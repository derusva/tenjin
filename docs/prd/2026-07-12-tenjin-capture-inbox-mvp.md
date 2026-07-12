# Tenjin Capture Inbox MVP PRD

**状态：** 已批准并冻结；仅阶段 A GO

**日期：** 2026-07-12

**版本：** 1.0

**阶段 A 目标平台：** 用户当前 iPhone / iOS 26

阶段 A 只对用户实际设备上的 iOS 26 作结论；不从这次真机结果反推 iOS 18.4–25 的兼容性。若未来需要支持旧系统，必须另做兼容性矩阵，不能把未测试版本写成已支持。

**文档性质：** Tenjin 输入子系统 PRD，不是完整学习系统 PRD

**本轮范围：** 只定义产品与验证方案，不开始开发

## 0. 给无上下文读者的说明

Tenjin 是一个本地优先的个人日语学习账本。它把真实阅读、听力和表达中的失败、验证、纠正与提问保存为事件，再用确定性规则生成 R / L / P 三个学习通道的状态、固定预算复习和可选的 AI 上下文。

本 PRD 只解决其中一个子问题：

> 如何让用户在 iPhone 上阅读、看视频、玩主机游戏或做纸面题目时，用尽可能低的成本把文字、链接和图片可靠送入 Tenjin，并在稍后转成真正的学习记录。

本 PRD 不重新设计 Tenjin 的学习者模型、状态机、复习算法或完整 AI 架构。它取代旧版《Tenjin iOS 学习资料收件箱 PRD》的**近期实施范围**；旧版仍可作为长期架构与风险清单参考。

## 1. 摘要

Tenjin 当前支持手工输入文字并选择“查过 / 没听出 / 表达纠正”，但不支持从 iOS 分享菜单直接接收文字、网页、截图或照片。用户必须中断当前活动、切换应用、粘贴或重打内容，并在捕获时立即分类。

本 MVP 采用以下原则：

> **先收下，稍后理解；先证明会用，再建设自动化。**

产品路线分为三个连续阶段：

1. 用可废弃的 `schemaVersion: 0` 完成“快捷指令写入 → 主屏 PWA 读回”的端到端 spike；
2. 先交付一条极薄的“捕获 → 导入 → 查看 → 人工晋升 / 归档 / 删除”闭环，并用前 10 条真实资料验证；
3. 闭环成立后再扩到 50 次捕获、20 条延迟处理，并补齐可靠性、容量和最小状态恢复。

GPT、完整便携备份、原生 App、CloudKit 和自动同步都不属于这条 MVP 垂直闭环。只有真实使用数据证明“捕获得到、处理得动、确实产生学习价值”后，才分别立项。

## 2. 与 Tenjin 总体设计的关系

### 2.1 继承的既有原则

- 正式学习事件是事实源；派生状态可以重建。
- R / L / P 分别表示阅读识别、听力识别和表达调用。
- 同一内容在不同通道可以有不同状态。
- 已稳定或 suppressed 的内容默认不被系统反复主动解释。
- LLM 是可拔插增强器；无 LLM 时仍能记录、查询、复习和恢复。
- LLM 只能提出 proposal，不能直接改变正式学习状态。
- 用户确认事件才是事实源。

### 2.2 本 PRD 负责

- iOS 分享菜单中的低摩擦捕获入口；
- iCloud Drive 中的原始 Capture Package；
- Tenjin 的手动批量导入；
- 未分类 InboxCapture；
- 从 InboxCapture 人工晋升为正式学习项；
- 支撑真实使用验证的指标；
- 持续试用前所需的最小状态导出与空库恢复。

### 2.3 本 PRD 不负责

- 重新定义学习者画像、R / L / P 状态或复习算法；
- 自动 OCR、网页全文抓取、视频下载、音频或 ASR；
- GPT 请求包、结果包和 proposal 协议；
- 完整 Vault Backup、附件便携恢复或多设备合并；
- 原生 App 技术栈、Share Extension、App Group 或 CloudKit；
- 后台自动导入、账号系统或服务器同步；
- Android。

## 3. 已确认约束

| 事项 | 决策 |
|---|---|
| 用户设备 | 只考虑 iPhone；不投入 Android 兼容 |
| 阶段 A 系统 | 用户当前 iOS 26；目录导入与快捷指令动作都以该目标设备实测为准，旧系统兼容性不在本阶段承诺 |
| 当前产品 | GitHub Pages 上的本地优先 PWA |
| 捕获入口 | 预先配置并通过链接交付的 iOS 快捷指令“存入 Tenjin” |
| 同步介质 | 用户自己的 iCloud Drive |
| 日常捕获 | 分享菜单内点一次；不填写字段、不分类、不等待 AI |
| 安装成本 | 允许一次性安装、选目录和授权；用户不手工搭建内部动作 |
| 签名约束 | 当前没有已确认且可持续的原生签名与真机分发渠道 |
| 开发环境 | 主要开发环境为 Windows；可持续的 macOS / Xcode 真机环境尚未确认 |
| 正式账本 | MVP 期间以 iPhone 上的 Tenjin 为唯一正式账本 |
| AI | 捕获和 MVP 处理路径均不调用 GPT |

用户曾因快捷指令配置和日常摩擦放弃过学习工具，因此“只需第一次复杂”必须由真实安装测试证明，不能只靠文档承诺。

## 4. 要验证的产品假设

