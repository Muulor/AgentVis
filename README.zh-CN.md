<p align="center">
  <img src="public/banner.png" alt="AgentVis" width="100%">
</p>

# AgentVis
<p align="center">
  <a href="https://github.com/Muulor/AgentVis/releases/latest">下载 Windows 版</a> | <a href="README.md">English README</a>
</p>
<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-backend-b7410e">
  <img alt="React" src="https://img.shields.io/badge/React-18-61DAFB">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6">
  <img alt="Windows first" src="https://img.shields.io/badge/platform-Windows%20first-2563eb">
</p>

AgentVis 是一个从零构建的本地 AI Agent 运行平台。它把 Agent 的规划、执行、工具调用、文件修改、记忆、技能、知识库、可视化、沙箱、安全审计和人工介入放进同一个可治理的桌面工作空间。它易用免部署，一键安装秒速启动，能快速进入你的业务场景。每一个 Agent 都是独立窗口，拥有完整的执行能力并支持自定义的配置，无需反复创建会话窗口或清空、压缩会话，每个 Agent 会维持充足的上下文窗口，稳健地执行你的持续性任务或新任务，你可以在数百轮对话后搜索或引用你们的历史对话，查看你们的协作历程，回溯你曾经处理过的棘手任务来巩固你的经验，让他们成为你长期稳定合作的伙伴。

你可以创建多个 hub 来作为你不同业务场景的团队，每个 hub 能创建多个 Agent 来配置不同的模型、规则、角色、技能、知识库、事实偏好、沙箱权限、定时任务，不同 hub 的 Agent 能同时执行各类型的任务互不干扰。如果你有特别的想法，你可以让他们去查看对方的工作间并跟进相关工作，或关联同一个项目目录作为共享工作间，这会成为你自由掌控并协调 Agent 的工作方式。
另外，你也可以在hub中@你团队中不同角色的 Agent，他们会以净空的视角和各自设定好的规则/角色来进行头脑风暴，你可以将讨论的结果引用回 agent 的窗口来让 Agent 更好地处理任务，一切基于你场景需求。

<p align="center">
  <a href="docs/User%20Guide/quick_start.md">快速开始</a>
  ·
  <a href="docs/User%20Guide/AgentVis%20技能使用指南.md">技能指南</a>
  ·
  <a href="docs/User%20Guide/AgentVis%20沙箱权限与安全审计指南.md">安全指南</a>
  ·
  <a href="docs/User%20Guide/IM 机器人配置指南.md">IM使用指南</a>
</p>


## 演示视频

<p align="center">
  <a href="https://agentvis.muulor.workers.dev/assets/Harness-demo.mp4">
    <img src="public/demo-cover.png" alt="AgentVis 演示视频：Just Tell Your Agent" width="100%">
  </a>
</p>

<p align="center">
  <a href="https://agentvis.muulor.workers.dev/assets/Harness-demo.mp4">点击封面观看演示视频</a>
</p>

## 核心能力

| 能力 | 说明 |
| --- | --- |
| MB + SA 多智能体协同 | Master Brain 负责拆解任务和派遣，Sub-Agent 在动态工具白名单内执行具体步骤。 |
| FSM 可视化运行时 | 将 Agent 执行拆成准备上下文、主脑决策、派遣、观察、评估、终止等状态，前端实时展示。 |
| Human-in-the-Loop | 用户可以在 Agent 执行任意步骤主动暂停，用自然语言纠偏、补充约束或改变方向。 |
| 三层记忆体系 | 短期缓冲、状态摘要、长期事实和任务经验共同组成跨轮上下文。 |
| RAG 知识库 | Parent-Child 分块、Embedding、BM25、RRF 融合和 Rerank 支撑私有文档召回。 |
| Fast Apply + Diff 审批 | XML 修改协议、四级内容匹配、Myers Diff、快照和回滚让代码改动可审阅、可撤销。 |
| 可视化增强 | Planning 回复可自动增强为 ECharts、Mermaid 和交互式 Widget。 |
| Vite 实时预览 | Agent 生成的 React、Vue、Vanilla 前端项目可在应用内启动 Vite Dev Server 预览。 |
| 定时任务 | Agent 可配置频率驱动或高级 Cron 任务，自动以 Planning 模式执行。 |
| 飞书 / Slack 远程控制 | 通过 IM 消息向 Agent 下发任务，在消息卡片里查看进度并随时停止。 |
| 外部 Skill 生态 | 支持 Guide / Script 两类外部技能包，安装前接入 AI 驱动安全审查。 |
| 五层安全防护 | LLM 软约束、TypeScript 工具拦截、Rust 命令硬阻断、进程 / 网络沙箱、Trash Bin 软删除。 |

