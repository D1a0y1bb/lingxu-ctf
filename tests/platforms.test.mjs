import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createAdapter, listPlatforms, isSupportedPlatform, LingxuAdapter, CtfdAdapter } from '../lib/platforms.js'
import {
  LingxuClient,
  LingxuError,
  parseCookie,
  maskSecret,
  htmlToMarkdown,
  normalizeConnectionTarget,
  formatConnectionInfo,
  extractMessage,
} from '../lib/lingxu.js'

/** 安装一个临时的 fetch 假实现，返回 [restore, calls]。 */
function withFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return [() => { globalThis.fetch = original }, calls]
}

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status < 400,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body) },
    async json() { return body },
    async arrayBuffer() { return new ArrayBuffer(0) },
  }
}

// ────────────────────────────────────────────── 纯函数

test('parseCookie / maskSecret', () => {
  const map = parseCookie('sessionid=abc; csrftoken=xyz; other=1')
  assert.equal(map.sessionid, 'abc')
  assert.equal(map.csrftoken, 'xyz')
  assert.equal(maskSecret('short'), '*****')
  assert.match(maskSecret('sessionid-abcdefghij'), /^sessionid…|^sessio…/)
  assert.equal(maskSecret('').length, 0)
})

test('htmlToMarkdown: 标题/列表/链接/实体', () => {
  const md = htmlToMarkdown('<h2>题面</h2><p>看这个 <b>重点</b></p><ul><li>一</li><li>二</li></ul><a href="/x.zip">附件</a>&amp;more')
  assert.match(md, /## 题面/)
  assert.match(md, /\*\*重点\*\*/)
  assert.match(md, /- 一/)
  assert.match(md, /\[附件\]\(\/x\.zip\)/)
  assert.match(md, /&more/)
})

test('htmlToMarkdown: 纯文本原样返回', () => {
  assert.equal(htmlToMarkdown('no tags here'), 'no tags here')
  assert.equal(htmlToMarkdown(''), '')
})

test('normalizeConnectionTarget', () => {
  assert.equal(normalizeConnectionTarget('1.2.3.4:9999'), 'nc 1.2.3.4 9999')
  assert.equal(normalizeConnectionTarget('nc 1.2.3.4 9999'), 'nc 1.2.3.4 9999')
  assert.equal(normalizeConnectionTarget('http://a.com/x'), 'http://a.com/x')
  assert.equal(normalizeConnectionTarget('  '), '')
})

test('formatConnectionInfo: 优先公网地址', () => {
  const r = formatConnectionInfo({ domain_addr: '1.2.3.4:1000', ext_id: '192.168.1.5:2000' })
  assert.deepEqual(r.targets, ['nc 1.2.3.4 1000'])
  assert.equal(r.hasPrivateOnly, false)
})

test('formatConnectionInfo: 只有内网时回退并标记', () => {
  const r = formatConnectionInfo({ ext_id: '192.168.1.5:2000' })
  assert.deepEqual(r.targets, ['nc 192.168.1.5 2000'])
  assert.equal(r.hasPrivateOnly, true)
})

test('formatConnectionInfo: ext_id 数组', () => {
  const r = formatConnectionInfo({ ext_id: [{ map_ip: '5.6.7.8:80' }, { ip: '10.0.0.1:80' }] })
  assert.deepEqual(r.targets, ['nc 5.6.7.8 80'])
})

test('extractMessage 多路兜底', () => {
  assert.equal(extractMessage({ error: ' boom ' }), 'boom')
  assert.equal(extractMessage({ msg: 'x' }), 'x')
  assert.equal(extractMessage({ detail: ['a', 'b'] }), 'a b')
  assert.equal(extractMessage('plain'), 'plain')
  assert.equal(extractMessage({}), '')
})

test('平台注册表', () => {
  assert.deepEqual(listPlatforms().sort(), ['ctfd', 'lingxu'])
  assert.equal(isSupportedPlatform('lingxu'), true)
  assert.equal(isSupportedPlatform('nope'), false)
  assert.throws(() => createAdapter({ platform: 'nope', baseUrl: 'x' }), /不支持的平台/)
})

// ────────────────────────────────────────────── 凌虚客户端

test('LingxuClient: 缺 sessionid 时 validateAccess 报错', async () => {
  const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 1, cookie: 'other=1' })
  await assert.rejects(() => c.validateAccess(), /缺少 sessionid/)
})

test('LingxuClient: 构造校验必填', () => {
  assert.throws(() => new LingxuClient({ eventId: 1 }), /baseUrl/)
  assert.throws(() => new LingxuClient({ baseUrl: 'https://x.com' }), /eventId/)
})

