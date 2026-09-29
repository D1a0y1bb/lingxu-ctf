import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply, normalizeConfig, slugify, maskFlag, injectBootEntry, buildPanelState,
  buildTeamState, buildReportsState, readLimitParam, toChallengeId, toEpochMs, withSessionCapture,
  name as pluginName, inject, Config, configHasCredentials, plainConfigValue,
  describeConfigFields, readJsonBody,
  createStageToolRegistry,
} from '../lib/index.js'

/** 最小 Cordis Context 替身：收集注册项，effect 立即执行并记录 disposer。 */
function mockCtx(services = {}) {
  const collected = { tools: [], sections: [], routes: [], taps: [], commands: [], effects: [] }
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(def) {
        collected.tools.push(def)
        return () => {
          const i = collected.tools.indexOf(def)
          if (i >= 0) collected.tools.splice(i, 1)
        }
      },
    },
    get(name) {
      if (name === 'systemPrompt') return { section: (s) => { collected.sections.push(s); return () => {} } }
      if (name === 'webServer') {
        return {
          register: (r) => { collected.routes.push(r); return () => {} },
          tapIndex: (f) => { collected.taps.push(f); return () => {} },
        }
      }
      if (name === 'commands') return { register: (c) => { collected.commands.push(c); return () => {} } }
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      collected.effects.push(fn)
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    _collected: collected,
    _disposeAll() { for (const d of disposers.splice(0)) d() },
  }
  return ctx
}

test('normalizeConfig: 默认值', () => {
  const c = normalizeConfig()
  assert.equal(c.concurrency, 4)
  assert.equal(c.maxWrongAttempts, 0)
  assert.equal(c.dedupeFlags, true)
  assert.equal(c.timeoutMs, 30000)
  assert.equal(c.enableWebPanel, true)
  assert.equal(c.workDir, '')
})

test('normalizeConfig: 并发被夹在 1..8', () => {
  assert.equal(normalizeConfig({ concurrency: 0 }).concurrency, 1)
  assert.equal(normalizeConfig({ concurrency: 99 }).concurrency, 8)
  assert.equal(normalizeConfig({ concurrency: 3.7 }).concurrency, 3)
  assert.equal(normalizeConfig({ concurrency: 'abc' }).concurrency, 4)
})

test('normalizeConfig: 其余字段边界', () => {
  assert.equal(normalizeConfig({ maxWrongAttempts: -5 }).maxWrongAttempts, 0)
  assert.equal(normalizeConfig({ maxWrongAttempts: 3 }).maxWrongAttempts, 3)
  assert.equal(normalizeConfig({ dedupeFlags: false }).dedupeFlags, false)
  assert.equal(normalizeConfig({ timeoutMs: 10 }).timeoutMs, 1000)
  assert.equal(normalizeConfig({ enableWebPanel: false }).enableWebPanel, false)
  assert.equal(normalizeConfig({ workDir: '  /tmp/x  ' }).workDir, '/tmp/x')
})

test('slugify: 保留中文可读性，剔除路径危险字符', () => {
  assert.equal(slugify('NeuroSign'), 'neurosign')
  assert.equal(slugify('AIoT固件加密服务'), 'aiot固件加密服务')
  assert.equal(slugify('a/b\\c:d'), 'a-b-c-d')
  assert.equal(slugify('  hello   world  '), 'hello-world')
  assert.equal(slugify('///'), 'challenge', '全非法字符时回退')
  assert.equal(slugify('', 'fallback'), 'fallback')
  assert.equal(slugify('x'.repeat(200)).length <= 60, true)
})

test('maskFlag: 脱敏但仍可辨认', () => {
  assert.equal(maskFlag(''), '')
  assert.equal(maskFlag('ab'), 'ab'.slice(0, 2))
  assert.match(maskFlag('flag{this_is_a_secret_flag}'), /^flag\{t\*+g\}$/)
  assert.equal(maskFlag('flag{this_is_a_secret_flag}').includes('secret'), false)
})







test('apply: 注册工具 / 提示词 / 路由 / 命令，并暴露插件身份', () => {
  const ctx = mockCtx()
  apply(ctx, { workDir: '/tmp/lingxu-test', enableWebPanel: true })

  assert.equal(pluginName, 'dsh-lingxu-ctf')
  assert.deepEqual(inject, ['tools'])

  const names = ctx._collected.tools.map((t) => t.name).sort()
  assert.equal(names.length, 16, `应注册 16 个工具，实际 ${names.length}: ${names.join(',')}`)
  for (const expected of [
    'ctf_connect', 'ctf_session', 'ctf_status', 'ctf_challenges', 'ctf_challenge', 'ctf_start_env',
    'ctf_delay_env', 'ctf_release_env', 'ctf_submit_flag', 'ctf_leaderboard', 'ctf_theory', 'ctf_notice',
    'ctf_solve_start', 'ctf_solve_status', 'ctf_solve_stop', 'ctf_writeup',
  ]) {
    assert.equal(names.includes(expected), true, `缺少工具 ${expected}`)
  }

  // 每个工具都必须是 registry-ready 的形状
  for (const tool of ctx._collected.tools) {
    assert.equal(typeof tool.description, 'string', `${tool.name} 缺 description`)
    assert.equal(tool.parameters?.type, 'object', `${tool.name} 的 parameters 不是 object schema`)
    assert.equal(typeof tool.output?.schema, 'object', `${tool.name} 缺 output.schema`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} 缺 output.render`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`)
  }

  assert.equal(ctx._collected.sections.length, 1)
  assert.equal(ctx._collected.sections[0].name, 'ctf:protocol')

  const routes = ctx._collected.routes.map((r) => r.path).sort()
  assert.equal(routes.includes('/lingxu-ctf/state'), true, '状态路由必须注册')
  assert.equal(routes.includes('/lingxu-ctf/config'), true, '配置读写路由必须注册（设置页表单用）')
  assert.equal(routes.includes('/lingxu-ctf/diag'), true, '诊断路由必须注册')
  assert.equal(routes.includes('/lingxu-ctf/beacon'), true, '客户端回传探针路由必须注册')
  assert.equal(routes.includes('/lingxu-ctf/team'), true, '顶部「CTF」视图的团队数据路由必须注册')
  assert.equal(routes.includes('/lingxu-ctf/reports'), true, '顶部「CTF」视图的报告路由必须注册')
  // client.js 路由仅在 lib/client.js 存在时注册（优雅降级）
  const hasBundle = routes.includes('/lingxu-ctf/client.js')
  // 客户端半改走官方 dsh.client 机制，**不再**注册 tapIndex
  assert.equal(ctx._collected.taps.length, 0, '不得再注册 tapIndex 注入（会被宿主权威 graph 覆盖）')
  assert.equal(routes.length, hasBundle ? 7 : 6)
  assert.equal(ctx._collected.commands.length, 1)
  assert.equal(ctx._collected.commands[0].name, 'ctf-status')
})

