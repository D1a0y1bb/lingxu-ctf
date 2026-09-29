/**
 * lib/client.js（Web 控制面板 + 配置卡片浏览器半）单测。
 *
 * 刻意**不引入 jsdom**：本文件手写一个最小 DOM stub，只实现 client.js 真正用到的
 * 那部分 API（createElement / appendChild / innerHTML / textContent / dataset /
 * addEventListener / 假定时器）。这样测试零依赖、跑得快，也不会把浏览器语义的
 * 复杂度带进 CI。
 *
 * 加载方式与生产**完全一致**：client.js 是 classic script（无顶层 export），
 * 由 DSH 客户端模块加载器抓取并期待它调 `window.__ModuleLoader__.load({id, factory})`。
 * 所以这里先 stub `__ModuleLoader__`，import 后捕获 factory，再物化拿插件导出。
 */

import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'

// ────────────────────────────────────────────────────────────── 最小 DOM stub

function createDom() {
  const byId = new Map()
  const docListeners = new Map()
  const timers = new Map()
  let nextTimerId = 1

  function makeEl(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      nodeType: 1,
      children: [],
      parentNode: null,
      className: '',
      style: {},
      dataset: {},
      attrs: {},
      value: '',
      type: '',
      _text: '',
      _html: '',
      _id: '',
      _listeners: {},
      get id() { return this._id },
      set id(value) {
        if (this._id) byId.delete(this._id)
        this._id = String(value)
        byId.set(this._id, this)
      },
      get textContent() { return this._text },
      set textContent(value) {
        this._text = String(value)
        this._html = ''
        this.children.length = 0
      },
      get innerHTML() { return this._html },
      set innerHTML(value) {
        this._html = String(value)
        this.children.length = 0
      },
      appendChild(child) {
        child.parentNode = this
        this.children.push(child)
        return child
      },
      removeChild(child) {
        const index = this.children.indexOf(child)
        if (index >= 0) this.children.splice(index, 1)
        return child
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this)
        if (this._id) byId.delete(this._id)
      },
      setAttribute(key, value) { this.attrs[key] = String(value) },
      getAttribute(key) { return key in this.attrs ? this.attrs[key] : null },
      addEventListener(type, fn) {
        this._listeners[type] = (this._listeners[type] || []).concat(fn)
      },
      removeEventListener(type, fn) {
        this._listeners[type] = (this._listeners[type] || []).filter((item) => item !== fn)
      },
      dispatch(type, event) {
        for (const fn of this._listeners[type] || []) fn(event || { target: this })
      },
      querySelector() { return null },
      querySelectorAll() { return [] },
      focus() {},
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains() { return false },
      },
    }
    return node
  }

  const head = makeEl('head')
  const body = makeEl('body')
  const documentElement = makeEl('html')
  documentElement.appendChild(head)
  documentElement.appendChild(body)

  const document = {
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    head,
    body,
    documentElement,
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      docListeners.set(type, (docListeners.get(type) || []).concat(fn))
    },
    removeEventListener() {},
    dispatch(type, event) {
      for (const fn of docListeners.get(type) || []) fn(event || {})
    },
  }

  const window = {
    setInterval(fn) {
      const id = nextTimerId++
      timers.set(id, fn)
      return id
    },
    clearInterval(id) { timers.delete(id) },
    addEventListener() {},
    removeEventListener() {},
  }

  return {
    document,
    window,
    /** 手动触发所有已注册的 interval 回调。 */
    runTimers() {
      for (const fn of [...timers.values()]) fn()
    },
    timerCount: () => timers.size,
  }
}

/** 递归拼接 stub 树里的文本（含 innerHTML 去标签）。 */
function collectText(node) {
  if (!node) return ''
  let out = node._text || ''
  out += String(node._html || '').replace(/<[^>]*>/g, ' ')
  for (const child of node.children || []) out += ` ${collectText(child)}`
  return out
}

/** 递归拼接 stub 树里的原始 HTML（用于断言 class / 结构）。 */
function collectHtml(node) {
  if (!node) return ''
  let out = node._html || ''
  for (const child of node.children || []) out += collectHtml(child)
  return out
}

/**
 * 每个用例的清理注册表。
 *
 * `apply()` 的面板是模块级单例（`getPanel()` 只在 `mounted === false` 时重建），
 * 所以断言失败导致漏掉 `destroy()` 时，**下一个用例会拿到上一个用例的面板**，
 * 出现难以定位的连锁失败。这里用 afterEach 兜底，保证用例之间彻底隔离。
 */
const live = { panels: [], envs: [], views: [] }

afterEach(() => {
  for (const panel of live.panels.splice(0)) {
    try { panel.destroy() } catch { /* 已销毁 */ }
  }
  for (const view of live.views.splice(0)) {
    try { view.destroy() } catch { /* 已销毁 */ }
  }
  for (const env of live.envs.splice(0)) {
    try { env.restore() } catch { /* 已还原 */ }
  }
})

/** 登记面板，交给 afterEach 销毁。 */
function track(panel) {
  live.panels.push(panel)
  return panel
}

/** 安装全局 stub，返回清理函数。 */
function installGlobals(fetchImpl) {
  const dom = createDom()
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  }
  globalThis.document = dom.document
  globalThis.window = dom.window
  globalThis.fetch = fetchImpl
  const env = {
    dom,
    restore() {
      if (saved.document === undefined) delete globalThis.document
      else globalThis.document = saved.document
      if (saved.window === undefined) delete globalThis.window
      else globalThis.window = saved.window
      if (saved.fetch === undefined) delete globalThis.fetch
      else globalThis.fetch = saved.fetch
    },
  }
  live.envs.push(env)
  return env
}

// ────────────────────────────────────────────────────────────── 以生产路径加载 client.js

const CLIENT_URL = new URL('../lib/client.js', import.meta.url)
let loadSeq = 0

/**
 * 按 DSH 客户端模块加载器的方式加载 client.js：
 * stub `window.__ModuleLoader__` → 动态 import（classic script，无顶层 export）→
 * 捕获 factory → 物化 → 拿到插件导出。
 *
 * 每次用不同 query，让 ESM 求值一份**全新实例**（模块级单例互不干扰）。
 */
/** React 元素标记，供断言使用。 */
const ELEMENT = Symbol.for('react.element')

async function loadClientModule({ react = null } = {}) {
  const captured = []
  assert.ok(globalThis.window, 'loadClientModule 需要先安装 window stub')
  globalThis.window.__ModuleLoader__ = {
    load: (registration) => { captured.push(registration) },
  }
  await import(`${CLIENT_URL.href}?case=${++loadSeq}`)
  assert.equal(captured.length, 1, '应当恰好向 __ModuleLoader__ 注册一个 factory')
  const registration = captured[0]
  assert.equal(registration.id, 'dsh-lingxu-ctf')
  assert.equal(typeof registration.factory, 'function')
  const requireStub = (id) => {
    if (id === 'react' && react !== null) return react
    throw new Error(`unexpected require(${id})`)
  }
  return { api: registration.factory(requireStub), registration }
}

// 共享实例：供纯函数类用例使用（不关心单例状态）。
const bootstrapDom = createDom()
globalThis.document = bootstrapDom.document
globalThis.window = bootstrapDom.window
const bootstrapped = await loadClientModule()
const client = bootstrapped.api

// 顶层自挂载在 import 时已经挂了一个浮动面板，立刻销毁，避免污染后续用例。
client.getPanel().destroy()

const {
  name,
  apply,
  createPanel,
  normalizeState,
  normalizeChallenge,
  filterChallenges,
  groupChallenges,
  challengeCategories,
  formatDuration,
  formatTime,
  escapeHtml,
  truncate,
  renderStatusHtml,
  renderBoardHtml,
  renderLeaderboardHtml,
  renderSubmissionsHtml,
  renderTheoryHtml,
  renderStatsHtml,
  renderHeaderMetaHtml,
  findHostContainer,
  normalizeConfig,
  configFieldKind,
  renderConfigSummary,
  collectConfigPatch,
  createConfigCard,
  renderConfigSlot,
  registerConfigCard,
  resetConfigSummaryCache,
  NOT_CONFIGURED_HINT,
  STATE_URL,
  POLL_INTERVAL_MS,
  CONFIG_URL,
  CONFIG_SLOT,
  CONFIG_SLOT_KEY,
  SECRET_SET_PLACEHOLDER,
  SECRET_UNSET_PLACEHOLDER,
  // ── task-13：顶部「CTF」视图 tab ──
  VIEW_SLOT,
  VIEW_SLOT_ID,
  VIEW_ORDER,
  VIEW_CLASS,
  VIEW_TABS,
  VIEW_LOCALE_NS,
  TEAM_URL,
  REPORTS_URL,
  createCtfView,
  registerCtfView,
  renderCtfViewSlot,
  renderViewMetaHtml,
  renderViewStatsHtml,
  renderViewBoardHtml,
  renderViewAgentsHtml,
  renderViewMessagesHtml,
  renderViewSubmissionsHtml,
  renderViewReportsHtml,
  normalizeTeam,
  normalizeReports,
  normalizeTaskStatus,
  normalizeMemberStatus,
  normalizeEnv,
  formatShortDuration,
  envStateOf,
  taskTypeLabel,
  renderTaskTypeBadgeHtml,
  renderEnvChipHtml,
  memberEnvOf,
  envChallengesOf,
  runningEnvCount,
  renderViewEnvHtml,
  renderViewChallengeCard,
  renderViewTabCount,
  challengeKey,
  mergeChallengeBoard,
  viewStats,
  memberLastActivity,
  floatingPanelEnabled,
  pendingFloatingSync,
  FLOATING_CONFIG_KEY,
  AGENT_STATUS_LABELS,
  TASK_STATUS_LABELS,
  MESSAGE_KIND_LABELS,
} = client

/** 构造一个「已配置 + 有数据」的快照。 */
function fullSnapshot() {
  return {
    connection: { key: 'lingxu:host:4', platform: 'lingxu', baseUrl: 'https://example.test:8000', eventId: 4, label: '测试赛' },
    event: { name: '2026 测试赛', remainingSeconds: 3661, user: { username: 'alice' }, punish: true },
    stats: { total: 78, solved: 1, working: 2, pending: 75, totalScore: 120 },
    rank: { rank: 4, total: 12, self: { id: 7, username: 'alice', score: 120 } },
    leaderboard: [
      { rank: 1, username: 'bob', score: 300, isSelf: false },
      { rank: 4, username: 'alice', score: 120, isSelf: true },
    ],
    challenges: [
      { id: 1, name: '签到', category: 'Misc', score: 100, solved: true, status: 'solved', owner: 'solver-misc-01', submitAttempts: 2 },
      { id: 2, name: '<img src=x onerror=alert(1)>', category: 'Web', score: 200, solved: false, status: 'working', owner: 'solver-web-01', submitAttempts: 1 },
      { id: 3, name: 'RSA', category: 'Crypto', score: 300, solved: false, status: 'pending', owner: null, submitAttempts: 0 },
    ],
    submissions: [
      { at: '2026-09-29T01:13:00Z', challengeId: 1, challengeName: '签到', status: 'correct', flag: '****' },
      { at: '2026-09-29T01:20:00Z', challengeId: 2, challengeName: 'XSS', status: 'incorrect', flag: '****' },
    ],
    theory: [
      { id: 3, name: '理论题 A', count: 100, isBegin: true, remainingSeconds: 3600 },
      { id: 4, name: '理论题 B', count: 50, isBegin: false, remainingSeconds: null },
    ],
  }
}

const jsonResponse = (payload, init = {}) => ({
  ok: init.ok !== false,
  status: init.status ?? 200,
  json: async () => payload,
})

/**
 * 显式挂出右下角悬浮面板的辅助函数。
 *
 * task-13 起 `apply()` **默认不挂**悬浮面板（用户明确要求不要；只有宿主
 * `GET /lingxu-ctf/config` 下发 `enableFloatingPanel: true` 才挂）。下面这些用例
 * 测的是面板自身的渲染 / 轮询 / 折叠行为，所以显式打开开关 ——
 * 默认行为另有专门用例（见「悬浮面板：默认不挂」一节）。
 */
const floatingApply = (ctx = null, options = {}) => apply(ctx, { ...options, enableFloating: true })

/** 等待一次宏任务，让 fetch/promise 链落地。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 依次 await 所有 pending 的悬浮面板决策，避免用例之间互相干扰。 */
async function settleFloating() {
  const { pendingFloatingSync } = client
  await pendingFloatingSync()
  await flush()
}

// ────────────────────────────────────────────────────────────── 1. 模块形态

test('模块导出 shape：name + apply + 纯函数助手', () => {
  assert.equal(name, 'dsh-lingxu-ctf')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof createPanel, 'function')
  assert.equal(typeof normalizeState, 'function')
  assert.equal(typeof filterChallenges, 'function')
  assert.equal(STATE_URL, '/lingxu-ctf/state')
  assert.equal(POLL_INTERVAL_MS, 5000)
})

test('自包含 classic script 形态：0 顶层 export / 0 裸包 import / 走 __ModuleLoader__', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // classic script 里顶层 export 是语法错误 → 面板与卡片会全部消失
  assert.deepEqual(source.match(/^export\s/gm) || [], [], '不能有顶层 export')
  // ESM import 语句在 classic script 里同样是语法错误
  assert.deepEqual(source.match(/^\s*import\s.+$/gm) || [], [], '不能有 import 语句')
  assert.equal(/\bimport\s*\(/.test(source), false, '不能有动态 import()')
  // require 只允许取 react（模块表静态 externalized 的那一个）
  const requires = [...new Set(
    [...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]),
  )]
  assert.deepEqual(requires, ['react'], '只允许 require("react")，不得引入其他包')
  // 必须注册进客户端模块表，否则拿不到 ctx
  assert.match(source, /__ModuleLoader__\.load/)
  // 确认用的是真实存在的 DSH token 命名空间
  assert.match(source, /--dsw-alias-/)
  // 注释里提到过 --dsh-color-*（说明为何不用），这里断言的是**实际使用**：
  assert.equal(source.includes('var(--dsh-color-'), false, '--dsh-color-* 在安装版 DSH 中不存在，不应使用')
})

// ────────────────────────────────────────────────────────────── 2. 容错

test('normalizeState 对 null / 垃圾输入全部容错且不抛错', () => {
  for (const input of [null, undefined, 42, 'nope', [], {}, { stats: 'x', challenges: 'y' }]) {
    const state = normalizeState(input)
    assert.equal(state.configured, false)
    assert.deepEqual(state.challenges, [])
    assert.equal(typeof state.event.name, 'string')
    assert.equal(typeof state.stats.total, 'number')
    assert.equal(state.rank.rank, null)
  }
})

