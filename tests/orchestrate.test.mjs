/**
 * lib/orchestrate.js 单元测试（node:test，零依赖）。
 *
 * 覆盖：过滤/排序/截断、名字清洗与去重、spawn 数量不超过 concurrency、spawn 失败容错、
 * teams 缺失报错、status 汇总、stop 中断与释放环境、prompt 自包含性。
 *
 * 运行：node --test tests/orchestrate.test.mjs
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'

import {
  LIMITS,
  allocateName,
  buildMemberDescription,
  buildSolverPrompt,
  buildTaskDescription,
  challengeIdFromScope,
  createOrchestrator,
  parseChallengeId,
  parseMemberDescription,
  parseTaskSubject,
  pathSlug,
  sanitizeSlug,
  selectChallenges,
  taskSubjectFor,
  teammateNameFor,
  writeScopeFor,
} from '../lib/orchestrate.js'
import { CtfStore } from '../lib/store.js'
import { slugify as indexSlugify } from '../lib/index.js'
import { buildToolSpecs } from '../lib/tools.js'

const CONNECTION = {
  key: 'lingxu:host:8000:4',
  platform: 'lingxu',
  baseUrl: 'https://host:8000',
  eventId: 4,
  cookie: 'sessionid=super-secret',
}
const AGENT = { id: 'agent-lead', name: 'lead' }
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const tmpDirs = []
async function makeTmpDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-orch-'))
  tmpDirs.push(dir)
  return dir
}
async function makeStore() {
  const dir = await makeTmpDir()
  return new CtfStore({ dir })
}
after(async () => {
  await Promise.all(tmpDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })))
})

function makeChallenge(overrides = {}) {
  return { id: 1, name: 'web', category: 'web', score: 100, solved: false, parseCount: 0, begun: false, ...overrides }
}

function makeTeams({ members = [], spawnImpl = null, createTaskImpl = null } = {}) {
  const calls = { spawn: [], createTask: [], listTasks: 0, listMembers: 0, interrupt: [], updateTask: [] }
  const taskList = []
  let seq = 0
  const teams = {
    async spawnTeammate(caller, request) {
      calls.spawn.push({ caller, request })
      if (spawnImpl) return await spawnImpl(request, calls.spawn.length)
      return { id: `child-${request.name}`, name: request.name, role: 'teammate', status: 'provisioning' }
    },
    async createTask(caller, request) {
      calls.createTask.push({ caller, request })
      if (createTaskImpl) return await createTaskImpl(request, calls.createTask.length)
      seq += 1
      const task = {
        id: `task-${seq}`,
        revision: 1,
        status: 'pending',
        subject: request.subject,
        description: request.description,
        writeScopes: request.writeScopes ?? [],
        blockedBy: [],
      }
      taskList.push(task)
      return task
    },
    listTasks() {
      calls.listTasks += 1
      return taskList.map((task) => ({ ...task }))
    },
    getTask(_caller, id) {
      return taskList.find((task) => task.id === id)
    },
    async updateTask(caller, request) {
      calls.updateTask.push({ caller, request })
      return request
    },
    listMembers() {
      calls.listMembers += 1
      return members.map((member) => ({ ...member }))
    },
    async interrupt(caller, name) {
      calls.interrupt.push({ caller, name })
      return { previousStatus: 'running' }
    },
    async sendMessage(caller, request) {
      return { id: 'msg-1', caller, request }
    },
  }
  return { teams, calls, taskList }
}

function makeAdapter(challenges, { releaseImpl = null } = {}) {
  const calls = { release: [] }
  const adapter = {
    async challenges() {
      return challenges
    },
    async releaseEnvironment(id) {
      calls.release.push(String(id))
      if (releaseImpl) return await releaseImpl(id)
      return { released: true }
    },
  }
  return { adapter, calls }
}

async function makeOrchestrator({
  challenges = [],
  teams = null,
  store = null,
  config = {},
  releaseImpl = null,
  adapterOverride = null,
  resolveError = null,
} = {}) {
  const { adapter, calls } = makeAdapter(challenges, { releaseImpl })
  const resolved = { fail: Boolean(resolveError) }
  const deps = {
    config: { concurrency: 4, ...config },
    teams,
    store,
    now: () => 1700000000000,
    resolveAdapter: async () => {
      if (resolved.fail) throw new Error(resolveError)
      return { adapter: adapterOverride ?? adapter, connection: CONNECTION }
    },
  }
  return { orchestrator: createOrchestrator(deps), adapter, adapterCalls: calls, resolved }
}

// ---------------------------------------------------------------- 纯函数

test('sanitizeSlug：非 [a-z0-9-] 一律换成 -，空串回退', () => {
  assert.equal(sanitizeSlug('Web-签到 1'), 'web-1')
  assert.equal(sanitizeSlug('a_b.c'), 'a-b-c')
  assert.equal(sanitizeSlug('  ***  '), '')
  assert.equal(sanitizeSlug(''), '')
  assert.equal(sanitizeSlug(undefined), '')
  assert.equal(sanitizeSlug('x'.repeat(80)).length, LIMITS.slugMaxLength)
  assert.equal(sanitizeSlug('--a--b--'), 'a-b')
})

test('teammateNameFor：lower-kebab-case、清洗失败回退、长度不超限', () => {
  assert.equal(teammateNameFor({ id: 101, name: 'Web 签到' }), 'solver-web-101')
  assert.equal(teammateNameFor({ id: 7, name: '!!!' }), 'solver-ch-7')
  assert.equal(teammateNameFor({ id: 7, name: '!!!', category: 'Pwn' }), 'solver-pwn-7')
  const long = teammateNameFor({ id: 123456, name: '极其冗长的中文题目名称'.repeat(6) })
  assert.match(long, NAME_RE)
  assert.ok(long.length <= LIMITS.maxMemberNameLength)
  assert.match(teammateNameFor({ id: 'a b/c' }), NAME_RE)
})

test('allocateName：重名自动加后缀，失败的名字也算占用', () => {
  assert.equal(allocateName('solver-web-1', new Set()), 'solver-web-1')
  assert.equal(allocateName('solver-web-1', new Set(['solver-web-1'])), 'solver-web-1-2')
  assert.equal(allocateName('solver-web-1', new Set(['solver-web-1', 'solver-web-1-2'])), 'solver-web-1-3')
  const numeric = new Set(['solver-web-1', ...Array.from({ length: 8 }, (_, i) => `solver-web-1-${i + 2}`)])
  assert.match(allocateName('solver-web-1', numeric, 'seed'), /^solver-web-1-seed$/)
  const seeded = allocateName('solver-web-1', new Set([...numeric, 'solver-web-1-seed']), 'seed')
  assert.match(seeded, /^solver-web-1-seed2$/)
})

test('selectChallenges：过滤未解/分类/分值/指定 id，按分值降序并截断', () => {
  const rows = [
    makeChallenge({ id: 1, name: 'a', category: 'web', score: 100 }),
    makeChallenge({ id: 2, name: 'b', category: 'pwn', score: 300 }),
    makeChallenge({ id: 3, name: 'c', category: 'web', score: 200, solved: true }),
    makeChallenge({ id: 4, name: 'd', category: 'web', score: 500 }),
    makeChallenge({ id: 5, name: 'e', category: 'misc', score: 500 }),
  ]
  assert.deepEqual(selectChallenges(rows).map((c) => c.id), [4, 5, 2, 1])
  assert.deepEqual(selectChallenges(rows, { category: 'WEB' }).map((c) => c.id), [4, 1])
  assert.deepEqual(selectChallenges(rows, { category: 'web,pwn' }).map((c) => c.id), [4, 2, 1])
  assert.deepEqual(selectChallenges(rows, { minScore: 250 }).map((c) => c.id), [4, 5, 2])
  assert.deepEqual(selectChallenges(rows, { includeSolved: true, limit: 2 }).map((c) => c.id), [4, 5])
  assert.deepEqual(selectChallenges(rows, { includeSolved: true, challengeIds: ['1', 3] }).map((c) => c.id), [3, 1])
  assert.deepEqual(selectChallenges([], {}), [])
  assert.deepEqual(selectChallenges(null, {}), [])
})

test('taskSubjectFor / writeScopeFor：格式与 DSH write scope 约束', () => {
  assert.equal(taskSubjectFor({ id: 12, name: 'babyheap', category: 'pwn', score: 300 }), '[pwn] babyheap (300分)')
  assert.equal(taskSubjectFor({ id: 12, name: 'x' }), '[未分类] x (0分)')
  const scope = writeScopeFor({ id: 12, name: 'Baby Heap!' })
  assert.equal(scope, 'lingxu-ctf-work/challenges/baby-heap!-12')
  assert.ok(!scope.startsWith('/'))
  assert.ok(!scope.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
})

// ---------------------------------------------------------------- 机器可读契约（/lingxu-ctf/team 依赖）

test('契约：任务 description 的 challengeId 是独立一行', () => {
  const description = buildTaskDescription({
    challenge: { id: 12, name: 'babyheap', category: 'pwn', score: 300 },
    connection: CONNECTION,
    connKey: CONNECTION.key,
    taskId: 'task-3',
  })
  const lines = description.split('\n')
  assert.equal(lines[0], 'challengeId: 12', '首行必须是机器可读契约行')
  assert.equal(parseChallengeId(description), '12')
  // 任务板任务 id 与写入范围仍要在
  assert.match(description, /task-3/)
  assert.match(description, /lingxu-ctf-work\/challenges\/babyheap-12/)
})

test('parseChallengeId：独立行 / 全角冒号 / 等号 / 列表符号 / 行内提及', () => {
  assert.equal(parseChallengeId('challengeId: 12'), '12')
  assert.equal(parseChallengeId('challengeId：12'), '12')
  assert.equal(parseChallengeId('challengeId = 12'), '12')
  assert.equal(parseChallengeId('challengeId:12'), '12')
  assert.equal(parseChallengeId('  challengeId:   12  '), '12')
  assert.equal(parseChallengeId('CHALLENGEID: 12'), '12', '键名大小写不敏感')
  assert.equal(parseChallengeId('challengeId: baby-heap_12'), 'baby-heap_12')
  assert.equal(parseChallengeId('challengeId: 12（baby heap）'), '12', '值后面的说明文字要忽略')
  // 列表 / 引用 / 有序列表前缀
  assert.equal(parseChallengeId('- challengeId: 3'), '3')
  assert.equal(parseChallengeId('* challengeId：3'), '3')
  assert.equal(parseChallengeId('1. challengeId: 3'), '3')
  assert.equal(parseChallengeId('# challengeId: 3'), '3')
  // 多行：取第一条命中（前面的无关行不影响）
  assert.equal(parseChallengeId('题目：x\n\nchallengeId: 7\n分类：pwn'), '7')
  // 行内提及（teammate description 的格式）
  assert.equal(parseChallengeId('解题 teammate：Crypto/NeuroSign（100分，challengeId=1）'), '1')
  assert.equal(parseChallengeId('（challengeId: 9）'), '9')
  // 不能误命中把别的词当键
  assert.equal(parseChallengeId('mychallengeId: 5'), null)
  assert.equal(parseChallengeId('challengeIds: 5'), null)
  assert.equal(parseChallengeId('没有这个键'), null)
  assert.equal(parseChallengeId('challengeId: '), null, '空值 = 没解析到')
  assert.equal(parseChallengeId('challengeId:（缺失）'), null)
  // 畸形输入不抛
  assert.equal(parseChallengeId(null), null)
  assert.equal(parseChallengeId(undefined), null)
  assert.equal(parseChallengeId(42), null)
  assert.equal(parseChallengeId({}), null)
  assert.equal(parseChallengeId([]), null)
  // 行内兜底：句子里提到 challengeId 也能解出来（旧格式 / 手写 description）
  assert.equal(parseChallengeId('题目 challengeId: 12 已解'), '12')
})

test('challengeIdFromScope：兼容外部/旧任务，长 slug 不串位', () => {
  assert.equal(challengeIdFromScope(['lingxu-ctf-work/challenges/baby-heap-12']), '12')
  assert.equal(challengeIdFromScope(['lingxu-ctf-work/challenges/固件加密服务-42']), '42')
  assert.equal(challengeIdFromScope(['lingxu-ctf-work/challenges/x-1', 'lingxu-ctf-work/challenges/y-2']), '1')
  assert.equal(challengeIdFromScope([]), null)
  assert.equal(challengeIdFromScope(null), null)
  assert.equal(challengeIdFromScope([123]), null)
})

test('parseTaskSubject：分类 / 题名 / 分值，畸形输入不抛', () => {
  assert.deepEqual(parseTaskSubject('[Crypto] NeuroSign (100分)'), {
    category: 'Crypto', name: 'NeuroSign', score: 100,
  })
  assert.deepEqual(parseTaskSubject('[未分类] x (0分)'), { category: '未分类', name: 'x', score: 0 })
  assert.deepEqual(parseTaskSubject('NeuroSign (100分)'), { category: null, name: 'NeuroSign', score: 100 })
  assert.deepEqual(parseTaskSubject('[Web] 签到题'), { category: 'Web', name: '签到题', score: null })
  assert.deepEqual(parseTaskSubject(''), { category: null, name: null, score: null })
  assert.deepEqual(parseTaskSubject(null), { category: null, name: null, score: null })
  assert.deepEqual(parseTaskSubject(7), { category: null, name: '7', score: null })
})

test('buildMemberDescription / parseMemberDescription：双向契约', () => {
  const challenge = { id: 1, name: 'NeuroSign', category: 'Crypto', score: 100 }
  const description = buildMemberDescription(challenge)
  assert.equal(description, '解题 teammate：Crypto/NeuroSign（100分，challengeId=1）')
  assert.deepEqual(parseMemberDescription(description), {
    challengeId: '1', category: 'Crypto', challengeName: 'NeuroSign', score: 100,
  })
  // 中文题名 / 缺字段也要稳
  const chinese = buildMemberDescription({ id: 42, name: '固件加密服务', category: 'IoT', score: 300 })
  assert.deepEqual(parseMemberDescription(chinese), {
    challengeId: '42', category: 'IoT', challengeName: '固件加密服务', score: 300,
  })
  assert.deepEqual(parseMemberDescription(buildMemberDescription({ id: 5 })), {
    challengeId: '5', category: '未分类', challengeName: null, score: 0,
  })
  // 畸形输入不抛
  assert.deepEqual(parseMemberDescription(null), { challengeId: null, category: null, challengeName: null, score: null })
  assert.deepEqual(parseMemberDescription('随便写的一句话'), {
    challengeId: null, category: null, challengeName: null, score: null,
  })
})

test('pathSlug：保留中文可读性，只替换路径危险字符，截断不切代理对', () => {
  // 中文题名不再被清空（docs-dev 报的问题）
  assert.equal(pathSlug('AIoT固件加密服务', 42), 'aiot固件加密服务')
  assert.equal(pathSlug('固件加密服务', 7), '固件加密服务')
  assert.equal(pathSlug('  Web 签到  ', 1), 'web-签到')
  // 路径危险字符 + 控制字符 → '-'
  assert.equal(pathSlug('a/b\\c:d*e?f"g<h>i|j', 1), 'a-b-c-d-e-f-g-h-i-j')
  assert.equal(pathSlug('a\u0000b\u001fc', 1), 'a-b-c')
  assert.equal(pathSlug('..\\..\\etc\\passwd', 1), 'etc-passwd')
  assert.equal(pathSlug('...', 9), 'challenge')
  assert.equal(pathSlug('   ', 9), 'challenge')
  assert.equal(pathSlug('', 9), 'challenge')
  assert.equal(pathSlug(undefined, undefined), 'challenge')
  // fallback 是裸 challenge：writeScopeFor 会再拼 -<id>，不能变成 ch-9-9
  assert.equal(writeScopeFor({ id: 9, name: '???' }), 'lingxu-ctf-work/challenges/challenge-9')
  // 折叠空白与连续 -
  assert.equal(pathSlug('a   ---   b', 1), 'a-b')
  // 60 码点截断且不切断代理对（emoji 各占 2 个 UTF-16 单元）
  const long = pathSlug(`题${'🔥'.repeat(80)}`, 1)
  assert.equal(Array.from(long).length, 60)
  assert.ok(!/[\uD800-\uDBFF]$/.test(long), '不能以孤立的高代理结尾')
  assert.equal(pathSlug('x'.repeat(100), 1).length, 60)
})

test('中文题名：writeScope 保留中文，teammate 名仍是纯 ASCII', () => {
  const chinese = { id: 42, name: 'AIoT固件加密服务', category: 'IoT', score: 300 }
  assert.equal(writeScopeFor(chinese), 'lingxu-ctf-work/challenges/aiot固件加密服务-42')
  assert.equal(teammateNameFor(chinese), 'solver-aiot-42')
  assert.match(teammateNameFor(chinese), NAME_RE)

  const pureChinese = { id: 7, name: '固件加密服务', category: 'IoT', score: 100 }
  assert.equal(writeScopeFor(pureChinese), 'lingxu-ctf-work/challenges/固件加密服务-7')
  assert.equal(teammateNameFor(pureChinese), 'solver-iot-7', 'teammate 名回退到 ASCII 分类')
  assert.match(teammateNameFor(pureChinese), NAME_RE)

  const nameless = { id: 8, name: '!!!', category: '', score: 10 }
  assert.equal(writeScopeFor(nameless), 'lingxu-ctf-work/challenges/!!!-8')
  assert.equal(teammateNameFor(nameless), 'solver-ch-8')

  // teammate prompt 里的工作目录也用中文路径（与 writeScope 一致）
  const prompt = buildSolverPrompt({
    name: 'solver-aiot-42',
    challenge: chinese,
    taskId: 'task-42',
    connection: CONNECTION,
    connKey: CONNECTION.key,
    workDir: 'lingxu-ctf-work',
  })
  const text = prompt.map((block) => block.text).join('\n')
  assert.match(text, /lingxu-ctf-work\/challenges\/aiot固件加密服务-42/)
  assert.match(text, /solver-aiot-42/)
})

// ---------------------------------------------------------------- 跨模块 slug 契约

/**
 * 编排层用 slug 决定 solver 的工作目录（prompt / writeScope），而 `ctf_challenge`（tools.js）
 * 用它把附件下载到 `challenges/<slug>-<id>/distfiles/`。两者必须逐字一致，否则 solver 会
 * 被指到一个没有附件的目录。index.js / tools.js / writeup.js / orchestrate.js 四份实现同规则。
 */
