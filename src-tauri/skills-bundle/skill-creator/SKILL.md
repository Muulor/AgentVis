---
name: skill-creator
description: Create new AgentVis skills, modify and improve existing skills, and measure skill performance. Use when users want to create a Guide Skill, Script Skill, networked skill, sandbox-compatible skill, or optimize an existing skill's description and trigger accuracy. When a skill involves HTTP APIs, credentials, local scripts, non-HTTP protocols, or ControlledNetwork compatibility, use this skill to choose the correct Guide/Script architecture and sandbox declarations before writing files.
triggers: [skill-creator, skill creator, Create skill, 创建技能, 生成技能, 保存技能, script skill, guide skill, ControlledNetwork, brokerOnly]
---

# Skill Creator for AgentVis

A skill for creating AgentVis skills and iteratively improving them. AgentVis supports two different skill shapes: Guide Skills teach the Sub-Agent through Markdown instructions, while Script Skills expose a typed execution contract and run through the external skill executor.

## Execution Architecture Adaptation (MB-SA Loop Mode)

**[MB] Goes first (requirement collection)**: When receiving a request to create or improve a skill, first confirm with the user: usage scenario, trigger conditions, expected output, and network/credential needs. Default to installing after validation unless the user explicitly asks for a draft-only package. Dispatch SA only after the requirements are clear.

**[SA] Execution phase**: Execute the current stage task according to MB's brief. After each stage is complete, report via `TASK_COMPLETE`; MB decides whether to dispatch the next-stage SA based on the result. Flow: draft writing -> testing -> iteration -> installation.

When reporting `TASK_COMPLETE`, include stage information:

```text
Current stage: [completed stage name]
Next stage: [next step requiring MB dispatch]
Output files: [key file paths]
```

If the brief is incomplete, report what's missing via `TASK_COMPLETE` and MB will ask the user. After the skill is done, offer to optimize the description for triggering accuracy.

## Creating A Skill

### Verify Requirements

Requirement collection is MB's responsibility. MB should usually provide:

1. What should this skill enable Agent to do?
2. When should this skill trigger? Include Chinese and English trigger phrases when useful.
3. What is the expected output format?
4. Does it need local scripts, network access, credentials, desktop control, or a draft-only output?

If the brief is sufficient, proceed directly to the draft. If critical information is missing, do not guess; report the exact missing details through `TASK_COMPLETE`.

### Research

Before writing, inspect similar bundled skills and relevant docs. For existing skills, read the installed version at:

```text
C:\Users\<User>\AppData\Roaming\com.agentvis.app\skills\external\packages\{skill-name}\SKILL.md
```

Also check whether a draft exists at:

```text
C:\Users\<User>\AppData\Roaming\com.agentvis.app\skills\external\packages\_drafts\{skill-name}\
```

Analyze the gap before editing.

## Choose The Skill Shape First

Always classify the skill before writing files. This decision determines which parts of `SKILL.md` the Sub-Agent can see and which sandbox mechanism will run the code.

| Shape | Use When | SA Sees | Execution Path |
| --- | --- | --- | --- |
| Guide Skill | The task is procedural, exploratory, or teaches the agent how to use existing tools/scripts. | Frontmatter plus `SKILL.md` body. | Normal Agent reasoning and `exec`/tools. |
| Script Skill | The task is a parameterized tool with stable inputs/outputs. | Frontmatter-derived compact contract, args, and schema. Body is not used as runtime instructions. | `external_skill_execute` -> `ExternalExecutor`. |
| Mixed Guide | One package has multiple scripts with different network behavior. | Guide body plus entrypoint declarations. | Normal `exec`, with `agentvisNetworkEntrypoints` matched by script path. |

Decision rules:

- Prefer Guide Skill when the agent needs step-by-step judgment, can choose among multiple commands, or must read instructions to use bundled resources.
- Prefer Script Skill when the user action maps cleanly to `argsSchema`, the output should be deterministic, or the network/credential surface should be broker-managed.
- Prefer a Guide with entrypoint-level `legacyNonHttp` when the package is purely IMAP/SMTP/SSH/database/raw-socket.
- Prefer a mixed Guide only when the same package truly has multiple scripts with different network behavior, such as one HTTP(S) API helper and one legacy non-HTTP helper.
- Do not convert a Guide Skill into Script just by adding schema unless the body is no longer required for correct usage.
- When adapting an installed external skill, preserve its existing shape first. If it has no `execution` contract and the body teaches commands, treat it as a Guide Skill and add the smallest AgentVis network metadata needed.

## AgentVis Progressive Disclosure

AgentVis uses different disclosure surfaces for Guide and Script skills:

- Guide Skill frontmatter controls retrieval. Once triggered, the `SKILL.md` body is injected to the Sub-Agent and should teach the workflow.
- Script Skill frontmatter controls retrieval, tool schema, execution contract, permissions, and credential policy. The Sub-Agent does not rely on the body for tool use.
- Script Skill body is fallback reference for the user, maintainers, and debugging. Routine tool-use instructions must be represented in `description`, `argsSchema`, `execution.permissions`, `execution.credentials`, and script behavior because the Sub-Agent normally sees only the compact contract card.
- Keep Guide bodies concise but complete. Keep Script bodies shorter and focused on capability summary, setup notes, troubleshooting, and maintainer context.

## Frontmatter Rules

Common fields:

- `name`: lowercase letters, numbers, and hyphens only. The name is also an automatic L1 trigger keyword.
- `description`: natural-language description of what the skill does and when to use it. Make it specific and slightly assertive so MB can choose the skill reliably. For Script Skills, include essential call-level caveats MB should pass to SA, such as single-flight, rate limits, or required serialization.
- `triggers`: exact-match retrieval phrases. Include abbreviations, domain terms, file extensions, and common Chinese/English variants.

Guide network fields:

- `agentvisNetwork: brokerProxyPreferred` for package-wide HTTP(S) Guide helpers that respect proxy environment variables, such as web scrapers or documentation crawlers.
- `agentvisNetworkEntrypoints` for per-script declarations. Use it both for mixed packages and for pure non-HTTP packages that need to mark one legacy entrypoint.
- `legacyNonHttp` only marks a non-HTTP(S) entrypoint for direct-audit target preflight; it is not a broker proxy, protocol translator, or general allowlist.

Script contract fields:

- `execution.runtime`, `execution.entry`, `execution.timeout`, `execution.maxOutput`.
- `execution.argsSchema` for every argument the Sub-Agent may pass.
- `execution.permissions.networkMode: brokerOnly` for fail-closed HTTP(S) broker helper access.
- `execution.permissions.filesystem` for Script Skills that must access user-provided file paths in restricted sandboxes.
- `execution.credentials` when the main process broker should hold and inject secrets by `credentialRef`.

Read `references/agentvis-skill-templates.md` before creating a networked or Script Skill. Copy the smallest matching template and adapt it to the requested domain.

## ControlledNetwork Compatibility

AgentVis `ControlledNetwork` is designed to be controlled and practical. Choose the lightest compatible declaration:

- HTTP(S), proxy-aware Guide helper: use `agentvisNetwork: brokerProxyPreferred` or an entrypoint-specific `brokerProxyPreferred`.
- HTTP(S), deterministic Script helper: use `execution.permissions.networkMode: brokerOnly` and call `agentvis-broker-fetch` explicitly from the script.
- HTTP(S) with a token/API key: use Script `brokerOnly` plus `execution.credentials`, and send only `credentialRef` in broker requests.
- Local file-management Script helper: use `execution.permissions.network: false` plus `execution.permissions.filesystem` entries that reference string args such as `path`.
- Non-HTTP(S) protocols such as IMAP, SMTP, SSH, database sockets, FTP, or raw TCP: use `agentvisNetworkEntrypoints: <script>: legacyNonHttp` and implement a read-only `--action network_targets` preflight.
- Pure email helpers that use only IMAP/SMTP should be Guide Skills with `scripts/email_helper.py: legacyNonHttp`; do not add `brokerProxyPreferred` unless there is a separate HTTP(S) API script.
- Web scrapers and documentation crawlers are the typical Guide Skill use case for package-wide `agentvisNetwork: brokerProxyPreferred`.
- Public HTTPS API Guide Skills, such as a Polymarket Gamma API helper using `requests` or `httpx`, should use `agentvisNetwork: brokerProxyPreferred`, not `legacyNonHttp`.
- For `brokerProxyPreferred`, confirm the script respects proxy environment variables and does not disable them with settings such as `trust_env=False`, empty `proxies`, `NO_PROXY=*`, `--noproxy`, or `proxy-server=direct://`.