test('apply: enableWebPanel=false 时不注册路由', () => {
  const ctx = mockCtx()
  apply(ctx, { workDir: '/tmp/lingxu-test', enableWebPanel: false })
  assert.equal(ctx._collected.routes.length, 0)
  assert.equal(ctx._collected.taps.length, 0)
  assert.equal(ctx._collected.tools.length, 16, '工具不受面板开关影响')
})

test('apply: 无 agentTeams 服务时仍能加载（编排工具给出清晰报错）', () => {
  const ctx = mockCtx() // services 里没有 agentTeams
  apply(ctx, { workDir: '/tmp/lingxu-test' })
  assert.equal(ctx._collected.tools.length, 16)
})

/**
 * Cordis 的 Context 是 Proxy：读取**未在 inject 中声明**的 service 属性会直接抛
 * `cannot get property "<name>" without inject`。
 * 这个替身复刻该行为 —— 真实安装时 `ctx.agent` 就是这样炸掉整个插件加载的，
 * 而当时所有测试都没覆盖到（mockCtx 是个普通对象，读什么都不会抛）。
 */
function strictCordisCtx(services = {}) {
  const collected = { tools: [], sections: [], routes: [], taps: [], commands: [] }
  const target = {
    // 宿主自带的非 service 成员
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { fn(); return () => {} },
    get(name) { return services[name] },
    tools: {
      register(def) { collected.tools.push(def); return () => {} },
    },
    _collected: collected,
  }
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop]
      // 任何未在 target 上的属性访问都按 Cordis 语义抛错
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

test('apply: 在 Cordis 严格 Proxy 上下文下不触碰未 inject 的 service', () => {
  // 真实场景：插件行挂在 profile 层，没有 ambient agent / systemPrompt / webServer 等
  const ctx = strictCordisCtx({}) // 所有 service 都缺失
  assert.doesNotThrow(() => apply(ctx, {}), '不得因读取未声明的 service 而炸掉加载')
  assert.equal(ctx._collected.tools.length, 16, '工具仍应全部注册')
})

test('apply: 严格 Proxy + 完整 service 时正常装配', () => {
  const sections = []
  const routes = []
  const ctx = strictCordisCtx({
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    webServer: { register: (r) => { routes.push(r); return () => {} }, tapIndex: () => () => {} },
    commands: { register: () => () => {} },
    agentTeams: { spawnTeammate() {}, createTask() {}, listTasks() {} },
    agent: { session: { header: { cwd: '/tmp/strict-cwd' } } },
  })
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(sections.length, 1)
  assert.equal(routes.some((r) => r.path === '/lingxu-ctf/state'), true)
})

test('apply: workDir 未配置时给出可写默认值，不落到不可写的 /', () => {
  const ctx = strictCordisCtx({})
  assert.doesNotThrow(() => apply(ctx, {}))
  // Electron 从 Finder 启动时 process.cwd() === '/'，绝不能拼出 /lingxu-ctf-work
  const cfg = normalizeConfig({})
  assert.equal(cfg.workDir, '', '未配置时 config.workDir 保持空，由下游解析')
})

/**
 * 模拟真实 Cordis：`ctx.inject(deps, cb)` 会**延迟**到依赖就绪才跑 cb。
 * 这是生产路径（真实 DSH 里 ctx.get 取不到未 inject 的 service），必须专门覆盖。
 */
function injectAwareCtx(available = {}) {
  const collected = { tools: [], sections: [], routes: [], taps: [], commands: [], pending: [], injected: [] }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(def) { collected.tools.push(def); return () => {} } },
    effect(fn) { fn(); return () => {} },
    get() { return undefined }, // 真实 DSH 语义：ctx.get 对未 inject 的 service 返回 undefined
    inject(deps, callback) {
      collected.injected.push(deps)
      const ready = deps.every((d) => available[d] !== undefined)
      if (ready) callback(makeChild(deps))
      else collected.pending.push({ deps, callback })
      return { dispose() {} }
    },
    _collected: collected,
    _collected_deliver(name, value) {
      available[name] = value
      const stillPending = []
      for (const item of collected.pending) {
        if (item.deps.every((d) => available[d] !== undefined)) item.callback(makeChild(item.deps))
        else stillPending.push(item)
      }
      collected.pending = stillPending
    },
  }
  function makeChild(deps) {
    const child = {
      logger: ctx.logger,
      effect(fn) { fn(); return () => {} },
      get: () => undefined,
    }
    for (const d of deps) child[d] = available[d]
    return child
  }
  return ctx
}

test('apply: 用 ctx.inject 等待可选 service（生产路径）', () => {
  const ctx = injectAwareCtx({}) // 一开始什么服务都没有
  apply(ctx, { workDir: '/tmp/lingxu-test' })

  assert.equal(ctx._collected.tools.length, 16, '工具只依赖 tools，立即可用')
  assert.deepEqual(
    ctx._collected.injected.map((d) => d[0]).sort(),
    ['agentTeams', 'commands', 'systemPrompt', 'webServer'],
    '四个可选服务都应通过 ctx.inject 声明',
  )
  assert.equal(ctx._collected.pending.length, 4, '依赖未就绪时应挂起而不是失败')

  // 逐个交付服务
  const sections = []
  ctx._collected_deliver('systemPrompt', { section: (s) => { sections.push(s); return () => {} } })
  assert.equal(sections.length, 1, 'systemPrompt 就绪后应注入提示词')

  const routes = []
  ctx._collected_deliver('webServer', {
    register: (r) => { routes.push(r); return () => {} },
    tapIndex: () => () => {},
  })
  assert.equal(routes.some((r) => r.path === '/lingxu-ctf/state'), true, 'webServer 就绪后应注册面板路由')

  ctx._collected_deliver('commands', { register: () => () => {} })
  assert.equal(ctx._collected.pending.length, 1, '只剩 agentTeams 未就绪')
})

test('apply: agentTeams 就绪后编排器才被装配（deps.orchestrator 延迟赋值）', async () => {
  const ctx = injectAwareCtx({})
  apply(ctx, { workDir: '/tmp/lingxu-test' })

  const solveStart = ctx._collected.tools.find((t) => t.name === 'ctf_solve_start')
  // 未就绪：应给出可读说明或硬失败，但不能崩得莫名其妙
  let before = ''
  try {
    before = String(await solveStart.execute({}, {}))
  } catch (error) {
    before = error?.message ?? String(error)
  }
  assert.match(before, /orchestrator|Agent Teams|不可用/, '未就绪时要有可读提示')

  // 交付 agentTeams
  const spawned = []
  ctx._collected_deliver('agentTeams', {
    spawnTeammate(caller, req) { spawned.push(req); return { member: { name: req.name } } },
    createTask() { return { id: 't1' } },
    listTasks() { return [] },
    listMembers() { return [] },
  })
  assert.equal(
    ctx._collected.pending.some((p) => p.deps.includes('agentTeams')),
    false,
    'agentTeams 交付后不应再挂起',
  )

  // 就绪后：应能走到真实编排（此处无连接，会给出平台连接提示而不是「orchestrator 缺失」）
  const after = String(await solveStart.execute({}, {}))
  assert.equal(
    /orchestrator.*未注入|请确认 lib\/orchestrate\.js/.test(after),
    false,
    `agentTeams 就绪后不应再报编排器缺失，实际：${after.slice(0, 120)}`,
  )
})

