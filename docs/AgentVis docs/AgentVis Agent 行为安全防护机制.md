# AgentVis Agent 行为安全防护机制

---

## 概述

Agent 具备调用 Shell 命令、读写文件、搜索网络等真实副作用能力。为防止 Agent 误操作或被恶意 Prompt 劫持，系统构建了**纵深防御**体系，分布在五层防护中：

1. **LLM 行为软防护层**（Prompt 层 + FSM 层）：引导和约束 Agent 的决策行为
2. **TypeScript 工具拦截层**：在工具调用落地前做快速拦截与分级处理
3. **Rust 命令校验层**：在已识别的危险命令、保护路径与可扫描脚本入口上提供宿主侧硬阻断
4. **进程 / 网络沙箱与审计层**：运行时防护层，通过 Job Object、Restricted Token、AppContainer、broker/proxy 与网络策略为 shell / Skill 执行增加可控约束
5. **Agent Trash Bin 软删除层**：在 Rust 层通过之后、OS 真正删除之前，将删除操作透明重写为"移动到回收站"，实现删除可恢复

各层相互协作，形成「软防护 → TS 快速反馈 → Rust 入口校验 → 沙箱约束与审计 → 软删除兜底」的纵深防御链。它降低大多常见 Agent 误删风险，但不等价于对任意同用户原生代码的完整文件系统强制访问控制。

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

| 终止条件                  | 优先级    | 说明                                                                                     |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `consecutive_no_progress` | 1（最高） | 连续 2 次循环无实质进展，防止 Agent 无效空转                                             |
| `tool_thrashing_detected` | 2         | 连续 N 次（默认 3）调用同一工具，防止死循环振荡                                          |
| `over_delegation`         | 3         | 子 Agent 派遣次数超过预算上限（默认随 MB 决策预算 8 轮同步，除非显式覆盖）               |
| `risk_exceeded`           | 4         | 累积风险分数超过阈值（默认 0.8；当前主流程暂不接入 MB `riskAssessment`，属于预留扩展位） |
| `budget_exhausted`        | 5         | MB 决策轮次预算耗尽（默认 8 轮；FSM 步进硬安全阀默认为 48）                              |

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

| 工具                     | 风险等级 | 说明                                             |
| ------------------------ | -------- | ------------------------------------------------ |
| `read`                   | low      | 只读操作，无副作用                               |
| `web_search`             | low      | 只读操作，无副作用                               |
| `local_search`           | low      | 只读操作，无副作用                               |
| `generate_image`         | low      | 仅写入 deliverables 目录，可撤销                 |
| `file_write`             | medium   | 写入操作，有 fast-apply 快照兜底                 |
| `cron`                   | medium   | 可撤销的定时任务管理                             |
| `exec`                   | **high** | 系统命令执行，可能有不可逆副作用                 |
| `external_skill_execute` | **high** | 外部 Script Skill 统一执行入口，会执行技能包脚本 |
| `im_send`                | low      | IM 消息发送统一工具                              |

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

| 类别             | 示例                                               |
| ---------------- | -------------------------------------------------- |
| 磁盘/分区销毁    | `diskpart`, `format C:`, `cipher /w`               |
| 系统启动破坏     | `bcdedit`                                          |
| 用户/服务管理    | `net user`, `net stop`, `sc delete`                |
| 注册表破坏       | `reg delete`, `reg add HKLM`                       |
| Base64 混淆      | `-EncodedCommand`, `-enc`                          |
| 环境变量永久修改 | `setx /M`, `[Environment]::SetEnvironmentVariable` |
| 注册表路径直写   | `Session Manager\Environment`                      |
| ACL + 系统目录   | `icacls/cacls/Set-Acl` + `system32/windows` 组合   |

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

## 三、Rust 命令校验层（宿主侧入口防线）

**文件**：`src-tauri/src/commands/command_validator.rs`

Rust 层在命令真正交给操作系统前，对已知高危工具/子命令、保护路径、写入目标和支持的脚本入口进行硬阻断。实现同时使用保守子串匹配与 token/路径语义检查；命中的策略无法由 TS 层绕过，但该入口校验不是 shell 或解释器的完整语法证明，并不承诺识别任意动态代码、未知解释器或原生二进制内部的副作用。

### 3.1 分阶段校验流水线

`shell_execute` 当前优先调用 `validate_command_safety_with_workdir()`，在执行以下校验时会用真实 `workdir` 解析相对删除/写入目标；`validate_command_safety()` 仍作为不带 workdir 的兼容入口。整体优先级如下：

