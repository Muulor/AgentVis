# Master Brain 与 Sub-Agent 协同工作机制

> **文档定位**：面向发布的核心功能介绍，面向技术读者。  
> **覆盖范围**：MB/SA 协同执行框架、任务调度、上下文持久化、用户介入机制。

---

## 一、整体架构概览

AgentVis 的规划执行系统由两个角色协同驱动：

| 角色 | 职责 |
|------|------|
| **Master Brain（MB / 主脑）** | 战略决策层。感知全局上下文，决定下一步做什么、派谁去做 |
| **Sub-Agent（SA / 子智能体）** | 战术执行层。在严格边界内自主使用工具完成单项任务 |

两者由 **FSM（有限状态机）** 统一编排，构成一个完整的感知-决策-执行闭环：

```
USER REQUEST
      │
      ▼
AGENT SERVICE（FSM Owner）
  ├─ IDLE → PREPARE_CONTEXT → MASTER_DECISION → DISPATCH → OBSERVE → EVALUATE → ...
  │
  ├──── MASTER BRAIN         ← 战略决策（LLM 驱动，JSON 输出）
  ├──── SUB-AGENT POOL       ← 执行单元（ReAct 原子循环）
  ├──── TASK ARTIFACT STORE  ← 跨 SA 成果持久化（内存，30K token）
  └──── LOOP GOVERNOR        ← 预算管理、风险评估、进度追踪
```

---

## 二、FSM 驱动的执行框架

### 2.1 状态机节点

每一轮用户请求均触发一次完整的 FSM 运行周期，经过以下状态节点：

| 状态 | 功能 |
|------|------|
| `IDLE` | 等待用户输入 |
| `PREPARE_CONTEXT` | 组装上下文（对话历史、记忆、WORKDIR 快照、Task Artifacts 等） |
| `MASTER_DECISION` | 调用 MB LLM，获取结构化决策 |
| `DISPATCH` | 根据 MB 决策创建并派遣 SA；用户回复/追问类决策在本轮直接收口 |
| `OBSERVE` | 收集 SA 执行结果 |
| `EVALUATE` | LoopGovernor 评估预算/风险，决定循环或终止 |
| `TERMINATE` | 向用户返回最终结果 |

### 2.2 三层预算架构

系统在三个粒度上独立控制执行预算，防止失控：

| 层级 | 默认值 | 职责 |
|------|--------|------|
| **MB 决策预算** | 8 轮 | MB 最多做几轮 decide→dispatch→observe 循环 |
| **SA 执行预算** | 50 步/SA | 单个 SA 最多执行多少步（并行工具调用只算 1 步） |
| **FSM 安全阀** | 48 次状态步进 | FSM 步进次数硬终止（defense-in-depth） |

> SA 的"一步"= 一次完整的 LLM 决策轮，即一次 LLM 响应（无论其中包含多少并行工具调用）。

### 2.3 LoopGovernor 终止条件

`LoopGovernor` 按优先级评估是否终止整个循环，无论 MB 的意愿：

1. 连续 2 轮无进展（`consecutive_no_progress`）
2. 连续调用同一工具超过阈值（`tool_thrashing_detected`）
3. SA 创建数超限（`over_delegation`）
4. 累积风险超阈值（`risk_exceeded`）
5. MB 决策预算耗尽（`budget_exhausted`）

> `risk_exceeded` 是 LoopGovernor 中保留的评估分支；当前主执行路径传入的 `riskDelta` 为 0，实际运行中主要由无进展、工具震荡、委派数和预算耗尽触发收口。

---

## 三、Master Brain 决策系统

### 3.1 决策类型

MB 每次调用仅输出三种决策之一：

| 决策 | 说明 |
|------|------|
| `SPAWN_SUB_AGENT` | 派遣子智能体执行一项具体任务 |
| `REQUEST_MORE_INPUT` | 任务信息不足或存在任务边界，向用户请求补充 |
| `RESPOND_TO_USER` | 任务完成或无需 SA，直接回复用户 |

### 3.2 MB 的信息视野

MB 每次决策前会收到由 `MasterBrainInputBuilder.build()` 组装的上下文组合：