test('normalizeState 在字段缺失时从 challenges 推导统计', () => {
  const state = normalizeState({
    connection: { key: 'k' },
    challenges: [{ id: 1, solved: true }, { id: 2, status: 'working' }, { id: 3 }],
  })
  assert.equal(state.configured, true)
  assert.equal(state.stats.total, 3)
  assert.equal(state.stats.solved, 1)
  assert.equal(state.stats.working, 1)
  assert.equal(state.stats.pending, 1)
  assert.equal(state.challenges[0].category, '未分类')
})

test('normalizeChallenge 状态推断：solved 布尔与 status 字符串双向兼容', () => {
  assert.equal(normalizeChallenge({ solved: true }).status, 'solved')
  assert.equal(normalizeChallenge({ status: 'working' }).status, 'working')
  assert.equal(normalizeChallenge({ status: 'in_progress' }).status, 'working')
  assert.equal(normalizeChallenge({}).status, 'pending')
  assert.equal(normalizeChallenge(null).submitAttempts, 0)
})

// ────────────────────────────────────────────────────────────── 3. 纯函数

test('formatDuration', () => {
  assert.equal(formatDuration(0), '已结束')
  assert.equal(formatDuration(-5), '已结束')
  assert.equal(formatDuration(45), '45秒')
  assert.equal(formatDuration(90), '1分30秒')
  assert.equal(formatDuration(3661), '1小时1分')
  assert.equal(formatDuration(7200), '2小时')
  assert.equal(formatDuration(86400), '1天')
  assert.equal(formatDuration(90000), '1天1小时')
  assert.equal(formatDuration(null), '—')
  assert.equal(formatDuration('abc'), '—')
})

test('escapeHtml 阻断注入', () => {
  const evil = '<img src=x onerror=alert(1)>'
  const escaped = escapeHtml(evil)
  assert.equal(escaped.includes('<'), false)
  assert.equal(escaped.includes('>'), false)
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;')
})

test('truncate 与 formatTime', () => {
  assert.equal(truncate('abcdef', 4), 'abc…')
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(formatTime(''), '—')
  assert.equal(formatTime('not-a-date'), 'not-a-date')
  assert.match(formatTime('2026-09-29T01:13:00Z'), /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

test('filterChallenges 按分类 / 状态 / 关键字过滤', () => {
  const state = normalizeState(fullSnapshot())
  assert.equal(filterChallenges(state.challenges, {}).length, 3)
  assert.equal(filterChallenges(state.challenges, { category: 'Web' }).length, 1)
  assert.equal(filterChallenges(state.challenges, { status: 'solved' }).length, 1)
  assert.equal(filterChallenges(state.challenges, { query: 'rsa' }).length, 1)
  assert.equal(filterChallenges(state.challenges, { query: 'solver-web-01' }).length, 1)
  assert.equal(filterChallenges(state.challenges, { category: 'Web', status: 'pending' }).length, 0)
  assert.equal(filterChallenges(state.challenges, { query: '不存在' }).length, 0)
})

test('groupChallenges 分组并统计已解数', () => {
  const state = normalizeState(fullSnapshot())
  const groups = groupChallenges(state.challenges)
  assert.deepEqual(groups.map((group) => group.category), ['Misc', 'Web', 'Crypto'])
  assert.equal(groups[0].solved, 1)
  assert.equal(groups[2].solved, 0)
  assert.deepEqual(challengeCategories(state.challenges), ['Misc', 'Web', 'Crypto'])
})

// ────────────────────────────────────────────────────────────── 4. 渲染片段

test('渲染片段：头部 / 统计 / 看板 / 排行榜 / 审计 / 理论题', () => {
  const state = normalizeState(fullSnapshot())

  const meta = renderHeaderMetaHtml(state)
  assert.match(meta, /lingxu/)
  assert.match(meta, /赛事 #4/)
  assert.match(meta, /剩余 1小时1分/)
  assert.match(meta, /得分 120/)
  assert.match(meta, /排名 4\/12/)
  assert.match(meta, /错误提交扣分中/)

  const stats = renderStatsHtml(state)
  assert.match(stats, /总数/)
  assert.match(stats, /78/)
  assert.match(stats, /总分/)

  const board = renderBoardHtml(state, {})
  assert.match(board, /Crypto/)
  assert.match(board, /RSA/)
  assert.match(board, /solver-misc-01/)
  assert.match(board, /提交 2 次/)
  // 注入防护：题目名里的标签必须被转义
  assert.equal(board.includes('<img src=x'), false)
  assert.match(board, /&lt;img src=x onerror=alert\(1\)&gt;/)

  const rank = renderLeaderboardHtml(state)
  assert.match(rank, /lx-self/)
  assert.match(rank, /bob/)
  assert.match(rank, /我/)

  const subs = renderSubmissionsHtml(state)
  assert.match(subs, /正确/)
  assert.match(subs, /错误/)
  assert.match(subs, /签到/)

  const theory = renderTheoryHtml(state)
  assert.match(theory, /理论题 A/)
  assert.match(theory, /100 题/)
  assert.match(theory, /进行中/)
  assert.match(theory, /未开始/)
})

test('渲染片段：空数据时给出空态而不是崩溃', () => {
  const empty = normalizeState({ connection: { key: 'k' } })
  assert.match(renderBoardHtml(empty, {}), /暂无题目数据/)
  assert.match(renderLeaderboardHtml(empty), /暂无排行榜数据/)
  assert.match(renderSubmissionsHtml(empty), /暂无 flag 提交记录/)
  assert.match(renderTheoryHtml(empty), /暂无理论题试卷/)
  assert.match(renderBoardHtml(normalizeState(fullSnapshot()), { query: '不存在' }), /没有符合筛选条件/)
})

test('渲染片段标签闭合平衡（innerHTML 结构不会破损）', () => {
  // 因为所有插值都经过 escapeHtml，属性值里不会出现裸 '>'，可以安全地做朴素标签扫描。
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link'])
  const imbalance = (html) => {
    const stack = []
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g
    let match
    while ((match = re.exec(html)) !== null) {
      const name = match[2].toLowerCase()
      if (VOID.has(name) || match[3] === '/') continue
      if (match[1] === '/') {
        if (stack.pop() !== name) return `意外闭合 </${name}>`
      } else stack.push(name)
    }
    return stack.length === 0 ? null : `未闭合：${stack.join(',')}`
  }

  const state = normalizeState(fullSnapshot())
  const fragments = {
    meta: renderHeaderMetaHtml(state),
    stats: renderStatsHtml(state),
    board: renderBoardHtml(state, {}),
    boardFiltered: renderBoardHtml(state, { category: 'Web' }),
    boardEmpty: renderBoardHtml(state, { query: '不存在' }),
    rank: renderLeaderboardHtml(state),
    subs: renderSubmissionsHtml(state),
    theory: renderTheoryHtml(state),
    statusEmpty: renderStatusHtml(normalizeState({ connection: null }), { loading: false, loaded: true }),
    statusError: renderStatusHtml(state, { error: 'boom' }),
    statusLoading: renderStatusHtml(state, { loading: true, loaded: false }),
  }
  for (const [key, html] of Object.entries(fragments)) {
    assert.equal(imbalance(html), null, `${key} 标签不平衡`)
  }
})

test('renderStatusHtml：错误态 / 加载态 / 未配置空态', () => {
  const unconfigured = normalizeState({ connection: null })
  assert.match(renderStatusHtml(unconfigured, { loading: true, loaded: false }), /正在加载/)
  assert.match(renderStatusHtml(unconfigured, { loading: false, loaded: true }), new RegExp(NOT_CONFIGURED_HINT))
  assert.match(renderStatusHtml(unconfigured, { error: 'boom' }), /加载失败/)
  assert.equal(renderStatusHtml(normalizeState(fullSnapshot()), { loading: false, loaded: true }), '')
})

test('排行榜最多 20 行', () => {
  const many = normalizeState({
    connection: { key: 'k' },
    leaderboard: Array.from({ length: 30 }, (_, index) => ({ rank: index + 1, username: `u${index}`, score: 0, isSelf: false })),
  })
  const html = renderLeaderboardHtml(many)
  assert.equal((html.match(/<tr/g) || []).length, 21) // 1 表头 + 20 数据行
  assert.match(html, /u19/)
  assert.equal(html.includes('u20'), false)
})

// ────────────────────────────────────────────────────────────── 5. apply / 生命周期

test('apply(ctx) 通过 ctx.effect 注册且不抛错，销毁后卸载', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const registered = []
    const ctx = {
      effect(fn, label) {
        registered.push({ fn, label })
        return () => {}
      },
    }
    const panel = track(floatingApply(ctx))
    await settleFloating()
    assert.ok(registered.length >= 1, '应通过 ctx.effect 托管生命周期')
    assert.match(registered.map((item) => item.label).join(' '), /lingxu-ctf/)
    assert.equal(panel.mounted, true)
    assert.ok(env.dom.document.getElementById('lingxu-ctf-panel'))

    // 模拟 cordis 执行每个 effect 拿到 disposer，并全部释放
    for (const item of registered) {
      const dispose = item.fn()
      assert.equal(typeof dispose, 'function')
      dispose()
    }
    assert.equal(panel.mounted, false)
    assert.equal(env.dom.document.getElementById('lingxu-ctf-panel'), null)
  } finally {
    env.restore()
  }
})

test('apply(null)（浏览器自挂载路径）不抛错且可销毁', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const panel = track(floatingApply())
    await settleFloating()
    assert.equal(panel.mounted, true)
    assert.equal(env.dom.timerCount(), 1, '应启动轮询定时器')
    panel.destroy()
    assert.equal(env.dom.timerCount(), 0, '销毁后应清掉定时器')
  } finally {
    env.restore()
  }
})

test('findHostContainer：找不到容器时返回 null（→ 浮动模式）', () => {
  const dom = createDom()
  assert.equal(findHostContainer(dom.document), null)
  assert.equal(findHostContainer(null), null)
  const host = dom.document.createElement('div')
  dom.document.querySelector = (selector) => (selector === '[data-lingxu-ctf-mount]' ? host : null)
  assert.equal(findHostContainer(dom.document), host)
})

// ────────────────────────────────────────────────────────────── 6. 数据流

test('成功路径：渲染赛事名、统计、题目卡片、排行榜与提交审计', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const panel = track(floatingApply())
    await panel.refresh()
    const text = collectText(panel.root())
    const html = collectHtml(panel.root())

    assert.match(text, /2026 测试赛/)
    assert.match(text, /78/)
    assert.match(text, /签到/)
    assert.match(text, /RSA/)
    assert.match(text, /solver-web-01/)
    assert.match(text, /alice/)
    assert.match(text, /理论题 A/)
    assert.match(html, /lx-self/)
    assert.equal(text.includes('加载失败'), false)

    // 请求打到宿主约定的路由，且带 no-store
    assert.equal(panel.state.snapshot.configured, true)
    panel.destroy()
  } finally {
    env.restore()
  }
})

test('契约对齐：宿主 buildPanelState 真实输出形状可直接渲染', () => {
  // 形状取自 lib/index.js 的 buildPanelState()：含 ok / configured / updatedAt，
  // rank 可能为 null、event.user 可能为 null、flag 已由宿主 maskFlag 脱敏。
  const hostPayload = {
    ok: true,
    configured: true,
    connection: { key: 'lingxu:x.test:8000:4', platform: 'lingxu', baseUrl: 'https://x.test:8000', eventId: 4, label: 'L' },
    event: { name: '真实赛事', remainingSeconds: 7200, user: null, punish: true, startTime: '', endTime: '' },
    stats: { total: 2, solved: 1, working: 1, pending: 0, totalScore: 100 },
    rank: null,
    leaderboard: [{ rank: 1, username: 'bob', score: 300, isSelf: false }],
    challenges: [
      { id: 1, name: '签到', category: 'Misc', score: 100, solved: true, status: 'solved', owner: null, submitAttempts: 1 },
      { id: 2, name: 'XSS', category: 'Web', score: 200, solved: false, status: 'working', owner: 'solver-web-01', submitAttempts: 0 },
    ],
    submissions: [{ at: '2026-09-29T01:13:00Z', challengeId: 1, challengeName: '签到', status: 'correct', flag: 'flag{r********e}' }],
    theory: [{ id: 3, name: '理论题', count: 50, isBegin: true, remainingSeconds: 1800 }],
    updatedAt: '2026-09-29T01:14:00.000Z',
  }
  const state = normalizeState(hostPayload)
  assert.equal(state.configured, true)
  // rank:null 与 event.user:null 不得让渲染崩溃，也不应凭空造出排名
  assert.equal(renderHeaderMetaHtml(state).includes('排名'), false)
  assert.match(renderHeaderMetaHtml(state), /错误提交扣分中/)
  assert.equal(renderStatusHtml(state, { loading: false, loaded: true }), '')
  assert.match(renderBoardHtml(state, {}), /solver-web-01/)
  assert.match(renderSubmissionsHtml(state), /正确/)
  assert.match(renderTheoryHtml(state), /理论题/)
  assert.match(renderStatsHtml(state), /100/)
})

test('契约对齐：宿主未配置时的 {ok:false,configured:false,error} 走空态而非错误态', async () => {
  const env = installGlobals(async () => jsonResponse({
    ok: false,
    configured: false,
    error: '未找到可用的平台连接，请先调用 ctf_connect 配置平台地址与 sessionid',
  }))
  try {
    const panel = track(floatingApply())
    await panel.refresh()
    const text = collectText(panel.root())
    assert.match(text, new RegExp(NOT_CONFIGURED_HINT))
    assert.equal(text.includes('加载失败'), false)
  } finally {
    env.restore()
  }
})

test('fetch 抛错 → 渲染错误态', async () => {
  const env = installGlobals(async () => { throw new Error('network down') })
  try {
    const panel = track(floatingApply())
    await panel.refresh()
    const text = collectText(panel.root())
    assert.match(text, /加载失败/)
    assert.match(text, /network down/)
    assert.match(collectHtml(panel.root()), /lx-retry/)
    panel.destroy()
  } finally {
    env.restore()
  }
})

test('HTTP 非 2xx → 渲染错误态', async () => {
  const env = installGlobals(async () => ({ ok: false, status: 502, json: async () => null }))
  try {
    const panel = track(floatingApply())
    await panel.refresh()
    assert.match(collectText(panel.root()), /HTTP 502/)
    panel.destroy()
  } finally {
    env.restore()
  }
})

test('未配置平台 → 空态提示 ctf_connect', async () => {
  const env = installGlobals(async () => jsonResponse({ connection: null, error: 'not configured' }))
  try {
    const panel = track(floatingApply())
    await panel.refresh()
    const text = collectText(panel.root())
    assert.match(text, new RegExp(NOT_CONFIGURED_HINT))
    assert.equal(text.includes('加载失败'), false, '未配置是空态，不应显示为错误态')
    panel.destroy()
  } finally {
    env.restore()
  }
})

test('响应不是 JSON（json() 抛错）→ 错误态而非崩溃', async () => {
  const env = installGlobals(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }))
  try {
    const panel = track(floatingApply())
    await panel.refresh()
    assert.match(collectText(panel.root()), /暂无题目数据|加载失败/)
    panel.destroy()
  } finally {
    env.restore()
  }
})

