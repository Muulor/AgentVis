# AgentVis Four Core Features Deep-Dive Technical Analysis

> Naming note: “Task mode” in the UI maps to the internal mode value `planning`; existing identifiers such as `usePlanningMode`, `services/planning`, and `cron:execute_planning` remain unchanged.

---

## 1. Interactive Visualization Enhancement (Visual Enhancer)

### 1.1 Feature Positioning

`VisualEnhancerService` is a **post-processing enhancement layer** for Task mode. After the Master Brain produces a plain-text response, this service decides whether the content is suitable for visualization. If it is, the service drives the LLM to convert the response into a rich-media version containing ECharts charts, Mermaid flowcharts, and Widget interactive components.

**Design principle**: show the raw MB response first; if enhancement fails, degrade silently and never affect the main response output path.

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
Update the checkpoint into a finalized original-response message immediately
     |
End foreground streaming, collapse the FSM into the static Processed trace, and unlock input
     |
shouldEnhance() --- false ---> Keep the original response as the final message
     | true
     v
Enqueue a message-scoped background enhancement job (serialized per context)
     |
buildVisualEnhancerSystemPrompt()   // Inject format rules
buildVisualEnhancerUserPrompt()     // Wrap original content
     |
llm_chat_stream (streaming call)     // Use sessionId to filter multiplexed events
     |
Collect the stream in the background while the UI keeps the original response stable
     |
Enhanced-result length check (>= 60% of original)
     |                              // Prevent LLM from emitting an empty summary-like result
     |
Use the enhanced result as the final message and retain the Enhanced / Original switch
```

**Why streaming is used**: non-streaming interfaces from providers such as Volcengine may time out on large payloads. All LLM calls in the system (MB/SA/Chat modes) use streaming consistently, and Visual Enhancer follows the same convention. VE deltas are collected only in the background, so incomplete Markdown, Mermaid, or ECharts output no longer overwrites the readable MB response.

**UI display strategy**: after the MB response is persisted, the dynamic FSM panel ends immediately and becomes the default-collapsed static Processed PlanningTrace, while the input is unlocked. Enhancement continues in the background. The message footer shows a queued/running visual status and a message-scoped Stop enhancement button. After validation succeeds, the same message is updated in place, defaults to the enhanced version, and replaces that footer with the persistent Original / Enhanced switch. The original version reuses the existing `metadata.persistContent`; no new cross-session or memory-persistence field is introduced.

**Stop and concurrency semantics**: the message-level Stop enhancement action cancels only that message's VE job; the composer stop action cancels only the current foreground AgentLoop. The two actions are independent. Each Agent/Hub runs at most one VE job while later jobs queue; different contexts may run concurrently. Deleting or revoking a message, or deleting its context, cancels the associated enhancement job.

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

**Content deduplication constraint**: each fact, metric, or dataset must have one primary presentation. Labels and values already represented by a visualization must not be repeated in adjacent tables, lists, or prose. If a visualization covers only part of a source table, only the non-overlapping rows and complementary details are retained.

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
| `shouldEnhance` returns false | Keep the already visible original response as the final message with `enhanced: false`. |
| Task mode execution is cancelled | Skip enhancement and directly keep the result before cancellation. |
| User selects Stop enhancement | Cancel only that message's background VE job and keep the persisted original. |
| LLM call throws an exception | Catch it with `catch` and return original content. |
| 120s streaming collection timeout | Fall back on timeout and return original content. |
| Enhanced result is too short (< 60% of original) | Validation fails and original content is returned. |

---

## 2. Project Preview (Vite / Import Map)

### 2.1 Feature Positioning

`VitePreviewService` (`services/preview/`) previews multi-file frontend projects generated by Agents (React/Vue/Vanilla) inside the application. It treats Agent input as untrusted data: source files first enter an isolated staging workspace under the application cache, then an AgentVis wrapper starts Vite or a static server. Project Preview does not create `vite_preview`, `node_modules`, or runtime configuration inside the Agent deliverable directory. Complete projects retain their entry graph, package type, declared dependency versions, and supported Vite/PostCSS/Tailwind/TypeScript configuration; chat snippets continue to use the AgentVis template scaffold and static configuration extraction, without mixing entry files between the two paths.

**Supported templates**: `vanilla` / `react-tailwind` / `vue-tailwind`

**Runtime routing**: projects with an explicit `package.json`, and ordinary module projects, use the trusted Vite route. A Vanilla project with no package manifest and an Import Map in its effective root entry (`index.html` or the only root HTML file) uses the static route only when every Import Map is valid, top-level `imports`/`scopes` cover every bare import, and the modules need no TS/JSX/Vue/CSS transform. An incompatible static candidate returns an explicit compile error instead of silently falling back to Vite.

**Trigger entries**: Project Preview can be triggered from single-file or multi-file code blocks in chat bubbles, project directories or `package.json` entries in the file list, and the file preview panel.

---

### 2.2 State and Lifecycle

```text
idle -> installing -> starting -> running
           |             |
           +-----------> error
