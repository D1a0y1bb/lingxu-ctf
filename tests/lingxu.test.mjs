/**
 * lib/lingxu.js 单元测试（node:test，零依赖，mock fetch，不触网）。
 *
 * 覆盖 task-11 的 5 个真实缺陷（全部来自真实平台实测 + 平台前端 main.chunk.js 逆向）：
 *   1. answerTheory 发 JSON + option 数组（原来 form-encoded 字符串 ⇒ HTTP 500）
 *   2. theoryTests 读 is_parse（交卷后 is_begin=false，只看 is_begin 会误判「未开始」）
 *   3. theoryQuestions 读 content 选项字典 + user_option 数组
 *   4. finishTheory 统一 JSON body
 *   5. releaseEnvironment / startEnvironment 对「平台未配置环境」分类，不算失败
 *   6. sessionid 失效（HTTP 403 + {"detail":"未登录"}）→ code: 'session-expired'
 *
 * 运行：
 *   "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
 *     --test tests/lingxu.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LingxuClient,
  LingxuError,
  LINGXU_CODES,
  isSessionExpired,
  isSessionExpiredPayload,
  isEnvNotConfigured,
  isEnvNotConfiguredPayload,
  normalizeOptionArray,
  normalizeTheoryOption,
  theoryOptionTypeLabel,
  theoryTestStatus,
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

function client(cookie = 'sessionid=a') {
  return new LingxuClient({ baseUrl: 'https://x.com', eventId: 4, cookie })
}

const lastCall = (calls) => calls[calls.length - 1]
const bodyOf = (call) => JSON.parse(String(call.init.body))
const contentTypeOf = (call) => call.init.headers['Content-Type']

// ────────────────────────────────────────────── 纯函数：选项归一化

test('normalizeOptionArray：数组 / 字符串 / 分隔符 / 空值', () => {
  assert.deepEqual(normalizeOptionArray(['B', 'C']), ['B', 'C'])
  assert.deepEqual(normalizeOptionArray(['B', '', '  C  ']), ['B', 'C'])
  assert.deepEqual(normalizeOptionArray('B'), ['B'])
  assert.deepEqual(normalizeOptionArray('B,C'), ['B', 'C'])
  assert.deepEqual(normalizeOptionArray('B、C；D'), ['B', 'C', 'D'])
  assert.deepEqual(normalizeOptionArray('  '), [])
  assert.deepEqual(normalizeOptionArray(null), [])
  assert.deepEqual(normalizeOptionArray(undefined), [])
})

test('normalizeTheoryOption：多选按键位排序，填空题保持空位顺序', () => {
  // 前端：4 === option_type ? option = answer : option = answer.sort()
  assert.deepEqual(normalizeTheoryOption('BCD'), ['B', 'C', 'D'])
  assert.deepEqual(normalizeTheoryOption('DCB'), ['B', 'C', 'D'], '字符串拆分后排序')
  assert.deepEqual(normalizeTheoryOption(['D', 'B', 'C']), ['B', 'C', 'D'], '数组也要排序')
  assert.deepEqual(normalizeTheoryOption(['B']), ['B'], '单选无需排序')
  assert.deepEqual(normalizeTheoryOption('B'), ['B'])
  // 填空题：按空位顺序，绝不能排序
  assert.deepEqual(normalizeTheoryOption(['答案二', '答案一'], { optionType: 4 }), ['答案二', '答案一'])
  assert.deepEqual(normalizeTheoryOption(['z', 'a'], { optionType: 4 }), ['z', 'a'])
  // 已知非填空题型：一律排序（与前端一致）
  assert.deepEqual(normalizeTheoryOption(['答案二', '答案一'], { optionType: 2 }), ['答案二', '答案一'].sort())
  // 不知道题型时：只有「全是单个字母」才排序，避免打乱填空空位
  assert.deepEqual(normalizeTheoryOption(['答案二', '答案一']), ['答案二', '答案一'])
})

test('theoryOptionTypeLabel / theoryTestStatus', () => {
  assert.equal(theoryOptionTypeLabel(1), '单选')
  assert.equal(theoryOptionTypeLabel(2), '多选')
  assert.equal(theoryOptionTypeLabel(3), '判断')
  assert.equal(theoryOptionTypeLabel(4), '填空')
  assert.equal(theoryOptionTypeLabel(9), '')
  assert.equal(theoryOptionTypeLabel(undefined), '')

  // is_parse 优先：交卷后平台把 is_begin 置回 false
  assert.deepEqual(theoryTestStatus({ isParse: true, isBegin: false, isEnd: false }), {
    key: 'submitted',
    label: '已交卷',
  })
  assert.equal(theoryTestStatus({ isBegin: true }).label, '进行中')
  assert.equal(theoryTestStatus({ isEnd: true }).label, '已结束（未交卷）')
  assert.equal(theoryTestStatus({ startTime: '2026-09-29 10:00' }).label, '已开始未交卷')
  assert.equal(theoryTestStatus({}).label, '未开始')
  // is_end 是「比赛已结束」，不是「已交卷」
  assert.equal(theoryTestStatus({ isEnd: true, isParse: false }).key, 'ended')
})

// ────────────────────────────────────────────── session 失效识别

test('session 失效：403 + {"detail":"未登录"} → code session-expired 且带响应体文案', async () => {
  const [restore] = withFetch(() => jsonResponse({ detail: '未登录' }, 403))
  try {
    await assert.rejects(
      () => client().eventInfo(),
      (error) => {
        assert.equal(error.name, 'LingxuError')
        assert.equal(error.code, LINGXU_CODES.SESSION_EXPIRED)
        assert.equal(error.httpStatus, 403)
        assert.match(error.message, /未登录/)
        assert.equal(error.platformMessage, '未登录')
        assert.equal(isSessionExpired(error), true)
        return true
      },
    )
  } finally { restore() }
})

test('session 失效：HTTP 200 带 detail 也识别（平台不总是用 403）', async () => {
  const [restore] = withFetch(() => jsonResponse({ detail: '未登录' }, 200))
  try {
    await assert.rejects(
      () => client().request('/event/4/test/'),
      (error) => error.code === LINGXU_CODES.SESSION_EXPIRED && error.httpStatus === 200,
    )
  } finally { restore() }
})

test('普通 403（非未登录）不误判为 session 失效，但消息仍带响应体', async () => {
  const [restore] = withFetch(() => jsonResponse({ detail: '没有权限' }, 403))
  try {
    await assert.rejects(
      () => client().request('/event/4/ctf/'),
      (error) => {
        assert.equal(error.code, undefined)
        assert.equal(isSessionExpired(error), false)
        assert.match(error.message, /HTTP 403/)
        assert.match(error.message, /没有权限/)
        return true
      },
    )
  } finally { restore() }
})

test('HTTP 400 的 message 带平台 error 文案（不只是一句裸 HTTP 400）', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '该题目没有选择对应的环境，请联系管理员。' }, 400))
  try {
    await assert.rejects(
      () => client().request('/event/4/ctf/46/run/', { method: 'POST' }),
      (error) => {
        assert.match(error.message, /HTTP 400/)
        assert.match(error.message, /该题目没有选择对应的环境/)
        return true
      },
    )
  } finally { restore() }
})

test('isSessionExpired / isEnvNotConfigured：丢 code 后仍按文案兜底识别', () => {
  const wrapped = new Error('无法解析平台连接：凌虚 GET /event/4/info/ 未登录（HTTP 403）：未登录')
  assert.equal(isSessionExpired(wrapped), true)
  assert.equal(isSessionExpiredPayload({ detail: '未登录' }), true)
  assert.equal(isSessionExpiredPayload({ detail: '未登录', status: 200 }), true)
  assert.equal(isSessionExpiredPayload({ msg: 'ok' }), false)
  assert.equal(isEnvNotConfiguredPayload({ error: '该题目没有选择对应的环境，请联系管理员。' }), true)
  assert.equal(isEnvNotConfiguredPayload({ msg: '启动成功' }), false)
  assert.equal(isEnvNotConfigured(new Error('启动环境失败：该题目没有选择对应的环境，请联系管理员。')), true)
  assert.equal(isEnvNotConfigured(new Error('启动环境失败：配额不足')), false)
  assert.equal(isSessionExpired(null), false)
  assert.equal(isEnvNotConfigured(undefined), false)
})

// ────────────────────────────────────────────── 理论题

test('theoryTests：读 is_parse / parse_count，交卷后 is_begin=false 也判「已交卷」', async () => {
  const [restore] = withFetch(() => jsonResponse([
    {
      id: 3, name: '理论题', type: ['单选', '多选', '判断'], parse_count: 1, score: 1000.0,
      is_parse: true, answer_rule: 2, time_seconds: 3600, start_time: null, end_time: null,
      is_begin: false, count: 100, is_end: false,
    },
  ]))
  try {
    const tests = await client().theoryTests()
    assert.equal(tests.length, 1)
    assert.equal(tests[0].isParse, true)
    assert.equal(tests[0].isBegin, false, '平台交卷后 is_begin 回到 false')
    assert.equal(tests[0].parseCount, 1)
    assert.equal(tests[0].status, 'submitted')
    assert.equal(tests[0].statusLabel, '已交卷')
    assert.deepEqual(tests[0].types, ['单选', '多选', '判断'])
  } finally { restore() }
})

test('theoryQuestions：content 选项字典 + user_option 数组 + option_type/score 字段', async () => {
  const [restore] = withFetch(() => jsonResponse({
    count: 2,
    next: null,
    results: [
      {
        id: 11,
        name: '以下哪些属于对称加密？',
        content: { A: 'RSA', B: 'AES', C: 'SM4' },
        option_type: 2,
        option_count: 3,
        user_option: ['B', 'C'],
        sub_user: 'alice',
        sub_time: '2026-09-29T01:02:03Z',
        score: 5.0,
      },
      {
        id: 12,
        name: '<p>填空：国密分组密码是？</p>',
        content: {},
        option_type: 4,
        option_count: 1,
        user_option: [],
        score: 5.0,
      },
    ],
  }))
  try {
    const questions = await client().theoryQuestions(3)
    assert.equal(questions.length, 2)

    const [multi, blank] = questions
    assert.deepEqual(multi.options, [
      { key: 'A', text: 'RSA' },
      { key: 'B', text: 'AES' },
      { key: 'C', text: 'SM4' },
    ])
    assert.deepEqual(multi.userOption, ['B', 'C'], 'user_option 是数组，不是字符串')
    assert.equal(multi.userOptionText, 'B、C')
    assert.equal(multi.answered, true)
    assert.equal(multi.optionTypeLabel, '多选')
    assert.equal(multi.score, 5)
    assert.equal(multi.subUser, 'alice')
    assert.equal(multi.subTime, '2026-09-29T01:02:03Z')

    assert.equal(blank.title, '填空：国密分组密码是？', 'title 兼容 name 字段并转 Markdown')
    assert.deepEqual(blank.options, [])
    assert.equal(blank.userOption, null, '空数组 = 未作答')
    assert.equal(blank.userOptionText, '')
    assert.equal(blank.answered, false)
    assert.equal(blank.optionType, 4)
    assert.equal(blank.optionCount, 1)
  } finally { restore() }
})

test('answerTheory：JSON body + option 数组（原来 form-encoded 字符串会 500）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1, msg: '提交成功' }))
  try {
    const result = await client('sessionid=a; csrftoken=tok').answerTheory(3, 11, 'BCD')
    const call = lastCall(calls)
    assert.equal(call.init.method, 'POST')
    assert.equal(contentTypeOf(call), 'application/json')
    assert.deepEqual(bodyOf(call), { option: ['B', 'C', 'D'] })
    assert.doesNotMatch(String(call.init.body), /^option=/, '不得再发 form-encoded')
    assert.equal(call.init.headers['X-CSRFToken'], 'tok', '写操作保留 CSRF 头')
    assert.equal(result.ok, true)
    assert.deepEqual(result.option, ['B', 'C', 'D'])
    assert.equal(result.message, '提交成功')
  } finally { restore() }
})

test('answerTheory：多选数组会被排序；单选/判断单元素不排序', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1 }))
  try {
    const c = client()
    await c.answerTheory(3, 11, ['D', 'B', 'C'])
    assert.deepEqual(bodyOf(lastCall(calls)), { option: ['B', 'C', 'D'] })

    await c.answerTheory(3, 12, 'T')
    assert.deepEqual(bodyOf(lastCall(calls)), { option: ['T'] })

    await c.answerTheory(3, 13, 'B')
    assert.deepEqual(bodyOf(lastCall(calls)), { option: ['B'] })
  } finally { restore() }
})

test('answerTheory：填空题数组按空位顺序提交（optionType=4 不排序）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1 }))
  try {
    await client().answerTheory(3, 12, ['答案二', '答案一'], { optionType: 4 })
    assert.deepEqual(bodyOf(lastCall(calls)), { option: ['答案二', '答案一'] })
  } finally { restore() }
})

test('answerTheory：空选项直接报错，不发请求', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1 }))
  try {
    await assert.rejects(() => client().answerTheory(3, 11, '   '), /不能为空/)
    await assert.rejects(() => client().answerTheory(3, 11, []), /不能为空/)
    assert.equal(calls.length, 0)
  } finally { restore() }
})

test('answerTheory：平台返回 error 时 ok=false 并带出文案', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '选项非法' }))
  try {
    const result = await client().answerTheory(3, 11, 'Z')
    assert.equal(result.ok, false)
    assert.equal(result.message, '选项非法')
  } finally { restore() }
})

test('finishTheory：JSON body {status:1}；beginTheoryTest 不带 body', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1, msg: 'ok' }))
  try {
    const c = client()
    const finished = await c.finishTheory(3)
    const finishCall = lastCall(calls)
    assert.equal(contentTypeOf(finishCall), 'application/json')
    assert.deepEqual(bodyOf(finishCall), { status: 1 })
    assert.equal(finished.ok, true)

    await c.beginTheoryTest(3)
    const beginCall = lastCall(calls)
    assert.equal(beginCall.init.method, 'POST')
    assert.equal(beginCall.init.body, undefined, '前端 begin 不带 body')
  } finally { restore() }
})

// ────────────────────────────────────────────── 环境：分类

test('releaseEnvironment：四种分类（已释放 / 本来没环境 / 平台未配置 / 真失败）', async () => {
  const cases = [
    [{ status: 2, msg: '释放成功' }, { released: true, idempotent: false, notConfigured: false, kind: 'released' }],
    [{ status: 3, msg: '没有运行的环境' }, { released: true, idempotent: true, notConfigured: false, kind: 'no-env' }],
    [{ status: 3, msg: '该环境正在释放' }, { released: true, idempotent: true, notConfigured: false, kind: 'released' }],
  ]
  for (const [payload, expected] of cases) {
    const [restore] = withFetch(() => jsonResponse(payload))
    try {
      const result = await client().releaseEnvironment(3)
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(result[key], value, `${JSON.stringify(payload)} 的 ${key}`)
      }
      assert.equal(result.challengeId, '3')
    } finally { restore() }
  }
})

test('releaseEnvironment：HTTP 400「没有选择对应的环境」= 平台未配置，不抛错', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '该题目没有选择对应的环境，请联系管理员。' }, 400))
  try {
    const result = await client().releaseEnvironment(41)
    assert.equal(result.released, false)
    assert.equal(result.notConfigured, true)
    assert.equal(result.kind, 'not-configured')
    assert.equal(result.idempotent, false)
    assert.match(result.message, /没有选择对应的环境/)
    assert.equal(result.raw.error, '该题目没有选择对应的环境，请联系管理员。')
  } finally { restore() }
})

test('releaseEnvironment：200 但 body 是 error 文案时同样按未配置分类', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '该题目没有选择对应的环境，请联系管理员。' }, 200))
  try {
    const result = await client().releaseEnvironment(41)
    assert.equal(result.notConfigured, true)
  } finally { restore() }
})

test('releaseEnvironment：真正的失败（未知 status / HTTP 5xx）仍然抛 LingxuError', async () => {
  const [restore1] = withFetch(() => jsonResponse({ status: 3, msg: '未知错误' }))
  try {
    await assert.rejects(() => client().releaseEnvironment(3), /释放环境失败/)
  } finally { restore1() }

  const [restore2] = withFetch(() => jsonResponse({ detail: '服务器开小差了' }, 500))
  try {
    await assert.rejects(() => client().releaseEnvironment(3), (error) => {
      assert.equal(error.name, 'LingxuError')
      assert.equal(error.httpStatus, 500)
      return true
    })
  } finally { restore2() }
})

test('startEnvironment：run 返回「没有选择对应的环境」→ code env-not-configured', async () => {
  const [restore, calls] = withFetch((url) => {
    if (url.endsWith('/begin/')) return jsonResponse({ status: 1 })
    if (url.endsWith('/run/')) return jsonResponse({ error: '该题目没有选择对应的环境，请联系管理员。' }, 400)
    return jsonResponse({ domain_addr: '1.2.3.4:31337' })
  })
  try {
    await assert.rejects(
      () => client().startEnvironment(46),
      (error) => {
        assert.equal(error.code, LINGXU_CODES.ENV_NOT_CONFIGURED)
        assert.equal(isEnvNotConfigured(error), true)
        assert.equal(error.platformMessage, '该题目没有选择对应的环境，请联系管理员。')
        assert.match(error.message, /没有配置环境/)
        return true
      },
    )
    assert.equal(calls.length, 2, 'run 失败后不再请求 addr')
  } finally { restore() }
})

test('startEnvironment：run 200 但 body 是 error 文案，同样按未配置分类', async () => {
  const [restore] = withFetch((url) => {
    if (url.endsWith('/begin/')) return jsonResponse({ status: 1 })
    if (url.endsWith('/run/')) return jsonResponse({ error: '该题目没有选择对应的环境，请联系管理员。' })
    return jsonResponse({})
  })
  try {
    await assert.rejects(() => client().startEnvironment(46), (error) => error.code === LINGXU_CODES.ENV_NOT_CONFIGURED)
  } finally { restore() }
})

test('startEnvironment：正常三步不受影响（回归）', async () => {
  const [restore, calls] = withFetch((url) => {
    if (url.endsWith('/begin/')) return jsonResponse({ status: 1 })
    if (url.endsWith('/run/')) return jsonResponse({ status: 2, msg: '启动成功' })
    return jsonResponse({ domain_addr: '1.2.3.4:31337' })
  })
  try {
    const result = await client().startEnvironment(2)
    assert.equal(result.connectionInfo, 'nc 1.2.3.4 31337')
    assert.deepEqual(calls.map((c) => c.url.replace('https://x.com', '')), [
      '/event/4/ctf/2/begin/', '/event/4/ctf/2/run/', '/event/4/ctf/2/addr/',
    ])
  } finally { restore() }
})
