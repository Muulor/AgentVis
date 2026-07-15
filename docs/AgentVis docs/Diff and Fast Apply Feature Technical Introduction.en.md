# Diff and Fast Apply Feature Technical Introduction

> Applicable version: current AgentVis main branch
> Last updated: 2026-06-21

---

## 1. Overview

AgentVis's **Diff & Fast Apply** system is the core bridge between AI-generated content and the file system. After a Sub-Agent completes a code-writing or modification task, the system captures the file changes, provides a Diff comparison, and preserves precise rollback capability.

1. Encode the AI's modification intent as an **XML modification protocol**
2. Locate target content in files through a four-level matching strategy
3. Generate an interactive **Diff Preview** interface that shows every change
4. After users approve changes block by block or in batch, write or keep disk content according to the current path and create **snapshot** backups

This design places file modifications into a reviewable and recoverable Diff workflow while also providing version rollback capability.

---

## 2. XML Modification Protocol

### 2.1 Protocol Format

The Fast Apply system uses a custom XML format to pass modification instructions. One modification task is wrapped by a `<modifications>` container and contains one or more `<modification>` tags:

```xml
<modifications>
  <modification>
    <file>src/components/Button.tsx</file>
    <operation>REPLACE</operation>
    <search>const oldText = "Click me";</search>
    <replace>const newText = "Submit";</replace>
    <description>Update button text</description>
  </modification>
  <modification>
    <operation>DELETE</operation>
    <search>// TODO: remove this line</search>
  </modification>
</modifications>
```

### 2.2 Operation Types

| Operation type | Description | `replace` field |
|---|---|---|
| `REPLACE` | Replace the `search` content with `replace` content. | Required |
| `INSERT_AFTER` | Insert `replace` content **after** the `search` content. | Required |
| `INSERT_BEFORE` | Insert `replace` content **before** the `search` content. | Required |
| `DELETE` | Delete the content specified by `search`. | Optional |

### 2.3 Protocol Parser (`ProtocolParser`)

`ProtocolParser` uses the browser-native `DOMParser` to parse XML and supports two usage scenarios:

- **Structured input**: the LLM/tool directly outputs a standard XML string.
- **Mixed text**: the LLM embeds an XML block in a natural-language reply, and the `extractFromText()` method extracts it with a regular expression before parsing.

The parsing process strictly validates `<operation>` values. For non-DELETE operations, a missing `<replace>` field throws `ProtocolParseError`.

---

## 3. Fast Apply Engine

### 3.1 Overall Architecture

```text
XML input
  |
  v
ProtocolParser ---> Parse into a Modification[] list
  |
  v
ContentMatcher ---> Locate the line range for each search in the file (four-level matching)
  |
  v
ModificationExecutor ---> Preview/execute replacement and generate newContent
  |
  v
DiffGenerator ---> Generate DiffResult (hunks/lines) with Myers Diff
  |
  v
diffStore / FullFileDiffViewer ---> Manage approval state and render the Diff panel
  |
  +-- SnapshotManager ---> Write snapshots (Tauri SQLite backend)
  +-- diff_records ---> Persist unfinished Diffs, active snapshots, and modification-block state
```

`FastApplyEngine` is the main class that coordinates parsing, matching, execution, Diff generation, and snapshot capabilities. It is exported as a singleton (`fastApplyEngine`). `FastApplyService` is a thin external wrapper, while `diffStore` (Zustand state management) mainly calls `preview()` plus snapshot and rollback-related APIs.

### 3.2 Preview Flow (`preview`)

The `preview()` method is **read-only**. It does not create snapshots or write to disk. It returns a `BatchApplyResult` with `pending` / `failed` states for filling the Diff panel:

```text
for each modification:
  1. ContentMatcher.match(content, modification.search)
  2. If matching succeeds:
       ModificationExecutor.previewModification() -> generate old/newContent
       DiffGenerator.generateDiff()               -> generate DiffResult
       status = 'pending'
  3. If matching fails:
       status = 'failed' (or 'manual' when manual handling is required)
```

