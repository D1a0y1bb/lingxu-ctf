#!/usr/bin/env node
/**
 * 读取真实凌虚赛事合同并输出脱敏样本。
 *
 * 默认只读：不会交 flag、交卷、起/延时/释放环境，也不会调用 AWD flag/token
 * 接口。需要真实平台响应时提供 LINGXU_COOKIE_FILE；不把 Cookie 粘贴到命令行。
 *
 *   LINGXU_COOKIE_FILE=/path/cookie \
 *   LINGXU_EVENT_ID=4 \
 *   node scripts/sample-live-contract.mjs --out /tmp/lingxu-event-4-contract.json
 */

import { promises as fsp, readFileSync } from 'node:fs'
import path from 'node:path'
import { LingxuAdapter } from '../lib/platforms.js'
import { PLATFORM_CONTRACT_VERSION, stageCapabilitiesFromSummary } from '../lib/platforms.js'

const baseUrl = process.env.LINGXU_BASE_URL || 'https://shuxinbei.clsadp.com:8000'
const eventId = Number(process.env.LINGXU_EVENT_ID || 4)
const requestedDetailSamples = Number(process.env.LINGXU_SAMPLE_MAX_DETAILS || 12)
const maxDetailSamples = Number.isFinite(requestedDetailSamples)
  ? Math.max(1, Math.min(50, Math.trunc(requestedDetailSamples)))
  : 12
const outArg = process.argv.indexOf('--out')
const outPath = outArg >= 0 ? process.argv[outArg + 1] : ''

function readCookie() {
  if (process.env.LINGXU_COOKIE) return process.env.LINGXU_COOKIE.trim()
  const file = process.env.LINGXU_COOKIE_FILE
  if (!file) return ''
  try { return readFileSync(file, 'utf8').trim() } catch { return '' }
}

const cookie = readCookie()
if (!cookie) {
  console.log('⏭ 未提供 LINGXU_COOKIE / LINGXU_COOKIE_FILE，跳过真实合同采样。')
  process.exit(0)
}

const origin = (() => {
  try { return new URL(baseUrl).origin } catch { return baseUrl }
})()

function safeString(value) {
  return String(value ?? '')
    .replace(/\b(?:sessionid|csrftoken|token|authorization|password|passwd|secret|flag)\s*[:=]\s*[^;\s,}]+/gi, '$1=<redacted>')
    .replaceAll(origin, '<platform-origin>')
    .replace(/https?:\/\/[^\s/]+/gi, '<url>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<address>')
    .replace(/[A-Za-z]:\\[^\s，。；;）)]+/g, '<local-path>')
    .replace(/\/(?:Users|private|var|tmp|home|Volumes)\/[^\s，。；;）)]+/g, '<local-path>')
    .slice(0, 800)
}

function sensitiveKey(key) {
  return /cookie|token|flag|password|passwd|secret|csrf|authorization|username|number/i.test(String(key))
}

function sanitize(value, key = '') {
  if (sensitiveKey(key)) return '<redacted>'
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return safeString(value)
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => sanitize(item))
  if (typeof value === 'object') {
    const out = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === 'raw' || sensitiveKey(childKey)) continue
      out[childKey] = sanitize(childValue, childKey)
    }
    return out
  }
  return safeString(value)
}

function shape(value) {
  if (Array.isArray(value)) return { type: 'array', length: value.length, itemKeys: value[0] && typeof value[0] === 'object' ? Object.keys(value[0]).sort() : [] }
  if (value && typeof value === 'object') return { type: 'object', keys: Object.keys(value).filter((key) => key !== 'raw').sort() }
  return { type: typeof value }
}

const samples = {}
async function capture(name, fn, { expectedCodes = [] } = {}) {
  try {
    const value = await fn()
    samples[name] = { status: 'passed', shape: shape(value), value: sanitize(value) }
    return value
  } catch (error) {
    const code = String(error?.code || '')
    if (expectedCodes.includes(code)) {
      samples[name] = {
        status: 'passed',
        outcome: 'absent',
        error: sanitize({
          code,
          httpStatus: error?.httpStatus,
          platformStatus: error?.platformStatus,
          message: error?.platformMessage || error?.message || String(error),
        }),
      }
      return null
    }
    samples[name] = {
      status: 'failed',
      error: sanitize({
        code: error?.code,
        httpStatus: error?.httpStatus,
        platformStatus: error?.platformStatus,
        message: error?.platformMessage || error?.message || String(error),
      }),
    }
    return null
  }
}

