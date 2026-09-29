/**
 * lib/tools.js 单元测试（node:test，零依赖）。
 *
 * 运行：
 *  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
 *    --test tests/tools.test.mjs
 *
 * 全部使用 mock deps：mock 适配器 + 真实 CtfStore（写到临时目录），不触网。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildToolSpecs, TOOL_NAMES, SESSION_EXPIRED_TEXT,
  connectionOriginLines, resolveWorkDirInfo, workDirNoticeLines,
} from '../lib/tools.js'
import { AWD_TOOL_NAMES, CFS_TOOL_NAMES, buildAwdToolSpecs, buildCfsToolSpecs, recommendStageTools } from '../lib/stage-tools.js'
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

function createHarness({ adapter = createAdapter(), store, config = {}, deps = {}, connection = CONNECTION } = {}) {
  const specs = buildToolSpecs({
    config: {
      concurrency: 4,
      maxWrongAttempts: 0,
      dedupeFlags: true,
      timeoutMs: 30000,
      ...config,
    },
    store,
    resolveAdapter: async () => ({ adapter, connection }),
    createAdapter: () => adapter,
    logger: { info() {}, warn() {}, error() {} },
    now: () => Date.parse('2026-09-29T01:00:00Z'),
    ...deps,
  })
  const tools = Object.fromEntries(specs.map((spec) => [spec.name, spec]))
  return { specs, tools, adapter, store }
}

const callsOf = (adapter, method) => adapter.calls.filter((call) => call.method === method)

// ------------------------------------------------------------------ 规格形状

test('导出 17 个工具规格，名字与 TOOL_NAMES 一致且形状符合 defineTool 契约', () => {
  const { specs, tools } = createHarness()
  assert.equal(specs.length, 17)
  assert.equal(TOOL_NAMES.length, 17)
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
  assert.equal(buildToolSpecs().length, 17)
  assert.equal(buildToolSpecs({}).length, 17)
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

test('ctf_status 显示 token 用量；拿不到就不显示、不编数字', async () => {
  const callStatus = async (deps) => createHarness({ deps }).tools.ctf_status.execute({})

  // ① 宿主注入读取器并返回数据 → 结果里出现千分位用量与来源
  const out = await callStatus({
    readTokenUsage: async () => ({
      ok: true,
      sessionId: 'session-abc',
      inferred: false,
      totalTokens: 16376086,
      totals: { uncachedInputTokens: 308286, outputTokens: 144984, cacheReadTokens: 15922816, cacheWriteTokens: 0 },
    }),
  })
  assert.match(out, /- token 用量: 工作 16,376,086/)
  assert.match(out, /未缓存输入 308,286/)
  assert.match(out, /输出 144,984/)
  assert.match(out, /缓存读 15,922,816/)
  assert.match(out, /合计 16,376,086/)
  assert.match(out, /来源 会话日志（工作用量与 DSH tokenUsage 投影同口径）（会话 session-abc）/)
  assert.equal(out.includes('缓存写'), false, '缓存写为 0 时不显示该桶')

  // ② 自动识别（请求的 agent id 不是会话目录名）→ 如实标注，别让人以为读的是它
  const inferredOut = await callStatus({
    readTokenUsage: async () => ({
      ok: true,
      sessionId: 'session-real',
      inferred: true,
      requestedSessionId: 'session-ae82',
      totalTokens: 42,
      totals: { uncachedInputTokens: 30, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
  })
  assert.match(inferredOut, /工作 42/)
  assert.match(inferredOut, /自动识别/)
  assert.match(inferredOut, /请求的 session-ae82 不是会话目录/)

  // ③ 读取失败 → 明说失败原因；不显示任何数字
  const failedOut = await callStatus({ readTokenUsage: async () => { throw new Error('EACCES') } })
  assert.match(failedOut, /token 用量: 读取失败（EACCES）/)

  // ④ 没有读取器（老宿主）→ 这一行完全不出现
  assert.equal((await callStatus({})).includes('token 用量'), false)

  // ⑤ 读取器返回 ok:false / 0 → 同样不显示（展示 0 会误导）
  const zeroOut = await callStatus({ readTokenUsage: async () => ({ ok: false, error: '无日志' }) })
  assert.equal(zeroOut.includes('token 用量'), false)
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
  assert.ok(out.includes('flag{dup}'), 'flag 应明文展示便于核对（用户要求：没必要藏住）')
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

// ------------------------------------------------------------------ 理论题状态、选项和作答

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

// ------------------------------------------------------------------ 错误分类与文案

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
  assert.ok(specs.length === 17)

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

// ------------------------------------------------------------------ ctf_session 探活

/** 平台 session 失效的真实回包形状（HTTP 403 + {"detail":"未登录"}）。 */
function sessionExpiredError() {
  return new LingxuError('凌虚 GET /event/4/info/ 未登录（HTTP 403）：未登录', {
    httpStatus: 403,
    code: LINGXU_CODES.SESSION_EXPIRED,
    platformMessage: '未登录',
  })
}

test('基础工具数 17：TOOL_NAMES 含 ctf_session / ctf_delay_env / ctf_notice / ctf_team_log（AWD/CFS 工具动态注册，不在此列）', () => {
  assert.equal(TOOL_NAMES.length, 17)
  assert.ok(TOOL_NAMES.includes('ctf_delay_env'))
  assert.ok(TOOL_NAMES.includes('ctf_notice'))
  assert.equal(TOOL_NAMES.includes('ctf_awd_submit'), false, 'AWD 工具由 buildAwdToolSpecs 动态注册')
  assert.ok(TOOL_NAMES.includes('ctf_session'))
  const { tools } = createHarness()
  assert.deepEqual(Object.keys(tools.ctf_session.parameters), ['connection'])
  assert.match(tools.ctf_session.description, /sessionid 是否还有效/)
  assert.match(tools.ctf_session.description, /ctf_solve_start/)
  assert.match(tools.ctf_session.description, /403|未登录/)
})

test('ctf_session：会话有效 → 用户 / 赛事剩余时间 / Cookie 摘要', async () => {
  const adapter = createAdapter()
  // 真实 eventSummary 的 user 来自 /event/{id}/info/，带 username 与 number
  adapter.eventSummary = async () => ({
    name: '凌虚测试赛',
    startTime: '2026-09-29T00:00:00Z',
    endTime: '2026-09-30T00:00:00Z',
    user: { username: 'alice', number: 42 },
    remainingSeconds: 7200,
  })
  const out = await createHarness({ adapter }).tools.ctf_session.execute({})

  assert.match(out, /^✅ 凌虚会话有效（sessionid 可用，平台已响应）/)
  assert.match(out, /- 连接: lingxu:example\.com:8000:4/)
  assert.match(out, /- 平台地址: https:\/\/example\.com:8000（赛事 ID 4）/)
  assert.match(out, /- 登录用户: alice（编号 42）/)
  assert.match(out, /- 赛事: 凌虚测试赛.*，剩余 2h/)
  assert.match(out, /- Cookie: sessio…ue \(len=54\)/)
  assert.ok(!out.includes('csrf-token-value'), '不得回显完整 Cookie')
})

test('ctf_session：session 失效 → 完整更新指引（含连接与平台返回）', async () => {
  const adapter = createAdapter({
    eventSummary: async () => {
      throw sessionExpiredError()
    },
  })
  const out = await createHarness({ adapter }).tools.ctf_session.execute({})

  assert.match(out, /^❌ 凌虚 sessionid 已失效，请重新登录平台后复制新的 Cookie，/)
  assert.match(out, /再用 ctf_connect \{ baseUrl, eventId, cookie \} 更新（其余配置会保留）。/)
  assert.match(out, /- 连接: lingxu:example\.com:8000:4/)
  assert.match(out, /- 平台返回: 未登录/)
  assert.doesNotMatch(out, /✅/)
})

test('ctf_session：其他失败 → 可读错误（不误报 session 失效）', async () => {
  const adapter = createAdapter({
    eventSummary: async () => {
      throw new Error('凌虚 GET /event/4/ HTTP 502：Bad Gateway')
    },
  })
  const out = await createHarness({ adapter }).tools.ctf_session.execute({})
  assert.match(out, /^❌ 凌虚 GET \/event\/4\/ HTTP 502/)
  assert.doesNotMatch(out, /sessionid 已失效/)
})

test('ctf_session：适配器没有 eventSummary 时退回 validate()', async () => {
  const adapter = createAdapter({ eventSummary: undefined })
  const out = await createHarness({ adapter }).tools.ctf_session.execute({})
  assert.match(out, /^✅ 凌虚会话有效/)
  assert.match(out, /- 登录用户: alice/)
  assert.equal(callsOf(adapter, 'validate').length, 1)
})