| 信息区块 | 内容 |
|---------|------|
| 对话历史 | 最近 10 轮用户/助手对话；更早内容通过 memory summary、RAG 和任务经验补充 |
| WORKDIR 快照 | 当前工作目录文件统计（总数、扩展名分布、最近修改 Top-5，约 200 tokens） |
| Task Artifact 索引 | 前序 SA 执行成果摘要（工具名+来源参数） |
| MB 决策历史 | 前序 MB 的 rationale 和派遣任务（战略连续性，优先使用 `[MB_DECISION_HISTORY]`） |
| SA 观测摘要 | 已完成 SA 的 observation、状态和工具调用摘要 |
| 工具目录 | 当前可用工具、内置技能、安装的 Guide/Script 技能目录 |
| 任务经验 | 历史执行过程中积累的试错经验（memory 系统） |
| 外部技能内容 | 语义检索命中的 Guide 技能，以及按需匹配的 Script 技能 |

#### 3.2.1 MB 输出与推理预算

MB 在同一个 provider 传输预算外设置了彼此独立的本地保护：结构化最终决策正文上限为
8,192 tokens；未知或非推理路由请求 16,384 transport tokens；推理与最终输出共享预算的
provider/model 路由请求 32,768；异常推理流另有 16,384 tokens 的硬熔断。

当 provider 明确拒绝 max-token 参数时，MB 只向下重试一档（32K→16K 或 16K→8K）。如果
请求已经被接受、只是以 `length` 或 `max_tokens` 结束，则属于输出耗尽，不走参数降级。

### 3.3 MB 决策输出契约

MB 输出采用“顶层决策元数据 + `nextStep` 决策载荷”的统一 wire protocol：

| 决策 | 必需载荷 |
|------|----------|
| `SPAWN_SUB_AGENT` | `nextStep.task` |
| `REQUEST_MORE_INPUT` | `nextStep.questionsForUser` |
| `RESPOND_TO_USER` | `nextStep.response` |

例如，直接回复用户时 MB 应输出：

```json
{
  "decision": "RESPOND_TO_USER",
  "rationale": "任务已经完成",
  "riskAssessment": { "level": "low", "notes": "无额外风险" },
  "nextStep": { "response": "面向用户的最终回复" }
}
```

`DecisionParser` 在协议边界继续兼容旧版根级 `response` / `questionsForUser`，随后规范化为应用内部既有的判别联合结构，避免把 wire protocol 迁移扩散到 FSM。仅当 canonical 字段完全缺失时才启用旧字段兼容；若 canonical 字段已显式出现但为空或类型非法，则分类为 `schema_invalid`。新旧位置同时存在但内容冲突时，系统不会猜测，而是将其分类为 `schema_invalid` 并使用共享的一次 MB 语义纠错额度重试。截断修复或激进修复得到的决策仍不会直接执行。

### 3.4 SPAWN_SUB_AGENT 决策内容

当 MB 决策派遣 SA 时，输出的 `nextStep` 结构由 `SubAgentSpecBuilder` JIT 构建为完整的 `SubAgentSpec`：

```typescript
interface SubAgentSpec {
  behaviorHint?: 'careful' | 'direct';  // 行为风格修饰符
  role: string;                          // 任务角色描述
  contextSummary?: string;              // 上下文摘要
  allowedTools: string[];               // 最终可用工具白名单
  terminationCondition?: string;        // 终止条件（可选）
  includeHistory?: boolean;             // 是否注入对话历史
  loopConfig?: SubAgentLoopConfig;      // 原子循环配置（自动推断）
}
```

**工具授权**采用“基础工具自动注入 + MB 按需扩展”的模式：系统会为 SA 自动加入 `read`、`local_search`、`web_search`、`exec`、`file_write` 等基础工具；MB 负责按任务需要补充特殊/扩展工具。最终执行时，`SubAgentRunner` 仍以 `allowedTools` 白名单拦截未授权工具调用。

---

## 四、Sub-Agent 执行机制

### 4.1 ReAct 原子事件循环

