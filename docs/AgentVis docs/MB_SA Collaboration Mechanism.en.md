# Master Brain and Sub-Agent Collaboration Mechanism

> **Document positioning**: A release-oriented introduction to a core feature, intended for technical readers.  
> **Scope**: MB/SA collaborative execution framework, task scheduling, context persistence, and user intervention.

---

## 1. Overall Architecture

AgentVis's planning-execution system is driven by two collaborating roles:

| Role | Responsibility |
|------|------|
| **Master Brain (MB)** | Strategic decision layer. It understands the global context and decides what should happen next and who should do it. |
| **Sub-Agent (SA)** | Tactical execution layer. It autonomously uses tools within strict boundaries to complete a single assigned task. |

Both roles are orchestrated by a unified **FSM (finite state machine)**, forming a complete perceive-decide-act loop:

```text
USER REQUEST
      |
      v
AGENT SERVICE (FSM Owner)
  +-- IDLE -> PREPARE_CONTEXT -> MASTER_DECISION -> DISPATCH -> OBSERVE -> EVALUATE -> ...
  |
  +---- MASTER BRAIN         <- strategic decision-making (LLM-driven, JSON output)
  +---- SUB-AGENT POOL       <- execution units (ReAct atomic loops)
  +---- TASK ARTIFACT STORE  <- cross-SA result persistence (memory, 30K tokens)
  +---- LOOP GOVERNOR        <- budget management, risk assessment, progress tracking
```

---

## 2. FSM-Driven Execution Framework

### 2.1 State Machine Nodes

Each user request triggers one complete FSM run cycle that passes through the following states:

| State | Function |
|------|------|
| `IDLE` | Waits for user input. |
| `PREPARE_CONTEXT` | Assembles context, including conversation history, memory, WORKDIR snapshot, Task Artifacts, and related data. |
| `MASTER_DECISION` | Calls the MB LLM and obtains a structured decision. |
| `DISPATCH` | Creates and dispatches an SA according to the MB decision. User reply / follow-up decisions are handled directly in the current round. |
| `OBSERVE` | Collects SA execution results. |
| `EVALUATE` | Lets LoopGovernor evaluate budget / risk and decide whether to continue or terminate. |
| `TERMINATE` | Returns the final result to the user. |

### 2.2 Three-Layer Budget Architecture

The system controls execution budgets independently at three granularities to prevent runaway execution:

| Layer | Default | Responsibility |
|------|--------|------|
| **MB decision budget** | 8 rounds | Maximum number of decide -> dispatch -> observe loops that MB may perform. |
| **SA execution budget** | 50 steps / SA | Maximum number of steps for one SA. Parallel tool calls count as only 1 step. |
| **FSM safety valve** | 48 state transitions | Hard termination limit for FSM stepping, used as defense-in-depth. |

> One SA "step" means one complete LLM decision round, namely one LLM response, no matter how many parallel tool calls it contains.

### 2.3 LoopGovernor Termination Conditions

`LoopGovernor` evaluates whether to terminate the whole loop by priority, regardless of MB's intent:

1. Two consecutive rounds with no progress (`consecutive_no_progress`)
2. Calling the same tool consecutively beyond the threshold (`tool_thrashing_detected`)
3. SA creation count exceeds the limit (`over_delegation`)
4. Accumulated risk exceeds the threshold (`risk_exceeded`)
5. MB decision budget is exhausted (`budget_exhausted`)

> `risk_exceeded` is a reserved evaluation branch in LoopGovernor. In the current main execution path, the incoming `riskDelta` is 0. In practice, loop closure is mainly triggered by no progress, tool thrashing, delegation count, and budget exhaustion.

---

## 3. Master Brain Decision System

### 3.1 Decision Types

Each MB call outputs exactly one of three decision types:

| Decision | Description |
|------|------|
| `SPAWN_SUB_AGENT` | Dispatches a Sub-Agent to execute a specific task. |
| `REQUEST_MORE_INPUT` | Requests additional information from the user because task information is insufficient or task boundaries are unclear. |
| `RESPOND_TO_USER` | Responds directly to the user because the task is complete or no SA is needed. |