For brokerProxyPreferred Guide helpers, frontmatter only tells the sandbox to provide the broker proxy path. It does not rewrite the script. Keep the script on normal proxy-aware clients such as `requests`, `httpx`, `urllib`'s default opener, or a direct `curl` command declared in the Guide body. Avoid "fixes" that bypass or confuse the proxy path:

- Do not shell out from Python to `curl.exe` just to avoid a `requests` block; keep the original Python HTTP client unless the command itself is a direct curl entrypoint.
- Do not add empty or conditional proxy maps such as `proxies = {}` or `proxies=proxies if proxies else None`.
- Do not disable TLS verification or hostname checks as a sandbox workaround.
- If the observation says `nodeNativeFetchWithoutProxyAgent` but the script is Python, look for a helper named `fetch(...)`; rename it to `api_get`, `request_json`, or `broker_request`. The scanner matches the literal `fetch(` pattern before launch.
- If the observation says `pythonProxyEnvDisabled`, remove `trust_env=False`, `proxies={}`, `ProxyHandler({})`, `deleteproxy`, or `NO_PROXY=*`; let the client inherit proxy environment variables.

For Script `brokerOnly`, do not rely on transparent proxy behavior. The script must call the helper from `AGENTVIS_BROKER_FETCH` or `agentvis-broker-fetch`.

For local file-management Script Skills, keep network disabled and declare user-supplied path grants:

```yaml
permissions:
  network: false
  filesystem:
    - fromArg: path
      access: readWrite
```

`fromArg` must reference a string field in `argsSchema`. Use `readOnly` for inspect-only scripts and `readWrite` for scripts that move, create, delete, or modify files.

For broker-managed credentials:

- Declare the credential in frontmatter with `id`, `provider`, `mode: brokerAuth`, exact `hosts`, `headerName`, `headerValuePrefix`, and `required`.
- Pass `credentialRef` in the broker helper request.
- Do not read token environment variables, real Home/AppData files, or Windows Credential Manager from the script process.
- Do not set the same auth header yourself. The broker injects it only for allowed HTTPS hosts.
- If `credentialApplied=false` and the API fails due to quota/auth, return a clear message telling Agent that the Credential Manager provider is missing or invalid.

Use `templates/python_script_entry.py` for the Script Skill entrypoint ABI, `templates/python_script_core.py` for the recommended brokerOnly core-module shape, and `templates/python_broker_fetch.py` for the reusable broker helper snippet. The brokerOnly templates already include stable failure diagnostics; reuse them instead of hand-rolling one-off error strings.

## Adapting Installed External Skills

When a downloaded or third-party skill works in LocalAudit mode but fails in `ControlledNetwork`, repair the skill instead of finding a substitute source.
You can check `references/agentvis-skill-templates.md` for more information.

1. Read the installed package's `SKILL.md` and the scripts it tells Agent to run.
2. Preserve the skill shape by default. A command-oriented skill with no `execution` block remains a Guide Skill.
3. Identify each networked script's protocol:
   - HTTP(S) only and proxy-aware: add package-wide `agentvisNetwork: brokerProxyPreferred`, or an entrypoint mapping if only some scripts need it.
   - IMAP, SMTP, SSH, database sockets, FTP, or raw TCP: use `agentvisNetworkEntrypoints: <script>: legacyNonHttp` and add a side-effect-free `network_targets` action.
   - Mixed protocols in one package: use `agentvisNetworkEntrypoints` and mark each script separately.