所有 SA 均采用 **ReAct（Reasoning and Acting）** 模式执行，循环控制权完全收归 `SubAgentRunner`：

```
while (!terminated && toolCallSteps < maxSteps) {
  
  Step A: 调用 LLM（callWithContext）
    ├── tool_use response → Step B
    └── text response    → 检测终止信号（TASK_COMPLETE）
                              └── terminated = true
  
  Step B: 执行工具（toolExecutor）
  
  Step C: 结果入栈（messages.push）
            └── storeToolResultAsArtifact()  ← 成功/失败结果均可自动存入 ArtifactStore
  
  [Checkpoint 触发]
    ├── 高风险操作前
    ├── 预算临近耗尽
    ├── 连续失败
    └── 定期检查机制保留（默认关闭）
}
```

#### 4.1.1 SA 输出预算与截断工具调用

普通 SA 首次请求 32,768 output tokens，为大型 function-call 参数保留更多空间。如果
provider 明确拒绝该 token 参数，Caller 使用完全相同的消息、工具和 session 以 24,576
重试一次，并在当前 Factory 后续步骤中记住降级。Skill 安全审计继续使用独立的 24,576
profile。

参数拒绝与 `length`、`max_tokens`、`MAX_TOKENS`、`incomplete` 等已接受但耗尽预算的结束
原因不同。后者会被标记为截断：后端在大参数暂存前丢弃该响应中的全部工具调用，Runner
不写入任何文件，并提示 SA 先创建短小完整骨架、再用 patch 模式分段填充长文件。若再次
截断，则以失败状态交回 MB 决策。

### 4.2 behaviorHint 行为修饰符

| 值 | 含义 | 适用场景 |
|----|------|---------|
| `'careful'` | 谨慎模式，每步验证 | 复杂分析、风险操作 |
| `'direct'` | 直接模式，高效执行 | 明确的文件操作、简单任务 |
| 未设置 | 通用模板 | 大多数常规任务 |

### 4.3 工具风险守卫

SA 执行工具时，`ToolRiskGuard` 按风险等级处理（非阻塞），同时 `SubAgentRunner` 会对部分工具应用额外安全策略：

| 风险等级 | 工具 | 处理方式 |
|---------|------|---------|
| `high` | `exec`, `external_skill_execute` | 可能触发 Checkpoint；`exec` 安全命令可跳过前置审批，危险命令直接阻断 |
| `medium` | `file_write`, `cron`，以及未登记工具 | 日志记录；`file_write` 主要走授权和 diff/写入链路 |
| `low` | `read`, `web_search`, `generate_image`, `local_search`, `im_send`, `feishu`, `slack` | 无额外处理 |

---

## 五、Checkpoint — MB 对 SA 的实时监督

SA 会在关键节点触发 Checkpoint，暂停执行并将当前状态上报给 MB 评估。当前默认活跃触发包括：高风险操作前、预算临近耗尽、连续失败；周期性 Checkpoint 机制仍保留，但默认间隔设置为 `maxSteps + 1`，等价于默认不主动周期触发。

### 5.1 Checkpoint 决策

MB 评估后返回三种决策之一：

| 决策 | 效果 |
|------|------|
| `EXTEND_BUDGET` | 增加迭代次数，继续执行 |
| `ADJUST_STRATEGY` | 注入新指令 + 进度摘要，改变执行方向 |
| `TERMINATE_SUB_AGENT` | 立即停止，返回已收集结果 |

### 5.2 越权与意图漂移检测

MB 在 Checkpoint 评估时同时进行：
- **越权检测**：SA 操作了委派范围之外的资源 → `TERMINATE_SUB_AGENT`（`scope_violation`）
- **意图漂移**：SA 下一步工具调用与任务目标无关 → `ADJUST_STRATEGY` 或 `TERMINATE_SUB_AGENT`

---

## 六、SA 上下文管理（三级递进）

SA 内部维护一个完整的 `messages[]` 消息栈作为事实单一来源（Single Source of Truth）。随着执行步骤增加，上下文压力触发分级管理：

