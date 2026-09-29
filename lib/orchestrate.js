/**
 * Agent Teams 并发解题编排 —— `ctf_solve_start` / `ctf_solve_status` / `ctf_solve_stop` 的实现。
 *
 * 设计要点：
 * - 只依赖 `deps.teams`（= `ctx.agentTeams`），不 import 任何 `@deepseek-ai/*` 包。
 * - 题目过滤 / 排序 / 截断是纯函数（`selectChallenges`），便于单测与复用。
 * - **两种 slug 分工**：teammate 名走 `memberSlug`（ASCII lower-kebab-case，DSH 强制）；
 *   `writeScope` / 本地目录走 `pathSlug`（保留中文可读性，与 index.js/writeup.js 的目录约定一致）。
 * - **limit 缺省 = 全部选中题目**（硬上限 200）：共享任务板就是完整队列，agent 做完一道领下一道；
 *   并发只由 `concurrency` 控制。
 * - teammate 名字必须满足 DSH 的 `^[a-z0-9]+(?:-[a-z0-9]+)*$`、≤64 字符、不能叫 `lead`，
 *   且**永久占用**（失败的名字也不会被释放）→ 统一走 `sanitizeSlug` + `allocateName`。
 * - spawn 失败（重名 / 成员上限）记录后继续，绝不整体崩。
 * - `start` 幂等：已在任务板上（pending / in_progress）的题目默认跳过，避免重复建任务、重复起 agent；
 *   需要重跑时传 `force: true`。
 *
 * ⚠️ Agent Teams 真实服务契约（已核对 dsh-experimental-agent-team 源码，与 DSH-API-NOTES 略有出入）：
 * - `spawnTeammate(caller, { name, description, prompt: ContentBlock[], context, provider, signal })`
 *   `provider` 与 `signal` 是**必填**（内部 `AbortSignal.any([request.signal, ...])`，缺 signal 直接 TypeError）。
 * - `createTask(caller, { subject, description, writeScopes })`
 * - `listTasks(caller)` → `[{ id, revision, subject, description, status, ownerName?, blockedBy, writeScopes, ready }]`
 * - `updateTask(caller, { taskId, expectedRevision, action })` —— 服务层字段名是 **taskId**（工具层 `task_id`）；
 *   本模块同时带上 `id` 以兼容包装层。
 * - `sendMessage(caller, { target, content: ContentBlock[], signal })` —— 服务层字段名是 **content**，不是 `message`。
 * - `listMembers(caller)` → 首行是 lead，teammate 行 status ∈ running|inactive|provisioning|failed。
 * - `interrupt(caller, name)`。
 *
 * ⚠️ **机器可读契约**（`GET /lingxu-ctf/team` 与顶部「CTF」视图按它解析，改格式 = 破坏兼容）：
 * 1. 任务 description 的**独立一行**固定为 `challengeId: <id>`（见 `buildTaskDescription`）；
 * 2. teammate description 固定为 `解题 teammate：<分类>/<题名>（<分值>分，challengeId=<id>）`
 *    （见 `buildMemberDescription`）；
 * 3. 任务 subject 固定为 `[<分类>] <题名> (<分值>分)`（见 `taskSubjectFor`）。
 * 对应的解析函数（都对畸形输入返回 null，不抛）：`parseChallengeId` / `parseMemberDescription` /
 * `parseTaskSubject`，以及从 writeScope 反解的 `challengeIdFromScope`。
 */

import { connectionKey } from './store.js'

/** 编排相关硬限制（供工具层校验复用）。 */
export const LIMITS = {
  maxConcurrency: 8, // DESIGN.md：并发上限 8
  defaultConcurrency: 4, // DESIGN.md：默认 4
  maxLimit: 200, // 单次建任务上限（任务板 maxTasks 默认 256，留余量）
  maxTeamMembers: 16, // ctx.agentTeams maxMembers 默认 16（含 lead）
  maxMemberNameLength: 64, // DSH 强制
  maxSpawnAttempts: 3, // 重名重试次数
  slugMaxLength: 32, // teammate 名（ASCII）slug 截断长度
  maxPathSlugChars: 60, // 路径 slug 截断码点数（与 index.js slugify 对齐）
}

const DEFAULT_WORK_DIR = 'lingxu-ctf-work'
const FRESH_PROVIDER = 'spawn'
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

