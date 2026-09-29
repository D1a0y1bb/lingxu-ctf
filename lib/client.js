/**
 * dsh-lingxu-ctf — Web 控制面板（浏览器半 / browser half）。
 *
 * ## 加载契约（重要，勿改）
 *
 * 本文件是 **classic script**：**不能有顶层 `export`**（那会让浏览器直接 SyntaxError，
 * 面板与配置卡片全部消失）。它由宿主注入进 DSH 的**客户端插件 boot graph**，
 * loader 用 `document.createElement("script")` 抓取，并期待脚本自己调用
 * `window.__ModuleLoader__.load({ id, factory })` 完成注册。
 *
 * 注册成功后，cordis Loader 会创建 entry 并调用 factory 导出的 `apply(ctx)` ——
 * **这是拿到真正 ctx（`ctx.slots` / `ctx.effect`）的唯一途径**，配置卡片之所以能
 * 注册进 Plugins 页的 `plugins.bundle.config` slot，靠的就是它。
 *
 * 宿主侧对应实现：`lib/index.js` 的 `injectBootEntry()` —— 用 `webServer.tapIndex`
 * 往 `window.__DSH_BOOT__` 的 `{ rev, entries, batches }` 里补一条 entry + 一个独立
 * batch（`tapIndex` 在 index 行渲染**之后**执行，所以来得及）。
 *
 * ### 两个已证伪的历史坑（勿回退）
 *   1. 往 `__DSH_BOOT__` 里按**数组** push（dsh-opencode-go-usage 的 injectGraphRow 写法）
 *      在本版本是 **no-op**：`parseBootManifest` 要求 `{rev,entries,batches}` 对象，
 *      且每个 entry 必须归属某个 batch，否则抛 `belongs to no initial-load batch`。
 *   2. `<script type="module">` 注入虽然能跑顶层代码（浮动面板可用），但**拿不到 ctx**，
 *      因此无法注册任何 slot —— 配置卡片永远不会出现。
 *
 * 顶层自挂载（文件末尾）保留：脚本一执行就把浮动面板挂上，不依赖 ctx。
 *
 * ## 数据契约
 *
 *   - `GET /lingxu-ctf/state`  → 浮动面板快照；轮询 5s，页面不可见时暂停。
 *   - `GET /lingxu-ctf/config` → 配置卡片表单（fields / values / secretsSet）。
 *   - `POST /lingxu-ctf/config` body `{ patch }` → 保存配置。
 *
 * **所有字段都做了容错**：缺失即降级为默认值，绝不抛错。
 *
 * ## 安全
 *
 * 题目名 / 负责人 / flag / 配置项全部来自宿主与平台，属于不可信数据；所有插值一律经
 * `escapeHtml()`。secret 字段（cookie / token）**永不回显**，只用 `secretsSet` 表达
 * 「已设置 / 未设置」，且空串是「不修改」哨兵 —— 故不提供清空入口。
 */

