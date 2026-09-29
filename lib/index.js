/**
 * dsh-lingxu-ctf — 宿主插件入口。
 *
 * 职责：装配。业务逻辑分散在：
 *   lib/lingxu.js      平台客户端
 *   lib/platforms.js   平台适配器（只支持凌虚 lingxu）
 *   lib/store.js       持久化与审计
 *   lib/tools.js       14 个模型可见工具
 *   lib/orchestrate.js Agent Teams 并发编排
 *   lib/writeup.js     WP 生成与提交
 *   lib/client.js      Web 控制面板（浏览器半，自托管）
 *
 * 本文件只做：配置归一化 → 依赖注入 → 注册工具 / 提示词 / 路由 / 命令。
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import z from '@deepseek-ai/schemastery'

import { defineTool } from './toolkit.js'
import { getStore, connectionKey } from './store.js'
import { createAdapter, listPlatforms } from './platforms.js'
import { buildToolSpecs } from './tools.js'
import {
  createOrchestrator,
  parseChallengeId,
  challengeIdFromScope,
  parseMemberDescription,
  parseTaskSubject,
} from './orchestrate.js'
import { createWriteup } from './writeup.js'

export const name = 'dsh-lingxu-ctf'

/** `tools` 是硬依赖；其余服务按可用性降级使用。 */
export const inject = ['tools']

const PANEL_ROUTE = '/lingxu-ctf/state'
const CLIENT_ROUTE = '/lingxu-ctf/client.js'
const CONFIG_ROUTE = '/lingxu-ctf/config'
const DIAG_ROUTE = '/lingxu-ctf/diag'
const BEACON_ROUTE = '/lingxu-ctf/beacon'
/** 顶部「CTF」视图的数据源：agent 团队全景（成员 / 任务板 / 协同消息）。 */
const TEAM_ROUTE = '/lingxu-ctf/team'
/** 顶部「CTF」视图的「报告」子视图：本地生成的 writeup 列表（纯本地，不请求平台）。 */
const REPORTS_ROUTE = '/lingxu-ctf/reports'
/** 团队消息默认/最大返回条数（`?limit=` 可覆盖）。 */
export const TEAM_MESSAGES_DEFAULT_LIMIT = 50
export const TEAM_MESSAGES_MAX_LIMIT = 200

/**
 * 插件配置 schema —— **这就是设置页里那份表单**。
 *
 * 导出 `Config` 后，DSH 的设置页（设置 → 插件 → 插件配置）会自动按 schema 渲染控件，
 * 用户填一次平台地址 / 赛事 ID / Cookie，之后选「CTF 解题模式」说「开始」就能跑，
 * 不必在对话里传凭据。
 *
 * 注意：
 * - 每个字段都必须有 `.default()`：缺默认值的字段会被 Loader 判为「missing required value」
 *   而让整行加载失败（本仓库就踩过 `dsh-tool-fs-search` 那个坑）。
 * - `cookie` 用 `role('secret')`：DSH 会在跨线（发给浏览器）前结构化脱敏，
 *   设置页渲染成**只写输入框**，密钥本身不会被前端读到。
 */
export const Config = z
  .object({
    baseUrl: z
      .string()
      .default('')
      .description('平台根地址，例如 https://ctf.example.com:8000（凌虚不要带前端 # 路由）')
      .volatile(),
    eventId: z.number().default(0).description('赛事 ID：填 URL 里 /event/<id>/ 的 id').volatile(),
    cookie: z
      .string()
      .role('secret')
      .default('')
      .description('浏览器复制的完整 Cookie（必须含 sessionid=...）。只存在本机，不会外发')
      .volatile(),
    label: z.string().default('').description('连接备注名，便于多赛事识别').volatile(),
    concurrency: z
      .number()
      .default(4)
      .description('并发解题 agent 数（1–8，默认 4）。每题一个 agent，共享任务板互相通信')
      .volatile(),
    maxWrongAttempts: z
      .number()
      .default(0)
      .description('单题 flag 最大错误提交次数；0 = 不限制（错误提交可能扣分，见赛事 punish 提示）')
      .volatile(),
    envLimit: z
      .number()
      .default(2)
      .description('本赛事同时可运行的环境数上限（平台 CompetitionCTFs.env_limit，默认 2）。0 = 让 agent 从平台报错里自动学习')
      .volatile(),
    envAutoDelay: z
      .boolean()
      .default(true)
      .description('环境剩余不足 30 分钟时自动调用延时接口（每次 +30 分钟）。平台只允许剩余 <30 分钟时延时')
      .volatile(),
    dedupeFlags: z.boolean().default(true).description('同一题重复提交相同 flag 时本地去重，不再请求平台').volatile(),
    workDir: z.string().default('').description('附件与 WP 落盘目录；留空 = 工作区下的 lingxu-ctf-work/').volatile(),
    timeoutMs: z.number().default(30000).description('平台请求超时（毫秒）').volatile(),
    enableWebPanel: z.boolean().default(true).description('在 Web 界面右下角显示 CTF 控制面板').volatile(),
    enableFloatingPanel: z
      .boolean()
      .default(false)
      .description('在 Web 界面右下角显示浮动面板（默认关闭，主要看顶部「CTF」视图）')
      .volatile(),
  })
  // ⚠️ 每个字段都必须 `.volatile()` —— 这是**设置页出现表单的必要条件**，不是可选修饰。
  //
  // dsh-settings 的 describe() 里有一句：
  //     const form = volatileForm(schema); if (form === void 0) return [];
  // 而 volatileForm 只在 schema 本身或**某个字段**带 `meta.volatile` 时才返回表单。
  // 只导出 Config 而不加 volatile 的表现是：插件能跑、但设置里**找不到任何配置项**（实测踩过）。
  // 官方 `dsh-web-search-deepseek` 的 Config 就是逐字段 `.volatile()`。
  //
  // 代价：volatile 字段解析后是「稳定引用」对象（带 `.get()`），读值前必须解包 ——
  // 见下面的 `plainConfigValue()`。
  //
  // 注意：**只能逐字段标**。给外层 object 也加 `.volatile()` 会被 schemastery 拒绝：
  //   ValidationError: volatile fields require a fixed object path without an enclosing volatile field