### H1：分享菜单可以显著降低捕获摩擦

若用户不必切换到 Tenjin、粘贴文字和立即选择 R / L / P，就会更愿意保存真实学习材料。

### H2：捕获后的资料可以被处理，而不是形成资料坟场

更轻的捕获只有在资料之后能被查看、理解和转成学习项时才有价值。

### H3：零字段捕获不会造成不可接受的意图丢失

捕获时不要求说明“为什么保存”。需要验证 24 小时后，来源、内容和相邻 payload 是否足以让用户恢复当时意图。

### H4：自动分析是后续增强，不是第一条闭环的前提

如果人工处理 20 条真实 capture 后，主要剩余障碍确实是 OCR、提取或解释成本，才进入 GPT 阶段。

## 5. 核心用户场景

### 5.1 小说、文章和网页

用户选择一段文字或分享网页，点击“存入 Tenjin”。系统保存实际收到的文字、URL、标题或选区；不承诺重新下载全文。

### 5.2 视频

用户分享视频 URL，或对字幕和画面截图后分享图片。MVP 不下载视频，也不自动取得播放时间点。

### 5.3 主机游戏和纸面题目

用户拍摄或截图游戏画面、题干、选项或解析，再从照片预览分享。系统保存来源应用实际交付的文件表示，不承诺获得相册底层原始位流或全部元数据。

### 5.4 多张相关图片

用户一次分享 2–10 张图片。它们必须作为同一个 capture 中有顺序的多个 payload 保存，不能散成互不相关的记录。

## 6. 分阶段交付

批准本 PRD 只表示可以为阶段 A 编写实施计划，不表示一次性批准 A、B、C 全部开发。每一阶段必须先通过自己的门，再决定是否进入下一阶段。

### 阶段 A：端到端可行性 Spike

目的：先证明“iPhone 分享写入”和“主屏 PWA 读回”整条链都成立，不承诺长期兼容。

交付：

- 一个仅供测试的诊断快捷指令；
- `schemaVersion: 0` 的可废弃输出；
- 一个不写 IndexedDB 的诊断读取页：选择月份目录、枚举 1–3 个包、读取并显示文字 / URL / 图片；
- Safari、照片、至少一个阅读器和文件预览的 Content Graph 样本；
- 验证各来源是否能稳定取得来源应用身份；若不能，v1 不伪造 `sourceApp`；
- 文字、URL、单图、多图的实际类型、顺序、文件格式和大小记录；
- 日文与 Unicode fixture：汉字 / 平假名 / 片假名混合、补充平面字符与 emoji、全角空格、多行与不同换行、首尾空白、日文及百分号编码 URL、Rich Text 标点 / 段落、同一句 Safari 选区与 Rich Text 表示；
- iCloud 目录创建、离线写入、权限、重启后目录引用、placeholder 下载和失败反馈测试；
- 快捷指令源端 `byteLength` / SHA-256 与 PWA 本地摘要的真实耗时对照。

规则：

- 只使用无敏感、可丢弃的测试材料；
- v0 写入独立的 `iCloud Drive/Shortcuts/Tenjin/CaptureLogSpike`，不污染正式 CaptureLog；
- v0 不进入正式 Inbox，不承诺迁移；
- 在看到真机输入前不冻结 v1 Content Graph 归一化规则；
- 源端 SHA-256 只有在不使标准负载 P90 超过 8 秒，且相对无 SHA 方案增量不超过 1 秒时，才进入正式快捷指令。

阶段门：

- 支持的来源都能稳定取得至少一种有用表示；
- 固定目录在首次授权后不再成为日常询问；
- 快捷指令写出的包可以由目标 iOS 26 主屏 PWA 重新选择目录并读回；
- manifest 先到、附件仍是 placeholder 时，本次显示暂不可用而不生成部分记录；
- 保存失败不会显示成功；
- 可以明确列出 v1 支持和拒绝的类型。

### 阶段 B：极薄学习闭环

目的：在积累大量资料之前，先让第一批 capture 能完成“捕获 → 导入 → 查看 → 晋升 / 归档 / 删除”。

交付：

- 通过 iCloud 分享链接安装的“存入 Tenjin”；
- 文字、Rich Text、HTTP / HTTPS URL、Safari 页面、JPEG、PNG、HEIC；
- 单图和一次 2–10 张多图；
- 按捕获设备本地日历月份保存的 CaptureLog；
- payload 先写、`capture.json` 最后写；
- Tenjin 中最小月份目录导入；
- 有序 `payloads[]` 的 Inbox；
- 用户可连续新增 0..N 个 R / L / P 学习项，再显式完成处理、归档或删除；
- 最小 ImportLedger、重复导入保护和来源引用；
- 不执行 OCR、GPT 或完整恢复。

阶段门：

- 先完成 10 次真实捕获，覆盖至少 3 类来源；
- 至少 5 条在相隔 24 小时后被处理；
- 捕获、导入、查看和人工晋升均有真实成功样本；
- 没有因为读取链路缺失而积累无法消费的资料；
- 初步意图恢复与处理时间表明这条闭环值得扩大试用。

### 阶段 C：Pilot Hardening 与有效性验证

交付：

- 把真实使用扩大到至少 50 次捕获和 20 条延迟处理；
- 完成标准负载计时、受控丢失审计、多图压力与容量测试；
- 增加版本化状态 JSON 导出和空库恢复；
- 完善配额预检、空间不足回退、删除墓碑和 payload 恢复；
- 记录意图恢复率、处理率、转化率、后续学习事件和 Inbox 增长。

