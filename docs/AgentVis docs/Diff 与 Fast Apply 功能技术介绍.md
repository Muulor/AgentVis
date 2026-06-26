# Diff 与 Fast Apply 功能技术介绍

> 适用版本：AgentVis 当前主线分支  
> 更新时间：2026-06-21

---

## 一、概述

AgentVis 的 **Diff & Fast Apply** 系统是连接 AI 生成内容与文件系统的核心桥梁。当 Sub-Agent 完成代码编写或修改任务后，系统吸入文件并提供diff对比，提供精确回滚能力。

1. 将 AI 的修改意图编码为 **XML 修改协议**
2. 通过四级匹配策略精确定位文件中的目标内容
3. 生成可交互的 **Diff 预览界面**，展示每一处变更
4. 经用户逐块或批量审批后，按当前链路写入/保留磁盘内容，并创建**快照**备份

这一设计让文件修改进入可审阅、可恢复的 Diff 流程，同时提供版本回滚能力。

---

## 二、XML 修改协议

### 2.1 协议格式

Fast Apply 系统使用自定义 XML 格式传递修改指令。一次修改任务由一个 `<modifications>` 容器包裹，内含一或多个 `<modification>` 标签：

```xml
<modifications>
  <modification>
    <file>src/components/Button.tsx</file>
    <operation>REPLACE</operation>
    <search>const oldText = "Click me";</search>
    <replace>const newText = "Submit";</replace>
    <description>更新按钮文字</description>
  </modification>
  <modification>
    <operation>DELETE</operation>
    <search>// TODO: remove this line</search>
  </modification>
</modifications>
```

### 2.2 操作类型

| 操作类型 | 说明 | `replace` 字段 |
|---|---|---|
| `REPLACE` | 将 `search` 内容替换为 `replace` 内容 | 必填 |
| `INSERT_AFTER` | 在 `search` 内容**之后**插入 `replace` 内容 | 必填 |
| `INSERT_BEFORE` | 在 `search` 内容**之前**插入 `replace` 内容 | 必填 |
| `DELETE` | 删除 `search` 指定的内容 | 可省略 |

### 2.3 协议解析器（ProtocolParser）

`ProtocolParser` 使用浏览器原生 `DOMParser` 解析 XML，支持两种使用场景：

- **结构化输入**：LLM/工具直接输出标准 XML 字符串
- **混合文本**：LLM 在自然语言回复中嵌入 XML 块，`extractFromText()` 方法通过正则表达式提取后再解析

解析过程对 `<operation>` 类型做严格合法性校验，非 DELETE 操作缺少 `<replace>` 时会抛出 `ProtocolParseError`。

---

## 三、Fast Apply 引擎

### 3.1 整体架构

```
XML 输入
  │
  ▼
ProtocolParser ──► 解析出 Modification[] 列表
  │
  ▼
ContentMatcher ──► 在文件中定位每个 search 的行范围（四级匹配）
  │
  ▼
ModificationExecutor ──► 预览/执行替换，生成 newContent
  │
  ▼
DiffGenerator ──► 基于 Myers Diff 生成 DiffResult（hunks/lines）
  │
  ▼
diffStore / FullFileDiffViewer ──► 管理审批状态并渲染 Diff 面板
  │
  ├─ SnapshotManager ──► 写入快照（Tauri SQLite 后端）
  └─ diff_records ──► 持久化未完成 Diff、活动快照和修改块状态
```

`FastApplyEngine` 是协调解析、匹配、执行、Diff 生成和快照能力的主类，以单例形式导出（`fastApplyEngine`）。`FastApplyService` 是对外的薄封装层，`diffStore`（Zustand 状态管理）主要调用 `preview()`、快照和回滚相关 API。

### 3.2 预览流程（preview）

`preview()` 方法**只读不写**，不会创建快照，也不会写入磁盘。它返回带 `pending` / `failed` 状态的 `BatchApplyResult`，用于填充 Diff 面板：

```
for each modification:
  1. ContentMatcher.match(content, modification.search)
  2. 若匹配成功：ModificationExecutor.previewModification() → 生成 old/newContent
                 DiffGenerator.generateDiff()           → 生成 DiffResult
                 status = 'pending'
  3. 若匹配失败：status = 'failed'（或 'manual' 需人工处理）
```

> **注意**：当前 `preview()` 内部始终使用**禁用语义匹配**的独立 `ContentMatcher`（`enableSemanticMatch: false`）。原因是 UI 预览链路大多来自 `diffToXml` 或整文件 REPLACE XML，语义兜底收益有限；而语义匹配会为失败块调用 Embedding API，可能明显阻塞 Diff 面板。