> **Note**: the current `preview()` implementation always uses an independent `ContentMatcher` with **semantic matching disabled** (`enableSemanticMatch: false`). This is because the UI preview path mostly comes from `diffToXml` or whole-file REPLACE XML, where semantic fallback brings limited benefit. Semantic matching also calls the Embedding API for failed blocks, which can noticeably block the Diff panel.

---

## 4. ContentMatcher Four-Level Matching Strategy

`ContentMatcher` is the core module of the whole system. It implements progressive matching from exact to fuzzy, ensuring that small deviations in AI-generated content do not immediately cause matching failure.

### 4.1 Matching Flow

```text
Input: content (file content), search (fragment to find)
  |
  +-- Step 1: Exact matching (exact)
  |     First try indexOf(search), then retry after trim() if it fails
  |     Then try line-by-line trimmed sliding-window matching if needed
  |         v failed
  +-- Step 2: Normalized matching (normalized)
  |     Activated only when content contains box-drawing characters (|, -, +, and similar)
  |     Map special characters to ASCII equivalents before exact matching
  |         v failed
  +-- Step 3: Fuzzy matching (fuzzy)
  |     Levenshtein edit-distance similarity threshold >= 0.8
  |     Traverse with a sliding window and choose the highest-similarity location
  |     Skip when search exceeds 2000 characters to prevent O(n^2) blocking
  |         v failed
  +-- Step 4: Semantic matching (semantic)
        Call EmbeddingService, vector cosine similarity threshold >= 0.85
        Use stepped sampling to reduce API calls (step = max(1, searchLines / 2))
        Degrade gracefully on network errors without blocking the flow
            v all failed
        Return matchLevel = 'manual', status = 'failed'
```

### 4.2 CRLF Compatibility

After XML is parsed by `DOMParser`, `\r\n` is normalized to `\n`, while file content may preserve Windows line endings. `ContentMatcher` handles this as follows:

- Matching runs on an LF-normalized copy to avoid `indexOf` failures.
- After a match succeeds, the match is mapped back to the original content by **line number**, extracting `matchedContent` with the original line separators.
- Replacement execution prefers `startOffset` / `matchLength` for character-level replacement, preserving original line endings in untouched regions. The replacement text itself keeps the line endings from the XML/new content. If execution falls back to line-number assembly, the joined result uses `\n`.

### 4.3 Match Result (`MatchResult`)

Each match returns:

| Field | Meaning |
|---|---|
| `success` | Whether matching succeeded. |
| `matchLevel` | `exact` / `normalized` / `fuzzy` / `semantic` / `manual`. |
| `confidence` | Confidence score (0-1): exact = 1.0, normalized = 0.95, fuzzy/semantic = actual calculated value. |
| `startLine` / `endLine` | Matched line-number range (1-indexed), used for later Diff reconstruction. |
| `matchedContent` | Actual matched content, including original line separators. |

---

## 5. Myers Diff Algorithm

### 5.1 Algorithm Introduction

`MyersDiff.ts` implements Eugene W. Myers's classic 1986 algorithm, which is also the underlying algorithm used by `git diff`. Core properties:

- **Time complexity O(ND)**, where N is the sum of line counts in the two files and D is the edit distance.
- For typical code edits (D << N), it performs much better than LCS's O(NM).
- Guarantees the **minimum edit distance** (shortest edit script).
- Pure function, no side effects, and zero external dependencies.

### 5.2 How It Works

The diff problem is modeled as shortest-path search on an **edit graph**:

1. **Forward search**: for each edit distance d (0, 1, 2, ...), advance as far as possible down and right on each diagonal k (matching lines are free moves).
2. **Save trace**: record the farthest-reaching position snapshot for each d.
3. **Backtrack**: trace backward from the endpoint (n, m) to reconstruct the edit-operation sequence (`add` / `remove` / `context`).

The output format is `EditOp[]`, compatible with the `DiffLine` type and directly usable by `DiffGenerator` and `diffStore`.

