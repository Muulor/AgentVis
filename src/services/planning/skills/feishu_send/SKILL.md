---
name: feishu_send
description: Send text messages, images, or local files to Feishu through an AgentVis-configured Feishu bot. Use this native tool when the user asks to send something to Feishu, send a report or generated file, send an image, or notify a Feishu chat from a scheduled task.
category: custom
complexity: 2
requiresAuth: false
---

# feishu_send Tool

Send a text message, image, or local file through an AgentVis Feishu bot.

## When To Use

- The user asks to send a message to Feishu.
- The user asks to send a generated report, document, archive, chart, or image to Feishu.
- A scheduled task needs to proactively notify Feishu.
- A Feishu-triggered task needs to send an additional message or attachment back to the current chat.

## Routing Rules

- Use `behaviorHint='direct'` for ordinary Feishu sending.
- Prefer omitting `botId`; IM-triggered and bot-bound cron tasks inject the correct bot automatically.
- Prefer omitting `receiveId` when the target is the configured default outbound target for the bot.
- If `receiveId` is omitted, the tool resolves the target in this order:
  1. The current bot's default outbound target from IM channel settings.
  2. The active Feishu chat for the current bot.
  3. The last remembered Feishu chat for the current bot.
- If sending to a specific target, pass both `receiveIdType` and `receiveId`.
- When proactively delivering a report, generated file, image, or scheduled-task output, include a concise `text` or `caption` in the same `send_file` or `send_image` call unless the user explicitly asked for the attachment only. The tool sends that text first, then sends the attachment.
- If a send fails because the receiver is invalid or the bot is not in the chat, do not keep retrying. Tell the user to enter the correct default outbound target ID in AgentVis Settings > IM Channels > the matching Feishu bot, confirm the ID type matches and the bot has joined the target chat, save it, then send the request again.

## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string | Yes | `send_text`, `send_image`, or `send_file`. |
| `text` | string | `send_text`; optional for attachments | Text content to send. For `send_image` / `send_file`, this is sent before the attachment as a concise caption or task result summary. |
| `caption` | string | Optional | Alias for attachment caption text. Use when `text` would be ambiguous. |
| `filePath` | string | `send_image` / `send_file` | Absolute or workdir-relative local file path. |
| `receiveIdType` | string | Optional | `chat_id`, `open_id`, `user_id`, `union_id`, or `email`. Required when `receiveId` is provided unless using `chatId`. |
| `receiveId` | string | Optional | Target Feishu receiver ID. |
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

### Send An Image To A Specific Chat

```json
{
  "action": "send_image",
  "filePath": "D:/AgentVis/charts/summary.png",
  "receiveIdType": "chat_id",
  "receiveId": "oc_xxxxxxxxxxxxx"
}
```

## Notes

- Image messages support jpg, png, webp, gif, and bmp, up to 10 MB.
- File messages support common file types up to 30 MB.
- MP4 videos are uploaded with Feishu file_type `mp4` and then sent as Feishu message type `media`, not ordinary `file`.
- OPUS audio is uploaded with Feishu file_type `opus` and then sent as Feishu message type `audio`; other audio formats should be sent as ordinary files unless converted to OPUS first.
- Archive files such as zip, rar, 7z, tar, and gz are ordinary file messages and should be uploaded with Feishu file_type `stream`.
- Folders cannot be sent directly. Compress a folder into a zip file first, then send the zip.
- The tool reads credentials from AgentVis settings; never ask the user for App Secret inside chat.
- Do not run the external `feishu-send` Python skill; this native tool replaces it.
