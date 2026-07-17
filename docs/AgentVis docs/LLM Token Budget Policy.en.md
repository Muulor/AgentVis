# LLM Token Budget Policy

This document defines how AgentVis chooses LLM generation budgets, distinguishes provider
transport limits from local safety guards, and handles both rejected token parameters and
accepted-but-truncated responses.

## 1. Terms And Ownership

The word "token" appears in several unrelated limits. They must not share one global constant.

| Limit                         | Meaning                                                                                                                            | Owner                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Provider transport output     | Maximum output requested from an LLM API. For reasoning models this may include reasoning and visible output in one shared budget. | `services/llm/LlmTokenPolicy.ts` and MB planning constants  |
| Visible output guard          | Local cap applied to a parsed or streamed response body.                                                                           | Scenario implementation, such as Master Brain               |
| Reasoning fuse                | Local estimated-token/time guard for anomalous reasoning streams.                                                                  | Master Brain reasoning guard                                |
| Context window / input budget | Maximum prompt plus history capacity and input truncation thresholds.                                                              | Model registry, ContextWindowManager, attachment processors |
| Loop budget                   | Cumulative execution budget across multiple calls.                                                                                 | LoopGovernor / SubAgentRunner                               |
| External Skill `maxOutput`    | Process stdout/stderr byte limit.                                                                                                  | External Skill execution contract                           |

`contextWindow`, local `nCtx`, attachment `maxTokens`, LoopGovernor budgets, and External Skill
`maxOutput` are therefore outside the provider output policy.

## 2. Call Profiles

The TypeScript policy exposes named profiles instead of raw `32768` literals.

| Profile          | Primary request | Parameter-rejection fallback | Notes                                                                          |
| ---------------- | --------------: | ---------------------------: | ------------------------------------------------------------------------------ |
| Chat             |          32,768 |                         none | Open-ended user-facing text output                                             |
| Memory           |          32,768 |                         none | General profile; structured subprofiles may be reduced after telemetry         |
| Visual Enhancer  |          32,768 |                         none | May emit long visualization or page code                                       |
| Sub-Agent        |          32,768 |                       24,576 | Gives large tool arguments, especially `file_write`, more headroom             |
| Skill audit      |          24,576 |                         none | Structured audit decision; explicitly does not inherit the Sub-Agent expansion |
| Image generation |          32,768 |                         none | Multimodal/image-model transport profile                                       |

### Master Brain

Master Brain keeps a specialized multi-layer policy because its provider reasoning and final
decision body have different local safety requirements:

| MB limit                   |  Value | Purpose                                              |
| -------------------------- | -----: | ---------------------------------------------------- |
| Final decision body        |  8,192 | Local visible-output cap                             |
| Default transport          | 16,384 | Unknown or non-reasoning model routes                |
| Shared-reasoning transport | 32,768 | Provider budget shared by reasoning and final output |
| Reasoning hard fuse        | 16,384 | Non-retryable local anomalous-reasoning guard        |

Provider parameter rejection may reduce MB transport from 32K to 16K or from 16K to 8K. This
fallback is separate from semantic retries and from output-truncation recovery.

## 3. Sub-Agent Resolution

For a normal Sub-Agent factory:

1. Start with the `subAgent` profile at 32,768.
2. If the provider explicitly rejects `max_tokens`, `max_completion_tokens`, or
   `max_output_tokens` as invalid or above its allowed range, retry the same messages, tools, and
   session once at 24,576.
3. Remember that downgrade for the remaining lifetime of the factory so later SA steps do not
   repeatedly incur the same 400 response.
4. Do not downgrade for unrelated 400 responses, authentication errors, rate limits, server
   errors, cancellation, or accepted responses whose finish reason reports exhaustion.

Token-parameter classification runs before vision fallback. A max-token 400 must not cause image
payloads to be removed.

## 4. Rejection Is Not Truncation

These conditions require different recovery paths:

| Condition                                                                                   | Meaning                                                                     | Recovery                                                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| HTTP/provider error rejects the max-token parameter                                         | The requested ceiling is unsupported                                        | Retry once with the configured compatibility fallback                                  |
| Finish reason is `length`, `max_tokens`, `MAX_TOKENS`, `max_output_tokens`, or `incomplete` | The provider accepted the request but exhausted the available output budget | Do not lower the budget; reject incomplete tool calls and ask the SA to split the work |

A provider exhaustion signal must be propagated through Rust `ToolChatResponse.finishReason` to
TypeScript. The Sub-Agent runner must not execute tool calls from a response marked as truncated,
even if JSON repair can turn the partial argument stream into syntactically valid JSON.

## 5. Long File Writes

Increasing the SA request maxtokens reduces truncation for large `file_write` arguments but
does not prove completeness. When a tool response is truncated:

1. Discard every tool call in Rust before large-argument staging and WebView IPC; write nothing to
   either the target path or the temporary large-argument directory.
2. Retry once with a tail instruction that forbids another long full-mode payload.
3. For a large new file, write a short complete skeleton first and then fill sections with
   `file_write` patch mode.
4. If the second response is also truncated, terminate with an explicit failure for MB handoff.

WebView large-argument staging happens only after model generation and parsing. Truncated tool
responses are discarded before this staging step; staging protects IPC payload size for complete
responses, not provider output completeness.

## 6. Model Capabilities

Reasoning-output behavior is provider-route scoped. The same model ID on a local compatible
endpoint must not automatically inherit the official route's reasoning behavior.