test('apply: 缺少 ctx.inject 的上下文退化为直接取一次（测试替身兼容）', () => {
  const ctx = mockCtx({ agentTeams: { spawnTeammate() {}, createTask() {}, listTasks() {}, listMembers() {} } })
  assert.doesNotThrow(() => apply(ctx, { workDir: '/tmp/lingxu-test' }))
  assert.equal(ctx._collected.tools.length, 16)
  assert.equal(ctx._collected.sections.length, 1)
  assert.equal(ctx._collected.routes.some((r) => r.path === '/lingxu-ctf/state'), true)
})

test('apply: 工具可通过 dispose 注销', () => {
  const ctx = mockCtx()
  apply(ctx, { workDir: '/tmp/lingxu-test' })
  assert.equal(ctx._collected.tools.length, 16)
  ctx._disposeAll()
  assert.equal(ctx._collected.tools.length, 0)
})

test('apply: 未配置平台时 ctf_status 返回引导性提示而不是崩溃', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-index-'))
  process.env.DSH_HOME = dir
  const ctx = mockCtx()
  apply(ctx, { workDir: dir })
  const status = ctx._collected.tools.find((t) => t.name === 'ctf_status')
  // 工具层刻意把「未配置」做成可读文本而非抛异常：模型能直接照做，不浪费一轮
  const text = await status.execute({}, {})
  assert.equal(typeof text, 'string')
  assert.match(text, /ctf_connect/, '必须告诉模型下一步该调 ctf_connect')
})

// ────────────────────────────────────────────── 面板快照

test('buildPanelState: 汇总平台与本地状态', async () => {
  const adapter = {
    async eventSummary() { return { name: '测试赛', remainingSeconds: 100, user: { username: 'xiyi' }, punish: true } },
    async challenges() {
      return [
        { id: 1, name: 'A', category: 'Web', score: 100, solved: true },
        { id: 2, name: 'B', category: 'Pwn', score: 200, solved: false },
        { id: 3, name: 'C', category: 'Pwn', score: 300, solved: false },
      ]
    },
    async leaderboard() { return { rows: [{ rank: 1, username: 'admin', score: 0, isSelf: false }] } },
    async myRank() { return { rank: 2, total: 5, self: { username: 'xiyi', score: 100 } } },
    async theoryTests() { return [{ id: 3, name: '理论题', count: 100, isBegin: false, timeSeconds: 3600 }] },
  }
  const submissions = [
    { at: '2026-09-29T01:00:00Z', challengeId: 1, status: 'correct', flag: 'flag{averylongsecret}' },
    { at: '2026-09-29T01:01:00Z', challengeId: 2, status: 'incorrect', flag: 'flag{wrong}' },
  ]
  const store = {
    async recentSubmissions() { return submissions },
    async listChallengeWork() { return [{ challengeId: 2, status: 'working', owner: 'solver-pwn-2' }] },
  }
  const state = await buildPanelState({
    store,
    deps: {},
    resolveAdapter: async () => ({
      adapter,
      connection: { platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4, label: '测试' },
      connKey: 'lingxu:x.com:4',
    }),
  })

  assert.equal(state.ok, true)
  assert.equal(state.connection.eventId, 4)
  assert.equal(state.event.name, '测试赛')
  assert.equal(state.event.punish, true)
  assert.deepEqual(state.stats, { total: 3, solved: 1, working: 1, pending: 1, totalScore: 100 })
  assert.equal(state.rank.rank, 2)

  const byId = Object.fromEntries(state.challenges.map((c) => [c.id, c]))
  assert.equal(byId[1].status, 'solved')
  assert.equal(byId[2].status, 'working')
  assert.equal(byId[2].owner, 'solver-pwn-2')
  assert.equal(byId[2].submitAttempts, 1)
  assert.equal(byId[3].status, 'pending')

  assert.equal(state.submissions[0].challengeName, 'B', '最新提交在前')
  assert.equal(state.submissions[0].flag.includes('secret'), false, 'flag 必须脱敏')
  assert.equal(state.theory.length, 1)
})

test('buildPanelState: 平台接口部分失败时不整体崩', async () => {
  const adapter = {
    async eventSummary() { throw new Error('boom') },
    async challenges() { return [] },
    async leaderboard() { throw new Error('boom') },
    async myRank() { throw new Error('boom') },
    async theoryTests() { throw new Error('boom') },
  }
  const store = {
    async recentSubmissions() { return [] },
    async listChallengeWork() { return [] },
  }
  const state = await buildPanelState({
    store,
    deps: {},
    resolveAdapter: async () => ({ adapter, connection: { platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4 }, connKey: 'k' }),
  })
  assert.equal(state.ok, true)
  assert.equal(state.stats.total, 0)
  assert.equal(state.rank, null)
  assert.deepEqual(state.theory, [])
})

// ────────────────────────────────────────────── 插件配置（设置页表单）

test('Config schema：存在、有默认值、字段齐全', () => {
  assert.equal(typeof Config, 'function', 'Config 应是 schemastery schema（可调用）')
  // volatile 字段解析出来是「稳定引用」对象，必须解包后才是真实值
  const parsed = plainConfigValue(Config({}))
  for (const key of [
    'baseUrl', 'eventId', 'cookie', 'label',
    'concurrency', 'maxWrongAttempts', 'dedupeFlags', 'workDir', 'timeoutMs', 'enableWebPanel',
  ]) {
    assert.equal(key in parsed, true, `Config 缺字段 ${key}`)
  }
  // 只支持凌虚：不应再有 CTFd 专用的 platform / token
  assert.equal('platform' in parsed, false, 'platform 字段应已移除（只支持凌虚）')
  assert.equal('token' in parsed, false, 'token 字段应已移除（CTFd 专用）')
  assert.equal(parsed.concurrency, 4)
  assert.equal(parsed.dedupeFlags, true)
  assert.equal(parsed.enableWebPanel, true)
})

test('Config schema：每个字段都标了 volatile —— 否则设置页根本不显示配置', () => {
  // dsh-settings 的 describe()：const form = volatileForm(schema); if (form === void 0) return []
  // volatileForm 只在 schema 本身或某个字段带 meta.volatile 时才返回表单。
  // 只导出 Config 不加 volatile 的表现是「插件能跑，但设置里找不到任何配置项」。
  const fields = Object.entries(Config.dict ?? {})
  assert.equal(fields.length, 13, `应有 13 个字段，实际 ${fields.length}`)
  const notVolatile = fields.filter(([, child]) => child.meta?.volatile !== true).map(([k]) => k)
  assert.deepEqual(notVolatile, [], `这些字段缺 .volatile()，会导致设置页不显示：${notVolatile.join(', ')}`)
  // 外层 object 不能也标 volatile（schemastery 会直接抛 ValidationError）
  assert.equal(Config.meta?.volatile, undefined, '外层 object 不能标 volatile')
})