/** 题目 → teammate 名字（含长度兜底，保证满足 DSH 命名规则）。 */
export function teammateNameFor(challenge, { slug } = {}) {
  const idPart = safeId(challenge?.id)
  const rawSlug = slug || memberSlug(challenge)
  const budget = Math.max(3, LIMITS.maxMemberNameLength - 'solver-'.length - 1 - idPart.length - 12)
  const trimmed = rawSlug.slice(0, budget).replace(/-+$/, '') || 'ch'
  return fitMemberName(`solver-${trimmed}-${idPart}`)
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
 */
export function buildSolverPrompt({ name, challenge, taskId, connection, connKey, workDir }) {
  const category = String(challenge?.category ?? '').trim() || '未分类'
  const score = Number(challenge?.score ?? 0)
  const id = safeId(challenge?.id)
  const dirSlug = pathSlug(challenge?.name || challenge?.category, challenge?.id)
  const scope = writeScopeFor(challenge, dirSlug)
  const dir = `${workDir || DEFAULT_WORK_DIR}/challenges/${dirSlug}-${id}`
  const subject = taskSubjectFor(challenge)

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
- 共享任务板任务：${taskId}（subject：${subject}）
- 工作目录：${dir}（只允许在这里写文件）

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

## 约束
- 只解本题，不要动别人的题目与目录。
- 卡住 / 失败也要汇报（send_message 找 lead），不要静默结束。
- 共享任务板就是去重手段：本题任务已被你 claim，不要重复建任务。
- 若平台工具缺少 \`connection\` 参数，直接调用即可（默认走活动连接）。

验收标准：ctf_submit_flag 返回 correct / already_solved，且 ${scope}/ 下存在 WP 文件。`

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
 *   config?: object,
 *   store?: object,
 *   resolveAdapter?: (args: object) => Promise<{ adapter: object, connection: object }>,
 *   teams?: object,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   now?: () => number,
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

  const workDir = String(config.workDir ?? DEFAULT_WORK_DIR).replace(/\/+$/, '') || DEFAULT_WORK_DIR

  /** 本会话最近一次 `ctf_solve_*` 调用者（= Team Lead 身份），供 /lingxu-ctf/team 读取团队数据。 */
  let sessionCaller = null
  /** 装配层注入的会话身份槽（index.js 的 withSessionCapture 会写它）。 */
  const sessionRef = deps.session && typeof deps.session === 'object' ? deps.session : null
  /** 上一条团队消息正文：连续重复（例如反复轮询 status）不再落盘，避免刷掉真正的汇报。 */
  let lastTeamMessage = ''

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
    return { adapter, connection: result?.connection ?? {}, connKey: connKeyOf(result?.connection) }
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
  async function activeTaskChallengeIds(api, caller) {
    const tasks = await safeListTasks(api, caller)
    const ids = new Set()
    for (const task of tasks) {
      if (task?.status === 'completed' || task?.status === 'deleted') continue
      const cid = parseChallengeId(task?.description) ?? challengeIdFromScope(task?.writeScopes)
      if (cid) ids.add(String(cid))
    }
    return ids
  }

  // -------------------------------------------------------------- start

  async function start(args = {}) {
    const api = requireTeams(['spawnTeammate', 'createTask', 'listTasks', 'listMembers'])
    const caller = requireCaller(args)
    const concurrency = resolveConcurrency(args.concurrency, config.concurrency)
    const limit = resolveLimit(args.limit)
    const { adapter, connection, connKey } = await resolvePlatform(args)

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
    const boarded = args.force === true ? new Set() : await activeTaskChallengeIds(api, caller)
    const skipped = candidates.filter((challenge) => boarded.has(String(challenge.id)))
    const selected = candidates.filter((challenge) => !boarded.has(String(challenge.id))).slice(0, limit)
    if (!selected.length) {
      if (skipped.length) {
        return [
          '## 无需编排：题目已在任务板上',
          '',
          `符合条件的 ${candidates.length} 道题目全部已有未完成任务（pending / in_progress），已跳过，避免重复建任务、重复起 agent：`,
          ...skipped.map((challenge) => `- ${taskSubjectFor(challenge)}（challengeId=${safeId(challenge.id)}）`),
          '',
          '如需强制重跑（例如上一轮 agent 已死），请传 force=true。',
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

    // 1) 每题建共享任务
    const entries = []
    const taskFailures = []
    for (const challenge of selected) {
      const slug = memberSlug(challenge) // teammate 名用 ASCII slug
      const writeScope = writeScopeFor(challenge) // 路径用 pathSlug（保留中文）
      const subject = taskSubjectFor(challenge)
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

    // 2) 计算本轮能拉起几个 agent
    const members = await safeListMembers(api, caller)
    const used = new Set(members.map((member) => String(member?.name ?? '')))
    const teammates = members.filter((member) => member?.role !== 'lead' && member?.name !== 'lead')
    const busy = teammates.filter((m) => m.status === 'running' || m.status === 'provisioning').length
    const teamRoom = Math.max(0, LIMITS.maxTeamMembers - members.length)
    const slots = Math.max(0, Math.min(concurrency - busy, teamRoom, entries.length))
    const seed = now().toString(36)

    // 3) 逐个 spawn（失败记录后继续；名字冲突换名重试）
    const spawned = []
    const spawnFailures = []
    let limitHit = false
    for (const entry of entries) {
      if (spawned.length >= slots || limitHit) break
      const base = teammateNameFor(entry.challenge, { slug: entry.slug })
      let name = allocateName(base, used, seed)
      let member = null
      let lastError = null
      for (let attempt = 1; attempt <= LIMITS.maxSpawnAttempts && !member; attempt += 1) {
        try {
          const result = await api.spawnTeammate(caller, {
            name,
            description: buildMemberDescription(entry.challenge), // ← 契约行，见文件头
            prompt: buildSolverPrompt({
              name,
              challenge: entry.challenge,
              taskId: entry.taskId,
              connection,
              connKey,
              workDir,
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
            limitHit = true
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
        await rememberWork(connKey, safeId(entry.challenge.id), {
          status: 'solving',
          teammate: memberName,
          taskId: entry.taskId,
        })
        log('info', `已拉起 ${memberName} → ${entry.subject}`)
      } else {
        const message = lastError?.message ?? String(lastError ?? '未知错误')
        spawnFailures.push({ ...entry, name, message })
        await rememberWork(connKey, safeId(entry.challenge.id), { status: 'spawn_failed', error: message })
        log('warn', `拉起 agent 失败（${entry.challenge?.name}）：${message}`)
      }
    }

    const spawnedIds = new Set(spawned.map((s) => String(s.challenge?.id)))
    const queued = entries.filter((entry) => !spawnedIds.has(String(entry.challenge?.id)))

    const lines = [
      '## 编排已启动',
      '',
      `- 平台：${connection?.platform ?? 'lingxu'} ${connection?.baseUrl ?? ''}（eventId=${connection?.eventId ?? '-'}，连接 key=${connKey}）`,
      `- 题目：平台共 ${Array.isArray(allChallenges) ? allChallenges.length : 0} 道 → 过滤后 ${candidates.length} 道${
        skipped.length ? `（跳过已在任务板 ${skipped.length} 道）` : ''
      } → 本轮处理 ${selected.length} 道（limit=${
        args.limit == null || args.limit === '' ? `全部，≤${limit}` : limit
      }）`,
      `- 任务板：创建 ${entries.length} 个任务${taskFailures.length ? `，失败 ${taskFailures.length} 个` : ''}`,
      `- 并发：上限 ${concurrency}（本插件硬上限 ${LIMITS.maxConcurrency}），当前在跑/在起 ${busy} 个 → 本轮拉起 ${spawned.length} 个`,
      `- 团队余量：成员 ${members.length}/${LIMITS.maxTeamMembers}，可用名额 ${teamRoom}`,
      '',
    ]
    if (spawned.length) {
      lines.push('### 已拉起', '')
      for (const item of spawned) {
        lines.push(
          `- ${item.name} → ${item.taskId} ${item.subject}（status=${item.status}，scope=${item.writeScope}）`,
        )
      }
      lines.push('')
    }
    if (queued.length) {
      lines.push(`### 排队中（${queued.length} 题，等 agent 空出来再 start）`, '')
      for (const item of queued) {
        lines.push(`- ${item.taskId} ${item.subject}`)
      }
      lines.push('')
    }
    if (skipped.length) {
      lines.push(`### 已在任务板（跳过 ${skipped.length} 题；force=true 可强制重跑）`, '')
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
    if (!spawned.length) {
      lines.push(
        limitHit
          ? `未拉起新 agent：已达到 Agent Teams 成员上限（${LIMITS.maxTeamMembers}）。`
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
        `ctf_solve_start：创建任务 ${entries.length} 个，拉起 agent ${spawned.length} 个（并发上限 ${concurrency}）`,
        ...spawned.map((item) => `- ${item.name} → ${item.taskId} ${item.subject}`),
        ...(queued.length ? [`排队 ${queued.length} 题：${queued.map((item) => item.taskId).join(', ')}`] : []),
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
    let connKey = null
    try {
      const platform = await resolvePlatform(args)
      connKey = platform.connKey
      const rows = await platform.adapter.challenges()
      challenges = Array.isArray(rows) ? rows : []
    } catch (error) {
      platformError = error?.message ?? String(error)
    }

    const work = await readWork(connKey || undefined)
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
     *    status=solving。用户反馈「进行中也看不到」主要就是这个空窗期。
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
      })
    }

    // 平台未解但 agent 正在跑的题目（用户最关心的「进行中」口径）
    const workingRows = rows.filter((row) => row.working && row.solved !== true)

    const solvedCount = (challenges ?? []).filter((c) => c?.solved === true).length
    const inProgress = tasks.filter((t) => t?.status === 'in_progress').length
    const pending = tasks.filter((t) => t?.status === 'pending').length
    const completed = tasks.filter((t) => t?.status === 'completed').length
    const failedMembers = teammates.filter((m) => m?.status === 'failed')
    const failedSpawns = work.filter((w) => w?.status === 'spawn_failed')
    const running = teammates.filter((m) => m?.status === 'running').length
    const inactive = teammates.filter((m) => m?.status === 'inactive').length
    const provisioning = teammates.filter((m) => m?.status === 'provisioning').length

    const lines = ['## 团队进度', '']
    if (platformError) {
      lines.push(`> ⚠️ 平台题目列表获取失败：${platformError}（仅显示任务板）`, '')
    } else {
      lines.push(`平台：${args.platform ?? '当前连接'}${connKey ? `（key=${connKey}）` : ''}`, '')
    }
    lines.push('| 题目 | 分类 | 分值 | 任务 | 任务状态 | owner | 平台 |')
    lines.push('|---|---|---|---|---|---|---|')
    if (!rows.length) {
      lines.push('| （无） | - | - | - | - | - | - |')
    } else {
      for (const row of rows) {
        lines.push(
          `| ${cell(row.title)} | ${cell(row.category)} | ${cell(row.score)} | ${cell(row.taskId)} | ${cell(
            fmtTaskStatus(row.status),
          )} | ${cell(row.owner)} | ${cell(platformLabel(row))} |`,
        )
      }
    }
    lines.push('')
    lines.push('### 统计', '')
    lines.push(
      `- 平台：已解 ${solvedCount}${challenges ? ` / 共 ${challenges.length}` : ''} 题；未建任务 ${rows.filter((r) => r.taskId === '-').length} 题`,
    )
    lines.push(`- 任务板：共 ${tasks.length}（进行中 ${inProgress}，待认领 ${pending}，已完成 ${completed}）`)
    lines.push(`- 进行中（agent 正在做）：${workingRows.length} 题${workingRows.length ? '，平台侧可能仍显示未解' : ''}`)
    lines.push(
      `- 成员：共 ${teammates.length}（running ${running}，inactive ${inactive}，provisioning ${provisioning}，failed ${failedMembers.length}）`,
    )
    lines.push(`- 失败：agent 拉起失败 ${failedSpawns.length} 个${failedMembers.length ? `，成员 failed ${failedMembers.map((m) => m.name).join(', ')}` : ''}`)
    if (workingRows.length) {
      lines.push('')
      lines.push('### 进行中（agent 正在做）', '')
      for (const row of workingRows) {
        const platformState = row.solved === true ? '已解' : row.solved === null ? '平台状态未知' : '平台未解'
        lines.push(
          `- ${cell(row.title)}｜${cell(row.category)}｜${cell(row.score)}分｜任务 ${row.taskId}｜owner=${cell(row.owner)}｜${platformState}`,
        )
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
        ...(challenges ? [`平台：已解 ${solvedCount}/${challenges.length}`] : ['平台：题目列表不可用']),
        ...(workingRows.length
          ? [`进行中（agent 正在做）${workingRows.length} 题：${workingRows.map((row) => `${row.title} @${row.owner}`).join('、')}`]
          : []),
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