```

Each `startProject` creates a new generation. Startup, installation, health checks, and process monitoring verify that generation inside one serialized lifecycle. The UI also assigns a monotonically increasing request ID to each visible preview; service state, deferred stop, and retry operations must match that ID, so an old request cannot overwrite a new panel or replay the previous Agent's project. Retry becomes available only after the request is submitted to the Preview service, so a source-tree scan or other pre-service error directs the user back to the original trigger. A newer request first cancels the previous dependency installation and terminates its owned PID, then removes the old staging workspace. Cancellation is checked again after source/package writes, while npm, Node checks, and dependency-link commands register their execution IDs before launch so a cancelled run cannot start a long-lived command afterward. Template preparation uses renderer-local single-flight owner/joiner semantics plus an OS-backed Rust exclusive lease for each shared template directory; another AgentVis process waits for the owner and rechecks the cache after acquiring that lease. The completion marker stores the same controlled `package.json` content as the committed installation, and an update removes the marker before any manifest write, so a crash cannot misclassify a new manifest, old `node_modules`, and stale marker as one completed version. Only the run that actually starts `npm install` registers and cancels its execution; a Preview that joins Shell warmup or another shared install never cancels that shared owner. If the owner fails, an active joiner retries once and competes for ownership again. Window close invalidates the UI request ID synchronously before its first await and then waits for the same service cleanup; a failed native `destroy` releases the close guard so a later close can retry. Retry clones the current request and creates a fresh runtime instead of reusing failed state.

The iframe has an additional presentation state. It shows startup-stage information, while a trusted diagnostics bridge emits `booting`, `ready`, `runtime-error`, `unhandled-rejection`, and `resource-error`. The host validates both `event.source` and the preview origin, so messages forged by other windows are ignored. Entering `running` with a managed URL or manually refreshing starts an eight-second “diagnostics bridge connected” deadline. Any trusted bridge message, including the early `booting` signal, proves connectivity and ends that deadline, so a slow `window.load` waiting on textures, fonts, or other resources no longer produces a false Retry warning. The bridge replays its current lifecycle at `DOMContentLoaded` and emits `ready` after full `load`; a late lifecycle signal clears only a stale handshake warning and never hides a real runtime error. No ping for the future Preview origin is sent while the iframe still has the host's inherited `about:blank` origin; after navigation commits, the exact-origin boundary remains in force. Before a trusted ping arrives, only content-free lifecycle signals may support the handshake; runtime/resource/rejection text is cached and replayed only to the exact allow-listed host origin after that ping, rather than being exposed through `*`. If no trusted signal ever arrives, timeout still reveals the page with an actionable diagnostic instead of leaving an infinite spinner.

The host renderer itself uses two error-isolation layers. A failed lazy Mermaid/ECharts module degrades only that diagram and remains retryable. Any other uncaught React error is contained by an entry-level boundary that preserves Reload, Close App, and diagnostic details. Window-close confirmation uses Tauri's standard `onCloseRequested` listener, so if the renderer root unmounts and removes that listener, native default closing becomes available again instead of leaving an unclosable black window. Before a Windows debug executable starts, it also performs a bounded probe of `127.0.0.1:1420`; if the development server is absent, a bilingual explanation is shown and the process exits safely instead of relying on a cached, incomplete WebView page.

---

### 2.3 Complete Startup Flow

```text
startProject(deliverableDir, projectName, templateId, files, packageJson?)
     |
