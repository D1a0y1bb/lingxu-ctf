/** 凌虚平台客户端：请求、响应归一化、错误分类和按 host 限流。 */

import { AsyncLocalStorage } from 'node:async_hooks'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// ---------------------------------------------------------------- 全局限流

/**
 * 默认限流参数（进程级；可被 `setLingxuRateLimit()` 覆盖）。
 *
 * - `minIntervalMs`：两次请求**发起**之间的最小间隔（100~200ms 是安全区）
 * - `maxConcurrent`：同一 host 同时在途的请求上限（`Promise.all` 打 6 发会被压到 4）
 * - `maxRetries`：仅对 **429 / 请求过于频繁** 重试；403「未登录」是会话失效，绝不重试
 * - `backoffBaseMs`：指数退避基数（500 → 1000 → …）
 *
 * ⚠️ `node:test` 下默认把 `minIntervalMs` 置 0：否则 550 个用例里每个请求都要干等 100ms
 * （单测打的是 mock fetch，节流没有意义）。要验证节流行为时显式传参即可
 * （`new LingxuClient({ ..., minIntervalMs: 30 })` 或 `setLingxuRateLimit({ minIntervalMs: 30 })`）。
 */
const IS_TEST_RUNNER = Boolean(process.env.NODE_TEST_CONTEXT)

export const DEFAULT_RATE_LIMIT = {
  minIntervalMs: IS_TEST_RUNNER ? 0 : 100,
  maxConcurrent: 4,
  maxRetries: 2,
  backoffBaseMs: 500,
}

let rateLimitDefaults = { ...DEFAULT_RATE_LIMIT }

/** 覆盖默认限流参数（返回生效后的值）。传 0 可关闭最小间隔。 */
export function setLingxuRateLimit(patch = {}) {
  rateLimitDefaults = { ...rateLimitDefaults, ...patch }
  for (const limiter of limiters.values()) limiter.configure(rateLimitDefaults)
  return { ...rateLimitDefaults }
}

/** 当前默认限流参数。 */
export function getLingxuRateLimit() {
  return { ...rateLimitDefaults }
}

/** 清空限流器注册表（测试用：让计数/队列回到干净状态）。 */
export function resetLingxuRateLimiters() {
  for (const limiter of limiters.values()) limiter.reset()
  limiters.clear()
}

/**
 * 请求优先级：`interactive`（agent 的解题调用：起环境 / 交 flag / 探活）优先，
 * `background`（面板与视图的轮询）让路。
 */
export const REQUEST_PRIORITIES = ['interactive', 'background']

const priorityStorage = new AsyncLocalStorage()

/**
 * 在指定优先级里跑一段代码（面板轮询用 `withRequestPriority('background', …)`）。
 * `request()` 读取当前 async 上下文里的优先级，默认 `interactive`（agent 的调用天然优先）。
 */
export function withRequestPriority(priority, fn) {
  const normalized = REQUEST_PRIORITIES.includes(priority) ? priority : 'interactive'
  return priorityStorage.run({ priority: normalized }, fn)
}

/** 当前 async 上下文里的请求优先级。 */
export function currentRequestPriority() {
  return priorityStorage.getStore()?.priority || 'interactive'
}

function normalizeHostKey(baseUrl) {
  const text = String(baseUrl || '').trim()
  try {
    const url = new URL(text)
    return `${url.protocol}//${url.host}`
  } catch {
    return text.replace(/\/+$/, '') || 'unknown'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

/**
 * 单 host 限流器：并发上限 + 最小间隔 + 两级优先级队列 + 计数。
 *
 * 放行一个请求前先看 `lastStartAt + minIntervalMs`，没到点就挂**一个** `setTimeout`
 * 到点再放行（同一时刻只有一个定时器，避免定时器风暴）。
 */
class RequestLimiter {
  constructor(host, config = {}) {
    this.host = host
    this.config = { ...rateLimitDefaults, ...config }
    this.reset()
  }

  reset() {
    this.interactive = []
    this.background = []
    this.inFlight = 0
    this.lastStartAt = 0
    this.timer = null
    this.counters = { sent: 0, retries: 0, rateLimited: 0, maxInFlight: 0, peakQueued: 0, waitedMs: 0 }
  }

  configure(patch = {}) {
    this.config = { ...this.config, ...patch }
    this.pump()
  }

  stats() {
    return {
      host: this.host,
      sent: this.counters.sent,
      inFlight: this.inFlight,
      queued: this.interactive.length + this.background.length,
      interactiveQueued: this.interactive.length,
      backgroundQueued: this.background.length,
      maxInFlight: this.counters.maxInFlight,
      peakQueued: this.counters.peakQueued,
      retries: this.counters.retries,
      rateLimited: this.counters.rateLimited,
      waitedMs: this.counters.waitedMs,
      minIntervalMs: this.config.minIntervalMs,
      maxConcurrent: this.config.maxConcurrent,
    }
  }

  /** 排队取一个「可以发请求」的令牌；返回 release 回调（请求结束后必须调用）。 */
  acquire(priority = 'interactive') {
    const normalized = REQUEST_PRIORITIES.includes(priority) ? priority : 'interactive'
    return new Promise((resolve) => {
      const entry = { resolve, queuedAt: Date.now() }
      if (normalized === 'background') this.background.push(entry)
      else this.interactive.push(entry)
      this.#noteQueue()
      this.pump()
    })
  }

  noteRetry() {
    this.counters.retries += 1
  }

  noteRateLimited() {
    this.counters.rateLimited += 1
  }

  #noteQueue() {
    const queued = this.interactive.length + this.background.length
    if (queued > this.counters.peakQueued) this.counters.peakQueued = queued
  }

  #release() {
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.pump()
  }

  /** 派发循环：受 `maxConcurrent` 与 `minIntervalMs` 双重约束。 */
  pump() {
    if (this.timer) return
    if (this.inFlight >= this.config.maxConcurrent) return
    if (!this.interactive.length && !this.background.length) return

    const wait = this.lastStartAt + Number(this.config.minIntervalMs || 0) - Date.now()
    if (wait > 0) {
      this.counters.waitedMs += wait
      this.timer = setTimeout(() => {
        this.timer = null
        this.pump()
      }, wait)
      return
    }

    // interactive 优先；同级 FIFO
    const entry = this.interactive.shift() || this.background.shift()
    if (!entry) return
    this.lastStartAt = Date.now()
    this.inFlight += 1
    this.counters.sent += 1
    if (this.inFlight > this.counters.maxInFlight) this.counters.maxInFlight = this.inFlight
    this.#noteQueue()

    entry.resolve(() => this.#release())
    this.pump() // 继续填满并发（会被 minInterval 自限）
  }
}

const limiters = new Map()

/** 取（或建）该 host 的限流器。 */
export function limiterFor(baseUrl, config = {}) {
  const key = normalizeHostKey(baseUrl)
  let limiter = limiters.get(key)
  if (!limiter) {
    limiter = new RequestLimiter(key, config)
    limiters.set(key, limiter)
  } else if (Object.keys(config).length) {
    limiter.configure({ ...rateLimitDefaults, ...config })
  }
  return limiter
}

/** 所有 host 的限流计数（给 `/lingxu-ctf/diag` 用）。 */
export function lingxuRateLimitStats() {
  return [...limiters.values()].map((limiter) => limiter.stats())
}

/** 是否「请求过于频繁」类错误（需要退避重试）。 */
export function isRateLimitedError(error) {
  if (!error) return false
  if (Number(error.httpStatus) === 429) return true
  if (Number(error.platformStatus) === 429) return true
  const text = `${error.message || ''} ${extractMessage(error.payload)}`
  return /429|too many requests|请求(过于|太)频繁|rate ?limit|throttl/i.test(text)
}

/**
 * 平台业务错误。status 为平台返回的 status 字段（若存在）。
 *
 * `code` 是机器可判别的错误码（见 LINGXU_CODES），调用方按 code 分派文案/行为，
 * 不要靠 message 正则；`payload` 保留平台原始响应体（含 `detail` / `error` 文案）。
 */
export class LingxuError extends Error {
  constructor(message, { httpStatus, platformStatus, path, code, payload, platformMessage } = {}) {
    super(message)
    this.name = 'LingxuError'
    this.httpStatus = httpStatus
    this.platformStatus = platformStatus
    this.path = path
    this.code = code
    this.payload = payload
    /** 平台自己给的文案（用于渲染给用户/模型，避免与我们的包装文案重复）。 */
    this.platformMessage = platformMessage
  }
}

/**
 * 错误码常量：跨模块按它分派，避免文案耦合。
 *
 * 环境相关错误码**逐条对应平台源码**（`event_app/views/env.py` 的 7 条 ValidationError，
 * 以及 `admin_env/utils/docker_api.py` 的 status=3 业务码），文案见 `classifyEnvErrorPayload()`。
 */
export const LINGXU_CODES = {
  /** sessionid 失效（实测 HTTP 403 + {"detail":"未登录"}）。 */
  SESSION_EXPIRED: 'session-expired',
  /** 平台未给该题配置环境（源码：「该题目没有选择对应的环境，请联系管理员。」）。 */
  ENV_NOT_CONFIGURED: 'env-not-configured',
  /** 同上（源码语义名：无环境配置），值与 ENV_NOT_CONFIGURED 相同，任选一个用。 */
  NO_ENV_CONFIG: 'env-not-configured',
  /** 题目没有绑定 CTF 原题（源码：「该题目没有选择对应的CTF题目，请联系管理员。」）。 */
  NO_CTF_BINDING: 'no-ctf-binding',
  /** 赛事未开始（源码：「比赛未开启」/「比赛未开始」）。 */
  CONTEST_NOT_OPEN: 'contest-not-open',
  /** 赛事已结束（源码：「比赛已结束」）。 */
  CONTEST_ENDED: 'contest-ended',
  /** 团队赛未加入战队（源码：「请加入战队」/「您还未加入战队，…」）。 */
  TEAM_REQUIRED: 'team-required',
  /** 赛事未配置 CTF 赛段（源码：「未配置CTF赛段」）。 */
  NO_CTF_STAGE: 'no-ctf-stage',
  /** 环境数超限（源码：f"当前赛事限制启动{env_limit}个题目环境，请释放后启动"）。 */
  ENV_LIMIT: 'env-limit',
  /** 环境正在启动/释放/延时（源码：status=3 +「该环境正在启动/释放/延时」）。 */
  ENV_BUSY: 'env-busy',
  /** 环境不存在或已过期（源码：status=3 +「不存在的环境」/「逻辑错误」）。 */
  ENV_MISSING: 'env-missing',
  /** 答题模式不匹配：对 check 题提交 flag，或对 FLAG 题调 check。 */
  ANSWER_MODE_MISMATCH: 'answer-mode-mismatch',
  /** 容器启动/释放本身失败（源码 docker_api：`{status:3, msg:'启动失败'|'释放失败'}`，实测于 #12）。 */
  ENV_START_FAILED: 'env-start-failed',

  // ---- AWD（源码 event_app/views/awd.py + utils/awd_flag.py）----
  /** 该赛事没有 AWD 赛段（`该赛事没有AWD赛段` / `未配置AWD赛段！`）。 */
  NO_AWD_STAGE: 'no-awd-stage',
  /** 题目没有绑定 AWD 原题（`该题目没有选择对应的AWD题目，请联系管理员。`）。 */
  NO_AWD_BINDING: 'no-awd-binding',
  /** AWD 赛段未开始 / 已结束。 */
  AWD_NOT_OPEN: 'awd-not-open',
  AWD_ENDED: 'awd-ended',
  /** 加固期不允许提交 flag（`加固阶段不允许提交flag！`）。 */
  AWD_REINFORCE: 'awd-reinforce',
  /** 回合开始前 10 秒不允许提交 flag（`回合开始前10秒不允许提交FLAG！`）。 */
  AWD_ROUND_COOLDOWN: 'awd-round-cooldown',
  /** flag 错误 / 提交自己的 flag / 重复提交 / 对方已宕机。 */
  AWD_FLAG_INCORRECT: 'awd-flag-incorrect',
  AWD_SELF_ATTACK: 'awd-self-attack',
  AWD_DUPLICATE: 'awd-duplicate',
  AWD_TARGET_DOWN: 'awd-target-down',
  /** token 缺失或错误（`未找到token！` / `token值错误`）。 */
  AWD_BAD_TOKEN: 'awd-bad-token',
  /** 没有可用的（免费/收费）重置次数。 */
  AWD_NO_RESET_QUOTA: 'awd-no-reset-quota',
  /** 重置被拒：回合结束前 1 分钟 / 剩余分数不足。 */
  AWD_RESET_BLOCKED: 'awd-reset-blocked',
  /** AWD 运行环境未就绪（`未找到运行环境` / `运行环境未启动` / 回合分数据缺失）。 */
  AWD_ENV_UNAVAILABLE: 'awd-env-unavailable',

  // ---- CFS（源码 event_app/views/cfs.py + serializer/cfs.py）----
  /** 该赛事没有 CFS 赛段（源码小写：`该赛事没有cfs赛段`）。 */
  NO_CFS_STAGE: 'no-cfs-stage',
  /** 题目没有绑定 CFS 原题。 */
  NO_CFS_BINDING: 'no-cfs-binding',
  /** CFS 赛段未开始 / 已结束（源码小写 cfs）。 */
  CFS_NOT_OPEN: 'cfs-not-open',
  CFS_ENDED: 'cfs-ended',
  /** 已通关本题 / 已通过本关卡 / flag 错误。 */
  CFS_LEVEL_DONE: 'cfs-level-done',
  CFS_FLAG_INCORRECT: 'cfs-flag-incorrect',

  // ---- 通用 ----
  /** 赛事不允许查看（`该赛事不允许查看` / `此场赛事不允许查看排行榜`）。 */
  EVENT_NOT_VIEWABLE: 'event-not-viewable',
}

/** AWD/CFS 赛段状态文案（源码：1 未开始 / 0 进行中 / 2 已结束）。 */
export const AWD_STATUS_LABELS = { 0: '进行中', 1: '未开始', 2: '已结束' }

/** AWD 回合动态类型（源码 `EventAWDDynamicView` 里给 `log_obj.status` 的取值）。 */
export const AWD_DYNAMIC_STATUS_LABELS = {
  0: '未知',
  1: '攻击',
  2: '被攻击',
  3: '重置',
  4: '自己宕机',
  5: '他人宕机',
}

/** AWD flag 类型（源码 `AWD.FLAG_TYPE_CHOICE`）。 */
export const AWD_FLAG_TYPES = { 1: 'flag文件', 2: 'flag服务器' }

/** CFS 关卡环境类型（源码 `CFSFlag.ENV_TYPE`）。 */
export const CFS_ENV_TYPES = { 1: '环境', 2: '外链', 3: '附件' }

/** `Competition.test_type` 的题型编号（源码注释：1 理论题 / 2 CTF / 3 AWD / 4 CFS）。 */
export const EVENT_TEST_TYPE_LABELS = { 1: '理论题', 2: 'CTF', 3: 'AWD', 4: 'CFS' }

/**
 * `/event/{pk}/type/`（源码 `centre.EventTypeView`）返回值的含义。
 *
 * ⚠️ **源码有坑**：该视图只在 `test_type` 含键 "1"/"2"/"4" 时分别追加 "1"/"2"/**"3"**，
 * 也就是说它的 `"3"` 指的是 **CFS（key 4）**，而 **AWD（key 3）根本不会出现在这个接口里**。
 * 判断有没有 AWD 要看 `test_type` 的键或直接调 `/awd/info/`。别把这个 "3" 当成 AWD。
 */
export const EVENT_TYPE_CODES = { 1: '理论题', 2: 'CTF', 3: 'CFS（注意：不是 AWD）' }

/** 把 `Competition.test_type`（JSONField）归一成 `[{id, name, size}]`。 */
export function normalizeTestTypes(testType) {
  if (!testType || typeof testType !== 'object') return []
  return Object.entries(testType)
    .map(([key, value]) => {
      const id = Number(key)
      const raw = value && typeof value === 'object' ? value : {}
      return {
        id: Number.isFinite(id) ? id : null,
        name: raw.name || EVENT_TEST_TYPE_LABELS[id] || String(key),
        size: Number(raw.size ?? 0),
        rawName: raw.name || '',
      }
    })
    .filter((entry) => entry.id != null)
    .sort((a, b) => a.id - b.id)
}

/** `/event/{pk}/type/` 的返回值 → 中文列表（含源码那个 CFS="3" 的坑）。 */
export function describeEventTypes(list) {
  const rows = Array.isArray(list) ? list : []
  return rows.map((code) => ({ code: String(code), label: EVENT_TYPE_CODES[String(code)] || `未知(${code})` }))
}

const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value])