---

## 四、ContentMatcher 四级匹配策略

`ContentMatcher` 是整个系统最核心的模块，实现了从精确到模糊的渐进式匹配，确保 AI 生成内容中的轻微偏差不会导致匹配失败。

### 4.1 匹配流程

```
输入: content（文件内容）, search（待查找片段）
  │
  ├─ Step 1: 精确匹配（exact）
  │     先 indexOf(search)，失败再 trim() 后重试
  │     失败再逐行 trim 滑动窗口匹配
  │         ↓ 失败
  ├─ Step 2: 正规化匹配（normalized）
  │     仅当内容含 box-drawing 字符（│─┌ 等）时激活
  │     将特殊字符映射到 ASCII 等价物后再精确匹配
  │         ↓ 失败
  ├─ Step 3: 模糊匹配（fuzzy）
  │     Levenshtein 编辑距离相似度 ≥ 0.8 阈值
  │     滑动窗口遍历，取最高相似度位置
  │     search 超过 2000 字符时跳过（防止 O(n²) 阻塞）
  │         ↓ 失败
  └─ Step 4: 语义匹配（semantic）
        调用 EmbeddingService，向量余弦相似度 ≥ 0.85
        步长采样减少 API 调用（step = max(1, searchLines÷2)）
        网络异常时优雅降级，不阻断流程
            ↓ 全部失败
        返回 matchLevel='manual'，status='failed'
```

### 4.2 CRLF 兼容性

XML 经 DOMParser 解析后 `\r\n` 会被归一化为 `\n`，而文件内容可能保留 Windows 换行符。ContentMatcher 的处理策略：

- 匹配在 LF 归一化的副本上进行（避免 indexOf 失败）
- 匹配成功后用**行号**映射回原始内容，提取带 CRLF 的 `matchedContent`
- 执行替换时优先使用 `startOffset` / `matchLength` 做字符级替换，未替换区域保留原始行尾；替换文本本身保持 XML/新内容中的换行。若落到行号 fallback，拼接结果使用 `\n`

### 4.3 匹配结果（MatchResult）

每次匹配返回：

| 字段 | 含义 |
|---|---|
| `success` | 是否成功 |
| `matchLevel` | `exact` / `normalized` / `fuzzy` / `semantic` / `manual` |
| `confidence` | 置信度（0-1），exact=1.0，normalized=0.95，fuzzy/semantic=实际计算值 |
| `startLine` / `endLine` | 匹配的行号范围（1-indexed），用于后续 Diff 重建 |
| `matchedContent` | 实际匹配到的内容（含原始行分隔符） |

---

## 五、Myers Diff 算法

### 5.1 算法简介

`MyersDiff.ts` 实现了 Eugene W. Myers（1986）的经典算法，这也是 `git diff` 的底层算法。核心特性：

- **时间复杂度 O(ND)**，N = 两文件行数之和，D = 编辑距离
- 对于典型代码编辑（D << N），性能远优于 LCS 的 O(NM)
- 保证**最小编辑距离**（最短编辑序列）
- 纯函数，无副作用，零外部依赖

### 5.2 工作原理

将 diff 建模为**编辑图**上的最短路径搜索：

1. **前向搜索**：对每个编辑距离 d（0, 1, 2, …），在每条对角线 k 上尽可能向右下方前进（匹配行 = 免费移动）
2. **保存 trace**：记录每一步 d 的最远到达位置快照
3. **回溯**：从终点 (n, m) 反向追溯 trace，还原编辑操作序列（`add` / `remove` / `context`）

输出格式为 `EditOp[]`，与 `DiffLine` 类型兼容，可直接供 `DiffGenerator` 和 `diffStore` 使用。

### 5.3 应用场景

Myers Diff 在系统中有两处核心用途：

| 场景 | 调用位置 | 说明 |
|---|---|---|
| Diff 预览生成 | `DiffGenerator.generateDiff()` | 将 search/replace 生成为可视化 hunks |
| accept/reject 内容重建 | `diffStore.rebuildByMyersDiff()` | 用户拒绝部分修改时，精确重建文件内容 |

---

## 六、DiffToXml 转换器

### 6.1 设计目的

`DiffToXmlConverter` 解决了 `file_write` 写入后复用 Diff 审批面板的问题：Sub-Agent 可能已经把文件写到磁盘，但 UI 仍需要一份可由 Fast Apply 管道解析的 XML 协议，以便用户查看、接受、拒绝或回滚变更。

**数据流**：

