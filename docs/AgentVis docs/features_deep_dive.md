# AgentVis 四大核心特性深度技术解析


> 命名说明：用户界面中的「Task 模式」对应内部模式值 `planning`；`usePlanningMode`、`services/planning` 和 `cron:execute_planning` 等既有代码标识保持不变。

---

## 一、交互可视化增强（Visual Enhancer）

### 1.1 功能定位

`VisualEnhancerService` 是 Task 模式的**后处理增强层**。当 Master Brain 给出纯文本响应后，该服务判断内容是否适合可视化，若适合则驱动 LLM 将其转化为包含 ECharts 图表、Mermaid 流程图、Widget 交互组件的富媒体版本。

**设计原则**：MB 原始回复优先展示；增强失败时无声降级，绝不影响主流程的响应输出。

---

### 1.2 触发判断（`shouldEnhance`）

增强不是无条件触发的，`VisualEnhancerService.ts` 中定义了精确的启发式评估逻辑：

| 条件 | 说明 |
|------|------|
| 内容 < 200 字符 | **直接跳过**，短回复无需增强 |
| 已含 `` ```echarts `` / `` ```mermaid `` / `` ```widget `` | **直接跳过**，避免重复处理 |
| 含百分比数字（`\d+[%％]`） | ✅ 指标 1 |
| 含数量级单位（中文数量级或英文 k/m/b、users/items 等） | ✅ 指标 2 |
| Markdown 无序列表 ≥ 4 项 | ✅ 指标 3 |
| 命中数据分析关键词（对比/趋势/占比/流程/架构…） | ✅ 指标 4 |
| 内容 > 800 字符的长报告 | ✅ 指标 5 |

**触发规则**：5 个指标满足 ≥ 2 个时，才发起 LLM 增强调用，精确控制不必要的开销。

---

### 1.3 增强执行链路

```
MB 原始 response
     │
立即更新 checkpoint 为正式原文消息
     │
结束 foreground streaming，FSM 面板折叠为静态“已处理”，输入框解锁
     │
shouldEnhance() ─── false ──→ 原文保持为最终消息
     │ true
     ▼
按 messageId 加入后台增强队列（同一 context 串行）
     │
buildVisualEnhancerSystemPrompt()   // 格式规范注入
buildVisualEnhancerUserPrompt()     // 原始内容包装
     │
llm_chat_stream (流式调用)           // 使用 sessionId 过滤多路事件
     │
后台流式收集，UI 继续稳定展示原文
     │
增强结果长度校验 (≥ 原始 60%)        // 防止 LLM 输出摘要式空内容
     │
增强版成为最终消息，并保留“增强 / 原文”切换
```

**流式调用设计理由**：火山引擎等 provider 的非流式接口对大 payload 有超时问题，系统所有 LLM 调用（MB/SA/Chat 模式）统一使用流式，Visual Enhancer 跟随此约定。VE 的增量片段只在后台收集，不再用未完成的 Markdown、Mermaid 或 ECharts 内容覆盖已可阅读的 MB 原文。

**UI 显示策略**：MB 原文持久化后，动态 FSM 面板立即结束并切换为默认收起的静态“已处理” PlanningTrace，输入框同时恢复可用。增强调用在后台继续，消息底部左侧显示“等待/正在生成可视化版本”和独立的“停止增强”按钮。增强通过校验后，同一条消息原位更新并默认显示增强版，底部同一位置变为常驻版本切换控件。原文直接复用消息已有的 `metadata.persistContent`，不新增跨会话或记忆持久化字段。

**停止与并发语义**：消息底部“停止增强”只取消对应 messageId 的 VE；输入框终止按钮只取消当前 foreground AgentLoop，两者不联动。同一 Agent/Hub 仅运行一个 VE，其余任务排队；不同 context 可并行。删除、撤回消息或删除 context 时会自动取消关联的后台增强任务。

---

### 1.4 Prompt 架构（`VisualEnhancerPrompt.ts`）

Prompt 精简控制在 ~2000 tokens，包含 3 类格式的完整规范与示例：

#### ECharts 图表（优先级最高）
- 支持：`bar`（柱状）/ `line`（折线）/ `pie`（饼图）/ `scatter`/ `radar`/ `gauge`/ `funnel`/ `heatmap`
- 严格 JSON-only，**禁止 function/callback**（安全沙箱需求）
- 系统已内置 tooltip、grid、配色，Prompt 仅要求输出核心配置

#### Mermaid 流程图
适合流程步骤、层级关系、时序展示，直接使用标准 `` ```mermaid `` 代码块

#### Widget 交互组件（三种子类型）

| 类型 | 语言标记 | 适用场景 |
|------|---------|---------|
| 选项卡片 | `widget-choices` | 方向选择；支持单选（立即提交）/多选（点确认） |
| 信息图 | `widget-chart` | 多维信息点汇总；type: flow/bar/info |
| 决策树 | `widget-tree` | 多层级路径探索；带面包屑、淡出动画 |

