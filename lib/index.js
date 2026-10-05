/** 插件入口：归一化配置，装配依赖，注册工具、路由和命令。 */

import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { zstdDecompressSync } from 'node:zlib'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import z from '@deepseek-ai/schemastery'

import { defineTool } from './toolkit.js'
import { getStore, connectionKey } from './store.js'
import { createAdapter, listPlatforms } from './platforms.js'
import { buildToolSpecs } from './tools.js'
import { lingxuRateLimitStats, withRequestPriority } from './lingxu.js'
import { teamDeliveryOf } from './team-events.js'

export { teamDeliveryOf }

// AWD/CFS 是可选赛段模块；加载失败时仍保留基础工具。
let buildAwdToolSpecs = () => []
let buildCfsToolSpecs = () => []
let recommendStageTools = () => null
try {
  const stageTools = await import('./stage-tools.js')
  if (typeof stageTools.buildAwdToolSpecs === 'function') buildAwdToolSpecs = stageTools.buildAwdToolSpecs
  if (typeof stageTools.buildCfsToolSpecs === 'function') buildCfsToolSpecs = stageTools.buildCfsToolSpecs
  if (typeof stageTools.recommendStageTools === 'function') recommendStageTools = stageTools.recommendStageTools
} catch {
  /* 赛段工具模块缺失：基础工具集照常工作 */
}
import {
  createOrchestrator,
  parseChallengeId,
  challengeIdFromScope,
  parseMemberDescription,
  parseTaskSubject,
} from './orchestrate.js'
import { createWriteup } from './writeup.js'
import { createExportBundle } from './export.js'

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
/** 题目详情：点击看板题目后按需读取。 */
const CHALLENGE_ROUTE = '/lingxu-ctf/challenge'
/**
 * 理论题**题目概要**（按需拉取，绝不自动全量）：`?testId=<id>&limit=<n>`。
 * 只回题干摘要 + 题型 + 是否已答，不回选项/正文，避免 100 道题把面板撑爆。
 */
const THEORY_ROUTE = '/lingxu-ctf/theory'
/**
 * token 用量（**按会话**）：`?session=<sessionId>`。
 *
 * 数据源：DSH 的会话日志 `~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`
 * （多帧 zstd + JSONL），按 **DSH 自己的 `tokenUsage` 投影语义**折叠 assistant 事件里的
 * provider 用量。客户端还会同时读会话行的 `projectionValues.tokenUsage`（DSH 统计药丸用的
 * 同一个投影），两边不一致时面板会显式提示，绝不静默展示可疑数字。
 */
const USAGE_ROUTE = '/lingxu-ctf/usage'
/** 会话身份槽的最大保留时间；正常长会话仍可持续，结束/卸载时会主动回收。 */
export const SESSION_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000
/** 单个插件实例最多保留的会话身份，避免宿主反复创建 session 导致无界增长。 */
export const SESSION_CONTEXT_MAX = 128
/** 团队消息默认/最大返回条数（`?limit=` 可覆盖）。 */
export const TEAM_MESSAGES_DEFAULT_LIMIT = 50
export const TEAM_MESSAGES_MAX_LIMIT = 200

/**
 * 面板快照缓存。
 *
 * 前端悬浮面板与顶部视图**各自**每 5 秒轮询一次 `/lingxu-ctf/state`，而每次快照要打
 * **6 次**平台（实测：`/event/{id}/`、`/info/`、`/ctf/`、`/user/rank/`×2、`/test/`）。
 *
 * 实测（真实平台，两个视图各 5s 轮询 60 秒 = 24 次快照请求）：
 * - 无缓存：**144 次平台请求/分钟**（这就是把会话打爆、全队 403 的元凶）
 * - 仅 TTL=4s：72 次/分钟（两个视图错开 2.5s 时刚好共用一次拉取）
 * - TTL=4s + 刷新下限 15s：**24 次/分钟** ✅
 *
 * 为什么要刷新下限：光靠 TTL 挡不住「视图 A 在 t 拉、视图 B 在 t+2.5 命中、t+5 又过期」的节奏，
 * 每个 5s 窗口仍会真打一次平台。下限把「后台刷新」压到每 15 秒最多一次。
 *
 * 为什么不牺牲交互：用户最关心的**写操作**（交 flag / 切连接）走 `instrumentStoreWrites`
 * 的 loud 通道 —— 一变就**立即穿透**缓存（见 handler）。其余只读数据最多陈旧
 * `PANEL_PLATFORM_REFRESH_MS`，payload 带 `stale` / `cachedAt`，前端可如实显示「更新于 N 秒前」。
 */
export const PANEL_CACHE_TTL_MS = 4000

/** 后台平台刷新的最小间隔（毫秒）：把轮询流量压到 ≤30 次平台请求/分钟（实测 24）。 */
export const PANEL_PLATFORM_REFRESH_MS = 20000

/**
 * 「用户可见写操作」（loud：交 flag / 切连接）的强制刷新冷却（毫秒）。
 *
 * 为什么要冷却：每次强制刷新都是 **6 次平台请求**。8 个 agent 连续交 flag 时，
 * 若每次都强制刷新，面板反而会把平台打回去（6×N 次/分钟）。
 * 5 秒冷却 = 单次用户操作最多等 5 秒就能在面板看到（通常下一次轮询就到），
 * 同时把 loud 放大上限压在 12 次/分钟。
 */
export const PANEL_LOUD_COOLDOWN_MS = 5000

/**
 * 平台刷新的**硬上限**：滚动 60 秒内最多 4 次（4 × 6 = **24 次平台请求/分钟**）。
 *
 * 为什么还要硬上限：刷新是**事件驱动**的（轮询 + 交 flag + 切连接），
 * 光靠「最小间隔 + 冷却」在极端情况下（8 个 agent 连续交 flag）仍可能叠加放大。
 * 有了这个闸门，面板对平台的流量**数学上不会超过 24 次/分钟**（验收要求 ≤30，留边界余量），
 * 无论上层多活跃。超额时返回旧数据（`stale: true`），前端可如实显示「更新于 N 秒前」。
 */
export const PANEL_MAX_REFRESHES_PER_MINUTE = 4

/**
 * store 写操作探针：把 `store.save()` 包一层自增计数器，并给「用户可见的写操作」再加一路计数。
 *
 * 为什么需要它：面板缓存必须**立刻**反映用户的写操作（交 flag / 起环境 / 释放环境），
 * 否则用户会觉得「操作了没反应」。而工具层（`lib/tools.js`）不是本任务写入范围，
 * 所以这里**原地包装** store 的方法：
 * - `save()` → `revision`（任何写入都变，用来判断缓存是否过期）
 * - `loudMethods` → `loudRevision`（**用户可见**的写操作，用来强制穿透刷新下限）
 *
 * 为什么不把所有写入都当 loud：8 个 agent 的 work 记录更新很频繁，
 * 全当 loud 会让平台流量重新回到每分钟上百次（缓存等于白加）。
 *
 * - 原地包装：不改变 `store` 对象身份、不改变任何方法签名
 * - 幂等：重复 `apply()` 只包一次（用 `__lingxuWriteProbe` 标记）
 */
export function instrumentStoreWrites(store, { loudMethods = ['recordSubmission', 'upsertConnection'] } = {}) {
  if (!store || typeof store !== 'object') return { revision: 0, loudRevision: 0, instrumented: false }
  if (store.__lingxuWriteProbe) return store.__lingxuWriteProbe
  const probe = { revision: 0, loudRevision: 0, instrumented: false }
  try {
    const originalSave = store.save
    if (typeof originalSave === 'function') {
      store.save = async function lingxuCachedSave(...args) {
        const result = await originalSave.apply(this, args)
        probe.revision += 1
        return result
      }
      probe.instrumented = true
    }
    for (const method of loudMethods) {
      const original = store[method]
      if (typeof original !== 'function') continue
      store[method] = async function lingxuLoudWrite(...args) {
        const result = await original.apply(this, args)
        probe.loudRevision += 1
        return result
      }
    }
    // 有些 store 实现/测试替身没有 save()，此时退回 updatedAt 指纹（见 panelRevisionOf）
    store.__lingxuWriteProbe = probe
  } catch {
    /* 冻结对象等极端情况：不装探针，缓存退化为纯 TTL */
  }
  return probe
}

/** 当前 store 的写入版本：优先用探针计数，其次退回 `state.updatedAt` 指纹。 */
export function panelRevisionOf(store, probe) {
  if (probe && probe.instrumented) return `w${probe.revision}`
  try {
    return `t${store?.state?.updatedAt ?? ''}`
  } catch {
    return 'static'
  }
}

/**
 * 面板快照缓存：**TTL + 单飞（single-flight）+ 刷新下限**。
 *
 * - TTL 内且 store 无写入 → 直接返回缓存（`fromCache: true` / `cachedAt`）
 * - 并发请求共享同一次平台拉取（后来者 `shared: true`，不会各拉各的）
 * - 超过 TTL 但**未到刷新下限** → 返回旧数据并标 `fromCache: true, stale: true`（不打平台）
 * - **loud 写操作**（交 flag / 切连接）→ 忽略刷新下限，立即重新拉取
 * - 任何 store 写入都会让缓存「脏」，最迟在刷新下限到点后重新拉取
 *
 * @param {{ ttlMs?: number, minRefreshMs?: number, now?: () => number }} [options]
 */
export function createPanelSnapshotCache({
  ttlMs = PANEL_CACHE_TTL_MS,
  minRefreshMs = PANEL_PLATFORM_REFRESH_MS,
  loudCooldownMs = PANEL_LOUD_COOLDOWN_MS,
  maxRefreshesPerMinute = PANEL_MAX_REFRESHES_PER_MINUTE,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, { at: number, revision: string, loudRevision: number, value: any }>} */
  const entries = new Map()
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map()
  let lastLoudRefreshAt = -Infinity
  /** 滚动 60 秒内的刷新时间戳（硬上限用）。 */
  let refreshTimes = []
  const stats = { hits: 0, staleHits: 0, misses: 0, shared: 0, invalidations: 0, errors: 0, loudRefreshes: 0, budgetBlocked: 0 }

  /** 滚动窗口内是否还有刷新额度。 */
  function hasBudget(nowMs) {
    refreshTimes = refreshTimes.filter((t) => nowMs - t < 60_000)
    return refreshTimes.length < maxRefreshesPerMinute
  }

  /** 打补丁式地给 payload 附加缓存元信息（不改原有字段）。 */
  function withMeta(value, { fromCache, cachedAt, shared, stale }) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return {
      ...value,
      cachedAt: new Date(cachedAt).toISOString(),
      fromCache,
      shared: Boolean(shared),
      stale: Boolean(stale),
    }
  }

  /**
   * @param {string} key
   * @param {() => Promise<any>} loader
   * @param {string} revision store 写入版本（`panelRevisionOf`）
   * @param {{ loudRevision?: number }} [options] 用户可见写操作的版本（变了就立即刷新）
   */
  async function load(key, loader, revision = '', { loudRevision = null } = {}) {
    const nowMs = now()
    const entry = entries.get(key)
    const age = entry ? nowMs - entry.at : Infinity
    const sameRevision = entry ? entry.revision === revision : false
    const loudChanged = entry && loudRevision != null ? entry.loudRevision !== loudRevision : false
    // loud 写操作可以穿透刷新下限，但要受冷却约束（否则 8 个 agent 交 flag 会把面板流量放大 6 倍）
    const loudForced = loudChanged && nowMs - lastLoudRefreshAt >= loudCooldownMs

    if (entry && age < ttlMs && sameRevision && !loudChanged) {
      stats.hits += 1
      return withMeta(entry.value, { fromCache: true, cachedAt: entry.at, shared: false, stale: false })
    }

    const pending = inFlight.get(key)
    if (pending) {
      stats.shared += 1
      const value = await pending
      return withMeta(value, { fromCache: false, cachedAt: entries.get(key)?.at ?? now(), shared: true, stale: false })
    }

    // 到刷新下限之前不打平台：把旧数据标 stale 直接返回（loud 写操作在冷却之外例外）
    const budgetLeft = hasBudget(nowMs)
    if (entry && !(loudForced && budgetLeft) && age < minRefreshMs) {
      stats.staleHits += 1
      return withMeta(entry.value, { fromCache: true, cachedAt: entry.at, shared: false, stale: true })
    }
    // 硬上限：滚动 60s 内刷新次数用完 → 只能给旧数据（数学上保证 ≤30 次平台请求/分钟）
    if (entry && !budgetLeft) {
      stats.budgetBlocked += 1
      stats.staleHits += 1
      return withMeta(entry.value, { fromCache: true, cachedAt: entry.at, shared: false, stale: true })
    }

    stats.misses += 1
    refreshTimes.push(nowMs)
    if (loudForced) {
      stats.loudRefreshes += 1
      lastLoudRefreshAt = nowMs
    }
    const startedAt = nowMs
    const task = (async () => {
      const value = await loader()
      // 条目时间戳用「加载完成时刻」：硬上限/下限都按它算，避免长请求把窗口算歪
      entries.set(key, { at: now(), revision, loudRevision: loudRevision ?? entry?.loudRevision ?? 0, value })
      return value
    })()
    inFlight.set(key, task)
    try {
      const value = await task
      return withMeta(value, { fromCache: false, cachedAt: startedAt, shared: false, stale: false })
    } catch (error) {
      stats.errors += 1
      throw error
    } finally {
      inFlight.delete(key)
    }
  }

  function invalidate(key) {
    stats.invalidations += 1
    if (key == null) entries.clear()
    else entries.delete(key)
  }

  return {
    load,
    invalidate,
    stats,
    ttlMs,
    minRefreshMs,
    loudCooldownMs,
    maxRefreshesPerMinute,
    refreshesInWindow: (nowMs = now()) => refreshTimes.filter((t) => nowMs - t < 60_000).length,
    size: () => entries.size,
  }
}

/**
 * 插件配置 schema —— **这就是设置页里那份表单**。
 *
 * 导出 `Config` 后，DSH 的设置页（设置 → 插件 → 插件配置）会自动按 schema 渲染控件，
 * 用户填一次平台地址 / 赛事 ID / Cookie，之后选「CTF 解题模式」说「开始」就能跑，
 * 不必在对话里传凭据。
 *
 * 注意：
 * - 每个字段都必须有 `.default()`：缺默认值的字段会被 Loader 判为「missing required value」
 *  而让整行加载失败（本仓库就踩过 `dsh-tool-fs-search` 那个坑）。
 * - `cookie` 用 `role('secret')`：DSH 会在跨线（发给浏览器）前结构化脱敏，
 *  设置页渲染成**只写输入框**，密钥本身不会被前端读到。
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
      .description('同时保持多少个解题 agent 在跑（1–8，默认 4）。它们是可复用的执行槽，共享任务板互相通信')
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
    reuseAgents: z
      .boolean()
      .default(true)
      .description(
        '复用闲置 agent 去做新题，而不是每题都新建。DSH 的 teammate 名额是累计且不可回收的，' +
          '关掉后会很快耗尽名额（78 道题的比赛约需 78 个），一般不要关',
      )
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
    reuseAgents: source.reuseAgents !== false,
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

/**
 * 设置页是否声明了「平台 + 赛事」（**Cookie 可以缺**）。
 *
 * 与 `configHasCredentials` 的区别：那个要求三件套齐全，用于「凭据是否完整」的判断；
 * 而解析连接时**不能**因为 Cookie 为空就无视设置页 —— 用户就是靠这里指定赛事的，
 * Cookie 是**平台级**凭据，可以从同平台的其它连接补（见 `pickConnection` 的 withCookie ③）。
 * 旧行为（要求 cookie）正是「切到 event 7 后仍显示 event 4」的直接原因。
 */
export function settingsHasPlatform(config) {
  return Boolean(config?.baseUrl && config?.eventId)
}

/** 连接来源的展示文案（让用户一眼看懂「为什么用的是这个赛事」）。 */
export const CONNECTION_ORIGIN_TEXT = {
  args: '显式参数',
  settings: '设置页配置',
  store: '本地已存连接（ctf_connect）',
}

/**
 * 设置页里的 Cookie 是否**可用**。
 *
 * ⚠️ `dsh-settings` 给远程调用者返回的是**脱敏值**（`***`），配置卡片上显示的就是脱敏串；
 * 万一有代码把脱敏串写回配置，我们不能拿它当 Cookie 用（会一直 403）。
 */
export function cookieLooksUsable(cookie) {
  const text = String(cookie ?? '').trim()
  if (!text) return false
  if (text.includes('***')) return false
  if (/^\*+$/.test(text)) return false
  return true
}

