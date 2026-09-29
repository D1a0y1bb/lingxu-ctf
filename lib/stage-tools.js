/**
 * AWD / CFS 赛段工具（**按赛事类型动态注册**，装配在 `lib/index.js`）。
 *
 * 为什么单独一个文件 + 动态注册：
 * - 纯 CTF 赛事不该为 16 个用不到的 AWD/CFS 工具付上下文成本；
 * - 含 AWD/CFS 时又希望模型看到 `ctf_awd_submit` / `ctf_cfs_detail` 这种**自解释的独立工具名**
 *   （而不是一个 `ctf_stage` action 分发工具 —— 模型更容易选中、参数表更明确）。
 *
 * 导出（与 `lib/tools.js` 的 `buildToolSpecs` 同构，返回 ToolSpec 数组）：
 *   - `buildAwdToolSpecs(deps)` → 9 个 `ctf_awd_*`
 *   - `buildCfsToolSpecs(deps)` → 7 个 `ctf_cfs_*`
 *   - `recommendStageTools(summary)` → `{ awd: true|false|null, cfs: true|false|null, reason }`
 *     （纯函数，给装配层判断「该注册哪一套」用；`null` = 未探测到，建议**保持现状**别抖）
 *
 * 依赖方向：`stage-tools → tools / lingxu`（复用 spec 助手与错误渲染，保证文案一致）。
 * 反向依赖禁止：`tools.js` **不** import 本文件；动态注册由 `lib/index.js` 负责。
 *
 * deps 形状与 `buildToolSpecs` 完全一致（见 lib/tools.js 文件头）：
 *   `{ config, store, resolveAdapter, logger, now, ... }`
 */

import { isSessionExpired, maskSecret } from './lingxu.js'
import {
  CONNECTION_PARAM,
  clampInt,
  connectionLabel,
  defineSpec,
  errorMessage,
  formatDuration,
  formatStageWindow,
  log,
  markdownTable,
  maskToken,
  normalizeId,
  pId,
  pInt,
  pString,
  platformDetail,
  resolveAdapterFor,
  truncate,
} from './tools.js'

/** AWD 工具名（9 个，顺序即建议的展示顺序）。 */
export const AWD_TOOL_NAMES = [
  'ctf_awd_status',
  'ctf_awd_list',
  'ctf_awd_detail',
  'ctf_awd_submit',
  'ctf_awd_own_flag',
  'ctf_awd_rank',
  'ctf_awd_dynamic',
  'ctf_awd_reset',
  'ctf_awd_referee',
]

/** CFS 工具名（7 个）。 */
export const CFS_TOOL_NAMES = [
  'ctf_cfs_status',
  'ctf_cfs_list',
  'ctf_cfs_detail',
  'ctf_cfs_submit',
  'ctf_cfs_rank',
  'ctf_cfs_chart',
  'ctf_cfs_dynamic',
]

/**
 * 从 `eventSummary()` 判定该注册哪几套赛段工具（纯函数）。
 *
 * - `true` → 该赛段存在，注册；
 * - `false` → `testTypes` 明确没有该赛段，注销（**不要去调它的接口**：无 AWD 时
 *   `awd/rank/` 平台会 HTTP 500）；
 * - `null` → 拿不到 `testTypes`（旧适配器 / 请求失败）→ **保持现状**，不要注册也不要注销，
 *   等下一次 `ctf_connect` / 探活拿到确定结果再同步，避免工具列表抖动。
 *
 * @param {object} summary `adapter.eventSummary()` 的返回
 * @returns {{ awd: boolean|null, cfs: boolean|null, testTypes: object[], reason: string }}
 */
export function recommendStageTools(summary) {
  const types = Array.isArray(summary?.testTypes) ? summary.testTypes : []
  const ids = new Set(types.map((type) => Number(type?.id)).filter((id) => Number.isFinite(id)))
  const pick = (flag, id) => {
    if (typeof summary?.[flag] === 'boolean') return summary[flag]
    if (!types.length) return null
    return ids.has(id)
  }
  const awd = pick('hasAwd', 3)
  const cfs = pick('hasCfs', 4)
  const describe = (value, label) =>
    value === true ? `含 ${label}` : value === false ? `无 ${label}` : `${label} 未知`
  return {
    awd,
    cfs,
    testTypes: types,
    reason: `${describe(awd, 'AWD')}、${describe(cfs, 'CFS')}${
      awd == null || cfs == null ? '（未知项建议保持现状，别注册也别注销）' : ''
    }`,
  }
}

// ---------------------------------------------------------------- AWD（9）