**增强策略映射**：
- 数据对比/统计 → ECharts
- 流程/步骤/关系 → Mermaid
- 可选方向/建议 → widget-choices 或 widget-tree
- 趋势/时序 → ECharts 折线图
- 多维信息点 → widget-chart (info)

**内容去重约束**：同一事实、指标或数据集只能保留一种主呈现形式。可视化已覆盖的标签和值不得再次出现在相邻表格、列表或正文中；如果可视化只覆盖源表的一部分，只保留尚未覆盖的行和补充信息。

---

### 1.5 渲染层视觉主题系统

Visual Enhancer 的增强链路分为两层：**Prompt 层**（1.4 节）驱动 LLM 输出图表代码，**渲染层**在 TypeScript 中对 LLM 输出做后处理美化。两层的风险隔离原则：

| 层 | 风险等级 | 说明 |
|---|---|---|
| Prompt 层 | ⚠️ 高风险 | LLM 输出不可控，复杂配置可能导致渲染失败 |
| 渲染层（TypeScript Recipe） | ✅ 低风险 | 纯代码控制，JSON 解析后注入；渲染失败时回退到未增强主题配置 |

**核心设计决策**：所有视觉美化逻辑封装在渲染层，不在 Prompt 中引导 LLM 生成复杂样式配置，从而避免渲染失败率上升。

#### ECharts 视觉主题（`EchartsVisualTheme.ts`）

管线位置：`buildSafeEChartsOption()` 在 JSON 解析 → `stripRiskyFields` → `normalizeTitle` → `normalizeSeries` 之后执行。

**五套预设主题**（`VISUAL_PRESETS`）：优先读取 `__visualPreset`，未指定时按深色/浅色模式使用默认预设；LLM 输出的 `option.color` 会保留，但不会用于自动选择预设。每套包含完整调色盘、渐变对、阴影色等，深色/浅色模式下的 `areaOpacity` 和 `radarAreaOpacity` 分别优化。

**类型专属 Recipe**：

| 图表类型 | Recipe 内容 |
|---|---|
| `bar` | 圆角柱体 + 纵向渐变 + 多系列进场动画错开（120ms/系列）+ hover 阴影 |
| `line` | 平滑曲线 + 同色相透明面积渐变 + 进场错开 + hover 发光（同色 shadowBlur） |
| `pie` | 环形切片 + **透明包边**（自适应气泡背景）+ hover 悬浮缩放阴影 |
| `gauge` | 细长发光指针 + 弧形进度条（14px 宽 + 同色发光）+ 数值/标签上下分离 |
| `scatter` | 半透明点 + hover 填满不透明度 + 阴影 |
| `radar` | 填充区域 + 深/浅模式 opacity 适配 |
| `funnel` | 层间间距 + 边框色 |
| `heatmap` | 深/浅模式下统一的 label 与 emphasis 视觉默认值 |

**全局动画注入**（`applyAnimationDefaults`）：`cubicOut` 缓动 900ms，替代默认线性动画。

**Tooltip 玻璃质感**：统一注入 `border-radius: 8px` + 多层 `box-shadow`。

**渐变白边修复**（`colorToTransparent`）：面积图渐变终点改用同色相 rgba 透明色，消除深色背景下 GPU 混合产生的白色光晕。

#### Mermaid 视觉主题（`MermaidVisualTheme.ts`）

**双调色盘**（`DARK_PALETTE` / `LIGHT_PALETTE`）：通过 `themeVariables` 注入 Mermaid `base` 主题，覆盖节点填充、边框、文字、连线等 40+ 变量。

**Mindmap 专用 12 色色阶**（`buildMindmapColorScale`）：直接注入 `cScale0~11`，绕过 Mermaid 从 `primaryColor` 自动推导导致深色模式全黑的问题。深色模式选用中亮度饱和色（HSL L 35~50%），浅色模式选用高亮度柔和色。

**SVG 后处理注入**（`injectMermaidSvgStyles`）：在 `</svg>` 前注入 `<style>` 块：

| CSS 规则 | 效果 |
|---|---|
| `.node rect / .cluster rect / .actor rect` | 圆角 6~8px |
| `.edgePath path` 等 | `stroke-linecap/join: round`，连线端点圆滑 |
| Mindmap `.edge path` | 加粗至 2.2px + 半透明 0.6，降低连线抢眼度 |

**文字对比度保障**（`applyMermaidSvgTextContrast` / `applyMermaidDomTextContrast`）：渲染后遍历所有 `g.node`，根据节点填充色的相对亮度自动切换文字为深/浅色，确保 WCAG 可读性。

---

### 1.6 降级保障


| 场景 | 行为 |
|------|------|
| `shouldEnhance` 返回 false | 已展示的原文直接成为最终消息，`enhanced: false` |
| Task 模式任务被取消 | 跳过增强，直接保留取消前结果 |
| 用户点击“停止增强” | 仅取消对应消息的后台 VE，保留已持久化原文 |
| LLM 调用抛出异常 | `catch` 捕获，返回原始内容 |
| 120s 流式收集超时 | 超时回退，返回原始内容 |
| 增强结果过短（< 原始 60%） | 校验不通过，返回原始内容 |

---

