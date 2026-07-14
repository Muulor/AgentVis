# AgentVis Agent 行为安全防护机制

---

## 概述

Agent 具备调用 Shell 命令、读写文件、搜索网络等真实副作用能力。为防止 Agent 误操作或被恶意 Prompt 劫持，系统构建了**纵深防御**体系，分布在五层防护中：

1. **LLM 行为软防护层**（Prompt 层 + FSM 层）：引导和约束 Agent 的决策行为
2. **TypeScript 工具拦截层**：在工具调用落地前做快速拦截与分级处理
3. **Rust 命令校验层**：作为命令执行的最后一道不可绕过的硬阻断防线
4. **进程 / 网络沙箱与审计层**：运行时防护层，通过 Job Object、Restricted Token、AppContainer、broker/proxy 与网络策略为 shell / Skill 执行增加可控约束
5. **Agent Trash Bin 软删除层**：在 Rust 层通过之后、OS 真正删除之前，将删除操作透明重写为"移动到回收站"，实现删除可恢复

各层相互协作，形成「软防护 → TS 快速反馈 → Rust 硬阻断 → 沙箱约束与审计 → 软删除兜底」的完整防御链。

---

## 一、LLM 行为软防护

软防护并不阻止命令执行，而是通过 Prompt 约束和 Agent 架构设计，从根本上减少 Agent 产生危险行为的概率。

### 1.1 Master Brain 决策约束

**文件**：`src/services/planning/brain/MasterBrainPrompt.ts`

MasterBrain（主脑）是 Agent 系统的顶层决策者。其 System Prompt 中明确写入了行为优先级约束：

```
优先级：安全性 > 进度 > 优雅性
```

MasterBrain 负责拆解任务并将 Sub-Agent（子执行体）的工具能力按需开放。当前实现中，`read`、`local_search`、`web_search`、`exec`、`file_write` 是 SA 基础工具，会由 `SubAgentSpecBuilder` 自动补全到 `allowedTools`；`nextStep.tools` 主要用于 MB 显式授权特殊/扩展工具（如 `cron`、`generate_image`、`external_skill_execute`）。SA 运行时仍会校验 `allowedTools`，拦截未授权或幻觉工具调用。

**风险评估字段**：MB Prompt 要求每次决策输出 `riskAssessment`，包含风险等级（low/medium/high）和潜在风险点。解析器对 `SPAWN_SUB_AGENT` 仍要求该字段；对 `RESPOND_TO_USER` / `REQUEST_MORE_INPUT` 等非操作型决策缺失时会填充默认 low。当前主执行流暂不把 MB 的 `riskAssessment` 直接映射为 LoopGovernor 的 `riskDelta`，全局 `risk_exceeded` 分支保留为扩展位，实际运行时风险主要由工具级策略、Checkpoint、Rust 校验和沙箱审计承担。

**行为模式约束**：MB Prompt 内置 `behaviorHint` 派遣参数，对涉及用户数据、隐私等敏感任务强制设定为 `careful`，对编码、查询类任务允许 `direct` 模式。

### 1.2 LoopGovernor 循环治理器

**文件**：`src/services/planning/agent-loop/LoopGovernor.ts`

LoopGovernor 是 FSM 驱动的 Agent 执行循环的内部"熔断器"，负责在以下五种异常模式下自动终止 Agent 执行：

| 终止条件 | 优先级 | 说明 |
|---------|--------|------|
| `consecutive_no_progress` | 1（最高） | 连续 2 次循环无实质进展，防止 Agent 无效空转 |
| `tool_thrashing_detected` | 2 | 连续 N 次（默认 3）调用同一工具，防止死循环振荡 |
| `over_delegation` | 3 | 子 Agent 派遣次数超过预算上限（默认随 MB 决策预算 8 轮同步，除非显式覆盖） |
| `risk_exceeded` | 4 | 累积风险分数超过阈值（默认 0.8；当前主流程暂不接入 MB `riskAssessment`，属于预留扩展位） |
| `budget_exhausted` | 5 | MB 决策轮次预算耗尽（默认 8 轮；FSM 步进硬安全阀默认为 48）|

```typescript
// 工具震荡检测：最后 N 次是否重复调用同一工具
private detectToolThrashing(): boolean {
    const lastN = history.slice(-threshold);
    return lastN.every((tool) => tool === lastN[0]);
}
```

### 1.3 Sub-Agent 预算双重管控

Sub-Agent 在 `runAtomicEventLoop` 中受到两级预算约束：

- **步数预算**（`maxSteps`）：主预算，当前默认 50 步；一步表示一次 LLM 决策/工具执行轮，并行工具调用只算 1 步
- **工具调用硬上限**（`TOOL_CALLS_HARD_LIMIT`）：全局上限，当前默认 200，防止单步并行调用大量工具绕过步数预算

当预算消耗达到 85% 时注入警告指令，达到 95% 时注入最终强制结束指令；临近耗尽（默认剩余 ≤ 5 步且已消耗 ≥ 85%）还会触发预算 Checkpoint，MB 可在单次最多追加 20 步、单个 SA 最多追加 2 次。

```
🛑 这是你的最后一步行动。请立即总结已完成的工作或交接，并输出 TASK_COMPLETE。不要开始新的操作。
```

### 1.4 Human-in-the-Loop（HITL）介入机制

**文件**：`src/stores/hitlStore.ts`

用户可在 FSM 可视化面板中随时点击「⏸ 暂停」，挂起正在运行的 SA。SA 在**每步 LLM 调用之间**检测暂停信号，保证消息历史完整性。

用户介入消息通过三重机制确保 SA 持续遵守：

1. **当步 `additionalInstructions`**：立即作用于下一次 LLM 调用
2. **持久化热区注入**：每步 LLM 调用都将介入消息写入 `SAFETY_FOOTER` 之后的“尾部热区”，确保不被执行惯性冲淡
3. **`messages[]` 永久追加**：以 `user` 角色消息永久写入上下文，防止 SA 后续步骤回归旧执行路径

当工具调用期间出现用户授权弹窗、长命令等待或任务终止信号时，Runner 必须先把已经返回的工具结果写入 `messages[]`、实时 observation 和 `TaskArtifactStore`，再处理中断退出。这样可以避免“工具已有结果，但 SA 因快速授权 / checkpoint / 取消信号导致最后一条 observation 或 TaskArtifact 丢失”的竞态。

---

## 二、TypeScript 工具拦截层

TypeScript 层在工具调用真正落地前，实现两种核心防护：命令分类分流与绝对禁止黑名单前置拦截。

### 2.1 工具风险等级注册表

**文件**：`src/services/planning/tools/ToolPolicyManager.ts`

系统对所有 Native 工具预定义风险等级：

| 工具 | 风险等级 | 说明 |
|------|---------|------|
| `read` | low | 只读操作，无副作用 |
| `web_search` | low | 只读操作，无副作用 |
| `local_search` | low | 只读操作，无副作用 |
| `generate_image` | low | 仅写入 deliverables 目录，可撤销 |
| `file_write` | medium | 写入操作，有 fast-apply 快照兜底 |
| `cron` | medium | 可撤销的定时任务管理 |
| `exec` | **high** | 系统命令执行，可能有不可逆副作用 |
| `external_skill_execute` | **high** | 外部 Script Skill 统一执行入口，会执行技能包脚本 |
| `im_send` | low | IM 消息发送统一工具 |

`feishu_send` / `slack_send` 在注册表中仍保留为低风险兼容桥接，但 Agent 侧实际暴露和推荐使用的是统一的 `im_send`。

`ToolRiskGuard.requiresCheckpoint()` 用于判断工具风险等级并为工厂验证、日志和测试提供统一依据。需要注意：当前 Runner 并不是对所有 high 工具通用套用该方法；运行时前置 Checkpoint 的主要触发点是非安全 `exec` 命令，以及未在 `allowedTools` 中授权却被调用的 `file_write`。