/**
 * 把设置页里的 Cookie 值归一化成可发送的 Cookie 串。
 *
 * 某些 profile 里 `cookie:` 存的是**裸 sessionid 值**
 * （32 字符，没有 `sessionid=` 前缀）：
 * - 直接当 Cookie 发 → `403 未登录`；
 * - 补上 `sessionid=` 前缀 → `✅ 数信杯 Agent 测试赛 / 78 题`。
 * 所以这里统一补前缀；已经是完整 Cookie 串（含 `=`）的原样返回。
 */
export function normalizeCookie(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text.includes('=')) return text // 完整 Cookie 串（sessionid=...; csrftoken=...）
  return `sessionid=${text}` // 裸 token：设置页只存了 sessionid 的值
}

/**
 * 选出这次使用的连接。函数保持纯净，便于单独验证。
 *
 * 优先级（用户直觉：设置页 =「我配置的平台」，ctf_connect =「连接/切换」）：
 *  ① 显式参数（`connection` / `platform` / `eventId` / `baseUrl`）—— 最高优先，找不到就报错（绝不静默换平台）
 *  ② 设置页配置（有凭据时）—— 用户在 UI 上改 eventId 必须**立刻生效**，不能被 store 里的历史记录压过
 *  ③ 本地已存的活动连接（`ctf_connect` 写的）
 *
 * 两个例外，避免"改了没用"的另一种形态：
 *  - `args` 给的 key 正好等于设置页那条 → 用设置页（用户可能直接从设置页复制了 key）；
 *  - store 的活动连接标记了 `settingsSync === 'failed'`（ctf_connect 连过、但回写设置页失败）→
 *    以**本次连接**为准，否则用户刚 connect 的赛事会被旧设置页压掉。
 *
 * Cookie 单独取（**设置页永远不写 cookie**，所以这里可能要给设置页配 store 里的 cookie）：
 *  同 key 的本地连接（ctf_connect 存的）→ 设置页 → null。
 *
 * @returns {{connection: object, origin: string, cookieFrom: string, mismatch: object|null}|null}
 */
export function pickConnection({
  requested = null,
  explicitMatch = null,
  settings = null,
  stored = null,
  getStoredByKey = () => null,
  listStored = () => [],
} = {}) {
  const wanted = requested ?? {}
  const wantsExplicit = Boolean(wanted.key || wanted.platform || wanted.eventId != null || wanted.baseUrl)
  const tag = (connection, origin, cookieFrom, mismatch = null) => ({
    connection: {
      ...connection,
      origin,
      originText: CONNECTION_ORIGIN_TEXT[origin] ?? origin,
      cookieFrom,
      ...(mismatch ? { mismatch } : {}),
    },
    origin,
    cookieFrom,
    mismatch,
  })

  const base = (value) => String(value ?? '').trim().replace(/\/+$/, '')

  /**
   * 给连接补 Cookie，按以下顺序查找：
   *  ① **同 key 的本地连接**（ctf_connect 为这个赛事存过）—— 最新鲜，优先；
   *  ② **设置页的 Cookie**（裸 sessionid 会补前缀，见 `normalizeCookie`）；
   *  ③ **同平台（同 baseUrl）其它连接的 Cookie** —— ⚠️ 关键：**Cookie 是平台级会话凭据，与赛事无关**
   *     （实测 store 里 `…:4` 的 Cookie 对 event 4 / event 7 都有效）。切赛事时 store 里往往只有旧赛事的连接，
   *     没有这一档就会「连接对了但没凭据」→ 403「未登录」→ 空数据。
   *  ④ 都拿不到 → 如实标注「无可用 Cookie」（不假装有）。
   *
   * ⛔ **绝不跨 baseUrl 复用**：不同平台的凭据不通用，拿错平台等于凭据泄漏。
   */
  const withCookie = (connection, key) => {
    const byKey = getStoredByKey(key)
    if (byKey && cookieLooksUsable(byKey.cookie)) {
      return { connection: { ...connection, cookie: byKey.cookie }, cookieFrom: `本地连接 ${key}` }
    }
    const own = normalizeCookie(connection.cookie)
    if (cookieLooksUsable(own)) return { connection: { ...connection, cookie: own }, cookieFrom: '设置页' }

    const samePlatform = listStored()
      .filter(
        (item) =>
          item?.key !== key &&
          cookieLooksUsable(item?.cookie) &&
          base(item?.baseUrl) === base(connection?.baseUrl),
      )
      .sort((a, b) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')))[0]
    if (samePlatform) {
      return {
        connection: { ...connection, cookie: samePlatform.cookie },
        cookieFrom: `同平台连接 ${samePlatform.key}`,
      }
    }
    return { connection, cookieFrom: '（无可用 Cookie）' }
  }

  // ① 显式参数
  if (wantsExplicit) {
    if (explicitMatch) return tag(explicitMatch, 'args', `明文传入/本地连接 ${explicitMatch.key ?? ''}`.trim())
    if (settings) {
      const settingsKey = connectionKey(settings)
      const hit = wanted.key ? String(wanted.key) === settingsKey : true
      if (hit) {
        const { connection, cookieFrom } = withCookie({ ...settings, key: settingsKey }, settingsKey)
        return tag(connection, 'args', cookieFrom)
      }
    }
    return null // 调用方负责报错（列出可用连接）
  }

  const settingsKey = settings ? connectionKey(settings) : null
  const storedKey = stored?.key ?? (stored ? connectionKey(stored) : null)

  // ② 设置页优先
  if (settings) {
    const sameAsStore = Boolean(stored && storedKey === settingsKey)
    // 比较前先归一化：`https://h:8000/` 与 `https://h:8000` 是同一个平台，不该报「不一致」
    const norm = (value) => String(value ?? '').trim().replace(/\/+$/, '')
    const mismatch = stored && !sameAsStore
      ? {
          settingsKey,
          storeKey: storedKey,
          fields: ['baseUrl', 'eventId'].filter((field) => norm(settings[field]) !== norm(stored[field])),
        }
      : null
    // 例外：ctf_connect 明确连过、但设置页回写失败 → 以本次连接为准（否则"刚 connect 就被旧设置页压掉"）
    if (stored && !sameAsStore && stored.settingsSync === 'failed') {
      return tag({ ...stored }, 'store', `本地连接 ${storedKey}`, mismatch)
    }
    const { connection, cookieFrom } = withCookie({ ...settings, key: settingsKey }, settingsKey)
    return tag(connection, 'settings', cookieFrom, mismatch)
  }

  // ③ 本地已存连接
  if (stored) return tag({ ...stored }, 'store', `本地连接 ${storedKey}`)
  return null
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

  //  依赖注入：解析当前应使用的平台连接与适配器
  //
  // 解析顺序：显式参数 > 本地已存连接 > **插件配置兜底**。
  // 最后一条是关键：用户在设置页填好平台地址/赛事ID/Cookie 后，直接说「开始」就能用，
  // 不必先在对话里跑 ctf_connect（也就不会把凭据打进聊天记录）。
  const rawResolveAdapter = createResolveAdapter({ store, config, rawConfig, createAdapter, logger })
  // 工具执行通过 withSessionCapture 进入 AsyncLocalStorage；解析到真实连接后把
  // connKey/eventId 回写当前上下文，团队/报告路由即可按会话过滤，不依赖全局 activeConnection。
  let sessionRegistry = null
  const resolveAdapter = async (args = {}) => {
    const resolved = await rawResolveAdapter(args)
    const scoped = sessionRegistry?.currentContext?.({ allowLatest: false })
    if (scoped && resolved) {
      const key = textValue(resolved.connKey ?? resolved.connection?.key)
      if (key) scoped.connKey = key
      const eventId = resolved.connection?.eventId
      if (eventId !== undefined && eventId !== null && String(eventId).trim() !== '') {
        scoped.eventId = String(eventId).trim()
      }
    }
    return resolved
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
    exporter: undefined,
    teams: undefined, // agentTeams 就绪后由下面的 withService 填上（/lingxu-ctf/team 读它）
    session: undefined, // 按 sessionId 隔离的会话身份注册表，见 withSessionCapture
    sessions: undefined, // sessions 服务（可选）：定位当前会话
    connection: undefined, // DSH Host Connection（可选）：复用浏览器会话认证
    sessionQuery: undefined, // sessionQuery 服务（可选）：确认重启后仍存在的冷会话
    sessionProjections: undefined, // sessionProjections 服务（可选）：读取 tokenUsage 投影
  }

  // 会话身份捕获：`GET /lingxu-ctf/team` 需要用 callerAgent 读任务板，而 HTTP 路由没有 exec。
  // 编排器只在 ctf_solve_* 时捕获 Lead 身份；这里对**所有** ctf_* 工具兜一层，
  // 覆盖「Lead 没跑过 solve_*」「用户直接用 DSH 的 spawn_teammate 起人」「teammate 自己调 ctf_* 工具」三种场景。
  // 注册表按 sessionId 建立独立上下文，避免两个 DSH 会话交错时互相覆盖 caller / connKey。
  const session = createSessionRegistry()
  sessionRegistry = session
  deps.session = session

  // ctf_status 的 token 用量行：tools.js 不能 import 本文件（会成环），所以走 deps 注入。
  // 只读会话日志 + 增量缓存，失败不抛（工具里再兜一层）。
  deps.readTokenUsage = (options) => readSessionTokenUsage({
    sessionId: sessionIdOf(options?.sessionId) || session.sessionId,
    // 工具层保留旧宿主的无 sessionId 兼容；普通 HTTP 路由直接传 allowInferred=false。
    allowInferred: options?.allowInferred !== false,
  })

  //  编排与 WP
  // agentTeams 是**可选**服务：用 ctx.inject 等它就绪后再建编排器。
  //
  // ⚠️ 不能用 `ctx.get('agentTeams')`：在真实 Loader 上下文里，未写进插件 `inject`
  //    的 service 通过 ctx.get 取不到（静默返回 undefined），实测已确认
  //    （agent-team bundle 明明是 active，却报「Agent Teams 未挂载」）。
  //    而 `inject` 数组语义是「必需」，把 agentTeams 写进去会让没装该 bundle 的组合
  //    整体加载失败，所以用 ctx.inject 起子 fiber 等它。
  deps.writeup = createWriteup(deps)
  deps.exporter = createExportBundle(deps)

  //  设置页同步
  //
  // 「设置页 = 我配置的平台」「ctf_connect = 连接/切换」两者必须一致：
  // ctf_connect 成功后把 baseUrl/eventId/label 回写设置页，下次用户在设置页改 eventId 才能立刻生效。
  //
  // ⚠️ 只回写**非 secret** 字段：cookie 是 secret（`dsh-settings` 给远程调用者返回脱敏值 `***`），
  //    写回脱敏串会把用户 Cookie 覆盖成 `***`。Cookie 的权威副本始终在 store（ctf_connect 写的）。
  //
  // 服务获取沿用 `withService`（内部 ctx.inject 子 fiber）：**不需要改插件 inject 数组** ——
  // settings 是可选服务，写进 inject 会让没装它的组合整体加载失败。
  deps.settings = undefined
  deps.settingsEntryId = (() => {
    try {
      // 本插件在 profile 里的条目 id（Settings 的 ns），例如 `lingxu-ctf`
      return ctx.fiber?.entry?.options?.id ?? null
    } catch {
      return null
    }
  })()
  withService(
    ctx,
    'settings',
    (serviceCtx, settings) => {
      deps.settings = settings
      logger.info(`设置页同步已就绪（条目 ${deps.settingsEntryId ?? '未知'}）`)
    },
    logger,
  )

  /**
   * 把平台/赛事信息回写设置页（`ctf_connect` 成功后调用）。
   *
   * 安全纪律：**只写 baseUrl / eventId / label**，绝不写 cookie（见上）。
   * `expectedRevision` 从 `settings.describe()` 里取（并发写冲突时平台会抛 SettingsConflictError）。
   *
   * @returns {Promise<{ok: boolean, reason?: string, ns?: string|null}>}
   */
  deps.syncSettings = async ({ baseUrl, eventId, label } = {}) => {
    const settings = deps.settings
    const ns = deps.settingsEntryId
    if (!settings || typeof settings.update !== 'function') {
      return { ok: false, reason: 'settings 服务不可用（未安装 dsh-settings？）', ns }
    }
    if (!ns) return { ok: false, reason: '拿不到插件在 profile 里的条目 id', ns }
    let revision
    try {
      const forms = typeof settings.describe === 'function' ? settings.describe() : []
      const entry = (Array.isArray(forms) ? forms : []).find((form) => form?.ns === ns)
      if (!entry) return { ok: false, reason: `设置页里找不到条目 ${ns}`, ns }
      revision = entry.revision
    } catch (error) {
      return { ok: false, reason: `读取设置页失败：${error?.message ?? error}`, ns }
    }
    try {
      const patch = {
        ...(baseUrl ? { baseUrl: String(baseUrl) } : {}),
        ...(eventId != null && eventId !== '' ? { eventId: Number(eventId) } : {}),
        ...(label ? { label: String(label) } : {}),
      }
      await settings.update(ns, patch, revision)
      return { ok: true, ns }
    } catch (error) {
      return { ok: false, reason: `${error?.message ?? error}`, ns }
    }
  }

  // token 用量对账：宿主侧读取 DSH 的 tokenUsage 投影。
  // 这个服务在不同 DSH 版本的挂载方式不同，缺失时只保留日志侧结果。
  withService(ctx, 'sessions', (_serviceCtx, sessions) => {
    deps.sessions = sessions
  }, logger)

  withService(ctx, 'connection', (_serviceCtx, connection) => {
    deps.connection = connection
  }, logger)

  withService(ctx, 'sessionQuery', (_serviceCtx, sessionQuery) => {
    deps.sessionQuery = sessionQuery
  }, logger)

  withService(ctx, 'sessionProjections', (_serviceCtx, projections) => {
    deps.sessionProjections = projections
  }, logger)

  withService(ctx, 'agentTeams', (serviceCtx, teams) => {
    deps.teams = teams // /lingxu-ctf/team 在请求时读它（服务晚于 webServer 就绪也不会漏）
    deps.orchestrator = createOrchestrator({ ...deps, teams })
    logger.info('Agent Teams 已就绪：ctf_solve_start / status / stop 可用')

    // agentTeams 可能在热重载/服务重新装配时重复交付；先拆掉旧订阅，避免一条消息写入多次。
    if (typeof deps.teamHookDisposer === 'function') {
      try { deps.teamHookDisposer() } catch { /* 旧宿主 disposer 失败不影响新订阅 */ }
      deps.teamHookDisposer = null
      deps.teamHook = false
    }

    //  观察 teammate 之间的 send_message
    // 邮箱把消息投递给目标会话时会写一条 user/message（source.kind='team-message'），
    // 宿主侧通过 ctx.on('session/event') 能看到 —— 我们只**记录**，不参与投递：
    // ⚠️ 处理器整体包 try/catch 且不 await，钩子失败绝不能影响消息送达。
    const onSessionEvent = (sessionRef, event) => {
      try {
        const eventSessionId = sessionIdOf(
          sessionRef?.sessionId
            ?? sessionRef?.id
            ?? event?.sessionId
            ?? event?.data?.sessionId
            ?? event?.data?.session?.id,
        )
        // 会话结束事件不应继续占住 caller/connKey；不同 DSH 版本的事件名不同，
        // 这里只识别明确的生命周期词，不影响普通 user/message 投递。
        const lifecycle = String(event?.type ?? event?.data?.type ?? '').toLowerCase()
        if (eventSessionId && /(?:session[/:_-])?(?:close|closed|dispose|disposed|destroy|destroyed|delete|deleted)$/.test(lifecycle)) {
          deps.session?.release?.(eventSessionId)
        }
        const delivery = teamDeliveryOf(event)
        if (delivery === null || typeof store?.appendTeamMessage !== 'function') return
        const bound = eventSessionId ? deps.session?.get?.(eventSessionId) : null
        const caller = bound?.caller ?? (eventSessionId ? null : deps.orchestrator?.getCaller?.() ?? null)
        const recipient = resolveMemberLabel(teams, sessionRef, caller)
        void (async () => {
          // 未绑定的事件只能进 unknown 队列，不能借用别的会话的活动连接。
          const connKey = textValue(bound?.connKey) || (eventSessionId ? 'unknown' : await connectionKeyForHook(store))
          await store.appendTeamMessage(connKey, {
            at: delivery.at === null ? undefined : new Date(delivery.at).toISOString(),
            from: delivery.from,
            to: recipient,
            kind: delivery.kind,
            text: delivery.text,
            messageId: delivery.messageId,
          })
        })().catch(() => { /* 落盘失败不影响投递 */ })
      } catch { /* 观察失败静默 */ }
    }
    try {
      if (typeof serviceCtx.on === 'function') {
        const off = serviceCtx.on('session/event', onSessionEvent)
        deps.teamHookDisposer = disposerOf(off)
          ?? (typeof serviceCtx.off === 'function' ? () => serviceCtx.off('session/event', onSessionEvent) : null)
        deps.teamHook = true
      } else if (typeof ctx.on === 'function') {
        const off = ctx.on('session/event', onSessionEvent)
        deps.teamHookDisposer = disposerOf(off)
          ?? (typeof ctx.off === 'function' ? () => ctx.off('session/event', onSessionEvent) : null)
        deps.teamHook = true
      }
      logger.info(deps.teamHook === true
        ? '已订阅 session/event：teammate 之间的 send_message 会进协同通信'
        : '未能订阅 session/event（ctx.on 不可用）：协同通信只有 ctf_team_log 的手工汇报')
    } catch (error) {
      logger.warn(`订阅 session/event 失败（不影响消息送达）：${error?.message ?? error}`)
    }
  }, logger)

  // 会话注册表和团队观察钩子都绑定插件生命周期；卸载/热重载后不得残留闭包。
  ctx.effect(() => () => {
    if (typeof deps.teamHookDisposer === 'function') {
      try { deps.teamHookDisposer() } catch { /* best effort */ }
      deps.teamHookDisposer = null
    }
    deps.teamHook = false
    deps.session?.dispose?.()
  })

  //  工具注册
  //
  // 基础工具集（18 个）永远注册；AWD / CFS 的专用工具**按赛事类型动态注册**：
  // 只有当当前连接对应的赛事真的含该赛段时才挂上（ctx.tools.register 返回 disposer，
  // 可以随时注销）。这样既保留了「名字自解释的独立工具」的可发现性，
  // 又不会在纯 CTF 赛事上白白占 16 个无关工具的上下文。
  const baseDisposers = []
  for (const spec of buildToolSpecs(deps)) {
    baseDisposers.push(ctx.tools.register(defineTool(withSessionCapture(spec, session))))
  }
  ctx.effect(() => () => {
    for (const dispose of baseDisposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        logger.warn('基础工具注销失败', error?.message ?? error)
      }
    }
  })

  // 赛段工具（AWD/CFS）按赛事动态注册 —— 逻辑抽在 createStageToolRegistry 里便于单测。
  const stageRegistry = createStageToolRegistry({
    registerTool: (spec) => ctx.tools.register(defineTool(withSessionCapture(spec, session))),
    deps,
    logger,
  })
  ctx.effect(() => () => stageRegistry.disposeAll())

  // 插件加载时先探一次（从 store 的 active connection 取赛事）；失败就静默保持基础工具集。
  // recommendStageTools 返回**三态**：true 注册 / false 注销 / null 保持现状——
  // 拿不到 testTypes 时不能贸然注销，否则工具列表会随网络抖动反复增减。
  void (async () => {
    try {
      const { adapter } = await resolveAdapter({})
      const summary = await adapter.eventSummary()
      stageRegistry.sync(recommendStageTools(summary))
    } catch {
      /* 没配连接 / 探活失败都不影响基础工具集 */
    }
  })()

  // 两个触发点：
  //   syncStageTools —— ctf_connect 成功后（用户刚确认过凭据，最自然的时机）
  //   onStageInfo    —— ctf_status / ctf_session 跑完（它们本来就会调 eventSummary，
  //                     所以 AWD/CFS 赛事在用户第一次 ctf_status 后就能长出工具，零额外请求）
  deps.syncStageTools = (stages) => stageRegistry.sync(stages)
  deps.onStageInfo = (summary) => stageRegistry.sync(recommendStageTools(summary))

  //  系统提示词：告诉 agent 这套工具的存在与纪律
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
        '不确定的 flag 不要反复提交——平台对错误提交本身不扣分，但反复乱试会浪费比赛时间。',
      ].join('\n'),
    })
  }, logger)

  //  Web 控制面板
  if (config.enableWebPanel) {
    withService(ctx, 'webServer', (serviceCtx, webServer) => {
      if (!webServer?.register) return
      registerWebPanel(serviceCtx, webServer, { deps, store, resolveAdapter, config, workDir, logger })
    }, logger)
  }

  //  斜杠命令：快速看状态
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
          // 注意：punish 是「是否展示处罚警告」（管理员下发的作弊处罚），不是错误提交扣分。
          if (summary.punish) lines.push('ℹ 本赛事会在前台公示作弊处罚记录（punish=true）')
          return { kind: 'success', text: lines.join('\n') }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  }, logger)

  logger.info(
    `已加载：${baseDisposers.length} 个基础工具（AWD/CFS 工具按赛事类型动态注册），` +
      `平台适配器 [${listPlatforms().join(', ')}]，工作目录 ${workDir}，并发 ${config.concurrency}`,
  )
}

