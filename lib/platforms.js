/**
 * 平台适配器注册表。
 *
 * 目标：让工具层与编排层完全不感知平台细节，只依赖统一接口。
 * 本项目**只支持凌虚赛事平台**（`lingxu`，实测打通）；其余平台（含历史遗留的
 * 非 lingxu 连接记录）在 `createAdapter` 处直接给出清晰报错，不做静默降级。
 */

import { LingxuClient, LingxuError, formatConnectionInfo, htmlToMarkdown } from './lingxu.js'

/**
 * 统一适配器接口（所有方法均为 async）：
 *   validate()                       -> { ok, user, event, warnings[] }
 *   eventSummary()                   -> { name, startTime, endTime, status, user, punish, testTypes, remainingSeconds }
 *   challenges()                     -> Challenge[]
 *   challengeDetail(id)              -> ChallengeDetail
 *   startEnvironment(id)             -> { connectionInfo, targets, hasPrivateOnly }
 *   releaseEnvironment(id)           -> { released }
 *   submitFlag(id, flag)             -> { status, message, flag }
 *   leaderboard(kind, opts)          -> { kind, total, rows[] }
 *   theoryTests()                    -> TheoryTest[]           （不支持时返回 []）
 *   beginTheoryTest(id)              -> { started }
 *   theoryQuestions(id)              -> Question[]
 *   answerTheory(testId, qid, opt)   -> { ok, message }
 *   finishTheory(testId)             -> { ok, message }
 *   submitWriteup(payload)           -> { ok, message }
 *   listWriteups()                   -> []
 *
 * Challenge 形状：{ id, name, category, score, solved, parseCount, begun, requiresEnv? }
 * ChallengeDetail 形状：{ id, name, description, descriptionHtml, attachment, score, solves,
 *                         requiresEnv, connectionInfo, checkMode, raw }
 */

const SUPPORTED = new Set(['lingxu'])

export function listPlatforms() {
  return [...SUPPORTED]
}

export function isSupportedPlatform(id) {
  return SUPPORTED.has(String(id || '').toLowerCase())
}

/** 凌虚适配器：薄封装，核心逻辑都在 LingxuClient。 */
export class LingxuAdapter {
  static id = 'lingxu'

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

  async validate() {
    const info = await this.client.validateAccess()
    const warnings = []
    if (!info?.user?.username) warnings.push('平台未返回用户名，Cookie 可能已过期')
    if (info?.punish) warnings.push('本赛事开启了错误 flag 扣分（punish=true）')
    return { ok: true, user: info?.user ?? null, event: null, warnings }
  }

  async eventSummary() {
    const [detail, info] = await Promise.all([this.client.eventDetail(), this.client.eventInfo()])
    return {
      name: detail?.name ?? '',
      organizer: detail?.organizer ?? '',
      startTime: detail?.start_time ?? '',
      endTime: detail?.end_time ?? '',
      status: detail?.status,
      labels: detail?.label ?? [],
      user: info?.user ?? null,
      punish: Boolean(info?.punish),
      testTypes: info?.test_type ?? {},
      remainingSeconds: Number(info?.end_seconds ?? 0),
      raw: { detail, info },
    }
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

  async releaseEnvironment(id) {
    return this.client.releaseEnvironment(id)
  }

  async submitFlag(id, flag) {
    return this.client.submitFlag(id, flag)
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