阶段门：

- 标准文字、URL 和单图稳定态 P90 不超过 8 秒；
- 受控测试中没有静默丢项或失败误报成功；
- 状态导出与空库恢复通过；
- 如果收件箱持续净增长，先修处理体验，不进入 GPT；
- 只有当语义提取、OCR 或解释成为主要剩余瓶颈时，才立项 GPT。

## 7. 用户流程

### 7.1 一次性安装

用户只完成四个任务：

1. 打开交付链接并添加“存入 Tenjin”；
2. 通过 Import Question 选择一次 `iCloud Drive/Shortcuts/Tenjin/CaptureLog`；
3. 第一次运行时允许目录访问和可选完成通知；
4. 在分享菜单“编辑操作”中把“存入 Tenjin”移到靠前位置，并完成一次安装自检。

目标：5 分钟内完成。用户不查看或编辑快捷指令内部动作。

### 7.2 日常捕获

```text
选择文字、URL 或图片
→ 系统分享
→ 存入 Tenjin
→ 显示“已收下”
→ 返回来源应用
```

“已收下”只表示来源 iPhone 已成功把完整包交给 iCloud 文件提供器，不表示其他设备已经完成同步。

### 7.3 批量导入

```text
打开 Tenjin
→ 收件箱
→ 从 iCloud 导入
→ 选择 CaptureLog/2026-07 等月份目录
→ 显示新增、重复、暂不可用和无效数量
```

PWA 不能记住持久目录句柄，也不能后台监控或删除 iCloud 文件，因此每次批量导入都需要用户主动选择目录。

### 7.4 人工处理

```text
打开一条 InboxCapture
→ 按原始顺序查看文字、URL 和图片
→ 判断为什么保存
→ 新增 0..N 个查过 / 没听出 / 表达纠正学习项
→ 显式点击“完成处理”，或归档 / 删除
```

默认 capture 没有 intent。MVP 不增加第二个快捷指令，也不要求捕获时备注。

## 8. Capture Package 候选 v1 最小契约

### 8.1 目录

```text
iCloud Drive/Shortcuts/Tenjin/CaptureLog/<YYYY-MM>/<timestamp>_<capture-id>/
├── payload-1.txt
├── payload-2.url.txt
├── payload-3.heic
└── capture.json
```

每次分享生成一个 UUID `captureId`。多项输入共享同一个 capture，payload 顺序必须与规范化后的分享输入顺序一致。

`capturedAt` 始终使用 UTC ISO 8601，作为事实时间；目录中的 `<YYYY-MM>` 与 manifest 的 `shardMonth` 使用捕获设备当时的本地日历月份，只用于让用户直观选择分片，不参与学习事件排序或冲突判断。

### 8.2 Manifest 最小字段

```json
{
  "schemaVersion": 1,
  "captureId": "550e8400-e29b-41d4-a716-446655440000",
  "capturedAt": "2026-07-12T23:15:01.000Z",
  "shardMonth": "2026-07",
  "transport": "ios-shortcut",
  "payloads": [
    {
      "payloadId": "payload-1",
      "kind": "text",
      "role": "selection",
      "path": "payload-1.txt",
      "mediaType": "text/plain"
    }
  ]
}
```

约束：

- `capture.json` 最后写；没有 manifest 的目录不导入；
- `capture.json` 不超过 256 KB，`payloads` 至少 1 项且最多 20 项；
- JSON 与文本为 UTF-8、无 BOM；
- `schemaVersion` 必须是整数 `1`，`captureId` 必须是 UUID，`capturedAt` 必须是有效的 UTC ISO 8601 时间，`shardMonth` 必须匹配 `YYYY-MM` 且与父目录名一致，`transport` 必须是 `ios-shortcut`；
- manifest 和 payload 对象使用严格 JSON Schema `additionalProperties: false`；未来扩展必须提升 schemaVersion，不接收任意未知字段；
- 路径只能指向当前 capture 内部，拒绝绝对路径、空路径段、`.`、`..`、反斜杠和 NUL；
- `payloadId` 与 `path` 在包内唯一；
- v1 `kind` 只允许 `text`、`url` 和 `image`；
- v1 支持 `selection`、`page-title`、`page-url`、`attachment` 和 `unknown` role；
- `mediaType` 只允许 `text/plain`、`text/uri-list`、`image/jpeg`、`image/png`、`image/heic` 和 `image/heif`，并且必须与 kind 和实际文件签名一致；
- `originalName` 是允许的可选显示字段，最多 255 个 Unicode 标量值，禁止控制字符和双向文本覆盖字符，不能用于构造存储路径；缺失时在本地摘要输入中使用 `null`；
- `byteLength` 和 `sha256` 是允许的可选完整性字段，必须同时出现或同时缺失；`byteLength` 是非负安全整数，`sha256` 是 64 位小写十六进制；是否由正式快捷指令写入以阶段 A 真机性能为准；
- manifest 提供可选完整性字段时，导入器必须与实际字节核对；不一致则该包无效；
- 导入器始终计算 `localPackageDigest`，用于本机重复和冲突检测；
- 同一 `captureId`、同一 `localPackageDigest` 视为重复；同一 ID、不同摘要进入冲突提示，不覆盖既有记录；
- 不同 `captureId` 即使内容完全相同，也保留为两次独立 encounter，不自动合并。