function specAwdStatus(ctx) {
  return defineSpec({
    name: 'ctf_awd_status',
    description: [
      'AWD 赛段状态：是否进行中 / 当前回合 / 加固期 / 赛段剩余时间 / 我的排名 / 提交用 token（脱敏）。',
      '何时用：打完 AWD 第一件事看它 —— 确认赛段在跑、当前第几回合、加固期还剩多久。',
      '参数：connection 指定连接。纯只读。',
      '返回：状态 / 回合 / 加固期 / token 摘要（只显示前 6 位）+ 下一步（ctf_awd_list）。',
    ].join('\n'),
    parameters: { connection: CONNECTION_PARAM },
    async execute(args) {
      const { adapter, connection } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.awdRoundInfo !== 'function') return 'ℹ️ 当前平台适配器不支持 AWD 赛段信息。'
      const info = await adapter.awdRoundInfo()
      const lines = ['🛡️ AWD 赛段状态']
      lines.push(`- 连接: ${connectionLabel(connection)}`)
      lines.push(`- 状态: ${formatStageWindow(info) || '未知'}`)
      const countdown = []
      if (Number(info?.round) > 0) countdown.push(`回合 ${info.round}`)
      if (Number(info?.roundEndSeconds) > 0) countdown.push(`本回合剩余 ${formatDuration(info.roundEndSeconds)}`)
      if (info?.isReinforce) countdown.push(`⚠️ 加固期（剩余 ${formatDuration(info.reinforceEndSeconds)}）`)
      if (countdown.length) lines.push(`- 进度: ${countdown.join('｜')}`)
      if (info?.name) lines.push(`- 我的队伍/账号: ${info.name}${info.number ? `（${info.number}）` : ''}`)
      if (info?.rank != null) lines.push(`- 我的排名: 第 ${info.rank} 名`)
      lines.push(
        info?.token
          ? `- 提交 token: ${maskToken(info.token)}（ctf_awd_submit 会用；完整值不显示）`
          : '- 提交 token: （平台未返回，提交时可用 ctf_awd_submit 自动获取）',
      )
      lines.push('下一步: ctf_awd_list 看题目列表；防守用 ctf_awd_own_flag，攻击用 ctf_awd_submit。')
      return lines.join('\n')
    },
  })
}

function specAwdList(ctx) {
  return defineSpec({
    name: 'ctf_awd_list',
    description: [
      'AWD 题目（靶机）列表：catId / caId / 分类 / 本轮分 / 总分 / 靶机是否宕机 / 是否已被攻击。',
      '何时用：进入 AWD 后先列靶机；用 ctf_awd_detail 看某台的详情（需要 catId + caId）。',
      '参数：classify 按分类过滤；connection 指定连接。纯只读。',
      '返回：Markdown 表格 + 「下一步」（详情/防守/攻击各自用哪个工具）。',
    ].join('\n'),
    parameters: {
      classify: pString('按分类过滤（如 Web / Pwn），省略为全部分类'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.awdChallenges !== 'function') return 'ℹ️ 当前平台适配器不支持 AWD 题目列表。'
      const rows = (await adapter.awdChallenges(args.classify ? { classify: String(args.classify) } : {})) || []
      const list = Array.isArray(rows) ? rows : []
      if (!list.length) return 'ℹ️ AWD 题目列表为空（赛段可能未开始，或没有分配靶机）。'
      const table = markdownTable(
        ['catId', 'caId', '题目', '分类', '本轮分', '总分', '靶机', '被攻击'],
        list.map((row) => [
          row?.catId ?? '-',
          row?.caId ?? '-',
          truncate(row?.name || '-', 34),
          row?.classify || '-',
          row?.roundScore ?? 0,
          row?.testScore ?? 0,
          row?.checkStatus === false ? '❌ 宕机' : '✅ 正常',
          row?.isAttacked ? '⚠️ 是' : '否',
        ]),
      )
      return [
        `🛡️ AWD 靶机列表｜共 ${list.length} 题${args.classify ? `｜分类=${args.classify}` : ''}`,
        table,
        '下一步: ctf_awd_detail catId=<catId> caId=<caId>（**参数顺序 catId 在前**）；' +
          '防守 ctf_awd_own_flag；攻击 ctf_awd_submit flag=<flag>（token 自动获取）。',
      ].join('\n')
    },
  })
}