// ------------------------------------------------------------------ start 前置探活（跨模块，真实 orchestrate）

test('跨模块集成：session 失效时 ctf_solve_start 不建任务、不 spawn', async () => {
  const store = await makeStore()
  await store.upsertConnection(CONNECTION)

  const teamsCalls = { spawn: [], createTask: [] }
  const teams = {
    async spawnTeammate(caller, request) {
      teamsCalls.spawn.push({ caller, name: request.name })
      return { name: request.name, role: 'teammate', status: 'provisioning' }
    },
    async createTask(caller, request) {
      teamsCalls.createTask.push(request)
      return { id: `task-${teamsCalls.createTask.length}`, revision: 1, status: 'pending', ...request }
    },
    async listTasks() { return [] },
    async listMembers() { return [{ name: 'lead', role: 'lead', status: 'running' }] },
    async interrupt(caller, name) { return { previousStatus: 'running', name } },
  }

  const adapter = createAdapter({
    validate: async () => {
      throw sessionExpiredError()
    },
  })
  const deps = {
    config: { concurrency: 4, maxWrongAttempts: 0, dedupeFlags: true },
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

  const out = await tools.ctf_solve_start.execute({ concurrency: 4 }, { agent, signal })
  assert.match(out, /无法开始：凌虚 sessionid 已失效（平台返回「未登录」）。/)
  assert.match(out, /再用 ctf_connect \{ baseUrl, eventId, cookie \} 更新/)
  assert.match(out, /本次未创建任何任务、未拉起任何 agent。/)
  assert.equal(teamsCalls.createTask.length, 0, '不得建任务')
  assert.equal(teamsCalls.spawn.length, 0, '不得 spawn')
  assert.equal(callsOf(adapter, 'challenges').length, 0, '探活失败就不该再拉题目列表')
})

//  环境延时 / 限量 / 附件型 / check 模式

test('ctf_delay_env：五分类渲染（成功 / 太早 / 正在延时 / 不存在 / 已过期）', async () => {
  const cases = [
    ['delayed', { ok: true, kind: 'delayed', addedSeconds: 1800, message: '成功延时30分钟' }, /⏱️ 已延时 30 分钟/, /成功延时30分钟/],
    ['too-early', { ok: false, kind: 'too-early', message: '剩余半小时后才能延时' }, /现在还不能延时/, /剩余半小时后才能延时/],
    ['busy', { ok: false, kind: 'busy', message: '该环境正在延时' }, /正在延时，请稍后重试/, /Redis 锁/],
    ['missing', { ok: false, kind: 'missing', message: '不存在的环境' }, /没有运行中的环境/, /ctf_start_env id=102/],
    ['expired', { ok: false, kind: 'expired', message: '逻辑错误' }, /环境已过期/, /重新起环境/],
  ]
  for (const [kind, result, ...patterns] of cases) {
    const store = await makeStore()
    const adapter = createAdapter({ delayEnvironment: async () => result })
    const { tools } = createHarness({ adapter, store })
    const out = await tools.ctf_delay_env.execute({ id: 102 })
    for (const pattern of patterns) assert.match(out, pattern, `${kind} 的渲染不对：${out}`)
    assert.equal(callsOf(adapter, 'delayEnvironment').length, 1)
    const work = await store.getChallengeWork(CONNECTION.key, '102')
    if (kind === 'delayed') {
      assert.equal(work.envDelayCount, 1, '成功延时才累计次数')
      assert.equal(typeof work.envDelayedAt, 'string')
    } else {
      assert.equal(work.envDelayLastKind, kind, '失败类别也要留痕（便于排查）')
    }
  }
})

test('ctf_delay_env：适配器没给 kind 时用平台文案兜底；缺 id / 无实现有清晰提示', async () => {
  const adapter = createAdapter({ delayEnvironment: async () => ({ status: 3, msg: '剩余半小时后才能延时' }) })
  const { tools } = createHarness({ adapter })
  assert.match(await tools.ctf_delay_env.execute({ id: 102 }), /现在还不能延时/)

  assert.match(await tools.ctf_delay_env.execute({}), /缺少题目 id/)

  const noImpl = createHarness({ adapter: createAdapter({ delayEnvironment: undefined }) })
  assert.match(await noImpl.tools.ctf_delay_env.execute({ id: 1 }), /不支持环境延时/)
})

test('ctf_delay_env：描述里写清了「为什么需要它」（环境会过期 + 30 分钟窗口）', () => {
  const { tools } = createHarness()
  const description = tools.ctf_delay_env.description
  assert.match(description, /每次 \+30 分钟/)
  assert.match(description, /剩余 <30 分钟/)
  assert.match(description, /默认时长由平台决定/)
  assert.doesNotMatch(description, /默认 60 分钟过期/, '实测本赛事是 30 分钟，不能写死 60')
})

test('ctf_start_env：env-limit 错误渲染成可操作文案，并把学到的 N 写进 store', async () => {
  const store = await makeStore()
  const error = new LingxuError('启动环境失败：当前赛事限制启动3个题目环境，请释放后启动', {
    httpStatus: 400,
    code: LINGXU_CODES.ENV_LIMIT,
    envLimit: 3,
    platformMessage: '当前赛事限制启动3个题目环境，请释放后启动',
    payload: { error: '当前赛事限制启动3个题目环境，请释放后启动' },
  })
  const adapter = createAdapter({ startEnvironment: async () => { throw error } })
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_start_env.execute({ id: 102 })

  assert.match(out, /平台限制了同时运行的环境数（本赛事最多 3 个）/)
  assert.match(out, /请先用 ctf_release_env 释放不再需要的环境/)
  assert.match(out, /环境是稀缺资源/)
  assert.match(out, /当前赛事限制启动3个题目环境/)
  assert.doesNotMatch(out, /^❌/, '不该渲染成裸失败')

  const work = await store.getChallengeWork(CONNECTION.key, '102')
  assert.equal(work.envLimitObserved, 3, '编排层靠这条自学习真实上限')
  assert.equal(typeof work.envLimitHitAt, 'string')
})

test('ctf_start_env：只有文案（没有 envLimit 字段）时也能解析出 N', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    startEnvironment: async () => {
      throw new Error('HTTP 400：当前赛事限制启动2个题目环境，请释放后启动')
    },
  })
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_start_env.execute({ id: 102 })
  assert.match(out, /最多 2 个/)
  assert.equal((await store.getChallengeWork(CONNECTION.key, '102')).envLimitObserved, 2)
})

test('ctf_start_env：返回剩余时间；剩余 <10 分钟时主动提醒延时', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    startEnvironment: async () => ({
      connectionInfo: 'nc 1.2.3.4 9999',
      targets: ['nc 1.2.3.4 9999'],
      hasPrivateOnly: false,
      remainingSeconds: 420, // 7 分钟
      releaseTime: '2026-09-29T01:07:00.000Z',
    }),
  })
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_start_env.execute({ id: 102 })
  assert.match(out, /- 环境剩余: 约 7 分钟/)
  assert.match(out, /2026-09-29T01:07:00.000Z 释放/)
  assert.match(out, /⚠️ 环境将在 7 分钟后释放，长题请用 ctf_delay_env id=102 延时/)

  const work = await store.getChallengeWork(CONNECTION.key, '102')
  assert.equal(work.envRemainingSeconds, 420)
  assert.equal(work.taskType, 1, '起过环境就说明是环境型（编排层免探测）')
})

test('ctf_start_env：envAutoDelay 默认开 —— 剩余 <30 分钟自动延一次（实测本赛事只有 30 分钟）', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    startEnvironment: async () => ({
      connectionInfo: 'nc 1.2.3.4 9999',
      targets: ['nc 1.2.3.4 9999'],
      remainingSeconds: 1799,
      releaseTime: '2026-09-29T01:30:00.000Z',
    }),
    delayEnvironment: async () => ({ ok: true, kind: 'delayed', addedSeconds: 1800, message: '成功延时30分钟' }),
  })
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_start_env.execute({ id: 102 })
  assert.equal(callsOf(adapter, 'delayEnvironment').length, 1, '剩余不足 30 分钟就该自动延一次')
  assert.match(out, /已自动延时 30 分钟/)
  assert.match(out, /- 环境剩余: 约 59 分钟/, '延时后要把剩余时间算进去')
  assert.doesNotMatch(out, /⚠️ 环境将在/, '已经延时了就不该再警告')
  assert.equal((await store.getChallengeWork(CONNECTION.key, '102')).envAutoDelayed, true)

  // envAutoDelay=false：不调用延时接口，剩余时间为准
  const off = createAdapter({
    startEnvironment: async () => ({ connectionInfo: 'nc 1.2.3.4 9999', targets: ['nc 1.2.3.4 9999'], remainingSeconds: 1799 }),
    delayEnvironment: async () => ({ ok: true, kind: 'delayed', addedSeconds: 1800 }),
  })
  const offHarness = createHarness({ adapter: off, store: await makeStore(), config: { envAutoDelay: false } })
  const offOut = await offHarness.tools.ctf_start_env.execute({ id: 102 })
  assert.equal(callsOf(off, 'delayEnvironment').length, 0)
  assert.match(offOut, /- 环境剩余: 约 29 分钟/)
})