## 二、Project Preview（Vite / Import Map）

### 2.1 功能定位

`VitePreviewService`（`services/preview/`）允许 Agent 生成的多文件前端项目（React/Vue/Vanilla）在应用内预览。它将 Agent 输入视为不可信数据：源文件先进入应用缓存中的独立 staging 工作区，再由 AgentVis 包装配置启动 Vite 或静态服务器，不会在 Agent 交付目录中创建 `vite_preview`、`node_modules` 或运行时配置。完整项目保留自己的入口图、包类型、依赖版本和受支持的 Vite/PostCSS/Tailwind/TypeScript 配置；聊天代码片段仍使用 AgentVis 模板脚手架和静态提取配置，两条路径不会互相混入入口文件。

**支持模板**：`vanilla` / `react-tailwind` / `vue-tailwind`

**运行路由**：显式 `package.json` 或普通模块项目走受信任 Vite 路由；没有包清单且有效根入口（`index.html` 或唯一的根 HTML）含 Import Map 的 Vanilla 项目只在“Import Map 全部合法、顶层 `imports`/`scopes` 覆盖裸导入、模块不需要 TS/JSX/Vue/CSS transform”时走静态路由，保留浏览器原生 Import Map 解析语义。静态候选不满足这些条件时返回明确编译错误，不静默回退到 Vite。

**触发入口**：聊天气泡中的单文件/多文件代码块、文件列表中的项目目录或 `package.json`、文件预览面板均可触发 Project Preview。

---

### 2.2 状态与生命周期

```text
idle -> installing -> starting -> running
           |             |
           +-----------> error
```

每次 `startProject` 都创建新 generation，启动、安装、健康检查和进程监控在同一个串行化生命周期中校验 generation。UI 还为每次可见预览分配单调递增的 request ID；服务状态、延迟 stop 和 retry 都必须匹配当前 ID，旧请求不能覆盖新面板或重放上一 Agent 的项目。只有请求真正提交给 Preview 服务后才开放“重试”，因此源树扫描等 pre-service 错误会引导用户从原入口重新启动。新请求会先取消旧依赖安装并终止旧 PID，再删除旧 staging；source/package 写入后重新检查取消状态，npm、Node 检查与 dependency-link 命令则在执行前登记 execution ID，避免取消后仍启动长时命令。模板准备在 renderer 内采用 single-flight owner/joiner，并由 Rust 为共享模板目录持有 OS 级跨进程排他 lease；另一个 AgentVis 实例必须等待 owner 完成并在取得 lease 后重新检查缓存。完成 marker 保存与受控 `package.json` 相同的提交内容，更新时在任何 manifest 写入前先删除 marker，因此崩溃不会把新 manifest、旧 `node_modules` 和旧 marker 误判为同一完成版本。只有真正发起 `npm install` 的 run 登记并取消自己的 execution，加入 Shell warmup 或其他共享安装的 Preview 不会误杀共享 owner；owner 失败后，仍活跃的 joiner 最多重试一次并重新竞选所有权。托盘 `Exit` 获得确认后，退出生命周期会在第一个异步等待前同步使 UI request ID 失效，再等待同一 service cleanup；cleanup 期间若出现新任务则暂停退出并重新确认，request-scoped 原生退出失败会释放退出锁，允许下一次 `Exit` 重试。标题栏 X / Alt+F4 只隐藏窗口，不触发此 cleanup。“重试”会使用当前请求的副本创建全新运行时，不复用已失败状态。

iframe 另有展示层状态：启动中显示阶段信息，页面通过受信任 diagnostics bridge 发送 `booting` / `ready` / `runtime-error` / `unhandled-rejection` / `resource-error`。宿主同时校验 `event.source` 和预览 origin，不接受其他窗口的伪造消息。受控 URL 进入 running 或手动刷新时会启动 8 秒“诊断桥是否连通”计时；任一可信 bridge 消息（包括早期 `booting`）即可证明连接并结束该计时，不再把等待纹理、字体等资源导致的慢 `window.load` 误报成 Retry。bridge 会在 `DOMContentLoaded` 重放当前 lifecycle，并在完整 `load` 后发送 `ready`；迟到的 lifecycle 只清除旧的握手警告，不覆盖真实 runtime error。iframe 尚停留在继承宿主 origin 的 `about:blank` 时不会发送面向未来预览 origin 的 ping，导航提交后仍只使用精确 origin。可信 ping 到达前仅无正文的 lifecycle 可用于握手，runtime/resource/rejection 诊断正文只缓存；ping 通过 allow-list 后才向该精确宿主 origin 重放，避免以 `*` 泄露错误细节。若始终没有任何可信信号，超时后会揭开页面并显示可操作诊断，而不是无限转圈。

