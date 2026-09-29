/**
 * lib/tools.js 单元测试（node:test，零依赖）。
 *
 * 运行：
 *   "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
 *     --test tests/tools.test.mjs
 *
 * 全部使用 mock deps：mock 适配器 + 真实 CtfStore（写到临时目录），不触网。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildToolSpecs, TOOL_NAMES, SESSION_EXPIRED_TEXT } from '../lib/tools.js'
import { CtfStore } from '../lib/store.js'
import { createOrchestrator, pathSlug } from '../lib/orchestrate.js'
import { slugify as indexPathSlug } from '../lib/index.js'
import { LingxuError, LINGXU_CODES } from '../lib/lingxu.js'

const tmpDirs = []
after(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true })
})

async function makeTmpDir(prefix = 'lingxu-tools-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

async function makeStore() {
  const dir = await makeTmpDir('lingxu-store-')
  return new CtfStore({ dir, now: () => Date.parse('2026-09-29T01:00:00Z') })
}

const CONNECTION = {
  key: 'lingxu:example.com:8000:4',
  platform: 'lingxu',
  baseUrl: 'https://example.com:8000',
  eventId: 4,
  cookie: 'sessionid=abcdef0123456789; csrftoken=csrf-token-value',
}

/** mock 适配器：所有调用记录到 calls，便于断言「有没有真的请求平台」。 */
function createAdapter(overrides = {}) {
  const calls = []
  const base = {
    validate: async () => ({
      ok: true,
      user: { username: 'alice', id: 7, number: 42 },
      event: null,
      warnings: [],
    }),
    eventSummary: async () => ({
      name: '凌虚测试赛',
      organizer: '测试主办方',
      startTime: '2026-09-29T00:00:00Z',
      endTime: '2026-09-30T00:00:00Z',
      status: 2,
      labels: [],
      user: { username: 'alice' },
      punish: false,
      testTypes: { 1: '理论题', 2: '实操题' },
      remainingSeconds: 7200,
    }),
    challenges: async () => [
      { id: 101, name: 'Web 签到', category: 'Web', score: 100, solved: true, parseCount: 23, begun: true },
      { id: 102, name: 'Pwn 栈溢出', category: 'Pwn', score: 300, solved: false, parseCount: 5, begun: false },
      { id: 103, name: 'Crypto RSA', category: 'Crypto', score: 200, solved: false, parseCount: 9, begun: true },
    ],
    challengeDetail: async (id) => ({
      id: Number(id),
      name: 'Pwn 栈溢出',
      descriptionHtml: '<h1>题面</h1><p>nc 靶机</p>',
      description: '# 题面\nnc 靶机',
      attachment: 'https://example.com:8000/media/x/pwn.zip',
      attachments: [],
      score: 300,
      solves: 5,
      taskType: 1,
      answerMode: 1,
      requiresEnv: true,
      connectionInfo: '',
      checkMode: false,
      raw: {},
    }),
    startEnvironment: async () => ({
      connectionInfo: 'nc 1.2.3.4 9999',
      targets: ['nc 1.2.3.4 9999'],
      hasPrivateOnly: false,
    }),
    releaseEnvironment: async () => ({ released: true }),
    submitFlag: async (id, flag) =>
      flag === 'flag{ok}'
        ? { status: 'correct', message: '回答正确', flag }
        : { status: 'incorrect', message: 'flag错误', flag },
    leaderboard: async (kind) => ({
      kind,
      total: 3,
      rows: [
        { rank: 1, id: 1, username: 'bob', score: 1200, ctfScore: 900, testScore: 300, awdScore: 0, solved: 5, firstBloods: 1, isSelf: false },
        { rank: 2, id: 2, username: 'alice', score: 900, ctfScore: 600, testScore: 300, awdScore: 0, solved: 4, firstBloods: 0, isSelf: true },
        { rank: 3, id: 3, username: 'carol', score: 300, ctfScore: 300, testScore: 0, awdScore: 0, solved: 2, firstBloods: 0, isSelf: false },
      ],
    }),
    myRank: async () => ({
      rank: 2,
      total: 3,
      self: { username: 'alice', score: 900, ctfScore: 600, testScore: 300, solved: 4 },
      board: null,
    }),
    theoryTests: async () => [
      { id: 1, name: '信息安全理论', types: [1], score: 60, count: 20, timeSeconds: 1800, isBegin: true, isEnd: false, parseCount: 3 },
    ],
    beginTheoryTest: async () => ({ started: true, status: 1 }),
    theoryQuestions: async () => [
      {
        index: 1,
        id: 501,
        title: '以下哪项属于对称加密算法？',
        options: [
          { key: 'A', text: 'RSA' },
          { key: 'B', text: 'AES' },
        ],
        userOption: null,
      },
    ],
    theoryTime: async () => ({ name: '信息安全理论', seconds: 300 }),
    answerTheory: async () => ({ ok: true, message: 'ok' }),
    finishTheory: async () => ({ ok: true, message: '交卷成功' }),
    downloadAttachment: async (_url, dest) => {
      await fsp.writeFile(dest, 'zipdata')
      return { path: dest, bytes: 7 }
    },
  }

  const adapter = { id: overrides.id || 'lingxu', calls }
  const impl = { ...base, ...overrides }
  for (const [method, fn] of Object.entries(impl)) {
    if (method === 'id' || typeof fn !== 'function') {
      adapter[method] = fn
      continue
    }
    adapter[method] = async (...args) => {
      calls.push({ method, args })
      return fn(...args)
    }
  }
  return adapter
}

function createHarness({ adapter = createAdapter(), store, config = {}, deps = {} } = {}) {
  const specs = buildToolSpecs({
    config: {
      concurrency: 4,
      maxWrongAttempts: 0,
      dedupeFlags: true,
      timeoutMs: 30000,
      ...config,
    },
    store,
    resolveAdapter: async () => ({ adapter, connection: CONNECTION }),
    createAdapter: () => adapter,
    logger: { info() {}, warn() {}, error() {} },
    now: () => Date.parse('2026-09-29T01:00:00Z'),
    ...deps,
  })
  const tools = Object.fromEntries(specs.map((spec) => [spec.name, spec]))
  return { specs, tools, adapter }
}

const callsOf = (adapter, method) => adapter.calls.filter((call) => call.method === method)

// ------------------------------------------------------------------ 规格形状

test('导出 13 个工具规格，名字与 TOOL_NAMES 一致且形状符合 defineTool 契约', () => {
  const { specs, tools } = createHarness()
  assert.equal(specs.length, 13)
  assert.equal(TOOL_NAMES.length, 13)
  assert.deepEqual(specs.map((spec) => spec.name), TOOL_NAMES)
  assert.deepEqual(Object.keys(tools).sort(), [...TOOL_NAMES].sort())
  for (const spec of specs) {
    assert.equal(typeof spec.description, 'string', `${spec.name} description`)
    assert.ok(spec.description.length > 30, `${spec.name} description 太短`)
    assert.equal(typeof spec.execute, 'function', `${spec.name} execute`)
    assert.ok(spec.parameters && typeof spec.parameters === 'object', `${spec.name} parameters`)
    assert.deepEqual(spec.output.schema, { type: 'string' }, `${spec.name} output.schema`)
    assert.deepEqual(spec.output.render({}, '文本'), [{ type: 'text', text: '文本' }])
    assert.deepEqual(spec.output.render({}, { a: 1 }), [{ type: 'text', text: '{\n  "a": 1\n}' }])
  }
})

