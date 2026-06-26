# AgentVis IM 机器人配置指南

> 适用范围：AgentVis 的「设置 -> IM 通道」中配置飞书企业自建应用机器人和 Slack App 机器人。

---

## 1. 文档指引简述 

AgentVis 支持把飞书或 Slack 消息转成 Agent 任务：用户在 IM 中给机器人发消息，AgentVis 桌面端收到后会把任务交给绑定的 Agent 执行，并用消息卡片展示执行进度、停止按钮、完成结果和错误信息。

普通用户最容易卡住的地方通常不是 AgentVis 设置页，而是飞书开放平台或 Slack App 后台里的这些步骤：

- 去哪里创建机器人应用。
- 哪些权限必须开。
- 哪些事件必须订阅。
- 是否需要配置公网回调 URL。
- 哪些 ID、Secret、Token 要复制回 AgentVis。
- 配置后为什么机器人还收不到消息。

AgentVis 当前的 IM 通道都走长连接模式：

- 飞书：使用飞书开放平台 WebSocket 长连接接收事件，不需要公网 Webhook 服务器。
- Slack：使用 Slack Socket Mode 接收事件和交互回调，不需要公网 Request URL。

也就是说，你只需要在平台后台创建应用、打开机器人能力、授权权限、订阅事件，然后把凭据填回 AgentVis。

---

## 2. AgentVis 设置页字段对照

打开 AgentVis：

1. 进入「设置」。
2. 点击左侧「IM 通道」。
3. 选择「添加飞书机器人」或「添加 Slack 机器人」。

### 2.1 飞书字段

| AgentVis 字段 | 从哪里获得 | 说明 |
| --- | --- | --- |
| 显示名称 | 自己填写 | 只在 AgentVis 设置页中显示，建议用业务名，例如「Marketing 飞书 bot」。 |
| App ID | 飞书开放平台应用的「凭证与基础信息」 | 形如 `cli_xxx`。 |
| App Secret | 飞书开放平台应用的「凭证与基础信息」 | 敏感信息，只填入 AgentVis，不要发给他人。 |
| Hub | AgentVis 本地 Hub | 用于缩小可选 Agent 范围。 |
| 目标 Agent | AgentVis 本地 Agent | 来自该机器人的 IM 消息会交给这个 Agent 执行。 |
| 默认主动发送目标 | 可选 | 给 `im_send` 工具、定时任务、非 IM 触发任务使用。初次配置建议留空，AgentVis 会优先回退到当前或最近一次飞书会话。 |

默认主动发送目标如果要手动填写：

- 群聊或单聊会话通常使用 `chat_id`，形如 `oc_xxx`。
- 私聊用户也可以使用 `open_id`、`user_id`、`union_id` 或 `email`。
- 如果只是用户从飞书里主动发任务，不需要先填这个字段。

### 2.2 Slack 字段

| AgentVis 字段 | 从哪里获得 | 说明 |
| --- | --- | --- |
| 显示名称 | 自己填写 | 只在 AgentVis 设置页中显示。 |
| Bot User OAuth Token | Slack App 的「OAuth & Permissions」 | 形如 `xoxb-...`。用于发送消息、更新卡片、上传文件。 |
| App-Level Token | Slack App 的「Basic Information -> App-Level Tokens」或「Socket Mode」引导创建 | 形如 `xapp-...`，必须带 `connections:write`。用于 Socket Mode 长连接。 |
| Hub | AgentVis 本地 Hub | 用于缩小可选 Agent 范围。 |
| 目标 Agent | AgentVis 本地 Agent | 来自该机器人的 Slack 消息会交给这个 Agent 执行。 |
| 默认主动发送 Channel | 可选 | 给 `im_send` 工具、定时任务、非 IM 触发任务使用。初次配置建议留空，AgentVis 会优先回退到当前或最近一次 Slack 会话。 |

默认主动发送 Channel 如果要手动填写，请填写 Slack Channel ID，而不是频道名称：

- 机器人消息：通常以`B`开头，例如 `B1234567890`。
- 公共频道：通常以 `C` 开头，例如 `C1234567890`。
- 私有频道或多人私聊：通常以 `G` 开头。
- 单人 DM：通常以 `D` 开头。

