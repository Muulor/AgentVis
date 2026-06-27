# AgentVis Sandbox Permissions and Security Audit Guide

> Scope: A single Agent's "Agent Settings -> Basic -> Sandbox permissions", and sandbox, broker/proxy, and network-protection events in "Settings -> Security Audit".

---

## 1. What This Guide Covers

AgentVis can let Agents read and write files, run commands, call skills, access the network, and use browser or desktop automation when the appropriate permissions are enabled. Sandbox permissions define the boundaries of these operations.

You can think of sandbox permissions as choosing a working mode for an Agent:

- Work like a local assistant while keeping audit records and dangerous-operation protection.
- Access the network while routing network egress through AgentVis audit paths as much as possible.
- Run in a stricter isolated environment, suitable for untrusted scripts and high-risk tasks.

The sandbox exists to make high-risk Agent operations more explainable, auditable, and recoverable.

---

## 2. Where to Set Sandbox Permissions

Open an Agent:

1. Go to "Agent Settings".
2. Click "Basic" at the top.
3. Find "Sandbox permissions".
4. Choose "Local Audit", "Controlled Network", or "Offline Isolated".
5. Click "Save".

Sandbox permissions are configured per Agent. Different Agents can use different permissions according to your needs.

---

## 3. How to Choose Among the Three Modes

| Mode | When to use it | Boundaries you should know |
| --- | --- | --- |
| Local Audit | Daily tasks, local project development, tasks that need local files and desktop capabilities | Dangerous-command blocking, protected paths, dangerous-script scanning, soft delete, and audit are enabled by default |
| Controlled Network | Tasks that need network access with stronger network safety, such as webpages, GitHub, cloud APIs, email, and networked skills | Focuses on network egress audit, not full virtual-machine isolation; normal tasks can still reuse local files and credential caches |
| Offline Isolated | Untrusted third-party skills, high-risk scripts, tasks that only process local workspace files | No network, limited file boundaries, no desktop control, screenshots, hotkeys, or external GUI launch |

If you are not sure, use this rule of thumb:

- Default daily use: choose "Local Audit".
- Daily use with safer network behavior: choose "Controlled Network".
- Untrusted scripts or skill sources: choose "Offline Isolated".
- When a task is blocked: check "Security Audit" first, then decide whether to adjust permissions.

---

## 4. Local Audit Mode

"Local Audit" is the default mode best suited for everyday work. The Agent can operate files, run commands, use common development tools, and use desktop capabilities like a local assistant.

It is suitable for:

- Daily office tasks.
- Reading and writing code in local projects.
- Running tests, builds, and scripts.
- Opening browsers or using desktop automation.
- Using local CLI tools, configuration, and caches.

But it is not an unrestricted mode. AgentVis still keeps multiple protection layers:

- Dangerous-command checks and blocking.
- Interception for system protected paths and custom protected directories.
- Delete operations go through Trash Bin soft delete.
- Suspicious scripts are scanned before execution.
- Key execution events are written to audit logs.

If you trust the current Agent and task source, Local Audit usually provides the best experience.

---

## 5. Controlled Network Mode

"Controlled Network" is suitable for tasks that need external network access while keeping network behavior auditable.

It is suitable for:

- Daily office tasks.
- Calling cloud APIs or third-party HTTP(S) services.
- Using Script skills that need network access.
- Using AgentVis dedicated browser automation to access webpages.

You should know:

- Controlled Network focuses on controlling network egress. It does not isolate the entire local file system.
- HTTP(S) traffic will preferentially go through the AgentVis broker/proxy audit path.
- Script skills can declare broker-only, requiring scripts to send requests through the AgentVis broker.
- Non-HTTP(S) direct connections require clearer targets and authorization.
- Regular `exec` and Guide skills currently do not claim that all direct connections are fully captured at the OS layer.

Controlled Network is not simply "allow network access". It turns common high-risk network behavior into blockable, confirmable, and auditable actions.

| Risk scenario | How AgentVis handles it |
| --- | --- |
| Bypassing the proxy | Identifies high-confidence bypass signals such as `NO_PROXY=*`, `curl --noproxy`, clearing proxy variables, direct proxy, and raw sockets, then blocks before execution. |
| Accessing localhost, private networks, or cloud metadata | The broker/proxy rejects localhost, private, link-local, metadata, and similar targets. It also identifies private-network or metadata addresses encoded in hostnames. |
| Non-HTTP(S) direct connections | Does not allow broad pass-through. The protocol, host, port, and source must be explicit enough before entering the direct-audit authorization flow. |
| Uploading local files | Commands that clearly upload local files trigger one-time confirmation. The confirmation only applies to the current retry. |
| Sensitive exfiltration | High-confidence combinations such as reading `.env` or environment variables and putting their content into a network body trigger confirmation. |
| Remote destruction | High-risk operations such as deleting remote repositories, destroying cloud resources, dropping databases, or clearing remote storage trigger confirmation. The default recommendation for real accounts and real resources is to cancel. |
| Credential leakage | Broker-managed credentials do not enter command lines, environment variables, logs, or observations, and are injected only for HTTPS and exact host allowlists. |
| Hard-to-debug task failures | Security Audit records reason codes, target hosts, sources, and protection modes to help distinguish proxy bypass, target risk, missing authorization, and runtime environment differences. |