/**
 * 答题模式不匹配的文案（**源码与线上部署不一致**，两边都收录）：
 * - 源码 `CTFCheckView`：`此题目不为check模式`
 * - 线上实测（2026-09-29）：`此题目为Flag模式，请提交Flag进行得分`
 * - 源码 `EventCTFFlagView`：`此题目为check模式，请点击check进行得分`
 */
const ANSWER_MODE_HINTS = ['此题目不为check模式', '此题目为Flag模式', '请提交Flag进行得分']

/** 响应体是否表示「答题模式不匹配」（check ↔ FLAG 走错端点）。 */
export function classifyAnswerModePayload(payload) {
  const message = extractMessage(payload)
  if (!message) return null
  if (ANSWER_MODE_HINTS.some((hint) => message.includes(hint))) {
    return { code: LINGXU_CODES.ANSWER_MODE_MISMATCH, message }
  }
  if (message.includes('请点击check进行得分')) {
    return { code: LINGXU_CODES.ANSWER_MODE_MISMATCH, message, expect: 'check' }
  }
  return null
}

/** 平台「未配置环境」的固定文案片段（run / release 都返回它）。 */
export const ENV_NOT_CONFIGURED_HINT = '没有选择对应的环境'

/**
 * AWD 错误文案（逐条取自源码）→ 错误码。
 * 顺序有讲究：更具体/更长的文案排在前面（如「该赛事没有AWD赛段」vs「未配置AWD赛段！」）。
 */
const AWD_ERROR_MATCHERS = [
  { code: 'NO_AWD_STAGE', hint: '该赛事没有AWD赛段' },
  { code: 'NO_AWD_STAGE', hint: '未配置AWD赛段' },
  { code: 'NO_AWD_BINDING', hint: '该题目没有选择对应的AWD题目' },
  { code: 'AWD_NOT_OPEN', hint: 'AWD赛段未开始' },
  { code: 'AWD_ENDED', hint: 'AWD赛段已结束' },
  { code: 'AWD_REINFORCE', hint: '加固阶段不允许提交flag' },
  { code: 'AWD_ROUND_COOLDOWN', hint: '回合开始前10秒不允许提交FLAG' },
  { code: 'AWD_SELF_ATTACK', hint: '您不能提交自己题目的Flag' },
  { code: 'AWD_TARGET_DOWN', hint: '对方已被攻陷' },
  { code: 'AWD_TARGET_DOWN', hint: '队伍已经被攻陷' },
  { code: 'AWD_DUPLICATE', hint: '您已经提交过正确的Flag' },
  { code: 'AWD_FLAG_INCORRECT', hint: '您提交的flag错误' },
  { code: 'AWD_BAD_TOKEN', hint: 'token值错误' },
  { code: 'AWD_BAD_TOKEN', hint: '未找到token' },
  { code: 'AWD_BAD_TOKEN', hint: '未找到flag' },
  { code: 'AWD_NO_RESET_QUOTA', hint: '您没有可用的重置次数' },
  { code: 'AWD_NO_RESET_QUOTA', hint: '您没有可用的收费重置次数' },
  { code: 'AWD_RESET_BLOCKED', hint: '回合结束前1分钟不允许重置环境' },
  { code: 'AWD_RESET_BLOCKED', hint: '您剩余的题目分小于重置扣分分数' },
  { code: 'AWD_ENV_UNAVAILABLE', hint: '未找到运行环境' },
  { code: 'AWD_ENV_UNAVAILABLE', hint: '运行环境未启动' },
  { code: 'AWD_ENV_UNAVAILABLE', hint: '未找到您的awd回合分数据' },
  { code: 'AWD_ENV_UNAVAILABLE', hint: '未找到运行环境，请联系管理员' },
  { code: 'EVENT_NOT_VIEWABLE', hint: '该赛事不允许查看' },
  { code: 'EVENT_NOT_VIEWABLE', hint: '不允许查看排行榜' },
]

/** CFS 错误文案（逐条取自源码）→ 错误码。 */
const CFS_ERROR_MATCHERS = [
  { code: 'NO_CFS_STAGE', hint: '该赛事没有cfs赛段' },
  { code: 'NO_CFS_BINDING', hint: '该题目没有选择对应的CFS题目' },
  { code: 'CFS_NOT_OPEN', hint: 'cfs赛段未开始' },
  { code: 'CFS_ENDED', hint: 'cfs赛段已结束' },
  { code: 'CFS_LEVEL_DONE', hint: '您已通关本题目' },
  { code: 'CFS_LEVEL_DONE', hint: '您已通过本关卡' },
  { code: 'CFS_FLAG_INCORRECT', hint: '您提交的flag错误' },
  { code: 'EVENT_NOT_VIEWABLE', hint: '该赛事不允许查看' },
  { code: 'EVENT_NOT_VIEWABLE', hint: '不允许查看排行榜' },
]

function matchBy(payload, matchers) {
  const message = extractMessage(payload)
  if (!message) return null
  for (const matcher of matchers) {
    if (message.includes(matcher.hint)) return { code: LINGXU_CODES[matcher.code], message }
  }
  return null
}

/** 把 AWD 响应体分类成错误码（源码 `views/awd.py` + `utils/awd_flag.py` 原文案）。 */
export function classifyAwdErrorPayload(payload) {
  return matchBy(payload, AWD_ERROR_MATCHERS)
}

/** 把 CFS 响应体分类成错误码（源码 `views/cfs.py` 原文案）。 */
export function classifyCfsErrorPayload(payload) {
  return matchBy(payload, CFS_ERROR_MATCHERS)
}

/** 环境 / AWD / CFS 三类错误统一分类（先环境，再 AWD，最后 CFS）。 */
export function classifyStageErrorPayload(payload) {
  return classifyEnvErrorPayload(payload) || classifyAwdErrorPayload(payload) || classifyCfsErrorPayload(payload)
}

/** 平台「未登录」的标记文案（sessionid 失效；403 为主，200 也一并识别）。 */
export const NOT_LOGGED_IN_HINT = '未登录'

/** 环境相关错误码 → 源码文案（按顺序匹配，长的在前，避免误命中）。 */
const ENV_ERROR_MATCHERS = [
  { code: 'NO_CTF_BINDING', hint: '该题目没有选择对应的CTF题目' },
  { code: 'ENV_NOT_CONFIGURED', hint: ENV_NOT_CONFIGURED_HINT },
  { code: 'NO_CTF_STAGE', hint: '未配置CTF赛段' },
  { code: 'CONTEST_NOT_OPEN', hint: '比赛未开启' },
  { code: 'CONTEST_NOT_OPEN', hint: '比赛未开始' },
  { code: 'CONTEST_ENDED', hint: '比赛已结束' },
  { code: 'TEAM_REQUIRED', hint: '请加入战队' },
  { code: 'TEAM_REQUIRED', hint: '还未加入战队' },
]

/**
 * 把平台响应体分类成环境相关错误码。
 *
 * 依据 `event_app/views/env.py`（EnvRunView / EnvReleaseView / EnvDelayedView）与
 * `admin_env/utils/docker_api.py` 的原文案；**未识别时返回 null**（调用方按普通错误处理）。
 *
 * @returns {{ code: string, message: string, envLimit?: number } | null}
 */
export function classifyEnvErrorPayload(payload) {
  const message = extractMessage(payload)
  if (!message) return null
  // 「当前赛事限制启动2个题目环境，请释放后启动」→ 解析出 env_limit
  const limitMatch = /限制启动\s*(\d+)\s*个题目环境/.exec(message)
  if (limitMatch) {
    return { code: LINGXU_CODES.ENV_LIMIT, message, envLimit: Number(limitMatch[1]) }
  }
  // 兜底：某些平台版本的文案可能只剩后半句「请释放后启动」，同样属于环境数超限
  if (message.includes('请释放后启动')) {
    return { code: LINGXU_CODES.ENV_LIMIT, message }
  }
  for (const matcher of ENV_ERROR_MATCHERS) {
    if (message.includes(matcher.hint)) return { code: LINGXU_CODES[matcher.code], message }
  }
  return null
}

/** 判定响应体是否为「环境正在启动/释放/延时」（业务 status=3 的占位提示）。 */
export function isEnvBusyPayload(payload) {
  const message = extractMessage(payload)
  return /该环境正在(启动|释放|延时)/.test(message)
}

/** 判定响应体是否为「环境不存在 / 已过期」（status=3）。 */
export function isEnvMissingPayload(payload) {
  const message = extractMessage(payload)
  return message.includes('不存在的环境') || message.includes('逻辑错误')
}

/** 平台响应体是否表示「未登录」（sessionid 失效）。 */
export function isSessionExpiredPayload(payload) {
  if (payload == null) return false
  if (typeof payload === 'object') {
    const detail = payload.detail
    const texts = Array.isArray(detail) ? detail.map((v) => String(v)) : [String(detail ?? '')]
    if (texts.some((text) => text.includes(NOT_LOGGED_IN_HINT))) return true
    return extractMessage(payload).includes(NOT_LOGGED_IN_HINT)
  }
  return String(payload).includes(NOT_LOGGED_IN_HINT)
}

/** 平台响应体是否表示「该题没有配置环境」。 */
export function isEnvNotConfiguredPayload(payload) {
  if (payload == null) return false
  if (typeof payload === 'object') {
    const error = payload.error
    if (typeof error === 'string' && error.includes(ENV_NOT_CONFIGURED_HINT)) return true
    return extractMessage(payload).includes(ENV_NOT_CONFIGURED_HINT)
  }
  return String(payload).includes(ENV_NOT_CONFIGURED_HINT)
}

/**
 * 判定「sessionid 已失效」错误。优先看 code；跨模块被重新包装（丢 code）时回退到文案，
 * 保证「403 + {"detail":"未登录"}」一定能被识别。
 */
export function isSessionExpired(error) {
  if (!error) return false
  if (error.code === LINGXU_CODES.SESSION_EXPIRED) return true
  if (isSessionExpiredPayload(error.payload)) return true
  return String(error.message || '').includes(NOT_LOGGED_IN_HINT)
}

/** 判定「平台未为该题配置环境」错误（同上：code 优先，文案兜底）。 */
export function isEnvNotConfigured(error) {
  if (!error) return false
  if (error.code === LINGXU_CODES.ENV_NOT_CONFIGURED) return true
  if (isEnvNotConfiguredPayload(error.payload)) return true
  return String(error.message || '').includes(ENV_NOT_CONFIGURED_HINT)
}

