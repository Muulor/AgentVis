# AgentVis Sandbox Mechanism Feature Documentation

> Naming note: “Task mode” in the UI maps to the internal mode value and path `planning`; existing code identifiers remain unchanged.

## 1. Document Scope

This is the main document for the AgentVis sandbox mechanism. It describes the currently supportable product boundaries, backend mapping, execution chain, audit model, and refactoring notes.

Maintenance principles:

- This document is the primary synchronization document for the sandbox mechanism. Roadmaps, spikes, acceptance checklists, and similar documents keep historical plans and validation process details.
- When later changes touch sandbox modes, network egress, file boundaries, audit fields, user authorization dialogs, or Skill permission declarations, update this document first.
- This document only describes capabilities that have landed or are explicitly behind experimental switches. Targets still in migration are marked as "target shape" or "not currently promised."

Related documents:

- `docs/AgentVis docs/AgentVis Agent Behavior Safety Guardrails.en.md`
- `docs/AgentVis docs/Skill Feature Technical Documentation.en.md`
- `docs/AgentVis docs/AgentVis ControlledNetwork 回归矩阵.md`

## 2. Core Goals and Non-Goals

The sandbox mechanism is not meant to turn AgentVis into a general-purpose virtual machine or transparent network gateway. Its purpose is to provide explainable, auditable, and recoverable security boundaries when Agents automatically execute commands, run Skills, access files, and use the network.

Core goals:

- Use a three-level permission model that users can understand, covering local operations, offline isolation, and controlled networking.
- Build continuous protection across the TS tool layer, Rust command layer, process sandbox layer, network broker/direct-audit layer, and Trash Bin layer.
- Preemptively intercept or audit dangerous commands, system protected paths, dangerous script APIs, proxy-bypass network signals, desktop control, and detached GUI launches.
- Provide exact targets, user confirmation, current-run or current-session scope, backend exact matching, and audit records for necessary non-HTTP(S) direct connections.
- Make security failures as actionable as possible: tell users whether the failure came from a path boundary, network egress, desktop capability, or runtime difference.

Current non-goals:

- Controlled Network Mode does not currently promise that ordinary `exec` / Guide Skills have complete broker-only network egress.
- Transparent proxying, TUN, full TCP interception, generic SOCKS/TCP broker, and per-protocol broker are not enabled by default.
- WFP remains an advanced / experimental enhancement entrypoint and is not part of the default promise of the normal three-mode UI.
- Controlled Network Mode is not a workspace file-isolation mode; by default, it reuses local file space and existing CLI / Skill credential caches.
- direct-audit is not a network content proxy. It does not parse or rewrite protocol content; it only authorizes and audits exact-target direct connections.

## 3. Terminology

| Term | Meaning |
| --- | --- |
| Local Audit Mode | `sandboxMode=LocalAudit`. The default mode. It operates on the local machine like an assistant, but is still constrained by command blocklists, protected paths, script scanning, Trash Bin, and audit. |
| Offline Isolated Mode | `sandboxMode=OfflineIsolated`. A mode with strong file boundaries and hard no-network behavior, aimed at untrusted scripts, third-party Skills, and high-risk tasks. |
| Controlled Network Mode | `sandboxMode=ControlledNetwork`. Uses local file space by default; HTTP(S) preferentially goes through broker/proxy audit, while non-HTTP(S) uses direct-audit authorization. |
| technical profile | Backend internal profiles: `standard`, `externalSkill`, `installer`, `preview`, `restricted`. Used for default network policy and audit attribution, not directly exposed to users. |
| process lifecycle | Process lifecycle: `managed`, `backgroundManaged`, `detachedLaunch`. Job Object only handles managed process-tree cleanup and is not equivalent to a sandbox. |
| broker-proxy-preferred | The current main HTTP(S) path for ordinary `exec` / Guide Skills in Controlled Network: injects a per-run proxy environment and audits, but does not claim full broker-only until OS-level direct-connection blocking is complete. |
| brokerOnly | Explicit network mode in the Script Skill Contract. Direct connections fail closed; scripts must delegate HTTP(S) requests through `agentvis-broker-fetch` or the main-process broker. |
| credentialRef | A lightweight credential reference for Script `brokerOnly`. The script only requests the reference name; the main-process broker reads the real secret from Credential Manager and adds the request header according to the declared host allowlist. |
| direct-audit | Exact-target direct-connection authorization closure for non-HTTP(S) protocols. It requires `protocol + host + port + subject`, and the backend must exact-match on retry. |

## 4. Overall Architecture

```mermaid
flowchart TD
  A["Agent Settings: sandboxMode"] --> B["Task mode (internal: planning) / ToolExecutionContext"]
  B --> C["TS tool layer: read / file_write / exec / external_skill_execute"]
  C --> D["TS pre-flight protection: path boundary, ExecSafetyPolicy, direct-audit UI"]
  D --> E["Tauri shell_execute / native IPC"]
  E --> F["Rust command validation: command_validator + script scan"]
  F --> G["ShellSandboxPolicy: mode / lifecycle / network scope / subject"]
  G --> H["Process constraints: Job Object / AppContainer / profile env"]
  G --> I["Network constraints: broker proxy / broker helper / direct-audit / WFP experiment"]
  G --> J["Audit: SandboxAuditEvent"]
  E --> K["Trash Bin / protected paths / soft delete"]
```

The execution chain is layered so that later layers are harder:

1. LLM / Agent soft constraints: prompts, Checkpoints, LoopGovernor, and human intervention reduce the probability of accidental operations.
2. TS tool layer: risk levels, `ExecSafetyPolicy`, native file-tool path boundaries, and direct-audit dialogs.
3. Rust command validation layer: dangerous commands, protected paths, write redirection, and script-content scanning, serving as the final command line of defense.
4. Process / network sandbox layer: injects runtime constraints, Job Object, AppContainer, broker/proxy, direct-audit, and WFP experimental diagnostics according to `ShellSandboxPolicy`.
5. Trash Bin layer: performs host-side soft delete for interceptable delete commands and mirrors file boundaries under isolated modes.
6. Audit layer: records security decisions through `SandboxAuditEvent` for Settings, security diagnostics, and later UI recovery entrypoints.

## 5. Three User Permission Modes

| UI mode | Backend mode | File boundary | Network boundary | GUI / desktop capability | Typical use |
| --- | --- | --- | --- | --- | --- |
| Local Audit Mode | `LocalAudit` | Not restricted to workdir; keeps protected paths, custom protected directories, and Trash Bin | Inherits system network | Allows GUI / detached launch; desktop control can run | Default Agent work, browser use, and local automation |
| Offline Isolated Mode | `OfflineIsolated` | AppContainer / workdir scope; application-managed runtime / skills roots are additionally granted | deny-all; script network commands and APIs hard-block | Blocks detached launch, desktop control, screenshots, hotkeys, and window activation | Untrusted scripts, third-party Skills, high-risk commands |
| Controlled Network Mode | `ControlledNetwork` | Currently defaults to local file space; uses protected paths and Trash Bin | HTTP(S) broker-proxy-preferred + audit; Script `brokerOnly` fail-closed; non-HTTP(S) direct-audit | By default blocks general detached launch and desktop control; `agent-browser` is available through a dedicated CDP runtime narrow path | Email, GitHub, cloud APIs, existing CLI / Skill token caches, controlled browser automation |

Key promises:

- Local Audit Mode is not an unprotected mode. It still goes through TS/Rust command protection, protected paths, script scanning, Trash Bin, and audit.
- Offline Isolated Mode promises workspace file boundaries and hard no-network behavior. If AppContainer initialization or sandbox profile initialization fails, it should fail closed.
- Controlled Network Mode promises network egress narrowing, not workspace file isolation. It currently does not claim that all direct connections have been captured at the OS layer. Browser automation only promises the AgentVis dedicated `agent-browser` CDP runtime narrow path, not arbitrary GUI / Chrome attach.
- UI copy and backend enforcement must stay consistent. Experimental capabilities must not be described as default capabilities in the normal UI.

## 6. Mode Mapping

Semantic parameters for `shell_execute`:

```ts
sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
processLifecycle?: 'managed' | 'detachedLaunch' | 'backgroundManaged';
networkScope?: 'inherit' | 'blocked' | 'lan' | 'internetAudit';
subjectType?: 'command' | 'skill' | 'tool' | 'preview' | 'installer';
subjectId?: string;
networkDirectAllowances?: NetworkDirectAllowance[];
networkDirectTargets?: NetworkDirectTarget[];
```

Default mapping:

| `sandboxMode` | `sandboxLevel` | `sandboxNetwork` | `networkScope` | Description |
| --- | --- | --- | --- | --- |
| `LocalAudit` | `standard` | `inherit` | `inherit` | Normal local execution while keeping security validation and audit. |
| `OfflineIsolated` | `restricted` | `blocked` | `blocked` | Strong isolation: AppContainer filesystem + deny-all network. |
| `ControlledNetwork` | `restricted` | `audit` | `internetAudit` | Current default: local file space + broker-proxy-preferred + direct-audit. |

Compatibility rules:

- Old `sandboxLevel` / `sandboxNetwork` can still be parsed by Rust, but new callers should prefer `sandboxMode`.
- `sandboxMode=OfflineIsolated` forces `restricted + blocked`; callers cannot loosen it with `networkScope`.
- `sandboxMode=ControlledNetwork` defaults to the local-file-space broker-preferred path when `AGENTVIS_CONTROLLED_NETWORK_BACKEND=legacy` is not set.
- `network=blocked` or Script Skill `brokerOnly` still enters the AppContainer deny-all / main-process broker helper fail-closed path.

