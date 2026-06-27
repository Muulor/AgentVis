# AgentVis Skill Templates

Use these templates when creating AgentVis skills or retrofitting an External Guide Skills. Pick one primary shape before writing the package.

## Guide Skill

Use for procedural or exploratory workflows where the Sub-Agent needs Markdown instructions.

````markdown
---
name: example-guide
description: "Use this skill whenever the user asks Agent to perform [workflow]. It provides step-by-step guidance, command examples, output interpretation, and troubleshooting for [domain]."
triggers: [example-guide, example, 示例]
---

# Example Guide

## Workflow

1. Inspect the input and choose the right command or reference.
2. Run the bundled script only when the user request matches the supported operation.
3. Interpret the output and report concise findings.

## Commands

```bash
python scripts/example_helper.py --action inspect --input "<value>"
```

## Troubleshooting

- If the command fails because configuration is missing, explain what needs to be configured.
- If the output is too large, rerun with a narrower filter.
````

## Guide Skill With HTTP(S) Broker Proxy Preference

Use when the Guide helper uses HTTP(S) libraries that respect proxy environment variables. Web scrapers, documentation crawlers, and public HTTP API helpers are the typical examples.

```yaml
---
name: web-scraper
description: "Use this skill whenever the user asks Agent to scrape web pages, crawl documentation, extract page content, collect links, or convert web content to Markdown."
triggers: [web-scraper, scrape, crawl pages, extract web, 网页抓取]
agentvisNetwork: brokerProxyPreferred
---
```

Do not use `brokerProxyPreferred` for IMAP, SMTP, SSH, database sockets, FTP, or raw TCP.

## Retrofitting An External HTTP(S) Guide Skill

Use when an installed third-party Guide Skill already works locally, has no `execution` contract, and runs scripts that call public HTTP(S) APIs through proxy-aware clients such as `requests`, `httpx`, `urllib`, or `curl_cffi`.

Minimal frontmatter patch:

```yaml
---
name: polymarket
description: Query Polymarket prediction markets. Check odds, find trending markets, search events, track price movements.
homepage: https://polymarket.com
agentvisNetwork: brokerProxyPreferred
---
```

Keep existing non-AgentVis fields unless they are invalid. Do not rewrite the skill as Script unless the user explicitly wants `external_skill_execute` with a stable `argsSchema`.

Before testing, check the scripts for proxy bypass settings:

```bash
rg -n "trust_env=False|proxies=|ProxyHandler\\(\\{\\}\\)|NO_PROXY|--noproxy|proxy-server=direct|socket|def fetch\\(|fetch\\(" scripts
```

If the skill has only public HTTPS API calls, do not use `legacyNonHttp`. If only one of several scripts calls HTTP(S), use `agentvisNetworkEntrypoints` and mark that script as `brokerProxyPreferred`.

If the command is still blocked after adding `agentvisNetwork: brokerProxyPreferred`, read the sandbox reason before changing transport code:

- `nodeNativeFetchWithoutProxyAgent` in a Python script usually means the scanner saw a helper named `fetch(...)`. Rename it to `api_get`, `request_json`, or another non-`fetch` name.
- `pythonProxyEnvDisabled` means the script disables proxy inheritance. Remove `trust_env=False`, `proxies={}`, `ProxyHandler({})`, `deleteproxy`, or `NO_PROXY=*`.
- Keep normal `requests.get(...)`, `httpx.get(...)`, or `urllib.request.urlopen(...)` behavior so the process inherits proxy environment variables.
- Do not fix this by spawning `curl.exe` from Python, manually building empty proxy maps, or disabling TLS verification.

Preferred Python shape:

```python
BASE_URL = "https://gamma-api.polymarket.com"

def api_get(endpoint: str, params: dict | None = None) -> dict:
    url = f"{BASE_URL}{endpoint}"
    response = requests.get(url, params=params, timeout=30)
    response.raise_for_status()
    return response.json()
```

## Guide Skill With Legacy Non-HTTP Entrypoint

Use when the Guide helper uses a non-HTTP(S) protocol such as IMAP, SMTP, SSH, database sockets, FTP, or raw TCP. This is the right shape for a pure IMAP/SMTP email helper.

```yaml
---
name: email-helper
description: "Use this skill whenever the user asks Agent to check emails, search inbox messages, send or reply to email, save attachments, manage folders, or mark messages as read/unread through IMAP/SMTP."
triggers: [email, mail, inbox, smtp, imap, send email, check email, reply email]
agentvisNetworkEntrypoints:
  scripts/email_helper.py: legacyNonHttp
---
```