function specAwdDetail(ctx) {
  return defineSpec({
    name: 'ctf_awd_detail',
    description: [
      'AWD 靶机详情：靶机 IP / 镜像账号 / 攻击 IP 列表 / 重置次数 / 是否被攻击 / 题面。',
      '何时用：拿到 catId + caId（来自 ctf_awd_list）后看单台靶机；需要 envRunId 时也在这里拿。',
      '参数：catId（= CompetitionAwdTest.id）与 caId（= CompetitionAWD.id）**都必填，顺序是 catId → caId**；connection 指定连接。',
      '返回：靶机信息 + envRunId（ctf_awd_reset 用）+ 题面 + 后续动作提示。',
    ].join('\n'),
    parameters: {
      catId: { ...pId('AWD catId（= CompetitionAwdTest.id，来自 ctf_awd_list）'), required: true },
      caId: { ...pId('AWD caId（= CompetitionAWD.id，来自 ctf_awd_list）'), required: true },
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const catId = normalizeId(args.catId)
      const caId = normalizeId(args.caId)
      if (!catId || !caId) {
        return '❌ ctf_awd_detail 需要 catId 与 caId（都来自 ctf_awd_list）。注意顺序：catId 在前、caId 在后。'
      }
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.awdChallengeDetail !== 'function') return 'ℹ️ 当前平台适配器不支持 AWD 题目详情。'
      const detail = await adapter.awdChallengeDetail(catId, caId)
      if (!detail) return `❌ 平台未返回 AWD 靶机详情（catId=${catId} caId=${caId}）。`

      const lines = [`🛡️ AWD 靶机详情 — ${detail.name || `catId=${catId}`}`]
      lines.push(
        `- 分类: ${detail.classify || '-'}｜靶机状态: ${detail.checkStatus === false ? '❌ 宕机' : '✅ 正常'}｜被攻击: ${
          detail.isAttacked ? '⚠️ 是' : '否'
        }`,
      )
      if (detail.ipAddr) lines.push(`- 我的靶机: ${detail.ipAddr}`)
      if (detail.imgUser || detail.imgPassword) {
        lines.push(`- 镜像账号: ${detail.imgUser || '-'} / ${detail.imgPassword ? maskSecret(String(detail.imgPassword)) : '-'}`)
      }
      if (Array.isArray(detail.attackIp) && detail.attackIp.length) {
        lines.push(
          `- 攻击 IP: ${detail.attackIp.slice(0, 10).join(', ')}${
            detail.attackIp.length > 10 ? ` …共 ${detail.attackIp.length} 个` : ''
          }`,
        )
      }
      lines.push(
        `- 重置次数: 免费 ${detail.leftFreeResetNum ?? '-'} 次 / 共 ${detail.leftResetNum ?? '-'} 次` +
          `${detail.resetScore != null ? `（扣分重置每次 -${detail.resetScore}）` : ''}`,
      )
      if (detail.envRunId != null) lines.push(`- envRunId: ${detail.envRunId}（ctf_awd_reset 用）`)
      if (detail.errorMsg) lines.push(`- ⚠️ 环境异常信息: ${truncate(detail.errorMsg, 120)}`)
      lines.push('题面:', detail.description?.trim() || '（平台未返回题面文本）')
      lines.push(
        `下一步: 重置靶机 ctf_awd_reset envRunId=${detail.envRunId ?? '<envRunId>'}；` +
          '取自己 flag ctf_awd_own_flag（需在靶机本机）；提交打到的 flag ctf_awd_submit flag=<flag>。',
      )
      return lines.join('\n')
    },
  })
}

function specAwdSubmit(ctx) {
  return defineSpec({
    hardFail: true,
    name: 'ctf_awd_submit',
    description: [
      '提交 AWD flag（攻击视角）：把打到的目标 flag 交给平台计分。',
      '何时用：确认拿到别人的 flag 后立即提交（AWD 靠回合得分，晚了分就没了）。',
      '参数：flag 必填（打到的 flag）；token 可选（省略时自动从 AWD 赛段信息 / flag 接口获取）；connection 指定连接。',
      '平台细节：token 与 flag 走 **query 参数**（放 body 无效）；成功返回 status=1 + data。',
      '副作用：真实计分（不可撤销）；token 含凭据，输出只显示前 6 位。',
      '返回：✅ 提交成功 / ❌ 失败 + 平台原文 + token 脱敏摘要 + 下一步（看排名/动态）。',
    ].join('\n'),
    parameters: {
      flag: { type: 'string', required: true, description: '要提交的 flag（从目标靶机拿到的）' },
      token: pString('AWD token（可省略：自动从赛段信息/flag 接口获取；含凭据，输出会脱敏）'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const flag = String(args.flag ?? '').trim()
      if (!flag) return '❌ ctf_awd_submit 需要 flag（打到的目标 flag）。'
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.awdSubmitFlag !== 'function') return 'ℹ️ 当前平台适配器不支持 AWD flag 提交。'

      let token = String(args.token ?? '').trim()
      let tokenSource = '参数 token'
      if (!token) {
        try {
          if (typeof adapter.awdRoundInfo === 'function') {
            const round = await adapter.awdRoundInfo()
            if (round?.token) {
              token = String(round.token)
              tokenSource = 'AWD 赛段信息'
            }
          }
          if (!token && typeof adapter.awdFlagApi === 'function') {
            const api = await adapter.awdFlagApi()
            if (api?.token) {
              token = String(api.token)
              tokenSource = 'flag 接口'
            }
          }
        } catch (error) {
          log(ctx, 'warn', `[ctf] 自动获取 AWD token 失败：${errorMessage(error)}`)
        }
      }
      if (!token) {
        return [
          '❌ ctf_awd_submit 缺少 token，且自动获取失败（赛段信息与 flag 接口都没给）。',
          '   请显式传 token，或先用 ctf_awd_status 确认赛段状态。',
        ].join('\n')
      }

      const result = await adapter.awdSubmitFlag(token, flag)
      const ok = result?.ok === true || Number(result?.status) === 1
      return [
        ok ? '✅ AWD flag 提交成功' : '❌ AWD flag 提交失败',
        `- 平台返回: ${result?.message || '（无消息）'}`,
        `- token: ${maskToken(token)}（来源：${tokenSource}）`,
        `- flag: ${maskSecret(flag)}`,
        ok
          ? '下一步: ctf_awd_rank 看排名变化，ctf_awd_dynamic 看攻防动态。'
          : '请确认 flag 与 token 都正确（token 可在平台 AWD 页面获取）。',
      ].join('\n')
    },
  })
}

