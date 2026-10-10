import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSarSeries, SAR_PARAMS } from '../../realtime-server/src/sar.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(ROOT, '..', '..')
const DAILY_DIR = join(WORKSPACE, 'rank20', 'kline')
const HOURLY_FILE = join(WORKSPACE, 'realtime-server', 'var', 'sar-hourly-cache.json')
const INITIAL_CAPITAL = 100_000
const TOP_K = 10
const TOP_M = 15
const SAR_WARMUP_BARS = 100
const FEE_BPS_PER_SIDE = 2
const START_AFTER = '20260301'
const END_DATE = '20261009'
const DAILY_SIGNAL_TIME = '15:16'
const HOURLY_CUTOFF_TIME = '15:15'
const SLOT_NOTIONAL = INITIAL_CAPITAL / (2 * TOP_M)
const STRATEGIES = [
  { id: 'sar_20d', name: '1小时SAR过滤 + 20日涨跌幅', useSar: true },
  { id: 'momentum_20d', name: '纯20日涨跌幅（无SAR过滤）', useSar: false },
]

function digits(value) { return String(value ?? '').replace(/[^0-9]/g, '').slice(0, 8) }
function lowerBound(list, value) {
  let low = 0, high = list.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (list[mid] < value) low = mid + 1
    else high = mid
  }
  return low
}
function nextTradeDate(calendar, raw, inclusive) {
  let i = lowerBound(calendar, raw)
  if (!inclusive && calendar[i] === raw) i++
  return calendar[i] ?? ''
}
function hourlyTradeDate(time, calendar) {
  const raw = digits(String(time).slice(0, 10))
  const hour = Number(String(time).slice(11, 13))
  if (!/^\d{8}$/.test(raw) || !Number.isFinite(hour)) return ''
  if (hour >= 21) return nextTradeDate(calendar, raw, false)
  if (hour <= 4) return nextTradeDate(calendar, raw, true)
  return calendar.includes(raw) ? raw : ''
}
function sortDaily(bars) {
  return bars.map((b) => ({
    d: digits(b.d ?? b.date),
    o: Number(b.o ?? b.open),
    h: Number(b.h ?? b.high),
    l: Number(b.l ?? b.low),
    c: Number(b.c ?? b.close),
  })).filter((b) => /^\d{8}$/.test(b.d) && [b.o, b.h, b.l, b.c].every((n) => Number.isFinite(n) && n > 0)
    && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c) && b.h >= b.l)
    .sort((a, b) => a.d.localeCompare(b.d))
}
function validHourly(b) {
  const time = String(b.time ?? '').trim().slice(0, 16)
  const o = Number(b.o ?? b.open), h = Number(b.h ?? b.high), l = Number(b.l ?? b.low), c = Number(b.c ?? b.close)
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time)
    && [o, h, l, c].every((n) => Number.isFinite(n) && n > 0)
    && h >= Math.max(o, c) && l <= Math.min(o, c) && h >= l
    ? { time, o, h, l, c, v: Number(b.v ?? 0) || 0 }
    : null
}

function readInputs() {
  const daily = new Map()
  const names = new Map()
  const dateSet = new Set()
  const dailyFiles = readdirSync(DAILY_DIR).filter((file) => file.endsWith('.json')).sort()
  for (const file of dailyFiles) {
    const doc = JSON.parse(readFileSync(join(DAILY_DIR, file), 'utf8'))
    const contract = String(doc.contract ?? basename(file, '.json')).toUpperCase()
    const bars = sortDaily(Array.isArray(doc.bars) ? doc.bars : []).filter((b) => b.d <= END_DATE)
    const byDate = new Map()
    for (const bar of bars) { byDate.set(bar.d, bar); dateSet.add(bar.d) }
    daily.set(contract, byDate)
    names.set(contract, { contract, variety: doc.variety ?? '', name: doc.name ?? '' })
  }
  const calendar = [...dateSet].sort().filter((d) => d <= END_DATE)
  if (!calendar.length || calendar.at(-1) !== END_DATE) throw new Error('日线数据没有截止日期 ' + END_DATE)
  const dateIndex = new Map(calendar.map((d, i) => [d, i]))

  const aligned = new Map()
  for (const [contract, byDate] of daily) {
    let last = null
    let firstIndex = -1
    const closes = [], exactBars = []
    for (let i = 0; i < calendar.length; i++) {
      const bar = byDate.get(calendar[i]) ?? null
      if (bar) {
        last = bar.c
        if (firstIndex < 0) firstIndex = i
      }
      closes.push(last)
      exactBars.push(bar)
    }
    aligned.set(contract, { closes, exactBars, firstIndex })
  }

  const hourlyDoc = JSON.parse(readFileSync(HOURLY_FILE, 'utf8'))
  const hourly = new Map()
  const hourlyCounts = []
  for (const [key, entry] of Object.entries(hourlyDoc.contracts ?? {})) {
    const contract = key.toUpperCase()
    if (!daily.has(contract)) continue
    const dedup = new Map()
    for (const raw of entry?.bars ?? []) {
      const b = validHourly(raw)
      if (!b) continue
      const tradeDate = hourlyTradeDate(b.time, calendar)
      const sessionIndex = dateIndex.get(tradeDate)
      if (sessionIndex === undefined || tradeDate > END_DATE) continue
      dedup.set(b.time, { ...b, tradeDate, sessionIndex })
    }
    const source = [...dedup.values()].sort((a, b) => a.time.localeCompare(b.time))
    if (!source.length) continue
    const sar = computeSarSeries(source)
    const bars = source.map((b, i) => ({
      ...b,
      sar: sar.bars[i]?.sar ?? null,
      direction: sar.bars[i]?.direction ?? null,
      count: i + 1,
    }))
    hourly.set(contract, bars)
    hourlyCounts.push({ contract, count: bars.length, first: bars[0].time, last: bars.at(-1).time })
  }

  const universe = [...daily.keys()].filter((contract) => hourly.has(contract)).sort()
  const dailyAligned = new Map(universe.map((contract) => [contract, aligned.get(contract)]))
  return {
    calendar, dateIndex, daily, dailyAligned, hourly, names, universe,
    dailyFiles, hourlyUpdatedAt: hourlyDoc.lastSuccessAt ?? null, hourlyCounts,
  }
}

