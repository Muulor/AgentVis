# AgentVis Memory Mechanism Introduction

> Document scope: the full `src/services/memory/` module plus the `src/components/memory/` UI layer

---

## 1. Design Goals

The core goal of the AgentVis memory system is to let an AI Agent "know" the user across sessions and tasks, and to distill valuable understanding into long-term knowledge instead of starting from zero in every conversation.

Specifically, the memory system solves three problems:

1. **Conversation accumulation in the current session**: as conversation turns increase and fill the LLM context window, how can the system compress them without losing key information?
2. **Cross-session persistence of user facts**: how can stable facts such as the user's identity, preferences, and goals be identified reliably and stored long term?
3. **Precise context supply**: how can saved memories be injected into the LLM Prompt at the right time and at the right granularity without adding noise?

---

## 2. Three-Layer Memory Architecture

The memory system uses three graded storage layers, from "hot" to "cold":

```text
+------------------------------------------------------------------+
| Layer 1: Short-Term Buffer                                       |
| - Stores the latest N user messages and their assistant replies  |
| - Dual-track storage: in-memory ShortTermBuffer + database       |
|   persistence                                                    |
| - Compresses into Layer 2 after the watermark threshold is met   |
+------------------------------------------------------------------+
| Layer 2: Summary Layer                                           |
| - LLM-driven stateful summaries, including confirmed decisions   |
|   and open questions                                             |
| - Summaries are vectorized and support embedding + temporary     |
|   BM25/RRF hybrid recall                                         |
| - State fields are passed through metadataJson for later         |
|   decision backtracking                                          |
+------------------------------------------------------------------+
| Layer 3: Fact Layer                                              |
| - Structured user facts stored in 6 categories                   |
| - Three-stage pipeline: candidate scan -> stability verification |
|   -> LLM extraction and write                                    |
| - Importance scoring plus category consolidation                 |
+------------------------------------------------------------------+
```

---

## 3. Layer 1: Short-Term Buffer (ShortTermBuffer)

### 3.1 Sliding Window and FIFO Eviction

`ShortTermBuffer` maintains a sliding window measured by the number of **user messages**.

| Parameter | Default | Meaning |
|------|--------|------|
| `windowSize` | 10 | Maximum number of user messages retained. |
| `watermarkThreshold` | 0.6 | Watermark that triggers compression, 60% = 6 messages. |
| `batchSizeRatio` | 0.4 | Batch ratio popped each time, 40% = 4 messages. |

The watermark is based on user-message count rather than total message count to avoid false triggers caused by very long assistant replies.

### 3.2 Dual-Track Storage

After each user message and assistant reply, `MemoryService.addInteraction()`:

1. **Writes to memory**: calls `buffer.addMessages()` to update the in-memory buffer for fast access within the same session.
2. **Persists to the database**: calls the Rust backend `memory_create` command through Tauri IPC and persists `User: <content>` and `Agent: <content>` separately into SQLite.

Persistence uses a **compensation strategy**: after the user message is written successfully, if writing the assistant message fails, the system automatically rolls back the already-written user record to avoid orphaned records.

### 3.3 Watermark Transition Flow

```text
Every addInteraction() -> check database short_term record count
|
+-- Below watermark (user messages < windowSize x watermarkThreshold)
|   +-- Do nothing
|
+-- Reaches watermark
    +-- Emit memory:watermark_triggered event, UI shows "Organizing memory..."
    +-- Take batchSize messages from the head of the FIFO queue
    +-- Call SummaryManager to generate an LLM summary
    +-- After writing the summary into Layer 2, delete the corresponding short_term records
        +-- Repeat until the watermark falls back into the safe zone
```

The watermark flow has **infinite-loop protection**: if the `short_term` record count does not change after two consecutive processing rounds, which can happen when the LLM keeps failing, the loop exits automatically. Watermark processing uses a **mutex** (`_watermarkLock`) to prevent duplicate summaries from concurrent `onSessionEnd` and `checkWatermarkOnResume` calls.

---

## 4. Layer 2: Summary Layer (SummaryManager)

### 4.1 Stateful Summary Design

Ordinary summaries only compress content. AgentVis summaries are **stateful** and contain the following fields:

| Field | Type | Meaning |
|------|------|------|
| `summary` | string | Highly condensed state summary. |
| `keyPoints` | string[] | Key state points as concise items. |
| `topics` | string[] | Discussion topics used for semantic retrieval. |
| `mentionedFiles` | string[] | Referenced file paths. |
| `confirmedDecisions` | string[] | Confirmed conclusions / decisions. |
| `openQuestions` | OpenQuestion[] | Open questions that drive precise original-message backtracking. |
| `invalidatedPoints` | string[] | Points that have been invalidated. |

