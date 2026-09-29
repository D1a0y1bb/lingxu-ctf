/**
 * 持久化：平台连接配置、赛事快照、flag 提交审计、解题进度、团队协同消息。
 *
 * 刻意不依赖 DSH storage service —— 用普通 JSON 文件，便于单测与跨版本稳定。
 * 默认落盘位置：`<dshHome>/storages/lingxu-ctf/state.json`
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

export function defaultStateDir() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'storages', 'lingxu-ctf')
}

/** 深拷贝，避免调用方拿到内部引用后误改。 */
const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)))

/**
 * 团队消息的硬限制（防止把 MB 级内容写进状态文件）。
 * 单条 `text` 截断到 `TEAM_MESSAGE_TEXT_LIMIT` 字符；整个 `teamMessages` 队列
 * 最多保留 `TEAM_MESSAGE_LIMIT` 条，超出按 FIFO（丢最旧）淘汰。
 */
export const TEAM_MESSAGE_LIMIT = 500
export const TEAM_MESSAGE_TEXT_LIMIT = 2000
/** 单条消息的 from/to/kind 字段长度上限（这三个字段是标识，不是正文）。 */
export const TEAM_MESSAGE_FIELD_LIMIT = 64
/** 状态文件的硬上限；超过时按损坏文件处理，避免异常输入耗尽内存。 */
export const MAX_STATE_BYTES = 16 * 1024 * 1024
/** 新字段通过 schemaVersion 演进，保留 version=1 兼容 DSH 旧状态。 */
export const STATE_SCHEMA_VERSION = 1
const STORE_LOCK_TIMEOUT_MS = 5000
const STORE_LOCK_STALE_MS = 30_000

function corruptBackupPath(file, now) {
  // 同一毫秒内可能有多个进程同时发现损坏；随机尾缀避免后一个备份覆盖前一个。
  return `${file}.corrupt-${now}-${randomUUID()}`
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function plainMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, entry]) => key !== '__proto__' && key !== 'constructor' && entry && typeof entry === 'object' && !Array.isArray(entry),
    ),
  )
}

function normalizeState(value) {
  const parsed = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const base = emptyState()
  const state = {
    ...base,
    ...parsed,
    schemaVersion: Number(parsed.schemaVersion) > 0 ? Number(parsed.schemaVersion) : STATE_SCHEMA_VERSION,
    connections: plainMap(parsed.connections),
    challengeWork: plainMap(parsed.challengeWork),
    submissions: Array.isArray(parsed.submissions)
      ? parsed.submissions.filter((row) => row && typeof row === 'object').slice(-2000)
      : [],
    teamMessages: Array.isArray(parsed.teamMessages)
      ? parsed.teamMessages.filter((row) => row && typeof row === 'object').slice(-TEAM_MESSAGE_LIMIT)
      : [],
    activeConnection: parsed.activeConnection == null ? null : String(parsed.activeConnection),
    activeConnKey: parsed.activeConnKey == null ? null : String(parsed.activeConnKey),
    updatedAt: parsed.updatedAt == null ? null : String(parsed.updatedAt),
  }
  // 不允许历史文件借 JSON 原型字段改变运行时对象。
  delete state.__proto__
  delete state.constructor
  return state
}

function mergeMap(base, local, disk) {
  const out = { ...plainMap(disk) }
  const baseMap = plainMap(base)
  const localMap = plainMap(local)
  for (const [key, value] of Object.entries(localMap)) {
    if (!sameValue(value, baseMap[key])) out[key] = clone(value)
  }
  return out
}

function recordIdentity(row, kind) {
  if (!row || typeof row !== 'object') return `json:${JSON.stringify(row)}`
  if (kind === 'team' && row.messageId) return `message:${row.connKey || 'unknown'}:${row.messageId}`
  if (kind === 'submission') {
    return `submission:${row.at || ''}:${row.connKey || ''}:${row.challengeId || ''}:${row.flag || ''}:${row.status || ''}`
  }
  return `json:${JSON.stringify(row)}`
}