```
原始内容 + LLM 新写入内容
  → DiffGenerator.generateDiff()       → DiffResult (hunks/lines)
  → DiffToXmlConverter.diffToXml()     → XML 修改协议
  → FastApplyEngine.preview()           → ModificationApplyResult[]
  → FullFileDiffViewer                  → 可交互 Diff 面板
```

### 6.2 变更块（Change Block）提取

转换器遍历每个 hunk 的 lines，将连续的 `remove`/`add` 行分组为**变更块**，context 行作为分隔符：

```
[context][remove][add][context][add][add][context]
  ─────────────────────────────────────────────────
         [REPLACE block]      [INSERT block]
```

### 6.3 操作类型推断

| 变更块内容 | 生成操作 |
|---|---|
| remove + add | `REPLACE`（search = 被删除行，replace = 插入行） |
| remove only | `DELETE` |
| add only（存在前方 context） | `REPLACE`（search = 前方 context 锚点，replace = 锚点 + 插入行） |
| add only（文件头部） | `INSERT_BEFORE`（search = 后方 context 行） |

对纯插入块，当前转换器优先使用最多 5 行前置 context 作为锚点，并把插入表达为 `REPLACE(anchor → anchor + inserted)`。这样可以复用替换链路，减少单行重复锚点（如大量 `}`、注释或 CSS 选择器）导致的错位。若没有前置 context（文件头部插入），才使用后置 context 生成 `INSERT_BEFORE`。

### 6.4 整文件覆写优化

当前有多条路径会使用 `generateWholeFileReplaceXml()` 生成**单一整文件 REPLACE**，替代多个细粒度修改块：

- `file_write` full 模式差异率高于 `OVERWRITE_THRESHOLD = 0.7`，或处于 0.3~0.7 的中间区间并选择 overwrite
- `diffStore.loadModifications()` 检测到任意 `MATCH FAILED`，且存在 `preAppliedContent` 可用于降级
- Sub-Agent 多次修改同一文件时，`SubAgentDispatcher` 用首次原始内容 + 最新内容重建整文件 REPLACE，避免重复内容文件中的 Myers 对齐偏差

优点：

- `preview()` 只需一次匹配（非空原始文件通常能精确命中整文件 search）
- `FullFileDiffBuilder` 在该修改块内部做 Myers Diff，展示精确的行级变更

代价是降级后通常只剩 1 个修改块，用户无法再按原细粒度逐块审批，但面板展示会比“部分匹配失败”更可预期。

---

## 七、Diff 可视化界面

### 7.1 FullFileDiffViewer 组件

`FullFileDiffViewer` 是全文档 Diff 视图，以**完整文件**为展示单元，将修改区块内嵌其中，无变化区域可折叠：

```
┌─────────────────────────────────┐
│ 📄 Button.tsx          +5 -3   │  ← 文件头部（增删统计）
├─────────────────────────────────┤
│ 142 │  const label = "Old";    │  ← 折叠的上下文行（点击展开）
│ ... │  ... 38 lines hidden ... │
├─────────────────────────────────┤
│ 180 - const label = "Old";     │  ← 修改块（可逐个接受/拒绝）
│ 180 + const label = "New";     │
│              [✓ Accept][✗ Reject]│
├─────────────────────────────────┤
│ ... 更多上下文行 ...             │
├─────────────────────────────────┤
│     [✓ 全部接受] [✗ 全部拒绝]  │  ← 底部操作栏
│     待审批: 3 | 失败: 0         │
└─────────────────────────────────┘
```

渲染时从 `FullFileDiffBuilder.buildFullFileDiff()` 获取合并后的行列表（`FullFileDiffLine[]`），按类型分为三种渲染项：

| 类型 | 组件 | 说明 |
|---|---|---|
| `context-line` | `DiffLine` | 无变化的上下文行，显示行号 |
| `diff-block` | `DiffBlock` | 变更区块，含接受/拒绝按钮 |
| `collapsed` | `CollapsedLines` | 折叠的上下文行占位符，可点击展开 |

当前组件还包含两层性能保护：

- 当单个整文件 REPLACE 的任一侧超过 10,000 行，且增删变化超过 1,000 行时，`FullFileDiffViewer` 会显示大型 Diff 摘要，不再渲染完整行列表
- 普通 Diff 行列表通过虚拟滚动渲染，避免大文件 Diff 一次性挂载所有 DOM 节点

### 7.2 多文件支持

同一 Agent 上下文（`contextId`）内支持多个文件同时处于 Diff 模式。`diffStore` 通过 `fileEntries: Map<string, FileDiffEntry>` 为每个文件独立维护审批状态、Undo/Redo 栈和快照列表。切换活跃文件时，将当前文件状态保存回 `fileEntries`，再加载目标文件的状态到顶层字段。

