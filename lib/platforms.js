/** 平台适配器注册表。目前提供凌虚实现，工具层只依赖这里的统一接口。 */

import {
  LingxuClient,
  LingxuError,
  formatConnectionInfo,
  htmlToMarkdown,
  normalizeTestTypes,
} from './lingxu.js'

/**
 * 统一适配器接口（所有方法均为 async）：
 *  validate()                       -> { ok, user, event, warnings[] }
 *  eventSummary()                   -> { name, startTime, endTime, status, user, punish,
 *                                        testTypes: [{id,name,size}], testTypeMap, hasTheory/hasCtf/hasAwd/hasCfs,
 *                                        remainingSeconds }
 *  eventType()                      -> { codes:['1','2','3'], labels:[{code,label}] }（"3"是 CFS，不是 AWD）
 *  eventChart(opts)                 -> { type, startTime, endTime, series[] }   （type 默认 2；理论题为空）
 *  eventPunish(opts)                -> [{ id, users[], issueTime, content, type, score }]
 *  ctfTime()                        -> { status, statusLabel, startSeconds, endSeconds }
 *  ctfNames()                       -> [{ id, name }]
 *  noticeCount()                    -> { count }
 *  challenges()                     -> Challenge[]
 *  challengeDetail(id)              -> ChallengeDetail
 *  startEnvironment(id)             -> { connectionInfo, targets, hasPrivateOnly, runTime, releaseTime, remainingSeconds, expired }
 *  getEnvironmentAddress(id)        -> { targets, connectionInfo, runTime, releaseTime, remainingSeconds, ... }
 *  delayEnvironment(id)             -> { ok, kind: 'delayed'|'too-early'|'busy'|'missing'|'expired', message }
 *  releaseEnvironment(id)           -> { released, kind, notConfigured, idempotent }
 *  submitFlag(id, flag)             -> { status, message, flag }
 *  checkFlag(id, flag)              -> { ok, status, detail, message }          （answer_mode=2）
 *  leaderboard(kind, opts)          -> { kind, total, rows[] }
 *  theoryTests()                    -> TheoryTest[]           （不支持时返回 []）
 *  beginTheoryTest(id)              -> { started }
 *  theoryQuestions(id)              -> Question[]
 *  answerTheory(testId, qid, opt)   -> { ok, message }
 *  finishTheory(testId)             -> { ok, message }
 *  submitWriteup(payload)           -> { ok, message }
 *  listWriteups()                   -> []
 *
 *   AWD（回合制攻防；与 CTF 完全不同）
 *  awdRoundInfo()                   -> { status, statusLabel, round, roundEndSeconds, reinforceEndSeconds,
 *                                        isReinforce, token, name, number, rank, startSeconds, endSeconds }
 *  awdChallenges(opts)              -> [{ catId, caId, awdId, name, classify, testScore, roundScore,
 *                                         checkStatus, isAttacked, messages }]
 *  awdChallengeDetail(catId, caId)  -> { envRunId, ipAddr, imgUser/imgPassword, attackIp, leftFreeResetNum,
 *                                        leftResetNum, resetScore, checkStatus, isAttacked, ... }
 *  awdRank()                        -> [{ rank, name, awdScore, roundAwdScore, totalRoundScore, isSelf, topicInfo }]
 *  awdDynamic()                     -> [{ status, statusLabel, attackName, attackedName, score, testName, roundNums }]
 *  awdDynamicInfo(filters)          -> 同上（含 avgScore）
 *  awdDynamicTests() / awdDynamicUsers() -> 筛选用表
 *  awdFlagApi()                     -> { api, token }      ⚠️ 含自己的 token，别整条打日志
 *  awdGetOwnFlag()                  -> { flag, hasFlag, hint }  ⚠️ 需在靶机本机调用（按请求 IP 匹配）
 *  awdSubmitFlag(token, flag, opts) -> { ok, status, message }  query 参数，不是 body
 *  awdResetKvm(envRunId, {type})    -> { ok, status, message }  type 1 免费 / 2 扣分
 *  awdReferee(content)              -> { ok, detail }
 *
 *   CFS（场景化闯关，一题多关卡）
 *  cfsRoundInfo()                   -> { status, statusLabel, startSeconds, endSeconds }（无回合概念）
 *  cfsChallenges()                  -> [{ cctId, ccId, cfsId, name, score, solveSchedule, allSchedule, ... }]
 *  cfsChallengeDetail(cctId)        -> 同上 + { nowScore, addrList, annexList, attachment }
 *  cfsSubmitFlag(cctId, flag)       -> { ok, status, message }
 *  cfsRank()                        -> [{ rank, name, cfsScore, cfsStrengths, cfsFlagCount, isSelf }]
 *  cfsChart()                       -> { startTime, endTime, series[] }
 *  cfsDynamic()                     -> [{ id, name, testName, flagTestName, subTime }]
 *
 * Challenge 形状：{ id, name, category, score, solved, parseCount, begun, testList, requiresEnv? }
 * ChallengeDetail 形状：{ id, name, description, descriptionHtml, attachment, attachmentName, score, solves,
 *                        isSolved, taskType, taskTypeLabel, answerMode, answerModeLabel, flagType,
 *                        requiresEnv, downloadable, externalLink, connectionInfo, checkMode, messages, raw }
 */

