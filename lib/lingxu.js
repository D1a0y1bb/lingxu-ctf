/**
 * 凌虚竞赛平台（Lingxu event CTF）客户端。
 *
 * 零依赖：只用 Node 内置 fetch（Node >= 18）。所有方法只访问调用方传入的 base URL。
 * API 路径与语义来自对真实赛事（event 4）的实测 + HuntingBlade 的 lingxu_event_ctf.py 逆向。
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 平台业务错误。status 为平台返回的 status 字段（若存在）。 */
export class LingxuError extends Error {
  constructor(message, { httpStatus, platformStatus, path } = {}) {
    super(message)
    this.name = 'LingxuError'
    this.httpStatus = httpStatus
    this.platformStatus = platformStatus
    this.path = path
  }
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

export class LingxuClient {
  /**
   * @param {{ baseUrl: string, eventId: number|string, cookie: string, timeoutMs?: number }} options
   */
  constructor({ baseUrl, eventId, cookie, timeoutMs = 30000 }) {
    if (!baseUrl) throw new LingxuError('缺少平台地址 baseUrl')
    if (!eventId) throw new LingxuError('缺少赛事 ID eventId')
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.eventId = Number(eventId)
    this.cookie = String(cookie || '')
    this.timeoutMs = timeoutMs
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

  async request(path, { method = 'GET', body, raw = false, expectJson = true } = {}) {
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

    if (response.status >= 400) {
      throw new LingxuError(
        `凌虚 ${method} ${path} HTTP ${response.status}${typeof payload === 'string' && payload ? `: ${payload.slice(0, 200)}` : ''}`,
        { httpStatus: response.status, path },
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

  async submitLogs({ type = 1, testType = 2 } = {}) {
    return this.requestAll(`/event/${this.eventId}/log/?type=${type}&test_type=${testType}`)
  }

  // ---------------------------------------------------------------- 题目

  /** 题目列表（自动翻页）。 */
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
    }))
  }

  async challengeDetail(challengeId) {
    const d = await this.request(`/event/${this.eventId}/ctf/${challengeId}/info/`)
    const requiresEnv = Number(d?.task_type) === 1
    const attachment = d?.attachment ? new URL(String(d.attachment), `${this.baseUrl}/`).toString() : ''
    return {
      id: Number(challengeId),
      name: d?.name || `challenge-${challengeId}`,
      descriptionHtml: d?.desc || '',
      description: htmlToMarkdown(d?.desc),
      attachment,
      score: Number(d?.score ?? 0),
      solves: Number(d?.parse_count ?? 0),
      taskType: d?.task_type,
      answerMode: d?.answer_mode,
      requiresEnv,
      connectionInfo: requiresEnv ? '' : formatConnectionInfo({ domain_addr: d?.link_path }).targets.join('\n'),
      checkMode: Number(d?.answer_mode) === 2,
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

  /** 环境题：begin → run → addr。返回连接信息。 */
  async startEnvironment(challengeId) {
    const begin = await this.request(`/event/${this.eventId}/ctf/${challengeId}/begin/`, {
      method: 'POST',
      body: new URLSearchParams(),
    })
    if (begin && typeof begin === 'object' && begin.error) {
      throw new LingxuError(`开启题目失败：${extractMessage(begin)}`, { path: 'begin' })
    }
    if (begin && typeof begin === 'object' && begin.status != null && ![1, 2].includes(Number(begin.status))) {
      throw new LingxuError(`开启题目失败（status=${begin.status}）：${extractMessage(begin)}`, {
        path: 'begin',
        platformStatus: begin.status,
      })
    }

    const run = await this.request(`/event/${this.eventId}/ctf/${challengeId}/run/`, {
      method: 'POST',
      body: new URLSearchParams(),
    })
    if (run && typeof run === 'object' && (run.error || Number(run.status) === 3)) {
      throw new LingxuError(`启动环境失败：${extractMessage(run)}`, { path: 'run', platformStatus: run.status })
    }

    const addr = await this.request(`/event/${this.eventId}/ctf/${challengeId}/addr/`)
    const { targets, hasPrivateOnly } = formatConnectionInfo(addr)
    if (!targets.length) {
      throw new LingxuError('平台未返回环境地址（addr 为空），可能需要人工在页面上确认环境状态', { path: 'addr' })
    }
    return { connectionInfo: targets.join('\n'), targets, hasPrivateOnly, raw: addr }
  }

  async releaseEnvironment(challengeId) {
    const payload = await this.request(`/event/${this.eventId}/ctf/${challengeId}/release/`, {
      method: 'POST',
      body: new URLSearchParams(),
    })
    if (payload && typeof payload === 'object') {
      if (payload.error) throw new LingxuError(`释放环境失败：${extractMessage(payload)}`, { path: 'release' })
      const status = Number(payload.status)
      if (status === 2 || payload.status == null) return { released: true }
      const message = extractMessage(payload)
      if (status === 3 && ['该环境正在释放', '没有运行的环境'].includes(message.trim())) {
        return { released: true, idempotent: true }
      }
      throw new LingxuError(`释放环境失败（status=${payload.status}）：${message}`, {
        path: 'release',
        platformStatus: payload.status,
      })
    }
    return { released: true }
  }

  // ---------------------------------------------------------------- 提交

  /**
   * 提交 flag。
   * @returns {{ status: 'correct'|'incorrect'|'already_solved'|'unknown', message: string, flag: string }}
   */
  async submitFlag(challengeId, flag) {
    const normalized = String(flag ?? '').trim()
    if (!normalized) throw new LingxuError('flag 不能为空')
    const payload = await this.request(`/event/${this.eventId}/ctf/${challengeId}/flag/`, {
      method: 'POST',
      body: new URLSearchParams({ flag: normalized }),
    })
    const message = extractMessage(payload)
    const status = payload && typeof payload === 'object' ? Number(payload.status) : NaN

    if (status === 1) return { status: 'correct', message, flag: normalized }
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
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      types: Array.isArray(t.type) ? t.type : [],
      score: Number(t.score ?? 0),
      count: Number(t.count ?? 0),
      timeSeconds: Number(t.time_seconds ?? 0),
      isBegin: Boolean(t.is_begin),
      isEnd: Boolean(t.is_end),
      answerRule: t.answer_rule,
      parseCount: Number(t.parse_count ?? 0),
    }))
  }