test('buildToolSpecs() 无 deps 也能构造全部规格（执行时才需要依赖）', () => {
  assert.equal(buildToolSpecs().length, 13)
  assert.equal(buildToolSpecs({}).length, 13)
})

// ------------------------------------------------------------------ 连接解析失败

test('连接解析失败：读取类工具返回带 ctf_connect 指引的错误文本（不抛异常）', async () => {
  const specs = buildToolSpecs({
    config: {},
    resolveAdapter: async () => {
      throw new Error('没有活动连接')
    },
    logger: {},
    now: Date.now,
  })
  const tools = Object.fromEntries(specs.map((spec) => [spec.name, spec]))
  const out = await tools.ctf_status.execute({})
  assert.match(out, /^❌/)
  assert.match(out, /ctf_connect/)
  assert.match(out, /没有活动连接/)
})

test('resolveAdapter 未注入时也不崩，返回装配错误文本', async () => {
  const specs = buildToolSpecs({})
  const tools = Object.fromEntries(specs.map((spec) => [spec.name, spec]))
  const out = await tools.ctf_challenges.execute({})
  assert.match(out, /^❌/)
  assert.match(out, /resolveAdapter/)
})

test('提交类工具在连接解析失败时抛硬失败', async () => {
  const specs = buildToolSpecs({
    config: {},
    resolveAdapter: async () => {
      throw new Error('没有活动连接')
    },
    logger: {},
    now: Date.now,
  })
  const tools = Object.fromEntries(specs.map((spec) => [spec.name, spec]))
  await assert.rejects(tools.ctf_submit_flag.execute({ id: 101, flag: 'flag{x}' }), /ctf_connect/)
})

test('平台调用抛错时读取类工具转成可读错误文本', async () => {
  const adapter = createAdapter({
    challenges: async () => {
      throw new Error('凌虚 GET /event/4/ctf/ HTTP 500')
    },
  })
  const { tools } = createHarness({ adapter })
  const out = await tools.ctf_challenges.execute({})
  assert.match(out, /^❌/)
  assert.match(out, /HTTP 500/)
})

// ------------------------------------------------------------------ ctf_connect

test('ctf_connect 成功：校验、持久化、脱敏、警告', async () => {
  const store = await makeStore()
  const adapter = createAdapter()
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_connect.execute({
    baseUrl: 'https://example.com:8000/',
    eventId: 4,
    cookie: CONNECTION.cookie,
    label: '测试赛',
  })
  assert.match(out, /✅ 已连接凌虚赛事平台/)
  assert.match(out, /alice/)
  assert.match(out, /凌虚测试赛/)
  assert.match(out, /全自动提交已开启/)
  assert.ok(!out.includes(CONNECTION.cookie), '不能输出完整 cookie')
  assert.ok(!out.includes('csrf-token-value'), '不能输出 cookie 片段')

  assert.equal(callsOf(adapter, 'validate').length, 1)
  const connections = await store.listConnections()
  assert.equal(connections.length, 1)
  assert.equal(connections[0].eventId, 4)
  assert.equal(connections[0].baseUrl, 'https://example.com:8000')
  assert.equal(connections[0].label, '测试赛')
  assert.equal(await store.resolveConnection({}).then((c) => c.key), connections[0].key)
})

test('ctf_connect：punish=true 时给出扣分警告', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    eventSummary: async () => ({ name: '扣分赛', user: { username: 'alice' }, punish: true, remainingSeconds: 0 }),
  })
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_connect.execute({
    baseUrl: 'https://example.com:8000',
    eventId: 4,
    cookie: CONNECTION.cookie,
  })
  assert.match(out, /punish=true/)
})

test('ctf_connect 参数校验：缺 baseUrl / 协议 / eventId / sessionid / 平台', async () => {
  const { tools } = createHarness()
  assert.match(await tools.ctf_connect.execute({}), /缺少平台地址 baseUrl/)
  assert.match(
    await tools.ctf_connect.execute({ baseUrl: 'example.com:8000', eventId: 4, cookie: 'sessionid=x' }),
    /必须是完整地址/,
  )
  assert.match(
    await tools.ctf_connect.execute({ baseUrl: 'https://example.com:8000', cookie: 'sessionid=x' }),
    /必须提供 eventId/,
  )
  assert.match(
    await tools.ctf_connect.execute({ baseUrl: 'https://example.com:8000', eventId: 4, cookie: 'foo=bar' }),
    /缺少 sessionid/,
  )
  assert.match(
    await tools.ctf_connect.execute({ baseUrl: 'https://example.com:8000', eventId: 'abc', cookie: 'sessionid=x' }),
    /eventId 必须是正整数/,
  )
})

test('ctf_connect：参数表不含 platform（只支持凌虚）', () => {
  const { tools } = createHarness()
  assert.deepEqual(Object.keys(tools.ctf_connect.parameters), ['baseUrl', 'eventId', 'cookie', 'label'])
  assert.ok(!('platform' in tools.ctf_connect.parameters), 'platform 参数应已移除')
  assert.ok(!('token' in tools.ctf_connect.parameters), 'token 参数（CTFd 专用）应已移除')
  assert.match(tools.ctf_connect.description, /凌虚/)
  // 即使调用方硬塞 platform/token，也不会被采纳（参数校验不拒绝未声明字段，工具应忽略它们）
  assert.match(tools.ctf_connect.description, /^配置并校验凌虚赛事平台连接/)
})

test('ctf_connect：平台校验失败时返回排查指引', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    validate: async () => {
      throw new Error('凌虚 GET /event/4/info/ HTTP 403')
    },
  })
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_connect.execute({
    baseUrl: 'https://example.com:8000',
    eventId: 4,
    cookie: 'sessionid=deadbeef',
  })
  assert.match(out, /^❌ 连接校验失败/)
  assert.match(out, /排查顺序/)
  assert.equal((await store.listConnections()).length, 0)
})

test('ctf_connect：store 写入失败只警告，不掩盖连接成功', async () => {
  const adapter = createAdapter()
  const { tools } = createHarness({
    adapter,
    store: {
      upsertConnection: async () => {
        throw new Error('磁盘只读')
      },
    },
  })
  const out = await tools.ctf_connect.execute({
    baseUrl: 'https://example.com:8000',
    eventId: 4,
    cookie: 'sessionid=x',
  })
  assert.match(out, /✅ 已连接/)
  assert.match(out, /写入本地状态失败/)
})

// ------------------------------------------------------------------ ctf_status