```
输入命令
│
Step 0: token 级高危形式（PowerShell encoded command、reg/sc/net 子命令）
│       命中 → Err(AppError::Forbidden) 立即阻断
│
Step 1: 绝对禁止命令黑名单（保守 contains 匹配）
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

内置系统级不可更改的保护路径，覆盖下列字面量与 CMD `%...%` 变量形式。这是有限的静态模式集，并不声称理解任意 shell 的环境变量语法；对 Trash Bin 已解析出的最终目标，移动前还会按当前 `SystemRoot` / `WINDIR` / `ProgramFiles` 等实际路径再次校验：

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

系统使用按 app-data 根区分的全局 `RwLock` 缓存自定义路径，首次调用时从磁盘加载并缓存。用户通过 UI 修改保护目录后，调用 `reload_custom_protected_paths()` 即时刷新缓存，无需重启应用。配置文件最多 1 MiB、4096 条，单路径最多 32 KiB；读取使用 metadata 预检与 `limit + 1` 有界读取，UI 写入也会在覆盖磁盘配置前执行相同预算校验。首次加载时配置文件不存在表示空列表；已有缓存后，JSON 损坏、超限、普通读取失败或显式 reload 时文件意外消失，都不会替换上一份有效缓存。应用重启后若配置仍不存在，则按尚未配置的空列表初始化。`protected_paths.json` 本身会被受支持的 Trash Bin 删除识别器视为内部保留路径。

自定义保护目录同时生效于：

- **破坏性动词防护**：`del`/`rmdir`/`remove-item` 等
- **写入重定向防护**：`>`/`>>`/`Out-File`/`Set-Content`/`Copy-Item` 等

### 3.4 文件写入路径保护

`validate_path_write_safety()` 在 `file_write_to_path` 等 Tauri 文件写入/导入命令中调用。它先做词法归一化（包括 `.` / `..` 与 Windows verbatim 前缀），再对已存在祖先 canonicalize 并补回尚不存在的尾部，最后用带分隔符边界的路径前缀匹配保护自定义目录及其所有子路径：

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

`validate_script_content()` 在 exec 执行脚本文件前调用，读取脚本源码并扫描危险 API。它会收集受支持提取模式命中的脚本，而不是只检查第一个参数；`cmd /D /C`（也识别 `/q/d/c` 等组合、完整路径和 `%ComSpec%` / `!ComSpec!`）、`call`、PowerShell/Python/Node/Bun/Deno 入口和脚本文本中可静态确定且符合提取模式的嵌套脚本也会递归检查（最大 8 层）。动态拼接、未知解释器入口或未被提取器识别的嵌套形式不在这项静态保证内。

**支持扫描的文件类型**：`.ps1`、`.bat`、`.cmd`、`.py` / `.pyw`、JavaScript / TypeScript 家族（`.js`、`.mjs`、`.cjs`、`.jsx`、`.ts`、`.mts`、`.cts`、`.tsx`）、`.cs`、`.vbs`

**脚本内容禁止关键字（`SCRIPT_CONTENT_FORBIDDEN`）**：

| 关键字                        | 威胁说明                                    |
| ----------------------------- | ------------------------------------------- |
| `setenvironmentvariable`      | PowerShell/.NET 永久修改系统/用户级环境变量 |
| `session manager\environment` | 通过注册表路径直接写系统级环境变量          |
| `diskpart`, `bcdedit`         | 磁盘分区/启动配置破坏                       |
| `cipher /w`                   | 不可逆磁盘覆写                              |
| `takeown`, `sfc /`            | 系统权限突破                                |
| `net user`, `sc delete`       | 用户/服务管理                               |
| `reg delete`, `reg add hklm`  | 注册表破坏                                  |

此外还按语言识别常见文件删除 API：PowerShell `Remove-Item` 及 `ri` / `rm` / `del` / `erase` / `rd` / `rmdir` 删除别名，Python `os.remove` / `shutil.rmtree` / `Path.unlink`，Node.js `fs.rm` / `unlink` / `rmdir`（含 `from 'fs'` 的 ESM named import），批处理普通及 `del/f/q` / `rmdir/s/q` 等紧凑写法，以及 C# / VBS 的删除调用。可扫描脚本中的直接或 package-manager 包装 `rimraf` 也会阻断。确认脚本包含本地删除后，Rust 扫描器内部返回结构化原因 `[recoverable_delete_required]`；TS exec 层不会把该内部标签或 Trash Bin 机制暴露给 Agent，而是映射为中性的 `[DELETE_RETRY_REQUIRED]` observation，要求改用一条受支持的直接字面路径命令重试。脚本不会先启动、再期待系统接管其进程内删除行为。

脚本路径提取支持多种可静态确定的调用模式：

- `powershell -File script.ps1`
- `pwsh -f script.ps1`、`powershell -NoProfile .\script.ps1` 与 `-Command ".\script.ps1"` 字面量调用（含带空格的单/双引号路径）
- `cmd.exe /q/d/c script.cmd`、`%ComSpec% /D /S /C script.bat`
- `python script.py` / `python3 -u my_script.py`（解释器已明确时允许非标准扩展名）
- `node script.js` / `bun script.mjs` / `deno run script.ts`
- `npx tsx script.ts` / `npx ts-node script.ts`
- `cscript script.vbs` / `wscript script.vbs`
- `csc.exe source.cs`（C# 编译器，扫描源码）
- 直接调用：`./setup.bat`、`install.cmd`

Python、Node、Deno 与 Bun 入口共享各自的带值选项表并识别 `--`，只把真实入口之前的 launcher option 当作解释器选项；入口之后同名参数仍是脚本 argv。Deno test/bench 的 `--filter`、Bun test 的 `--test-name-pattern` 等 mode 专属值会作为选项数据消费，不再误当文件路径；Bun test 中显式的路径型本地入口仍会扫描。`-c`（含 Python 合法短选项组合）、eval/print 与 PowerShell `-Command` 的 inline 源码会直接复用文件脚本扫描。Python `-m` 会扫描能从 exec workdir 静态定位到的 `module.py`、包 `__init__.py` / `__main__.py`，找不到的已安装模块保留为依赖边界；Deno task、package task 与测试自动发现不会把任务名或后续数据参数误当作脚本。

Node、Deno、Bun 的显式路径型本地 preload 与真实文件入口会一并扫描；裸 package specifier 仍属于已安装依赖边界。远程入口、URI preload、带路径但无受支持扩展名的 preload、入口前的运行时 `--cwd` / PowerShell `-WorkingDirectory`，以及先 `cd` 再启动脚本等无法可靠复原解析目录的形式以 `[script_scan_ambiguous_launcher]` fail closed，要求改用显式本地入口和 exec workdir。Node 的外部配置、snapshot 配置和路径型测试 setup/reporter 等可能间接执行未扫描代码的 launcher option 也按同一原因阻断。

危险系统关键字和删除 API 会先在排除注释与普通惰性字符串后的代码区检查；位于 `subprocess` / `child_process` / `Process.Start` / `Start-Process` / WSH Run 等明确执行上下文中的字面命令、argv 列表和一次简单字面量变量传递仍会阻断。Python 的 `#` 注释和三引号字符串、JavaScript 正则字面量、PowerShell here-string、Batch 控制符分段，以及 Python/JavaScript/PowerShell/C# 的有界递归可执行插值分别按语言语义处理，避免把纯说明字符串当执行，同时不漏掉插值中的真实调用；插值在 8 层内仍未收敛时返回 `[script_scan_depth_exceeded]`，分析文本增长超过 16 MiB 时返回 `[script_scan_too_large]`，不会静默接受部分扫描结果。嵌套路径解析保留原始大小写、引号与空格；用于危险词匹配的小写规范化文本不会再用于选择待扫描文件。

单个脚本读取上限为 8 MiB，并支持 UTF-8、UTF-16 LE/BE BOM 与 UTF-32 LE/BE BOM；无 BOM 且 NUL 比例异常的文本会按不可读编码 fail closed。一次嵌套扫描最多读取 256 个不同的“文件 + 语言”组合、累计 64 MiB，同一真实文件的循环依赖只扫描一次。launcher、入口或解析目录含糊，脚本或工作目录不可读，超过单文件/调用图大小预算，以及新的未访问嵌套超过 8 层时，分别以 `[script_scan_ambiguous_launcher]`、`[script_scan_unreadable]`、`[script_scan_too_large]`、`[script_scan_depth_exceeded]` fail closed，不把“未能检查”当作安全。该机制仍是保守的静态扫描，不等价于解释器语义执行：裸依赖/package task、测试自动发现、更复杂的动态拼接、运行时下载、原生二进制和扫描完成后脚本被替换的 TOCTOU 仍需依赖权限模式、沙箱与后续执行链约束。

---

## 四、进程 / 网络沙箱与安全审计

**文件**：`src-tauri/src/commands/process_sandbox.rs`

