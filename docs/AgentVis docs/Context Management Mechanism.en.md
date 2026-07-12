# AgentVis MB and SA Context Management Mechanism

> **Document scope**: the full context-management pipeline between the Master Brain (MB) decision brain and Sub-Agent (SA) execution units.  
> **Code base**: `src/services/planning/`

---

## Overall Architecture

AgentVis uses an **MB + SA layered architecture**: MB is responsible for strategic decision-making, while SA is responsible for atomic execution. They maintain independent context pipelines and collaborate through shared mechanisms such as Task Artifact Store, hitlStore, and AgentSession.

```text
User request
    |
    v
+------------------------- AgentService (FSM Owner) -------------------------+
|                                                                            |
|  +----------------------+   +-------------------------------------------+  |
|  |  Master Brain (MB)   |   |  Sub-Agent (SA)                           |  |
|  |  strategy decision   |   |  atomic execution, tool calls              |  |
|  |  global perspective  |   |                                           |  |
|  |                      |   |                                           |  |
|  | MasterBrainInput     |   | System Prompt                             |  |
|  |  + userIntent        |   |  + BASE_TEMPLATE                          |  |
|  |  + memory            |   |  + behaviorHint                           |  |
|  |  + ragEvidence       |   |  + LOOP_GUIDANCE                          |  |
|  |  + conversationHist  |   |  + inputProtocol                          |  |
|  |  + toolCatalog       |   |  + taskExperiences                        |  |
|  |  + externalSkills    |   |  + sandboxRuntime                         |  |
|  |  + skillCatalogs     |   |  + toolSection                            |  |
|  |  + artifactIndex     |   |  + externalGuides                         |  |
|  |  + workdirSnapshot   |   |  + externalScripts                        |  |
|  |  + mbDecisionHistory |   |  + venvConstraints                        |  |
|  |                      |   |  + platformInfo                           |  |
|  +----------------------+   |  + TOOL_CALL_SELF_CHECK                   |  |
|                             +-------------------------------------------+  |
|                                                                            |
|   +--------------------------------------------------------------------+   |
|   |              Task Artifact Store (cross-SA shared channel)          |   |
|   +--------------------------------------------------------------------+   |
+----------------------------------------------------------------------------+
```

---

## 1. MB-Side Context Management

### 1.1 MasterBrainInputBuilder - Data Aggregator

**File**: [MasterBrainInputBuilder.ts](../../src/services/planning/agent-loop/builders/MasterBrainInputBuilder.ts)

Every time the FSM enters the `MASTER_DECISION` state, `MasterBrainInputBuilder.build()` aggregates data from multiple sources and constructs the `MasterBrainInput` contract object. It contains the following information layers:

| Information layer | Source | Purpose |
|--------|------|------|
| `userIntent` | Last user message from `AgentSession.getMessages()` | Current user intent, including the original send time (`sentAt`) so MB can estimate elapsed time. |
| `memory` | `MemoryService.getMemorySnapshot(agentId, query)` | Long-term factual memory plus summary memory, recalled semantically. |
| `ragEvidence` | `RagService.getRAGEvidence(query)` | Knowledge-base retrieval results (RAG). |
| `conversationHistory` | Latest N user / assistant turns from `AgentSession.getMessages()` | Short-term conversation context supplement, covering recent turns not yet summarized between watermarks. |
| `toolCatalog` | `AgentLoop.getToolCatalogEntries()` | Decision-level summaries of available tools, not full `SKILL.md` content. |
| `externalGuideSkills` | `SkillRetriever.retrieve(query, topK=3)` | External Guide skills semantically retrieved by user intent, Top-K. |
| `externalScriptSkills` | `SkillRetriever` / registry exact match | Script skills explicitly mentioned by the user or MB, passed to the DISPATCH phase. |
| `installedSkillCatalog` | Static full Guide skill list, including name and description | Ensures MB knows all installed Guide skills and avoids semantic-retrieval misses. |
| `installedScriptSkillCatalog` | Static full Script skill catalog | Ensures MB knows which Script skills can be called through `external_skill_execute`. |
| `taskArtifactIndex` | `TaskArtifactStore.getIndex()` | Lightweight index of prior SA intermediate results, including tool name and source parameters. |
| `taskArtifactObservations` | `SharedState.saObservationsSummaries` | Observation-summary timeline reported from SAs to MB. |
| `workdirSnapshot` | Aggregated stats from `SubAgentDispatcher.scanWorkdirFiles()` | WORKDIR file-system state, including total file count, extension distribution, and five most recent files. |
| `projectPath` / `deliverableWorkdir` | `AgentLoopFSMIntegration` configuration | External project cwd switching and original deliverable directory hint. |
| `sandboxMode` | Agent safety-mode configuration | Injects MB sandbox awareness, distinguishing LocalAudit / ControlledNetwork / OfflineIsolated. |
| `mbDecisionLog` | `SharedState.mbDecisionLog` | Recent N rounds of MB decision reasoning, preventing repeated dispatch or decision drift in long tasks. |
| `lastMBDecision` | `SharedState.lastMBRationale + lastMBTask` | Single-round fallback for backward compatibility when `mbDecisionLog` is unavailable. |
| `hasExecutedSA` | Current Session `sub_agent_*` tool messages | From round 2 onward, renders `[USER_INTENT]` in a desensitized way so the original user message is not treated as a new request. |
| `mbBudgetRemaining` | `LoopGovernor.getSnapshot()` | Injects a closing reminder at the tail of messages when the MB budget is close to exhaustion. |

### 1.2 MB Prompt Assembly Structure

**File**: [MasterBrainPrompt.ts](../../src/services/planning/brain/MasterBrainPrompt.ts)

The MB Prompt consists of hard constraints at the top, fixed context, budget-management blocks, and tail format anchors:

```text
+--- P0 (Prime Directive, highest priority) -------------------------------+
|  - Role definition: Master Brain decision brain                           |
|  - Three decision types: SPAWN_SUB_AGENT / REQUEST_MORE_INPUT /           |
|    RESPOND_TO_USER                                                        |
|  - Output format requirement: JSON Schema                                 |
+---------------------------------------------------------------------------+

+--- Fixed context (fixed token cost, not part of progressive truncation) --+
|  - Identity Awareness / Character Grounding                               |
|  - AgentRules, MB-specific rules                                          |
|  - CURRENT_TIME / USER_INTENT / WORKDIR / PROJECT_CONTEXT                 |
|  - WORKDIR_SNAPSHOT, aggregated by buildWorkdirSnapshot                   |
|  - MB_SANDBOX_AWARENESS, ControlledNetwork / OfflineIsolated              |
|  - MB_DECISION_HISTORY, preferred, or LAST_MB_DECISION fallback           |
|  - Installed Guide / Script skill catalogs and matched external Guides    |
|  - OUTPUT_FORMAT_FOOTER, tail JSON format anchor                          |
+---------------------------------------------------------------------------+

+--- Variable zone (can be truncated by budget) ----------------------------+
|  - TOOL_CATALOG, progressive truncation with a 4-level strategy           |
|  - CONVERSATION_HISTORY, recent N conversation turns                      |
|  - MEMORY, long-term facts, summaries, task_experience                    |
|  - RAG_EVIDENCE, truncated by relevance                                  |
|  - TASK_ARTIFACTS, prior SA intermediate result index                     |
|  - Prior SA reasoning-process summaries, in timeline form                 |
+---------------------------------------------------------------------------+
```

### 1.3 Progressive Tool Catalog Truncation (4-Level Strategy)

The `TOOL_CATALOG` in the MB Prompt is dynamically truncated under budget pressure. `BASE_TOOLS` (`read` / `local_search` / `web_search` / `exec` / `file_write`) have already been filtered out of `TOOL_CATALOG`, so MB only sees special tools such as `cron` and `generate_image`.

| Level | Removed content | Retained content |
|-------|---------|---------|
| 1 | None | Everything is preserved. |
| 2 | `whenToUse` | `whenNotToUse`, `decisionHint`, and full description. |
| 3 | `whenToUse` + `decisionHint` | `whenNotToUse` and full description. |
| 4 | All extension fields | Only name, first sentence of description, and riskLevel. |