/** 判定任意环境相关错误码（env-limit / contest-not-open / team-required / …）。 */
export function isEnvError(error) {
  if (!error) return false
  const envCodes = new Set([
    LINGXU_CODES.ENV_NOT_CONFIGURED,
    LINGXU_CODES.NO_CTF_BINDING,
    LINGXU_CODES.CONTEST_NOT_OPEN,
    LINGXU_CODES.CONTEST_ENDED,
    LINGXU_CODES.TEAM_REQUIRED,
    LINGXU_CODES.NO_CTF_STAGE,
    LINGXU_CODES.ENV_LIMIT,
    LINGXU_CODES.ENV_BUSY,
    LINGXU_CODES.ENV_MISSING,
    LINGXU_CODES.ENV_START_FAILED,
  ])
  if (error.code && envCodes.has(error.code)) return true
  return Boolean(classifyEnvErrorPayload(error.payload) || classifyEnvErrorPayload(error.message))
}

/**
 * 构造一个「环境相关」的 LingxuError：带 code / platformMessage / envLimit，
 * message 形如 `该题在平台上没有配置环境：<平台原文案>`，便于上层按 code 分派文案。
 */
function envError(payload, fallbackPath, { prefix, httpStatus, platformStatus } = {}) {
  const classified = classifyEnvErrorPayload(payload)
  const message = classified?.message || extractMessage(payload) || '环境操作失败'
  const code = classified?.code || 'env-error'
  const head =
    prefix ||
    {
      [LINGXU_CODES.ENV_NOT_CONFIGURED]: '该题在平台上没有配置环境',
      [LINGXU_CODES.NO_CTF_BINDING]: '该题在平台上没有绑定 CTF 原题',
      [LINGXU_CODES.CONTEST_NOT_OPEN]: '比赛未开启',
      [LINGXU_CODES.CONTEST_ENDED]: '比赛已结束',
      [LINGXU_CODES.TEAM_REQUIRED]: '团队赛需要先加入战队',
      [LINGXU_CODES.NO_CTF_STAGE]: '该赛事未配置 CTF 赛段',
      [LINGXU_CODES.ENV_LIMIT]: `环境数已达上限（${classified?.envLimit ?? '?'} 个）`,
      [LINGXU_CODES.ENV_START_FAILED]: '容器启动/释放失败',
    }[code] ||
    '环境操作失败'
  const error = new LingxuError(`${head}：${message}`, {
    code,
    path: fallbackPath,
    platformMessage: message,
    payload,
    httpStatus,
    platformStatus,
  })
  if (classified?.envLimit != null) error.envLimit = classified.envLimit
  return error
}

/** 错误码 → 人类可读前缀（AWD/CFS 用）。 */
const STAGE_ERROR_HEADS = {
  [LINGXU_CODES.NO_AWD_STAGE]: '该赛事没有 AWD 赛段',
  [LINGXU_CODES.NO_AWD_BINDING]: '该题没有绑定 AWD 原题',
  [LINGXU_CODES.AWD_NOT_OPEN]: 'AWD 赛段未开始',
  [LINGXU_CODES.AWD_ENDED]: 'AWD 赛段已结束',
  [LINGXU_CODES.AWD_REINFORCE]: '加固期内不允许提交 flag',
  [LINGXU_CODES.AWD_ROUND_COOLDOWN]: '回合开始前 10 秒不允许提交 flag',
  [LINGXU_CODES.AWD_FLAG_INCORRECT]: 'AWD flag 错误',
  [LINGXU_CODES.AWD_SELF_ATTACK]: '不能提交自己题目的 flag',
  [LINGXU_CODES.AWD_DUPLICATE]: '本回合已提交过正确的 flag',
  [LINGXU_CODES.AWD_TARGET_DOWN]: '对方已被攻陷',
  [LINGXU_CODES.AWD_BAD_TOKEN]: 'AWD token 缺失或错误',
  [LINGXU_CODES.AWD_NO_RESET_QUOTA]: '没有可用的重置次数',
  [LINGXU_CODES.AWD_RESET_BLOCKED]: '当前不允许重置靶机',
  [LINGXU_CODES.AWD_ENV_UNAVAILABLE]: 'AWD 运行环境未就绪',
  [LINGXU_CODES.NO_CFS_STAGE]: '该赛事没有 CFS 赛段',
  [LINGXU_CODES.NO_CFS_BINDING]: '该题没有绑定 CFS 原题',
  [LINGXU_CODES.CFS_NOT_OPEN]: 'CFS 赛段未开始',
  [LINGXU_CODES.CFS_ENDED]: 'CFS 赛段已结束',
  [LINGXU_CODES.CFS_LEVEL_DONE]: '该关卡/题目已通关',
  [LINGXU_CODES.CFS_FLAG_INCORRECT]: 'CFS flag 错误',
  [LINGXU_CODES.EVENT_NOT_VIEWABLE]: '该赛事不允许查看',
}

/** 是否已分类过的 AWD/CFS 错误码。 */
export function isAwdCfsErrorCode(code) {
  return Boolean(code && STAGE_ERROR_HEADS[code] !== undefined)
}

/**
 * 从 stage 名字推断「哪一 famille 的请求」（`cfs-flag` → cfs，`awd-info` → awd）。
 *
 * 必要性：**「您提交的flag错误！」在 AWD 和 CFS 源码里字面相同**，
 * 不区分来源就会把 CFS 的错误标成 `awd-flag-incorrect`。
 */
function stageFamilyOf(stage) {
  const text = String(stage || '')
  if (text.startsWith('cfs')) return 'cfs'
  if (text.startsWith('awd')) return 'awd'
  return ''
}

/** 按请求来源家族优先匹配，再退回另一家族。 */
function classifyForFamily(payload, family) {
  if (family === 'cfs') return classifyCfsErrorPayload(payload) || classifyAwdErrorPayload(payload)
  if (family === 'awd') return classifyAwdErrorPayload(payload) || classifyCfsErrorPayload(payload)
  return classifyStageErrorPayload(payload)
}

/**
 * 判定任意 AWD/CFS 错误（code 优先，文案兜底）。
 * @param {Error} error
 * @param {'awd'|'cfs'|''} [family] 请求来源（可省略）
 */
export function isStageError(error, family = '') {
  if (!error) return false
  if (isAwdCfsErrorCode(error.code)) return true
  return Boolean(classifyForFamily(error.payload, family) || classifyForFamily(error.message, family))
}

/** 构造一个 AWD/CFS 的 LingxuError（带 code / platformMessage / httpStatus）。 */
function stageError(payload, fallbackPath, { httpStatus, platformStatus, family } = {}) {
  const classified = classifyForFamily(payload, family)
  const message = classified?.message || extractMessage(payload) || '赛段操作失败'
  const code = classified?.code || 'stage-error'
  const head = STAGE_ERROR_HEADS[code] || '赛段操作失败'
  return new LingxuError(`${head}：${message}`, {
    code,
    path: fallbackPath,
    platformMessage: message,
    payload,
    httpStatus,
    platformStatus,
  })
}

// ---------------------------------------------------------------- 平台 choices（源码 event_app/models.py）

/** `CTF.test_type`：题目类型。 */
export const CTF_TASK_TYPES = { 1: '环境型', 2: '外链型', 3: '附件型' }
/** `CTF.flag_type`：flag 类型（2=动态 flag，需 flag_script；仅在 test_type=1 时生效）。 */
export const CTF_FLAG_TYPES = { 1: '静态flag', 2: '动态flag' }
/** `CTF.answer_mode`：答题模式（2=check，走 `/check/`）。 */
export const CTF_ANSWER_MODES = { 1: 'FLAG', 2: 'check' }
/** `CTF.shared`：环境共享方式（默认 3 全员共享）。 */
export const CTF_SHARED_MODES = { 1: '独享', 2: '团队内共享', 3: '全员共享' }
/** `CTF.property`：题目属性（默认 2 私有）。 */
export const CTF_PROPERTIES = { 1: '公开', 2: '私有' }
/** `CompetitionCTFs.score_mode`：计分模式。 */
export const CTF_SCORE_MODES = { 1: '固定计分', 2: '动态计分' }
/** `Competition.test_type` 里的题型编号（JSONField 的键）。 */
export const EVENT_TEST_TYPES = { 1: '理论题', 2: '实操题' }

const labelOf = (map, value) => map[Number(value)] || ''

/** `task_type` → 「环境型」/「外链型」/「附件型」（未知返回空串）。 */
export const ctfTaskTypeLabel = (value) => labelOf(CTF_TASK_TYPES, value)
/** `flag_type` → 「静态flag」/「动态flag」。 */
export const ctfFlagTypeLabel = (value) => labelOf(CTF_FLAG_TYPES, value)
/** `answer_mode` → 「FLAG」/「check」。 */
export const ctfAnswerModeLabel = (value) => labelOf(CTF_ANSWER_MODES, value)
/** `shared` → 「独享」/「团队内共享」/「全员共享」。 */
export const ctfSharedLabel = (value) => labelOf(CTF_SHARED_MODES, value)
/** `property` → 「公开」/「私有」。 */
export const ctfPropertyLabel = (value) => labelOf(CTF_PROPERTIES, value)
/** `score_mode` → 「固定计分」/「动态计分」。 */
export const ctfScoreModeLabel = (value) => labelOf(CTF_SCORE_MODES, value)

/**
 * 解析时间戳（平台返回的 Django DateTimeField 序列化结果，可能是 ISO 串或 null）。
 * 解析不出来返回 null（不抛）。
 */
export function parsePlatformTime(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const text = String(value).trim()
  if (!text) return null
  const ms = Date.parse(text)
  if (Number.isFinite(ms)) return new Date(ms)
  // Django 有时给 "2026-09-29 10:00:00"（无 T / 无时区）
  const normalized = Date.parse(text.replace(' ', 'T'))
  return Number.isFinite(normalized) ? new Date(normalized) : null
}

/**
 * 计算环境剩余秒数，**优先用平台算好的 `end_second`**（源码 `Env_RunSerializer.get_end_second`：
 * `int((release_time - now()).total_seconds())`，小于 0 归零），否则用 `release_time` 现算。
 *
 * @param {object} payload addr 响应（`{end_second, release_time, ...}`）
 * @param {number} [nowMs] 便于测试注入
 * @returns {number|null} 剩余秒数；两个字段都没有时返回 null
 */
export function envRemainingSeconds(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return null
  const endSecond = Number(payload.end_second)
  if (Number.isFinite(endSecond)) return Math.max(0, Math.trunc(endSecond))
  const release = parsePlatformTime(payload.release_time)
  if (!release) return null
  return Math.max(0, Math.round((release.getTime() - nowMs) / 1000))
}

/** 解析 Cookie 字符串为 map。 */
export function parseCookie(cookie) {
  const map = {}
  for (const part of String(cookie || '').split(';')) {
    const entry = part.trim()
    if (!entry || !entry.includes('=')) continue
    const idx = entry.indexOf('=')
    map[entry.slice(0, idx).trim()] = entry.slice(idx + 1).trim()
  }
  return map
}

/** 脱敏：日志/展示用，永不输出完整 cookie。 */
export function maskSecret(value) {
  const text = String(value ?? '')
  if (!text) return ''
  if (text.length <= 8) return '*'.repeat(text.length)
  return `${text.slice(0, 6)}…${text.slice(-2)} (len=${text.length})`
}

