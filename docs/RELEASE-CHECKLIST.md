# 发布检查清单

这份清单把本地可复现检查、宿主 DSH 检查和真实凌虚检查分开。没有凭据或没有对应宿主时，必须写 `unverified`，不能把跳过写成通过。

## 1. 干净工作树

```bash
git status --short
git diff --check
node --version
npm --version
```

插件要求 Node `>=18`。`package.json` 的 `dsh.runtime` 声明 DSH 负责提供运行时和 `@deepseek-ai/schemastery`；不要在 DSH profile 目录里执行项目级 `npm install`、`npm update` 或覆盖宿主依赖。

## 2. 本地检查

在插件目录运行：

```bash
npm test
bash scripts/verify.sh
npm pack --dry-run --json
```

如果需要隔离依赖，在临时目录复制源码后安装插件声明的依赖：

```bash
npm install --ignore-scripts --no-audit --no-fund
npm test
```

仓库不提交宿主 DSH 的 lockfile，也不把宿主 runtime 锁进插件包。发布前应记录 Node/npm 版本、依赖解析结果和 tarball 文件清单；需要完全冻结供应链时，在独立 CI 中生成并审查 lockfile，不要把它当作 DSH profile 的安装指令。

## 3. 包内容

确认 `npm pack --dry-run` 只包含运行所需的 `lib/`、文档、清单和许可证，不包含：

- Cookie、sessionid、flag、日志和本地 state；
- `node_modules/`、临时目录和用户工作目录；
- 未审查的测试账号、真实赛事响应或内部绝对路径。

## 4. DSH 宿主检查

在目标 DSH profile 中确认：

1. 插件被作为 source/bundle 安装，而不是复制进 profile 的 `node_modules`；
2. `dsh.client.inject` 中的客户端模块真实存在；
3. `slots`、`sessions`、`sessionProjections`、`agentTeams` 缺失时，基础工具仍能装配；
4. 切换会话时 CTF 视图和 token 用量不会串到另一会话；
5. 卸载或热重载后没有重复的工具、事件订阅和轮询定时器。

## 5. 真实凌虚检查

仅在隔离赛事和有效 Cookie 下运行：

```bash
LINGXU_COOKIE_FILE=/path/to/cookie \
LINGXU_BASE_URL=https://ctf.example.com:8000 \
LINGXU_EVENT_ID=4 npm run smoke

LINGXU_COOKIE_FILE=/path/to/cookie \
LINGXU_BASE_URL=https://ctf.example.com:8000 \
LINGXU_EVENT_ID=4 npm run e2e
```

至少记录：

- 登录、赛事摘要、题目分页、排行榜和理论题字段；
- AWD/CFS 能力是 `present`、`absent` 还是 `unknown`；
- 附件下载大小限制、环境启动/释放、flag 提交结果；
- 两个会话交错调用时的隔离结果；
- HTTP 4xx/5xx、session 过期和限流时的错误 `code`、重试和用户提示。

提交 flag、交卷、释放环境属于有副作用操作，应使用专门测试题并保留操作编号，不能用生产题目做回归。

## 6. 发布记录

发布说明只写本版本确实改变的行为，并把检查结果标成：

- `passed`：有可复现命令或真实回执；
- `failed`：检查已运行且失败；
- `partial`：一部分路径通过；
- `unverified`：没有运行条件；
- `environment_failed`：检查入口因环境问题无法执行；
- `not_reproduced`：已知风险尚未在目标环境复现。

Release 标题和 commit 标题不要写“全部完成”“零问题”“实测全过”等回执无法证明的话。旧公共历史如需改写，必须另行确认并采用可回滚方案。