---

## 3. 飞书机器人配置

### 3.1 创建企业自建应用

1. 打开 [飞书开放平台应用管理](https://open.feishu.cn/app)。
2. 登录你的企业账号。
3. 点击「创建应用」。
4. 选择「企业自建应用」。
5. 填写应用名称，例如 `AgentVis bot`，应用描述和应用图标随意填写选择后点击创建。
6. 创建完成后进入应用详情页。

### 3.2 复制 App ID 和 App Secret

1. 在应用详情页进入「基础信息 -> 凭证与基础信息」。
2. 找到 `App ID`，复制到 AgentVis 的 `App ID`。
3. 找到 `App Secret`，复制到 AgentVis 的 `App Secret`。

`App Secret` 是敏感凭据。建议只保存在 AgentVis 的本机凭据存储中，不要截图、不要粘贴到聊天群里。

### 3.3  配置权限

进入「开发配置 -> 权限管理 -> 开通权限」，可以复制一下Scope字段添加下面权限。不同租户后台可能显示中文名称，也可能显示 scope 名。找不到时可以直接搜索 scope。

建议最小权限：

| Scope | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的单聊消息。 |
| `im:message.group_at_msg:readonly` | 接收群聊中 @ 机器人的消息。 |
| `im:message:send_as_bot` | 以机器人身份发送文本、卡片、图片、文件消息。 |
| `im:message:update` | 更新 AgentVis 进度卡片。 |
| `im:message:recall` | 删除或撤回机器人自己发送的消息。 |
| `im:resource` | 上传和下载消息中的图片、文件资源。 |

### 3.4 配置事件与回调

进入「开发配置 -> 事件与回调」。

1. 找到「事件配置」-「订阅方式」,选择「使用长连接接收事件」,保存订阅方式。
2. 点击「添加事件」，添加：`im.message.receive_v1`, `im.message.recalled_v1`
3. 找到「回调配置」-「订阅方式」,选择「使用长连接接收事件」,保存订阅方式。
4. 点击「添加回调」，添加：`card.action.trigger`

AgentVis 使用长连接接收事件，不需要填写公网回调 URL。只要 AgentVis 桌面端在线并连接了机器人，就会通过 WebSocket 收到事件。

### 3.5 发布应用版本

飞书应用修改权限、事件订阅、机器人能力后，通常都需要发布新版本才会生效。

1. 进入「版本管理与发布」。
2. 创建新版本。
3. 填写版本说明。
4. 提交发布。
5. 如果企业需要管理员审批，等待审批通过。

如果你配置完后机器人仍没有反应，优先检查是否忘记发布新版本。

### 3.6 在 AgentVis 中连接飞书机器人

1. 打开 AgentVis「设置 -> IM 通道」。
2. 点击「添加飞书机器人」。
3. 填写显示名称、`App ID`、`App Secret`。
4. 选择 Hub。
5. 选择目标 Agent。
6. 默认主动发送目标可以先留空。
7. 点击「保存凭据」。
8. 点击「连接」。

连接成功后状态会显示「在线」。

### 3.7 测试飞书消息

单聊测试：

1. 在飞书里譬如手机端顶部放大镜按钮搜索机器人名称找到刚创建的机器人。 
2. 给机器人发送一条文本消息，例如「帮我写一份helloworld文本发给我」。
3. AgentVis 应该收到任务，并在飞书里返回进度卡片。

群聊测试：

1. 把机器人添加到群聊。
2. 在群里发送 `@机器人 你好`。
3. AgentVis 只处理群聊里 @ 机器人的消息；没有 @ 的普通群消息会被忽略。

文件测试：

1. 给机器人发送一张图片或一个文件，机器人会查看并回复。
2. 给机器人发送消息，例如「帮我把桌面的XX文件发给我」，Agent 会在电脑中搜索该文件并发送到飞书。

---

## 4. Slack 机器人配置

### 4.1 创建 Slack App

1. 打开 [Slack Apps 管理页](https://api.slack.com/apps)。
2. 点击「Create New App」。
3. 选择「From scratch」。
4. 填写 App 名称，例如 `AgentVis bot`。
5. 选择要安装的 Slack workspace。
6. 点击创建。

### 4.2 配置 Bot Token Scopes

进入 Slack App 后台左侧「OAuth & Permissions」，找到「Scopes -> Bot Token Scopes」，添加：

| Scope | 用途 |
| --- | --- |
| `app_mentions:read` | 接收频道里 @ 机器人的消息。 |
| `channels:history` | 接收公共频道消息事件。 |
| `groups:history` | 接收私有频道消息事件。 |
| `im:history` | 接收单人 DM 消息事件。 |
| `mpim:history` | 接收多人 DM 消息事件。 |
| `chat:write` | 发送文本消息和 AgentVis 进度卡片。 |
| `files:write` | 上传 Agent 发出的图片和文件。 |
| `files:read` | 下载用户在 Slack 中发给机器人的文件。 |

可选权限：

| Scope | 何时需要 |
| --- | --- |
| `chat:write.public` | 需要机器人向尚未加入的公共频道主动发消息时才需要。一般不建议一开始就加，优先把机器人邀请进频道。 |

添加或修改 scopes 后，需要重新安装应用到 workspace，否则新的权限不会进入 `xoxb-` token。

### 4.3 安装应用并复制 Bot User OAuth Token

仍在「OAuth & Permissions」页面：

1. 点击「Install to Workspace」或「Reinstall to Workspace」。
2. 授权应用。
3. 回到「OAuth & Permissions」。
4. 复制「Bot User OAuth Token」。
5. 粘贴到 AgentVis 的 `Bot User OAuth Token` 字段。

这个 token 通常以 `xoxb-` 开头。

### 4.4 开启 Socket Mode 并复制 App-Level Token

AgentVis 使用 Slack Socket Mode，因此不需要公网 Request URL。

1. 进入左侧「Settings -> Socket Mode」打开「Enable Socket Mode」。。
2. 进入左侧「Settings -> Basic Imformation」按提示创建 App-Level Token。
3. Token Name 随便填，Scope 选择 `connections:write`，生成后复制 token(这个 token 通常以 `xapp-` 开头)，粘贴到 AgentVis 的 `App-Level Token` 字段。

### 4.5 配置 Event Subscriptions

进入左侧「Event Subscriptions」。

1. 打开「Enable Events」。
2. 使用 Socket Mode 时不需要 Request URL。
3. 点开「Subscribe to bot events」并添加：

| Event | 是否必需 | 用途 |
| --- | --- | --- |
| `app_mention` | 必需 | 接收频道里 @ 机器人的消息。 |
| `message.im` | 必须 | 接收单人 DM 消息。 |
| `message.channels` | 建议 | 接收公共频道消息。AgentVis 仍会要求 @ 机器人后才执行。 |
| `message.groups` | 可选 | 接收私有频道消息。 |
| `message.mpim` | 可选 | 接收多人 DM 消息。 |

如果你只想让用户通过 DM 使用机器人，可以只订阅 `message.im`；如果要在频道中 @ 机器人发任务，至少需要 `app_mention`。

### 4.6 开启 Interactivity

进入左侧「Interactivity & Shortcuts」。

1. 打开「Interactivity」。
2. Socket Mode 开启后，交互组件会通过 WebSocket 发送到 AgentVis，不需要配置 Request URL。
3. 保存。

这一步用于接收 AgentVis 卡片上的按钮点击，例如「终止任务」「删除消息」。如果没有打开，用户能看到卡片，但点击按钮不会触发 AgentVis。

### 4.7 允许用户给 App 发 DM

如果用户打开 Slack App 的 Messages tab 时看到「Sending messages to this app has been turned off」之类提示，通常是 App Home 里没有打开消息入口。

进入左侧「App Home」：

1. 找到「Messages Tab」或「Show Tabs」。
2. 打开允许用户从 Messages tab 发送消息的选项。
3. 保存。

不同 Slack 后台版本文案略有差异，核心是允许用户向 App 的消息页发送消息。

### 4.8 在 AgentVis 中连接 Slack 机器人

1. 打开 AgentVis「设置 -> IM 通道」。
2. 点击「添加 Slack 机器人」。
3. 填写显示名称。
4. 填入 `Bot User OAuth Token`，也就是 `xoxb-...`。
5. 填入 `App-Level Token`，也就是 `xapp-...`。
6. 选择 Hub。
7. 选择目标 Agent。
8. 默认主动发送 Channel 可以先留空。
9. 点击「保存凭据」。
10. 点击「连接」。

连接成功后状态会显示「在线」。

### 4.9 测试 Slack 消息

DM 测试：

1. 在 Slack 左侧 Apps 中找到你的 App。
2. 打开 Messages tab。
3. 发送一条消息，例如「请写一个hello_world.md并发给我」。
4. AgentVis 应该收到任务，并返回进度卡片。

频道测试：

1. 进入目标频道。
2. 输入 `/invite @你的机器人名`，把机器人邀请进频道。
3. 发送 `@你的机器人名 你好`。
4. AgentVis 应该收到消息并回复。

文件测试：

1. 给机器人发送一个文件，机器人会查看并回复。
2. 如果配置了 `files:read`，AgentVis 可以下载用户发来的 Slack 文件。
3. 如果配置了 `files:write`，可以给机器人发送「请把电脑中的example.md发给我」，Agent 可以通过 `im_send` 主动发送文件。

---

## 5. 常见问题排查

### 5.1 AgentVis 里显示离线

检查：

- 飞书：`App ID` 和 `App Secret` 是否填反、是否复制完整。
- Slack：`Bot User OAuth Token` 是否为 `xoxb-...`，`App-Level Token` 是否为 `xapp-...`。
- Slack App-Level Token 是否带 `connections:write`。
- 当前网络是否能访问 `open.feishu.cn` 或 Slack API。
- 改完权限后是否重新发布飞书应用或重新安装 Slack App。

### 5.2 飞书机器人收不到消息

按顺序检查：

1. AgentVis 中机器人是否在线。
2. 飞书应用是否启用了「机器人」能力。
3. 是否订阅了 `im.message.receive_v1`。
4. 事件订阅方式是否为「使用长连接接收事件」。
5. 应用权限是否包含单聊、群聊 @、发送消息、资源权限。
6. 是否发布了新版本并通过企业审批。
7. 群聊中是否 @ 了机器人；AgentVis 默认忽略未 @ 机器人的群消息。
8. 连接成功前发送的旧消息可能会被 AgentVis 忽略，请在线后重新发一条新消息。

### 5.3 飞书卡片按钮没有反应

检查：

- 是否订阅了 `card.action.trigger`。
- 是否发布了包含该事件的新版本。
- AgentVis 是否在线。
- 如果飞书客户端弹出回调超时 toast，但卡片状态已经正确更新，通常可以先忽略；如果按钮完全无效，再检查事件订阅。

### 5.4 飞书发送图片或文件失败

检查：

- 是否开启机器人能力。
- 是否有 `im:resource`。
- 文件大小是否超过限制：AgentVis 当前飞书图片按 10 MB 控制，普通文件按 30 MB 控制。
- 应用权限变更后是否重新发布。

### 5.5 Slack 机器人收不到频道消息

检查：

1. App 是否已安装到 workspace。
2. 机器人是否被邀请进目标频道。
3. 频道消息中是否 @ 了机器人。
4. 是否订阅了 `app_mention`。
5. 如果依赖普通 message 事件，是否订阅了对应类型：
   - 公共频道：`message.channels`
   - 私有频道：`message.groups`
   - DM：`message.im`
   - 多人 DM：`message.mpim`
6. scopes 是否包含对应 history scope。
7. 修改 scopes 或 events 后是否点击了「Reinstall to Workspace」。

### 5.6 Slack DM 显示不能给 App 发消息

去「App Home」里打开 Messages tab 的发送消息选项。打开后可能需要重新安装 App，或让用户重新打开 Slack 客户端。

### 5.7 Slack 卡片按钮没有反应

检查：

- 「Interactivity & Shortcuts」是否开启。
- Socket Mode 是否开启。
- App-Level Token 是否带 `connections:write`。
- AgentVis 是否在线。

### 5.8 Slack 发送或删除消息失败

检查：

- `chat:write` 是否存在。
- 机器人是否在目标频道中。
- 默认主动发送 Channel 是否填了频道 ID，而不是频道名。
- 如果想向未加入的公共频道发消息，需要额外 `chat:write.public`，但更推荐先邀请机器人进频道。

### 5.9 Slack 文件下载或上传失败

检查：

- 下载用户发来的文件需要 `files:read`。
- Agent 主动上传文件需要 `files:write`。
- 改完 scopes 后是否重新安装 App。
- 机器人是否能访问该频道或 DM。

---

## 6. 推荐配置清单

### 6.1 飞书

- 企业自建应用已创建。
- 机器人能力已开启。
- 已复制 `App ID` 和 `App Secret` 到 AgentVis。
- 权限至少包含：
  - `im:message.p2p_msg:readonly`
  - `im:message.group_at_msg:readonly`
  - `im:message:send_as_bot`
  - `im:message:update`
  - `im:message:recall`
  - `im:resource`
- 事件订阅方式为长连接。
- 已添加事件：
  - `im.message.receive_v1`
  - `im.message.recalled_v1`
- 已添加回调：
  - `card.action.trigger`
- 应用已发布新版本。
- AgentVis 中已选择 Hub 和目标 Agent。
- AgentVis 中机器人状态为在线。

### 6.2 Slack

- Slack App 已创建。
- Bot Token Scopes 至少包含：
  - `app_mentions:read`
  - `channels:history`
  - `groups:history`
  - `im:history`
  - `mpim:history`
  - `chat:write`
  - `files:write`
  - `files:read`
- App 已安装或重新安装到 workspace。
- 已复制 `xoxb-...` 到 AgentVis 的 `Bot User OAuth Token`。
- Socket Mode 已开启。
- App-Level Token 已创建，scope 为 `connections:write`。
- 已复制 `xapp-...` 到 AgentVis 的 `App-Level Token`。
- Event Subscriptions 已添加所需 bot events。
- Interactivity 已开启。
- 如需 DM，App Home 的 Messages tab 已允许用户发送消息。
- AgentVis 中已选择 Hub 和目标 Agent。
- AgentVis 中机器人状态为在线。

---

## 7. 安全建议

- `App Secret`、`xoxb-...`、`xapp-...` 都是敏感凭据，不要提交到 Git，也不要发给他人。
- 如果怀疑凭据泄露：
  - 飞书：在开放平台重置 App Secret，然后更新 AgentVis。
  - Slack：在 OAuth & Permissions 或 Basic Information 中重新生成对应 token，然后更新 AgentVis。
- 给机器人添加最小必要权限。需要文件能力时再加资源或文件权限。
- 在 Slack 中优先把机器人邀请进需要使用的频道，而不是一开始就给 `chat:write.public`。
- 一个 AgentVis 机器人建议只绑定一个明确的目标 Agent，避免用户在 IM 里不清楚任务会交给谁执行。

---

## 8. 参考链接

飞书：

- [飞书开放平台应用管理](https://open.feishu.cn/app)
- [使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [接收消息事件 im.message.receive_v1](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [发送消息接口](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)
- [卡片回传交互回调](https://open.feishu.cn/document/feishu-cards/card-callback-communication?lang=zh-CN)
- [更新已发送的消息卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch?lang=zh-CN)
- [上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create?lang=zh-CN)
- [上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create?lang=zh-CN)
- [获取消息中的资源文件](https://open.feishu.cn/document/server-docs/im-v1/message-resource/get?lang=zh-CN)

Slack：

- [Slack Apps 管理页](https://api.slack.com/apps)
- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [app_mention event](https://docs.slack.dev/reference/events/app_mention/)
- [message event](https://docs.slack.dev/reference/events/message/)
- [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [files:write scope](https://docs.slack.dev/reference/scopes/files.write/)
- [files:read scope](https://docs.slack.dev/reference/scopes/files.read/)
- [Working with files](https://docs.slack.dev/messaging/working-with-files)
