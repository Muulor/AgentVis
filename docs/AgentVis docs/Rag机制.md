# AgentVis RAG 机制深度介绍

> 适用版本：当前代码实现
> 模块路径：`src/services/rag/`、`src/types/rag.ts`
> 相关链路：`src/services/memory/MemorySummaryRetriever.ts`、`src/services/memory/MemoryVectorIndex.ts`、`src/services/memory/MemoryContextProvider.ts`
> 命名说明：用户界面中的「Task 模式」对应内部模式值与路径 `planning`，既有代码标识保持不变。

---

## 概述

RAG（Retrieval-Augmented Generation，检索增强生成）在 AgentVis 中主要指 **Agent 知识库检索**：用户发起请求时，系统从当前 Agent 的知识库文件中召回相关片段，格式化后注入 Prompt，作为模型推理的外部资料。

当前知识库 RAG 采用 **Hybrid Search + RRF 融合**：

```text
原始 Query ───────────────→ Embedding Top 30 ──┐
                                               ├── RRF 融合 → SiliconFlow Rerank → Parent 聚合 → 上下文分配 → Final Relevance Gate → Parent Context Restore → 注入 Prompt
Query Preprocess → 增强 BM25 Query/Fragments ─→ BM25 Top 30 ─────┘
```

当前版本默认引入 SiliconFlow `BAAI/bge-reranker-v2-m3` reranker。初召回仍依赖 Query 预处理、BM25 元数据增强、Document Overview 合成块和 RRF 融合保证召回率；reranker 负责对 RRF 候选池做二阶段语义重排与低分过滤。Rerank 调用失败、超时或返回异常时会静默降级到原有 RRF + Gate 链路。

需要特别区分：

- **知识库 RAG**：由 `RagService` / `HybridRetriever` 负责，检索 Agent 的知识库文件。
- **记忆摘要召回**：由 `MemoryContextProvider` / `MemorySummaryRetriever` / `MemoryVectorIndex` 负责，底层复用 `EmbeddingService`、`VectorStore`，并用一次性的 `BM25Index` 做摘要词面召回与 RRF 纠偏；但不走 `RagService` / `HybridRetriever` / 知识库 BM25 生命周期。
- **记忆事实注入**：事实记忆通过 `memory_get_context` 全量读取后按类别注入，不走 BM25，也不走摘要混合召回。

---

## 架构总览

```text
src/services/rag/
├── RagService.ts              # RAG 主服务（单例），统一索引、检索、格式化入口
├── DocumentChunker.ts         # 文档分块器；Markdown 支持 Parent-Child，文本/代码为扁平 chunk
├── DocumentOverviewBuilder.ts # 文档总览合成块，用于总览类问题召回
├── EmbeddingService.ts        # 向量化服务；默认 SiliconFlow BAAI/bge-m3，fallback Gitee AI bge-m3
├── VectorStore.ts             # 向量存储 IPC 封装 + chunk LRU 缓存
├── BM25Index.ts               # 纯内存 BM25 关键词索引（增量 IDF）
├── RagQueryPreprocessor.ts    # Query 预处理、BM25 元数据增强、embedding 紧凑元数据增强
├── HybridRetriever.ts         # 混合检索器（Embedding + BM25 + RRF + 上下文分配）
├── RerankService.ts           # SiliconFlow bge-reranker-v2-m3 二阶段重排序服务
├── ContextProvider.ts         # 检索结果格式化器
└── LruCache.ts                # 通用 LRU 缓存工具
```

Rust 侧主要对应：

```text
src-tauri/src/commands/rag.rs             # rag_index_chunk / rag_search / rag_list_chunks 等 IPC
src-tauri/src/commands/cloud_embedding.rs # SiliconFlow / Gitee AI / ZhipuAI Embedding API
src-tauri/src/db/vector_repo.rs           # chunk_embeddings 表读写与 cosine 搜索
```

---

## 核心组件详解

### 1. DocumentChunker - 文档分块器

**源文件**：`DocumentChunker.ts`

`DocumentChunker` 负责把原始文档切成适合索引的 chunk。当前实现要注意两点：

