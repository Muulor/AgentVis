# LLM Token 预算策略

本文档定义了 AgentVis 如何选择 LLM 生成预算、区分服务商传输限制与本地安全防护，以及如何处理被拒绝的 Token 参数和已接受但被截断的响应。

## 1. 术语与归属

"Token" 一词出现在多个互不相关的限制中。它们不得共享同一个全局常量。

| 限制                  | 含义                                                                                    | 归属                                                        |
| --------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 服务商传输输出        | 从 LLM API 请求的最大输出量。对于推理模型，这可能包括推理内容和可见输出共享同一个预算。 | `services/llm/LlmTokenPolicy.ts` 及 MB 规划常量             |
| 可见输出防护          | 对已解析或流式响应体施加的本地上限。                                                    | Scenario implementation，如 Master Brain                    |
| 推理熔断              | 针对异常推理流的本地估算 Token/时间防护。                                               | Master Brain 推理防护                                       |
| 上下文窗口 / 输入预算 | 最大提示词加历史记录容量及输入截断阈值。                                                | Model registry, ContextWindowManager, attachment processors |
| 循环预算              | 跨多次调用的累计执行预算。                                                              | LoopGovernor / SubAgentRunner                               |
| 外部技能 `maxOutput`  | 进程 stdout/stderr 的字节限制。                                                         | External Skill execution contract                           |

因此，`contextWindow`、本地 `nCtx`、附件 `maxTokens`、LoopGovernor 预算和外部技能 `maxOutput` 均不属于服务商输出策略的范畴。

## 2. 调用配置

TypeScript 策略暴露命名的配置，而非原始的 `32768` 字面量。

| 配置             | 主请求值 | 参数拒绝回退 | 说明                                              |
| ---------------- | -------: | -----------: | ------------------------------------------------- |
| Chat             |   32,768 |           无 | 面向用户的开放式文本输出                          |
| Memory           |   32,768 |           无 | 通用配置；结构化子配置可能在遥测后调低            |
| Visual Enhancer  |   32,768 |           无 | 可能输出较长的可视化或页面代码                    |
| Sub-Agent        |   32,768 |       24,576 | 为大型工具参数（尤其是 `file_write`）提供更多余量 |
| Skill audit      |   24,576 |           无 | 结构化审计决策；明确不继承 Sub-Agent 的扩展       |
| Image generation |   32,768 |           无 | 多模态/图像模型的传输配置                         |

### Master Brain

Master Brain 保留了专门的多层策略，因为其服务商推理和最终决策体具有不同的本地安全要求：

| MB 限制      |     值 | 用途                           |
| ------------ | -----: | ------------------------------ |
| 最终决策体   |  8,192 | 本地可见输出上限               |
| 默认传输     | 16,384 | 未知或非推理模型路由           |
| 共享推理传输 | 32,768 | 推理与最终输出共享的服务商预算 |
| 推理硬熔断   | 16,384 | 不可重试的本地异常推理防护     |

服务商参数拒绝可能将 MB 传输从 32K 降至 16K，或从 16K 降至 8K。此回退与语义重试和输出截断恢复相互独立。

## 3. Sub-Agent 解析

对于常规的 Sub-Agent factory：

1. 从 `subAgent` 配置的 32,768 开始。
2. 如果服务商明确拒绝 `max_tokens`、`max_completion_tokens` 或 `max_output_tokens`（认为其无效或超出允许范围），则以 24,576 重试一次相同的消息、工具和会话。
3. 在工厂的剩余生命周期内记住该降级，以便后续 SA 步骤不会反复遭遇相同的 400 响应。
4. 对于无关的 400 响应、认证错误、速率限制、服务器错误、取消操作，或完成原因报告已耗尽的已接受响应，不得降级。

Token 参数分类在视觉回退之前执行。最大 Token 的 400 错误不得导致图像载荷被移除。

## 4. 拒绝非截断

以下条件需要不同的恢复路径：

| 条件                                                                                 | 含义                                 | 恢复方式                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------- |
| HTTP/服务商错误拒绝最大 Token 参数                                                   | 请求的上限不受支持                   | 以配置的兼容性回退值重试一次                       |
| 完成原因为 `length`、`max_tokens`、`MAX_TOKENS`、`max_output_tokens` 或 `incomplete` | 服务商接受了请求但耗尽了可用输出预算 | 不降低预算；拒绝不完整的工具调用并要求 SA 拆分工作 |

服务商耗尽信号必须通过 Rust 的 `ToolChatResponse.finishReason` 传递至 TypeScript。Sub-Agent 运行器不得执行标记为截断的响应中的工具调用，即使 JSON 修复能将部分参数流转换为语法有效的 JSON。

