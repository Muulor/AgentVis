# AgentVis 四大核心特性深度技术解析

> 版本：发布前技术文档  
> 更新时间：2026-06-21

---

## 一、交互可视化增强（Visual Enhancer）

### 1.1 功能定位

`VisualEnhancerService` 是 Planning 模式的**后处理增强层**。当 Master Brain 给出纯文本响应后，该服务判断内容是否适合可视化，若适合则驱动 LLM 将其转化为包含 ECharts 图表、Mermaid 流程图、Widget 交互组件的富媒体版本。

**设计原则**：增强失败时无声降级，绝不影响主流程的响应输出。

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
shouldEnhance() ─── false ──→ 直接返回原始内容
     │ true
     ▼
buildVisualEnhancerSystemPrompt()   // 格式规范注入
buildVisualEnhancerUserPrompt()     // 原始内容包装
     │
llm_chat_stream (流式调用)           // 使用 sessionId 过滤多路事件
     │
流式收集 Promise 内部超时 120s
     │
增强结果长度校验 (≥ 原始 60%)        // 防止 LLM 输出摘要式空内容
     │
返回 VisualEnhanceResult { content, enhanced: true }
```

**流式调用设计理由**：火山引擎等 provider 的非流式接口对大 payload 有超时问题，系统所有 LLM 调用（MB/SA/Chat 模式）统一使用流式，Visual Enhancer 跟随此约定。

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
| `shouldEnhance` 返回 false | 返回原始内容，`enhanced: false` |
| Planning 任务被取消 | 跳过增强，直接保留取消前结果 |
| LLM 调用抛出异常 | `catch` 捕获，返回原始内容 |
| 120s 流式收集超时 | 超时回退，返回原始内容 |
| 增强结果过短（< 原始 60%） | 校验不通过，返回原始内容 |

---

## 二、Vite 实时预览

### 2.1 功能定位

`VitePreviewService`（`services/preview/`）允许 Agent 生成的多文件前端项目（React/Vue/Vanilla）**在应用内直接启动 Vite Dev Server** 并嵌入 iframe 实时预览，无需用户手动操作命令行。

**支持模板**：`vanilla` / `react-tailwind` / `vue-tailwind`

**触发入口**：聊天气泡中的单文件/多文件代码块、文件列表中的项目目录或 `package.json`、文件预览面板均可触发 Vite 项目预览。

---

### 2.2 状态机

```
idle → installing → starting → running
           ↓
         error
```

每次 `startProject` 递增 `startGeneration`，各 async 阶段结束后调用 `assertNotPreempted()` 检查是否被新请求抢占，防止产生孤儿进程。

---

### 2.3 完整启动流程

```
startProject(deliverableDir, projectName, templateId, files, packageJson?)
     │
①  checkNodeEnvironment()              // 检查 Node.js ≥ 18
     │
②  templateManager.ensureTemplateReady()
     │  首次：npm install → 缓存 node_modules
     │  已有：检测依赖漂移（依赖版本变化时重新安装）
     │
③  initProjectDirectory()             // 创建项目结构
     │  ├─ 解析 projectPackageJson 提取额外依赖
     │  ├─ 无额外依赖 → mklink /J 创建 junction 指向模板缓存（零成本）
     │  └─ 有额外依赖 → 合并 package.json + npm install（独立安装）
     │  ├─ 写入配置文件（自动跳过 Agent 已提供的同名文件）
     │  ├─ 智能入口检测：Agent 提供 main.tsx 时自动生成适配 index.html
     │  ├─ 写入 Agent 源文件（CSS 自动降级 Tailwind v4→v3 语法）
     │  └─ 链接静态资源目录（public/, src/assets/ 用 junction 避免复制二进制）
     │
④  portAllocator.allocate()           // fetch 探测 3100-3199 范围空闲端口
     │
⑤  shell_execute(npx vite --port {port} --strictPort --host 127.0.0.1, background=true)
     │                                // 仅回环地址，安全隔离
     │
