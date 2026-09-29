/** Agent Teams 编排：创建、复用、查询和停止解题 teammate。 */

import { existsSync as defaultExistsSync } from 'node:fs'

import { connectionKey } from './store.js'
import { isSessionExpired } from './lingxu.js'

/** 编排相关硬限制（供工具层校验复用）。 */
export const LIMITS = {
  maxConcurrency: 8, // DESIGN.md：并发上限 8
  defaultConcurrency: 4, // DESIGN.md：默认 4
  maxLimit: 200, // 单次建任务上限（任务板 maxTasks 默认 256，留余量）
  // ⚠️ 这只是 **DSH 的默认值**，不是真值：用户 profile 可能覆盖（实测 ~/.dsh/profiles/desktop/cordis.yml
  // 里 maxMembers: 8）。真值优先读 `teams.config.maxMembers`，读不到才退回这里。
  // DSH 语义：maxMembers = 「一支团队最多可创建的 teammate 数」，**不含 lead**（README + roster.js 的
  // `state.members.length >= this.maxMembers` 都这么算）。
  maxTeamMembers: 16,
  maxMemberNameLength: 64, // DSH 强制
  maxSpawnAttempts: 3, // 重名重试次数
  slugMaxLength: 32, // teammate 名（ASCII）slug 截断长度
  maxPathSlugChars: 60, // 路径 slug 截断码点数（与 index.js slugify 对齐）
  //  环境稀缺性（平台源码：CompetitionCTFs.env_limit 默认 2；Competition.env_start_min 默认 60 分钟）
  defaultEnvLimit: 2, // 平台源码的 default；真实值从平台报错文案里自学习（用户零配置）
  minEnvLimit: 1,
  maxEnvLimit: 8, // 理论上限，防脏数据
  maxEnvProbes: 12, // 单轮最多探测多少道题的详情（列表接口没有 task_type，只能按需探测）
  envProbeConcurrency: 4, // 探测并发（1 题 1 次请求，别打爆平台）
  envWarnSeconds: 600, // 剩余 < 10 分钟时提醒延时
  envDelayWindowSeconds: 1800, // 平台只允许「剩余 < 30 分钟」时延时
  //  智能调度：环境配额满时派离线准备 agent
  envScorePenalty: 0.75, // 环境型题降权：占 1/envLimit 的全局配额，机会成本 ≈ 另一道题
  prepScoreBoost: 1.6, // 已有 PREP.md（P0 完成）→ 拿到环境就能出 flag，大幅升权
  parseScoreStep: 0.08, // 每个数量级解出人数 +8%（log10 压缩，避免签到题碾压难题）
  parseScoreMax: 1.4, // 解出人数权重上限
  envStallMinutes: 20, // 环境被占且无进展超过 N 分钟 → 标「环境空转」
  prepStaleMinutes: 30, // 准备 agent 超过 N 分钟还没写出 PREP.md → 视为已结束，允许重新派（防死锁）
  envStallReleaseSeconds: 600, // 停滞且剩余 < 10 分钟 → 建议释放让位
}

/** 题型标签（与 lib/tools.js 的 TASK_TYPE_LABELS 逐字一致；两处各自持有以避免反向依赖）。 */
const TASK_TYPE_LABELS = { 1: '环境型', 2: '外链型', 3: '附件型' }

/** 题型文案；认不出来返回「未知题型」（编排不因缺字段而崩）。 */
export function taskTypeText(taskType) {
  const type = Number(taskType)
  if (!Number.isFinite(type)) return '未知题型'
  return TASK_TYPE_LABELS[type] ?? `题型${type}`
}

/** 是否环境型题目（凌虚 task_type=1）。**只有环境型才吃 envLimit 配额**。 */
export function isEnvType(taskType) {
  return Number(taskType) === 1
}

/** 环境上限夹到 1..maxEnvLimit；非法值返回 null（调用方回退默认值）。 */
export function clampEnvLimit(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num < LIMITS.minEnvLimit) return null
  return Math.min(LIMITS.maxEnvLimit, Math.trunc(num))
}

/**
 * 真实 teammate 上限：**优先读 agentTeams 的运行时配置**（`teams.config.maxMembers`），
 * 读不到（服务没有 config / 值非法）才退回 `LIMITS.maxTeamMembers`（DSH 默认 16）。
 *
 * ⚠️ 为什么不能写死：用户 profile 会覆盖它（实测 `~/.dsh/profiles/desktop/cordis.yml` 里
 * `maxMembers: 8`）。写死 16 会让 `teamRoom` 高估 8 个，spawn 直接撞 `Team member limit 8 reached`。
 *
 * ⚠️ DSH 语义：maxMembers **不含 lead**（README：「一支团队最多可创建的 teammate 数」；
 * roster.js 用 `state.members.length >= this.maxMembers` 判定，state.members 只有 teammate）。
 *
 * @param {object} teams `ctx.agentTeams` 服务实例
 * @param {number} [fallback] 读不到时用的默认值
 * @returns {number}
 */
export function resolveMaxTeamMembers(teams, fallback = LIMITS.maxTeamMembers) {
  return resolveTeamLimitWithSource(teams, fallback).limit
}

/** 内部版：连「上限来源」一起返回，供 status/摘要显示（`运行时配置` / `默认值`）。 */
function resolveTeamLimitWithSource(teams, fallback = LIMITS.maxTeamMembers) {
  try {
    const configured = Number(teams?.config?.maxMembers)
    if (Number.isFinite(configured) && configured >= 1) {
      return { limit: Math.floor(configured), source: '运行时配置 maxMembers' }
    }
  } catch {
    /* Cordis Proxy / 服务形状不同 → 退回默认 */
  }
  return { limit: Math.floor(fallback) || LIMITS.maxTeamMembers, source: '默认值' }
}

/**
 * 从 DSH 的成员上限报错里解析真实 N（`Team member limit 8 reached`，code `TEAM_MEMBER_LIMIT`）。
 * 取不到返回 null（**不要瞎设值**）。
 */
export function parseMemberLimit(error, extraText = '') {
  const text = `${error?.message ?? error ?? ''} ${extraText}`
  const match = /member limit\s+(\d+)\s+reached/i.exec(String(text))
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : null
}

/**
 * work 记录是否表示「这道题此刻正占着环境」。
 *
 * 判据只有 `ctf_start_env` 写的 `envStarted`（且未释放）；`envReleaseTime` 已过则视为
 * 平台已自动释放（`env_start_min` 到期），不再占用配额。
 */
export function envHeld(record, nowMs) {
  if (record?.envStarted !== true || record?.envReleased === true) return false
  const releaseMs = Date.parse(String(record?.envReleaseTime ?? ''))
  if (Number.isFinite(releaseMs) && releaseMs <= nowMs) return false
  return true
}

/** work 记录里的环境剩余秒数（优先绝对的 releaseTime，其次按记录时间衰减 remainingSeconds）。 */
export function envRemainingOf(record, nowMs) {
  if (!record || record.envStarted !== true || record.envReleased === true) return null
  const releaseMs = Date.parse(String(record?.envReleaseTime ?? ''))
  if (Number.isFinite(releaseMs)) return Math.max(0, Math.round((releaseMs - nowMs) / 1000))
  const seconds = Number(record?.envRemainingSeconds)
  if (!Number.isFinite(seconds)) return null
  const at = Date.parse(String(record?.envStartedAt ?? record?.updatedAt ?? ''))
  if (Number.isFinite(at)) return Math.max(0, Math.round(seconds - (nowMs - at) / 1000))
  return Math.max(0, Math.round(seconds))
}

// ---------------------------------------------------------------- 智能调度

/**
 * 题目工作目录（与 `ctf_challenge` 下载附件、solver prompt 的目录**同一处**）。
 * 目录名规则必须与 `writeScopeFor` / `pathSlug` 一致，否则会去看一个不存在的 PREP.md。
 */
export function solverDirFor(challenge, workDir) {
  const base = String(workDir || DEFAULT_WORK_DIR).replace(/\/+$/, '') || DEFAULT_WORK_DIR
  const dirSlug = pathSlug(challenge?.name || challenge?.category, challenge?.id)
  return `${base}/challenges/${dirSlug}-${safeId(challenge?.id)}`
}

/**
 * P0（离线段）完成标记：`<题目目录>/PREP.md`。
 *
 * ⚠️ 这是**软信号**：文件存在 ≈ 已经离线准备过（大概率），不保证质量、不读内容（避免大文件）。
 * 环境型题拿到环境前先把 P0 做完，配额一释放就能立刻出 flag —— 所以它大幅提权。
 */
export function prepFileFor(challenge, workDir) {
  return `${solverDirFor(challenge, workDir)}/PREP.md`
}

/**
 * 派发优先级打分（越大越先派）。**不再只看分值**：
 *
 * | 信号 | 方向 | 依据 |
 * |---|---|---|
 * | `taskType === 1`（环境型） | 降权 ×0.75 | 吃 1/envLimit 的全局配额；机会成本 ≈ 另一道题 |
 * | `parseCount`（全平台解出人数） | 升权（log10，上限 ×1.4） | 源码 `AnswerLog.type=2`「解出」的计数；解出的人多 = 相对简单 = 成功率高 |
 * | `score` | 升权（基数） | 分值 |
 * | 已有 `PREP.md` | 大幅升权 ×1.6 | P0 已完成 → 拿到环境立刻能出 flag，上手最快 |
 *
 * 排序口径见 `orderForSpawn()`：**先非环境题（不吃配额）**，再按本函数降序。
 * 已解题目由 `selectChallenges` 提前排除，这里不再处理。
 *
 * @param {object} challenge 题目（`{ id, name, score, parseCount, solved }`）
 * @param {{ taskType?: number|null, hasPrep?: boolean, limits?: object }} [ctx]
 * @returns {number}
 */
export function scoreChallenge(challenge, ctx = {}) {
  const limits = { ...LIMITS, ...(ctx.limits ?? {}) }
  const score = Math.max(0, Number(challenge?.score ?? 0) || 0)
  const parseCount = Math.max(0, Number(challenge?.parseCount ?? 0) || 0)
  // 解出人数：log10 压缩后线性加成（0 人 → ×1.0；10 人 → ×1.08；100 人 → ×1.16；1000 人 → ×1.24）
  const solveWeight = Math.min(1 + Math.log10(1 + parseCount) * limits.parseScoreStep, limits.parseScoreMax)
  let value = score * solveWeight
  // 环境型降权：它占掉一个稀缺配额，等价于放弃另一道题的收益
  if (isEnvType(ctx.taskType)) value *= limits.envScorePenalty
  // P0 已完成：拿到环境就能立刻验证，性价比最高
  if (ctx.hasPrep === true) value *= limits.prepScoreBoost
  return value
}

/**
 * work 记录里表示「这道题已经结束、槽可以放掉」的状态。
 * `abandoned` 由 `ctf_solve_stop` 写（中断即放弃）；`reassigned` 是本文件换题时给**旧题**打的标记。
 */
export const TERMINAL_WORK_STATUSES = ['abandoned', 'reassigned', 'dropped']

/** 从 task subject（`[分类] 题名 (100分)`）里取分类，用于「同类优先复用」。 */
export function categoryFromSubject(subject) {
  const match = /^\s*\[([^\]]+)\]/.exec(String(subject ?? ''))
  return match ? match[1].trim() : ''
}

/**
 * 找出闲置槽（可被复用去接新题）。
 *
 * 必须**同时**满足（缺一不可，否则会毁掉正在进行的进度）：
 * 1. `listMembers` 里 `status === 'inactive'`（running/provisioning 正在干活；**failed 不可复用**）；
 * 2. 它名下（work 记录 `teammate === 名字`）的题**已经结束**：平台已解出 / 任务板任务 completed / work 记录是终态。
 *
 * ⚠️ **只看 inactive 会出事**：agent 可能正在**等环境配额**、或思考到一半被打断（inactive 只表示「此刻没有 turn 在跑」），
 * 挪用它等于毁掉那道题的进度。所以第 2 条是硬条件。
 *
 * @returns {Array<{name: string, previousId: string, previousSubject: string, category: string}>}
 */
export function collectReusableSlots({ members, workByChallenge, solvedIds, completedIds } = {}) {
  // teammate 名 → 它负责的题。归属有两个来源：
  // - `teammate`：**当前**在做（活跃归属）；
  // - `slotOwner`：**历史**归属（换题/中断时我们会清掉 `teammate`，否则旧题会被判成「已有 agent」永远派不出去，
  //   但清掉后槽就不知道自己原来做过哪道题了 → 用 slotOwner 记住）。
  const owner = new Map()
  for (const [cid, record] of workByChallenge ?? []) {
    if (record?.challengeId == null) continue
    const active = String(record?.teammate ?? '')
    const historical = String(record?.slotOwner ?? '')
    const name = active || historical
    if (!name) continue
    const existing = owner.get(name)
    if (existing?.active && !active) continue // 已有活跃归属，别被历史记录覆盖
    owner.set(name, { id: String(record.challengeId), record, active: Boolean(active) })
  }
  const slots = []
  for (const member of members ?? []) {
    const name = String(member?.name ?? '')
    if (!name || member?.role === 'lead' || name === 'lead') continue
    if (member?.status !== 'inactive') continue
    const owned = owner.get(name)
    if (!owned) continue // 不知道它原来在做哪道题 → 保守起见不复用
    const cid = String(owned.id)
    const record = owned.record
    const finished =
      solvedIds?.has(cid) === true ||
      completedIds?.has(cid) === true ||
      TERMINAL_WORK_STATUSES.includes(String(record?.status ?? ''))
    if (!finished) continue
    slots.push({
      name,
      previousId: cid,
      previousSubject: String(record?.subject ?? `#${cid}`),
      category: categoryFromSubject(record?.subject),
    })
  }
  return slots
}

/**
 * 给一道题挑一个闲置槽：**同类优先**（做过 Crypto 的槽去接 Crypto 新题，
 * 上一题的领域上下文可能反而是优势），同类没有就取第一个。
 */
export function takeSlotFor(slots, challenge) {
  if (!Array.isArray(slots) || !slots.length) return null
  const category = String(challenge?.category ?? '').trim()
  const index = category ? slots.findIndex((slot) => slot.category === category) : -1
  const at = index >= 0 ? index : 0
  return slots.splice(at, 1)[0] ?? null
}

/**
 * 派发顺序：**非环境题优先**（不吃配额），然后按 `scoreChallenge` 降序。
 * 同分时用 id 升序保证稳定（与 `compareChallenges` 的约定一致）。
 */
export function orderForSpawn(items) {
  const rows = Array.isArray(items) ? items : []
  return [...rows].sort((a, b) => {
    // 1) 非环境题优先（不吃稀缺配额，先填满并发）
    const aEnv = isEnvType(a?.taskType) ? 1 : 0
    const bEnv = isEnvType(b?.taskType) ? 1 : 0
    if (aEnv !== bEnv) return aEnv - bEnv
    // 2) 已就绪（PREP.md 在）优先：配额释放后先把「拿到环境就能出 flag」的题送进 P1
    if (Boolean(a?.hasPrep) !== Boolean(b?.hasPrep)) return a?.hasPrep ? -1 : 1
    // 3) 再按 scoreChallenge（环境型降权 / 解出人数升权 / PREP 升权）
    const diff = Number(b?.priority ?? 0) - Number(a?.priority ?? 0)
    if (diff) return diff
    const an = Number(a?.challenge?.id)
    const bn = Number(b?.challenge?.id)
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn
    return String(a?.challenge?.id ?? '').localeCompare(String(b?.challenge?.id ?? ''))
  })
}

const DEFAULT_WORK_DIR = 'lingxu-ctf-work'
const FRESH_PROVIDER = 'spawn'

/**
 * sessionid 失效时的编排层文案。
 *
 * 背景（真实事故）：session 中途失效时 `ctf_solve_start` 照常建任务、拉 agent，
 * 8 个 agent 一起撞 403，`ctf_submit_flag` 连续失败导致 **flag 丢失**。
 * 因此 start 前置探活失败即停手；status 顶部给醒目横幅（但**不**自动中断 agent）。
 */
export const SESSION_EXPIRED_BANNER = [
  '🛑 平台 sessionid 已失效 —— 所有 agent 的提交都会失败，flag 会丢失。',
  '   请立即更新 Cookie（ctf_connect），然后重新 ctf_solve_start。',
].join('\n')

/** start 因 session 失效拒绝编排时的完整文案（带平台地址，便于用户直接去登录）。 */
export function sessionExpiredStartText(baseUrl) {
  const url = String(baseUrl || '').trim()
  return [
    '❌ 无法开始：凌虚 sessionid 已失效（平台返回「未登录」）。',
    `   请重新登录${url ? ` ${url} ` : '平台'}后复制新的 Cookie，再用 ctf_connect { baseUrl, eventId, cookie } 更新。`,
    '   其余配置（并发、工作目录等）都会保留，连接也会复用。',
    '   本次未创建任何任务、未拉起任何 agent。',
  ].join('\n')
}

/**
 * 轻量探活：优先 `adapter.validate()`（凌虚 = 1 次请求 `GET /event/{id}/info/`），
 * 退回 `adapter.eventSummary()`；适配器两者都没有时视为「无法探活」并放行（不阻断编排）。
 *
 * 返回 `{ checked, sessionExpired, error, warning }`：
 * - `sessionExpired` → 调用方应立即停手；
 * - `warning` → 网络/超时等**其他**错误，只警告不阻断（不因为一次抖动就拒绝干活）。
 */