### 5.3 Usage Scenarios

Myers Diff has two core uses in the system:

| Scenario | Call location | Description |
|---|---|---|
| Diff preview generation | `DiffGenerator.generateDiff()` | Converts search/replace into visual hunks. |
| Accept/reject content reconstruction | `diffStore.rebuildByMyersDiff()` | Precisely reconstructs file content when the user rejects some modifications. |

---

## 6. DiffToXml Converter

### 6.1 Design Purpose

`DiffToXmlConverter` solves the problem of reusing the Diff approval panel after `file_write` has already written content. A Sub-Agent may have written the file to disk, but the UI still needs an XML protocol that can be parsed by the Fast Apply pipeline so the user can view, accept, reject, or roll back changes.

**Data flow**:

```text
Original content + new LLM-written content
  -> DiffGenerator.generateDiff()       -> DiffResult (hunks/lines)
  -> DiffToXmlConverter.diffToXml()     -> XML modification protocol
  -> FastApplyEngine.preview()          -> ModificationApplyResult[]
  -> FullFileDiffViewer                 -> Interactive Diff panel
```

### 6.2 Change Block Extraction

The converter traverses the lines in each hunk and groups consecutive `remove` / `add` lines into **change blocks**, using context lines as separators:

```text
[context][remove][add][context][add][add][context]
  -------------------------------------------------
         [REPLACE block]      [INSERT block]
```

### 6.3 Operation Type Inference

| Change block content | Generated operation |
|---|---|
| remove + add | `REPLACE` (`search` = removed lines, `replace` = inserted lines) |
| remove only | `DELETE` |
| add only (has preceding context) | `REPLACE` (`search` = preceding context anchor, `replace` = anchor + inserted lines) |
| add only (file header) | `INSERT_BEFORE` (`search` = following context line) |

For pure insertion blocks, the current converter prefers up to 5 preceding context lines as the anchor and expresses the insertion as `REPLACE(anchor -> anchor + inserted)`. This reuses the replacement path and reduces misalignment caused by repeated single-line anchors, such as many `}`, comments, or CSS selectors. Only when no preceding context exists (insertion at the file header) does it use following context to generate `INSERT_BEFORE`.

### 6.4 Whole-File Overwrite Optimization

Several current paths use `generateWholeFileReplaceXml()` to generate a **single whole-file REPLACE**, replacing multiple fine-grained modification blocks:

- `file_write` full mode when the difference ratio is higher than `OVERWRITE_THRESHOLD = 0.7`, or when the ratio is in the 0.3-0.7 middle range and overwrite is selected.
- `diffStore.loadModifications()` when any `MATCH FAILED` is detected and `preAppliedContent` exists for degradation.
- When a Sub-Agent modifies the same file multiple times, `SubAgentDispatcher` rebuilds a whole-file REPLACE from the first original content plus the latest content, avoiding Myers alignment drift in files with repeated content.

Advantages:

- `preview()` needs only one match. For non-empty original files, the whole-file `search` usually matches exactly.
- `FullFileDiffBuilder` performs Myers Diff inside that modification block and shows precise line-level changes.

The tradeoff is that after degradation there is usually only 1 modification block left, so users can no longer approve the original fine-grained blocks one by one. However, the panel display becomes more predictable than a partially failed match.

---

## 7. Diff Visualization Interface

### 7.1 FullFileDiffViewer Component

`FullFileDiffViewer` is the full-document Diff view. It displays changes by **complete file**, embeds modification blocks inside the file, and allows unchanged regions to collapse:

```text
+---------------------------------+
| Button.tsx              +5 -3   |  <- File header (add/remove stats)
+---------------------------------+
| 142 |  const label = "Old";     |  <- Collapsed context line (click to expand)
| ... |  ... 38 lines hidden ...  |
+---------------------------------+
| 180 - const label = "Old";      |  <- Modification block (accept/reject individually)
| 180 + const label = "New";      |
|              [Accept][Reject]   |
+---------------------------------+
| ... more context lines ...      |
+---------------------------------+
|     [Accept All] [Reject All]   |  <- Bottom action bar
|     Pending: 3 | Failed: 0      |
+---------------------------------+
```

