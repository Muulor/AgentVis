# AgentVis RAG Mechanism Deep Dive

> Applicable version: current code implementation  
> Module paths: `src/services/rag/`, `src/types/rag.ts`  
> Related pipelines: `src/services/memory/MemorySummaryRetriever.ts`, `src/services/memory/MemoryVectorIndex.ts`, `src/services/memory/MemoryContextProvider.ts`
> Naming note: “Task mode” in the UI maps to the internal mode value and path `planning`; existing code identifiers remain unchanged.

---

## Overview

In AgentVis, RAG (Retrieval-Augmented Generation) mainly refers to **Agent Knowledge Base retrieval**: when the user sends a request, the system recalls relevant snippets from the current Agent's Knowledge Base files, formats them, and injects them into the Prompt as external material for model reasoning.

The current Knowledge Base RAG uses **Hybrid Search + RRF fusion**:

```text
Raw Query ---------------------> Embedding Top 30 --+
                                                    +--> RRF fusion -> optional Rerank -> Parent aggregation -> context allocation -> Final Relevance Gate -> Parent Context Restore -> Prompt injection
Query Preprocess -> enhanced BM25 query/fragments -> BM25 Top 30 ------+
```

The recommended configuration uses SiliconFlow `BAAI/bge-m3` and `BAAI/bge-reranker-v2-m3`. Users can instead configure separate Embedding and Reranker services, or disable reranking. Initial recall still relies on query preprocessing, BM25 metadata enhancement, Document Overview synthetic chunks, and RRF fusion to preserve recall. The reranker performs second-stage semantic reranking and low-score filtering over the RRF candidate pool. When reranking is disabled, fails, times out, or returns abnormal data, the system degrades to the original RRF + Gate pipeline.

The following boundaries are important:

- **Knowledge Base RAG**: handled by `RagService` / `HybridRetriever`; retrieves files from the Agent's Knowledge Base.
- **Memory summary recall**: handled by `MemoryContextProvider` / `MemorySummaryRetriever` / `MemoryVectorIndex`; reuses `EmbeddingService` and `VectorStore` at the lower level, and uses a one-shot `BM25Index` for summary lexical recall and RRF correction. It does not use `RagService`, `HybridRetriever`, or the Knowledge Base BM25 lifecycle.
- **Memory fact injection**: fact memories are fully loaded through `memory_get_context` and injected by category. They do not use BM25 and do not use summary hybrid recall.

---

## Architecture Overview

```text
src/services/rag/
+-- RagService.ts              # Main RAG service singleton; unified indexing, retrieval, and formatting entry
+-- DocumentChunker.ts         # Document chunker; Markdown supports Parent-Child, text/code use flat chunks
+-- DocumentOverviewBuilder.ts # Synthetic document overview chunks for overview-style queries
+-- EmbeddingService.ts        # Profile-aware embedding service; SiliconFlow, custom OpenAI-compatible, or native Gemini
+-- VectorStore.ts             # Vector storage IPC wrapper + chunk LRU cache
+-- BM25Index.ts               # Pure in-memory BM25 keyword index with incremental IDF
+-- RagQueryPreprocessor.ts    # Query preprocessing, BM25 metadata enhancement, compact embedding metadata enhancement
+-- HybridRetriever.ts         # Hybrid retriever: Embedding + BM25 + RRF + context allocation
+-- RagConnectionConfig.ts     # RAG routing, validation, and Embedding profile definition
+-- RagConnectionService.ts    # Connection tests, activation, and index-migration orchestration
+-- RagIndexRebuildService.ts  # Per-Agent Embedding index rebuilds
+-- RerankService.ts           # Recommended or custom second-stage reranking service
+-- ContextProvider.ts         # Retrieval result formatter
+-- LruCache.ts                # Generic LRU cache utility
```

The Rust side mainly maps to:

```text
src-tauri/src/commands/rag.rs             # rag_index_chunk / rag_search / rag_list_chunks IPC
src-tauri/src/commands/cloud_embedding.rs # SiliconFlow, custom OpenAI / Reranker, native Gemini, and credential commands
src-tauri/src/db/vector_repo.rs           # chunk_embeddings table read/write and cosine search
```

---

## Core Components

### 1. DocumentChunker - Document Chunker

**Source file**: `DocumentChunker.ts`

`DocumentChunker` splits raw documents into chunks suitable for indexing. Two details matter in the current implementation:

