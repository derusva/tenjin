# Tenjin 可运行竖切版设计

**日期：** 2026-07-11

**目标：** 在不等待完整交换协议落地的前提下，先交付一个真实可操作、离线优先的 Tenjin 主流程，让用户能体验“记录 → 复习 → 搜索 → 查看证据”。

## 范围

本竖切版实现：

- 三类快速记录：查过、没听出、表达纠正；
- 追加事件账本与独立 context 存储；
- R/L/P 通道的确定性派生状态；
- 固定 5 条预算复习，回答 pass / hesitant / fail；
- 搜索、最近证据和 8 秒撤销；
- IndexedDB 本地持久化；
- 可安装、可离线启动的 PWA；
- 纯 TypeScript core 与浏览器适配器边界。

本竖切版暂不实现：

- 多设备 .tenjin 压缩包交换；
- redaction、promotion 冲突和别名合并 UI；
- LLM bridge；
- iOS Shortcut；
- 音频录制和 ASR。

这些能力不会被假装成已完成；界面只暴露真正可工作的功能。

## 架构

代码采用 pnpm workspace：

- packages/core：事件类型、校验、identity 规范化、reducer、复习选择；
- packages/storage-indexeddb：事件和 context 的事务存储；
- apps/web：React + Vite PWA、应用服务和界面。

数据流：

    用户动作
      → 应用服务创建不可变事件
      → IndexedDB 原子写入事件与 context
      → core 对当前事件集合全量派生
      → React 渲染 captures、items、review queue 与 evidence

生产界面不直接修改 item 状态。

## 状态规则

- lookup 激活 R 通道为 unstable；
- listening miss 激活 L 通道为 unstable；
- production correction 激活 P 通道为 unstable；
- hesitant 记录证据但不晋升；
- fail 清空该通道未完成的验证进度；
- 三次非补录 pass 必须落在三个不同 UTC 日期，并从第一次到第三次至少跨 7 天，才进入 stable；
- stable 在 30 天内两次 fail 回到 unstable；
- 被撤销 capture 及其派生观察不再参与视图。

## 视觉基准

主屏概念图：docs/design/tenjin-home-mobile-concept.png

复习概念图：docs/design/tenjin-review-mobile-concept.png

设计系统：

- 背景：温暖纸白 #F3EFE6；
- 主文字：墨黑 #171A18；
- 品牌色：深森林绿 #123F31；
- 主动作：朱红 #C9342B；
- 边线：#B7B2A8；
- 标题字体：系统日文明朝体；
- 控件字体：系统无衬线；
- 容器模型：开放式页面、细分隔线和列表，不使用卡片网格；
- 记忆点：页面左侧一条细朱红账本线。

允许的首屏文案：

- Tenjin
- 今天遇到了什么？
- 查过
- 没听出
- 表达纠正
- 记下来
- 复习 5 条
- 搜索
- 最近记录
- 记录
- 复习
- 数据

## 错误与恢复

- 空输入不会创建事件；
- context 和事件必须在同一 IndexedDB 事务中写入，失败时界面不得显示成功；
- 存储读取失败显示可恢复错误，不清空现有数据；
- 撤销追加 capture_discarded，不删除历史事件；
- 首次启动为空账本，不注入伪造学习记录。

## 验收

- core、storage 和 UI 自动化测试通过；
- production build 通过；
- service worker 产物存在；
- 桌面与移动 viewport 均无溢出；
- 可实际完成记录、撤销、复习回答和搜索；
- 浏览器截图与概念图完成并排检查。