### 1.4 Strategic Continuity Injection ([MB_DECISION_HISTORY] / [LAST_MB_DECISION])

**Problem**: after SA execution completes, the final report is saved in the parent `AgentSession` as a `role: tool` message with `toolName=sub_agent_*`. Before the next MB plain-text call, `AgentLoop` converts `tool` messages into `role: user` messages to fit the LLM API. Without a semantic fence, MB may misread an SA report as a new user request and dispatch again.

**Two-layer protection**:

```text
Layer 1: SA report semantic fence (AgentLoop.ts)
  +------------------------------------------------------------------+
  | [SYSTEM: The following is an execution completion report from    |
  |  Sub-Agent (tool name). It is not a user message]                |
  | ...report content...                                             |
  | [END_SA_REPORT]                                                  |
  +------------------------------------------------------------------+

Layer 2: Prefer [MB_DECISION_HISTORY] injection (MasterBrainInputBuilder)
  +------------------------------------------------------------------+
  | [CONVERSATION_HISTORY]  ...user conversation history...           |
  |                                                                  |
  | [MB_DECISION_HISTORY]  <- recent N rounds of MB decision chain    |
  |   Round 1 - Completed / SA failed                                |
  |   Decision rationale: ...                                        |
  |   Dispatched task: ...                                           |
  |                                                                  |
  | [TASK_ARTIFACTS]  ...SA execution results...                     |
  +------------------------------------------------------------------+
```

`mbDecisionLog` / `lastMBDecision` data flow:

- **Write within the same run**: `StateHandlers.handleDispatch()` writes an `MbDecisionLogEntry` after SA dispatch completes, including round, rationale, task, completed / failed.
- **Sliding window**: `PLANNING_CONSTANTS.MB_DECISION_LOG_MAX_ROUNDS = 5`, keeping only the latest 5 rounds.
- **Inject within the same run**: `AgentLoopFSMIntegration.syncSharedState()` -> `setMbDecisionLog()` / `setLastMBDecision()` -> next MB input.
- **Prompt selection**: `MasterBrainPrompt` renders `[MB_DECISION_HISTORY]` first. If the history log is empty, it falls back to `[LAST_MB_DECISION]`.
- **Cross-request persistence**: on abnormal termination, `injectRationaleBeforeReturn()` appends it to `persistContent`; on JSON degradation, `StateHandlers` appends the taskBlock.

> [!NOTE]
> `[MB_DECISION_HISTORY]` / `[LAST_MB_DECISION]` are not part of variable-zone truncation because they are core context for preserving MB strategic continuity.

---

## 2. SA-Side Context Management

### 2.1 SubAgentPromptBuilder - System Prompt Assembly

**File**: [SubAgentPromptBuilder.ts](../../src/services/planning/sub-agents/SubAgentPromptBuilder.ts)

The SA System Prompt concatenates multiple sections in a fixed order. Sections are separated by `\n\n---\n\n`. With sandboxing, external Script Skill support, and tail safety anchors added, it is no longer a fixed 11-section prompt:

| No. | Section | Content | Trigger |
|------|---------|------|---------|
| 1 | `BASE_TEMPLATE` | Core constraints: responsibility boundary, execution red lines, and output rules. | Always injected. |
| 2 | `getBehaviorTemplate()` | Behavior modifier, supporting the two styles `careful` and `direct`. | When `spec.behaviorHint` is present. |
| 3 | `LOOP_EXECUTION_GUIDANCE` | Loop execution mode description and execution-experience report format. | When `spec.loopConfig` is present. |
| 4 | `formatAgentRules()` | User-defined role rules, such as PM role rules. | When `context.data.agentRules` is present. |
| 5 | `buildCurrentTimePrompt()` | Current time, allowing SA to perceive time. | Always injected. |
| 6 | `buildSandboxRuntimeContextSection()` | Isolated runtime / network sandbox constraints. | When `sandboxMode` is `ControlledNetwork` / `OfflineIsolated`. |
| 7 | `buildInputProtocol()` | Task role, background context, prior SA reports, Artifact snapshot, HITL constraints, and task-context JSON. | Always injected. |
| 8 | `buildTaskExperienceSection()` | Existing `task_experience` from the memory system, including deduplication guidance. | When historical experience exists. |
| 9 | `buildToolSection()` | Original `SKILL.md` content for authorized tools. Skills matched by Guide avoid duplicate full-text injection. | Always injected. |
| 10 | `buildExternalGuideSection()` | Full text and metadata for Guide skills matched by SkillRetriever, plus other installed skill names at the tail. | When matched skills or installed skill catalog exists. |
| 11 | `buildExternalScriptSection()` | Execution metadata for exactly matched Script Skills. | When matched Script skills exist. |
| 12 | `buildVenvConstraintSection()` | Python venv path constraints, prohibiting package installation / new environments. | When `venvPythonPath` is present. |
| 13 | `buildPlatformInfoSection()` | Windows platform command constraints, such as `dir` and `type`. | In Windows environments. |
| 14 | `TOOL_CALL_SELF_CHECK` | CoT tool-call self-check guidance, establishing a thinking framework. | When `spec.loopConfig` is present. |

### 2.2 buildInputProtocol - Core Context Injection

`buildInputProtocol()` is the core assembly method for SA context. It injects and combines content in the following order:

```text
## Input Protocol

> [!CAUTION] <- HITL hard constraint, highest priority, from context.data.hitlOverride
> ### User Intervention Constraint - Must Be Followed
> ...

### Task Role
{spec.role}

### Background Context
{spec.contextSummary}  <- optional, provided by MB

### Previous Sub-Agent Reports (continue from these; do not repeat completed work)
{recentToolResults: prior SA TASK_COMPLETE-level reports}  <- role=tool messages slice(-3)

### Previous Task Artifacts (do not repeat completed work)
{artifactSnapshot: full Artifact Store content}  <- total context window x 15%; when budget is insufficient, newest items are kept first

### Termination Condition
{spec.terminationCondition}  <- optional

### Task Context
{sanitizedContext JSON}  <- sensitive fields and already injected fields are filtered out
```

> When SA needs historical conversation, MB sets `nextStep.includeHistory=true`. `SubAgentDispatcher.buildRunnerHistoryMessages()` then injects the latest N user / assistant turns as a Runner `messages[]` prefix before the first task instruction, avoiding the same history being scattered across both the system prompt and messages.

### 2.3 Context Isolation (sanitizeContext)

`sanitizeContext()` applies two kinds of filtering before serializing `context.data`:

**Sensitive field filtering** (security): `userId`, `apiKey`, `token`, `password`, `secret`, `globalGoal`

**Already injected field exclusion** (prevents duplicate serialization):

| Original field | Already injected location |
|---------|----------|
| `artifactSnapshot` | Artifact section in `buildInputProtocol()`. |
| `recentToolResults` | Prior SA reports section in `buildInputProtocol()`. |
| `agentRules` | Section 4, `formatAgentRules`. |
| `taskExperiences` | Historical experience block, `buildTaskExperienceSection`. |
| `hitlOverride` | Top CAUTION block in `buildInputProtocol()`. |

### 2.4 Per-Step LLM Calls - Tail Safety Anchor

**File**: [SubAgentLLMCaller.ts](../../src/services/planning/agent-loop/callers/SubAgentLLMCaller.ts)

Message organization for each SA LLM call (`callWithContext`):

```text
[system]     <- System Prompt described above

[user]       <- optional historical conversation prefix, when includeHistory=true
[user]       <- initial task instruction, first step
[assistant]  <- LLM response
[tool]       <- tool execution result
[user]       <- optional additionalInstructions, such as strategy adjustment / budget warning / context reset instruction
              + "---" + optional SAFETY_FOOTER_TEXT, only when subAgentSafetyFooterEnabled=true
              + "---" + optional persistedIntervention, HITL user intervention, always placed at the very end
```