- **Markdown** uses Parent-Child chunking: H1~H6 headings are parsed into sections, section content becomes Parent chunks, and section internals are further grouped by sentence into Child chunks.
- **Non-Markdown** content, such as plain text, code, and JSON, uses flat chunking: no Parent chunks are generated, `parentChunks` is empty, and `childChunks` are the actual flat chunks.

Key parameters:

| Parameter                              | Current value  | Description                                                      |
| -------------------------------------- | -------------- | ---------------------------------------------------------------- |
| `PARENT_MIN_SIZE`                      | 200 characters | Markdown sections shorter than this are not recorded as Parents. |
| `CHILD_SIZE`                           | 500 characters | Target size for Markdown Child chunks.                           |
| `CHILD_OVERLAP`                        | 50 characters  | Overlap window between Child chunks.                             |
| `DEFAULT_CHUNKING_CONFIG.chunkSize`    | 500 characters | Target size for text / flat chunks.                              |
| `DEFAULT_CHUNKING_CONFIG.minChunkSize` | 100 characters | Minimum chunk size.                                              |

Markdown Child chunks carry metadata such as `parentChunkId` and `sectionPath`. Currently, `RagService.indexDocument()` actually writes **Document Overview + Child chunks** into the vector database. Parent chunks themselves are not persisted as regular vector entries. When continuous context is needed after retrieval, `HybridRetriever` uses sibling chunks from the same Parent in cache for `Parent Context Restore`.

---

### 2. DocumentOverviewBuilder - Synthetic Document Overview Chunk

**Source file**: `DocumentOverviewBuilder.ts`

Each time a document is indexed, `RagService` tries to create a synthetic Document Overview chunk. Its characteristics are:

- `chunkIndex = -1`
- `heading = "Document Overview"`
- `metadata.isDocumentOverview = true`
- Content includes the file name, title, chunk count, section count, up to 16 Markdown headings, and up to 900 characters from the opening body text.

This synthetic chunk enters both the vector database and BM25 just like a normal Child chunk. It mainly serves overview-style questions such as "what features does this have", "introduce the capabilities", and "what features", avoiding cases where an overview query only recalls a tiny detail paragraph.

In `HybridRetriever`, overview-style queries receive additional strategies:

- Document Overview embedding RRF contribution weight is `1.2`.
- When embedding candidates exist, ordinary BM25-only RRF contribution is reduced to `0.35`.
- The selection pool expands to `finalTopK * 4`.
- After successful rerank, extra same-source multi-hit rewards are downweighted so several slightly lower-scoring detail chunks do not outrank the single most relevant source.
- For broad overview queries, if scores are close within the same source, Document Overview is injected first, then detail chunks are backfilled.
- One snippet per source is preferred first, then backfilled, improving multi-source coverage.
- After source allocation for a broad overview query, final output is sorted again by rerank score so the most relevant overview material is injected first.
- Broad overview queries skip Parent Context Restore to avoid one long section consuming the entire budget.

---

### 3. EmbeddingService - Embedding Service

**Source file**: `EmbeddingService.ts`  
**Backend command**: `cloud_embedding_encode`

The “RAG model connections” setting selects the Embedding route:

1. **Recommended mode (default)**: fixed `https://api.siliconflow.cn/v1/embeddings` endpoint and `BAAI/bge-m3` model.
2. **Custom OpenAI mode**: a complete OpenAI Embeddings-compatible endpoint, model ID, and authentication mode supplied by the user.
3. **Native Google Gemini mode**: the network target is fixed to the Gemini Developer API `v1beta` endpoint. Text-only requests support the stable `gemini-embedding-2` and `gemini-embedding-001` models at 768, 1536, or 3072 dimensions. Vertex AI, OAuth, custom Gemini proxies, multimodal input, and asynchronous Batch jobs are intentionally out of scope.

The Gitee AI fallback has been removed. AgentVis never switches automatically between different Embedding models, which prevents vectors from distinct semantic spaces from being mixed. If the network or Embedding service is unavailable, each consumer applies its own degradation behavior: Knowledge Base search retains local BM25 recall, while memory and semantic-comparison paths skip the unavailable vector capability.

Each `encode` / `encodeBatch` operation captures one immutable route snapshot. Cache keys and database rows carry an Embedding profile. The existing OpenAI-compatible profile remains derived from protocol, normalized endpoint, and model ID for backward compatibility. A native Gemini profile separately includes the fixed protocol/API version, model, output dimension, and task-strategy version. Before applying a user-selected mode, protocol, endpoint, model, or dimension change, Settings tests the target connection and confirms possible API usage and content transfer. After confirmation, the prompt closes immediately while the new profile is activated and existing vectors are rebuilt per Agent in the background. Gemini task mapping is not user-configurable: it is an internal, versioned profile strategy. An application update that changes the strategy version therefore creates a new profile, and the next index check or Embedding-profile activation rebuilds its vectors rather than mixing incompatible spaces. If part of a rebuild fails, the new profile remains active, old vectors stay filtered, unmigrated Agents temporarily fall back to BM25, and the rebuild can be retried idempotently.

