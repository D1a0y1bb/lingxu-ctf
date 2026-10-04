#!/usr/bin/env node
/**
 * 端到端联调：用**真实的** lib/index.js + lib/tools.js + lib/store.js，
 * 对着**真实的**凌虚平台跑一遍完整链路（不提交 flag、不交卷）。
 *
 * 这是交付前最有说服力的一次验证：mock ctx 走宿主注册路径，
 * 工具走 defineTool 包装后的真实 execute，平台请求是真的。
 *
 * 用法：
 *  LINGXU_COOKIE_FILE=/path/cookie \
 *  LINGXU_BASE_URL=https://ctf.example.com:8000 \
 *  LINGXU_EVENT_ID=4 \
 *  node tests/e2e-live.mjs
 */

import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const BASE = process.env.LINGXU_BASE_URL || 'https://ctf.example.com:8000'
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
  console.log('⏭  未提供 LINGXU_COOKIE / LINGXU_COOKIE_FILE，跳过端到端联调。')
  process.exit(0)
}

// 隔离状态目录，不污染真实 ~/.dsh
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'lingxu-e2e-'))
process.env.DSH_HOME = home

const { apply, buildPanelState } = await import('../lib/index.js')

let failures = 0
function check(label, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`)
}

//  mock Cordis ctx：走真实的注册路径
const collected = { tools: [], routes: [], sections: [], commands: [] }
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: {
    register(def) {
      collected.tools.push(def)
      return () => {
        const i = collected.tools.indexOf(def)
        if (i >= 0) collected.tools.splice(i, 1)
      }
    },
  },
  get(name) {
    if (name === 'systemPrompt') return { section: (s) => { collected.sections.push(s); return () => {} } }
    if (name === 'webServer') {
      return {
        register: (r) => { collected.routes.push(r); return () => {} },
        tapIndex: () => () => {},
      }
    }
    if (name === 'commands') return { register: (c) => { collected.commands.push(c); return () => {} } }
    return undefined // 刻意不给 agentTeams：验证编排工具在缺服务时的报错路径
  },
  effect(fn) { fn(); return () => {} },
}

console.log(`平台 ${BASE}  event ${EVENT}  状态目录 ${home}\n`)
apply(ctx, { workDir: path.join(home, 'work'), concurrency: 4 })

check('插件加载并注册 17 个基础工具', collected.tools.length === 17, `实际 ${collected.tools.length}`)
check('注册系统提示词', collected.sections.length === 1)
check('注册 Web 路由', collected.routes.some((r) => r.path === '/lingxu-ctf/state'))
check('注册斜杠命令', collected.commands.length === 1)

const tool = (n) => collected.tools.find((t) => t.name === n)
const exec = { agent: undefined, signal: undefined, cwd: path.join(home, 'work') }

//  1. ctf_connect
console.log('\n── ctf_connect')
const connectText = await tool('ctf_connect').execute(
  { platform: 'lingxu', baseUrl: BASE, eventId: Number(EVENT), cookie, label: '端到端联调' },
  exec,
)
check('连接成功（返回里含用户名）', /xiyi|已连接|连接成功/.test(connectText), connectText.split('\n')[0].slice(0, 90))
check('返回里不回显完整 cookie', !connectText.includes(cookie), '凭据已脱敏')
check('提示 punish 扣分风险', /punish|扣分/.test(connectText))

//  1b. ctf_session（session 探活，只读）
console.log('\n── ctf_session')
const sessionText = await tool('ctf_session').execute({}, exec)
check('会话探活成功', /^✅ 凌虚会话有效/.test(sessionText), sessionText.split('\n')[0].slice(0, 90))
check('输出含剩余时间与 Cookie 摘要', /剩余|Cookie:/.test(sessionText))
check('探活不回显完整 cookie', !sessionText.includes(cookie), '凭据已脱敏')

//  2. ctf_status
console.log('\n── ctf_status')
const statusText = await tool('ctf_status').execute({}, exec)
check('拿到赛事总览', /题目|赛事/.test(statusText))
const totalMatch = /(\d+)\s*题/.exec(statusText)
check('解析出题目总数', totalMatch && Number(totalMatch[1]) > 0, totalMatch ? `${totalMatch[1]} 题` : statusText.slice(0, 120))
console.log(statusText.split('\n').slice(0, 8).map((l) => `   ${l}`).join('\n'))

//  3. ctf_challenges
console.log('\n── ctf_challenges')
const listText = await tool('ctf_challenges').execute({ solved: false, limit: 5 }, exec)
// 输出是 markdown 表格：统计「| 数字 |」开头的数据行（排除表头与分隔行）
const listedIds = listText
  .split('\n')
  .map((line) => /^\|\s*(\d+)\s*\|/.exec(line)?.[1])
  .filter(Boolean)
  .map(Number)
const listed = listedIds.length
check('列出未解题（limit=5 生效）', listed === 5)
check('条目数受 limit 约束', listed === 5, `列出 ${listed} 条`)
check('表格含 id 与分值列', /\|\s*id\s*\|/.test(listText) && /分值/.test(listText))
const targetChallengeId = listedIds[0] ?? 0
check('从真实题目列表解析题目 id', targetChallengeId > 0, `题目 #${targetChallengeId}`)

//  4. ctf_challenge（含附件下载路径）
console.log('\n── ctf_challenge')
const detailText = await tool('ctf_challenge').execute({ id: targetChallengeId }, exec)
check('拿到题面', /题目详情|题面|描述/.test(detailText), detailText.split('\n')[0].slice(0, 80))
const workFiles = await fsp.readdir(path.join(home, 'work', 'challenges')).catch(() => [])
check('题目工作目录已建立', workFiles.length > 0, workFiles.join(', '))

//  5. ctf_leaderboard
console.log('\n── ctf_leaderboard')
const boardText = await tool('ctf_leaderboard').execute({ kind: 'user', size: 5 }, exec)
check('拿到排行榜', /1\.|排名|分/.test(boardText), boardText.split('\n')[0].slice(0, 80))

//  6. ctf_theory（只读，不 begin/finish）
console.log('\n── ctf_theory (list)')
const theoryText = await tool('ctf_theory').execute({ action: 'list' }, exec)
check('拿到理论题列表', /理论题|单选|多选|判断/.test(theoryText), theoryText.split('\n')[0].slice(0, 90))

//  7. ctf_submit_flag 去重护栏（不真的提交：用已提交过的 flag）
console.log('\n── ctf_submit_flag 去重护栏')
const store = (await import('../lib/store.js')).getStore()
const conn = await store.resolveConnection({})
const connKey = (await import('../lib/store.js')).connectionKey(conn)
await store.recordSubmission({ connKey, challengeId: targetChallengeId, flag: 'flag{e2e-dedupe-probe}', status: 'correct' })
const dedupeText = await tool('ctf_submit_flag').execute({ id: targetChallengeId, flag: 'flag{e2e-dedupe-probe}' }, exec)
check('重复 flag 被去重拦截（未打到平台）', /已提交|重复|already/i.test(dedupeText), dedupeText.split('\n')[0].slice(0, 90))

//  8. ctf_solve_start 在无 agentTeams 时给出清晰报错
console.log('\n── ctf_solve_start（无 agentTeams 服务）')
// 设计约定：编排类工具在前置条件不满足时**硬失败**（抛异常），错误文案必须可读可照做
let solveMsg = ''
try {
  solveMsg = String(await tool('ctf_solve_start').execute({ limit: 2 }, exec))
} catch (error) {
  solveMsg = error?.message ?? String(error)
}
check('缺 agentTeams 时给出可读说明', /Agent Teams|agentTeams|orchestrator|Lead|调用/.test(solveMsg), solveMsg.slice(0, 110))

//  9. Web 面板快照
console.log('\n── /lingxu-ctf/state 快照')
const route = collected.routes.find((r) => r.path === '/lingxu-ctf/state')
let body = ''
await route.handler({ method: 'GET' }, { setHeader() {}, end(s) { body = s } })
const snapshot = JSON.parse(body)
check('快照 ok', snapshot.ok === true)
check('题目数 > 0', snapshot.stats.total > 0, `${snapshot.stats.total} 题，已解 ${snapshot.stats.solved}`)
check('含排行榜', Array.isArray(snapshot.leaderboard) && snapshot.leaderboard.length > 0, `${snapshot.leaderboard.length} 行`)
check('含我的排名', snapshot.rank && snapshot.rank.rank !== null, `第 ${snapshot.rank?.rank} 名`)
check('含分类看板', snapshot.challenges.length > 0, `${snapshot.challenges.length} 张卡片`)
// flag 现在明文展示（用户要求便于核对），真正必须脱敏的是凭据。
check(
  '提交审计：flag 明文 + 凭据脱敏',
  snapshot.submissions.every((s) => !/sessionid=|cookie/i.test(JSON.stringify(s))),
  JSON.stringify(snapshot.submissions[0] ?? {}).slice(0, 90),
)
check('含理论题信息', snapshot.theory.length > 0, JSON.stringify(snapshot.theory[0] ?? {}).slice(0, 90))

console.log(`\n${failures === 0 ? '✅ 端到端联调全部通过' : `❌ ${failures} 项失败`}`)
await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
process.exit(failures === 0 ? 0 : 1)