在 Rust shell 执行链路中加入运行时沙箱策略，定位是“降低误操作和外部脚本副作用”，不替代命令黑名单、脚本扫描和 Trash Bin。产品层只暴露三档用户权限：**本机审计模式**、**离线隔离模式**、**受控联网模式**；内部 enum 保持 `LocalAudit` / `OfflineIsolated` / `ControlledNetwork`，后端的 `standard` / `externalSkill` / `installer` / `preview` / `restricted` 仍作为技术 profile 和审计归因使用。

> 重要边界：Job Object 不是“沙箱开关”，只负责托管型命令的生命周期清理。本机审计模式下的 GUI / detached launch 不应挂入带 `KILL_ON_JOB_CLOSE` 的 Job Object，避免 Chrome、VS Code、explorer 等外部应用在启动后被误杀。

### 4.1 执行 profile 与默认网络策略

| profile         | 典型来源              | 默认网络策略 | 说明                                                                         |
| --------------- | --------------------- | ------------ | ---------------------------------------------------------------------------- |
| `standard`      | 普通 `exec`           | `inherit`    | 不改变普通 shell 的联网行为                                                  |
| `externalSkill` | 外部 Script Skill     | `audit`      | 默认不直接阻断，但扫描命中会写入审计事件                                     |
| `installer`     | Skill 安装 / 依赖安装 | `inherit`    | 安装阶段允许下载依赖                                                         |
| `preview`       | 内置 Project Preview  | `inherit`    | 网络保持可用；文件/执行面另由独立 staging、输入 allow-list 和 owned PID 收口 |
| `restricted`    | 高风险 / 强隔离执行   | `blocked`    | 启用更严格的进程与网络约束                                                   |

`preview=inherit` 不代表直接信任 Agent 项目。内置 Project Preview 不在交付目录执行、不执行 npm lifecycle scripts，也不以端口扫描推断进程所有权；片段模式只执行 AgentVis 模板配置，完整项目模式则会在 staging 中执行项目 Vite/PostCSS/Tailwind 配置以保留插件、alias 和 CSS 工具链语义。它通过 app-cache staging、路径/依赖/资产预算（包括 256 KiB manifest 与 128 依赖上限）、Import Map native-JS-only fail-closed 预检、AgentVis 包装服务器配置、per-run health token 和 registry PID 生命周期提供专用边界。staging 由 Rust 原生命令创建并返回 `runId`/`ownerToken`，`.agentvis/active` 精确绑定该身份，跨实例文件 lease 保护活跃 workspace。正常清理还必须证明并释放本进程 registry lease，不能仅凭另一个实例的 marker/token 删除其 workspace；通过 app-cache 直接子目录、UUIDv4、链接/reparse 与 canonical containment 校验后，才原子隔离并 no-follow 删除，junction 只删链接。陈旧清理要求至少 24 小时且成功取得 lease，并以原生有界分页执行；部分删除遗留的 `.trash-{UUIDv4}` 仅凭严格配对且至少 24 小时的 root receipt 自回收。前端 backlog 有上限且每次只重试固定数量。完整项目配置是当前用户权限下的可执行 Node 代码，Local Audit 不构成 OS 级 VM；该边界不应被表述为任意不可信构建配置的强隔离、浏览器网络 DLP 或完整虚拟机隔离。

共享 Preview 模板还使用按模板划分的 OS 跨进程排他 lease，并把完成 marker 作为受控 `package.json` 的提交记录；更新 manifest 前先失效 marker。staging 删除器使用显式栈且限制单轮 100,000 个 entry、128 层和 2 秒，stale IPC 总计最多 5 秒；预算耗尽的部分 quarantine 保留 root receipt，后续 sweep 从剩余目录继续。窗口关闭会先同步使 renderer request ID 失效，再等待 service cleanup，避免 pre-service 扫描在关闭期间重新启动 Preview。

三档用户权限与后端机制的关系：

| UI 档位      | 后端模式                        | 文件边界                                                                                       | 网络边界                                                                                                                                           | 进程生命周期                                                                           |
| ------------ | ------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 本机审计模式 | `sandboxMode=LocalAudit`        | 不限制在 workdir；沿用保护路径和 Trash Bin                                                     | 继承系统网络                                                                                                                                       | CLI 使用托管；GUI 使用 detached launch                                                 |
| 离线隔离模式 | `sandboxMode=OfflineIsolated`   | AppContainer / workdir scope                                                                   | deny-all                                                                                                                                           | 禁止 detached launch 与桌面控制                                                        |
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
- AppContainer 文件系统授权除 workdir 外，还包含应用内 runtime、skills、deliverables 与用户级 `~/.agent-browser/tmp/screenshots` roots，供内嵌 Python、外部 Skill、交付物和浏览器截图流程使用。`brokerOnly` 文件型 IPC 会在 runtime 目录下通过临时文件 rename 发布请求，因此 ReadWrite 授权需要支持 create/write/rename/delete。
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
  backend:
    | 'none'
    | 'jobObject'
    | 'restrictedToken'
    | 'appContainer'
    | 'mainProcess'
    | 'broker'
    | 'wfpEnhanced';
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

Agent Trash Bin 是针对文件删除操作的**可恢复软删除层**。当 Agent 执行受支持的 `del`、`rmdir`、`Remove-Item` 等删除命令时，Rust 后端会在调用 OS 之前拦截命令，将目标文件/目录的可恢复内容保存到 app-data 下的 `Agent_Trash_Bin`，而不让原始删除命令真正销毁数据。

软删除只在可以证明安全的条件下提交：命令先通过命令文本/词法目标的保护路径检查；Trash Bin 展开白名单环境变量和 glob 后，会在任何转移前对全部最终目标做整批复检，同时阻止目标位于保护目录内、目标是保护目录祖先、或目标与 `protected_paths.json` / `Agent_Trash_Bin` 内部恢复元数据相交。复检同时比较词法路径与已存在祖先的 canonical 路径，`restricted` 模式还要求最终目标属于 allowed roots。**卷不参与授权判断**：目标是否位于系统盘、其他本地卷，或者是否已关联为 Agent 项目，都不会单独决定放行或阻断；在当前权限模式本来允许访问的前提下，用户仅在任务中给出的未关联项目绝对路径也按相同规则接管。卷只决定内部传输算法：同卷使用“不覆盖目标”的原子 rename，跨卷使用中央 app-data payload、经过验证的 candidate 和源路径同父目录下的短生命周期 hidden claim。任一步骤失败都会阻断原始命令，绝不降级为永久删除。

> **关键设计**：Agent-facing 工具返回值保持不透明，只返回固定成功 observation，例如 `Deleted successfully.`，不保留原命令的 stdout、提示文本或错误码语义，也不主动在 observation 中暴露 Trash Bin 真实路径、原始路径和恢复信息。这是降低 Agent 二次清理概率的上下文设计，不是路径访问控制；同用户进程仍可能通过其他本机能力读取 app-data、manifest 或日志。

