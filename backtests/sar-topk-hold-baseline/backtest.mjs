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
const TOP_K = 3
const TOP_M = 5
const SAR_WARMUP_BARS = 100
const FEE_BPS_PER_SIDE = 2
const START_COVERAGE = 50
const DAILY_END = '20261009'
const SLOT_NOTIONAL = INITIAL_CAPITAL / (2 * TOP_M)

const strategies = [
  { id: 'sar_5d', name: '1小时SAR + 5日涨跌幅', signal: 'sar5' },
  { id: 'momentum_5d', name: '5日涨跌幅（不加SAR过滤）', signal: 'mom5' },
  { id: 'momentum_20d', name: '20日涨跌幅（项目现有排序基准）', signal: 'mom20' },
]

function readInputs() {
  const daily = new Map()
  const names = new Map()
  const dateSet = new Set()
  for (const file of readdirSync(DAILY_DIR).filter((x) => x.endsWith('.json')).sort()) {
    const doc = JSON.parse(readFileSync(join(DAILY_DIR, file), 'utf8'))
    const contract = String(doc.contract ?? basename(file, '.json')).toUpperCase()
    const bars = (Array.isArray(doc.bars) ? doc.bars : [])
      .map((b) => ({ ...b, d: digits(b.d ?? b.date), o: Number(b.o ?? b.open), c: Number(b.c ?? b.close) }))
      .filter((b) => /^\d{8}$/.test(b.d) && b.o > 0 && b.c > 0)
      .sort((a, b) => a.d.localeCompare(b.d))
    const byDate = new Map()
    for (const bar of bars) {
      byDate.set(bar.d, bar)
      dateSet.add(bar.d)
    }
    daily.set(contract, byDate)
    names.set(contract, { variety: doc.variety ?? '', name: doc.name ?? '', contract })
  }

  const calendar = [...dateSet].sort().filter((d) => d <= DAILY_END)
  if (!calendar.length || calendar.at(-1) !== DAILY_END) throw new Error(`日线快照没有截止日期 ${DAILY_END}`)
  const indexByDate = new Map(calendar.map((d, i) => [d, i]))

  const hourlyDoc = JSON.parse(readFileSync(HOURLY_FILE, 'utf8'))
  const hourly = new Map()
  for (const [key, entry] of Object.entries(hourlyDoc.contracts ?? {})) {
    const contract = key.toUpperCase()
    if (!daily.has(contract)) continue
    const barsBySession = []
    const seen = new Set()
    for (const b of entry?.bars ?? []) {
      const time = String(b.time ?? '').trim()
      const rawDate = digits(time.slice(0, 10))
      const hour = Number(time.slice(11, 13))
      let sessionIndex = lowerBound(calendar, rawDate)
      if (hour >= 21) {
        while (sessionIndex < calendar.length && calendar[sessionIndex] <= rawDate) sessionIndex++
      }
      if (sessionIndex >= calendar.length) continue
      const o = Number(b.o ?? b.open)
      const h = Number(b.h ?? b.high)
      const l = Number(b.l ?? b.low)
      const c = Number(b.c ?? b.close)
      if (!time || ![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue
      if (h < l || h < Math.max(o, c) || l > Math.min(o, c)) continue
      const dedup = `${sessionIndex}|${time}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      barsBySession.push({ time, o, h, l, c, sessionIndex })
    }
    barsBySession.sort((a, b) => a.time.localeCompare(b.time))
    hourly.set(contract, barsBySession)
  }

  // Use only contracts with both the current daily history and the SAR platform's hourly source.
  const universe = [...daily.keys()].filter((contract) => hourly.has(contract)).sort()
  const dailyAligned = new Map()
  for (const contract of universe) {
    const exact = daily.get(contract)
    let last = null
    const closes = []
    const exactBars = []
    for (const date of calendar) {
      const bar = exact.get(date) ?? null
      if (bar) last = bar.c
      closes.push(last)
      exactBars.push(bar)
    }
    dailyAligned.set(contract, { closes, exactBars })
  }
  return { calendar, daily, dailyAligned, hourly, names, universe, indexByDate }
}

function buildFrames(data) {
  const { calendar, dailyAligned, hourly, universe, names } = data
  const frames = []
  const pointers = new Map(universe.map((contract) => [contract, 0]))
  const cumulative = new Map(universe.map((contract) => [contract, []]))
  const coverage = []

  for (let i = 0; i < calendar.length; i++) {
    const date = calendar[i]
    const frame = { date, sar: { long: [], short: [] }, mom5: { long: [], short: [] }, mom20: { long: [], short: [] }, rankable: 0 }
    for (const contract of universe) {
      const source = hourly.get(contract)
      let cursor = pointers.get(contract)
      const bars = cumulative.get(contract)
      while (cursor < source.length && source[cursor].sessionIndex <= i) {
        const b = source[cursor]
        bars.push({ time: b.time, o: b.o, h: b.h, l: b.l, c: b.c })
        cursor++
      }
      pointers.set(contract, cursor)

      const aligned = dailyAligned.get(contract)
      const currentBar = aligned.exactBars[i]
      if (!currentBar) continue
      const close = currentBar.c
      const meta = names.get(contract)
      const makeCandidate = (direction, pct, extra = {}) => ({
        contract, name: meta.name, variety: meta.variety, direction,
        pct, signalDate: date, ...extra,
      })

      const fiveDayBase = i >= 5 ? aligned.closes[i - 5] : null
      if (fiveDayBase > 0) {
        const pct5 = (close / fiveDayBase - 1) * 100
        frame.mom5.long.push(makeCandidate('long', pct5))
        frame.mom5.short.push(makeCandidate('short', pct5))
        if (bars.length >= SAR_WARMUP_BARS) {
          const sar = computeSarSeries(bars)
          if (sar.direction) {
            frame.sar[sar.direction].push(makeCandidate(sar.direction, pct5, {
              sar: sar.sar,
              sarTime: sar.barTime,
              hourlyBars: bars.length,
            }))
            frame.rankable++
          }
        }
      }

      const twentyDayBase = i >= 20 ? aligned.closes[i - 20] : null
      if (twentyDayBase > 0) {
        const pct20 = (close / twentyDayBase - 1) * 100
        frame.mom20.long.push(makeCandidate('long', pct20))
        frame.mom20.short.push(makeCandidate('short', pct20))
      }
    }
    sortRanks(frame.sar)
    sortRanks(frame.mom5)
    sortRanks(frame.mom20)
    coverage.push({ date, count: frame.rankable })
    frames.push(frame)
  }

  const startIndex = frames.findIndex((f) => f.date >= '20260301' && f.rankable >= START_COVERAGE)
  if (startIndex < 0) throw new Error(`没有找到至少 ${START_COVERAGE} 个可排名品种的回测起点`)
  return { frames, startIndex, coverage }
}

function sortRanks(frame) {
  for (const side of ['long', 'short']) {
    frame[side].sort((a, b) => side === 'long'
      ? b.pct - a.pct || a.contract.localeCompare(b.contract)
      : a.pct - b.pct || a.contract.localeCompare(b.contract))
    frame[side].forEach((candidate, i) => { candidate.rank = i + 1 })
  }
}

function selectHoldings(ranking, previous) {
  const next = new Map()
  const isPresent = (side, contract, maxRank) => ranking[side].find((c) => c.contract === contract && c.rank <= maxRank)
  for (const [contract, old] of previous) {
    const candidate = isPresent(old.direction, contract, TOP_M)
    if (candidate) next.set(contract, candidate)
  }
  for (const side of ['long', 'short']) {
    for (const candidate of ranking[side].slice(0, TOP_K)) {
      if (!next.has(candidate.contract)) next.set(candidate.contract, candidate)
    }
  }
  return next
}

function simulate(frames, startIndex, strategy) {
  const feeRate = FEE_BPS_PER_SIDE / 10_000
  const positions = new Map()
  let desired = new Map()
  let equity = INITIAL_CAPITAL
  let grossEquity = INITIAL_CAPITAL
  let peak = INITIAL_CAPITAL
  let serial = 0
  const daily = []
  const trades = []
  const grossBySide = { long: 0, short: 0 }
  const netBySide = { long: 0, short: 0 }
  const feeBySide = { long: 0, short: 0 }
  const candidateKey = strategy.signal === 'sar5' ? 'sar' : strategy.signal === 'mom5' ? 'mom5' : 'mom20'

  for (let i = startIndex; i < frames.length; i++) {
    const frame = frames[i]
    let grossPnl = 0
    let fees = 0
    let opened = 0
    let closed = 0
    const tradesBefore = trades.length
    const contracts = new Set([...positions.keys(), ...desired.keys()])

    for (const contract of contracts) {
      const bar = frame._bars?.get(contract)
      const target = desired.get(contract)
      const position = positions.get(contract)
      if (!bar) continue

      if (position) {
        const gap = sign(position.direction) * position.units * (bar.o - position.lastClose)
        grossPnl += gap
        position.grossPnl += gap
      }

      const targetDirection = target?.direction ?? null
      if (position && position.direction !== targetDirection) {
        const exitNotional = position.units * bar.o
        const exitFee = exitNotional * feeRate
        fees += exitFee
        position.fees += exitFee
        feeBySide[position.direction] += exitFee
        closed++
        trades.push(closeTrade(position, frame.date, bar.o, 'open', exitFee, frame.date))
        positions.delete(contract)
      }

      if (!positions.has(contract) && targetDirection) {
        const units = SLOT_NOTIONAL / bar.o
        const entryFee = SLOT_NOTIONAL * feeRate
        const openedPosition = {
          id: ++serial,
          contract,
          name: target.name,
          variety: target.variety,
          direction: targetDirection,
          units,
          entryPrice: bar.o,
          entryDate: frame.date,
          signalDate: target.signalDate,
          entryRank: target.rank,
          entryPct: target.pct,
          lastClose: bar.o,
          grossPnl: 0,
          fees: entryFee,
        }
        positions.set(contract, openedPosition)
        fees += entryFee
        feeBySide[targetDirection] += entryFee
        opened++
      }

      const current = positions.get(contract)
      if (current) {
        const intraday = sign(current.direction) * current.units * (bar.c - bar.o)
        grossPnl += intraday
        current.grossPnl += intraday
        current.lastClose = bar.c
      }
    }

    // Close all remaining positions at the final observed daily close to make terminal P&L explicit.
    if (i === frames.length - 1) {
      for (const [contract, position] of [...positions]) {
        const bar = frame._bars?.get(contract)
        const exitPrice = bar?.c ?? position.lastClose
        const exitFee = position.units * exitPrice * feeRate
        fees += exitFee
        position.fees += exitFee
        feeBySide[position.direction] += exitFee
        closed++
        trades.push(closeTrade(position, frame.date, exitPrice, 'close', exitFee, frame.date))
        positions.delete(contract)
      }
    }

    const startEquity = equity
    grossEquity += grossPnl
    equity += grossPnl - fees
    peak = Math.max(peak, equity)
    grossBySide.long += 0
    const longDailyGross = [...positions.values()].length // placeholder overwritten below for output shape only
    void longDailyGross
    for (const trade of trades.slice(tradesBefore)) {
      const net = trade.netPnl
      netBySide[trade.direction] += net
      grossBySide[trade.direction] += trade.grossPnl
    }
    const currentRanks = selectHoldings(frame[candidateKey], desired)
    const rankLong = frame[candidateKey].long.length
    const rankShort = frame[candidateKey].short.length
    const dailyRow = {
      date: frame.date,
      strategy: strategy.id,
      startingEquity: startEquity,
      grossPnl,
      fees,
      netPnl: grossPnl - fees,
      equity,
      grossEquity,
      dailyReturnPct: startEquity ? ((equity / startEquity) - 1) * 100 : 0,
      drawdownPct: peak ? ((equity / peak) - 1) * 100 : 0,
      longPositions: [...positions.values()].filter((p) => p.direction === 'long').length,
      shortPositions: [...positions.values()].filter((p) => p.direction === 'short').length,
      longCandidates: rankLong,
      shortCandidates: rankShort,
      entries: opened,
      exits: closed,
      grossExposure: [...positions.values()].reduce((sum, p) => sum + p.units * p.lastClose, 0),
    }
    daily.push(dailyRow)
    desired = currentRanks
  }

  const metrics = summarize(strategy, daily, trades, grossBySide, netBySide, feeBySide)
  return { daily, trades, metrics }
}

function closeTrade(position, exitDate, exitPrice, exitAt, exitFee, lastSignalDate) {
  const notional = position.units * exitPrice
  const gross = position.grossPnl
  const fees = position.fees
  const net = gross - fees
  return {
    tradeId: position.id,
    contract: position.contract,
    variety: position.variety,
    name: position.name,
    direction: position.direction,
    signalDate: position.signalDate,
    entryDate: position.entryDate,
    entryRank: position.entryRank,
    entryPct: position.entryPct,
    entryPrice: position.entryPrice,
    exitDate,
    exitAt,
    exitPrice,
    units: position.units,
    entryNotional: SLOT_NOTIONAL,
    exitNotional: notional,
    holdingCalendarDays: calendarDays(position.entryDate, exitDate),
    grossPnl: gross,
    fees,
    netPnl: net,
    netReturnOnEntryNotionalPct: net / SLOT_NOTIONAL * 100,
    exitSignalDate: lastSignalDate,
    exitFeeIncluded: exitFee,
  }
}

function summarize(strategy, daily, trades, grossBySide, netBySide, feeBySide) {
  const first = daily[0]
  const last = daily.at(-1)
  const netReturns = daily.map((r) => r.dailyReturnPct / 100)
  const mean = netReturns.reduce((a, b) => a + b, 0) / (netReturns.length || 1)
  const variance = netReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (netReturns.length || 1)
  const stdev = Math.sqrt(variance)
  const totalDays = calendarDays(first.date, last.date)
  const totalReturnPct = (last.equity / INITIAL_CAPITAL - 1) * 100
  const grossReturnPct = (last.grossEquity / INITIAL_CAPITAL - 1) * 100
  const wins = trades.filter((t) => t.netPnl > 0).length
  const losses = trades.filter((t) => t.netPnl < 0).length
  const maxDrawdownPct = Math.min(...daily.map((r) => r.drawdownPct))
  const annualizedPct = last.equity > 0 && totalDays > 0
    ? ((last.equity / INITIAL_CAPITAL) ** (365.25 / totalDays) - 1) * 100
    : null
  return {
    id: strategy.id,
    name: strategy.name,
    startDate: first.date,
    endDate: last.date,
    tradingDays: daily.length,
    totalReturnPct,
    grossReturnPct,
    annualizedPct,
    maxDrawdownPct,
    sharpe252: stdev ? mean / stdev * Math.sqrt(252) : null,
    roundTrips: trades.length,
    wins,
    losses,
    winRatePct: trades.length ? wins / trades.length * 100 : 0,
    profitFactor: profitFactor(trades),
    totalFees: daily.reduce((sum, row) => sum + row.fees, 0),
    endingEquity: last.equity,
    endingGrossEquity: last.grossEquity,
    maxLongPositions: Math.max(...daily.map((r) => r.longPositions)),
    maxShortPositions: Math.max(...daily.map((r) => r.shortPositions)),
    maxGrossExposure: Math.max(...daily.map((r) => r.grossExposure)),
    longGrossPnl: grossBySide.long,
    shortGrossPnl: grossBySide.short,
    longNetPnl: netBySide.long,
    shortNetPnl: netBySide.short,
    longFees: feeBySide.long,
    shortFees: feeBySide.short,
  }
}

function profitFactor(trades) {
  const positive = trades.filter((t) => t.netPnl > 0).reduce((s, t) => s + t.netPnl, 0)
  const negative = -trades.filter((t) => t.netPnl < 0).reduce((s, t) => s + t.netPnl, 0)
  if (!negative) return positive ? Infinity : 0
  return positive / negative
}

function renderCsv(rows, columns) {
  const q = (value) => {
    if (value === null || value === undefined) return ''
    const text = typeof value === 'number' ? (Number.isFinite(value) ? String(round(value, 8)) : '') : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return `${columns.join(',')}\n${rows.map((row) => columns.map((col) => q(row[col])).join(',')).join('\n')}\n`
}

function hashFile(file) {
  const bytes = readFileSync(file)
  return { path: relative(WORKSPACE, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function digits(value) { return String(value ?? '').replace(/[^0-9]/g, '').slice(0, 8) }
function sign(direction) { return direction === 'long' ? 1 : -1 }
function round(value, digitsCount = 4) { return Math.round((value + Number.EPSILON) * (10 ** digitsCount)) / (10 ** digitsCount) }
function calendarDays(start, end) {
  const a = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(4, 6)) - 1, Number(start.slice(6, 8)))
  const b = Date.UTC(Number(end.slice(0, 4)), Number(end.slice(4, 6)) - 1, Number(end.slice(6, 8)))
  return Math.max(1, Math.round((b - a) / 86_400_000))
}
function lowerBound(list, value) {
  let low = 0, high = list.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (list[mid] < value) low = mid + 1
    else high = mid
  }
  return low
}

function appendExecutionBars(frames, startIndex, data) {
  // Attach each date's exact OHLC bars for fills and daily mark-to-market.
  for (let i = startIndex; i < frames.length; i++) {
    const bars = new Map()
    for (const contract of data.universe) {
      const bar = data.dailyAligned.get(contract).exactBars[i]
      if (bar) bars.set(contract, bar)
    }
    frames[i]._bars = bars
  }
}

function writeOutputs(data, built, results) {
  const inputFiles = [HOURLY_FILE, ...readdirSync(DAILY_DIR).filter((x) => x.endsWith('.json')).sort().map((x) => join(DAILY_DIR, x))]
  const manifest = {
    source: '读取仓库 rank20/kline 与 realtime-server/var/sar-hourly-cache.json',
    inputFiles: inputFiles.map(hashFile),
    dailyFiles: inputFiles.length - 1,
    dailyContracts: data.daily.size,
    sharedHourlyDailyContracts: data.universe.length,
    dailyCalendarDates: data.calendar.length,
    dailyStart: data.calendar[0],
    dailyEnd: data.calendar.at(-1),
    hourlyCacheUpdatedAt: JSON.parse(readFileSync(HOURLY_FILE, 'utf8')).lastSuccessAt ?? null,
    sar: SAR_PARAMS,
    generatedAt: new Date().toISOString(),
  }
  writeFileSync(join(ROOT, 'inputs-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const dailyRows = results.flatMap((r) => r.daily)
  const tradeRows = results.flatMap((r) => r.trades.map((t) => ({ strategy: r.metrics.id, ...t })))
  writeFileSync(join(ROOT, 'daily-equity.csv'), renderCsv(dailyRows, [
    'date', 'strategy', 'startingEquity', 'grossPnl', 'fees', 'netPnl', 'equity', 'grossEquity',
    'dailyReturnPct', 'drawdownPct', 'longPositions', 'shortPositions', 'longCandidates', 'shortCandidates',
    'entries', 'exits', 'grossExposure',
  ]), 'utf8')
  writeFileSync(join(ROOT, 'trades.csv'), renderCsv(tradeRows, [
    'strategy', 'tradeId', 'contract', 'variety', 'name', 'direction', 'signalDate', 'entryDate', 'entryRank',
    'entryPct', 'entryPrice', 'exitDate', 'exitAt', 'exitPrice', 'units', 'entryNotional', 'exitNotional',
    'holdingCalendarDays', 'grossPnl', 'fees', 'netPnl', 'netReturnOnEntryNotionalPct', 'exitSignalDate',
  ]), 'utf8')
  writeFileSync(join(ROOT, 'metrics.csv'), renderCsv(results.map((r) => r.metrics), Object.keys(results[0].metrics)), 'utf8')

  return manifest
}

function markdownReport(data, built, results, manifest) {
  const byId = new Map(results.map((r) => [r.metrics.id, r.metrics]))
  const sar = byId.get('sar_5d')
  const formatPct = (x) => `${round(x, 2)}%`
  const formatMoney = (x) => `¥${round(x, 2).toLocaleString('en-US')}`
  const coverageRows = built.coverage.slice(built.startIndex)
  const avgCoverage = coverageRows.reduce((s, r) => s + r.count, 0) / (coverageRows.length || 1)
  const start = data.calendar[built.startIndex]
  const end = data.calendar.at(-1)
  const strategiesTable = results.map(({ metrics: m }) => `| ${m.name} | ${formatPct(m.grossReturnPct)} | ${formatPct(m.totalReturnPct)} | ${formatPct(m.annualizedPct ?? 0)} | ${formatPct(m.maxDrawdownPct)} | ${m.roundTrips} | ${formatPct(m.winRatePct)} | ¥${round(m.totalFees, 2).toLocaleString('en-US')} |`).join('\n')
  const sideTable = `| 方向 | 毛盈亏 | 扣费后盈亏 | 费用 |\n|---|---:|---:|---:|\n| 多头 | ${formatMoney(sar.longGrossPnl)} | ${formatMoney(sar.longNetPnl)} | ${formatMoney(sar.longFees)} |\n| 空头 | ${formatMoney(sar.shortGrossPnl)} | ${formatMoney(sar.shortNetPnl)} | ${formatMoney(sar.shortFees)} |`
  return `# SAR TopK/TopM 基线回测汇总

## 结论

区间内，SAR 策略毛收益为 **${formatPct(sar.grossReturnPct)}**，计入每边 2bp 交易摩擦后净收益为 **${formatPct(sar.totalReturnPct)}**，期末净值 **${formatMoney(sar.endingEquity)}**；最大回撤 **${formatPct(sar.maxDrawdownPct)}**，完成 ${sar.roundTrips} 笔往返交易，胜率 ${formatPct(sar.winRatePct)}。这是用现有缓存做的研究性 baseline，不能视为可实盘复现的收益。

## 参数与口径

- 本金 ¥${INITIAL_CAPITAL.toLocaleString('en-US')}；日内信号计算后，下一交易日开盘成交。
- SAR 使用项目当前参数：1 小时线，step=${SAR_PARAMS.step}、max=${SAR_PARAMS.max}；每个信号日按近 5 个交易日收盘涨跌幅排序。SAR 向上时只进入涨幅榜，SAR 向下时只进入跌幅榜。
- TopK=${TOP_K} 开仓、TopM=${TOP_M} 持有：原持仓仍在同方向 TopM 内则保留；新进同方向 TopK 的品种在次日开盘买入/卖出；退出榜单或 SAR 方向翻转后于次日开盘退出。每个方向最多保留 TopM 个品种。
- 每个仓位固定名义金额 ¥${round(SLOT_NOTIONAL, 2).toLocaleString('en-US')}（初始本金除以多空合计 ${2 * TOP_M} 个仓位）；固定名义金额、不随净值复利。
- 费用按成交名义金额每边 2bp 计入，开仓、平仓各收一次；未用真实交易所/期货公司手续费表。回测末日以收盘价强制平仓并计平仓费。
- 为和 SAR 的可交易标的口径一致，三组策略使用同时存在日线和小时线的 ${data.universe.length} 个合约。比较组为 5 日动量 TopK/TopM（不加 SAR）及项目现有 20 日涨跌幅 TopK/TopM；三组共享起止日期和执行/费用设定。
- 区间：${start} 至 ${end}，共 ${sar.tradingDays} 个交易日。起点取 SAR 小时线预热后、可排序合约首次达到 ${START_COVERAGE} 个的日期。该区间平均每日报价覆盖 ${round(avgCoverage, 1)} 个，起点 ${built.coverage[built.startIndex].count} 个，末日 ${built.coverage.at(-1).count} 个。

## 结果对比

| 策略 | 毛收益 | 净收益 | 年化净收益 | 最大回撤 | 往返笔数 | 胜率 | 费用 |
|---|---:|---:|---:|---:|---:|---:|---:|
${strategiesTable}

净收益基于每日权益变化复合，最大回撤按日终净值计算；年化按起止自然日折算。往返胜率以扣费后单笔净盈亏为准。

SAR 多空拆分：

${sideTable}

## 结果文件

- backtest.mjs：完整回测实现；在项目专用环境中运行 node backtest.mjs 可重新生成结果。
- daily-equity.csv：每日权益、盈亏、费用、回撤和持仓数量。
- trades.csv：逐笔开仓/平仓、成交时间、价格、盈亏及费用。
- metrics.csv：三组策略的汇总指标。
- inputs-manifest.json：本次读取的仓库行情文件及 SHA-256 校验信息。

## 重要限制

1. 日线文件是当前留存的主力合约代码历史序列，数据没有逐日历史主力合约映射；将当前合约向前回看，会产生合约选择/幸存者偏差，尤其换月、上市时间和历史连续性都无法严格复原。
2. 小时线源是缓存的当前合约历史，部分品种最多只有最近 1023 根。SAR 从缓存首根重新预热；虽然设置 100 根门槛，仍不等同于完整历史小时线计算。
3. 以日线开、高、低、收和次日开盘模拟成交，忽略真实合约乘数、保证金、手续费差异、滑点、涨跌停无法成交、夜盘跳空风控、换月及强平规则。仓位按价格数量折算固定名义金额，只是跨品种的近似等权模型。
4. “TopM 保留”是滞回规则，持仓可能处于排名 K+1 至 M；信号在收盘后才可用，因此回测不按当天收盘价成交。数据截止 ${end}，不包含之后的新信号。

复现时，脚本读取仓库内 rank20/kline/ 与 realtime-server/var/sar-hourly-cache.json；SAR 计算函数复用仓库中的 realtime-server/src/sar.mjs。输入文件哈希见 inputs-manifest.json（本次生成时间：${manifest.generatedAt}）。
`
}

function run() {
  const data = readInputs()
  const built = buildFrames(data)
  appendExecutionBars(built.frames, built.startIndex, data)
  const results = strategies.map((strategy) => simulate(built.frames, built.startIndex, strategy))
  const manifest = writeOutputs(data, built, results)
  writeFileSync(join(ROOT, '汇总.md'), markdownReport(data, built, results, manifest), 'utf8')
  const brief = results.map((r) => ({
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
  process.stdout.write(`${JSON.stringify({ inputContracts: data.universe.length, startDate: data.calendar[built.startIndex], endDate: data.calendar.at(-1), coverageStart: built.coverage[built.startIndex].count, strategies: brief }, null, 2)}\n`)
}

run()