const SUPPORTED = new Set(['lingxu'])

/**
 * 平台适配器对外合同版本。这个版本只描述归一化结果，不等同于凌虚
 * 服务端版本；服务端字段变化时先扩展 capabilities / error shape，再更新工具层。
 */
export const PLATFORM_CONTRACT_VERSION = 1

/** 赛段能力的三态值：明确存在、明确不存在、暂时无法判断。 */
export const CAPABILITY_STATES = Object.freeze({
  PRESENT: 'present',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
})

/**
 * 统一的凌虚能力合同。`stageIds` 是平台 test_type 的真实键，不能把
 * `/event/{id}/type/` 返回的 "3" 当 AWD（那个接口的 3 实际是 CFS）。
 */
export const LINGXU_PLATFORM_CONTRACT = Object.freeze({
  platform: 'lingxu',
  version: PLATFORM_CONTRACT_VERSION,
  stageIds: Object.freeze({ theory: 1, ctf: 2, awd: 3, cfs: 4 }),
  source: 'event.test_type',
})

const STAGE_ID_BY_NAME = LINGXU_PLATFORM_CONTRACT.stageIds

function hasOwn(value, key) {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
}

/**
 * 从赛事 `test_type` JSONField 生成稳定的能力快照。
 *
 * `null/undefined` 表示接口没有给出字段，必须是 unknown；空对象则是平台
 * 明确返回「没有任何赛段」，属于 absent。这样网络抖动不会被误当成纯 CTF。
 */
export function stageCapabilitiesFromTestType(testType, { known = testType !== null && testType !== undefined } = {}) {
  const validObject = testType && typeof testType === 'object' && !Array.isArray(testType)
  const source = validObject ? testType : {}
  const effectiveKnown = Boolean(known) && validObject
  const state = (id) => effectiveKnown
    ? (hasOwn(source, String(id)) || hasOwn(source, id) ? CAPABILITY_STATES.PRESENT : CAPABILITY_STATES.ABSENT)
    : CAPABILITY_STATES.UNKNOWN
  return {
    platform: LINGXU_PLATFORM_CONTRACT.platform,
    version: PLATFORM_CONTRACT_VERSION,
    source: effectiveKnown ? LINGXU_PLATFORM_CONTRACT.source : 'unknown',
    stages: {
      theory: state(STAGE_ID_BY_NAME.theory),
      ctf: state(STAGE_ID_BY_NAME.ctf),
      awd: state(STAGE_ID_BY_NAME.awd),
      cfs: state(STAGE_ID_BY_NAME.cfs),
    },
  }
}

