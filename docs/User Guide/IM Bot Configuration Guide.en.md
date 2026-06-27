# AgentVis IM Bot Configuration Guide

> Scope: Configure Feishu enterprise self-built app bots and Slack App bots in AgentVis "Settings -> IM Channels".

---

## 1. What This Guide Covers

AgentVis supports converting Feishu or Slack messages into Agent tasks: when a user sends a message to the bot in IM, the AgentVis desktop app receives it, hands the task to the bound Agent, and uses message cards to show execution progress, the stop button, final results, and error messages.

The places where users most often get stuck are usually not in the AgentVis settings page, but in the Feishu Open Platform or Slack App console:

- Where to create the bot app.
- Which permissions must be enabled.
- Which events must be subscribed to.
- Whether a public callback URL is required.
- Which IDs, secrets, and tokens need to be copied back to AgentVis.
- Why the bot still cannot receive messages after configuration.

AgentVis currently uses long-connection mode for all IM channels:

- Feishu: uses Feishu Open Platform WebSocket long connections to receive events. No public Webhook server is required.
- Slack: uses Slack Socket Mode to receive events and interactive callbacks. No public Request URL is required.

In other words, you only need to create the app in the platform console, enable bot capabilities, authorize permissions, subscribe to events, and paste the credentials back into AgentVis.

---

## 2. AgentVis Settings Field Reference

Open AgentVis:

1. Go to "Settings".
2. Click "IM Channels" on the left.
3. Choose "Add Feishu bot" or "Add Slack bot".

### 2.1 Feishu Fields

| AgentVis field | Where to get it | Description |
| --- | --- | --- |
| Display name | Fill it yourself | Only shown in the AgentVis settings page. Use a business name such as "Marketing Feishu bot". |
| App ID | "Credentials and Basic Info" for the Feishu Open Platform app | Looks like `cli_xxx`. |
| App Secret | "Credentials and Basic Info" for the Feishu Open Platform app | Sensitive information. Only enter it into AgentVis. Do not send it to others. |
| Hub | Local AgentVis Hub | Narrows the selectable Agent range. |
| Target Agent | Local AgentVis Agent | IM messages from this bot are handed to this Agent for execution. |
| Default proactive-send target | Optional | Used by the `im_send` tool, scheduled tasks, and non-IM-triggered tasks. For first-time configuration, leave it empty. AgentVis will prefer falling back to the current or most recent Feishu conversation. |

If you want to manually fill in the default proactive-send target:

- Group chats or one-on-one chat sessions usually use `chat_id`, such as `oc_xxx`.
- Private users can also use `open_id`, `user_id`, `union_id`, or `email`.
- If users only send tasks from Feishu, you do not need to fill in this field first.

### 2.2 Slack Fields

| AgentVis field | Where to get it | Description |
| --- | --- | --- |
| Display name | Fill it yourself | Only shown in the AgentVis settings page. |
| Bot User OAuth Token | Slack App "OAuth & Permissions" | Looks like `xoxb-...`. Used to send messages, update cards, and upload files. |
| App-Level Token | Slack App "Basic Information -> App-Level Tokens", or created through the Socket Mode guide | Looks like `xapp-...` and must include `connections:write`. Used for the Socket Mode long connection. |
| Hub | Local AgentVis Hub | Narrows the selectable Agent range. |
| Target Agent | Local AgentVis Agent | Slack messages from this bot are handed to this Agent for execution. |
| Default proactive-send Channel | Optional | Used by the `im_send` tool, scheduled tasks, and non-IM-triggered tasks. For first-time configuration, leave it empty. AgentVis will prefer falling back to the current or most recent Slack conversation. |

If you manually fill in the default proactive-send Channel, enter the Slack Channel ID, not the channel name:

- Bot message: usually starts with `B`, such as `B1234567890`.
- Public channel: usually starts with `C`, such as `C1234567890`.
- Private channel or multi-person DM: usually starts with `G`.
- One-on-one DM: usually starts with `D`.