Normal requests for the same Embedding profile are serialized within one `EmbeddingService`, while a rate-limit cooldown does not block another profile. Gemini request starts remain spaced by at least one second. OpenAI-compatible routes have no hard-coded baseline rate and instead adapt after 429 responses, retryable 5xx responses, and transient network timeouts. Both protocols use exponential backoff with jitter; OpenAI-compatible routes make at most six retries to span a common one-minute limit window and prefer a parsed, bounded `Retry-After` hint when present. Connection tests remain single-attempt so they report the current state promptly. RPM, TPM, and daily limits are properties of the user's provider and account; total credits are not treated as remaining per-minute capacity, and an exhausted daily allowance still requires waiting for quota recovery. Rebuilds persist an atomic checkpoint after every successful 25-chunk provider batch, so a later failure retries only unfinished chunks. Agent Knowledge Base settings persist only file paths whose indexing completed and reconcile historical paths against local document IDs; failed files remain visibly retryable instead of being shown as successfully indexed.

OpenAI-compatible Embedding, native Gemini Embeddings, and Reranker credentials use separate purpose-level slots, so testing or switching protocols cannot overwrite another protocol's key. OpenAI-compatible Embedding and Reranker records are also bound to the endpoint origin: a model or API-path change on the same origin can reuse the key, while an origin change requires saving a new key and the backend refuses to send the old one. Legacy unbound custom credentials must be saved again once. Clicking Save beside the key field writes immediately to the system credential manager; Save and apply only persists non-sensitive endpoint, model, and dimension settings. Remote custom endpoints require HTTPS, with HTTP allowed only for loopback addresses. Never put secrets in the URL or query string. The native Gemini route instead pins the exact Google host, constructs the path from an allowlisted model ID, sends the key only through `x-goog-api-key`, and follows no redirects. Reranking explicitly supports Jina/Cohere and Voyage protocol shapes; it is not inferred from either Embedding protocol.

Gemini purpose handling is model-specific. For `gemini-embedding-001`, document, query/test, and generic similarity requests map to `RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY`, and `SEMANTIC_SIMILARITY`. `gemini-embedding-2` does not accept `taskType`, so AgentVis applies Google's documented query, document, or sentence-similarity text prefix. Purpose stays out of the persisted profile because query and document vectors must remain comparable; the profile carries the strategy version instead. Switching between the two models always rebuilds indexes because their vector spaces are incompatible.

Google states that content submitted through unpaid Gemini API services may be used to improve its products and may be reviewed by humans. Since this route receives Knowledge Base chunks, memory, skill descriptions, and semantic-comparison text, users must not submit sensitive, confidential, or personal data through the unpaid tier. Current pricing, region availability, quotas, and terms are external service properties and are not promised by AgentVis.

Current code comments mark `bge-m3` as 1024-dimensional. `EmbeddingService` also provides:

- LRU cache: up to 1000 embeddings.
- Batch calls: up to 25 items per batch.
- Embedding scheduling: serialized per profile; Gemini keeps one-second request spacing, while OpenAI-compatible routes back off adaptively after throttling.
- Layered timeout: a 15-second Rust network hard timeout plus an 18-second renderer IPC fallback, preventing long blocking when the network is disconnected.
- Cosine similarity calculation.
- `isSemanticallySimilar()`: default threshold `0.75`; returns `false` on failure.

During indexing, the embedding input is not raw `chunk.content`. It is compact metadata-enhanced text built by `buildEmbeddingIndexText()`:

```text
Document: <fileName + a small number of expansion terms>
Section: <sectionPath>
Heading: <heading>

<chunk.content>
```

Full paths do not enter the embedding input to reduce path noise. The original chunk content is still stored as-is and injected into the LLM.

---

### 4. VectorStore - Vector Storage and Cache

**Source file**: `VectorStore.ts`  
**Rust implementation**: `src-tauri/src/db/vector_repo.rs`