宿主 renderer 自身采用两级错误隔离：Markdown 中按需加载的 Mermaid/ECharts 失败时只降级对应图表并允许重试；其他未捕获 React 异常由入口级 boundary 接管，保留“重新加载 / 关闭应用”和错误详情，崩溃页的“关闭应用”使用独立的全进程退出兜底。正常窗口生命周期由 Rust 原生层持有：标题栏 X / Alt+F4 会发出可补领、需 ACK 的 hidden 状态并隐藏主窗口，托盘 `Open AgentVis`、左键/双击、二次启动以及任务通知激活共用同一恢复与聚焦 helper；single-instance 回调忽略二次启动的参数和工作目录，只恢复既有进程。每次显式托盘 `Exit` 都会分配新的 `requestId` 并取代旧请求；Renderer 先 peek，把请求同步交给 handler 后再 ACK，随后通过 request-owned 最新请求队列执行活动任务确认、Preview cleanup，并仅凭仍有效且已 ACK 的同一 `requestId` 调用原生退出。X 会取消尚未完成的 Exit；cleanup 中紧接的新请求会在旧请求失败后自动继续。当前 attempt 若在 5 秒内没有 ACK，Rust watchdog 会直接结束进程；若 Renderer 在 ACK 后才失去响应，再次点击 `Exit` 会建立新的未 ACK attempt 并重新启动 watchdog。Windows debug 可执行文件启动前还会有界探测 `127.0.0.1:1420`；若开发服务未运行，会显示双语说明并安全退出，避免依赖 WebView 缓存进入残缺界面。

手工测试：生产环境与安装包已测试IM任务/Cron任务/20分钟长任务等，在后台 suspend 后仍会持续执行任务，任务完成时会能正常弹出通知消息，点击跳转会激活应用在前端打开相应Agent窗口，应用在托盘隐藏态具备后台任务功能。

---

### 2.3 完整启动流程

```text
startProject(deliverableDir, projectName, templateId, files, packageJson?)
     |
1. 输入预检
     |-- 标准化 ProjectFile 路径，拒绝绝对路径、盘符、URL、NUL 和任何 `..`
     |-- 校验源文件数量/大小，忽略保留目录与 Agent 构建配置
     |-- 限制 package.json UTF-8 字节、依赖数量、包名和版本规格长度
     |-- 收集静态导入、重导出和字面量动态导入的裸包名
     |-- 先确定有效入口；多根 HTML、嵌套项目、缺少入口和已知非 Vite 构建契约分别诊断
     |
2. 模式选择
     |-- Vanilla + 有效根入口 Import Map + 无 package.json -> 先校验 imports/scopes、映射与 native-JS-only 约束
     |-- 拒绝 malformed map、未映射裸导入、.jsx/.ts/.tsx/.vue 源文件或模块式 CSS/transform 导入
     |-- 通过后 -> 静态服务器
     `-- 其他 -> 受信任 Vite 运行时
     |
3. 环境与 staging
     |-- 检查 Node.js >= 18
     |-- 由 Rust 在 {appCacheDir}/project-preview/project-preview-{UUIDv4}/ 创建全新工作区
     |-- 原生命令返回 workspace、runId 与 ownerToken，写入精确匹配的 .agentvis/active marker 并持有跨实例文件 lease
     `-- 仅复制 allow-list 静态资产，跳过 symlink / reparse point
     |
4. 依赖准备（仅 Vite 路由）
     |-- 解析受限 npm 包名与 registry version/range，拒绝 file/link/workspace/git/http/npm alias
     |-- package.json <= 256 KiB，dependencies + devDependencies <= 128，包名 <= 214 字符，specifier <= 256 字符
     |-- 裸导入必须已由模板或 package.json 声明，否则在启动 iframe 前失败
     |-- 共享模板目录由原生跨进程 lease 串行化；完成 marker 必须与受控 package.json 内容一致
     |-- 完整项目声明的依赖版本与 package type 覆盖模板默认值；模板只补齐缺项
     |-- 模板缓存或项目依赖安装均使用 npm --ignore-scripts --no-audit --no-fund
     `-- 不含项目依赖的片段/项目才将 staging/node_modules junction 指向受控模板缓存
     |
5. 物化项目
     |-- 完整项目只写入自己的入口图；为已识别 main 或唯一根 HTML 补齐 index.html，模式选择与物化共用同一入口分析
     |-- 代码片段可借用模板入口，但同 stem 的 Agent 文件优先，避免 App.jsx 遮蔽 App.tsx
     |-- 完整项目保留 Vite/PostCSS/Tailwind/tsconfig/jsconfig；ESLint/Webpack/Rollup/Esbuild 等无关根配置继续过滤
     |-- 仅片段路径执行 Tailwind v4 -> v3 CSS 归一和有预算的字面量 theme 静态提取
     `-- 生成 .agentvis/vite.config.mjs 或 .agentvis/static-server.mjs
     |
6. 启动与验证
     |-- 分配 3100-3199 回环端口，以 backgroundManaged 启动并记录确切 PID
     |-- 轮询 /.agentvis/health 并校验本次随机 token
     |-- GET 根 HTML 和其浏览器 module 入口，在展示 iframe 前捕获入口 4xx/5xx；深层按需模块由 iframe diagnostics 接续
     `-- 写入 previewStore，并启动 PID 状态监控