### 3.2 MB's Information Scope

Before each decision, MB receives a context bundle assembled by `MasterBrainInputBuilder.build()`:

| Information block | Content |
|---------|------|
| Conversation history | The latest 10 user / assistant turns. Earlier content is supplemented through memory summary, RAG, and task experience. |
| WORKDIR snapshot | File statistics for the current working directory, including total count, extension distribution, and recently modified Top 5 files, around 200 tokens. |
| Task Artifact index | Summaries of prior SA execution results, including tool name and source parameters. |
| MB decision history | Prior MB rationales and dispatched tasks, preserving strategic continuity. `[MB_DECISION_HISTORY]` is preferred. |
| SA observation summary | Observations, status, and tool-call summaries from completed SAs. |
| Tool catalog | Currently available tools, built-in skills, and installed Guide / Script skill catalogs. |
| Task experience | Trial-and-error experience accumulated during historical execution, provided by the memory system. |
| External skill content | Guide skills hit by semantic retrieval and Script skills matched on demand. |

#### 3.2.1 MB Output And Reasoning Budgets

MB uses separate local guards around one provider transport budget. The final structured decision
body is locally capped at 8,192 tokens. Unknown and non-reasoning routes request 16,384 transport
tokens, while provider/model routes whose reasoning shares the output budget request 32,768.
An independent 16,384-token reasoning fuse stops anomalous reasoning streams.

If a provider explicitly rejects the requested max-token parameter, MB retries once at the next
lower transport tier (32K to 16K, or 16K to 8K). This is not used for an accepted response that
finishes with `length` or `max_tokens`; provider exhaustion follows semantic truncation recovery.

### 3.3 MB Decision Output Contract

MB output uses a unified wire protocol consisting of root decision metadata plus a decision-specific `nextStep` payload:

| Decision | Required payload |
|------|------|
| `SPAWN_SUB_AGENT` | `nextStep.task` |
| `REQUEST_MORE_INPUT` | `nextStep.questionsForUser` |
| `RESPOND_TO_USER` | `nextStep.response` |

For example, a direct user response must use:

```json
{
  "decision": "RESPOND_TO_USER",
  "rationale": "The task is complete",
  "riskAssessment": { "level": "low", "notes": "No additional risk" },
  "nextStep": { "response": "The final user-facing response" }
}
```

At the protocol boundary, `DecisionParser` continues to accept legacy root-level `response` / `questionsForUser` fields and then normalizes them into the existing internal discriminated union so the wire migration does not spread through the FSM. Legacy fallback applies only when the canonical key is absent; an explicitly present canonical key that is empty or type-invalid is classified as `schema_invalid`. If legacy and `nextStep` locations are both present with conflicting content, the system does not guess: it classifies the decision as `schema_invalid` and consumes the shared one-attempt MB semantic correction budget. Decisions obtained through truncated or aggressive repair are still never executed directly.

### 3.4 SPAWN_SUB_AGENT Decision Content

When MB decides to dispatch an SA, the emitted `nextStep` structure is JIT-built by `SubAgentSpecBuilder` into a complete `SubAgentSpec`:

```typescript
interface SubAgentSpec {
  behaviorHint?: 'careful' | 'direct';  // Behavior style modifier
  role: string;                          // Task role description
  contextSummary?: string;              // Context summary
  allowedTools: string[];               // Final whitelist of available tools
  terminationCondition?: string;        // Termination condition, optional
  includeHistory?: boolean;             // Whether to inject conversation history
  loopConfig?: SubAgentLoopConfig;      // Atomic loop configuration, inferred automatically
}
```

**Tool authorization** follows the model "base tools are injected automatically + MB extends authorization on demand." The system automatically adds base tools such as `read`, `local_search`, `web_search`, `exec`, and `file_write` for the SA. MB is responsible for adding special / extension tools according to task needs. At runtime, `SubAgentRunner` still intercepts unauthorized tool calls through the `allowedTools` whitelist.

---

