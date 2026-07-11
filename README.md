# Tenjin

Tenjin 是一个离线优先的个人日语学习账本。它把“刚查过的词、没听出来的表达、被纠正的说法”快速记到本机，并用 R（识别）、L（听辨）、P（产出）三个通道组织复习证据。

当前版本包含：

- 记录、最近记录与 8 秒撤销
- 五条以内的本地复习会话
- 本地搜索和数据概览
- IndexedDB 事件账本与引用安全的上下文清理
- 可安装、可离线启动的 PWA 外壳

## 本地运行

需要 Node.js 22（推荐）和 pnpm 11。

```bash
pnpm install
pnpm dev
```

开发服务器默认打开 `http://localhost:5173`。

## 验证与构建

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm preview
```

`pnpm preview` 会预览最近一次构建，默认地址是 `http://localhost:4173`。

## 数据与安装说明

学习记录只写入当前浏览器的 IndexedDB，不会上传。数据页会显示浏览器实际返回的持久化状态；即使已获持久化保护，也不能把它视为绝对备份。iPhone/iPad 上请先“添加到主屏幕”再长期使用，删除主屏幕应用也可能一并删除这份本机工作副本。

代码按职责拆分为：

- `packages/core`：事件、归一化、派生状态和复习选择
- `packages/storage-indexeddb`：原子写入与本机快照
- `apps/web`：React 界面、流程编排和 PWA
