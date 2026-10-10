/**
 * 运行状态模块 · **前端渲染逻辑**验证（无浏览器，靠最小 DOM 桩真跑 app.js）
 *
 * 为什么值得单独测：DOM id 存在 ≠ 渲染正确。这里把 app.js 在一个最小 DOM 桩里
 * 真执行一遍，用假的服务端 JSON 驱动 renderSources / loadModelConfig /
 * testModelConn / saveModel / clearModelKey，断言"页面上会出现的 HTML"。
 *
 * 重点回答用户的两条需求：
 *   ① 每个源的**地址 + 连通性 + 延迟**真的渲染出来了（含异常源与延迟分级着色）
 *   ② 模型 API 输入框可测连通性，且 **Key 永不明文出现在任何 DOM 节点里**
 *
 * 用法：node test/verify-ops-ui.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RT = resolve(HERE, '..')
const html = readFileSync(join(RT, 'web', 'index.html'), 'utf8')
const src = readFileSync(join(RT, 'web', 'app.js'), 'utf8')

const results = []
const check = (id, name, cond, extra = '') => {
  results.push({ id, name, pass: !!cond })
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

// ══════════════════════════════════════════════════════════════════════════
//  最小 DOM 桩：只实现 app.js 真正用到的那部分
// ══════════════════════════════════════════════════════════════════════════
const KEY = 'sk-ui-verify-abcdefghijklmnop-9Z8Y'

class El {
  constructor(id = '', tag = 'div') {
    this.id = id
    this.tagName = tag.toUpperCase()
    this._html = ''
    this.textContent = ''
    this.value = ''
    this.placeholder = ''
    this.className = ''
    this.hidden = false
    this.disabled = false
    this.dataset = {}
    this.style = {}
    this.clientWidth = 1200
    this.scrollHeight = 120
    this.children = []
    this.handlers = {}
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !this.classList._s.has(c) : !!force
        if (on) this.classList._s.add(c)
        else this.classList._s.delete(c)
        return on
      },
    }
  }
  get innerHTML() { return this._html }
  set innerHTML(v) { this._html = String(v) }
  addEventListener(t, fn) { (this.handlers[t] ??= []).push(fn) }
  fire(t, ev = {}) { for (const fn of this.handlers[t] ?? []) fn({ preventDefault() {}, target: this, ...ev }) }
  querySelector(selector) { return selector === '.panelClose' ? new El('panelClose', 'button') : null }
  querySelectorAll() { return [] }
  appendChild(c) { this.children.push(c); return c }
  insertBefore(c) { c.parentNode = this; return c }
  remove() {}
  removeChild(c) { this.children = this.children.filter((x) => x !== c) }
  focus() {}
  getBoundingClientRect() { return { width: 1200, height: 400, top: 0, left: 0 } }
}

// index.html 里真实存在的 id 全部预建；缺失的 id 会让 $() 返回 null（暴露前端引用错误）
const els = new Map()
for (const m of html.matchAll(/id="([A-Za-z0-9_]+)"/g)) els.set(m[1], new El(m[1]))
// JS 动态创建的元素
for (const id of ['expandPanel', 'kchart', 'chartWrap', 'chartTip', 'chartLegend', 'kclear', 'kmeta', 'barReadout']) {
  els.set(id, new El(id))
}
const document = {
  getElementById: (id) => {
    if (!els.has(id)) return null
    return els.get(id)
  },
  createElement: (tag) => new El('', tag),
  addEventListener() {},
  body: new El('body'),
  activeElement: null,
  documentElement: new El('html'),
}

// fetch 桩：按 URL 返回假服务端数据，并记录调用
const calls = []
const RESP = {
  '/api/sources': {
    at: Date.parse('2026-09-21T14:00:00+08:00'),
    elapsedMs: 2871,
    tradeDate: '20260918',
    cached: true,
    okCount: 6,
    total: 7,
    sources: [
      { id: 'sina', name: '新浪实时行情', kind: 'live', url: 'https://hq.sinajs.cn/list=<合约列表>', ok: true, latencyMs: 28, detail: '取到 3/3 个合约' },
      { id: 'shfe', name: 'SHFE', kind: 'eod', url: 'https://www.shfe.com.cn/data/tradedata/future/dailydata/kx20260918.dat', ok: true, latencyMs: 237, rows: 301, detail: '20260918 解析出 301 个合约' },
      { id: 'ine', name: 'INE', kind: 'eod', url: 'https://www.ine.cn/x.dat', ok: true, latencyMs: 83, rows: 63, detail: '20260918 解析出 63 个合约' },
      { id: 'czce', name: 'CZCE', kind: 'eod', url: 'https://www.czce.com.cn/a.txt', ok: true, latencyMs: 940, rows: 243, detail: '20260918 解析出 243 个合约' },
      { id: 'gfex', name: 'GFEX', kind: 'eod', url: 'http://www.gfex.com.cn/u/interfacesWebTiDayQuotes/loadList', ok: true, latencyMs: 130, rows: 48, detail: '20260918 解析出 48 个合约' },
      { id: 'cffex', name: 'CFFEX', kind: 'eod', url: 'http://www.cffex.com.cn/sj/hqsj/rtj/202609/18/20260918_1.csv', ok: true, latencyMs: 139, rows: 28, detail: '20260918 解析出 28 个合约' },
      { id: 'dce', name: 'DCE', kind: 'eod', url: 'http://www.dce.com.cn/dceapi/forward/publicweb/dailystat/dayQuotes', ok: false, latencyMs: 25100, error: 'DCE 超时（25000ms）' },
    ],
    local: [
      { id: 'base', name: '基准表 base.json', kind: 'local', url: 'C:\\...\\rank20\\base.json', ok: true, detail: '交易日 20260918 · 基准日 20260821 · 85 个品种' },
      { id: 'kline', name: '日K线库 kline/', kind: 'local', url: 'C:\\...\\rank20\\kline', ok: true, detail: '85 个合约文件' },
      { id: 'out', name: '实时榜产物 盘中实时.md', kind: 'local', url: 'C:\\...\\rank20\\盘中实时.md', ok: true, detail: 'seq 16 · 换价 82/85' },
    ],
    model: { hasKey: false, keyMasked: '' },
  },
  '/api/model/config': {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hasKey: true,
    keyMasked: 'sk-********9Z8Y',
    savedAt: '2026-09-21T06:00:00.000Z',
    storePath: 'C:\\...\\realtime-server\\var\\model.json',
  },
}
let testReply = { ok: true, via: 'chat/completions', url: 'https://api.deepseek.com/v1/chat/completions', status: 200, latencyMs: 412, elapsedMs: 412, model: 'deepseek-chat', reply: 'pong', note: '模型已响应（消耗 1 token 以内）' }

const fetchStub = async (url, opt = {}) => {
  const requestUrl = String(url)
  const parsed = new URL(requestUrl, 'http://127.0.0.1:8899')
  const p = parsed.pathname
  calls.push({ path: p, url: requestUrl, method: opt.method ?? 'GET', body: opt.body ? JSON.parse(opt.body) : null })
  let body
  if (p === '/api/sources' || p === '/api/sources/probe') body = RESP['/api/sources']
  else if (p === '/api/model/config') body = opt.method === 'POST' ? { ok: true, config: RESP['/api/model/config'] } : RESP['/api/model/config']
  else if (p === '/api/model/test') body = testReply
  else if (p === '/api/model/key') body = { ok: true, config: { ...RESP['/api/model/config'], hasKey: false, keyMasked: '' } }
  else if (/^\/api\/variety\/[a-z0-9]+\/sar-hourly$/.test(p)) body = {
    variety: 'rb', contract: 'RB2701', interval: '60m', sourceLabel: '新浪期货 60 分钟 K 线',
    signal: { time: '2026-10-09 15:00', direction: 'long', sar: 3200.25, covered: true },
    bars: [
      { d: '2026-10-09 14:00', time: '2026-10-09 14:00', o: 3210, h: 3230, l: 3200, c: 3220, v: 10, sar: 3190, sarDirection: 'long', src: 'sina60' },
      { d: '2026-10-09 15:00', time: '2026-10-09 15:00', o: 3220, h: 3250, l: 3210, c: 3240, v: 12, sar: 3200.25, sarDirection: 'long', src: 'sina60' },
    ],
  }
  else if (/^\/api\/variety\/[a-z0-9]+\/kline$/.test(p)) body = { variety: 'rb', contract: parsed.searchParams.get('contract') ?? 'RB2701', name: '螺纹钢', bars: [], note: '测试数据' }
  else body = {}
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

class ES {
  constructor() { this.handlers = {} }
  addEventListener(t, fn) { (this.handlers[t] ??= []).push(fn) }
  close() {}
}

const win = { addEventListener() {}, location: { href: 'http://127.0.0.1:8899/' } }

// 执行 app.js，并把要测的函数导出来
const factory = new Function(
  'document', 'window', 'fetch', 'EventSource', 'setInterval', 'setTimeout', 'requestAnimationFrame', 'getComputedStyle', 'confirm', 'location',
  `${src}
   return { renderSources, loadSources, loadModelConfig, saveModel, testModelConn, clearModelKey, initOps, renderSarStatus, paintSar, setView, toggleExpand, loadPanel, renderSarDetails, klinePane, buildExpandRow, state }`,
)
const api = factory(
  document, win, fetchStub, ES,
  () => 0,                       // setInterval：不真跑定时器
  (fn) => 0,                     // setTimeout：不排队（避免画图路径）
  (fn) => 0,                     // requestAnimationFrame
  () => ({ getPropertyValue: () => '#000' }),
  () => true,                    // confirm 永远同意（测 clearModelKey）
  win.location,
)

const $ = (id) => els.get(id)
const domContains = (needle) => {
  for (const el of els.values()) {
    if (el.innerHTML.includes(needle) || el.value.includes(needle) || el.textContent.includes(needle) || el.placeholder.includes(needle)) return true
  }
  return false
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== ① 数据源卡片渲染 ===')
await api.loadSources(false)
const rows = $('srcRows').innerHTML
check('U1', '渲染出 7 个远端源 + 3 个本地产物', (rows.match(/<tr/g) ?? []).length === 10, `${(rows.match(/<tr/g) ?? []).length} 行`)
check('U2', '每行都带真实地址', rows.includes('https://www.shfe.com.cn/data/tradedata/future/dailydata/kx20260918.dat') && rows.includes('hq.sinajs.cn'))
check('U3', '连通性用状态点表达（正常/异常）', rows.includes('dot2 ok') && rows.includes('dot2 bad') && rows.includes('正常') && rows.includes('异常'))
check('U4', '延迟按毫秒渲染并分级着色（<300 绿 / <1000 黄 / ≥1000 红）',
  /class="lat g">28ms/.test(rows) && /class="lat y">940ms/.test(rows) && /class="lat r">25100ms/.test(rows),
  (rows.match(/class="lat [gyr]">\d+ms/g) ?? []).join(' '))
check('U5', '异常源显示原始错误而不是空着', rows.includes('DCE 超时（25000ms）'))
check('U6', '本地产物带 kindLocal 标记并列出状态', rows.includes('kindLocal') && rows.includes('85 个合约文件') && rows.includes('换价 82/85'))
check('U7', '头部摘要：远端源 6/7 可用', $('opsSummary').textContent.includes('远端源 6/7 可用'), $('opsSummary').textContent)
check('U8', '检测耗时与时间戳可见（并标注缓存）', $('srcMeta').textContent.includes('2871ms') && $('srcMeta').textContent.includes('缓存'), $('srcMeta').textContent)
check('U9', '状态异常时摘要变红', $('opsSummary').className === 'bad', `className=${$('opsSummary').className}`)

await api.loadSources(true)
check('U10', '“重新检测”用 POST 强制重探', calls.some((c) => c.path === '/api/sources/probe' && c.method === 'POST'))

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== ② 模型 API 卡片渲染与安全 ===')
await api.loadModelConfig()
check('U11', '地址与模型名回填到输入框', $('mBase').value === 'https://api.deepseek.com/v1' && $('mModel').value === 'deepseek-chat')
check('U12', '**Key 输入框留空**（绝不回填明文）', $('mKey').value === '', JSON.stringify($('mKey').value))
check('U13', '用 placeholder 告知"已保存 + 掩码 + 留空即不改"',
  $('mKey').placeholder.includes('已保存') && $('mKey').placeholder.includes('sk-********9Z8Y'), $('mKey').placeholder)
check('U14', '落盘路径与配置状态可见', $('mStorePath').textContent.includes('model.json') && $('mMeta').textContent.includes('已配置'))
check('U15', '**DOM 桩里找不到明文 Key**', !domContains(KEY))

// 保存：输入框留空 → 请求体不带 apiKey
$('mKey').value = ''
await api.saveModel({ preventDefault() {} })
const saveEmpty = calls.filter((c) => c.path === '/api/model/config' && c.method === 'POST').at(-1)
check('U16', '留空保存 → 请求体不含 apiKey（服务端保持原 Key）', saveEmpty && !('apiKey' in saveEmpty.body), JSON.stringify(saveEmpty?.body))
check('U17', '保存成功给出反馈', $('mResult').innerHTML.includes('已保存到服务端'))

// 保存：填了新 Key → 带上；提交后立刻清空
$('mKey').value = KEY
await api.saveModel({ preventDefault() {} })
const saveNew = calls.filter((c) => c.path === '/api/model/config' && c.method === 'POST').at(-1)
check('U18', '填写新 Key → 才随请求发送', saveNew?.body?.apiKey === KEY)
check('U19', '**提交后立即清空输入框**（明文不在 DOM 常驻）', $('mKey').value === '' && !domContains(KEY))

// 测试连通性：成功
testReply = { ok: true, via: 'chat/completions', status: 200, latencyMs: 412, elapsedMs: 412, model: 'deepseek-chat', reply: 'pong', note: '模型已响应（消耗 1 token 以内）' }
await api.testModelConn()
check('U20', '测试成功渲染 ✓ + 通路 + 延迟', $('mResult').innerHTML.includes('连通成功') && $('mResult').innerHTML.includes('chat/completions') && $('mResult').innerHTML.includes('412ms'),
  $('mResult').innerHTML.replace(/<[^>]+>/g, ' ').trim().slice(0, 90))
check('U21', '测试成功同时展示模型回包（证明真答了）', $('mResult').innerHTML.includes('pong'))
check('U22', '测试期间按钮禁用后恢复', $('mTest').disabled === false && $('mTest').textContent === '测试连通性')

// 测试连通性：失败（含 attempts 明细）
testReply = { ok: false, elapsedMs: 30000, error: '两个探测端点都未成功', hint: '检查：接口地址是否含 /v1、Key 是否有效', attempts: [{ via: 'chat/completions', url: 'x', status: 401, body: '{"error":"invalid key"}' }, { via: 'models', url: 'y', error: 'fetch failed' }] }
await api.testModelConn()
const mr = $('mResult').innerHTML
check('U23', '测试失败渲染 ✗ + 原因 + 可操作提示', mr.includes('连通失败') && mr.includes('两个探测端点都未成功') && mr.includes('检查：接口地址'))
check('U24', '失败明细（attempts）以 <pre> 展开，不吞错误', mr.includes('<pre>') && mr.includes('401') && mr.includes('fetch failed'))

// 清除 Key
await api.clearModelKey()
check('U25', '清除走 DELETE 并给出反馈', calls.some((c) => c.path === '/api/model/key' && c.method === 'DELETE') && $('mResult').innerHTML.includes('已清除'))

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== ③ 折叠与整体安全复查 ===')
api.initOps()
$('opsToggle').fire('click')
check('U26', '折叠按钮切换 collapsed 并改文案', $('ops').classList.contains('collapsed') && $('opsToggle').textContent.includes('展开'), $('opsToggle').textContent)
$('opsToggle').fire('click')
check('U27', '再次点击展开', !$('ops').classList.contains('collapsed') && $('opsToggle').textContent.includes('收起'))

check('U28', '**全过程结束后，任何 DOM 节点都不含明文 Key**', !domContains(KEY))
check('U29', '所有响应里也没有明文 Key 进入页面', !$('srcRows').innerHTML.includes('sk-') || $('srcRows').innerHTML.includes('sk-********9Z8Y'))

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== ④ SAR 榜单视图渲染 ===')
api.state.snap = { sar: { coverage: { longSignals: 1, shortSignals: 0 }, gainers: [], losers: [] } }
api.renderSarStatus({
  state: 'ok', sourceLabel: '新浪期货 60 分钟 K 线', params: { step: 0.02, max: 0.2 },
  tradeDate: '20261009', coverage: { hourly: 5, supported: 8, rankable: 3 }, refreshedAt: '2026-10-10T06:30:00.000Z',
})
api.paintSar('gain', [{
  variety: 'rb', name: '螺纹钢', contract: 'RB2701', direction: 'long', pct_5d: 4.56,
  sar: 3020.5, sar_time: '2026-10-09 14:00', sar_trade_date: '20261009',
}], $('bodySarGain'))
check('U30', '覆盖数、状态和多头行字段真实呈现',
  $('sarCoverage').textContent.includes('5/8') && $('sarCoverage').textContent.includes('可排名 3') &&
  $('sarCoverage').textContent.includes('2026-10-09') &&
  $('bodySarGain').innerHTML.includes('螺纹钢') && $('bodySarGain').innerHTML.includes('+4.56%') &&
  $('bodySarGain').innerHTML.includes('3,020.50') && $('bodySarGain').innerHTML.includes('2026-10-09 14:00 · 2026-10-09') &&
  $('bodySarGain').innerHTML.includes('data-kind="sarGain"'))
api.setView('sar')
check('U31', '指标切换显示 SAR 双榜并更新按钮状态', $('boards').hidden && !$('boardsSar').hidden && $('viewSar').ariaPressed === 'true')

const signal = {
  variety: 'rb', name: '螺纹钢', contract: 'RB2701', direction: 'long', pct_5d: 4.56,
  price: 3250, sar: 3200.25, sar_time: '2026-10-09 15:00', sar_trade_date: '20261009',
  sar_asof_trade_date: '20261009', five_day_base_date: '20261002', five_day_base_close: 3100,
}
api.state.snap = {
  all: [{ variety: 'rb', name: '螺纹钢', contract: 'RB2701', pct_20d: 2.1, is_live: false }],
  sar: { tradeDate: '20261009', sourceLabel: '新浪期货 60 分钟 K 线' },
}
const parent = { insertBefore(child) { child.parentNode = this } }
const sarTr = new El('sarRow', 'tr')
sarTr.dataset = { variety: 'rb', kind: 'sarGain' }
sarTr.parentNode = parent
api.state.rows.sarGain.set('rb', sarTr)
const beforeSarOpen = calls.length
const openSar = api.toggleExpand('rb', 'sarGain', signal)
api.state.expanded.tab = 'sarData'
await openSar
const sarHourlyCall = calls.slice(beforeSarOpen).find((c) => c.path === '/api/variety/rb/sar-hourly')
const hourlyPane = api.klinePane(api.state.expanded, null)
check('U32', '点击 SAR 行请求小时 OHLC 接口并展示具体信号详情',
  sarHourlyCall?.url.includes('?contract=RB2701') &&
  !calls.slice(beforeSarOpen).some((c) => c.path === '/api/variety/rb/kline') &&
  !calls.slice(beforeSarOpen).some((c) => c.path === '/api/variety/rb/logic') &&
  api.state.expanded?.kline?.contract === 'RB2701' && api.state.expanded?.kline?.interval === '60m' &&
  $('expandPanel').innerHTML.includes('2026-10-09 15:00') &&
  $('expandPanel').innerHTML.includes('排序截止交易日') && $('expandPanel').innerHTML.includes('1 小时 K 线图'))
check('U33', 'SAR 小时图按时间戳精确标注信号 K 线，展开行使用七列宽度',
  api.buildExpandRow().innerHTML.includes('colspan="7"') &&
  hourlyPane.includes('小时 K 已标出 2026-10-09 15:00') &&
  src.includes("const sarD = isHourly ? ex.sar?.sar_time : ex.sar?.sar_trade_date"))
api.setView('rank20')

// ══════════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.pass).length
console.log(`\n=== 结果：${pass}/${results.length} 通过${pass === results.length ? '' : `，${results.length - pass} 失败`} ===`)
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.id} ${r.name}`)
process.exit(pass === results.length ? 0 : 1)