test('ctf_submit_flag：answer_mode=2（check 模式）走 /check/，不走 /flag/', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    challengeDetail: async (id) => ({
      id: Number(id), name: 'check 题', taskType: 3, taskTypeLabel: '附件型', answerMode: 2, answerModeLabel: 'check',
    }),
    checkFlag: async () => ({ ok: true, status: 1, detail: 'check已触发', message: 'check已触发' }),
  })
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_submit_flag.execute({ id: 102, flag: 'whatever' })

  assert.equal(callsOf(adapter, 'checkFlag').length, 1, '必须走 check 端点')
  assert.equal(callsOf(adapter, 'submitFlag').length, 0, '绝不能走 /flag/（平台会拒绝）')
  assert.match(out, /🧪 平台已触发 check — 题目 #102/)
  assert.match(out, /check已触发/)
  assert.match(out, /不返回判定结果/)
  assert.match(out, /不等于\*\*已得分|不等于.*已得分/)
  assert.match(out, /不计入错误提交次数/)

  const audit = await store.recentSubmissions(5)
  assert.equal(audit[0].status, 'check')
  assert.equal(audit[0].challengeId, '102')
  // check 结果不参与 flag 去重、也不算错误提交
  assert.equal(await store.hasSubmittedFlag(CONNECTION.key, 102, 'whatever'), false)
  assert.equal(await store.wrongAttemptCount(CONNECTION.key, 102), 0)
})

test('ctf_submit_flag：详情探测失败但平台回「此题目为check模式」→ 改走 check，不误记账', async () => {
  const store = await makeStore()
  const adapter = createAdapter({
    challengeDetail: async () => { throw new Error('网络抖动') },
    submitFlag: async () => {
      throw new LingxuError('提交未成功：此题目为check模式，请点击check进行得分', {
        httpStatus: 400,
        code: LINGXU_CODES.ANSWER_MODE_MISMATCH,
        platformMessage: '此题目为check模式，请点击check进行得分',
        payload: { error: '此题目为check模式，请点击check进行得分' },
      })
    },
    checkFlag: async () => ({ ok: true, status: 1, detail: 'check已触发' }),
  })
  const { tools } = createHarness({ adapter, store })
  const out = await tools.ctf_submit_flag.execute({ id: 102, flag: 'flag{x}' })
  assert.equal(callsOf(adapter, 'checkFlag').length, 1)
  assert.match(out, /平台已触发 check/)
  const audit = await store.recentSubmissions(5)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].status, 'check', '不能把「模式探错」记成错误提交')
})