Boundary note: Controlled Network is not a full virtual machine, a transparent proxy for all protocols, or generalized DLP. It focuses on narrowing network egress and high-confidence risky actions. It does not describe the default mode as full protocol-level hard isolation.

If a task reports that proxy bypass, upload, sensitive exfiltration, or remote destruction was blocked, check Security Audit first instead of immediately switching to a looser mode.

---

## 6. Offline Isolated Mode

"Offline Isolated" is the strictest common mode. It is suitable when you do not fully trust a task or skill.

It is suitable for:

- Running a third-party untrusted skill for the first time.
- Processing scripts from unknown sources.
- Reading and writing only the current workspace files, with no need for network access.
- Minimizing the risk of scripts accessing the local environment.

Offline Isolated brings these limits:

- Network access is disabled.
- File access is limited to the workspace and application-managed directories.
- Desktop control, screenshots, hotkeys, and window activation are disabled.
- Launching external GUI or detached applications is disabled.
- Some skills that depend on the local Home directory, AppData, or CLI token caches may not work normally.

If the task truly needs network or desktop capabilities, Offline Isolated may not be the right mode.

---

## 7. How to Read the Security Audit Page

Open AgentVis:

1. Go to "Settings".
2. Click "Security Audit" on the left.

The Security Audit page shows recent sandbox, broker/proxy, and network-protection events.

### 7.1 Top Statistics

The top numbers help you quickly understand recent events:

- Recent events: total number of recently recorded security-related events.
- Audit: events recorded but not necessarily blocked.
- Blocked: risky actions the system has prevented.
- Diagnostics: auxiliary information about proxy, broker, network path, or runtime environment state.

Diagnostics do not necessarily mean a task failed. Some diagnostics only tell you "this run did not actually send a broker request" or "a cache may have been hit."

### 7.2 Filters

You can filter by:

- Decision: view all, audit, blocked, or diagnostic events.
- Backend: sources such as Broker, Sandbox, or command validation.
- Source: whether the event came from a command, skill, tool, or another execution path.
- Reason: search by specific reason code.
- Protection mode: filter by Local Audit, Controlled Network, or Offline Isolated.
- Target host: troubleshoot events for a specific domain or address.
- Subject ID: locate related records by command or Skill ID.

### 7.3 How to Read an Event

For an audit event, usually check:

- Label: whether it is audit, blocked, or diagnostic.
- Title: often shows the command, target, proxy session, or risk type.
- Time: when the event occurred.
- Source: whether it came from `exec`, Skill, browser, broker, or another tool.
- Mode: which sandbox permission was in use.
- Reason: why it was recorded or blocked.
- Target: for network events, check the target host or protocol.

If you only want to solve "why did the task fail", prioritize blocked events. If you are troubleshooting whether network traffic used the proxy as expected, check diagnostic events.

---

## 8. Common Blocks and How to Handle Them

### 8.1 A Task Cannot Access the Network

Check:

1. Whether the current Agent uses "Offline Isolated".
2. Whether a Script skill declared no network access.
3. Whether proxy-bypass signals were blocked.
4. Whether the task accessed localhost, private networks, metadata, or other high-risk targets.
5. Whether you need to switch to "Controlled Network".

### 8.2 Browser or Desktop Control Failed

Check:

1. Whether the current Agent uses "Offline Isolated".
2. Whether the current Agent uses "Controlled Network" while the task needs general desktop control.
3. Whether the skill declared desktop-control capability.
4. If the task is only browsing webpages, prefer the dedicated AgentVis `agent-browser` browser automation skill.

In general, arbitrary desktop control is better suited to "Local Audit". Controlled Network only opens a narrow path for dedicated browser automation capabilities.

### 8.3 A Third-Party Skill Cannot Access Files

Check:

1. Whether the current Agent uses "Offline Isolated".
2. Whether the file is inside the current workspace or an application-allowed directory.
3. Whether the Script skill declared the file or directory parameters it needs for this run.
4. Whether you can move the task files into the current workspace and retry.

### 8.4 A Network Command Reports Proxy Bypass

Controlled Network blocks some explicit proxy-bypass behavior, such as:

- Clearing `HTTP_PROXY` / `HTTPS_PROXY`.
- Setting `NO_PROXY=*`.
- Using `curl --noproxy`.
- Using raw sockets, SSH, FTP, direct database connections, or other non-HTTP(S) network capabilities.
- Specifying a direct proxy in browser launch arguments.

How to handle it:

- If it is a normal HTTP(S) request, remove the proxy-bypass arguments and retry.
- If a non-HTTP(S) direct connection is truly required, follow the interface prompt for explicit target authorization.
- If the target is an internal network, localhost, or metadata address, proceed carefully. Do not allow it casually just to make the task continue.

