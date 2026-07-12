# AgentVis Skill 功能技术文档

> 面向对象：开发者 / 技能包开发者 / 产品团队
> 命名说明：用户界面中的「Task 模式」对应内部模式值与路径 `planning`，既有代码标识保持不变。

---

## 目录

1. [概述](#概述)
2. [技能分类体系](#技能分类体系)
3. [原生技能（Native Skill）](#原生技能native-skill)
4. [外部技能（External Skill）](#外部技能external-skill)
   - [内置 skill-creator](#内置-skill-creator)
   - [Guide 模式](#guide-模式)
   - [Script 模式](#script-模式)
5. [技能包格式 — SKILL.md 规范](#技能包格式--skillmd-规范)
6. [安装流程](#安装流程)
7. [触发机制](#触发机制)
8. [安全审查机制](#安全审查机制)
9. [Python Runtime 环境](#python-runtime-环境)
10. [排错指南](#排错指南)

---

## 概述

Skill（技能）是 AgentVis Sub-Agent 的能力扩展单元。当前实现中，Native Skill 以原生 Tool 的形式注入；External Guide Skill 以说明书、脚本和资源上下文注入；External Script Skill 通过统一原生工具 `external_skill_execute` 按合约执行，并不是每个外部 Script 都注册成独立 Tool。

- **SKILL.md 即文档即代码**：技能的元数据、触发规则、使用手册、执行合约全部写在同一个 Markdown 文件中。
- **双轨架构**：内置原生技能（打包时固化）与外部技能包（运行时热加载）并行，互不干扰。
- **双模式运行**：外部技能支持 Guide 模式（LLM 自主决策执行路径）和 Script 模式（合约驱动的严格参数化调用）。

---

## 技能分类体系

```
Skill
├── Native Skill（原生技能）        ← 内置，构建时打包，无需安装
│   ├── exec          Shell 命令执行
│   ├── read          文件读取
│   ├── file_write    文件写入
│   ├── web_search    网络搜索
│   ├── local_search  本地代码搜索（grep / AST / outline）
│   ├── cron          定时任务管理
│   ├── generate_image 图片生成
│   ├── im_send       IM 消息发送（飞书 / Slack）
│   ├── conversation_search  历史对话检索技能
│   └── external_skill_execute Script Skill 合约执行入口
│
└── External Skill（外部技能）       ← 用户安装或随包部署，运行时加载
    ├── Guide 模式   SKILL.md 是给 LLM 的能力说明书
    └── Script 模式  SKILL.md 包含 Execution Contract，通过 external_skill_execute 调用
```

> **命名保护**：当前注册冲突检查保护 `exec`、`read`、`file_write`、`web_search`、`external_skill_execute`。外部技能包不得使用这些名称；同时也应避免使用其他原生工具名（如 `local_search`、`cron`、`generate_image`、`im_send`），以免混淆 LLM 的工具选择。

---

## 原生技能（Native Skill）

### 加载机制

原生技能在 **构建时** 通过 Vite 的 `import.meta.glob` 将所有 `SKILL.md` 文件以原始字符串形式内嵌到产物中：

```typescript
const skillModules = import.meta.glob('./**/SKILL.md', {
    eager: true,
    query: '?raw',
    import: 'default',
});
```

`SkillLoader` 单例在实例化时立即解析所有 SKILL.md，建立内存缓存（`Map<skillName, SkillDefinition>`），整个过程同步完成，调用方无需等待异步操作。

### SKILL.md 结构（原生技能）

```markdown
---
name: exec
description: 运行构建命令、执行脚本...
category: execution    # file_operation | search | execution | external | custom
complexity: 4          # 1-5，影响 Token 分配策略
requiresAuth: true     # 是否需要用户授权
---

# exec 工具

（主体内容：When To Use、When Not To Use、参数表、示例...）
```

### 注入时机

`SkillLoader.getAllSync()` 返回所有原生技能的 `fullContent`（frontmatter 之后的完整 Markdown）。`SubAgentPromptBuilder` 在构建 SA 的系统 Prompt 时，将每个技能的 `fullContent` 注入到对应工具的说明区块，让 Sub-Agent 在调用工具前获得完整的使用指南。

---

## 外部技能（External Skill）

### 文件系统布局

外部技能包最终都以目录形式存放在 AppData 目录下的 `packages/`。用户安装的包、GitHub 下载的包，以及安装包随附的内置外部技能包，都会归一到这条扫描路径；Release 安装包中的内置外部技能来源为 `src-tauri/skills-bundle/`，首次启动时由 Rust 端按需部署到 AppData。

```
{AppDataDir}/skills/external/
├── packages/
│   ├── html-slides/           ← 技能包目录（目录名仅作路径标识）
│   │   ├── SKILL.md           ← 必须，技能定义文件
│   │   ├── scripts/           ← 可选，可执行脚本
│   │   └── resources/         ← 可选，资源文件（主题、模板等）
│   ├── web-scraper/
│   │   ├── SKILL.md
│   │   └── main.py            ← Script 模式入口
│   └── _disabled-pkg/         ← 以 _ 开头的目录会被跳过（禁用约定）
```

### 扫描与注册

应用启动后，`App` 会提前预加载外部技能扫描；Task 模式的内部 `planning` 路径中，`SkillLoader.loadAllSkills()` 也会触发同一个 `bootstrapExternalSkills()` Promise，保证并发调用只执行一次。扫描注册完成后即解锁 Task 模式，额外依赖安装在后台异步进行：

```
App 预加载 / SkillLoader.loadAllSkills()
    └── ExternalSkillBootstrap.bootstrapExternalSkills()
        ├── ExternalSkillRegistryLoader.scanAll()      ← 扫描 packages/ 目录
        ├── 模式自动检测（有 execution.entry → Script，否则 → Guide）
        ├── Script 模式：ContractValidator 验证合约
        ├── Guide 模式：收集 scriptFiles + resourceFiles
        ├── skillLoader.registerExternal(skill)        ← 注入 SkillLoader
        ├── RuntimeStore.setInstalledSkills(...)       ← 更新技能管理列表
        ├── SkillRetriever.register(guideSkills)       ← 构建 Guide 向量索引
        └── launchBackgroundInstall()                  ← 后台安装待处理依赖
```

---

### 内置 skill-creator

AgentVis 随安装包内置 `skill-creator` 外部技能，用于让 Agent 创建、修改和优化 AgentVis Skill。它不是通用 Skill 模板的简单复制器，而是按 AgentVis 的双模式机制做架构选择：

- **Guide Skill**：与市面上通用 Skill 形态基本一致，核心是 `SKILL.md` 正文说明。适合开放式流程、创作、分析、资源使用说明、多个脚本/命令由 Agent 自主判断的场景。
- **Script Skill**：AgentVis 特有的执行型形态，核心是 frontmatter 中的 `execution` 合约。适合稳定输入输出、参数化脚本、HTTP API 查询、brokerOnly 网络/凭据审计等场景，运行时通过 `external_skill_execute` 调用。

`skill-creator` 会优先保持已有技能形态：已有 Guide 不会仅因为涉及网络或沙箱适配就被改成 Script；只有当任务天然适合稳定参数和固定入口时，才会引导创建 Script Skill。面向普通用户的选择建议见 [AgentVis 技能使用指南](../使用指南/AgentVis%20技能使用指南.md)。

---

### Guide 模式

Guide 模式的 SKILL.md 是一份给 LLM 阅读的**能力说明书**，告诉 Agent **能做什么**、**如何做**，但不限定执行路径。Agent 可以自由使用 `exec` 调用技能包内的脚本，也可以直接编写代码实现。

**典型结构：**

```markdown
---
name: html-slides
description: 创建精美的 HTML 幻灯片演示文稿，支持动画、主题定制和丰富排版
triggers: [pptx, PPT, 幻灯片, slides, presentation, 演示文稿]
dependencies:
  packages:
    - Pillow>=10.0
---

# HTML Slides 技能

## 工作流程
1. 根据用户要求规划幻灯片结构和主题
2. 生成完整 HTML 文件（内联 CSS + JS）
3. 通过 file_write 写出成品

## 设计原则
- 使用渐变、玻璃拟态或扁平等现代视觉风格
- 每张幻灯片保持内容聚焦...
```

**Guide 技能的注入机制：**

Master Brain 每次收到用户请求时，会通过 `SkillRetriever.retrieve(userQuery)` 获取相关 Guide 技能目录信息。MB 看到的是技能名称、描述和使用提示，并在 `SPAWN_SUB_AGENT` 的任务描述中明确引用技能名。真正的 Guide `fullContent`、`scriptFiles`、`resourceFiles` 会在 Sub-Agent Prompt 构建阶段，按已命中的技能或任务中显式提到的技能名注入。

如果 Guide 技能包含脚本文件或正文中明显要求运行包内脚本，调度层会为 Sub-Agent 兜底补充 `exec`。Guide Skill 仍按说明书由 Agent 使用普通工具完成任务，不会自动进入 Script Skill 的 `external_skill_execute` 合约执行链路。

---

### Script 模式

Script 模式的 SKILL.md 包含 **Execution Contract**。框架通过 `external_skill_execute` 解析合约、验证参数、调用脚本，LLM 只需决定是否调用和传入正确参数。

**典型 frontmatter：**

```yaml
---
name: web-scraper
description: 抓取网页并提取主体文本内容，支持 Cookie 认证和复杂页面
execution:
  runtime: python        # python | bash | node
  entry: main.py         # 相对于技能包目录的入口脚本
  timeout: 60            # 秒，默认 60
  maxOutput: 65536       # 字节，默认 64KB
  permissions:
    network: true        # true | false；未声明时默认 audit
    networkMode: brokerOnly # 可选；brokerOnly 表示必须通过主进程 broker 出口
    desktopControl: false # true 表示需要热键、鼠标、截图、窗口激活等桌面控制能力
  credentials:
    - id: github
      provider: github
      mode: brokerAuth
      hosts: [api.github.com]
      headerName: Authorization
      headerValuePrefix: "Bearer "
      required: false
  argsSchema:
    - name: url
      type: string
      required: true
      description: 目标网页 URL
    - name: cookies
      type: string
      required: false
      description: Cookie 字符串（如需认证）
dependencies:
  packages:
    - trafilatura>=1.6
    - curl_cffi>=0.7
---
```

**执行链路：**

```
MB 识别任务适合某个 Script Skill
    └── 派发 Sub-Agent，并允许 external_skill_execute
        └── SA 调用 external_skill_execute({ skillName, args })
            ├── 按精确 skillName 查找已安装 Script Skill
            ├── ContractValidator.validateArgs()       ← 参数类型/必填校验
            ├── ExternalExecutor.buildCommand()
            │   → "venv/Scripts/python.exe" "main.py" --url "..." --cookies "..."
            └── shellExecute(command, workdir, timeout)
                └── 返回 {skillName, exitCode, stdout, stderr, durationMs, timedOut}
```

**命令行参数映射规则：**
- `string` / `number` 类型：`--name "value"`（自动转义）
- `boolean` 类型：`true` → `--name`，`false` → 不传
- 入口脚本通过 venv 中的解释器调用（Python 3.11+）

**网络权限策略：**

Script 模式外部技能默认以 `externalSkill` sandbox profile 执行。若 `execution.permissions.network` 未声明，网络策略为 `audit`：执行前扫描命令和入口脚本中的联网迹象，命中后写入结构化审计事件，但不直接阻断，以降低对既有技能生态的回归风险。

| `execution.permissions.network` | shell 策略 | 适用场景 |
|----------------------------------|------------|----------|
| `true` | `inherit` | 明确需要访问 GitHub、ArXiv、RSS、邮件、第三方 API 的技能 |
| `false` | `blocked` | 明确不应联网的本地转换、文件处理、计算类技能 |
| 未声明 | `audit` | 兼容旧技能；先记录联网迹象，再由后续 UI 引导用户决策 |

`execution.permissions.networkMode` 是更细的出口模式声明，当前支持 `direct` / `brokerOnly`。未声明或 `direct` 保持上表行为；`brokerOnly` 表示 Skill 不应直连外网，框架会把 shell 直连网络策略收口为 `blocked`，并注入 `AGENTVIS_BROKER_MODE=explicit`、`AGENTVIS_BROKER_PIPE`、`AGENTVIS_BROKER_TOKEN`、`AGENTVIS_BROKER_FETCH`、`AGENTVIS_NETWORK_DIRECT_ACCESS=blocked`。脚本可通过 `agentvis-broker-fetch` 显式代发 HTTP(S) 请求；`network=false` 与 `brokerOnly` 语义冲突，会在 Contract 校验阶段拒绝。

`execution.credentials` 只在 `networkMode=brokerOnly` 下生效，用于声明由主进程 broker 代持的凭据引用。脚本和 LLM 参数只看到 `credentialRef`，真实 secret 由主进程按 `provider` 从 Windows Credential Manager 读取，并只在 HTTPS、精确 host 白名单命中、请求未自带同名鉴权 header 时注入声明的请求头。v1 仅支持 `mode=brokerAuth` 的 HTTP header 注入，不支持 query/body 注入、通配 host、非 HTTP(S) 协议，也不扩展到普通 `brokerProxyPreferred` 透明代理路径。`required=false` 且未配置凭据时会匿名继续，broker 响应返回 `credentialApplied=false`；`required=true` 时 fail closed。

本地文件类 Script Skill 可声明 `execution.permissions.filesystem`，从 `argsSchema` 中的 string 参数生成 per-run AppContainer 文件系统授权。该声明不改变网络策略；例如文件整理 Skill 可同时使用 `network=false` 和 `filesystem: [{ fromArg: path, access: readWrite }]`，在受控联网禁网路径下仍只获得用户传入目录的读写权限。

```yaml
permissions:
  network: false
  filesystem:
    - fromArg: path
      access: readWrite
argsSchema:
  - name: path
    type: string
    required: true
    description: 目标文件或目录
```

Script Skill 的稳定执行入口是 `external_skill_execute({ skillName, args })`。工具层按精确名称查找 Script Skill Contract，校验 `argsSchema` 后调用 `ExternalExecutor`，并返回 `skillName`、`exitCode`、`durationMs`、`stdout`、`stderr`、`timedOut`。MB 只看到轻量 catalog，SA 在命中 Skill 名称后注入 compact contract card；Guide Skill 仍按 guide 语义走普通 `exec`，不自动进入 Script Skill brokerOnly 链路。

当前阶段不做域名级 allowlist；静态扫描只能发现联网能力或联网命令，不能可靠证明真实目标域名。域名粒度权限应等 broker / proxy 或真实网络事件可观测后再产品化。

在三档沙箱中，用户可见的受控联网模式（内部 `ControlledNetwork`）当前默认使用本机文件空间，并给普通 `exec` / Guide Skill 注入 broker-proxy-preferred 会话：`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 指向 per-run 本机 HTTP(S) proxy，`NO_PROXY` / `no_proxy` 被清空，且可选注入 `agentvis-broker-fetch` helper 环境；direct network 仍处于 audit 过渡期。legacy AppContainer direct 后端可通过 `AGENTVIS_CONTROLLED_NETWORK_BACKEND=legacy` 回退，该路径会清空代理环境并设置 `NO_PROXY=*`，避免 Python / Node HTTP 客户端读到 `127.0.0.1` 系统代理后因 AppContainer loopback 限制而超时。原生 `web_search`、后端 `network_broker_http_request`、普通 HTTP(S) proxy 和 Script `agentvis-broker-fetch` 已接入主进程 broker；`brokerOnly` 不做透明 monkeypatch，脚本必须显式调用 helper。

受控联网的目标形态会保留 `ControlledNetwork` 字段和 UI 名称，把实现语义继续推进为“本机文件空间 + broker-only 网络出口”。这意味着普通 Guide Skill / `exec` 可以复用用户已有 CLI、token cache 和应用配置文件，但 HTTP(S) 出口应统一经过主进程 broker/proxy；在 WFP 或等价 network-only guard 能阻断直连前，普通命令不能宣称完整 brokerOnly。

Native Skill 的文件工具（`read` / `file_write` / `local_search`）已通过工具上下文中的 `sandboxFilesystemScope` 区分文件边界：离线隔离固定限制在 workspace / 授权根目录内；受控联网目标语义使用本机文件空间，避免为了访问本机凭据缓存而绕回 `exec`。

`brokerOnly` 仍会在 spawn 前扫描入口脚本。入口脚本不应直接 import `urllib.request`、`requests`、`socket` 等直连网络 API；如需验证“直连被阻断”，应像 `broker-e2e` 一样把直连探测放进独立子脚本，由主入口通过子进程触发，避免静态扫描在加载阶段阻断整条验证链路。

**桌面控制权限策略：**

Script Skill 若需要控制或观察交互式桌面，应声明 `execution.permissions.desktopControl=true`；若会启动外部 GUI / detached 应用，应声明 `execution.permissions.desktopLaunch=true`。这类能力只在本机审计模式下成立。本机审计模式会使用 detached lifecycle，避免 Job Object 在 shell 退出时关闭外部 GUI / 浏览器；离线隔离 / 受控联网模式会在后端 spawn 前阻断桌面控制、热键、屏幕截图、窗口激活和 detached GUI 启动，避免脚本返回 0 但实际桌面操作被 Windows UI 隔离或 Job Object 吞掉。

---

## 技能包格式 — SKILL.md 规范

### 通用 frontmatter 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 技能唯一名称（小写字母、数字、连字符，如 `web-scraper`） |
| `description` | string | ✅ | 一句话描述，用于 LLM 理解何时使用（也是向量检索的语义来源） |
| `triggers` | string[] | | 关键词触发列表，用于 L1 精确匹配（仅 Guide 模式有效） |
| `dependencies.packages` | string[] | | 额外 pip 包列表（如 `["scipy>=1.10", "networkx"]`） |
| `agentvisNetwork` | string | | Guide/普通 `exec` 的包级网络声明；当前支持 `brokerProxyPreferred` |
| `agentvisNetworkEntrypoints` | object | | Guide 包内不同脚本的网络声明，值支持 `brokerProxyPreferred` / `legacyNonHttp` |
| `license` | string | | 许可证声明 |

### Script 模式专有字段（`execution` 块）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `execution.runtime` | string | ✅ | - | `python` / `bash` / `node` |
| `execution.entry` | string | ✅ | - | 入口脚本路径（相对于技能包目录） |
| `execution.timeout` | number | | 60 | 最大执行秒数；普通上限 300 秒，`permissions.longRunning=true` 时上限 1800 秒 |
| `execution.maxOutput` | number | | 65536 | 最大输出字节数（stdout + stderr 分别限制） |
| `execution.permissions.network` | boolean | | 未声明 | `true` 继承网络；`false` 静态扫描命中即阻断；未声明时审计命中但不阻断 |
| `execution.permissions.networkMode` | string | | `direct` | `direct` 保持现有直连/audit 行为；`brokerOnly` 阻断 shell 直连并要求通过 `agentvis-broker-fetch` / broker IPC 发起 HTTP(S) 请求 |
| `execution.permissions.filesystem` | array | | - | 从 string 参数生成 AppContainer 文件系统授权；元素为 `{ fromArg, access }`，`access` 支持 `readOnly` / `readWrite` |
| `execution.credentials` | array | | - | brokerOnly 专用的凭据引用策略；脚本用 `credentialRef` 请求，主进程从 Credential Manager 读取并按 host 白名单代加 header |
| `execution.permissions.desktopControl` | boolean | | `false` | 是否需要热键、鼠标、截图、窗口激活等交互式桌面控制能力；离线隔离 / 受控联网下阻断 |
| `execution.permissions.desktopLaunch` | boolean | | `false` | 是否会启动外部 GUI / detached 应用；离线隔离 / 受控联网下阻断，本机审计模式使用 detached lifecycle |
| `execution.env` | string[] | | - | 兼容/预留字段；当前执行器不会按该字段注入任意普通环境变量，Script 不应依赖它传参 |
| `execution.argsSchema` | array | | `[]` | 参数定义列表；可省略，但建议 Script Skill 显式声明所有可传参数 |
| `execution.argsSchema[].name` | string | ✅ | - | 参数名称 |
| `execution.argsSchema[].type` | string | ✅ | - | `string` / `number` / `boolean` |
| `execution.argsSchema[].required` | boolean | ✅ | - | 是否必填 |
| `execution.argsSchema[].description` | string | ✅ | - | 参数说明（注入 LLM 工具 Schema） |

### 技能名称命名规则

- 仅允许：小写字母、数字、连字符（`-`）
- 禁止：空格、下划线、大写字母、特殊字符
- 禁用名称：`exec`、`read`、`file_write`、`web_search`、`external_skill_execute`（注册冲突检查保护）
- 不建议使用其他原生工具名：`local_search`、`cron`、`generate_image`、`im_send`
- 示例合法名称：`html-slides`、`web-scraper`、`pdf-converter`

### 多行 description 写法

支持 YAML 块标量格式：

```yaml
description: >
  强大的网页抓取工具，支持认证访问和复杂页面的
  主体内容提取，自动过滤广告和导航栏干扰。
```

---

## 安装流程

用户通过「设置 → 技能管理」安装技能包。当前实现支持本地目录导入和 GitHub 下载，包会先复制/下载到 `packages/{name}/`，然后由用户选择安全审查或直接安装：

```
1. 用户选择本地技能包目录，或输入 GitHub 仓库地址
              ↓
2. 复制/下载技能包到 packages/{name}/
              ↓
3. 读取 SKILL.md，解析 name / description / mode 等基础信息
              ↓
4. 展示确认弹窗
   - 开始安全审查：进入 SkillAuditService 流程
   - 直接安装：跳过审查，立即触发 rescanExternalSkills()
              ↓
5. SkillAuditService（可选）
   - 启动独立 Sub-Agent（只允许 read 工具）
   - 审查范围限定在包目录内的 root SKILL.md、references/reference、scripts/script、assets/asset 等渐进披露目录
   - 输出结构化 JSON 裁决：APPROVED / REJECTED / MANUAL_REVIEW_REQUIRED
              ↓
6. 用户根据审查结果决策（SkillAuditModal）
   - APPROVED：继续安装或取消
   - MANUAL_REVIEW_REQUIRED：用户可继续安装或移除包
   - REJECTED：强风险提示；用户仍可强制继续或移除包
              ↓
7. rescanExternalSkills() / bootstrapExternalSkills()
   - ExternalSkillRegistryLoader.scanAll()
   - ContractValidator 验证 Script Contract
   - skillLoader.registerExternal(skill)
   - RuntimeStore.setInstalledSkills(...)
   - SkillRetriever.register(Guide Skills)
              ↓
8. DependencyAnalyzer 记录待安装依赖
   - 解析 dependencies.packages
   - 静态分析 npm / system / cargo / go 等依赖信号
              ↓
9. launchBackgroundInstall() 后台安装额外依赖
   - RuntimeManager.ensureReady([], skillDeps)
   - 释放/校验预置 Python runtime
   - 增量安装技能包声明的额外 pip 包
   - 镜像源：阿里云 HTTP → 清华 HTTP → PyPI HTTPS
   - 安装结果通过 SkillSettings 的提示消息异步展示
              ↓
10. 技能扫描注册后即生效（无需重启）；缺依赖的技能可能在运行时失败，并提示用户刷新列表重试依赖安装
```

### 卸载/禁用

- **禁用**：将技能包目录重命名为 `_前缀`（如 `_web-scraper`），下次扫描时自动跳过
- **卸载**：删除 `packages/{name}/` 目录

---

## 触发机制

### 原生技能触发

原生技能始终在 Sub-Agent 允许的工具列表（`allowedTools`）中，由 Master Brain 在 `SPAWN_SUB_AGENT` 决策时指定。Agent 收到任务后根据 SKILL.md 内容自主判断何时调用。

### Guide 模式技能触发（两层检索）

每次用户发送消息时，系统通过 `SkillRetriever` 对用户意图进行检索，将相关 Guide 技能的目录信息提供给 Master Brain；当 MB 在任务里引用技能名，或调度阶段二次匹配到技能名时，Sub-Agent Prompt 才会注入该 Guide 的完整正文、脚本列表和资源列表：

#### L1：关键词精确匹配（确定性，零延迟）

```
用户消息："帮我做一个 PPT 演示文稿"
         ↓
SkillRetriever.keywordMatch(query)
         ↓
检查 html-slides 的 triggers：[pptx, PPT, 幻灯片, slides, presentation, 演示文稿]
         ↓
命中！score = 1.0（最高优先级）
```

技能名称（`name` 字段）自动包含在触发词中，无需在 `triggers` 中重复声明。

#### L2：Multi-Fragment 向量语义匹配（fallback）

当 L1 未命中时，通过向量相似度检索：

```
用户消息（多行）
    ↓
分割为 fragments（按换行符，过滤 <4 字符片段，最多 8 个）
    ↓
批量 embedding（复用全局 EmbeddingService 单例）
    ↓
每个 fragment 与所有技能的 embedding 计算余弦相似度
    ↓
每个技能取所有 fragment 中的最高分（解决长文本平均化问题）
    ↓
过滤 < 阈值（默认 0.85）的结果
```

两层结果按 max score 合并去重，按分数降序取 Top-3 注入 Master Brain。

> **索引文本**：向量化的是 `name: description`（意图摘要），而非 fullContent（实现细节），保证语义空间与用户查询对齐。

### Script 模式技能触发

Script 模式技能不会作为独立 Tool 暴露给 LLM。MB 会看到已安装 Script Skill 的轻量目录；当任务与某个 Script Skill 名称或描述匹配时，调度层会为 Sub-Agent 补充 `external_skill_execute` 工具，并在 SA Prompt 中注入 compact contract card。Sub-Agent 使用：

```json
{
  "skillName": "web-scraper",
  "args": {
    "url": "https://example.com"
  }
}
```

工具层按精确 `skillName` 查找 Script Contract，校验 `argsSchema`，再交给 `ExternalExecutor` 构造命令并执行。仓库中仍保留 `ExternalToolProvider` 类用于兼容/历史测试，但当前主链路以 `external_skill_execute` 为准。

---

## 安全审查机制

安全审查由 `SkillAuditService` 提供，但当前安装流程中它是用户可选择的步骤：导入本地目录或 GitHub 包后，用户可以先审查再决定，也可以跳过审查直接注册。审查结果用于风险提示和用户决策，不是唯一的注册门禁。

### 审查架构

- **执行者**：独立 Sub-Agent（复用 `SubAgentRunner`，不创建新基础设施）
- **工具沙箱**：仅允许 `read` 工具，且路径限定在技能包目录内（防路径遍历攻击）
- **审查范围**：root `SKILL.md` 以及 `references/`、`reference/`、`scripts/`、`script/`、`assets/`、`asset/` 等渐进披露目录；不默认读取包内所有文件
- **Checkpoint 策略**：Noop（审查 SA 无需 Master Brain 介入，全程自主）
- **输出格式**：结构化 JSON 裁决

### 审查 SA 工作流程

```
1. 按限定范围和优先级读取文件（SKILL.md > 脚本/代码 > 配置 > 文档/资源）
2. 分析 7 个安全维度：
   ① 远程代码执行（RCE）风险
   ② 数据外泄行为
   ③ 供应链污染
   ④ 权限提升
   ⑤ 持久化/backdoor 行为
   ⑥ 资源滥用（Crypto Mining 等）
   ⑦ 意图与代码功能不一致（Prompt Injection）
3. 输出 JSON 裁决
```

### 裁决结果

| 裁决 | 含义 | 用户操作 |
|------|------|----------|
| `APPROVED` | 通过，无风险项 | 直接安装 |
| `MANUAL_REVIEW_REQUIRED` | 存在可疑项，建议人工核查 | 用户可选择是否安装 |
| `REJECTED` | 存在高危风险，强烈建议拒绝 | 默认建议移除；用户可强制继续安装 |

裁决包含：风险评分（1-10）、置信度（LOW/MEDIUM/HIGH）、具体发现项列表（含文件、位置、风险类型、攻击场景描述）。

---

## Python Runtime 环境

### 共享 venv 架构

所有需要 Python 运行时的外部技能共享一个应用托管的 Python 环境，避免为每个技能重复创建 venv。Windows 打包场景优先释放随包发布的预置 `python-runtime-v1.zip`（包含 `.venv` 和基础依赖），开发环境或预置资源不可用时再回退到内嵌 Python / 系统 Python 路径：

```
{AppDataDir}/runtime/python-v1/
└── .venv/
    ├── Scripts/        ← Windows
    │   ├── python.exe
    │   └── pip.exe
    └── bin/            ← Unix
        ├── python
        └── pip
```

runtime 刷新采用进程内 single-flight、跨实例文件锁和 staging 目录发布，避免多个启动/UI/搜索入口并发删除或解压同一目录。只有在签名变化或健康检查失败、确实需要替换旧 runtime 时，Windows 后端才会枚举并终止“可执行文件路径位于当前 `{AppDataDir}/runtime/python-v1` 内”的残留进程；不会按 `python.exe` 进程名批量结束系统 Python、Conda 或其他应用进程。旧目录删除会进行有限重试，仍被安全软件或外部进程占用时停止替换并返回可操作错误，不在活动目录上继续覆盖解压。

### 环境状态机

前端 Store / 设置面板展示的是用户可见状态：

| 状态 | 说明 |
|------|------|
| `not_checked` | 尚未与磁盘上的 runtime 物理状态协调 |
| `not_created` | venv 不存在或不可用 |
| `creating` | 正在释放预置 runtime 或创建运行环境 |
| `installing_base` | 正在准备/校验基础运行时 |
| `installing_extra` | 正在安装技能包额外依赖 |
| `ready` | 环境就绪 |
| `error` | 严重错误或运行时不可用 |
| `skipped` | 当前环境跳过 runtime 准备 |

`RuntimeManager` 内部仍会返回更细的中间状态，用于决定降级和提示文案：

| 内部状态 | 说明 |
|----------|------|
| `base_incomplete` | 预置 runtime 缺失/损坏或基础包验收失败，需要重建或重新打包 |
| `extra_partial` | 额外依赖部分失败；已有环境可继续使用，失败结果通过技能管理提示异步展示 |

### Python 版本要求

- 最低版本：**Python 3.11**
- 当前 Windows 打包运行时预置版本：**Python 3.13.14**
- Windows 打包运行时优先释放预置 Python runtime（`{AppDataDir}/runtime/python-v1/.venv`），基础依赖以验收为主，而不是每次启动重新安装。
- 预置 runtime 不可用时，才尝试使用内嵌 Python（`{AppDataDir}/runtime/python-embed-*`）或系统 Python 创建共享 venv。
- 开发环境或内嵌资源不可用时，才回退 PATH 中的 `python` / `python3` / `py -3` / LocalAppData 常见安装路径。
- 离线隔离要求 venv 是 hermetic：`pyvenv.cfg` 的 `home`、`executable`、`base-executable` 等字段必须位于 `{AppDataDir}/runtime` 内。legacy 受控联网和 Script `brokerOnly` 的硬隔离执行链仍沿用这条约束；受控联网目标形态下的普通 Guide Skill / `exec` 可复用本机 CLI 与已有凭据缓存。

### 沙箱运行时目录

在离线隔离以及当前受控联网实现下，Script Skill 仍可访问应用托管目录：

- `{AppDataDir}/runtime`：内嵌 Python、共享 venv、sandbox profile。
- `{AppDataDir}/skills`：已安装外部 Skill 包和引用文件。
- 当前 workdir / project root：用户授予的工作区。

当前离线隔离和 legacy 受控联网会将常见用户目录环境变量重定向到 `{AppDataDir}/runtime/sandbox-profile/*`，包括 `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME`、`XDG_DATA_HOME`。默认受控联网路径使用本机文件空间，不再重定向真实 Home / AppData，以兼容已有 CLI 与 Skill 凭据缓存。

### 受控联网与代理

- 受控联网模式（内部 `ControlledNetwork`）默认保留本机文件空间，并给普通 `exec` / Guide Skill 注入 broker-proxy-preferred 会话环境；原生 `web_search`、后端 `network_broker_http_request` 和遵守代理环境的普通 HTTP(S) 流量已通过主进程 broker 出口。后续目标是由 OS 层阻断绕过代理的直连。
- Script Skill 可声明 `execution.permissions.networkMode=brokerOnly` 进入 fail-closed 路径：直连网络被阻断，进程收到 broker 环境变量，并可调用 `agentvis-broker-fetch` 通过 stdin/stdout JSON 代发 HTTP(S) 请求。请求 JSON 为 `{ method, url, headers?, bodyBase64?, timeoutMs?, credentialRef? }`，响应包含 `{ ok, status, headers, bodyBase64, truncated, durationMs, finalUrl, targetHost, targetScheme, bytesOut, credentialRef?, credentialApplied?, error? }`。
- 当请求带 `credentialRef` 时，该 ref 必须在 `execution.credentials` 中声明；broker 会校验 HTTPS、精确 host、同名 header 未由脚本自带，并在每一跳 redirect 后重新校验。日志、审计和 observation 只记录 ref 与是否应用，不记录 secret。
- `agentvis-broker-fetch` 由 `tauri build` 前置构建并随安装包 resources/bin 发布，运行时复制到 `{AppDataDir}/runtime/bin` 后注入 PATH；Skill 脚本也可以直接读取 `AGENTVIS_BROKER_FETCH` 调用绝对路径。若 helper 缺失，`brokerOnly` 会 fail-closed，不回退直连。
- `brokerOnly` 当前使用应用 runtime 目录下的 per-run 文件型 IPC；AppContainer 的 ReadWrite 授权必须允许 create/write/rename/delete，因为 helper 通过临时文件 rename 发布请求。
- Guide Skill 当前可获得 broker-proxy-preferred 会话入口，但仍不是完整透明请求级 broker，也不提供子进程真实域名级 hard allowlist；遵守 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 的 HTTP(S) 客户端会进入 broker/proxy，不遵守代理环境的直连仍只处于 audit 过渡期，后续需要 network-only guard。
- legacy AppContainer direct 后端不支持让沙箱进程访问本机 `127.0.0.1` 代理；Windows loopback exemption 需要管理员权限，不能作为默认能力。
- legacy AppContainer direct 后端会清空代理环境并设置 `NO_PROXY=*`，优先 direct network；默认受控联网路径不再因文件系统沙箱而强制清空真实 Home / AppData。
- 需要系统代理、企业代理或请求级审计的场景优先走 broker/proxy；域名 allowlist 与策略 UI 放在后续阶段。
- 默认受控联网路径下的 `Path.home()` 指向用户真实主目录，可复用真实 Home / 应用目录中的 CLI 与 Skill token cache；broker 审计不记录完整 URL query / credentials，agent-facing observation 会脱敏 broker token、proxy URL、Authorization/Cookie/Set-Cookie 和常见 token/api_key 字段。

#### broker helper 调用示例

Shell：

```bash
printf '{"method":"GET","url":"https://example.com","timeoutMs":15000}' | agentvis-broker-fetch
```

Python：

```python
import base64
import json
import os
import subprocess

helper = os.environ["AGENTVIS_BROKER_FETCH"]
request = {"method": "GET", "url": "https://example.com", "timeoutMs": 15000}
completed = subprocess.run(
    [helper],
    input=json.dumps(request),
    text=True,
    capture_output=True,
    check=True,
)
response = json.loads(completed.stdout)
body = base64.b64decode(response.get("bodyBase64") or b"").decode("utf-8", "replace")
```

Node.js：

```js
import { spawnSync } from 'node:child_process'

const helper = process.env.AGENTVIS_BROKER_FETCH
const request = { method: 'GET', url: 'https://example.com', timeoutMs: 15000 }
const result = spawnSync(helper, {
  input: JSON.stringify(request),
  encoding: 'utf8',
})
if (result.status !== 0) throw new Error(result.stderr || result.stdout)
const response = JSON.parse(result.stdout)
const body = Buffer.from(response.bodyBase64 || '', 'base64').toString('utf8')
```

迁移内置或第三方 Script Skill 时，不建议 monkeypatch `requests` / `fetch`，也不建议让脚本读取 `HTTP_PROXY` 指向本机代理。需要联网的入口应集中封装成 `broker_get` / `broker_post` 之类的显式函数，便于后续把域名策略、审计归因和错误提示统一接入。

#### brokerProxyPreferred 兼容声明

不是所有 Skill 都需要升级到 `brokerOnly`。对于只做 HTTP(S) 请求、且底层库会遵守代理环境的 Python / Node Skill，可以在 `SKILL.md` frontmatter 声明：

```yaml
agentvisNetwork: brokerProxyPreferred
```

如果一个 Guide 包内有多个脚本、且不同脚本需要不同网络语义，可以使用入口级声明：

```yaml
agentvisNetworkEntrypoints:
  scripts/http_client.py: brokerProxyPreferred
  scripts/email_helper.py: legacyNonHttp
```

`exec` 会按命令中引用的包内脚本路径匹配 `agentvisNetworkEntrypoints`；Script Skill 的 `external_skill_execute` 也会按 `execution.entry` 查询同一张表，用于补充网络 fallback 信息。

该声明的语义是：在 `ControlledNetwork` 下优先使用普通 per-run HTTP(S) broker proxy，显式 WFP per-run guard 遇到首 token 为 `python` 的命令时，可以降级到 broker-proxy-preferred，而不是因为共享解释器无法生成唯一 WFP AppID 就直接阻断。适用条件：

- Skill 的联网能力只走 HTTP(S)。
- 脚本会读取 `AGENTVIS_NETWORK_PROXY_URL`，或遵守 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。
- 包管理器和工具链可使用运行时补充的 `npm_config_proxy` / `npm_config_https_proxy`、`PIP_PROXY`、git `http.proxy` / `https.proxy`；浏览器自动化脚本可读取 `AGENTVIS_BROWSER_PROXY_SERVER` 并显式设置 Chromium / Playwright proxy。
- 若使用 `httpx`、`requests`、`curl_cffi`、Playwright/Chromium 等需要显式 proxy 参数的库，Skill 自己应把 broker proxy env 转成对应参数。
- 输出和错误消息不得回显完整 proxy URL、broker token、Authorization、Cookie、api_key 等敏感值。
- `ControlledNetwork` 会把明确绕过 proxy 的行为视为高风险并阻断，包括 `NO_PROXY` / `npm_config_noproxy`、`curl --noproxy`、Chromium direct proxy、raw socket / IMAP / SMTP / FTP / SSH 类库，以及未配置 proxy agent 的 Node native `fetch`。

不适用场景：

- IMAP/SMTP/SSH/数据库/raw socket 等非 HTTP(S) 协议。
- 需要 fail-closed 的强 brokerOnly 语义。
- 会主动设置 `NO_PROXY=*`、`curl --noproxy` 或其它绕过代理参数的工具。

如果需要强语义，仍应使用 `execution.permissions.networkMode=brokerOnly` 并显式调用 `agentvis-broker-fetch`；如果需要非 HTTP(S) 协议，后续应单独设计 SOCKS/TCP broker、per-protocol broker 或显式 direct-audit allowlist。

#### 最小验收 Skill

- `broker-e2e` 是临时内置 Script Skill，用于手工验证 `ControlledNetwork + brokerOnly`：检查 broker env 注入、直连 Python 网络失败、helper 访问公网成功、helper 访问 localhost 被拒。运行后应能看到 `{AppDataDir}/runtime/bin/agentvis-broker-fetch.exe` 被复制或刷新。实测已在受控联网模式下通过四项检查，确认 `external_skill_execute -> ExternalExecutor -> shell_execute -> broker session` 链路打通。
- `github-lookup` 作为第一批真实迁移样例：新增 Script Contract wrapper，并在 `AGENTVIS_BROKER_FETCH` 可用时通过 broker helper 请求 GitHub API；没有 broker env 时仍保留原本的直接 `httpx` CLI 行为。由于它可能已存在于用户本地 packages，同版本启动时通过 `.bundle_revision` 触发一次增量刷新，避免手工删除旧目录。实测 broker 通路可用；若在受控联网下未获得 GitHub token，会以匿名配额请求并可能返回 403 quota exhausted，这属于 secret 注入能力缺口，不是 broker 链路失败。

### pip 安装策略

- **批量安装**：每批 5 个包，减少进程启动开销
- **失败回退**：批量失败时降级为逐包安装，精确定位问题包
- **镜像源**：阿里云 HTTP（主）→ 清华 HTTP（备）→ PyPI HTTPS（兜底）
- **单包超时**：300 秒（支持编译型大包如 `curl_cffi`）

---

## 排错指南

### 外部技能未出现在技能管理或 Agent 上下文

1. 检查 `packages/` 目录下是否有以 `_` 开头的目录（被视为禁用）
2. 检查 SKILL.md 的 `name` 字段是否合法（不含大写、特殊字符）
3. 检查 `name` 是否与受保护的原生技能名称冲突
4. 查看 SkillLoader 日志（过滤 `[ExternalSkillRegistry]`）
5. 注意 Script Skill 不会作为独立 Tool 出现在工具列表中；应由 Sub-Agent 通过 `external_skill_execute` 调用

### Script 模式技能调用失败

1. 检查 Execution Contract 的 `runtime` 字段是否正确
2. 检查 `entry` 路径是否相对于技能包目录
3. 确认 Python venv 状态为 `ready`（设置面板 → 技能管理）
4. 脚本内部异常会在 `stderr` 中返回，查看 SA 的工具调用结果

### Guide 技能未被 Master Brain 识别

1. 确认 `description` 简洁且准确描述技能用途
2. 在 `triggers` 中添加用户自然语言中会使用的关键词（中英文均可）
3. 向量检索失败时会降级为空（不阻断主流程），可通过关键词触发作为保底

### 安全审查超时或解析失败

- 审查 SA 有最大 30 步限制；文件较多、脚本复杂或模型能力不足时可能超时
- 超时时裁决降级为 `MANUAL_REVIEW_REQUIRED`，风险评分为 5/10
- 可在设置中更换更强的模型以提升审查准确率

---

*本文档基于 `ExternalSkillRegistry.ts`、`SkillLoader.ts`、`SkillAuditService.ts`、`ExternalExecutor.ts`、`RuntimeManager.ts`、`SkillRetriever.ts`、`ExternalSkillBootstrap.ts`、`external_skill_execute/tool.ts` 等源文件综合整理。`ExternalToolProvider.ts` 仍保留在代码中，但当前主执行链路不以它作为 Script Skill 暴露入口。*
