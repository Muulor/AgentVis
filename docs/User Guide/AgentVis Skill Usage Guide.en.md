# AgentVis Skill Usage Guide

> Scope: AgentVis "Settings -> Skills", a single Agent's "Agent Settings -> Skills", and skill selection through `/` in the chat input box.

---

## 1. What This Guide Covers

In AgentVis, a Skill can be understood as a specialized capability added to an Agent. For example:

- Make an Agent better at browsing webpages, querying GitHub, or searching papers.
- Let an Agent generate documents, slides, charts, or reports in specific formats.
- Let an Agent call a stable script to complete queries, conversions, batch processing, or automation tasks.

A skill is a capability package an Agent can use while executing tasks. After installation, you can enable it globally, bind several frequently used skills to a specific Agent, or temporarily type `/` in chat and choose the skill to use for the current task.

In normal use, you usually only need to care about three things:

- Whether the skill is installed and enabled.
- Whether this Agent needs certain skills bound permanently.
- Whether this chat should temporarily specify a skill.

---

## 2. Where Skills Appear

### 2.1 Global Skill Settings

Open AgentVis:

1. Go to "Settings".
2. Click "Skills" on the left.

This page manages all installed skills:

- View the skill list.
- View skill type tags, such as `Guide` or `Script`.
- Enable or disable a skill.
- Open skill details.
- Install dependencies required by a skill.
- Import a local skill folder.
- Install from a GitHub skill URL.
- Refresh the list after installing or modifying skills.

### 2.2 Skill Settings for a Single Agent

Open an Agent:

1. Go to "Agent Settings".
2. Click "Skills" at the top.

This page configures the skill strategy dedicated to that Agent:

- Enable or disable "Pinned Skill Mode".
- Select 1-5 skills to bind directly to the current Agent.
- After saving, this Agent will prioritize your bound skills in Task mode.

### 2.3 Skill Selection Through `/` in Chat

Type `/` in the chat input box. AgentVis will show a list of available skills. You can choose a skill so the Agent explicitly references or calls it for the current task.

This is suitable for stable tasks. For example, you may not usually need to permanently bind `arxiv-search`, but if this task should use that skill to search papers instead of web search or other channels, choose it in the input box.

---

## 3. Recommended Usage Patterns

### 3.1 When You Are Not Sure Which Skill to Use

Keep global skills enabled, then describe the task directly. AgentVis will decide whether to call relevant skills based on your task. If you want to know which skills are currently installed or how a skill should be used, you can ask the Agent directly.

Suitable for:

- Exploratory tasks.
- Cases where you are not sure which skill is best.
- Cases where you want the Agent to decide whether a skill is needed.

### 3.2 When You Want an Agent to Reliably Use Fixed Skills

Go to "Agent Settings -> Skills", enable "Pinned Skill Mode", select 1-5 skills commonly used by this Agent, then save.

Suitable for:

- Giving an Agent a fixed role.
- Making it work with several stable capabilities every time.
- Avoiding unrelated skills being selected from global skills.

Examples:

- Research Agent: bind skills such as `arxiv-search` and `web-scraper`.
- Frontend design Agent: bind skills such as `frontend-design` and `html-slides`.
- Office assistant Agent: bind skills such as `docx`, `xlsx`, and `file-organizer`.

### 3.3 When You Only Want to Use a Skill for This Task

Type `/` in the chat input box, choose a skill, then add your task description.

Suitable for:

- Using a specific skill to execute a deterministic task.
- Avoiding changes to the Agent's long-term configuration.
- Explicitly telling the Agent, "use this capability for this task."

---

## 4. Install New Skills

### 4.1 Import from a Local Folder

1. Open "Settings -> Skills".
2. Find the "Install new skill" area.
3. Click "Import folder".
4. Select the skill package directory that contains `SKILL.md`.
5. In the dialog, choose "Install directly" or "Start review".
6. Confirm whether to continue installation based on the security review result.
7. After installation is complete, click "Refresh list".