  async beginTheoryTest(testId) {
    const payload = await this.request(`/event/${this.eventId}/test/${testId}/begin/`, {
      method: 'POST',
      body: new URLSearchParams(),
    })
    const status = Number(payload?.status)
    if (status === 1 || status === 2) return { started: true, status, raw: payload }
    throw new LingxuError(`开始理论题失败：${extractMessage(payload)}`, { platformStatus: payload?.status })
  }

  async theoryQuestions(testId) {
    const rows = await this.requestAll(`/event/${this.eventId}/test/${testId}/list/`)
    return rows.map((q, i) => ({
      index: i + 1,
      id: q.id,
      title: htmlToMarkdown(q.title || q.name || q.desc || ''),
      raw: q,
      options: extractOptions(q),
      userOption: q.user_option ?? null,
    }))
  }

  async theoryOrder(testId) {
    return this.request(`/event/${this.eventId}/test/${testId}/order/`)
  }

  async theoryTime(testId) {
    return this.request(`/event/${this.eventId}/test/${testId}/time/`)
  }

  /** 提交单题作答。option 是平台需要的选项值（如 'A' / 'AB' / 'T'）。 */
  async answerTheory(testId, questionId, option) {
    const payload = await this.request(`/event/${this.eventId}/test/${testId}/answer/${questionId}/`, {
      method: 'POST',
      body: new URLSearchParams({ option: String(option) }),
    })
    return { ok: !(payload && payload.error), message: extractMessage(payload), raw: payload }
  }

  /** 交卷（不可逆）。 */
  async finishTheory(testId) {
    const payload = await this.request(`/event/${this.eventId}/test/${testId}/finish/`, {
      method: 'POST',
      body: new URLSearchParams({ status: '1' }),
    })
    return { ok: !(payload && payload.error), message: extractMessage(payload), raw: payload }
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

/** 从题目对象里尽力抽取选项。平台字段名不稳定，做多路兜底。 */
function extractOptions(question) {
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
