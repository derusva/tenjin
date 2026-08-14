# Tenjin Reach Collector

`tenjin-reach` 是 Tenjin 的外置社媒采集命令层。它不直接写浏览器里的
IndexedDB：采集端保存来源级游标、去重和 sidecar，最后只输出现有
`tenjin.coach-transfer/v1`，由用户在 Tenjin 的“从 Coach 导入”中预览确认。

Agent Reach 在这里负责安装、体检和路由；实际读取仍按它选择的上游执行：
OpenCLI、yt-dlp、RSS/Jina Reader。当前固定基线：

- Agent Reach `93ae1d18c37b707dec053c7c4f9d91cd8ef8943d`
- OpenCLI npm `1.8.6`，gitHead `cad35e7a6a5ff3f7d6b859bfa4c45195c0390260`

## 先跑无凭据闭环

```powershell
pnpm --filter @tenjin/reach-collector build
node packages/reach-collector/dist/cli.js --json doctor --config packages/reach-collector/examples/reach.config.example.json
node packages/reach-collector/dist/cli.js --json collect --config packages/reach-collector/examples/reach.config.example.json --source fixture.social
node packages/reach-collector/dist/cli.js --json teaching prepare --config packages/reach-collector/examples/reach.config.example.json --source fixture.social
```

`teaching prepare` 生成只含原文片段和稳定 `excerptId` 的 request。教学生成器只能
返回 `excerptId + focus + answer`，不能改写 `sourceExcerpt`。之后执行：

```powershell
node packages/reach-collector/dist/cli.js --json teaching compile --request <request.json> --result <generation-result.json> --out <coach-transfer.json> --sources-out <sources.json>
```

把 `<coach-transfer.json>` 内容粘贴到 Tenjin 的“从 Coach 导入”。`sources.json`
留在 collector 侧，因为现有 Coach v1 合同不接受 URL、平台或 external ID。

## 真实来源边界

| 来源 | 当前 V0 | 上游命令 |
|---|---|---|
| note | 指定 creator / magazine RSS + 正文读取 | RSS + Jina Reader |
| YouTube | history、Watch Later、日文字幕 | `opencli youtube history/watch-later/transcript` |
| X | 自己的 bookmarks、likes | `opencli twitter bookmarks/likes` |
| Instagram | 只做 Saved 可用性 probe | `opencli instagram saved` |

Instagram Saved 当前输出缺 stable ID、URL 和完整 caption，不能可靠去重和回源，
所以不会伪装成正式采集。YouTube Liked 也没有已承诺的 read 命令。

OpenCLI 依赖本机 Chrome 登录态与 Browser Bridge，会启动 daemon 并操作临时 tab。
它不是无头服务。若以后启用 Windows Task Scheduler，必须使用同一 Windows 用户、
选择“仅在用户登录时运行”、串行抓取，并对 429 做冷却。

## 体检与错误

```powershell
tenjin-reach --json doctor --config <config.json>
tenjin-reach --json state show --config <config.json>
```

`agent-reach doctor --json` 只证明安装/路由状态，不证明登录态或某批内容可读；
`active_backend: null` 也不等于 OpenCLI 不存在。每个登录源仍必须以一次真实、只读、
非空的小批量命令验收。CLI 的 JSON 模式只把 JSON 写到 stdout；诊断和稳定错误写到
stderr；错误消息中的 Authorization/Cookie 头，以及 JSON 或 key/value 形式的
token、apiKey、secret、password 会在输出前替换为 `[REDACTED]`；子进程环境变量不会输出。