### 8.3 本地摘要

`localDigestVersion: 1` 只由 Tenjin 导入器计算，不要求快捷指令或未来原生入口复现：

1. 对每个实际 payload 文件计算 SHA-256；
2. 按 manifest 顺序构造固定键序、无多余空白的 UTF-8 JSON，包含 `localDigestVersion`、`schemaVersion`、`captureId`、`capturedAt`、`shardMonth`、`transport`，以及每项的 `payloadId`、`kind`、`role`、`path`、`mediaType`、`originalName` 或 `null`、实际 `byteLength` 和实际 SHA-256；
3. 对这段 JSON 字节计算 SHA-256，得到 `localPackageDigest`。

算法变化必须提升 `localDigestVersion`。实现需为单文本、多图、同内容不同 captureId 和同 ID 篡改四类 fixture 建立测试，但不把它升级成跨生产者的 Capture Package 协议。

`InboxCapture`、`ImportLedgerEntry` 和状态 JSON 必须把 `localDigestVersion` 与 `localPackageDigest` 成对保存。比较规则：

1. 同版本、同摘要：重复；
2. 同版本、不同摘要：ID 冲突；
3. 已存版本不受当前导入器支持：报告 `unsupported-digest-version`，不能伪装成内容冲突；
4. 摘要算法升级时，必须保留旧版本计算器或显式迁移既有记录，不能直接用新算法比较旧摘要。

### 8.4 MVP 限制

- Text / Rich Text 单项不超过 1 MB；
- URL 单项不超过 16 KB，且必须是绝对 HTTP / HTTPS URL；
- 单张图片不超过 10 MB；
- 一次最多 10 张图片，总 payload 不超过 50 MB；
- Pilot 本机已导入 payload 总量软上限为 200 MB；50 MB 只用于单包压力测试，不代表 50 个包都可按最大值同时驻留；
- 不支持 PDF、Office、压缩包、音频、视频和通用文件；
- 超限或不支持时明确失败，不静默丢弃部分输入。

上述大小是阶段 A 的压力测试上限；如果真机证明不稳定，冻结 v1 前必须在文档中明确下调，不能实现时静默采用另一套限制。

## 9. Inbox 数据模型

```text
InboxCapture
- captureId
- capturedAt
- importedAt
- transport
- sourceShardMonth
- sourcePackageRelativePath
- payloads[]
  - payloadId
  - kind
  - role
  - mediaType
  - contentRef?
  - originalName?
- intentHint?
- reviewState: unreviewed | reviewed
- archiveState: active | archived | deleted
- payloadAvailability: available | needs-restore | removed
- sourcePackageVersion
- localDigestVersion
- localPackageDigest
```

规则：

- `payloads[]` 保留 Capture Package 的顺序和 role，不拆成三个无序数组；
- `intentHint` 默认不存在；它只是未来可选能力，不属于 MVP 捕获 UI；
- GPT 分析状态不写成 InboxCapture 的单一字段；未来由独立 request / proposal 记录派生；
- `payloadAvailability` 只描述本机 payload Blob 是否存在，不表示 iCloud 同步状态；
- `available` 要求所有必需 payload 都有可用 `contentRef`；`needs-restore` 允许 `contentRef` 缺失或不可用；`removed` 表示用户明确删除，所有 `contentRef` 已移除且不得自动恢复；
- delete 删除本机可见内容，但 ImportLedger 保留 `captureId`、摘要版本 / 摘要、来源路径和非敏感的 `sourcePayloadIds[]` 墓碑，避免下次导入复活并让既有正式 item 的来源引用仍可校验；
- 用户每次新增学习项时立即创建正式学习事件，但不自动完成或归档 capture；
- 一个 capture 可以产生多个正式 item，但每个 item 必须保留来源引用。

```text
ImportLedgerEntry
- captureId
- localDigestVersion
- localPackageDigest
- importedAt
- sourceShardMonth
- sourcePackageRelativePath
- sourcePayloadIds[]
- tombstone: active | deleted
```

状态转换：

| 用户动作 | reviewState | archiveState | payloadAvailability | 说明 |
|---|---|---|---|---|
| 新导入 | unreviewed | active | available | 出现在待处理 Inbox |
| 只打开查看 | 不变 | 不变 | 不变 | 打开不算处理完成 |
| 新增一个学习项 | 不变 | 不变 | 不变 | 学习项立即保存；capture 留在 Inbox，可继续处理其他 payload |
| 点击“完成处理” | reviewed | archived | available | 从待处理 Inbox 移出，仍可搜索来源及已创建学习项 |
| “保存此学习项并完成处理” | reviewed | archived | available | 组合快捷动作：先保存当前学习项，再完成处理 |
| 明确归档但不晋升 | reviewed | archived | available | 表示已判断但本次不形成学习项 |
| 删除 capture | reviewed | deleted | removed | 删除本机 payload，仅保留 captureId、摘要、来源路径、sourcePayloadIds[] 和删除墓碑 |
| 从状态 JSON 恢复 | 保留备份值 | 保留备份值 | needs-restore | deleted 项保持 removed |

若已晋升的 capture 后来被删除，正式学习项不自动删除；它只保留非敏感的 captureId / payloadId 来源引用并显示“来源已删除”。删除正式学习项属于现有账本的另一项显式操作。

