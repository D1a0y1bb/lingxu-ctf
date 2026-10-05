import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdapter } from '../lib/platforms.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status < 400,
    async json() { return body },
    async text() { return JSON.stringify(body) },
  }
}

async function replayFixture(name, run) {
  const fixture = JSON.parse(await readFile(path.join(here, 'fixtures', 'lingxu', name), 'utf8'))
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    const route = fixture.routes?.[parsed.pathname]
    if (route === undefined) throw new Error(`fixture route missing: ${parsed.pathname}`)
    return jsonResponse(route)
  }
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

test('脱敏凌虚 fixture 可以回放赛事、题目、详情、排行和理论题链路', async () => {
  await replayFixture('event-basic.json', async () => {
    const adapter = createAdapter({ baseUrl: 'https://fixture.invalid', eventId: 10, cookie: 'sessionid=fixture-session' })
    const summary = await adapter.eventSummary()
    assert.equal(summary.name, '脱敏演示赛')
    assert.equal(summary.hasCtf, true)
    assert.equal(summary.hasAwd, false)
    const challenges = await adapter.challenges()
    assert.equal(challenges.length, 2)
    assert.equal(challenges[1].solved, true)
    const detail = await adapter.challengeDetail(101)
    assert.equal(detail.taskType, 3)
    assert.match(detail.description, /本地回放/)
    const board = await adapter.leaderboard('user', { size: 20 })
    assert.equal(board.rows[0].isSelf, true)
    const theory = await adapter.theoryTests()
    assert.equal(theory[0].id, 201)
  })
})

test('session-expired fixture 保留真实 HTTP 状态，适配器负责统一错误', async () => {
  const fixture = JSON.parse(await readFile(path.join(here, 'fixtures', 'lingxu', 'session-expired.json'), 'utf8'))
  const original = globalThis.fetch
  globalThis.fetch = async () => jsonResponse(fixture.body, fixture.status)
  try {
    const adapter = createAdapter({ baseUrl: 'https://fixture.invalid', eventId: 10, cookie: 'sessionid=fixture-session' })
    await assert.rejects(() => adapter.eventSummary(), (error) => error?.code === 'session-expired' && error?.httpStatus === 403)
  } finally {
    globalThis.fetch = original
  }
})