/** 从摘要中读取能力合同；旧适配器没有合同字段时按三态推导。 */
export function stageCapabilitiesFromSummary(summary) {
  const src = summary && typeof summary === 'object' ? summary : {}
  const declared = src.capabilities
  if (declared && typeof declared === 'object' && declared.stages && typeof declared.stages === 'object') {
    const normalize = (value) => Object.values(CAPABILITY_STATES).includes(value)
      ? value
      : CAPABILITY_STATES.UNKNOWN
    return {
      platform: declared.platform || LINGXU_PLATFORM_CONTRACT.platform,
      version: Number(declared.version) || PLATFORM_CONTRACT_VERSION,
      stageIds: declared.stageIds && typeof declared.stageIds === 'object'
        ? { ...declared.stageIds }
        : { ...LINGXU_PLATFORM_CONTRACT.stageIds },
      source: typeof declared.source === 'string' ? declared.source : 'unknown',
      stages: {
        theory: normalize(declared.stages.theory),
        ctf: normalize(declared.stages.ctf),
        awd: normalize(declared.stages.awd),
        cfs: normalize(declared.stages.cfs),
      },
    }
  }
  if (hasOwn(src, 'testTypeMap')) return stageCapabilitiesFromTestType(src.testTypeMap, { known: true })
  if (hasOwn(src, 'testTypes')) {
    const rows = src.testTypes
    if (Array.isArray(rows)) {
      const validRows = rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row) && Number.isFinite(Number(row.id)))
      const testTypeMap = Object.fromEntries(validRows.map((row) => [String(Number(row.id)), row]))
      // 归一化列表里混入没有 id 的行时，不能把剩余的空 map 当成「明确没有
      // AWD/CFS」；那会在一次脏响应后错误注销仍可用的赛段工具。
      return stageCapabilitiesFromTestType(testTypeMap, { known: validRows.length === rows.length })
    }
    if (rows && typeof rows === 'object') return stageCapabilitiesFromTestType(rows, { known: true })
    return stageCapabilitiesFromTestType(null, { known: false })
  }
  if (hasOwn(src, 'hasTheory') || hasOwn(src, 'hasCtf') || hasOwn(src, 'hasAwd') || hasOwn(src, 'hasCfs')) {
    const state = (value) => typeof value === 'boolean'
      ? (value ? CAPABILITY_STATES.PRESENT : CAPABILITY_STATES.ABSENT)
      : CAPABILITY_STATES.UNKNOWN
    return {
      platform: LINGXU_PLATFORM_CONTRACT.platform,
      version: PLATFORM_CONTRACT_VERSION,
      source: 'summary.flags',
      stages: {
        theory: state(src.hasTheory),
        ctf: state(src.hasCtf),
        awd: state(src.hasAwd),
        cfs: state(src.hasCfs),
      },
    }
  }
  return stageCapabilitiesFromTestType(null, { known: false })
}

/**
 * 跨适配器共享的错误结构。故意不带 raw payload，避免把 Cookie/token 或
 * 平台 HTML 错误页无意间送到客户端；需要调试时仍可从 LingxuError 读取原始字段。
 */
export function normalizePlatformError(error, fallback = '平台请求失败') {
  const source = error && typeof error === 'object' ? error : {}
  const httpStatus = Number.isFinite(Number(source.httpStatus)) ? Number(source.httpStatus) : null
  const platformStatus = Number.isFinite(Number(source.platformStatus)) ? Number(source.platformStatus) : null
  const code = typeof source.code === 'string' && source.code !== ''
    ? source.code
    : httpStatus === 401
      ? 'session-expired'
      : httpStatus === 403
        ? 'forbidden'
        : httpStatus === 408 || httpStatus === 429 || (httpStatus !== null && httpStatus >= 500)
          ? 'transient-platform-error'
          : 'platform-error'
  const message = String(source.platformMessage || source.message || fallback)
  const retryable = typeof source.retryable === 'boolean'
    ? source.retryable
    : code === 'transient-platform-error' || code === 'env-busy'
  return {
    ok: false,
    code,
    message,
    httpStatus,
    platformStatus,
    path: typeof source.path === 'string' ? source.path : null,
    retryable,
  }
}

export function listPlatforms() {
  return [...SUPPORTED]
}

export function isSupportedPlatform(id) {
  return SUPPORTED.has(String(id || '').toLowerCase())
}

/** 凌虚适配器：薄封装，核心逻辑都在 LingxuClient。 */
export class LingxuAdapter {
  static id = 'lingxu'
  static contractVersion = PLATFORM_CONTRACT_VERSION

  constructor(config) {
    this.config = config
    this.client = new LingxuClient({
      baseUrl: config.baseUrl,
      eventId: config.eventId,
      cookie: config.cookie,
      timeoutMs: config.timeoutMs,
    })
  }

  get id() {
    return 'lingxu'
  }

  get contractVersion() {
    return PLATFORM_CONTRACT_VERSION
  }

  /** 当前适配器支持的能力合同（不发请求）。 */
  capabilities() {
    return {
      platform: LINGXU_PLATFORM_CONTRACT.platform,
      version: PLATFORM_CONTRACT_VERSION,
      stageIds: { ...LINGXU_PLATFORM_CONTRACT.stageIds },
      source: LINGXU_PLATFORM_CONTRACT.source,
    }
  }