function specAwdOwnFlag(ctx) {
  return defineSpec({
    name: 'ctf_awd_own_flag',
    description: [
      '取**自己靶机**的 flag（防守视角）：用来确认自己服务里应该放的 flag 值。',
      '何时用：被攻击后确认 flag 是否被改；或提交自己的 flag 前核对。',
      '⚠️ 平台靠**请求来源 IP** 匹配靶机（源码 GetIP）：只有在**靶机本机**调用才有值，',
      '   在 agent 自己机器上调通常只拿到空字符串 —— 需要时请到靶机上 curl 平台的 /awd/get_flag/。',
      '⚠️ 只有题目 `flag_type=2`（flag 服务器）才返回 flag；`flag_type=1`（flag 文件）时 flag 在靶机文件里，需自己读。',
      '参数：connection 指定连接。纯只读。',
      '返回：✅ flag 值（或空 + 原因说明）。',
    ].join('\n'),
    parameters: { connection: CONNECTION_PARAM },
    async execute(args) {
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.awdGetOwnFlag !== 'function') return 'ℹ️ 当前平台适配器不支持取自己靶机的 flag。'
      const result = await adapter.awdGetOwnFlag()
      const lines = ['🚩 AWD 自己的 flag（防守视角）']
      if (result?.hasFlag) {
        lines.push(`- flag: ${result.flag}`)
        lines.push('  （这是你靶机的 flag；不要把整段对话分享出去）')
      } else {
        lines.push('- flag: （空）')
        lines.push(`- 原因: ${result?.hint || '平台未返回 flag'}`)
      }
      lines.push(
        '- ⚠️ 该接口靠**请求来源 IP** 匹配靶机：只有在**靶机本机**调用才有值；在 agent 本机调用通常返回空字符串。',
        '- ⚠️ 只有题目 `flag_type=2`（flag 服务器）才有值；`flag_type=1`（flag 文件）时 flag 在靶机文件里，需要自己读文件。',
      )
      return lines.join('\n')
    },
  })
}

function specAwdRank(ctx) {
  return defineSpec({
    name: 'ctf_awd_rank',
    description: [
      'AWD 排行榜：名次 / 队伍 / AWD 总分 / 本轮分 / 累计回合分（标出自己）。',
      '何时用：每轮提交后确认排位变化。',
      '参数：limit 显示前多少名（默认 30，上限 200）；connection 指定连接。纯只读。',
      '⚠️ 无 AWD 赛段时平台该接口会 HTTP 500（实测）：本工具会把它渲染成友好提示，而不是抛错。',
    ].join('\n'),
    parameters: {
      limit: pInt('显示前多少名，默认 30，上限 200'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.awdRank !== 'function') return 'ℹ️ 当前平台适配器不支持 AWD 排行榜。'
      let rows
      try {
        rows = (await adapter.awdRank()) || []
      } catch (error) {
        // session 失效要冒泡（交给统一渲染：让 agent 去更新 Cookie），别被下面的「友好降级」吞掉
        if (isSessionExpired(error)) throw error
        // 无 AWD 赛段时平台会 HTTP 500（实测）；给友好降级而不是抛错
        return [
          '⚠️ AWD 排行榜获取失败（平台在没有 AWD 赛段时该接口会 HTTP 500，这是平台行为）。',
          `- 平台返回: ${truncate(platformDetail(error) || errorMessage(error), 140)}`,
          '建议: 本工具通常只在含 AWD 的赛事注册；若你是手动调用，请确认本赛事是否有 AWD 赛段，CTF 榜用 ctf_leaderboard。',
        ].join('\n')
      }
      const list = Array.isArray(rows) ? rows : []
      if (!list.length) return 'ℹ️ AWD 排行榜为空（赛段可能未开始）。'
      const limit = clampInt(args.limit, 1, 200, 30)
      const table = markdownTable(
        ['名次', '战队/选手', 'AWD 总分', '本轮分', '累计回合分'],
        list.slice(0, limit).map((row) => [
          row?.rank ?? '-',
          `${row?.isSelf ? '👈 ' : ''}${truncate(row?.name || '-', 28)}`,
          row?.awdScore ?? 0,
          row?.roundAwdScore ?? 0,
          row?.totalRoundScore ?? 0,
        ]),
      )
      return [`🏆 AWD 排行榜｜共 ${list.length} 名（显示前 ${Math.min(limit, list.length)}）`, table].join('\n')
    },
  })
}

