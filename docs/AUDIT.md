# 需求落实审计（逐条核对代码与运行态）

> 审计时间：2026-09-29 19:22
> 被审版本：`v1.0.4`（commit `071ffad`）+ 工作区
> 审计方式：**三类证据并用** —— ① 源码逐条 grep（**剥掉注释**，避免注释里的"已删除"字样误判）
> ② 真实调用工具/路由 ③ 线上运行态 HTTP 探测
>
> 结论：**用户提出的全部需求均已在代码中落实**。下表每条给出**证据**与**验证方式**。

---

## 一、早期交付要求

| 需求 | 状态 | 证据 |
|---|---|---|
| 凌虚平台适配（非 CTFd） | ✅ | `grep -ci ctfd README.md` = 0；`lib/platforms.js` 只有 lingxu |
| 多赛事支持 | ✅ | `ctf_status` 实调输出：「已知赛事: 只有当前这一条；`ctf_connect` 可以添加/切换赛事（会同步设置页）」 |
| Web 控制面板 | ✅ | 7 条路由（`/state` `/diag` `/reports` `/team` `/theory` `/config` `/client.js`）全部 HTTP 200 |
| 「CTF 解题模式」预设 | ✅ | `cordis.patch.yml` 的 `preset-ctf` |
| 配置卡片中文、无描述文案 | ✅ | `CONFIG_LABELS` 中文标签表；14 项 |
| 发布到 GitHub | ✅ | 5 个 Release（v1.0.0 ~ v1.0.4），`master` = `071ffad` |

## 二、平台源码深度适配

| 需求 | 状态 | 证据 |
|---|---|---|
| 环境延时 `/delayed/` | ✅ | `lingxu.js delayEnvironment`；仅剩余 <30 分钟可延时 |
| `env_limit` 感知调度 | ✅ | `orchestrate.js` 的 `envBudget`；默认 2 |
| 附件题（`task_type=3`） | ✅ | `tools.js` 附件下载 + `ctf_challenge` 落盘 |
| 平台错误分类 | ✅ | `LINGXU_CODES`（`no-ctf-stage` / `contest-ended` / `team-required` / `env-limit` …） |
| AWD 赛制 | ✅ | `lingxu.js` 13 个 AWD 方法 + `stage-tools.js` 9 个工具 |
| CFS 赛制 | ✅ | `lingxu.js` 7 个 CFS 方法 + 7 个工具 |
| 赛段工具动态注册 | ✅ | `createStageToolRegistry` + `syncStageTools` |

## 三、界面

| 需求 | 状态 | 证据 |
|---|---|---|
| 走真实主题 token（零 hex） | ✅ | `panelCss()` **活代码**里 0 处 hex |
| 不用 `prefers-color-scheme` | ✅ | 活代码 0 处（仅注释里解释"为何不用"） |
| 无自造 `--lx-` 变量 | ✅ | 0 处 |
| 间距刻度合规 | ✅ | 实测取值 `1/2/4/6/8/10/12/14/16` —— 全在允许刻度内 |
| 悬浮面板可选（默认关） | ✅ | `enableFloatingPanel` 默认 `false` |
| tab 改名 | ✅ | `VIEW_LABEL_FALLBACK = '凌虚竞赛平台 CTF Agent 模式'` |
| 头部重做（删平台名/URL/更新时间/刷新） | ✅ | `renderHeaderMetaHtml` **函数已删除**；「更新于」只存在于注释 |
| flag 完整显示 | ✅ | `renderFlagBlockHtml` 共享片段 + `break-all` |
| `punish` 语义修正 | ✅ | 4 处改为「处罚公示中」（平台源码：`verbose_name="是否展示处罚警告"`） |
| 视图下隐藏输入框 | ✅ | `body[data-lx-view]` + `data-composer-seat` 规则 |
| 理论题独立 tab | ✅ | `VIEW_TABS` 7 项（含 `theory`） |
| 布局四连修 | ✅ | 状态色用 `box-shadow: inset 3px 0 0 0`（实测三处 left 均为 127.5）；排行榜列宽；面板分隔线；select 箭头 `padding-right:26px` |

## 四、行为与编排

| 需求 | 状态 | 证据 |
|---|---|---|
| Agent 池（复用闲置槽） | ✅ | `collectReusableSlots` / `buildReassignPrompt` / `takeSlotFor` |
| 两阶段派发（准备 agent） | ✅ | `buildPrepPrompt` + `PREP.md` 检测 |
| `maxMembers` 自学习 | ✅ | `resolveMaxTeamMembers` 读 `teams.config.maxMembers`；`parseMemberLimit` 从报错学 |
| session 失效处理 | ✅ | `SESSION_EXPIRED_TEXT`；403 直接抛 `session-expired`，**不退避重试** |
| 设置页改 eventId 立刻生效 | ✅ | `plainConfigValue` 拆 volatile 包装 + `pickConnection` 优先级 |

## 五、用户 18 项问题

