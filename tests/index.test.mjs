import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply, normalizeConfig, slugify, maskFlag, injectBootEntry, buildPanelState,
  buildTeamState, buildReportsState, readLimitParam, toChallengeId, toEpochMs, withSessionCapture,
  createSessionRegistry, sessionIdFromRequest, resolveRequestSession,
  isSameOriginConfigRequest,
  name as pluginName, inject, Config, configHasCredentials, plainConfigValue,
  describeConfigFields, normalizeConfigPatch, readJsonBody,
  createStageToolRegistry,
  pickConnection, createResolveAdapter, cookieLooksUsable, normalizeCookie, settingsHasPlatform,
  CONNECTION_ORIGIN_TEXT,
  createPanelSnapshotCache,
  instrumentStoreWrites,
  panelRevisionOf,
  PANEL_CACHE_TTL_MS,
  PANEL_PLATFORM_REFRESH_MS,
  PANEL_LOUD_COOLDOWN_MS,
  PANEL_MAX_REFRESHES_PER_MINUTE,
} from '../lib/index.js'
import { CtfStore } from '../lib/store.js'

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
  assert.equal(names.length, 17, `应注册 17 个工具，实际 ${names.length}: ${names.join(',')}`)
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
  assert.equal(routes.includes('/lingxu-ctf/theory'), true, '理论题题目概要路由必须注册（按需拉取，视图不自动全量请求）')
  assert.equal(routes.includes('/lingxu-ctf/usage'), true, 'token 用量路由必须注册（只读会话日志）')
  // client.js 路由仅在 lib/client.js 存在时注册（优雅降级）
  const hasBundle = routes.includes('/lingxu-ctf/client.js')
  // 客户端半改走官方 dsh.client 机制，**不再**注册 tapIndex
  assert.equal(ctx._collected.taps.length, 0, '不得再注册 tapIndex 注入（会被宿主权威 graph 覆盖）')
  assert.equal(routes.length, hasBundle ? 9 : 8)
  assert.equal(ctx._collected.commands.length, 1)
  assert.equal(ctx._collected.commands[0].name, 'ctf-status')
})

test('apply: enableWebPanel=false 时不注册路由', () => {
  const ctx = mockCtx()
  apply(ctx, { workDir: '/tmp/lingxu-test', enableWebPanel: false })
  assert.equal(ctx._collected.routes.length, 0)
  assert.equal(ctx._collected.taps.length, 0)
  assert.equal(ctx._collected.tools.length, 17, '工具不受面板开关影响')
})

test('apply: 无 agentTeams 服务时仍能加载（编排工具给出清晰报错）', () => {
  const ctx = mockCtx() // services 里没有 agentTeams
  apply(ctx, { workDir: '/tmp/lingxu-test' })
  assert.equal(ctx._collected.tools.length, 17)
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
  assert.equal(ctx._collected.tools.length, 17, '工具仍应全部注册')
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
  const collected = { tools: [], sections: [], routes: [], taps: [], commands: [], pending: [], injected: [], listeners: [] }
  const ctx = {
    on(event, handler) { collected.listeners.push({ event, handler }); return () => {} },
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
      on(event, handler) { collected.listeners.push({ event, handler }); return () => {} },
    }
    for (const d of deps) child[d] = available[d]
    return child
  }
  return ctx
}

