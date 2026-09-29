/**
 * 凌虚竞赛平台（Lingxu event CTF）客户端。
 *
 * 零依赖：只用 Node 内置 fetch（Node >= 18）。所有方法只访问调用方传入的 base URL。
 * API 路径与语义来自对真实赛事（event 4）的实测 + HuntingBlade 的 lingxu_event_ctf.py 逆向。
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

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

/** 错误码常量：跨模块按它分派，避免文案耦合。 */
export const LINGXU_CODES = {
  /** sessionid 失效（实测 HTTP 403 + {"detail":"未登录"}）。 */
  SESSION_EXPIRED: 'session-expired',
  /** 平台未给该题配置环境（实测 400 + {"error":"该题目没有选择对应的环境，请联系管理员。"}）。 */
  ENV_NOT_CONFIGURED: 'env-not-configured',
}

/** 平台「未配置环境」的固定文案片段（run / release 都返回它）。 */
export const ENV_NOT_CONFIGURED_HINT = '没有选择对应的环境'

/** 平台「未登录」的标记文案（sessionid 失效；403 为主，200 也一并识别）。 */
export const NOT_LOGGED_IN_HINT = '未登录'

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

/** 构造一个「平台未配置环境」的 LingxuError（保留平台原文案与 HTTP 状态）。 */
function envNotConfiguredError(payload, fallbackPath) {
  const message = extractMessage(payload) || '该题目没有选择对应的环境，请联系管理员。'
  return new LingxuError(`该题在平台上没有配置环境：${message}`, {
    code: LINGXU_CODES.ENV_NOT_CONFIGURED,
    path: fallbackPath,
    platformMessage: message,
    payload,
  })
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

  /**
   * 环境题：begin → run → addr。返回连接信息。
   *
   * 平台对「没有配置环境」的题目会在 run（有时是 begin）直接返回
   * HTTP 400 + `{"error":"该题目没有选择对应的环境，请联系管理员。"}`；
   * 这类错误会被翻译成 `code: 'env-not-configured'`，让上层给出「这题不需要环境」的提示，
   * 而不是一句裸的 HTTP 400。
   */
  async startEnvironment(challengeId) {
    const begin = await this.requestEnv(`/event/${this.eventId}/ctf/${challengeId}/begin/`, {
      method: 'POST',
      body: new URLSearchParams(),
      stage: 'begin',
    })
    if (begin && typeof begin === 'object' && begin.error) {
      if (isEnvNotConfiguredPayload(begin)) throw envNotConfiguredError(begin, 'begin')
      throw new LingxuError(`开启题目失败：${extractMessage(begin)}`, { path: 'begin', payload: begin })
    }
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
    if (run && typeof run === 'object' && (run.error || Number(run.status) === 3)) {
      if (isEnvNotConfiguredPayload(run)) throw envNotConfiguredError(run, 'run')
      throw new LingxuError(`启动环境失败：${extractMessage(run)}`, {
        path: 'run',
        platformStatus: run.status,
        payload: run,
      })
    }

    let addr
    try {
      addr = await this.request(`/event/${this.eventId}/ctf/${challengeId}/addr/`)
    } catch (error) {
      if (isEnvNotConfigured(error)) throw envNotConfiguredError(error.payload ?? error.message, 'addr')
      throw error
    }
    const { targets, hasPrivateOnly } = formatConnectionInfo(addr)
    if (!targets.length) {
      throw new LingxuError('平台未返回环境地址（addr 为空），可能需要人工在页面上确认环境状态', { path: 'addr' })
    }
    return { connectionInfo: targets.join('\n'), targets, hasPrivateOnly, raw: addr }
  }

  /** 发一次「环境相关」请求，把「平台未配置环境」翻译成专门的错误码。 */
  async requestEnv(path, { method = 'POST', body, stage } = {}) {
    try {
      return await this.request(path, { method, body })
    } catch (error) {
      if (isEnvNotConfigured(error)) {
        throw envNotConfiguredError(error.payload ?? error.message, stage || error.path)
      }
      throw error
    }
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
        // ★ 实测：交卷后 is_begin 会变回 false，真正的「已交卷」标记是 is_parse。
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
   * ★ 平台前端真实行为（main.chunk.js）：
   *   `4===option_type ? m.option = answer : m.option = answer.sort()`
   *   `S.post("/event/"+e_id+"/test/"+id+"/answer/"+q.id+"/", m)` —— **JSON body 且 option 是数组**。
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