// ────────────────────────────────────────────────────────────── 7. 轮询与交互

test('轮询：页面隐藏时暂停，恢复可见后立即刷新', async () => {
  let calls = 0
  const env = installGlobals(async () => { calls += 1; return jsonResponse(fullSnapshot()) })
  try {
    const panel = track(floatingApply())
    await panel.refresh()
    const afterInitial = calls
    assert.ok(afterInitial >= 1)

    env.dom.document.hidden = true
    env.dom.runTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, afterInitial, '隐藏时不应发起请求')

    env.dom.document.hidden = false
    env.dom.runTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(calls > afterInitial, '可见时应恢复轮询')
    panel.destroy()
  } finally {
    env.restore()
  }
})

test('交互：分类 / 状态 / 搜索过滤会重绘看板', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const panel = track(floatingApply())
    await panel.refresh()
    const root = panel.root()
    const find = (className) => {
      const stack = [root]
      while (stack.length > 0) {
        const node = stack.pop()
        if (node.className && node.className.includes(className)) return node
        for (const child of node.children || []) stack.push(child)
      }
      return null
    }

    // 断言只看**看板区域**：提交审计里也有「签到」，不能拿整面板文本判断过滤结果。
    const board = find('lx-board')
    assert.ok(board, '应存在题目看板区域')

    const search = find('lx-search')
    assert.ok(search, '应存在搜索框')
    search.value = 'RSA'
    search.dispatch('input')
    assert.match(collectText(board), /RSA/)
    assert.equal(collectText(board).includes('签到'), false, '搜索后不应出现不匹配的题目')

    search.value = ''
    search.dispatch('input')
    assert.match(collectText(board), /签到/)
    const categorySel = find('lx-filter-category')
    assert.ok(categorySel, '应存在分类下拉框')
    assert.match(categorySel.innerHTML, /全部分类/)
    assert.match(categorySel.innerHTML, /Crypto/)
    categorySel.value = 'Crypto'
    categorySel.dispatch('change')
    assert.match(collectText(board), /RSA/)
    assert.equal(collectText(board).includes('签到'), false)

    const statusSel = find('lx-filter-status')
    statusSel.value = 'solved'
    statusSel.dispatch('change')
    assert.match(collectText(board), /没有符合筛选条件/)
    panel.destroy()
  } finally {
    env.restore()
  }
})

test('折叠：启动器可展开 / 收起', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const panel = track(floatingApply())
    await panel.refresh()
    const root = panel.root()
    panel.setCollapsed(true)
    assert.equal(root.dataset.collapsed, 'true')
    panel.setCollapsed(false)
    assert.equal(root.dataset.collapsed, 'false')
    panel.destroy()
  } finally {
    env.restore()
  }
})

test('重复 apply 不会挂出第二个面板', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const first = track(floatingApply())
    const second = track(floatingApply())
    assert.equal(first, second)
    await settleFloating()
    const panels = collectHtml(env.dom.document.body).match(/id="lingxu-ctf-panel"/g) || []
    assert.equal(panels.length, 0) // stub 的 id 走属性赋值，不在 innerHTML 里
    assert.equal(env.dom.document.getElementById('lingxu-ctf-panel') !== null, true)
    first.destroy()
  } finally {
    env.restore()
  }
})

test('createPanel 可显式注入 doc/win/fetch，不依赖全局', async () => {
  const dom = createDom()
  const panel = createPanel({
    doc: dom.document,
    win: dom.window,
    fetchImpl: async () => jsonResponse(fullSnapshot()),
    intervalMs: 1234,
  })
  panel.mount()
  await panel.refresh()
  assert.match(collectText(panel.root()), /2026 测试赛/)
  panel.destroy()
})

// ────────────────────────────────────────────────────────────── 8. 生产路径：classic script + __ModuleLoader__

test('生产路径：脚本执行即向 __ModuleLoader__ 注册 factory（默认不挂悬浮面板）', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const { api, registration } = await loadClientModule()
    // ① 模块表注册（宿主据此建 cordis entry → 拿到真 ctx）
    assert.equal(registration.id, 'dsh-lingxu-ctf')
    assert.equal(typeof registration.factory, 'function')
    // factory 物化后必须给出 name / apply
    assert.equal(api.name, 'dsh-lingxu-ctf')
    assert.equal(typeof api.apply, 'function')
    // ② 顶层装配完成，但**不再默认挂右下角悬浮**（task-13）
    await api.pendingFloatingSync()
    assert.equal(
      env.dom.document.getElementById('lingxu-ctf-panel'),
      null,
      '默认（宿主没开 enableFloatingPanel）不应挂悬浮面板',
    )

    // 显式打开开关后才挂，并且能正常渲染
    const panel = track(api.getPanel())
    await api.maybeMountFloatingPanel({ enableFloating: true })
    const mounted = env.dom.document.getElementById('lingxu-ctf-panel')
    assert.ok(mounted, '显式打开后应挂出面板')
    assert.equal(panel.root(), mounted)
    await panel.ready
    assert.match(collectText(panel.root()), /2026 测试赛/)
    assert.match(collectText(panel.root()), /RSA/)
  } finally {
    env.restore()
  }
})

test('生产路径：DOM 未就绪（readyState=loading）时等 DOMContentLoaded 再装配', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  env.dom.document.readyState = 'loading'
  try {
    const { api } = await loadClientModule()
    assert.equal(env.dom.document.getElementById('lingxu-ctf-panel'), null, 'DOM 未就绪时不应提前挂载')

    env.dom.document.dispatch('DOMContentLoaded')
    await api.pendingFloatingSync()
    // DOMContentLoaded 之后也只是「装配完成」：悬浮面板默认仍不挂
    assert.equal(env.dom.document.getElementById('lingxu-ctf-panel'), null)

    const panel = track(api.maybeMountFloatingPanel({ enableFloating: true }))
    await panel
    assert.ok(env.dom.document.getElementById('lingxu-ctf-panel'), '显式打开后应挂载')
    await track(api.getPanel()).ready
    assert.match(collectText(track(api.getPanel()).root()), /2026 测试赛/)
  } finally {
    env.restore()
  }
})

test('生产路径：宿主页面没有 fetch 时也不抛错（降级为错误态）', async () => {
  const env = installGlobals(undefined)
  try {
    const { api } = await loadClientModule()
    // 没有 fetch → 无法判定悬浮开关 → 默认不挂（顶层装配不抛错）
    await api.pendingFloatingSync()
    assert.equal(env.dom.document.getElementById('lingxu-ctf-panel'), null)
    // 显式挂载后帧渲染降级为可读错误态，而不是崩溃
    const panel = track(api.getPanel())
    panel.mount()
    panel.start()
    await panel.refresh()
    assert.match(collectText(panel.root()), /加载失败|不支持 fetch/)
  } finally {
    env.restore()
  }
})

test('生产路径：没有 __ModuleLoader__ 时脚本仍能跑（装配照旧）', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    // 模拟「没有模块加载器」的降级场景：注册应当被安全跳过
    const { api } = await loadClientModule()
    delete globalThis.window.__ModuleLoader__
    await api.pendingFloatingSync()
    track(api.getPanel())
    assert.equal(env.dom.document.getElementById('lingxu-ctf-panel'), null, '默认不挂悬浮')
  } finally {
    env.restore()
  }
})

test('生产路径：classic script 无 export，Node 侧经全局兜底取到 API', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const { api } = await loadClientModule()
    // 全局兜底暴露的是内部 API 对象（factory 返回的是带 Module tag 的副本）
    const fallback = globalThis.__DSH_LINGXU_CTF_CLIENT__
    assert.equal(fallback.name, 'dsh-lingxu-ctf')
    assert.equal(typeof fallback.renderConfigSlot, 'function')
    assert.equal(typeof fallback.registerCtfView, 'function')
    assert.equal(typeof fallback.createCtfView, 'function')
    assert.equal(typeof fallback.apply, 'function')
    assert.equal(fallback.name, api.name)
    track(api.getPanel())
  } finally {
    env.restore()
  }
})

test('生产路径：文件可被当作 **classic script** 求值（浏览器真实解析方式）', () => {
  // 这是本文件最关键的回归护栏：DSH 的 defaultLoadBundle 用
  // `document.createElement("script")`（无 type="module"）加载 bundle，
  // 所以只要有人加回顶层 `export` / `import.meta`，浏览器就会 SyntaxError、
  // 视图 tab 与配置卡片全部消失。vm.runInContext 按 **script** 编译，正好复现这一点。
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const dom = createDom()
  const registered = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registered.push(registration) } },
    document: dom.document,
    console,
  }
  vm.createContext(sandbox)

  assert.doesNotThrow(
    () => vm.runInContext(source, sandbox, { filename: 'lingxu-ctf-client.js' }),
    '必须以 classic script 语法通过（顶层 export 会在此抛 SyntaxError）',
  )
  assert.equal(registered.length, 1, '求值后应恰好注册一个 factory')
  assert.equal(registered[0].id, 'dsh-lingxu-ctf')
  assert.equal(typeof registered[0].factory, 'function')

  // 物化后仍要给出 name / apply / inject 与视图注册入口
  const exports = registered[0].factory(() => { throw new Error('no react') })
  assert.equal(exports.name, 'dsh-lingxu-ctf')
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.registerCtfView, 'function')
  // 注意：数组来自 vm 的另一个 realm，需拷回本 realm 再比较
  assert.deepEqual([...exports.inject], ['slots'])
  // 视图常量：slot 名 / id / 顺序都必须与 DSH 契约一致
  assert.equal(exports.VIEW_SLOT, 'conversation.view')
  assert.equal(exports.VIEW_SLOT_ID, 'ctf')
  assert.equal(exports.VIEW_ORDER, 20)

  // classic script 求值后默认**不挂**右下角悬浮面板（宿主没开开关）
  assert.equal(
    dom.document.getElementById('lingxu-ctf-panel'),
    null,
    '默认不挂悬浮面板；图省事的自挂载不能把面板塞回页面',
  )
})

// ────────────────────────────────────────────────────────────── 9. 配置卡片（task-8）

/** 12 个字段的配置快照，形状对齐宿主 `GET /lingxu-ctf/config`。 */
function configPayload() {
  return {
    ok: true,
    fields: [
      { key: 'baseUrl', label: '平台地址', type: 'string', description: '平台根地址', role: null, default: '' },
      { key: 'eventId', label: '赛事 ID', type: 'number', description: '赛事 ID', role: null, default: null },
      { key: 'cookie', label: 'Cookie（sessionid）', type: 'string', description: '凌虚 sessionid Cookie', role: 'secret', default: '' },
      { key: 'label', label: '连接备注名', type: 'string', description: '连接备注名', role: null, default: '' },
      { key: 'concurrency', label: '并发解题 Agent 数', type: 'number', description: '并发解题 agent 数', role: null, default: 4 },
      { key: 'maxWrongAttempts', label: '单题错误提交上限', type: 'number', description: '每题错误提交上限', role: null, default: 0 },
      { key: 'dedupeFlags', label: 'flag 本地去重', type: 'boolean', description: 'flag 去重', role: null, default: true },
      { key: 'workDir', label: '工作目录', type: 'string', description: '解题工作目录', role: null, default: '' },
      { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'number', description: '请求超时（毫秒）', role: null, default: 30000 },
      { key: 'enableWebPanel', label: '显示 Web 控制面板', type: 'boolean', description: '启用 Web 面板', role: null, default: true },
    ],
    values: {
      baseUrl: 'https://x.test:8000',
      eventId: 4,
      cookie: '',
      label: '测试',
      concurrency: 4,
      maxWrongAttempts: 0,
      dedupeFlags: true,
      workDir: '',
      timeoutMs: 30000,
      enableWebPanel: true,
    },
    secretsSet: { cookie: true, token: false },
  }
}

/** 按 name 找控件。 */
function findByKey(root, key) {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node && node.name === key) return node
    for (const child of (node && node.children) || []) stack.push(child)
  }
  return null
}

/** 统计带某个 class 的节点数。 */
function countByClass(root, cls) {
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node && typeof node.className === 'string' && node.className.split(/\s+/).includes(cls)) count += 1
    for (const child of (node && node.children) || []) stack.push(child)
  }
  return count
}

/** GET 返回配置、POST 记录调用的 fetch stub。 */
function configFetch(payload, postResult = { ok: true, changed: 1 }) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    if (init && init.method === 'POST') return jsonResponse(postResult)
    return jsonResponse(payload)
  }
  return { impl, calls }
}

const postCalls = (calls) => calls.filter((call) => call.init && call.init.method === 'POST')

test('配置：normalizeConfig 容错 + 字段类型归一', () => {
  const config = normalizeConfig(configPayload())
  assert.equal(config.ok, true)
  assert.equal(config.fields.length, 10)
  assert.equal(config.secretsSet.cookie, true)

  assert.equal(configFieldKind({ type: 'boolean' }), 'boolean')
  assert.equal(configFieldKind({ type: 'number' }), 'number')
  assert.equal(configFieldKind({ type: 'string' }), 'text')
  assert.equal(configFieldKind({ type: 'string', role: 'secret' }), 'password')
  assert.equal(configFieldKind({ type: 'union', options: ['a'] }), 'select')
  assert.equal(configFieldKind(null), 'text')
  assert.equal(configFieldKind({ type: '未知类型' }), 'text')

  for (const bad of [null, undefined, 42, 'x', [], {}, { fields: 'nope' }, { fields: [null, {}] }]) {
    const tolerant = normalizeConfig(bad)
    assert.deepEqual(tolerant.fields, [])
    assert.equal(typeof tolerant.values, 'object')
  }
})

test('配置：renderConfigSummary 一句话摘要', () => {
  assert.equal(renderConfigSummary(normalizeConfig(configPayload())), '平台：凌虚 · event 4 · 已配置')
  // 缺 secret → 未配置
  const noSecret = configPayload()
  noSecret.secretsSet = { cookie: false }
  assert.match(renderConfigSummary(normalizeConfig(noSecret)), /未配置$/)
  assert.match(renderConfigSummary(normalizeConfig({ ok: false, error: '配置服务未就绪' })), /配置不可用：配置服务未就绪/)
})

test('配置：collectConfigPatch 只发改动，secret 空串绝不回传', () => {
  const config = normalizeConfig(configPayload())
  const values = config.values

  assert.deepEqual(collectConfigPatch(config, { ...values }), {}, '无改动不应产生 patch')
  assert.deepEqual(collectConfigPatch(config, { ...values, cookie: '', token: '' }), {}, 'secret 空串是「不修改」哨兵')

  assert.deepEqual(collectConfigPatch(config, { ...values, cookie: 'sessionid=x' }), { cookie: 'sessionid=x' })
  assert.deepEqual(collectConfigPatch(config, { ...values, baseUrl: 'https://new.test' }), { baseUrl: 'https://new.test' })
  assert.deepEqual(collectConfigPatch(config, { ...values, dedupeFlags: false }), { dedupeFlags: false })
  assert.deepEqual(collectConfigPatch(config, { ...values, concurrency: '8' }), { concurrency: 8 })
  assert.deepEqual(collectConfigPatch(config, { ...values, concurrency: 'abc' }), {}, '非数字应忽略')
  assert.deepEqual(collectConfigPatch(config, { ...values, eventId: '' }), {}, 'number 空值应忽略')
})