指标口径：`processed` 指用户显式完成处理、明确归档或删除，等价于 `reviewState = reviewed`；只新增学习项但未完成处理不计作 processed。7 天处理率的分母只包含捕获时间已满 7 天的 capture；转化率为“至少产生一个正式 item 的 reviewed capture / reviewed capture”。

## 10. 功能需求

### 10.1 捕获

| ID | 阶段 | 优先级 | 需求 |
|---|---|---|---|
| CAP-01 | B | Must | “存入 Tenjin”可从 iOS 分享菜单运行 |
| CAP-02 | B | Must | 正常捕获不显示分类、备注或确认表单 |
| CAP-03 | B | Must | 每次调用只生成一个 captureId，多图保持同组和顺序 |
| CAP-04 | B | Must | payload 先写、manifest 最后写；只有全部必需写入成功才显示“已收下” |
| CAP-05 | B | Must | 首次选定目录后，日常捕获不再询问保存位置 |
| CAP-06 | B | Must | 空输入、权限、空间、转换和保存失败时不误报成功 |
| CAP-07 | B | Must | 通过共享链接交付，用户不手工搭建内部动作 |
| CAP-08 | A | Must | v1 类型归一化规则必须来自阶段 A 的真机样本，而不是只靠 Content Graph 文档推断 |

### 10.2 导入

| ID | 阶段 | 优先级 | 需求 |
|---|---|---|---|
| IMP-01 | B | Must | 目标 iOS 26 主屏模式允许用户选择单个月份目录 |
| IMP-02 | B | Must | 在 IndexedDB 事务外读取、限制大小并计算本地摘要 |
| IMP-03 | B | Must | 用 captureId + localPackageDigest 区分新增、重复和 ID 冲突；不同 captureId 的相同内容仍是独立 encounter |
| IMP-04 | B | Must | 单包元数据、payload Blob 和 ImportLedger 在短事务中原子写入 |
| IMP-05 | B | Must | 正常导入时，manifest 或引用文件暂不可用只进入本次“暂不可用”报告，不创建部分 InboxCapture；以后重选重试 |
| IMP-06 | B | Must | 不实现 24 小时 / 三次扫描状态机；MVP 不把等待同步误包装成永久损坏 |
| IMP-07 | B | Must | ImportLedger 保留已导入 ID 和删除墓碑 |
| IMP-08 | B | Must | 图片按允许的媒体类型和可识别文件签名校验，不只信任扩展名；不支持 SVG 或其他可执行内容 |
| IMP-09 | C | Must | 导入前在浏览器支持时读取存储估算，并始终统计 Tenjin 已存 payload 字节；达到 200 MB 软上限或发生 quota 错误时停止该包、保留 iCloud 原件并允许清理后重试 |
| IMP-10 | B | Must | 文字、标题和文件名只通过 `textContent` 等纯文本路径渲染，禁止 `innerHTML`；URL 不自动抓取，只在用户显式点击后以 `noopener noreferrer` 安全打开；图片使用校验后的 Blob URL 并及时释放 |
| IMP-11 | B | Must | 导入时保存 manifest 的 shardMonth 与文件选择器提供的 CaptureLog 相对包路径；二者不一致时拒绝该包 |

### 10.3 Inbox 与人工晋升

| ID | 阶段 | 优先级 | 需求 |
|---|---|---|---|
| INB-01 | B | Must | InboxCapture 不要求 R / L / P 分类 |
| INB-02 | B | Must | 按原顺序显示文字、URL、图片、role 和捕获时间 |
| INB-03 | B | Must | 支持按时间浏览、搜索文字 / URL、查看附件 |
| INB-04 | B | Must | 支持 reviewed、archived 和 deleted 的显式操作 |
| INB-05 | B | Must | 用户可连续新增 0..N 个查过、没听出或表达纠正学习项；新增单项不自动完成 capture |
| INB-06 | B | Must | 正式事件和 item 保留 captureId / payloadId 来源引用 |
| INB-07 | B | Should | 批处理界面一次最多展示 5 条资料，不用红点、欠账或连续天数催促清空 |
| INB-08 | B | Must | 只有用户显式点击“完成处理”、归档或删除时才把 reviewState 设为 reviewed；提供可选的“保存此学习项并完成处理”组合动作 |

### 10.4 最小状态恢复

| ID | 阶段 | 优先级 | 需求 |
|---|---|---|---|
| REC-01 | C | Must | 进入持续学习试用前可导出版本化状态 JSON |
| REC-02 | C | Must | 状态 JSON 包含正式事件、contexts、Inbox 元数据、ImportLedger / 墓碑、sourceShardMonth / sourcePackageRelativePath、localDigestVersion / localPackageDigest 和事件坐标高水位 |
| REC-03 | C | Must | MVP 只支持恢复到空库；写入前校验 schema、ID 唯一性、事件与来源交叉引用、摘要版本、墓碑和事件坐标；正式 item 可引用 active / archived Inbox payload，或 deleted tombstone 的 sourcePayloadIds[]，其他悬空引用一律拒绝；失败不能留下半恢复状态 |
| REC-04 | C | Must | 状态 JSON 不重复打包 CaptureLog payload；恢复后将其标为 `needs-restore`，按 sourceShardMonth 提示月份并使用 sourcePackageRelativePath 定位，核对 captureId / 摘要版本 / localPackageDigest 后整包原子补回 Blob |
| REC-05 | C | Must | 界面明确说明状态备份不是完整便携附件备份，不能据此建议清理 CaptureLog |
| REC-06 | C | Must | 补回 active / archived capture 的 payload 时允许越过普通“已导入则跳过”分支；deleted 墓碑仍不得复活 |
| REC-07 | C | Must | 只有一条 capture 的所有必需 payload 均可读且校验通过后，才在单个短事务中从 `needs-restore` 切换为 `available`；不创建部分恢复状态 |