The intent is that a summary is not only compressed history, but also a **snapshot of conversation state**. It helps the LLM perceive both certainty and uncertainty in the current context.

### 4.2 Summary Vectorization and Hybrid Recall

After each summary is generated, the system calls the Embedding API to build a vector index (`MemoryVectorIndex`). During context injection, `MemoryContextProvider` calls `MemorySummaryRetriever`: it first recalls a semantic candidate pool through embeddings, with final Top-3 by default and a similarity threshold of 0.4; then it temporarily builds a `BM25Index` over summary state fields for lexical recall; finally, it fuses rankings with RRF.

The BM25 index text is built from `content`, `topics`, `keyPoints`, `mentionedFiles`, `confirmedDecisions`, the question / scope / keywords in `openQuestions`, and `invalidatedPoints`. BM25-only candidates must hit strong anchors such as file names, paths, code symbols, quoted phrases, or explicit proper names. Generic words such as "previous", "plan", "issue", "mechanism", "memory", "summary", "this", and "that" cannot trigger recall by themselves.

If embedding fails but BM25 has strong-anchor hits, those strong-anchor results are returned directly. If both embedding and BM25 have no usable results, the system **degrades** to returning the latest K summaries and skips original-message backtracking and evidence-slice loading, avoiding irrelevant content pollution in the Prompt.

### 4.3 Open Questions and Evidence Backtracking

When a summary contains `openQuestions`, `EvidenceRetriever`:

1. Locates the original message range using each question's `keywords`, `turnHint`, and the current `userQuery`.
2. Extracts `[User] + [Assistant]` evidence slices in user-turn pairs, avoiding semantic breaks caused by recalling only the user's question or only the assistant's answer.
3. By default, expands 1 evidence turn only for the top-ranked recalled summary. When the query explicitly asks for historical context, such as "complete process", "review", "context", "chain", "timeline", or "recap", it expands to 2 turns.
4. Trims long answers by relevant paragraphs and attaches them as `evidenceSlices` under the corresponding question node.
5. Injects the final content into the Prompt in the `Evidence Slices` format to help the LLM fill in missing details.

---

## 5. Layer 3: Long-Term Facts - Three-Stage Pipeline

Fact extraction is the core of the memory system. It uses a **three-stage progressive pipeline** instead of calling an LLM for extraction after every conversation:

```text
User message input
     |
     v
[Layer 1 - Candidate Scan] MemoryCandidateScanner (rule-based, no LLM)
     |   Scans user messages and matches the intent dictionary
     |   Output: MemoryCandidate[] with category and initial score
     v
[Candidate Pool Merge] StabilityVerifier.mergeCandidatesAsync()
     |   New candidate <-> candidate pool semantic matching
     |   Similar items in the same category are merged with occurrenceCount++
     v
[Layer 2 - Stability Verification] StabilityVerifier (rules + semantic enhancement, no LLM)
     |   Scoring model: see section 5.2
     |   score >= 5 -> promote to Layer 3
     |   score 3~5 -> keep in candidate pool for later accumulation
     |   score < 3 -> discard
     v
[Layer 3 - LLM Extraction And Write] FactExtractor.extractAndSaveFromVerified()
     |   Calls the LLM to refine candidates into standardized facts
     |   Writes them into long-term memory
     +-- Emits memory:facts_updated event to refresh the UI
```

### 5.1 Fact Categories (6 Categories)

| Category ID | English name | Typical example |
|---------|-------|---------|
| `identity_role` | Identity / Role | "I am a backend engineer." |
| `preference_style` | Preferences / Style | "I prefer concise replies." |
| `long_term_goal` | Long-term Goals / Constraints | "I am preparing for system design interviews." |
| `knowledge_level` | Knowledge Level | "I know TypeScript and have some Rust familiarity." |
| `interaction_signals` | Interaction Signals | "Use Chinese for communication; timezone UTC+8." |
| `task_experience` | Task Experience | "On Windows, use findstr instead of grep." |

`task_experience` is written directly by `MemoryService.saveTaskExperience()` after Sub-Agent execution, **bypassing the three-stage verification pipeline**, because SA execution conclusions have natural certainty.

### 5.2 Stability Scoring Model

