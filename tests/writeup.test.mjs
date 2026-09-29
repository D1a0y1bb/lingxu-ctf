/**
 * lib/writeup.js 单元测试。
 *
 * 用真实 CtfStore（临时目录）+ mock adapter，覆盖：
 *   1. 正常生成（题面 / 元信息 / 时间线 / flag / store 登记）
 *   2. 中文题名 slug 不被清空
 *   3. 无 work 记录时的降级文案
 *   4. 平台不支持 WP 提交时的明确说明（不抛异常）
 *   5. body 覆盖思路、force 语义、复现脚本内联、list
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CtfStore, connectionKey } from '../lib/store.js'
import { createWriteup, resolveWorkDir, slugify, writeupDir, writeupFileName } from '../lib/writeup.js'
// 跨模块 slug 契约：编排层/工具层用 index.js 的 slugify 决定目录名，必须与本模块一致
import { slugify as indexSlugify } from '../lib/index.js'
import { writeScopeFor } from '../lib/orchestrate.js'

const CONNECTION = { platform: 'lingxu', baseUrl: 'https://example.test:8000', eventId: 4 }
const CONN_KEY = connectionKey(CONNECTION)
const NOW = () => Date.parse('2026-09-29T03:00:00Z')

/** 建一套临时环境：临时 state 目录 + 临时 workDir + mock adapter。 */
async function makeEnv({ detail = {}, adapter: adapterOverride = {}, connection = CONNECTION, work, submissions = [] } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-writeup-'))
  const workDir = path.join(root, 'work')
  const store = new CtfStore({ dir: path.join(root, 'state'), now: NOW })
  await store.load()

  if (work) {
    await store.upsertChallengeWork(connectionKey(connection), work.challengeId ?? 7, work)
  }
  for (const submission of submissions) {
    await store.recordSubmission({ connKey: connectionKey(connection), ...submission })
  }

  const adapter = {
    id: connection.platform || 'lingxu',
    lastSubmit: null,
    async challengeDetail(id) {
      return { id: Number(id), name: 'Sign In', description: '签到题：直接提交 flag。', ...detail }
    },
    async eventSummary() {
      return { name: '数信杯' }
    },
    async challenges() {
      return []
    },
    async submitWriteup(payload) {
      adapter.lastSubmit = payload
      return { ok: true, message: 'WP 提交成功' }
    },
    async listWriteups() {
      return [{ id: 1, title: '官方 WP', username: 'alice', sub_time: '2026-09-29T02:00:00Z' }]
    },
    ...adapterOverride,
  }

  const writeup = createWriteup({
    config: { workDir },
    store,
    resolveAdapter: async () => ({ adapter, connection }),
    now: NOW,
  })

  return { root, workDir, store, adapter, writeup }
}

// ------------------------------------------------------------------ slug

test('slugify：中文题名保留可读性，退化题名回退裸 challenge', () => {
  assert.equal(slugify('签到题', 7), '签到题')
  assert.equal(slugify('Web/签到 题', 7), 'web-签到-题')
  // 退化题名统一回退裸 `challenge`（与 index/orchestrate/tools 一致），id 由 writeupFileName 单独拼
  assert.equal(slugify('   ', 9), 'challenge')
  assert.equal(slugify('', 9), 'challenge')
  assert.equal(slugify(null, 9), 'challenge')
  assert.equal(slugify('///', 9), 'challenge')
  assert.equal(slugify('...', 9), 'challenge')
  assert.equal(slugify('\u0000\u0007', 5), 'challenge')
  assert.equal(writeupFileName(slugify('///', 12), 12), 'challenge-12.md')
  assert.equal(slugify('../../etc/passwd', 3), 'etc-passwd')
  // 可读符号（! { } ( ) ☕）保留，只剔路径危险字符
  assert.equal(slugify('flag{test}', 3), 'flag{test}')
  assert.equal(slugify('Baby Heap!', 12), 'baby-heap!')
  // 超长截断到 60 码点以内，且不留下尾部 `-`
  const long = slugify(`${'a'.repeat(120)}中文`, 1)
  assert.ok(Array.from(long).length <= 60, `slug 长度 ${Array.from(long).length}`)
  assert.ok(!long.endsWith('-'))
  assert.ok(long.startsWith('a'))
  // 码点截断不切断代理对（emoji）
  const emoji = slugify(`${'x'.repeat(59)}😀😀`, 1)
  assert.ok(!/[\uD800-\uDBFF]$/.test(emoji), '截断后不应以孤立高代理项结尾')
  assert.equal(Array.from(emoji).length, 60)
})