test('ctf_status：统计题目/分类/排名/理论题', async () => {
  const { tools } = createHarness()
  const out = await tools.ctf_status.execute({})
  assert.match(out, /📊 赛事总览 — 凌虚测试赛/)
  assert.match(out, /共 3 题｜已解 1｜待解 2｜完成度 33\.3%/)
  assert.match(out, /已得 100 \/ 总分 600/)
  assert.match(out, /Web: 1\/1 已解（\+100）/)
  assert.match(out, /我的排名: 第 2 名 \/ 共 3/)
  assert.match(out, /理论题: 共 1 套/)
  assert.match(out, /ctf_theory action=questions testId=1/)
})

test('ctf_status：myRank 失败不影响主输出', async () => {
  const adapter = createAdapter({
    myRank: async () => {
      throw new Error('排行榜接口 500')
    },
  })
  const { tools } = createHarness({ adapter })
  const out = await tools.ctf_status.execute({})
  assert.match(out, /📊 赛事总览/)
  assert.match(out, /平台未提供/)
})

// ------------------------------------------------------------------ ctf_challenges

test('ctf_challenges：默认全量 + 表格', async () => {
  const { tools } = createHarness()
  const out = await tools.ctf_challenges.execute({})
  assert.match(out, /共 3 题（已解 1 \/ 待解 2）/)
  assert.match(out, /\| id \| 名称 \| 分类 \| 分值 \| 状态 \| 解题数 \|/)
  assert.match(out, /Web 签到/)
  assert.match(out, /⬜ 未开始/)
})

test('ctf_challenges：solved/category/minScore/limit 过滤', async () => {
  const { tools } = createHarness()
  const unsolved = await tools.ctf_challenges.execute({ solved: false })
  assert.match(unsolved, /仅待解/)
  assert.ok(!unsolved.includes('Web 签到'))

  const web = await tools.ctf_challenges.execute({ category: 'web' })
  assert.match(web, /命中 1 题/)
  assert.match(web, /Web 签到/)

  const minScore = await tools.ctf_challenges.execute({ minScore: 200 })
  assert.match(minScore, /命中 2 题/)
  assert.ok(!minScore.includes('Web 签到'))

  const limited = await tools.ctf_challenges.execute({ limit: 1 })
  assert.match(limited, /显示 1 题/)
  assert.match(limited, /还有 2 题未显示/)
})

test('ctf_challenges：无命中时给出明确说明', async () => {
  const { tools } = createHarness()
  const out = await tools.ctf_challenges.execute({ category: 'Blockchain' })
  assert.match(out, /没有符合条件的题目/)
})

// ------------------------------------------------------------------ ctf_challenge