test('ctf_submit_flag：check 模式但适配器没有 checkFlag → 本地拦截，不再撞 /flag/', async () => {
  const adapter = createAdapter({
    challengeDetail: async (id) => ({ id: Number(id), name: 'check 题', answerMode: 2 }),
  })
  const { tools } = createHarness({ adapter })
  const out = await tools.ctf_submit_flag.execute({ id: 102, flag: 'flag{x}' })
  assert.match(out, /check 模式/)
  assert.match(out, /还没有 checkFlag 实现/)
  assert.match(out, /不要\*\*继续用 \/flag\/|不要.*\/flag\//)
  assert.equal(callsOf(adapter, 'submitFlag').length, 0)
  assert.equal(callsOf(adapter, 'checkFlag').length, 0)
})

test('ctf_challenge：taskType=3 附件型必须下载附件并显示题型标签', async () => {
  const workDir = await makeTmpDir()
  const adapter = createAdapter({
    challengeDetail: async (id) => ({
      id: Number(id),
      name: '附件题',
      description: '# 附件题\n看附件',
      attachment: 'https://example.com:8000/media/x/file.zip',
      attachmentName: 'file.zip',
      score: 150,
      solves: 2,
      taskType: 3,
      taskTypeLabel: '附件型',
      answerMode: 1,
      requiresEnv: false,
      downloadable: true,
    }),
  })
  const store = await makeStore()
  const { tools } = createHarness({ adapter, store, config: { workDir } })
  const out = await tools.ctf_challenge.execute({ id: 105 })

  assert.match(out, /- 题型: 附件型/)
  assert.match(out, /需要环境: 否/)
  assert.match(out, /附件（file\.zip）/)
  assert.match(out, /下一步: 附件型题目/)
  const dirs = await fsp.readdir(path.join(workDir, 'challenges'))
  const files = await fsp.readdir(path.join(workDir, 'challenges', dirs[0], 'distfiles'))
  assert.deepEqual(files, ['file.zip'], '附件型必须真的落盘')
  const metadata = JSON.parse(await fsp.readFile(path.join(workDir, 'challenges', dirs[0], 'metadata.json'), 'utf8'))
  assert.equal(metadata.taskType, 3)
  assert.equal(metadata.taskTypeLabel, '附件型')
  assert.equal(metadata.downloadable, true)
  // 题型回写 work 记录（编排层免探测）
  assert.equal((await store.getChallengeWork(CONNECTION.key, '105')).taskType, 3)
})

test('ctf_challenge：外链型显示 link_path；动态 flag 标注；附件型缺附件要警告', async () => {
  const workDir = await makeTmpDir()
  const adapter = createAdapter({
    challengeDetail: async (id) => ({
      id: Number(id),
      name: '外链题',
      description: '题面',
      attachment: '',
      taskType: 2,
      taskTypeLabel: '外链型',
      flagType: 2,
      flagTypeLabel: '动态 flag',
      answerMode: 1,
      externalLink: 'https://pan.example.com/s/abc',
      secondaryPath: '/data/sec',
      manual: '手册第一行',
    }),
  })
  const { tools } = createHarness({ adapter, config: { workDir } })
  const out = await tools.ctf_challenge.execute({ id: 106 })
  assert.match(out, /- 题型: 外链型｜动态 flag/)
  assert.match(out, /- 外链: https:\/\/pan\.example\.com\/s\/abc/)
  assert.match(out, /- 二级路径: \/data\/sec/)
  assert.match(out, /手册第一行/)
  assert.match(out, /下一步: 按外链获取题目材料后/)

  // 附件型但平台没给附件链接 → 明确警告（否则 agent 会去空目录找附件）
  const noFile = createAdapter({
    challengeDetail: async (id) => ({
      id: Number(id), name: '缺附件', description: 'x', attachment: '', taskType: 3, taskTypeLabel: '附件型', answerMode: 1,
    }),
  })
  const out2 = await createHarness({ adapter: noFile, config: { workDir } }).tools.ctf_challenge.execute({ id: 107 })
  assert.match(out2, /平台未返回附件链接/)
})


//  AWD/CFS 赛段工具（动态注册）+ ctf_notice

/** 带赛段信息的 adapter：testTypes 用**数组**（新形状）+ hasXxx 布尔，AWD/CFS 方法齐全。 */
function createStageAdapter(overrides = {}) {
  return createAdapter({
    eventSummary: async () => ({
      name: '凌虚测试赛',
      startTime: '2026-09-29T00:00:00Z',
      endTime: '2026-09-30T00:00:00Z',
      status: 2,
      user: { username: 'alice' },
      punish: false,
      remainingSeconds: 122400,
      testTypes: [
        { id: 2, name: '实操题', size: 30 },
        { id: 3, name: 'AWD', size: 5 },
        { id: 4, name: 'CFS', size: 3 },
      ],
      hasTheory: false,
      hasCtf: true,
      hasAwd: true,
      hasCfs: true,
    }),
    awdRoundInfo: async () => ({
      status: 0, statusLabel: '进行中', round: 2, roundEndSeconds: 1800, reinforceEndSeconds: 0,
      isReinforce: false, token: 'awd-token-abcdef123456', rank: 7, name: 'alice', number: '42',
    }),
    awdChallenges: async () => [
      { catId: 11, caId: 22, awdId: 1, name: 'Web 靶机', classify: 'Web', testScore: 1000, roundScore: 50, checkStatus: true, isAttacked: true },
      { catId: 12, caId: 23, awdId: 2, name: 'Pwn 靶机', classify: 'Pwn', testScore: 800, roundScore: 0, checkStatus: false, isAttacked: false },
    ],
    awdChallengeDetail: async (catId, caId) => ({
      id: Number(caId), name: 'Web 靶机', classify: 'Web', envRunId: 4242, ipAddr: '1.2.3.4:22',
      imgUser: 'root', imgPassword: 'p@ssw0rd', attackIp: ['9.9.9.9'], leftFreeResetNum: 1, leftResetNum: 2,
      resetScore: 50, checkStatus: true, isAttacked: true, description: '# Web 靶机题面',
    }),
    awdRank: async () => [
      { rank: 1, name: 'bob', awdScore: 900, roundAwdScore: 100, totalRoundScore: 300, isSelf: false },
      { rank: 7, name: 'alice', awdScore: 100, roundAwdScore: 0, totalRoundScore: 10, isSelf: true },
    ],
    awdDynamic: async () => [
      { statusLabel: '成功', attackName: 'alice', attackedName: 'bob', score: 10, testName: 'Web 靶机', roundNums: 2 },
    ],
    awdGetOwnFlag: async () => ({ flag: '', hasFlag: false, hint: '未取到 flag：需在靶机本机调用（平台按请求 IP 匹配靶机），且题目 flag_type 必须是 2（flag 服务器）' }),
    awdSubmitFlag: async (token, flag) => ({ ok: true, status: 1, message: 'Flag提交成功！', token, flag }),
    awdResetKvm: async () => ({ ok: true, status: 1, message: '重置成功' }),
    awdReferee: async () => ({ ok: true, detail: '已收到' }),
    cfsRoundInfo: async () => ({ status: 0, statusLabel: '进行中', startSeconds: 0, endSeconds: 7200 }),
    cfsChallenges: async () => [
      { cctId: 5, name: '场景一', score: 300, solveSchedule: 1, allSchedule: 3, doneCount: 1 },
    ],
    cfsChallengeDetail: async (cctId) => ({
      cctId: Number(cctId), name: '场景一', score: 300, nowScore: 100, solveSchedule: 1, allSchedule: 3,
      addrList: ['http://1.2.3.4:8080'], annexList: ['a.zip'], attachment: '', description: '# 场景一',
    }),
    cfsSubmitFlag: async (cctId, flag) => ({ ok: true, status: 1, message: '恭喜攻克【场景一】题目下的关卡【第一关】！', cctId, flag }),
    cfsRank: async () => [{ rank: 1, name: 'alice', cfsScore: 300, cfsStrengths: 10, cfsFlagCount: 3, isSelf: true }],
    cfsChart: async () => ({ startTime: 1000, endTime: 2000, series: [{ id: 1, name: 'alice', points: [[1000, 100], [2000, 300]] }] }),
    cfsDynamic: async () => [{ id: 1, name: 'alice', testName: '场景一', flagTestName: '第一关', subTime: '2026-09-29 10:00' }],
    noticeCount: async () => ({ count: 3 }),
    notices: async () => [
      { id: 3, type: 1, content: '第三题环境已修复，请重试', create_time: '2026-09-29 11:00' },
      { id: 2, type: 3, content: '禁止对平台发起扫描', create_time: '2026-09-29 10:00' },
      { id: 1, type: 5, content: '第一题提示：注意大小端', create_time: '2026-09-29 09:00' },
    ],
    ...overrides,
  })
}

/** 赛段工具的 harness：adapter 用 createStageAdapter，specs 来自 builders。 */
function stageHarness({ adapter = createStageAdapter(), deps = {} } = {}) {
  const specs = [...buildAwdToolSpecs({ ...deps, resolveAdapter: async () => ({ adapter, connection: CONNECTION }) }),
    ...buildCfsToolSpecs({ ...deps, resolveAdapter: async () => ({ adapter, connection: CONNECTION }) })]
  return { specs, tools: Object.fromEntries(specs.map((spec) => [spec.name, spec])), adapter }
}

test('buildAwdToolSpecs / buildCfsToolSpecs：数量、名字与 defineTool 契约', () => {
  const awd = buildAwdToolSpecs()
  const cfs = buildCfsToolSpecs()
  assert.equal(awd.length, 9)
  assert.equal(cfs.length, 7)
  assert.deepEqual(awd.map((spec) => spec.name), AWD_TOOL_NAMES)
  assert.deepEqual(cfs.map((spec) => spec.name), CFS_TOOL_NAMES)
  for (const spec of [...awd, ...cfs]) {
    assert.equal(typeof spec.description, 'string', `${spec.name} 缺 description`)
    assert.ok(spec.parameters && typeof spec.parameters === 'object', `${spec.name} 缺 parameters`)
    assert.equal('connection' in spec.parameters, true, `${spec.name} 缺 connection 参数`)
    assert.equal(typeof spec.output?.schema, 'object', `${spec.name} 缺 output.schema`)
    assert.equal(typeof spec.output?.render, 'function', `${spec.name} 缺 output.render`)
    assert.equal(typeof spec.execute, 'function', `${spec.name} 缺 execute`)
    // 每个工具都要能自解释「何时用」，模型才敢选
    assert.match(spec.description, /何时用/, `${spec.name} 描述缺「何时用」`)
  }
  // 无 deps 也能构造（执行时才需要依赖）
  assert.equal(buildAwdToolSpecs().length, 9)
  assert.equal(buildCfsToolSpecs({}).length, 7)
})

test('recommendStageTools：true/false/null 三态（未知时建议保持现状）', () => {
  assert.deepEqual(
    recommendStageTools({ testTypes: [{ id: 2, name: '实操题', size: 30 }], hasAwd: false, hasCfs: false }),
    { awd: false, cfs: false, testTypes: [{ id: 2, name: '实操题', size: 30 }], reason: '无 AWD、无 CFS' },
  )
  const all = recommendStageTools({ testTypes: [{ id: 2 }, { id: 3 }, { id: 4 }] })
  assert.equal(all.awd, true)
  assert.equal(all.cfs, true)
  // 只有 testTypes 没有 hasXxx 布尔时按 id 推断
  const infer = recommendStageTools({ testTypes: [{ id: 2 }, { id: 4 }] })
  assert.equal(infer.awd, false)
  assert.equal(infer.cfs, true)
  // 拿不到赛段信息 → null（别注册也别注销，避免工具列表抖动）
  const unknown = recommendStageTools({})
  assert.equal(unknown.awd, null)
  assert.equal(unknown.cfs, null)
  assert.match(unknown.reason, /未知项建议保持现状/)
  // hasXxx 布尔优先于 testTypes
  const override = recommendStageTools({ hasAwd: true, hasCfs: false, testTypes: [{ id: 2 }] })
  assert.equal(override.awd, true)
  assert.equal(override.cfs, false)
})

test('ctf_awd_*：每个工具路由到对应适配器方法，参数形态正确', async () => {
  const { tools, adapter } = stageHarness()
  const cases = [
    ['ctf_awd_status', {}, 'awdRoundInfo', /AWD 赛段状态/],
    ['ctf_awd_list', { classify: 'Web' }, 'awdChallenges', /AWD 靶机列表/],
    ['ctf_awd_detail', { catId: 11, caId: 22 }, 'awdChallengeDetail', /AWD 靶机详情/],
    ['ctf_awd_submit', { flag: 'flag{attacked}', token: 'tok-abcdef123456' }, 'awdSubmitFlag', /AWD flag 提交成功/],
    ['ctf_awd_own_flag', {}, 'awdGetOwnFlag', /自己的 flag/],
    ['ctf_awd_rank', { limit: 1 }, 'awdRank', /AWD 排行榜/],
    ['ctf_awd_dynamic', {}, 'awdDynamic', /AWD 回合动态/],
    ['ctf_awd_reset', { envRunId: 4242, type: 2 }, 'awdResetKvm', /靶机重置已触发/],
    ['ctf_awd_referee', { content: '环境异常' }, 'awdReferee', /已呼叫裁判/],
  ]
  for (const [name, args, method, pattern] of cases) {
    const before = adapter.calls.length
    const out = await tools[name].execute(args)
    assert.match(out, pattern, `${name} 输出不对：${out}`)
    const called = adapter.calls.slice(before).filter((call) => call.method === method)
    assert.equal(called.length, 1, `${name} 应调用 ${method} 一次`)
  }

  const calledWith = (method) => adapter.calls.filter((call) => call.method === method).map((call) => call.args)
  assert.deepEqual(calledWith('awdChallenges')[0], [{ classify: 'Web' }], 'awd_list 要带 classify')
  assert.deepEqual(calledWith('awdChallengeDetail')[0], ['11', '22'], 'awd_detail 参数顺序必须是 (catId, caId)')
  assert.deepEqual(calledWith('awdSubmitFlag')[0].slice(0, 2), ['tok-abcdef123456', 'flag{attacked}'])
  assert.deepEqual(calledWith('awdResetKvm')[0], ['4242', { type: 2 }], 'type=2 = 扣分重置')
})

test('ctf_awd_status：回合/加固期/token 脱敏/我的排名', async () => {
  const reinforce = createStageAdapter({
    awdRoundInfo: async () => ({
      status: 0, statusLabel: '进行中', round: 0, roundEndSeconds: 0, reinforceEndSeconds: 600,
      isReinforce: true, token: 'awd-token-abcdef123456', rank: 3, name: 'alice', number: '42',
    }),
  })
  const out = await stageHarness({ adapter: reinforce }).tools.ctf_awd_status.execute({})
  assert.match(out, /状态: 进行中/)
  assert.match(out, /⚠️ 加固期（剩余 10m0s）/)
  assert.match(out, /我的队伍\/账号: alice（42）/)
  assert.match(out, /我的排名: 第 3 名/)
  assert.match(out, /token: awd-to…（已脱敏，共 22 字符）/)
  assert.equal(out.includes('awd-token-abcdef123456'), false, '完整 token 不能出现在输出里')
})

test('ctf_awd_rank：平台 500 → 友好降级（错误分类保留，不抛错）', async () => {
  const adapter = createStageAdapter({
    awdRank: async () => {
      throw new Error('凌虚 GET /event/4/awd/rank/ 失败（HTTP 500）：Internal Server Error')
    },
  })
  const out = await stageHarness({ adapter }).tools.ctf_awd_rank.execute({})
  assert.match(out, /AWD 排行榜获取失败/)
  assert.match(out, /HTTP 500/)
  assert.match(out, /平台在没有 AWD 赛段时该接口会 HTTP 500/)
  assert.match(out, /ctf_leaderboard/)
  assert.doesNotMatch(out, /^❌/)
})

test('ctf_awd_own_flag：说明「靶机本机 + flag_type=2」限制；有值时如实显示', async () => {
  const empty = await stageHarness().tools.ctf_awd_own_flag.execute({})
  assert.match(empty, /请求来源 IP/)
  assert.match(empty, /靶机本机/)
  assert.match(empty, /flag_type=2/)
  assert.match(empty, /flag_type=1/)
  assert.match(empty, /flag: （空）/)
  assert.match(empty, /未取到 flag/)

  const withFlag = createStageAdapter({ awdGetOwnFlag: async () => ({ flag: 'flag{own_defense_flag}', hasFlag: true, hint: '' }) })
  const out = await stageHarness({ adapter: withFlag }).tools.ctf_awd_own_flag.execute({})
  assert.match(out, /flag: flag\{own_defense_flag\}/)
})

test('ctf_awd_submit：token 输出脱敏（显式与自动两条路径）', async () => {
  const { tools, adapter } = stageHarness()
  const explicit = await tools.ctf_awd_submit.execute({ token: 'tok-abcdef123456', flag: 'flag{attacked}' })
  assert.match(explicit, /token: tok-ab…（已脱敏，共 16 字符）/)
  assert.match(explicit, /来源：参数 token/)
  assert.equal(explicit.includes('abcdef123456'), false, '输出不能包含完整 token')
  assert.match(explicit, /flag: flag\{a…d\} \(len=14\)/, 'flag 也要脱敏')

  const auto = await tools.ctf_awd_submit.execute({ flag: 'flag{attacked2}' })
  assert.match(auto, /来源：AWD 赛段信息/)
  assert.match(auto, /token: awd-to…（已脱敏，共 22 字符）/)
  assert.equal(auto.includes('awd-token-abcdef123456'), false)
  assert.equal(callsOf(adapter, 'awdSubmitFlag').length, 2)
})

test('ctf_awd_*：参数校验与会话失效/不支持的错误分类', async () => {
  const { tools } = stageHarness()
  assert.match(await tools.ctf_awd_detail.execute({ catId: 11 }), /需要 catId 与 caId/)
  assert.match(await tools.ctf_awd_detail.execute({}), /注意顺序/)
  assert.match(await tools.ctf_awd_reset.execute({}), /需要 envRunId/)
  assert.match(await tools.ctf_awd_submit.execute({}), /需要 flag/)
  assert.match(await tools.ctf_awd_referee.execute({}), /需要 content/)

  // 适配器缺方法 → ℹ️ 而不是崩
  const bare = createAdapter({ awdChallenges: undefined, cfsChallenges: undefined })
  const bareHarness = stageHarness({ adapter: bare })
  assert.match(await bareHarness.tools.ctf_awd_list.execute({}), /适配器不支持 AWD 题目列表/)
  assert.match(await bareHarness.tools.ctf_cfs_list.execute({}), /适配器不支持 CFS 关卡列表/)

  // session 失效：错误分类仍然生效（就算工具本不该被注册，边界调用也得给对的文案）
  const expired = createStageAdapter({
    awdRank: async () => { throw sessionExpiredError() },
  })
  const expiredOut = await stageHarness({ adapter: expired }).tools.ctf_awd_rank.execute({})
  assert.match(expiredOut, /sessionid 已失效/)
  assert.match(expiredOut, /ctf_connect/)

  // 写操作（submit）是硬失败：连接解析不到时抛错，不静默
  const noConn = buildAwdToolSpecs({ resolveAdapter: async () => { throw new Error('没有连接') }, logger: {} })
  const submitSpec = noConn.find((spec) => spec.name === 'ctf_awd_submit')
  await assert.rejects(() => submitSpec.execute({ flag: 'flag{x}' }), /无法解析平台连接/)
})

test('ctf_cfs_*：每个工具路由到对应适配器方法，参数形态正确', async () => {
  const { tools, adapter } = stageHarness()
  const cases = [
    ['ctf_cfs_status', {}, 'cfsRoundInfo', /CFS 赛段状态/],
    ['ctf_cfs_list', {}, 'cfsChallenges', /CFS 关卡列表/],
    ['ctf_cfs_detail', { cctId: 5 }, 'cfsChallengeDetail', /CFS 题目详情/],
    ['ctf_cfs_submit', { cctId: 5, flag: 'flag{level1}' }, 'cfsSubmitFlag', /CFS 关卡 flag 正确/],
    ['ctf_cfs_rank', { limit: 1 }, 'cfsRank', /CFS 排行榜/],
    ['ctf_cfs_chart', {}, 'cfsChart', /CFS 得分总势/],
    ['ctf_cfs_dynamic', {}, 'cfsDynamic', /CFS 提交流水/],
  ]
  for (const [name, args, method, pattern] of cases) {
    const before = adapter.calls.length
    const out = await tools[name].execute(args)
    assert.match(out, pattern, `${name} 输出不对：${out}`)
    const called = adapter.calls.slice(before).filter((call) => call.method === method)
    assert.equal(called.length, 1, `${name} 应调用 ${method} 一次`)
  }
  const calledWith = (method) => adapter.calls.filter((call) => call.method === method).map((call) => call.args)
  assert.deepEqual(calledWith('cfsChallengeDetail')[0], ['5'])
  assert.deepEqual(calledWith('cfsSubmitFlag')[0], ['5', 'flag{level1}'])

  assert.match(await tools.ctf_cfs_detail.execute({}), /需要 cctId/)
  assert.match(await tools.ctf_cfs_submit.execute({ cctId: 5 }), /需要 flag/)
})

test('赛段工具：危险写操作在描述里标注副作用', () => {
  const { tools } = stageHarness()
  assert.match(tools.ctf_awd_referee.description, /真的给管理员写消息/)
  assert.match(tools.ctf_awd_referee.description, /非必要不要调用/)
  assert.match(tools.ctf_awd_reset.description, /消耗重置次数/)
  assert.match(tools.ctf_awd_reset.description, /直接扣分/)
  assert.match(tools.ctf_awd_submit.description, /真实计分/)
  assert.match(tools.ctf_awd_submit.description, /query 参数/)
  assert.match(tools.ctf_awd_submit.description, /只显示前 6 位/)
  assert.match(tools.ctf_cfs_submit.description, /真实计分/)
  assert.match(tools.ctf_awd_own_flag.description, /请求来源 IP/)
})

test('ctf_notice：未读数 + 公告列表（最新在前 / 类型标签 / limit）', async () => {
  const adapter = createStageAdapter()
  const { tools } = createHarness({ adapter })
  const out = await tools.ctf_notice.execute({})
  assert.match(out, /📢 赛事公告｜共 3 条，其中约 3 条未读/)
  assert.match(out, /通知/)
  assert.match(out, /警告/)
  assert.match(out, /题目提示信息/)
  assert.match(out, /第三题环境已修复/)
  assert.match(out, /2026-09-29 11:00/)
  // 最新在前
  assert.equal(out.indexOf('第三题环境已修复') < out.indexOf('第一题提示'), true)

  const limited = await tools.ctf_notice.execute({ limit: 1 })
  assert.match(limited, /第三题环境已修复/)
  assert.doesNotMatch(limited, /第一题提示/)
  assert.match(limited, /还有 2 条未显示/)

  const unreadOnly = await tools.ctf_notice.execute({ unreadOnly: true, limit: 2 })
  assert.match(unreadOnly, /unreadOnly=true/)
  assert.match(unreadOnly, /平台不提供逐条已读标记/)
  assert.equal(unreadOnly.includes('第一题提示'), false)

  assert.equal(tools.ctf_notice.parameters.unreadOnly.type, 'boolean')
  assert.equal(tools.ctf_notice.parameters.limit.type, 'integer')
})

test('ctf_notice：无公告 / 无未读 / 适配器不支持 / 计数失败', async () => {
  const empty = createStageAdapter({ notices: async () => [], noticeCount: async () => ({ count: 0 }) })
  assert.match(await createHarness({ adapter: empty }).tools.ctf_notice.execute({}), /当前没有公告/)

  const noCount = createStageAdapter({ noticeCount: undefined })
  const noCountOut = await createHarness({ adapter: noCount }).tools.ctf_notice.execute({})
  assert.match(noCountOut, /📢 赛事公告｜共 3 条/)
  assert.doesNotMatch(noCountOut, /未读/)

  const broken = createStageAdapter({ noticeCount: async () => { throw new Error('boom') } })
  const brokenOut = await createHarness({ adapter: broken }).tools.ctf_notice.execute({})
  assert.match(brokenOut, /共 3 条/, '计数失败也要能列出公告')
  assert.doesNotMatch(brokenOut, /boom/)

  const bare = createAdapter({ notices: undefined, noticeCount: undefined })
  assert.match(await createHarness({ adapter: bare }).tools.ctf_notice.execute({}), /不支持公告/)
})

test('ctf_status：显示赛段构成与未读公告（指向 ctf_notice）', async () => {
  const out = await createHarness({ adapter: createStageAdapter() }).tools.ctf_status.execute({})
  assert.match(out, /- 本赛事含: 实操题 30 题、AWD 5 题、CFS 3 题/)
  assert.match(out, /- 📢 公告: 有 3 条未读 → ctf_notice 查看/)
  assert.match(out, /- 其他赛段: 含 AWD \/ CFS/)

  const quiet = createStageAdapter({
    noticeCount: async () => ({ count: 0 }),
    eventSummary: async () => ({
      name: '纯 CTF', remainingSeconds: 100, punish: false,
      testTypes: [{ id: 2, name: '实操题', size: 10 }],
      hasTheory: false, hasCtf: true, hasAwd: false, hasCfs: false,
    }),
  })
  const quietOut = await createHarness({ adapter: quiet }).tools.ctf_status.execute({})
  assert.match(quietOut, /- 本赛事含: 实操题 10 题/)
  assert.match(quietOut, /- 📢 公告: 无未读/)
  assert.doesNotMatch(quietOut, /其他赛段/)
})

test('赛段工具：边界情况下被调用时，「没有该赛段」也要分类出可操作文案', async () => {
  // 正常路径下这些工具根本不会注册（recommendStageTools 返回 false）；这里覆盖「万一被调用」
  const awd = createStageAdapter({
    awdRoundInfo: async () => {
      throw new LingxuError('该赛事没有 AWD 赛段：该赛事没有AWD赛段', {
        httpStatus: 400, code: LINGXU_CODES.NO_AWD_STAGE, platformMessage: '该赛事没有AWD赛段',
      })
    },
  })
  const awdOut = await stageHarness({ adapter: awd }).tools.ctf_awd_status.execute({})
  assert.match(awdOut, /本赛事没有 AWD 赛段/)
  assert.match(awdOut, /testTypes 里没有 id=3/)
  assert.match(awdOut, /ctf_challenges/)
  assert.doesNotMatch(awdOut, /^❌/)

  const cfs = createStageAdapter({
    cfsChallenges: async () => {
      throw new LingxuError('该赛事没有 CFS 赛段', {
        httpStatus: 400, code: LINGXU_CODES.NO_CFS_STAGE, platformMessage: '该赛事没有cfs赛段',
      })
    },
  })
  const cfsOut = await stageHarness({ adapter: cfs }).tools.ctf_cfs_list.execute({})
  assert.match(cfsOut, /本赛事没有 CFS 赛段/)
  assert.match(cfsOut, /testTypes 里没有 id=4/)
})

test('赛段工具：能直接过 defineTool 注册（宿主路径），required 参数由 schema 兜底', async () => {
  const { defineTool } = await import('../lib/toolkit.js')
  const specs = [...buildAwdToolSpecs(), ...buildCfsToolSpecs()]
  const registered = specs.map((spec) => defineTool(spec))
  assert.equal(registered.length, 16)
  for (const tool of registered) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} 的 parameters 不是 JSON Schema`)
    assert.equal(typeof tool.execute, 'function')
  }
  // required 参数写进了 JSON Schema（宿主会先校验）
  const detail = registered.find((tool) => tool.name === 'ctf_awd_detail')
  assert.deepEqual([...detail.parameters.required].sort(), ['caId', 'catId'])
  await assert.rejects(() => detail.execute({ catId: 11 }), /invalid arguments/)
  const submit = registered.find((tool) => tool.name === 'ctf_cfs_submit')
  assert.deepEqual([...submit.parameters.required].sort(), ['cctId', 'flag'])
})

test('赛段上报：ctf_status / ctf_session 把 eventSummary 原对象交给宿主回调', async () => {
  const adapter = createStageAdapter()
  const seen = []
  const { tools } = createHarness({ adapter, deps: { onStageInfo: (summary) => seen.push(summary) } })

  const statusOut = await tools.ctf_status.execute({})
  assert.match(statusOut, /📊 赛事总览/)
  assert.equal(seen.length, 1, 'ctf_status 应回报一次赛段信息')
  // 必须是 eventSummary 的原对象（带 testTypes + hasXxx），不能是拼出来的 {hasAwd,hasCfs}
  assert.equal(seen[0].name, '凌虚测试赛')
  assert.equal(Array.isArray(seen[0].testTypes), true, '要带上 testTypes（三态判定依赖它）')
  assert.equal(seen[0].hasAwd, true)
  assert.equal(recommendStageTools(seen[0]).awd, true, '宿主拿它就能判定该注册哪一套')

  const sessionOut = await tools.ctf_session.execute({})
  assert.match(sessionOut, /✅ 凌虚会话有效/)
  assert.equal(seen.length, 2, 'ctf_session 也应回报一次')

  // 没有回调时静默跳过（不能因为宿主没接就崩）
  const plain = createHarness({ adapter })
  assert.match(await plain.tools.ctf_status.execute({}), /📊 赛事总览/)
  assert.match(await plain.tools.ctf_session.execute({}), /✅ 凌虚会话有效/)

  // 回调抛错 / 异步 rejection / 非函数 → 都不影响工具输出
  const boom = createHarness({ adapter, deps: { onStageInfo: () => { throw new Error('sync boom') } } })
  assert.match(await boom.tools.ctf_status.execute({}), /📊 赛事总览/)
  const asyncBoom = createHarness({ adapter, deps: { onStageInfo: async () => { throw new Error('async boom') } } })
  assert.match(await asyncBoom.tools.ctf_status.execute({}), /📊 赛事总览/)
  const notFn = createHarness({ adapter, deps: { onStageInfo: 'not-a-function' } })
  assert.match(await notFn.tools.ctf_status.execute({}), /📊 赛事总览/)
  await new Promise((resolve) => setTimeout(resolve, 10)) // 让异步 rejection 走完，确认没有 unhandled rejection 崩测试
})


test('isEnvLimitError：兜底识别「请释放后启动」半句文案', async () => {
  const { isEnvLimitError } = await import('../lib/tools.js')
  // 完整版
  assert.equal(isEnvLimitError({ code: 'env-limit' }), true)
  assert.equal(
    isEnvLimitError({ platformMessage: '当前赛事限制启动2个题目环境，请释放后启动' }),
    true,
  )
  // 兜底：某些平台版本可能只剩后半句 —— reviewer 指出这种文案下 agent 会卡在裸「启动失败」
  assert.equal(isEnvLimitError({ platformMessage: '环境不足，请释放后启动' }), true)
  assert.equal(isEnvLimitError({ message: 'please 请释放后启动 now' }), true)
  // 不能误判
  assert.equal(isEnvLimitError({ platformMessage: '该题目没有选择对应的环境，请联系管理员。' }), false)
  assert.equal(isEnvLimitError(null), false)
})

//  释放即让位（就绪题点名）

test('ctf_release_env：释放后点名「就绪待环境」的题（准备 agent / PREP.md）', async () => {
  const workDir = await makeTmpDir()
  const store = await makeStore()
  // 两道就绪题：一道有准备 agent 标记、一道有真实 PREP.md；一道没准备的题不应出现
  await store.upsertChallengeWork(CONNECTION.key, '201', {
    challengeId: '201', subject: '[Pwn] ready-a (300分)', writeScope: 'lingxu-ctf-work/challenges/ready-a-201',
    status: 'prep', prepTeammate: 'prep-ready-a-201', taskType: 1,
  })
  const prepDir = path.join(workDir, 'challenges', 'ready-b-202')
  await fsp.mkdir(prepDir, { recursive: true })
  await fsp.writeFile(path.join(prepDir, 'PREP.md'), '# P0\n', 'utf8')
  await store.upsertChallengeWork(CONNECTION.key, '202', {
    challengeId: '202', subject: '[Pwn] ready-b (200分)', writeScope: 'lingxu-ctf-work/challenges/ready-b-202', taskType: 1,
  })
  await store.upsertChallengeWork(CONNECTION.key, '203', {
    challengeId: '203', subject: '[Web] not-ready (100分)', writeScope: 'lingxu-ctf-work/challenges/not-ready-203', taskType: 1,
  })
  // 已占着环境的题不算「等待」
  await store.upsertChallengeWork(CONNECTION.key, '204', {
    challengeId: '204', subject: '[Pwn] busy (100分)', writeScope: 'lingxu-ctf-work/challenges/busy-204',
    envStarted: true, envReleased: false, prepTeammate: 'prep-busy-204',
  })

  const adapter = createAdapter()
  const { tools } = createHarness({ adapter, store, config: { workDir } })
  const out = await tools.ctf_release_env.execute({ id: 102 }, { cwd: workDir })

  assert.match(out, /🧹 已释放题目 #102 的环境/)
  assert.match(out, /♻️ 已让出 1 个环境配额；当前有 2 道题已就绪/)
  assert.match(out, /#201 \[Pwn\] ready-a \(300分\)（准备 agent: prep-ready-a-201）/)
  assert.match(out, /#202 \[Pwn\] ready-b \(200分\)（PREP\.md 已就绪）/)
  assert.doesNotMatch(out, /not-ready/, '没准备的题不该被点名')
  assert.doesNotMatch(out, /#204/, '占着环境的题不算等待')
  assert.match(out, /ctf_solve_start` 会把配额优先给这些题/)
})

