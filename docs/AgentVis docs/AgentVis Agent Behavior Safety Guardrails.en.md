# AgentVis Agent Behavior Safety Guardrails

---

## Overview

Agents can perform real side-effecting operations such as running Shell commands, reading and writing files, and searching the network. To prevent accidental Agent operations or malicious prompt hijacking, the system implements a **defense-in-depth** architecture distributed across five protection layers:

1. **LLM behavior soft-guardrail layer** (Prompt layer + FSM layer): guides and constrains Agent decision-making behavior.
2. **TypeScript tool interception layer**: performs fast interception and tiered handling before tool calls take effect.
3. **Rust command validation layer**: provides host-side hard blocking before command execution for the policy patterns and semantics it recognizes.
4. **Process / network sandbox and audit layer**: runtime protection that adds controllable constraints to shell / Skill execution through Job Object, Restricted Token, AppContainer, broker/proxy, and network policy.
5. **Agent Trash Bin soft-delete layer**: after the Rust layer passes but before the OS actually deletes, transparently rewrites delete operations into "move to Trash Bin" so deletion is recoverable.

Together, these layers form a complete defense chain: "soft guardrails -> fast TS feedback -> Rust hard block -> sandbox constraints and audit -> soft-delete fallback."

---

## 1. LLM Behavior Soft Guardrails

Soft guardrails do not directly block command execution. Instead, they use Prompt constraints and Agent architecture design to reduce the probability that an Agent produces dangerous behavior in the first place.

### 1.1 Master Brain Decision Constraints

**File**: `src/services/planning/brain/MasterBrainPrompt.ts`

MasterBrain is the top-level decision maker in the Agent system. Its System Prompt explicitly encodes the behavioral priority rule:

```text
Priority: safety > progress > elegance
```

MasterBrain decomposes tasks and grants Sub-Agent tool capabilities as needed. In the current implementation, `read`, `local_search`, `web_search`, `exec`, and `file_write` are SA base tools and are automatically filled into `allowedTools` by `SubAgentSpecBuilder`; `nextStep.tools` is mainly used for MB to explicitly authorize special or extension tools, such as `cron`, `generate_image`, and `external_skill_execute`. At runtime, SA still validates `allowedTools` and intercepts unauthorized or hallucinated tool calls.

**Risk assessment field**: the MB Prompt requires every decision output to include `riskAssessment`, containing a risk level (`low` / `medium` / `high`) and potential risk points. The parser still requires this field for `SPAWN_SUB_AGENT`; for non-operational decisions such as `RESPOND_TO_USER` / `REQUEST_MORE_INPUT`, it fills a default `low` when the field is missing. The main execution flow currently does not directly map MB `riskAssessment` to LoopGovernor `riskDelta`. The global `risk_exceeded` branch is kept as an extension point; in actual runtime, risk is mainly handled by tool-level policy, Checkpoint, Rust validation, and sandbox audit.

**Behavior mode constraints**: the MB Prompt includes a `behaviorHint` dispatch parameter. For sensitive tasks involving user data, privacy, and similar concerns, it forces `careful`; for coding and query-like tasks, it allows `direct`.

### 1.2 LoopGovernor Loop Controller

**File**: `src/services/planning/agent-loop/LoopGovernor.ts`

LoopGovernor is the internal "circuit breaker" for the FSM-driven Agent execution loop. It automatically terminates Agent execution under the following five abnormal patterns:

| Termination condition     | Priority    | Description                                                                                                                                                     |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consecutive_no_progress` | 1 (highest) | Two consecutive loops with no substantive progress, preventing ineffective Agent spinning                                                                       |
| `tool_thrashing_detected` | 2           | N consecutive calls to the same tool (default 3), preventing dead-loop oscillation                                                                              |
| `over_delegation`         | 3           | Sub-Agent dispatch count exceeds the budget limit (default synchronized with the MB decision budget of 8 rounds unless explicitly overridden)                   |
| `risk_exceeded`           | 4           | Accumulated risk score exceeds the threshold (default 0.8; the main flow currently does not connect MB `riskAssessment`, so this is a reserved extension point) |
| `budget_exhausted`        | 5           | MB decision round budget is exhausted (default 8 rounds; FSM stepping hard safety valve defaults to 48)                                                         |

```typescript
// Tool thrashing detection: whether the last N calls all used the same tool.
private detectToolThrashing(): boolean {
    const lastN = history.slice(-threshold);
    return lastN.every((tool) => tool === lastN[0]);
}
```

### 1.3 Dual Budget Control for Sub-Agents

Sub-Agents are constrained by two budget levels in `runAtomicEventLoop`:

- **Step budget** (`maxSteps`): the primary budget, currently defaulting to 50 steps. One step means one LLM decision / tool execution round, and parallel tool calls count as only one step.
- **Hard tool-call limit** (`TOOL_CALLS_HARD_LIMIT`): a global cap, currently defaulting to 200, preventing a single step from bypassing the step budget by launching many parallel tool calls.

When budget usage reaches 85%, a warning instruction is injected. When it reaches 95%, a final forced-stop instruction is injected. Near exhaustion (by default, remaining steps <= 5 and usage >= 85%) also triggers a budget Checkpoint; MB may add up to 20 steps in one extension, with at most 2 extensions for a single SA.

```text
[STOP] This is your final action step. Immediately summarize completed work or hand off, and output TASK_COMPLETE. Do not start new operations.
```

### 1.4 Human-in-the-Loop (HITL) Intervention

**File**: `src/stores/hitlStore.ts`

Users can click "Pause" in the FSM visualization panel at any time to suspend a running SA. SA checks the pause signal **between each LLM call**, preserving message history integrity.

User intervention messages are enforced through three mechanisms:

1. **Current-step `additionalInstructions`**: takes effect immediately on the next LLM call.
2. **Persistent hot-zone injection**: every LLM call writes the intervention message into the "tail hot zone" after `SAFETY_FOOTER`, ensuring it is not diluted by execution inertia.
3. **Permanent append to `messages[]`**: permanently writes the intervention as a `user` role message into context, preventing SA from drifting back to the old execution path in later steps.

When a user-authorization dialog, long command wait, or task termination signal appears during tool execution, Runner must first write already returned tool results into `messages[]`, realtime observation, and `TaskArtifactStore`, then handle interruption and exit. This avoids the race where "the tool already produced a result, but SA loses the final observation or TaskArtifact because of quick authorization / checkpoint / cancel signal."

---

## 2. TypeScript Tool Interception Layer

Before tool calls actually take effect, the TypeScript layer implements two core protections: command classification/routing and pre-flight interception through an absolutely forbidden blocklist.

### 2.1 Tool Risk-Level Registry

**File**: `src/services/planning/tools/ToolPolicyManager.ts`

The system predefines risk levels for all Native tools:

| Tool                     | Risk level | Description                                                                        |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------- |
| `read`                   | low        | Read-only operation with no side effects                                           |
| `web_search`             | low        | Read-only operation with no side effects                                           |
| `local_search`           | low        | Read-only operation with no side effects                                           |
| `generate_image`         | low        | Writes only to the deliverables directory and is reversible                        |
| `file_write`             | medium     | Write operation with fast-apply snapshot fallback                                  |
| `cron`                   | medium     | Reversible scheduled-task management                                               |
| `exec`                   | **high**   | System command execution with possible irreversible side effects                   |
| `external_skill_execute` | **high**   | Unified execution entry for external Script Skills; executes skill-package scripts |
| `im_send`                | low        | Unified tool for sending IM messages                                               |

`feishu_send` / `slack_send` remain in the registry as low-risk compatibility bridges, but the Agent side actually exposes and recommends the unified `im_send`.

`ToolRiskGuard.requiresCheckpoint()` determines tool risk levels and provides a unified basis for factory validation, logging, and tests. Note that the current Runner does not apply this method generically to all high-risk tools. The main runtime pre-flight Checkpoint triggers are unsafe `exec` commands and `file_write` calls that are invoked without being authorized in `allowedTools`.

### 2.2 ExecSafetyPolicy Three-Way Command Routing

**File**: `src/services/planning/skills/exec/ExecSafetyPolicy.ts`

When a Sub-Agent executes the `exec` tool, the command first goes through three-way routing in the TS layer:

```text
Command input
|
+-- isExecCommandBlocked() -> true  ----> [STOP] Absolute rejection (no Checkpoint, no shell_execute)
|
+-- isExecCommandBlocked() -> false
|   +-- isExecCommandSafe()  -> true  ----> Safe command: skip user authorization and MB high-risk Checkpoint
|   +-- isExecCommandSafe()  -> false ----> Unsafe command: enter high-risk path, constrained by Runner/authorization/Rust/sandbox chain
```

In the current implementation, Runner's MB high-risk pre-flight Checkpoint intercepts unsafe `exec` only after there is already tool-call history. The first unsafe `exec` still goes through later defenses, including exec tool authorization, Rust `command_validator`, script scanning, sandbox policy, and Trash Bin. In other words, TS three-way routing is the entry to the high-risk path; it should not be understood as "every unsafe exec always triggers an MB LLM Checkpoint first."

**Blocklist (`BLOCKED_EXEC_PATTERNS`)**: uses regex `\b` word boundaries for precise matching and covers the following threat types:

| Category                                     | Examples                                                |
| -------------------------------------------- | ------------------------------------------------------- |
| Disk / partition destruction                 | `diskpart`, `format C:`, `cipher /w`                    |
| System boot damage                           | `bcdedit`                                               |
| User / service management                    | `net user`, `net stop`, `sc delete`                     |
| Registry damage                              | `reg delete`, `reg add HKLM`                            |
| Base64 obfuscation                           | `-EncodedCommand`, `-enc`                               |
| Persistent environment-variable modification | `setx /M`, `[Environment]::SetEnvironmentVariable`      |
| Direct registry-path writes                  | `Session Manager\Environment`                           |
| ACL + system directories                     | `icacls/cacls/Set-Acl` combined with `system32/windows` |

**Allowlist (`SAFE_EXEC_PATTERNS`)**: uses regex matching for common side-effect-free operations and allows them to pass directly:

- Read-only Git operations (`status` / `log` / `diff` / `branch`, etc.).
- File browsing (`ls` / `dir` / `cat` / `grep` / `find`).
- Build tools (`cargo build/test`, `npm run build`, `go test`).
- Version queries (`node --version`, `pip list`, etc.).
- Script execution (`python` / `powershell` / `bash`), where truly dangerous commands have already been intercepted by the pre-flight blocklist.

### 2.3 Silent Pass Optimization for Approved Tools

**File**: `src/services/planning/sub-agents/SubAgentRunner.ts`

```typescript
// Set of approved high-risk tools: after the first Checkpoint approval, later calls of the same tool type pass silently.
const approvedHighRiskTools = new Set<string>();
```

In skill-package scenarios such as `agent-browser`, the same type of tool (`exec`) may be called dozens of times in one task. The system uses a "approve once, allow same type" mechanism: after the first Checkpoint approval passes, later calls with the same tool name are added to `approvedHighRiskTools` and no longer repeatedly trigger MB LLM calls (10-24 seconds each). This cache is keyed by **tool name**, not by specific command content, so later defenses such as the TS blocklist, Rust hard validation, script scanning, and sandbox audit are still required as fallback.

---

## 3. Rust Command Validation Layer (Final Line)

**File**: `src-tauri/src/commands/command_validator.rs`

The Rust layer is the host-side enforcement point. When one of its modeled command, token, path, or script policies matches, it performs hard blocking before the operating system starts the command, even if the TS layer was bypassed. It combines conservative substring checks with token/subcommand parsing, normalized-path checks, and static script scanning. This is not a semantic proof for arbitrary native executables, unknown interpreters, or runtime-generated code; those limits are documented in section 5.8.

### 3.1 Six-Stage Validation Pipeline

`shell_execute` currently prioritizes `validate_command_safety_with_workdir()`. When running the checks below, it uses the real `workdir` to resolve relative delete/write targets. `validate_command_safety()` remains a compatibility entry point without `workdir`. The overall priority is:

```text
Input command (lowercased)
|
Step 1: Absolutely forbidden command blocklist (contains matching)
|       Hit -> Err(AppError::Forbidden), block immediately
|
Step 2: Exact detection for format disk commands
|       format + drive letter -> block (avoids false positives for Python str.format())
|
Step 3: wmic + write subcommand combination block
|       wmic read-only queries (get/list) -> allow
|       wmic + delete/create/set/call -> block
|
Step 4: icacls/cacls + ACL-modifying parameter + core directory ternary block
|       + PowerShell Set-Acl + system directory -> block
|
Step 5: Destructive verb + core protected directory combination block
|       + destructive verb + user-defined protected directory -> block
|
Step 6: Write redirection (>/>> /Out-File/Set-Content) + custom protected directory -> block
|
OK(())  -> command may execute
```

### 3.2 Core Protected Directories (Static)

Built-in immutable system paths cover the following literals and CMD `%...%` variable forms. This is a finite static pattern set, not a claim to understand every shell's environment-variable syntax. For final targets reconstructed by Trash Bin, the move-time checks also resolve and validate the current `SystemRoot` / `WINDIR` / `ProgramFiles` locations:

```rust
const PROTECTED_PATHS: &[&str] = &[
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
    "system32",
    "syswow64",
    "%systemroot%",      // Prevent bypass through environment-variable form.
    "%windir%",
    "%programfiles%",
    "%programfiles(x86)%",
    "\\windows\\system32",
    "\\windows\\syswow64",
];
```

### 3.3 Custom Protected Directories (Dynamic Hot Reload)

**Config file**: `{app_data_dir}/protected_paths.json`, using a JSON string-array format:

```json
["D:\\ImportantBackups", "E:\\ProjectArchives"]
```

The system uses a global `RwLock` cache keyed by the app-data root. On first use, it loads custom paths from disk; `reload_custom_protected_paths()` refreshes that cache immediately after a UI change without requiring restart. The file is limited to 1 MiB and 4,096 entries, with each path limited to 32 KiB. Reads use metadata preflight plus a bounded `limit + 1` read, and UI writes apply the same limits before replacing the on-disk configuration. A missing file on first load means an empty list. Once a valid cache exists, malformed JSON, budget overflow, ordinary read failure, or an unexpectedly missing file during explicit reload does not replace the last valid cache. After application restart, a still-missing file initializes as not-yet-configured empty state. `protected_paths.json` itself is a reserved internal path for supported Trash Bin deletion recognizers.

Custom protected directories apply to both:

- **Destructive verb protection**: `del` / `rmdir` / `remove-item`, etc.
- **Write redirection protection**: `>` / `>>` / `Out-File` / `Set-Content` / `Copy-Item`, etc.

### 3.4 File Write Path Protection

`validate_path_write_safety()` is called by Tauri file write/import commands such as `file_write_to_path`. It first performs lexical normalization, including `.` / `..` and Windows verbatim prefixes. It then canonicalizes the longest existing ancestor, appends any nonexistent suffix, and applies separator-bounded path-prefix matching to protect each custom directory and its descendants:

```rust
// Additional separator-boundary check to avoid matching "D:\\important_other" for "D:\\important".
if file_str.starts_with(&protected_normalized) {
    let after = &file_str[protected_normalized.len()..];
    if after.is_empty() || after.starts_with('\\') || after.starts_with('/') {
        return Err(AppError::Forbidden(...));
    }
}
```

#### Transactional Imports into the Right-Side Workspace

When files or folders are dropped into the right-side workspace, the frontend transfers them in 2 MiB chunks and the Rust backend writes the complete batch to internal staging on the target filesystem before committing it. Both the staging root and UUID session directories carry AgentVis ownership markers, while imported data is isolated under `payload/`. If an unowned `.agentvis-importing` directory already exists, the import fails closed without adopting or cleaning that user directory.

A durable commit guard is written before destination moves begin. If moving multiple top-level items fails, the backend rolls completed moves back in reverse order and checks every rollback result. It reports a full rollback only when every move was restored. Otherwise, staging, the recovery record, and paths requiring review are preserved; the frontend refreshes the file list and asks the user to inspect the workspace. Cancellation is available before commit; after the commit guard is established, the backend exclusively owns finalization or recovery preservation.

Stale cleanup only removes AgentVis-owned sessions that have a valid UUID, an exact session marker, no active session, an age of at least 24 hours, no commit guard, and no recovery record. A poisoned lock, symbolic link, missing marker, or damaged marker makes cleanup stop fail-closed.

For diagnostics, the frontend marks cancellation and error rollback IPC as the `workspace-import:cancel` renderer-health stage. Chunk byte progress is coalesced to a minimum 100 ms interval, while initial state, every file/directory completion, and the commit stage are emitted immediately. Rust records the `reason`, `duration_ms`, and outcome of every owned staging deletion; successful deletes taking at least one second and all failed deletes are logged as warnings.

### 3.5 Static Script Content Scanning

`validate_script_content()` is called before exec runs script files. It collects every script matched by a supported static extraction form rather than inspecting only the first argument. `cmd /D /C` wrappers (including combined switches, full executable paths, and `%ComSpec%` / `!ComSpec!`), `call`, PowerShell/Python/Node/Bun/Deno entrypoints, and statically identifiable nested scripts are scanned recursively up to eight levels. Dynamic composition, unknown interpreter entrypoints, and nested forms not recognized by the extractor remain outside this static guarantee.

**Scannable file types**: `.ps1`, `.bat`, `.cmd`, `.py` / `.pyw`, the JavaScript/TypeScript family (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`), `.cs`, and `.vbs`