`StabilityVerifier` computes a **stability score** for each candidate and decides its fate:

| Dimension | Score | Description |
|------|------|------|
| Repeated across multiple turns (`occurrenceCount >= 2`) | +3 | The same fact appears in different turns. |
| Definite expression, without vague words | +2 | No words such as "maybe", "perhaps", or "probably". |
| Affects the decision path | +2 | Contains words such as "decide", "must", or "forbid". |
| Confirmed by the user | +3 | Such as "correct" or "remember this". |
| Contains temporary / emotional / hypothetical words | -3 | Such as "annoyed", "if", or "temporarily". |
| Strong context binding, work / code related | -2 | Such as "this project", "this code", or "just now". |
| Category bonus (`identity_role/preference_style`) | +3 | Categories that are naturally stable. |
| Category bonus (`long_term_goal/knowledge_level`) | +2 | Long-term background categories that are relatively stable. |
| Category bonus (`interaction_signals`) | +0 | No rule-layer bonus; value is judged by the LLM. |
| Preference soft signal, only for `preference_style` | +1 | Words such as "like", "prefer", or "dislike". |

**Threshold rules**:

- `score >= 5`: promote into LLM extraction.
- `retentionThreshold <= score < 5`: retain in the candidate pool and wait for `occurrenceCount` to accumulate. Default `retentionThreshold = 3`.
- `score < retentionThreshold`: discard.

The retention threshold for `interaction_signals` is lowered to 1. This category only filters obvious noise at the rule layer; whether it is worth writing is finally judged by the Layer 3 LLM.

**Cascading Verification**: candidates in the gray zone (`retentionThreshold ~ 5`) additionally call semantic embedding analysis (`SemanticAnchors`) to amplify existing evidence. If the semantic layer confirms strong certainty, it can raise the score to the promotion threshold. The embedding layer **cannot promote candidates on its own**. It is gate-first and can only amplify existing rule signals.

### 5.3 Candidate Pool Overflow Promotion

If a category accumulates 5 candidates in the candidate pool (`CANDIDATE_POOL_OVERFLOW_THRESHOLD`), all candidates in that category are **batch-promoted** to LLM extraction, regardless of whether each individual score is high enough. This is a safety valve for facts that accumulate slowly.

---

## 6. Hybrid Trigger Model (MemoryTriggerManager)

The trigger model determines **when** to start the three-stage pipeline. It uses a **hybrid trigger** strategy to avoid calling the LLM on every conversation turn.

### 6.1 Trigger Signal Sources (Multi-Source)

| Signal type | Strength | Trigger threshold |
|---------|------|---------|
| Explicit memory command, such as "remember this" | Strong signal | +4.0 points, triggers immediately. |
| User confirmation words, such as "correct" / "that's it" | Strong signal | +3.0 points. |
| Candidate scan hit, +0.5 per candidate | Weak signal | Up to +2.0 points per turn. |
| Semantic score accumulates to 5.0 | Semantic trigger | N/A. |
| Conversation reaches 10 turns + base score >= 2.0 | Fallback trigger | N/A. |
| Session end / Agent switch / task completion | Forced trigger | Triggers when there is new content. |

### 6.2 Lifecycle Forced Triggers

The following lifecycle events call `triggerOnLifecycleEvent()` and perform a **strong-consistency checkpoint**:

- The Agent is switched back to, and `AgentChatView` calls `checkWatermarkOnResume()` when mounted.
- The user closes the chat window through `onSessionEnd()`.
- Task mode task completion.

Lifecycle triggers compare `latestMessageId` with `lastProcessedMessageId`. If they differ, processing is triggered, preventing duplicate handling of the same content.

### 6.3 Incremental Processing Optimization

After each trigger, the system records `lastProcessedMessageId`. On the next trigger, it uses `loadRecentMessagesAfter()` for incremental loading and only processes messages after the previous processing point, avoiding a full rescan.

---

## 7. Context Injection (MemoryContextProvider)

The value of memory lies in Prompt injection. `MemoryContextProvider` loads facts, recalls summaries, fills Evidence Slices, and returns structured memory context. Prompt rendering is handled by the caller.

### 7.1 Injection Strategy

