import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CtfStore, connectionKey, emptyState, TEAM_MESSAGE_LIMIT, TEAM_MESSAGE_TEXT_LIMIT } from '../lib/store.js'

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ctf-store-'))
}

test('connectionKey: 稳定且忽略协议与尾斜杠', () => {
  const a = connectionKey({ platform: 'lingxu', baseUrl: 'https://ctf.example.com:8000/', eventId: 4 })
  const b = connectionKey({ platform: 'lingxu', baseUrl: 'http://ctf.example.com:8000', eventId: 4 })
  assert.equal(a, b)
  assert.equal(a, 'lingxu:ctf.example.com:8000:4')
})

test('连接增删改查与 activeConnection', async () => {
  const dir = await tempDir()
  const store = new CtfStore({ dir })
  await store.load()
  assert.deepEqual(await store.listConnections(), [])

  const conn = await store.upsertConnection({
    platform: 'lingxu', baseUrl: 'https://a.example.com', eventId: 1, cookie: 'sessionid=x',
  })
  assert.equal(conn.key, 'lingxu:a.example.com:1')
  assert.equal(conn.createdAt !== undefined, true)

  const resolved = await store.resolveConnection({})
  assert.equal(resolved.cookie, 'sessionid=x')

  await store.upsertConnection({ platform: 'lingxu', baseUrl: 'https://b.example.com', eventId: 2, cookie: 'sessionid=y' })
  assert.equal((await store.resolveConnection({})).eventId, 2, '后配置的成为 active')

  await store.setActive('lingxu:a.example.com:1')
  assert.equal((await store.resolveConnection({})).eventId, 1)
  assert.equal((await store.resolveConnection({ eventId: 2 })).eventId, 2, '显式 eventId 覆盖 active')

  await assert.rejects(() => store.setActive('nope'), /未知连接/)
})

test('resolveConnection: 无任何连接时返回 undefined', async () => {
  const dir = await tempDir()
  const store = new CtfStore({ dir })
  assert.equal(await store.resolveConnection({}), undefined)
})

test('upsertConnection 保留 createdAt 并刷新 updatedAt', async () => {
  const dir = await tempDir()
  let clock = 1000
  const store = new CtfStore({ dir, now: () => clock })
  const first = await store.upsertConnection({ platform: 'lingxu', baseUrl: 'https://a.com', eventId: 1 })
  clock = 5000
  const second = await store.upsertConnection({ platform: 'lingxu', baseUrl: 'https://a.com', eventId: 1, label: 'x' })
  assert.equal(first.createdAt, second.createdAt)
  assert.notEqual(first.updatedAt, second.updatedAt)
  assert.equal(second.label, 'x')
})

test('flag 审计：去重 / 错误计数 / 截断', async () => {
  const dir = await tempDir()
  const store = new CtfStore({ dir })
  const key = 'lingxu:a.com:1'

  await store.recordSubmission({ connKey: key, challengeId: 7, flag: 'flag{a}', status: 'correct' })
  assert.equal(await store.hasSubmittedFlag(key, 7, 'flag{a}'), true)
  assert.equal(await store.hasSubmittedFlag(key, 7, 'flag{b}'), false)
  assert.equal(await store.hasSubmittedFlag(key, 8, 'flag{a}'), false)

  await store.recordSubmission({ connKey: key, challengeId: 8, flag: 'flag{x}', status: 'incorrect' })
  await store.recordSubmission({ connKey: key, challengeId: 8, flag: 'flag{y}', status: 'incorrect' })
  assert.equal(await store.wrongAttemptCount(key, 8), 2)
  assert.equal(await store.wrongAttemptCount(key, 7), 0)

  const flags = await store.submittedFlagsFor(key, 8)
  assert.deepEqual(flags.map((f) => f.flag), ['flag{x}', 'flag{y}'])
})

test('flag 去重：incorrect 不算已提交', async () => {
  const dir = await tempDir()
  const store = new CtfStore({ dir })
  await store.recordSubmission({ connKey: 'k', challengeId: 1, flag: 'f', status: 'incorrect' })
  assert.equal(await store.hasSubmittedFlag('k', 1, 'f'), false)
})

test('题目工作记录', async () => {
  const dir = await tempDir()
  const store = new CtfStore({ dir })
  await store.upsertChallengeWork('k', 3, { status: 'working', owner: 'solver-a-3' })
  await store.upsertChallengeWork('k', 3, { writeupPath: '/tmp/x.md' })
  const work = await store.getChallengeWork('k', 3)
  assert.equal(work.status, 'working')
  assert.equal(work.owner, 'solver-a-3')
  assert.equal(work.writeupPath, '/tmp/x.md')
  assert.equal((await store.listChallengeWork('k')).length, 1)
  assert.equal((await store.listChallengeWork('other')).length, 0)
})

test('持久化跨实例可读', async () => {
  const dir = await tempDir()
  const a = new CtfStore({ dir })
  await a.upsertConnection({ platform: 'lingxu', baseUrl: 'https://a.com', eventId: 9, cookie: 'sessionid=zzz' })
  const b = new CtfStore({ dir })
  assert.equal((await b.resolveConnection({})).cookie, 'sessionid=zzz')
})

test('损坏的状态文件：备份后从空状态继续，不抛错', async () => {
  const dir = await tempDir()
  await fsp.writeFile(path.join(dir, 'state.json'), '{ this is not json', 'utf8')
  const store = new CtfStore({ dir })
  const state = await store.load()
  assert.deepEqual(Object.keys(state.connections), [])
  const files = await fsp.readdir(dir)
  assert.equal(files.some((f) => f.startsWith('state.json.corrupt-')), true, '应留下损坏备份')
})