> **隔离边界**：Trash Bin 的移动动作由宿主侧 Rust 代码执行，不天然受 AppContainer 约束。因此在离线隔离模式下，删除拦截必须带 allowed-roots 校验，只允许移动 workdir、`{AppDataDir}/runtime`、`{AppDataDir}/skills`、`{AppDataDir}/deliverables` 与用户级 `~/.agent-browser/tmp/screenshots` 内的目标。只有实际使用 `AppContainerFilesystem` 后端时，本次明确授予、当前存在且在按路径去重后实际生效的 readWrite/default filesystem grant 才会追加为宿主侧删除根；重复路径沿用 AppContainer 的 first-wins 访问级别。Restricted Token 不因携带 grant 扩权，readOnly 或不存在的 grant 也不提供删除权限。命中外部路径时直接返回沙箱阻断。受控联网目标形态沿用本机审计模式的保护路径、自定义保护路径和 Trash Bin，不按 workdir 做文件边界。

### 5.1 拦截作用时机

Trash Bin 在命令通过 `validate_command_safety_with_workdir()` 之后、OS 真实执行之前触发：

```
[validate_command_safety_with_workdir() → Ok]   ← Rust 硬阻断通过
         │
         ▼
[try_intercept_delete()]            ← Trash Bin 软删除拦截
   ├─ 解析成功 + 边界校验通过
   │    ├─ 同卷 → no-replace 原子 rename
   │    └─ 跨卷 → central candidate/payload + verify + sibling hidden claim
   │               → Pending → PayloadReady → Claimed → PayloadVerified → Ready
   │    → manifest 标记 Ready 后返回不透明成功消息给 Agent
   ├─ -WhatIf / 已不存在 / glob 零匹配 → 安全消费，不执行原始删除
   └─ 已识别删除意图但无法完整还原语义，或安全转移失败 → fail closed，不进入 OS 执行
```

通用脚本扫描之前会先做一次无副作用的 PowerShell 删除形态分类。只有已经由 Trash Bin 完整建模、显式使用 `-NoProfile` 且没有动态控制流或未知前缀的静态 `-Command` 删除，才会跳过内联脚本删除阻断并延后到 `try_intercept_delete()` 处理；这一步不移动文件。目标解析、保护路径、沙箱 allowed-roots 和传输校验仍在 Trash Bin 阶段执行。脚本文件、`.NET Delete()`、`iex`、缺少 `-NoProfile` 或其他未建模形态继续由脚本扫描器 / Trash Bin fail closed，原始 PowerShell 命令不会因此获得执行机会。

在 `restricted` 模式下，上述“解析成功”还必须满足目标路径属于 allowed roots；否则不会执行宿主侧移动。本机审计等不以 workdir 为唯一文件边界的模式下，未关联项目的绝对路径只要通过既有权限、保护路径和目标语义校验，就不会因为盘符或项目关联状态而被 Trash Bin 额外拒绝。

### 5.2 支持拦截的命令格式

| 命令格式                              | 示例                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `del filepath`                        | `del /f /q C:\project\old.log`                                                                                                                                                |
| `erase filepath`                      | `erase temp.txt`                                                                                                                                                              |
| `rmdir /s /q dirpath`                 | `rmdir /s /q dist`                                                                                                                                                            |
| `rd /s /q dirpath`                    | `rd /s /q .build`                                                                                                                                                             |
| PowerShell `Remove-Item`              | `powershell -NoProfile -Command "Remove-Item -LiteralPath 'path' -Force"`                                                                                                     |
| PowerShell 别名 `ri`/`rm`             | `powershell -NoProfile -Command "ri -LiteralPath 'path' -Force"`                                                                                                              |
| `cmd /D /C "del ..."` 嵌套            | `cmd /D /C "del /f /q file.txt"`                                                                                                                                              |
| 管道删除                              | `powershell -NoProfile -Command "Get-ChildItem -Force *.log \| Remove-Item -Force"`                                                                                           |
| 简单 `*` / `?` glob                   | `del C:\project\*.webp`（按 Rust glob 结果展开后逐个移动）                                                                                                                    |
| PowerShell 环境变量通配符             | `powershell -NoProfile -Command "Remove-Item -Path $env:APPDATA\com.agentvis.app\deliverables\Team\Agent\* -Recurse -Force"`                                                  |
| PowerShell 变量通配符                 | `powershell -NoProfile -Command "$target='C:\project'; Remove-Item -Path $target\* -Recurse -Force"`                                                                          |
| 严格白名单的 `Get-ChildItem` 循环删除 | `powershell -NoProfile -Command "$target='C:\project'; Get-ChildItem -LiteralPath $target -Force \| ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }"` |

