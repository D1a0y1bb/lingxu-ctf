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
  collectReusableSlots,
  parseMemberLimit,
  prepFileFor,
  resolveMaxTeamMembers,
  scoreChallenge,
  solverDirFor,
  takeSlotFor,
  sanitizeSlug,
  probeSession,
  selectChallenges,
  sessionExpiredStartText,
  SESSION_EXPIRED_BANNER,
  taskSubjectFor,
  teammateNameFor,
  writeScopeFor,
} from '../lib/orchestrate.js'
import { CtfStore } from '../lib/store.js'
import { slugify as indexSlugify } from '../lib/index.js'
import { buildToolSpecs } from '../lib/tools.js'
import { LingxuError, LINGXU_CODES } from '../lib/lingxu.js'

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
  const calls = {
    spawn: [], createTask: [], listTasks: 0, listMembers: 0, interrupt: [], updateTask: [], sendMessage: [],
  }
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
      calls.sendMessage.push({ caller, request })
      return { id: `msg-${calls.sendMessage.length}`, caller, request }
    },
  }
  return { teams, calls, taskList }
}

function makeAdapter(challenges, { releaseImpl = null, details = null } = {}) {
  const calls = { release: [], detail: [] }
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
  // 详情探测（taskType 只有详情接口有）：只有显式给了 details 才挂这个方法，
  // 没给时编排层应把它当成「无法探测」→ 一律按非环境题处理（不改变老测试的行为）。
  if (details) {
    adapter.challengeDetail = async (id) => {
      calls.detail.push(String(id))
      const found = typeof details === 'function' ? details(id) : details[String(id)] ?? details[Number(id)]
      if (!found) throw new Error(`no detail for ${id}`)
      return found
    }
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
  details = null,
  existsSync = null,
  maxMembersOverride = null,
} = {}) {
  const { adapter, calls } = makeAdapter(challenges, { releaseImpl, details })
  const resolved = { fail: Boolean(resolveError) }
  if (maxMembersOverride != null && teams) teams.config = { maxMembers: maxMembersOverride }
  const deps = {
    config: { concurrency: 4, ...config },
    teams,
    store,
    now: () => 1700000000000,
    ...(existsSync ? { existsSync } : {}),
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
  assert.match(summary, /新建 4 个任务/)
  assert.match(summary, /本轮分配 2 个（♻️ 复用 0 \/ 🆕 新建 2）/)
  assert.match(summary, /solver-pwn-hard-2/)
  assert.match(summary, /排队中（2 题/)
  assert.match(summary, /环境调度：同时最多 2 个环境/)

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
  assert.match(summary, /已达 teammate 上限/)
  assert.match(summary, /maxMembers=16/)
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
  assert.match(summary, /本轮分配 1 个（♻️ 复用 0 \/ 🆕 新建 1）/)
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

test('start 幂等：已有 agent 的题目跳过；force=true 强制重跑', async () => {
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
  assert.equal(calls.spawn.length, 2, '第二次调用不应重复起 agent（已在跑的不重复派）')
  assert.match(second, /已有 agent 在做/)

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
  assert.match(report, /\| 题目 \| 分类 \| 分值 \| 题型 \| 任务 \| 任务状态 \| owner \| 平台 \| 环境 \|/)
  assert.match(report, /pwn-2 \(#2\)/)
  assert.match(report, /进行中/)
  assert.match(report, /已完成/)
  assert.match(report, /solver-pwn-2/)
  assert.match(report, /已解 1 \/ 共 3 题/)
  assert.match(report, /进行中 1，待认领 0，已完成 1/)
  assert.match(report, /running 1，inactive 1，provisioning 0，failed 1/)
  assert.match(report, /- 环境占用：0\/2（上限来源：平台默认 2/)
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
  assert.match(report, /- misc-3 \(#3\)｜misc｜300分｜-｜任务 task-1｜owner=solver-misc-3｜平台未解/)
  assert.match(report, /- pwn-2 \(#2\)｜pwn｜200分｜-｜任务 task-2｜owner=未认领｜平台未解/)

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

// ---------------------------------------------------------------- task-14：session 前置探活

/** 平台 session 失效的真实回包形状（HTTP 403 + {"detail":"未登录"}）。 */
function sessionExpiredError() {
  return new LingxuError('凌虚 GET /event/4/info/ 未登录（HTTP 403）：未登录', {
    httpStatus: 403,
    code: LINGXU_CODES.SESSION_EXPIRED,
    platformMessage: '未登录',
  })
}

test('probeSession：区分 session-expired / 其他错误 / 无法探活', async () => {
  assert.deepEqual(await probeSession(null), { checked: false, sessionExpired: false, error: null, warning: null })
  assert.deepEqual(await probeSession({}), { checked: false, sessionExpired: false, error: null, warning: null })

  const ok = await probeSession({ async validate() { return { ok: true } } })
  assert.equal(ok.checked, true)
  assert.equal(ok.sessionExpired, false)
  assert.equal(ok.warning, null)

  const expired = await probeSession({ async validate() { throw sessionExpiredError() } })
  assert.equal(expired.checked, true)
  assert.equal(expired.sessionExpired, true)
  assert.equal(expired.warning, null)

  const other = await probeSession({ async validate() { throw new Error('请求超时（30000ms）') } })
  assert.equal(other.sessionExpired, false)
  assert.match(other.warning.message, /超时/)

  // 没有 validate() 时退回 eventSummary()
  const fallback = await probeSession({ async eventSummary() { throw sessionExpiredError() } })
  assert.equal(fallback.sessionExpired, true)

  // 文案在缺 baseUrl 时也要通顺（没有多余空格）
  assert.match(sessionExpiredStartText(''), /请重新登录平台后复制新的 Cookie/)
  assert.match(sessionExpiredStartText('  '), /请重新登录平台后复制新的 Cookie/)
  assert.match(sessionExpiredStartText('https://x:8000'), /请重新登录 https:\/\/x:8000 后复制新的 Cookie/)
})

test('start 前置探活：session 失效 → 不建任务、不 spawn，返回更新 Cookie 指引', async () => {
  const store = await makeStore()
  const { teams, calls, taskList } = makeTeams()
  const adapter = {
    async validate() { throw sessionExpiredError() },
    async challenges() { throw new Error('探活已判定失效，不应再拉题目列表') },
  }
  const { orchestrator } = await makeOrchestrator({ teams, store, adapterOverride: adapter })
  const out = await orchestrator.start({ __agent: AGENT })

  assert.equal(calls.createTask.length, 0, '不得创建任何任务')
  assert.equal(calls.spawn.length, 0, '不得拉起任何 agent')
  assert.equal(taskList.length, 0)
  assert.equal(out, sessionExpiredStartText(CONNECTION.baseUrl))
  assert.match(out, /无法开始：凌虚 sessionid 已失效（平台返回「未登录」）。/)
  assert.match(out, /https:\/\/host:8000/, '文案里要有平台地址，用户直接去登录')
  assert.match(out, /ctf_connect \{ baseUrl, eventId, cookie \}/)
  assert.match(out, /未创建任何任务、未拉起任何 agent/)

  // 面板「协同交流」留痕（不写入平台，仅本地 store）
  const messages = await store.listTeamMessages(CONNECTION.key)
  assert.ok(messages.some((m) => /sessionid 已失效/.test(m.text ?? '')), '应有 session 失效记录')
})

test('start 前置探活：网络抖动等其他错误 → 只警告并继续编排', async () => {
  const challenges = [makeChallenge({ id: 1, name: 'web-1' })]
  const { teams, calls } = makeTeams()
  const adapter = {
    async validate() { throw new Error('凌虚 GET /event/4/info/ 请求超时（30000ms）') },
    async challenges() { return challenges },
  }
  const { orchestrator } = await makeOrchestrator({
    teams,
    adapterOverride: adapter,
    config: { concurrency: 1 },
  })
  const out = await orchestrator.start({ __agent: AGENT })

  assert.match(out, /## 编排已启动/)
  assert.match(out, /前置探活失败但已继续/)
  assert.match(out, /请求超时/)
  assert.equal(calls.createTask.length, 1, '抖动不应阻断编排')
  assert.equal(calls.spawn.length, 1)
})

test('start 前置探活：优先 validate()（1 次请求），不额外拉 eventSummary', async () => {
  const probed = { validate: 0, eventSummary: 0 }
  const adapter = {
    async validate() { probed.validate += 1; return { ok: true } },
    async eventSummary() { probed.eventSummary += 1; return { name: 'x' } },
    async challenges() { return [makeChallenge({ id: 1 })] },
  }
  const { teams } = makeTeams()
  const { orchestrator } = await makeOrchestrator({ teams, adapterOverride: adapter, config: { concurrency: 1 } })
  await orchestrator.start({ __agent: AGENT })
  assert.equal(probed.validate, 1)
  assert.equal(probed.eventSummary, 0)
})

test('start 前置探活：适配器没有 validate/eventSummary 时跳过探活，照常编排（回归）', async () => {
  const { teams, calls } = makeTeams()
  const { orchestrator } = await makeOrchestrator({
    challenges: [makeChallenge({ id: 1 })],
    teams,
    config: { concurrency: 1 },
  })
  const out = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 1)
  assert.doesNotMatch(out, /前置探活失败/)
})

// ---------------------------------------------------------------- task-14：status 失效横幅

test('status：session 失效 → 顶部 🛑 横幅 + 统计「⚠️ 会话失效」，且不自动中断 agent', async () => {
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'solver-web-1', role: 'teammate', status: 'running' },
  ]
  const { teams, calls } = makeTeams({ members })
  const challenges = [makeChallenge({ id: 1, name: 'web-1' })]
  const adapter = {
    async validate() { return { ok: true } },
    async challenges() { return challenges },
  }
  const { orchestrator } = await makeOrchestrator({
    teams,
    adapterOverride: adapter,
    challenges,
    config: { concurrency: 2 }, // 已有 1 个 running teammate，留 1 个名额给本轮 spawn
  })
  await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 1)

  // 比赛进行中 session 失效
  adapter.challenges = async () => { throw sessionExpiredError() }
  const report = await orchestrator.status({ __agent: AGENT })

  assert.ok(report.startsWith(SESSION_EXPIRED_BANNER), `横幅必须在最顶部：\n${report.slice(0, 120)}`)
  assert.match(report, /所有 agent 的提交都会失败，flag 会丢失/)
  assert.match(report, /请立即更新 Cookie（ctf_connect），然后重新 ctf_solve_start/)
  assert.match(report, /- 平台：⚠️ 会话失效/)
  assert.doesNotMatch(report, /- 平台：已解 0 \/ 共 1 题/, '失效时不再显示正常平台统计')
  assert.match(report, /ctf_solve_stop/, '要在文案里明确建议怎么停手')
  assert.equal(calls.interrupt.length, 0, '不得自动 interrupt 任何 agent')
  // 任务板/成员数字仍然照常显示（本地数据可用）
  assert.match(report, /任务板：共 1/)
  assert.match(report, /running 1/)
})

test('status：session 正常的非失效错误仍走原有降级文案（回归）', async () => {
  const { teams } = makeTeams()
  const adapter = {
    async validate() { return { ok: true } },
    async challenges() { throw new Error('HTTP 502 Bad Gateway') },
  }
  const { orchestrator } = await makeOrchestrator({ teams, adapterOverride: adapter })
  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /^## 团队进度/)
  assert.match(report, /平台题目列表获取失败/)
  assert.match(report, /502/)
  assert.doesNotMatch(report, /sessionid 已失效/)
})

// ---------------------------------------------------------------- 环境感知调度（task-17 核心）

/** 造一道题 + 它的详情（taskType：1 环境型 / 2 外链型 / 3 附件型）。 */
function envChallenge(id, score, taskType, name) {
  return makeChallenge({ id, name: name || `ch-${id}`, category: 'Pwn', score, taskTypeHint: taskType })
}
function detailsFor(entries) {
  const labels = { 1: '环境型', 2: '外链型', 3: '附件型' }
  return Object.fromEntries(
    entries.map(([id, taskType]) => [String(id), { id: Number(id), taskType, taskTypeLabel: labels[taskType] }]),
  )
}

test('环境调度：envLimit 只约束环境题，非环境题不受限（10 环境 + 4 非环境，并发 6）', async () => {
  const store = await makeStore()
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const { teams, calls } = makeTeams({ members })
  // 分值降序：非环境题在前 4 个 → 探测窗口内可见
  const flat = [0, 1, 2, 3].map((i) => makeChallenge({ id: 300 + i, name: `flat-${i}`, category: 'Misc', score: 900 - i }))
  const envs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) =>
    makeChallenge({ id: 400 + i, name: `env-${i}`, category: 'Pwn', score: 800 - i }),
  )
  const details = detailsFor([
    ...[0, 1, 2, 3].map((i) => [300 + i, 3]), // 附件型
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => [400 + i, 1]), // 环境型
  ])
  const { orchestrator, adapterCalls } = await makeOrchestrator({
    challenges: [...flat, ...envs],
    teams,
    store,
    details,
    config: { concurrency: 6, envLimit: 2 },
  })

  const summary = await orchestrator.start({ __agent: AGENT })
  const spawnedNames = calls.spawn.map((c) => c.request.name)
  const spawnedEnvs = spawnedNames.filter((name) => name.includes('env-'))
  const spawnedFlat = spawnedNames.filter((name) => name.includes('flat-'))

  assert.equal(spawnedEnvs.length, 2, `环境题必须被 envLimit=2 限制住，实际 ${spawnedEnvs.length}: ${spawnedNames}`)
  assert.equal(spawnedFlat.length, 4, '非环境题不受 envLimit 限制，应把剩余并发槽填满')
  assert.equal(calls.spawn.length, 6, '总并发 = 6')
  assert.match(summary, /环境调度：同时最多 2 个环境/)
  assert.match(summary, /本轮环境题配额 2 个/)
  assert.match(summary, /环境排队（6 题：配额 2\/2 已满/)
  assert.match(summary, /题型探测：本轮按需探测 \d+ 题/)
  // 每道环境题的 prompt 都要写清「环境稀缺、解完立刻释放」
  const envPrompt = calls.spawn.find((c) => c.request.name.includes('env-')).request.prompt.map((b) => b.text).join('\n')
  assert.match(envPrompt, /环境是稀缺资源/)
  assert.match(envPrompt, /ctf_release_env/)
  assert.match(envPrompt, /ctf_delay_env/)
  const flatPrompt = calls.spawn.find((c) => c.request.name.includes('flat-')).request.prompt.map((b) => b.text).join('\n')
  assert.match(flatPrompt, /附件型/)
  assert.doesNotMatch(flatPrompt, /环境是稀缺资源/)
  assert.equal(adapterCalls.detail.length <= 12, true, '探测有上限（maxEnvProbes）')
})

test('环境调度：题型从 work 记录缓存读取，不再重复探测（探测结果回写）', async () => {
  const store = await makeStore()
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const { teams } = makeTeams({ members })
  const challenges = [makeChallenge({ id: 501, name: 'pwn-a', score: 100 })]
  const details = detailsFor([[501, 1]])
  const first = await makeOrchestrator({ challenges, teams, store, details, config: { concurrency: 1 } })
  await first.orchestrator.start({ __agent: AGENT })
  assert.equal(first.adapterCalls.detail.length, 1, '首次要探测一次详情')

  const work = await store.getChallengeWork(CONNECTION.key, '501')
  assert.equal(work.taskType, 1, '探测结果要回写 work 记录（列表接口没有 task_type）')
  assert.match(work.taskTypeLabel ?? '', /环境型/)

  // 第二轮（新编排器实例，模拟进程重启）：命中 work 缓存，零探测
  const second = await makeOrchestrator({ challenges, teams, store, details, config: { concurrency: 1 } })
  await second.orchestrator.start({ __agent: AGENT, force: true })
  assert.equal(second.adapterCalls.detail.length, 0, '有缓存时不应再探测')
})

test('环境调度：envLimit=0（自学习）→ 用平台实测值；配置值优先', async () => {
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const envs = [0, 1, 2, 3, 4].map((i) => makeChallenge({ id: 600 + i, name: `e-${i}`, score: 100 - i }))
  const details = detailsFor([0, 1, 2, 3, 4].map((i) => [600 + i, 1]))

  // 1) envLimit=0 → 自学习：work 记录里的 envLimitObserved=3（ctf_start_env 撞上限时写入）
  const store = await makeStore()
  await store.upsertChallengeWork(CONNECTION.key, '999', { envLimitObserved: 3, envLimitHitAt: '2026-09-29T01:00:00Z' })
  const { teams, calls } = makeTeams({ members })
  const learned = await makeOrchestrator({ challenges: envs, teams, store, details, config: { concurrency: 5, envLimit: 0 } })
  const learnedSummary = await learned.orchestrator.start({ __agent: AGENT })
  // 自学习到 3 → 3 个「全程 agent」拿环境；剩下 2 个并发槽派「离线准备 agent」（task-21：不干等）
  const learnedNames = calls.spawn.map((c) => c.request.name)
  assert.equal(learnedNames.filter((name) => name.startsWith('solver-')).length, 3, `自学习到 3 就该放 3 个全程环境题，实际 ${learnedNames}`)
  assert.equal(learnedNames.filter((name) => name.startsWith('prep-')).length, 2, '剩余并发槽派离线准备 agent')
  assert.match(learnedSummary, /同时最多 3 个环境（平台实测/)
  assert.match(learnedSummary, /离线准备 agent 2 个/)

  // 2) 显式配置优先于实测值与默认值
  const configuredStore = await makeStore()
  await configuredStore.upsertChallengeWork(CONNECTION.key, '999', { envLimitObserved: 3 })
  const second = makeTeams({ members })
  const configured = await makeOrchestrator({
    challenges: envs, teams: second.teams, store: configuredStore, details,
    config: { concurrency: 5, envLimit: 1 },
  })
  const configuredSummary = await configured.orchestrator.start({ __agent: AGENT })
  assert.equal(
    second.calls.spawn.filter((c) => c.request.name.startsWith('solver-')).length,
    1,
    '配置 envLimit=1 时只能放 1 个全程 agent',
  )
  assert.equal(second.calls.spawn.filter((c) => c.request.name.startsWith('prep-')).length, 4, '其余槽位派准备 agent')
  assert.match(configuredSummary, /同时最多 1 个环境（config.envLimit/)

  // 3) 都没有 → 平台默认 2
  const third = makeTeams({ members })
  const fallback = await makeOrchestrator({
    challenges: envs, teams: third.teams, store: await makeStore(), details, config: { concurrency: 5 },
  })
  await fallback.orchestrator.start({ __agent: AGENT })
  assert.equal(
    third.calls.spawn.filter((c) => c.request.name.startsWith('solver-')).length,
    2,
    '默认值 = 平台源码 default 2',
  )
})

test('环境调度：已占用的环境要扣配额，过期的不占', async () => {
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const envs = [0, 1, 2].map((i) => makeChallenge({ id: 700 + i, name: `e-${i}`, score: 100 - i }))
  const details = detailsFor([[700, 1], [701, 1], [702, 1]])

  // 已占满 2 个（envStarted 且未释放）→ 本轮环境配额 0
  const store = await makeStore()
  await store.upsertChallengeWork(CONNECTION.key, '900', { envStarted: true, envReleased: false, connectionInfo: 'nc 1.1.1.1 1' })
  await store.upsertChallengeWork(CONNECTION.key, '901', { envStarted: true, envReleased: false, connectionInfo: 'nc 1.1.1.1 2' })
  const { teams, calls } = makeTeams({ members })
  const busy = await makeOrchestrator({ challenges: envs, teams, store, details, config: { concurrency: 3 } })
  const busySummary = await busy.orchestrator.start({ __agent: AGENT })
  const busyNames = calls.spawn.map((c) => c.request.name)
  assert.equal(busyNames.filter((name) => name.startsWith('solver-')).length, 0, '配额已满，不能再起「全程」环境 agent')
  assert.equal(busyNames.filter((name) => name.startsWith('prep-')).length, 3, '应该派 3 个离线准备 agent（不干等）')
  assert.match(busySummary, /离线准备 agent 3 个/)

  // 环境到期（releaseTime 已过）→ 平台已自动释放，配额还回来
  const releasedStore = await makeStore()
  await releasedStore.upsertChallengeWork(CONNECTION.key, '900', {
    envStarted: true, envReleased: false, envReleaseTime: '2023-01-01T00:00:00Z',
  })
  const second = makeTeams({ members })
  const back = await makeOrchestrator({ challenges: envs, teams: second.teams, store: releasedStore, details, config: { concurrency: 3 } })
  const backSummary = await back.orchestrator.start({ __agent: AGENT })
  assert.equal(
    second.calls.spawn.filter((c) => c.request.name.startsWith('solver-')).length,
    2,
    '过期环境不再占配额',
  )
  assert.match(backSummary, /当前已占用 0/)
})

test('环境调度：释放后下一轮能补派已建任务的题（不重复建任务）', async () => {
  const store = await makeStore()
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const envs = [0, 1, 2, 3].map((i) => makeChallenge({ id: 800 + i, name: `e-${i}`, score: 100 - i }))
  const details = detailsFor([0, 1, 2, 3].map((i) => [800 + i, 1]))
  const { teams, calls, taskList } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({ challenges: envs, teams, store, details, config: { concurrency: 2 } })

  await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.createTask.length, 4, '任务板是完整队列（4 道都建任务）')
  assert.equal(calls.spawn.length, 2, 'envLimit=2 只派 2 个')

  // 模拟：两个 agent 解完（平台标记已解）+ 释放环境 → 剩下的环境题应该被补派
  for (const task of taskList.slice(0, 2)) task.status = 'completed'
  envs[0].solved = true
  envs[1].solved = true
  await store.upsertChallengeWork(CONNECTION.key, '800', { envReleased: true, envStarted: false })
  await store.upsertChallengeWork(CONNECTION.key, '801', { envReleased: true, envStarted: false })

  const again = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.createTask.length, 4, '补派不能重复建任务（复用已有任务）')
  assert.equal(calls.spawn.length, 4, '释放后应补派下一批（e-2 / e-3）')
  assert.match(again, /复用已有任务 2 个/)
  assert.deepEqual(calls.spawn.slice(2).map((c) => c.request.name), ['solver-e-2-802', 'solver-e-3-803'])
})

test('环境调度：已 spawn 且在跑的题，下一轮绝不能再派（安全网）', async () => {
  const store = await makeStore()
  // 一个 teammate 已拉起（inactive 也算在册），任务是 pending（还没 claim）
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'solver-pwn-1', role: 'teammate', status: 'inactive' },
  ]
  const { teams, calls, taskList } = makeTeams({ members })
  const challenges = [makeChallenge({ id: 901, name: 'pwn-1', category: 'Pwn', score: 300 })]
  const { orchestrator } = await makeOrchestrator({ challenges, teams, store, config: { concurrency: 4 } })
  await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 1)
  assert.equal(taskList[0].status, 'pending', '还没 claim')

  // 第二轮：同一道题（agent 还在册，任务未完成）→ 不能再派一次
  for (const attempt of [1, 2]) {
    const report = await orchestrator.start({ __agent: AGENT })
    assert.equal(calls.spawn.length, 1, `第 ${attempt + 1} 轮不应重复派同一道题`)
    assert.equal(calls.createTask.length, 1, '也不应重复建任务')
    assert.match(report, /已有 agent 在做/)
  }

  // 任务完成后才允许重跑
  taskList[0].status = 'completed'
  await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 2, '任务完成后可重跑（新任务）')
})

