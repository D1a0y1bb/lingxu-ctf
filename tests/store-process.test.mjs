import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { CtfStore, connectionKey } from '../lib/store.js'

const WORKER = fileURLToPath(import.meta.url)

function runWorker(dir, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, '--worker', dir, label], {
      cwd: path.dirname(WORKER),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`store worker ${label} exited with ${code ?? signal}: ${stderr}`))
    })
  })
}

async function workerMain(dir, label) {
  const store = new CtfStore({ dir })
  await store.load()
  for (let i = 0; i < 20; i += 1) {
    const connKey = connectionKey({ platform: 'lingxu', baseUrl: `https://${label}.example`, eventId: i + 1 })
    await store.upsertConnection({
      platform: 'lingxu',
      baseUrl: `https://${label}.example`,
      eventId: i + 1,
      label: `${label}-${i}`,
      cookie: 'sessionid=redacted',
    })
    await store.recordSubmission({ connKey, challengeId: `${label}-challenge-${i}`, flag: `flag{${label}-${i}}`, status: 'wrong' })
    await store.upsertChallengeWork(connKey, `${label}-challenge-${i}`, { status: 'running', owner: label })
    await store.appendTeamMessage(connKey, {
      messageId: `${label}-${i}`,
      from: label,
      text: `message-${label}-${i}`,
    })
  }
}

if (process.argv[2] === '--worker') {
  await workerMain(process.argv[3], process.argv[4])
} else {
  test('两个独立 Node 进程并发写入时保留连接、提交、题目工作和团队消息', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-store-process-'))
    try {
      await Promise.all([runWorker(dir, 'worker-a'), runWorker(dir, 'worker-b')])

      const store = new CtfStore({ dir })
      await store.load()
      assert.equal(Object.keys(store.state.connections).length, 40)
      assert.equal(store.state.submissions.length, 40)
      assert.equal(Object.keys(store.state.challengeWork).length, 40)
      assert.equal(store.state.teamMessages.length, 40)

      const files = await fsp.readdir(dir)
      assert.deepEqual(files.filter((name) => name.endsWith('.lock') || name.includes('.tmp-')), [])
      const stateStat = await fsp.stat(path.join(dir, 'state.json'))
      assert.equal(stateStat.mode & 0o777, 0o600)
      const dirStat = await fsp.stat(dir)
      assert.equal(dirStat.mode & 0o777, 0o700)
      const stateText = await fsp.readFile(path.join(dir, 'state.json'), 'utf8')
      assert.doesNotThrow(() => JSON.parse(stateText))
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
}