解析器只把显式 `powershell` / `pwsh -Command` 包装内的 PowerShell 当作可执行脚本，并区分代码、字符串与注释；裸 `Remove-Item` 文本不会被误当成可安全接管的 PowerShell。所有被接管的静态 PowerShell 删除都必须显式使用 `-NoProfile`，且 launcher 不能用 `-WorkingDirectory` / `-wd` 改写工作目录；否则在启动前 fail closed，防止 profile、alias、provider 或相对路径基准改变有效目标。`-WhatIf` 只模拟、不移动，`-WhatIf:$false` 才按删除处理；`-Recurse:$false` 不会被误判为递归删除；`-LiteralPath` 中的通配符永不展开。目标表达式仅接受严格建模的字面量、精确普通变量或白名单环境变量形式；`~`、字符串拼接、复合赋值、方法/反射调用、module-qualified 删除命令和未建模的括号表达式都阻断。删除语句之前只允许可静态确定的普通变量赋值，以及严格建模的 `Get-ChildItem` 直接管道 / `ForEach-Object` 枚举；未知命令、控制流、调用运算符、反引号混淆和动态执行前缀统一 fail closed。普通变量按完整 token 替换；环境变量只展开 `WORKDIR`、`APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`HOME`、`TEMP`、`TMP` 白名单。该白名单值按真实子进程的覆盖顺序计算：主进程继承值、解析后的默认 `WORKDIR`、本次 exec 的 `env`，以及受限模式最终覆盖的 sandbox profile；Windows 环境键在注入受限子进程前按大小写不敏感语义归一，避免重复键改变最终值。未显式提供 `WORKDIR` 时，shell 也会向子进程注入解析后的工作目录。删除前若脚本以简单或复合赋值改写 `$env:*`、通过 `Set-Item` / `Copy-Item` / `Move-Item` 等 Env provider cmdlet（含常见别名）或 `.SetEnvironmentVariable()` 改变环境，则不猜测新值而是 fail closed。带 `Where-Object`、条件、`-Filter` / `-Include` / `-Exclude` 等无法完整保持语义的 foreach/管道形式也会阻断，`Get-ChildItem` 接管还要求显式 `-Force`。常见的 `iex` / `Invoke-Expression`、调用运算符、`Start-Process`、嵌套 PowerShell 和 `ScriptBlock.Create(...).Invoke()` 动态删除形态会按删除意图阻断；任意动态拼接仍属于后文声明的静态识别边界。

Windows 的实际外层 shell 统一使用 `cmd /D /S /C`，以禁用 Command Processor AutoRun；Agent 显式嵌套的 `cmd /C` / `/K` 删除也必须包含 `/D`，否则阻断。CMD 的组合开关、完整 `cmd.exe` 路径、`%ComSpec%`、双引号和多目标会被解析，单引号按 CMD 的字面文件名字符处理；内建命令紧凑写法 `del/f/q`、`erase/f/q`、`rd/s/q`、`rmdir/s/q` 也会接管。前置或紧贴命令名的重定向、`call` / `if` / `start` 包装等无法保持完全等价语义的删除会保守阻断。`del` / `erase` 仅接受 `/f`、`/q`，`/a`、`/p`、`/s` 或未知开关会 fail closed；其简单 `*` / `?` glob 只接管文件项，Windows 只读文件要求 `/f`。递归 `**` 与 `[]` 扩展 glob 不接管；一次删除最多预检 256 个枚举目标，并在每次 iterator 产出与后续预检阶段检查 2 秒 cooperative deadline，任一已观测到的预算超限都会在首个移动前 fail closed。该 deadline 不能抢占一次正在阻塞的目录/网络文件系统 I/O，因此不是严格的 wall-clock 硬超时。`rmdir` / `rd` 仅接受 `/s`、`/q` 和一个非 glob 目录目标，非空目录必须显式带 `/s`。PowerShell 直接删除非空目录必须显式带 `-Recurse`，Windows 只读文件要求 `-Force`。

多目标命令会在转移前完成解析、glob 展开项、保护路径/保留路径、allowed-roots、对象类型、祖先/后代目标重叠和递归语义预检，但整个批次不是一个可回滚事务。批次在同一次 manifest 锁内一次写入全部 Pending，再按每个目标实际所在卷选择同卷 rename 或跨卷事务，并逐项持久化状态。同卷条目的单次 no-replace rename 具备原子性；跨卷条目采用 `Pending → PayloadReady → Claimed → PayloadVerified → Ready`：先在中央 Trash 中完成 candidate 复制与内容验证，再把源对象原子改名为同父目录的随机 hidden claim；claim 与 candidate 再次一致（不一致时从 claim 重建 candidate）后，才把 candidate 原子发布为 payload。claim 与最终 payload 再次一致时，会先持久化 `PayloadVerified`，再开始递归清理 claim；因此即使清理中断、剩余 claim 已不再等于完整 payload，协调器也能凭该持久化边界继续收敛。若 claim 后原路径被其他进程重新创建，协调器绝不会把新对象当成 claim 删除。任一存储准备失败会在首个破坏性步骤前终止；若后续目标失败，已经完成的早先条目不会回滚，但原始删除命令仍绝不会执行。

跨卷首版只接管可按 no-follow 规则枚举和验证的普通文件与目录。若目标本身或递归内容包含符号链接、junction 或其他 reparse point，事务会在跟随它们之前 fail closed 并保留源对象；不通过递归复制把链接目标内容误装进 payload。同卷路径仍只对经目标复检、且无需遍历链接目标即可整体 rename 的对象使用原子移动。

对于命令文本已经呈现删除/清理意图，但 Trash Bin 解析器无法安全还原目标路径的复杂命令（多层管道链、未解析变量、PowerShell 中的 .NET `Delete()` 调用、Python/Node 内联删除、`rimraf`、`robocopy /purge`、非 dry-run 的 `git clean`、会删除工作树内容的 `git rm` 等），系统采用 **fail closed**：阻断执行并返回“请改用受支持的显式删除方式”的安全提示；直接、链式、`call` / `start` / 条件包装、常见 package-manager exec / dlx / corepack、`cmd /c` 或 PowerShell 动态包装的 `rimraf`（含版本规格）都按此处理，`git clean -n` / `--dry-run` 只预览，`git rm --cached` 只改索引，两者不作为文件删除拦截。只读的 `pnpm list rimraf`、`yarn why rimraf` 等“仅提及包名”的命令不会因此误判为删除。已识别删除的目标不存在或 glob 零匹配也由拦截器按幂等成功消费，不能在检查之后回退原始命令，从而关闭一类 TOCTOU 删除窗口。

### 5.3 不透明成功反馈（防二次清理）

拦截成功后，exec 工具的返回内容不暴露 Trash Bin 路径，也不说明文件被移入可恢复目录：

```
Deleted successfully.
```

这条消息直接进入 SA 的工具调用结果。它的目的不是向 Agent 解释软删除细节，而是让 Agent 将当前删除任务视为已经完成，降低其继续搜索 `Agent_Trash_Bin` 并二次删除回收站副本的概率；它本身不阻止同用户进程访问 app-data。

完整恢复信息仍然保存在 `trash_manifest.json` 和内部日志中，面向用户或“设置 → 文件保护”的 Agent 回收站 UI 展示；Agent 默认不应拿到这些路径。

当阻断错误命中带方括号的内部结构化 reason 时，TS exec 层会把可能包含内部路径与实现细节的原始错误替换为短小、i18n 化的 Agent observation。内部仍使用 `recoverable_delete_*`、`script_scan_*` 等精确 reason 供审计与调试，但 Agent 可见标签刻意不出现 Trash Bin、软删除、跨卷或扫描机制：

- `[recoverable_delete_required]` → `[DELETE_RETRY_REQUIRED]`：说明删除尚未完成，仅允许用 `del /f /q "..."`、`rmdir /s /q "..."` 或 `powershell -NoProfile -Command "Remove-Item -LiteralPath '...' -Force"` 之一，以一条直接命令和显式字面路径重试一次；再次失败后停止并报告。
- `[recoverable_delete_unavailable]` → `[DELETE_UNAVAILABLE]`：说明删除未完成，要求 Agent 保留当前目标，**不得再使用其他命令、脚本或工具尝试删除**，并向用户报告本次操作未完成；不暴露具体存储或传输失败原因。
- `[recoverable_delete_cross_volume]` → `[DELETE_UNAVAILABLE]`：仅保留为旧后端错误的 observation 兼容映射；跨卷本身不再是新实现的阻断原因，也不向 Agent 暴露卷信息。
- `[script_scan_unreadable]` → `[EXECUTION_INPUT_UNREADABLE]`：要求确认入口脚本与工作目录已经存在且可读，然后重试一次。
- `[script_scan_too_large]` → `[EXECUTION_INPUT_TOO_LARGE]`：说明脚本超出 8 MiB 执行输入限制或读取时持续增长，要求拆分或缩小后重试。
- `[script_scan_ambiguous_launcher]` → `[EXECUTION_ENTRY_AMBIGUOUS]`：说明当前命令或脚本将启动的本地入口无法可靠确定，要求使用带受支持扩展名的明确本地入口，并通过 exec workdir 指定运行目录。
- `[script_scan_depth_exceeded]` → `[EXECUTION_CHAIN_TOO_DEEP]`：说明脚本调用链超过 8 层，要求展开或拆分后重试。
- `[script_scan_unavailable]` → `[EXECUTION_INPUT_UNAVAILABLE]`：保留为旧错误的兼容兜底，只提供存在、可读、拆分或缩小等通用执行修复指引。

其他没有结构化 reason 的保护路径/通用校验错误仍走既有通用 redaction，不在这些结构化 reason 的替换保证内。Agent observation 只描述本次操作状态、受支持的修复方式与停止条件，不解释底层防护机制，也不提示存在可绕过的检查层。

这里不新增 brokered delete 工具，也不要求 Agent 学习第二套删除接口；Agent 仍使用习惯的 `exec`，只有被阻断时才收到有限上下文的恢复指令。

### 5.4 Trash Bin 存储结构

```
{app_data_dir}/
└── Agent_Trash_Bin/
    ├── trash_manifest.lock              # 独立 sidecar 排他锁
    ├── trash_manifest.json              # 删除记录索引
    └── items/
        └── <UUIDv4>/
            ├── candidate                # 跨卷复制与验证期间的临时候选
            └── payload                  # 已提交的普通文件/目录可恢复内容