### 8.5 Upload, Sensitive Exfiltration, or Remote Destruction Is Blocked for Confirmation

Controlled Network triggers one-time confirmation for three kinds of high-confidence risk:

| Risk type | Example | Recommendation |
| --- | --- | --- |
| File upload | `curl -F file=@...`, uploading a local file | Allow this run only when you trust the target. |
| Sensitive exfiltration | Reading `.env` or environment variables and sending them in a network body | Cancel by default unless you clearly know the content and target. |
| Remote destruction | Deleting remote repositories, cloud resources, or databases | Cancel by default, especially on real accounts and real resources. |

Confirmation only applies to the current retry. It does not become long-term authorization.

---

## 9. Relationship Between Skills and Sandbox

Skills are also affected by the current Agent sandbox permissions when they run.

### 9.1 Guide Skills

Guide skills mainly provide capability instructions to the Agent. They usually follow the current Agent sandbox permissions.

Examples:

- Under Local Audit, Guide skills can guide the Agent to use local commands or file capabilities.
- Under Controlled Network, HTTP(S) network behavior from Guide skills preferentially enters the broker/proxy audit path.
- Under Offline Isolated, Guide skills cannot depend on external network access or general desktop control.

### 9.2 Script Skills

Script skills can declare more explicit execution requirements in their definitions, such as:

- Which parameters are required.
- Whether network access is needed.
- Whether broker-only network egress is required.
- Whether file-system authorization is required.
- Whether desktop control is required.

If the capability declared by a Script skill conflicts with current sandbox permissions, AgentVis prioritizes user safety and may block execution or return diagnostics.

Examples:

- A Script skill that needs network access may fail under Offline Isolated.
- A Script skill that declares desktop control may be blocked under Controlled Network or Offline Isolated.
- If a broker-only skill cannot use the broker helper, it fails closed instead of falling back to a direct connection.

---

## 10. Lightweight Technical Notes

This section is for users who want to understand mechanism boundaries. Daily users can skip it.

### 10.1 AgentVis Protection Is Not a Single Layer

A command or skill execution roughly goes through:

1. Agent planning and prompt constraints, or a custom Safety Footer anchoring safety rules.
2. TypeScript tool-layer checks, such as path boundaries, risk levels, and user confirmations.
3. Rust command validation, such as dangerous commands, protected paths, and script scanning.
4. Process and network sandboxing, such as Job Object, AppContainer, broker/proxy, and direct-audit.
5. Trash Bin soft delete and audit records.

### 10.2 Controlled Network Is Not a Full Virtual Machine

The purpose of Controlled Network is to be controllable and practical. It does not unconditionally block all Agent network behavior. It avoids unnecessary blocking for normal safe tasks, and makes network egress more controllable and auditable, rather than placing the Agent inside a full virtual machine.

Current semantics can be summarized as:

- Normal HTTP(S) should use broker/proxy as much as possible.
- Script `brokerOnly` can enter a stronger delegated-request path.
- Non-HTTP(S) direct connections require clearer targets and authorization.
- It does not promise transparent proxying for all protocols, TUN, SOCKS, or complete OS-level network interception by default.
- It does not implement generalized DLP or inspect file content. It only confirms high-confidence uploads, sensitive exfiltration, and remote destruction.

### 10.3 Offline Isolated Is More Like a Safe Workroom

Offline Isolated tries to keep the task within the workspace and application-managed directories, and hard-disables network access. It is better for "try it safely first", but it is not suitable for every task.

If a skill needs to read your existing local CLI token, browser configuration, cloud-service cache, or network API, Offline Isolated may prevent it from working normally.

### 10.4 Local Audit Still Has Protection

Local Audit is not "turning off the sandbox". It still keeps command protection, path protection, script scanning, Trash Bin, and audit. Its file and network boundaries are simply closer to the everyday local-assistant experience.

---

## 11. Common Usage Recommendations

| Scenario | Recommended mode |
| --- | --- |
| Daily office work, research, analysis | Local Audit / Controlled Network |
| Modifying local project code and running tests | Local Audit |
| Generating webpages or starting a local preview server | Local Audit |
| Running a newly installed unknown skill | Offline Isolated or Controlled Network |
| Handling untrusted scripts or workspace-file tasks | Offline Isolated |
| Using browser automation to access webpages | Local Audit, or dedicated browser capability under Controlled Network |
| Uploading files to an external service | Controlled Network, and confirm that the target is trusted |
| Remote deletion, destruction, or database-drop operations | Controlled Network, where confirmation is cancelled by default |

---

## 12. Recommended Configuration Checklist

Before daily use, quickly confirm:

- The current Agent sandbox permissions match the task risk.
- Untrusted skills are first tried in a stricter mode.
- Tasks that need network access do not use Offline Isolated.
- Tasks that need desktop control prefer Local Audit.
- After a task is blocked, check "Settings -> Security Audit" first.
- Stay cautious with upload, sensitive exfiltration, and remote destruction confirmations.
- Do not blindly switch to a looser mode just to make a task continue.