- **Markdown** 走 Parent-Child 分块：按 H1~H6 标题解析章节，章节内容生成 Parent，章节内部再按句子聚合成 Child。
- **非 Markdown**（纯文本、代码、JSON 等）走扁平分块：不会生成 Parent，`parentChunks` 为空，`childChunks` 就是实际扁平 chunks。

关键参数：

| 参数 | 当前值 | 说明 |
|------|--------|------|
| `PARENT_MIN_SIZE` | 200 字符 | Markdown 章节短于该值时不记录 Parent |
| `CHILD_SIZE` | 500 字符 | Markdown Child 目标尺寸 |
| `CHILD_OVERLAP` | 50 字符 | Child 间重叠窗口 |
| `DEFAULT_CHUNKING_CONFIG.chunkSize` | 500 字符 | 文本/扁平分块目标尺寸 |
| `DEFAULT_CHUNKING_CONFIG.minChunkSize` | 100 字符 | 最小 chunk 尺寸 |

Markdown Child 会携带 `parentChunkId`、`sectionPath` 等元数据。当前 `RagService.indexDocument()` 实际写入向量库的是 **Document Overview + Child chunks**，Parent chunk 本身不作为普通向量条目持久化。检索后如需连续上下文，由 `HybridRetriever` 使用缓存中的同 Parent sibling chunks 做 `Parent Context Restore`。

---

### 2. DocumentOverviewBuilder - 文档总览合成块

**源文件**：`DocumentOverviewBuilder.ts`

每次索引文档时，`RagService` 会尝试创建一个合成的 Document Overview chunk。它的特点：

- `chunkIndex = -1`
- `heading = "Document Overview"`
- `metadata.isDocumentOverview = true`
- 内容包含文件名、标题、chunk 数、章节数、最多 16 个 Markdown 标题、最多 900 字符的开头正文

这个合成块和普通 Child 一样会进入向量库和 BM25。它主要服务于“有什么功能”“介绍一下能力”“what features”等总览类问题，避免用户问概览时只召回某个细碎段落。

在 `HybridRetriever` 中，总览类 query 会有额外策略：

- Document Overview 的 embedding RRF 贡献权重为 `1.2`
- 有 embedding 候选时，普通 BM25-only 命中的 RRF 贡献会降到 `0.35`
- 选择池扩大为 `finalTopK * 4`
- Rerank 成功后，同源多命中的额外奖励会降权，避免多个略低分细节片段压过单个最高相关来源
- broad overview query 中，同源内分数接近时优先注入 Document Overview，再回填细节 chunk
- 优先一源一个片段，再回填，增强多来源覆盖
- broad overview query 完成来源分配后，会按 rerank score 重新排序最终输出，确保最高相关总览材料优先注入
- broad overview query 不做 Parent Context Restore，避免概览问题被单个长章节吃满预算

---

### 3. EmbeddingService - 向量化服务

**源文件**：`EmbeddingService.ts`
**后端命令**：`cloud_embedding_encode`

当前默认 Embedding 路径是：

1. 首选 `siliconflow` provider，模型 `BAAI/bge-m3`
2. 主 provider 失败且配置了 Gitee AI Key 时，fallback 到 `giteeai` provider，模型 `bge-m3`
3. Rust 后端仍支持 `zhipu` provider 和 `Embedding-3-pro`，但 TS 默认 RAG 服务不会优先使用它

当前代码注释标注 `bge-m3` 为 1024 维。`EmbeddingService` 还提供：

- LRU 缓存：最多 1000 条 embedding
- 批量调用：每批最多 25 条
- 单批超时：15 秒，避免网络断开时长期阻塞
- 余弦相似度计算
- `isSemanticallySimilar()`：默认阈值 `0.75`，失败时返回 `false`

索引时，embedding 输入不是裸 `chunk.content`，而是由 `buildEmbeddingIndexText()` 构造的紧凑元数据增强文本：

```text
Document: <fileName + 少量扩展词>
Section: <sectionPath>
Heading: <heading>

<chunk.content>
```

完整路径不会进入 embedding 输入，以减少路径噪声；原始 chunk 内容仍按原文存储并注入 LLM。