  /** 给工具层使用的稳定错误投影，不暴露原始 payload。 */
  normalizeError(error, fallback) {
    return normalizePlatformError(error, fallback)
  }

  async validate() {
    const info = await this.client.validateAccess()
    const warnings = []
    if (!info?.user?.username) warnings.push('平台未返回用户名，Cookie 可能已过期')
    if (info?.punish) warnings.push('本赛事开启了错误 flag 扣分（punish=true）')
    return { ok: true, user: info?.user ?? null, event: null, warnings }
  }

  async eventSummary() {
    const [detail, info] = await Promise.all([this.client.eventDetail(), this.client.eventInfo()])
    // Competition.test_type 是 JSONField：{'1': {name, size}, '2': {...}, '3': AWD, '4': CFS}
    const hasTestTypeField = hasOwn(info, 'test_type')
    const validTestType = info?.test_type && typeof info.test_type === 'object' && !Array.isArray(info.test_type)
    const testTypeMap = validTestType ? info.test_type : {}
    const testTypes = normalizeTestTypes(testTypeMap)
    const hasType = (id) => !hasTestTypeField || !validTestType
      ? null
      : Object.prototype.hasOwnProperty.call(testTypeMap, String(id))
    return {
      name: detail?.name ?? '',
      organizer: detail?.organizer ?? '',
      startTime: detail?.start_time ?? '',
      endTime: detail?.end_time ?? '',
      status: detail?.status,
      labels: detail?.label ?? [],
      user: info?.user ?? null,
      punish: Boolean(info?.punish),
      /** 归一化题型构成：[{id,name,size}]（1 理论题 / 2 CTF / 3 AWD / 4 CFS）。 */
      testTypes,
      /** 平台原始 JSONField（键是字符串 '1'..'4'）。 */
      testTypeMap,
      /** 这场赛事有没有对应赛段——没有就别去调 awd/cfs 接口（省一次必然 400 的请求）。 */
      hasTheory: hasType(1),
      hasCtf: hasType(2),
      hasAwd: hasType(3),
      hasCfs: hasType(4),
      remainingSeconds: Number(info?.end_seconds ?? 0),
      // 赛事时间窗口（源码 EventInfoView：start_seconds/end_seconds，均已被平台归零处理）
      startSeconds: Number(info?.start_seconds ?? 0),
      endSeconds: Number(info?.end_seconds ?? 0),
      showTools: Boolean(info?.show_tools),
      capabilities: stageCapabilitiesFromTestType(info?.test_type, { known: hasTestTypeField }),
      raw: { detail, info },
    }
  }

  /** 赛事类型（`GET /event/{pk}/type/`；⚠️ 它的 "3" 是 CFS，不是 AWD）。 */
  async eventType() {
    return this.client.eventType()
  }

  /** 得分总势（`GET /event/{pk}/chart/?type=`）。 */
  async eventChart(opts = {}) {
    return this.client.eventChart(opts)
  }

  /** 处罚警告（`GET /event/{pk}/punish/?type=`，分页）。 */
  async eventPunish(opts = {}) {
    return this.client.eventPunish(opts)
  }

  /** CTF 倒计时（`GET /event/{pk}/ctf/time/`）。 */
  async ctfTime() {
    return this.client.ctfTime()
  }

  /** CTF 题目名称列表（`GET /event/{pk}/ctf/name/`）。 */
  async ctfNames() {
    return this.client.ctfNames()
  }

  /** 未读公告数（`GET /event/{pk}/notice/count/`）。 */
  async noticeCount() {
    return this.client.noticeCount()
  }

  async challenges() {
    return this.client.challenges()
  }

  async challengeDetail(id) {
    return this.client.challengeDetail(id)
  }

  async startEnvironment(id) {
    return this.client.startEnvironment(id)
  }

  /** 只取环境地址（不改环境状态），含 run_time/release_time/end_second。 */
  async getEnvironmentAddress(id) {
    return this.client.getEnvironmentAddress(id)
  }

  /** 环境延时 +30 分钟（仅剩余 <30 分钟时可用）。 */
  async delayEnvironment(id) {
    return this.client.delayEnvironment(id)
  }

  async releaseEnvironment(id) {
    return this.client.releaseEnvironment(id)
  }

  async submitFlag(id, flag) {
    return this.client.submitFlag(id, flag)
  }

  /** check 模式判题（answer_mode=2）。 */
  async checkFlag(id, flag) {
    return this.client.checkFlag(id, flag)
  }

