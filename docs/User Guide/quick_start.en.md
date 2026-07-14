# AgentVis Quick Start Guide

> Scope: Complete initial setup after installing AgentVis for the first time, configure models and cloud services, install skill dependencies, create and configure an Agent, and start using the Agent on local projects or files.

---

## 1. What This Guide Covers

This guide is for first-time AgentVis users. It helps you move from "just installed" to "ready to run Agents reliably."

We recommend completing setup in this order:

1. Follow the initial setup wizard to configure API keys, cloud services, and preset skill dependencies.
2. Confirm that the default model, embedding service, and memory-system LLM are configured.
3. Add Tavily search, image generation services, protected paths, and data backup settings as needed.
4. Check common skill dependencies, especially browser automation and office-document skills.
5. Create an Agent and configure Rules, Knowledge Base, scheduled tasks, and workspace files.
6. Run one trial task to confirm the Agent can call the LLM and execute tasks normally.

If you want to get started as quickly as possible, prioritize sections 2, 3, 4, 7, and 10. You can fill in the rest gradually as you use AgentVis.

---

## 2. Complete Initial Setup

When you open the app for the first time, AgentVis shows the "Complete initial setup" wizard. The wizard takes you to the "Settings -> API Keys" and "Settings -> Cloud Services" tabs, and prompts you to install the Python dependencies required by preset skills.

### 2.1 Configure API Keys

After entering "Settings -> API Keys", first configure the model provider you plan to use to drive Agents. For common providers, you can directly enter the corresponding API key.

If you use a custom compatible API, relay service, or private gateway, use the provider named `local`. It is suitable for custom endpoints compatible with OpenAI, Anthropic, or Gemini protocols.

### 2.2 Configure Cloud Services

After entering "Settings -> Cloud Services", you need to configure at least two service types:

- Embedding model provider credentials: used for Knowledge Base, memory, and semantic retrieval.
- Memory-system LLM: used for memory summaries and fact extraction.

We also recommend applying for and configuring a Tavily key. After configuration, Agents can use web search tools more reliably to query public information. DuckDuckGo is used as a free fallback without an API key.

Image generation is not required for initial use. If you want Agents to directly generate images, posters, or visual assets, configure it when needed.

### 2.3 Install Preset Skill Dependencies

The top of the initial setup wizard provides a button for installing Python dependencies for preset skills. Click it and wait for installation to complete. Some built-in skills require these dependencies before their full functionality works correctly.

Dependency installation may take a little time. Do not close the app during installation. Create or use Agents after installation is complete.

---

## 3. Set the Default Model and Manage Models

After entering "Settings -> Models", select the default provider and model. This default configuration is used for:

- The default model when creating a new Agent.
- Security review when installing or importing skills.
- Some system-assistance capabilities, such as model configuration management.

You can add models under an existing provider yourself, or provide the model name, API endpoint, protocol type, and related information so the Agent can use the built-in `model-config` skill to add or adjust the model configuration for you.

For first-time use, choose a stable primary model with suitable response speed. After the basic workflow is running smoothly, configure different models for different Agents.

---

## 4. Configure Protected Paths, Trash Bin, and Data Backups

AgentVis allows Agents to read and write local files, run commands, and work on projects. Before using it on real projects, set up basic safety boundaries and data backups.

### 4.1 Custom Protected Paths and Trash Bin

Go to "Settings -> File Protection" to add custom protected paths. Protected paths receive additional safeguards during file operations and command execution, reducing the risk of accidentally deleting or changing important directories.

Files deleted by the Agent will be moved to the AgentVis Trash Bin. You can also view and restore files from the Trash Bin directly via "Settings -> File Protection" or periodically clean up redundant screenshots and temporary files deleted after the Agent executes tasks.

Files that you remove manually from the right-side workspace file list do not enter the AgentVis Trash Bin. They are sent to the Windows Recycle Bin so that Agent deletion records remain easy to audit. If the item is on a network share or another location that does not support the system Recycle Bin, AgentVis keeps the item and reports the failure instead of falling back to permanent deletion.

### 4.2 Backup, Restore, and Migration

"Settings -> General" also shows key application data information. You can export data as a backup at any time, and import a backup to restore it.

This is helpful when switching computers, reinstalling the system, or migrating AgentVis to another device. Before long-term use, we recommend trying the export and import flow once.

---

## 5. Check Skill Dependencies

After entering "Settings -> Skills", you can view installed skills, their types, enabled status, details, and dependencies.

After completing the initialization wizard and installing Python dependencies, most built-in skills already have the basic runtime conditions they need. Some skills still require additional system-level tools.

AgentVis statically scans skills and shows possible dependencies or risk notices in the details view. Installing these dependencies in advance is recommended to reduce blockers when an Agent uses a skill. In many cases the Agent will try to install dependencies automatically, but pre-installation reduces instability caused by network failures or timeouts.

The most common example is `agent-browser`. If you need Agents to use browser automation or the built-in video-production capabilities, open `agent-browser` and `hyperframes-video`, then install their system tool dependencies.

Some office-document skills may also require system-level tools, such as the built-in `docx`, `xlsx`, and `minimax-pdf` skills. AgentVis statically scans skills and shows possible dependencies or risk notices in their details view.

Recommendations:

- Before first using browser automation, check the `agent-browser` dependencies.
- Before first working on Office, PDF, or spreadsheet tasks, check the relevant document-skill dependencies.
- When importing third-party skills, read the security review results carefully.
- After installing or modifying a skill, click "Refresh list" to apply the skill definition.

---

## 6. Create and Configure an Agent

After creating an Agent, configure its basic capabilities before giving it complex tasks.