`VectorStore` is the TypeScript-side IPC wrapper. On the Rust side, data is currently stored in the SQLite table `chunk_embeddings`; embeddings are stored as f32 little-endian BLOBs. During retrieval, Rust reads candidate chunks, computes cosine similarity, sorts by score descending, and truncates.

In other words, the current main pipeline is not sqlite-vec virtual-table nearest-neighbor search. `vector_metadata` is still retained for compatibility with the old table schema. Code comments mentioning sqlite-vec should be understood as historical / future extension notes.

Main IPC commands:

| Command                             | Function                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `rag_index_chunk`                   | Inserts chunk + embedding.                                                     |
| `rag_search`                        | Cosine similarity search, with optional `document_id_prefix`.                  |
| `rag_list_chunks`                   | Lists persisted chunks for rebuilding BM25 and warming cache.                  |
| `rag_delete_by_agent`               | Clears all vectors for an Agent.                                               |
| `rag_delete_by_document`            | Deletes vectors for a single documentId.                                       |
| `rag_get_status`                    | Queries index statistics.                                                      |
| `rag_list_document_ids`             | Lists all indexed documentIds under an Agent for reconciliation / diagnostics. |
| `rag_list_vector_agent_ids`         | Lists Agents with persisted vectors for profile-migration discovery.           |
| `rag_batch_update_chunk_embeddings` | Updates vectors, dimensions, and profiles in one per-Agent transaction.        |

`VectorStore` also maintains a chunk LRU cache of up to 2000 entries:

- New indexing writes through `insert()` into cache.
- `listChunks()` pulls chunks from SQLite and warms cache.
- After BM25 hits a chunk id, the full chunk is read back from this cache.
- Parent Context Restore uses `getCachedChunksByParent()` to find sibling chunks with the same Parent.

---

### 5. BM25Index - Keyword Index

**Source file**: `BM25Index.ts`

BM25 runs in renderer memory and is not persisted. It handles keyword recall, especially for file names, paths, section names, code symbols, and other cases where embedding may be unstable.

Algorithm core:

```text
BM25 score = sum IDF(t) * TF_norm(t, d)

IDF(t) = log((N - df + 0.5) / (df + 0.5) + 1)
TF_norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))

k1 = 1.2
b = 0.75
```

Tokenization strategy:

- English: extracts English / numeric tokens, filters English stop words, and removes words shorter than 2 characters.
- Chinese: generates bigrams from continuous Chinese spans and also keeps complete short phrases of 2~4 characters.

BM25 supports incremental IDF:

- `addDocument()` only updates terms that appear in the new document.
- `removeDocument()` / `removeByDocumentId()` rolls back old document term frequencies.
- `clearAgent()` clears the in-memory index for an Agent.

Because BM25 is not persisted, after the app / renderer restarts, `RagService.retrieve()` calls `ensureBm25Index()` before the first hybrid retrieval and restores Knowledge Base BM25 entries from SQLite through `rag_list_chunks`. During restoration, internal memory vectors carrying `metadata.memoryType` / `metadata.memoryId` are skipped.

---

### 6. RagQueryPreprocessor - Query and Index Text Enhancement

**Source file**: `RagQueryPreprocessor.ts`

It performs three kinds of work:

1. **Query preprocessing**: extracts symbols such as file names, paths, PascalCase / camelCase / snake_case, and quoted phrases, then appends them to the BM25 query.
2. **Multi-fragment BM25**: splits multi-line or multi-sentence queries into up to 4 fragments, runs BM25 retrieval for each, and merges the results.
3. **Index text enhancement**:
   - `buildBm25IndexText()` concatenates `fileName`, `filePath`, `sectionPath`, `heading`, and body text for BM25.
   - `buildEmbeddingIndexText()` adds only compact metadata such as file name, section path, and heading to the embedding input.

Important constraints:

- Query preprocess only enhances BM25. Embedding search always uses the raw user query.
- Brand compounds such as `AgentVis` are not split into overly broad `agent` / `vis`.
- Broad overview queries append aliases such as feature, function, capability, features, capabilities, and overview to improve overview recall.

---

### 7. HybridRetriever - Hybrid Retriever

**Source file**: `HybridRetriever.ts`

Main flow:

```text
Step 1: Query Preprocess             Generate enhanced BM25 query and fragments
Step 2: Embedding vector retrieval   Raw query, Top 30
Step 3: BM25 keyword retrieval       Enhanced query Top 30 + fragments Top 10
Step 4: RRF fusion                   Default rrfTopK = 20
Step 5: Optional Rerank              RRF Top20 enters the configured Reranker; disabled or failed calls degrade automatically
Step 6: Parent aggregation           Aggregate by parentChunkId / chunk.id
Step 7: Same-source-first sorting     Source score mainly uses best Parent, with small same-source reward
Step 8: Context allocation            Focused expands continuously; broad balances main and auxiliary sources
Step 9: Memory fact filtering         Hybrid internally excludes documentIds starting with memory_fact_
Step 10: Embedding threshold filter   Requires >= 0.3 when embeddingScore exists; pure BM25 hits are exempt
Step 11: Final Relevance Gate         Strong rerank/embedding relevance is kept directly; cross-language semantic evidence can bypass lexical anchors; other gray-zone or BM25-only candidates must have valid lexical anchors
Step 12: Parent Context Restore       Non-broad overview queries can expand sibling chunks from the same Parent
```

RRF algorithm:

```text
RRF_score(d) = sum weight_i / (k + rank_i(d))
k = 60
```

Default configuration:

| Parameter                       | Value                                                      |
| ------------------------------- | ---------------------------------------------------------- |
| `embeddingTopK`                 | 30                                                         |
| `bm25TopK`                      | 30                                                         |
| `rrfTopK`                       | 20                                                         |
| `finalTopK`                     | 4                                                          |
| `rrfK`                          | 60                                                         |
| `embeddingThreshold`            | 0.3                                                        |
| `maxChunksPerParent`            | 4                                                          |
| `enableParentContextRestore`    | true                                                       |
| `parentContextMaxChars`         | 2200                                                       |
| `enableFinalRelevanceFilter`    | true                                                       |
| `finalEmbeddingThreshold`       | 0.45                                                       |
| `strongFinalEmbeddingThreshold` | 0.62                                                       |
| `enableBm25MultiFragment`       | true                                                       |
| `bm25FragmentTopK`              | 10                                                         |
| `enableRerank`                  | true (the custom route may disable Reranker independently) |
| `rerankTopK`                    | 20                                                         |
| `rerankMinScore`                | 0.08                                                       |
| `strongRerankScoreThreshold`    | 0.20                                                       |

Rerank sits after RRF fusion and before Parent aggregation. It only processes the candidate pool and does not scan the entire database. The recommended SiliconFlow route uses its BGE-calibrated raw rerank score for later sorting / aggregation and discards candidates below `rerankMinScore`. A custom route instead converts response order into a stable rank score, so neither raw-score magnitude nor BGE thresholds can affect aggregation. Neither path backfills discarded candidates. Final Relevance Gate sits after context allocation and before Parent Context Restore, preventing unrelated queries from force-filling `finalTopK`. It does not backfill after discarding candidates, so `finalTopK` / `topK` is an output upper bound, not a guaranteed count.

`embeddingThreshold`, `finalEmbeddingThreshold`, `strongFinalEmbeddingThreshold`, `rerankMinScore`, and `strongRerankScoreThreshold` are calibrated only for the recommended BGE combination. Scores from custom Embedding / Reranker services have no universal scale and are used only for candidate ordering: custom Embedding search does not apply BGE cosine thresholds, custom Reranker output does not apply BGE rerank thresholds, and final candidates must have useful lexical grounding. This custom-route lexical gate remains active even when a caller disables the ordinary Final Relevance Filter.

Retention rules:

- `rerankScore >= 0.20`: strong reranker hit; keep directly.
- `embeddingScore >= 0.62`: strong semantic hit; keep directly.
- Cross-language semantic hit: when the query and candidate text clearly mismatch by Chinese / English script, keep if `embeddingScore >= 0.52` and `rerankScore >= max(rerankMinScore, 0.08)`. This avoids incorrectly killing English reports or technical docs under Chinese queries because of missing lexical anchors.
- `0.45 <= embeddingScore < 0.62`: must also hit a valid lexical anchor.
- BM25-only: must hit a valid lexical anchor.
- Candidates below 0.45, lacking valid lexical anchors, or lacking embedding / BM25 relevance signals are discarded.

Valid lexical anchors come from query-preprocess extracted items, file names / path items, English identifiers, and stop-word-filtered Chinese spans, and are matched against the chunk's `fileName`, `heading`, `sectionPath`, and body text. Generic terms such as `AgentVis`, feature, mechanism, document, and overview do not count as valid anchors by default. In broad overview queries, overview hints such as feature / function / capability / features / capabilities / overview can count as valid anchors.

`HybridRetriever` internal comments still mention that summary `memory_summary_*` may be retained, but the normal application entry goes through `RagService.retrieve()` final filtering: internal memory vectors carrying `metadata.memoryType` or `metadata.memoryId` are not returned as Knowledge Base RAG results.