/** HTML → Markdown 的轻量转换（不引入 markdownify 依赖）。 */
export function htmlToMarkdown(html) {
  let text = String(html ?? '')
  if (!text) return ''
  if (!/<[a-z!/][^>]*>/i.test(text)) return text.trim()

  text = text.replace(/<\s*br\s*\/?>/gi, '\n')
  text = text.replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
  text = text.replace(/<\s*li[^>]*>/gi, '- ')
  text = text.replace(/<\s*h([1-6])[^>]*>/gi, (_m, n) => `${'#'.repeat(Number(n))} `)
  text = text.replace(/<\s*(b|strong)[^>]*>/gi, '**').replace(/<\s*\/\s*(b|strong)\s*>/gi, '**')
  text = text.replace(/<\s*(i|em)[^>]*>/gi, '*').replace(/<\s*\/\s*(i|em)\s*>/gi, '*')
  text = text.replace(/<\s*code[^>]*>/gi, '`').replace(/<\s*\/\s*code\s*>/gi, '`')
  text = text.replace(/<\s*pre[^>]*>/gi, '\n```\n').replace(/<\s*\/\s*pre\s*>/gi, '\n```\n')
  // 图片/链接：保留 href/src 供 agent 下载附件
  text = text.replace(/<\s*a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi, '[$2]($1)')
  text = text.replace(/<\s*img[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi, '![]($1)')
  text = text.replace(/<[^>]+>/g, '')
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 把平台返回的连接信息规范化成 agent 可用的形式。 */
export function normalizeConnectionTarget(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return text
  if (/^nc\s+/i.test(text)) return text
  const hostPort = /^([^:\s/]+):(\d+)$/.exec(text)
  if (hostPort) return `nc ${hostPort[1]} ${hostPort[2]}`
  return text
}

function connectionHost(target) {
  const text = String(target || '').trim()
  if (!text) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
    try {
      return new URL(text).hostname
    } catch {
      return ''
    }
  }
  if (/^nc\s+/i.test(text)) {
    const parts = text.split(/\s+/)
    return parts.length >= 3 ? parts[1] : ''
  }
  const hostPort = /^([^:\s/]+):(\d+)$/.exec(text)
  return hostPort ? hostPort[1] : ''
}

function isPrivateHost(host) {
  if (!host) return false
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** 从 addr 载荷提取连接信息，优先公网地址。 */
export function formatConnectionInfo(payload) {
  const lines = []
  const add = (v) => {
    const n = normalizeConnectionTarget(v)
    if (n && !lines.includes(n)) lines.push(n)
  }

  if (payload && typeof payload === 'object') {
    add(payload.domain_addr)
    const ext = payload.ext_id
    if (typeof ext === 'string') add(ext)
    else if (Array.isArray(ext)) {
      for (const entry of ext) {
        if (entry && typeof entry === 'object') {
          for (const key of ['map_ip', 'ext_ip', 'ip']) {
            if (entry[key]) {
              add(entry[key])
              break
            }
          }
        } else add(entry)
      }
    } else if (ext != null) add(ext)
  } else if (payload != null) {
    add(payload)
  }

  const publicLines = lines.filter((l) => !isPrivateHost(connectionHost(l)))
  const chosen = publicLines.length ? publicLines : lines
  return { targets: chosen, hasPrivateOnly: publicLines.length === 0 && lines.length > 0 }
}

const SOLVED_HINTS = ['已提交了正确的Flag', '已经提交', 'correct']

/** 题型标签（平台 option_type：1 单选 / 2 多选 / 3 判断 / 4 填空）。 */
const THEORY_OPTION_TYPE_LABELS = { 1: '单选', 2: '多选', 3: '判断', 4: '填空' }

/** option_type → 中文标签（未知返回空串）。 */
export function theoryOptionTypeLabel(optionType) {
  return THEORY_OPTION_TYPE_LABELS[Number(optionType)] || ''
}

/**
 * 试卷状态判定，顺序与平台前端一致：
 * `is_parse`(已交卷) > `is_begin`(进行中) > `is_end`(比赛已结束、未交卷) >
 * `start_time` 有值(已开始未交卷) > 未开始。
 *
 * ⚠️ 交卷后平台会把 `is_begin` 变回 false，只看 is_begin 会误判成「未开始」。
 * ⚠️ `is_end` 是「比赛已结束」（前端文案），**不是**「已交卷」，所以排在 is_parse 之后。
 */
export function theoryTestStatus(test) {
  if (test?.isParse) return { key: 'submitted', label: '已交卷' }
  if (test?.isBegin) return { key: 'running', label: '进行中' }
  if (test?.isEnd) return { key: 'ended', label: '已结束（未交卷）' }
  if (test?.startTime) return { key: 'started', label: '已开始未交卷' }
  return { key: 'not-started', label: '未开始' }
}

/** 把平台字段（数组 / 字符串 / null）归一成字符串数组，保持顺序。 */
export function normalizeOptionArray(value) {
  if (value == null) return []
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  const text = String(value).trim()
  if (!text) return []
  if (/[\n,，、;；|]/.test(text)) {
    return text
      .split(/[\n,，、;；|]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return [text]
}

/**
 * 归一化作答选项为平台需要的**数组**。
 *
 * 平台前端：`4 === option_type ? m.option = answer : m.option = answer.sort()`。
 * - 数组：原样（去掉空值）；
 * - 字符串：`'BCD'` → `['B','C','D']`；`'B,C'` → `['B','C']`；`'答案一'` → `['答案一']`；
 * - 非填空题按键位排序（与前端 `.sort()` 一致）；
 * - 填空题（option_type=4）按空位顺序保留，**不排序**；
 * - 不知道题型时，仅当所有值都是单个字母（选项键位）才排序，避免打乱填空题空位顺序。
 */
export function normalizeTheoryOption(option, { optionType } = {}) {
  let values
  if (Array.isArray(option)) {
    values = normalizeOptionArray(option)
  } else {
    const text = String(option ?? '').trim()
    if (!text) return []
    if (/[\n,，、;；|]/.test(text)) values = normalizeOptionArray(text)
    // 纯字母串按「选项键位」拆：'BCD' → ['B','C','D']（单选 'B' 保持单元素）
    else if (text.length > 1 && /^[A-Za-z]+$/.test(text)) values = text.split('')
    else values = [text]
  }
  if (values.length < 2) return values
  const type = Number(optionType)
  if (type === 4) return values
  if (type >= 1) return [...values].sort()
  return values.every((v) => /^[A-Za-z]$/.test(v)) ? [...values].sort() : values
}

export class LingxuClient {
  /**
   * @param {{ baseUrl: string, eventId: number|string, cookie: string, timeoutMs?: number }} options
   */
  constructor({ baseUrl, eventId, cookie, timeoutMs = 30000, minIntervalMs, maxConcurrent, maxRetries, backoffBaseMs } = {}) {
    if (!baseUrl) throw new LingxuError('缺少平台地址 baseUrl')
    if (!eventId) throw new LingxuError('缺少赛事 ID eventId')
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.eventId = Number(eventId)
    this.cookie = String(cookie || '')
    this.timeoutMs = timeoutMs
    /** 该 client 的限流参数覆盖（不传则跟随 `DEFAULT_RATE_LIMIT` / `setLingxuRateLimit()`）。 */
    this.rateLimit = Object.fromEntries(
      Object.entries({ minIntervalMs, maxConcurrent, maxRetries, backoffBaseMs }).filter(([, v]) => v != null),
    )
  }

  /** 本 client 使用的限流器（按 host 全局共享）。 */
  get limiter() {
    return limiterFor(this.baseUrl, this.rateLimit)
  }

  get cookieMap() {
    return parseCookie(this.cookie)
  }

  get hasSessionId() {
    return Boolean(this.cookieMap.sessionid)
  }

  url(path) {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  headers(extra = {}) {
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...extra,
    }
    if (this.cookie) headers.Cookie = this.cookie
    return headers
  }

  writeHeaders() {
    const headers = this.headers({ 'X-Requested-With': 'XMLHttpRequest' })
    const csrf = this.cookieMap.csrftoken
    if (csrf) headers['X-CSRFToken'] = csrf
    return headers
  }

  /**
   * 发一次平台请求（所有出站请求的唯一入口）。
   *
   * 全局限流和退避：
   * - 先过限流器（最小间隔 + 并发上限 + 优先级：`interactive` > `background`）；
   * - **429 / 请求过于频繁** → 指数退避重试（默认最多 2 次，500ms → 1000ms）；
   * - **403「未登录」是会话失效**，不退避、不重试，直接抛 `session-expired`（见下）。
   *
   * @param {string} path
   * @param {{ method?: string, body?: any, raw?: boolean, expectJson?: boolean,
   *          priority?: 'interactive'|'background' }} [options]
   */
  async request(path, { method = 'GET', body, raw = false, expectJson = true, priority } = {}) {
    const limiter = this.limiter
    const effectivePriority = priority || currentRequestPriority()
    const maxRetries = Math.max(0, Number(limiter.config.maxRetries ?? 0))
    let attempt = 0
    for (;;) {
      const release = await limiter.acquire(effectivePriority)
      let backoffMs = 0
      try {
        return await this.#attempt(path, { method, body, raw, expectJson })
      } catch (error) {
        if (!isRateLimitedError(error) || attempt >= maxRetries) throw error
        attempt += 1
        limiter.noteRetry()
        limiter.noteRateLimited()
        backoffMs = Number(limiter.config.backoffBaseMs || 500) * 2 ** (attempt - 1)
      } finally {
        release()
      }
      // 退避在**释放槽位之后**做，避免占着并发名额干等
      await sleep(backoffMs)
    }
  }

  /** 单次尝试：建连 + 超时 + 解析 + 状态判定（不重试）。 */
  async #attempt(path, { method = 'GET', body, raw = false, expectJson = true } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response
    try {
      const init = {
        method,
        headers: method === 'GET' ? this.headers() : this.writeHeaders(),
        redirect: 'follow',
        signal: controller.signal,
      }
      if (body != null) {
        if (body instanceof URLSearchParams) {
          init.body = body
          init.headers = { ...init.headers, 'Content-Type': 'application/x-www-form-urlencoded' }
        } else if (typeof body === 'string') {
          init.body = body
        } else {
          init.body = JSON.stringify(body)
          init.headers = { ...init.headers, 'Content-Type': 'application/json' }
        }
      }
      response = await fetch(this.url(path), init)
    } catch (error) {
      clearTimeout(timer)
      const reason = error?.name === 'AbortError' ? `请求超时（${this.timeoutMs}ms）` : error?.message || String(error)
      throw new LingxuError(`凌虚请求失败 ${path}: ${reason}`, { path })
    }
    clearTimeout(timer)

    if (raw) return response

    const text = await response.text()
    let payload = text
    if (expectJson) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }

    // sessionid 失效：实测 HTTP 403 + {"detail":"未登录"}（不是 401）；少数接口 200 带 detail，一并识别。
    if (isSessionExpiredPayload(payload)) {
      throw new LingxuError(
        `凌虚 ${method} ${path} 未登录（HTTP ${response.status}）：${extractMessage(payload) || NOT_LOGGED_IN_HINT}`,
        {
          httpStatus: response.status,
          path,
          code: LINGXU_CODES.SESSION_EXPIRED,
          payload,
          platformMessage: extractMessage(payload),
        },
      )
    }

    if (response.status >= 400) {
      // 平台把具体原因放在响应体里（如 error/detail），必须带出来，不能只报 HTTP 状态码。
      const detail = extractMessage(payload)
      throw new LingxuError(
        `凌虚 ${method} ${path} HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`,
        { httpStatus: response.status, path, payload },
      )
    }
    return payload
  }

  /** 分页遍历：返回全部 results。 */
  async requestAll(path, { pageSize = 100, maxPages = 50 } = {}) {
    const out = []
    let page = 1
    while (page <= maxPages) {
      const sep = path.includes('?') ? '&' : '?'
      const payload = await this.request(`${path}${sep}page=${page}&size=${pageSize}`)
      if (Array.isArray(payload)) {
        out.push(...payload)
        break
      }
      const rows = Array.isArray(payload?.results) ? payload.results : []
      out.push(...rows)
      if (!payload?.next || rows.length === 0) break
      page += 1
    }
    return out
  }

  // ---------------------------------------------------------------- 赛事

  /** 校验凭据可用性。 */
  async validateAccess() {
    if (!this.hasSessionId) {
      throw new LingxuError('Cookie 中缺少 sessionid，请从浏览器复制完整 Cookie')
    }
    const info = await this.request(`/event/${this.eventId}/info/`)
    return info
  }

  async eventDetail() {
    return this.request(`/event/${this.eventId}/`)
  }

  async eventInfo() {
    return this.request(`/event/${this.eventId}/info/`)
  }

  async notices() {
    return this.requestAll(`/event/${this.eventId}/notice/`)
  }

  /** 未读公告数（`GET /event/{pk}/notice/count/` → `{count}`，源码 `EventNoticeCountView`）。 */
  async noticeCount() {
    const payload = await this.request(`/event/${this.eventId}/notice/count/`)
    return { count: Number(payload?.count ?? 0), raw: payload }
  }

  /**
   * 得分总势（`GET /event/{pk}/chart/?type=`，源码 `EventChartView`）。
   *
   * ⚠️ 源码里 `type` **默认 "1"（理论题）且直接返回 `[]`**；只有 `type=2`（CTF）才返回走势：
   * `{ start_time, end_time, data: [{ id, name, data: [[timestamp, score], ...] }, ...] }`（前 10 名）。
   * 因此这里**默认 type=2**（默认 1 只会拿到空数组，没有意义）。
   * `show_rank=false` 时平台返回 400 `{"error":"此场赛事不允许查看排行榜"}`。
   */
  async eventChart({ type = 2 } = {}) {
    const payload = await this.request(`/event/${this.eventId}/chart/?type=${encodeURIComponent(type)}`)
    if (Array.isArray(payload)) return { type: Number(type), startTime: null, endTime: null, series: [], raw: payload }
    const rows = Array.isArray(payload?.data) ? payload.data : []
    return {
      type: Number(type),
      startTime: payload?.start_time != null ? Number(payload.start_time) : null,
      endTime: payload?.end_time != null ? Number(payload.end_time) : null,
      series: rows.map((row) => ({
        id: row?.id,
        name: row?.name ?? '',
        points: Array.isArray(row?.data) ? row.data : [],
      })),
      raw: payload,
    }
  }

  /**
   * 处罚警告（`GET /event/{pk}/punish/?type=`，源码 `EventPunishView`，分页）。
   * 返回行字段：`id, user_list[], issue_time, content, type, score`。
   * `Competition.punish=false` 时平台直接返回空列表（200）。
   */
  async eventPunish({ type } = {}) {
    const query = type == null ? '' : `?type=${encodeURIComponent(type)}`
    const rows = await this.requestAll(`/event/${this.eventId}/punish/${query}`)
    return rows.map((row) => ({
      id: row?.id,
      users: Array.isArray(row?.user_list) ? row.user_list : [],
      issueTime: row?.issue_time ?? '',
      content: row?.content ?? '',
      type: row?.type,
      score: row?.score != null ? Number(row.score) : null,
    }))
  }

  /**
   * CTF 倒计时（`GET /event/{pk}/ctf/time/`，源码 `EventCTFTimeView`）。
   * 返回 `{status, startSeconds, endSeconds}`：
   * `status` 0=进行中 / 1=未开始 / 2=已结束（源码里 3 是兜底值，正常不会出现）。
   * 未配置 CTF 赛段 → 400 `{"error":"未配置CTF赛段"}`。
   */
  async ctfTime() {
    const payload = await this.request(`/event/${this.eventId}/ctf/time/`)
    const status = Number(payload?.status)
    const labels = { 0: '进行中', 1: '未开始', 2: '已结束' }
    return {
      status,
      statusLabel: labels[status] || '未知',
      startSeconds: Number(payload?.start_seconds ?? 0),
      endSeconds: Number(payload?.end_seconds ?? 0),
      raw: payload,
    }
  }

  /**
   * CTF 题目名称列表（`GET /event/{pk}/ctf/name/`，源码 `CTFNameListView`）。
   * 返回 `[{ id, name }]`（赛事内题名，按 show_order/id 排序；未开始赛事可能为空数组）。
   */
  async ctfNames() {
    const payload = await this.request(`/event/${this.eventId}/ctf/name/`)
    const rows = Array.isArray(payload) ? payload : []
    return rows.map((row) => ({ id: row?.id, name: row?.name ?? '' }))
  }

  async submitLogs({ type = 1, testType = 2 } = {}) {
    return this.requestAll(`/event/${this.eventId}/log/?type=${type}&test_type=${testType}`)
  }

  /**
   * 赛事类型（`GET /event/{pk}/type/`，源码 `centre.EventTypeView`）。
   *
   * ⚠️ **源码有坑**（已核对 `EventTypeView`）：返回值是字符串数组，但语义是
   * `"1"`=理论题、`"2"`=CTF、**`"3"`=CFS（test_type 的键 "4"）**；
   * **AWD（键 "3"）根本不出现在这个接口里**。别把 `"3"` 当成 AWD ——
   * 判断有没有 AWD 请用 `eventSummary().testTypes`（键 3）或直接调 `awdRoundInfo()`。
   */
  async eventType() {
    const payload = await this.request(`/event/${this.eventId}/type/`)
    const codes = (Array.isArray(payload) ? payload : []).map((code) => String(code))
    return { codes, labels: describeEventTypes(codes), raw: payload }
  }

  // ---------------------------------------------------------------- 题目

  /** 题目列表（自动翻页）。 */
  /**
   * 题目列表（`GET /event/{pk}/ctf/`，自动翻页）。
   * 行形状见 `CompetitionCTFSerializer.Meta.fields`：
   * `id, name, classify, score, ctf_id, test_list, is_parse, parse_count, is_begin, msg`。
   * 注意 `name`/`score` 是**赛事内**的覆盖值（`CompetitionCTF`），不是原题的值。
   */
  async challenges() {
    const rows = await this.requestAll(`/event/${this.eventId}/ctf/`)
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.classify || row.category || '',
      score: Number(row.score ?? 0),
      ctfId: row.ctf_id,
      solved: Boolean(row.is_parse),
      parseCount: Number(row.parse_count ?? 0),
      begun: Boolean(row.is_begin),
      messages: Array.isArray(row.msg) ? row.msg : [],
      /** 前三名解题榜（源码 `CompetitionCTF.test_list`，show_mode=2 时是编号）。 */
      testList: row.test_list && typeof row.test_list === 'object' ? row.test_list : {},
    }))
  }

  /**
   * 题目详情（`GET /event/{pk}/ctf/{tpk}/info/`）。
   *
   * ⚠️ 返回形状以平台源码 `event_app/views/test.py::EventCTFInfoView` 为准，**只有**：
   * `name`, `desc`, `vuln_id`, `task_type`, `link_path`, `answer_mode`, `secondary_path`,
   * `attachment`, `test_list`, `score`, `parse_count`, `is_parse`, `message`。
   *
   * `flag_type` / `shared` / `property` / `min_score` / `pass_score` / `level` / `number` /
   * `alias` / `manual` / `attachment_name` 在 **event_app 的任何接口里都没有返回**
   * （只在服务端算分/生成动态 flag 时使用）——这里仍然按「有就解析」处理，
   * 方便平台升级/私有部署多返回字段时不至于丢数据，但不要假设它们一定存在。
   */
  async challengeDetail(challengeId) {
    const d = await this.request(`/event/${this.eventId}/ctf/${challengeId}/info/`)
    const taskType = Number(d?.task_type ?? 0)
    const answerMode = Number(d?.answer_mode ?? 0)
    const flagType = Number(d?.flag_type ?? 0)
    const requiresEnv = taskType === 1
    const attachmentPath = d?.attachment || ''
    const attachment = attachmentPath ? new URL(String(attachmentPath), `${this.baseUrl}/`).toString() : ''
    const linkPath = d?.link_path || ''
    return {
      id: Number(challengeId),
      name: d?.name || `challenge-${challengeId}`,
      descriptionHtml: d?.desc || '',
      description: htmlToMarkdown(d?.desc),
      attachment,
      attachmentName: d?.attachment_name || (attachmentPath ? attachmentPath.split('/').pop() : ''),
      score: Number(d?.score ?? 0),
      solves: Number(d?.parse_count ?? 0),
      isSolved: Boolean(d?.is_parse),
      taskType,
      taskTypeLabel: ctfTaskTypeLabel(taskType),
      answerMode,
      answerModeLabel: ctfAnswerModeLabel(answerMode),
      flagType: flagType || undefined,
      flagTypeLabel: ctfFlagTypeLabel(flagType),
      shared: d?.shared,
      sharedLabel: ctfSharedLabel(d?.shared),
      property: d?.property,
      propertyLabel: ctfPropertyLabel(d?.property),
      minScore: d?.min_score ?? null,
      passScore: d?.pass_score ?? null,
      level: d?.level ?? null,
      number: d?.number ?? '',
      alias: d?.alias ?? '',
      manual: d?.manual ?? '',
      secondaryPath: d?.secondary_path || '',
      vulnId: d?.vuln_id != null ? String(d.vuln_id) : '',
      testList: d?.test_list && typeof d.test_list === 'object' ? d.test_list : {},
      messages: Array.isArray(d?.message) ? d.message : [],
      requiresEnv,
      /** 1 环境型 → 起环境；2 外链型 → 用 link_path；3 附件型 → 下附件。 */
      downloadable: taskType === 3,
      externalLink: taskType === 2 ? normalizeConnectionTarget(linkPath) : '',
      connectionInfo: requiresEnv ? '' : formatConnectionInfo({ domain_addr: linkPath }).targets.join('\n'),
      checkMode: answerMode === 2,
      raw: d,
    }
  }

  /** 下载附件到指定路径。返回 { path, bytes }。 */
  async downloadAttachment(url, destPath, { fs } = {}) {
    const fsm = fs || (await import('node:fs/promises'))
    const response = await this.request(url, { raw: true })
    const buffer = Buffer.from(await response.arrayBuffer())
    await fsm.writeFile(destPath, buffer)
    return { path: destPath, bytes: buffer.length }
  }

  // ---------------------------------------------------------------- 环境
  //
  // 源码依据：`event_app/views/env.py`（EnvRunView / EnvReleaseView / EnvAddrView / EnvDelayedView）
  // 与 `admin_env/utils/docker_api.py`（DokcerApi.start/release）。
  //
  // 环境时长：`release_time = now() + Competition.env_start_min 分钟`（默认 **60 分钟**）；
  // 环境数：`CompetitionCTFs.env_limit`（默认 **2**：个人赛一人 2 个 / 团队赛一队 2 个）；
  // 延时：`POST .../delayed/` 每次 +30 分钟，且**只在剩余 < 30 分钟时**允许。

  /**
   * 取环境地址（`GET /event/{pk}/ctf/{tpk}/addr/`），解析 `Env_RunSerializer` 的全部字段。
   *
   * 返回形状（源码 `event_app/serializers.py::Env_RunSerializer.Meta.fields`）：
   * `id, name, domain_addr, run_time, error_msg, release_time, ext_id, instance_id, vuln_id, end_second`
   * 外加视图补的 `classify`。
   *
   * @returns {{
   *  targets: string[], connectionInfo: string, hasPrivateOnly: boolean,
   *  runTime: string, releaseTime: string, remainingSeconds: number|null,
   *  endSecond: number|null, expired: boolean, envError: string,
   *  name: string, domainAddr: string, classify: string, vulnId: string,
   *  instanceId: string, extId: string, raw: object
   * }}
   */
  async getEnvironmentAddress(challengeId) {
    let addr
    try {
      addr = await this.request(`/event/${this.eventId}/ctf/${challengeId}/addr/`)
    } catch (error) {
      if (isEnvError(error)) {
        throw envError(error.payload ?? error.message, 'addr', {
          httpStatus: error.httpStatus,
          platformStatus: error.platformStatus,
        })
      }
      throw error
    }
    const payload = addr && typeof addr === 'object' ? addr : {}
    const { targets, hasPrivateOnly } = formatConnectionInfo(payload)
    const remainingSeconds = envRemainingSeconds(payload)
    const endSecond = Number.isFinite(Number(payload.end_second)) ? Number(payload.end_second) : null
    return {
      targets,
      connectionInfo: targets.join('\n'),
      hasPrivateOnly,
      runTime: payload.run_time || '',
      releaseTime: payload.release_time || '',
      remainingSeconds,
      endSecond,
      expired: remainingSeconds != null && remainingSeconds <= 0,
      envError: payload.error_msg || '',
      name: payload.name || '',
      domainAddr: payload.domain_addr || '',
      classify: payload.classify || '',
      vulnId: payload.vuln_id != null ? String(payload.vuln_id) : '',
      instanceId: payload.instance_id || '',
      extId: typeof payload.ext_id === 'string' ? payload.ext_id : '',
      raw: addr,
    }
  }

  /**
   * 环境题：begin → run → addr。
   *
   * 平台会在这三步里返回**七类**可分类的错误（源码文案见 `classifyEnvErrorPayload`）：
   * 未绑定 CTF 原题 / 未配置环境 / 比赛未开启 / 比赛已结束 / 未加入战队 /
   * 未配置 CTF 赛段 / 环境数超限（带 `envLimit` 数字）。
   * 都翻译成带 `code` 的 LingxuError，不再是一句裸 HTTP 400。
   */
  async startEnvironment(challengeId) {
    const begin = await this.requestEnv(`/event/${this.eventId}/ctf/${challengeId}/begin/`, {
      method: 'POST',
      body: new URLSearchParams(),
      stage: 'begin',
    })
    if (begin && typeof begin === 'object' && begin.error) {
      if (classifyEnvErrorPayload(begin)) throw envError(begin, 'begin')
      throw new LingxuError(`开启题目失败：${extractMessage(begin)}`, { path: 'begin', payload: begin })
    }
    // EventCTFBeginView：status 1=开启成功 / 2=已经开启（都算成功）
    if (begin && typeof begin === 'object' && begin.status != null && ![1, 2].includes(Number(begin.status))) {
      throw new LingxuError(`开启题目失败（status=${begin.status}）：${extractMessage(begin)}`, {
        path: 'begin',
        platformStatus: begin.status,
        payload: begin,
      })
    }

    const run = await this.requestEnv(`/event/${this.eventId}/ctf/${challengeId}/run/`, {
      method: 'POST',
      body: new URLSearchParams(),
      stage: 'run',
    })
    // DokcerApi.start：status 2=启动成功 / 3=启动失败（含「该环境正在启动」）
    if (run && typeof run === 'object' && (run.error || Number(run.status) === 3)) {
      if (classifyEnvErrorPayload(run)) throw envError(run, 'run')
      if (isEnvBusyPayload(run)) {
        throw new LingxuError(`环境正在启动：${extractMessage(run) || '该环境正在启动'}`, {
          code: LINGXU_CODES.ENV_BUSY,
          path: 'run',
          platformStatus: run.status,
          platformMessage: extractMessage(run),
          payload: run,
        })
      }
      throw new LingxuError(`启动环境失败：${extractMessage(run)}`, {
        code: LINGXU_CODES.ENV_START_FAILED,
        path: 'run',
        platformStatus: run.status,
        platformMessage: extractMessage(run),
        payload: run,
      })
    }

    const address = await this.getEnvironmentAddress(challengeId)
    if (!address.targets.length) {
      throw new LingxuError('平台未返回环境地址（addr 为空），可能需要人工在页面上确认环境状态', { path: 'addr' })
    }
    return {
      connectionInfo: address.connectionInfo,
      targets: address.targets,
      hasPrivateOnly: address.hasPrivateOnly,
      // 环境生命周期：剩余时间用于过期预警
      runTime: address.runTime,
      releaseTime: address.releaseTime,
      remainingSeconds: address.remainingSeconds,
      expired: address.expired,
      raw: address.raw,
    }
  }

  /** 发一次「环境相关」请求，把可分类的环境错误翻译成专门的错误码。 */
  async requestEnv(path, { method = 'POST', body, stage } = {}) {
    try {
      return await this.request(path, { method, body })
    } catch (error) {
      if (isEnvError(error)) {
        throw envError(error.payload ?? error.message, stage || error.path, {
          httpStatus: error.httpStatus,
          platformStatus: error.platformStatus,
        })
      }
      throw error
    }
  }

  /**
   * 发一次 AWD/CFS 请求，把平台文案分类成带 `code` 的 LingxuError。
   * （`isStageError` 覆盖 AWD/CFS 的全部错误码，见 `classifyAwdErrorPayload` / `classifyCfsErrorPayload`。）
   */
  async requestStage(path, { method = 'GET', body, stage } = {}) {
    const family = stageFamilyOf(stage)
    try {
      return await this.request(path, { method, body })
    } catch (error) {
      if (isStageError(error, family)) {
        throw stageError(error.payload ?? error.message, stage || error.path, {
          httpStatus: error.httpStatus,
          platformStatus: error.platformStatus,
          family,
        })
      }
      throw error
    }
  }

  /**
   * 分页拉取 AWD/CFS 列表（`page`/`size`，与 `CommonPagination` 一致：`page_size_query_param='size'`，
   * `max_page_size=1000`）。
   */
  async requestAllStage(path, { pageSize = 100, maxPages = 50, stage } = {}) {
    const family = stageFamilyOf(stage)
    try {
      return await this.requestAll(path, { pageSize, maxPages })
    } catch (error) {
      if (isStageError(error, family)) {
        throw stageError(error.payload ?? error.message, stage || error.path, {
          httpStatus: error.httpStatus,
          platformStatus: error.platformStatus,
          family,
        })
      }
      throw error
    }
  }

  /**
   * 取「可能是数组、也可能是分页对象」的列表端点。
   * AWD 回合动态 / CFS 大屏动态的视图**没有分页类**（源码里 `pagination_class` 被注释掉），
   * 返回普通数组；其余列表视图都带 `CommonPagination`。两种形状都兼容。
   */
  async requestListStage(path, { stage } = {}) {
    const payload = await this.requestStage(path, { stage })
    if (Array.isArray(payload)) return payload
    return Array.isArray(payload?.results) ? payload.results : []
  }

  /**
   * 环境延时（`POST /event/{pk}/ctf/{tpk}/delayed/`，源码 `EnvDelayedView`）。
   *
   * 平台语义：**每次 +30 分钟，且只有当剩余时间 < 30 分钟时才允许**。
   * 四分类（全部为 HTTP 200 + `status`/`msg`）：
   * - `{status:2, msg:'成功延时30分钟'}` → `{ ok:true, kind:'delayed', addedSeconds:1800 }`
   * - `{status:3, msg:'剩余半小时后才能延时'}` → `{ ok:false, kind:'too-early' }`
   * - `{status:3, msg:'该环境正在延时'}`       → `{ ok:false, kind:'busy' }`
   * - `{status:3, msg:'不存在的环境'}`         → `{ ok:false, kind:'missing' }`
   * - `{status:3, msg:'逻辑错误'}`（release_time 已过）→ `{ ok:false, kind:'expired' }`
   * HTTP 400（如团队赛未加入战队）仍抛带 code 的 LingxuError。
   */
  async delayEnvironment(challengeId) {
    const payload = await this.requestEnv(`/event/${this.eventId}/ctf/${challengeId}/delayed/`, {
      method: 'POST',
      body: new URLSearchParams(),
      stage: 'delayed',
    })
    const message = extractMessage(payload)
    const status = payload && typeof payload === 'object' ? Number(payload.status) : NaN
    const base = { challengeId: String(challengeId), status, message, raw: payload }
    if (status === 2) {
      return { ...base, ok: true, kind: 'delayed', delayed: true, addedSeconds: 1800 }
    }
    if (message.includes('剩余半小时后才能延时')) return { ...base, ok: false, kind: 'too-early', delayed: false }
    if (isEnvBusyPayload(payload)) return { ...base, ok: false, kind: 'busy', delayed: false }
    if (message.includes('不存在的环境')) return { ...base, ok: false, kind: 'missing', delayed: false }
    if (message.includes('逻辑错误')) return { ...base, ok: false, kind: 'expired', delayed: false }
    if (payload && typeof payload === 'object' && payload.error) {
      if (classifyEnvErrorPayload(payload)) throw envError(payload, 'delayed')
      throw new LingxuError(`延时失败：${message}`, { path: 'delayed', payload })
    }
    return { ...base, ok: false, kind: 'unknown', delayed: false }
  }

  /**
   * 释放环境。结果分类返回，**不把「平台未配置环境」当失败**：
   * - `kind: 'released'`     环境已释放（status=2，或「该环境正在释放」）
   * - `kind: 'no-env'`       本来就没有运行的环境（status=3 +「没有运行的环境」，幂等成功）
   * - `kind: 'not-configured'` 平台未给该题配置环境（HTTP 400 +「没有选择对应的环境」，跳过不计失败）
   * 其他情况仍然抛 LingxuError（真失败）。
   */
  async releaseEnvironment(challengeId) {
    let payload
    try {
      payload = await this.requestEnv(`/event/${this.eventId}/ctf/${challengeId}/release/`, {
        method: 'POST',
        body: new URLSearchParams(),
        stage: 'release',
      })
    } catch (error) {
      if (isEnvNotConfigured(error)) {
        return {
          challengeId: String(challengeId),
          released: false,
          idempotent: false,
          notConfigured: true,
          unsupported: false,
          kind: 'not-configured',
          message: error.platformMessage || extractMessage(error.payload) || '该题目没有选择对应的环境，请联系管理员。',
          raw: error.payload,
        }
      }
      throw error
    }

    const base = {
      challengeId: String(challengeId),
      released: false,
      idempotent: false,
      notConfigured: false,
      unsupported: false,
      kind: 'released',
      message: '',
      raw: payload,
    }

    if (payload && typeof payload === 'object') {
      base.message = extractMessage(payload)
      if (payload.error) {
        if (isEnvNotConfiguredPayload(payload)) {
          return { ...base, notConfigured: true, kind: 'not-configured' }
        }
        throw new LingxuError(`释放环境失败：${base.message}`, {
          path: 'release',
          platformStatus: payload.status,
          payload,
        })
      }
      const status = Number(payload.status)
      if (status === 2 || payload.status == null) return { ...base, released: true }
      const message = base.message.trim()
      if (status === 3 && ['该环境正在释放', '没有运行的环境'].includes(message)) {
        return { ...base, released: true, idempotent: true, kind: message === '没有运行的环境' ? 'no-env' : 'released' }
      }
      throw new LingxuError(`释放环境失败（status=${payload.status}）：${base.message}`, {
        path: 'release',
        platformStatus: payload.status,
        payload,
      })
    }
    return { ...base, released: true }
  }

  // ---------------------------------------------------------------- 提交

  /**
   * 提交 flag。
   * @returns {{ status: 'correct'|'incorrect'|'already_solved'|'unknown', message: string, flag: string }}
   */
  /**
   * 提交 flag（`POST /event/{pk}/ctf/{tpk}/flag/`，body `flag=<flag>`）。
   *
   * 源码 `EventCTFFlagView` 的响应：
   * - `{status: 1}`（+ 动态计分时的 `score`）= 正确
   * - `{status: 2}` = 错误
   * - HTTP 400 `{"error": …}` = 业务拒绝，文案包括：
   *  `您已提交了正确的Flag。` / `您所在的战队已提交了正确的Flag。` /
   *  `此题目为check模式，请点击check进行得分` / `请输入flag` / `比赛未开始` / `比赛已结束` /
   *  `未配置CTF赛段` / `FLAG错误` 等。
   *
   * 400 里的「已提交过正确 flag」按 `already_solved` 返回（**不抛错**），
   * check 模式题按 `check-mode` 返回，让上层能正确路由到 `/check/`。
   *
   * @returns {{ status: 'correct'|'incorrect'|'already_solved'|'check-mode'|'unknown', message: string, flag: string, score?: number }}
   */
  async submitFlag(challengeId, flag) {
    const normalized = String(flag ?? '').trim()
    if (!normalized) throw new LingxuError('flag 不能为空')
    let payload
    try {
      payload = await this.request(`/event/${this.eventId}/ctf/${challengeId}/flag/`, {
        method: 'POST',
        body: new URLSearchParams({ flag: normalized }),
      })
    } catch (error) {
      const message = extractMessage(error?.payload) || error?.platformMessage || ''
      if (isSessionExpired(error)) throw error
      if (message.includes('已提交了正确的Flag')) {
        return { status: 'already_solved', message, flag: normalized }
      }
      if (message.includes('check模式') || message.includes('请点击check进行得分')) {
        return { status: 'check-mode', message, flag: normalized }
      }
      throw error
    }
    const message = extractMessage(payload)
    const status = payload && typeof payload === 'object' ? Number(payload.status) : NaN

    if (status === 1) {
      return { status: 'correct', message, flag: normalized, score: payload?.score }
    }
    if (status === 2) return { status: 'incorrect', message, flag: normalized }

    const lower = message.toLowerCase()
    if (message.includes('已提交了正确的Flag')) return { status: 'already_solved', message, flag: normalized }
    if (lower.includes('flag错误') || lower.includes('incorrect') || lower.includes('错误')) {
      return { status: 'incorrect', message, flag: normalized }
    }
    if (SOLVED_HINTS.some((h) => message.includes(h))) {
      return { status: 'correct', message, flag: normalized }
    }
    return { status: 'unknown', message, flag: normalized }
  }

  /**
   * check 模式判题（`POST /event/{pk}/ctf/{tpk}/check/`，源码 `CTFCheckView`）。
   *
   * ⚠️ **源码实测要点**（`event_app/views/test.py::CTFCheckView`，当前版本注释写着「简化版」）：
   * - 视图**完全不读请求体**（前端也是 `S.post(url)` 不带 body），只写一条 CTFLog 后
   *  返回 `{"status": 1, "detail": "check已触发"}`；
   * - 所以 flag 参数可选：传了就带上 `{flag}`（对将来读 body 的版本/私有部署更友好），
   *  不传就与前端一致不带 body；
   * - 400 文案：`未配置CTF赛段` / `比赛未开始` / `比赛已结束` /
   *  `该题目没有选择对应的CTF题目，请联系管理员。` / `此题目不为check模式` / `check失败`。
   */
  async checkFlag(challengeId, flag) {
    const normalized = String(flag ?? '').trim()
    let payload
    try {
      payload = await this.request(`/event/${this.eventId}/ctf/${challengeId}/check/`, {
        method: 'POST',
        ...(normalized ? { body: { flag: normalized } } : {}),
      })
    } catch (error) {
      if (isEnvError(error)) {
        throw envError(error.payload ?? error.message, 'check', {
          httpStatus: error.httpStatus,
          platformStatus: error.platformStatus,
        })
      }
      const mismatch = classifyAnswerModePayload(error.payload)
      if (mismatch) {
        throw new LingxuError(`该题不是 check 模式：${mismatch.message}`, {
          code: mismatch.code,
          httpStatus: error.httpStatus,
          path: 'check',
          platformMessage: mismatch.message,
          payload: error.payload,
        })
      }
      throw error
    }
    const message = extractMessage(payload)
    return {
      ok: Number(payload?.status) === 1,
      status: payload && typeof payload === 'object' ? Number(payload.status) : NaN,
      detail: payload?.detail || message,
      message,
      flag: normalized,
      raw: payload,
    }
  }

  // ---------------------------------------------------------------- 排行榜

  /**
   * @param {'user'|'team'|'awd'|'cfs'} kind
   */
  async leaderboard(kind = 'user', { size = 20, type = 1 } = {}) {
    const path =
      kind === 'user'
        ? `/event/${this.eventId}/user/rank/?size=${size}&type=${type}`
        : `/event/${this.eventId}/${kind}/rank/?size=${size}`
    const payload = await this.request(path)
    const rows = Array.isArray(payload?.results) ? payload.results : []
    return {
      kind,
      total: Number(payload?.count ?? rows.length),
      rows: rows.map((r) => ({
        rank: rows.indexOf(r) + 1,
        id: r.id,
        username: r.username || r.name || '',
        score: Number(r.score ?? 0),
        testScore: Number(r.test_score ?? 0),
        ctfScore: Number(r.ctf_score ?? 0),
        awdScore: Number(r.awd_score ?? 0),
        solved: Number(r.parse_count ?? 0),
        firstBloods: Number(r.first_count ?? 0),
        isSelf: Boolean(r.is_self),
      })),
    }
  }

  /** 找自己在个人榜上的名次。 */
  async myRank() {
    const board = await this.leaderboard('user', { size: 200 })
    const idx = board.rows.findIndex((r) => r.isSelf)
    return { rank: idx >= 0 ? idx + 1 : null, total: board.total, self: idx >= 0 ? board.rows[idx] : null, board }
  }

  // ---------------------------------------------------------------- 理论题

  async theoryTests() {
    const payload = await this.request(`/event/${this.eventId}/test/`)
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : []
    return rows.map((t) => {
      const test = {
        id: t.id,
        name: t.name,
        types: Array.isArray(t.type) ? t.type : [],
        score: Number(t.score ?? 0),
        count: Number(t.count ?? 0),
        timeSeconds: Number(t.time_seconds ?? 0),
        isBegin: Boolean(t.is_begin),
        isEnd: Boolean(t.is_end),
        // 交卷后 is_begin 会变回 false，真正的「已交卷」标记是 is_parse。
        isParse: Boolean(t.is_parse),
        startTime: t.start_time ?? null,
        endTime: t.end_time ?? null,
        answerRule: t.answer_rule,
        parseCount: Number(t.parse_count ?? 0),
      }
      const status = theoryTestStatus(test)
      return { ...test, status: status.key, statusLabel: status.label }
    })
  }

  async beginTheoryTest(testId) {
    // 前端：S.post("/event/"+e_id+"/test/"+id+"/begin/") —— 无 body。
    const payload = await this.request(`/event/${this.eventId}/test/${testId}/begin/`, { method: 'POST' })
    const status = Number(payload?.status)
    if (status === 1 || status === 2) return { started: true, status, raw: payload }
    throw new LingxuError(`开始理论题失败：${extractMessage(payload)}`, {
      platformStatus: payload?.status,
      payload,
    })
  }

  /**
   * 题目列表。平台字段：`name` / `content`（选项字典）/ `option_type` / `option_count` /
   * `user_option`（**数组**）/ `sub_user` / `sub_time` / `score`。
   */
  async theoryQuestions(testId) {
    const rows = await this.requestAll(`/event/${this.eventId}/test/${testId}/list/`)
    return rows.map((q, i) => {
      const userOption = normalizeOptionArray(q.user_option)
      const optionType = Number(q.option_type ?? 0)
      return {
        index: i + 1,
        id: q.id,
        name: q.name ?? '',
        title: htmlToMarkdown(q.title || q.name || q.desc || ''),
        optionType,
        optionTypeLabel: theoryOptionTypeLabel(optionType),
        optionCount: Number(q.option_count ?? 0),
        score: Number(q.score ?? 0),
        options: extractOptions(q),
        // 平台给的是数组；归一成数组后空数组 = 未作答（保持旧字段存在，null 表示未作答）
        userOption: userOption.length ? userOption : null,
        userOptionText: userOption.join('、'),
        answered: userOption.length > 0,
        subUser: q.sub_user ?? '',
        subTime: q.sub_time ?? null,
        raw: q,
      }
    })
  }

  async theoryOrder(testId) {
    return this.request(`/event/${this.eventId}/test/${testId}/order/`)
  }

  async theoryTime(testId) {
    return this.request(`/event/${this.eventId}/test/${testId}/time/`)
  }

  /**
   * 提交单题作答。
   *
   * 平台前端真实行为（main.chunk.js）：
   *  `4===option_type ? m.option = answer : m.option = answer.sort()`
   *  `S.post("/event/"+e_id+"/test/"+id+"/answer/"+q.id+"/", m)` —— **JSON body 且 option 是数组**。
   * 之前发 form-encoded `option=B`（字符串）会直接 HTTP 500。
   *
   * @param {string|string[]} option 选项数组或可拆分的字符串（'BCD' → ['B','C','D']）
   * @param {{ optionType?: number }} [options] 题型的提示（4=填空，按空位顺序不排序）
   */
  async answerTheory(testId, questionId, option, { optionType } = {}) {
    const values = normalizeTheoryOption(option, { optionType })
    if (!values.length) throw new LingxuError('作答选项不能为空', { path: 'answer' })
    const payload = await this.request(`/event/${this.eventId}/test/${testId}/answer/${questionId}/`, {
      method: 'POST',
      body: { option: values },
    })
    const message = extractMessage(payload)
    return {
      ok: !(payload && payload.error),
      message,
      option: values,
      status: payload && typeof payload === 'object' ? payload.status : undefined,
      raw: payload,
    }
  }

  /** 交卷（不可逆）。前端：`S.post(".../test/"+id+"/finish/", {status: 1})` —— JSON。 */
  async finishTheory(testId) {
    const payload = await this.request(`/event/${this.eventId}/test/${testId}/finish/`, {
      method: 'POST',
      body: { status: 1 },
    })
    return { ok: !(payload && payload.error), message: extractMessage(payload), raw: payload }
  }

  // ---------------------------------------------------------------- AWD（源码 event_app/views/awd.py）
  //
  // AWD 与 CTF 是**完全不同的玩法**：
  // - 守方：`awdGetOwnFlag()`（GET /awd/get_flag/，按**请求来源 IP** 找到自己的靶机，flag_type=2 才有值）
  // - 攻方：`awdSubmitFlag(token, flag)`（GET/POST /awd/flag/?token=&flag= —— **query 参数**，不是 body）
  // - 回合制：`round_times` 回合时长 / `round_score` 回合分 / `down_score` 宕机扣分
  // - 加固期：`is_force` + `force_times`，加固期内回合号=0 且不允许提交 flag
  // - 靶机重置：`awdResetKvm(envRunId, {type})`，type=1 免费次数 / 2 扣分次数

  /** AWD 赛段 + 回合信息（`GET /event/{pk}/awd/info/`，源码 `EventAwdRoundTimeView`）。 */
  async awdRoundInfo() {
    const payload = await this.requestStage(`/event/${this.eventId}/awd/info/`, { stage: 'awd-info' })
    const status = Number(payload?.status)
    const info = payload?.info_dict || {}
    return {
      status,
      // 源码：1 未开始 / 0 进行中 / 2 已结束（3 是兜底值）
      statusLabel: AWD_STATUS_LABELS[status] || '未知',
      startSeconds: Number(payload?.start_seconds ?? 0),
      endSeconds: Number(payload?.end_seconds ?? 0),
      /** 当前回合号；加固期未结束时平台会置 0（源码 `if reinforce_end_seconds > 0: round = 0`）。 */
      round: Number(payload?.round ?? 0),
      roundEndSeconds: Number(payload?.round_end_seconds ?? 0),
      reinforceEndSeconds: Number(payload?.reinforce_end_seconds ?? 0),
      isReinforce: Number(payload?.reinforce_end_seconds ?? 0) > 0,
      /** 自己的 AWD token（提交 flag 时要用）。 */
      token: info.token || '',
      name: info.name || '',
      number: info.number || '',
      rank: info.rank != null ? Number(info.rank) : null,
      raw: payload,
    }
  }

  /**
   * AWD 题目列表（`GET /event/{pk}/awd/`，分页；源码 `EventAWDView` + `CompetitionAwdTestSerializer`）。
   *
   * 字段名容易混：`cat_id` = CompetitionAwdTest.id（详情 URL 的 cat_id）、
   * `ca_id` = CompetitionAWD.id（详情 URL 的 ca_id）、`awd_id` = 原题 AWD.id。
   */
  async awdChallenges({ classify } = {}) {
    const query = classify ? `?classify=${encodeURIComponent(classify)}` : ''
    const rows = await this.requestAllStage(`/event/${this.eventId}/awd/${query}`, { stage: 'awd-list' })
    return rows.map((row) => ({
      catId: row?.cat_id,
      caId: row?.ca_id,
      awdId: row?.awd_id,
      name: row?.awd_name ?? '',
      classify: row?.classify ?? '',
      testScore: Number(row?.test_score ?? 0),
      roundScore: Number(row?.round_score ?? 0),
      /** 靶机是否正常（false = 宕机）。 */
      checkStatus: Boolean(row?.check_status),
      /** 是否已被攻击。 */
      isAttacked: Boolean(row?.is_attacked),
      messages: Array.isArray(row?.msg) ? row.msg : [],
    }))
  }

  /**
   * AWD 题目详情（`GET /event/{pk}/awd/{cat_id}/{ca_id}/info/`，源码 `EventAWDInfoView`）。
   *
   * ⚠️ 参数顺序容易搞错：URL 里第一个是 **cat_id = CompetitionAwdTest.id**，
   * 第二个是 **ca_id = CompetitionAWD.id**（源码注释：`ca_id:CompetitionAWD.id; cat_id:CompetitionAwdTest.id`）。
   */
  async awdChallengeDetail(catId, caId) {
    const path = `/event/${this.eventId}/awd/${encodeURIComponent(catId)}/${encodeURIComponent(caId)}/info/`
    const d = await this.requestStage(path, { stage: 'awd-detail' })
    const pass = d?.test_img_pass || {}
    const attackIp = Array.isArray(d?.attack_ip) ? d.attack_ip.filter(Boolean) : []
    return {
      id: d?.id,
      name: d?.name || '',
      classify: d?.classify || '',
      descriptionHtml: d?.content ?? d?.desc ?? '',
      description: htmlToMarkdown(d?.desc ?? d?.content ?? ''),
      envRunId: d?.env_run_id,
      isAttacked: Boolean(d?.is_attacked),
      checkStatus: Boolean(d?.check_status),
      runStatus: d?.run_status,
      errorMsg: d?.error_msg || '',
      /** 自己靶机地址（源码 `test_ip_addr`，是个 dict，如 {ext_ip: '1.2.3.4:22'}）。 */
      testIpAddr: d?.test_ip_addr ?? null,
      ipAddr: d?.test_ip_addr?.ext_ip || d?.test_ip_addr?.ip || '',
      imgUser: pass.username || '',
      imgPassword: pass.password || '',
      leftFreeResetNum: d?.left_free_reset_num != null ? Number(d.left_free_reset_num) : null,
      leftResetNum: d?.left_reset_num != null ? Number(d.left_reset_num) : null,
      resetScore: d?.reset_score != null ? Number(d.reset_score) : null,
      isAttackIp: Boolean(d?.is_attack_ip),
      /** 可攻击的对手 ip 列表（`attacked_ip` 打开且非加固期才有）。 */
      attackIp,
      testScore: Number(d?.test_score ?? 0),
      roundScore: Number(d?.round_score ?? 0),
      messages: Array.isArray(d?.msg) ? d.msg : [],
      raw: d,
    }
  }

  /**
   * AWD 排行榜（`GET /event/{pk}/awd/rank/`，分页；个人赛/团队赛同一套字段）。
   *
   * ⚠️ **源码没有赛段校验**：赛事没有 AWD 赛段时该端点不做 400，而是照常查
   * `CompetitionUser/Team.awd_score`。真实平台（event 4）实测直接 **HTTP 500**。
   * 所以先看 `eventSummary().hasAwd` 再决定要不要调。
   */
  async awdRank() {
    const rows = await this.requestAllStage(`/event/${this.eventId}/awd/rank/`, { stage: 'awd-rank' })
    return rows.map((row, i) => ({
      rank: i + 1,
      id: row?.id,
      name: row?.name ?? '',
      awdScore: Number(row?.awd_score ?? 0),
      roundAwdScore: Number(row?.round_awd_score ?? 0),
      totalRoundScore: row?.total_round_score != null ? Number(row.total_round_score) : null,
      isSelf: Boolean(row?.is_self),
      awdScoreTime: row?.awd_score_time ?? '',
      logo: row?.logo ?? '',
      /** 该选手/队伍名下每台靶机的 {awd__name, check_status, is_attacked, sub_user/team_id}。 */
      topicInfo: Array.isArray(row?.topic_info) ? row.topic_info : [],
    }))
  }

  /**
   * AWD 回合动态（`GET /event/{pk}/awd/dynamic/`，源码 `EventAWDDynamicView`）。
   * ⚠️ 该视图**没有分页类**（源码只写了 serializer_class），返回的是**普通数组**；
   * 这里两种形状都兼容（数组或分页对象）。
   */
  async awdDynamic() {
    const rows = await this.requestListStage(`/event/${this.eventId}/awd/dynamic/`, { stage: 'awd-dynamic' })
    return rows.map((row) => ({
      status: Number(row?.status ?? 0),
      statusLabel: AWD_DYNAMIC_STATUS_LABELS[Number(row?.status ?? 0)] || '未知',
      attack: Array.isArray(row?.attack) ? row.attack : [],
      attackName: row?.attack_name ?? '',
      attacked: Array.isArray(row?.attacked) ? row.attacked : [],
      attackedName: row?.attacked_name ?? '',
      score: row?.score != null ? String(row.score) : '',
      testId: row?.test_id,
      testName: row?.test_name ?? '',
      roundNums: row?.round_nums != null ? Number(row.round_nums) : null,
      updateTime: row?.update_time ?? '',
    }))
  }

  /**
   * AWD 赛事动态（`GET /event/{pk}/awd/dynamic/info/`，分页）。
   * 支持的筛选（源码 `getlist`，数组参数）：`status[]` / `test_id[]` / `round_nums[]` /
   * `attack[]` / `attacked[]`，以及 `ordering`（`-1` 倒序默认 / `1` 正序）。
   */
  async awdDynamicInfo({ status, testId, roundNums, attack, attacked, ordering } = {}) {
    const params = []
    for (const value of asArray(status)) params.push(`status=${encodeURIComponent(value)}`)
    for (const value of asArray(testId)) params.push(`test_id=${encodeURIComponent(value)}`)
    for (const value of asArray(roundNums)) params.push(`round_nums=${encodeURIComponent(value)}`)
    for (const value of asArray(attack)) params.push(`attack=${encodeURIComponent(value)}`)
    for (const value of asArray(attacked)) params.push(`attacked=${encodeURIComponent(value)}`)
    if (ordering != null) params.push(`ordering=${encodeURIComponent(ordering)}`)
    const query = params.length ? `?${params.join('&')}` : ''
    const rows = await this.requestAllStage(`/event/${this.eventId}/awd/dynamic/info/${query}`, {
      stage: 'awd-dynamic-info',
    })
    return rows.map((row) => ({
      id: row?.id,
      status: Number(row?.status ?? 0),
      testId: row?.test_id,
      testName: row?.test_name ?? '',
      attack: Array.isArray(row?.attack) ? row.attack : [],
      attacked: Array.isArray(row?.attacked) ? row.attacked : [],
      avgScore: row?.avg_score != null ? Number(row.avg_score) : null,
      roundNums: row?.round_nums != null ? Number(row.round_nums) : null,
      updateTime: row?.update_time ?? '',
    }))
  }

  /** AWD 动态筛选用题目表（`GET /event/{pk}/awd/dynamic/awd_test/` → `[{id, test_name}]`）。 */
  async awdDynamicTests() {
    const payload = await this.requestStage(`/event/${this.eventId}/awd/dynamic/awd_test/`, { stage: 'awd-tests' })
    const rows = Array.isArray(payload) ? payload : []
    return rows.map((row) => ({ id: row?.id, name: row?.test_name ?? row?.name ?? '' }))
  }

  /** AWD 动态筛选用人员/队伍表（`GET /event/{pk}/awd/dynamic/awd_user/` → `[{id, username}]`）。 */
  async awdDynamicUsers() {
    const payload = await this.requestStage(`/event/${this.eventId}/awd/dynamic/awd_user/`, { stage: 'awd-users' })
    const rows = Array.isArray(payload) ? payload : []
    return rows.map((row) => ({ id: row?.id, name: row?.username ?? row?.name ?? '' }))
  }

  /**
   * AWD flag 提交 API 地址（`GET /event/{pk}/awd/flag/addr/`）。
   * ⚠️ 源码**没有赛段校验**：没有 AWD 赛段时也会正常返回（带你的 token）。
   * 平台返回 `{"API": "/event/{pk}/awd/flag/?token=<我的 token>&flag="}`。
   * ⚠️ 返回值里含自己的 token（凭据）——日志/展示时要脱敏，不要整条打出去。
   */
  async awdFlagApi() {
    const payload = await this.requestStage(`/event/${this.eventId}/awd/flag/addr/`, { stage: 'awd-flag-api' })
    const api = payload?.API || payload?.api || ''
    const match = /[?&]token=([^&]*)/.exec(api)
    return { api, token: match ? decodeURIComponent(match[1]) : '', raw: payload }
  }

  /**
   * 取**自己**靶机的 flag（防守视角，`GET /event/{pk}/awd/get_flag/`，源码 `EventGetAWDFlagView`）。
   *
   * ⚠️ 源码要点（很容易用错）：
   * - 该视图**没有鉴权**（permission_classes 被注释掉），靠 `GetIP(request)` 匹配
   *  `KvmEnvRun.ip_addr.ext_ip` 找到靶机 —— 也就是说**必须在靶机本机调用**才有值，
   *  在 agent 自己机器上调通常只能拿到空字符串；
   * - 只有 `awd.flag_type == 2`（flag 服务器）才返回 flag；`flag_type == 1`（flag 文件）
   *  返回空串（flag 在靶机文件里，需要自己读文件）。
   */
  async awdGetOwnFlag() {
    const payload = await this.requestStage(`/event/${this.eventId}/awd/get_flag/`, { stage: 'awd-get-flag' })
    const flag = payload?.flag ?? ''
    return {
      flag: typeof flag === 'string' ? flag : String(flag ?? ''),
      hasFlag: Boolean(flag),
      hint: flag ? '' : '未取到 flag：需在靶机本机调用（平台按请求 IP 匹配靶机），且题目 flag_type 必须是 2（flag 服务器）',
      raw: payload,
    }
  }

  /**
   * 提交 AWD flag（攻击视角，`GET|POST /event/{pk}/awd/flag/?token=&flag=`）。
   *
   * **参数必须放 query**（源码 `request.query_params.get("token")`），放 body 无效。
   * 成功返回 `{"status": 1, "data": "Flag提交成功！"}`；业务失败是 HTTP 400 + `{"error": …}`。
   *
   * @param {string} token AWD token（`awdRoundInfo().token` 或 `awdFlagApi().token`）
   * @param {string} flag 打到的 flag
   * @param {{ method?: 'GET'|'POST' }} [options]
   */
  async awdSubmitFlag(token, flag, { method = 'POST' } = {}) {
    const normalizedToken = String(token ?? '').trim()
    const normalizedFlag = String(flag ?? '').trim()
    if (!normalizedToken) throw new LingxuError('AWD 提交需要 token（可用 awdRoundInfo().token 获取）')
    if (!normalizedFlag) throw new LingxuError('AWD 提交需要 flag')
    const path =
      `/event/${this.eventId}/awd/flag/?token=${encodeURIComponent(normalizedToken)}` +
      `&flag=${encodeURIComponent(normalizedFlag)}`
    const payload = await this.requestStage(path, { method, stage: 'awd-flag' })
    return {
      ok: Number(payload?.status) === 1,
      status: Number(payload?.status),
      message: payload?.data || payload?.msg || extractMessage(payload),
      raw: payload,
    }
  }

  /**
   * AWD 靶机重置（`POST /event/{pk}/kvm/{env_run_id}/reset/?type=1|2`，源码 `AWDKvmResetView`）。
   * `type`：1 = 免费次数（默认），2 = 扣分次数（扣 `reset_score`）。
   * 返回 `{status: 1|2, message}`（注意是 **message**，不是 msg）。
   */
  async awdResetKvm(envRunId, { type = 1 } = {}) {
    const payload = await this.requestStage(
      `/event/${this.eventId}/kvm/${encodeURIComponent(envRunId)}/reset/?type=${encodeURIComponent(type)}`,
      { method: 'POST', stage: 'awd-reset' },
    )
    return {
      ok: Number(payload?.status) === 1,
      status: Number(payload?.status),
      message: payload?.message || extractMessage(payload),
      raw: payload,
    }
  }

  /** AWD 呼叫裁判（`POST /event/{pk}/awd/referee/`，body `{content}`）。 */
  async awdReferee(content) {
    const text = String(content ?? '').trim()
    if (!text) throw new LingxuError('呼叫裁判需要 content')
    const payload = await this.requestStage(`/event/${this.eventId}/awd/referee/`, {
      method: 'POST',
      body: { content: text },
      stage: 'awd-referee',
    })
    return { ok: Number(payload?.status) === 1, detail: payload?.detail || extractMessage(payload), raw: payload }
  }

  // ---------------------------------------------------------------- CFS（源码 event_app/views/cfs.py）
  //
  // CFS = 场景化闯关：一道题下多个**关卡**（`CFSFlag`，每关一个 flag/分值），
  // 进度用 `solve_schedule`（已通关卡数）/ `all_schedule`（总关卡数）。

  /** CFS 赛段信息（`GET /event/{pk}/cfs/info/`，源码 `EventCFSRoundTimeView`，无回合概念）。 */
  async cfsRoundInfo() {
    const payload = await this.requestStage(`/event/${this.eventId}/cfs/info/`, { stage: 'cfs-info' })
    const status = Number(payload?.status)
    return {
      status,
      statusLabel: AWD_STATUS_LABELS[status] || '未知',
      startSeconds: Number(payload?.start_seconds ?? 0),
      endSeconds: Number(payload?.end_seconds ?? 0),
      raw: payload,
    }
  }

  /** CFS 题目列表（`GET /event/{pk}/cfs/`，分页；源码 `CompetitionCFSTestSerializer`）。 */
  async cfsChallenges() {
    const rows = await this.requestAllStage(`/event/${this.eventId}/cfs/`, { stage: 'cfs-list' })
    return rows.map((row) => ({
      cctId: row?.cct_id,
      ccId: row?.cc_id,
      cfsId: row?.cfs_id,
      name: row?.cfs_name ?? '',
      score: Number(row?.cfs_score ?? 0),
      descriptionHtml: row?.desc_content ?? '',
      description: htmlToMarkdown(row?.desc_content ?? ''),
      /** 自己已通关卡数 / 总关卡数。 */
      solveSchedule: Number(row?.solve_schedule ?? 0),
      allSchedule: Number(row?.all_schedule ?? 0),
      doneCount: Number(row?.done_count ?? 0),
      messages: Array.isArray(row?.msg) ? row.msg : [],
    }))
  }

  /** CFS 题目详情（`GET /event/{pk}/cfs/{cct_id}/info/`，源码 `CompetitionCFSTestInfoSerializer`）。 */
  async cfsChallengeDetail(cctId) {
    const d = await this.requestStage(`/event/${this.eventId}/cfs/${encodeURIComponent(cctId)}/info/`, {
      stage: 'cfs-detail',
    })
    const attachmentPath = d?.attachment || ''
    return {
      cctId: d?.cct_id,
      ccId: d?.cc_id,
      cfsId: d?.cfs_id,
      name: d?.cfs_name ?? '',
      score: Number(d?.cfs_score ?? 0),
      nowScore: Number(d?.now_score ?? 0),
      descriptionHtml: d?.desc_content ?? '',
      description: htmlToMarkdown(d?.desc_content ?? ''),
      solveSchedule: Number(d?.solve_schedule ?? 0),
      allSchedule: Number(d?.all_schedule ?? 0),
      doneCount: Number(d?.done_count ?? 0),
      /** 关卡地址列表 / 附件列表（源码由 `now_score/addr_list/annex_list` 提供）。 */
      addrList: Array.isArray(d?.addr_list) ? d.addr_list : [],
      annexList: Array.isArray(d?.annex_list) ? d.annex_list : [],
      attachment: attachmentPath ? new URL(String(attachmentPath), `${this.baseUrl}/`).toString() : '',
      messages: Array.isArray(d?.msg) ? d.msg : [],
      raw: d,
    }
  }

  /**
   * 提交 CFS 关卡 flag（`POST /event/{pk}/cfs/{cct_id}/flag/`，body `{flag}`）。
   * 成功：`{"status": 1, "data": "恭喜攻克【题名】题目下的关卡【关卡名】！"}`。
   */
  async cfsSubmitFlag(cctId, flag) {
    const normalized = String(flag ?? '').trim()
    if (!normalized) throw new LingxuError('CFS 提交需要 flag')
    const payload = await this.requestStage(`/event/${this.eventId}/cfs/${encodeURIComponent(cctId)}/flag/`, {
      method: 'POST',
      body: { flag: normalized },
      stage: 'cfs-flag',
    })
    return {
      ok: Number(payload?.status) === 1,
      status: Number(payload?.status),
      message: payload?.data || payload?.msg || extractMessage(payload),
      flag: normalized,
      raw: payload,
    }
  }

  /**
   * CFS 排行榜（`GET /event/{pk}/cfs/rank/`，分页；源码 `CFSUserRankSerializer`/`CFSTeamRankSerializer`）。
   *
   * ⚠️ 和 `awdRank()` 一样**没有赛段校验**：没有 CFS 赛段时真实平台仍会返回全体参赛者
   * （cfs_score 全 0），所以**不能**用它判断「有没有 CFS 赛段」——请用 `eventSummary().hasCfs`。
   */
  async cfsRank() {
    const rows = await this.requestAllStage(`/event/${this.eventId}/cfs/rank/`, { stage: 'cfs-rank' })
    return rows.map((row, i) => ({
      rank: i + 1,
      id: row?.id,
      name: row?.name ?? '',
      cfsScore: Number(row?.cfs_score ?? 0),
      cfsStrengths: Number(row?.cfs_strengths ?? 0),
      cfsFlagCount: Number(row?.cfs_flag_count ?? 0),
      isSelf: Boolean(row?.is_self),
      cfsScoreTime: row?.cfs_score_time ?? '',
      logo: row?.logo ?? '',
    }))
  }

  /** CFS 得分总势（`GET /event/{pk}/cfs/chart/` → `{start_time, end_time, data[]}`）。 */
  async cfsChart() {
    const payload = await this.requestStage(`/event/${this.eventId}/cfs/chart/`, { stage: 'cfs-chart' })
    const rows = Array.isArray(payload?.data) ? payload.data : []
    return {
      startTime: payload?.start_time != null ? Number(payload.start_time) : null,
      endTime: payload?.end_time != null ? Number(payload.end_time) : null,
      series: rows.map((row) => ({
        id: row?.id,
        name: row?.name ?? '',
        points: Array.isArray(row?.data) ? row.data : [],
      })),
      raw: payload,
    }
  }

  /** CFS 大屏赛事动态（`GET /event/{pk}/cfs/dynamic/`；源码未启用分页 → 普通数组）。 */
  async cfsDynamic() {
    const rows = await this.requestListStage(`/event/${this.eventId}/cfs/dynamic/`, { stage: 'cfs-dynamic' })
    return rows.map((row) => ({
      id: row?.id,
      name: row?.name ?? '',
      testName: row?.test_name ?? '',
      flagTestName: row?.flag_test_name ?? '',
      subTime: row?.sub_time ?? '',
    }))
  }

  // ---------------------------------------------------------------- WP

  async listWriteups() {
    return this.requestAll(`/event/${this.eventId}/write_up/`)
  }

  async submitWriteup({ id, title, code }) {
    const body = new URLSearchParams()
    if (id != null) body.set('id', String(id))
    if (title != null) body.set('title', String(title))
    body.set('code', String(code ?? ''))
    const payload = await this.request(`/event/${this.eventId}/write_up/`, { method: 'POST', body })
    return { ok: !(payload && payload.error), message: extractMessage(payload), raw: payload }
  }
}