/**
 * 把 Loader 给的 volatile 引用解包成普通 JSON 值。
 *
 * schemastery 的 `.volatile()` 会把字段解析成带 `.get()` 的稳定引用
 * （`JSON.stringify` 出来是 `{}`）。DSH 自己的插件也这么处理，
 * 例如 dsh-opencode-go-usage 的 `plainConfigValue()`。
 */
export function plainConfigValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return plainConfigValue(value.get())
  }
  if (Array.isArray(value)) return value.map(plainConfigValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfigValue(child)]))
  }
  return value
}

/** 归一化插件配置（纯函数，便于单测；不依赖 schemastery）。 */
export function normalizeConfig(raw = {}) {
  // 先解包 volatile 引用：直接读会拿到 {} 而不是真实值
  const source = plainConfigValue(raw) ?? {}
  const concurrency = Number(source.concurrency ?? 4)
  return {
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl.trim().replace(/\/+$/, '') : '',
    eventId: Number.isFinite(Number(source.eventId)) ? Math.max(0, Math.trunc(Number(source.eventId))) : 0,
    cookie: typeof source.cookie === 'string' ? source.cookie.trim() : '',
    label: typeof source.label === 'string' ? source.label.trim() : '',
    concurrency: Number.isFinite(concurrency) ? Math.min(Math.max(Math.trunc(concurrency), 1), 8) : 4,
    maxWrongAttempts: Number.isFinite(Number(source.maxWrongAttempts)) ? Math.max(0, Math.trunc(Number(source.maxWrongAttempts))) : 0,
    envLimit: Number.isFinite(Number(source.envLimit)) ? Math.max(0, Math.trunc(Number(source.envLimit))) : 2,
    envAutoDelay: source.envAutoDelay !== false,
    dedupeFlags: source.dedupeFlags !== false,
    workDir: typeof source.workDir === 'string' ? source.workDir.trim() : '',
    timeoutMs: Number.isFinite(Number(source.timeoutMs)) ? Math.max(1000, Math.trunc(Number(source.timeoutMs))) : 30000,
    enableWebPanel: source.enableWebPanel !== false,
    // 默认关闭：顶部「CTF」视图是主入口，右下角浮动面板只在显式开启时出现
    enableFloatingPanel: source.enableFloatingPanel === true,
  }
}

/** 配置里是否填了足够的凭据可以直接连平台。 */
export function configHasCredentials(config) {
  if (!config?.baseUrl) return false
  return Boolean(config.eventId && config.cookie)
}

/** 题名 → 文件系统安全且保留中文可读性的 slug。 */
export function slugify(value, fallback = 'challenge') {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    // 只剔除路径分隔符、控制字符与 Windows 保留字符；保留中文等可读字符
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/g, '')
  return text || fallback
}

/**
 * 安全获取宿主 service（**仅供测试替身/降级路径**）。
 *
 * ⚠️ 在真实 DSH 里 `ctx.get('x')` 取不到未写进插件 `inject` 的 service（静默返回 undefined），
 * 所以生产装配一律走 `withService`（基于 `ctx.inject` 起子 fiber 等依赖就绪）。
 * 这里只保留给 mock 上下文兜底。
 */