| Data | Loading strategy | Injection method |
|------|---------|---------|
| Facts (`fact` layer) | **Full load** | Chat path splits into binding facts and background facts. MB path renders by `factsByCategory` grouping. |
| Summaries (`summary` layer) | **Hybrid recall**, embedding candidates + temporary BM25/RRF, Top-3, threshold 0.4 | Timeline format, ordered by generation time ascending. |
| Original messages, source backtracking | Loaded on demand, controlled by `includeOriginal` | Appended after the corresponding summary. |
| Evidence Slices | Loaded on demand when `openQuestions` is non-empty | By default, expands 1 turn of paired User/Assistant evidence for the first relevant summary; historical-context queries expand to 2 turns. |

### 7.2 Fact Partition Injection

After facts are fully loaded, they are partitioned by usage scenario for injection:

**Chat path binding facts** (constraints the model must follow)

```text
# Confirmed Identity And Preferences

## User Identity
- [identity_role fact list]

## User Preferences
- [preference_style fact list]

> Note: the current user's explicitly expressed intent takes priority over historical preferences
```

**Chat path reference facts** (user background knowledge, not hard constraints)

```text
# Background Knowledge From User Interactions (for reference only)

## Long-Term Goals
## Knowledge Background
## Interaction Signals Worth Noticing
```

**Master Brain path grouped facts** (for decision-making)

```text
**Identity And Preferences:**
**Long-Term Goals:**
**Knowledge Background:**
**Interaction Signals:**
**Other Facts:**
```

**Task Experience** (independently injected into Master Brain so it can avoid dispatching Sub-Agents into repeated mistakes)

```text
# Historical Task Execution Experience
> The following experience comes from Sub-Agent trial-and-error summaries in past task execution...
```

### 7.3 Summary Prompt Format

```text
## Earlier Conversation State

- [2026-04-06 10:30] Discussed the system architecture plan and decided to use the FSM engine...
  Confirmed Decisions:
    - Use YAML to define the FSM state machine
  Open Questions:
    - How should the distributed lock be implemented? (architecture)
  Evidence Slices:
    [Turn 5 - User] "We need to support multi-instance deployment..."
  Invalidated Points:
    - The initially proposed database polling plan
```

---

## 8. Database Layer (Rust Backend)

All memory data is persisted to SQLite and managed by the Rust Tauri backend. The frontend calls the following commands through IPC:

| IPC command | Purpose |
|---------|------|
| `memory_create` | Creates a memory record at any layer. |
| `memory_delete` | Deletes memory by ID. |
| `memory_update` | Updates memory content. |
| `memory_list_by_layer` | Lists memories by layer. |
| `memory_get_context` | Gets the full context of facts + summaries. |
| `memory_get_stats` | Gets memory-count statistics for each layer. |
| `memory_candidate_*` | Candidate-pool CRUD: list, create, update, and batch delete. |
| `memory_trigger_*` | Reads and writes the trigger state machine: turns, score, reset. |
| `message_get_recent` | Gets the latest N messages, used for first load. |
| `message_get_after` | Incrementally gets messages after a specified ID. |
| `message_get_batch` | Gets a batch of messages by IDs, used for summary source backtracking. |

---

## 9. UI Layer - Memory Panel

`src/components/memory/` provides a complete visual interface so users can perceive and manage memory:

| Component | Function |
|------|------|
| `MemoryPanel.tsx` | Memory panel container, integrating three view-switching tabs. |
| `ShortTermView.tsx` | Short-term memory view, showing messages currently in the buffer. |
| `SummaryView.tsx` | Summary Layer view, showing all historical summaries. |
| `FactsView.tsx` | Facts view, showing long-term facts by category. |
| `FactCard.tsx` | Single fact card, showing content, category, source, updated time, and action entry points. |
| `FactEditModal.tsx` | Fact edit dialog, supporting manual fact creation and editing. |
| `WatermarkIndicator.tsx` | Watermark indicator, visualizing current buffer usage. |

The memory system pushes the following events to the UI through the Tauri event bus:

| Event name | Trigger scenario |
|--------|---------|
| `memory:watermark_triggered` | Watermark reaches threshold and compression starts. |
| `memory:watermark_completed` | Compression completed. |
| `memory:watermark_failed` | Compression failed, such as when the LLM is unavailable. |
| `memory:facts_updated` | New facts have been written into long-term memory. |

---

## 10. Key Design Decisions

### 10.1 Why Three Layers Instead of Two?

- **Layer 1 (Short-Term Buffer)** handles conversation traffic and preserves recent context at the lowest cost.
- **Layer 2 (Summary Layer)** performs lossy compression of long-term history while preserving state intent.
- **Layer 3 (Fact Layer)** performs lossless distillation of stable, cross-session reusable user attributes.