test('环境调度：ctf_solve_status 显示题型 / 环境剩余 / 环境占用 / 环境排队', async () => {
  const store = await makeStore()
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    // inactive = 手里的 turn 已结束，不占并发槽（否则 slots=0，本轮不会探测题型）
    { name: 'solver-pwn-1', role: 'teammate', status: 'inactive' },
  ]
  const challenges = [
    makeChallenge({ id: 101, name: 'pwn-a', category: 'Pwn', score: 300, solved: false }),
    makeChallenge({ id: 102, name: 'misc-b', category: 'Misc', score: 200, solved: true }),
  ]
  const { teams, taskList } = makeTeams({ members })
  const details = detailsFor([[101, 1], [102, 3]])
  const { orchestrator } = await makeOrchestrator({ challenges, teams, store, details, config: { concurrency: 1 } })
  await orchestrator.start({ __agent: AGENT })
  assert.equal(taskList.length, 1, '已解出的题不参与编排（只建未解题的任务）')
  taskList[0].status = 'in_progress'
  taskList[0].ownerName = 'solver-pwn-1'

  // 模拟 101 起了环境（剩余 25 分钟 → 距释放 ~1500s），已解出的 102 也占着环境
  await store.upsertChallengeWork(CONNECTION.key, '101', {
    envStarted: true, envReleased: false, envReleaseTime: new Date(1700000000000 + 1500 * 1000).toISOString(),
  })
  await store.upsertChallengeWork(CONNECTION.key, '102', {
    envStarted: true, envReleased: false, envReleaseTime: new Date(1700000000000 + 1700 * 1000).toISOString(),
  })

  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /\| 题目 \| 分类 \| 分值 \| 题型 \| 任务 \| 任务状态 \| owner \| 平台 \| 环境 \|/)
  assert.match(report, /\| pwn-a \(#101\) .*\| 环境型 \|/)
  assert.match(report, /剩余 25m/)
  assert.match(report, /- 环境占用：2\/2（上限来源：平台默认 2/)
  assert.match(report, /### ♻️ 已解出但仍在占用环境/)
  assert.match(report, /ctf_release_env id=102/)
})

test('环境调度：纯环境题池（10 道 / envLimit=2 / 并发 6）→ 只派 2 个，其余明确排队', async () => {
  const store = await makeStore()
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const { teams, calls } = makeTeams({ members })
  const envs = Array.from({ length: 10 }, (_, i) =>
    makeChallenge({ id: 1000 + i, name: `only-env-${i}`, category: 'Pwn', score: 500 - i }),
  )
  const details = detailsFor(envs.map((c, i) => [1000 + i, 1]))
  const { orchestrator } = await makeOrchestrator({
    challenges: envs, teams, store, details, config: { concurrency: 6, envLimit: 2 },
  })

  const summary = await orchestrator.start({ __agent: AGENT })
  const names = calls.spawn.map((c) => c.request.name)
  // 2 个全程（吃配额）+ 4 个离线准备（不吃配额，但吃并发槽）—— 不让 agent 干等
  assert.equal(names.filter((name) => name.startsWith('solver-')).length, 2, '全程环境 agent 必须被 envLimit=2 限制住')
  assert.equal(names.filter((name) => name.startsWith('prep-')).length, 4, '剩余并发槽派离线准备 agent（P0）')
  assert.equal(calls.spawn.length, 6, '总并发 = 6（准备 agent 也吃并发槽）')
  assert.equal(calls.createTask.length, 10, '任务板仍是完整队列')
  assert.match(summary, /环境调度：同时最多 2 个环境（config.envLimit），当前已占用 0 → 本轮环境题配额 2 个/)
  assert.match(summary, /离线准备 agent（4 个：不吃环境配额，先把 P0 做完）/)
  // 剩下的 4 题：配额满 + 并发槽用完 → 明确排队
  assert.match(summary, /环境排队（4 题：配额 2\/2 已满/)
  assert.match(summary, /challengeId=1009，题型=环境型/)
  assert.match(summary, /题型探测：本轮按需探测 10 题/)
})

// ---------------------------------------------------------------- 智能调度（task-21：两阶段派发）

test('两阶段派发：配额满时派「离线准备 agent」而不是干等，prompt 明确不许反复起环境', async () => {
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const envs = [0, 1, 2, 3].map((i) => makeChallenge({ id: 1100 + i, name: `env-${i}`, category: 'Pwn', score: 100 - i }))
  const details = detailsFor(envs.map((challenge, i) => [1100 + i, 1]))
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: envs, teams, details, config: { concurrency: 4, envLimit: 2 },
  })

  const summary = await orchestrator.start({ __agent: AGENT })
  const prep = calls.spawn.filter((call) => call.request.name.startsWith('prep-'))
  const full = calls.spawn.filter((call) => call.request.name.startsWith('solver-'))
  assert.equal(full.length, 2, 'envLimit=2 → 只有 2 个全程 agent 拿环境')
  assert.equal(prep.length, 2, '剩余并发槽派离线准备 agent（不干等）')
  assert.equal(calls.spawn.length, 4, '准备 agent 也吃并发槽（不是"不吃配额就无限派"）')
  assert.match(summary, /离线准备 agent（2 个：不吃环境配额，先把 P0 做完）/)
  assert.match(summary, /两阶段派发：全程 agent 2 个（其中环境型 2）\/ \*\*离线准备 agent 2 个\*\*/)

  // 准备 agent 的 prompt：必须具体可执行（agent 只能看到 prompt）
  const prompt = prep[0].request.prompt.map((block) => block.text).join('\n')
  assert.match(prompt, /拿不到环境配额/, '要说清现在没有配额')
  assert.match(prompt, /不要反复调 `ctf_start_env`/, '要明确禁止反复起环境')
  assert.match(prompt, /PREP\.md/, '要给 P0 产物落点')
  assert.match(prompt, /challenges\/env-[0-9]+-11[0-9][0-9]\/PREP\.md/, 'PREP.md 路径要具体')
  assert.match(prompt, /不需要环境/, '要说清只做不需要环境的部分')
  assert.match(prompt, /不要 claim/, '不要接管任务板（那是 P1 全程 agent 的）')
  assert.match(prompt, /send_message/, '要要求向 lead 汇报')
  assert.match(prompt, /已就绪，等环境/)
  assert.match(prompt, /"prep-env-2-1102"/, 'system-reminder 里要带自己的名字')
  // 全程 agent 的 prompt 不能出现「拿不到配额」
  const fullPrompt = full[0].request.prompt.map((block) => block.text).join('\n')
  assert.doesNotMatch(fullPrompt, /拿不到环境配额/)
  // 成员名字要能区分角色，且都满足 DSH 命名规则
  for (const call of calls.spawn) assert.match(call.request.name, /^(solver|prep)-[a-z0-9-]+$/)
  assert.match(prep[0].request.description, /准备 teammate（等环境配额）：/)
})