/**
 * 赛段工具（AWD/CFS）的动态注册器。
 *
 * 凌虚的 `Competition.test_type` 决定这场赛事含哪些赛段（1 理论题 / 2 CTF / 3 AWD / 4 CFS）。
 * AWD 与 CFS 各有自己的一整套操作（回合制攻防、KVM 重置、关卡制……），
 * 全量注册会让工具列表膨胀到 30+，而纯 CTF 赛事根本用不到。
 *
 * 所以按赛段**动态注册**：`ctx.tools.register()` 返回 disposer，可以随时注销。
 * 这样既保留「名字自解释的独立工具」的可发现性，又不在无关赛事上占上下文。
 *
 * @param {{ registerTool: (spec: object) => (() => void), buildAwd?: Function, buildCfs?: Function,
 *          deps?: object, logger?: object }} options
 *  - `registerTool`：把 ToolSpec 包成 DSH 工具并注册，**返回 disposer**。
 *  - `buildAwd` / `buildCfs`：产出 ToolSpec 数组的 builder（默认取 stage-tools.js 的实现）。
 * @returns {{ sync: (stages?: {hasAwd?: boolean|null, hasCfs?: boolean|null}|null) => string,
 *            disposeAll: () => void,
 *            counts: () => {awd: number, cfs: number},
 *            signature: () => string|null }}
 */
