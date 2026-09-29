/**
 * dsh-lingxu-ctf 工具层：13 个模型可见工具的**纯规格对象**。
 *
 * 本文件刻意不 import `@deepseek-ai/dsh-tools`：这里导出的对象形状与 `defineTool(options)`
 * 的入参一致（`{ name, description, parameters, output, execute }`），由 `lib/index.js`
 * 用 `defineTool` 包装后注册到 `ctx.tools`。好处是单测可以直接
 * `spec.execute(args, exec)`，不需要宿主运行时。
 *
 * 依赖方向：`tools → platforms/store/lingxu`（反向依赖禁止）。
 * 编排（`deps.orchestrator`）与 WP（`deps.writeup`）由外部注入，本文件只做校验与转发。
 *
 * deps 形状（index.js 注入，测试用 mock）：
 *   {
 *     config,          // { concurrency, maxWrongAttempts, dedupeFlags, workDir, timeoutMs, enableWebPanel }
 *     store,           // CtfStore 实例
 *     resolveAdapter,  // async (args) => { adapter, connection }
 *     logger,          // { info, warn, error }
 *     now,             // () => number
 *     createAdapter,   // 可选：适配器工厂（默认用 lib/platforms.js 的 createAdapter，测试时可注入 mock）
 *     orchestrator,    // { start, status, stop } —— 可选，由 lib/orchestrate.js 提供
 *     writeup,         // { generate }            —— 可选，由 lib/writeup.js 提供
 *   }
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createAdapter } from './platforms.js'
import { connectionKey } from './store.js'
import {
  isEnvNotConfigured,
  isSessionExpired,
  maskSecret,
  normalizeOptionArray,
  parseCookie,
  theoryOptionTypeLabel,
  theoryTestStatus,
} from './lingxu.js'

/** 13 个工具名，顺序与 docs/DESIGN.md 第 5 节一致。 */
export const TOOL_NAMES = [
  'ctf_connect',
  'ctf_status',
  'ctf_challenges',
  'ctf_challenge',
  'ctf_start_env',
  'ctf_release_env',
  'ctf_submit_flag',
  'ctf_leaderboard',
  'ctf_theory',
  'ctf_solve_start',
  'ctf_solve_status',
  'ctf_solve_stop',
  'ctf_writeup',
]

// ------------------------------------------------------------------ 基础工具

/** 所有工具的返回都是紧凑文本（模型直接读）。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : stringify(value) },
  ],
}

/** 硬失败：即使所在工具整体是「返回错误文本」策略，也直接抛给宿主。 */
class HardFail extends Error {
  constructor(message) {
    super(message)
    this.name = 'HardFail'
    this.hard = true
  }
}

