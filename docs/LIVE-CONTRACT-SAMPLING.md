# 真实平台合同采样

`scripts/sample-live-contract.mjs` 面向一次真实凌虚赛事连接，默认只读并输出脱敏 JSON。它会采样赛事摘要、赛事类型、CTF 题目与详情、排行榜、理论题列表，以及当前赛事存在时的 AWD/CFS 列表、详情、排行榜和动态接口。

附件只采样是否存在和元数据，不自动下载；环境只读取地址，不自动启动、延时或释放。这样不会在没有隔离赛事的情况下改变比赛状态。

```bash
LINGXU_COOKIE_FILE=/绝对路径/lingxu.cookie \
LINGXU_BASE_URL=https://ctf.example.com:8000 \
LINGXU_EVENT_ID=4 \
LINGXU_SAMPLE_MAX_DETAILS=12 \
node scripts/sample-live-contract.mjs \
  --out /tmp/lingxu-event-4-contract.json
```

Cookie 文件只应包含浏览器复制的完整 Cookie，命令行和样本都不会写出 Cookie、flag、token、用户名、密码或原始响应。样本中的每个调用有 `passed` / `failed` 状态；403 未登录、权限不足、未配置赛段等错误会保留机器可读的状态码和错误码。题目详情默认最多采样 12 道（可用 `LINGXU_SAMPLE_MAX_DETAILS` 调整，上限 50），直到找到附件型和环境型题；输出会记录实际采样数量，避免把未采样误报为平台没有该能力。赛事摘要成功但部分接口失败时，顶层状态为 `partial`。

最近一次验收已使用临时有效 Cookie 完成赛事 10 和 11 的只读采样。两场赛事摘要、题目、理论题、排行榜、环境地址和 e2e 链路均成功；两场的 AWD/CFS 能力均由平台返回为 `absent`。Cookie 未写入仓库、样本或持久化记忆。