| 级别 | 触发条件 | 动作 |
|------|---------|------|
| **L1 梯度压缩** | 单条工具输出超过阈值，或整体上下文超过 85% 进入 pressure mode | 工具输出按 8K/12K 分级压缩；压力模式下更积极压缩旧 tool 消息，保护近期关键内容 |
| **L2 上下文重置** | Token > 总窗口 45% 且剩余步数 ≥ 3 | SA 输出结构化摘要 → 清空历史 → 注入摘要继续 |
| **L3 预算警告** | 步数占比 > 85% / 95% | 注入收尾提示 / 最终警告 |

### L2 上下文重置流程

```
Step N:   Token > 45% → Runner 注入 CONTEXT_RESET_INSTRUCTION
Step N+1: SA 输出 ---CONTEXT_SUMMARY--- 结构化摘要
            → Runner 拦截摘要
            → 清空 messages[]（保留 system prompt）
            → 注入摘要为新 user message
Step N+2: SA 从摘要继续执行未完成任务
```

L2 支持**无限次**重置，步数计数不归零，总预算控制始终有效。

---

## 七、Task Artifact — 跨 SA 成果持久化

### 7.1 问题来源

SA 执行失败后 MB 重新派遣新 SA，新 SA 无法获取前序 SA 的中间成果（如搜索结果、文件内容），导致重复劳动。

### 7.2 自动收集策略

SA 执行工具后，`SubAgentRunner.storeToolResultAsArtifact()` 按工具类型自动提取并写入 `TaskArtifactStore`，成功和失败结果都可能被保留，**无需 LLM 显式指令**：

| 工具 | 最大保留 |
|------|---------|
| `web_search` | 3000 字符 |
| `read` / `file_read` | 1500 字符 |
| `exec` | 500 字符 |
| `file_write` | 200 字符 |

Store 采用 FIFO 淘汰，总预算上限 30K tokens。

### 7.3 双层注入

收集到的 Artifacts 通过双通道注入后续决策链：

| 注入目标 | 数据 | 用途 |
|---------|------|------|
| **MB Prompt** | 轻量索引（工具名 + 来源参数） | 指引 MB 派遣新 SA 时告知其利用已有成果 |
| **SA Prompt** | 完整 Artifact 内容（前序任务成果 Section） | 新 SA 直接读取前序搜索结果或文件内容，无需重复执行 |

### 7.4 生命周期

- **创建**：`AgentLoopFSMIntegration` 构造时初始化
- **写入**：工具调用结果返回后自动写入（成功/失败均可保留）
- **清空**：每次用户发送新消息时重置（一次完整对话轮次对应一个生命周期）

---

## 八、HITL — 用户步间介入机制

### 8.1 机制概述

SA 执行期间，用户可以随时点击「⏸ 暂停」，待 SA 完成当前步骤后暂停，输入调整指令后恢复执行。整个过程无需终止任务。

```
UI（HitlInterventionBar）
    │ pause(contextId)
    ▼
hitlStore（Zustand）
    │ pausedContexts.add(contextId)
    │
SubAgentRunner（步间检查点）
    │ while (!terminated) {
    │     checkAbortSignal()     ← 终止优先
    │     isPaused()             ← HITL 检查点
    │     waitForResume()        ← 阻塞等待用户指令
    │     callLLM()
    │     executeTools()
    │ }
    │
    │ 用户输入介入消息 → resume(contextId, message)
    ▼
    ├── 注入 additionalInstructions   ← 当前 SA 下一步 LLM 调用可见
    ├── 写入 messages[]               ← 作为持久 user 消息保留在当前 SA 上下文
    ├── 写入 TaskArtifactStore        ← 跨 SA 持久化（类型 user_intervention）
    └── emitObservation               ← UI 时间线展示用户介入事件
```

### 8.2 介入持久化

用户介入消息写入 `TaskArtifactStore`，确保 MB 和后续所有 SA 都能感知该介入：

- MB Prompt 中渲染介入告警块，提醒 MB 将用户调整指令纳入后续 SA 的任务描述
- SA 观测时间线中，介入消息精准出现在对应步骤之后（而非浮在顶部）
- 当前 SA 后续每次 LLM 调用都会在安全尾注后追加持久化的用户介入指令，保证其优先级

