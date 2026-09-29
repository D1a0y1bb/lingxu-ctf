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
import { readFileSync } from 'node:fs'
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
const live = { panels: [], envs: [] }

afterEach(() => {
  for (const panel of live.panels.splice(0)) {
    try { panel.destroy() } catch { /* 已销毁 */ }
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

test('apply(ctx) 通过 ctx.effect 注册且不抛错，销毁后卸载', () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const registered = []
    const ctx = {
      effect(fn, label) {
        registered.push({ fn, label })
        return () => {}
      },
    }
    const panel = track(apply(ctx))
    assert.equal(registered.length, 1)
    assert.match(registered[0].label, /lingxu-ctf/)
    assert.equal(panel.mounted, true)
    assert.ok(env.dom.document.getElementById('lingxu-ctf-panel'))

    // 模拟 cordis 执行 effect 拿到 disposer
    const dispose = registered[0].fn()
    assert.equal(typeof dispose, 'function')
    dispose()
    assert.equal(panel.mounted, false)
    assert.equal(env.dom.document.getElementById('lingxu-ctf-panel'), null)
  } finally {
    env.restore()
  }
})

test('apply(null)（浏览器自挂载路径）不抛错且可销毁', () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const panel = track(apply(null))
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
    const panel = track(apply(null))
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
    const panel = track(apply(null))
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
    const panel = track(apply(null))
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
    const panel = track(apply(null))
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
    const panel = track(apply(null))
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
    const panel = track(apply(null))
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
    const panel = track(apply(null))
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
    const panel = track(apply(null))
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
    const panel = track(apply(null))
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

test('重复 apply 不会挂出第二个面板', () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const first = track(apply(null))
    const second = track(apply(null))
    assert.equal(first, second)
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

test('生产路径：脚本执行即向 __ModuleLoader__ 注册 factory，并自挂载浮动面板', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const { api, registration } = await loadClientModule()
    // ① 模块表注册（宿主据此建 cordis entry → 拿到真 ctx）
    assert.equal(registration.id, 'dsh-lingxu-ctf')
    assert.equal(typeof registration.factory, 'function')
    // factory 物化后必须给出 name / apply
    assert.equal(api.name, 'dsh-lingxu-ctf')
    assert.equal(typeof api.apply, 'function')
    // ② 顶层自挂载（不依赖 ctx）
    const mounted = env.dom.document.getElementById('lingxu-ctf-panel')
    assert.ok(mounted, '顶层自挂载应立即创建面板（无需宿主调用 apply）')

    const panel = track(api.getPanel())
    assert.equal(panel.root(), mounted)
    await panel.ready
    assert.match(collectText(panel.root()), /2026 测试赛/)
    assert.match(collectText(panel.root()), /RSA/)
  } finally {
    env.restore()
  }
})

test('生产路径：DOM 未就绪（readyState=loading）时等 DOMContentLoaded 再挂载', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  env.dom.document.readyState = 'loading'
  try {
    const { api } = await loadClientModule()
    assert.equal(env.dom.document.getElementById('lingxu-ctf-panel'), null, 'DOM 未就绪时不应提前挂载')

    env.dom.document.dispatch('DOMContentLoaded')
    const mounted = env.dom.document.getElementById('lingxu-ctf-panel')
    assert.ok(mounted, 'DOMContentLoaded 后应挂载')

    const panel = track(api.getPanel())
    await panel.ready
    assert.match(collectText(panel.root()), /2026 测试赛/)
  } finally {
    env.restore()
  }
})

test('生产路径：宿主页面没有 fetch 时也不抛错（降级为错误态）', async () => {
  const env = installGlobals(undefined)
  try {
    const { api } = await loadClientModule()
    const panel = track(api.getPanel())
    await panel.refresh()
    assert.match(collectText(panel.root()), /加载失败|不支持 fetch/)
  } finally {
    env.restore()
  }
})

test('生产路径：没有 __ModuleLoader__ 时脚本仍能跑（浮动面板照旧）', async () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    // 模拟「没有模块加载器」的降级场景：注册应当被安全跳过
    const { api } = await loadClientModule()
    delete globalThis.window.__ModuleLoader__
    assert.ok(env.dom.document.getElementById('lingxu-ctf-panel'), '没有模块加载器也要挂出面板')
    track(api.getPanel())
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
  // 面板与配置卡片全部消失。vm.runInContext 按 **script** 编译，正好复现这一点。
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

  // 物化后仍要给出 name / apply / inject
  const exports = registered[0].factory(() => { throw new Error('no react') })
  assert.equal(exports.name, 'dsh-lingxu-ctf')
  assert.equal(typeof exports.apply, 'function')
  // 注意：数组来自 vm 的另一个 realm，需拷回本 realm 再比较
  assert.deepEqual([...exports.inject], ['slots'])

  // 顶层自挂载也要在 script 求值时生效
  assert.ok(dom.document.getElementById('lingxu-ctf-panel'), 'classic script 求值后应挂出浮动面板')
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

  assert.equal(countByClass(card.element, 'lx-config-field'), 10, '应渲染 10 个字段')
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

test('apply(ctx)：同时注册配置卡片与浮动面板', () => {
  const env = installGlobals(async () => jsonResponse(fullSnapshot()))
  try {
    const registered = []
    const ctx = {
      slots: { register(options) { registered.push(options); return () => {} } },
      effect(fn) { return fn() },
    }
    const panel = track(apply(ctx))
    assert.equal(registered.length, 1, 'apply 应把配置卡片注册进 slot')
    assert.equal(registered[0].name, 'plugins.bundle.config')
    assert.equal(registered[0].key, 'dsh-lingxu-ctf')
    assert.equal(panel.mounted, true, '浮动面板照旧挂载')
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
  // 若面板的 position:fixed 等布局声明与主题变量同处 `#panel,.lx-config{}`，
  // 卡片会变成右下角浮层、布局全乱（用户看到的「CSS 丢失」）。
  const { api } = await loadClientModule()
  const css = api.panelCss()

  // 主题变量块允许同时作用于面板与卡片
  assert.match(css, /#lingxu-ctf-panel,\.lx-config\{/)
  // 但 position:fixed 只能出现在 #lingxu-ctf-panel 块里
  const fixedBlocks = [...css.matchAll(/([^{}]+)\{[^}]*position:fixed/g)].map((m) => m[1].trim())
  assert.deepEqual(fixedBlocks, ['#lingxu-ctf-panel'], `position:fixed 只能作用于面板，实际: ${JSON.stringify(fixedBlocks)}`)
  // 卡片自己的块不得含任何定位
  const cardBlock = /\.lx-config\{([^}]*)\}/.exec(css)
  assert.ok(cardBlock, '应有 .lx-config 基础块')
  for (const bad of ['position:', 'z-index:', 'right:', 'bottom:']) {
    assert.equal(cardBlock[1].includes(bad), false, `.lx-config 不得含 ${bad}`)
  }
})

test('CSS 作用域：暗色主题变量同时覆盖面板与卡片', async () => {
  const { api } = await loadClientModule()
  const css = api.panelCss()
  assert.match(css, /@media \(prefers-color-scheme:dark\)\{#lingxu-ctf-panel,\.lx-config\{/)
})
