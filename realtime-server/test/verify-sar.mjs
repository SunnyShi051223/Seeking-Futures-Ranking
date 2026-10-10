/** SAR signal, 5 日基准、交易所映射和小时线缓存验证。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/server.mjs'
import {
  SarService,
  alignDailyBarsToCalendar,
  buildSarRanking,
  calculateFiveDayChange,
  computeSarSeries,
  filterHourlyBarsToTradeDate,
  hourlySessionDate,
  sinaHourlySymbol,
  parseSinaHourlyBars,
} from '../src/sar.mjs'

const check = (name, fn) => {
  fn()
  console.log(`  ✓ ${name}`)
}

console.log('\n=== SAR 一小时策略验证 ===')
check('新浪合约代码映射正确，郑商所 3 位月份转换，月均价合约排除', () => {
  assert.equal(sinaHourlySymbol({ variety: 'rb', contract: 'RB2701' }), 'RB2701')
  assert.equal(sinaHourlySymbol({ variety: 'm', contract: 'M2701' }), 'M2701')
  assert.equal(sinaHourlySymbol({ variety: 'ma', contract: 'MA611' }), 'MA2611')
  assert.equal(sinaHourlySymbol({ variety: 'sc', contract: 'SC2611' }), 'SC2611')
  assert.equal(sinaHourlySymbol({ variety: 'if', contract: 'IF2612' }), 'IF2612')
  assert.equal(sinaHourlySymbol({ variety: 'lc', contract: 'LC2701' }), 'LC2701')
  assert.equal(sinaHourlySymbol({ variety: 'ppF', contract: 'PP2612F', isMonthlyAvg: true }), null)
})

check('新浪 60 分钟 JSONP 小时线解析、排序并过滤格式错误的行', () => {
  const bars = parseSinaHourlyBars(`/*json*/=([{"d":"2026-10-09 10:00:00","o":"11","h":"13","l":"10","c":"12","v":"20"},{"d":"bad row","o":"10","h":"12","l":"9","c":"11"},{"d":"2026-10-09 09:00:00","o":"10","h":"12","l":"9","c":"11","v":"10"}]);`)
  assert.deepEqual(bars.map((b) => b.time), ['2026-10-09 09:00', '2026-10-09 10:00'])
  assert.equal(bars[0].c, 11)
})

const rising = [
  { time: 'a', o: 10, h: 11, l: 9, c: 10 },
  { time: 'b', o: 10, h: 12, l: 10, c: 11 },
  { time: 'c', o: 11, h: 13, l: 11, c: 12 },
  { time: 'd', o: 12, h: 14, l: 12, c: 13 },
]
const falling = [
  { time: 'a', o: 12, h: 13, l: 11, c: 12 },
  { time: 'b', o: 11, h: 12, l: 10, c: 11 },
  { time: 'c', o: 10, h: 11, l: 9, c: 10 },
  { time: 'd', o: 9, h: 10, l: 8, c: 9 },
]
const dates = ['20260930', '20261001', '20261002', '20261005', '20261006', '20261008']
const sessionDates = [...dates, '20261009', '20261012']
check('SAR 趋势延续并在价格穿越时反转', () => {
  assert.equal(computeSarSeries(rising).direction, 'long')
  assert.equal(computeSarSeries(rising).sar, 9.16)
  assert.equal(computeSarSeries([...rising, { time: 'e', o: 9, h: 10, l: 8, c: 9 }]).direction, 'short')
  assert.equal(computeSarSeries(falling).direction, 'short')
})

check('夜盘小时线按下一个交易日归属，收盘榜不混入未来信号', () => {
  assert.equal(hourlySessionDate('2026-10-08 21:00', sessionDates), '20261009')
  assert.equal(hourlySessionDate('2026-10-09 23:00', sessionDates), '20261012')
  assert.equal(hourlySessionDate('2026-10-10 01:00', sessionDates), '20261012')
  assert.equal(hourlySessionDate('2026-10-09 01:00', sessionDates), '20261009')
  const bars = [
    { time: '2026-10-09 15:00', o: 10, h: 11, l: 9, c: 10 },
    { time: '2026-10-09 23:00', o: 10, h: 12, l: 9, c: 11 },
    { time: '2026-10-10 00:00', o: 11, h: 12, l: 10, c: 11 },
    { time: '2026-10-10 01:00', o: 11, h: 13, l: 10, c: 12 },
  ]
  assert.deepEqual(filterHourlyBarsToTradeDate(bars, { tradeDate: '20261009', tradingDates: sessionDates }).map((b) => b.time), ['2026-10-09 15:00'])
})

const dailyFlat = dates.map((d) => ({ d, c: 100 }))
check('5 日涨跌幅以交易日收盘价为基准，覆盖盘中未收盘日', () => {
  assert.ok(Math.abs(calculateFiveDayChange(dailyFlat, { price: 110, tradeDate: '20261008' }).pct - 10) < 1e-9)
  assert.ok(Math.abs(calculateFiveDayChange(dailyFlat, { price: 112.2, tradeDate: '20261009', isLive: true }).pct - 12.2) < 1e-9)
  assert.equal(calculateFiveDayChange(dailyFlat.slice(0, 5), { price: 110, tradeDate: '20261008' }), null)
})

check('日 K 缺少无成交日时按交易日历补齐，避免基准前移', () => {
  const sparse = [
    { d: '20260930', c: 100 },
    { d: '20261002', c: 102 },
    { d: '20261006', c: 104 },
    { d: '20261008', c: 106 },
  ]
  const aligned = alignDailyBarsToCalendar(sparse, dates, '20261008')
  assert.deepEqual(aligned.map((b) => b.d), dates)
  assert.equal(aligned[1].c, 100)
  assert.equal(aligned[3].c, 102)
  const change = calculateFiveDayChange(aligned, { price: 110, tradeDate: '20261008' })
  assert.equal(change.baseDate, '20260930')
  assert.equal(change.baseClose, 100)
})

check('多头按 5 日涨幅降序，空头按跌幅升序，各限制前 10 名', () => {
  const rows = []
  const hourlyBarsByContract = new Map()
  const dailyBarsByContract = new Map()
  for (let i = 0; i < 12; i++) {
    for (const [side, bars, pct] of [
      ['L', rising, i + 1],
      ['S', falling, -(i + 1)],
    ]) {
      const contract = `${side === 'L' ? 'M' : 'A'}26${String(i + 1).padStart(2, '0')}`
      const variety = side === 'L' ? 'm' : 'a'
      const row = { variety, name: `${side}${i}`, contract, price: 100 + pct, is_live: false }
      rows.push(row)
      hourlyBarsByContract.set(contract, bars)
      dailyBarsByContract.set(contract, dailyFlat)
    }
  }
  const rank = buildSarRanking({ rows, hourlyBarsByContract, dailyBarsByContract, tradeDate: '20261008' })
  assert.equal(rank.coverage.rankable, 24)
  assert.equal(rank.gainers.length, 10)
  assert.equal(rank.losers.length, 10)
  assert.deepEqual(rank.gainers.map((r) => r.pct_5d), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
  assert.deepEqual(rank.losers.map((r) => r.pct_5d), [-12, -11, -10, -9, -8, -7, -6, -5, -4, -3])
})

check('信号交易日取自最后一根小时线，另保留排序截止日', () => {
  const hourlyBars = rising.map((b, i) => ({
    ...b,
    time: ['2026-10-08 09:00', '2026-10-08 10:00', '2026-10-08 11:00', '2026-10-08 14:00'][i],
  }))
  const item = buildSarRanking({
    rows: [{ variety: 'm', name: '豆粕', contract: 'M2610', price: 110, is_live: false }],
    hourlyBarsByContract: new Map([['M2610', hourlyBars]]),
    dailyBarsByContract: new Map([['M2610', dailyFlat]]),
    tradeDate: '20261009', tradingDates: dates,
  }).gainers[0]
  assert.equal(item.sar_time, '2026-10-08 14:00')
  assert.equal(item.sar_trade_date, '20261008')
  assert.equal(item.sar_asof_trade_date, '20261009')
})

const temp = mkdtempSync(join(tmpdir(), 'future-ranking-sar-'))
try {
  const cacheFile = join(temp, 'sar-cache.json')
  const requested = []
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    requested.push(`${parsed.searchParams.get('symbol')}:${parsed.searchParams.get('type')}`)
    return {
      ok: true,
      text: async () => `/*json*/=([{"d":"2026-10-09 09:00:00","o":"10","h":"12","l":"9","c":"11","v":"10"},{"d":"2026-10-09 10:00:00","o":"11","h":"13","l":"10","c":"12","v":"20"},{"d":"2026-10-09 11:00:00","o":"12","h":"14","l":"11","c":"13","v":"30"}]);`,
    }
  }
  const service = new SarService({ cacheFile, fetchImpl, refreshMs: 60_000, requestSpacingMs: 0 })
  const instruments = [
    { variety: 'rb', contract: 'RB2701' },
    { variety: 'ma', contract: 'MA611' },
  ]
  const result = await service.refresh(instruments)
  assert.equal(result.succeeded, 2)
  assert.deepEqual(requested.sort(), ['MA2611:60', 'RB2701:60'])
  assert.equal(service.stats().cachedContracts, 2)
  const saved = JSON.parse(readFileSync(cacheFile, 'utf8'))
  assert.equal(Object.keys(saved.contracts).length, 2)
  const reloaded = new SarService({ cacheFile, fetchImpl: async () => { throw new Error('must reuse cache') } })
  assert.equal(reloaded.stats().cachedContracts, 2)
  assert.equal((await reloaded.refresh(instruments)).attempted, 0)
  console.log('  ✓ 小时线请求、节流缓存写入与重启读取')

  let failedRequests = 0
  const offline = new SarService({
    cacheFile: join(temp, 'offline-cache.json'),
    fetchImpl: async () => {
      failedRequests++
      const error = new TypeError('fetch failed')
      error.cause = { code: 'UND_ERR_SOCKET' }
      throw error
    },
    refreshMs: 60_000,
    requestSpacingMs: 0,
    concurrency: 2,
  })
  const offlineResult = await offline.refresh([
    { variety: 'rb', contract: 'RB2701' },
    { variety: 'm', contract: 'M2701' },
    { variety: 'ma', contract: 'MA611' },
    { variety: 'sc', contract: 'SC2611' },
  ])
  assert.ok(failedRequests <= 3)
  assert.equal(offlineResult.attempted, failedRequests)
  assert.equal(offline.stats().state, 'unavailable')
  assert.equal((await offline.refresh(instruments)).coolingDown, true)
  assert.equal(failedRequests, offlineResult.attempted)
  console.log('  ✓ 数据源断连后及时熔断，避免批量重试')

  const endpointBars = [
    { time: '2026-10-08 14:00', o: 100, h: 103, l: 99, c: 101, v: 10 },
    { time: '2026-10-09 14:00', o: 101, h: 104, l: 100, c: 102, v: 12 },
    { time: '2026-10-09 15:00', o: 102, h: 106, l: 101, c: 105, v: 14 },
    { time: '2026-10-12 09:00', o: 105, h: 107, l: 104, c: 106, v: 16 },
  ]
  const expectedSignal = computeSarSeries(endpointBars.slice(0, 3))
  const ranked = {
    variety: 'ma', name: '甲醇', contract: 'MA611', direction: expectedSignal.direction,
    sar_time: expectedSignal.barTime, sar_trade_date: '20261009', sar_asof_trade_date: '20261009', sar: expectedSignal.sar,
  }
  const app = createApp({
    poller: { sarService: { hourly: new Map([['MA611', { bars: endpointBars, fetchedAt: Date.now() }]]) } },
    hub: { current: { sar: { tradeDate: '20261009', gainers: [ranked], losers: [] } } },
    baseWatcher: { table: { tradingDates: ['20261008', '20261009', '20261012'] } },
  })
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
  try {
    const address = app.address()
    const response = await fetch(`http://127.0.0.1:${address.port}/api/variety/ma/sar-hourly?contract=MA611`)
    const doc = await response.json()
    assert.equal(response.status, 200)
    assert.equal(doc.interval, '60m')
    assert.equal(doc.source, 'sina_hourly')
    assert.equal(doc.bars.at(-1).time, '2026-10-09 15:00')
    assert.equal(doc.signal.time, '2026-10-09 15:00')
    assert.equal(doc.signal.covered, true)
    assert.ok(doc.bars.every((bar) => [bar.o, bar.h, bar.l, bar.c].every(Number.isFinite)))
    assert.equal(doc.bars.find((bar) => bar.time === doc.signal.time).sar, expectedSignal.sar)
    assert.ok(!doc.bars.some((bar) => bar.time.startsWith('2026-10-12')))
    const denied = await fetch(`http://127.0.0.1:${address.port}/api/variety/ma/sar-hourly?contract=MA999`)
    assert.equal(denied.status, 404)
    console.log('  ✓ SAR 小时线接口返回真实时间戳 OHLC、SAR 序列，并精确覆盖信号小时')
  } finally {
    await new Promise((resolve, reject) => app.close((error) => error ? reject(error) : resolve()))
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}

console.log('\n全部通过 ✓')