test('跨模块契约：pathSlug 与 index.slugify 对 5 个题名逐字一致（全角括号是核心）', () => {
  const names = [
    '签到题（Web 入门）', // 全角括号：NFKC 会折叠成半角，导致与 tools.js 的目录不一致
    'Baby Heap!',
    'a/b:c',
    'café ☕ CTF',
    '中'.repeat(80), // 超长中文：按码点/UTF-16 截断在 BMP 上等价
  ]
  for (const name of names) {
    assert.equal(pathSlug(name, 12), indexSlugify(name), `slug 必须与 index.slugify 一致：${name}`)
  }
  // 退化题名（全为危险字符/空白）：fallback 也必须是裸 `challenge`，否则 writeScope 会变成
  // `ch-12-12`，而 ctf_challenge 建的是 `challenge-12`（多一个 id，solver 找不到附件）
  for (const name of ['???', '***', '///', '   ', '...']) {
    assert.equal(pathSlug(name, 12), indexSlugify(name), `退化题名 fallback 必须一致：${name}`)
    assert.equal(writeScopeFor({ id: 12, name }), `lingxu-ctf-work/challenges/${indexSlugify(name)}-12`)
  }
  // 回归护栏：不得再做 NFKC 归一化
  assert.equal(pathSlug('签到题（Web 入门）', 12), '签到题（web-入门）')
  assert.notEqual(pathSlug('签到题（Web 入门）', 12), '签到题(web-入门)')
})