⑥  waitForViteReady()                 // 轮询 HEAD 请求，500ms 间隔，30s 超时
     │
⑦  syncToStore → previewStore.setProjectUrl()
     │
     └─ 返回 http://localhost:{port}  → LivePreviewPanel iframe src
```

---

### 2.4 关键设计决策

#### Windows Junction（无需管理员权限）
模板 `node_modules` 通过 `mklink /J` 创建目录联接点指向共享缓存，每个预览项目重用同一份依赖，**零额外磁盘空间和安装时间**。切换模板时自动重建 junction 指向正确目标。

#### 额外依赖的独立安装
若 Agent 的 `package.json` 包含模板未内置的库（如 `d3`, `three.js` 等），自动合并并执行独立 `npm install`。旧 junction 与旧真实目录的清理逻辑用 `rmdir`（只删 junction）与 `rmdir /S /Q`（删真实目录）分情况处理。

#### CSS Tailwind v4→v3 自动降级
LLM 可能生成 Tailwind v4 语法（`@import "tailwindcss"`, `@theme {}`），但模板环境固定使用 v3。写入 CSS 文件前自动执行三步替换：

```
@import "tailwindcss"  →  @tailwind base; @tailwind components; @tailwind utilities;
@import "tailwindcss/..."  →  移除（v3 不支持）
@theme { ... }  →  :root { ... }
```

#### 孤儿进程清理
首次启动 Vite 项目预览时执行懒初始化：注册窗口关闭清理钩子，并扫描 `3100-3110` 端口上可能由上次异常退出留下的 Vite 进程；关闭窗口时通过 `beforeunload` + Tauri 清理钩子执行 `shell_kill`。

---

### 2.5 端口管理（`PortAllocator`）
使用 `fetch` 探测而非 `bind` 尝试，范围 3100-3199，用 `Set` 跟踪已分配端口，`release()` 在进程终止后归还，无端口泄漏。

---

## 三、定时任务系统（Cron）

### 3.1 功能定位

Agent 定时任务系统允许用户为任意 Agent 配置**自动触发的任务 Prompt**，在指定时间点以 Planning 模式自主执行。执行结果持久化到该 Agent 的聊天历史，用户随时可翻看。

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
  └─ AgentChatView ← usePlanningMode 接手 Planning 执行
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

定时任务统一使用 **Planning 模式**执行（Full Agent Loop）：

```
setModeFor(agentId, 'planning')          // chatStore 切换模式
必要时切换 Hub 并等待目标 Agent 加载
setCurrentAgentId(agentId)              // 切换当前 Agent
await sleep(800ms)                       // 等待 React 重渲染，避免事件被旧 listener 丢弃
emit('cron:execute_planning', payload)   // AgentChatView 的 usePlanningMode 接手
```

**关键竞态处理**：800ms 延迟等待 React 重新挂钩监听器，防止旧 `agentId` 的 listener 忽略新事件。

**执行状态语义**：`CronExecutor` 将任务标记为 `running` 后触发 `cron:execute_planning`，事件成功发出即把 CronJob 状态更新为 `success`。Agent Loop 的实际执行结果由 `AgentChatView` / `usePlanningMode` 写入聊天历史；当前 CronJob 的 `success/failed` 更接近“是否成功触发 Planning 执行”，不等同于 Agent 最终任务结果。

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
| **Vite 实时预览** | Junction + Dev Server 管理 | 零成本依赖共享 / CSS 自动降级 / 竞态防护 / 懒清理孤儿进程 |
| **定时任务** | Cron 轮询 + Planning 事件触发链 | 双向 UI 映射 / 防重入 / 一次性任务自动关闭 / 跨 Hub Agent 切换 |
| **IM 通道** | 多 Bot Channel 工厂 + 平台长连接 + 节流推送 | 飞书/Slack 适配 / Bot 级任务隔离 / 附件统一落盘 / 2s 节流卡片更新 |