test('两阶段派发：准备 agent 数 = min(并发空槽, 排队环境题)，且不重复派', async () => {
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const envs = Array.from({ length: 10 }, (_, i) => makeChallenge({ id: 1150 + i, name: `e-${i}`, score: 100 - i }))
  const details = detailsFor(envs.map((_, i) => [1150 + i, 1]))
  const { teams, calls } = makeTeams({ members })
  const store = await makeStore() // 准备状态要落 work 记录，第二轮才知道「已有准备 agent」
  const { orchestrator } = await makeOrchestrator({
    challenges: envs, teams, store, details, config: { concurrency: 3, envLimit: 2 },
  })
  await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.filter((c) => c.request.name.startsWith('solver-')).length, 2)
  assert.equal(calls.spawn.filter((c) => c.request.name.startsWith('prep-')).length, 1, '并发 3 → 只剩 1 个槽给准备 agent')

  // 第二轮：已派过准备 agent 的题不再重复派准备 agent（即使它还没写 PREP.md）
  await orchestrator.start({ __agent: AGENT })
  const prepNames = calls.spawn.filter((c) => c.request.name.startsWith('prep-')).map((c) => c.request.name)
  assert.equal(prepNames.filter((name) => name.startsWith('prep-e-2-')).length, 1, `同一道题只该派一次准备 agent：${prepNames}`)
  // 已 spawn 且任务未完成的题（work 里有 teammate）不会被重复派全程 agent
  assert.equal(calls.spawn.filter((c) => c.request.name === 'solver-e-0-1150').length, 1)
})