### 8.3 竞争条件处理

用户可能在 LLM 调用期间（`waitForResume` 尚未调用前）就点击恢复，产生 race condition。系统通过 `preResolvedMap` 机制处理：

| 场景 | 处理 |
|------|------|
| 正常：`waitForResume` 先等待，用户后恢复 | `resume()` 找到 resolver，直接调用 |
| 竞争：用户恢复在 `waitForResume` 调用之前 | 消息暂存 `preResolvedMap`，`waitForResume` 启动时立即消费 |

---

## 九、跨请求上下文持久化

### 9.1 问题背景

任务执行过程可能因网络断开、API 错误或用户主动停止而中断。若 MB 的决策过程（rationale）和 SA 的执行进展（observations）丢失，下一轮用户消息（如「请继续」）将导致 MB 从零重新规划，已完成的工作付之东流。

### 9.2 注入内容

任务结束时，系统会在需要跨请求恢复的收口路径中，将以下内容注入到 assistant 消息的持久化版本中。正常最终回复已有用户可见内容时通常不额外注入；取消、异常兜底、空结果兜底等路径会依赖该机制保留内部进展：

```
MB 决策进度（系统注入，供下轮决策参考）：
{MB rationale 完整版}

MB 上次派遣任务（系统注入）：
{最后派遣的 task 描述}

最后一次 SA 执行进展（系统注入）：
{SA observations 最新 1200 字符}
```

### 9.3 三层持久化防线

| 层级 | 位置 | 职责 |
|------|------|------|
| **数据层** | `metadata.persistContent` | chatStore 和 DB 中同时保留完整内容（含 rationale），供下轮 historyMessages 读取 |
| **结果层** | `buildResult.content` | 返回给 UI 的版本已剥离 rationale，用户不可见 |
| **渲染层** | `MessageBubble.tsx` | 从 DB 加载历史消息时再次剥离（最后防线） |

### 9.4 数据分叉问题的解决

原架构中 chatStore（UI 用）和 DB（持久化用）存储的内容不一致：chatStore 存 UI 剥离版，DB 存完整版。下一轮请求从 chatStore 构建 historyMessages，导致 rationale 丢失。

**解决方案**：在 `messageMetadata` 中单独冗余存储 `persistContent`，`historyMessages` 构建时优先读取 `metadata.persistContent`，绕开数据分叉：

```
chatStore.content          = finalContent       （UI 展示用，已剥离 rationale）
chatStore.metadata.persistContent = 完整版      （上下文恢复用）
historyMessages 构建        ← 优先取 metadata.persistContent ✅
```

### 9.5 取消场景的处理

用户点击停止按钮时，系统执行完整的持久化链路（而非丢弃）：

```
用户点击停止 → cancel() → 统一收口点注入 rationale
  → buildResult('cancelled') 返回 success=true
  → usePlanningMode 走正常 assistant 消息路径
  → metadata.persistContent 包含 rationale
  → 下一轮 MB 恢复上下文 ✅
```

---

## 十、MB 战略连续性

### 10.1 SA 报告语义围栏

MB 串行派遣多个 SA 时，SA 完成报告在 session 中先作为 `role: tool` 的消息保存；组装给 MB LLM 时再转换为 `role: user`（LLM 协议限制）。为防止 MB 将 SA 报告误判为用户新消息，系统自动包裹语义围栏：

```
[SYSTEM: 以下是 Sub-Agent (工具名) 的执行完成报告，这不是用户消息]
...报告内容...
[END_SA_REPORT]
```

### 10.2 [MB_DECISION_HISTORY] 战略连续性注入

MB 每次 `SPAWN_SUB_AGENT` 决策后，`rationale` 和 `task` 保存到 `SharedState`，下一轮 MB 调用时注入 System Prompt：

```
[CONVERSATION_HISTORY]
  ...用户对话历史...

[MB_DECISION_HISTORY]   ← 前n轮 MB 的决策上下文
  ...
  第n轮决策理由：...
  第n轮下发给 SA 的任务：...
  ...

[TASK_ARTIFACTS]
  ...SA 执行成果索引...
```