---

### 4. VectorStore - 向量存储与缓存

**源文件**：`VectorStore.ts`
**Rust 实现**：`src-tauri/src/db/vector_repo.rs`

`VectorStore` 是 TypeScript 侧的 IPC 封装。当前 Rust 侧实际存储在 SQLite 表 `chunk_embeddings` 中，embedding 以 f32 little-endian BLOB 保存；检索时 Rust 读取候选 chunk，计算 cosine similarity，按分数降序截断。

也就是说，当前主链路并不是 sqlite-vec 虚拟表近邻搜索。`vector_metadata` 仍保留为兼容旧表结构，代码注释里提到 sqlite-vec 的位置应理解为历史/未来扩展说明。

主要 IPC 命令：

| 命令 | 功能 |
|------|------|
| `rag_index_chunk` | 插入 chunk + embedding |
| `rag_search` | cosine 相似度搜索，可选 `document_id_prefix` |
| `rag_list_chunks` | 列出持久化 chunks，用于重建 BM25 和预热缓存 |
| `rag_delete_by_agent` | 清空 Agent 所有向量 |
| `rag_delete_by_document` | 删除单个 documentId 的向量 |
| `rag_get_status` | 查询索引统计 |
| `rag_list_document_ids` | 列出 Agent 下所有已索引 documentId，用于对账/诊断 |

`VectorStore` 还维护一个最多 2000 条的 chunk LRU 缓存：

- 新索引时通过 `insert()` 写入缓存
- `listChunks()` 会从 SQLite 拉取 chunk 并预热缓存
- BM25 命中 chunk id 后，会从该缓存取回完整 chunk
- Parent Context Restore 会用 `getCachedChunksByParent()` 找同 Parent 的 sibling chunks

---

### 5. BM25Index - 关键词索引

**源文件**：`BM25Index.ts`

BM25 运行在 renderer 内存中，不落库。它负责关键词召回，尤其补足文件名、路径、章节名、代码符号等 embedding 不稳定的场景。

算法核心：

```text
BM25 score = Σ IDF(t) * TF_norm(t, d)

IDF(t) = log((N - df + 0.5) / (df + 0.5) + 1)
TF_norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))

k1 = 1.2
b = 0.75
```

分词策略：

- 英文：提取英文/数字 token，过滤英文停用词和长度小于 2 的词
- 中文：连续中文片段生成 bigram，同时保留 2~4 字完整短语

BM25 支持增量 IDF：

- `addDocument()` 只更新新文档出现的 terms
- `removeDocument()` / `removeByDocumentId()` 回退旧文档词频
- `clearAgent()` 清理某个 Agent 的内存索引

由于 BM25 不持久化，应用/renderer 重启后，`RagService.retrieve()` 会在首次混合检索前调用 `ensureBm25Index()`，通过 `rag_list_chunks` 从 SQLite 恢复知识库 BM25 条目。恢复时会跳过带 `metadata.memoryType` / `metadata.memoryId` 的内部记忆向量。

---

### 6. RagQueryPreprocessor - Query 与索引文本增强

**源文件**：`RagQueryPreprocessor.ts`

它承担三类工作：

1. **Query 预处理**：提取文件名、路径、PascalCase/camelCase/snake_case、quoted phrase 等符号，追加到 BM25 query。
2. **多片段 BM25**：多行或多句 query 会拆为最多 4 个 fragments，分别 BM25 检索后合并。
3. **索引文本增强**：
   - `buildBm25IndexText()` 把 `fileName`、`filePath`、`sectionPath`、`heading` 和正文拼接后送入 BM25
   - `buildEmbeddingIndexText()` 只把文件名、章节路径、标题等紧凑元数据加入 embedding 输入

重要约束：

- Query preprocess 只增强 BM25；embedding search 始终使用原始用户 query。
- 品牌复合词如 `AgentVis` 不拆成过泛的 `agent` / `vis`。
- broad overview query 会追加“特性、功能、能力、features、capabilities、overview”等别名，提升总览召回。

---

### 7. HybridRetriever - 混合检索器

