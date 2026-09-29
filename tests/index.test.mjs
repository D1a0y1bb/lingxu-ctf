import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply, normalizeConfig, slugify, maskFlag, injectClientScript, buildPanelState,
  name as pluginName, inject, Config, configHasCredentials, plainConfigValue,
  describeConfigFields, readJsonBody,
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

test('injectClientScript: 注入 module script 到 </body> 前', () => {
  const html = '<html><body><div id=app></div></body></html>'
  const out = injectClientScript(html, '/lingxu-ctf/client.js?rev=abc')
  assert.match(out, /<script type="module" src="\/lingxu-ctf\/client\.js\?rev=abc"><\/script>/)
  assert.equal(out.indexOf('type="module"') < out.indexOf('</body>'), true)
})

test('injectClientScript: 幂等（重复注入同一 url 不叠加）', () => {
  const html = '<body></body>'
  const once = injectClientScript(html, '/x.js?rev=1')
  const twice = injectClientScript(once, '/x.js?rev=1')
  assert.equal(once, twice)
  assert.equal(once.split('<script').length - 1, 1)
})

test('injectClientScript: 没有 </body> 时追加到末尾', () => {
  const out = injectClientScript('<div></div>', '/x.js?rev=1')
  assert.match(out, /<script type="module" src="\/x\.js\?rev=1"><\/script>$/)
})

test('injectClientScript: 不使用 __DSH_BOOT__ graph 行（0.2.0-rc.1 上是 no-op）', () => {
  const out = injectClientScript('<body></body>', '/x.js')
  assert.equal(out.includes('__DSH_BOOT__'), false)
  assert.equal(out.includes('data-dsh-client-plugin'), false)
  assert.equal(out.includes('application/json'), false)
})

test('injectClientScript: 必须带 type="module"（client.js 有顶层 export）', () => {
  // lib/client.js 是 ESM（顶层 export），若被当成 classic script 加载会直接语法错误、
  // 面板静默消失。这条断言防止有人改回 graph row / script-src 注入。
  const out = injectClientScript('<body></body>', '/lingxu-ctf/client.js?rev=deadbeef')
  assert.match(out, /<script type="module" /)
  assert.equal(out.includes('type="module"'), true)
  // 不得出现 classic script 形式（无 type 或无 src 的内联）
  assert.equal(/<script(?![^>]*type="module")[^>]*src=/.test(out), false)
})

test('injectClientScript: 注入的 url 带内容哈希 rev，改代码后浏览器不会用旧缓存', () => {
  const out = injectClientScript('<body></body>', '/lingxu-ctf/client.js?rev=abc123')
  assert.match(out, /client\.js\?rev=abc123/)
})

test('apply: 注册工具 / 提示词 / 路由 / 命令，并暴露插件身份', () => {
  const ctx = mockCtx()
  apply(ctx, { workDir: '/tmp/lingxu-test', enableWebPanel: true })

  assert.equal(pluginName, 'dsh-lingxu-ctf')
  assert.deepEqual(inject, ['tools'])

  const names = ctx._collected.tools.map((t) => t.name).sort()
  assert.equal(names.length, 13, `应注册 13 个工具，实际 ${names.length}: ${names.join(',')}`)
  for (const expected of [
    'ctf_connect', 'ctf_status', 'ctf_challenges', 'ctf_challenge', 'ctf_start_env',
    'ctf_release_env', 'ctf_submit_flag', 'ctf_leaderboard', 'ctf_theory',
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
  // client.js 路由仅在 lib/client.js 存在时注册（优雅降级）；taps 数量与之一致
  const hasBundle = routes.includes('/lingxu-ctf/client.js')
  assert.equal(ctx._collected.taps.length, hasBundle ? 1 : 0)
  assert.equal(routes.length, hasBundle ? 3 : 2)
  assert.equal(ctx._collected.commands.length, 1)
  assert.equal(ctx._collected.commands[0].name, 'ctf-status')
})

test('apply: enableWebPanel=false 时不注册路由', () => {
  const ctx = mockCtx()
  apply(ctx, { workDir: '/tmp/lingxu-test', enableWebPanel: false })
  assert.equal(ctx._collected.routes.length, 0)
  assert.equal(ctx._collected.taps.length, 0)
  assert.equal(ctx._collected.tools.length, 13, '工具不受面板开关影响')
})

test('apply: 无 agentTeams 服务时仍能加载（编排工具给出清晰报错）', () => {
  const ctx = mockCtx() // services 里没有 agentTeams
  apply(ctx, { workDir: '/tmp/lingxu-test' })
  assert.equal(ctx._collected.tools.length, 13)
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
  assert.equal(ctx._collected.tools.length, 13, '工具仍应全部注册')
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

  assert.equal(ctx._collected.tools.length, 13, '工具只依赖 tools，立即可用')
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
  assert.equal(ctx._collected.tools.length, 13)
  assert.equal(ctx._collected.sections.length, 1)
  assert.equal(ctx._collected.routes.some((r) => r.path === '/lingxu-ctf/state'), true)
})

test('apply: 工具可通过 dispose 注销', () => {
  const ctx = mockCtx()
  apply(ctx, { workDir: '/tmp/lingxu-test' })
  assert.equal(ctx._collected.tools.length, 13)
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
    'platform', 'baseUrl', 'eventId', 'cookie', 'token', 'label',
    'concurrency', 'maxWrongAttempts', 'dedupeFlags', 'workDir', 'timeoutMs', 'enableWebPanel',
  ]) {
    assert.equal(key in parsed, true, `Config 缺字段 ${key}`)
  }
  assert.equal(parsed.platform, 'lingxu')
  assert.equal(parsed.concurrency, 4)
  assert.equal(parsed.dedupeFlags, true)
  assert.equal(parsed.enableWebPanel, true)
})

