---
name: github-lookup
description: "Search and query GitHub repositories, read README file, analyze the project source code, browse code, view releases and issues. Use this skill when the user asks about a GitHub project, wants to read source code from a repo, check latest releases, browse repo structure, research the related code implementation and logic, or look up project information. Prefer this over web search for GitHub-specific queries.(notes:This skill can be used anonymously without a token. If encounter a 403 (quota exhausted) or 401 (token expired) error during use, must report it after the task and guide the user to obtain a GitHub Token. After helping the user set it up, the rate limit can be increased from 60 requests/hour to 5000 requests/hour for continued use.)"
triggers: [github-lookup, 仓库查询, 代码库, github仓库, 查看源码, 开源项目, github搜索]
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
      examples: [search, readme, file]
    - name: query
      type: string
      required: false
      description: "Search query for action=search."
    - name: repo
      type: string
      required: false
      description: "Repository in owner/repo format or a GitHub URL."
    - name: path
      type: string
      required: false
      description: "Repository path for action=file or optional subpath for action=tree."
    - name: ref
      type: string
      required: false
      description: "Branch, tag, or commit SHA for action=file."
    - name: sort
      type: string
      required: false
      description: "Search sort for action=search."
      allowedValues: [best-match, stars, forks, updated]
      default: best-match
    - name: state
      type: string
      required: false
      description: "Issue state for action=issues."
      allowedValues: [open, closed, all]
      default: open
    - name: labels
      type: string
      required: false
      description: "Comma-separated label filter for action=issues."
    - name: limit
      type: number
      required: false
      description: "Maximum number of results to display."
      min: 1
      max: 100
      examples: [10, 100]
    - name: max
      type: number
      required: false
      description: "Maximum number of characters for readme/file output."
      min: 1
      examples: [8000, 10000]
    - name: depth
      type: number
      required: false
      description: "Tree display depth for action=tree."
      min: 1
      default: 3
---

# GitHub Lookup Skill for AgentVis

Search repositories, get README files, browse directory structures, read source files, and view Releases and Issues through the GitHub REST API. No additional dependencies are required (only httpx is used).
⚠️ Important: this skill can be used anonymously without a token. If a 403 quota exhausted error or 401 token expired error is encountered during use, the task must report it after completion and guide the user to obtain a token. After configuration, the limit can be increased to continue use.

## Token Configuration (Automatically Reused After First Configuration)

When this skill runs inside AgentVis `brokerOnly`, GitHub authentication is broker-managed: the script sends `credentialRef: "github"` to `agentvis-broker-fetch`, and the main process reads the `github` token from AgentVis Credential Manager and injects `Authorization` only for `https://api.github.com`. The script process does not read the real Home directory, Credential Manager, or token environment variables in broker mode.

**⚠️ Check whether a Token is already configured before running**
- In AgentVis: configure the GitHub token through the existing GitHub token setting; it is stored under provider `github` in Credential Manager.

### Token Application

1. Open [GitHub Settings → Tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Select the `public_repo` permission (only reading public repositories is needed)
4. Copy the generated Token (starts with `ghp_`) and save it through the AgentVis GitHub token setting so the broker can read provider `github`

## Troubleshooting 

| Issue | Solution |
|------|----------|
| API quota exhausted (403) | Configure a GitHub Token to increase the limit from 60 requests/hour to 5000 requests/hour. Save it through the AgentVis GitHub token setting so broker can read provider `github` |
| Token expired/invalid (401) | Go to https://github.com/settings/tokens to regenerate a Token, then update the AgentVis GitHub token setting |
| Repository does not exist (404) | Check whether the owner/repo format is correct |
| Request timeout | Check the network connection; a proxy may be needed |
| File content is empty | When the file is too large, the API does not return content and will provide a download link |
| Binary file | Automatically detected and skipped, with a download link provided |

## Requirements

- Python 3.11+
- httpx (already in the runtime)
- **Recommended**: configure a GitHub Token to increase the API limit (60 → 5000 requests/hour)