During rendering, the component gets the merged line list (`FullFileDiffLine[]`) from `FullFileDiffBuilder.buildFullFileDiff()` and renders three item types:

| Type | Component | Description |
|---|---|---|
| `context-line` | `DiffLine` | Unchanged context line with line number. |
| `diff-block` | `DiffBlock` | Change block with accept/reject buttons. |
| `collapsed` | `CollapsedLines` | Placeholder for collapsed context lines; click to expand. |

The current component also contains two layers of performance protection:

- When either side of a single whole-file REPLACE exceeds 10,000 lines and added/removed changes exceed 1,000 lines, `FullFileDiffViewer` shows a large Diff summary instead of rendering the full line list.
- Normal Diff line lists are rendered with virtual scrolling to avoid mounting all DOM nodes for large-file Diffs at once.

### 7.2 Multi-File Support

Within the same Agent context (`contextId`), multiple files can be in Diff mode at the same time. `diffStore` maintains independent approval state, Undo/Redo stacks, and snapshot lists for each file through `fileEntries: Map<string, FileDiffEntry>`. When switching the active file, it saves the current file state back to `fileEntries` and then loads the target file state into the top-level fields.

---

## 8. Snapshot System

### 8.1 Snapshot Creation Timing

| Timing | Description |
|---|---|
| First Diff load | Create `Original file version` (only one original-version semantic snapshot is kept for the same document). |
| After Sub-Agent-written content exists | If `preAppliedContent` differs from the original content, create `Post-write version`. |
| After the user accepts one modification | Record the accepted file state and save modification-block state at that time. |
| After the user rejects one modification | Rebuild content to restore that block's original text, write it back to disk, and create a snapshot. |
| User accepts all | Create the final applied-result snapshot. |
| User rejects all | Restore original content and create a snapshot. |
| User rolls back to a historical version | Update the currently active snapshot and refresh Diff state from the snapshot content. |

`preview()` itself is read-only and does not create snapshots. Snapshots are stored in the Rust backend's SQLite database through Tauri Command calls. By default, each document keeps the latest **10** snapshots, and the oldest ones are automatically cleaned up when the limit is exceeded.

### 8.2 Snapshot Data Structure

In addition to the content itself, each snapshot carries `modificationStatuses` (a modification-block approval-state mapping):

```typescript
interface DocumentSnapshot {
    id: string;
    documentId: string;
    content: string;
    timestamp: Date;
    description: string;
    modificationStatuses?: Record<string, string>; // index -> 'pending'|'applied'|'rejected'|'failed'
}
```

This ensures that when rolling back to a historical snapshot, the Diff panel can **precisely restore** the approval state of each modification block at that time, without re-inferring it.

In addition to the snapshot table, `diff_records` also stores:

- `xml_modification`: used to restore unfinished Diffs after restart.
- `active_snapshot_id`: records the snapshot version currently being viewed.
- `modification_statuses`: JSON for modification-block state after partial approval. During restore, it has lower priority than the active snapshot's own `modificationStatusesJson`.

### 8.3 Snapshot Panel (`SnapshotHistory`)

The `SnapshotHistory` component displays historical snapshots as a timeline and supports:

- Clicking to view the content of any version.
- Rolling back to a historical version while rebuilding Diff panel state.
- Deleting snapshots that are no longer needed.

---

## 9. diffStore State Management

### 9.1 Isolation Strategy

`diffStore` (Zustand store) isolates Diff state by `contextId` (Agent ID or Hub ID), using `Map<string, ContextDiffState>`. This matches `chatStore`'s isolation strategy. When switching Agents, each Agent's Diff state remains fully independent and does not interfere with the others.

### 9.2 Undo/Redo Mechanism

Every accept or reject operation pushes a `HistoryEntry` onto `undoStack`, recording the complete content and modification-list state before and after the operation:

```text
undoStack: [entry1, entry2, entry3]  <- stack top (latest operation)
redoStack: []                        <- after undo, entry3 moves into redoStack
```

The Undo/Redo stacks have a maximum depth of **50 entries** to prevent unbounded memory growth.

### 9.3 Content Reconstruction Algorithm

When the user rejects a modification block, the system needs to restore the disk file to a state where "other blocks are applied, but the rejected block is not included." Reconstruction has two paths:

**Main path (matchResult reconstruction)**: when all modification blocks have valid `startLine` / `endLine`, traverse the original content by line range directly. `rejected` blocks keep original lines, while all other blocks output their `replace` content.

**Fallback path (Myers Diff reconstruction)**: when `matchResult` is unreliable (LLM-written search/replace may be imprecise), run Myers Diff on the original content and LLM-written content. Then allocate 1:N change blocks in modification order, avoiding repeated association of multiple change blocks with the same modification, and finally selectively keep or restore each block's content.

### 9.4 Persistence

Diff records (`diff_records` table) and snapshots can be restored after app restart:

- On startup or Agent switch, `loadPersistedDiffs()` reads `pending` Diff records from the database.
- If `active_snapshot_id` exists, that snapshot content is read first as the restore target.
- `activeSnapshot.modificationStatusesJson` is preferred for exact approval-state restoration; `diff_records.modification_statuses` is used next.
- If no persisted state exists and disk content equals `preAppliedContent`, keep all modifications `pending` to avoid misclassifying a just-written Sub-Agent change as applied.
- If no persisted state exists and content has diverged from `preAppliedContent`, call `inferModificationStatus()` to heuristically infer each block's state from the current file content.
- If the target file no longer exists during restore, mark the corresponding `diff_record` as `reverted` and skip the stale Diff.
- After the file list successfully deletes a file or directory at runtime, invalidate matching in-memory Diffs by physical path immediately and mark matching `pending` records as `reverted`; directory deletion matches only descendants within the path boundary.
- Deletion also advances the matching `loadModifications` generation and keeps a bounded deleted-path marker. Even when a Diff callback starts only after deletion, the store rereads the disk and drops the callback if the target is absent or now belongs to another write. Generation is rechecked before committing asynchronous preview, snapshot, and persistence work, and persistent cleanup is limited to records created before the deletion boundary, preventing late results and rapid same-path recreation from contaminating each other. The restore-time existence check remains the fallback.
- A history rollback first uniquely matches the target snapshot content to a source `diff_record` for the same document and restores that round's `originalContent + XML`. If the source is unavailable or ambiguous, it generates a whole-file projection from the adjacent snapshot, following the History panel's “previous version → current version” semantics.
- The rollback projection atomically updates content, Diff basis, XML, `matchResult`, review states, and `activeSnapshotId`, then synchronizes the matching `fileEntries` entry. Generated projections never reuse status indexes from an older XML: applicable blocks reset to `pending`, failed matches remain `failed`, and Undo/Redo preserves and restores the complete projection. A manual rollback writes to disk only after preview succeeds. Rollback/Undo/Redo does not start while a real-time Diff for the same file is still loading; if a newer load takes over during disk writing, compensation uses its final target after disk correction or restoration rebuild. If restart restoration cannot rebuild a trusted preview, it closes that file's Diff instead of showing misaligned output.
- `active_snapshot_id` updates are scoped by `contextId + documentId`; restart restoration also verifies snapshot ownership so legacy cross-file associations cannot leak another file's Diff basis.

---

## 10. Trigger Path Comparison

In the current code, `file_write` is the unified file tool and has replaced the earlier write/edit split. `AgentService` still keeps compatible checks for `file_edit`-type Diff data, but the built-in tool registry no longer registers a standalone EditTool.

