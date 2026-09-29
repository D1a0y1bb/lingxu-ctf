/**
 * 平台适配器注册表。
 *
 * 目标：让工具层与编排层完全不感知具体平台，只依赖统一接口。
 * 已实现：`lingxu`（凌虚赛事 CTF，实测打通）、`ctfd`（CTFd，按官方 API v1 实现，未实测）。
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

const SUPPORTED = new Set(['lingxu', 'ctfd'])

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

/** CTFd 适配器（官方 API v1）。支持 Token 或 session cookie 两种认证。 */
export class CtfdAdapter {
  static id = 'ctfd'

  constructor(config) {
    this.config = config
    this.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '')
    this.token = config.token || ''
    this.cookie = config.cookie || ''
    this.timeoutMs = config.timeoutMs ?? 30000
  }

  get id() {
    return 'ctfd'
  }

  headers(extra = {}) {
    const headers = { Accept: 'application/json', 'User-Agent': 'dsh-lingxu-ctf', ...extra }
    if (this.token) headers.Authorization = `Token ${this.token}`
    if (this.cookie) headers.Cookie = this.cookie
    return headers
  }

  async request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const init = { method, headers: this.headers(), signal: controller.signal, redirect: 'follow' }
      if (body != null) {
        init.headers = { ...init.headers, 'Content-Type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const response = await fetch(`${this.baseUrl}${path}`, init)
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
      if (response.status >= 400) {
        throw new LingxuError(`CTFd ${method} ${path} HTTP ${response.status}`, { httpStatus: response.status, path })
      }
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  async validate() {
    if (!this.token && !this.cookie) throw new LingxuError('CTFd 需要 token 或 cookie')
    const me = await this.request('/api/v1/users/me')
    const data = me?.data ?? me
    if (!data?.id) throw new LingxuError('CTFd 凭据无效（/api/v1/users/me 未返回用户）')
    return { ok: true, user: { username: data.name, id: data.id }, event: null, warnings: [] }
  }

  async eventSummary() {
    let config = {}
    try {
      const res = await this.request('/api/v1/config')
      config = res?.data ?? res ?? {}
    } catch {
      /* 配置接口可能被关闭，忽略 */
    }
    const me = await this.request('/api/v1/users/me').catch(() => null)
    return {
      name: config.ctf_name || config.name || 'CTFd',
      organizer: config.ctf_description || '',
      startTime: config.start ? new Date(config.start * 1000).toISOString() : '',
      endTime: config.end ? new Date(config.end * 1000).toISOString() : '',
      status: undefined,
      labels: [],
      user: me?.data ? { username: me.data.name, id: me.data.id } : null,
      punish: false,
      testTypes: {},
      remainingSeconds: 0,
      raw: { config },
    }
  }

  async challenges() {
    const payload = await this.request('/api/v1/challenges')
    const rows = payload?.data ?? []
    const solvedIds = new Set()
    try {
      const me = await this.request('/api/v1/users/me')
      for (const s of me?.data?.solves ?? []) solvedIds.add(s.challenge_id)
    } catch {
      /* 未登录或接口受限时忽略 */
    }
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category || '',
      score: Number(row.value ?? 0),
      solved: solvedIds.has(row.id),
      parseCount: Number(row.solves ?? 0),
      begun: false,
    }))
  }

  async challengeDetail(id) {
    const payload = await this.request(`/api/v1/challenges/${id}`)
    const d = payload?.data ?? {}
    const files = Array.isArray(d.files) ? d.files : []
    return {
      id: Number(id),
      name: d.name || `challenge-${id}`,
      descriptionHtml: d.description || '',
      description: htmlToMarkdown(d.description),
      attachment: files.length ? String(files[0]) : '',
      attachments: files.map(String),
      score: Number(d.value ?? 0),
      solves: Number(d.solves ?? 0),
      taskType: undefined,
      answerMode: d.type === 'multiple_choice' ? 2 : undefined,
      requiresEnv: false,
      connectionInfo: d.connection_info || '',
      checkMode: d.type === 'multiple_choice',
      raw: d,
    }
  }

  async startEnvironment() {
    throw new LingxuError('CTFd 适配器不支持自动开启环境（该平台无统一环境接口）')
  }

  async releaseEnvironment() {
    return { released: false, unsupported: true }
  }

  async submitFlag(id, flag) {
    const normalized = String(flag ?? '').trim()
    const payload = await this.request('/api/v1/challenges/attempt', {
      method: 'POST',
      body: { challenge_id: Number(id), submission: normalized },
    })
    const data = payload?.data ?? {}
    const status = String(data.status || '')
    const map = { correct: 'correct', incorrect: 'incorrect', 'already_solved': 'already_solved' }
    return {
      status: map[status] || 'unknown',
      message: data.message || status,
      flag: normalized,
    }
  }

  async leaderboard(kind = 'user', opts = {}) {
    const count = opts.size ?? 20
    const payload = await this.request(`/api/v1/scoreboard/top/${count}`)
    const rows = payload?.data ?? []
    return {
      kind,
      total: rows.length,
      rows: rows.map((r, i) => ({
        rank: i + 1,
        id: r.id ?? r.account_id,
        username: r.name || r.account_name || '',
        score: Number(r.score ?? 0),
        testScore: 0,
        ctfScore: Number(r.score ?? 0),
        awdScore: 0,
        solved: 0,
        firstBloods: 0,
        isSelf: false,
      })),
    }
  }

  async myRank() {
    const board = await this.leaderboard('user', { size: 100 })
    const me = await this.request('/api/v1/users/me').catch(() => null)
    const username = me?.data?.name
    const idx = board.rows.findIndex((r) => r.username === username)
    return { rank: idx >= 0 ? idx + 1 : null, total: board.total, self: idx >= 0 ? board.rows[idx] : null, board }
  }

  async theoryTests() {
    return []
  }

  async beginTheoryTest() {
    throw new LingxuError('CTFd 适配器不支持理论题')
  }

  async theoryQuestions() {
    return []
  }

  async answerTheory() {
    throw new LingxuError('CTFd 适配器不支持理论题')
  }

  async finishTheory() {
    throw new LingxuError('CTFd 适配器不支持理论题')
  }

  async listWriteups() {
    return []
  }

  async submitWriteup() {
    throw new LingxuError('CTFd 适配器不支持平台侧 WP 提交，请使用本地导出')
  }

  async notices() {
    return []
  }

  async submitLogs() {
    return []
  }

  async downloadAttachment(url, destPath, opts) {
    const fsm = opts?.fs || (await import('node:fs/promises'))
    const response = await fetch(url, { headers: this.headers() })
    const buffer = Buffer.from(await response.arrayBuffer())
    await fsm.writeFile(destPath, buffer)
    return { path: destPath, bytes: buffer.length }
  }
}

const ADAPTERS = {
  lingxu: LingxuAdapter,
  ctfd: CtfdAdapter,
}

/** 按连接配置构造适配器。 */
export function createAdapter(connection) {
  const id = String(connection?.platform || 'lingxu').toLowerCase()
  const Adapter = ADAPTERS[id]
  if (!Adapter) {
    throw new LingxuError(`不支持的平台 "${id}"，可选：${listPlatforms().join(', ')}`)
  }
  return new Adapter(connection)
}

export { LingxuClient, LingxuError, formatConnectionInfo, htmlToMarkdown }
