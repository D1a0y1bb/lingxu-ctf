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

import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import z from '@deepseek-ai/schemastery'

import { defineTool } from './toolkit.js'
import { getStore, connectionKey } from './store.js'
import { createAdapter, listPlatforms } from './platforms.js'
import { buildToolSpecs } from './tools.js'
import { lingxuRateLimitStats, withRequestPriority } from './lingxu.js'

// 赛段工具（AWD/CFS）是**可选模块**：用动态 import 容错，
// 万一文件缺失或加载失败，插件仍能以基础工具集正常加载（不能让 AWD 拖垮整个插件）。
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
/**
 * 理论题**题目概要**（按需拉取，绝不自动全量）：`?testId=<id>&limit=<n>`。
 * 只回题干摘要 + 题型 + 是否已答，不回选项/正文，避免 100 道题把面板撑爆。
 */
const THEORY_ROUTE = '/lingxu-ctf/theory'
/** 团队消息默认/最大返回条数（`?limit=` 可覆盖）。 */
export const TEAM_MESSAGES_DEFAULT_LIMIT = 50
export const TEAM_MESSAGES_MAX_LIMIT = 200

/**
 * 面板快照缓存 TTL（task-33）。
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
 * ⚠️ 与 `configHasCredentials` 的区别（task-28）：那个要求三件套齐全，用于「凭据是否完整」的判断；
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
 * 实测（task-28，真实平台核对过）：profile 里 `cookie:` 存的是**裸 sessionid 值**
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
 * 选出「这次该用哪个连接」—— **纯函数**，便于单测（task-27 的核心语义）。
 *
 * 优先级（用户直觉：设置页 =「我配置的平台」，ctf_connect =「连接/切换」）：
 *   ① 显式参数（`connection` / `platform` / `eventId` / `baseUrl`）—— 最高优先，找不到就报错（绝不静默换平台）
 *   ② 设置页配置（有凭据时）—— 用户在 UI 上改 eventId 必须**立刻生效**，不能被 store 里的历史记录压过
 *   ③ 本地已存的活动连接（`ctf_connect` 写的）
 *
 * 两个例外，避免"改了没用"的另一种形态：
 *   - `args` 给的 key 正好等于设置页那条 → 用设置页（用户可能直接从设置页复制了 key）；
 *   - store 的活动连接标记了 `settingsSync === 'failed'`（ctf_connect 连过、但回写设置页失败）→
 *     以**本次连接**为准，否则用户刚 connect 的赛事会被旧设置页压掉。
 *
 * Cookie 单独取（**设置页永远不写 cookie**，所以这里可能要给设置页配 store 里的 cookie）：
 *   同 key 的本地连接（ctf_connect 存的）→ 设置页 → null。
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
   * 给连接补 Cookie。取值顺序（task-28）：
   *   ① **同 key 的本地连接**（ctf_connect 为这个赛事存过）—— 最新鲜，优先；
   *   ② **设置页的 Cookie**（裸 sessionid 会补前缀，见 `normalizeCookie`）；
   *   ③ **同平台（同 baseUrl）其它连接的 Cookie** —— ⚠️ 关键：**Cookie 是平台级会话凭据，与赛事无关**
   *      （实测 store 里 `…:4` 的 Cookie 对 event 4 / event 7 都有效）。切赛事时 store 里往往只有旧赛事的连接，
   *      没有这一档就会「连接对了但没凭据」→ 403「未登录」→ 空数据。
   *   ④ 都拿不到 → 如实标注「无可用 Cookie」（不假装有）。
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

  // ── 依赖注入：解析当前应使用的平台连接与适配器 ────────────────────────
  //
  // 解析顺序：显式参数 > 本地已存连接 > **插件配置兜底**。
  // 最后一条是关键：用户在设置页填好平台地址/赛事ID/Cookie 后，直接说「开始」就能用，
  // 不必先在对话里跑 ctf_connect（也就不会把凭据打进聊天记录）。
  const resolveAdapter = createResolveAdapter({ store, config, rawConfig, createAdapter, logger })


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

  // ── 设置页同步（task-27）────────────────────────────────────────────
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

  withService(ctx, 'agentTeams', (serviceCtx, teams) => {
    deps.teams = teams // /lingxu-ctf/team 在请求时读它（服务晚于 webServer 就绪也不会漏）
    deps.orchestrator = createOrchestrator({ ...deps, teams })
    logger.info('Agent Teams 已就绪：ctf_solve_start / status / stop 可用')
  }, logger)

  // ── 工具注册 ─────────────────────────────────────────────────────────
  //
  // 基础工具集（16 个）永远注册；AWD / CFS 的专用工具**按赛事类型动态注册**：
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
        '不确定的 flag 不要反复提交——平台对错误提交本身不扣分，但反复乱试会浪费比赛时间。',
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
 *           deps?: object, logger?: object }} options
 *   - `registerTool`：把 ToolSpec 包成 DSH 工具并注册，**返回 disposer**。
 *   - `buildAwd` / `buildCfs`：产出 ToolSpec 数组的 builder（默认取 stage-tools.js 的实现）。
 * @returns {{ sync: (stages?: {hasAwd?: boolean, hasCfs?: boolean}|null) => string,
 *             disposeAll: () => void,
 *             counts: () => {awd: number, cfs: number},
 *             signature: () => string|null }}
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
    // 探活失败（键都缺失）时保持现状：不能因为一次网络抖动就把已注册的工具摘掉
    if (!stages || (stages.hasAwd === undefined && stages.hasCfs === undefined)) return sig ?? ''
    const wantAwd = stages.hasAwd === true
    const wantCfs = stages.hasCfs === true
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

  // 面板快照缓存（task-33）：TTL + 单飞 + 刷新下限 + store 写入穿透。
  // 放在路由注册前，handler 只多一层包装，不动 buildPanelState 的字段构造。
  const storeWriteProbe = instrumentStoreWrites(store)
  const panelCache = createPanelSnapshotCache()

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
          await store?.load?.()
          const cacheKey = [
            store?.state?.activeConnection ?? '',
            config?.eventId ?? '',
            config?.baseUrl ?? '',
          ].join('|')
          const payload = await panelCache.load(
            cacheKey,
            () => withRequestPriority('background', () => buildPanelState({ store, resolveAdapter, deps, config })),
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

  // ── 顶部「CTF」视图：理论题**题目概要**（按需拉取，前端点按钮才请求）──────
  ctx.effect(() =>
    webServer.register({
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
          payload = await buildTheoryQuestionsState({
            resolveAdapter,
            testId: url.searchParams.get('testId'),
            limit: Number(url.searchParams.get('limit') ?? 100),
          })
        } catch (error) {
          payload = { ok: false, generatedAt: new Date().toISOString(), testId: null, total: 0, answered: 0, questions: [], error: error instanceof Error ? error.message : String(error) }
        }
        res.statusCode = 200
        res.end(JSON.stringify(payload))
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
        // 限流 / 面板缓存的可观测性（task-33）：这里能直接看出「打平台有多猛」
        res.end(
          JSON.stringify(
            {
              ok: true,
              ...diag,
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
    webServer.register({
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
/**
 * 造一个「连接解析器」—— 从 store 与设置页配置里挑出这次要用的连接。
 *
 * 抽成工厂是为了**可测**：单测传入假 `createAdapter` 就能断言「解析到哪条连接」，
 * 不用真的发 HTTP（task-27 的核心行为全在这里）。
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
        // 表现为「切换赛事后一片空白 + 剩余已结束」（真实事故）。
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
      // 同平台 Cookie 回退（task-28）：Cookie 是平台级凭据，切赛事时 store 里常常只有旧赛事那条
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

export async function buildPanelState({ store, resolveAdapter, deps, config }) {
  const { adapter, connection, connKey } = await resolveAdapter({})
  // 面板自身也刷新「当前赛事」：用户改完设置页、没跑任何 ctf_* 工具就直接看面板时，
  // store 的 activeConnKey 可能还停在上一场 → 提交审计会串赛事（task-31 的修复）。
  // ⚠️ 可选调用：noteActiveConnection 是 task-31 新加的 API，老 store 上可能不存在。
  await store.noteActiveConnection?.(connKey)
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
      // 来源与差异（task-27/28）：面板可以据此显示「为什么是這個赛事 / Cookie 从哪来」
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
        // flag 是用户自己提交的答案，明文展示便于核对；
        // 真正需要脱敏的是凭据（cookie / token），那些另有 maskSecret/maskToken。
        flag: s.flag ?? '',
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
    runtime: { startedAt: null, elapsedSeconds: null, lastActivityAt: null, idleSeconds: null },
    tokenUsage: {
      available: false,
      reason: 'DSH 未向插件暴露 token 统计（无聚合服务/字段）',
    },
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

  // ── 活动时间线（用户问题 7/15：agent 活动要能看出「在干啥 / 多久没动」）──────
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
  const nowMs = Date.now()
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
    tokenUsage: {
      available: false,
      reason: 'DSH 未向插件暴露 token 统计：usage 只存在于单次 LLM 请求的流结果与会话日志 chunk 中，插件侧没有聚合服务/字段',
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
export async function buildTheoryQuestionsState({ resolveAdapter, testId, limit = 100, summarize } = {}) {
  const generatedAt = new Date().toISOString()
  const id = toChallengeId(testId)
  if (id === null) return { ok: false, generatedAt, testId: null, total: 0, answered: 0, questions: [], error: '缺少 testId（试卷 ID）' }
  if (typeof resolveAdapter !== 'function') {
    return { ok: false, generatedAt, testId: id, total: 0, answered: 0, questions: [], error: '插件缺少平台适配器' }
  }
  const size = Number(limit)
  const max = Number.isFinite(size) && size > 0 ? Math.min(Math.floor(size), 200) : 100
  try {
    const adapter = await resolveAdapter({})
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
  buildTeamState,
  buildReportsState,
  buildTheoryQuestionsState,
  summarizeStem,
  readLimitParam,
  withSessionCapture,
  injectBootEntry,
  maskFlag,
}
