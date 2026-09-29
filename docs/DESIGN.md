# dsh-lingxu-ctf — 设计文档

DSH 插件：把凌虚竞赛平台（Lingxu event CTF）接入 DSH，实现「给一个平台地址 + sessionid，
自动枚举赛题 / 排行榜 / 理论题，拉起并发解题 agent 团队，自动交 flag，自动写 WP」。

- 宿主版本基线：DSH Desktop `0.2.0-rc.1`（`@deepseek-ai/dsh-*` 全部 `0.2.0-rc.1`，Cordis `4.0.4`）；
  当前开发机实测 `0.2.0-rc.2`；上游报告在 `0.1.7-rc.1` 上可用（本仓库未复现）—— 兼容策略见 §10
- 目标 profile：`desktop`
- 分发渠道：**只有 GitHub**（`1.0.3` / tag `v1.0.3`）；npm 未发布（见 §10）
- 参考实现：`HuntingBlade`（凌虚 API 逆向来源）、`howmp/dsh-pentest`（bundle 打包范式）

---

## 1. 用户已确认的决策

| 决策点 | 选择 |
|---|---|
| 认证 | **只用 `sessionid` Cookie**（平台登录带验证码 `/api/captcha/verify/`，不做自动登录） |
| 理论题 | **全自动答题 + 自动交卷** |
| 交付范围 | 核心工具集 + **CTF 解题模式预设** + **WP 自动生成/提交** + **Web 控制面板** + **多赛事管理** + **AWD / CFS 赛段工具**（按赛事类型动态注册） |
| Flag 提交 | **全自动**（agent 判定为 flag 即提交）；check 模式自动改走 `/check/` |
| 并发 | 默认 **4** 个解题 agent，可配置 |
| 环境生命周期 | 时长**以平台下发为准**（`env_start_min`，实测 30 分钟）；剩余 <30 分钟可延时（+30 分钟/次），`envAutoDelay` 默认自动延一次 |
| 环境配额 | 平台 `env_limit` 默认 **2**；**只有环境型题目**受配额约束，非环境题不限量 |
| 分发方式 | **只发 GitHub**（clone / codeload tarball 钉 tag）；**npm 暂不发布**（用户决策），README 不提供 npm 安装路径 |
| 解题环境 | 本机 workspace，按需安装工具链（**不用 Docker**） |

> 非阻塞护栏（不违反"全自动"选择）：flag 去重、提交审计日志、每题错误次数统计并在面板展示。
> `punish: true` 时错误提交会扣分，护栏只记录不阻断，可用配置 `maxWrongAttempts` 主动收紧。

---

## 2. 凌虚平台 API（**基于平台 Django 源码** + 实测，event 4）

Base = 平台根地址，例如 `https://shuxinbei.clsadp.com:8000`（**不要**填前端 hash 路由）。
认证：`Cookie: sessionid=...`；写操作若 Cookie 里有 `csrftoken` 则附带 `X-CSRFToken` 头。

源码依据：用户提供的凌虚源码（`event_app/views/*.py`、`event_app/models.py`、`event_app/serializers.py`、
`admin_env/utils/docker_api.py`）。下表路径与文案逐条对齐源码，「关键返回」只列插件真正消费的字段。

### 2.1 通用