;(function () {
  'use strict'

  /** React 运行时：由 factory 里的 require("react") 注入；拿不到就纯 DOM 降级。 */
  let reactRuntime = null

  const name = 'dsh-lingxu-ctf'

  /** 宿主侧注册的快照路由。 */
  const STATE_URL = '/lingxu-ctf/state'

  /** 轮询间隔（毫秒）。 */
  const POLL_INTERVAL_MS = 5000

  /** 面板根元素 id。 */
  const PANEL_ID = 'lingxu-ctf-panel'

  /** 配置卡片根 class（渲染在 Plugins 页，与浮动面板互不影响）。 */
  const CONFIG_CLASS = 'lx-config'

  /** 宿主侧注册的配置路由（GET 读 / POST 写）。 */
  const CONFIG_URL = '/lingxu-ctf/config'

  /** Plugins 页的 bundle 配置 slot 名与 key（key 必须等于包名）。 */
  const CONFIG_SLOT = 'plugins.bundle.config'
  const CONFIG_SLOT_KEY = 'dsh-lingxu-ctf'

  /** 主题变量作用域：浮动面板 + 配置卡片共用一套 token。 */
  const THEME_SCOPE = `#${PANEL_ID},.${CONFIG_CLASS}`

  /** secret 字段的 placeholder 文案（空串是「不修改」哨兵，故不提供清空入口）。 */
  const SECRET_SET_PLACEHOLDER = '已设置（留空则不修改）'
  const SECRET_UNSET_PLACEHOLDER = '未设置'

  /** 平台 → 展示名。 */
  const PLATFORM_LABELS = { lingxu: '凌虚', ctfd: 'CTFd' }

  /** 内联样式表标识（避免重复注入）。 */
  const CSS_ID = 'dsh-lingxu-ctf/panel.css'

  /** 未配置平台时的空态提示。 */
  const NOT_CONFIGURED_HINT = '先调用 ctf_connect 配置平台地址与 sessionid'

  /** 题目状态 → 中文标签。 */
  const STATUS_LABELS = { pending: '待解', working: '进行中', solved: '已解' }

  /** flag 提交状态 → 中文标签。 */
  const SUBMISSION_LABELS = {
    correct: '正确',
    incorrect: '错误',
    wrong: '错误',
    already_solved: '重复正确',
    duplicate: '重复提交',
    error: '异常',
  }

  // ────────────────────────────────────────────────────────────── 基础工具

  const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

  /** 安全取对象。 */
  function obj(value) {
    return isObj(value) ? value : null
  }

  /** 安全取数组。 */
  function list(value) {
    return Array.isArray(value) ? value : []
  }

  /** 安全取字符串。 */
  function str(value, fallback = '') {
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return fallback
  }

  /** 安全取有限数字。 */
  function num(value, fallback = 0) {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  /** HTML 文本转义 —— 所有平台数据插值都必须经过它。 */
  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  /** 秒 → 紧凑中文时长；无效输入返回占位符。 */
  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return '—'
    const total = num(seconds, NaN)
    if (!Number.isFinite(total)) return '—'
    if (total <= 0) return '已结束'
    const whole = Math.floor(total)
    const days = Math.floor(whole / 86400)
    const hours = Math.floor((whole % 86400) / 3600)
    const minutes = Math.floor((whole % 3600) / 60)
    const secs = whole % 60
    if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`
    if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`
    if (minutes > 0) return `${minutes}分${secs}秒`
    return `${secs}秒`
  }

  /** ISO 时间 → 本地 `MM-DD HH:MM:SS`；无法解析时原样返回。 */
  function formatTime(value) {
    const text = str(value)
    if (text === '') return '—'
    const date = new Date(text)
    if (Number.isNaN(date.getTime())) return text
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  /** 超长文本截断。 */
  function truncate(value, max = 24) {
    const text = str(value)
    if (text.length <= max) return text
    return `${text.slice(0, Math.max(1, max - 1))}…`
  }

  // ────────────────────────────────────────────────────────────── 视图模型

  /** 单题归一化：缺失字段全部降级，状态从 `solved` / `status` 双向推断。 */
  function normalizeChallenge(raw) {
    const src = obj(raw) || {}
    const solved = src.solved === true
    const declared = str(src.status).toLowerCase()
    let status = 'pending'
    if (solved || declared === 'solved' || declared === 'done' || declared === 'correct') status = 'solved'
    else if (declared === 'working' || declared === 'in_progress' || declared === 'running' || declared === 'busy') status = 'working'
    return {
      id: src.id ?? null,
      name: str(src.name, `#${str(src.id, '?')}`),
      category: str(src.category, '未分类') || '未分类',
      score: num(src.score, 0),
      solved: status === 'solved',
      status,
      owner: str(src.owner) || null,
      submitAttempts: num(src.submitAttempts, 0),
    }
  }

  /** 快照归一化 —— 面板渲染只吃这个结构，永不直接读原始 JSON。 */
  function normalizeState(raw) {
    const src = obj(raw) || {}
    const connection = obj(src.connection)
    const event = obj(src.event) || {}
    const user = obj(event.user) || {}
    const stats = obj(src.stats) || {}
    const rank = obj(src.rank) || {}
    const self = obj(rank.self)

    const challenges = list(src.challenges).map(normalizeChallenge)
    const solvedCount = challenges.filter((item) => item.status === 'solved').length
    const workingCount = challenges.filter((item) => item.status === 'working').length

    return {
      // 宿主显式给出 configured:false 时以它为准（未配置时返回 {ok:false,configured:false,error}）；
      // 否则「有连接」即视为已配置。
      configured: src.configured === false
        ? false
        : (connection !== null && (str(connection.key) !== '' || str(connection.baseUrl) !== '')),
      error: str(src.error) || null,
      connection: {
        key: str(connection?.key),
        platform: str(connection?.platform, 'lingxu'),
        baseUrl: str(connection?.baseUrl),
        eventId: connection?.eventId ?? null,
        label: str(connection?.label),
      },
      event: {
        name: str(event.name, '未命名赛事'),
        remainingSeconds: event.remainingSeconds === undefined || event.remainingSeconds === null
          ? null
          : num(event.remainingSeconds, null),
        username: str(user.username) || null,
        punish: event.punish === true,
      },
      stats: {
        total: num(stats.total, challenges.length),
        solved: num(stats.solved, solvedCount),
        working: num(stats.working, workingCount),
        pending: num(stats.pending, Math.max(0, challenges.length - solvedCount - workingCount)),
        totalScore: num(stats.totalScore, 0),
      },
      rank: {
        rank: rank.rank === undefined || rank.rank === null ? null : num(rank.rank, null),
        total: rank.total === undefined || rank.total === null ? null : num(rank.total, null),
        self,
      },
      challenges,
      leaderboard: list(src.leaderboard).map((row) => {
        const item = obj(row) || {}
        return {
          rank: num(item.rank, 0),
          username: str(item.username, '未知'),
          score: num(item.score, 0),
          isSelf: item.isSelf === true,
        }
      }),
      submissions: list(src.submissions).map((row) => {
        const item = obj(row) || {}
        return {
          at: str(item.at),
          challengeId: item.challengeId ?? null,
          challengeName: str(item.challengeName, `#${str(item.challengeId, '?')}`),
          status: str(item.status, 'unknown').toLowerCase(),
          flag: str(item.flag),
        }
      }),
      theory: list(src.theory).map((row) => {
        const item = obj(row) || {}
        return {
          id: item.id ?? null,
          name: str(item.name, '理论题'),
          count: num(item.count, 0),
          isBegin: item.isBegin === true,
          remainingSeconds: item.remainingSeconds === undefined || item.remainingSeconds === null
            ? null
            : num(item.remainingSeconds, null),
        }
      }),
    }
  }

  // ────────────────────────────────────────────────────────────── 过滤 / 分组

  /** 题目分类列表（保持首次出现顺序）。 */
  function challengeCategories(challenges) {
    const seen = []
    for (const item of list(challenges)) {
      const category = str(obj(item)?.category, '未分类') || '未分类'
      if (!seen.includes(category)) seen.push(category)
    }
    return seen
  }

  /** 按分类 + 状态 + 关键字过滤。 */
  function filterChallenges(challenges, filters = {}) {
    const category = str(filters.category, 'all') || 'all'
    const status = str(filters.status, 'all') || 'all'
    const query = str(filters.query).trim().toLowerCase()
    return list(challenges).filter((item) => {
      if (category !== 'all' && item.category !== category) return false
      if (status !== 'all' && item.status !== status) return false
      if (query !== '') {
        const haystack = `${item.name} ${item.category} ${item.owner ?? ''}`.toLowerCase()
        if (!haystack.includes(query)) return false
      }
      return true
    })
  }

  /** 按分类分组，保留原顺序。 */
  function groupChallenges(challenges) {
    const groups = new Map()
    for (const item of list(challenges)) {
      if (!groups.has(item.category)) groups.set(item.category, [])
      groups.get(item.category).push(item)
    }
    return [...groups.entries()].map(([category, items]) => ({
      category,
      items,
      solved: items.filter((entry) => entry.status === 'solved').length,
    }))
  }

  // ────────────────────────────────────────────────────────────── 各区域 HTML

  /** 头部胶囊：平台 / 赛事 / 剩余时间 / 我的分数与排名。 */
  function renderHeaderMetaHtml(state) {
    const chips = []
    chips.push(`<span class="lx-chip">${escapeHtml(state.connection.platform)}</span>`)
    if (state.connection.eventId !== null && state.connection.eventId !== undefined) {
      chips.push(`<span class="lx-chip">赛事 #${escapeHtml(state.connection.eventId)}</span>`)
    }
    if (state.event.remainingSeconds !== null) {
      chips.push(`<span class="lx-chip">剩余 ${escapeHtml(formatDuration(state.event.remainingSeconds))}</span>`)
    }
    chips.push(`<span class="lx-chip lx-chip-strong">得分 ${escapeHtml(state.stats.totalScore)}</span>`)
    if (state.rank.rank !== null) {
      const total = state.rank.total !== null ? `/${escapeHtml(state.rank.total)}` : ''
      chips.push(`<span class="lx-chip">排名 ${escapeHtml(state.rank.rank)}${total}</span>`)
    }
    if (state.event.username) {
      chips.push(`<span class="lx-chip">@${escapeHtml(state.event.username)}</span>`)
    }
    if (state.event.punish) {
      chips.push('<span class="lx-chip lx-chip-warn" title="该赛事错误提交会扣分">错误提交扣分中</span>')
    }
    return chips.join('')
  }

  /** 统计条：总数 / 已解 / 进行中 / 待解 / 总分。 */
  function renderStatsHtml(state) {
    const cells = [
      ['总数', state.stats.total, ''],
      ['已解', state.stats.solved, 'lx-ok'],
      ['进行中', state.stats.working, 'lx-info'],
      ['待解', state.stats.pending, 'lx-dim'],
      ['总分', state.stats.totalScore, ''],
    ]
    return cells
      .map(([label, value, tone]) => (
        `<div class="lx-stat ${tone}"><span class="lx-stat-value">${escapeHtml(value)}</span>`
        + `<span class="lx-stat-label">${escapeHtml(label)}</span></div>`
      ))
      .join('')
  }

  /** 单张题目卡片。 */
  function renderChallengeCard(item) {
    const owner = item.owner ? `<span class="lx-owner" title="负责人">@${escapeHtml(item.owner)}</span>` : ''
    const attempts = item.submitAttempts > 0
      ? `<span class="lx-attempts" title="已提交 flag 次数">提交 ${escapeHtml(item.submitAttempts)} 次</span>`
      : ''
    return '<div class="lx-card lx-st-' + escapeHtml(item.status) + '">'
      + '<div class="lx-card-top">'
      + `<span class="lx-card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>`
      + `<span class="lx-card-score">${escapeHtml(item.score)}</span>`
      + '</div>'
      + '<div class="lx-card-meta">'
      + `<span class="lx-pill lx-pill-${escapeHtml(item.status)}">${escapeHtml(STATUS_LABELS[item.status] || item.status)}</span>`
      + owner
      + attempts
      + '</div>'
      + '</div>'
  }

  /** 题目看板：按分类分组。 */
  function renderBoardHtml(state, filters = {}) {
    const visible = filterChallenges(state.challenges, filters)
    if (visible.length === 0) {
      const hint = state.challenges.length === 0 ? '暂无题目数据' : '没有符合筛选条件的题目'
      return `<div class="lx-empty">${escapeHtml(hint)}</div>`
    }
    return groupChallenges(visible)
      .map((group) => {
        const cards = group.items.map(renderChallengeCard).join('')
        return '<div class="lx-group">'
          + '<div class="lx-group-head">'
          + `<span class="lx-group-name">${escapeHtml(group.category)}</span>`
          + `<span class="lx-group-count">${escapeHtml(group.solved)}/${escapeHtml(group.items.length)}</span>`
          + '</div>'
          + `<div class="lx-cards">${cards}</div>`
          + '</div>'
      })
      .join('')
  }

  /** 排行榜：前 20，标出自己。 */
  function renderLeaderboardHtml(state) {
    const rows = state.leaderboard.slice(0, 20)
    if (rows.length === 0) return '<div class="lx-empty">暂无排行榜数据</div>'
    const body = rows
      .map((row) => {
        const cls = row.isSelf ? ' class="lx-self"' : ''
        const badge = row.isSelf ? '<span class="lx-you">我</span>' : ''
        return `<tr${cls}><td class="lx-num">${escapeHtml(row.rank)}</td>`
          + `<td class="lx-user">${escapeHtml(row.username)}${badge}</td>`
          + `<td class="lx-num">${escapeHtml(row.score)}</td></tr>`
      })
      .join('')
    return '<table class="lx-table"><thead><tr><th>#</th><th>选手</th><th>分数</th></tr></thead>'
      + `<tbody>${body}</tbody></table>`
  }

  /** 提交审计：最近 20 条。 */
  function renderSubmissionsHtml(state) {
    const rows = state.submissions.slice(0, 20)
    if (rows.length === 0) return '<div class="lx-empty">暂无 flag 提交记录</div>'
    const body = rows
      .map((row) => {
        const label = SUBMISSION_LABELS[row.status] || row.status
        return `<tr><td class="lx-time">${escapeHtml(formatTime(row.at))}</td>`
          + `<td class="lx-user" title="${escapeHtml(row.challengeName)}">${escapeHtml(truncate(row.challengeName, 18))}</td>`
          + `<td><span class="lx-sub lx-sub-${escapeHtml(row.status)}">${escapeHtml(label)}</span></td>`
          + `<td class="lx-flag">${escapeHtml(truncate(row.flag, 16))}</td></tr>`
      })
      .join('')
    return '<table class="lx-table"><thead><tr><th>时间</th><th>题目</th><th>状态</th><th>flag</th></tr></thead>'
      + `<tbody>${body}</tbody></table>`
  }

  /** 理论题：试卷状态 / 题量 / 剩余时间。 */
  function renderTheoryHtml(state) {
    if (state.theory.length === 0) return '<div class="lx-empty">暂无理论题试卷</div>'
    return state.theory
      .map((paper) => {
        const stateText = paper.isBegin ? '进行中' : '未开始'
        const tone = paper.isBegin ? 'lx-info' : 'lx-dim'
        const remaining = paper.remainingSeconds !== null
          ? `<span class="lx-theory-time">剩余 ${escapeHtml(formatDuration(paper.remainingSeconds))}</span>`
          : ''
        return '<div class="lx-theory-item">'
          + `<span class="lx-theory-name">${escapeHtml(paper.name)}</span>`
          + `<span class="lx-pill ${tone}">${escapeHtml(stateText)}</span>`
          + `<span class="lx-theory-count">${escapeHtml(paper.count)} 题</span>`
          + remaining
          + '</div>'
      })
      .join('')
  }

  /** 状态行：错误态 / 空态 / 加载态。 */
  function renderStatusHtml(state, meta = {}) {
    if (meta.error) {
      return `<div class="lx-alert lx-alert-error"><b>加载失败</b>：${escapeHtml(meta.error)}`
        + '<button class="lx-link lx-retry" type="button">重试</button></div>'
    }
    if (meta.loading && !meta.loaded) {
      return '<div class="lx-alert lx-alert-dim">正在加载面板数据…</div>'
    }
    if (!state.configured) {
      return `<div class="lx-alert lx-alert-warn">尚未连接竞赛平台：${escapeHtml(NOT_CONFIGURED_HINT)}</div>`
    }
    if (state.error) {
      return `<div class="lx-alert lx-alert-error">${escapeHtml(state.error)}</div>`
    }
    return ''
  }

  // ────────────────────────────────────────────────────────────── 配置卡片

  /** 配置快照归一化：字段缺失、类型未知一律降级，绝不抛错。 */
  function normalizeConfig(raw) {
    const src = obj(raw) || {}
    const values = obj(src.values) || {}
    const secretsSet = obj(src.secretsSet) || {}
    const fields = list(src.fields)
      .map((entry) => {
        const field = obj(entry) || {}
        const declared = str(field.type)
        const type = ['string', 'number', 'boolean', 'union'].includes(declared) ? declared : 'string'
        const role = str(field.role) || null
        return {
          key: str(field.key),
          type,
          description: str(field.description),
          role,
          secret: role === 'secret',
          default: field.default,
          options: list(field.options).map((option) => str(option)).filter((option) => option !== ''),
        }
      })
      .filter((field) => field.key !== '')
    return {
      ok: src.ok !== false,
      error: str(src.error) || null,
      fields,
      values,
      secretsSet,
    }
  }

  /** 字段 → 控件种类。secret 优先（secret 也可能是 string 类型）。 */
  function configFieldKind(field) {
    if (field === null || typeof field !== 'object') return 'text'
    if (field.secret === true || field.role === 'secret') return 'password'
    if (field.type === 'boolean') return 'boolean'
    if (field.type === 'number') return 'number'
    if (field.type === 'union') return 'select'
    return 'text'
  }

  /** 摘要一句话：`平台：凌虚 · event 4 · 已配置`。 */
  function renderConfigSummary(config) {
    if (config === null || config === undefined || config.ok === false) {
      return `配置不可用：${str(obj(config)?.error, '未知错误')}`
    }
    const values = obj(config.values) || {}
    const parts = [`平台：${PLATFORM_LABELS[str(values.platform)] || str(values.platform, '未设置')}`]
    const eventId = values.eventId
    if (eventId !== undefined && eventId !== null && str(eventId) !== '') parts.push(`event ${str(eventId)}`)
    const hasBase = str(values.baseUrl) !== ''
    const secrets = obj(config.secretsSet) || {}
    const hasSecret = secrets.cookie === true || secrets.token === true
    parts.push(hasBase && hasSecret ? '已配置' : '未配置')
    return parts.join(' · ')
  }

  /**
   * 把表单草稿折成 POST 的 `patch`。规则：
   *   - 只回传**确实改动过**的字段（避免无谓覆盖）
   *   - secret 字段为空串时**绝不回传**（空串是「不修改」哨兵，且不提供清空入口）
   *   - number 为空或非数字时跳过；boolean 按勾选态比对
   */
  function collectConfigPatch(config, draft) {
    const patch = {}
    const values = obj(obj(config)?.values) || {}
    const draftObj = obj(draft) || {}
    for (const field of list(obj(config)?.fields)) {
      const key = field.key
      const kind = configFieldKind(field)
      const next = draftObj[key]
      const current = values[key]
      if (kind === 'boolean') {
        const wanted = next === true
        if (wanted !== (current === true)) patch[key] = wanted
        continue
      }
      if (kind === 'password') {
        const text = str(next)
        if (text !== '') patch[key] = text
        continue
      }
      if (kind === 'number') {
        const text = str(next).trim()
        if (text === '') continue
        const parsed = Number(text)
        if (!Number.isFinite(parsed)) continue
        if (parsed !== Number(current)) patch[key] = parsed
        continue
      }
      const text = str(next)
      if (text !== str(current)) patch[key] = text
    }
    return patch
  }

  /**
   * 配置卡片控制器（纯 DOM）。
   *
   * secret 字段**永不回显**：`values[key]` 恒为空串，输入框始终从空开始，
   * 只用 placeholder 表达 `secretsSet[key]` 的「已设置 / 未设置」。
   */
  function createConfigCard(options = {}) {
    const doc = options.doc || (typeof document !== 'undefined' ? document : null)
    const url = str(options.url, CONFIG_URL) || CONFIG_URL
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)

    const state = {
      config: null,
      error: null,
      loading: true,
      saving: false,
      saved: false,
      notice: null,
    }

    let controls = new Map()
    let regions = null
    const card = doc && typeof doc.createElement === 'function' ? build() : null

    function build() {
      const root = el(doc, 'div', CONFIG_CLASS)
      const title = el(doc, 'div', 'lx-config-title')
      title.textContent = '凌虚 CTF 配置'
      const desc = el(doc, 'div', 'lx-config-desc')
      desc.textContent = '配置平台连接、并发与护栏。Cookie / Token 只保存在 DSH 本地存储，不会回显。'

      const status = el(doc, 'div', 'lx-config-status')
      status.textContent = '正在读取配置…'
      const grid = el(doc, 'div', 'lx-config-grid')

      const actions = el(doc, 'div', 'lx-config-actions')
      const saveBtn = el(doc, 'button', 'lx-config-save')
      saveBtn.type = 'button'
      saveBtn.textContent = '保存'
      const reloadBtn = el(doc, 'button', 'lx-config-reload')
      reloadBtn.type = 'button'
      reloadBtn.textContent = '重新加载'
      actions.appendChild(saveBtn)
      actions.appendChild(reloadBtn)

      root.appendChild(title)
      root.appendChild(desc)
      root.appendChild(status)
      root.appendChild(grid)
      root.appendChild(actions)

      saveBtn.addEventListener('click', () => { void save() })
      reloadBtn.addEventListener('click', () => { void refresh() })

      regions = { status, grid, saveBtn, reloadBtn }
      return root
    }

    /** 依据 config.fields 重建表单（每次刷新都重建，保证与最新 schema 一致）。 */
    function renderFields() {
      if (!regions) return
      const config = state.config
      regions.grid.innerHTML = ''
      controls = new Map()
      if (!config || config.ok === false) return

      for (const field of config.fields) {
        const kind = configFieldKind(field)
        const wrap = el(doc, 'label', 'lx-config-field')
        // 描述较长或路径类字段占满整行，避免输入框被挤扁
        if (field.description.length > 60 || field.key === 'workDir') wrap.className = 'lx-config-field lx-span-2'
        const caption = el(doc, 'span', 'lx-config-label')
        caption.textContent = field.key

        if (kind === 'boolean') {
          wrap.className = 'lx-config-field lx-config-check'
          const input = el(doc, 'input')
          input.type = 'checkbox'
          input.name = field.key
          input.checked = config.values[field.key] === true
          wrap.appendChild(input)
          wrap.appendChild(caption)
          controls.set(field.key, input)
        } else {
          wrap.appendChild(caption)
          let input
          if (kind === 'select') {
            input = el(doc, 'select')
            for (const option of field.options) {
              const node = el(doc, 'option')
              node.value = option
              node.textContent = option
              input.appendChild(node)
            }
            input.value = str(config.values[field.key], str(field.default))
          } else if (kind === 'password') {
            input = el(doc, 'input')
            input.type = 'password'
            input.autocomplete = 'new-password'
            // 关键：secret 绝不回显，输入框恒为空
            input.value = ''
            input.placeholder = config.secretsSet[field.key] === true ? SECRET_SET_PLACEHOLDER : SECRET_UNSET_PLACEHOLDER
          } else {
            input = el(doc, 'input')
            input.type = kind === 'number' ? 'number' : 'text'
            const value = config.values[field.key]
            input.value = value === undefined || value === null ? '' : String(value)
          }
          input.name = field.key
          wrap.appendChild(input)
          controls.set(field.key, input)
        }

        if (field.description !== '') {
          const help = el(doc, 'span', 'lx-config-help')
          help.textContent = field.description
          wrap.appendChild(help)
        }
        if (field.secret) {
          const hint = el(doc, 'span', 'lx-config-secret')
          hint.textContent = config.secretsSet[field.key] === true ? '当前：已设置' : '当前：未设置'
          wrap.appendChild(hint)
        }
        regions.grid.appendChild(wrap)
      }
    }

    function readDraft() {
      const draft = {}
      for (const [key, input] of controls) {
        draft[key] = input.type === 'checkbox' ? input.checked === true : str(input.value)
      }
      return draft
    }

    function setStatus(text, tone) {
      if (!regions) return
      regions.status.className = tone ? `lx-config-status ${tone}` : 'lx-config-status'
      regions.status.textContent = text
    }

    function patch() {
      if (!regions) return
      const config = state.config
      const usable = config !== null && config.ok !== false
      if (state.error !== null) setStatus(state.error, 'lx-err-text')
      else if (state.saved) setStatus('已保存', 'lx-ok-text')
      else if (state.notice !== null) setStatus(state.notice, null)
      else if (state.loading) setStatus('正在读取配置…', null)
      else if (usable) setStatus(`共 ${config.fields.length} 项配置`, null)
      else setStatus('', null)

      regions.saveBtn.disabled = state.saving || state.loading || !usable
      regions.reloadBtn.disabled = state.saving || state.loading
      regions.saveBtn.textContent = state.saving ? '保存中…' : '保存'
    }

    /** GET 配置并重建表单。 */
    async function refresh() {
      state.loading = true
      state.saved = false
      state.notice = null
      state.error = null
      patch()
      if (fetchImpl === null) {
        state.loading = false
        state.error = '当前环境不支持 fetch，无法读取配置'
        patch()
        return
      }
      try {
        const response = await fetchImpl(url, { cache: 'no-store', headers: { accept: 'application/json' } })
        let payload = null
        if (response && typeof response.json === 'function') payload = await response.json().catch(() => null)
        if (!response || response.ok === false) {
          const detail = payload && payload.error ? String(payload.error) : `HTTP ${response && response.status !== undefined ? response.status : '?'}`
          state.config = null
          state.error = `读取配置失败：${detail}`
        } else if (payload === null) {
          state.config = null
          state.error = '读取配置失败：响应不是合法 JSON'
        } else {
          state.config = normalizeConfig(payload)
          if (state.config.ok === false) {
            state.error = `配置不可用：${state.config.error || '未知错误'}`
          } else {
            renderFields()
          }
        }
      } catch (error) {
        state.config = null
        state.error = `读取配置失败：${String((error && error.message) || error)}`
      } finally {
        state.loading = false
        patch()
      }
    }

    /** POST 改动，成功后重新 GET 刷新。 */
    async function save() {
      if (state.saving) return
      const config = state.config
      if (!config || config.ok === false) return
      const patchBody = collectConfigPatch(config, readDraft())
      if (Object.keys(patchBody).length === 0) {
        state.saved = false
        state.error = null
        state.notice = '没有需要保存的改动'
        patch()
        return
      }
      if (fetchImpl === null) {
        state.error = '当前环境不支持 fetch，无法保存配置'
        patch()
        return
      }
      state.saving = true
      state.saved = false
      state.notice = null
      state.error = null
      patch()
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ patch: patchBody }),
        })
        let payload = null
        if (response && typeof response.json === 'function') payload = await response.json().catch(() => null)
        if (!response || response.ok === false || !payload || payload.ok === false) {
          const detail = payload && payload.error ? String(payload.error) : `HTTP ${response && response.status !== undefined ? response.status : '?'}`
          state.saving = false
          state.error = `保存失败：${detail}`
          patch()
          return
        }
        state.saving = false
        state.saved = true
        patch()
        // 保存后重新拉取，让表单回到服务端权威值（secret 输入框也会被清空）
        await refresh()
        state.saved = true
        patch()
      } catch (error) {
        state.saving = false
        state.error = `保存失败：${String((error && error.message) || error)}`
        patch()
      }
    }

    function destroy() {
      if (card && typeof card.remove === 'function') card.remove()
      controls = new Map()
      regions = null
    }

    return {
      element: card,
      refresh,
      save,
      destroy,
      readDraft,
      get state() { return state },
    }
  }

  // ────────────────────────────────────────────────────────────── 样式

  /**
   * 主题：优先 DSH 主题 token（`--dsw-alias-*`，0.2.0-rc.1 实际存在的命名空间），
   * 取不到时按 `prefers-color-scheme` 退化为中性配色 —— 保证深色主题下也可读。
   * 注意：任务书里写的 `--dsh-color-*` 在安装包中**不存在**（0 次命中），故不采用。
   */
  function panelCss() {
    return [
      `${THEME_SCOPE}{`,
      '--lx-bg:var(--dsw-alias-bg-layer-2,#ffffff);',
      '--lx-bg-soft:var(--dsw-alias-bg-layer-1,#f6f6f7);',
      '--lx-fg:var(--dsw-alias-label-primary,#1a1a1c);',
      '--lx-dim:var(--dsw-alias-label-secondary,#5c5c66);',
      '--lx-faint:var(--dsw-alias-label-tertiary,#8a8a94);',
      '--lx-border:var(--dsw-alias-border-l2,rgba(0,0,0,.14));',
      '--lx-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));',
      '--lx-ok:var(--dsw-alias-state-success-primary,#0a7d43);',
      '--lx-warn:var(--dsw-alias-state-warn-primary,#9a6700);',
      '--lx-err:var(--dsw-alias-state-error-primary,#c0392b);',
      '--lx-info:var(--dsw-alias-state-business-primary,#0b62c4);',
      '--lx-accent:var(--dsw-alias-brand-primary,#4c6ef5);',
      '--lx-on-accent:var(--dsw-alias-label-primary-foreground,#ffffff);',
      'position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;',
      'align-items:flex-end;gap:8px;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
      'color:var(--lx-fg);text-align:left;',
      '}',
      `@media (prefers-color-scheme:dark){${THEME_SCOPE}{`,
      '--lx-bg:var(--dsw-alias-bg-layer-2,#1c1c1f);',
      '--lx-bg-soft:var(--dsw-alias-bg-layer-1,#141416);',
      '--lx-fg:var(--dsw-alias-label-primary,#f2f2f4);',
      '--lx-dim:var(--dsw-alias-label-secondary,#a2a2ac);',
      '--lx-faint:var(--dsw-alias-label-tertiary,#78787f);',
      '--lx-border:var(--dsw-alias-border-l2,rgba(255,255,255,.18));',
      '--lx-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));',
      '--lx-ok:var(--dsw-alias-state-success-primary,#3ddc84);',
      '--lx-warn:var(--dsw-alias-state-warn-primary,#f0b429);',
      '--lx-err:var(--dsw-alias-state-error-primary,#ff6b6b);',
      '--lx-info:var(--dsw-alias-state-business-primary,#6ea8fe);',
      '--lx-accent:var(--dsw-alias-brand-primary,#7c93ff);',
      '--lx-on-accent:var(--dsw-alias-label-primary-foreground,#10101a);',
      '}}',
      `#${PANEL_ID}.lx-docked{position:static;right:auto;bottom:auto;align-items:stretch;width:100%;}`,
      `#${PANEL_ID} *{box-sizing:border-box;}`,
      `.lx-drawer{display:flex;flex-direction:column;width:440px;max-width:calc(100vw - 32px);`,
      'max-height:min(72vh,760px);border:1px solid var(--lx-border);border-radius:12px;background:var(--lx-bg);',
      'box-shadow:0 12px 32px rgba(0,0,0,.28);overflow:hidden;}',
      `#${PANEL_ID}.lx-docked .lx-drawer{width:100%;max-width:none;max-height:none;box-shadow:none;}`,
      `#${PANEL_ID}[data-collapsed="true"] .lx-drawer{display:none;}`,
      '.lx-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:10px 12px;',
      'border-bottom:1px solid var(--lx-border);background:var(--lx-bg-soft);}',
      '.lx-title{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.lx-name{font-size:13px;font-weight:600;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-sub{font-size:10px;line-height:14px;color:var(--lx-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-head-actions{display:flex;gap:6px;flex:none;}',
      '.lx-btn{border:1px solid var(--lx-border);border-radius:6px;background:transparent;color:var(--lx-dim);',
      'font:inherit;font-size:11px;line-height:16px;padding:2px 8px;cursor:pointer;}',
      '.lx-btn:hover{background:var(--lx-hover);color:var(--lx-fg);}',
      '.lx-link{border:none;background:none;color:var(--lx-accent);font:inherit;cursor:pointer;padding:0 4px;text-decoration:underline;}',
      '.lx-status:empty{display:none;}',
      '.lx-alert{margin:8px 12px 0;padding:6px 8px;border-radius:6px;font-size:11px;line-height:16px;border:1px solid var(--lx-border);}',
      '.lx-alert-error{color:var(--lx-err);border-color:var(--lx-err);}',
      '.lx-alert-warn{color:var(--lx-warn);border-color:var(--lx-warn);}',
      '.lx-alert-dim{color:var(--lx-dim);}',
      '.lx-meta{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px 0;}',
      '.lx-chip{display:inline-block;padding:1px 6px;border-radius:8px;background:var(--lx-hover);',
      'font-size:10px;line-height:16px;color:var(--lx-dim);}',
      '.lx-chip-strong{color:var(--lx-fg);font-weight:600;}',
      '.lx-chip-warn{color:var(--lx-warn);}',
      '.lx-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;margin:8px 12px 0;',
      'border:1px solid var(--lx-border);border-radius:8px;overflow:hidden;background:var(--lx-border);}',
      '.lx-stat{display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 2px;background:var(--lx-bg);}',
      '.lx-stat-value{font-size:14px;font-weight:600;line-height:18px;}',
      '.lx-stat-label{font-size:9px;line-height:12px;color:var(--lx-faint);}',
      '.lx-ok .lx-stat-value{color:var(--lx-ok);}',
      '.lx-info .lx-stat-value{color:var(--lx-info);}',
      '.lx-dim .lx-stat-value{color:var(--lx-dim);}',
      '.lx-controls{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px 0;}',
      '.lx-controls select,.lx-controls input{border:1px solid var(--lx-border);border-radius:6px;',
      'background:var(--lx-bg-soft);color:var(--lx-fg);font:inherit;font-size:11px;line-height:16px;padding:3px 6px;min-width:0;}',
      '.lx-controls input{flex:1;min-width:90px;}',
      '.lx-body{display:flex;flex-direction:column;gap:12px;padding:10px 12px 12px;overflow:auto;}',
      '.lx-section{display:flex;flex-direction:column;gap:6px;}',
      '.lx-section-title{font-size:11px;font-weight:600;line-height:16px;color:var(--lx-dim);',
      'text-transform:uppercase;letter-spacing:.04em;}',
      '.lx-group{display:flex;flex-direction:column;gap:4px;}',
      '.lx-group+.lx-group{margin-top:8px;}',
      '.lx-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'font-size:11px;line-height:16px;color:var(--lx-dim);font-weight:600;}',
      '.lx-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px;}',
      '.lx-card{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border:1px solid var(--lx-border);',
      'border-left-width:3px;border-radius:8px;background:var(--lx-bg-soft);min-width:0;}',
      '.lx-card.lx-st-solved{border-left-color:var(--lx-ok);}',
      '.lx-card.lx-st-working{border-left-color:var(--lx-info);}',
      '.lx-card.lx-st-pending{border-left-color:var(--lx-border);}',
      '.lx-card-top{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0;}',
      '.lx-card-name{font-size:12px;font-weight:600;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-card-score{font-size:11px;line-height:16px;color:var(--lx-dim);flex:none;}',
      '.lx-card-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px;font-size:10px;line-height:14px;color:var(--lx-faint);}',
      '.lx-pill{display:inline-block;padding:0 5px;border-radius:7px;font-size:10px;line-height:15px;background:var(--lx-hover);color:var(--lx-dim);}',
      '.lx-pill-solved{color:var(--lx-ok);}',
      '.lx-pill-working{color:var(--lx-info);}',
      '.lx-pill-pending{color:var(--lx-faint);}',
      '.lx-owner{color:var(--lx-accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px;}',
      '.lx-table{width:100%;border-collapse:collapse;font-size:11px;line-height:16px;}',
      '.lx-table th{text-align:left;font-weight:600;color:var(--lx-faint);border-bottom:1px solid var(--lx-border);padding:2px 4px;}',
      '.lx-table td{padding:2px 4px;border-bottom:1px solid var(--lx-border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-table tr.lx-self{background:var(--lx-hover);font-weight:600;}',
      '.lx-num{text-align:right;font-variant-numeric:tabular-nums;}',
      '.lx-time{color:var(--lx-faint);font-variant-numeric:tabular-nums;}',
      '.lx-you{display:inline-block;margin-left:4px;padding:0 4px;border-radius:6px;background:var(--lx-accent);',
      'color:var(--lx-on-accent);font-size:9px;line-height:13px;}',
      '.lx-sub{display:inline-block;padding:0 5px;border-radius:7px;font-size:10px;line-height:15px;background:var(--lx-hover);}',
      '.lx-sub-correct{color:var(--lx-ok);}',
      '.lx-sub-incorrect,.lx-sub-wrong,.lx-sub-error{color:var(--lx-err);}',
      '.lx-sub-already_solved,.lx-sub-duplicate{color:var(--lx-warn);}',
      '.lx-flag{color:var(--lx-faint);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
      '.lx-theory-item{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 8px;',
      'border:1px solid var(--lx-border);border-radius:8px;background:var(--lx-bg-soft);font-size:11px;line-height:16px;}',
      '.lx-theory-name{font-weight:600;}',
      '.lx-theory-count,.lx-theory-time{color:var(--lx-faint);}',
      '.lx-empty{padding:8px;border:1px dashed var(--lx-border);border-radius:8px;',
      'color:var(--lx-faint);font-size:11px;line-height:16px;text-align:center;}',
      '.lx-launcher{display:flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--lx-border);',
      'border-radius:999px;background:var(--lx-bg);color:var(--lx-fg);font:inherit;font-size:12px;font-weight:600;',
      'cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.24);}',
      '.lx-launcher:hover{background:var(--lx-hover);}',
      '.lx-launcher-dot{width:7px;height:7px;border-radius:50%;background:var(--lx-faint);flex:none;}',
      '.lx-launcher-dot.lx-dot-ok{background:var(--lx-ok);}',
      '.lx-launcher-dot.lx-dot-err{background:var(--lx-err);}',
      `#${PANEL_ID}.lx-docked .lx-launcher{display:none;}`,
      // ── 配置卡片（渲染在 Plugins 页，不在 #lingxu-ctf-panel 内，故自带 .lx-config 作用域）──
      '.lx-config{display:flex;flex-direction:column;gap:10px;padding:12px;margin:0;list-style:none;',
      'border:1px solid var(--lx-border);border-radius:10px;background:var(--lx-bg);color:var(--lx-fg);',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;text-align:left;}',
      '.lx-config *{box-sizing:border-box;}',
      '.lx-config-title{font-size:14px;line-height:20px;font-weight:600;}',
      '.lx-config-desc{font-size:12px;line-height:18px;color:var(--lx-dim);}',
      '.lx-config-status{font-size:12px;line-height:18px;color:var(--lx-dim);}',
      '.lx-config-status.lx-ok-text{color:var(--lx-ok);}',
      '.lx-config-status.lx-err-text{color:var(--lx-err);}',
      '.lx-config-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;}',
      '.lx-config-field{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.lx-config-field.lx-span-2{grid-column:1/-1;}',
      '.lx-config-label{font-size:12px;line-height:18px;font-weight:500;color:var(--lx-fg);}',
      '.lx-config-field input[type=text],.lx-config-field input[type=number],',
      '.lx-config-field input[type=password],.lx-config-field select{',
      'box-sizing:border-box;width:100%;min-height:30px;padding:4px 8px;border:1px solid var(--lx-border);',
      'border-radius:6px;background:var(--lx-bg-soft);color:var(--lx-fg);font:inherit;}',
      '.lx-config-field input:focus,.lx-config-field select:focus{outline:none;border-color:var(--lx-accent);}',
      '.lx-config-field input:disabled,.lx-config-field select:disabled{opacity:.55;}',
      '.lx-config-check{display:flex;align-items:center;gap:6px;min-height:30px;cursor:pointer;}',
      '.lx-config-check input{margin:0;flex:none;}',
      '.lx-config-help{font-size:11px;line-height:16px;color:var(--lx-faint);}',
      '.lx-config-secret{font-size:11px;line-height:16px;color:var(--lx-warn);}',
      '.lx-config-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.lx-config-save{min-height:30px;padding:4px 14px;border:none;border-radius:6px;',
      'background:var(--lx-accent);color:var(--lx-on-accent);font:inherit;font-weight:600;cursor:pointer;}',
      '.lx-config-save:hover{opacity:.9;}',
      '.lx-config-save:disabled{opacity:.45;cursor:default;}',
      '.lx-config-reload{min-height:30px;padding:4px 12px;border:1px solid var(--lx-border);border-radius:6px;',
      'background:transparent;color:var(--lx-dim);font:inherit;cursor:pointer;}',
      '.lx-config-reload:hover{background:var(--lx-hover);color:var(--lx-fg);}',
      '.lx-config-reload:disabled{opacity:.45;cursor:default;}',
      '.lx-config-host{display:block;}',
    ].join('')
  }

  /** 注入样式表（幂等）。 */
  function ensureStyles(doc) {
    if (!doc || typeof doc.createElement !== 'function') return
    if (typeof doc.querySelector === 'function' && doc.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return
    const tag = doc.createElement('style')
    if (tag.dataset) {
      tag.dataset.plugin = name
      tag.dataset.pluginCss = CSS_ID
    }
    tag.textContent = panelCss()
    const head = doc.head || doc.documentElement
    if (head && typeof head.appendChild === 'function') head.appendChild(tag)
  }

  // ────────────────────────────────────────────────────────────── 面板控制器

  /** 找到可停靠的宿主容器；找不到返回 null（→ 浮动模式）。 */
  function findHostContainer(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null
    for (const selector of ['[data-lingxu-ctf-mount]', '#lingxu-ctf-mount', '.lingxu-ctf-mount']) {
      try {
        const found = doc.querySelector(selector)
        if (found) return found
      } catch {
        /* 选择器不被支持时忽略 */
      }
    }
    return null
  }

  /** 创建元素的小助手。 */
  function el(doc, tag, className) {
    const node = doc.createElement(tag)
    if (className) node.className = className
    return node
  }

  /**
   * 面板控制器：先建一次骨架（保证搜索框等交互元素不随轮询重建），
   * 之后只按区域刷新 `innerHTML`。
   *
   * @param {{doc?:Document,win?:Window,fetchImpl?:Function,url?:string,intervalMs?:number}} options
   */
  function createPanel(options = {}) {
    const doc = options.doc || (typeof document !== 'undefined' ? document : null)
    const win = options.win || (typeof window !== 'undefined' ? window : null)
    const url = str(options.url, STATE_URL) || STATE_URL
    const intervalMs = num(options.intervalMs, POLL_INTERVAL_MS)
    const fetchImpl = options.fetchImpl
      || (typeof fetch === 'function' ? fetch : null)

    const state = {
      snapshot: normalizeState(null),
      error: null,
      loading: true,
      loaded: false,
      filters: { category: 'all', status: 'all', query: '' },
      collapsed: false,
    }

    let root = null
    let regions = null
    let timer = null
    let visibilityHandler = null
    let destroyed = false
    let disposed = false
    let lastRefresh = Promise.resolve()

    // ── 骨架 ────────────────────────────────────────────────────
    function buildSkeleton(container) {
      const docked = container !== null
      const panel = el(doc, 'div', docked ? 'lx-docked' : 'lx-floating')
      panel.id = PANEL_ID
      panel.dataset.collapsed = 'false'

      const drawer = el(doc, 'section', 'lx-drawer')

      const head = el(doc, 'header', 'lx-head')
      const title = el(doc, 'div', 'lx-title')
      const nameEl = el(doc, 'span', 'lx-name')
      nameEl.textContent = '凌虚 CTF 控制面板'
      const subEl = el(doc, 'span', 'lx-sub')
      subEl.textContent = '等待数据…'
      title.appendChild(nameEl)
      title.appendChild(subEl)

      const actions = el(doc, 'div', 'lx-head-actions')
      const refreshBtn = el(doc, 'button', 'lx-btn lx-refresh')
      refreshBtn.type = 'button'
      refreshBtn.textContent = '刷新'
      const collapseBtn = el(doc, 'button', 'lx-btn lx-collapse')
      collapseBtn.type = 'button'
      collapseBtn.textContent = '收起'
      actions.appendChild(refreshBtn)
      actions.appendChild(collapseBtn)
      head.appendChild(title)
      head.appendChild(actions)

      const statusEl = el(doc, 'div', 'lx-status')
      const metaEl = el(doc, 'div', 'lx-meta')

      const body = el(doc, 'div', 'lx-body')

      const statsEl = el(doc, 'div', 'lx-stats')

      // 交互控件只建一次：轮询重建 innerHTML 不会夺走输入焦点。
      const controls = el(doc, 'div', 'lx-controls')
      const categorySel = el(doc, 'select', 'lx-filter-category')
      categorySel.setAttribute('aria-label', '按分类过滤')
      const statusSel = el(doc, 'select', 'lx-filter-status')
      statusSel.setAttribute('aria-label', '按状态过滤')
      const searchInput = el(doc, 'input', 'lx-search')
      searchInput.setAttribute('type', 'search')
      searchInput.setAttribute('placeholder', '搜索题目 / 负责人')
      searchInput.setAttribute('aria-label', '搜索题目或负责人')
      controls.appendChild(categorySel)
      controls.appendChild(statusSel)
      controls.appendChild(searchInput)

      const boardSection = el(doc, 'div', 'lx-section')
      const boardTitle = el(doc, 'div', 'lx-section-title')
      boardTitle.textContent = '题目看板'
      const boardEl = el(doc, 'div', 'lx-board')
      boardSection.appendChild(boardTitle)
      boardSection.appendChild(boardEl)

      const rankSection = el(doc, 'div', 'lx-section')
      const rankTitle = el(doc, 'div', 'lx-section-title')
      rankTitle.textContent = '排行榜 · 前 20'
      const rankEl = el(doc, 'div', 'lx-leaderboard')
      rankSection.appendChild(rankTitle)
      rankSection.appendChild(rankEl)

      const subSection = el(doc, 'div', 'lx-section')
      const subTitle = el(doc, 'div', 'lx-section-title')
      subTitle.textContent = '提交审计 · 最近 20'
      const submissionsEl = el(doc, 'div', 'lx-submissions')
      subSection.appendChild(subTitle)
      subSection.appendChild(submissionsEl)

      const theorySection = el(doc, 'div', 'lx-section')
      const theoryTitle = el(doc, 'div', 'lx-section-title')
      theoryTitle.textContent = '理论题'
      const theoryEl = el(doc, 'div', 'lx-theory')
      theorySection.appendChild(theoryTitle)
      theorySection.appendChild(theoryEl)

      body.appendChild(statsEl)
      body.appendChild(controls)
      body.appendChild(boardSection)
      body.appendChild(rankSection)
      body.appendChild(subSection)
      body.appendChild(theorySection)

      drawer.appendChild(head)
      drawer.appendChild(statusEl)
      drawer.appendChild(metaEl)
      drawer.appendChild(body)

      const launcher = el(doc, 'button', 'lx-launcher')
      launcher.type = 'button'
      const dot = el(doc, 'span', 'lx-launcher-dot')
      const launcherText = el(doc, 'span', 'lx-launcher-text')
      launcherText.textContent = 'CTF'
      launcher.appendChild(dot)
      launcher.appendChild(launcherText)

      panel.appendChild(drawer)
      panel.appendChild(launcher)

      // ── 交互 ──
      refreshBtn.addEventListener('click', () => { void refresh() })
      collapseBtn.addEventListener('click', () => setCollapsed(true))
      launcher.addEventListener('click', () => setCollapsed(false))
      categorySel.addEventListener('change', () => {
        state.filters.category = str(categorySel.value, 'all') || 'all'
        patch()
      })
      statusSel.addEventListener('change', () => {
        state.filters.status = str(statusSel.value, 'all') || 'all'
        patch()
      })
      searchInput.addEventListener('input', () => {
        state.filters.query = str(searchInput.value)
        patch()
      })

      // 错误态里的「重试」按钮：事件委托到状态行。
      statusEl.addEventListener('click', (event) => {
        const target = event && event.target
        if (target && typeof target.className === 'string' && target.className.includes('lx-retry')) void refresh()
      })

      // 页面可见性：重新可见时立刻拉一次。
      if (doc && typeof doc.addEventListener === 'function') {
        visibilityHandler = () => {
          if (doc.hidden !== true) void refresh()
        }
        doc.addEventListener('visibilitychange', visibilityHandler)
      }

      const parent = container || doc.body || doc.documentElement
      if (parent && typeof parent.appendChild === 'function') parent.appendChild(panel)

      regions = {
        nameEl, subEl, statusEl, metaEl, statsEl, boardEl, rankEl, submissionsEl, theoryEl,
        categorySel, statusSel, searchInput, launcherDot: dot, launcherText,
      }
      return panel
    }

    // ── 渲染 ────────────────────────────────────────────────────
    function syncFilterOptions() {
      const { categorySel, statusSel } = regions
      const categories = challengeCategories(state.snapshot.challenges)
      if (state.filters.category !== 'all' && !categories.includes(state.filters.category)) {
        state.filters.category = 'all'
      }
      const categoryOptions = ['<option value="all">全部分类</option>']
        .concat(categories.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`))
        .join('')
      categorySel.innerHTML = categoryOptions
      categorySel.value = state.filters.category

      statusSel.innerHTML = [
        '<option value="all">全部状态</option>',
        '<option value="pending">待解</option>',
        '<option value="working">进行中</option>',
        '<option value="solved">已解</option>',
      ].join('')
      statusSel.value = state.filters.status
    }

    /** 只刷新数据区域。 */
    function patch() {
      if (destroyed || !regions) return
      const snapshot = state.snapshot

      regions.nameEl.textContent = snapshot.event.name || '凌虚 CTF 控制面板'
      const platform = snapshot.connection.platform
      const base = snapshot.connection.baseUrl
      regions.subEl.textContent = snapshot.configured
        ? [platform, base].filter(Boolean).join(' · ')
        : '未配置平台连接'

      regions.statusEl.innerHTML = renderStatusHtml(snapshot, {
        error: state.error,
        loading: state.loading,
        loaded: state.loaded,
      })
      regions.metaEl.innerHTML = snapshot.configured ? renderHeaderMetaHtml(snapshot) : ''
      regions.statsEl.innerHTML = snapshot.configured ? renderStatsHtml(snapshot) : ''
      regions.boardEl.innerHTML = snapshot.configured ? renderBoardHtml(snapshot, state.filters) : ''
      regions.rankEl.innerHTML = snapshot.configured ? renderLeaderboardHtml(snapshot) : ''
      regions.submissionsEl.innerHTML = snapshot.configured ? renderSubmissionsHtml(snapshot) : ''
      regions.theoryEl.innerHTML = snapshot.configured ? renderTheoryHtml(snapshot) : ''

      if (snapshot.configured) syncFilterOptions()

      // 启动器角标：错误红点 / 已解进度。
      const tone = state.error ? 'lx-dot-err' : (snapshot.configured ? 'lx-dot-ok' : '')
      regions.launcherDot.className = `lx-launcher-dot ${tone}`.trim()
      regions.launcherText.textContent = snapshot.configured
        ? `CTF ${snapshot.stats.solved}/${snapshot.stats.total}`
        : 'CTF'
    }

    function setCollapsed(next) {
      state.collapsed = next === true
      if (root && root.dataset) root.dataset.collapsed = state.collapsed ? 'true' : 'false'
    }

    // ── 数据 ────────────────────────────────────────────────────
    /** 拉取一次快照并重绘；永不 reject。 */
    async function refresh() {
      if (destroyed) return
      if (fetchImpl === null) {
        state.error = '当前环境不支持 fetch'
        state.loading = false
        state.loaded = true
        patch()
        return
      }
      try {
        const response = await fetchImpl(url, { cache: 'no-store', headers: { accept: 'application/json' } })
        let payload = null
        if (response && typeof response.json === 'function') {
          payload = await response.json().catch(() => null)
        }
        const ok = response ? response.ok !== false : true
        if (!ok) {
          state.snapshot = normalizeState(payload)
          state.error = `HTTP ${response && response.status !== undefined ? response.status : '?'}`
        } else if (payload === null) {
          // 200 但不是合法 JSON：按错误态处理，避免被静默显示成「未配置」。
          state.snapshot = normalizeState(null)
          state.error = '响应不是合法 JSON'
        } else {
          state.snapshot = normalizeState(payload)
          // 宿主「未配置」时也会带 error:'not configured'；那种情况应显示空态提示而非错误态。
          state.error = state.snapshot.configured ? state.snapshot.error : null
        }
      } catch (error) {
        state.error = String((error && error.message) || error)
        state.snapshot = normalizeState(null)
      } finally {
        state.loading = false
        state.loaded = true
        patch()
      }
    }

    /** 立刻拉一次并启动轮询（页面隐藏时跳过）。 */
    function start() {
      if (destroyed || disposed) return
      stop()
      lastRefresh = refresh()
      // 优先用传入的 win（便于单测注入假定时器），否则退回全局。
      if (win && typeof win.setInterval === 'function') {
        timer = { handle: win.setInterval(tick, intervalMs), scheduler: win }
      } else if (typeof setInterval === 'function') {
        timer = { handle: setInterval(tick, intervalMs), scheduler: null }
      }
    }

    function tick() {
      if (destroyed) return
      // 页面不可见时暂停轮询（不消耗平台配额）。
      if (doc && doc.hidden === true) return
      void refresh()
    }

    function stop() {
      if (timer === null) return
      const { handle, scheduler } = timer
      if (scheduler && typeof scheduler.clearInterval === 'function') scheduler.clearInterval(handle)
      else if (typeof clearInterval === 'function') clearInterval(handle)
      timer = null
    }

    /** 挂载（幂等）。 */
    function mount() {
      if (root !== null || destroyed) return root
      if (!doc || typeof doc.createElement !== 'function') return null
      ensureStyles(doc)
      // 清掉可能残留的同 id 节点（模块被重复求值时）。
      if (typeof doc.getElementById === 'function') {
        const stale = doc.getElementById(PANEL_ID)
        if (stale && typeof stale.remove === 'function') stale.remove()
      }
      root = buildSkeleton(findHostContainer(doc))
      patch()
      return root
    }

    function destroy() {
      if (destroyed) return
      stop()
      if (visibilityHandler && doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', visibilityHandler)
      }
      visibilityHandler = null
      destroyed = true
      if (root && typeof root.remove === 'function') root.remove()
      root = null
      regions = null
    }

    return {
      mount,
      start,
      stop,
      refresh,
      destroy,
      setCollapsed,
      get state() { return state },
      get mounted() { return root !== null },
      get ready() { return lastRefresh },
      root: () => root,
    }
  }

  // ────────────────────────────────────────────────────────────── 插件入口

  let singleton = null

  /** 最近一次成功读取的配置摘要（供 slot 的 `view:'summary'` 同步渲染）。 */
  let configSummaryCache = null

  /** 供单测重置摘要缓存。 */
  function resetConfigSummaryCache() {
    configSummaryCache = null
  }

  /** 后台把摘要刷到最新；失败静默（摘要只是锦上添花）。 */
  function warmConfigSummary(options = {}) {
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
    if (fetchImpl === null) return Promise.resolve(null)
    return fetchImpl(CONFIG_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
      .then((response) => (response && typeof response.json === 'function' ? response.json() : null))
      .then((payload) => {
        if (payload === null || payload === undefined) return null
        configSummaryCache = renderConfigSummary(normalizeConfig(payload))
        return configSummaryCache
      })
      .catch(() => null)
  }

  /**
   * 用 React 承载纯 DOM 卡片：React 只提供一个挂载点（ref + effect），
   * 表单本身仍由 `createConfigCard` 的纯 DOM 实现负责 —— 避免手写 JSX/虚拟 DOM。
   */
  function reactConfigHost(react, options) {
    const h = react.createElement
    return function LingxuCtfConfigCard() {
      const ref = react.useRef(null)
      react.useEffect(() => {
        const card = createConfigCard(options)
        const host = ref.current
        if (host && typeof host.appendChild === 'function' && card.element) host.appendChild(card.element)
        void card.refresh()
        return () => card.destroy()
      }, [])
      return h('div', { className: 'lx-config-host', ref })
    }
  }

  /**
   * slot 渲染函数。
   * - `view === 'summary'` → 一句话字符串（React 可直接渲染）
   * - `view === 'page'` → 有 React 时给 React 元素，否则给纯 DOM 节点
   */
  function renderConfigSlot(props = {}, options = {}) {
    if (props && props.view === 'summary') {
      if (configSummaryCache === null) void warmConfigSummary(options)
      return configSummaryCache || '凌虚 CTF：平台连接、并发与护栏配置'
    }
    // React 优先取显式传入的（单测用），其次取 factory 里 require("react") 拿到的。
    const react = options.react || reactRuntime
    if (react && typeof react.createElement === 'function') return reactConfigHost(react, options)
    const card = createConfigCard(options)
    void card.refresh()
    return card.element
  }

  /**
   * 注册 Plugins 页的 bundle 配置卡片。
   *
   * `key` 必须等于包名：插件页是 `renderSlot('plugins.bundle.config', {view:'page'}, {entryKey: pkg.name})`。
   * 没有 `ctx.slots` 时返回 null（例如当前以普通 module script 加载的场景）。
   *
   * @returns 注册函数，或 null（拿不到 slots 服务）
   */
  function registerConfigCard(ctx, options = {}) {
    const slots = obj(ctx)?.slots
    beacon('registerConfigCard', 'slots=' + (slots ? 'yes' : 'no') + ' register=' + typeof slots?.register + ' inject=' + typeof slots?.inject)
    if (!slots || typeof slots.register !== 'function') return null
    const register = () => {
      try {
        const off = slots.register(
          { name: CONFIG_SLOT, key: CONFIG_SLOT_KEY },
          (props) => renderConfigSlot(props, options),
        )
        beacon('slot-registered', CONFIG_SLOT + '#' + CONFIG_SLOT_KEY)
        return off
      } catch (error) {
        beacon('slot-register-error', (error && error.message) || String(error))
        throw error
      }
    }
    if (typeof ctx.effect === 'function') {
      if (typeof slots.inject === 'function') {
        beacon('slots-inject-available', CONFIG_SLOT)
        ctx.effect(() => slots.inject(CONFIG_SLOT, register), 'dsh-lingxu-ctf: config card')
      } else {
        ctx.effect(register, 'dsh-lingxu-ctf: config card')
      }
    } else {
      register()
    }
    return register
  }

  /** 取得（必要时创建）进程内唯一面板。 */
  function getPanel(options = {}) {
    if (singleton === null || singleton.mounted === false) {
      singleton = createPanel(options)
      singleton.mount()
    }
    return singleton
  }

  /**
   * Cordis 插件入口。
   *
   * 浏览器里本模块是自挂载的（见文件末尾），`apply` 主要供宿主装配与 Node 单测调用；
   * 有 `ctx.effect` 时用它托管生命周期，否则返回手工销毁函数。
   *
   * @param {{effect?:Function, slots?:object}|null} ctx
   * @returns 面板控制器
   */
  function apply(ctx) {
    beacon('apply-called', 'ctx=' + (ctx ? 'yes' : 'no'))
    const panel = getPanel()
    const dispose = () => {
      if (singleton === panel) singleton = null
      panel.destroy()
    }
    // 配置卡片：只有拿到真 ctx（客户端插件图条目）时才可能注册进 Plugins 页 slot；
    // 拿不到就静默跳过，绝不影响浮动面板。
    try {
      registerConfigCard(ctx)
    } catch (error) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[dsh-lingxu-ctf] config card registration failed:', error)
      }
    }
    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(() => {
        panel.start()
        return dispose
      }, 'dsh-lingxu-ctf: web panel')
    } else {
      panel.start()
    }
    return panel
  }

  // ──────────────────────────────────────────────────── 导出 / 注册 / 自挂载

  /** 对外 API：factory 的返回值，即 DSH 眼中的插件模块导出。 */
  const api = {
    name,
    /**
     * 声明依赖 slots 服务：cordis 会在 slots 就绪后才调 apply，
     * 保证 `ctx.slots` 一定可用。注意浮动面板是**顶层自挂载**的，
     * 即使 apply 被无限期推迟，面板也照常工作。
     */
    inject: ['slots'],
    apply,
    getPanel,
    createPanel,
    findHostContainer,
    normalizeState,
    normalizeChallenge,
    filterChallenges,
    groupChallenges,
    challengeCategories,
    formatDuration,
    formatTime,
    escapeHtml,
    truncate,
    renderStatusHtml,
    renderBoardHtml,
    renderLeaderboardHtml,
    renderSubmissionsHtml,
    renderTheoryHtml,
    renderStatsHtml,
    renderHeaderMetaHtml,
    normalizeConfig,
    configFieldKind,
    renderConfigSummary,
    collectConfigPatch,
    createConfigCard,
    renderConfigSlot,
    registerConfigCard,
    resetConfigSummaryCache,
    STATE_URL,
    POLL_INTERVAL_MS,
    PANEL_ID,
    CONFIG_CLASS,
    CONFIG_URL,
    CONFIG_SLOT,
    CONFIG_SLOT_KEY,
    SECRET_SET_PLACEHOLDER,
    SECRET_UNSET_PLACEHOLDER,
    PLATFORM_LABELS,
    NOT_CONFIGURED_HINT,
    STATUS_LABELS,
    SUBMISSION_LABELS,
  }

  /**
   * 注册进 DSH 客户端模块表。
   *
   * factory 在**被 cordis Loader 物化时**才执行（惰性 CJS 模型），所以把
   * `require("react")` 放在 factory 内部 —— 那时模块表已就绪，react 在静态表里。
   * 拿不到 react 也不致命：配置卡片会退化成纯 DOM 渲染。
   */
  function registerWithModuleLoader(target) {
    if (!target || typeof target.load !== 'function') return false
    target.load({
      id: name,
      factory: function (require) {
        if (reactRuntime === null && typeof require === "function") {
          try {
            reactRuntime = require("react")
          } catch (error) {
            reactRuntime = null
          }
        }
        const exports = {}
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
        for (const key of Object.keys(api)) exports[key] = api[key]
        exports.default = api
        return exports
      },
    })
    return true
  }


  /** 向宿主回传诊断打点（宿主 /lingxu-ctf/diag 可见）。失败静默。 */
  function beacon(stage, detail) {
    try {
      if (typeof fetch !== 'function') return
      var url = '/lingxu-ctf/beacon?stage=' + encodeURIComponent(stage) + '&detail=' + encodeURIComponent(String(detail || '').slice(0, 300))
      fetch(url, { cache: 'no-store' }).catch(function () {})
    } catch (e) { /* 打点绝不影响功能 */ }
  }

  beacon('script-executed', 'ModuleLoader=' + (typeof window !== 'undefined' && window.__ModuleLoader__ ? 'yes' : 'no'))

  registerWithModuleLoader(typeof window !== "undefined" ? window.__ModuleLoader__ : null)

  // classic script 没有 export，Node 单测经此全局取用。
  if (typeof globalThis !== "undefined") globalThis.__DSH_LINGXU_CTF_CLIENT__ = api

  // ── 顶层自挂载：脚本一执行就挂浮动面板，不依赖 ctx ──
  if (typeof document !== "undefined" && typeof window !== "undefined") {
    const boot = () => {
      try {
        apply(null)
      } catch (error) {
        // 面板失败绝不能影响宿主页面。
        if (typeof console !== "undefined" && console.error) {
          console.error("[dsh-lingxu-ctf] panel bootstrap failed:", error)
        }
      }
    }
    if (document.readyState === "loading" && typeof document.addEventListener === "function") {
      document.addEventListener("DOMContentLoaded", boot, { once: true })
    } else {
      boot()
    }
  }
})()