### 2.2 ExecSafetyPolicy 命令三分流

**文件**：`src/services/planning/skills/exec/ExecSafetyPolicy.ts`

在 Sub-Agent 执行 `exec` 工具时，命令先经过 TS 层三路分流：

```
命令输入
│
├─ isExecCommandBlocked() → true  ──→ 🛑 绝对拒绝（不进 Checkpoint，不调 shell_execute）
│
├─ isExecCommandBlocked() → false
│   └─ isExecCommandSafe()  → true  ──→ ✅ 安全命令：跳过用户授权与 MB 高风险 Checkpoint
│   └─ isExecCommandSafe()  → false ──→ ⚠️ 非安全命令：进入高风险路径，由 Runner/授权/Rust/沙箱链路继续约束
```

当前实现中，Runner 的 MB 高风险前置 Checkpoint 会在已有工具调用历史后拦截非安全 `exec`；首个非安全 `exec` 仍会经过 exec 工具授权、Rust `command_validator`、脚本扫描、沙箱策略和 Trash Bin 等后续防线。也就是说，TS 三分流是高风险路径入口，不应理解为“每一条非安全 exec 都一定先触发 MB LLM Checkpoint”。

**黑名单（`BLOCKED_EXEC_PATTERNS`）**：使用正则 `\b` 词边界做精确匹配，覆盖以下威胁类型：

| 类别 | 示例 |
|------|------|
| 磁盘/分区销毁 | `diskpart`, `format C:`, `cipher /w` |
| 系统启动破坏 | `bcdedit` |
| 用户/服务管理 | `net user`, `net stop`, `sc delete` |
| 注册表破坏 | `reg delete`, `reg add HKLM` |
| Base64 混淆 | `-EncodedCommand`, `-enc` |
| 环境变量永久修改 | `setx /M`, `[Environment]::SetEnvironmentVariable` |
| 注册表路径直写 | `Session Manager\Environment` |
| ACL + 系统目录 | `icacls/cacls/Set-Acl` + `system32/windows` 组合 |

**白名单（`SAFE_EXEC_PATTERNS`）**：使用正则匹配常见无副作用操作，允许直接放行：
- Git 只读操作（status/log/diff/branch 等）
- 文件浏览（ls/dir/cat/grep/find）
- 构建工具（`cargo build/test`, `npm run build`, `go test`）
- 版本查询（`node --version`, `pip list` 等）
- 脚本执行（python/powershell/bash，真正危险命令已被黑名单前置拦截）

### 2.3 已批准工具静默放行优化

**文件**：`src/services/planning/sub-agents/SubAgentRunner.ts`

```typescript
// 已批准的高风险工具集合：首次 Checkpoint 批准后，同类工具后续调用静默放行
const approvedHighRiskTools = new Set<string>();
```

技能包场景（如 `agent-browser`）中，同类工具（exec）可能在单次任务中被调用数十次。系统设计了"一次批准，同类放行"机制：首次 Checkpoint 审批通过后，后续同类工具名会加入 `approvedHighRiskTools`，不再重复触发 MB LLM 调用（每次 10-24s）。该缓存粒度是**工具名**而不是具体命令内容，因此仍需要依赖 TS 黑名单、Rust 硬校验、脚本扫描、沙箱审计等后续防线兜底。

---

## 三、Rust 命令校验层（最后防线）

**文件**：`src-tauri/src/commands/command_validator.rs`

Rust 层是系统的**最后一道防线**，在命令真正由操作系统执行前进行硬阻断。其设计原则是"宁误报不漏检"，使用 `contains()` 子串匹配而非正则词边界，确保即使 TS 层被绕过也无法执行危险命令。

### 3.1 六阶段校验流水线

`shell_execute` 当前优先调用 `validate_command_safety_with_workdir()`，在执行以下校验时会用真实 `workdir` 解析相对删除/写入目标；`validate_command_safety()` 仍作为不带 workdir 的兼容入口。整体优先级如下：

```
输入命令（已转小写）
│
Step 1: 绝对禁止命令黑名单（contains 匹配）
│       命中 → Err(AppError::Forbidden) 立即阻断
│
Step 2: format 磁盘命令精确检测
│       format + 盘符 → 阻断（避免误报 Python str.format()）
│
Step 3: wmic + 写入子命令 组合阻断
│       wmic 只读查询（get/list）→ 放行
│       wmic + delete/create/set/call → 阻断
│
Step 4: icacls/cacls + ACL 修改参数 + 核心目录 三元组合阻断
│       + PowerShell Set-Acl + 系统目录 阻断
│
Step 5: 破坏性动词 + 核心保护目录 组合阻断
│       + 破坏性动词 + 用户自定义保护目录 阻断
│
Step 6: 写入重定向（>/>> /Out-File/Set-Content）+ 自定义保护目录 阻断
│
OK(())  → 命令可以执行
```

### 3.2 核心保护目录（静态）

内置系统级不可更改的保护路径，防止命令通过环境变量形式绕过：

```rust
const PROTECTED_PATHS: &[&str] = &[
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
    "system32",
    "syswow64",
    "%systemroot%",      // 环境变量形式防绕过
    "%windir%",
    "%programfiles%",
    "%programfiles(x86)%",
    "\\windows\\system32",
    "\\windows\\syswow64",
];
```

### 3.3 自定义保护目录（动态热更新）

**配置文件**：`{app_data_dir}/protected_paths.json`，JSON 字符串数组格式：

```json
["D:\\重要备份", "E:\\项目存档"]
```

系统使用全局 `RwLock<Option<Vec<String>>>` 缓存自定义路径，首次调用时从磁盘加载并缓存。用户通过 UI 修改保护目录后，调用 `reload_custom_protected_paths()` 即时刷新缓存，无需重启应用。

自定义保护目录同时生效于：
- **破坏性动词防护**：`del`/`rmdir`/`remove-item` 等
- **写入重定向防护**：`>`/`>>`/`Out-File`/`Set-Content`/`Copy-Item` 等

### 3.4 文件写入路径保护

`validate_path_write_safety()` 在 `file_write_to_path` 等 Tauri 文件写入/导入命令中调用，使用路径**前缀匹配**（非子串匹配）保护自定义目录及其所有子路径：

```rust
// 额外检查分隔符边界，避免 "D:\\important" 误匹配 "D:\\important_other"
if file_str.starts_with(&protected_normalized) {
    let after = &file_str[protected_normalized.len()..];
    if after.is_empty() || after.starts_with('\\') || after.starts_with('/') {
        return Err(AppError::Forbidden(...));
    }
}
```

#### 右侧工作区事务式导入

从右侧工作区拖入文件或文件夹时，前端按 2 MiB 分块传输，Rust 后端将完整批次先写入当前文件系统中的内部 staging，再提交到目标目录。staging 根和 UUID 会话目录都带有 AgentVis 所有权标记，实际载荷位于独立的 `payload/`；若工作区已存在无有效标记的同名 `.agentvis-importing`，导入会 fail closed，既不接管也不清理该用户目录。

提交前会持久化 commit guard。多个顶层项目移动失败时，后端逆序回滚并检查每一次恢复结果：全部恢复成功才报告整批已回滚；任一恢复失败则保留 staging、恢复记录和仍需检查的工作区路径，前端刷新文件列表并提示用户检查，不再声称完整回滚。进入提交阶段前可以取消；commit guard 建立后进入不可取消阶段，由后端独占提交或保留恢复现场。

过期清理只处理同时满足“合法 UUID、精确 session marker、非活动、超过 24 小时、无 commit guard、无 recovery 记录”的 AgentVis 自有会话。锁状态异常、符号链接、marker 缺失或损坏时一律停止清理。

