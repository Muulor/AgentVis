# AgentVis Four Core Features Deep-Dive Technical Analysis

> Version: Pre-release technical document  
> Last updated: 2026-06-21

---

## 1. Interactive Visualization Enhancement (Visual Enhancer)

### 1.1 Feature Positioning

`VisualEnhancerService` is a **post-processing enhancement layer** for Planning mode. After the Master Brain produces a plain-text response, this service decides whether the content is suitable for visualization. If it is, the service drives the LLM to convert the response into a rich-media version containing ECharts charts, Mermaid flowcharts, and Widget interactive components.

**Design principle**: if enhancement fails, degrade silently and never affect the main response output path.

---

### 1.2 Trigger Decision (`shouldEnhance`)

Enhancement is not triggered unconditionally. `VisualEnhancerService.ts` defines precise heuristic evaluation logic:

| Condition | Description |
|------|------|
| Content < 200 characters | **Skip directly**. Short replies do not need enhancement. |
| Already contains `` ```echarts `` / `` ```mermaid `` / `` ```widget `` | **Skip directly** to avoid duplicate processing. |
| Contains percentage numbers (`\d+[%％]`) | Signal 1 |
| Contains magnitude units (Chinese magnitude words or English units such as k/m/b, users/items) | Signal 2 |
| Markdown unordered list has >= 4 items | Signal 3 |
| Hits data-analysis keywords (comparison, trend, share, process, architecture, etc.) | Signal 4 |
| Long report with content > 800 characters | Signal 5 |

**Trigger rule**: an LLM enhancement call is made only when at least 2 of the 5 signals are satisfied, precisely controlling unnecessary overhead.

---

### 1.3 Enhancement Execution Chain

```text
MB raw response
     |
shouldEnhance() --- false ---> Return original content directly
     | true
     v
buildVisualEnhancerSystemPrompt()   // Inject format rules
buildVisualEnhancerUserPrompt()     // Wrap original content
     |
llm_chat_stream (streaming call)     // Use sessionId to filter multiplexed events
     |
Streaming collection Promise with internal 120s timeout
     |
Enhanced-result length check (>= 60% of original)
     |                              // Prevent LLM from emitting an empty summary-like result
     |
Return VisualEnhanceResult { content, enhanced: true }
```

**Why streaming is used**: non-streaming interfaces from providers such as Volcengine may time out on large payloads. All LLM calls in the system (MB/SA/Chat modes) use streaming consistently, and Visual Enhancer follows the same convention.

---

### 1.4 Prompt Architecture (`VisualEnhancerPrompt.ts`)

The Prompt is kept compact at about 2000 tokens and contains complete rules and examples for 3 output formats:

#### ECharts Charts (Highest Priority)

- Supports: `bar` / `line` / `pie` / `scatter` / `radar` / `gauge` / `funnel` / `heatmap`
- Strict JSON-only output. **Functions and callbacks are forbidden** to satisfy sandbox safety requirements.
- Tooltip, grid, and color palettes are already built into the system. The Prompt only asks for core chart configuration.

#### Mermaid Flowcharts

Suitable for process steps, hierarchical relationships, and sequence displays. Uses standard `` ```mermaid `` code blocks directly.

#### Widget Interactive Components (Three Subtypes)

| Type | Language tag | Suitable scenarios |
|------|---------|---------|
| Choice cards | `widget-choices` | Direction selection; supports single select (submit immediately) and multi-select (confirm button). |
| Information chart | `widget-chart` | Multi-dimensional information summaries; `type: flow/bar/info`. |
| Decision tree | `widget-tree` | Multi-level path exploration with breadcrumbs and fade-out animation. |

**Enhancement strategy mapping**:

- Data comparison / statistics -> ECharts
- Process / steps / relationships -> Mermaid
- Optional directions / suggestions -> `widget-choices` or `widget-tree`
- Trends / time series -> ECharts line chart
- Multi-dimensional information points -> `widget-chart` (`info`)

---

### 1.5 Render-Layer Visual Theme System

