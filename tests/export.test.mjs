import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createExportBundle } from '../lib/export.js'
import { CtfStore } from '../lib/store.js'

test('ctf_export_bundle 导出附件、WP、脚本并脱敏提交记录', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-export-'))
  try {
    const store = new CtfStore({ dir: path.join(root, 'store') })
    const connKey = 'lingxu:fixture.invalid:10'
    await store.upsertChallengeWork(connKey, 101, {
      name: 'fixture-web',
      category: 'Web',
      taskType: 3,
      status: 'solved',
      writeupPath: path.join(root, 'writeups', 'fixture-web-101.md'),
    })
    await store.recordSubmission({ connKey, challengeId: 101, flag: 'FLAG{fixture-secret}', status: 'correct' })
    await fsp.mkdir(path.join(root, 'challenges', 'fixture-web-101', 'distfiles'), { recursive: true })
    await fsp.writeFile(path.join(root, 'challenges', 'fixture-web-101', 'distfiles', 'readme.txt'), 'fixture attachment')
    await fsp.mkdir(path.join(root, 'writeups'), { recursive: true })
    await fsp.writeFile(path.join(root, 'writeups', 'fixture-web-101.md'), '# fixture writeup')
    await fsp.mkdir(path.join(root, 'scripts'), { recursive: true })
    await fsp.writeFile(path.join(root, 'scripts', 'solve-101.py'), 'print("fixture")')
    await fsp.writeFile(path.join(root, 'store.json'), 'should never be copied')
    const exporter = createExportBundle({
      config: { workDir: root },
      store,
      now: () => Date.parse('2026-01-02T03:04:05Z'),
      resolveAdapter: async () => ({
        connKey,
        connection: { platform: 'lingxu', eventId: 10, baseUrl: 'https://fixture.invalid' },
        adapter: { challengeDetail: async () => ({ id: 101, name: 'fixture-web', category: 'Web', score: 100, solved: true, taskType: 3 }) },
      }),
    })
    const result = await exporter.export({ id: 101 })
    assert.equal(result.ok, true)
    const manifest = JSON.parse(await fsp.readFile(result.manifestPath, 'utf8'))
    assert.equal(manifest.counts.challenges, 1)
    assert.equal(manifest.submissions[0].flag, 'FLAG{f********t}')
    assert.equal(JSON.stringify(manifest).includes('fixture-secret'), false)
    assert.equal(manifest.files.includes('store.json'), false)
    assert.equal(manifest.files.includes('challenges/fixture-web-101/distfiles/readme.txt'), true)
    assert.equal(manifest.files.includes('writeups/fixture-web-101.md'), true)
    assert.equal(manifest.files.includes('scripts/solve-101.py'), true)
    assert.equal(manifest.exclusions.includes('Cookie'), true)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