export async function probeSession(adapter) {
  const probe =
    typeof adapter?.validate === 'function'
      ? () => adapter.validate()
      : typeof adapter?.eventSummary === 'function'
        ? () => adapter.eventSummary()
        : null
  if (!probe) return { checked: false, sessionExpired: false, error: null, warning: null }
  try {
    await probe()
    return { checked: true, sessionExpired: false, error: null, warning: null }
  } catch (error) {
    if (isSessionExpired(error)) {
      return { checked: true, sessionExpired: true, error, warning: null }
    }
    return { checked: true, sessionExpired: false, error: null, warning: error }
  }
}

// 契约键（小写比较）：任务 description 里那一行的键名。
const CHALLENGE_ID_KEY = 'challengeid'
// challengeId 值允许的字符集（与 safeId 的输出一致；平台 id 以数字为主）。
const ID_VALUE_RE = /^[A-Za-z0-9_-]+$/
// 键与值之间的分隔符：半角/全角冒号、等号。
const KEY_VALUE_SEPARATORS = new Set([':', '：', '='])
// 行首允许的装饰：空白、列表符号、引用符号、标题号。
const LINE_PREFIX_RE = /^[\s>*#•\-–—]+/
// 从 writeScope 反解 challengeId：前缀用贪婪匹配（`baby-heap-12` 必须得到 `12`，而不是 `heap-12`），
// 尾部 token 不含 `-`（`safeId` 产出的 id 以数字/字母为主）。
const SCOPE_ID_RE = /challenges\/.+-([A-Za-z0-9_]+)\/?$/i
// 路径危险字符：`<>:"/\|?*` + C0/C1 控制字符（含 DEL）
const PATH_UNSAFE_RE = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]+/g

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

// ---------------------------------------------------------------- 纯函数工具

/** 清洗成 lower-kebab-case 片段；全被过滤掉时返回 ''（由调用方回退）。 */
export function sanitizeSlug(value, maxLength = LIMITS.slugMaxLength) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, Math.max(0, maxLength))
    .replace(/-+$/, '')
  return slug
}

/**
 * 路径 slug：**保留中文等可读字符**，只替换路径危险字符。
 *
 * ⚠️ 必须与 `lib/index.js` 的 `slugify`、`lib/tools.js` 的 `slugify`、`lib/writeup.js` 的 `slugify`
 * **逐字一致**：编排层用它决定 solver 的工作目录（prompt / writeScope），而 `ctf_challenge`
 * 用它把附件下载到 `challenges/<slug>-<id>/distfiles/`；差一个字符 solver 就会去一个没有附件的目录。
 * **不要做 NFKC 归一化**：全角括号 `（）` 必须原样保留，否则 `签到题（Web 入门）` 会变成
 * `签到题(web-入门)`，与其余三份实现不一致。
 *
 * 规则：替换 `<>:"/\|?*` 与控制字符（C0 / DEL / C1）→ 空白折叠为 `-` → 折叠连续 `-`
 * → 去掉首尾 `-_.` → 截断 60 **码点**（`Array.from`，不会切断代理对；这是与 index/tools
 * 的 UTF-16 截断唯一有意为之的差异）→ 为空回退 `challenge`（与 index.js 的默认 fallback 一致）。
 *
 * 注意 fallback 是**裸** `challenge`，不含 id：`writeScopeFor` 会再拼 `-<id>`，若这里返回
 * `ch-<id>` 会得到 `ch-12-12`，与 `ctf_challenge` 的 `challenge-12` 不一致。
 *
 * 用途：`writeScope` / 本地目录名。**不要**用于 teammate 名（DSH 强制 lower-kebab-case）。
 * @param {string} value 题名/分类
 * @param {unknown} [fallbackId] 保留参数（与 `slugify(value, fallback)` 调用约定兼容），当前不参与回退
 */