test('scoreChallenge：环境型降权 / 解出人数升权 / PREP.md 大幅升权', () => {
  const base = { id: 1, name: 'x', score: 300, parseCount: 0 }
  const plain = scoreChallenge(base, { taskType: 3 })
  const env = scoreChallenge(base, { taskType: 1 })
  assert.equal(plain, 300)
  assert.equal(Number(env.toFixed(4)), Number((300 * LIMITS.envScorePenalty).toFixed(4)), '环境型按机会成本打折')
  assert.ok(env < plain)

  const popular = scoreChallenge({ ...base, parseCount: 500 }, { taskType: 3 })
  assert.ok(popular > plain, '解出人数多（全平台 type=2 计数）要升权')
  const huge = scoreChallenge({ ...base, parseCount: 10 ** 9 }, { taskType: 3 })
  assert.ok(huge <= 300 * LIMITS.parseScoreMax + 1e-6, '解出人数权重有上限（防签到题碾压）')

  const prepped = scoreChallenge(base, { taskType: 1, hasPrep: true })
  assert.ok(prepped > env * 1.5, 'PREP.md 存在要大幅升权')
  assert.ok(prepped > plain, '已就绪的环境题应盖过同分非环境题')

  // 环境型 + 高解出人数 + 已就绪：三项叠加
  const all = scoreChallenge({ ...base, parseCount: 100 }, { taskType: 1, hasPrep: true })
  assert.ok(all > prepped, '解出人数的加成仍然生效')
})

test('槽位交接：配额释放后，有 PREP.md 的环境题优先拿全程 agent', async () => {
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const envs = [
    makeChallenge({ id: 1200, name: 'hard', category: 'Pwn', score: 280 }),
    makeChallenge({ id: 1201, name: 'prepped', category: 'Pwn', score: 240 }),
  ]
  const details = detailsFor([[1200, 1], [1201, 1]])
  // 只有 1201 有 PREP.md（软信号：文件存在）
  const existsSync = (target) => String(target).includes('prepped-1201')
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: envs, teams, details, existsSync, config: { concurrency: 1, envLimit: 1 },
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.deepEqual(calls.spawn.map((c) => c.request.name), ['solver-prepped-1201'], '已就绪的题优先（即使分数略低）')
  assert.match(summary, /就绪待环境 0 题/, '被选中的就绪题不算「等待」')
  assert.match(summary, /环境排队（1 题：配额 1\/1 已满/)
})