## 4. Sub-Agent Execution Mechanism

### 4.1 ReAct Atomic Event Loop

All SAs execute in the **ReAct (Reasoning and Acting)** pattern. Loop control belongs entirely to `SubAgentRunner`:

```text
while (!terminated && toolCallSteps < maxSteps) {

  Step A: Call LLM (callWithContext)
    +-- tool_use response -> Step B
    +-- text response     -> detect termination signal (TASK_COMPLETE)
                              +-- terminated = true

  Step B: Execute tools (toolExecutor)

  Step C: Push results into the stack (messages.push)
            +-- storeToolResultAsArtifact()
                Successful and failed results can both be automatically stored in ArtifactStore

  [Checkpoint triggers]
    +-- before high-risk operations
    +-- when budget is close to exhaustion
    +-- after consecutive failures
    +-- periodic check mechanism is retained, but disabled by default
}
```

#### 4.1.1 SA Output Budget And Truncated Tool Calls

Normal SA calls request 32,768 output tokens so large function-call arguments have more room. If a
provider explicitly rejects that token parameter, the caller retries the same request once at the
24,576 compatibility baseline and remembers the downgrade for later steps in the same factory.
Skill-audit calls keep their separate 24,576 profile.

A provider rejection is different from an accepted response whose finish reason is `length`,
`max_tokens`, `MAX_TOKENS`, or `incomplete`. The latter is marked as truncated: the backend discards
all tool calls before large-argument staging, and Runner writes nothing. It retries with a strategy
instruction that asks the SA to create a short complete skeleton and then fill long files with patch
mode. A repeated truncation terminates as a failure for MB handoff.

### 4.2 behaviorHint Behavior Modifier

| Value | Meaning | Suitable scenarios |
|----|------|---------|
| `'careful'` | Careful mode, verifies each step. | Complex analysis and risky operations. |
| `'direct'` | Direct mode, executes efficiently. | Clear file operations and simple tasks. |
| Not set | General template. | Most routine tasks. |

### 4.3 Tool Risk Guard

When an SA executes tools, `ToolRiskGuard` handles them by risk level in a non-blocking way. `SubAgentRunner` also applies additional safety policies to some tools:

| Risk level | Tools | Handling |
|---------|------|---------|
| `high` | `exec`, `external_skill_execute` | May trigger a Checkpoint. Safe `exec` commands can skip pre-execution approval, while dangerous commands are blocked directly. |
| `medium` | `file_write`, `cron`, and unregistered tools | Logged. `file_write` mainly goes through the authorization and diff / write pipeline. |
| `low` | `read`, `web_search`, `generate_image`, `local_search`, `im_send`, `feishu`, `slack` | No extra handling. |

---

## 5. Checkpoint - Real-Time MB Supervision of SA

An SA triggers Checkpoints at key moments, pauses execution, and reports its current state to MB for evaluation. Active triggers enabled by default include before high-risk operations, when budget is close to exhaustion, and after consecutive failures. The periodic Checkpoint mechanism is still retained, but its default interval is set to `maxSteps + 1`, which is equivalent to not actively triggering periodic checks by default.

### 5.1 Checkpoint Decisions

After evaluation, MB returns one of three decisions:

| Decision | Effect |
|------|------|
| `EXTEND_BUDGET` | Adds iterations and continues execution. |
| `ADJUST_STRATEGY` | Injects new instructions plus a progress summary to change the execution direction. |
| `TERMINATE_SUB_AGENT` | Stops immediately and returns the collected results. |

### 5.2 Scope Violation and Intent Drift Detection

During Checkpoint evaluation, MB also performs:

- **Scope violation detection**: the SA operated on resources outside the delegated scope -> `TERMINATE_SUB_AGENT` (`scope_violation`).
- **Intent drift detection**: the SA's next tool call is unrelated to the task goal -> `ADJUST_STRATEGY` or `TERMINATE_SUB_AGENT`.

---

## 6. SA Context Management (Three Progressive Levels)

Inside an SA, the complete `messages[]` message stack is maintained as the Single Source of Truth. As execution steps increase, context pressure triggers tiered management:

| Level | Trigger | Action |
|------|---------|------|
| **L1 gradient compression** | A single tool output exceeds the threshold, or total context exceeds 85% and enters pressure mode. | Tool outputs are compressed by the 8K / 12K tiers. In pressure mode, old tool messages are compressed more aggressively to protect recent key content. |
| **L2 context reset** | Tokens > 45% of the total window and remaining steps >= 3. | SA outputs a structured summary -> clears history -> injects the summary and continues. |
| **L3 budget warning** | Step usage ratio > 85% / 95%. | Injects closing guidance / final warning. |

### L2 Context Reset Flow

```text
Step N:   Tokens > 45% -> Runner injects CONTEXT_RESET_INSTRUCTION
Step N+1: SA outputs ---CONTEXT_SUMMARY--- structured summary
            -> Runner intercepts the summary
            -> Clears messages[] while keeping the system prompt
            -> Injects the summary as a new user message
Step N+2: SA continues the unfinished task from the summary
```

L2 supports an **unlimited number** of resets. Step counting is not reset, and the total budget control always remains effective.

---

## 7. Task Artifact - Cross-SA Result Persistence

### 7.1 Problem Source

After an SA execution fails, MB may dispatch a new SA. The new SA cannot access intermediate results from the prior SA, such as search results or file content, causing duplicated work.

### 7.2 Automatic Collection Strategy

After an SA executes a tool, `SubAgentRunner.storeToolResultAsArtifact()` automatically extracts content by tool type and writes it into `TaskArtifactStore`. Both successful and failed results may be retained, with **no explicit LLM instruction required**:

| Tool | Maximum retained content |
|------|---------|
| `web_search` | 3000 characters |
| `read` / `file_read` | 1500 characters |
| `exec` | 500 characters |
| `file_write` | 200 characters |

The store uses FIFO eviction, with a total budget cap of 30K tokens.

### 7.3 Two-Layer Injection

Collected Artifacts are injected into subsequent decision chains through two channels:

| Injection target | Data | Purpose |
|---------|------|------|
| **MB Prompt** | Lightweight index, including tool name and source parameters. | Guides MB to tell a newly dispatched SA to reuse existing results. |
| **SA Prompt** | Full Artifact content in the prior task results section. | Lets the new SA directly read prior search results or file content without repeating execution. |

### 7.4 Lifecycle

- **Creation**: initialized when `AgentLoopFSMIntegration` is constructed.
- **Write**: automatically written after tool-call results return. Successful and failed results can both be retained.
- **Clear**: reset every time the user sends a new message. One complete conversation turn corresponds to one lifecycle.

---

## 8. HITL - User Intervention Between Steps

### 8.1 Mechanism Overview

During SA execution, the user can click "Pause" at any time. After the SA finishes its current step, it pauses; the user can then enter adjustment instructions and resume execution. The whole process does not require terminating the task.

```text
UI (HitlInterventionBar)
    | pause(contextId)
    v
hitlStore (Zustand)
    | pausedContexts.add(contextId)
    |
SubAgentRunner (between-step checkpoint)
    | while (!terminated) {
    |     checkAbortSignal()     <- termination has priority
    |     isPaused()             <- HITL checkpoint
    |     waitForResume()        <- blocks and waits for user instruction
    |     callLLM()
    |     executeTools()
    | }
    |
    | User enters intervention message -> resume(contextId, message)
    v
    +-- Inject into additionalInstructions  <- visible to the current SA's next LLM call
    +-- Write into messages[]               <- retained as a persistent user message in the current SA context
    +-- Write into TaskArtifactStore         <- cross-SA persistence, type user_intervention
    +-- emitObservation                      <- UI timeline displays the user intervention event
```

### 8.2 Intervention Persistence

User intervention messages are written into `TaskArtifactStore`, ensuring that MB and all subsequent SAs can perceive the intervention:

- The MB Prompt renders an intervention warning block, reminding MB to include the user's adjustment instruction in the task description for subsequent SAs.
- In the SA observation timeline, the intervention message appears precisely after the corresponding step instead of floating at the top.
- Every later LLM call of the current SA appends the persisted user intervention instruction after the Safety Footer, guaranteeing its priority.

### 8.3 Race Condition Handling

The user may click resume during an LLM call before `waitForResume` has been called, creating a race condition. The system handles this through the `preResolvedMap` mechanism:

| Scenario | Handling |
|------|------|
| Normal: `waitForResume` starts waiting first, then the user resumes. | `resume()` finds the resolver and calls it directly. |
| Race: the user resumes before `waitForResume` is called. | The message is temporarily stored in `preResolvedMap` and consumed immediately when `waitForResume` starts. |

---

## 9. Cross-Request Context Persistence

### 9.1 Background

Task execution may be interrupted by network disconnection, API errors, or the user stopping the task. If MB's decision process (`rationale`) and SA execution progress (`observations`) are lost, the next user message, such as "please continue," will make MB plan again from scratch and waste completed work.

### 9.2 Injected Content

When a task ends, the system injects the following content into the persisted version of the assistant message on close-out paths that need cross-request recovery. Normal final replies that already have user-visible content usually do not add this extra injection. Cancellation, exception fallback, and empty-result fallback paths rely on this mechanism to retain internal progress:

```text
MB decision progress (system-injected context for the next decision):
{Full MB rationale}

MB previous dispatched task (system-injected):
{Description of the last dispatched task}

Latest SA execution progress (system-injected):
{Latest 1200 characters of SA observations}
```

### 9.3 Three-Layer Persistence Defense

| Layer | Location | Responsibility |
|------|------|------|
| **Data layer** | `metadata.persistContent` | Stores the full content, including rationale, in both chatStore and DB so the next turn's historyMessages can read it. |
| **Result layer** | `buildResult.content` | The version returned to the UI has rationale stripped and is not visible to the user. |
| **Rendering layer** | `MessageBubble.tsx` | Strips rationale again when loading historical messages from DB, serving as the final defense. |

### 9.4 Resolving the Data Fork Problem

In the original architecture, chatStore, used by the UI, and DB, used for persistence, stored different content. chatStore stored the UI-stripped version, while DB stored the full version. The next request built historyMessages from chatStore, causing rationale to be lost.

**Solution**: redundantly store `persistContent` inside `messageMetadata`. When building `historyMessages`, read `metadata.persistContent` first to bypass the data fork:

```text
chatStore.content                 = finalContent   (for UI display, rationale stripped)
chatStore.metadata.persistContent = full version   (for context recovery)
historyMessages building          -> prefer metadata.persistContent
```

### 9.5 Handling Cancellation

When the user clicks the stop button, the system executes the complete persistence pipeline instead of discarding progress:

```text
User clicks stop -> cancel() -> unified close-out point injects rationale
  -> buildResult('cancelled') returns success=true
  -> usePlanningMode follows the normal assistant message path
  -> metadata.persistContent includes rationale
  -> next-round MB recovers context
```

---

## 10. MB Strategic Continuity

### 10.1 Semantic Fence for SA Reports

When MB dispatches multiple SAs serially, each completed SA report is first stored in the session as a `role: tool` message. When assembled for the MB LLM, it is converted into `role: user` because of LLM protocol constraints. To prevent MB from mistaking an SA report for a new user message, the system automatically wraps it in a semantic fence:

```text
[SYSTEM: The following is an execution completion report from Sub-Agent (tool name). It is not a user message]
...report content...
[END_SA_REPORT]
```

### 10.2 [MB_DECISION_HISTORY] Strategic Continuity Injection

After each `SPAWN_SUB_AGENT` decision, MB's `rationale` and `task` are saved into `SharedState`. On the next MB call, they are injected into the System Prompt:

```text
[CONVERSATION_HISTORY]
  ...user conversation history...

[MB_DECISION_HISTORY]   <- decision context from the previous n MB rounds
  ...
  Round n decision rationale: ...
  Round n task dispatched to SA: ...
  ...

[TASK_ARTIFACTS]
  ...SA execution result index...
```