```

每个新条目使用完整 UUIDv4 作为 `storage_id`，candidate/payload 位置只由受信任 Trash 根和 `storage_id` 推导，不依赖 manifest 中可篡改的 `trashPath`。根目录必须 canonicalize 后仍位于 app-data 下，且自身不能是符号链接、junction/reparse point 或非目录；payload 的父边界在恢复、永久清理和显式过期清理前都会重新验证。被当前 Trash Bin 识别并接管的删除命令不能以 Trash 根、manifest、payload、`protected_paths.json` 或包含它们的祖先目录为目标；这些维护操作只应通过用户 UI / 专用 Tauri 命令进行。未知原生程序、未识别的进程内删除或其他写入/重命名方式不在这条删除目标守卫的绝对保证内。

跨卷事务只在源对象同父目录短暂建立随机 hidden claim，不为每个卷创建永久 Trash Root：

```text
<source-parent>/
└── .agentvis-trash-claim-<UUID> # 被改名的原文件或原目录本身；仅短暂存在
```

manifest 的删除事务只记录 UUID `storage_id` 和状态，不接受任意外部 `claimPath`；claim 路径始终由原路径父目录、固定保留前缀和该 UUID 严格派生。用户恢复期间会另存 restore UUID、owner token 与 `Preparing` / `Committed` 阶段，但 staging 路径同样只能由可信前缀和 UUID 派生。协调器只在状态已是 `Claimed` / `PayloadVerified`，或 `PayloadReady` 且原路径已经消失时，才把该精确路径视为本事务 claim；`PayloadReady` 且原路径仍在时遇到同名项会按碰撞处理，不接管也不清理。只有完整 claim 与已发布 payload 一致且该事实已经原子持久化后，才能进入 `PayloadVerified`；该状态允许幂等清理崩溃后已经残缺的 claim。直接删除保留前缀路径、其内部子路径，或把活动 claim / restore staging 包进祖先目录删除都会被阻断。claim 和 restore wrapper 都不是新的永久用户数据目录；崩溃协调优先保留 source、claim、中央 payload 或已验证恢复目标中的有效副本。

`trash_manifest.json` 的新条目 `id` 使用“时间戳\_完整 UUID”，`storage_id` 使用完整 UUIDv4；同时记录原始路径、删除时间、触发命令、批次、类型与状态。读入时限制为 32 MiB，并校验 JSON、条目 `id` 非空且唯一、`storage_id` / restore UUID / owner token 为 canonical UUID 且各自唯一、时间戳和状态组合；不存在、零字节或纯空白 manifest 被视为空清单，非空但损坏或含重复记录的 manifest 会 fail closed。并发修改使用独立 sidecar 锁；每次锁获取的竞争等待上限为 2 秒，超时阻断当前阶段而不会无限等待同一把锁（一次高层操作若分阶段取锁，其总时长仍可能更长）。写入采用同目录临时文件、flush/sync 和原子替换，避免锁定旧 manifest inode 后被 rename 绕开。

同卷软删除可以从 `Pending` 经 no-replace rename 直接提交为 `Ready`。跨卷软删除采用 `Pending → PayloadReady → Claimed → PayloadVerified → Ready`：`PayloadReady` 表示 app-data 中的 candidate 已完成 no-follow 复制与逐项内容核对，但源仍在原位且最终 payload 尚未发布；`Claimed` 表示源对象已经同卷原子改名到短期 hidden claim。再次确认 claim 与 candidate 的内容一致后，candidate 才会在 app-data 内原子发布为 payload；发布后还会再次逐字节比较 claim 与最终 payload，只有仍一致时才先持久化 `PayloadVerified`，随后开始清理 claim。`PayloadVerified` 证明中央 payload 在该边界已经完整且可独立恢复，因此递归清理若因崩溃中断，即使剩余 claim 只是原树的子集，也能继续幂等收敛。进入该状态前，payload 的存在本身不被当作充分证明：若发生名称碰撞、外部替换或发布后变化，claim 会保留为恢复证据。任一阶段异常都不会回退执行原始删除命令，协调器也不会在内容验证结果尚未持久化时清理 source/claim。正常列表、用户恢复和过期清理只处理 `Ready`；其他状态作为崩溃恢复现场保留。

当前实现为保持状态与 manifest 一致性，跨卷目录复制和验证期间仍可能长时间持有全局 sidecar manifest 锁。大目录或慢速卷会串行化其他删除、列表、恢复和清理操作，并可能让等待者触发锁超时；这是明确的性能债，后续应拆为 per-entry journal/lease 与短时 manifest 提交，而不能以放松恢复状态为代价规避。

### 5.5 用户恢复与手动清理

“设置 → 文件保护”中的 **Agent 回收站** 会读取 manifest 展示最近删除条目，并提供用户侧恢复/清理能力：

- **选择回收站条目**：用户勾选一个或多个条目后，再执行“恢复选中”或“清理选中”。
- **整批选中**：同一次删除命令产生多个条目时，条目末端的“整批”按钮只负责把同批条目加入选中集合，不直接执行恢复或清理。
- **恢复选中**：仅处理 Ready 条目。恢复前先把随机 restore UUID、独立 owner token 和 `Preparing` 阶段写入条目的 restore journal。若 payload 与原路径同卷，使用 no-replace 原子 rename；若跨卷，则先在原路径父目录原子创建可由 journal 重建的 `.agentvis-trash-restore-<UUID>` staging wrapper，并在其中写入匹配 owner token 的所有权 marker，再把载荷 no-follow 复制到 wrapper 内。验证后以 no-replace rename 提交到原路径，随后再次比较恢复目标与中央 payload；只有确认一致后才把 journal 持久化为 `Committed`，然后清理自有 staging 与中央副本。只有 marker 匹配的 wrapper 才能被协调器清理；预先存在的同名用户路径不会被接管或删除。清理中断可以凭 `Committed` 阶段幂等续做，而不再要求残缺中央目录与完整目标重新匹配。进程若在复制、提交或清理之间退出，下一次协调会清理自有未提交 staging、重试中央副本清理，或在提交前两份内容不一致时保留两者和 journal；不会把“目标已恢复但 manifest 尚未删除”永久误报为普通 `original_exists` 冲突。原路径已存在、复制/验证失败、链接/reparse 类型不受首版支持或最终 rename 失败时，中央 payload 与 manifest 记录都会保留，不覆盖或合并现有目标。该路径同时兼容旧版位于 app-data Trash 根直属位置的 legacy payload。
- **清理选中**：仅处理 Ready 条目，使用由 `storage_id` 推导并重新验证的 payload 路径永久删除；删除失败的条目继续保留在 manifest 中。跨卷首版不会创建链接/reparse payload；对历史链接类 payload 的恢复不跟随其目标，无法安全重建时保留条目并报告冲突。

长耗时恢复或清理不会因为用户关闭设置页而取消。前端把活动操作保存在跨组件生命周期的全局状态中，重开设置时显示“后台继续”状态并保持条目只读；操作成功或失败后以递增 revision 使旧列表失效，并自动重新读取。列表 IPC 将 manifest 锁超时返回为结构化 `busy`，UI 按 `retryAfterMs` 自动重试且不弹“加载失败”；Trash 路径和保护路径独立加载，不会被列表暂时忙碌连带清空。只有 `ready` 且已对应最新 operation revision 的真实零条目结果才显示空状态，`idle` / `loading` / `busy` / `error` 或操作中的状态都不会伪装成“暂无记录”。

Pending / PayloadReady / Claimed / PayloadVerified 等非 Ready 删除状态不会出现在正常列表，也不能被用户恢复、手动清理或过期清理；带活动 restore journal 的 Ready 条目同样不能被手动/过期清理，只由故障协调逻辑保守收敛。这些操作面向用户，不通过 Agent 执行恢复命令，因此不会把回收站内部路径暴露给 Agent。设置页的永久清理使用应用内受控确认弹窗：点击“清理选中”只冻结待清理 ID 并打开确认界面，只有确认回调才调用后端；取消、关闭弹窗或直接关闭设置页都不会开始清理。

### 5.6 用户主动删除与 Windows 回收站

右栏工作区文件列表中的删除属于**用户主动操作**，不会写入 Agent Trash Bin，也不会生成 Agent 删除审计记录。这样可以保持 Agent Trash Bin 只展示 Agent 发起的删除，便于用户判断 Agent 是否误删文件。

用户确认后，前端调用独立的 `file_move_to_system_trash` 命令。后端不会信任前端提供的工作区根目录，而是根据 `agentId` 从数据库读取 Agent 绑定的外部项目路径；未绑定项目时，则根据数据库中的 Hub/Agent 名称推导对应的 `deliverables/<hub>/<agent>` 根目录。目标路径必须满足：

- 是绝对路径，且父目录 canonicalize 后仍位于该 Agent 的可信工作区根目录内；
- 不是工作区根目录本身；
- 目标当前存在，且不位于 AgentVis 拥有的工作区导入 staging 内；
- 末级链接只作为链接项交给 Windows Shell，操作不启用 `FOFX_NOSKIPJUNCTIONS`，不会主动遍历 junction。

Windows 端通过 `IFileOperation` 和 `FOFX_RECYCLEONDELETE` 将条目移入系统回收站，并使用独立 STA 线程执行 Shell COM 操作。网络共享、特殊文件系统、文件占用或其他不支持回收站的情况会直接返回失败并保留原文件；实现中**没有永久删除 fallback**。

### 5.7 过期清理（当前未自动调度）

后端提供 `startup_trash_cleanup` / `cleanup_expired_items` 维护入口：只有状态为 Ready、时间戳有效、payload 路径重新验证通过且**达到或超过 30 天**的条目才会物理删除；删除成功或 payload 确认不存在后才从 manifest 移除。路径异常、检查失败或删除失败会保留记录和现场。当前该 Tauri command 仅注册，尚未由 Rust setup 或 renderer 启动流程调用，因此应用启动不会自动执行 30 天物理清理；条目会保留到用户手动清理或未来显式接入维护调度。

### 5.8 当前安全边界与已知限制

- **卷不是授权边界**：系统盘、其他本地卷和项目关联状态不会单独决定 Agent 删除是否可接管。保护路径、内部保留路径、当前沙箱/allowed-roots 与删除语义才是授权边界；因此，当前权限允许访问的未关联项目绝对路径与已关联工作区具有相同的 Trash Bin 行为。卷只选择同卷 rename 或跨卷 copy/verify/claim 传输。网络共享、只读介质、离线卷或不支持所需原子操作的文件系统仍可能返回 `[recoverable_delete_unavailable]`，但这属于具体存储能力失败，不是“非 app-data 卷默认禁止”。旧 `[recoverable_delete_cross_volume]` 只保留 observation 兼容。
- **跨卷保证的是普通内容可恢复，不是文件系统完整镜像**：首版逐项验证普通文件主数据流、目录层级与名称，能够恢复常规源码、脚本、截图和临时文件；不承诺完整保留 ACL/owner、NTFS ADS、硬链接拓扑、稀疏/压缩属性、扩展属性或所有时间戳。符号链接、junction 和其他 reparse point 不会被跟随，跨卷删除与恢复首版遇到这些对象会保留现场并阻断，而不是把链接目标复制成普通内容。
- **全局 manifest 锁仍是性能债**：跨卷大文件或目录的复制与验证可能持有全局 sidecar 锁较长时间，使其他删除、列表、恢复和清理串行等待或超时。后续应以 per-entry journal/lease 和短时原子 manifest 提交缩小锁粒度；当前不能为了吞吐量跳过 `PayloadReady` / `Claimed` / `PayloadVerified` 的持久化边界。
- **静态识别不是完整语义证明**：直接命令和已知脚本 API 覆盖常见 Agent 删除方式，但本机审计模式中的原生可执行文件、动态拼接/反射、运行时下载代码或未知解释器仍可能在进程内部删除文件。Restricted Token / AppContainer 也不应被表述为通用“禁止 DELETE”能力；它们的实际 ACL/allowed-roots 可能仍允许删除。
- **包脚本不会被递归展开**：直接调用、命令链、`call` / `start` / 条件包装、常见 package-manager exec / dlx / corepack、`cmd /c` 或 PowerShell 动态包装中出现的 `rimraf` 会 fail closed，但 `npm run clean`、其他 package lifecycle 以及构建工具内部 cleanup 当前不会展开 `package.json` 或运行时调用图；其中的 `rimraf` / `fs` 删除属于上一条所述的解释器或原生进程内部副作用，不在 Trash 接管保证内。
- **仍有同用户 TOCTOU 面**：脚本扫描后到解释器打开脚本之间、路径 canonicalize 后到 rename 之间，以及跨卷 candidate 验证、源改名为 claim、claim 复核和移除之间，仍存在被同权限进程替换祖先/路径或通过既有打开句柄继续写入对象的窗口。当前通过整批预检、破坏性步骤紧前复检、no-replace rename、claim 后二次内容验证、链接 no-follow 和状态协调降低风险，但尚未使用 handle-relative 路径遍历、稳定文件标识或全程绑定同一对象的句柄事务；该机制不是对抗同用户恶意进程的绝对隔离。
- **非 Windows 恢复的断电耐久性仍有限**：恢复使用 no-replace rename、restore journal 与父目录 best-effort sync；普通进程崩溃可由 `Preparing` / `Committed` 协调恢复，但 sync 错误目前不会提升为事务失败。极端断电下仍可能出现 rename、目录项和 manifest 的持久化顺序不一致，后续若扩展跨平台支持应把 sync 结果纳入提交判定并补 fault-injection 测试。
- **manifest 不是防同用户篡改的密码学账本**：结构与大小、条目 `id` 非空且唯一、`storage_id` / restore UUID 为 canonical UUID 且各自唯一、状态以及 payload / staging 派生路径与边界会严格校验，写入具备锁和原子性，但没有签名/MAC；`original_path` 目前只要求非空，不能证明仍是最初删除位置。LocalAudit 下的 Agent exec 或其他能够以同一用户身份直接写 app-data 的进程，仍可能通过未识别删除、写入或重命名篡改元数据，甚至改变一个后续用户恢复操作的 no-clobber 落点；恢复目标已存在时会拒绝覆盖，payload 边界校验用于限制其余后果。

因此，实际目标行为是“常见直接删除可恢复；一旦识别到删除意图但无法完整还原语义，就在启动前停止；可静态识别的脚本删除要求改写为直接命令”，而不是宣称所有未知命令都能被识别，或对任意同用户代码提供绝对不可删除保证。

---

## 六、TS/Rust 双层设计说明

| 对比维度       | TS 层（ExecSafetyPolicy）          | Rust 层（command_validator）                         |
| -------------- | ---------------------------------- | ---------------------------------------------------- |
| **定位**       | 第一道防线，快速反馈               | 宿主侧入口硬校验；命中策略不可由 TS 绕过             |
| **匹配方式**   | 正则 `\b` 词边界，精确匹配         | 保守子串、token/子命令、路径归一化与脚本静态扫描组合 |
| **阻断时机**   | 在 SA 工具调用层，未发起 Tauri IPC | 在 Tauri 命令层，命令到达 OS 前                      |
| **黑名单覆盖** | 与 Rust 层基本一致                 | 额外实现 icacls 组合阻断、脚本内容扫描               |
| **放行能力**   | 有白名单，可跳过 Checkpoint        | 无白名单，只做阻断不做放行                           |

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
  └─→ validate_script_content()    ── Err ─→ 🛑 脚本内容扫描阻断
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
  ├─→ 受支持解析 + 最终目标复检（卷不参与授权）
  │     ├─→ 同卷：Pending → no-replace rename → Ready
  │     └─→ 跨卷：central candidate/payload + verify + sibling hidden claim
  │                 → Pending → PayloadReady → Claimed → PayloadVerified → Ready
  │     → 返回不透明成功消息（Agent 不感知回收站路径）  ── ✅ 不调用 OS 删除
  ├─→ -WhatIf / 目标不存在 / glob 零匹配 → 安全消费  ── ✅ 不调用 OS 删除
  └─→ 已识别删除意图但语义不完整，或安全转移失败 → fail closed  ── ✅ 不调用 OS 删除
  │
  ▼
仅未被有限识别集消费或阻断的命令进入 OS 执行
```