test('就绪待环境：PREP.md 存在但配额被占 → 不派准备 agent，列进「就绪待环境」', async () => {
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const envs = [
    makeChallenge({ id: 1250, name: 'ready-one', category: 'Pwn', score: 300 }),
    makeChallenge({ id: 1251, name: 'fresh-one', category: 'Pwn', score: 200 }),
  ]
  const details = detailsFor([[1250, 1], [1251, 1]])
  const store = await makeStore()
  // 配额已被别的题占满（envLimit=2，两条 envStarted 未释放）
  await store.upsertChallengeWork(CONNECTION.key, '9998', {
    envStarted: true, envReleased: false, connectionInfo: 'nc 1.1.1.1 1',
  })
  await store.upsertChallengeWork(CONNECTION.key, '9999', {
    envStarted: true, envReleased: false, connectionInfo: 'nc 1.1.1.1 2',
  })
  const existsSync = (target) => String(target).includes('ready-one-1250')
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: envs, teams, store, details, existsSync, config: { concurrency: 4, envLimit: 2 },
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  // 已就绪的题不派准备 agent；没准备的题派准备 agent
  assert.deepEqual(calls.spawn.map((c) => c.request.name), ['prep-fresh-one-1251'])
  assert.match(summary, /就绪待环境（1 题：PREP\.md 已就绪/)
  assert.match(summary, /PREP\.md 已存在/)
  assert.match(summary, /离线准备 agent（1 个/)
})

test('准备工作流：真实 PREP.md 落盘路径与 solverDirFor 一致（软信号可被识别）', async () => {
  const workDir = await makeTmpDir()
  const challenge = makeChallenge({ id: 1300, name: 'AIoT固件加密服务', category: 'IoT', score: 300 })
  const prepPath = prepFileFor(challenge, workDir)
  assert.equal(prepPath, `${workDir}/challenges/aiot固件加密服务-1300/PREP.md`)
  assert.equal(prepPath, `${solverDirFor(challenge, workDir)}/PREP.md`)

  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const details = detailsFor([[1300, 1]])
  // 1) 文件不存在 + 配额已满（envLimit=1 且被占）→ 派准备 agent
  const heldStore = new CtfStore({ dir: await makeTmpDir() })
  await heldStore.upsertChallengeWork(CONNECTION.key, '8888', {
    envStarted: true, envReleased: false, connectionInfo: 'nc 1.1.1.1 1',
  })
  const first = makeTeams({ members })
  const before = await makeOrchestrator({
    challenges: [challenge], teams: first.teams, store: heldStore, details, config: { concurrency: 2, envLimit: 1, workDir },
  })
  await before.orchestrator.start({ __agent: AGENT })
  assert.deepEqual(first.calls.spawn.map((c) => c.request.name), ['prep-aiot-1300'], '没有 PREP.md → 派准备 agent')

  // 2) 真写一个 PREP.md → 变成「就绪待环境」，不再派准备 agent
  await fsp.mkdir(path.dirname(prepPath), { recursive: true })
  await fsp.writeFile(prepPath, '# P0 分析\n\n- 结论：\n', 'utf8')
  const second = makeTeams({ members })
  const after = await makeOrchestrator({
    challenges: [challenge], teams: second.teams, store: heldStore, details, config: { concurrency: 2, envLimit: 1, workDir },
  })
  const summary = await after.orchestrator.start({ __agent: AGENT })
  assert.equal(second.calls.spawn.length, 0, '已就绪的题不该再派准备 agent')
  assert.match(summary, /就绪待环境（1 题/)
})

test('环境停滞检测：空转 ≥ 阈值 → 标注；剩余 < 10 分钟 → 建议释放让位（只提示不抢占）', async () => {
  const nowMs = 1700000000000
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'solver-stale-1', role: 'teammate', status: 'inactive' },
  ]
  const challenges = [
    makeChallenge({ id: 1400, name: 'stale-env', category: 'Pwn', score: 300, solved: false }),
    makeChallenge({ id: 1401, name: 'fresh-env', category: 'Pwn', score: 200, solved: false }),
  ]
  const details = detailsFor([[1400, 1], [1401, 1]])
  // 陈旧记录：用「25 分钟前的时钟」写入，编排器用 nowMs 计算停滞
  const store = new CtfStore({ dir: await makeTmpDir(), now: () => nowMs - 25 * 60000 })
  await store.upsertChallengeWork(CONNECTION.key, '1400', {
    challengeId: '1400', taskType: 1, envStarted: true, envReleased: false,
    envStartedAt: new Date(nowMs - 25 * 60000).toISOString(),
    envReleaseTime: new Date(nowMs + 6 * 60000).toISOString(), // 剩余 6 分钟
    connectionInfo: 'nc 1.1.1.1 1337',
  })
  // 新鲜记录（刚起的、剩余 25 分钟）
  const freshStore = new CtfStore({ dir: await makeTmpDir(), now: () => nowMs })
  await freshStore.upsertChallengeWork(CONNECTION.key, '1400', {
    challengeId: '1400', taskType: 1, envStarted: true, envReleased: false,
    envStartedAt: new Date(nowMs - 25 * 60000).toISOString(),
    envReleaseTime: new Date(nowMs + 6 * 60000).toISOString(),
    connectionInfo: 'nc 1.1.1.1 1337',
  })
  await freshStore.upsertChallengeWork(CONNECTION.key, '1401', {
    challengeId: '1401', taskType: 1, envStarted: true, envReleased: false,
    envStartedAt: new Date(nowMs).toISOString(),
    envReleaseTime: new Date(nowMs + 25 * 60000).toISOString(),
    connectionInfo: 'nc 1.1.1.2 1337',
  })

  const { teams } = makeTeams({ members })
  const stale = await makeOrchestrator({ challenges, teams, store, details, config: { concurrency: 1 } })
  const staleReport = await stale.orchestrator.status({ __agent: AGENT })
  assert.match(staleReport, /### ⚠️ 环境占用异常（1 题/)
  assert.match(staleReport, /环境空转 25 分钟/)
  assert.match(staleReport, /♻️ 建议释放让位/)
  assert.match(staleReport, /ctf_release_env id=1400/)
  assert.match(staleReport, /只提示，不自动抢占/)
  assert.match(staleReport, /⚠ 剩余 6m ♻️ 建议让位/, '表格环境列也要带标记')

  const fresh = await makeOrchestrator({ challenges, teams, store: freshStore, details, config: { concurrency: 1 } })
  const freshReport = await fresh.orchestrator.status({ __agent: AGENT })
  assert.doesNotMatch(freshReport, /环境空转/, '刚起的环境不该被判为停滞')
  assert.doesNotMatch(freshReport, /环境占用异常/)
  assert.match(freshReport, /剩余 2[0-9]m/, '新鲜环境正常显示剩余时间')

  // 最近有提交 → 视为有进展，不算停滞
  const submitStore = new CtfStore({ dir: await makeTmpDir(), now: () => nowMs - 25 * 60000 })
  await submitStore.upsertChallengeWork(CONNECTION.key, '1400', {
    challengeId: '1400', taskType: 1, envStarted: true, envReleased: false,
    envReleaseTime: new Date(nowMs + 6 * 60000).toISOString(), connectionInfo: 'nc 1.1.1.1 1',
  })
  await submitStore.recordSubmission({
    connKey: CONNECTION.key, challengeId: '1400', flag: 'flag{x}', status: 'incorrect',
    at: new Date(nowMs - 60000).toISOString(),
  })
  const withSubmit = await makeOrchestrator({ challenges, teams, store: submitStore, details, config: { concurrency: 1 } })
  const submitReport = await withSubmit.orchestrator.status({ __agent: AGENT })
  assert.doesNotMatch(submitReport, /环境空转/, '1 分钟前刚提交过 → 有进展，不算停滞')
})

