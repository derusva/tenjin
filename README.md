# Tenjin

Tenjin 是一个离线优先的个人日语学习账本。它把“刚查过的词、没听出来的表达、被纠正的说法”快速记到本机，并用 R（识别）、L（听辨）、P（产出）三个通道组织复习证据。

当前版本包含：

- 文字粘贴 / 输入和应用内单张图片记录
- 记录、最近记录与 8 秒撤销
- 五条以内的本地复习会话
- 本地搜索和数据概览
- IndexedDB 事件账本与引用安全的上下文清理
- 可安装、可离线启动的 PWA 外壳

## 在线安装

打开 [Tenjin GitHub Pages](https://derusva.github.io/tenjin/) 后安装：

- iPhone/iPad：Safari 分享菜单 →“添加到主屏幕”。
- Android：Chrome 菜单 →“安装应用”或“添加到主屏幕”。
- 桌面 Chrome/Edge：点击地址栏右侧的安装图标。

首次成功加载后，核心功能可以离线运行。学习记录仍只保存在安装 Tenjin 的那台设备和浏览器中，不会上传到 GitHub。

日常记录不需要配置 iOS 快捷指令：

- 选中的文字：从其他应用复制，回到 Tenjin 首页点击“粘贴”，选择类型后保存；如果浏览器不允许自动读取剪贴板，也可以在输入框内长按粘贴。
- Photos 中的单张截图：从主屏 Tenjin 首页点击“选择图片”，选一张 JPEG、PNG、HEIC 或 HEIF 图片，确认预览后保存。单张上限为 20 MB；内容校验或当前浏览器预览失败时不会入账。
- 查词结果：在“查过”中可以同时填写“查到的意思 / 解释”；只有填写了答案的查词记录才进入 R 通道复习。无答案纯图只保留为 capture 和最近记录；带文字的无答案查词仍可搜索。
- 没听出的内容：近似假名、罗马字、中文拟音或之后查到的字幕都可以直接输入。
- 表达纠正：输入原表达；有纠正版时一并填写，完整句对才进入 P 通道对比复习。

图片只保存在当前 Tenjin 的本机 IndexedDB context 中，不上传，也不进入核心事件 payload。当前不做多图、OCR、语音转写或 GPT 解析；选择图片是应用内正式入口，不要求 Shortcut。

学习画像、解释策略和候选产品能力的来源边界见 [`docs/learning/`](docs/learning/)。
本轮自动化、浏览器与真实 iPhone 验收边界见 [`docs/qa/2026-07-30-learning-image-capture.md`](docs/qa/2026-07-30-learning-image-capture.md)。

## 本地运行

需要 Node.js 22（推荐）和 pnpm 11。

```bash
pnpm install
pnpm dev
```

开发服务器默认使用 `http://localhost:5173/tenjin/`。

## 验证与构建

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm preview
```

`pnpm preview` 会预览最近一次构建，默认地址是 `http://localhost:4173/tenjin/`。

## 数据与安装说明

学习记录和图片只写入当前浏览器的 IndexedDB，不会上传。数据页会显示浏览器实际返回的持久化状态；即使已获持久化保护，也不能把它视为绝对备份。当前导出也不应被视为已经覆盖本机图片的完整备份。iPhone/iPad 上请先“添加到主屏幕”再开始长期记录，Safari 标签页和主屏 Web App 不是同一份工作副本；删除主屏幕应用也可能一并删除本机数据。

代码按职责拆分为：

- `packages/core`：事件、归一化、派生状态和复习选择
- `packages/storage-indexeddb`：原子写入与本机快照
- `apps/web`：React 界面、流程编排和 PWA