export function pathSlug(value, fallbackId) { // eslint-disable-line no-unused-vars -- 保留签名兼容
  const fallback = 'challenge'
  let text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(PATH_UNSAFE_RE, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')

  const chars = Array.from(text)
  if (chars.length > LIMITS.maxPathSlugChars) {
    text = chars.slice(0, LIMITS.maxPathSlugChars).join('').replace(/[-.]+$/g, '')
  }
  return text || fallback
}

/** 把任意 id 变成可用于名字/路径的 token。 */
export function safeId(value) {
  const text = String(value ?? '').trim()
  return text.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || '0'
}

/**
 * teammate 名专用 slug（ASCII lower-kebab-case，DSH 强制）。
 * 清洗失败时退回分类，再退回 'ch'；路径可读性由 `pathSlug` 负责。
 */
export function memberSlug(challenge) {
  return sanitizeSlug(challenge?.name) || sanitizeSlug(challenge?.category) || 'ch'
}

/** 题目 → teammate 名字（含长度兜底，保证满足 DSH 命名规则）。
 * `prefix` 用于区分角色：`solver-`（全程 agent）/ `prep-`（离线准备 agent，不占环境配额）。 */
export function teammateNameFor(challenge, { slug, prefix = 'solver' } = {}) {
  const idPart = safeId(challenge?.id)
  const rawSlug = slug || memberSlug(challenge)
  const head = String(prefix || 'solver').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'solver'
  const budget = Math.max(3, LIMITS.maxMemberNameLength - head.length - 1 - 1 - idPart.length - 12)
  const trimmed = rawSlug.slice(0, budget).replace(/-+$/, '') || 'ch'
  return fitMemberName(`${head}-${trimmed}-${idPart}`)
}

/** 名字超长时从中间裁掉（保留尾部 id/后缀，保证唯一性可见）。 */
export function fitMemberName(name) {
  const text = String(name ?? '')
  if (text.length <= LIMITS.maxMemberNameLength) return text
  const tail = text.slice(-20).replace(/^-+/, '')
  const head = text.slice(0, LIMITS.maxMemberNameLength - tail.length - 1).replace(/-+$/, '')
  return `${head}-${tail}`
}

/**
 * 在已占用名字集合里分配一个唯一名字：`base` → `base-2` → `base-3` … → `base-<seed>`。
 * DSH 的 teammate 名字永久占用，所以失败的名字也要算作已占用。
 */
export function allocateName(base, used, seed = '') {
  const taken = used instanceof Set ? used : new Set(used ?? [])
  if (!taken.has(base)) return base
  for (let i = 2; i <= 9; i += 1) {
    const candidate = fitMemberName(`${base}-${i}`)
    if (!taken.has(candidate)) return candidate
  }
  const suffix = String(seed || 'x').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'x'
  let candidate = fitMemberName(`${base}-${suffix}`)
  let n = 1
  while (taken.has(candidate)) {
    n += 1
    candidate = fitMemberName(`${base}-${suffix}${n}`)
  }
  return candidate
}

function toIdSet(challengeIds) {
  if (challengeIds == null) return null
  const list = Array.isArray(challengeIds) ? challengeIds : String(challengeIds).split(',')
  const set = new Set()
  for (const entry of list) {
    const text = String(entry ?? '').trim()
    if (text) set.add(text)
  }
  return set.size ? set : null
}

function toCategorySet(category) {
  if (category == null) return null
  const list = Array.isArray(category) ? category : String(category).split(',')
  const set = new Set()
  for (const entry of list) {
    const text = String(entry ?? '').trim().toLowerCase()
    if (text) set.add(text)
  }
  return set.size ? set : null
}

function compareChallenges(a, b) {
  const scoreDiff = Number(b?.score ?? 0) - Number(a?.score ?? 0)
  if (scoreDiff) return scoreDiff
  const an = Number(a?.id)
  const bn = Number(b?.id)
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
}

/**
 * 过滤 + 排序 + 截断题目（纯函数）。
 * 过滤顺序：未解（includeSolved=false 时）→ challengeIds → category（忽略大小写精确匹配，可逗号分隔）
 * → minScore。排序：分值降序，同分按 id 升序。
 */
export function selectChallenges(challenges, args = {}) {
  const { category, minScore, limit, includeSolved = false, challengeIds } = args ?? {}
  const idFilter = toIdSet(challengeIds)
  const categories = toCategorySet(category)
  const min = minScore == null || minScore === '' ? null : Number(minScore)
  const floor = Number.isFinite(min) ? min : null

  const rows = (Array.isArray(challenges) ? challenges : []).filter((challenge) => {
    if (!challenge || challenge.id == null) return false
    if (!includeSolved && challenge.solved) return false
    if (idFilter && !idFilter.has(String(challenge.id))) return false
    if (categories && !categories.has(String(challenge.category ?? '').trim().toLowerCase())) return false
    if (floor != null && !(Number(challenge.score ?? 0) >= floor)) return false
    return true
  })
  rows.sort(compareChallenges)

  const max = Number(limit)
  if (Number.isFinite(max) && max >= 1) return rows.slice(0, Math.floor(max))
  return rows
}

/** 题目 → 共享任务板 subject（≤200 字符，DSH 限制）。 */
export function taskSubjectFor(challenge) {
  const category = String(challenge?.category ?? '').trim() || '未分类'
  const name = String(challenge?.name ?? '').trim() || `challenge-${safeId(challenge?.id)}`
  const score = Number(challenge?.score ?? 0)
  return `[${category}] ${name} (${score}分)`.slice(0, 200)
}

/**
 * 题目 → 相对 write scope（必须是工作区相对路径：无前导 /、无 `..`）。
 * 目录名用 `pathSlug`（保留中文可读性），与 writeup.js / index.js 的目录约定一致。
 */
export function writeScopeFor(challenge, slug) {
  const dirSlug = slug || pathSlug(challenge?.name || challenge?.category, challenge?.id)
  return `${DEFAULT_WORK_DIR}/challenges/${dirSlug}-${safeId(challenge?.id)}`
}

/**
 * 共享任务板 description：机器可读的 challengeId 行 + 工具清单 + 验收标准。
 *
 * ⚠️ **契约（不要改格式）**：首行是**独立一行** `challengeId: <id>`，
 * `GET /lingxu-ctf/team` 与 `ctf_solve_status` 都靠 `parseChallengeId()` 从这一行拿题目 id。
 * 不要把 challengeId 混进句子（`题目 challengeId: 1 已解` 这种写法解析器不再保证命中）。
 */
export function buildTaskDescription({ challenge, connection, connKey, taskId }) {
  const scope = writeScopeFor(challenge)
  const category = String(challenge?.category ?? '').trim() || '未分类'
  const score = Number(challenge?.score ?? 0)
  return [
    `challengeId: ${safeId(challenge?.id)}`, // ← 机器可读契约行（独立成行）
    `题目：${challenge?.name ?? ''}`,
    `分类：${category} ｜ 分值：${score}`,
    `平台：${connection?.platform ?? 'lingxu'} ${connection?.baseUrl ?? ''}（eventId=${connection?.eventId ?? '-'}）`,
    `连接 key：${connKey}`,
    `任务板任务：${taskId ?? '（创建后由 lead 在 spawn prompt 中告知）'}`,
    '',
    '要求：',
    `1. 用 ctf_challenge 读取题目 id=${safeId(challenge?.id)} 的题面（HTML 已转 Markdown）并下载附件；`,
    '2. 需要环境时用 ctf_start_env 拿连接信息（begin→run→addr，返回 nc host port）；',
    `3. 在当前 workspace 的 ${scope}/ 下解题，保留 exp/脚本；`,
    '4. flag 用 ctf_submit_flag 提交（插件自动去重 + 审计；punish 赛事错误提交会扣分，禁止盲目爆破）；',
    '5. 成功后用 ctf_writeup 生成 WP（本地保存，平台提交可选）；',
    '6. 完成后把本任务 updateTask action=complete 关闭，并用 send_message 向 lead 汇报。',
    '',
    `验收标准：ctf_submit_flag 返回 correct / already_solved，且 ${scope}/ 下生成了 WP。`,
    `写入范围：${scope}`,
  ].join('\n')
}

/**
 * teammate 初始 prompt（ContentBlock[]）。
 * teammate 是 fresh context，看不到 Lead 历史 → 平台地址/凭据引用/题目/任务/工作流全部写进 prompt。
 *
 * 环境配额段落：只有 `taskType === 1` 的题才写「拿到环境立刻释放」的纪律；
 * 非环境题（外链型/附件型）明确告知不吃配额，避免 agent 误以为自己在抢稀缺资源。
 */
export function buildSolverPrompt({
  name, challenge, taskId, connection, connKey, workDir, envLimit, envHeld, taskType,
}) {
  const category = String(challenge?.category ?? '').trim() || '未分类'
  const score = Number(challenge?.score ?? 0)
  const id = safeId(challenge?.id)
  const dirSlug = pathSlug(challenge?.name || challenge?.category, challenge?.id)
  const scope = writeScopeFor(challenge, dirSlug)
  const dir = `${workDir || DEFAULT_WORK_DIR}/challenges/${dirSlug}-${id}`
  const subject = taskSubjectFor(challenge)
  const envTask = isEnvType(taskType)
  const limitText = Number.isFinite(Number(envLimit)) && Number(envLimit) > 0 ? Number(envLimit) : LIMITS.defaultEnvLimit
  const heldText = Number.isFinite(Number(envHeld)) && Number(envHeld) > 0 ? `，当前已占用 ${Number(envHeld)} 个` : ''

  const envSection = envTask
    ? `## ⚠️ 环境配额（本题是环境型，环境是稀缺资源）
- 本赛事同时最多 **${limitText} 个**环境${heldText}（平台限制；插件按它限量派发环境型题目）。
- 你拿到环境后**其他 agent 才能用**：解出、放弃或卡住时请**立刻** \`ctf_release_env id=${id}\` 释放让位。
- 环境会在平台到期后自动释放，**时长以 \`ctf_start_env\` 返回的「环境剩余」为准**（部分赛事只有 30 分钟）；
  **剩余 < 30 分钟**时可用 \`ctf_delay_env id=${id}\` 延长 30 分钟（解长题建议提前延一次；envAutoDelay 开启时起环境会自动延）。
- 撞上平台环境数上限时，\`ctf_start_env\` 会给出可操作提示（先释放再起），不要反复硬撞。`
    : `## 环境配额
- 本题是**${taskTypeText(taskType)}**，不需要环境、也不吃环境配额：直接读题面/附件/外链解题即可。`

  const reminder = [
    '<system-reminder>',
    `You are teammate "${name}".`,
    'Your Team Lead is named "lead".',
    'Use list_agents({}) to find your teammates and their names.',
    'To message your Team Lead, use send_message({ target: "lead", message: "..." }).',
    'To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).',
    '</system-reminder>',
    '',
  ].join('\n')

  const body = `# 任务：解出 CTF 题目「${challenge?.name ?? id}」

你是 dsh-lingxu-ctf 插件的并发解题 teammate。**你是 fresh context，看不到 Lead 的任何对话历史**，
以下信息完全自包含，请严格照此执行。

## 平台与凭据
- 平台：${connection?.platform ?? 'lingxu'}（${connection?.baseUrl ?? '未提供'}），赛事 eventId=${connection?.eventId ?? '-'}
- 连接 key：${connKey}
- 凭据（sessionid Cookie）已保存在插件 store 中，**不要在输出里回显 cookie**。
  调用平台工具时传 \`connection: "${connKey}"\`；省略该参数时会回退到当前活动连接。

## 本题
- challengeId：${id}
- 名称：${challenge?.name ?? ''}
- 分类：${category}
- 分值：${score}
- 题型：${taskTypeText(taskType)}
- 共享任务板任务：${taskId}（subject：${subject}）
- 工作目录：${dir}（只允许在这里写文件）

${envSection}

## 执行步骤
1. **claim 任务**：用任务板工具（team_task_update / updateTask）以 \`action: "claim"\` 认领 ${taskId}
   （expectedRevision 取 listTasks 里的当前 revision）。
2. **读题**：\`ctf_challenge\` 读取题目 id=${id} 的题面与附件（附件下载到 ${dir}/）。
3. **起环境**（题目需要环境时）：\`ctf_start_env\`（题目 id=${id}）→ 拿到 \`nc host port\` 等连接信息。
   解题环境就是当前本机 workspace，按需安装工具链（**不要用 Docker**）。
4. **解题**：在 ${dir}/ 下写脚本/exp 反复调试。不要修改其他 teammate 的目录，也不要改插件源码。
5. **交 flag**：\`ctf_submit_flag\`（题目 id=${id}, flag=...）。插件自动去重 + 审计；
   本赛事若开启 punish，错误提交会扣分 → 不要盲目爆破，不确定的 flag 不要提交。
6. **写 WP**：\`ctf_writeup\` 生成 writeup（保存到 ${dir}/writeup.md 或插件默认位置），必要时提交平台。
7. **关闭任务**：\`updateTask\` 对 ${taskId} 执行 \`action: "complete"\`。
8. **汇报**：用 \`send_message\` 给 \`lead\` 发一条消息，说清：题目、flag 是否提交成功、WP 路径、耗时、阻塞点。
9. **协同落档**（\`ctf_team_log\`，用户会在「协同通信」tab 里看）：
   - **跨题线索必记**：任何**对其他题有用**的东西（凭据/密钥/token/内网地址/通用 payload/同款漏洞点）
     → \`ctf_team_log kind="clue" challengeId=<本题或线索指向的题 id>\`。**这是硬要求**：不记就等于线索丢了。
   - **求助**：卡住需要别人帮忙 → \`ctf_team_log kind="help"\`，说清要谁做什么。
   - **阶段进展**：拿到 shell / 找到注入点 / 爆破出密码这类里程碑 → \`ctf_team_log kind="progress"\`。
   - 与 \`send_message\` 的分工：**要叫具体的人做事**用 send_message（会投递给他）；
     **只是留档给全队和用户看**用 \`ctf_team_log\`（不打扰别人）。两者可以都发。

## 约束
- 只解本题，不要动别人的题目与目录。
- 卡住 / 失败也要汇报（send_message 找 lead），不要静默结束。
- 线索/求助/进展**同时**用 \`ctf_team_log\` 落一条（用户靠它看协同过程；只发 send_message 的话面板里看不到）。
- 共享任务板就是去重手段：本题任务已被你 claim，不要重复建任务。
- 若平台工具缺少 \`connection\` 参数，直接调用即可（默认走活动连接）。

验收标准：ctf_submit_flag 返回 correct / already_solved，且 ${scope}/ 下存在 WP 文件。`

  return [
    { type: 'text', text: reminder },
    { type: 'text', text: body },
  ]
}

// ---------------------------------------------------------------- 小工具

/**
 * 「同一个槽 → 同一道题」的**重启**消息（被中断后重新派回原题）。
 *
 * 与 `buildReassignPrompt` 的区别：那道题就是它自己做过的，**不要**叫它「忽略上一题」——
 * 应该让它接着已有的 PREP.md / 脚本 / 结论继续（那才是最快出 flag 的路径）。
 */
export function buildResumePrompt({
  name, challenge, taskId, connection, connKey, workDir, envLimit, envHeld, taskType, mode,
} = {}) {
  const id = safeId(challenge?.id)
  const subject = taskSubjectFor(challenge)
  const heading = `♻️ 你之前就在做 #${id}（${challenge?.name ?? ''}）—— 这**不是新题**，是**重启**上一轮被中断的进度。

## 重启纪律
- ✅ **先看自己的旧成果**：\`${solverDirFor(challenge, workDir)}/\` 下的 \`PREP.md\`、脚本、exp、笔记，能接着用就接着用（别从零重来）。
- ✅ 环境若已释放：重新 \`ctf_start_env id=${id}\` 起环境，再跑你的脚本验证。
- ✅ 任务板任务：${taskId}（subject：${subject}）—— 若它还是 pending，重新 claim 即可。
- ⛔ 不要动**其他题**的环境与目录。

下面是本题的完整任务书（与上一轮一致，确认用）：`

  const base =
    mode === 'prep'
      ? buildPrepPrompt({ name, challenge, taskId, connection, connKey, workDir, envLimit, envHeld })
      : buildSolverPrompt({ name, challenge, taskId, connection, connKey, workDir, envLimit, envHeld, taskType })
  return [{ type: 'text', text: heading }, ...base]
}

/**
 * 「复用闲置槽」的换题消息。
 *
 * ⚠️ **防上下文污染是第一要务**：被复用的 teammate 带着上一道题的完整上下文，
 * 如果不说清，它可能拿旧结论去套新题、甚至去动旧题的靶机/目录/flag（毁掉别人的进度）。
 * 所以这条消息**第一句**就是切换声明，然后才附上完整的新题任务书（自包含）。
 *
 */
export function buildReassignPrompt({
  name, previousId, previous, challenge, taskId, connection, connKey, workDir, envLimit, envHeld, taskType, mode,
} = {}) {
  const prevId = safeId(previousId ?? previous?.id)
  const prevName = String(previous?.name ?? '').trim() || `#${prevId}`
  const nextId = safeId(challenge?.id)
  const nextName = String(challenge?.name ?? '').trim() || `#${nextId}`
  const warning = `⚠️ 你之前在做 #${prevId}（${prevName}），那道题**已经结束**。你现在被**重新分配**到 #${nextId}（${nextName}）——请**完全忽略**之前的题目内容、路径、flag 与结论，它们与新题无关。

## 换题纪律（务必遵守）
- ⛔ **不要碰 #${prevId}** 的靶机环境、工作目录（含 PREP.md / 脚本 / exp）与 flag：那道题可能已被别人接手，动它会毁掉别人的进度。
- ⛔ 不要沿用上一题的脚本、payload、字典、结论或思路 —— 换了题就**重新分析**。
- ⛔ 不要提交上一题遗留的 flag（插件会去重，白费一次错误提交）。
- ✅ **重新完整读一遍**新题：调用 \`ctf_challenge id=${nextId}\` 拉题面与附件（**不要凭记忆或猜测**）。
- ✅ 产物写到**新题**的目录：\`${solverDirFor(challenge, workDir)}/\`。
- ✅ 按新题自己的题型行事（环境型才需要 \`ctf_start_env\`；附件型/外链型不吃环境配额）。

下面是新题的完整任务书（以它为准）：`

  const base =
    mode === 'prep'
      ? buildPrepPrompt({ name, challenge, taskId, connection, connKey, workDir, envLimit, envHeld })
      : buildSolverPrompt({ name, challenge, taskId, connection, connKey, workDir, envLimit, envHeld, taskType })
  return [{ type: 'text', text: warning }, ...base]
}

/**
 * 「离线准备 agent」的初始 prompt（P0 段）。
 *
 * 场景：环境型题目配额已满，但 P0（读题/下载分析附件/逆向/审计/写 exp/搭本地复现）**不需要环境**。
 * 与其让 agent 干等，不如派它把 P0 做完 —— 配额一释放，这道题就能立刻进 P1 出 flag。
 *
 * 文案必须**具体可执行**（agent 只能看到 prompt）：
 * - 明确「现在拿不到配额」+ 不要反复调 `ctf_start_env`（会撞 env-limit，纯浪费）；
 * - 明确产物落点 `PREP.md` + 脚本目录；
 * - 明确**不要** claim/complete 任务板（那是 P1 全程 agent 的）；
 * - 明确完成后 `send_message` 汇报「已就绪，等环境」。
 */
export function buildPrepPrompt({ name, challenge, taskId, connection, connKey, workDir, envLimit, envHeld }) {
  const category = String(challenge?.category ?? '').trim() || '未分类'
  const score = Number(challenge?.score ?? 0)
  const id = safeId(challenge?.id)
  const dir = solverDirFor(challenge, workDir)
  const prepFile = prepFileFor(challenge, workDir)
  const subject = taskSubjectFor(challenge)
  const limitText = Number.isFinite(Number(envLimit)) && Number(envLimit) > 0 ? Number(envLimit) : LIMITS.defaultEnvLimit
  const heldText = Number.isFinite(Number(envHeld)) && Number(envHeld) > 0 ? `${Number(envHeld)} 个` : '（全部）'

  const reminder = [
    '<system-reminder>',
    `You are teammate "${name}".`,
    'Your Team Lead is named "lead".',
    'Use list_agents({}) to find your teammates and their names.',
    'To message your Team Lead, use send_message({ target: "lead", message: "..." }).',
    '</system-reminder>',
    '',
  ].join('\n')

  const body = `# 任务：为「${challenge?.name ?? id}」做**离线准备（P0）**——现在拿不到环境配额

你是 dsh-lingxu-ctf 插件的**离线准备 teammate**。**你是 fresh context，看不到 Lead 的对话历史**，
以下信息完全自包含。这道题是环境型，但**本赛事同时最多 ${limitText} 个环境，当前已被占用 ${heldText}**，
所以你现在**拿不到环境配额**。

⚠️ 因此：**不要反复调 \`ctf_start_env\`**（只会撞平台 env-limit 报错，纯浪费时间和上下文）。
你的价值是把**不需要环境的那半段工作**全部做完，让这道题在配额一释放时能立刻进 P1 出 flag。

## 平台与凭据
- 平台：${connection?.platform ?? 'lingxu'}（${connection?.baseUrl ?? '未提供'}），赛事 eventId=${connection?.eventId ?? '-'}
- 连接 key：${connKey}
- 凭据（sessionid Cookie）已保存在插件 store 中，**不要在输出里回显 cookie**。
  调用平台工具时传 \`connection: "${connKey}"\`；省略该参数时会回退到当前活动连接。

## 本题
- challengeId：${id}
- 名称：${challenge?.name ?? ''}
- 分类：${category}
- 分值：${score}
- 共享任务板任务：${taskId}（subject：${subject}）
- 工作目录：${dir}（只允许在这里写文件）

## 只做这些（不需要环境）
1. **读题**：\`ctf_challenge id=${id}\` 拿题面（HTML 已转 Markdown）+ 附件（会下载到 ${dir}/distfiles/）。
   题目若有手册/二级路径/外链，一并读完。
2. **静态分析**：逆向二进制、审计源码、分析附件格式、找漏洞点与可利用路径。
   本机没有工具链就按需装（\`pip install\` / \`brew install\`，**不要用 Docker**）。
3. **写可执行脚本**：把 exploit / 利用脚本 / 分析脚本写到 ${dir}/ 下（例如 \`exp.py\`、\`solve.py\`），
   **要求：拿到 \`nc host port\` 后能直接跑**（把目标地址/端口做成命令行参数或环境变量，别写死）。
4. **搭本地复现**（能搭就搭）：用本地 mock/复现环境验证脚本逻辑，把不确定点记下来。
5. **写 ${prepFile}**（必做，这是「P0 已完成」的信号）：
   - 题目理解与关键结论（漏洞点、约束、已知线索）
   - 附件清单与各自用途
   - 脚本用法（怎么传 target、预期输出）
   - **P1 下一步计划**：拿到环境后按 1/2/3 步做什么、要验证什么、可能的坑
   - 不确定/待确认的点

## 明确不要做
- ❌ 不要调 \`ctf_start_env\`（拿不到配额；配额要留给已经准备好、或正在打靶的题）
- ❌ 不要释放/重置**别的题**的环境（那是别人的进度，不要越界）
- ❌ 不要 claim / complete 任务板上的 ${taskId}（那是给 P1 全程 agent 的；你只做 P0）
- ❌ 不要提交不确定的 flag；不要改插件源码；不要动别人的题目目录

## 收尾（必做）
1. 确认 ${prepFile} 与脚本都在 ${dir}/ 下；
2. 用 \`send_message\` 给 \`lead\` 发一条**一句话汇报**：
   \`#${id} ${challenge?.name ?? ''} 已就绪，等环境（PREP.md 已写，脚本：<文件名>，一句话结论：…）\`
   并**同时**用 \`ctf_team_log\` 落一条（用户会在「协同通信」里看到谁把哪道题准备到哪一步）：
   \`kind="progress" challengeId=${id}\`，正文写「PREP 完成 + 一句话结论 + 脚本名」。
3. 然后**结束本轮**。Lead 或下一轮 \`ctf_solve_start\` 会在环境空出后接手 P1
   （有 PREP.md 的题会**优先**拿到配额）。

验收标准：${prepFile} 存在且内容具体（含 P1 计划），${dir}/ 下至少有一个可直接运行的脚本。`

  return [
    { type: 'text', text: reminder },
    { type: 'text', text: body },
  ]
}

// ---------------------------------------------------------------- 小工具

function resolveConcurrency(value, fallback) {
  const base = Number(fallback)
  const fallbackValue =
    Number.isFinite(base) && base >= 1 ? Math.min(LIMITS.maxConcurrency, Math.floor(base)) : LIMITS.defaultConcurrency
  const n = Number(value)
  if (value == null || value === '' || !Number.isFinite(n) || n < 1) return fallbackValue
  return Math.min(LIMITS.maxConcurrency, Math.floor(n))
}

/**
 * 解析 limit：缺省 = 全部选中题目（共享任务板即完整队列），硬上限 `LIMITS.maxLimit`（200）。
 * 显式传值时按传入值截断。并发只由 `concurrency` 控制，与 limit 无关。
 */
function resolveLimit(value) {
  const n = Number(value)
  if (value == null || value === '' || !Number.isFinite(n) || n < 1) return LIMITS.maxLimit
  return Math.min(LIMITS.maxLimit, Math.floor(n))
}

function errorText(error) {
  return `${error?.code ?? ''} ${error?.message ?? error ?? ''}`.trim()
}

/** 名字被占用（DSH 名字永久占用，需要换名重试）。 */
function isNameConflict(error) {
  return /TEAM_MEMBER_NAME_TAKEN|TEAM_INVALID_MEMBER_NAME|already used|already exists|invalid member name/i.test(
    errorText(error),
  )
}

/** 成员数量上限（换名字也没用，直接停止 spawn）。 */
function isMemberLimit(error) {
  return /TEAM_MEMBER_LIMIT|member limit/i.test(errorText(error))
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-'
}

/**
 * work 记录是否表示「这道题起过环境」。
 *
 * ⚠️ 「任务在进行中」**不等于**「有环境」：附件题（凌虚 `task_type=2`）没有环境，
 * 对它们调平台 release 会返回 400「该题目没有选择对应的环境」。判断依据只能来自
 * `ctf_start_env` 写下的 work 字段（`envStarted` / `connectionInfo`）。
 */
function envRecordStarted(record) {
  if (!record) return false
  return record.envStarted === true || Boolean(record.connectionInfo ?? record.connection)
}

function fmtTaskStatus(status) {
  const map = { pending: '待认领', in_progress: '进行中', completed: '已完成', deleted: '已删除' }
  return map[status] ?? String(status ?? '未知')
}

/**
 * 从「键: 值」里读出 challengeId 值 —— **手写扫描，不用脆弱正则**。
 *
 * 规则（与 `buildTaskDescription` 的契约行对齐）：
 * - 行首可有空白 / 列表符号（`-` `*` `•` `>` `#`）或有序列表前缀（`1.` `2、`）；
 * - 键必须是行内**第一个词**，忽略大小写等于 `challengeId`；
 * - 键后允许空白，然后必须是 `:` / `：` / `=` 之一；
 * - 值取随后的连续 `[A-Za-z0-9_-]`（到空白、全角括号等为止），空值视为没解析到。
 *
 * @param {string} line 单行文本
 * @returns {string|null}
 */
function challengeIdFromLine(line) {
  const text = String(line ?? '')
  let i = LINE_PREFIX_RE.exec(text)?.[0].length ?? 0
  // 有序列表前缀（`1. ` / `2、` / `3)`）也要跳过
  const ordered = /^\d+\s*[.、)]\s*/.exec(text.slice(i))
  if (ordered) i += ordered[0].length
  if (text.slice(i, i + CHALLENGE_ID_KEY.length).toLowerCase() !== CHALLENGE_ID_KEY) return null

  let j = i + CHALLENGE_ID_KEY.length
  while (j < text.length && /\s/.test(text[j])) j += 1
  if (!KEY_VALUE_SEPARATORS.has(text[j])) return null
  j += 1
  while (j < text.length && /\s/.test(text[j])) j += 1

  let end = j
  while (end < text.length && ID_VALUE_RE.test(text[end])) end += 1
  const value = text.slice(j, end)
  return value || null
}

/**
 * 解析任务/文本里的 challengeId（契约见文件头）。
 *
 * 先**逐行**找独立行（`challengeId: 12`），找不到再退化为「行内提及」扫描
 * （例如 teammate description 的 `（100分，challengeId=1）`）。
 * 任何畸形输入都返回 `null`，绝不抛异常。
 *
 * @param {unknown} text
 * @returns {string|null} 解析出的 id 原始 token（调用方决定转数字还是保留字符串）
 */
export function parseChallengeId(text) {
  const raw = String(text ?? '')
  if (!raw) return null
  const lines = raw.split(/\r?\n/)

  for (const line of lines) {
    const value = challengeIdFromLine(line)
    if (value) return value
  }

  // 兜底：行内提及。要求 `challengeId` 前面是词边界（免把 `mychallengeId` 当命中）。
  const lower = raw.toLowerCase()
  const boundary = /[\s\-–—*•#>（(【\[,，;；|\/]/
  let from = 0
  for (;;) {
    const idx = lower.indexOf(CHALLENGE_ID_KEY, from)
    if (idx < 0) return null
    from = idx + CHALLENGE_ID_KEY.length
    if (idx > 0 && !boundary.test(raw[idx - 1])) continue
    let j = idx + CHALLENGE_ID_KEY.length
    while (j < raw.length && /\s/.test(raw[j])) j += 1
    if (!KEY_VALUE_SEPARATORS.has(raw[j])) continue
    j += 1
    while (j < raw.length && /\s/.test(raw[j])) j += 1
    let end = j
    while (end < raw.length && ID_VALUE_RE.test(raw[end])) end += 1
    const value = raw.slice(j, end)
    if (value) return value
  }
}

/**
 * 从 writeScope 反解 challengeId（旧任务 / 外部建的任务可能没有契约行）。
 * @param {unknown} scopes
 * @returns {string|null}
 */
export function challengeIdFromScope(scopes) {
  for (const scope of Array.isArray(scopes) ? scopes : []) {
    const match = SCOPE_ID_RE.exec(String(scope ?? ''))
    if (match) return match[1]
  }
  return null
}

/**
 * 解析任务 subject（`[<分类>] <题名> (<分值>分)`）。
 * 解析不出的字段填 null；subject 被截断时尽量保留已解析到的部分。
 *
 * @param {unknown} subject
 * @returns {{ category: string|null, name: string|null, score: number|null }}
 */
export function parseTaskSubject(subject) {
  const text = String(subject ?? '').trim()
  const result = { category: null, name: null, score: null }
  if (!text) return result

  let rest = text
  const bracket = /^\[([^\]]*)\]\s*/.exec(rest)
  if (bracket) {
    result.category = bracket[1].trim() || null
    rest = rest.slice(bracket[0].length)
  }
  const score = /\(\s*(\d+)\s*分?\s*\)\s*$/.exec(rest)
  if (score) {
    result.score = Number(score[1])
    rest = rest.slice(0, score.index)
  }
  result.name = rest.trim() || null
  return result
}