**Forbidden script-content keywords (`SCRIPT_CONTENT_FORBIDDEN`)**:

| Keyword                       | Threat description                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `setenvironmentvariable`      | PowerShell/.NET persistent modification of system/user-level environment variables |
| `session manager\environment` | Directly writes system-level environment variables through a registry path         |
| `diskpart`, `bcdedit`         | Disk partition / boot configuration destruction                                    |
| `cipher /w`                   | Irreversible disk wiping                                                           |
| `takeown`, `sfc /`            | System permission breakthrough                                                     |
| `net user`, `sc delete`       | User / service management                                                          |
| `reg delete`, `reg add hklm`  | Registry damage                                                                    |

The scanner also recognizes common file-deletion APIs by language: PowerShell `Remove-Item` and the `ri` / `rm` / `del` / `erase` / `rd` / `rmdir` aliases; Python `os.remove` / `shutil.rmtree` / `Path.unlink`; Node.js `fs.rm` / `unlink` / `rmdir`, including ESM named imports from `fs`; ordinary and compact batch builtins such as `del/f/q` and `rmdir/s/q`; and C# / VBS deletion calls. Direct or package-manager-wrapped `rimraf` inside a scannable script is blocked as well. Once local deletion is confirmed, the Rust scanner returns the structured `[recoverable_delete_required]` reason internally. The TS exec layer does not expose that label or the Trash Bin mechanism to the Agent; it maps the reason to a neutral `[DELETE_RETRY_REQUIRED]` observation that requests one supported direct literal-path retry. The script is never launched in the hope that its in-process deletion will be intercepted later.

Script path extraction supports multiple invocation patterns:

- `powershell -File script.ps1`
- `pwsh -f script.ps1`, `powershell -NoProfile .\script.ps1`, and literal `-Command ".\script.ps1"` invocations, including quoted paths with spaces
- `cmd.exe /q/d/c script.cmd` and `%ComSpec% /D /S /C script.bat`
- `python script.py` / `python3 -u my_script.py`; once the interpreter is explicit, non-standard extensions are allowed
- `node script.js` / `bun script.mjs` / `deno run script.ts`
- `npx tsx script.ts` / `npx ts-node script.ts`
- `cscript script.vbs` / `wscript script.vbs`
- `csc.exe source.cs` (C# compiler; scans source code)
- Direct invocation: `./setup.bat`, `install.cmd`

Python, Node, Deno, and Bun entrypoint parsing shares each runtime's value-taking option table, honors `--`, and treats launcher options only before the real entrypoint; identically named arguments after the entrypoint remain script argv. Mode-specific values such as Deno test/bench `--filter` and Bun test `--test-name-pattern` are consumed as option data rather than file paths; explicit path-like Bun test entries are still scanned. Inline source from `-c` (including valid Python short-option clusters), eval/print, and PowerShell `-Command` reuses file-script scanning. Python `-m` scans `module.py` and package `__init__.py` / `__main__.py` when they can be resolved statically from exec workdir; installed modules that cannot be found there remain a dependency boundary. Deno task, package-task, and test auto-discovery modes do not misclassify task names or later data arguments as scripts.

Explicit path-like local Node, Deno, and Bun preloads are scanned together with real file entrypoints; bare package specifiers remain an installed-dependency boundary. Remote entrypoints, URI preloads, path-like preloads without a supported extension, pre-entry runtime `--cwd` / PowerShell `-WorkingDirectory`, and a directory change before script launch fail closed with `[script_scan_ambiguous_launcher]`; the caller must use an explicit local entrypoint and exec workdir. Node launcher options for external configuration, snapshot configuration, or path-like test setup/reporters that may indirectly execute unscanned code fail with the same reason.

Dangerous system keywords and delete APIs are first checked in code with comments and ordinary inert strings removed. Literal commands, argv arrays, and one-step literal variable bindings inside explicit execution contexts such as `subprocess`, `child_process`, `Process.Start`, `Start-Process`, and WSH Run remain blocked. Python comments and triple-quoted strings, JavaScript regex literals, PowerShell here-strings, Batch control segments, and bounded recursive executable interpolation in Python, JavaScript, PowerShell, and C# are handled by language-aware paths so inert explanatory strings pass while real interpolated calls remain visible. Interpolation that does not converge within eight levels fails with `[script_scan_depth_exceeded]`; analysis growth beyond 16 MiB fails with `[script_scan_too_large]` instead of accepting a partial scan. Nested path resolution preserves original case, quoting, and spaces; the lowercase normalized view used for dangerous-keyword matching is no longer used to select files for scanning.

Each script read is limited to 8 MiB and supports UTF-8 plus UTF-16 LE/BE and UTF-32 LE/BE BOMs; NUL-heavy text without a BOM fails closed as an unreadable encoding. One nested scan may read at most 256 distinct file-and-language combinations and 64 MiB in total, while a cyclic dependency on the same real file is scanned only once. An ambiguous launcher, entrypoint, or resolution directory; an unreadable script or working directory; single-file or graph-budget overflow; and a new unvisited nesting chain beyond eight levels fail closed with `[script_scan_ambiguous_launcher]`, `[script_scan_unreadable]`, `[script_scan_too_large]`, and `[script_scan_depth_exceeded]` respectively. Inability to inspect is not treated as safe. This remains conservative static scanning, not interpreter-level semantic execution. Bare dependencies/package tasks, test auto-discovery, more complex runtime composition, downloaded code, native binaries, and TOCTOU replacement after scanning still depend on permission mode, sandboxing, and the remaining execution chain.

---

## 4. Process / Network Sandbox and Security Audit

**File**: `src-tauri/src/commands/process_sandbox.rs`

Runtime sandbox policy is added to the Rust shell execution chain. Its role is to "reduce accidental operations and side effects from external scripts"; it does not replace command blocklists, script scanning, or Trash Bin. The product layer exposes only three user permission modes: **Local Audit Mode**, **Offline Isolated Mode**, and **Controlled Network Mode**. Internal enums remain `LocalAudit` / `OfflineIsolated` / `ControlledNetwork`, while backend `standard` / `externalSkill` / `installer` / `preview` / `restricted` remain technical profiles for audit attribution.

> Important boundary: Job Object is not a "sandbox switch"; it only manages the lifecycle cleanup of managed commands. GUI / detached launches in Local Audit Mode should not be attached to a Job Object with `KILL_ON_JOB_CLOSE`, to avoid accidentally killing external applications such as Chrome, VS Code, or explorer after launch.

### 4.1 Execution Profiles and Default Network Policies

| profile         | Typical source                               | Default network policy | Description                                                                                                              |
| --------------- | -------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `standard`      | Normal `exec`                                | `inherit`              | Does not change normal shell networking behavior                                                                         |
| `externalSkill` | External Script Skill                        | `audit`                | Does not block by default, but scan hits write audit events                                                              |
| `installer`     | Skill installation / dependency installation | `inherit`              | Allows dependency downloads during installation                                                                          |
| `preview`       | Built-in Project Preview                     | `inherit`              | Keeps networking available; isolated staging, input allow-lists, and owned PIDs separately constrain files and execution |
| `restricted`    | High-risk / strongly isolated execution      | `blocked`              | Enables stricter process and network constraints                                                                         |

`preview=inherit` does not mean that an Agent project is trusted directly. Built-in Project Preview does not execute in the deliverable directory, never executes npm lifecycle scripts, and does not infer process ownership by scanning ports. Snippet mode executes only AgentVis template configuration; complete-project mode executes staged project Vite/PostCSS/Tailwind configuration to preserve plugins, aliases, and CSS toolchain semantics. It uses app-cache staging, path/dependency/asset budgets (including a 256 KiB manifest and 128-dependency limit), fail-closed native-JS-only Import Map preflight, an AgentVis server wrapper, a per-run health token, and registry-owned PID lifecycle as its dedicated boundary. Rust native commands create staging and return a `runId`/`ownerToken`; `.agentvis/active` binds that exact identity and a cross-instance file lease protects an active workspace. Normal cleanup must also prove and release this process's registry lease, so another instance's marker/token alone cannot authorize removal. Only after app-cache direct-child, UUIDv4, link/reparse, and canonical-containment checks does it atomically quarantine and delete without following links; junctions have only the link removed. Stale cleanup requires at least 24 hours of inactivity and successful lease acquisition and runs in bounded native pages; a partially deleted `.trash-{UUIDv4}` is self-reclaimed only through a strictly paired root receipt that is at least 24 hours old. The frontend backlog is bounded with a fixed retry count per start. Complete-project configuration is executable Node code under the current user and Local Audit is not an OS-level VM; this boundary must not be described as strong isolation for arbitrary untrusted build configuration, browser-network DLP, or full virtual-machine isolation.

The shared Preview templates also use a per-template OS-backed cross-process exclusive lease and treat the completion marker as a commit record for the controlled `package.json`; that marker is invalidated before any manifest update. The staging deleter uses an explicit stack and caps each pass at 100,000 entries, 128 levels, and two seconds, while the entire stale IPC is capped at five seconds. A partial quarantine keeps its root receipt so a later sweep continues from the remaining tree. Window close invalidates the renderer request ID synchronously before awaiting service cleanup, preventing a pre-service scan from starting Preview again during shutdown.

Relationship between the three user permission modes and backend mechanisms:

| UI mode                 | Backend mode                    | File boundary                                                                                                       | Network boundary                                                                                                                                                                                   | Process lifecycle                                                                                                                       |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Local Audit Mode        | `sandboxMode=LocalAudit`        | Not restricted to workdir; uses protected paths and Trash Bin                                                       | Inherits system network                                                                                                                                                                            | CLI uses managed lifecycle; GUI uses detached launch                                                                                    |
| Offline Isolated Mode   | `sandboxMode=OfflineIsolated`   | AppContainer / workdir scope                                                                                        | deny-all                                                                                                                                                                                           | Blocks detached launch and desktop control                                                                                              |
| Controlled Network Mode | `sandboxMode=ControlledNetwork` | Default: local file space + protected paths / Trash Bin; legacy fallback may return to AppContainer / workdir scope | Current: normal `exec` / Guide Skill broker-proxy-preferred + direct/audit; Script Skill can explicitly use brokerOnly; target: broker/proxy-only egress after OS-level direct-connection blocking | By default blocks general detached launch and desktop control; `agent-browser` is available through a dedicated CDP runtime narrow path |

`execution.permissions.network` can affect the network policy of external Script Skills:

- `true`: inherits system network, suitable for Skills that clearly need networking, such as GitHub, ArXiv, RSS, and email APIs.
- `false`: if pre-execution static scanning hits network commands or network APIs, execution is blocked directly.
- Unspecified: defaults to `audit`, recording risk while trying not to break already installed Skills.
- `execution.permissions.networkMode=brokerOnly`: explicitly declares that only broker egress is allowed. It currently blocks direct shell networking, creates a per-run broker session, and injects `AGENTVIS_BROKER_PIPE` / `AGENTVIS_BROKER_TOKEN` / `AGENTVIS_BROKER_FETCH`. Scripts delegate HTTP(S) requests through `agentvis-broker-fetch`; the helper is provided by release package `resources/bin` and copied to `{AppDataDir}/runtime/bin`, and missing helper fails closed. This conflicts with `network=false`.
- `execution.permissions.filesystem`: external Script Skills can generate per-run AppContainer filesystem grants from string parameters, for example `{ fromArg: path, access: readWrite }`. This declaration only expands local paths visible to the restricted process and does not change network policy; `network=false` still disables networking. It is suitable for local-file Skills such as file organization, conversion, and batch processing.
- `agentvisNetwork: brokerProxyPreferred`: Controlled Network compatibility declaration in Skill frontmatter. It only applies to HTTP(S) proxy-aware Skills that honor `AGENTVIS_NETWORK_PROXY_URL` / `HTTP_PROXY` / `HTTPS_PROXY`. When explicit WFP per-run guard encounters this kind of Python Skill, it may downgrade to broker-proxy-preferred to reduce false positives caused by the first token being a shared interpreter. This declaration is not an allow path for non-HTTP(S) protocols and is not equivalent to full brokerOnly.
- `agentvisNetworkEntrypoints`: entrypoint-level network declaration in Skill frontmatter, taking precedence over the package-level declaration. A typical use is marking scripts under `scripts/` as `brokerProxyPreferred`, or marking a script under `scripts/` as `legacyNonHttp`. `brokerProxyPreferred` means HTTP(S) API paths should go through broker/proxy and audit; `legacyNonHttp` does not allow direct connections, but tells Controlled Network that the entrypoint is a non-HTTP(S) legacy path such as IMAP/SMTP/SSH/database/raw socket and needs direct-audit authorization closure.
- Guide-mode scripts also automatically bind entrypoint-level declarations. Script paths in normal `exec` are matched against loaded external Skills' `packagePath` / `agentvisNetworkEntrypoints`. On a `legacyNonHttp` hit, the execution layer appends `--action network_targets` with the same arguments before real networking and runs a read-only preflight. If exact targets are returned, it enters direct-audit authorization; if not, it remains blocked. This lets self-made or downloaded Guide Skills use the same Controlled Network foundation without converting to Script Skills.
- The unified Script Skill execution entry is `external_skill_execute({ skillName, args })`. This tool precisely matches the Script Skill Contract, validates parameters, and calls `ExternalExecutor`; `brokerOnly` currently takes effect only through this Script Skill contract chain. Guide Skills continue to use normal `exec`, and the Controlled Network migration target is to route normal commands through broker/proxy egress as well.
- `execution.permissions.desktopControl=true` means the Skill needs interactive desktop capabilities such as hotkeys, mouse, screenshots, and window activation; Offline Isolated Mode blocks it. Controlled Network still does not generally open desktop capability by default, except for narrow built-in paths such as `agent-browser`, which integrate with a dedicated runtime and broker proxy contract.
- `execution.permissions.desktopLaunch=true` means the Skill may start external GUI / detached applications; Local Audit Mode uses detached lifecycle, while Offline Isolated Mode blocks it. After the Controlled Network migration, managed commands are prioritized first, without promising that external GUI processes are fully network-managed.
- Guide-style desktop / browser Skills do not necessarily go through the manifest executor. Commands such as `desktop_control.py`, `agent-browser`, and `start-chrome-debug.bat` are recognized as detached lifecycle even in Local Audit Mode, avoiding Job Object closing external applications when the shell exits. In Controlled Network, `agent-browser` only allows the narrow controlled path through `start-chrome-debug.bat`, `browser-command.bat`, and CDP commands bound to an `agentvis-cdp-*` session.

### 4.2 Runtime Isolation Capabilities

- Windows child processes are attached to Job Object where possible, so timeout, cancel, and background kill preferentially terminate the process tree.
- The `restricted` profile supports the Restricted Token path. When the AppContainer filesystem backend is explicitly enabled, the workdir is granted as the minimum accessible directory.
- AppContainer deny-all network isolation is the preferred strong-isolation backend candidate for `restricted + blocked`; it is lifecycle-local and does not require a resident service.
- AppContainer filesystem grants include workdir, in-app runtime / skills / deliverables roots, the user-level Agent Browser screenshot root, and sandbox-profile paths needed by embedded Python and external Skills. `brokerOnly` file-based IPC publishes requests in the runtime directory through temporary-file rename, so ReadWrite grants must support create/write/rename/delete.
- Script Skills can use `execution.permissions.filesystem` to add AppContainer grants for user-provided files or directories. Grants may only reference string parameters in `argsSchema` and must declare `readOnly` or `readWrite`; this prevents controlled-network no-network paths from misclassifying valid local-file tasks as lacking permission.
- Offline Isolated processes redirect `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, temp directories, and `XDG_*` into `{AppDataDir}/runtime/sandbox-profile/*`, preventing scripts from writing tokens/caches to the real user home directory. The target shape of Controlled Network no longer redirects these directories, so existing user CLI / Skill credential caches can be reused.
- Native file tools (`read` / `file_write` / `local_search`) use `sandboxFilesystemScope` from tool context to decide file boundaries: Offline Isolated is fixed to `workspace`, while the Controlled Network target shape is `local`, avoiding a split where `exec` can access local files but native tools are forced back to the workspace.
- The `exec` preflight blocks for "global install / login flows" and runtime hints such as "command not found / credentials missing may be caused by sandbox environment differences" are only used for Offline Isolated. Controlled Network no longer explains such failures as workspace file-sandbox issues, avoiding misleading the Agent into repeatedly asking to switch to Local Audit Mode.
- Trash Bin delete interception happens inside the Tauri main process. Under Offline Isolated, it validates workdir and fixed application-managed roots before a host-side move. Only when `AppContainerFilesystem` is the effective backend may currently existing, deduplicated read-write/default grants expand that host-side set; read-only or missing grants do not, and Restricted Token does not inherit this expansion. This prevents soft delete from silently widening the effective filesystem boundary. Controlled Network follows Local Audit Mode's protected paths, custom protected paths, and Trash Bin.
- Desktop GUI control is not a normal CLI capability. In Offline Isolated, `desktop-control`-style Skills, hotkeys, screenshots, window activation, SendInput / pyautogui / pywinauto, and similar automation should be blocked before spawn, avoiding cases where scripts exit with code 0 while real desktop operations are swallowed by Windows UI isolation or Job Object lifecycle. The Controlled Network target shape should decide whether to open this only after network-only guard coverage is clear.
- The Python runtime must be hermetic. If a shared venv's `pyvenv.cfg` points to user-host Python, such as `C:\Python*`, Offline Isolated Mode treats it as incompatible and requires rebuilding an embedded Python runtime.
- WFP helper / probe remains an enhanced network-isolation spike and diagnostics entrypoint, and is not connected to the default shell / Skill chain. When `AGENTVIS_NETWORK_GUARD_BACKEND=wfpAppIdBlock` or `wfpPerRunAppIdBlock` is explicitly set, the normal shell chain first runs the WFP helper `inspect --json` readiness diagnostic and writes the result to a `wfpEnhanced` audit event. The first batch of per-run managed executable policy only supports foreground commands whose first token is bare `curl` / `node`: the main process creates a temporary directory marked with `.agentvis-egress-managed`, copies the real tool executable, prepends PATH, and starts a WFP dynamic block session for the command lifecycle. Other network-intent commands fail closed by default to avoid false positives from shared `cmd.exe` / interpreter AppIDs affecting other processes on the same machine. HTTP(S) Python Skills declared with `agentvisNetwork: brokerProxyPreferred` or explicitly opt-in via execution environment may downgrade to broker-proxy-preferred and write diagnostic audit. PowerShell specifically parses networking actions inside `-Command` / `-EncodedCommand`, such as `Invoke-WebRequest`, `Invoke-RestMethod`, `iwr`, `irm`, and `curl`; plain URL strings do not trigger WFP network intent by themselves. This switch validates the per-run egress guard foundation and does not mean ordinary commands already provide full brokerOnly.

### 4.3 Network Scanning and Environment Tightening

Before `shell_execute` spawn, `ShellSandboxPolicy` applies network policy through:

- Network command scanning, such as `curl`, `wget`, `ssh`, `Invoke-WebRequest`, and `Invoke-RestMethod`.
- Script network API scanning, such as `requests`, `urllib.request`, `socket`, `aiohttp`, and `smtplib`.
- No-network environment-variable injection, such as `AGENTVIS_NETWORK_ACCESS=blocked`, so child processes and later runtimes can detect the policy.

Controlled Network currently defaults to local file space and broker-proxy-preferred network guard. Normal `exec` / Guide Skills receive a per-run HTTP(S) proxy environment (`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`) and optional `agentvis-broker-fetch` helper environment. The proxy reuses main-process broker validation and audit attribution for localhost/private/link-local/metadata targets. The per-run proxy requires token authentication, and standard proxy URLs as well as npm / pip / git injected values carry credentials. Browser runtime instead reads a server-only address through `AGENTVIS_BROWSER_PROXY_SERVER` and uses a local one-time proxy endpoint, so users do not need to see or enter proxy auth. The broker resolves and validates the target address for every request, rejecting localhost, private, link-local, metadata, CGNAT, multicast, unspecified, and similar results. It also detects private/local/metadata IPv4 addresses encoded in `sslip.io` / `nip.io` / `xip.io` before DNS, preventing enterprise DNS/proxies from rewriting risky targets into `198.18.x.x` and making them look like ordinary public addresses. HTTP requests and HTTPS CONNECT use the same validated address set for connection; redirects repeat resolution, validation, and pinning hop by hop, avoiding TOCTOU between DNS validation and connection.

`agent-browser` uses the AgentVis dedicated Chrome CDP runtime rather than default headless Playwright. In Controlled Network, only `start-chrome-debug.bat`, `browser-command.bat`, and CDP commands bound to an `agentvis-cdp-*` session are given a narrow path. The launcher enforces the broker browser proxy, rejects direct/bypass/credential proxy Chrome arguments, and uses runtime state to avoid reusing old Chrome instances launched under Local Audit Mode. `browser-command.bat` clears the effect of normal proxy env on the local CDP control plane, reliably restores minimized state after screenshots, and turns `close` into runtime graceful stop. Attaching to an arbitrary already-running user Chrome is only a Local Audit Mode capability and is not a default Controlled Network promise.

When `ControlledNetwork + internetAudit + broker-preferred` detects proxyable network intent such as HTTP(S), Git, or npm, an unavailable broker proxy session must fail closed with `broker_proxy_required_unavailable`; it must not silently fall back to direct connection. If the broker file/helper session is unavailable but the proxy is available, execution may continue with a `broker_helper_unavailable` diagnostic. Successful proxy startup writes `broker_proxy_session_started`. If the command exits successfully but the current broker file/proxy session made no broker requests, it writes a `broker_proxy_expected_but_unused` diagnostic for investigating cache hits, misclassification, or suspected silent direct egress.

`broker_proxy_expected_but_unused` is a high-signal diagnostic, not a block. Audit detail carries `reasonCode=broker_proxy_expected_but_unused` and an aggregatable `reasonClass`, currently including `cache_hit_likely`, `tool_misclassification`, and `potential_direct_egress`. Agent observation should explain it as three investigation paths: "cache hit / detection misclassification / suspected direct egress"; it must not directly assert task failure.

To reduce ecosystem false positives, the shell also injects `npm_config_proxy` / `npm_config_https_proxy` / `PIP_PROXY`, git per-process `http.proxy` / `https.proxy`, and a browser-runtime-readable server-only proxy environment. HTTP(S) Python Skills can declare `agentvisNetwork: brokerProxyPreferred` to mark themselves as proxy-aware, reducing shared-interpreter false positives under explicit WFP per-run guard. The built-in `web-scraper` also automatically reads `AGENTVIS_NETWORK_PROXY_URL` / standard proxy env and passes them to httpx / curl_cffi. The legacy AppContainer direct backend can be restored with `AGENTVIS_CONTROLLED_NETWORK_BACKEND=legacy`; that path clears `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` and sets `NO_PROXY=*`, avoiding timeout when AppContainer inherits a `127.0.0.1` local proxy. When a Script Skill declares `brokerOnly`, the AppContainer network capability becomes deny-all and only allows HTTP(S) requests delegated through the main-process broker helper. Non-HTTP(S) direct connections do not claim broker-only, but the controlled escape hatch already supports "exact target + user confirmation + direct-audit audit."

Controlled Network is not generalized DLP and does not inspect file content. It currently triggers one-time confirmation only for three high-confidence network risks: explicit file upload, sensitive material egress, and remote destructive operations. File upload hits `network_upload_confirmation_required` / `network_upload_risk_confirmed`; sensitive egress hits `network_sensitive_egress_confirmation_required` / `network_sensitive_egress_confirmed`; remote destruction hits `network_remote_destructive_confirmation_required` / `network_remote_destructive_confirmed`. Confirmation applies only to the same retry and does not persist authorization. Audit additionally writes `riskClass`, `riskKind`, and `credentialContext` to distinguish `fileUpload`, `sensitiveEgress`, `remoteDestructive`, and broker credential / ambient credential context. Normal `git` / `npm` / `pip`, read-only HTTP(S) queries, downloads to local files, `kubectl get`, `helm list`, `terraform plan`, `aws s3 ls`, and read-only database queries do not trigger these three confirmations.

#### 4.3.1 Non-HTTP(S) direct-audit Authorization Closure

Non-HTTP(S) protocols such as IMAP/SMTP/SSH/database/raw socket are not pretended to be covered by the HTTP broker. Under Controlled Network, direct-connection intent of this kind fails closed by default. Only when `protocol + host + port + subject` can be determined clearly can a UI dialog generate a direct-audit allowance for the current run or current session.

The current closure includes:

- `sandbox_network_direct_targets` only checks targets and does not execute the original network action. SSH/scp/sftp commands can extract targets directly from the command line, for example `ssh -p 2222 user@example.com` -> `ssh://example.com:2222`.
- The email-helper legacy IMAP/SMTP entrypoint reads account configuration through read-only `--action network_targets` and returns `imap://host:port` / `smtp://host:port` without opening a network connection.
- Self-made or downloaded non-HTTP(S) Skills can declare an entrypoint as `legacyNonHttp` in `agentvisNetworkEntrypoints` and implement read-only `--action network_targets`, outputting JSON such as `{"targets":[{"protocol":"postgres","host":"db.example.com","port":5432}]}`. Script Skills use this preflight through `ExternalExecutor`; Guide Skills use the same preflight by automatically reading frontmatter through normal `exec` script-path attribution. If no exact target is returned, execution remains blocked.
- Common non-HTTP(S) command-line targets already cover SSH/SCP/SFTP, raw TCP / Telnet, and major database client paths including `psql`, `mysql` / `mariadb`, `redis-cli`, `mongosh` / `mongo`, and `sqlcmd`. PowerShell additionally recognizes `Test-NetConnection` / `tnc` and `.NET TcpClient/Socket` raw sockets: when host/port can be statically extracted, it enters direct-audit; when the exact target cannot be extracted, no authorization dialog is shown and it continues to fail closed with `proxy_bypass_signal_blocked`.
- The UI dialog shows only the exact target and authorization subject. Public targets can choose "allow this time" or "allow for this session"; localhost/private/link-local/CGNAT targets show high-risk copy and default to this-run only; metadata targets in `ControlledNetwork` do not provide an allow button and require switching to Local Audit Mode. The generated `NetworkDirectAllowance` has fixed fields: `id, subjectType, subjectId, protocol, host, port, scope, expiresAt, createdAt, reason`; `scope` currently supports `currentExecution` and `session`.
- Before direct-audit authorization, Rust resolves the hostname and returns `resolvedRisk`, `resolvedIpSamples`, and `resolvedRiskReason` to the frontend. If the hostname resolves to metadata, the backend fails closed with `network_direct_metadata_target_blocked`; if it resolves to localhost/private/link-local/CGNAT, only `currentExecution` is accepted, not `session` scope. To avoid enterprise DNS/proxies rewriting `sslip.io` / `nip.io` / `xip.io` into proxy-mapped addresses, Rust first detects IPv4 addresses encoded in hostnames, such as `127.0.0.1.sslip.io` and `169-254-169-254.sslip.io`, and marks `hostnameEncodedPrivateOrLocalIp` / `hostnameEncodedMetadataIp`. Proxy/load-test mapping addresses such as `198.18.0.0/15` do not change the public authorization experience, but are diagnosed with `dnsResolvedBenchmarkOrProxyIp` / `literalBenchmarkOrProxyIp`.
- During retry, the frontend passes both `networkDirectAllowances` and `networkDirectTargets`. The Rust side requires the target and allowance to match exactly by subject, protocol, host, port, and expiration time; only a successful match records audit as `directAuditAllowed` and continues execution.
- direct-audit is not broker-only. It does not proxy content, parse protocols, or rewrite domain policy. Its role is to preserve an explainable, auditable, and revocable execution space for everyday necessary non-HTTP(S) tasks.
- `network-direct-guide` covers SSH/SCP/SFTP, raw TCP / Telnet, database clients, and no-target negative checks. Commands whose exact targets can be parsed show a direct-audit authorization dialog and continue after approval. If the corresponding local client is missing, a later OS-layer failure is not considered a sandbox false block. Raw socket commands without host/port do not show an authorization dialog and continue to hard-block. In quick authorization-dialog scenarios, tool results, observation, and TaskArtifact have been verified not to be lost.
- The 7 core network-isolation commands for `ControlledNetwork` behave as expected. Git HTTPS passes normally through broker/proxy with no direct-audit dialog; `curl.exe --noproxy "*"` is blocked by `proxy_bypass_signal_blocked`; PowerShell `.NET TcpClient` to `example.com:80` triggers `tcp://example.com:80` direct-audit and blocks after user rejection; `Test-NetConnection imap.gmail.com:993` triggers direct-audit and continues after user approval; `127.0.0.1:5432` shows a private/local high-risk dialog and only allows this run; `169.254.169.254:80` shows the metadata risk path and cannot be allowed under Controlled Network; Socket creation without static host/port is directly blocked and no broad authorization is offered.
- Normal `curl` / Git HTTPS / npm tasks remain usable and write `broker_proxy_session_started` / `broker_network_request`. `curl --noproxy "*"`, `curl -x ""`, `git -c http.proxy=`, and `cmd /c "set npm_config_proxy=&& npm view ..."` are all blocked with `proxy_bypass_signal_blocked`. Normal URLs targeting localhost, metadata, CGNAT, IPv6 loopback, and similar addresses are blocked by broker target validation. PowerShell `.NET TcpClient` continues to block. Python `subprocess` / Node `child_process` spawning raw sockets again, plus Playwright / Chromium `--proxy-server=direct://` / `--proxy-bypass-list=*`, are covered by static bypass scanning and intent gating: script content should fail closed before execution even if launched through a `cmd /c "cd /d ... && node/python script"` wrapper. redirect-to-private still needs a self-hosted canary endpoint to verify broker hop-by-hop validation; if a third-party public redirect service itself refuses private redirects, that is not proof of broker coverage.
- In the A-H regression baseline, everyday public-network tasks remain usable and explicit proxy bypasses are blocked. The additional test `cmd /c "set npm_config_proxy=&& set npm_config_https_proxy=&& npm view ..."` now reliably hits `proxy_bypass_signal_blocked`. Two C-group retests show that `curl --data-binary @file`, `curl -F file=@...`, `curl -T`, and PowerShell `Invoke-RestMethod -InFile` all trigger `network_upload_confirmation_required`; after the user selects "allow this upload once", `network_upload_risk_confirmed` is written and execution continues. A `webhook.site` endpoint can return 200; a temporary Vercel endpoint returning 404 is classified as an endpoint routing problem, not a sandbox failure. One `Invoke-RestMethod` retest produced a non-blocking `broker_proxy_expected_but_unused` / `reasonClass=potential_direct_egress` diagnostic and needs continued observation. Real upload canary body / bytes_out / target validation should still rely on self-hosted broker canary automation tests and stable public manual canaries. The public/private/metadata direct-audit experience meets expectations. The HTTP broker layer identifies hostname-encoded IPs before DNS: `127.0.0.1.sslip.io` returns `403 Forbidden` and records `resolvedRisk=private`, `resolvedRiskReason=hostnameEncodedPrivateOrLocalIp`, `resolvedIpSamples=127.0.0.1`; `169-254-169-254.sslip.io` returns `403 Forbidden` and records `resolvedRisk=metadata`, `resolvedRiskReason=hostnameEncodedMetadataIp`, `resolvedIpSamples=169.254.169.254`. `cmd /c echo https://example.com` reliably triggers non-blocking `broker_proxy_expected_but_unused` with detail containing `reasonClass=tool_misclassification`.
- Automated-scenario regression coverage has been filled in: the Rust detector adds a `network_risk_checkpoint_matrix_covers_daily_and_high_risk_cases` matrix, using `id/group/expectation` to fix both boundaries: "normal daily tasks are not falsely blocked" and "explicit upload / exfiltration / destructive remote operations are detected." Current negative coverage includes normal download, read-only query, package management, Git, Kubernetes read-only, Terraform plan, AWS S3 ls, and database read-only. Positive high-risk coverage includes file upload, environment variable / SSH key / `credentials.json` egress, HTTP DELETE, `helm`, `gh repo delete`, `az/gcloud/aws`, `mongosh`, and `sqlcmd`. This layer does not replace a real manual task matrix; it is a regression baseline for later accumulated Agent task samples.
- `agent-browser` Controlled Network validation conclusion: the default browser Skill's proxy contract is closed. After starting the AgentVis dedicated CDP runtime with `start-chrome-debug.bat`, real page navigation, snapshot, screenshots / annotated screenshots, fill / click / press, scroll, wait, get text / attr, screenshot temporary-file cleanup, post-start minimization, and `browser-command.bat close` graceful stop are all stable. Explicit direct/bypass/credential proxy Chrome arguments remain blocked. The browser runtime no longer asks users to enter proxy auth; when an old runtime or proxy hash mismatch is detected, `ensure` rebuilds it.

Target shape: Controlled Network keeps the `ControlledNetwork` field and UI name, and continues migrating from "networked AppContainer with file isolation too" to "local file space + broker-only network egress." Normal `exec` / Guide Skills already have a broker-proxy-preferred session entry. Later, WFP or an equivalent network-only guard must block direct connections that bypass the proxy; before OS-level direct-connection blocking is complete, this can only be called broker-proxy-preferred / audit, not full brokerOnly.

Static scanning can only detect obvious networking traces. Outside the AppContainer path, `network=blocked` is a soft block and cannot be described as hard no-network. Real domain control requires later broker / proxy or observable network-event support.

Additional boundaries:

- Network API hits in the current Controlled Network implementation are audit, not block; only Offline Isolated Mode should block. The migration target is for Controlled Network to fail closed on ordinary command direct connections once a network-only guard is available.
- `web_search` already goes through the main-process broker first and records `broker` audit events. Generic `network_broker_http_request` can record broker audit attributed by `tool` / `skill` / `command`.
- Script Skill `brokerOnly` is a fail-closed switch: direct connections are disabled, helper requests are validated by the main-process broker for URL, private/localhost/link-local, redirects, and size limits, and `broker` audit is recorded according to execution context. Third-party Skills only need to explicitly call the helper; they do not need to be trusted by the broker. On 2026-05-23, `broker-e2e` verified four passing cases under Controlled Network. Guide Skill normal `exec` attribution can already pass through to a broker-proxy-preferred session; HTTP(S) clients enter the main-process broker/proxy if they obey proxy environment variables.
- `brokerProxyPreferred` is an intermediate mode to reduce false positives. It allows proxy-aware HTTP(S) tools to keep using ordinary libraries and standard proxy environments, but it still cannot promise that all direct connections are blocked at the OS layer. `curl --noproxy` / `--no-proxy`, explicit `NO_PROXY` / `npm_config_noproxy`, clearing `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `npm_config_proxy`, Chromium direct proxy flags, Node native fetch not using proxy, Python / Node child processes spawning raw sockets, PowerShell `.NET TcpClient/Socket`, `Test-NetConnection`, raw socket, and IMAP/SMTP/FTP/SSH libraries are identified as `proxy_bypass_signal_detected` and fail closed with `proxy_bypass_signal_blocked` in the default Controlled Network path. If the task is non-HTTP(S) and exact targets can be extracted, execution can be restored through direct-audit authorization closure. Private/localhost/link-local targets remain covered by broker target validation, direct-audit risk classification, and WFP/equivalent guard fallback.
- Non-HTTP(S) Skills should not declare `agentvisNetwork: brokerProxyPreferred`. IMAP/SMTP paths use `agentvisNetworkEntrypoints.scripts/email_helper.py=legacyNonHttp`, then run through `network_targets` preflight and direct-audit authorization. Self-made email, SSH, database, and raw socket Skills should also use entrypoint-level `legacyNonHttp` + read-only target preflight, rather than declaring the entire Skill as HTTP(S) proxy-aware.
- `github-lookup` has verified that the broker path is usable under the Controlled Network legacy implementation, but `Path.home()` inside the sandbox does not point to the real `C:\Users\<user>`, so it cannot read an existing `.github_token.json`. The new default Controlled Network path will reuse the real Home / application-directory CLI and Skill token caches, but needs matching broker log redaction, agent-facing observation redaction, and upload policy so credentials do not enter model context or leak.
- Full compatibility with Windows local proxies, enterprise proxies, and VPNs cannot rely on sandbox processes directly connecting to loopback. Later, the main-process broker / proxy should inherit the local network environment and provide unified request audit.

### 4.4 Security Audit Events

The Rust side pushes structured events through `agentvis://sandbox-audit-event` and exposes recent in-memory events through the `sandbox_audit_events` command. The current event `schemaVersion` is `1`, with core fields:

```ts
type SandboxAuditEvent = {
  schemaVersion: 1;
  id: string;
  timestamp: number;
  timestampIso: string;
  executionId: string | null;
  source: 'exec' | 'externalSkill' | 'installer' | 'preview' | 'nativeTool';
  subjectType: 'command' | 'skill' | 'tool' | 'preview' | 'installer' | 'process' | 'wfpSession';
  subjectId: string | null;
  commandHash: string;
  profile: 'standard' | 'externalSkill' | 'installer' | 'preview' | 'restricted';
  sandboxMode: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
  processLifecycle: 'managed' | 'detachedLaunch' | 'backgroundManaged';
  networkPolicy: 'inherit' | 'audit' | 'blocked';
  networkScope: 'inherit' | 'blocked' | 'lan' | 'internetAudit';
  backend:
    | 'none'
    | 'jobObject'
    | 'restrictedToken'
    | 'appContainer'
    | 'mainProcess'
    | 'broker'
    | 'wfpEnhanced';
  decision: 'allow' | 'audit' | 'block' | 'diagnostic';
  reason: string;
  matchedPattern: string | null;
  riskClass?: string | null;
  riskKind?: string | null;
  credentialContext?: string | null;
  workdir: string | null;
  cleanup: 'notApplicable' | 'clean' | 'residualDetected' | 'failed' | null;
  targetHost?: string | null;
  targetScheme?: string | null;
  targetPort?: number | null;
  networkProtocol?: string | null;
  guardMode?: 'auditOnly' | 'wouldBlock' | 'hardBlock' | 'directAuditAllowed' | null;
  requestMethod?: string | null;
  urlHash?: string | null;
  statusCode?: number | null;
  bytesIn?: number | null;
  bytesOut?: number | null;
  durationMs?: number | null;
  blockedReason?: string | null;
};
```

Events do not record the full original command text. They only record stable hash, profile, network policy, matched pattern, and decision result, providing a data foundation for later Skill security overviews, audit logs, and permission-recovery UI. Network-related observations and audit details must not record proxy tokens, `Authorization`, `Proxy-Authorization`, `Cookie`, or common secret query/key values. For targets, only redacted target, hash, status code, byte counts, duration, and block reason are retained.

---

## 5. Agent Trash Bin Soft Delete

**File**: `src-tauri/src/commands/trash_bin.rs`

Agent Trash Bin is a **recoverable soft-delete layer** for file deletion operations. When an Agent runs delete commands such as `del`, `rmdir`, or `Remove-Item`, the Rust backend intercepts the command before calling the OS and preserves recoverable target content under the app-data `Agent_Trash_Bin` instead of allowing the original delete command to destroy it.

Soft deletion commits only when safety can be proven. The command first passes protected-path checks over command text and lexical targets. After allowlisted environment expansion and glob enumeration, Trash Bin revalidates every final target before transferring anything. It blocks protected paths and their ancestors, intersections with `protected_paths.json` or internal recovery metadata, and, under `restricted` mode, targets outside allowed roots. Lexical paths are checked together with canonicalized existing ancestors. **A filesystem volume is not an authorization boundary**: being on the system volume, another local volume, or outside an Agent-linked project does not by itself allow or deny interception. An absolute path supplied only in the task receives the same handling when the current permission mode already permits access. Volume topology selects only the internal transfer algorithm: a same-volume target uses a no-replace atomic rename, while a cross-volume target uses a central app-data payload, a verified candidate, and a short-lived hidden claim next to the source. Any failure blocks the original command; there is no permanent-delete fallback.

> **Key design**: Agent-facing tool return values remain opaque and use a fixed success observation such as `Deleted successfully.` They do not preserve the original command's stdout, prompt text, or exit-code semantics, and do not proactively expose the Trash Bin path, original path, or recovery information. This context design reduces secondary-cleanup behavior; it is not path access control. Another process running as the same user may still read app-data, the manifest, or logs through other local capabilities.

> **Isolation boundary**: Trash Bin movement is performed by host-side Rust code and is not naturally constrained by AppContainer. In Offline Isolated Mode, interception therefore permits only workdir, `{AppDataDir}/runtime`, `{AppDataDir}/skills`, `{AppDataDir}/deliverables`, and the user-level `~/.agent-browser/tmp/screenshots` root. Only when the actual backend is `AppContainerFilesystem` are currently existing, path-deduplicated read-write/default filesystem grants added as host-side delete roots; duplicate paths retain AppContainer's first-wins access level. A Restricted Token does not gain delete authority merely because grants are present, and read-only or nonexistent grants do not authorize deletion. External-path hits are blocked. Controlled Network follows Local Audit Mode's protected paths, custom protected paths, and Trash Bin rather than treating workdir as the file boundary.

### 5.1 Interception Timing

Trash Bin triggers after the command passes `validate_command_safety_with_workdir()` and before real OS execution:

```text
[validate_command_safety_with_workdir() -> Ok]   <- Rust hard block passed
         |
         v
[try_intercept_delete()]            <- Trash Bin soft-delete interception
   +-- Parse + boundary checks succeed
   |      +-- same volume -> no-replace atomic rename
   |      +-- cross volume -> central candidate/payload + verify + sibling hidden claim
   |                          -> Pending -> PayloadReady -> Claimed -> PayloadVerified -> Ready
   |      -> return opaque success only after the manifest reaches Ready
   +-- -WhatIf / already missing / zero-match glob -> consume safely; do not run the original delete
   +-- Recognized delete intent with incomplete semantics, or a safe-transfer failure
          -> fail closed; do not enter OS execution
```

Before generic script scanning, the shell performs a side-effect-free classification of PowerShell delete envelopes. Only static `-Command` deletes that are fully modeled by Trash Bin, explicitly use `-NoProfile`, and contain no dynamic control flow or unknown executable prefix skip the inline-script delete block and are deferred to `try_intercept_delete()`; this classification does not move files. Target resolution, protected paths, sandbox allowed roots, and transfer validation still run inside Trash Bin. Script files, `.NET Delete()`, `iex`, missing `-NoProfile`, and other unmodeled forms continue to fail closed in the script scanner or Trash Bin, so the original PowerShell command does not gain an execution path.

In `restricted` mode, the "parse success" branch above must also satisfy that the target path belongs to allowed roots; otherwise the host-side move is not performed. In Local Audit and other modes that do not make workdir the sole filesystem boundary, an absolute path outside a linked project is not additionally rejected by Trash Bin merely because of its drive letter or project-link status, provided existing permission, protected-path, and target-semantics checks pass.

### 5.2 Supported Command Formats

| Command format                            | Example                                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `del filepath`                            | `del /f /q C:\project\old.log`                                                                                                                                                |
| `erase filepath`                          | `erase temp.txt`                                                                                                                                                              |
| `rmdir /s /q dirpath`                     | `rmdir /s /q dist`                                                                                                                                                            |
| `rd /s /q dirpath`                        | `rd /s /q .build`                                                                                                                                                             |
| PowerShell `Remove-Item`                  | `powershell -NoProfile -Command "Remove-Item -LiteralPath 'path' -Force"`                                                                                                     |
| PowerShell aliases `ri` / `rm`            | `powershell -NoProfile -Command "ri -LiteralPath 'path' -Force"`                                                                                                              |
| Nested `cmd /D /C "del ..."`              | `cmd /D /C "del /f /q file.txt"`                                                                                                                                              |
| Piped delete                              | `powershell -NoProfile -Command "Get-ChildItem -Force *.log \| Remove-Item -Force"`                                                                                           |
| Simple `*` / `?` glob                     | `del C:\project\*.webp` (expanded from Rust glob results and moved one by one)                                                                                                |
| PowerShell environment-variable wildcard  | `powershell -NoProfile -Command "Remove-Item -Path $env:APPDATA\com.agentvis.app\deliverables\Team\Agent\* -Recurse -Force"`                                                  |
| PowerShell variable wildcard              | `powershell -NoProfile -Command "$target='C:\project'; Remove-Item -Path $target\* -Recurse -Force"`                                                                          |
| Strictly allowlisted `Get-ChildItem` loop | `powershell -NoProfile -Command "$target='C:\project'; Get-ChildItem -LiteralPath $target -Force \| ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }"` |

The parser treats PowerShell as executable script only inside an explicit `powershell` / `pwsh -Command` wrapper and distinguishes code from strings and comments. Every intercepted static PowerShell delete must include `-NoProfile`, and its launcher may not change the working directory with `-WorkingDirectory` / `-wd`; otherwise it fails closed before spawn so profiles, aliases, providers, or relative-path bases cannot change the effective target. `-WhatIf` simulates without moving, while `-WhatIf:$false` is treated as deletion. `-Recurse:$false` does not become recursive, and wildcards in `-LiteralPath` are never expanded. Target expressions are limited to modeled literals, exact ordinary variables, or allowlisted environment variables. Tilde paths, string composition, compound assignment, method/reflection calls, module-qualified delete commands, and unmodeled parenthesized expressions are blocked.

Before a delete statement, only statically determined ordinary-variable assignments and strictly modeled direct `Get-ChildItem` pipelines / `ForEach-Object` enumeration are accepted. Unknown commands, control flow, invocation operators, backtick obfuscation, and dynamic execution prefixes fail closed. Environment expansion is limited to `WORKDIR`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `HOME`, `TEMP`, and `TMP`. Values follow the child process's real precedence: inherited process environment, resolved default `WORKDIR`, the current exec `env`, then restricted-mode sandbox-profile overrides. Windows environment keys are canonicalized case-insensitively before injection, and resolved workdir is injected even when `WORKDIR` was not supplied. If prior script text mutates `$env:*` through assignment, Env-provider cmdlets/aliases, or `.SetEnvironmentVariable()`, the parser fails closed rather than guessing the new value. `Where-Object`, conditions, `-Filter` / `-Include` / `-Exclude`, and other forms whose semantics cannot be preserved are blocked; intercepted `Get-ChildItem` also requires explicit `-Force`. Common dynamic forms such as `iex` / `Invoke-Expression`, invocation operators, `Start-Process`, nested PowerShell, and `ScriptBlock.Create(...).Invoke()` are blocked as delete intent. Arbitrary runtime composition remains a static-recognition boundary.

The actual outer Windows shell is always `cmd /D /S /C`, disabling Command Processor AutoRun. An Agent-supplied nested `cmd /C` / `/K` delete must also contain `/D` or it is blocked. Combined switches, full `cmd.exe` paths, `%ComSpec%`, double quotes, and multiple targets are parsed; single quotes remain literal CMD filename characters. Compact builtins such as `del/f/q`, `erase/f/q`, `rd/s/q`, and `rmdir/s/q` are intercepted. Leading or attached redirection and `call` / `if` / `start` wrappers whose semantics cannot be preserved are conservatively blocked. `del` / `erase` accept only `/f` and `/q`; `/a`, `/p`, `/s`, or unknown flags fail closed. Their simple `*` / `?` globs intercept files only, and read-only Windows files require `/f`. Recursive `**` and `[]` extended globs are not intercepted. A command may enumerate at most 256 targets and checks a two-second cooperative deadline during iterator output and later preflight. An observed budget overrun fails before the first move, but a single blocked directory/network-filesystem I/O cannot be preempted, so this is not a hard wall-clock timeout. `rmdir` / `rd` accept only `/s`, `/q`, and one non-glob directory target; a nonempty directory requires `/s`. Direct PowerShell deletion of a nonempty directory requires `-Recurse`, and Windows read-only files require `-Force`.

Multi-target commands complete parsing, glob enumeration, protected/reserved-path, allowed-root, object-type, ancestor/descendant overlap, and recursion preflight before the first transfer, but a whole batch is not a rollback transaction. The batch writes all `Pending` records under one manifest lock, selects a same-volume rename or a cross-volume transaction for each target, and persists each item's phase. A same-volume item has one atomic no-replace rename. A cross-volume item follows `Pending -> PayloadReady -> Claimed -> PayloadVerified -> Ready`: it first copies into a central candidate and verifies content, then atomically renames the source into a random hidden claim under the same parent. Only after the claim still matches the candidate (or the candidate has been rebuilt from the claim) is the candidate atomically published as payload. Claim and final payload are compared again, and `PayloadVerified` is persisted before recursive claim cleanup starts. That durable boundary lets reconciliation continue an interrupted, partially completed claim cleanup without incorrectly requiring the remaining claim to equal the complete payload. If another process recreates the original path after claiming, reconciliation never treats that new object as the claim. A preparation failure stops before the first destructive step. If a later item fails, earlier completed items are not rolled back, but the original delete command is still never executed.

The first cross-volume release handles only ordinary files and directories that can be enumerated and verified without following links. If the target itself or recursive content contains a symbolic link, junction, or another reparse point, the transaction fails closed before following it and leaves the source in place; it never turns link-target content into an ordinary payload through recursive copying. Same-volume handling may still atomically rename a leaf object only when target revalidation proves that doing so requires no traversal through the link target.

If command text already reveals deletion/cleanup intent but the parser cannot reconstruct its semantics safely, the system **fails closed**. Covered examples include multi-level pipelines, unresolved variables, PowerShell .NET `Delete()`, inline Python/Node deletion, `rimraf`, `robocopy /purge`, non-dry-run `git clean`, and `git rm` that removes worktree content. Direct, chained, `call` / `start` / conditional, common package-manager exec/dlx/corepack, `cmd /c`, and dynamic PowerShell wrappers around `rimraf`, including version specifications, are detected. `git clean -n` / `--dry-run` only previews and `git rm --cached` only changes the index, so those are not intercepted as file deletion. Read-only references such as `pnpm list rimraf` or `yarn why rimraf` are not misclassified solely for mentioning the package. A recognized target that is already missing, or a glob with zero matches, is consumed as idempotent success and never falls through to the original command after the check.

### 5.3 Opaque Success Feedback (Preventing Secondary Cleanup)

After successful interception, the exec tool return content does not expose the Trash Bin path and does not say that the file was moved into a recoverable directory:

```text
Deleted successfully.
```

This message enters the SA tool-call result directly. Its purpose is not to explain soft-delete details to the Agent, but to let the Agent treat the current deletion task as complete, avoiding continued searches for `Agent_Trash_Bin` and secondary deletion of Trash Bin copies.

Complete recovery information is still stored in `trash_manifest.json` and internal logs for display to users through the "Settings -> File Protection" Agent Trash UI; by default, the Agent should not receive these paths.

When a blocked error contains an internal structured reason, the TS exec layer replaces the original error, which may contain internal paths and implementation details, with a short i18n Agent observation. Internally, precise `recoverable_delete_*` and `script_scan_*` reasons remain available for audit and diagnostics, while Agent-facing labels deliberately omit Trash Bin, soft-delete, cross-volume, and scanning terminology:

- `[recoverable_delete_required]` -> `[DELETE_RETRY_REQUIRED]`: says deletion did not complete and permits one retry with one direct command and an explicit literal path: `del /f /q "..."`, `rmdir /s /q "..."`, or `powershell -NoProfile -Command "Remove-Item -LiteralPath '...' -Force"`; after another failure, stop and report.
- `[recoverable_delete_unavailable]` -> `[DELETE_UNAVAILABLE]`: says deletion did not complete, requires the Agent to leave the target in place, **not use another command, script, or tool to delete it**, and report that the operation was not completed; it does not expose the storage or transfer failure.
- `[recoverable_delete_cross_volume]` -> `[DELETE_UNAVAILABLE]`: retained only as an observation compatibility mapping for errors from older backends. Cross-volume topology is no longer a blocking reason in the new implementation and is not exposed to the Agent.
- `[script_scan_unreadable]` -> `[EXECUTION_INPUT_UNREADABLE]`: asks for an existing, readable entry script and working directory before one retry.
- `[script_scan_too_large]` -> `[EXECUTION_INPUT_TOO_LARGE]`: says the script exceeds the 8 MiB execution-input limit or kept growing while being read, then asks for it to be split or reduced.
- `[script_scan_ambiguous_launcher]` -> `[EXECUTION_ENTRY_AMBIGUOUS]`: says the local entrypoint that the current command or script will launch cannot be determined reliably, then asks for an explicit local entrypoint with a supported extension and an exec workdir.
- `[script_scan_depth_exceeded]` -> `[EXECUTION_CHAIN_TOO_DEEP]`: says the script call chain exceeds eight levels and asks for it to be flattened or split.
- `[script_scan_unavailable]` -> `[EXECUTION_INPUT_UNAVAILABLE]`: remains a compatibility fallback for older errors and provides only general existing/readable/split/reduce execution guidance.

Other protected-path or general validation failures without one of these reasons continue through the existing generic redaction path and are not covered by these structured-reason replacements. The Agent observation describes only the operation state, supported remediation, and stopping condition; it does not explain the underlying guard or suggest that an inspection layer exists to bypass.

This design does not add a brokered-delete tool or ask the Agent to learn a second deletion interface. It keeps normal `exec` behavior and injects a small recovery instruction only after a block.

### 5.4 Trash Bin Storage Structure

```text
{app_data_dir}/
+-- Agent_Trash_Bin/
    +-- trash_manifest.lock              # Dedicated sidecar exclusive lock
    +-- trash_manifest.json              # Delete-record index
    +-- items/
        +-- <UUIDv4>/
            +-- candidate                # Temporary cross-volume copy under verification
            +-- payload                  # Committed recoverable ordinary file/directory content
```

Every new entry uses a full UUIDv4 `storage_id`. Candidate and payload paths are derived only from the trusted Trash root and `storage_id`, never from a manifest `trashPath` that could be tampered with. After canonicalization the root must remain below app-data and may not itself be a symlink, junction/reparse point, or non-directory. Payload-parent boundaries are revalidated before restore, permanent cleanup, and explicit expiration cleanup. Deletes intercepted by the current Trash Bin cannot target the Trash root, manifest, payloads, `protected_paths.json`, or an ancestor containing them; maintenance must go through user UI / dedicated Tauri commands. Unknown native programs, unrecognized in-process deletes, and other write/rename paths are not absolutely covered by this target guard.

A cross-volume transaction creates only a short-lived random hidden claim under the source object's parent; it does not create a permanent Trash root on each volume:

```text
<source-parent>/
+-- .agentvis-trash-claim-<UUID> # Renamed original file or directory; exists only briefly
```

The delete transaction stores only the UUID `storage_id` and state; it never accepts an arbitrary external `claimPath`. The claim is strictly derived from the original parent, a reserved prefix, and that UUID. User restore separately records a restore UUID, owner token, and `Preparing` / `Committed` phase, while staging paths are still derived only from the trusted prefix and UUID. Reconciliation treats the exact claim path as this transaction's claim only when state is already `Claimed` / `PayloadVerified`, or when state is `PayloadReady` and the original path has disappeared. A same-name item encountered while `PayloadReady` still has its source is a collision and is neither adopted nor cleaned. `PayloadVerified` is accepted only after the published payload and complete claim matched and that fact was atomically persisted; it authorizes idempotent cleanup of a claim that may already be partial after a crash. Direct deletion of a reserved transaction path or its descendants, and deletion of an ancestor containing an active claim or restore staging wrapper, are blocked. Neither claim nor restore wrapper is a permanent user data directory. Crash handling conservatively preserves a valid copy among source, claim, central payload, and a verified restored destination.

New `trash_manifest.json` entries use a timestamp plus full UUID for `id` and a full UUIDv4 for `storage_id`, together with original path, deletion time, triggering command, batch, object type, and state. Reads are capped at 32 MiB and validate JSON, nonempty unique IDs, canonical and separately unique storage/restore/owner UUIDs, timestamps, and valid state combinations. A missing, zero-byte, or whitespace-only manifest is empty; a nonempty damaged or duplicate manifest fails closed. Concurrent mutation uses a sidecar lock with a two-second contention limit per acquisition. Writes use a same-directory temporary file, flush/sync, and atomic replacement so locking an old manifest inode cannot be bypassed by rename.

Same-volume soft deletion can move directly from `Pending` through a no-replace rename to `Ready`. Cross-volume soft deletion uses `Pending -> PayloadReady -> Claimed -> PayloadVerified -> Ready`. `PayloadReady` means the app-data candidate completed a no-follow copy and per-item content verification while the source remains in place; the final payload has not been published. `Claimed` means the source object was atomically renamed on its own volume into the short-lived hidden claim. After claim and candidate match, the candidate is atomically published as payload inside app data. Claim and final payload are then compared byte-for-byte again; while they still match, `PayloadVerified` is persisted before claim cleanup starts. `PayloadVerified` proves that the central payload was complete and independently recoverable at that boundary, so recursive claim cleanup can resume after a crash even when the remaining claim is only a subset. Payload existence alone is not sufficient proof before this state: a name collision, external replacement, or post-publication change keeps the claim as recovery evidence. No failure path falls back to the original delete command, and reconciliation never cleans source or claim before content verification has been durably recorded. Normal listing, user restore, and expiration cleanup process only `Ready`; other states remain crash-recovery evidence.

To keep state and manifest evidence consistent, the current implementation may still hold the global sidecar manifest lock for a long time while copying and verifying a cross-volume directory. Large trees or slow volumes can serialize other delete, list, restore, and cleanup operations and cause waiting calls to hit lock timeouts. This is an explicit performance debt. A future design should use per-entry journals/leases and short manifest commits rather than weakening the persisted `PayloadReady` / `Claimed` / `PayloadVerified` boundaries.

### 5.5 User Recovery and Manual Cleanup

The **Agent Trash** area under "Settings -> File Protection" reads the manifest and exposes user-side recovery and cleanup actions:

- **Select Trash entries**: users select one or more entries and then run "Restore Selected" or "Clean Selected".
- **Batch selection**: when one delete command creates multiple entries, the row-level "Batch" button only adds the same batch to the selection. It does not directly restore or clean.
- **Restore Selected**: handles only `Ready` records. Before transfer, it persists a random restore UUID, an independent owner token, and `Preparing` in the entry's restore journal. If payload and original path share a volume, it uses a no-replace atomic rename. Across volumes, it atomically creates a reconstructable `.agentvis-trash-restore-<UUID>` staging wrapper under the target parent, writes an ownership marker matching the journal token, and copies the payload without following links inside that wrapper. After verification, the staged payload is committed to the original path with a no-replace rename, then the restored destination is compared with the central payload again. Only after they match is `Committed` persisted; owned staging and central-payload cleanup start afterward. Reconciliation may clean only a wrapper whose marker matches; a pre-existing same-name user path is never adopted or deleted. Cleanup can resume idempotently from `Committed` without requiring a partially removed central directory to keep matching the complete destination. If the process exits during copy, commit, or cleanup, later reconciliation removes owned uncommitted staging, retries central-payload cleanup, or retains both copies and the journal when they differ before commit. A restored destination with a not-yet-removed manifest therefore does not become a permanent ordinary `original_exists` conflict. If the original path exists, copying or verification fails, the first release does not support the link/reparse type, or the final rename fails, the central payload and manifest record remain; an existing target is never overwritten or merged. The same path also restores legacy payloads stored directly under the older app-data Trash root.
- **Clean Selected**: handles only `Ready` records and permanently deletes the payload path derived from `storage_id` after revalidation. Failed deletes remain in the manifest. The first cross-volume implementation never creates link/reparse payloads. Restore of a historical link-like payload does not follow its target; if the object cannot be reconstructed safely, the record remains and a conflict is reported.

A long-running restore or cleanup is not cancelled when the user closes Settings. The frontend keeps the active operation in lifecycle-independent global state, renders a read-only “continues in the background” state after Settings is reopened, and invalidates the old list with an incrementing revision on either success or failure before automatically reloading it. The list IPC maps manifest-lock timeout to structured `busy`; the UI retries according to `retryAfterMs` without showing a load-failure toast. Trash path and protected paths load independently, so a temporarily busy list cannot clear them. The empty state is rendered only for a real zero-entry `ready` response that matches the latest operation revision; `idle`, `loading`, `busy`, `error`, and active-operation states never masquerade as an empty Trash.

`Pending` / `PayloadReady` / `Claimed` / `PayloadVerified` and other non-`Ready` delete states are hidden from normal listing and cannot be restored, manually cleaned, or expired by users. A `Ready` entry with an active restore journal also cannot be manually or automatically cleaned; only conservative fault reconciliation converges it. These actions are user-facing and do not require the Agent to execute recovery commands, so internal Trash Bin paths remain hidden from the Agent. Permanent cleanup in Settings uses the app's controlled confirmation dialog: clicking Clean Selected only freezes the requested IDs and opens the confirmation UI, and only the confirmation callback invokes the backend. Cancelling, dismissing the dialog, or closing Settings does not start cleanup.

### 5.6 User-Initiated Deletion and the Windows Recycle Bin

Deletions performed on files in the right-hand workspace file list are classified as **user-initiated actions**. These operations are not recorded in the Agent Trash Bin, nor do they generate Agent deletion audit logs. This design ensures that the Agent Trash Bin exclusively displays deletions initiated by the Agent, facilitating user verification of potential accidental deletions by the Agent.

Upon user confirmation, the frontend invokes the standalone `file_move_to_system_trash` command. The backend does not trust the workspace root directory provided by the frontend. Instead, it retrieves the external project path bound to the Agent from the database based on the `agentId`. If no project is bound, it derives the corresponding `deliverables/<hub>/<agent>` root directory from the Hub/Agent names stored in the database. The target path must satisfy the following conditions:

- It must be an absolute path, and its parent directory, after canonicalization, must remain within the Agent’s trusted workspace root directory;
- It must not be the workspace root directory itself;
- The target must currently exist and must not reside within the workspace import staging area owned by AgentVis;
- Symlinks at the leaf level are passed to the Windows Shell as link items. The operation does not enable `FOFX_NOSKIPJUNCTIONS` and does not actively traverse junctions.

On the Windows side, entries are moved to the system Recycle Bin using `IFileOperation` with the `FOFX_RECYCLEONDELETE` flag. Shell COM operations are executed on a dedicated STA (Single-Threaded Apartment) thread. Failures due to network shares, special file systems, file locks, or other scenarios unsupported by the Recycle Bin will result in an immediate error return, leaving the original file intact. The implementation **does not include a fallback to permanent deletion**.

### 5.7 Expiration Cleanup (Not Automatically Scheduled Today)

The backend exposes `startup_trash_cleanup` / `cleanup_expired_items` maintenance entrypoints. Only `Ready` records with valid timestamps and revalidated payload paths that are **at least 30 days old** are physically deleted. A record is removed only after successful deletion or confirmation that its payload is absent; path anomalies, inspection failures, and deletion failures retain both record and evidence. The Tauri command is registered but is not currently called from Rust setup or renderer startup, so application launch does not automatically perform 30-day physical cleanup. Entries remain until manual cleanup or a future explicit scheduler is wired.

### 5.8 Current Security Boundaries and Known Limitations

- **Volume is not an authorization boundary**: the system volume, another local volume, and project-link status do not by themselves determine whether an Agent delete can be intercepted. Protected paths, reserved internal paths, the active sandbox/allowed roots, and reconstructed delete semantics are the authorization boundary. An absolute path outside a linked project therefore receives the same Trash Bin behavior as a linked workspace when current permissions allow access. Volume topology selects same-volume rename or cross-volume copy/verify/claim transport. Network shares, read-only media, offline volumes, or filesystems without the required atomic operations may still return `[recoverable_delete_unavailable]`; that is a concrete storage-capability failure, not a default ban on non-app-data volumes. Legacy `[recoverable_delete_cross_volume]` is retained only for observation compatibility.
- **Cross-volume recovery preserves ordinary content, not a complete filesystem image**: the first release verifies ordinary-file primary data streams, directory hierarchy, and names, which covers routine source files, scripts, screenshots, and temporary artifacts. It does not promise complete preservation of ACL/owner data, NTFS alternate data streams, hard-link topology, sparse/compression attributes, extended attributes, or every timestamp. Symbolic links, junctions, and other reparse points are never followed; the first cross-volume delete and restore implementation preserves evidence and blocks instead of copying link-target content as ordinary data.
- **The global manifest lock remains a performance debt**: copying and verifying a large cross-volume file or tree may hold the global sidecar lock long enough to serialize or time out other delete, list, restore, and cleanup operations. Future work should narrow this to per-entry journals/leases and short atomic manifest commits. The current implementation must not skip persisted `PayloadReady` / `Claimed` / `PayloadVerified` boundaries merely to improve throughput.
- **Static recognition is not a complete semantic proof**: direct commands and known script APIs cover common Agent deletion behavior, but native executables, dynamic composition/reflection, runtime-downloaded code, and unknown interpreters may still delete inside their process in Local Audit Mode. Restricted Token / AppContainer must not be described as a generic "deny DELETE" mechanism; their actual ACLs and allowed roots may still permit deletion.
- **Package scripts are not recursively expanded**: direct, chained, `call` / `start` / conditional, common package-manager exec/dlx/corepack, `cmd /c`, and dynamic PowerShell wrappers that expose `rimraf` fail closed. `npm run clean`, other package lifecycle scripts, and cleanup inside build tools are not expanded through `package.json` or a runtime call graph. Their `rimraf` / `fs` side effects fall under the interpreter/native-process boundary above.
- **Same-user TOCTOU surfaces remain**: another same-privilege process may replace a script between scanning and interpreter open, replace a path or ancestor between canonicalization and rename, or continue writing through an already-open handle between cross-volume candidate verification, claim creation, claim revalidation, and claim removal. Whole-batch preflight, immediate pre-destructive-step revalidation, no-replace rename, post-claim content verification, no-follow link handling, and state reconciliation reduce but do not eliminate these windows. The implementation does not yet use handle-relative traversal, stable file identity, or a handle-bound transaction over the same object; it is not absolute isolation against a malicious same-user process.
- **Non-Windows restore power-loss durability remains limited**: restore uses no-replace rename, a restore journal, and best-effort parent-directory sync. Ordinary process crashes can be reconciled from `Preparing` / `Committed`, but sync errors are not yet promoted to transaction failure. An extreme power loss can still reorder rename, directory entries, and manifest durability. Cross-platform expansion should make sync results part of commit and add fault-injection tests. Windows uses write-through move semantics for this path.
- **The manifest is not a cryptographic ledger against same-user tampering**: size, structure, unique nonempty IDs, canonical and separately unique UUID storage/restore IDs, states, and derived payload/staging boundaries are validated, and writes are locked and atomic, but there is no signature/MAC. `original_path` is currently required only to be nonempty and cannot prove that it is the original deletion location. In Local Audit Mode, Agent exec or another same-user process with direct app-data write access may use an unrecognized delete/write/rename path to alter metadata and potentially redirect a later user restore's no-clobber destination. Restore refuses to overwrite an existing target, and payload-boundary validation constrains other effects.

The actual goal is therefore: common direct deletes are recoverable; recognized delete intent whose semantics cannot be reconstructed is stopped before spawn; and statically recognizable script deletion must be rewritten as a direct command. It is not a claim that every unknown command can be recognized or that arbitrary same-user code can never delete data.

---

## 6. TS/Rust Dual-Layer Design Notes

| Dimension              | TS layer (`ExecSafetyPolicy`)                      | Rust layer (`command_validator`)                                                    |
| ---------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Positioning**        | First line of defense, fast feedback               | Host-side entry enforcement; matched policies cannot be bypassed through TS         |
| **Matching method**    | Regex `\b` word boundaries, precise matching       | Conservative substring, token/subcommand, normalized-path, and static-script checks |
| **Block timing**       | At the SA tool-call layer, before Tauri IPC starts | At the Tauri command layer, before the command reaches the OS                       |
| **Blocklist coverage** | Mostly consistent with the Rust layer              | Adds icacls combination blocking and script-content scanning                        |
| **Allow capability**   | Has an allowlist and can skip Checkpoint           | No allowlist; only blocks and does not allow                                        |

---

## 7. Protection-Layer Collaboration Flow

```text
User request
    |
    v
[Master Brain decision]
  +-- behaviorHint: careful/direct
  +-- base tools auto-filled + special tools explicitly authorized
  +-- riskAssessment self-evaluation (currently not directly mapped to global riskDelta)
    |
    v
[LoopGovernor loop control]
  +-- circuit break on consecutive no-progress loops
  +-- tool thrashing detection
  +-- budget control + reserved risk-threshold slot
    |
    v
[Sub-Agent executes exec tool]
  |
  +--> isExecCommandBlocked()  -- true  --> TS layer absolute rejection
  |
  +--> isExecCommandSafe()     -- true  --> skip user authorization and MB high-risk Checkpoint
                               -- false --> unsafe exec path (Runner/authorization/Rust/sandbox continue constraining)
  |
  v
[Tauri IPC: shell_execute]
  |
  +--> validate_command_safety_with_workdir() -- Err --> Rust hard block
  +--> validate_script_content()              -- Err --> script-content scan block
  |
  v
[ShellSandboxPolicy]
  +--> static network scan          -- audit/block -> structured audit event
  +--> non-HTTP direct target       -- exact target + user authorization -> direct-audit
  +--> Job Object / Restricted Token / AppContainer
  +--> WFP helper kept as experimental diagnostic entrypoint
  |
  v
[try_intercept_delete()]            <- Trash Bin soft-delete interception
  +--> supported parse + final-target checks (volume is not authorization)
  |     +--> same volume: Pending -> no-replace rename -> Ready
  |     +--> cross volume: central candidate/payload + verify + sibling hidden claim
  |                         -> Pending -> PayloadReady -> Claimed -> PayloadVerified -> Ready
  |     -> return opaque success (Agent does not know Trash Bin path) -- no OS delete call
  +--> -WhatIf / missing target / zero-match glob -> consume safely -- no OS delete call
  +--> recognized delete intent with incomplete semantics, or a safe-transfer failure
        -> fail closed -- no OS delete call
  |
  v
OS executes only commands not consumed or blocked by the finite recognition set
```

`validate_path_write_safety()` protects native file write/import commands and is not part of the `shell_execute` call chain. Final shell-delete target protection is performed by target-level revalidation inside `try_intercept_delete()`. Unknown or dynamically generated in-process deletion that does not match the finite recognizers remains subject to permission, sandbox, and filesystem ACL boundaries rather than Trash Bin interception.

---

## 8. Security Design Notes

### Precise Matching vs Loose Matching

- **TS layer** uses `\b` word-boundary regex, ensuring `format` does not falsely hit Python `str.format()` and `wmic` does not falsely hit read-only queries.
- **Rust layer** combines conservative substring fallback with token/subcommand parsing, path normalization, and static script scanning. A matched rule fails closed, but an unknown native or dynamically generated operation is not thereby proven safe.
- **Separate handling for the `format` command**: it is separated from the blocklist and detected through `is_format_drive_command()` for the `format X:` drive-letter pattern, avoiding large numbers of false positives for programming-language format functions.

### Combination Blocking vs Blanket Blocking

- Tools such as `wmic`, `icacls` / `cacls`, and `Set-Acl` have legitimate read-only query scenarios and are not fully forbidden.
- They are blocked only when combined with **write-like subcommands** or **system core directories**, enabling precise control.

### Hot Cache Reload

Custom protected paths use a global `RwLock` cache keyed by the app-data root. After the first IO, cache hits are used. The UI calls `reload_custom_protected_paths()` for immediate refresh. Malformed, oversized, missing-after-load, or otherwise unreadable disk configuration does not replace the last valid cache; only a first load or a new process with no file initializes an empty configuration.

### Trash Bin Fail-Closed Strategy

For complex formats that look like delete/cleanup operations but cannot be safely resolved to target paths, such as nested multi-level pipelines, unresolved variables, script-level `.Delete()` calls, `git clean`, or `robocopy /purge`, Trash Bin fails closed instead of falling back to OS execution. The returned message asks the Agent to retry once with a supported direct literal-path delete command, making interception by soft delete more likely. Commands outside the finite recognition set continue through the remaining normal validation and sandbox path; this does not prove that they contain no runtime delete behavior.