function specAwdDynamic(ctx) {
  return defineSpec({
    name: 'ctf_awd_dynamic',
    description: [
      'AWD 回合动态：谁攻击了谁、得分、对应靶机、发生在第几回合。',
      '何时用：看自己有没有被打、别人在打哪台、每题/每轮的攻防记分。',
      '参数：limit 显示前多少条（默认 30，上限 200）；connection 指定连接。纯只读。',
    ].join('\n'),
    parameters: {
      limit: pInt('显示前多少条，默认 30，上限 200'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.awdDynamic !== 'function') return 'ℹ️ 当前平台适配器不支持 AWD 回合动态。'
      const rows = (await adapter.awdDynamic()) || []
      const list = Array.isArray(rows) ? rows : []
      if (!list.length) return 'ℹ️ 暂无 AWD 回合动态（还没有攻防记分）。'
      const limit = clampInt(args.limit, 1, 200, 30)
      const table = markdownTable(
        ['状态', '攻击方', '被攻击方', '题目', '得分'],
        list.slice(0, limit).map((row) => [
          row?.statusLabel || row?.status || '-',
          truncate(row?.attackName || '-', 20),
          truncate(row?.attackedName || '-', 20),
          truncate(row?.testName || '-', 24),
          row?.score ?? 0,
        ]),
      )
      return [`⚔️ AWD 回合动态｜共 ${list.length} 条（显示前 ${Math.min(limit, list.length)}）`, table].join('\n')
    },
  })
}

function specAwdReset(ctx) {
  return defineSpec({
    name: 'ctf_awd_reset',
    description: [
      '重置 AWD 的 KVM 靶机（环境坏了/被改烂了时用）。',
      '何时用：靶机宕机、服务起不来、被对手改坏到无法恢复时。',
      '参数：envRunId 必填（从 ctf_awd_detail 的 `envRunId` 拿）；type 1=免费次数（默认）/ 2=扣分次数；connection 指定连接。',
      '⚠️ 副作用：消耗重置次数；type=2 会**直接扣分**（扣 resetScore），且会清空靶机上你自己的改动。',
      '返回：重置结果 + 平台原文。',
    ].join('\n'),
    parameters: {
      envRunId: { ...pId('KVM 靶机 env_run_id（来自 ctf_awd_detail）'), required: true },
      type: pInt('重置类型：1=免费次数（默认）；2=扣分次数（扣 resetScore）'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const envRunId = normalizeId(args.envRunId)
      if (!envRunId) return '❌ ctf_awd_reset 需要 envRunId（从 ctf_awd_detail 的 `envRunId` 拿）。'
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.awdResetKvm !== 'function') return 'ℹ️ 当前平台适配器不支持 KVM 靶机重置。'
      const type = Number(args.type) === 2 ? 2 : 1
      const result = await adapter.awdResetKvm(envRunId, { type })
      const ok = result?.ok === true || Number(result?.status) === 1
      return [
        `${ok ? '♻️ 靶机重置已触发' : '❌ 靶机重置失败'} — env_run_id=${envRunId}（type=${type}${
          type === 2 ? '，会扣分' : '，消耗免费次数'
        }）`,
        `- 平台返回: ${result?.message || '（无消息）'}`,
        '⚠️ 副作用: 重置会消耗次数（type=2 直接扣分）并清空靶机上的改动；确认后再用。',
      ].join('\n')
    },
  })
}