```

---

### 2.4 信任边界与资源预算

#### 受控运行时

Vite 的命令行只显式加载 AgentVis 生成的 `.agentvis/vite.config.mjs`。对于完整项目，该包装配置会从 staging 加载项目自己的根 Vite 配置并保留插件、alias、位于 staging 内的 root/env/public 和 CSS 工具链语义，再覆盖 host/port、CORS、`server.fs.strict`、cache 位置和 diagnostics/health 等服务边界；PostCSS/Tailwind 配置也只从 staging 解析。代码片段不加载项目构建配置，继续使用 AgentVis 模板配置。

完整项目的 Vite/PostCSS/Tailwind 配置属于可执行 Node 代码；app-cache staging 保护原交付目录并限制 Vite 的文件服务范围，但 `preview=inherit`/Local Audit 不是操作系统级 VM，不能阻止配置代码以当前用户权限主动访问其他本机文件或网络。因此只应预览自己或可信 Agent 生成的完整项目；这项兼容路径不能描述为任意不可信构建配置的强隔离执行。Import Map 中的远程 URL 同样会由预览页面按浏览器语义请求。

#### 有界输入

| 类型           | 预算                                                                                 | 超限行为                                                |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 源文件         | 最多 500 个；单文件 4 MiB；合计 32 MiB                                               | 启动前返回结构化预览错误                                |
| `package.json` | UTF-8 最多 256 KiB；依赖/开发依赖合计 128 项；包名 214 字符；版本 specifier 256 字符 | npm 执行前返回 `invalid-package`                        |
| 静态资产       | 最多 1,000 个；单文件 64 MiB；合计 256 MiB                                           | 停止复制并回收本次 staging                              |
| 目录扫描       | 最深 24 层；最多扫描 10,000 个 entry                                                 | 停止扫描，不跟随链接                                    |
| staging 删除   | 单个 no-follow pass 最多 100,000 个 entry、128 层、2 秒；单次 stale sweep 最多 5 秒  | 保留带 receipt 的 quarantine，后续 sweep 从剩余目录继续 |

源树枚举、文本读取和资产复制分别通过原生 `preview_list_source_tree`、`preview_read_text_file` 与 `preview_copy_assets` 完成。目录 entry 在 Rust 迭代器中边枚举边计数，不会先在 renderer 一次性物化；列表将物理 `sourcePath` 与 staging `path` 一一绑定，`src/` 等目标前缀不会反向改变源文件读取位置。枚举只统计 `.env` / `.env.*` 的数量而不读取内容；若启动随后失败，UI 会在保留主错误的同时提示环境文件未进入隔离预览。文件在同一个已验证 handle 上执行 `fstat` 与读取/复制，并以 handle 的最终解析路径再次确认仍位于 deliverables 根目录内。源码和文本读取继续拒绝多硬链接；Windows 静态资产只有在原生层枚举出的全部 NTFS hardlink 名称都能复验为同一 Agent 工作间内的同一文件对象时才允许只读复制，任一链接跨工作间、位于 deliverables 外、发生变化或无法枚举都会 fail closed；其他平台仍拒绝多硬链接资产。资产写入在 Unix 上从已持有的 workspace/parent dirfd 通过 `mkdirat`/`openat` 相对创建，在 Windows 上由不共享删除权限的 no-follow 父目录 handle 固定路径链；`destinationPrefix` 同样按 root-relative 路径验证。资产复制仅允许明确的图像、字体、音视频、3D 模型、JSON/CSV 和 WASM 等非配置类扩展名；跳过隐藏文件/目录、`Agent-Log`、构建产物、包缓存、锁文件、`package.json`、`tsconfig.json`、`jsconfig.json`、symlink 和 Windows reparse point。

#### Staging 所有权与原生回收

Preview workspace 的创建与删除由 Rust 原生命令负责。`preview_create_workspace` 只在真实的 app-cache `project-preview` 根目录下创建名称为 `project-preview-{UUIDv4}` 的直接子目录，返回 `workspace`、`runId` 与随机 `ownerToken`，并写入与二者精确匹配且包含活动时间的 `.agentvis/active` marker。活跃 run 最多每 60 秒刷新 marker；原生层同时持有跨实例文件 lease，因此另一个 AgentVis 实例不能把仍在使用的 workspace 判为可清理。

正常回收必须向 `preview_cleanup_workspace` 提交期望的 `runId` 与 `ownerToken`。除 marker/token 匹配外，Rust 还必须证明该 `ownerToken` 的 lease 正由本进程 registry 持有，并在清理前释放；仅知道另一个实例的 marker/token 不能发起正常回收。Rust 随后重新验证 app-cache 根目录、直接子目录关系、UUIDv4 名称、symlink/reparse 状态和 canonical containment；任一条件不成立都会 fail closed。通过验证后，workspace 先在受控 cache 根目录内原子重命名为隔离 trash，再由不跟随链接的显式栈删除器回收。Windows 上刚终止的 Node/Vite watcher 可能短暂保留 cwd 或文件句柄；原生层只对 access denied / sharing violation / lock violation（错误码 5/32/33）执行约 1.6 秒的有界退避，并在每次重试前重新验证 workspace、owner 与 receipt。重试耗尽仍会删除临时 receipt、恢复本地 lease 并 fail closed。删除器不会递归消耗调用栈，并同时限制单轮 entry、深度和执行时间；超限或中途失败时不恢复可能已部分删除的目录，而是保留 root receipt 与 quarantine，供后续 stale sweep 继续。`node_modules` junction 或其他 symlink/reparse point 只删除链接本身，不遍历目标。

陈旧 workspace 也由原生 `preview_cleanup_stale_workspaces` 分页有界处理，不再由前端依据 mtime 猜测后递归删除。候选必须至少 24 小时未活动、通过同一组身份/路径验证，并且原生层成功获取文件 lease 后才可进入隔离删除。原子 quarantine 前会在 cache 根目录写入与 `.trash-{UUIDv4}` 精确配对的 `.trash-{UUIDv4}.owner.json` receipt；若部分删除已移除 workspace marker、导致无法安全恢复原名，该 receipt 会保留所有权证据。后续 stale sweep 只有在 trash 与 receipt 严格命名且相互匹配、都是受控根目录中的真实直接子项、receipt 也已超过 24 小时时，才以 no-follow 方式自回收残留 quarantine；每轮删除会实际推进一部分条目，entry/时间预算耗尽后仍保留 receipt，下一轮从剩余树继续。若配对 trash 已不存在，只有严格命名、内容自洽、真实普通文件且同样至少 24 小时的孤立 receipt 才可删除，错配、链接或新 receipt 一律保留。整个 stale IPC 还有 5 秒总执行预算。前端 cleanup backlog 有容量与单轮重试上限，失败项会移到队尾以避免饥饿；新的清理失败、quarantine 或 backlog 溢出都会重新登记原生 stale recovery，使同一应用会话中已完成过一次 sweep 也不会永久跳过后来产生的残留。

---

### 2.5 进程可观测性与端口管理

Rust 后台 registry 为 `background=true` 进程异步排空 stdout/stderr，每路保留最后 1 MiB 并记录已截断前缀字节数。`shell_background_status(pid)` 返回 `running` / `exited`、退出码和输出 tail；退出后 tombstone 保留 5 分钟，足以让启动阶段和运行中监控定位错误。

`PortAllocator` 在 3100-3199 范围分配本地端口，但端口只是路由资源，不是进程所有权证明。服务只终止本次 registry 记录的 PID，并用随机 health token 确认端口上响应的确是当前运行时；不再扫描 3100-3110，也不再因“某端口被占用”而终止未知进程。

### 2.6 失败分类与兼容边界

- 入口类错误区分多 HTML、缺少入口、嵌套项目目录和已知非 Vite 构建工具；不会用通用“编译失败”掩盖目录选择问题。
- npm 安装错误区分 Registry 认证、网络/代理/证书和一般安装失败。安装仍固定禁用 lifecycle script；需要原生二进制或安装期生成的包应在项目自己的开发环境中运行。
- `file:` / `workspace:` / Git / URL / alias 等非 Registry 依赖明确归类为不受支持的项目契约，而不是伪装成缺少包。
- 链接/重解析点和源/资产预算错误显示对应安全原因与上限。运行期诊断会区分 WebGL/WebGPU 等嵌入浏览器能力、CORS/CSP 和远程资源加载问题，但不会把这些环境差异改写成项目编译错误。

---

## 三、定时任务系统（Cron）

### 3.1 功能定位

Agent 定时任务系统允许用户为任意 Agent 配置**自动触发的任务 Prompt**，在指定时间点以 Task 模式自主执行。执行结果持久化到该 Agent 的聊天历史，用户随时可翻看。

---

### 3.2 整体架构

```
CronSettingsTab (UI)
     │  创建/修改/删除/启用
     ▼