---

## 3. Configure a Feishu Bot

### 3.1 Create an Enterprise Self-Built App

1. Open [Feishu Open Platform App Management](https://open.feishu.cn/app).
2. Log in with your enterprise account.
3. Click "Create app".
4. Choose "Enterprise self-built app".
5. Fill in an app name, such as `AgentVis bot`. The app description and icon can be filled in as you like. Then click create.
6. After creation, enter the app details page.

### 3.2 Copy App ID and App Secret

1. On the app details page, go to "Basic Information -> Credentials and Basic Info".
2. Find `App ID` and copy it to AgentVis `App ID`.
3. Find `App Secret` and copy it to AgentVis `App Secret`.

`App Secret` is a sensitive credential. Keep it only in AgentVis local credential storage. Do not take screenshots or paste it into chat groups.

### 3.3 Configure Permissions

Go to "Development Configuration -> Permission Management -> Enable permissions". You can copy the Scope field and add the permissions below. Different tenant consoles may show Chinese names or scope names. If you cannot find a permission, search for the scope directly.

Recommended minimum permissions:

| Scope | Purpose |
| --- | --- |
| `im:message.p2p_msg:readonly` | Receive one-on-one messages sent by users to the bot. |
| `im:message.group_at_msg:readonly` | Receive group messages where the bot is mentioned. |
| `im:message:send_as_bot` | Send text, card, image, and file messages as the bot. |
| `im:message:update` | Update AgentVis progress cards. |
| `im:message:recall` | Delete or recall messages sent by the bot itself. |
| `im:resource` | Upload and download image and file resources in messages. |

### 3.4 Configure Events and Callbacks

Go to "Development Configuration -> Events and Callbacks".

1. Find "Event configuration" -> "Subscription method", choose "Receive events using long connection", and save the subscription method.
2. Click "Add event", then add: `im.message.receive_v1`, `im.message.recalled_v1`.
3. Find "Callback configuration" -> "Subscription method", choose "Receive events using long connection", and save the subscription method.
4. Click "Add callback", then add: `card.action.trigger`.

AgentVis receives events through long connections, so you do not need to fill in a public callback URL. As long as the AgentVis desktop app is online and connected to the bot, it will receive events through WebSocket.

### 3.5 Publish an App Version

After changing permissions, event subscriptions, or bot capabilities for a Feishu app, you usually need to publish a new version before changes take effect.

1. Go to "Version Management and Release".
2. Create a new version.
3. Fill in the release notes.
4. Submit the release.
5. If your enterprise requires administrator approval, wait for approval.

If the bot still does not respond after configuration, first check whether you forgot to publish a new version.

### 3.6 Connect the Feishu Bot in AgentVis

1. Open AgentVis "Settings -> IM Channels".
2. Click "Add Feishu bot".
3. Fill in the display name, `App ID`, and `App Secret`.
4. Select a Hub.
5. Select the target Agent.
6. Leave the default proactive-send target empty at first.
7. Click "Save credentials".
8. Click "Connect".

After connection succeeds, the status shows "Online".

### 3.7 Test Feishu Messages

One-on-one test:

1. In Feishu, use search, such as the magnifying-glass button at the top of the mobile app, to find the newly created bot by name.
2. Send the bot a text message, such as "Help me write a helloworld text file and send it to me."
3. AgentVis should receive the task and return a progress card in Feishu.

Group chat test:

1. Add the bot to a group chat.
2. Send `@bot hello` in the group.
3. AgentVis only processes group messages that mention the bot. Normal group messages without an `@` mention are ignored.

File test:

1. Send the bot an image or file. The bot should inspect it and reply.
2. Send a message such as "Help me send the XX file from my desktop to me." The Agent will search the computer for the file and send it to Feishu.

---

## 4. Configure a Slack Bot

### 4.1 Create a Slack App

1. Open [Slack Apps Management](https://api.slack.com/apps).
2. Click "Create New App".
3. Choose "From scratch".
4. Fill in the App name, such as `AgentVis bot`.
5. Choose the Slack workspace where the app will be installed.
6. Click create.

### 4.2 Configure Bot Token Scopes

In the Slack App console, go to "OAuth & Permissions" on the left, find "Scopes -> Bot Token Scopes", and add:

| Scope | Purpose |
| --- | --- |
| `app_mentions:read` | Receive messages where the bot is mentioned in channels. |
| `channels:history` | Receive public-channel message events. |
| `groups:history` | Receive private-channel message events. |
| `im:history` | Receive one-on-one DM message events. |
| `mpim:history` | Receive multi-person DM message events. |
| `chat:write` | Send text messages and AgentVis progress cards. |
| `files:write` | Upload images and files sent by the Agent. |
| `files:read` | Download files users send to the bot in Slack. |

Optional permission:

| Scope | When it is needed |
| --- | --- |
| `chat:write.public` | Only needed when the bot must proactively send messages to public channels it has not joined. In general, do not add it at the beginning; invite the bot into the channel first. |

After adding or modifying scopes, reinstall the app to the workspace. Otherwise, the new permissions will not be included in the `xoxb-` token.

### 4.3 Install the App and Copy the Bot User OAuth Token

Still on the "OAuth & Permissions" page:

1. Click "Install to Workspace" or "Reinstall to Workspace".
2. Authorize the app.
3. Return to "OAuth & Permissions".
4. Copy "Bot User OAuth Token".
5. Paste it into the AgentVis `Bot User OAuth Token` field.

This token usually starts with `xoxb-`.

### 4.4 Enable Socket Mode and Copy the App-Level Token

AgentVis uses Slack Socket Mode, so no public Request URL is required.

1. Go to "Settings -> Socket Mode" on the left and enable "Enable Socket Mode".
2. Go to "Settings -> Basic Information" on the left and create an App-Level Token as prompted.
3. Fill in any token name, choose the `connections:write` scope, copy the generated token, which usually starts with `xapp-`, and paste it into the AgentVis `App-Level Token` field.

### 4.5 Configure Event Subscriptions

Go to "Event Subscriptions" on the left.

1. Enable "Enable Events".
2. No Request URL is required when using Socket Mode.
3. Expand "Subscribe to bot events" and add:

| Event | Required? | Purpose |
| --- | --- | --- |
| `app_mention` | Required | Receive messages where the bot is mentioned in channels. |
| `message.im` | Required | Receive one-on-one DM messages. |
| `message.channels` | Recommended | Receive public-channel messages. AgentVis still requires the bot to be mentioned before execution. |
| `message.groups` | Optional | Receive private-channel messages. |
| `message.mpim` | Optional | Receive multi-person DM messages. |

If you only want users to use the bot through DM, you can subscribe only to `message.im`. If users need to mention the bot in channels, at least `app_mention` is required.

### 4.6 Enable Interactivity

Go to "Interactivity & Shortcuts" on the left.

1. Enable "Interactivity".
2. After Socket Mode is enabled, interactive components are sent to AgentVis through WebSocket, so no Request URL is required.
3. Save.

This step receives button clicks on AgentVis cards, such as "Stop task" and "Delete message". If it is not enabled, users can see cards, but button clicks will not trigger AgentVis.

### 4.7 Allow Users to DM the App

If users open the Slack App's Messages tab and see a message such as "Sending messages to this app has been turned off", the message entry is usually not enabled in App Home.

Go to "App Home" on the left:

1. Find "Messages Tab" or "Show Tabs".
2. Enable the option that allows users to send messages from the Messages tab.
3. Save.

Text may differ slightly between Slack console versions. The core requirement is allowing users to send messages to the App's message page.

### 4.8 Connect the Slack Bot in AgentVis

1. Open AgentVis "Settings -> IM Channels".
2. Click "Add Slack bot".
3. Fill in the display name.
4. Enter `Bot User OAuth Token`, meaning `xoxb-...`.
5. Enter `App-Level Token`, meaning `xapp-...`.
6. Select a Hub.
7. Select the target Agent.
8. Leave the default proactive-send Channel empty at first.
9. Click "Save credentials".
10. Click "Connect".

After connection succeeds, the status shows "Online".

### 4.9 Test Slack Messages

DM test:

1. Find your App in Slack's left-side Apps list.
2. Open the Messages tab.
3. Send a message, such as "Please write hello_world.md and send it to me."
4. AgentVis should receive the task and return a progress card.

Channel test:

1. Enter the target channel.
2. Type `/invite @your-bot-name` to invite the bot into the channel.
3. Send `@your-bot-name hello`.
4. AgentVis should receive the message and reply.

File test:

1. Send a file to the bot. The bot should inspect it and reply.
2. If `files:read` is configured, AgentVis can download Slack files sent by users.
3. If `files:write` is configured, you can send the bot "Please send me example.md from my computer", and the Agent can proactively send the file through `im_send`.

---

## 5. Troubleshooting

### 5.1 AgentVis Shows Offline

Check:

- Feishu: whether `App ID` and `App Secret` were swapped or copied incompletely.
- Slack: whether `Bot User OAuth Token` is `xoxb-...` and `App-Level Token` is `xapp-...`.
- Whether the Slack App-Level Token includes `connections:write`.
- Whether the current network can access `open.feishu.cn` or Slack API.
- Whether you republished the Feishu app or reinstalled the Slack App after changing permissions.

### 5.2 The Feishu Bot Cannot Receive Messages

Check in order:

1. Whether the bot is online in AgentVis.
2. Whether the Feishu app has the "Bot" capability enabled.
3. Whether `im.message.receive_v1` is subscribed.
4. Whether the event subscription method is "Receive events using long connection".
5. Whether app permissions include one-on-one messages, group mentions, message sending, and resource permissions.
6. Whether a new version was published and approved by the enterprise if approval is required.
7. Whether the bot was mentioned in group chat. AgentVis ignores group messages that do not mention the bot by default.
8. Old messages sent before the connection succeeded may be ignored by AgentVis. Send a new message after the bot is online.

### 5.3 Feishu Card Buttons Do Not Respond

Check:

- Whether `card.action.trigger` is subscribed.
- Whether a new version including this event was published.
- Whether AgentVis is online.
- If the Feishu client shows a callback timeout toast but the card status has updated correctly, you can usually ignore it. If the button has no effect at all, check event subscription again.

### 5.4 Feishu Image or File Sending Fails

Check:

- Whether bot capability is enabled.
- Whether `im:resource` is present.
- Whether the file size exceeds limits: AgentVis currently controls Feishu images at 10 MB and normal files at 30 MB.
- Whether the app was republished after permission changes.

### 5.5 The Slack Bot Cannot Receive Channel Messages

Check:

1. Whether the App is installed to the workspace.
2. Whether the bot has been invited into the target channel.
3. Whether the bot was mentioned in the channel message.
4. Whether `app_mention` is subscribed.
5. If relying on regular message events, whether the corresponding type is subscribed:
   - Public channel: `message.channels`
   - Private channel: `message.groups`
   - DM: `message.im`
   - Multi-person DM: `message.mpim`
6. Whether scopes include the corresponding history scope.
7. Whether you clicked "Reinstall to Workspace" after modifying scopes or events.

### 5.6 Slack DM Says Users Cannot Send Messages to the App

Go to "App Home" and enable the option that lets users send messages from the Messages tab. After enabling it, you may need to reinstall the App or ask users to reopen the Slack client.

### 5.7 Slack Card Buttons Do Not Respond

Check:

- Whether "Interactivity & Shortcuts" is enabled.
- Whether Socket Mode is enabled.
- Whether the App-Level Token includes `connections:write`.
- Whether AgentVis is online.

### 5.8 Slack Sending or Deleting Messages Fails

Check:

- Whether `chat:write` exists.
- Whether the bot is in the target channel.
- Whether the default proactive-send Channel is a channel ID, not a channel name.
- If you want to send messages to a public channel the bot has not joined, add `chat:write.public`; it is still more recommended to invite the bot into the channel first.

### 5.9 Slack File Download or Upload Fails

Check:

- Downloading files sent by users requires `files:read`.
- Proactively uploading files from the Agent requires `files:write`.
- Whether the App was reinstalled after scopes changed.
- Whether the bot can access the channel or DM.

---

## 6. Recommended Configuration Checklist

### 6.1 Feishu

- Enterprise self-built app has been created.
- Bot capability is enabled.
- `App ID` and `App Secret` have been copied to AgentVis.
- Permissions include at least:
  - `im:message.p2p_msg:readonly`
  - `im:message.group_at_msg:readonly`
  - `im:message:send_as_bot`
  - `im:message:update`
  - `im:message:recall`
  - `im:resource`
- Event subscription method is long connection.
- Events have been added:
  - `im.message.receive_v1`
  - `im.message.recalled_v1`
- Callback has been added:
  - `card.action.trigger`
- App has published a new version.
- Hub and target Agent are selected in AgentVis.
- Bot status is online in AgentVis.

### 6.2 Slack

- Slack App has been created.
- Bot Token Scopes include at least:
  - `app_mentions:read`
  - `channels:history`
  - `groups:history`
  - `im:history`
  - `mpim:history`
  - `chat:write`
  - `files:write`
  - `files:read`
- App has been installed or reinstalled to the workspace.
- `xoxb-...` has been copied to AgentVis `Bot User OAuth Token`.
- Socket Mode is enabled.
- App-Level Token has been created with scope `connections:write`.
- `xapp-...` has been copied to AgentVis `App-Level Token`.
- Required bot events have been added in Event Subscriptions.
- Interactivity is enabled.
- If DM is needed, the App Home Messages tab allows users to send messages.
- Hub and target Agent are selected in AgentVis.
- Bot status is online in AgentVis.

---

## 7. Security Recommendations

- `App Secret`, `xoxb-...`, and `xapp-...` are sensitive credentials. Do not commit them to Git or send them to others.
- If you suspect credential leakage:
  - Feishu: reset App Secret in the Open Platform, then update AgentVis.
  - Slack: regenerate the corresponding token in OAuth & Permissions or Basic Information, then update AgentVis.
- Give the bot the minimum necessary permissions. Add resource or file permissions only when file capabilities are needed.
- In Slack, prefer inviting the bot into channels where it is needed instead of granting `chat:write.public` from the start.
- Each AgentVis bot should preferably bind to one clear target Agent, so users know who will execute tasks sent from IM.

---

## 8. Reference Links

Feishu:

- [Feishu Open Platform App Management](https://open.feishu.cn/app)
- [Receive events using long connections](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [Receive message event im.message.receive_v1](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [Send message API](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)
- [Card interaction callback](https://open.feishu.cn/document/feishu-cards/card-callback-communication?lang=zh-CN)
- [Update sent message cards](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch?lang=zh-CN)
- [Upload images](https://open.feishu.cn/document/server-docs/im-v1/image/create?lang=zh-CN)
- [Upload files](https://open.feishu.cn/document/server-docs/im-v1/file/create?lang=zh-CN)
- [Get resource files from messages](https://open.feishu.cn/document/server-docs/im-v1/message-resource/get?lang=zh-CN)

Slack:

- [Slack Apps Management](https://api.slack.com/apps)
- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [app_mention event](https://docs.slack.dev/reference/events/app_mention/)
- [message event](https://docs.slack.dev/reference/events/message/)
- [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [files:write scope](https://docs.slack.dev/reference/scopes/files.write/)
- [files:read scope](https://docs.slack.dev/reference/scopes/files.read/)
- [Working with files](https://docs.slack.dev/messaging/working-with-files)