The Visual Enhancer pipeline is divided into two layers: the **Prompt layer** (section 1.4), which drives the LLM to output chart code, and the **render layer**, which post-processes and polishes the LLM output in TypeScript. The two layers follow this risk-isolation principle:

| Layer | Risk level | Description |
|---|---|---|
| Prompt layer | High risk | LLM output is uncontrollable; complex configuration may cause render failures. |
| Render layer (TypeScript Recipe) | Low risk | Pure code control after JSON parsing and injection; if rendering fails, the system falls back to the unenhanced theme configuration. |

**Core design decision**: all visual-polishing logic is encapsulated in the render layer. The Prompt does not guide the LLM to generate complex style configuration, avoiding a higher render-failure rate.

#### ECharts Visual Theme (`EchartsVisualTheme.ts`)

Pipeline position: `buildSafeEChartsOption()` runs after JSON parsing -> `stripRiskyFields` -> `normalizeTitle` -> `normalizeSeries`.

**Five preset themes** (`VISUAL_PRESETS`): `__visualPreset` is read first. If it is not specified, the default preset is selected according to dark/light mode. `option.color` emitted by the LLM is preserved, but it is not used for automatic preset selection. Each preset contains a complete palette, gradient pairs, shadow colors, and related values. `areaOpacity` and `radarAreaOpacity` are optimized separately for dark and light modes.

**Type-specific Recipes**:

| Chart type | Recipe content |
|---|---|
| `bar` | Rounded bars + vertical gradients + staggered entrance animation for multiple series (120ms/series) + hover shadow |
| `line` | Smooth curve + same-hue transparent area gradient + staggered entrance + hover glow (same-color `shadowBlur`) |
| `pie` | Donut slices + **transparent outline** (adapts to bubble backgrounds) + hover floating scale shadow |
| `gauge` | Slim glowing pointer + arc progress bar (14px width + same-color glow) + separated value/label layout |
| `scatter` | Semi-transparent points + hover full opacity + shadow |
| `radar` | Filled area + dark/light mode opacity adaptation |
| `funnel` | Inter-layer spacing + border color |
| `heatmap` | Unified visual defaults for `label` and `emphasis` in dark/light modes |

**Global animation injection** (`applyAnimationDefaults`): injects `cubicOut` easing at 900ms, replacing the default linear animation.

**Glass-like Tooltip feel**: consistently injects `border-radius: 8px` plus multi-layer `box-shadow`.

**Gradient white-edge fix** (`colorToTransparent`): the end point of area-chart gradients uses a same-hue transparent `rgba` color, eliminating white halos caused by GPU blending on dark backgrounds.

#### Mermaid Visual Theme (`MermaidVisualTheme.ts`)

**Dual palettes** (`DARK_PALETTE` / `LIGHT_PALETTE`): inject Mermaid `themeVariables` into the `base` theme, overriding 40+ variables such as node fills, borders, text, and connectors.

**Mindmap-specific 12-color scale** (`buildMindmapColorScale`): directly injects `cScale0~11`, bypassing Mermaid's automatic derivation from `primaryColor`, which can make dark-mode mindmaps turn fully black. Dark mode uses medium-brightness saturated colors (HSL L 35~50%), while light mode uses high-brightness soft colors.

**SVG post-processing injection** (`injectMermaidSvgStyles`): injects a `<style>` block before `</svg>`:

| CSS rule | Effect |
|---|---|
| `.node rect / .cluster rect / .actor rect` | Rounded corners of 6-8px |
| `.edgePath path` and related rules | `stroke-linecap/join: round`, smoothing connector endpoints |
| Mindmap `.edge path` | Thickens to 2.2px + 0.6 opacity, reducing visual dominance of connectors |

**Text contrast guarantee** (`applyMermaidSvgTextContrast` / `applyMermaidDomTextContrast`): after rendering, traverses all `g.node` elements and automatically switches text to dark or light based on the relative luminance of the node fill color, ensuring WCAG readability.

---

### 1.6 Degradation Guarantees