const adapter = new LingxuAdapter({ baseUrl, eventId, cookie, timeoutMs: 30_000 })
const result = {
  capturedAt: new Date().toISOString(),
  platform: 'lingxu',
  contractVersion: PLATFORM_CONTRACT_VERSION,
  eventId,
  baseUrl: '<platform-origin>',
  credentials: { provided: true },
  mode: 'read-only',
  samples,
}

const summary = await capture('event.summary', () => adapter.eventSummary())
if (!summary) {
  result.status = 'failed'
} else {
  const capabilities = stageCapabilitiesFromSummary(summary)
  result.capabilities = capabilities
  await capture('event.type', () => adapter.eventType())
  await capture('event.leaderboard.user', () => adapter.leaderboard('user', { size: 5 }))
  await capture('event.theory.tests', () => adapter.theoryTests())
  const challenges = await capture('ctf.challenges', () => adapter.challenges())
  const challengeRows = Array.isArray(challenges)
    ? challenges.filter((row) => row?.id != null).slice(0, maxDetailSamples)
    : []
  let attachmentChallengeId = null
  let environmentChallengeId = null
  let environmentAddressSampled = false
  let sampledDetails = 0
  for (const row of challengeRows) {
    const detail = await capture(`ctf.challenge.${row.id}.detail`, () => adapter.challengeDetail(row.id))
    sampledDetails += 1
    if (!detail) continue
    if (attachmentChallengeId == null && detail.attachment) attachmentChallengeId = row.id
    if (environmentChallengeId == null && detail.requiresEnv) {
      environmentChallengeId = row.id
      const address = await capture(`environment.address.${row.id}`, () => adapter.getEnvironmentAddress(row.id))
      environmentAddressSampled = address != null
    }
    if (attachmentChallengeId != null && environmentAddressSampled) break
  }
  result.ctf = { sampledDetailCount: sampledDetails, maxDetailSamples }
  result.attachment = attachmentChallengeId != null
    ? { status: 'metadata-present', challengeId: attachmentChallengeId, url: '<platform-origin>/attachment/<redacted>' }
    : { status: 'not-present-in-sampled-challenges', sampledDetailCount: sampledDetails, maxDetailSamples }
  result.environment = environmentAddressSampled
    ? { status: 'address-sampled', challengeId: environmentChallengeId, mutation: 'not-run' }
    : environmentChallengeId != null
      ? { status: 'address-failed', challengeId: environmentChallengeId, mutation: 'not-run' }
      : { status: 'not-present-in-sampled-challenges', mutation: 'not-run', sampledDetailCount: sampledDetails, maxDetailSamples }

  if (capabilities.stages.awd === 'present') {
    const awdRows = await capture('awd.challenges', () => adapter.awdChallenges())
    await capture('awd.round-info', () => adapter.awdRoundInfo())
    await capture('awd.rank', () => adapter.awdRank())
    await capture('awd.dynamic', () => adapter.awdDynamic())
    const awd = Array.isArray(awdRows) ? awdRows.find((row) => row?.catId != null && row?.caId != null) : null
    if (awd) await capture(`awd.challenge.${awd.catId}.${awd.caId}.detail`, () => adapter.awdChallengeDetail(awd.catId, awd.caId))
  } else {
    await capture('awd.absent-contract', () => adapter.awdRoundInfo(), {
      expectedCodes: ['no-awd-stage', 'awd-not-open', 'awd-ended'],
    })
  }

  if (capabilities.stages.cfs === 'present') {
    const cfsRows = await capture('cfs.challenges', () => adapter.cfsChallenges())
    await capture('cfs.round-info', () => adapter.cfsRoundInfo())
    await capture('cfs.rank', () => adapter.cfsRank())
    await capture('cfs.chart', () => adapter.cfsChart())
    await capture('cfs.dynamic', () => adapter.cfsDynamic())
    const cfs = Array.isArray(cfsRows) ? cfsRows.find((row) => row?.cctId != null) : null
    if (cfs) await capture(`cfs.challenge.${cfs.cctId}.detail`, () => adapter.cfsChallengeDetail(cfs.cctId))
  } else {
    await capture('cfs.absent-contract', () => adapter.cfsRoundInfo(), {
      expectedCodes: ['no-cfs-stage', 'cfs-not-open', 'cfs-ended'],
    })
  }
  const failedSamples = Object.values(samples).filter((sample) => sample.status === 'failed')
  result.status = failedSamples.length ? 'partial' : 'passed'
}

const output = JSON.stringify(sanitize(result), null, 2)
if (outPath) {
  const target = path.resolve(outPath)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, `${output}\n`, { mode: 0o600 })
  console.log(`已写入脱敏合同样本：${target}`)
} else {
  console.log(output)
}

process.exit(result.status === 'failed' ? 1 : 0)