test('slugify：与 lib/index.js 的规则逐字一致（跨模块契约）', () => {
  // 契约：编排层用 index.js 的 slugify 决定 solver 工作目录，
  // writeup 用同一个规则定位复现脚本 → 两处必须逐字一致。
  const names = ['Baby Heap!', '签到题（Web 入门）', 'a/b:c', '长'.repeat(80)]
  for (const name of names) {
    assert.equal(slugify(name, 12), indexSlugify(name), `slug 不一致：${name}`)
  }
  for (const name of ['Sign In', 'flag{test}', '../../etc/passwd', 'café ☕ CTF', 'Web/签到 题']) {
    assert.equal(slugify(name, 7), indexSlugify(name), `slug 不一致：${name}`)
  }
  // 退化题名：两边都回退裸 `challenge`，且 WP 文件名只出现一次 id
  for (const name of ['???', '***', '///', '...', '   ']) {
    assert.equal(slugify(name, 12), indexSlugify(name), `退化 slug 不一致：${JSON.stringify(name)}`)
    assert.equal(slugify(name, 12), 'challenge')
    assert.equal(writeupFileName(slugify(name, 12), 12), 'challenge-12.md')
  }
})

test('resolveWorkDir：未配置时回退到 cwd/lingxu-ctf-work', () => {
  assert.equal(resolveWorkDir({ workDir: '/tmp/custom' }), '/tmp/custom')
  assert.equal(resolveWorkDir({}), path.join(process.cwd(), 'lingxu-ctf-work'))
  assert.equal(resolveWorkDir(), path.join(process.cwd(), 'lingxu-ctf-work'))
})

// ------------------------------------------------------------------ generate

