# Tenjin vertical slice — browser acceptance

Date: 2026-07-11  
Branch: `codex/tenjin-vertical-slice`

## Acceptance result

PASS. Capture、草稿保留、真实材料复习、搜索、撤销、数据状态、PWA manifest 和断网重载均在最终 production build 的真实浏览器中通过；控制台没有应用 warning/error。独立代码复审结论为 `APPROVED`，没有 Critical/Important 遗留。

## Method and environment

- Surface: Codex in-app Browser using its Playwright-compatible controls.
- App source: `pnpm build` 生成的 `apps/web/dist`，通过本地 production preview 加载。
- Mobile viewport override: 390 × 844 CSS px。应用内浏览器保留原生 chrome 与 15px 滚动条，最终两张手机截图栅格均为 375 × 812。
- Desktop viewport override: 1280 × 900 CSS px；截图栅格为 1265 × 889，居中 paper shell 实测 760px。
- 两张概念图与最终实现截图均以原始尺寸通过 `view_image` 检查。

## Core workflow

| Check | Result | Evidence |
| --- | --- | --- |
| Capture and recent row | PASS | 分别写入 lookup、listening miss、production correction；最近记录显示 R/L/P、原文和时间，重载后仍在。 |
| Draft retention | PASS | 输入未完成的 production original/correction，切到搜索再返回记录，两段草稿和记录类型均完整保留；保存后才清空。 |
| Review reveal and answer | PASS | Lookup 因没有答案材料不进入队列；会话实际为 2 条 L/P。P 题先显示原句“話すです”，纠正版“話します”只在揭示后出现；hesitant/fail 写入后分别进入下一题与完成态，焦点和 live status 正确。 |
| Search | PASS | 输入“話します”后只剩目标项，并显示 `P unstable` 与证据 2。 |
| Undo | PASS | 新增“撤销重试验收”后在 8 秒内撤销；toast 消失，最近记录中不存在该项。 |
| Data and persistence status | PASS | 数据页显示事件/上下文数量；本机返回“尽力保留”，并明确持久化不等于绝对安全。 |
| Failure/concurrency recovery | PASS | 自动化 deferred-write 回归覆盖首次/后续读取重试、复习保存重试、撤销失败重试、旧撤销不得污染新记录、写入中禁止重开会话或带走草稿；v1 数据库升级阻塞会显示可重试错误。 |
| PWA/offline shell | PASS | manifest 含 192/512/maskable 图标；停止 4178 preview 并确认端口不可达后，浏览器重载仍完整渲染首页和本机数据。更新采用 waiting/prompt 模式，不会自动重载并丢弃内存草稿。 |
| Console errors | PASS | 离线重载后读取 warning/error 日志为空。 |

## Visual fidelity ledger

Accepted concepts:

- `docs/design/tenjin-home-mobile-concept.png`
- `docs/design/tenjin-review-mobile-concept.png`

Implementation screenshots:

- `docs/qa/screenshots/home-mobile-390x844.png`
- `docs/qa/screenshots/review-mobile-390x844.png`
- `docs/qa/screenshots/home-desktop-1280x900.png`

| Comparison point | Result | Notes |
| --- | --- | --- |
| Copy | PASS | Tenjin、主问题、三类记录、主操作、快捷操作、最近记录和底栏标签与锁定文案一致；没有营销文案/KPI。 |
| Layout and hierarchy | PASS | 左侧账本线、主问题、分段输入、单一主操作、双快捷操作、开放列表和固定底栏顺序一致。浏览器对照后把主问题修为 390px 单行，并消除 textarea `rows` 导致的额外高度。 |
| Typography | PASS | 标题/日文使用系统 Mincho，控件使用系统无衬线；字重和编辑式层级与概念一致，无网络字体依赖。 |
| Palette | PASS | paper `#F3EFE6`、forest `#123F31`、vermilion `#C9342B`、ink/hairline 与锁定 token 一致。 |
| Spacing, rules, and borders | PASS | 细线、6px 克制圆角、开放式 ruled sections 和安全区 padding 均保留；没有卡片网格、渐变、玻璃或 glow。 |
| Icons and channel marks | PASS | 使用代码原生线性图标；最近记录显示 R/L/P；pass/hesitant/fail 分别使用 forest/ink/vermilion。 |
| Responsive behavior | PASS | 390px 无横向溢出；长文本可 anywhere 换行；桌面 760px shell 居中，底栏不越出 shell。 |
| Accessibility and motion | PASS | 44px 触控目标、可见 focus ring、live announcement、焦点转移和 reduced-motion 规则均验证/复核通过。 |

### Above-the-fold copy diff

概念与实现的固定首屏文案无差异。状态相关差异如下：

- 概念图输入了示例词，所以“记下来”为红色可用态；最终首页截图为空输入，因此按钮按真实状态禁用。
- 概念图最近行只画标题与通道；实现保留已批准的原文和 ISO 时间，以提供可核对的本机账本证据。
- 概念图包含 iOS 状态栏/主屏手势条；它们属于操作系统 chrome，不由网页绘制。

### Intentional deviations

- 复习概念使用虚构例句、先回想文本和详细笔记；竖切版没有伪造这些数据，只展示真实可导出的 item、通道、笔记空态和选择原因。
- 概念的 `2 / 5` 与截图的 `1 / 2` 来自不同本机数据集；实现只把有真实提示/答案材料的 L/P 项纳入队列，复习预算仍为最多 5 条。
- 概念中的菜单/结束入口由当前固定底栏导航覆盖；完成后另有“结束本次”。
- 首页概念能在一屏容纳三条极简记录；实现因显示原文与时间，在 390px 首屏看到两条并可继续滚动，这是为账本可核对性保留的差异。

视觉 fidelity 已在概念原图和实现原生截图之间逐项验证；核心交互也在同一浏览器验收中验证。

## Command evidence

- `pnpm test`: PASS，245/245（core 129、storage 42、web 74）。
- `pnpm typecheck`: PASS。
- `pnpm lint`: PASS，0 warnings。
- `pnpm build`: PASS；Vite 生成 production bundle，PWA `generateSW` 预缓存 11 项，并生成 `dist/sw.js` 与 Workbox runtime。
- Manifest: `Tenjin 日语学习账本`，standalone，zh-Hans，192/512 PNG + 独立 512 maskable PNG；Apple touch PNG 随构建输出。
