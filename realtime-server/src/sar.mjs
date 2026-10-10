/**
 * 1 小时 Parabolic SAR + 近 5 个交易日涨跌幅排序。
 * 小时线来自新浪期货 60 分钟 K 线接口；日线继续使用项目的本地主力合约 K 线库。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from './config.mjs'
import { isMonthlyAvg, sinaSymbol } from './sources/symbols.mjs'

export const SAR_PARAMS = Object.freeze({ step: 0.02, max: 0.2 })
export const SAR_TOP_N = 10
const REFRESH_MS = 15 * 60 * 1000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const REFERER = 'https://finance.sina.com.cn/'

/** 新浪小时线接口的合约代码，郑商所 3 位月份会转换为 4 位月份。 */
export function sinaHourlySymbol(row) {
  if (!row?.contract || row.isMonthlyAvg || isMonthlyAvg(row.contract)) return null
  const symbol = sinaSymbol(row.contract)
  return symbol ? symbol.replace(/^nf_/i, '') : null
}

/** 把新浪 60 分钟 K 线转换成统一 OHLC 结构。 */
export function parseSinaHourlyBars(payload) {
  const text = String(payload ?? '')
  const marker = text.lastIndexOf('=')
  if (marker < 0) return []
  let raw
  try {
    const body = text.slice(marker + 1).trim().replace(/^\(/, '').replace(/\);?\s*$/, '')
    raw = JSON.parse(body)
  } catch { return [] }
  if (!Array.isArray(raw)) return []
  const byTime = new Map()
  for (const line of raw) {
    const time = line?.d
    const n = (x) => Number(x)
    const bar = { time: String(time ?? '').trim().slice(0, 16), o: n(line?.o), c: n(line?.c), h: n(line?.h), l: n(line?.l), v: n(line?.v) }
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(bar.time)) continue
    if (![bar.o, bar.c, bar.h, bar.l].every((x) => Number.isFinite(x) && x > 0)) continue
    if (bar.h < bar.l || bar.h < Math.max(bar.o, bar.c) || bar.l > Math.min(bar.o, bar.c)) continue
    byTime.set(bar.time, bar)
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time))
}

/** 标准 Wilder Parabolic SAR 序列，输出每根 bar 的方向和 SAR 点位。 */
export function computeSarSeries(input, { step = SAR_PARAMS.step, max = SAR_PARAMS.max } = {}) {
  if (!(step > 0) || !(max >= step)) throw new Error('SAR 参数无效')
  const bars = normalizeHourlyBars(input)
  if (bars.length < 3) return { bars: [], direction: null, sar: null, barTime: null }

  let up = bars[1].c >= bars[0].c
  let sar = up ? Math.min(bars[0].l, bars[1].l) : Math.max(bars[0].h, bars[1].h)
  let ep = up ? Math.max(bars[0].h, bars[1].h) : Math.min(bars[0].l, bars[1].l)
  let af = step
  const out = [
    { time: bars[0].time, sar: null, direction: null },
    { time: bars[1].time, sar, direction: up ? 'long' : 'short' },
  ]

  for (let i = 2; i < bars.length; i++) {
    const current = bars[i]
    const previous = bars[i - 1]
    const beforePrevious = bars[i - 2]
    let next = sar + af * (ep - sar)
    if (up) {
      next = Math.min(next, previous.l, beforePrevious.l)
      if (current.l <= next) {
        up = false
        next = ep
        ep = current.l
        af = step
      } else if (current.h > ep) {
        ep = current.h
        af = Math.min(max, af + step)
      }
    } else {
      next = Math.max(next, previous.h, beforePrevious.h)
      if (current.h >= next) {
        up = true
        next = ep
        ep = current.h
        af = step
      } else if (current.l < ep) {
        ep = current.l
        af = Math.min(max, af + step)
      }
    }
    sar = next
    out.push({ time: current.time, sar, direction: up ? 'long' : 'short' })
  }

  const last = out.at(-1)
  return { bars: out, direction: last.direction, sar: last.sar, barTime: last.time }
}

/**
 * 将小时线时间映射到期货交易日。
 * 夜盘 21:00 后属于下一个有效交易日；没有未来交易日历时按下一个工作日推断。
 */
export function hourlySessionDate(time, tradingDates = []) {
  const text = String(time ?? '').trim()
  const raw = text.slice(0, 10).replace(/[^\d]/g, '')
  if (!/^\d{8}$/.test(raw)) return ''
  const hour = Number(text.slice(11, 13))
  const dates = [...new Set((tradingDates ?? [])
    .map((d) => String(d).replace(/[^\d]/g, '').slice(0, 8))
    .filter((d) => /^\d{8}$/.test(d)))].sort()
  if (hour >= 21) return dates.find((d) => d > raw) ?? nextWeekday(raw)

  // 00:00–04:00 仍属于前一晚的夜盘。周末/节假日凌晨归入日历中的下一个交易日。
  if (hour <= 4) {
    if (dates.length) return dates.find((d) => d >= raw) ?? nextWeekday(raw)
    return isWeekday(raw) ? raw : nextWeekday(raw)
  }
  return raw
}