The helper must support a side-effect-free target preflight before opening IMAP/SMTP sockets:

```bash
python scripts/email_helper.py --action network_targets --account default
```

Expected output:

```json
{"targets":[{"protocol":"imap","host":"imap.example.com","port":993},{"protocol":"smtp","host":"smtp.example.com","port":465}]}
```

The real IMAP/SMTP command should run only after the direct-audit allowance path is expected. Do not add `brokerProxyPreferred` unless the package also has a separate HTTP(S) API script.

## Mixed Guide Skill With Entrypoints

Use only when one package has multiple scripts with different network behavior, such as an HTTP(S) API helper plus a legacy non-HTTP helper. If the package is purely IMAP/SMTP, use the legacy non-HTTP Guide template above instead.

```yaml
---
name: mixed-helper
description: "Use this skill whenever the user asks Agent to work with [service]. Prefer the HTTP API helper when possible; use the legacy helper only when the API cannot cover the task."
triggers: [mixed-helper, mixed service, 混合服务]
agentvisNetworkEntrypoints:
  scripts/http_api_helper.py: brokerProxyPreferred
  scripts/legacy_socket_helper.py: legacyNonHttp
---
```

For every `legacyNonHttp` entrypoint, implement a read-only target preflight:

```bash
python scripts/legacy_socket_helper.py --action network_targets --account default
```

The command must return JSON like:

```json
{"targets":[{"protocol":"imap","host":"imap.example.com","port":993}]}
```

It must not open a network socket while producing this output.

## Script Skill With Local Filesystem Access

Use for deterministic local file tools that do not need network access but must read or write a user-provided path in restricted sandboxes.

```yaml
---
name: file-helper
description: "Plan and apply local file operations. Use this skill whenever the user asks Agent to organize, inspect, or modify files in a folder."
triggers: [file-helper, organize files, 整理文件]
execution:
  runtime: python
  entry: scripts/file_helper_entry.py
  timeout: 120
  maxOutput: 65536
  permissions:
    network: false
    filesystem:
      - fromArg: path
        access: readWrite
  argsSchema:
    - name: path
      type: string
      required: true
      description: "Absolute path to the target file or directory."
    - name: action
      type: string
      required: false
      description: "Action to run."
      allowedValues: [plan, inspect, apply]
      default: plan
---
```

`fromArg` must reference a string field in `argsSchema`. Use `readOnly` for inspect-only tools and `readWrite` for tools that move, create, delete, or modify files. Keep the script's own path safety checks; the filesystem grant only makes the declared path visible to the restricted process.

## Script Skill With BrokerOnly HTTP(S)

Use for deterministic, parameterized HTTP(S) tools. The body is not the Sub-Agent's runtime instruction surface, so every operation must be represented in `argsSchema`. Keep the body as fallback troubleshooting and maintainer notes; do not duplicate the full action list, argument list, or examples there.

```yaml
---
name: api-lookup
description: "Search and query [service] through its HTTP API. Use this skill whenever the user asks about [entities], wants structured API results, or needs details from [service]."
triggers: [api-lookup, api search, 服务查询]
execution:
  runtime: python
  entry: scripts/api_lookup_entry.py
  timeout: 60
  maxOutput: 65536
  permissions:
    network: true
    networkMode: brokerOnly
  argsSchema:
    - name: action
      type: string
      required: true
      description: "Operation to run."
      allowedValues: [search, info, read]
      default: search
    - name: query
      type: string
      required: false
      description: "Search query for action=search."
    - name: id
      type: string
      required: false
      description: "Resource id for action=info or action=read."
---
```

The script must call `agentvis-broker-fetch` explicitly. It should not use direct `requests`, `httpx`, `urllib`, `socket`, or native fetch paths for brokerOnly requests. Centralize brokered HTTP(S) calls in helper functions such as `broker_request`, `broker_get`, or `broker_post`.

Use `templates/python_script_entry.py` for the declared entrypoint shape, `templates/python_script_core.py` for the recommended brokerOnly core module, and `templates/python_broker_fetch.py` for a smaller broker helper snippet. The helper function should be named `broker_request`, `broker_get`, or `broker_post`, not `broker_fetch`, because the sandbox static scanner treats a fetch-style call pattern as a direct network API signal.

BrokerOnly helpers should preserve stable failure diagnostics in observations. Include `brokerReasonCode`, `brokerErrorKind`, `brokerTargetHost`, `brokerCredentialRef`, and `credentialApplied` when the helper returns them. This lets Agent distinguish network routing, credential, policy, and malformed-request failures without guessing from prose error text.