/** 从平台返回里抽取人类可读消息。 */
export function extractMessage(payload) {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload.trim()
  if (typeof payload === 'object') {
    for (const key of ['error', 'msg', 'message', 'detail']) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (Array.isArray(value)) {
        const text = value.map((v) => String(v).trim()).filter(Boolean).join(' ')
        if (text) return text
      }
      if (value) return String(value).trim()
    }
    return ''
  }
  return String(payload).trim()
}

/**
 * 从题目对象里尽力抽取选项。平台字段名不稳定，做多路兜底。
 * 实测理论题的选项在 `content` 字典里（如 `{"A":"…","B":"…"}`），优先读它。
 */
function extractOptions(question) {
  const content = question?.content
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const entries = Object.entries(content)
    if (entries.length) {
      return entries.map(([key, value]) => ({ key: String(key), text: htmlToMarkdown(value) }))
    }
  }

  const candidates = [question.option, question.options, question.option_list, question.choices]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (Array.isArray(candidate)) {
      return candidate
        .map((o, i) => {
          if (o && typeof o === 'object') {
            const key = o.key ?? o.option ?? o.label ?? o.id ?? String.fromCharCode(65 + i)
            const text = o.value ?? o.text ?? o.content ?? o.title ?? ''
            return { key: String(key), text: htmlToMarkdown(text) }
          }
          return { key: String.fromCharCode(65 + i), text: htmlToMarkdown(o) }
        })
        .filter((o) => o.text || o.key)
    }
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
        .split(/[\n,，;；]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((text, i) => ({ key: String.fromCharCode(65 + i), text }))
    }
  }
  return []
}