Agent-level reasoning intensity uses one semantic preset contract: `recommended`, `none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A database `NULL`, an omitted request
field, and explicit `recommended` have the same meaning and must preserve the route's pre-upgrade
behavior; this does not always mean omitting the provider field. The Rust LLM route adapter maps an
explicit preset to the current protocol's native field, alias, or thinking switch.

Available presets must be resolved from the actual `provider + model + protocol/route` capability.
Unknown, custom, and unverified aggregator-compatible routes expose only `recommended` and omit
unverified outbound reasoning controls. Verified aggregator routes may expose only the controls
reported for that provider/model pair. The backend must also normalize unsupported input to a
verified, conservative value for that route rather than treating the frontend menu as a trust
boundary.

Verified routes currently use these special normalization rules:

| Route/model                       | UI presets (excluding `recommended`)            | Outbound rule                                                                                                                                                                                                             |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI GPT-5.4 family and GPT-5.5 | `none`, `low`, `medium`, `high`, `xhigh`        | Do not send `minimal`, which these models reject; defensively clamp a stale value to `low`.                                                                                                                               |
| OpenAI GPT-5.6 Sol/Terra/Luna     | `none`, `low`, `medium`, `high`, `xhigh`, `max` | Pass `max` through unchanged; use `reasoning.effort` on Responses paths and `reasoning_effort` on Chat Completions paths.                                                                                                 |
| Anthropic Claude 4.6 Sonnet       | `low`, `medium`, `high`, `max`                  | Do not send `xhigh`, which this model rejects; defensively clamp a stale value to `high`.                                                                                                                                 |
| DeepSeek V4                       | `none`, `high`, `max`                           | For `none`, send only `thinking.type=disabled` and omit `reasoning_effort`; `low/medium` alias `high`, while `xhigh` aliases `max`, so duplicate levels are hidden.                                                       |
| MiniMax M3                        | `none`, `high`                                  | For `none`, send only `thinking.type=disabled`; for `high`, send `thinking.type=adaptive`; do not send Claude `output_config`, and do not inherit the switch to M2.x.                                                     |
| ZhipuAI Coding GLM-5.1/5.2        | GLM-5.1: `none`; GLM-5.2: `none`, `high`, `max` | Reuse the parameter mapping for the matching model on the regular Zhipu route while keeping the Coding Plan endpoint and quota isolated.                                                                                  |
| StepFun Step 3.7 Flash            | `low`, `medium`, `high`                         | Send only `reasoning_effort` on the OpenAI-compatible route.                                                                                                                                                              |
| OpenRouter Xiaomi MiMo-V2.5       | `none`                                          | Send the unified nested `reasoning` object with `exclude=false`; normalize `reasoning`, `reasoning_content`, and visible `reasoning_details` for display, and return raw `reasoning_details` unchanged across tool turns. |

Reasoning presets and output-token budgets are independent dimensions. Selecting `xhigh` or `max`
does not raise a scenario transport ceiling, the Master Brain final-body limit, or the reasoning
hard fuse. Higher presets remain subject to the budgets and truncation policy in this document.

The model registry owns stable model facts such as context size and explicit route capabilities.
Call-profile preferences remain in the LLM token policy. An output ceiling must never be inferred
from `contextWindow`; a verified model output capability and the current call profile are separate
inputs.

Unknown/custom routes use the scenario profile and runtime parameter-rejection fallback rather
than an unverified provider-wide clamp.

## 7. Observability And Tests

Logs and tests should capture low-cardinality metadata without prompt or credential content:

- profile, provider, model, requested max tokens, and effective max tokens;
- whether a parameter fallback was used;
- input/output usage when supplied by the provider;
- finish reason and whether a truncated tool call was discarded.
- requested semantic reasoning preset and the low-cardinality reasoning control actually sent after
  route adaptation; never log prompts, reasoning bodies, or credentials.

Required regression coverage includes:

- SA 32K success and 32K to 24K parameter rejection for thrown and response-wrapped errors;
- no fallback for unrelated 400, 429, 5xx, cancellation, or a second 24K rejection;
- token fallback before vision fallback, preserving images;
- provider finish-reason propagation for OpenAI, Anthropic, and Gemini tool paths;
- zero file writes from truncated tool responses;
- shared-reasoning registry routes resolving to real built-in provider/model pairs.
- omitted/`recommended` preserving legacy behavior, explicit presets mapping consistently across
  plain, streaming, and tool calls, and unknown routes not leaking reasoning parameters.
- OpenRouter plaintext aliases and structured reasoning blocks normalizing without duplicate UI
  text, while tool continuations preserve every `reasoning_details` value and the provider order.

## 8. StatusBar Current Context

The StatusBar token indicator is a context-capacity aid, not a provider bill or cost report. Session Usage remains hidden until a unified per-attempt ledger exists; provider dashboards remain authoritative for actual usage and cost.

Current Context only tracks explicitly attributed foreground LLM calls for the visible Agent/Hub task: Chat, Master Brain, Checkpoint, and Sub-Agent. Background Memory, Visual Enhancer, Skill Audit, Embedding, Rerank, and media-generation calls must not replace the visible window's context state.

Its lifecycle is:

- Show `Current Context` after a call begins. Estimate input from the final request messages (including historical tool calls, reasoning content, and structured reasoning details), protocol fields, tool schemas, and image count.
- During streaming generation, include visible response text, available reasoning content, and large tool-argument progress at a throttled rate; include tool-call arguments on completion as well.
- Show `Last Context` after the LLM call completes while the task is still executing tools or scheduling its next step.
- Hide the metric when the task finishes, is cancelled, or otherwise becomes idle. A stale call must not overwrite or clear a newer call; updates are guarded by `callId`.

The primary display is `input + output / contextWindow`. Provider-reported base usage may correct the estimate when a call completes; otherwise the application-wide fallback remains in use. Image payloads must never be estimated from base64 character length and instead use a provider-neutral fixed media fallback. `contextWindow` must resolve from the actual `providerId + modelId` route and must not borrow a same-named model configuration from another provider.