`validate_path_write_safety()` 属于原生文件写入/导入命令的路径保护，不在 `shell_execute` 这条调用链中；shell 删除的最终目标保护由 `try_intercept_delete()` 内的目标级复检承担。未命中有限识别器的未知或动态进程内删除仍由权限、沙箱和文件系统 ACL 等边界约束，不属于 Trash Bin 的接管保证。

---

## 八、安全设计说明

### 精确匹配 vs 宽松匹配

- **TS 层**使用 `\b` 词边界正则，确保 `format` 不误报 Python 的 `str.format()`，`wmic` 不误报只读查询。
- **Rust 层**对历史黑名单保留保守 `contains()` 匹配，同时对工具名/子命令、相对路径最终落点和脚本启动器增加语义检查；这些规则仍是有限识别集，不应描述为完整 shell 解析器。
- **`format` 命令单独处理**：从黑名单中独立，通过 `is_format_drive_command()` 检测 `format X:` 盘符模式，避免编程语言中 format 函数的大量误报。

### 组合阻断 vs 全量阻断

- `wmic`、`icacls`/`cacls`、`Set-Acl` 等工具本身有合法的只读查询场景，不全量禁止。
- 仅当它们与**写入类子命令**或**系统核心目录**组合出现时才阻断，实现精准管控。

### 缓存热更新

自定义保护路径通过按 app-data 根区分的 `RwLock` 全局缓存，首次 IO 后命中缓存，UI 更新保护目录后调用 `reload_custom_protected_paths()` 立即刷新，兼顾性能与实时性。磁盘配置损坏、超限或普通读取失败时保留上一份有效缓存；已加载值不会因磁盘文件消失而被普通校验或显式 reload 清空，显式 reload 会报错。只有尚无缓存的首次加载或应用重启后仍找不到配置文件时，才按空配置初始化。

### Trash Bin fail-closed 策略

对于已被当前识别器判定为“存在删除/清理意图”、但解析器无法安全确定目标的复杂格式（如嵌套多级管道、未解析变量、脚本片段里的 `.Delete()`、`git clean` / `robocopy /purge` 等），Trash Bin 选择 fail closed 阻断，而不是回退到 OS 执行。返回提示会要求 Agent 改用受支持的显式删除方式，使后续重试更容易被软删除拦截。未命中有限识别集的动态/未知实现仍可能继续执行，需由权限、沙箱和文件系统 ACL 等其他层约束。