/** 追加型数组做并发合并；本 store 没有删除接口，保留另一进程已写入的记录更安全。 */
function mergeAppendOnly(base, local, disk, kind, limit) {
  const baseRows = Array.isArray(base) ? base : []
  const localRows = Array.isArray(local) ? local : []
  const out = Array.isArray(disk) ? disk.map(clone) : []
  const positions = new Map(out.map((row, index) => [recordIdentity(row, kind), index]))
  for (const row of localRows) {
    const identity = recordIdentity(row, kind)
    const baseRow = baseRows.find((candidate) => recordIdentity(candidate, kind) === identity)
    const index = positions.get(identity)
    // 本进程新增，或修改了自己基线中的同一条记录，都应写回。
    if (!baseRow || !sameValue(row, baseRow)) {
      if (index == null) {
        positions.set(identity, out.length)
        out.push(clone(row))
      } else {
        out[index] = clone(row)
      }
    }
  }
  return limit && out.length > limit ? out.slice(-limit) : out
}

function mergeStateDelta(base, local, disk, updatedAt) {
  const current = normalizeState(disk)
  const baseline = normalizeState(base)
  const changes = normalizeState(local)
  return {
    ...current,
    version: Math.max(Number(current.version) || 1, Number(changes.version) || 1),
    schemaVersion: Math.max(Number(current.schemaVersion) || STATE_SCHEMA_VERSION, Number(changes.schemaVersion) || STATE_SCHEMA_VERSION),
    connections: mergeMap(baseline.connections, changes.connections, current.connections),
    challengeWork: mergeMap(baseline.challengeWork, changes.challengeWork, current.challengeWork),
    submissions: mergeAppendOnly(baseline.submissions, changes.submissions, current.submissions, 'submission', 2000),
    teamMessages: mergeAppendOnly(baseline.teamMessages, changes.teamMessages, current.teamMessages, 'team', TEAM_MESSAGE_LIMIT),
    activeConnection: !sameValue(changes.activeConnection, baseline.activeConnection)
      ? changes.activeConnection
      : current.activeConnection,
    activeConnKey: !sameValue(changes.activeConnKey, baseline.activeConnKey)
      ? changes.activeConnKey
      : current.activeConnKey,
    updatedAt: updatedAt || current.updatedAt || null,
  }
}

export function emptyState() {
  return {
    version: 1,
    schemaVersion: STATE_SCHEMA_VERSION,
    connections: {}, // key -> connection
    activeConnection: null,
    // 当前连接 key（也可能只来自设置页）；提交和面板按它过滤。
    activeConnKey: null,
    submissions: [], // flag 提交审计（append-only）
    challengeWork: {}, // `${connKey}:${challengeId}` -> work record
    teamMessages: [], // agent 团队协同消息（FIFO，上限 TEAM_MESSAGE_LIMIT）
    updatedAt: null,
  }
}

