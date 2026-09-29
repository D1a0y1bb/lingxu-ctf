import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITY_STATES,
  LINGXU_PLATFORM_CONTRACT,
  PLATFORM_CONTRACT_VERSION,
  createAdapter,
  listPlatforms,
  isSupportedPlatform,
  LingxuAdapter,
  normalizePlatformError,
  stageCapabilitiesFromSummary,
  stageCapabilitiesFromTestType,
} from '../lib/platforms.js'
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

//  纯函数

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

test('平台注册表：只支持凌虚', () => {
  assert.deepEqual(listPlatforms(), ['lingxu'])
  assert.equal(isSupportedPlatform('lingxu'), true)
  assert.equal(isSupportedPlatform('LINGXU'), true)
  assert.equal(isSupportedPlatform('nope'), false)
  assert.equal(isSupportedPlatform(''), false)
  assert.equal(isSupportedPlatform(undefined), false)
  // 省略 platform 时按 lingxu 处理
  assert.ok(createAdapter({ baseUrl: 'https://x.com', eventId: 1, cookie: 'sessionid=a' }) instanceof LingxuAdapter)
})

test('平台能力合同：test_type 缺失、为空和含赛段分别归一为 unknown/absent/present', () => {
  assert.equal(PLATFORM_CONTRACT_VERSION, 1)
  assert.deepEqual(LINGXU_PLATFORM_CONTRACT.stageIds, { theory: 1, ctf: 2, awd: 3, cfs: 4 })
  assert.equal(stageCapabilitiesFromTestType(null).stages.awd, CAPABILITY_STATES.UNKNOWN)
  assert.equal(stageCapabilitiesFromTestType([]).stages.awd, CAPABILITY_STATES.UNKNOWN)
  assert.equal(stageCapabilitiesFromTestType({}).stages.awd, CAPABILITY_STATES.ABSENT)
  const present = stageCapabilitiesFromTestType({ 2: { name: 'CTF' }, 3: { name: 'AWD' } })
  assert.equal(present.stages.ctf, CAPABILITY_STATES.PRESENT)
  assert.equal(present.stages.awd, CAPABILITY_STATES.PRESENT)
  assert.equal(present.stages.cfs, CAPABILITY_STATES.ABSENT)
  assert.equal(stageCapabilitiesFromSummary({ hasAwd: true }).stages.awd, CAPABILITY_STATES.PRESENT)
  assert.equal(stageCapabilitiesFromSummary({}).stages.awd, CAPABILITY_STATES.UNKNOWN)
})

test('平台能力合同：异常三态值按 unknown 处理，不能把脏数据当成可用赛段', () => {
  const summary = stageCapabilitiesFromSummary({
    capabilities: { version: 1, stages: { awd: 'yes', cfs: 'present' } },
  })
  assert.equal(summary.stages.awd, CAPABILITY_STATES.UNKNOWN)
  assert.equal(summary.stages.cfs, CAPABILITY_STATES.PRESENT)
})

test('normalizePlatformError：输出稳定且不携带原始响应体', () => {
  const error = normalizePlatformError({
    name: 'LingxuError', code: 'session-expired', httpStatus: 403, path: '/event/4/info/',
    platformMessage: '未登录', payload: { token: 'secret', detail: '未登录' },
  })
  assert.deepEqual(error, {
    ok: false,
    code: 'session-expired',
    message: '未登录',
    httpStatus: 403,
    platformStatus: null,
    path: '/event/4/info/',
    retryable: false,
  })
  assert.equal('payload' in error, false)
  assert.equal(normalizePlatformError({ httpStatus: 503 }).retryable, true)
  assert.equal(normalizePlatformError({ httpStatus: 403 }).code, 'forbidden')
})