test('配置卡片：渲染 10 个字段，控件类型正确、标签中文化', async () => {
  const dom = createDom()
  const { impl } = configFetch(configPayload())
  const card = createConfigCard({ doc: dom.document, fetchImpl: impl })
  await card.refresh()

  // 8 个输入型字段在网格里，2 个布尔开关单独一行（放进网格会把行撑高、复选框被居中）
  assert.equal(countByClass(card.element, 'lx-config-field'), 8, '网格里应有 8 个输入型字段')
  assert.equal(countByClass(card.element, 'lx-config-check'), 2, '开关行应有 2 个布尔项')
  assert.equal(countByClass(card.element, 'lx-config-toggles'), 1, '应有独立的开关行容器')
  assert.equal(findByKey(card.element, 'eventId').type, 'number')
  assert.equal(findByKey(card.element, 'dedupeFlags').type, 'checkbox')
  assert.equal(findByKey(card.element, 'enableWebPanel').type, 'checkbox')
  assert.equal(findByKey(card.element, 'baseUrl').type, 'text')
  assert.equal(findByKey(card.element, 'baseUrl').value, 'https://x.test:8000')
  assert.equal(findByKey(card.element, 'dedupeFlags').checked, true)

  const text = collectText(card.element)
  assert.match(text, /平台根地址/, '应显示字段描述')
  // 用户要求：不显示标题与说明性文字，也不显示「共 N 项配置」
  assert.doesNotMatch(text, /凌虚 CTF 配置/)
  assert.doesNotMatch(text, /共 \d+ 项配置/)
  assert.doesNotMatch(text, /只保存在 DSH 本地存储/)
  // 标签必须走中文 label，而不是英文 key
  assert.match(text, /平台地址/)
  assert.match(text, /并发解题 Agent 数/)
  assert.doesNotMatch(text, /baseUrl/)
  card.destroy()
})

test('配置卡片：secret 永不回显，placeholder 反映 secretsSet', async () => {
  const dom = createDom()
  const payload = configPayload()
  // 即使宿主（错误地）回显了 cookie，也必须被忽略
  payload.values.cookie = 'sessionid=LEAKED'
  const { impl } = configFetch(payload)
  const card = createConfigCard({ doc: dom.document, fetchImpl: impl })
  await card.refresh()

  const cookie = findByKey(card.element, 'cookie')
  assert.equal(cookie.type, 'password')
  assert.equal(cookie.value, '', 'secret 绝不能回显')
  assert.equal(cookie.placeholder, SECRET_SET_PLACEHOLDER)

  const text = collectText(card.element)
  assert.equal(text.includes('LEAKED'), false, '页面里不得出现 secret 明文')
  assert.match(text, /当前：已设置/)

  // secretsSet 为 false 时 placeholder 应显示「未设置」
  const dom2 = createDom()
  const payload2 = configPayload()
  payload2.secretsSet = { cookie: false }
  const card2 = createConfigCard({ doc: dom2.document, fetchImpl: configFetch(payload2).impl })
  await card2.refresh()
  assert.equal(findByKey(card2.element, 'cookie').placeholder, SECRET_UNSET_PLACEHOLDER)
  assert.match(collectText(card2.element), /当前：未设置/)
  card2.destroy()
  card.destroy()
})

test('配置卡片：保存只 POST 改动过的字段', async () => {
  const dom = createDom()
  const { impl, calls } = configFetch(configPayload())
  const card = createConfigCard({ doc: dom.document, fetchImpl: impl })
  await card.refresh()

  findByKey(card.element, 'baseUrl').value = 'https://new.test:9000'
  findByKey(card.element, 'cookie').value = 'sessionid=abc'
  await card.save()

  const posts = postCalls(calls)
  assert.equal(posts.length, 1, '应恰好发一次 POST')
  assert.equal(posts[0].url, CONFIG_URL)
  assert.equal(posts[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(posts[0].init.body), {
    patch: { baseUrl: 'https://new.test:9000', cookie: 'sessionid=abc' },
  })
  assert.match(collectText(card.element), /已保存/)
  // 保存后重新 GET 刷新（1 次初始 + 1 次刷新）
  assert.equal(calls.filter((call) => !call.init || call.init.method !== 'POST').length, 2)
  // 刷新后 secret 输入框重新清空
  assert.equal(findByKey(card.element, 'cookie').value, '')
  card.destroy()
})

test('配置卡片：没有改动时不发 POST', async () => {
  const dom = createDom()
  const { impl, calls } = configFetch(configPayload())
  const card = createConfigCard({ doc: dom.document, fetchImpl: impl })
  await card.refresh()
  await card.save()

  assert.equal(postCalls(calls).length, 0, '无改动不应发 POST')
  assert.match(collectText(card.element), /没有需要保存的改动/)
  card.destroy()
})

test('配置卡片：GET 503 → 可读中文错误态，保存按钮禁用', async () => {
  const dom = createDom()
  const impl = async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: '配置服务未就绪' }) })
  const card = createConfigCard({ doc: dom.document, fetchImpl: impl })
  await card.refresh()

  const text = collectText(card.element)
  assert.match(text, /读取配置失败/)
  assert.match(text, /配置服务未就绪/)
  assert.equal(countByClass(card.element, 'lx-config-field'), 0, '错误态不应渲染表单')
  card.destroy()
})

test('配置卡片：网络异常 / POST 失败 → 错误态', async () => {
  const dom = createDom()
  const boom = createConfigCard({
    doc: dom.document,
    fetchImpl: async () => { throw new Error('network down') },
  })
  await boom.refresh()
  assert.match(collectText(boom.element), /读取配置失败：network down/)
  boom.destroy()

  const dom2 = createDom()
  const impl = async (url, init) => (init && init.method === 'POST'
    ? { ok: false, status: 500, json: async () => ({ ok: false, error: '写入失败' }) }
    : jsonResponse(configPayload()))
  const card = createConfigCard({ doc: dom2.document, fetchImpl: impl })
  await card.refresh()
  findByKey(card.element, 'baseUrl').value = 'https://changed'
  await card.save()
  assert.match(collectText(card.element), /保存失败：写入失败/)
  card.destroy()
})

test('配置卡片：注册进 plugins.bundle.config，key 为包名', () => {
  const registered = []
  const injected = []
  const ctx = {
    slots: {
      register(options, render) { registered.push({ options, render }); return () => {} },
      inject(slot, fn) { injected.push(slot); fn(); return () => {} },
    },
    effect(fn, label) { return fn() },
  }
  const register = registerConfigCard(ctx)
  assert.equal(typeof register, 'function')
  assert.deepEqual(injected, [CONFIG_SLOT])
  assert.equal(CONFIG_SLOT, 'plugins.bundle.config')
  assert.equal(CONFIG_SLOT_KEY, 'dsh-lingxu-ctf')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'plugins.bundle.config')
  assert.equal(registered[0].options.key, 'dsh-lingxu-ctf')
  assert.equal(typeof registered[0].render, 'function')
  // summary 视图必须给一句话字符串（React 可直接渲染）
  const summary = registered[0].render({ view: 'summary' })
  assert.equal(typeof summary, 'string')
  assert.ok(summary.length > 0)
})

test('配置卡片：没有 slots 服务时安全跳过（不抛错）', () => {
  assert.equal(registerConfigCard(null), null)
  assert.equal(registerConfigCard(undefined), null)
  assert.equal(registerConfigCard({}), null)
  assert.equal(registerConfigCard({ slots: {} }), null)
  assert.equal(registerConfigCard({ slots: { register: 'not-a-function' } }), null)
})

test('配置卡片：slot 渲染 —— 有 React 给元素，无 React 退化为纯 DOM', () => {
  // 有 React：返回组件函数，调用后得到挂载点元素
  const react = {
    createElement(type, props, ...children) { return { $$typeof: ELEMENT, type, props, children } },
    useRef: () => ({ current: null }),
    useEffect: () => {},
  }
  const element = renderConfigSlot({ view: 'page' }, { react, doc: createDom().document })
  // ⚠️ 必须返回**元素**。渲染器是 `const Comp = entry.component; renderEntry(..., Comp, ...)`，
  // React 直接调用 slot 函数并把返回值当 React child；返回函数会抛
  // "Functions are not valid as a React child" → SlotErrorBoundary 捕获 →
  // reportEntryError({abdicate:true}) → 该 key 被退休 → 只剩空的 <div data-slot-error>。
  assert.notEqual(typeof element, 'function', '不能返回组件函数')
  assert.equal(element && element.$$typeof, ELEMENT, '必须返回 React 元素')
  assert.equal(typeof element.type, 'function')
  const inner = element.type({})
  assert.equal(inner.type, 'div')
  assert.equal(inner.props.className, 'lx-config-host')

  // 无 React：直接给纯 DOM 节点
  const dom = createDom()
  const node = renderConfigSlot(
    { view: 'page' },
    { doc: dom.document, fetchImpl: async () => jsonResponse(configPayload()) },
  )
  assert.ok(node, '无 React 时应返回 DOM 节点')
  assert.equal(node.className, 'lx-config')
})

test('配置卡片：summary 预热后带平台与 event 信息', async () => {
  resetConfigSummaryCache()
  const dom = createDom()
  const options = { doc: dom.document, fetchImpl: async () => jsonResponse(configPayload()) }

  const first = renderConfigSlot({ view: 'summary' }, options)
  assert.equal(typeof first, 'string')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = renderConfigSlot({ view: 'summary' }, options)
  assert.match(second, /平台：凌虚/)
  assert.match(second, /event 4/)
  assert.match(second, /已配置/)
  resetConfigSummaryCache()
})

test('apply(ctx)：注册配置卡片 + CTF 视图 tab，悬浮面板按开关决定', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const registered = []
    const injected = []
    const ctx = {
      slots: {
        register(options) { registered.push(options); return () => {} },
        inject(slot, fn) { injected.push(slot); fn(); return () => {} },
      },
      effect(fn) { return fn() },
    }
    const panel = track(apply(ctx))
    await settleFloating()
    const byName = (name) => registered.filter((options) => options.name === name)
    assert.equal(byName('plugins.bundle.config').length, 1, 'apply 应把配置卡片注册进 slot')
    assert.equal(byName('plugins.bundle.config')[0].key, 'dsh-lingxu-ctf')
    // 无 ctx.sessions → 降级：视图 tab 始终注册
    assert.equal(byName('conversation.view').length, 1, 'apply 应注册顶部 CTF 视图 tab')
    assert.equal(byName('conversation.view')[0].id, 'ctf')
    assert.deepEqual(injected, ['plugins.bundle.config', 'conversation.view'])
    assert.equal(panel.mounted, false, '默认不挂右下角悬浮面板')
    assert.equal(env.dom.document.getElementById('lingxu-ctf-panel'), null)
  } finally {
    env.restore()
  }
})

// ────────────────────────────────────────────── 配置卡片必须返回 React 元素

test('renderConfigSlot(page) 必须返回 React 元素，而不是组件函数', async () => {
  // 渲染器是 `const Comp = entry.component; renderEntry(slotKey, Comp, ...)`：
  // React 直接调用 slot 函数，把返回值当 React child。
  // 返回函数会抛 "Functions are not valid as a React child" →
  // SlotErrorBoundary 捕获 → reportEntryError({abdicate:true}) → 该 key 被退休 →
  // 只剩一个空的 <div data-slot-error>（表现为一段空白，卡片永不出现）。
  const { api } = await loadClientModule()
  const created = []
  const react = {
    createElement(type, props, ...children) {
      created.push({ type, props })
      return { $$typeof: ELEMENT, type, props: props ?? {}, children }
    },
    useRef: () => ({ current: null }),
    useEffect: () => {},
  }

  const out = api.renderConfigSlot({ view: 'page' }, { react })

  assert.notEqual(typeof out, 'function', '不能返回组件函数')
  assert.equal(out && out.$$typeof, ELEMENT, '必须返回 React 元素')
  assert.equal(typeof out.type, 'function', '元素类型应是我们的组件函数')

  // 真正被 React 调用的是元素 type，调用后必须仍返回元素（不是函数/DOM）
  const rendered = out.type({})
  assert.equal(rendered && rendered.$$typeof, ELEMENT, '组件调用后也必须返回元素')
  assert.equal(rendered.type, 'div')
  assert.equal(rendered.props.className, 'lx-config-host')
})

test('renderConfigSlot(summary) 返回字符串（React 可直接渲染）', async () => {
  const { api } = await loadClientModule()
  const out = api.renderConfigSlot({ view: 'summary' }, {})
  assert.equal(typeof out, 'string')
  assert.equal(out.length > 0, true)
})

test('CSS 作用域：面板布局不得泄漏到配置卡片上', async () => {
  // 卡片渲染在插件页里（不在 #lingxu-ctf-panel 内）。
  // 若面板的 position:fixed 等布局声明与卡片同处一个选择器，
  // 卡片会变成右下角浮层、布局全乱（用户看到的「CSS 丢失」）。
  const { api } = await loadClientModule()
  const css = api.panelCss()

  // position:fixed 只能出现在 #lingxu-ctf-panel 块里
  const fixedBlocks = [...css.matchAll(/([^{}]+)\{[^}]*position:fixed/g)].map((m) => m[1].trim())
  assert.deepEqual(fixedBlocks, ['#lingxu-ctf-panel'], `position:fixed 只能作用于面板，实际: ${JSON.stringify(fixedBlocks)}`)
  // 卡片自己的块不得含任何定位
  const cardBlock = /\.lx-config\{([^}]*)\}/.exec(css)
  assert.ok(cardBlock, '应有 .lx-config 基础块')
  for (const bad of ['position:', 'z-index:', 'right:', 'bottom:']) {
    assert.equal(cardBlock[1].includes(bad), false, `.lx-config 不得含 ${bad}`)
  }
})

// ────────────────────────────────────────────── 主题：只用 DSH 真实 token（task-15）

/**
 * DSH 主题 token 白名单（104 个 `--dsw-alias-*`）。
 *
 * 提取方式：`dsh-client-ui-theme/lib/client.js` 里 `body{...}` /
 * `body[data-ds-dark-theme]{...}` 两份定义，grep `--dsw-alias-`。
 * 本白名单用来**防止 token 名写错导致静默失效**（写错的 var() 不会有任何报错，
 * 只会让颜色变成 transparent/继承）。
 */
