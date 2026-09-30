import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { LingxuClient } from '../lib/lingxu.js'

const WORKER = fileURLToPath(import.meta.url)

function runWorker(baseUrl, statePath, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, '--worker', baseUrl, statePath, label], {
      cwd: path.dirname(WORKER),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`rate worker ${label} exited with ${code ?? signal}: ${stderr}`))
    })
  })
}

async function workerMain(baseUrl, statePath) {
  const client = new LingxuClient({
    baseUrl,
    eventId: 1,
    cookie: '',
    minIntervalMs: 60,
    maxConcurrent: 1,
    maxRetries: 0,
    sharedRateLimit: true,
    sharedRateStatePath: statePath,
    timeoutMs: 5000,
  })
  await Promise.all(Array.from({ length: 5 }, () => client.request('/probe')))
}

if (process.argv[2] === '--worker') {
  await workerMain(process.argv[3], process.argv[4])
} else {
  test('两个独立 DSH 进程共用账号时共享 host 限流租约', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-shared-rate-'))
    const starts = []
    let inFlight = 0
    let maxInFlight = 0
    const server = http.createServer((req, res) => {
      if (req.url !== '/probe') {
        res.statusCode = 404
        res.end()
        return
      }
      starts.push(Date.now())
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      setTimeout(() => {
        inFlight -= 1
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      }, 20)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const baseUrl = `http://127.0.0.1:${port}`
    try {
      await Promise.all([
        runWorker(baseUrl, path.join(dir, 'rate-limit.json'), 'a'),
        runWorker(baseUrl, path.join(dir, 'rate-limit.json'), 'b'),
      ])
      assert.equal(starts.length, 10)
      assert.equal(maxInFlight, 1)
      const intervals = starts.slice(1).map((at, index) => at - starts[index])
      // 共享租约设为 60ms；跨进程调度和 loopback socket 到达时间会有少量抖动，
      // 这里保留 35ms 的下界，重点确认没有退化成同时发射。
      assert.ok(Math.min(...intervals) >= 35, `跨进程最小间隔 ${Math.min(...intervals)}ms，小于共享限流下界`)
      const stateText = await fsp.readFile(path.join(dir, 'rate-limit.json'), 'utf8')
      const state = JSON.parse(stateText)
      assert.equal(Object.keys(state.hosts).length, 1)
      assert.deepEqual((state.hosts[Object.keys(state.hosts)[0]].leases), [])
    } finally {
      await new Promise((resolve) => server.close(resolve))
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
}