function buildRankings(data) {
  const frames = new Map()
  const coverage = []
  const lastHourPointer = new Map(data.universe.map((c) => [c, 0]))
  for (let i = 0; i < data.calendar.length; i++) {
    const date = data.calendar[i]
    const long = [], short = []
    const latestHour = new Map()
    for (const contract of data.universe) {
      const bars = data.hourly.get(contract)
      let ptr = lastHourPointer.get(contract)
      const cutoff = dateToIso(date) + ' ' + HOURLY_CUTOFF_TIME
      while (ptr < bars.length && bars[ptr].sessionIndex <= i && bars[ptr].time <= cutoff) ptr++
      lastHourPointer.set(contract, ptr)
      if (ptr > 0) latestHour.set(contract, bars[ptr - 1])

      const aligned = data.dailyAligned.get(contract)
      if (i < 20 || aligned.firstIndex < 0 || i - aligned.firstIndex < 20) continue
      const close = aligned.closes[i]
      const base = aligned.closes[i - 20]
      if (!(close > 0 && base > 0)) continue
      const meta = data.names.get(contract)
      const pct20 = (close / base - 1) * 100
      const hour = latestHour.get(contract) ?? null
      const ready = !!hour && hour.count >= SAR_WARMUP_BARS && !!hour.direction
      const row = {
        date, contract, variety: meta.variety, name: meta.name,
        pct20, dailyClose: close, dailyBaseDate: data.calendar[i - 20], dailyBaseClose: base,
        currentDailyBar: !!aligned.exactBars[i],
        sarDirection: ready ? hour.direction : '', sarValue: ready ? hour.sar : null,
        sarBarTime: hour?.time ?? '', sarTradeDate: hour?.tradeDate ?? '',
        hourlyBars: hour?.count ?? 0, sarReady: ready,
      }
      long.push(row)
      short.push(row)
    }
    long.sort((a, b) => b.pct20 - a.pct20 || a.contract.localeCompare(b.contract))
    short.sort((a, b) => a.pct20 - b.pct20 || a.contract.localeCompare(b.contract))
    long.forEach((row, rank) => { row.longRank = rank + 1 })
    short.forEach((row, rank) => { row.shortRank = rank + 1 })
    const byContract = new Map(long.map((row) => [row.contract, row]))
    const sarCoverage = long.filter((row) => row.sarReady).length
    frames.set(date, { date, long, short, byContract, sarCoverage, rankable: long.length })
    coverage.push({ date, rankable: long.length, sarCoverage })
  }
  const startIndex = coverage.findIndex((row) => row.date >= START_AFTER && row.sarCoverage >= 50)
  if (startIndex < 0) throw new Error('没有找到小时 SAR 预热且覆盖不少于 50 个品种的起点')
  return { frames, coverage, startIndex, startDate: coverage[startIndex].date }
}

function sideSign(direction) { return direction === 'long' ? 1 : -1 }
function round(value, digitsCount = 6) {
  return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * (10 ** digitsCount)) / (10 ** digitsCount) : null
}
function csvValue(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(round(value, 8)) : '') : String(value)
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
}
function renderCsv(rows, columns) {
  return columns.join(',') + '\n' + rows.map((row) => columns.map((col) => csvValue(row[col])).join(',')).join('\n') + '\n'
}
function calendarDays(start, end) {
  const date = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)))
  return Math.max(1, Math.round((date(end) - date(start)) / 86_400_000))
}
function money(value) { return '¥' + round(value, 2).toLocaleString('en-US') }
function pct(value) { return round(value, 2) + '%' }
function dateToIso(date) { return date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8) }

function newSimulationState(strategy) {
  return {
    strategy,
    positions: new Map(),
    desired: new Map(),
    latestSar: new Map(),
    rankState: new Map(),
    trades: [],
    timingEvents: [],
    portfolio: [],
    dailyEquity: [],
    hourlyEquity: [],
    fillsByDate: new Map(),
    dayGross: new Map(),
    dayFees: new Map(),
    totalGrossPnl: 0,
    totalFees: 0,
    grossBySide: { long: 0, short: 0 },
    feesBySide: { long: 0, short: 0 },
    nextTradeId: 0,
    peakEquity: INITIAL_CAPITAL,
    maxDrawdownPct: 0,
    maxLongPositions: 0,
    maxShortPositions: 0,
    maxGrossExposure: 0,
    previousDailyEquity: INITIAL_CAPITAL,
  }
}

function stateRowFor(state, contract) {
  return state.rankState.get(contract) ?? null
}
function makeTarget(state, contract, signalTime, sar, candidate, direction, reason) {
  return {
    direction,
    signalTime,
    signalDate: digits(signalTime.slice(0, 10)),
    reason,
    rankDate: candidate?.date ?? '',
    longRank: candidate?.longRank ?? null,
    shortRank: candidate?.shortRank ?? null,
    pct20: candidate?.pct20 ?? null,
    sarDirection: sar?.ready ? sar.direction : '',
    sarTime: sar?.time ?? '',
    sarValue: sar?.ready ? sar.sar : null,
    hourlyBars: sar?.count ?? 0,
    strategy: state.strategy.id,
  }
}
function desiredFor(state, contract, signalTime, sar) {
  const candidate = stateRowFor(state, contract)
  const position = state.positions.get(contract)
  const sarDirection = state.strategy.useSar ? (sar?.ready ? sar.direction : '') : 'both'
  const longEntry = !!candidate && candidate.longRank <= TOP_K && (!state.strategy.useSar || sarDirection === 'long')
  const shortEntry = !!candidate && candidate.shortRank <= TOP_K && (!state.strategy.useSar || sarDirection === 'short')
  const longHold = !!candidate && candidate.longRank <= TOP_M && (!state.strategy.useSar || sarDirection === 'long')
  const shortHold = !!candidate && candidate.shortRank <= TOP_M && (!state.strategy.useSar || sarDirection === 'short')

  if (position?.direction === 'long' && longHold) {
    return makeTarget(state, contract, signalTime, sar, candidate, 'long', '持仓仍在涨幅Top' + TOP_M + '且SAR看多')
  }
  if (position?.direction === 'short' && shortHold) {
    return makeTarget(state, contract, signalTime, sar, candidate, 'short', '持仓仍在跌幅Top' + TOP_M + '且SAR看空')
  }
  if (longEntry && (position?.direction !== 'long')) {
    return makeTarget(state, contract, signalTime, sar, candidate, 'long', state.strategy.useSar ? '涨幅Top' + TOP_K + '且1小时SAR看多' : '涨幅Top' + TOP_K)
  }
  if (shortEntry && (position?.direction !== 'short')) {
    return makeTarget(state, contract, signalTime, sar, candidate, 'short', state.strategy.useSar ? '跌幅Top' + TOP_K + '且1小时SAR看空' : '跌幅Top' + TOP_K)
  }

  let reason = '不满足开仓条件'
  if (!candidate) reason = '20日排名缺失或历史不足'
  else if (position?.direction === 'long' && state.strategy.useSar && sarDirection !== 'long') reason = '1小时SAR转空或信号预热不足'
  else if (position?.direction === 'short' && state.strategy.useSar && sarDirection !== 'short') reason = '1小时SAR转多或信号预热不足'
  else if (position?.direction === 'long' && candidate.longRank > TOP_M) reason = '跌出涨幅Top' + TOP_M
  else if (position?.direction === 'short' && candidate.shortRank > TOP_M) reason = '跌出跌幅Top' + TOP_M
  else if (!state.strategy.useSar && position?.direction === 'long' && candidate.longRank > TOP_M) reason = '跌出涨幅Top' + TOP_M
  else if (!state.strategy.useSar && position?.direction === 'short' && candidate.shortRank > TOP_M) reason = '跌出跌幅Top' + TOP_M
  return makeTarget(state, contract, signalTime, sar, candidate, null, reason)
}