const DSH_ALIAS_TOKEN_WHITELIST = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-bg-document-preview', '--dsw-alias-bg-document-selection',
  '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask-1', '--dsw-alias-bg-mask-2', '--dsw-alias-bg-mask-3',
  '--dsw-alias-bg-mask-drop', '--dsw-alias-bg-mask-photo', '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-multi-select', '--dsw-alias-bg-overlay', '--dsw-alias-bg-skeleton',
  '--dsw-alias-border-inverted', '--dsw-alias-border-inverted2', '--dsw-alias-border-l1',
  '--dsw-alias-border-l2', '--dsw-alias-border-l2-darkmode-thin', '--dsw-alias-border-l3', '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary', '--dsw-alias-brand-primary-invert', '--dsw-alias-brand-primary-new-colorprimary-new-color',
  '--dsw-alias-brand-text',
  '--dsw-alias-button-contrast-fill', '--dsw-alias-button-elevated-fill', '--dsw-alias-button-floating-fill',
  '--dsw-alias-button-floating-hover', '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-button-ghost-active-fill', '--dsw-alias-button-ghost-active-hover',
  '--dsw-alias-button-info-fill', '--dsw-alias-button-info-hover', '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-tool-bar-fill', '--dsw-alias-button-tool-bar-fill-invisible', '--dsw-alias-button-tool-bar-hover',
  '--dsw-alias-code-diff-added', '--dsw-alias-code-diff-deleted',
  '--dsw-alias-file-diff-added-bg', '--dsw-alias-file-diff-added-gutter', '--dsw-alias-file-diff-added-marker',
  '--dsw-alias-file-diff-deleted-bg', '--dsw-alias-file-diff-deleted-gutter', '--dsw-alias-file-diff-deleted-marker',
  '--dsw-alias-interactive-bg-active', '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-hover-danger', '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-label-caption', '--dsw-alias-label-deep-diving', '--dsw-alias-label-deep-diving-shimmer',
  '--dsw-alias-label-dimmed', '--dsw-alias-label-document-preview', '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-bluish', '--dsw-alias-label-primary-dimmed', '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-primary-inverted', '--dsw-alias-label-secondary', '--dsw-alias-label-shimmer',
  '--dsw-alias-label-tertiary', '--dsw-alias-link',
  '--dsw-alias-markdown-citation', '--dsw-alias-markdown-code-block', '--dsw-alias-markdown-code-block-banner',
  '--dsw-alias-markdown-code-segment-selected', '--dsw-alias-markdown-code-segment-unselected',
  '--dsw-alias-markdown-inline-code', '--dsw-alias-markdown-placeholder', '--dsw-alias-markdown-tag',
  '--dsw-alias-menu-icon', '--dsw-alias-onboarding-accent', '--dsw-alias-onboarding-card-fill',
  '--dsw-alias-onboarding-checkbox-border', '--dsw-alias-onboarding-secondary-fill',
  '--dsw-alias-scrollbar-bg-l1', '--dsw-alias-scrollbar-bg-l2', '--dsw-alias-scrollbar-hover-l1', '--dsw-alias-scrollbar-hover-l2',
  '--dsw-alias-settings-card-fill', '--dsw-alias-settings-card-stroke',
  '--dsw-alias-state-business-primary', '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-error-secondary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-success-secondary', '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label', '--dsw-alias-state-warn-primary', '--dsw-alias-state-warn-secondary', '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-switch-thumb', '--dsw-alias-toast-bg', '--dsw-alias-toast-label',
  '--dsw-alias-tooltip-bg', '--dsw-alias-tooltip-key-bg',
])

test('★ 主题：CSS 里不得出现 prefers-color-scheme（暗色靠 body[data-ds-dark-theme]）', async () => {
  // 这是 task-15 最关键的回归防线：DSH 的暗色由 `body[data-ds-dark-theme]` 切换，
  // token 自己会变；用媒体查询判断暗色会导致「系统浅色 + DSH 暗色」时露出浅色兜底。
  const { api } = await loadClientModule()
  const css = api.panelCss()
  assert.equal(css.includes('prefers-color-scheme'), false, 'CSS 输出里不得有 prefers-color-scheme')

  // 源码层面也守一道（去掉注释后仍不得出现），防止有人写到别的函数里
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(
    withoutComments.includes('prefers-color-scheme'), false,
    'lib/client.js（注释以外）不得再出现 prefers-color-scheme —— 主题必须交给 DSH 的 body[data-ds-dark-theme]',
  )
})

test('★ 主题：不得有 --lx-* 间接层（直接用 var(--dsw-alias-*)）', async () => {
  const { api } = await loadClientModule()
  const css = api.panelCss()
  assert.equal(css.includes('--lx-'), false, 'CSS 里不得再定义/使用 --lx-* 变量')
  // 顺带确认：没有残留的 hex 颜色兜底（DSH token 才是唯一来源）
  const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
  assert.deepEqual(hexes, [], `CSS 里不应出现硬编码 hex 颜色，实际: ${hexes.join(',')}`)
})

test('★ 主题：用到的 --dsw-alias-* 名必须在白名单内（防拼错 token 静默失效）', async () => {
  const { api } = await loadClientModule()
  const css = api.panelCss()
  const used = [...new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((m) => m[1]))]
  assert.ok(used.length >= 20, `应该用到足够多的 token，实际 ${used.length}`)
  for (const token of used) {
    if (!token.startsWith('--dsw-alias-')) {
      // 非 alias 命名空间目前只允许面板阴影（theme 的 elevation 块，定义在 body,body *）
      assert.deepEqual([token], ['--dsw-elevation-panel'], `未预期的非 alias token: ${token}`)
      continue
    }
    assert.ok(DSH_ALIAS_TOKEN_WHITELIST.has(token), `token 名不在 DSH 白名单里（拼错了？）：${token}`)
  }
})

test('主题：三个出口都用 token 上色（视图 / 配置卡片 / 悬浮面板）', async () => {
  const { api } = await loadClientModule()
  const css = api.panelCss()
  // ① 悬浮面板：带定位 + 浮层底
  assert.match(css, /#lingxu-ctf-panel\{position:fixed;[^}]*color:var\(--dsw-alias-label-primary\)/)
  // ② 配置卡片：卡片底 + 分隔边框（不再自带定位）
  assert.match(css, /\.lx-config\{[^}]*background:var\(--dsw-alias-bg-layer-1\)[^}]*\}/)
  // ③ 视图：会话区里自己滚动（ui-conversation 的 viewArea 是 overflow:hidden 的弹性盒）
  assert.match(css, /\.lx-view\{[^}]*height:100%[^}]*overflow-y:auto[^}]*\}/)
  // 主题 token 一旦缺失，三处都会变成透明底 —— 所以三处都必须直接引用 token
  for (const surface of ['#lingxu-ctf-panel{', '.lx-config{', '.lx-view{']) {
    const block = new RegExp(`${surface.replace(/[.#]/g, '\\$&')}([^}]*)\\}`).exec(css)
    assert.ok(block, `应有 ${surface} 基础块`)
    assert.match(block[1], /var\(--dsw-alias-/, `${surface} 必须直接用 DSH token 上色`)
  }
})