test('ctf_challenge：下载附件 + 写 metadata.json + 不含凭据', async () => {
  const workDir = await makeTmpDir()
  const adapter = createAdapter()
  const { tools } = createHarness({ adapter, config: { workDir } })
  const out = await tools.ctf_challenge.execute({ id: 102 })

  assert.match(out, /🧩 题目详情 #102 — Pwn 栈溢出/)
  assert.match(out, /需要环境: 是/)
  assert.match(out, /# 题面/)
  assert.match(out, /ctf_start_env id=102/)

  const challengeRoot = path.join(workDir, 'challenges')
  const dirs = await fsp.readdir(challengeRoot)
  assert.equal(dirs.length, 1)
  assert.equal(dirs[0], 'pwn-栈溢出-102')

  const files = await fsp.readdir(path.join(challengeRoot, dirs[0], 'distfiles'))
  assert.deepEqual(files, ['pwn.zip'])
  assert.equal(await fsp.readFile(path.join(challengeRoot, dirs[0], 'distfiles', 'pwn.zip'), 'utf8'), 'zipdata')

  const metadata = JSON.parse(await fsp.readFile(path.join(challengeRoot, dirs[0], 'metadata.json'), 'utf8'))
  assert.equal(metadata.id, 102)
  assert.equal(metadata.requiresEnv, true)
  assert.equal(metadata.connection.key, CONNECTION.key)
  assert.ok(!JSON.stringify(metadata).includes('sessionid'), 'metadata 不能包含 cookie')
  assert.ok(out.includes(path.join(challengeRoot, dirs[0], 'distfiles', 'pwn.zip')))
})

test('ctf_challenge：download=false 时不落盘附件', async () => {
  const workDir = await makeTmpDir()
  const { tools } = createHarness({ config: { workDir } })
  const out = await tools.ctf_challenge.execute({ id: 102, download: false })
  assert.match(out, /未下载，download=false/)
  const dirs = await fsp.readdir(path.join(workDir, 'challenges'))
  const distfiles = await fsp.readdir(path.join(workDir, 'challenges', dirs[0])).catch(() => [])
  assert.ok(!distfiles.includes('distfiles'))
})

test('ctf_challenge：凌虚适配器使用相对路径下载附件', async () => {
  const workDir = await makeTmpDir()
  const adapter = createAdapter()
  adapter.client = { url: (p) => `https://example.com:8000${p}` }
  const { tools } = createHarness({ adapter, config: { workDir } })
  await tools.ctf_challenge.execute({ id: 102 })
  const downloads = callsOf(adapter, 'downloadAttachment')
  assert.equal(downloads.length, 1)
  assert.equal(downloads[0].args[0], '/media/x/pwn.zip')
})

test('ctf_challenge：附件下载失败只警告，题面照常返回', async () => {
  const workDir = await makeTmpDir()
  const adapter = createAdapter({
    downloadAttachment: async () => {
      throw new Error('附件 404')
    },
  })
  const { tools } = createHarness({ adapter, config: { workDir } })
  const out = await tools.ctf_challenge.execute({ id: 102 })
  assert.match(out, /附件下载失败/)
  assert.match(out, /# 题面/)
})

test('ctf_challenge：缺 id / 平台报错都返回文本', async () => {
  const { tools } = createHarness()
  assert.match(await tools.ctf_challenge.execute({}), /缺少题目 id/)
  const adapter = createAdapter({
    challengeDetail: async () => {
      throw new Error('题目不存在')
    },
  })
  const broken = createHarness({ adapter, config: { workDir: os.tmpdir() } })
  assert.match(await broken.tools.ctf_challenge.execute({ id: 999 }), /^❌.*题目不存在/)
})

test('ctf_challenge：附件目录名与编排层 pathSlug / index.slugify 同规则', async () => {
  // 编排层把 `challenges/<pathSlug>-<id>` 当作 solver 的工作目录写进 writeScope；
  // ctf_challenge 必须落在同一个目录，否则 solver 被指到没有附件的目录。
  const trickyNames = [
    'Baby Heap!',
    'AIoT固件加密服务',
    'Web 签到 (2)',
    'Pwn/栈溢出',
    'café ☕ CTF',
    'a'.repeat(80),
  ]
  for (const name of trickyNames) {
    const workDir = await makeTmpDir()
    const adapter = createAdapter({
      challengeDetail: async (id) => ({
        id: Number(id),
        name,
        description: '题面',
        attachment: 'https://example.com:8000/media/x/f.zip',
        attachments: [],
        requiresEnv: false,
        connectionInfo: '',
        checkMode: false,
        raw: {},
      }),
    })
    const { tools } = createHarness({ adapter, config: { workDir } })
    await tools.ctf_challenge.execute({ id: 12 })
    const dirs = await fsp.readdir(path.join(workDir, 'challenges'))
    assert.equal(dirs.length, 1, `${name} 应生成 1 个目录`)
    assert.equal(dirs[0], `${pathSlug(name, 12)}-12`, `目录名要与 orchestrate.pathSlug 一致：${name}`)
    assert.equal(dirs[0], `${indexPathSlug(name)}-12`, `目录名要与 index.slugify 一致：${name}`)
  }
})

// ------------------------------------------------------------------ 环境

test('ctf_start_env：返回连接信息并记录环境状态', async () => {
  const store = await makeStore()
  const { tools } = createHarness({ store })
  const out = await tools.ctf_start_env.execute({ id: 102 })
  assert.match(out, /🚀 环境已就绪 — 题目 #102/)
  assert.match(out, /nc 1\.2\.3\.4 9999/)
  const work = await store.getChallengeWork(CONNECTION.key, '102')
  assert.deepEqual(work.env.targets, ['nc 1.2.3.4 9999'])
  assert.equal(work.env.released, false)
  // 跨模块契约：orchestrate.stop 读顶层 envStarted/connectionInfo，writeup 读 envStartedAt/connectionInfo
  assert.equal(work.envStarted, true)
  assert.equal(work.envReleased, false)
  assert.equal(work.connectionInfo, 'nc 1.2.3.4 9999')
  assert.equal(typeof work.envStartedAt, 'string')
  assert.equal(work.requiresEnv, true)
})

test('ctf_start_env：只有内网地址时警告', async () => {
  const adapter = createAdapter({
    startEnvironment: async () => ({
      connectionInfo: 'nc 192.168.1.5 9999',
      targets: ['nc 192.168.1.5 9999'],
      hasPrivateOnly: true,
    }),
  })
  const { tools } = createHarness({ adapter })
  const out = await tools.ctf_start_env.execute({ id: 102 })
  assert.match(out, /只返回了内网地址/)
})

test('ctf_start_env：缺 id 与平台错误', async () => {
  const { tools } = createHarness()
  assert.match(await tools.ctf_start_env.execute({}), /缺少题目 id/)
  const adapter = createAdapter({
    startEnvironment: async () => {
      throw new Error('启动环境失败：配额不足')
    },
  })
  const broken = createHarness({ adapter })
  assert.match(await broken.tools.ctf_start_env.execute({ id: 102 }), /配额不足/)
})

test('ctf_release_env：正常 / 幂等 / 不支持', async () => {
  const store = await makeStore()
  const { tools } = createHarness({ store })
  assert.match(await tools.ctf_release_env.execute({ id: 102 }), /已释放题目 #102 的环境/)
  const work = await store.getChallengeWork(CONNECTION.key, '102')
  assert.equal(work.env.released, true)
  assert.equal(work.envReleased, true, 'orchestrate.stop 读顶层 envReleased')
  assert.equal(work.envStarted, false)
  assert.equal(typeof work.envReleasedAt, 'string')

  const idempotent = createHarness({ adapter: createAdapter({ releaseEnvironment: async () => ({ released: true, idempotent: true }) }) })
  assert.match(await idempotent.tools.ctf_release_env.execute({ id: 102 }), /幂等/)

  const unsupported = createHarness({ adapter: createAdapter({ releaseEnvironment: async () => ({ released: false, unsupported: true }) }) })
  assert.match(await unsupported.tools.ctf_release_env.execute({ id: 102 }), /不支持自动释放/)
})

// ------------------------------------------------------------------ 提交 flag

test('ctf_submit_flag：dedupeFlags 命中时直接返回 already_submitted，不请求平台', async () => {
  const store = await makeStore()
  await store.recordSubmission({
    connKey: CONNECTION.key,
    challengeId: '101',
    flag: 'flag{dup}',
    status: 'correct',
  })
  const adapter = createAdapter()
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_submit_flag.execute({ id: 101, flag: 'flag{dup}' })
  assert.match(out, /already_submitted/)
  assert.match(out, /未重复请求平台/)
  assert.equal(callsOf(adapter, 'submitFlag').length, 0)
  assert.ok(!out.includes('flag{dup}'), '输出中 flag 应脱敏')
})

test('ctf_submit_flag：dedupeFlags=false 时忽略去重', async () => {
  const store = await makeStore()
  await store.recordSubmission({
    connKey: CONNECTION.key,
    challengeId: '101',
    flag: 'flag{dup}',
    status: 'correct',
  })
  const adapter = createAdapter()
  const { tools } = createHarness({ adapter, store, config: { dedupeFlags: false } })
  const out = await tools.ctf_submit_flag.execute({ id: 101, flag: 'flag{dup}' })
  assert.match(out, /^❌ flag 错误/) // mock 只认 flag{ok}
  assert.equal(callsOf(adapter, 'submitFlag').length, 1)
})

test('ctf_submit_flag：错误次数达到 maxWrongAttempts 时拒绝提交', async () => {
  const store = await makeStore()
  for (const flag of ['flag{a}', 'flag{b}']) {
    await store.recordSubmission({ connKey: CONNECTION.key, challengeId: '102', flag, status: 'incorrect' })
  }
  const adapter = createAdapter()
  const { tools } = createHarness({ adapter, store, config: { maxWrongAttempts: 2 } })
  await assert.rejects(tools.ctf_submit_flag.execute({ id: 102, flag: 'flag{c}' }), /上限 2 次/)
  assert.equal(callsOf(adapter, 'submitFlag').length, 0, '超限时不应请求平台')
  assert.equal(await store.wrongAttemptCount(CONNECTION.key, '102'), 2)
})

test('ctf_submit_flag：未超限时放行并计入错误次数', async () => {
  const store = await makeStore()
  await store.recordSubmission({ connKey: CONNECTION.key, challengeId: '102', flag: 'flag{a}', status: 'incorrect' })
  const { tools } = createHarness({ store, config: { maxWrongAttempts: 3 } })
  const out = await tools.ctf_submit_flag.execute({ id: 102, flag: 'flag{bad}' })
  assert.match(out, /^❌ flag 错误/)
  assert.match(out, /累计错误 2 次，上限 3/)
  assert.equal(await store.wrongAttemptCount(CONNECTION.key, '102'), 2)
})

test('ctf_submit_flag：成功提交写入审计并返回正确状态', async () => {
  const store = await makeStore()
  const adapter = createAdapter()
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_submit_flag.execute({ id: 101, flag: 'flag{ok}' })
  assert.match(out, /^✅ flag 正确，题目已解 — 题目 #101/)
  assert.match(out, /回答正确/)
  assert.match(out, /ctf_writeup/)
  assert.equal(callsOf(adapter, 'submitFlag').length, 1)

  const submissions = await store.recentSubmissions()
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].status, 'correct')
  assert.equal(submissions[0].connKey, CONNECTION.key)
  assert.equal(submissions[0].challengeId, '101')
})

test('ctf_submit_flag：平台异常抛硬失败并留审计（结果未知）', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    submitFlag: async () => {
      throw new Error('凌虚 POST /flag/ HTTP 502')
    },
  })
  const { tools } = createHarness({ adapter, store })
  await assert.rejects(tools.ctf_submit_flag.execute({ id: 101, flag: 'flag{ok}' }), /提交未成功/)
  const submissions = await store.recentSubmissions()
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].status, 'error')
})