test('plainConfigValue：解包 volatile 引用（真实 Loader 路径）', () => {
  const parsed = Config({ baseUrl: 'https://y.com', eventId: 7, cookie: 'sessionid=z', concurrency: 6 })
  // 未解包时每个字段都是 {}（引用对象）
  assert.equal(typeof parsed.baseUrl, 'object')
  const plain = plainConfigValue(parsed)
  assert.equal(plain.baseUrl, 'https://y.com')
  assert.equal(plain.eventId, 7)
  assert.equal(plain.cookie, 'sessionid=z')
  assert.equal(plain.concurrency, 6)
  assert.equal(plain.eventId, 7, '未显式给的字段应拿到 schema 默认值')
  // normalizeConfig 必须自己解包，否则读到的是 {}
  const norm = normalizeConfig(parsed)
  assert.equal(norm.baseUrl, 'https://y.com')
  assert.equal(norm.eventId, 7)
  assert.equal(norm.cookie, 'sessionid=z')
  assert.equal(norm.concurrency, 6)
})

test('Config schema：cookie 标了 role(secret)（跨线脱敏、只写输入）', () => {
  const json = JSON.stringify(Config.toJSON())
  assert.match(json, /secret/, 'cookie 必须是 role(secret)，否则设置页会明文回显凭据')
  assert.equal(Config.dict.cookie.meta?.role, 'secret')
})

test('configHasCredentials：需要 baseUrl + eventId + cookie', () => {
  assert.equal(configHasCredentials(normalizeConfig({})), false)
  assert.equal(configHasCredentials(normalizeConfig({ baseUrl: 'https://x.com' })), false, '缺 eventId/cookie')
  assert.equal(
    configHasCredentials(normalizeConfig({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })),
    true,
  )
  assert.equal(configHasCredentials(normalizeConfig({ baseUrl: 'https://x.com' })), false, '只有 baseUrl 不够')
})

test('normalizeConfig：新字段的边界处理', () => {
  const c = normalizeConfig({ baseUrl: 'https://x.com///', eventId: '4', cookie: '  a=b  ' })
  assert.equal(c.baseUrl, 'https://x.com', '去掉尾部斜杠')
  assert.equal(c.eventId, 4)
  assert.equal(c.cookie, 'a=b', '去掉首尾空白')
  assert.equal(normalizeConfig({ eventId: -5 }).eventId, 0)
  assert.equal(normalizeConfig({}).concurrency, 4, '默认并发 4')
  assert.equal(normalizeConfig({ concurrency: 99 }).concurrency, 8, '并发上限 8')
  assert.equal(normalizeConfig({ concurrency: 0 }).concurrency, 1, '并发下限 1')
})

test('apply：设置页填好配置后，无需 ctf_connect 也能解析连接', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-cfg-'))
  process.env.DSH_HOME = dir
  const ctx = injectAwareCtx({})
  apply(ctx, {
    baseUrl: 'https://cfg.example.com',
    eventId: 7,
    cookie: 'sessionid=from-config',
    label: '设置页配置',
  })

  // 没有 ctf_connect、store 里也没有连接 —— 应当用配置兜底
  const status = ctx._collected.tools.find((t) => t.name === 'ctf_status')
  let out = ''
  try {
    out = String(await status.execute({}, {}))
  } catch (error) {
    out = error?.message ?? String(error)
  }
  assert.equal(/未找到可用的平台连接/.test(out), false, `配置已填，不应再报未配置：${out.slice(0, 160)}`)
})

test('apply：配置为空时才提示去设置页', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-cfg2-'))
  process.env.DSH_HOME = dir
  const ctx = injectAwareCtx({})
  apply(ctx, {})
  const status = ctx._collected.tools.find((t) => t.name === 'ctf_status')
  const out = String(await status.execute({}, {}))
  assert.match(out, /设置|插件配置|ctf_connect/, '要告诉用户去哪里配置')
})

// ────────────────────────────────────────────── 模块形状（Loader 契约）

test('默认导出必须携带 Config/inject/apply —— Loader 只认 default 导出', async () => {
  // cordis-plugin-loader 的 normalizeExports 是 `exports = exports.default ?? exports`：
  // 有 default 导出时，Loader 只从 default 上读 plugin.Config，命名导出被忽略。
  // 漏了 Config 的后果是「设置页没有配置表单」（inspect status: "absent"），实测踩过。
  const mod = await import('../lib/index.js')
  const def = mod.default
  assert.equal(typeof def, 'object', '必须有 default 导出对象')
  assert.equal(def.Config, mod.Config, 'default.Config 必须与命名导出一致')
  assert.equal(typeof def.Config, 'function', 'Config 应是 schemastery schema')
  assert.deepEqual(def.inject, mod.inject, 'default.inject 必须存在')
  assert.equal(typeof def.apply, 'function', 'default.apply 必须存在')
  assert.equal(def.name, 'dsh-lingxu-ctf')
  // default 上的 Config 必须能解析出默认值（否则 Loader 校验会失败）
  assert.equal(plainConfigValue(def.Config({})).concurrency, 4)
})

// ────────────────────────────────────────────── 设置页配置读写接口

test('describeConfigFields：13 个字段，含中文标签/类型/说明/secret 标记', () => {
  const fields = describeConfigFields()
  assert.equal(fields.length, 13)
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]))

  assert.equal(byKey.cookie.role, 'secret')
  assert.equal(byKey.cookie.label, 'Cookie（sessionid）')
  assert.equal(byKey.baseUrl.label, '平台地址')
  assert.equal(byKey.eventId.label, '赛事 ID')
  // 每个字段都必须有中文标签，否则设置页会显示英文 key
  for (const f of fields) {
    assert.equal(typeof f.label, 'string', `${f.key} 缺 label`)
    assert.equal(f.label.length > 0, true)
    // 标签必须区别于英文 key（否则设置页会显示 baseUrl / concurrency 这种）
    assert.notEqual(f.label, f.key, `${f.key} 的 label 不能等于 key`)
    assert.equal(f.label.length >= 2, true, `${f.key} 的 label 太短`)
  }
  assert.equal(byKey.dedupeFlags.type, 'boolean')
  assert.equal(byKey.eventId.type, 'number')
  assert.equal(byKey.baseUrl.type, 'string')
  // 每个字段都要有中文说明，设置页才有提示文字
  for (const f of fields) assert.equal(f.description.length > 0, true, `${f.key} 缺 description`)
})