### 6.1 Basic Settings, Safety Footer, and Decision Rounds

Go to "Agent Settings -> Basic" to adjust the Sub-Agent Safety Footer and the Decision Rounds limit.

The Safety Footer is a fixed system reminder appended to the attention area at the end of each Sub-Agent LLM call. When enabled, it continuously influences the Agent's execution preferences. It is suitable as an experimental switch for task correction, delivery-quality testing, or safety reminders. Most users can leave it off by default.

Decision rounds limit the number of Master Brain decisions during Task mode execution. The default is 8, the minimum is 3, and the maximum is 20. More complex tasks may need more rounds, but higher limits also increase cost and waiting time.

### 6.2 Rules: Define the Agent's Role and Boundaries

Go to "Agent Settings -> Rules" to configure prompts or rules separately for Chat mode and Task mode.

Good content for Rules includes:

- Agent role definition, such as "frontend engineering assistant", "research assistant", or "product manager".
- Output preferences, such as "give the conclusion first, then the steps" or "all code changes must explain risks".
- Behavioral boundaries, such as "explain the reason before deleting files" or "ask the user first when unsure".

Start with short rules. Add more only after you notice recurring deviations during use.

---

## 7. Configure the Knowledge Base

Go to "Agent Settings -> Knowledge" to upload documents for the current Agent, so it can retrieve and cite them during tasks.

The Knowledge Base supports batch upload and batch deletion. After uploading files, click save. AgentVis will call the embedding model to build an index. When files are deleted, their corresponding vector data is deleted as well.

If you want the Agent to automatically sync deliverables to the Knowledge Base, enable or disable the deliverable-sync options as needed. AgentVis uses a RAG mechanism with retrieval and filtering design. For files synced into the Knowledge Base, the principle is "retrieve relevant content and filter irrelevant content." Enabling this can improve the Agent's memory of historical tasks to some extent, but the right setting depends on your scenario.

Recommendations:

- Project standards, API documentation, and requirements documents are good Knowledge Base candidates.
- Do not keep temporary or outdated files long term, or they may interfere with retrieval.
- After changing the Knowledge Base, test with a simple question to confirm the Agent can cite the materials correctly.

---

## 8. Configure Scheduled Tasks

Go to "Agent Settings -> Scheduled Tasks" to view, create, modify, or delete scheduled tasks with different times, cycles, and contents. Scheduled tasks can be used for periodic reports, webpage checks, reminders, and proactive IM notifications.

You can create scheduled tasks manually, or ask an Agent in natural language. For example:

```text
I have a meeting tomorrow at 2:30 PM. Send me a Feishu reminder one hour in advance.
```

The Agent generates a task plan from the description. After saving, AgentVis runs it in Task mode at the specified time.

Scheduled tasks are suitable for:

- Generating regular reports.
- Checking webpages, repositories, or data sources on a schedule.
- Sending reminders before meetings, releases, or inspections.
- Proactively sending results to Feishu or Slack through IM channels.

---

## 9. Use Workspace Files and Project Directories

The AgentVis message input box and right-side workspace both help Agents access task files.

### 9.1 Reference Files in the Input Box

Type `@` in the message input box to show current workspace files. You can type a file prefix or full name to find and reference a file precisely.

For example, tell the Agent: "Please implement this according to the plan document."

### 9.2 Drag in Files or Folders

The right-side workspace supports dragging files or folders from any path on your computer. Content is fully staged and validated before the batch is committed to the workspace. You can cancel before final commit; once final commit starts, wait for it to finish. Name collisions are avoided automatically, and a folder collision is imported as a separate directory such as `folder (1)`. After import, the Agent can read these files within the workspace scope.

### 9.3 Associate a Project Folder

You can also associate a target folder through the "Project" feature below the message input box. After association, the Agent uses that folder as the workspace. This is suitable for code projects, web projects, or document projects.

For your first trial run, choose a low-risk test directory. Do not directly let the Agent operate on important production projects.

---

## 10. Recommended First Trial Task

After completing the basic configuration, use a low-risk task to verify that the workflow is functioning:

```text
First read the file structure of the current workspace and summarize what this project does. Do not modify any files.
```

If you have already associated a project directory, continue with:

```text
Find out how to start this project and tell me which commands I should run. Do not execute them directly; only give me recommendations.
```

After confirming file reading, model calls, and replies work correctly, you can try asking the Agent to run commands or modify files. When real file changes are involved, prefer confirming through Diff review.

---

## 11. Quick Checklist

Before regular use, confirm the following in order:

- API keys are configured.
- The default provider and model are selected.
- The embedding service and memory-system LLM are configured.
- Preset skill Python dependencies are installed.
- Tavily is configured when web search is needed.
- Image services are configured when image generation is needed.
- You know where protected paths and the Trash Bin are.
- You know how to export important data as a backup.
- Common skill dependencies have been checked, especially `agent-browser`.
- The Agent has Rules, Knowledge Base, or scheduled tasks configured as needed.
- Workspace files or the project directory are associated correctly.
- The first task starts with a read-only, low-risk request.

---

## 12. What to Read Next

After finishing the quick start, continue with:

- [AgentVis Skill Usage Guide](AgentVis%20Skill%20Usage%20Guide.en.md): Learn how to install, enable, bind, and troubleshoot skills.
- [AgentVis Sandbox Permissions and Security Audit Guide](AgentVis%20Sandbox%20Permissions%20and%20Security%20Audit%20Guide.en.md): Understand Local Audit, Controlled Network, Offline Isolation, and Security Audit.
- [IM Bot Configuration Guide](IM%20Bot%20Configuration%20Guide.en.md): Configure Feishu or Slack bots so IM messages can trigger Agent tasks.