test('跨模块契约：writeScope / solver prompt 的目录 == ctf_challenge 实际创建的目录', async () => {
  const workDir = await makeTmpDir()
  const challenges = [
    { id: 12, name: '签到题（Web 入门）', category: 'Web', score: 100, solved: false },
    { id: 13, name: '???', category: 'misc', score: 50, solved: false }, // 退化名 → challenge-13
  ]
  const byId = new Map(challenges.map((challenge) => [String(challenge.id), challenge]))
  const adapter = {
    async challengeDetail(id) {
      const challenge = byId.get(String(id))
      return {
        id,
        name: challenge.name,
        description: '# 题面',
        descriptionHtml: '<h1>题面</h1>',
        attachment: 'https://host:8000/media/quiz.zip',
        attachments: [],
        score: challenge.score,
        solves: 3,
        requiresEnv: false,
        checkMode: false,
        connectionInfo: '',
      }
    },
    async downloadAttachment(_url, destPath) {
      await fsp.mkdir(path.dirname(destPath), { recursive: true })
      await fsp.writeFile(destPath, 'zipdata', 'utf8')
      return { path: destPath, bytes: 7 }
    },
  }
  const specs = buildToolSpecs({
    config: { concurrency: 4, workDir },
    resolveAdapter: async () => ({ adapter, connection: CONNECTION }),
    logger: { info() {}, warn() {}, error() {} },
    now: () => Date.parse('2026-09-29T01:00:00Z'),
  })
  const tool = specs.find((spec) => spec.name === 'ctf_challenge')
  for (const challenge of challenges) {
    const out = await tool.execute({ id: challenge.id })
    assert.ok(!out.startsWith('❌'), `ctf_challenge 执行失败：${out}`)
  }

  // ctf_challenge 实际创建的目录
  const dirs = (await fsp.readdir(path.join(workDir, 'challenges'))).sort()
  assert.deepEqual(dirs, ['challenge-13', '签到题（web-入门）-12'])
  await fsp.access(path.join(workDir, 'challenges', '签到题（web-入门）-12', 'distfiles', 'quiz.zip'))
  await fsp.access(path.join(workDir, 'challenges', 'challenge-13', 'distfiles', 'quiz.zip'))

  // 编排层的 writeScope 与 solver prompt 必须指向同一批目录名
  for (const challenge of challenges) {
    const dirName = `${pathSlug(challenge.name, challenge.id)}-${challenge.id}`
    assert.ok(dirs.includes(dirName), `目录名必须与 ctf_challenge 一致：${dirName}`)
    assert.equal(writeScopeFor(challenge), `lingxu-ctf-work/challenges/${dirName}`)
    const prompt = buildSolverPrompt({
      name: `solver-web-${challenge.id}`,
      challenge,
      taskId: 'task-1',
      connection: CONNECTION,
      connKey: CONNECTION.key,
      workDir,
    })
    const text = prompt.map((block) => block.text).join('\n')
    assert.ok(
      text.includes(path.join(workDir, 'challenges', dirName)),
      'prompt 的工作目录必须指向附件所在目录',
    )
    assert.ok(text.includes(`lingxu-ctf-work/challenges/${dirName}`), 'prompt 的 writeScope 必须与之一致')
  }
})

// ---------------------------------------------------------------- start