诊断方面，前端将取消/错误回滚 IPC 标记为 `workspace-import:cancel` renderer health 阶段；分块字节进度以 100 ms 为最小间隔合并，但初始状态、每个文件/目录完成和提交阶段立即上报。Rust 对所有自有 staging 删除记录 `reason`、`duration_ms` 和结果，达到或超过 1 秒的成功删除以及所有删除失败都会写入 warning 日志。

### 3.5 脚本内容静态扫描

`validate_script_content()` 在 exec 执行脚本文件前调用，读取脚本源码并扫描危险 API：

**支持扫描的文件类型**：`.ps1`、`.bat`、`.cmd`、`.py`、`.cs`、`.vbs`

**脚本内容禁止关键字（`SCRIPT_CONTENT_FORBIDDEN`）**：

| 关键字 | 威胁说明 |
|--------|---------|
| `setenvironmentvariable` | PowerShell/.NET 永久修改系统/用户级环境变量 |
| `session manager\environment` | 通过注册表路径直接写系统级环境变量 |
| `diskpart`, `bcdedit` | 磁盘分区/启动配置破坏 |
| `cipher /w` | 不可逆磁盘覆写 |
| `takeown`, `sfc /` | 系统权限突破 |
| `net user`, `sc delete` | 用户/服务管理 |
| `reg delete`, `reg add hklm` | 注册表破坏 |

脚本路径提取支持多种调用模式：
- `powershell -File script.ps1`
- `python script.py` / `python3 -u my_script.py`
- `csc.exe source.cs`（C# 编译器，扫描源码）
- 直接调用：`./setup.bat`、`install.cmd`

---

## 四、进程 / 网络沙箱与安全审计

**文件**：`src-tauri/src/commands/process_sandbox.rs`

在 Rust shell 执行链路中加入运行时沙箱策略，定位是“降低误操作和外部脚本副作用”，不替代命令黑名单、脚本扫描和 Trash Bin。产品层只暴露三档用户权限：**本机审计模式**、**离线隔离模式**、**受控联网模式**；内部 enum 保持 `LocalAudit` / `OfflineIsolated` / `ControlledNetwork`，后端的 `standard` / `externalSkill` / `installer` / `preview` / `restricted` 仍作为技术 profile 和审计归因使用。

> 重要边界：Job Object 不是“沙箱开关”，只负责托管型命令的生命周期清理。本机审计模式下的 GUI / detached launch 不应挂入带 `KILL_ON_JOB_CLOSE` 的 Job Object，避免 Chrome、VS Code、explorer 等外部应用在启动后被误杀。

### 4.1 执行 profile 与默认网络策略

| profile | 典型来源 | 默认网络策略 | 说明 |
|---------|----------|--------------|------|
| `standard` | 普通 `exec` | `inherit` | 不改变普通 shell 的联网行为 |
| `externalSkill` | 外部 Script Skill | `audit` | 默认不直接阻断，但扫描命中会写入审计事件 |
| `installer` | Skill 安装 / 依赖安装 | `inherit` | 安装阶段允许下载依赖 |
| `preview` | 内置 Project Preview | `inherit` | 网络保持可用；文件/执行面另由独立 staging、输入 allow-list 和 owned PID 收口 |
| `restricted` | 高风险 / 强隔离执行 | `blocked` | 启用更严格的进程与网络约束 |

`preview=inherit` 不代表直接信任 Agent 项目。内置 Project Preview 不在交付目录执行、不执行 npm lifecycle scripts，也不以端口扫描推断进程所有权；片段模式只执行 AgentVis 模板配置，完整项目模式则会在 staging 中执行项目 Vite/PostCSS/Tailwind 配置以保留插件、alias 和 CSS 工具链语义。它通过 app-cache staging、路径/依赖/资产预算（包括 256 KiB manifest 与 128 依赖上限）、Import Map native-JS-only fail-closed 预检、AgentVis 包装服务器配置、per-run health token 和 registry PID 生命周期提供专用边界。staging 由 Rust 原生命令创建并返回 `runId`/`ownerToken`，`.agentvis/active` 精确绑定该身份，跨实例文件 lease 保护活跃 workspace。正常清理还必须证明并释放本进程 registry lease，不能仅凭另一个实例的 marker/token 删除其 workspace；通过 app-cache 直接子目录、UUIDv4、链接/reparse 与 canonical containment 校验后，才原子隔离并 no-follow 删除，junction 只删链接。陈旧清理要求至少 24 小时且成功取得 lease，并以原生有界分页执行；部分删除遗留的 `.trash-{UUIDv4}` 仅凭严格配对且至少 24 小时的 root receipt 自回收。前端 backlog 有上限且每次只重试固定数量。完整项目配置是当前用户权限下的可执行 Node 代码，Local Audit 不构成 OS 级 VM；该边界不应被表述为任意不可信构建配置的强隔离、浏览器网络 DLP 或完整虚拟机隔离。

共享 Preview 模板还使用按模板划分的 OS 跨进程排他 lease，并把完成 marker 作为受控 `package.json` 的提交记录；更新 manifest 前先失效 marker。staging 删除器使用显式栈且限制单轮 100,000 个 entry、128 层和 2 秒，stale IPC 总计最多 5 秒；预算耗尽的部分 quarantine 保留 root receipt，后续 sweep 从剩余目录继续。窗口关闭会先同步使 renderer request ID 失效，再等待 service cleanup，避免 pre-service 扫描在关闭期间重新启动 Preview。

三档用户权限与后端机制的关系：

| UI 档位 | 后端模式 | 文件边界 | 网络边界 | 进程生命周期 |
| --- | --- | --- | --- | --- |
| 本机审计模式 | `sandboxMode=LocalAudit` | 不限制在 workdir；沿用保护路径和 Trash Bin | 继承系统网络 | CLI 使用托管；GUI 使用 detached launch |
| 离线隔离模式 | `sandboxMode=OfflineIsolated` | AppContainer / workdir scope | deny-all | 禁止 detached launch 与桌面控制 |
| 受控联网模式 | `sandboxMode=ControlledNetwork` | 默认：本机文件空间 + 保护路径 / Trash Bin；legacy fallback 可回到 AppContainer / workdir scope | 当前：普通 `exec` / Guide Skill broker-proxy-preferred + direct/audit；Script Skill 可显式 brokerOnly；目标：OS 层直连阻断后只走 broker/proxy 出口 | 默认禁止通用 detached launch 与桌面控制；`agent-browser` 通过专用 CDP runtime 窄口可用 |

`execution.permissions.network` 可影响外部 Script Skill 的网络策略：