test('ctf_submit_flag：未知状态提示人工确认', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    submitFlag: async (id, flag) => ({ status: 'unknown', message: '系统繁忙', flag }),
  })
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_submit_flag.execute({ id: 101, flag: 'flag{maybe}' })
  assert.match(out, /未知状态 "unknown"/)
})

test('ctf_submit_flag：缺 id / 空 flag 抛硬失败', async () => {
  const { tools } = createHarness()
  await assert.rejects(tools.ctf_submit_flag.execute({ flag: 'flag{x}' }), /缺少题目 id/)
  await assert.rejects(tools.ctf_submit_flag.execute({ id: 101, flag: '   ' }), /flag 不能为空/)
})

// ------------------------------------------------------------------ 排行榜

test('ctf_leaderboard：表格中标出自己并给出我的排名', async () => {
  const { tools } = createHarness()
  const out = await tools.ctf_leaderboard.execute({ kind: 'user', size: 10 })
  assert.match(out, /🏆 个人排行榜/)
  assert.match(out, /2 👈/)
  assert.match(out, /我的排名: 第 2 名/)
})

test('ctf_leaderboard：空榜单有兜底文案；kind 默认 user', async () => {
  const adapter = createAdapter({ leaderboard: async (kind) => ({ kind, total: 0, rows: [] }) })
  const { tools } = createHarness({ adapter })
  const out = await tools.ctf_leaderboard.execute({})
  assert.match(out, /未返回榜单数据/)
  assert.equal(callsOf(adapter, 'leaderboard')[0].args[0], 'user')
})

// ------------------------------------------------------------------ 理论题

test('ctf_theory：6 个 action 分发到对应适配器方法', async () => {
  const adapter = createAdapter()
  const { tools } = createHarness({ adapter })

  assert.match(await tools.ctf_theory.execute({ action: 'list' }), /理论题试卷（共 1 套）/)
  assert.match(await tools.ctf_theory.execute({ action: 'begin', testId: 1 }), /已开始/)
  assert.match(await tools.ctf_theory.execute({ action: 'questions', testId: 1 }), /\[id=501\]/)
  assert.match(
    await tools.ctf_theory.execute({ action: 'answer', testId: 1, questionId: 501, option: 'A' }),
    /已提交作答/,
  )
  assert.match(await tools.ctf_theory.execute({ action: 'time', testId: 1 }), /05:00/)
  assert.match(await tools.ctf_theory.execute({ action: 'finish', testId: 1 }), /已交卷（不可逆）/)

  assert.deepEqual(
    adapter.calls.map((call) => call.method),
    ['theoryTests', 'beginTheoryTest', 'theoryQuestions', 'answerTheory', 'theoryTime', 'finishTheory'],
  )
  const answerCall = callsOf(adapter, 'answerTheory')[0]
  assert.deepEqual(answerCall.args, ['1', '501', 'A'])
})

test('ctf_theory：finish 的描述明确标注不可逆', () => {
  const { tools } = createHarness()
  assert.match(tools.ctf_theory.description, /不可逆/)
  assert.match(tools.ctf_theory.description, /finish/)
})

test('ctf_theory：参数校验（缺 testId / questionId / option / 未知 action）', async () => {
  const { tools } = createHarness()
  assert.match(await tools.ctf_theory.execute({ action: 'begin' }), /需要 testId/)
  assert.match(await tools.ctf_theory.execute({ action: 'answer', testId: 1 }), /需要 questionId/)
  assert.match(await tools.ctf_theory.execute({ action: 'answer', testId: 1, questionId: 501 }), /需要 option/)
  assert.match(await tools.ctf_theory.execute({ action: 'hack' }), /未知 action/)
  assert.match(await tools.ctf_theory.execute({}), /未知 action/)
})

test('ctf_theory：无理论题 / 作答失败 / 题目截断', async () => {
  const empty = createHarness({ adapter: createAdapter({ theoryTests: async () => [] }) })
  assert.match(await empty.tools.ctf_theory.execute({ action: 'list' }), /没有理论题/)

  const failed = createHarness({ adapter: createAdapter({ answerTheory: async () => ({ ok: false, message: '选项非法' }) }) })
  const out = await failed.tools.ctf_theory.execute({ action: 'answer', testId: 1, questionId: 501, option: 'Z' })
  assert.match(out, /未确认作答成功/)
  assert.match(out, /选项非法/)

  const many = createHarness({
    adapter: createAdapter({
      theoryQuestions: async () =>
        Array.from({ length: 5 }, (_, i) => ({ index: i + 1, id: 600 + i, title: `题目${i + 1}`, options: [] })),
    }),
  })
  const truncated = await many.tools.ctf_theory.execute({ action: 'questions', testId: 1, limit: 2 })
  assert.match(truncated, /共 5 题，显示 2 题/)
  assert.match(truncated, /还有 3 题未显示/)
})

// ------------------------------------------------------------------ 委派工具

test('ctf_solve_start/status/stop 转发给 deps.orchestrator 并规范化并发', async () => {
  const seen = []
  const orchestrator = {
    async start(args) {
      seen.push(['start', args])
      return '已拉起 3 个解题 agent'
    },
    async status(args) {
      seen.push(['status', args])
      return { tasks: 3, running: 2 }
    },
    async stop(args) {
      seen.push(['stop', args])
      return '已停止全部解题 agent'
    },
  }
  const { tools } = createHarness({ deps: { orchestrator } })
  const callerAgent = { id: 'lead-agent' }
  const signal = new AbortController().signal
  const exec = { agent: callerAgent, signal, cwd: '/tmp' }

  assert.match(
    await tools.ctf_solve_start.execute({ concurrency: 99, limit: 5 }, exec),
    /已拉起 3 个解题 agent/,
  )
  assert.equal(seen[0][1].concurrency, 8, '并发上限 8')
  assert.equal(seen[0][1].onlyUnsolved, true)
  assert.equal(seen[0][1].limit, 5)
  assert.equal(seen[0][1].__agent, callerAgent, 'start 必须透传 exec.agent')
  assert.equal(seen[0][1].__signal, signal, 'start 必须透传 exec.signal')

  assert.match(await tools.ctf_solve_status.execute({}, exec), /tasks/)
  assert.equal(seen[1][1].__agent, callerAgent, 'status 必须透传 exec.agent')
  assert.equal(seen[1][1].__signal, signal)

  assert.match(await tools.ctf_solve_stop.execute({ reason: '比赛结束' }, exec), /已停止/)
  assert.equal(seen[2][1].reason, '比赛结束')
  assert.equal(seen[2][1].__agent, callerAgent, 'stop 必须透传 exec.agent')
  assert.equal(seen[2][1].__signal, signal)
  assert.equal(seen[2][1].releaseEnvs, true, 'DESIGN §5：stop 默认释放环境')

  await tools.ctf_solve_stop.execute({ releaseEnvs: false }, exec)
  assert.equal(seen[3][1].releaseEnvs, false, 'releaseEnvs=false 时不释放')
})