---

### 8. ContextProvider - Context Formatter

**Source file**: `ContextProvider.ts`

It provides three formats:

- `format()`: plain text format, such as `[Chunk N] | Source: fileName`.
- `formatMarkdown()`: Markdown format; code chunks are wrapped in code blocks.
- `formatStructured()`: structured object format.

`ContextProvider` defaults to `showScore = true`, but `RagService` overrides it to `showScore = false` when creating the formatter. This is because RRF scores are usually only around `0.01~0.02`, and displaying them as percentages would mislead the model. The regular production `retrieveAndFormat()` injection does not show match percentage by default.

---

### 9. RagService - Main Service Coordinator

**Source file**: `RagService.ts`

`RagService` is the unified entry for Knowledge Base RAG.

#### Indexing API

```ts
indexDocument(agentId, documentId, content, metadata, onProgress?)
```

Flow:

1. Calls `DocumentChunker.chunkWithHierarchy()` for chunking.
2. Takes `childChunks`.
3. Calls `createDocumentOverviewChunk()` to generate an optional overview chunk.
4. Builds embedding input for `[overviewChunk, ...childChunks]` and vectorizes them in batch.
5. Writes each chunk into both `VectorStore` and `BM25Index`.

Before writing, the caller usually executes `deleteDocumentIndex(agentId, documentId)` first to make rebuild idempotent.

#### Retrieval API

```ts
retrieve(agentId, query, options?)
retrieveAndFormat(agentId, query, options?)
retrieveAndFormatMarkdown(agentId, query, options?)
```

Flow:

1. Queries vector index status and returns empty if there is no data.
2. Before hybrid retrieval, tries to rebuild in-memory BM25 through `ensureBm25Index()`.
3. Bridges `topK` to Hybrid `finalTopK`.
4. Calls `HybridRetriever.retrieve()`.
5. Finally filters out internal memory vectors carrying `metadata.memoryType` / `metadata.memoryId`.
6. Sends results to `ContextProvider` for formatting.

#### Management API

```ts
deleteDocumentIndex(agentId, documentId);
deleteAgentIndex(agentId);
getIndexStatus(agentId);
listIndexedDocumentIds(agentId);
```

---

## Boundary Between Memory Recall and Knowledge Base RAG

The memory system and Knowledge Base RAG share some lower-level infrastructure, but their business entry points are different.

### Fact Memory

Facts are retrieved by `MemoryContextProvider.getMemoryContext()` through `memory_get_context`. Currently they are fully read, grouped by category, and then rendered separately:

- `buildBindingFactsPrompt()`: identity and preferences, injected into the identity layer.
- `buildContextFactsPrompt()`: long-term goals, knowledge background, interaction signals, and similar background context.
- `buildTaskExperiencePrompt()`: task experience for MB / SA task reasoning.

Although fact vectors are written into `chunk_embeddings` by `MemoryVectorIndex.indexFact()`, normal memory-context injection does not depend on BM25 and does not go through Knowledge Base `RagService`.

### Summary Memory

Summaries are written into the same `chunk_embeddings` table by `MemoryVectorIndex.indexSummary()`. Their `documentId` is shaped like `memory_summary_{summaryId}`, and metadata contains:

```ts
{
  memoryType: 'summary',
  memoryId: summaryId,
  indexedAt: Date.now()
}
```

When the user sends a message, `MemoryContextProvider.getRelevantSummaries()` calls:

```ts
memorySummaryRetriever.retrieve(agentId, userQuery, allSummaries, {
  topK,
  threshold,
});
```

`MemorySummaryRetriever` works as follows:

1. Calls `MemoryVectorIndex.searchRelevant()` for embedding candidate recall. Candidate pool size is `max(topK * 3, 8)`, still isolating internal memory vectors by `memoryType === 'summary'` and the `memory_summary_` prefix.
2. Temporarily builds a `BM25Index` from the current `allSummaries`; index text includes `content`, `topics`, `keyPoints`, `mentionedFiles`, `confirmedDecisions`, the question / scope / keywords in `openQuestions`, and `invalidatedPoints`.
3. Extracts strong anchors from the query: file names, paths, extensions, code identifiers, quoted phrases, explicit Chinese proper names, and similar items. Low-value generic terms cannot trigger BM25-only recall by themselves.
4. Fuses ranking through RRF: embedding weight `1.0`; BM25 default weight `0.35`, boosted to `0.55` when strong anchors exist; `rrfK = 60`.
5. Gate keeps embedding-hit summaries. BM25-only summaries must hit a non-extension strong anchor to be retained. The fused results do not force-fill `topK`.
6. If embedding fails but BM25 has strong-anchor results, returns strong-anchor BM25 results. If neither side has usable results, degrades to the latest `topK` summaries and marks `isDegraded = true`.

