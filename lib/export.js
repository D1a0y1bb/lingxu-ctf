/**
 * 将本地解题产物导出为可移交的目录包。
 *
 * 导出只读取当前连接的数据，并明确排除 store.json、Cookie、日志和符号链接。
 * 结果是普通目录，方便审阅、压缩或继续归档，不引入 zip 依赖。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectionKey } from './store.js'
import { resolveWorkDir, slugify } from './writeup.js'

const MAX_SUBMISSIONS = 2000

function maskFlag(flag) {
  const text = String(flag ?? '')
  if (!text) return ''
  if (text.length <= 8) return `${text.slice(0, 2)}${'*'.repeat(Math.max(0, text.length - 2))}`
  return `${text.slice(0, 6)}${'*'.repeat(Math.min(8, text.length - 8))}${text.slice(-2)}`
}

function safeId(value) {
  const text = String(value ?? '').trim()
  return /^\d+$/.test(text) ? text : text.replace(/[^a-zA-Z0-9_-]/g, '')
}

function within(root, target) {
  const base = path.resolve(root)
  const candidate = path.resolve(target)
  return candidate === base || candidate.startsWith(`${base}${path.sep}`)
}

async function copyTree(fs, source, target, { include = () => true, files = [] } = {}) {
  let entries
  try {
    entries = await fs.readdir(source, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const relative = path.relative(source, from)
    if (entry.isSymbolicLink?.()) continue
    if (entry.isDirectory()) {
      await copyTree(fs, from, path.join(target, entry.name), { include, files })
      continue
    }
    if (!entry.isFile() || !include(from, relative)) continue
    await fs.mkdir(path.dirname(path.join(target, entry.name)), { recursive: true })
    await fs.copyFile(from, path.join(target, entry.name))
    files.push(path.join(target, entry.name))
  }
}

export function createExportBundle(deps = {}) {
  const config = deps.config || {}
  const fs = deps.fs || fsp
  const store = deps.store
  const resolveAdapter = deps.resolveAdapter
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  async function exportBundle(args = {}) {
    if (typeof resolveAdapter !== 'function') throw new Error('导出模块缺少 deps.resolveAdapter')
    if (!store) throw new Error('导出模块缺少 store')
    const resolved = await resolveAdapter(args)
    const adapter = resolved?.adapter
    const connection = resolved?.connection || {}
    if (!adapter) throw new Error('未能解析平台适配器，请先配置连接')
    const connKey = String(resolved?.connKey || connectionKey(connection))
    const requestedId = args.id ?? args.challengeId
    const id = requestedId == null || String(requestedId).trim() === '' ? null : String(requestedId).trim()
    const suppliedWorkDir = String(args.workDir || '').trim()
    const workDir = path.resolve(suppliedWorkDir && path.isAbsolute(suppliedWorkDir)
      ? suppliedWorkDir
      : resolveWorkDir(config, suppliedWorkDir))
    const timestamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    const root = path.join(workDir, 'exports', `lingxu-ctf-event-${safeId(connection.eventId) || 'unknown'}-${timestamp}-${randomUUID().slice(0, 8)}`)
    if (!within(workDir, root)) throw new Error('导出目录必须位于 workDir 内')

    const challenges = id
      ? [await adapter.challengeDetail(id)]
      : ((await adapter.challenges()) || [])
    const rows = challenges.filter(Boolean)
    const selectedIds = new Set(rows.map((row) => String(row.id)))
    const workRows = typeof store.listChallengeWork === 'function'
      ? await store.listChallengeWork(connKey)
      : []
    const selectedWork = workRows.filter((row) => selectedIds.has(String(row.challengeId)))
    const allSubmissions = typeof store.recentSubmissions === 'function'
      ? await store.recentSubmissions(MAX_SUBMISSIONS, { connKey })
      : []
    const submissions = allSubmissions.filter((row) => selectedIds.has(String(row.challengeId)))
    const files = []
    const workSummaryOf = (row) => {
      if (!row) return null
      const rawWriteupPath = String(row.writeupPath || '').trim()
      const absoluteWriteupPath = rawWriteupPath
        ? (path.isAbsolute(rawWriteupPath) ? rawWriteupPath : path.join(workDir, rawWriteupPath))
        : ''
      return {
        status: row.status ?? null,
        owner: row.owner ?? row.teammate ?? row.prepTeammate ?? null,
        taskType: row.taskType ?? null,
        requiresEnv: row.requiresEnv === true,
        updatedAt: row.updatedAt ?? null,
        writeupPath: absoluteWriteupPath && within(workDir, absoluteWriteupPath) ? path.relative(workDir, absoluteWriteupPath) : null,
      }
    }
    for (const row of rows) {
      const slug = slugify(row.name || row.category || 'challenge')
      const source = path.join(workDir, 'challenges', `${slug}-${row.id}`)
      await copyTree(fs, source, path.join(root, 'challenges', `${slug}-${row.id}`), { files })
      const writeupPaths = selectedWork
        .filter((work) => String(work.challengeId) === String(row.id) && work.writeupPath)
        .map((work) => {
          const raw = String(work.writeupPath)
          return path.isAbsolute(raw) ? raw : path.join(workDir, raw)
        })
      for (const writeupPath of writeupPaths) {
        const absolute = path.resolve(writeupPath)
        if (!within(workDir, absolute)) continue
        try {
          const stat = await fs.lstat(absolute)
          if (!stat.isFile() || stat.isSymbolicLink()) continue
          const relative = path.relative(workDir, absolute)
          const target = path.join(root, relative)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.copyFile(absolute, target)
          files.push(target)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    }
    const scriptFilter = id
      ? (file) => path.basename(file).includes(id)
      : () => true
    await copyTree(fs, path.join(workDir, 'scripts'), path.join(root, 'scripts'), { include: (file) => scriptFilter(file), files })

    const manifest = {
      format: 'dsh-lingxu-ctf-export',
      version: 1,
      generatedAt: new Date(now()).toISOString(),
      platform: connection.platform || adapter.id || 'lingxu',
      eventId: connection.eventId ?? null,
      eventName: connection.eventName || connection.eventTitle || null,
      challengeId: id,
      counts: { challenges: rows.length, submissions: submissions.length, files: files.length },
      challenges: rows.map((row) => ({
        id: row.id,
        name: row.name || '',
        category: row.category || '',
        score: row.score ?? 0,
        solved: Boolean(row.solved),
        taskType: row.taskType ?? null,
        work: workSummaryOf(selectedWork.find((work) => String(work.challengeId) === String(row.id))),
      })),
      submissions: submissions.map((row) => ({
        at: row.at || null,
        challengeId: row.challengeId,
        status: row.status || 'unknown',
        flag: maskFlag(row.flag),
      })),
      files: files.map((file) => path.relative(root, file)).sort(),
      exclusions: ['store.json', 'Cookie', 'sessionid', 'logs', 'symbolic links'],
    }
    await fs.mkdir(root, { recursive: true })
    const manifestPath = path.join(root, 'manifest.json')
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return {
      ok: true,
      action: 'export-bundle',
      path: root,
      manifestPath,
      fileCount: files.length,
      challengeCount: rows.length,
      summary: `已导出 ${rows.length} 道题、${files.length} 个文件：${root}`,
    }
  }

  return { export: exportBundle }
}

export default createExportBundle