**源文件**：`HybridRetriever.ts`

主流程：

```text
Step 1: Query Preprocess          生成 BM25 增强 query 和 fragments
Step 2: Embedding 向量检索         原始 query，Top 30
Step 3: BM25 关键词检索           增强 query Top 30 + fragments Top 10
Step 4: RRF 融合                  默认 rrfTopK = 20
Step 5: SiliconFlow Rerank       RRF Top20 进入 bge-reranker-v2-m3；失败自动降级
Step 6: Parent 聚合               按 parentChunkId / chunk.id 聚合
Step 7: 同源优先排序               来源得分以最佳 Parent 为主，少量保留同源奖励
Step 8: 上下文分配                 focused 连续展开；broad 平衡主来源与辅助来源
Step 9: 记忆事实过滤               Hybrid 内部排除 documentId 以 memory_fact_ 开头的结果
Step 10: embedding 阈值二次过滤     有 embeddingScore 时要求 >= 0.3；纯 BM25 命中豁免
Step 11: Final Relevance Gate     rerank/embedding 强相关直接保留；跨语言语义证据可豁免词面锚点；其余灰区或 BM25-only 候选必须有有效词面锚点
Step 12: Parent Context Restore   非 broad overview query 可扩展同 Parent sibling chunks
```

RRF 算法：

```text
RRF_score(d) = Σ weight_i / (k + rank_i(d))
k = 60
```

默认配置：

| 参数 | 值 |
|------|----|
| `embeddingTopK` | 30 |
| `bm25TopK` | 30 |
| `rrfTopK` | 20 |
| `finalTopK` | 4 |
| `rrfK` | 60 |
| `embeddingThreshold` | 0.3 |
| `maxChunksPerParent` | 4 |
| `enableParentContextRestore` | true |
| `parentContextMaxChars` | 2200 |
| `enableFinalRelevanceFilter` | true |
| `finalEmbeddingThreshold` | 0.45 |
| `strongFinalEmbeddingThreshold` | 0.62 |
| `enableBm25MultiFragment` | true |
| `bm25FragmentTopK` | 10 |
| `enableRerank` | true |
| `rerankTopK` | 20 |
| `rerankMinScore` | 0.08 |
| `strongRerankScoreThreshold` | 0.20 |

Rerank 位于 RRF 融合之后、Parent 聚合之前。它只处理候选池，不参与全库扫描；成功后使用 rerank score 作为后续排序/聚合主分数，低于 `rerankMinScore` 的候选会被丢弃且不回填。Final Relevance Gate 位于上下文分配之后、Parent Context Restore 之前，用来避免无关 query 被硬塞满 `finalTopK`。它不会在丢弃候选后回填，因此 `finalTopK` / `topK` 是输出上限，不是保证数量。

保留规则：

- `rerankScore >= 0.20`：reranker 强相关命中，直接保留。
- `embeddingScore >= 0.62`：强语义命中，直接保留。
- 跨语言语义命中：query 和候选文本呈现明显中英文脚本错配、`embeddingScore >= 0.52`，且 `rerankScore >= max(rerankMinScore, 0.08)` 时保留；这用于避免英文报告、英文技术文档在中文 query 下被词面锚点误杀。
- `0.45 <= embeddingScore < 0.62`：必须同时命中有效词面锚点才保留。
- BM25-only：必须命中有效词面锚点才保留。
- 低于 0.45、缺少有效词面锚点，或缺少 embedding/BM25 相关性信号的候选会被丢弃。

有效词面锚点来自 query preprocess 抽取项、文件名/路径项、英文标识符和去停用词后的中文片段，并在 chunk 的 `fileName`、`heading`、`sectionPath` 和正文中匹配。`AgentVis`、`功能`、`机制`、`文档`、`overview` 等泛词默认不算有效锚点；但 broad overview query 中，“特性/功能/能力/features/capabilities/overview”等概览提示词可作为有效锚点。

`HybridRetriever` 内部注释仍保留“摘要 `memory_summary_*` 可保留”的说法，但正常应用入口会经过 `RagService.retrieve()` 的最终过滤：带 `metadata.memoryType` 或 `metadata.memoryId` 的内部记忆向量不会作为知识库 RAG 结果返回。