function stringify(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function errorMessage(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error.trim() || '未知错误'
  const message = typeof error.message === 'string' ? error.message.trim() : ''
  return message || error.name || String(error)
}

/** sessionid 失效的统一文案（所有工具共用，不要在各工具里重复）。 */
export const SESSION_EXPIRED_TEXT = [
  '❌ 凌虚 sessionid 已失效，请重新登录平台后复制新的 Cookie，',
  '   再用 ctf_connect { baseUrl, eventId, cookie } 更新（其余配置会保留）。',
].join('\n')

/** 「平台未为该题配置环境」的统一文案（ctf_start_env 等共用）。 */
export function renderEnvNotConfigured(detail) {
  const platformText = String(detail || '').trim() || '该题目没有选择对应的环境，请联系管理员。'
  return [
    `⚠️ 该题在平台上没有配置环境（平台返回：${platformText}）。`,
    '   可能是题目本身不需要环境，或平台侧配置缺失。可以尝试直接分析附件（附件已由 ctf_challenge 下载）。',
  ].join('\n')
}

/** 取平台自己给的文案（优先 platformMessage，其次响应体），避免包装文案套娃。 */
function platformDetail(error) {
  if (!error) return ''
  if (typeof error.platformMessage === 'string' && error.platformMessage.trim()) {
    return error.platformMessage.trim()
  }
  const payload = error.payload
  if (payload && typeof payload === 'object') {
    for (const key of ['error', 'msg', 'message', 'detail']) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return ''
}

/** 统一错误渲染：session 失效 / 未配置环境 有专门文案，其余保持 `❌ message`。 */
function renderToolError(error) {
  if (isSessionExpired(error)) return SESSION_EXPIRED_TEXT
  if (isEnvNotConfigured(error)) return renderEnvNotConfigured(platformDetail(error))
  return `❌ ${errorMessage(error)}`
}

/** 硬失败（抛给宿主）时的文案：工具自己抛的 HardFail 已写好完整文案，尊重它；其余按统一规则渲染。 */
function hardFailText(error) {
  if (error?.hard === true) return errorMessage(error)
  return renderToolError(error).replace(/^[❌⚠️ℹ️]\s*/, '')
}

/**
 * 构造一个工具规格。
 *
 * 默认容错：任何异常都转成 `❌ ...` 文本返回（工具调用不算失败，模型能读到原因）。
 * `hardFail: true`（提交类工具）或 execute 抛 `HardFail` 时，异常照常抛出。
 */
function defineSpec({ name, description, parameters, execute, hardFail = false }) {
  return {
    name,
    description,
    parameters,
    output: TEXT_OUTPUT,
    async execute(args = {}, exec) {
      try {
        return await execute(args || {}, exec || {})
      } catch (error) {
        if (hardFail || error?.hard === true) {
          throw new Error(`[${name}] ${hardFailText(error)}`, { cause: error })
        }
        return renderToolError(error)
      }
    },
  }
}

// ------------------------------------------------------------------ 参数 DSL

const pString = (description) => ({ type: 'string', description })
const pBool = (description) => ({ type: 'boolean', description })
const pInt = (description) => ({ type: 'integer', description })
const pNum = (description) => ({ type: 'number', description })
const pEnum = (values, description) => ({ type: 'string', enum: values, description })
/** 平台 ID 既可能是数字也可能是字符串，用 oneOf 两种都收。 */
const pId = (description) => ({
  oneOf: [{ type: 'string' }, { type: 'integer' }],
  description,
})

const CONNECTION_PARAM = pString('连接 key（省略则使用当前活动连接；多赛事时用来指定用哪个连接）')

// ------------------------------------------------------------------ 展示helper

function markdownTable(headers, rows) {
  const cell = (value) =>
    String(value ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\s*\n+\s*/g, ' ')
      .trim()
  const lines = [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`)
  return lines.join('\n')
}

function truncate(value, max = 60) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

function formatDuration(seconds) {
  const total = Number(seconds)
  if (!Number.isFinite(total) || total <= 0) return '0s'
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = Math.floor(total % 60)
  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  if (!days && !hours) parts.push(`${secs}s`)
  return parts.join('')
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`
}

/**
 * 题目工作目录名 slug。
 *
 * ⚠️ 必须与 `lib/index.js` 的 `slugify` / `lib/orchestrate.js` 的 `pathSlug` **同规则**：
 * 编排层把 solver 的工作目录写进 writeScope/任务描述（`challenges/<pathSlug>-<id>`），
 * ctf_challenge 把附件下载到 `challenges/<slug>-<id>/distfiles/`；两边不一致时
 * solver 会被告知去一个没有附件的目录。规则：只剔除路径危险字符与控制字符，
 * 保留中文等可读字符（在本文件内实现，避免 tools → index/orchestrate 的反向依赖）。
 */
function slugify(value, fallback = 'challenge') {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/g, '')
  return text || fallback
}

function normalizeId(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function clampInt(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(num)))
}

// ------------------------------------------------------------------ 依赖 helper

function log(ctx, level, message) {
  const fn = ctx.logger?.[level]
  if (typeof fn !== 'function') return
  try {
    fn.call(ctx.logger, message)
  } catch {
    /* 日志失败不能影响工具 */
  }
}

/**
 * 解析平台连接与适配器。解析不到时给出可操作的指引（先 ctf_connect）。
 */
async function resolveAdapterFor(ctx, args) {
  const resolver = ctx.deps?.resolveAdapter
  if (typeof resolver !== 'function') {
    throw new Error('插件未正确装配：缺少 resolveAdapter（应由 lib/index.js 注入）')
  }
  let resolved
  try {
    resolved = await resolver(args || {})
  } catch (error) {
    throw new Error(
      `无法解析平台连接：${errorMessage(error)}。请先用 ctf_connect 配置平台地址与 sessionid；` +
        '若已配置多个赛事，用 connection 参数指定连接 key。',
    )
  }
  if (!resolved || !resolved.adapter) {
    throw new Error(
      '无法解析平台连接：当前没有可用连接。请先用 ctf_connect 配置平台地址（baseUrl）与 sessionid。',
    )
  }
  return { adapter: resolved.adapter, connection: resolved.connection || {} }
}

function connectionKeyOf(connection) {
  if (!connection) return 'unknown'
  if (connection.key) return String(connection.key)
  try {
    return connectionKey(connection)
  } catch {
    return 'unknown'
  }
}

/** store 方法可能缺失（mock / 早期版本），缺失时当作 no-op。 */
async function storeCall(store, method, ...callArgs) {
  if (!store || typeof store[method] !== 'function') return undefined
  return store[method](...callArgs)
}

function connectionLabel(connection) {
  if (!connection) return '未知连接'
  const key = connectionKeyOf(connection)
  const event = connection.eventId ? ` event=${connection.eventId}` : ''
  return `${key}（${connection.platform || 'lingxu'} ${connection.baseUrl || ''}${event}）`
}

function resolveWorkDir(ctx, exec) {
  const configured = ctx.config?.workDir
  if (configured) return String(configured)
  if (exec?.cwd) return String(exec.cwd)
  const agentCwd = exec?.agent?.session?.header?.cwd
  if (agentCwd) return String(agentCwd)
  return process.cwd()
}

function nowIso(ctx) {
  try {
    return new Date(Number(ctx.now()) || Date.now()).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

// ------------------------------------------------------------------ 1. ctf_connect

function specConnect(ctx) {
  const { deps, config } = ctx
  return defineSpec({
    name: 'ctf_connect',
    description: [
      '配置并校验凌虚赛事平台连接，成功后写入 DSH 本地状态并设为当前活动连接。',
      '何时用：会话开始、或要切换赛事/账号时。调用其他任何 ctf_* 工具之前必须先成功调用它。',
      '参数：baseUrl 平台根地址（填 https://host:port，不要带前端 # 路由）；eventId 赛事 ID（URL 里的 /event/<id>/）；',
      'cookie 浏览器复制的完整 Cookie（必须含 sessionid）；label 备注名，便于多赛事切换。',
      '返回：登录用户、赛事信息、脱敏凭据摘要与警告（如 punish 错误提交扣分提醒）。',
      '副作用：凭据写入 DSH 本地存储（不写入插件目录、不进 git），后续工具默认使用该连接。',
    ].join('\n'),
    parameters: {
      baseUrl: {
        type: 'string',
        required: true,
        description: '平台根地址，例如 https://example.com:8000（不要带前端 hash 路由）',
      },
      eventId: pId('赛事 ID（必填），例如 4'),
      cookie: pString('浏览器复制的完整 Cookie 字符串（必须包含 sessionid=...）'),
      label: pString('连接备注名，多赛事时便于识别'),
    },
    async execute(args) {
      const baseUrl = String(args.baseUrl || '')
        .trim()
        .replace(/\/+$/, '')
      if (!baseUrl) {
        return '❌ 缺少平台地址 baseUrl。示例：ctf_connect baseUrl=https://example.com:8000 eventId=4 cookie="sessionid=..."'
      }
      if (!/^https?:\/\//i.test(baseUrl)) {
        return `❌ baseUrl 必须是完整地址（含 http:// 或 https://），当前为 "${baseUrl}"`
      }

      const cookie = String(args.cookie || '').trim()
      let eventId
      if (args.eventId !== undefined && args.eventId !== null && String(args.eventId).trim() !== '') {
        eventId = Number(args.eventId)
        if (!Number.isInteger(eventId) || eventId <= 0) {
          return `❌ eventId 必须是正整数，当前为 "${args.eventId}"`
        }
      }

      if (!eventId) {
        return '❌ 必须提供 eventId（赛事 ID，取自 URL 的 /event/<id>/）'
      }
      if (!cookie) {
        return '❌ 必须提供 cookie：浏览器登录后复制完整 Cookie（需含 sessionid）'
      }
      if (!/(^|;\s*)sessionid=/.test(cookie)) {
        return '❌ cookie 中缺少 sessionid。请在浏览器开发者工具 → Application → Cookies 中复制完整 Cookie 串。'
      }

      const connection = {
        platform: 'lingxu',
        baseUrl,
        ...(eventId ? { eventId } : {}),
        ...(cookie ? { cookie } : {}),
        ...(args.label ? { label: String(args.label) } : {}),
        ...(config?.timeoutMs ? { timeoutMs: Number(config.timeoutMs) } : {}),
      }

      let adapter
      try {
        const factory = typeof deps.createAdapter === 'function' ? deps.createAdapter : createAdapter
        adapter = factory(connection)
      } catch (error) {
        return `❌ 创建平台适配器失败：${errorMessage(error)}`
      }

      let validation
      try {
        validation = await adapter.validate()
      } catch (error) {
        // sessionid 失效时给专门文案（不要淹没在排查清单里）
        if (isSessionExpired(error)) return SESSION_EXPIRED_TEXT
        return [
          `❌ 连接校验失败：${errorMessage(error)}`,
          '排查顺序：',
          '1) baseUrl 是否是平台根地址（不要带 # 路由、不要多写路径）；',
          '2) Cookie/sessionid 是否过期（浏览器重新登录后复制完整 Cookie）；',
          '3) eventId 是否存在于该平台；',
          '4) 本机网络能否访问该地址。',
        ].join('\n')
      }

      const warnings = Array.isArray(validation?.warnings) ? [...validation.warnings] : []
      // 实测平台不强制 CSRF（不带 X-CSRFToken 也能写），但 README 建议带上；缺了只提醒、不拒绝。
      if (!parseCookie(cookie).csrftoken) {
        warnings.push(
          '建议把 csrftoken 一起带上（浏览器全量复制 Cookie）：实测平台不强制，部分写操作可能依赖它。',
        )
      }

      let summary = null
      if (typeof adapter.eventSummary === 'function') {
        try {
          summary = await adapter.eventSummary()
        } catch (error) {
          warnings.push(`赛事信息获取失败（不影响连接）：${errorMessage(error)}`)
        }
      }

      let stored
      try {
        stored = await storeCall(ctx.store, 'upsertConnection', connection)
      } catch (error) {
        warnings.push(`连接已校验成功，但写入本地状态失败：${errorMessage(error)}`)
      }
      const key = stored?.key || connectionKeyOf(connection)

      if (validation?.punish || summary?.punish) {
        warnings.push('⚠️ 本赛事开启了错误 flag 扣分（punish=true）：错误提交会扣分，请先确认 flag 再提交。')
      }
      if (Number(config?.maxWrongAttempts) > 0) {
        warnings.push(`已启用错误次数护栏：每题最多 ${Number(config.maxWrongAttempts)} 次错误提交。`)
      }
      warnings.push(
        '⚠️ 全自动提交已开启：agent 判定为 flag 即提交；每次提交都会写入本地审计日志（去重 + 错误计数）。',
      )

      const user = validation?.user || summary?.user || null
      const lines = [
        '✅ 已连接凌虚赛事平台',
        `- 连接 key: ${key}`,
        `- 地址: ${baseUrl}${eventId ? `（event ${eventId}）` : ''}`,
        `- 用户: ${user?.username || '（平台未返回用户名，Cookie 可能已过期）'}${
          user?.number != null ? `（编号 ${user.number}）` : ''
        }`,
      ]
      if (summary?.name) {
        const window = [summary.startTime, summary.endTime].filter(Boolean).join(' → ')
        lines.push(
          `- 赛事: ${summary.name}${window ? `（${window}）` : ''}${
            Number(summary.remainingSeconds) > 0 ? `，剩余 ${formatDuration(summary.remainingSeconds)}` : ''
          }`,
        )
      }
      lines.push(`- Cookie: ${cookie ? maskSecret(cookie) : '（未使用 cookie）'}`)
      if (warnings.length) {
        lines.push('警告：')
        for (const warning of warnings) lines.push(`- ${warning}`)
      }
      lines.push('下一步：ctf_status 看赛事总览，ctf_challenges 拉题目列表。')
      log(ctx, 'info', `[ctf] 已连接 ${key}`)
      return lines.join('\n')
    },
  })
}

// ------------------------------------------------------------------ 2. ctf_status

function specStatus(ctx) {
  return defineSpec({
    name: 'ctf_status',
    description: [
      '查看当前赛事总览：赛事名称/时间/剩余时间、我的分数与排名、题目总数与已解/待解、按分类的解题分布、理论题状态。',
      '何时用：连接成功后了解全局；解题中途判断还剩多少题、排名是否变化。',
      '参数：connection 可选，指定连接 key（多赛事时用）。',
      '返回：紧凑的中文统计文本（纯只读，无副作用）。',
    ].join('\n'),
    parameters: { connection: CONNECTION_PARAM },
    async execute(args) {
      const { adapter, connection } = await resolveAdapterFor(ctx, args)
      const [summary, challenges] = await Promise.all([
        adapter.eventSummary(),
        adapter.challenges(),
      ])

      let myRank = null
      if (typeof adapter.myRank === 'function') {
        try {
          myRank = await adapter.myRank()
        } catch (error) {
          log(ctx, 'warn', `[ctf] myRank 获取失败：${errorMessage(error)}`)
        }
      }

      let theoryTests = []
      if (typeof adapter.theoryTests === 'function') {
        try {
          theoryTests = (await adapter.theoryTests()) || []
        } catch (error) {
          log(ctx, 'warn', `[ctf] theoryTests 获取失败：${errorMessage(error)}`)
        }
      }

      const list = Array.isArray(challenges) ? challenges : []
      const solvedList = list.filter((c) => c.solved)
      const totalScore = list.reduce((sum, c) => sum + (Number(c.score) || 0), 0)
      const earnedScore = solvedList.reduce((sum, c) => sum + (Number(c.score) || 0), 0)
      const rate = list.length ? ((solvedList.length / list.length) * 100).toFixed(1) : '0.0'

      const byCategory = new Map()
      for (const challenge of list) {
        const key = challenge.category || '未分类'
        const entry = byCategory.get(key) || { total: 0, solved: 0, score: 0 }
        entry.total += 1
        if (challenge.solved) {
          entry.solved += 1
          entry.score += Number(challenge.score) || 0
        }
        byCategory.set(key, entry)
      }

      const lines = [`📊 赛事总览 — ${summary?.name || '（未命名赛事）'}`]
      lines.push(`- 连接: ${connectionLabel(connection)}`)
      const user = summary?.user || myRank?.self || null
      lines.push(`- 用户: ${user?.username || '未知'}`)
      const window = [summary?.startTime, summary?.endTime].filter(Boolean).join(' → ')
      if (window) {
        const remaining = Number(summary?.remainingSeconds) > 0
          ? `，剩余 ${formatDuration(summary.remainingSeconds)}`
          : ''
        lines.push(`- 赛事时间: ${window}${remaining}`)
      }
      lines.push(
        `- 题目: 共 ${list.length} 题｜已解 ${solvedList.length}｜待解 ${list.length - solvedList.length}｜完成度 ${rate}%`,
      )
      lines.push(`- 分值: 已得 ${earnedScore} / 总分 ${totalScore}`)
      if (byCategory.size) {
        lines.push('- 分类分布:')
        for (const [category, entry] of [...byCategory.entries()].sort((a, b) => b[1].total - a[1].total)) {
          lines.push(`  - ${category}: ${entry.solved}/${entry.total} 已解（+${entry.score}）`)
        }
      }
      if (myRank && (myRank.rank != null || myRank.self)) {
        const self = myRank.self || {}
        lines.push(
          `- 我的排名: 第 ${myRank.rank ?? '?'} 名 / 共 ${myRank.total ?? '?'}` +
            `（总分 ${self.score ?? '-'}；CTF ${self.ctfScore ?? '-'}；理论 ${self.testScore ?? '-'}；解题 ${self.solved ?? '-'}）`,
        )
      } else {
        lines.push('- 我的排名: 平台未提供（请确认 sessionid 有效；凌虚个人榜需要有效登录态）')
      }

      if (theoryTests.length) {
        lines.push(`- 理论题: 共 ${theoryTests.length} 套`)
        for (const test of theoryTests) {
          const state = test.statusLabel || theoryTestStatus(test).label
          // 已交卷的试卷平台不再开放 list（400「题目不是开启状态」），不要再指路 questions。
          const next = test.isParse
            ? '（平台不再开放题目列表）'
            : `→ ctf_theory action=questions testId=${test.id}`
          lines.push(
            `  - #${test.id} ${test.name}（${state}，${test.count} 题，${test.score} 分）${next}`,
          )
        }
      } else {
        lines.push('- 理论题: 无（或该平台不支持理论题）')
      }
      lines.push('下一步: ctf_challenges 看题目（加 solved=false 只看待解），ctf_leaderboard 看排行榜。')
      return lines.join('\n')
    },
  })
}

// ------------------------------------------------------------------ 3. ctf_challenges

function specChallenges(ctx) {
  return defineSpec({
    name: 'ctf_challenges',
    description: [
      '拉取赛事题目列表（自动翻页），支持按分类、是否已解、最低分值过滤，返回紧凑表格。',
      '何时用：挑题、确认还有哪些待解、给并发解题团队选题。',
      '参数：category 分类名过滤；solved=true 只看已解 / false 只看待解 / 省略看全部；',
      'minScore 只看分值 ≥ 该值的题；limit 最多显示多少行（默认 50，上限 200）；connection 指定连接。',
      '返回：Markdown 表格（id/名称/分类/分值/状态/解题数）+ 统计行。纯只读。',
      '拿到 id 后用 ctf_challenge 看题面，用 ctf_start_env 起环境。',
    ].join('\n'),
    parameters: {
      category: pString('按分类过滤（如 Web / Pwn / Misc），省略为全部分类'),
      solved: pBool('true=只看已解；false=只看待解；省略=全部'),
      minScore: pNum('只看分值 ≥ 该值的题目'),
      limit: pInt('最多显示多少行，默认 50，上限 200'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const { adapter } = await resolveAdapterFor(ctx, args)
      const all = (await adapter.challenges()) || []
      const limit = clampInt(args.limit, 1, 200, 50)

      let rows = all
      if (args.category) {
        const wanted = String(args.category).toLowerCase()
        rows = rows.filter((c) => String(c.category || '').toLowerCase().includes(wanted))
      }
      if (args.solved === true) rows = rows.filter((c) => c.solved)
      if (args.solved === false) rows = rows.filter((c) => !c.solved)
      if (args.minScore !== undefined && args.minScore !== null) {
        const min = Number(args.minScore)
        if (Number.isFinite(min)) rows = rows.filter((c) => (Number(c.score) || 0) >= min)
      }

      const solvedCount = all.filter((c) => c.solved).length
      const sorted = [...rows].sort(
        (a, b) => Number(a.solved) - Number(b.solved) || (Number(b.score) || 0) - (Number(a.score) || 0),
      )
      const shown = sorted.slice(0, limit)

      const filters = []
      if (args.category) filters.push(`分类=${args.category}`)
      if (args.solved === true) filters.push('仅已解')
      if (args.solved === false) filters.push('仅待解')
      if (args.minScore != null) filters.push(`分值≥${args.minScore}`)

      const header =
        `📋 题目列表｜共 ${all.length} 题（已解 ${solvedCount} / 待解 ${all.length - solvedCount}）` +
        (filters.length ? `｜过滤: ${filters.join('，')}` : '') +
        `｜命中 ${sorted.length} 题，显示 ${shown.length} 题`

      if (!shown.length) {
        return `${header}\n没有符合条件的题目。`
      }

      const table = markdownTable(
        ['id', '名称', '分类', '分值', '状态', '解题数'],
        shown.map((c) => [
          c.id,
          truncate(c.name, 44),
          c.category || '-',
          c.score ?? 0,
          c.solved ? '✅ 已解' : c.begun === false ? '⬜ 未开始' : '⬜ 待解',
          c.parseCount ?? 0,
        ]),
      )
      const lines = [header, table]
      if (sorted.length > shown.length) {
        lines.push(`（还有 ${sorted.length - shown.length} 题未显示，可调大 limit 或加过滤条件）`)
      }
      lines.push('下一步: ctf_challenge id=<id> 看题面；环境题用 ctf_start_env id=<id>。')
      return lines.join('\n')
    },
  })
}

// ------------------------------------------------------------------ 4. ctf_challenge

function specChallenge(ctx) {
  return defineSpec({
    name: 'ctf_challenge',
    description: [
      '查看单题详情：题面（HTML 已转 Markdown）、分值、解题数、是否需要环境、连接信息，并把附件下载到本机工作区。',
      '何时用：开始解一道题之前；下载 distfiles 供逆向/分析。',
      '参数：id 题目 ID（必填，来自 ctf_challenges）；download 是否下载附件（默认 true）；connection 指定连接。',
      '副作用：在 <workDir>/challenges/<slug>-<id>/ 下创建 distfiles/ 目录并写入附件，同时写 metadata.json。',
      '返回：题面 Markdown + 附件绝对路径 + 后续动作提示（环境题 → ctf_start_env）。',
    ].join('\n'),
    parameters: {
      id: pId('题目 ID（ctf_challenges 表格里的 id 列）'),
      download: pBool('是否下载附件，默认 true'),
      connection: CONNECTION_PARAM,
    },
    async execute(args, exec) {
      const id = normalizeId(args.id)
      if (!id) return '❌ 缺少题目 id。先用 ctf_challenges 拿到 id，再 ctf_challenge id=<id>。'
      const { adapter, connection } = await resolveAdapterFor(ctx, args)
      const detail = await adapter.challengeDetail(id)
      if (!detail) return `❌ 平台未返回题目 ${id} 的详情（可能 id 不存在或无权限）`

      const workDir = resolveWorkDir(ctx, exec)
      const dir = path.join(workDir, 'challenges', `${slugify(detail.name)}-${detail.id ?? id}`)
      const distDir = path.join(dir, 'distfiles')

      const attachmentUrls = []
      if (detail.attachment) attachmentUrls.push(String(detail.attachment))
      if (Array.isArray(detail.attachments)) {
        for (const url of detail.attachments) {
          const text = String(url || '')
          if (text && !attachmentUrls.includes(text)) attachmentUrls.push(text)
        }
      }

      const saved = []
      const failures = []
      const shouldDownload = args.download !== false && attachmentUrls.length > 0
      if (shouldDownload) {
        try {
          await fsp.mkdir(distDir, { recursive: true })
        } catch (error) {
          failures.push(`创建目录失败：${errorMessage(error)}`)
        }
        for (let index = 0; index < attachmentUrls.length; index += 1) {
          const url = attachmentUrls[index]
          const dest = path.join(distDir, attachmentFilename(url, index))
          try {
            const result = await downloadAttachmentFile(adapter, connection, url, dest)
            saved.push({ url, path: dest, bytes: result?.bytes ?? null })
          } catch (error) {
            failures.push(`附件下载失败（${truncate(url, 60)}）：${errorMessage(error)}`)
          }
        }
      }

      const metadata = {
        id: detail.id ?? id,
        name: detail.name,
        score: detail.score ?? null,
        solves: detail.solves ?? null,
        requiresEnv: Boolean(detail.requiresEnv),
        checkMode: Boolean(detail.checkMode),
        taskType: detail.taskType ?? null,
        answerMode: detail.answerMode ?? null,
        connection: {
          key: connectionKeyOf(connection),
          platform: connection.platform || null,
          baseUrl: connection.baseUrl || null,
          eventId: connection.eventId ?? null,
        },
        attachmentUrls,
        files: saved.map((entry) => path.relative(dir, entry.path)),
        fetchedAt: nowIso(ctx),
        description: detail.description || '',
      }
      let metadataPath = ''
      try {
        await fsp.mkdir(dir, { recursive: true })
        metadataPath = path.join(dir, 'metadata.json')
        await fsp.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
      } catch (error) {
        failures.push(`metadata.json 写入失败：${errorMessage(error)}`)
      }

      const lines = [`🧩 题目详情 #${detail.id ?? id} — ${detail.name}`]
      lines.push(
        `- 分值: ${detail.score ?? '-'}｜解题数: ${detail.solves ?? '-'}｜` +
          `需要环境: ${detail.requiresEnv ? '是' : '否'}${detail.checkMode ? '｜check 模式（answer_mode=2）' : ''}`,
      )
      if (detail.connectionInfo) lines.push(`- 连接信息: ${detail.connectionInfo}`)
      if (saved.length) {
        lines.push(`- 附件（已下载到 ${distDir}）:`)
        for (const entry of saved) lines.push(`  - ${entry.path}${entry.bytes != null ? `（${entry.bytes} bytes）` : ''}`)
      } else if (attachmentUrls.length && args.download === false) {
        lines.push(`- 附件（未下载，download=false）: ${attachmentUrls.join(' , ')}`)
      } else if (!attachmentUrls.length) {
        lines.push('- 附件: 无')
      }
      if (metadataPath) lines.push(`- 元数据: ${metadataPath}`)
      if (failures.length) {
        lines.push('⚠️ 部分操作失败：')
        for (const failure of failures) lines.push(`  - ${failure}`)
      }
      lines.push('题面:')
      lines.push(detail.description?.trim() || '（平台未返回题面文本）')
      if (detail.requiresEnv) {
        lines.push(`下一步: 该题需要环境，用 ctf_start_env id=${detail.id ?? id} 拉起后拿连接信息。`)
      } else {
        lines.push(`下一步: 分析附件并解题，拿到 flag 后 ctf_submit_flag id=${detail.id ?? id} flag=<flag>。`)
      }
      return lines.join('\n')
    },
  })
}

/** 附件落盘文件名：取 URL 最后一段，去掉 query，做安全化处理。 */
function attachmentFilename(url, index) {
  let name = ''
  try {
    const parsed = new URL(String(url))
    name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
  } catch {
    name = String(url).split('?')[0].split('/').filter(Boolean).pop() || ''
  }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  if (!name || name === '.' || name === '..') name = `attachment-${index + 1}.bin`
  return name.slice(0, 120)
}

/**
 * 附件下载：不同适配器对 URL 形式的期望不同（凌虚客户端会把相对路径拼到 baseUrl 上），
 * 因此先按适配器语义换算，失败再退回另一种形式。
 */
async function downloadAttachmentFile(adapter, connection, url, destPath) {
  if (typeof adapter.downloadAttachment !== 'function') {
    throw new Error('当前平台适配器不支持附件下载')
  }
  const base = String(connection?.baseUrl || '').replace(/\/+$/, '')
  const absolute = String(url || '')
  const prefixesBase = typeof adapter?.client?.url === 'function' && base && absolute.startsWith(base)
  const relative = prefixesBase ? absolute.slice(base.length) || '/' : absolute
  const candidates = relative === absolute ? [absolute] : [relative, absolute]
  let lastError
  for (const candidate of candidates) {
    try {
      return await adapter.downloadAttachment(candidate, destPath)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('附件下载失败')
}

// ------------------------------------------------------------------ 5. ctf_start_env

function specStartEnv(ctx) {
  return defineSpec({
    name: 'ctf_start_env',
    description: [
      '为环境题执行「开题 → 起环境 → 取地址」，返回可直连的靶机地址（host:port 规范化为 nc host port）。',
      '何时用：题目详情里「需要环境: 是」时（凌虚 task_type=1）。',
      '参数：id 题目 ID（必填）；connection 指定连接。',
      '副作用：在平台上真正拉起容器/实例并消耗比赛时间与配额；同一题重复调用是幂等的（平台会复用实例）。',
      '返回：连接信息（可能有多个目标）、是否只有内网地址的提示。用完请 ctf_release_env 释放。',
    ].join('\n'),
    parameters: {
      id: pId('题目 ID'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const id = normalizeId(args.id)
      if (!id) return '❌ 缺少题目 id。用法：ctf_start_env id=<题目ID>'
      const { adapter, connection } = await resolveAdapterFor(ctx, args)
      const result = await adapter.startEnvironment(id)
      const targets = Array.isArray(result?.targets) ? result.targets : []
      const connKey = connectionKeyOf(connection)
      const connectionInfo = result?.connectionInfo || targets.join('\n')
      const startedAt = nowIso(ctx)

      try {
        // 同时写两份视图：
        //  - `env`：本工具的完整环境状态；
        //  - 顶层 envStarted / envReleased / connectionInfo / envStartedAt：orchestrate.stop 靠它
        //    决定释放哪些环境（lib/orchestrate.js readWork），writeup 靠它写时间线与连接信息。
        await storeCall(ctx.store, 'upsertChallengeWork', connKey, id, {
          env: { targets, connectionInfo, startedAt, released: false },
          envStarted: true,
          envReleased: false,
          connectionInfo,
          envStartedAt: startedAt,
          requiresEnv: true,
        })
      } catch (error) {
        log(ctx, 'warn', `[ctf] 环境状态写入失败：${errorMessage(error)}`)
      }

      const lines = [`🚀 环境已就绪 — 题目 #${id}`]
      if (result?.connectionInfo) {
        lines.push('连接信息:')
        for (const line of String(result.connectionInfo).split('\n').filter(Boolean)) {
          lines.push(`  ${line}`)
        }
      } else if (targets.length) {
        lines.push('连接信息:')
        for (const target of targets) lines.push(`  ${target}`)
      } else {
        lines.push('⚠️ 平台未返回连接地址，请到平台页面确认环境状态。')
      }
      if (result?.hasPrivateOnly) {
        lines.push(
          '⚠️ 平台只返回了内网地址（192.168./10./172.16-31.）：若本机不在同一网络将无法直连，' +
            '请确认是否需要平台提供的公网映射或跳板。',
        )
      }
      lines.push(`用完记得释放：ctf_release_env id=${id}`)
      return lines.join('\n')
    },
  })
}

// ------------------------------------------------------------------ 6. ctf_release_env

function specReleaseEnv(ctx) {
  return defineSpec({
    name: 'ctf_release_env',
    description: [
      '释放某道环境题占用的靶机实例（幂等：环境已在释放中或本就没有运行环境都算成功）。',
      '何时用：解题结束、解题 agent 被中断、或 ctf_solve_stop 之后。',
      '参数：id 题目 ID（必填）；connection 指定连接。',
      '副作用：销毁平台上的实例（不影响已提交的 flag）。',
      '返回：释放结果文本。',
    ].join('\n'),
    parameters: {
      id: pId('题目 ID'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const id = normalizeId(args.id)
      if (!id) return '❌ 缺少题目 id。用法：ctf_release_env id=<题目ID>'
      const { adapter, connection } = await resolveAdapterFor(ctx, args)
      const result = await adapter.releaseEnvironment(id)
      const connKey = connectionKeyOf(connection)
      const releasedAt = nowIso(ctx)
      try {
        // 顶层字段与 orchestrate.js 的约定一致（envReleased/envStarted），避免重复释放
        await storeCall(ctx.store, 'upsertChallengeWork', connKey, id, {
          env: { targets: [], released: true, releasedAt },
          envReleased: true,
          envStarted: false,
          envReleasedAt: releasedAt,
        })
      } catch (error) {
        log(ctx, 'warn', `[ctf] 释放状态写入失败：${errorMessage(error)}`)
      }
      if (result?.unsupported) {
        return `ℹ️ 题目 #${id}：当前平台适配器不支持自动释放环境，请到平台页面手动释放。`
      }
      if (result?.notConfigured) {
        // 平台根本没为这题配环境（HTTP 400 +「该题目没有选择对应的环境」）：不算失败。
        return [
          `ℹ️ 题目 #${id}：平台未为该题配置环境，无需释放（不算失败）。`,
          `- 平台返回: ${result?.message || '该题目没有选择对应的环境，请联系管理员。'}`,
        ].join('\n')
      }
      return `🧹 已释放题目 #${id} 的环境${result?.idempotent ? '（幂等：此前已释放或正在释放）' : ''}。`
    },
  })
}

// ------------------------------------------------------------------ 7. ctf_submit_flag

function specSubmitFlag(ctx) {
  const { config } = ctx
  return defineSpec({
    hardFail: true,
    name: 'ctf_submit_flag',
    description: [
      '向平台提交 flag（核心工具）：先做本地去重与错误次数护栏，再提交并写审计日志。',
      '何时用：解题 agent 判定出 flag 后立即调用（全自动提交已开启）。',
      '参数：id 题目 ID（必填）；flag 完整 flag 字符串（必填，如 flag{...}）；connection 指定连接。',
      '护栏：dedupeFlags 开启时，同一题已成功提交过的相同 flag 直接返回 already_submitted，不再请求平台；',
      'maxWrongAttempts > 0 时，该题错误提交达到上限会直接拒绝（抛错），避免 punish=true 赛事持续扣分。',
      '副作用：真实提交到平台（会扣分/计分，不可撤销）+ 写入本地审计。',
      '返回：✅ 正确 / ♻️ 已提交过 / ❌ 错误（含累计错误次数）；平台或网络异常会以工具失败抛出（结果未知，勿盲目重试）。',
    ].join('\n'),
    parameters: {
      id: pId('题目 ID（必填）'),
      flag: { type: 'string', required: true, description: '完整 flag 字符串，例如 flag{...}' },
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const id = normalizeId(args.id)
      const flag = String(args.flag ?? '').trim()
      if (!id) throw new HardFail('缺少题目 id。用法：ctf_submit_flag id=<题目ID> flag=<flag>')
      if (!flag) throw new HardFail('flag 不能为空')

      const { adapter, connection } = await resolveAdapterFor(ctx, args)
      const connKey = connectionKeyOf(connection)

      if (config?.dedupeFlags !== false) {
        const duplicated = await storeCall(ctx.store, 'hasSubmittedFlag', connKey, id, flag)
        if (duplicated) {
          return [
            `♻️ already_submitted：题目 #${id} 的这个 flag 之前已成功提交过（本地去重，未重复请求平台）。`,
            `- flag: ${maskSecret(flag)}`,
            '无需再次提交；如需确认平台状态请用 ctf_status / ctf_challenge。',
          ].join('\n')
        }
      }

      const maxWrong = Number(config?.maxWrongAttempts) || 0
      let wrongCount = 0
      if (maxWrong > 0) {
        wrongCount = Number(await storeCall(ctx.store, 'wrongAttemptCount', connKey, id)) || 0
        if (wrongCount >= maxWrong) {
          throw new HardFail(
            `已拒绝提交：题目 #${id} 的错误提交已达上限 ${maxWrong} 次（maxWrongAttempts）。` +
              '请先确认真实 flag（注意大小写、前后缀、空格），必要时调高 maxWrongAttempts 配置后再试。',
          )
        }
      }

      let result
      try {
        result = await adapter.submitFlag(id, flag)
      } catch (error) {
        const message = errorMessage(error)
        try {
          await storeCall(ctx.store, 'recordSubmission', {
            connKey,
            challengeId: String(id),
            flag,
            status: 'error',
            message,
            at: nowIso(ctx),
          })
        } catch (auditError) {
          log(ctx, 'warn', `[ctf] 审计写入失败：${errorMessage(auditError)}`)
        }
        if (isSessionExpired(error)) {
          // 403 + {"detail":"未登录"}：明确是登录态失效，不是网络/平台异常。
          throw new HardFail(
            [
              `提交未成功：凌虚 sessionid 已失效，本次提交未生效 — 题目 #${id}`,
              '请重新登录平台后复制新的 Cookie，再用 ctf_connect { baseUrl, eventId, cookie } 更新（其余配置会保留），然后重试本题。',
              `- 平台返回: ${platformDetail(error) || message}`,
            ].join('\n'),
          )
        }
        // 其他 403 / 5xx / 网络异常：结果未知，保留原措辞，避免误判为「没提交成功」。
        throw new HardFail(
          `提交未成功（结果未知，请先确认平台状态再决定是否重试）：${message}`,
        )
      }

      const status = String(result?.status || 'unknown')
      try {
        await storeCall(ctx.store, 'recordSubmission', {
          connKey,
          challengeId: String(id),
          flag,
          status,
          message: result?.message || '',
          at: nowIso(ctx),
        })
      } catch (error) {
        log(ctx, 'warn', `[ctf] 审计写入失败：${errorMessage(error)}`)
      }

      if (status === 'correct' || status === 'already_solved') {
        return [
          `✅ ${status === 'correct' ? 'flag 正确，题目已解' : 'already_solved（平台显示此前已提交过正确 flag）'} — 题目 #${id}`,
          `- 平台返回: ${result?.message || '（无消息）'}`,
          `- 已记录审计（连接 ${connKey}，flag ${maskSecret(flag)}）`,
          '下一步: ctf_status 看排名变化；需要写 WP 用 ctf_writeup。',
        ].join('\n')
      }

      if (status === 'incorrect') {
        const total = maxWrong > 0 ? `（本题累计错误 ${wrongCount + 1} 次，上限 ${maxWrong}）` : `（本题累计错误 ${wrongCount + 1} 次，未设上限）`
        return [
          `❌ flag 错误，平台未接受 — 题目 #${id}`,
          `- 平台返回: ${result?.message || '（无消息）'}`,
          `- ${total}`,
          '提示: 检查大小写、前后缀（flag{}/CTF{}）、是否漏字符；不要盲目重复提交。',
        ].join('\n')
      }

      return [
        `❓ 平台返回了未知状态 "${status}" — 题目 #${id}`,
        `- 平台返回: ${result?.message || '（无消息）'}`,
        '- 已记录审计；建议用 ctf_challenges solved=true 或平台页面确认该题是否已解，再决定下一步。',
      ].join('\n')
    },
  })
}

// ------------------------------------------------------------------ 8. ctf_leaderboard

function specLeaderboard(ctx) {
  return defineSpec({
    name: 'ctf_leaderboard',
    description: [
      '查看排行榜：个人（user）/ 战队（team）/ AWD / CFS，返回名次表并标出自己（👈）。',
      '何时用：评估竞争态势、确认自己的排名与分数变化。',
      '参数：kind 榜单类型（默认 user）；size 显示前多少名（默认 20，上限 200）；connection 指定连接。',
      '返回：Markdown 表格 + 我的排名摘要。纯只读。',
    ].join('\n'),
    parameters: {
      kind: pEnum(['user', 'team', 'awd', 'cfs'], "榜单类型：'user' 个人（默认）/ 'team' 战队 / 'awd' / 'cfs'"),
      size: pInt('显示前多少名，默认 20，上限 200'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const kind = String(args.kind || 'user').toLowerCase()
      const size = clampInt(args.size, 1, 200, 20)
      const { adapter, connection } = await resolveAdapterFor(ctx, args)
      const board = await adapter.leaderboard(kind, { size })
      const rows = Array.isArray(board?.rows) ? board.rows : []
      const labels = { user: '个人', team: '战队', awd: 'AWD', cfs: 'CFS' }

      const header =
        `🏆 ${labels[kind] || kind}排行榜｜显示 ${rows.length} / 共 ${board?.total ?? rows.length} 条` +
        `｜连接 ${connectionKeyOf(connection)}`
      if (!rows.length) return `${header}\n（平台未返回榜单数据，可能尚未开始或接口受限）`

      const table = markdownTable(
        ['#', '名称', '总分', 'CTF', '理论', 'AWD', '解题', '一血'],
        rows.map((row) => [
          `${row.rank ?? '-'}${row.isSelf ? ' 👈' : ''}`,
          truncate(row.username || row.name || `#${row.id ?? '-'}`, 30),
          row.score ?? 0,
          row.ctfScore ?? 0,
          row.testScore ?? 0,
          row.awdScore ?? 0,
          row.solved ?? 0,
          row.firstBloods ?? 0,
        ]),
      )

      const lines = [header, table]
      const selfInTable = rows.find((row) => row.isSelf)
      if (!selfInTable && typeof adapter.myRank === 'function') {
        try {
          const mine = await adapter.myRank()
          if (mine?.rank != null) {
            lines.push(
              `我的排名: 第 ${mine.rank} 名 / 共 ${mine.total ?? '?'}（总分 ${mine.self?.score ?? '-'}；未进前 ${size} 名）`,
            )
          } else {
            lines.push('我的排名: 未上榜或平台未提供（请确认凭据有效）')
          }
        } catch (error) {
          lines.push(`我的排名: 获取失败（${errorMessage(error)}）`)
        }
      } else if (selfInTable) {
        lines.push(`我的排名: 第 ${selfInTable.rank} 名（总分 ${selfInTable.score}；解题 ${selfInTable.solved}）`)
      }
      return lines.join('\n')
    },
  })
}

// ------------------------------------------------------------------ 9. ctf_theory

function specTheory(ctx) {
  return defineSpec({
    name: 'ctf_theory',
    description: [
      '理论题一站式工具（一个工具多种动作）：列出试卷 / 开始考试 / 拉题目 / 逐题作答 / 查剩余时间 / 交卷。',
      '何时用：赛事含理论题（test_type=1）时。先 action=list 看有哪些试卷，再 begin → questions → answer… → finish。',
      '参数：action 动作（必填）；testId 试卷 ID；questionId 题目 ID（questions 输出的 [id=...]）；',
      'option 作答选项：单选/判断传 "B" 或 ["B"]；多选可传 "BCD"（自动拆成 ["B","C","D"] 并按平台要求排序）或 ["B","C","D"]；',
      '填空题按空位顺序传数组，如 ["答案1","答案2"]（不排序）；limit 拉题时最多显示多少题（默认 50）；connection 指定连接。',
      '⚠️ action=finish 是**不可逆**的交卷操作：交卷后不能再改答案，只能在确认所有题都作答后再调用。',
      '注意：试卷一旦交卷（状态=已交卷），平台不再开放题目列表（list/order 会 400「题目不是开启状态」）。',
      '返回：各动作对应的中文结果文本（列表 / 题面+选项 / 作答结果 / 剩余时间 / 交卷结果）。',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'begin', 'questions', 'answer', 'time', 'finish'],
        description:
          "动作：list=列出试卷；begin=开始考试；questions=拉题目与选项；answer=提交单题作答；time=查剩余时间；finish=交卷（不可逆）",
      },
      testId: pId('试卷 ID（begin/questions/answer/time/finish 必填）'),
      questionId: pId('题目 ID（answer 必填，来自 questions 的 [id=...]）'),
      option: {
        oneOf: [
          { type: 'string', description: '选项串，如 "B" / "BCD"（多选会自动拆分并排序）' },
          {
            type: 'array',
            items: { type: 'string' },
            description: '选项数组，如 ["B","C","D"]；填空题按空位顺序传（不排序）',
          },
        ],
        description:
          '选项值（answer 必填）：单选/判断 "B"；多选 "BCD" 或 ["B","C","D"]；填空题 ["答案1","答案2"]',
      },
      limit: pInt('questions 动作最多显示多少题，默认 50'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const action = String(args.action || '').toLowerCase()
      const supported = ['list', 'begin', 'questions', 'answer', 'time', 'finish']
      if (!supported.includes(action)) {
        return `❌ 未知 action "${args.action}"。可选：${supported.join(' / ')}`
      }
      const testId = normalizeId(args.testId)
      const questionId = normalizeId(args.questionId)
      const { adapter, connection } = await resolveAdapterFor(ctx, args)

      if (action === 'list') {
        if (typeof adapter.theoryTests !== 'function') return 'ℹ️ 当前平台适配器不支持理论题。'
        const tests = (await adapter.theoryTests()) || []
        if (!tests.length) return 'ℹ️ 该赛事没有理论题（或适配器不支持）。'
        const table = markdownTable(
          ['id', '名称', '题型', '题数', '分值', '时长', '状态', '交卷次数'],
          tests.map((test) => [
            test.id,
            truncate(test.name, 40),
            Array.isArray(test.types) && test.types.length ? test.types.join('/') : '-',
            test.count ?? 0,
            test.score ?? 0,
            test.timeSeconds ? formatDuration(test.timeSeconds) : '-',
            // ★ is_parse=已交卷 优先于 is_begin（交卷后平台把 is_begin 置回 false）
            test.statusLabel || theoryTestStatus(test).label,
            // parse_count 是「交卷次数」，不是已答题目数
            test.parseCount ?? 0,
          ]),
        )
        const submitted = tests.filter((test) => test.isParse)
        const lines = [`📚 理论题试卷（共 ${tests.length} 套${submitted.length ? `，已交卷 ${submitted.length} 套` : ''}）`, table]
        if (submitted.length) {
          lines.push('⚠️ 已交卷的试卷不能再拉题目/作答（平台会返回「题目不是开启状态」）。')
        } else {
          lines.push('下一步: ctf_theory action=begin testId=<id> 开始考试（注意开始后计时）。')
        }
        return lines.join('\n')
      }

      if (!testId) return `❌ action=${action} 需要 testId。先用 ctf_theory action=list 查看试卷 ID。`

      if (action === 'begin') {
        const result = await adapter.beginTheoryTest(testId)
        return [
          `▶️ 理论题 #${testId} 已开始${result?.status ? `（平台 status=${result.status}）` : ''}。`,
          `下一步: ctf_theory action=questions testId=${testId} 拉题目与选项。`,
          '⚠️ 考试计时已开始，注意 action=time 查剩余时间。',
        ].join('\n')
      }

      if (action === 'questions') {
        const limit = clampInt(args.limit, 1, 200, 50)
        const questions = (await adapter.theoryQuestions(testId)) || []
        if (!questions.length) return `ℹ️ 试卷 #${testId} 没有题目（可能尚未开始，先 action=begin）。`
        const shown = questions.slice(0, limit)
        const answeredCount = questions.filter(
          (q) => q.answered === true || normalizeOptionArray(q.userOption).length > 0,
        ).length
        const lines = [
          `📝 试卷 #${testId} 题目（共 ${questions.length} 题，显示 ${shown.length} 题，已作答 ${answeredCount} 题）`,
        ]
        for (const question of shown) {
          const typeLabel = question.optionTypeLabel || theoryOptionTypeLabel(question.optionType)
          const meta = [typeLabel, Number(question.score) ? `${question.score} 分` : ''].filter(Boolean).join('，')
          const answeredList = normalizeOptionArray(question.userOption)
          const answeredText = answeredList.length
            ? `（已作答：${question.userOptionText || answeredList.join('、')}）`
            : '（未作答）'
          lines.push(
            `${question.index ?? '-'}. [id=${question.id}]${meta ? `（${meta}）` : ''} ` +
              `${truncate(question.title, 300)} ${answeredText}`,
          )
          for (const opt of question.options || []) {
            lines.push(`   ${opt.key}. ${truncate(opt.text, 200)}`)
          }
          if (Number(question.optionType) === 4 && !(question.options || []).length) {
            const blanks = Number(question.optionCount) || 0
            lines.push(
              `   （填空题${blanks ? `，共 ${blanks} 空` : ''}：按空位顺序传数组，如 option=["答案1","答案2"]）`,
            )
          }
        }
        if (questions.length > shown.length) {
          lines.push(`（还有 ${questions.length - shown.length} 题未显示，可调大 limit）`)
        }
        lines.push(
          `作答: ctf_theory action=answer testId=${testId} questionId=<id> option=<选项>`,
          '多选可写 option=BCD（自动拆分排序）；填空题写 option=["答案1","答案2"]。',
        )
        return lines.join('\n')
      }

      if (action === 'answer') {
        const values = Array.isArray(args.option)
          ? normalizeOptionArray(args.option)
          : normalizeOptionArray(String(args.option ?? '').trim())
        if (!questionId) return '❌ action=answer 需要 questionId（questions 结果里的 [id=...]）。'
        if (!values.length) {
          return '❌ action=answer 需要 option，例如 option=A、option=BCD 或 option=["B","C","D"]。'
        }
        const result = await adapter.answerTheory(
          testId,
          questionId,
          Array.isArray(args.option) ? values : String(args.option).trim(),
        )
        const ok = result?.ok !== false
        const submitted = normalizeOptionArray(result?.option).length
          ? normalizeOptionArray(result.option)
          : values
        return [
          `${ok ? '✅ 已提交作答' : '⚠️ 平台未确认作答成功'}：试卷 #${testId} 题目 #${questionId} → ${submitted.join('、')}`,
          `- 平台返回: ${result?.message || '（无消息）'}`,
          ok ? '继续下一题；全部答完后用 action=finish 交卷（不可逆）。' : '请检查题目/选项是否合法后重试。',
        ].join('\n')
      }

      if (action === 'time') {
        if (typeof adapter.theoryTime !== 'function') return 'ℹ️ 当前平台适配器不支持查询理论题剩余时间。'
        const payload = await adapter.theoryTime(testId)
        const seconds = Number(payload?.seconds)
        return [
          `⏱️ 试卷 #${testId}${payload?.name ? `「${payload.name}」` : ''} 剩余时间: ${
            Number.isFinite(seconds) ? `${formatClock(seconds)}（${seconds}s）` : '平台未返回'
          }`,
        ].join('\n')
      }

      // action === 'finish'
      const result = await adapter.finishTheory(testId)
      const ok = result?.ok !== false
      return [
        `${ok ? '📤 已交卷（不可逆）' : '⚠️ 交卷未确认成功'}：试卷 #${testId}`,
        `- 平台返回: ${result?.message || '（无消息）'}`,
        ok
          ? '交卷后不能再修改答案。用 ctf_theory action=list 确认状态，ctf_status 看分数变化。'
          : '请到平台页面确认试卷状态，避免重复交卷。',
      ].join('\n')
    },
  })
}

// ------------------------------------------------------------------ 10~13. 委派工具

/** 取注入的委派模块（orchestrator / writeup），缺失时给出可操作的硬失败。 */
function requireDelegate(ctx, key, method, toolName, hint) {
  const delegate = ctx.deps?.[key]
  if (!delegate || typeof delegate[method] !== 'function') {
    throw new HardFail(
      `${toolName} 需要 ${key}.${method}()，但插件未注入 ${key} 模块（应由 lib/index.js 装配）。${hint || ''}`.trim(),
    )
  }
  return delegate
}

async function delegateResult(toolName, delegate, method, args) {
  const result = await delegate[method](args)
  if (typeof result === 'string') return result
  if (result === undefined || result === null) return `${toolName} 已完成（无输出）。`
  return `${toolName} 结果:\n${stringify(result)}`
}

function specSolveStart(ctx) {
  const { config } = ctx
  return defineSpec({
    name: 'ctf_solve_start',
    description: [
      '拉起并发解题 agent 团队：同步未解题目 → 建共享任务板 → 按 concurrency 分批 spawnTeammate（默认 4，上限 8）。',
      '何时用：用户要求「自动解题 / 拉团队打比赛」时；需要已 ctf_connect。',
      '参数：category 只做某分类；minScore 只做分值 ≥ 该值的题；limit 最多编排多少题（省略时编排全部符合条件的题目，上限 200）；',
      'onlyUnsolved 是否只做未解题（默认 true）；concurrency 并发数（默认取配置，上限 8）；connection 指定连接。',
      '副作用：创建共享任务、spawn 多个 teammate、占用本会话的并发配额；每道环境题会由 teammate 自行拉起环境。',
      '返回：编排摘要（任务数、teammate 名单）。后续用 ctf_solve_status 查进度，ctf_solve_stop 停止。',
      '注意：必须在会话内由 Lead agent 调用（工具会把 exec.agent 身份透传给编排层）。',
    ].join('\n'),
    parameters: {
      category: pString('只编排该分类的题目（如 Web），省略为全部'),
      minScore: pNum('只编排分值 ≥ 该值的题目'),
      limit: pInt('最多编排多少道题，省略时编排全部符合条件的题目（上限 200）'),
      onlyUnsolved: pBool('是否只编排未解题，默认 true'),
      concurrency: pInt('并发解题 agent 数，默认取插件配置（默认 4），上限 8'),
      connection: CONNECTION_PARAM,
    },
    async execute(args, exec) {
      const orchestrator = requireDelegate(
        ctx,
        'orchestrator',
        'start',
        'ctf_solve_start',
        '请确认 lib/orchestrate.js 已实现并由 lib/index.js 注入为 deps.orchestrator。',
      )
      const concurrency = clampInt(args.concurrency, 1, 8, clampInt(config?.concurrency, 1, 8, 4))
      const payload = {
        ...args,
        concurrency,
        onlyUnsolved: args.onlyUnsolved !== false,
        // ctx.agentTeams 的每个方法都需要 callerAgent / AbortSignal，只能来自 exec
        __agent: exec?.agent,
        __signal: exec?.signal,
      }
      return delegateResult('ctf_solve_start', orchestrator, 'start', payload)
    },
  })
}

function specSolveStatus(ctx) {
  return defineSpec({
    name: 'ctf_solve_status',
    description: [
      '查看并发解题团队进度：共享任务板状态 + 平台侧题目/排名对照。',
      '何时用：ctf_solve_start 之后轮询进度、判断是否需要补人。',
      '参数：connection 指定连接。',
      '返回：任务板与平台状态对照文本。纯只读。',
    ].join('\n'),
    parameters: { connection: CONNECTION_PARAM },
    async execute(args, exec) {
      const orchestrator = requireDelegate(
        ctx,
        'orchestrator',
        'status',
        'ctf_solve_status',
        '请确认 lib/orchestrate.js 已实现并由 lib/index.js 注入为 deps.orchestrator。',
      )
      return delegateResult('ctf_solve_status', orchestrator, 'status', {
        ...args,
        __agent: exec?.agent,
        __signal: exec?.signal,
      })
    },
  })
}

function specSolveStop(ctx) {
  return defineSpec({
    name: 'ctf_solve_stop',
    description: [
      '停止解题团队：中断所有解题 agent，并默认释放它们拉起的环境。',
      '何时用：用户喊停、比赛结束、或需要重新编排时。',
      '参数：reason 停止原因（写入摘要）；releaseEnvs 是否释放已开启的解题环境（默认 true，传 false 保留环境）；connection 指定连接。',
      '副作用：中断运行中的 teammate（其未完成任务保留在任务板上，可用 ctf_solve_status 查看）；releaseEnvs=true 时还会销毁平台上的靶机实例。',
      '返回：停止摘要（中断名单 + 释放结果）。',
      '注意：必须在会话内由 Lead agent 调用（工具会把 exec.agent 身份透传给编排层）。',
    ].join('\n'),
    parameters: {
      reason: pString('停止原因，便于记录（可选）'),
      releaseEnvs: pBool('是否释放已开启的解题环境，默认 true；传 false 则保留环境'),
      connection: CONNECTION_PARAM,
    },
    async execute(args, exec) {
      const orchestrator = requireDelegate(
        ctx,
        'orchestrator',
        'stop',
        'ctf_solve_stop',
        '请确认 lib/orchestrate.js 已实现并由 lib/index.js 注入为 deps.orchestrator。',
      )
      return delegateResult('ctf_solve_stop', orchestrator, 'stop', {
        ...args,
        // DESIGN §5：ctf_solve_stop 默认释放环境；编排层只认显式 true，所以这里补默认值
        releaseEnvs: args.releaseEnvs !== false,
        __agent: exec?.agent,
        __signal: exec?.signal,
      })
    },
  })
}

function specWriteup(ctx) {
  return defineSpec({
    name: 'ctf_writeup',
    description: [
      '生成解题报告（Writeup）：汇总题面、解题过程、flag 与关键命令，可选提交到平台 WP 接口。',
      '何时用：题目解出后（通常由解题 agent 在 ctf_submit_flag 成功后调用）。',
      '参数：id 指定题目（省略则按已解题目批量生成）；body 解题思路正文（Markdown，强烈建议由解题 agent 填写）；',
      'submit=true 同时提交到平台（默认 false，只生成本地文件）；title 自定义标题；connection 指定连接。',
      '副作用：写本地 WP 文件；submit=true 时会在平台上发布 WP（对外可见）。',
      '返回：WP 路径与提交结果。',
    ].join('\n'),
    parameters: {
      id: pId('题目 ID（省略则对已解题目批量生成）'),
      body: pString('解题思路正文（Markdown），由解题 agent 总结；会作为 WP 的「## 解题思路」正文'),
      submit: pBool('是否提交到平台 WP 接口，默认 false（只生成本地文件）'),
      title: pString('自定义 WP 标题'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const writeup = requireDelegate(
        ctx,
        'writeup',
        'generate',
        'ctf_writeup',
        '请确认 lib/writeup.js 已实现并由 lib/index.js 注入为 deps.writeup。',
      )
      // 与其余 12 个工具统一用 `id`；`challengeId` 保留为旧别名（未在 schema 声明，
      // 但参数校验不会拒绝未声明字段）。writeup 模块读的是 challengeId，这里统一归一化后转发。
      const challengeId = args.id ?? args.challengeId
      const payload = { ...args, submit: args.submit === true }
      if (challengeId !== undefined && challengeId !== null && String(challengeId).trim() !== '') {
        payload.challengeId = challengeId
      }
      return delegateResult('ctf_writeup', writeup, 'generate', payload)
    },
  })
}

// ------------------------------------------------------------------ 装配

/**
 * 构造 13 个工具规格对象。
 * @param {object} [deps] 见文件头注释；缺省时仍能返回全部规格（执行时才需要依赖）。
 * @returns {Array<object>} ToolSpec[]
 */
export function buildToolSpecs(deps) {
  const options = deps || {}
  const ctx = {
    deps: options,
    config: options.config || {},
    store: options.store,
    logger: options.logger || {},
    now: typeof options.now === 'function' ? options.now : () => Date.now(),
  }
  return [
    specConnect(ctx),
    specStatus(ctx),
    specChallenges(ctx),
    specChallenge(ctx),
    specStartEnv(ctx),
    specReleaseEnv(ctx),
    specSubmitFlag(ctx),
    specLeaderboard(ctx),
    specTheory(ctx),
    specSolveStart(ctx),
    specSolveStatus(ctx),
    specSolveStop(ctx),
    specWriteup(ctx),
  ]
}

export default buildToolSpecs