test('ctf_solve_stop：releaseEnvs 参数在 schema 中为可选 boolean', () => {
  const { tools } = createHarness()
  assert.equal(tools.ctf_solve_stop.parameters.releaseEnvs.type, 'boolean')
  assert.match(tools.ctf_solve_stop.description, /默认 true/)
  assert.match(tools.ctf_solve_stop.description, /exec\.agent/)
})

test('ctf_solve_start：未注入 orchestrator 时抛错说明', async () => {
  const { tools } = createHarness()
  await assert.rejects(tools.ctf_solve_start.execute({}), /orchestrator/)
  await assert.rejects(tools.ctf_solve_status.execute({}), /orchestrator/)
  await assert.rejects(tools.ctf_solve_stop.execute({}), /orchestrator/)
})

test('ctf_solve_start：编排内部报错时返回文本（不抛）', async () => {
  const { tools } = createHarness({
    deps: {
      orchestrator: {
        async start() {
          throw new Error('平台题目列表拉取失败')
        },
      },
    },
  })
  const out = await tools.ctf_solve_start.execute({})
  assert.match(out, /^❌/)
  assert.match(out, /平台题目列表拉取失败/)
})

test('ctf_writeup：转发给 deps.writeup.generate，submit 默认 false', async () => {
  const seen = []
  const { tools } = createHarness({
    deps: {
      writeup: {
        async generate(args) {
          seen.push(args)
          return 'WP 已生成: /tmp/wp/101.md'
        },
      },
    },
  })
  assert.match(await tools.ctf_writeup.execute({ id: 101 }), /WP 已生成/)
  assert.equal(seen[0].submit, false)
  assert.equal(seen[0].challengeId, 101, 'id 必须归一化成 writeup 模块读的 challengeId')

  await tools.ctf_writeup.execute({ id: 101, submit: true })
  assert.equal(seen[1].submit, true)

  await tools.ctf_writeup.execute({ id: 101, body: '## 解题思路\n爆破得到 flag' })
  assert.equal(seen[2].body, '## 解题思路\n爆破得到 flag')
})

test('ctf_writeup：参数名统一为 id，challengeId 作为旧别名仍可用', async () => {
  const seen = []
  const { tools } = createHarness({
    deps: {
      writeup: {
        async generate(args) {
          seen.push(args)
          return 'ok'
        },
      },
    },
  })
  assert.equal(Object.keys(tools.ctf_writeup.parameters)[0], 'id', '首参必须是 id')
  assert.ok(!('challengeId' in tools.ctf_writeup.parameters), 'challengeId 不再作为声明参数')
  assert.match(tools.ctf_writeup.description, /id 指定题目/)

  await tools.ctf_writeup.execute({ id: 7 })
  assert.equal(seen[0].challengeId, 7)
  await tools.ctf_writeup.execute({ challengeId: 7 })
  assert.equal(seen[1].challengeId, 7, '旧别名 challengeId 仍能走到 writeup')
  await tools.ctf_writeup.execute({})
  assert.equal(seen[2].challengeId, undefined, '都不传则批量生成')
})

test('ctf_writeup：未注入 writeup 时抛错说明', async () => {
  const { tools } = createHarness()
  await assert.rejects(tools.ctf_writeup.execute({}), /writeup/)
})

// ------------------------------------------------------------------ 跨模块集成
// 上面 solve 相关用例都 mock 了 orchestrator，会掩盖真实契约（exec.agent 透传、releaseEnvs、
// challengeWork 记录形状）。这里接**真实的 lib/orchestrate.js** + mock agentTeams 服务跑一遍。

test('跨模块集成：tools → 真实 orchestrate → mock agentTeams', async () => {
  const store = await makeStore()
  await store.upsertConnection(CONNECTION)

  const teamsCalls = { spawn: [], createTask: [], interrupt: [] }
  const tasks = []
  const teams = {
    async spawnTeammate(caller, request) {
      if (!caller) throw new Error('缺少 callerAgent')
      teamsCalls.spawn.push({ caller, name: request.name })
      return { name: request.name, role: 'teammate', status: 'provisioning' }
    },
    async createTask(caller, request) {
      if (!caller) throw new Error('缺少 callerAgent')
      teamsCalls.createTask.push(request)
      const task = {
        id: `task-${tasks.length + 1}`,
        revision: 1,
        status: 'pending',
        subject: request.subject,
        description: request.description,
        writeScopes: request.writeScopes ?? [],
        blockedBy: [],
      }
      tasks.push(task)
      return task
    },
    async listTasks() {
      return tasks.map((task) => ({ ...task }))
    },
    async listMembers() {
      return [{ name: 'lead', role: 'lead', status: 'running' }]
    },
    async interrupt(caller, name) {
      if (!caller) throw new Error('缺少 callerAgent')
      teamsCalls.interrupt.push(name)
      return { previousStatus: 'running' }
    },
  }

  const adapter = createAdapter()
  const deps = {
    config: { concurrency: 2, maxWrongAttempts: 0, dedupeFlags: true, workDir: await makeTmpDir() },
    store,
    resolveAdapter: async () => ({ adapter, connection: CONNECTION }),
    createAdapter: () => adapter,
    logger: { info() {}, warn() {}, error() {} },
    now: () => Date.parse('2026-09-29T01:00:00Z'),
    teams,
  }
  deps.orchestrator = createOrchestrator(deps)
  const tools = Object.fromEntries(buildToolSpecs(deps).map((spec) => [spec.name, spec]))
  const agent = { id: 'agent-lead', name: 'lead' }
  const signal = new AbortController().signal

  // 1) 真实编排：exec.agent 没透传的话，requireCaller 会直接抛「需要在会话内由 Lead agent 调用」
  const started = await tools.ctf_solve_start.execute({ concurrency: 2, limit: 3 }, { agent, signal })
  assert.match(started, /编排已启动/)
  assert.equal(teamsCalls.createTask.length, 2, '2 道未解题都应建任务')
  assert.equal(teamsCalls.spawn.length, 2, 'spawn 数量受 concurrency 限制')
  assert.equal(teamsCalls.spawn[0].caller, agent, 'caller 必须是 exec.agent')

  // 2) status / stop 同样需要 callerAgent
  assert.match(await tools.ctf_solve_status.execute({}, { agent, signal }), /团队进度/)

  // 3) 缺 exec.agent 时给可读提示，而不是崩溃
  assert.match(await tools.ctf_solve_status.execute({}, {}), /callerAgent/)

  // 4) stop 默认释放 ctf_start_env 记录的环境：验证 tools→store→orchestrate 的记录契约
  await tools.ctf_start_env.execute({ id: 102 })
  const stopped = await tools.ctf_solve_stop.execute({ reason: '冒烟' }, { agent, signal })
  assert.match(stopped, /编排已停止/)
  assert.deepEqual(
    callsOf(adapter, 'releaseEnvironment').map((call) => call.args[0]),
    ['102'],
    'stop 必须默认释放环境',
  )
  const work = await store.getChallengeWork(CONNECTION.key, '102')
  assert.equal(work.envReleased, true)
})

// ------------------------------------------------------------------ 容错