function service(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/**
 * 等某个**可选** service 就绪后再执行装配。
 *
 * `export const inject = [...]` 的语义是「必需」——写进去会让缺少该服务的组合整体加载失败。
 * 可选依赖的正解是 `ctx.inject([name], cb)`：Cordis 会起一个子 fiber，等依赖出现才跑 cb，
 * 且父 fiber 卸载时一并释放。测试替身没有 `ctx.inject` 时退化为直接取一次。
 *
 * @returns 是否已（同步或异步地）安排装配
 */
function withService(ctx, name, callback, logger) {
  try {
    // 注意：ctx.inject 本身也可能触发 Cordis 的 Proxy 守卫（未声明即抛），单独包一层
    let injectFn
    try {
      injectFn = ctx.inject
    } catch {
      injectFn = undefined
    }
    if (typeof injectFn === 'function') {
      injectFn.call(ctx, [name], (serviceCtx) => callback(serviceCtx, serviceCtx[name]))
      return true
    }
    const value = service(ctx, name)
    if (value !== undefined) {
      callback(ctx, value)
      return true
    }
    return false
  } catch (error) {
    logger?.warn?.(`等待服务 ${name} 失败：${error?.message ?? error}`)
    return false
  }
}

/**
 * 默认工作目录。
 *
 * Electron 应用从 Finder 启动时 `process.cwd()` 是 `/`，直接拼会得到不可写的 `/lingxu-ctf-work`。
 * 因此只在 cwd 看起来可用时才用它，否则退回用户主目录。
 */
function defaultWorkDir() {
  const cwd = process.cwd()
  const usable = typeof cwd === 'string' && path.isAbsolute(cwd) && cwd !== '/' && cwd !== '/private'
  return path.join(usable ? cwd : os.homedir(), 'lingxu-ctf-work')
}

function resolveWorkDir(config) {
  return config.workDir || defaultWorkDir()
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  // ctx.logger 是 Cordis 核心属性（走 Reflect.has 短路，不触发 inject 守卫），
  // 但仍包一层：任何上下文替身都不该让插件加载失败。
  let hostLogger
  try {
    hostLogger = ctx.logger
  } catch {
    hostLogger = undefined
  }
  const logger = {
    info: (...a) => hostLogger?.info?.(...a) ?? console.log('[lingxu-ctf]', ...a),
    warn: (...a) => hostLogger?.warn?.(...a) ?? console.warn('[lingxu-ctf]', ...a),
    error: (...a) => hostLogger?.error?.(...a) ?? console.error('[lingxu-ctf]', ...a),
  }

  const store = getStore()
  const workDir = resolveWorkDir(config)

  // ── 依赖注入：解析当前应使用的平台连接与适配器 ────────────────────────
  //
  // 解析顺序：显式参数 > 本地已存连接 > **插件配置兜底**。
  // 最后一条是关键：用户在设置页填好平台地址/赛事ID/Cookie 后，直接说「开始」就能用，
  // 不必先在对话里跑 ctf_connect（也就不会把凭据打进聊天记录）。
  async function resolveAdapter(args = {}) {
    let connection = await store.resolveConnection({
      key: args.connection,
      platform: args.platform,
      eventId: args.eventId,
      baseUrl: args.baseUrl,
    })

    if (!connection && configHasCredentials(config)) {
      connection = {
        platform: 'lingxu',
        baseUrl: config.baseUrl,
        eventId: config.eventId,
        cookie: config.cookie,
        label: config.label || '插件配置',
        fromConfig: true,
      }
      connection.key = connectionKey(connection)
    }

    if (!connection) {
      const known = await store.listConnections()
      const hint = known.length
        ? `已配置的连接：${known.map((c) => `${c.key}${c.label ? `（${c.label}）` : ''}`).join('、')}`
        : '当前没有任何已配置的连接。'
      throw new Error(
        '未找到可用的平台连接。请在「设置 → 插件 → 插件配置 → 凌虚 CTF」里填好' +
          '平台地址、赛事 ID 与 Cookie；或在会话里调用 ctf_connect。' +
          hint,
      )
    }
    const adapter = createAdapter({ ...connection, timeoutMs: config.timeoutMs })
    return { adapter, connection, connKey: connectionKey(connection) }
  }

  const deps = {
    config: { ...config, workDir },
    store,
    resolveAdapter,
    logger,
    now: () => Date.now(),
    fs: fsp,
    orchestrator: undefined,
    writeup: undefined,
    teams: undefined, // agentTeams 就绪后由下面的 withService 填上（/lingxu-ctf/team 读它）
    session: undefined, // 会话身份（exec.agent）捕获槽，见 withSessionCapture
  }

  // 会话身份捕获：`GET /lingxu-ctf/team` 需要用 callerAgent 读任务板，而 HTTP 路由没有 exec。
  // 编排器只在 ctf_solve_* 时捕获 Lead 身份；这里对**所有** ctf_* 工具兜一层，
  // 覆盖「Lead 没跑过 solve_*」「用户直接用 DSH 的 spawn_teammate 起人」「teammate 自己调 ctf_* 工具」三种场景。
  const session = { caller: null }
  deps.session = session

  // ── 编排与 WP ────────────────────────────────────────────────────────
  // agentTeams 是**可选**服务：用 ctx.inject 等它就绪后再建编排器。
  //
  // ⚠️ 不能用 `ctx.get('agentTeams')`：在真实 Loader 上下文里，未写进插件 `inject`
  //    的 service 通过 ctx.get 取不到（静默返回 undefined），实测已确认
  //    （agent-team bundle 明明是 active，却报「Agent Teams 未挂载」）。
  //    而 `inject` 数组语义是「必需」，把 agentTeams 写进去会让没装该 bundle 的组合
  //    整体加载失败，所以用 ctx.inject 起子 fiber 等它。
  deps.writeup = createWriteup(deps)
  withService(ctx, 'agentTeams', (serviceCtx, teams) => {
    deps.teams = teams // /lingxu-ctf/team 在请求时读它（服务晚于 webServer 就绪也不会漏）
    deps.orchestrator = createOrchestrator({ ...deps, teams })
    logger.info('Agent Teams 已就绪：ctf_solve_start / status / stop 可用')
  }, logger)

  // ── 工具注册 ─────────────────────────────────────────────────────────
  const specs = buildToolSpecs(deps)
  const disposers = []
  for (const spec of specs) {
    disposers.push(ctx.tools.register(defineTool(withSessionCapture(spec, session))))
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        logger.warn('工具注销失败', error?.message ?? error)
      }
    }
  })

  // ── 系统提示词：告诉 agent 这套工具的存在与纪律 ────────────────────────
  withService(ctx, 'systemPrompt', (_c, systemPrompt) => {
    if (!systemPrompt?.section) return
    systemPrompt.section({
      name: 'ctf:protocol',
      order: 500,
      text: [
        '当用户要求你处理 CTF 竞赛（尤其是凌虚竞赛平台）时，使用 ctf_* 工具族：',
        '- 先 ctf_connect 配置平台地址与 sessionid，再 ctf_status 看全局。',
        '- 开始比赛前先跑 ctf_session 探活；任何工具报 403/未登录时，先让用户更新 Cookie。',
        '- ctf_challenges / ctf_challenge 摸题，ctf_start_env 开环境，ctf_submit_flag 交 flag。',
        '- 需要并发解题时用 ctf_solve_start 拉起 agent 团队，用 ctf_solve_status 看进度。',
        '- 解出题目后用 ctf_writeup 生成 writeup。',
        '不确定的 flag 不要反复提交：部分赛事开启了错误提交扣分（ctf_status 会提示 punish）。',
      ].join('\n'),
    })
  }, logger)

  // ── Web 控制面板 ─────────────────────────────────────────────────────
  if (config.enableWebPanel) {
    withService(ctx, 'webServer', (serviceCtx, webServer) => {
      if (!webServer?.register) return
      registerWebPanel(serviceCtx, webServer, { deps, store, resolveAdapter, config, workDir, logger })
    }, logger)
  }

  // ── 斜杠命令：快速看状态 ─────────────────────────────────────────────
  withService(ctx, 'commands', (_c, commands) => {
    if (!commands?.register) return
    commands.register({
      name: 'ctf-status',
      description: '查看凌虚 CTF 当前状态（赛事 / 题目 / 排名）',
      handler: async () => {
        try {
          const { adapter, connection } = await resolveAdapter({})
          const [summary, challenges, rank] = await Promise.all([
            adapter.eventSummary(),
            adapter.challenges(),
            adapter.myRank().catch(() => null),
          ])
          const solved = challenges.filter((c) => c.solved).length
          const lines = [
            `赛事：${summary.name || '(未命名)'} @ ${connection.baseUrl} (event ${connection.eventId})`,
            `用户：${summary.user?.username ?? '?'}${rank?.rank ? `　排名：${rank.rank}/${rank.total}` : ''}`,
            `题目：${challenges.length} 题，已解 ${solved}，待解 ${challenges.length - solved}`,
            `平台：${connection.platform}`,
          ]
          if (summary.punish) lines.push('⚠ 本赛事开启错误提交扣分（punish=true）')
          return { kind: 'success', text: lines.join('\n') }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  }, logger)

  logger.info(
    `已加载：${specs.length} 个工具，平台适配器 [${listPlatforms().join(', ')}]，工作目录 ${workDir}，并发 ${config.concurrency}`,
  )
}

/** 注册面板状态路由与客户端 bundle 路由。 */
/** 设置页表单的中文标签（key → 显示名）。describeConfigFields 会带上它。 */
export const CONFIG_LABELS = {
  baseUrl: '平台地址',
  eventId: '赛事 ID',
  cookie: 'Cookie（sessionid）',
  label: '连接备注名',
  concurrency: '并发解题 Agent 数',
  maxWrongAttempts: '单题错误提交上限',
  envLimit: '同时运行环境数上限',
  envAutoDelay: '环境到期自动延时',
  dedupeFlags: 'flag 本地去重',
  workDir: '工作目录',
  timeoutMs: '请求超时（毫秒）',
  enableWebPanel: '显示 Web 控制面板',
  enableFloatingPanel: '显示右下角浮动面板',
}

/** 从 Config schema 描述设置页要渲染的字段。 */
export function describeConfigFields() {
  const dict = Config?.dict ?? {}
  return Object.entries(dict).map(([key, child]) => {
    const meta = child.meta ?? {}
    // union-of-consts（例如 lingxu | lingxu-web）→ 下拉选项
    const constList = Array.isArray(child.list) ? child.list.filter((v) => v?.type === 'const') : []
    const options =
      constList.length > 0 && constList.length === child.list.length ? constList.map((v) => v.value) : undefined
    return {
      key,
      label: CONFIG_LABELS[key] ?? key,
      type: child.type,
      description: meta.description ?? '',
      role: meta.role ?? null,
      default: meta.default ?? null,
      options,
    }
  })
}

/** 读取一小段 JSON 请求体（带体积上限）。 */
export function readJsonBody(req, { maxBytes = 262144 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy?.()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 读取查询串里的 `limit`（非法/缺失时回退默认值，并夹在 1..max）。 */
export function readLimitParam(req, fallback, max) {
  try {
    const url = new URL(req?.url ?? '/', 'http://localhost')
    const raw = url.searchParams.get('limit')
    if (raw == null || raw === '') return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 1) return fallback
    return Math.min(Math.floor(n), max)
  } catch {
    return fallback
  }
}

/**
 * 给工具 spec 的 `execute` 包一层：记录最近一次调用本插件工具的 Agent（`exec.agent`）。
 *
 * 为什么要这层：`/lingxu-ctf/team` 要调 `ctx.agentTeams.listTasks/listMembers`，而这些方法
 * 需要真实 callerAgent；HTTP 路由没有 exec，只能靠会话内捕获。编排器只覆盖 `ctf_solve_*`，
 * 这层覆盖全部 `ctf_*` 工具（任意一个被调用，团队视图就有会话语境）。
 *
 * 纯旁路：不改参数、不改返回值、不改校验顺序；捕获异常一律吞掉。
 */
export function withSessionCapture(spec, session) {
  const run = spec?.execute
  if (typeof run !== 'function' || !session || typeof session !== 'object') return spec
  return {
    ...spec,
    execute(args, exec) {
      try {
        if (exec?.agent) session.caller = exec.agent
      } catch {
        /* 捕获失败不影响工具执行 */
      }
      return run(args, exec)
    },
  }
}

function registerWebPanel(ctx, webServer, { deps, store, resolveAdapter, config, workDir, logger }) {
  // 诊断计数器：客户端半没生效时用来定位到底断在哪一环
  const diag = {
    startedAt: new Date().toISOString(),
    webServerMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(webServer ?? {})).sort(),
    hasTapIndex: typeof webServer?.tapIndex === 'function',
    tapRegistered: false,
    tapCalls: 0,
    tapFoundBoot: false,
    tapInjected: false,
    tapLastLen: 0,
    clientServed: 0,
    configServed: 0,
    lastTapAt: null,
    lastTapError: null,
    beacons: [],
  }

  // 面板快照
  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: PANEL_ROUTE,
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        try {
          res.end(JSON.stringify(await buildPanelState({ store, resolveAdapter, deps, config })))
        } catch (error) {
          res.statusCode = 200
          res.end(
            JSON.stringify({
              ok: false,
              configured: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          )
        }
      },
    }),
  )

  // ── 顶部「CTF」视图：agent 团队全景 ──────────────────────────────────
  //
  // 客户端视图用轮询读它。**HTTP 路由没有 exec.agent**，所以 caller 只能用
  // 编排器在会话内捕获的 Lead 身份（orchestrator.getCaller()）；尚未捕获时
  // 返回 ok:false（HTTP 200），由前端渲染空态并提示先跑一次 ctf_* 工具。
  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: TEAM_ROUTE,
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let payload
        try {
          payload = await buildTeamState({
            store,
            teams: deps.teams,
            // 优先用编排器捕获的 Lead 身份（稳定），退化为最近一次 ctf_* 调用者
            caller: deps.orchestrator?.getCaller?.() ?? deps.session?.caller ?? null,
            resolveAdapter,
            messagesLimit: readLimitParam(req, TEAM_MESSAGES_DEFAULT_LIMIT, TEAM_MESSAGES_MAX_LIMIT),
          })
        } catch (error) {
          payload = emptyTeamPayload(new Date().toISOString(), error instanceof Error ? error.message : String(error))
        }
        res.statusCode = 200
        res.end(JSON.stringify(payload))
      },
    }),
  )

  // ── 顶部「CTF」视图：报告（本地 WP 列表，纯本地不请求平台）────────────────
  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: REPORTS_ROUTE,
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        try {
          res.end(JSON.stringify(await buildReportsState({ store, resolveAdapter, workDir })))
        } catch (error) {
          res.statusCode = 200
          res.end(JSON.stringify({ ok: false, generatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), writeups: [] }))
        }
      },
    }),
  )

  // ── 配置读写路由 ─────────────────────────────────────────────────────
  //
  // 设置页的配置卡片（lib/client.js 注册到 plugins.bundle.config）通过这两个路由
  // 读写本插件配置。写入走 ctx.configEditor.edit(entry, change) —— DSH 0.2 的原生写路径，
  // 会落到 profile 的 patch 层并经 Loader 生效（HMR 实时重载）。
  //
  // ⚠️ configEditor 必须通过 ctx.inject 拿（ctx.get 对未 inject 的 service 返回 undefined）；
  //    entry 要从**本插件自己的 fiber** 取，不能从子 fiber 取。
  let configApi = null
  withService(
    ctx,
    'configEditor',
    (_serviceCtx, configEditor) => {
      const entry = ctx.fiber?.entry
      if (!entry || typeof configEditor?.edit !== 'function') return
      configApi = {
        async read() {
          const raw = plainConfigValue(entry.fiber?.config ?? entry.options?.config ?? {}) ?? {}
          const fields = describeConfigFields()
          const values = {}
          const secretsSet = {}
          for (const f of fields) {
            if (f.role === 'secret') {
              secretsSet[f.key] = Boolean(String(raw[f.key] ?? '').length)
              values[f.key] = ''
            } else {
              values[f.key] = raw[f.key] ?? f.default
            }
          }
          return { ok: true, fields, values, secretsSet }
        },
        async write(patch) {
          const clean = {}
          for (const [key, value] of Object.entries(patch ?? {})) {
            // 空字符串 = 「不修改」哨兵，避免把已存的密钥抹掉
            if (value === '' || value === undefined || value === null) continue
            clean[key] = value
          }
          if (Object.keys(clean).length === 0) return { ok: true, changed: 0 }
          await configEditor.edit(entry, (current) => ({ ...(current ?? {}), ...clean }))
          return { ok: true, changed: Object.keys(clean).length }
        },
      }
      logger.info('配置读写接口已就绪（设置页可编辑本插件配置）')
    },
    logger,
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        try {
          if (!configApi) {
            res.statusCode = 503
            res.end(JSON.stringify({ ok: false, error: '配置服务尚未就绪，请稍后重试' }))
            return
          }
          if (req.method === 'GET') {
            res.end(JSON.stringify(await configApi.read()))
            return
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            res.end(JSON.stringify(await configApi.write(body?.patch ?? body)))
            return
          }
          res.statusCode = 405
          res.setHeader('allow', 'GET, POST')
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        } catch (error) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        }
      },
    }),
  )

  // 客户端回传探针：浏览器侧的脚本是否执行、slot 是否注册成功，宿主这侧看不到，
  // 只能让脚本自己打点回来（用 1x1 图片式 GET，避免 CORS/预检）。
  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: BEACON_ROUTE,
      handler: async (req, res) => {
        try {
          const u = new URL(req.url ?? '/', 'http://x')
          diag.beacons.push({
            at: new Date().toISOString(),
            stage: u.searchParams.get('stage') ?? '',
            detail: u.searchParams.get('detail') ?? '',
          })
          if (diag.beacons.length > 50) diag.beacons.shift()
        } catch {
          /* 打点失败不影响任何功能 */
        }
        res.setHeader('content-type', 'text/plain')
        res.setHeader('cache-control', 'no-store')
        res.end('ok')
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: DIAG_ROUTE,
      handler: async (_req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ ok: true, ...diag }, null, 2))
      },
    }),
  )

  // 自托管客户端 bundle（第三方 profile 插件不能依赖 client-modules 解析）
  let bundleBytes = null
  try {
    bundleBytes = readFileSync(new URL('./client.js', import.meta.url))
  } catch {
    logger.warn('未找到 lib/client.js，Web 面板不可用（其余功能不受影响）')
  }
  if (!bundleBytes) return

  const rev = createHash('sha256').update(bundleBytes).digest('hex').slice(0, 12)
  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: CLIENT_ROUTE,
      handler: async (_req, res) => {
        diag.clientServed += 1
        res.setHeader('content-type', 'text/javascript; charset=utf-8')
        res.setHeader('cache-control', 'no-cache')
        res.end(bundleBytes)
      },
    }),
  )

  // 客户端半**不再**用 tapIndex 注入 boot graph —— 那会被宿主后续的权威 graph
  // 覆盖删除（ClientEntries.sync 里 wanted.has(id) 不成立就 loader.remove）。
  // 官方机制：package.json 声明 dsh.client + exports["./client"]，dsh-client-modules
  // 的宿主半会扫描 Loader 条目自动组装条目并服务在 /plugins/??<pkg>/client.js&rev=..
  // 若这里再注入一条同 id 的，parseBootManifest 会抛 duplicate graph entry，
  // 导致**整个客户端模块系统**启动失败。
}