4. Patch minimally. Keep the original commands, body, metadata, local storage behavior, and user-facing workflow unless they are unsafe or incompatible with the sandbox.
5. Check for proxy bypasses before testing: `trust_env=False`, empty `proxies`, `NO_PROXY=*`, `--noproxy`, `proxy-server=direct://`, or direct socket code in an HTTP-only skill. Also search for Python helpers containing the literal `fetch(`; rename false-positive helper names such as `fetch` to `api_get` or `request_json`.
6. Re-test the original user request in `ControlledNetwork`. If it still fails and the frontmatter is already correct, use the sandbox observation reason to patch the script minimally: rename false-positive `fetch(` helpers, remove proxy-disabling code, or choose the correct protocol mode. Do not add manual proxy dictionaries, spawn `curl.exe` from Python, or disable TLS as a workaround.

Do not convert a working external Guide Skill into a Script Skill solely to satisfy the sandbox. Convert only when the user wants a parameterized `external_skill_execute` tool and the body is no longer needed for correct use.

## Writing The Skill

### Anatomy

```text
skill-name/
├── SKILL.md
├── scripts/
├── references/
├── templates/
└── assets/
```

Create only the directories that the skill actually needs.

### Creation Path Rules (_drafts Isolation Mechanism)

External package directory:

```text
C:\Users\<User>\AppData\Roaming\com.agentvis.app\skills\external\packages
```

New skills must be created under:

```text
{packages_dir}\_drafts\{skill-name}\
```