完整 ZIP、250 MB 附件归档、staging 数据库替换、外部分片补齐状态机和跨设备合并属于独立的 Data Portability & Recovery PRD。

## 11. 指标与决策门

### 11.1 捕获可靠性

| 指标 | 目标 |
|---|---:|
| 首次安装与授权 | 5 分钟内完成 |
| 分享菜单内的 Tenjin 专属选择 | 1 次点击 |
| 捕获时必填字段 | 0 |
| 相比当前手工文字流程的捕获时间中位数 | 至少降低 50% |
| 标准文字 / URL / 单图稳定态 P50 | 不超过 5 秒 |
| 标准文字 / URL / 单图稳定态 P90 | 不超过 8 秒 |
| 受控尝试中的静默丢失 | 0 |
| 受控故障中的失败误报成功 | 0 |

标准负载定义为：不超过 100 KB 的文字或 URL，或不超过 10 MB 的单图；权限已授予、iCloud 文件提供器已热启动，并记录 iPhone 型号、iOS 版本和网络状态。计时从用户点击来源应用的“分享”开始，到“已收下”出现为止。选择文字、截图或拍照的时间单独观察。首次权限和 iCloud 冷启动单独记录，不混入稳定态指标。

H1 基线使用同一部 iPhone 完成至少 10 次当前“复制 / 切换 Tenjin / 粘贴 / 分类 / 保存”的标准文字流程，再与至少 10 次快捷指令文字流程比较。

“静默丢失”不能只从 CaptureLog 反推。受控测试在产品之外维护连续 attempt 编号；每次尝试记录是否出现成功通知及其短 captureId，再用 PWA 读回结果核对。Files 已显示该月份内容在本机可用、且测试者重新选择目录两次后，成功通知对应的完整包仍无法读回，记为失败误报；没有可导入包且没有明确失败反馈，记为静默丢失。该测试日志只用于验证，不进入日常产品流程。

### 11.2 学习价值

必须记录：

- 24 小时后仍能判断“为什么保存”的比例；
- capture 在 7 天内被查看的比例；
- capture → 正式学习项转化率；
- promoted item 在晋升后 14 天内进入查询、复习、验证或纠正事件的比例；
- reviewed 后 archived / deleted 的比例；
- 每条 capture 的处理中位时间；
- 每周用于批量处理 Inbox 的总时间；
- 每次选择月份目录、等待扫描和完成导入的时间，以及因此放弃导入的次数；
- 每条样本的主要处理成本：恢复语境、提取目标 / OCR、选择 R / L / P、操作界面或其他；
- 因缺少语境而无法处理的比例；
- 每周新增与处理数量，观察 Inbox 是否持续净增长；
- 第 2、3 周捕获量是否因操作麻烦明显衰减。

意图实验使用预先确定的 20 条分层样本，不挑容易记住的资料；文字、URL、单图、多图 / 混合 payload 各至少 3 条，并覆盖至少 3 类来源。样本分为两组：

- **Instrumented 组（10 条）：** 捕获后只在产品之外记录一个极短原因代码：`unknown-word`、`listening-miss`、`natural-expression`、`grammar-choice`、`question-error`、`reference` 或 `other`，不写完整句子；
- **Natural 组（10 条）：** 正常捕获，不作任何即时记录。

24–72 小时后，两组都只查看 Inbox 内容，回答目标内容、保存原因、主观确信度以及能否顺利处理。Instrumented 组与隐藏原因代码比较，记为“清楚匹配 / 部分匹配 / 无法判断”；Natural 组记录“可直接处理 / 需要猜测 / 无法处理”。两组结果分别报告，不把有 ground truth 的匹配率和自然使用的自报结果混成一个数字。原因代码仍可能轻微强化记忆，结论中必须披露该测量干扰。评估日志保留在本机，不提交仓库，也不发送给 AI。

### 11.3 MVP 证据下限

正常路径进入任何 GPT 或原生 App 项目前，至少完成：

- 50 次真实捕获；
- 3 类不同来源；
- 20 条相隔至少 24 小时后处理的 capture；
- 一次完整的状态导出与空库恢复演练。

决策规则：

- 若 Instrumented 组清楚 / 部分匹配低于 80%，或 Natural 组“无法处理”超过 20%，先改善自动语境或试验可选 `intentHint`，不增加必填字段；
- 若 7 天处理率低于 30%，或 Inbox 连续两周只增长不处理，先修批处理体验，不进入 GPT；
- 若至少 50% 的已处理资料被判定为“不值得保存”并立即删除，先调整捕获场景和反馈，不把更多自动化当答案；
- 进入 GPT 必须同时满足：已处理至少 20 条；其中至少 5 条的主要成本是语义提取、OCR 或解释；这类工作占全部处理总时间至少 30%，或其中位处理时间超过 60 秒；并且问题不能通过更简单的批处理 UI、文本选区或现有能力明显降低；
- 只有快捷指令可靠性或交互摩擦仍阻碍捕获，并且签名 / entitlement 可持续，才评估原生 App。

