---
name: cron
description: Manage scheduled tasks. Supports creating, listing, updating, and deleting one-time or recurring automation jobs so the Agent can follow up on reminders, periodic needs, or proactive important tasks.
category: custom
complexity: 2
requiresAuth: false
---

# cron Tool

Manage scheduled tasks (`CronJob`) for the current Agent. When a schedule is reached, the system sends the configured cron prompt back to the Agent automatically.

## When To Use

- The user asks to create a timed, scheduled, or recurring task.
- The user asks to view, update, delete, pause, or resume an existing scheduled task.
- The user asks for a reminder about a todo, event, deadline, or recurring need.
- The Agent decides that a positive follow-up or proactive check-in is useful and appropriate.

## When Not To Use

- The user only wants an immediate one-time action -> perform the action directly instead of creating a scheduled task.
- The user wants to change unrelated Agent settings such as model, rules, or profile configuration.
- The task has no timing, reminder, follow-up, or recurring component.

## Decision Hint

- `cron` is a medium-risk scheduling tool, but ordinary use should use `behaviorHint='direct'`.
- Convert the user's natural-language time request into a five-field cron expression.
- For `create`, write a complete, self-contained `prompt`. The future execution may not have the current chat context.
- For reminders, schedule the reminder before the event. If the user gives no lead time, default to about 15 minutes before the event.
- If the user says "a little earlier", use roughly 15-30 minutes before the event unless context suggests otherwise.
- For execution tasks such as "do X at 9:00", schedule the task at the exact requested time.
- For follow-up tasks, choose a reasonable time based on the user's history and the importance of the event.
- If the requested time is ambiguous or impossible to infer safely, ask a concise clarification before creating the job.

## Rules

1. `action` is always required: `create`, `list`, `update`, or `delete`.
2. `create` requires `name`, `cronExpression`, and `prompt`.
3. `update` requires `jobId` and at least one field to change: `name`, `cronExpression`, `prompt`, or `enabled`.
4. `delete` requires `jobId`.
5. Get `jobId` from `list` before updating or deleting a job unless the user already provided a valid ID.
6. Cron expressions must use standard five-field format: `minute hour day-of-month month day-of-week`.
7. The scheduled `prompt` must be an executable instruction, not just a restatement of the user's request.

## Cron Expression Reference

| Expression | Meaning |
| --- | --- |
| `0 9 * * *` | Every day at 09:00 |
| `30 8 * * 1-5` | Every weekday at 08:30 |
| `0 */2 * * *` | Every 2 hours on the hour |
| `0 9 * * 1` | Every Monday at 09:00 |
| `0 9 1 * *` | On the 1st day of every month at 09:00 |
| `*/30 * * * *` | Every 30 minutes |

Use five fields only. Do not use six-field or seven-field cron syntax.

## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string | Yes | Action type: `create`, `list`, `update`, or `delete`. |
| `name` | string | create/update | Job name. |
| `cronExpression` | string | create/update | Five-field cron expression. |
| `prompt` | string | create/update | Prompt sent to the Agent when the schedule triggers. |
| `jobId` | string | update/delete | Job ID, obtained from `list`. |
| `enabled` | boolean | create/update | Whether the job is enabled. Defaults to `true`. |

## Examples

### Create A Scheduled Task

```json
{
  "action": "create",
  "name": "Daily AI news brief",
  "cronExpression": "0 9 * * *",
  "prompt": "Search for the latest important AI news and product updates from today, then summarize the key developments, why they matter, and any links worth reading."
}
```

### List Scheduled Tasks

```json
{
  "action": "list"
}
```

### Update A Scheduled Task

```json
{
  "action": "update",
  "jobId": "<job-id>",
  "cronExpression": "0 8 * * 1-5",
  "name": "Weekday AI news brief"
}
```

### Pause A Scheduled Task

```json
{
  "action": "update",
  "jobId": "<job-id>",
  "enabled": false
}
```

### Delete A Scheduled Task

```json
{
  "action": "delete",
  "jobId": "<job-id>"
}
```

## Common Mistakes

- Cron expression error: use exactly five fields in the order `minute hour day-of-month month day-of-week`.
- Missing `jobId`: update and delete operations must identify the target job.
- Too-short prompt: scheduled prompts must be self-contained because they may run without the original conversation context.
- Scheduling a reminder at the event time when the user expected advance notice.