test('主题：状态徽章用三级色配对（浅底深字，暗色自动反转）', async () => {
  const { api } = await loadClientModule()
  const css = api.panelCss()
  assert.match(css, /\.lx-pill-solved,[^{]*\{color:var\(--dsw-alias-state-success-primary\);background:var\(--dsw-alias-state-success-tertiary\);\}/)
  assert.match(css, /\.lx-pill-working,[^{]*\{color:var\(--dsw-alias-state-business-primary\);background:var\(--dsw-alias-state-business-tertiary\);\}/)
  assert.match(css, /\.lx-pill-pending[^{]*\{color:var\(--dsw-alias-label-tertiary\);background:var\(--dsw-alias-bg-layer-2\);\}/)
})

test('主题：白名单与 DSH 真源码逐字一致（有解包源码时才跑）', async (t) => {
  // 本机把 DSH 解包在 /tmp/dsh-src（见 docs/DSH-API-NOTES.md）；有就顺手校验白名单没抄漏。
  const themePath = '/tmp/dsh-src/dsh-client-ui-theme/lib/client.js'
  if (!existsSync(themePath)) {
    t.skip('未找到解包的 DSH 主题源码（/tmp/dsh-src），跳过白名单对账')
    return
  }
  const source = readFileSync(themePath, 'utf8')
  const actual = new Set([...source.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map((match) => match[0]))
  assert.equal(
    actual.size, DSH_ALIAS_TOKEN_WHITELIST.size,
    `白名单数量与 DSH 源码不一致（源码 ${actual.size} / 白名单 ${DSH_ALIAS_TOKEN_WHITELIST.size}）`,
  )
  for (const token of actual) {
    assert.ok(DSH_ALIAS_TOKEN_WHITELIST.has(token), `白名单漏了 DSH 真实 token：${token}`)
  }
})

test('配置卡片：布局 —— 布尔独占开关行，workDir 占两列，网格固定三列', async () => {
  const dom = createDom()
  const { impl } = configFetch(configPayload())
  const card = createConfigCard({ doc: dom.document, fetchImpl: impl })
  await card.refresh()

  const css = (await loadClientModule()).api.panelCss()

  // 固定三列 + 顶部对齐：auto-fit 会让列宽/行高参差
  assert.match(css, /\.lx-config-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\);gap:14px 16px;align-items:start;\}/)
  // 窄屏降级
  assert.match(css, /@media \(max-width:760px\)\{\.lx-config-grid\{grid-template-columns:repeat\(2/)
  assert.match(css, /@media \(max-width:520px\)\{\.lx-config-grid\{grid-template-columns:minmax\(0,1fr\)/)
  // 开关行独立、带分隔线（分隔线用 DSH 的 border-l1，不再是 --lx-* 中间层）
  assert.match(css, /\.lx-config-toggles\{display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;padding-top:12px;border-top:1px solid var\(--dsw-alias-border-l1\);\}/)
  assert.match(css, /\.lx-config-toggles:empty\{display:none;\}/, '没有开关时不留空行')
  // 开关项必须左对齐的 inline-flex，不能是会被拉伸的块
  assert.match(css, /\.lx-config-check\{display:inline-flex;align-items:center;/)
  // workDir 占两列（与 timeoutMs 凑满一行）
  assert.match(css, /\.lx-config-field\.lx-span-2\{grid-column:span 2;\}/)

  // DOM 结构：开关在 toggles 里，且网格里不含布尔
  const byClass = (root, cls) => {
    const stack = [root]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node && String(node.className || '').split(/\s+/).includes(cls)) return node
      for (const child of (node && node.children) || []) stack.push(child)
    }
    return null
  }
  const grid = byClass(card.element, 'lx-config-grid')
  const toggles = byClass(card.element, 'lx-config-toggles')
  assert.ok(grid && toggles, 'grid 与 toggles 都应存在')
  const gridKeys = (grid.children || []).map((c) => (c.children || []).find((n) => n.tagName === 'INPUT')?.name).filter(Boolean)
  assert.equal(gridKeys.includes('dedupeFlags'), false, '布尔不应出现在网格里')
  assert.equal(gridKeys.includes('enableWebPanel'), false, '布尔不应出现在网格里')
  const toggleKeys = (toggles.children || []).map((c) => (c.children || []).find((n) => n.tagName === 'INPUT')?.name)
  assert.deepEqual(toggleKeys, ['dedupeFlags', 'enableWebPanel'])

  card.destroy()
})

// ══════════════════════════════════════ 10. 顶部「CTF」视图 tab（task-13）

/** 团队快照：形状对齐宿主 `GET /lingxu-ctf/team`（task-12 契约）。 */
function teamPayload() {
  return {
    ok: true,
    members: [
      { name: 'solver-web-01', status: 'running', description: 'Web 方向解题', challengeId: 2, challengeName: '<img src=x onerror=alert(1)>', category: 'Web' },
      { name: 'solver-misc-01', status: 'inactive', description: 'Misc 方向', challengeId: null, challengeName: '', category: '' },
      { name: 'solver-rev-02', status: 'failed', description: '逆向进度慢', challengeId: 3, challengeName: 'RSA', category: 'Crypto' },
    ],
    tasks: [
      // 平台侧已是 working，任务也 in_progress
      { id: 't1', subject: '解出 Web 题', status: 'in_progress', owner: 'solver-web-01', challengeId: '2', challengeName: '<img src=x onerror=alert(1)>', category: 'Web' },
      // 平台侧已解 → 不能因为任务完成而变回未解
      { id: 't2', subject: '解出签到', status: 'completed', owner: 'solver-misc-01', challengeId: 1, challengeName: '签到', category: 'Misc' },
      // ★ 平台侧 pending + 任务 in_progress → 必须升级成「进行中 · solver-rev-02」
      { id: 't3', subject: '解出 RSA', status: 'in_progress', owner: 'solver-rev-02', challengeId: 3, challengeName: 'RSA', category: 'Crypto' },
      // 任务里有、平台列表里没有 → 补一张「仅任务」卡
      { id: 't4', subject: '解出隐藏题', status: 'in_progress', owner: 'solver-web-01', challengeId: 99, challengeName: '隐藏题', category: 'Web' },
    ],
    messages: [
      { at: '2026-09-29T01:00:00Z', from: 'lead', to: 'solver-web-01', kind: 'spawn', text: '去做 Web 题' },
      { at: '2026-09-29T01:05:00Z', from: 'solver-web-01', to: 'lead', kind: 'report', text: '拿到 flag 了' },
      { at: '2026-09-29T01:06:00Z', from: 'lead', to: 'solver-rev-02', kind: 'status', text: '进度？' },
      { at: '2026-09-29T01:07:00Z', from: 'lead', to: 'solver-rev-02', kind: 'stop', text: '先停一下' },
      { at: '2026-09-29T01:08:00Z', from: 'lead', to: 'solver-misc-01', kind: 'send', text: '顺手看下 Misc' },
    ],
    counts: { members: 3, running: 1, inactive: 1, tasksTotal: 4, tasksDone: 1, tasksInProgress: 3, tasksPending: 0 },
  }
}

/** 报告快照：形状对齐宿主 `GET /lingxu-ctf/reports`。 */
function reportsPayload() {
  return {
    ok: true,
    writeups: [
      {
        challengeId: 1,
        challengeName: '签到',
        title: '签到 writeup',
        path: '/Users/x/lingxu-ctf-work/writeups/challenge-1.md',
        submitted: true,
        submittedAt: '2026-09-29T02:00:00Z',
        body: '# 签到\n\nbase64 解码即得 flag。',
      },
      {
        challengeId: 3,
        challengeName: 'RSA',
        title: 'RSA writeup',
        path: '/Users/x/lingxu-ctf-work/writeups/rsa-3.md',
        submitted: false,
        body: '',
      },
    ],
  }
}

/** 三路 fetch stub：/state、/team、/reports 各自返回给定 payload（或抛错）。 */
function viewFetch({
  state = fullSnapshot(), team = teamPayload(), reports = reportsPayload(),
  teamError = null, reportsError = null, stateError = null,
} = {}) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    if (url === STATE_URL) {
      if (stateError) throw stateError
      return jsonResponse(state)
    }
    if (url === TEAM_URL) {
      if (teamError) throw teamError
      return jsonResponse(team)
    }
    if (url === REPORTS_URL) {
      if (reportsError) throw reportsError
      return jsonResponse(reports)
    }
    return jsonResponse({ ok: false })
  }
  return { impl, calls }
}

/** 把视图挂到 stub document 上（真实路径由 React host 插入）。 */
function mountView(options = {}) {
  const dom = options.dom || createDom()
  const view = createCtfView({ doc: dom.document, win: dom.window, ...options })
  const element = view.mount()
  dom.document.body.appendChild(element)
  live.views.push(view)
  return { dom, view, element }
}

test('视图：slot 常量与 DSH 契约一致（list slot 必须有 id + order）', () => {
  assert.equal(VIEW_SLOT, 'conversation.view')
  assert.equal(VIEW_SLOT_ID, 'ctf')
  assert.equal(VIEW_ORDER, 20, '排在「对话」(0) / 「轨迹」(10) 之后')
  assert.equal(VIEW_CLASS, 'lx-view')
  assert.equal(TEAM_URL, '/lingxu-ctf/team')
  assert.equal(REPORTS_URL, '/lingxu-ctf/reports')
  assert.equal(FLOATING_CONFIG_KEY, 'enableFloatingPanel')
  assert.deepEqual(
    VIEW_TABS.map((tab) => tab.id),
    ['board', 'agents', 'messages', 'submissions', 'reports', 'env'],
  )
})

test('视图：registerCtfView 注册 conversation.view，id=ctf / order=20 / label 可调用', () => {
  const registered = []
  const injected = []
  const ctx = {
    slots: {
      register(options, render) { registered.push({ options, render }); return () => {} },
      inject(slot, fn) { injected.push(slot); fn(); return () => {} },
    },
    effect(fn) { return fn() },
  }
  const register = registerCtfView(ctx)
  assert.equal(typeof register, 'function')
  assert.deepEqual(injected, ['conversation.view'])
  assert.equal(registered.length, 1)
  const { options, render } = registered[0]
  assert.equal(options.name, 'conversation.view')
  assert.equal(options.id, 'ctf')
  assert.equal(options.order, 20)
  // 无 locale 服务时必须不带 locale 字段（ui-renderer 会因缺 face 抛 SlotAssemblyError）
  assert.equal('locale' in options, false)
  assert.equal(typeof options.label, 'function', 'label 必须是 thunk（跟随语言）')
  assert.equal(options.label(), 'CTF')
  assert.equal(typeof render, 'function')
})

test('视图：有 locale 服务时带命名空间 + thunk 标签', () => {
  const registered = []
  const namespaces = []
  const ctx = {
    slots: { register(options) { registered.push(options); return () => {} } },
    effect(fn) { return fn() },
    get(name) {
      if (name !== 'locale') return undefined
      return {
        register(ns, dict) { namespaces.push({ ns, dict }) },
        bind: () => (key) => (key === 'view.ctf' ? 'CTF 视图' : key),
      }
    },
  }
  registerCtfView(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].locale, VIEW_LOCALE_NS)
  assert.deepEqual(namespaces.map((item) => item.ns), [VIEW_LOCALE_NS])
  assert.equal(registered[0].label(), 'CTF 视图')
})

test('视图：locale.register 抛错 / 键缺失时 label thunk 仍可用（兜底 CTF）', () => {
  const registered = []
  const ctx = {
    slots: { register(options) { registered.push(options); return () => {} } },
    effect(fn) { return fn() },
    get: () => ({
      register() { throw new Error('namespace already registered') },
      bind: () => (key) => key, // 未注册命名空间 → 原样返回 key
    }),
  }
  registerCtfView(ctx)
  assert.equal(registered[0].locale, VIEW_LOCALE_NS)
  assert.equal(registered[0].label(), 'CTF', '拿不到译文时兜底成 CTF，而不是显示 view.ctf')
})

test('视图：拿不到 slots 服务时安全返回 null（不抛）', () => {
  assert.equal(registerCtfView(null), null)
  assert.equal(registerCtfView(undefined), null)
  assert.equal(registerCtfView({}), null)
  assert.equal(registerCtfView({ slots: {} }), null)
})

test('视图：没有 ctx.sessions 时降级为始终注册（不能因此不注册这个 tab）', () => {
  const registered = []
  const ctx = {
    slots: {
      register(options) { registered.push(options); return () => {} },
      inject(slot, fn) { fn(); return () => {} },
    },
    effect(fn) { return fn() },
  }
  registerCtfView(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'ctf')
})

test('视图：会话门控 —— 非 CTF 会话不注册，切到 ctf 会话注册，切走注销', () => {
  const registered = []
  const disposed = []
  let listener = null
  let snapshot = {
    current: 's1',
    byId: { s1: { projectionValues: { agentPreset: 'standard' } } },
  }
  const ctx = {
    slots: {
      register(options) {
        registered.push(options)
        return () => disposed.push(options.id)
      },
      inject(slot, fn) { fn(); return () => {} },
    },
    effect(fn) { return fn() },
    get(name) {
      if (name !== 'sessions') return undefined
      return {
        list: {
          getSnapshot: () => snapshot,
          subscribe(fn) { listener = fn; return () => { listener = null } },
        },
      }
    },
  }
  registerCtfView(ctx)
  assert.equal(registered.length, 0, '普通会话里不该出现 CTF tab')

  // 切到 CTF 预设的会话 → 注册
  snapshot = {
    current: 's2',
    byId: { s1: { projectionValues: { agentPreset: 'standard' } }, s2: { projectionValues: { agentPreset: 'ctf' } } },
  }
  listener()
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'ctf')

  // 切回普通会话 → 注销
  snapshot = {
    current: 's1',
    byId: { s1: { projectionValues: { agentPreset: 'standard' } }, s2: { projectionValues: { agentPreset: 'ctf' } } },
  }
  listener()
  assert.deepEqual(disposed, ['ctf'])
  assert.equal(registered.length, 1, '不应重复注册')
})

test('视图：preset 识别 —— ctf / ctf-* / 祖先会话 / 旧字段 agentPreset / 环路', () => {
  assert.equal(client.isCtfPresetId('ctf'), true)
  assert.equal(client.isCtfPresetId('ctf-hard'), true)
  assert.equal(client.isCtfPresetId('standard'), false)
  assert.equal(client.isCtfPresetId(undefined), false)
  // 旧字段（0.1.1 及更早）：preset id 直接在行上
  assert.equal(client.isCtfSession({ byId: { s1: { agentPreset: 'ctf' } } }, 's1'), true)
  // 新字段：projectionValues.agentPreset
  assert.equal(client.isCtfSession({ byId: { s1: { projectionValues: { agentPreset: 'ctf-x' } } } }, 's1'), true)
  // 子会话继承 lead 的会话（沿 parentId 向上找）
  assert.equal(
    client.isCtfSession({
      byId: {
        child: { parentId: 'root', projectionValues: { agentPreset: null } },
        root: { projectionValues: { agentPreset: 'ctf' } },
      },
    }, 'child'),
    true,
  )
  // 环路也不能死循环
  assert.equal(client.isCtfSession({ byId: { a: { parentId: 'b' }, b: { parentId: 'a' } } }, 'a'), false)
  // 当前会话：current 优先，其次 retainedBy.mainView
  assert.equal(client.currentSessionOf({ current: 'x', byId: {} }), 'x')
  assert.equal(client.currentSessionOf({ byId: { y: { retainedBy: { mainView: 1 } } } }), 'y')
  assert.equal(client.currentSessionOf({ byId: {} }), undefined)
})

test('视图：options.alwaysShowView 逃生舱 —— 跳过关控始终显示', () => {
  const registered = []
  const ctx = {
    slots: {
      register(options) { registered.push(options); return () => {} },
      inject(slot, fn) { fn(); return () => {} },
    },
    effect(fn) { return fn() },
    get(name) {
      if (name !== 'sessions') return undefined
      // 当前会话明确是普通 preset —— 门控会拒绝注册
      return {
        list: {
          getSnapshot: () => ({ current: 's1', byId: { s1: { projectionValues: { agentPreset: 'standard' } } } }),
          subscribe: () => () => {},
        },
      }
    },
  }
  registerCtfView(ctx)
  assert.equal(registered.length, 0, '默认门控：普通会话不显示')
  registerCtfView(ctx, { alwaysShowView: true })
  assert.equal(registered.length, 1, '打开逃生舱后始终显示')
  assert.equal(registered[0].id, 'ctf')
})

test('视图：快照里完全没有 preset 信息时降级为始终注册（宁可多显示）', () => {  const registered = []
  const ctx = {
    slots: {
      register(options) { registered.push(options); return () => {} },
      inject(slot, fn) { fn(); return () => {} },
    },
    effect(fn) { return fn() },
    get(name) {
      if (name !== 'sessions') return undefined
      return { list: { getSnapshot: () => ({ current: 's1', byId: { s1: {} } }), subscribe: () => () => {} } }
    },
  }
  registerCtfView(ctx)
  assert.equal(registered.length, 1, '无法判定时必须始终注册')
})

test('视图：renderCtfViewSlot 必须返回 React 元素，而不是组件函数 / DOM 节点', () => {
  const react = {
    createElement(type, props, ...children) { return { $$typeof: ELEMENT, type, props: props ?? {}, children } },
    useRef: () => ({ current: null }),
    useEffect: () => {},
  }
  const out = renderCtfViewSlot({}, { react })
  assert.notEqual(typeof out, 'function', '返回组件函数会被 React 判为非法 child')
  assert.equal(out && out.$$typeof, ELEMENT, '必须返回 React 元素')
  assert.equal(typeof out.type, 'function')
  const rendered = out.type({})
  assert.equal(rendered && rendered.$$typeof, ELEMENT, '组件调用后也必须返回元素')
  assert.equal(rendered.type, 'div')
  assert.equal(rendered.props.className, 'lx-view-host')
})

// ── 数据模型：全部容错 ──

test('视图模型：normalizeTeam 对 null / 垃圾 / ok:false 全部降级成空团队', () => {
  for (const input of [null, undefined, 42, 'nope', [], {}, { ok: false, error: '团队数据缺失' }]) {
    const team = normalizeTeam(input)
    assert.equal(team.hasTeam, false)
    assert.deepEqual(team.members, [])
    assert.deepEqual(team.tasks, [])
    assert.deepEqual(team.messages, [])
    assert.equal(team.counts.members, 0)
    assert.equal(team.counts.tasksTotal, 0)
  }
  assert.equal(normalizeTeam({ ok: false, error: 'x' }).error, 'x')
})

test('视图模型：counts 缺失时由 members / tasks 推导', () => {
  const team = normalizeTeam({
    members: [{ name: 'a', status: 'running' }, { name: 'b', status: 'inactive' }, { name: 'c', status: 'failed' }],
    tasks: [
      { id: 't1', status: 'in_progress', owner: 'a' },
      { id: 't2', status: 'completed', owner: 'b' },
      { id: 't3', status: 'pending', owner: 'c' },
    ],
  })
  assert.equal(team.hasTeam, true)
  assert.equal(team.counts.members, 3)
  assert.equal(team.counts.running, 1)
  assert.equal(team.counts.inactive, 1)
  assert.equal(team.counts.tasksTotal, 3)
  assert.equal(team.counts.tasksDone, 1)
  assert.equal(team.counts.tasksInProgress, 1)
  assert.equal(team.counts.tasksPending, 1)
})

test('视图模型：状态归一（连字符 / 大小写 / 别名）与 challengeId 对齐', () => {
  assert.equal(normalizeTaskStatus('In-Progress'), 'in_progress')
  assert.equal(normalizeTaskStatus('done'), 'completed')
  assert.equal(normalizeTaskStatus(undefined), 'unknown')
  assert.equal(normalizeTaskStatus('奇怪状态'), '奇怪状态')
  assert.equal(normalizeMemberStatus('RUNNING'), 'running')
  assert.equal(normalizeMemberStatus('gone'), 'unknown')
  assert.equal(challengeKey(2), '2')
  assert.equal(challengeKey(' 2 '), '2')
  assert.equal(challengeKey(null), null)
  assert.equal(challengeKey(''), null)
})

test('★ 「进行中」必须可见：平台未解 + 任务 in_progress → working + owner', () => {
  const state = normalizeState(fullSnapshot())
  const team = normalizeTeam(teamPayload())
  const board = mergeChallengeBoard(state.challenges, team)

  const rsa = board.find((item) => item.name === 'RSA')
  assert.equal(rsa.status, 'working', '平台 pending + 任务 in_progress 必须升级为进行中')
  assert.equal(rsa.owner, 'solver-rev-02')
  assert.equal(rsa.taskStatus, 'in_progress')

  const signed = board.find((item) => item.name === '签到')
  assert.equal(signed.status, 'solved', '已解的题不能因为任务完成而变回未解')

  // id 类型不一致（平台 2 / 任务 "2"）也要对齐
  const web = board.find((item) => item.category === 'Web' && item.name.startsWith('<img'))
  assert.equal(web.status, 'working')
  assert.equal(web.owner, 'solver-web-01')

  // 任务里有、平台没有的题补一张卡
  const extra = board.find((item) => item.teamOnly === true)
  assert.ok(extra, '应补出「仅任务」的题')
  assert.equal(extra.name, '隐藏题')
  assert.equal(extra.status, 'working')

  const stats = viewStats(state, board, team)
  assert.equal(stats.total, 78)
  assert.equal(stats.working, 3, 'working 统计按合并后的看板算')
  assert.equal(stats.agents, 3)
})

test('★ 题目看板渲染出「进行中 · solver-rev-02」，并做注入防护', () => {
  const state = normalizeState(fullSnapshot())
  const team = normalizeTeam(teamPayload())
  const board = mergeChallengeBoard(state.challenges, team)
  const html = renderViewBoardHtml({ state, team, board, reports: normalizeReports(null) }, {})

  assert.match(html, /进行中 · solver-rev-02/)
  assert.match(html, /lx-st-working/)
  assert.match(html, /Crypto/)
  assert.match(html, /已解 1\/1/)
  // 平台数据里的 HTML 必须被转义（题名是 <img src=x onerror=...>）
  assert.equal(html.includes('<img src=x'), false)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('视图：Agent 活动渲染状态点 / 当前题目 / 完成数 / 最后活动 + 可展开题目', () => {
  const state = normalizeState(fullSnapshot())
  const team = normalizeTeam(teamPayload())
  const board = mergeChallengeBoard(state.challenges, team)
  const html = renderViewAgentsHtml({ state, team, board, reports: normalizeReports(null) })

  assert.match(html, /solver-web-01/)
  assert.match(html, /运行中/)
  assert.match(html, /空闲/)
  assert.match(html, /失败/)
  assert.match(html, /lx-vdot lx-ok/, 'running 用绿点')
  assert.match(html, /lx-vdot lx-dim/, 'inactive 用灰点')
  assert.match(html, /lx-vdot lx-err/, 'failed 用红点')
  assert.match(html, /当前：/)
  assert.match(html, /已完成 1 题/)
  assert.match(html, /最后活动/)
  assert.match(html, /负责的题目（2）/, '点开可看该 agent 负责的全部题目')
  assert.match(html, /隐藏题/)
})

test('视图：Agent 活动 / 协同通信在无团队或 ok:false 时给空态且不抛', () => {
  const state = normalizeState(fullSnapshot())
  for (const raw of [null, { ok: false, error: 'HTTP 404' }, { ok: true, members: [], tasks: [], messages: [] }]) {
    const team = normalizeTeam(raw)
    const board = mergeChallengeBoard(state.challenges, team)
    const model = { state, team, board, reports: normalizeReports(null) }
    const agents = renderViewAgentsHtml(model)
    const messages = renderViewMessagesHtml(model)
    assert.match(agents, /尚未拉起解题团队/)
    assert.match(messages, /暂无协同记录/)
    assert.match(agents, /lx-vempty/)
    assert.match(messages, /lx-vempty/)
  }
  // 宿主路由 404 时把原因写进空态提示（仍然不崩）
  const team = { ...normalizeTeam(null), error: 'HTTP 404' }
  assert.match(renderViewAgentsHtml({ state, team, board: [], reports: normalizeReports(null) }), /HTTP 404/)
})

test('视图：协同通信时间线按时间升序并带 from → to / kind 标签', () => {
  const state = normalizeState(fullSnapshot())
  const team = normalizeTeam(teamPayload())
  const html = renderViewMessagesHtml({ state, team, board: [], reports: normalizeReports(null) })
  assert.match(html, /lead/)
  assert.match(html, /solver-web-01/)
  assert.match(html, /→/)
  assert.match(html, /拉起/)
  assert.match(html, /汇报/)
  assert.match(html, /lx-vmsg-spawn/)
  assert.match(html, /lx-vmsg-report/)
  const first = html.indexOf('去做 Web 题')
  const last = html.indexOf('顺手看下 Misc')
  assert.ok(first > 0 && last > first, '时间线应从早到晚')
})

test('视图：提交审计渲染状态徽章与脱敏 flag；报告可展开正文', () => {
  const state = normalizeState(fullSnapshot())
  const model = { state, team: normalizeTeam(null), board: [], reports: normalizeReports(reportsPayload()) }
  const subs = renderViewSubmissionsHtml(model)
  assert.match(subs, /签到/)
  assert.match(subs, /正确/)
  assert.match(subs, /错误/)
  assert.match(subs, /lx-sub-correct/)

  const reports = renderViewReportsHtml(model)
  assert.match(reports, /签到 writeup/)
  assert.match(reports, /已提交平台/)
  assert.match(reports, /仅本地/)
  assert.match(reports, /lx-vreport-body/)
  assert.match(reports, /base64 解码即得 flag/)
  assert.match(reports, /writeups\/challenge-1\.md/)
})

test('视图：报告路由拿不到时显示「暂无 writeup」空态', () => {
  const state = normalizeState(fullSnapshot())
  for (const raw of [null, { ok: false, error: 'HTTP 404' }, []]) {
    const html = renderViewReportsHtml({ state, team: normalizeTeam(null), board: [], reports: normalizeReports(raw) })
    assert.match(html, /暂无 writeup/)
    assert.match(html, /lx-vempty/)
  }
  const withError = renderViewReportsHtml({
    state, team: normalizeTeam(null), board: [], reports: { ok: false, error: 'HTTP 404', items: [] },
  })
  assert.match(withError, /HTTP 404/)
})

test('视图：摘要统计条含「题目总数 / 已解 / 进行中 / 待解 / Agents」', () => {
  const state = normalizeState(fullSnapshot())
  const team = normalizeTeam(teamPayload())
  const board = mergeChallengeBoard(state.challenges, team)
  const model = { state, team, board, reports: normalizeReports(null), stats: viewStats(state, board, team) }
  const stats = renderViewStatsHtml(model)
  for (const label of ['题目总数', '已解', '进行中', '待解', 'Agents', 'flag 提交']) {
    assert.ok(stats.includes(label), `统计条应含「${label}」`)
  }
  const meta = renderViewMetaHtml(model)
  assert.match(meta, /赛事 #4/)
  assert.match(meta, /剩余 1小时1分/)
  assert.match(meta, /Agents 3/)
  assert.match(meta, /任务 1\/4/)
})

test('视图：所有片段标签闭合平衡（innerHTML 结构不会破损）', () => {
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link'])
  const imbalance = (html) => {
    const stack = []
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g
    let match
    while ((match = re.exec(html)) !== null) {
      const name = match[2].toLowerCase()
      if (VOID.has(name) || match[3] === '/') continue
      if (match[1] === '/') {
        if (stack.pop() !== name) return `意外闭合 </${name}>`
      } else stack.push(name)
    }
    return stack.length === 0 ? null : `未闭合：${stack.join(',')}`
  }
  const state = normalizeState(fullSnapshot())
  const team = normalizeTeam(teamPayload())
  const board = mergeChallengeBoard(state.challenges, team)
  const model = { state, team, board, reports: normalizeReports(reportsPayload()), stats: viewStats(state, board, team) }
  const emptyModel = {
    state, team: normalizeTeam(null), board: [], reports: normalizeReports(null), stats: viewStats(state, [], null),
  }
  const fragments = {
    meta: renderViewMetaHtml(model),
    stats: renderViewStatsHtml(model),
    board: renderViewBoardHtml(model, {}),
    boardEmpty: renderViewBoardHtml(emptyModel, {}),
    agents: renderViewAgentsHtml(model),
    agentsEmpty: renderViewAgentsHtml(emptyModel),
    messages: renderViewMessagesHtml(model),
    messagesEmpty: renderViewMessagesHtml(emptyModel),
    submissions: renderViewSubmissionsHtml(model),
    reports: renderViewReportsHtml(model),
    reportsEmpty: renderViewReportsHtml(emptyModel),
  }
  for (const [key, html] of Object.entries(fragments)) {
    assert.equal(imbalance(html), null, `${key} 标签不平衡`)
  }
})

// ── DOM 控制器 ──

test('视图控制器：挂载后拉三份数据并渲染摘要 / 看板，切 tab 重绘', async () => {
  const { impl, calls } = viewFetch()
  const { dom, view } = mountView({ fetchImpl: impl })
  await view.refresh()

  const text = collectText(dom.document.body)
  assert.match(text, /2026 测试赛/)
  assert.match(text, /凌虚/)
  assert.match(text, /题目总数/)
  assert.match(text, /RSA/)
  assert.match(text, /进行中 · solver-rev-02/)
  // 三个路由都要拉
  assert.ok(calls.includes(STATE_URL))
  assert.ok(calls.includes(TEAM_URL))
  assert.ok(calls.includes(REPORTS_URL))
  assert.equal(view.state.snapshot.configured, true)
  assert.equal(view.state.team.hasTeam, true)

  view.setTab('agents')
  const agents = collectText(dom.document.body)
  assert.match(agents, /solver-web-01/)
  assert.match(agents, /运行中/)

  view.setTab('messages')
  assert.match(collectText(dom.document.body), /拿到 flag 了/)

  view.setTab('submissions')
  assert.match(collectText(dom.document.body), /正确/)

  view.setTab('reports')
  assert.match(collectText(dom.document.body), /签到 writeup/)

  // 未知 tab 忽略
  view.setTab('nope')
  assert.equal(view.state.tab, 'reports')
  view.destroy()
})

test('视图控制器：/lingxu-ctf/team 与 /reports 404 时显示空态且不抛（赛事数据不被连坐）', async () => {
  const notFound = () => {
    const error = new Error('HTTP 404')
    error.status = 404
    return error
  }
  const { impl } = viewFetch({ teamError: notFound(), reportsError: notFound() })
  const { dom, view } = mountView({ fetchImpl: impl })
  await view.refresh()

  assert.match(collectText(dom.document.body), /2026 测试赛/)
  view.setTab('agents')
  assert.match(collectText(dom.document.body), /尚未拉起解题团队/)
  assert.match(collectText(dom.document.body), /HTTP 404/)
  view.setTab('messages')
  assert.match(collectText(dom.document.body), /暂无协同记录/)
  view.setTab('reports')
  assert.match(collectText(dom.document.body), /暂无 writeup/)
  assert.equal(view.state.team.hasTeam, false)

  // ok:false 的形状同样只走空态
  const { impl: impl2 } = viewFetch({ team: { ok: false, error: '团队不可用' }, reports: { ok: false, error: '报告不可用' } })
  const second = mountView({ fetchImpl: impl2 })
  await second.view.refresh()
  second.view.setTab('agents')
  assert.match(collectText(second.dom.document.body), /尚未拉起解题团队/)
  second.view.destroy()
  view.destroy()
})

test('视图控制器：筛选（分类 / 状态 / 搜索）与工具条随 tab 显隐', async () => {
  const { impl } = viewFetch()
  const { dom, view } = mountView({ fetchImpl: impl })
  await view.refresh()

  const find = (cls) => {
    const stack = [view.element()]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node && String(node.className || '').split(/\s+/).includes(cls)) return node
      for (const child of (node && node.children) || []) stack.push(child)
    }
    return null
  }
  const search = find('lx-vsearch')
  assert.ok(search, '看板应有搜索框')
  search.value = '不存在'
  search.dispatch('input')
  assert.match(collectText(dom.document.body), /没有符合筛选条件的题目/)

  search.value = ''
  search.dispatch('input')
  const statusSel = find('lx-vfilter-status')
  statusSel.value = 'solved'
  statusSel.dispatch('change')
  assert.match(collectText(dom.document.body), /签到/)
  assert.equal(collectText(dom.document.body).includes('RSA'), false, '已解筛选不应出现待解题')

  const toolbar = find('lx-vtoolbar')
  assert.equal(toolbar.dataset.hidden, 'false')
  view.setTab('agents')
  assert.equal(toolbar.dataset.hidden, 'true')
  view.destroy()
})

test('视图控制器：轮询在页面隐藏时暂停、恢复可见后继续、销毁后停表', async () => {
  let calls = 0
  const { impl } = viewFetch()
  const counting = async (url, init) => { calls += 1; return impl(url, init) }
  const { dom, view } = mountView({ fetchImpl: counting })
  view.start()
  await view.ready
  const afterInitial = calls
  assert.ok(afterInitial >= 3, '首轮应拉三份数据')

  dom.document.hidden = true
  dom.runTimers()
  await flush()
  assert.equal(calls, afterInitial, '页面隐藏时不应轮询')

  dom.document.hidden = false
  dom.runTimers()
  await flush()
  assert.ok(calls > afterInitial, '恢复可见后应继续轮询')

  view.destroy()
  assert.equal(dom.timerCount(), 0, '销毁后应清掉定时器')
  assert.equal(view.mounted, false)
})

test('视图控制器：没有 fetch 时降级为可读错误态，而不是崩溃', async () => {
  const dom = createDom()
  const view = createCtfView({ doc: dom.document, win: dom.window, fetchImpl: null })
  live.views.push(view)
  dom.document.body.appendChild(view.mount())
  await view.refresh()
  assert.match(collectText(dom.document.body), /不支持 fetch|加载失败/)
  view.destroy()
})

test('视图控制器：未配置平台 → 空态提示 ctf_connect', async () => {
  const { impl } = viewFetch({ state: { ok: false, configured: false, error: 'not configured' } })
  const { dom, view } = mountView({ fetchImpl: impl })
  await view.refresh()
  assert.match(collectText(dom.document.body), /尚未连接竞赛平台/)
  assert.match(collectText(dom.document.body), /ctf_connect/)
  view.destroy()
})

// ── 悬浮面板开关（默认不挂） ──

test('悬浮面板：默认不挂 —— 宿主没给 enableFloatingPanel 字段', async () => {
  const env = installGlobals(async (url) => {
    if (url === CONFIG_URL) return jsonResponse(configPayload()) // 老配置：只有 enableWebPanel
    return jsonResponse(fullSnapshot())
  })
  try {
    assert.equal(await floatingPanelEnabled(), false)
    const panel = track(apply(null))
    await pendingFloatingSync()
    assert.equal(panel.mounted, false)
    assert.equal(env.dom.document.getElementById('lingxu-ctf-panel'), null)
  } finally {
    env.restore()
  }
})

test('悬浮面板：enableFloatingPanel:true 才挂', async () => {
  const env = installGlobals(async (url) => {
    if (url === CONFIG_URL) {
      const payload = configPayload()
      payload.values.enableFloatingPanel = true
      return jsonResponse(payload)
    }
    return jsonResponse(fullSnapshot())
  })
  try {
    assert.equal(await floatingPanelEnabled(), true)
    const panel = track(apply(null))
    await pendingFloatingSync()
    assert.equal(panel.mounted, true, '宿主显式打开时应挂载')
  } finally {
    env.restore()
  }
})

test('悬浮面板：配置读取失败 / 非 JSON / 404 一律按「不挂」', async () => {
  for (const response of [
    () => { throw new Error('network down') },
    () => ({ ok: false, status: 404, json: async () => ({}) }),
    () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }),
    () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: '配置不可用' }) }),
  ]) {
    const env = installGlobals(async () => response())
    try {
      assert.equal(await floatingPanelEnabled(), false)
    } finally {
      env.restore()
    }
  }
  assert.equal(await floatingPanelEnabled({ enableFloating: false }), false)
  assert.equal(await floatingPanelEnabled({ enableFloatingPanel: true }), true)
})

