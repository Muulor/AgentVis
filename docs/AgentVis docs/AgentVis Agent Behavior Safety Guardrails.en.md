# AgentVis Agent Behavior Safety Guardrails

> Last updated: 2026-06-01
> Applicable version: AgentVis release build

---

## Overview

Agents can perform real side-effecting operations such as running Shell commands, reading and writing files, and searching the network. To prevent accidental Agent operations or malicious prompt hijacking, the system implements a **defense-in-depth** architecture distributed across five protection layers:

1. **LLM behavior soft-guardrail layer** (Prompt layer + FSM layer): guides and constrains Agent decision-making behavior.
2. **TypeScript tool interception layer**: performs fast interception and tiered handling before tool calls take effect.
3. **Rust command validation layer**: provides the final non-bypassable hard-blocking line before command execution.
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

| Termination condition | Priority | Description |
|---------|--------|------|
| `consecutive_no_progress` | 1 (highest) | Two consecutive loops with no substantive progress, preventing ineffective Agent spinning |
| `tool_thrashing_detected` | 2 | N consecutive calls to the same tool (default 3), preventing dead-loop oscillation |
| `over_delegation` | 3 | Sub-Agent dispatch count exceeds the budget limit (default synchronized with the MB decision budget of 8 rounds unless explicitly overridden) |
| `risk_exceeded` | 4 | Accumulated risk score exceeds the threshold (default 0.8; the main flow currently does not connect MB `riskAssessment`, so this is a reserved extension point) |
| `budget_exhausted` | 5 | MB decision round budget is exhausted (default 8 rounds; FSM stepping hard safety valve defaults to 48) |

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

| Tool | Risk level | Description |
|------|---------|------|
| `read` | low | Read-only operation with no side effects |
| `web_search` | low | Read-only operation with no side effects |
| `local_search` | low | Read-only operation with no side effects |
| `generate_image` | low | Writes only to the deliverables directory and is reversible |
| `file_write` | medium | Write operation with fast-apply snapshot fallback |
| `cron` | medium | Reversible scheduled-task management |
| `exec` | **high** | System command execution with possible irreversible side effects |
| `external_skill_execute` | **high** | Unified execution entry for external Script Skills; executes skill-package scripts |
| `im_send` | low | Unified tool for sending IM messages |

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

| Category | Examples |
|------|------|
| Disk / partition destruction | `diskpart`, `format C:`, `cipher /w` |
| System boot damage | `bcdedit` |
| User / service management | `net user`, `net stop`, `sc delete` |
| Registry damage | `reg delete`, `reg add HKLM` |
| Base64 obfuscation | `-EncodedCommand`, `-enc` |
| Persistent environment-variable modification | `setx /M`, `[Environment]::SetEnvironmentVariable` |
| Direct registry-path writes | `Session Manager\Environment` |
| ACL + system directories | `icacls/cacls/Set-Acl` combined with `system32/windows` |

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

The Rust layer is the system's **final line of defense**. It performs hard blocking before commands are actually executed by the operating system. Its design principle is "prefer false positives over missed detections." It uses `contains()` substring matching rather than regex word boundaries, ensuring dangerous commands cannot execute even if the TS layer is bypassed.

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

Built-in system-level immutable protected paths prevent commands from bypassing protection through environment-variable forms:

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

The system uses a global `RwLock<Option<Vec<String>>>` to cache custom paths. On first use, it loads from disk and caches the result. After users modify protected directories through the UI, `reload_custom_protected_paths()` refreshes the cache immediately without restarting the application.

Custom protected directories apply to both:

- **Destructive verb protection**: `del` / `rmdir` / `remove-item`, etc.
- **Write redirection protection**: `>` / `>>` / `Out-File` / `Set-Content` / `Copy-Item`, etc.

### 3.4 File Write Path Protection

`validate_path_write_safety()` is called by Tauri file write/import commands such as `file_write_to_path`. It uses path **prefix matching** (not substring matching) to protect custom directories and all their subpaths:

```rust
// Additional separator-boundary check to avoid matching "D:\\important_other" for "D:\\important".
if file_str.starts_with(&protected_normalized) {
    let after = &file_str[protected_normalized.len()..];
    if after.is_empty() || after.starts_with('\\') || after.starts_with('/') {
        return Err(AppError::Forbidden(...));
    }
}
```

### 3.5 Static Script Content Scanning

`validate_script_content()` is called before exec runs script files. It reads script source code and scans for dangerous APIs.

**Scannable file types**: `.ps1`, `.bat`, `.cmd`, `.py`, `.cs`, `.vbs`

**Forbidden script-content keywords (`SCRIPT_CONTENT_FORBIDDEN`)**:

| Keyword | Threat description |
|--------|---------|
| `setenvironmentvariable` | PowerShell/.NET persistent modification of system/user-level environment variables |
| `session manager\environment` | Directly writes system-level environment variables through a registry path |
| `diskpart`, `bcdedit` | Disk partition / boot configuration destruction |
| `cipher /w` | Irreversible disk wiping |
| `takeown`, `sfc /` | System permission breakthrough |
| `net user`, `sc delete` | User / service management |
| `reg delete`, `reg add hklm` | Registry damage |

Script path extraction supports multiple invocation patterns:

- `powershell -File script.ps1`
- `python script.py` / `python3 -u my_script.py`
- `csc.exe source.cs` (C# compiler; scans source code)
- Direct invocation: `./setup.bat`, `install.cmd`

---

## 4. Process / Network Sandbox and Security Audit

**File**: `src-tauri/src/commands/process_sandbox.rs`

Runtime sandbox policy is added to the Rust shell execution chain. Its role is to "reduce accidental operations and side effects from external scripts"; it does not replace command blocklists, script scanning, or Trash Bin. The product layer exposes only three user permission modes: **Local Audit Mode**, **Offline Isolated Mode**, and **Controlled Network Mode**. Internal enums remain `LocalAudit` / `OfflineIsolated` / `ControlledNetwork`, while backend `standard` / `externalSkill` / `installer` / `preview` / `restricted` remain technical profiles for audit attribution.

> Important boundary: Job Object is not a "sandbox switch"; it only manages the lifecycle cleanup of managed commands. GUI / detached launches in Local Audit Mode should not be attached to a Job Object with `KILL_ON_JOB_CLOSE`, to avoid accidentally killing external applications such as Chrome, VS Code, or explorer after launch.

### 4.1 Execution Profiles and Default Network Policies

| profile | Typical source | Default network policy | Description |
|---------|----------|--------------|------|
| `standard` | Normal `exec` | `inherit` | Does not change normal shell networking behavior |
| `externalSkill` | External Script Skill | `audit` | Does not block by default, but scan hits write audit events |
| `installer` | Skill installation / dependency installation | `inherit` | Allows dependency downloads during installation |
| `preview` | Local preview service | `inherit` | Avoids breaking frontend preview workflows |
| `restricted` | High-risk / strongly isolated execution | `blocked` | Enables stricter process and network constraints |

Relationship between the three user permission modes and backend mechanisms:

| UI mode | Backend mode | File boundary | Network boundary | Process lifecycle |
| --- | --- | --- | --- | --- |
| Local Audit Mode | `sandboxMode=LocalAudit` | Not restricted to workdir; uses protected paths and Trash Bin | Inherits system network | CLI uses managed lifecycle; GUI uses detached launch |
| Offline Isolated Mode | `sandboxMode=OfflineIsolated` | AppContainer / workdir scope | deny-all | Blocks detached launch and desktop control |
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
- AppContainer filesystem grants include not only workdir but also in-app runtime / skills roots for embedded Python, external Skills, and sandbox profiles. `brokerOnly` file-based IPC publishes requests in the runtime directory through temporary-file rename, so ReadWrite grants must support create/write/rename/delete.
- Script Skills can use `execution.permissions.filesystem` to add AppContainer grants for user-provided files or directories. Grants may only reference string parameters in `argsSchema` and must declare `readOnly` or `readWrite`; this prevents controlled-network no-network paths from misclassifying valid local-file tasks as lacking permission.
- Offline Isolated processes redirect `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, temp directories, and `XDG_*` into `{AppDataDir}/runtime/sandbox-profile/*`, preventing scripts from writing tokens/caches to the real user home directory. The target shape of Controlled Network no longer redirects these directories, so existing user CLI / Skill credential caches can be reused.
- Native file tools (`read` / `file_write` / `local_search`) use `sandboxFilesystemScope` from tool context to decide file boundaries: Offline Isolated is fixed to `workspace`, while the Controlled Network target shape is `local`, avoiding a split where `exec` can access local files but native tools are forced back to the workspace.
- The `exec` preflight blocks for "global install / login flows" and runtime hints such as "command not found / credentials missing may be caused by sandbox environment differences" are only used for Offline Isolated. Controlled Network no longer explains such failures as workspace file-sandbox issues, avoiding misleading the Agent into repeatedly asking to switch to Local Audit Mode.
- Trash Bin delete interception happens inside the Tauri main process. Under Offline Isolated, it must first validate that the delete target is inside workdir or application-managed roots, so host-side soft delete cannot bypass AppContainer file boundaries. The Controlled Network target shape follows Local Audit Mode's protected paths, custom protected paths, and Trash Bin.
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
  backend: 'none' | 'jobObject' | 'restrictedToken' | 'appContainer' | 'mainProcess' | 'broker' | 'wfpEnhanced';
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

Agent Trash Bin is a **recoverable soft-delete layer** for file deletion operations. When an Agent runs delete commands such as `del`, `rmdir`, or `Remove-Item`, the Rust backend intercepts the command before calling the OS and **moves the target file/directory into the `Agent_Trash_Bin` directory** instead of actually destroying it.

> **Key design**: Agent-facing tool return values remain opaque and only return a success message semantically consistent with the original delete command, such as `Deleted successfully.` The real Trash Bin path, original path, and recovery information are written only to the manifest / logs / later user UI. This prevents the Agent from seeing the Trash Bin location, chasing it, and deleting it a second time.

> **Isolation boundary**: Trash Bin movement is performed by host-side Rust code and is not naturally constrained by AppContainer. Therefore, in Offline Isolated Mode, delete interception must include allowed-roots validation and only move targets inside authorized root directories such as workdir, `{AppDataDir}/runtime`, and `{AppDataDir}/skills`; an external-path hit returns a sandbox block directly. The Controlled Network target shape follows Local Audit Mode's protected paths, custom protected paths, and Trash Bin, without using workdir as the file boundary.

### 5.1 Interception Timing

Trash Bin triggers after the command passes `validate_command_safety_with_workdir()` and before real OS execution:

```text
[validate_command_safety_with_workdir() -> Ok]   <- Rust hard block passed
         |
         v
[try_intercept_delete()]            <- Trash Bin soft-delete interception
   +-- Parse success -> move to Trash Bin -> return opaque success message to Agent
   +-- Parse failure (complex command) -> fall back and continue normal OS execution
```

In `restricted` mode, the "parse success" branch above must also satisfy that the target path belongs to allowed roots; otherwise the host-side move is not performed.

### 5.2 Supported Command Formats

| Command format | Example |
|---------|------|
| `del filepath` | `del /f /q C:\project\old.log` |
| `erase filepath` | `erase temp.txt` |
| `rmdir /s /q dirpath` | `rmdir /s /q dist` |
| `rd /s /q dirpath` | `rd /s /q .build` |
| PowerShell `Remove-Item` | `powershell -Command "Remove-Item 'path' -Force"` |
| PowerShell aliases `ri` / `rm` | `powershell -Command "ri 'path'"` |
| Nested `cmd /c "del ..."` | `cmd /c "del file.txt"` |
| Piped delete | `Get-ChildItem *.log \| Remove-Item` |
| Wildcard glob | `del C:\project\*.webp` (expanded and moved one by one) |

For complex commands that cannot be parsed, such as multi-level pipeline chains and compound conditional statements, the system falls back to the normal execution flow and does not intercept.

### 5.3 Opaque Success Feedback (Preventing Secondary Cleanup)

After successful interception, the exec tool return content does not expose the Trash Bin path and does not say that the file was moved into a recoverable directory:

```text
Deleted successfully.
```

This message enters the SA tool-call result directly. Its purpose is not to explain soft-delete details to the Agent, but to let the Agent treat the current deletion task as complete, avoiding continued searches for `Agent_Trash_Bin` and secondary deletion of Trash Bin copies.

Complete recovery information is still stored in `trash_manifest.json` and internal logs for display to users or later security UI; by default, the Agent should not receive these paths.

### 5.4 Trash Bin Storage Structure

```text
{app_data_dir}/
+-- Agent_Trash_Bin/
    +-- trash_manifest.json              # Delete-record index (file exclusive lock ensures concurrency safety)
    +-- 20260407_224512_C_proj_old.log   # Intercepted file (timestamp_encoded-path naming)
    +-- ...
```

**manifest.json** records complete metadata for each deletion: original path, Trash Bin path, deletion time, triggering command, and whether the target was a directory.

### 5.5 Automatic Expiration Cleanup

On application startup, the manifest is scanned automatically. Entries **older than 30 days** are physically deleted and removed from the manifest. Files accidentally deleted in the short term can be recovered during this period by manually moving them back to their original paths.

---

## 6. TS/Rust Dual-Layer Design Notes

| Dimension | TS layer (`ExecSafetyPolicy`) | Rust layer (`command_validator`) |
|---------|-----|------|
| **Positioning** | First line of defense, fast feedback | Final line of defense, non-bypassable |
| **Matching method** | Regex `\b` word boundaries, precise matching | `contains()` substring matching; prefer false positives over missed detections |
| **Block timing** | At the SA tool-call layer, before Tauri IPC starts | At the Tauri command layer, before the command reaches the OS |
| **Blocklist coverage** | Mostly consistent with the Rust layer | Adds icacls combination blocking and script-content scanning |
| **Allow capability** | Has an allowlist and can skip Checkpoint | No allowlist; only blocks and does not allow |

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
  +--> validate_path_write_safety()           -- Err --> path write protection block
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
  +--> parse success (del/rmdir/Remove-Item...)
  |     -> move to Agent_Trash_Bin
  |     -> return opaque success message (Agent does not know Trash Bin path) -- no OS del call
  +--> parse failure (complex format) -> fall back and continue
  |
  v
OS executes command
```

---

## 8. Security Design Notes

### Precise Matching vs Loose Matching

- **TS layer** uses `\b` word-boundary regex, ensuring `format` does not falsely hit Python `str.format()` and `wmic` does not falsely hit read-only queries.
- **Rust layer** uses `contains()` substring matching to provide extra fallback coverage, preferring a small number of false positives over missing dangerous commands.
- **Separate handling for the `format` command**: it is separated from the blocklist and detected through `is_format_drive_command()` for the `format X:` drive-letter pattern, avoiding large numbers of false positives for programming-language format functions.

### Combination Blocking vs Blanket Blocking

- Tools such as `wmic`, `icacls` / `cacls`, and `Set-Acl` have legitimate read-only query scenarios and are not fully forbidden.
- They are blocked only when combined with **write-like subcommands** or **system core directories**, enabling precise control.

### Hot Cache Reload

Custom protected paths are globally cached through `RwLock`. After the first IO, cache hits are used. When the UI updates protected directories, `reload_custom_protected_paths()` refreshes immediately, balancing performance and realtime behavior.

### Trash Bin Fallback Strategy

For complex formats that the command parser cannot recognize, such as nested multi-level pipelines and script fragments with conditional checks, Trash Bin falls back instead of blocking and lets the command continue into OS execution. This avoids breaking the Agent's normal workflow while preserving the reliability of the fallback mechanism. Fallback scenarios are usually cases where the Agent is running more complex scripts, and the `validate_script_content()` script-content scanning layer still applies.