Rust SQLite (cron_repo.rs)    ← cron CRUD IPC 命令
     │  cron_list_all_enabled
     ▼
CronScheduler                  // 单例，应用启动时初始化
  ├─ 每 60s 轮询 checkAndExecute()
  ├─ matchesCronExpression(job.cronExpression, now)
  └─ executingJobs Set（防重入）
     │ 命中
     ▼
CronExecutor.executeCronJob()
  ├─ 标记 running
  ├─ emit('cron:execute_planning', payload)
  └─ AgentChatView ← usePlanningMode 接手 Task 模式执行
```

---

### 3.3 Cron 表达式解析（`cronExpression.ts`）

完整实现标准五段格式（`分 时 日 月 周`）的解析器，支持：

| 语法 | 示例 | 说明 |
|------|------|------|
| 通配符 | `*` | 匹配所有值 |
| 单值 | `9` | 精确值 |
| 列表 | `1,3,5` | 多值或 |
| 范围 | `1-5` | 连续区间 |
| 步进 | `*/2`, `1-10/3` | 等间隔 |

**智能跳跃优化**：`getNextRunTime()` 在计算下一次触发时间时，当月份不匹配直接跳月、日期不匹配跳天、小时不匹配跳时，最大迭代次数为 366×24×60，覆盖一整年周期。

#### 友好 UI ↔ Cron 双向映射

`ScheduleConfig` UI 配置与 Cron 表达式双向转换，支持频率类型：

```
every_n_minutes  →  */N * * * *
hourly           →  M * * * *
daily            →  M H * * *
weekly           →  M H * * W
monthly          →  M H D * *
specific         →  M H D Mo *  （一次性任务，autoDisable: true，执行后自动关闭）
```

---

### 3.4 调度器核心（`CronScheduler`）

```typescript
// 每 60s 轮询，匹配成功后异步并发执行，不阻塞其他任务检查
for (const job of state.enabledJobs) {
    if (state.executingJobs.has(job.id)) continue;  // 防重入
    if (!matchesCronExpression(job.cronExpression, now)) continue;
    state.executingJobs.add(job.id);
    executeAndCleanup(job);  // 异步，无 await
}
```

`executeAndCleanup` 执行完毕后无论成功失败，都在 `finally` 块中 `executingJobs.delete(job.id)`，保证下次能正常触发。

---

### 3.5 执行引擎（`CronExecutor`）

定时任务统一使用 **Task 模式**执行（Full Agent Loop）：

```
setModeFor(agentId, 'planning')          // chatStore 切换到 Task 模式（内部值 planning）
必要时切换 Hub 并等待目标 Agent 加载
setCurrentAgentId(agentId)              // 切换当前 Agent
await sleep(800ms)                       // 等待 React 重渲染，避免事件被旧 listener 丢弃
emit('cron:execute_planning', payload)   // AgentChatView 的 usePlanningMode 接手
```

**关键竞态处理**：800ms 延迟等待 React 重新挂钩监听器，防止旧 `agentId` 的 listener 忽略新事件。

**执行状态语义**：`CronExecutor` 将任务标记为 `running` 后触发 `cron:execute_planning`，事件成功发出即把 CronJob 状态更新为 `success`。Agent Loop 的实际执行结果由 `AgentChatView` / `usePlanningMode` 写入聊天历史；当前 CronJob 的 `success/failed` 更接近“是否成功触发 Task 模式执行”，不等同于 Agent 最终任务结果。

---

### 3.6 UI 配置界面

- `CronSettingsTab`：频率驱动 UI（下拉选频率 + 时间选择器），隐藏 Cron 表达式复杂度；高级模式允许直接输入原始表达式
- `CronJobItem`：任务卡片，显示上次执行状态（running/success/failed）、下次执行时间、启用开关
- `AgentNavItem` 角标：全局 Cron 索引，有启用任务时显示定时任务角标

---

## 四、IM 通信通道（飞书/Slack，多 Bot）

### 4.1 功能定位

IM 通道系统允许用户通过飞书或 Slack 向指定 Agent 下发任务，并在对应平台的消息卡片中查看思维链、Sub-Agent 进度与执行结果。当前架构以 `BotConfig` 为核心，每个 Bot 绑定一个 Hub/Agent，可为同一平台配置多个 Bot，单平台最多 10 个 Bot。

---

### 4.2 架构分层

```
飞书 / Slack 客户端
     │  @机器人或私聊发送消息
     ▼