test('LingxuClient: challenges 翻页合并并归一化字段', async () => {
  const [restore, calls] = withFetch((url) => {
    if (url.includes('page=1')) {
      return jsonResponse({ count: 3, next: '/event/4/ctf/?page=2', results: [
        { id: 1, name: 'A', classify: 'Web', score: 100, is_parse: false, parse_count: 0, is_begin: true },
        { id: 2, name: 'B', classify: 'Pwn', score: 200, is_parse: true },
      ] })
    }
    return jsonResponse({ count: 3, next: null, results: [
      { id: 3, name: 'C', classify: 'Misc', score: 50, is_parse: false },
    ] })
  })
  try {
    const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    const rows = await c.challenges()
    assert.equal(rows.length, 3)
    assert.deepEqual(rows[0], { id: 1, name: 'A', category: 'Web', score: 100, ctfId: undefined, solved: false, parseCount: 0, begun: true, messages: [] })
    assert.equal(rows[1].solved, true)
    assert.equal(calls.length, 2)
  } finally { restore() }
})

test('LingxuClient: 写操作带 CSRF 头', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1 }))
  try {
    const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a; csrftoken=tok' })
    await c.submitFlag(7, 'flag{test}')
    assert.equal(calls[0].init.headers['X-CSRFToken'], 'tok')
    assert.equal(calls[0].init.headers['X-Requested-With'], 'XMLHttpRequest')
    assert.equal(calls[0].init.method, 'POST')
    assert.match(String(calls[0].init.body), /flag=flag%7Btest%7D/)
  } finally { restore() }
})

test('LingxuClient: submitFlag 状态归一化', async () => {
  const cases = [
    [{ status: 1 }, 'correct'],
    [{ status: 2 }, 'incorrect'],
    [{ msg: '您已提交了正确的Flag' }, 'already_solved'],
    [{ error: 'flag错误' }, 'incorrect'],
    [{ msg: '莫名其妙' }, 'unknown'],
  ]
  for (const [payload, expected] of cases) {
    const [restore] = withFetch(() => jsonResponse(payload))
    try {
      const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
      const r = await c.submitFlag(1, 'f')
      assert.equal(r.status, expected, JSON.stringify(payload))
    } finally { restore() }
  }
})

test('LingxuClient: startEnvironment 三步并归一化地址', async () => {
  const [restore, calls] = withFetch((url) => {
    if (url.endsWith('/begin/')) return jsonResponse({ status: 1 })
    if (url.endsWith('/run/')) return jsonResponse({ status: 1 })
    return jsonResponse({ domain_addr: '1.2.3.4:31337' })
  })
  try {
    const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    const r = await c.startEnvironment(9)
    assert.equal(r.connectionInfo, 'nc 1.2.3.4 31337')
    assert.equal(r.hasPrivateOnly, false)
    assert.deepEqual(calls.map((x) => x.url.replace('https://x.com', '')), [
      '/event/4/ctf/9/begin/', '/event/4/ctf/9/run/', '/event/4/ctf/9/addr/',
    ])
  } finally { restore() }
})

test('LingxuClient: startEnvironment 在 addr 为空时报可读错误', async () => {
  const [restore] = withFetch((url) => {
    if (url.endsWith('/addr/')) return jsonResponse({ domain_addr: '' })
    return jsonResponse({ status: 1 })
  })
  try {
    const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    await assert.rejects(() => c.startEnvironment(9), /未返回环境地址/)
  } finally { restore() }
})

test('LingxuClient: releaseEnvironment 幂等成功', async () => {
  for (const payload of [{ status: 2 }, { status: 3, msg: '没有运行的环境' }, { status: 3, msg: '该环境正在释放' }]) {
    const [restore] = withFetch(() => jsonResponse(payload))
    try {
      const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
      const r = await c.releaseEnvironment(3)
      assert.equal(r.released, true)
    } finally { restore() }
  }
})

test('LingxuClient: HTTP 错误转 LingxuError 且带状态码', async () => {
  const [restore] = withFetch(() => jsonResponse('<h1>Not Found</h1>', 404))
  try {
    const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    await assert.rejects(
      () => c.request('/event/4/nope/'),
      (e) => e instanceof LingxuError && e.httpStatus === 404 && /404/.test(e.message),
    )
  } finally { restore() }
})

test('LingxuClient: leaderboard 归一化并标记 isSelf', async () => {
  const [restore] = withFetch(() => jsonResponse({
    count: 2,
    results: [
      { id: 2, username: 'admin', score: 0, test_score: 0, ctf_score: 0, parse_count: 0, is_self: false },
      { id: 4, username: 'xiyi', score: 100, ctf_score: 100, parse_count: 1, first_count: 1, is_self: true },
    ],
  }))
  try {
    const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    const board = await c.leaderboard('user', { size: 2 })
    assert.equal(board.total, 2)
    assert.equal(board.rows[1].isSelf, true)
    assert.equal(board.rows[1].score, 100)
    const mine = await c.myRank()
    assert.equal(mine.rank, 2)
    assert.equal(mine.self.username, 'xiyi')
  } finally { restore() }
})