function nextBarTime(data, contract, signalTime) {
  const bars = data.hourly.get(contract) ?? []
  let low = 0, high = bars.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (bars[mid].time <= signalTime) low = mid + 1
    else high = mid
  }
  return bars[low]?.time ?? ''
}

function updateDesired(state, data, contract, signalTime, source) {
  const sar = state.latestSar.get(contract) ?? null
  const previous = state.desired.get(contract) ?? { direction: null, signalTime: '', reason: '' }
  const next = desiredFor(state, contract, signalTime, sar)
  state.desired.set(contract, next)
  if (previous.direction === next.direction) return
  const actual = state.positions.get(contract)?.direction ?? null
  const action = next.direction === actual ? '撤销待执行信号'
    : next.direction ? (actual ? '反向换仓' : '开' + (next.direction === 'long' ? '多' : '空'))
      : (actual ? '平' + (actual === 'long' ? '多' : '空') : '撤销待开仓')
  state.timingEvents.push({
    strategy: state.strategy.id,
    signalTime,
    signalSource: source,
    contract,
    variety: data.names.get(contract)?.variety ?? '',
    name: data.names.get(contract)?.name ?? '',
    heldDirection: actual ?? '',
    previousTarget: previous.direction ?? '',
    targetDirection: next.direction ?? '',
    action,
    reason: next.reason,
    rankDate: next.rankDate,
    longRank: next.longRank,
    shortRank: next.shortRank,
    pct20: next.pct20,
    sarDirection: next.sarDirection,
    sarTime: next.sarTime,
    sarValue: next.sarValue,
    hourlyBars: next.hourlyBars,
    nextAvailableBar: nextBarTime(data, contract, signalTime),
  })
}

function addPnl(state, tradeDate, direction, amount) {
  state.totalGrossPnl += amount
  state.grossBySide[direction] += amount
  state.dayGross.set(tradeDate, (state.dayGross.get(tradeDate) ?? 0) + amount)
}
function addFee(state, tradeDate, direction, amount) {
  state.totalFees += amount
  state.feesBySide[direction] += amount
  state.dayFees.set(tradeDate, (state.dayFees.get(tradeDate) ?? 0) + amount)
}
function recordFill(state, tradeDate, type) {
  const row = state.fillsByDate.get(tradeDate) ?? { entries: 0, exits: 0 }
  row[type]++
  state.fillsByDate.set(tradeDate, row)
}

function closePosition(state, contract, price, fillTime, tradeDate, signal, forced = false) {
  const position = state.positions.get(contract)
  if (!position) return
  const exitNotional = position.units * price
  const exitFee = exitNotional * FEE_BPS_PER_SIDE / 10_000
  position.fees += exitFee
  addFee(state, tradeDate, position.direction, exitFee)
  recordFill(state, tradeDate, 'exits')
  const grossPnl = position.grossPnl
  const netPnl = grossPnl - position.fees
  state.trades.push({
    tradeId: position.tradeId, strategy: state.strategy.id,
    contract, variety: position.variety, name: position.name,
    direction: position.direction,
    signalDate: position.entrySignalDate, signalTime: position.entrySignalTime,
    entryDate: position.entryTradeDate, entryTime: position.entryTime,
    entryRankDate: position.entryRankDate, entryRank: position.entryRank,
    entryPct20: position.entryPct20, entrySarDirection: position.entrySarDirection,
    entrySarTime: position.entrySarTime, entryPrice: position.entryPrice,
    entryNotional: position.entryNotional, units: position.units,
    exitSignalTime: signal?.signalTime ?? fillTime,
    exitReason: forced ? '样本结束强制平仓' : (signal?.reason ?? '策略信号退出'),
    exitDate: tradeDate, exitTime: fillTime, exitPrice: price,
    exitNotional, holdingCalendarDays: calendarDays(position.entryTradeDate, tradeDate),
    grossPnl, fees: position.fees, netPnl,
    netReturnOnEntryNotionalPct: netPnl / position.entryNotional * 100,
    forcedExit: forced,
  })
  state.positions.delete(contract)
}

function openPosition(state, data, contract, target, price, fillTime, tradeDate) {
  if (!target?.direction) return
  const meta = data.names.get(contract) ?? { variety: '', name: '' }
  const units = SLOT_NOTIONAL / price
  const fee = SLOT_NOTIONAL * FEE_BPS_PER_SIDE / 10_000
  const position = {
    tradeId: ++state.nextTradeId, contract,
    variety: meta.variety, name: meta.name,
    direction: target.direction, units,
    entryPrice: price, entryNotional: SLOT_NOTIONAL,
    entryTradeDate: tradeDate, entryTime: fillTime,
    entrySignalDate: target.signalDate, entrySignalTime: target.signalTime,
    entryRankDate: target.rankDate,
    entryRank: target.direction === 'long' ? target.longRank : target.shortRank,
    entryPct20: target.pct20,
    entrySarDirection: target.sarDirection,
    entrySarTime: target.sarTime,
    grossPnl: 0, fees: fee, lastMark: price,
  }
  state.positions.set(contract, position)
  addFee(state, tradeDate, position.direction, fee)
  recordFill(state, tradeDate, 'entries')
}

function currentEquity(state) { return INITIAL_CAPITAL + state.totalGrossPnl - state.totalFees }
function currentExposure(state) {
  let total = 0
  for (const position of state.positions.values()) total += position.units * position.lastMark
  return total
}
function markDrawdown(state) {
  const equity = currentEquity(state)
  state.peakEquity = Math.max(state.peakEquity, equity)
  const dd = state.peakEquity ? (equity / state.peakEquity - 1) * 100 : 0
  state.maxDrawdownPct = Math.min(state.maxDrawdownPct, dd)
  return { equity, drawdownPct: dd }
}

