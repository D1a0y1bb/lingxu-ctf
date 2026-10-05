/**
 * 浏览器端 classic script。
 *
 * 宿主通过 `window.__ModuleLoader__.load({ id, factory })` 装载它；因此不能出现顶层
 * import/export。factory 负责注册 DSH 的视图和配置 slot，末尾的自挂载逻辑保留给
 * 没有 Loader 的普通页面。
 *
 * 数据来自 `/lingxu-ctf/state`、`/team`、`/reports`、`/config` 和 `/usage`。路由失败或
 * 字段缺失时渲染空态；外部文本一律经过 `escapeHtml`，Cookie 和 token 不回显。
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

  /** 字体栈：与 DSH 一致的系统字体（不引外部字体）。 */
  const FONT_STACK = '-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif'
  /** 等宽字体栈：flag、writeup 正文。 */
  const MONO_STACK = 'ui-monospace,SFMono-Regular,Menlo,monospace'

  /** secret 字段的 placeholder 文案（空串是「不修改」哨兵，故不提供清空入口）。 */
  const SECRET_SET_PLACEHOLDER = '已设置（留空则不修改）'
  const SECRET_UNSET_PLACEHOLDER = '未设置'

  /** 平台 → 展示名。 */
  /** 只支持凌虚。 */
  const PLATFORM_LABELS = { lingxu: '凌虚' }

  /** 内联样式表标识（避免重复注入）。 */
  const CSS_ID = 'dsh-lingxu-ctf/panel.css'

  /** 未配置平台时的空态提示。 */
  const NOT_CONFIGURED_HINT = '先调用 ctf_connect 配置平台地址与 sessionid'

  /** 题目状态 → 中文标签。 */
  const STATUS_LABELS = { pending: '待解', working: '进行中', solved: '已解' }

  /** 题型（平台 `task_type`）→ 徽章文案：1 环境型 / 2 外链型 / 3 附件型。 */
  const TASK_TYPE_LABELS = { 1: '环境型', 2: '外链型', 3: '附件型' }

  /** 环境剩余时间的警告阈值（秒）：低于 10 分钟就橙色告警 —— 过期就解不下去了。 */
  const ENV_WARN_SECONDS = 600

  /** flag 提交状态 → 中文标签。 */
  const SUBMISSION_LABELS = {
    correct: '正确',
    incorrect: '错误',
    wrong: '错误',
    already_solved: '重复正确',
    duplicate: '重复提交',
    error: '异常',
  }

  //  顶部「CTF」视图 tab（DSH 的 conversation.view list slot）
  //
  // DSH 顶部视图条由 ui-conversation 投影：它遍历 `slots.entries('conversation.view')`
  // 取 `options.id` 与 `resolveSlotLabel(options.label)`（label 可以是 thunk）。
  // list slot **必须**给 `id`（ui-slots 的 register 会校验），`order` 决定 tab 顺序
  // （对话 `0` / 轨迹 `10` / 我们 `20`）。
  //
  // ⚠️ `options.locale` 是**有门槛**的：ui-renderer 发现 entry 声明了 locale 而宿主
  // 没有装 locale face 时会抛 SlotAssemblyError（条目渲染失败 → 空白）。所以注册前
  // 先探测 ctx 里有没有 locale 服务，没有就不带该字段，用固定字面量 label。

  /** 视图 tab：slot 名 / id / 排序 / 根类名。 */
  const VIEW_SLOT = 'conversation.view'
  const VIEW_SLOT_ID = 'ctf'
  const VIEW_ORDER = 20
  const VIEW_CLASS = 'lx-view'

  /** 视图用的 locale 命名空间（仅在宿主有 locale 服务时注册）。 */
  const VIEW_LOCALE_NS = 'dsh-lingxu-ctf'

  /**
   * tab 文案（locale 键 `view.ctf` 与兜底都用它）。
   *
   * 顶部入口使用完整名称，方便和普通 CTF 页面区分。
   * 长文案靠 `.lx-vtab{flex:none;white-space:nowrap}` + `.lx-vtabs{overflow-x:auto}` 保证
   * 完整显示（不换行、不挤压「对话」「轨迹」，必要时 tab 条自己横向滚动）。
   */
  const VIEW_LABEL_FALLBACK = '凌虚竞赛平台 CTF Agent 模式'

  /** 会话 preset 命中即视为「CTF 会话」（预设 id 是 ctf，副本按 ctf-* 约定）。 */
  const CTF_PRESET_ID = 'ctf'
  const CTF_PRESET_PREFIX = 'ctf-'

  /** 视图数据源：团队/协同与报告（均允许缺失）。 */
  const TEAM_URL = '/lingxu-ctf/team'
  const REPORTS_URL = '/lingxu-ctf/reports'
  /** 单题详情：看板点击后按需请求。 */
  const CHALLENGE_URL = '/lingxu-ctf/challenge'
  /** 理论题题目概要：**按需**拉取（用户点按钮才请求，绝不进轮询）。 */
  const THEORY_URL = '/lingxu-ctf/theory'
  /** 当前会话的 token 用量（宿主折叠会话日志；与 DSH 投影对账）。 */
  const USAGE_URL = '/lingxu-ctf/usage'

  /** 子视图（数组顺序 = tab 顺序）。 */
  const VIEW_TABS = [
    { id: 'board', label: '题目看板' },
    // 理论题是独立赛段：以前没有子 tab，只能塞在看板/面板末尾，很突兀（用户点名）
    { id: 'theory', label: '理论题' },
    { id: 'agents', label: 'Agent 活动' },
    { id: 'messages', label: '协同通信' },
    { id: 'submissions', label: '提交审计' },
    { id: 'reports', label: '报告' },
    { id: 'env', label: '环境' },
  ]

  // 视图导航只突出四个高频入口；其余仍保留完整能力，但收进「更多视图」，
  // 避免首次打开时把七个平级入口挤成一条工具栏。VIEW_TABS 的顺序和原 id 不变，
  // 这样旧宿主、书签和外部 setTab 调用都不受影响。
  const PRIMARY_VIEW_TABS = new Set(['board', 'agents', 'env', 'reports'])
  let nextViewId = 0

  /** agent 状态 → 文案 / 色点 class（running 绿 / inactive 灰 / failed 红）。 */
  const AGENT_STATUS_LABELS = {
    running: '运行中', inactive: '空闲', provisioning: '启动中', failed: '失败', unknown: '未知',
  }
  const AGENT_STATUS_TONES = {
    running: 'lx-ok', inactive: 'lx-dim', provisioning: 'lx-info', failed: 'lx-err', unknown: 'lx-dim',
  }

  /** 任务状态 → 文案。 */
  const TASK_STATUS_LABELS = {
    pending: '待领取', in_progress: '进行中', completed: '已完成', unknown: '未知',
  }

  /** 协同消息 kind → 文案（未知 kind 原样显示）。 */
  const MESSAGE_KIND_LABELS = {
    spawn: '拉起', report: '汇报', status: '状态', stop: '停止', send: '消息', task: '任务', error: '异常',
  }

  /** 悬浮面板开关的配置键：宿主 `/lingxu-ctf/config` 下发，**缺省即不挂**。 */
  const FLOATING_CONFIG_KEY = 'enableFloatingPanel'

  //  基础工具

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

  /** 给会话相关路由附加同一个 session 参数；空值保持旧宿主兼容路径。 */
  function sessionUrl(url, sessionId) {
    const base = str(url)
    const id = str(sessionId).trim()
    if (base === '' || id === '') return base
    const separator = base.includes('?') ? '&' : '?'
    return `${base}${separator}session=${encodeURIComponent(id)}`
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

  /** 秒 → 超紧凑时长（环境剩余用）：`25m` / `3m20s` / `45s` / `1h5m`。 */
  function formatShortDuration(seconds) {
    const total = Math.max(0, Math.floor(num(seconds, 0)))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const secs = total % 60
    if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
    if (minutes > 0) return secs > 0 && minutes < 10 ? `${minutes}m${secs}s` : `${minutes}m`
    return `${secs}s`
  }

  /**
   * 题目的环境状态 → 展示模型（看板 / 环境视图 / agent 行共用）。
   * - `null`：没有在跑的环境（**不显示任何环境标记**）
   * - `error`：已过期（`envExpired` 或剩余 0）
   * - `warn`：剩余 < 10 分钟（过期就解不下去了，必须醒目）
   * - `ok`：正常倒计时
   */
  function envStateOf(item) {
    const src = obj(item)
    if (src === null) return null
    const remaining = src.envRemainingSeconds
    if (remaining === null || remaining === undefined) return null
    const seconds = Math.max(0, num(remaining, 0))
    if (src.envExpired === true || seconds === 0) return { tone: 'error', seconds: 0, label: '环境已过期', short: '0s' }
    const short = formatShortDuration(seconds)
    if (seconds < ENV_WARN_SECONDS) return { tone: 'warn', seconds, label: `⚠ 环境 ${short}`, short }
    return { tone: 'ok', seconds, label: `环境 ${short}`, short }
  }

  /** 题型徽章文案（`taskType` 未知 → null，不显示）。 */
  function taskTypeLabel(taskType) {
    const value = num(taskType, 0)
    return TASK_TYPE_LABELS[value] !== undefined ? TASK_TYPE_LABELS[value] : null
  }

  /** 题型徽章 HTML（未探测 → 空串）。 */
  function renderTaskTypeBadgeHtml(item) {
    const label = taskTypeLabel(obj(item)?.taskType)
    if (label === null) return ''
    return `<span class="lx-vtype lx-vtype-${escapeHtml(str(num(item.taskType, 0)))}" title="题型">${escapeHtml(label)}</span>`
  }

  /** 环境状态徽章 HTML（没有环境 → 空串）。 */
  function renderEnvChipHtml(item) {
    const env = envStateOf(item)
    if (env === null) return ''
    const title = env.tone === 'error'
      ? '环境已过期：需要重新 ctf_start_env 才能继续'
      : `环境剩余 ${env.short}（<10 分钟会橙色告警）`
    return `<span class="lx-venv lx-venv-${escapeHtml(env.tone)}" title="${escapeHtml(title)}">${escapeHtml(env.label)}</span>`
  }

  /**
   * 秒 → 相对时间（「12 秒前」「3 分钟前」），让活动时间一眼可见。
   * 负数（时钟漂移）按 0 处理。
   */
  function formatRelativeSeconds(seconds) {
    const total = Math.max(0, Math.floor(num(seconds, 0)))
    if (total < 5) return '刚刚'
    if (total < 60) return `${total} 秒前`
    const minutes = Math.floor(total / 60)
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时前`
    return `${Math.floor(hours / 24)} 天前`
  }

  /** 秒 → 可读耗时（「12 分 34 秒」「1 小时 5 分」）；给定时间戳也可直接算。 */
  function formatElapsed(seconds) {
    const total = Math.max(0, Math.floor(num(seconds, 0)))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const secs = total % 60
    if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
    if (minutes > 0) return `${minutes} 分 ${secs} 秒`
    return `${secs} 秒`
  }

  /** 停滞判定：超过这个秒数没有活动 → 灰色/警示。 */
  const STALE_AFTER_SECONDS = 300

  /** 秒 → 本地 `MM-DD HH:MM:SS`；无法解析时原样返回。 */
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

  //  视图模型

  /** 单题归一化：缺失字段全部降级，状态从 `solved` / `status` 双向推断。 */
  function normalizeChallenge(raw) {
    const src = obj(raw) || {}
    const solved = src.solved === true
    const declared = str(src.status).toLowerCase()
    let status = 'pending'
    if (solved || declared === 'solved' || declared === 'done' || declared === 'correct') status = 'solved'
    else if (declared === 'working' || declared === 'in_progress' || declared === 'running' || declared === 'busy') status = 'working'
    // 环境剩余：null = 没有在跑的环境（或老宿主没这个字段）；
    // 0 = 已过期（宿主同时会给 envExpired:true，这里两者取或）。
    const remainingRaw = src.envRemainingSeconds
    const remaining = remainingRaw === null || remainingRaw === undefined ? null : Math.max(0, num(remainingRaw, 0))
    const taskType = num(src.taskType, 0)
    return {
      id: src.id ?? null,
      name: str(src.name, `#${str(src.id, '?')}`),
      category: str(src.category, '未分类') || '未分类',
      score: num(src.score, 0),
      solved: status === 'solved',
      status,
      owner: str(src.owner) || null,
      submitAttempts: num(src.submitAttempts, 0),
      // 题型：1 环境型 / 2 外链型 / 3 附件型；缺省 / 未探测（null）= 不显示徽章，不瞎猜
      taskType: TASK_TYPE_LABELS[taskType] !== undefined ? taskType : null,
      envRemainingSeconds: remaining,
      envExpired: src.envExpired === true || remaining === 0,
    }
  }

  /**
   * 环境配额归一。宿主 `GET /lingxu-ctf/state` 的 `env`：`{ limit, held, free }`。
   * **老宿主没有这个字段** → `known:false`，UI 不显示占用（绝不能因为缺字段崩）。
   */
  function normalizeEnv(raw) {
    const src = obj(raw)
    if (src === null) return { known: false, limit: 0, held: 0, free: 0, full: false, blocked: false, blockedAt: null, heldScope: 'plugin', blockedReason: null }
    const limit = Math.max(0, num(src.limit, 0))
    const held = Math.max(0, num(src.held, 0))
    const hasFree = src.free !== null && src.free !== undefined
    const free = hasFree ? Math.max(0, num(src.free, 0)) : Math.max(0, limit - held)
    // blocked = 平台侧报过「环境数超限」。它比本地计数可信：本地只统计本插件起的环境，
    // 别的会话/人工在平台上起的实例看不见，于是会出现「本地 0/2、平台其实 2/2」。
    const blocked = src.blocked === true
    return {
      known: limit > 0,
      limit,
      held,
      free,
      full: limit > 0 && free === 0,
      blocked,
      blockedAt: str(src.blockedAt) || null,
      // held 只统计本插件起的实例（宿主标注 heldScope: 'plugin'），UI 文案必须据此措辞
      heldScope: str(src.heldScope, 'plugin') || 'plugin',
      blockedReason: str(src.blockedReason) || null,
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
    // 环境配额：老宿主没有这个字段 → known:false（UI 不显示，不报错、不瞎猜）
    const env = normalizeEnv(src.env)

    return {
      // 宿主显式给出 configured:false 时以它为准（未配置时返回 {ok:false,configured:false,error}）；
      // 否则「有连接」即视为已配置。
      configured: src.configured === false
        ? false
        : (connection !== null && (str(connection.key) !== '' || str(connection.baseUrl) !== '')),
      error: str(src.error) || null,
      // theory-dev 的面板缓存字段（有就用于页脚新鲜度，没有就退回本地 fetch 时间）
      cachedAt: str(src.cachedAt) || null,
      fromCache: src.fromCache === true,
      shared: src.shared === true,
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
      env,
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
          isParse: item.isParse === true || item.status === 'submitted',
          parseCount: num(item.parseCount, 0),
          statusLabel: str(item.statusLabel, ''),
          remainingSeconds: item.remainingSeconds === undefined || item.remainingSeconds === null
            ? null
            : num(item.remainingSeconds, null),
        }
      }),
    }
  }

  //  团队 / 协同 / 报告（视图模型，全部容错）

  /**
   * 题目 id 归一：`state.challenges[].id` 是数字，而任务/提交里的 `challengeId`
   * 可能是字符串（宿主 JSON 往返后会变），所以对齐前一律 `String()`。
   */
  function challengeKey(value) {
    if (value === null || value === undefined) return null
    const text = str(value).trim()
    if (text === '' || text === 'null' || text === 'undefined') return null
    return text
  }

  /** 任务状态归一：pending / in_progress / completed（未知值原样保留）。 */
  function normalizeTaskStatus(value) {
    const text = str(value).toLowerCase().replace(/[\s-]+/g, '_')
    if (['in_progress', 'running', 'working', 'active', 'claimed', 'started'].includes(text)) return 'in_progress'
    if (['completed', 'complete', 'done', 'finished', 'closed'].includes(text)) return 'completed'
    if (['pending', 'open', 'ready', 'todo', 'unclaimed'].includes(text)) return 'pending'
    return text === '' ? 'unknown' : text
  }

  /** 成员状态归一：running / inactive / provisioning / failed，其余归 unknown。 */
  function normalizeMemberStatus(value) {
    const text = str(value).toLowerCase()
    if (['running', 'inactive', 'provisioning', 'failed'].includes(text)) return text
    return 'unknown'
  }

  /** 单个 agent 成员。 */
  function normalizeMember(raw) {
    const src = obj(raw) || {}
    return {
      name: str(src.name, '未命名'),
      status: normalizeMemberStatus(src.status),
      description: str(src.description),
      challengeId: challengeKey(src.challengeId),
      challengeName: str(src.challengeName),
      category: str(src.category),
      role: str(src.role) || null,
      // 活动信息由宿主从 work 记录和团队消息推断，拿不到时保留 null。
      currentAction: str(src.currentAction),
      lastActivityAt: str(src.lastActivityAt) || null,
      staleSeconds: src.staleSeconds === null || src.staleSeconds === undefined ? null : num(src.staleSeconds, null),
    }
  }

  /** 单个共享任务。 */
  function normalizeTask(raw) {
    const src = obj(raw) || {}
    return {
      id: str(src.id ?? src.taskId),
      subject: str(src.subject, '未命名任务'),
      status: normalizeTaskStatus(src.status),
      owner: str(src.owner ?? src.ownerName) || null,
      challengeId: challengeKey(src.challengeId),
      challengeName: str(src.challengeName),
      category: str(src.category),
      createdAt: str(src.createdAt),
      updatedAt: str(src.updatedAt),
    }
  }

  /** 单条协同消息。 */
  function normalizeMessage(raw) {
    const src = obj(raw) || {}
    const kind = str(src.kind, 'other').toLowerCase() || 'other'
    return {
      at: str(src.at ?? src.time),
      from: str(src.from, '?'),
      to: str(src.to, '?'),
      kind,
      text: str(src.text ?? src.message),
      // 来源标识、消息 ID 和关联题目。
      messageId: str(src.messageId),
      challengeId: challengeKey(src.challengeId),
    }
  }

  /**
   * 团队快照归一。宿主 `/lingxu-ctf/team` 可能**还不存在**（404）或返回 `{ok:false}`：
   * 一律降级成「没有团队」的空结构，让视图渲染空态而不是崩掉。
   */
  function normalizeTeam(raw) {
    const src = obj(raw) || {}
    const members = list(src.members).map(normalizeMember)
    const tasks = list(src.tasks).map(normalizeTask)
    const messages = list(src.messages).map(normalizeMessage)
    const declared = obj(src.counts) || {}
    const statusOf = (status) => members.filter((member) => member.status === status).length
    const taskOf = (status) => tasks.filter((task) => task.status === status).length
    return {
      // `ok:true` 代表路由成功；成员和任务为空只是当前没有活动，不应被当成请求失败。
      ok: src.ok === true || (src.ok !== false && (members.length + tasks.length > 0 || messages.length > 0)),
      error: str(src.error) || null,
      members,
      tasks,
      messages,
      hasTeam: members.length > 0,
      // 本轮运行时长 + 最后活动（宿主从最早/最晚的活动时间戳算出；没有就 null）
      runtime: {
        startedAt: str(obj(src.runtime)?.startedAt) || null,
        elapsedSeconds: obj(src.runtime)?.elapsedSeconds === null || obj(src.runtime)?.elapsedSeconds === undefined
          ? null
          : num(obj(src.runtime)?.elapsedSeconds, null),
        lastActivityAt: str(obj(src.runtime)?.lastActivityAt) || null,
        idleSeconds: obj(src.runtime)?.idleSeconds === null || obj(src.runtime)?.idleSeconds === undefined
          ? null
          : num(obj(src.runtime)?.idleSeconds, null),
      },
      // 没有任何来源时保留原因；拿到投影或日志的数值由渲染层单独展示。
      tokenUsage: {
        available: obj(src.tokenUsage)?.available === true,
        reason: str(obj(src.tokenUsage)?.reason)
          || '本会话暂时没有可用的 token 用量来源',
        total: obj(src.tokenUsage)?.total === undefined || obj(src.tokenUsage)?.total === null
          ? null
          : num(obj(src.tokenUsage)?.total, null),
      },
      counts: {
        members: num(declared.members, members.length),
        running: num(declared.running, statusOf('running')),
        inactive: num(declared.inactive, statusOf('inactive')),
        tasksTotal: num(declared.tasksTotal, tasks.length),
        tasksDone: num(declared.tasksDone, taskOf('completed')),
        tasksInProgress: num(declared.tasksInProgress, taskOf('in_progress')),
        tasksPending: num(declared.tasksPending, taskOf('pending')),
      },
    }
  }

  /** 单份 writeup。 */
  function normalizeReport(raw) {
    const src = obj(raw) || {}
    return {
      id: str(src.id ?? src.challengeId),
      challengeId: challengeKey(src.challengeId),
      challengeName: str(src.challengeName ?? src.name, '未命名题目'),
      title: str(src.title) || str(src.challengeName) || 'writeup',
      path: str(src.path),
      submitted: src.submitted === true || str(src.status).toLowerCase() === 'submitted',
      submittedAt: str(src.submittedAt ?? src.at ?? src.createdAt),
      // 宿主 /reports 的字段：bodyPreview（前 N 字符）/ bodyChars / bytes / modifiedAt
      body: str(src.body ?? src.content ?? src.markdown ?? src.bodyPreview),
      bodyChars: num(src.bodyChars, 0),
      generatedAt: str(src.modifiedAt ?? src.generatedAt ?? src.at),
      bytes: num(src.bytes, num(src.size, 0)),
      size: num(src.size, 0),
    }
  }

  /**
   * 报告快照归一。接受三种形状：裸数组、`{ok, writeups}`、`{ok, reports}`；
   * 拿不到路由（404）时就是空列表 + 空态。
   */
  function normalizeReports(raw) {
    const src = obj(raw)
    const rows = Array.isArray(raw)
      ? raw
      : (list(src?.writeups).length > 0 ? list(src?.writeups) : list(src?.reports))
    return {
      ok: Array.isArray(raw) || (src !== null && src.ok !== false),
      error: str(src?.error) || null,
      items: rows.map(normalizeReport),
    }
  }

  /**
   * 题目看板 + 团队任务的合并 —— 「进行中」必须可见：
   * 平台侧还显示「未解」、但共享任务已经 `in_progress` 的题，要升级成
   * 「进行中 · solver-xxx」，而不是继续显示「待解」。
   *
   * 顺带把 owner（平台进度里的 owner 优先，其次正在解该题的 agent）与
   * 该题的全部负责人（owners）一并带出来，供卡片与 agent 视图使用。
   */
  function mergeChallengeBoard(challenges, team) {
    const tasksByChallenge = new Map()
    for (const task of list(obj(team)?.tasks)) {
      if (task.challengeId === null) continue
      if (!tasksByChallenge.has(task.challengeId)) tasksByChallenge.set(task.challengeId, [])
      tasksByChallenge.get(task.challengeId).push(task)
    }

    const matched = new Set()
    const board = list(challenges).map((item) => {
      const key = challengeKey(item.id)
      const tasks = key !== null ? (tasksByChallenge.get(key) || []) : []
      if (key !== null && tasks.length > 0) matched.add(key)
      const active = tasks.filter((task) => task.status === 'in_progress')
      const owners = []
      for (const task of tasks) {
        if (task.owner !== null && !owners.includes(task.owner)) owners.push(task.owner)
      }
      const activeAgents = []
      for (const task of active) {
        if (task.owner !== null && !activeAgents.includes(task.owner)) activeAgents.push(task.owner)
      }
      // 平台未解 + 任务进行中 → 升级为 working（这就是「进行中」的来源）
      const status = item.status !== 'solved' && active.length > 0 ? 'working' : item.status
      return {
        ...item,
        status,
        owner: item.owner || activeAgents[0] || owners[0] || null,
        owners,
        activeAgents,
        tasks,
        taskStatus: active.length > 0
          ? 'in_progress'
          : (tasks.length > 0 ? tasks[0].status : null),
      }
    })

    // 任务里有、平台列表里没有的题（列表缓存过期 / 手工建任务）也要看得见。
    const extras = []
    for (const [key, tasks] of tasksByChallenge) {
      if (matched.has(key)) continue
      const active = tasks.filter((task) => task.status === 'in_progress')
      const owners = []
      for (const task of tasks) {
        if (task.owner !== null && !owners.includes(task.owner)) owners.push(task.owner)
      }
      const sample = tasks[0]
      extras.push({
        id: sample.challengeId,
        name: sample.challengeName || sample.subject,
        category: sample.category || '未分类',
        score: 0,
        solved: false,
        status: active.length > 0 ? 'working' : 'pending',
        owner: (active[0] && active[0].owner) || owners[0] || null,
        submitAttempts: 0,
        owners,
        activeAgents: active.map((task) => task.owner).filter((name) => name !== null),
        tasks,
        taskStatus: active.length > 0 ? 'in_progress' : (tasks[0] ? tasks[0].status : null),
        teamOnly: true,
      })
    }
    return board.concat(extras)
  }

  /** 统计条数据（进行中按**合并后**的看板算，含任务升级上来的）。 */
  function viewStats(state, board, team) {
    const rows = list(board)
    const countOf = (status) => rows.filter((item) => item.status === status).length
    return {
      total: num(obj(obj(state)?.stats)?.total, rows.length),
      solved: countOf('solved'),
      working: countOf('working'),
      pending: countOf('pending'),
      agents: num(obj(obj(team)?.counts)?.members, 0),
      attempts: rows.reduce((sum, item) => sum + num(item.submitAttempts, 0), 0),
    }
  }

  /** 某个 agent 的最后活动时间：优先协同消息，其次任务。 */
  function memberLastActivity(name, team) {
    const actor = str(name)
    if (actor === '') return null
    let latest = null
    for (const message of list(obj(team)?.messages)) {
      if (message.from !== actor && message.to !== actor) continue
      const parsed = Date.parse(message.at)
      if (Number.isFinite(parsed) && (latest === null || parsed > latest)) latest = parsed
    }
    if (latest === null) return null
    return new Date(latest).toISOString()
  }

  //  过滤 / 分组

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

  //  各区域 HTML
  //
  // 面板和顶部视图有不同的布局，但共用数据模型和公共片段：
  //
  //     悬浮面板（窄，440px）                 顶部视图（宽，会话区）
  //     renderStatsHtml                       renderViewStatsHtml
  //     renderBoardHtml                       renderViewBoardHtml
  //     renderSubmissionsHtml                 renderViewSubmissionsHtml
  //     renderTheoryHtml                      （视图没有理论题 tab）
  //     patch() 里拼头部                       renderViewMetaHtml
  //
  // 两族存在是有理由的（信息密度不同），但**公共片段必须共用**，不能再各写一遍：
  //   · `renderMetricsLineHtml()` —— 头部那行指标（两族都用它，禁止再拼平台名/URL/赛事 ID）
  //   · `renderSubmissionCardsHtml()` / `renderFlagBlockHtml()` —— 提交审计卡片与完整 flag
  // 两套布局的公共片段由同一组函数生成。

  /**
   * 头部指标行（**两族共用**）：一行小字、`·` 分隔、无 chip 底色。
   *
   * 只保留得分、排名、剩余时间、环境配额、Agents、任务和处罚。
   *
   * @param {object} state normalizeState 后的快照
   * @param {{team?: object|null}} options 面板没有团队数据时不传 team（就不显示 Agents/任务）
   */
  function renderMetricsLineHtml(state, options = {}) {
    const snapshot = obj(state) || normalizeState(null)
    const team = obj(options.team)
    const env = obj(snapshot.env) || normalizeEnv(null)
    const items = []

    items.push(`<span class="lx-vmetric">得分 ${escapeHtml(snapshot.stats.totalScore)}</span>`)
    if (snapshot.rank.rank !== null && snapshot.rank.rank !== undefined) {
      const total = snapshot.rank.total === null || snapshot.rank.total === undefined
        ? ''
        : `/${escapeHtml(snapshot.rank.total)}`
      items.push(`<span class="lx-vmetric">排名 ${escapeHtml(snapshot.rank.rank)}${total}</span>`)
    }
    if (snapshot.event.remainingSeconds !== null) {
      items.push(`<span class="lx-vmetric">剩余 ${escapeHtml(formatDuration(snapshot.event.remainingSeconds))}</span>`)
    }
    // 环境配额：本地计数与平台侧已满分开显示。
    //   held 只统计本插件起的实例（heldScope: 'plugin'），平台侧可能被别的会话占满 ——
    //   以前写成「环境 0/2 · 平台已满」会自相矛盾（0/2 却已满），所以拆成两条指标：
    //   一条是本插件占用（本地语义），另一条是平台侧的明确告警 + 原因 tooltip。
    if (env.known) {
      const localFull = env.full
      items.push(`<span class="lx-vmetric${localFull ? ' lx-vmetric-warn' : ''}" title="${escapeHtml(
        localFull
          ? '本插件已占满自己配置的环境上限：新的环境题起不来，先释放一个（ctf_release_env）'
          : `本插件（ctf_start_env）已占用 ${env.held} / 上限 ${env.limit}；不含其他会话或手工起的实例`,
      )}">环境（本插件）${escapeHtml(env.held)}/${escapeHtml(env.limit)}${localFull ? ' · 已满' : ''}</span>`)
    }
    if (env.blocked === true) {
      items.push(`<span class="lx-vmetric lx-vmetric-warn" title="${escapeHtml(str(env.blockedReason)
        || '平台环境配额已满：最近 ctf_start_env 撞到过平台上限（配额被其他会话或手工实例占着）')}">⚠ 平台环境配额已满</span>`)
    }
    // 本轮耗时由 /lingxu-ctf/team 给出（最早活动 → 现在）。
    const runtime = obj(options.team) === null ? null : obj(obj(options.team)?.runtime)
    if (runtime !== null && runtime.elapsedSeconds !== null && runtime.elapsedSeconds !== undefined) {
      items.push(`<span class="lx-vmetric" title="从本轮最早的团队活动算起">本轮已运行 ${escapeHtml(formatElapsed(runtime.elapsedSeconds))}</span>`)
    }
    if (team !== null && team.hasTeam) {
      items.push(`<span class="lx-vmetric">${escapeHtml(team.counts.members)} Agents</span>`)
      items.push(`<span class="lx-vmetric">任务 ${escapeHtml(team.counts.tasksDone)}/${escapeHtml(team.counts.tasksTotal)}</span>`)
    }
    if (snapshot.event.punish) {
      // punish 的源码语义是「是否展示处罚警告」（对应 CompetitionPunish「赛事作弊处罚」，
      // 由管理员下发、含扣分与处罚信息），**与错误提交 flag 无关**。
      items.push('<span class="lx-vmetric lx-vmetric-warn" '
        + 'title="该赛事会在前台公示管理员下发的作弊处罚记录（与错误提交 flag 无关）">⚠ 处罚公示中</span>')
    }
    return items.join('<span class="lx-vsep" aria-hidden="true">·</span>')
  }

  /**
   * 单条 flag 的完整渲染（**两族共用**）。
   * flag 需要完整可复制：等宽、`break-all`，不使用省略号。
   */
  function renderFlagBlockHtml(flag) {
    const text = str(flag)
    if (text === '') {
      return '<p class="lx-vflag lx-vflag-empty">（无 flag · check 模式或平台未回显）</p>'
    }
    return `<p class="lx-vflag">${escapeHtml(text)}</p>`
  }

  /**
   * 提交审计卡片列表（**两族共用**）。
   * 每条一张卡：首行 时间 / 题目 / 状态徽章，第二行完整 flag 独占一行。
   */
  function renderSubmissionCardsHtml(rows) {
    return list(rows)
      .map((row) => {
        const label = SUBMISSION_LABELS[row.status] || row.status
        return '<div class="lx-vsub-row">'
          + '<div class="lx-vsub-head">'
          + `<span class="lx-time">${escapeHtml(formatTime(row.at))}</span>`
          + `<span class="lx-vsub-name">${escapeHtml(row.challengeName)}</span>`
          + `<span class="lx-sub lx-sub-${escapeHtml(kindClass(row.status))}">${escapeHtml(label)}</span>`
          + '</div>'
          + renderFlagBlockHtml(row.flag)
          + '</div>'
      })
      .join('')
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
      + renderTaskTypeBadgeHtml(item)   // 题型徽章（未探测不显示）
      + renderEnvChipHtml(item)         // 环境剩余（无环境不显示）
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

  /** 排行榜：前 20，标出自己。空态区分「没数据」与「未连接」。 */
  function renderLeaderboardHtml(state) {
    const rows = state.leaderboard.slice(0, 20)
    if (rows.length === 0) {
      const hint = state.configured
        ? '暂无排行榜数据（平台返回为空，稍后自动重试）'
        : '尚未连接竞赛平台，没有排行榜可显示'
      return `<div class="lx-empty">${escapeHtml(hint)}</div>`
    }
    const body = rows
      .map((row) => {
        const cls = row.isSelf ? ' class="lx-self"' : ''
        const badge = row.isSelf ? '<span class="lx-you">我</span>' : ''
        return `<tr${cls}><td class="lx-num">${escapeHtml(row.rank)}</td>`
          + `<td class="lx-user">${escapeHtml(row.username)}${badge}</td>`
          + `<td class="lx-num">${escapeHtml(row.score)}</td></tr>`
      })
      .join('')
    // `lx-rank` 让三列保持紧凑（见 CSS：max-width + 固定首末列宽）——两族共用本函数
    return '<table class="lx-table lx-rank"><thead><tr><th>#</th><th>选手</th><th>分数</th></tr></thead>'
      + `<tbody>${body}</tbody></table>`
  }

  /**
   * 提交审计（悬浮面板版）：**与视图共用** `renderSubmissionCardsHtml` —— 卡片式、
   * flag 完整显示，避免复制时丢字符。
   */
  function renderSubmissionsHtml(state) {
    const rows = state.submissions.slice(0, 20)
    if (rows.length === 0) return '<div class="lx-empty">暂无 flag 提交记录</div>'
    return renderSubmissionCardsHtml(rows)
  }

  /**
   * 理论题条目（**两族共用**）：面板底部区块与视图「理论题」子 tab 都用它渲染，
   * 避免「一边改了另一边没改」。
   */
  function renderTheoryItemsHtml(papers, options = {}) {
    const actionOf = typeof options.actionOf === 'function' ? options.actionOf : null
    return list(papers)
      .map((paper) => {
        // 交卷（is_parse）优先于进行中：交卷后平台的 is_begin 会变回 false
        const stateText = paper.statusLabel || (paper.isParse ? '已交卷' : paper.isBegin ? '进行中' : '未开始')
        const tone = paper.isParse ? 'lx-ok' : paper.isBegin ? 'lx-info' : 'lx-dim'
        const submitTimes = paper.parseCount > 0
          ? `<span class="lx-theory-count">交卷 ${escapeHtml(paper.parseCount)} 次</span>`
          : ''
        const remaining = paper.remainingSeconds !== null
          ? `<span class="lx-theory-time">剩余 ${escapeHtml(formatDuration(paper.remainingSeconds))}</span>`
          : ''
        return '<div class="lx-theory-item">'
          + `<span class="lx-theory-name">${escapeHtml(paper.name)}</span>`
          + `<span class="lx-pill ${tone}">${escapeHtml(stateText)}</span>`
          + `<span class="lx-theory-count">${escapeHtml(paper.count)} 题</span>`
          + submitTimes
          + remaining
          // 动作槽（视图用它插入「加载题目概要」按钮 + 题目列表；面板不传就不渲染）
          + (actionOf === null ? '' : str(actionOf(paper)))
          + '</div>'
      })
      .join('')
  }

  /** 理论题（面板族）：视图那侧见 `renderViewTheoryHtml`，条目共用上面的函数。 */
  function renderTheoryHtml(state) {
    if (state.theory.length === 0) return '<div class="lx-empty">暂无理论题试卷</div>'
    return renderTheoryItemsHtml(state.theory)
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

  //  顶部「CTF」视图：5 个子视图（HTML 片段）

  /** 视图空态：一句话 + 可选引导。 */
  function renderViewEmptyHtml(text, hint = '') {
    return '<div class="lx-vempty"><div class="lx-vempty-text">' + escapeHtml(text) + '</div>'
      + (hint !== '' ? `<div class="lx-vempty-hint">${escapeHtml(hint)}</div>` : '')
      + '</div>'
  }

  /** kind → 安全的 class 片段（防平台数据注入类名）。 */
  function kindClass(kind) {
    return str(kind).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'other'
  }

  /**
   * 视图指标行 —— **薄封装**，真正的实现在共享的 `renderMetricsLineHtml()`。
   * 视图比面板多传一个 `team`（视图拉 /lingxu-ctf/team，面板不拉）。
   */
  function renderViewMetaHtml(model) {
    return renderMetricsLineHtml(model.state, { team: model.team })
  }

  /** 视图统计条：总数 / 已解 / 进行中 / 待解 / Agents / flag 提交。 */
  function renderViewStatsHtml(model) {
    const stats = model.stats
    const cells = [
      ['题目总数', stats.total, ''],
      ['已解', stats.solved, 'lx-ok'],
      ['进行中', stats.working, 'lx-info'],
      ['待解', stats.pending, 'lx-dim'],
      ['Agents', stats.agents, ''],
      ['flag 提交', stats.attempts, ''],
    ]
    return cells
      .map(([label, value, tone]) => (
        `<div class="lx-stat ${tone}"><span class="lx-stat-value">${escapeHtml(value)}</span>`
        + `<span class="lx-stat-label">${escapeHtml(label)}</span></div>`
      ))
      .join('')
  }

  /** 视图告警行：加载失败 / 未配置 / 宿主回传的错误。 */
  function renderViewAlertHtml(model) {
    const parts = []
    if (model.error) {
      parts.push('<div class="lx-alert lx-alert-error"><b>赛事数据加载失败</b>：'
        + escapeHtml(model.error)
        + '<button class="lx-link lx-vretry" type="button">重试</button></div>')
    }
    if (!model.state.configured) {
      parts.push(`<div class="lx-alert lx-alert-warn">尚未连接竞赛平台：${escapeHtml(NOT_CONFIGURED_HINT)}</div>`)
    } else if (model.state.error) {
      parts.push(`<div class="lx-alert lx-alert-error">${escapeHtml(model.state.error)}</div>`)
    }
    return parts.join('')
  }

  /** 单张题目卡片：题名 / 分值 / 状态徽章（进行中 · solver-xxx）/ 负责人 / 提交次数。 */
  function renderViewChallengeCard(item) {
    const label = STATUS_LABELS[item.status] || item.status
    // 「进行中 · solver-xxx」：平台未解但任务 in_progress 时由 mergeChallengeBoard 升级而来
    const withOwner = item.status === 'working' && item.owner ? `${label} · ${item.owner}` : label
    const notes = []
    for (const owner of list(item.owners).slice(0, 4)) {
      notes.push(`<span class="lx-vagent" title="负责过的 agent">@${escapeHtml(owner)}</span>`)
    }
    if (item.owners.length > 4) notes.push(`<span class="lx-vnote">+${escapeHtml(item.owners.length - 4)}</span>`)
    if (item.submitAttempts > 0) {
      notes.push(`<span class="lx-vnote" title="已提交 flag 次数">提交 ${escapeHtml(item.submitAttempts)} 次</span>`)
    }
    if (list(item.tasks).length > 0) {
      const done = item.tasks.filter((task) => task.status === 'completed').length
      notes.push(`<span class="lx-vnote" title="共享任务完成数">任务 ${escapeHtml(done)}/${escapeHtml(item.tasks.length)}</span>`)
    }
    if (item.teamOnly === true) {
      notes.push('<span class="lx-vnote lx-vwarn" title="任务里有、平台列表里还没有">仅任务</span>')
    }
    // 「仅任务」的题平台还没同步分值，显示占位符而不是误导性的 0
    const score = item.teamOnly === true && num(item.score, 0) === 0 ? '—' : str(item.score)
    return '<div class="lx-vcard lx-vchallenge lx-st-' + escapeHtml(item.status) + '" role="button" tabindex="0" data-challenge-id="' + escapeHtml(item.id) + '">'
      + '<div class="lx-vcard-top">'
      + `<span class="lx-vcard-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>`
      + `<span class="lx-vscore">${escapeHtml(score)}</span>`
      + '</div>'
      + '<div class="lx-vcard-meta">'
      + `<span class="lx-pill lx-pill-${escapeHtml(item.status)}">${escapeHtml(withOwner)}</span>`
      + renderTaskTypeBadgeHtml(item)   // 题型：环境型 / 外链型 / 附件型（未探测则不显示）
      + renderEnvChipHtml(item)         // 环境剩余：正常 / <10 分钟橙色 / 过期红色
      + notes.join('')
      + '</div>'
      + '</div>'
  }

  /** 看板详情抽屉。服务端字段再次转义，提交答案只显示脱敏值。 */
  function renderChallengeDetailHtml(detailState) {
    if (!detailState) return ''
    if (detailState.loading) return '<aside class="lx-vdetail" aria-live="polite"><div class="lx-vdetail-head"><b>题目详情</b><button class="lx-link lx-vdetail-close" type="button">关闭</button></div><div class="lx-vdetail-body">正在加载…</div></aside>'
    if (detailState.ok === false) return '<aside class="lx-vdetail" aria-live="polite"><div class="lx-vdetail-head"><b>题目详情</b><button class="lx-link lx-vdetail-close" type="button">关闭</button></div><div class="lx-vdetail-body lx-alert-error">' + escapeHtml(detailState.error || '详情加载失败') + '</div></aside>'
    const detail = obj(detailState.challenge)
    const work = obj(detailState.work)
    const submissions = list(detailState.submissions).map((row) => `<li><span>${escapeHtml(str(row.status, 'unknown'))}</span><code>${escapeHtml(str(row.flag))}</code><small>${escapeHtml(str(row.at))}</small></li>`).join('')
    const metadata = [
      `${str(detail.category, '未分类')} · ${str(detail.score)} 分`,
      detail.taskTypeLabel || TASK_TYPE_LABELS[detail.taskType] || '题型待探测',
      detail.solved ? '已解' : '未解',
      detail.requiresEnv ? '需要环境' : '无需环境',
    ].map((item) => `<span class="lx-pill">${escapeHtml(item)}</span>`).join('')
    return '<aside class="lx-vdetail" aria-live="polite">'
      + '<div class="lx-vdetail-head"><div><b>' + escapeHtml(str(detail.name, `题目 #${detail.id}`)) + '</b><small>#' + escapeHtml(detail.id) + '</small></div><button class="lx-link lx-vdetail-close" type="button">关闭</button></div>'
      + '<div class="lx-vdetail-meta">' + metadata + '</div><div class="lx-vdetail-body">'
      + '<h4>题面</h4><pre>' + escapeHtml(str(detail.description, '暂无题面')) + '</pre>'
      + (detail.connectionInfo ? '<p><b>连接信息：</b>' + escapeHtml(detail.connectionInfo) + '</p>' : '')
      + (detail.externalLink ? '<p><b>外链：</b>' + escapeHtml(detail.externalLink) + '</p>' : '')
      + '<h4>本地进度</h4><p>' + escapeHtml(work.status || '暂无记录') + (work.owner ? ` · ${escapeHtml(work.owner)}` : '') + '</p>'
      + (detailState.writeup?.exists ? `<p>Writeup：${escapeHtml(detailState.writeup.path || '已生成')}</p>` : '<p>Writeup：未生成</p>')
      + (submissions ? '<h4>提交记录（已脱敏）</h4><ul class="lx-vdetail-submissions">' + submissions + '</ul>' : '')
      + '</div></aside>'
  }

  /** ① 题目看板：按分类分组 + 筛选（分类 / 状态 / 搜索）。 */
  function renderViewBoardHtml(model, filters = {}) {
    const board = list(model.board)
    if (board.length === 0) {
      return renderViewEmptyHtml('暂无题目数据', '先 ctf_connect 配置平台，或等赛事侧同步题目列表。')
    }
    const visible = filterChallenges(board, filters)
    if (visible.length === 0) return renderViewEmptyHtml('没有符合筛选条件的题目')
    return groupChallenges(visible)
      .map((group) => {
        const working = group.items.filter((item) => item.status === 'working').length
        const cards = group.items.map(renderViewChallengeCard).join('')
        return '<div class="lx-vgroup">'
          + '<div class="lx-vgroup-head">'
          + `<span class="lx-vgroup-name">${escapeHtml(group.category)}</span>`
          + `<span class="lx-vgroup-count">已解 ${escapeHtml(group.solved)}/${escapeHtml(group.items.length)}`
          + (working > 0 ? ` · 进行中 ${escapeHtml(working)}` : '')
          + '</span>'
          + '</div>'
          + `<div class="lx-vcards">${cards}</div>`
          + '</div>'
      })
      .join('')
  }

  /** 某个 agent 负责的全部题目（原生 details，无需 JS 展开）。 */
  /** 单个任务的耗时：已完成 = updatedAt - createdAt；进行中 = now - createdAt。 */
  function taskElapsedSeconds(task) {
    const created = Date.parse(str(task?.createdAt))
    if (!Number.isFinite(created)) return null
    const end = task?.status === 'completed' ? Date.parse(str(task?.updatedAt)) : Date.now()
    if (!Number.isFinite(end)) return null
    return Math.max(0, Math.round((end - created) / 1000))
  }

  function renderViewAgentTasksHtml(tasks, owner) {
    if (list(tasks).length === 0) return ''
    const rows = tasks
      .map((task) => {
        const elapsed = taskElapsedSeconds(task)
        const elapsedText = elapsed === null
          ? ''
          : `<span class="lx-vnote" title="${task.status === 'completed' ? '从建任务到完成' : '从建任务到现在'}">耗时 ${escapeHtml(formatElapsed(elapsed))}</span>`
        return '<li>'
          + `<span class="lx-vpill lx-vpill-${escapeHtml(kindClass(task.status))}">`
          + `${escapeHtml(TASK_STATUS_LABELS[task.status] || task.status)}</span>`
          + `<span class="lx-vtask-name">${escapeHtml(task.challengeName || task.subject)}</span>`
          + (task.category !== '' ? `<span class="lx-vnote">${escapeHtml(task.category)}</span>` : '')
          + (task.challengeId !== null ? `<span class="lx-vnote">#${escapeHtml(task.challengeId)}</span>` : '')
          + elapsedText
          + '</li>'
      })
      .join('')
    return `<details class="lx-vtasks" data-lx-detail="tasks:${escapeHtml(owner)}"><summary>负责的题目（${escapeHtml(list(tasks).length)}）</summary>`
      + `<ul class="lx-vtask-list">${rows}</ul></details>`
  }

  /**
   * 某个 agent 手上（负责的题）正在跑的环境，返回最强告警的那条。
   * 「谁占着稀缺的环境配额」一眼可见 —— 环境上限通常只有 2。
   */
  function memberEnvOf(memberName, board) {
    const actor = str(memberName)
    if (actor === '') return null
    let best = null
    const rank = { error: 3, warn: 2, ok: 1 }
    for (const item of list(board)) {
      const mine = item.owner === actor || list(item.owners).includes(actor) || list(item.activeAgents).includes(actor)
      if (!mine) continue
      const env = envStateOf(item)
      if (env === null) continue
      if (best === null || rank[env.tone] > rank[best.env.tone]) best = { env, item }
    }
    return best
  }

  /** 用量四桶归一（`inputTokens` 在 DSH 语义里是**未缓存输入**）。 */
  function normalizeUsageBuckets(raw) {
    const src = obj(raw)
    if (src === null) return null
    const buckets = {
      uncachedInputTokens: Math.max(0, num(src.uncachedInputTokens ?? src.inputTokens, 0)),
      outputTokens: Math.max(0, num(src.outputTokens, 0)),
      cacheReadTokens: Math.max(0, num(src.cacheReadTokens, 0)),
      cacheWriteTokens: Math.max(0, num(src.cacheWriteTokens, 0)),
    }
    const keys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    const any = keys.some((key) => num(src[key], 0) > 0)
    return any ? { ...buckets, total: keys.reduce((sum, key) => sum + buckets[key], 0) } : null
  }

  /** 千分位（token 数量级大，逗号更好读）。 */
  function formatCount(value) {
    const digits = String(Math.max(0, Math.floor(num(value, 0))))
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  /**
   * token 用量（面板和顶部视图共用）。
   *
   * 两条数据源 + **对账**：
   * - `projection`：会话行的 `projectionValues.tokenUsage`（DSH 统计药丸用的同一个投影，权威）；
   * - `log`：宿主 `/lingxu-ctf/usage` 折叠会话日志的结果（独立实现）。
   * 两者都有时对比；不一致会显式标注（**绝不静默展示可疑数字**）。
   * 都没有时如实说明，不再声称「宿主未提供」。
   */
  function renderTokenUsageHtml(usage) {
    const src = obj(usage) || {}
    const breakdownHtml = renderUsageBreakdownHtml(src.breakdown)
    const projection = normalizeUsageBuckets(src.projection)
    const log = normalizeUsageBuckets(src.log)
    const primary = projection || log
    if (primary === null) {
      const reason = str(src.reason) || '本会话还没有 LLM 用量记录（或会话日志不可读）'
      return `<div class="lx-vnote">token 用量：暂不可用（${escapeHtml(reason)}）</div>`
    }
    const sourceText = projection !== null
      ? (log !== null && log.total !== projection.total ? 'DSH 会话投影 · 与日志不一致' : 'DSH 会话投影')
      : (src.inferred === true ? '会话日志（最近会话，自动识别）' : '会话日志')
    // 压缩开销（上下文压缩 compaction/summary）：真实花费，**DSH 投影不含它**，所以单列
    const compaction = Math.max(0, num(src.compactionTokens, 0))
    const billed = Math.max(0, num(src.billedTokens, 0)) || (primary.total + compaction)
    const detail = src.detail === false
      ? ''
      : `（未缓存输入 ${escapeHtml(formatCount(primary.uncachedInputTokens))} · 输出 ${escapeHtml(formatCount(primary.outputTokens))}`
        + ` · 缓存读 ${escapeHtml(formatCount(primary.cacheReadTokens))}`
        + (primary.cacheWriteTokens > 0 ? ` · 缓存写 ${escapeHtml(formatCount(primary.cacheWriteTokens))}` : '')
        + '）'
    // 对账口径：只比**工作用量**（DSH 投影不含压缩）；压缩已单列 → 不报「不一致」
    const verdict = projection !== null && log !== null
      ? (projection.total === log.total
        ? ' · 与 DSH 投影逐桶一致'
        : ` · ⚠ 与 DSH 投影不一致（投影 ${escapeHtml(formatCount(projection.total))} · 日志 ${escapeHtml(formatCount(log.total))}；压缩开销不参与本比较）`)
      : ''
    const warn = projection !== null && log !== null && projection.total !== log.total ? ' lx-vwarn' : ''
    // 三个数：工作（= DSH 投影口径）｜ 压缩开销（DSH 不含）｜ 合计（真实花费）
    const compactionText = compaction > 0
      ? ` ｜ 压缩开销 ${escapeHtml(formatCount(compaction))}（上下文压缩，DSH 投影不含）`
      : (log !== null ? ' ｜ 压缩开销 0' : '')
    return `<div class="lx-vnote${warn}">token 用量：工作 ${escapeHtml(formatCount(primary.total))}${detail}`
      + `${compactionText} ｜ <span class="lx-usage-billed">合计 ${escapeHtml(formatCount(billed))}</span>`
      + `<span class="lx-vnote-dim"> · 来源 ${escapeHtml(sourceText)}${verdict}`
      + (compaction > 0 ? ' · 合计 = 工作 + 压缩' : '')
      + '</span></div>'
      + breakdownHtml
  }

  /** 兼容旧调用：团队 payload 里的 tokenUsage 现在只当兜底说明。 */
  function renderViewUsageNoteHtml(team) {
    const usage = obj(team?.tokenUsage) || {}
    return renderTokenUsageHtml({
      projection: usage.available === true ? usage : null,
      log: usage.available === true ? usage : null,
      reason: str(usage.reason),
    })
  }

  /** ② Agent 活动：名字 / 状态点 / 当前题目 / 完成数 / 最后活动（+ 是否持有环境）。 */
  function renderViewAgentsHtml(model) {
    const team = model.team
    if (!team.hasTeam) {
      const hint = team.error
        ? `团队数据读取失败：${team.error}`
        : '说「开始」或调用 ctf_solve_start 拉起团队后，这里会显示每个 agent 的状态与当前题目。'
      return renderViewEmptyHtml('尚未拉起解题团队', hint)
    }
    const runtime = obj(team.runtime)
    const usageLine = renderTokenUsageHtml(model.tokenUsage || {
      projection: obj(model.team)?.tokenUsage?.available === true ? obj(model.team)?.tokenUsage : null,
      log: null,
      reason: str(obj(obj(model.team)?.tokenUsage)?.reason),
    })
    const runtimeLine = runtime !== null && runtime.elapsedSeconds !== null
      ? `<div class="lx-vnote">本轮已运行 ${escapeHtml(formatElapsed(runtime.elapsedSeconds))}`
        + `${runtime.idleSeconds !== null ? ` · 团队最后活动 ${escapeHtml(formatRelativeSeconds(runtime.idleSeconds))}` : ''}</div>`
      : ''
    return runtimeLine
      + usageLine
      + team.members
      .map((member) => {
        const tasks = team.tasks.filter((task) => task.owner === member.name)
        const byId = member.challengeId !== null
          ? model.board.find((item) => challengeKey(item.id) === member.challengeId)
          : null
        const active = model.board.find((item) => item.activeAgents.includes(member.name))
        const owned = model.board.find((item) => item.owner === member.name)
        const current = member.challengeName
          || (byId !== null && byId !== undefined ? byId.name : '')
          || (active !== undefined ? active.name : '')
          || (owned !== undefined ? owned.name : '')
        const done = tasks.filter((task) => task.status === 'completed').length
        // 活动时间：优先宿主给的（含 store/work + 团队消息，比前端推断更准），
        // 退化到前端从消息里推的 lastActivity；再退化就是「无活动记录」。
        const hostLast = str(member.lastActivityAt)
        const last = hostLast !== '' ? hostLast : memberLastActivity(member.name, team)
        const staleSeconds = member.staleSeconds === null || member.staleSeconds === undefined
          ? (last !== null ? Math.max(0, Math.round((Date.now() - Date.parse(last)) / 1000)) : null)
          : num(member.staleSeconds, null)
        const stale = typeof staleSeconds === 'number' && staleSeconds >= STALE_AFTER_SECONDS
        const tone = AGENT_STATUS_TONES[member.status] || 'lx-dim'
        const activityText = staleSeconds === null
          ? '无活动记录'
          : `${formatRelativeSeconds(staleSeconds)}${stale ? ' · 已停滞' : ''}`
        // 当前在做什么：宿主推断的 currentAction（最近一次进度/任务/消息）优先
        const actionText = str(member.currentAction) || (current !== '' ? `正在解「${current}」` : '暂无活动记录')
        // 环境标记：该 agent 负责的题里有正在跑（或刚过期）的环境
        const held = memberEnvOf(member.name, model.board)
        const envTag = held === null
          ? ''
          : `<span class="lx-venv lx-venv-${escapeHtml(held.env.tone)} lx-venv-held" title="`
            + escapeHtml(`持有环境：${held.item.name}（${held.env.label}）`) + '">🌐 '
            + escapeHtml(held.env.label) + '</span>'
        return '<div class="lx-vagent-row">'
          + '<div class="lx-vagent-head">'
          + `<span class="lx-vdot ${escapeHtml(tone)}"></span>`
          + `<span class="lx-vagent-name">${escapeHtml(member.name)}</span>`
          + `<span class="lx-vstatus ${escapeHtml(tone)}">${escapeHtml(AGENT_STATUS_LABELS[member.status] || member.status)}</span>`
          + (member.role !== null && member.role !== '' ? `<span class="lx-vrole">${escapeHtml(member.role)}</span>` : '')
          + envTag
          + '</div>'
          + '<div class="lx-vagent-meta">'
          + `<span class="lx-vnote">当前：${current !== '' ? escapeHtml(current) : '—'}</span>`
          + `<span class="lx-vnote">已完成 ${escapeHtml(done)} 题</span>`
          + `<span class="lx-vnote${stale ? ' lx-vwarn' : ''}" title="${escapeHtml(last !== null ? formatTime(last) : '暂无记录')}">最后活动 ${escapeHtml(activityText)}</span>`
          + '</div>'
          + `<div class="lx-vagent-action" title="${escapeHtml(str(member.itemDescription) || '')}">在做：${escapeHtml(actionText)}</div>`
          + (member.description !== '' ? `<div class="lx-vagent-desc">${escapeHtml(member.description)}</div>` : '')
          + renderViewAgentTasksHtml(tasks, member.name)
          + '</div>'
      })
      .join('')
  }

  /**
   * 协同消息分类：
   * - `orchestration`：编排事件（spawn / status / stop / report，来自 ctf_solve_*）
   * - `interactive`：agent 之间的 `send_message`（宿主只读钩子观察到投递时记录）
   * - `clue` / `help` / `progress` / `note`：agent 主动用 `ctf_team_log` 落档
   *
   * ⚠️ 钩子只记 kind=`interactive`；所以「交流」是按**来源**分，不是按人猜的。
   */
  function messageCategory(kind) {
    const value = str(kind)
    if (value === 'interactive') return 'interactive'
    if (value === 'clue' || value === 'help' || value === 'progress') return value
    return value === 'note' ? 'note' : 'orchestration'
  }

  /** 分类 → 中文标签（筛选按钮与徽章共用）。 */
  const MESSAGE_CATEGORY_LABELS = {
    all: '全部',
    orchestration: '编排事件',
    interactive: 'Agent 交流',
    clue: '跨题线索',
    help: '求助',
    progress: '进展',
    note: '其它记录',
  }

  /**
   * ③ 协同通信：**按「谁 ↔ 谁」分组**的时间线，便于看清消息往来。
   *
   * ⚠️ 数据来源限制（已在回报里说明根因）：目前落盘的只有 `ctf_solve_*` 生命周期消息
   * （from=lead → to=team），**agent 之间的 send_message 不会进这个数组**；
   * 所以这里按「对话对」分组、把能看到的都摊开，并在空态/顶部说明这一点。
   */
  function renderViewMessagesHtml(model, filters = {}) {
    const messages = list(model.team.messages)
    if (messages.length === 0) {
      const hint = model.team.error
        ? `团队数据读取失败：${model.team.error}`
        : '还没有协同记录：agent 之间没发过 send_message，也没有 ctf_solve_* 编排事件，'
          + '更没有人用 ctf_team_log 落档线索/求助/进展。'
          + '（口径：send_message 由宿主只读钩子在**投递时**记录；ctf_team_log 是 agent 主动落档；'
          + '两者都不需要额外配置。）'
      return renderViewEmptyHtml('暂无协同记录', hint)
    }
    // 全部时间可解析时按时间升序（最新在最后），否则保持宿主给的顺序。
    const times = messages.map((message) => Date.parse(message.at))
    const ordered = times.every((value) => Number.isFinite(value))
      ? messages.map((message, index) => ({ message, time: times[index] }))
        .sort((a, b) => a.time - b.time)
        .map((entry) => entry.message)
      : messages
    // 按「对话对」分组：lead→team / lead↔solver-x / solver-x↔solver-y …
    // 每组内部仍是时间升序，组间按最近活跃排序 —— 一眼看出「谁在和谁说什么」。
    //  分类筛选：默认全部；只筛掉展示，不改数据
    const active = str(filters.msgKind) || 'all'
    const counts = new Map()
    for (const message of ordered) {
      const category = messageCategory(message.kind)
      counts.set(category, (counts.get(category) || 0) + 1)
    }
    const filterBar = '<div class="lx-vmsg-filters">'
      + Object.entries(MESSAGE_CATEGORY_LABELS)
        .filter(([key]) => key === 'all' || (counts.get(key) || 0) > 0)
        .map(([key, label]) => {
          const total = key === 'all' ? ordered.length : counts.get(key) || 0
          const on = key === active ? ' lx-vmsg-filter-on' : ''
          return `<button class="lx-vmsg-filter${on}" type="button" data-msg-kind="${escapeHtml(key)}">`
            + `${escapeHtml(label)} ${escapeHtml(total)}</button>`
        })
        .join('')
      + '</div>'
    const visible = active === 'all'
      ? ordered
      : ordered.filter((message) => messageCategory(message.kind) === active)

    const pairOf = (message) => {
      const from = str(message.from) || '?'
      const to = str(message.to) || '?'
      const members = [from, to].sort()
      return members.join(' ↔ ')
    }
    const groups = new Map()
    for (const message of visible) {
      const key = pairOf(message)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(message)
    }
    const groupList = [...groups.entries()]
      .map(([pair, rows]) => ({
        pair,
        rows,
        latest: Date.parse(rows[rows.length - 1]?.at ?? ''),
      }))
      .sort((a, b) => (Number.isFinite(b.latest) ? b.latest : 0) - (Number.isFinite(a.latest) ? a.latest : 0))
    if (visible.length === 0) {
      return filterBar + renderViewEmptyHtml(
        '该分类下暂无记录',
        `当前筛的是「${MESSAGE_CATEGORY_LABELS[active] || active}」；点「全部」看所有协同记录。`,
      )
    }
    return filterBar + '<div class="lx-vmsg-groups">'
      + groupList
        .map((group) => '<section class="lx-vmsg-group">'
          + '<div class="lx-vmsg-group-head">'
          + `<span class="lx-vmsg-pair">${escapeHtml(group.pair)}</span>`
          + `<span class="lx-vnote">${escapeHtml(group.rows.length)} 条`
          + `${group.latest && Number.isFinite(group.latest) ? ` · 最近 ${escapeHtml(formatRelativeSeconds(Math.round((Date.now() - group.latest) / 1000)))}` : ''}</span>`
          + '</div>'
          + '<div class="lx-vtimeline">'
          + group.rows
            .map((message) => {
              const category = messageCategory(message.kind)
              const badge = `<span class="lx-vmsg-kind">${escapeHtml(MESSAGE_CATEGORY_LABELS[category] || category)}</span>`
              const related = message.challengeId !== null
                ? `<span class="lx-vmsg-challenge" title="该消息关联的题目">#${escapeHtml(message.challengeId)}</span>`
                : ''
              return '<div class="lx-vmsg lx-vmsg-' + escapeHtml(kindClass(message.kind)) + '">'
          + `<span class="lx-vmsg-time">${escapeHtml(formatTime(message.at))}</span>`
          + `<span class="lx-vmsg-kind">${escapeHtml(MESSAGE_KIND_LABELS[message.kind] || message.kind)}</span>`
          + `<span class="lx-vmsg-route">${escapeHtml(message.from)} <i class="lx-varrow">→</i> ${escapeHtml(message.to)}</span>`
          + `<span class="lx-vmsg-text">${escapeHtml(message.text)}</span>`
          + badge
          + related
          + '</div>'
            })
            .join('')
          + '</div>'
          + '</section>')
        .join('')
      + '</div>'
  }

  /** ④ 提交审计：时间 / 题目 / 状态 / 脱敏 flag。 */
  function renderViewSubmissionsHtml(model) {
    const rows = list(model.state.submissions).slice(0, 30)
    if (rows.length === 0) {
      return renderViewEmptyHtml('暂无 flag 提交记录', 'ctf_submit_flag 的每一次提交（含重复与错误）都会记在这里。')
    }
    // 卡片式 + **完整 flag**：与悬浮面板共用 renderSubmissionCardsHtml（禁止各写一遍）。
    return renderSubmissionCardsHtml(rows)
  }

  /** ⑤ 报告（writeup）：列表 + 可展开正文。 */
  function renderViewReportsHtml(model) {
    const items = list(model.reports.items)
    if (items.length === 0) {
      const hint = model.reports.error
        ? `报告数据读取失败：${model.reports.error}`
        : '还没生成过 writeup：每道题解出后由 agent 调 ctf_writeup 写入 lingxu-ctf-work/writeups/，'
          + '生成后这里会立刻出现（列表每 5 秒刷新一次）。'
      return renderViewEmptyHtml('暂无 writeup', hint)
    }
    return items
      .map((report) => {
        const badge = report.submitted
          ? '<span class="lx-vpill lx-vpill-completed">已提交平台</span>'
          : '<span class="lx-vpill lx-vpill-pending">仅本地</span>'
        // 正文：宿主 /reports 现在会回 bodyPreview（前 4000 字符）；老宿主只有元信息时
        // 宿主未返回正文时明确说明，避免把缺失和空文件混为一谈。
        const limited = report.body.length > 20000 ? `${report.body.slice(0, 20000)}\n…（正文已截断）` : report.body
        const truncatedHint = report.bodyChars > report.body.length
          ? `\n\n…（预览前 ${report.body.length} 字符，全文 ${report.bodyChars} 字符；完整内容见文件）`
          : ''
        const body = limited !== ''
          ? `<pre class="lx-vreport-body">${escapeHtml(limited + truncatedHint)}</pre>`
          : `<div class="lx-vnote lx-vreport-empty">${escapeHtml(
            report.bytes > 0
              ? `宿主未返回正文预览（文件 ${report.bytes} 字节，见上方路径）`
              : '正文为空（文件 0 字节）',
          )}</div>`
        return `<details class="lx-vreport" data-lx-detail="report:${escapeHtml(report.path || report.id)}">`
          + '<summary>'
          + `<span class="lx-vreport-title">${escapeHtml(report.title)}</span>`
          + `<span class="lx-vreport-challenge">${escapeHtml(report.challengeName)}</span>`
          + badge
          + `<span class="lx-vnote" title="文件最后修改时间">生成 ${escapeHtml(formatTime(report.generatedAt))}</span>`
          + (report.bytes > 0 ? `<span class="lx-vnote">${escapeHtml(report.bytes)} 字节</span>` : '')
          + (report.submittedAt !== '' ? `<span class="lx-vnote">提交 ${escapeHtml(formatTime(report.submittedAt))}</span>` : '')
          + (report.path !== ''
            ? `<span class="lx-vnote lx-vpath" title="${escapeHtml(report.path)}">${escapeHtml(truncate(report.path, 48))}</span>`
            : '')
          + '</summary>'
          + body
          + '</details>'
      })
      .join('')
  }

  /**
   * 环境型题目集合：`taskType === 1`（已探测的环境型）或**有 env 记录**的题
   * （`envRemainingSeconds !== null`，含刚过期的）。
   */
  function envChallengesOf(board) {
    return list(board).filter((item) => (
      num(item.taskType, 0) === 1 || item.envRemainingSeconds !== null
    ))
  }

  /** 理论题总题量（tab 角标用）：所有试卷的 `count` 之和。 */
  function theoryQuestionCount(papers) {
    return list(papers).reduce((sum, paper) => sum + num(obj(paper)?.count, 0), 0)
  }

  /** 运行中的环境数（`envRemainingSeconds > 0` 且未过期）。 */
  function runningEnvCount(board) {
    return envChallengesOf(board).filter((item) => {
      const env = envStateOf(item)
      return env !== null && env.tone !== 'error'
    }).length
  }

  /**
   * ⑥ 环境子视图：只列环境型题目 —— 谁在跑、还剩多久、谁占着。
   * 用途：环境上限通常只有 2，用户要据此决定放掉哪个（`ctf_release_env`）。
   */
  function renderViewEnvHtml(model) {
    const env = obj(model.state.env) || normalizeEnv(null)
    const rows = envChallengesOf(model.board)
    const quota = env.known
      ? '<div class="lx-venv-quota">'
        + `<span class="lx-vnote">本插件占用 ${escapeHtml(env.held)}/${escapeHtml(env.limit)}（空闲 ${escapeHtml(env.free)}）</span>`
        + (env.full
          ? '<span class="lx-venv lx-venv-warn">本插件配额已满 · 新环境起不来，先释放一个</span>'
          : '')
        + (env.blocked === true
          ? `<span class="lx-venv lx-venv-warn" title="${escapeHtml(str(env.blockedReason)
            || '平台环境配额已满（最近 ctf_start_env 撞到平台上限）')}">⚠ 平台环境配额已满</span>`
          : '')
        + '</div>'
      : (env.blocked === true
        ? `<div class="lx-venv-quota"><span class="lx-venv lx-venv-warn">⚠ 平台环境配额已满</span></div>`
        : '')
    if (rows.length === 0) {
      return quota + renderViewEmptyHtml(
        '当前没有运行中的环境',
        '环境型题目用 ctf_start_env 起环境；起过的题会在这里显示剩余时间，方便决定释放哪个。',
      )
    }
    // 排序：告警/过期优先 → 剩余时间少的优先 → 未起环境的最后
    const rank = { error: 0, warn: 1, ok: 2 }
    const ordered = rows.slice().sort((a, b) => {
      const ea = envStateOf(a)
      const eb = envStateOf(b)
      if (ea === null && eb === null) return 0
      if (ea === null) return 1
      if (eb === null) return -1
      if (rank[ea.tone] !== rank[eb.tone]) return rank[ea.tone] - rank[eb.tone]
      return ea.seconds - eb.seconds
    })
    // 只列**有环境记录**或**未解的环境型题目**：已解且无环境的题不再占资源，列出来只会淹没重点。
    const needed = ordered.filter((item) => envStateOf(item) !== null || item.status !== 'solved')
    const hiddenSolved = ordered.length - needed.length
    return quota + (hiddenSolved > 0
      ? `<div class="lx-vnote">已省略 ${escapeHtml(hiddenSolved)} 道已解且无环境的环境型题目</div>`
      : '')
      + needed
      .map((item) => {
        const state = envStateOf(item)
        const owners = list(item.owners).length > 0
          ? item.owners
          : (item.owner !== null && item.owner !== undefined ? [item.owner] : [])
        const ownerText = owners.length > 0
          ? owners.map((name) => `<span class="lx-vagent">@${escapeHtml(name)}</span>`).join('')
          : '<span class="lx-vnote">无 agent 认领</span>'
        const hint = state === null
          ? '<span class="lx-vnote">尚未起环境（ctf_start_env）</span>'
          : (state.tone === 'error'
            ? '<span class="lx-vnote lx-vwarn">已过期 · 需要重新 ctf_start_env</span>'
            : `<span class="lx-vnote">剩余 ${escapeHtml(state.short)}</span>`)
        return '<div class="lx-venv-row">'
          + '<div class="lx-venv-head">'
          + `<span class="lx-venv-name">${escapeHtml(item.name)}</span>`
          + `<span class="lx-vnote">${escapeHtml(item.category)}</span>`
          + renderTaskTypeBadgeHtml(item)
          + (state !== null ? renderEnvChipHtml(item) : '')
          + '</div>'
          + '<div class="lx-venv-meta">'
          + `<span class="lx-pill lx-pill-${escapeHtml(item.status)}">${escapeHtml(STATUS_LABELS[item.status] || item.status)}</span>`
          + ownerText
          + hint
          + `<span class="lx-vnote">${escapeHtml(item.score)} 分</span>`
          + '</div>'
          + '</div>'
      })
      .join('')
  }

  /**
   * ⑦ 理论题子视图 —— 复用共享的 renderTheoryItemsHtml()（面板底部区块用的是同一份）。
   */
  function renderViewTheoryHtml(model) {
    const papers = list(model.state.theory)
    if (papers.length === 0) {
      return renderViewEmptyHtml('本赛事没有理论题赛段', '平台的 test_type 不等于理论题，或该赛事没有理论题赛段。')
    }
    const questions = model.theoryQuestions || null
    const QUESTIONS_HINT = '题目列表不会自动拉取（100 道题的题面很大，也会消耗平台配额）：'
      + '点「加载题目概要」才会请求一次，只回题干摘要与答题状态。'
    // 试卷行仍然共用 renderTheoryItemsHtml；视图只往“动作槽”里多塞
    //    一个「加载题目概要」按钮 + 按需加载出来的题目列表。
    return renderTheoryItemsHtml(papers, {
      actionOf: (paper) => {
        const canLoad = paper.isBegin === true && paper.isParse !== true
        const loaded = questions !== null && String(questions.testId) === String(paper.id)
        let body
        if (loaded && questions.ok === true) {
          body = questions.questions.length === 0
            ? '<div class="lx-vnote">试卷没有返回题目（可能尚未开始，先用 ctf_theory action=begin）。</div>'
            : '<ol class="lx-vq-list">'
              + questions.questions
                .map((question) => '<li class="lx-vq-item">'
                  + `<span class="lx-vq-stem">${escapeHtml(question.stem || '（无题干）')}</span>`
                  + (question.type !== '' ? `<span class="lx-vpill">${escapeHtml(question.type)}</span>` : '')
                  + `<span class="lx-vpill ${question.answered ? 'lx-vpill-completed' : 'lx-vpill-pending'}">${question.answered ? '已答' : '未答'}</span>`
                  + (question.optionsCount > 0 ? `<span class="lx-vnote">${escapeHtml(question.optionsCount)} 选项</span>` : '')
                  + `<span class="lx-vnote">#${escapeHtml(question.id ?? '?')}</span>`
                  + '</li>')
                .join('')
              + '</ol>'
              + `<div class="lx-vnote">共 ${escapeHtml(questions.total)} 题、已答 ${escapeHtml(questions.answered)} 题`
              + `${questions.truncated ? '（已截断显示）' : ''}</div>`
        } else if (loaded && questions.ok === false) {
          body = `<div class="lx-alert lx-alert-error">题目加载失败：${escapeHtml(questions.error || '未知错误')}</div>`
        } else if (loaded) {
          body = '<div class="lx-alert lx-alert-dim">正在加载题目概要…</div>'
        } else {
          body = `<div class="lx-vnote">${escapeHtml(QUESTIONS_HINT)}</div>`
        }
        return `<button class="lx-vbtn lx-vtheory-load" type="button" data-test-id="${escapeHtml(paper.id ?? '')}"`
          + `${canLoad ? '' : ' disabled title="试卷未开启或已交卷：平台不再开放题目列表"'}>加载题目概要</button>`
          + `<div class="lx-vquestions">${body}</div>`
      },
    })
  }

  /** 子 tab → HTML 片段。 */
  function renderViewBodyHtml(model, tab, filters = {}) {
    switch (str(tab)) {
      case 'theory': return renderViewTheoryHtml(model)
      case 'agents': return renderViewAgentsHtml(model)
      case 'messages': return renderViewMessagesHtml(model, filters)
      case 'submissions': return renderViewSubmissionsHtml(model)
      case 'reports': return renderViewReportsHtml(model)
      case 'env': return renderViewEnvHtml(model)
      default: return renderViewBoardHtml(model, filters)
    }
  }

  /** 子 tab 上的角标数字。 */
  function renderViewTabCount(tab, model) {
    switch (str(tab)) {
      case 'agents': return model.team.counts.members
      case 'messages': return model.team.messages.length
      case 'submissions': return model.state.submissions.length
      case 'reports': return model.reports.items.length
      case 'theory': return theoryQuestionCount(model.state.theory)
      case 'env': return runningEnvCount(model.board)
      default: return model.stats.total
    }
  }

  //  顶部「CTF」视图：DOM 控制器

  /**
   * CTF 视图控制器（纯 DOM，React 只提供挂载点 —— 与配置卡片同一套路子）。
   *
   * 骨架只建一次（子 tab / 筛选控件不随轮询重建，输入焦点不丢），每次刷新只重绘
   * 数据区域。`mount()` 返回根元素但**不负责插入**（插入由 React host 做）。
   *
   * @param {{doc?:Document,win?:Window,fetchImpl?:Function,stateUrl?:string,teamUrl?:string,reportsUrl?:string,intervalMs?:number}} options
   */
  function createCtfView(options = {}) {
    const doc = options.doc || (typeof document !== 'undefined' ? document : null)
    const win = options.win || (typeof window !== 'undefined' ? window : null)
    // 会话 token 用量投影的读取器由宿主注册时注入（视图自己没有 ctx）；缺失时返回 null → 走日志侧
    const sessionUsage = typeof options.sessionUsage === 'function' ? options.sessionUsage : () => null
    const sessionUsageBreakdownRef = typeof options.sessionUsageBreakdown === 'function' ? options.sessionUsageBreakdown : () => null
    const stateUrl = str(options.stateUrl, STATE_URL) || STATE_URL
    const teamUrl = str(options.teamUrl, TEAM_URL) || TEAM_URL
    const reportsUrl = str(options.reportsUrl, REPORTS_URL) || REPORTS_URL
    const theoryUrl = str(options.theoryUrl, THEORY_URL) || THEORY_URL
    const challengeUrl = str(options.challengeUrl, CHALLENGE_URL) || CHALLENGE_URL
    const intervalMs = num(options.intervalMs, POLL_INTERVAL_MS)
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
    const bodyId = `lx-view-body-${++nextViewId}`

    const state = {
      snapshot: normalizeState(null),
      team: normalizeTeam(null),
      reports: normalizeReports(null),
      tab: 'board',
      filters: { category: 'all', status: 'all', query: '', msgKind: 'all' },
      model: null,
      error: null,
      loading: true,
      loaded: false,
      updatedAt: null,
      // 页脚「更新于 N 秒前」用：上次成功拉到 /state 的本地时间
      lastFetchAt: null,
      // 理论题题目概要（按需拉取，绝不在轮询里自动请求 —— 100 道题的题面很大）
      theoryQuestions: null,
      challengeDetail: null,
      // token 用量：{ projection, log, reason }
      tokenUsage: null,
    }

    let root = null
    let regions = null
    let timer = null
    let visibilityHandler = null
    let destroyed = false
    let lastRefresh = Promise.resolve()
    // 轮询可能重叠（慢网络、页面重新可见、手动 refresh 同时发生）。每一轮
    // 都带自己的 generation；新一轮还会主动 abort 旧请求。某些宿主 fetch
    // 不实现 AbortController，所以 generation 检查仍然是最终防线。
    let refreshGeneration = 0
    let refreshController = null
    let theoryGeneration = 0
    let theoryController = null
    let theorySessionId = ''
    let challengeGeneration = 0
    let challengeController = null
    let renderedBodyHtml = null

    function newAbortController() {
      try {
        return typeof AbortController === 'function' ? new AbortController() : null
      } catch {
        return null
      }
    }

    function cancelRefresh() {
      refreshGeneration += 1
      if (refreshController !== null) {
        try { refreshController.abort() } catch { /* 旧宿主的 controller 可能不完整 */ }
        refreshController = null
      }
    }

    function cancelTheory() {
      theoryGeneration += 1
      if (theoryController !== null) {
        try { theoryController.abort() } catch { /* 旧宿主的 controller 可能不完整 */ }
        theoryController = null
      }
    }

    function cancelChallengeDetail() {
      challengeGeneration += 1
      if (challengeController !== null) {
        try { challengeController.abort() } catch { /* ignore */ }
        challengeController = null
      }
    }

    //  骨架
    function buildSkeleton() {
      const view = el(doc, 'section', VIEW_CLASS)

      // 头部：赛事摘要卡。只放用户做判断需要的赛事名、进度指标和统计，
      // 平台名、赛事 ID、URL、刷新按钮等实现细节不占首屏。
      // 数据由 5s 轮询保持新鲜，手动刷新仍不做成常驻按钮。
      const summary = el(doc, 'div', 'lx-vsummary')
      const top = el(doc, 'div', 'lx-vtop')
      const title = el(doc, 'div', 'lx-vtitle')
      const nameEl = el(doc, 'h2', 'lx-vname')
      nameEl.textContent = '凌虚 CTF'
      title.appendChild(nameEl)
      top.appendChild(title)

      const metaEl = el(doc, 'div', 'lx-vmeta')
      const statsEl = el(doc, 'div', 'lx-vstats')
      const alertEl = el(doc, 'div', 'lx-valerts')

      const tabsEl = el(doc, 'div', 'lx-vtabs')
      tabsEl.setAttribute('role', 'navigation')
      tabsEl.setAttribute('aria-label', 'CTF 视图')
      const primaryTabsEl = el(doc, 'div', 'lx-vtabs-primary')
      const moreEl = el(doc, 'details', 'lx-vmore')
      const moreSummary = el(doc, 'summary', 'lx-vmore-summary')
      moreSummary.textContent = '更多视图'
      moreEl.appendChild(moreSummary)
      const secondaryTabsEl = el(doc, 'div', 'lx-vtabs-secondary')
      moreEl.appendChild(secondaryTabsEl)
      moreEl.addEventListener('toggle', () => {
        // 低频视图仍是当前页时不能把它的入口收起来。
        if (!moreEl.open && !PRIMARY_VIEW_TABS.has(state.tab)) moreEl.open = true
      })
      const tabButtons = new Map()
      for (const tab of VIEW_TABS) {
        const btn = el(doc, 'button', 'lx-vtab')
        btn.type = 'button'
        btn.dataset.tab = tab.id
        btn.setAttribute('aria-controls', bodyId)
        const label = el(doc, 'span', 'lx-vtab-label')
        label.textContent = tab.label
        const count = el(doc, 'span', 'lx-vtab-count')
        count.textContent = '0'
        btn.appendChild(label)
        btn.appendChild(count)
        btn.addEventListener('click', () => setTab(tab.id))
        const tabGroup = PRIMARY_VIEW_TABS.has(tab.id) ? primaryTabsEl : secondaryTabsEl
        tabGroup.appendChild(btn)
        tabButtons.set(tab.id, { btn, count })
      }
      tabsEl.appendChild(primaryTabsEl)
      tabsEl.appendChild(moreEl)

      // 筛选控件只建一次：轮询重绘 body 不会夺走输入焦点。
      const toolbar = el(doc, 'div', 'lx-vtoolbar')
      toolbar.dataset.hidden = 'false'
      const categorySel = el(doc, 'select', 'lx-vfilter-category')
      categorySel.setAttribute('aria-label', '按分类过滤')
      const statusSel = el(doc, 'select', 'lx-vfilter-status')
      statusSel.setAttribute('aria-label', '按状态过滤')
      const searchInput = el(doc, 'input', 'lx-vsearch')
      searchInput.setAttribute('type', 'search')
      searchInput.setAttribute('placeholder', '搜索题名 / 分类 / agent')
      searchInput.setAttribute('aria-label', '搜索题目或 agent')
      toolbar.appendChild(categorySel)
      toolbar.appendChild(statusSel)
      toolbar.appendChild(searchInput)

      const bodyEl = el(doc, 'div', 'lx-vbody')
      bodyEl.id = bodyId
      // 页脚：数据新鲜度。
      const freshEl = el(doc, 'div', 'lx-vfresh')
      freshEl.textContent = '数据 尚未成功刷新'

      summary.appendChild(top)
      summary.appendChild(metaEl)
      summary.appendChild(statsEl)
      view.appendChild(summary)
      view.appendChild(alertEl)
      view.appendChild(tabsEl)
      view.appendChild(toolbar)
      view.appendChild(bodyEl)
      view.appendChild(freshEl)

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
      alertEl.addEventListener('click', (event) => {
        const target = event && event.target
        if (target && typeof target.className === 'string' && target.className.includes('lx-vretry')) void refresh()
      })
      // 理论题「加载题目概要」：**只在用户点击时**请求一次 /lingxu-ctf/theory（不自动全量拉）
      bodyEl.addEventListener('click', (event) => {
        const target = event && event.target
        if (!target) return
        const card = typeof target.closest === 'function' ? target.closest('.lx-vchallenge') : null
        if (card && typeof card.getAttribute === 'function') {
          void loadChallengeDetail(card.getAttribute('data-challenge-id'))
          return
        }
        if (typeof target.className !== 'string') return
        if (target.className.includes('lx-vtheory-load')) {
          const testId = typeof target.getAttribute === 'function' ? target.getAttribute('data-test-id') : null
          void loadTheoryQuestions(testId)
          return
        }
        // 协同通信分类筛选
        if (target.className.includes('lx-vmsg-filter')) {
          const next = typeof target.getAttribute === 'function' ? target.getAttribute('data-msg-kind') : null
          state.filters.msgKind = str(next) || 'all'
          patch()
        }
        if (target.className.includes('lx-vdetail-close')) {
          cancelChallengeDetail()
          state.challengeDetail = null
          patch()
        }
      })

      if (doc && typeof doc.addEventListener === 'function') {
        visibilityHandler = () => {
          if (doc.hidden !== true) void refresh()
        }
        doc.addEventListener('visibilitychange', visibilityHandler)
      }

      regions = {
        nameEl, metaEl, statsEl, alertEl, bodyEl, toolbar, freshEl, moreEl,
        tabButtons, categorySel, statusSel, searchInput,
      }
      return view
    }

    //  渲染
    function currentModel() {
      const board = mergeChallengeBoard(state.snapshot.challenges, state.team)
      return {
        state: state.snapshot,
        team: state.team,
        reports: state.reports,
        board,
        stats: viewStats(state.snapshot, board, state.team),
        // 理论题是按需加载的：模型里必须带上它，否则重绘时又被当成「还没点过」
        theoryQuestions: state.theoryQuestions,
        challengeDetail: state.challengeDetail,
        tokenUsage: state.tokenUsage,
        error: state.error,
        loading: state.loading,
        loaded: state.loaded,
      }
    }

    function syncFilterOptions() {
      const { categorySel, statusSel } = regions
      const categories = challengeCategories(state.model.board)
      if (state.filters.category !== 'all' && !categories.includes(state.filters.category)) {
        state.filters.category = 'all'
      }
      categorySel.innerHTML = ['<option value="all">全部分类</option>']
        .concat(categories.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`))
        .join('')
      categorySel.value = state.filters.category

      statusSel.innerHTML = [
        '<option value="all">全部状态</option>',
        '<option value="pending">待解</option>',
        '<option value="working">进行中</option>',
        '<option value="solved">已解</option>',
      ].join('')
      statusSel.value = state.filters.status
    }

    /** 只重绘数据区域。 */
    function patch() {
      if (destroyed || regions === null) return
      const model = currentModel()
      state.model = model
      const snapshot = state.snapshot

      regions.nameEl.textContent = snapshot.event.name || '凌虚 CTF'
      // 账号信息价值不大，不放正文（用户嫌乱），挂在标题 tooltip 上
      regions.nameEl.title = snapshot.event.username ? `账号 @${snapshot.event.username}` : ''
      // 指标行：一行小字，`·` 分隔、无 chip 底色（见 renderViewMetaHtml）
      regions.metaEl.innerHTML = snapshot.configured ? renderViewMetaHtml(model) : ''
      regions.statsEl.innerHTML = snapshot.configured ? renderViewStatsHtml(model) : ''
      regions.alertEl.innerHTML = renderViewAlertHtml(model)

      for (const tab of VIEW_TABS) {
        const entry = regions.tabButtons.get(tab.id)
        if (!entry) continue
        entry.btn.className = tab.id === state.tab ? 'lx-vtab is-active' : 'lx-vtab'
        entry.btn.setAttribute('aria-pressed', tab.id === state.tab ? 'true' : 'false')
        entry.count.textContent = snapshot.configured ? String(renderViewTabCount(tab.id, model)) : ''
      }
      regions.toolbar.dataset.hidden = state.tab === 'board' ? 'false' : 'true'
      const bodyHtml = snapshot.configured
        ? renderViewBodyHtml(model, state.tab, state.filters)
        : renderViewEmptyHtml('尚未连接竞赛平台', NOT_CONFIGURED_HINT)
      const nextBodyHtml = snapshot.configured && state.tab === 'board'
        ? renderChallengeDetailHtml(state.challengeDetail) + bodyHtml
        : bodyHtml
      // 轮询只替换有变化的内容。数据变化时仍保留当前正在阅读的原生 details，
      // 以及报告正文的滚动位置；不能每 5 秒把展开的报告和任务列表收回。
      if (nextBodyHtml !== renderedBodyHtml) {
        const details = new Map()
        for (const node of regions.bodyEl.querySelectorAll('details[data-lx-detail]')) {
          if (!node.open) continue
          const body = node.querySelector('.lx-vreport-body')
          details.set(node.getAttribute('data-lx-detail'), body?.scrollTop ?? 0)
        }
        regions.bodyEl.innerHTML = nextBodyHtml
        for (const node of regions.bodyEl.querySelectorAll('details[data-lx-detail]')) {
          const key = node.getAttribute('data-lx-detail')
          if (!details.has(key)) continue
          node.open = true
          const body = node.querySelector('.lx-vreport-body')
          if (body) body.scrollTop = details.get(key)
        }
        renderedBodyHtml = nextBodyHtml
      }
      if (snapshot.configured && state.tab === 'board') syncFilterOptions()

      // 页脚新鲜度（问题 15）：让用户知道数据不是卡住的。
      // 优先用宿主给的 cachedAt（theory-dev 的面板缓存），退回本地「上次成功 fetch」。
      const fetchedAt = state.lastFetchAt === null ? null : Math.round((Date.now() - state.lastFetchAt) / 1000)
      const cacheAge = snapshot.cachedAt !== null
        ? Math.max(0, Math.round((Date.now() - Date.parse(snapshot.cachedAt)) / 1000))
        : null
      const ageText = cacheAge !== null
        ? `${formatRelativeSeconds(cacheAge)}${snapshot.fromCache === true ? ' · 缓存' : ''}`
        : (fetchedAt === null ? '尚未成功刷新' : formatRelativeSeconds(fetchedAt))
      regions.freshEl.textContent = `数据 ${ageText} · 每 ${Math.round(intervalMs / 1000)} 秒自动刷新`
    }

    /** 切换子 tab（未知 id 忽略）。 */
    function setTab(id) {
      const wanted = str(id)
      if (!VIEW_TABS.some((tab) => tab.id === wanted)) return
      if (state.tab === wanted) return
      state.tab = wanted
      if (regions !== null) regions.moreEl.open = !PRIMARY_VIEW_TABS.has(wanted)
      patch()
    }

    //  数据

    /** 按需加载一题详情，并阻止旧请求覆盖当前选择。 */
    async function loadChallengeDetail(challengeId) {
      const id = str(challengeId)
      if (id === '') return
      cancelChallengeDetail()
      const generation = challengeGeneration
      const controller = newAbortController()
      const signal = controller?.signal ?? null
      challengeController = controller
      const isCurrent = () => !destroyed && generation === challengeGeneration
      state.challengeDetail = { loading: true, id, ok: null, challenge: null }
      patch()
      try {
        let usageSource = null
        try { usageSource = sessionUsage() } catch { /* session service may be absent */ }
        const sessionId = str(obj(usageSource)?.sessionId)
        const payload = await fetchJson(sessionUrl(`${challengeUrl}?id=${encodeURIComponent(id)}`, sessionId), signal)
        if (!isCurrent()) return
        state.challengeDetail = { ...payload, loading: false, id }
      } catch (error) {
        if (isCurrent()) state.challengeDetail = { loading: false, id, ok: false, error: errorText(error) }
      } finally {
        if (challengeController === controller) challengeController = null
      }
      if (isCurrent()) patch()
    }

    /**
     * 按需拉取理论题概要。
     * 只回题干摘要/题型/是否已答，不回选项与正文；失败时把错误显示在卡片里，不静默。
     */
    async function loadTheoryQuestions(testId) {
      const paperId = str(testId)
      if (paperId === '') return
      cancelTheory()
      const generation = theoryGeneration
      const controller = newAbortController()
      const signal = controller?.signal ?? null
      theoryController = controller
      const isCurrent = () => !destroyed && generation === theoryGeneration
      state.theoryQuestions = { loading: true, testId: paperId, ok: null, questions: [], total: 0, answered: 0, error: null }
      patch()
      if (fetchImpl === null) {
        if (isCurrent()) {
          state.theoryQuestions = { loading: false, testId: paperId, ok: false, questions: [], total: 0, answered: 0, error: '当前环境不支持 fetch' }
          patch()
        }
        if (theoryController === controller) theoryController = null
        return
      }
      try {
        let usageSource = null
        try { usageSource = sessionUsage() } catch { /* 会话服务切换时按空上下文处理 */ }
        const sessionId = str(obj(usageSource)?.sessionId)
        const theoryRequest = sessionUrl(
          `${theoryUrl}?testId=${encodeURIComponent(paperId)}&limit=100`,
          sessionId,
        )
        const response = await fetchImpl(theoryRequest, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          ...(signal ? { signal } : {}),
        })
        if (!isCurrent()) return
        const payload = response && typeof response.json === 'function' ? await response.json().catch(() => null) : null
        if (!isCurrent()) return
        if (!response || response.ok === false || payload === null) {
          const detail = payload && payload.error ? String(payload.error) : `HTTP ${response && response.status !== undefined ? response.status : '?'}`
          state.theoryQuestions = { loading: false, testId: paperId, ok: false, questions: [], total: 0, answered: 0, error: detail }
        } else {
          state.theoryQuestions = {
            loading: false,
            testId: paperId,
            ok: payload.ok !== false,
            questions: list(payload.questions).map((row) => ({
              id: obj(row)?.id ?? null,
              type: str(obj(row)?.type),
              stem: str(obj(row)?.stem),
              answered: obj(row)?.answered === true,
              optionsCount: num(obj(row)?.optionsCount, 0),
            })),
            total: num(payload.total, 0),
            answered: num(payload.answered, 0),
            truncated: payload.truncated === true,
            error: str(payload.error) || null,
          }
        }
      } catch (error) {
        if (isCurrent()) {
          state.theoryQuestions = { loading: false, testId: paperId, ok: false, questions: [], total: 0, answered: 0, error: errorText(error) }
        }
      } finally {
        if (theoryController === controller) theoryController = null
      }
      if (isCurrent()) patch()
    }

    /** 单个请求的永不 reject 包装。 */
    function settle(promise) {
      return Promise.resolve(promise).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
    }

    function errorText(error) {
      const status = num(obj(error)?.status, 0)
      if (status > 0) return `HTTP ${status}`
      const message = str(obj(error)?.message)
      if (message !== '') return message
      return str(error, '未知错误')
    }

    /** GET 一个 same-origin JSON 路由。 */
    async function fetchJson(url, signal = null) {
      if (fetchImpl === null) throw new Error('当前环境不支持 fetch')
      const request = { cache: 'no-store', headers: { accept: 'application/json' } }
      if (signal !== null) request.signal = signal
      const response = await fetchImpl(url, request)
      let payload = null
      if (response && typeof response.json === 'function') payload = await response.json().catch(() => null)
      if (response && response.ok === false) {
        const error = new Error(`HTTP ${response.status !== undefined ? response.status : '?'}`)
        error.status = response.status
        error.payload = payload
        throw error
      }
      if (payload === null) throw new Error('响应不是合法 JSON')
      return payload
    }

    /** 拉一次三份数据并重绘；永不 reject。 */
    async function refresh() {
      if (destroyed || regions === null) return
      if (fetchImpl === null) {
        state.error = '当前环境不支持 fetch'
        state.loading = false
        state.loaded = true
        patch()
        return
      }

      // 先取消旧一轮，再分配新的代次。即使 fetch 实现忽略 signal，下面的
      // `isCurrent` 也会阻止旧响应写入 state。
      if (refreshController !== null) {
        try { refreshController.abort() } catch { /* ignore */ }
      }
      const generation = ++refreshGeneration
      const controller = newAbortController()
      const signal = controller?.signal ?? null
      refreshController = controller
      const isCurrent = () => !destroyed && generation === refreshGeneration

      try {
        let usageSource = null
        try { usageSource = sessionUsage() } catch { /* 会话服务切换时按空上下文处理 */ }
        const sessionId = str(obj(usageSource)?.sessionId)
        if (sessionId !== theorySessionId) {
          theorySessionId = sessionId
          if (state.theoryQuestions !== null) {
            cancelTheory()
            state.theoryQuestions = null
          }
          if (state.challengeDetail !== null) {
            cancelChallengeDetail()
            state.challengeDetail = null
          }
        }
        const scopedStateUrl = sessionUrl(stateUrl, sessionId)
        const scopedTeamUrl = sessionUrl(teamUrl, sessionId)
        const scopedReportsUrl = sessionUrl(reportsUrl, sessionId)
        const [snapshotResult, teamResult, reportsResult] = await Promise.all([
          settle(fetchJson(scopedStateUrl, signal)),
          settle(fetchJson(scopedTeamUrl, signal)),
          settle(fetchJson(scopedReportsUrl, signal)),
        ])

        // Promise.all 可能在宿主忽略 AbortSignal 时仍然等到旧响应；在任何
        // 状态写入前再次核对代次，避免旧赛事/旧会话覆盖新视图。
        if (!isCurrent()) return

        // ① 赛事快照：失败时保留上一次的好数据，只挂错误提示。
        // token 用量：投影来自 DSH 会话快照（同步，权威），日志侧走宿主路由（带 TTL 缓存）。
        // 拿不到 sessions 服务时 sessionId 传空 → 宿主退化为「最近写入的会话日志」。
        const loaded = await loadTokenUsage(fetchImpl, sessionId)
        if (!isCurrent()) return
        state.tokenUsage = obj(loaded) === null && obj(usageSource) === null
          ? null
          : {
            sessionId: str(obj(loaded)?.sessionId) || str(obj(usageSource)?.sessionId),
            projection: obj(usageSource)?.projection ?? null,
            log: obj(loaded)?.log ?? null,
            inferred: obj(loaded)?.inferred === true,
            compactionTokens: num(obj(loaded)?.compactionTokens, 0),
            billedTokens: num(obj(loaded)?.billedTokens, 0),
            reason: str(obj(loaded)?.reason),
            breakdown: sessionUsageBreakdownRef(),
          }

        if (snapshotResult.ok) {
          state.snapshot = normalizeState(snapshotResult.value)
          state.error = state.snapshot.configured ? state.snapshot.error : null
          state.updatedAt = new Date().toISOString()
          state.lastFetchAt = Date.now()
        } else {
          state.error = errorText(snapshotResult.error)
        }

        // ② 团队 / 协同（路由可能还不存在 → 空态而不是报错）
        if (teamResult.ok) {
          const team = normalizeTeam(teamResult.value)
          state.team = team.ok ? team : { ...team, error: team.error || str(obj(teamResult.value)?.error) || null }
        } else {
          state.team = { ...normalizeTeam(null), error: errorText(teamResult.error) }
        }

        // ③ 报告（可选路由；拿不到就空态）
        if (reportsResult.ok) {
          state.reports = normalizeReports(reportsResult.value)
        } else {
          state.reports = { ok: false, error: errorText(reportsResult.error), items: [] }
        }

        state.loading = false
        state.loaded = true
        patch()
      } finally {
        // 旧一轮不能清掉新一轮的 controller。
        if (refreshController === controller) refreshController = null
      }
    }

    function tick() {
      if (destroyed) return
      if (doc && doc.hidden === true) return
      void refresh()
    }

    /** 启动轮询（幂等：先停旧的）。 */
    function start() {
      if (destroyed) return
      stop()
      lastRefresh = refresh()
      if (win && typeof win.setInterval === 'function') {
        timer = { handle: win.setInterval(tick, intervalMs), scheduler: win }
      } else if (typeof setInterval === 'function') {
        timer = { handle: setInterval(tick, intervalMs), scheduler: null }
      }
    }

    function stop() {
      if (timer !== null) {
        const { handle, scheduler } = timer
        if (scheduler && typeof scheduler.clearInterval === 'function') scheduler.clearInterval(handle)
        else if (typeof clearInterval === 'function') clearInterval(handle)
        timer = null
      }
      cancelRefresh()
    }

    /** 建骨架并返回根元素（**不插入 DOM**，插入由调用方负责）。 */
    function mount() {
      if (root !== null || destroyed) return root
      if (!doc || typeof doc.createElement !== 'function') return null
      ensureStyles(doc)
      root = buildSkeleton()
      patch()
      return root
    }

    function destroy() {
      if (destroyed) return
      stop()
      cancelTheory()
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
      setTab,
      element: () => root,
      get state() { return state },
      get mounted() { return root !== null },
      get destroyed() { return destroyed },
      get ready() { return lastRefresh },
    }
  }

  //  顶部「CTF」视图：React host 与 slot 注册

  /**
   * 用 React 承载纯 DOM 视图：React 只提供挂载点（ref + effect），视图本身仍是
   * `createCtfView` 的纯 DOM 实现 —— 与配置卡片完全同一套路子，避免手写 VDOM。
   */
  //  视图组件必须是**稳定标识**
  //
  // 踩过的坑：早期把组件定义在 reactCtfViewHost() 里，于是宿主每次重渲染 slot
  // 都得到一个新的函数标识。React 按标识判断组件类型，标识变了就当成另一个组件
  // ——先卸载整棵树再重新挂载，视觉上就是「一直在闪」。而且每次重挂载都会重新拉
  // 一次状态，于是空态里那句「尚未连接竞赛平台」会一闪而过。
  //
  // 修法：组件只创建一次并缓存，options 放模块级「最新值」供其读取
  // （slot 选项在一次会话内是常量，用 [] 依赖挂载一次即可）。
  let ctfViewOptions = {}
  let CtfViewComponent = null
  let ctfViewReact = null

  function ctfViewComponent(react) {
    if (CtfViewComponent !== null) return CtfViewComponent
    ctfViewReact = react
    const h = react.createElement
    CtfViewComponent = function LingxuCtfView() {
      const ref = react.useRef(null)
      react.useEffect(() => {
        const view = createCtfView(ctfViewOptions)
        const host = ref.current
        const element = view.mount()
        if (host && typeof host.appendChild === 'function' && element) host.appendChild(element)
        view.start()
        const stopVisibility = watchViewVisibility(host)
        return () => {
          stopVisibility()
          view.destroy()
        }
      }, [])
      return h('div', { className: 'lx-view-host', ref })
    }
    return CtfViewComponent
  }

  function reactCtfViewHost(react, options) {
    ctfViewOptions = options || {}
    // ⚠️ 必须返回**元素**：渲染器把 slot 函数的返回值直接当 React child，
    // 返回组件函数会抛 "Functions are not valid as a React child" → 条目被退休。
    return react.createElement(ctfViewComponent(react))
  }

  /**
   * 视图 slot 渲染函数。
   * - 有 React → React 元素（真实页面路径）
   * - 无 React → 纯 DOM 节点（会打点，便于在 /lingxu-ctf/diag 里定位）
   */
  function renderCtfViewSlot(props = {}, options = {}) {
    const react = options.react || reactRuntime
    if (react && typeof react.createElement === 'function') return reactCtfViewHost(react, options)
    beacon('ctf-view-dom-fallback', 'react=' + (react ? 'no-createElement' : 'absent'))
    const view = createCtfView(options)
    view.mount()
    view.start()
    return view.element()
  }

  /**
   * 读一个 service：**绝不用属性访问**。
   * Cordis 的 ctx 是 Proxy，读未 inject 的 service 会抛
   * `cannot get property "<name>" without inject`，可选链也拦不住；
   * 而 `ctx.get(name)` 对不存在的 service 返回 undefined。
   */
  function readService(ctx, key) {
    if (!ctx) return null
    try {
      if (typeof ctx.get === 'function') return ctx.get(key) ?? null
    } catch { /* ctx.get 不可用 → 退回属性探测 */ }
    try {
      return ctx[key] ?? null
    } catch {
      return null
    }
  }

  /**
   * 跟踪「CTF 视图是不是真的显示着」，据此在 `body` 上打 `data-lx-view` 标记；
   * 样式那边用它在视图模式下隐藏宿主的输入框（用户要求：视图下不要输入框）。
   *
   * 为什么不直接依赖挂载/卸载：宿主**可能**把非激活的视图留在 DOM 里只是隐藏起来
   * （那样卸载时的清理根本不会发生，标记会一直挂着 → 切回「对话」也没了输入框）。
   * 所以按**实际可见性**判断（`getClientRects()` 有没有盒子），两种挂载策略下都正确。
   */
  function watchViewVisibility(host, doc) {
    const document_ = doc || (typeof document !== 'undefined' ? document : null)
    if (!host || document_ === null) return () => {}
    let on = null
    const tick = () => {
      let visible = false
      try {
        visible = typeof host.getClientRects === 'function' && host.getClientRects().length > 0
      } catch { visible = false }
      if (visible === on) return
      on = visible
      try {
        if (visible) document_.body.setAttribute('data-lx-view', 'on')
        else document_.body.removeAttribute('data-lx-view')
      } catch { /* body 不可用就算了，绝不能影响视图本身 */ }
    }
    tick()
    const timer = typeof setInterval === 'function' ? setInterval(tick, 300) : null
    // Node（单测）里别拖住进程退出；浏览器里 setInterval 返回数字，unref 不存在
    if (timer && typeof timer.unref === 'function') timer.unref()
    return () => {
      if (timer !== null && typeof clearInterval === 'function') clearInterval(timer)
      try { document_.body.removeAttribute('data-lx-view') } catch { /* ignore */ }
    }
  }


  /** 会话 preset id → 是否属于 CTF 会话（预设 ctf 及其 ctf-* 副本）。 */
  function isCtfPresetId(id) {
    const text = str(id).toLowerCase()
    return text === CTF_PRESET_ID || text.startsWith(CTF_PRESET_PREFIX)
  }

  /** 一行会话记录携带的 preset id（兼容旧字段 agentPreset 与新投影 projectionValues）。 */
  function sessionRowPreset(row) {
    const projected = obj(row)?.projectionValues
    const value = obj(projected)?.agentPreset ?? obj(row)?.agentPreset
    return str(value) || undefined
  }

  /**
   * 当前会话的 token 用量投影：DSH 把 `tokenUsage` 作为会话投影下发，
   * 客户端统计药丸读的就是它 —— 我们读同一份，保证数字与 DSH 自己显示的一致。
   *
   * @returns {{ sessionId: string, projection: object|null }|null}
   */
  function sessionUsageOf(ctx) {
    const store = sessionListStore(ctx)
    if (store === null) return null
    let snapshot = null
    try {
      snapshot = store.getSnapshot()
    } catch {
      return null
    }
    const sessionId = currentSessionOf(snapshot)
    if (sessionId === undefined) return null
    const row = obj(obj(obj(snapshot)?.byId)?.[sessionId])
    const projected = obj(obj(row)?.projectionValues)?.tokenUsage
    return { sessionId, projection: normalizeUsageBuckets(projected) }
  }

  /**
   * 按**会话**拆分的用量（≈分 agent）。
   *
   * DSH 不给「agent 名字 → 会话」的映射，但每个 teammate 是**独立子会话**
   * （日志头部有 `parentSession`），所以按 `parentId` 串出当前会话的后代即可分列。
   * 标签用会话标题，没有就用 agentPreset / 短 id —— **不编名字**。
   */
  function sessionUsageBreakdown(ctx) {
    const store = sessionListStore(ctx)
    if (store === null) return null
    let snapshot = null
    try {
      snapshot = store.getSnapshot()
    } catch {
      return null
    }
    const current = currentSessionOf(snapshot)
    if (current === undefined) return null
    const byId = obj(obj(snapshot)?.byId) || {}
    const isDescendant = (id) => {
      let cursor = str(obj(byId[id])?.parentId)
      const seen = new Set()
      while (cursor !== '' && !seen.has(cursor)) {
        if (cursor === current) return true
        seen.add(cursor)
        cursor = str(obj(byId[cursor])?.parentId)
      }
      return false
    }
    const rows = []
    const push = (id, self) => {
      const row = obj(byId[id])
      const usage = normalizeUsageBuckets(obj(obj(row)?.projectionValues)?.tokenUsage)
      if (usage === null) return
      const title = str(obj(row)?.title)
      const preset = str(obj(row)?.projectionValues?.agentPreset ?? row?.agentPreset)
      const short = id.length > 12 ? id.slice(-8) : id
      rows.push({
        id,
        label: self ? '主会话' : (title !== '' ? title : (preset !== '' ? `${preset} · #${short}` : `子会话 #${short}`)),
        self: self === true,
        usage,
      })
    }
    push(current, true)
    for (const id of Object.keys(byId)) {
      if (id !== current && isDescendant(id)) push(id, false)
    }
    if (rows.length <= 1) return null
    return { rows, total: rows.reduce((sum, row) => sum + row.usage.total, 0) }
  }

  /** 分会话用量行（两族共用片段：视图 Agent 活动 + 面板用量区）。 */
  function renderUsageBreakdownHtml(breakdown) {
    const data = obj(breakdown)
    if (data === null || list(data.rows).length <= 1) return ''
    const items = list(data.rows)
      .slice()
      .sort((a, b) => num(b.usage?.total, 0) - num(a.usage?.total, 0))
      .map((row) => `<span class="lx-usage-item${row.self ? ' lx-usage-self' : ''}">`
        + `${escapeHtml(row.label)} ${escapeHtml(formatCount(row.usage.total))}</span>`)
      .join('')
    return `<div class="lx-usage-split">分会话：${items}`
      + `<span class="lx-vnote-dim"> · 每个 teammate 一个会话；DSH 不提供 agent 名→会话映射，故按会话列出（共 ${escapeHtml(items === '' ? 0 : list(data.rows).length)} 个）</span></div>`
  }

  /**
   * token 用量缓存：视图与面板共用（5 秒 TTL + 单飞），避免两族各拉一次。
   * `log` 来自宿主 `/lingxu-ctf/usage`（折叠会话日志）。
   */
  const usageCache = { at: 0, key: '', value: null, inflight: null, generation: 0 }

  async function loadTokenUsage(fetchImpl, sessionId) {
    const key = str(sessionId)
    const now = Date.now()
    // 允许空 key：宿主会退化为「最近写入的会话日志」（老宿主拿不到 sessions 服务时仍可用）
    if (fetchImpl === null) return null
    if (usageCache.key === key && usageCache.value !== null && now - usageCache.at < 5000) return usageCache.value
    if (usageCache.inflight !== null && usageCache.key === key) return usageCache.inflight
    usageCache.key = key
    const generation = ++usageCache.generation
    usageCache.inflight = (async () => {
      let log = null
      let reason = ''
      let resolvedId = key
      let inferred = false
      let compactionTokens = 0
      let billedTokens = 0
      try {
        const query = key === '' ? '' : `?session=${encodeURIComponent(key)}`
        const response = await fetchImpl(`${USAGE_URL}${query}`, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        const payload = response && typeof response.json === 'function' ? await response.json().catch(() => null) : null
        if (payload !== null && payload.ok === true) {
          log = normalizeUsageBuckets(payload.totals)
          resolvedId = str(payload.sessionId) || key
          inferred = payload.inferred === true
          compactionTokens = num(payload.compactionTokens, 0)
          billedTokens = num(payload.billedTokens, 0)
        } else {
          reason = str(obj(payload)?.error)
        }
      } catch (error) {
        reason = errorText(error)
      }
      const value = {
        log,
        reason,
        sessionId: resolvedId,
        inferred,
        // 压缩开销（宿主单列）：真实花费 = 工作 + 压缩
        compactionTokens,
        billedTokens,
      }
      // A slower request for an older session must not overwrite the current key.
      if (usageCache.generation === generation && usageCache.key === key) {
        usageCache.value = value
        usageCache.at = Date.now()
        usageCache.inflight = null
      }
      return value
    })()
    return usageCache.inflight
  }

  /** 测试用：清掉用量缓存。 */
  function resetUsageCache() {
    usageCache.at = 0
    usageCache.key = ''
    usageCache.value = null
    usageCache.inflight = null
    usageCache.generation += 1
  }

  /** 当前主视图会话 id：优先 `current`，退回 retainedBy.mainView 的那一行。 */
  function currentSessionOf(snapshot) {
    const src = obj(snapshot)
    if (src === null) return undefined
    if (typeof src.current === 'string' && src.current !== '') return src.current
    const byId = obj(src.byId)
    if (byId === null) return undefined
    const entry = Object.entries(byId).find(([, row]) => num(obj(obj(row)?.retainedBy)?.mainView, 0) > 0)
    return entry === undefined ? undefined : entry[0]
  }

  /** 该会话（或其祖先）是不是 CTF 会话。 */
  function isCtfSession(snapshot, id) {
    const byId = obj(obj(snapshot)?.byId) || {}
    let cursor = id
    const seen = new Set()
    while (typeof cursor === 'string' && cursor !== '' && !seen.has(cursor)) {
      seen.add(cursor)
      const row = obj(byId[cursor])
      if (row === null) return false
      if (isCtfPresetId(sessionRowPreset(row))) return true
      const parent = row.parentId
      cursor = typeof parent === 'string' ? parent : undefined
    }
    return false
  }

  /** 整份快照里到底能不能看到 preset 信息（看不到 → 无法判定，降级为始终注册）。 */
  /** 会话行里出现 `agentPreset` 这个「事实」——哪怕值是 null。 */
  function hasPresetFact(row) {
    const source = obj(row)
    if (source === null) return false
    // 旧宿主（0.1.1 及更早）：preset id 直接挂在行上
    if (typeof source.agentPreset === 'string') return true
    // 新宿主：`projectionValues` 里带 agentPreset 列（null = 这个会话没挂预设）
    const projected = obj(source.projectionValues)
    return projected !== null && Object.prototype.hasOwnProperty.call(projected, 'agentPreset')
  }

  /** 会话列表快照里的行（`byId` 的 values）。 */
  function sessionRows(snapshot) {
    const byId = obj(obj(snapshot)?.byId)
    return byId === null ? [] : Object.values(byId)
  }

  /** 从 ctx（或 scoped ctx）取「会话列表快照仓」；结构不认识时返回 null。 */
  function sessionListStore(ctx) {
    const store = obj(obj(readService(ctx, 'sessions'))?.list)
    if (store === null) return null
    if (typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return null
    return store
  }

  /**
   * 整份快照里到底能不能看到 preset 信息（看不到 → 无法判定，降级为始终注册）。
   *
   * 两个边界：
   *  1. **列表还没到时不能下结论**：页面刚加载时 `byId` 是 `{}`（`phase:'pending'`），
   *     以前这里返回 false 会让 `detectorBroken` 被**永久 latch**，于是「始终显示」，
   *     再也不看后来的会话信息 —— 这就是「CTF tab 在任何模式下都出现」的一半原因。
   *  2. **“有 preset 键”就算可判定**：`agentPreset: null` 是**明确事实**
   *     （这个会话没挂预设），不该当成「看不到信息」。
   */
  function canDetectPreset(snapshot) {
    const rows = sessionRows(snapshot)
    if (rows.length === 0) return false // 还没到 → 无法判定（调用方不要 latch）
    return rows.some(hasPresetFact)
  }

  /** tab 文案：有 locale 服务就跟随语言，否则固定 'CTF'。 */
  function viewSlotMeta(ctx) {
    const locale = readService(ctx, 'locale')
    if (!locale || typeof locale.bind !== 'function') return { label: () => VIEW_LABEL_FALLBACK }
    let t = null
    try {
      t = locale.bind(VIEW_LOCALE_NS)
    } catch {
      t = null
    }
    if (typeof t !== 'function') return { label: () => VIEW_LABEL_FALLBACK }
    try {
      // 命名空间已注册 / 不允许重复注册都不致命：label thunk 照样能用。
      if (typeof locale.register === 'function') {
        locale.register(VIEW_LOCALE_NS, { zh: { 'view.ctf': VIEW_LABEL_FALLBACK }, en: { 'view.ctf': VIEW_LABEL_FALLBACK } })
      }
    } catch { /* 忽略：下面的 thunk 会做兜底 */ }
    return {
      locale: VIEW_LOCALE_NS,
      label: () => {
        try {
          const text = str(t('view.ctf'))
          return text !== '' && text !== 'view.ctf' ? text : VIEW_LABEL_FALLBACK
        } catch {
          return VIEW_LABEL_FALLBACK
        }
      },
    }
  }

  /** 在 `ctx.effect`（可选再叠 `slots.inject`）里托管注册。 */
  function hostRegistration(ctx, slotName, register) {
    if (typeof ctx.effect !== 'function') {
      register()
      return
    }
    const slots = obj(ctx)?.slots
    if (slots && typeof slots.inject === 'function') {
      ctx.effect(() => slots.inject(slotName, register), `dsh-lingxu-ctf: ${slotName}`)
      return
    }
    ctx.effect(register, `dsh-lingxu-ctf: ${slotName}`)
  }

  /**
   * 注册顶部「CTF」视图 tab（`conversation.view` list slot）。
   *
   * 会话门控：**只在 CTF 会话里显示**这个 tab —— 当前会话或其祖先的 preset 是
   * `ctf` / `ctf-*` 时注册，切走就注销。三种降级（都**不会**导致不注册）：
   *  1. 拿不到 `ctx.sessions`（服务缺失 / 结构不认识）→ 始终注册；
   *  2. 拿到了会话行但一行都没带 preset 信息（无法判定）→ 始终注册；
   *  3. `options.alwaysShowView === true`（逃生舱，手动强制显示）。
   *
   * ## ⚠️ 为什么 `package.json` 的 `dsh.client.inject` 必须声明 ui-conversation
   *
   * 本文件读的是 `ctx.get('sessions')`（**属性访问会抛 `cannot get property ... without
   * inject`，所以只能 ctx.get**）。`sessions` 服务由
   * `@deepseek-ai/dsh-api-session-controller` 提供，但客户端 boot graph 里**只有
   * `@deepseek-ai/dsh-client-ui-conversation` 把那一行拉进来**；`package.json` 的
   * `dsh.client.inject` 少写它 → 服务不存在 → 落进上面降级 ① → **tab 在任何模式下都出现**。
   * 2026-09 真实踩过这个坑（diag 里 `view-slot-sessions-absent|fallback=always`）。
   * dsh-pentest 用的是同一组 inject（runtime + locale + ui-conversation）。
   * `tests/client.test.mjs` 有一条专门断言 inject 不被「清理未使用依赖」删掉。
   *
   * @returns 注册函数，或 null（拿不到 slots 服务）
   */
  function registerCtfView(ctx, options = {}) {
    const slots = obj(ctx)?.slots
    // token 用量：把「读当前会话投影」的能力交给渲染层（渲染层拿不到 ctx）
    const viewOptions = {
      ...options,
      sessionUsage: options.sessionUsage || (() => sessionUsageOf(ctx)),
      sessionUsageBreakdown: options.sessionUsageBreakdown || (() => sessionUsageBreakdown(ctx)),
    }
    beacon('registerCtfView', 'slots=' + (slots ? 'yes' : 'no') + ' register=' + typeof slots?.register + ' inject=' + typeof slots?.inject)
    if (!slots || typeof slots.register !== 'function') return null

    const meta = viewSlotMeta(ctx)
    // 逃生舱：`options.alwaysShowView === true` 时跳过关控，始终显示这个 tab。
    const forced = options.alwaysShowView === true
    let disposeEntry = null

    /** 注册条目（幂等）。 */
    const registerNow = () => {
      if (disposeEntry !== null) return disposeEntry
      try {
        disposeEntry = slots.register(
          { name: VIEW_SLOT, id: VIEW_SLOT_ID, order: VIEW_ORDER, ...meta },
          (props) => renderCtfViewSlot(props, viewOptions),
        )
        beacon('view-slot-registered', `${VIEW_SLOT}#${VIEW_SLOT_ID}`)
      } catch (error) {
        beacon('view-slot-error', (error && error.message) || String(error))
        disposeEntry = null
      }
      return disposeEntry
    }

    /** 注销条目（幂等）。 */
    const unregister = () => {
      if (disposeEntry === null) return
      try { disposeEntry() } catch { /* 已注销 */ }
      disposeEntry = null
    }

    /**
     * 会话门控：跟随 `sessions.list` 快照注册 / 注销；返回 disposer。
     * （`registerNow` 抛错会被吞掉并打点，不能影响 slots 的订阅回调。）
     */
    const installGate = (listStore) => {
      let lastId
      let lastFlag
      let detectorBroken = false
      const sync = () => {
        let snapshot = null
        try {
          snapshot = listStore.getSnapshot()
        } catch {
          snapshot = null
        }
        if (snapshot === null || snapshot === undefined) return
        const rows = sessionRows(snapshot)
        // 降级 ②：**确实拿到了会话行、但一行都没带 preset 信息** → 无法判定 → 始终注册。
        // ⚠️ 行数为 0 时（`phase:'pending'`，会话列表还没到）**不下结论、不 latch**，
        // 否则「始终显示」会被永久钉死。
        if (!detectorBroken && rows.length > 0 && !canDetectPreset(snapshot)) {
          detectorBroken = true
          beacon('view-slot-preset-absent', `fallback=always rows=${rows.length}`)
        }
        const current = currentSessionOf(snapshot)
        const wanted = detectorBroken ? true : (current === undefined ? undefined : isCtfSession(snapshot, current))
        if (current === lastId && wanted === lastFlag) return
        lastId = current
        lastFlag = wanted
        unregister()
        if (wanted !== true) {
          // 打点区分「门控生效（正常隐藏）」与「拿不到服务（降级）」，方便 diag 排查
          beacon('view-slot-gated', `rows=${rows.length} current=${current === undefined ? 'none' : current}`)
          return
        }
        registerNow()
      }
      sync()
      const off = listStore.subscribe(sync)
      return () => {
        if (typeof off === 'function') off()
        unregister()
      }
    }

    hostRegistration(ctx, VIEW_SLOT, () => {
      const listStore = sessionListStore(ctx)
      if (forced || listStore === null) {
        // 降级 ①：拿不到 sessions（或被强制打开）→ 先始终注册，别让 tab 消失
        beacon('view-slot-sessions-absent', forced ? 'fallback=forced' : 'fallback=always')
        registerNow()
        if (forced || typeof ctx.inject !== 'function') return unregister
        // ⚠️ 服务可能「迟到」：客户端插件按加载顺序挂载，apply 时 sessions 可能还没 provide。
        // 以前这里一次性探测失败就永久降级 → tab 在任何模式下都出现。
        // 现在等它上线，**升级为门控**（拿不到就一直保持始终显示，行为不变）。
        try {
          ctx.inject(['sessions'], (scoped) => {
            const late = sessionListStore(scoped) || sessionListStore(ctx)
            if (late === null) return undefined
            beacon('view-slot-sessions-late', 'upgrade=gated')
            unregister()
            return installGate(late)
          })
        } catch { /* 老 ctx 没有 inject → 保持降级 */ }
        return unregister
      }
      return installGate(listStore)
    })
    return registerNow
  }

  //  配置卡片

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
          // ⚠️ label 必须保留：宿主 describeConfigFields 下发中文标签，
          // 这里若重建字段时丢掉它，表单就会退回显示英文 key。
          label: str(field.label) || str(field.key),
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
    // 只支持凌虚，平台名固定；不再依赖 values.platform（该字段已随 CTFd 一起移除）
    const parts = ['平台：凌虚']
    const eventId = values.eventId
    if (eventId !== undefined && eventId !== null && str(eventId) !== '') parts.push(`event ${str(eventId)}`)
    const hasBase = str(values.baseUrl) !== ''
    const secrets = obj(config.secretsSet) || {}
    const hasSecret = secrets.cookie === true
    parts.push(hasBase && hasSecret ? '已配置' : '未配置')
    return parts.join(' · ')
  }

  /**
   * 把表单草稿折成 POST 的 `patch`。规则：
   *  - 只回传**确实改动过**的字段（避免无谓覆盖）
   *  - secret 字段为空串时**绝不回传**（空串是「不修改」哨兵，且不提供清空入口）
   *  - number 为空或非数字时跳过；boolean 按勾选态比对
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
    // ⚠️ 注入样式表：配置卡片的三个入口（React slot / 纯 DOM 回退 / 直接调用本函数）
    // **都不会经过 CTF 视图或悬浮面板的 mount()**，而样式原先只在那两处 ensureStyles()。
    // 少了这一次，「设置 → 内置插件 → 插件列表 → dsh-lingxu-ctf」的表单就是**裸 DOM**：
    // 三列栅格塌陷、标签与输入框挤在一行、布尔开关串位、按钮没有外观
    // —— 这是 v1.0.3 及之前真实发到用户手上的 P1 缺陷（上游 issue 报告实测复现）。
    // ensureStyles 是幂等的（按 data-plugin-css 去重），重复调用无副作用。
    ensureStyles(doc)

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
      // 用户要求：不显示标题与说明性文字，只留表单本体。
      const status = el(doc, 'div', 'lx-config-status')
      status.textContent = '正在读取配置…'
      const grid = el(doc, 'div', 'lx-config-grid')
      // 布尔开关单独一行：放进网格会因说明文字把行撑高、复选框被垂直居中，很难看
      const toggles = el(doc, 'div', 'lx-config-toggles')

      const actions = el(doc, 'div', 'lx-config-actions')
      const saveBtn = el(doc, 'button', 'lx-config-save')
      saveBtn.type = 'button'
      saveBtn.textContent = '保存'
      const reloadBtn = el(doc, 'button', 'lx-config-reload')
      reloadBtn.type = 'button'
      reloadBtn.textContent = '重新加载'
      actions.appendChild(saveBtn)
      actions.appendChild(reloadBtn)

      root.appendChild(status)
      root.appendChild(grid)
      root.appendChild(toggles)
      root.appendChild(actions)

      saveBtn.addEventListener('click', () => { void save() })
      reloadBtn.addEventListener('click', () => { void refresh() })

      regions = { status, grid, toggles, saveBtn, reloadBtn }
      return root
    }

    /** 依据 config.fields 重建表单（每次刷新都重建，保证与最新 schema 一致）。 */
    function renderFields() {
      if (!regions) return
      const config = state.config
      regions.grid.innerHTML = ''
      regions.toggles.innerHTML = ''
      controls = new Map()
      if (!config || config.ok === false) return

      for (const field of config.fields) {
        const kind = configFieldKind(field)
        const caption = el(doc, 'span', 'lx-config-label')
        caption.textContent = field.label || field.key

        //  布尔：渲染成紧凑的开关项，独占一行、左对齐
        if (kind === 'boolean') {
          const item = el(doc, 'label', 'lx-config-check')
          if (field.description) item.title = field.description
          const input = el(doc, 'input')
          input.type = 'checkbox'
          input.name = field.key
          input.checked = config.values[field.key] === true
          item.appendChild(input)
          item.appendChild(caption)
          controls.set(field.key, input)
          regions.toggles.appendChild(item)
          continue
        }

        const wrap = el(doc, 'label', 'lx-config-field')
        // 路径类与超长说明占两列，避免输入框被挤扁
        if (field.key === 'workDir' || field.description.length > 60) wrap.className = 'lx-config-field lx-span-2'
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
      else if (usable) setStatus('', null)
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

  //  样式

  /**
   * 主题：**只用 DSH 真实 token**（`--dsw-alias-*`），**零 fallback、零中间层**。
   *
   * 三条历史 bug（勿回退，回归防线见 tests/client.test.mjs 的「主题」用例）：
   *  1. **暗色检测**：DSH 靠 `body[data-ds-dark-theme]` 切主题（`dsh-client-ui-theme`
   *     里 token 分 `body{}` / `body[data-ds-dark-theme]{}` 两份）。以前我们写
   *     `@media (prefers-color-scheme:dark)` —— 系统浅色 + DSH 暗色时暗色块不生效，
   *     露出硬编码的浅色兜底（白底白字）。**所以本函数里不得出现任何媒体查询式暗色块。**
   *  2. **兜底值**：以前给每个 token 配了 hex 兜底，值是猜的（品牌色猜成蓝色
   *     `#4c6ef5`，DSH 其实是黑白）。token 自己会随主题切换，不需要兜底。
   *  3. **间接层**：以前包了一层 `--lx-*`，纯属多余；直接写 `var(--dsw-alias-*)`。
   *
   * 样式分五段：作用域基础 / 公共原语 / 悬浮面板 / 配置卡片 / 顶部 CTF 视图。
   * 三处出口（视图、配置卡片、悬浮面板）共用本函数，改样式时三处一起看。
   */
  function panelCss() {
    return [
      //  一、作用域基础
      // ⚠️ 定位声明（position:fixed 等）**只能**出现在 #lingxu-ctf-panel 块里：
      // 以前把它和主题变量同处 `#panel,.lx-config{}`，导致插件页里的配置卡片
      // 被一起变成右下角浮层（表现为「CSS 丢失」）。视图同样不得带定位。
      `#${PANEL_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;text-align:left;font:13px/20px ${FONT_STACK};color:var(--dsw-alias-label-primary);}`,
      `#${PANEL_ID} *{box-sizing:border-box;}`,
      `#${PANEL_ID}.lx-docked{position:static;right:auto;bottom:auto;align-items:stretch;width:100%;}`,
      `.${CONFIG_CLASS}{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;padding:14px 16px;margin:0;list-style:none;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);text-align:left;font:13px/20px ${FONT_STACK};color:var(--dsw-alias-label-primary);}`,
      `.${CONFIG_CLASS} *{box-sizing:border-box;}`,
      '.lx-view-host{display:block;width:100%;height:100%;min-height:0;}',
      // 视图模式下隐藏宿主输入框（用户要求：「进入视图模式就不要输入框了」）。
      // data-composer-seat 是宿主输入框容器的**稳定** data 属性
      // （dsh-client-ui-conversation 的 ConversationRoot：
      //   <div data-composer-seat data-conversation-region="composer">），
      // 不像 className 那样带构建哈希，所以可跨版本安全定位。
      // 标记只在本视图**真的可见**时挂上（watchViewVisibility），切回「对话」会移除，
      // 不会误伤正常聊天输入。
      "body[data-lx-view='on'] [data-composer-seat]{display:none;}", 
      `.${VIEW_CLASS}{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;max-width:1180px;height:100%;min-height:0;margin:0 auto;padding:16px 20px 24px;overflow-y:auto;text-align:left;font:13px/20px ${FONT_STACK};color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}`,
      `.${VIEW_CLASS} *{box-sizing:border-box;}`,

      //  二、公共原语（三处出口共用）
      // 药丸 / 徽章：11px、全圆角、layer-2 底（对齐 pentest 的 badge 规格）
      '.lx-chip,.lx-pill,.lx-sub,.lx-vpill,.lx-vagent,.lx-vrole,.lx-vmsg-kind{display:inline-block;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap;}',
      '.lx-chip-strong{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.lx-chip-warn{color:var(--dsw-alias-state-warn-label);}',
      // 状态徽章用 token 的「三级色」做浅底深字（暗色下 tertiary 自动变深底，不用自己算透明度）
      '.lx-pill-solved,.lx-vpill-completed,.lx-sub-correct{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary);}',
      '.lx-pill-working,.lx-vpill-in_progress{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary);}',
      '.lx-pill-pending,.lx-vpill-pending{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);}',
      '.lx-vpill-failed,.lx-sub-incorrect,.lx-sub-wrong,.lx-sub-error{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.lx-sub-already_solved,.lx-sub-duplicate{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);}',
      // 按钮：次级按钮用 elevated-fill，hover 用 floating-hover（DSH 的浮层按钮语义）
      '.lx-btn,.lx-vbtn{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;padding:3px 12px;cursor:pointer;}',
      '.lx-btn:hover,.lx-vbtn:hover{background:var(--dsw-alias-button-floating-hover);color:var(--dsw-alias-label-primary);}',
      '.lx-btn:disabled,.lx-vbtn:disabled{opacity:.45;cursor:default;}',
      '.lx-link{border:0;background:none;color:var(--dsw-alias-link);font:inherit;font-size:inherit;cursor:pointer;padding:0 4px;text-decoration:underline;}',
      // 告警条
      '.lx-alert{display:flex;align-items:center;gap:6px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.lx-alert-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary);}',
      '.lx-alert-warn{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-secondary);}',
      '.lx-alert-dim{color:var(--dsw-alias-label-tertiary);}',
      '.lx-status:empty{display:none;}',
      // 表格
      '.lx-table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px;}',
      '.lx-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 8px;}',
      '.lx-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-table tr.lx-self{background:var(--dsw-alias-interactive-bg-hover);font-weight:600;}',
      '.lx-num{text-align:right;font-variant-numeric:tabular-nums;}',
      // 排行榜：三列**不要被拉散**（用户截图：分数被推到最右、中间空一大片）。
      // 收窄表格 + 固定首末列宽，宽屏（视图 1180）与窄栏（面板 440）都不会散架。
      '.lx-table.lx-rank{width:100%;max-width:560px;table-layout:fixed;}',
      '.lx-table.lx-rank th:first-child,.lx-table.lx-rank td:first-child{width:48px;}',
      '.lx-table.lx-rank th:last-child,.lx-table.lx-rank td:last-child{width:88px;}',
      '.lx-time{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}',
      '.lx-you{display:inline-block;margin-left:6px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:18px;}',
      '.lx-empty{padding:16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center;}',
      '.lx-section{display:flex;flex-direction:column;gap:8px;}',
      '.lx-section-title{font-size:12px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-tertiary);}',

      //  三、悬浮面板（可选，默认关闭）
      // 卡片：12px 圆角 + border-l1 + layer-1 底 + 面板阴影（对齐 pentest 的 .card）
      '.lx-drawer{display:flex;flex-direction:column;width:440px;max-width:calc(100vw - 32px);max-height:min(72vh,760px);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);overflow:hidden;}',
      `#${PANEL_ID}.lx-docked .lx-drawer{width:100%;max-width:none;max-height:none;box-shadow:none;}`,
      `#${PANEL_ID}[data-collapsed="true"] .lx-drawer{display:none;}`,
      // 头部**不再有分隔线**（用户点名「这条线有啥用啊」）：只靠留白区分层次
      '.lx-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:12px 14px;}',
      '.lx-title{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.lx-name{font-size:14px;line-height:22px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-head-actions{display:flex;gap:6px;flex:none;}',
      `#${PANEL_ID} .lx-alert{margin:10px 14px 0;}`,
      '.lx-meta{display:flex;flex-wrap:wrap;gap:6px;padding:12px 14px 0;}',
      '.lx-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;margin:12px 14px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-border-l1);}',
      '.lx-stat{display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 2px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-stat-value{font-size:16px;line-height:24px;font-weight:600;}',
      '.lx-stat-label{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.lx-ok .lx-stat-value{color:var(--dsw-alias-state-success-primary);}',
      '.lx-info .lx-stat-value{color:var(--dsw-alias-state-business-primary);}',
      '.lx-dim .lx-stat-value{color:var(--dsw-alias-label-secondary);}',
      '.lx-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 14px 0;}',
      // select 右侧留 26px 给原生下拉箭头（否则 ▼ 会压在右边框上）；控件按内容定基宽，
      // 一行放不下就整块换行（`flex-grow` 让同一行的控件均分剩余宽度，不挤压错位）。
      '.lx-controls select,.lx-controls input{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:4px 10px;min-width:0;}',
      // ⚠️ 顺序要紧：这两条必须在上面那条 `padding` 简写**之后**，否则 padding-right 会被重置回 10px
      //    否则原生下拉箭头会压在右边框上。
      '.lx-controls select,.lx-vtoolbar select{flex:1 1 132px;padding-right:26px;}',
      '.lx-controls input,.lx-vtoolbar input{flex:1 1 168px;}',
      '.lx-body{display:flex;flex-direction:column;gap:16px;padding:14px;overflow:auto;}',
      '.lx-group{display:flex;flex-direction:column;gap:8px;}',
      '.lx-group+.lx-group{margin-top:12px;}',
      '.lx-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-tertiary);}',
      '.lx-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;}',
      '.lx-card{display:flex;flex-direction:column;gap:6px;padding:8px 10px 8px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);min-width:0;}',
      '.lx-card.lx-st-solved{box-shadow:inset 3px 0 0 0 var(--dsw-alias-state-success-primary);}',
      '.lx-card.lx-st-working{box-shadow:inset 3px 0 0 0 var(--dsw-alias-state-business-primary);}',
      '.lx-card.lx-st-pending{box-shadow:inset 3px 0 0 0 var(--dsw-alias-state-idle-primary);}',
      '.lx-card-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0;}',
      '.lx-card-name{font-size:13px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-card-score{flex:none;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);}',
      '.lx-card-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.lx-owner{color:var(--dsw-alias-link);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px;}',
      '.lx-theory-item{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);font-size:13px;line-height:20px;}',
      '.lx-theory-name{font-weight:600;}',
      '.lx-theory-count,.lx-theory-time{color:var(--dsw-alias-label-tertiary);font-size:12px;}',
      '.lx-launcher{display:flex;align-items:center;gap:8px;padding:6px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-button-floating-fill);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:600;cursor:pointer;box-shadow:var(--dsw-elevation-panel);}',
      '.lx-launcher:hover{background:var(--dsw-alias-button-floating-hover);}',
      '.lx-launcher-dot{width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);flex:none;}',
      '.lx-launcher-dot.lx-dot-ok{background:var(--dsw-alias-state-success-primary);}',
      '.lx-launcher-dot.lx-dot-err{background:var(--dsw-alias-state-error-primary);}',
      `#${PANEL_ID}.lx-docked .lx-launcher{display:none;}`,

      //  四、配置卡片（Plugins 页）
      '.lx-config-status{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.lx-config-status.lx-ok-text{color:var(--dsw-alias-state-success-primary);}',
      '.lx-config-status.lx-err-text{color:var(--dsw-alias-state-error-primary);}',
      '.lx-config-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 16px;align-items:start;}',
      '@media (max-width:760px){.lx-config-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}',
      '@media (max-width:520px){.lx-config-grid{grid-template-columns:minmax(0,1fr);}}',
      '.lx-config-field{display:flex;flex-direction:column;gap:6px;min-width:0;}',
      '.lx-config-field.lx-span-2{grid-column:span 2;}',
      '@media (max-width:520px){.lx-config-field.lx-span-2{grid-column:1/-1;}}',
      '.lx-config-label{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.lx-config-field input[type=text],.lx-config-field input[type=number],.lx-config-field input[type=password],.lx-config-field select{box-sizing:border-box;width:100%;min-height:32px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;}',
      '.lx-config-field input:focus,.lx-config-field select:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.lx-config-field input:disabled,.lx-config-field select:disabled{opacity:.55;}',
      '.lx-config-toggles{display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.lx-config-toggles:empty{display:none;}',
      '.lx-config-check{display:inline-flex;align-items:center;gap:8px;cursor:pointer;min-height:24px;white-space:nowrap;}',
      '.lx-config-check input{margin:0;flex:none;width:15px;height:15px;cursor:pointer;}',
      '.lx-config-check .lx-config-label{font-weight:500;}',
      '.lx-config-help{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.lx-config-field input::placeholder{color:var(--dsw-alias-label-caption);opacity:1;}',
      '.lx-config-secret{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label);}',
      '.lx-config-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.lx-config-save{min-height:32px;padding:4px 14px;border:1px solid var(--dsw-alias-button-primary-fill);border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-weight:600;cursor:pointer;}',
      '.lx-config-save:hover{background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover);}',
      '.lx-config-save:disabled{opacity:.45;cursor:default;}',
      '.lx-config-reload{min-height:32px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;}',
      '.lx-config-reload:hover{background:var(--dsw-alias-button-floating-hover);color:var(--dsw-alias-label-primary);}',
      '.lx-config-reload:disabled{opacity:.45;cursor:default;}',
      '.lx-config-host{display:block;}',

      //  五、顶部「CTF」视图（conversation.view tab）
      // ⚠️ 这段的作用域只能是 .lx-v* / .lx-view*，且**不得出现任何定位声明**：
      // 视图渲染在会话区里，一旦把定位写进共享选择器就会盖住别的 UI。
      // 会话区（ui-conversation 的 viewArea）是 overflow:hidden 的弹性盒，
      // 所以视图自己做滚动（height:100% + overflow-y:auto，与 pentest 的 .root 一致）。
      // 头部是轻量摘要卡；主导航突出四个高频入口，低频能力放在「更多视图」里。
      // 不把平台名、赛事 ID、URL、更新时间或刷新按钮塞进首屏。
      '.lx-vsummary{display:flex;flex-direction:column;gap:12px;flex:none;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);}',
      '.lx-vtop{display:flex;flex-direction:column;align-items:center;gap:6px;flex:none;}',
      '.lx-vtitle{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;width:100%;}',
      '.lx-vname{margin:0;font-size:19px;line-height:28px;font-weight:600;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}',
      '.lx-vmeta{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px 8px;min-height:20px;text-align:center;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);}',
      '.lx-vmetric{white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.lx-vmetric-warn{color:var(--dsw-alias-state-warn-label);}',
      '.lx-vsep{color:var(--dsw-alias-label-caption);}',
      '.lx-vstats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;flex:none;}',
      '.lx-vstats:empty{display:none;}',
      '.lx-vstats .lx-stat{min-width:0;padding:8px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);}',
      '.lx-vstats .lx-stat-value{font-size:18px;line-height:26px;font-variant-numeric:tabular-nums;}',
      '.lx-vstats .lx-stat-label{font-size:11px;white-space:nowrap;}',
      '.lx-valerts{display:flex;flex-direction:column;gap:8px;flex:none;}',
      '.lx-valerts:empty{display:none;}',
      // 提交审计：flag 完整显示（等宽 + break-all 换行，不省略）。
      '.lx-vsub-row{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-vsub-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.lx-vflag{margin:0;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:19px;word-break:break-all;overflow-wrap:anywhere;white-space:pre-wrap;}',
      '.lx-vflag-empty{background:none;color:var(--dsw-alias-label-caption);padding:0;}',
      // 主导航仍是下划线式；低频能力收进原生 details，窄屏也不会挤成一团。
      '.lx-vtabs{display:flex;flex-wrap:wrap;align-items:flex-start;gap:4px;flex:none;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.lx-vtabs-primary{display:flex;gap:4px;flex:1 1 auto;min-width:0;overflow-x:auto;}',
      '.lx-vtab{appearance:none;display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;min-height:40px;padding:6px 12px;border:0;border-radius:8px 8px 0 0;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;}',
      '.lx-vtab:hover{color:var(--dsw-alias-label-secondary);}',
      '.lx-vtab.is-active{color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary);}',
      '.lx-vtab-count{display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;line-height:18px;text-align:center;font-variant-numeric:tabular-nums;}',
      '.lx-vtab.is-active .lx-vtab-count{color:var(--dsw-alias-label-primary);}',
      '.lx-vmore{flex:0 0 auto;}',
      '.lx-vmore[open]{flex-basis:100%;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.lx-vmore-summary{display:inline-flex;align-items:center;min-height:40px;padding:4px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;cursor:pointer;list-style:none;}',
      '.lx-vmore-summary::-webkit-details-marker{display:none;}',
      '.lx-vmore-summary::before{content:"+";display:inline-block;width:16px;margin-right:4px;color:var(--dsw-alias-label-caption);font-size:14px;line-height:20px;text-align:center;}',
      '.lx-vmore[open] .lx-vmore-summary::before{content:"−";}',
      '.lx-vtabs-secondary{display:flex;gap:4px;overflow-x:auto;padding:4px 0 0;}',
      '.lx-vtab:focus-visible,.lx-vmore-summary:focus-visible,.lx-vbtn:focus-visible,.lx-vtoolbar select:focus-visible,.lx-vtoolbar input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.lx-vtoolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-vtoolbar[data-hidden="true"]{display:none;}',
      '.lx-vtoolbar select,.lx-vtoolbar input{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:4px 10px;min-width:0;}',
      // ⚠️ 同面板：必须在 padding 简写之后，否则箭头位失效。
      '.lx-vtoolbar select{flex:1 1 132px;padding-right:26px;}',
      '.lx-vtoolbar input{flex:1 1 168px;}',
      '.lx-vbody{display:flex;flex-direction:column;gap:16px;min-height:120px;}',
      '.lx-vgroup{display:flex;flex-direction:column;gap:8px;padding:12px 14px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-vgroup-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}',
      '.lx-vgroup-name{font-size:12px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-tertiary);}',
      '.lx-vgroup-count{font-size:12px;line-height:20px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;}',
      '.lx-vcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(216px,1fr));gap:10px;}',
      '.lx-vcard{display:flex;flex-direction:column;gap:8px;padding:10px 12px 10px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);min-width:0;}',
      '.lx-vchallenge{cursor:pointer;transition:border-color .15s ease,transform .15s ease;} .lx-vchallenge:hover{border-color:var(--dsw-alias-brand-primary);transform:translateY(-1px);}',
      '.lx-vdetail{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-brand-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-vdetail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;} .lx-vdetail-head b{font-size:15px;line-height:22px;} .lx-vdetail-head small{display:block;color:var(--dsw-alias-label-tertiary);}',
      '.lx-vdetail-meta{display:flex;flex-wrap:wrap;gap:6px;} .lx-vdetail-body{font-size:13px;line-height:20px;} .lx-vdetail-body h4{margin:12px 0 4px;font-size:12px;color:var(--dsw-alias-label-tertiary);} .lx-vdetail-body pre{margin:0;padding:10px;border-radius:8px;background:var(--dsw-alias-markdown-code-block);white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;} .lx-vdetail-body p{margin:6px 0;} .lx-vdetail-submissions{display:flex;flex-direction:column;gap:6px;margin:0;padding-left:18px;} .lx-vdetail-submissions li{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;} .lx-vdetail-submissions code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;} .lx-vdetail-submissions small{color:var(--dsw-alias-label-tertiary);}',
      '.lx-vcard.lx-st-solved{box-shadow:inset 3px 0 0 0 var(--dsw-alias-state-success-primary);}',
      '.lx-vcard.lx-st-working{box-shadow:inset 3px 0 0 0 var(--dsw-alias-state-business-primary);}',
      '.lx-vcard.lx-st-pending{box-shadow:inset 3px 0 0 0 var(--dsw-alias-state-idle-primary);}',
      '.lx-vcard-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0;}',
      '.lx-vcard-name{font-size:13px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-vscore{flex:none;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}',
      '.lx-vcard-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.lx-vnote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;}',
      '.lx-vnote.lx-vwarn{color:var(--dsw-alias-state-warn-label);}',
      // 题型徽章（环境型/外链型/附件型）：中性底；环境型给 business 色调（稀缺资源）
      '.lx-vtype{display:inline-block;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap;}',
      '.lx-vtype-1{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary);}',
      // 环境剩余：正常=中性可读；<10 分钟=橙；已过期=红
      '.lx-venv{display:inline-block;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.lx-venv-ok{color:var(--dsw-alias-label-secondary);}',
      '.lx-venv-warn{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);}',
      '.lx-venv-error{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.lx-venv-held{font-weight:600;}',
      '.lx-chip-env{font-variant-numeric:tabular-nums;}',
      '.lx-venv-quota{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 0 4px;}',
      '.lx-venv-row{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-venv-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.lx-venv-name{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.lx-venv-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.lx-vagent{max-width:130px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;}',
      '.lx-vagent-row{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-vagent-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.lx-vdot{width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);flex:none;}',
      '.lx-vdot.lx-ok{background:var(--dsw-alias-state-success-primary);animation:lx-vpulse 2.2s ease-in-out infinite;}',
      '.lx-vdot.lx-info{background:var(--dsw-alias-state-business-primary);}',
      '.lx-vdot.lx-err{background:var(--dsw-alias-state-error-primary);}',
      '@keyframes lx-vpulse{0%,100%{opacity:1;}50%{opacity:.35;}}',
      '.lx-vagent-name{font-size:14px;line-height:22px;font-weight:600;}',
      '.lx-vstatus{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.lx-vstatus.lx-ok{color:var(--dsw-alias-state-success-primary);}',
      '.lx-vstatus.lx-info{color:var(--dsw-alias-state-business-primary);}',
      '.lx-vstatus.lx-err{color:var(--dsw-alias-state-error-primary);}',
      '.lx-vrole{color:var(--dsw-alias-label-tertiary);}',
      '.lx-vagent-meta{display:flex;flex-wrap:wrap;gap:6px 16px;}',
      '.lx-vagent-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.lx-vtasks{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.lx-vtasks summary{cursor:pointer;color:var(--dsw-alias-link);font-size:12px;line-height:20px;}',
      '.lx-vtask-list{display:flex;flex-direction:column;gap:6px;margin:8px 0 0;padding:0;list-style:none;}',
      '.lx-vtask-list li{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);}',
      '.lx-vtask-name{font-weight:600;color:var(--dsw-alias-label-primary);}',
      // 协同通信时间线：左侧色条标 kind
      '.lx-vtimeline{display:flex;flex-direction:column;gap:8px;}',
      '.lx-vmsg{display:grid;grid-template-columns:96px 60px 1fr;gap:4px 12px;align-items:start;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px;}',
      '.lx-vmsg-time{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;}',
      '.lx-vmsg-kind{color:var(--dsw-alias-label-secondary);text-align:center;}',
      '.lx-vmsg-route{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-varrow{font-style:normal;color:var(--dsw-alias-label-caption);}',
      '.lx-vmsg-text{grid-column:1/-1;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;}',
      '.lx-vmsg-spawn{border-left-color:var(--dsw-alias-brand-primary);}',
      '.lx-vmsg-report{border-left-color:var(--dsw-alias-state-success-primary);}',
      '.lx-vmsg-status{border-left-color:var(--dsw-alias-state-business-primary);}',
      '.lx-vmsg-stop{border-left-color:var(--dsw-alias-state-warn-primary);}',
      '.lx-vmsg-error{border-left-color:var(--dsw-alias-state-error-primary);}',
      '.lx-vsub-name{color:var(--dsw-alias-label-primary);}',
      '.lx-vreport{padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-vreport summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer;}',
      '.lx-vreport-title{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.lx-vreport-challenge{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.lx-vpath{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      `.lx-vreport-body{margin:12px 0 0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font:12px/19px ${MONO_STACK};white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto;}`,
      '.lx-vreport-empty{margin-top:8px;}',
      //  活动行 / 协同分组 / 理论题题目 / 页脚新鲜度
      '.lx-vagent-action{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.lx-vnote-dim{color:var(--dsw-alias-label-caption);}',
      '.lx-usage{padding:8px 14px 0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);}',
      '.lx-usage-split{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:4px;}',
      '.lx-usage-item{padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
      '.lx-usage-self{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-weight:600;}',
      '.lx-usage-billed{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.lx-vmsg-groups{display:flex;flex-direction:column;gap:16px;}',
      '.lx-vmsg-group{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-vmsg-group-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;}',
      '.lx-vmsg-pair{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-secondary);}',
      '.lx-vmsg-filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;}',
      '.lx-vmsg-filter{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:2px 10px;cursor:pointer;}',
      '.lx-vmsg-filter-on{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);font-weight:600;}',
      '.lx-vmsg-kind{margin-left:auto;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;}',
      '.lx-vmsg-challenge{padding:0 8px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:18px;font-variant-numeric:tabular-nums;}',
      '.lx-vtheory-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-vtheory-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.lx-vtheory-name{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.lx-vtheory-load{margin-left:auto;}',
      // 题目区必须独占一行（否则会被 flex 挤到右侧、左边留一大片空白）
      '.lx-vquestions{flex:1 0 100%;display:flex;flex-direction:column;gap:8px;min-width:0;}',
      '.lx-vq-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;}',
      '.lx-vq-item{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);}',
      '.lx-vq-stem{flex:1;min-width:200px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);}',
      '.lx-vfresh{flex:none;padding:8px 0 0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-caption);text-align:center;}',
      '.lx-vempty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center;}',
      '.lx-vempty-text{max-width:480px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-tertiary);}',
      '.lx-vempty-hint{max-width:480px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-caption);}',
      '@media (max-width:760px){.lx-vstats{grid-template-columns:repeat(3,minmax(0,1fr));}}',
      '@media (max-width:640px){.lx-vcards{grid-template-columns:minmax(0,1fr);}.lx-vmsg{grid-template-columns:88px 1fr;}.lx-vmsg-route{grid-column:2;}}',
      '@media (max-width:520px){.lx-vstats{grid-template-columns:repeat(2,minmax(0,1fr));}.lx-vsummary{padding:12px;}}',
      '@media (prefers-reduced-motion:reduce){.lx-vdot.lx-ok{animation:none;}}',
    ].join('')
  }

  /** 注入样式表（幂等）。 */
  /**
   * `<head>` 里是否已经有我们注入的样式表（按 `data-plugin-css` 判重）。
   *
   * 两级判定，缺一不可：
   *  ① `querySelector` —— 真实浏览器里最快；
   *  ② **扫 head 的子节点** —— 桩 DOM / 极简 DOM 里 `querySelector` 可能是空实现
   *     （返回 null），只靠 ① 会让幂等失效、样式被重复注入。
   *     这个兜底同时也让 ensureStyles 在**没有 querySelector 的宿主**里可用。
   */
  function styleTagPresent(doc) {
    try {
      if (typeof doc.querySelector === 'function' && doc.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return true
    } catch { /* querySelector 抛错 → 走兜底 */ }
    try {
      const head = doc.head || doc.documentElement
      const children = head?.children
      if (!children || typeof children.length !== 'number') return false
      for (let i = 0; i < children.length; i += 1) {
        const node = children[i]
        if (!node || String(node.tagName).toUpperCase() !== 'STYLE') continue
        const marker = node.dataset?.pluginCss ?? node.attrs?.['data-plugin-css'] ?? node.getAttribute?.('data-plugin-css')
        if (marker === CSS_ID) return true
      }
    } catch { /* 兜底失败就当作没有 → 最多重复注入一次，不致命 */ }
    return false
  }

  function ensureStyles(doc) {
    if (!doc || typeof doc.createElement !== 'function') return
    if (styleTagPresent(doc)) return
    const tag = doc.createElement('style')
    if (tag.dataset) {
      tag.dataset.plugin = name
      tag.dataset.pluginCss = CSS_ID
    }
    tag.textContent = panelCss()
    const head = doc.head || doc.documentElement
    if (head && typeof head.appendChild === 'function') head.appendChild(tag)
  }

  //  面板控制器

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
    const ctx = options.ctx

    const state = {
      snapshot: normalizeState(null),
      error: null,
      loading: true,
      loaded: false,
      tokenUsage: null,
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
    // 悬浮面板与主视图一样需要防止慢请求回写旧状态。部分宿主 fetch
    // 不支持 AbortController，因此 generation 检查必须保留，abort 只是尽快释放连接。
    let refreshGeneration = 0
    let refreshController = null

    function newAbortController() {
      try {
        return typeof AbortController === 'function' ? new AbortController() : null
      } catch {
        return null
      }
    }

    function cancelRefresh() {
      refreshGeneration += 1
      if (refreshController !== null) {
        try { refreshController.abort() } catch { /* 旧宿主的 controller 可能不完整 */ }
        refreshController = null
      }
    }

    //  骨架
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
      // ⚠️ 头部**只有赛事名**：平台名 / URL / 「更新于」整行已删除（用户点名），
      // 别再往 title 里加副标题（视图那边同理，两族都禁止）。
      title.appendChild(nameEl)

      const actions = el(doc, 'div', 'lx-head-actions')
      // 「刷新」按钮已删除：数据本来就有 5s 轮询，手动刷新是噪音（用户点名）。
      // 「收起」**必须保留** —— 面板的停靠/收起交互靠它。
      const collapseBtn = el(doc, 'button', 'lx-btn lx-collapse')
      collapseBtn.type = 'button'
      collapseBtn.textContent = '收起'
      actions.appendChild(collapseBtn)
      head.appendChild(title)
      head.appendChild(actions)

      const statusEl = el(doc, 'div', 'lx-status')
      const metaEl = el(doc, 'div', 'lx-meta')
      // token 用量（与视图共用 renderTokenUsageHtml 与用量缓存）：放在指标行下方
      const usageEl = el(doc, 'div', 'lx-usage')

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
      drawer.appendChild(usageEl)
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

      //  交互
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
        nameEl, statusEl, metaEl, usageEl, statsEl, boardEl, rankEl, submissionsEl, theoryEl,
        categorySel, statusSel, searchInput, launcherDot: dot, launcherText,
      }
      return panel
    }

    //  渲染
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
      // 头部不再有「平台 · URL · 更新于」那行；账号信息挂 tooltip（与视图一致）。
      regions.nameEl.title = snapshot.event.username ? `账号 @${snapshot.event.username}` : ''

      regions.statusEl.innerHTML = renderStatusHtml(snapshot, {
        error: state.error,
        loading: state.loading,
        loaded: state.loaded,
      })
      // 指标行与视图**共用** renderMetricsLineHtml（面板没有团队数据，所以不传 team）
      regions.metaEl.innerHTML = snapshot.configured ? renderMetricsLineHtml(snapshot) : ''
      // token 用量与视图**共用**片段与缓存（面板没有团队数据，用量来自会话投影/宿主路由）
      if (regions.usageEl) {
        regions.usageEl.innerHTML = snapshot.configured ? renderTokenUsageHtml(state.tokenUsage) : ''
      }
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

    //  数据
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
      cancelRefresh()
      const generation = refreshGeneration
      const controller = newAbortController()
      const signal = controller?.signal ?? null
      refreshController = controller
      const isCurrent = () => !destroyed && generation === refreshGeneration
      // token 用量：与视图共用同一个读取器 + 缓存（面板先打开时也能拿到）
      let usageSource = null
      try {
        usageSource = typeof options.sessionUsage === 'function' ? options.sessionUsage() : sessionUsageOf(options.ctx)
      } catch { /* 会话服务切换时按空上下文处理 */ }
      const sessionId = str(obj(usageSource)?.sessionId)
      try {
        const loaded = await loadTokenUsage(fetchImpl, sessionId)
        if (!isCurrent()) return
        state.tokenUsage = {
          sessionId: str(obj(loaded)?.sessionId) || str(obj(usageSource)?.sessionId),
          projection: obj(usageSource)?.projection ?? null,
          log: obj(loaded)?.log ?? null,
          inferred: obj(loaded)?.inferred === true,
          compactionTokens: num(obj(loaded)?.compactionTokens, 0),
          billedTokens: num(obj(loaded)?.billedTokens, 0),
          reason: str(obj(loaded)?.reason),
          breakdown: sessionUsageBreakdown(ctx),
        }
      } catch { /* 用量失败不影响面板主数据 */ }
      try {
        const response = await fetchImpl(sessionUrl(url, sessionId), {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          ...(signal ? { signal } : {}),
        })
        if (!isCurrent()) return
        let payload = null
        if (response && typeof response.json === 'function') {
          payload = await response.json().catch(() => null)
        }
        if (!isCurrent()) return
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
        if (isCurrent()) {
          state.error = String((error && error.message) || error)
          state.snapshot = normalizeState(null)
        }
      } finally {
        if (refreshController === controller) refreshController = null
        if (isCurrent()) {
          state.loading = false
          state.loaded = true
          patch()
        }
      }
    }

    /** 立刻拉一次并启动轮询（页面隐藏时跳过）。 */
    function start() {
      if (destroyed || disposed) return
      // apply() 的异步开关决策可能在调用方显式 refresh() 之后才完成。
      // 这时复用正在进行的请求，不能为了启动轮询把它取消掉。
      const hasPendingRefresh = refreshController !== null
      stop({ cancelRequest: !hasPendingRefresh })
      if (!hasPendingRefresh) lastRefresh = refresh()
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

    function stop({ cancelRequest = true } = {}) {
      if (timer !== null) {
        const { handle, scheduler } = timer
        if (scheduler && typeof scheduler.clearInterval === 'function') scheduler.clearInterval(handle)
        else if (typeof clearInterval === 'function') clearInterval(handle)
        timer = null
      }
      if (cancelRequest) cancelRefresh()
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
      get destroyed() { return destroyed },
      get ready() { return lastRefresh },
      root: () => root,
    }
  }

  //  插件入口

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
    function LingxuCtfConfigCard() {
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
    // ⚠️ 必须返回**元素**而不是组件函数本身。
    // 渲染器是 `const Comp = entry.component; renderEntry(slotKey, Comp, ...)`，
    // 即 React 直接调用我们的 slot 函数并把返回值当 React child。
    // 返回函数会抛 "Functions are not valid as a React child" → SlotErrorBoundary
    // 捕获 → reportEntryError({abdicate:true}) → 该 key 被退休 → 只剩一个空的
    // <div data-slot-error>（表现为一段空白，卡片永远不出现）。
    return h(LingxuCtfConfigCard)
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
    // 无 React 时返回 DOM 节点 —— 只有当 slot 渲染器接受 DOM 时才有意义。
    // 渲染器基于 React，所以这条路径在真实页面里会抛「Objects are not valid
    // as a React child」；打点以便在 /lingxu-ctf/diag 里看到。
    beacon('config-card-dom-fallback', 'react=' + (react ? 'no-createElement' : 'absent'))
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

  //  悬浮面板（可选：**默认不挂**）

  /**
   * 最近一次「是否挂悬浮面板」的决策。`apply()` 是同步返回面板控制器的，
   * 而开关来自宿主的异步配置读取，所以把 promise 记在模块级，供单测/预览 await。
   */
  let floatingSync = Promise.resolve(null)

  /** 记录悬浮面板决策（失败一律当「不挂」）。 */
  function trackFloatingSync(promise) {
    floatingSync = Promise.resolve(promise).catch(() => null)
    return floatingSync
  }

  /** 最近一次悬浮面板决策的完成信号。 */
  function pendingFloatingSync() {
    return floatingSync
  }

  /**
   * 是否挂右下角悬浮面板 —— **默认不挂**。
   *
   * 浮动面板默认关闭，只有宿主
   * `GET /lingxu-ctf/config` 明确下发 `enableFloatingPanel: true` 才挂；
   * 字段缺失、配置读不到、响应不是 JSON、路由 404 全部按「不挂」处理。
   *
   * `options.enableFloating` / `options.enableFloatingPanel` 可显式覆盖
   * （单测与静态预览用），避免为了测旧行为去伪造宿主配置。
   */
  function floatingPanelEnabled(options = {}) {
    if (options.enableFloating === true || options.enableFloatingPanel === true) return Promise.resolve(true)
    if (options.enableFloating === false || options.enableFloatingPanel === false) return Promise.resolve(false)
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
    if (fetchImpl === null) return Promise.resolve(false)
    const url = str(options.configUrl, CONFIG_URL) || CONFIG_URL
    return Promise.resolve(fetchImpl(url, { cache: 'no-store', headers: { accept: 'application/json' } }))
      .then((response) => (response && typeof response.json === 'function' ? response.json() : null))
      .then((payload) => {
        const config = normalizeConfig(payload)
        if (config.ok === false) return false
        return config.values[FLOATING_CONFIG_KEY] === true
      })
      .catch(() => false)
  }

  /** 按配置决定是否挂悬浮面板；返回面板或 null（永不 reject）。 */
  function maybeMountFloatingPanel(options = {}) {
    const panel = getPanel(options)
    return floatingPanelEnabled(options)
      .then((enabled) => {
        if (enabled !== true || panel.destroyed === true) return null
        panel.mount()
        panel.start()
        return panel
      })
      .catch(() => null)
  }

  /**
   * 实时跟随 `enableFloatingPanel` 配置：轮询 `/lingxu-ctf/config`，开→挂、关→卸。
   *
   * 为什么需要它：`floatingPanelEnabled()` 只在装配时读一次配置。用户在
   * 「设置 → 内置插件 → dsh-lingxu-ctf」里把开关打开后，不刷新页面是看不到变化的——
   * 这正是用户反馈的「选了没反应」。
   *
   * 显式指定 `options.enableFloating` / `enableFloatingPanel` 时**不轮询**
   * （单测与静态预览要确定行为，不能被网络抖动影响）。
   *
   * @param {object} options 同 maybeMountFloatingPanel
   * @returns {() => void} 停止轮询
   */
  function watchFloatingPanel(options = {}) {
    if (options.enableFloating === true || options.enableFloating === false) return () => {}
    if (options.enableFloatingPanel === true || options.enableFloatingPanel === false) return () => {}
    if (options.watchFloating === false) return () => {}
    if (typeof setInterval !== 'function') return () => {}

    let stopped = false
    const tick = () => {
      if (stopped) return
      // 页面不可见时跳过：设置页在另一个 view 里，切回来会立刻补一次
      if (typeof document !== 'undefined' && document.hidden === true) return
      floatingPanelEnabled(options)
        .then((enabled) => {
          if (stopped) return
          const panel = singleton
          const isMounted = panel !== null && panel.destroyed !== true && panel.mounted === true
          if (enabled === isMounted) return
          if (enabled) {
            const next = getPanel(options)
            next.mount()
            next.start()
          } else if (panel !== null && panel.destroyed !== true) {
            panel.destroy()
          }
        })
        .catch(() => {})
    }

    const timer = setInterval(tick, Number(options.watchIntervalMs) > 0 ? Number(options.watchIntervalMs) : 5000)
    // Node（单测）里不要让这个轮询拖住进程退出；浏览器里 setInterval 返回数字，unref 不存在，是 no-op。
    if (timer && typeof timer.unref === 'function') timer.unref()
    tick() // 立即对齐一次
    return () => {
      stopped = true
      if (typeof clearInterval === 'function') clearInterval(timer)
    }
  }

  /** 取得（必要时创建）进程内唯一面板；**不自动挂载**（由上面的开关决定）。 */
  function getPanel(options = {}) {
    if (singleton === null || singleton.destroyed === true) singleton = createPanel(options)
    return singleton
  }

  /**
   * Cordis 插件入口。做三件事：
   *  1. 注册设置页配置卡片（`plugins.bundle.config`）；
   *  2. 注册顶部「CTF」视图 tab（`conversation.view`）；
   *  3. **按配置**决定是否挂右下角悬浮面板（默认不挂）。
   *
   * 三者互不牵连：任何一项失败都只是打点 + console.error，不影响其余两项。
   *
   * @param {{effect?:Function, slots?:object, get?:Function}|null} ctx
   * @param {object} options 透传给卡片/视图/悬浮开关（`enableFloating` 可强制开关）
   * @returns 面板控制器（未必已挂载）
   */
  function apply(ctx, options = {}) {
    beacon('apply-called', 'ctx=' + (ctx ? 'yes' : 'no'))
    const panelOptions = { ...options, ctx }
    const panel = getPanel(panelOptions)

    // ① 配置卡片
    try {
      registerConfigCard(ctx, options)
    } catch (error) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[dsh-lingxu-ctf] config card registration failed:', error)
      }
    }

    // ② 顶部「CTF」视图 tab
    try {
      registerCtfView(ctx, options)
    } catch (error) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[dsh-lingxu-ctf] ctf view registration failed:', error)
      }
    }

    // 面板生命周期挂在 ctx 上：插件卸载时一并销毁（挂没挂都安全）。
    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (singleton === panel) singleton = null
        panel.destroy()
      }, 'dsh-lingxu-ctf: web panel')
      ctx.effect(() => watchFloatingPanel(panelOptions), 'dsh-lingxu-ctf: floating config watcher')
    }

    // ③ 悬浮面板：默认不挂，只有宿主配置显式打开才挂
    trackFloatingSync(maybeMountFloatingPanel(panelOptions))
    return panel
  }

  //  导出 / 注册 / 自挂载

  /** 对外 API：factory 的返回值，即 DSH 眼中的插件模块导出。 */
  const api = {
    name,
    /**
     * 声明依赖 slots 服务：cordis 会在 slots 就绪后才调 apply，保证
     * `ctx.slots` 一定可用；其余服务（`locale` / `sessions`）一律用
     * `ctx.get(...)` 探测后选择性使用 —— 不写进 inject，避免服务缺失时
     * apply 被无限期推迟（那样配置卡片与视图 tab 都不会注册）。
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
    sessionUrl,
    truncate,
    renderStatusHtml,
    // 两套布局共用头部指标、提交卡片和完整 flag 片段。
    renderMetricsLineHtml,
    renderSubmissionCardsHtml,
    renderFlagBlockHtml,
    renderBoardHtml,
    renderLeaderboardHtml,
    renderSubmissionsHtml,
    renderTheoryHtml,
    renderStatsHtml,
    normalizeConfig,
    configFieldKind,
    renderConfigSummary,
    collectConfigPatch,
    createConfigCard,
    renderConfigSlot,
    panelCss,
    ensureStyles,
    registerConfigCard,
    resetConfigSummaryCache,
    //  顶部「CTF」视图 tab（conversation.view）
    createCtfView,
    renderCtfViewSlot,
    registerCtfView,
    reactCtfViewHost,
    readService,
    isCtfPresetId,
    isCtfSession,
    sessionRowPreset,
    currentSessionOf,
    canDetectPreset,
    viewSlotMeta,
    normalizeTeam,
    normalizeMember,
    normalizeTask,
    normalizeMessage,
    normalizeReport,
    normalizeReports,
    normalizeTaskStatus,
    normalizeMemberStatus,
    normalizeEnv,
    challengeKey,
    formatShortDuration,
    envStateOf,
    taskTypeLabel,
    renderTaskTypeBadgeHtml,
    renderEnvChipHtml,
    memberEnvOf,
    envChallengesOf,
    runningEnvCount,
    renderViewEnvHtml,
    renderViewTheoryHtml,
    renderTheoryItemsHtml,
    theoryQuestionCount,
    mergeChallengeBoard,
    viewStats,
    memberLastActivity,
    renderViewMetaHtml,
    renderViewStatsHtml,
    renderViewAlertHtml,
    renderViewBoardHtml,
    renderViewChallengeCard,
    renderChallengeDetailHtml,
    renderViewAgentsHtml,
    renderViewMessagesHtml,
    renderViewSubmissionsHtml,
    renderViewReportsHtml,
    renderViewBodyHtml,
    renderViewTabCount,
    renderViewEmptyHtml,
    kindClass,
    //  悬浮面板开关（默认不挂）
    floatingPanelEnabled,
    maybeMountFloatingPanel,
    watchFloatingPanel,
    watchViewVisibility,
    pendingFloatingSync,
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
    VIEW_SLOT,
    VIEW_SLOT_ID,
    VIEW_ORDER,
    VIEW_CLASS,
    VIEW_LOCALE_NS,
    VIEW_LABEL_FALLBACK,
    VIEW_TABS,
    TEAM_URL,
    REPORTS_URL,
    CHALLENGE_URL,
    THEORY_URL,
    formatRelativeSeconds,
    formatElapsed,
    STALE_AFTER_SECONDS,
    taskElapsedSeconds,
    renderViewUsageNoteHtml,
    renderTokenUsageHtml,
    normalizeUsageBuckets,
    formatCount,
    sessionUsageOf,
    loadTokenUsage,
    resetUsageCache,
    sessionUsageBreakdown,
    messageCategory,
    MESSAGE_CATEGORY_LABELS,
    renderUsageBreakdownHtml,
    USAGE_URL,
    CTF_PRESET_ID,
    CTF_PRESET_PREFIX,
    AGENT_STATUS_LABELS,
    AGENT_STATUS_TONES,
    TASK_STATUS_LABELS,
    MESSAGE_KIND_LABELS,
    FLOATING_CONFIG_KEY,
  }

  /**
   * 注册进 DSH 客户端模块表。
   *
   * factory 在**被 cordis Loader 物化时**才执行（惰性 CJS 模型），所以把
   * `require("react")` 放在 factory 内部 —— 那时模块表已就绪，react 在静态表里。
   * 拿不到 react 也不致命：配置卡片与视图都会退化成纯 DOM 渲染（会打点）。
   */
  function registerWithModuleLoader(target) {
    if (!target || typeof target.load !== 'function') return false
    target.load({
      id: name,
      factory: function (require) {
        if (reactRuntime === null && typeof require === "function") {
          try {
            reactRuntime = require("react")
            beacon('react-loaded', 'createElement=' + typeof reactRuntime?.createElement + ' useRef=' + typeof reactRuntime?.useRef + ' useEffect=' + typeof reactRuntime?.useEffect)
          } catch (error) {
            reactRuntime = null
            beacon('react-missing', (error && error.message) || String(error))
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

  const registeredWithLoader = registerWithModuleLoader(typeof window !== "undefined" ? window.__ModuleLoader__ : null)

  // classic script 没有 export，Node 单测经此全局取用。
  if (typeof globalThis !== "undefined") globalThis.__DSH_LINGXU_CTF_CLIENT__ = api

  //  顶层装配：脚本一执行就尝试装配（不等宿主调用 apply）
  //
  // 注意：**这里不会挂出悬浮面板** —— 悬浮默认关闭，只有宿主
  // `/lingxu-ctf/config` 下发 `enableFloatingPanel: true` 时才挂（见 apply 第 ③ 步）。
  // 顶部「CTF」视图 tab 与配置卡片都依赖真 ctx，只能由 cordis 调 apply(ctx) 时注册。
  if (!registeredWithLoader && typeof document !== "undefined" && typeof window !== "undefined") {
    const boot = () => {
      try {
        apply(null)
      } catch (error) {
        // 装配失败绝不能影响宿主页面。
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
    // 悬浮开关实时跟随配置（开关打开/关闭后无需刷新页面）
    try {
      watchFloatingPanel({})
    } catch (error) {
      if (typeof console !== "undefined" && console.error) {
        console.error("[dsh-lingxu-ctf] floating watcher failed:", error)
      }
    }
  }
})()