`[MB_DECISION_HISTORY]` 不参与 token 预算截断，确保 MB 在预算紧张时也能保持战略一致性。

---

## 十一、任务经验记忆

SA 完成复杂任务后，若报告中包含 `## EXECUTION_EXPERIENCE` 标记，系统自动提取并写入长期记忆（SQLite `task_experience` 类别）：

- ✅ 适合记录：环境配置踩坑、路径兼容性问题、发现更高效的执行方式
- ❌ 不记录：一切顺利的场景

经验在下一次用户请求时自动注入 MB 和 SA 的 Prompt，帮助避免重蹈覆辙。

---

## 十二、Prompt 构建管线全景

```
SubAgent System Prompt 组装顺序（SubAgentPromptBuilder）
  1. BASE_TEMPLATE          ← 角色/禁止行为/输出格式
  2. getBehaviorTemplate()  ← behaviorHint 修饰符
  3. LOOP_EXECUTION_GUIDANCE← 循环执行指导（仅 loopConfig）
  4. agentRules             ← 用户自定义规则（条件）
  5. 当前时间               ← 时间感知
  6. buildSandboxRuntimeSection() ← 沙箱/运行时说明（条件）
  7. buildInputProtocol()
     ├── 背景上下文          ← contextSummary（条件）
     ├── 用户对话历史        ← conversationHistory（条件）
     ├── HITL override       ← 用户介入指令（条件）
     ├── 前序 SA 报告        ← previousSubAgentReports（条件）
     ├── 前序任务成果        ← Task Artifact 快照（条件）
     └── 终止条件           ← terminationCondition（条件）
  8. buildTaskExperienceSection() ← 历史经验注入（条件）
  9. buildToolSection()     ← 可用工具/SKILL.md 内容注入
 10. buildExternalGuideSection() ← Guide 技能注入
 11. buildExternalScriptSkillSection() ← Script 技能注入（条件）
 12. buildVenvConstraintSection() ← Python 环境约束
 13. buildPlatformInfoSection() ← Windows 命令约束（条件）
 14. TOOL_CALL_SELF_CHECK   ← CoT 自检（仅 Loop，尾部）

每步 LLM 调用时额外追加：
  [user 尾部] SAFETY_FOOTER_TEXT ← 始终在 context 最后，对抗注意力稀释
```

**SAFETY_FOOTER 的设计意图**：每步 LLM 调用时将安全约束附加到 user 消息尾部，确保无论 SA 执行多少步，约束始终处于 context 最后几百 token 的注意力热区，彻底规避"Lost in the Middle"问题。

---

## 总结：信息流全景图

```
用户消息
    │
    ▼
[PREPARE_CONTEXT]
  最近对话 + memory/RAG + WORKDIR快照 + Artifact索引 + MB决策历史 + 任务经验 + Guide/Script技能
    │
    ▼
[MASTER_DECISION]（MB LLM）
    │
    ├─ SPAWN_SUB_AGENT
    │     │ 基础工具自动注入 + MB扩展授权 + 行为修饰符 + 任务描述
    │     ▼
    │  [DISPATCH] → SubAgentFactory → SubAgentRunner
    │     │         完整System Prompt（含Artifact快照 + SKILL.md）
    │     │
    │     │  ReAct 原子循环（LLM → 工具 → 结果入栈 → Artifact写入）
    │     │  ├── Checkpoint → MB评估（越权/漂移检测）
    │     │  ├── L1/L2/L3上下文管理（压缩/重置/预算警告）
    │     │  └── HITL步间检查点（用户可随时介入）
    │     │
    │     ▼
    │  SubAgentOutput（observations + toolCalls + status）
    │     │
    │  [OBSERVE] → [EVALUATE]（LoopGovernor 预算/风险评估）
    │     │
    │     └─ 继续 → 下一轮 [MASTER_DECISION]（携带新Artifact索引）
    │
    └─ RESPOND_TO_USER
          │ 必要时注入MB rationale + task + SA observations
          ▼
       持久化（metadata.persistContent 跨请求保全）
          │
          ▼
       用户可见回复（已剥离内部决策信息）
```