test('generate：正常生成 WP（题面 / 元信息 / 时间线 / flag / store 登记）', async () => {
  const env = await makeEnv({
    detail: {
      name: 'Sign In',
      category: 'Web',
      score: 100,
      attachment: 'https://example.test:8000/media/sign.zip',
      connectionInfo: 'nc 1.2.3.4 1337',
      requiresEnv: true,
    },
    work: {
      challengeId: 7,
      category: 'Web',
      score: 100,
      envStartedAt: '2026-09-29T01:05:00Z',
      solvedAt: '2026-09-29T01:30:00Z',
      status: 'solved',
    },
    submissions: [
      { challengeId: 7, flag: 'flag{wrong}', status: 'incorrect', at: '2026-09-29T01:20:00Z', message: 'flag错误' },
      { challengeId: 7, flag: 'flag{hello}', status: 'correct', at: '2026-09-29T01:29:00Z' },
    ],
  })

  const result = await env.writeup.generate({ challengeId: 7 })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, false)
  assert.equal(result.slug, 'sign-in')
  assert.equal(result.path, path.join(writeupDir(env.workDir), writeupFileName('sign-in', 7)))
  assert.ok(result.bytes > 0)
  assert.equal(result.flagFound, true)
  assert.equal(result.hasWorkRecord, true)
  assert.deepEqual(result.sections, ['题目描述', '解题思路', '关键步骤', 'Flag', '复现脚本'])

  const content = await fsp.readFile(result.path, 'utf8')
  assert.match(content, /^# Sign In/)
  assert.match(content, /\| 分类 \| Web \|/)
  assert.match(content, /\| 分值 \| 100 \|/)
  assert.match(content, /\| 平台 \| lingxu \|/)
  assert.match(content, /\| 赛事 \| 数信杯 \|/)
  assert.match(content, /## 题目描述\n\n签到题：直接提交 flag。/)
  assert.match(content, /https:\/\/example\.test:8000\/media\/sign\.zip/)
  assert.match(content, /nc 1\.2\.3\.4 1337/)
  assert.match(content, /## 关键步骤/)
  assert.match(content, /开启解题环境/)
  assert.match(content, /提交 flag `flag\{wrong\}` → ❌ 错误/)
  assert.match(content, /提交 flag `flag\{hello\}` → ✅ 正确/)
  assert.match(content, /## Flag\n\n```text\nflag\{hello\}\n```/)
  assert.match(content, /## 复现脚本/)

  // store 里登记了 writeupPath
  const stored = await env.store.getChallengeWork(CONN_KEY, 7)
  assert.equal(stored.writeupPath, result.path)
  assert.equal(stored.writeupSlug, 'sign-in')

  // 第二次调用默认不覆盖，force 才重新生成
  const second = await env.writeup.generate({ challengeId: 7 })
  assert.equal(second.skipped, true)
  assert.equal(second.path, result.path)
  const forced = await env.writeup.generate({ challengeId: 7, force: true })
  assert.equal(forced.skipped, false)
})

test('generate：中文题名 slug 不被清成空字符串', async () => {
  const env = await makeEnv({ detail: { name: '签到题（Web 入门）', score: 50 } })
  const result = await env.writeup.generate({ challengeId: 12 })

  assert.equal(result.ok, true)
  assert.ok(result.slug.length > 0)
  assert.ok(result.slug.includes('签到题'), `slug=${result.slug}`)
  // 全角括号保留（与 index.js 规则一致），只有空白折叠成 `-`
  assert.equal(result.slug, indexSlugify('签到题（Web 入门）'))
  assert.equal(path.basename(result.path), `签到题（web-入门）-12.md`)
  assert.ok((await fsp.readFile(result.path, 'utf8')).startsWith('# 签到题（Web 入门）'))

  // 纯符号题名回退裸 challenge（id 只出现一次）
  const env2 = await makeEnv({ detail: { name: '///' } })
  const result2 = await env2.writeup.generate({ challengeId: 33 })
  assert.equal(result2.slug, 'challenge')
  assert.equal(path.basename(result2.path), 'challenge-33.md')
})

test('generate：无 work / 无提交记录时降级，不崩且给出占位说明', async () => {
  const env = await makeEnv({ detail: { name: 'Empty Case', score: 200 } })
  const result = await env.writeup.generate({ challengeId: 99 })

  assert.equal(result.ok, true)
  assert.equal(result.hasWorkRecord, false)
  assert.equal(result.flagFound, false)
  assert.equal(result.scriptCount, 0)

  const content = await fsp.readFile(result.path, 'utf8')
  assert.match(content, /暂无解题思路记录/)
  assert.match(content, /store 中没有本题的解题过程记录/)
  assert.match(content, /未记录到 flag 提交/)
  assert.match(content, /未在 workDir 下找到本题的复现脚本/)
  assert.match(content, /\| 解题时间 \| 未记录 \|/)
})

test('generate：body 作为解题思路正文，且优先于 store 里的 approach', async () => {
  const env = await makeEnv({
    detail: { name: 'Body Case' },
    work: { challengeId: 21, approach: 'store 里的旧思路' },
  })

  const approachSection = (text) => /## 解题思路\n\n([\s\S]*?)\n\n## 关键步骤/.exec(text)?.[1] ?? ''

  const withBody = await env.writeup.generate({ challengeId: 21, body: '## 手工总结\n\n先逆向后爆破。' })
  const content = await fsp.readFile(withBody.path, 'utf8')
  assert.match(content, /## 解题思路\n\n## 手工总结\n\n先逆向后爆破。/)
  assert.ok(!approachSection(content).includes('store 里的旧思路'))

  const withoutBody = await env.writeup.generate({ challengeId: 21, force: true })
  const content2 = await fsp.readFile(withoutBody.path, 'utf8')
  assert.match(approachSection(content2), /store 里的旧思路/)
})

test('generate：自动内联 workDir/scripts 下匹配题目的复现脚本', async () => {
  const env = await makeEnv({ detail: { name: 'Script Case' } })
  const scriptsDir = path.join(env.workDir, 'scripts')
  await fsp.mkdir(scriptsDir, { recursive: true })
  await fsp.writeFile(path.join(scriptsDir, 'script-case-exp.py'), 'print("pwn")\n', 'utf8')
  await fsp.writeFile(path.join(scriptsDir, 'unrelated.py'), 'print("nope")\n', 'utf8')

  const result = await env.writeup.generate({ challengeId: 55 })
  assert.equal(result.scriptCount, 1)
  const content = await fsp.readFile(result.path, 'utf8')
  assert.match(content, /### `scripts\/script-case-exp\.py`/)
  assert.match(content, /```python\nprint\("pwn"\)\n```/)
  assert.ok(!content.includes('nope'))
})

test('契约：WP 文件名与编排层 solver 目录同源（真跑生成 + 落盘断言）', async () => {
  // 端到端：orchestrate 用 writeScopeFor 告诉 solver「把 exp 放这里」，
  // writeup 必须把 WP 落在同名 slug 上、并能从该目录内联脚本（不再依赖 id 兜底）。
  for (const name of ['Baby Heap!', '签到题（Web 入门）', '???']) {
    const env = await makeEnv({ detail: { name } })
    const result = await env.writeup.generate({ challengeId: 12 })

    const scopeDir = path.basename(writeScopeFor({ id: 12, name, category: 'Web' }))
    assert.equal(path.basename(result.path), `${scopeDir}.md`, `WP 文件名与 solver 目录不同源：${name}`)

    const scriptDir = path.join(env.workDir, 'challenges', scopeDir)
    await fsp.mkdir(scriptDir, { recursive: true })
    await fsp.writeFile(path.join(scriptDir, 'exp.py'), 'print("ok")\n', 'utf8')
    const second = await env.writeup.generate({ challengeId: 12, force: true })
    assert.equal(second.scriptCount, 1, `未从 solver 目录内联脚本：${name}`)
    assert.match(await fsp.readFile(second.path, 'utf8'), /exp\.py/)
  }
})

test('generate：符号题名按共享 slug 精确命中 solver 目录（不依赖 id 兜底）', async () => {
  // Baby Heap! → 共享 slug `baby-heap!`，与 index.js / orchestrate.pathSlug / tools.js 一致
  const env = await makeEnv({ detail: { name: 'Baby Heap!' } })
  const solverDir = path.join(env.workDir, 'challenges', 'baby-heap!-12')
  await fsp.mkdir(solverDir, { recursive: true })
  await fsp.writeFile(path.join(solverDir, 'exp.py'), 'print("heap")\n', 'utf8')

  const result = await env.writeup.generate({ challengeId: 12 })
  assert.equal(result.slug, indexSlugify('Baby Heap!'))
  assert.equal(path.basename(result.path), 'baby-heap!-12.md')
  assert.equal(result.scriptCount, 1)
  assert.match(await fsp.readFile(result.path, 'utf8'), /challenges\/baby-heap!-12\/exp\.py/)
})

test('generate：slug 有分歧时按题目 id 兜底发现 solver 目录（NFKC 全角括号场景）', async () => {
  // orchestrate.js 的 pathSlug 会做 NFKC（`（ ）` → `( )`），index/writeup 不做；
  // 这类残留分歧由「challenges/*-<id>」动态发现兜底（锚定 `-<id>`，不会串到别的题）。
  const env = await makeEnv({ detail: { name: '签到题（Web 入门）' } })
  const solverDir = path.join(env.workDir, 'challenges', '签到题(web-入门)-12')
  await fsp.mkdir(solverDir, { recursive: true })
  await fsp.writeFile(path.join(solverDir, 'exp.py'), 'import requests\n', 'utf8')
  await fsp.writeFile(path.join(solverDir, 'notes.md'), '# 草稿\n', 'utf8')

  const result = await env.writeup.generate({ challengeId: 12 })
  assert.equal(result.slug, indexSlugify('签到题（Web 入门）'))
  assert.equal(result.scriptCount, 2)
  const content = await fsp.readFile(result.path, 'utf8')
  assert.match(content, /challenges\/签到题\(web-入门\)-12\/exp\.py/)
  assert.match(content, /import requests/)
})

// ------------------------------------------------------------------ submit

test('submit：平台不支持 WP 提交时返回明确说明而不是崩溃', async () => {
  const env = await makeEnv({
    connection: { platform: 'ctfd', baseUrl: 'https://ctfd.test', eventId: null },
    adapter: {
      id: 'ctfd',
      async submitWriteup() {
        throw new Error('CTFd 适配器不支持平台侧 WP 提交，请使用本地导出')
      },
      async listWriteups() {
        return []
      },
    },
  })

  const generated = await env.writeup.generate({ challengeId: 8 })
  assert.equal(generated.ok, true)

  const result = await env.writeup.submit({ challengeId: 8 })
  assert.equal(result.ok, false)
  assert.equal(result.unsupported, true)
  assert.equal(result.path, generated.path)
  assert.match(result.message, /不支持/)
  assert.match(result.message, /本地/)
  assert.ok(result.message.includes(generated.path))

  const listed = await env.writeup.list({})
  assert.equal(listed.ok, true)
  assert.equal(listed.count, 0)
})

test('submit：正常提交本地 WP，标题取自 H1，writeupId 透传', async () => {
  const env = await makeEnv({ detail: { name: 'Sign In' } })
  const generated = await env.writeup.generate({ challengeId: 7 })
  const content = await fsp.readFile(generated.path, 'utf8')

  const result = await env.writeup.submit({ challengeId: 7 })
  assert.equal(result.ok, true)
  assert.equal(result.path, generated.path)
  assert.equal(result.title, 'Sign In')
  assert.equal(env.adapter.lastSubmit.code, content)
  assert.equal(env.adapter.lastSubmit.id, undefined)

  const updated = await env.writeup.submit({ challengeId: 7, writeupId: 42 })
  assert.equal(updated.ok, true)
  assert.equal(env.adapter.lastSubmit.id, 42)

  // 平台返回 ok:false 时如实透传
  env.adapter.submitWriteup = async () => ({ ok: false, message: '标题重复' })
  const failed = await env.writeup.submit({ challengeId: 7 })
  assert.equal(failed.ok, false)
  assert.equal(failed.message, '标题重复')
})

test('submit：本地没有 WP 文件时给出可操作的提示', async () => {
  const env = await makeEnv({ detail: { name: 'Missing Case' } })
  const result = await env.writeup.submit({ challengeId: 77 })
  assert.equal(result.ok, false)
  assert.equal(result.path, '')
  assert.match(result.message, /未找到题目 77 的本地 WP 文件/)
  assert.match(result.message, /ctf_writeup id=77 生成/)
  assert.match(result.message, /submit=true/)
})

test('submit：大 WP（>8KB）完整提交，不被复现脚本的截断逻辑截断', async () => {
  const env = await makeEnv({ detail: { name: 'Big WP' } })
  const body = `## 长思路\n\n${'A'.repeat(12000)}\n\nTAIL-MARKER-END`
  const generated = await env.writeup.generate({ challengeId: 61, body })
  const content = await fsp.readFile(generated.path, 'utf8')
  assert.ok(content.length > 8192, `WP 长度 ${content.length}`)

  const result = await env.writeup.submit({ challengeId: 61 })
  assert.equal(result.ok, true)
  assert.equal(env.adapter.lastSubmit.code, content)
  assert.match(env.adapter.lastSubmit.code, /TAIL-MARKER-END/)
  assert.equal(result.bytes, Buffer.byteLength(content, 'utf8'))

  // 已存在文件被跳过时，bytes 也必须是完整文件大小
  const skipped = await env.writeup.generate({ challengeId: 61 })
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.bytes, Buffer.byteLength(content, 'utf8'))
})

test('generate/submit：接受工具层参数名 id（与 challengeId 等价）', async () => {
  const env = await makeEnv({ detail: { name: 'Alias Case' } })

  // id 走单题生成，不会误入批量模式
  const generated = await env.writeup.generate({ id: 71, body: '## 思路\n别名调用' })
  assert.equal(generated.action, 'generate')
  assert.equal(generated.challengeId, 71)
  assert.equal(path.basename(generated.path), 'alias-case-71.md')

  const submitted = await env.writeup.submit({ id: 71 })
  assert.equal(submitted.ok, true)
  assert.equal(submitted.path, generated.path)
  assert.match(env.adapter.lastSubmit.code, /别名调用/)
})

test('submit/list：缺少 id 或 resolveAdapter 时给出清晰结果', async () => {
  const env = await makeEnv({})
  await assert.rejects(() => env.writeup.submit({}), /需要 id/)

  // generate 省略 id = 批量模式；没有已解题目时给出可操作说明
  const batch = await env.writeup.generate({})
  assert.equal(batch.ok, false)
  assert.equal(batch.action, 'generate-batch')
  assert.match(batch.message, /没有找到已解题目/)
  assert.match(batch.message, /显式传 id/)

  const broken = createWriteup({ config: {}, store: env.store })
  await assert.rejects(() => broken.list({}), /resolveAdapter/)
})

// ------------------------------------------------------------------ 批量 / 提交联动

test('generate：省略 id 时按已解题目批量生成（工具层 ctf_writeup 语义）', async () => {
  const env = await makeEnv({
    adapter: {
      async challenges() {
        return [
          { id: 1, name: 'Solved One', solved: true },
          { id: 2, name: 'Solved Two', solved: true },
          { id: 3, name: 'Still Open', solved: false },
        ]
      },
      async challengeDetail(id) {
        return { id: Number(id), name: `Challenge ${id}`, description: `题面 ${id}` }
      },
    },
  })

  const result = await env.writeup.generate({})
  assert.equal(result.ok, true)
  assert.equal(result.action, 'generate-batch')
  assert.equal(result.count, 2)
  assert.deepEqual(result.items.map((i) => i.challengeId), [1, 2])
  assert.match(result.summary, /已解题目 2 道/)

  const files = await fsp.readdir(writeupDir(env.workDir))
  assert.deepEqual(files.sort(), ['challenge-1-1.md', 'challenge-2-2.md'])
})

test('generate：submit=true 时生成后自动提交到平台', async () => {
  const env = await makeEnv({ detail: { name: 'Auto Submit' } })
  const result = await env.writeup.generate({ challengeId: 5, submit: true })

  assert.equal(result.ok, true)
  assert.equal(result.submitted, true)
  assert.equal(result.submitResult.ok, true)
  assert.equal(env.adapter.lastSubmit.title, 'Auto Submit')
  assert.equal(env.adapter.lastSubmit.code, await fsp.readFile(result.path, 'utf8'))
  assert.match(result.summary, /WP 提交成功/)

  // 平台不支持提交时，生成仍然成功，但 submitted=false 并带明确说明
  const env2 = await makeEnv({
    connection: { platform: 'ctfd', baseUrl: 'https://ctfd.test', eventId: null },
    adapter: {
      id: 'ctfd',
      async submitWriteup() {
        throw new Error('CTFd 适配器不支持平台侧 WP 提交，请使用本地导出')
      },
    },
  })
  const result2 = await env2.writeup.generate({ challengeId: 6, submit: true })
  assert.equal(result2.ok, true)
  assert.equal(result2.submitted, false)
  assert.equal(result2.submitResult.unsupported, true)
  assert.match(result2.summary, /不支持/)
})

test('generate：title 覆盖标题与文件名 slug', async () => {
  const env = await makeEnv({ detail: { name: 'Platform Name' } })
  const result = await env.writeup.generate({ challengeId: 9, title: '自定义题解' })
  assert.equal(result.title, '自定义题解')
  assert.equal(path.basename(result.path), '自定义题解-9.md')
  assert.match(await fsp.readFile(result.path, 'utf8'), /^# 自定义题解/)
})

// ------------------------------------------------------------------ list

test('list：返回平台侧 WP 列表摘要', async () => {
  const env = await makeEnv({})
  const result = await env.writeup.list({})
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.items[0].title, '官方 WP')
  assert.equal(result.items[0].author, 'alice')
  assert.match(result.summary, /官方 WP/)
})