`[MB_DECISION_HISTORY]` is not included in token-budget truncation, ensuring that MB can maintain strategic consistency even when the budget is tight.

---

## 11. Task Experience Memory

After an SA completes a complex task, if its report contains the `## EXECUTION_EXPERIENCE` marker, the system automatically extracts the content and writes it into long-term memory under the SQLite `task_experience` category:

- Suitable to record: environment configuration pitfalls, path compatibility issues, and more efficient execution approaches that were discovered.
- Not recorded: scenarios where everything went smoothly.

Experience is automatically injected into MB and SA Prompts on the next user request, helping avoid repeating prior mistakes.

---

## 12. Prompt Construction Pipeline Overview

```text
SubAgent System Prompt assembly order (SubAgentPromptBuilder)
  1. BASE_TEMPLATE          <- role / forbidden behavior / output format
  2. getBehaviorTemplate()  <- behaviorHint modifier
  3. LOOP_EXECUTION_GUIDANCE<- loop execution guidance, only for loopConfig
  4. agentRules             <- user-defined rules, conditional
  5. Current time           <- time awareness
  6. buildSandboxRuntimeSection() <- sandbox / runtime description, conditional
  7. buildInputProtocol()
     +-- Background context      <- contextSummary, conditional
     +-- User conversation history <- conversationHistory, conditional
     +-- HITL override           <- user intervention instruction, conditional
     +-- Prior SA reports        <- previousSubAgentReports, conditional
     +-- Prior task results      <- Task Artifact snapshot, conditional
     +-- Termination condition   <- terminationCondition, conditional
  8. buildTaskExperienceSection() <- historical experience injection, conditional
  9. buildToolSection()     <- available tools / SKILL.md content injection
 10. buildExternalGuideSection() <- Guide skill injection
 11. buildExternalScriptSkillSection() <- Script skill injection, conditional
 12. buildVenvConstraintSection() <- Python environment constraints
 13. buildPlatformInfoSection() <- Windows command constraints, conditional
 14. TOOL_CALL_SELF_CHECK   <- CoT self-check, only in Loop mode, appended at the end

Extra content appended on each LLM call:
  [user tail] SAFETY_FOOTER_TEXT <- always at the end of context, resisting attention dilution
```

**Design intent of SAFETY_FOOTER**: on every LLM call, safety constraints are appended to the tail of the user message. This ensures that no matter how many steps the SA executes, the constraints always stay in the attention hot zone of the last few hundred context tokens, avoiding the "Lost in the Middle" problem.

---

## Summary: Full Information Flow

```text
User message
    |
    v
[PREPARE_CONTEXT]
  Recent conversation + memory/RAG + WORKDIR snapshot + Artifact index
  + MB decision history + task experience + Guide/Script skills
    |
    v
[MASTER_DECISION] (MB LLM)
    |
    +-- SPAWN_SUB_AGENT
    |     | base tool auto-injection + MB extension authorization + behavior modifier + task description
    |     v
    |  [DISPATCH] -> SubAgentFactory -> SubAgentRunner
    |     |         Complete System Prompt, including Artifact snapshot + SKILL.md
    |     |
    |     |  ReAct atomic loop (LLM -> tool -> result stack -> Artifact write)
    |     |  +-- Checkpoint -> MB evaluation, including scope / drift detection
    |     |  +-- L1/L2/L3 context management, including compression / reset / budget warning
    |     |  +-- HITL between-step checkpoint, allowing user intervention at any time
    |     |
    |     v
    |  SubAgentOutput (observations + toolCalls + status)
    |     |
    |  [OBSERVE] -> [EVALUATE] (LoopGovernor budget / risk evaluation)
    |     |
    |     +-- Continue -> next [MASTER_DECISION], carrying the new Artifact index
    |
    +-- RESPOND_TO_USER
          | inject MB rationale + task + SA observations when needed
          v
       Persistence (metadata.persistContent preserves cross-request context)
          |
          v
       User-visible reply, with internal decision information stripped
```
