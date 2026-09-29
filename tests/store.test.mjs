import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CtfStore, connectionKey, emptyState } from '../lib/store.js'

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
})