test('宿主侧读 DSH tokenUsage 投影（与日志折叠对账用）', async () => {
  const { readProjectedTokenUsage } = await import('../lib/index.js')

  // 投影 = 客户端统计药丸读的同一份（sessions.list 的 projectionValues.tokenUsage）
  const sessions = {
    list: () => ({
      byId: {
        'session-a': { projectionValues: { tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 } } },
      },
    }),
  }
  assert.deepEqual(readProjectedTokenUsage(sessions, 'session-a'), {
    uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0, total: 420,
  })

  // 宿主 sessions.list() 返回 Session 实例时，投影来自 sessionProjections。
  const session = { id: 'session-a' }
  const hostSessions = { list: () => [session] }
  const projections = {
    snapshot(value, keys) {
      assert.equal(value, session)
      assert.deepEqual(keys, ['tokenUsage'])
      return { values: { tokenUsage: { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 } } }
    },
  }
  assert.deepEqual(readProjectedTokenUsage(hostSessions, 'session-a', projections), {
    uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1, total: 13,
  })
  assert.deepEqual(readProjectedTokenUsage({ get: () => session }, 'session-a', {
    stateOf: () => ({ totals: { uncachedInputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
  }), {
    uncachedInputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, total: 3,
  })

  // 拿不到投影/会话不存在/没有服务 → null（不抛错、不猜数字）
  assert.equal(readProjectedTokenUsage(sessions, 'session-b'), null)
  assert.equal(readProjectedTokenUsage(sessions, ''), null)
  assert.equal(readProjectedTokenUsage(null, 'session-a'), null)
  assert.equal(readProjectedTokenUsage({ list: () => ({ byId: { 'session-c': { projectionValues: {} } } }) }, 'session-c'), null)
  assert.equal(readProjectedTokenUsage({ list: () => { throw new Error('boom') } }, 'session-a'), null)
  // 全 0 视为无数据（不能显示 0 误导）
  assert.equal(readProjectedTokenUsage({ list: () => ({ byId: { 'session-d': { projectionValues: { tokenUsage: { uncachedInputTokens: 0, outputTokens: 0 } } } } }) }, 'session-d'), null)
})

test('端到端 —— 投递事件经只读钩子落进 store，/team 能读回 agent 间交流', async () => {
  const { CtfStore } = await import('../lib/store.js')
  const { buildTeamState } = await import('../lib/index.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  // 钩子写的是 getStore()（进程内单例，按 DSH_HOME 定位）→ 把 DSH_HOME 指到临时目录，
  // 避免测试污染用户真实状态文件（不开生产代码的测试后门）。
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'lx-hook-home-'))
  // ⚠️ 必须用 getStore() 单例：apply 内部也是它，自己 new 一个会读到过期内存态
  const { getStore: getHookStore } = await import('../lib/store.js')
  const store = getHookStore()

  const ctx = injectAwareCtx({ tools: { register: (def) => { ctx._collected.tools.push(def); return () => {} } }, webServer: {}, settings: {}, commands: {}, systemPrompt: {} })
  ctx.tools = { register: (def) => { ctx._collected.tools.push(def); return () => {} } }
  apply(ctx, { workDir: '/tmp/lingxu-hook' })
  ctx._collected_deliver('agentTeams', {
    listMembers: () => [{ name: 'solver-web-01', role: 'teammate', status: 'running', description: '解题 teammate：Web/图书馆' }],
    listTasks: () => [],
    memberName: () => 'solver-pwn-01',
  })

  // 钩子应当已订阅 session/event（在 serviceCtx 或 ctx 上）
  const listener = ctx._collected.listeners.find((item) => item.event === 'session/event')
  assert.ok(listener, 'agentTeams 就绪后必须订阅 session/event（只读观察）')

  // 模拟 DSH 投递一条 teammate 消息到目标会话
  listener.handler({ id: 'session-target', name: 'solver-pwn-01' }, {
    type: 'user/message',
    time: Date.parse('2026-09-29T06:00:00Z'),
    data: {
      source: { kind: 'team-message', teamId: 'team-1', messageId: 'team-message-e2e', senderId: 'a1', senderName: 'solver-web-01' },
      content: [{ type: 'text', text: 'Team message team-message-e2e from solver-web-01:' }, { type: 'text', text: '图书馆的凭据给你：admin:pass' }],
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const rows = await store.listTeamMessages(undefined, 50)
  assert.equal(rows.length, 1, '钩子必须把消息落盘')
  assert.equal(rows[0].kind, 'interactive')
  assert.equal(rows[0].from, 'solver-web-01')
  assert.equal(rows[0].to, 'solver-pwn-01', '收件人用会话解析出的成员名')
  assert.match(rows[0].text, /图书馆的凭据给你/)
  assert.equal(rows[0].messageId, 'team-message-e2e')

  // /team 读回（视图数据源）：能看出「谁在和谁说什么」
  // teams 缺失时 buildTeamState 会走空 payload → 这里给最小 teams 替身，走真实的数据组装路径
  const state = await buildTeamState({
    store,
    teams: { listMembers: () => [{ name: 'solver-web-01', role: 'teammate', status: 'running', description: '' }], listTasks: () => [] },
    caller: { id: 'lead' },
    resolveAdapter: null,
  })
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].kind, 'interactive')
  assert.match(state.messages[0].text, /凭据/)

  // 同一条消息重复投递（重放/冷启动）不重复入库
  listener.handler({ id: 'session-target', name: 'solver-pwn-01' }, {
    type: 'user/message',
    time: Date.parse('2026-09-29T06:00:05Z'),
    data: {
      source: { kind: 'team-message', messageId: 'team-message-e2e', senderName: 'solver-web-01' },
      content: [{ type: 'text', text: '重复投递' }],
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal((await store.listTeamMessages(undefined, 50)).length, 1, 'messageId 去重')

  // 普通用户消息绝不能进协同通信
  listener.handler({ id: 'session-target', name: 'solver-pwn-01' }, { type: 'user/message', time: Date.now(), data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '用户说的话' }] } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await store.listTeamMessages(undefined, 50)).length, 1)
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

test('apply: 用 ctx.inject 等待可选 service（生产路径）', () => {
  const ctx = injectAwareCtx({}) // 一开始什么服务都没有
  apply(ctx, { workDir: '/tmp/lingxu-test' })

  assert.equal(ctx._collected.tools.length, 17, '工具只依赖 tools，立即可用')
  assert.deepEqual(
    ctx._collected.injected.map((d) => d[0]).sort(),
    ['agentTeams', 'commands', 'connection', 'sessionProjections', 'sessionQuery', 'sessions', 'settings', 'systemPrompt', 'webServer'],
    '可选服务都应通过 ctx.inject 声明（settings=设置页回写；sessionQuery=恢复冷会话；sessions/sessionProjections=token 用量投影对账）',
  )
  assert.equal(ctx._collected.pending.length, 9, '依赖未就绪时应挂起而不是失败（含 connection / settings / sessions / sessionQuery / sessionProjections）')

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
  assert.equal(ctx._collected.pending.length, 6, '只剩 agentTeams / connection / sessions / sessionQuery / settings / sessionProjections 未就绪')

  // settings 就绪 → deps.settings 被填上（ctf_connect 要用它回写设置页）
  ctx._collected_deliver('settings', {
    describe: () => [{ ns: 'lingxu-ctf', revision: 3 }],
    update: async () => {},
  })
  assert.equal(ctx._collected.pending.length, 5, '只剩 agentTeams / connection / sessions / sessionQuery / sessionProjections 未就绪')
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
  assert.equal(ctx._collected.tools.length, 17)
  assert.equal(ctx._collected.sections.length, 1)
  assert.equal(ctx._collected.routes.some((r) => r.path === '/lingxu-ctf/state'), true)
})

test('apply: 工具可通过 dispose 注销', () => {
  const ctx = mockCtx()
  apply(ctx, { workDir: '/tmp/lingxu-test' })
  assert.equal(ctx._collected.tools.length, 17)
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

//  面板快照

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

//  插件配置（设置页表单）

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
  assert.equal(fields.length, 14, `应有 14 个字段，实际 ${fields.length}`)
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

//  模块形状（Loader 契约）

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

//  设置页配置读写接口

test('describeConfigFields：14 个字段，含中文标签/类型/说明/secret 标记', () => {
  const fields = describeConfigFields()
  assert.equal(fields.length, 14)
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

test('normalizeConfigPatch：配置路由只接受已声明字段和正确类型', () => {
  assert.deepEqual(normalizeConfigPatch({ baseUrl: 'https://x.test', eventId: 4, cookie: 'sessionid=x' }), {
    baseUrl: 'https://x.test', eventId: 4, cookie: 'sessionid=x',
  })
  assert.deepEqual(normalizeConfigPatch({ cookie: '', label: null, timeoutMs: undefined }), {})
  assert.throws(() => normalizeConfigPatch({ unknown: true }), /不支持的配置项/)
  assert.throws(() => normalizeConfigPatch({ eventId: '4' }), /有限数字/)
  assert.throws(() => normalizeConfigPatch({ enableWebPanel: 'yes' }), /布尔值/)
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

//  顶部「CTF」视图：/lingxu-ctf/team

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
  assert.deepEqual(Object.keys(state).sort(), ['connection', 'counts', 'generatedAt', 'members', 'messages', 'ok', 'runtime', 'tasks', 'tokenUsage'])

  //  members：listMembers 透传 + work/description 映射出题目
  assert.equal(state.members.length, 3)
  for (const member of state.members) {
    assert.deepEqual(
      Object.keys(member).sort(),
      ['category', 'challengeId', 'challengeName', 'currentAction', 'description', 'lastActivityAt', 'name', 'role', 'staleSeconds', 'status'],
      '成员多出 currentAction / lastActivityAt / staleSeconds —— 可显示 agent 当前动作和停滞时间',
    )
  }
  const lead = state.members[0]
  assert.deepEqual(
    { ...lead, currentAction: undefined, lastActivityAt: undefined, staleSeconds: undefined },
    {
      name: 'lead', role: 'lead', status: 'running', description: '',
      challengeId: null, challengeName: null, category: null,
      currentAction: undefined, lastActivityAt: undefined, staleSeconds: undefined,
    },
  )
  // 活动信息：lead 收到过一条团队消息 → 有 lastActivityAt 与动作描述
  assert.equal(typeof lead.lastActivityAt, 'string')
  assert.match(lead.currentAction, /消息|暂无活动记录/)
  const solver = state.members[1]
  assert.equal(solver.name, 'solver-neurosign-1')
  assert.equal(solver.role, 'teammate')
  assert.equal(solver.status, 'running', 'status 直接透传')
  assert.equal(solver.description, '解题 teammate：Crypto/NeuroSign（100分，challengeId=1）')
  assert.equal(solver.challengeId, 1, '数字 id（与平台 challenges[].id 可比）')
  assert.equal(solver.challengeName, 'NeuroSign')
  assert.equal(solver.category, 'Crypto')
  // 没有 work 记录 + 没有 description → 一律 null，不崩
  const idle = state.members[2]
  assert.deepEqual(
    { ...idle, currentAction: undefined, lastActivityAt: undefined, staleSeconds: undefined },
    {
      name: 'solver-web-2', role: 'teammate', status: 'inactive', description: '',
      challengeId: null, challengeName: null, category: null,
      currentAction: undefined, lastActivityAt: undefined, staleSeconds: undefined,
    },
  )
  // 完全没有活动记录时如实标注，不编时间
  assert.equal(idle.lastActivityAt, null)
  assert.equal(idle.currentAction, '暂无活动记录')

  //  tasks
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

  //  messages：最新在前，字段裁剪到契约
  assert.equal(state.messages.length, 2)
  assert.deepEqual(Object.keys(state.messages[0]).sort(), ['at', 'challengeId', 'from', 'kind', 'messageId', 'text', 'to'])
  assert.equal(state.messages[0].kind, 'status', '最新一条在前')
  assert.deepEqual(state.messages[1], {
    at: '2026-09-29T05:02:10.000Z', from: 'solver-neurosign-1', to: 'lead', kind: 'report',
    text: 'NeuroSign 已解出，flag 已提交', messageId: '', challengeId: null,
  })

  //  counts
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

test('buildTeamState：平台解析失败时按活动连接隔离消息', async () => {
  const { teams } = mockAgentTeams()
  const seen = []
  const store = mockTeamStore({
    async getActiveConnKey() { return TEAM_CONN_KEY },
    async listTeamMessages(connKey) {
      seen.push(connKey)
      return [{ connKey, at: '2026-09-29T05:03:00.000Z', from: 'lead', to: 'team', kind: 'status', text: '只属于当前赛事' }]
    },
  })
  const state = await buildTeamState({
    store,
    teams,
    caller: TEAM_AGENT,
    resolveAdapter: async () => { throw new Error('平台暂不可用') },
    now: () => Date.parse('2026-09-29T05:04:00.000Z'),
  })
  assert.deepEqual(seen, [TEAM_CONN_KEY])
  assert.equal(state.connection.key, TEAM_CONN_KEY)
  assert.equal(state.messages.length, 1)
  assert.equal(state.runtime.idleSeconds, 60, '活动时间使用注入时钟，测试与运行时口径一致')
})

test('buildTeamState：没有活动连接时不读取全部赛事消息', async () => {
  const { teams } = mockAgentTeams()
  const seen = []
  const state = await buildTeamState({
    store: mockTeamStore({
      async getActiveConnKey() { return null },
      async listTeamMessages(connKey) { seen.push(connKey); return [] },
    }),
    teams,
    caller: TEAM_AGENT,
    resolveAdapter: async () => { throw new Error('未配置') },
  })
  assert.equal(state.ok, true)
  assert.deepEqual(seen, ['unknown'])
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
function mockReq({ url = '/', method = 'GET', headers = {}, remoteAddress } = {}) {
  return {
    url,
    method,
    headers,
    ...(remoteAddress === undefined ? {} : { socket: { remoteAddress } }),
  }
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

test('GET /lingxu-ctf/usage：日志根目录不接受浏览器参数', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-usage-route-'))
  const attackerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-usage-attacker-'))
  const previousHome = process.env.DSH_HOME
  const sessionId = 'session-route-test'
  try {
    process.env.DSH_HOME = root
    const dir = path.join(root, 'sessions', 'workspace', sessionId)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'session.v4.jsonl'), [
      JSON.stringify({ type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 11, outputTokens: 2 } } }),
      '',
    ].join('\n'))
    const ctx = mockCtx()
    apply(ctx, {})
    const route = ctx._collected.routes.find((item) => item.path === '/lingxu-ctf/usage')
    const response = await callRoute(route, { url: `/lingxu-ctf/usage?session=${sessionId}&root=${encodeURIComponent(attackerRoot)}` })
    const body = JSON.parse(response.body)
    assert.equal(body.ok, true)
    assert.equal(body.totals.uncachedInputTokens, 11)
    assert.equal(body.totals.outputTokens, 2)
    assert.equal('file' in body, false, '普通 HTTP 用量响应不应暴露本机日志绝对路径')
    assert.equal(JSON.stringify(body).includes(attackerRoot), false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(attackerRoot, { recursive: true, force: true }).catch(() => {})
  }
})

test('GET /lingxu-ctf/usage：重启后的冷会话由 sessionQuery 精确恢复', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-cold-session-'))
  const previousHome = process.env.DSH_HOME
  const sessionId = 'session-cold-route-test'
  let disposed = 0
  const observed = []
  try {
    process.env.DSH_HOME = root
    const dir = path.join(root, 'sessions', 'workspace', sessionId)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'session.v4.jsonl'), [
      JSON.stringify({ type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 13, outputTokens: 5 } } }),
      '',
    ].join('\n'))
    const sessionQuery = {
      observeSession(id, options) {
        observed.push([id, options])
        return {
          header: { id },
          [Symbol.dispose]() { disposed += 1 },
        }
      },
    }
    const ctx = mockCtx({ sessionQuery })
    apply(ctx, {})
    const route = ctx._collected.routes.find((item) => item.path === '/lingxu-ctf/usage')
    const response = await callRoute(route, { url: `/lingxu-ctf/usage?session=${sessionId}` })
    const body = JSON.parse(response.body)
    assert.equal(body.ok, true)
    assert.equal(body.sessionId, sessionId)
    assert.equal(body.totals.uncachedInputTokens, 13)
    assert.equal(body.totals.outputTokens, 5)
    assert.deepEqual(observed, [[sessionId, { projectionMode: 'none' }]])
    assert.equal(disposed, 1, '只读 session 观察必须释放租约')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

//  顶部「CTF」视图：/lingxu-ctf/reports

test('buildReportsState：按 store 记录列出本地 WP，文件不存在则跳过', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-reports-'))
  const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-reports-outside-'))
  const writeupsDir = path.join(dir, 'writeups')
  await fsp.mkdir(writeupsDir, { recursive: true })
  const existing = path.join(writeupsDir, 'neurosign-1.md')
  const outside = path.join(outsideDir, 'secret.md')
  await fsp.writeFile(existing, '# NeuroSign\n\nflag{test}\n', 'utf8')
  await fsp.writeFile(path.join(writeupsDir, 'babyheap-3.md'), '# babyheap\n', 'utf8')
  await fsp.writeFile(outside, 'should not be exposed\n', 'utf8')
  const linked = path.join(writeupsDir, 'linked-5.md')
  let hasSymlink = true
  try { await fsp.symlink(outside, linked) } catch { hasSymlink = false }

  const store = {
    async listChallengeWork() {
      return [
        { connKey: TEAM_CONN_KEY, challengeId: '1', subject: '[Crypto] NeuroSign (100分)', writeupPath: existing },
        { connKey: TEAM_CONN_KEY, challengeId: '2', subject: '[Web] 签到 (100分)', writeupPath: path.join(writeupsDir, 'gone-2.md') },
        { connKey: TEAM_CONN_KEY, challengeId: '3', subject: '[Pwn] babyheap (300分)', writeupSlug: 'babyheap' },
        { connKey: TEAM_CONN_KEY, challengeId: '4', subject: '[Misc] 外部路径 (10分)', writeupPath: outside },
        ...(hasSymlink ? [{ connKey: TEAM_CONN_KEY, challengeId: '5', subject: '[Web] 符号链接 (10分)', writeupPath: linked }] : []),
      ]
    },
  }
  const state = await buildReportsState({ store, resolveAdapter: teamResolveAdapter, workDir: dir })
  assert.equal(state.ok, true)
  assert.equal(state.writeups.length, 2, '文件不存在的记录要跳过')

  const byId = Object.fromEntries(state.writeups.map((w) => [w.challengeId, w]))
  assert.deepEqual(Object.keys(byId[1]).sort(), ['absPath', 'bodyChars', 'bodyPreview', 'bytes', 'category', 'challengeId', 'challengeName', 'modifiedAt', 'path', 'submitted'])
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

test('buildReportsState：绑定 session 时只读取对应赛事，不能回退全量', async () => {
  const seen = []
  const state = await buildReportsState({
    store: {
      async listChallengeWork(connKey) {
        seen.push(connKey)
        return []
      },
    },
    resolveAdapter: async () => { throw new Error('不应在已绑定 session 时走全局连接') },
    workDir: '/tmp',
    sessionContext: { sessionId: 'session-a', connKey: TEAM_CONN_KEY },
  })
  assert.equal(state.ok, true)
  assert.deepEqual(seen, [TEAM_CONN_KEY])
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

test('session 路由：未知 session 不读取 reports/theory 的全局数据', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-session-routes-'))
  process.env.DSH_HOME = dir
  const ctx = mockCtx()
  apply(ctx, { workDir: dir })
  const reports = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/reports')
  const theory = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/theory')

  const reportsResponse = await callRoute(reports, { url: '/lingxu-ctf/reports?session=does-not-exist' })
  const reportsBody = JSON.parse(reportsResponse.body)
  assert.equal(reportsBody.ok, false)
  assert.deepEqual(reportsBody.writeups, [])

  const theoryResponse = await callRoute(theory, { url: '/lingxu-ctf/theory?session=does-not-exist&testId=4' })
  const theoryBody = JSON.parse(theoryResponse.body)
  assert.equal(theoryBody.ok, false)
  assert.deepEqual(theoryBody.questions, [])
})

//  enableFloatingPanel（默认关闭）

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

test('withSessionCapture：旁路记录 caller 和 session id，不改参数与返回值', async () => {
  const session = { caller: null, sessionId: '' }
  const seen = []
  const spec = {
    name: 'demo',
    async execute(args, exec) { seen.push({ args, agent: exec?.agent }); return `ok:${args.x}` },
  }
  const wrapped = withSessionCapture(spec, session)
  assert.notEqual(wrapped, spec, '必须返回包装后的新对象（不污染原 spec）')
  assert.equal(await wrapped.execute({ x: 1 }, { agent: TEAM_AGENT, sessionId: 'session-real' }), 'ok:1')
  assert.equal(session.caller, TEAM_AGENT)
  assert.equal(session.sessionId, 'session-real')
  assert.deepEqual(seen, [{ args: { x: 1 }, agent: TEAM_AGENT }], '参数与 exec 原样透传')

  // 没有 exec / 没有 agent → 不记录、不抛
  await wrapped.execute({ x: 2 }, {})
  assert.equal(session.caller, TEAM_AGENT)
  assert.equal(session.sessionId, 'session-real')
  await wrapped.execute({ x: 3 }, null)
  assert.equal(await wrapped.execute({ x: 3 }), 'ok:3')

  // 缺少必要形状时原样返回，不制造半成品工具
  assert.equal(withSessionCapture(null, session), null)
  assert.equal(withSessionCapture({ name: 'x' }, session).name, 'x')
  const plain = { name: 'y', execute: () => 'z' }
  assert.equal(withSessionCapture(plain, null), plain, '没有会话槽时不包装')
})

test('createSessionRegistry：并发 session 的 caller/connKey 不串线，显式未知 session 不回退', async () => {
  let clock = Date.parse('2026-09-30T00:00:00Z')
  const registry = createSessionRegistry({ now: () => clock, ttlMs: 1000, maxContexts: 4 })
  const callerA = { id: 'agent-a' }
  const callerB = { id: 'agent-b' }
  const contextA = registry.capture({ sessionId: 'session-a', agent: callerA, connKey: 'conn-a', eventId: 'evt-a' }, {})
  const contextB = registry.capture({ sessionId: 'session-b', agent: callerB, connKey: 'conn-b', eventId: 'evt-b' }, {})
  assert.equal(sessionIdFromRequest({ headers: { 'x-dsh-session-id': 'session-a' } }), 'session-a')
  assert.equal(resolveRequestSession(registry, { url: '/x?session=session-a' }, { require: true }).context, contextA)
  assert.equal(resolveRequestSession(registry, { url: '/x?session=missing' }, { require: true }).ok, false)
  assert.equal(resolveRequestSession(registry, { url: '/x' }, { require: true }).ok, false, '多个 session 不应猜最近一个')

  const observed = []
  await Promise.all([
    registry.run(contextA, async () => {
      await new Promise((resolve) => setTimeout(resolve, 8))
      observed.push([registry.sessionId, registry.caller, registry.connKey])
    }),
    registry.run(contextB, async () => {
      observed.push([registry.sessionId, registry.caller, registry.connKey])
    }),
  ])
  observed.sort((left, right) => left[0].localeCompare(right[0]))
  assert.deepEqual(observed[0], ['session-a', callerA, 'conn-a'])
  assert.deepEqual(observed[1], ['session-b', callerB, 'conn-b'])

  clock += 1001
  assert.equal(registry.get('session-a'), null, '超过 TTL 的会话要回收')
  assert.equal(registry.get('session-b'), null, '超过 TTL 的会话要回收')
  registry.dispose()
})

test('配置写入：跨站 Origin / Fetch Metadata 被拒绝，无头本机调用保持兼容', () => {
  assert.equal(isSameOriginConfigRequest({ headers: { origin: 'http://localhost:3000', host: 'localhost:3000' } }), true)
  assert.equal(isSameOriginConfigRequest({ headers: { origin: 'https://evil.example', host: 'localhost:3000' } }), false)
  assert.equal(isSameOriginConfigRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isSameOriginConfigRequest({ headers: {} }), true)
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

//  赛段工具动态注册

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
  reg.sync({ hasAwd: null, hasCfs: null })
  assert.equal(awd(), 9, '显式 unknown 也应保持现状')
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

//  连接解析：设置页 vs 本地连接

test('cookieLooksUsable：脱敏占位符不能当 Cookie 用（否则平台一直 403）', () => {
  assert.equal(cookieLooksUsable('sessionid=abc; csrftoken=x'), true)
  assert.equal(cookieLooksUsable('***'), false)
  assert.equal(cookieLooksUsable('sessionid=***'), false, 'dsh-settings 给远程调用者的脱敏值')
  assert.equal(cookieLooksUsable(''), false)
  assert.equal(cookieLooksUsable(null), false)
  assert.equal(cookieLooksUsable('  '), false)
})

test('pickConnection：设置页 eventId=7 + 本地还存着 event 4 → **用 7**（复现用户报的 bug）', () => {
  const settings = { key: 'lingxu:host:8000:7', baseUrl: 'https://host:8000', eventId: 7, cookie: 'sessionid=new' }
  const stored = { key: 'lingxu:host:8000:4', baseUrl: 'https://host:8000', eventId: 4, cookie: 'sessionid=old' }

  const picked = pickConnection({ settings, stored })
  assert.equal(picked.connection.eventId, 7, '设置页是用户明确声明，必须压过历史遗留的 store 记录')
  assert.equal(picked.connection.key, 'lingxu:host:8000:7')
  assert.equal(picked.origin, 'settings')
  assert.equal(picked.connection.originText, CONNECTION_ORIGIN_TEXT.settings)
  assert.ok(picked.mismatch, '不一致时要能提示用户')
  assert.equal(picked.mismatch.settingsKey, 'lingxu:host:8000:7')
  assert.equal(picked.mismatch.storeKey, 'lingxu:host:8000:4')
  assert.deepEqual(picked.mismatch.fields, ['eventId'])
})

test('pickConnection：只有设置页 / 只有 store / 都没有', () => {
  const settings = { key: 'k7', baseUrl: 'https://h:8000', eventId: 7, cookie: 'sessionid=x' }
  const stored = { key: 'k4', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=y' }

  // 回归：只填设置页、从不 ctf_connect 的老用户
  const onlySettings = pickConnection({ settings })
  assert.equal(onlySettings.connection.eventId, 7)
  assert.equal(onlySettings.origin, 'settings')
  assert.equal(onlySettings.mismatch, null)

  const onlyStore = pickConnection({ stored })
  assert.equal(onlyStore.connection.eventId, 4)
  assert.equal(onlyStore.origin, 'store')
  assert.equal(onlyStore.connection.originText, CONNECTION_ORIGIN_TEXT.store)

  assert.equal(pickConnection({}), null, '两个来源都没有 → 调用方报错')
})

test('pickConnection：显式参数最优先；显式 key 等于设置页那条时也用设置页', () => {
  const settings = { key: 'lingxu:h:8000:7', baseUrl: 'https://h:8000', eventId: 7, cookie: 'sessionid=s' }
  const stored = { key: 'lingxu:h:8000:4', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=t' }
  const requested = { key: 'lingxu:h:8000:4' }
  const explicitMatch = { ...stored }

  const byArgs = pickConnection({ requested, explicitMatch, settings, stored })
  assert.equal(byArgs.connection.key, 'lingxu:h:8000:4', '显式参数必须赢过设置页')
  assert.equal(byArgs.origin, 'args')

  // 显式 key 正好是设置页那条（store 里没有）→ 用设置页
  const settingsOnly = pickConnection({ requested: { key: 'lingxu:h:8000:7' }, settings, stored })
  assert.equal(settingsOnly.connection.eventId, 7)
  assert.equal(settingsOnly.origin, 'args')

  // 显式指定了一个谁都没有的 key → null（调用方报错，绝不静默换平台）
  assert.equal(pickConnection({ requested: { key: 'nope' }, settings, stored }), null)
})

test('pickConnection：Cookie 取值（设置页不存 secret → 用同 key 本地连接的 Cookie）', () => {
  const settings = { key: 'lingxu:h:8000:7', baseUrl: 'https://h:8000', eventId: 7, cookie: '' }
  const stored = { key: 'lingxu:h:8000:4', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=old' }
  const storedById = {
    'lingxu:h:8000:7': { key: 'lingxu:h:8000:7', cookie: 'sessionid=from-store-7' },
    'lingxu:h:8000:4': stored,
  }

  const picked = pickConnection({
    settings, stored,
    getStoredByKey: (key) => storedById[key] ?? null,
  })
  assert.equal(picked.connection.eventId, 7, '赛事仍按设置页')
  assert.equal(picked.connection.cookie, 'sessionid=from-store-7', 'Cookie 用同 key 的本地连接（ctf_connect 存过）')
  assert.match(picked.cookieFrom, /本地连接 lingxu:h:8000:7/)

  // 设置页自己有 Cookie → 用设置页的
  const own = pickConnection({ settings: { ...settings, cookie: 'sessionid=own' }, stored, getStoredByKey: () => null })
  assert.equal(own.connection.cookie, 'sessionid=own')
  assert.equal(own.cookieFrom, '设置页')
})

test('pickConnection：ctf_connect 连过但设置页回写失败 → 以本次连接为准（避免"刚连就被旧设置页压掉"）', () => {
  const settings = { key: 'lingxu:h:8000:4', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=settings' }
  const stored = {
    key: 'lingxu:h:8000:7', baseUrl: 'https://h:8000', eventId: 7, cookie: 'sessionid=connected',
    settingsSync: 'failed',
  }
  const picked = pickConnection({ settings, stored })
  assert.equal(picked.connection.eventId, 7)
  assert.equal(picked.origin, 'store')
  assert.ok(picked.mismatch)

  // 回写成功（settingsSync='ok'）时反过来：以设置页为准
  const ok = pickConnection({ settings, stored: { ...stored, settingsSync: 'ok' } })
  assert.equal(ok.connection.eventId, 4)
  assert.equal(ok.origin, 'settings')
})

test('createResolveAdapter：真实 store + 设置页配置 → 解析到设置页的赛事，并带上来源/差异', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-resolve-'))
  const store = new CtfStore({ dir, now: () => Date.parse('2026-09-29T02:00:00Z') })
  // 历史遗留：store 里只有 event 4（用户上次 ctf_connect 的）
  await store.upsertConnection({
    platform: 'lingxu', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=old', label: '数信杯测试赛',
  })
  const seen = []
  const resolveAdapter = createResolveAdapter({
    store,
    config: { baseUrl: 'https://h:8000', eventId: 7, cookie: 'sessionid=new', label: '数信杯 Agent 测试赛', timeoutMs: 30000 },
    createAdapter: (connection) => { seen.push(connection); return { marker: 'adapter' } },
  })

  const { adapter, connection, connKey } = await resolveAdapter({})
  assert.equal(connection.eventId, 7, '设置页改成 7 必须立刻生效')
  assert.equal(connection.label, '数信杯 Agent 测试赛')
  assert.equal(connKey, 'lingxu:h:8000:7')
  assert.equal(seen[0].eventId, 7, '适配器就是用这条连接造的')
  assert.equal(seen[0].timeoutMs, 30000, 'config.timeoutMs 要透传给适配器')
  assert.equal(connection.origin, 'settings')
  assert.equal(connection.mismatch.storeKey, 'lingxu:h:8000:4')

  // 显式参数仍然最优先
  const explicit = await resolveAdapter({ connection: 'lingxu:h:8000:4' })
  assert.equal(explicit.connection.eventId, 4)
  assert.equal(explicit.connection.origin, 'args')

  // 显式指定不存在的连接 → 报错（不静默换平台）
  await assert.rejects(() => resolveAdapter({ connection: 'lingxu:h:8000:99' }), /未找到匹配的连接/)

  // 回归：老用户（store 无连接、只填设置页）
  const freshStore = new CtfStore({ dir: await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-resolve2-')) })
  const onlySettings = createResolveAdapter({
    store: freshStore,
    config: { baseUrl: 'https://h:8000', eventId: 7, cookie: 'sessionid=new' },
    createAdapter: () => ({ marker: 'adapter' }),
  })
  const resolved = await onlySettings({})
  assert.equal(resolved.connection.eventId, 7)
  assert.equal(resolved.connection.origin, 'settings')

  // 脱敏 Cookie（设置页显示 ***）不能当凭据用 → 退回本地连接
  const redacted = createResolveAdapter({
    store,
    config: { baseUrl: 'https://h:8000', eventId: 4, cookie: '***' },
    createAdapter: () => ({ marker: 'adapter' }),
  })
  const fallback = await redacted({})
  // 设置页仍然声明平台/赛事（origin=settings），只是 Cookie 取同 key 的本地连接
  assert.equal(fallback.connection.cookie, 'sessionid=old', '脱敏 Cookie 时用本地已存连接')
  assert.equal(fallback.connection.origin, 'settings')
  assert.equal(fallback.connection.cookieFrom, '本地连接 lingxu:h:8000:4')
})

test('createResolveAdapter：设置页改了 eventId → **立刻生效**（不重启、不需要 reload）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-live-'))
  const store = new CtfStore({ dir })
  await store.upsertConnection({
    platform: 'lingxu', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=old',
  })
  // Cordis 的 config 是响应式对象：改设置页 = 就地改这些字段（rawConfig 读的是同一个对象）
  const rawConfig = { baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=settings', label: '旧的' }
  const config = normalizeConfig(rawConfig)
  const resolveAdapter = createResolveAdapter({
    store, config, rawConfig, createAdapter: () => ({ marker: 'adapter' }),
  })

  assert.equal((await resolveAdapter({})).connection.eventId, 4, '一开始设置页也是 4（与 store 一致）')

  // 用户在设置页把 eventId 改成 7
  rawConfig.eventId = 7
  rawConfig.label = '数信杯 Agent 测试赛'
  const after = await resolveAdapter({})
  assert.equal(after.connection.eventId, 7, '改设置页后必须立刻用 7，无需重启 DSH')
  assert.equal(after.connection.label, '数信杯 Agent 测试赛')
  assert.equal(after.connection.key, 'lingxu:h:8000:7')

  // 归一化：设置页 baseUrl 带尾斜杠不影响 key 与「是否不一致」的判断
  rawConfig.baseUrl = 'https://h:8000/'
  const normalized = await resolveAdapter({})
  assert.equal(normalized.connection.key, 'lingxu:h:8000:7')
})

test('回归：设置页活配置必须拆 volatile 包装（否则 eventId 变 {} → 切赛事后一片空白）', async () => {
  // 真实事故：settingsSnapshot() 直接读 rawConfig[field]，而 Config 字段全是 .volatile() 包装，
  // 于是 baseUrl 变成 "[object Object]"、eventId 变成 {}，拿去请求平台必然失败 →
  // 面板显示「剩余 已结束」+「暂无题目数据」。这里钉住拆包行为。
  const { createResolveAdapter, plainConfigValue } = await import('../lib/index.js')

  const vol = (v) => ({ get: () => v })   // volatile 包装的典型形态
  const rawConfig = {
    baseUrl: vol('https://example.com:8000'),
    eventId: vol(7),
    cookie: vol('sessionid=abc123'),
    label: vol('测试赛事'),
  }
  const store = {
    resolveConnection: async () => null,
    listConnections: async () => [],
    getConnectionByKey: async () => null,
    getActiveConnection: async () => null,
  }
  let seen = null
  const resolve = createResolveAdapter({
    store,
    config: { baseUrl: '', eventId: 0, cookie: '', label: '' }, // 快照是空的，逼它必须读活配置
    rawConfig,
    createAdapter: (conn) => { seen = conn; return { ping: async () => true } },
    logger: { info() {}, warn() {} },
  })

  const out = await resolve({})
  assert.equal(out.connection.eventId, 7, 'eventId 必须是数字 7，不能是 {}')
  assert.equal(out.connection.baseUrl, 'https://example.com:8000', 'baseUrl 不能是 [object Object]')
  assert.doesNotMatch(String(out.connection.key), /object Object/, '连接 key 里不得出现 [object Object]')
  assert.equal(seen?.eventId, 7, '传给适配器的 eventId 必须是 7')

  // 拆包工具本身的契约
  assert.equal(plainConfigValue(vol(7)), 7)
  assert.deepEqual(plainConfigValue({ a: vol(1), b: vol('x') }), { a: 1, b: 'x' })
})

//  Cookie 是平台级的

test('设置页 eventId=7 + 设置页无 cookie + store 只有 …:4（cookie 可用）→ 用 7 且 cookie 来自 …:4', () => {
  // 用户真实现场：设置页写了 event 7，但 store 里只有上次 ctf_connect 的 event 4 连接，
  // 且设置页的 cookie 拿不到真值（DSH 对非 owner 读是空/脱敏）→ 旧实现会「无可用 Cookie」→ 403 未登录 → 空数据。
  const settings = { key: 'lingxu:h:8000:7', baseUrl: 'https://h:8000', eventId: 7, cookie: '' }
  const stored4 = {
    key: 'lingxu:h:8000:4', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=realsession',
    updatedAt: '2026-09-29T01:00:00.000Z',
  }
  const picked = pickConnection({
    settings,
    stored: stored4,
    getStoredByKey: (key) => (key === stored4.key ? stored4 : null),
    listStored: () => [stored4],
  })
  assert.equal(picked.connection.eventId, 7, '赛事按设置页')
  assert.equal(picked.connection.cookie, 'sessionid=realsession', 'Cookie 是平台级的 → 复用同平台连接的 cookie')
  assert.equal(picked.cookieFrom, '同平台连接 lingxu:h:8000:4')
  assert.equal(picked.origin, 'settings')
})

test('Cookie 取值顺序：同 key 优先于同平台回退；跨 baseUrl 绝不复用', () => {
  const settings = { key: 'lingxu:h:8000:7', baseUrl: 'https://h:8000', eventId: 7, cookie: '' }
  const byKey = { key: 'lingxu:h:8000:7', baseUrl: 'https://h:8000', eventId: 7, cookie: 'sessionid=bykey' }
  const other = { key: 'lingxu:h:8000:4', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=other' }
  const otherHost = { key: 'lingxu:evil:8000:7', baseUrl: 'https://evil:8000', eventId: 7, cookie: 'sessionid=evil' }

  // ① 同 key 有可用 cookie → 用它（不被同平台回退抢走）
  const sameKey = pickConnection({
    settings, stored: other,
    getStoredByKey: (key) => (key === byKey.key ? byKey : null),
    listStored: () => [other, byKey],
  })
  assert.equal(sameKey.connection.cookie, 'sessionid=bykey')
  assert.equal(sameKey.cookieFrom, '本地连接 lingxu:h:8000:7')

  // ③ 只有别的平台的连接 → 不得复用（凭据不通用）
  const crossHost = pickConnection({
    settings, stored: null, getStoredByKey: () => null, listStored: () => [otherHost],
  })
  assert.equal(crossHost.connection.cookie, '', '跨 baseUrl 不能复用 cookie')
  assert.equal(crossHost.cookieFrom, '（无可用 Cookie）')
})

test('Cookie 取值：尾斜杠视为同平台；同平台多条时取 updatedAt 最新的一条', () => {
  const settings = { key: 'lingxu:h:8000:7', baseUrl: 'https://h:8000', eventId: 7, cookie: '' }
  const older = {
    key: 'lingxu:h:8000:3', baseUrl: 'https://h:8000/', eventId: 3, cookie: 'sessionid=old',
    updatedAt: '2026-09-28T01:00:00.000Z',
  }
  const newer = {
    key: 'lingxu:h:8000:4', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=new',
    updatedAt: '2026-09-29T01:00:00.000Z',
  }
  const picked = pickConnection({ settings, stored: null, getStoredByKey: () => null, listStored: () => [older, newer] })
  assert.equal(picked.connection.cookie, 'sessionid=new', '取最近更新的连接（登录最新鲜）')
  assert.match(picked.cookieFrom, /同平台连接 lingxu:h:8000:4/)
  assert.equal(picked.connection.baseUrl, 'https://h:8000', '尾斜杠差异算同平台（归一化比较）')
})

test('normalizeCookie：设置页存的是裸 sessionid 值 → 补 sessionid= 前缀（实测 32 字符串就是 sessionid）', () => {
  assert.equal(normalizeCookie('7mlmrl83xe0tihxxxxxxxxxxxxxxxxxx'), 'sessionid=7mlmrl83xe0tihxxxxxxxxxxxxxxxxxx')
  assert.equal(normalizeCookie('sessionid=abc; csrftoken=x'), 'sessionid=abc; csrftoken=x', '完整 Cookie 串原样')
  assert.equal(normalizeCookie('  '), '')
  assert.equal(normalizeCookie(null), '')

  // 设置页只有裸 token 时也能用（② 这条路是通的 —— 实测补前缀后平台返回 200）
  const settings = { key: 'lingxu:h:8000:7', baseUrl: 'https://h:8000', eventId: 7, cookie: 'baretoken123' }
  const picked = pickConnection({ settings, stored: null, getStoredByKey: () => null, listStored: () => [] })
  assert.equal(picked.connection.cookie, 'sessionid=baretoken123')
  assert.equal(picked.cookieFrom, '设置页')
})

test('Cookie 取值：全都没有 → 「无可用 Cookie」，并且不把脱敏值当真值', () => {
  const settings = { key: 'lingxu:h:8000:7', baseUrl: 'https://h:8000', eventId: 7, cookie: '***' }
  const redactedStore = { key: 'lingxu:h:8000:4', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=***' }
  const picked = pickConnection({
    settings, stored: redactedStore,
    getStoredByKey: () => redactedStore, listStored: () => [redactedStore],
  })
  assert.equal(picked.cookieFrom, '（无可用 Cookie）')
  assert.equal(cookieLooksUsable(picked.connection.cookie), false)
})

test('createResolveAdapter：同平台 cookie 回退走真实 store（切赛事不再 403）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-cookie-'))
  const store = new CtfStore({ dir, now: () => Date.parse('2026-09-29T02:00:00Z') })
  // store 里只有旧赛事（event 4）的连接
  await store.upsertConnection({
    platform: 'lingxu', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=platform-level', label: '旧赛事',
  })
  const seen = []
  const resolveAdapter = createResolveAdapter({
    store,
    // 设置页：eventId=7，但 cookie 为空（DSH 不给真值）
    config: { baseUrl: 'https://h:8000', eventId: 7, cookie: '', label: '数信杯 Agent 测试赛' },
    createAdapter: (connection) => { seen.push(connection); return { marker: 'adapter' } },
  })
  const { connection } = await resolveAdapter({})
  assert.equal(connection.eventId, 7)
  assert.equal(connection.cookie, 'sessionid=platform-level', 'Cookie 来自同平台的 store 连接')
  assert.equal(connection.cookieFrom, '同平台连接 lingxu:h:8000:4')
  assert.equal(seen[0].cookie, 'sessionid=platform-level', '适配器真的拿到了可用 cookie')
})

//  面板缓存 / 单飞 / 写入穿透
// 背景：悬浮面板 + CTF 视图各自 5s 轮询，每次快照打 6 次平台 → ~140 请求/分钟
// → 平台把会话打爆（403「未登录」）→ 全队掉线。

test('createPanelSnapshotCache：TTL 内命中缓存，过期后重新拉取（minRefreshMs=0 的纯 TTL 语义）', async () => {
  let nowMs = 1_000_000
  let loads = 0
  const cache = createPanelSnapshotCache({ ttlMs: 4000, minRefreshMs: 0, now: () => nowMs })
  const loader = async () => { loads += 1; return { ok: true, n: loads } }

  const first = await cache.load('k', loader, 'w0')
  assert.equal(first.fromCache, false)
  assert.equal(first.shared, false)
  assert.equal(typeof first.cachedAt, 'string')
  assert.equal(loads, 1)

  nowMs += 1000 // TTL 内
  const second = await cache.load('k', loader, 'w0')
  assert.equal(loads, 1, 'TTL 内不得再打平台')
  assert.equal(second.fromCache, true)
  assert.equal(second.cachedAt, first.cachedAt)

  nowMs += 4000 // 超过 TTL
  const third = await cache.load('k', loader, 'w0')
  assert.equal(loads, 2, '过期后必须重新拉取')
  assert.equal(third.fromCache, false)
  assert.equal(cache.stats.hits, 1)
  assert.equal(cache.stats.misses, 2)
})

test('createPanelSnapshotCache：单飞 —— 并发 5 个请求只打一次平台', async () => {
  let loads = 0
  const cache = createPanelSnapshotCache({ ttlMs: 4000 })
  const loader = async () => {
    loads += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { ok: true, n: loads }
  }
  const results = await Promise.all(Array.from({ length: 5 }, () => cache.load('same-key', loader, 'w0')))
  assert.equal(loads, 1, '并发请求必须共享同一次平台拉取')
  assert.equal(cache.stats.shared, 4, '后到 4 个标记为 shared')
  assert.equal(results[0].shared, false)
  assert.equal(results[1].shared, true)
  assert.ok(results.every((r) => r.n === 1))
})

test('createPanelSnapshotCache：刷新下限 —— TTL 过期但未到下限时给 stale 数据，不打平台', async () => {
  let nowMs = 0
  let loads = 0
  const cache = createPanelSnapshotCache({ ttlMs: 4000, minRefreshMs: 15000, now: () => nowMs })
  const loader = async () => { loads += 1; return { ok: true, n: loads } }

  await cache.load('k', loader, 'w0')
  assert.equal(loads, 1)

  nowMs = 5000 // 刚过 TTL，但远没到 15s 刷新下限
  const stale = await cache.load('k', loader, 'w0')
  assert.equal(loads, 1, '刷新下限内不得打平台')
  assert.equal(stale.fromCache, true)
  assert.equal(stale.stale, true, '必须如实标记「这是旧数据」')

  nowMs = 15001 // 到下限
  const fresh = await cache.load('k', loader, 'w0')
  assert.equal(loads, 2, '到刷新下限后必须重新拉取')
  assert.equal(fresh.fromCache, false)
  assert.equal(fresh.stale, false)
  assert.equal(cache.stats.staleHits, 1)
})

test('createPanelSnapshotCache：loud 写操作穿透刷新下限（交 flag 面板马上变），且受 5s 冷却约束', async () => {
  let nowMs = 0
  let loads = 0
  const cache = createPanelSnapshotCache({
    ttlMs: 4000,
    minRefreshMs: 60_000,
    loudCooldownMs: 5000,
    now: () => nowMs,
  })
  const loader = async () => { loads += 1; return { ok: true, n: loads } }

  await cache.load('k', loader, 'w0', { loudRevision: 0 })
  nowMs = 5000

  // 普通写入（agent 的 work 记录更新）：只标脏，不打平台
  const quiet = await cache.load('k', loader, 'w1', { loudRevision: 0 })
  assert.equal(loads, 1, '普通写入不穿透（否则 8 个 agent 会把平台打爆）')
  assert.equal(quiet.stale, true)

  // 用户可见写入（ctf_submit_flag / ctf_connect）：立即穿透
  const loud = await cache.load('k', loader, 'w2', { loudRevision: 1 })
  assert.equal(loads, 2, 'loud 写操作必须立即重新拉取')
  assert.equal(loud.fromCache, false)
  assert.equal(loud.stale, false)
  assert.equal(cache.stats.loudRefreshes, 1)

  // 冷却期内再来一次 loud：不重复打平台（把放大上限压住）
  nowMs = 6000
  const burst = await cache.load('k', loader, 'w3', { loudRevision: 2 })
  assert.equal(loads, 2, '5s 冷却内的连续 loud 不得再打平台')
  assert.equal(burst.stale, true)

  // 冷却过后恢复立即穿透
  nowMs = 11000
  await cache.load('k', loader, 'w4', { loudRevision: 3 })
  assert.equal(loads, 3, '冷却结束后 loud 可再次穿透')
})

test('createPanelSnapshotCache：每分钟刷新硬上限（数学上保证 ≤30 次平台请求/分钟）', async () => {
  let nowMs = 0
  let loads = 0
  const cache = createPanelSnapshotCache({
    ttlMs: 0,
    minRefreshMs: 0,
    loudCooldownMs: 0,
    maxRefreshesPerMinute: 4,
    now: () => nowMs,
  })
  const loader = async () => { loads += 1; return { ok: true, n: loads } }

  // 疯狂轮询 60 秒：每 1 秒一次，共 60 次
  for (let t = 0; t < 60_000; t += 1000) {
    nowMs = t
    await cache.load('k', loader, 'w0')
  }
  assert.equal(loads, 4, `一圈最多 4 次刷新（=24 次 HTTP），实测 ${loads}`)
  assert.equal(cache.refreshesInWindow(59_000), 4)
  assert.ok(cache.stats.budgetBlocked >= 50, '其余请求被预算挡住并拿到 stale')

  // 滚出窗口后额度恢复
  nowMs = 61_000
  await cache.load('k', loader, 'w0')
  assert.equal(loads, 5, '窗口滚动后恢复刷新')
})

test('PANEL_PLATFORM_REFRESH_MS / PANEL_LOUD_COOLDOWN_MS / PANEL_MAX_REFRESHES_PER_MINUTE：流量与响应性的折中值', () => {
  // 单快照 = 6 次平台请求；20s 下限 → 纯轮询 ≤24 次/分钟（验收要求 ≤30）
  assert.ok(PANEL_PLATFORM_REFRESH_MS >= 15000, `实测 ${PANEL_PLATFORM_REFRESH_MS}`)
  assert.ok(PANEL_LOUD_COOLDOWN_MS >= 1000 && PANEL_LOUD_COOLDOWN_MS <= 10000, `实测 ${PANEL_LOUD_COOLDOWN_MS}`)
  // 4 次刷新 × 6 次 HTTP = 24 ≤ 30（留出边界余量）
  assert.ok(PANEL_MAX_REFRESHES_PER_MINUTE * 6 <= 30, `实测 ${PANEL_MAX_REFRESHES_PER_MINUTE}`)
})

test('instrumentStoreWrites：原地包装 save()，幂等且不改对象身份', async () => {
  const store = new CtfStore({ dir: await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-probe-')) })
  const originalSave = store.save
  const probe = instrumentStoreWrites(store)
  assert.equal(probe.instrumented, true)
  assert.notEqual(store.save, originalSave, '包装了 save')
  assert.equal(instrumentStoreWrites(store), probe, '重复调用返回同一探针（幂等）')

  const before = probe.revision
  await store.save()
  assert.equal(probe.revision, before + 1, '每次 save 自增')
  assert.equal(panelRevisionOf(store, probe), `w${probe.revision}`)

  // 没有 save() 的替身：退化为 updatedAt 指纹，不抛错
  const fake = { state: { updatedAt: 'T1' } }
  const fakeProbe = instrumentStoreWrites(fake)
  assert.equal(fakeProbe.instrumented, false)
  assert.equal(panelRevisionOf(fake, fakeProbe), 'tT1')
})

/** 面板快照用的平台 mock：按路径返回最小可用数据，并统计请求次数。 */
function panelFetchMock({ delayMs = 0 } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const raw = String(url)
    const json0 = (body) => ({
      status: 200,
      ok: true,
      async text() { return JSON.stringify(body) },
      async json() { return body },
      async arrayBuffer() { return new ArrayBuffer(0) },
    })
    // 别的用例/插件后台遗留的调用（例如真实平台连接）不归本 mock 管，也不计入统计
    if (!raw.startsWith('https://panel.test:8000')) return json0({})
    const pathname = raw.replace('https://panel.test:8000', '')
    calls.push(pathname)
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    const json = (body) => ({
      status: 200,
      ok: true,
      async text() { return JSON.stringify(body) },
      async json() { return body },
      async arrayBuffer() { return new ArrayBuffer(0) },
    })
    if (pathname === '/event/4/info/') {
      return json({ status: 0, start_seconds: 0, end_seconds: 3600, user: { username: 'xiyi', number: 'lx_1' }, test_type: { 2: { name: 'CTF', size: 1 } }, punish: false })
    }
    if (pathname === '/event/4/') return json({ name: '面板缓存测试赛', start_time: 'a', end_time: 'b' })
    if (pathname.startsWith('/event/4/ctf/') && pathname.includes('?')) {
      return json({ count: 1, next: null, results: [{ id: 1, name: 'A', classify: 'Web', score: 100, is_parse: false, parse_count: 0, is_begin: false }] })
    }
    if (pathname.startsWith('/event/4/ctf/') && pathname.endsWith('/flag/')) return json({ status: 1 })
    if (pathname.startsWith('/event/4/user/rank/')) {
      return json({ count: 1, results: [{ id: 2, username: 'xiyi', score: 0, ctf_score: 0, test_score: 0, parse_count: 0, is_self: true }] })
    }
    if (pathname === '/event/4/test/') return json([])
    if (pathname.startsWith('/event/4/ctf/')) return json({ count: 0, next: null, results: [] })
    return json({})
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('GET /lingxu-ctf/state：TTL 缓存 + 单飞（并发 5 个请求只打一次平台）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-panel-'))
  process.env.DSH_HOME = dir
  // 给平台响应加 5ms 延迟：让 5 个并发请求真的**重叠**，才能验证单飞（否则它们会串行命中 TTL 缓存）
  const platform = panelFetchMock({ delayMs: 5 })
  const ctx = mockCtx()
  try {
    apply(ctx, { baseUrl: 'https://panel.test:8000', eventId: 4, cookie: 'sessionid=panel-test', workDir: dir })
    const route = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/state')
    assert.ok(route, 'state 路由必须注册')

    const responses = await Promise.all(Array.from({ length: 5 }, () => callRoute(route, { url: '/lingxu-ctf/state' })))
    const payloads = responses.map((r) => JSON.parse(r.body))
    const platformCalls = platform.calls.length
    assert.ok(platformCalls > 0, '首次必须真打平台')
    assert.ok(platformCalls <= 8, `5 个并发请求只应打一次平台快照（≤8 次 HTTP），实测 ${platformCalls}`)
    const owners = payloads.filter((p) => p.fromCache === false && p.shared === false)
    const joined = payloads.filter((p) => p.shared === true)
    assert.equal(owners.length, 1, '只有一个是真正的拉取者')
    assert.equal(joined.length, 4, '后到 4 个共享同一次拉取（单飞）')
    assert.ok(payloads.every((p) => typeof p.cachedAt === 'string'))

    // TTL 内的第二次：完全命中缓存，不再打平台
    const again = JSON.parse((await callRoute(route, { url: '/lingxu-ctf/state' })).body)
    assert.equal(platform.calls.length, platformCalls, 'TTL 内不得再打平台')
    assert.equal(again.fromCache, true)
  } finally {
    platform.restore()
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('缓存穿透：写操作（ctf_submit_flag 落审计）后，面板必须重新拉取', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-panel-w-'))
  process.env.DSH_HOME = dir
  const platform = panelFetchMock()
  const ctx = mockCtx()
  try {
    apply(ctx, { baseUrl: 'https://panel.test:8000', eventId: 4, cookie: 'sessionid=panel-test', workDir: dir })
    const route = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/state')
    await callRoute(route, { url: '/lingxu-ctf/state' })
    const afterFirst = platform.calls.length

    // TTL 内直接命中
    const cached = JSON.parse((await callRoute(route, { url: '/lingxu-ctf/state' })).body)
    assert.equal(cached.fromCache, true)
    assert.equal(platform.calls.length, afterFirst)

    // 真调 ctf_submit_flag（走真实 store.recordSubmission → save → revision 自增）
    const submit = ctx._collected.tools.find((t) => t.name === 'ctf_submit_flag')
    const submitText = await submit.execute({ id: 1, flag: 'flag{panel-cache}' }, {})
    assert.match(submitText, /flag 正确/)

    const refreshed = JSON.parse((await callRoute(route, { url: '/lingxu-ctf/state' })).body)
    assert.equal(refreshed.fromCache, false, '写操作后不得返回旧缓存')
    assert.ok(platform.calls.length > afterFirst, '写操作后必须重新拉平台')
  } finally {
    platform.restore()
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('GET /lingxu-ctf/diag：暴露限流与面板缓存计数', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-diag-'))
  process.env.DSH_HOME = dir
  const platform = panelFetchMock()
  const ctx = mockCtx()
  try {
    apply(ctx, { baseUrl: 'https://panel.test:8000', eventId: 4, cookie: 'sessionid=panel-test', workDir: dir })
    const state = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/state')
    await callRoute(state, { url: '/lingxu-ctf/state' })

    const diagRes = await callRoute(ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/diag'), { url: '/lingxu-ctf/diag' })
    const body = JSON.parse(diagRes.body)
    assert.equal(body.ok, true)
    assert.ok(Array.isArray(body.rateLimit), 'diag.rateLimit 应是数组')
    const entry = body.rateLimit.find((row) => row.host === 'https://panel.test:8000')
    assert.ok(entry, '应有该 host 的限流计数')
    assert.ok(entry.sent >= 1, '已发出请求数')
    assert.equal(typeof entry.queued, 'number')
    assert.equal(typeof entry.inFlight, 'number')
    assert.ok(body.panelCache && typeof body.panelCache === 'object')
    assert.ok(body.panelCache.misses >= 1, '至少一次未命中')
    assert.equal(typeof body.panelCache.ttlMs, 'number')
  } finally {
    platform.restore()
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('面板路由复用 DSH Host Connection 认证，未认证不能访问 /diag', async () => {
  const connection = {
    admit(req) {
      return req.headers?.cookie === 'dsh-auth=ok' ? { peer: {} } : { rejection: 401 }
    },
  }
  const ctx = mockCtx({ connection })
  apply(ctx, { workDir: '/tmp/lingxu-diag-auth' })
  const route = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/diag')
  const unauthorized = await callRoute(route)
  assert.equal(unauthorized.statusCode, 401)
  assert.equal(unauthorized.body, 'unauthorized')
  const authorized = await callRoute(route, { headers: { cookie: 'dsh-auth=ok' } })
  assert.equal(authorized.statusCode, 200)
  assert.equal(JSON.parse(authorized.body).ok, true)
})

test('没有 DSH Connection 服务时，旧宿主的面板路由拒绝非 loopback 请求', async () => {
  const ctx = mockCtx()
  apply(ctx, { workDir: '/tmp/lingxu-diag-loopback' })
  const route = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/diag')
  const remote = await callRoute(route, { remoteAddress: '192.0.2.10' })
  assert.equal(remote.statusCode, 403)
  assert.equal(remote.body, 'forbidden')
  const local = await callRoute(route, { remoteAddress: '127.0.0.1' })
  assert.equal(local.statusCode, 200)
  assert.equal(JSON.parse(local.body).ok, true)
})

test('Connection 认证器返回异常形状时，面板路由按失败关闭', async () => {
  const ctx = mockCtx({ connection: { admit: () => undefined } })
  apply(ctx, { workDir: '/tmp/lingxu-diag-auth-shape' })
  const route = ctx._collected.routes.find((r) => r.path === '/lingxu-ctf/diag')
  const response = await callRoute(route)
  assert.equal(response.statusCode, 401)
  assert.equal(response.body, 'unauthorized')
})

test('PANEL_CACHE_TTL_MS：略小于前端 5 秒轮询', () => {
  assert.ok(PANEL_CACHE_TTL_MS >= 3000 && PANEL_CACHE_TTL_MS <= 5000, `实测 ${PANEL_CACHE_TTL_MS}`)
})