test('start：建任务 + 按 concurrency 拉起 agent + 摘要', async () => {
  const store = await makeStore()
  const challenges = [
    makeChallenge({ id: 1, name: 'web-easy', category: 'web', score: 100 }),
    makeChallenge({ id: 2, name: 'pwn-hard', category: 'pwn', score: 500 }),
    makeChallenge({ id: 3, name: 'misc-mid', category: 'misc', score: 300 }),
    makeChallenge({ id: 4, name: 'crypto', category: 'crypto', score: 200 }),
    makeChallenge({ id: 5, name: 'rev', category: 'rev', score: 50, solved: true }),
  ]
  const { teams, calls } = makeTeams()
  const { orchestrator } = await makeOrchestrator({ challenges, teams, store, config: { concurrency: 2 } })

  const summary = await orchestrator.start({ __agent: AGENT })

  assert.equal(calls.createTask.length, 4, '已解题目不应建任务')
  assert.equal(calls.spawn.length, 2, 'spawn 数量 = concurrency')
  assert.equal(calls.createTask[0].caller, AGENT)
  assert.equal(calls.spawn[0].caller, AGENT)

  // subject / writeScopes / description 契约
  const first = calls.createTask[0].request
  assert.equal(first.subject, '[pwn] pwn-hard (500分)')
  assert.deepEqual(first.writeScopes, ['lingxu-ctf-work/challenges/pwn-hard-2'])
  assert.match(first.description, /challengeId: 2/)
  assert.match(first.description, /ctf_submit_flag/)
  assert.match(first.description, /验收标准/)
  assert.ok(first.description.length <= 16384)

  // 排序：高分先建任务、先起 agent
  assert.deepEqual(
    calls.createTask.map((c) => c.request.subject),
    ['[pwn] pwn-hard (500分)', '[misc] misc-mid (300分)', '[crypto] crypto (200分)', '[web] web-easy (100分)'],
  )

  // spawn 请求契约（真实 Agent Teams 需要 provider + AbortSignal）
  const spawn = calls.spawn[0].request
  assert.match(spawn.name, NAME_RE)
  assert.equal(spawn.name, 'solver-pwn-hard-2')
  assert.equal(spawn.context, 'fresh')
  assert.equal(spawn.provider, 'spawn')
  assert.ok(spawn.signal instanceof AbortSignal)
  assert.ok(Array.isArray(spawn.prompt))
  for (const block of spawn.prompt) {
    assert.equal(block.type, 'text')
    assert.equal(typeof block.text, 'string')
    assert.ok(block.text.length > 0)
  }
  assert.ok(spawn.description.length <= 200)

  // prompt 自包含性（fresh context 看不到 Lead 历史）
  const promptText = spawn.prompt.map((b) => b.text).join('\n')
  assert.match(promptText, /https:\/\/host:8000/)
  assert.match(promptText, /eventId=4/)
  assert.match(promptText, /lingxu:host:8000:4/)
  assert.match(promptText, /challengeId：2/)
  assert.match(promptText, /task-1/)
  assert.match(promptText, /ctf_challenge/)
  assert.match(promptText, /ctf_start_env/)
  assert.match(promptText, /ctf_submit_flag/)
  assert.match(promptText, /ctf_writeup/)
  assert.match(promptText, /complete/)
  assert.match(promptText, /send_message/)
  assert.match(promptText, /teammate "solver-pwn-hard-2"/)
  assert.doesNotMatch(promptText, /super-secret/, 'prompt 不应泄漏 cookie')

  // 摘要
  assert.match(summary, /编排已启动/)
  assert.match(summary, /创建 4 个任务/)
  assert.match(summary, /本轮拉起 2 个/)
  assert.match(summary, /solver-pwn-hard-2/)
  assert.match(summary, /排队中（2 题/)

  // store 落盘（面板 / stop 释放环境要用）
  const work = await store.listChallengeWork(CONNECTION.key)
  assert.equal(work.length, 4)
  const solving = work.filter((w) => w.status === 'solving').map((w) => w.challengeId)
  assert.deepEqual(solving.sort(), ['2', '3'])

  // 任务 createdAt 契约：DSH 任务对象没有时间戳，由编排层写进 work 记录
  assert.equal(work.every((w) => typeof w.taskCreatedAt === 'string' && w.taskCreatedAt.includes('T')), true)
})

test('getCaller：start/status/stop 捕获会话身份（/lingxu-ctf/team 依赖它）', async () => {
  const { teams } = makeTeams()
  const { orchestrator } = await makeOrchestrator({ challenges: [makeChallenge({ id: 1 })], teams })
  assert.equal(orchestrator.getCaller(), null, '未调用前没有身份')

  await orchestrator.start({ __agent: AGENT })
  assert.equal(orchestrator.getCaller(), AGENT)
  await orchestrator.status({ __agent: AGENT })
  assert.equal(orchestrator.getCaller(), AGENT)
  await orchestrator.stop({ __agent: AGENT })
  assert.equal(orchestrator.getCaller(), AGENT)

  // 缺少 caller 时不覆盖已捕获的身份（也不该崩）
  await assert.rejects(() => orchestrator.status({}), /需要在会话内由 Lead agent 调用/)
  assert.equal(orchestrator.getCaller(), AGENT, '失败调用不应清掉已捕获身份')
})

test('getCaller：装配层会话槽兜底（没跑过 ctf_solve_* 也能拿到身份）', async () => {
  const session = { caller: { id: 'agent-lead', name: 'lead' } }
  const { teams } = makeTeams()
  const deps = {
    config: { concurrency: 4 },
    teams,
    store: null,
    now: () => 1700000000000,
    session,
    resolveAdapter: async () => ({ adapter: { async challenges() { return [] } }, connection: CONNECTION }),
  }
  const orchestrator = createOrchestrator(deps)
  assert.equal(orchestrator.getCaller(), session.caller, '没有 solve_* 捕获时退化用会话槽')

  // solve_* 捕获的 Lead 优先，并回写会话槽
  const lead = { id: 'agent-new', name: 'lead' }
  await orchestrator.status({ __agent: lead })
  assert.equal(orchestrator.getCaller(), lead)
  assert.equal(session.caller, lead, '编排器捕获也要回写会话槽（供装配层使用）')
})

test('协同消息采集：start → spawn、status → status、stop → stop', async () => {
  const store = await makeStore()
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const { teams } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1, name: 'web-1', category: 'web', score: 100 })],
    teams,
    store,
    config: { concurrency: 1 },
  })

  await orchestrator.start({ __agent: AGENT })
  let messages = await store.listTeamMessages(CONNECTION.key)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].kind, 'spawn')
  assert.equal(messages[0].from, 'lead')
  assert.match(messages[0].text, /拉起 agent 1 个/)
  assert.match(messages[0].text, /solver-web-1/)

  await orchestrator.status({ __agent: AGENT })
  // 反复轮询：连续两次正文相同的 status 只落盘一次（避免刷掉真正的汇报）
  await orchestrator.status({ __agent: AGENT })
  assert.deepEqual((await store.listTeamMessages(CONNECTION.key)).map((m) => m.kind), ['spawn', 'status'])

  await orchestrator.stop({ __agent: AGENT, reason: '收工' })
  messages = await store.listTeamMessages(CONNECTION.key)
  assert.deepEqual(messages.map((m) => m.kind), ['spawn', 'status', 'stop'])
  assert.match(messages[1].text, /ctf_solve_status/)
  assert.match(messages[2].text, /ctf_solve_stop/)
  assert.match(messages[2].text, /收工/)
})