export function createStageToolRegistry({ registerTool, buildAwd, buildCfs, deps = {}, logger = {} } = {}) {
  const buildA = typeof buildAwd === 'function' ? buildAwd : buildAwdToolSpecs
  const buildC = typeof buildCfs === 'function' ? buildCfs : buildCfsToolSpecs
  const bag = { awd: [], cfs: [] }
  let sig = null

  function dispose(stage) {
    for (const off of bag[stage].splice(0)) {
      try {
        off()
      } catch (error) {
        logger.warn?.(`${stage} 工具注销失败`, error?.message ?? error)
      }
    }
  }

  function sync(stages) {
    // 探活失败或能力未知时保持对应赛段现状：不能因为一次网络抖动就把已注册的工具摘掉。
    if (!stages) return sig ?? ''
    const currentAwd = sig === 'awd|' || sig === 'awd|cfs'
    const currentCfs = sig === '|cfs' || sig === 'awd|cfs'
    const wantAwd = stages.hasAwd === undefined || stages.hasAwd === null
      ? currentAwd
      : stages.hasAwd === true
    const wantCfs = stages.hasCfs === undefined || stages.hasCfs === null
      ? currentCfs
      : stages.hasCfs === true
    if (stages.hasAwd === undefined && stages.hasCfs === undefined) return sig ?? ''
    const next = `${wantAwd ? 'awd' : ''}|${wantCfs ? 'cfs' : ''}`
    if (next === sig) return sig // 状态没变，避免反复注册/注销
    sig = next
    dispose('awd')
    dispose('cfs')
    if (wantAwd) for (const spec of buildA(deps)) bag.awd.push(registerTool(spec))
    if (wantCfs) for (const spec of buildC(deps)) bag.cfs.push(registerTool(spec))
    logger.info?.(
      `赛段工具已同步：AWD ${wantAwd ? `${bag.awd.length} 个` : '无'}，CFS ${wantCfs ? `${bag.cfs.length} 个` : '无'}`,
    )
    return sig
  }

  return {
    sync,
    disposeAll: () => {
      dispose('awd')
      dispose('cfs')
      sig = null
    },
    counts: () => ({ awd: bag.awd.length, cfs: bag.cfs.length }),
    signature: () => sig,
  }
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
  reuseAgents: '复用闲置 agent',
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

/** 过滤配置路由的输入，只接受 schema 中声明的字段和类型。 */
export function normalizeConfigPatch(patch = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('配置补丁必须是对象')
  }
  const fields = new Map(describeConfigFields().map((field) => [field.key, field]))
  const clean = {}
  for (const [key, value] of Object.entries(patch)) {
    const field = fields.get(key)
    if (!field) throw new Error(`不支持的配置项：${key}`)
    // 空值仍是“保持原值”约定，尤其不能用空串擦除 secret。
    if (value === '' || value === undefined || value === null) continue
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} 必须是有限数字`)
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`)
    } else if (field.type === 'string') {
      if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`)
    } else if (field.options && !field.options.includes(value)) {
      throw new Error(`${key} 不是允许的值`)
    }
    clean[key] = value
  }
  return clean
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

const SESSION_REGISTRY = Symbol('lingxuSessionRegistry')
const ANONYMOUS_SESSION_ID = '__anonymous__'

function textValue(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function safeNow(now) {
  try {
    const value = Number(now?.())
    return Number.isFinite(value) ? value : Date.now()
  } catch {
    return Date.now()
  }
}

function isoAt(value) {
  try {
    return new Date(value).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/** 从工具执行上下文提取宿主会话身份，兼容 DSH 不同版本的字段形状。 */
function executionSessionId(exec) {
  return sessionIdOf(
    exec?.sessionId
      ?? exec?.session?.id
      ?? exec?.session
      ?? exec?.context?.sessionId
      ?? exec?.context?.session?.id
      ?? exec?.agent?.sessionId
      ?? exec?.agent?.session?.id,
  )
}

function executionCaller(exec) {
  return exec?.agent
    ?? exec?.callerAgent
    ?? exec?.caller
    ?? exec?.context?.agent
    ?? null
}

/**
 * 从工具参数/宿主 exec 提取连接 key。
 * 连接 key 是赛事隔离的第二维；没有显式 key 时，ctf_connect 的 baseUrl/eventId
 * 仍能形成稳定 key，避免新会话沿用上一会话的活动赛事。
 */
function executionConnKey(args, exec) {
  const candidates = [
    exec?.connKey,
    exec?.connectionKey,
    exec?.context?.connKey,
    exec?.context?.connectionKey,
    exec?.session?.connKey,
    args?.connKey,
    args?.connectionKey,
    args?.connection,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (candidate && typeof candidate === 'object') {
      const explicit = textValue(candidate.key ?? candidate.connKey ?? candidate.connectionKey)
      if (explicit) return explicit
      try {
        const derived = connectionKey(candidate)
        if (derived && !/^lingxu::/.test(derived)) return derived
      } catch {
        /* 形状不是连接对象，继续尝试下一个候选 */
      }
    }
  }
  const baseUrl = textValue(args?.baseUrl ?? exec?.baseUrl ?? exec?.context?.baseUrl)
  const eventId = args?.eventId ?? exec?.eventId ?? exec?.context?.eventId
  if (baseUrl && eventId !== undefined && eventId !== null && String(eventId).trim() !== '') {
    try {
      return connectionKey({ platform: 'lingxu', baseUrl, eventId })
    } catch {
      /* 连接字段不完整时保持空值，调用方会显示 unknown 而不是猜测 */
    }
  }
  return ''
}

function executionEventId(args, exec) {
  const candidate = exec?.eventId
    ?? exec?.event?.id
    ?? exec?.context?.eventId
    ?? exec?.context?.event?.id
    ?? args?.eventId
  if (candidate === undefined || candidate === null) return ''
  return textValue(String(candidate))
}

function updateSessionTarget(target, context) {
  // 注册表 facade 自身通过同一 symbol 指向自己；旧的可变槽位则指向 facade，仍需同步。
  if (!target || typeof target !== 'object' || target[SESSION_REGISTRY] === target) return
  try { target.caller = context?.caller ?? null } catch { /* 只读兼容槽 */ }
  try { target.sessionId = context?.sessionId ?? '' } catch { /* 只读兼容槽 */ }
  try { target.connKey = context?.connKey ?? '' } catch { /* 只读兼容槽 */ }
  try { target.eventId = context?.eventId ?? '' } catch { /* 只读兼容槽 */ }
}

function disposerOf(value) {
  if (typeof value === 'function') return value
  if (typeof value?.dispose === 'function') return () => value.dispose()
  if (typeof value?.off === 'function') return () => value.off()
  if (typeof value?.unsubscribe === 'function') return () => value.unsubscribe()
  return null
}

/**
 * 创建插件实例级会话注册表。
 *
 * 每次工具执行通过 AsyncLocalStorage 进入自己的上下文；插件内部仍可读取
 * `deps.session.caller/sessionId/connKey`，但并发执行时这些 getter 不再共享最近一次调用。
 * `get()`/`release()` 给 HTTP 路由和生命周期钩子使用，`prune()` 负责回收异常退出的会话。
 */
export function createSessionRegistry({
  now = () => Date.now(),
  ttlMs = SESSION_CONTEXT_TTL_MS,
  maxContexts = SESSION_CONTEXT_MAX,
  legacyTarget = null,
} = {}) {
  const storage = new AsyncLocalStorage()
  const contexts = new Map()
  let activeId = ''
  let disposed = false

  function contextId(value) {
    const id = textValue(value)
    return id === '' ? ANONYMOUS_SESSION_ID : id
  }

  function createContext(id) {
    const nowMs = safeNow(now)
    const sessionId = id === ANONYMOUS_SESSION_ID ? '' : id
    return {
      sessionId,
      caller: null,
      connKey: '',
      eventId: '',
      capturedAt: isoAt(nowMs),
      lastSeenAt: isoAt(nowMs),
      anonymous: sessionId === '',
    }
  }

  function touch(context) {
    if (!context) return context
    context.lastSeenAt = isoAt(safeNow(now))
    activeId = context.sessionId || ANONYMOUS_SESSION_ID
    updateSessionTarget(legacyTarget, context)
    return context
  }

  function prune() {
    if (disposed) return 0
    const nowMs = safeNow(now)
    const limit = Number(ttlMs)
    let removed = 0
    if (Number.isFinite(limit) && limit > 0) {
      for (const [id, context] of contexts) {
        const seen = Date.parse(String(context.lastSeenAt ?? ''))
        if (Number.isFinite(seen) && nowMs - seen > limit) {
          contexts.delete(id)
          if (activeId === id) activeId = ''
          removed += 1
        }
      }
    }
    const cap = Number.isFinite(Number(maxContexts)) && Number(maxContexts) > 0
      ? Math.floor(Number(maxContexts))
      : SESSION_CONTEXT_MAX
    while (contexts.size > cap) {
      const oldest = contexts.keys().next().value
      if (oldest === undefined) break
      contexts.delete(oldest)
      if (activeId === oldest) activeId = ''
      removed += 1
    }
    return removed
  }

  function ensure(id, seed = {}) {
    if (disposed) return null
    prune()
    const key = contextId(id)
    let context = contexts.get(key)
    if (!context) {
      context = createContext(key)
      contexts.set(key, context)
    }
    if (seed.caller !== undefined && seed.caller !== null) context.caller = seed.caller
    if (textValue(seed.connKey)) context.connKey = textValue(seed.connKey)
    if (seed.eventId !== undefined && seed.eventId !== null && String(seed.eventId).trim() !== '') {
      context.eventId = String(seed.eventId).trim()
    }
    return touch(context)
  }

  function currentContext({ sessionId, allowLatest = true } = {}) {
    if (disposed) return null
    prune()
    const requested = sessionId === undefined || sessionId === null ? null : textValue(sessionId)
    if (requested !== null) return contexts.get(contextId(requested)) ?? null
    const scoped = storage.getStore()
    if (scoped) {
      // 当前异步调用原属已 release 的 session 时返回 null，不能退回另一个
      // 活跃 session；否则关闭会话的尾部 promise 可能写入别人的上下文。
      return contexts.get(scoped.key) === scoped.context ? touch(scoped.context) : null
    }
    if (!allowLatest || activeId === '') return null
    return contexts.get(activeId) ?? null
  }

  function capture(exec, args = {}) {
    const id = executionSessionId(exec)
    const caller = executionCaller(exec)
    const connKey = executionConnKey(args, exec)
    const eventId = executionEventId(args, exec)
    // 没有任何身份字段时保留当前绑定（旧宿主会省略 exec），不要把已捕获的
    // session-real 清空成匿名上下文；真正的新会话必须带 sessionId 才能隔离。
    if (!id && !caller && !connKey && !eventId) {
      const existing = currentContext({ allowLatest: true })
      if (existing) return touch(existing)
      if (storage.getStore()) return null
    }
    const context = ensure(id, {
      caller,
      connKey,
      eventId,
    })
    if (context) touch(context)
    return context
  }

  function run(context, callback) {
    if (disposed || !context || typeof callback !== 'function') return callback?.()
    const key = context.sessionId || ANONYMOUS_SESSION_ID
    return storage.run({ key, context }, callback)
  }

  function release(sessionId) {
    if (disposed) return false
    const requested = textValue(sessionId)
    const key = contextId(requested)
    const removed = contexts.delete(key)
    if (activeId === key) activeId = ''
    if (removed && legacyTarget && legacyTarget !== facade) {
      updateSessionTarget(legacyTarget, null)
    }
    return removed
  }

  function dispose() {
    if (disposed) return
    disposed = true
    contexts.clear()
    activeId = ''
    try { storage.disable() } catch { /* Node 18 always supports disable; test doubles may not */ }
    if (legacyTarget && legacyTarget !== facade) updateSessionTarget(legacyTarget, null)
  }

  const facade = {
    capture,
    run,
    get: (sessionId) => {
      prune()
      const id = textValue(sessionId)
      return id === '' ? null : contexts.get(id) ?? null
    },
    currentContext,
    release,
    prune,
    dispose,
    snapshot: () => {
      prune()
      return [...contexts.values()].map((context) => ({ ...context }))
    },
    get size() {
      prune()
      return contexts.size
    },
    get caller() { return currentContext()?.caller ?? null },
    set caller(value) {
      const scoped = storage.getStore()
      const context = currentContext() ?? (scoped ? null : ensure('', { caller: value }))
      if (context) {
        context.caller = value ?? null
        touch(context)
      }
    },
    get sessionId() { return currentContext()?.sessionId ?? '' },
    set sessionId(value) {
      const id = textValue(value)
      const current = currentContext({ allowLatest: true })
      if (!id) return
      if (!current && storage.getStore()) return
      // sessionId 是注册表主键，不在原 context 上原地改名；这样不会留下
      // Map key 与 context.sessionId 不一致的幽灵槽位。
      const context = current && current.sessionId === id
        ? current
        : ensure(id, {
            caller: current?.caller,
            connKey: current?.connKey,
            eventId: current?.eventId,
          })
      if (context) touch(context)
    },
    get connKey() { return currentContext()?.connKey ?? '' },
    set connKey(value) {
      const scoped = storage.getStore()
      const context = currentContext() ?? (scoped ? null : ensure(''))
      if (context) {
        context.connKey = textValue(value)
        touch(context)
      }
    },
    get eventId() { return currentContext()?.eventId ?? '' },
    set eventId(value) {
      const scoped = storage.getStore()
      const context = currentContext() ?? (scoped ? null : ensure(''))
      if (context) {
        context.eventId = textValue(value)
        touch(context)
      }
    },
  }
  Object.defineProperty(facade, SESSION_REGISTRY, { value: facade })

  // 兼容旧调用方传入的 `{ caller, sessionId }` 槽位；初始值只作为匿名上下文种子。
  if (legacyTarget && typeof legacyTarget === 'object') {
    Object.defineProperty(legacyTarget, SESSION_REGISTRY, { value: facade, configurable: true })
    const seedId = textValue(legacyTarget.sessionId)
    const seed = ensure(seedId, {
      caller: legacyTarget.caller,
      connKey: legacyTarget.connKey,
      eventId: legacyTarget.eventId,
    })
    updateSessionTarget(legacyTarget, seed)
  }
  return facade
}

function sessionRegistryOf(value) {
  if (value && typeof value === 'object' && value[SESSION_REGISTRY]) return value[SESSION_REGISTRY]
  if (value && typeof value === 'object') return createSessionRegistry({ legacyTarget: value })
  return createSessionRegistry()
}

/** 读取请求头，兼容 Fetch Headers 和普通对象替身。 */
function requestHeader(req, name) {
  const headers = req?.headers
  if (typeof headers?.get === 'function') return textValue(headers.get(name))
  const wanted = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (String(key).toLowerCase() === wanted) return textValue(value)
  }
  return ''
}

/** 配置写入只接受同源请求；没有 Origin 的宿主内部调用保留兼容性。 */
export function isSameOriginConfigRequest(req) {
  const fetchSite = requestHeader(req, 'sec-fetch-site').toLowerCase()
  if (fetchSite === 'cross-site') return false
  const origin = requestHeader(req, 'origin')
  if (origin === '' || origin === 'null') return origin === ''
  const host = requestHeader(req, 'host')
  if (host === '') return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function redactLocalPathText(value) {
  return String(value ?? '')
    .replace(/\/(?:Users|private|var|tmp|home|Volumes)\/[^\s，。；;）)]+/g, '<本机路径>')
    .replace(/[A-Za-z]:\\[^\s，。；;）)]+/g, '<本机路径>')
}

function publicErrorText(error) {
  return redactLocalPathText(error instanceof Error ? error.message : String(error))
}

function isAbsoluteLocalPath(value) {
  const text = String(value ?? '')
  return path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text)
}

function publicUsagePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const { file, ...rest } = payload
  if (typeof rest.error === 'string') rest.error = redactLocalPathText(rest.error)
  return rest
}

function publicReportsPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  return {
    ...payload,
    ...(typeof payload.error === 'string' ? { error: redactLocalPathText(payload.error) } : {}),
    writeups: Array.isArray(payload.writeups)
      ? payload.writeups.map(({ absPath, ...row }) => ({
        ...row,
        path: isAbsoluteLocalPath(row.path) ? '<本机路径>' : row.path,
      }))
      : [],
  }
}

/** 从 HTTP 请求中读取宿主/客户端提供的 session id；未提供时返回空串。 */
export function sessionIdFromRequest(req) {
  const direct = sessionIdOf(
    req?.sessionId
      ?? req?.session?.id
      ?? req?.context?.sessionId
      ?? req?.context?.session?.id,
  )
  if (direct) return direct
  const headers = req?.headers
  const header = typeof headers?.get === 'function'
    ? headers.get('x-dsh-session-id') ?? headers.get('x-session-id')
    : headers?.['x-dsh-session-id'] ?? headers?.['x-session-id'] ?? headers?.['X-Dsh-Session-Id'] ?? headers?.['X-Session-Id']
  if (textValue(header)) return textValue(header)
  try {
    const url = new URL(req?.url ?? '/', 'http://localhost')
    return textValue(url.searchParams.get('session'))
  } catch {
    return ''
  }
}

/**
 * 解析 HTTP 请求绑定的会话。
 * 显式指定的 session 必须已注册；缺省时只允许唯一的兼容上下文，绝不猜最近日志。
 */
export function resolveRequestSession(registry, req, { require = false } = {}) {
  const sessions = sessionRegistryOf(registry)
  const requested = sessionIdFromRequest(req)
  if (requested) {
    const context = sessions.get(requested)
    return context
      ? { ok: true, requestedSessionId: requested, context }
      : { ok: false, requestedSessionId: requested, error: `请求的 session 不存在或已结束：${requested}` }
  }
  const rows = sessions.snapshot().filter((row) => row.sessionId !== '')
  if (rows.length > 1) {
    return { ok: false, error: '当前存在多个会话，请在请求中指定 session 参数' }
  }
  const current = sessions.currentContext({ allowLatest: true })
  if (current && current.sessionId !== '') return { ok: true, requestedSessionId: '', context: current }
  if (rows.length === 1) {
    const context = sessions.get(rows[0].sessionId)
    return context ? { ok: true, requestedSessionId: '', context } : { ok: false, error: '会话已结束，请重新调用 ctf_* 工具' }
  }
  const anonymous = sessions.currentContext({ allowLatest: true })
  // 老宿主没有暴露 sessionId 时仍允许唯一匿名 caller 读取团队板；这是兼容退化，
  // 不能与带 sessionId 的上下文混用，也不会用于 usage 的日志回退。
  if (anonymous && rows.length === 0 && anonymous.caller) {
    return { ok: true, requestedSessionId: '', context: anonymous, legacy: true }
  }
  return { ok: false, requestedSessionId: '', error: '当前请求没有绑定 sessionId，请先在会话内调用 ctf_solve_start 或 ctf_status' }
}

/**
 * 在重启或 HMR 后恢复宿主仍存在的精确会话身份。
 *
 * sessions 只含热会话；冷会话通过宿主的只读查询确认，并在完成后释放观察租约。
 * 不猜最近会话，不恢复 caller 或凭据；非 CTF 会话的界面门控仍由客户端预设负责。
 */
async function hydrateRequestSession(registry, requestedSessionId, { sessions, sessionQuery } = {}) {
  const id = textValue(requestedSessionId)
  if (!id || !registry) return null
  const existing = registry.get(id)
  if (existing) return existing
  if (sessionIdOf(sessions?.get?.(id)) === id) return registry.capture({ sessionId: id }, {})
  if (typeof sessionQuery?.observeSession !== 'function') return null
  let observation
  try {
    observation = await sessionQuery.observeSession(id, { projectionMode: 'none' })
    return observation?.header?.id === id ? registry.capture({ sessionId: id }, {}) : null
  } catch {
    return null
  } finally {
    observation?.[Symbol.dispose]?.()
  }
}

/**
 * 给工具 spec 的 `execute` 包一层：记录调用本插件工具的 Agent（`exec.agent`）。
 *
 * 为什么要这层：`/lingxu-ctf/team` 要调 `ctx.agentTeams.listTasks/listMembers`，而这些方法
 * 需要真实 callerAgent；HTTP 路由没有 exec，只能靠会话内捕获。编排器只覆盖 `ctf_solve_*`，
 * 这层覆盖全部 `ctf_*` 工具（任意一个被调用，团队视图就有会话语境）。
 *
 * 纯旁路：不改参数、不改返回值、不改校验顺序；捕获异常一律吞掉。
 * 每次执行在自己的 AsyncLocalStorage 上下文中运行，工具内部读取 `deps.session`
 * 时不会被另一个并发会话覆盖。
 */
export function withSessionCapture(spec, session) {
  const run = spec?.execute
  if (typeof run !== 'function' || !session || typeof session !== 'object') return spec
  const registry = sessionRegistryOf(session)
  return {
    ...spec,
    execute(args, exec) {
      let context = null
      try {
        context = registry.capture(exec, args)
      } catch {
        /* 捕获失败不影响工具执行；旧宿主仍可走匿名兼容上下文 */
      }
      return registry.run(context, () => run(args, exec))
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

  // 面板快照缓存：TTL + 单飞 + 刷新下限 + store 写入穿透。
  // 放在路由注册前，handler 只多一层包装，不动 buildPanelState 的字段构造。
  const storeWriteProbe = instrumentStoreWrites(store)
  const panelCache = createPanelSnapshotCache()

  /**
   * 插件路由不在 DSH `/api` 前缀内，因此不会自动经过
   * `client-connection` 的 Host/Origin/浏览器会话认证。能拿到宿主
   * connection 服务时复用它的 admission；旧宿主没有该服务时至少只接受
   * loopback socket，不能把 `/diag` 当成公开接口。
   */
  function admitPanelRequest(req, res) {
    const connection = deps.connection
    if (connection && typeof connection.admit === 'function') {
      let admission
      try {
        admission = connection.admit(req)
      } catch {
        admission = { rejection: 401 }
      }
      if (admission && Object.prototype.hasOwnProperty.call(admission, 'rejection')) {
        const status = Number(admission.rejection) === 403 ? 403 : 401
        res.statusCode = status
        res.setHeader('cache-control', 'no-store')
        res.end(status === 403 ? 'forbidden' : 'unauthorized')
        return false
      }
      // Connection 的稳定合同是 `{ peer }`；服务版本不匹配或返回空值时
      // 也必须 fail-closed，不能因为认证器异常而把面板变成公开接口。
      if (!admission || typeof admission !== 'object' || !Object.prototype.hasOwnProperty.call(admission, 'peer')) {
        res.statusCode = 401
        res.setHeader('cache-control', 'no-store')
        res.end('unauthorized')
        return false
      }
      return true
    }
    const remoteAddress = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress
    if (!remoteAddress) return true // 单测/宿主内部调用没有 socket
    const normalized = String(remoteAddress).toLowerCase()
    const loopback = normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1'
    if (loopback) return true
    res.statusCode = 403
    res.setHeader('cache-control', 'no-store')
    res.end('forbidden')
    return false
  }

  const registerPanelRoute = (route) => webServer.register({
    ...route,
    handler: async (req, res) => {
      if (!admitPanelRequest(req, res)) return
      return route.handler(req, res)
    },
  })

  // 面板快照
  ctx.effect(() =>
    registerPanelRoute({
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
          await store?.load?.()
          const requestedSessionId = sessionIdFromRequest(req)
          await hydrateRequestSession(deps.session, requestedSessionId, deps)
          const knownSessions = typeof deps.session?.snapshot === 'function'
            ? deps.session.snapshot().filter((row) => row?.sessionId)
            : []
          let sessionContext = null
          if (requestedSessionId || knownSessions.length > 0) {
            const bound = resolveRequestSession(deps.session, req, { require: true })
            if (!bound.ok) {
              res.statusCode = 200
              res.end(JSON.stringify({
                ok: false,
                configured: false,
                sessionId: requestedSessionId || null,
                error: bound.error,
              }))
              return
            }
            sessionContext = bound.context
          }
          const boundConnKey = textValue(sessionContext?.connKey)
          const cacheKey = [
            sessionContext?.sessionId ?? requestedSessionId ?? '',
            boundConnKey,
            store?.state?.activeConnection ?? '',
            config?.eventId ?? '',
            config?.baseUrl ?? '',
          ].join('|')
          const payload = await panelCache.load(
            cacheKey,
            () => withRequestPriority('background', () => buildPanelState({
              store,
              resolveAdapter,
              deps,
              config,
              sessionContext,
              resolveArgs: boundConnKey ? { connection: boundConnKey } : {},
            })),
            panelRevisionOf(store, storeWriteProbe),
            // loud 写操作（交 flag / 切连接）→ 忽略刷新下限，立即穿透
            { loudRevision: storeWriteProbe.loudRevision },
          )
          res.end(JSON.stringify(payload))
        } catch (error) {
          res.statusCode = 200
          res.end(
            JSON.stringify({
              ok: false,
              configured: false,
              error: publicErrorText(error),
            }),
          )
        }
      },
    }),
  )

  // 题目详情：只在用户点击看板题目时请求，避免把完整题面加入轮询快照。
  ctx.effect(() =>
    registerPanelRoute({
      kind: 'exact',
      path: CHALLENGE_ROUTE,
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        let payload
        try {
          const requestedSessionId = sessionIdFromRequest(req)
          await hydrateRequestSession(deps.session, requestedSessionId, deps)
          const knownSessions = typeof deps.session?.snapshot === 'function'
            ? deps.session.snapshot().filter((row) => row?.sessionId)
            : []
          let sessionContext = null
          if (requestedSessionId || knownSessions.length > 0) {
            const bound = resolveRequestSession(deps.session, req, { require: true })
            if (!bound.ok) {
              res.statusCode = 200
              res.end(JSON.stringify({ ok: false, generatedAt: new Date().toISOString(), id: toChallengeId(url.searchParams.get('id')), error: bound.error }))
              return
            }
            sessionContext = bound.context
          }
          const boundConnKey = textValue(sessionContext?.connKey)
          payload = await buildChallengeDetailState({
            store,
            resolveAdapter,
            id: url.searchParams.get('id'),
            workDir,
            fs: fsp,
            sessionContext,
            resolveArgs: boundConnKey ? { connection: boundConnKey } : {},
          })
        } catch (error) {
          payload = { ok: false, generatedAt: new Date().toISOString(), id: toChallengeId(url.searchParams.get('id')), error: publicErrorText(error) }
        }
        if (payload && typeof payload.error === 'string') payload = { ...payload, error: redactLocalPathText(payload.error) }
        res.statusCode = 200
        res.end(JSON.stringify(payload))
      },
    }),
  )

  //  顶部「CTF」视图：agent 团队全景
  //
  // 客户端视图用轮询读它。**HTTP 路由没有 exec.agent**，所以 caller 只能用
  // 编排器在会话内捕获的 Lead 身份（orchestrator.getCaller()）；尚未捕获时
  // 返回 ok:false（HTTP 200），由前端渲染空态并提示先跑一次 ctf_* 工具。
  ctx.effect(() =>
    registerPanelRoute({
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
          await hydrateRequestSession(deps.session, sessionIdFromRequest(req), deps)
          const bound = resolveRequestSession(deps.session, req, { require: true })
          if (!bound.ok) {
            payload = emptyTeamPayload(
              new Date().toISOString(),
              bound.error,
              bound.requestedSessionId || null,
            )
            res.statusCode = 200
            res.end(JSON.stringify(payload))
            return
          }
          payload = await buildTeamState({
            store,
            teams: deps.teams,
            // 显式 session 只读取自己的 caller；没有 session id 的旧宿主仅在唯一兼容上下文时使用。
            caller: bound.context?.caller ?? null,
            sessionContext: bound.context,
            resolveAdapter,
            messagesLimit: readLimitParam(req, TEAM_MESSAGES_DEFAULT_LIMIT, TEAM_MESSAGES_MAX_LIMIT),
          })
        } catch (error) {
          payload = emptyTeamPayload(new Date().toISOString(), publicErrorText(error))
        }
        res.statusCode = 200
        if (payload && typeof payload.error === 'string') {
          payload = { ...payload, error: redactLocalPathText(payload.error) }
        }
        res.end(JSON.stringify(payload))
      },
    }),
  )

  //  顶部「CTF」视图：当前会话的 token 用量（只读会话日志，附带 DSH 投影对账）
  ctx.effect(() =>
    registerPanelRoute({
      kind: 'exact',
      path: USAGE_ROUTE,
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
          const requestedSessionId = sessionIdFromRequest(req)
          await hydrateRequestSession(deps.session, requestedSessionId, deps)
          // 空 session 只在当前工具调用已绑定唯一上下文时允许；不能再从磁盘猜最近会话。
          const bound = resolveRequestSession(deps.session, req, { require: true })
          if (!requestedSessionId && !bound.ok) {
            payload = {
              ok: false,
              sessionId: null,
              inferred: false,
              error: bound.error,
            }
            res.statusCode = 200
            res.end(JSON.stringify(payload))
            return
          }
          const sessionId = requestedSessionId || bound.context?.sessionId || ''
          // 日志根目录只由宿主配置决定，不能从浏览器查询参数传入。
          payload = await readSessionTokenUsage({
            sessionId,
            allowInferred: false,
          })
          payload = publicUsagePayload(payload)
          // 对账：宿主侧读 DSH 的 tokenUsage 投影（客户端读的是同一份），两边都给出来
          const projected = readProjectedTokenUsage(deps.sessions, payload.sessionId, deps.sessionProjections)
          payload.projection = projected
          // match 只比**工作用量**：DSH 的 tokenUsage 投影不含 compaction/summary，
          // 而我们把压缩单列在 payload.compactionTokens —— 差额有明确解释时**不算不一致**。
          payload.match = projected === null || payload.ok !== true
            ? null
            : projected.uncachedInputTokens === payload.totals.uncachedInputTokens
              && projected.outputTokens === payload.totals.outputTokens
              && projected.cacheReadTokens === payload.totals.cacheReadTokens
              && projected.cacheWriteTokens === payload.totals.cacheWriteTokens
          payload.matchNote = payload.match === null
            ? null
            : (payload.match
              ? `与 DSH 投影逐桶一致；压缩开销 ${payload.compactionTokens ?? 0} 已单列（DSH 投影不含它），合计 ${payload.billedTokens ?? payload.totalTokens}`
              : `⚠ 与 DSH 投影逐桶不一致（投影 ${projected?.total ?? '?'} vs 日志工作用量 ${payload.totalTokens}）；压缩开销 ${payload.compactionTokens ?? 0} 单独计算，不参与本比较`)
        } catch (error) {
          payload = publicUsagePayload({ ok: false, sessionId: null, error: error instanceof Error ? error.message : String(error) })
        }
        res.statusCode = 200
        res.end(JSON.stringify(payload))
      },
    }),
  )

  //  顶部「CTF」视图：报告（本地 WP 列表，纯本地不请求平台）
  ctx.effect(() =>
    registerPanelRoute({
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
          const requestedSessionId = sessionIdFromRequest(req)
          await hydrateRequestSession(deps.session, requestedSessionId, deps)
          const knownSessions = typeof deps.session?.snapshot === 'function'
            ? deps.session.snapshot().filter((row) => row?.sessionId)
            : []
          let sessionContext = null
          if (requestedSessionId || knownSessions.length > 0) {
            const bound = resolveRequestSession(deps.session, req, { require: true })
            if (!bound.ok) {
              res.statusCode = 200
              res.end(JSON.stringify(publicReportsPayload({
                ok: false,
                generatedAt: new Date().toISOString(),
                sessionId: requestedSessionId || null,
                error: bound.error,
                writeups: [],
              })))
              return
            }
            sessionContext = bound.context
          }
          const boundConnKey = textValue(sessionContext?.connKey)
          res.end(JSON.stringify(publicReportsPayload(await buildReportsState({
            store,
            resolveAdapter,
            workDir,
            sessionContext,
            resolveArgs: boundConnKey ? { connection: boundConnKey } : {},
          }))))
        } catch (error) {
          res.statusCode = 200
          res.end(JSON.stringify(publicReportsPayload({ ok: false, generatedAt: new Date().toISOString(), error: publicErrorText(error), writeups: [] })))
        }
      },
    }),
  )

  //  顶部「CTF」视图：理论题**题目概要**（按需拉取，前端点按钮才请求）
  ctx.effect(() =>
    registerPanelRoute({
      kind: 'exact',
      path: THEORY_ROUTE,
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        let payload
        try {
          const requestedSessionId = sessionIdFromRequest(req)
          await hydrateRequestSession(deps.session, requestedSessionId, deps)
          const knownSessions = typeof deps.session?.snapshot === 'function'
            ? deps.session.snapshot().filter((row) => row?.sessionId)
            : []
          let sessionContext = null
          if (requestedSessionId || knownSessions.length > 0) {
            const bound = resolveRequestSession(deps.session, req, { require: true })
            if (!bound.ok) {
              res.statusCode = 200
              res.end(JSON.stringify({
                ok: false,
                generatedAt: new Date().toISOString(),
                testId: toChallengeId(url.searchParams.get('testId')),
                total: 0,
                answered: 0,
                questions: [],
                sessionId: requestedSessionId || null,
                error: bound.error,
              }))
              return
            }
            sessionContext = bound.context
          }
          const boundConnKey = textValue(sessionContext?.connKey)
          payload = await buildTheoryQuestionsState({
            resolveAdapter,
            testId: url.searchParams.get('testId'),
            limit: Number(url.searchParams.get('limit') ?? 100),
            sessionContext,
            resolveArgs: boundConnKey ? { connection: boundConnKey } : {},
          })
        } catch (error) {
          payload = { ok: false, generatedAt: new Date().toISOString(), testId: null, total: 0, answered: 0, questions: [], error: publicErrorText(error) }
        }
        if (payload && typeof payload.error === 'string') {
          payload = { ...payload, error: redactLocalPathText(payload.error) }
        }
        res.statusCode = 200
        res.end(JSON.stringify(payload))
      },
    }),
  )

  //  配置读写路由
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
          const clean = normalizeConfigPatch(patch)
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
    registerPanelRoute({
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
            if (!isSameOriginConfigRequest(req)) {
              res.statusCode = 403
              res.end(JSON.stringify({ ok: false, error: '拒绝跨站配置请求' }))
              return
            }
            const body = await readJsonBody(req)
            res.end(JSON.stringify(await configApi.write(body?.patch ?? body)))
            return
          }
          res.statusCode = 405
          res.setHeader('allow', 'GET, POST')
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        } catch (error) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: publicErrorText(error) }))
        }
      },
    }),
  )

  // 客户端回传探针：浏览器侧的脚本是否执行、slot 是否注册成功，宿主这侧看不到，
  // 只能让脚本自己打点回来（用 1x1 图片式 GET，避免 CORS/预检）。
  ctx.effect(() =>
    registerPanelRoute({
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
    registerPanelRoute({
      kind: 'exact',
      path: DIAG_ROUTE,
      handler: async (_req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        // 限流和面板缓存计数，供诊断路由查看。
        const safeDiag = {
          ...diag,
          lastTapError: redactLocalPathText(diag.lastTapError),
          beacons: Array.isArray(diag.beacons)
            ? diag.beacons.map((item) => ({ ...item, detail: redactLocalPathText(item?.detail) }))
            : [],
        }
        res.end(
          JSON.stringify(
            {
              ok: true,
              ...safeDiag,
              rateLimit: lingxuRateLimitStats(),
              panelCache: { ...panelCache.stats, ttlMs: panelCache.ttlMs, entries: panelCache.size() },
            },
            null,
            2,
          ),
        )
      },
    }),
  )

  // 自托管客户端 bundle（第三方 profile 插件不能依赖 client-modules 解析）
  //
  // ⚠️ 这里**不做一次性快照**：早期版本在启动时 readFileSync 一次就缓存，
  // 导致改了 lib/client.js 必须重启 DSH 才生效——开发时反复重启，用户也会
  // 误以为「重启了还是旧的」。改成按 mtime 失效缓存：文件没变就复用，变了就重读，
  // 于是改完客户端只需刷新页面（rev 也会跟着变，浏览器拿得到新 bundle）。
  const CLIENT_FILE = new URL('./client.js', import.meta.url)
  let bundleBytes = null
  let bundleMtimeMs = -1
  let bundleRev = 'none'

  function loadClientBundle() {
    try {
      const stat = statSync(CLIENT_FILE)
      if (bundleBytes !== null && stat.mtimeMs === bundleMtimeMs) return bundleBytes
      const next = readFileSync(CLIENT_FILE)
      bundleBytes = next
      bundleMtimeMs = stat.mtimeMs
      bundleRev = createHash('sha256').update(next).digest('hex').slice(0, 12)
      return bundleBytes
    } catch {
      return bundleBytes // 读失败就退回上次的（首次失败则 null）
    }
  }

  if (loadClientBundle() === null) {
    logger.warn('未找到 lib/client.js，Web 面板不可用（其余功能不受影响）')
    return
  }

  ctx.effect(() =>
    registerPanelRoute({
      kind: 'exact',
      path: CLIENT_ROUTE,
      handler: async (_req, res) => {
        diag.clientServed += 1
        const bytes = loadClientBundle()
        res.setHeader('content-type', 'text/javascript; charset=utf-8')
        res.setHeader('cache-control', 'no-cache')
        res.end(bytes ?? '')
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
 *  在 DSH 0.2.0-rc.1 上 `@deepseek-ai/dsh-client-modules` 的 `parseBootManifest`
 *  要求 `window.__DSH_BOOT__` 是**对象** `{rev, entries, batches}`，且每个 entry
 *  必须归属某个 initial-load batch；而 graph 行是按 **classic script** 加载并必须
 *  自行调用 `window.__ModuleLoader__.load({id, factory})`。以数组格式写入的
 *  graph 行在本版本是 **no-op**（`if (!Array.isArray(graph)) return html`），
 *  带顶层 `export` 的 ESM 作为 classic script 更是语法错误。
 *  ⇒ 用最直接的 module script 注入，版本无关且不会污染 boot manifest。
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
/**
 * 造一个「连接解析器」—— 从 store 与设置页配置里挑出这次要用的连接。
 *
 * 抽成工厂是为了**可测**：单测传入假 `createAdapter` 就能断言「解析到哪条连接」，
 * 只做本地解析，不发 HTTP。
 *
 * 优先级：**显式参数 > 设置页配置（有凭据）> 本地已存连接**，细节见 `pickConnection()`。
 */
export function createResolveAdapter({ store, config, rawConfig, createAdapter: factory = createAdapter, logger } = {}) {
  /**
   * 读「当前」设置页配置。
   *
   * ⚠️ **每次解析都重新读**：Cordis 的 config 可能是响应式对象 —— 用户在设置页改 eventId 时
   * 它会被**就地更新**（设置卡片标的是 `applies: live`）。若只读 apply 时的快照，
   * 「改了设置没生效」就会以另一种形式复现（要重启 DSH 才生效）。
   * rawConfig 读不到（Proxy 守卫/未传）时才退回 apply 时的归一化快照。
   */
  function settingsSnapshot() {
    const read = (field, fallback) => {
      try {
        // ⚠️ 必须 plainConfigValue 拆包！我们的 Config 字段全部是 `.volatile()` 包装的，
        // 直接读 rawConfig[field] 拿到的是**包装对象**而不是值 —— 后果是把
        // `[object Object]` 当成 baseUrl、把 `{}` 当成 eventId 去请求平台，
        // 否则切换赛事时会出现空白面板和过期倒计时。
        const value = plainConfigValue(rawConfig?.[field])
        if (value !== undefined && value !== null && value !== '') return value
      } catch {
        /* Proxy 守卫：退回快照 */
      }
      return fallback
    }
    return {
      baseUrl: read('baseUrl', config?.baseUrl),
      eventId: read('eventId', config?.eventId),
      cookie: read('cookie', config?.cookie),
      label: read('label', config?.label),
      timeoutMs: config?.timeoutMs,
    }
  }

  /**
   * 设置页配置 → 连接对象（`null` = 设置页没填平台/赛事）。
   *
   * ⚠️ **这里不看 Cookie 是否为空**（只看 baseUrl+eventId）：Cookie 是平台级凭据，
   * 由 `pickConnection` 的 withCookie 按「同 key → 设置页 → 同平台连接」补；
   * 设置页的 Cookie 还可能是**裸 sessionid 值**（实测 32 字符，无 `sessionid=` 前缀），
   * 由 `normalizeCookie` 补前缀。被脱敏成 `***` 的值不会被当成真值。
   */
  function settingsConnection() {
    const live = settingsSnapshot()
    // 只看「平台 + 赛事」：Cookie 为空也要认（Cookie 是平台级凭据，由 withCookie 从同平台连接补）
    if (!settingsHasPlatform(live)) return null
    const connection = {
      platform: 'lingxu',
      baseUrl: String(live.baseUrl).trim().replace(/\/+$/, ''),
      eventId: live.eventId,
      cookie: live.cookie,
      label: live.label || '插件配置',
      fromConfig: true,
    }
    connection.key = connectionKey(connection)
    return connection
  }

  return async function resolveAdapter(args = {}) {
    const requested = { key: args.connection, platform: args.platform, eventId: args.eventId, baseUrl: args.baseUrl }
    const wantsExplicit = Boolean(requested.key || requested.platform || requested.eventId != null || requested.baseUrl)
    const settings = settingsConnection()
    const stored = await store.getActiveConnection()
    const known = await store.listConnections()

    // 显式参数先让 store 做精确/部分匹配（老行为：只给 eventId 也能命中）
    const explicitMatch = wantsExplicit ? await store.resolveConnection(requested) : null
    const picked = pickConnection({
      requested: wantsExplicit ? requested : null,
      explicitMatch: explicitMatch ?? null,
      settings,
      stored: stored ?? null,
      getStoredByKey: (key) => known.find((item) => item.key === key) ?? null,
      // 同平台 Cookie 回退：Cookie 是平台级凭据，切赛事时 store 里常常只有旧赛事那条
      listStored: () => known,
    })

    if (!picked) {
      if (wantsExplicit) {
        throw new Error(
          [
            `未找到匹配的连接：${JSON.stringify(requested)}`,
            settings ? `设置页配置：${connectionKey(settings)}（eventId=${settings.eventId}）` : '设置页配置：未填写可用凭据',
            known.length ? `本地连接：${known.map((c) => c.key).join('、')}` : '本地连接：无',
            '提示：ctf_connect 可以新建/切换连接（会同步设置页）。',
          ].join('\n'),
        )
      }
      const hint = known.length
        ? `已配置的连接：${known.map((c) => `${c.key}${c.label ? `（${c.label}）` : ''}`).join('、')}`
        : '当前没有任何已配置的连接。'
      throw new Error(
        '未找到可用的平台连接。请在「设置 → 插件 → 插件配置 → 凌虚 CTF」里填好' +
          '平台地址、赛事 ID 与 Cookie；或在会话里调用 ctf_connect。' +
          hint,
      )
    }

    const connection = picked.connection
    const adapter = factory({ ...connection, timeoutMs: config?.timeoutMs })
    logger?.debug?.(
      `连接解析：${connection.key}（来源 ${picked.origin}，Cookie 来源 ${picked.cookieFrom}${
        picked.mismatch ? `，设置页与本地不一致` : ''
      }）`,
    )
    return { adapter, connection, connKey: connectionKey(connection) }
  }
}

export async function buildPanelState({ store, resolveAdapter, deps, config, sessionContext = null, resolveArgs = {} }) {
  const { adapter, connection, connKey } = await resolveAdapter(resolveArgs)
  // 面板自身也刷新「当前赛事」：用户改完设置页、没跑任何 ctf_* 工具就直接看面板时，
  // 活动连接可能还停在上一场，写入前先同步当前连接；旧 store 没有该方法时跳过。
  if (sessionContext === null) await store.noteActiveConnection?.(connKey)
  if (sessionContext && typeof sessionContext === 'object') {
    sessionContext.connKey = String(connKey ?? sessionContext.connKey ?? '')
    if (connection?.eventId !== undefined && connection?.eventId !== null) sessionContext.eventId = String(connection.eventId)
  }
  const [summary, challenges, leaderboard, submissions, work, theory] = await Promise.all([
    adapter.eventSummary().catch(() => ({})),
    adapter.challenges().catch(() => []),
    adapter
      .leaderboard('user', { size: 20 })
      .then((b) => b.rows)
      .catch(() => []),
    store.recentSubmissions(20, { connKey }).catch(() => []),
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
  // 「平台已满」：最近一次 ctf_start_env 撞到 env-limit（工具层写 envLimitHitAt，
  // 起环境成功时会清成 null）。它比本地计数**更可信**——本地只统计本插件起的环境，
  // 别的会话或用户手动在平台上起的实例我们看不见，于是会出现「本地 0/2、平台其实 2/2」。
  // 10 分钟窗口：平台随时可能被释放，太久以前的记录不该一直挂着吓人。
  let platformBlockedAt = null
  for (const w of work) {
    const at = w?.envLimitHitAt
    if (!at) continue
    const ms = Date.parse(String(at).replace(' ', 'T'))
    if (!Number.isFinite(ms)) continue
    if (nowMs - ms > 10 * 60 * 1000) continue
    if (platformBlockedAt === null || ms > Date.parse(String(platformBlockedAt).replace(' ', 'T'))) {
      platformBlockedAt = at
    }
  }
  const envLimit = Number.isFinite(Number(config?.envLimit)) && Number(config.envLimit) > 0
    ? Number(config.envLimit)
    : Number.isFinite(Number(observedLimit)) ? Number(observedLimit) : 2

  const solved = rows.filter((r) => r.solved).length
  const working = rows.filter((r) => r.status === 'working').length

  const nameById = new Map(challenges.map((c) => [String(c.id), c.name]))
  return {
    ok: true,
    configured: true,
    env: {
      limit: envLimit,
      held: envHeld,
      free: Math.max(0, envLimit - envHeld),
      // 平台侧已满（本地计数可能偏低，因为看不见别处起的实例）
      blocked: platformBlockedAt !== null,
      blockedAt: platformBlockedAt,
      // ⚠️ 语义澄清（UI 必须据此措辞，别把两者写进同一句）：
      //   held 只统计**本插件**通过 ctf_start_env 起的实例；blocked 是平台侧真实反馈。
      //   于是会出现 held=0 但 blocked=true —— 配额被别的会话/人工实例占着。
      heldScope: 'plugin',
      blockedReason: platformBlockedAt === null
        ? null
        : '平台环境配额已满：最近 10 分钟内 ctf_start_env 撞到过平台上限；'
          + '本插件的 0/2 只统计它自己起的实例，看不到其他会话或手工起的实例',
      blockedWindowSeconds: 600,
    },
    connection: {
      key: connKey,
      platform: connection.platform,
      baseUrl: connection.baseUrl,
      eventId: connection.eventId,
      label: connection.label ?? '',
      // 来源与差异，供面板解释当前赛事和 Cookie 的来源。
      origin: connection.origin ?? null,
      originText: connection.originText ?? null,
      cookieFrom: connection.cookieFrom ?? null,
      mismatch: connection.mismatch ?? null,
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
        // 提交答案也属于敏感结果；面板和题目详情统一只返回脱敏值。
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

/** 按需组装单题详情。题面可读，提交 flag 永远只返回脱敏值。 */
export async function buildChallengeDetailState({
  store,
  resolveAdapter,
  id,
  workDir,
  fs = fsp,
  sessionContext = null,
  resolveArgs = {},
} = {}) {
  const generatedAt = new Date().toISOString()
  const challengeId = toChallengeId(id)
  if (challengeId === null) return { ok: false, generatedAt, id: null, error: '缺少题目 id' }
  if (typeof resolveAdapter !== 'function') return { ok: false, generatedAt, id: challengeId, error: '插件缺少平台适配器' }
  try {
    const { adapter, connection, connKey } = await resolveAdapter(resolveArgs)
    const challenge = (await adapter.challengeDetail(challengeId)) || {}
    const work = typeof store?.getChallengeWork === 'function'
      ? await store.getChallengeWork(connKey, challengeId)
      : null
    const allSubmissions = typeof store?.recentSubmissions === 'function'
      ? await store.recentSubmissions(2000, { connKey })
      : []
    const submissions = allSubmissions
      .filter((row) => String(row?.challengeId) === String(challengeId))
      .slice()
      .reverse()
      .map((row) => ({
        at: row.at ?? null,
        status: row.status ?? 'unknown',
        flag: maskFlag(row.flag),
      }))
    const detail = {
      id: challenge.id ?? challengeId,
      name: challenge.name || work?.name || `题目 #${challengeId}`,
      category: challenge.category || work?.category || '未分类',
      score: challenge.score ?? work?.score ?? 0,
      solved: Boolean(challenge.solved ?? challenge.isSolved),
      taskType: challenge.taskType ?? work?.taskType ?? null,
      taskTypeLabel: challenge.taskTypeLabel ?? work?.taskTypeLabel ?? null,
      flagType: challenge.flagType ?? work?.flagType ?? null,
      answerMode: challenge.answerMode ?? work?.answerMode ?? null,
      requiresEnv: Boolean(challenge.requiresEnv ?? work?.requiresEnv),
      description: challenge.description ?? challenge.desc ?? '',
      connectionInfo: challenge.connectionInfo ?? work?.connectionInfo ?? '',
      externalLink: challenge.externalLink ?? challenge.url ?? '',
      attachment: challenge.attachment ?? '',
    }
    let writeup = { exists: false, path: null }
    const writeupPath = resolveWriteupPath(work, workDir)
    if (writeupPath && await isPathWithinWorkspace(fs, workDir, writeupPath)) {
      try {
        const stat = await fs.stat(writeupPath)
        if (stat.isFile()) writeup = { exists: true, path: toWorkspacePath(writeupPath, workDir) }
      } catch { /* 本地 WP 不存在时保持 exists=false */ }
    }
    return {
      ok: true,
      generatedAt,
      sessionId: sessionContext?.sessionId ?? null,
      connection: { key: connKey, platform: connection?.platform ?? 'lingxu', eventId: connection?.eventId ?? null },
      challenge: detail,
      work: work ? {
        status: work.status ?? null,
        owner: work.owner ?? work.teammate ?? work.prepTeammate ?? null,
        envRemainingSeconds: work.releaseTime ? Math.max(0, Math.round((Date.parse(String(work.releaseTime).replace(' ', 'T')) - Date.now()) / 1000)) : null,
        updatedAt: work.updatedAt ?? null,
      } : null,
      submissions,
      writeup,
    }
  } catch (error) {
    return { ok: false, generatedAt, id: challengeId, error: error instanceof Error ? error.message : String(error) }
  }
}