Therefore, summaries are retrieved through an **independent memory-summary hybrid recall pipeline**. It lightly reuses `BM25Index` internally, but it does not pass through Knowledge Base `RagService` / `HybridRetriever`, and it does not use Knowledge Base BM25 rebuilding, Parent aggregation, context allocation, or Parent Context Restore.

### Ordinary Knowledge Base Files Are Not Filtered by memory Prefix

Knowledge Base RAG final filtering is based on metadata, not file names or documentId strings. For example, if the user's Knowledge Base contains a file such as `memory_notes.md`, it still participates in retrieval as an ordinary Knowledge Base document as long as it does not have `metadata.memoryType` / `metadata.memoryId`.

---

## System Integration Pipelines

### Pipeline 1: Knowledge Base Writes

```text
Agent settings page adds Knowledge Base files
        |
        +-- On save, reads text content -> RagService.indexDocument()

Document attachment upload in an Agent window
        |
        +-- useAttachmentManager -> AttachmentService.indexToKnowledge()
            +-- RagService.indexDocument()

file_write writes text deliverables
        |
        +-- Controlled by the autoIndexDeliverables switch
            +-- addToKnowledgePaths() -> indexToKnowledgeBase()
                +-- RagService.indexDocument()

Sub-Agent scans binary deliverables after completion
        |
        +-- DeliverableIndexer scans xlsx/docx/pptx/pdf newly produced by this task
            +-- parse_* -> RagService.indexDocument()
```

Notes:

- `file_write` currently does not have a tool parameter such as `indexToKnowledgeBase=true`; it is controlled by the Agent's `autoIndexDeliverables` switch.
- `file_write` asynchronous indexing rechecks `knowledgePaths` before actually writing indexes, preventing a background index task from "reviving" old vectors after the user deletes a Knowledge Base file.
- `DeliverableIndexer` uses `taskStartTime` to filter files newly created by the current task, avoiding reindexing old deliverables that the user has manually removed.
- When Knowledge Base paths are added directly from the settings page, they are mainly read as text. Office / PDF parsing entry points occur more often in the attachment service and deliverable indexer.

### Pipeline 2: Agent Reads During Reasoning

In Task mode (the internal path is `planning`), `AgentService.processMessage()` calls `loadRuntimeContext()` before creating `AgentLoop`:

```text
User message
  +-- AgentService.loadRuntimeContext(userQuery)
      +-- MemoryContextProvider.getMemoryContext()
      |   +-- Full-read facts and group them
      |   +-- Summaries through MemorySummaryRetriever hybrid recall
      |       (embedding + temporary BM25/RRF)
      +-- RagService.retrieveAndFormat(agentId, userQuery, { topK: 5 })
          +-- RuntimeContext.ragResults
```

The regular Chat sending path in an Agent window also executes a similar flow:

```text
useChatSender
  +-- MemoryContextProvider.getMemoryContext()
  +-- RagService.retrieveAndFormat(contextId, content, { topK: 5 })
```

In Hub @mention mode:

- The mentioned Agent's memory context is loaded.
- Knowledge Base RAG is disabled by default (`enableRag = false`) to reduce context pressure.

---

## Key Parameters