test('协同消息采集：store 未注入 / 不支持该方法时不影响编排', async () => {
  const { teams } = makeTeams()
  const { orchestrator } = await makeOrchestrator({ challenges: [makeChallenge({ id: 1 })], teams, store: null })
  await assert.doesNotReject(() => orchestrator.start({ __agent: AGENT }))

  // 只有 upsertChallengeWork 的旧 store：也要能跑完 start/status/stop
  const partialStore = { async upsertChallengeWork() { return {} }, async listChallengeWork() { return [] } }
  const second = await makeOrchestrator({ challenges: [makeChallenge({ id: 1 })], teams, store: partialStore })
  await assert.doesNotReject(() => second.orchestrator.start({ __agent: AGENT }))
  await assert.doesNotReject(() => second.orchestrator.status({ __agent: AGENT }))
  await assert.doesNotReject(() => second.orchestrator.stop({ __agent: AGENT }))
})

test('start：默认 limit = 全部选中题目（≤200），concurrency 硬上限 8', async () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    makeChallenge({ id: i + 1, name: `ch-${i + 1}`, score: 1000 - i, solved: false }),
  )

  const a = makeTeams()
  const oa = await makeOrchestrator({ challenges: many, teams: a.teams, config: { concurrency: 4 } })
  const summary = await oa.orchestrator.start({ __agent: AGENT })
  assert.equal(a.calls.createTask.length, 30, '默认 limit = 全部选中题目')
  assert.equal(a.calls.spawn.length, 4, '并发只由 concurrency 控制')
  assert.match(summary, /本轮处理 30 道（limit=全部，≤200）/)

  const b = makeTeams()
  const ob = await makeOrchestrator({ challenges: many, teams: b.teams, config: { concurrency: 20 } })
  await ob.orchestrator.start({ __agent: AGENT })
  assert.equal(b.calls.spawn.length, LIMITS.maxConcurrency, '并发硬上限 8')
  assert.equal(b.calls.createTask.length, 30)

  // 显式 limit 仍按传入值截断（截断发生在排序之后）
  const c = makeTeams()
  const oc = await makeOrchestrator({ challenges: many, teams: c.teams, config: { concurrency: 4 } })
  const limited = await oc.orchestrator.start({ __agent: AGENT, concurrency: 3, limit: 2 })
  assert.equal(c.calls.createTask.length, 2)
  assert.equal(c.calls.spawn.length, 2)
  assert.match(limited, /本轮处理 2 道（limit=2）/)
  assert.deepEqual(
    c.calls.createTask.map((t) => t.request.subject),
    ['[web] ch-1 (1000分)', '[web] ch-2 (999分)'],
    'limit 截断保留最高分的题',
  )
})

test('start：77 道待解题全量建任务（验收 #3），limit 上限 200', async () => {
  const seventySeven = Array.from({ length: 77 }, (_, i) =>
    makeChallenge({ id: i + 1, name: `ch-${i + 1}`, score: 500 - i, solved: false }),
  )
  const a = makeTeams()
  const oa = await makeOrchestrator({ challenges: seventySeven, teams: a.teams, config: { concurrency: 4 } })
  await oa.orchestrator.start({ __agent: AGENT })
  assert.equal(a.calls.createTask.length, 77)
  assert.equal(a.calls.spawn.length, 4)

  const twoHundredFifty = Array.from({ length: 250 }, (_, i) =>
    makeChallenge({ id: i + 1, name: `ch-${i + 1}`, score: 500 - i, solved: false }),
  )
  const b = makeTeams()
  const ob = await makeOrchestrator({ challenges: twoHundredFifty, teams: b.teams, config: { concurrency: 4 } })
  const summary = await ob.orchestrator.start({ __agent: AGENT })
  assert.equal(b.calls.createTask.length, LIMITS.maxLimit, 'limit 硬上限 200（任务板 maxTasks 256 留余量）')
  assert.equal(b.calls.spawn.length, 4)
  assert.match(summary, /排队中（196 题/)
})

test('start：已有 teammate 占名 → 自动加后缀；名字冲突 → 换名重试', async () => {
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'solver-web-1', role: 'teammate', status: 'inactive' },
  ]
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1, name: 'web' })],
    teams,
    config: { concurrency: 1 },
  })
  await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn[0].request.name, 'solver-web-1-2')

  // DSH 名字永久占用：spawn 抛重名错误时应换名重试
  const conflict = makeTeams({
    spawnImpl: (request, attempt) => {
      if (attempt === 1) {
        const error = new Error(`teammate name "${request.name}" was already used in this Team`)
        error.code = 'TEAM_MEMBER_NAME_TAKEN'
        throw error
      }
      return { name: request.name, role: 'teammate', status: 'provisioning' }
    },
  })
  const second = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1, name: 'web' })],
    teams: conflict.teams,
    config: { concurrency: 1 },
  })
  const summary = await second.orchestrator.start({ __agent: AGENT })
  assert.equal(conflict.calls.spawn.length, 2)
  assert.equal(conflict.calls.spawn[0].request.name, 'solver-web-1')
  assert.equal(conflict.calls.spawn[1].request.name, 'solver-web-1-2')
  assert.match(summary, /solver-web-1-2/)
})

test('start：spawn 失败不整体崩，记录后继续下一题', async () => {
  const { teams, calls } = makeTeams({
    spawnImpl: (request) => {
      if (request.name === 'solver-boom-1') throw new Error('provider unavailable')
      return { name: request.name, role: 'teammate', status: 'provisioning' }
    },
  })
  const { orchestrator } = await makeOrchestrator({
    challenges: [
      makeChallenge({ id: 1, name: 'boom', score: 900 }),
      makeChallenge({ id: 2, name: 'ok', score: 800 }),
    ],
    teams,
    config: { concurrency: 2 },
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 2, '失败的题不应吃掉后续题目的名额')
  assert.equal(calls.spawn[1].request.name, 'solver-ok-2')
  assert.match(summary, /拉起 agent 失败/)
  assert.match(summary, /provider unavailable/)
  assert.match(summary, /solver-ok-2/)
})

test('start：成员上限错误 → 立即停止 spawn，不反复重试', async () => {
  const { teams, calls } = makeTeams({
    spawnImpl: () => {
      const error = new Error('Team member limit 16 reached')
      error.code = 'TEAM_MEMBER_LIMIT'
      throw error
    },
  })
  const { orchestrator } = await makeOrchestrator({
    challenges: [1, 2, 3].map((id) => makeChallenge({ id, name: `c${id}` })),
    teams,
    config: { concurrency: 3 },
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 1, '成员上限时只尝试一次')
  assert.match(summary, /成员上限/)
})

test('start：已有 teammate 在跑时按并发总量扣减', async () => {
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'solver-a-1', role: 'teammate', status: 'running' },
    { name: 'solver-b-2', role: 'teammate', status: 'provisioning' },
    { name: 'solver-c-3', role: 'teammate', status: 'inactive' },
  ]
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: [1, 2, 3, 4].map((id) => makeChallenge({ id, name: `c${id}` })),
    teams,
    config: { concurrency: 3 },
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 1, '已有 2 个在跑 → 本轮只能再起 1 个')
  assert.match(summary, /本轮拉起 1 个/)
})

test('start：没有符合条件的题目 → 不建任务不起 agent', async () => {
  const { teams, calls } = makeTeams()
  const { orchestrator } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1, solved: true })],
    teams,
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.createTask.length, 0)
  assert.equal(calls.spawn.length, 0)
  assert.match(summary, /无需编排/)
})

test('start：createTask 全失败 → 返回失败摘要而不是抛异常', async () => {
  const { teams, calls } = makeTeams({
    createTaskImpl: () => {
      throw new Error('Team task limit 256 reached')
    },
  })
  const { orchestrator } = await makeOrchestrator({ challenges: [makeChallenge({ id: 1 })], teams })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 0)
  assert.match(summary, /任务一个都没建出来/)
  assert.match(summary, /Team task limit/)
})