/**
 * 把客户端 bundle 以 `<script type="module">` 注入 index.html。
 *
 * 为什么不用 `__DSH_BOOT__` graph 行（很多第三方插件抄的写法）：
 *   在 DSH 0.2.0-rc.1 上 `@deepseek-ai/dsh-client-modules` 的 `parseBootManifest`
 *   要求 `window.__DSH_BOOT__` 是**对象** `{rev, entries, batches}`，且每个 entry
 *   必须归属某个 initial-load batch；而 graph 行是按 **classic script** 加载并必须
 *   自行调用 `window.__ModuleLoader__.load({id, factory})`。以数组格式写入的
 *   graph 行在本版本是 **no-op**（`if (!Array.isArray(graph)) return html`），
 *   带顶层 `export` 的 ESM 作为 classic script 更是语法错误。
 *   ⇒ 用最直接的 module script 注入，版本无关且不会污染 boot manifest。
 */
export function injectBootEntry(html, { id, url, rev }) {
  const marker = 'globalThis["__DSH_BOOT__"] = '
  const start = html.indexOf(marker)
  if (start < 0) return html
  const jsonStart = start + marker.length
  const end = html.indexOf('</script>', jsonStart)
  if (end < 0) return html

  let graph
  try {
    graph = JSON.parse(html.slice(jsonStart, end))
  } catch {
    return html
  }
  if (typeof graph !== 'object' || graph === null) return html
  if (!Array.isArray(graph.entries) || !Array.isArray(graph.batches)) return html
  if (graph.entries.some((e) => e?.id === id)) return html // 幂等

  // entry 与 batch 必须成对加：parseBootManifest 对「不属于任何 batch 的 entry」直接抛
  // `belongs to no initial-load batch`；batch.url 必须唯一，用自身 url 即可（loader 只抓一次）。
  graph.entries.push({ id, url, rev, inject: [], external: [] })
  graph.batches.push({ phase: 'application', url, rev, entries: [id] })

  // 与 dsh-host-webserver 的 renderRow('global') 保持一致：把 < 转义成 \u003c
  const next = JSON.stringify(graph).replaceAll('<', '\\u003c')
  return html.slice(0, jsonStart) + next + html.slice(end)
}