---

### 8. ContextProvider - 上下文格式化器

**源文件**：`ContextProvider.ts`

提供三种格式：

- `format()`：纯文本格式，形如 `[Chunk N] | Source: fileName`
- `formatMarkdown()`：Markdown 格式，代码 chunk 会包裹代码块
- `formatStructured()`：结构化对象

`ContextProvider` 默认 `showScore = true`，但 `RagService` 创建它时会覆盖为 `showScore = false`。这是因为 RRF 分数通常只有 `0.01~0.02`，直接显示成百分比会误导模型。实际生产注入的常规 `retrieveAndFormat()` 默认不显示匹配度。

---

### 9. RagService - 主服务协调器

**源文件**：`RagService.ts`

`RagService` 是知识库 RAG 的统一入口。

#### 索引接口

```ts
indexDocument(agentId, documentId, content, metadata, onProgress?)
```

流程：

1. 调用 `DocumentChunker.chunkWithHierarchy()` 分块
2. 取 `childChunks`
3. 调用 `createDocumentOverviewChunk()` 生成可选 overview chunk
4. 对 `[overviewChunk, ...childChunks]` 构建 embedding 输入并批量向量化
5. 每个 chunk 同时写入 `VectorStore` 和 `BM25Index`

写入前通常由调用方先执行 `deleteDocumentIndex(agentId, documentId)`，实现幂等重建。

#### 检索接口

```ts
retrieve(agentId, query, options?)
retrieveAndFormat(agentId, query, options?)
retrieveAndFormatMarkdown(agentId, query, options?)
```

流程：

1. 查询向量索引状态，无数据直接返回空
2. 混合检索前通过 `ensureBm25Index()` 尝试重建内存 BM25
3. `topK` 会桥接到 Hybrid 的 `finalTopK`
4. 调用 `HybridRetriever.retrieve()`
5. 最终过滤掉带 `metadata.memoryType` / `metadata.memoryId` 的内部记忆向量
6. 交给 `ContextProvider` 格式化

#### 管理接口

```ts
deleteDocumentIndex(agentId, documentId)
deleteAgentIndex(agentId)
getIndexStatus(agentId)
listIndexedDocumentIds(agentId)
```

---

## 记忆召回与知识库 RAG 的边界

记忆系统和知识库 RAG 共用部分底层设施，但业务入口不同。

### 事实记忆

事实由 `MemoryContextProvider.getMemoryContext()` 通过 `memory_get_context` 获取。当前是全量读取后按类别分组，再分别构建：

- `buildBindingFactsPrompt()`：身份与偏好，注入身份层
- `buildContextFactsPrompt()`：长期目标、知识背景、交互信号等，作为背景上下文
- `buildTaskExperiencePrompt()`：任务经验，供 MB/SA 任务推理参考

事实向量虽然会由 `MemoryVectorIndex.indexFact()` 写入 `chunk_embeddings`，但正常记忆上下文注入不依赖 BM25，也不走知识库 `RagService`。

### 摘要记忆

摘要由 `MemoryVectorIndex.indexSummary()` 写入同一张 `chunk_embeddings` 表，`documentId` 形如 `memory_summary_{summaryId}`，metadata 带：

```ts
{
  memoryType: 'summary',
  memoryId: summaryId,
  indexedAt: Date.now()
}
```

用户发消息时，`MemoryContextProvider.getRelevantSummaries()` 会调用：

```ts
memorySummaryRetriever.retrieve(agentId, userQuery, allSummaries, {
  topK,
  threshold,
})
```

`MemorySummaryRetriever` 的流程是：