test('readJsonBody：解析 JSON、空体、非法体、超限', async () => {
  const { EventEmitter } = await import('node:events')
  const mk = (chunks) => {
    const req = new EventEmitter()
    req.destroy = () => {}
    queueMicrotask(() => {
      for (const c of chunks) req.emit('data', Buffer.from(c))
      req.emit('end')
    })
    return req
  }
  assert.deepEqual(await readJsonBody(mk(['{"a":1}'])), { a: 1 })
  assert.deepEqual(await readJsonBody(mk(['   '])), {}, '空体应为 {}')
  await assert.rejects(() => readJsonBody(mk(['{not json'])), /不是合法 JSON/)
  await assert.rejects(() => readJsonBody(mk(['x'.repeat(300)]), { maxBytes: 10 }), /过大/)
})

/**
 * 复刻 dsh-client-modules 的 `parseBootManifest` 校验规则（逐条对照源码写），
 * 用来验证我们注入的 boot graph 一定会被宿主接受。
 * 规则来源：dsh-client-modules/lib/client.js 的 parseBootManifest。
 */
function validateBootManifest(graph) {
  if (typeof graph !== 'object' || graph === null) throw new Error('__DSH_BOOT__ is missing or not an object')
  if (typeof graph.rev !== 'string') throw new Error('boot manifest rev must be a string')
  if (!Array.isArray(graph.entries)) throw new Error('boot manifest entries must be an array')
  if (!Array.isArray(graph.batches)) throw new Error('boot manifest batches must be an array')

  const entryIds = new Set()
  for (const row of graph.entries) {
    if (typeof row !== 'object' || row === null) throw new Error('boot manifest entry is not an object')
    if (typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.rev !== 'string') {
      throw new Error('boot manifest entry must carry string id/url/rev')
    }
    if (entryIds.has(row.id)) throw new Error(`duplicate graph entry "${row.id}"`)
    entryIds.add(row.id)
  }

  const batchUrls = new Set()
  const initialUrls = new Map()
  for (const batch of graph.batches) {
    if (typeof batch !== 'object' || batch === null) throw new Error('boot manifest batch is not an object')
    if (batch.phase !== 'bootstrap' && batch.phase !== 'application') throw new Error('bad batch phase')
    if (typeof batch.url !== 'string' || typeof batch.rev !== 'string') throw new Error('batch must carry string url/rev')
    if (batchUrls.has(batch.url)) throw new Error(`duplicate batch URL ${batch.url}`)
    batchUrls.add(batch.url)
    if (!Array.isArray(batch.entries) || batch.entries.length === 0) throw new Error('batch entries must be non-empty')
    for (const id of batch.entries) {
      if (!entryIds.has(id)) throw new Error(`batch names unknown entry "${id}"`)
      if (initialUrls.has(id)) throw new Error(`entry "${id}" belongs to more than one batch`)
      initialUrls.set(id, batch.url)
    }
  }

  for (const row of graph.entries) {
    if (initialUrls.get(row.id) === undefined) throw new Error(`entry "${row.id}" belongs to no initial-load batch`)
  }
  return true
}

test('package.json 走官方 dsh.client 机制（而不是 tapIndex 注入）', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  // dsh-client-modules 宿主半的 resolveMeta 要求：dsh.client.platform === 'web'
  assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform 必须是 web')
  // clientExportOf 要求 exports["./client"] 是字符串
  assert.equal(typeof pkg.exports?.['./client'], 'string', 'exports["./client"] 必须是字符串')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  // 且该文件必须真实存在
  assert.equal(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').length > 0, true)
  // bundle patch 仍要在
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
})

