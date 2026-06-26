---
name: external_skill_execute
description: Execute an installed external Script Skill by name through its declared Execution Contract.
category: external
complexity: 4
requiresAuth: false
---

# External Script Skill Execute

Runs an installed external Script Skill through its contract. Use this for Script Skills that declare `execution` metadata in their package `SKILL.md`.

## When To Use

- The task explicitly names an installed Script Skill.
- User needs to create a new Script Skill.
- This tool is only available for Script Skill.
- The Script Skill contract should control arguments, timeout, sandbox network behavior, and broker-only execution.

## When Not To Use

- Do not use this for Guide Skills. Follow the injected guide and use the normal tools it requests.
- Do not directly run a Script Skill entry file with `exec` when `external_skill_execute` is available.
- Do not invent arguments outside the injected Script Skill contract.

## Usage

Call with the exact installed skill name and an `args` object matching that skill's contract.

```json
{
  "skillName": "broker-e2e",
  "args": {
    "url": "https://example.com"
  }
}
```
