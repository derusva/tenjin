# 决策记录：Agent Reach 社媒学习采集器 V0

**日期：** 2026-08-12

**决策人：** 用户（dufei）

**状态：** 已被 2026-08-13 价值探针裁决取代；不再授权多来源 V0 实施

**2026-08-13 校准：** 本记录保留为架构探索证据，但其中“V0 已授权实施”、多来源验收和后续调度路线不再构成当前授权。现行裁决见 `docs/prd/2026-08-13-tenjin-reach-home-export-button-v0.md`：不实现按钮、不建设多来源 collector 产品；只有在用户另行明确授权浏览器读取后，才允许执行一次最多 20 条的 X Bookmarks 单源、只读价值探针，并按 G0–G4 决定是否继续。现有 collector 代码是本地探针基础设施，不是已批准产品范围。

## 1. 本次决定

用户明确指出，Tenjin 仍未真正接入 Agent Reach，也没有可运行的社媒内容采集教学
方案。本决定因此修订 2026-08-05 决策中“后台定时抓取任何外部源永不做”的绝对
禁令：外置 collector、来源级去重、Coach 教学交接重新进入允许范围。

旧决定仍保留以下边界：

- Tenjin PWA 不持有社媒 Cookie，不在浏览器内跑常驻抓取；
- 外部模型只能提议，用户在现有 Coach Import 预览确认后才写入正式账本；
- 不产生必须清空的 Inbox，不展示欠账，不把导入变成手工记录的必经路径；
- 每周额外 Tenjin 时间仍受约 6 分钟预算和“价值可见”双硬门约束。

## 2. 架构边界

```text
Agent Reach doctor/router
          ↓
固定上游适配器（RSS/Jina、OpenCLI、yt-dlp）
          ↓
collector raw + cursor + source-level dedupe（仓库外本地目录）
          ↓
日语召回过滤 + 精确原文片段
          ↓
受限教学生成（模型不能改 sourceExcerpt）
          ↓
tenjin.coach-transfer/v1 + sources sidecar
          ↓
现有 Coach Import 预览确认 → 原子写账
```

Agent Reach 是 installer / doctor / router，不存在统一的 `agent-reach fetch`。collector
必须直接调用它选择的上游工具；`doctor` 成功也不能替代一次真实来源的非空只读验收。

## 3. V0 来源范围

| 来源 | V0 状态 | 理由 |
|---|---|---|
| 合成 fixture | 正式 | 无凭据、断网可跑完整闭环 |
| note creator / magazine RSS | 正式 | 可稳定发现，正文再经 Jina Reader 读取 |
| YouTube History / Watch Later + transcript | 代码接通，登录后验收 | OpenCLI 有稳定 read 命令与 URL |
| X bookmarks / self-likes | 代码接通，登录后验收 | 有 stable tweet ID/URL；私有 GraphQL 易漂移 |
| Instagram Saved | 仅 probe | 当前输出无 stable ID/URL/完整 caption，无法可靠去重与回源 |
| YouTube Liked | 不接 | 当前没有已承诺的 read 命令 |

note RSS 是指定订阅源，不冒充用户自己的 like/bookmark 历史。若要表达高意图，可由用户
建立专用 magazine 或显式提供 URL。

## 4. 凭据和运行约束

- Agent Reach 固定到提交 `93ae1d18c37b707dec053c7c4f9d91cd8ef8943d`；不从可变
  `main.zip` 安装。
- OpenCLI 生产基线固定 npm `1.8.6` / gitHead
  `cad35e7a6a5ff3f7d6b859bfa4c45195c0390260`，并记录配套扩展版本。
- Agent 不读取浏览器 Cookie、不代用户登录。Twitter Cookie 只接受用户显式导出；
  Instagram/YouTube 的 OpenCLI 只复用用户已有且明确控制的 Chrome 会话。
- OpenCLI 会启动 daemon 并操作浏览器 tab，不是纯 headless scraper。调度仅在同一用户
  已登录、Chrome/扩展可连接时可靠，且必须串行、限速。
- 本次不自动创建 Windows Task Scheduler 任务。先以手动命令验证 20 条真实样本、
  重复运行去重、无凭据泄漏和候选有用率；通过后再单独授权调度。

## 5. 数据与教学合同

- `itemKey = sha256(canonical(platform, accountScope, interaction, externalId))`；
- `contentHash = sha256(canonical(content))`；
- `revisionKey = sha256(canonical(itemKey, contentHash))`；
- state 损坏 fail closed，不自动清空游标重新吞历史；raw 先原子落盘，最后提交 state；
- `ja-script-v1` 只做召回，不自称语言识别真相；
- 生成器只返回 `excerptId + focus + answer`，collector 按 `excerptId` 补回精确
  `sourceExcerpt`；未知 ID、未知键、超过 3 条整批拒绝；
- 来源平台、URL、external ID 留在 sidecar，不塞进 Coach v1 的 `answer` 或
  `sourceExcerpt`。如需 Tenjin 内部来源追溯，须另立 Coach transfer v2 与备份迁移。

## 6. 验收与止损

V0 最低验收：

1. fixture 在断网/无凭据条件完成 collect → teaching request → Coach transfer；
2. note 实际 RSS 得到非空日文片段，第二次运行不产生重复 revision；
3. 任一登录平台必须实际返回非空目标互动内容，不能只报 doctor 绿色；
4. stdout/stderr、state、fixture 和测试快照不含 Cookie/token；
5. Coach transfer 被共享 parser 接受，并继续经过 Tenjin 人工预览门；
6. 真实使用若在约 6 分钟周预算内看不到复习/迁移价值，停止扩平台或调度。