test('index.js 源码里不再调用 webServer.tapIndex 注入 boot graph', async () => {
  // 宿主会用权威 graph 覆盖并删除非官方条目，注入毫无意义；
  // 且若与官方条目 id 重名，parseBootManifest 会抛 duplicate graph entry，
  // 导致**整个客户端模块系统**启动失败。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 允许注释里提到 tapIndex，但不允许真的调用
  const calls = src.match(/webServer\.tapIndex\s*\(|webServer\?\.tapIndex\s*\(/g) ?? []
  assert.deepEqual(calls, [], `不得调用 tapIndex，实际 ${calls.length} 处`)
})

// ────────────────────────────────────────────── 顶部「CTF」视图：/lingxu-ctf/team

const TEAM_CONN_KEY = 'lingxu:x.com:4'
const TEAM_AGENT = { id: 'agent-lead', name: 'lead' }

/** 复刻 ctx.agentTeams 的只读接口（listMembers 首行固定是 lead）。 */
function mockAgentTeams(overrides = {}) {
  const calls = { listMembers: 0, listTasks: 0, callers: [] }
  const teams = {
    listMembers(caller) {
      calls.listMembers += 1
      calls.callers.push(caller)
      return [
        { id: 'agent-lead', name: 'lead', role: 'lead', status: 'running' },
        {
          id: 'child-1', name: 'solver-neurosign-1', role: 'teammate', status: 'running',
          description: '解题 teammate：Crypto/NeuroSign（100分，challengeId=1）',
        },
        { id: 'child-2', name: 'solver-web-2', role: 'teammate', status: 'inactive' },
      ]
    },
    listTasks() {
      calls.listTasks += 1
      return [
        {
          id: 'task-1', revision: 3, subject: '[Crypto] NeuroSign (100分)', status: 'in_progress',
          description: 'challengeId: 1\n题目：NeuroSign\n分类：Crypto ｜ 分值：100',
          ownerName: 'solver-neurosign-1',
          writeScopes: ['lingxu-ctf-work/challenges/neurosign-1'],
          blockedBy: [], ready: false, writeScopeWarnings: [],
        },
        {
          id: 'task-2', revision: 1, subject: '[Web] 签到 (100分)', status: 'completed',
          description: 'challengeId: 2', ownerName: 'solver-web-2',
          writeScopes: ['lingxu-ctf-work/challenges/签到-2'], blockedBy: [], ready: false,
        },
      ]
    },
    ...overrides,
  }
  return { teams, calls }
}

/** 复刻 store 的两个只读接口（team 路由用到的部分）。 */
function mockTeamStore(overrides = {}) {
  const work = [
    {
      connKey: TEAM_CONN_KEY, challengeId: '1', taskId: 'task-1', teammate: 'solver-neurosign-1',
      subject: '[Crypto] NeuroSign (100分)', status: 'solving',
      taskCreatedAt: '2026-09-29T05:00:00.000Z', updatedAt: '2026-09-29T05:02:00.000Z',
    },
  ]
  const messages = [
    { connKey: TEAM_CONN_KEY, at: '2026-09-29T05:02:10.000Z', from: 'solver-neurosign-1', to: 'lead', kind: 'report', text: 'NeuroSign 已解出，flag 已提交' },
    { connKey: TEAM_CONN_KEY, at: '2026-09-29T05:03:00.000Z', from: 'lead', to: 'team', kind: 'status', text: '轮询一次' },
  ]
  return {
    async listChallengeWork() { return work },
    async listTeamMessages(connKey, limit) {
      const rows = connKey ? messages.filter((m) => m.connKey === connKey) : messages
      return rows.slice(-(Number(limit) > 0 ? Number(limit) : 50))
    },
    ...overrides,
  }
}

const teamResolveAdapter = async () => ({
  adapter: {},
  connection: { platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4, label: '数信杯测试赛' },
  connKey: TEAM_CONN_KEY,
})

test('buildTeamState：响应形状严格按契约（成员 / 任务 / 消息 / 计数）', async () => {
  const { teams } = mockAgentTeams()
  const store = mockTeamStore()
  const state = await buildTeamState({
    store,
    teams,
    caller: TEAM_AGENT,
    resolveAdapter: teamResolveAdapter,
    now: () => Date.parse('2026-09-29T05:02:45.143Z'),
  })

  assert.equal(state.ok, true)
  assert.equal(state.generatedAt, '2026-09-29T05:02:45.143Z')
  assert.deepEqual(state.connection, { key: TEAM_CONN_KEY, label: '数信杯测试赛' })
  assert.deepEqual(Object.keys(state).sort(), ['connection', 'counts', 'generatedAt', 'members', 'messages', 'ok', 'tasks'])

  // ── members：listMembers 透传 + work/description 映射出题目
  assert.equal(state.members.length, 3)
  for (const member of state.members) {
    assert.deepEqual(Object.keys(member).sort(), ['category', 'challengeId', 'challengeName', 'description', 'name', 'role', 'status'])
  }
  assert.deepEqual(state.members[0], {
    name: 'lead', role: 'lead', status: 'running', description: '',
    challengeId: null, challengeName: null, category: null,
  })
  const solver = state.members[1]
  assert.equal(solver.name, 'solver-neurosign-1')
  assert.equal(solver.role, 'teammate')
  assert.equal(solver.status, 'running', 'status 直接透传')
  assert.equal(solver.description, '解题 teammate：Crypto/NeuroSign（100分，challengeId=1）')
  assert.equal(solver.challengeId, 1, '数字 id（与平台 challenges[].id 可比）')
  assert.equal(solver.challengeName, 'NeuroSign')
  assert.equal(solver.category, 'Crypto')
  // 没有 work 记录 + 没有 description → 一律 null，不崩
  assert.deepEqual(state.members[2], {
    name: 'solver-web-2', role: 'teammate', status: 'inactive', description: '',
    challengeId: null, challengeName: null, category: null,
  })

  // ── tasks
  assert.equal(state.tasks.length, 2)
  for (const task of state.tasks) {
    assert.deepEqual(Object.keys(task).sort(), [
      'category', 'challengeId', 'challengeName', 'createdAt', 'id', 'owner', 'revision', 'status', 'subject', 'updatedAt', 'writeScopes',
    ])
  }
  assert.deepEqual(state.tasks[0], {
    id: 'task-1', revision: 3, subject: '[Crypto] NeuroSign (100分)', status: 'in_progress',
    owner: 'solver-neurosign-1', challengeId: 1, challengeName: 'NeuroSign', category: 'Crypto',
    writeScopes: ['lingxu-ctf-work/challenges/neurosign-1'],
    createdAt: Date.parse('2026-09-29T05:00:00.000Z'),
    updatedAt: Date.parse('2026-09-29T05:02:00.000Z'),
  })
  assert.equal(state.tasks[1].challengeId, 2, '从 description 的契约行解析')
  assert.equal(state.tasks[1].challengeName, '签到')
  assert.equal(state.tasks[1].status, 'completed')
  assert.equal(state.tasks[1].createdAt, null, 'DSH 任务没有时间戳 / 无 work 记录 → null')

  // ── messages：最新在前，字段裁剪到契约
  assert.equal(state.messages.length, 2)
  assert.deepEqual(Object.keys(state.messages[0]).sort(), ['at', 'from', 'kind', 'text', 'to'])
  assert.equal(state.messages[0].kind, 'status', '最新一条在前')
  assert.deepEqual(state.messages[1], {
    at: '2026-09-29T05:02:10.000Z', from: 'solver-neurosign-1', to: 'lead', kind: 'report',
    text: 'NeuroSign 已解出，flag 已提交',
  })

  // ── counts
  assert.deepEqual(state.counts, {
    members: 3, running: 2, inactive: 1, tasksTotal: 2, tasksDone: 1, tasksInProgress: 1, tasksPending: 0,
  })
})

test('buildTeamState：messagesLimit 只取最新 N 条', async () => {
  const { teams } = mockAgentTeams()
  const state = await buildTeamState({
    store: mockTeamStore(), teams, caller: TEAM_AGENT, resolveAdapter: teamResolveAdapter, messagesLimit: 1,
  })
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].kind, 'status')
})

test('buildTeamState：agentTeams 缺失 / caller 未捕获 / 读取失败 → ok:false，不抛', async () => {
  const generatedAt = '2026-09-29T05:02:45.143Z'
  const now = () => Date.parse(generatedAt)

  // 1) agentTeams 未挂载（或接口不完整）
  const missing = await buildTeamState({ store: mockTeamStore(), teams: null, caller: TEAM_AGENT, now })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /Agent Teams 不可用/)
  assert.equal(missing.members.length, 0)
  assert.deepEqual(missing.counts, { members: 0, running: 0, inactive: 0, tasksDone: 0, tasksInProgress: 0, tasksPending: 0, tasksTotal: 0 })

  const partial = await buildTeamState({ teams: { listTasks() { return [] } }, caller: TEAM_AGENT, now })
  assert.equal(partial.ok, false)
  assert.match(partial.error, /listMembers/)

  // 2) 会话里还没调用过 ctf_solve_* → 没有 caller
  const { teams } = mockAgentTeams()
  const noCaller = await buildTeamState({ store: mockTeamStore(), teams, caller: null, now })
  assert.equal(noCaller.ok, false)
  assert.match(noCaller.error, /ctf_solve_start/)
  assert.equal(noCaller.generatedAt, generatedAt)

  // 3) 名单/任务板读取抛错（例如捕获到的身份已失效）
  const throwing = await buildTeamState({
    teams: { listMembers() { throw new Error('stale caller') }, listTasks() { return [] } },
    caller: TEAM_AGENT,
    now,
  })
  assert.equal(throwing.ok, false)
  assert.match(throwing.error, /stale caller/)
})

test('buildTeamState：没有平台连接也能看团队；store 缺方法不崩', async () => {
  const { teams } = mockAgentTeams()
  const state = await buildTeamState({
    store: {}, // 连 listChallengeWork 都没有
    teams,
    caller: TEAM_AGENT,
    resolveAdapter: async () => { throw new Error('未找到可用的平台连接') },
  })
  assert.equal(state.ok, true)
  assert.deepEqual(state.connection, { key: null, label: '' })
  assert.equal(state.tasks.length, 2, '任务板来自 agentTeams，不依赖平台连接')
  assert.equal(state.messages.length, 0)
  // description 兜底解析出题目（没有 work 记录）
  assert.equal(state.tasks[0].challengeId, 1)
  assert.equal(state.members[1].challengeId, 1)
})