test('ctf_solve_status：显示「就绪待环境」与「准备中」段', async () => {
  const nowMs = 1700000000000
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const challenges = [
    makeChallenge({ id: 1500, name: 'ready-one', category: 'Pwn', score: 300, solved: false }),
    makeChallenge({ id: 1501, name: 'prepping-one', category: 'Pwn', score: 200, solved: false }),
  ]
  const details = detailsFor([[1500, 1], [1501, 1]])
  const store = new CtfStore({ dir: await makeTmpDir(), now: () => nowMs })
  await store.upsertChallengeWork(CONNECTION.key, '1500', { challengeId: '1500', taskType: 1 })
  await store.upsertChallengeWork(CONNECTION.key, '1501', {
    challengeId: '1501', taskType: 1, status: 'prep', prepTeammate: 'prep-prepping-one-1501',
  })
  const existsSync = (target) => String(target).includes('ready-one-1500')
  const { teams, taskList } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges, teams, store, details, existsSync, config: { concurrency: 2, envLimit: 2 },
  })
  // 造两个任务（避免 start 建任务时的探测影响）：直接调 status
  taskList.push(
    { id: 'task-1', revision: 1, status: 'pending', subject: '[Pwn] ready-one (300分)', description: 'challengeId: 1500', writeScopes: ['lingxu-ctf-work/challenges/ready-one-1500'], blockedBy: [] },
    { id: 'task-2', revision: 1, status: 'pending', subject: '[Pwn] prepping-one (200分)', description: 'challengeId: 1501', writeScopes: ['lingxu-ctf-work/challenges/prepping-one-1501'], blockedBy: [] },
  )
  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /### ⏳ 就绪待环境（1 题：PREP\.md 已就绪/)
  assert.match(report, /ready-one \(#1500\)/)
  assert.match(report, /PREP\.md 已就绪/)
  assert.match(report, /### 🔧 准备中（1 题/)
  assert.match(report, /prep-prepping-one-1501/)
  assert.match(report, /- P0 就绪待环境：1 题｜准备中：1 题/)
})

// ---------------------------------------------------------------- teammate 上限（task-22）

test('resolveMaxTeamMembers：读运行时配置，缺失/垃圾值退回默认', () => {
  assert.equal(resolveMaxTeamMembers({ config: { maxMembers: 8 } }), 8, '用户 profile 覆盖成 8 时必须读到 8')
  assert.equal(resolveMaxTeamMembers({ config: { maxMembers: 3.9 } }), 3, '取整')
  assert.equal(resolveMaxTeamMembers({}), LIMITS.maxTeamMembers, '没有 config → 退回默认 16')
  assert.equal(resolveMaxTeamMembers(null), LIMITS.maxTeamMembers)
  for (const bad of ['x', 0, -1, NaN, null, undefined, {}]) {
    assert.equal(
      resolveMaxTeamMembers({ config: { maxMembers: bad } }),
      LIMITS.maxTeamMembers,
      `垃圾值 ${String(bad)} 应退回默认`,
    )
  }
  // 自定义 fallback
  assert.equal(resolveMaxTeamMembers({}, 4), 4)
  // 读 config 抛错（Cordis Proxy / 异形服务）也要退回默认
  const throwing = { get config() { throw new Error('proxy boom') } }
  assert.equal(resolveMaxTeamMembers(throwing), LIMITS.maxTeamMembers)
})

test('parseMemberLimit：从 DSH 报错里解析真实上限（解析不到就返回 null）', () => {
  assert.equal(parseMemberLimit(new Error('Team member limit 8 reached')), 8)
  assert.equal(parseMemberLimit(new Error('member limit 16 reached')), 16)
  assert.equal(parseMemberLimit({ message: 'TEAM_MEMBER_LIMIT: Team member limit 8 reached' }), 8)
  assert.equal(parseMemberLimit(new Error('Team member limit 8 reached'), 'cause: member limit 8 reached'), 8)
  assert.equal(parseMemberLimit(new Error('member limit reached')), null, '没有数字就别瞎设')
  assert.equal(parseMemberLimit(new Error('boom')), null)
  assert.equal(parseMemberLimit(null), null)
})

test('teammate 上限：读运行时配置 maxMembers=8 —— 已有 6 个 teammate 时最多再派 2 个', async () => {
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    ...Array.from({ length: 6 }, (_, i) => ({ name: `solver-x-${i}`, role: 'teammate', status: 'inactive' })),
  ]
  const { teams, calls } = makeTeams({ members })
  teams.config = { maxMembers: 8 } // 用户 profile 覆盖（DSH 语义：不含 lead）
  const challenges = Array.from({ length: 6 }, (_, i) => makeChallenge({ id: 2000 + i, name: `c-${i}`, score: 100 - i }))
  const { orchestrator } = await makeOrchestrator({ challenges, teams, config: { concurrency: 8 } })

  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 2, '8 - 6 = 只剩 2 个名额（lead 不算）')
  assert.match(summary, /团队余量：teammate 6\/8（上限来源：运行时配置 maxMembers/)
  assert.match(summary, /DSH 的 maxMembers \*\*不含 lead\*\*，含 lead 共 7 人/)
  assert.match(summary, /可用名额 2/)
})

test('teammate 上限：默认 16 时不因为多派准备 agent 就越界（含两阶段派发回归）', async () => {
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const envs = Array.from({ length: 10 }, (_, i) => makeChallenge({ id: 2100 + i, name: `e-${i}`, score: 100 - i }))
  const details = detailsFor(envs.map((_, i) => [2100 + i, 1]))
  const { teams, calls } = makeTeams({ members })
  const store = await makeStore()
  const { orchestrator } = await makeOrchestrator({
    challenges: envs, teams, store, details, config: { concurrency: 8, envLimit: 2 },
  })
  await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 8, '默认 16 时也受「并发 8」约束：2 全程 + 6 准备')
  assert.equal(calls.spawn.filter((c) => c.request.name.startsWith('solver-')).length, 2)
  assert.equal(calls.spawn.filter((c) => c.request.name.startsWith('prep-')).length, 6)
})

test('teammate 上限：从报错自学习真实值，下一轮按真值算（不再超发）', async () => {
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  let limit = 3 // DSH 真实上限（比默认 16 小得多）
  const { teams, calls } = makeTeams({
    members,
    // ⚠️ makeTeams 已经把这次调用 push 进 calls.spawn（count 就是本次是第几次），这里不要再 push。
    // 同时模拟 DSH 的真实行为：成功的成员会留在 roster 里（listMembers 能读到）→ 下一轮才知道名额已满。
    spawnImpl: (request, count) => {
      if (count > limit) {
        const error = new Error(`Team member limit ${limit} reached`)
        error.code = 'TEAM_MEMBER_LIMIT'
        throw error
      }
      members.push({ name: request.name, role: 'teammate', status: 'running' })
      return { name: request.name, status: 'provisioning' }
    },
  })
  const store = await makeStore()
  const challenges = Array.from({ length: 6 }, (_, i) => makeChallenge({ id: 2200 + i, name: `c-${i}`, score: 100 - i }))
  const { orchestrator } = await makeOrchestrator({ challenges, teams, store, config: { concurrency: 6 } })

  const first = await orchestrator.start({ __agent: AGENT })
  assert.match(first, /已达 teammate 上限/)
  assert.match(first, /maxMembers=3（来源：报错自学习/)
  assert.match(first, /本轮有 3 个 agent 没拉起来/)
  assert.match(first, /建议（任选其一）：/)
  assert.match(first, /ctf_solve_stop` 释放不再需要的 agent/)
  assert.match(first, /maxMembers`（当前 3，DSH 默认 16）/)
  // 学到的值落进 work 记录（排障用）
  const learned = await store.listChallengeWork(CONNECTION.key)
  assert.equal(learned.some((row) => row.teamLimitObserved === 3), true)

  // 第二轮：按真值 3 算 teamRoom（名额已满 → 一次都不试）
  const spawnCallsBefore = calls.spawn.length
  assert.equal(spawnCallsBefore, 4, '第一轮：3 次成功 + 1 次撞上限（共 4 次调用）')
  await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, spawnCallsBefore, '上限已满，第二轮不该再试')
})

test('teammate 上限：团队余量与并发取更小者；limitHit 不吞题（清单 + 建议）', async () => {
  // 只剩 1 个名额，但要派 4 个 → 只派 1 个，其余进「排队中」（不是上限问题）
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    ...Array.from({ length: 2 }, (_, i) => ({ name: `solver-t-${i}`, role: 'teammate', status: 'inactive' })),
  ]
  const { teams, calls } = makeTeams({ members })
  teams.config = { maxMembers: 3 }
  const challenges = Array.from({ length: 4 }, (_, i) => makeChallenge({ id: 2300 + i, name: `c-${i}`, score: 100 - i }))
  const { orchestrator } = await makeOrchestrator({ challenges, teams, config: { concurrency: 4 } })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.spawn.length, 1, 'teammate 2/3 → 只剩 1 个名额')
  assert.match(summary, /团队余量：teammate 2\/3/)
  assert.match(summary, /可用名额 1/)
  assert.doesNotMatch(summary, /已达 teammate 上限/, '名额是算准的，不该撞上限')
  assert.match(summary, /排队中（3 题/)
})

test('ctf_solve_status：显示成员 N/M 与上限来源', async () => {
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'solver-a-1', role: 'teammate', status: 'running' },
    { name: 'solver-b-2', role: 'teammate', status: 'inactive' },
  ]
  const { teams } = makeTeams({ members })
  teams.config = { maxMembers: 8 }
  const { orchestrator } = await makeOrchestrator({ challenges: [], teams, config: { concurrency: 4 } })
  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /- 成员：共 2（running 1，inactive 1，provisioning 0，failed 0）/)
  assert.match(report, /上限 8（来源：运行时配置 maxMembers）/)
  assert.match(report, /含 lead 共 3 人/)
  assert.match(report, /余量 6/)

  // 没有运行时配置时标注「默认值」
  const plain = makeTeams({ members })
  const fallback = await makeOrchestrator({ challenges: [], teams: plain.teams, config: { concurrency: 4 } })
  const fallbackReport = await fallback.orchestrator.status({ __agent: AGENT })
  assert.match(fallbackReport, /上限 16（来源：默认值）/)
})