> **Key design**: the tail user message is the attention hot zone for every SA call. `SAFETY_FOOTER_TEXT` is placed in that hot zone when enabled. If the user intervenes through HITL, `persistedIntervention` is appended after the Safety Footer, giving it higher priority and keeping it present in every subsequent step.

> **MaxTokens Budget**：The per-call provider output budget is independent of this input-context organization. Normal SA
calls use the `subAgent` output profile (32K with one explicit parameter-rejection fallback to
24K). Context-window ratios below measure accumulated input history and must not be used as model
output ceilings. Accepted responses that finish because their output budget is exhausted are
discarded before tool execution and retried with a split-work instruction.

---

## 3. SA Three-Level Progressive Context Compression Strategy

When an SA executes a long-chain task, `messages[]` expands as tool-call results accumulate. Runner maintains context health through a three-level compression mechanism:

**File**: [SubAgentRunner.ts](../../src/services/planning/sub-agents/SubAgentRunner.ts)

```text
               token ratio (total context window)
  0%-------------45%------------------85%----100%
               |                    |
               v L2 trigger         v L1 trigger
  normal       context reset         gradient compression
  execution    (active cleanup)      (high-position safety fallback)
```

### 3.1 L1 Gradient Compression (Trigger Threshold: 85% of Total Window)

This is a **high-position safety fallback** and only triggers when L2 has not released enough context.

**Strategy**: `compressHistoricalToolOutputs()`

Tool messages in the historical zone, outside the protected zone, are handled in two pressure modes:

| Condition | Handling |
|------|---------|
| **No pressure** (tokens < 85% of window) | Standard gradient compression: preserve content under 5K tokens in full. |
| **Pressure + assistant analysis exists** | Aggressively compress to metadata plus reference hints, because LLM analysis conclusions already exist. |
| **Pressure + no assistant analysis** | Standard gradient compression, preserving more raw content. |

Tool-specific cap: `SUB_AGENT_COMPRESS_THRESHOLD_L1 = 8000 tokens`

### 3.2 L2 Context Reset (Trigger Threshold: 45% of Total Window and Remaining Steps >= 3)

This is an **active cleanup mechanism** that lets SA output a structured summary and then restart:

```text
Step N: tokens > 45% of total window
    v Runner injects CONTEXT_RESET_INSTRUCTION through additionalInstructions

Step N+1: SA outputs a structured summary marked with ---CONTEXT_SUMMARY---
    v Runner intercepts the summary before termination-signal detection, continuing and skipping detection
    v Clears messages[] while keeping the system prompt
    v Injects the summary as a new user message

Step N+2: SA continues the unfinished task from the summary, with a fresh context
```

**Key design**:

- Supports an **unlimited number** of resets. `contextResetCount` is counted, and each reset unlocks the next possible trigger.
- `toolCallSteps` and `totalToolCalls` **are not reset**, preserving total budget control.
- If SA does not respond within 2 steps, `buildMechanicalSummary()` provides a mechanical fallback.

### 3.3 L3 Budget Warning (Triggered by Step Usage Ratio)

When steps are close to exhaustion, a closing prompt is injected to guide SA toward completion:

| Trigger condition | Injected content | Constant |
|---------|---------|------|
| `toolCallSteps / maxSteps > 85%` | Lightweight closing prompt. | `SUB_AGENT_BUDGET_WARNING_RATIO = 0.85` |
| `toolCallSteps / maxSteps > 95%` | Final strong warning. | `SUB_AGENT_BUDGET_CRITICAL_RATIO = 0.95` |

### 3.4 Key Constants

**File**: [PlanningConstants.ts](../../src/services/planning/PlanningConstants.ts)