原生路线有一个防死锁例外：若完成至少 15 次受控尝试并覆盖 3 类来源后，快捷指令因可复现的系统限制导致超过 20% 尝试失败，或一周内至少 3 次明确放弃捕获，允许提前做原生**可行性 spike**；这不等于批准完整原生 App。

## 12. 隐私与数据边界

### 12.1 MVP 捕获

- 捕获阶段不把资料发送到 GitHub、Tenjin 服务器或 AI 服务；
- Capture Package 保存在用户自己的 iCloud Drive；
- 来源应用交给分享菜单什么，快捷指令才保存什么；
- Inbox 删除不等于删除 iCloud 原包，界面必须显示准确路径和未清理状态；
- 用户执行隐私清理时，可以按路径手工删除 CaptureLog 和状态备份；append-only 不能高于用户删除权。

### 12.2 未来 GPT 的前置条件

> **Informative / non-normative：** 本节只记录未来立项门槛，当前任何实施计划不得据此创建 GPT 任务。

GPT 不属于本 MVP。以后立项时必须满足：

- 原始 Capture Package 与 AI 分析副本分离；
- 导出前逐项预览、排除或裁切；
- 图片分析副本默认移除 EXIF、GPS 和不必要元数据；
- URL 去除 userinfo 和 fragment，查询参数默认不带或逐项明确保留；
- 不发送全量 learnerSnapshot；只使用当前任务必要的最小画像片段和相关已确认证据；
- Tenjin 本地过滤重复、已掌握或 suppressed 项，但用户本次真实失败可以重新激活它们；
- 模型只返回语义建议和 sourceRefs；所有系统 ID 与摘要由 Tenjin 生成；
- 顶层请求错配整包拒绝，单条 proposal 错误单独隔离。

## 13. 明确后置

> **Informative / non-normative：** 本节项目全部不在阶段 A、B、C 的当前规范性需求表中，当前实施计划不得据此预建模块。

以下项目不进入本 MVP 实施计划：

- GPT ZIP / JSON 往返；
- `resultPackageId`、`proposalId` 和 proposal 幂等协议；
- 完整 Vault Backup 和便携附件恢复；
- 24 小时 / 三次扫描的同步停滞状态机；
- 固定跨实现 `packageDigest` 算法与 golden vectors；
- 原生 App 技术栈预选；
- Share Extension、App Group、CloudKit 和自动同步；
- OCR、ASR、音频和视频捕获；
- 捕获时第二个必选入口或必填 intent；
- Windows 上的第二份正式 Tenjin 账本。

这些项目不是被永久否定，而是必须由前序数据证明值得建设。

完整 Data Portability & Recovery PRD 的触发条件是：用户希望在保留附件的同时清理 CaptureLog、需要第二台正式账本设备，或真实恢复演练证明状态 JSON + CaptureLog 无法满足恢复需要。未满足任一条件时不提前建设。

## 14. 验收测试

### 14.1 阶段 A

- Safari 选中文字、Safari 页面、URL、照片单图、照片多图和至少一个阅读器均有真实 Content Graph 样本；
- 日文与 Unicode fixture 逐项记录输入表示、保存字节与读回文本；任何换行或空白规范化都必须显式写入 v1 决策，不能无记录地改变；
- 快捷指令写入至少一个文字、一个 URL 和一个图片 v0 包，主屏 PWA 选择月份目录后可以枚举、读取和显示；
- 用跨 UTC / 本地月界的固定日期 fixture 验证 `capturedAt` 使用 UTC、CaptureLog 分片使用设备本地 `YYYY-MM`；
- manifest 可见但引用文件仍是 placeholder 时，诊断读取页显示暂不可用，不显示部分成功；
- 比较开启与关闭 SHA-256 时的文字、10 MB 单图和 50 MB 多图耗时；
- 重启、离线、权限撤销、iCloud 空间不足时行为被记录；
- 输出 v1 类型白名单、归一化规则、来源应用身份可用性结论和明确拒绝清单。

### 14.2 阶段 B

- 完成 10 次真实捕获并覆盖至少 3 类来源；
- 至少 5 条 capture 在 24 小时后完成晋升、明确归档或删除；
- 文字、URL、单图和多图各至少完成一次“捕获 → 导入 → Inbox 显示”；
- 重选同一月份目录不会重复创建；
- 有序 payload 在 Inbox 中保持原顺序和 role；
- 人工把文字、URL 上下文和多图 capture 转成正式学习项，来源引用可追溯；
- 新增第一个学习项后 capture 仍留在 Inbox；继续新增第二项后，只有显式“完成处理”才变成 reviewed + archived；
- 任一 payload 保存失败时没有 manifest 和成功通知；
- 第一次授权后，后续捕获不再选择目录；
- 不支持或超限输入给出明确提示。

### 14.3 阶段 C