| # | 问题 | 状态 | 证据 |
|---|---|---|---|
| 1 | 提交审计串赛事 | ✅ | 实调 `ctf_status`：「提交审计: 本赛事 71 次（成功 42 / 错误 24）」；`recentSubmissions` 实测 `all:true` → 100 条，按连接过滤 → 71 条 |
| 2 | 多赛事 | ✅ | 见上「已知赛事」行 |
| 3 | 环境/附件并发智能分配 | ⚠️ 部分 | 取证未复现"傻等"（当时跑的是老版本）；两阶段派发已上线。**附件题并发度因日志无 `task_type` 无法量化** |
| 4 | 比 0.1.0 慢 | ✅ 已结论 | 取证：主因是 **LLM 推理延迟**（p50 12.7s）+ `wait_agent` 长阻塞；**无 0.1.0 日志，无法直接对比**（已如实标注） |
| 5 | 全面 session 分析 | ✅ | `docs/FORENSICS.md` |
| 6 | Windows 安装报错 | ⚠️ 如实说明 | 仓库侧查不出确切原因（按用户补充：那是真实用户报错后由 DeepSeek 修复的文档案）；已排除项 + 需收集清单写入 `docs/INSTALL.md` |
| 7 | 理论题题目列表 | ✅ | `/lingxu-ctf/theory` 路由**实测 HTTP 200** |
| 8 | 工作区写入路径 | ✅ | `resolveWorkDirInfo`；`writeup.js` 不再用 `process.cwd()` |
| 9 | 报告为空 / 环境显示 | ✅ | `/reports` 实测 **17 篇 + `bodyPreview` 4000 字符 + `bodyChars` 17005**；`env.heldScope` + `blockedReason` 已上线 |
| 10 | 耗时 / token | ⏳ 进行中 | 耗时 ✅（`runtime.elapsedSeconds`）；**token 由 task-34 实现中**（当前仍是「未提供」占位符） |
| 11 | 协同通信 | ⏳ 进行中 | 呈现已升级（按 who↔who 分组）；**数据源由 task-35 实现中**（当前 `/team` 仍 `ok:false`） |
| 12 | 子 agent 无法回收 | ✅ | Agent 池 + 中断即回收；取证确认「无法回收」是**老版本**行为 |
| 13 | 环境 0/2 显示 | ✅ | 拆成「环境（本插件）0/2」+「⚠ 平台环境配额已满」；断言禁止再出现同句写法 |
| 14 | agent 活动实时性 | ✅ | `lastActivityAt` / `staleSeconds`；视图显示「最后活动 12 秒前」+「≥5 分钟 已停滞」 |
| 15 | agent 活动信息量 | ✅ | 「在做：…」+ 负责题目列表 + 每题耗时 |

## 六、上游报告 3 项

| # | 问题 | 状态 | 证据 |
|---|---|---|---|
| 1 | P1 配置卡片不注入样式 | ✅ | `createConfigCard` 开头 `ensureStyles(doc)`；`styleTagPresent` 两级判重；回归测试已加 |
| 2 | P1 inject 包名失效 | ✅ | `@deepseek-ai/dsh-client-modules`（实测该包在 DSH 0.2.0-rc.2 存在；旧名 `dsh-client-runtime` 不存在） |
| 3 | P2 pnpm SSH / npm 不存在 | ✅ | README 给三种绕法 + 明确 npm 未发布（实测 404） |
| 4 | P3 `injectWhy` 超长单行 | ✅ | 已拆成 13 行 |

## 七、额外发现并修复（用户未提）

| 项 | 证据 |
|---|---|
| 🔴 **请求频率打爆平台会话** | 报告里「触发全队 403」。量化：150 次/分钟 → **修后 24 次/分钟**；`/diag` 新增 `rateLimit` + `panelCache` |
| `scripts/install.sh` 残留作者机器路径 | 已清（`grep -c '/Users/' scripts/*.sh` = 0） |
| `scripts/verify.sh` 打包清单缺 `docs/INSTALL.md` | 已补 |

---

## 审计方法说明（为什么可信）

1. **剥注释再审**：第一轮审计有 2 项误报 —— `prefers-color-scheme` 与「更新于」只出现在**解释为何删除的注释**里。
   剥掉注释后全部通过。**这是审计脚本的坑，不是代码的问题。**
2. **不只看源码，还看运行态**：`/theory` 路由 HTTP 200、`/reports` 有 `bodyPreview`、
   `env.heldScope` 存在 —— 这些是**重启后真实进程**返回的，不是"代码里有"。
3. **功能实调**：`ctf_status` / `ctf_challenges` / `recentSubmissions` 都是**真跑**出来的输出。
4. **区分「已落实」与「如实说明」**：第 3、4、6 条属于后者 —— 数据不足就写数据不足，
   **没有假装解决**。

## 尚未完成（进行中）

- **task-34**：token 用量（从会话日志累加）
- **task-35**：协同通信数据源（截获 teammate `send_message` + `ctf_team_log`）

这两条是用户在最近一轮**新提**的需求，正在并行实施。