// ---------------------------------------------------------------- Agent 池：复用闲置槽（task-23）
//
// 为什么必须复用：DSH 的 roster 是 **append-only + 累计计数**
// （README：「maxMembers = 一支团队最多可**曾创建过**的 teammate 数，含失败的」；
//   roster.js: `state.members.length >= maxMembers` 判定，`ctf_solve_stop` 也不会释放名额）。
// 算一笔账：**78 道题、不复用 = 需要 78 个名额**；复用闲置槽后 roster 增长 ≈ **峰值并发**（concurrency 4~8 个），
// 32 个名额也就够跑完整场比赛（不复用的话 32 个名额在 32 道题后就必然撞墙）。

/** 造一批「有闲置槽」的 mock：lead + N 个 inactive teammate，各自名下有一道**已解**的题。 */
function makePoolMembers({ idle = 0, running = 0, failed = 0, busyInactive = 0, startId = 900 } = {}) {
  const members = [{ name: 'lead', role: 'lead', status: 'running' }]
  const assignments = []
  let id = startId
  for (let i = 0; i < idle; i += 1) {
    const name = `solver-idle-${i}`
    members.push({ name, role: 'teammate', status: 'inactive' })
    assignments.push({ name, challengeId: String(id), solved: true })
    id += 1
  }
  for (let i = 0; i < running; i += 1) {
    const name = `solver-run-${i}`
    members.push({ name, role: 'teammate', status: 'running' })
    assignments.push({ name, challengeId: String(id), solved: false })
    id += 1
  }
  for (let i = 0; i < failed; i += 1) {
    const name = `solver-failed-${i}`
    members.push({ name, role: 'teammate', status: 'failed' })
    assignments.push({ name, challengeId: String(id), solved: true })
    id += 1
  }
  // inactive 但原题**没结束**（例如正在等环境配额）→ 绝不能挪用
  for (let i = 0; i < busyInactive; i += 1) {
    const name = `solver-waiting-${i}`
    members.push({ name, role: 'teammate', status: 'inactive' })
    assignments.push({ name, challengeId: String(id), solved: false })
    id += 1
  }
  return { members, assignments }
}

/** 把 mock 成员的「名下题目」写进 work 记录，并让平台列表带上「已解」标记。 */
async function seedPool({ store, assignments, extraChallenges = [] }) {
  const map = new Map(extraChallenges.map((c) => [String(c.id), c]))
  for (const item of assignments) {
    await store.upsertChallengeWork(CONNECTION.key, item.challengeId, {
      challengeId: item.challengeId,
      teammate: item.name,
      status: 'solving',
      subject: `[pwn] old-${item.challengeId} (100分)`,
      writeScope: `lingxu-ctf-work/challenges/old-${item.challengeId}`,
      taskType: 3,
    })
    if (!map.has(String(item.challengeId))) {
      map.set(String(item.challengeId), makeChallenge({
        id: Number(item.challengeId), name: `old-${item.challengeId}`, score: 100, solved: item.solved,
      }))
    }
  }
  return [...map.values()]
}

test('collectReusableSlots：inactive + 原题已结束 才算闲置；failed / running / 原题未结束都不算', async () => {
  const store = await makeStore()
  const { members, assignments } = makePoolMembers({ idle: 2, running: 1, failed: 1, busyInactive: 1 })
  const challenges = await seedPool({ store, assignments })
  const work = await store.listChallengeWork(CONNECTION.key)
  const workByChallenge = new Map(work.map((row) => [String(row.challengeId), row]))
  const solvedIds = new Set(challenges.filter((c) => c.solved === true).map((c) => String(c.id)))

  const slots = collectReusableSlots({
    members: members.filter((m) => m.role !== 'lead'),
    workByChallenge,
    solvedIds,
    completedIds: new Set(),
  })
  assert.deepEqual(slots.map((slot) => slot.name).sort(), ['solver-idle-0', 'solver-idle-1'])
  assert.equal(slots[0].previousId, '900')
  assert.equal(slots[0].category, 'pwn', '分类从 subject 的 [pwn] 前缀取（同类优先复用用）')

  // 任务板 completed 也算「原题结束」
  const completed = collectReusableSlots({
    members: members.filter((m) => m.role !== 'lead'),
    workByChallenge,
    solvedIds: new Set(),
    completedIds: new Set(assignments.map((item) => String(item.challengeId))),
  })
  assert.equal(completed.length, 3, '任务完成也算结束（2 个 idle + 1 个在等配额的 inactive；running/failed 仍被排除）')
})

test('Agent 池：2 个闲置槽 + 2 道新题 → spawnTeammate 0 次、sendMessage 2 次（不新建）', async () => {
  const store = await makeStore()
  const { members, assignments } = makePoolMembers({ idle: 2 })
  const oldChallenges = await seedPool({ store, assignments })
  const fresh = [1, 2].map((id) => makeChallenge({ id, name: `new-${id}`, score: 500 - id }))
  const { teams, calls } = makeTeams({ members })
  const { orchestrator, adapterCalls } = await makeOrchestrator({
    challenges: [...oldChallenges, ...fresh], teams, store, config: { concurrency: 4 },
  })
  const summary = await orchestrator.start({ __agent: AGENT })

  assert.equal(calls.spawn.length, 0, '有闲置槽就不该新建 teammate（roster 名额要省着用）')
  assert.equal(calls.sendMessage.length, 2, '两道题各唤醒一个闲置槽')
  assert.deepEqual(
    calls.sendMessage.map((call) => call.request.target).sort(),
    ['solver-idle-0', 'solver-idle-1'],
  )
  // sendMessage 的服务层契约：content 是 ContentBlock[]，且必须带 signal
  for (const call of calls.sendMessage) {
    assert.equal(Array.isArray(call.request.content), true)
    assert.equal(call.request.content[0].type, 'text')
    assert.ok(call.request.signal, '缺 signal 会 TypeError（mailbox 里 AbortSignal.any）')
  }
  assert.match(summary, /♻️ 复用闲置槽（2 个/)
  assert.match(summary, /本轮分配 2 个（♻️ 复用 2 \/ 🆕 新建 0）/)
  assert.equal(adapterCalls.detail.length <= 12, true)
})

test('Agent 池：1 个闲置槽 + 2 道题 → 1 次 sendMessage + 1 次 spawn（不够才新建）', async () => {
  const store = await makeStore()
  const { members, assignments } = makePoolMembers({ idle: 1 })
  const oldChallenges = await seedPool({ store, assignments })
  const fresh = [1, 2].map((id) => makeChallenge({ id, name: `new-${id}`, score: 500 - id }))
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: [...oldChallenges, ...fresh], teams, store, config: { concurrency: 4 },
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.sendMessage.length, 1)
  assert.equal(calls.spawn.length, 1)
  assert.match(summary, /本轮分配 2 个（♻️ 复用 1 \/ 🆕 新建 1）/)
})

test('Agent 池：running 的槽不能被抢；原题未结束的 inactive 槽也不能挪用', async () => {
  const store = await makeStore()
  const { members, assignments } = makePoolMembers({ running: 2, busyInactive: 2 })
  const oldChallenges = await seedPool({ store, assignments })
  const fresh = [1, 2].map((id) => makeChallenge({ id, name: `new-${id}`, score: 500 - id }))
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: [...oldChallenges, ...fresh], teams, store, config: { concurrency: 8 },
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.sendMessage.length, 0, '一个槽都不能挪（running 在干活，inactive 但原题没结束）')
  assert.equal(
    calls.spawn.filter((call) => call.request.name.includes('new-')).length,
    2,
    '两道新题只能靠新建（老题那两道未解的也会各自新建）',
  )
  assert.match(summary, /闲置可复用 0 个/)
})

test('Agent 池：failed 成员不复用，但占名额（teamRoom 要扣掉）', async () => {
  const store = await makeStore()
  const { members, assignments } = makePoolMembers({ failed: 3 })
  const oldChallenges = await seedPool({ store, assignments })
  const fresh = [1, 2, 3, 4].map((id) => makeChallenge({ id, name: `new-${id}`, score: 500 - id }))
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: [...oldChallenges, ...fresh], teams, store,
    config: { concurrency: 8, envLimit: 2 }, maxMembersOverride: 5,
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.sendMessage.length, 0, 'failed 的槽不可复用')
  assert.equal(calls.spawn.length, 2, 'maxMembers=5、已有 3 个 failed → 只剩 2 个名额（failed 照样占名额）')
  assert.match(summary, /roster 3\/5/)
})