test('LingxuClient: 理论题全流程', async () => {
  const [restore, calls] = withFetch((url) => {
    if (url.includes('/test/') && url.endsWith('/test/')) {
      return jsonResponse([{ id: 3, name: '理论题', type: ['单选', '多选', '判断'], score: 1000, count: 100, time_seconds: 3600, is_begin: false }])
    }
    if (url.endsWith('/begin/')) return jsonResponse({ status: 1 })
    if (url.includes('/list/')) {
      return jsonResponse({ count: 1, next: null, results: [{ id: 11, title: '<p>1+1=?</p>', option: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }] }] })
    }
    if (url.includes('/answer/')) return jsonResponse({ status: 1 })
    if (url.endsWith('/finish/')) return jsonResponse({ status: 1 })
    return jsonResponse({})
  })
  try {
    const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    const tests = await c.theoryTests()
    assert.equal(tests[0].id, 3)
    assert.equal(tests[0].count, 100)
    assert.deepEqual(tests[0].types, ['单选', '多选', '判断'])

    assert.equal((await c.beginTheoryTest(3)).started, true)

    const qs = await c.theoryQuestions(3)
    assert.equal(qs.length, 1)
    assert.equal(qs[0].id, 11)
    assert.equal(qs[0].title, '1+1=?')
    assert.deepEqual(qs[0].options, [{ key: 'A', text: '1' }, { key: 'B', text: '2' }])

    assert.equal((await c.answerTheory(3, 11, 'B')).ok, true)
    assert.equal((await c.finishTheory(3)).ok, true)
    assert.equal(calls.some((x) => x.url.includes('/test/3/answer/11/')), true)
  } finally { restore() }
})

test('LingxuClient: theoryQuestions 兼容字符串选项', async () => {
  const [restore] = withFetch(() => jsonResponse({ results: [{ id: 1, title: 'q', option: 'A. 甲\nB. 乙' }] }))
  try {
    const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    const qs = await c.theoryQuestions(3)
    assert.deepEqual(qs[0].options.map((o) => o.text), ['A. 甲', 'B. 乙'])
  } finally { restore() }
})

// ────────────────────────────────────────────── 适配器

test('LingxuAdapter: validate 返回 punish 警告', async () => {
  const [restore] = withFetch(() => jsonResponse({
    user: { username: 'xiyi', number: 'lx_1' },
    test_type: { 1: { name: '理论题' } },
    punish: true,
  }))
  try {
    const a = createAdapter({ platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    assert.equal(a instanceof LingxuAdapter, true)
    const r = await a.validate()
    assert.equal(r.ok, true)
    assert.equal(r.user.username, 'xiyi')
    assert.equal(r.warnings.some((w) => w.includes('扣分')), true)
  } finally { restore() }
})

test('LingxuAdapter: challengeDetail 标记环境题并规范化', async () => {
  const [restore] = withFetch(() => jsonResponse({
    name: 'NeuroSign', desc: '<p>题面</p>', attachment: '/media/a.zip',
    score: 1000, parse_count: 3, task_type: 1, answer_mode: 1, link_path: '',
  }))
  try {
    const a = createAdapter({ platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    const d = await a.challengeDetail(1)
    assert.equal(d.name, 'NeuroSign')
    assert.equal(d.requiresEnv, true)
    assert.equal(d.description, '题面')
    assert.equal(d.attachment, 'https://x.com/media/a.zip')
    assert.equal(d.checkMode, false)
  } finally { restore() }
})

test('CtfdAdapter: 挑战列表与提交', async () => {
  const [restore, calls] = withFetch((url) => {
    if (url.endsWith('/api/v1/challenges')) {
      return jsonResponse({ data: [{ id: 1, name: 'warmup', category: 'Misc', value: 100, solves: 5 }] })
    }
    if (url.endsWith('/api/v1/users/me')) return jsonResponse({ data: { id: 9, name: 'me', solves: [{ challenge_id: 1 }] } })
    if (url.endsWith('/api/v1/challenges/attempt')) {
      return jsonResponse({ data: { status: 'correct', message: 'Nice' } })
    }
    if (url.endsWith('/api/v1/config')) return jsonResponse({ data: { ctf_name: 'Demo CTF' } })
    return jsonResponse({ data: [] })
  })
  try {
    const a = createAdapter({ platform: 'ctfd', baseUrl: 'https://c.example.com', token: 'tok' })
    assert.equal(a instanceof CtfdAdapter, true)
    const v = await a.validate()
    assert.equal(v.user.username, 'me')
    const rows = await a.challenges()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].solved, true)
    const r = await a.submitFlag(1, 'flag{x}')
    assert.equal(r.status, 'correct')
    assert.equal(calls.find((c) => c.url.endsWith('/attempt')).init.headers.Authorization, 'Token tok')
  } finally { restore() }
})

test('CtfdAdapter: 不支持的能力给出明确错误', async () => {
  const a = createAdapter({ platform: 'ctfd', baseUrl: 'https://c.example.com', token: 'tok' })
  await assert.rejects(() => a.startEnvironment(1), /不支持自动开启环境/)
  await assert.rejects(() => a.beginTheoryTest(1), /不支持理论题/)
  assert.deepEqual(await a.theoryTests(), [])
})

test('CtfdAdapter: 缺凭据时报错', async () => {
  const a = createAdapter({ platform: 'ctfd', baseUrl: 'https://c.example.com' })
  await assert.rejects(() => a.validate(), /需要 token 或 cookie/)
})