平台长连接
  ├─ FeishuChannel (WSClient + EventDispatcher)
  └─ SlackChannel (Socket Mode WebSocket)
     │
ImChannelFactory                  // botId → Channel 实例，多 Bot 并存
     │
ImTaskBridge.handleIncomingMessage(botId, message)
  ├─ 幂等去重（processedMessageIds Set）
  ├─ 停止指令检测（/stop, stop, 停止, 终止, 取消）
  ├─ 忙碌拦截（activeTasks[botId] 非空时拒绝该 Bot 新消息）
  ├─ 解析 BotConfig，定位目标 Hub / Agent
  ├─ 附件下载 → im_save_attachment → buildEnhancedPrompt()
  ├─ ImProgressTracker.sendPendingCard()
  └─ triggerPlanningExecution()
     ├─ setModeFor(agentId, 'planning')
     ├─ 必要时切换 Hub 并等待 Agent 列表加载
     ├─ setCurrentAgentId(agentId)
     ├─ await sleep(800ms)
     └─ emit('cron:execute_planning', { source: 'im', botId, imPlatform })
        │
AgentChatView ← usePlanningMode → Agent Loop
     │  onStateChange/onThinkingPhase/onSubAgentObservation...
     ▼
ImProgressTracker（按 Bot 独立追踪，2s 节流批量更新卡片）
     │
平台卡片更新 API（飞书经 Rust 代理绕 CORS，Slack 经 Rust HTTP 代理）
```

---

### 4.3 工厂模式（`ImChannelFactory`）

`ImChannelFactory` 采用平台注册 + botId 实例表。平台适配器仍通过 `registerPlatform()` 注册，但活跃连接不再是“每平台一个”，而是“每个 Bot 一个 Channel 实例”。

```typescript
// 注册平台（模块加载时调用）
registerPlatform('feishu', (config) => new FeishuChannel(config));
registerPlatform('slack', (config) => new SlackChannel(config));