1. Input preflight
     |-- Normalize ProjectFile paths; reject absolute paths, drives, URLs, NUL, and every `..`
     |-- Enforce source count/size budgets; ignore reserved paths and Agent build configs
     |-- Bound package.json UTF-8 bytes, dependency count, package names, and version-specifier lengths
     |-- Collect bare packages from static imports, re-exports, and literal dynamic imports
     |-- Resolve the effective entry first; diagnose multiple root HTML files, nested projects, missing entries, and known non-Vite contracts separately
     |
2. Select mode
     |-- Vanilla + effective-root Import Map + no package.json -> validate imports/scopes, mappings, and native-JS-only rules
     |-- Reject malformed maps, unmapped bare imports, .jsx/.ts/.tsx/.vue sources, or module CSS/transform imports
     |-- On success -> static server
     `-- Everything else -> trusted Vite runtime
     |
3. Environment and staging
     |-- Check Node.js >= 18
     |-- Let Rust create a fresh {appCacheDir}/project-preview/project-preview-{UUIDv4}/ workspace
     |-- Return workspace, runId, and ownerToken; write an exact .agentvis/active marker and hold a cross-instance file lease
     `-- Copy only allow-listed static assets; skip symlinks and reparse points
     |
4. Prepare dependencies (Vite route only)
     |-- Parse constrained npm names and registry versions/ranges; reject file/link/workspace/git/http/npm aliases
     |-- package.json <= 256 KiB; dependencies + devDependencies <= 128; name <= 214 chars; specifier <= 256 chars
     |-- Every bare import must be supplied by the template or declared in package.json before iframe startup
     |-- A native cross-process lease serializes the shared template; its marker must match controlled package.json content
     |-- Complete-project versions and package type override template defaults; the template only fills missing packages
     |-- Template and project dependency installs use npm --ignore-scripts --no-audit --no-fund
     `-- Only snippets/projects with no declared project dependencies junction staging/node_modules to the controlled template cache
     |
5. Materialize the project
     |-- A complete project writes only its own entry graph; complete index.html from a recognized main entry or the only root HTML file, using the same entry analysis as mode selection
     |-- A snippet may borrow template entries, but an Agent file with the same stem wins so App.jsx cannot shadow App.tsx
     |-- Complete projects retain Vite/PostCSS/Tailwind/tsconfig/jsconfig; unrelated ESLint/Webpack/Rollup/Esbuild root config remains filtered
     |-- Only snippet mode normalizes Tailwind v4 CSS to the v3 fallback and statically extracts a budgeted literal theme
     `-- Generate .agentvis/vite.config.mjs or .agentvis/static-server.mjs
     |
6. Start and verify
     |-- Allocate a loopback port in 3100-3199; start as backgroundManaged and retain the exact PID
     |-- Poll /.agentvis/health and validate the per-run random token
     |-- GET root HTML and its browser module entries to catch entry 4xx/5xx before display; iframe diagnostics continue for lazy/deep modules
     `-- Update previewStore and begin PID status monitoring
```

---

### 2.4 Trust Boundaries and Resource Budgets

#### Controlled Runtime

The Vite command line explicitly loads only the AgentVis-generated `.agentvis/vite.config.mjs`. For a complete project, that wrapper loads the project's root Vite configuration from staging; preserves plugins, aliases, in-staging root/env/public paths, and CSS toolchain semantics; then overrides host/port, CORS, `server.fs.strict`, cache location, diagnostics, and health boundaries. PostCSS and Tailwind configuration is likewise resolved only from staging. Snippets never load project build configuration and continue to use the AgentVis template configuration.

A complete project's Vite/PostCSS/Tailwind configuration is executable Node code. App-cache staging protects the original deliverable directory and constrains Vite's served filesystem, but the `preview=inherit`/Local Audit process is not an OS-level VM and cannot stop configuration code from actively accessing other local files or the network with the current user's authority. Complete-project Preview should therefore be used only for projects created by the user or a trusted Agent; this compatibility route is not strong isolation for arbitrary untrusted build configuration. Remote Import Map/page resources also follow normal browser networking semantics.

#### Bounded Input