## 适合谁使用

- 希望在本地环境中使用 Agent 作为通用助手来协作完成各类型日常任务的开发者。
- 想验证多智能体协作、长链路任务执行和 Agent 可观测性的研究者或产品团队。
- 需要把 Agent 接入飞书 / Slack、定时任务、浏览器自动化和办公文档处理的效率工具用户。
- 想为 AgentVis 编写或审计外部 Skill 的开源贡献者。

## 快速开始

### 使用安装包

当前发布版本主要面向 Windows。

1. 下载并安装 [AgentVis Windows 安装包](https://github.com/Muulor/AgentVis/releases/latest)。
2. 首次进入后，按初始化引导配置 API Key、云端服务和预设技能依赖，创建 Hub 和 Agent 即可开始协作。

完整上手流程见 [AgentVis 快速开始指南](docs/User%20Guide/quick_start.md)。

### 从源码运行

建议在 Windows 上开发和运行。

环境要求：

- Node.js 18 或更高版本
- npm
- Rust stable toolchain
- Tauri 2 所需 Windows 桌面构建环境
- WebView2 Runtime
- Python 3.11 或更高版本，用于开发环境下的外部 Script Skill runtime 回退

安装依赖：

```powershell
npm install
```

启动完整 Tauri 桌面应用：

```powershell
npm run tauri dev
```

只启动前端 Vite：

```powershell
npm run dev
```

构建前端产物：

```powershell
npm run build
```

构建 Tauri 安装包：

```powershell
npm run tauri build
```

Tauri 打包前会构建 Python runtime、前端产物和 broker helper。打包资源包含内置 Skills、native helper scripts、嵌入式 Python、预构建 Python runtime、Node bundle 和 broker 二进制。

## 安全模型

AgentVis 默认假设 Agent 可能出错，也可能被外部内容诱导。因此安全设计不是一个弹窗，而是一条从决策到执行的连续防线。

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 1. LLM 行为软约束 | Prompt、FSM、Master Brain、Sub-Agent | 降低危险决策概率，注入安全优先级、预算、风险字段和 HITL。 |
| 2. TypeScript 工具拦截 | Native Skill、Tool Guard、ExecSafetyPolicy | 在工具落地前进行风险分级、黑名单阻断和 Checkpoint 审批。 |
| 3. Rust 命令硬阻断 | `command_validator.rs`、shell 命令 | 拦截系统破坏、保护路径、危险脚本和不可接受命令。 |
| 4. 进程 / 网络沙箱 | `process_sandbox/`、broker、direct-audit | 根据沙箱档位控制进程生命周期、网络出口、直连授权和审计。 |
| 5. Trash Bin 软删除 | `trash_bin.rs` | 将可拦截删除改写为回收站移动，降低不可逆破坏半径。 |

三档用户权限：

| 模式 | 典型用途 |
| --- | --- |
| 本机审计模式 | 默认本地 Agent 工作、常规项目开发、本机自动化。 |
| 受控联网模式 | 邮件、GitHub、云 API、受控浏览器自动化和需要联网但要审计的任务。 |
| 离线隔离模式 | 不可信脚本、第三方 Skill、高风险命令和需要禁网隔离的任务。 |

边界说明：受控联网模式强调网络出口收口和审计，非所有普通 `exec` 或 Guide Skill 的直连都已经被 OS 层完整捕获。更完整的网络隔离边界见 [沙箱权限与安全审计指南](<docs/User Guide/AgentVis 沙箱权限与安全审计指南.md>) 和 [ControlledNetwork 回归矩阵](<docs/AgentVis docs/AgentVis ControlledNetwork 回归矩阵.md>)。

## 数据与隐私

- AgentVis 是本地桌面应用，Hub、Agent、消息、文件、记忆、RAG 索引、快照、Diff 和 Cron 数据默认保存在本机 SQLite 数据库中。
- API Key 和部分外部服务凭据通过 Windows Credential Manager 加密存储。
- LLM 调用、Embedding、联网 Skill 或用户主动配置的云服务会向对应服务商发起请求。
- Agent 删除文件时会优先进入 AgentVis Trash Bin，便于恢复与审计。
- 用户可在设置中导出、导入和备份关键数据。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Tauri 2 |
| 前端 | React 18、TypeScript、Vite 6 |
| 状态管理 | Zustand |
| UI 基础 | Radix UI、Lucide React、CSS Modules |
| 可视化 | ECharts、Mermaid、Widget Renderer |
| 后端 | Rust、Tokio、Tauri Commands |
| 数据库 | SQLite、sqlx、向量索引接口 |
| LLM 网关 | OpenAI、Anthropic、Gemini 及兼容协议适配 |
| 文档处理 | Rust 侧 DOCX、XLSX、PDF、PPTX 解析；外部 Skill Python runtime |
| 工程质量 | ESLint、TypeScript、Vitest、Husky、lint-staged |

## 项目结构

```text
AgentVis/
├─ docs/AgentVis docs/         # 核心技术文档
├─ docs/User Guide/              # 用户上手与配置指南
├─ public/                     # 应用静态资源
├─ scripts/                    # 构建和 runtime 辅助脚本
├─ src/                        # React + TypeScript 前端源码
├─ src-tauri/                  # Tauri + Rust 后端源码
├─ runtime-requirements-v1.txt # 外部 Python runtime 依赖清单
├─ package.json                # npm 脚本和前端依赖
├─ vite.config.ts              # Vite 配置
└─ vitest.config.ts            # Vitest 配置
```

关键源码索引见 [PROJECT_STRUCTURE.md](<docs/AgentVis docs/PROJECT_STRUCTURE.md>)。

## 常用脚本

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Vite 前端开发服务器。 |
| `npm run dev:broker-helper` | 构建调试版 broker helper 资源。 |
| `npm run dev:sync-skills` | 同步 Tauri 开发模式所需的内置资源。 |
| `npm run dev:tauri` | 构建 broker helper、同步资源并启动 Vite，供 Tauri dev 使用。 |
| `npm run build` | `tsc` 检查后执行 Vite 构建。 |
| `npm run build:python-runtime` | 构建外部 Skill 使用的 Python runtime。 |
| `npm run build:broker-helper` | 构建 release 版 broker helper 和 WFP helper。 |
| `npm run preview` | 预览 Vite 构建产物。 |
| `npm run lint` | 对 TS/TSX 执行 ESLint 检查。 |
| `npm run test:run` | 执行一次 Vitest 测试。 |
| `npm run tauri <cmd>` | 调用 Tauri CLI，例如 `npm run tauri dev`、`npm run tauri build`。 |

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [快速开始](docs/User%20Guide/quick_start.md) | 从首次安装到模型、云端服务、技能依赖、Agent 设置和工作区配置。 |
| [技能使用指南](<docs/User Guide/AgentVis 技能使用指南.md>) | 全局技能、单 Agent 技能绑定、Guide / Script 区别和常见排查。 |
| [沙箱权限与安全审计指南](<docs/User Guide/AgentVis 沙箱权限与安全审计指南.md>) | 本机审计、受控联网、离线隔离和安全审计事件。 |
| [IM 机器人配置指南](<docs/User Guide/IM 机器人配置指南.md>) | 飞书和 Slack 机器人配置，让 IM 消息触发 Agent 任务。 |
| [四大核心特性解析](<docs/AgentVis docs/features_deep_dive.md>) | 可视化增强、实时预览、Cron、IM 通道深度解析。 |
| [MB / SA 协同工作机制](<docs/AgentVis docs/MB_SA_协同工作机制.md>) | Master Brain 与 Sub-Agent 协同执行框架。 |
| [上下文管理机制](<docs/AgentVis docs/上下文管理机制.md>) | MB / SA 上下文、压缩、Task Artifact 和 HITL。 |
| [记忆机制介绍](<docs/AgentVis docs/记忆机制介绍.md>) | 三层记忆、触发、注入和 UI 设计。 |
| [RAG 机制](<docs/AgentVis docs/Rag机制.md>) | Hybrid Search + RRF 的 RAG 管线。 |
| [Skill 功能技术文档](<docs/AgentVis docs/Skill 功能技术文档.md>) | Native / External Skill、执行合约、安全审查和 runtime。 |
| [Diff 与 Fast Apply](<docs/AgentVis docs/Diff 与 Fast Apply 功能技术介绍.md>) | XML 修改协议、Diff、快照和回滚。 |
| [Agent 行为安全防护](<docs/AgentVis docs/AgentVis Agent 行为安全防护机制.md>) | 五层 Agent 行为安全防护。 |

## 贡献指南

AgentVis 作为个人开发者的开源项目，有很多不足之处，欢迎通过 Issue、Discussion 和 PR 参与 AgentVis。Fork 本仓库并创建分支，以 Ai Native 的工作方式，让 Agent 先查看相关功能文档和架构文档，来辅助你的开发工作。

为了让 Agent 相关改动保持可审计，请遵守以下约定：

- 修改 TS/TSX 后，只对改动文件运行 `eslint --fix --quiet`，并运行 `tsc --noEmit`。
- 修改 Rust 后运行 `cargo check`。
- 新建功能组件需要添加头文件注释并将组件添加到PROJECT_STRUCTURE.md。
- 新增或修改用户可见文案、Toast、错误提示、聊天气泡内容、工具 observation、会影响 Agent 决策的系统 / 工具返回消息时，优先接入现有 i18n，避免硬编码中文或英文。
- 内部日志和纯调试信息不强制 i18n。
- 涉及文件、命令、网络、外部 Skill、凭据和沙箱的改动，请同时更新相关安全文档或测试说明。

示例：

```powershell
npx eslint --fix --quiet src\path\to\changed-file.tsx
npx tsc --noEmit
cargo check --manifest-path src-tauri\Cargo.toml
```

- [GitHub Issues](https://github.com/Muulor/AgentVis/issues) -- Bug 反馈和功能建议
- [GitHub Discussions](https://github.com/Muulor/AgentVis/discussions) -- 提问和讨论

对 AgentVis 有任何疑问或建议可通过邮件联系：muulor@gmail.com，或添加作者的微信: Hexaner-

## FAQ

### AgentVis 需要部署服务器吗？

不需要。AgentVis 是 Tauri 桌面应用，核心数据和执行环境都在本机。飞书 / Slack 集成使用 WebSocket 长连接，不需要公网 IP、Webhook 服务器或反向代理。

### 数据会上传到云端吗？

对话记录、文件操作、记忆数据和本地数据库默认保存在本机。LLM 调用、Embedding、联网 Skill 或用户主动配置的云服务会向对应服务商发起请求。

### AgentVis 支持哪些模型？

内置支持 OpenAI、Anthropic、Gemini 及多个兼容协议供应商，也支持 Local 自定义 API 端点。用户可以在设置中添加自定义模型。

### 可以开发自己的 Skill 吗？

可以。外部 Skill 使用 `SKILL.md` 描述能力和执行合约，支持 Guide 和 Script 两种模式。导入本地包或 GitHub 包时会经过安全审查，安装后可在设置中刷新生效。

### 为什么需要 Diff 审批？

Agent 具备写文件能力，Diff 审批让每一处改动在写入前可见、可接受、可拒绝，并可通过快照回滚。

### 当前是否跨平台？

当前产品主要面向 Windows。Tauri 框架具备跨平台能力，但本项目的沙箱、Credential Manager、WFP、桌面自动化和部分 runtime 能力带有 Windows 优先设计。

## License

本项目采用 [MIT License](LICENSE) 开源，欢迎自由使用、修改、分发与贡献。