test('createAdapter：未知平台抛 LingxuError（不静默降级）', () => {
  for (const platform of ['nope', 'ctfd', 'CTFd', 'ctfhub']) {
    assert.throws(
      () => createAdapter({ platform, baseUrl: 'https://x.com', eventId: 1, cookie: 'sessionid=a' }),
      (error) => {
        assert.equal(error.name, 'LingxuError')
        assert.match(error.message, /不支持的平台/)
        assert.match(error.message, /只支持 lingxu/)
        return true
      },
      `platform=${platform} 应抛 LingxuError`,
    )
  }
  assert.equal(typeof LingxuAdapter, 'function')
})

test('LingxuAdapter：暴露版本化能力合同与错误投影', () => {
  const adapter = createAdapter({ platform: 'lingxu', baseUrl: 'https://x.com', eventId: 1, cookie: 'sessionid=a' })
  assert.equal(adapter.contractVersion, PLATFORM_CONTRACT_VERSION)
  assert.deepEqual(adapter.capabilities().stageIds, { theory: 1, ctf: 2, awd: 3, cfs: 4 })
  assert.equal(adapter.normalizeError({ httpStatus: 429 }).retryable, true)
})

//  凌虚客户端

test('LingxuClient: 缺 sessionid 时 validateAccess 报错', async () => {
  const c = new LingxuClient({ baseUrl: 'https://x.com', eventId: 1, cookie: 'other=1' })
  await assert.rejects(() => c.validateAccess(), /缺少 sessionid/)
})

