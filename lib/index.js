/**
 * dsh-lingxu-ctf — 宿主插件入口。
 *
 * 职责：装配。业务逻辑分散在：
 *   lib/lingxu.js      平台客户端
 *   lib/platforms.js   平台适配器（lingxu / ctfd）
 *   lib/store.js       持久化与审计
 *   lib/tools.js       13 个模型可见工具
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
import { createOrchestrator } from './orchestrate.js'
import { createWriteup } from './writeup.js'

export const name = 'dsh-lingxu-ctf'

/** `tools` 是硬依赖；其余服务按可用性降级使用。 */
export const inject = ['tools']

const PANEL_ROUTE = '/lingxu-ctf/state'
const CLIENT_ROUTE = '/lingxu-ctf/client.js'

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
export const Config = z.object({
  platform: z
    .union([z.const('lingxu'), z.const('ctfd')])
    .default('lingxu')
    .description('平台类型：lingxu = 凌虚赛事平台；ctfd = 标准 CTFd'),
  baseUrl: z
    .string()
    .default('')
    .description('平台根地址，例如 https://ctf.example.com:8000（凌虚不要带前端 # 路由）'),
  eventId: z.number().default(0).description('赛事 ID：凌虚填 URL 里 /event/<id>/ 的 id；CTFd 留 0'),
  cookie: z
    .string()
    .role('secret')
    .default('')
    .description('浏览器复制的完整 Cookie（凌虚必须含 sessionid=...）。只存在本机，不会外发'),
  token: z
    .string()
    .role('secret')
    .default('')
    .description('CTFd API Token（与 Cookie 二选一）'),
  label: z.string().default('').description('连接备注名，便于多赛事识别'),
  concurrency: z
    .number()
    .default(4)
    .description('并发解题 agent 数（1–8，默认 4）。每题一个 agent，共享任务板互相通信'),
  maxWrongAttempts: z
    .number()
    .default(0)
    .description('单题 flag 最大错误提交次数；0 = 不限制（错误提交可能扣分，见赛事 punish 提示）'),
  dedupeFlags: z.boolean().default(true).description('同一题重复提交相同 flag 时本地去重，不再请求平台'),
  workDir: z.string().default('').description('附件与 WP 落盘目录；留空 = 工作区下的 lingxu-ctf-work/'),
  timeoutMs: z.number().default(30000).description('平台请求超时（毫秒）'),
  enableWebPanel: z.boolean().default(true).description('在 Web 界面右下角显示 CTF 控制面板'),
})

/** 归一化插件配置（纯函数，便于单测；不依赖 schemastery）。 */
export function normalizeConfig(raw = {}) {
  const concurrency = Number(raw.concurrency ?? 4)
  const platform = String(raw.platform ?? 'lingxu').toLowerCase()
  return {
    platform: platform === 'ctfd' ? 'ctfd' : 'lingxu',
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : '',
    eventId: Number.isFinite(Number(raw.eventId)) ? Math.max(0, Math.trunc(Number(raw.eventId))) : 0,
    cookie: typeof raw.cookie === 'string' ? raw.cookie.trim() : '',
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    label: typeof raw.label === 'string' ? raw.label.trim() : '',
    concurrency: Number.isFinite(concurrency) ? Math.min(Math.max(Math.trunc(concurrency), 1), 8) : 4,
    maxWrongAttempts: Number.isFinite(Number(raw.maxWrongAttempts)) ? Math.max(0, Math.trunc(Number(raw.maxWrongAttempts))) : 0,
    dedupeFlags: raw.dedupeFlags !== false,
    workDir: typeof raw.workDir === 'string' ? raw.workDir.trim() : '',
    timeoutMs: Number.isFinite(Number(raw.timeoutMs)) ? Math.max(1000, Math.trunc(Number(raw.timeoutMs))) : 30000,
    enableWebPanel: raw.enableWebPanel !== false,
  }
}

/** 配置里是否填了足够的凭据可以直接连平台。 */
export function configHasCredentials(config) {
  if (!config?.baseUrl) return false
  if (config.platform === 'ctfd') return Boolean(config.token || config.cookie)
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
        platform: config.platform,
        baseUrl: config.baseUrl,
        eventId: config.eventId,
        cookie: config.cookie,
        token: config.token,
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
  }

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
    deps.orchestrator = createOrchestrator({ ...deps, teams })
    logger.info('Agent Teams 已就绪：ctf_solve_start / status / stop 可用')
  }, logger)

  // ── 工具注册 ─────────────────────────────────────────────────────────
  const specs = buildToolSpecs(deps)
  const disposers = []
  for (const spec of specs) {
    disposers.push(ctx.tools.register(defineTool(spec)))
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
function registerWebPanel(ctx, webServer, { deps, store, resolveAdapter, config, workDir, logger }) {
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
          res.end(JSON.stringify(await buildPanelState({ store, resolveAdapter, deps })))
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
        res.setHeader('content-type', 'text/javascript; charset=utf-8')
        res.setHeader('cache-control', 'no-cache')
        res.end(bundleBytes)
      },
    }),
  )

  if (webServer.tapIndex) {
    ctx.effect(() => webServer.tapIndex((html) => injectClientScript(html, `${CLIENT_ROUTE}?rev=${rev}`)))
  }
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
export function injectClientScript(html, url) {
  if (html.includes(url)) return html
  const tag = `<script type="module" src="${url}"></script>`
  if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`)
  return `${html}${tag}`
}


/** 组装 Web 面板快照。所有平台字段都可能缺失，必须容错。 */
export async function buildPanelState({ store, resolveAdapter, deps }) {
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

  const rows = challenges.map((c) => {
    const w = workByChallenge.get(String(c.id))
    return {
      id: c.id,
      name: c.name,
      category: c.category || '未分类',
      score: c.score ?? 0,
      solved: Boolean(c.solved),
      status: c.solved ? 'solved' : w?.status === 'working' ? 'working' : 'pending',
      owner: w?.owner ?? null,
      submitAttempts: attemptCounts.get(String(c.id)) ?? 0,
    }
  })

  const solved = rows.filter((r) => r.solved).length
  const working = rows.filter((r) => r.status === 'working').length

  const nameById = new Map(challenges.map((c) => [String(c.id), c.name]))
  return {
    ok: true,
    configured: true,
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
      isBegin: t.isBegin,
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

export default { name, inject, apply, normalizeConfig, slugify, buildPanelState, injectClientScript, maskFlag }