test('Agent 池：换题消息第一句就要求「完全忽略」上一题（防上下文污染）+ 迁移 work 记录', async () => {
  const store = await makeStore()
  const { members, assignments } = makePoolMembers({ idle: 1 })
  const oldChallenges = await seedPool({ store, assignments })
  const fresh = [makeChallenge({ id: 77, name: 'FreshTarget', category: 'crypto', score: 400 })]
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: [...oldChallenges, ...fresh], teams, store, config: { concurrency: 2 },
  })
  await orchestrator.start({ __agent: AGENT })

  const message = calls.sendMessage[0].request.content.map((block) => block.text).join('\n')
  assert.match(message, /^⚠️ 你之前在做 #900（old-900）/, '第一句必须是换题声明')
  assert.match(message, /完全忽略/)
  assert.match(message, /重新完整读一遍/)
  assert.match(message, /不要碰 #900/)
  assert.match(message, /ctf_challenge id=77/)
  assert.match(message, /challenges\/freshtarget-77\//, '产物要写进新题目录')
  assert.match(message, /解出 CTF 题目「FreshTarget」/, '新题任务书要完整（自包含）')

  // work 记录迁移：旧题标 reassignedTo 且清掉 teammate；新题记 reassignedFrom
  const oldRecord = (await store.listChallengeWork(CONNECTION.key)).find((row) => String(row.challengeId) === '900')
  assert.equal(oldRecord.status, 'reassigned')
  assert.equal(oldRecord.reassignedTo, '77')
  assert.equal(oldRecord.previousTeammate, 'solver-idle-0')
  assert.equal(Boolean(oldRecord.teammate), false, 'teammate 要清空，否则旧题永远派不出去')
  const newRecord = (await store.listChallengeWork(CONNECTION.key)).find((row) => String(row.challengeId) === '77')
  assert.equal(newRecord.teammate, 'solver-idle-0')
  assert.equal(newRecord.reassignedFrom, '900')
  assert.equal(newRecord.status, 'solving')
})

test('Agent 池：reuseAgents=false → 退回每题新建（并提示名额会耗尽）', async () => {
  const store = await makeStore()
  const { members, assignments } = makePoolMembers({ idle: 2 })
  const oldChallenges = await seedPool({ store, assignments })
  const fresh = [1, 2].map((id) => makeChallenge({ id, name: `new-${id}`, score: 500 - id }))
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges: [...oldChallenges, ...fresh], teams, store, config: { concurrency: 4, reuseAgents: false },
  })
  const summary = await orchestrator.start({ __agent: AGENT })
  assert.equal(calls.sendMessage.length, 0, '关掉复用就只 spawn')
  assert.equal(calls.spawn.length, 2)
  assert.match(summary, /reuseAgents=false/)
  assert.match(summary, /每题新建 agent/)
})

test('ctf_solve_status：Agent 池视图（活跃 / 闲置可复用 / 占用不可挪 / failed + 当前题目）', async () => {
  const store = await makeStore()
  const { members, assignments } = makePoolMembers({ idle: 1, running: 1, busyInactive: 1, failed: 1 })
  const challenges = await seedPool({ store, assignments })
  const { teams, taskList } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({
    challenges, teams, store, config: { concurrency: 4 },
  })
  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /### 🧩 Agent 池（4 槽：活跃 1 \/ 闲置可复用 1 \/ 占用不可挪 1 \/ failed 1）/)
  assert.match(report, /- solver-idle-0：♻️ 闲置可复用（原 #900 old-900 已结束/)
  assert.match(report, /- solver-run-0：🏃 活跃（当前 #901 old-901）/)
  assert.match(report, /- solver-waiting-0：🔒 占用中（#903 old-903 未结束，不可挪用/)
  assert.match(report, /- solver-failed-0：⛔ failed（不可复用，但仍占名额）/)
  assert.match(report, /roster 是\*\*累计且不可回收\*\*/)
  assert.equal(taskList.length, 0, 'status 只读，不该建任务')
})

test('Agent 池：ctf_solve_stop 中断后，槽变成「闲置可复用」（工作记录标 abandoned）', async () => {
  const store = await makeStore()
  const { members, assignments } = makePoolMembers({ running: 1 })
  const challenges = await seedPool({ store, assignments })
  const { teams, calls } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({ challenges, teams, store, config: { concurrency: 4 } })
  await orchestrator.stop({ __agent: AGENT })
  assert.equal(calls.interrupt.length, 1, '中断了 1 个槽')
  const record = (await store.listChallengeWork(CONNECTION.key)).find((row) => String(row.challengeId) === '900')
  assert.equal(record.status, 'abandoned')
  assert.equal(Boolean(record.teammate), false)

  // 下一轮：这个槽已经闲置 → 直接复用到新题（不再新建）
  // ⚠️ 真实 DSH 里 interrupt 之后成员 status 会变成 inactive；mock 不会自动改，手动同步一下
  members[1].status = 'inactive'
  const fresh = [makeChallenge({ id: 55, name: 'AfterStop', score: 300 })]
  const second = makeTeams({ members })
  const next = await makeOrchestrator({
    challenges: [...challenges, ...fresh], teams: second.teams, store, config: { concurrency: 2 },
  })
  const afterStop = await next.orchestrator.start({ __agent: AGENT })
  // 新题（300 分）优先级更高 → 复用这个刚闲置的槽；被放弃的旧题（100 分）则重新新建一个槽
  assert.equal(second.calls.sendMessage.length, 1)
  assert.equal(second.calls.sendMessage[0].request.target, 'solver-run-0')
  assert.match(second.calls.sendMessage[0].request.content.map((b) => b.text).join('\n'), /完全忽略/)
  assert.equal(second.calls.spawn.length, 1, '被放弃的题重新排队 → 新建一个槽')
  assert.match(afterStop, /本轮分配 2 个（♻️ 复用 1 \/ 🆕 新建 1）/)
})

test('Agent 池：同一道题被中断后重新派回 → 用「重启」消息（接着旧成果，不是「忽略上一题」）', async () => {
  const store = await makeStore()
  const { members, assignments } = makePoolMembers({ running: 1 })
  const challenges = await seedPool({ store, assignments })
  const { teams } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({ challenges, teams, store, config: { concurrency: 2 } })
  await orchestrator.stop({ __agent: AGENT })
  members[1].status = 'inactive'

  // 只留被中断的那道题（不加新题）→ 重新派回原题
  const second = makeTeams({ members })
  const next = await makeOrchestrator({ challenges, teams: second.teams, store, config: { concurrency: 2 } })
  await next.orchestrator.start({ __agent: AGENT })
  assert.equal(second.calls.spawn.length, 0)
  assert.equal(second.calls.sendMessage.length, 1)
  const message = second.calls.sendMessage[0].request.content.map((b) => b.text).join('\n')
  assert.match(message, /这\*\*不是新题\*\*，是\*\*重启\*\*上一轮被中断的进度/)
  assert.match(message, /PREP\.md/)
  assert.doesNotMatch(message, /完全忽略/, '同一道题不能说「忽略上一题」')
})

test('Agent 池：同类优先复用（做过 Crypto 的槽优先接 Crypto 新题）', () => {
  const slots = [
    { name: 'solver-pwn-1', previousId: '1', category: 'Pwn' },
    { name: 'solver-crypto-2', previousId: '2', category: 'Crypto' },
    { name: 'solver-misc-3', previousId: '3', category: 'Misc' },
  ]
  const picked = takeSlotFor(slots, { id: 9, category: 'Crypto' })
  assert.equal(picked.name, 'solver-crypto-2', '同类槽优先（上一题的领域上下文可能反而是优势）')
  assert.equal(slots.length, 2, '取走的槽要从池里移除')
  const fallback = takeSlotFor(slots, { id: 10, category: 'Web' })
  assert.equal(fallback.name, 'solver-pwn-1', '没有同类 → 取第一个')
  assert.equal(takeSlotFor([], { id: 11, category: 'Web' }), null)
})

test('Agent 池：离线准备槽单独显示（不写 teammate，但别显示成「状态未知」）', async () => {
  const store = await makeStore()
  const members = [
    { name: 'lead', role: 'lead', status: 'running' },
    { name: 'prep-ready-7', role: 'teammate', status: 'inactive' },
  ]
  const challenges = [makeChallenge({ id: 7, name: 'prep-target', score: 300 })]
  await store.upsertChallengeWork(CONNECTION.key, '7', {
    challengeId: '7', taskType: 1, status: 'prep', prepTeammate: 'prep-ready-7',
    subject: '[Pwn] prep-target (300分)', writeScope: 'lingxu-ctf-work/challenges/prep-target-7',
  })
  const { teams } = makeTeams({ members })
  const { orchestrator } = await makeOrchestrator({ challenges, teams, store, config: { concurrency: 4 } })
  const report = await orchestrator.status({ __agent: AGENT })
  assert.match(report, /### 🧩 Agent 池（1 槽：活跃 0 \/ 闲置可复用 0 \/ 占用不可挪 0 \/ 准备槽 1）/)
  assert.match(report, /- prep-ready-7：🌙 准备槽（#7 prep-target 等环境配额/)
})