test('start 幂等：已在任务板上的题目跳过；force=true 强制重跑', async () => {
  const store = await makeStore()
  const { teams, calls, taskList } = makeTeams()
  const { orchestrator } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1, name: 'web-1' }), makeChallenge({ id: 2, name: 'pwn-2' })],
    teams,
    store,
    config: { concurrency: 2 },
  })

  await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.createTask.length, 2)
  assert.equal(calls.spawn.length, 2)

  const second = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.createTask.length, 2, '第二次调用不应重复建任务')
  assert.equal(calls.spawn.length, 2, '第二次调用不应重复起 agent')
  assert.match(second, /已在任务板上/)

  // 任务完成后可以再次编排（completed 不算占用）
  for (const task of taskList) task.status = 'completed'
  const third = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.createTask.length, 4)
  assert.equal(calls.spawn.length, 4)
  assert.match(third, /编排已启动/)

  const forced = await orchestrator.start({ __agent: AGENT, force: true })
  assert.equal(calls.createTask.length, 6, 'force=true 无视任务板去重')
  assert.match(forced, /编排已启动/)
})

test('start：拉题目列表失败 / resolveAdapter 失败 → 清晰报错', async () => {
  const { teams } = makeTeams()
  const broken = await makeOrchestrator({
    teams,
    adapterOverride: {
      async challenges() {
        throw new Error('HTTP 401')
      },
    },
  })
  await assert.rejects(() => broken.orchestrator.start({ __agent: AGENT }), /拉取题目列表失败.*HTTP 401/)

  const noResolve = await makeOrchestrator({ teams, resolveError: '没有可用的平台连接' })
  await assert.rejects(() => noResolve.orchestrator.start({ __agent: AGENT }), /解析平台连接失败/)
})

// ---------------------------------------------------------------- 守卫

test('teams 缺失：start / status / stop 都给出清晰报错', async () => {
  const { orchestrator } = await makeOrchestrator({ challenges: [makeChallenge({ id: 1 })] })
  for (const method of ['start', 'status', 'stop']) {
    await assert.rejects(() => orchestrator[method]({ __agent: AGENT }), /Agent Teams 不可用/)
  }
})

test('缺少 __agent：报「需要在会话内由 Lead agent 调用」', async () => {
  const { teams } = makeTeams()
  const { orchestrator } = await makeOrchestrator({ challenges: [makeChallenge({ id: 1 })], teams })
  for (const method of ['start', 'status', 'stop']) {
    await assert.rejects(() => orchestrator[method]({}), /需要在会话内由 Lead agent 调用/)
  }
})

test('teams 接口不完整：报缺少的方法名（按操作校验）', async () => {
  const partial = { spawnTeammate: async () => ({}) }
  const { orchestrator } = await makeOrchestrator({ challenges: [], teams: partial })
  await assert.rejects(() => orchestrator.start({ __agent: AGENT }), /接口不完整.*createTask/s)
  await assert.rejects(() => orchestrator.status({ __agent: AGENT }), /接口不完整.*listTasks/s)
  await assert.rejects(() => orchestrator.stop({ __agent: AGENT }), /接口不完整.*interrupt/s)
})

// ---------------------------------------------------------------- status

test('status：任务板 + 平台对照表 + 统计', async () => {
  const store = await makeStore()
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'solver-web-1', role: 'teammate', status: 'running' },
    { name: 'solver-pwn-2', role: 'teammate', status: 'inactive' },
    { name: 'solver-misc-3', role: 'teammate', status: 'failed' },
  ]
  const challenges = [
    makeChallenge({ id: 1, name: 'web-1', category: 'web', score: 100, solved: true }),
    makeChallenge({ id: 2, name: 'pwn-2', category: 'pwn', score: 300, solved: false }),
    makeChallenge({ id: 3, name: 'misc-3', category: 'misc', score: 200, solved: false }),
  ]
  const { teams, taskList } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({ challenges, teams, store, config: { concurrency: 2 } })
  await orchestrator.start({ __agent: AGENT, limit: 3 })

  // 模拟 teammate 认领 + 完成
  taskList[0].status = 'in_progress'
  taskList[0].ownerName = 'solver-pwn-2'
  taskList[1].status = 'completed'
  taskList[1].ownerName = 'solver-web-1'

  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /\| 题目 \| 分类 \| 分值 \| 任务 \| 任务状态 \| owner \| 平台 \|/)
  assert.match(report, /pwn-2 \(#2\)/)
  assert.match(report, /进行中/)
  assert.match(report, /已完成/)
  assert.match(report, /solver-pwn-2/)
  assert.match(report, /已解 1 \/ 共 3 题/)
  assert.match(report, /进行中 1，待认领 0，已完成 1/)
  assert.match(report, /running 1，inactive 1，provisioning 0，failed 1/)
})

test('status：平台不可用时降级为任务板视图（不抛异常）', async () => {
  const { teams, taskList } = makeTeams()
  const { orchestrator, resolved } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1, name: 'web-1' })],
    teams,
    config: { concurrency: 1 },
  })
  await orchestrator.start({ __agent: AGENT })
  assert.equal(taskList.length, 1)

  resolved.fail = true
  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /平台题目列表获取失败/)
  assert.match(report, /任务板：共 1/)
})

test('status：外部创建的任务用 writeScope 反解 challengeId（连字符 slug 不串位）', async () => {
  const { teams, taskList } = makeTeams()
  taskList.push({
    id: 'task-99',
    revision: 1,
    status: 'in_progress',
    subject: '[pwn] babyheap (300分)',
    description: '外部（人工/旧版本）创建的任务，没有 challengeId 行',
    writeScopes: ['lingxu-ctf-work/challenges/baby-heap-12'],
    blockedBy: [],
  })
  const { orchestrator } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 12, name: 'babyheap', category: 'pwn', score: 300, solved: false })],
    teams,
  })
  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /babyheap \(#12\)/, 'writeScope 应反解出 12（旧正则会把 baby-heap-12 解成 heap-12）')
  assert.match(report, /进行中（agent 正在做）/, '平台未解但任务 in_progress → 必须标注进行中（而不是只显示未解）')
  assert.match(report, /进行中 1，待认领 0，已完成 0/)
  assert.match(report, /未建任务 0 题/, '不应再出现一条重复的排队行')
})