## 5. 长文件写入

提升 SA 请求的 maxtokens 可减少大型 `file_write` 参数的截断，但并不能证明完整性。当工具响应被截断时：

1. 在 Rust 的大参数暂存和 WebView IPC 之前丢弃该响应中的所有工具调用；既不写入目标路径，也不在大参数临时目录遗留内容。
2. 以禁止再次生成长完整模式载荷的尾部指令重试一次。
3. 对于大型新文件，先写入一个简短的完整骨架，然后使用 `file_write` patch 模式填充各部分。
4. 如果第二次响应也被截断，则以明确的失败终止，交由 MB 处理。

WebView 大型参数暂存仅在模型生成和解析之后发生。截断的工具响应会在暂存前被丢弃；对于完整响应，暂存保护的是 IPC 载荷大小，而非服务商输出的完整性。

## 6. 模型能力

推理输出行为是服务商路由作用域的。同一模型 ID 在本地兼容端点上不得自动继承官方路由的推理行为。

Agent 级推理强度使用统一的语义档位契约：`recommended`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。数据库中的 `NULL`、请求中缺失该字段和显式 `recommended` 具有相同语义，必须保持升级前的路由行为；它不等同于无条件省略服务商参数。显式档位由 Rust LLM 路由适配层转换为当前协议的原生字段、别名或思考开关。

可选档位必须由实际的 `provider + model + protocol/route` 能力共同决定。未知、自定义以及未经验证的聚合器兼容路由在内部保持 `recommended`，但 UI 不显示档位后缀或推理二级菜单，并省略未经验证的出站控制。经过验证的聚合器路由只显示与该特定提供商/模型组合相关的控制。后端仍须把不受支持的输入规范化为该路由允许的保守值；不得把前端菜单视为数据可信边界。

当前已验证路由的特殊归一化规则如下：

| 路由/模型                      | UI 档位（不含 `recommended`）                   | 出站规则                                                                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI GPT-5.4 系列、GPT-5.5   | `none`、`low`、`medium`、`high`、`xhigh`        | 不发送已被这些模型拒绝的 `minimal`；旧值防御性下调为 `low`。                                                                                                                                                               |
| OpenAI GPT-5.6 Sol/Terra/Luna  | `none`、`low`、`medium`、`high`、`xhigh`、`max` | `max` 原样传递；Responses 路径使用 `reasoning.effort`，Chat Completions 路径使用 `reasoning_effort`。                                                                                                                      |
| Anthropic Claude 4.6 Sonnet    | `low`、`medium`、`high`、`max`                  | 不发送该模型拒绝的 `xhigh`；旧值防御性下调为 `high`。                                                                                                                                                                      |
| DeepSeek V4                    | `none`、`high`、`max`                           | `none` 仅发送 `thinking.type=disabled` 并省略 `reasoning_effort`；`low/medium` 与 `xhigh` 分别是 `high` 与 `max` 的兼容别名，因此不重复展示。                                                                              |
| MiniMax M3                     | `none`、`high`                                  | `none` 仅发送 `thinking.type=disabled`；`high` 发送 `thinking.type=adaptive`；不发送 Claude 的 `output_config`，M2.x 不继承此开关。                                                                                        |
| ZhipuAI Coding GLM-5.1/5.2     | GLM-5.1：`none`；GLM-5.2：`none`、`high`、`max` | 与普通 Zhipu 路由中的同名模型复用参数映射，但 Coding Plan endpoint 与配额仍保持独立。                                                                                                                                      |
| Volcengine DeepSeek V4/GLM-5.2 | `none`、`high`、`max`                           | 使用火山独立路由；`none` 发送 `thinking.type=disabled`，DeepSeek 省略 `reasoning_effort`，GLM-5.2 同时发送 `reasoning_effort=none`。                                                                                       |
| Volcengine Kimi K2.6/K2.7 Code | K2.6：`none`；K2.7 Code：无                     | K2.6 的 `none` 仅发送 `thinking.type=disabled`；K2.7 Code 始终思考，且火山路由上的 effort 参数尚未验证，因此不发送 `thinking` 或 `reasoning_effort`。                                                                      |
| Volcengine MiniMax M3          | `none`                                          | `none` 仅发送 `thinking.type=disabled`；不推断火山 Coding Plan 未公开的 effort 档位。                                                                                                                                      |
| StepFun Step 3.7 Flash         | `low`、`medium`、`high`                         | OpenAI 兼容路由只发送 `reasoning_effort`。                                                                                                                                                                                 |
| OpenRouter MiniMax M3          | `none`                                          | 使用 OpenRouter 统一 `reasoning` 对象；`none` 发送 `enabled=false`。模型元数据未公开 effort 档位，因此不显示或发送 `high` 等强度值。                                                                                       |
| OpenRouter Step 3.7 Flash      | `low`、`medium`、`high`                         | 模型推理为强制开启；通过统一 `reasoning.effort` 发送三档强度，不开放 `none`，后端将防御性的关闭或越界输入收敛到有效档位。                                                                                                  |
| OpenRouter Xiaomi MiMo-V2.5    | `none`                                          | 发送包含 `exclude=false` 参数的统一嵌套结构 `reasoning` 对象；对 `reasoning`、`reasoning_content` 以及用于显示的 `reasoning_details` 进行规范化处理，同时在不同工具的使用过程中保持原始的 `reasoning_details` 不发生改变。 |