function snapshotDaily(state, data, built, date) {
  const priorEquity = state.previousDailyEquity
  const marked = markDrawdown(state)
  const fill = state.fillsByDate.get(date) ?? { entries: 0, exits: 0 }
  const frame = built.frames.get(date)
  const positions = [...state.positions.values()]
  const longPositions = positions.filter((p) => p.direction === 'long').length
  const shortPositions = positions.filter((p) => p.direction === 'short').length
  const exposure = currentExposure(state)
  state.maxLongPositions = Math.max(state.maxLongPositions, longPositions)
  state.maxShortPositions = Math.max(state.maxShortPositions, shortPositions)
  state.maxGrossExposure = Math.max(state.maxGrossExposure, exposure)
  state.dailyEquity.push({
    date, strategy: state.strategy.id,
    startingEquity: priorEquity,
    grossPnl: state.dayGross.get(date) ?? 0,
    fees: state.dayFees.get(date) ?? 0,
    netPnl: (state.dayGross.get(date) ?? 0) - (state.dayFees.get(date) ?? 0),
    equity: marked.equity,
    grossEquity: INITIAL_CAPITAL + state.totalGrossPnl,
    dailyReturnPct: priorEquity ? (marked.equity / priorEquity - 1) * 100 : 0,
    drawdownPct: marked.drawdownPct,
    longPositions, shortPositions, grossExposure: exposure,
    rankedContracts: frame?.rankable ?? 0,
    sarReadyContracts: frame?.sarCoverage ?? 0,
    entries: fill.entries, exits: fill.exits,
  })
  state.previousDailyEquity = marked.equity

  for (const p of positions) {
    const candidate = frame?.byContract.get(p.contract) ?? null
    const sar = state.latestSar.get(p.contract)
    const target = state.desired.get(p.contract)
    state.portfolio.push({
      date, strategy: state.strategy.id,
      contract: p.contract, variety: p.variety, name: p.name,
      direction: p.direction, entryDate: p.entryTradeDate, entryTime: p.entryTime,
      entryRank: p.entryRank, entryPct20: p.entryPct20,
      entryPrice: p.entryPrice, markPrice: p.lastMark, units: p.units,
      entryNotional: p.entryNotional, unrealizedAndRealizedPnl: p.grossPnl,
      feesToDate: p.fees, rankDate: candidate?.date ?? '',
      longRank: candidate?.longRank ?? null, shortRank: candidate?.shortRank ?? null,
      pct20: candidate?.pct20 ?? null,
      sarDirection: sar?.ready ? sar.direction : '', sarTime: sar?.time ?? '',
      targetDirection: target?.direction ?? '', pendingReason: target?.reason ?? '',
    })
  }
}

function buildEvents(data, built) {
  const eventMap = new Map()
  const add = (time) => {
    if (!eventMap.has(time)) eventMap.set(time, { time, bars: [], rankDate: '' })
    return eventMap.get(time)
  }
  for (const date of data.calendar) {
    if (date < built.startDate || date > END_DATE) continue
    add(dateToIso(date) + ' ' + DAILY_SIGNAL_TIME).rankDate = date
  }
  const simBarsByContract = new Map()
  const startSignalTime = dateToIso(built.startDate) + ' ' + DAILY_SIGNAL_TIME
  for (const contract of data.universe) {
    const bars = data.hourly.get(contract).filter((bar) => bar.time > startSignalTime && bar.tradeDate <= END_DATE)
    simBarsByContract.set(contract, bars)
    for (const bar of bars) add(bar.time).bars.push({ contract, bar })
  }
  return { events: [...eventMap.values()].sort((a, b) => a.time.localeCompare(b.time)), simBarsByContract, startSignalTime }
}

function runSimulation(data, built, strategy, eventBundle) {
  const state = newSimulationState(strategy)
  const { events, simBarsByContract, startSignalTime } = eventBundle

  // Seed each instrument with the latest completed hourly SAR known at the first ranking close.
  for (const contract of data.universe) {
    const bars = data.hourly.get(contract)
    let lo = 0, hi = bars.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (bars[mid].time <= startSignalTime && bars[mid].tradeDate <= built.startDate) lo = mid + 1
      else hi = mid
    }
    const last = bars[lo - 1]
    state.latestSar.set(contract, last ? {
      direction: last.direction, sar: last.sar, time: last.time,
      tradeDate: last.tradeDate, count: last.count,
      ready: last.count >= SAR_WARMUP_BARS && !!last.direction,
    } : null)
  }

  const lastBarTime = new Map()
  for (const [contract, bars] of simBarsByContract) if (bars.length) lastBarTime.set(contract, bars.at(-1).time)

  for (const event of events) {
    // Mark gaps for every contract at this timestamp before applying any orders.
    for (const { contract, bar } of event.bars) {
      const position = state.positions.get(contract)
      if (position) {
        const gap = sideSign(position.direction) * position.units * (bar.o - position.lastMark)
        position.grossPnl += gap
        position.lastMark = bar.o
        addPnl(state, bar.tradeDate, position.direction, gap)
      }
    }

    // Close first so simultaneous exits release portfolio slots before new entries.
    for (const { contract, bar } of event.bars) {
      const target = state.desired.get(contract) ?? { direction: null, reason: '无目标持仓' }
      const actual = state.positions.get(contract)
      if (actual && actual.direction !== target.direction) {
        closePosition(state, contract, bar.o, bar.time, bar.tradeDate, target)
      }
    }

    // Enforce the TopM per-side portfolio cap when asynchronous contract bars delay exits.
    const entries = event.bars.filter(({ contract }) => {
      return !state.positions.has(contract) && state.desired.get(contract)?.direction
    }).sort((a, b) => {
      const at = state.desired.get(a.contract)
      const bt = state.desired.get(b.contract)
      if (at.direction !== bt.direction) return at.direction.localeCompare(bt.direction)
      const ar = at.direction === 'long' ? at.longRank : at.shortRank
      const br = bt.direction === 'long' ? bt.longRank : bt.shortRank
      return (ar ?? Infinity) - (br ?? Infinity) || a.contract.localeCompare(b.contract)
    })
    for (const { contract, bar } of entries) {
      const target = state.desired.get(contract)
      const sideCount = [...state.positions.values()].filter((p) => p.direction === target.direction).length
      if (sideCount < TOP_M) openPosition(state, data, contract, target, bar.o, bar.time, bar.tradeDate)
    }

    for (const { contract, bar } of event.bars) {
      const opened = state.positions.get(contract)
      if (opened) {
        const intrabar = sideSign(opened.direction) * opened.units * (bar.c - bar.o)
        opened.grossPnl += intrabar
        opened.lastMark = bar.c
        addPnl(state, bar.tradeDate, opened.direction, intrabar)
      }

      state.latestSar.set(contract, {
        direction: bar.direction, sar: bar.sar, time: bar.time,
        tradeDate: bar.tradeDate, count: bar.count,
        ready: bar.count >= SAR_WARMUP_BARS && !!bar.direction,
      })

      if (lastBarTime.get(contract) === bar.time) {
        const terminalPosition = state.positions.get(contract)
        if (terminalPosition) {
          closePosition(state, contract, bar.c, bar.time, bar.tradeDate,
            { signalTime: bar.time, reason: '小时样本结束，无后续成交时点' }, true)
        }
        state.desired.set(contract, { direction: null, signalTime: bar.time, reason: '小时样本结束，无后续成交时点' })
      } else if (strategy.useSar) {
        updateDesired(state, data, contract, bar.time, '1小时SAR收盘确认')
      }
    }

    if (event.rankDate) {
      const date = event.rankDate
      const frame = built.frames.get(date)
      if (frame) {
        state.rankState.clear()
        for (const row of frame.long) state.rankState.set(row.contract, row)
        // Do not create new orders from the final ranking date: there is no next sample bar.
        if (date !== END_DATE) {
          for (const contract of data.universe) updateDesired(state, data, contract, event.time, '20日收盘排名更新')
        }
      }
      snapshotDaily(state, data, built, date)
    }

    if (event.bars.length) {
      const marked = markDrawdown(state)
      const positions = [...state.positions.values()]
      const longPositions = positions.filter((p) => p.direction === 'long').length
      const shortPositions = positions.filter((p) => p.direction === 'short').length
      const exposure = currentExposure(state)
      state.maxLongPositions = Math.max(state.maxLongPositions, longPositions)
      state.maxShortPositions = Math.max(state.maxShortPositions, shortPositions)
      state.maxGrossExposure = Math.max(state.maxGrossExposure, exposure)
      state.hourlyEquity.push({
        time: event.time, strategy: strategy.id,
        equity: marked.equity, grossEquity: INITIAL_CAPITAL + state.totalGrossPnl,
        drawdownPct: marked.drawdownPct,
        longPositions, shortPositions, grossExposure: exposure,
      })
    }
  }

  const metrics = summarize(state, built.startDate, END_DATE)
  return { state, metrics }
}