---

## 八、快照系统

### 8.1 快照创建时机

| 时机 | 说明 |
|---|---|
| 首次加载 Diff | 创建 `Original file version`（同一文档只保留一个原始版本语义快照） |
| Sub-Agent 已写入内容后 | 若 `preAppliedContent` 与原始内容不同，创建 `Post-write version` |
| 用户接受单个修改后 | 记录接受后的文件状态，并保存当时的修改块状态 |
| 用户拒绝单个修改后 | 通过内容重建恢复该块原文，写回磁盘并创建快照 |
| 用户执行接受全部 | 创建最终应用结果快照 |
| 用户执行拒绝全部 | 恢复原始内容并创建快照 |
| 用户回滚到历史版本 | 更新当前激活快照，并据快照内容刷新 Diff 状态 |

`preview()` 本身只读，不创建快照。快照存储于 Rust 后端的 SQLite 数据库（通过 Tauri Command 调用），每个文档默认保留最近 **10 个**快照，超出时自动清理最旧的。

### 8.2 快照数据结构

除内容本身外，每个快照额外携带 `modificationStatuses`（修改块审批状态映射）：

```typescript
interface DocumentSnapshot {
    id: string;
    documentId: string;
    content: string;
    timestamp: Date;
    description: string;
    modificationStatuses?: Record<string, string>; // 索引 → 'pending'|'applied'|'rejected'|'failed'
}
```

这确保回滚到某个历史快照时，Diff 面板能**精确恢复**当时每个修改块的审批状态，而无需重新推断。

除快照表外，`diff_records` 还会保存：

- `xml_modification`：用于重启恢复未完成 Diff
- `active_snapshot_id`：记录当前停留的快照版本
- `modification_statuses`：部分审批后的修改块状态 JSON；恢复时优先级低于 active snapshot 自身的 `modificationStatusesJson`

### 8.3 快照面板（SnapshotHistory）

`SnapshotHistory` 组件以时间线形式展示历史快照列表，支持：

- 点击查看任意版本内容
- 回滚到历史版本（同时重建 Diff 面板状态）
- 删除不需要的快照

---

## 九、diffStore 状态管理

### 9.1 隔离策略

`diffStore`（Zustand store）按 `contextId`（Agent ID 或 Hub ID）**隔离** Diff 状态，使用 `Map<string, ContextDiffState>` 存储，与 `chatStore` 隔离策略一致。切换 Agent 时各自的 Diff 状态完全独立，互不干扰。

### 9.2 Undo/Redo 机制

每次接受或拒绝操作都会向 `undoStack` 压入一条 `HistoryEntry`，记录操作前后的完整内容和修改列表状态：

```
undoStack: [entry1, entry2, entry3]  ← 栈顶（最新操作）
redoStack: []                         ← 执行 undo 后，entry3 移入 redoStack
```

Undo/Redo 栈最大深度为 **50 条**，防止内存无限增长。

### 9.3 内容重建算法

用户拒绝某个修改块时，系统需要将磁盘文件恢复到「应用了其他块、但未包含被拒绝块」的状态。重建有两条路径：

**主路径（matchResult 重建）**：当所有修改块都有有效的 `startLine`/`endLine` 时，直接按行范围遍历原始内容，`rejected` 块保留原始行，其余块输出 `replace` 内容。

**兜底路径（Myers Diff 重建）**：当 matchResult 不可靠时（LLM 手写 search/replace 可能不精确），对原始内容和 LLM 写入内容运行 Myers Diff，再按 modification 顺序做 1:N 变更块分配，避免多个变更块重复关联到同一个 modification，最后选择性保留/恢复各块内容。

### 9.4 持久化

Diff 记录（`diff_records` 表）和快照在应用重启时可恢复：

- 启动/切换 Agent 时调用 `loadPersistedDiffs()`，从数据库读取 `pending` 状态的 Diff 记录
- 若存在 `active_snapshot_id`，优先读取该快照内容作为恢复目标
- 优先使用 `activeSnapshot.modificationStatusesJson` 恢复精确审批状态；其次使用 `diff_records.modification_statuses`
- 若无持久化状态，且磁盘内容等于 `preAppliedContent`，保持全部 `pending`（避免 Sub-Agent 刚写完就被误判为 applied）
- 若无持久化状态且内容已偏离 `preAppliedContent`，调用 `inferModificationStatus()` 基于当前文件内容启发式推断各块状态
- 若恢复时发现目标文件已不存在，会将对应 `diff_record` 标记为 `reverted` 并跳过 stale Diff