test('Config schema：每个字段都标了 volatile —— 否则设置页根本不显示配置', () => {
  // dsh-settings 的 describe()：const form = volatileForm(schema); if (form === void 0) return []
  // volatileForm 只在 schema 本身或某个字段带 meta.volatile 时才返回表单。
  // 只导出 Config 不加 volatile 的表现是「插件能跑，但设置里找不到任何配置项」。
  const fields = Object.entries(Config.dict ?? {})
  assert.equal(fields.length, 12, `应有 12 个字段，实际 ${fields.length}`)
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
  assert.equal(plain.platform, 'lingxu', '未显式给的字段应拿到 schema 默认值')
  // normalizeConfig 必须自己解包，否则读到的是 {}
  const norm = normalizeConfig(parsed)
  assert.equal(norm.baseUrl, 'https://y.com')
  assert.equal(norm.eventId, 7)
  assert.equal(norm.cookie, 'sessionid=z')
  assert.equal(norm.concurrency, 6)
})

test('Config schema：cookie/token 标了 role(secret)（跨线脱敏、只写输入）', () => {
  const json = JSON.stringify(Config.toJSON())
  assert.match(json, /secret/, 'cookie/token 必须是 role(secret)，否则设置页会明文回显凭据')
})

test('configHasCredentials：凌虚需要 baseUrl + eventId + cookie', () => {
  assert.equal(configHasCredentials(normalizeConfig({})), false)
  assert.equal(configHasCredentials(normalizeConfig({ baseUrl: 'https://x.com' })), false, '缺 eventId/cookie')
  assert.equal(
    configHasCredentials(normalizeConfig({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })),
    true,
  )
  assert.equal(
    configHasCredentials(normalizeConfig({ platform: 'ctfd', baseUrl: 'https://x.com', token: 't' })),
    true,
    'CTFd 用 token 即可',
  )
})

test('normalizeConfig：新字段的边界处理', () => {
  const c = normalizeConfig({ platform: 'CTFD', baseUrl: 'https://x.com///', eventId: '4', cookie: '  a=b  ' })
  assert.equal(c.platform, 'ctfd')
  assert.equal(c.baseUrl, 'https://x.com', '去掉尾部斜杠')
  assert.equal(c.eventId, 4)
  assert.equal(c.cookie, 'a=b', '去掉首尾空白')
  assert.equal(normalizeConfig({ platform: 'nope' }).platform, 'lingxu', '非法平台回退 lingxu')
  assert.equal(normalizeConfig({ eventId: -5 }).eventId, 0)
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

test('describeConfigFields：12 个字段，含类型/说明/secret 标记/下拉选项', () => {
  const fields = describeConfigFields()
  assert.equal(fields.length, 12)
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]))

  assert.deepEqual(byKey.platform.options, ['lingxu', 'ctfd'], 'union-of-consts 应给出下拉选项')
  assert.equal(byKey.cookie.role, 'secret')
  assert.equal(byKey.token.role, 'secret')
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