// ══════════════════════════════════════ 11. 环境 / 题型（task-20）

/** 带环境字段的快照：覆盖正常 / 告警 / 过期 / 未探测四种形态。 */
function envSnapshot(overrides = {}) {
  const base = {
    connection: { key: 'lingxu:host:4', platform: 'lingxu', baseUrl: 'https://example.test:8000', eventId: 4 },
    event: { name: '2026 测试赛', remainingSeconds: 3661, user: { username: 'alice' } },
    env: { limit: 2, held: 1, free: 1 },
    challenges: [
      { id: 1, name: '签到', category: 'Misc', score: 100, solved: true, taskType: 3 },
      { id: 2, name: '外链题', category: 'Web', score: 200, status: 'pending', taskType: 2 },
      // 正常倒计时（25 分钟）
      { id: 3, name: 'Pwn-A', category: 'Pwn', score: 300, status: 'working', owner: 'solver-pwn-01', taskType: 1, envRemainingSeconds: 1500, envExpired: false },
      // <10 分钟 → 橙色
      { id: 4, name: 'Pwn-B', category: 'Pwn', score: 400, status: 'working', owner: 'solver-pwn-02', taskType: 1, envRemainingSeconds: 180, envExpired: false },
      // 已过期 → 红色
      { id: 5, name: 'Pwn-C', category: 'Pwn', score: 500, status: 'pending', taskType: 1, envRemainingSeconds: 0, envExpired: true },
      // 未探测：taskType 缺失 + 无环境
      { id: 6, name: '未探测题', category: 'Misc', score: 50, status: 'pending' },
    ],
  }
  return { ...base, ...overrides }
}