```typescript
SUB_AGENT_TOKEN_PRESSURE_RATIO      = 0.85  // L1 gradient compression trigger
SUB_AGENT_CONTEXT_RESET_RATIO       = 0.45  // L2 context reset trigger
SUB_AGENT_CONTEXT_RESET_MIN_REMAINING_STEPS = 3  // Minimum remaining steps for L2
SUB_AGENT_BUDGET_WARNING_RATIO      = 0.85  // First L3 budget warning
SUB_AGENT_BUDGET_CRITICAL_RATIO     = 0.95  // Final L3 budget warning
SUB_AGENT_BUDGET_CHECKPOINT_REMAINING_STEPS = 5   // Budget Checkpoint when near exhaustion
SUB_AGENT_BUDGET_EXTENSION_MAX_ITERATIONS = 20    // Max steps per budget extension
SUB_AGENT_BUDGET_EXTENSION_MAX_COUNT = 2          // Max extensions per SA
TOOL_CALLS_HARD_LIMIT               = 200   // Hard safety valve for total tool calls
MAX_TOOLS_PER_STEP                  = 8     // Max parallel tool calls in one step
SUB_AGENT_COMPRESS_THRESHOLD_L1     = 8000  // L1 aggressive truncation threshold, tokens
MB_DECISION_LOG_MAX_ROUNDS          = 5     // MB decision-history sliding window
```

---

## 4. Task Artifact Store - Cross-SA Result Persistence

**File**: [TaskArtifactStore.ts](../../src/services/planning/artifact/TaskArtifactStore.ts)

### 4.1 Background

After an SA execution fails, MB may dispatch a new SA. The new SA cannot access intermediate results from the prior SA, such as search results and file content, which can cause substantial duplicated work.

### 4.2 Automatic Extraction Strategy

As long as an SA tool returns a result, `SubAgentRunner.storeToolResultAsArtifact()` automatically extracts and archives it. Successful and failed results are both retained, with no explicit LLM instruction required:

| Tool | Maximum retained content | Data type |
|------|---------|---------|
| `web_search` | 3000 characters | `search_results` |
| `read` / `file_read` | 1500 characters | `file_content` |
| `exec` | 500 characters | `execution_output` |
| `file_write` | 200 characters | `file_operation` |

### 4.3 Two-Layer Injection Architecture

```text
TaskArtifactStore (memory, 30K-token total budget; FIFO eviction when writes exceed limit)
    |
    +---- Index injection (lightweight) -----> MasterBrainInputBuilder.build()
    |     tool name + source parameters                  |
    |     budget: variableBudget x 10%                   v
    |                                             MB Prompt [TASK_ARTIFACTS]
    |                                             helps MB guide a new SA to reuse existing results
    |
    +---- Snapshot injection (full data) -----> SubAgentDispatcher.buildTaskContext()
          full Artifact content                         |
          budget: total context window x 15%            v
                                                   SA System Prompt [prior task results]
                                                   new SA receives search results / file content
```

`TaskArtifactStore.getSnapshot(budgetTokens)` selects content as follows: if the full content fits, inject everything. If the budget is insufficient, select from the newest Artifact backward, preserving the most recently written results first, while the index still contains all lightweight entries.

### 4.4 Lifecycle

```text
AgentLoopFSMIntegration constructed       -> initializes TaskArtifactStore
SubAgentRunner tool result returns        -> storeToolResultAsArtifact() writes
run() -> reset(), at each user request    -> clears all Artifacts
writes exceed the 30K-token total budget  -> FIFO evicts oldest entries
```

---

## 5. Human-in-the-Loop (HITL) - Between-Step Intervention

**Files**: [hitlStore.ts](../../src/stores/hitlStore.ts) / [SubAgentRunner.ts between-step checkpoint](../../src/services/planning/sub-agents/SubAgentRunner.ts)

### 5.1 Intervention Flow

```text
UI (HitlInterventionBar)
    | pause(contextId)        <- user clicks "Pause"
    v
hitlStore (Zustand)
    | pausedContexts.add(contextId)
    |
SubAgentRunner (between-step checkpoint)
    | while (!terminated) {
    |     checkAbortSignal()           <- termination has priority
    |     isPaused() -> waitForResume() <- HITL checkpoint
    |     callLLM()
    |     executeTools()
    | }

User enters intervention message -> resume(contextId, message)
    +-- additionalInstructions injection       <- visible to the current SA's next LLM call
    +-- persistedIntervention injection        <- stays visible in the tail hot zone of later LLM calls
    +-- append user message to messages[]      <- permanently visible during current SA lifecycle
    +-- TaskArtifactStore.write(user_intervention) <- cross-SA persistence
    +-- emitObservation({ thinking: '[User intervention] ...' }) <- UI timeline
```