/** flag 在面板上脱敏显示。 */
export function maskFlag(flag) {
  const text = String(flag ?? '')
  if (!text) return ''
  if (text.length <= 8) return `${text.slice(0, 2)}${'*'.repeat(Math.max(0, text.length - 2))}`
  return `${text.slice(0, 6)}${'*'.repeat(Math.min(8, text.length - 8))}${text.slice(-2)}`
}

//  顶部「CTF」视图：团队数据

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
function emptyTeamPayload(generatedAt, error, sessionId = null) {
  return {
    ok: false,
    generatedAt,
    error,
    sessionId: sessionId || null,
    connection: { key: null, label: '' },
    members: [],
    tasks: [],
    messages: [],
    counts: { members: 0, running: 0, inactive: 0, tasksDone: 0, tasksInProgress: 0, tasksPending: 0, tasksTotal: 0 },
    runtime: { startedAt: null, elapsedSeconds: null, lastActivityAt: null, idleSeconds: null },
    tokenUsage: {
      available: false,
      reason: '本会话尚未取得 token 用量（客户端投影与 /lingxu-ctf/usage 都不可用）',
      sources: ['sessions.projectionValues.tokenUsage', USAGE_ROUTE],
    },
  }
}

/**
 * 组装 `GET /lingxu-ctf/team` 的响应（顶部「CTF」视图数据源）。
 *
 * 数据来源：
 * - `teams.listMembers(caller)` / `teams.listTasks(caller)`（`ctx.agentTeams`，caller 来自
 *  `orchestrator.getCaller()` —— HTTP 路由没有 `exec.agent`，只能用会话内捕获的 Lead 身份）；
 * - `store.listChallengeWork()` 里的 `teammate` / `taskId` / `subject` 映射（谁在做哪道题）；
 * - `store.listTeamMessages(connKey)`（协同消息）。
 *
 * 契约：**任何失败都返回 `ok:false` + `error`（HTTP 仍 200）**，不抛异常给路由层。
 * 时间戳：DSH 任务对象没有 `createdAt/updatedAt`，由编排层写进 work 记录，缺失时填 `null`。
 *
 * @param {{
 *  store?: object,
 *  teams?: object,
 *  caller?: unknown,
 *  sessionContext?: { sessionId?: string, caller?: unknown, connKey?: string, eventId?: string },
 *  resolveAdapter?: (args: object) => Promise<object>,
 *  now?: () => number,
 *  messagesLimit?: number,
 * }} deps
 */