推理档位与输出 Token 预算是两个独立维度。选择 `xhigh` 或 `max` 不会自动提高场景传输上限、Master Brain 最终正文上限或推理硬熔断；更高档位仍受本文件所列预算与截断策略约束。

模型注册表负责稳定的模型事实，如上下文大小和显式路由能力。调用配置偏好保留在 LLM Token 策略中。输出上限绝不可从 `contextWindow` 推断；经过验证的模型输出能力和当前调用配置是独立的输入。

未知/自定义路由使用场景配置和运行时参数拒绝回退，而非未经验证的服务商全局限制。

## 7. 可观测性与测试

日志和测试应捕获低基数元数据，不包含提示词或凭证内容：

- 配置、服务商、模型、请求的最大 Token 数和实际最大 Token 数；
- 是否使用了参数回退；
- 服务商提供时的输入/输出使用量；
- 完成原因及是否丢弃了被截断的工具调用。
- 请求的语义推理档位，以及路由适配后实际发送的低基数推理控制；不得记录提示词、推理正文或凭证。

所需的回归测试覆盖包括：

- SA 32K 成功以及 32K 到 24K 的参数拒绝（涵盖抛出异常和响应包装错误）；
- 对无关的 400、429、5xx、取消操作或第二次 24K 拒绝不回退；
- Token 回退在视觉回退之前，保留图像；
- OpenAI、Anthropic 和 Gemini 工具路径的服务商完成原因传递；
- 被截断的工具响应零文件写入；
- 共享推理注册表路由解析为实际的内置服务商/模型对。
- 缺失/`recommended` 保持旧行为，显式档位在普通、流式和工具调用中得到一致映射，未知路由不泄漏推理参数。
- Volcengine 普通与工具请求按模型发送 `thinking` 或 `reasoning_effort`；Kimi K2.6 与 MiniMax M3 只发送已验证的关闭开关，K2.7 Code 保持请求体不变。
- OpenRouter 按模型元数据区分可关闭推理的 MiniMax M3 与强制推理的 Step 3.7 Flash，并在普通与工具请求中统一发送 `reasoning` 对象。
- OpenRouter 支持明文别名以及结构化的推理模块；这些功能在实现时不会导致用户界面（UI）出现重复或混乱的情况。同时，工具的后续操作会保留所有的 `reasoning_details` 数据以及各个组件的排列顺序（即提供者的顺序）。

## 8. StatusBar Current Context

StatusBar 的 Token 指标是上下文容量提示，不是服务商账单或成本统计。Session Usage 在统一调用账本完成前不对用户展示；实际用量和费用以服务商控制台为准。

Current Context 仅跟踪当前可见 Agent/Hub Task 明确归属的前台 LLM 调用：Chat、Master Brain、Checkpoint 和 Sub-Agent。后台 Memory、Visual Enhancer、Skill Audit、Embedding、Rerank 以及媒体生成调用不得覆盖当前窗口的上下文状态。

显示生命周期如下：

- 在调用开始后显示`Current Context`。根据最后的请求消息（包括历史工具调用记录、推理内容及结构化的推理细节）、协议字段、工具规范以及图像数量等信息来估算输入数据。
- 流式生成期间，输出包含可见正文、可获得的推理内容和大型工具参数进度，并以节流后的频率更新；完成后也计入工具调用参数。
- 调用完成而 Task 仍在执行工具或调度下一步时显示 `Last Context`。
- Task 结束、取消后进入空闲状态时隐藏；旧调用必须通过 `callId` 保护，不能覆盖或清除较新的调用。

主显示口径为 `input + output / contextWindow`。服务商返回基础 usage 时可在完成阶段修正估算；缺失时继续使用应用统一估算。图片不得按 base64 字符长度换算，使用与供应商无关的固定媒体回退值。`contextWindow` 必须按实际 `providerId + modelId` 路由解析，不能借用其他供应商的同名模型配置。