test('execute 缺少 exec 参数也不崩（exec 容错）', async () => {
  const store = await makeStore()
  const { tools } = createHarness({ store })
  const out = await tools.ctf_status.execute({})
  assert.match(out, /📊 赛事总览/)
  assert.match(await tools.ctf_leaderboard.execute({}), /排行榜/)
})

test('所有工具的 execute 都能容忍空参数对象', async () => {
  const workDir = await makeTmpDir()
  const store = await makeStore()
  const { tools } = createHarness({ store, config: { workDir } })
  for (const name of TOOL_NAMES) {
    if (name.startsWith('ctf_solve') || name === 'ctf_writeup' || name === 'ctf_submit_flag') continue
    const out = await tools[name].execute({}, {})
    assert.equal(typeof out, 'string', `${name} 应返回字符串`)
  }
})

// ------------------------------------------------------------------ task-11 回归：理论题状态/选项/作答

test('ctf_theory list：is_parse 优先于 is_begin → 已交卷；交卷次数单独成列', async () => {
  const adapter = createAdapter({
    theoryTests: async () => [
      // 真实平台交卷后的返回：is_parse=true，is_begin=false，is_end=false，parse_count=1
      {
        id: 3, name: '理论题', types: ['单选', '多选', '判断'], score: 1000, count: 100,
        timeSeconds: 3600, isBegin: false, isEnd: false, isParse: true, statusLabel: '已交卷', parseCount: 1,
      },
    ],
  })
  const out = await createHarness({ adapter }).tools.ctf_theory.execute({ action: 'list' })
  assert.match(out, /交卷次数/)
  assert.match(out, /单选\/多选\/判断/)
  assert.match(out, /已交卷 1 套/)
  assert.match(out, /不能再拉题目\/作答/)
  assert.doesNotMatch(out, /未开始/, '交卷后不得再渲染成「未开始」')
  assert.doesNotMatch(out, /action=begin/, '已交卷时不应再提示开始考试')
})

test('ctf_theory list：状态判定顺序（is_parse > is_begin > is_end > start_time > 未开始）', async () => {
  const adapter = createAdapter({
    theoryTests: async () => [
      { id: 1, name: 'A', isParse: true, isBegin: false, isEnd: false },
      { id: 2, name: 'B', isParse: false, isBegin: true, isEnd: false },
      { id: 3, name: 'C', isParse: false, isBegin: false, isEnd: true },
      { id: 4, name: 'D', isParse: false, isBegin: false, isEnd: false, startTime: '2026-09-29 10:00' },
      { id: 5, name: 'E', isParse: false, isBegin: false, isEnd: false },
    ],
  })
  const out = await createHarness({ adapter }).tools.ctf_theory.execute({ action: 'list' })
  const rows = out.split('\n').filter((line) => /^\| [1-5] \|/.test(line))
  assert.equal(rows.length, 5)
  assert.match(rows[0], /已交卷/)
  assert.match(rows[1], /进行中/)
  assert.match(rows[2], /已结束（未交卷）/, 'is_end 是比赛已结束，不是已交卷')
  assert.match(rows[3], /已开始未交卷/)
  assert.match(rows[4], /未开始/)
})

test('ctf_status：理论题摘要用同一套状态判定（已交卷不再指路 action=questions）', async () => {
  const adapter = createAdapter({
    theoryTests: async () => [
      { id: 3, name: '理论题', types: ['单选'], score: 1000, count: 100, isParse: true, isBegin: false, isEnd: false },
      { id: 4, name: '加试', types: ['判断'], score: 100, count: 10, isParse: false, isBegin: true, isEnd: false },
    ],
  })
  const out = await createHarness({ adapter }).tools.ctf_status.execute({})
  assert.match(out, /#3 理论题（已交卷，100 题，1000 分）/)
  assert.match(out, /#4 加试（进行中，10 题，100 分）→ ctf_theory action=questions testId=4/)
})

test('ctf_theory questions：渲染 content 选项字典 / user_option 数组 / 题型分值 / 填空提示', async () => {
  const adapter = createAdapter({
    theoryQuestions: async () => [
      {
        index: 1, id: 501, title: '以下哪些属于对称加密？', optionType: 2, optionTypeLabel: '多选', score: 5,
        options: [{ key: 'A', text: 'RSA' }, { key: 'B', text: 'AES' }, { key: 'C', text: 'SM4' }],
        userOption: ['B', 'C'], userOptionText: 'B、C', answered: true,
      },
      {
        index: 2, id: 502, title: '国密分组密码是？', optionType: 4, optionTypeLabel: '填空',
        optionCount: 2, score: 5, options: [], userOption: null, answered: false,
      },
    ],
  })
  const out = await createHarness({ adapter }).tools.ctf_theory.execute({ action: 'questions', testId: 1 })
  assert.match(out, /已作答 1 题/)
  assert.match(out, /\[id=501\]（多选，5 分）/)
  assert.match(out, /（已作答：B、C）/)
  assert.match(out, /   A\. RSA/)
  assert.match(out, /\[id=502\]（填空，5 分）/)
  assert.match(out, /（未作答）/)
  assert.match(out, /共 2 空/)
  assert.match(out, /option=\["答案1","答案2"\]/)
})

test('ctf_theory questions：适配器没给 optionTypeLabel 时用客户端标签兜底', async () => {
  const adapter = createAdapter({
    theoryQuestions: async () => [
      { index: 1, id: 601, title: '判断题', optionType: 3, options: [{ key: 'T', text: '正确' }], userOption: ['T'], subUser: 'alice' },
    ],
  })
  const out = await createHarness({ adapter }).tools.ctf_theory.execute({ action: 'questions', testId: 1 })
  assert.match(out, /\[id=601\]（判断）/)
  assert.match(out, /（已作答：T）/)
  assert.match(out, /   T\. 正确/)
})

test('ctf_theory answer：option 支持数组，多选字符串透传给适配器（由客户端拆分）', async () => {
  const adapter = createAdapter()
  const { tools } = createHarness({ adapter })

  const arrayOut = await tools.ctf_theory.execute({
    action: 'answer', testId: 1, questionId: 501, option: ['C', 'B'],
  })
  assert.match(arrayOut, /已提交作答/)
  assert.match(arrayOut, /→ C、B/)
  assert.deepEqual(callsOf(adapter, 'answerTheory')[0].args, ['1', '501', ['C', 'B']])

  await tools.ctf_theory.execute({ action: 'answer', testId: 1, questionId: 501, option: 'BCD' })
  assert.deepEqual(callsOf(adapter, 'answerTheory')[1].args, ['1', '501', 'BCD'])

  // 数组里全是空值 = 没有提供 option
  assert.match(
    await tools.ctf_theory.execute({ action: 'answer', testId: 1, questionId: 501, option: ['  '] }),
    /需要 option/,
  )
  assert.equal(callsOf(adapter, 'answerTheory').length, 2, '空选项不得请求平台')
})

test('ctf_theory answer：schema 里 option 同时接受字符串与数组', () => {
  const { tools } = createHarness()
  assert.equal(tools.ctf_theory.parameters.option.oneOf.length, 2)
  assert.equal(tools.ctf_theory.parameters.option.oneOf[0].type, 'string')
  assert.equal(tools.ctf_theory.parameters.option.oneOf[1].type, 'array')
})

// ------------------------------------------------------------------ task-11 回归：错误分类与文案

test('ctf_release_env：平台未配置环境 → ℹ️ 提示且记为已释放（不是失败）', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    releaseEnvironment: async () => ({
      challengeId: '41',
      released: false,
      idempotent: false,
      notConfigured: true,
      unsupported: false,
      kind: 'not-configured',
      message: '该题目没有选择对应的环境，请联系管理员。',
    }),
  })
  const out = await createHarness({ adapter, store }).tools.ctf_release_env.execute({ id: 41 })
  assert.match(out, /^ℹ️ 题目 #41：平台未为该题配置环境，无需释放（不算失败）。/)
  assert.match(out, /该题目没有选择对应的环境/)
  assert.doesNotMatch(out, /❌/)
  const work = await store.getChallengeWork(CONNECTION.key, '41')
  assert.equal(work.envReleased, true, '避免下次 stop 再对同一题重复报错')
})