export async function buildTeamState({
  store,
  teams,
  caller,
  sessionContext = null,
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

  // 连接信息。绑定了会话上下文时只使用该上下文的 connKey；不能退回全局活动连接，
  // 否则两个会话切换赛事时会把协同消息串到一起。未绑定上下文的旧直接调用仍保留旧行为。
  let connKey = null
  let connLabel = ''
  const hasBoundConnection = sessionContext !== null && sessionContext !== undefined
  if (hasBoundConnection) {
    const boundKey = textValue(sessionContext?.connKey)
    connKey = boundKey || 'unknown'
  } else if (typeof resolveAdapter === 'function') {
    try {
      const platform = await resolveAdapter({})
      connKey = platform?.connKey ?? connectionKey(platform?.connection ?? {})
      connLabel = String(platform?.connection?.label ?? '')
    } catch {
      /* 未配置连接：团队成员/任务板仍应可见 */
    }
  }
  if (!hasBoundConnection && connKey === null) {
    try {
      const active = typeof store?.getActiveConnKey === 'function'
        ? await store.getActiveConnKey()
        : (store?.state?.activeConnKey ?? store?.state?.activeConnection)
      if (typeof active === 'string' && active !== '') connKey = active
    } catch {
      /* store 不可读时保持无连接 */
    }
  }

  // work 记录：把 teammate / taskId 映射到题目（taskId 在同一团队内唯一，跨连接取也无歧义）
  let work = []
  try {
    if (typeof store?.listChallengeWork === 'function') {
      const rows = await store.listChallengeWork(hasBoundConnection ? connKey : undefined)
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
      // 没有可确认的连接时只读 unknown 队列，不能把所有赛事的消息混在一起。
      const rows = await store.listTeamMessages(connKey ?? 'unknown', limit)
      messages = (Array.isArray(rows) ? rows : [])
        .slice()
        .reverse()
        .map((message) => ({
          at: String(message?.at ?? ''),
          from: String(message?.from ?? ''),
          to: String(message?.to ?? ''),
          kind: String(message?.kind ?? ''),
          text: String(message?.text ?? ''),
          // 保存来源标识、消息 ID 和关联题目。
          messageId: String(message?.messageId ?? ''),
          challengeId: message?.challengeId === null || message?.challengeId === undefined ? null : Number(message.challengeId),
        }))
    }
  } catch {
    messages = []
  }

  //  活动时间线：显示 agent 当前任务和最近活动时间。
  // 现有数据源能给出的最细粒度：
  //   · store 的 work 记录 updatedAt（工具写入进度时的时间戳，逐题）
  //   · 团队消息 at（ctf_solve_* 落盘的协同消息）
  //   · 任务板 createdAt / updatedAt（Agent Teams 的共享任务）
  // ⚠️ DSH 不向插件暴露「agent 最近一次工具调用」——那是会话日志里的东西，
  //    所以 currentAction 只能由上面三者推断；缺失时如实写「暂无活动记录」。
  const parseMs = (value) => {
    const ms = toEpochMs(value)
    return Number.isFinite(ms) ? ms : null
  }
  let nowMs
  try {
    nowMs = Number(now())
  } catch {
    nowMs = Date.now()
  }
  if (!Number.isFinite(nowMs)) nowMs = Date.now()
  const activity = new Map()
  const touch = (name, ms, action) => {
    if (!name || ms === null) return
    const prev = activity.get(name)
    if (!prev || ms >= prev.at) activity.set(name, { at: ms, action })
  }
  for (const record of work) {
    touch(
      record?.teammate ? String(record.teammate) : null,
      parseMs(record?.updatedAt),
      record?.subject ? `最后进度：${parseTaskSubject(record.subject).name ?? record.subject}` : '更新了解题进度',
    )
  }
  for (const task of tasks) {
    const owner = task?.owner ? String(task.owner) : null
    const ms = task?.updatedAt ?? task?.createdAt ?? null
    const label = task?.subject ? String(task.subject) : '共享任务'
    touch(owner, ms, task?.status === 'completed' ? `完成任务：${label}` : `任务进行中：${label}`)
  }
  for (const message of messages) {
    const ms = parseMs(message?.at)
    const text = String(message?.text ?? '')
    const short = text.length > 40 ? `${text.slice(0, 39)}…` : text
    touch(String(message?.from ?? ''), ms, short ? `发送消息：${short}` : '发送了消息')
    touch(String(message?.to ?? ''), ms, short ? `收到消息：${short}` : '收到消息')
  }

  const enrichedMembers = members.map((member) => {
    const hit = activity.get(member.name) ?? null
    const lastActivityAt = hit ? new Date(hit.at).toISOString() : null
    const staleSeconds = hit ? Math.max(0, Math.round((nowMs - hit.at) / 1000)) : null
    // 正在解哪道题 > 最近动作 > 无记录
    const currentAction = member.challengeName
      ? `正在解「${member.challengeName}」`
      : (hit?.action ?? '暂无活动记录')
    return { ...member, lastActivityAt, staleSeconds, currentAction }
  })

  const allMs = [
    ...activity.values(),
  ].map((item) => item.at)
  const taskCreated = tasks.map((task) => parseMs(task.createdAt)).filter((ms) => ms !== null)
  const startedCandidates = [...allMs, ...taskCreated]
  const startedAtMs = startedCandidates.length > 0 ? Math.min(...startedCandidates) : null
  const lastActivityMs = allMs.length > 0 ? Math.max(...allMs) : null
  const runtime = {
    startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
    elapsedSeconds: startedAtMs === null ? null : Math.max(0, Math.round((nowMs - startedAtMs) / 1000)),
    lastActivityAt: lastActivityMs === null ? null : new Date(lastActivityMs).toISOString(),
    idleSeconds: lastActivityMs === null ? null : Math.max(0, Math.round((nowMs - lastActivityMs) / 1000)),
  }

  return {
    ok: true,
    generatedAt,
    connection: { key: connKey, label: connLabel },
    members: enrichedMembers,
    tasks,
    messages,
    runtime,
    // token 用量：**DSH 没有向插件暴露累计用量**（usage 只出现在单次 LLM 请求的流结果
    // 与当前会话日志的 usage chunk 里，插件侧拿不到聚合值）。如实标注，不编造数字。
    // token 用量同时尝试日志和宿主投影两条数据源：
    //   ① 客户端读会话行的 projectionValues.tokenUsage（DSH 统计药丸用的同一个投影）
    //   ② GET /lingxu-ctf/usage?session=<id>（宿主折叠会话日志，附带对账）
    // 本字段只作为「客户端两条都失败」时的兜底说明，不再是「DSH 没暴露」。
    tokenUsage: {
      available: false,
      reason: '本会话尚未取得 token 用量：客户端投影与 /lingxu-ctf/usage 都不可用时会显示此提示',
      sources: ['sessions.projectionValues.tokenUsage', USAGE_ROUTE],
    },
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

//
// 会话 token 用量
//
// 日志格式：`session.v4.jsonl.zstd` = **多个独立 zstd 帧**顺序追加，每帧内含若干 JSONL 行。
// 分帧扫描移植自 DSH 自己的 `dsh-session-persistence-jsonl`（magic / 描述符 / 块头 / 校验和），
// 必须逐帧解压——用 `zstdDecompressSync` 直接解整个文件只能拿到第一帧（实测 63 KB 只出 273 字节）。
//

/** zstd 帧魔数（小端读出的 uint32）。 */
export const ZSTD_FRAME_MAGIC = 0xfd2fb528

/**
 * 扫描连续的 zstd 帧边界（移植自 dsh-session-persistence-jsonl 的 scanZstdFrames）。
 * 末尾不完整的帧不返回，并通过 `tornStart` 告知调用方（下次追加后再读）。
 *
 * @param {Buffer} buffer
 * @returns {{ frames: Array<{start: number, end: number}>, tornStart?: number }}
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_FRAME_MAGIC) return { frames, tornStart: start }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, tornStart: start }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, tornStart: start }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 取事件里的 provider 用量样本（与 DSH tokenMeter 的 `usageOf` 同语义）。 */
export function usageSampleOf(event) {
  if (!event || typeof event !== 'object') return undefined
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = event.data?.stream
  const chunks = Array.isArray(stream?.chunks) ? stream.chunks : (Array.isArray(stream) ? stream : null)
  if (chunks === null) return undefined
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (chunks[index]?.type === 'usage') return chunks[index].usage
  }
  return undefined
}

/** 单个用量样本 → DSH 的四个桶（`inputTokens` 即未缓存输入）。 */
export function usageBuckets(sample) {
  const tokenCount = (value) => {
    const count = Number(value ?? 0)
    return Number.isFinite(count) ? Math.max(0, count) : 0
  }
  return {
    uncachedInputTokens: tokenCount(sample?.inputTokens),
    outputTokens: tokenCount(sample?.outputTokens),
    cacheReadTokens: tokenCount(sample?.cacheReadTokens),
    cacheWriteTokens: tokenCount(sample?.cacheWriteTokens),
  }
}

/**
 * 按 **DSH `tokenUsage` 投影**的语义折叠事件流（与 dsh-token-meter 的
 * `tokenUsageProjectionDefinition.apply` 逐条对齐）：
 * - 同一 `(turn, step)` 的后续样本**替换**前一个（不是累加）——
 *  `assistant/attempt` 与 `assistant/message` 常常是同一 step 的两次上报，直接相加会翻倍；
 * - `llm/retry-started` 关闭替换槽：重试后的新样本重新累加。
 *
 * @param {Array<object>} events
 * @returns {{ uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }}
 */
export function foldTokenUsage(events) {
  return foldUsageEvents(events).totals
}

const EMPTY_USAGE_BUCKETS = Object.freeze({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

function usageIdentityOf(event) {
  const data = event?.data ?? {}
  return {
    turn: data.turn ?? event?.turn ?? null,
    step: data.step ?? event?.step ?? null,
  }
}

function usageIdentityKey(turn, step) {
  if (turn === null && step === null) return null
  return JSON.stringify([turn, step])
}

function usageBucketsEqual(left, right) {
  return left?.uncachedInputTokens === right?.uncachedInputTokens
    && left?.outputTokens === right?.outputTokens
    && left?.cacheReadTokens === right?.cacheReadTokens
    && left?.cacheWriteTokens === right?.cacheWriteTokens
}

function safeUsageBuckets(value) {
  const source = value && typeof value === 'object' ? value : EMPTY_USAGE_BUCKETS
  return {
    uncachedInputTokens: Number.isFinite(Number(source.uncachedInputTokens)) ? Math.max(0, Number(source.uncachedInputTokens)) : 0,
    outputTokens: Number.isFinite(Number(source.outputTokens)) ? Math.max(0, Number(source.outputTokens)) : 0,
    cacheReadTokens: Number.isFinite(Number(source.cacheReadTokens)) ? Math.max(0, Number(source.cacheReadTokens)) : 0,
    cacheWriteTokens: Number.isFinite(Number(source.cacheWriteTokens)) ? Math.max(0, Number(source.cacheWriteTokens)) : 0,
  }
}

function usageSlotMapOf(value) {
  const slots = Object.create(null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return slots
  for (const [key, buckets] of Object.entries(value)) slots[key] = safeUsageBuckets(buckets)
  return slots
}

function retryGenerationMapOf(value) {
  const generations = Object.create(null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return generations
  for (const [key, generation] of Object.entries(value)) {
    const n = Number(generation)
    if (Number.isFinite(n) && n >= 0) generations[key] = Math.trunc(n)
  }
  return generations
}

/**
 * 用 Map 语义维护所有 `(turn, step, retry)` 槽位。
 *
 * 日志事件并不保证一个 step 的样本连续出现：step 1、step 2、step 1
 * 的交错顺序很常见。单独保存 `last` 会把 step 1 的第二个样本误当成新请求；
 * 这里按身份替换，并为每次 retry 增加 generation。没有身份的样本没有可安全
 * 替换的依据，按独立事件计入，避免静默吞掉真实消耗。
 */
function foldUsageEvents(events, prior = {}) {
  const totals = {
    uncachedInputTokens: Number(prior?.totals?.uncachedInputTokens) || 0,
    outputTokens: Number(prior?.totals?.outputTokens) || 0,
    cacheReadTokens: Number(prior?.totals?.cacheReadTokens) || 0,
    cacheWriteTokens: Number(prior?.totals?.cacheWriteTokens) || 0,
  }
  const slots = usageSlotMapOf(prior?.usageSlots)
  const retryGenerations = retryGenerationMapOf(prior?.retryGenerations)
  let nextAnonymousSlot = Number.isFinite(Number(prior?.nextAnonymousSlot))
    ? Math.max(0, Math.trunc(Number(prior.nextAnonymousSlot)))
    : 0

  // 兼容当前进程在热更新前留下的旧缓存槽位。
  if (Object.keys(slots).length === 0 && prior?.last?.buckets) {
    const identity = usageIdentityKey(prior.last.turn ?? null, prior.last.step ?? null)
    if (identity !== null) slots[`${identity}#0`] = safeUsageBuckets(prior.last.buckets)
  }

  const add = (buckets, previous = EMPTY_USAGE_BUCKETS) => {
    totals.uncachedInputTokens += buckets.uncachedInputTokens - previous.uncachedInputTokens
    totals.outputTokens += buckets.outputTokens - previous.outputTokens
    totals.cacheReadTokens += buckets.cacheReadTokens - previous.cacheReadTokens
    totals.cacheWriteTokens += buckets.cacheWriteTokens - previous.cacheWriteTokens
  }

  for (const event of Array.isArray(events) ? events : []) {
    const { turn, step } = usageIdentityOf(event)
    const identity = usageIdentityKey(turn, step)
    if (event?.type === 'llm/retry-started') {
      if (identity !== null) retryGenerations[identity] = (retryGenerations[identity] ?? 0) + 1
      continue
    }
    if (event?.type !== 'assistant/message' && event?.type !== 'assistant/attempt') continue
    const sample = usageSampleOf(event)
    if (sample === undefined || sample === null) continue
    const buckets = safeUsageBuckets(usageBuckets(sample))
    const slotKey = identity === null
      ? `anonymous#${nextAnonymousSlot++}`
      : `${identity}#${retryGenerations[identity] ?? 0}`
    const previous = slots[slotKey]
    if (previous && usageBucketsEqual(previous, buckets)) continue
    add(buckets, previous)
    slots[slotKey] = buckets
  }

  return {
    totals,
    usageSlots: slots,
    retryGenerations,
    nextAnonymousSlot,
  }
}

/**
 * 折叠**上下文压缩**的用量（\`compaction/summary\` 事件）。
 *
 * 这些 token 是真实花掉的（一次压缩可达 30 万+，见实测），但 DSH 的 \`tokenUsage\` 投影
 * **不含**它（投影只看 assistant 事件）。所以我们把它**单独算出来并列展示**，
 * 既不和 DSH 数字打架，也不隐瞒真实花费。
 */
export function foldCompactionUsage(events) {
  const totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let count = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'compaction/summary') continue
    const sample = event.data?.usage
    if (sample === null || sample === undefined) continue
    const buckets = usageBuckets(sample)
    totals.uncachedInputTokens += buckets.uncachedInputTokens
    totals.outputTokens += buckets.outputTokens
    totals.cacheReadTokens += buckets.cacheReadTokens
    totals.cacheWriteTokens += buckets.cacheWriteTokens
    count += 1
  }
  return {
    totals,
    count,
    total: totals.uncachedInputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
  }
}

/** 会话日志根目录（DSH 默认 \`~/.dsh/sessions\`，按工作区再分子目录）。 */
export function defaultSessionsRoot() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'sessions')
}

/** 在 `<root>/<workspace>/<sessionId>/session.v4.jsonl.zstd` 里定位日志文件。 */
export async function resolveSessionLogPath(sessionId, root, fs = fsp) {
  const id = String(sessionId ?? '').trim()
  // session id 来自 HTTP 查询参数或宿主事件，Windows 下反斜杠同样是路径分隔符；
  // 过长或带控制字符的值也不应进入文件系统探测。
  if (id === '' || id.length > 256 || id.includes('..') || /[\\/\u0000-\u001f]/.test(id)) return null
  const base = root || defaultSessionsRoot()
  let workspaces = []
  try {
    workspaces = await fs.readdir(base)
  } catch {
    return null
  }
  for (const workspace of workspaces) {
    for (const candidate of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd']) {
      const file = path.join(base, workspace, id, candidate)
      try {
        const stat = await fs.stat(file)
        if (stat.isFile()) return file
      } catch {
        /* 换下一个候选 */
      }
    }
  }
  return null
}

/**
 * 兜底：`sessionId` 拿不到时（老宿主没有 sessions 服务），取**最近写入**的会话日志。
 * 当前正在对话的会话几乎总是最后被写入的那个；返回值带 `inferred: true`，UI 会如实标注。
 */
export async function resolveLatestSessionLogPath(root, fs = fsp) {
  const base = root || defaultSessionsRoot()
  let workspaces = []
  try {
    workspaces = await fs.readdir(base)
  } catch {
    return null
  }
  let best = null
  for (const workspace of workspaces) {
    let sessions = []
    try {
      sessions = await fs.readdir(path.join(base, workspace))
    } catch {
      continue
    }
    for (const sessionId of sessions) {
      for (const candidate of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const file = path.join(base, workspace, sessionId, candidate)
        try {
          const stat = await fs.stat(file)
          if (!stat.isFile()) continue
          const mtime = Number(stat.mtimeMs ?? 0)
          if (best === null || mtime > best.mtime) best = { file, sessionId, mtime }
        } catch {
          /* 跳过 */
        }
      }
    }
  }
  return best
}

/** 会话内已处理到的字节偏移缓存：轮询时只解新追加的帧。 */
const sessionUsageCache = new Map()

/** 只解析 JSONL，撕裂行跳过。 */
function parseLogLines(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* 撕裂行：忽略 */
    }
  }
  return events
}