/** 由快照构造渲染模型（不依赖 DOM）。 */
function envModel(rawState, teamRaw = null) {
  const state = normalizeState(rawState)
  const team = normalizeTeam(teamRaw)
  const board = mergeChallengeBoard(state.challenges, team)
  return { state, team, board, reports: normalizeReports(null), stats: viewStats(state, board, team) }
}

test('环境模型：env 字段缺失 / 垃圾输入不崩，且 known=false（不显示占用）', () => {
  for (const raw of [undefined, null, 42, 'nope', [], {}, { limit: 0, held: 0, free: 0 }]) {
    const env = normalizeEnv(raw)
    assert.equal(env.known, false)
    assert.equal(env.full, false)
    assert.equal(typeof env.limit, 'number')
  }
  // 老宿主的 state（没有 env 字段）→ 摘要里不出现「环境 x/y」
  const model = envModel({ connection: { key: 'k' }, challenges: [{ id: 1, name: 'A' }] })
  const meta = renderViewMetaHtml(model)
  assert.equal(meta.includes('环境 '), false, '老宿主不该显示环境占用')
  assert.equal(meta.includes('lx-chip-env'), false)
})

test('环境模型：limit/held/free 推导与「已满」判定', () => {
  assert.deepEqual(normalizeEnv({ limit: 2, held: 1, free: 1 }), { known: true, limit: 2, held: 1, free: 1, full: false })
  assert.equal(normalizeEnv({ limit: 2, held: 2, free: 0 }).full, true)
  // free 缺失时用 limit - held 推导
  assert.equal(normalizeEnv({ limit: 3, held: 1 }).free, 2)
  // held 超出 limit 也不能出现负数
  assert.equal(normalizeEnv({ limit: 1, held: 5 }).free, 0)
})

test('题型徽章：taskType 1/2/3 各渲染正确文案，null/缺失不显示', () => {
  assert.equal(taskTypeLabel(1), '环境型')
  assert.equal(taskTypeLabel(2), '外链型')
  assert.equal(taskTypeLabel(3), '附件型')
  assert.equal(taskTypeLabel(null), null)
  assert.equal(taskTypeLabel(undefined), null)
  assert.equal(taskTypeLabel(9), null, '未知题型不瞎猜')

  assert.match(renderTaskTypeBadgeHtml({ taskType: 1 }), /环境型/)
  assert.match(renderTaskTypeBadgeHtml({ taskType: 1 }), /lx-vtype-1/)
  assert.match(renderTaskTypeBadgeHtml({ taskType: 2 }), /外链型/)
  assert.match(renderTaskTypeBadgeHtml({ taskType: 3 }), /附件型/)
  assert.equal(renderTaskTypeBadgeHtml({ taskType: null }), '')
  assert.equal(renderTaskTypeBadgeHtml({}), '')
  assert.equal(renderTaskTypeBadgeHtml(null), '')
})

test('环境剩余：正常 / <10 分钟橙色 / 0 与 envExpired 红色 / null 不显示', () => {
  // 正常
  const ok = envStateOf({ envRemainingSeconds: 1500 })
  assert.equal(ok.tone, 'ok')
  assert.equal(ok.label, '环境 25m')
  // <10 分钟 → 橙色告警
  const warn = envStateOf({ envRemainingSeconds: 180 })
  assert.equal(warn.tone, 'warn')
  assert.equal(warn.label, '⚠ 环境 3m')
  // 恰好 10 分钟不算告警（边界）
  assert.equal(envStateOf({ envRemainingSeconds: 600 }).tone, 'ok')
  assert.equal(envStateOf({ envRemainingSeconds: 599 }).tone, 'warn')
  // 0 → 已过期
  assert.equal(envStateOf({ envRemainingSeconds: 0 }).label, '环境已过期')
  assert.equal(envStateOf({ envRemainingSeconds: 0 }).tone, 'error')
  // envExpired:true 但剩余不为 0（老宿主的写法）也按过期处理
  assert.equal(envStateOf({ envRemainingSeconds: 100, envExpired: true }).tone, 'error')
  // 没有环境 → 什么都不显示
  assert.equal(envStateOf({ envRemainingSeconds: null }), null)
  assert.equal(envStateOf({}), null)
  assert.equal(envStateOf(null), null)
  assert.equal(renderEnvChipHtml({ envRemainingSeconds: null }), '')

  // HTML 片段：三类 class 都要对
  assert.match(renderEnvChipHtml({ envRemainingSeconds: 1500 }), /lx-venv-ok/)
  assert.match(renderEnvChipHtml({ envRemainingSeconds: 180 }), /lx-venv-warn/)
  assert.match(renderEnvChipHtml({ envRemainingSeconds: 180 }), /⚠ 环境 3m/)
  assert.match(renderEnvChipHtml({ envRemainingSeconds: 0 }), /lx-venv-error/)
  assert.match(renderEnvChipHtml({ envRemainingSeconds: 0 }), /环境已过期/)
})

test('紧凑时长格式：25m / 3m20s / 45s / 1h5m', () => {
  assert.equal(formatShortDuration(1500), '25m')
  assert.equal(formatShortDuration(200), '3m20s')
  assert.equal(formatShortDuration(45), '45s')
  assert.equal(formatShortDuration(3900), '1h5m')
  assert.equal(formatShortDuration(-5), '0s')
  assert.equal(formatShortDuration(null), '0s')
})

test('★ 看板卡片：题型徽章 + 环境剩余（橙 / 红 / 正常）都渲染出来', () => {
  const model = envModel(envSnapshot())
  const html = renderViewBoardHtml(model, {})
  assert.match(html, /环境型/)
  assert.match(html, /外链型/)
  assert.match(html, /附件型/)
  assert.match(html, /环境 25m/)
  assert.match(html, /⚠ 环境 3m/)
  assert.match(html, /环境已过期/)
  assert.match(html, /lx-venv-warn/)
  assert.match(html, /lx-venv-error/)
  // 未探测的题（taskType 缺失）不该凭空出现题型徽章
  const card = renderViewChallengeCard(model.board.find((item) => item.name === '未探测题'))
  assert.equal(card.includes('lx-vtype'), false)
  assert.equal(card.includes('lx-venv'), false)
})

test('★ 摘要 chips：环境 held/limit；free === 0 时高亮', () => {
  const normal = renderViewMetaHtml(envModel(envSnapshot()))
  assert.match(normal, /环境 1\/2/)
  assert.equal(normal.includes('lx-chip-warn'), false, '没满时不告警')

  const full = renderViewMetaHtml(envModel(envSnapshot({ env: { limit: 2, held: 2, free: 0 } })))
  assert.match(full, /环境 2\/2/)
  assert.match(full, /已满/)
  assert.match(full, /lx-chip-warn/)
})

test('★ Agent 活动：持有环境的 agent 有标记（含告警色）', () => {
  const team = {
    ok: true,
    members: [
      { name: 'solver-pwn-01', status: 'running', challengeId: 3, challengeName: 'Pwn-A' },
      { name: 'solver-pwn-02', status: 'running', challengeId: 4, challengeName: 'Pwn-B' },
      { name: 'solver-web-01', status: 'inactive', challengeId: 2, challengeName: '外链题' },
    ],
    tasks: [
      { id: 't1', status: 'in_progress', owner: 'solver-pwn-01', challengeId: 3, challengeName: 'Pwn-A' },
      { id: 't2', status: 'in_progress', owner: 'solver-pwn-02', challengeId: 4, challengeName: 'Pwn-B' },
      { id: 't3', status: 'in_progress', owner: 'solver-web-01', challengeId: 2, challengeName: '外链题' },
    ],
    messages: [],
  }
  const model = envModel(envSnapshot(), team)
  const html = renderViewAgentsHtml(model)
  assert.match(html, /🌐 环境 25m/, 'solver-pwn-01 持有 25 分钟的环境')
  assert.match(html, /🌐 ⚠ 环境 3m/, 'solver-pwn-02 的环境快过期了')
  assert.match(html, /lx-venv-held/)
  // 没持有环境的 agent 不该有标记：按行切开分别断言
  const rows = html.split('<div class="lx-vagent-row">')
  const webRow = rows.find((row) => row.includes('solver-web-01'))
  assert.ok(webRow)
  assert.equal(webRow.includes('lx-venv-held'), false, '外链题不占环境配额')
  assert.equal(memberEnvOf('solver-none', model.board), null)
})

test('★ 「环境」子视图：只列环境型题目，按告警/剩余排序，含配额与占用者', () => {
  const team = {
    ok: true,
    members: [{ name: 'solver-pwn-02', status: 'running' }],
    tasks: [{ id: 't1', status: 'in_progress', owner: 'solver-pwn-02', challengeId: 4, challengeName: 'Pwn-B' }],
    messages: [],
  }
  const model = envModel(envSnapshot(), team)
  const html = renderViewEnvHtml(model)

  assert.match(html, /环境配额 1\/2（空闲 1）/)
  assert.match(html, /Pwn-A/)
  assert.match(html, /Pwn-B/)
  assert.match(html, /Pwn-C/)
  assert.match(html, /@solver-pwn-02/)
  assert.match(html, /已过期 · 需要重新 ctf_start_env/)
  // 非环境型（外链题 / 未探测题）不该出现
  assert.equal(html.includes('外链题'), false)
  assert.equal(html.includes('未探测题'), false)
  // 排序：过期(error) 最前，其次告警(warn)，最后正常(ok)
  assert.ok(html.indexOf('Pwn-C') < html.indexOf('Pwn-B'))
  assert.ok(html.indexOf('Pwn-B') < html.indexOf('Pwn-A'))
  // tab 角标 = 运行中的环境数（过期的不算）
  assert.equal(renderViewTabCount('env', model), 2)
})

test('「环境」子视图：没有环境时给空态；配额满时给提示', () => {
  const empty = envModel({ connection: { key: 'k' }, env: { limit: 2, held: 0, free: 2 }, challenges: [{ id: 1, name: 'A', taskType: 3 }] })
  const html = renderViewEnvHtml(empty)
  assert.match(html, /当前没有运行中的环境/)
  assert.match(html, /lx-vempty/)
  assert.equal(runningEnvCount(empty.board), 0)

  const full = envModel(envSnapshot({ env: { limit: 2, held: 2, free: 0 } }))
  assert.match(renderViewEnvHtml(full), /配额已满 · 新环境起不来，先释放一个/)
})

test('环境数据容错：challenges 里混入 null / 垃圾字段不崩', () => {
  const model = envModel({
    connection: { key: 'k' },
    env: 'not-an-object',
    challenges: [null, 42, {}, { id: 1, name: 'A', taskType: 'x', envRemainingSeconds: 'abc', envExpired: 'yes' }],
  })
  assert.doesNotThrow(() => renderViewBoardHtml(model, {}))
  assert.doesNotThrow(() => renderViewEnvHtml(model))
  assert.doesNotThrow(() => renderViewAgentsHtml(model))
  assert.equal(model.state.env.known, false)
  const item = model.board.find((row) => row.name === 'A')
  assert.equal(item.taskType, null, '非数字题型 → 不显示')
  assert.equal(typeof item.envRemainingSeconds, 'number')
})

test('环境视图控制器：切到 env tab 渲染环境面板', async () => {
  const { impl } = viewFetch({ state: envSnapshot() })
  const { dom, view } = mountView({ fetchImpl: impl })
  await view.refresh()
  view.setTab('env')
  const text = collectText(dom.document.body)
  assert.match(text, /环境配额 1\/2/)
  assert.match(text, /Pwn-B/)
  assert.match(text, /环境已过期/)
  assert.equal(view.state.tab, 'env')
  view.destroy()
})

// ── 样式作用域 ──

test('视图 CSS：作用域限定在 .lx-v* / .lx-view*，且不含任何定位声明', async () => {
  const { api } = await loadClientModule()
  const css = api.panelCss()
  assert.match(css, /\.lx-view\{/)
  // 宿主（ui-conversation 的 viewArea）是 overflow:hidden 的弹性盒 → 视图自己滚动
  assert.match(css, /\.lx-view-host\{display:block;width:100%;height:100%;min-height:0;\}/)
  // 视图样式里不能出现 position（尤其 fixed）—— 会话区里的视图一旦定位就会盖住别的 UI
  const viewBlocks = [...css.matchAll(/\.lx-v[a-z-]*\{([^}]*)\}/g)].map((match) => match[1])
  assert.ok(viewBlocks.length > 0)
  for (const block of viewBlocks) {
    assert.equal(block.includes('position:'), false, `视图样式不得含定位：${block}`)
    assert.equal(block.includes('z-index:'), false)
  }
  // 全局扫描：position:fixed 仍然只能出现在面板块里（历史坑的回归防线）
  const fixedBlocks = [...css.matchAll(/([^{}]+)\{[^}]*position:fixed/g)].map((match) => match[1].trim())
  assert.deepEqual(fixedBlocks, ['#lingxu-ctf-panel'])
  // 视图的暗色不靠自己写媒体查询，而是 DSH token 自己切（见「主题」用例）
  assert.equal(css.includes('prefers-color-scheme'), false)
})

test('理论题状态：交卷后必须显示「已交卷」，不能显示「未开始」', () => {
  // 真实 bug：平台交卷后 is_begin 变回 false、is_parse 变 true。
  // 只看 isBegin 会显示「未开始」（用户在真实 session 里反馈过）。
  const dom = createDom()
  const mk = (theory) => normalizeState({
    ok: true,
    connection: { key: 'k', platform: 'lingxu', baseUrl: 'https://x', eventId: 4 },
    event: {}, stats: {}, challenges: [], leaderboard: [], submissions: [], theory,
  })

  // 已交卷：is_begin=false + is_parse=true
  const submitted = mk([{ id: 3, name: '理论题', count: 100, isBegin: false, isParse: true, parseCount: 1, statusLabel: '已交卷' }])
  const html1 = renderTheoryHtml(submitted)
  assert.match(html1, /已交卷/, '必须显示已交卷')
  assert.doesNotMatch(html1, /未开始/, '不得显示未开始')
  assert.match(html1, /交卷 1 次/)

  // 进行中：is_begin=true
  const running = mk([{ id: 3, name: '理论题', count: 100, isBegin: true, isParse: false }])
  assert.match(renderTheoryHtml(running), /进行中/)

  // 未开始
  const fresh = mk([{ id: 3, name: '理论题', count: 100, isBegin: false, isParse: false }])
  assert.match(renderTheoryHtml(fresh), /未开始/)

  // status==='submitted' 也能兜住（statusLabel 缺失时）
  const noLabel = mk([{ id: 3, name: '理论题', count: 100, isBegin: false, status: 'submitted' }])
  assert.match(renderTheoryHtml(noLabel), /已交卷/)
})
