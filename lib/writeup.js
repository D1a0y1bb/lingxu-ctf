/**
 * WP（writeup）自动生成与提交。
 *
 * 设计约束：
 * - **不 import 任何 `@deepseek-ai/*` 包**；平台/存储能力全部由 `deps` 注入，便于单测。
 * - 只依赖 `node:fs` / `node:path` 以及同层的纯函数（`store.connectionKey`、`lingxu.htmlToMarkdown`）。
 * - 依赖方向：writeup → platforms/store/lingxu（反向依赖禁止）。
 *
 * deps 形状（由 lib/index.js 装配）：
 *  {
 *    config,          // { workDir, ... }
 *    store,           // CtfStore
 *    resolveAdapter,  // async (args) => { adapter, connection }
 *    logger,          // 可选
 *    now,             // 可选，() => number(ms)
 *    fs,              // 可选，node:fs/promises 兼容对象
 *  }
 *
 * 对外 API：
 *  generate({ challengeId, connection?, body?, force?, submit?, title?, __agent? })
 *    -> { ok, action:'generate', challengeId, connKey, title, slug, path, bytes,
 *         generatedAt, sections[], preview, summary, skipped?, submitted? }
 *    省略 challengeId 时退化为「已解题目批量生成」：
 *    -> { ok, action:'generate-batch', count, okCount, items[], summary }
 *  submit({ challengeId, connection?, writeupId? })
 *    -> { ok, action:'submit', platform, challengeId, writeupId, path, title, bytes,
 *         message, unsupported?, summary }
 *  list({ connection? })
 *    -> { ok, action:'list', platform, count, items[], summary }
 *
 * 命名说明：模块级 API 用 `challengeId`；模型可见的 `ctf_writeup` 工具主参数名是 `id`
 * （`lib/tools.js` 会做 `args.id ?? args.challengeId` 归一化后传入），旧写法 `challengeId` 仍可用。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { connectionKey } from './store.js'
import { htmlToMarkdown } from './lingxu.js'

const MAX_SLUG_CHARS = 60
const MAX_INLINE_SCRIPTS = 3
const MAX_INLINE_SCRIPT_BYTES = 8192
const SUBMISSION_SCAN_LIMIT = 500
const PREVIEW_CHARS = 600
/** 省略 challengeId 时的批量生成上限，避免一次调用写爆磁盘/上下文。 */
const MAX_BATCH_WRITEUPS = 50