function profitFactor(trades) {
  const positive = trades.filter((t) => t.netPnl > 0).reduce((sum, t) => sum + t.netPnl, 0)
  const negative = -trades.filter((t) => t.netPnl < 0).reduce((sum, t) => sum + t.netPnl, 0)
  return negative ? positive / negative : (positive ? Infinity : 0)
}
function summarize(state, startDate, endDate) {
  const daily = state.dailyEquity
  const trades = state.trades
  const netReturns = daily.map((r) => r.dailyReturnPct / 100)
  const mean = netReturns.reduce((sum, x) => sum + x, 0) / (netReturns.length || 1)
  const variance = netReturns.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (netReturns.length || 1)
  const stdev = Math.sqrt(variance)
  const equity = currentEquity(state)
  const totalReturnPct = (equity / INITIAL_CAPITAL - 1) * 100
  const grossReturnPct = state.totalGrossPnl / INITIAL_CAPITAL * 100
  const wins = trades.filter((t) => t.netPnl > 0).length
  const losses = trades.filter((t) => t.netPnl < 0).length
  const years = calendarDays(startDate, endDate) / 365.25
  const annualizedPct = equity > 0 && years > 0 ? ((equity / INITIAL_CAPITAL) ** (1 / years) - 1) * 100 : null
  return {
    id: state.strategy.id, name: state.strategy.name,
    startDate, endDate, tradingDays: daily.length,
    totalReturnPct, grossReturnPct, annualizedPct,
    maxDrawdownPct: state.maxDrawdownPct,
    sharpe252: stdev ? mean / stdev * Math.sqrt(252) : null,
    roundTrips: trades.length, wins, losses,
    winRatePct: trades.length ? wins / trades.length * 100 : 0,
    profitFactor: profitFactor(trades),
    totalFees: state.totalFees,
    endingEquity: equity,
    endingGrossEquity: INITIAL_CAPITAL + state.totalGrossPnl,
    maxLongPositions: state.maxLongPositions,
    maxShortPositions: state.maxShortPositions,
    maxGrossExposure: state.maxGrossExposure,
    longGrossPnl: state.grossBySide.long,
    shortGrossPnl: state.grossBySide.short,
    longFees: state.feesBySide.long,
    shortFees: state.feesBySide.short,
    longNetPnl: state.grossBySide.long - state.feesBySide.long,
    shortNetPnl: state.grossBySide.short - state.feesBySide.short,
  }
}

