/**
 * 持久化：平台连接配置、赛事快照、flag 提交审计、解题进度、团队协同消息。
 *
 * 刻意不依赖 DSH storage service —— 用普通 JSON 文件，便于单测与跨版本稳定。
 * 默认落盘位置：`<dshHome>/storages/lingxu-ctf/state.json`
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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

export function emptyState() {
  return {
    version: 1,
    connections: {}, // key -> connection
    activeConnection: null,
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
    this.loaded = false
    this._writeChain = Promise.resolve()
  }

  async load() {
    if (this.loaded) return this.state
    try {
      const text = await this.fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      this.state = { ...emptyState(), ...parsed }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 损坏的状态文件不应让插件整体失败：备份后从空状态继续
        try {
          await this.fs.rename(this.file, `${this.file}.corrupt-${this.now()}`)
        } catch {
          /* 备份失败可忽略 */
        }
      }
      this.state = emptyState()
    }
    this.loaded = true
    return this.state
  }

  async save() {
    // 串行化写入，避免并发工具调用互相覆盖
    this._writeChain = this._writeChain.then(async () => {
      await this.fs.mkdir(this.dir, { recursive: true })
      this.state.updatedAt = new Date(this.now()).toISOString()
      const tmp = `${this.file}.tmp`
      await this.fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      await this.fs.rename(tmp, this.file)
    })
    return this._writeChain
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
   *   1. 显式 key（精确）
   *   2. 显式 platform / baseUrl / eventId 的**部分匹配**（只给 eventId 也能命中）
   *   3. activeConnection
   *   4. 仅有一个连接时用它
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
   * `resolveAdapter` 要靠它判断「ctf_connect 最近连的是哪条」（task-27）。
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

  async recentSubmissions(limit = 50) {
    await this.load()
    return clone(this.state.submissions.slice(-limit))
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
    const record = {
      connKey: String(connKey ?? '').trim() || 'unknown',
      at: normalizeTime(message.at) ?? new Date(this.now()).toISOString(),
      from: shortField(message.from, 'unknown'),
      to: shortField(message.to, 'team'),
      kind: shortField(message.kind, 'note'),
      text: String(message.text ?? '').slice(0, TEAM_MESSAGE_TEXT_LIMIT),
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