- 文字、URL、单图各完成 20 次稳定态计时；真实使用与专门基准均可计入；
- 当前手工文字流程和快捷指令文字流程各完成至少 10 次基线比较；
- 一次分享 2、5、10 张图片各 3 轮，不丢顺序或分组；
- 用独立 attempt 清单核对受控成功、失败和读回结果；
- 选择包含 50 个 capture 的月份目录并正确导入；
- 导入后保存的 sourceShardMonth / sourcePackageRelativePath 与实际 CaptureLog 路径一致；状态恢复后可以据此提示并定位正确月份；
- 标准 Pilot 语料的 50 个 capture 总 payload 不超过 200 MB；另用一个不超过 50 MB 的包单独做压力测试；
- 重选同一目录新增为 0；
- 同 ID 不同 localPackageDigest 进入冲突提示，不覆盖；不同 ID 的相同内容保留两条 encounter；
- 同版本同摘要、同版本不同摘要和 unsupported-digest-version 三条比较分支均有测试；
- manifest 存在但附件暂不可用时允许以后重试；
- 模拟 quota 错误时当前包不留下半记录，其他包和 iCloud 原件不受影响；
- 删除后重选同一月份目录不会复活；
- 状态导出后在空库恢复，事件、contexts、Inbox 元数据、墓碑和事件坐标一致；
- 恢复后 active / archived capture 显示 `needs-restore` 且 contentRef 缺失；只有整包全部 payload 校验通过后才原子补回并切到 available，deleted capture 不复活；
- 状态恢复拒绝重复 ID、悬空事件 / 来源引用、不支持的摘要版本和冲突墓碑，失败不留下半状态。
- 完整流程“一个 capture 创建两个 item → 完成处理 → 删除 capture → 导出状态 → 空库恢复”成功；两个 item 均解析到 deleted tombstone 的 sourcePayloadIds[] 并显示“来源已删除”。

## 15. 主要风险与缓解

| 风险 | 缓解 |
|---|---|
| 用户再次因快捷指令复杂而弃用 | 共享成品、四步安装、5 分钟门槛；不让用户搭内部动作 |
| 不同来源分享类型不一致 | 先诊断 spike，再冻结 v1；按真实来源建立测试矩阵 |
| 捕获很轻但形成资料坟场 | 先做人工处理闭环；用 7 天处理率和 Inbox 净增长作为阶段门 |
| 24 小时后忘记为什么保存 | 保留 URL、标题、role、顺序和相邻图片；测意图恢复率后才决定可选提示 |
| 手动月份导入有摩擦 | 允许批量、使用设备本地月份并明确当前分片；不伪装成自动同步 |
| iCloud 同步顺序变化 | manifest-last 只作本机完成标记；缺引用文件本次显示暂不可用并允许重试 |
| PWA 本地数据被清理 | 原始资料留在 CaptureLog；持续 Pilot 前提供状态导出与空库恢复 |
| 为未来能力提前造平台 | GPT、完整恢复和原生 App 各自通过真实数据后单独立项 |

## 16. MVP 完成定义

本 PRD 的 MVP 完成，不等于 Tenjin 完整学习系统完成，也不等于应该立即加入 GPT。

完成必须同时满足：

1. 分享捕获在真实 iPhone 上达到速度和可靠性目标；
2. 至少 50 次真实 capture 进入 CaptureLog；
3. 至少 20 条 capture 被延迟处理；
4. 用户可以把原始资料人工转成正式学习项；
5. 已测量意图恢复、处理率、转化率和 Inbox 增长；
6. 状态导出与空库恢复通过；
7. 已作出“继续捕获 / 先修 Inbox / 进入 GPT / 评估原生”的明确决策。

## 17. 复审结论与冻结规则

- 本文已被确认是 Capture Inbox 输入子系统 PRD，不是完整自适应学习系统方案。
- 阶段 A 获准进入实施计划；阶段 B 只能在 A 的真实数据过门后另行批准，阶段 C 不得预先批准。
- `schemaVersion: 0` 端到端真机 spike 后再冻结候选 v1 的顺序获准。
- 50 次捕获、3 类来源和 20 条延迟处理足以作为个人 MVP 的最低方向性证据，不扩成大样本实验。
- 零字段捕获继续保留；意图丢失通过 Instrumented / Natural 两组实验验证，不恢复必填字段。
- 最小状态 JSON 只保护正式状态与引用；完整附件灾备继续作为独立 PRD 后置。
- 有序 payload、最小 ImportLedger、显式“完成处理”和 promotion 的边界已冻结。
- GPT、完整 Vault 和原生 App 的后置条件维持不变。
- 手动月份导入、首次安装、图片无 OCR 和批处理疲劳继续作为真实试验指标，不在阶段 A 前用新功能掩盖。

冻结后，阶段 A 实施只能修改诊断目录、v0 输出和诊断读取页。任何会创建正式 Inbox、实现 v1 持久化、GPT、完整恢复或原生入口的工作都属于范围扩大，必须先修改 PRD 版本并重新批准。

## 18. 官方技术依据

- [Apple：从其他 App 的分享菜单运行快捷指令](https://support.apple.com/en-euro/guide/shortcuts/apd163eb9f95/ios)
- [Apple：快捷指令支持的输入类型](https://support.apple.com/en-ie/guide/shortcuts/apd7644168e1/ios)
- [Apple：快捷指令中的文件保存动作](https://support.apple.com/en-ca/guide/shortcuts/apdaf74d75a5/ios)
- [Apple：共享快捷指令的 Import Questions](https://support.apple.com/guide/shortcuts/add-import-questions-to-shared-shortcuts-apdf330fd3a0/ios)
- [WebKit：Safari 18.4 在 iOS 支持 `webkitdirectory`](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)
- [Apple：免费 Personal Team 的周期性重新配置限制](https://developer.apple.com/help/account/basics/about-your-developer-account/)