---

## 十、触发路径对比

当前代码中，`file_write` 是统一文件工具，已替代早期的 write/edit 拆分。`AgentService` 仍保留对 `file_edit` 类型 Diff 数据的兼容判断，但项目内置工具注册表不再注册独立 EditTool。

| | **file_write patch/merge 路径** | **file_write full/overwrite 路径** | **兼容 XML 路径** |
|---|---|---|---|
| 数据来源 | LLM 提供 `patches` 或小范围全文变化 | LLM 提供完整文件内容 | 外部/历史链路直接提供 XML 修改协议 |
| XML 生成 | `DiffToXmlConverter.diffToXml()`；Sub-Agent 返回 UI 时可能转成整文件 REPLACE | `generateWholeFileReplaceXml()`；普通模式可先返回覆盖预览 | 已是 XML，直接交给 `ProtocolParser` |
| 主要匹配策略 | UI `preview()` 禁用语义匹配；执行合并时可按引擎配置重新匹配 | 整文件 search 精确匹配为主，失败时无法细粒度恢复 | 由调用入口决定；当前 UI 预览同样禁用语义匹配 |
| 降级策略 | 匹配异常、无匹配、结果与目标全文不一致时降级 overwrite；UI 发现 MATCH FAILED 时降级整文件 REPLACE | 本身即整文件 REPLACE | 解析失败或匹配失败进入 failed/manual 状态 |
| 用户体验 | 成功时可细粒度审批；失败降级后变成单块审批 | 通常单块审批，但 `FullFileDiffBuilder` 内部仍展示行级变化 | 取决于 XML 粒度 |

---

## 十一、关键文件索引

| 文件 | 职责 |
|---|---|
| [`services/fast-apply/types.ts`](../../src/services/fast-apply/types.ts) | 所有类型定义（操作类型、匹配结果、Diff、快照、Patch 等） |
| [`services/fast-apply/FastApplyEngine.ts`](../../src/services/fast-apply/FastApplyEngine.ts) | 主引擎，协调解析、匹配、执行、Diff 和快照能力，导出单例 `fastApplyEngine` |
| [`services/fast-apply/FastApplyService.ts`](../../src/services/fast-apply/FastApplyService.ts) | UI 层封装，含 `generateEditInstructions()`、Diff 生成和快照管理 API |
| [`services/fast-apply/ProtocolParser.ts`](../../src/services/fast-apply/ProtocolParser.ts) | XML 协议解析，支持批量和混合文本提取 |
| [`services/fast-apply/ContentMatcher.ts`](../../src/services/fast-apply/ContentMatcher.ts) | 四级匹配策略（精确→正规化→模糊→语义） |
| [`services/fast-apply/MyersDiff.ts`](../../src/services/fast-apply/MyersDiff.ts) | O(ND) Myers Diff 算法，纯函数实现 |
| [`services/fast-apply/DiffGenerator.ts`](../../src/services/fast-apply/DiffGenerator.ts) | 将 Myers Diff 输出组织为带上下文的 hunks |
| [`services/fast-apply/DiffToXmlConverter.ts`](../../src/services/fast-apply/DiffToXmlConverter.ts) | DiffResult → XML 修改协议转换，并提供整文件 REPLACE XML |
| [`services/fast-apply/SnapshotManager.ts`](../../src/services/fast-apply/SnapshotManager.ts) | 快照 CRUD，通过 Tauri Command 与 Rust SQLite 后端交互 |
| [`services/fast-apply/ModificationExecutor.ts`](../../src/services/fast-apply/ModificationExecutor.ts) | 基于 matchResult 执行实际的字符串替换/插入/删除 |
| [`services/fast-apply/FullFileDiffBuilder.ts`](../../src/services/fast-apply/FullFileDiffBuilder.ts) | 将多个 ModificationApplyResult 合并为全文 Diff 渲染数据 |
| [`stores/diffStore.ts`](../../src/stores/diffStore.ts) | Zustand 状态管理，含内容重建、持久化、Undo/Redo、多文件/多上下文隔离 |
| [`components/diff/FullFileDiffViewer.tsx`](../../src/components/diff/FullFileDiffViewer.tsx) | 全文 Diff 视图主组件，支持折叠/展开、虚拟滚动、大型 Diff 摘要和逐块审批 |
| [`components/diff/SnapshotHistory.tsx`](../../src/components/diff/SnapshotHistory.tsx) | 快照历史面板，时间线展示和回滚操作 |