A two-layer design would force summaries to both compress context and extract facts, creating conflicting objectives.

### 10.2 Why Not Send the Candidate Pool Directly to the LLM?

Calling an LLM every turn to extract facts is expensive, and large amounts of noise would enter long-term memory. The candidate pool plus stability verification is a **cost-quality tradeoff**:

- The rule layers, Layer 1 and Layer 2, filter more than 70% of noise without an LLM.
- Only truly stable candidates consume LLM tokens in Layer 3.

### 10.3 Why Use Embedding + Lightweight BM25/RRF for Summary Recall Instead of Full Injection?

As usage grows, the number of summaries keeps increasing. Full injection would consume a large amount of context-window space and introduce irrelevant noise. The core value of embedding recall is to **inject only historical state relevant to the current query**, not all history.

On top of that, `MemorySummaryRetriever` uses a one-shot BM25/RRF layer as lightweight correction. Strong anchors such as file names, paths, code symbols, quoted phrases, and explicit proper names can compensate for unstable embedding scenarios. BM25-only candidates matched by generic words are discarded by the gate, and fused results do not force-fill `topK`. This improves summary recall precision without importing the full Knowledge Base RAG `HybridRetriever` pipeline into the memory summary layer.

### 10.4 The Special Status of task_experience

The "trial-and-error lessons" accumulated after SA task execution, such as "On Windows, use findstr instead of grep", are objective system-level facts rather than subjective user statements. Therefore:

- They are written directly into Layer 3, mapping extraction confidence 0.9 to `importance`, and bypass candidate verification.
- They are independently rendered as `## EXECUTION_EXPERIENCE` and injected into MB, instead of being mixed into user facts.
- Similar content is automatically deduplicated and merged. Inside `saveFactV2`, semantic similarity >= 75% is considered the same fact.
- Facts are currently fully loaded into context. A fact vector index is not actively created at write time.

### 10.5 Why Do Long-Term Facts Not Use Vector Recall?

Long-term facts, including manually added user background facts, are usually few in number, concise, and valuable as stable background for the Agent's user understanding. The current implementation chooses to **fully load facts** and let Chat / MB inject them in their own partitions instead of filtering facts through vector recall.

This avoids missing user-maintained background facts because of retrieval thresholds. Fact merging is still handled by `saveFactV2` through same-category semantic similarity. When deleting facts, the UI calls the backend interface with vector cleanup to remain compatible with historical `memory_fact_*` indexes that may exist.

---

## 11. Full Data Flow

```text
User message
  |
  +--> addInteraction()
  |      |
  |      +-- Memory buffer write (ShortTermBuffer)
  |      +-- Database persistence (short_term layer)
  |      +-- Candidate scan signal (MemoryCandidateScanner)
  |      +-- Trigger signal accumulation (MemoryTriggerManager)
  |      |     +-- Semantic score reaches threshold -> processCandidates()
  |      |     +-- Fallback turn count reaches threshold -> processCandidates()
  |      +-- Watermark check (checkAndTriggerFromDatabase)
  |             +-- Watermark exceeded -> SummaryManager.generateSummary()
  |
  +--> onSessionEnd() (lifecycle strong-consistency point)
  |      +-- Detect new content -> processCandidates()
  |      +-- Watermark check
  |
  +--> processCandidates()
         +-- Layer 1: CandidateScanner.scan()
         +-- StabilityVerifier.mergeCandidatesAsync() (semantic merge)
         +-- Layer 2: StabilityVerifier.verifyBatchAsync()
         |     +-- score >= 5 -> passed, direct promotion
         |     +-- 3~5 -> semantic enhancement (SemanticAnchors) -> possible promotion
         |     +-- < 3 -> discard
         +-- Overflow check, category candidate count >= 5 -> batch promotion
         +-- Layer 3: FactExtractor.extractAndSaveFromVerified()
         +-- checkAndTriggerConsolidation() (category consolidation)

-------------------------------------------------------------
When assembling an LLM Prompt:
  +-- MemoryContextProvider.getMemoryContext()
  |     +-- Full-load facts -> Chat binding/background partitions or MB factsByCategory grouping
  |     +-- Hybrid summary recall (MemorySummaryRetriever: embedding + temporary BM25/RRF)
  |     |     -> state-summary timeline
  |     +-- Evidence Slices loading (EvidenceRetriever: query-aware turn-pair)
  +-- Inject into System Prompt
```

---

*Document generated from full source analysis of `src/services/memory/`.*