| Parameter                       | Value                                 | Description                                                                                                                                                  |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Markdown Child Chunk size       | 500 characters                        | `DocumentChunker.CHILD_SIZE`                                                                                                                                 |
| Parent minimum size             | 200 characters                        | Parents shorter than this are not recorded.                                                                                                                  |
| Child overlap window            | 50 characters                         | `DocumentChunker.CHILD_OVERLAP`                                                                                                                              |
| Default text chunkSize          | 500 characters                        | `DEFAULT_CHUNKING_CONFIG.chunkSize`                                                                                                                          |
| Default min chunk               | 100 characters                        | `DEFAULT_CHUNKING_CONFIG.minChunkSize`                                                                                                                       |
| Recommended Embedding model     | `BAAI/bge-m3`                         | SiliconFlow Mainland China endpoint; users may switch to a custom OpenAI-compatible endpoint or native Gemini.                                               |
| Native Gemini models            | `gemini-embedding-2` / `-001`         | Text only; fixed Google Developer API endpoint; output dimensions 768, 1536, or 3072.                                                                        |
| Embedding profile               | Route-specific semantic fingerprint   | OpenAI keeps its existing protocol + endpoint + model fingerprint; Gemini adds API/model/dimension/task-strategy version.                                    |
| Embedding cache                 | 1000-entry LRU                        | `EmbeddingService`                                                                                                                                           |
| Embedding batch size            | 25 items                              | `EMBEDDING_BATCH_SIZE`                                                                                                                                       |
| Embedding timeout               | Rust 15 seconds / renderer 18 seconds | Network hard timeout / IPC fallback.                                                                                                                         |
| BM25 k1                         | 1.2                                   | Term-frequency saturation control.                                                                                                                           |
| BM25 b                          | 0.75                                  | Document length normalization.                                                                                                                               |
| RRF k                           | 60                                    | Standard RRF parameter.                                                                                                                                      |
| `embeddingTopK`                 | 30                                    | Initial vector recall count.                                                                                                                                 |
| `bm25TopK`                      | 30                                    | Initial BM25 recall count.                                                                                                                                   |
| `rrfTopK`                       | 20                                    | Count entering aggregation after RRF fusion.                                                                                                                 |
| `finalTopK`                     | 4                                     | Overridden by caller `topK`; after final gate, output may be smaller.                                                                                        |
| `maxChunksPerParent`            | 4                                     | Maximum Child chunks expanded per Parent group.                                                                                                              |
| `embeddingThreshold`            | 0.3                                   | Hybrid embedding relevance gate.                                                                                                                             |
| `enableFinalRelevanceFilter`    | true                                  | Whether final relevance filtering is enabled.                                                                                                                |
| `finalEmbeddingThreshold`       | 0.45                                  | Lower bound for weak semantic hits, usually requiring valid lexical anchors; cross-language semantic hits can be exempt through rerank + embedding evidence. |
| `strongFinalEmbeddingThreshold` | 0.62                                  | Lower bound for strong semantic hits, requiring no lexical anchor.                                                                                           |
| `parentContextMaxChars`         | 2200                                  | Maximum characters for Parent Context Restore.                                                                                                               |
| `bm25FragmentTopK`              | 10                                    | BM25 recall count for each query fragment.                                                                                                                   |
| Semantic similarity threshold   | 0.75                                  | Default value of `isSemanticallySimilar()`.                                                                                                                  |

---

## Design Highlights

1. **Clear boundary between Knowledge Base and memory**: Knowledge Base RAG only returns ordinary Knowledge Base chunks. Internal memory vectors are filtered by metadata. Summary memory uses `MemorySummaryRetriever` independently and only lightly reuses temporary BM25/RRF internally. Fact memory is injected separately.

2. **Document Overview improves overview questions**: each document additionally generates a synthetic overview chunk and weights it in broad overview queries. After rerank, overview selection prefers the most relevant source and favors Document Overview within the same source, improving recall stability for "what features / capabilities does it have" questions.

3. **Hybrid Search provides complementary coverage**: Embedding handles semantic recall; BM25 handles precise signals such as file names, paths, headings, and code symbols; RRF avoids manual weight tuning.

4. **Layered metadata enhancement**: BM25 uses full metadata enhancement; embedding only uses compact metadata enhancement; final injection still uses original chunk content, reducing metadata pollution.

5. **Optional Rerank improves precision**: Hybrid Search provides recall coverage, while the recommended model or a custom Jina/Cohere- or Voyage-compatible Reranker performs second-stage semantic reranking. Disabled or failed reranking degrades to the original RRF + Gate pipeline.

6. **Final Relevance Gate prevents context force-fill**: strong rerank / embedding relevance is kept directly; cross-language semantic hits are retained through rerank + embedding dual evidence; other gray-zone weak semantic hits and BM25-only candidates must have valid lexical anchors. Discarded candidates are not backfilled to `topK`, reducing cases where unrelated queries are forced to receive 5 chunks.

7. **Parent Context Restore**: after a Markdown Child hit, the system can restore same-section context from cached sibling chunks instead of persisting the entire long Parent as a retrieval result.

8. **Incremental and idempotent indexing**: before file updates, `deleteDocumentIndex` runs first, then vectors and BM25 are rewritten; BM25 supports incremental deletion by documentId.

9. **BM25 can recover after restart**: although BM25 is in-memory only, before the first retrieval it is rebuilt from SQLite through `rag_list_chunks`, which also warms the chunk cache.
