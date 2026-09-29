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
 * 顶层自挂载（文件末尾）保留：脚本一执行就尝试装配，不依赖宿主调用 apply。
 *
 * ## 界面组成（三个互不牵连的出口）
 *
 *   1. **顶部「CTF」视图 tab** —— 注册进 DSH 的 `conversation.view` list slot
 *      （对话 | 轨迹 | **CTF**）。5 个子视图：题目看板（含「进行中」升级）/
 *      Agent 活动 / 协同通信 / 提交审计 / 报告。会话门控：只在 CTF 会话
 *      （当前会话或其祖先 preset 为 `ctf` / `ctf-*`）里显示；拿不到
 *      `ctx.sessions`（或整份快照没有 preset 信息）时**降级为始终注册**。
 *   2. **设置页配置卡片** —— `plugins.bundle.config`（key = 包名）。
 *   3. **右下角悬浮面板** —— **可选且默认关闭**：只有宿主 `/lingxu-ctf/config`
 *      下发 `enableFloatingPanel: true` 才挂（用户明确要求不要悬浮）。
 *
 * ## 数据契约
 *
 *   - `GET /lingxu-ctf/state`   → 赛事 + 题目看板 + 排行榜 + 提交审计 + 理论题
 *   - `GET /lingxu-ctf/team`    → 团队/协同快照（task-12；**路由可能还不存在**，
 *      404 / `{ok:false}` / 非 JSON 一律降级为可读空态，不崩）
 *   - `GET /lingxu-ctf/reports` → writeup 列表（可选路由，同上容错）
 *   - `GET /lingxu-ctf/config`  → 配置卡片表单；同时决定是否挂悬浮面板
 *   - `POST /lingxu-ctf/config` → 保存配置
 *
 * `team` 的期望形状：
 *   `{ ok, members:[{name,status,description,challengeId,challengeName,category}],
 *      tasks:[{id,subject,status,owner,challengeId,challengeName,category}],
 *      messages:[{at,from,to,kind,text}],
 *      counts:{members,running,inactive,tasksTotal,tasksDone,tasksInProgress,tasksPending} }`
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

  // ── 顶部「CTF」视图 tab（DSH 的 conversation.view list slot）──────────────
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

  /** 拿不到 locale 服务时的兜底 tab 文案。 */
  const VIEW_LABEL_FALLBACK = 'CTF'

  /** 会话 preset 命中即视为「CTF 会话」（预设 id 是 ctf，副本按 ctf-* 约定）。 */
  const CTF_PRESET_ID = 'ctf'
  const CTF_PRESET_PREFIX = 'ctf-'

  /** 视图数据源：团队/协同（宿主 task-12）与报告（可选路由）。 */
  const TEAM_URL = '/lingxu-ctf/team'
  const REPORTS_URL = '/lingxu-ctf/reports'

  /** 子视图（数组顺序 = tab 顺序）。 */
  const VIEW_TABS = [
    { id: 'board', label: '题目看板' },
    { id: 'agents', label: 'Agent 活动' },
    { id: 'messages', label: '协同通信' },
    { id: 'submissions', label: '提交审计' },
    { id: 'reports', label: '报告' },
    { id: 'env', label: '环境' },
  ]

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
    if (src === null) return { known: false, limit: 0, held: 0, free: 0, full: false }
    const limit = Math.max(0, num(src.limit, 0))
    const held = Math.max(0, num(src.held, 0))
    const hasFree = src.free !== null && src.free !== undefined
    const free = hasFree ? Math.max(0, num(src.free, 0)) : Math.max(0, limit - held)
    return { known: limit > 0, limit, held, free, full: limit > 0 && free === 0 }
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

  // ────────────────────────────────── 团队 / 协同 / 报告（视图模型，全部容错）

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
      ok: src.ok !== false && members.length + tasks.length > 0,
      error: str(src.error) || null,
      members,
      tasks,
      messages,
      hasTeam: members.length > 0,
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
      body: str(src.body ?? src.content ?? src.markdown),
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
   * ★ 题目看板 + 团队任务的合并 —— 「进行中」必须可见：
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

  // ────────────────────────────────── 顶部「CTF」视图：5 个子视图（HTML 片段）

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

  /** 视图摘要 chips：复用面板 header，并追加团队 / 环境信息。 */
  function renderViewMetaHtml(model) {
    const team = model.team
    const env = obj(model.state.env) || normalizeEnv(null)
    const extra = []
    // 环境配额：稀缺资源（上限通常只有 2），free === 0 时高亮提醒会阻塞环境题
    if (env.known) {
      const title = env.full
        ? '环境配额已满：新的环境题起不来，先释放一个（ctf_release_env）'
        : `环境配额：已占用 ${env.held} / 上限 ${env.limit}`
      extra.push(`<span class="lx-chip ${env.full ? 'lx-chip-warn' : ''} lx-chip-env" title="${escapeHtml(title)}">`
        + `环境 ${escapeHtml(env.held)}/${escapeHtml(env.limit)}${env.full ? ' · 已满' : ''}</span>`)
    }
    if (team.hasTeam) {
      extra.push(`<span class="lx-chip">Agents ${escapeHtml(team.counts.members)}</span>`)
      extra.push(`<span class="lx-chip lx-chip-strong">任务 ${escapeHtml(team.counts.tasksDone)}/${escapeHtml(team.counts.tasksTotal)}</span>`)
    }
    return renderHeaderMetaHtml(model.state) + extra.join('')
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
    // ★ 「进行中 · solver-xxx」：平台未解但任务 in_progress 时由 mergeChallengeBoard 升级而来
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
    return '<div class="lx-vcard lx-st-' + escapeHtml(item.status) + '">'
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
  function renderViewAgentTasksHtml(tasks) {
    if (list(tasks).length === 0) return ''
    const rows = tasks
      .map((task) => '<li>'
        + `<span class="lx-vpill lx-vpill-${escapeHtml(kindClass(task.status))}">`
        + `${escapeHtml(TASK_STATUS_LABELS[task.status] || task.status)}</span>`
        + `<span class="lx-vtask-name">${escapeHtml(task.challengeName || task.subject)}</span>`
        + (task.category !== '' ? `<span class="lx-vnote">${escapeHtml(task.category)}</span>` : '')
        + (task.challengeId !== null ? `<span class="lx-vnote">#${escapeHtml(task.challengeId)}</span>` : '')
        + '</li>')
      .join('')
    return `<details class="lx-vtasks"><summary>负责的题目（${escapeHtml(list(tasks).length)}）</summary>`
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

  /** ② Agent 活动：名字 / 状态点 / 当前题目 / 完成数 / 最后活动（+ 是否持有环境）。 */
  function renderViewAgentsHtml(model) {
    const team = model.team
    if (!team.hasTeam) {
      const hint = team.error
        ? `团队数据读取失败：${team.error}`
        : '说「开始」或调用 ctf_solve_start 拉起团队后，这里会显示每个 agent 的状态与当前题目。'
      return renderViewEmptyHtml('尚未拉起解题团队', hint)
    }
    return team.members
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
        const last = memberLastActivity(member.name, team)
        const tone = AGENT_STATUS_TONES[member.status] || 'lx-dim'
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
          + `<span class="lx-vnote">最后活动 ${escapeHtml(last !== null ? formatTime(last) : '—')}</span>`
          + '</div>'
          + (member.description !== '' ? `<div class="lx-vagent-desc">${escapeHtml(member.description)}</div>` : '')
          + renderViewAgentTasksHtml(tasks)
          + '</div>'
      })
      .join('')
  }

  /** ③ 协同通信：时间线 `[时间] from → to 内容`，按 kind 着色。 */
  function renderViewMessagesHtml(model) {
    const messages = list(model.team.messages)
    if (messages.length === 0) {
      const hint = model.team.error
        ? `团队数据读取失败：${model.team.error}`
        : '团队 spawn / 汇报 / 状态 / 停止 的消息会按时间线汇总在这里。'
      return renderViewEmptyHtml('暂无协同记录', hint)
    }
    // 全部时间可解析时按时间升序（最新在最后），否则保持宿主给的顺序。
    const times = messages.map((message) => Date.parse(message.at))
    const ordered = times.every((value) => Number.isFinite(value))
      ? messages.map((message, index) => ({ message, time: times[index] }))
        .sort((a, b) => a.time - b.time)
        .map((entry) => entry.message)
      : messages
    return '<div class="lx-vtimeline">'
      + ordered
        .map((message) => '<div class="lx-vmsg lx-vmsg-' + escapeHtml(kindClass(message.kind)) + '">'
          + `<span class="lx-vmsg-time">${escapeHtml(formatTime(message.at))}</span>`
          + `<span class="lx-vmsg-kind">${escapeHtml(MESSAGE_KIND_LABELS[message.kind] || message.kind)}</span>`
          + `<span class="lx-vmsg-route">${escapeHtml(message.from)} <i class="lx-varrow">→</i> ${escapeHtml(message.to)}</span>`
          + `<span class="lx-vmsg-text">${escapeHtml(message.text)}</span>`
          + '</div>')
        .join('')
      + '</div>'
  }

  /** ④ 提交审计：时间 / 题目 / 状态 / 脱敏 flag。 */
  function renderViewSubmissionsHtml(model) {
    const rows = list(model.state.submissions).slice(0, 30)
    if (rows.length === 0) {
      return renderViewEmptyHtml('暂无 flag 提交记录', 'ctf_submit_flag 的每一次提交（含重复与错误）都会记在这里。')
    }
    const body = rows
      .map((row) => {
        const label = SUBMISSION_LABELS[row.status] || row.status
        return '<tr class="lx-vsub-row">'
          + `<td class="lx-time">${escapeHtml(formatTime(row.at))}</td>`
          + `<td class="lx-vsub-name" title="${escapeHtml(row.challengeName)}">${escapeHtml(truncate(row.challengeName, 24))}</td>`
          + `<td><span class="lx-sub lx-sub-${escapeHtml(kindClass(row.status))}">${escapeHtml(label)}</span></td>`
          + `<td class="lx-flag">${escapeHtml(truncate(row.flag, 18))}</td>`
          + '</tr>'
      })
      .join('')
    return '<table class="lx-table lx-vtable"><thead><tr><th>时间</th><th>题目</th><th>状态</th><th>flag</th></tr></thead>'
      + `<tbody>${body}</tbody></table>`
  }

  /** ⑤ 报告（writeup）：列表 + 可展开正文。 */
  function renderViewReportsHtml(model) {
    const items = list(model.reports.items)
    if (items.length === 0) {
      const hint = model.reports.error
        ? `报告数据读取失败：${model.reports.error}`
        : '解题 agent 调用 ctf_writeup 生成后，报告会出现在这里，点开即可看正文。'
      return renderViewEmptyHtml('暂无 writeup', hint)
    }
    return items
      .map((report) => {
        const badge = report.submitted
          ? '<span class="lx-vpill lx-vpill-completed">已提交平台</span>'
          : '<span class="lx-vpill lx-vpill-pending">仅本地</span>'
        const limited = report.body.length > 20000 ? `${report.body.slice(0, 20000)}\n…（正文已截断）` : report.body
        const body = limited !== ''
          ? `<pre class="lx-vreport-body">${escapeHtml(limited)}</pre>`
          : '<div class="lx-vnote lx-vreport-empty">（无正文）</div>'
        return '<details class="lx-vreport">'
          + '<summary>'
          + `<span class="lx-vreport-title">${escapeHtml(report.title)}</span>`
          + `<span class="lx-vreport-challenge">${escapeHtml(report.challengeName)}</span>`
          + badge
          + `<span class="lx-vnote">${escapeHtml(formatTime(report.submittedAt))}</span>`
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
        + `<span class="lx-vnote">环境配额 ${escapeHtml(env.held)}/${escapeHtml(env.limit)}（空闲 ${escapeHtml(env.free)}）</span>`
        + (env.full
          ? '<span class="lx-venv lx-venv-warn">配额已满 · 新环境起不来，先释放一个</span>'
          : '')
        + '</div>'
      : ''
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
    return quota + ordered
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

  /** 子 tab → HTML 片段。 */
  function renderViewBodyHtml(model, tab, filters = {}) {
    switch (str(tab)) {
      case 'agents': return renderViewAgentsHtml(model)
      case 'messages': return renderViewMessagesHtml(model)
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
      case 'env': return runningEnvCount(model.board)
      default: return model.stats.total
    }
  }

  // ────────────────────────────────── 顶部「CTF」视图：DOM 控制器

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
    const stateUrl = str(options.stateUrl, STATE_URL) || STATE_URL
    const teamUrl = str(options.teamUrl, TEAM_URL) || TEAM_URL
    const reportsUrl = str(options.reportsUrl, REPORTS_URL) || REPORTS_URL
    const intervalMs = num(options.intervalMs, POLL_INTERVAL_MS)
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)

    const state = {
      snapshot: normalizeState(null),
      team: normalizeTeam(null),
      reports: normalizeReports(null),
      tab: 'board',
      filters: { category: 'all', status: 'all', query: '' },
      model: null,
      error: null,
      loading: true,
      loaded: false,
      updatedAt: null,
    }

    let root = null
    let regions = null
    let timer = null
    let visibilityHandler = null
    let destroyed = false
    let lastRefresh = Promise.resolve()

    // ── 骨架 ────────────────────────────────────────────────────
    function buildSkeleton() {
      const view = el(doc, 'section', VIEW_CLASS)

      const top = el(doc, 'div', 'lx-vtop')
      const title = el(doc, 'div', 'lx-vtitle')
      const nameEl = el(doc, 'span', 'lx-vname')
      nameEl.textContent = '凌虚 CTF'
      const subEl = el(doc, 'span', 'lx-vsub')
      subEl.textContent = '正在加载…'
      title.appendChild(nameEl)
      title.appendChild(subEl)

      const actions = el(doc, 'div', 'lx-vactions')
      const liveDot = el(doc, 'span', 'lx-vlive')
      liveDot.title = '数据连接状态'
      const refreshBtn = el(doc, 'button', 'lx-vbtn lx-vrefresh')
      refreshBtn.type = 'button'
      refreshBtn.textContent = '刷新'
      actions.appendChild(liveDot)
      actions.appendChild(refreshBtn)
      top.appendChild(title)
      top.appendChild(actions)

      const metaEl = el(doc, 'div', 'lx-vchips')
      const statsEl = el(doc, 'div', 'lx-vstats')
      const alertEl = el(doc, 'div', 'lx-valerts')

      const tabsEl = el(doc, 'div', 'lx-vtabs')
      tabsEl.setAttribute('role', 'tablist')
      const tabButtons = new Map()
      for (const tab of VIEW_TABS) {
        const btn = el(doc, 'button', 'lx-vtab')
        btn.type = 'button'
        btn.dataset.tab = tab.id
        const label = el(doc, 'span', 'lx-vtab-label')
        label.textContent = tab.label
        const count = el(doc, 'span', 'lx-vtab-count')
        count.textContent = '0'
        btn.appendChild(label)
        btn.appendChild(count)
        btn.addEventListener('click', () => setTab(tab.id))
        tabsEl.appendChild(btn)
        tabButtons.set(tab.id, { btn, count })
      }

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

      view.appendChild(top)
      view.appendChild(metaEl)
      view.appendChild(statsEl)
      view.appendChild(alertEl)
      view.appendChild(tabsEl)
      view.appendChild(toolbar)
      view.appendChild(bodyEl)

      refreshBtn.addEventListener('click', () => { void refresh() })
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

      if (doc && typeof doc.addEventListener === 'function') {
        visibilityHandler = () => {
          if (doc.hidden !== true) void refresh()
        }
        doc.addEventListener('visibilitychange', visibilityHandler)
      }

      regions = {
        nameEl, subEl, metaEl, statsEl, alertEl, bodyEl, toolbar,
        tabButtons, categorySel, statusSel, searchInput, liveDot,
      }
      return view
    }

    // ── 渲染 ────────────────────────────────────────────────────
    function currentModel() {
      const board = mergeChallengeBoard(state.snapshot.challenges, state.team)
      return {
        state: state.snapshot,
        team: state.team,
        reports: state.reports,
        board,
        stats: viewStats(state.snapshot, board, state.team),
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
      regions.subEl.textContent = [
        PLATFORM_LABELS[snapshot.connection.platform] || snapshot.connection.platform,
        snapshot.connection.baseUrl,
        state.updatedAt !== null ? `更新于 ${formatTime(state.updatedAt)}` : '',
      ].filter((part) => str(part) !== '').join(' · ')

      regions.metaEl.innerHTML = snapshot.configured ? renderViewMetaHtml(model) : ''
      regions.statsEl.innerHTML = snapshot.configured ? renderViewStatsHtml(model) : ''
      regions.alertEl.innerHTML = renderViewAlertHtml(model)

      for (const tab of VIEW_TABS) {
        const entry = regions.tabButtons.get(tab.id)
        if (!entry) continue
        entry.btn.className = tab.id === state.tab ? 'lx-vtab is-active' : 'lx-vtab'
        entry.count.textContent = snapshot.configured ? String(renderViewTabCount(tab.id, model)) : ''
      }
      regions.toolbar.dataset.hidden = state.tab === 'board' ? 'false' : 'true'
      regions.bodyEl.innerHTML = snapshot.configured
        ? renderViewBodyHtml(model, state.tab, state.filters)
        : renderViewEmptyHtml('尚未连接竞赛平台', NOT_CONFIGURED_HINT)
      if (snapshot.configured && state.tab === 'board') syncFilterOptions()

      regions.liveDot.className = 'lx-vlive ' + (state.error !== null ? 'lx-err' : (snapshot.configured ? 'lx-ok' : 'lx-dim'))
      regions.liveDot.title = state.error !== null
        ? `数据加载失败：${state.error}`
        : (snapshot.configured ? '已连接平台，自动刷新中' : '未连接平台')
    }

    /** 切换子 tab（未知 id 忽略）。 */
    function setTab(id) {
      const wanted = str(id)
      if (!VIEW_TABS.some((tab) => tab.id === wanted)) return
      if (state.tab === wanted) return
      state.tab = wanted
      patch()
    }

    // ── 数据 ────────────────────────────────────────────────────
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
    async function fetchJson(url) {
      if (fetchImpl === null) throw new Error('当前环境不支持 fetch')
      const response = await fetchImpl(url, { cache: 'no-store', headers: { accept: 'application/json' } })
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
      const [snapshotResult, teamResult, reportsResult] = await Promise.all([
        settle(fetchJson(stateUrl)),
        settle(fetchJson(teamUrl)),
        settle(fetchJson(reportsUrl)),
      ])

      // ① 赛事快照：失败时保留上一次的好数据，只挂错误提示。
      if (snapshotResult.ok) {
        state.snapshot = normalizeState(snapshotResult.value)
        state.error = state.snapshot.configured ? state.snapshot.error : null
        state.updatedAt = new Date().toISOString()
      } else {
        state.error = errorText(snapshotResult.error)
      }

      // ② 团队 / 协同（task-12；路由可能还不存在 → 空态而不是报错）
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
      if (timer === null) return
      const { handle, scheduler } = timer
      if (scheduler && typeof scheduler.clearInterval === 'function') scheduler.clearInterval(handle)
      else if (typeof clearInterval === 'function') clearInterval(handle)
      timer = null
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

  // ────────────────────────────────── 顶部「CTF」视图：React host 与 slot 注册

  /**
   * 用 React 承载纯 DOM 视图：React 只提供挂载点（ref + effect），视图本身仍是
   * `createCtfView` 的纯 DOM 实现 —— 与配置卡片完全同一套路子，避免手写 VDOM。
   */
  function reactCtfViewHost(react, options) {
    const h = react.createElement
    function LingxuCtfView() {
      const ref = react.useRef(null)
      react.useEffect(() => {
        const view = createCtfView(options)
        const host = ref.current
        const element = view.mount()
        if (host && typeof host.appendChild === 'function' && element) host.appendChild(element)
        view.start()
        return () => view.destroy()
      }, [])
      return h('div', { className: 'lx-view-host', ref })
    }
    // ⚠️ 必须返回**元素**：渲染器把 slot 函数的返回值直接当 React child，
    // 返回组件函数会抛 "Functions are not valid as a React child" → 条目被退休。
    return h(LingxuCtfView)
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
  function canDetectPreset(snapshot) {
    const byId = obj(obj(snapshot)?.byId)
    if (byId === null) return false
    return Object.values(byId).some((row) => sessionRowPreset(row) !== undefined)
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
   * `ctf` / `ctf-*` 时注册，切走就注销。两种降级（都**不会**导致不注册）：
   *   1. 拿不到 `ctx.sessions`（服务缺失 / 结构不认识）→ 始终注册；
   *   2. 拿得到但整份快照里没有任何 preset 信息（无法判定）→ 始终注册。
   *
   * @returns 注册函数，或 null（拿不到 slots 服务）
   */
  function registerCtfView(ctx, options = {}) {
    const slots = obj(ctx)?.slots
    beacon('registerCtfView', 'slots=' + (slots ? 'yes' : 'no') + ' register=' + typeof slots?.register + ' inject=' + typeof slots?.inject)
    if (!slots || typeof slots.register !== 'function') return null

    const meta = viewSlotMeta(ctx)
    const register = () => {
      try {
        const off = slots.register(
          { name: VIEW_SLOT, id: VIEW_SLOT_ID, order: VIEW_ORDER, ...meta },
          (props) => renderCtfViewSlot(props, options),
        )
        beacon('view-slot-registered', `${VIEW_SLOT}#${VIEW_SLOT_ID}`)
        return off
      } catch (error) {
        beacon('view-slot-error', (error && error.message) || String(error))
        throw error
      }
    }

    const listStore = obj(obj(readService(ctx, 'sessions'))?.list)
    // 逃生舱：`options.alwaysShowView === true` 时跳过关控，始终显示这个 tab
    // （用户如果不想按 preset 判定，可以一行打开；默认仍然是「只在 CTF 会话显示」）。
    const forced = options.alwaysShowView === true
    const gated = !forced
      && listStore !== null
      && typeof listStore.getSnapshot === 'function'
      && typeof listStore.subscribe === 'function'
    if (!gated) {
      // 降级 ①：拿不到 sessions（或被强制打开）→ 始终注册
      beacon('view-slot-sessions-absent', forced ? 'fallback=forced' : 'fallback=always')
      hostRegistration(ctx, VIEW_SLOT, register)
      return register
    }

    let disposeEntry = null
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
      if (!detectorBroken && !canDetectPreset(snapshot)) {
        // 降级 ②：快照里没有 preset 信息 → 无法判定 → 始终注册
        detectorBroken = true
        beacon('view-slot-preset-absent', 'fallback=always')
      }
      const current = currentSessionOf(snapshot)
      const wanted = detectorBroken ? true : (current === undefined ? undefined : isCtfSession(snapshot, current))
      if (current === lastId && wanted === lastFlag) return
      lastId = current
      lastFlag = wanted
      if (disposeEntry !== null) {
        try { disposeEntry() } catch { /* 已注销 */ }
        disposeEntry = null
      }
      if (wanted !== true) return
      try {
        disposeEntry = register()
      } catch (error) {
        // 注册失败（例如同 id 已被占用）不能让 slots 的订阅回调炸掉
        beacon('view-slot-error', (error && error.message) || String(error))
        disposeEntry = null
      }
    }

    hostRegistration(ctx, VIEW_SLOT, () => {
      sync()
      const off = listStore.subscribe(sync)
      return () => {
        if (typeof off === 'function') off()
        if (disposeEntry !== null) {
          try { disposeEntry() } catch { /* 已注销 */ }
          disposeEntry = null
        }
      }
    })
    return register
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

        // ── 布尔：渲染成紧凑的开关项，独占一行、左对齐 ──
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

  // ────────────────────────────────────────────────────────────── 样式

  /**
   * 主题：**只用 DSH 真实 token**（`--dsw-alias-*`），**零 fallback、零中间层**。
   *
   * 三条历史 bug（勿回退，回归防线见 tests/client.test.mjs 的「主题」用例）：
   *   1. **暗色检测**：DSH 靠 `body[data-ds-dark-theme]` 切主题（`dsh-client-ui-theme`
   *      里 token 分 `body{}` / `body[data-ds-dark-theme]{}` 两份）。以前我们写
   *      `@media (prefers-color-scheme:dark)` —— 系统浅色 + DSH 暗色时暗色块不生效，
   *      露出硬编码的浅色兜底（白底白字）。**所以本函数里不得出现任何媒体查询式暗色块。**
   *   2. **兜底值**：以前给每个 token 配了 hex 兜底，值是猜的（品牌色猜成蓝色
   *      `#4c6ef5`，DSH 其实是黑白）。token 自己会随主题切换，不需要兜底。
   *   3. **间接层**：以前包了一层 `--lx-*`，纯属多余；直接写 `var(--dsw-alias-*)`。
   *
   * 样式分五段：作用域基础 / 公共原语 / 悬浮面板 / 配置卡片 / 顶部 CTF 视图。
   * 三处出口（视图、配置卡片、悬浮面板）共用本函数，改样式时三处一起看。
   */
  function panelCss() {
    return [
      // ══════════════════════════════════ 一、作用域基础
      // ⚠️ 定位声明（position:fixed 等）**只能**出现在 #lingxu-ctf-panel 块里：
      // 以前把它和主题变量同处 `#panel,.lx-config{}`，导致插件页里的配置卡片
      // 被一起变成右下角浮层（表现为「CSS 丢失」）。视图同样不得带定位。
      `#${PANEL_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;text-align:left;font:13px/20px ${FONT_STACK};color:var(--dsw-alias-label-primary);}`,
      `#${PANEL_ID} *{box-sizing:border-box;}`,
      `#${PANEL_ID}.lx-docked{position:static;right:auto;bottom:auto;align-items:stretch;width:100%;}`,
      `.${CONFIG_CLASS}{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;padding:14px 16px;margin:0;list-style:none;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);text-align:left;font:13px/20px ${FONT_STACK};color:var(--dsw-alias-label-primary);}`,
      `.${CONFIG_CLASS} *{box-sizing:border-box;}`,
      '.lx-view-host{display:block;width:100%;height:100%;min-height:0;}',
      `.${VIEW_CLASS}{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;max-width:1180px;height:100%;min-height:0;margin:0 auto;padding:16px 20px 24px;overflow-y:auto;text-align:left;font:13px/20px ${FONT_STACK};color:var(--dsw-alias-label-primary);}`,
      `.${VIEW_CLASS} *{box-sizing:border-box;}`,

      // ══════════════════════════════════ 二、公共原语（三处出口共用）
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
      '.lx-time{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}',
      `.lx-flag{color:var(--dsw-alias-label-caption);font-family:${MONO_STACK};font-size:12px;}`,
      '.lx-you{display:inline-block;margin-left:6px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:11px;line-height:18px;}',
      '.lx-empty{padding:16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center;}',
      '.lx-section{display:flex;flex-direction:column;gap:8px;}',
      '.lx-section-title{font-size:12px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-tertiary);}',

      // ══════════════════════════════════ 三、悬浮面板（可选，默认关闭）
      // 卡片：12px 圆角 + border-l1 + layer-1 底 + 面板阴影（对齐 pentest 的 .card）
      '.lx-drawer{display:flex;flex-direction:column;width:440px;max-width:calc(100vw - 32px);max-height:min(72vh,760px);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);overflow:hidden;}',
      `#${PANEL_ID}.lx-docked .lx-drawer{width:100%;max-width:none;max-height:none;box-shadow:none;}`,
      `#${PANEL_ID}[data-collapsed="true"] .lx-drawer{display:none;}`,
      '.lx-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.lx-title{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.lx-name{font-size:14px;line-height:22px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-panel-sub{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
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
      '.lx-controls{display:flex;flex-wrap:wrap;gap:8px;padding:12px 14px 0;}',
      '.lx-controls select,.lx-controls input{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:4px 10px;min-width:0;}',
      '.lx-controls input{flex:1;min-width:90px;}',
      '.lx-body{display:flex;flex-direction:column;gap:16px;padding:14px;overflow:auto;}',
      '.lx-group{display:flex;flex-direction:column;gap:8px;}',
      '.lx-group+.lx-group{margin-top:12px;}',
      '.lx-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-tertiary);}',
      '.lx-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;}',
      '.lx-card{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-left-width:3px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);min-width:0;}',
      '.lx-card.lx-st-solved{border-left-color:var(--dsw-alias-state-success-primary);}',
      '.lx-card.lx-st-working{border-left-color:var(--dsw-alias-state-business-primary);}',
      '.lx-card.lx-st-pending{border-left-color:var(--dsw-alias-border-l2);}',
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

      // ══════════════════════════════════ 四、配置卡片（Plugins 页）
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
      '.lx-config-check{display:inline-flex;align-items:center;gap:7px;cursor:pointer;min-height:24px;white-space:nowrap;}',
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

      // ══════════════════════════════════ 五、顶部「CTF」视图（conversation.view tab）
      // ⚠️ 这段的作用域只能是 .lx-v* / .lx-view*，且**不得出现任何定位声明**：
      // 视图渲染在会话区里，一旦把定位写进共享选择器就会盖住别的 UI。
      // 会话区（ui-conversation 的 viewArea）是 overflow:hidden 的弹性盒，
      // 所以视图自己做滚动（height:100% + overflow-y:auto，与 pentest 的 .root 一致）。
      '.lx-vtop{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex:none;}',
      '.lx-vtitle{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.lx-vname{font-size:16px;line-height:24px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-vsub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lx-vactions{display:flex;align-items:center;gap:8px;flex:none;}',
      '.lx-vlive{width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);flex:none;}',
      '.lx-vlive.lx-ok{background:var(--dsw-alias-state-success-primary);}',
      '.lx-vlive.lx-err{background:var(--dsw-alias-state-error-primary);}',
      '.lx-vchips{display:flex;flex-wrap:wrap;gap:6px;flex:none;}',
      '.lx-vchips:empty{display:none;}',
      '.lx-vstats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:1px;flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-border-l1);}',
      '.lx-vstats:empty{display:none;}',
      '.lx-vstats .lx-stat{padding:10px 4px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-vstats .lx-stat-value{font-size:18px;line-height:26px;}',
      '.lx-vstats .lx-stat-label{font-size:11px;}',
      '.lx-valerts{display:flex;flex-direction:column;gap:8px;flex:none;}',
      '.lx-valerts:empty{display:none;}',
      // 子 tab：下划线式（pentest 的 .tab 规格）
      '.lx-vtabs{display:flex;gap:4px;flex:none;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.lx-vtab{appearance:none;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:0;border-radius:8px 8px 0 0;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;}',
      '.lx-vtab:hover{color:var(--dsw-alias-label-secondary);}',
      '.lx-vtab.is-active{color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary);}',
      '.lx-vtab-count{display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;line-height:18px;text-align:center;font-variant-numeric:tabular-nums;}',
      '.lx-vtab.is-active .lx-vtab-count{color:var(--dsw-alias-label-primary);}',
      '.lx-vtoolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none;}',
      '.lx-vtoolbar[data-hidden="true"]{display:none;}',
      '.lx-vtoolbar select,.lx-vtoolbar input{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:4px 10px;min-width:0;}',
      '.lx-vtoolbar input{flex:1;min-width:150px;}',
      '.lx-vbody{display:flex;flex-direction:column;gap:16px;min-height:120px;}',
      '.lx-vgroup{display:flex;flex-direction:column;gap:8px;}',
      '.lx-vgroup-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}',
      '.lx-vgroup-name{font-size:12px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-tertiary);}',
      '.lx-vgroup-count{font-size:12px;line-height:20px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;}',
      '.lx-vcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(216px,1fr));gap:10px;}',
      '.lx-vcard{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-left-width:3px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);min-width:0;}',
      '.lx-vcard.lx-st-solved{border-left-color:var(--dsw-alias-state-success-primary);}',
      '.lx-vcard.lx-st-working{border-left-color:var(--dsw-alias-state-business-primary);}',
      '.lx-vcard.lx-st-pending{border-left-color:var(--dsw-alias-border-l2);}',
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
      '.lx-vtable{font-size:13px;line-height:20px;}',
      '.lx-vtable td,.lx-vtable th{padding:8px 10px;}',
      '.lx-vsub-name{color:var(--dsw-alias-label-primary);}',
      '.lx-vreport{padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.lx-vreport summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer;}',
      '.lx-vreport-title{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.lx-vreport-challenge{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.lx-vpath{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      `.lx-vreport-body{margin:12px 0 0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font:12px/19px ${MONO_STACK};white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto;}`,
      '.lx-vreport-empty{margin-top:8px;}',
      '.lx-vempty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center;}',
      '.lx-vempty-text{max-width:480px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-tertiary);}',
      '.lx-vempty-hint{max-width:480px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-caption);}',
      '@media (max-width:640px){.lx-vcards{grid-template-columns:minmax(0,1fr);}.lx-vmsg{grid-template-columns:88px 1fr;}.lx-vmsg-route{grid-column:2;}}',
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
      const subEl = el(doc, 'span', 'lx-panel-sub')
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
      get destroyed() { return destroyed },
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

  // ────────────────────────────────── 悬浮面板（可选：**默认不挂**）

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
   * 用户明确要求「不要右下角的悬浮」，所以只有宿主
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
   *   1. 注册设置页配置卡片（`plugins.bundle.config`）；
   *   2. 注册顶部「CTF」视图 tab（`conversation.view`）；
   *   3. **按配置**决定是否挂右下角悬浮面板（默认不挂）。
   *
   * 三者互不牵连：任何一项失败都只是打点 + console.error，不影响其余两项。
   *
   * @param {{effect?:Function, slots?:object, get?:Function}|null} ctx
   * @param {object} options 透传给卡片/视图/悬浮开关（`enableFloating` 可强制开关）
   * @returns 面板控制器（未必已挂载）
   */
  function apply(ctx, options = {}) {
    beacon('apply-called', 'ctx=' + (ctx ? 'yes' : 'no'))
    const panel = getPanel(options)

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
    }

    // ③ 悬浮面板：默认不挂，只有宿主配置显式打开才挂
    trackFloatingSync(maybeMountFloatingPanel(options))
    return panel
  }

  // ──────────────────────────────────────────────────── 导出 / 注册 / 自挂载

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
    panelCss,
    ensureStyles,
    registerConfigCard,
    resetConfigSummaryCache,
    // ── 顶部「CTF」视图 tab（conversation.view）──
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
    mergeChallengeBoard,
    viewStats,
    memberLastActivity,
    renderViewMetaHtml,
    renderViewStatsHtml,
    renderViewAlertHtml,
    renderViewBoardHtml,
    renderViewChallengeCard,
    renderViewAgentsHtml,
    renderViewMessagesHtml,
    renderViewSubmissionsHtml,
    renderViewReportsHtml,
    renderViewBodyHtml,
    renderViewTabCount,
    renderViewEmptyHtml,
    kindClass,
    // ── 悬浮面板开关（默认不挂）──
    floatingPanelEnabled,
    maybeMountFloatingPanel,
    watchFloatingPanel,
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

  registerWithModuleLoader(typeof window !== "undefined" ? window.__ModuleLoader__ : null)

  // classic script 没有 export，Node 单测经此全局取用。
  if (typeof globalThis !== "undefined") globalThis.__DSH_LINGXU_CTF_CLIENT__ = api

  // ── 顶层装配：脚本一执行就尝试装配（不等宿主调用 apply）──
  //
  // 注意：**这里不会挂出悬浮面板** —— 悬浮默认关闭，只有宿主
  // `/lingxu-ctf/config` 下发 `enableFloatingPanel: true` 时才挂（见 apply 第 ③ 步）。
  // 顶部「CTF」视图 tab 与配置卡片都依赖真 ctx，只能由 cordis 调 apply(ctx) 时注册。
  if (typeof document !== "undefined" && typeof window !== "undefined") {
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