/**
 * 读某个会话的**累计 token 用量**（只读日志，不请求平台、不碰会话状态）。
 *
 * ## 数字口径（⚠️ 2026-09 lead 复核后的准确说法）
 * - `totals` / `totalTokens`：**只算 \`assistant/message\` 与 \`assistant/attempt\`** 的 provider
 *  usage，与 DSH 的 \`tokenUsageProjectionDefinition\`（会话投影 \`tokenUsage\`）**逐桶对齐**，
 *  也就是 DSH 界面统计药丸显示的那个数。
 *  ⚠️ 它**不等于**「把日志里所有 usage 加起来」——差额来自 \`compaction/summary\`（上下文压缩）。
 * - `compaction` / \`compactionTokens\`：上下文压缩那次请求自己花掉的 token（真实花费，**单列**）。
 * - `billedTokens` = \`totalTokens\` + \`compactionTokens\`：这一会话**真实消耗**的合计。
 *
 * ## sessionId 与降级（调试必读）
 * - 传了 \`sessionId\` 且日志存在 → 读它的日志（\`inferred: false\`）。
 * - 默认兼容模式下，传了但找不到对应目录（常见于传进来的是 `exec.agent` 这类 agent id），
 *  或没传，会退化为最近写入的会话日志，并返回 `inferred: true`。
 * - `allowInferred: false` 用于普通 HTTP 路由：缺失/不存在的 session 直接失败，绝不猜最近日志。
 * - 插件运行时里正常路径是客户端把 \`sessions\` 快照里的当前会话 id 传进来，不会走降级。
 *
 * 增量策略：文件按帧追加，缓存 `processedBytes` + 已折叠结果，轮询只解码新帧；
 * 末尾撕裂帧不推进偏移，下次重读。
 *
 * @param {{ sessionId?: string, sessionsRoot?: string, fs?: object, force?: boolean, allowInferred?: boolean }} deps
 */
export async function readSessionTokenUsage({ sessionId, sessionsRoot, fs = fsp, force = false, allowInferred = true } = {}) {
  let id = String(sessionId ?? '').trim()
  let inferred = false
  let file = null
  if (id === '') {
    if (allowInferred !== true) {
      return { ok: false, sessionId: null, inferred: false, error: '请求未绑定 sessionId；普通 HTTP 请求不会读取最近会话日志' }
    }
    // 客户端拿不到 sessions 服务（老宿主）时退化为「最近写入的会话日志」
    const latest = await resolveLatestSessionLogPath(sessionsRoot, fs)
    if (latest === null) {
      return { ok: false, sessionId: null, error: `未指定 session 且找不到任何会话日志（目录 ${sessionsRoot || defaultSessionsRoot()}）` }
    }
    id = String(latest.sessionId ?? '')
    file = latest.file
    inferred = true
  } else {
    file = await resolveSessionLogPath(id, sessionsRoot, fs)
  }
  const requestedSessionId = id
  if (file === null || file === undefined) {
    if (allowInferred !== true) {
      return {
        ok: false,
        sessionId: requestedSessionId,
        requestedSessionId,
        inferred: false,
        error: `找不到指定会话日志（在 ${sessionsRoot || defaultSessionsRoot()} 下按 workspace 查找 ${requestedSessionId}/session.v4.jsonl.zstd）`,
      }
    }
    // 兼容旧调用方：给的 id 不是会话目录名（例如 exec.agent 是 agent id 而非 session id）
    // 时才退化到最近会话，并在响应里标明 requestedSessionId。
    const latest = await resolveLatestSessionLogPath(sessionsRoot, fs)
    if (latest === null) {
      return { ok: false, sessionId: id, error: `找不到会话日志（在 ${sessionsRoot || defaultSessionsRoot()} 下按 workspace 查找 ${id}/session.v4.jsonl.zstd）` }
    }
    id = String(latest.sessionId ?? '')
    file = latest.file
    inferred = true
  }
  let stat
  try {
    stat = await fs.stat(file)
  } catch (error) {
    return { ok: false, sessionId: id, file, inferred, error: `读取会话日志失败：${error?.message ?? error}` }
  }

  const cached = sessionUsageCache.get(file)
  const replaced = cached !== undefined
    && (
      (stat.ino !== undefined && cached.ino !== undefined && stat.ino !== cached.ino)
      || (
        stat.size === cached.size
        && Number.isFinite(stat.mtimeMs)
        && Number.isFinite(cached.mtimeMs)
        && stat.mtimeMs !== cached.mtimeMs
      )
    )
  const from = cached && !force && !replaced && cached.size <= stat.size ? cached.processedBytes : 0
  const state = from > 0 && cached
    ? cached
    : {
      size: 0,
      processedBytes: 0,
      totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usageSlots: {},
      retryGenerations: {},
      nextAnonymousSlot: 0,
      compaction: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      compactionCount: 0,
      compactionTokens: 0,
      billedTokens: 0,
      events: 0,
      steps: 0,
      attempts: 0,
      firstAt: null,
      lastAt: null,
      parseErrors: 0,
    }

  try {
    const buffer = await fs.readFile(file)
    // 明文 JSONL（未压缩）也支持。明文文件很小且没有帧边界，轮询时重读整文件，
    // 避免把半行 UTF-8 或半行 JSON 当成完整事件。
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_FRAME_MAGIC) {
      const events = parseLogLines(buffer.toString('utf8'))
      const totals = foldTokenUsage(events)
      const result = summarizeUsageEvents(events, totals, foldCompactionUsage(events))
      sessionUsageCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, processedBytes: buffer.length, ...result })
      return { ok: true, sessionId: id, requestedSessionId: inferred && requestedSessionId !== id ? requestedSessionId : null, file, inferred, ...publicUsageResult(result) }
    } else {
      const slice = buffer.subarray(from)
      const { frames, tornStart } = scanZstdFrames(slice)
      let text = ''
      for (const frame of frames) {
        text += zstdDecompressSync(slice.subarray(frame.start, frame.end)).toString('utf8')
      }
      const events = parseLogLines(text)
      // 逐帧折叠：保持替换槽语义（用 events 顺序即可，因为同 step 的样本必然相邻帧内有序）
      const merged = mergeUsageFold(state, events, foldCompactionUsage(events))
      const consumed = tornStart === undefined ? buffer.length : from + tornStart
      const result = { ...merged, processedBytes: consumed, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }
      sessionUsageCache.set(file, result)
      return { ok: true, sessionId: id, requestedSessionId: inferred && requestedSessionId !== id ? requestedSessionId : null, file, inferred, ...publicUsageResult(result) }
    }
  } catch (error) {
    return { ok: false, sessionId: id, file, inferred, error: `解析会话日志失败：${error?.message ?? error}` }
  }
  return { ok: false, sessionId: id, file, inferred, error: '会话日志为空' }
}