/** teammate description（契约见文件头）：单点生成，避免格式散落多处。 */
export function buildMemberDescription(challenge) {
  const category = String(challenge?.category ?? '').trim() || '未分类'
  const name = String(challenge?.name ?? '').trim()
  const score = Number(challenge?.score ?? 0)
  return `解题 teammate：${category}/${name}（${score}分，challengeId=${safeId(challenge?.id)}）`.slice(0, 200)
}

/**
 * 离线准备 agent 的 description。
 *
 * ⚠️ 与 `buildMemberDescription` 保持**同一份可解析契约**（都是
 * `<角色> teammate：<分类>/<题名>（<分值>分，challengeId=<id>…）`），
 * `parseMemberDescription()` 因此不需要改（它取第一个冒号后的片段 + challengeId 的 token）。
 */
export function buildPrepMemberDescription(challenge) {
  const category = String(challenge?.category ?? '').trim() || '未分类'
  const name = String(challenge?.name ?? '').trim()
  const score = Number(challenge?.score ?? 0)
  return `准备 teammate（等环境配额）：${category}/${name}（${score}分，challengeId=${safeId(challenge?.id)}）`.slice(0, 200)
}

/**
 * 解析 teammate description → 题目信息（用于 `/lingxu-ctf/team` 里把成员映射到题目）。
 * 解析不到就填 null；`challengeId` 走 `parseChallengeId`。
 *
 * 契约格式：`解题 teammate：<分类>/<题名>（<分值>分，challengeId=<id>）`
 *
 * @param {unknown} description
 * @returns {{ challengeId: string|null, category: string|null, challengeName: string|null, score: number|null }}
 */