- `true`：继承系统网络，适合 GitHub、ArXiv、RSS、邮件 API 等明确需要联网的 Skill。
- `false`：执行前静态扫描命中网络命令或网络 API 时直接阻断。
- 未声明：默认 `audit`，记录风险但尽量不破坏已安装 Skill 的可用性。
- `execution.permissions.networkMode=brokerOnly`：显式声明只允许 broker 出口。当前会阻断 shell 直连网络，创建 per-run broker 会话，并注入 `AGENTVIS_BROKER_PIPE` / `AGENTVIS_BROKER_TOKEN` / `AGENTVIS_BROKER_FETCH`，脚本通过 `agentvis-broker-fetch` 代发 HTTP(S) 请求；helper 由发布包 resources/bin 提供并复制到 `{AppDataDir}/runtime/bin`，缺失时 fail-closed；`network=false` 与它冲突。
- `execution.permissions.filesystem`：外部 Script Skill 可从 string 类型参数生成 per-run AppContainer 文件系统授权，例如 `{ fromArg: path, access: readWrite }`。该声明只扩大受限进程可见的本地路径，不改变网络策略；`network=false` 仍保持禁网，适合文件整理、转换、批处理等本地文件 Skill。
- `agentvisNetwork: brokerProxyPreferred`：Skill frontmatter 中的受控联网兼容声明。仅适用于 HTTP(S) 且会遵守 `AGENTVIS_NETWORK_PROXY_URL` / `HTTP_PROXY` / `HTTPS_PROXY` 的 proxy-aware Skill；显式 WFP per-run guard 遇到这类 Python Skill 时可降级到 broker-proxy-preferred，减少首 token 为共享解释器造成的误伤。该声明不是非 HTTP(S) 协议的放行口，也不等价于完整 brokerOnly。
- `agentvisNetworkEntrypoints`：Skill frontmatter 中的入口级网络声明，优先级高于 Skill 顶层声明。典型用法是同一个 Skill 包内将 `scripts/`中脚本标记为 `brokerProxyPreferred`，或将 `scripts/`中脚本标记为 `legacyNonHttp`。`brokerProxyPreferred` 表示 HTTP(S) API 路径应走 broker/proxy 并审计；`legacyNonHttp` 不放行直连，只告知受控联网该入口属于 IMAP/SMTP/SSH/数据库/raw socket 等非 HTTP(S) legacy path，需要按 direct-audit 授权闭环处理。
- Guide 模式脚本也会自动关联入口级声明：普通 `exec` 中的脚本路径会和已加载外部 Skill 的 `packagePath` / `agentvisNetworkEntrypoints` 做匹配。命中 `legacyNonHttp` 时，执行层会在真正联网前以相同参数追加 `--action network_targets` 做只读 preflight；拿到精确目标后进入 direct-audit 授权，拿不到目标则继续阻断。这样自制或下载的 Guide Skill 不必改成 Script Skill，也能接入同一套受控联网基座。
- Script Skill 的统一执行入口是 `external_skill_execute({ skillName, args })`。该工具精确命中 Script Skill Contract、校验参数并调用 `ExternalExecutor`；`brokerOnly` 当前只通过这条 Script Skill contract 链路生效。Guide Skill 继续走普通 `exec`，受控联网迁移目标是让普通命令也进入 broker/proxy 出口。
- `execution.permissions.desktopControl=true` 表示 Skill 需要热键、鼠标、屏幕截图、窗口激活等交互式桌面能力；离线隔离模式会阻断。受控联网默认仍不放开通用桌面能力，只有 `agent-browser` 这类已接入专用 runtime 和 broker proxy 契约的内置窄口例外。
- `execution.permissions.desktopLaunch=true` 表示 Skill 可能启动外部 GUI / detached 应用；本机审计模式使用 detached lifecycle，离线隔离模式会阻断。受控联网迁移后先以 managed 命令为主，不先承诺外部 GUI 进程也被完整网络托管。
- Guide 型桌面 / 浏览器 Skill 不一定经过 manifest 执行器；`desktop_control.py`、`agent-browser`、`start-chrome-debug.bat` 等命令在本机审计模式也会被识别为 detached lifecycle，避免 Job Object 在 shell 退出时关闭外部应用。受控联网下，`agent-browser` 只允许 `start-chrome-debug.bat`、`browser-command.bat` 和已绑定 `agentvis-cdp-*` session 的 CDP 命令走受控窄口。

### 4.2 运行时隔离能力