/** 把任意时间表示归一化成 ISO 字符串（认不出来时返回 null，由调用方回退）。 */
function normalizeTime(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** 截断成短标识字段（from/to/kind）。 */
function shortField(value, fallback) {
  const text = String(value ?? '').trim()
  return text ? text.slice(0, TEAM_MESSAGE_FIELD_LIMIT) : fallback
}

/**
 * 从连接 key 里解析 eventId（`lingxu:host:8000:7` → `7`）。
 *
 * 老提交记录没有 `eventId` 字段时，从连接 key 归位。
 * 解析不出来返回 `null`（不瞎猜）。
 */
export function parseEventIdFromConnKey(connKey) {
  const text = String(connKey ?? '').trim()
  const match = /:(\d+)$/.exec(text)
  if (!match) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

/** 提交/work 记录归属的赛事 id：优先记录里的 `eventId`，否则从 `connKey` 反推。 */
export function eventIdOf(record) {
  const explicit = Number(record?.eventId)
  if (Number.isInteger(explicit) && explicit > 0) return explicit
  return parseEventIdFromConnKey(record?.connKey)
}

/** 从连接配置生成稳定 key。 */
export function connectionKey({ platform = 'lingxu', baseUrl, eventId }) {
  const base = String(baseUrl || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
  return `${platform}:${base}:${eventId ?? '-'}`
}

export class CtfStore {
  /**
   * @param {{ dir?: string, fs?: typeof fsp, now?: () => number }} options
   */
  constructor({ dir, fs = fsp, now = () => Date.now() } = {}) {
    this.dir = dir || defaultStateDir()
    this.file = path.join(this.dir, 'state.json')
    this.fs = fs
    this.now = now
    this.state = emptyState()
    this._baseState = clone(this.state)
    this.loaded = false
    this._writeChain = Promise.resolve()
  }

  async load() {
    if (this.loaded) return this.state
    try {
      const text = await this.fs.readFile(this.file, 'utf8')
      if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) {
        const error = new Error('状态文件超过大小限制')
        error.code = 'E2BIG'
        throw error
      }
      const parsed = JSON.parse(text)
      this.state = normalizeState(parsed)
      try {
        await this.fs.chmod?.(this.dir, 0o700)
        await this.fs.chmod?.(this.file, 0o600)
      } catch {
        // 只读环境不能改权限，但不应把有效状态当成损坏文件。
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 损坏的状态文件不应让插件整体失败：备份后从空状态继续
        const backup = corruptBackupPath(this.file, this.now())
        try {
          await this.fs.rename(this.file, backup)
          await this.fs.chmod?.(backup, 0o600)
        } catch {
          /* 备份失败可忽略 */
        }
      }
      this.state = emptyState()
    }
    this._baseState = clone(this.state)
    this.loaded = true
    return this.state
  }

  async save() {
    // 进程内串行 + 进程间 lock；每次写入都会把本进程相对基线的增量合并到磁盘最新状态。
    const write = this._writeChain.catch(() => {}).then(() => this.#saveOnce())
    this._writeChain = write
    return write
  }

  async #readDiskState() {
    try {
      const text = await this.fs.readFile(this.file, 'utf8')
      if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) throw new Error('状态文件超过大小限制')
      return normalizeState(JSON.parse(text))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      // save 阶段发现损坏文件时先保留证据，再以空状态合并，不能直接覆盖现场。
      try {
        const backup = corruptBackupPath(this.file, this.now())
        await this.fs.rename(this.file, backup)
        await this.fs.chmod?.(backup, 0o600)
      } catch { /* 备份失败可忽略 */ }
      return null
    }
  }

  async #acquireLock() {
    if (typeof this.fs.open !== 'function' || typeof this.fs.unlink !== 'function') return null
    const lockPath = `${this.file}.lock`
    const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS
    for (;;) {
      try {
        const handle = await this.fs.open(lockPath, 'wx', 0o600)
        return async () => {
          try { await handle.close() } catch { /* 句柄可能已由宿主回收 */ }
          try { await this.fs.unlink(lockPath) } catch { /* 锁清理尽力而为 */ }
        }
      } catch (error) {
        if (error?.code !== 'EEXIST' || Date.now() >= deadline) {
          throw new Error(`状态文件被其他进程占用：${lockPath}`)
        }
        // 进程崩溃留下的锁不能永久阻塞插件；只清理明确过期的锁。
        try {
          const stat = await this.fs.stat(lockPath)
          if (Date.now() - Number(stat.mtimeMs || 0) > STORE_LOCK_STALE_MS) {
            await this.fs.unlink(lockPath)
            continue
          }
        } catch { /* 文件刚好被释放 */ }
        await wait(25)
      }
    }
  }

  async #saveOnce() {
    // state.json 保存平台 Cookie，只允许当前用户访问目录和文件。
    await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    await this.fs.chmod?.(this.dir, 0o700)
    const release = await this.#acquireLock()
    try {
      const disk = await this.#readDiskState()
      const base = normalizeState(this._baseState)
      const local = normalizeState(this.state)
      const current = disk || emptyState()
      const merged = mergeStateDelta(base, local, current, new Date(this.now()).toISOString())
      const serialized = JSON.stringify(merged, null, 2)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
        throw new Error(`状态文件超过大小限制（${MAX_STATE_BYTES} bytes）`)
      }
      const tmp = `${this.file}.tmp-${process.pid}-${randomUUID()}`
      try {
        await this.fs.writeFile(tmp, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await this.fs.chmod?.(tmp, 0o600)
        await this.fs.rename(tmp, this.file)
      } finally {
        try { await this.fs.unlink?.(tmp) } catch { /* rename 成功后不存在 */ }
      }
      await this.fs.chmod?.(this.file, 0o600)
      // 另一个同实例调用可能在 await writeFile/rename 期间继续修改 state。
      // 保留这段时间产生的增量，交给排队中的下一次 save 落盘，不能用旧快照覆盖它。
      const latestLocal = normalizeState(this.state)
      this.state = sameValue(latestLocal, local)
        ? merged
        : mergeStateDelta(local, latestLocal, merged, merged.updatedAt)
      this._baseState = clone(merged)
    } finally {
      await release?.()
    }
  }

  // ------------------------------------------------------------ 连接

  async upsertConnection(conn) {
    await this.load()
    const key = connectionKey(conn)
    const existing = this.state.connections[key] || {}
    this.state.connections[key] = {
      ...existing,
      ...conn,
      key,
      createdAt: existing.createdAt || new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    }
    this.state.activeConnection = key
    await this.save()
    return clone(this.state.connections[key])
  }

  async getConnection(key) {
    await this.load()
    return clone(this.state.connections[key])
  }

  async listConnections() {
    await this.load()
    return Object.values(this.state.connections).map(clone)
  }

  /**
   * 解析要使用的连接。优先级：
   *  1. 显式 key（精确）
   *  2. 显式 platform / baseUrl / eventId 的**部分匹配**（只给 eventId 也能命中）
   *  3. activeConnection
   *  4. 仅有一个连接时用它
   */
  async resolveConnection({ key, platform, eventId, baseUrl } = {}) {
    await this.load()
    if (key) return clone(this.state.connections[key])

    if (platform || baseUrl || eventId != null) {
      // 先试精确 key（三者齐全时命中）
      if (baseUrl && eventId != null) {
        const exact = this.state.connections[connectionKey({ platform: platform || 'lingxu', baseUrl, eventId })]
        if (exact) return clone(exact)
      }
      // 再按提供的字段做部分匹配
      const normalizedBase = baseUrl
        ? String(baseUrl).replace(/^https?:\/\//, '').replace(/\/+$/, '')
        : undefined
      const matches = Object.values(this.state.connections).filter((c) => {
        if (platform && String(c.platform) !== String(platform)) return false
        if (eventId != null && String(c.eventId) !== String(eventId)) return false
        if (normalizedBase) {
          const cBase = String(c.baseUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
          if (cBase !== normalizedBase) return false
        }
        return true
      })
      if (matches.length === 1) return clone(matches[0])
      if (matches.length > 1) {
        // 多个候选时优先 activeConnection，其次最近更新的
        const active = matches.find((c) => c.key === this.state.activeConnection)
        if (active) return clone(active)
        return clone(matches.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0])
      }
      return undefined
    }

    if (this.state.activeConnection) return clone(this.state.connections[this.state.activeConnection])
    const all = Object.values(this.state.connections)
    return all.length === 1 ? clone(all[0]) : undefined
  }

  /**
   * 活动连接（`activeConnection` 指向的那条）；没有活动记录时按老规则退化（唯一连接/最新更新）。
   *
   * ⚠️ 与 `resolveConnection()` 的区别：这里**只看活动连接**，不会被"部分匹配"绕过去 ——
   * `resolveAdapter` 用它判断 ctf_connect 最近使用的连接。
   */
  async getActiveConnection() {
    await this.load()
    if (this.state.activeConnection && this.state.connections[this.state.activeConnection]) {
      return clone(this.state.connections[this.state.activeConnection])
    }
    const all = Object.values(this.state.connections)
    if (!all.length) return undefined
    return clone(all.slice().sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0])
  }

  async setActive(key) {
    await this.load()
    if (!this.state.connections[key]) throw new Error(`未知连接：${key}`)
    this.state.activeConnection = key
    await this.save()
    return clone(this.state.connections[key])
  }

  // ------------------------------------------------------------ 提交审计

  async recordSubmission(entry) {
    await this.load()
    const record = {
      at: new Date(this.now()).toISOString(),
      ...entry,
      // 赛事归属：显式传入优先，否则从 connKey 反推。
      eventId: eventIdOf(entry) ?? undefined,
    }
    this.state.submissions.push(record)
    // 审计日志只保留最近 2000 条，避免无限增长
    if (this.state.submissions.length > 2000) {
      this.state.submissions = this.state.submissions.slice(-2000)
    }
    await this.save()
    return record
  }

  /** 该题是否已成功提交过同一 flag（去重）。 */
  async hasSubmittedFlag(connKey, challengeId, flag) {
    await this.load()
    const normalized = String(flag).trim()
    return this.state.submissions.some(
      (s) =>
        s.connKey === connKey &&
        String(s.challengeId) === String(challengeId) &&
        s.flag === normalized &&
        (s.status === 'correct' || s.status === 'already_solved'),
    )
  }

  /** 该题已提交过的所有 flag（用于避免重复尝试同一个错误答案）。 */
  async submittedFlagsFor(connKey, challengeId) {
    await this.load()
    return this.state.submissions
      .filter((s) => s.connKey === connKey && String(s.challengeId) === String(challengeId))
      .map((s) => ({ flag: s.flag, status: s.status, at: s.at }))
  }

  async wrongAttemptCount(connKey, challengeId) {
    await this.load()
    return this.state.submissions.filter(
      (s) => s.connKey === connKey && String(s.challengeId) === String(challengeId) && s.status === 'incorrect',
    ).length
  }

  /**
   * 最近的提交审计。
   *
   * 默认按当前赛事过滤；store 里的 `submissions` 是一个全局数组，
   * 换赛事后还把上一场的提交混着显示就是用户报的「串数据」。
   *
   * @param {number} limit 最多返回多少条
   * @param {{ connKey?: string|null, all?: boolean, includeUnknown?: boolean }} [options]
   *  - `connKey`：显式指定赛事（默认取 `activeConnKey` → `activeConnection`）
   *  - `all: true`：不过滤（跨赛事全量，仅供排障/导出）
   *  - `includeUnknown`：连 `connKey` 都没有的极老记录是否一并返回（默认 false）
   */
  async recentSubmissions(limit = 50, options = {}) {
    await this.load()
    const { connKey = null, all = false, includeUnknown = false } = options ?? {}
    const key = all ? null : connKey ?? this.state.activeConnKey ?? this.state.activeConnection ?? null
    if (!key) return clone(this.state.submissions.slice(-limit))
    // 老记录（没有 connKey）默认不算任何赛事 —— 宁可少显示，也不要串赛事
    const rows = this.state.submissions.filter((s) => s.connKey === key || (includeUnknown && !s.connKey))
    return clone(rows.slice(-limit))
  }

  /** 当前连接 key，供事件隔离和多赛事视图使用。 */
  async getActiveConnKey() {
    await this.load()
    return this.state.activeConnKey ?? this.state.activeConnection ?? null
  }

  /**
   * 记下「此刻正在用哪个连接」。
   *
   * 每次工具解析出连接时调用（只在**变化**时落盘，避免每次调用都写文件）。
   * 与 `setActive` 的区别：
   * - 允许 key **不在** `connections` 里（设置页配的赛事可能还没 ctf_connect 过）；
   * - `activeConnection` 只在 store 里确实有这条记录时才更新（保持原有语义）。
   */
  async noteActiveConnection(connKey) {
    const key = String(connKey ?? '').trim()
    if (!key) return null
    await this.load()
    const changed = this.state.activeConnKey !== key
    this.state.activeConnKey = key
    const storedChanged = Boolean(this.state.connections[key]) && this.state.activeConnection !== key
    if (storedChanged) this.state.activeConnection = key
    if (changed || storedChanged) await this.save()
    return key
  }

  // ------------------------------------------------------------ 解题进度

  async upsertChallengeWork(connKey, challengeId, patch) {
    await this.load()
    const key = `${connKey}:${challengeId}`
    this.state.challengeWork[key] = {
      ...(this.state.challengeWork[key] || {}),
      ...patch,
      connKey,
      challengeId: String(challengeId),
      updatedAt: new Date(this.now()).toISOString(),
    }
    await this.save()
    return clone(this.state.challengeWork[key])
  }

  async getChallengeWork(connKey, challengeId) {
    await this.load()
    return clone(this.state.challengeWork[`${connKey}:${challengeId}`])
  }

  async listChallengeWork(connKey) {
    await this.load()
    return Object.values(this.state.challengeWork)
      .filter((w) => !connKey || w.connKey === connKey)
      .map(clone)
  }

  // ------------------------------------------------------------ 团队协同消息

  /**
   * 追加一条 agent 团队协同消息（`ctf_solve_*` 自动记录 + 未来的 `ctf_team_log` 手工汇报）。
   *
   * 落盘纪律（**不要**把这里当聊天记录仓库）：
   * - `text` 截断到 `TEAM_MESSAGE_TEXT_LIMIT`（2000）字符；
   * - `from` / `to` / `kind` 截断到 `TEAM_MESSAGE_FIELD_LIMIT`（64）字符；
   * - 队列整体上限 `TEAM_MESSAGE_LIMIT`（500）条，超出丢最旧的（FIFO）。
   *
   * @param {string} connKey 连接 key（省略归入 `unknown`，仍可被无连接的读取路径拿到）
   * @param {{ from?: string, to?: string, kind?: string, text?: string, at?: string|number|Date }} message
   * @returns {Promise<{ connKey: string, at: string, from: string, to: string, kind: string, text: string }>}
   */
  async appendTeamMessage(connKey, message = {}) {
    await this.load()
    if (!Array.isArray(this.state.teamMessages)) this.state.teamMessages = []
    const messageId = String(message.messageId ?? '').trim()
    // 幂等：同一条 Team 消息可能被投递/重放多次（hook 观察 + 冷启动恢复），按 messageId 去重
    if (messageId !== '') {
      const targetConnKey = String(connKey ?? '').trim() || 'unknown'
      const existing = this.state.teamMessages.find(
        (row) => row && row.connKey === targetConnKey && row.messageId === messageId,
      )
      if (existing) return clone(existing)
    }
    const challengeId = message.challengeId === null || message.challengeId === undefined || message.challengeId === ''
      ? null
      : Number(message.challengeId)
    const record = {
      connKey: String(connKey ?? '').trim() || 'unknown',
      at: normalizeTime(message.at) ?? new Date(this.now()).toISOString(),
      from: shortField(message.from, 'unknown'),
      to: shortField(message.to, 'team'),
      kind: shortField(message.kind, 'note'),
      text: String(message.text ?? '').slice(0, TEAM_MESSAGE_TEXT_LIMIT),
      // team 消息保存来源标识、消息 ID 和关联题目。
      messageId,
      challengeId: Number.isFinite(challengeId) ? challengeId : null,
    }
    this.state.teamMessages.push(record)
    if (this.state.teamMessages.length > TEAM_MESSAGE_LIMIT) {
      this.state.teamMessages = this.state.teamMessages.slice(-TEAM_MESSAGE_LIMIT)
    }
    await this.save()
    return clone(record)
  }

  /**
   * 读取团队消息（按写入顺序，最旧 → 最新）。
   *
   * @param {string} [connKey] 省略 = 返回所有连接的消息（无平台连接时也能看到协同记录）
   * @param {number} [limit=50] 最多返回多少条（取**最新**的 limit 条）
   */
  async listTeamMessages(connKey, limit = 50) {
    await this.load()
    const queue = Array.isArray(this.state.teamMessages) ? this.state.teamMessages : []
    const rows = connKey ? queue.filter((m) => m?.connKey === connKey) : queue
    const n = Number(limit)
    const size = Number.isFinite(n) && n > 0 ? Math.floor(n) : 50
    return clone(rows.slice(-size))
  }
}

/** 供工具层复用的单例（按目录缓存）。 */
const instances = new Map()
export function getStore(options = {}) {
  const dir = options.dir || defaultStateDir()
  if (!instances.has(dir)) instances.set(dir, new CtfStore({ ...options, dir }))
  return instances.get(dir)
}