| Scenario | Behavior |
|------|------|
| `shouldEnhance` returns false | Return original content with `enhanced: false`. |
| Planning task is cancelled | Skip enhancement and directly keep the result before cancellation. |
| LLM call throws an exception | Catch it with `catch` and return original content. |
| 120s streaming collection timeout | Fall back on timeout and return original content. |
| Enhanced result is too short (< 60% of original) | Validation fails and original content is returned. |

---

## 2. Vite Live Preview

### 2.1 Feature Positioning

`VitePreviewService` (`services/preview/`) allows multi-file frontend projects generated by Agents (React/Vue/Vanilla) to **start a Vite Dev Server directly inside the app** and embed it in an iframe for live preview, without requiring the user to manually operate a command line.

**Supported templates**: `vanilla` / `react-tailwind` / `vue-tailwind`

**Trigger entries**: Vite project preview can be triggered from single-file or multi-file code blocks in chat bubbles, project directories or `package.json` entries in the file list, and the file preview panel.

---

### 2.2 State Machine

```text
idle -> installing -> starting -> running
           |
           v
         error
```

Each `startProject` increments `startGeneration`. After each async phase finishes, `assertNotPreempted()` checks whether the current request has been preempted by a newer request, preventing orphan processes.

---

### 2.3 Complete Startup Flow

```text
startProject(deliverableDir, projectName, templateId, files, packageJson?)
     |
1. checkNodeEnvironment()              // Check Node.js >= 18
     |
2. templateManager.ensureTemplateReady()
     |  First run: npm install -> cache node_modules
     |  Existing cache: detect dependency drift and reinstall when dependency versions change
     |
3. initProjectDirectory()              // Create project structure
     |  +-- Parse projectPackageJson and extract extra dependencies
     |  +-- No extra dependencies -> mklink /J creates junction to template cache (zero cost)
     |  +-- Has extra dependencies -> merge package.json + npm install (independent install)
     |  +-- Write config files (automatically skip same-name files already provided by Agent)
     |  +-- Smart entry detection: auto-generate adapted index.html when Agent provides main.tsx
     |  +-- Write Agent source files (CSS automatically downgraded from Tailwind v4 to v3 syntax)
     |  +-- Link static asset directories (public/, src/assets/ use junctions to avoid copying binaries)
     |
4. portAllocator.allocate()            // Use fetch to probe free ports in range 3100-3199
     |
5. shell_execute(npx vite --port {port} --strictPort --host 127.0.0.1, background=true)
     |                                 // Loopback only, safe isolation
     |
6. waitForViteReady()                  // Poll HEAD requests, 500ms interval, 30s timeout
     |
7. syncToStore -> previewStore.setProjectUrl()
     |
     +-- Return http://localhost:{port} -> LivePreviewPanel iframe src
```

---

### 2.4 Key Design Decisions

#### Windows Junction (No Administrator Permission Required)

Template `node_modules` is linked to a shared cache through a directory junction created with `mklink /J`. Each preview project reuses the same dependency set, with **zero extra disk space and installation time**. When switching templates, the junction is automatically rebuilt to point to the correct target.

#### Independent Installation for Extra Dependencies

If the Agent's `package.json` contains libraries not built into the template (such as `d3` or `three.js`), the system automatically merges dependencies and runs an independent `npm install`. Cleanup logic distinguishes old junctions from old real directories by using `rmdir` for junctions only and `rmdir /S /Q` for real directories.

#### Automatic CSS Downgrade from Tailwind v4 to v3

The LLM may generate Tailwind v4 syntax (`@import "tailwindcss"`, `@theme {}`), but the template environment is fixed on v3. Before writing CSS files, the system automatically performs three replacements:

```text
@import "tailwindcss"      ->  @tailwind base; @tailwind components; @tailwind utilities;
@import "tailwindcss/..."  ->  Remove (unsupported by v3)
@theme { ... }             ->  :root { ... }
```

#### Orphan Process Cleanup