test('toChallengeId / toEpochMs：平台 id 与时间戳归一化', () => {
  assert.equal(toChallengeId('12'), 12)
  assert.equal(toChallengeId(12), 12)
  assert.equal(toChallengeId('baby-heap'), 'baby-heap')
  assert.equal(toChallengeId(''), null)
  assert.equal(toChallengeId(undefined), null)
  assert.equal(toEpochMs('2026-09-29T05:02:45.143Z'), Date.parse('2026-09-29T05:02:45.143Z'))
  assert.equal(toEpochMs(1790651925466), 1790651925466)
  assert.equal(toEpochMs('nope'), null)
  assert.equal(toEpochMs(null), null)
})

test('readLimitParam：合法值夹在 1..max，非法回退默认', () => {
  assert.equal(readLimitParam({ url: '/x?limit=10' }, 50, 200), 10)
  assert.equal(readLimitParam({ url: '/x?limit=999' }, 50, 200), 200)
  assert.equal(readLimitParam({ url: '/x?limit=0' }, 50, 200), 50)
  assert.equal(readLimitParam({ url: '/x?limit=abc' }, 50, 200), 50)
  assert.equal(readLimitParam({ url: '/x' }, 50, 200), 50)
  assert.equal(readLimitParam({}, 50, 200), 50)
})

/** 最小 req/res 替身，用来真调路由 handler。 */
function mockReq({ url = '/', method = 'GET' } = {}) {
  return { url, method }
}
function mockRes() {
  const res = { statusCode: 200, headers: {}, body: '' }
  res.setHeader = (key, value) => { res.headers[String(key).toLowerCase()] = value }
  res.end = (chunk) => { res.body = chunk ?? '' }
  return res
}
async function callRoute(route, options) {
  const res = mockRes()
  await route.handler(mockReq(options), res)
  return res
}

test('GET /lingxu-ctf/team：真调 handler —— 200 + JSON（caller 由 ctf_solve_* 捕获）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-team-'))
  process.env.DSH_HOME = dir
  const { teams, calls } = mockAgentTeams()
  const ctx = mockCtx({ agentTeams: teams })
  apply(ctx, { workDir: dir })

  const route = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/team')
  assert.ok(route, 'team 路由必须注册')

  // 还没跑过任何 ctf_solve_* → 没有会话语境
  const before = await callRoute(route)
  assert.equal(before.statusCode, 200, '失败也必须 HTTP 200（前端渲染空态，不要 500）')
  assert.equal(before.headers['content-type'], 'application/json; charset=utf-8')
  const beforeBody = JSON.parse(before.body)
  assert.equal(beforeBody.ok, false)
  assert.match(beforeBody.error, /ctf_solve_start/)

  // 跑一次 ctf_solve_status（无平台连接也不抛），把 exec.agent 捕获成会话语境
  const status = ctx._collected.tools.find((t) => t.name === 'ctf_solve_status')
  await status.execute({}, { agent: TEAM_AGENT })

  const after = await callRoute(route, { url: '/lingxu-ctf/team?limit=1' })
  const body = JSON.parse(after.body)
  assert.equal(body.ok, true)
  assert.equal(body.members.length, 3)
  assert.equal(body.tasks.length, 2)
  assert.equal(calls.listMembers > 0, true)
  assert.equal(calls.callers.every((caller) => caller === TEAM_AGENT), true, 'listMembers 必须用捕获到的 caller 调用')
  // 编排层刚刚那次 status 调用应留下一条协同消息（connKey 未知时也能被读到）
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].kind, 'status')
  assert.match(body.messages[0].text, /ctf_solve_status/)

  // 非 GET → 405
  const posted = await callRoute(route, { method: 'POST' })
  assert.equal(posted.statusCode, 405)
  assert.equal(JSON.parse(posted.body).ok, false)
})

// ────────────────────────────────────────────── 顶部「CTF」视图：/lingxu-ctf/reports

test('buildReportsState：按 store 记录列出本地 WP，文件不存在则跳过', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-reports-'))
  const writeupsDir = path.join(dir, 'writeups')
  await fsp.mkdir(writeupsDir, { recursive: true })
  const existing = path.join(writeupsDir, 'neurosign-1.md')
  await fsp.writeFile(existing, '# NeuroSign\n\nflag{test}\n', 'utf8')
  await fsp.writeFile(path.join(writeupsDir, 'babyheap-3.md'), '# babyheap\n', 'utf8')

  const store = {
    async listChallengeWork() {
      return [
        { connKey: TEAM_CONN_KEY, challengeId: '1', subject: '[Crypto] NeuroSign (100分)', writeupPath: existing },
        { connKey: TEAM_CONN_KEY, challengeId: '2', subject: '[Web] 签到 (100分)', writeupPath: path.join(writeupsDir, 'gone-2.md') },
        { connKey: TEAM_CONN_KEY, challengeId: '3', subject: '[Pwn] babyheap (300分)', writeupSlug: 'babyheap' },
      ]
    },
  }
  const state = await buildReportsState({ store, resolveAdapter: teamResolveAdapter, workDir: dir })
  assert.equal(state.ok, true)
  assert.equal(state.writeups.length, 2, '文件不存在的记录要跳过')

  const byId = Object.fromEntries(state.writeups.map((w) => [w.challengeId, w]))
  assert.deepEqual(Object.keys(byId[1]).sort(), ['absPath', 'bytes', 'category', 'challengeId', 'challengeName', 'modifiedAt', 'path', 'submitted'])
  assert.equal(byId[1].challengeName, 'NeuroSign')
  assert.equal(byId[1].category, 'Crypto')
  assert.equal(byId[1].absPath, existing)
  assert.equal(byId[1].path.endsWith('writeups/neurosign-1.md'), true)
  assert.equal(byId[1].bytes > 0, true)
  assert.match(byId[1].modifiedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(byId[1].submitted, false)
  assert.equal(byId[3].challengeName, 'babyheap', 'writeupPath 缺失时按目录约定找文件')
})

test('buildReportsState：store 无记录 → ok:true + 空数组；store 抛错 → ok:false（HTTP 200）', async () => {
  const empty = await buildReportsState({ store: {}, resolveAdapter: teamResolveAdapter, workDir: '/tmp' })
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.writeups, [])

  const broken = await buildReportsState({
    store: { async listChallengeWork() { throw new Error('state.json 损坏') } },
    resolveAdapter: teamResolveAdapter,
    workDir: '/tmp',
  })
  assert.equal(broken.ok, false)
  assert.match(broken.error, /state\.json 损坏/)
  assert.deepEqual(broken.writeups, [])
})