function hashFile(file) {
  const bytes = readFileSync(file)
  return {
    path: relative(WORKSPACE, file).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function writeOutputs(data, built, results) {
  const inputPaths = [HOURLY_FILE, ...data.dailyFiles.map((file) => join(DAILY_DIR, file))]
  const manifest = {
    source: 'rank20/kline 日线 + realtime-server/var/sar-hourly-cache.json 的 60 分钟 OHLC',
    inputFiles: inputPaths.map(hashFile),
    dailyFiles: data.dailyFiles.length,
    dailyContracts: data.daily.size,
    sharedHourlyDailyContracts: data.universe.length,
    dailyCalendarDates: data.calendar.length,
    dailyStart: data.calendar[0], dailyEnd: data.calendar.at(-1),
    hourlyCacheUpdatedAt: data.hourlyUpdatedAt,
    hourlyBarsByContract: data.hourlyCounts,
    hourlyBarsMin: Math.min(...data.hourlyCounts.map((x) => x.count)),
    hourlyBarsMax: Math.max(...data.hourlyCounts.map((x) => x.count)),
    backtestStart: built.startDate, backtestEnd: END_DATE,
    sar: SAR_PARAMS, sarWarmupBars: SAR_WARMUP_BARS,
    generatedAt: new Date().toISOString(),
  }
  writeFileSync(join(ROOT, 'inputs-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const metrics = results.map((r) => r.metrics)
  const daily = results.flatMap((r) => r.state.dailyEquity)
  const hourly = results.flatMap((r) => r.state.hourlyEquity)
  const portfolio = results.flatMap((r) => r.state.portfolio)
  const trades = results.flatMap((r) => r.state.trades)
  const events = results.flatMap((r) => r.state.timingEvents)
  const timings = []
  for (const date of data.calendar) {
    if (date < built.startDate || date > END_DATE) continue
    const frame = built.frames.get(date)
    for (const row of frame?.long ?? []) {
      timings.push({
        date, contract: row.contract, variety: row.variety, name: row.name,
        dailyClose: row.dailyClose, baseDate20: row.dailyBaseDate, baseClose20: row.dailyBaseClose,
        pct20: row.pct20, longRank: row.longRank, shortRank: row.shortRank,
        sarDirection: row.sarDirection, sarValue: row.sarValue,
        sarTime: row.sarBarTime, sarTradeDate: row.sarTradeDate,
        completedHourlyBars: row.hourlyBars, sarReady: row.sarReady,
        longTopK: row.longRank <= TOP_K, shortTopK: row.shortRank <= TOP_K,
        longEntrySignal: row.longRank <= TOP_K && row.sarReady && row.sarDirection === 'long',
        shortEntrySignal: row.shortRank <= TOP_K && row.sarReady && row.sarDirection === 'short',
      })
    }
  }

  writeFileSync(join(ROOT, 'rank-timing.csv'), renderCsv(timings, [
    'date', 'contract', 'variety', 'name', 'dailyClose', 'baseDate20', 'baseClose20', 'pct20',
    'longRank', 'shortRank', 'sarDirection', 'sarValue', 'sarTime', 'sarTradeDate',
    'completedHourlyBars', 'sarReady', 'longTopK', 'shortTopK', 'longEntrySignal', 'shortEntrySignal',
  ]), 'utf8')
  writeFileSync(join(ROOT, 'timing-events.csv'), renderCsv(events, [
    'strategy', 'signalTime', 'signalSource', 'contract', 'variety', 'name',
    'heldDirection', 'previousTarget', 'targetDirection', 'action', 'reason',
    'rankDate', 'longRank', 'shortRank', 'pct20', 'sarDirection', 'sarTime', 'sarValue',
    'hourlyBars', 'nextAvailableBar',
  ]), 'utf8')
  writeFileSync(join(ROOT, 'portfolio-daily.csv'), renderCsv(portfolio, [
    'date', 'strategy', 'contract', 'variety', 'name', 'direction', 'entryDate', 'entryTime',
    'entryRank', 'entryPct20', 'entryPrice', 'markPrice', 'units', 'entryNotional',
    'unrealizedAndRealizedPnl', 'feesToDate', 'rankDate', 'longRank', 'shortRank', 'pct20',
    'sarDirection', 'sarTime', 'targetDirection', 'pendingReason',
  ]), 'utf8')
  writeFileSync(join(ROOT, 'trades.csv'), renderCsv(trades, [
    'tradeId', 'strategy', 'contract', 'variety', 'name', 'direction',
    'signalDate', 'signalTime', 'entryDate', 'entryTime', 'entryRankDate', 'entryRank',
    'entryPct20', 'entrySarDirection', 'entrySarTime', 'entryPrice', 'entryNotional', 'units',
    'exitSignalTime', 'exitReason', 'exitDate', 'exitTime', 'exitPrice', 'exitNotional',
    'holdingCalendarDays', 'grossPnl', 'fees', 'netPnl', 'netReturnOnEntryNotionalPct', 'forcedExit',
  ]), 'utf8')
  writeFileSync(join(ROOT, 'daily-equity.csv'), renderCsv(daily, [
    'date', 'strategy', 'startingEquity', 'grossPnl', 'fees', 'netPnl', 'equity', 'grossEquity',
    'dailyReturnPct', 'drawdownPct', 'longPositions', 'shortPositions', 'grossExposure',
    'rankedContracts', 'sarReadyContracts', 'entries', 'exits',
  ]), 'utf8')
  writeFileSync(join(ROOT, 'hourly-equity.csv'), renderCsv(hourly, [
    'time', 'strategy', 'equity', 'grossEquity', 'drawdownPct',
    'longPositions', 'shortPositions', 'grossExposure',
  ]), 'utf8')
  writeFileSync(join(ROOT, 'metrics.csv'), renderCsv(metrics, Object.keys(metrics[0])), 'utf8')
  return manifest
}

function reportMarkdown(data, built, results, manifest) {
  const sar = results.find((r) => r.metrics.id === 'sar_20d').metrics
  const baseline = results.find((r) => r.metrics.id === 'momentum_20d').metrics
  const coverage = built.coverage.filter((r) => r.date >= built.startDate && r.date <= END_DATE)
  const avgHourlyReady = coverage.reduce((sum, row) => sum + row.sarCoverage, 0) / (coverage.length || 1)
  const table = results.map(({ metrics: m }) => '| ' + m.name + ' | ' + pct(m.grossReturnPct) + ' | ' + pct(m.totalReturnPct)
    + ' | ' + pct(m.annualizedPct) + ' | ' + pct(m.maxDrawdownPct) + ' | ' + m.roundTrips
    + ' | ' + pct(m.winRatePct) + ' | ' + money(m.totalFees) + ' |').join('\n')
  const sideRows = [
    '| 多头 | ' + money(sar.longGrossPnl) + ' | ' + money(sar.longNetPnl) + ' | ' + money(sar.longFees) + ' |',
    '| 空头 | ' + money(sar.shortGrossPnl) + ' | ' + money(sar.shortNetPnl) + ' | ' + money(sar.shortFees) + ' |',
  ].join('\n')
  const sarResult = 'SAR策略净收益 ' + pct(sar.totalReturnPct) + '，纯20日动量比较组净收益 '
    + pct(baseline.totalReturnPct) + '；SAR策略最大回撤 ' + pct(sar.maxDrawdownPct)
    + '，完成 ' + sar.roundTrips + ' 笔往返，胜率 ' + pct(sar.winRatePct) + '。'
  return [
    '# SAR + 20日涨跌幅基线回测汇总', '',
    '## 结论', '',
    sarResult + '比较组使用完全相同的排序、TopK/TopM、小时开盘成交、仓位和费用模型，只移除 SAR 过滤，以便观察 SAR 过滤本身的影响。结果属于当前本地行情缓存上的研究性模拟，不代表实盘收益。', '',
    '## 回测口径', '',
    '- 区间：' + dateToIso(built.startDate) + ' 至 ' + dateToIso(END_DATE) + '，共 ' + sar.tradingDays + ' 个交易日；初始本金 ' + money(INITIAL_CAPITAL) + '。',
    '- 每个交易日收盘后（全市场信号时点设为北京时间 15:16，以纳入国债期货 15:15 收盘小时 K），按全体共享覆盖品种的 20 个交易日收盘涨跌幅计算排名；多头看涨幅前 ' + TOP_K + '，空头看跌幅前 ' + TOP_K + '。',
    '- SAR策略入场要求最近已完成的 1 小时 SAR 方向与交易方向一致；持仓留在对应方向 Top' + TOP_M + ' 且 SAR 未反向时继续持有。纯20日比较组不检查 SAR。',
    '- 排名信号在北京时间 15:16 确认；SAR 反向在小时线收盘后确认。交易在信号之后该品种第一根小时 K 的开盘价模拟成交；若同方向已达到 TopM 持仓上限，则等待有仓位退出后在首根可用小时 K 开盘建仓。样本末尾无法等下一根小时 K 的持仓，以该品种最后一根小时 K 收盘强制平仓。',
    '- SAR参数：step=' + SAR_PARAMS.step + '、max=' + SAR_PARAMS.max + '；小时线至少预热 ' + SAR_WARMUP_BARS + ' 根才允许形成 SAR 入场信号。',
    '- TopK=' + TOP_K + ' 入场、TopM=' + TOP_M + ' 保留；每方向最多 ' + TOP_M + ' 个品种。每个仓位固定名义金额 ' + money(SLOT_NOTIONAL) + '，不随净值变化，最多同时占用 ' + money(INITIAL_CAPITAL) + ' 名义敞口。',
    '- 交易摩擦按每边成交名义金额 ' + FEE_BPS_PER_SIDE + 'bp 计费；不含真实合约乘数、保证金、涨跌停和额外滑点。合约按价格比例近似为可分割数量。',
    '', '## 收益对比', '',
    '| 策略 | 毛收益 | 净收益 | 年化净收益 | 最大回撤 | 往返笔数 | 胜率 | 费用 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|', table, '',
    'SAR策略多空拆分：', '',
    '| 方向 | 毛盈亏 | 扣费后盈亏 | 费用 |', '|---|---:|---:|---:|', sideRows, '',
    '净收益由逐小时持仓盈亏和交易摩擦累积后除以初始本金计算；最大回撤按逐小时权益路径统计；夏普按每日权益变化估计。由于每个仓位固定名义金额，权益收益为固定风险预算模型，不复利加仓。', '',
    '## 小时数据核验', '',
    '- 小时源：realtime-server/var/sar-hourly-cache.json，记录字段包含实际时间戳与 `o/h/l/c` OHLC；与 rank20 日线共有 ' + data.universe.length + ' 个合约。',
    '- 缓存覆盖每合约 ' + manifest.hourlyBarsMin + ' 至 ' + manifest.hourlyBarsMax + ' 根小时 K；回测区间平均每日达到 SAR 预热门槛的品种数为 ' + round(avgHourlyReady, 1) + '。',
    '- rank-timing.csv 可按交易日核对 20 日基准价格、涨跌幅名次、SAR 使用的小时线时间戳/方向和 TopK 信号；timing-events.csv 记录目标仓位变化及下一可成交小时 K；portfolio-daily.csv 记录每日持仓快照。',
    '', '## 文件', '',
    '- 策略.md：规则与参数定义。',
    '- backtest.mjs：可复现的回测代码；需在项目的 future-ranking 环境运行 Node 脚本。',
    '- rank-timing.csv：每日逐品种排名和截至当日的已完成小时 SAR 状态。',
    '- timing-events.csv：开平仓信号、原因、信号时间和预计下一小时成交时间。',
    '- portfolio-daily.csv：日终持仓、排名、SAR状态及持仓盈亏快照。',
    '- trades.csv：逐笔交易和往返盈亏。',
    '- daily-equity.csv、hourly-equity.csv：日频与小时权益曲线。',
    '- metrics.csv：SAR策略与纯20日动量比较组绩效。',
    '- inputs-manifest.json：行情输入文件路径、哈希、更新时间及各品种小时线覆盖。',
    '', '## 数据限制', '',
    '1. 日线来自项目当前保存的主力合约代码；没有逐交易日历史主力切换映射。把当前合约向前回看会造成主力选择/幸存者偏差，无法准确模拟历史换月。',
    '2. 小时缓存属于当前合约的有限历史缓存，并非从期货上市起的完整连续小时序列；SAR 从缓存首根重新计算，达到 ' + SAR_WARMUP_BARS + ' 根的门槛仍不能消除起始截断影响。',
    '3. 数据服务的小时 K 标签被当作已完成 K 线时间；若源接口时间标签语义不同，下一根成交时间可能偏移一个小时。回测按小时 K 开盘成交，忽略逐笔成交、真实合约乘数、手续费表、滑点、夜盘风控、涨跌停和保证金强平。',
    '4. 小时 K 在北京时间 21:00 后归到下一个日线交易日；缺少官方交易日历时，输入数据的日线日期集承担节假日映射。',
    '', '回测输入哈希和具体覆盖清单见 inputs-manifest.json。生成时间：' + manifest.generatedAt, '',
  ].join('\n')
}

function strategyMarkdown(results, built, data) {
  const sar = results.find((r) => r.metrics.id === 'sar_20d').metrics
  const baseline = results.find((r) => r.metrics.id === 'momentum_20d').metrics
  return [
    '# SAR + 20日涨跌幅排序策略', '',
    '**策略类型：** 研究性多空基线；组合按固定名义金额分配，持仓采用小时 K 收盘信号、下一根小时 K 开盘成交。', '',
    '**回测结果：** ' + dateToIso(built.startDate) + ' 至 ' + dateToIso(END_DATE) + '，初始本金 ' + money(INITIAL_CAPITAL)
      + '。SAR策略净收益 ' + pct(sar.totalReturnPct) + '，最大回撤 ' + pct(sar.maxDrawdownPct)
      + '，往返交易 ' + sar.roundTrips + ' 笔；纯20日动量对照净收益 ' + pct(baseline.totalReturnPct) + '。完整结果见汇总.md。', '',
    '**# 多头候选**',
    '每个交易日收盘后（全市场决策时点为北京时间 15:16），从当时可排名的合约中计算过去 20 个交易日收盘价涨幅，选涨幅最高的前 ' + TOP_K + ' 名。只有截至当时最近一根已完成的 1 小时 SAR 显示看多，且该合约小时线至少有 ' + SAR_WARMUP_BARS + ' 根可用于预热时，才允许新开多仓。', '',
    '**# 空头候选**',
    '每个交易日收盘后，从当时可排名的合约中计算过去 20 个交易日收盘价跌幅，选跌幅最大的前 ' + TOP_K + ' 名。只有截至决策时点最近一根已完成的 1 小时 SAR 显示看空，且小时线达到预热门槛时，才允许新开空仓。', '',
    '**# 持仓与退出**',
    '新仓进入涨幅前 ' + TOP_K + ' 或跌幅前 ' + TOP_K + '。已有多仓只要仍在涨幅前 ' + TOP_M + ' 且 1 小时 SAR 继续看多就保留；已有空仓只要仍在跌幅前 ' + TOP_M + ' 且 1 小时 SAR 继续看空就保留。SAR 反向、跌出对应方向前 ' + TOP_M + ' 或排名/信号不可用时，发出平仓信号。信号确认后在该合约下一根可用小时 K 的开盘成交；同方向达到 ' + TOP_M + ' 个仓位时，新仓等到名额释放后再成交。样本末端改在最后一根小时 K 收盘强制平仓。', '',
    '**# 组合与成本**',
    '初始本金 ' + money(INITIAL_CAPITAL) + '；每个仓位固定名义金额 ' + money(SLOT_NOTIONAL) + '，多头和空头各最多 ' + TOP_M + ' 个持仓。每边成交费用按名义金额 ' + FEE_BPS_PER_SIDE + 'bp 估计；名义数量按合约价格折算为可分割数量，便于跨品种比较。', '',
    '**# 纯20日对照组**',
    '为识别 SAR 过滤的影响，额外回测同一 20 日涨跌幅排名、同样 Top' + TOP_K + '/Top' + TOP_M + '、仓位、费用与小时成交规则，但移除 SAR 方向筛选。此组是同回测引擎下的对照，不等同于平台中日频展示排序。', '',
    '**# 数据与适用范围**',
    '日线读取项目 `rank20/kline/`；小时 SAR 使用 `realtime-server/var/sar-hourly-cache.json` 中的 60 分钟 OHLC。两者共有 ' + data.universe.length + ' 个合约，回测从 ' + dateToIso(built.startDate) + ' 开始。日线文件缺少逐日历史主力切换映射；小时缓存长度有限并从缓存首根重新初始化 SAR，因此存在当前主力回看偏差、幸存者偏差和 SAR 起始截断风险。未建模真实乘数、保证金、逐品种手续费、滑点、涨跌停、无法成交与换月。该结果用于比较策略规则，不代表可直接实盘执行。', '',
    '复现脚本：backtest.mjs。择时明细：rank-timing.csv、timing-events.csv；组合快照：portfolio-daily.csv；交易明细：trades.csv；绩效汇总：metrics.csv。', '',
  ].join('\n')
}

function validateResults(results, built) {
  for (const result of results) {
    const state = result.state
    const metrics = result.metrics
    const tradeGross = state.trades.reduce((sum, trade) => sum + trade.grossPnl, 0)
    const tradeFees = state.trades.reduce((sum, trade) => sum + trade.fees, 0)
    const dailyNet = state.dailyEquity.reduce((sum, row) => sum + row.netPnl, 0)
    const tolerance = 0.0001
    if (state.positions.size) throw new Error(result.metrics.id + ' 回测结束后仍有未平持仓')
    if (metrics.maxLongPositions > TOP_M || metrics.maxShortPositions > TOP_M) {
      throw new Error(result.metrics.id + ' 超出 TopM 单方向持仓上限')
    }
    if (state.trades.some((trade) => trade.entryTime <= trade.signalTime)) {
      throw new Error(result.metrics.id + ' 存在信号确认前或同时成交的开仓')
    }
    if (state.trades.some((trade) => !trade.forcedExit && trade.exitTime <= trade.exitSignalTime)) {
      throw new Error(result.metrics.id + ' 存在信号确认前或同时成交的平仓')
    }
    if (Math.abs(tradeGross - state.totalGrossPnl) > tolerance) throw new Error(result.metrics.id + ' 交易毛盈亏与组合毛盈亏不一致')
    if (Math.abs(tradeFees - state.totalFees) > tolerance) throw new Error(result.metrics.id + ' 交易费用与组合费用不一致')
    if (Math.abs(dailyNet - (currentEquity(state) - INITIAL_CAPITAL)) > tolerance) throw new Error(result.metrics.id + ' 日频盈亏与期末权益不一致')
    const lastDaily = state.dailyEquity.at(-1)
    if (!lastDaily || Math.abs(lastDaily.equity - currentEquity(state)) > tolerance) throw new Error(result.metrics.id + ' 日频权益没有对齐期末权益')
  }
  for (const frame of built.frames.values()) {
    const cutoff = dateToIso(frame.date) + ' ' + HOURLY_CUTOFF_TIME
    for (const row of frame.long) {
      if (row.sarBarTime && row.sarBarTime > cutoff) throw new Error('排名信号使用了收盘后才完成的小时 K：' + frame.date + ' ' + row.contract)
      if (row.sarTradeDate && row.sarTradeDate > frame.date) throw new Error('SAR交易日超过排名交易日：' + frame.date + ' ' + row.contract)
    }
  }
}

function run() {
  const data = readInputs()
  const built = buildRankings(data)
  const eventBundle = buildEvents(data, built)
  const results = STRATEGIES.map((strategy) => runSimulation(data, built, strategy, eventBundle))
  validateResults(results, built)
  const manifest = writeOutputs(data, built, results)
  writeFileSync(join(ROOT, '汇总.md'), reportMarkdown(data, built, results, manifest), 'utf8')
  writeFileSync(join(ROOT, '策略.md'), strategyMarkdown(results, built, data), 'utf8')

  const summary = results.map((r) => ({
    strategy: r.metrics.name,
    start: r.metrics.startDate,
    end: r.metrics.endDate,
    grossPct: round(r.metrics.grossReturnPct, 2),
    netPct: round(r.metrics.totalReturnPct, 2),
    maxDrawdownPct: round(r.metrics.maxDrawdownPct, 2),
    roundTrips: r.metrics.roundTrips,
    winRatePct: round(r.metrics.winRatePct, 2),
    endingEquity: round(r.metrics.endingEquity, 2),
  }))
  process.stdout.write(JSON.stringify({
    universe: data.universe.length,
    hourlyBarsMin: manifest.hourlyBarsMin,
    hourlyBarsMax: manifest.hourlyBarsMax,
    startDate: built.startDate,
    endDate: END_DATE,
    strategies: summary,
  }, null, 2) + '\n')
}

run()