When Vite project preview is started for the first time, lazy initialization registers a window-close cleanup hook and scans ports `3100-3110` for Vite processes that may have been left by a previous abnormal exit. When the window closes, `beforeunload` plus a Tauri cleanup hook executes `shell_kill`.

---

### 2.5 Port Management (`PortAllocator`)

Uses `fetch` probing rather than `bind` attempts. The range is 3100-3199. A `Set` tracks allocated ports, and `release()` returns the port after process termination, avoiding port leaks.

---

## 3. Scheduled Task System (Cron)

### 3.1 Feature Positioning

The Agent scheduled task system allows users to configure an **automatically triggered task Prompt** for any Agent. At the specified time, the Agent autonomously executes it in Planning mode. Execution results are persisted to that Agent's chat history so users can review them at any time.

---

### 3.2 Overall Architecture

```text
CronSettingsTab (UI)
     |  Create / modify / delete / enable
     v
Rust SQLite (cron_repo.rs)    <- cron CRUD IPC commands
     |  cron_list_all_enabled
     v
CronScheduler                  // Singleton, initialized at app startup
  +-- Poll checkAndExecute() every 60s
  +-- matchesCronExpression(job.cronExpression, now)
  +-- executingJobs Set (prevents re-entry)
     | Hit
     v
CronExecutor.executeCronJob()
  +-- Mark running
  +-- emit('cron:execute_planning', payload)
  +-- AgentChatView <- usePlanningMode takes over Planning execution
```

---

### 3.3 Cron Expression Parsing (`cronExpression.ts`)

The parser fully implements the standard five-field format (`minute hour day month weekday`) and supports:

| Syntax | Example | Description |
|------|------|------|
| Wildcard | `*` | Matches all values. |
| Single value | `9` | Exact value. |
| List | `1,3,5` | Multiple-value OR. |
| Range | `1-5` | Continuous interval. |
| Step | `*/2`, `1-10/3` | Fixed interval. |

**Smart jump optimization**: when `getNextRunTime()` calculates the next trigger time, it directly jumps months when the month does not match, days when the date does not match, and hours when the hour does not match. The maximum iteration count is 366 x 24 x 60, covering a full year.

#### Friendly UI <-> Cron Bidirectional Mapping

`ScheduleConfig` UI configuration is converted bidirectionally with Cron expressions. Supported frequency types:

```text
every_n_minutes  ->  */N * * * *
hourly           ->  M * * * *
daily            ->  M H * * *
weekly           ->  M H * * W
monthly          ->  M H D * *
specific         ->  M H D Mo *  (one-time task, autoDisable: true, automatically disabled after execution)
```

---

### 3.4 Scheduler Core (`CronScheduler`)

```typescript
// Poll every 60s. After a match, execute asynchronously and concurrently
// without blocking checks for other jobs.
for (const job of state.enabledJobs) {
    if (state.executingJobs.has(job.id)) continue;  // Prevent re-entry
    if (!matchesCronExpression(job.cronExpression, now)) continue;
    state.executingJobs.add(job.id);
    executeAndCleanup(job);  // Async, no await
}
```

After `executeAndCleanup` finishes, whether it succeeds or fails, it runs `executingJobs.delete(job.id)` in the `finally` block to ensure the job can be triggered normally next time.

---

### 3.5 Execution Engine (`CronExecutor`)

Scheduled tasks uniformly run in **Planning mode** (Full Agent Loop):

```text
setModeFor(agentId, 'planning')          // chatStore switches mode
Switch Hub if needed and wait for target Agent to load
setCurrentAgentId(agentId)               // Switch current Agent
await sleep(800ms)                       // Wait for React re-render to avoid old listeners dropping the event
emit('cron:execute_planning', payload)   // AgentChatView's usePlanningMode takes over
```

**Key race-condition handling**: the 800ms delay waits for React to re-mount listeners, preventing a listener for the old `agentId` from ignoring the new event.