### 5.2 Race Condition Handling (preResolvedMap)

The user may click resume during an LLM call before `waitForResume` has been called:

| Scenario | Handling |
|------|---------|
| Normal: `waitForResume` starts waiting first, then the user resumes. | `resume()` directly finds and calls the resolver. |
| Race: the user resumes before `waitForResume` is called. | The message is temporarily stored in `preResolvedMap` and consumed immediately when `waitForResume` starts. |

> [!IMPORTANT]
> `isPaused()` must check both `pausedContexts` and `preResolvedContexts` in Zustand state. `preResolvedMap` is a module-level cache and does not trigger React re-rendering, so `preResolvedContexts` is needed to let both UI and Runner perceive the "resumed but not yet consumed" state.

### 5.3 Persisting Intervention Messages into Task Artifact

Intervention messages are written into `TaskArtifactStore` as `user_intervention`:

```typescript
TaskArtifact {
    key: 'user_intervention_0',
    toolName: 'user_intervention',
    content: '[User intervened at step N to adjust strategy]\nUser instruction: <original text>'
}
```

The MB Prompt's `[TASK_ARTIFACTS]` section displays an intervention warning block to ensure the next dispatched SA inherits the constraint. In a new SA's System Prompt, `hitlOverride` is promoted to the very top of `buildInputProtocol()` as a CAUTION warning block. The current SA continuously receives the user intervention instruction through `persistedIntervention` in the tail hot zone of every LLM call.

---

## 6. Conversation-Turn Isolation - Tool Message Lifecycle

SA tool-call results, such as large raw text from `web_search`, can bloat the parent Session. The following mechanisms isolate them:

| Mechanism | Implementation location | Purpose |
|------|---------|------|
| **SA tool isolation** | `AgentLoop.createToolAdapter()` | When `isSubAgentContext === true`, skips `addMessage`, so SA internal tool results are not written into the parent Session. |
| **Turn cleanup** | `AgentSession.clearToolMessages()` | Clears `role=tool` messages from the previous round at the start of each `runWithFSM()`. |
| **SA observations retained** | `SubAgentDispatcher.buildDispatchResult()` | Writes the SA final report into the parent Session as `role=tool` / `toolName=sub_agent_*`, available in the current round and cleared next round. |
| **Conversion before MB call** | `AgentLoop.callLLM()` | Plain-text MB calls do not support `role=tool`, so current-round `tool` messages are converted into semantic-fenced `role=user` messages. |

```text
Within the same request:
  Session = [user_1...user_n] + [assistant_1...assistant_n] + [tool(current-round SA observations)]
  -> Before MB call, tool is converted into a user message with [END_SA_REPORT] and becomes visible

At the start of the next request:
  clearToolMessages() -> all [tool] messages are cleared
  Session = [user_1...user_n] + [assistant_1...assistant_n]
  -> Cross-round knowledge transfer is handled by the memory system (task_experience)
```

---

## 7. Task Experience Memory - Persisting SA Trial-and-Error Experience

When SA encounters meaningful trial-and-error experience during execution, it appends a `## EXECUTION_EXPERIENCE` marker after `TASK_COMPLETE`. After extraction, the experience is injected into **both MB and SA Prompts**:

```text
SA report contains "## EXECUTION_EXPERIENCE"
    |
    v ExperienceExtractor.extractExperienceFeedback()
    |
    v pendingExperiences accumulates in SharedState
    |
    v RESPOND_TO_USER phase batch write -> MemoryService.saveTaskExperience()
                                           (SQLite, task_experience category)
    |
    +---- MB side: MasterBrainPrompt [TASK_EXPERIENCE] section
    +---- SA side: SubAgentPromptBuilder historical experience block
                  (buildTaskExperienceSection), including deduplication guidance
                  to prevent SA from repeatedly reporting the same type of experience
```

Write conditions:

- Environment configuration, path, or encoding pitfalls.
- More efficient execution methods discovered.
- Lessons from tool / skill usage failures.
- Smooth runs do not need to be reported.

---

## 8. Security Enhancement Summary

| Mechanism | Injection location | Purpose |
|------|---------|------|
| Execution-boundary negative list | `BASE_TEMPLATE`, always | Five explicit prohibitions, such as fixing bugs outside scope, installing packages, and speculative operations. |
| Tool-call CoT self-check | `TOOL_CALL_SELF_CHECK`, Loop only | SA states operation intent at each step and builds a self-constraint framework. |
| Tail safety anchor | `SAFETY_FOOTER_TEXT`, on every LLM call when `subAgentSafetyFooterEnabled=true` | Located in the context tail attention hot zone to resist long-context dilution. |
| HITL tail hard constraint | `persistedIntervention`, on every LLM call after the Safety Footer | After user intervention, the instruction continuously has the highest tail-attention priority. |
| Scope-violation Checkpoint | `MasterBrainPrompt.buildCheckpointEvaluationPrompt` | Detects whether SA operated on resources outside the delegated scope. |
| Intent-drift Checkpoint | Same as above | Detects whether the SA's next tool call is unrelated to the task goal. |
| ADJUST_STRATEGY progress summary | `buildProgressSummaryForSA()` | Injects completed steps during strategy adjustment to prevent repeated operations after context truncation. |
| Semantic fence | `AgentLoop.ts`, when converting `sub_agent_*` tool reports into user messages | Prevents MB from mistaking SA reports for new user requests. |
| MB decision history | `[MB_DECISION_HISTORY]` in `MasterBrainPrompt` | Latest 5 rounds of MB rationale / task / status, preventing repeated dispatch and decision drift. |

---

## Key File Index

| File | Responsibility |
|------|------|
| [MasterBrainInputBuilder.ts](../../src/services/planning/agent-loop/builders/MasterBrainInputBuilder.ts) | Aggregates MB input data and merges information from multiple sources. |
| [MasterBrainPrompt.ts](../../src/services/planning/brain/MasterBrainPrompt.ts) | Assembles MB Prompt, handles budget truncation, and injects `[MB_DECISION_HISTORY]`. |
| [SubAgentPromptBuilder.ts](../../src/services/planning/sub-agents/SubAgentPromptBuilder.ts) | Assembles SA System Prompt, handles context isolation, and places HITL top constraints. |
| [SubAgentRunner.ts](../../src/services/planning/sub-agents/SubAgentRunner.ts) | Runs the SA atomic event loop, three-level compression strategy, Artifact auto-extraction, and HITL between-step checks. |
| [SubAgentLLMCaller.ts](../../src/services/planning/agent-loop/callers/SubAgentLLMCaller.ts) | Performs per-step LLM calls and injects Safety Footer / HITL into the tail hot zone. |
| [TaskArtifactStore.ts](../../src/services/planning/artifact/TaskArtifactStore.ts) | Persists cross-SA results, selects snapshots by budget, and performs FIFO total-size eviction. |
| [SubAgentDispatcher.ts](../../src/services/planning/agent-loop/dispatchers/SubAgentDispatcher.ts) | Builds SA task context, injects Artifact snapshots, and writes SA `role=tool` reports. |
| [AgentLoopFSMIntegration.ts](../../src/services/planning/agent-loop/AgentLoopFSMIntegration.ts) | Synchronizes strategic continuity, coordinates state, and manages the Artifact Store lifecycle. |
| [hitlStore.ts](../../src/stores/hitlStore.ts) | Manages HITL pause / resume state and pre-resolved race-condition handling. |
| [PlanningConstants.ts](../../src/services/planning/PlanningConstants.ts) | Defines compression, budget, tool limit, and MB decision-history constants. |
| [AgentSession.ts](../../src/services/planning/agent-loop/AgentSession.ts) | Manages session messages and per-turn tool-message cleanup. |
| [ExperienceExtractor.ts](../../src/services/planning/agent-loop/ExperienceExtractor.ts) | Extracts SA experience and writes it into the memory system. |