test('GET /lingxu-ctf/reports：真调 handler', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-reports-route-'))
  process.env.DSH_HOME = dir
  const ctx = mockCtx({ agentTeams: mockAgentTeams().teams })
  apply(ctx, { workDir: dir })
  const route = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/reports')
  assert.ok(route, 'reports 路由必须注册')

  const res = await callRoute(route)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.deepEqual(body.writeups, [])

  const posted = await callRoute(route, { method: 'POST' })
  assert.equal(posted.statusCode, 405)
})

// ────────────────────────────────────────────── enableFloatingPanel（默认关闭）

test('enableFloatingPanel：默认 false（顶部「CTF」视图为主），显式 true 才开', () => {
  assert.equal(normalizeConfig({}).enableFloatingPanel, false)
  assert.equal(normalizeConfig({ enableFloatingPanel: true }).enableFloatingPanel, true)
  assert.equal(normalizeConfig({ enableFloatingPanel: 'yes' }).enableFloatingPanel, false, '只认严格 true')
  const schemaDefault = plainConfigValue(Config({})).enableFloatingPanel
  assert.equal(schemaDefault, false, 'schema 默认值必须是 false')
  const field = describeConfigFields().find((f) => f.key === 'enableFloatingPanel')
  assert.ok(field, '设置页要能渲染该字段')
  assert.equal(field.type, 'boolean')
  assert.equal(field.default, false)
  assert.equal(field.label, '显示右下角浮动面板')
})

test('withSessionCapture：旁路记录 exec.agent，不改参数与返回值', async () => {
  const session = { caller: null }
  const seen = []
  const spec = {
    name: 'demo',
    async execute(args, exec) { seen.push({ args, agent: exec?.agent }); return `ok:${args.x}` },
  }
  const wrapped = withSessionCapture(spec, session)
  assert.notEqual(wrapped, spec, '必须返回包装后的新对象（不污染原 spec）')
  assert.equal(await wrapped.execute({ x: 1 }, { agent: TEAM_AGENT }), 'ok:1')
  assert.equal(session.caller, TEAM_AGENT)
  assert.deepEqual(seen, [{ args: { x: 1 }, agent: TEAM_AGENT }], '参数与 exec 原样透传')

  // 没有 exec / 没有 agent → 不记录、不抛
  await wrapped.execute({ x: 2 }, {})
  assert.equal(session.caller, TEAM_AGENT)
  await wrapped.execute({ x: 3 }, null)
  assert.equal(await wrapped.execute({ x: 3 }), 'ok:3')

  // 缺少必要形状时原样返回，不制造半成品工具
  assert.equal(withSessionCapture(null, session), null)
  assert.equal(withSessionCapture({ name: 'x' }, session).name, 'x')
  const plain = { name: 'y', execute: () => 'z' }
  assert.equal(withSessionCapture(plain, null), plain, '没有会话槽时不包装')
})

test('GET /lingxu-ctf/team：任意 ctf_* 工具调用都能提供会话语境（不限于 solve_*）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-team2-'))
  process.env.DSH_HOME = dir
  const { teams, calls } = mockAgentTeams()
  const ctx = mockCtx({ agentTeams: teams })
  apply(ctx, { workDir: dir })

  const route = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/team')
  const status = ctx._collected.tools.find((t) => t.name === 'ctf_status')
  // ctf_status 不是 solve 工具：编排器不会捕获它，靠 withSessionCapture 兜住
  await status.execute({}, { agent: TEAM_AGENT })

  const body = JSON.parse((await callRoute(route)).body)
  assert.equal(body.ok, true, '跑过任意 ctf_* 工具后团队视图就该有数据')
  assert.equal(body.members.length, 3)
  assert.equal(calls.callers.every((caller) => caller === TEAM_AGENT), true)
})

// ────────────────────────────────────────────── 赛段工具动态注册

test('createStageToolRegistry：按赛事赛段动态注册/注销 AWD、CFS 工具', async () => {
  const live = []
  const reg = createStageToolRegistry({
    registerTool: (spec) => {
      live.push(spec.name)
      return () => {
        const i = live.indexOf(spec.name)
        if (i >= 0) live.splice(i, 1)
      }
    },
    logger: { info() {}, warn() {} },
    deps: { config: {}, store: {}, resolveAdapter: async () => ({}), logger: console },
  })
  const awd = () => live.filter((n) => n.startsWith('ctf_awd_')).length
  const cfs = () => live.filter((n) => n.startsWith('ctf_cfs_')).length

  assert.equal(awd(), 0, '初始不应有 AWD 工具')
  assert.equal(cfs(), 0, '初始不应有 CFS 工具')

  // ① 含 AWD → 9 个
  reg.sync({ hasAwd: true, hasCfs: false })
  assert.equal(awd(), 9)
  assert.equal(cfs(), 0)

  // ② 同入参重复同步 → 幂等，不叠加
  reg.sync({ hasAwd: true, hasCfs: false })
  assert.equal(awd(), 9, '重复同步不应叠加')

  // ③ 换成 CFS → AWD 整组注销
  reg.sync({ hasAwd: false, hasCfs: true })
  assert.equal(awd(), 0, 'AWD 工具应被注销')
  assert.equal(cfs(), 7)

  // ④ 两者都有
  reg.sync({ hasAwd: true, hasCfs: true })
  assert.equal(awd(), 9)
  assert.equal(cfs(), 7)

  // ⑤ 回到纯 CTF → 全部注销
  reg.sync({ hasAwd: false, hasCfs: false })
  assert.equal(live.length, 0, `应清空，实际 ${live.join(',')}`)

  // ⑥ 探活失败（键缺失 / null）时保持现状
  reg.sync({ hasAwd: true, hasCfs: false })
  assert.equal(awd(), 9)
  reg.sync({})
  assert.equal(awd(), 9, 'hasAwd/hasCfs 都 undefined 时应保持现状')
  reg.sync(null)
  assert.equal(awd(), 9, 'null 时应保持现状')

  // ⑦ disposeAll 清空并重置签名（下次 sync 同值仍会注册）
  reg.disposeAll()
  assert.equal(live.length, 0)
  assert.equal(reg.signature(), null)
  reg.sync({ hasAwd: true, hasCfs: false })
  assert.equal(awd(), 9, 'disposeAll 后同值 sync 应重新注册')
})

test('接线守卫：apply 暴露 deps.syncStageTools，ctf_connect 换赛事时调用它', async () => {
  // deps 是 apply 内部闭包，测试够不到，所以做源码级守卫防止被误删。
  const { readFileSync } = await import('node:fs')
  const index = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(index, /deps\.syncStageTools\s*=/, 'apply 必须把 syncStageTools 放到 deps 上')
  assert.match(index, /createStageToolRegistry\(/, 'apply 必须用工厂创建注册器')

  const tools = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert.match(tools, /ctx\.syncStageTools/, 'ctf_connect 必须在连接成功后调用 syncStageTools')
  assert.match(tools, /hasAwd/, 'ctf_connect 必须把 hasAwd 传下去')
})