// 创建或复用某个 Bot 的连接实例
const channel = createChannelForBot(botId, {
    platform: 'feishu',
    appId,
    appSecret,
});

initializeImTaskBridge(botId, channel);
```

新增平台只需实现 `ImChannel` 接口并调用 `registerPlatform()`，无需修改任务桥接器。旧的 `createChannel()` / `getChannel()` / `destroyChannel()` 保留为兼容接口，新代码应优先使用 botId 版本。

---

### 4.4 平台连接实现

#### 飞书（`FeishuChannel`）

用户在飞书开放平台创建企业自建应用，获取 `App ID + App Secret`，启用机器人能力，订阅 `im.message.receive_v1` 与 `card.action.trigger` 事件。WebSocket 模式无需公网 Webhook。

飞书 SDK 在 Tauri WebView 中访问 `open.feishu.cn` 会遇到 CORS 限制，因此在 SDK 加载前注入全局 `ProxiedXHR`，将飞书域名请求转发到 Rust 后端 `feishu_http_proxy` 命令，非飞书请求仍交给真实 XHR。

`tenant_access_token` 有效期 2 小时，提前 5 分钟检测刷新，通过 Rust 后端代理请求并缓存在内存中。旧消息过滤使用 `connectInitiatedAt`，避免 WebSocket 建连过程中的新消息被误判为历史消息。

#### Slack（`SlackChannel`）

Slack 通道使用 `botToken`（`xoxb-*`）与 `appToken`（`xapp-*`，需 `connections:write`）建立 Socket Mode WebSocket。消息、卡片更新、文件下载等 HTTP API 通过 Rust Slack 代理命令执行。群聊场景需要 @ Bot，私聊可直接触发任务。

#### 支持的消息与附件

- `text`：文本消息，群聊需 @ Bot
- `image` / `file`：解析为 `ImIncomingAttachment`
- 飞书附件通过 `feishu_download_resource` 下载，Slack 文件通过私有 URL 下载，最终统一由 `im_save_attachment` 写入 Agent 工作目录，并把本地路径追加到 Prompt

---

### 4.5 实时进度卡片（`ImProgressTracker`）

**节流机制**：追踪器设 2s 节流，所有事件在缓冲区累积后批量合并一次推送，避免平台卡片更新频率过高。

**跟踪的事件类型**：

| 事件 | 卡片内容 |
|------|--------|
| FSM 状态变化 | 当前状态标签 |
| `onThinkingPhase` | 思维链步骤（保留最近 8 步） |
| `onSubAgentSpawn` | Sub-Agent 角色描述 |
| `onSubAgentObservation` | 工具调用步骤列表（最近 10 步） |
| `handleBudgetUpdate` | 迭代进度（已用/总计） |

**卡片状态流转**：
```
pending 卡片（正在准备...）
     ↓ 每 2s 节流更新
progress 卡片（实时进度 + 思维链 + Sub-Agent 步骤）
     ↓  任务完成/失败
completion 卡片（结果摘要 + 耗时 + 迭代数）
/ error 卡片（错误原因 + 重试引导）
```

---

### 4.6 任务控制

#### 停止指令
用户在 IM 中发送 `/stop`、`stop`、`停止`、`终止`、`取消` 时，`ImTaskBridge` 只中断该 Bot 当前任务：
1. 发射 `im:abort_task` Tauri 事件（携带 `taskId` 与 `botId`，`usePlanningMode` 监听后中断 Agent Loop）
2. 更新当前平台卡片为错误态
3. 清理 `activeTasks[botId]` 与对应 tracker，恢复该 Bot 接受新消息

#### 卡片按钮动作
平台卡片按钮动作统一进入 `ImTaskBridge`：
- `abort_task`：终止当前 Bot 的任务
- `delete_message`：删除卡片消息
- `delete_file`：删除 Slack 文件

#### 任务状态持久化
活跃任务元信息（`taskId`, `chatId`, `platform`, `botId`）写入 `AppData/im_active_task_{botId}.json`，最近会话写入 `AppData/im_last_chat_{botId}.json`。原生 `im_send` 工具会优先使用 Bot 默认出站目标，其次回退到当前或最近一次会话来发送追加消息。

---

## 总结

| 特性 | 核心机制 | 关键设计亮点 |
|------|---------|------------|
| **Visual Enhancer** | 启发式评分 + LLM 后处理 + 渲染层 Recipe | 5 指标评分 / 全链路降级保障 / TS 低风险视觉注入 / 深浅模式自适应 |
| **Project Preview** | 独立 staging + 受信任 Vite/静态路由 + PID 所有权 | 路径/依赖 allow-list / 禁用安装脚本 / token 健康检查 / iframe 诊断 / 全生命周期回收 |
| **定时任务** | Cron 轮询 + `cron:execute_planning` 事件触发链 | 双向 UI 映射 / 防重入 / 一次性任务自动关闭 / 跨 Hub Agent 切换 |
| **IM 通道** | 多 Bot Channel 工厂 + 平台长连接 + 节流推送 | 飞书/Slack 适配 / Bot 级任务隔离 / 附件统一落盘 / 2s 节流卡片更新 |