test('status：进行中可见 —— 任务 in_progress 与「已拉起未认领」都要标注（用户反馈）', async () => {
  const store = await makeStore()
  // busy 只算 running/provisioning：放一个 inactive 的 teammate 占名但不算并发
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'solver-pwn-2', role: 'teammate', status: 'inactive' },
  ]
  const challenges = [
    makeChallenge({ id: 1, name: 'web-1', category: 'web', score: 100, solved: false }),
    makeChallenge({ id: 2, name: 'pwn-2', category: 'pwn', score: 200, solved: false }),
    makeChallenge({ id: 3, name: 'misc-3', category: 'misc', score: 300, solved: false }),
  ]
  const { teams, taskList } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({ challenges, teams, store, config: { concurrency: 2 } })
  await orchestrator.start({ __agent: AGENT })

  // 建任务按分值降序：task-1=misc-3(300) → task-2=pwn-2(200) → task-3=web-1(100)；并发 2 只拉起前两题
  assert.equal(taskList.length, 3)
  // 题目 3：teammate 已认领（in_progress）但平台仍是未解
  taskList[0].status = 'in_progress'
  taskList[0].ownerName = 'solver-misc-3'
  // 题目 2：agent 已拉起（work.status=solving）但还没 claim → 任务仍是 pending（空窗期）
  assert.equal(taskList[1].status, 'pending')

  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /\| misc-3 \(#3\) .*进行中（agent 正在做）/, 'in_progress 的题要标注进行中')
  assert.match(report, /\| pwn-2 \(#2\) .*进行中（agent 正在做）/, '已拉起未认领的题也要标注进行中（空窗期）')
  assert.match(report, /\| web-1 \(#1\) .*未解/, '没起 agent 的题仍是未解')
  assert.match(report, /- 进行中（agent 正在做）：2 题/)
  assert.match(report, /### 进行中（agent 正在做）/)
  assert.match(report, /- misc-3 \(#3\)｜misc｜300分｜任务 task-1｜owner=solver-misc-3｜平台未解/)
  assert.match(report, /- pwn-2 \(#2\)｜pwn｜200分｜任务 task-2｜owner=未认领｜平台未解/)

  // 平台侧已解时不再进「进行中」清单
  challenges.find((c) => c.id === 3).solved = true
  const after = await orchestrator.status({ __agent: AGENT })
  assert.match(after, /- 进行中（agent 正在做）：1 题/)
})

test('status：spawn 失败的题目会出现在统计里', async () => {
  const store = await makeStore()
  const { teams } = makeTeams({
    spawnImpl: () => {
      throw new Error('boom')
    },
  })
  const { orchestrator } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1, name: 'web-1' })],
    teams,
    store,
    config: { concurrency: 1 },
  })
  await orchestrator.start({ __agent: AGENT })
  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /agent 拉起失败 1 个/)
  assert.match(report, /challengeId=1：boom/)
})

// ---------------------------------------------------------------- stop

test('stop：中断全部 teammate，releaseEnvs 释放已开环境', async () => {
  const store = await makeStore()
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'solver-web-1', role: 'teammate', status: 'running' },
    { name: 'solver-pwn-2', role: 'teammate', status: 'inactive' },
  ]
  const { teams, calls, taskList } = makeTeams({ members })
  const { orchestrator, adapterCalls } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1, name: 'web-1' }), makeChallenge({ id: 2, name: 'pwn-2' })],
    teams,
    store,
    config: { concurrency: 2 },
  })
  await orchestrator.start({ __agent: AGENT })

  // 标记题目 1 已开环境；题目 2 的任务处于进行中但**没有起过环境**（附件题）
  await store.upsertChallengeWork(CONNECTION.key, '1', { envStarted: true, connectionInfo: 'nc 1.2.3.4 1337' })
  taskList[1].status = 'in_progress'

  const summary = await orchestrator.stop({ __agent: AGENT, releaseEnvs: true })
  assert.deepEqual(calls.interrupt.map((c) => c.name), ['solver-web-1', 'solver-pwn-2'])
  assert.equal(calls.interrupt[0].caller, AGENT)
  assert.deepEqual(adapterCalls.release.sort(), ['1'], '「任务进行中」≠「有环境」：只有起过环境的题才 release')
  assert.match(summary, /中断 agent：2 个/)
  assert.match(summary, /释放环境：1 个成功，0 个本来就没环境，0 个平台未配置环境/)
  assert.match(summary, /challengeId=1/)
  assert.doesNotMatch(summary, /challengeId=2/, '没起过环境的题不应出现在释放清单里')
})

test('stop：非环境题（task_type=2 / 附件题）绝不被 release（回归）', async () => {
  const store = await makeStore()
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const { teams, taskList } = makeTeams({ members })
  const { orchestrator, adapterCalls } = await makeOrchestrator({
    // 41 这类附件题的 task_type 是 2（link_path 指向网盘），平台对 release 返回 400
    challenges: [
      makeChallenge({ id: 41, name: '消失的浮点数', category: 'misc', score: 100, task_type: 2, type: 2 }),
      makeChallenge({ id: 7, name: 'baby-heap', category: 'pwn', score: 200, task_type: 1, type: 1 }),
    ],
    teams,
    store,
    config: { concurrency: 2 },
  })
  await orchestrator.start({ __agent: AGENT })
  for (const task of taskList) task.status = 'in_progress'

  // 只有题目 7 真的起过环境（ctf_start_env 写的 work 记录）
  await store.upsertChallengeWork(CONNECTION.key, '7', {
    envStarted: true, envReleased: false, connectionInfo: 'nc 10.0.0.1 1337',
  })

  const summary = await orchestrator.stop({ __agent: AGENT, releaseEnvs: true })
  assert.deepEqual(adapterCalls.release, ['7'], '只释放起过环境的题')
  assert.doesNotMatch(summary, /challengeId=41/)
  assert.match(summary, /- challengeId=7/)
})

test('stop：释放结果四分类摘要（成功 / 本来就没环境 / 平台未配置 / 失败）', async () => {
  const store = await makeStore()
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const { teams } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1 }), makeChallenge({ id: 2 }), makeChallenge({ id: 3 }), makeChallenge({ id: 4 }), makeChallenge({ id: 5 })],
    teams,
    store,
    releaseImpl: async (id) => {
      if (id === '2') return { kind: 'no-env', released: false, idempotent: true }
      if (id === '3') return { kind: 'not-configured', released: false, notConfigured: true }
      if (id === '4') throw new Error('平台 500')
      if (id === '5') return { kind: 'released', released: true, idempotent: true }
      return { kind: 'released', released: true }
    },
  })
  for (const id of ['1', '2', '3', '4', '5']) {
    await store.upsertChallengeWork(CONNECTION.key, id, { envStarted: true, connectionInfo: 'nc x 1' })
  }

  const summary = await orchestrator.stop({ __agent: AGENT, releaseEnvs: true })
  assert.match(summary, /释放环境：1 个成功，2 个本来就没环境，1 个平台未配置环境，1 个失败/)
  assert.match(summary, /- challengeId=1\n/)
  assert.match(summary, /- challengeId=2（幂等：本来就无环境）/)
  assert.match(summary, /- challengeId=3（平台未配置环境，跳过）/)
  assert.match(summary, /- challengeId=4：平台 500/)
  assert.match(summary, /- challengeId=5（幂等：此前已释放或正在释放）/, 'idempotent + kind=released 要与 no-env 区分')

  // 释放成功的题会写 envReleased=true → 下一轮不再重复释放
  const second = await orchestrator.stop({ __agent: AGENT, releaseEnvs: true })
  assert.doesNotMatch(second, /- challengeId=1\n/)
  assert.match(second, /释放环境：0 个成功/)
})

test('stop：names 只中断指定成员；releaseEnvs 默认关闭；中断失败不崩', async () => {
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'solver-a-1', role: 'teammate', status: 'running' },
    { name: 'solver-b-2', role: 'teammate', status: 'running' },
  ]
  const { teams, calls } = makeTeams({ members })
  teams.interrupt = async (caller, name) => {
    calls.interrupt.push({ caller, name })
    if (name === 'solver-a-1') throw new Error('member not found')
    return { previousStatus: 'running' }
  }
  const { orchestrator, adapterCalls } = await makeOrchestrator({ challenges: [], teams })

  const summary = await orchestrator.stop({ __agent: AGENT, names: ['solver-a-1', 'solver-b-2'] })
  assert.deepEqual(calls.interrupt.map((c) => c.name), ['solver-a-1', 'solver-b-2'])
  assert.equal(adapterCalls.release.length, 0)
  assert.match(summary, /中断 agent：1 个，失败 1 个/)
  assert.match(summary, /member not found/)
  assert.match(summary, /环境未释放（releaseEnvs=false）/)

  // names 省略 / 为空数组 → 中断全部 teammate（solver-a-1 仍失败，solver-b-2 成功）
  const all = await orchestrator.stop({ __agent: AGENT, names: [] })
  assert.equal(calls.interrupt.length, 4)
  assert.deepEqual(calls.interrupt.slice(2).map((c) => c.name), ['solver-a-1', 'solver-b-2'])
  assert.match(all, /中断 agent：1 个，失败 1 个/)
  assert.match(all, /solver-b-2/)
  assert.match(all, /solver-a-1：member not found/)
})

// ---------------------------------------------------------------- 其它