/** 只保留指定交易日及以前已经可见的小时线。 */
export function filterHourlyBarsToTradeDate(input, { tradeDate = '', tradingDates = [] } = {}) {
  const td = String(tradeDate).replace(/[^\d]/g, '').slice(0, 8)
  if (!/^\d{8}$/.test(td)) return normalizeHourlyBars(input)
  return normalizeHourlyBars(input).filter((bar) => hourlySessionDate(bar.time, tradingDates) <= td)
}

/** 计算当前价相对 5 个交易日前收盘价的变动。 */
export function calculateFiveDayChange(dailyBars, { price, tradeDate = '', isLive = false } = {}) {
  const bars = normalizeDailyBars(dailyBars)
  if (!(Number(price) > 0) || bars.length < 6) return null
  const td = String(tradeDate).replace(/[^\d]/g, '').slice(0, 8)
  let currentIndex = bars.length - 1
  if (td) {
    currentIndex = bars.findLastIndex((b) => b.d <= td)
    if (currentIndex < 0) return null
  }
  const hasTradeDateBar = !!td && bars[currentIndex].d === td
  const offset = hasTradeDateBar || !isLive ? 5 : 4
  const base = bars[currentIndex - offset]
  if (!base || !(base.c > 0)) return null
  return {
    pct: ((Number(price) / base.c) - 1) * 100,
    baseDate: base.d,
    baseClose: base.c,
  }
}

/** 将稀疏日 K 对齐到交易日历；无成交日沿用上一根收盘价。 */
export function alignDailyBarsToCalendar(dailyBars, tradingDates, tradeDate = '') {
  const observed = new Map(normalizeDailyBars(dailyBars).map((bar) => [bar.d, bar.c]))
  const td = String(tradeDate).replace(/[^\d]/g, '').slice(0, 8)
  const dates = [...new Set((tradingDates ?? [])
    .map((d) => String(d).replace(/[^\d]/g, '').slice(0, 8))
    .filter((d) => /^\d{8}$/.test(d) && (!td || d <= td)))]
    .sort()
  if (td && !dates.includes(td)) dates.push(td)
  if (!dates.length) return normalizeDailyBars(dailyBars)

  const aligned = []
  let lastClose = null
  for (const d of dates) {
    if (observed.has(d)) lastClose = observed.get(d)
    if (lastClose > 0) aligned.push({ d, c: lastClose })
  }
  return aligned
}

/** 基于真实 SAR 信号，再按 5 日涨跌幅生成多头/空头 Top 10。 */
export function buildSarRanking({ rows, hourlyBarsByContract, dailyBarsByContract, tradeDate, tradingDates = [], serviceStatus = {} }) {
  const supported = (rows ?? []).filter((r) => sinaHourlySymbol(r))
  const longCandidates = []
  const shortCandidates = []
  let hourlyCovered = 0
  let signalCovered = 0

  for (const row of rows ?? []) {
    const symbol = sinaHourlySymbol(row)
    if (!symbol) continue
    const hourlyBars = filterHourlyBarsToTradeDate(
      hourlyBarsByContract.get(String(row.contract).toUpperCase()) ?? [],
      { tradeDate, tradingDates },
    )
    if (hourlyBars.length < 3) continue
    hourlyCovered++
    const signal = computeSarSeries(hourlyBars)
    const change = calculateFiveDayChange(dailyBarsByContract.get(String(row.contract).toUpperCase()), {
      price: row.price,
      tradeDate,
      isLive: row.is_live,
    })
    if (!signal.direction || signal.sar === null || !change) continue
    signalCovered++
    const item = {
      variety: row.variety,
      name: row.name,
      contract: row.contract,
      direction: signal.direction,
      pct_5d: round(change.pct, 2),
      price: row.price,
      sar: signal.sar,
      sar_time: signal.barTime,
      sar_trade_date: hourlySessionDate(signal.barTime, tradingDates) || String(tradeDate ?? '').replace(/[^\d]/g, '').slice(0, 8),
      sar_asof_trade_date: String(tradeDate ?? '').replace(/[^\d]/g, '').slice(0, 8),
      five_day_base_date: change.baseDate,
      five_day_base_close: change.baseClose,
      quote_is_live: !!row.is_live,
    }
    if (signal.direction === 'long') longCandidates.push(item)
    else shortCandidates.push(item)
  }

  longCandidates.sort((a, b) => b.pct_5d - a.pct_5d || a.variety.localeCompare(b.variety))
  shortCandidates.sort((a, b) => a.pct_5d - b.pct_5d || a.variety.localeCompare(b.variety))
  return {
    source: 'sina_hourly',
    sourceLabel: '新浪期货 60 分钟 K 线',
    tradeDate: String(tradeDate ?? '').replace(/[^\d]/g, '').slice(0, 8),
    params: { step: SAR_PARAMS.step, max: SAR_PARAMS.max },
    refreshedAt: serviceStatus.lastSuccessAt ?? null,
    state: serviceStatus.state ?? 'idle',
    lastError: serviceStatus.lastError ?? null,
    coverage: {
      total: (rows ?? []).length,
      supported: supported.length,
      unsupported: (rows ?? []).length - supported.length,
      hourly: hourlyCovered,
      rankable: signalCovered,
      longSignals: longCandidates.length,
      shortSignals: shortCandidates.length,
    },
    gainers: longCandidates.slice(0, SAR_TOP_N),
    losers: shortCandidates.slice(0, SAR_TOP_N),
  }
}