Recommended file shape:

```text
scripts/
  package_lookup_entry.py  # declared execution.entry; parse args and call core only
  script_core.py           # broker helper, API URL constants, response handling
```

Keep API base URL constants and broker helper subprocess code out of the declared entry file. The current sandbox scanner inspects `execution.entry` before launch; a thin entry avoids false direct-network blocks while still keeping all network traffic brokered.

## Script Skill Entry ABI

`ExternalExecutor` passes `argsSchema` fields as named CLI flags:

```bash
python scripts/package_lookup_entry.py --packageName "lodash" --registry "npm" --includeMetadata
```

Keep `execution.entry` as a safe relative package path such as `scripts/package_lookup_entry.py`; do not use absolute paths, `..`, quotes, shell metacharacters, or paths outside the skill package.

Keep `argsSchema.name` values compatible with CLI flags: start with a letter or underscore, then use letters, numbers, underscores, or hyphens. Do not use spaces, quotes, dots, slashes, or shell punctuation.

Use local contract metadata for argument constraints instead of complex JSON Schema: `allowedValues` for choices, `min`/`max` for number bounds, `default` for the suggested value, and `examples` for prompt guidance. The values must match the declared `type`, and scripts should mirror the same constraints with `argparse` choices or explicit validation. Keep `description` short and avoid repeating values already expressed by these metadata fields, because the compact Script Skill card renders them together.

Do not parse Script Skill arguments as positional `sys.argv[1]`, `sys.argv[2]`. Match every `argsSchema.name` with an option of the same name:

```python
import argparse

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packageName", required=True)
    parser.add_argument("--registry", choices=["npm", "pypi"], default="npm")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--includeMetadata", action="store_true")
    return parser

args = build_parser().parse_args()
```

Boolean fields are passed only when true, so Python parsers should use `action="store_true"`. Number fields arrive as CLI strings, so parse them with `type=int` or `type=float` in `argparse`.

Do not invent CLI flags that are missing from `argsSchema`; Sub-Agents cannot pass them through `external_skill_execute`. Before finalizing a Script Skill, compare every `argsSchema.name` with the parser's `--name` options and confirm they match exactly.

Direct smoke tests should use the same shape:

```bash
python scripts/package_lookup_entry.py --packageName lodash --registry npm
```

If `external_skill_execute` fails, check parser flags, contract names, and whether the declared entry file contains URL literals or direct network-client imports before blaming the sandbox.

## Script Skill With Broker-Managed Credential

Use when an API token or secret should be held by the AgentVis main process.

```yaml
---
name: github-lookup
description: "Search and query GitHub repositories, read README files, browse code, view releases and issues. Use this skill for GitHub-specific repository research."
triggers: [github-lookup, github, 仓库查询, 开源项目]
execution:
  runtime: python
  entry: scripts/github_lookup_entry.py
  timeout: 60
  maxOutput: 65536
  permissions:
    network: true
    networkMode: brokerOnly
  credentials:
    - id: github
      provider: github
      mode: brokerAuth
      hosts: [api.github.com]
      headerName: Authorization
      headerValuePrefix: "Bearer "
      required: false
  argsSchema:
    - name: action
      type: string
      required: true
      description: "Operation to run."
      allowedValues: [search, info, readme, tree, file, releases, issues]
      default: search
    - name: query
      type: string
      required: false
      description: "Search query for action=search."
    - name: repo
      type: string
      required: false
      description: "Repository in owner/repo format."
---
```

Script requirements:

- Include `credentialRef` in broker helper requests when calling the protected host.
- Do not read `GITHUB_TOKEN`, `GH_TOKEN`, real Home files, AppData files, or Credential Manager in brokerOnly mode.
- Do not send `Authorization` yourself. The broker injects it for allowed HTTPS hosts.
- Treat `credentialApplied=false` as anonymous or missing-credential mode, depending on `required`.

## Legacy Non-HTTP Helper

Use for IMAP, SMTP, SSH, database sockets, FTP, or raw TCP. This is a controlled direct-audit path, not brokerOnly.

```yaml
---
name: database-helper
description: "Use this skill whenever the user asks Agent to inspect [database] metadata or run approved read-only database checks."
triggers: [database-helper, db inspect, 数据库]
agentvisNetworkEntrypoints:
  scripts/database_helper.py: legacyNonHttp
---
```

The helper must support:

```bash
python scripts/database_helper.py --action network_targets --profile default
```

Expected output:

```json
{"targets":[{"protocol":"postgres","host":"db.example.com","port":5432}]}
```

Keep `network_targets` side-effect-free and read-only.
