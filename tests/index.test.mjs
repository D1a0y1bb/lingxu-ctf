import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, normalizeConfig, slugify, maskFlag, injectClientScript, buildPanelState, name as pluginName, inject } from '../lib/index.js'

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
  // client.js 路由仅在 lib/client.js 存在时注册（优雅降级）；taps 数量与之一致
  const hasBundle = routes.includes('/lingxu-ctf/client.js')
  assert.equal(ctx._collected.taps.length, hasBundle ? 1 : 0)
  assert.equal(routes.length, hasBundle ? 2 : 1)
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

test('apply: workDir 未配置时回退到 process.cwd()，且不读 ctx.agent 之外的东西', () => {
  const ctx = strictCordisCtx({ agent: { session: { header: { cwd: '/tmp/from-agent' } } } })
  assert.doesNotThrow(() => apply(ctx, {}))
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