| Type             | Budget                                                                                                                        | Behavior when exceeded                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Source files     | At most 500 files; 4 MiB each; 32 MiB total                                                                                   | Return a structured Preview error before startup                                    |
| `package.json`   | At most 256 KiB UTF-8; 128 combined dependencies/devDependencies; 214-character package name; 256-character version specifier | Return `invalid-package` before npm executes                                        |
| Static assets    | At most 1,000 files; 64 MiB each; 256 MiB total                                                                               | Stop copying and reclaim this run's staging workspace                               |
| Directory scan   | Maximum depth 24; at most 10,000 scanned entries                                                                              | Stop scanning and never follow links                                                |
| Staging deletion | At most 100,000 entries, 128 levels, and 2 seconds per no-follow pass; 5 seconds per stale sweep                              | Keep the receipted quarantine and continue from its remaining tree in a later sweep |

Native `preview_list_source_tree`, `preview_read_text_file`, and `preview_copy_assets` perform source enumeration, text reads, and asset copies. Rust counts directory entries while iterating instead of first materializing an unbounded renderer list; each listed physical `sourcePath` is bound one-to-one to its staging `path`, so a target prefix such as `src/` never changes the source read location. Enumeration counts `.env` / `.env.*` names without reading their contents; if startup later fails, the UI preserves the primary error and adds a notice that environment files were omitted from isolated Preview. Each file is `fstat`-checked and read or copied through the same validated handle, whose final resolved path must remain under the deliverables root. Source/text reads still refuse multiply hard-linked files. A Windows static asset is copied read-only only when native enumeration and identity checks prove that every NTFS hard-link name refers to the same file object inside the same Agent workspace; a cross-workspace/out-of-deliverables link, changed set, or enumeration failure closes the operation, and other platforms continue to reject multiply linked assets. On Unix, asset destinations are created relative to held workspace/parent directory descriptors with `mkdirat`/`openat`; on Windows, no-follow parent handles that do not share delete access pin the path chain. `destinationPrefix` is subject to the same root-relative validation. Asset copying permits explicit non-configuration extensions for images, fonts, audio/video, 3D models, JSON/CSV, WASM, and similar data. It skips hidden files/directories, `Agent-Log`, build output, package caches, lockfiles, `package.json`, `tsconfig.json`, `jsconfig.json`, symlinks, and Windows reparse points.

#### Staging Ownership and Native Reclamation

Rust native commands own Preview workspace creation and deletion. `preview_create_workspace` creates only a direct child named `project-preview-{UUIDv4}` under the real app-cache `project-preview` root, returns its `workspace`, `runId`, and random `ownerToken`, and writes `.agentvis/active` with that exact identity pair and an activity timestamp. An active run refreshes the marker no more than every 60 seconds. The native layer also holds a cross-instance file lease, so another AgentVis instance cannot treat an in-use workspace as reclaimable.

Normal reclamation must pass the expected `runId` and `ownerToken` to `preview_cleanup_workspace`. Beyond matching the marker/token, Rust must prove that this process's registry currently holds the lease for that `ownerToken`, then release it before cleanup; knowing another instance's marker/token is not enough to initiate normal reclamation. Rust then revalidates the app-cache root, direct-child relationship, UUIDv4 name, symlink/reparse state, and canonical containment, failing closed if any condition is false. After validation, it atomically renames the workspace to a quarantined trash name under the controlled cache root, then deletes it with an explicit-stack no-follow walker. On Windows, a just-terminated Node/Vite watcher may briefly retain its cwd or file handles. Native cleanup applies about 1.6 seconds of bounded backoff only to access-denied, sharing-violation, and lock-violation errors (codes 5/32/33), revalidating the workspace, owner, and receipt before every retry. Exhaustion still removes the temporary receipt, restores the local lease, and fails closed. The walker consumes no recursive call stack and bounds entries, depth, and execution time per pass. If a limit or mid-pass error occurs, a potentially partial tree is not renamed back; its root receipt and quarantine remain available for a later stale sweep. A `node_modules` junction or any other symlink/reparse point has only the link itself removed.