test('LingxuClient: 构造校验必填', () => {
  assert.throws(() => new LingxuClient({ eventId: 1 }), /baseUrl/)
  assert.throws(() => new LingxuClient({ baseUrl: 'https://x.com' }), /eventId/)
  for (const eventId of [0, -1, 1.5, 'abc', Infinity]) {
    assert.throws(
      () => new LingxuClient({ baseUrl: 'https://x.com', eventId, cookie: 'sessionid=a' }),
      /eventId 必须是正整数|eventId/,
    )
  }
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
    assert.deepEqual(rows[0], { id: 1, name: 'A', category: 'Web', score: 100, ctfId: undefined, solved: false, parseCount: 0, begun: true, messages: [], testList: {} })
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

//  适配器

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

test('createAdapter：显式 platform 为 lingxu 时正常构造', () => {
  const a = createAdapter({ platform: 'lingxu', baseUrl: 'https://x.com', eventId: 1, cookie: 'sessionid=a' })
  assert.equal(a instanceof LingxuAdapter, true)
  assert.equal(a.id, 'lingxu')
  assert.equal(typeof a.submitFlag, 'function')
  assert.equal(typeof a.downloadAttachment, 'function')
})

//  适配器接口同步

test('LingxuAdapter: 新增平台方法全部转发（接口完整性）', () => {
  const a = createAdapter({ platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
  for (const method of [
    'getEnvironmentAddress', 'delayEnvironment', 'checkFlag',
    'eventChart', 'eventPunish', 'ctfTime', 'ctfNames', 'noticeCount',
  ]) {
    assert.equal(typeof a[method], 'function', `适配器缺少 ${method}`)
  }
})

test('LingxuAdapter: 环境地址 / 延时 / check / 新端点 的调用形状', async () => {
  const seen = []
  const [restore] = withFetch((url, init) => {
    seen.push({ url, method: init.method })
    if (url.endsWith('/addr/')) return jsonResponse({ ext_id: '1.2.3.4:80', end_second: 60, run_time: 'a', release_time: 'b' })
    if (url.endsWith('/delayed/')) return jsonResponse({ status: 2, msg: '成功延时30分钟' })
    if (url.endsWith('/check/')) return jsonResponse({ status: 1, detail: 'check已触发' })
    if (url.includes('/chart/')) return jsonResponse({ start_time: 1, end_time: 2, data: [] })
    if (url.includes('/punish/')) return jsonResponse({ count: 0, next: null, results: [] })
    if (url.endsWith('/ctf/time/')) return jsonResponse({ status: 0, start_seconds: 0, end_seconds: 100 })
    if (url.endsWith('/ctf/name/')) return jsonResponse([{ id: 1, name: 'x' }])
    if (url.endsWith('/notice/count/')) return jsonResponse({ count: 2 })
    return jsonResponse({})
  })
  try {
    const a = createAdapter({ platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    const addr = await a.getEnvironmentAddress(9)
    assert.equal(addr.remainingSeconds, 60)
    assert.equal(addr.connectionInfo, 'nc 1.2.3.4 80')

    const delayed = await a.delayEnvironment(9)
    assert.equal(delayed.kind, 'delayed')

    const checked = await a.checkFlag(11, 'flag{x}')
    assert.equal(checked.ok, true)

    assert.equal((await a.eventChart()).type, 2)
    assert.deepEqual(await a.eventPunish({ type: 1 }), [])
    assert.equal((await a.ctfTime()).endSeconds, 100)
    assert.deepEqual(await a.ctfNames(), [{ id: 1, name: 'x' }])
    assert.equal((await a.noticeCount()).count, 2)

    const paths = seen.map((entry) => entry.url.replace('https://x.com', ''))
    assert.deepEqual(paths, [
      '/event/4/ctf/9/addr/',
      '/event/4/ctf/9/delayed/',
      '/event/4/ctf/11/check/',
      '/event/4/chart/?type=2',
      '/event/4/punish/?type=1&page=1&size=100',
      '/event/4/ctf/time/',
      '/event/4/ctf/name/',
      '/event/4/notice/count/',
    ])
    assert.equal(seen[1].method, 'POST', 'delayed 必须是 POST')
    assert.equal(seen[2].method, 'POST', 'check 必须是 POST')
  } finally { restore() }
})

//  AWD / CFS + test_type

test('LingxuAdapter: AWD/CFS 方法全部转发（接口完整性）', () => {
  const a = createAdapter({ platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
  for (const method of [
    'awdRoundInfo', 'awdChallenges', 'awdChallengeDetail', 'awdRank', 'awdDynamic', 'awdDynamicInfo',
    'awdDynamicTests', 'awdDynamicUsers', 'awdFlagApi', 'awdGetOwnFlag', 'awdSubmitFlag', 'awdResetKvm',
    'awdReferee', 'cfsRoundInfo', 'cfsChallenges', 'cfsChallengeDetail', 'cfsSubmitFlag', 'cfsRank',
    'cfsChart', 'cfsDynamic', 'eventType',
  ]) {
    assert.equal(typeof a[method], 'function', `适配器缺少 ${method}`)
  }
})

test('LingxuAdapter: eventSummary 解析 test_type（1理论/2CTF/3AWD/4CFS）', async () => {
  const [restore] = withFetch((url) => {
    if (url.endsWith('/info/')) {
      return jsonResponse({
        status: 0,
        start_seconds: 0,
        end_seconds: 3600,
        user: { username: 'xiyi', number: 'lx_1' },
        test_type: { 1: { name: '理论题', size: 30 }, 2: { name: '实操题', size: 30 }, 3: { name: 'AWD', size: 10 } },
        punish: true,
      })
    }
    return jsonResponse({ name: '测试赛', start_time: 'a', end_time: 'b' })
  })
  try {
    const a = createAdapter({ platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    const summary = await a.eventSummary()
    assert.deepEqual(summary.testTypes.map((t) => [t.id, t.name, t.size]), [
      [1, '理论题', 30],
      [2, '实操题', 30],
      [3, 'AWD', 10],
    ])
    assert.equal(summary.hasTheory, true)
    assert.equal(summary.hasCtf, true)
    assert.equal(summary.hasAwd, true)
    assert.equal(summary.hasCfs, false, '这场没有 CFS 赛段')
    assert.deepEqual(Object.keys(summary.testTypeMap).sort(), ['1', '2', '3'])
    assert.equal(summary.capabilities.version, PLATFORM_CONTRACT_VERSION)
    assert.equal(summary.capabilities.stages.awd, CAPABILITY_STATES.PRESENT)
    assert.equal(summary.capabilities.stages.cfs, CAPABILITY_STATES.ABSENT)
    assert.equal(summary.remainingSeconds, 3600)
  } finally { restore() }
})

test('LingxuAdapter: test_type 形状异常时能力保持 unknown，不猜测赛段', async () => {
  for (const malformed of [null, [], '3', 3]) {
    const [restore] = withFetch((url) => {
      if (url.endsWith('/info/')) return jsonResponse({ test_type: malformed, user: {} })
      return jsonResponse({ name: '异常赛事' })
    })
    try {
      const a = createAdapter({ platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
      const summary = await a.eventSummary()
      assert.equal(summary.hasAwd, null)
      assert.equal(summary.hasCfs, null)
      assert.equal(summary.capabilities.stages.awd, CAPABILITY_STATES.UNKNOWN)
      assert.equal(summary.capabilities.stages.cfs, CAPABILITY_STATES.UNKNOWN)
    } finally { restore() }
  }
})

test('LingxuAdapter: AWD/CFS 调用形状（路径与 query 参数）', async () => {
  const seen = []
  const [restore] = withFetch((url, init) => {
    seen.push(`${init.method} ${url.replace('https://x.com', '')}`)
    if (url.includes('/awd/info/')) return jsonResponse({ status: 0, info_dict: { token: 't' } })
    if (url.includes('/awd/flag/')) return jsonResponse({ status: 1, data: 'Flag提交成功！' })
    if (url.includes('/awd/rank/')) return jsonResponse({ count: 0, next: null, results: [] })
    if (url.includes('/awd/dynamic/info/')) return jsonResponse({ count: 0, next: null, results: [] })
    if (url.includes('/awd/dynamic/')) return jsonResponse([])
    if (url.includes('/awd/')) return jsonResponse({ count: 0, next: null, results: [] })
    if (url.includes('/kvm/')) return jsonResponse({ status: 1, message: '重置成功' })
    if (url.includes('/cfs/info/')) return jsonResponse({ status: 1, start_seconds: 60, end_seconds: 0 })
    if (url.includes('/cfs/rank/')) return jsonResponse({ count: 0, next: null, results: [] })
    if (url.includes('/cfs/chart/')) return jsonResponse({ start_time: 1, end_time: 2, data: [] })
    if (url.includes('/cfs/dynamic/')) return jsonResponse([])
    if (url.includes('/cfs/')) return jsonResponse({ count: 0, next: null, results: [] })
    if (url.includes('/type/')) return jsonResponse(['1', '2'])
    return jsonResponse({})
  })
  try {
    const a = createAdapter({ platform: 'lingxu', baseUrl: 'https://x.com', eventId: 4, cookie: 'sessionid=a' })
    await a.awdRoundInfo()
    await a.awdChallenges({ classify: 'Web' })
    await a.awdRank()
    await a.awdDynamic()
    await a.awdDynamicInfo({ status: [1, 2] })
    await a.awdSubmitFlag('tok', 'flag{x}')
    await a.awdResetKvm(77, { type: 2 })
    await a.cfsRoundInfo()
    await a.cfsRank()
    await a.cfsChart()
    await a.cfsDynamic()
    await a.cfsSubmitFlag(5, 'flag{y}')
    const type = await a.eventType()
    assert.deepEqual(type.codes, ['1', '2'])

    assert.deepEqual(seen, [
      'GET /event/4/awd/info/',
      'GET /event/4/awd/?classify=Web&page=1&size=100',
      'GET /event/4/awd/rank/?page=1&size=100',
      'GET /event/4/awd/dynamic/',
      'GET /event/4/awd/dynamic/info/?status=1&status=2&page=1&size=100',
      'POST /event/4/awd/flag/?token=tok&flag=flag%7Bx%7D',
      'POST /event/4/kvm/77/reset/?type=2',
      'GET /event/4/cfs/info/',
      'GET /event/4/cfs/rank/?page=1&size=100',
      'GET /event/4/cfs/chart/',
      'GET /event/4/cfs/dynamic/',
      'POST /event/4/cfs/5/flag/',
      'GET /event/4/type/',
    ])
  } finally { restore() }
})