- Windows 子进程会尽量挂入 Job Object，超时、取消、后台 kill 时优先终止进程树。
- `restricted` profile 支持 Restricted Token 路径；当显式启用 AppContainer 文件系统后端时，工作目录作为最小可访问目录授权。
- AppContainer deny-all 网络隔离作为 `restricted + blocked` 强隔离后端优先候选，生命周期局部，不要求常驻服务。
- AppContainer 文件系统授权除 workdir 外，还包含应用内 runtime / skills roots，供内嵌 Python、外部 Skill 和 sandbox profile 使用。`brokerOnly` 文件型 IPC 会在 runtime 目录下通过临时文件 rename 发布请求，因此 ReadWrite 授权需要支持 create/write/rename/delete。
- Script Skill 可通过 `execution.permissions.filesystem` 为用户传入的文件或目录追加 AppContainer grant。grant 只能引用 `argsSchema` 中的 string 参数，并声明 `readOnly` 或 `readWrite`，用于避免受控联网禁网路径把合法本地文件任务误判为无权限。
- 离线隔离进程会将 `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、临时目录和 `XDG_*` 重定向到 `{AppDataDir}/runtime/sandbox-profile/*`，避免脚本把 token/cache 写到真实用户主目录。受控联网目标形态不再重定向这些目录，以复用用户已有 CLI / Skill 凭据缓存。
- Native 文件工具（`read` / `file_write` / `local_search`）通过工具上下文中的 `sandboxFilesystemScope` 判断文件边界：离线隔离固定为 `workspace`，受控联网目标形态为 `local`，避免出现 `exec` 可访问本机文件而 native 工具反而被迫退回工作区的割裂。
- `exec` 的“全局安装 / 登录流程”预检阻断和“命令找不到 / 凭据缺失可能是沙箱环境差异”的 runtime hint 仅用于离线隔离；受控联网不再按工作区文件沙箱解释这类失败，避免误导 Agent 反复要求切换到本机审计模式。
- Trash Bin 删除拦截发生在 Tauri 主进程内。离线隔离下它必须先校验删除目标位于 workdir 或应用托管根目录内，不能让宿主侧软删除绕过 AppContainer 文件边界；受控联网目标形态沿用本机审计模式的保护路径、自定义保护路径和 Trash Bin。
- 桌面 GUI 控制不是普通 CLI 能力。离线隔离下，`desktop-control` 类 Skill、热键、屏幕截图、窗口激活、SendInput / pyautogui / pywinauto 等自动化应在 spawn 前阻断，避免脚本退出码为 0 但实际桌面操作被 Windows UI 隔离或 Job Object 生命周期吞掉；受控联网目标形态需要等 network-only guard 覆盖范围明确后再决定是否放开。
- Python runtime 必须是 hermetic。若共享 venv 的 `pyvenv.cfg` 指向用户主机 Python（例如 `C:\Python*`），离线隔离模式会将其视为不兼容并要求重建为内嵌 Python runtime。
- WFP helper / probe 保留为增强网络隔离 spike 和诊断入口，当前不接默认 shell / Skill 链路；显式设置 `AGENTVIS_NETWORK_GUARD_BACKEND=wfpAppIdBlock` 或 `wfpPerRunAppIdBlock` 时，普通 shell 链路会先运行 WFP helper `inspect --json` readiness 诊断，将结果写入 `wfpEnhanced` 审计事件。第一批 per-run managed executable 策略只支持 foreground 且首个 token 为裸 `curl` / `node` 的命令：主进程创建带 `.agentvis-egress-managed` 标记的临时目录、复制真实工具 exe、前置 PATH，并在命令生命周期内启动 WFP dynamic block session；其它网络意图命令默认 fail closed，避免按共享 `cmd.exe` / 解释器 AppID 误伤同机进程。HTTP(S) Python Skill 若通过 `agentvisNetwork: brokerProxyPreferred` 或执行环境显式标记 opt-in，可降级到 broker-proxy-preferred 并写诊断审计。PowerShell 会专门解析 `-Command` / `-EncodedCommand` 内的 `Invoke-WebRequest`、`Invoke-RestMethod`、`iwr`、`irm`、`curl` 等联网动作，纯 URL 字符串不会单独触发 WFP 网络意图。该开关用于验证 per-run egress guard 底座，不代表普通命令已具备完整 brokerOnly。

### 4.3 网络扫描与环境收口

在 `shell_execute` spawn 之前，`ShellSandboxPolicy` 会根据网络策略执行：

- 网络命令扫描：如 `curl`、`wget`、`ssh`、`Invoke-WebRequest`、`Invoke-RestMethod`。
- 脚本网络 API 扫描：如 `requests`、`urllib.request`、`socket`、`aiohttp`、`smtplib`。
- 禁网环境变量注入：`AGENTVIS_NETWORK_ACCESS=blocked` 等，供子进程和后续 runtime 感知。
受控联网当前默认使用本机文件空间和 broker-proxy-preferred 网络 guard；普通 `exec` / Guide Skill 会拿到 per-run HTTP(S) proxy 环境（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`）和可选 `agentvis-broker-fetch` helper 环境，proxy 会复用主进程 broker 的 localhost/private/link-local/metadata 校验与审计归因。per-run proxy 需要 token 鉴权，标准 proxy URL、npm / pip / git 注入值会携带凭据；浏览器 runtime 则通过 `AGENTVIS_BROWSER_PROXY_SERVER` 读取 server-only 地址，使用本地一次性 proxy endpoint，不要求用户看到或填写 proxy auth。broker 每次请求会先解析并校验目标地址，拒绝 localhost、private、link-local、metadata、CGNAT、multicast、unspecified 等结果；同时会在 DNS 前识别 `sslip.io` / `nip.io` / `xip.io` 中编码的 private/local/metadata IPv4，避免企业 DNS/代理把风险目标改写成 `198.18.x.x` 后被当作普通公网处理。HTTP 请求和 HTTPS CONNECT 使用同一批已校验地址连接，重定向逐跳重复解析、校验和 pinning，避免 DNS 校验到连接之间的 TOCTOU。

`agent-browser` 走 AgentVis 专用 Chrome CDP runtime，而不是默认无头 Playwright。受控联网下只对 `start-chrome-debug.bat`、`browser-command.bat` 和已绑定 `agentvis-cdp-*` session 的 CDP 命令开窄口；launcher 会强制使用 broker browser proxy、拒绝 direct/bypass/credential proxy Chrome 参数，并通过 runtime state 避免复用本机审计模式启动的旧 Chrome。`browser-command.bat` 会清理普通 proxy env 对本地 CDP 控制面的影响，截图后稳定恢复最小化，`close` 转为 runtime graceful stop。任意 attach 用户已有 Chrome 只属于本机审计模式能力，不作为受控联网默认承诺。

当 `ControlledNetwork + internetAudit + broker-preferred` 检测到 HTTP(S) / Git / npm 等 proxyable network intent 时，broker proxy 会话不可用必须 fail closed，写入 `broker_proxy_required_unavailable`，不静默回退直连。broker file/helper 会话不可用但 proxy 可用时允许继续，写入 `broker_helper_unavailable` 诊断；proxy 启动成功写入 `broker_proxy_session_started`。如果命令成功退出但本次 broker file/proxy 会话没有任何 broker 请求，会写入 `broker_proxy_expected_but_unused` 诊断，用于定位缓存命中、误判或疑似静默直连。

`broker_proxy_expected_but_unused` 是高信号诊断而非阻断。审计 detail 会携带 `reasonCode=broker_proxy_expected_but_unused` 与可聚合的 `reasonClass`，当前包括 `cache_hit_likely`、`tool_misclassification`、`potential_direct_egress`。Agent observation 中应把它解释为“缓存命中 / 检测误判 / 疑似直连”三类排查入口，不能直接断言任务失败。

为降低生态误伤，shell 还会注入 `npm_config_proxy` / `npm_config_https_proxy` / `PIP_PROXY`、git per-process `http.proxy` / `https.proxy` 和浏览器 runtime 可读取的 server-only proxy 环境。HTTP(S) Python Skill 可用 `agentvisNetwork: brokerProxyPreferred` 声明自己是 proxy-aware，以便在显式 WFP per-run guard 下减少共享解释器误伤；内置 `web-scraper` 还会自动读取 `AGENTVIS_NETWORK_PROXY_URL` / 标准 proxy 环境并传给 httpx / curl_cffi。legacy AppContainer direct 后端可通过 `AGENTVIS_CONTROLLED_NETWORK_BACKEND=legacy` 回退；该路径会清空 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 并设置 `NO_PROXY=*`，避免 AppContainer 继承 `127.0.0.1` 本机代理后超时。当 Script Skill 声明 `brokerOnly` 时，AppContainer 网络 capability 改为 deny-all，只允许通过主进程 broker helper 代发 HTTP(S) 请求。非 HTTP(S) 直连不承诺 broker-only，但已支持“精确目标 + 用户确认 + direct-audit 审计”的受控逃生口。

受控联网不是泛化 DLP，也不检查文件内容；当前只对三类高置信网络风险触发一次性确认：明确文件上传、敏感材料外传、远端破坏性操作。文件上传命中 `network_upload_confirmation_required` / `network_upload_risk_confirmed`；敏感外传命中 `network_sensitive_egress_confirmation_required` / `network_sensitive_egress_confirmed`；远端破坏命中 `network_remote_destructive_confirmation_required` / `network_remote_destructive_confirmed`。确认只作用于同一次重试，不持久化授权；审计额外写 `riskClass`、`riskKind`、`credentialContext`，用于区分 `fileUpload`、`sensitiveEgress`、`remoteDestructive` 以及 broker credential / ambient 凭据上下文。普通 `git` / `npm` / `pip`、只读 HTTP(S) 查询、下载到本地、`kubectl get`、`helm list`、`terraform plan`、`aws s3 ls`、数据库只读查询不触发这三类确认。

#### 4.3.1 非 HTTP(S) direct-audit 授权闭环

IMAP/SMTP/SSH/数据库/raw socket 等非 HTTP(S) 协议不伪装成 HTTP broker 覆盖。受控联网下，命中此类直连意图时默认 fail closed；只有能明确得到 `protocol + host + port + subject` 时，才允许通过 UI 弹窗生成本次或本会话 direct-audit 授权。

当前闭环包括：

- `sandbox_network_direct_targets` 只做目标检查，不执行原始联网动作。SSH/scp/sftp 等命令可从命令行直接提取目标，例如 `ssh -p 2222 user@example.com` → `ssh://example.com:2222`。
- email-helper legacy IMAP/SMTP 入口通过只读 `--action network_targets` 读取账号配置，返回 `imap://host:port` / `smtp://host:port`，不发起网络连接。
- 自制或下载的非 HTTP(S) Skill 可在 `agentvisNetworkEntrypoints` 中将入口声明为 `legacyNonHttp`，并实现只读 `--action network_targets`，输出形如 `{"targets":[{"protocol":"postgres","host":"db.example.com","port":5432}]}` 的 JSON。Script Skill 通过 `ExternalExecutor` 使用该 preflight；Guide Skill 通过普通 `exec` 脚本路径归因自动读取 frontmatter 后使用同一 preflight。无法返回精确目标时继续阻断。
- 常见非 HTTP(S) 命令行目标已覆盖 SSH/SCP/SFTP、raw TCP / Telnet 以及数据库客户端主路径，包括 `psql`、`mysql` / `mariadb`、`redis-cli`、`mongosh` / `mongo`、`sqlcmd`。PowerShell 路径额外识别 `Test-NetConnection` / `tnc` 和 `.NET TcpClient/Socket` raw socket：可静态抽取 host/port 时进入 direct-audit；无法抽取精确目标时不弹授权框，继续以 `proxy_bypass_signal_blocked` fail closed。
- UI 弹窗只展示精确目标和授权对象。public 目标可选择“允许本次”或“本会话允许”；localhost/private/link-local/CGNAT 目标显示高风险文案，默认只允许本次；metadata 目标在 `ControlledNetwork` 下不提供放行按钮，要求切换到本机审计模式。授权生成 `NetworkDirectAllowance`，字段固定为 `id, subjectType, subjectId, protocol, host, port, scope, expiresAt, createdAt, reason`；`scope` 当前支持 `currentExecution` 和 `session`。
- direct-audit 授权前会由 Rust 解析 hostname，向前端返回 `resolvedRisk`、`resolvedIpSamples`、`resolvedRiskReason`。如果 hostname 解析到 metadata，后端以 `network_direct_metadata_target_blocked` fail closed；解析到 localhost/private/link-local/CGNAT 时只接受 `currentExecution`，不接受 `session` scope。为避免企业 DNS/代理把 `sslip.io` / `nip.io` / `xip.io` 改写成代理映射地址，Rust 会先识别 hostname 中编码的 IPv4 地址，例如 `127.0.0.1.sslip.io`、`169-254-169-254.sslip.io`，并标记 `hostnameEncodedPrivateOrLocalIp` / `hostnameEncodedMetadataIp`。`198.18.0.0/15` 等代理/压测映射地址不改变 public 授权体验，但会用 `dnsResolvedBenchmarkOrProxyIp` / `literalBenchmarkOrProxyIp` 做诊断标记。
- 重试时前端同时传递 `networkDirectAllowances` 与 `networkDirectTargets`，Rust 侧要求目标与 allowance 按 subject、protocol、host、port、过期时间精确匹配，匹配成功才以 `directAuditAllowed` 记录审计并继续执行。
- direct-audit 不是 broker-only，不做内容代理、协议解析或域名策略重写；它的定位是给日常必要的非 HTTP(S) 任务保留可解释、可审计、可撤销的执行空间。
- `network-direct-guide` 覆盖 SSH/SCP/SFTP、raw TCP / Telnet、数据库客户端和无目标 negative checks。可解析出精确目标的命令会弹出 direct-audit 授权并在允许后继续执行；若本机缺少对应客户端，后续 OS 层失败不视为沙箱误拦。无 host/port 的 raw socket 类命令不会弹授权，继续硬阻断。快速授权弹窗场景下，工具结果、observation 与 TaskArtifact 已验证不会再丢失。
- `ControlledNetwork` 的 7 项核心网络隔离命令均符合预期。Git HTTPS 正常通过 broker/proxy 且无 direct-audit 弹窗；`curl.exe --noproxy "*"` 被 `proxy_bypass_signal_blocked` 阻断；PowerShell `.NET TcpClient` 对 `example.com:80` 能触发 `tcp://example.com:80` direct-audit，用户拒绝后阻断；`Test-NetConnection imap.gmail.com:993` 触发 direct-audit，用户允许后继续执行；`127.0.0.1:5432` 显示 private/local 高风险弹窗且只允许本次；`169.254.169.254:80` 显示 metadata 风险路径且不允许在受控联网下放行；无静态 host/port 的 Socket 创建直接阻断、不提供粗放授权。
- 普通 `curl` / Git HTTPS / npm 任务保持可用，并写入 `broker_proxy_session_started` / `broker_network_request`；`curl --noproxy "*"`, `curl -x ""`, `git -c http.proxy=`, `cmd /c "set npm_config_proxy=&& npm view ..."` 均以 `proxy_bypass_signal_blocked` 阻断；localhost、metadata、CGNAT、IPv6 loopback 等普通 URL 由 broker 目标校验阻断；PowerShell `.NET TcpClient` 继续阻断。Python `subprocess` / Node `child_process` 再 spawn raw socket、以及 Playwright / Chromium `--proxy-server=direct://` / `--proxy-bypass-list=*` 已纳入静态 bypass 扫描和 intent 门控：脚本内容即使通过 `cmd /c "cd /d ... && node/python script"` wrapper 启动，也应在执行前 fail closed。redirect-to-private 仍需要使用自建 canary endpoint 才能验证 broker 逐跳校验，第三方公开 redirect 服务若自身拒绝 private redirect，不能视为 broker 覆盖证明。
- A-H 回归基线中，日常公网任务仍可用且明确代理绕过会阻断；补测后的 `cmd /c "set npm_config_proxy=&& set npm_config_https_proxy=&& npm view ..."` 已稳定命中 `proxy_bypass_signal_blocked`。C 组两次补测显示，`curl --data-binary @file`、`curl -F file=@...`、`curl -T`、PowerShell `Invoke-RestMethod -InFile` 均能触发 `network_upload_confirmation_required` 弹窗，用户选择“允许本次”后写入 `network_upload_risk_confirmed` 并继续执行；`webhook.site` 端点可返回 200，临时 Vercel endpoint 返回 404 时归类为端点路由问题，不视为沙箱失败。一次 `Invoke-RestMethod` 补测出现非阻断 `broker_proxy_expected_but_unused` / `reasonClass=potential_direct_egress` 诊断，后续需继续观察；真正 upload canary 的 body / bytes_out / 目标校验仍以自托管 broker canary 自动化测试和稳定公网手工 canary 为准。direct-audit 的 public/private/metadata 体验符合预期；HTTP broker 层已在 DNS 前识别 hostname 编码 IP，`127.0.0.1.sslip.io` 返回 `403 Forbidden` 并记录 `resolvedRisk=private`、`resolvedRiskReason=hostnameEncodedPrivateOrLocalIp`、`resolvedIpSamples=127.0.0.1`，`169-254-169-254.sslip.io` 返回 `403 Forbidden` 并记录 `resolvedRisk=metadata`、`resolvedRiskReason=hostnameEncodedMetadataIp`、`resolvedIpSamples=169.254.169.254`。`cmd /c echo https://example.com` 可稳定触发非阻断 `broker_proxy_expected_but_unused`，detail 带 `reasonClass=tool_misclassification`。
- 自动化场景回归补齐：Rust 检测器增加 `network_risk_checkpoint_matrix_covers_daily_and_high_risk_cases` 矩阵，用 `id/group/expectation` 固定“正常日常不误拦”和“明确上传 / 外传 / 删库跑路可命中”两侧边界。当前覆盖普通下载、只读查询、包管理、Git、Kubernetes 只读、Terraform plan、AWS S3 ls、数据库只读负例；同时覆盖文件上传、环境变量 / SSH key / `credentials.json` 外传、HTTP DELETE、`helm`、`gh repo delete`、`az/gcloud/aws`、`mongosh`、`sqlcmd` 等高风险正例。该层不是替代真实手工任务矩阵，而是作为后续沉淀 Agent 任务样本的回归基线。
- `agent-browser` 受控联网验证结论：默认浏览器 Skill 的代理契约已闭环。使用 `start-chrome-debug.bat` 启动 AgentVis 专用 CDP runtime 后，真实页面导航、snapshot、截图 / 标注截图、fill / click / press、scroll、wait、get text / attr、截图临时文件清理、启动后最小化和 `browser-command.bat close` graceful stop 均稳定可用；明确 direct/bypass/credential proxy Chrome 参数继续阻断。浏览器 runtime 不再要求用户填写 proxy auth，旧 runtime 或代理 hash 不匹配时通过 `ensure` 重建。

目标形态：受控联网保留 `ControlledNetwork` 字段和 UI 名称，继续从“文件也隔离的 networked AppContainer”迁移为“本机文件空间 + broker-only 网络出口”。普通 `exec` / Guide Skill 已具备 broker-proxy-preferred 会话入口，后续需要由 WFP 或等价 network-only guard 阻断绕过代理的直连；在 OS 层直连阻断完成前，只能称为 broker-proxy-preferred / audit，不能宣称完整 brokerOnly。

静态扫描只能发现明显联网迹象；在非 AppContainer 路径下，`network=blocked` 属于软阻断，不能宣称为硬禁网。真实域名管控需要后续 broker / proxy 或可观测网络事件支持。

补充边界：

- 受控联网当前实现的网络 API 命中是 audit，不是 block；离线隔离模式才应阻断。迁移目标是受控联网在 network-only guard 可用时对普通命令直连也 fail closed。
- `web_search` 已先走主进程 broker，并记录 `broker` 审计事件；通用 `network_broker_http_request` 可按 `tool` / `skill` / `command` 归因记录 broker 审计。
- Script Skill 的 `brokerOnly` 是 fail-closed 切换：直连被禁用，helper 请求由主进程 broker 校验 URL、私网/localhost/link-local、重定向和大小限制，并按执行上下文记录 `broker` 审计；第三方 Skill 只需要显式调用 helper，不需要被 broker 信任；2026-05-23 `broker-e2e` 已在受控联网模式下验证四项通过；Guide Skill 的普通 `exec` 归因已可透传到 broker-proxy-preferred 会话，HTTP(S) 客户端若遵守代理环境会进入主进程 broker/proxy。
- `brokerProxyPreferred` 是降低误伤的中间档：它允许 proxy-aware HTTP(S) 工具继续使用普通库和标准代理环境，但仍不能承诺所有直连都被 OS 层阻断。`curl --noproxy` / `--no-proxy`、显式 `NO_PROXY` / `npm_config_noproxy`、清空 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `npm_config_proxy`、Chromium direct proxy 参数、Node native fetch 不走 proxy、Python / Node 子进程再 spawn raw socket、PowerShell `.NET TcpClient/Socket`、`Test-NetConnection`、raw socket、IMAP/SMTP/FTP/SSH 类库等会被识别为 `proxy_bypass_signal_detected`，在默认受控联网路径中以 `proxy_bypass_signal_blocked` fail closed；若属于非 HTTP(S) 且可精确提取目标，可由 direct-audit 授权闭环恢复执行。私网/localhost/link-local 目标继续由 broker 目标校验、direct-audit 风险分级和 WFP/等价 guard 兜底。
- 非 HTTP(S) Skill 不应声明 `agentvisNetwork: brokerProxyPreferred`。IMAP/SMTP 路径使用 `agentvisNetworkEntrypoints.scripts/email_helper.py=legacyNonHttp`，通过 `network_targets` 预检和 direct-audit 授权执行。自制邮箱、SSH、数据库、raw socket 类 Skill 也应使用入口级 `legacyNonHttp` + 只读目标预检，而不是把整个 Skill 声明为 HTTP(S) proxy-aware。
- `github-lookup` 在受控联网 legacy 实现下已验证 broker 通路可用，但沙箱内 `Path.home()` 不会指向真实 `C:\Users\<user>`，因此不能读取现有 `.github_token.json`。新的默认受控联网路径会复用真实 Home / 应用目录中的 CLI 与 Skill token cache，但需要配套 broker 日志脱敏、agent-facing observation 脱敏和上传策略，避免凭据进入模型上下文或外泄。
- Windows 本机代理、企业代理、VPN 的完整兼容不能依赖沙箱进程直连 loopback。后续应由主进程 broker / proxy 继承本机网络环境并统一审计请求。

### 4.4 安全审计事件

Rust 端通过 `agentvis://sandbox-audit-event` 推送结构化事件，并通过 `sandbox_audit_events` 命令提供最近内存事件查询。当前事件 `schemaVersion` 为 `1`，核心字段包括：

```ts
type SandboxAuditEvent = {
  schemaVersion: 1;
  id: string;
  timestamp: number;
  timestampIso: string;
  executionId: string | null;
  source: 'exec' | 'externalSkill' | 'installer' | 'preview' | 'nativeTool';
  subjectType: 'command' | 'skill' | 'tool' | 'preview' | 'installer' | 'process' | 'wfpSession';
  subjectId: string | null;
  commandHash: string;
  profile: 'standard' | 'externalSkill' | 'installer' | 'preview' | 'restricted';
  sandboxMode: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
  processLifecycle: 'managed' | 'detachedLaunch' | 'backgroundManaged';
  networkPolicy: 'inherit' | 'audit' | 'blocked';
  networkScope: 'inherit' | 'blocked' | 'lan' | 'internetAudit';
  backend: 'none' | 'jobObject' | 'restrictedToken' | 'appContainer' | 'mainProcess' | 'broker' | 'wfpEnhanced';
  decision: 'allow' | 'audit' | 'block' | 'diagnostic';
  reason: string;
  matchedPattern: string | null;
  riskClass?: string | null;
  riskKind?: string | null;
  credentialContext?: string | null;
  workdir: string | null;
  cleanup: 'notApplicable' | 'clean' | 'residualDetected' | 'failed' | null;
  targetHost?: string | null;
  targetScheme?: string | null;
  targetPort?: number | null;
  networkProtocol?: string | null;
  guardMode?: 'auditOnly' | 'wouldBlock' | 'hardBlock' | 'directAuditAllowed' | null;
  requestMethod?: string | null;
  urlHash?: string | null;
  statusCode?: number | null;
  bytesIn?: number | null;
  bytesOut?: number | null;
  durationMs?: number | null;
  blockedReason?: string | null;
};
```

事件不记录原始命令全文，只记录稳定 hash、profile、网络策略、命中模式和决策结果，为后续 Skill 安全概览、审计日志和权限恢复 UI 提供数据基础。网络相关 observation 和审计详情不得记录 proxy token、`Authorization`、`Proxy-Authorization`、`Cookie`、常见 secret query/key；对目标仅保留 redacted target、hash、状态码、字节数、耗时和阻断原因。

---

## 五、Agent Trash Bin 软删除机制

**文件**：`src-tauri/src/commands/trash_bin.rs`

Agent Trash Bin 是针对文件删除操作的**可恢复软删除层**。当 Agent 执行 `del`、`rmdir`、`Remove-Item` 等删除命令时，Rust 后端会在调用 OS 之前拦截命令，将目标文件/目录**移动到 `Agent_Trash_Bin` 目录**，而不是真正销毁。

> **关键设计**：Agent-facing 工具返回值保持不透明，只返回与原始删除命令语义一致的成功消息，例如 `Deleted successfully.`。Trash Bin 真实路径、原始路径和恢复信息只写入 manifest / 日志 / 后续用户 UI，避免 Agent 看到回收站位置后继续追踪并二次删除。

> **隔离边界**：Trash Bin 的移动动作由宿主侧 Rust 代码执行，不天然受 AppContainer 约束。因此在离线隔离模式下，删除拦截必须带 allowed-roots 校验，只允许移动 workdir、`{AppDataDir}/runtime`、`{AppDataDir}/skills` 等已授权根目录内的目标；命中外部路径时直接返回沙箱阻断。受控联网目标形态沿用本机审计模式的保护路径、自定义保护路径和 Trash Bin，不按 workdir 做文件边界。

### 5.1 拦截作用时机

Trash Bin 在命令通过 `validate_command_safety_with_workdir()` 之后、OS 真实执行之前触发：

```
[validate_command_safety_with_workdir() → Ok]   ← Rust 硬阻断通过
         │
         ▼
[try_intercept_delete()]            ← Trash Bin 软删除拦截
   ├─ 解析成功 → 移动到 Trash Bin → 返回不透明成功消息给 Agent
   └─ 有删除/清理意图但无法安全解析目标 → fail closed 阻断，不进入 OS 执行
```

在 `restricted` 模式下，上述“解析成功”还必须满足目标路径属于 allowed roots；否则不会执行宿主侧移动。

### 5.2 支持拦截的命令格式

| 命令格式 | 示例 |
|---------|------|
| `del filepath` | `del /f /q C:\project\old.log` |
| `erase filepath` | `erase temp.txt` |
| `rmdir /s /q dirpath` | `rmdir /s /q dist` |
| `rd /s /q dirpath` | `rd /s /q .build` |
| PowerShell `Remove-Item` | `powershell -Command "Remove-Item 'path' -Force"` |
| PowerShell 别名 `ri`/`rm` | `powershell -Command "ri 'path'"` |
| `cmd /c "del ..."` 嵌套 | `cmd /c "del file.txt"` |
| 管道删除 | `Get-ChildItem *.log \| Remove-Item` |
| 通配符 glob | `del C:\project\*.webp`（展开后逐个移动） |
| PowerShell 通配符 | `Remove-Item -Path "$env:APPDATA\com.agentvis.app\deliverables\Team\Agent\*"` |
| PowerShell 变量通配符 | `$target='C:\project'; Remove-Item -LiteralPath $target\* -Recurse -Force` |
| `Get-ChildItem` 循环删除 | `foreach ($item in Get-ChildItem $dir) { Remove-Item -LiteralPath $item.FullName -Recurse -Force }` |

对于命令文本已经呈现删除/清理意图，但 Trash Bin 解析器无法安全还原目标路径的复杂命令（多层管道链、未解析变量、.NET `Delete()` 调用、`robocopy /purge`、`git clean` 等），系统采用 **fail closed**：阻断执行并返回“请改用受支持的显式删除方式”的安全提示。这样可以促使 Agent 改写为 `Remove-Item` / `del` / `rmdir` 等可被软删除兜住的形式，而不是绕过 Trash Bin 直接进入 OS 删除。

### 5.3 不透明成功反馈（防二次清理）

拦截成功后，exec 工具的返回内容不暴露 Trash Bin 路径，也不说明文件被移入可恢复目录：

```
Deleted successfully.
```

这条消息直接进入 SA 的工具调用结果。它的目的不是向 Agent 解释软删除细节，而是让 Agent 将当前删除任务视为已经完成，避免继续搜索 `Agent_Trash_Bin` 并对回收站副本执行二次删除。

完整恢复信息仍然保存在 `trash_manifest.json` 和内部日志中，面向用户或“设置 → 文件保护”的 Agent 回收站 UI 展示；Agent 默认不应拿到这些路径。

### 5.4 Trash Bin 存储结构

```
{app_data_dir}/
└── Agent_Trash_Bin/
    ├── trash_manifest.json              # 删除记录索引（文件排他锁保证并发安全）
    ├── 20260407_224512_C_proj_old.log   # 被拦截的文件（时间戳_编码路径命名）
    └── ...
```

**manifest.json** 记录每条删除的完整元数据：原始路径、回收站路径、删除时间、触发命令、是否为目录。

### 5.5 用户恢复与手动清理

“设置 → 文件保护”中的 **Agent 回收站** 会读取 manifest 展示最近删除条目，并提供用户侧恢复/清理能力：

- **选择回收站条目**：用户勾选一个或多个条目后，再执行“恢复选中”或“清理选中”。
- **整批选中**：同一次删除命令产生多个条目时，条目末端的“整批”按钮只负责把同批条目加入选中集合，不直接执行恢复或清理。
- **恢复选中**：将 Trash Bin 副本移回原始路径；恢复成功后从 manifest 移除记录。若原始路径已存在，则保留记录并提示冲突；若副本已经缺失，则从 manifest 清理该失效记录。
- **清理选中**：永久删除 Trash Bin 内的副本并从 manifest 移除记录；删除失败的条目继续保留在 manifest 中。清理前后端会校验 `trashPath` 必须位于 `Agent_Trash_Bin` 内，避免用户侧清理动作误删回收站外路径。

这些操作面向用户，不通过 Agent 执行恢复命令，因此不会把回收站内部路径暴露给 Agent。

### 5.6 自动过期清理

应用启动时自动扫描 manifest，**超过 30 天**的条目物理删除并从 manifest 移除；清理完成后 manifest 会同步写回。短期内被误删的文件在此期间可通过文件保护 UI 恢复或手动清理。

---

## 六、TS/Rust 双层设计说明

| 对比维度 | TS 层（ExecSafetyPolicy） | Rust 层（command_validator） |
|---------|-----|------|
| **定位** | 第一道防线，快速反馈 | 最后一道防线，不可绕过 |
| **匹配方式** | 正则 `\b` 词边界，精确匹配 | `contains()` 子串匹配，宁误报不漏检 |
| **阻断时机** | 在 SA 工具调用层，未发起 Tauri IPC | 在 Tauri 命令层，命令到达 OS 前 |
| **黑名单覆盖** | 与 Rust 层基本一致 | 额外实现 icacls 组合阻断、脚本内容扫描 |
| **放行能力** | 有白名单，可跳过 Checkpoint | 无白名单，只做阻断不做放行 |

---

## 七、防护层协同流程图

```
用户需求
    │
    ▼
[Master Brain 决策]
  ├─ behaviorHint: careful/direct
  ├─ 基础工具自动补全 + 特殊工具显式授权
  └─ riskAssessment 风险自评（当前不直接映射全局 riskDelta）
    │
    ▼
[LoopGovernor 循环治理]
  ├─ 连续无进展熔断
  ├─ 工具震荡检测
  └─ 预算管控 + 风险阈值预留位
    │
    ▼
[Sub-Agent 执行 exec 工具]
  │
  ├─→ isExecCommandBlocked()  ── true ──→ 🛑 TS 层绝对拒绝
  │
  ├─→ isExecCommandSafe()     ── true  ─→ ✅ 跳过用户授权与 MB 高风险 Checkpoint
  │                            ── false ─→ ⚠️ 非安全 exec 路径（Runner/授权/Rust/沙箱继续约束）
  │
  ▼
[Tauri IPC: shell_execute]
  │
  ├─→ validate_command_safety_with_workdir() ── Err ─→ 🛑 Rust 层硬阻断
  ├─→ validate_script_content()    ── Err ─→ 🛑 脚本内容扫描阻断
  └─→ validate_path_write_safety() ── Err ─→ 🛑 路径写入保护阻断
  │
  ▼
[ShellSandboxPolicy]
  ├─→ static network scan          ── audit/block → 结构化审计事件
  ├─→ non-HTTP direct target       ── 精确目标 + 用户授权 → direct-audit
  ├─→ Job Object / Restricted Token / AppContainer
  └─→ WFP helper 保留为实验诊断入口
  │
  ▼
[try_intercept_delete()]            ← Trash Bin 软删除拦截
  ├─→ 解析成功（del/rmdir/Remove-Item...）
  │     → 移动到 Agent_Trash_Bin
  │     → 返回不透明成功消息（Agent 不感知回收站路径）  ── ✅ 不调用 OS del
  └─→ 删除/清理意图存在但解析失败 → fail closed 阻断
  │
  ▼
OS 执行命令
```

---

## 八、安全设计说明

### 精确匹配 vs 宽松匹配
- **TS 层**使用 `\b` 词边界正则，确保 `format` 不误报 Python 的 `str.format()`，`wmic` 不误报只读查询。
- **Rust 层**使用 `contains()` 子串匹配，提供额外兜底覆盖，宁可触发少量误报也不漏检危险命令。
- **`format` 命令单独处理**：从黑名单中独立，通过 `is_format_drive_command()` 检测 `format X:` 盘符模式，避免编程语言中 format 函数的大量误报。

### 组合阻断 vs 全量阻断
- `wmic`、`icacls`/`cacls`、`Set-Acl` 等工具本身有合法的只读查询场景，不全量禁止。
- 仅当它们与**写入类子命令**或**系统核心目录**组合出现时才阻断，实现精准管控。

### 缓存热更新
自定义保护路径通过 `RwLock` 全局缓存，首次 IO 后命中缓存，UI 更新保护目录后调用 `reload_custom_protected_paths()` 立即刷新，兼顾性能与实时性。

### Trash Bin fail-closed 策略
对于“看起来有删除/清理意图，但解析器无法安全确定目标”的复杂格式（如嵌套多级管道、未解析变量、脚本片段里的 `.Delete()`、`git clean` / `robocopy /purge` 等），Trash Bin 选择 fail closed 阻断，而不是回退到 OS 执行。返回提示会要求 Agent 改用受支持的显式删除方式，使后续重试更容易被软删除拦截。只有完全不呈现删除意图的命令才继续正常执行。