  async leaderboard(kind = 'user', opts = {}) {
    return this.client.leaderboard(kind, opts)
  }

  async myRank() {
    return this.client.myRank()
  }

  async theoryTests() {
    return this.client.theoryTests()
  }

  async beginTheoryTest(id) {
    return this.client.beginTheoryTest(id)
  }

  async theoryQuestions(id) {
    return this.client.theoryQuestions(id)
  }

  async theoryTime(id) {
    return this.client.theoryTime(id)
  }

  async answerTheory(testId, questionId, option) {
    return this.client.answerTheory(testId, questionId, option)
  }

  async finishTheory(testId) {
    return this.client.finishTheory(testId)
  }

  async listWriteups() {
    return this.client.listWriteups()
  }

  async submitWriteup(payload) {
    return this.client.submitWriteup(payload)
  }

  async notices() {
    return this.client.notices()
  }

  async submitLogs(opts) {
    return this.client.submitLogs(opts)
  }

  async downloadAttachment(url, destPath, opts) {
    return this.client.downloadAttachment(url, destPath, opts)
  }

  //  AWD（回合制攻防）

  /** AWD 赛段 + 回合信息（含自己的 token / 排名）。 */
  async awdRoundInfo() {
    return this.client.awdRoundInfo()
  }

  /** AWD 题目列表（`?classify=` 过滤）。 */
  async awdChallenges(opts = {}) {
    return this.client.awdChallenges(opts)
  }

  /** AWD 题目详情（catId=CompetitionAwdTest.id，caId=CompetitionAWD.id）。 */
  async awdChallengeDetail(catId, caId) {
    return this.client.awdChallengeDetail(catId, caId)
  }

  /** AWD 排行榜（个人赛/团队赛同一套字段）。 */
  async awdRank() {
    return this.client.awdRank()
  }

  /** AWD 回合动态（普通数组，无分页）。 */
  async awdDynamic() {
    return this.client.awdDynamic()
  }

  /** AWD 赛事动态（分页 + 多值筛选）。 */
  async awdDynamicInfo(filters = {}) {
    return this.client.awdDynamicInfo(filters)
  }

  async awdDynamicTests() {
    return this.client.awdDynamicTests()
  }

  async awdDynamicUsers() {
    return this.client.awdDynamicUsers()
  }

  /** AWD flag 提交 API 地址（返回值含自己的 token，注意脱敏）。 */
  async awdFlagApi() {
    return this.client.awdFlagApi()
  }

  /** 取自己靶机的 flag（防守视角；需在靶机本机调用）。 */
  async awdGetOwnFlag() {
    return this.client.awdGetOwnFlag()
  }

  /** 提交打到的 flag（query 参数传 token/flag）。 */
  async awdSubmitFlag(token, flag, opts = {}) {
    return this.client.awdSubmitFlag(token, flag, opts)
  }

  /** 靶机重置（type 1 免费 / 2 扣分）。 */
  async awdResetKvm(envRunId, opts = {}) {
    return this.client.awdResetKvm(envRunId, opts)
  }

  /** 呼叫裁判。 */
  async awdReferee(content) {
    return this.client.awdReferee(content)
  }

  //  CFS（场景化闯关）

  async cfsRoundInfo() {
    return this.client.cfsRoundInfo()
  }

  async cfsChallenges() {
    return this.client.cfsChallenges()
  }

  async cfsChallengeDetail(cctId) {
    return this.client.cfsChallengeDetail(cctId)
  }

  async cfsSubmitFlag(cctId, flag) {
    return this.client.cfsSubmitFlag(cctId, flag)
  }

  async cfsRank() {
    return this.client.cfsRank()
  }

  async cfsChart() {
    return this.client.cfsChart()
  }

  async cfsDynamic() {
    return this.client.cfsDynamic()
  }
}

/**
 * 按连接配置构造适配器。
 *
 * `connection.platform` 省略时按 lingxu 处理；若显式指定了别的平台（例如 store 里
 * 遗留的旧连接记录），抛 LingxuError 而不是静默降级成凌虚适配器。
 */
export function createAdapter(connection) {
  const id = String(connection?.platform || 'lingxu').toLowerCase()
  if (!isSupportedPlatform(id)) {
    throw new LingxuError(`不支持的平台 "${id}"，本项目只支持 lingxu（凌虚赛事平台）`)
  }
  return new LingxuAdapter(connection)
}

export { LingxuClient, LingxuError, formatConnectionInfo, htmlToMarkdown }