1. 调用 `MemoryVectorIndex.searchRelevant()` 做 embedding 候选召回，候选池大小为 `max(topK * 3, 8)`，仍由 `memoryType === 'summary'` 和 `memory_summary_` 前缀隔离内部记忆向量。
2. 基于本次 `allSummaries` 临时构建 `BM25Index`，索引文本包含 `content`、`topics`、`keyPoints`、`mentionedFiles`、`confirmedDecisions`、`openQuestions` 的问题/范围/关键词，以及 `invalidatedPoints`。
3. 从 query 抽取强锚点：文件名、路径、扩展名、代码标识符、quoted phrase、明确中文专名等；低价值泛词不能单独触发 BM25-only 召回。
4. 通过 RRF 融合排序：embedding 权重 `1.0`；BM25 默认权重 `0.35`，有强锚点时提升到 `0.55`；`rrfK = 60`。
5. Gate 保留 embedding 命中的摘要；BM25-only 摘要必须命中非扩展名强锚点才保留；融合后不强行补满 `topK`。
6. embedding 失败但 BM25 有强锚点结果时，返回强锚点 BM25 结果；两边都没有可用结果时，降级为最近 `topK` 摘要并标记 `isDegraded = true`。

因此，摘要是 **通过独立的记忆摘要混合召回链路** 检索：它内部轻量复用 `BM25Index`，但不经过知识库 `RagService` / `HybridRetriever`，也不使用知识库 BM25 的重建、Parent 聚合、上下文分配或 Parent Context Restore。

### 普通知识库文件不会按 memory 前缀过滤

知识库 RAG 的最终过滤依据是 metadata，而不是文件名或 documentId 字符串。也就是说，用户知识库里有 `memory_notes.md` 这类文件，只要它没有 `metadata.memoryType` / `metadata.memoryId`，仍会作为普通知识库文档参与检索。

---

## 系统集成链路

### 链路一：知识库写入

```text
Agent 设置页添加知识库文件
        │
        └── 保存设置时读取文本内容 → RagService.indexDocument()

Agent 窗口上传文档附件
        │
        └── useAttachmentManager → AttachmentService.indexToKnowledge()
            └── RagService.indexDocument()

file_write 写入文本交付物
        │
        └── 受 autoIndexDeliverables 开关控制
            └── addToKnowledgePaths() → indexToKnowledgeBase()
                └── RagService.indexDocument()

Sub-Agent 完成后扫描二进制交付物
        │
        └── DeliverableIndexer 扫描本次任务新产生的 xlsx/docx/pptx/pdf
            └── parse_* → RagService.indexDocument()
```

注意：

- `file_write` 当前没有 `indexToKnowledgeBase=true` 这样的工具参数；它由 Agent 的 `autoIndexDeliverables` 开关控制。
- `file_write` 的异步索引会在真正写入索引前重新检查 `knowledgePaths`，避免用户删除知识库文件后，后台索引把旧向量“复活”。
- `DeliverableIndexer` 使用 `taskStartTime` 过滤本次任务新增文件，避免重新索引用户已手动移除的旧交付物。
- 设置页直接添加知识库路径时主要按文本读取；Office/PDF 的解析入口更多发生在附件服务与交付物索引器。

### 链路二：Agent 推理时读取

Task 模式（内部路径为 `planning`）中，`AgentService.processMessage()` 会在创建 `AgentLoop` 前调用 `loadRuntimeContext()`：

```text
用户消息
  └── AgentService.loadRuntimeContext(userQuery)
      ├── MemoryContextProvider.getMemoryContext()
      │   ├── facts 全量读取并分组
      │   └── summaries 通过 MemorySummaryRetriever 混合召回（embedding + 临时 BM25/RRF）
      └── RagService.retrieveAndFormat(agentId, userQuery, { topK: 5 })
          └── RuntimeContext.ragResults
```

普通 Chat 发送链路在 Agent 窗口中也会执行类似流程：

```text
useChatSender
  ├── MemoryContextProvider.getMemoryContext()
  └── RagService.retrieveAndFormat(contextId, content, { topK: 5 })
```

Hub @提及模式下：

- 会加载被 @ Agent 的记忆上下文
- 默认禁用知识库 RAG（`enableRag = false`），减少上下文压力

---

## 关键参数一览

