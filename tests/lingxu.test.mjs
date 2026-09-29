/**
 * lib/lingxu.js 单元测试（node:test，零依赖，mock fetch，不触网）。
 *
 * 覆盖平台接口和前端实现中发现的 5 个缺陷：
 *  1. answerTheory 发 JSON + option 数组（原来 form-encoded 字符串 ⇒ HTTP 500）
 *  2. theoryTests 读 is_parse（交卷后 is_begin=false，只看 is_begin 会误判「未开始」）
 *  3. theoryQuestions 读 content 选项字典 + user_option 数组
 *  4. finishTheory 统一 JSON body
 *  5. releaseEnvironment / startEnvironment 对「平台未配置环境」分类，不算失败
 *  6. sessionid 失效（HTTP 403 + {"detail":"未登录"}）→ code: 'session-expired'
 *
 * 运行：
 *  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
 *    --test tests/lingxu.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LingxuClient,
  LingxuError,
  LINGXU_CODES,
  CTF_TASK_TYPES,
  EVENT_TEST_TYPES,
  ctfAnswerModeLabel,
  ctfFlagTypeLabel,
  ctfPropertyLabel,
  ctfScoreModeLabel,
  ctfSharedLabel,
  ctfTaskTypeLabel,
  AWD_DYNAMIC_STATUS_LABELS,
  DEFAULT_RATE_LIMIT,
  REQUEST_PRIORITIES,
  currentRequestPriority,
  getLingxuRateLimit,
  lingxuRateLimitStats,
  setLingxuRateLimit,
  withRequestPriority,
  AWD_STATUS_LABELS,
  EVENT_TEST_TYPE_LABELS,
  EVENT_TYPE_CODES,
  classifyAnswerModePayload,
  classifyAwdErrorPayload,
  classifyCfsErrorPayload,
  classifyEnvErrorPayload,
  classifyStageErrorPayload,
  describeEventTypes,
  isStageError,
  normalizeTestTypes,
  envRemainingSeconds,
  isEnvBusyPayload,
  isEnvError,
  isEnvMissingPayload,
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

//  纯函数：选项归一化

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

//  session 失效识别

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

//  理论题

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

//  环境：分类

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

//  源码级深度适配
// 依据：平台 Django 源码 event_app/views/env.py、test.py、other.py、
// serializers.py、models.py（用户提供的完整源码）。

//  choices 标签

test('choices 标签：task_type / flag_type / answer_mode / shared / property / score_mode', () => {
  assert.equal(ctfTaskTypeLabel(1), '环境型')
  assert.equal(ctfTaskTypeLabel(2), '外链型')
  assert.equal(ctfTaskTypeLabel(3), '附件型')
  assert.equal(ctfTaskTypeLabel(9), '')
  assert.equal(ctfTaskTypeLabel(undefined), '')
  assert.equal(ctfFlagTypeLabel(1), '静态flag')
  assert.equal(ctfFlagTypeLabel(2), '动态flag')
  assert.equal(ctfAnswerModeLabel(1), 'FLAG')
  assert.equal(ctfAnswerModeLabel(2), 'check')
  assert.equal(ctfSharedLabel(3), '全员共享')
  assert.equal(ctfPropertyLabel(2), '私有')
  assert.equal(ctfScoreModeLabel(2), '动态计分')
  // 源码 models.py 的 choices 字典也在导出里
  assert.deepEqual(CTF_TASK_TYPES, { 1: '环境型', 2: '外链型', 3: '附件型' })
  assert.equal(EVENT_TEST_TYPES[2], '实操题')
})

//  环境错误分类（源码 7 条）

test('classifyEnvErrorPayload：源码 7 条环境错误逐条分类（含 env_limit 数字）', () => {
  const cases = [
    ['该题目没有选择对应的CTF题目，请联系管理员。', LINGXU_CODES.NO_CTF_BINDING],
    ['该题目没有选择对应的环境，请联系管理员。', LINGXU_CODES.ENV_NOT_CONFIGURED],
    ['比赛未开启', LINGXU_CODES.CONTEST_NOT_OPEN],
    ['比赛已结束', LINGXU_CODES.CONTEST_ENDED],
    ['请加入战队', LINGXU_CODES.TEAM_REQUIRED],
    ['未配置CTF赛段', LINGXU_CODES.NO_CTF_STAGE],
  ]
  for (const [message, code] of cases) {
    const parsed = classifyEnvErrorPayload({ error: message })
    assert.equal(parsed?.code, code, message)
    assert.equal(parsed?.message, message)
  }

  // 环境数超限：从「当前赛事限制启动2个题目环境，请释放后启动」解析出 envLimit
  const limit = classifyEnvErrorPayload({ error: '当前赛事限制启动2个题目环境，请释放后启动' })
  assert.equal(limit.code, LINGXU_CODES.ENV_LIMIT)
  assert.equal(limit.envLimit, 2)
  const limitBig = classifyEnvErrorPayload({ error: '当前赛事限制启动 12 个题目环境，请释放后启动' })
  assert.equal(limitBig.envLimit, 12, '容忍数字两侧空格')

  // 源码里 EventCTFBeginView 的战队文案变体
  assert.equal(
    classifyEnvErrorPayload({ error: '您还未加入战队，请先去个人中心加入战队后再开启题目。' }).code,
    LINGXU_CODES.TEAM_REQUIRED,
  )

  // 未识别 → null（上层按普通错误处理）
  assert.equal(classifyEnvErrorPayload({ error: '莫名其妙的错误' }), null)
  assert.equal(classifyEnvErrorPayload(null), null)
  assert.equal(classifyEnvErrorPayload({}), null)
})

test('isEnvError / isEnvBusyPayload / isEnvMissingPayload', () => {
  const envLimitError = new LingxuError('环境数已达上限（2 个）：当前赛事限制启动2个题目环境，请释放后启动', {
    code: LINGXU_CODES.ENV_LIMIT,
  })
  assert.equal(isEnvError(envLimitError), true)
  assert.equal(isEnvError(new Error('凌虚 POST /run/ HTTP 400：比赛已结束')), true, '文案兜底')
  assert.equal(isEnvError(new Error('网络超时')), false)
  assert.equal(isEnvError(null), false)

  assert.equal(isEnvBusyPayload({ status: 3, msg: '该环境正在启动' }), true)
  assert.equal(isEnvBusyPayload({ status: 3, msg: '该环境正在释放' }), true)
  assert.equal(isEnvBusyPayload({ status: 3, msg: '该环境正在延时' }), true)
  assert.equal(isEnvBusyPayload({ status: 3, msg: '没有运行的环境' }), false)
  assert.equal(isEnvMissingPayload({ status: 3, msg: '不存在的环境' }), true)
  assert.equal(isEnvMissingPayload({ status: 3, msg: '逻辑错误' }), true)
  assert.equal(isEnvMissingPayload({ status: 3, msg: '成功延时30分钟' }), false)
})

test('startEnvironment：7 类环境错误各自抛出对应 code（源码文案 → 结构化）', async () => {
  const cases = [
    ['该题目没有选择对应的CTF题目，请联系管理员。', LINGXU_CODES.NO_CTF_BINDING],
    ['该题目没有选择对应的环境，请联系管理员。', LINGXU_CODES.ENV_NOT_CONFIGURED],
    ['比赛未开启', LINGXU_CODES.CONTEST_NOT_OPEN],
    ['比赛已结束', LINGXU_CODES.CONTEST_ENDED],
    ['请加入战队', LINGXU_CODES.TEAM_REQUIRED],
    ['未配置CTF赛段', LINGXU_CODES.NO_CTF_STAGE],
    ['当前赛事限制启动2个题目环境，请释放后启动', LINGXU_CODES.ENV_LIMIT],
  ]
  for (const [message, code] of cases) {
    // 七条错误都出现在 run 视图里（begin 视图只有前几条，这里统一用 run 验证）
    const [restore, calls] = withFetch((url) => {
      if (url.endsWith('/begin/')) return jsonResponse({ status: 1, msg: '开启成功' })
      if (url.endsWith('/run/')) return jsonResponse({ error: message }, 400)
      return jsonResponse({ domain_addr: '1.2.3.4:1' })
    })
    try {
      await assert.rejects(
        () => client().startEnvironment(2),
        (error) => {
          assert.equal(error.code, code, `${message} → ${code}（实际 ${error.code}）`)
          assert.equal(error.platformMessage, message)
          assert.equal(error.httpStatus, 400)
          return true
        },
      )
      assert.equal(calls.length, 2, 'run 报错后不应再请求 addr')
    } finally { restore() }
  }

  // env-limit 额外把 env_limit 数字带出来
  const [restore] = withFetch((url) => {
    if (url.endsWith('/begin/')) return jsonResponse({ status: 1 })
    return jsonResponse({ error: '当前赛事限制启动2个题目环境，请释放后启动' })
  })
  try {
    await assert.rejects(() => client().startEnvironment(2), (error) => {
      assert.equal(error.code, LINGXU_CODES.ENV_LIMIT)
      assert.equal(error.envLimit, 2)
      assert.match(error.message, /环境数已达上限（2 个）/)
      return true
    })
  } finally { restore() }
})

test('startEnvironment：run 的「启动失败」（docker 层）→ env-start-failed（实测 #12）', async () => {
  const [restore] = withFetch((url) => {
    if (url.endsWith('/begin/')) return jsonResponse({ status: 1, msg: '开启成功' })
    return jsonResponse({ status: 3, msg: '启动失败' })
  })
  try {
    await assert.rejects(() => client().startEnvironment(12), (error) => {
      assert.equal(error.code, LINGXU_CODES.ENV_START_FAILED)
      assert.equal(error.platformStatus, 3)
      assert.match(error.message, /启动环境失败：启动失败/)
      return true
    })
  } finally { restore() }
})

test('startEnvironment：run 的「该环境正在启动」→ env-busy（status=3，不是通用失败）', async () => {
  const [restore] = withFetch((url) => {
    if (url.endsWith('/begin/')) return jsonResponse({ status: 2, msg: '您已经开启该题目' })
    return jsonResponse({ status: 3, msg: '该环境正在启动' })
  })
  try {
    await assert.rejects(() => client().startEnvironment(9), (error) => {
      assert.equal(error.code, LINGXU_CODES.ENV_BUSY)
      assert.equal(error.platformStatus, 3)
      return true
    })
  } finally { restore() }
})

//  addr / 剩余时间

test('envRemainingSeconds：优先 end_second，其次 release_time，过期归零', () => {
  assert.equal(envRemainingSeconds({ end_second: 1234 }), 1234)
  assert.equal(envRemainingSeconds({ end_second: 0 }), 0)
  assert.equal(envRemainingSeconds({ end_second: -5 }), 0, '负值归零（源码 get_end_second 同款处理）')
  assert.equal(envRemainingSeconds({ end_second: 12.7 }), 12, '取整')

  const release = '2026-09-29T10:30:00Z'
  const nowMs = Date.parse('2026-09-29T10:00:00Z')
  assert.equal(envRemainingSeconds({ release_time: release }, nowMs), 1800)
  assert.equal(envRemainingSeconds({ release_time: release }, Date.parse('2026-09-29T11:00:00Z')), 0, '已过期归零')
  // 无 T / 无时区的 Django 串按**本地时区**解析，期望值同样用本地解析算
  const naiveMs = Date.parse('2026-09-29T10:30:00')
  assert.equal(
    envRemainingSeconds({ release_time: '2026-09-29 10:30:00' }, naiveMs - 1800_000),
    1800,
    '兼容无 T 的 Django 串',
  )
  assert.equal(envRemainingSeconds({}), null)
  assert.equal(envRemainingSeconds(null), null)
})

test('getEnvironmentAddress：解析 Env_RunSerializer 全字段（run_time/release_time/end_second）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({
    id: 77,
    name: 'web-1-abc',
    domain_addr: 'https://a.example.com/',
    run_time: '2026-09-29T09:00:00Z',
    release_time: '2026-09-29T10:00:00Z',
    error_msg: '',
    ext_id: '1.2.3.4:31337',
    instance_id: 'abc123',
    vuln_id: 5,
    end_second: 900,
    classify: 'Pwn',
  }))
  try {
    const addr = await client().getEnvironmentAddress(9)
    assert.equal(calls[0].url, 'https://x.com/event/4/ctf/9/addr/')
    assert.deepEqual(addr.targets, ['https://a.example.com/', 'nc 1.2.3.4 31337'], 'domain_addr 与 ext_id 都列')
    assert.equal(addr.connectionInfo, 'https://a.example.com/\nnc 1.2.3.4 31337')
    assert.equal(addr.remainingSeconds, 900)
    assert.equal(addr.endSecond, 900)
    assert.equal(addr.expired, false)
    assert.equal(addr.runTime, '2026-09-29T09:00:00Z')
    assert.equal(addr.releaseTime, '2026-09-29T10:00:00Z')
    assert.equal(addr.vulnId, '5')
    assert.equal(addr.instanceId, 'abc123')
    assert.equal(addr.classify, 'Pwn')
    assert.equal(addr.name, 'web-1-abc')
    assert.equal(addr.envError, '')
  } finally { restore() }
})

test('getEnvironmentAddress：只有 release_time 时现算剩余时间；过期标记 expired', async () => {
  const past = new Date(Date.now() - 60_000).toISOString()
  const [restore] = withFetch(() => jsonResponse({ ext_id: '1.2.3.4:80', release_time: past }))
  try {
    const addr = await client().getEnvironmentAddress(9)
    assert.equal(addr.remainingSeconds, 0)
    assert.equal(addr.expired, true)
    assert.equal(addr.endSecond, null, '平台没给 end_second 时为 null')
  } finally { restore() }
})

test('getEnvironmentAddress：平台返回 {} （环境不存在）时不崩，targets 为空', async () => {
  const [restore] = withFetch(() => jsonResponse({}))
  try {
    const addr = await client().getEnvironmentAddress(9)
    assert.deepEqual(addr.targets, [])
    assert.equal(addr.remainingSeconds, null)
    assert.equal(addr.expired, false, '剩余时间未知时不算过期')
  } finally { restore() }
})

test('startEnvironment：把 addr 的生命周期字段带进返回值', async () => {
  const [restore] = withFetch((url) => {
    if (url.endsWith('/begin/')) return jsonResponse({ status: 1, msg: '开启成功' })
    if (url.endsWith('/run/')) return jsonResponse({ status: 2, msg: '启动成功' })
    return jsonResponse({ ext_id: '1.2.3.4:9999', end_second: 3599, run_time: '2026-09-29T09:00:00Z', release_time: '2026-09-29T10:00:00Z' })
  })
  try {
    const result = await client().startEnvironment(2)
    assert.equal(result.connectionInfo, 'nc 1.2.3.4 9999')
    assert.equal(result.remainingSeconds, 3599)
    assert.equal(result.expired, false)
    assert.equal(result.runTime, '2026-09-29T09:00:00Z')
  } finally { restore() }
})

//  环境延时（/delayed/）

test('delayEnvironment：成功 +30 分钟（status=2）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 2, msg: '成功延时30分钟' }))
  try {
    const result = await client().delayEnvironment(9)
    assert.equal(calls[0].url, 'https://x.com/event/4/ctf/9/delayed/')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'delayed')
    assert.equal(result.delayed, true)
    assert.equal(result.addedSeconds, 1800)
    assert.equal(result.message, '成功延时30分钟')
  } finally { restore() }
})

test('delayEnvironment：四类 status=3 结果（太早 / 正在延时 / 不存在 / 已过期）', async () => {
  const cases = [
    ['剩余半小时后才能延时', 'too-early'],
    ['该环境正在延时', 'busy'],
    ['不存在的环境', 'missing'],
    ['逻辑错误', 'expired'],
  ]
  for (const [message, kind] of cases) {
    const [restore] = withFetch(() => jsonResponse({ status: 3, msg: message }))
    try {
      const result = await client().delayEnvironment(9)
      assert.equal(result.ok, false, message)
      assert.equal(result.kind, kind, `${message} → ${kind}`)
      assert.equal(result.status, 3)
      assert.equal(result.message, message)
    } finally { restore() }
  }
})

test('delayEnvironment：HTTP 400（团队赛未加入战队）抛带 code 的错误', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '请加入战队' }, 400))
  try {
    await assert.rejects(() => client().delayEnvironment(9), (error) => {
      assert.equal(error.code, LINGXU_CODES.TEAM_REQUIRED)
      assert.equal(error.httpStatus, 400)
      return true
    })
  } finally { restore() }
})

//  题目详情（三类题型）

test('challengeDetail：task_type=3 附件型必须有附件路径 + 类型标签', async () => {
  const [restore] = withFetch(() => jsonResponse({
    name: '附件题',
    desc: '<p>下载附件</p>',
    vuln_id: '',
    task_type: 3,
    link_path: '',
    answer_mode: 1,
    secondary_path: '',
    attachment: '/media/env/ctf/flag_checker.py',
    test_list: {},
    score: 300,
    parse_count: 7,
    is_parse: false,
    message: [],
  }))
  try {
    const d = await client().challengeDetail(12)
    assert.equal(d.taskType, 3)
    assert.equal(d.taskTypeLabel, '附件型')
    assert.equal(d.downloadable, true)
    assert.equal(d.requiresEnv, false)
    assert.equal(d.attachment, 'https://x.com/media/env/ctf/flag_checker.py')
    assert.equal(d.attachmentName, 'flag_checker.py')
    assert.equal(d.answerModeLabel, 'FLAG')
    assert.equal(d.solves, 7)
    assert.equal(d.score, 300)
  } finally { restore() }
})

test('challengeDetail：task_type=1 环境型 / 2 外链型 语义正确', async () => {
  const [restore1] = withFetch(() => jsonResponse({
    name: '环境题', desc: 'x', vuln_id: '5', task_type: 1, link_path: '', answer_mode: 1,
    attachment: '', score: 1000, parse_count: 1, is_parse: true, message: ['环境重置通知'],
  }))
  try {
    const d = await client().challengeDetail(1)
    assert.equal(d.requiresEnv, true)
    assert.equal(d.taskTypeLabel, '环境型')
    assert.equal(d.vulnId, '5')
    assert.equal(d.isSolved, true)
    assert.deepEqual(d.messages, ['环境重置通知'])
    assert.equal(d.downloadable, false)
  } finally { restore1() }

  const [restore2] = withFetch(() => jsonResponse({
    name: '外链题', desc: 'x', vuln_id: '', task_type: 2, link_path: 'https://ext.example.com:8080/',
    answer_mode: 2, secondary_path: '/flag', attachment: '', score: 200, parse_count: 0, is_parse: false, message: [],
  }))
  try {
    const d = await client().challengeDetail(2)
    assert.equal(d.taskTypeLabel, '外链型')
    assert.equal(d.externalLink, 'https://ext.example.com:8080/')
    assert.equal(d.connectionInfo, 'https://ext.example.com:8080/')
    assert.equal(d.secondaryPath, '/flag')
    assert.equal(d.checkMode, true)
    assert.equal(d.answerModeLabel, 'check')
  } finally { restore2() }
})

test('challengeDetail：源码接口不返回的字段「有就解析、没有就空」（不臆造）', async () => {
  // 源码 EventCTFInfoView 不返回这些字段 → 默认值必须安全
  const [restore] = withFetch(() => jsonResponse({
    name: '普通题', desc: 'x', task_type: 2, answer_mode: 1, score: 100, parse_count: 0, is_parse: false, message: [],
  }))
  try {
    const d = await client().challengeDetail(3)
    assert.equal(d.flagType, undefined)
    assert.equal(d.flagTypeLabel, '')
    assert.equal(d.shared, undefined)
    assert.equal(d.sharedLabel, '')
    assert.equal(d.minScore, null)
    assert.equal(d.passScore, null)
    assert.equal(d.level, null)
    assert.equal(d.number, '')
    assert.equal(d.alias, '')
    assert.equal(d.manual, '')
    assert.equal(d.attachment, '')
    assert.equal(d.attachmentName, '')
  } finally { restore() }

  // 私有部署多返回这些字段时也能解析（源码里确实有这些模型字段）
  const [restore2] = withFetch(() => jsonResponse({
    name: '全字段', desc: 'x', task_type: 1, answer_mode: 1, score: 100, parse_count: 0, is_parse: false, message: [],
    flag_type: 2, shared: 2, property: 1, min_score: 100, pass_score: 0.3, level: 3,
    number: 'LX-001', alias: '别名', manual: '<p>手册</p>', attachment_name: 'handout.pdf', secondary_path: '/s',
  }))
  try {
    const d = await client().challengeDetail(4)
    assert.equal(d.flagType, 2)
    assert.equal(d.flagTypeLabel, '动态flag')
    assert.equal(d.shared, 2)
    assert.equal(d.sharedLabel, '团队内共享')
    assert.equal(d.propertyLabel, '公开')
    assert.equal(d.minScore, 100)
    assert.equal(d.passScore, 0.3)
    assert.equal(d.level, 3)
    assert.equal(d.number, 'LX-001')
    assert.equal(d.alias, '别名')
    assert.match(d.manual, /手册/)
    assert.equal(d.attachmentName, 'handout.pdf')
    assert.equal(d.secondaryPath, '/s')
  } finally { restore2() }
})

//  新端点

test('eventChart：默认 type=2（源码 type=1 恒为空数组）；解析 start/end + 前 10 名走势', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({
    start_time: 1759100000000,
    end_time: 1759200000000,
    data: [{ id: 1, name: 'xiyi', data: [[1759100000000, 0], [1759100600000, 500]] }],
  }))
  try {
    const chart = await client().eventChart()
    assert.equal(calls[0].url, 'https://x.com/event/4/chart/?type=2')
    assert.equal(chart.type, 2)
    assert.equal(chart.startTime, 1759100000000)
    assert.equal(chart.series.length, 1)
    assert.equal(chart.series[0].name, 'xiyi')
    assert.deepEqual(chart.series[0].points, [[1759100000000, 0], [1759100600000, 500]])
  } finally { restore() }

  // type=1（理论题）源码直接 return Response([]) → 空走势，不崩
  const [restore2, calls2] = withFetch(() => jsonResponse([]))
  try {
    const chart = await client().eventChart({ type: 1 })
    assert.equal(calls2[0].url, 'https://x.com/event/4/chart/?type=1')
    assert.deepEqual(chart.series, [])
    assert.equal(chart.startTime, null)
  } finally { restore2() }
})

test('eventPunish：分页拉取 + 归一化（id/user_list/issue_time/content/type/score）', async () => {
  const [restore, calls] = withFetch((url) => {
    if (url.includes('page=1')) {
      return jsonResponse({
        count: 2,
        next: '/event/4/punish/?type=1&page=2',
        results: [{ id: 1, user_list: ['alice'], issue_time: '2026-09-29 10:00', content: '违规', type: 1, score: -50 }],
      })
    }
    return jsonResponse({ count: 2, next: null, results: [{ id: 2, user_list: [], issue_time: '', content: '警告', type: 2, score: null }] })
  })
  try {
    const rows = await client().eventPunish({ type: 1 })
    assert.equal(calls[0].url, 'https://x.com/event/4/punish/?type=1&page=1&size=100')
    assert.equal(rows.length, 2)
    assert.deepEqual(rows[0], { id: 1, users: ['alice'], issueTime: '2026-09-29 10:00', content: '违规', type: 1, score: -50 })
    assert.equal(rows[1].score, null)
  } finally { restore() }
})

test('ctfTime：status 0/1/2 → 中文标签 + start/end_seconds', async () => {
  const cases = [[0, '进行中'], [1, '未开始'], [2, '已结束']]
  for (const [status, label] of cases) {
    const [restore, calls] = withFetch(() => jsonResponse({ status, start_seconds: 0, end_seconds: 3600 }))
    try {
      const time = await client().ctfTime()
      assert.equal(calls[0].url, 'https://x.com/event/4/ctf/time/')
      assert.equal(time.status, status)
      assert.equal(time.statusLabel, label)
      assert.equal(time.endSeconds, 3600)
    } finally { restore() }
  }
})

test('ctfNames：返回 [{id,name}]（赛事内题名）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse([{ id: 1, name: '签到' }, { id: 2, name: 'CodeGuardian' }]))
  try {
    const names = await client().ctfNames()
    assert.equal(calls[0].url, 'https://x.com/event/4/ctf/name/')
    assert.deepEqual(names, [{ id: 1, name: '签到' }, { id: 2, name: 'CodeGuardian' }])
  } finally { restore() }
})

test('noticeCount：返回 {count}', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ count: 3 }))
  try {
    const result = await client().noticeCount()
    assert.equal(calls[0].url, 'https://x.com/event/4/notice/count/')
    assert.equal(result.count, 3)
  } finally { restore() }
})

test('checkFlag：无 flag 时不带 body（与前端一致）；带 flag 时发 JSON', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1, detail: 'check已触发' }))
  try {
    const c = client()
    const result = await c.checkFlag(11)
    assert.equal(calls[0].url, 'https://x.com/event/4/ctf/11/check/')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.body, undefined, '前端 S.post(url) 不带 body')
    assert.equal(result.ok, true)
    assert.equal(result.detail, 'check已触发')
    assert.equal(result.flag, '')

    await c.checkFlag(11, 'flag{dynamic}')
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { flag: 'flag{dynamic}' })
    assert.equal(calls[1].init.headers['Content-Type'], 'application/json')
  } finally { restore() }
})

test('checkFlag：400 走环境错误分类（比赛未开始 / 非 check 模式）', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '比赛未开始' }, 400))
  try {
    await assert.rejects(() => client().checkFlag(11, 'f'), (error) => {
      assert.equal(error.code, LINGXU_CODES.CONTEST_NOT_OPEN)
      return true
    })
  } finally { restore() }

  const [restore2] = withFetch(() => jsonResponse({ error: '此题目不为check模式' }, 400))
  try {
    await assert.rejects(() => client().checkFlag(11, 'f'), /此题目不为check模式/)
  } finally { restore2() }
})

test('submitFlag：HTTP 400「您已提交了正确的Flag。」→ already_solved（不抛错）', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '您已提交了正确的Flag。' }, 400))
  try {
    const result = await client().submitFlag(1, 'flag{ok}')
    assert.equal(result.status, 'already_solved')
    assert.match(result.message, /已提交了正确的Flag/)
  } finally { restore() }

  // 团队赛文案
  const [restore2] = withFetch(() => jsonResponse({ error: '您所在的战队已提交了正确的Flag。' }, 400))
  try {
    const result = await client().submitFlag(1, 'flag{ok}')
    assert.equal(result.status, 'already_solved')
  } finally { restore2() }
})

test('classifyAnswerModePayload：源码文案与线上实测文案都识别', () => {
  assert.equal(classifyAnswerModePayload({ error: '此题目不为check模式' })?.code, LINGXU_CODES.ANSWER_MODE_MISMATCH)
  // 线上实测（2026-09-29）：与源码快照不同
  assert.equal(
    classifyAnswerModePayload({ error: '此题目为Flag模式，请提交Flag进行得分' })?.code,
    LINGXU_CODES.ANSWER_MODE_MISMATCH,
  )
  const fromFlag = classifyAnswerModePayload({ error: '此题目为check模式，请点击check进行得分' })
  assert.equal(fromFlag?.code, LINGXU_CODES.ANSWER_MODE_MISMATCH)
  assert.equal(fromFlag?.expect, 'check')
  assert.equal(classifyAnswerModePayload({ error: '别的错误' }), null)
})

test('checkFlag：对 FLAG 题调用 → answer-mode-mismatch（含线上文案变体）', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '此题目为Flag模式，请提交Flag进行得分' }, 400))
  try {
    await assert.rejects(() => client().checkFlag(1, 'flag{x}'), (error) => {
      assert.equal(error.code, LINGXU_CODES.ANSWER_MODE_MISMATCH)
      assert.equal(error.httpStatus, 400)
      assert.match(error.message, /该题不是 check 模式/)
      return true
    })
  } finally { restore() }
})

test('submitFlag：HTTP 400「check 模式」→ check-mode；其他 400 仍然抛错', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '此题目为check模式，请点击check进行得分' }, 400))
  try {
    const result = await client().submitFlag(1, 'flag{x}')
    assert.equal(result.status, 'check-mode')
  } finally { restore() }


  const [restore2] = withFetch(() => jsonResponse({ error: '比赛已结束' }, 400))
  try {
    await assert.rejects(() => client().submitFlag(1, 'flag{x}'), /比赛已结束/)
  } finally { restore2() }
})

test('submitFlag：status=1 时把动态分值 score 带出来', async () => {
  const [restore] = withFetch(() => jsonResponse({ status: 1, score: 850.5 }))
  try {
    const result = await client().submitFlag(1, 'flag{ok}')
    assert.equal(result.status, 'correct')
    assert.equal(result.score, 850.5)
  } finally { restore() }
})

//  AWD / CFS 两种赛制
// 依据：源码 event_app/views/awd.py、cfs.py、serializer/cfs.py、models.py、utils/awd_flag.py

//  赛事类型（test_type）

test('normalizeTestTypes：JSONField → [{id,name,size}]（1理论/2CTF/3AWD/4CFS）', () => {
  const rows = normalizeTestTypes({
    1: { name: '理论题', size: 30 },
    2: { name: '实操题', size: 30 },
    3: { name: 'AWD', size: 10 },
    4: { size: 5 },
  })
  assert.deepEqual(
    rows.map((r) => [r.id, r.name, r.size]),
    [
      [1, '理论题', 30],
      [2, '实操题', 30],
      [3, 'AWD', 10],
      [4, 'CFS', 5], // 没给 name 时用默认标签
    ],
  )
  assert.equal(rows[3].rawName, '', '保留平台原始 name（可能为空）')
  assert.deepEqual(normalizeTestTypes(null), [])
  assert.deepEqual(normalizeTestTypes('x'), [])
  assert.deepEqual(normalizeTestTypes({}), [])
  assert.deepEqual(EVENT_TEST_TYPE_LABELS, { 1: '理论题', 2: 'CTF', 3: 'AWD', 4: 'CFS' })
})

test('describeEventTypes：/type/ 的 "3" 是 CFS（源码 EventTypeView 的坑，不是 AWD）', () => {
  const rows = describeEventTypes(['1', '2', '3'])
  assert.deepEqual(rows.map((r) => r.label), ['理论题', 'CTF', 'CFS（注意：不是 AWD）'])
  assert.equal(EVENT_TYPE_CODES['3'].includes('不是 AWD'), true)
  assert.equal(EVENT_TYPE_CODES['4'], undefined, '源码里不会有 "4"')
})

test('eventType：GET /event/4/type/ 返回 codes + labels', async () => {
  const [restore, calls] = withFetch(() => jsonResponse(['1', '2']))
  try {
    const result = await client().eventType()
    assert.equal(calls[0].url, 'https://x.com/event/4/type/')
    assert.deepEqual(result.codes, ['1', '2'])
    assert.deepEqual(result.labels.map((r) => r.label), ['理论题', 'CTF'])
  } finally { restore() }
})

//  AWD 错误分类（源码原文案）

test('classifyAwdErrorPayload：源码全部 AWD 文案逐条分类', () => {
  const cases = [
    ['该赛事没有AWD赛段', LINGXU_CODES.NO_AWD_STAGE],
    ['未配置AWD赛段！', LINGXU_CODES.NO_AWD_STAGE],
    ['该题目没有选择对应的AWD题目，请联系管理员。', LINGXU_CODES.NO_AWD_BINDING],
    ['AWD赛段未开始', LINGXU_CODES.AWD_NOT_OPEN],
    ['AWD赛段已结束', LINGXU_CODES.AWD_ENDED],
    ['加固阶段不允许提交flag！', LINGXU_CODES.AWD_REINFORCE],
    ['回合开始前10秒不允许提交FLAG！', LINGXU_CODES.AWD_ROUND_COOLDOWN],
    ['您提交的flag错误！', LINGXU_CODES.AWD_FLAG_INCORRECT],
    ['您不能提交自己题目的Flag！', LINGXU_CODES.AWD_SELF_ATTACK],
    ['您已经提交过正确的Flag,无需重复提交！', LINGXU_CODES.AWD_DUPLICATE],
    ['对方已被攻陷，不可提交Flag！', LINGXU_CODES.AWD_TARGET_DOWN],
    ['队伍已经被攻陷！', LINGXU_CODES.AWD_TARGET_DOWN],
    ['token值错误', LINGXU_CODES.AWD_BAD_TOKEN],
    ['未找到token！', LINGXU_CODES.AWD_BAD_TOKEN],
    ['未找到flag！', LINGXU_CODES.AWD_BAD_TOKEN],
    ['您没有可用的重置次数！', LINGXU_CODES.AWD_NO_RESET_QUOTA],
    ['您没有可用的收费重置次数！', LINGXU_CODES.AWD_NO_RESET_QUOTA],
    ['回合结束前1分钟不允许重置环境！', LINGXU_CODES.AWD_RESET_BLOCKED],
    ['您剩余的题目分小于重置扣分分数，重置失败！', LINGXU_CODES.AWD_RESET_BLOCKED],
    ['未找到运行环境，请联系管理员！', LINGXU_CODES.AWD_ENV_UNAVAILABLE],
    ['运行环境未启动，请联系管理员！', LINGXU_CODES.AWD_ENV_UNAVAILABLE],
    ['未找到您的awd回合分数据，请联系管理员！', LINGXU_CODES.AWD_ENV_UNAVAILABLE],
    ['该赛事不允许查看', LINGXU_CODES.EVENT_NOT_VIEWABLE],
    ['此场赛事不允许查看排行榜', LINGXU_CODES.EVENT_NOT_VIEWABLE],
  ]
  for (const [message, code] of cases) {
    assert.equal(classifyAwdErrorPayload({ error: message })?.code, code, message)
  }
  assert.equal(classifyAwdErrorPayload({ error: '别的错误' }), null)
  assert.equal(classifyAwdErrorPayload(null), null)
  assert.equal(
    classifyStageErrorPayload({ error: '该赛事没有AWD赛段' })?.code,
    LINGXU_CODES.NO_AWD_STAGE,
    '统一分类入口也能识别 AWD',
  )
})

test('classifyCfsErrorPayload：源码全部 CFS 文案分类（注意小写 cfs）', () => {
  const cases = [
    ['该赛事没有cfs赛段', LINGXU_CODES.NO_CFS_STAGE],
    ['该题目没有选择对应的CFS题目，请联系管理员。', LINGXU_CODES.NO_CFS_BINDING],
    ['cfs赛段未开始', LINGXU_CODES.CFS_NOT_OPEN],
    ['cfs赛段已结束', LINGXU_CODES.CFS_ENDED],
    ['您已通关本题目', LINGXU_CODES.CFS_LEVEL_DONE],
    ['您已通过本关卡', LINGXU_CODES.CFS_LEVEL_DONE],
    ['您提交的flag错误！', LINGXU_CODES.CFS_FLAG_INCORRECT],
  ]
  for (const [message, code] of cases) {
    assert.equal(classifyCfsErrorPayload({ error: message })?.code, code, message)
  }
  assert.equal(classifyCfsErrorPayload({ error: '无关' }), null)
})

test('isStageError：code 优先 + 文案兜底', () => {
  assert.equal(isStageError(new LingxuError('x', { code: LINGXU_CODES.NO_AWD_STAGE })), true)
  assert.equal(isStageError(new Error('凌虚 GET /event/4/awd/info/ HTTP 400：该赛事没有AWD赛段')), true)
  assert.equal(isStageError(new Error('网络超时')), false)
  assert.equal(isStageError(null), false)
})

//  AWD 端点

test('awdRoundInfo：赛段状态/回合/加固期/token/排名', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({
    status: 0,
    start_seconds: 0,
    end_seconds: 3600,
    reinforce_end_seconds: 300,
    round_end_seconds: 120,
    round: 3,
    info_dict: { token: 'tok-abc', name: 'xiyi', number: 'lx_1', rank: 2 },
  }))
  try {
    const info = await client().awdRoundInfo()
    assert.equal(calls[0].url, 'https://x.com/event/4/awd/info/')
    assert.equal(info.status, 0)
    assert.equal(info.statusLabel, '进行中')
    assert.equal(info.round, 3)
    assert.equal(info.roundEndSeconds, 120)
    assert.equal(info.reinforceEndSeconds, 300)
    assert.equal(info.isReinforce, true)
    assert.equal(info.token, 'tok-abc')
    assert.equal(info.rank, 2)
    assert.equal(info.name, 'xiyi')
  } finally { restore() }

  // 状态 1/2 与「无加固期」
  for (const [status, label] of [[1, '未开始'], [2, '已结束']]) {
    const [restore2] = withFetch(() => jsonResponse({ status, reinforce_end_seconds: 0, round: 0 }))
    try {
      const info = await client().awdRoundInfo()
      assert.equal(info.statusLabel, label)
      assert.equal(info.isReinforce, false)
    } finally { restore2() }
  }
})

test('awdRoundInfo：没有 AWD 赛段 → no-awd-stage（真实平台就是这个）', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '该赛事没有AWD赛段' }, 400))
  try {
    await assert.rejects(() => client().awdRoundInfo(), (error) => {
      assert.equal(error.code, LINGXU_CODES.NO_AWD_STAGE)
      assert.equal(error.httpStatus, 400)
      assert.equal(error.platformMessage, '该赛事没有AWD赛段')
      assert.match(error.message, /该赛事没有 AWD 赛段/)
      return true
    })
  } finally { restore() }
})

test('awdChallenges：分页 + cat_id/ca_id/awd_id 三段 id 不混', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({
    count: 1,
    next: null,
    results: [{
      cat_id: 11, ca_id: 22, awd_id: 33, awd_name: 'EasyPHP', classify: 'Web',
      test_score: 100, round_score: 50, check_status: true, is_attacked: false, msg: ['提示'],
    }],
  }))
  try {
    const rows = await client().awdChallenges()
    assert.equal(calls[0].url, 'https://x.com/event/4/awd/?page=1&size=100')
    assert.deepEqual(rows[0], {
      catId: 11, caId: 22, awdId: 33, name: 'EasyPHP', classify: 'Web',
      testScore: 100, roundScore: 50, checkStatus: true, isAttacked: false, messages: ['提示'],
    })
  } finally { restore() }

  const [restore2, calls2] = withFetch(() => jsonResponse({ count: 0, results: [] }))
  try {
    await client().awdChallenges({ classify: 'Web' })
    assert.equal(calls2[0].url, 'https://x.com/event/4/awd/?classify=Web&page=1&size=100')
  } finally { restore2() }
})

test('awdChallengeDetail：URL 参数顺序是 (cat_id, ca_id) —— 源码注释明确', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({
    id: 11, name: 'EasyPHP', classify: 'Web', desc: '<p>题面</p>',
    env_run_id: 77, is_attacked: true, check_status: true,
    test_ip_addr: { ext_ip: '1.2.3.4:2222' },
    test_img_pass: { username: 'root', password: 'cloversec' },
    left_free_reset_num: 1, left_reset_num: 2, reset_score: 30, is_attack_ip: true,
    attack_ip: ['5.6.7.8:2222', ''], run_status: 3, error_msg: '',
    test_score: 100, round_score: 10, msg: ['注意'],
  }))
  try {
    const d = await client().awdChallengeDetail(11, 22)
    assert.equal(calls[0].url, 'https://x.com/event/4/awd/11/22/info/', 'cat_id 在前、ca_id 在后')
    assert.equal(d.name, 'EasyPHP')
    assert.equal(d.description, '题面')
    assert.equal(d.envRunId, 77)
    assert.equal(d.ipAddr, '1.2.3.4:2222')
    assert.equal(d.imgUser, 'root')
    assert.equal(d.imgPassword, 'cloversec')
    assert.deepEqual(d.attackIp, ['5.6.7.8:2222'], '过滤空值')
    assert.equal(d.leftFreeResetNum, 1)
    assert.equal(d.leftResetNum, 2)
    assert.equal(d.resetScore, 30)
    assert.equal(d.isAttacked, true)
    assert.equal(d.checkStatus, true)
    assert.equal(d.runStatus, 3)
    assert.deepEqual(d.messages, ['注意'])
  } finally { restore() }
})

test('awdSubmitFlag：token/flag 走 query 参数（GET 与 POST 都可以）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1, data: 'Flag提交成功！' }))
  try {
    const c = client()
    const result = await c.awdSubmitFlag('tok-abc', 'flag{attack}')
    assert.equal(
      calls[0].url,
      'https://x.com/event/4/awd/flag/?token=tok-abc&flag=flag%7Battack%7D',
      '必须是 query 参数',
    )
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.body, undefined, '不得把 token/flag 放 body（源码只读 query_params）')
    assert.equal(result.ok, true)
    assert.equal(result.message, 'Flag提交成功！')

    await c.awdSubmitFlag('tok-abc', 'flag{x}', { method: 'GET' })
    assert.equal(calls[1].init.method, 'GET')
  } finally { restore() }
})

test('awdSubmitFlag：token/flag 特殊字符要 encode；缺参数直接报错', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1, data: 'ok' }))
  try {
    await client().awdSubmitFlag('a+b&c=d', 'flag{1+2}')
    assert.equal(
      calls[0].url,
      'https://x.com/event/4/awd/flag/?token=a%2Bb%26c%3Dd&flag=flag%7B1%2B2%7D',
    )
    await assert.rejects(() => client().awdSubmitFlag('', 'flag{x}'), /需要 token/)
    await assert.rejects(() => client().awdSubmitFlag('tok', '   '), /需要 flag/)
    assert.equal(calls.length, 1, '参数不合法时不应发请求')
  } finally { restore() }
})

test('awdSubmitFlag：业务错误按 code 分类（token 错 / 自己打自己 / 重复 / 加固期）', async () => {
  const cases = [
    ['token值错误', LINGXU_CODES.AWD_BAD_TOKEN],
    ['您不能提交自己题目的Flag！', LINGXU_CODES.AWD_SELF_ATTACK],
    ['您已经提交过正确的Flag,无需重复提交！', LINGXU_CODES.AWD_DUPLICATE],
    ['加固阶段不允许提交flag！', LINGXU_CODES.AWD_REINFORCE],
    ['回合开始前10秒不允许提交FLAG！', LINGXU_CODES.AWD_ROUND_COOLDOWN],
    ['您提交的flag错误！', LINGXU_CODES.AWD_FLAG_INCORRECT],
    ['AWD赛段已结束', LINGXU_CODES.AWD_ENDED],
  ]
  for (const [message, code] of cases) {
    const [restore] = withFetch(() => jsonResponse({ error: message }, 400))
    try {
      await assert.rejects(() => client().awdSubmitFlag('tok', 'flag{x}'), (error) => {
        assert.equal(error.code, code, message)
        return true
      })
    } finally { restore() }
  }
})

test('awdGetOwnFlag：返回 flag 与「没取到」的提示（源码按请求 IP 匹配靶机）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ flag: 'flag{own}' }))
  try {
    const own = await client().awdGetOwnFlag()
    assert.equal(calls[0].url, 'https://x.com/event/4/awd/get_flag/')
    assert.equal(own.flag, 'flag{own}')
    assert.equal(own.hasFlag, true)
    assert.equal(own.hint, '')
  } finally { restore() }

  const [restore2] = withFetch(() => jsonResponse({ flag: '' }))
  try {
    const own = await client().awdGetOwnFlag()
    assert.equal(own.hasFlag, false)
    assert.match(own.hint, /靶机本机/)
    assert.match(own.hint, /flag_type/)
  } finally { restore2() }
})

test('awdResetKvm：POST /kvm/{id}/reset/?type=；成功看 message 字段', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1, message: '重置成功' }))
  try {
    const result = await client().awdResetKvm(77)
    assert.equal(calls[0].url, 'https://x.com/event/4/kvm/77/reset/?type=1', '默认免费重置 type=1')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(result.ok, true)
    assert.equal(result.message, '重置成功')

    await client().awdResetKvm(77, { type: 2 })
    assert.equal(calls[1].url, 'https://x.com/event/4/kvm/77/reset/?type=2')
  } finally { restore() }

  const [restore2] = withFetch(() => jsonResponse({ status: 2, message: '环境正在重建中，请稍后再操作' }))
  try {
    const result = await client().awdResetKvm(77)
    assert.equal(result.ok, false)
    assert.match(result.message, /重建中/)
  } finally { restore2() }
})

test('awdResetKvm：重置被拒的三种错误分类', async () => {
  const cases = [
    ['您没有可用的重置次数！', LINGXU_CODES.AWD_NO_RESET_QUOTA],
    ['回合结束前1分钟不允许重置环境！', LINGXU_CODES.AWD_RESET_BLOCKED],
    ['AWD赛段未开始', LINGXU_CODES.AWD_NOT_OPEN],
  ]
  for (const [message, code] of cases) {
    const [restore] = withFetch(() => jsonResponse({ error: message }, 400))
    try {
      await assert.rejects(() => client().awdResetKvm(77), (error) => {
        assert.equal(error.code, code, message)
        return true
      })
    } finally { restore() }
  }
})

test('awdReferee：POST body {content}；空内容/重复呼叫的错误', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ status: 1, detail: '消息已发送！' }))
  try {
    const result = await client().awdReferee('环境连不上')
    assert.equal(calls[0].url, 'https://x.com/event/4/awd/referee/')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { content: '环境连不上' })
    assert.equal(result.ok, true)
    assert.equal(result.detail, '消息已发送！')
    await assert.rejects(() => client().awdReferee('  '), /需要 content/)
  } finally { restore() }
})

test('awdRank：分页 + 名次 + topicInfo（每人每台靶机状态）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({
    count: 2,
    next: null,
    results: [
      { id: 1, name: 'xiyi', awd_score: 300, round_awd_score: 50, total_round_score: 20, is_self: true,
        awd_score_time: '2026-09-29 12:00', logo: '',
        topic_info: [{ awd__name: 'EasyPHP', check_status: true, is_attacked: false, sub_user: 'xiyi' }] },
      { id: 2, name: 'bob', awd_score: 100, round_awd_score: 0, total_round_score: null, is_self: false },
    ],
  }))
  try {
    const rows = await client().awdRank()
    assert.equal(calls[0].url, 'https://x.com/event/4/awd/rank/?page=1&size=100')
    assert.equal(rows[0].rank, 1)
    assert.equal(rows[0].isSelf, true)
    assert.equal(rows[0].awdScore, 300)
    assert.equal(rows[0].roundAwdScore, 50)
    assert.equal(rows[0].totalRoundScore, 20)
    assert.equal(rows[0].topicInfo[0].awd__name, 'EasyPHP')
    assert.equal(rows[1].rank, 2)
    assert.equal(rows[1].totalRoundScore, null)
    assert.deepEqual(rows[1].topicInfo, [])
  } finally { restore() }
})

test('awdDynamic：数组形状（源码未启用分页）+ 状态文案', async () => {
  const [restore, calls] = withFetch(() => jsonResponse([
    { status: 1, attack: [1], attack_name: 'xiyi', attacked: [2], attacked_name: 'bob', score: '50',
      test_id: '11', test_name: 'EasyPHP', round_nums: 3, update_time: '2026-09-29 12:00' },
    { status: 3, attack: [], attack_name: '', attacked: [1], attacked_name: 'xiyi', score: '-30',
      test_id: '11', test_name: 'EasyPHP', round_nums: 3, update_time: '2026-09-29 12:01' },
  ]))
  try {
    const rows = await client().awdDynamic()
    assert.equal(calls[0].url, 'https://x.com/event/4/awd/dynamic/')
    assert.equal(rows[0].statusLabel, '攻击')
    assert.equal(rows[0].attackName, 'xiyi')
    assert.equal(rows[0].score, '50')
    assert.equal(rows[0].roundNums, 3)
    assert.equal(rows[1].statusLabel, '重置')
    assert.equal(rows[1].score, '-30')
  } finally { restore() }

  // 也兼容分页对象形状
  const [restore2] = withFetch(() => jsonResponse({ count: 1, results: [{ status: 4 }] }))
  try {
    const rows = await client().awdDynamic()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].statusLabel, '自己宕机')
  } finally { restore2() }
})

test('awdDynamicInfo：多值筛选参数（status[]/test_id[]/round_nums[]/ordering）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({ count: 0, results: [] }))
  try {
    await client().awdDynamicInfo({ status: [1, 2], testId: 11, roundNums: [3, 4], ordering: 1 })
    assert.equal(
      calls[0].url,
      'https://x.com/event/4/awd/dynamic/info/?status=1&status=2&test_id=11&round_nums=3&round_nums=4&ordering=1&page=1&size=100',
    )
  } finally { restore() }
})

test('awdDynamicTests / awdDynamicUsers / awdFlagApi', async () => {
  const [restore, calls] = withFetch((url) => {
    if (url.includes('awd_test')) return jsonResponse([{ id: 11, test_name: 'EasyPHP' }])
    if (url.includes('awd_user')) return jsonResponse([{ id: 1, username: 'xiyi' }])
    if (url.includes('flag/addr')) return jsonResponse({ API: '/event/4/awd/flag/?token=tok-xyz&flag=' })
    return jsonResponse({})
  })
  try {
    assert.deepEqual(await client().awdDynamicTests(), [{ id: 11, name: 'EasyPHP' }])
    assert.deepEqual(await client().awdDynamicUsers(), [{ id: 1, name: 'xiyi' }])
    const api = await client().awdFlagApi()
    assert.equal(api.token, 'tok-xyz', '从 API 串里解析出 token')
    assert.equal(api.api, '/event/4/awd/flag/?token=tok-xyz&flag=')
    assert.equal(calls.length, 3)
  } finally { restore() }
})

//  CFS 端点

test('cfsRoundInfo：赛段状态（无回合概念）', async () => {
  for (const [status, label] of [[0, '进行中'], [1, '未开始'], [2, '已结束']]) {
    const [restore, calls] = withFetch(() => jsonResponse({ status, start_seconds: 0, end_seconds: 600 }))
    try {
      const info = await client().cfsRoundInfo()
      assert.equal(calls[0].url, 'https://x.com/event/4/cfs/info/')
      assert.equal(info.statusLabel, label)
      assert.equal(info.endSeconds, 600)
    } finally { restore() }
  }

  const [restore2] = withFetch(() => jsonResponse({ error: '该赛事没有cfs赛段' }, 400))
  try {
    await assert.rejects(() => client().cfsRoundInfo(), (error) => {
      assert.equal(error.code, LINGXU_CODES.NO_CFS_STAGE)
      assert.match(error.message, /该赛事没有 CFS 赛段/)
      return true
    })
  } finally { restore2() }
})

test('cfsChallenges：分页 + 关卡进度（solve_schedule/all_schedule）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({
    count: 1,
    next: null,
    results: [{
      cct_id: 5, cc_id: 6, cfs_id: 7, cfs_name: '靶场渗透', cfs_score: 500,
      desc_content: '<p>场景说明</p>', solve_schedule: 2, all_schedule: 5, done_count: 3, msg: ['提示'],
    }],
  }))
  try {
    const rows = await client().cfsChallenges()
    assert.equal(calls[0].url, 'https://x.com/event/4/cfs/?page=1&size=100')
    assert.deepEqual(rows[0], {
      cctId: 5, ccId: 6, cfsId: 7, name: '靶场渗透', score: 500, descriptionHtml: '<p>场景说明</p>',
      description: '场景说明', solveSchedule: 2, allSchedule: 5, doneCount: 3, messages: ['提示'],
    })
  } finally { restore() }
})

test('cfsChallengeDetail：cct_id 路径 + 关卡地址/附件/当前分', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({
    cct_id: 5, cc_id: 6, cfs_id: 7, cfs_name: '靶场渗透', cfs_score: 500, now_score: 120,
    desc_content: '说明', solve_schedule: 2, all_schedule: 5, done_count: 3,
    addr_list: [{ name: '入口', addr: '1.2.3.4' }], annex_list: ['a.zip'], attachment: '/media/env/cfs/a.zip',
    msg: [],
  }))
  try {
    const d = await client().cfsChallengeDetail(5)
    assert.equal(calls[0].url, 'https://x.com/event/4/cfs/5/info/')
    assert.equal(d.nowScore, 120)
    assert.deepEqual(d.addrList, [{ name: '入口', addr: '1.2.3.4' }])
    assert.deepEqual(d.annexList, ['a.zip'])
    assert.equal(d.attachment, 'https://x.com/media/env/cfs/a.zip')
    assert.equal(d.solveSchedule, 2)
    assert.equal(d.allSchedule, 5)
  } finally { restore() }
})

test('cfsSubmitFlag：POST body {flag} + 成功文案（data 字段）', async () => {
  const [restore, calls] = withFetch(() => jsonResponse({
    status: 1, data: '恭喜攻克【靶场渗透】题目下的关卡【第一关】！',
  }))
  try {
    const result = await client().cfsSubmitFlag(5, 'flag{level1}')
    assert.equal(calls[0].url, 'https://x.com/event/4/cfs/5/flag/')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { flag: 'flag{level1}' })
    assert.equal(result.ok, true)
    assert.match(result.message, /恭喜攻克/)
    assert.equal(result.flag, 'flag{level1}')
    await assert.rejects(() => client().cfsSubmitFlag(5, '  '), /需要 flag/)
  } finally { restore() }
})

test('同一句「您提交的flag错误！」在 AWD/CFS 里按请求来源区分（源码两处字面相同）', async () => {
  const awdHarness = withFetch(() => jsonResponse({ error: '您提交的flag错误！' }, 400))
  try {
    await assert.rejects(() => client().awdSubmitFlag('tok', 'flag{x}'), (error) => {
      assert.equal(error.code, LINGXU_CODES.AWD_FLAG_INCORRECT, 'AWD 请求 → awd-flag-incorrect')
      return true
    })
  } finally { awdHarness[0]() }

  const cfsHarness = withFetch(() => jsonResponse({ error: '您提交的flag错误！' }, 400))
  try {
    await assert.rejects(() => client().cfsSubmitFlag(5, 'flag{x}'), (error) => {
      assert.equal(error.code, LINGXU_CODES.CFS_FLAG_INCORRECT, 'CFS 请求 → cfs-flag-incorrect')
      return true
    })
  } finally { cfsHarness[0]() }
})

test('cfsSubmitFlag：已通关 / 已通过关卡 / flag 错误 的分类', async () => {
  const cases = [
    ['您已通关本题目', LINGXU_CODES.CFS_LEVEL_DONE],
    ['您已通过本关卡', LINGXU_CODES.CFS_LEVEL_DONE],
    ['您提交的flag错误！', LINGXU_CODES.CFS_FLAG_INCORRECT],
    ['cfs赛段未开始', LINGXU_CODES.CFS_NOT_OPEN],
    ['cfs赛段已结束', LINGXU_CODES.CFS_ENDED],
  ]
  for (const [message, code] of cases) {
    const [restore] = withFetch(() => jsonResponse({ error: message }, 400))
    try {
      await assert.rejects(() => client().cfsSubmitFlag(5, 'flag{x}'), (error) => {
        assert.equal(error.code, code, message)
        return true
      })
    } finally { restore() }
  }
})

test('cfsRank / cfsChart / cfsDynamic', async () => {
  const [restore, calls] = withFetch((url) => {
    if (url.includes('/cfs/rank/')) {
      return jsonResponse({ count: 1, next: null, results: [{ id: 1, name: 'xiyi', cfs_score: 200, cfs_strengths: 3, cfs_flag_count: 4, is_self: true, cfs_score_time: '2026-09-29 12:00', logo: '' }] })
    }
    if (url.includes('/cfs/chart/')) {
      return jsonResponse({ start_time: 1, end_time: 2, data: [{ id: 1, name: 'xiyi', data: [[1, 0], [2, 200]] }] })
    }
    if (url.includes('/cfs/dynamic/')) {
      return jsonResponse([{ id: 9, name: 'xiyi', test_name: '靶场渗透', flag_test_name: '第一关', sub_time: '12:00:00' }])
    }
    return jsonResponse({})
  })
  try {
    const rank = await client().cfsRank()
    assert.equal(calls[0].url, 'https://x.com/event/4/cfs/rank/?page=1&size=100')
    assert.deepEqual(rank[0], {
      rank: 1, id: 1, name: 'xiyi', cfsScore: 200, cfsStrengths: 3, cfsFlagCount: 4, isSelf: true,
      cfsScoreTime: '2026-09-29 12:00', logo: '',
    })

    const chart = await client().cfsChart()
    assert.equal(chart.series[0].points.length, 2)

    const dynamic = await client().cfsDynamic()
    assert.deepEqual(dynamic[0], {
      id: 9, name: 'xiyi', testName: '靶场渗透', flagTestName: '第一关', subTime: '12:00:00',
    })
  } finally { restore() }
})

//  全局限流 + 429 退避
// 背景：面板 5s 轮询 × 6 次请求 + 8 个 agent → 平台会话被打爆（真实事故：全队 403）。

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('限流：连发 20 个请求，实际发起间隔 ≥ 配置的最小间隔', async () => {
  const starts = []
  const [restore] = withFetch(() => {
    starts.push(Date.now())
    return jsonResponse({ ok: true })
  })
  try {
    const c = new LingxuClient({
      baseUrl: 'https://rl-interval.test',
      eventId: 4,
      cookie: 'sessionid=a',
      minIntervalMs: 30,
      maxConcurrent: 2,
    })
    for (let i = 0; i < 20; i += 1) await c.request('/event/4/info/')
    assert.equal(starts.length, 20)
    const gaps = starts.slice(1).map((t, i) => t - starts[i])
    const minGap = Math.min(...gaps)
    assert.ok(minGap >= 28, `最小间隔应 ≥ 28ms（配置 30ms），实测 ${minGap}ms，gaps=${gaps.join(',')}`)
  } finally { restore() }
})

test('限流：并发上限生效（同时 10 个请求，在途 ≤ 2）', async () => {
  let active = 0
  let maxActive = 0
  const [restore] = withFetch(async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await sleepMs(8)
    active -= 1
    return jsonResponse({ ok: true })
  })
  try {
    const c = new LingxuClient({
      baseUrl: 'https://rl-concurrency.test',
      eventId: 4,
      cookie: 'sessionid=a',
      minIntervalMs: 0,
      maxConcurrent: 2,
    })
    await Promise.all(Array.from({ length: 10 }, (_, i) => c.request(`/event/4/ctf/${i}/info/`)))
    assert.equal(maxActive, 2, `在途请求应被压到 2，实测 ${maxActive}`)
    const stats = lingxuRateLimitStats().find((s) => s.host === 'https://rl-concurrency.test')
    assert.equal(stats.sent, 10)
    assert.equal(stats.maxInFlight, 2)
    assert.equal(stats.queued, 0, '跑完队列应清空')
  } finally { restore() }
})

test('限流：interactive 优先于 background（面板让路给 agent）', async () => {
  const order = []
  const [restore] = withFetch(async (url) => {
    order.push(String(url).replace('https://rl-priority.test/event/4/', '').replace(/\/$/, ''))
    await sleepMs(5)
    return jsonResponse({ ok: true })
  })
  try {
    const c = new LingxuClient({
      baseUrl: 'https://rl-priority.test',
      eventId: 4,
      cookie: 'sessionid=a',
      minIntervalMs: 0,
      maxConcurrent: 1,
    })
    // 先占住唯一的并发名额
    const blocker = c.request('/event/4/blocker/')
    await sleepMs(1)
    // 名额被占时排队：两个后台 + 一个交互（交互后入队但应先跑）
    const bg1 = withRequestPriority('background', () => c.request('/event/4/bg1/'))
    const bg2 = withRequestPriority('background', () => c.request('/event/4/bg2/'))
    const interactive = c.request('/event/4/mine/')
    await Promise.all([blocker, bg1, bg2, interactive])
    assert.deepEqual(order, ['blocker', 'mine', 'bg1', 'bg2'], '交互请求必须插到后台请求前面')
  } finally { restore() }
})

test('withRequestPriority / currentRequestPriority：优先级随 async 上下文传递', async () => {
  assert.equal(currentRequestPriority(), 'interactive')
  const seen = await withRequestPriority('background', async () => {
    await sleepMs(1)
    return currentRequestPriority()
  })
  assert.equal(seen, 'background', '必须跨 await 保持')
  assert.equal(currentRequestPriority(), 'interactive', '出了作用域要恢复')
})

test('退避：429 → 指数退避后重试成功，且计数可读', async () => {
  let calls = 0
  const [restore] = withFetch(() => {
    calls += 1
    if (calls <= 2) return jsonResponse({ detail: 'too many requests' }, 429)
    return jsonResponse({ ok: true })
  })
  try {
    const c = new LingxuClient({
      baseUrl: 'https://rl-backoff.test',
      eventId: 4,
      cookie: 'sessionid=a',
      minIntervalMs: 0,
      maxConcurrent: 1,
      maxRetries: 2,
      backoffBaseMs: 20,
    })
    const started = Date.now()
    const result = await c.request('/event/4/info/')
    const elapsed = Date.now() - started
    assert.deepEqual(result, { ok: true })
    assert.equal(calls, 3, '两次 429 后第三次成功')
    assert.ok(elapsed >= 40, `退避应至少等 20+40ms，实测 ${elapsed}ms`)
    const stats = lingxuRateLimitStats().find((s) => s.host === 'https://rl-backoff.test')
    assert.equal(stats.retries, 2)
    assert.equal(stats.rateLimited, 2)
    assert.equal(stats.sent, 3)
  } finally { restore() }
})

test('退避：平台文案说「请求过于频繁」也重试；超过 maxRetries 才抛', async () => {
  const [restore] = withFetch(() => jsonResponse({ error: '请求过于频繁，请稍后再试' }, 400))
  try {
    const c = new LingxuClient({
      baseUrl: 'https://rl-backoff2.test',
      eventId: 4,
      cookie: 'sessionid=a',
      minIntervalMs: 0,
      maxRetries: 1,
      backoffBaseMs: 5,
    })
    await assert.rejects(() => c.request('/event/4/info/'), /请求过于频繁/)
  } finally { restore() }

  let calls = 0
  const [restore2] = withFetch(() => {
    calls += 1
    return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 400)
  })
  try {
    const c = new LingxuClient({
      baseUrl: 'https://rl-backoff3.test',
      eventId: 4,
      cookie: 'sessionid=a',
      minIntervalMs: 0,
      maxRetries: 1,
      backoffBaseMs: 5,
    })
    await assert.rejects(() => c.request('/event/4/info/'))
    assert.equal(calls, 2, '首次 + 1 次重试')
  } finally { restore2() }
})

test('403「未登录」是会话失效：绝不退避重试，直接抛 session-expired', async () => {
  let calls = 0
  const [restore] = withFetch(() => {
    calls += 1
    return jsonResponse({ detail: '未登录' }, 403)
  })
  try {
    const c = new LingxuClient({
      baseUrl: 'https://rl-session.test',
      eventId: 4,
      cookie: 'sessionid=dead',
      minIntervalMs: 0,
      maxRetries: 3, // 就算允许重试也不能重试会话失效
      backoffBaseMs: 5,
    })
    await assert.rejects(
      () => c.request('/event/4/info/'),
      (error) => {
        assert.equal(error.code, LINGXU_CODES.SESSION_EXPIRED)
        assert.equal(error.httpStatus, 403)
        return true
      },
    )
    assert.equal(calls, 1, '会话失效只发一次请求（重试没有意义）')
    const stats = lingxuRateLimitStats().find((s) => s.host === 'https://rl-session.test')
    assert.equal(stats.sent, 1)
    assert.equal(stats.retries, 0)
  } finally { restore() }
})

test('限流计数通过 lingxuRateLimitStats() 可读（diag 用）', async () => {
  const [restore] = withFetch(async () => {
    await sleepMs(3)
    return jsonResponse({ ok: true })
  })
  try {
    const c = new LingxuClient({
      baseUrl: 'https://rl-stats.test',
      eventId: 4,
      cookie: 'sessionid=a',
      minIntervalMs: 0,
      maxConcurrent: 2,
    })
    await Promise.all([c.request('/a/'), c.request('/b/'), c.request('/c/')])
    const stats = lingxuRateLimitStats()
    const mine = stats.find((s) => s.host === 'https://rl-stats.test')
    assert.ok(mine, 'stats 里应有该 host')
    assert.equal(mine.sent, 3)
    assert.equal(mine.inFlight, 0)
    assert.equal(mine.queued, 0)
    assert.equal(mine.minIntervalMs, 0)
    assert.equal(mine.maxConcurrent, 2)
    assert.ok(mine.peakQueued >= 1, '有排队过')
    assert.equal(typeof mine.waitedMs, 'number')
  } finally { restore() }
})

test('限流器按 host 分桶：不同平台互不影响；set/getLingxuRateLimit 可配', async () => {
  const [restore] = withFetch(() => jsonResponse({ ok: true }))
  try {
    const a = new LingxuClient({ baseUrl: 'https://host-a.test', eventId: 4, cookie: 'sessionid=a', minIntervalMs: 0 })
    const b = new LingxuClient({ baseUrl: 'https://host-b.test', eventId: 4, cookie: 'sessionid=a', minIntervalMs: 0 })
    await Promise.all([a.request('/x/'), b.request('/x/')])
    const stats = lingxuRateLimitStats()
    assert.ok(stats.some((s) => s.host === 'https://host-a.test'))
    assert.ok(stats.some((s) => s.host === 'https://host-b.test'))

    const before = getLingxuRateLimit()
    const applied = setLingxuRateLimit({ minIntervalMs: 7, maxConcurrent: 3 })
    assert.equal(applied.minIntervalMs, 7)
    assert.equal(getLingxuRateLimit().maxConcurrent, 3)
    setLingxuRateLimit({ minIntervalMs: before.minIntervalMs, maxConcurrent: before.maxConcurrent })
  } finally { restore() }
})

test('默认限流参数：生产默认有最小间隔，node:test 下自动放开', () => {
  assert.equal(DEFAULT_RATE_LIMIT.maxConcurrent, 4)
  assert.equal(DEFAULT_RATE_LIMIT.maxRetries, 2)
  // 测试运行器里默认 0（否则 550 个用例每个请求都要干等），生产默认 100ms
  assert.equal(DEFAULT_RATE_LIMIT.minIntervalMs, process.env.NODE_TEST_CONTEXT ? 0 : 100)
  assert.deepEqual(REQUEST_PRIORITIES, ['interactive', 'background'])
})