test('ctf_release_env：没有就绪题时给出「配额空着」的下一步', async () => {
  const workDir = await makeTmpDir()
  const store = await makeStore()
  await store.upsertChallengeWork(CONNECTION.key, '301', {
    challengeId: '301', subject: '[Pwn] plain (100分)', writeScope: 'lingxu-ctf-work/challenges/plain-301',
  })
  const out = await createHarness({ adapter: createAdapter(), store, config: { workDir } })
    .tools.ctf_release_env.execute({ id: 102 }, { cwd: workDir })
  assert.match(out, /🧹 已释放题目 #102 的环境/)
  assert.match(out, /暂无「就绪待环境」的题/)
})

test('ctf_solve_start / ctf_solve_status 的描述写清两阶段调度', () => {
  const { tools } = createHarness()
  const start = tools.ctf_solve_start.description
  assert.match(start, /两阶段派发/)
  assert.match(start, /离线准备 agent/)
  assert.match(start, /PREP\.md/)
  assert.match(start, /不让 agent 干等/)
  const status = tools.ctf_solve_status.description
  assert.match(status, /就绪待环境/)
  assert.match(status, /准备中/)
  assert.match(status, /环境占用异常/)
  assert.match(status, /只提示不自动抢占/)
})

test('ctf_solve_start / ctf_solve_status 的描述写清 teammate 上限的来源与降级建议', () => {
  const { tools } = createHarness()
  const start = tools.ctf_solve_start.description
  assert.match(start, /maxMembers/)
  assert.match(start, /不含 lead/)
  assert.match(start, /DSH 默认 16/)
  assert.match(start, /不静默丢题/)
  assert.match(start, /ctf_solve_stop/)
  const status = tools.ctf_solve_status.description
  assert.match(status, /成员 N\/M（上限来源：运行时配置 maxMembers \/ 报错自学习 \/ 默认值）/)
})

test('ctf_solve_start / ctf_solve_status 的描述写清 Agent 池（复用闲置槽）', () => {
  const { tools } = createHarness()
  const start = tools.ctf_solve_start.description
  assert.match(start, /Agent 池/)
  assert.match(start, /可复用的执行槽/)
  assert.match(start, /累计且不可回收/)
  assert.match(start, /峰值并发/)
  assert.match(start, /reuseAgents=false/)
  assert.match(start, /完全忽略/)
  const status = tools.ctf_solve_status.description
  assert.match(status, /Agent 池/)
  assert.match(status, /闲置可复用/)
})

//  设置页同步与来源提示

test('ctf_connect：成功后回写设置页，且**只写非 secret 字段**（绝不动 cookie）', async () => {
  const adapter = createAdapter()
  const synced = []
  const created = createHarness({
    adapter,
    store: await makeStore(),
    deps: {
      syncSettings: async (patch) => { synced.push(patch); return { ok: true, ns: 'lingxu-ctf' } },
    },
  })
  const out = await created.tools.ctf_connect.execute({
    baseUrl: 'https://h:8000', eventId: 7, cookie: 'sessionid=abc; csrftoken=x', label: '数信杯 Agent 测试赛',
  })
  assert.match(out, /✅ 已连接凌虚赛事平台/)
  assert.equal(synced.length, 1)
  assert.deepEqual(synced[0], { baseUrl: 'https://h:8000', eventId: 7, label: '数信杯 Agent 测试赛' })
  assert.equal('cookie' in synced[0], false, '⚠️ cookie 是 secret，绝不能回写（脱敏值会覆盖真实 Cookie）')
  assert.match(out, /- 设置页已同步: baseUrl\/eventId\/label → lingxu-ctf（Cookie 保持设置页原值，不回写 secret）/)

  // store 里记下同步结果（解析连接时要用）
  const conn = await created.store.getActiveConnection()
  assert.equal(conn.settingsSync, 'ok')
  assert.equal(conn.eventId, 7)
})

test('ctf_connect：设置页同步失败时明确告知（并标记 settingsSync=failed）', async () => {
  const adapter = createAdapter()
  const created = createHarness({
    adapter,
    store: await makeStore(),
    deps: { syncSettings: async () => ({ ok: false, reason: 'settings 服务不可用（未安装 dsh-settings？）', ns: null }) },
  })
  const out = await created.tools.ctf_connect.execute({ baseUrl: 'https://h:8000', eventId: 7, cookie: 'sessionid=abc' })
  assert.match(out, /⚠️ 未能回写设置页（settings 服务不可用/)
  assert.match(out, /本次连接已保存到本地，并以「本地已存连接」优先/)
  assert.equal((await created.store.getActiveConnection()).settingsSync, 'failed')

  // 宿主没提供 syncSettings（老组合）也不能崩
  const plain = createHarness({ adapter: createAdapter() })
  const plainOut = await plain.tools.ctf_connect.execute({ baseUrl: 'https://h:8000', eventId: 7, cookie: 'sessionid=abc' })
  assert.match(plainOut, /宿主未提供设置页同步能力/)
})

test('connectionOriginLines：来源 + Cookie 来源 + 不一致提示', () => {
  const lines = connectionOriginLines({
    platform: 'lingxu', baseUrl: 'https://h:8000', eventId: 7, originText: '设置页配置', cookieFrom: '设置页',
    mismatch: { settingsKey: 'lingxu:h:8000:7', storeKey: 'lingxu:h:8000:4', fields: ['eventId'] },
  })
  assert.equal(lines.length, 3)
  assert.match(lines[0], /- 连接来源: 设置页配置｜Cookie 来源: 设置页/)
  assert.match(lines[1], /⚠️ 设置页与本地连接不一致：设置页 lingxu:h:8000:7（eventId 不同），本地还存着 lingxu:h:8000:4/)
  assert.match(lines[2], /改完立即生效/)

  assert.deepEqual(connectionOriginLines({ platform: 'lingxu', baseUrl: 'https://h:8000', eventId: 4 }), [])
  assert.deepEqual(connectionOriginLines(null), [])
})

test('ctf_status / ctf_session / ctf_connect 输出里带上连接来源', async () => {
  const adapter = createAdapter()
  const connection = {
    platform: 'lingxu', baseUrl: 'https://h:8000', eventId: 7, key: 'lingxu:h:8000:7',
    originText: '设置页配置', cookieFrom: '本地连接 lingxu:h:8000:7',
    mismatch: { settingsKey: 'lingxu:h:8000:7', storeKey: 'lingxu:h:8000:4', fields: ['eventId'] },
  }
  const { tools } = createHarness({ adapter, connection })
  const status = await tools.ctf_status.execute({})
  assert.match(status, /- 连接来源: 设置页配置｜Cookie 来源: 本地连接 lingxu:h:8000:7/)
  assert.match(status, /⚠️ 设置页与本地连接不一致/)
  const session = await tools.ctf_session.execute({})
  assert.match(session, /- 连接来源: 设置页配置/)
})

test('connectionOriginLines：Cookie 来自同平台连接时解释一句（且只显示来源标签、不显示 cookie 值）', () => {
  const lines = connectionOriginLines({
    platform: 'lingxu', baseUrl: 'https://h:8000', eventId: 7,
    originText: '设置页配置', cookieFrom: '同平台连接 lingxu:h:8000:4',
    cookie: 'sessionid=super-secret-value',
  })
  const text = lines.join('\n')
  assert.match(text, /- 连接来源: 设置页配置｜Cookie 来源: 同平台连接 lingxu:h:8000:4/)
  assert.match(text, /Cookie 是\*\*平台级\*\*会话凭据，与具体赛事无关，所以复用了同平台的 lingxu:h:8000:4/)
  assert.equal(text.includes('super-secret-value'), false, '⚠️ 绝不能把 cookie 值写进输出')
})

//  工作区路径 / 赛事隔离 / 多赛事

test('resolveWorkDirInfo：会话 cwd 优先，绝不用 process.cwd()（插件软链场景）', () => {
  // ① 显式配置（绝对路径）
  assert.equal(resolveWorkDirInfo({ config: { workDir: '/tmp/my-work' } }, {}).dir, '/tmp/my-work')
  // ① 相对配置 → 按会话 cwd 解析
  const relative = resolveWorkDirInfo({ config: { workDir: 'work/sub' } }, { cwd: '/tmp/session' })
  assert.equal(relative.dir, path.join('/tmp/session', 'work/sub'))
  assert.equal(relative.source, 'config-relative')
  // ② exec.cwd（DSH 传给工具的调用者会话工作目录）
  const byExec = resolveWorkDirInfo({ config: {} }, { cwd: '/tmp/session' })
  assert.equal(byExec.dir, path.join('/tmp/session', 'lingxu-ctf-work'))
  assert.equal(byExec.source, 'exec-cwd')
  assert.equal(byExec.fallback, false)
  // ③ 会话 header 里的 cwd
  const byHeader = resolveWorkDirInfo({ config: {} }, { agent: { session: { header: { cwd: '/tmp/ws' } } } })
  assert.equal(byHeader.dir, path.join('/tmp/ws', 'lingxu-ctf-work'))
  assert.equal(byHeader.source, 'session-cwd')
  // ④ 都没有 → 家目录兜底 + 标记 fallback（工具输出里会警告用户）
  const home = resolveWorkDirInfo({ config: {} }, {})
  assert.equal(home.dir, path.join(os.homedir(), 'lingxu-ctf-work'))
  assert.equal(home.fallback, true)
  assert.notEqual(home.dir, path.join(process.cwd(), 'lingxu-ctf-work'), '⚠️ 不能落到插件进程目录')
  assert.match(workDirNoticeLines(home)[0], /workDir 未配置且拿不到会话工作目录/)
  assert.deepEqual(workDirNoticeLines(byExec), [])
})

test('ctf_solve_start：把会话 cwd 解析出的绝对 workDir 传给编排器（teammate 才不会写错地方）', async () => {
  const calls = []
  const adapter = createAdapter()
  const { tools } = createHarness({
    adapter,
    deps: {
      orchestrator: {
        async start(args) {
          calls.push(args)
          return '## 编排已启动\n（mock）'
        },
      },
    },
  })
  await tools.ctf_solve_start.execute({ limit: 1 }, { cwd: '/Users/someone/Desktop/我的比赛' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].workDir, path.join('/Users/someone/Desktop/我的比赛', 'lingxu-ctf-work'))

  // 没有会话 cwd 时给出兜底 + 警告行
  await tools.ctf_solve_start.execute({ limit: 1 }, {})
  assert.equal(calls[1].workDir, path.join(os.homedir(), 'lingxu-ctf-work'))
})

test('ctf_writeup：把会话 workDir 传给 writeup 引擎（原来的 process.cwd() 会写到插件目录）', async () => {
  const calls = []
  const { tools } = createHarness({
    deps: {
      writeup: {
        async generate(args) {
          calls.push(args)
          return '✅ WP 已生成'
        },
      },
    },
  })
  const out = await tools.ctf_writeup.execute({ id: 5, body: 'x' }, { cwd: '/tmp/ws' })
  assert.match(out, /WP 已生成/)
  assert.equal(calls[0].workDir, '/tmp/ws', '传会话 cwd（writeup 内部再拼 lingxu-ctf-work）')
})

test('ctf_status：提交审计按当前赛事过滤 + 多赛事可见性（②）', async () => {
  const dir = await makeTmpDir()
  const store = new CtfStore({ dir })
  const A = 'lingxu:h:8000:4'
  const B = 'lingxu:h:8000:7'
  await store.upsertConnection({ platform: 'lingxu', baseUrl: 'https://h:8000', eventId: 4, cookie: 'sessionid=a', label: '题目测试' })
  await store.recordSubmission({ connKey: A, challengeId: '1', flag: 'flag{a}', status: 'correct' })
  await store.recordSubmission({ connKey: A, challengeId: '2', flag: 'flag{a2}', status: 'incorrect' })
  await store.recordSubmission({ connKey: B, challengeId: '9', flag: 'flag{b}', status: 'correct' })

  const adapter = createAdapter()
  const connection = { platform: 'lingxu', baseUrl: 'https://h:8000', eventId: 7, label: '数信杯 Agent 测试赛', key: B, originText: '设置页配置' }
  const { tools } = createHarness({ adapter, store, connection })
  const out = await tools.ctf_status.execute({})

  assert.match(out, /- 提交审计: 本赛事 1 次（成功 1 \/ 错误 0）/, '只统计当前赛事（B 那 1 条）')
  assert.match(out, /另有 2 条其它赛事的提交记录/, '其它赛事的记录要说明而不是混进来')
  assert.doesNotMatch(out, /本赛事 3 次/)
  // ② 多赛事：当前 + 其它可用连接 + 切换方式
  // 当前赛事来自设置页（store 里还没有）→ 列表要把它补进「已知赛事」并提示可以记住它
  assert.match(out, /- 已知赛事（2）：当前 ✅ lingxu:h:8000:7（数信杯 Agent 测试赛）/)
  assert.match(out, /- lingxu:h:8000:4（题目测试） eventId=4｜切换：ctf_connect baseUrl=https:\/\/h:8000 eventId=4 cookie=<你的 sessionid>/)
  assert.match(out, /ℹ️ 当前赛事来自设置页、还没存进本地/)

  // 只有一条已知连接时给添加提示
  const single = await createHarness({ adapter, store: await makeStore(), connection })
  assert.match(await single.tools.ctf_status.execute({}), /- 已知赛事: 只有当前这一条/)
})

test('resolveAdapterFor：解析后记下「当前赛事」（submissions/面板靠它隔离）', async () => {
  const store = new CtfStore({ dir: await makeTmpDir() })
  const adapter = createAdapter()
  const { tools } = createHarness({ adapter, store, connection: { ...CONNECTION, key: 'lingxu:h:8000:7' } })
  await tools.ctf_challenges.execute({})
  assert.equal(await store.getActiveConnKey(), 'lingxu:h:8000:7')
})