| 用途 | 方法 + 路径 | 关键返回 |
|---|---|---|
| 赛事详情 | `GET /event/{eid}/` | `name/start_time/end_time/status/label` |
| 赛事状态 | `GET /event/{eid}/info/` | `user{token,username,number}`、`test_type`（JSONField：`1` 理论题 / `2` CTF / `3` AWD / `4` CFS）、`punish`、`start_seconds/end_seconds`、`show_tools` |
| 赛事类型 | `GET /event/{eid}/type/` | ⚠️ **源码有坑**：只在 `test_type` 含键 `"1"/"2"/"4"` 时分别追加 `"1"/"2"`/**`"3"`** —— 它的 `"3"` 指 **CFS（key 4）**，**AWD（key 3）根本不会出现**。赛段判定一律用 `test_type` 的键（`hasAwd`/`hasCfs`） |
| 得分总势 | `GET /event/{eid}/chart/?type=` | 分数曲线 |
| 处罚记录 | `GET /event/{eid}/punish/?type=` | 分页 |
| 排行榜（个人） | `GET /event/{eid}/user/rank/?size=&type=` | `{count,results[{id,username,score,test_score,ctf_score,awd_score,parse_count,is_self}]}` |
| 排行榜（战队） | `GET /event/{eid}/team/rank/` | 同上结构 |
| WP 列表/提交 | `GET /event/{eid}/write_up/` / `POST /event/{eid}/write_up/` | 分页；POST 提交 writeup（form-encoded：`id`/`title`/`code`） |
| 通知 | `GET /event/{eid}/notice/` | 分页（已按时间倒序；**不含 type=5**，那是题目级提示，不是公告） |
| 通知未读数 | `GET /event/{eid}/notice/count/` | `{count}` |
| 提交日志 | `GET /event/{eid}/log/?type=1&test_type=2` | 分页 `{test_name,username,sub_time,type,test_type}` |

> 另有 5 个端点**客户端已实现、当前工具未调用**（留给后续功能 / 私有部署）：
> `GET /event/{eid}/ctf/time/`（CTF 倒计时 `{status(0 进行中/1 未开始/2 已结束),start_seconds,end_seconds}`；
> 未配置 CTF 赛段 → 400 `未配置CTF赛段`）、`GET /event/{eid}/ctf/name/`（题名列表 `[{id,name}]`）、
> `GET /event/{eid}/chart/?type=`（`{type,startTime,endTime,series[]}`）、
> `GET /event/{eid}/punish/?type=`（处罚，分页 `{user_list[],issue_time,content,type,score}`）、
> `GET /event/{eid}/log/`（提交流水）。
> ⚠️ **没有「个人中心」接口**（`/personal/`、`/platform/personal/` 在平台与代码里都不存在，本表已移除）。

### 2.2 CTF 题目与环境

| 用途 | 方法 + 路径 | 关键返回 |
|---|---|---|
| 题目列表 | `GET /event/{eid}/ctf/` | 分页 `{count,next,results[]}`；`results[]` = `{id,name,classify,score,ctf_id,is_parse,parse_count,is_begin,msg}`（**没有 `task_type`**，题型只能从详情拿） |
| 题目详情 | `GET /event/{eid}/ctf/{cid}/info/` | 源码 `EventCTFInfoView` **只返回**：`{name,desc(HTML),vuln_id,task_type,link_path,answer_mode,secondary_path,attachment,test_list,score,parse_count,is_parse,message}`。`flag_type`/`shared`/`property`/`min_score`/`pass_score`/`level`/`number`/`alias`/`manual`/`attachment_name` **在 `event_app` 任何接口里都不返回**（只在服务端算分/生成动态 flag 时用）——插件仍按「有就解析」兼容私有部署 |
| 开题 | `POST /event/{eid}/ctf/{cid}/begin/` | `{status}`：`1` 开启成功 / `2` 已经开启（都算成功），其余失败 |
| 起环境 | `POST /event/{eid}/ctf/{cid}/run/` | `{status}`：`2` 启动成功 / `3` 启动失败（`docker_api`，含「该环境正在启动」⇒ `env-busy`） |
| 取地址 | `GET /event/{eid}/ctf/{cid}/addr/` | `Env_RunSerializer`：`{id,name,domain_addr,run_time,error_msg,release_time,ext_id,instance_id,vuln_id,end_second}` + 视图补的 `classify`；优先公网 `domain_addr`，剩余时间优先 `end_second` |
| 环境延时 | `POST /event/{eid}/ctf/{cid}/delayed/` | `status==2`「成功延时30分钟」（固定 **+1800s**）；`3` +「剩余半小时后才能延时」= `too-early`（平台**只允许剩余 <30 分钟时延时**）／「该环境正在延时」= `busy`（Redis 锁 3 分钟）／「不存在的环境」= `missing`／「逻辑错误」（`release_time` 已过）= `expired` |
| 释放环境 | `POST /event/{eid}/ctf/{cid}/release/` | `status==2` 成功；`3` + "该环境正在释放"/"没有运行的环境" 视为幂等成功；HTTP 400 + "没有选择对应的环境" ⇒ `kind: not-configured`（平台没给这题配环境，跳过**不算失败**） |
| 交 flag（FLAG 模式） | `POST /event/{eid}/ctf/{cid}/flag/`，body `flag=<flag>`（form-encoded） | `status==1` 正确（动态计分带 `score`）/ `==2` 错误；**HTTP 400 = 业务拒绝**：`您已提交了正确的Flag。`（含战队版 `您所在的战队已提交了正确的Flag。`）⇒ `already_solved`；`此题目为check模式，请点击check进行得分` ⇒ 改走 `/check/`；另有 `比赛未开始`/`比赛已结束`/`未配置CTF赛段`/`FLAG错误`/`请输入flag` 等按码分类 |
| check 模式 | `POST /event/{eid}/ctf/{cid}/check/` | ⚠️ 源码自述「**简化版**」：视图**完全不读请求体、不比对 flag、不判分**，只写一条 `CTFLog` 后返回 `{status:1, detail:'check已触发'}`。400 文案：`此题目不为check模式`（源码）/ `此题目为Flag模式，请提交Flag进行得分`（线上实测，源码与部署不一致，两边都认）/ `该题目没有选择对应的CTF题目，请联系管理员。` / `check失败` |
| 环境数上限 | 由 `/run/` 的 400 文案体现 | `当前赛事限制启动{N}个题目环境，请释放后启动` ⇒ `env-limit`（错误对象带 `envLimit=N`，插件据此自学习真实上限） |

**环境生命周期**（源码 `models.py` + `views/env.py` + `admin_env/utils/docker_api.py`）：

- `release_time = now() + Competition.env_start_min 分钟` —— 模型默认 **60**，**实测本赛事 ≈30**
  ⇒ 插件一律以 `/addr/` 的 `end_second` / `release_time` 为准，**不写死时长**；
- 同时运行数量由 `CompetitionCTFs.env_limit` 限制（默认 **2**：个人赛一人 2 个 / 团队赛一队 2 个）；
- 延时**每次固定 +30 分钟**，且**只在剩余 <30 分钟时允许**；延时用的 Redis 锁 3 分钟防并发。

**题目分类字段**（源码 `models.py` 的 choices，逐字对齐）：
`CTF.test_type` = `1` 环境型 / `2` 外链型 / `3` 附件型（**详情接口返回**）；
`answer_mode` = `1` FLAG / `2` check（**详情接口返回**）；
`flag_type` = `1` 静态 flag / `2` 动态 flag（`flag_script`，仅环境型生效）——**这是模型字段，`event_app` 接口不返回**，
只在服务端算分时用，所以插件不依赖它（AWD 那边的 `flag_type` 是另一张表的字段，见 2.4）。

### 2.3 理论题

| 用途 | 方法 + 路径 | 关键返回 |
|---|---|---|
| 理论题列表 | `GET /event/{eid}/test/` | `[{id,name,type[],score,count,time_seconds,is_begin,is_end,is_parse,parse_count,start_time,end_time,answer_rule}]` |
| 开始理论题 | `POST /event/{eid}/test/{tid}/begin/` | `status==1` 成功 |
| 题目列表 | `GET /event/{eid}/test/{tid}/list/` | 分页题目（选项在 `content` 字典里，`option_type` 1 单选 / 2 多选 / 3 判断 / 4 填空） |
| 题序 | `GET /event/{eid}/test/{tid}/order/` | 题目顺序 |
| 剩余时间 | `GET /event/{eid}/test/{tid}/time/` | `{name,seconds}` |
| 答题 | `POST /event/{eid}/test/{tid}/answer/{qid}/`，**JSON** body `{"option":["B","C"]}` | 逐题提交；`option` 一律归一成数组：非填空题按键位 `sort()`，填空题（`option_type=4`）按空位顺序**不排序** |
| 交卷 | `POST /event/{eid}/test/{tid}/finish/`，**JSON** body `{"status":1}` | 不可逆；交卷后平台不再开放题目列表（`list`/`order` → 400「题目不是开启状态」） |

### 2.4 AWD 赛段（源码 `event_app/views/awd.py` + `utils/awd_flag.py`）

| 用途 | 方法 + 路径 | 关键返回 |
|---|---|---|
| 赛段信息 | `GET /event/{eid}/awd/info/` | `{status(1 未开始 / 0 进行中 / 2 已结束), start_seconds, end_seconds, round, round_end_seconds, reinforce_end_seconds, info_dict{token,name,number,rank}}`；加固期未结束时平台把 `round` 置 0 |
| 靶机列表 | `GET /event/{eid}/awd/` | 分页；`{cat_id, ca_id, awd_id, awd_name, classify, test_score, round_score, check_status, is_attacked, msg}` |
| 靶机详情 | `GET /event/{eid}/awd/{cat_id}/{ca_id}/info/` | ⚠️ **顺序是 cat_id → ca_id**（`cat_id = CompetitionAwdTest.id`，`ca_id = CompetitionAWD.id`）；返回 `test_ip_addr{ext_ip}`、`test_img_pass{username,password}`、`attack_ip[]`、`env_run_id`、`left_free_reset_num`、`left_reset_num`、`reset_score`、`is_attacked`、`check_status`、`run_status`、`error_msg`、`desc` |
| 提交 flag | `GET\|POST /event/{eid}/awd/flag/?token=&flag=` | ⚠️ **token 与 flag 必须放 query**（源码 `request.query_params.get`），放 body 无效；成功 `{status:1, data:'Flag提交成功！'}`，业务失败 HTTP 400 + `{error}` |
| 提交 API 地址 | `GET /event/{eid}/awd/flag/addr/` | `{API:"…/awd/flag/?token=<我的 token>&flag="}`；⚠️ **含自己的 token（凭据）**，日志/展示必须脱敏；⚠️ 源码**没有赛段校验**，没有 AWD 赛段时也照常返回 ⇒ 不能当赛段判据 |
| 自己靶机 flag | `GET /event/{eid}/awd/get_flag/` | ⚠️ 视图**无鉴权**、靠 `GetIP()` 匹配 `KvmEnvRun.ip_addr.ext_ip` ⇒ **必须在靶机本机调用**；只有 `flag_type=2`（flag 服务器）才有值，`flag_type=1`（flag 文件）返回空串 |
| 排行榜 | `GET /event/{eid}/awd/rank/` | 分页；`{id,name,awd_score,round_awd_score,total_round_score,is_self,awd_score_time,logo,topic_info[]}`。⚠️ 源码**没有赛段校验**，无 AWD 赛段时真实平台 **HTTP 500**（实测）⇒ 只能靠 `hasAwd` 判断 |
| 回合动态 | `GET /event/{eid}/awd/dynamic/` | ⚠️ 该视图**没有分页类**，返回**普通数组**；`{status, attack[], attack_name, attacked[], attacked_name, score, test_id, test_name, round_nums, update_time}` |
| 动态（可筛选） | `GET /event/{eid}/awd/dynamic/info/{query}` | 分页；支持 `status[]` / `test_id[]` / `round_nums[]` / `attack[]` / `attacked[]` / `ordering`（默认 -1 倒序） |
| 动态筛选项 | `GET /event/{eid}/awd/dynamic/awd_test/`、`GET /event/{eid}/awd/dynamic/awd_user/` | `[{id,test_name}]` / `[{id,username}]`（普通数组） |
| 重置靶机 | `POST /event/{eid}/kvm/{env_run_id}/reset/?type=1\|2` | `type`：`1` 免费次数（默认）/ `2` 扣分次数（扣 `reset_score`）；返回 `{status:1\|2, message}`（字段是 **message**，不是 `msg`） |
| 呼叫裁判 | `POST /event/{eid}/awd/referee/`，body `{content}` | 真的给管理员写一条消息 |

### 2.5 CFS 赛段（源码 `event_app/views/cfs.py` + `serializers/cfs.py`）

CFS = 场景化闯关：一道题下有多个**关卡**（`CFSFlag`，每关一个 flag / 分值），
进度用 `solve_schedule`（已通关卡数）/ `all_schedule`（总关卡数）表达。

| 用途 | 方法 + 路径 | 关键返回 |
|---|---|---|
| 赛段信息 | `GET /event/{eid}/cfs/info/` | `{status, start_seconds, end_seconds}`（**没有回合概念**） |
| 关卡列表 | `GET /event/{eid}/cfs/` | 分页；`{cct_id, cc_id, cfs_id, cfs_name, cfs_score, desc_content, solve_schedule, all_schedule, done_count, msg}` |
| 关卡详情 | `GET /event/{eid}/cfs/{cct_id}/info/` | 同上 + `now_score`、`addr_list[]`（关卡地址）、`annex_list[]`、`attachment` |
| 提交关卡 flag | `POST /event/{eid}/cfs/{cct_id}/flag/`，**JSON** body `{flag}` | `{status:1, data}` = 本关通过 |
| 排行榜 | `GET /event/{eid}/cfs/rank/` | 分页；`{cfs_score, cfs_strengths, cfs_flag_count, is_self, cfs_score_time, logo}`。⚠️ 无 CFS 赛段时**不报错**，仍返回全体参赛者（分数全 0）⇒ 不能当赛段判据，请用 `hasCfs` |
| 得分总势 | `GET /event/{eid}/cfs/chart/` | `{start_time, end_time, data:[{id,name,data[]}]}` |
| 大屏动态 | `GET /event/{eid}/cfs/dynamic/` | 普通数组（源码未启用分页）；`{id, name, test_name, flag_test_name, sub_time}` |

### 2.6 注意事项

- 题目列表分页：`next` 为相对路径，需要拼 base。AWD/CFS 的 `/awd/dynamic/`、`/cfs/dynamic/`、
  `/awd/dynamic/awd_test/`、`/awd/dynamic/awd_user/` **返回裸数组**（源码把分页类注释掉了），
  其余列表端点都带 `CommonPagination`（`page`/`size`，`max_page_size=1000`）——两种形状都兼容。
- `desc` 是 HTML，需转 Markdown 后给 agent。
- `attachment` 是相对路径，需 `urljoin(base, attachment)` 下载（只有**附件型**题目才有意义）。
- 连接信息格式：`domain_addr` 可能是 `host:port`，统一规范化为 `nc host port`；若是 URL 则原样保留。
- 平台可能只返回内网地址（`192.168.x.x`），此时优先公网；只有内网时原样返回并提示。
- **登录态失效**：实测 HTTP `403` + `{"detail":"未登录"}`（**不是 401**；少数接口 200 带 `detail` 也一并识别）
  ⇒ `code: session-expired`，所有工具统一提示「重新登录后复制新 Cookie，用 `ctf_connect` 更新」。
  ⚠️ **无法自动续期**：登录接口需要滑动验证码（`{username, password, captcha_ticket}`），
  且鉴权请求不回 `Set-Cookie`，Cookie 寿命在登录那一刻固定，只能手动换。
- **CSRF**：Cookie 里有 `csrftoken` 时写操作附 `X-CSRFToken`；实测**平台不强制**（不带也是 200），
  属于建议项而非必需，缺了只提醒不拒绝。
- **理论题状态**（`theoryTestStatus`，与平台前端一致）：
  `已交卷`（`is_parse`）> `进行中`（`is_begin`）> `已结束·未交卷`（`is_end`）>
  `已开始未交卷`（有 `start_time`）> `未开始`。⚠️ **交卷后平台会把 `is_begin` 变回 `false`**，
  只看 `is_begin` 会把已交卷误判成「未开始」。`parse_count` 是**交卷次数**，不是已答题数。
- **环境相关错误共 10 类**，逐条对应源码文案（`classifyEnvErrorPayload` / `isEnvBusyPayload` /
  `isEnvMissingPayload`）：未绑定 CTF 原题 `该题目没有选择对应的CTF题目` / 未配置环境 `没有选择对应的环境` /
  比赛未开启 / 比赛已结束 / 未加入战队 / 未配置 CTF 赛段 / 环境数超限（带 N）/
  环境忙碌（`该环境正在启动|释放|延时`）/ 环境不存在或已过期（`不存在的环境`、`逻辑错误`）/
  容器启动·释放失败（`docker_api` 的 `status=3`）。各类都带 `code`，不再是一句裸 400。
- **AWD/CFS 错误同样按码分类**（`awd-not-open` / `awd-reinforce` / `awd-round-cooldown` /
  `awd-self-attack` / `awd-duplicate` / `awd-target-down` / `awd-bad-token` / `awd-no-reset-quota` /
  `awd-reset-blocked` / `awd-env-unavailable` / `cfs-not-open` / `cfs-level-done` / …），
  文案逐条对齐源码；`无 AWD/CFS 赛段` 会被渲染成「本赛事没有该赛段」而不是报错。

---

## 3. 插件形态

一个 bundle：`cordis.patch.yml` 以 `insert` 注入 **两条 Loader 行**（宿主插件 + 预设），
客户端半**不占 Loader 行**，走 DSH 官方的 `dsh.client` 机制按需装配：

```yaml
- insert:
    - id: lingxu-ctf            # 宿主插件：工具 + 编排 + 存储 + Web 路由
      name: 'dsh-lingxu-ctf'
      config: { ... }
    - id: preset-ctf            # 「CTF 解题模式」预设
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: ctf, order: 5, name: 'CTF 解题模式', plugins: [...] }
```

客户端半（`lib/client.js`）由 `package.json` 的 `dsh.client` + `exports["./client"]` 声明，
`@deepseek-ai/dsh-client-modules` 的宿主半扫描 Loader 条目后自动组装并服务
（`/plugins/??<pkg>/client.js&rev=…`）；插件自己再在 `/lingxu-ctf/client.js` 托管一份同源副本。
**不要**手工往 `window.__DSH_BOOT__` 注入 boot graph —— 会被宿主后续的权威 graph 覆盖，
同 id 条目还会让 `parseBootManifest` 抛 duplicate 并拖垮整个客户端模块系统。

> 0.2.0-rc.1 的预设**不再扫描 YAML 目录**，改为 `@deepseek-ai/dsh-agent-preset` 行声明
> （见 `dsh-agent-preset-registry` README）。dsh-pentest 的 `preset/pentest/` 目录方案是 0.1.x 的旧做法，
> 本插件不用。

**工具列表是「16 个基础 + 按赛段动态」**：`Competition.test_type` 含 AWD（key 3）/ CFS（key 4）时，
`lib/index.js` 的 `createStageToolRegistry` 才把对应赛段工具 `ctx.tools.register()` 上去，
切走或探到「没有该赛段」时用 disposer 注销。纯 CTF 赛事只有 16 个工具，不占上下文（见 §5.2）。

---

## 4. 模块划分与写入范围

| 文件 | 职责 | 负责人 |
|---|---|---|
| `package.json` / `cordis.patch.yml` | bundle 声明、两条 Loader 行、预设 persona 与子插件清单 | Lead |
| `lib/lingxu.js` | 凌虚平台客户端（纯 `fetch`，零依赖）：题目/环境生命周期/理论题/AWD/CFS/错误分类 | Lead |
| `lib/platforms.js` | 平台适配器注册表（**只注册 lingxu**；非 lingxu 连接直接报错，不静默降级）+ `eventSummary()` 的赛段判定 | Lead |
| `lib/store.js` | 连接解析 + 提交审计 + 解题进度（环境 / teammate / taskId / `envLimitObserved`）+ 团队消息 | Lead |
| `lib/toolkit.js` | 零依赖 `defineTool` 兼容实现（参数 DSL → JSON Schema + 校验） | Lead |
| `lib/tools.js` | **16 个基础** `defineTool` 工具定义 | Teammate A |
| `lib/stage-tools.js` | **赛段工具**：`buildAwdToolSpecs`（9）/ `buildCfsToolSpecs`（7）/ `recommendStageTools`（三态判定） | Teammate A |
| `lib/orchestrate.js` | Agent Teams 并发编排 + **环境感知派发**（envLimit / 排队 / 前置探活） | Teammate B |
| `lib/client.js` | Web 界面（客户端半）：**顶部「CTF」视图 tab（6 子视图）** + 设置页配置卡片 + 按配置的浮动面板 | Teammate C |
| `lib/writeup.js` | WP 生成与提交 | Teammate D |
| `lib/index.js` | 宿主插件入口：装配上述模块 + 配置 schema/归一化 + Web 路由 + 会话身份捕获 + **赛段工具动态注册器** | Lead |
| `tests/*.test.mjs` | 单元测试（mock ctx + mock fetch） | 各自 |

> 预设 persona 文案**没有独立模块**（不存在 `lib/preset.js`）：它写在 `cordis.patch.yml`
> 的 `preset-ctf` 行里（`@deepseek-ai/dsh-persona` 的 prefix / suffix），随 bundle 一起安装。

**依赖方向**：`tools/stage-tools/orchestrate/writeup` → `lingxu/platforms/store`；
`tools` → `toolkit`；`stage-tools` → `tools`（复用 `defineSpec` / `resolveAdapterFor` 等）。
反向依赖禁止。`index.js` 只做装配与路由，不含业务逻辑。

---

## 5. 工具清单（模型可见）

### 5.1 基础工具（16 个，永远注册）

| 工具名 | 作用 |
|---|---|
| `ctf_connect` | 配置平台地址 + sessionid，校验连通性并持久化；成功后同步赛段工具 |
| `ctf_session` | **探活**：只读地确认 sessionid 仍有效（开赛前 / 403 后 / `ctf_solve_start` 前置检查） |
| `ctf_status` | 赛事总览：名称/时间/赛段构成/我的分数排名/已解/待解/理论题状态/未读公告数 |
| `ctf_challenges` | 题目列表，支持按分类/状态/分值过滤 |
| `ctf_challenge` | 单题详情（题面 Markdown + 题型 + 附件下载 + 连接信息） |
| `ctf_start_env` | 环境型 `begin→run→addr`，返回连接信息 + 剩余时间；必要时按 `envAutoDelay` 自动延时一次 |
| `ctf_delay_env` | 环境延时（+30 分钟/次；平台只允许剩余 <30 分钟时延时） |
| `ctf_release_env` | 释放环境（幂等；让位给排队的环境题） |
| `ctf_submit_flag` | 提交 flag（去重 + 审计 + 错误计数）；check 模式自动改走 `/check/` |
| `ctf_leaderboard` | 个人/战队/AWD/CFS 排行榜 |
| `ctf_theory` | 理论题：列出试卷 / 开始 / 拉题 / 作答 / 交卷。`action=answer` 的 `option` 支持 **string \| array**：单选 / 判断 `"B"` 或 `["B"]`；多选 `"BCD"` 或 `["B","C","D"]`（按平台规则按键位排序）；填空 `["答案1","答案2"]`（按空位顺序，**不排序**） |
| `ctf_notice` | 赛事公告：未读条数 + 列表（`unreadOnly` 按未读数截取最新 N 条） |
| `ctf_solve_start` | 拉起并发解题 agent 团队（默认 4），建共享任务板；**环境感知派发** |
| `ctf_solve_status` | 团队进度：任务板 + 平台状态对照 + 环境占用 / 排队 / 已解仍占环境提示 |
| `ctf_solve_stop` | 中断所有解题 agent、释放环境 |
| `ctf_writeup` | 生成 / 提交 WP |

> 试卷状态判定顺序（`theoryTestStatus`）：`已交卷`（`is_parse`）> `进行中`（`is_begin`）>
> `已结束·未交卷`（`is_end`）> `已开始未交卷`（有 `start_time`）> `未开始`；
> 交卷后 `is_begin` 会变回 `false`，`action=list` 展示的「交卷次数」列取 `parse_count`。
> 已交卷的试卷平台不再开放 `list` / `order`（400「题目不是开启状态」）。

### 5.2 赛段工具（**按赛事类型动态注册/注销**）

由 `lib/stage-tools.js` 提供，注册依据是 `Competition.test_type` 的键（1 理论题 / 2 CTF / 3 AWD / 4 CFS）：

| 赛段 | 工具（数量） |
|---|---|
| AWD（key 3） | `ctf_awd_status` / `ctf_awd_list` / `ctf_awd_detail` / `ctf_awd_submit` / `ctf_awd_own_flag` / `ctf_awd_rank` / `ctf_awd_dynamic` / `ctf_awd_reset` / `ctf_awd_referee`（**9**） |
| CFS（key 4） | `ctf_cfs_status` / `ctf_cfs_list` / `ctf_cfs_detail` / `ctf_cfs_submit` / `ctf_cfs_rank` / `ctf_cfs_chart` / `ctf_cfs_dynamic`（**7**） |

- 触发点：插件启动时探一次 + `ctf_connect` 成功后 + `ctf_status` / `ctf_session` 跑完（复用它们已经拿到的
  `eventSummary()`，零额外请求）；
- `recommendStageTools()` 返回**三态**：`true` 注册 / `false` 注销 / `null`（拿不到 `testTypes`）**保持现状** ——
  避免一次网络抖动就让工具列表抖动；`createStageToolRegistry` 按 `awd|cfs` 签名做增量同步，
  `ctx.tools.register()` 的 disposer 负责注销；
- 注册失败/模块缺失不拖垮插件：`lib/stage-tools.js` 用动态 import 容错，缺失时只保留 16 个基础工具。

---

## 6. 编排设计（`ctf_solve_start`）

1. **前置探活**：先探一次 session；失效则**不建任务、不 spawn**，直接返回更新 Cookie 的指引
   （避免 agent 集体撞 403、丢 flag）
2. 同步平台题目列表 → 过滤未解题（可按分类/最低分值/数量上限过滤）
3. 每题 `ctx.agentTeams.createTask({ subject, description, writeScopes })` 建共享任务
4. **环境感知派发**（`planSpawns`）：批内先填**非环境题**（不受配额限制），再按
   `envBudget = envLimit - 当前已占用` 填**环境型**题目；预算用尽的环境题进入**排队**，
   等环境释放后由下一轮 `ctf_solve_start` 补派（`ctf_solve_status` 会列出排队清单）
5. 按 `concurrency`（默认 4）分批 `ctx.agentTeams.spawnTeammate(lead, {...})`，命名 `solver-<slug>`
6. teammate prompt 自带：平台地址、凭据引用、题目 id、任务 id、题型与环境配额说明、工作流
   （`ctf_challenge` → `ctf_start_env` → 解题 → `ctf_submit_flag` → `ctf_writeup` → 完成任务 → 释放环境）
7. teammate 之间可用 `send_message` 互相交流；共享任务板天然去重（claim 语义）
8. 返回编排摘要（含环境调度行）；后续用 `ctf_solve_status` 查询进度

**环境上限来源（三级，零配置可用）**：`config.envLimit`（显式配了就用）→ **平台实测**
（`ctf_start_env` 撞上限时把平台报错里的 N 写进 work 记录的 `envLimitObserved`）→
平台源码默认值 `2`。运行中的环境按 work 记录统计（`envStarted && !envReleased && 未到释放时间`）。

**题型探测**：列表接口**没有 `task_type`**，只有 `/ctf/<id>/info/` 有。编排层按
「本轮缓存 → work 记录（`ctf_challenge` 曾回写）→ 探测一次详情并回写」取，探测有并发与数量上限；
探测失败按非环境题处理（宁可派出去让 `ctf_start_env` 报错自学习，也不要空转）。

**环境回收**：`ctf_solve_status` 会单独列出「♻️ 已解出但仍在占用环境」，提示立刻释放让位。

**并发上限**：`ctx.agentTeams` 的 `maxMembers` 默认 16，`ctx.subagents` 的 `maxActiveSubagents` 默认 8。
本插件 `concurrency` 默认 4、上限 8；环境型题目的实际并发还受 `envLimit` 约束。

---

## 7. 安全与凭据

- Cookie 只写入 DSH 自己的存储（`storageDomain` / `~/.dsh`），不写入插件目录、不进 git。
- 平台 URL 与 Cookie 通过 `ctf_connect` 传入，落到 `store`，日志中脱敏（`maskSecret`：首 6 位 + `…` + 末 2 位 + 长度；
  flag 走 `maskFlag`：首 6 位 + 掩码 + 末 2 位）。
- **AWD token 也是凭据**：`/awd/flag/addr/` 与 `/awd/info/` 都会回自己的 token，
  工具里只展示前 6 位，不整条输出；AWD flag 提交必须走 query 参数（平台源码要求），不要在日志里回显完整 URL。
- Cookie **无法自动续期**：登录需滑动验证码，鉴权请求不回 `Set-Cookie`，失效（403 +「未登录」）后只能手动更新。
- 所有出站请求只指向用户配置的平台 base，不做任何第三方外发。

---

## 8. 验收标准

1. `node --test tests/*.test.mjs` 全绿
2. 用真实 event 4 + 真实 cookie 跑通：`ctf_status` / `ctf_challenges` / `ctf_leaderboard` 返回正确数据
3. 插件装入 `desktop` profile 后重启，工具在会话中可见（纯 CTF 赛事 **16 个基础工具**），
   预设「CTF 解题模式」出现在模式选择
4. `ctf_solve_start` 能真实拉起 N 个 teammate 并建出任务板；含环境型题目时按 `envLimit` 限量、其余排队
5. 含 AWD / CFS 的赛事：`ctf_connect` 或 `ctf_status` 后对应赛段工具（9 / 7 个）自动出现，切走自动注销
6. Web 界面三件套可用：顶部「CTF」视图 tab（**6 个子视图**，含「环境」配额与倒计时）、设置页配置卡片、
   打开 `enableFloatingPanel` 后的右下角浮动面板

---

## 9. 实现状态（截至交付）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 单元测试 | ✅ | `node --test` → **468 用例全绿**（客户端 106 + 工具 101 + 平台客户端 80 + 编排 61 + 装配 46 + …） |
| 真实平台冒烟 | ✅ | `tests/smoke-live.mjs` 对 event 4 全通过（78 题 / 15 分类 / 排行榜 / 理论题） |
| 端到端联调 | ✅ | `tests/e2e-live.mjs` 22/22：真实插件装配 + 真实平台，含 flag 去重护栏与面板快照 |
| 真实 Cordis 装配 | ✅ | 用解包出的同一份 Cordis 跑 `ctx.plugin()`：注册 **16 个基础工具**，可选 service 全缺失仍装配成功 |
| 赛段工具动态注册 | ✅ | `createStageToolRegistry` + `recommendStageTools` 三态语义有单测覆盖（含「未知不注销」与增量签名） |
| 装入 profile | ✅ | `dsh-lingxu-ctf` 已在 `desktop` profile 的 `dsh.profile.bundles` + `node_modules`（link:） |
| 重启后生效 | ⏳ | Node ESM 缓存按 URL 永久生效，**必须重启 DSH** 才会 import 新代码 |
| 浏览器视觉验收 | ⏳ | 需人工刷新确认（客户端逻辑已有 `tests/client.test.mjs` 106 条覆盖，含视图门控、环境倒计时、主题 token） |
| 真实拉起 teammate | ⏳ | 需重启后在会话里实际调用 `ctf_solve_start` 验证 |
| 真实 AWD / CFS 赛段 | ⏳ | 需在含该赛段的真实赛事上跑一遍（当前 event 4 是纯 CTF） |

### 交付过程中修掉的真实缺陷（均由跨模块复核发现，非单测能覆盖）

1. **Cordis Proxy 守卫**：`ctx.agent` 抛 `cannot get property "agent" without inject` ⇒ 插件整体
   `fiberPhase: failed`。改为统一的 `service(ctx, name)` 兜底访问器，并加严格 Proxy 回归测试。
2. **`ctf_solve_*` 未透传 `exec.agent`** ⇒ 三个编排工具在生产环境全不可用（单测因 mock 掉了
   orchestrator 而全绿）。补 `__agent`/`__signal`。
3. **环境记录形状不一致**：`ctf_start_env` 只写嵌套 `env`，而 `orchestrate.stop` 与 `writeup`
   读顶层字段 ⇒ 停止时永不释放环境、WP 时间线永远「未记录开始时间」。改为双写。
4. **slug 实现四份分歧**：`Baby Heap!` 在编排层是 `baby-heap!-12`，而 `ctf_challenge` 下到
   `baby-heap-12` ⇒ solver 被指到没有附件的目录。统一为「只剔路径危险字符」流派。
5. **`SCOPE_ID_RE` 非贪婪反解**：`challenges/baby-heap-12` 被解成 `heap-12` ⇒ status 对照错乱、
   stop 漏释放。改贪婪前缀 + 尾部不含 `-`。
6. **WP 提交截断**：提交/预览复用了复现脚本的 8KB 截断读取器，>8KB 的 WP 会被截断提交。
   改为不截断读取。
7. **`store.resolveConnection` 部分匹配**：只传 `eventId`（不带 `baseUrl`）时无法构造 key ⇒
   永远解析不到连接。改为按已提供字段做部分匹配。

### 第二批改动（理论题 / 顶部视图 / 界面开关）

1. **理论题打通**（对照平台前端 `main.chunk.js` 纠正）：
   - 作答 / 交卷请求体从 form-encoded 改为 **JSON**（`{"option":[...]}` / `{"status":1}`）——
     原先发 `option=B` 字符串会被平台判 500；`option` 同时接受 string 与 array，统一归一成数组，
     非填空题按键位排序、填空题按空位顺序。
   - 状态判定改用 `is_parse` 优先：**交卷后平台把 `is_begin` 变回 `false`**，旧逻辑会把已交卷的试卷
     显示成「未开始」（`ctf_status` / 面板 / 视图三处都踩过，已全部修正）。
   - 明确「已交卷的试卷平台不再开放 `list` / `order`」（400「题目不是开启状态」）。
2. **顶部「CTF」视图 tab + 团队数据路由**：新增 `lib/client.js` 的 `conversation.view` 注册
   （当时 5 个子视图，第三批扩到 6 个）与宿主的 `GET /lingxu-ctf/team`、`GET /lingxu-ctf/reports`；
   视图只在 CTF 预设会话显示（`isCtfSession` 沿 `parentId` 上溯），两种「无法判定」情形降级为始终显示。
   `/team` 依赖会话内捕获的 caller（HTTP 路由没有 `exec.agent`）。
3. **界面开关与布局**：新增配置项 `enableFloatingPanel`（**默认 false**，浮动面板不再默认挂载，
   主入口改为顶部视图）；重做设置页配置卡片布局；厘清 `enableWebPanel` 的语义 ——
   它只控制宿主侧 `/lingxu-ctf/*` 路由是否注册（界面数据来源），客户端半仍由 `dsh.client` 独立装配。

### 第三批改动（平台源码适配 + AWD/CFS + 环境视图）

1. **不再靠反推，改为对照平台 Django 源码适配**（`event_app/views/*.py`、`models.py`、`docker_api.py`）：
   - **环境有 TTL**：`release_time = now() + env_start_min`（模型默认 60，**实测本赛事 ≈30**）——
     一律以 `/addr/` 的 `end_second` 为准；起环境后剩余不足 30 分钟自动延时一次（`envAutoDelay`），
     剩余 <10 分钟主动告警；新增 `ctf_delay_env`（+30 分钟/次，**只在剩余 <30 分钟时允许**）。
   - **环境数上限 `env_limit` 默认 2**：编排改为**环境感知调度** —— 非环境题不限量，只有环境型题目吃配额；
     上限来源 = `config.envLimit` → 平台报错自学习（`envLimitObserved`）→ 默认 2。
   - **题型三类**：`task_type` 1 环境型 / 2 外链型 / 3 **附件型**（之前漏了附件型，现在会下载附件）。
   - **环境错误 10 类精确分类**（未绑定 CTF 原题 / 未配置环境 / 比赛未开启 / 已结束 / 未加入战队 /
     未配置 CTF 赛段 / 环境数超限 / 忙碌 / 不存在·已过期 / 容器启动失败），不再是裸 400。
   - **check 模式走 `/check/`**：平台源码自述「简化版」——不读 body、不判分，只写检测日志，
     因此文档与工具文案都强调「触发 ≠ 判定」。
   - **已解题目重复提交是 HTTP 400**（`您已提交了正确的Flag。`）⇒ 正确分类成 `already_solved`。
2. **AWD / CFS 两种赛制**：新增 `lib/stage-tools.js`（AWD 9 + CFS 7），**按 `Competition.test_type` 动态注册**
   （16 基础工具零上下文浪费）；`recommendStageTools` 三态 + 注册器增量同步。
   三个实测坑写进代码与文档：`/event/{pk}/type/` 的 `"3"` 是 **CFS 不是 AWD**；无 AWD 时 `awd/rank/` **HTTP 500**；
   无 CFS 时 `cfs/` 不报错返回空、`cfs/rank/` 还返回全体参赛者 ⇒ 判据只能是 `hasAwd`/`hasCfs`。
3. **`ctf_session` 探活**（工具 13 → 14 → 本轮 16）：开赛前 / 403 后 / `ctf_solve_start` 前置检查；
   编排层 session 失效时**不建任务不 spawn**，`ctf_solve_status` 顶部加 🛑 横幅。
4. **界面第三轮重做**：改用 **DSH 真实主题 token**（`--dsw-alias-*`）；修掉 `@media (prefers-color-scheme:dark)`
   这个真 bug（DSH 用 `body[data-ds-dark-theme]`）与「品牌色猜成蓝色」（实际近黑）；
   新增**题型徽章**、**环境剩余时间**（<10 分钟橙色 / 过期红色）、**环境占用 `环境 1/2`**（满额高亮）、
   Agent 行的 🌐 环境标记，以及**第 6 个子视图「环境」**（配额 + 按紧急度排序）。

### 已知限制

- 凌虚登录带验证码，只支持 `sessionid` Cookie，不做账号密码自动登录；**Cookie 过期无法自动续期**
  （鉴权请求不回 `Set-Cookie`），只能手动重新登录后更新。
- `punish: true` 的赛事错误提交会扣分；护栏（去重 / 错误计数 / 审计）默认只记录不阻断
  （按用户「全自动」决策），可用 `maxWrongAttempts` 收紧。
- 本机无 Docker / pwntools / gdb / r2，pwn/rev 需按需自装工具链。
- **环境有 TTL 且到期自动回收**：时长以平台 `env_start_min` 为准（模型默认 60，实测 ≈30 分钟），
  只能每次 +30 分钟地延时、且只在剩余 <30 分钟时允许；同时运行数受 `env_limit`（默认 2）限制，
  超出的环境型题目只能排队。
- **check 模式（`answer_mode=2`）平台不判分**：`/check/` 是「简化版」，不读 body、不返回结果，
  「已触发」不等于已得分，需人工到平台确认。
- **AWD / CFS 接口没有赛段校验**（源码行为）：无 AWD 时 `awd/rank/` HTTP 500；无 CFS 时 `cfs/` 返回空、
  `cfs/rank/` 返回全体参赛者（全 0）；`/event/{pk}/type/` 的 `"3"` 是 CFS 不是 AWD。
  判据一律用 `Competition.test_type`（`hasAwd` / `hasCfs`）。
- **`ctf_awd_own_flag` 只在靶机本机有值**（平台按请求来源 IP 匹配靶机），且要求 `flag_type=2`。
- **AWD / CFS 尚未在真实赛段上端到端验证**：当前实测赛事（event 4）是纯 CTF，赛段工具靠源码 + 单测覆盖。
- `task_type=1` 但平台未配置环境的题：`ctf_start_env` / `ctf_release_env` 识别为 `env-not-configured`，
  不算失败，但环境起不来（平台数据问题，只能找平台确认）。
- 理论题 `finish` 不可逆，按用户决策不加二次确认；交卷后平台不再开放题目列表。
- 顶部「CTF」视图 tab 只在 CTF 预设会话里出现；拿不到 `ctx.sessions` 或快照无 preset 信息时降级为始终显示。


---

## 10. 分发与安装（分发组的决策与实测）

### 10.1 只发 GitHub，不发 npm

- npm registry 实测：`GET https://registry.npmjs.org/dsh-lingxu-ctf` → **404**（该包从未发布）。
- 因此 README / INSTALL 里**不出现任何「用 npm 装」的路径**，也不提供版本范围写法（`^1.0.3` 之类会装不上）。
- `package.json` 里的 `publishConfig.access: public` **保留**：它是「将来若发布」的声明，不是「已发布」的暗示；
  文档已明确写清当前未发布（JSON 不能写注释，所以这条约束由 README + INSTALL 承担）。
- 分发形态：
  - `git clone https://github.com/D1a0y1bb/lingxu-ctf.git`（公开仓库，无需凭据）；
  - **codeload tarball 钉 commit/tag**（推荐给 pnpm 用户）：
    `https://codeload.github.com/D1a0y1bb/lingxu-ctf/tar.gz/<sha>` 或 `.../tar.gz/refs/tags/v1.0.3`；
  - 本地目录 `file:<绝对路径>`（开发态）；
  - `npm pack` 产出的 `.tgz`（离线分发；`files` 决定包内容：`lib/`、`docs/`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`）。
- ⚠️ **`scripts/` 不在 npm 包里**（只在 git 仓库）：`scripts/install.sh`（安装助手）、`scripts/verify.sh`（交付自检）
  都是 **bash-only**，Windows 默认不可用 —— 所以文档把「安装」全部收敛到 `plugin_manager`，
  手工步骤同时给出 PowerShell 版本（见 INSTALL.md §6）。

### 10.2 版本锚点：**用 tag，不要用「本地 HEAD」**

- 发布版本 `1.0.3` = tag `v1.0.3` = commit `3702de70a771fd0d430916dea03d5e09bfd7ef0d`（codeload 实测 200）。
- 教训：文档里给用户**钉版本的 SHA 必须是「远端存在的 ref」**。开发机 HEAD 可能领先于已推送的提交
  （本项目就出现过：本地 HEAD 的 commit 未推送，拿它拼 codeload URL 会 404）。
  文档与 release note 一律以 **tag / 远端 ref** 为准，并给出自查命令
  `git ls-remote https://github.com/D1a0y1bb/lingxu-ctf.git`。

### 10.3 pnpm 的 `github:` 依赖退化成 SSH（上游实测）

- 现象：spec `github:D1a0y1bb/lingxu-ctf` 在 `pnpm update/install` 时被解析成
  `git+ssh://git@github.com/D1a0y1bb/lingxu-ctf.git` 去 `git ls-remote`，没有 SSH key 的用户直接
  `Host key verification failed`（exit 128），且报错不含「HTTPS 被转成 SSH」这一关键信息。
- 绕法（文档已收录，按推荐顺序）：codeload tarball 钉版本 / `git+https://…#v1.0.3` /
  配 SSH key 或 `git config url."https://github.com/".insteadOf "ssh://git@github.com/"`。
- 取舍：**不改本插件去迎合 `github:` spec**（那是 pnpm 的解析行为），只在文档里给出可用写法。

### 10.4 Windows

- 运行时**没有平台分支**：`lib/**` 不读 `process.platform`，路径统一走 `node:path`；
  `process.platform` 只出现在 `cordis.patch.yml`（预设里在 bash / pwsh 两个工具行之间二选一）。
- `package.json` **没有** `os` / `cpu` 限制字段 —— 包管理器不会因平台拒绝安装；`engines` 只要求 `node >= 18`。
- 已知障碍：`scripts/*.sh` 是 bash（安装助手 / 自检），以及手工安装时的**符号链接**步骤
  （`ln -sfn`；Windows 用 `New-Item -ItemType Junction` 可免管理员权限）。
- 「Windows 用 GUI / 浏览器 web 安装报错」：**仓库侧无法复现，也未能定位确切原因**。
  文档采取诚实的处理：列出已排除项 + 需要用户提供的报错清单（INSTALL.md §10），不做猜测性归因。

### 10.5 版本兼容策略

| DSH Desktop | 状态 | 处理 |
|---|---|---|
| `0.2.0-rc.1` | 开发基线（Cordis `4.0.4`） | 主要验证目标 |
| `0.2.0-rc.2` | 当前开发机实测 | README 行为描述以此为准 |
| `0.1.7-rc.1` | 上游报告可用、未复现 | 文档标注「⚠️ 未复现」并列出旧版本可能的表现（客户端半静默降级） |
| 更早 | 未验证 | 明确写「配置卡片 / 顶部 tab 可能不出现」，不承诺 |

- 客户端半依赖 `dsh.client.inject` 的三个包名（`dsh-client-modules` / `dsh-client-locale` /
  `dsh-client-ui-conversation`）：**只在 `0.2.0-rc.2` 的安装包里核实过存在**；旧版本是否存在不写死结论。
- 宿主侧能力（16 个基础工具 + 预设）不依赖客户端装配，跨版本更稳。