/** 小时线拉取、缓存与状态。以低频请求逐合约获取，失败时保留上次成功数据。 */
export class SarService {
  constructor({
    cacheFile = join(config.varDir, 'sar-hourly-cache.json'),
    fetchImpl = (...args) => fetch(...args),
    refreshMs = REFRESH_MS,
    requestSpacingMs = 700,
    concurrency = 2,
  } = {}) {
    this.cacheFile = cacheFile
    this.fetchImpl = fetchImpl
    this.refreshMs = refreshMs
    this.requestSpacingMs = requestSpacingMs
    this.concurrency = Math.max(1, concurrency)
    this.hourly = new Map()
    this.attemptedAt = new Map()
    this.daily = new Map()
    this.inFlight = null
    this.cooldownUntil = 0
    this.state = 'idle'
    this.lastAttemptAt = null
    this.lastSuccessAt = null
    this.lastError = null
    this.#load()
  }

  #load() {
    try {
      if (!existsSync(this.cacheFile)) return
      const doc = JSON.parse(readFileSync(this.cacheFile, 'utf8'))
      if (doc?.schemaVersion !== 1 || !doc.contracts || typeof doc.contracts !== 'object') return
      for (const [contract, entry] of Object.entries(doc.contracts)) {
        const bars = normalizeHourlyBars(entry?.bars)
        if (bars.length >= 3) this.hourly.set(contract.toUpperCase(), { bars, fetchedAt: Number(entry.fetchedAt) || 0 })
      }
      this.lastSuccessAt = doc.lastSuccessAt ?? null
      if (this.hourly.size) this.state = 'cached'
    } catch {
      // 缓存损坏不影响启动；后续成功请求会重建文件。
    }
  }

  get hourlyBarsByContract() {
    return new Map([...this.hourly].map(([contract, entry]) => [contract, entry.bars]))
  }

  stats() {
    return {
      source: 'sina_hourly',
      state: this.state,
      cachedContracts: this.hourly.size,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      inProgress: !!this.inFlight,
      lastError: this.lastError,
    }
  }

  build(rows, tradeDate, klineStore, tradingDates = []) {
    const dailyBarsByContract = new Map()
    for (const row of rows ?? []) {
      const contract = String(row.contract ?? '').toUpperCase()
      if (!contract || !sinaHourlySymbol(row)) continue
      const cached = this.daily.get(contract)
      if (!cached || Date.now() - cached.checkedAt >= 60_000) {
        this.daily.set(contract, {
          bars: klineStore?.get(row.contract)?.bars ?? [],
          checkedAt: Date.now(),
        })
      }
      const bars = this.daily.get(contract)?.bars ?? []
      dailyBarsByContract.set(contract, alignDailyBarsToCalendar(bars, tradingDates, tradeDate))
    }
    return buildSarRanking({
      rows,
      hourlyBarsByContract: this.hourlyBarsByContract,
      dailyBarsByContract,
      tradeDate,
      tradingDates,
      serviceStatus: this.stats(),
    })
  }

  refresh(rows, { force = false, now = Date.now() } = {}) {
    if (this.inFlight) return this.inFlight
    if (!force && now < this.cooldownUntil) return Promise.resolve({ changed: false, attempted: 0, succeeded: 0, coolingDown: true })
    const candidates = (rows ?? []).filter((r) => sinaHourlySymbol(r))
    const due = candidates.filter((row) => {
      const contract = String(row.contract).toUpperCase()
      const last = this.attemptedAt.get(contract) ?? this.hourly.get(contract)?.fetchedAt ?? 0
      return force || now - last >= this.refreshMs
    })
    if (!due.length) return Promise.resolve({ changed: false, attempted: 0, succeeded: 0 })

    this.lastAttemptAt = new Date(now).toISOString()
    this.state = this.hourly.size ? 'refreshing' : 'loading'
    this.inFlight = this.#refreshBatch(due).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  async #refreshBatch(rows) {
    let cursor = 0
    let attempted = 0
    let succeeded = 0
    let firstError = ''
    let transportFailures = 0
    let stopBatch = false
    const worker = async () => {
      while (cursor < rows.length && !stopBatch) {
        const row = rows[cursor++]
        const contract = String(row.contract).toUpperCase()
        this.attemptedAt.set(contract, Date.now())
        attempted++
        try {
          const bars = await fetchHourlyBars(this.fetchImpl, sinaHourlySymbol(row))
          this.hourly.set(contract, { bars, fetchedAt: Date.now() })
          succeeded++
          transportFailures = 0
        } catch (e) {
          if (!firstError) firstError = `${contract}: ${e instanceof Error ? e.message : String(e)}`
          if (isTransportError(e)) transportFailures++
          else transportFailures = 0
          if (transportFailures >= 2) {
            stopBatch = true
            this.cooldownUntil = Date.now() + this.refreshMs
          }
        }
        if (!stopBatch && this.requestSpacingMs > 0 && cursor < rows.length) await delay(this.requestSpacingMs)
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, rows.length) }, worker))

    const at = new Date().toISOString()
    if (succeeded) this.lastSuccessAt = at
    this.lastError = succeeded === rows.length
      ? null
      : stopBatch
        ? `小时线源连接失败，已暂停本轮批量请求（${attempted}/${rows.length} 已尝试；${firstError}）`
        : `${rows.length - succeeded}/${rows.length} 小时线请求失败${firstError ? `（${firstError}）` : ''}`
    this.state = succeeded === rows.length ? 'ok' : this.hourly.size ? 'stale' : 'unavailable'
    if (succeeded) this.#save()
    return { changed: true, attempted, succeeded }
  }

  #save() {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      const contracts = Object.fromEntries(
        [...this.hourly].map(([contract, entry]) => [contract, entry]),
      )
      writeFileSync(this.cacheFile, JSON.stringify({ schemaVersion: 1, lastSuccessAt: this.lastSuccessAt, contracts }), 'utf8')
    } catch {
      // 写缓存失败不影响当前内存中的排序。
    }
  }
}