test('store 未注入时 start/status/stop 仍可用', async () => {
  const { teams } = makeTeams()
  const { orchestrator } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1, name: 'web-1' })],
    teams,
    config: { concurrency: 1 },
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.match(summary, /编排已启动/)
  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /团队进度/)
  const stopped = await orchestrator.stop({ __agent: AGENT, releaseEnvs: true })
  assert.match(stopped, /编排已停止/)
})

// ---------------------------------------------------------------- DSH 契约

/**
 * 复刻 dsh-experimental-agent-team 的真实校验规则，确保我们生成的请求一定被服务端接受：
 * - memberName: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ + ≤64 + 不能是 lead
 * - description/subject: 非空且 ≤200；task description ≤16384
 * - provider: 非空且 ≤200
 * - signal: 必须是 AbortSignal（内部 AbortSignal.any 会 TypeError）
 * - prompt: ContentBlock[]，{ type:'text', text:string } 严格 schema
 * - writeScope: 工作区相对路径，无前导 /、无盘符、无空段 / '.' / '..'
 */
function assertDshContract({ createRequests, spawnRequests }) {
  for (const request of createRequests) {
    assert.ok(request.subject.trim().length > 0 && request.subject.length <= 200, `subject 非法：${request.subject}`)
    assert.ok(request.description.trim().length > 0 && request.description.length <= 16384)
    for (const scope of request.writeScopes ?? []) {
      assert.ok(scope.length > 0, 'writeScope 不能为空')
      assert.ok(!scope.startsWith('/'), `writeScope 不能是绝对路径：${scope}`)
      assert.ok(!/^[a-z]:/i.test(scope), `writeScope 不能带盘符：${scope}`)
      assert.ok(
        !scope.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '').split('/').some((s) => !s || s === '.' || s === '..'),
        `writeScope 段非法：${scope}`,
      )
    }
  }
  for (const request of spawnRequests) {
    assert.match(request.name, NAME_RE, `名字不符合 lower-kebab-case：${request.name}`)
    assert.ok(request.name.length <= 64)
    assert.notEqual(request.name, 'lead')
    assert.ok(request.description.trim().length > 0 && request.description.length <= 200)
    assert.ok(typeof request.provider === 'string' && request.provider.trim().length > 0 && request.provider.length <= 200)
    assert.ok(request.signal instanceof AbortSignal, 'spawn 必须带 AbortSignal（DSH 内部 AbortSignal.any 会 TypeError）')
    assert.ok(Array.isArray(request.prompt) && request.prompt.length > 0)
    for (const block of request.prompt) {
      assert.deepEqual(Object.keys(block).sort(), ['text', 'type'])
      assert.equal(block.type, 'text')
      assert.equal(typeof block.text, 'string')
    }
  }
}

test('DSH 契约：恶意/边界题目名生成的请求全部合法', async () => {
  const challenges = [
    makeChallenge({ id: 1, name: '签到', category: 'Web', score: 100 }),
    makeChallenge({ id: 2, name: '../../etc/passwd', category: '', score: 90 }),
    makeChallenge({ id: 3, name: '!!!', category: '!!!', score: 80 }),
    makeChallenge({ id: 4, name: 'a'.repeat(200), category: 'pwn', score: 70 }),
    makeChallenge({ id: 5, name: '🔥🔥 emoji 题', category: 'misc', score: 60 }),
    makeChallenge({ id: '6', name: 'UPPER_CASE.Name', category: 'web', score: 50 }),
    makeChallenge({ id: 'a/b', name: 'weird-id', category: 'web', score: 40 }),
    makeChallenge({ id: 8, name: '同名题', category: 'web', score: 30 }),
    makeChallenge({ id: 9, name: '同名题', category: 'web', score: 20 }),
  ]
  const { teams, calls } = makeTeams()
  const { orchestrator } = await makeOrchestrator({ challenges, teams, config: { concurrency: 8 } })
  await orchestrator.start({ __agent: AGENT })

  assertDshContract({
    createRequests: calls.createTask.map((c) => c.request),
    spawnRequests: calls.spawn.map((c) => c.request),
  })
  // 9 道题都建了任务；同名题靠 id 区分名字，全部唯一
  assert.equal(calls.createTask.length, 9)
  const names = calls.spawn.map((c) => c.request.name)
  assert.equal(new Set(names).size, names.length, 'teammate 名字必须唯一')
  assert.equal(calls.spawn.length, 8, 'concurrency 硬上限')
})

test('与 tools.js 的装配契约：onlyUnsolved / agent 别名 / __signal / reason', async () => {
  const challenges = [
    makeChallenge({ id: 1, name: 'unsolved', score: 200, solved: false }),
    makeChallenge({ id: 2, name: 'solved', score: 100, solved: true }),
  ]

  // tools.js 的 ctf_solve_start 传 onlyUnsolved，而不是 includeSolved
  const a = makeTeams()
  const oa = await makeOrchestrator({ challenges, teams: a.teams, config: { concurrency: 2 } })
  await oa.orchestrator.start({ __agent: AGENT, onlyUnsolved: true })
  assert.equal(a.calls.createTask.length, 1)
  const b = makeTeams()
  const ob = await makeOrchestrator({ challenges, teams: b.teams, config: { concurrency: 2 } })
  await ob.orchestrator.start({ __agent: AGENT, onlyUnsolved: false })
  assert.equal(b.calls.createTask.length, 2, 'onlyUnsolved=false 时应包含已解题目')

  // callerAgent 键名兼容（避免装配层命名不一致直接不可用）
  const c = makeTeams()
  const oc = await makeOrchestrator({ challenges, teams: c.teams, config: { concurrency: 1 } })
  const signal = new AbortController().signal
  await oc.orchestrator.start({ agent: AGENT, __signal: signal })
  assert.equal(c.calls.spawn[0].caller, AGENT)
  assert.equal(c.calls.spawn[0].request.signal, signal, 'exec.signal 应透传给 spawnTeammate')

  // stop 的 reason / release 别名
  const d = makeTeams({
    members: [
      { name: 'lead', role: 'lead', status: 'running' },
      { name: 'solver-x-1', role: 'teammate', status: 'running' },
    ],
  })
  const od = await makeOrchestrator({ challenges: [], teams: d.teams })
  const summary = await od.orchestrator.stop({ __agent: AGENT, reason: '比赛结束', release: true })
  assert.match(summary, /停止原因：比赛结束/)
  assert.match(summary, /释放环境：0 个/)
})

test('buildSolverPrompt：ContentBlock[] 且不包含凭据', () => {
  const blocks = buildSolverPrompt({
    name: 'solver-web-1',
    challenge: makeChallenge({ id: 1, name: 'web' }),
    taskId: 'task-9',
    connection: CONNECTION,
    connKey: CONNECTION.key,
    workDir: 'lingxu-ctf-work',
  })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /system-reminder/)
  assert.match(blocks[1].text, /task-9/)
  assert.match(blocks[1].text, /lingxu-ctf-work\/challenges\/web-1/)
  assert.doesNotMatch(blocks[1].text, /super-secret/)
})

test('config.concurrency 作为默认值，非法值回退 4', async () => {
  const a = makeTeams()
  const oa = await makeOrchestrator({
    challenges: [1, 2, 3].map((id) => makeChallenge({ id, name: `c${id}` })),
    teams: a.teams,
    config: { concurrency: 2 },
  })
  await oa.orchestrator.start({ __agent: AGENT })
  assert.equal(a.calls.spawn.length, 2)

  const b = makeTeams()
  const ob = await makeOrchestrator({
    challenges: [1, 2, 3, 4, 5].map((id) => makeChallenge({ id, name: `c${id}` })),
    teams: b.teams,
    config: { concurrency: 'nonsense' },
  })
  await ob.orchestrator.start({ __agent: AGENT })
  assert.equal(b.calls.spawn.length, LIMITS.defaultConcurrency)
})
