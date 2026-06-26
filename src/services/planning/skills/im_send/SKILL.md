---
name: im_send
description: Send text messages, images, or local files to Feishu or Slack through an AgentVis-configured IM bot. Use this native tool when the user asks to send something to IM, deliver a report or generated file, send an image, or notify an IM chat/channel from a scheduled task.
category: custom
complexity: 2
requiresAuth: false
---

# im_send Tool

Send a text message, image, or local file through an AgentVis Feishu or Slack bot.

## When To Use

- The user asks to send a message to Feishu, Lark, Slack, or an IM channel.
- The user asks to send a generated report, document, archive, chart, or image to IM.
- A scheduled task needs to proactively notify Feishu or Slack.
- An IM-triggered task needs to send an additional message or attachment back to the current chat, channel, or DM.

## Routing Rules

- Use `behaviorHint='direct'` for ordinary IM sending.
- Prefer omitting `botId`; IM-triggered and bot-bound cron tasks inject the correct bot automatically.
- Prefer omitting `platform` when the task was triggered from Feishu or Slack; the current bot context selects the platform.
- Pass `platform` only when the task is not tied to an IM bot context or when the user explicitly names Feishu/Slack.
- If sending to Slack, pass `channelId` only for a specific channel/DM; otherwise the tool uses the configured default Slack channel, then the active or last remembered Slack chat.
- If sending to Feishu, pass both `receiveIdType` and `receiveId` only for a specific target; otherwise the tool uses the configured default Feishu outbound target, then the active or last remembered Feishu chat.
- When proactively delivering a report, generated file, image, or scheduled-task output, include a concise `text` or `caption` unless the user explicitly asked for the attachment only.

## Platform Differences

- Feishu attachment captions are sent as a separate text card before the image or file. Slack captions are sent in the companion file-control message.
- Feishu images are limited to 10 MB and regular files to 30 MB. Slack file uploads allow larger files, subject to Slack workspace policy.
- Feishu supports receiver ID types such as `chat_id`, `open_id`, `user_id`, `union_id`, and `email`. Slack uses `channelId`.
- If a Slack observation says the failure is a transient network/connectivity issue, retry `im_send` once with the same arguments. If the retry also fails, tell the user Slack network or upload service is temporarily unavailable.
- If a Feishu or Slack send fails because the target is invalid or the bot is not in the chat/channel, do not keep retrying. Tell the user to correct the default outbound target in AgentVis Settings > IM Channels, confirm the bot has joined the target, save it, then send the request again.

## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | string | Optional | `feishu` or `slack`. Usually omit it when current IM context or `botId` is available. |
| `action` | string | Yes | `send_text`, `send_image`, or `send_file`. |
| `text` | string | `send_text`; optional for attachments | Text content to send. For attachments, this is a concise caption or task result summary. |
| `caption` | string | Optional | Alias for attachment caption text. |
| `filePath` | string | `send_image` / `send_file` | Absolute or workdir-relative local file path. |
| `channelId` | string | Slack-specific optional | Slack target channel/DM ID, such as `C...`, `G...`, or `D...`. |
| `receiveIdType` | string | Feishu-specific optional | `chat_id`, `open_id`, `user_id`, `union_id`, or `email`. Required when `receiveId` is provided unless using `chatId`. |
| `receiveId` | string | Feishu-specific optional | Target Feishu receiver ID. |
| `botId` | string | Optional | AgentVis bot ID. Usually omit it. |

## Examples

### Send Text To The Current Or Default IM Target

```json
{
  "action": "send_text",
  "text": "Daily build completed successfully."
}
```

### Send A File To Slack

```json
{
  "platform": "slack",
  "action": "send_file",
  "filePath": "D:/AgentVis/reports/daily-report.pdf",
  "text": "Daily report is complete. The report file is attached below."
}
```

### Send An Image To A Specific Feishu Chat

```json
{
  "platform": "feishu",
  "action": "send_image",
  "filePath": "D:/AgentVis/charts/summary.png",
  "receiveIdType": "chat_id",
  "receiveId": "oc_xxxxxxxxxxxxx"
}
```

## Notes

- Folders cannot be sent directly. Compress a folder into a zip file first, then send the zip.
- The tool reads credentials from AgentVis settings; never ask the user for Feishu App Secret or Slack tokens inside chat.
- Use `im_send`; the legacy native tool names `feishu_send` and `slack_send` are compatibility aliases.