async function fetchHourlyBars(fetchImpl, symbol) {
  const url = new URL('https://stock2.finance.sina.com.cn/futures/api/jsonp.php/=/InnerFuturesNewService.getFewMinLine')
  url.search = new URLSearchParams({ symbol, type: '60' }).toString()
  const response = await fetchImpl(url, {
    headers: { Referer: REFERER, 'User-Agent': UA },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bars = parseSinaHourlyBars(await response.text())
  if (bars.length < 3) throw new Error('返回小时线不足 3 根')
  return bars.slice(-1023)
}

function normalizeHourlyBars(input) {
  const byTime = new Map()
  for (const b of input ?? []) {
    const time = String(b?.time ?? '').trim()
    const o = Number(b?.o ?? b?.open)
    const h = Number(b?.h ?? b?.high)
    const l = Number(b?.l ?? b?.low)
    const c = Number(b?.c ?? b?.close)
    if (!time || ![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) continue
    if (h < l || h < Math.max(o, c) || l > Math.min(o, c)) continue
    byTime.set(time, { time, o, h, l, c })
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time))
}

function normalizeDailyBars(input) {
  const byDate = new Map()
  for (const b of input ?? []) {
    const d = String(b?.d ?? b?.date ?? '').replace(/[^\d]/g, '').slice(0, 8)
    const c = Number(b?.c ?? b?.close)
    if (!/^\d{8}$/.test(d) || !(c > 0) || !Number.isFinite(c)) continue
    byDate.set(d, { d, c })
  }
  return [...byDate.values()].sort((a, b) => a.d.localeCompare(b.d))
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value, digits) => Math.round(value * (10 ** digits)) / (10 ** digits)

function nextWeekday(yyyymmdd) {
  const y = Number(yyyymmdd.slice(0, 4))
  const m = Number(yyyymmdd.slice(4, 6))
  const d = Number(yyyymmdd.slice(6, 8))
  const date = new Date(Date.UTC(y, m - 1, d + 1))
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function isWeekday(yyyymmdd) {
  const date = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8))))
  return date.getUTCDay() !== 0 && date.getUTCDay() !== 6
}

function isTransportError(error) {
  return !!error?.cause?.code || /fetch failed|socket|network|timeout|timed out|HTTP (403|429|502|503|504)/i.test(String(error?.message ?? error))
}