**Execution-state semantics**: `CronExecutor` marks the job as `running`, then triggers `cron:execute_planning`. Once the event is sent successfully, the CronJob status is updated to `success`. The actual Agent Loop execution result is written to chat history by `AgentChatView` / `usePlanningMode`; the current CronJob `success/failed` status is closer to "whether Planning execution was successfully triggered" and is not equivalent to the Agent's final task result.

---

### 3.6 UI Configuration Screen

- `CronSettingsTab`: frequency-driven UI (frequency dropdown + time picker) that hides Cron-expression complexity; advanced mode allows direct input of raw expressions.
- `CronJobItem`: task card showing the last execution status (`running/success/failed`), next execution time, and enable switch.
- `AgentNavItem` badge: global Cron index; shows the scheduled-task badge when enabled jobs exist.

---

## 4. IM Channels (Feishu / Slack, Multiple Bots)

### 4.1 Feature Positioning

The IM channel system allows users to send tasks to a specific Agent through Feishu or Slack, then view the thinking chain, Sub-Agent progress, and execution result in message cards on the corresponding platform. The current architecture centers on `BotConfig`: each Bot is bound to one Hub/Agent, multiple Bots can be configured for the same platform, and each platform supports up to 10 Bots.

---

### 4.2 Architecture Layers

```text
Feishu / Slack client
     |  Send a message by mentioning the bot or using a DM
     v
Platform long connection
  +-- FeishuChannel (WSClient + EventDispatcher)
  +-- SlackChannel (Socket Mode WebSocket)
     |
ImChannelFactory                  // botId -> Channel instance, multiple Bots coexist
     |
ImTaskBridge.handleIncomingMessage(botId, message)
  +-- Idempotent deduplication (processedMessageIds Set)
  +-- Stop-command detection (`/stop`, `stop`, `停止`, `终止`, `取消`)
  +-- Busy interception (reject new messages for this Bot when activeTasks[botId] is non-empty)
  +-- Parse BotConfig and locate target Hub / Agent
  +-- Attachment download -> im_save_attachment -> buildEnhancedPrompt()
  +-- ImProgressTracker.sendPendingCard()
  +-- triggerPlanningExecution()
     +-- setModeFor(agentId, 'planning')
     +-- Switch Hub if needed and wait for Agent list to load
     +-- setCurrentAgentId(agentId)
     +-- await sleep(800ms)
     +-- emit('cron:execute_planning', { source: 'im', botId, imPlatform })
        |
AgentChatView <- usePlanningMode -> Agent Loop
     |  onStateChange/onThinkingPhase/onSubAgentObservation...
     v
ImProgressTracker (tracks each Bot independently and batches card updates with 2s throttling)
     |
Platform card update API (Feishu through Rust proxy to bypass CORS; Slack through Rust HTTP proxy)
```

---

### 4.3 Factory Pattern (`ImChannelFactory`)

`ImChannelFactory` uses platform registration plus a botId instance table. Platform adapters are still registered through `registerPlatform()`, but active connections are no longer "one per platform"; they are "one Channel instance per Bot."

```typescript
// Register platforms (called during module loading)
registerPlatform('feishu', (config) => new FeishuChannel(config));
registerPlatform('slack', (config) => new SlackChannel(config));

// Create or reuse the connection instance for one Bot
const channel = createChannelForBot(botId, {
    platform: 'feishu',
    appId,
    appSecret,
});

initializeImTaskBridge(botId, channel);
```

To add a new platform, implement the `ImChannel` interface and call `registerPlatform()`; the task bridge does not need to change. The old `createChannel()` / `getChannel()` / `destroyChannel()` APIs are kept for compatibility. New code should prefer the botId-based versions.

---

### 4.4 Platform Connection Implementations

#### Feishu (`FeishuChannel`)

The user creates an enterprise self-built app in the Feishu Open Platform, obtains `App ID + App Secret`, enables bot capabilities, and subscribes to `im.message.receive_v1` and `card.action.trigger` events. WebSocket mode does not require a public Webhook.