test('ctf_start_env：平台未配置环境 → ⚠️ 说明 + 建议分析附件（不是裸 HTTP 400）', async () => {
  const adapter = createAdapter({
    startEnvironment: async () => {
      throw new LingxuError('该题在平台上没有配置环境：该题目没有选择对应的环境，请联系管理员。', {
        code: LINGXU_CODES.ENV_NOT_CONFIGURED,
        httpStatus: 400,
        path: 'run',
        platformMessage: '该题目没有选择对应的环境，请联系管理员。',
      })
    },
  })
  const out = await createHarness({ adapter }).tools.ctf_start_env.execute({ id: 46 })
  assert.match(out, /^⚠️ 该题在平台上没有配置环境/)
  assert.match(out, /平台返回：该题目没有选择对应的环境，请联系管理员。/)
  assert.match(out, /直接分析附件/)
  assert.doesNotMatch(out, /❌/)
  assert.doesNotMatch(out, /HTTP 400/)
})

test('ctf_start_env：适配器抛普通 Error（只在文案里带线索）也能识别为未配置环境', async () => {
  const adapter = createAdapter({
    startEnvironment: async () => {
      throw new Error('凌虚 POST /event/4/ctf/46/run/ HTTP 400：该题目没有选择对应的环境，请联系管理员。')
    },
  })
  const out = await createHarness({ adapter }).tools.ctf_start_env.execute({ id: 46 })
  assert.match(out, /^⚠️ 该题在平台上没有配置环境/)
  assert.match(out, /该题目没有选择对应的环境/)
  assert.doesNotMatch(out, /❌/)
})

test('session 失效：普通工具渲染成指定的中文提示（且不重复文案）', async () => {
  const sessionError = () =>
    new LingxuError('凌虚 GET /event/4/ctf/ HTTP 403：未登录', {
      httpStatus: 403,
      code: LINGXU_CODES.SESSION_EXPIRED,
      platformMessage: '未登录',
    })
  const adapter = createAdapter({
    challenges: async () => { throw sessionError() },
  })
  const out = await createHarness({ adapter }).tools.ctf_challenges.execute({})
  assert.equal(out, SESSION_EXPIRED_TEXT, '必须是完全一致的统一文案')
  assert.match(out, /凌虚 sessionid 已失效，请重新登录平台后复制新的 Cookie，/)
  assert.match(out, /ctf_connect \{ baseUrl, eventId, cookie \} 更新（其余配置会保留）。/)
})

test('session 失效：丢 code 的错误（被上层重新包装）也能识别', async () => {
  const adapter = createAdapter({
    challenges: async () => {
      throw new Error('无法解析平台连接：凌虚 GET /event/4/info/ 未登录（HTTP 403）：未登录')
    },
  })
  const out = await createHarness({ adapter }).tools.ctf_challenges.execute({})
  assert.equal(out, SESSION_EXPIRED_TEXT)
})

test('ctf_connect：session 失效时直接给更新 Cookie 的指引', async () => {
  const adapter = createAdapter({
    validate: async () => {
      throw new LingxuError('凌虚 GET /event/4/info/ HTTP 403：未登录', {
        httpStatus: 403,
        code: LINGXU_CODES.SESSION_EXPIRED,
      })
    },
  })
  const out = await createHarness({ adapter }).tools.ctf_connect.execute({
    baseUrl: 'https://example.com:8000',
    eventId: 4,
    cookie: 'sessionid=abcdef',
  })
  assert.equal(out, SESSION_EXPIRED_TEXT)
})

test('ctf_connect：cookie 缺 csrftoken 只提醒不拒绝', async () => {
  const adapter = createAdapter()
  const { tools, specs } = createHarness({ adapter, deps: { createAdapter: () => adapter } })
  const out = await tools.ctf_connect.execute({
    baseUrl: 'https://example.com:8000',
    eventId: 4,
    cookie: 'sessionid=abcdef0123456789',
  })
  assert.match(out, /^✅ 已连接凌虚赛事平台/)
  assert.match(out, /建议把 csrftoken 一起带上/)
  assert.match(out, /不强制/)
  assert.ok(specs.length === 13)

  const withCsrf = await tools.ctf_connect.execute({
    baseUrl: 'https://example.com:8000',
    eventId: 4,
    cookie: 'sessionid=abcdef0123456789; csrftoken=tok',
  })
  assert.doesNotMatch(withCsrf, /建议把 csrftoken/)
})

test('ctf_submit_flag：session 失效 → 明确说「未生效/已失效」，不说「结果未知」', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    submitFlag: async () => {
      throw new LingxuError('凌虚 POST /event/4/ctf/56/flag/ 未登录（HTTP 403）：未登录', {
        httpStatus: 403,
        code: LINGXU_CODES.SESSION_EXPIRED,
        platformMessage: '未登录',
      })
    },
  })
  const { tools } = createHarness({ adapter, store })
  await assert.rejects(tools.ctf_submit_flag.execute({ id: 56, flag: 'flag{ok}' }), (error) => {
    assert.match(error.message, /sessionid 已失效/)
    assert.match(error.message, /本次提交未生效/)
    assert.match(error.message, /ctf_connect/)
    assert.doesNotMatch(error.message, /结果未知/)
    return true
  })
  const submissions = await store.recentSubmissions()
  assert.equal(submissions.length, 1, '失败也要留审计')
  assert.equal(submissions[0].status, 'error')
})

test('ctf_submit_flag：非 session 的 403 仍保留「结果未知」措辞', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    submitFlag: async () => {
      throw new LingxuError('凌虚 POST /event/4/ctf/56/flag/ HTTP 403：没有权限', { httpStatus: 403 })
    },
  })
  const { tools } = createHarness({ adapter, store })
  await assert.rejects(tools.ctf_submit_flag.execute({ id: 56, flag: 'flag{ok}' }), (error) => {
    assert.match(error.message, /结果未知/)
    assert.match(error.message, /没有权限/)
    assert.doesNotMatch(error.message, /sessionid 已失效/)
    return true
  })
})