/** 从事件流里统计 steps / 时间范围（与用量一起返回）。 */
function summarizeUsageEvents(events, totals, compaction = { totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, count: 0, total: 0 }) {
  let steps = 0
  let attempts = 0
  let firstAt = null
  let lastAt = null
  for (const event of events) {
    if (event?.type === 'step/start') steps += 1
    if (event?.type === 'assistant/message' || event?.type === 'assistant/attempt') attempts += 1
    const time = Number(event?.time)
    if (Number.isFinite(time)) {
      if (firstAt === null || time < firstAt) firstAt = time
      if (lastAt === null || time > lastAt) lastAt = time
    }
  }
  const totalTokens = totals.uncachedInputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  return {
    totals,
    totalTokens,
    // 压缩开销单列；billedTokens = 工作 + 压缩（真实花费）
    compaction: compaction.totals,
    compactionCount: compaction.count,
    compactionTokens: compaction.total,
    billedTokens: totalTokens + compaction.total,
    events: events.length,
    steps,
    attempts,
    firstAt: firstAt === null ? null : new Date(firstAt).toISOString(),
    lastAt: lastAt === null ? null : new Date(lastAt).toISOString(),
  }
}

/** 删除增量折叠的内部槽位，避免 HTTP 响应暴露实现细节。 */
function publicUsageResult(result) {
  if (!result || typeof result !== 'object') return result
  const { usageSlots, retryGenerations, nextAnonymousSlot, last, ...publicResult } = result
  return publicResult
}

/**
 * 增量折叠：把新解出的事件接到已有槽位上；槽位按 `(turn, step, retry)` 保存，
 * 因此交错 step 和跨帧追加都不会把旧样本重复计入。
 */
function mergeUsageFold(state, events, compaction = { totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, count: 0, total: 0 }) {
  const folded = foldUsageEvents(events, state)
  const totals = folded.totals
  const compTotals = { ...(state.compaction ?? EMPTY_USAGE_BUCKETS) }
  const compactionCount = (state.compactionCount ?? 0) + compaction.count
  const compactionTokens = (state.compactionTokens ?? 0) + compaction.total
  for (const key of Object.keys(compTotals)) compTotals[key] += compaction.totals[key] ?? 0
  let steps = state.steps ?? 0
  let attempts = state.attempts ?? 0
  let firstAt = state.firstAt ?? null
  let lastAt = state.lastAt ?? null
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'step/start') steps += 1
    if (event?.type === 'assistant/message' || event?.type === 'assistant/attempt') attempts += 1
    const time = Number(event?.time)
    if (Number.isFinite(time)) {
      const iso = new Date(time).toISOString()
      if (firstAt === null || iso < firstAt) firstAt = iso
      if (lastAt === null || iso > lastAt) lastAt = iso
    }
  }
  const totalTokens = totals.uncachedInputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  return {
    totals,
    totalTokens,
    usageSlots: folded.usageSlots,
    retryGenerations: folded.retryGenerations,
    nextAnonymousSlot: folded.nextAnonymousSlot,
    compaction: compTotals,
    compactionCount,
    compactionTokens,
    billedTokens: totalTokens + compactionTokens,
    events: (state.events ?? 0) + (Array.isArray(events) ? events.length : 0),
    steps,
    attempts,
    firstAt,
    lastAt,
  }
}

/**
 * 读 DSH 会话的 `tokenUsage` 投影（与客户端统计药丸同源）。
 *
 * 客户端的 sessions 服务提供 `list.getSnapshot()`；宿主则通过
 * `sessionProjections.snapshot(session)` 提供同一份视图。两种形状都支持，
 * 缺少任一服务时返回 null，不猜数字。
 *
 * @param {object} sessions - sessions 服务（可选）
 * @param {string} sessionId
 * @param {object} projections - sessionProjections 服务（可选）
 */
export function readProjectedTokenUsage(sessions, sessionId, projections) {
  const id = String(sessionId ?? '')
  if (id === '' || sessions === null || sessions === undefined) return null
  try {
    let usage
    const list = sessions.list
    if (list && typeof list.getSnapshot === 'function') {
      const snapshot = list.getSnapshot()
      usage = snapshot?.byId?.[id]?.projectionValues?.tokenUsage
    } else if (typeof list === 'function') {
      const snapshot = list.call(sessions)
      usage = snapshot?.byId?.[id]?.projectionValues?.tokenUsage
      if (usage === undefined && Array.isArray(snapshot) && projectionReaderAvailable(projections)) {
        const session = snapshot.find((item) => String(item?.id ?? '') === id)
        if (session) usage = projectionUsageOf(projections, session)
      }
    } else if (sessions.list?.byId) {
      usage = sessions.list.byId[id]?.projectionValues?.tokenUsage
    } else {
      usage = sessions?.byId?.[id]?.projectionValues?.tokenUsage
    }

    if (usage === undefined && typeof sessions.get === 'function' && projectionReaderAvailable(projections)) {
      const session = sessions.get(id)
      if (session) usage = projectionUsageOf(projections, session)
    }
    return normalizeProjectedUsage(usage)
  } catch {
    return null
  }
}

function projectionUsageOf(projections, session) {
  try {
    if (typeof projections?.snapshot === 'function') {
      const snapshot = projections.snapshot(session, ['tokenUsage'])
      const value = snapshot?.values?.tokenUsage
      if (value !== undefined) return value?.totals ?? value
    }
    const state = typeof projections.stateOf === 'function'
      ? projections.stateOf(session, 'tokenUsage')
      : undefined
    return state?.totals ?? state
  } catch {
    return undefined
  }
}

function projectionReaderAvailable(projections) {
  return typeof projections?.snapshot === 'function' || typeof projections?.stateOf === 'function'
}

function normalizeProjectedUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const buckets = {
    uncachedInputTokens: Number(usage.uncachedInputTokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? 0),
    cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
  }
  if (Object.values(buckets).some((value) => !Number.isFinite(value) || value < 0)) return null
  const total = Object.values(buckets).reduce((sum, value) => sum + value, 0)
  return total > 0 ? { ...buckets, total } : null
}

/** 钩子用的连接 key：只读 store，不触发平台请求。 */
async function connectionKeyForHook(store) {
  try {
    if (typeof store?.getActiveConnKey === 'function') {
      const loaded = await store.getActiveConnKey()
      if (typeof loaded === 'string' && loaded !== '') return loaded
    }
    const active = store?.state?.activeConnKey ?? store?.state?.activeConnection
    return typeof active === 'string' && active !== '' ? active : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 从 DSH agent/session 引用中取稳定的会话 id。 */
function sessionIdOf(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return ''
  for (const candidate of [
    value.sessionId,
    value.id,
    value.session?.id,
    value.session?.header?.id,
    value.header?.id,
  ]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return ''
}

/**
 * 会话 → 收件人显示名（拿不到名字就退化为短 id，**不编名字**）。
 *
 * 解析顺序：
 * 1. `session.name`（DSH 给 teammate 的 Agent 名，最直接）；
 * 2. `teams.listMembers(caller)` 里按 `id` 匹配（caller 取编排器捕获的 Lead）；
 * 3. 退化为短会话 id —— 这时视图会显示「…abc12345」，是**如实**的，不是猜的名字。
 */
function resolveMemberLabel(teams, session, caller) {
  const id = String(session?.id ?? session?.agentId ?? '')
  const direct = String(session?.name ?? '')
  if (direct !== '') return direct
  try {
    if (caller && typeof teams?.listMembers === 'function') {
      const rows = teams.listMembers(caller)
      const hit = (Array.isArray(rows) ? rows : []).find((row) => String(row?.id ?? '') === id)
      if (hit && typeof hit.name === 'string' && hit.name !== '') return hit.name
    }
  } catch { /* 退化为 id */ }
  return id === '' ? 'team' : (id.length > 12 ? `…${id.slice(-8)}` : id)
}

/** 单份 WP 的正文预览上限（字符）：够看清结构，又不会把轮询响应撑大。 */
export const WRITEUP_PREVIEW_CHARS = 4000

/**
 * 读 WP 正文预览。失败**不抛**（列表里少一段正文，好过整个 /reports 挂掉）。
 * @returns {Promise<{bodyPreview: string, bodyChars: number}>}
 */
async function readWriteupPreview(fs, absPath, stat) {
  const empty = { bodyPreview: '', bodyChars: 0 }
  try {
    const text = await fs.readFile(absPath, 'utf8')
    const body = typeof text === 'string' ? text : String(text ?? '')
    return { bodyPreview: body.slice(0, WRITEUP_PREVIEW_CHARS), bodyChars: body.length }
  } catch {
    return { ...empty, bodyChars: Number(stat?.size ?? 0) }
  }
}

/**
 * 组装 `GET /lingxu-ctf/theory` 的响应：**题目概要**（题干摘要 / 题型 / 是否已答）。
 *
 * 为什么单独一条路由、且由前端按需调用：
 * - 100 道题的完整题面很大，轮询里自动拉会拖慢面板、也浪费平台配额；
 * - 所以只回摘要（每条 ~100 字符），点「加载题目概要」时才请求一次。
 *
 * 平台不可用 / 未配置时返回 `ok:false` + `error`（HTTP 200），前端显示可读提示。
 *
 * @param {{ resolveAdapter?: Function, testId?: (string|number), limit?: number, summarize?: Function }} deps
 */
export async function buildTheoryQuestionsState({ resolveAdapter, testId, limit = 100, summarize, sessionContext = null, resolveArgs = {} } = {}) {
  const generatedAt = new Date().toISOString()
  const id = toChallengeId(testId)
  if (id === null) return { ok: false, generatedAt, testId: null, total: 0, answered: 0, questions: [], error: '缺少 testId（试卷 ID）' }
  if (typeof resolveAdapter !== 'function') {
    return { ok: false, generatedAt, testId: id, total: 0, answered: 0, questions: [], error: '插件缺少平台适配器' }
  }
  const size = Number(limit)
  const max = Number.isFinite(size) && size > 0 ? Math.min(Math.floor(size), 200) : 100
  try {
    const adapter = await resolveAdapter(resolveArgs)
    const rows = (await adapter.theoryQuestions(id)) || []
    const all = Array.isArray(rows) ? rows : []
    const questions = all.slice(0, max).map((q) => {
      const body = q?.content ?? q?.title ?? q?.question ?? q?.name ?? ''
      const stem = typeof summarize === 'function' ? summarize(body) : summarizeStem(body)
      const options = Array.isArray(q?.options) ? q.options : []
      return {
        id: q?.id ?? null,
        type: String(q?.typeLabel ?? q?.type ?? ''),
        stem,
        answered: q?.answered === true,
        optionsCount: options.length,
      }
    })
    return {
      ok: true,
      generatedAt,
      testId: id,
      total: all.length,
      answered: all.filter((q) => q?.answered === true).length,
      truncated: all.length > questions.length,
      questions,
    }
  } catch (error) {
    return {
      ok: false,
      generatedAt,
      testId: id,
      total: 0,
      answered: 0,
      questions: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 题干 → 单行摘要（去 HTML 标签、折叠空白、截断）。 */
export function summarizeStem(raw, max = 120) {
  const text = String(raw ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

/** WP 落盘绝对路径：优先 work 记录里的 writeupPath，否则按目录约定拼。 */
function resolveWriteupPath(record, workDir) {
  const explicit = record?.writeupPath ? String(record.writeupPath) : ''
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(workDir, explicit)
  if (record?.challengeId == null) return ''
  const slug = String(record?.writeupSlug ?? '').trim() || slugify(parseTaskSubject(record?.subject).name || '')
  if (!slug) return ''
  return path.join(workDir, 'writeups', `${slug}-${record.challengeId}.md`)
}

function isPathWithin(base, target) {
  const root = path.resolve(String(base || '.'))
  const candidate = path.resolve(String(target || ''))
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

async function isPathWithinWorkspace(fs, base, target) {
  if (!isPathWithin(base, target)) return false
  if (typeof fs?.realpath !== 'function') return true
  try {
    const [realBase, realTarget] = await Promise.all([
      fs.realpath(base),
      fs.realpath(target),
    ])
    return isPathWithin(realBase, realTarget)
  } catch {
    // 目标不存在或 realpath 不可用时由后面的 stat 统一跳过。
    return false
  }
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
export async function buildReportsState({ store, resolveAdapter, workDir, fs = fsp, now = () => Date.now(), sessionContext = null, resolveArgs = {} } = {}) {
  let generatedAt
  try {
    generatedAt = new Date(now()).toISOString()
  } catch {
    generatedAt = new Date().toISOString()
  }
  try {
    const dir = workDir || defaultWorkDir()
    let connKey = textValue(sessionContext?.connKey)
    if (!sessionContext && typeof resolveAdapter === 'function') {
      try {
        const platform = await resolveAdapter(resolveArgs)
        connKey = platform?.connKey ?? null
      } catch {
        /* 未配置连接：本地已生成的 WP 仍然要能看到 */
      }
    }
    // 已绑定会话却还没有连接 key 时，只读 unknown 队列；不能因为解析失败
    // 把另一赛事的 writeup 全部展示出来。
    const recordKey = sessionContext ? (connKey || 'unknown') : (connKey ?? undefined)
    const records = typeof store?.listChallengeWork === 'function' ? await store.listChallengeWork(recordKey) : []
    const writeups = []
    for (const record of Array.isArray(records) ? records : []) {
      const absPath = resolveWriteupPath(record, dir)
      if (!absPath) continue
      // state.json 里的路径属于本地可变数据；报告路由只允许读取当前工作区，
      // 避免一条被篡改的记录把 /etc/passwd 等任意文件内容带进 HTTP 响应。
      if (!await isPathWithinWorkspace(fs, dir, absPath)) continue
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
        // 正文预览：视图的「报告」<details> 直接展示它（此前只回元信息，展开是空的）。
        // 只读前 N 字符，避免大文件把轮询响应撑大；bodyChars 为完整字符数。
        ...(await readWriteupPreview(fs, absPath, stat)),
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
  settingsHasPlatform,
  slugify,
  buildPanelState,
  buildChallengeDetailState,
  buildTeamState,
  buildReportsState,
  buildTheoryQuestionsState,
  summarizeStem,
  readSessionTokenUsage,
  readProjectedTokenUsage,
  foldCompactionUsage,
  teamDeliveryOf,
  resolveSessionLogPath,
  resolveLatestSessionLogPath,
  defaultSessionsRoot,
  readLimitParam,
  createSessionRegistry,
  sessionIdFromRequest,
  resolveRequestSession,
  withSessionCapture,
  injectBootEntry,
  maskFlag,
}