test('emptyState 形状稳定', () => {
  const s = emptyState()
  assert.equal(s.version, 1)
  assert.deepEqual(s.connections, {})
  assert.equal(s.activeConnection, null)
  assert.deepEqual(s.submissions, [])
  assert.deepEqual(s.teamMessages, [], '团队消息队列必须存在（旧状态文件也要能兼容）')
})

// ────────────────────────────────────────────── 团队协同消息

test('团队消息：append/list、默认字段、按连接过滤', async () => {
  const dir = await tempDir()
  const store = new CtfStore({ dir })
  const key = 'lingxu:a.com:1'

  const record = await store.appendTeamMessage(key, { from: 'solver-a-1', to: 'lead', kind: 'report', text: '已解出' })
  assert.equal(record.connKey, key)
  assert.equal(record.from, 'solver-a-1')
  assert.equal(record.to, 'lead')
  assert.equal(record.kind, 'report')
  assert.equal(record.text, '已解出')
  assert.match(record.at, /^\d{4}-\d{2}-\d{2}T/)

  // 缺省字段有兜底值，且不会污染其他连接的读取
  const sparse = await store.appendTeamMessage(key, { text: '只有正文' })
  assert.equal(sparse.from, 'unknown')
  assert.equal(sparse.to, 'team')
  assert.equal(sparse.kind, 'note')

  await store.appendTeamMessage('lingxu:b.com:2', { text: '另一场比赛' })

  const mine = await store.listTeamMessages(key)
  assert.deepEqual(mine.map((m) => m.text), ['已解出', '只有正文'], '按写入顺序（最旧 → 最新）')
  const other = await store.listTeamMessages('lingxu:b.com:2')
  assert.deepEqual(other.map((m) => m.text), ['另一场比赛'])
  // 省略 connKey = 全量（没有平台连接时也能看到协同记录）
  assert.equal((await store.listTeamMessages()).length, 3)
  // limit = 取最新 N 条
  assert.deepEqual((await store.listTeamMessages(key, 1)).map((m) => m.text), ['只有正文'])
})

test('团队消息：单条正文截断到 2000 字符（不把大段内容写进状态文件）', async () => {
  const dir = await tempDir()
  const store = new CtfStore({ dir })
  const record = await store.appendTeamMessage('k', { text: 'x'.repeat(5000) })
  assert.equal(record.text.length, TEAM_MESSAGE_TEXT_LIMIT)
  assert.equal(TEAM_MESSAGE_TEXT_LIMIT, 2000)
  const [stored] = await store.listTeamMessages('k')
  assert.equal(stored.text.length, 2000)
  // from/to/kind 是标识字段，也有长度上限
  const long = await store.appendTeamMessage('k', { from: 'f'.repeat(200), kind: 'k'.repeat(200), text: 't' })
  assert.equal(long.from.length <= 64, true)
  assert.equal(long.kind.length <= 64, true)
})

test('团队消息：FIFO 上限 500 条，超出丢最旧的', async () => {
  const dir = await tempDir()
  let clock = 0
  const store = new CtfStore({ dir, now: () => (clock += 1000) })
  for (let i = 1; i <= TEAM_MESSAGE_LIMIT + 5; i += 1) {
    await store.appendTeamMessage('k', { text: `msg-${i}` })
  }
  const rows = await store.listTeamMessages('k', 10_000)
  assert.equal(rows.length, TEAM_MESSAGE_LIMIT)
  assert.equal(rows[0].text, 'msg-6', '最旧的 5 条应被淘汰')
  assert.equal(rows[rows.length - 1].text, `msg-${TEAM_MESSAGE_LIMIT + 5}`)
  // 落盘文件里也不该无限增长
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(raw.teamMessages.length, TEAM_MESSAGE_LIMIT)
})

test('团队消息：at 认不出来时回退为当前时间；跨实例可读；旧状态文件兼容', async () => {
  const dir = await tempDir()
  const store = new CtfStore({ dir, now: () => Date.parse('2026-09-29T05:02:45.000Z') })
  const bad = await store.appendTeamMessage('k', { at: 'not-a-time', text: 'x' })
  assert.equal(bad.at, '2026-09-29T05:02:45.000Z')
  const numeric = await store.appendTeamMessage('k', { at: 1790651925466, text: 'y' })
  assert.equal(numeric.at, new Date(1790651925466).toISOString())
  const explicit = await store.appendTeamMessage('k', { at: '2026-09-29T05:02:10.000Z', text: 'z' })
  assert.equal(explicit.at, '2026-09-29T05:02:10.000Z')

  const reopened = new CtfStore({ dir })
  assert.deepEqual((await reopened.listTeamMessages('k')).map((m) => m.text), ['x', 'y', 'z'])

  // 老版本状态文件（没有 teamMessages 字段）读进来必须是空队列而不是崩
  const legacyDir = await tempDir()
  await fsp.writeFile(
    path.join(legacyDir, 'state.json'),
    JSON.stringify({ version: 1, connections: {}, activeConnection: null, submissions: [], challengeWork: {} }),
    'utf8',
  )
  const legacy = new CtfStore({ dir: legacyDir })
  assert.deepEqual(await legacy.listTeamMessages('k'), [])
  await legacy.appendTeamMessage('k', { text: 'after-upgrade' })
  assert.deepEqual((await legacy.listTeamMessages('k')).map((m) => m.text), ['after-upgrade'])
})