export function parseMemberDescription(description) {
  const text = String(description ?? '').trim()
  const result = {
    challengeId: parseChallengeId(text),
    category: null,
    challengeName: null,
    score: null,
  }
  if (!text) return result

  const score = /（?\s*(\d+)\s*分/.exec(text)
  if (score) result.score = Number(score[1])

  // 取第一个冒号之后的片段，截到全角/半角左括号之前 → `<分类>/<题名>`
  const colon = text.search(/[:：]/)
  if (colon >= 0) {
    const rest = text.slice(colon + 1).split(/[（(]/, 1)[0].trim()
    const slash = rest.indexOf('/')
    if (slash > 0) {
      result.category = rest.slice(0, slash).trim() || null
      result.challengeName = rest.slice(slash + 1).trim() || null
    } else if (rest) {
      result.challengeName = rest
    }
  }
  return result
}

// ---------------------------------------------------------------- 编排器

/**
 * @param {{
 *  config?: object,
 *  store?: object,
 *  resolveAdapter?: (args: object) => Promise<{ adapter: object, connection: object }>,
 *  teams?: object,
 *  logger?: { info?: Function, warn?: Function, error?: Function },
 *  now?: () => number,
 * }} deps
 * @returns {{ start: Function, status: Function, stop: Function }}
 */
export function createOrchestrator(deps = {}) {
  const config = deps.config ?? {}
  const store = deps.store ?? null
  const resolveAdapter = deps.resolveAdapter
  const teams = deps.teams ?? null
  const logger = deps.logger ?? silentLogger
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  const configuredWorkDir = String(config.workDir ?? DEFAULT_WORK_DIR).replace(/\/+$/, '') || DEFAULT_WORK_DIR
  /**
   * 当前生效的工作目录。
   *
   * `ctf_solve_start` 会把会话 cwd 解析出的绝对路径通过 `args.workDir` 传进来
   * （`exec.cwd` / `exec.agent.session.header.cwd`），赋值给这个变量后：
   * - teammate prompt 里的目录是绝对路径 → 无论 teammate 自己的 cwd 是什么都写到用户工作区 ✓
   * - PREP.md 的存在性检查也看同一处 ✓
   * 不传时才退回配置值（测试里是相对的 `lingxu-ctf-work`）。
   */
  let workDir = configuredWorkDir
  /** 允许注入（测试可替身）；默认用 node:fs 的 existsSync —— 只看「有没有文件」，不读内容。 */
  const fileExists = typeof deps.existsSync === 'function' ? deps.existsSync : defaultExistsSync

  /** P0 完成标记（软信号）：`<题目目录>/PREP.md` 是否存在。任何 IO 异常都当作「没有」。 */
  function prepExists(challenge) {
    if (!challenge?.id) return false
    try {
      return fileExists(prepFileFor(challenge, workDir)) === true
    } catch {
      return false
    }
  }

  /** 本会话最近一次 `ctf_solve_*` 调用者（= Team Lead 身份），供 /lingxu-ctf/team 读取团队数据。 */
  let sessionCaller = null
  /** 装配层注入的会话身份槽（index.js 的 withSessionCapture 会写它）。 */
  const sessionRef = deps.session && typeof deps.session === 'object' ? deps.session : null
  /** 上一条团队消息正文：连续重复（例如反复轮询 status）不再落盘，避免刷掉真正的汇报。 */
  let lastTeamMessage = ''
  /**
   * 从 DSH 报错里学到的真实 teammate 上限（`Team member limit 8 reached`）。
   * 优先级最高 —— 报错就是 DSH 实际执行的值（配置可能在我们读完之后又被改）。
   */
  let learnedTeamLimit = null

  function log(level, message) {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, `[lingxu-ctf] ${message}`)
    } catch {
      /* 日志失败不影响编排 */
    }
  }

  function stamp() {
    try {
      return new Date(now()).toISOString()
    } catch {
      return 'unknown-time'
    }
  }

  /** teams 缺失/不完整时给出可操作的清晰报错（按各操作实际用到的方法校验）。 */
  function requireTeams(methods = []) {
    if (!teams) {
      throw new Error(
        'Agent Teams 不可用：ctx.agentTeams 未挂载。请确认 desktop profile 已启用 ' +
          '@deepseek-ai/dsh-experimental-agent-team（bundle: dsh-experimental-agent-team-profile）后重启 DSH，再重试。',
      )
    }
    const missing = methods.filter((method) => typeof teams[method] !== 'function')
    if (missing.length) {
      throw new Error(`Agent Teams 接口不完整：ctx.agentTeams 缺少 ${missing.join(', ')}（DSH 版本可能不匹配）。`)
    }
    return teams
  }

  /**
   * callerAgent 只能来自 exec.agent（index.js / tools.js 必须塞进 args.__agent）。
   * 兼容 `__agent` / `callerAgent` / `caller` / `agent` 几种键名，避免装配层命名不一致直接不可用。
   *
   * 副作用：把最近一次成功解析出的 caller 记下来 —— `ctf_solve_*` 是 Lead 专用，
   * 所以这个身份就是**本会话的 Team Lead**，`GET /lingxu-ctf/team` 用它读任务板/名单
   * （HTTP 路由没有 exec，只能靠这里捕获的会话语境）。
   */
  function requireCaller(args) {
    const agent = args?.__agent ?? args?.callerAgent ?? args?.caller ?? args?.agent
    if (!agent) {
      throw new Error(
        '该操作需要在会话内由 Lead agent 调用：缺少 callerAgent。' +
          '工具层必须把 exec.agent 作为 args.__agent 传进来（lib/tools.js 的 ctf_solve_* spec.execute(args, exec)）。',
      )
    }
    sessionCaller = agent
    if (sessionRef) sessionRef.caller = agent
    return agent
  }

  /** spawn 需要真实 AbortSignal（DSH 内部 AbortSignal.any 会对 undefined 抛 TypeError）。 */
  function resolveSignal(args) {
    const signal = args?.__signal ?? args?.signal
    return signal instanceof AbortSignal ? signal : new AbortController().signal
  }

  /**
   * 解析平台连接。
   *
   * 顺手把当前连接记进 store（`noteActiveConnection`）——
   * submissions 的默认过滤、`ctf_status` 的「当前赛事」都靠它，切赛事后数据自动跟着变。
   */
  async function resolvePlatform(args) {
    if (typeof resolveAdapter !== 'function') {
      throw new Error('编排器缺少 resolveAdapter 依赖（index.js 未注入），无法解析平台连接。')
    }
    let result
    try {
      result = await resolveAdapter({ ...args })
    } catch (error) {
      throw new Error(`解析平台连接失败：${error?.message ?? error}`)
    }
    const adapter = result?.adapter
    if (!adapter || typeof adapter.challenges !== 'function') {
      throw new Error('resolveAdapter 未返回可用适配器（期望 { adapter, connection }）。')
    }
    const connection = result?.connection ?? {}
    const connKey = connKeyOf(connection)
    try {
      if (store && typeof store.noteActiveConnection === 'function') await store.noteActiveConnection(connKey)
    } catch (error) {
      log('warn', `记录当前赛事失败（不影响编排）：${error?.message ?? error}`)
    }
    return { adapter, connection, connKey }
  }

  function connKeyOf(connection) {
    if (connection?.key) return String(connection.key)
    try {
      return connectionKey(connection ?? {})
    } catch {
      return 'unknown'
    }
  }

  async function rememberWork(connKey, challengeId, patch) {
    if (!store || typeof store.upsertChallengeWork !== 'function') return
    try {
      await store.upsertChallengeWork(connKey, challengeId, patch)
    } catch (error) {
      log('warn', `写入解题进度失败（challenge ${challengeId}）：${error?.message ?? error}`)
    }
  }

  async function readWork(connKey) {
    if (!store || typeof store.listChallengeWork !== 'function') return []
    try {
      const rows = await store.listChallengeWork(connKey)
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      log('warn', `读取解题进度失败：${error?.message ?? error}`)
      return []
    }
  }

  /**
   * 团队消息落盘用的连接 key：显式 connKey 优先，其次当前活动连接，最后退化为 `unknown`。
   * `unknown` 桶也能被 `/lingxu-ctf/team` 在「没有平台连接」时读到（listTeamMessages 省略 key = 全量）。
   */
  async function messageConnKey(connKey) {
    if (connKey) return String(connKey)
    try {
      if (typeof store?.resolveConnection === 'function') {
        const conn = await store.resolveConnection({})
        if (conn?.key) return String(conn.key)
      }
    } catch {
      /* 没有连接也要能记消息 */
    }
    return 'unknown'
  }

  /**
   * 记录一条 agent 团队协同消息（`ctf_solve_start` → spawn / `ctf_solve_status` → status /
   * `ctf_solve_stop` → stop）。store 未注入 / 不支持时静默跳过，绝不影响编排本身。
   *
   * 去抖：与上一条正文完全相同时不重复落盘（用户反复轮询 status 时不会把 500 条 FIFO 刷满）。
   */
  async function logTeamMessage(kind, text, connKey) {
    if (!store || typeof store.appendTeamMessage !== 'function') return
    const body = String(text ?? '').trim()
    if (!body || body === lastTeamMessage) return
    try {
      await store.appendTeamMessage(await messageConnKey(connKey), {
        from: 'lead',
        to: 'team',
        kind,
        text: body,
        at: stamp(),
      })
      lastTeamMessage = body
    } catch (error) {
      log('warn', `记录团队消息失败（${kind}）：${error?.message ?? error}`)
    }
  }

  /** 尝试解析当前连接 key（只读本地 store，不产生网络请求）；失败返回 null。 */
  async function tryConnKey(args) {
    try {
      const platform = await resolvePlatform(args)
      return platform.connKey
    } catch {
      return null
    }
  }

  /**
   * 当前生效的 teammate 上限 + 来源：**报错自学习 > 运行时配置 > 默认值**。
   * DSH 语义：maxMembers **不含 lead**（roster.js 用 `state.members.length >= maxMembers` 判定）。
   */
  function teamLimitState() {
    if (Number.isFinite(learnedTeamLimit) && learnedTeamLimit >= 1) {
      return { limit: Math.floor(learnedTeamLimit), source: '报错自学习' }
    }
    return resolveTeamLimitWithSource(teams, LIMITS.maxTeamMembers)
  }

  /** listMembers 是只读信息，失败不致命（降级为空名单）。 */
  async function safeListMembers(api, caller) {
    try {
      const rows = await api.listMembers(caller)
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      log('warn', `listMembers 失败：${error?.message ?? error}`)
      return []
    }
  }

  async function safeListTasks(api, caller) {
    try {
      const rows = await api.listTasks(caller)
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      log('warn', `listTasks 失败：${error?.message ?? error}`)
      return []
    }
  }

  /** 任务板上仍活跃（未完成/未删除）的题目 id —— 用于 start 幂等去重。 */
  /**
   * 任务板 + work 记录 → 「谁已有任务」「谁已有 agent」。
   *
   * 占用 = 任务 `in_progress` 或 work 记录里已有 teammate。
   * 只看「任务是否在板上」会把「已建任务但没派 agent」也算占用 —— 那种题必须能在下一轮
   * 被补派（环境配额满而暂缓的环境题、并发满而排队的一般题都靠它）。
   * 建任务去重仍用 `boardedIds`（有未完成任务就不再建第二个）。
   */
  async function readBoardState(api, caller, connKey) {
    const tasks = await safeListTasks(api, caller)
    const work = await readWork(connKey)
    const boardedIds = new Set()
    const inProgressIds = new Set()
    const teammateIds = new Set()
    const taskByChallenge = new Map()
    const workByChallenge = new Map()

    for (const record of work) {
      if (record?.challengeId == null) continue
      const key = String(record.challengeId)
      const previous = workByChallenge.get(key)
      if (!previous || String(record.updatedAt ?? '') >= String(previous.updatedAt ?? '')) {
        workByChallenge.set(key, record)
      }
      if (record?.teammate) teammateIds.add(key)
    }

    for (const task of tasks) {
      if (task?.status === 'completed' || task?.status === 'deleted') continue
      const cid = parseChallengeId(task?.description) ?? challengeIdFromScope(task?.writeScopes)
      if (!cid) continue
      const key = String(cid)
      boardedIds.add(key)
      if (!taskByChallenge.has(key)) taskByChallenge.set(key, task) // 最早那个未完成任务
      if (task?.status === 'in_progress') inProgressIds.add(key)
    }

    // 「已有 agent」= 任务被认领，或「有 teammate 且任务还没完成」。
    // 任务已完成（或已删除）的题视为可重跑：work 记录里的 teammate 是历史，不再算占用。
    const assignedIds = new Set(inProgressIds)
    for (const id of teammateIds) if (boardedIds.has(id)) assignedIds.add(id)

    return { tasks, work, boardedIds, assignedIds, inProgressIds, taskByChallenge, workByChallenge }
  }

  /**
   * 环境上限（用户零配置）：
   * 1. `config.envLimit`（若显式配了就用它，保留兼容）；
   * 2. **平台实测**：`ctf_start_env` 撞上限时把平台报错里的 N 写进 work 记录（`envLimitObserved`）；
   * 3. 平台源码默认值 2（`CompetitionCTFs.env_limit` default）。
   */
  async function resolveEnvLimit(workRecords) {
    const configured = clampEnvLimit(config.envLimit)
    if (configured != null) return { limit: configured, source: 'config.envLimit' }
    let observed = null
    for (const record of Array.isArray(workRecords) ? workRecords : []) {
      const value = clampEnvLimit(record?.envLimitObserved)
      if (value != null) observed = observed == null ? value : Math.max(observed, value)
    }
    if (observed != null) return { limit: observed, source: '平台实测（env-limit 报错文案）' }
    return { limit: LIMITS.defaultEnvLimit, source: `平台默认 ${LIMITS.defaultEnvLimit}` }
  }

  /** 当前正被占用的环境（work 记录里 envStarted 且未释放、且未到自动释放时间）。 */
  function heldEnvIds(workRecords, nowMs) {
    const ids = new Set()
    for (const record of Array.isArray(workRecords) ? workRecords : []) {
      if (record?.challengeId == null) continue
      if (envHeld(record, nowMs)) ids.add(String(record.challengeId))
    }
    return ids
  }

  /**
   * 判定题型（1 环境型 / 2 外链型 / 3 附件型）。
   *
   * 平台的**列表接口没有 `task_type`**（`CompetitionCTFSerializer.Meta.fields` 里没有），
   * 只有 `/ctf/<id>/info/` 有。所以：
   *  1. 本轮缓存 → 2. work 记录（`ctf_challenge` / 上次探测回写过）→ 3. 探测一次详情并回写缓存。
   * 探测失败返回 `null`（当作非环境题处理：宁可派出去让 `ctf_start_env` 报错自学习，也不要空转）。
   */
  const typeCache = new Map()
  async function classifyChallenge(adapter, connKey, challenge, workByChallenge) {
    const key = `${connKey}:${challenge?.id}`
    if (typeCache.has(key)) return typeCache.get(key)
    const cached = Number(workByChallenge?.get(String(challenge?.id))?.taskType)
    if (Number.isFinite(cached) && cached >= 1 && cached <= 3) {
      typeCache.set(key, cached)
      return cached
    }
    if (typeof adapter?.challengeDetail !== 'function') {
      typeCache.set(key, null)
      return null
    }
    try {
      const detail = await adapter.challengeDetail(challenge.id)
      const type = Number(detail?.taskType)
      const value = Number.isFinite(type) && type >= 1 && type <= 3 ? type : null
      typeCache.set(key, value)
      if (value != null) {
        // 顺带缓存 answerMode / flagType（同样只有详情接口有，工具层判断 check 模式要用）
        await rememberWork(connKey, safeId(challenge.id), {
          taskType: value,
          taskTypeLabel: detail?.taskTypeLabel ?? undefined,
          flagType: detail?.flagType ?? undefined,
          answerMode: detail?.answerMode ?? undefined,
          requiresEnv: value === 1,
          detailFetchedAt: stamp(),
        })
      }
      return value
    } catch (error) {
      log('warn', `题型探测失败（challenge ${challenge?.id}）：${error?.message ?? error}`)
      typeCache.set(key, null)
      return null
    }
  }

  /** 小并发映射（探测详情用；不引入依赖）。 */
  async function mapWithConcurrency(items, size, worker) {
    const list = Array.isArray(items) ? items : []
    const results = new Array(list.length)
    let cursor = 0
    const width = Math.max(1, Math.min(Number(size) || 1, list.length || 1))
    await Promise.all(
      Array.from({ length: width }, async () => {
        for (;;) {
          const index = cursor
          cursor += 1
          if (index >= list.length) return
          results[index] = await worker(list[index], index)
        }
      }),
    )
    return results
  }

  /**
   * 环境感知和两阶段派发计划。
   *
   * 三档：
   * 1. **非环境题**（附件型/外链型）→ 派「全程 agent」，**不限量**（只受并发槽约束）；
   * 2. **环境题 + 配额有空** → 派「全程 agent」（P0+P1）；
   * 3. **环境题 + 配额已满** → 派「**离线准备 agent**」（只做 P0：读题/逆向/写 exp/搭复现）。
   *
   * 关键约束：
   * - 准备 agent **不吃环境配额，但吃并发槽**（teammate 上限）→ `准备数 = min(剩余槽, 需要准备的题数)`；
   * - 已经有 `PREP.md`（P0 完成）或已有准备 agent 在跑的题**不会重复派准备 agent**，
   *  它们进「就绪待环境 / 准备中」队列，等配额释放时按 `scoreChallenge` 优先拿全程 agent；
   * - 题型按需探测（最多 `maxEnvProbes` 个，结果回写 work 记录，后续轮次零请求）；
   * - 派发顺序 = 非环境题优先 → `scoreChallenge` 降序（环境型降权、PREP.md 升权、解出人数升权）。
   *
   * @returns {{
   *  picks: Array<{challenge: object, taskType: number|null, mode: 'full'|'prep', hasPrep: boolean, priority: number}>,
   *  fullPicks: object[], prepPicks: object[],
   *  readyWaiting: object[], prepping: object[], envDeferred: object[], slotDeferred: object[], deferred: object[],
   *  probed: number, types: Map<string, number|null>,
   * }}
   */
  async function planSpawns({ adapter, connKey, candidates, slots, envBudget, workByChallenge, prepStateOf }) {
    const ordered = Array.isArray(candidates) ? candidates : []
    const rows = []
    const types = new Map()
    let probed = 0
    let cursor = 0

    // 题型探测：列表接口没有 task_type，只探「可能本轮要派的窗口」（≤ maxEnvProbes）
    const probeTarget = Math.min(ordered.length, LIMITS.maxEnvProbes)
    while (cursor < ordered.length && probed < probeTarget) {
      const left = probeTarget - probed
      const batch = ordered.slice(cursor, cursor + Math.min(LIMITS.envProbeConcurrency, left))
      if (!batch.length) break
      cursor += batch.length
      probed += batch.length
      const batchTypes = await mapWithConcurrency(batch, LIMITS.envProbeConcurrency, (challenge) =>
        classifyChallenge(adapter, connKey, challenge, workByChallenge),
      )
      for (let index = 0; index < batch.length; index += 1) {
        const challenge = batch[index]
        const taskType = batchTypes[index] ?? null
        types.set(String(challenge?.id), taskType)
        const state = prepStateOf ? prepStateOf(challenge) : { hasPrep: false, prepping: false }
        rows.push({
          challenge,
          taskType,
          hasPrep: state?.hasPrep === true,
          prepping: state?.prepping === true,
          priority: scoreChallenge(challenge, { taskType, hasPrep: state?.hasPrep === true }),
        })
      }
    }

    const picks = []
    const readyWaiting = []
    const preppingRows = []
    const envDeferred = []
    const slotDeferred = []
    let slotsLeft = Math.max(0, slots)
    let budget = Math.max(0, envBudget)

    for (const row of orderForSpawn(rows)) {
      const envTask = isEnvType(row.taskType)
      if (!envTask) {
        // 档 1：非环境题不限量（只受并发槽约束）
        if (slotsLeft > 0) {
          picks.push({ ...row, mode: 'full' })
          slotsLeft -= 1
        } else {
          slotDeferred.push(row)
        }
        continue
      }
      // 档 2：环境题 + 配额有空 → 全程 agent
      // ⚠️ 正在做 P0 的题（prepping）先让准备 agent 做完：同一道题派两个 agent 会撞目录/重复劳动
      if (budget > 0 && slotsLeft > 0 && !row.prepping) {
        picks.push({ ...row, mode: 'full' })
        slotsLeft -= 1
        budget -= 1
        continue
      }
      // 档 3：环境题 + 配额满 → 离线准备 agent（已有准备/已就绪的不重复派）
      if (slotsLeft > 0 && !row.hasPrep && !row.prepping) {
        picks.push({ ...row, mode: 'prep' })
        slotsLeft -= 1
        continue
      }
      if (row.hasPrep) readyWaiting.push(row)
      else if (row.prepping) preppingRows.push(row)
      else envDeferred.push(row)
    }

    const pickedIds = new Set(picks.map((pick) => String(pick.challenge?.id)))
    const deferred = ordered.filter((challenge) => !pickedIds.has(String(challenge?.id)))
    return {
      picks,
      fullPicks: picks.filter((pick) => pick.mode === 'full').map((pick) => pick.challenge),
      prepPicks: picks.filter((pick) => pick.mode === 'prep').map((pick) => pick.challenge),
      readyWaiting: readyWaiting.map((row) => row.challenge),
      prepping: preppingRows.map((row) => row.challenge),
      envDeferred: envDeferred.map((row) => row.challenge),
      slotDeferred: slotDeferred.map((row) => row.challenge),
      deferred,
      probed,
      types,
    }
  }

  /**
   * 把一个闲置槽复用到新题：
   * 1. `sendMessage` 唤醒 inactive 的 teammate（DSH 语义：inactive target starts or resumes a turn）；
   * 2. 迁移 work 记录：旧题标 `reassignedTo` 并把 `teammate` 清空（旧题因此重新可派），新题记 `reassignedFrom`。
   *
   * ⚠️ 不 rename：DSH 名字永久占用，改名只会白烧名额。
   */
  async function reuseSlot({
    slot, entry, api, caller, args, connection, connKey, workDir, envLimit, heldEnvs, taskTypeOf, challengeById,
  }) {
    const previousId = String(slot.previousId)
    const previous = challengeById?.get(previousId) ?? { id: previousId, name: slot.previousSubject }
    try {
      const sameTask = previousId === String(entry.challenge?.id)
      const payload = {
        name: slot.name,
        challenge: entry.challenge,
        taskId: entry.taskId,
        connection,
        connKey,
        workDir,
        envLimit,
        envHeld: heldEnvs.size,
        taskType: taskTypeOf(entry.challenge),
        mode: entry.mode,
      }
      await api.sendMessage(caller, {
        target: slot.name,
        // 同一道题被中断后重新派回 → 「重启」而不是「换题」（别让它丢掉已有成果）
        content: sameTask
          ? buildResumePrompt(payload)
          : buildReassignPrompt({ ...payload, previousId, previous }),
        signal: resolveSignal(args),
      })
    } catch (error) {
      return { ok: false, message: error?.message ?? String(error) }
    }
    // 旧题：标记「已换题」并清掉 teammate（否则旧题会被 readBoardState 判成「已有 agent」，永远派不出去）
    await rememberWork(connKey, safeId(previousId), {
      status: 'reassigned',
      teammate: '',
      slotOwner: slot.name,
      previousTeammate: slot.name,
      reassignedTo: String(entry.challenge.id),
      reassignedAt: stamp(),
    })
    await rememberWork(connKey, safeId(entry.challenge.id), {
      status: entry.mode === 'prep' ? 'prep' : 'solving',
      ...(entry.mode === 'prep'
        ? { prepTeammate: slot.name, prepStartedAt: stamp() }
        : { teammate: slot.name }),
      taskId: entry.taskId,
      reassignedFrom: previousId,
      reassignedAt: stamp(),
    })
    return { ok: true }
  }

  // -------------------------------------------------------------- start

  async function start(args = {}) {
    const api = requireTeams(['spawnTeammate', 'createTask', 'listTasks', 'listMembers'])
    const caller = requireCaller(args)
    const concurrency = resolveConcurrency(args.concurrency, config.concurrency)
    /**
     * 本次编排用的工作目录：优先用工具传进来的绝对路径
     * （`ctf_solve_start` 从会话 cwd 解析：`exec.cwd` / `exec.agent.session.header.cwd`），
     * 否则退回闭包里的配置值。**绝对路径会写进 teammate 的 prompt** ——
     * teammate 可能不在同一个 cwd，相对路径会让它写到插件目录去（用户报的「没写进工作区」）。
     */
    const sessionWorkDir = String(args.workDir ?? '').trim()
    if (sessionWorkDir) workDir = sessionWorkDir.replace(/\/+$/, '') || configuredWorkDir
    // Agent 池默认开启；sendMessage 不可用时退回每题新 agent。
    const reuseEnabled = config.reuseAgents !== false && typeof api.sendMessage === 'function'
    const limit = resolveLimit(args.limit)
    const { adapter, connection, connKey } = await resolvePlatform(args)

    // 前置探活：session 失效时立刻停手，不建任务、不 spawn。
    // 失效时若照常编排，N 个 agent 会一起撞 403，提交的 flag 直接丢失。
    const probe = await probeSession(adapter)
    if (probe.sessionExpired) {
      log('warn', 'sessionid 已失效：已拒绝 ctf_solve_start（未建任务、未拉起 agent）')
      await logTeamMessage('spawn', SESSION_EXPIRED_BANNER, connKey)
      return sessionExpiredStartText(connection?.baseUrl)
    }

    let allChallenges
    try {
      allChallenges = await adapter.challenges()
    } catch (error) {
      throw new Error(`拉取题目列表失败：${error?.message ?? error}`)
    }
    const candidates = selectChallenges(allChallenges, {
      ...args,
      includeSolved: args.includeSolved === true || args.onlyUnsolved === false, // tools.js 传 onlyUnsolved
      limit: undefined,
    })

    // 任务板 / work 记录：区分「已有任务」（避免重复建任务）与「已有 agent」（避免重复起 agent）。
    // ⚠️ force=true 只是**无视任务板占用**（重新建任务、重新起 agent），但 work 记录仍要读：
    //    题型缓存与「当前已占用环境数」都在里面。
    const board = await readBoardState(api, caller, connKey)
    if (args.force === true) {
      board.boardedIds = new Set()
      board.assignedIds = new Set()
      board.taskByChallenge = new Map()
    }
    const skipped = candidates.filter((challenge) => board.assignedIds.has(String(challenge.id)))
    const selected = candidates
      .filter((challenge) => !board.assignedIds.has(String(challenge.id)))
      .slice(0, limit)
    if (!selected.length) {
      if (skipped.length) {
        return [
          '## 无需编排：题目都已有 agent 在做',
          '',
          `符合条件的 ${candidates.length} 道题目全部已被 agent 接管（任务 in_progress 或 work 记录里有 teammate），已跳过，避免重复建任务、重复起 agent：`,
          ...skipped.map((challenge) => `- ${taskSubjectFor(challenge)}（challengeId=${safeId(challenge.id)}）`),
          '',
          '如需强制重跑（例如上一轮 agent 已死），请传 force=true；想补派排队中的题目请先释放环境/等 agent 结束。',
        ].join('\n')
      }
      return [
        '## 无需编排',
        '',
        `平台 ${connection?.platform ?? 'lingxu'} ${connection?.baseUrl ?? ''}（eventId=${connection?.eventId ?? '-'}）`,
        '没有符合条件（未解 / 分类 / 最低分值 / challengeIds）的题目，未创建任务、未拉起 agent。',
        '如需重跑已解题目，请传 includeSolved=true（工具层等价参数：onlyUnsolved=false）。',
      ].join('\n')
    }

    // 1) 建共享任务（**已有未完成任务的题直接复用**：排队/补派时不能重复建任务）
    const entries = []
    const taskFailures = []
    let reusedTasks = 0
    for (const challenge of selected) {
      const cid = String(challenge.id)
      const slug = memberSlug(challenge) // teammate 名用 ASCII slug
      const writeScope = writeScopeFor(challenge) // 路径用 pathSlug（保留中文）
      const subject = taskSubjectFor(challenge)
      const existing = board.taskByChallenge.get(cid)
      if (existing) {
        reusedTasks += 1
        entries.push({
          challenge, slug, writeScope, subject,
          taskId: existing.id ?? null, revision: existing.revision ?? 1, reused: true,
        })
        continue
      }
      try {
        const task = await api.createTask(caller, {
          subject,
          description: buildTaskDescription({ challenge, connection, connKey }),
          writeScopes: [writeScope],
        })
        entries.push({ challenge, slug, writeScope, subject, taskId: task?.id ?? null, revision: task?.revision ?? 1 })
        await rememberWork(connKey, safeId(challenge.id), {
          challengeId: String(challenge.id),
          taskId: task?.id ?? null,
          taskCreatedAt: stamp(), // 任务板本身没有时间戳字段，/lingxu-ctf/team 用它填 createdAt
          subject,
          slug,
          writeScope,
          status: 'queued',
        })
      } catch (error) {
        const message = error?.message ?? String(error)
        taskFailures.push({ challenge, message })
        log('warn', `创建任务失败（${challenge?.name}）：${message}`)
      }
    }

    if (!entries.length) {
      return [
        '## 编排失败：任务一个都没建出来',
        '',
        `候选题目 ${selected.length} 道，全部 createTask 失败：`,
        ...taskFailures.map((f) => `- ${f.challenge?.name}：${f.message}`),
      ].join('\n')
    }

    // 2) 计算本轮能拉起几个 agent，并做**环境感知 + 两阶段**的派发计划
    const members = await safeListMembers(api, caller)
    const memberByName = new Map(members.map((member) => [String(member?.name ?? ''), member]))
    const used = new Set(members.map((member) => String(member?.name ?? '')))
    const teammates = members.filter((member) => member?.role !== 'lead' && member?.name !== 'lead')
    const busy = teammates.filter((m) => m.status === 'running' || m.status === 'provisioning').length
    // 真实上限（agentTeams 运行时配置 → 报错自学习 → 默认 16），**不含 lead**：
    // DSH 判定是 `state.members.length >= maxMembers`，而 state.members 只有 teammate。
    const teamLimit = teamLimitState()
    const maxMembers = teamLimit.limit
    const teamRoom = Math.max(0, maxMembers - teammates.length)

    /**
     * 闲置槽只有在 inactive 且名下题已结束时才可复用。
     * roster 是 append-only 且**累计计数**（README：maxMembers = 团队**曾创建过**的 teammate 总数，
     * 含失败的，永不回收）→ 78 道题「每题一个 agent」需要 78 个名额；
     * 复用闲置槽后 roster 增长被限制在**峰值并发**（≈ concurrency）。
     * 代价是**上下文污染**：复用槽带着上一题的历史 → 换题消息第一句就要求它「完全忽略」上一题。
     */
    const solvedIds = new Set(
      (Array.isArray(allChallenges) ? allChallenges : [])
        .filter((challenge) => challenge?.solved === true)
        .map((challenge) => String(challenge.id)),
    )
    const completedIds = new Set()
    for (const task of board.tasks ?? []) {
      if (task?.status !== 'completed' && task?.status !== 'deleted') continue
      const cid = parseChallengeId(task?.description) ?? challengeIdFromScope(task?.writeScopes)
      if (cid) completedIds.add(String(cid))
    }
    const idleSlots = reuseEnabled
      ? collectReusableSlots({ members: teammates, workByChallenge: board.workByChallenge, solvedIds, completedIds })
      : []
    // 执行槽供给：闲置槽（不占新名额）+ roster 剩余名额
    const executorSupply = idleSlots.length + (reuseEnabled ? teamRoom : teamRoom)
    const slots = Math.max(0, Math.min(concurrency - busy, executorSupply, entries.length))
    const seed = now().toString(36)

    const nowMs = now()
    const { limit: envLimit, source: envLimitSource } = await resolveEnvLimit(board.work)
    const heldEnvs = heldEnvIds(board.work, nowMs)
    const envBudget = Math.max(0, envLimit - heldEnvs.size)

    /**
     * P0 准备状态：
     * - `hasPrep`：`<题目目录>/PREP.md` 存在（**软信号**：存在 ≈ 已离线准备，不保证质量，不读内容）；
     * - `prepping`：已有准备 agent 在跑（work 记录 `prepTeammate` + 该成员在册且未 failed）。
     * 两者都成立的题不再重复派准备 agent —— 它们等配额释放后拿全程 agent（`scoreChallenge` 升权）。
     */
    function prepStateOf(challenge) {
      const record = board.workByChallenge.get(String(challenge?.id))
      const prepName = String(record?.prepTeammate ?? '')
      const member = prepName ? memberByName.get(prepName) : null
      const startedMs = Date.parse(String(record?.prepStartedAt ?? record?.updatedAt ?? ''))
      const stale = Number.isFinite(startedMs) && nowMs - startedMs > LIMITS.prepStaleMinutes * 60000
      // 「还在做 P0」= 派过准备 agent + 还没写 PREP.md + 成员没 failed + 没超过 stale 窗口。
      // 超时/成员已消失都视为「准备结束」→ 允许重新派（另派准备 agent 或配额有空时派全程 agent），避免死锁。
      const prepping = Boolean(prepName) && record?.status === 'prep' && member?.status !== 'failed' && !stale
      return { hasPrep: prepExists(challenge), prepping }
    }

    const plan = await planSpawns({
      adapter,
      connKey,
      candidates: entries.map((entry) => entry.challenge),
      slots,
      envBudget,
      workByChallenge: board.workByChallenge,
      prepStateOf,
    })
    /** 本题题型：优先本轮探测结果，其次 work 记录缓存（两种情况都来自详情接口）。 */
    const taskTypeOf = (challenge) => {
      const probed = plan.types.get(String(challenge?.id))
      if (probed != null) return probed
      const cached = Number(board.workByChallenge.get(String(challenge?.id))?.taskType)
      return Number.isFinite(cached) && cached >= 1 && cached <= 3 ? cached : null
    }
    // 按**计划顺序**（非环境题优先 → scoreChallenge 降序）派发，而不是按建任务顺序
    const entryById = new Map(entries.map((entry) => [String(entry.challenge?.id), entry]))
    const spawnQueue = plan.picks
      .map((pick) => {
        const entry = entryById.get(String(pick.challenge?.id))
        if (!entry) return null
        return { ...entry, mode: pick.mode, taskType: pick.taskType, hasPrep: pick.hasPrep, priority: pick.priority }
      })
      .filter(Boolean)
    if (plan.probed > 0) {
      log(
        'info',
        `环境调度：envLimit=${envLimit}（${envLimitSource}），已占用 ${heldEnvs.size}，本轮探测 ${plan.probed} 题，` +
          `派发 ${spawnQueue.length} 个（全程 ${plan.fullPicks.length} / 离线准备 ${plan.prepPicks.length}），` +
          `就绪待环境 ${plan.readyWaiting.length}，准备中 ${plan.prepping.length}`,
      )
    }

    // 3) 给每道题找执行者：复用闲置槽 → spawn 新槽 → 排队
    //    `mode === 'prep'` → 离线准备 agent（只做 P0，不占环境配额，但仍占并发槽）
    const spawned = [] // 新 spawn 的槽
    const reused = [] // 复用的闲置槽（send_message 派新题）
    const spawnFailures = []
    const limitBlocked = [] // 因为撞 teammate 上限而**没拉起来**的题（要如实汇报，不能静默丢）
    const challengeById = new Map(
      (Array.isArray(allChallenges) ? allChallenges : []).map((challenge) => [String(challenge.id), challenge]),
    )
    const pool = [...idleSlots]
    let spawnRoom = Math.max(0, teamRoom)
    let limitHit = false
    for (const entry of spawnQueue) {
      // 撞上限后不再继续试（每个都会被拒），但要把剩下的记下来
      if (limitHit) {
        limitBlocked.push(entry)
        continue
      }
      if (spawned.length + reused.length >= slots) break

      // ① 复用闲置槽：`sendMessage` 会唤醒 inactive 的 teammate 并让它继续干活
      const slot = reuseEnabled ? takeSlotFor(pool, entry.challenge) : null
      if (slot) {
        const reassigned = await reuseSlot({
          slot, entry, api, caller, args, connection, connKey, workDir, envLimit, heldEnvs, taskTypeOf, challengeById,
        })
        if (reassigned.ok) {
          reused.push({
            ...entry,
            name: slot.name,
            previousId: slot.previousId,
            status: 'resuming',
            reused: true,
          })
          used.add(slot.name)
          log('info', `♻️ 复用闲置槽 ${slot.name}（原 #${slot.previousId}）→ ${entry.subject}`)
          continue
        }
        // 复用失败就退回 spawn（下面继续执行），并把原因记进 failures
        spawnFailures.push({ ...entry, name: slot.name, message: `复用失败：${reassigned.message}` })
        log('warn', `复用闲置槽 ${slot.name} 失败（${entry.challenge?.name}）：${reassigned.message}`)
      }

      // ② spawn 新槽（roster 还有名额时）
      if (spawnRoom <= 0) continue // ③ 没槽也没名额 → 留在任务板排队（下一轮再派）
      spawnRoom -= 1
      const isPrep = entry.mode === 'prep'
      const base = teammateNameFor(entry.challenge, { slug: entry.slug, prefix: isPrep ? 'prep' : 'solver' })
      let name = allocateName(base, used, seed)
      let member = null
      let lastError = null
      for (let attempt = 1; attempt <= LIMITS.maxSpawnAttempts && !member; attempt += 1) {
        try {
          const result = await api.spawnTeammate(caller, {
            name,
            // 两个 description 共用同一份可解析契约（见 buildPrepMemberDescription 注释）
            description: isPrep
              ? buildPrepMemberDescription(entry.challenge)
              : buildMemberDescription(entry.challenge),
            prompt: isPrep
              ? buildPrepPrompt({
                  name,
                  challenge: entry.challenge,
                  taskId: entry.taskId,
                  connection,
                  connKey,
                  workDir,
                  envLimit,
                  envHeld: heldEnvs.size,
                })
              : buildSolverPrompt({
                  name,
                  challenge: entry.challenge,
                  taskId: entry.taskId,
                  connection,
                  connKey,
                  workDir,
                  envLimit,
                  envHeld: heldEnvs.size,
                  taskType: taskTypeOf(entry.challenge),
                }),
            context: 'fresh',
            provider: config.freshProvider ?? FRESH_PROVIDER,
            signal: resolveSignal(args),
          })
          member = result?.member ?? result ?? null
        } catch (error) {
          lastError = error
          used.add(name) // DSH 名字永久占用：失败的名字也不能再用
          if (isMemberLimit(error)) {
            // 报错里带真实上限（`Team member limit 8 reached`）→ 记住它，下一轮按真值算 teamRoom
            const parsed = parseMemberLimit(error, lastError?.cause?.message ?? '')
            if (parsed && parsed !== learnedTeamLimit) {
              learnedTeamLimit = parsed
              log('warn', `学到真实 teammate 上限 maxMembers=${parsed}（来自 DSH 报错，后续按它算并发）`)
              await rememberWork(connKey, safeId(entry.challenge.id), {
                teamLimitObserved: parsed,
                teamLimitLearnedAt: stamp(),
                teamLimitMessage: String(lastError?.message ?? error ?? ''),
              })
            }
            limitHit = true
            spawnRoom += 1 // 没建成，名额还回去
            break
          }
          if (attempt < LIMITS.maxSpawnAttempts && isNameConflict(error)) {
            name = allocateName(base, used, seed)
            continue
          }
          break
        }
      }

      if (member) {
        const memberName = String(member.name ?? name)
        used.add(memberName)
        spawned.push({ ...entry, name: memberName, status: member.status ?? 'provisioning' })
        if (isPrep) {
          // ⚠️ **不写 `teammate`**：准备 agent 不接管任务板任务，这道题仍然可以被派「全程 agent」
          //    （配额一释放，下一轮 start 会优先派它，PREP.md 让它直接进 P1）。
          await rememberWork(connKey, safeId(entry.challenge.id), {
            status: 'prep',
            prepTeammate: memberName,
            prepStartedAt: stamp(),
            taskId: entry.taskId,
          })
          log('info', `已拉起离线准备 agent ${memberName} → ${entry.subject}（环境配额满，先做 P0）`)
        } else {
          await rememberWork(connKey, safeId(entry.challenge.id), {
            status: 'solving',
            teammate: memberName,
            taskId: entry.taskId,
          })
          log('info', `已拉起 ${memberName} → ${entry.subject}`)
        }
      } else {
        const message = lastError?.message ?? String(lastError ?? '未知错误')
        if (limitHit && isMemberLimit(lastError)) {
          // 撞 teammate 上限：归到「没拉起来」（不是普通失败），摘要里要如实列出
          limitBlocked.push({ ...entry, name, message })
        } else {
          spawnRoom += 1 // 这个名字被永久占用，但名额没消耗成功 → 还回去（下一个 entry 可以继续试）
          spawnFailures.push({ ...entry, name, message })
          await rememberWork(connKey, safeId(entry.challenge.id), { status: 'spawn_failed', error: message })
          log('warn', `拉起 agent 失败（${entry.challenge?.name}）：${message}`)
        }
      }
    }

    const assigned = [...spawned, ...reused]
    const spawnedIds = new Set(assigned.map((s) => String(s.challenge?.id)))
    const fullAgents = assigned.filter((item) => item.mode !== 'prep')
    const prepAgents = assigned.filter((item) => item.mode === 'prep')
    const waitingIds = new Set(
      [...plan.readyWaiting, ...plan.prepping, ...plan.envDeferred].map((challenge) => String(challenge?.id)),
    )
    // 「排队中」= 有并发槽位但本轮没轮到（就绪/准备中/环境排队各自成段，避免重复列）
    const queued = entries.filter(
      (entry) => !spawnedIds.has(String(entry.challenge?.id)) && !waitingIds.has(String(entry.challenge?.id)),
    )

    const lines = [
      '## 编排已启动',
      '',
      `- 平台：${connection?.platform ?? 'lingxu'} ${connection?.baseUrl ?? ''}（eventId=${connection?.eventId ?? '-'}，连接 key=${connKey}）`,
      ...(probe.warning
        ? [`- ⚠️ 前置探活失败但已继续（可能是网络抖动）：${probe.warning?.message ?? probe.warning}`]
        : []),
      `- 题目：平台共 ${Array.isArray(allChallenges) ? allChallenges.length : 0} 道 → 过滤后 ${candidates.length} 道${
        skipped.length ? `（跳过已有 agent 的 ${skipped.length} 道）` : ''
      } → 本轮处理 ${selected.length} 道（limit=${
        args.limit == null || args.limit === '' ? `全部，≤${limit}` : limit
      }）`,
      `- 任务板：新建 ${entries.length - reusedTasks} 个任务${
        reusedTasks ? `，复用已有任务 ${reusedTasks} 个` : ''
      }${taskFailures.length ? `，失败 ${taskFailures.length} 个` : ''}`,
      `- 环境调度：同时最多 ${envLimit} 个环境（${envLimitSource}），当前已占用 ${heldEnvs.size} → 本轮环境题配额 ${envBudget} 个`,
      `- 两阶段派发：全程 agent ${fullAgents.length} 个（其中环境型 ${
        fullAgents.filter((item) => isEnvType(item.taskType)).length
      }）/ **离线准备 agent ${prepAgents.length} 个**（不吃配额，先把 P0 做完）/ 就绪待环境 ${plan.readyWaiting.length} 题${plan.prepping.length ? ` / 准备中 ${plan.prepping.length} 题` : ''}`,
      ...(plan.probed
        ? [
            `- 题型探测：本轮按需探测 ${plan.probed} 题（列表接口没有 task_type，只探可能要派的题）` +
              `${
                plan.envDeferred.length || plan.slotDeferred.length
                  ? `；排队 ${plan.envDeferred.length + plan.slotDeferred.length} 题`
                  : ''
              }`,
          ]
        : []),
      `- 并发：上限 ${concurrency}（本插件硬上限 ${LIMITS.maxConcurrency}），当前在跑/在起 ${busy} 个 → 本轮分配 ${assigned.length} 个（♻️ 复用 ${reused.length} / 🆕 新建 ${spawned.length}）`,
      `- Agent 池：闲置可复用 ${idleSlots.length} 个${
        idleSlots.length ? `（${idleSlots.map((slot) => `${slot.name}←#${slot.previousId}`).join('、')}）` : ''
      }｜roster ${teammates.length}/${maxMembers}（上限来源：${teamLimit.source}），剩余名额 ${Math.max(0, maxMembers - teammates.length)}` +
        `${reuseEnabled ? '' : '｜⚠️ reuseAgents=false：每题新建 agent，会快速耗尽名额（roster 累计且不可回收）'}`,
      `- 团队余量：teammate ${teammates.length}/${maxMembers}（上限来源：${teamLimit.source}；DSH 的 maxMembers **不含 lead**，` +
        `含 lead 共 ${members.length} 人），可用名额 ${teamRoom}`,
      '',
    ]
    if (reused.length) {
      lines.push(`### ♻️ 复用闲置槽（${reused.length} 个：不占新名额，send_message 唤醒）`, '')
      for (const item of reused) {
        lines.push(
          `- ${item.name}：原 #${item.previousId} → ${item.taskId} ${item.subject}（${taskTypeText(item.taskType)}；已发换题消息，含「完全忽略上一题」纪律）`,
        )
      }
      lines.push('')
    }
    if (fullAgents.length) {
      lines.push('### 🆕 新建槽（全程 agent：P0 + P1）', '')
      for (const item of fullAgents.filter((row) => row.reused !== true)) {
        lines.push(
          `- ${item.name} → ${item.taskId} ${item.subject}（${taskTypeText(item.taskType)}，status=${item.status}，scope=${item.writeScope}）`,
        )
      }
      lines.push('')
    }
    if (prepAgents.length) {
      lines.push(`### 🌙 离线准备 agent（${prepAgents.length} 个：不吃环境配额，先把 P0 做完）`, '')
      for (const item of prepAgents.filter((row) => row.reused !== true)) {
        lines.push(
          `- ${item.name} → ${item.taskId} ${item.subject}（等环境配额；做完读题/逆向/写 exp + PREP.md 后汇报）`,
        )
      }
      lines.push(
        '',
        '说明：这些题是环境型但配额已满 —— 与其让 agent 干等，不如先做**不需要环境**的那半段（读题面、下载分析附件、逆向、写 exploit、搭本地复现）。',
        '配额一释放，`ctf_solve_start` 会把这些题**优先**派成全程 agent（有 PREP.md = 上手最快）。',
        '',
      )
    }
    if (plan.readyWaiting.length) {
      lines.push(`### ⏳ 就绪待环境（${plan.readyWaiting.length} 题：PREP.md 已就绪）`, '')
      for (const challenge of plan.readyWaiting) {
        lines.push(
          `- ${taskSubjectFor(challenge)}（challengeId=${safeId(challenge.id)}，PREP.md 已存在）` +
            `${plan.envDeferred.length || plan.readyWaiting.length ? '' : ''}`,
        )
      }
      lines.push('', '提示：环境释放后 `ctf_solve_start` 会优先把配额给这些题（scoreChallenge 对已就绪大幅升权）。', '')
    }
    if (plan.prepping.length) {
      lines.push(`### 🔧 准备中（${plan.prepping.length} 题：P0 进行中，还没写 PREP.md）`, '')
      for (const challenge of plan.prepping) {
        const name = board.workByChallenge.get(String(challenge.id))?.prepTeammate
        lines.push(`- ${taskSubjectFor(challenge)}（challengeId=${safeId(challenge.id)}${name ? `，准备 agent: ${name}` : ''}）`)
      }
      lines.push(
        '',
        '提示：这些题已有准备 agent 在做 P0，**同一道题不会重复派 agent**（避免撞目录）。',
        '配额先空出来时，可以直接 `send_message` 让准备 agent 接手 P1（它已有上下文）；',
        `或者等它写出 PREP.md 后 ctf_solve_start —— 那时会按「已就绪」优先派全程 agent（超过 ${LIMITS.prepStaleMinutes} 分钟没动静会视为已结束，允许重新派）。`,
        '',
      )
    }
    if (queued.length) {
      lines.push(`### 排队中（${queued.length} 题，等 agent 空出来再 start）`, '')
      for (const item of queued) {
        lines.push(`- ${item.taskId} ${item.subject}`)
      }
      // 题型只有详情接口有：本轮探测窗口之外的题还没分类，如实告知（别让用户以为它们一定是非环境题）
      const unprobed = queued.filter((entry) => plan.types.get(String(entry.challenge?.id)) == null).length
      if (unprobed) {
        lines.push(
          '',
          `提示：其中 ${unprobed} 题本轮未探测题型（列表接口没有 task_type，只探要派的题）；` +
            '环境型的会在下一轮按 envLimit 配额派发。',
        )
      }
      lines.push('')
    }
    if (plan.envDeferred.length) {
      lines.push(
        `### 环境排队（${plan.envDeferred.length} 题：配额 ${envBudget}/${envLimit} 已满，且**并发槽用完**，暂时派不出准备 agent）`,
        '',
      )
      for (const challenge of plan.envDeferred) {
        lines.push(`- ${taskSubjectFor(challenge)}（challengeId=${safeId(challenge.id)}，题型=${taskTypeText(taskTypeOf(challenge))}）`)
      }
      lines.push(
        '',
        '提示：这些题可以等下一次 `ctf_solve_start`（会先派准备 agent 做 P0）；' +
          '有 agent 腾出并发槽时优先补派。解完的题请立刻 `ctf_release_env` 释放环境。',
        '',
      )
    }
    if (skipped.length) {
      lines.push(`### 已有 agent 在做（跳过 ${skipped.length} 题；force=true 可强制重跑）`, '')
      for (const challenge of skipped) {
        lines.push(`- ${taskSubjectFor(challenge)}（challengeId=${safeId(challenge.id)}）`)
      }
      lines.push('')
    }
    if (taskFailures.length) {
      lines.push('### 建任务失败', '')
      for (const item of taskFailures) lines.push(`- ${item.challenge?.name}：${item.message}`)
      lines.push('')
    }
    if (spawnFailures.length) {
      lines.push('### 拉起 agent 失败（已跳过，不影响其他题目）', '')
      for (const item of spawnFailures) lines.push(`- ${item.name}（${item.subject}）：${item.message}`)
      lines.push('')
    }
    if (limitBlocked.length) {
      // 上限可能在 spawn 过程中从报错里学到了真值 → 这里重新取一次（比规划时更准）
      const finalTeamLimit = teamLimitState()
      lines.push(
        `### ⚠️ 已达 teammate 上限：本轮有 ${limitBlocked.length} 个 agent 没拉起来`,
        '',
        `- 上限：maxMembers=${finalTeamLimit.limit}（来源：${finalTeamLimit.source}；DSH 语义**不含 lead**，当前 teammate ${teammates.length} 个 + lead 1 个 = 共 ${members.length} 人）`,
        '- 没拉起来的题：',
        ...limitBlocked.map(
          (item) =>
            `  - ${taskSubjectFor(item.challenge)}（challengeId=${safeId(item.challenge?.id)}，${
              item.mode === 'prep' ? '离线准备 agent' : '全程 agent'
            }）`,
        ),
        '',
        '建议（任选其一）：',
        '  ① 用 `ctf_solve_stop` 释放不再需要的 agent（或等它们跑完），再 `ctf_solve_start` 补派；',
        '  ② 提高上限：编辑 `~/.dsh/profiles/desktop/cordis.yml` 里 agentTeams 的 `maxMembers`' +
          `（当前 ${finalTeamLimit.limit}，DSH 默认 16），改完重启 DSH —— 这是提高并发最直接的办法。`,
        '',
        '（题目都还在任务板上，配额/槽位一释放，下一次 `ctf_solve_start` 会自动补派。）',
        '',
      )
    }
    if (!spawned.length) {
      lines.push(
        limitHit
          ? `未拉起新 agent：已达到 teammate 上限（maxMembers=${maxMembers}，来源：${teamLimit.source}）。`
          : envBudget <= 0 && plan.envDeferred.length
            ? `未拉起新 agent：环境配额已满（占用 ${heldEnvs.size}/${envLimit}），且有 ${plan.envDeferred.length} 道环境题在排队 —— 先 ctf_release_env 释放环境再 start。`
            : busy >= concurrency
              ? `未拉起新 agent：已有 ${busy} 个 teammate 在跑，达到并发上限 ${concurrency}；题目已在任务板排队。`
              : '未拉起新 agent：可用名额为 0；题目已在任务板排队。',
        '',
      )
    }
    lines.push(
      `提示：用 ctf_solve_status 查看任务板进度；ctf_solve_stop 中断 agent（可选释放环境）。生成于 ${stamp()}。`,
    )
    // 「协同交流」采集：拉起动作留一条 spawn 记录，供顶部「CTF」视图的通信流展示
    await logTeamMessage(
      'spawn',
      [
        `ctf_solve_start：新建任务 ${entries.length - reusedTasks} 个${reusedTasks ? `（复用 ${reusedTasks}）` : ''}，拉起 agent ${spawned.length} 个（并发上限 ${concurrency}）`,
        `环境调度：上限 ${envLimit}（${envLimitSource}），已占用 ${heldEnvs.size}，环境题配额 ${envBudget}${
          plan.envDeferred.length ? `，环境排队 ${plan.envDeferred.length} 题` : ''
        }`,
        ...spawned.map((item) => `- ${item.name} → ${item.taskId} ${item.subject}（${taskTypeText(taskTypeOf(item.challenge))}）`),
        ...(queued.length ? [`并发排队 ${queued.length} 题：${queued.map((item) => item.taskId).join(', ')}`] : []),
        ...(taskFailures.length ? [`建任务失败 ${taskFailures.length} 个`] : []),
        ...(spawnFailures.length ? [`拉起失败 ${spawnFailures.length} 个：${spawnFailures.map((f) => f.name).join(', ')}`] : []),
      ].join('\n'),
      connKey,
    )
    return lines.join('\n')
  }

  // -------------------------------------------------------------- status

  async function status(args = {}) {
    const api = requireTeams(['listTasks', 'listMembers'])
    const caller = requireCaller(args)

    const tasks = await safeListTasks(api, caller)
    const members = await safeListMembers(api, caller)
    const teammates = members.filter((member) => member?.role !== 'lead' && member?.name !== 'lead')

    let challenges = null
    let platformError = null
    let sessionExpired = false
    let connKey = null
    try {
      const platform = await resolvePlatform(args)
      connKey = platform.connKey
      const rows = await platform.adapter.challenges()
      challenges = Array.isArray(rows) ? rows : []
    } catch (error) {
      // 拉题目列表本身就是一次探活：403「未登录」= session 失效（不额外发请求）。
      sessionExpired = isSessionExpired(error)
      platformError = error?.message ?? String(error)
    }

    const work = await readWork(connKey || undefined)
    const nowMs = now()
    const byChallenge = new Map()
    for (const challenge of challenges ?? []) byChallenge.set(String(challenge.id), challenge)

    // 同一题可能有多条 work 记录（不同连接/重跑），取 updatedAt 最新的一条
    const workByChallenge = new Map()
    for (const record of work) {
      if (record?.challengeId == null) continue
      const key = String(record.challengeId)
      const previous = workByChallenge.get(key)
      if (!previous || String(record.updatedAt ?? '') >= String(previous.updatedAt ?? '')) {
        workByChallenge.set(key, record)
      }
    }

    /**
     * 该题是否「agent 正在做」。
     *
     * 两个来源缺一不可：
     * 1. 任务被认领 → `task.status === 'in_progress'`；
     * 2. **agent 已拉起但还没 claim**（spawn 与 claim 之间的空窗）→ work 记录里有 teammate 且
     *   status=solving。用户反馈「进行中也看不到」主要就是这个空窗期。
     */
    function agentWorking(cid, taskStatus) {
      if (taskStatus === 'in_progress') return true
      const record = cid ? workByChallenge.get(String(cid)) : null
      return Boolean(record?.teammate) && record?.status === 'solving'
    }

    /** 平台侧状态：进行中的题不再只显示「未解」，而是明确标注 agent 正在做。 */
    function platformLabel(row) {
      if (row.solved === true) return '已解'
      if (row.solved === null) return row.working ? '进行中（agent 正在做）' : '未知'
      return row.working ? '进行中（agent 正在做）' : '未解'
    }

    /** 题型单元格：来自 work 记录缓存（探测 / ctf_challenge 回写），没缓存就是 '-'。 */
    function typeCell(cid) {
      const record = cid ? workByChallenge.get(String(cid)) : null
      const type = Number(record?.taskType)
      return Number.isFinite(type) && type >= 1 && type <= 3 ? taskTypeText(type) : '-'
    }

    /**
     * 环境单元格：`剩余 47m` / `⚠ 剩余 3m` / `已过期` / `已释放`。
     * 只对「起过环境但没释放」的题显示（数据来自 ctf_start_env 写的 work 记录）。
     */
    function envCell(cid) {
      const record = cid ? workByChallenge.get(String(cid)) : null
      if (record?.envStarted !== true || record?.envReleased === true) return '-'
      const seconds = envRemainingOf(record, nowMs)
      if (seconds == null) return '运行中'
      if (seconds <= 0) return '已过期'
      const text = `剩余 ${Math.max(1, Math.round(seconds / 60))}m`
      return seconds < LIMITS.envWarnSeconds ? `⚠ ${text}` : text
    }

    /** 该题是否环境型（用于排队/占用统计）。 */
    function isEnvRow(cid) {
      return isEnvType(workByChallenge.get(String(cid))?.taskType)
    }

    /** 环境列 + 停滞标记：`剩余 25m ⚠ 空转 24m` / `剩余 6m ♻️ 建议让位`（只提示，不抢占）。 */
    function envCellWithHealth(row) {
      if (row.env === '-' || row.env === '') return '-'
      if (row.suggestRelease) return `${row.env} ♻️ 建议让位`
      if (row.idleMinutes != null) return `${row.env} ⚠ 空转 ${row.idleMinutes}m`
      return row.env
    }

    const rows = []
    const seen = new Set()
    for (const task of tasks) {
      const cid = parseChallengeId(task?.description) ?? challengeIdFromScope(task?.writeScopes)
      if (cid) seen.add(String(cid))
      const challenge = cid ? byChallenge.get(String(cid)) : null
      const status = task?.status ?? 'unknown'
      rows.push({
        cid: cid ?? '-',
        title: challenge ? `${challenge.name} (#${cid})` : cell(task?.subject),
        category: challenge?.category ?? '-',
        score: challenge ? Number(challenge.score ?? 0) : '-',
        taskId: task?.id ?? '-',
        status,
        owner: task?.ownerName ?? task?.owner ?? (task?.ownerId ? `id:${task.ownerId}` : '未认领'),
        solved: challenge ? challenge.solved === true : null,
        working: agentWorking(cid, status),
        env: envCell(cid),
        type: typeCell(cid),
        envStarted: envHeld(workByChallenge.get(String(cid ?? '')), nowMs),
        envType: isEnvRow(cid),
        // 题名（重建 PREP.md 路径用）：平台列表优先，其次 task description/subject 里的题名
        name: challenge?.name ?? parseTaskSubject(task?.subject).name ?? null,
        prepName: String(workByChallenge.get(String(cid ?? ''))?.prepTeammate ?? '') || null,
      })
    }
    for (const challenge of challenges ?? []) {
      if (seen.has(String(challenge.id))) continue
      rows.push({
        cid: String(challenge.id),
        title: `${challenge.name} (#${challenge.id})`,
        category: challenge?.category ?? '-',
        score: Number(challenge?.score ?? 0),
        taskId: '-',
        status: 'queued',
        owner: '-',
        solved: challenge.solved === true,
        working: agentWorking(String(challenge.id), 'queued'),
        env: envCell(String(challenge.id)),
        type: typeCell(String(challenge.id)),
        envStarted: envHeld(workByChallenge.get(String(challenge.id)), nowMs),
        envType: isEnvRow(String(challenge.id)),
        name: challenge?.name ?? null,
        prepName: String(workByChallenge.get(String(challenge.id))?.prepTeammate ?? '') || null,
      })
    }

    //  P0 就绪 / 准备中 / 环境停滞（只提示，不自动抢占）
    //
    // 进度判据（取最新者）：work 记录的 `updatedAt`（ctf_start_env / ctf_delay_env / release / 编排都会写）
    // 与本题最近一次 flag 提交时间。**agent 的解题动作不会写 work 记录**，所以阈值刻意宽松（默认 20 分钟），
    // 且只提示不抢占 —— agent 可能正处在解题最后一步。
    const submissions = typeof store?.recentSubmissions === 'function'
      ? await store.recentSubmissions(200).catch(() => [])
      : []
    const lastSubmitByChallenge = new Map()
    for (const item of Array.isArray(submissions) ? submissions : []) {
      const key = String(item?.challengeId ?? '')
      const ms = Date.parse(String(item?.at ?? ''))
      if (!key || !Number.isFinite(ms)) continue
      if (!lastSubmitByChallenge.has(key) || ms > lastSubmitByChallenge.get(key)) lastSubmitByChallenge.set(key, ms)
    }
    const lastProgressMs = (cid) => {
      const record = workByChallenge.get(String(cid))
      return Math.max(
        Date.parse(String(record?.updatedAt ?? '')) || 0,
        Date.parse(String(record?.envStartedAt ?? '')) || 0,
        lastSubmitByChallenge.get(String(cid)) ?? 0,
      )
    }
    for (const row of rows) {
      // PREP.md（P0 完成软信号）：只对「环境型 + 未解 + 没在跑环境」的题做一次存在性检查
      row.prep = row.envType && row.solved !== true && !row.envStarted ? prepExists({ id: row.cid, name: row.name }) : false
      if (!row.envStarted) continue
      const lastMs = lastProgressMs(row.cid)
      const idleMinutes = lastMs > 0 ? Math.floor((nowMs - lastMs) / 60000) : null
      row.idleMinutes = idleMinutes != null && idleMinutes >= LIMITS.envStallMinutes ? idleMinutes : null
      const remaining = envRemainingOf(workByChallenge.get(String(row.cid)), nowMs)
      row.envRemainingSeconds = remaining
      row.suggestRelease = Boolean(row.idleMinutes != null && remaining != null && remaining > 0 && remaining < LIMITS.envStallReleaseSeconds)
    }

    // 平台未解但 agent 正在跑的题目（用户最关心的「进行中」口径）
    const workingRows = rows.filter((row) => row.working && row.solved !== true)
    // 已解出却还占着环境的题（释放即让位：环境是稀缺资源）
    const envHogs = rows.filter((row) => row.solved === true && row.envStarted)
    const heldEnvRows = rows.filter((row) => row.envStarted)

    const solvedCount = (challenges ?? []).filter((c) => c?.solved === true).length
    const inProgress = tasks.filter((t) => t?.status === 'in_progress').length
    const pending = tasks.filter((t) => t?.status === 'pending').length
    const completed = tasks.filter((t) => t?.status === 'completed').length
    const failedMembers = teammates.filter((m) => m?.status === 'failed')
    const failedSpawns = work.filter((w) => w?.status === 'spawn_failed')
    const running = teammates.filter((m) => m?.status === 'running').length
    const inactive = teammates.filter((m) => m?.status === 'inactive').length
    const provisioning = teammates.filter((m) => m?.status === 'provisioning').length
    const envState = await resolveEnvLimit(work)
    // 环境排队 = 环境型 + 没在做 + 没解出（等环境释放后 start 补派）
    // 就绪待环境：P0 已完成（PREP.md 在）但还没拿到配额（没环境、没在跑）
    const readyRows = rows.filter((row) => row.envType && row.prep === true && row.solved !== true && !row.working)
    // 准备中：派了准备 agent 但 PREP.md 还没写出来
    const preppingRows = rows.filter(
      (row) => row.envType && row.prep !== true && row.prepName && row.solved !== true && !row.envStarted,
    )
    // 环境停滞：占着环境但长时间无进展（含是否该让位）
    const stalledRows = rows.filter((row) => row.envStarted && row.idleMinutes != null && row.solved !== true)
    // 「环境型待派」= 环境型但本轮既没环境、也没准备 agent、也没在跑（上面三种各有专段，避免重复列）
    const listedIds = new Set([...readyRows, ...preppingRows, ...stalledRows].map((row) => String(row.cid)))
    const envQueueRows = rows.filter(
      (row) => row.envType && !row.working && row.solved !== true && !row.envStarted && !listedIds.has(String(row.cid)),
    )

    const lines = []
    if (sessionExpired) {
      // 醒目横幅置顶（第一行）；**不**自动 interrupt 所有 agent（用户可能想自己决定），只给建议。
      lines.push(SESSION_EXPIRED_BANNER, '')
    }
    lines.push('## 团队进度', '')
    if (sessionExpired) {
      lines.push('> 现有 agent 未被自动中断（如需停手请用 ctf_solve_stop）；从此刻起它们的提交都会失败，flag 会丢失。', '')
    } else if (platformError) {
      lines.push(`> ⚠️ 平台题目列表获取失败：${platformError}（仅显示任务板）`, '')
    } else {
      lines.push(`平台：${args.platform ?? '当前连接'}${connKey ? `（key=${connKey}）` : ''}`, '')
    }
    lines.push('| 题目 | 分类 | 分值 | 题型 | 任务 | 任务状态 | owner | 平台 | 环境 |')
    lines.push('|---|---|---|---|---|---|---|---|---|')
    if (!rows.length) {
      lines.push('| （无） | - | - | - | - | - | - | - | - |')
    } else {
      for (const row of rows) {
        lines.push(
          `| ${cell(row.title)} | ${cell(row.category)} | ${cell(row.score)} | ${cell(row.type)} | ${cell(
            row.taskId,
          )} | ${cell(fmtTaskStatus(row.status))} | ${cell(row.owner)} | ${cell(platformLabel(row))} | ${cell(
            envCellWithHealth(row),
          )} |`,
        )
      }
    }
    lines.push('')
    lines.push('### 统计', '')
    if (sessionExpired) {
      lines.push('- 平台：⚠️ 会话失效（sessionid 已失效，平台数据不可用；上方任务板/成员数字仍有效）')
    } else {
      lines.push(
        `- 平台：已解 ${solvedCount}${challenges ? ` / 共 ${challenges.length}` : ''} 题；未建任务 ${rows.filter((r) => r.taskId === '-').length} 题`,
      )
    }
    lines.push(`- 任务板：共 ${tasks.length}（进行中 ${inProgress}，待认领 ${pending}，已完成 ${completed}）`)
    lines.push(`- 进行中（agent 正在做）：${workingRows.length} 题${workingRows.length ? '，平台侧可能仍显示未解' : ''}`)
    lines.push(
      `- 环境占用：${heldEnvRows.length}/${envState.limit}（上限来源：${envState.source}；按 ctf_start_env 的 work 记录统计）` +
        `${envQueueRows.length ? `；环境型待派/排队 ${envQueueRows.length} 题` : ''}`,
    )
    if (readyRows.length || preppingRows.length || stalledRows.length) {
      lines.push(
        `- P0 就绪待环境：${readyRows.length} 题｜准备中：${preppingRows.length} 题｜环境停滞：${stalledRows.length} 题` +
          '（两阶段派发：配额满时先派离线准备 agent 做 P0）',
      )
    }
    const teamLimit = teamLimitState()

    /**
     * Agent 池视图：roster 是累计不可回收的，所以槽才是稀缺资源。
     * 每个 teammate 归为四类：活跃 / 闲置可复用 / 占用不可挪 / failed，并显示它**当前负责哪道题**。
     */
    const slotOwner = new Map()
    for (const [cid, record] of workByChallenge) {
      const active = String(record?.teammate ?? '')
      const name = active || String(record?.slotOwner ?? '')
      if (!name) continue
      const existing = slotOwner.get(name)
      if (existing?.active && !active) continue
      slotOwner.set(name, { id: String(cid), record, active: Boolean(active) })
    }
    // 离线准备 agent 不写 teammate（它不接管任务板任务），单独识别名称。
    const prepOwner = new Map()
    for (const [cid, record] of workByChallenge) {
      const name = String(record?.prepTeammate ?? '')
      if (name) prepOwner.set(name, { id: String(cid) })
    }
    const slotRows = teammates.map((member) => {
      const name = String(member?.name ?? '')
      const owned = slotOwner.get(name) ?? prepOwner.get(name) ?? null
      const prev = owned ? workByChallenge.get(owned.id) : null
      const current = owned ? byChallenge.get(owned.id) : null
      const label = owned ? `#${owned.id}${current ? ` ${current.name}` : ''}` : '（无题目记录）'
      if (member?.status === 'failed') return { name, kind: 'failed', label }
      if (member?.status === 'running' || member?.status === 'provisioning') {
        return { name, kind: 'active', label, status: member.status }
      }
      if (!owned) return { name, kind: 'unknown', label }
      if (!slotOwner.has(name) && prepOwner.has(name)) return { name, kind: 'prep', label }
      const finished =
        byChallenge.get(owned.id)?.solved === true ||
        tasks.some(
          (task) =>
            task?.status === 'completed' &&
            String(parseChallengeId(task?.description) ?? challengeIdFromScope(task?.writeScopes)) === owned.id,
        ) ||
        TERMINAL_WORK_STATUSES.includes(String(prev?.status ?? ''))
      return { name, kind: finished ? 'idle' : 'busy', label }
    })
    const idleSlotsInStatus = slotRows.filter((row) => row.kind === 'idle')

    lines.push(
      `- 成员：共 ${teammates.length}（running ${running}，inactive ${inactive}，provisioning ${provisioning}，failed ${failedMembers.length}）` +
        `｜上限 ${teamLimit.limit}（来源：${teamLimit.source}），含 lead 共 ${members.length} 人，余量 ${Math.max(
          0,
          teamLimit.limit - teammates.length,
        )}`,
    )
    lines.push(`- 失败：agent 拉起失败 ${failedSpawns.length} 个${failedMembers.length ? `，成员 failed ${failedMembers.map((m) => m.name).join(', ')}` : ''}`)
    if (workingRows.length) {
      lines.push('')
      lines.push('### 进行中（agent 正在做）', '')
      for (const row of workingRows) {
        const platformState = row.solved === true ? '已解' : row.solved === null ? '平台状态未知' : '平台未解'
        lines.push(
          `- ${cell(row.title)}｜${cell(row.category)}｜${cell(row.score)}分｜${cell(row.type)}｜任务 ${row.taskId}｜owner=${cell(row.owner)}｜${platformState}${
            row.env !== '-' ? `｜环境 ${row.env}` : ''
          }`,
        )
      }
    }
    if (slotRows.length) {
      lines.push('')
      lines.push(
        `### 🧩 Agent 池（${slotRows.length} 槽：活跃 ${
          slotRows.filter((row) => row.kind === 'active').length
        } / 闲置可复用 ${idleSlotsInStatus.length} / 占用不可挪 ${
          slotRows.filter((row) => row.kind === 'busy').length
        }${slotRows.some((row) => row.kind === 'prep') ? ` / 准备槽 ${slotRows.filter((row) => row.kind === 'prep').length}` : ''}${
          slotRows.some((row) => row.kind === 'failed') ? ` / failed ${slotRows.filter((row) => row.kind === 'failed').length}` : ''
        }）`,
        '',
      )
      for (const row of slotRows) {
        const tag =
          row.kind === 'active'
            ? `🏃 活跃（当前 ${row.label}）`
            : row.kind === 'idle'
              ? `♻️ 闲置可复用（原 ${row.label} 已结束 → 下一个 ctf_solve_start 会派新题）`
              : row.kind === 'failed'
                ? '⛔ failed（不可复用，但仍占名额）'
                : row.kind === 'prep'
                  ? `🌙 准备槽（${row.label} 等环境配额，P0 已完成/进行中，不可挪用）`
                : row.kind === 'busy'
                  ? `🔒 占用中（${row.label} 未结束，不可挪用 —— 可能在等环境配额）`
                  : `❔ 状态未知（${row.label}）`
        lines.push(`- ${row.name}：${tag}`)
      }
      lines.push(
        '',
        '说明：DSH 的 roster 是**累计且不可回收**的（`maxMembers` 数的是「曾创建过」的 teammate，含失败的），',
        '所以闲置槽会被复用去接新题（`send_message` 唤醒 + 换题纪律），而不是每题新建；`reuseAgents=false` 可关掉复用。',
      )
    }
    if (readyRows.length) {
      lines.push('')
      lines.push(`### ⏳ 就绪待环境（${readyRows.length} 题：PREP.md 已就绪，拿到环境就能立刻出 flag）`, '')
      for (const row of readyRows) {
        lines.push(
          `- ${cell(row.title)}｜${cell(row.score)}分｜${cell(row.type)}` +
            `${row.prepName ? `｜准备 agent: ${row.prepName}` : ''}｜PREP.md 已就绪`,
        )
      }
      lines.push(
        '',
        '提示：环境释放后 `ctf_solve_start` 会把配额优先给这些题（scoreChallenge 对「已就绪」大幅升权）；',
        '      也可以直接 `send_message` 通知上面的准备 agent 接手 P1。',
      )
    }
    if (preppingRows.length) {
      lines.push('')
      lines.push(`### 🔧 准备中（${preppingRows.length} 题：离线准备 agent 在做 P0，还没写 PREP.md）`, '')
      for (const row of preppingRows) {
        lines.push(`- ${cell(row.title)}｜${cell(row.score)}分｜准备 agent: ${row.prepName || '-'}`)
      }
    }
    if (stalledRows.length) {
      lines.push('')
      lines.push(`### ⚠️ 环境占用异常（${stalledRows.length} 题：占着配额但长时间无进展 —— 只提示，不自动抢占）`, '')
      for (const row of stalledRows) {
        const remain = row.envRemainingSeconds != null ? `剩余 ${Math.max(1, Math.round(row.envRemainingSeconds / 60))}m` : '剩余未知'
        lines.push(
          `- ${cell(row.title)}：环境空转 ${row.idleMinutes} 分钟｜${remain}` +
            (row.suggestRelease
              ? ` → ♻️ 建议释放让位（剩余不足 ${LIMITS.envStallReleaseSeconds / 60} 分钟且已停滞）：ctf_release_env id=${row.cid}`
              : ` → 要么 ctf_delay_env id=${row.cid} 续期，要么 ctf_release_env id=${row.cid} 让给就绪的题`),
        )
      }
      lines.push('', '（agent 可能正在最后一步，所以这里只提示；确认停滞后由 Lead 决定是否释放。）')
    }
    if (envQueueRows.length) {
      lines.push('')
      lines.push(
        `### 环境型待派（${envQueueRows.length} 题：没环境配额也没并发槽位 → 下一轮 ctf_solve_start 会先派离线准备 agent 做 P0）`,
        '',
      )
      for (const row of envQueueRows) {
        lines.push(`- ${cell(row.title)}｜${cell(row.score)}分｜任务 ${row.taskId}｜owner=${cell(row.owner)}`)
      }
    }
    if (envHogs.length) {
      lines.push('')
      lines.push('### ♻️ 已解出但仍在占用环境（建议立刻释放让位）', '')
      for (const row of envHogs) {
        lines.push(`- ${cell(row.title)}（challengeId=${row.cid}，${row.env}）→ ctf_release_env id=${row.cid}`)
      }
    }
    if (failedSpawns.length) {
      lines.push('')
      lines.push('### 拉起失败的题目', '')
      for (const item of failedSpawns) {
        lines.push(`- challengeId=${item.challengeId ?? '-'}：${item.error ?? '未知错误'}`)
      }
    }
    lines.push('')
    lines.push(`生成于 ${stamp()}。`)
    // 「协同交流」采集：状态查询留一条 status 记录（正文相同则去抖，不重复落盘）
    await logTeamMessage(
      'status',
      [
        `ctf_solve_status：任务板 ${tasks.length}（进行中 ${inProgress}，待认领 ${pending}，已完成 ${completed}），成员 ${teammates.length}（running ${running}）`,
        sessionExpired
          ? '🛑 平台 sessionid 已失效：agent 的提交都会失败，请更新 Cookie 后重新 ctf_solve_start'
          : challenges
            ? `平台：已解 ${solvedCount}/${challenges.length}`
            : '平台：题目列表不可用',
        ...(workingRows.length
          ? [`进行中（agent 正在做）${workingRows.length} 题：${workingRows.map((row) => `${row.title} @${row.owner}`).join('、')}`]
          : []),
        `环境占用 ${heldEnvRows.length}/${envState.limit}（${envState.source}）${
          envQueueRows.length ? `；环境型排队 ${envQueueRows.length} 题` : ''
        }`,
        ...(envHogs.length ? [`♻️ 已解出仍占环境 ${envHogs.length} 题：${envHogs.map((row) => `#${row.cid} ctf_release_env id=${row.cid}`).join('、')}`] : []),
      ].join('\n'),
      connKey,
    )
    return lines.join('\n')
  }

  // -------------------------------------------------------------- stop

  async function stop(args = {}) {
    const api = requireTeams(['listMembers', 'interrupt'])
    const caller = requireCaller(args)

    const members = await safeListMembers(api, caller)
    const teammates = members.filter((member) => member?.role !== 'lead' && member?.name !== 'lead')
    const explicit = Array.isArray(args.names) ? args.names.map((n) => String(n).trim()).filter(Boolean) : []
    const targets = explicit.length ? explicit : teammates.map((m) => String(m.name))
    const before = new Map(teammates.map((m) => [String(m.name), m.status]))

    const interrupted = []
    const failed = []
    for (const name of targets) {
      try {
        const result = await api.interrupt(caller, name)
        interrupted.push({ name, previousStatus: result?.previousStatus ?? before.get(name) ?? 'unknown' })
      } catch (error) {
        failed.push({ name, message: error?.message ?? String(error) })
        log('warn', `中断 ${name} 失败：${error?.message ?? error}`)
      }
    }

    /**
     * 被中断的槽会把名下题标为 `abandoned`：
     * 1. 语义正确：agent 被停掉了，那道题不再有人做；
     * 2. 槽因此满足「闲置」条件（原题已结束），可以被下一个 `ctf_solve_start` 复用到新题。
     * 同时清掉 `teammate`，否则 `readBoardState` 会把旧题一直当成「已有 agent」，永远派不出去。
     */
    if (interrupted.length) {
      const names = new Set(interrupted.map((item) => String(item.name)))
      const rows = await readWork(undefined)
      for (const record of rows) {
        const name = String(record?.teammate ?? '')
        if (!name || !names.has(name) || record?.challengeId == null) continue
        await rememberWork(record.connKey, safeId(record.challengeId), {
          status: 'abandoned',
          teammate: '',
          slotOwner: name, // 槽的历史归属：清掉 teammate 后仍知道这个槽做过哪道题（闲置判定要用）
          previousTeammate: name,
          abandonedAt: stamp(),
        })
      }
    }

    const released = []
    const releaseFailures = []
    const releaseEnvs = args.releaseEnvs === true || args.release === true
    if (releaseEnvs) {
      try {
        const { adapter, connection, connKey } = await resolvePlatform(args)
        const ids = new Set()
        for (const id of Array.isArray(args.challengeIds) ? args.challengeIds : []) ids.add(String(id))
        const work = await readWork(connKey)

        /**
         * 「这道题有没有起过环境」的**唯一可信来源**是 work 记录：
         * `ctf_start_env` 成功后会写 `envStarted: true`（lib/tools.js）。
         * 任务状态（in_progress）只能说明 agent 在解题，**不代表这题有环境** ——
         * 附件题（凌虚 task_type=2）对平台调 release 会返回 400「该题目没有选择对应的环境」。
         */
        const startedById = new Map()
        for (const record of work) {
          const started = envRecordStarted(record)
          if (record?.challengeId != null) startedById.set(String(record.challengeId), record)
          if (started && record?.envReleased !== true && record?.challengeId != null) ids.add(String(record.challengeId))
        }

        // 兜底：任务在跑、但 work 记录里没有「已启动」标记时**不做任何事**。
        // 只有 work 明确记录过 envStarted 且尚未释放的题才允许补进释放列表。
        for (const task of await safeListTasks(api, caller)) {
          if (task?.status !== 'in_progress') continue
          const cid = parseChallengeId(task?.description) ?? challengeIdFromScope(task?.writeScopes)
          if (!cid) continue
          const record = startedById.get(String(cid))
          if (envRecordStarted(record) && record?.envReleased !== true) ids.add(String(cid))
        }

        for (const id of ids) {
          try {
            const result = await adapter.releaseEnvironment(id)
            released.push({
              id,
              // theory-dev 新增：平台/赛事未配置环境（不再抛错，而是带标记返回）
              kind: String(result?.kind ?? ''),
              idempotent: Boolean(result?.idempotent),
              unsupported: Boolean(result?.unsupported),
              notConfigured: Boolean(result?.notConfigured),
            })
            await rememberWork(connKey, id, { envReleased: true, envStarted: false })
          } catch (error) {
            releaseFailures.push({ id, message: error?.message ?? String(error) })
            log('warn', `释放环境失败（challenge ${id}）：${error?.message ?? error}`)
          }
        }
      } catch (error) {
        releaseFailures.push({ id: '-', message: `解析平台连接失败：${error?.message ?? error}` })
      }
    }

    const lines = ['## 编排已停止', '']
    if (args.reason) lines.push(`- 停止原因：${cell(args.reason)}`)
    lines.push(`- 中断 agent：${interrupted.length} 个${failed.length ? `，失败 ${failed.length} 个` : ''}`)
    for (const item of interrupted) lines.push(`  - ${item.name}（中断前 status=${item.previousStatus}）`)
    for (const item of failed) lines.push(`  - ${item.name}：${item.message}`)
    if (releaseEnvs) {
      // 四分类摘要：成功释放 / 本来就没环境（幂等）/ 平台未配置环境 / 失败
      const notConfigured = released.filter((item) => item.notConfigured)
      const noEnv = released.filter((item) => !item.notConfigured && item.idempotent)
      const okReleased = released.filter((item) => !item.notConfigured && !item.idempotent)
      lines.push(
        `- 释放环境：${okReleased.length} 个成功，${noEnv.length} 个本来就没环境，${notConfigured.length} 个平台未配置环境` +
          `${releaseFailures.length ? `，${releaseFailures.length} 个失败` : ''}`,
      )
      for (const item of released) {
        // `idempotent` 有两种语义：本来就没环境（no-env）/ 此前已释放或正在释放（released）
        const suffix = item.notConfigured
          ? '（平台未配置环境，跳过）'
          : item.idempotent
            ? item.kind === 'released'
              ? '（幂等：此前已释放或正在释放）'
              : '（幂等：本来就无环境）'
            : ''
        lines.push(`  - challengeId=${item.id}${suffix}${item.unsupported ? '（平台不支持）' : ''}`)
      }
      for (const item of releaseFailures) lines.push(`  - challengeId=${item.id}：${item.message}`)
    } else {
      lines.push('- 环境未释放（releaseEnvs=false）；如需释放请再调用 ctf_solve_stop releaseEnvs=true。')
    }
    if (!targets.length) lines.push('- 没有可中断的 teammate（当前名单为空）。')
    lines.push('')
    lines.push(`生成于 ${stamp()}。`)
    // 「协同交流」采集：停止动作留一条 stop 记录
    await logTeamMessage(
      'stop',
      [
        `ctf_solve_stop：中断 ${interrupted.length} 个${failed.length ? `（失败 ${failed.length}）` : ''}，环境${
          releaseEnvs ? `释放 ${released.length} 个${releaseFailures.length ? `（失败 ${releaseFailures.length}）` : ''}` : '未释放'
        }`,
        ...(args.reason ? [`原因：${cell(args.reason)}`] : []),
        ...(interrupted.length ? [`成员：${interrupted.map((item) => item.name).join(', ')}`] : []),
      ].join('\n'),
      await tryConnKey(args),
    )
    return lines.join('\n')
  }

  /**
   * 本会话捕获到的 Team Lead 身份（`ctf_solve_*` 调用者）。
   * `GET /lingxu-ctf/team` 用它读任务板与成员名单 —— HTTP 路由没有 `exec`，只能靠这里。
   *
   * 优先返回 `ctf_solve_*` 捕获的 Lead；没有时退化用装配层（index.js）
   * 对**所有** `ctf_*` 工具捕获的最近调用者，保证「没跑过 solve_*」也能看到团队。
   */
  function getCaller() {
    return sessionCaller ?? sessionRef?.caller ?? null
  }

  return { start, status, stop, getCaller }
}

export default createOrchestrator