function specAwdReferee(ctx) {
  return defineSpec({
    name: 'ctf_awd_referee',
    description: [
      '呼叫 AWD 裁判（把问题发给管理员）。',
      '何时用：环境异常、被误判、题目描述有歧义且**确实需要人工介入**时。',
      '参数：content 必填（要发给裁判的说明：题目、现象、你的判断）；connection 指定连接。',
      '⚠️ 该动作会**真的给管理员写消息**：非必要不要调用，也不要重复刷屏（先看 ctf_awd_detail 的「环境异常信息」）。',
      '返回：是否已送达 + 平台原文。',
    ].join('\n'),
    parameters: {
      content: { type: 'string', required: true, description: '要发给裁判的说明（题目、现象、已尝试的操作）' },
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const content = String(args.content ?? '').trim()
      if (!content) return '❌ ctf_awd_referee 需要 content（要发给裁判的说明）。'
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.awdReferee !== 'function') return 'ℹ️ 当前平台适配器不支持呼叫裁判。'
      const result = await adapter.awdReferee(content)
      return [
        result?.ok === false ? '⚠️ 呼叫裁判未确认成功' : '📣 已呼叫裁判',
        `- 平台返回: ${result?.detail || '（无消息）'}`,
        '- ⚠️ 该动作会真的给管理员写消息：非必要不要调用，也不要重复刷屏。',
      ].join('\n')
    },
  })
}

// ---------------------------------------------------------------- CFS（7）

function specCfsStatus(ctx) {
  return defineSpec({
    name: 'ctf_cfs_status',
    description: [
      'CFS 赛段状态：是否进行中 / 赛段剩余时间（CFS 没有「回合」概念）。',
      '何时用：进入 CFS 前确认赛段在跑、还剩多久。',
      '参数：connection 指定连接。纯只读。',
    ].join('\n'),
    parameters: { connection: CONNECTION_PARAM },
    async execute(args) {
      const { adapter, connection } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.cfsRoundInfo !== 'function') return 'ℹ️ 当前平台适配器不支持 CFS 赛段信息。'
      const info = await adapter.cfsRoundInfo()
      return [
        '🎯 CFS 赛段状态',
        `- 连接: ${connectionLabel(connection)}`,
        `- 状态: ${formatStageWindow(info) || '未知'}`,
        '下一步: ctf_cfs_list 看关卡列表；一题多关卡，逐关提交用 ctf_cfs_submit。',
      ].join('\n')
    },
  })
}

function specCfsList(ctx) {
  return defineSpec({
    name: 'ctf_cfs_list',
    description: [
      'CFS 关卡题目列表：cctId / 题名 / 分值 / 通关进度（已过关卡/总关卡）。',
      '何时用：进入 CFS 后先列题；用 ctf_cfs_detail 看某题的关卡地址与附件。',
      '参数：connection 指定连接。纯只读。',
    ].join('\n'),
    parameters: { connection: CONNECTION_PARAM },
    async execute(args) {
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.cfsChallenges !== 'function') return 'ℹ️ 当前平台适配器不支持 CFS 关卡列表。'
      const rows = (await adapter.cfsChallenges()) || []
      const list = Array.isArray(rows) ? rows : []
      if (!list.length) return 'ℹ️ CFS 列表为空（赛段可能未开始，或没有题目）。'
      const table = markdownTable(
        ['cctId', '题目', '分值', '进度', '已通关卡'],
        list.map((row) => [
          row?.cctId ?? '-',
          truncate(row?.name || '-', 34),
          row?.score ?? 0,
          `${row?.solveSchedule ?? 0}/${row?.allSchedule ?? 0}`,
          row?.doneCount ?? 0,
        ]),
      )
      return [
        `🎯 CFS 关卡列表｜共 ${list.length} 题`,
        table,
        '下一步: ctf_cfs_detail cctId=<cctId> 看关卡地址与附件；提交 ctf_cfs_submit cctId=<cctId> flag=<flag>。',
      ].join('\n')
    },
  })
}