/** 可作为「复现脚本」内联的扩展名 → Markdown 代码块语言。 */
const SCRIPT_LANGUAGES = new Map([
  ['.py', 'python'],
  ['.sage', 'python'],
  ['.sh', 'bash'],
  ['.bash', 'bash'],
  ['.zsh', 'bash'],
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.ts', 'typescript'],
  ['.rb', 'ruby'],
  ['.pl', 'perl'],
  ['.php', 'php'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.java', 'java'],
  ['.cs', 'csharp'],
  ['.sql', 'sql'],
  ['.http', 'http'],
  ['.json', 'json'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
  ['.txt', 'text'],
  ['.md', 'markdown'],
])

// ------------------------------------------------------------------ 工具函数

const STATUS_LABEL = {
  correct: '✅ 正确',
  incorrect: '❌ 错误',
  already_solved: '↩️ 已提交过正确 flag',
  unknown: '❓ 未知',
  pending: '⏳ 待确认',
}

/**
 * 题名 → 文件名 slug（**全仓库统一规则**，与 `lib/index.js` 的 `slugify`、
 * `lib/orchestrate.js` 的 `pathSlug`、`lib/tools.js` 的 `slugify` 保持一致）。
 *
 * 规则：只把「路径危险字符 `<>:"/\|?*` + 控制字符（C0 / DEL / C1）」替换成 `-`，
 * **保留** `!`、`()`、`☕`、中文等可读字符；空白折叠为 `-`、折叠连续 `-`、
 * 去掉首尾 `-_.`、按**码点**截断 60（不会切断代理对）。
 * 退化题名（纯符号/空白/控制字符）统一回退**裸 `challenge`**，与 index/orchestrate/tools 一致；
 * 题目 id 由 `writeupFileName()` 单独拼接（`challenge-12.md`），不会重复出现。
 *
 * 注意：与 `lib/index.js` 逐字对齐是目录契约（编排层用它决定 solver 工作目录，
 * 本模块用它定位复现脚本）；唯一有意为之的差异是截断按码点而非 UTF-16 单元，
 * 避免在 60 字符边界切断 emoji 产生孤立代理项。
 *
 * @param {unknown} input 题名
 * @param {unknown} _legacyFallbackId 历史参数（旧版用于拼 `challenge-<id>`），现已忽略，仅为兼容旧调用保留
 */
export function slugify(input, _legacyFallbackId) {
  let text = String(input ?? '')
    .trim()
    .toLowerCase()
    // 控制字符（C0 / DEL / C1）与路径危险字符；其余符号（! ( ) ☕ 中文 …）保留可读性
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')

  const chars = Array.from(text)
  if (chars.length > MAX_SLUG_CHARS) {
    text = chars
      .slice(0, MAX_SLUG_CHARS)
      .join('')
      .replace(/[-.]+$/g, '')
  }
  return text || 'challenge'
}

/**
 * 解析工作目录。
 *
 * 优先级与理由：
 *  ① `config.workDir`（用户在设置里明确指定）—— 相对路径按**会话 cwd**（`hint`）解析；
 *  ② `hint`（调用方从 `exec.cwd` / `exec.agent.session.header.cwd` 拿到的**会话工作目录**）
 *     → `<hint>/lingxu-ctf-work`；
 *  ③ `os.homedir()/lingxu-ctf-work`（最后的兜底，**并会让调用方在输出里警告用户**）。
 *
 * 不使用 `process.cwd()`：插件进程的 cwd 可能是 DSH profile 目录
 * （实测 `~/.dsh/profiles/desktop`，因为插件在 profile 里是软链），
 * 用它会把 WP/附件写到「插件安装处」而不是用户的工作区 —— 这正是用户报的
 * 「没有往工作区目录写东西 / 工作区位置目录不对」。
 */
export function resolveWorkDir(config = {}, hint = '') {
  const configured = String(config?.workDir ?? '').trim()
  if (configured) {
    if (path.isAbsolute(configured)) return configured
    return path.join(String(hint ?? '').trim() || os.homedir(), configured)
  }
  const base = String(hint ?? '').trim()
  if (base) return path.join(base, 'lingxu-ctf-work')
  return path.join(os.homedir(), 'lingxu-ctf-work')
}

/** WP 落盘目录：`<workDir>/writeups/`。 */
export function writeupDir(workDir) {
  return path.join(workDir, 'writeups')
}

/** WP 文件名：`<slug>-<challengeId>.md`。 */
export function writeupFileName(slug, challengeId) {
  return `${slug}-${challengeId}.md`
}

function nowDate(now) {
  try {
    const value = typeof now === 'function' ? now() : undefined
    if (value instanceof Date) return value
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  } catch {
    /* 忽略注入的 now 异常，退回系统时间 */
  }
  return new Date()
}

function toDate(value) {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 10 位按秒处理，13 位按毫秒处理
    const ms = value < 1e12 ? value * 1000 : value
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const text = String(value).trim()
  if (!text) return null
  const d = new Date(text)
  return Number.isNaN(d.getTime()) ? null : d
}

function formatTime(value) {
  const d = toDate(value)
  if (!d) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(from, to) {
  const a = toDate(from)
  const b = toDate(to)
  if (!a || !b) return ''
  const ms = b.getTime() - a.getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** Markdown 表格单元格转义。 */
function cell(value) {
  const text = String(value ?? '').trim()
  if (!text) return '-'
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** 用合适的围栏包裹代码块（内容含 ``` 时自动加长围栏）。 */
function fence(code, lang = '') {
  const body = String(code ?? '').replace(/\s+$/, '')
  const ticks = body.includes('```') ? '````' : '```'
  return `${ticks}${lang}\n${body}\n${ticks}`
}

async function pathExists(fsm, target) {
  try {
    await fsm.stat(target)
    return true
  } catch {
    return false
  }
}

function readText(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(readText).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    for (const key of ['text', 'message', 'note', 'summary', 'desc', 'body']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
    }
    return ''
  }
  return String(value).trim()
}

// ------------------------------------------------------------------ 记录读取

function resolveConnKey(connection) {
  if (!connection) return ''
  if (connection.key) return String(connection.key)
  try {
    return connectionKey(connection)
  } catch {
    return `${connection.platform || 'lingxu'}:${connection.baseUrl || ''}:${connection.eventId ?? '-'}`
  }
}

const sameChallenge = (row, challengeId) =>
  row != null && String(row.challengeId ?? row.challenge_id ?? row.id) === String(challengeId)

async function loadWorkRecord(store, connKey, challengeId) {
  if (typeof store?.listChallengeWork !== 'function') return null
  try {
    const rows = await store.listChallengeWork(connKey)
    if (!Array.isArray(rows)) return null
    const hit = rows.find((row) => sameChallenge(row, challengeId))
    return hit || null
  } catch {
    return null
  }
}

async function loadSubmissions(store, connKey, challengeId) {
  const out = []
  const push = (row) => {
    if (!row) return
    if (connKey && row.connKey && String(row.connKey) !== String(connKey)) return
    if (!sameChallenge(row, challengeId)) return
    out.push(row)
  }

  if (typeof store?.recentSubmissions === 'function') {
    try {
      const rows = await store.recentSubmissions(SUBMISSION_SCAN_LIMIT)
      if (Array.isArray(rows)) rows.forEach(push)
    } catch {
      /* 读取失败按无记录处理 */
    }
  }
  // 兜底：审计日志窗口之外的提交记录（recentSubmissions 只取尾部 N 条）
  if (typeof store?.submittedFlagsFor === 'function') {
    try {
      const rows = await store.submittedFlagsFor(connKey, challengeId)
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const exists = out.some((s) => s.at === row.at && s.flag === row.flag && s.status === row.status)
          if (!exists) push({ ...row, connKey, challengeId })
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  const keyOf = (row) => `${row.at ?? ''}|${row.flag ?? ''}|${row.status ?? ''}`
  const seen = new Set()
  const deduped = []
  for (const row of out) {
    const key = keyOf(row)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }
  deduped.sort((a, b) => {
    const ta = toDate(a.at)?.getTime() ?? 0
    const tb = toDate(b.at)?.getTime() ?? 0
    return ta - tb
  })
  return deduped
}

function pickTime(work, keys) {
  for (const key of keys) {
    const value = work?.[key]
    if (value) {
      const d = toDate(value)
      if (d) return d
    }
  }
  return null
}

/** 关键步骤时间线：work 记录字段 + flag 提交审计，按时间排序。 */
function buildTimeline({ work, submissions }) {
  const steps = []
  const seen = new Set()
  const add = (at, text) => {
    const label = String(text || '').trim()
    if (!label) return
    const iso = at ? toDate(at)?.toISOString() || String(at) : ''
    const key = `${iso}|${label}`
    if (seen.has(key)) return
    seen.add(key)
    steps.push({ at: at ? toDate(at) : null, text: label, iso })
  }

  const envStart = pickTime(work, [
    'envStartedAt',
    'envStartAt',
    'environmentStartedAt',
    'environmentAt',
    'startedAt',
    'begunAt',
  ])
  if (envStart) add(envStart, '开启解题环境 / 领取题目')

  const release = pickTime(work, ['envReleasedAt', 'envReleaseAt', 'releasedAt'])
  if (release) add(release, '释放解题环境')

  if (work?.status) add(pickTime(work, ['updatedAt']), `当前状态：${readText(work.status)}`)
  if (work?.approach) add(pickTime(work, ['updatedAt']), `思路记录：${readText(work.approach)}`)

  for (const submission of submissions) {
    const status = STATUS_LABEL[submission.status] || submission.status || 'unknown'
    const message = submission.message ? `（${readText(submission.message)}）` : ''
    add(submission.at, `提交 flag \`${submission.flag ?? ''}\` → ${status}${message}`)
  }

  const solved = pickTime(work, ['solvedAt', 'solved_at', 'flagAcceptedAt', 'finishedAt'])
  if (solved) add(solved, '确认本题解出')

  // 自由文本步骤：work.timeline / work.steps / work.notes / work.log
  for (const key of ['timeline', 'steps', 'notes', 'log']) {
    const value = work?.[key]
    if (!value) continue
    const rows = Array.isArray(value) ? value : [value]
    for (const row of rows) {
      if (row && typeof row === 'object') {
        add(row.at ?? row.time ?? row.timestamp, readText(row) || row.event || row.title)
      } else {
        add(null, readText(row))
      }
    }
  }

  // 有时间的排前面（升序），无时间的按插入顺序排在最后
  const timed = steps.filter((s) => s.at)
  const untimed = steps.filter((s) => !s.at)
  timed.sort((a, b) => a.at.getTime() - b.at.getTime())
  return [...timed, ...untimed]
}

/** 从审计记录里找出「已确认正确」的 flag。 */
function findAcceptedFlags(submissions) {
  const flags = []
  for (const row of submissions) {
    if (row.status !== 'correct' && row.status !== 'already_solved') continue
    const flag = String(row.flag ?? '').trim()
    if (flag && !flags.includes(flag)) flags.push(flag)
  }
  return flags
}

/** 解题思路正文：调用方 body 优先 > store 中的思路字段。 */
function resolveApproach(body, work) {
  const explicit = readText(body)
  if (explicit) return { text: explicit, source: 'body' }
  for (const key of ['approach', 'writeupBody', 'solution', 'summary', 'notes', 'analysis']) {
    const text = readText(work?.[key])
    if (text) return { text, source: key }
  }
  return {
    text: [
      '（暂无解题思路记录。）',
      '',
      '解题 agent 可在调用 `ctf_writeup` 时通过 `body` 参数传入自己总结的思路正文，',
      '或在 store 的题目工作记录里写入 `approach` / `summary` 字段后重新生成。',
    ].join('\n'),
    source: 'none',
  }
}

// ------------------------------------------------------------------ 复现脚本

async function collectScripts(fsm, workDir, { slug, challengeId, work, excludePath }) {
  const found = []
  const push = (target) => {
    if (!target) return
    const text = String(target)
    const abs = path.resolve(path.isAbsolute(text) ? text : path.join(workDir, text))
    if (excludePath && abs === path.resolve(excludePath)) return
    if (!found.includes(abs)) found.push(abs)
  }

  // 1) work 记录里显式登记的脚本
  if (work?.scriptPath) push(work.scriptPath)
  for (const key of ['scripts', 'expPath', 'exploitPath', 'scriptPaths']) {
    const value = work?.[key]
    if (Array.isArray(value)) value.forEach((v) => typeof v === 'string' && push(v))
    else if (typeof value === 'string') push(value)
  }
  for (const candidate of [...found]) {
    if (!(await pathExists(fsm, candidate))) found.splice(found.indexOf(candidate), 1)
  }
  if (found.length >= MAX_INLINE_SCRIPTS) return found.slice(0, MAX_INLINE_SCRIPTS)

  // 2) 约定目录下匹配复现脚本
  const idPattern = new RegExp(`(^|[^0-9])${String(challengeId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`)
  // 题目专属目录：目录名已含题目 id/slug，目录内脚本一律视为该题
  const scopedDirs = [
    path.join(workDir, slug),
    path.join(workDir, `${slug}-${challengeId}`),
    path.join(workDir, 'challenges', `${slug}-${challengeId}`),
  ]
  // 兜底：其他模块（如 orchestrate.js）可能用不同的 slug 规则（中文会被清成 ch），
  // 因此动态发现 challenges/* 下所有「目录名带该题 id」的目录。
  try {
    const entries = await fsm.readdir(path.join(workDir, 'challenges'), { withFileTypes: true })
    for (const entry of entries) {
      const name = String(entry?.name || '')
      if (!name || name.startsWith('.')) continue
      if (name.endsWith(`-${challengeId}`) || idPattern.test(name)) {
        const dir = path.join(workDir, 'challenges', name)
        if (!scopedDirs.includes(dir)) scopedDirs.push(dir)
      }
    }
  } catch {
    /* 目录不存在 */
  }
  // 宽目录：文件名必须能对上题名 slug 或题目 id
  const broadDirs = [path.join(workDir, 'scripts'), path.join(workDir, 'solutions'), workDir]

  const scan = async (dir, { requireNameMatch }) => {
    let entries
    try {
      entries = await fsm.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const names = entries
      .filter((entry) => (entry?.isFile?.() ?? true) && !String(entry.name).startsWith('.'))
      .map((entry) => String(entry.name))
      .sort()
    for (const name of names) {
      if (found.length >= MAX_INLINE_SCRIPTS) return
      const ext = path.extname(name).toLowerCase()
      if (!SCRIPT_LANGUAGES.has(ext)) continue
      if (requireNameMatch) {
        const base = path.basename(name, ext)
        if (!base.includes(slug) && !idPattern.test(base)) continue
      }
      push(path.join(dir, name))
    }
  }

  for (const dir of scopedDirs) {
    if (found.length >= MAX_INLINE_SCRIPTS) break
    await scan(dir, { requireNameMatch: false })
  }
  for (const dir of broadDirs) {
    if (found.length >= MAX_INLINE_SCRIPTS) break
    await scan(dir, { requireNameMatch: true })
  }
  return found.slice(0, MAX_INLINE_SCRIPTS)
}

async function readScript(fsm, file) {
  try {
    const raw = await fsm.readFile(file, 'utf8')
    const bytes = Buffer.byteLength(raw, 'utf8')
    if (bytes <= MAX_INLINE_SCRIPT_BYTES) return { text: raw, truncated: false, bytes }
    return { text: `${raw.slice(0, MAX_INLINE_SCRIPT_BYTES)}\n# …（脚本过长，已截断）`, truncated: true, bytes }
  } catch (error) {
    return { text: `（读取失败：${error?.message || String(error)}）`, truncated: false, bytes: 0, error: true }
  }
}

/** 读取完整文本文件（**不截断**；WP 提交/预览必须用这个，不能复用 readScript）。 */
async function readWholeFile(fsm, file) {
  try {
    const raw = await fsm.readFile(file, 'utf8')
    return { text: raw, bytes: Buffer.byteLength(raw, 'utf8'), error: false }
  } catch (error) {
    return { text: '', bytes: 0, error: true, message: error?.message || String(error) }
  }
}

// ------------------------------------------------------------------ WP 组装

function buildMarkdown({ detail, work, submissions, meta, approach, flags, scripts, workDir, generatedAt }) {
  const title = meta.title
  const accepted = flags.accepted
  const lines = []

  lines.push(`# ${title}`)
  lines.push('')
  lines.push('| 项目 | 值 |')
  lines.push('|---|---|')
  lines.push(`| 题目 ID | ${cell(meta.challengeId)} |`)
  lines.push(`| 分类 | ${cell(meta.category)} |`)
  lines.push(`| 分值 | ${cell(meta.score)} |`)
  lines.push(`| 平台 | ${cell(meta.platform)} |`)
  lines.push(`| 赛事 | ${cell(meta.event)} |`)
  lines.push(`| 解题时间 | ${cell(meta.solveWindow)} |`)
  lines.push(`| 生成时间 | ${cell(generatedAt)} |`)
  lines.push('')

  lines.push('## 题目描述')
  lines.push('')
  lines.push(meta.description || '（平台未返回题面。）')
  lines.push('')
  if (meta.attachment) {
    lines.push(`- 附件：${meta.attachment}`)
  }
  if (meta.connectionInfo) {
    lines.push('- 连接信息：')
    lines.push('')
    lines.push(fence(meta.connectionInfo, 'text'))
    lines.push('')
  }
  if (meta.requiresEnv) {
    lines.push('- 环境题：需要通过 `ctf_start_env` 执行 `begin → run → addr` 后才能连接。')
  }
  if (meta.checkMode) {
    lines.push('- ⚠️ 平台标记 `answer_mode == 2`（check 模式），HuntingBlade 未支持该模式，请人工确认。')
  }
  lines.push('')

  lines.push('## 解题思路')
  lines.push('')
  lines.push(approach.text)
  lines.push('')

  lines.push('## 关键步骤')
  lines.push('')
  if (meta.timeline.length) {
    meta.timeline.forEach((step, index) => {
      const when = step.at ? `\`${formatTime(step.at)}\` ` : ''
      lines.push(`${index + 1}. ${when}${step.text}`)
    })
  } else {
    lines.push('（store 中没有本题的解题过程记录：没有开环境时间、也没有 flag 提交审计。')
    lines.push('可先执行 `ctf_start_env` / `ctf_submit_flag`，或直接调用 `ctf_writeup` 时传 `body` 手动补全。）')
  }
  lines.push('')

  lines.push('## Flag')
  lines.push('')
  if (accepted.length) {
    for (const flag of accepted) lines.push(fence(flag, 'text'))
    lines.push('')
  } else if (submissions.length) {
    lines.push('尚未有提交成功的 flag。已尝试过的提交：')
    lines.push('')
    lines.push('| 时间 | Flag | 结果 |')
    lines.push('|---|---|---|')
    for (const row of submissions) {
      const status = STATUS_LABEL[row.status] || row.status || 'unknown'
      lines.push(`| ${cell(formatTime(row.at))} | \`${cell(row.flag)}\` | ${cell(status)} |`)
    }
    lines.push('')
  } else {
    lines.push('（未记录到 flag 提交。）')
    lines.push('')
  }

  lines.push('## 复现脚本')
  lines.push('')
  if (scripts.length) {
    for (const script of scripts) {
      const lang = SCRIPT_LANGUAGES.get(path.extname(script.file).toLowerCase()) || ''
      const rel = path.relative(workDir, script.file) || script.file
      lines.push(`### \`${rel}\`${script.truncated ? '（已截断）' : ''}`)
      lines.push('')
      lines.push(fence(script.text, lang))
      lines.push('')
    }
  } else {
    lines.push('（未在 workDir 下找到本题的复现脚本。）')
    lines.push('')
    lines.push(`把 exp/脚本放到 \`${path.join(workDir, 'scripts')}/\` 下（文件名包含题名 slug 或题目 ID），重新生成即可自动内联。`)
    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

// ------------------------------------------------------------------ 工厂

export function createWriteup(deps = {}) {
  const config = deps.config || {}
  const store = deps.store
  const fsm = deps.fs || fsp
  const resolveAdapter = deps.resolveAdapter

  const log = (level, message, meta) => {
    const fn = deps.logger?.[level]
    if (typeof fn !== 'function') return
    try {
      fn.call(deps.logger, `[writeup] ${message}`, meta)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  async function resolveContext(args = {}) {
    if (typeof resolveAdapter !== 'function') {
      throw new Error('writeup 模块缺少 deps.resolveAdapter，无法解析平台适配器')
    }
    const resolved = await resolveAdapter(args)
    const adapter = resolved?.adapter
    if (!adapter) throw new Error('未能解析平台适配器，请先用 ctf_connect 配置平台地址与 sessionid')
    const connection = resolved?.connection || {}
    // index.js 的 resolveAdapter 会直接给出 connKey；缺失时按连接配置自行推导
    const connKey = resolved?.connKey ? String(resolved.connKey) : resolveConnKey(connection)
    return { adapter, connection, connKey }
  }

  function requireChallengeId(args) {
    // 工具层 ctf_writeup 的主参数名是 `id`，模块级 API 用 `challengeId`；两者都接受（内部参数优先）
    const id = args?.challengeId ?? args?.id
    if (id == null || String(id).trim() === '') {
      throw new Error('ctf_writeup 需要 id（题目 ID）')
    }
    return id
  }

  async function resolveEventName(adapter, connection) {
    const direct = connection?.eventName || connection?.eventTitle || connection?.event
    if (direct && typeof direct === 'string') return direct
    if (typeof adapter?.eventSummary === 'function') {
      try {
        const summary = await adapter.eventSummary()
        if (summary?.name) return String(summary.name)
      } catch {
        /* 赛事名只是元信息，取不到就降级 */
      }
    }
    if (connection?.eventId != null) return `event ${connection.eventId}`
    return ''
  }

  /**
   * 生成 WP 并落盘。
   */
  async function generate(args = {}) {
    // 省略 id/challengeId = 对「已解题目」批量生成（ctf_writeup 的模型可见语义）
    const explicitId = args?.challengeId ?? args?.id
    if (explicitId == null || String(explicitId).trim() === '') {
      return generateBatch(args)
    }
    const challengeId = requireChallengeId(args)
    const { adapter, connection, connKey } = await resolveContext(args)
    log('debug', `generate challenge=${challengeId} conn=${connKey}`, { agent: args.__agent })

    const detail = (await adapter.challengeDetail(challengeId)) || {}
    const work = await loadWorkRecord(store, connKey, challengeId)
    const submissions = await loadSubmissions(store, connKey, challengeId)

    const title = String(args.title || detail.name || work?.name || `challenge-${challengeId}`)
    const slug = slugify(title)
    // `args.workDir` 是**会话工作目录**提示（由 ctf_writeup 从 exec 解析后传入），见 resolveWorkDir
    const workDir = resolveWorkDir(config, args.workDir)
    const dir = writeupDir(workDir)
    const target = path.join(dir, writeupFileName(slug, challengeId))
    const generatedAt = formatTime(nowDate(deps.now))

    const description =
      readText(detail.description) ||
      (detail.descriptionHtml ? htmlToMarkdown(detail.descriptionHtml) : '') ||
      readText(detail.desc)

    const acceptedFlags = findAcceptedFlags(submissions)
    const approach = resolveApproach(args.body, work)
    const timeline = buildTimeline({ work, submissions })

    const envStart = pickTime(work, [
      'envStartedAt',
      'envStartAt',
      'environmentStartedAt',
      'environmentAt',
      'startedAt',
      'begunAt',
    ])
    const solvedAt =
      pickTime(work, ['solvedAt', 'solved_at', 'flagAcceptedAt', 'finishedAt']) ||
      toDate(acceptedFlags.length ? submissions.find((s) => s.status === 'correct' || s.status === 'already_solved')?.at : null)
    const solveWindow = envStart
      ? `${formatTime(envStart)}${solvedAt ? ` → ${formatTime(solvedAt)}（耗时 ${formatDuration(envStart, solvedAt) || '未知'}）` : ' → 未记录完成时间'}`
      : solvedAt
        ? `未记录开始时间 → ${formatTime(solvedAt)}`
        : '未记录'

    const scripts = await collectScripts(fsm, workDir, {
      slug,
      challengeId,
      work,
      excludePath: target,
    })
    const inlineScripts = []
    for (const file of scripts) {
      const read = await readScript(fsm, file)
      inlineScripts.push({ file, ...read })
    }

    const meta = {
      title,
      challengeId,
      slug,
      category: work?.category || detail.category || detail.raw?.classify || '',
      score: work?.score ?? detail.score ?? '',
      platform: connection.platform || adapter.id || 'lingxu',
      event: await resolveEventName(adapter, connection),
      solveWindow,
      description,
      attachment: detail.attachment || '',
      connectionInfo: detail.connectionInfo || work?.connectionInfo || '',
      requiresEnv: Boolean(detail.requiresEnv ?? work?.requiresEnv),
      checkMode: Boolean(detail.checkMode),
      timeline,
    }

    const content = buildMarkdown({
      detail,
      work,
      submissions,
      meta,
      approach,
      flags: { accepted: acceptedFlags },
      scripts: inlineScripts,
      workDir,
      generatedAt,
    })

    const exists = await pathExists(fsm, target)
    if (exists && !args.force) {
      const existing = await readWholeFile(fsm, target)
      const summary = [
        `WP 已存在，未覆盖：${target}`,
        `题目：${title}（id=${challengeId}）`,
        '如需用最新记录重新生成，请传 force: true。',
      ].join('\n')
      log('info', `skip existing writeup ${target}`)
      return finalizeGenerate(
        {
          ok: true,
          action: 'generate',
          skipped: true,
          challengeId,
          connKey,
          title,
          slug,
          path: target,
          bytes: existing.bytes,
          generatedAt,
          preview: existing.text.slice(0, PREVIEW_CHARS),
          summary,
        },
        { args, adapter, connection, connKey, challengeId, filePath: target, title, platform: meta.platform },
      )
    }

    await fsm.mkdir(dir, { recursive: true })
    await fsm.writeFile(target, content, 'utf8')
    const bytes = Buffer.byteLength(content, 'utf8')

    if (typeof store?.upsertChallengeWork === 'function') {
      try {
        await store.upsertChallengeWork(connKey, challengeId, {
          writeupPath: target,
          writeupAt: nowDate(deps.now).toISOString(),
          writeupSlug: slug,
        })
      } catch (error) {
        log('warn', `upsertChallengeWork 失败：${error?.message || error}`)
      }
    }

    const sections = ['题目描述', '解题思路', '关键步骤', 'Flag', '复现脚本']
    const summary = [
      `已生成 WP：${target}（${bytes} B）`,
      `题目：${title}（id=${challengeId}，分类 ${meta.category || '-'}，${meta.score === '' ? '-' : `${meta.score} 分`}）`,
      `记录：${work ? '有解题过程记录' : '无解题过程记录'}；思路来源：${approach.source}；flag：${acceptedFlags[0] || '未记录'}；内联脚本：${inlineScripts.length} 个`,
      `章节：${sections.join(' / ')}`,
    ].join('\n')

    log('info', `generated writeup ${target}`, { bytes })
    return finalizeGenerate(
      {
        ok: true,
        action: 'generate',
        skipped: false,
        challengeId,
        connKey,
        title,
        slug,
        path: target,
        bytes,
        generatedAt,
        sections,
        hasWorkRecord: Boolean(work),
        flagFound: acceptedFlags.length > 0,
        scriptCount: inlineScripts.length,
        preview: content.slice(0, PREVIEW_CHARS),
        summary,
      },
      { args, adapter, connection, connKey, challengeId, filePath: target, title, platform: meta.platform },
    )
  }

  /**
   * 批量生成：challengeId 省略时，对平台返回的「已解题目」逐题生成。
   * （对应 `ctf_writeup` 工具描述的「省略则按已解题目批量生成」。）
   */
  async function generateBatch(args = {}) {
    const { adapter, connection, connKey } = await resolveContext(args)
    let rows = []
    try {
      rows = (await adapter.challenges()) || []
    } catch (error) {
      throw new Error(`拉取题目列表失败，无法批量生成 WP：${error?.message || error}`)
    }
    const solved = rows.filter((row) => row?.solved)
    if (!solved.length) {
      const message =
        '没有找到已解题目，无法批量生成 WP。请显式传 id（题目 ID）；' +
        '可先用 ctf_challenges 查看已解题目的 id。'
      log('warn', message)
      return {
        ok: false,
        action: 'generate-batch',
        challengeId: null,
        connKey,
        count: 0,
        items: [],
        message,
        summary: message,
      }
    }

    const items = []
    for (const row of solved.slice(0, MAX_BATCH_WRITEUPS)) {
      try {
        const result = await generate({ ...args, challengeId: row.id })
        items.push({
          challengeId: row.id,
          name: row.name || '',
          ok: result.ok !== false,
          skipped: Boolean(result.skipped),
          path: result.path || '',
          submitted: result.submitted,
          message: result.message || '',
        })
      } catch (error) {
        items.push({
          challengeId: row.id,
          name: row.name || '',
          ok: false,
          path: '',
          message: error?.message || String(error),
        })
      }
    }

    const okCount = items.filter((item) => item.ok).length
    const summary = [
      `批量生成 WP：已解题目 ${solved.length} 道，本次处理 ${items.length} 道，成功 ${okCount} 道。`,
      ...items.map((item) => `- #${item.challengeId} ${item.name} → ${item.ok ? item.path : `失败：${item.message}`}`),
    ].join('\n')
    log('info', `batch generated ${okCount}/${items.length} writeups`)
    return {
      ok: okCount > 0,
      action: 'generate-batch',
      challengeId: null,
      connKey,
      count: items.length,
      okCount,
      items,
      summary,
    }
  }

  /** generate 的统一收尾：submit=true 时把刚写好的本地 WP 提交到平台。 */
  async function finalizeGenerate(base, { args, adapter, connection, connKey, challengeId, filePath, title, platform }) {
    if (args.submit !== true) return base
    const submission = await submitResolved({
      adapter,
      connection,
      connKey,
      challengeId,
      writeupId: args.writeupId,
      filePath,
      title,
      platform,
    })
    return {
      ...base,
      submitted: submission.ok,
      submitResult: submission,
      message: submission.message,
      summary: `${base.summary}\n\n${submission.summary}`,
    }
  }

  /** 读取本地 WP（work 记录优先，其次按约定路径匹配）。 */
  async function locateWriteup({ connKey, challengeId, slug, workDir, detailName }) {
    const dir = writeupDir(workDir)
    const work = await loadWorkRecord(store, connKey, challengeId)
    const candidates = []
    if (work?.writeupPath) candidates.push(String(work.writeupPath))
    const title = detailName || work?.name || `challenge-${challengeId}`
    candidates.push(path.join(dir, writeupFileName(slug || slugify(title), challengeId)))

    for (const candidate of candidates) {
      if (await pathExists(fsm, candidate)) return { path: candidate, work }
    }

    // 兜底：writeups/ 目录下按题目 ID 或 slug 模糊匹配
    try {
      const entries = await fsm.readdir(dir)
      const idPattern = new RegExp(`(^|[^0-9])${String(challengeId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`)
      const hit = entries
        .filter((name) => name.endsWith('.md'))
        .find((name) => idPattern.test(name) || (slug && name.includes(slug)))
      if (hit) return { path: path.join(dir, hit), work }
    } catch {
      /* 目录不存在 */
    }
    return { path: '', work }
  }

  /**
   * 提交本地 WP 到平台。平台不支持时返回明确说明，不抛异常。
   */
  async function submit(args = {}) {
    const challengeId = requireChallengeId(args)
    const { adapter, connection, connKey } = await resolveContext(args)
    const platform = connection.platform || adapter.id || 'lingxu'
    const workDir = resolveWorkDir(config)

    let detail = {}
    try {
      detail = (await adapter.challengeDetail(challengeId)) || {}
    } catch (error) {
      log('warn', `读取题面失败（继续用本地 WP 提交）：${error?.message || error}`)
    }

    const located = await locateWriteup({
      connKey,
      challengeId,
      slug: detail.name ? slugify(detail.name) : '',
      workDir,
      detailName: detail.name,
    })
    if (!located.path) {
      const message = `未找到题目 ${challengeId} 的本地 WP 文件。请先调用 ctf_writeup id=${challengeId} 生成（或 ctf_writeup id=${challengeId} submit=true 一次完成生成+提交），预期路径：${path.join(writeupDir(workDir), writeupFileName(slugify(detail.name), challengeId))}`
      log('warn', message)
      return {
        ok: false,
        action: 'submit',
        platform,
        connKey,
        challengeId,
        writeupId: args.writeupId ?? null,
        path: '',
        message,
        summary: message,
      }
    }

    const existingText = (await readWholeFile(fsm, located.path)).text
    const heading = /^#\s+(.+)$/m.exec(existingText)
    const title = (heading?.[1] || detail.name || `challenge-${challengeId}`).trim()
    return submitResolved({
      adapter,
      connection,
      connKey,
      challengeId,
      writeupId: args.writeupId,
      filePath: located.path,
      title,
      platform,
    })
  }

  /** 真正执行平台侧提交（submit 与 generate(submit:true) 共用）。 */
  async function submitResolved({ adapter, connection, connKey, challengeId, writeupId, filePath, title, platform }) {
    const resolvedPlatform = platform || connection?.platform || adapter?.id || 'lingxu'
    const read = await readWholeFile(fsm, filePath)
    const content = read.text
    const heading = /^#\s+(.+)$/m.exec(content)
    const finalTitle = (title || heading?.[1] || `challenge-${challengeId}`).trim()

    if (typeof adapter?.submitWriteup !== 'function') {
      const message = `平台 ${resolvedPlatform} 不支持平台侧 WP 提交；WP 已保存在本地：${filePath}`
      return {
        ok: false,
        action: 'submit',
        unsupported: true,
        platform: resolvedPlatform,
        connKey,
        challengeId,
        writeupId: writeupId ?? null,
        path: filePath,
        title: finalTitle,
        bytes: read.bytes,
        message,
        summary: message,
      }
    }

    try {
      const result = (await adapter.submitWriteup({
        id: writeupId,
        title: finalTitle,
        code: content,
      })) || {}
      const ok = result.ok !== false
      const message = result.message || (ok ? 'WP 提交成功' : 'WP 提交失败')
      log(ok ? 'info' : 'warn', `submit writeup ${filePath} -> ${message}`)
      return {
        ok,
        action: 'submit',
        platform: resolvedPlatform,
        connKey,
        challengeId,
        writeupId: writeupId ?? null,
        path: filePath,
        title: finalTitle,
        bytes: read.bytes,
        message,
        summary: `${ok ? '✅' : '❌'} ${message}\n本地 WP：${filePath}\n平台：${resolvedPlatform}`,
      }
    } catch (error) {
      const raw = error?.message || String(error)
      const unsupported = /不支持|not support|unsupported/i.test(raw)
      const message = unsupported
        ? `平台 ${resolvedPlatform} 不支持平台侧 WP 提交（${raw}）；WP 已保存在本地：${filePath}`
        : `WP 提交失败：${raw}`
      log('warn', message)
      return {
        ok: false,
        action: 'submit',
        unsupported,
        platform: resolvedPlatform,
        connKey,
        challengeId,
        writeupId: writeupId ?? null,
        path: filePath,
        title: finalTitle,
        bytes: read.bytes,
        message,
        summary: message,
      }
    }
  }

  /**
   * 列出平台侧 WP。平台不支持时返回空列表 + 说明，不抛异常。
   */
  async function list(args = {}) {
    const { adapter, connection, connKey } = await resolveContext(args)
    const platform = connection.platform || adapter.id || 'lingxu'
    if (typeof adapter.listWriteups !== 'function') {
      const message = `平台 ${platform} 不支持列出平台侧 WP`
      return { ok: false, action: 'list', unsupported: true, platform, connKey, count: 0, items: [], message, summary: message }
    }
    try {
      const rows = (await adapter.listWriteups()) || []
      const items = (Array.isArray(rows) ? rows : []).map((row) => ({
        id: row?.id ?? null,
        title: row?.title ?? row?.name ?? '',
        author: row?.username ?? row?.user ?? row?.author ?? '',
        at: row?.sub_time ?? row?.time ?? row?.created_at ?? row?.at ?? '',
        raw: row,
      }))
      const summary = items.length
        ? `平台 ${platform} 共有 ${items.length} 篇 WP：\n${items.slice(0, 10).map((i) => `- [${i.id ?? '-'}] ${i.title || '(无标题)'}${i.author ? ` — ${i.author}` : ''}`).join('\n')}`
        : `平台 ${platform} 暂无 WP 记录`
      return { ok: true, action: 'list', platform, connKey, count: items.length, items, summary }
    } catch (error) {
      const raw = error?.message || String(error)
      const unsupported = /不支持|not support|unsupported/i.test(raw)
      const message = unsupported ? `平台 ${platform} 不支持列出平台侧 WP（${raw}）` : `读取 WP 列表失败：${raw}`
      log('warn', message)
      return { ok: false, action: 'list', unsupported, platform, connKey, count: 0, items: [], message, summary: message }
    }
  }

  return { generate, submit, list }
}

export default createWriteup
