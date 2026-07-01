# AgentVis Skill Feature Technical Documentation

> Last updated: 2026-06-21
> Audience: developers / skill-package developers / product team

---

## Table of Contents

1. [Overview](#overview)
2. [Skill Classification](#skill-classification)
3. [Native Skill](#native-skill)
4. [External Skill](#external-skill)
   - [Built-in skill-creator](#built-in-skill-creator)
   - [Guide Mode](#guide-mode)
   - [Script Mode](#script-mode)
5. [Skill Package Format: SKILL.md Specification](#skill-package-format-skillmd-specification)
6. [Installation Flow](#installation-flow)
7. [Trigger Mechanism](#trigger-mechanism)
8. [Security Review Mechanism](#security-review-mechanism)
9. [Python Runtime Environment](#python-runtime-environment)
10. [Troubleshooting](#troubleshooting)

---

## Overview

A Skill is a capability extension unit for AgentVis Sub-Agents. In the current implementation, Native Skills are injected as native Tools; External Guide Skills are injected as manuals, scripts, and resource context; External Script Skills execute through the unified native tool `external_skill_execute` according to a contract. Not every external Script is registered as an independent Tool.

- **SKILL.md is both documentation and code**: skill metadata, trigger rules, user manual, and execution contract all live in the same Markdown file.
- **Dual-track architecture**: built-in native skills (fixed at build time) and external skill packages (hot-loaded at runtime) coexist without interfering with each other.
- **Dual-mode execution**: external skills support Guide Mode, where the LLM decides the execution path, and Script Mode, where execution is strictly parameterized and contract-driven.

---

## Skill Classification

```text
Skill
+-- Native Skill                         <- Built in, bundled at build time, no installation needed
|   +-- exec          Shell command execution
|   +-- read          File reading
|   +-- file_write    File writing
|   +-- web_search    Web search
|   +-- local_search  Local code search (grep / AST / outline)
|   +-- cron          Scheduled task management
|   +-- generate_image Image generation
|   +-- im_send       IM message sending (Feishu / Slack)
|   +-- conversation_search  Search conversation history.
|   +-- external_skill_execute Script Skill contract execution entrypoint
|
+-- External Skill                       <- User-installed or bundled package, loaded at runtime
    +-- Guide Mode   SKILL.md is a capability manual for the LLM
    +-- Script Mode  SKILL.md contains an Execution Contract and is called through external_skill_execute
```

> **Name protection**: the current registration conflict check protects `exec`, `read`, `file_write`, `web_search`, and `external_skill_execute`. External skill packages must not use these names. They should also avoid other native tool names, such as `local_search`, `cron`, `generate_image`, and `im_send`, to avoid confusing LLM tool selection.

---

## Native Skill

### Loading Mechanism

Native Skills are embedded into the build output **at build time** through Vite `import.meta.glob`, which loads every `SKILL.md` as a raw string:

```typescript
const skillModules = import.meta.glob('./**/SKILL.md', {
    eager: true,
    query: '?raw',
    import: 'default',
});
```

The `SkillLoader` singleton parses all SKILL.md files immediately when instantiated and builds an in-memory cache (`Map<skillName, SkillDefinition>`). The whole process is synchronous, and callers do not need to wait for any asynchronous operation.

### SKILL.md Structure for Native Skills

```markdown
---
name: exec
description: Run build commands, execute scripts...
category: execution    # file_operation | search | execution | external | custom
complexity: 4          # 1-5, affects token allocation strategy
requiresAuth: true     # Whether user authorization is required
---

# exec tool

(Body content: When To Use, When Not To Use, parameter table, examples...)
```

### Injection Timing

`SkillLoader.getAllSync()` returns the `fullContent` of all native skills, meaning the complete Markdown after frontmatter. When `SubAgentPromptBuilder` builds an SA system Prompt, it injects each skill's `fullContent` into the description block of the corresponding tool, so the Sub-Agent has the full usage guide before calling the tool.

---

## External Skill

### Filesystem Layout

External skill packages are ultimately stored as directories under `packages/` in AppData. User-installed packages, GitHub-downloaded packages, and built-in external skill packages bundled with the installer are normalized into this scan path. Built-in external skills in release installers come from `src-tauri/skills-bundle/` and are deployed to AppData by the Rust side on first startup as needed.

```text
{AppDataDir}/skills/external/
+-- packages/
    +-- html-slides/           <- Skill package directory (directory name is only a path identifier)
    |   +-- SKILL.md           <- Required skill definition file
    |   +-- scripts/           <- Optional executable scripts
    |   +-- resources/         <- Optional resources such as themes and templates
    +-- web-scraper/
    |   +-- SKILL.md
    |   +-- main.py            <- Script Mode entrypoint
    +-- _disabled-pkg/         <- Directories starting with _ are skipped (disable convention)
```

### Scanning and Registration

After app startup, `App` preloads external skill scanning. In the Planning path, `SkillLoader.loadAllSkills()` also triggers the same `bootstrapExternalSkills()` Promise, ensuring concurrent calls only execute once. Planning is unblocked after scanning and registration complete, while additional dependency installation continues asynchronously in the background:

```text
App preload / SkillLoader.loadAllSkills()
    +-- ExternalSkillBootstrap.bootstrapExternalSkills()
        +-- ExternalSkillRegistryLoader.scanAll()      <- Scan packages/ directory
        +-- Automatic mode detection (execution.entry -> Script; otherwise -> Guide)
        +-- Script Mode: ContractValidator validates the contract
        +-- Guide Mode: collect scriptFiles + resourceFiles
        +-- skillLoader.registerExternal(skill)        <- Inject into SkillLoader
        +-- RuntimeStore.setInstalledSkills(...)       <- Update skill management list
        +-- SkillRetriever.register(guideSkills)       <- Build Guide vector index
        +-- launchBackgroundInstall()                  <- Install pending dependencies in background
```

---

### Built-in skill-creator

AgentVis bundles the external skill `skill-creator` with the installer. It lets Agents create, modify, and optimize AgentVis Skills. It is not a simple copier of generic Skill templates; it chooses architecture according to AgentVis's dual-mode mechanism:

- **Guide Skill**: broadly consistent with common Skill formats in the broader ecosystem. Its core is the body text of `SKILL.md`. It is suitable for open-ended workflows, creation, analysis, resource usage instructions, and cases where the Agent should choose among multiple scripts or commands.
- **Script Skill**: an execution-oriented AgentVis-specific form. Its core is the `execution` contract in frontmatter. It is suitable for stable inputs and outputs, parameterized scripts, HTTP API queries, brokerOnly network/credential audit, and similar scenarios. It is called at runtime through `external_skill_execute`.

`skill-creator` preserves the existing skill shape when possible: an existing Guide is not converted into Script merely because network or sandbox adaptation is involved. It only guides users toward Script Skill when the task naturally fits stable parameters and a fixed entrypoint. For user-facing selection guidance, see [AgentVis Skill Usage Guide](../User%20Guide/AgentVis%20Skill%20Usage%20Guide.en.md).

---

### Guide Mode

In Guide Mode, SKILL.md is a **capability manual** for the LLM. It tells the Agent **what it can do** and **how to do it**, but does not constrain the execution path. The Agent may freely use `exec` to call scripts inside the skill package, or write code directly to implement the task.

**Typical structure:**

```markdown
---
name: html-slides
description: Create polished HTML slide decks with animation, theming, and rich typography
triggers: [pptx, PPT, slides, presentation, deck]
dependencies:
  packages:
    - Pillow>=10.0
---

# HTML Slides Skill

## Workflow
1. Plan the slide structure and theme from the user's request
2. Generate a complete HTML file with inline CSS + JS
3. Write the final deliverable through file_write

## Design Principles
- Use modern visual styles such as gradients, glassmorphism, or flat design
- Keep each slide focused...
```

**Guide Skill injection mechanism:**

Every time Master Brain receives a user request, it calls `SkillRetriever.retrieve(userQuery)` to obtain relevant Guide skill catalog information. MB sees the skill name, description, and usage hints, and explicitly references the skill name in the `SPAWN_SUB_AGENT` task description. The actual Guide `fullContent`, `scriptFiles`, and `resourceFiles` are injected during Sub-Agent Prompt construction based on matched skills or skill names explicitly mentioned in the task.

If a Guide Skill contains script files or its body clearly asks the Agent to run scripts from the package, the dispatch layer adds `exec` to the Sub-Agent as a fallback. Guide Skills are still used by the Agent through ordinary tools according to the manual, and do not automatically enter the `external_skill_execute` contract execution chain of Script Skills.

---

### Script Mode

Script Mode SKILL.md contains an **Execution Contract**. The framework parses the contract, validates arguments, and calls the script through `external_skill_execute`; the LLM only needs to decide whether to call it and pass correct arguments.

**Typical frontmatter:**

```yaml
---
name: web-scraper
description: Scrape webpages and extract main text content, with Cookie authentication and complex page support
execution:
  runtime: python        # python | bash | node
  entry: main.py         # Entrypoint script relative to the skill package directory
  timeout: 60            # Seconds, default 60
  maxOutput: 65536       # Bytes, default 64KB
  permissions:
    network: true        # true | false; defaults to audit when not declared
    networkMode: brokerOnly # Optional; brokerOnly means it must egress through the main-process broker
    desktopControl: false # true means hotkeys, mouse, screenshots, window activation, and similar desktop capability are needed
  credentials:
    - id: github
      provider: github
      mode: brokerAuth
      hosts: [api.github.com]
      headerName: Authorization
      headerValuePrefix: "Bearer "
      required: false
  argsSchema:
    - name: url
      type: string
      required: true
      description: Target webpage URL
    - name: cookies
      type: string
      required: false
      description: Cookie string when authentication is needed
dependencies:
  packages:
    - trafilatura>=1.6
    - curl_cffi>=0.7
---
```

**Execution chain:**

```text
MB identifies that the task fits a Script Skill
    +-- Dispatches a Sub-Agent and allows external_skill_execute
        +-- SA calls external_skill_execute({ skillName, args })
            +-- Find installed Script Skill by exact skillName
            +-- ContractValidator.validateArgs()       <- Argument type/required validation
            +-- ExternalExecutor.buildCommand()
            |   -> "venv/Scripts/python.exe" "main.py" --url "..." --cookies "..."
            +-- shellExecute(command, workdir, timeout)
                +-- Returns {skillName, exitCode, stdout, stderr, durationMs, timedOut}
```

**Command-line argument mapping rules:**

- `string` / `number`: `--name "value"` with automatic escaping.
- `boolean`: `true` -> `--name`; `false` -> omit.
- Entrypoint scripts are called through the interpreter in the venv (Python 3.11+).

**Network permission policy:**

Script Mode external skills execute with the `externalSkill` sandbox profile by default. If `execution.permissions.network` is not declared, the network policy is `audit`: before execution, commands and entrypoint scripts are scanned for networking traces. Hits write structured audit events but do not directly block, reducing regression risk for the existing skill ecosystem.

| `execution.permissions.network` | Shell policy | Suitable scenario |
|----------------------------------|------------|----------|
| `true` | `inherit` | Skills that explicitly need GitHub, ArXiv, RSS, email, or third-party APIs |
| `false` | `blocked` | Local conversion, file processing, and compute skills that explicitly should not access the network |
| Not declared | `audit` | Compatibility with old skills; record networking traces first, then guide user decisions in later UI |

`execution.permissions.networkMode` is a more specific egress mode declaration. It currently supports `direct` / `brokerOnly`. Unspecified or `direct` keeps the behavior in the table above. `brokerOnly` means the Skill should not connect directly to the internet; the framework narrows shell direct network policy to `blocked` and injects `AGENTVIS_BROKER_MODE=explicit`, `AGENTVIS_BROKER_PIPE`, `AGENTVIS_BROKER_TOKEN`, `AGENTVIS_BROKER_FETCH`, and `AGENTVIS_NETWORK_DIRECT_ACCESS=blocked`. Scripts can explicitly delegate HTTP(S) requests through `agentvis-broker-fetch`; `network=false` conflicts with `brokerOnly` and is rejected during Contract validation.

`execution.credentials` only takes effect under `networkMode=brokerOnly`. It declares credential references held by the main-process broker. Scripts and LLM args only see `credentialRef`. The real secret is read by the main process from Windows Credential Manager according to `provider`, and the declared request header is injected only when HTTPS is used, the exact host allowlist matches, and the request does not already contain an auth header with the same name. v1 only supports `mode=brokerAuth` HTTP header injection. It does not support query/body injection, wildcard hosts, non-HTTP(S) protocols, or the ordinary `brokerProxyPreferred` transparent proxy path. When `required=false` and no credential is configured, it continues anonymously and the broker response returns `credentialApplied=false`; when `required=true`, it fails closed.

Local-file Script Skills can declare `execution.permissions.filesystem` to generate per-run AppContainer filesystem grants from string parameters in `argsSchema`. This declaration does not change network policy. For example, a file-organization Skill can use both `network=false` and `filesystem: [{ fromArg: path, access: readWrite }]`, obtaining read/write permission only to the user-provided directory under a Controlled Network no-network path.

```yaml
permissions:
  network: false
  filesystem:
    - fromArg: path
      access: readWrite
argsSchema:
  - name: path
    type: string
    required: true
    description: Target file or directory
```

The stable execution entrypoint for Script Skills is `external_skill_execute({ skillName, args })`. The tool layer looks up the Script Skill Contract by exact name, validates `argsSchema`, calls `ExternalExecutor`, and returns `skillName`, `exitCode`, `durationMs`, `stdout`, `stderr`, and `timedOut`. MB only sees a lightweight catalog. After SA hits a Skill name, a compact contract card is injected. Guide Skills still follow guide semantics through ordinary `exec` and do not automatically enter the Script Skill brokerOnly chain.

At the current stage, domain-level allowlists are not implemented. Static scanning can only detect networking capability or network commands; it cannot reliably prove the real target domain. Domain-granular permissions should be productized only after broker / proxy or real network events are observable.

Across the three sandbox modes, the user-visible Controlled Network Mode (internal `ControlledNetwork`) currently defaults to local file space and injects a broker-proxy-preferred session for ordinary `exec` / Guide Skills: `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` point to a per-run local HTTP(S) proxy, `NO_PROXY` / `no_proxy` are cleared, and an optional `agentvis-broker-fetch` helper environment is injected. Direct networking is still in an audit transition period. The legacy AppContainer direct backend can be restored with `AGENTVIS_CONTROLLED_NETWORK_BACKEND=legacy`; that path clears proxy environment variables and sets `NO_PROXY=*`, avoiding timeouts when Python / Node HTTP clients read a `127.0.0.1` system proxy but AppContainer loopback restrictions apply. Native `web_search`, backend `network_broker_http_request`, ordinary HTTP(S) proxy, and Script `agentvis-broker-fetch` are connected to the main-process broker. `brokerOnly` does not do transparent monkeypatching; scripts must call the helper explicitly.

The Controlled Network target shape keeps the `ControlledNetwork` field and UI name while moving implementation semantics toward "local file space + broker-only network egress." This means ordinary Guide Skills / `exec` can reuse users' existing CLI, token caches, and app configuration files, but HTTP(S) egress should go through the main-process broker/proxy. Until WFP or an equivalent network-only guard can block direct connections, ordinary commands cannot claim full brokerOnly.

Native Skill file tools (`read` / `file_write` / `local_search`) distinguish file boundaries through `sandboxFilesystemScope` in tool context: Offline Isolated is fixed to workspace / authorized roots, while the Controlled Network target semantics use local file space, avoiding a detour back to `exec` just to access local credential caches.

`brokerOnly` still scans entrypoint scripts before spawn. Entrypoint scripts should not directly import network APIs such as `urllib.request`, `requests`, or `socket`. If the Skill needs to verify that "direct connections are blocked," place the direct-connection probe in an independent child script, like `broker-e2e`, and let the main entrypoint trigger it through a subprocess. This avoids static scanning blocking the entire validation chain during load.

**Desktop control permission policy:**

If a Script Skill needs to control or observe the interactive desktop, it should declare `execution.permissions.desktopControl=true`. If it starts external GUI / detached applications, it should declare `execution.permissions.desktopLaunch=true`. These capabilities only hold in Local Audit Mode. Local Audit Mode uses detached lifecycle to avoid Job Object closing external GUI / browser processes when the shell exits. Offline Isolated / Controlled Network Modes block desktop control, hotkeys, screenshots, window activation, and detached GUI launch before backend spawn, avoiding cases where a script returns 0 while the actual desktop operation is swallowed by Windows UI isolation or Job Object lifecycle.

---

## Skill Package Format: SKILL.md Specification

### Common frontmatter fields

| Field | Type | Required | Description |
|------|------|------|------|
| `name` | string | Yes | Unique skill name, using lowercase letters, numbers, and hyphens, such as `web-scraper` |
| `description` | string | Yes | One-sentence description used by the LLM to decide when to use the skill; also the semantic source for vector retrieval |
| `triggers` | string[] | | Keyword trigger list for L1 exact matching; only effective in Guide Mode |
| `dependencies.packages` | string[] | | Extra pip package list, such as `["scipy>=1.10", "networkx"]` |
| `agentvisNetwork` | string | | Package-level network declaration for Guide / ordinary `exec`; currently supports `brokerProxyPreferred` |
| `agentvisNetworkEntrypoints` | object | | Network declarations for different scripts inside a Guide package; values support `brokerProxyPreferred` / `legacyNonHttp` |
| `license` | string | | License declaration |

### Script Mode-specific fields (`execution` block)

| Field | Type | Required | Default | Description |
|------|------|------|--------|------|
| `execution.runtime` | string | Yes | - | `python` / `bash` / `node` |
| `execution.entry` | string | Yes | - | Entrypoint script path relative to the skill package directory |
| `execution.timeout` | number | | 60 | Maximum execution seconds; normal maximum is 300 seconds, or 1800 seconds when `permissions.longRunning=true` |
| `execution.maxOutput` | number | | 65536 | Maximum output bytes; stdout and stderr are limited separately |
| `execution.permissions.network` | boolean | | Not declared | `true` inherits network; `false` blocks on static scan hits; undeclared audits hits but does not block |
| `execution.permissions.networkMode` | string | | `direct` | `direct` keeps current direct/audit behavior; `brokerOnly` blocks shell direct networking and requires HTTP(S) requests through `agentvis-broker-fetch` / broker IPC |
| `execution.permissions.filesystem` | array | | - | Generates AppContainer filesystem grants from string parameters; elements are `{ fromArg, access }`, with `access` supporting `readOnly` / `readWrite` |
| `execution.credentials` | array | | - | brokerOnly-only credential reference policy; scripts request with `credentialRef`, and the main process reads from Credential Manager and adds headers according to the host allowlist |
| `execution.permissions.desktopControl` | boolean | | `false` | Whether interactive desktop control such as hotkeys, mouse, screenshots, or window activation is needed; blocked under Offline Isolated / Controlled Network |
| `execution.permissions.desktopLaunch` | boolean | | `false` | Whether external GUI / detached applications may be launched; blocked under Offline Isolated / Controlled Network, uses detached lifecycle in Local Audit Mode |
| `execution.env` | string[] | | - | Compatibility/reserved field; the current executor does not inject arbitrary ordinary environment variables from this field, and Scripts should not depend on it for arguments |
| `execution.argsSchema` | array | | `[]` | Argument definition list; optional, but Script Skills should explicitly declare every passable argument |
| `execution.argsSchema[].name` | string | Yes | - | Argument name |
| `execution.argsSchema[].type` | string | Yes | - | `string` / `number` / `boolean` |
| `execution.argsSchema[].required` | boolean | Yes | - | Whether the argument is required |
| `execution.argsSchema[].description` | string | Yes | - | Argument description, injected into the LLM tool Schema |

### Skill Name Rules

- Allowed only: lowercase letters, numbers, and hyphen (`-`).
- Forbidden: spaces, underscores, uppercase letters, and special characters.
- Disabled names: `exec`, `read`, `file_write`, `web_search`, `external_skill_execute` (protected by registration conflict checks).
- Other native tool names are not recommended: `local_search`, `cron`, `generate_image`, `im_send`.
- Valid examples: `html-slides`, `web-scraper`, `pdf-converter`.

### Multiline description Syntax

YAML block scalar format is supported:

```yaml
description: >
  Powerful web scraping tool with authenticated access,
  complex page support, and main-content extraction that
  filters advertising and navigation noise.
```

---

## Installation Flow

Users install skill packages through "Settings -> Skills". The current implementation supports local directory import and GitHub download. Packages are first copied/downloaded to `packages/{name}/`, then users choose between security review and direct installation:

```text
1. User selects a local skill package directory or enters a GitHub repository URL
              |
2. Copy/download the skill package to packages/{name}/
              |
3. Read SKILL.md and parse basic info such as name / description / mode
              |
4. Show confirmation dialog
   - Start security review: enter SkillAuditService flow
   - Install directly: skip review and immediately trigger rescanExternalSkills()
              |
5. SkillAuditService (optional)
   - Start an independent Sub-Agent (read tool only)
   - Scope review to root SKILL.md and progressive-disclosure directories inside the package:
     references/reference, scripts/script, assets/asset
   - Output structured JSON verdict: APPROVED / REJECTED / MANUAL_REVIEW_REQUIRED
              |
6. User decides based on review result (SkillAuditModal)
   - APPROVED: continue installation or cancel
   - MANUAL_REVIEW_REQUIRED: user may continue installation or remove package
   - REJECTED: strong risk warning; user may still force continue or remove package
              |
7. rescanExternalSkills() / bootstrapExternalSkills()
   - ExternalSkillRegistryLoader.scanAll()
   - ContractValidator validates Script Contract
   - skillLoader.registerExternal(skill)
   - RuntimeStore.setInstalledSkills(...)
   - SkillRetriever.register(Guide Skills)
              |
8. DependencyAnalyzer records dependencies to install
   - Parse dependencies.packages
   - Statically analyze npm / system / cargo / go dependency signals
              |
9. launchBackgroundInstall() installs extra dependencies in the background
   - RuntimeManager.ensureReady([], skillDeps)
   - Extract/validate bundled Python runtime
   - Incrementally install extra pip packages declared by skill packages
   - Mirrors: Aliyun HTTP -> Tsinghua HTTP -> PyPI HTTPS
   - Installation result is shown asynchronously through SkillSettings notices
              |
10. Skill takes effect immediately after scanning and registration (no restart needed);
    skills missing dependencies may fail at runtime and prompt the user to refresh the list to retry dependency installation
```

### Uninstall / Disable

- **Disable**: rename the skill package directory with an `_` prefix, such as `_web-scraper`; it will be skipped on the next scan.
- **Uninstall**: delete the `packages/{name}/` directory.

---

## Trigger Mechanism

### Native Skill Triggering

Native Skills are always in the tool list allowed for the Sub-Agent (`allowedTools`) and are specified by Master Brain in the `SPAWN_SUB_AGENT` decision. After receiving a task, the Agent decides when to call them according to SKILL.md content.

### Guide Mode Skill Triggering (Two-Level Retrieval)

Whenever a user sends a message, the system uses `SkillRetriever` to retrieve against user intent and provides relevant Guide skill catalog information to Master Brain. Only when MB references a skill name in the task, or when the dispatch stage secondarily matches a skill name, does the Sub-Agent Prompt inject the Guide's full body, script list, and resource list.

#### L1: Exact Keyword Matching (deterministic, zero latency)

```text
User message: "Help me make a slide deck"
         |
SkillRetriever.keywordMatch(query)
         |
Check html-slides triggers: [pptx, PPT, slides, presentation, deck]
         |
Hit! score = 1.0 (highest priority)
```

The skill name (`name` field) is automatically included in trigger terms, so it does not need to be repeated in `triggers`.

#### L2: Multi-Fragment Vector Semantic Matching (fallback)

When L1 does not hit, vector similarity retrieval is used:

```text
User message (multi-line)
    |
Split into fragments (by newline, filtering fragments shorter than 4 characters, up to 8 fragments)
    |
Batch embedding (reuse global EmbeddingService singleton)
    |
Compute cosine similarity between each fragment and every skill embedding
    |
For each skill, take the highest score among all fragments (solves long-text averaging)
    |
Filter results below threshold (default 0.85)
```

The two result sets are deduplicated by max score, sorted descending, and the Top-3 are injected into Master Brain.

> **Index text**: the vectorized text is `name: description` (intent summary), not fullContent (implementation details), keeping the semantic space aligned with user queries.

### Script Mode Skill Triggering

Script Mode skills are not exposed to the LLM as independent Tools. MB sees a lightweight catalog of installed Script Skills. When the task matches a Script Skill name or description, the dispatch layer adds the `external_skill_execute` tool for the Sub-Agent and injects a compact contract card into the SA Prompt. The Sub-Agent calls:

```json
{
  "skillName": "web-scraper",
  "args": {
    "url": "https://example.com"
  }
}
```

The tool layer looks up the Script Contract by exact `skillName`, validates `argsSchema`, then hands it to `ExternalExecutor` to build and execute the command. The repository still keeps the `ExternalToolProvider` class for compatibility / historical tests, but the current main chain uses `external_skill_execute`.

---

## Security Review Mechanism

Security review is provided by `SkillAuditService`, but in the current installation flow it is an optional user step: after importing a local directory or GitHub package, users may review first and then decide, or skip review and register directly. Review results are used for risk prompts and user decisions, but are not the only registration gate.

### Review Architecture

- **Executor**: independent Sub-Agent, reusing `SubAgentRunner` without creating new infrastructure.
- **Tool sandbox**: only the `read` tool is allowed, and paths are limited to the skill package directory to prevent path traversal.
- **Review scope**: root `SKILL.md` and progressive-disclosure directories such as `references/`, `reference/`, `scripts/`, `script/`, `assets/`, and `asset/`; it does not read every file in the package by default.
- **Checkpoint strategy**: Noop, because the review SA does not need Master Brain intervention and acts autonomously.
- **Output format**: structured JSON verdict.

### Review SA Workflow

```text
1. Read files according to limited scope and priority
   (SKILL.md > scripts/code > config > docs/resources)
2. Analyze 7 security dimensions:
   1. Remote code execution (RCE) risk
   2. Data exfiltration behavior
   3. Supply-chain pollution
   4. Privilege escalation
   5. Persistence/backdoor behavior
   6. Resource abuse such as crypto mining
   7. Mismatch between stated intent and code functionality (Prompt Injection)
3. Output JSON verdict
```

### Verdict Results

| Verdict | Meaning | User action |
|------|------|----------|
| `APPROVED` | Passed with no risk items | Install directly |
| `MANUAL_REVIEW_REQUIRED` | Suspicious items exist; manual inspection is recommended | User may choose whether to install |
| `REJECTED` | High-risk findings exist; strongly recommend rejecting | Default recommendation is removal; user may force continue |

The verdict includes risk score (1-10), confidence (LOW/MEDIUM/HIGH), and a concrete finding list containing file, location, risk type, and attack-scenario description.

---

## Python Runtime Environment

### Shared venv Architecture

All external skills that need Python runtime share an application-managed Python environment, avoiding duplicate venv creation for every skill. In Windows packaged builds, AgentVis preferentially extracts the bundled `python-runtime-v1.zip` (containing `.venv` and base dependencies). In development, or when bundled resources are unavailable, it falls back to embedded Python / system Python paths:

```text
{AppDataDir}/runtime/python-v1/
+-- .venv/
    +-- Scripts/        <- Windows
    |   +-- python.exe
    |   +-- pip.exe
    +-- bin/            <- Unix
        +-- python
        +-- pip
```

### Environment State Machine

The frontend Store / settings panel displays user-visible states:

| State | Description |
|------|------|
| `not_checked` | Not yet reconciled with the physical runtime state on disk |
| `not_created` | venv does not exist or is unavailable |
| `creating` | Extracting bundled runtime or creating runtime environment |
| `installing_base` | Preparing/validating base runtime |
| `installing_extra` | Installing extra dependencies for skill packages |
| `ready` | Environment ready |
| `error` | Severe error or runtime unavailable |
| `skipped` | Runtime preparation skipped in the current environment |

`RuntimeManager` still returns more detailed internal intermediate states for deciding downgrade behavior and hint copy:

| Internal state | Description |
|----------|------|
| `base_incomplete` | Bundled runtime is missing/damaged or base package validation failed; rebuild or repackaging is needed |
| `extra_partial` | Some extra dependencies failed; existing environment can continue to be used, and failure results are shown asynchronously through skill management notices |

### Python Version Requirements

- Minimum version: **Python 3.11**
- Current Windows packaged runtime version: **Python 3.13.14**
- Windows packaged builds preferentially extract bundled Python runtime (`{AppDataDir}/runtime/python-v1/.venv`). Base dependencies are accepted by validation rather than reinstalled at every startup.
- Only when the bundled runtime is unavailable does AgentVis try embedded Python (`{AppDataDir}/runtime/python-embed-*`) or system Python to create the shared venv.
- Only in development environments or when embedded resources are unavailable does it fall back to `python` / `python3` / `py -3` on PATH or common LocalAppData installation paths.
- Offline Isolated requires the venv to be hermetic: `home`, `executable`, `base-executable`, and similar fields in `pyvenv.cfg` must be under `{AppDataDir}/runtime`. The hard-isolation execution chains for legacy Controlled Network and Script `brokerOnly` still use this constraint. Under the Controlled Network target shape, ordinary Guide Skills / `exec` can reuse local CLIs and existing credential caches.

### Sandbox Runtime Directories

Under Offline Isolated and the current Controlled Network implementation, Script Skills can still access application-managed directories:

- `{AppDataDir}/runtime`: embedded Python, shared venv, sandbox profile.
- `{AppDataDir}/skills`: installed external Skill packages and reference files.
- Current workdir / project root: workspace granted by the user.

Current Offline Isolated and legacy Controlled Network redirect common user directory environment variables to `{AppDataDir}/runtime/sandbox-profile/*`, including `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_DATA_HOME`. The default Controlled Network path uses local file space and no longer redirects the real Home / AppData, preserving compatibility with existing CLI and Skill credential caches.

### Controlled Network and Proxy

- Controlled Network Mode (internal `ControlledNetwork`) keeps local file space by default and injects a broker-proxy-preferred session environment for ordinary `exec` / Guide Skills. Native `web_search`, backend `network_broker_http_request`, and ordinary HTTP(S) traffic that honors proxy environment variables already go through the main-process broker egress. The later target is for the OS layer to block direct connections that bypass the proxy.
- Script Skills can declare `execution.permissions.networkMode=brokerOnly` to enter a fail-closed path: direct networking is blocked, the process receives broker environment variables, and it can call `agentvis-broker-fetch` to delegate HTTP(S) requests through stdin/stdout JSON. Request JSON is `{ method, url, headers?, bodyBase64?, timeoutMs?, credentialRef? }`; response JSON contains `{ ok, status, headers, bodyBase64, truncated, durationMs, finalUrl, targetHost, targetScheme, bytesOut, credentialRef?, credentialApplied?, error? }`.
- When a request carries `credentialRef`, that ref must be declared in `execution.credentials`; the broker validates HTTPS, exact host, and that the script did not provide a same-name header, and validates again after every redirect hop. Logs, audit, and observations only record the ref and whether it was applied; they do not record the secret.
- `agentvis-broker-fetch` is built before `tauri build`, released with installer `resources/bin`, copied to `{AppDataDir}/runtime/bin` at runtime, and then injected into PATH. Skill scripts can also read `AGENTVIS_BROKER_FETCH` directly and call the absolute path. If the helper is missing, `brokerOnly` fails closed and does not fall back to direct connection.
- `brokerOnly` currently uses per-run file-based IPC under the application runtime directory. AppContainer ReadWrite grants must allow create/write/rename/delete because the helper publishes requests through temporary-file rename.
- Guide Skills currently receive a broker-proxy-preferred session entry, but this is still not a full transparent request-level broker and does not provide a child-process real-domain hard allowlist. HTTP(S) clients that honor `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` enter broker/proxy. Direct connections that do not honor proxy env are still in an audit transition period and later require a network-only guard.
- The legacy AppContainer direct backend does not support sandbox processes accessing the local `127.0.0.1` proxy. Windows loopback exemption requires administrator privileges and cannot be a default capability.
- The legacy AppContainer direct backend clears proxy environment variables and sets `NO_PROXY=*`, preferring direct network. The default Controlled Network path no longer clears the real Home / AppData because of filesystem sandboxing.
- Scenarios needing system proxy, enterprise proxy, or request-level audit should prefer broker/proxy. Domain allowlists and policy UI are for a later phase.
- Under the default Controlled Network path, `Path.home()` points to the user's real home directory, and real Home / application-directory CLI and Skill token caches can be reused. Broker audit does not record full URL query / credentials, and agent-facing observations redact broker token, proxy URL, Authorization/Cookie/Set-Cookie, and common token/api_key fields.

#### broker helper invocation examples

Shell:

```bash
printf '{"method":"GET","url":"https://example.com","timeoutMs":15000}' | agentvis-broker-fetch
```

Python:

```python
import base64
import json
import os
import subprocess

helper = os.environ["AGENTVIS_BROKER_FETCH"]
request = {"method": "GET", "url": "https://example.com", "timeoutMs": 15000}
completed = subprocess.run(
    [helper],
    input=json.dumps(request),
    text=True,
    capture_output=True,
    check=True,
)
response = json.loads(completed.stdout)
body = base64.b64decode(response.get("bodyBase64") or b"").decode("utf-8", "replace")
```

Node.js:

```js
import { spawnSync } from 'node:child_process'

const helper = process.env.AGENTVIS_BROKER_FETCH
const request = { method: 'GET', url: 'https://example.com', timeoutMs: 15000 }
const result = spawnSync(helper, {
  input: JSON.stringify(request),
  encoding: 'utf8',
})
if (result.status !== 0) throw new Error(result.stderr || result.stdout)
const response = JSON.parse(result.stdout)
const body = Buffer.from(response.bodyBase64 || '', 'base64').toString('utf8')
```

When migrating built-in or third-party Script Skills, do not monkeypatch `requests` / `fetch`, and do not ask scripts to read `HTTP_PROXY` as a local proxy. Networked entrypoints should be centralized into explicit functions such as `broker_get` / `broker_post`, making future integration of domain policy, audit attribution, and error hints easier.

#### brokerProxyPreferred Compatibility Declaration

Not every Skill needs to be upgraded to `brokerOnly`. For Python / Node Skills that only make HTTP(S) requests and whose underlying libraries honor proxy environments, declare the following in `SKILL.md` frontmatter:

```yaml
agentvisNetwork: brokerProxyPreferred
```

If a Guide package contains multiple scripts and different scripts need different network semantics, use entrypoint-level declarations:

```yaml
agentvisNetworkEntrypoints:
  scripts/http_client.py: brokerProxyPreferred
  scripts/email_helper.py: legacyNonHttp
```

`exec` matches `agentvisNetworkEntrypoints` by package-internal script paths referenced in the command. Script Skill `external_skill_execute` also queries the same table by `execution.entry` to supplement network fallback information.

This declaration means: under `ControlledNetwork`, prefer the ordinary per-run HTTP(S) broker proxy; when explicit WFP per-run guard sees a command whose first token is `python`, it can downgrade to broker-proxy-preferred instead of blocking directly because a shared interpreter cannot produce a unique WFP AppID. Applicable conditions:

- The Skill's network capability only uses HTTP(S).
- The script reads `AGENTVIS_NETWORK_PROXY_URL`, or honors `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`.
- Package managers and toolchains can use runtime-injected `npm_config_proxy` / `npm_config_https_proxy`, `PIP_PROXY`, git `http.proxy` / `https.proxy`; browser automation scripts can read `AGENTVIS_BROWSER_PROXY_SERVER` and explicitly configure Chromium / Playwright proxy.
- If libraries such as `httpx`, `requests`, `curl_cffi`, Playwright/Chromium need explicit proxy parameters, the Skill itself should translate broker proxy env into those parameters.
- Output and error messages must not echo the full proxy URL, broker token, Authorization, Cookie, api_key, or other sensitive values.
- `ControlledNetwork` treats explicit proxy bypass as high-risk and blocks it, including `NO_PROXY` / `npm_config_noproxy`, `curl --noproxy`, Chromium direct proxy, raw socket / IMAP / SMTP / FTP / SSH libraries, and Node native `fetch` without a configured proxy agent.

Not applicable to:

- Non-HTTP(S) protocols such as IMAP/SMTP/SSH/database/raw socket.
- Strong fail-closed brokerOnly semantics.
- Tools that actively set `NO_PROXY=*`, `curl --noproxy`, or other proxy-bypass parameters.

If strong semantics are needed, use `execution.permissions.networkMode=brokerOnly` and explicitly call `agentvis-broker-fetch`. If non-HTTP(S) protocols are needed, design a SOCKS/TCP broker, per-protocol broker, or explicit direct-audit allowlist separately in a later phase.

#### Minimal Acceptance Skills

- `broker-e2e` is a temporary built-in Script Skill for manually validating `ControlledNetwork + brokerOnly`: it checks broker env injection, failure of direct Python networking, helper access to public internet, and helper rejection of localhost. After running it, `{AppDataDir}/runtime/bin/agentvis-broker-fetch.exe` should be copied or refreshed. Manual testing has passed all four checks under Controlled Network, confirming the `external_skill_execute -> ExternalExecutor -> shell_execute -> broker session` chain works.
- `broker-e2e-deny` exists only as a test fixture and is not included in the built-in Skill list. It intentionally declares `network=false + networkMode=brokerOnly` to verify that Contract validation rejects conflicting permissions.
- `github-lookup` is one of the first real migration examples. It adds a Script Contract wrapper and uses the broker helper to request the GitHub API when `AGENTVIS_BROKER_FETCH` is available; without broker env, it preserves the original direct `httpx` CLI behavior. Because it may already exist in users' local packages, startup with the same version triggers one incremental refresh via `.bundle_revision`, avoiding manual deletion of old directories. The broker path has been tested as usable. If no GitHub token is available under Controlled Network, it requests with anonymous quota and may return 403 quota exhausted. That is a secret-injection capability gap, not a broker-chain failure.

### pip Installation Strategy

- **Batch install**: 5 packages per batch to reduce process startup overhead.
- **Failure fallback**: when batch install fails, downgrade to per-package install to identify the problematic package accurately.
- **Mirrors**: Aliyun HTTP (primary) -> Tsinghua HTTP (backup) -> PyPI HTTPS (fallback).
- **Single-package timeout**: 300 seconds, supporting compilation-heavy packages such as `curl_cffi`.

---

## Troubleshooting

### External Skill Does Not Appear in Skill Management or Agent Context

1. Check whether `packages/` contains directories starting with `_`, which are treated as disabled.
2. Check whether the `name` field in SKILL.md is valid, with no uppercase letters or special characters.
3. Check whether `name` conflicts with a protected native skill name.
4. Inspect SkillLoader logs, filtering for `[ExternalSkillRegistry]`.
5. Remember that Script Skills do not appear as independent Tools in the tool list; they should be called by Sub-Agent through `external_skill_execute`.

### Script Mode Skill Call Fails

1. Check whether the `runtime` field in the Execution Contract is correct.
2. Check whether `entry` is relative to the skill package directory.
3. Confirm that Python venv state is `ready` in the settings panel under Skills.
4. Internal script exceptions are returned in `stderr`; check the SA tool-call result.

### Guide Skill Is Not Recognized by Master Brain

1. Confirm that `description` is concise and accurately describes the skill's purpose.
2. Add keywords users naturally use to `triggers`; both Chinese and English are allowed.
3. Vector retrieval falls back to empty on failure and does not block the main flow; keyword triggers can be used as a fallback.

### Security Review Times Out or Fails to Parse

- The review SA has a maximum 30-step limit. Many files, complex scripts, or weaker models may cause timeout.
- On timeout, the verdict downgrades to `MANUAL_REVIEW_REQUIRED` with a risk score of 5/10.
- Use a stronger model in settings to improve review accuracy.

---

*This document is compiled from source files including `ExternalSkillRegistry.ts`, `SkillLoader.ts`, `SkillAuditService.ts`, `ExternalExecutor.ts`, `RuntimeManager.ts`, `SkillRetriever.ts`, `ExternalSkillBootstrap.ts`, and `external_skill_execute/tool.ts`. `ExternalToolProvider.ts` is still kept in code, but the current main execution chain does not expose Script Skills through it.*