function specCfsDetail(ctx) {
  return defineSpec({
    name: 'ctf_cfs_detail',
    description: [
      'CFS 题目详情：分值/当前分、通关进度、关卡地址列表、附件、题面。',
      '何时用：准备做某道 CFS 题时（从 ctf_cfs_list 拿 cctId）；一题多关卡，逐关看。',
      '参数：cctId 必填（来自 ctf_cfs_list）；connection 指定连接。纯只读。',
    ].join('\n'),
    parameters: {
      cctId: { ...pId('CFS 题目 ID（来自 ctf_cfs_list 的 cctId）'), required: true },
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const cctId = normalizeId(args.cctId)
      if (!cctId) return '❌ ctf_cfs_detail 需要 cctId（来自 ctf_cfs_list）。'
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.cfsChallengeDetail !== 'function') return 'ℹ️ 当前平台适配器不支持 CFS 题目详情。'
      const detail = await adapter.cfsChallengeDetail(cctId)
      if (!detail) return `❌ 平台未返回 CFS 题目详情（cctId=${cctId}）。`
      const lines = [`🎯 CFS 题目详情 — ${detail.name || `cctId=${cctId}`}`]
      lines.push(
        `- 分值: ${detail.score ?? 0}（当前 ${detail.nowScore ?? 0}）｜进度: ${detail.solveSchedule ?? 0}/${
          detail.allSchedule ?? 0
        } 关`,
      )
      if (Array.isArray(detail.addrList) && detail.addrList.length) {
        lines.push('- 关卡地址:')
        for (const addr of detail.addrList.slice(0, 10)) lines.push(`  - ${truncate(String(addr), 100)}`)
      }
      if (Array.isArray(detail.annexList) && detail.annexList.length) {
        lines.push(`- 附件: ${detail.annexList.slice(0, 5).map((item) => truncate(String(item), 60)).join(' , ')}`)
      }
      if (detail.attachment) lines.push(`- 附件下载: ${detail.attachment}`)
      lines.push('题面:', detail.description?.trim() || '（平台未返回题面文本）')
      lines.push(`下一步: 通关后 ctf_cfs_submit cctId=${cctId} flag=<flag>（逐关提交）。`)
      return lines.join('\n')
    },
  })
}

function specCfsSubmit(ctx) {
  return defineSpec({
    hardFail: true,
    name: 'ctf_cfs_submit',
    description: [
      '提交 CFS 关卡 flag（一题多关卡，每关一个 flag）。',
      '何时用：攻下某道 CFS 的当前关卡后立即提交。',
      '参数：cctId 必填（来自 ctf_cfs_list）；flag 必填；connection 指定连接。',
      '副作用：真实计分（不可撤销）；提交后可用 ctf_cfs_detail 看是否还有下一关。',
      '返回：✅ 关卡通过（平台会回「恭喜攻克【题名】题目下的关卡【关卡名】」）/ ❌ 未通过。',
    ].join('\n'),
    parameters: {
      cctId: { ...pId('CFS 题目 ID（来自 ctf_cfs_list）'), required: true },
      flag: { type: 'string', required: true, description: '该关卡的 flag' },
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const cctId = normalizeId(args.cctId)
      const flag = String(args.flag ?? '').trim()
      if (!cctId) return '❌ ctf_cfs_submit 需要 cctId（来自 ctf_cfs_list）。'
      if (!flag) return '❌ ctf_cfs_submit 需要 flag。'
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.cfsSubmitFlag !== 'function') return 'ℹ️ 当前平台适配器不支持 CFS flag 提交。'
      const result = await adapter.cfsSubmitFlag(cctId, flag)
      const ok = result?.ok === true || Number(result?.status) === 1
      return [
        `${ok ? '✅ CFS 关卡 flag 正确' : '❌ CFS 关卡 flag 未通过'} — cctId=${cctId}`,
        `- 平台返回: ${result?.message || '（无消息）'}`,
        `- flag: ${maskSecret(flag)}`,
        '下一步: ctf_cfs_detail 看是否还有下一关；一题多关卡需要逐关提交。',
      ].join('\n')
    },
  })
}

function specCfsRank(ctx) {
  return defineSpec({
    name: 'ctf_cfs_rank',
    description: [
      'CFS 排行榜：名次 / 队伍 / CFS 分 / 优势分 / flag 数（标出自己）。',
      '何时用：确认自己的 CFS 排位。',
      '参数：limit 显示前多少名（默认 30，上限 200）；connection 指定连接。纯只读。',
      '注意：平台在**没有 CFS 赛段**时该接口仍会返回全体参赛者（分数全 0），所以它不能用来判断有没有 CFS 赛段。',
    ].join('\n'),
    parameters: {
      limit: pInt('显示前多少名，默认 30，上限 200'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.cfsRank !== 'function') return 'ℹ️ 当前平台适配器不支持 CFS 排行榜。'
      const rows = (await adapter.cfsRank()) || []
      const list = Array.isArray(rows) ? rows : []
      if (!list.length) return 'ℹ️ CFS 排行榜为空（赛段可能未开始）。'
      const limit = clampInt(args.limit, 1, 200, 30)
      const table = markdownTable(
        ['名次', '战队/选手', 'CFS 分', '优势分', 'flag 数'],
        list.slice(0, limit).map((row) => [
          row?.rank ?? '-',
          `${row?.isSelf ? '👈 ' : ''}${truncate(row?.name || '-', 28)}`,
          row?.cfsScore ?? 0,
          row?.cfsStrengths ?? 0,
          row?.cfsFlagCount ?? 0,
        ]),
      )
      return [`🏆 CFS 排行榜｜共 ${list.length} 名（显示前 ${Math.min(limit, list.length)}）`, table].join('\n')
    },
  })
}