When the Feishu SDK accesses `open.feishu.cn` inside the Tauri WebView, it encounters CORS restrictions. Therefore, before the SDK loads, the system injects a global `ProxiedXHR`, forwarding Feishu-domain requests to the Rust backend command `feishu_http_proxy`. Non-Feishu requests still go to the real XHR.

`tenant_access_token` is valid for 2 hours. The system checks and refreshes it 5 minutes early, using the Rust backend proxy for requests and caching the token in memory. Legacy message filtering uses `connectInitiatedAt` to avoid misclassifying new messages during WebSocket connection setup as historical messages.

#### Slack (`SlackChannel`)

The Slack channel uses `botToken` (`xoxb-*`) and `appToken` (`xapp-*`, requiring `connections:write`) to establish a Socket Mode WebSocket. Message sending, card updates, file downloads, and other HTTP APIs run through Rust Slack proxy commands. Group chats require mentioning the Bot, while DMs can trigger tasks directly.

#### Supported Messages and Attachments

- `text`: text messages; group chats must mention the Bot.
- `image` / `file`: parsed into `ImIncomingAttachment`.
- Feishu attachments are downloaded through `feishu_download_resource`; Slack files are downloaded through private URLs. They are finally written into the Agent work directory by `im_save_attachment`, and the local paths are appended to the Prompt.

---

### 4.5 Real-Time Progress Cards (`ImProgressTracker`)

**Throttling mechanism**: the tracker uses a 2s throttle. All events accumulate in a buffer and are batch-merged into one push, avoiding excessive platform card update frequency.

**Tracked event types**:

| Event | Card content |
|------|--------|
| FSM state changes | Current status label |
| `onThinkingPhase` | Thinking-chain steps (keeps the latest 8 steps) |
| `onSubAgentSpawn` | Sub-Agent role description |
| `onSubAgentObservation` | Tool-call step list (latest 10 steps) |
| `handleBudgetUpdate` | Iteration progress (used / total) |

**Card state flow**:

```text
pending card (preparing...)
     | Updated every 2s with throttling
     v
progress card (real-time progress + thinking chain + Sub-Agent steps)
     | Task completed / failed
     v
completion card (result summary + elapsed time + iteration count)
/ error card (error reason + retry guidance)
```

---

### 4.6 Task Control

#### Stop Commands

When the user sends `/stop`, `stop`, `停止`, `终止`, or `取消` in IM, `ImTaskBridge` interrupts only the current task for that Bot:

1. Emits the `im:abort_task` Tauri event, carrying `taskId` and `botId`; after `usePlanningMode` receives it, it aborts the Agent Loop.
2. Updates the current platform card to the error state.
3. Clears `activeTasks[botId]` and the corresponding tracker, allowing the Bot to accept new messages again.

#### Card Button Actions

Platform card button actions enter `ImTaskBridge` uniformly:

- `abort_task`: terminate the current Bot task.
- `delete_message`: delete the card message.
- `delete_file`: delete the Slack file.

#### Task-State Persistence

Active task metadata (`taskId`, `chatId`, `platform`, `botId`) is written to `AppData/im_active_task_{botId}.json`, and the latest session is written to `AppData/im_last_chat_{botId}.json`. The native `im_send` tool first prefers the Bot's default outbound target, then falls back to the current or most recent session to send follow-up messages.

---

## Summary

| Feature | Core mechanism | Key design highlights |
|------|---------|------------|
| **Visual Enhancer** | Heuristic scoring + LLM post-processing + render-layer Recipe | 5-signal scoring / end-to-end degradation guarantees / low-risk TS visual injection / dark-light mode adaptation |
| **Vite Live Preview** | Junction + Dev Server management | Zero-cost dependency sharing / automatic CSS downgrade / race protection / lazy orphan-process cleanup |
| **Scheduled Tasks** | Cron polling + Planning event trigger chain | Bidirectional UI mapping / re-entry prevention / one-time task auto-disable / cross-Hub Agent switching |
| **IM Channels** | Multi-Bot Channel factory + platform long connections + throttled push | Feishu/Slack adapters / Bot-level task isolation / unified attachment persistence / 2s throttled card updates |
