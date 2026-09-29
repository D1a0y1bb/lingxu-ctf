#!/usr/bin/env node
/**
 * 真实平台冒烟测试（只读为主，不会提交 flag / 不交卷）。
 *
 * 用法：
 *   LINGXU_COOKIE_FILE=/path/to/lingxu.cookie \
 *   LINGXU_BASE_URL=https://shuxinbei.clsadp.com:8000 \
 *   LINGXU_EVENT_ID=4 \
 *   node tests/smoke-live.mjs
 *
 * 或者直接给 LINGXU_COOKIE="sessionid=...; csrftoken=..."
 *
 * 没有凭据时以退出码 0 跳过（不视为失败），便于在 CI 里安全运行。
 */

import { readFileSync } from 'node:fs'
import { LingxuClient, maskSecret } from '../lib/lingxu.js'

const BASE = process.env.LINGXU_BASE_URL || 'https://shuxinbei.clsadp.com:8000'
const EVENT = process.env.LINGXU_EVENT_ID || '4'

function readCookie() {
  if (process.env.LINGXU_COOKIE) return process.env.LINGXU_COOKIE.trim()
  const file = process.env.LINGXU_COOKIE_FILE
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim()
    } catch {
      return ''
    }
  }
  return ''
}

const cookie = readCookie()
if (!cookie) {
  console.log('⏭  未提供 LINGXU_COOKIE / LINGXU_COOKIE_FILE，跳过真实平台冒烟测试。')
  process.exit(0)
}

let failures = 0
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}

const client = new LingxuClient({ baseUrl: BASE, eventId: EVENT, cookie })
console.log(`平台：${BASE}  event：${EVENT}  cookie：${maskSecret(cookie)}\n`)

// 1. 认证
const info = await client.validateAccess()
check('认证有效', info?.user?.username, `用户 ${info?.user?.username}（${info?.user?.number}）`)
check('拿到 test_type', info?.test_type && Object.keys(info.test_type).length > 0, JSON.stringify(info?.test_type))
if (info?.punish) console.log('  ⚠ 本赛事 punish=true：错误 flag 会扣分')

// 2. 赛事详情
const detail = await client.eventDetail()
check('赛事详情', detail?.name, `${detail?.name}（${detail?.start_time} ~ ${detail?.end_time}）`)

// 3. 题目列表
const challenges = await client.challenges()
check('题目列表非空', challenges.length > 0, `${challenges.length} 题`)
const solved = challenges.filter((c) => c.solved)
check('已解状态可读', typeof challenges[0]?.solved === 'boolean', `已解 ${solved.length} / 待解 ${challenges.length - solved.length}`)
const cats = {}
for (const c of challenges) cats[c.category || '(未分类)'] = (cats[c.category || '(未分类)'] || 0) + 1
check('分类分布可读', Object.keys(cats).length > 0, Object.entries(cats).map(([k, v]) => `${k}:${v}`).join(' '))
const envCount = challenges.filter((c) => c.begun).length
console.log(`  ℹ 已开环境标记的题：${envCount}`)

// 4. 题目详情
const target = challenges.find((c) => !c.solved) || challenges[0]
const d = await client.challengeDetail(target.id)
check('题目详情', d?.name, `${d.name}｜${d.score} 分｜环境题=${d.requiresEnv}｜check模式=${d.checkMode}`)
check('题面转 Markdown', d.description.length > 0, `${d.description.length} 字符`)
if (d.attachment) console.log(`  ℹ 附件：${d.attachment}`)

// 5. 排行榜
const board = await client.leaderboard('user', { size: 10 })
check('个人排行榜', board.rows.length > 0, `共 ${board.total} 人，首位 ${board.rows[0]?.username}（${board.rows[0]?.score} 分）`)
const mine = await client.myRank()
check('我的排名可解析', mine.rank !== null, `第 ${mine.rank} / ${mine.total} 名，${mine.self?.score ?? 0} 分`)

// 6. 理论题
const tests = await client.theoryTests()
if (tests.length) {
  const t = tests[0]
  check(
    '理论题列表',
    t.id,
    `${t.name}｜${t.count} 题｜${t.timeSeconds}s｜题型 ${t.types.join('/')}｜状态=${t.statusLabel}（is_parse=${t.isParse} is_begin=${t.isBegin}）`,
  )
  check('理论题交卷状态字段可读', typeof t.isParse === 'boolean', `parse_count=${t.parseCount}`)
  // 只读：不 begin、不 answer、不 finish
  if (t.isBegin) {
    const time = await client.theoryTime(t.id).catch(() => null)
    console.log(`  ℹ 剩余时间：${JSON.stringify(time)}`)
  } else if (t.isParse) {
    console.log('  ℹ 试卷已交卷：平台不再开放题目列表（list/order 会 400「题目不是开启状态」），跳过拉题')
  } else {
    console.log('  ℹ 试卷未开始，跳过题目拉取（冒烟测试不触发 begin）')
  }
} else {
  console.log('⏭  该赛事没有理论题接口数据')
}

// 7. 通知与提交日志
const notices = await client.notices().catch(() => [])
console.log(`  ℹ 通知 ${notices.length} 条`)
const logs = await client.submitLogs().catch(() => [])
check('提交日志可读', Array.isArray(logs), `${logs.length} 条`)

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
