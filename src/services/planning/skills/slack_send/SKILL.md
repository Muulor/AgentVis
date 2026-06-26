---
name: slack_send
description: Send text messages, images, or local files to Slack through an AgentVis-configured Slack bot. Use this native tool when the user asks to send something to Slack, send a report or generated file, send an image, or notify a Slack channel from a scheduled task.
category: custom
complexity: 2
requiresAuth: false
---

# slack_send Tool

Send a text message, image, or local file through an AgentVis Slack bot.

## When To Use

- The user asks to send a message to Slack.
- The user asks to send a generated report, document, archive, chart, or image to Slack.
- A scheduled task needs to proactively notify Slack.
- A Slack-triggered task needs to send an additional message or attachment back to the current channel or DM.

## Routing Rules

- Use `behaviorHint='direct'` for ordinary Slack sending.
- Prefer omitting `botId`; IM-triggered and bot-bound cron tasks inject the correct bot automatically.
- Prefer omitting `channelId` when the target is the configured default Slack channel for the bot.
- If `channelId` is omitted, the tool resolves the target in this order:
  1. The current bot's default Slack channel from IM channel settings.
  2. The active Slack chat for the current bot.
  3. The last remembered Slack chat for the current bot.
- If sending to a specific target, pass `channelId`.
- When proactively delivering a report, generated file, image, or scheduled-task output, include a concise `text` or `caption` unless the user explicitly asked for the attachment only.

- If an observation says the failure is a transient Slack network/connectivity issue, retry `slack_send` once with the same arguments. If the retry also fails, tell the user Slack network or upload service is temporarily unavailable.
- If a send fails because the channel is invalid or the bot is not a member, do not keep retrying. Tell the user to enter the correct default Channel ID in AgentVis Settings > IM Channels > the matching Slack bot, confirm the bot has joined the target channel, save it, then send the request again.

## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string | Yes | `send_text`, `send_image`, or `send_file`. |
| `text` | string | `send_text`; optional for attachments | Text content to send. For `send_image` / `send_file`, this is sent as the companion file caption. |
| `caption` | string | Optional | Alias for attachment caption text. |
| `filePath` | string | `send_image` / `send_file` | Absolute or workdir-relative local file path. |
| `channelId` | string | Optional | Slack target channel/DM ID, such as `C...`, `G...`, or `D...`. |
| `botId` | string | Optional | AgentVis bot ID. Usually omit it. |

## Examples

### Send Text To The Default Target

```json
{
  "action": "send_text",
  "text": "Daily build completed successfully."
}
```

### Send A File To The Default Target

```json
{
  "action": "send_file",
  "filePath": "D:/AgentVis/reports/daily-report.pdf",
  "text": "Daily report is complete. The report file is attached below."
}
```

### Send An Image To A Specific Channel

```json
{
  "action": "send_image",
  "filePath": "D:/AgentVis/charts/summary.png",
  "channelId": "C0123456789"
}
```

## Notes

- File upload uses Slack's external upload flow, not the deprecated `files.upload` API.
- Folders cannot be sent directly. Compress a folder into a zip file first, then send the zip.
- The tool reads credentials from AgentVis settings; never ask the user for Slack tokens inside chat.