| | **file_write patch/merge path** | **file_write full/overwrite path** | **Compatible XML path** |
|---|---|---|---|
| Data source | LLM provides `patches` or small-range full-content changes. | LLM provides complete file content. | External/historical path directly provides XML modification protocol. |
| XML generation | `DiffToXmlConverter.diffToXml()`; may be converted to whole-file REPLACE when returned from Sub-Agent to UI. | `generateWholeFileReplaceXml()`; normal mode can first return an overwrite preview. | Already XML; passed directly to `ProtocolParser`. |
| Main matching strategy | UI `preview()` disables semantic matching; execution merge can rematch according to engine config. | Whole-file `search` mainly uses exact matching; when it fails, fine-grained recovery is unavailable. | Determined by the caller; current UI preview also disables semantic matching. |
| Degradation strategy | Degrade to overwrite when matching is abnormal, no match exists, or result differs from target full text; the UI degrades to whole-file REPLACE when it finds MATCH FAILED. | Already whole-file REPLACE. | Parse failure or match failure enters `failed` / `manual` state. |
| User experience | Fine-grained approval when successful; after failed degradation, becomes single-block approval. | Usually single-block approval, but `FullFileDiffBuilder` still shows line-level changes internally. | Depends on XML granularity. |

---

## 11. Key File Index

| File | Responsibility |
|---|---|
| [`services/fast-apply/types.ts`](../../src/services/fast-apply/types.ts) | All type definitions (operation types, match results, Diff, snapshots, Patch, etc.). |
| [`services/fast-apply/FastApplyEngine.ts`](../../src/services/fast-apply/FastApplyEngine.ts) | Main engine that coordinates parsing, matching, execution, Diff, and snapshot capabilities; exports singleton `fastApplyEngine`. |
| [`services/fast-apply/FastApplyService.ts`](../../src/services/fast-apply/FastApplyService.ts) | UI-layer wrapper containing `generateEditInstructions()`, Diff generation, and snapshot-management APIs. |
| [`services/fast-apply/ProtocolParser.ts`](../../src/services/fast-apply/ProtocolParser.ts) | XML protocol parsing, with support for batch and mixed-text extraction. |
| [`services/fast-apply/ContentMatcher.ts`](../../src/services/fast-apply/ContentMatcher.ts) | Four-level matching strategy (exact -> normalized -> fuzzy -> semantic). |
| [`services/fast-apply/MyersDiff.ts`](../../src/services/fast-apply/MyersDiff.ts) | O(ND) Myers Diff algorithm implemented as pure functions. |
| [`services/fast-apply/DiffGenerator.ts`](../../src/services/fast-apply/DiffGenerator.ts) | Organizes Myers Diff output into hunks with context. |
| [`services/fast-apply/DiffToXmlConverter.ts`](../../src/services/fast-apply/DiffToXmlConverter.ts) | Converts `DiffResult` to the XML modification protocol and provides whole-file REPLACE XML. |
| [`services/fast-apply/SnapshotManager.ts`](../../src/services/fast-apply/SnapshotManager.ts) | Snapshot CRUD through Tauri Command interactions with the Rust SQLite backend. |
| [`services/fast-apply/ModificationExecutor.ts`](../../src/services/fast-apply/ModificationExecutor.ts) | Executes actual string replacement/insertion/deletion based on `matchResult`. |
| [`services/fast-apply/FullFileDiffBuilder.ts`](../../src/services/fast-apply/FullFileDiffBuilder.ts) | Merges multiple `ModificationApplyResult` values into full-file Diff render data. |
| [`stores/diffStore.ts`](../../src/stores/diffStore.ts) | Zustand state management, including content reconstruction, persistence, Undo/Redo, and multi-file/multi-context isolation. |
| [`components/diff/FullFileDiffViewer.tsx`](../../src/components/diff/FullFileDiffViewer.tsx) | Main full-file Diff view component, supporting collapse/expand, virtual scrolling, large Diff summaries, and block-by-block approval. |
| [`components/diff/SnapshotHistory.tsx`](../../src/components/diff/SnapshotHistory.tsx) | Snapshot history panel with timeline display and rollback operations. |