Native `preview_cleanup_stale_workspaces` also handles stale workspaces in bounded pages instead of letting the frontend infer safety from mtime and recursively delete them. A candidate must be inactive for at least 24 hours, pass the same identity/path checks, and yield its file lease before quarantine deletion. Before atomic quarantine, native code writes a root-owned `.trash-{UUIDv4}.owner.json` receipt that exactly identifies its paired `.trash-{UUIDv4}` directory. If partial deletion has already removed the workspace marker and therefore prevents a safe rename back, the receipt preserves ownership evidence. A later stale sweep performs no-follow self-reclamation only when trash and receipt have strict matching names, are real direct children of the controlled root, and the receipt is also at least 24 hours old. Each pass makes deletion progress; when its entry/time budget expires, the receipt remains and a later sweep continues from the remaining tree. If the paired trash is already absent, an orphan receipt may be deleted only when its name is strict, its fields are self-consistent, it is a real regular file, and it is likewise at least 24 hours old; mismatched, linked, or recent receipts remain untouched. The entire stale-cleanup IPC also has a five-second execution budget. The frontend cleanup backlog has capacity and per-pass retry bounds, moves failures to the tail to prevent starvation, and re-registers native stale recovery for every new cleanup failure, quarantine, or backlog overflow, so completing one sweep never permanently suppresses residue created later in the same application session.

---

### 2.5 Process Observability and Port Management

The Rust background registry asynchronously drains stdout and stderr for `background=true` processes. It retains the last 1 MiB per stream and reports how many prefix bytes were truncated. `shell_background_status(pid)` returns `running` / `exited`, the exit code, and output tails. An exited-process tombstone remains available for five minutes, allowing both startup and runtime monitors to diagnose failures.

`PortAllocator` allocates a local port in 3100-3199, but a port is only a routing resource, not proof of process ownership. The service terminates only the PID registered for the current run and uses a random health token to verify that the response on the port belongs to that runtime. It no longer scans 3100-3110 and never kills an unknown process merely because a port is occupied.

### 2.6 Failure Classification and Compatibility Boundaries

- Entry failures distinguish multiple HTML files, a missing entry, nested project directories, and known non-Vite build tools instead of hiding directory-selection problems behind a generic compile error.
- npm failures distinguish Registry authentication, network/proxy/certificate failures, and general installation errors. Lifecycle scripts remain disabled; packages requiring native setup or install-time generation should run in the project's own development environment.
- `file:` / `workspace:` / Git / URL / alias dependencies are reported as unsupported project contracts rather than missing packages.
- Link/reparse and source/asset budget errors expose the relevant safety reason and limit. Runtime diagnostics distinguish embedded-browser capability gaps such as WebGL/WebGPU, CORS/CSP failures, and remote resource failures without rewriting those environment differences as compile errors.

---

## 3. Scheduled Task System (Cron)

### 3.1 Feature Positioning

The Agent scheduled task system allows users to configure an **automatically triggered task Prompt** for any Agent. At the specified time, the Agent autonomously executes it in Task mode. Execution results are persisted to that Agent's chat history so users can review them at any time.

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
  +-- AgentChatView <- usePlanningMode takes over Task mode execution
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

Scheduled tasks uniformly run in **Task mode** (Full Agent Loop):

```text
setModeFor(agentId, 'planning')          // chatStore switches to Task mode (internal value: planning)
Switch Hub if needed and wait for target Agent to load
setCurrentAgentId(agentId)               // Switch current Agent
await sleep(800ms)                       // Wait for React re-render to avoid old listeners dropping the event
emit('cron:execute_planning', payload)   // AgentChatView's usePlanningMode takes over
```

**Key race-condition handling**: the 800ms delay waits for React to re-mount listeners, preventing a listener for the old `agentId` from ignoring the new event.

**Execution-state semantics**: `CronExecutor` marks the job as `running`, then triggers `cron:execute_planning`. Once the event is sent successfully, the CronJob status is updated to `success`. The actual Agent Loop execution result is written to chat history by `AgentChatView` / `usePlanningMode`; the current CronJob `success/failed` status is closer to "whether Task mode execution was successfully triggered" and is not equivalent to the Agent's final task result.

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
| **Project Preview** | Isolated staging + trusted Vite/static routes + PID ownership | Path/dependency allow-lists / install scripts disabled / token health check / iframe diagnostics / full-lifecycle cleanup |
| **Scheduled Tasks** | Cron polling + `cron:execute_planning` event trigger chain | Bidirectional UI mapping / re-entry prevention / one-time task auto-disable / cross-Hub Agent switching |
| **IM Channels** | Multi-Bot Channel factory + platform long connections + throttled push | Feishu/Slack adapters / Bot-level task isolation / unified attachment persistence / 2s throttled card updates |