## 7. Process Lifecycle

| Lifecycle | Use case | Job Object behavior | Sandbox limit |
| --- | --- | --- | --- |
| `managed` | CLI, tests, builds, short scripts | Uses Job Object; cleans process tree on timeout, cancel, or exit | Available in all modes |
| `backgroundManaged` | Vite / dev server / long-running background services | Background registry + Job Object; can be terminated through `shell_kill` | Constrained by the current mode's network and file boundaries |
| `detachedLaunch` | `start`, `Start-Process`, Chrome, VS Code, explorer, browser / desktop Skills | Does not use `KILL_ON_JOB_CLOSE`, avoiding accidental kills of external GUI apps | Offline Isolated and current Controlled Network fail closed by default |

Desktop capabilities are handled separately:

- `desktopLaunch=true` means the Skill may start an external GUI / detached application.
- `desktopControl=true` means the Skill needs interactive desktop capability such as hotkeys, mouse, screenshots, window activation, SendInput, pyautogui, or pywinauto.
- Offline Isolated Mode must block desktop control before spawn, avoiding cases where the command exits with code 0 but the actual operation is swallowed by system isolation or lifecycle handling.
- Controlled Network still blocks general desktop capability by default. `agent-browser` is not a generic desktop allow path; it provides browser automation through a dedicated Chrome CDP runtime, broker proxy, and command-classification narrow path.

### 7.1 Project Preview Background-Process Ownership

Project Preview uses the `backgroundManaged` lifecycle, but it does not infer ownership from "a process is listening on a port":

- After `shell_execute(background=true)` starts successfully, the background registry retains the exact PID and Job Object guard. Preview calls `shell_kill` only for a PID owned by its current run.
- Asynchronous drain tasks continuously consume stdout and stderr. Each stream retains only its last 1 MiB and separately records discarded prefix bytes, preventing a long-running service from blocking on a full pipe or consuming unbounded memory.
- `shell_background_status(pid)` returns `running` / `exited`, the exit code, both output tails, and truncation counters. A tombstone remains for five minutes after exit, and is then pruned, or pruned earlier when the tombstone-count limit is exceeded. An unknown PID returns an explicit not-found error.
- Preview polls status during startup and while running. When an old request is cancelled, Preview is closed, the Agent/project is switched, or the user retries, dependency installs, the background PID, the port, and the staging workspace are reclaimed through the same serialized cleanup path.
- Rust native commands reclaim staging. Beyond checking the workspace `runId`/`ownerToken`, normal cleanup must prove and release the owner lease held in this process's registry; it cannot use another instance's marker/token to remove that instance's workspace. It then atomically renames the workspace into controlled trash and performs no-follow deletion. A `node_modules` junction has only the link itself removed. On Windows, only error codes 5/32/33 that can follow process termination receive about 1.6 seconds of bounded retries, with owner/receipt revalidation before every attempt. Failures enter a capacity- and per-pass-bounded fair cleanup backlog and re-register native stale recovery.
- The old `3100-3110` port scan/process-kill behavior is disabled. A port is only a routing resource, not process identity or proof of ownership.

## 8. Filesystem Boundaries

### 8.1 Local Audit Mode

Local Audit Mode does not restrict the Agent to workdir. It relies on the following defenses:

- Rust `command_validator` blocks core system directories and custom protected directories.
- `file_write` calls `validate_path_write_safety()` to protect custom directories.
- Delete commands in `exec` preferentially enter Trash Bin soft delete.
- Dangerous script content is scanned before execution.

### 8.2 Offline Isolated Mode

The file boundary of Offline Isolated Mode is workdir + application-managed root directories:

- Native file tools use `getSandboxPathViolation()` to restrict access to `sandboxRoots` or `workdir`.
- On the Rust side, AppContainer filesystem grants include the working directory and app-managed roots such as `{AppDataDir}/runtime` and `{AppDataDir}/skills`.
- `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, and `XDG_*` are redirected to `{AppDataDir}/runtime/sandbox-profile/*`.
- The Python runtime must be hermetic and cannot depend on user-host Python. If `.venv/pyvenv.cfg` points outside the app-managed runtime, it should be treated as sandbox-incompatible and rebuilt.
- Trash Bin is a host-side soft-delete proxy. Under isolated modes, it must first validate that the delete target is inside workdir or app-managed roots to avoid bypassing AppContainer.

### 8.3 Controlled Network Mode

The Controlled Network target shape uses local file space by default:

- Ordinary `exec` / Guide Skills no longer enter AppContainer filesystem boundaries by default.
- Native file tools align with this semantic through `sandboxFilesystemScope=local`; if that scope is not set to `local`, `ControlledNetwork` still blocks according to workspace-bounded logic.
- If a Script Skill explicitly declares `network=false` or enters a `restricted + blocked` path such as `brokerOnly`, it may still use the AppContainer deny-all backend. In that case, `execution.permissions.filesystem` can generate per-run filesystem grants from string parameters and expose only the files or directories needed by the current call.
- Reuse of the real Home, CLI configuration, Skill token cache, browser credentials, or cloud-service credential files is allowed.
- Risk narrowing moves to broker egress policy, log redaction, observation redaction, upload limits, and direct-audit authorization.

### 8.4 Project Preview Staging Boundary

Project Preview does not use the Agent deliverable directory as an executable workspace. On each start, Rust creates a fresh `{appCacheDir}/project-preview/project-preview-{UUIDv4}/` staging workspace and treats Agent files as untrusted input:

- `ProjectFile.path` is first normalized to a slash-separated relative path. Empty paths, NUL, absolute/UNC paths, drive-qualified paths, URL schemes, and every explicit `..` segment are rejected. Reserved `.agentvis`, `.git`, `Agent-Log`, `node_modules`, and build-output paths are not written as Agent sources. Complete projects additionally admit only Vite/PostCSS/Tailwind/tsconfig/jsconfig toolchain files; other root build, test, and lint configuration remains filtered.
- The source budget is at most 500 files, 4 MiB per file, and 32 MiB total. `preview_list_source_tree` applies entry/depth/file/byte hard limits while iterating in Rust instead of first materializing an unbounded renderer list. Root `package.json`/lock files are skipped before source-byte accounting, the manifest uses a separate bounded read, and complete-project tsconfig/jsconfig may enter source staging. `.env` / `.env.*` names are counted but never read or staged; if startup fails, the UI preserves the primary error and notes that environment files were omitted. `preview_read_text_file` uses one no-follow handle for `fstat` and reading, with each request reduced to the remaining total budget. `preview_copy_assets` copies only while the current process holds the workspace owner lease, allows only explicit extensions, and enforces at most 1,000 files, 64 MiB per file, 256 MiB total, depth 24, and 10,000 scanned entries. Final resolved source/target handle paths must remain under their controlled roots, and source/text reads refuse multiple hard links. A Windows static asset is copied read-only only when every enumerated NTFS hard-link name remains inside the same Agent workspace with matching identity; cross-workspace, out-of-root, or unstable links remain blocked, while other platforms still refuse multiply linked assets. Symlinks, junctions, Windows reparse points, and hidden assets are always refused.
- `package.json` is limited to 256 KiB of UTF-8, 128 combined `dependencies + devDependencies`, 214 characters per package name, and 256 characters per version specifier. It accepts only valid npm-registry package names and constrained versions/ranges. `file:`, `link:`, `workspace:`, Git/HTTP URLs, GitHub shorthand, npm aliases, and local paths are rejected. Dependency installation always uses `--ignore-scripts --no-audit --no-fund --package-lock=false`, so package lifecycle scripts do not execute.
- Snippet mode never executes Agent root build configuration; it uses the AgentVis template and syntax-only Tailwind extraction. Complete-project mode is wrapped by AgentVis `.agentvis/vite.config.mjs` and loads the staged project Vite configuration to restore plugins, aliases, PostCSS/Tailwind, package type, declared versions, and in-staging root/env/public semantics. The wrapper overrides host/port, CORS, `server.fs.strict`, cache location, health, and diagnostics, and does not load unrelated ESLint/Webpack/Rollup/Esbuild root configuration. Project Vite/PostCSS/Tailwind configuration remains executable Node code: the current `preview=inherit`/Local Audit process is not an OS-level VM and cannot stop that code from actively accessing local files outside staging or the network with the current user's authority. Complete-project compatibility is therefore only for projects created by the user or a trusted Agent.
- A Vanilla project with no `package.json` and an Import Map in its effective root entry (`index.html` or the only root HTML file) first becomes a static candidate. It uses the owned static server only when every Import Map parses, every bare import is covered by top-level `imports` or the longest referrer-matching `scopes` mapping, and the project contains no `.jsx/.ts/.tsx/.vue` source or module entry/import specifier ending in those extensions or `.css`. Malformed maps, unmapped bare specifiers, and TS/TSX/JSX/Vue/CSS modules that require a Vite transform fail closed without falling back to Vite. Ordinary `<link rel="stylesheet">` CSS remains a valid static resource.
- `preview_create_workspace` creates only a direct child of the real app-cache root, returns its `workspace`, `runId`, and random `ownerToken`, writes `.agentvis/active` with that exact identity and an activity timestamp, and holds a cross-instance file lease. An active run refreshes the marker no more than every 60 seconds.
- `preview_cleanup_workspace` must match the expected `runId`/`ownerToken`. Normal cleanup must additionally prove and release the corresponding owner lease from this process's registry; marker/token knowledge alone does not authorize cross-instance removal. It then revalidates the app-cache direct child, UUIDv4 name, marker, symlink/reparse state, and canonical containment. The workspace is atomically renamed into quarantined trash under the controlled cache root and removed with a no-follow walker. On Windows, backoff for access denied, sharing violation, or lock violation (5/32/33) is strictly bounded, and each retry revalidates the workspace, owner, receipt, and empty target. Exhaustion removes the temporary receipt, restores the lease, and fails closed. A directory is traversed only while its canonical path remains inside that trash; a `node_modules` junction or any other link/reparse point has only the link itself removed.
- This boundary covers untrusted deliverable contents, deliverable-tree link/rename races, and accidental cross-instance cleanup. It assumes the private app-cache root remains owned by AgentVis; a malicious process running as the same OS account that deliberately renames or replaces that cache between trusted writes and process spawn is outside the Project Preview threat model.
- `preview_cleanup_stale_workspaces` reclaims stale directories in bounded native pages. A candidate must be inactive for at least 24 hours, pass the same identity/path validation, and yield its file lease; active, mismatched, or invalid workspaces remain in place. Before quarantine, native code writes a root-owned `.trash-{UUIDv4}.owner.json` receipt paired exactly with `.trash-{UUIDv4}`. If partial deletion removes the workspace marker and prevents restoration to the original name, a stale sweep self-reclaims the residue with no-follow deletion only when trash and receipt have strict matching names, both are real direct children of the controlled root, and the receipt is at least 24 hours old. When the paired trash is absent, only a strictly named, self-consistent, real regular-file orphan receipt older than 24 hours may be deleted. The frontend backlog has bounded capacity and per-pass retries, moves failures to the tail, and re-registers stale recovery after a new failure, quarantine, or overflow so an earlier completed sweep cannot mask later residue in the same session.

## 9. Network Mechanisms

### 9.1 Network Policy

| Policy | Behavior |
| --- | --- |
| `inherit` | Does not change the child-process network environment. |
| `audit` | Scans network commands / network APIs and writes audit. In the Controlled Network broker-preferred path, it blocks proxy-bypass signals. |
| `blocked` | Blocks on scan hits and injects no-network environment variables. |

Offline Isolated uses `blocked`; Controlled Network defaults to `audit + internetAudit`.

### 9.2 Broker / Proxy

Controlled Network currently provides two broker paths:

- Ordinary `exec` / Guide Skills: starts a per-run local HTTP(S) proxy and injects `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, lowercase variables, npm / pip / git proxy configuration, and a server-only proxy environment readable by browser runtime.
- Script Skill `brokerOnly`: starts a file-based broker session and injects `AGENTVIS_BROKER_MODE=explicit`, `AGENTVIS_BROKER_PIPE`, `AGENTVIS_BROKER_TOKEN`, and `AGENTVIS_BROKER_FETCH`; scripts request main-process delegated fetch through `agentvis-broker-fetch`.
- Script Skill `brokerOnly + execution.credentials`: the Contract can declare a broker-managed credential policy. Script request JSON carries only `credentialRef`; the real secret does not enter LLM args, environment variables, command lines, script stdout/stderr, or observations. Before making an HTTP(S) request, the main process reads credentials from Windows Credential Manager by `provider`, and injects the declared header only when HTTPS is used, the exact host allowlist matches, and the request does not already contain an authentication header with the same name.

Failure semantics for `ControlledNetwork + internetAudit + broker-preferred`:

- When proxyable network intent such as HTTP(S) / Git / npm is detected, broker proxy session startup failure must fail closed with `broker_proxy_required_unavailable`; it must not fall back to direct connection.
- If the broker file/helper session fails to start but proxy is available, execution may continue and only writes a `broker_helper_unavailable` diagnostic.
- Successful proxy session startup writes `broker_proxy_session_started`.
- If the command exits successfully but the current broker file/proxy session receives no broker requests, write `broker_proxy_expected_but_unused` as a diagnostic to investigate cache hits, misclassification, or suspected silent direct connection.
- `broker_proxy_expected_but_unused` still does not block the task. Audit detail always contains `reasonCode=broker_proxy_expected_but_unused` and an aggregatable `reasonClass`; current values are `cache_hit_likely`, `tool_misclassification`, and `potential_direct_egress`, helping regression dashboards distinguish cache hits, detection misclassification, and suspected direct egress.

Broker security policy:

- Per-run token authentication.
- Reject URL credentials.
- Reject localhost, private, link-local, metadata, CGNAT, multicast, unspecified, and similar targets.
- Before DNS, identify private/local/metadata IPv4 addresses encoded in `sslip.io` / `nip.io` / `xip.io`; on hit, block with `broker_network_block` / `hardBlock` and record `resolvedRisk`, `resolvedRiskReason`, and `resolvedIpSamples` in `matchedPattern/detail`, preventing enterprise DNS/proxies from hiding the risk by rewriting to `198.18.x.x`.
- HTTP requests and HTTPS CONNECT both connect using already validated addresses, reducing TOCTOU between DNS validation and connection.
- Re-resolve, validate, and pin on every redirect hop.
- For broker requests carrying `credentialRef`, every redirect hop must still be HTTPS and match the same host allowlist, otherwise fail closed to avoid leaking `Authorization` to third-party domains.
- Apply limits to request body, response body, redirect count, and timeout.
- Redact logs / observations for `Authorization`, `Proxy-Authorization`, `Cookie`, proxy credential URLs, token queries, and common secret keys. Credential broker responses may only return `credentialRef` and `credentialApplied` boolean state, never the secret.

Browser Skill notes:

- Ordinary CLI / HTTP(S) tools use standard proxy URLs with tokens; browser runtime reads a server-only address from `AGENTVIS_BROWSER_PROXY_SERVER`, and credential URLs must not be written to command lines, environment echoes, or observations.
- `agent-browser` is the current default closed path: it starts the AgentVis dedicated Chrome CDP runtime through `start-chrome-debug.bat`. Under Controlled Network, only that launcher, the `browser-command.bat` wrapper, and CDP commands bound to an `agentvis-cdp-*` session are opened as narrow paths.
- Browser broker proxy sessions use local one-time endpoints. The browser side does not ask users to enter proxy username / password. If an old extension or old runtime displays proxy auth, restart the runtime and use the new launcher.
- The launcher rejects direct / bypass / credential proxy Chrome arguments, records controlled runtime state, and requires `ensure` rebuild when an uncontrolled old runtime or proxy hash mismatch is detected.
- `browser-command.bat` clears the effect of normal `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` on the local CDP control plane and keeps only loopback no-proxy. `screenshot` / `screenshot --annotate` restores window screenshots and minimizes afterwards; `close` uses runtime graceful stop.
- Attaching to an arbitrary existing user Chrome is only a Local Audit Mode capability and is not a default Controlled Network promise. General Playwright / Chromium Skills must still explicitly read the browser proxy environment, pass launch proxy parameters, and reject direct/bypass/credential URLs.

### 9.3 Proxy Bypass Signals

In the `ControlledNetwork` broker-preferred path, the following signals are identified as `proxy_bypass_signal_detected` and fail closed by default with `proxy_bypass_signal_blocked`:

- `curl --noproxy` / `--no-proxy`.
- Explicit `NO_PROXY` / `no_proxy` / `npm_config_noproxy`.
- Clearing or explicitly disabling `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `npm_config_proxy` / `npm_config_https_proxy`, including `cmd /c "set KEY=&& ..."`, `git -c http.proxy=`, and `curl -x ""`.
- Chromium direct proxy parameters.
- Python raw socket, IMAP, SMTP, FTP, SSH libraries.
- In-script raw sockets spawned again through Python `subprocess` / Node `child_process`.
- Node raw TCP / UDP, native fetch without a configured proxy agent.
- PowerShell `.NET TcpClient` / `Socket` / `Test-NetConnection`.
- Non-HTTP(S) direct commands such as SSH / SCP / SFTP, Telnet, database clients, and raw socket.

The scanner parses common shell wrappers, including `cmd /c` payloads, subsequent scripts in `cd /d ... && node/python script`, multiple script entrypoints, and child script paths inside script string literals. If Playwright / Chromium scripts pass `--proxy-server=direct://` or `--proxy-bypass-list=*`, they should be blocked before spawn even when launched through a wrapper.

If the direct connection is non-HTTP(S) and an exact target can be parsed or preflighted, it enters direct-audit authorization; otherwise, no broad authorization is shown and execution is blocked directly.

### 9.3.1 High-Confidence Confirmation for Upload / Sensitive Egress / Remote Destruction

`ControlledNetwork` does not perform generalized DLP by default and does not inspect file content. However, before spawn it identifies three very explicit high-risk network semantics and triggers one-time user confirmation. After confirmation, the frontend passes the corresponding confirmed flag only in the same retry, and the backend writes confirmation audit without persisting authorization.

| Risk class | First block reason | Reason after confirmation | Retry flag | Description |
| --- | --- | --- | --- | --- |
| `fileUpload` | `network_upload_confirmation_required` | `network_upload_risk_confirmed` | `networkUploadConfirmed=true` | Explicit file upload, without judging whether file content is sensitive. |
| `sensitiveEgress` | `network_sensitive_egress_confirmation_required` | `network_sensitive_egress_confirmed` | `networkSensitiveEgressConfirmed=true` | Command combines sensitive file / environment-variable reads with network body send. |
| `remoteDestructive` | `network_remote_destructive_confirmation_required` | `network_remote_destructive_confirmed` | `networkRemoteDestructiveConfirmed=true` | High-confidence remote delete, destruction, database drop, cloud resource wipe, and similar operations. |

Audit events additionally write structured fields: `riskClass`, `riskKind`, and `credentialContext`. `credentialContext=brokerCredentialRef` means the execution carries broker-managed credential policy; `credentialContext=ambient` means ordinary context such as environment / CLI / local cache.

Initial upload patterns: `curl --data-binary @file`, `curl -F name=@file`, `curl -T/--upload-file`, PowerShell `Invoke-WebRequest/Invoke-RestMethod -InFile`, Python `requests/httpx ... files=...` including multiline `files = ...`, and Node `FormData + fs.createReadStream`.

Initial sensitive-egress patterns: reading sensitive files such as `.env`, `.npmrc`, `.pypirc`, `.git-credentials`, `.netrc`, SSH keys, cloud provider credentials, kubeconfig, `credentials.json`, service accounts into a `curl` body; piping `env` / `printenv` / `set` / PowerShell `Get-ChildItem Env:` into a network request; Python `requests/httpx post|put|patch` or Node `fetch/axios/got/undici` putting sensitive file reads into body / data.

Initial remote-destructive patterns: `curl -X DELETE`, PowerShell `-Method Delete`, Python / Node HTTP delete; `DROP`, `TRUNCATE`, `DELETE FROM`, `FLUSHALL`, `dropDatabase()` in database clients such as `psql` / `mysql` / `redis-cli` / `mongosh` / `sqlcmd`; and cloud/resource destruction commands such as `terraform destroy`, `kubectl delete`, `helm uninstall/delete`, `gh repo delete`, `az ... delete`, `gcloud ... delete`, `aws s3 rm --recursive`, and `aws terminate-/delete-/remove-`.

Daily tasks such as normal `git` / `npm` / `pip`, read-only HTTP(S) queries, local downloads, `kubectl get`, `helm list`, `terraform plan`, `aws s3 ls`, and database `SELECT` / `INFO` should not trigger these confirmations. This boundary is covered by Rust regression tests and will continue expanding with the real Agent task corpus.

### 9.4 WFP Experimental Enhancement

WFP is not a default capability of the three normal modes and can only be entered through explicit advanced switches:

- `AGENTVIS_NETWORK_GUARD_BACKEND=wfpCanary`
- `AGENTVIS_NETWORK_GUARD_BACKEND=wfpAppIdBlock`
- `AGENTVIS_NETWORK_GUARD_BACKEND=wfpPerRunAppIdBlock`

Current positioning:

- Used to validate per-run egress guard, readiness, session, and cleanup audit.
- The normal shell chain first runs helper `inspect --json` diagnostics and writes a `wfpEnhanced` audit event.
- `wfpCanary` only provides diagnostic enhancement, recording `wfp_canary_direct_egress_observed`, `wfp_canary_no_direct_egress`, and `wfp_canary_unavailable`; it is not equivalent to default hard no-network.
- Hard guard only applies to high-confidence, allowlisted managed executables. The concrete command set follows Rust `wfp_managed_egress_command_name()`.
- It does not recursively promise coverage of all child executables spawned by a managed exe, and does not cover detached GUI / long-lived external processes by default.

### 9.5 Project Preview Network Boundary

`preview` remains an internal technical profile whose default network policy is `inherit`, supporting npm-registry dependency installation and preview-page resource loading. Its isolated staging, dependency/path allow-lists, and trusted server configuration constrain files and execution; they must not be described as a network sandbox.

Both runtime routes bind only to `127.0.0.1`. Before displaying the iframe, the host validates a per-run random token returned by `/.agentvis/health`, then requests the root HTML and entry/source paths to detect 4xx/5xx failures. The health token establishes local-service identity and protects against startup races; it is not user authentication. The iframe diagnostics bridge also validates the current frame source and exact Preview origin. Before a trusted host ping, only content-free lifecycle messages support the handshake; error details remain cached and are replayed only to the exact allow-listed host origin. CDN URLs in an Import Map and other remote requests in the page are still initiated by the embedded page according to browser semantics and are not covered by a Project Preview network-DLP guarantee.

## 10. Non-HTTP(S) direct-audit Authorization

### 10.1 Trigger Conditions

direct-audit only handles necessary non-HTTP(S) direct connections, including:

- IMAP / SMTP.
- SSH / SCP / SFTP.
- Telnet / raw TCP.
- Database clients such as `psql`, `mysql` / `mariadb`, `redis-cli`, `mongosh` / `mongo`, and `sqlcmd`.
- PowerShell `Test-NetConnection` / `.NET TcpClient` / Socket.
- `legacyNonHttp` entrypoints in self-made or downloaded Skills.

Entering direct-audit requires exact targets:

```json
{
  "targets": [
    { "protocol": "postgres", "host": "db.example.com", "port": 5432 }
  ]
}
```

Target sources:

- Rust `sandbox_network_direct_targets` extracts read-only targets for common commands.
- The email-helper legacy entrypoint returns IMAP / SMTP targets through `--action network_targets`.
- Script Skill or Guide Skill `legacyNonHttp` entrypoints return targets through read-only `--action network_targets` preflight.

### 10.2 Frontend Authorization

`NetworkDirectAuthorizationDialog` displays the target, authorization subject, working directory, and truncated command.

Risk levels:

- public target: can choose "allow this time" or "allow for this session."
- localhost / private / link-local / CGNAT: shows high-risk copy, and even if the user selects session, it is downgraded to current-run authorization.
- metadata target: no allow button is provided; the user must switch to Local Audit Mode.
- Before the authorization dialog, Rust resolves hostnames and fills `resolvedRisk`, `resolvedIpSamples`, and `resolvedRiskReason`. For example, if `db.example.com` resolves to private/link-local/metadata, risk is displayed and fail-closed / current-run downgrade is applied according to the resolved result. To avoid enterprise DNS/proxies rewriting `sslip.io` / `nip.io` / `xip.io` into proxy-mapped addresses, Rust first detects IPv4 addresses encoded in these hostnames, such as `127.0.0.1.sslip.io` and `169-254-169-254.sslip.io`, and marks `hostnameEncodedPrivateOrLocalIp` / `hostnameEncodedMetadataIp`. Common proxy/load-test mapping addresses such as `198.18.0.0/15` keep the `public` authorization experience, but `resolvedRiskReason` is marked as `dnsResolvedBenchmarkOrProxyIp` / `literalBenchmarkOrProxyIp` for enterprise proxy matrix aggregation.

Authorization validity:

- `currentExecution`: the current implementation has a short expiration time, defaulting to 15 minutes.
- `session`: frontend in-memory session authorization, defaulting to 12 hours and automatically filtered after expiration.

### 10.3 Backend Retry and Exact Matching

Authorization structure:

```ts
type NetworkDirectAllowance = {
  id: string;
  subjectType: 'command' | 'skill' | 'preview' | 'installer';
  subjectId?: string;
  protocol: string;
  host: string;
  port: number;
  scope: 'currentExecution' | 'session';
  expiresAt?: number;
  createdAt: number;
  reason: string;
};
```

On retry, the frontend passes both:

- `networkDirectAllowances`
- `networkDirectTargets`

Rust only allows execution when all of the following match:

- `subjectType`
- `subjectId`
- `protocol`
- `host`
- `port`
- non-expired `scope`
- target is not metadata
- if the hostname resolves to metadata, it still fails closed with `network_direct_metadata_target_blocked`; if it resolves to localhost/private/link-local/CGNAT, the backend only accepts `currentExecution`, not `session` scope.

After a successful match, it writes `network_direct_audit_allowed`, `guardMode=directAuditAllowed`, and continues normal shell execution. If matching fails, it continues to block with `proxy_bypass_signal_blocked`.

## 11. Skill Permission Declarations

### 11.1 Script Skill Contract

Script Skills enter the unified execution chain through `external_skill_execute({ skillName, args })`. `execution.permissions` in `SKILL.md` frontmatter supports:

```yaml
execution:
  permissions:
    network: true | false
    networkMode: direct | brokerOnly
    filesystem:
      - fromArg: path
        access: readOnly | readWrite
    desktopLaunch: true | false
    desktopControl: true | false
  credentials:
    - id: github
      provider: github
      mode: brokerAuth
      hosts: [api.github.com]
      headerName: Authorization
      headerValuePrefix: "Bearer "
      required: false
```

Rules:

- `network=true`: allows inheriting system network.
- `network=false`: blocks when scanning hits network commands or network APIs.
- Unspecified `network`: defaults to audit, trying not to break installed Skill usability.
- `networkMode=brokerOnly`: direct connections fail closed and must use the main-process broker helper; it cannot be declared together with `network=false`.
- `filesystem`: adds local filesystem authorization for the current call to a restricted AppContainer process. `fromArg` must reference a string parameter in `argsSchema`; `readOnly` is suitable for inspection scripts, while `readWrite` is suitable for scripts that organize, move, create, delete, or modify files.
- `execution.credentials` is only allowed together with `networkMode=brokerOnly`. v1 only supports `mode=brokerAuth`, HTTP header injection, exact host, and HTTPS. It does not support wildcard hosts, query/body injection, non-HTTP(S) protocols, or transparent broker proxy paths.
- `provider` corresponds to the provider key in Credential Manager, such as `github`. When not configured, `required=false` continues anonymously and returns `credentialApplied=false`; `required=true` fails closed.
- `desktopLaunch=true`: indicates the Skill may start an external GUI / detached application.
- `desktopControl=true`: indicates the Skill needs hotkeys, screenshots, mouse/keyboard, or window control capability.

### 11.2 AgentVis Network Declarations

Top-level declaration:

```yaml
agentvisNetwork: brokerProxyPreferred
```

Applicable to:

- HTTP(S) proxy-aware Skills.
- Skills that honor `HTTP_PROXY` / `HTTPS_PROXY` / `AGENTVIS_NETWORK_PROXY_URL`.
- Skills that can avoid false positives under explicit WFP per-run guard when the first token is a shared interpreter.

Not applicable to:

- Non-HTTP(S) protocols such as IMAP / SMTP / SSH / database / raw socket.
- Do not disguise an entire non-HTTP(S) Skill as HTTP(S) proxy-aware.

Entrypoint-level declaration:

```yaml
agentvisNetworkEntrypoints:
  scripts/gmail_api_helper.py: brokerProxyPreferred
  scripts/email_helper.py: legacyNonHttp
```

Rules:

- Entrypoint-level declarations have higher priority than top-level declarations.
- `brokerProxyPreferred` means this entrypoint is an HTTP(S) API path and should go through broker/proxy and audit.
- `legacyNonHttp` is not an allow marker. It only means that if the entrypoint hits non-HTTP(S), it enters direct-audit authorization closure.
- Ordinary `exec` in Guide mode also matches loaded Skills' `packagePath` and `agentvisNetworkEntrypoints` by script path. On a `legacyNonHttp` hit, it automatically performs `--action network_targets` preflight.

## 12. Audit Model

`SandboxAuditEvent` is the single stable data source for UI and diagnostics. Events are pushed in realtime through `agentvis://sandbox-audit-event`, while recent in-memory events are kept and persisted to `sandbox_audit_events`. The query command is `sandbox_audit_events`.

Core fields:

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

Audit requirements:

- Do not record the full original command text. Only record stable hash, profile, policy, hit reason, and result.
- Broker targets keep only redacted target, hash, status code, byte count, duration, and block reason.
- Network observations, error messages, and audit details must not leak proxy token, `Authorization`, `Proxy-Authorization`, `Cookie`, token query, or common secret keys.
- direct-audit must record subject, target protocol, host, port, reason, and `guardMode=directAuditAllowed`.
- WFP events must be marked as experimental enhancement diagnostics and must not be confused with the default broker-only promise.
- The following detail / `matchedPattern` fields should remain stable as high-signal aggregation contracts: `broker_proxy_expected_but_unused.reasonClass`, `proxy_bypass_signal_blocked.matchedPattern`, `network_upload_*` / `network_sensitive_egress_*` / `network_remote_destructive_*` risk signals, `resolvedRisk` / `resolvedIpSamples` / `resolvedRiskReason`, and `wfpCanary.taskCategory`.
- The three high-confidence network risk event types should primarily consume structured fields `riskClass`, `riskKind`, and `credentialContext`; `matchedPattern` is only for legacy-event compatibility and manual troubleshooting details.

## 13. UI and i18n

Current UI entrypoints:

- Agent settings page displays the three modes: Local Audit Mode, Offline Isolated Mode, and Controlled Network Mode.
- `NetworkDirectAuthorizationDialog` handles non-HTTP(S) direct-audit authorization.
- `NetworkUploadAuthorizationDialog` handles one-time confirmation for high-confidence upload, sensitive egress, and remote destruction.
- Settings page `SandboxAuditSettings` displays persisted audit events and supports filtering by decision, backend, source, guardMode, and other fields.

Copy requirements:

- When adding or modifying user-visible copy, Toasts, error messages, chat bubble content, tool observations, system / tool return messages, prefer existing i18n.
- Sandbox block messages should tell users the recovery path, such as switching to a broker/proxy-aware path, using Gmail API, requesting direct-audit, or switching to Local Audit Mode.
- Security confirmation dialogs must not close on outside click or Escape. When opened, initial focus should be on dialog content rather than buttons, avoiding accidental cancel/allow through Space / Enter. Users must explicitly click a button or Tab to a button before keyboard confirmation.
- Internal logs and pure debug information do not strictly require i18n, but must not leak secrets.

## 14. Key Source Index

Frontend:

- `src/components/agent/AgentSettingsModal.tsx`: entrypoint for three-mode settings.
- `src/hooks/usePlanningMode.ts`: passes `sandboxMode` from Agent configuration to AgentService.
- `src/services/planning/skills/exec/tool.ts`: TS pre-flight validation, mode mapping, Guide Skill entrypoint-level network declaration matching, direct-audit / upload confirmation retry for ordinary `exec`.
- `src/services/planning/skills/external_skill_execute/tool.ts`: Script Skill tool entrypoint.
- `src/services/planning/skills/external/ExternalExecutor.ts`: Script Skill shell execution, brokerOnly environment, legacyNonHttp preflight, direct-audit / upload confirmation retry.
- `src/services/planning/skills/shared/sandboxPath.ts`: sandbox path boundaries for native file tools.
- `src/stores/networkDirectAuthorizationStore.ts`: direct-audit authorization state, expiration, and risk downgrade.
- `src/components/security/NetworkDirectAuthorizationDialog.tsx`: direct-audit UI.
- `src/stores/networkUploadAuthorizationStore.ts`, `src/components/security/NetworkUploadAuthorizationDialog.tsx`: confirmation UI for high-confidence upload / sensitive egress / remote destruction.
- `src/components/settings/SandboxAuditSettings.tsx`: audit log UI.
- `src/types/sandboxAudit.ts`, `src/types/networkDirectAuthorization.ts`: frontend structured types.
- `src/services/preview/VitePreviewService.ts`: Project Preview staging orchestration, Import Map native-JS-only preflight, dependency budgets, health/heartbeat, owned-PID lifecycle, and bounded native-reclamation retries.
- `src/services/preview/projectPathPolicy.ts`, `previewDependencyPolicy.ts`, `previewSourcePolicy.ts`, `previewAssetCopier.ts`: Preview path, npm-dependency, source-file, and static-asset boundaries.
- `src/services/preview/importMapAnalysis.ts`, `trustedPreviewRuntime.ts`: Import Map static routing, trusted Vite/static runtimes, and the iframe diagnostics bridge.
- `src/components/file/LivePreviewPanel.tsx`, `src/stores/previewStore.ts`: staged Preview UI, source/origin-checked `postMessage` diagnostics, and close/switch/retry lifecycle.

Backend:

- `scripts/collect-enterprise-network-env.ps1`: AgentVis enterprise network compatibility read-only collector; collects current network, proxy server, VPN, firewall, and EDR-related signals and generates reports without changing system settings.
- `src-tauri/Run-MatrixTest.ps1`: AgentVis WFP matrix test tool.
- `src-tauri/src/commands/shell.rs`: main `shell_execute` chain, background PID registry / `shell_background_status` / bounded-output tombstones, plus native Preview workspace creation, per-process owner-lease registry, identity/path validation, receipt-backed atomic quarantine/no-follow deletion, and bounded stale workspace/quarantine pagination.
- `src-tauri/src/lib.rs`: registers Tauri commands including `preview_create_workspace`, `preview_cleanup_workspace`, and `preview_cleanup_stale_workspaces`.
- `src-tauri/src/commands/process_sandbox.rs`: sandbox facade, continuing to re-export submodule types and capabilities to keep external call paths stable.
- `src-tauri/src/commands/process_sandbox/policy.rs`: main `ShellSandboxPolicy` strategy chain, responsible for mode / lifecycle / network scope / subject parsing, policy environment variables, audit events, and direct-audit allowance matching.
- `src-tauri/src/commands/process_sandbox/platform.rs`: process sandbox platform backend facade, separating Windows and non-Windows implementations while keeping upper-level exports stable.
- `src-tauri/src/commands/process_sandbox/platform/windows.rs`: Windows platform backend, carrying Win32 handles, Job Object, AppContainer filesystem profile / probe, Restricted Token process, and pipe-output reading.
- `src-tauri/src/commands/process_sandbox/platform/non_windows.rs`: non-Windows stub, keeping only guard and restricted-token probe placeholders needed for cross-platform compilation.
- `src-tauri/src/commands/process_sandbox/types.rs`: sandbox modes, network scopes, lifecycle, direct-audit authorization / targets, AppContainer / Restricted Token shared types, and enum helper methods.
- `src-tauri/src/commands/process_sandbox/audit.rs`: `SandboxAuditEvent` storage, query, SQLite persistence, command hash, and audit target redaction.
- `src-tauri/src/commands/process_sandbox/broker_audit.rs`: structured audit event construction for network broker / main-process network requests.
- `src-tauri/src/commands/process_sandbox/network.rs`: process sandbox network submodule facade, stabilizing the re-export boundary between the main policy file and network scanning implementation.
- `src-tauri/src/commands/process_sandbox/network/scan.rs`: scanning for network commands, script network APIs, PowerShell payloads, proxy bypass, raw sockets, high-confidence upload, sensitive egress, and remote destruction signals.
- `src-tauri/src/commands/process_sandbox/network/direct_targets.rs`: non-HTTP(S) direct-audit protocol target parsing, Skill entrypoint network declaration recognition, authorization target backfill, DNS risk resolution, and metadata target rejection checks.
- `src-tauri/src/commands/process_sandbox/network/powershell.rs`: target extraction for PowerShell `Test-NetConnection`, `.NET TcpClient`, and direct connections in nested payloads.
- `src-tauri/src/commands/process_sandbox/desktop.rs`: desktop interaction capability detection, desktop script API scanning, and detached launch command inference.
- `src-tauri/src/commands/network_broker.rs`: main-process HTTP(S) broker, proxy server, target validation, DNS pinning, and CONNECT handling.
- `src-tauri/src/commands/command_validator.rs`: dangerous commands, protected paths, write redirection, and script-content scanning.
- `src-tauri/src/commands/trash_bin.rs`: soft-delete fallback for delete commands.
- `src-tauri/src/bin/agentvis_broker_fetch.rs`: Script `brokerOnly` helper.
- `src-tauri/src/bin/agentvis_wfp_helper.rs`, `src-tauri/src/bin/agentvis_wfp_network_probe.rs`: WFP experimental helper / probe.

## 15. Acceptance and Regression

Basic requirements after code changes:

- After modifying TS / TSX, run `eslint --fix --quiet` on changed files and run `tsc --noEmit`.
- After modifying Rust, run `cargo check`.
- Do not run global formatters; only process changed files.

Recommended sandbox-related regression:

- `cargo test process_sandbox`
- `cargo test --manifest-path src-tauri/Cargo.toml network_risk_checkpoint_matrix`
- `cargo test --manifest-path src-tauri/Cargo.toml detector_flags_high_confidence`
- `cargo test --manifest-path src-tauri/Cargo.toml broker_canary`
- `cargo test wfp_network_isolation`, only when WFP helper validation is needed.
- `src/services/planning/skills/shared/__tests__/sandboxPath.test.ts`
- `src/services/planning/skills/exec/__tests__/sandboxRuntimeHint.test.ts`
- `src/services/planning/skills/exec/__tests__/guideNetworkEntrypoint.test.ts`
- `src/services/planning/skills/external/__tests__/ExternalExecutor.test.ts`
- `src/services/planning/skills/external/__tests__/ExternalToolProvider.test.ts`
- `src/services/planning/skills/external/__tests__/ContractValidator.test.ts`
- `src/utils/__tests__/networkDirectRisk.test.ts`
- `src/services/preview/projectPathPolicy.test.ts`
- `src/services/preview/importMapAnalysis.test.ts`
- `src/services/preview/previewDependencyPolicy.test.ts`
- `src/services/preview/previewSourcePolicy.test.ts`
- `src/services/preview/trustedPreviewRuntime.test.ts`
- `src/services/preview/VitePreviewService.test.ts`
- `src/services/preview/VitePreviewServiceCleanup.test.ts`
- `src/services/preview/TemplateManager.test.ts`
- `cargo test background_registry` (background output tails, exit tombstones, and idempotent kill)
- `cargo test --manifest-path src-tauri/Cargo.toml preview_` (workspace identity, path/link validation, owner leases, stale pagination, and no-follow reclamation)

Suggested manual acceptance:

- Starting Chrome / VS Code / explorer in Local Audit Mode should not be accidentally killed by Job Object.
- In Offline Isolated Mode, deleting files outside workdir should be blocked, while deleting files inside workdir should enter Trash Bin.
- In Offline Isolated Mode, running `curl`, Python `requests`, or Node network scripts should fail closed.
- In Controlled Network, Git HTTPS / ordinary `curl` HTTP(S) should access normally through broker/proxy and write audit.
- broker canary should cover public redirect success, redirect-to-private block, and post-redirect DNS rebinding block.
- In Controlled Network, `curl --noproxy "*" https://example.com` should be blocked.
- In Controlled Network, `curl -x ""`, `git -c http.proxy=`, and `cmd /c "set npm_config_proxy=&& npm view ..."` should block with `proxy_bypass_signal_blocked`.
- In Controlled Network, Python `subprocess` / Node `child_process` scripts that spawn raw sockets again should be blocked by static scanning before the parent script executes.
- In Controlled Network, Playwright / Chromium scripts that explicitly pass `--proxy-server=direct://` or `--proxy-bypass-list=*` should be blocked before browser spawn.
- SSH / SCP / SFTP, database clients, and PowerShell `Test-NetConnection` should show direct-audit after targets are parsed.
- localhost / private targets only allow this run; metadata targets cannot be allowed under `ControlledNetwork`.
- If a hostname resolves to private/link-local/metadata, risk should be shown according to the resolved IP: private/link-local only allow this run, metadata has no allow path. Prefer encoded-IP hostnames such as `127.0.0.1.sslip.io` and `169-254-169-254.sslip.io` for stable manual regression. The HTTP broker path should identify encoded IPs before DNS and return `403 Forbidden`; audit detail should contain `resolvedRisk`, `resolvedRiskReason`, and `resolvedIpSamples`. Even if enterprise DNS rewrites real resolution to `198.18.x.x`, the target must not be treated as ordinary public internet.
- Successful network-intent tasks with broker request count 0 should only produce non-blocking `broker_proxy_expected_but_unused` diagnostics with `reasonClass` in detail for dashboard aggregation. Stable manual trigger: `echo https://example.com` should exit successfully, make no actual broker requests, and generate `reasonClass=tool_misclassification`.
- High-confidence upload, sensitive egress, and remote destructive commands should trigger one-time confirmation on first run; after confirmation, the current retry can execute and writes structured audit fields. `npm` / `pip` / `git`, read-only HTTP(S) queries, local downloads, `kubectl get`, `helm list`, `terraform plan`, `aws s3 ls`, and read-only database queries should not trigger these three confirmations.
- Automated scenario regression should at least cover `network_risk_checkpoint_matrix_covers_daily_and_high_risk_cases`, using the `id/group/expectation` matrix to verify both "normal daily tasks are not falsely blocked" and "explicit upload / exfiltration / destructive remote operations are detected." Common Windows `curl.exe -X DELETE` and database `DROP DATABASE` should keep remote-destruction priority and must not be preempted by ordinary `curl` intent or `proxy_bypass_signal_blocked` classification.
- Raw socket without host / port does not show authorization and is blocked directly.
- Script `brokerOnly` missing helper or broker session should fail closed and must not fall back to direct connection.
- Project Preview must reject absolute paths, UNC/drives, URLs, NUL, and `..` traversal before creating an iframe, and must not write staging data or `node_modules` into the deliverable directory.
- Native source-staging regression must cover immediate stop during streaming enumeration when entry/depth/file/byte limits are exceeded; rejection of both final symlink/reparse entries and an ancestor directory transiently replaced with a junction/symlink by opened-handle containment; same-handle text-size validation; read-only allowance of Windows static-asset hard links contained in one Agent workspace while rejecting out-of-workspace links; and asset-copy requirements for the current-process owner lease, hidden/package/lock/tsconfig/jsconfig skips, and no overwrite of existing staging files.
- A complete project must load staged Vite/PostCSS/Tailwind through the `.agentvis` wrapper, preserving plugins/aliases/CSS configuration, package type, project dependency versions, and in-staging root/env/public while overriding host/port/CORS/fs/cache plus health/diagnostics; snippets must not load those project configurations. `file:`/Git/HTTP/workspace/alias dependencies, a manifest over 256 KiB, more than 128 dependencies, or overlong package names/specifiers must be rejected before npm, and npm lifecycle scripts from valid project dependencies must not execute.
- A Vanilla Import Map project must take the static route only when the effective entry map (including `imports`/`scopes`) is valid, all bare imports are mapped, and modules are native-JS-only. A unique named root HTML file must use the same mode decision as a real `index.html`; malformed/unmapped maps and TS/TSX/JSX/Vue/module-CSS transform dependencies must fail before startup. Multiple root HTML files, nested projects, missing entries, non-Registry dependencies, and known non-Vite build contracts must be diagnosed separately. Missing bare dependencies in Vite mode, entry 4xx/5xx responses, runtime exceptions, unhandled rejections, and resource failures must enter actionable error UI; `.env` may only be counted for a notice, never read.
- After repeated starts, closing, Agent/project switches, and retries, only the latest run may remain active. Old PIDs, ports, installation executions, and staging workspaces must be reclaimed. An unrelated process pre-started on 3100-3110 must never be terminated by Preview.
- Staging reclamation must validate the direct child, UUIDv4 name, exact marker/token, link/reparse state, and canonical containment. Normal cleanup must also prove and release this process's registry lease and cannot remove another instance's workspace by borrowing marker/token data. Atomic quarantine is followed by no-follow deletion, and junctions have only the link removed. Windows regression must use a real file handle without delete sharing to cover both a transient lock recovered within bounded backoff and a persistent lock that times out, restores its lease, and succeeds after release. A partially deleted `.trash-{UUIDv4}` can be self-reclaimed only through a strictly paired root receipt at least 24 hours old; an orphan receipt additionally requires a strict name, self-consistent contents, a regular file, an absent paired trash, and the same age, while mismatches remain untouched. Stale pages handle only candidates inactive for at least 24 hours whose lease can be acquired. Frontend tests must cover per-pass bounds, fair rotation, timer teardown, and stale-sweep rearming after new failures or overflow.

ControlledNetwork regression matrix manual validation conclusions:

- Group A daily public-network tasks passed: `curl`, `npm view`, `pip index`, and `git ls-remote` all went normally through broker/proxy, with no upload confirmation, no direct-audit, and no hardBlock.
- Group B proxy bypass passed: `curl --noproxy "*"`, `curl -x ""`, `git -c http.proxy=`, and `cmd /c "set npm_config_proxy=&& set npm_config_https_proxy=&& npm view ..."` were all blocked with `proxy_bypass_signal_blocked` / `hardBlock` and were not allowed through direct-audit.
- Group C high-confidence upload confirmation passed, while complete canary evidence remains layered: in two manual retests, `curl --data-binary @file`, `curl -F file=@...`, `curl -T`, and PowerShell `Invoke-RestMethod -InFile` all triggered `network_upload_confirmation_required`; after the user selected "allow this time", `network_upload_risk_confirmed` was written and execution continued. A `webhook.site` endpoint can return 200, while a temporary Vercel endpoint returning 404 is classified as an endpoint routing issue, not a sandbox failure. One `Invoke-RestMethod` retest produced a non-blocking `broker_proxy_expected_but_unused` / `reasonClass=potential_direct_egress` diagnostic and should continue to be observed. Rust broker canary already covers the self-hosted upload body forwarding path; a stable public manual upload canary is still used to accumulate complete repeatable reports.
- Groups D/E/F direct-audit and metadata passed: public non-HTTP targets can be authorized for this run, private/local only allow this run, and metadata has no allow path and fails closed.
- Group G hostname-encoded IP risk passed: enterprise DNS/proxy rewrites `sslip.io` resolution to `198.18.x.x`, so the broker identifies encoded-IP hostnames before DNS. Retesting `127.0.0.1.sslip.io` returned `403 Forbidden` and recorded `resolvedRisk=private`, `resolvedRiskReason=hostnameEncodedPrivateOrLocalIp`, `resolvedIpSamples=127.0.0.1`; `169-254-169-254.sslip.io` returned `403 Forbidden` and recorded `resolvedRisk=metadata`, `resolvedRiskReason=hostnameEncodedMetadataIp`, `resolvedIpSamples=169.254.169.254`.
- Group H broker unused diagnostic closed the loop: daily `npm` / `pip` / `curl` all made broker requests and did not falsely report `broker_proxy_expected_but_unused`; `cmd /c echo https://example.com` exited successfully with broker request count 0, generating non-blocking `broker_proxy_expected_but_unused` with detail containing `reasonClass=tool_misclassification`.
- Group I sensitive-egress confirmation passed: four paths triggered `network_sensitive_egress_confirmation_required` on first run: sending a fake `.env` in a `curl` body, PowerShell script, Python `httpx`, and Node `axios`. The cancel path confirmed execution did not continue; the allow-this-time path wrote `network_sensitive_egress_confirmed`. Audit contained `riskClass=sensitiveEgress`, `riskKind`, `credentialContext`, and `networkIntent=sensitive_egress`. Script preparation should be written in separate steps to avoid a single `Set-Content` command text containing both "sensitive read + network send" and triggering a dialog early.
- Group J remote-destructive confirmation passed: `curl.exe -X DELETE` hit `curlDeleteMethod`; `kubectl delete`, `terraform destroy`, `gh repo delete`, and `aws s3 rm --recursive` hit their corresponding remote-destructive riskKinds; `psql ... DROP DATABASE ...` hit `databaseDestructiveQuery` and is no longer preempted by `proxy_bypass_signal_blocked`. Except for a disposable HTTP DELETE canary, real repositories, cloud accounts, clusters, and database commands default to cancel.
- WFP Canary real-task matrix passed. The positive Node classification item uses `node -e "console.log('node_probe https://example.com')"`, while bare `node fetch(...)` remains blocked as a high-confidence `nodeNativeFetchWithoutProxyAgent` bypass.
- Static scanning incremental-library negative tasks passed, covering `--proxy=direct://`, `$env:HTTP_PROXY=$null`, PowerShell `UseProxy=$false`, Python `proxies={'http': None}` / `ProxyHandler({})`, Node `axios { proxy: false }`, and undici direct dispatcher.

## 16. Refactoring Boundaries

Keep the following boundaries unchanged during future sandbox component refactors:

- The three user semantics remain stable: `LocalAudit`, `OfflineIsolated`, `ControlledNetwork`.
- `SandboxAuditEvent` is the stable UI and diagnostics contract; new fields must remain compatible with old UI and historical events.
- During `process_sandbox` splitting, keep re-exporting `types` / `audit` / `broker_audit` through the facade to avoid call-path churn in `shell.rs`, `network_broker.rs`, and `web_search.rs`.
- `ShellSandboxPolicy` should remain the single Rust-side parsing point for mode, lifecycle, network scope, and subject attribution.
- `ControlledNetwork` should not currently be refactored back to default AppContainer file isolation, because that would break the existing CLI / Skill token cache experience.
- direct-audit must continue requiring exact targets and backend exact matching. It must not degrade into "allow a protocol" or "allow a Skill to direct-connect arbitrarily."
- Before WFP or an equivalent network-only guard is promoted to a default capability, it must go through audit / would-block observation, false-block regression, recovery path validation, and i18n copy validation.
- When adding a network protocol broker, first define target validation, secret redaction, audit fields, size / timeout limits, and failure recovery semantics.

## 17. Roadmap

Further ControlledNetwork improvements should continue around "practical by default, clear diagnostics, confirmable key risks." As of 2026-06-01, tests in `AgentVis ControlledNetwork 回归矩阵.md` all pass as expected. The A-J manual regression matrix, broker canary, static scanning incremental library, and high-confidence network risk confirmations have formed a repeatable baseline. Follow-up work mainly shifts from "filling core capabilities" to "expanding the real-task corpus, enterprise network compatibility, WFP default-readiness evaluation, and long-term regression dashboards." Before WFP or an equivalent network-only guard is defaulted, do not describe default Controlled Network as full-protocol hard isolation or DLP.

Closed-loop capability note: `agent-browser`, as the default AgentVis browser automation Skill, has completed the Controlled Network proxy contract closure. The roadmap item for "browser Skill proxy contract" is mainly kept for generalizing to other Playwright / Chromium Skills, enterprise network matrices, and long-term regression baselines.

1. **P0.5: Solidify the A-J manual regression baseline**. After each sandbox networking change, cover at least daily public network, explicit proxy bypass, high-confidence upload / sensitive egress / remote destructive confirmations, direct-audit public/private/metadata, hostname-encoded IP risk, and broker unused `reasonClass`.
   - Status: `AgentVis ControlledNetwork 回归矩阵.md` has been added, with A-J manual task prompts and report templates that can be copied directly to an Agent. Manual regressions from 2026-05-29 to 2026-06-01 covered A/B/C/D/E/F/G/H/I/J and matched expectations. Stable public upload / egress / delete canaries remain follow-up manual-environment quality items and do not affect the core security-chain conclusion.
   - A: `curl` / `npm view` / `pip index` / `git ls-remote` go normally through broker/proxy with no false block.
   - B: explicit bypasses such as `curl --noproxy "*"`, `curl -x ""`, `git -c http.proxy=`, and `cmd /c "set npm_config_proxy=&& set npm_config_https_proxy=&& npm view ..."` are blocked by `proxy_bypass_signal_blocked`.
   - C: `curl --data-binary @file`, `curl -F file=@...`, `curl -T`, and PowerShell `Invoke-RestMethod -InFile` trigger upload confirmation on first run and continue for the current retry after confirmation; remote 404 / 5xx is interpreted with audit as endpoint routing or stability issue, not a sandbox failure.
   - D/E/F: direct-audit public can be authorized; private/local only allow this run; metadata has no allow path.
   - G: the HTTP broker identifies encoded IPs in `127.0.0.1.sslip.io` / `169-254-169-254.sslip.io` before DNS, returns `403 Forbidden`, and records `resolvedRisk`, `resolvedRiskReason`, and `resolvedIpSamples`.
   - H: daily tasks do not falsely report `broker_proxy_expected_but_unused`; `cmd /c echo https://example.com` reliably triggers a non-blocking diagnostic with `reasonClass=tool_misclassification`.
   - I: combinations of sensitive file / environment-variable reads and network body sends trigger `network_sensitive_egress_confirmation_required`; cancel does not continue execution, and allow-this-time writes `network_sensitive_egress_confirmed`.
   - J: HTTP DELETE, database drop, cloud resource destruction, and similar high-confidence remote-destructive commands trigger `network_remote_destructive_confirmation_required`; `curl.exe -X DELETE` and `psql DROP DATABASE` cover previous missed-detection / misclassification gaps.
2. **P0.5: Stabilize self-hosted canaries**. Keep and extend broker self-hosted canaries to cover public redirect success, redirect-to-private block, and post-redirect DNS rebinding block. Third-party public redirect / upload services may only be auxiliary and must not be the sole acceptance basis.
   - Status: broker self-hosted canary test scaffolding has been added. Test-only DNS override separates the public validation address from the local canary server connection address and only takes effect under `#[cfg(test)]`.
   - Status: upload canary automation has been added to verify broker-delegated POST body forwarding, target validation, and `bytes_out` semantics, avoiding unstable remote services such as `httpbin.org` / temporary Cloudflare endpoints from affecting sandbox conclusions.
   - Status: `cargo test --manifest-path src-tauri/Cargo.toml broker_canary` is now the Broker Canary targeted automation entrypoint, covering public redirect success, upload body + `bytes_out`, redirect-to-private / metadata block, post-redirect DNS rebinding block, hostname-encoded private/metadata pre-DNS block, and POST redirect rejection.
   - Follow-up only needs one stable public manual canary endpoint for real Agent manual reports to cover the full Group C chain. If manual reports show `broker_proxy_expected_but_unused.reasonClass=potential_direct_egress`, record it separately as a proxy-usage diagnostic. It does not affect the upload-confirmation conclusion, but it is not proof of broker body forwarding.
3. **P1: Audit dashboard and reason code stability**. Turn high-signal fields into aggregatable contracts, prioritizing `broker_proxy_expected_but_unused.reasonClass`, `resolvedRisk` / `resolvedIpSamples` / `resolvedRiskReason`, `network_upload_*`, `network_sensitive_egress_*`, `network_remote_destructive_*`, `proxy_bypass_signal_blocked.matchedPattern`, and `wfpCanary.taskCategory`.
   - Status: the audit UI has added high-signal summaries and event-level signal display. Sub-Agent observation can surface broker encoded-hostname risk detail. High-confidence network risk confirmation events write `riskClass`, `riskKind`, and `credentialContext`. The goal is for product and regression reports to distinguish cache hit, detection misclassification, suspected direct egress, user-confirmed upload / sensitive egress / remote destruction, DNS risk, and WFP observation rather than only seeing "blocked/failed."
4. **P1: direct-audit DNS hardening**. `resolvedRisk` / `resolvedIpSamples` / `resolvedRiskReason` are currently displayed, and hostname-encoded IP is supported. Later retry authorization can pin the current resolved IP to reduce DNS rebinding risk.
   - Status: hostname-encoded IP recognition is used both for direct-audit risk display and HTTP broker target validation. Private/local/metadata encoded targets fail closed in the broker path.
   - Proxy/load-test mapping addresses such as `198.18.0.0/15` continue to keep public authorization experience and diagnostic marking. Whether to upgrade them to `reserved` / `unknown` belongs to enterprise policy or an administrator switch, not default blocking.
5. **P1: High-confidence network risk confirmation matrix**. Continue to insist that this is not DLP and does not inspect file content; only expand high-confidence upload, sensitive egress, and remote-destructive semantics and test matrix.
   - Status: three one-time confirmation classes have landed: `fileUpload`, `sensitiveEgress`, and `remoteDestructive`, writing `network_upload_risk_confirmed`, `network_sensitive_egress_confirmed`, and `network_remote_destructive_confirmed` respectively. Frontend retry passes only the current confirmed flag and does not persist authorization.
   - Status: the Rust regression matrix `network_risk_checkpoint_matrix_covers_daily_and_high_risk_cases` covers daily negative cases, upload, sensitive egress, and remote destructive scenarios. The 2026-06-01 I/J manual retest verified cancel path, allow-this-time path, and structured audit fields.
   - Future expansion should only absorb high-confidence variants from real Agent tasks, such as PowerShell `-Form`, Python `requests/httpx files = ...` with multiple variables/lines, Node `FormData + fs.createReadStream` variable flows, and more cloud CLI delete commands. Normal `npm` / `pip` / `git` / read-only HTTP(S) queries should not trigger these three confirmations.
6. **P1: Browser Skill proxy contract**. The `agent-browser` default path is closed. When generalized to other Playwright / Chromium Skills, still standardize reading `AGENTVIS_BROWSER_PROXY_SERVER` / `USERNAME` / `PASSWORD` (username and password may be empty) and passing launch proxy parameters, forbid credential URLs and direct/bypass parameters, and keep real page, bad proxy auth, private target, and CONNECT audit regression.
   - Browser proxy credential URLs have been added to high-confidence bypass signals. `--proxy-server=http://user:pass@...` and Playwright script `proxy.server` credential URLs fail closed in the Controlled Network path; agent-facing observation also redacts generic credential URLs.
   - The `agent-browser` main path advances around the dedicated CDP Chrome runtime: Controlled Network only opens narrow paths for `start-chrome-debug.bat` / CDP commands bound to an `agentvis-cdp-*` session. The launcher forces broker browser proxy, rejects direct/bypass/credential proxy Chrome arguments, and uses runtime state to prevent silently reusing old Chrome launched under Local Audit Mode.
   - Manual regression on 2026-05-30 verified that startup, navigation, snapshot, screenshots / annotated screenshots, fill / click / press, scroll, wait, get text / attr, screenshot cleanup, window minimization, and runtime close all work stably under Controlled Network. `browser-command.bat close` becomes runtime graceful stop to avoid Chrome restore pages.
   - Browser runtime uses a local one-time proxy endpoint; users should not see or enter proxy auth. `browser-command.bat` clears normal proxy env interference on the local CDP control plane and restores minimization after screenshots.
7. **P1: WFP canary real-task matrix**. Continue observing whether broker-preferred commands have direct egress, focusing on `curl` / `git` / `npm` / `pip` / Python / Node / Playwright / Chromium / background / cleanup. Canary only writes diagnostics and does not block by default.
   - `taskCategory` has been added to canary diagnostic detail to distinguish matrix rows such as `curl`, `git`, `npm`, `pythonPackage`, `node`, `pythonBrokerProxyPreferred`, `background`, and `proxyBypass:*`. This field is only for audit diagnostics and does not change blocking behavior.
   - Status: `taskCategory` now runs through canary preflight, session stop, and actual result. Playwright / Chromium / `npx playwright` / `node *playwright*` are classified as `browser`, and WFP residual cleanup is classified as `cleanup`, making dashboards easier to aggregate by real-task matrix.
   - Verification: manual regression passed on 2026-05-30. The positive Node classification item uses non-networking `node_probe`; bare `node fetch(...)` remains blocked as a high-confidence `nodeNativeFetchWithoutProxyAgent` bypass.
8. **P1: Static scanning incremental library**. Continue absorbing wrapper / shell / runtime variants from real Agent tasks, but only block high-confidence bypass and high-confidence network risk signals. Low-confidence paths enter canary / suspicious audit to avoid falsely blocking normal local scripts.
   - Status: high-confidence proxy-disabling variants have been added, including `--proxy=direct://` / `$env:HTTP_PROXY=$null`, PowerShell `UseProxy=$false` / `Proxy=$null`, Python `proxies={'http': None}` / `ProxyHandler({})`, Node `axios { proxy: false }`, and undici `setGlobalDispatcher(new Agent())`. PowerShell wrappers that immediately `Set-Content` and execute Python/Node scripts are covered, as is `$env:VAR\script.py` path parsing. Low-confidence script shapes are still not upgraded directly into blocking.
   - Status: remote-destructive detection covers common Windows `curl.exe -X DELETE`, and has priority over proxy bypass / direct-audit classification in the ControlledNetwork shell main chain. Database `DROP DATABASE` and similar destructive signals enter remote-destructive confirmation first.
   - Verification: negative regression from 2026-05-30 to 2026-06-01 passed. Python `proxies=None` and `ProxyHandler({})` retries both hardBlock before networking and hit `pythonProxyEnvDisabled`. Group J retest verified that `curlDeleteMethod` and `databaseDestructiveQuery` hit as expected.
9. **P2: Enterprise network compatibility matrix**. Continue recording behavior of `curl` / `git` / `npm` / `pip` / browser tasks under system proxy, PAC, VPN, EDR, Defender, Heysocks, Clash, and corporate gateway.
   - Focus observations on `198.18.0.0/15`, local proxy mapping, DNS rewriting, proxy auth, CONNECT behavior, and WFP/VPN/EDR policy overlap.
   - Status: a P2 enterprise network compatibility matrix has been added to `AgentVis ControlledNetwork 回归矩阵.md`; fixed scenario tags are `baseline`, `system-proxy`, `pac-or-autodetect`, `vpn-on`, `local-proxy-tool`, `corp-gateway-edr`, and `dns-198-18-mapping`.
   - Status: read-only collection script `scripts/collect-enterprise-network-env.ps1` has been added to generate JSON / Markdown environment snapshots for the current scenario. The script does not automatically switch proxy, VPN, firewall, or EDR, and defaults output to `%TEMP%\agentvis-enterprise-network-matrix`.
   - Verification: the 2026-05-30 `NetworkedIsolateTest` scenario passed, covering Heysocks TAP, local WinINET proxy, proxy environment variables, Defender / Firewall enabled, and DNS `198.18.x.x` mapping. A/B/G/H and `broker_canary` all matched expectations.
10. **P2: Expand non-HTTP(S) target preflight as needed**. Add direct-audit integration for read-only target discovery for more databases, message queues, and cloud CLIs. Do not introduce transparent TUN/SOCKS/full-protocol broker.
11. **P2: WFP hard guard experimental switch**. Enable only when per-run identity is clear, broker proxy port is known, loopback broker proxy is allowed, and cleanup can complete. Keep it as an advanced/experimental switch first, not a default three-mode promise.

Default-readiness criteria for WFP hard guard:

- Daily HTTP(S), Git HTTPS, npm/pip, common API helpers, and Playwright public HTTPS tasks have no direct egress under canary, or only explainable broker loopback.
- `NO_PROXY`, clearing proxy, raw socket, metadata/private targets, and browser direct proxy parameters can all be captured by static scanning or WFP observation.
- Missing privileges, VPN/EDR conflict, residual cleanup, detached/background coverage gaps all have clear audit reasons and recovery paths.
- UI / i18n clearly explains that canary is diagnostic enhancement and hard guard is an experimental/advanced policy; default Controlled Network must not be misdescribed as full-protocol hard no-network.

## 18. Update Checklist

For every sandbox mechanism iteration, check the following parts of this document:

- Whether the three-mode permission matrix is still accurate.
- Whether `shell_execute` parameters, default mapping, and lifecycle rules changed.
- Whether file boundaries affect native tools, Trash Bin, AppContainer grants, or sandbox profile.
- Whether network broker/proxy environment variables, target validation, proxy-bypass signals, and direct-audit rules changed.
- Whether Skill frontmatter / Contract fields were added or changed semantically.
- Whether `SandboxAuditEvent` fields, reason, backend, or guardMode were added.
- Whether UI added user-visible copy and whether it is wired through i18n.
- Whether tests and manual acceptance checklist cover the new risk surface.