function specCfsChart(ctx) {
  return defineSpec({
    name: 'ctf_cfs_chart',
    description: [
      'CFS 得分总势：每一路（前若干名）的分数曲线最新值 + 时间范围。',
      '何时用：想看走势而不是当前名次时（cfc_rank 给的是快照）。',
      '参数：connection 指定连接。纯只读。',
    ].join('\n'),
    parameters: { connection: CONNECTION_PARAM },
    async execute(args) {
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.cfsChart !== 'function') return 'ℹ️ 当前平台适配器不支持 CFS 得分总势。'
      const chart = (await adapter.cfsChart()) || {}
      const series = Array.isArray(chart.series) ? chart.series : []
      const lines = [`📈 CFS 得分总势｜${series.length} 条曲线`]
      if (chart.startTime || chart.endTime) {
        lines.push(`- 时间范围: ${chart.startTime ?? '-'} → ${chart.endTime ?? '-'}`)
      }
      const latest = (points) => {
        const list = Array.isArray(points) ? points : []
        const last = list[list.length - 1]
        return Array.isArray(last) ? last[1] : last
      }
      for (const row of series.slice(0, 10)) {
        lines.push(`  - ${truncate(row?.name || `#${row?.id ?? '-'}`, 26)}: 最新 ${latest(row?.points) ?? '-'}`)
      }
      if (!series.length) lines.push('（平台没有返回走势数据：可能赛段未开始，或该赛事不允许查看排行榜）')
      return lines.join('\n')
    },
  })
}

function specCfsDynamic(ctx) {
  return defineSpec({
    name: 'ctf_cfs_dynamic',
    description: [
      'CFS 提交流水：谁在什么时候提交了哪道题的哪一关。',
      '何时用：确认自己的提交是否生效、看别人进度。',
      '参数：limit 显示前多少条（默认 30，上限 200）；connection 指定连接。纯只读。',
    ].join('\n'),
    parameters: {
      limit: pInt('显示前多少条，默认 30，上限 200'),
      connection: CONNECTION_PARAM,
    },
    async execute(args) {
      const { adapter } = await resolveAdapterFor(ctx, args)
      if (typeof adapter.cfsDynamic !== 'function') return 'ℹ️ 当前平台适配器不支持 CFS 提交流水。'
      const rows = (await adapter.cfsDynamic()) || []
      const list = Array.isArray(rows) ? rows : []
      if (!list.length) return 'ℹ️ 暂无 CFS 提交流水。'
      const limit = clampInt(args.limit, 1, 200, 30)
      const table = markdownTable(
        ['时间', '提交者', '题目', '关卡'],
        list.slice(0, limit).map((row) => [
          row?.subTime || '-',
          truncate(row?.name || '-', 20),
          truncate(row?.testName || '-', 24),
          truncate(row?.flagTestName || '-', 20),
        ]),
      )
      return [`📜 CFS 提交流水｜共 ${list.length} 条（显示前 ${Math.min(limit, list.length)}）`, table].join('\n')
    },
  })
}

// ---------------------------------------------------------------- 装配

function stageContext(deps) {
  const options = deps || {}
  return {
    deps: options,
    config: options.config || {},
    store: options.store,
    logger: options.logger || {},
    now: typeof options.now === 'function' ? options.now : () => Date.now(),
  }
}

/**
 * 构造 AWD 赛段工具规格（9 个）。**只在赛事含 AWD 赛段时注册**。
 * @param {object} [deps] 与 buildToolSpecs 相同；缺省时仍能返回全部规格（执行时才需要依赖）
 * @returns {Array<object>} ToolSpec[]
 */
export function buildAwdToolSpecs(deps) {
  const ctx = stageContext(deps)
  return [
    specAwdStatus(ctx),
    specAwdList(ctx),
    specAwdDetail(ctx),
    specAwdSubmit(ctx),
    specAwdOwnFlag(ctx),
    specAwdRank(ctx),
    specAwdDynamic(ctx),
    specAwdReset(ctx),
    specAwdReferee(ctx),
  ]
}

/**
 * 构造 CFS 赛段工具规格（7 个）。**只在赛事含 CFS 赛段时注册**。
 * @param {object} [deps] 与 buildToolSpecs 相同
 * @returns {Array<object>} ToolSpec[]
 */
export function buildCfsToolSpecs(deps) {
  const ctx = stageContext(deps)
  return [
    specCfsStatus(ctx),
    specCfsList(ctx),
    specCfsDetail(ctx),
    specCfsSubmit(ctx),
    specCfsRank(ctx),
    specCfsChart(ctx),
    specCfsDynamic(ctx),
  ]
}

export default { buildAwdToolSpecs, buildCfsToolSpecs, recommendStageTools, AWD_TOOL_NAMES, CFS_TOOL_NAMES }