`_drafts\` starts with `_`, so the system scanner skips it. After validation, migrate the core files to `{packages_dir}\{skill-name}\`.

### Guide Skill Body

Write the body as operational instructions for the Sub-Agent:

- Include the normal workflow, command examples, output interpretation, and troubleshooting.
- Tell the agent when to read bundled references or use bundled scripts.
- Include ControlledNetwork notes when the skill has scripts that need network access.
- Keep the body under 500 lines when possible. Move long examples and reference material to `references/`.

### Script Skill Body

Write the body for users and maintainers:

- Keep it short and diagnostic-first; do not duplicate the full action list, argument list, examples, or query syntax already encoded in frontmatter.
- Include only fallback notes that are not practical in the compact contract card, such as known failure modes, troubleshooting, setup requirements that are not secrets, and maintainer context.
- Explain credential provider names and troubleshooting, but never include token-handling code that reads host secrets in broker mode.
- Put every normal-use instruction in `description`, `argsSchema`, contract metadata, permissions, credentials, or script validation. The body should not be required for a successful first tool call.

### Script Output Contract

For any bundled script, whether it is used by a Guide Skill or exposed as a Script Skill, design stdout/stderr as an observation contract for the Sub-Agent.

- On success, return structured facts the Agent should report: status, key result fields, artifact paths, URLs, measured values, requested values when they differ, and a concise next-step hint.
- On retryable failure, say that the failure is retryable and why. Include stable fields such as `retryable: true`, transient network status, rate-limit status, `retryAfter` when known, and the exact action that may be retried.
- On blocked or user-actionable failure, say not to keep retrying. Include the blocking reason, missing credential/config/path, provider policy or sandbox limitation, and what the Agent should report or ask the user to fix.
- When the script detects a provider limitation or hard constraint, state it directly and tell the Agent when to stop looking for workarounds. 
- Keep requested parameters separate from measured results. For example, report `requestedSize` separately from `actualSize` so the Agent does not present a request target as a real output property.
- Preserve machine-readable diagnostics alongside prose: `status`, `errorKind`, `reasonCode`, `credentialApplied`, `savedPath`, `nextStep`, or domain-specific equivalents.
- Keep secrets out of observations, but include enough non-secret context for the Agent to distinguish success, retry, blocked, and partial-success states.

### Script Code

For Script Skills:

- Use `references/agentvis-skill-templates.md` as the canonical source for Script Skill ABI, safe `execution.entry`, safe `argsSchema.name`, contract metadata, brokerOnly file shape, and smoke-test command shape.
- Keep `argsSchema.description` concise because it is injected into the Sub-Agent compact contract card. Put hard choices and ranges in `allowedValues`, `min`, `max`, `default`, or `examples` instead of repeating them in prose.
- Before finalizing, compare every `argsSchema.name` with the parser's named CLI flag and smoke-test the declared entrypoint with the same named-flag shape used by `ExternalExecutor`.
- Print concise, structured output suitable for observations.
- Exit non-zero for real execution failure; exit zero with a clear message for user-correctable states such as missing optional credential.
- Keep secrets out of command-line args, environment variables, stdout, stderr, and logs.
- For brokerOnly HTTP(S), preserve stable broker diagnostics in failed observations so Agent can distinguish routing, credential, policy, and malformed-request failures without guessing from prose.
- For brokerOnly downloads, use broker `savePath` for binary or large responses such as PDFs, images, archives, audio, or video. Treat `truncated=true` on non-`savePath` responses as a hard failure; never write a truncated `bodyBase64` response to a file.

### Script Skill Entry ABI

AgentVis `ExternalExecutor` passes Script Skill arguments as named CLI flags, not positional arguments and not stdin. Detailed ABI examples and required implementation rules live in `references/agentvis-skill-templates.md`; read that reference before creating or changing any Script Skill.

## Anti-Patterns

- Do not expect Script Skill body instructions to be visible to SA during tool use.
- Do not read env/Home/AppData/Credential Manager secrets inside a brokerOnly Script Skill.
- Do not declare non-HTTP(S) protocols as `brokerProxyPreferred`.
- Do not combine `execution.permissions.network: false` with `networkMode: brokerOnly`.
- Do not add `Authorization`, `Cookie`, or other declared auth headers when using `credentialRef`.
- Do not make a skill Script-only if the agent still needs free-form procedural instructions to use it correctly.
- Do not convert a working third-party Guide Skill into Script only because it hit the network sandbox; add the correct AgentVis network metadata first.
- Do not mark public HTTP(S) APIs as `legacyNonHttp`; use `brokerProxyPreferred` for Guide helpers or `brokerOnly` for Script helpers.
- Do not add proxy-bypass settings such as `NO_PROXY=*`, `--noproxy`, `proxy-server=direct://`, `trust_env=False`, or empty proxy maps to make a network script work locally.
- Do not name Guide Python HTTP helper functions `fetch`; use `api_get`, `request_json`, or another name without the literal `fetch(` pattern.
- Do not fix brokerProxyPreferred blocks by adding manual `proxies={}` dictionaries, spawning `curl.exe` inside Python, or disabling TLS verification.
- Do not place architecture instructions in `description`; use description for retrieval and when-to-use semantics.
- Do not validate a Script Skill by running positional commands such as `python script.py lodash` when the contract declares `packageName`; use `python script.py --packageName lodash`.
- Do not treat a failed `external_skill_execute` as a sandbox failure until checking contract parsing, CLI flags, and broker helper availability.
- Do not name Python broker helper functions `broker_fetch`; use `broker_request`, `broker_get`, or `broker_post` to avoid the static fetch-call network API scan.
- Do not put brokerOnly URL constants or broker helper subprocess code directly in the declared `execution.entry`; place them in an imported sibling module.
- Do not download binary or large files through broker `bodyBase64`; use `savePath` and validate `savedPath`/`bytesIn`.

## Validate The Skill

Validate according to the skill shape:

- Guide Skill: simulate a realistic user request and confirm the body gives enough information to run the workflow.
- brokerProxyPreferred Guide: run an HTTP(S) smoke task such as scraping a simple page and confirm the helper works through the sandbox's proxy path.
- legacyNonHttp Guide: run `--action network_targets` first and confirm it returns exact protocol, host, and port without opening a socket; then run the real command only after the direct-audit allowance path is expected.
- External Guide retrofit: run the original command that failed, confirm the new frontmatter declares the right network mode, and confirm scripts do not disable proxy environment variables.
- Script Skill: confirm the frontmatter contract can be parsed, args cover every user-facing operation, and the script works from the declared entrypoint.
- Script Skill ABI: confirm every `argsSchema.name` has a matching named parser flag such as `--packageName`; direct smoke commands must use these named flags.
- brokerOnly Script: run a broker helper path where available, confirm direct token reads are absent, and inspect the declared entry file for static-scan tripwires such as URL literals, direct network-client imports, and broker helper subprocess code.
- brokerOnly Script diagnostics: force or inspect a failed broker helper path and confirm the observation preserves `reasonCode`/`errorKind`-derived fields without leaking secrets.
- Script output contract: smoke at least one success, one retryable failure, and one blocked/user-actionable failure when practical; confirm the observations tell Agent whether to retry, stop and report, or suggest a concrete next step.
- credentialRef Script: confirm the request carries `credentialRef` and the observation/logs expose only `credentialApplied`, never the secret.
- mixed Guide: smoke each declared entrypoint separately, because one script may be broker-proxied while another needs direct-audit allowance.

Suggested smoke examples:

1. GitHub API lookup: Script + brokerOnly + `credentialRef`.
2. Web scraper: Guide + package-wide `agentvisNetwork: brokerProxyPreferred`.
3. Email helper: Guide + `agentvisNetworkEntrypoints: scripts/email_helper.py: legacyNonHttp` + `network_targets`.
4. Mixed service helper: Guide with one HTTP(S) entrypoint using `brokerProxyPreferred` and one non-HTTP entrypoint using `legacyNonHttp`.
5. External Polymarket-style helper: existing Guide + public HTTPS API script + package-wide `agentvisNetwork: brokerProxyPreferred`.

If only Markdown/templates changed, TS/Rust checks are not required. If TS/TSX is changed, run ESLint on changed files and `tsc --noEmit`. If Rust is changed, run `cargo check`.

## Improving The Skill

1. Read transcripts, not just final outputs.
2. Remove instructions that do not affect behavior.
3. Extract repeated code into `scripts/` or `templates/`.
4. Move long domain specifics into `references/`.
5. Re-test with fresh prompts after meaningful changes.

Keep going until the user is satisfied, feedback is empty, or further changes no longer improve behavior.

## Install To System

After creation and validation, install the skill into the system by default. Do not ask the user whether to install unless the user explicitly requested a draft-only package. Skills under `_drafts\` are not recognized by the scanner.

Migration flow:

```bat
set PKG=C:\Users\<User>\AppData\Roaming\com.agentvis.app\skills\external\packages
set SKILL={skill-name}
xcopy "%PKG%\_drafts\%SKILL%\SKILL.md" "%PKG%\%SKILL%\" /Y
xcopy "%PKG%\_drafts\%SKILL%\scripts" "%PKG%\%SKILL%\scripts\" /E /I /Y
xcopy "%PKG%\_drafts\%SKILL%\references" "%PKG%\%SKILL%\references\" /E /I /Y
xcopy "%PKG%\_drafts\%SKILL%\templates" "%PKG%\%SKILL%\templates\" /E /I /Y
xcopy "%PKG%\_drafts\%SKILL%\assets" "%PKG%\%SKILL%\assets\" /E /I /Y
xcopy "%PKG%\_drafts\%SKILL%\agents" "%PKG%\%SKILL%\agents\" /E /I /Y
```

After migration, tell the user to refresh the list in Settings -> Skill Management and manually test the skill. If the skill has problems, adjust it by copying the installed package back to `_drafts\{skill-name}\`, patching there, validating again, and reinstalling.

For updates, copy the installed skill to `_drafts\{skill-name}\`, modify and validate there, then overwrite-install after approval.