| 参数 | 值 | 说明 |
|------|----|------|
| Markdown Child Chunk 大小 | 500 字符 | `DocumentChunker.CHILD_SIZE` |
| Parent 最小尺寸 | 200 字符 | 短于该值不记录 Parent |
| Child 重叠窗口 | 50 字符 | `DocumentChunker.CHILD_OVERLAP` |
| 默认文本 chunkSize | 500 字符 | `DEFAULT_CHUNKING_CONFIG.chunkSize` |
| 默认最小 chunk | 100 字符 | `DEFAULT_CHUNKING_CONFIG.minChunkSize` |
| Embedding 默认模型 | `BAAI/bge-m3` | SiliconFlow provider |
| Embedding fallback | `bge-m3` | Gitee AI provider |
| Embedding 缓存 | 1000 条 LRU | `EmbeddingService` |
| Embedding 批大小 | 25 条 | `EMBEDDING_BATCH_SIZE` |
| Embedding 超时 | 15 秒 | 单批 API 调用 |
| BM25 k1 | 1.2 | 词频饱和控制 |
| BM25 b | 0.75 | 文档长度归一化 |
| RRF k | 60 | 标准 RRF 参数 |
| embeddingTopK | 30 | 向量初召回数量 |
| bm25TopK | 30 | BM25 初召回数量 |
| rrfTopK | 20 | RRF 融合后进入聚合的数量 |
| finalTopK | 4 | 调用方传 `topK` 时会桥接覆盖；经 final gate 后可能少于该值 |
| maxChunksPerParent | 4 | 每个 Parent 组最多展开的 Child 数 |
| embeddingThreshold | 0.3 | Hybrid embedding 相关度门控 |
| enableFinalRelevanceFilter | true | 是否启用最终相关性过滤 |
| finalEmbeddingThreshold | 0.45 | 弱语义命中保留下限，通常需有有效词面锚点；跨语言语义命中可由 rerank+embedding 双证据豁免 |
| strongFinalEmbeddingThreshold | 0.62 | 强语义命中保留下限，不要求词面锚点 |
| parentContextMaxChars | 2200 | Parent Context Restore 最大字符数 |
| bm25FragmentTopK | 10 | 每个 query fragment 的 BM25 召回数量 |
| 语义相似阈值 | 0.75 | `isSemanticallySimilar()` 默认值 |

---

## 设计亮点

1. **知识库与记忆边界清晰**：知识库 RAG 只返回普通知识库 chunk；内部记忆向量通过 metadata 过滤。摘要记忆独立走 `MemorySummaryRetriever`，只在内部轻量复用临时 BM25/RRF；事实记忆独立注入。

2. **Document Overview 改善总览问题**：每个文档额外生成总览合成块，并在 broad overview query 中加权。Rerank 后的总览选择会优先最高相关来源，并在同源内偏向 Document Overview，提升“有哪些功能/能力”类问题的召回稳定性。

3. **Hybrid Search 覆盖互补**：Embedding 负责语义召回，BM25 负责文件名、路径、标题、代码符号等精确线索；RRF 避免手动调权重。

4. **元数据分层增强**：BM25 使用完整元数据增强；embedding 只使用紧凑元数据增强；最终注入仍是原始 chunk 内容，降低元数据污染。

5. **SiliconFlow Rerank 提升精排质量**：Hybrid Search 负责召回覆盖，`BAAI/bge-reranker-v2-m3` 负责对候选池做二阶段语义重排；失败时静默降级到原 RRF + Gate 链路。

6. **Final Relevance Gate 防止硬塞上下文**：rerank/embedding 强相关直接保留；跨语言语义命中由 rerank+embedding 双证据保留；其余灰区弱语义命中和 BM25-only 候选必须有有效词面锚点。丢弃后不补满 `topK`，减少无关问题被强行注入 5 个 chunk。

7. **Parent Context Restore**：Markdown 命中 Child 后，可基于缓存 sibling chunks 恢复同章节上下文，而不是直接把整个长 Parent 持久化为检索结果。

8. **增量与幂等索引**：文件更新前先 `deleteDocumentIndex`，再重新写入向量与 BM25；BM25 支持按 documentId 增量删除。

9. **重启后 BM25 可恢复**：BM25 虽然只在内存中，但首次检索前会通过 `rag_list_chunks` 从 SQLite 重建知识库 BM25，并预热 chunk 缓存。