A skill package usually contains at least one `SKILL.md` file. More complex skills may also include scripts, templates, resource files, or dependency declarations.

### 4.2 Install from a GitHub URL

1. Open "Settings -> Skills".
2. Paste the skill directory URL into the GitHub URL input box.
3. In the dialog, choose "Install directly" or "Start review".
4. Confirm whether to continue installation based on the security review result.
5. Click "Refresh list" to confirm the skill appears.

A GitHub URL usually points to a specific skill directory in a repository, for example:

```text
https://github.com/owner/repo/tree/main/skills/skill-name
```

### 4.3 Why Refresh the List After Installing or Editing

AgentVis scans skill directories and registers available skills. After installing a new skill, modifying skill content, or manually replacing a skill package, click "Refresh list" so the new skill definition takes effect.

---

## 5. Enable, Disable, and View Details

In "Settings -> Skills", each skill has a switch on the right.

- Enabled: the skill can be retrieved, selected, or called by Agents.
- Disabled: the skill remains local, but does not participate in use.
- Details entry: view the skill description, type, and possible execution information.

If you temporarily do not want to use a skill, disable it instead of directly removing files. If you removed an AgentVis built-in skill package and want to restore it, find the `skills-bundle` folder under the installation directory, locate the relevant skill, import it, and click direct install.

---

## 6. Guide Skills and Script Skills

AgentVis currently supports two types of External Skill: `Guide` and `Script`.

### 6.1 Guide Skills

Guide skills follow a structure similar to common skills in the broader ecosystem. They are more like capability manuals written for the Agent. They tell the Agent:

- What tasks this skill is suitable for.
- How to think when encountering this kind of task.
- Which workflows, templates, scripts, or resources can be used.

A Guide skill does not force the Agent to execute only one script. The Agent reads the skill instructions, then plans based on the current task.

Suitable for:

- Open-ended tasks such as writing, design, analysis, and code generation.
- Tasks that require the Agent to judge flexibly based on context.
- Custom workflow tasks.

### 6.2 Script Skills

Script skills are execution-oriented skills specific to AgentVis. In addition to describing a capability, they declare a clear execution contract, including:

- Skill name and description.
- Which parameters can be passed in.
- Parameter types and required fields.
- Which script to run.
- Whether network, file, or desktop capabilities are required.

When an Agent calls a Script skill, AgentVis validates parameters first, then runs the script according to the contract. The experience is similar to a lightweight MCP tool: for the Agent, it is a stable callable capability; for the user, it is still installed and managed as a skill package with progressive disclosure.

Suitable for:

- Querying GitHub, ArXiv, APIs, databases, or internal systems.
- Batch file processing, format conversion, and report generation.
- Tasks that need stable parameters and fixed outputs.
- Tasks where network requests should go through the AgentVis broker audit path.

### 6.3 How to Choose Between the Two

| Type | What it resembles | Suitable tasks | Does the user need to write code? |
| --- | --- | --- | --- |
| Guide | A manual for the Agent | Open-ended, workflow-based, creative tasks | Usually no |
| Script | A callable small tool | Stable input/output, script execution, API queries | Usually no; you can ask an Agent to create it |

If you are only using AgentVis, you do not need to write `SKILL.md` manually. You can directly ask an Agent to create a skill for you, for example:

```text
Help me create a skill: after I enter a GitHub repository URL, automatically read its README, latest release, and open issues, then generate a summary.
```

The built-in AgentVis `skill-creator` guides the Agent to create skills according to the AgentVis skill specification. For scenarios that need stable script calls, it will also prioritize Script mode.

---

## 7. Pinned Skill Mode

"Pinned Skill Mode" binds a small number of fixed skills to a specific Agent. After it is enabled, the selected skills are inserted directly into that Agent's task context.

Enable it when:

- This Agent has a clear responsibility or workflow.
- You want it to reliably use a few skills.
- There are many global skills, and automatic retrieval may bring in unrelated ones.

Avoid enabling it when:

- You want the Agent to freely explore global skills.
- This Agent often handles completely different task types.
- You are not sure which skills suit it best.

Notes:

- Pinned Skill Mode only affects the current Agent.
- Pinned Skill Mode mainly takes effect in Task mode.
- After it is enabled, the Agent cannot use other globally enabled skills. Bind only the skills you truly want it to use.

---

## 8. Skills and Safety

Skills may be only instruction documents, or they may contain executable scripts. When installing third-party skills, prioritize trusted sources and read the security review results carefully.

Recommendations:

- Do not directly use skills from uncertain sources in important workspaces.
- When running a third-party Script skill for the first time, consider switching the Agent's sandbox permission to "Offline Isolated" or "Controlled Network".
- For skills involving API keys, tokens, cookies, or account credentials, use only skill packages you trust.
- If the security review reports high risk, do not continue installation just because the skill name looks useful.

AgentVis provides security review, sandbox permissions, network audit, and sensitive-information redaction during installation and runtime, but these mechanisms cannot replace your judgment about the skill source.

---

## 9. Troubleshooting

### 9.1 A Newly Installed Skill Does Not Appear in the List

Check:

1. Whether the skill directory contains `SKILL.md`.
2. Whether `SKILL.md` follows the required format.
3. Whether you clicked "Refresh list".
4. Whether the skill name conflicts with an existing skill.
5. If installed from GitHub, confirm the URL points to a specific skill directory.
6. If security review or dependency installation failed during installation, handle the corresponding prompt first.

### 9.2 The Agent Did Not Use the Skill I Wanted

Check in order:

1. Whether the skill is enabled in "Settings -> Skills".
2. Whether the current Agent has "Pinned Skill Mode" enabled.
3. If Pinned Skill Mode is enabled, whether the target skill is selected.
4. If you only want to use it for this task, whether you selected the skill through `/` in the input box.
5. Whether the task description is clear enough, for example: "Please use arxiv-search to query..."

### 9.3 A Script Skill Failed to Run

Common causes include:

- Missing parameters or incorrect format.
- Python or Node runtime or dependencies are not ready.
- Current sandbox permissions do not allow network access, file access, or desktop control.
- The skill script reported an internal error.
- The target service requires credentials, but credentials are not configured or have expired.

You can view tool call results in chat, or go to "Settings -> Security Audit" to check whether there are blocked, diagnostic, or broker-related records.

### 9.4 Can a Skill Access the Network?

It depends on the skill type, skill declaration, and current Agent sandbox permissions.

- Guide skills usually follow the current Agent sandbox permissions.
- Script skills can declare more explicit network policies.
- Script skills requiring stronger audit may use a broker-only path, where AgentVis sends HTTP(S) requests on their behalf and records audit events.
- In Offline Isolated mode, skills cannot access the network by default.

### 9.5 Can a Skill Control the Desktop or Browser?

It depends on the skill capability and sandbox permissions.

- General desktop control usually requires "Local Audit" mode.
- In "Controlled Network" mode, AgentVis only opens a narrow path for dedicated browser automation by default. This is not the same as allowing arbitrary desktop control.
- "Offline Isolated" mode blocks desktop control, screenshots, hotkeys, external GUI launch, and related capabilities.

---

## 10. Recommended Configuration Checklist

Before daily use, quickly confirm:

- The skills you need are installed.
- Skills are enabled in "Settings -> Skills".
- You clicked "Refresh list" after installing or modifying skills.
- For a fixed-purpose Agent, common skills are bound in "Agent Settings -> Skills".
- For a temporary task, the skill was selected through `/` in the chat input box.
- You have read the security review results for third-party skills.
- Untrusted scripts or high-risk tasks are paired with suitable sandbox permissions.