/** 组装 Web 面板快照。所有平台字段都可能缺失，必须容错。 */
export async function buildPanelState({ store, resolveAdapter, deps, config }) {
  const { adapter, connection, connKey } = await resolveAdapter({})
  const [summary, challenges, leaderboard, submissions, work, theory] = await Promise.all([
    adapter.eventSummary().catch(() => ({})),
    adapter.challenges().catch(() => []),
    adapter
      .leaderboard('user', { size: 20 })
      .then((b) => b.rows)
      .catch(() => []),
    store.recentSubmissions(20).catch(() => []),
    store.listChallengeWork(connKey).catch(() => []),
    adapter.theoryTests().catch(() => []),
  ])

  const rank = await adapter.myRank().catch(() => null)
  const workByChallenge = new Map(work.map((w) => [String(w.challengeId), w]))
  const attemptCounts = new Map()
  for (const s of submissions) {
    const key = String(s.challengeId)
    attemptCounts.set(key, (attemptCounts.get(key) ?? 0) + 1)
  }

  // 环境型题目才有 TTL：work 记录里存了 releaseTime（ctf_start_env 写入）。
  // 平台实测环境时长是 30 分钟（env_start_min 模型默认 60，但线上配置不同），
  // 所以一律以 releaseTime 现算剩余，不写死时长。
  const nowMs = Date.now()
  const envRemainingOf = (w) => {
    if (!w || w.envStarted !== true || w.envReleased === true) return null
    const rel = w.releaseTime ? Date.parse(String(w.releaseTime).replace(' ', 'T')) : NaN
    if (!Number.isFinite(rel)) return null
    return Math.max(0, Math.round((rel - nowMs) / 1000))
  }

  const rows = challenges.map((c) => {
    const w = workByChallenge.get(String(c.id))
    const remaining = envRemainingOf(w)
    return {
      id: c.id,
      name: c.name,
      category: c.category || '未分类',
      score: c.score ?? 0,
      solved: Boolean(c.solved),
      status: c.solved ? 'solved' : w?.status === 'working' ? 'working' : 'pending',
      owner: w?.owner ?? null,
      submitAttempts: attemptCounts.get(String(c.id)) ?? 0,
      // 题型（1 环境型 / 2 外链型 / 3 附件型）：只有详情接口有，由 ctf_challenge 回写 work
      taskType: w?.taskType ?? null,
      envRemainingSeconds: remaining,
      envExpired: remaining === 0,
    }
  })

  // 环境占用：只统计我们自己通过 ctf_start_env 起的环境（用户手动在平台上起的不计入）
  const envHeld = rows.filter((r) => r.envRemainingSeconds !== null && r.envRemainingSeconds > 0).length
  const observedLimit = work.find((w) => Number.isFinite(Number(w?.envLimitObserved)))?.envLimitObserved
  const envLimit = Number.isFinite(Number(config?.envLimit)) && Number(config.envLimit) > 0
    ? Number(config.envLimit)
    : Number.isFinite(Number(observedLimit)) ? Number(observedLimit) : 2

  const solved = rows.filter((r) => r.solved).length
  const working = rows.filter((r) => r.status === 'working').length

  const nameById = new Map(challenges.map((c) => [String(c.id), c.name]))
  return {
    ok: true,
    configured: true,
    env: { limit: envLimit, held: envHeld, free: Math.max(0, envLimit - envHeld) },
    connection: {
      key: connKey,
      platform: connection.platform,
      baseUrl: connection.baseUrl,
      eventId: connection.eventId,
      label: connection.label ?? '',
    },
    event: {
      name: summary?.name ?? '',
      remainingSeconds: summary?.remainingSeconds ?? 0,
      user: summary?.user ?? null,
      punish: Boolean(summary?.punish),
      startTime: summary?.startTime ?? '',
      endTime: summary?.endTime ?? '',
    },
    stats: {
      total: rows.length,
      solved,
      working,
      pending: rows.length - solved - working,
      totalScore: rows.filter((r) => r.solved).reduce((sum, r) => sum + (r.score || 0), 0),
    },
    rank: rank ? { rank: rank.rank, total: rank.total, self: rank.self } : null,
    leaderboard,
    challenges: rows,
    submissions: submissions
      .slice()
      .reverse()
      .map((s) => ({
        at: s.at,
        challengeId: s.challengeId,
        challengeName: nameById.get(String(s.challengeId)) ?? `#${s.challengeId}`,
        status: s.status,
        flag: maskFlag(s.flag),
      })),
    theory: theory.map((t) => ({
      id: t.id,
      name: t.name,
      count: t.count,
      // ⚠️ 状态必须带 statusLabel：交卷后 is_begin 会变回 false，
      // 只看 isBegin 会显示成「未开始」（真实 session 踩过）。
      isBegin: t.isBegin,
      isParse: t.isParse === true,
      parseCount: Number(t.parseCount ?? 0),
      status: t.status ?? null,
      statusLabel: t.statusLabel ?? null,
      remainingSeconds: t.timeSeconds,
    })),
    updatedAt: new Date().toISOString(),
  }
}

/** flag 在面板上脱敏显示。 */
export function maskFlag(flag) {
  const text = String(flag ?? '')
  if (!text) return ''
  if (text.length <= 8) return `${text.slice(0, 2)}${'*'.repeat(Math.max(0, text.length - 2))}`
  return `${text.slice(0, 6)}${'*'.repeat(Math.min(8, text.length - 8))}${text.slice(-2)}`
}

// ────────────────────────────────────────────── 顶部「CTF」视图：团队数据

/** 平台题目 id 多为数字：能转数字就转，保证 ui 侧 `challenges[].id` 直接可比。 */
export function toChallengeId(value) {
  if (value == null) return null
  const text = String(value).trim()
  if (!text) return null
  return /^\d+$/.test(text) ? Number(text) : text
}

/** 任意时间表示 → 毫秒时间戳（认不出来返回 null，绝不抛）。 */
export function toEpochMs(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/** 任务板/名单读取失败时也要能渲染空态：形状与成功响应保持一致。 */
function emptyTeamPayload(generatedAt, error) {
  return {
    ok: false,
    generatedAt,
    error,
    connection: { key: null, label: '' },
    members: [],
    tasks: [],
    messages: [],
    counts: { members: 0, running: 0, inactive: 0, tasksDone: 0, tasksInProgress: 0, tasksPending: 0, tasksTotal: 0 },
  }
}

/**
 * 组装 `GET /lingxu-ctf/team` 的响应（顶部「CTF」视图数据源）。
 *
 * 数据来源：
 * - `teams.listMembers(caller)` / `teams.listTasks(caller)`（`ctx.agentTeams`，caller 来自
 *   `orchestrator.getCaller()` —— HTTP 路由没有 `exec.agent`，只能用会话内捕获的 Lead 身份）；
 * - `store.listChallengeWork()` 里的 `teammate` / `taskId` / `subject` 映射（谁在做哪道题）；
 * - `store.listTeamMessages(connKey)`（协同消息）。
 *
 * 契约：**任何失败都返回 `ok:false` + `error`（HTTP 仍 200）**，不抛异常给路由层。
 * 时间戳：DSH 任务对象没有 `createdAt/updatedAt`，由编排层写进 work 记录，缺失时填 `null`。
 *
 * @param {{
 *   store?: object,
 *   teams?: object,
 *   caller?: unknown,
 *   resolveAdapter?: (args: object) => Promise<object>,
 *   now?: () => number,
 *   messagesLimit?: number,
 * }} deps
 */
export async function buildTeamState({
  store,
  teams,
  caller,
  resolveAdapter,
  now = () => Date.now(),
  messagesLimit = TEAM_MESSAGES_DEFAULT_LIMIT,
} = {}) {
  let generatedAt
  try {
    generatedAt = new Date(now()).toISOString()
  } catch {
    generatedAt = new Date().toISOString()
  }

  if (typeof teams?.listMembers !== 'function' || typeof teams?.listTasks !== 'function') {
    return emptyTeamPayload(
      generatedAt,
      'Agent Teams 不可用：ctx.agentTeams 未挂载或接口不完整（缺少 listMembers / listTasks）。' +
        '请确认 desktop profile 已启用 @deepseek-ai/dsh-experimental-agent-team 后重启 DSH。',
    )
  }
  if (!caller) {
    return emptyTeamPayload(
      generatedAt,
      '尚未获取会话语境：本会话还没有调用过任何 ctf_* 工具（这些工具会把 exec.agent 记下来供本路由读取）。' +
        '先在会话里跑一次 ctf_status 或 ctf_solve_start，团队数据即可用。',
    )
  }

  let memberRows
  let taskRows
  try {
    memberRows = await teams.listMembers(caller)
    taskRows = await teams.listTasks(caller)
  } catch (error) {
    return emptyTeamPayload(generatedAt, `读取 Agent Teams 数据失败：${error?.message ?? error}`)
  }

  // 连接信息（没有配置平台也要能看团队，所以失败只是降级为 null）
  let connKey = null
  let connLabel = ''
  if (typeof resolveAdapter === 'function') {
    try {
      const platform = await resolveAdapter({})
      connKey = platform?.connKey ?? connectionKey(platform?.connection ?? {})
      connLabel = String(platform?.connection?.label ?? '')
    } catch {
      /* 未配置连接：团队成员/任务板仍应可见 */
    }
  }

  // work 记录：把 teammate / taskId 映射到题目（taskId 在同一团队内唯一，跨连接取也无歧义）
  let work = []
  try {
    if (typeof store?.listChallengeWork === 'function') {
      const rows = await store.listChallengeWork()
      work = Array.isArray(rows) ? rows : []
    }
  } catch {
    work = []
  }
  const pickLatest = (map, key, record) => {
    if (!key) return
    const previous = map.get(key)
    if (!previous || String(record?.updatedAt ?? '') >= String(previous.updatedAt ?? '')) map.set(key, record)
  }
  const workByTaskId = new Map()
  const workByTeammate = new Map()
  for (const record of work) {
    if (record?.taskId != null) pickLatest(workByTaskId, String(record.taskId), record)
    if (record?.teammate) pickLatest(workByTeammate, String(record.teammate), record)
  }

  const members = (Array.isArray(memberRows) ? memberRows : []).map((member) => {
    const name = String(member?.name ?? '')
    const record = workByTeammate.get(name)
    const fromDescription = parseMemberDescription(member?.description)
    const fromSubject = parseTaskSubject(record?.subject)
    const rawId = record?.challengeId ?? fromDescription.challengeId ?? null
    return {
      name,
      role: String(member?.role ?? 'teammate'),
      status: String(member?.status ?? 'unknown'),
      description: typeof member?.description === 'string' ? member.description : '',
      challengeId: toChallengeId(rawId),
      challengeName: fromSubject.name ?? fromDescription.challengeName ?? null,
      category: fromSubject.category ?? fromDescription.category ?? null,
    }
  })

  const tasks = (Array.isArray(taskRows) ? taskRows : []).map((task) => {
    const record = workByTaskId.get(String(task?.id ?? ''))
    const rawId = parseChallengeId(task?.description) ?? challengeIdFromScope(task?.writeScopes) ?? record?.challengeId ?? null
    const fromSubject = parseTaskSubject(task?.subject ?? record?.subject)
    const revision = Number(task?.revision)
    return {
      id: String(task?.id ?? ''),
      revision: Number.isFinite(revision) ? revision : null,
      subject: String(task?.subject ?? record?.subject ?? ''),
      status: String(task?.status ?? 'unknown'),
      owner: task?.ownerName ?? task?.owner ?? null,
      challengeId: toChallengeId(rawId),
      challengeName: fromSubject.name ?? null,
      category: fromSubject.category ?? null,
      writeScopes: (Array.isArray(task?.writeScopes) ? task.writeScopes : []).map((scope) => String(scope)),
      createdAt: toEpochMs(record?.taskCreatedAt ?? record?.createdAt ?? null),
      updatedAt: toEpochMs(record?.updatedAt ?? null),
    }
  })

  // 消息：store 按时间升序存放，这里翻成**最新在前**（与 /lingxu-ctf/state 的 submissions 一致）
  let messages = []
  try {
    if (typeof store?.listTeamMessages === 'function') {
      const size = Number(messagesLimit)
      const limit = Number.isFinite(size) && size > 0 ? Math.floor(size) : TEAM_MESSAGES_DEFAULT_LIMIT
      const rows = await store.listTeamMessages(connKey ?? undefined, limit)
      messages = (Array.isArray(rows) ? rows : [])
        .slice()
        .reverse()
        .map((message) => ({
          at: String(message?.at ?? ''),
          from: String(message?.from ?? ''),
          to: String(message?.to ?? ''),
          kind: String(message?.kind ?? ''),
          text: String(message?.text ?? ''),
        }))
    }
  } catch {
    messages = []
  }

  return {
    ok: true,
    generatedAt,
    connection: { key: connKey, label: connLabel },
    members,
    tasks,
    messages,
    counts: {
      members: members.length,
      running: members.filter((member) => member.status === 'running').length,
      inactive: members.filter((member) => member.status === 'inactive').length,
      tasksTotal: tasks.length,
      tasksDone: tasks.filter((task) => task.status === 'completed').length,
      tasksInProgress: tasks.filter((task) => task.status === 'in_progress').length,
      tasksPending: tasks.filter((task) => task.status === 'pending').length,
    },
  }
}

/** WP 落盘绝对路径：优先 work 记录里的 writeupPath，否则按目录约定拼。 */
function resolveWriteupPath(record, workDir) {
  const explicit = record?.writeupPath ? String(record.writeupPath) : ''
  if (explicit) return explicit
  if (record?.challengeId == null) return ''
  const slug = String(record?.writeupSlug ?? '').trim() || slugify(parseTaskSubject(record?.subject).name || '')
  if (!slug) return ''
  return path.join(workDir, 'writeups', `${slug}-${record.challengeId}.md`)
}

/** 绝对路径 → 工作区相对路径（前端展示用）；落在工作区外时原样返回绝对路径。 */
function toWorkspacePath(absPath, workDir) {
  const bases = [process.cwd(), path.dirname(workDir), workDir].filter(
    (base) => typeof base === 'string' && base && base !== '/' && base !== path.sep,
  )
  for (const base of bases) {
    const rel = path.relative(base, absPath)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
  }
  return String(absPath)
}

/**
 * 组装 `GET /lingxu-ctf/reports` 的响应（顶部「CTF」视图的「报告」子视图）。
 *
 * **纯本地**：只读 store 里的 WP 记录 + 文件系统 stat，不请求平台（视图会轮询）。
 * 文件不存在就跳过；任何异常都返回 `ok:false` + `error`（HTTP 仍 200）。
 *
 * @param {{ store?: object, resolveAdapter?: Function, workDir?: string, fs?: object, now?: () => number }} deps
 */
export async function buildReportsState({ store, resolveAdapter, workDir, fs = fsp, now = () => Date.now() } = {}) {
  let generatedAt
  try {
    generatedAt = new Date(now()).toISOString()
  } catch {
    generatedAt = new Date().toISOString()
  }
  try {
    const dir = workDir || defaultWorkDir()
    let connKey = null
    if (typeof resolveAdapter === 'function') {
      try {
        const platform = await resolveAdapter({})
        connKey = platform?.connKey ?? null
      } catch {
        /* 未配置连接：本地已生成的 WP 仍然要能看到 */
      }
    }
    const records = typeof store?.listChallengeWork === 'function' ? await store.listChallengeWork(connKey ?? undefined) : []
    const writeups = []
    for (const record of Array.isArray(records) ? records : []) {
      const absPath = resolveWriteupPath(record, dir)
      if (!absPath) continue
      let stat
      try {
        stat = await fs.stat(absPath)
      } catch {
        continue // 记录里有、文件没了：跳过，不报错
      }
      if (!stat?.isFile?.()) continue
      const subject = parseTaskSubject(record?.subject)
      writeups.push({
        challengeId: toChallengeId(record?.challengeId),
        challengeName: subject.name ?? null,
        category: subject.category ?? null,
        path: toWorkspacePath(absPath, dir),
        absPath: String(absPath),
        bytes: Number(stat.size ?? 0),
        modifiedAt: new Date(stat.mtimeMs ?? stat.mtime ?? 0).toISOString(),
        // ⚠️ writeup.js 的 submit 目前不落盘标记；此处透传记录里的字段，缺省 false
        submitted: Boolean(record?.writeupSubmittedAt ?? record?.submitted ?? false),
      })
    }
    writeups.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
    return { ok: true, generatedAt, writeups }
  } catch (error) {
    return { ok: false, generatedAt, error: error instanceof Error ? error.message : String(error), writeups: [] }
  }
}

/**
 * ⚠️ Cordis Loader 用 `exports = exports.default ?? exports` 归一化模块形状
 * （见 cordis-plugin-loader 的 normalizeExports）：**只要存在 default 导出，Loader 就只认它**，
 * 再从它身上读 `plugin.Config` / `plugin.inject` / `plugin.apply`。
 * 所以 default 导出必须携带 `Config`，否则设置页拿不到 schema、渲染不出配置表单
 * （inspect 会报 `status: "absent"`，实测踩过）。命名导出同时保留，便于单测直接 import。
 */
export default {
  name,
  inject,
  Config,
  apply,
  normalizeConfig,
  configHasCredentials,
  slugify,
  buildPanelState,
  buildTeamState,
  buildReportsState,
  readLimitParam,
  withSessionCapture,
  injectBootEntry,
  maskFlag,
}
