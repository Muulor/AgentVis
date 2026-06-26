# AgentVis 沙箱机制功能文档

更新日期：2026-06-01

## 一、文档定位

本文是 AgentVis 沙箱机制的总文档，用来描述当前产品可承诺的功能边界、后端映射、执行链路、审计模型和重构注意事项。

维护原则：

- 本文作为沙箱机制的主同步文档；路线图、Spike、验收清单等文档保留历史计划和验证过程。
- 后续改动沙箱档位、网络出口、文件边界、审计字段、用户授权弹窗或 Skill 权限声明时，优先更新本文。
- 本文只描述已落地或明确处于实验开关后的能力；仍在迁移中的目标会标注为“目标形态”或“暂不承诺”。

相关文档：

- `docs/AgentVis docs/AgentVis Agent 行为安全防护机制.md`
- `docs/AgentVis docs/Skill 功能技术文档.md`
- `docs/AgentVis docs/AgentVis ControlledNetwork 回归矩阵.md`

## 二、核心目标与非目标

沙箱机制的目标不是把 AgentVis 变成通用虚拟机或透明网络网关，而是在 Agent 自动执行命令、运行 Skill、访问文件和联网时提供可解释、可审计、可恢复的安全边界。

核心目标：

- 用三档用户可理解的权限模型覆盖本机操作、离线隔离和受控联网。
- 在 TS 工具层、Rust 命令层、进程沙箱层、网络 broker/direct-audit 层、Trash Bin 层形成连续防护。
- 对危险命令、系统保护路径、脚本危险 API、网络绕过代理信号、桌面控制和 detached GUI 启动做前置拦截或审计。
- 对非 HTTP(S) 必要直连提供精确目标、用户确认、本次或本会话范围、后端精确匹配和审计记录。
- 让安全失败尽量可行动：告诉用户是路径边界、网络出口、桌面能力还是 runtime 差异导致失败。

当前非目标：

- 受控联网模式暂不承诺普通 `exec` / Guide Skill 已具备完整 broker-only 网络出口。
- 暂不默认启用透明代理、TUN、全量 TCP 劫持、通用 SOCKS/TCP broker 或 per-protocol broker。
- WFP 仍是高级 / 实验增强入口，不进入普通三档 UI 的默认承诺。
- 受控联网模式不是工作区文件隔离模式；它默认复用本机文件空间和已有 CLI / Skill 凭据缓存。
- direct-audit 不是网络内容代理，不解析或重写协议内容，只对精确目标直连进行授权和审计。

## 三、术语

| 术语 | 含义 |
| --- | --- |
| 本机审计模式 | `sandboxMode=LocalAudit`。默认模式，像助手一样操作本机，但仍受命令黑名单、保护路径、脚本扫描、Trash Bin 和审计约束。 |
| 离线隔离模式 | `sandboxMode=OfflineIsolated`。强文件边界和硬禁网模式，面向不可信脚本、第三方 Skill 和高风险任务。 |
| 受控联网模式 | `sandboxMode=ControlledNetwork`。默认本机文件空间，HTTP(S) 优先走 broker/proxy 审计，非 HTTP(S) 走 direct-audit 授权。 |
| technical profile | 后端内部 profile：`standard`、`externalSkill`、`installer`、`preview`、`restricted`。用于默认网络策略和审计归因，不直接暴露给用户。 |
| process lifecycle | 进程生命周期：`managed`、`backgroundManaged`、`detachedLaunch`。Job Object 只负责托管进程树清理，不等同于沙箱。 |
| broker-proxy-preferred | 当前受控联网普通 `exec` / Guide Skill 的 HTTP(S) 主路径：注入 per-run proxy 环境并审计，但在 OS 层直连阻断完成前不宣称完整 broker-only。 |
| brokerOnly | Script Skill Contract 的显式网络模式。直连 fail-closed，脚本必须通过 `agentvis-broker-fetch` 或主进程 broker 代发 HTTP(S) 请求。 |
| credentialRef | Script `brokerOnly` 的轻量凭据引用。脚本只请求引用名，主进程 broker 从 Credential Manager 读取真实 secret，并按声明的 host 白名单代加请求头。 |
| direct-audit | 非 HTTP(S) 协议的精确目标直连授权闭环，必须有 `protocol + host + port + subject`，且后端重试时精确匹配。 |

## 四、整体架构

```mermaid
flowchart TD
  A["Agent 设置: sandboxMode"] --> B["Planning / ToolExecutionContext"]
  B --> C["TS 工具层: read / file_write / exec / external_skill_execute"]
  C --> D["TS 前置防护: 路径边界、ExecSafetyPolicy、direct-audit UI"]
  D --> E["Tauri shell_execute / native IPC"]
  E --> F["Rust 命令校验: command_validator + script scan"]
  F --> G["ShellSandboxPolicy: mode / lifecycle / network scope / subject"]
  G --> H["进程约束: Job Object / AppContainer / profile env"]
  G --> I["网络约束: broker proxy / broker helper / direct-audit / WFP 实验"]
  G --> J["审计: SandboxAuditEvent"]
  E --> K["Trash Bin / 保护路径 / 软删除"]
```

执行链路按“越靠后越硬”的方式分层：

1. LLM / Agent 软约束：提示词、Checkpoint、LoopGovernor 和人工介入降低误操作概率。
2. TS 工具层：风险等级、`ExecSafetyPolicy`、native 文件工具路径边界、direct-audit 弹窗。
3. Rust 命令校验层：危险命令、保护路径、写入重定向、脚本内容扫描，作为最后一道命令防线。
4. 进程 / 网络沙箱层：根据 `ShellSandboxPolicy` 注入运行时约束、Job Object、AppContainer、broker/proxy、direct-audit 和 WFP 实验诊断。
5. Trash Bin 层：对可拦截删除命令做宿主侧软删除，并在隔离模式下复刻文件边界。
6. 审计层：用 `SandboxAuditEvent` 记录安全决策，供设置页、安全诊断和后续 UI 恢复入口使用。

## 五、三档用户权限

| UI 档位 | 后端模式 | 文件边界 | 网络边界 | GUI / 桌面能力 | 典型用途 |
| --- | --- | --- | --- | --- | --- |
| 本机审计模式 | `LocalAudit` | 不限制在 workdir；保留保护路径、自定义保护目录和 Trash Bin | 继承系统网络 | 允许 GUI / detached launch；桌面控制可运行 | 默认 Agent 工作、浏览器和本机自动化 |
| 离线隔离模式 | `OfflineIsolated` | AppContainer / workdir scope；应用托管 runtime / skills roots 额外授权 | deny-all；脚本网络命令和 API 硬阻断 | 禁止 detached launch、桌面控制、截图、热键、窗口激活 | 不可信脚本、第三方 Skill、高风险命令 |
| 受控联网模式 | `ControlledNetwork` | 当前默认本机文件空间；沿用保护路径和 Trash Bin | HTTP(S) broker-proxy-preferred + 审计；Script `brokerOnly` fail-closed；非 HTTP(S) direct-audit | 默认禁止通用 detached launch 和桌面控制；`agent-browser` 通过专用 CDP runtime 窄口可用 | 邮件、GitHub、云 API、已有 CLI / Skill token cache、受控浏览器自动化 |

关键承诺：

- 本机审计模式不是无保护模式，仍经过 TS/Rust 命令防护、保护路径、脚本扫描、Trash Bin 和审计。
- 离线隔离模式承诺工作区文件边界和硬禁网；如果 AppContainer 初始化或 sandbox profile 初始化失败，应 fail closed。
- 受控联网模式承诺网络出口收口，而不是工作区文件隔离；它当前不宣称所有直连都已被 OS 层捕获。浏览器自动化只承诺 AgentVis 专用 `agent-browser` CDP runtime 窄口，不承诺任意 GUI / Chrome attach。
- UI 文案和后端 enforcement 必须一致，不能在普通 UI 中把实验能力说成默认能力。

## 六、模式映射

`shell_execute` 的语义层参数：

```ts
sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
processLifecycle?: 'managed' | 'detachedLaunch' | 'backgroundManaged';
networkScope?: 'inherit' | 'blocked' | 'lan' | 'internetAudit';
subjectType?: 'command' | 'skill' | 'tool' | 'preview' | 'installer';
subjectId?: string;
networkDirectAllowances?: NetworkDirectAllowance[];
networkDirectTargets?: NetworkDirectTarget[];
```

默认映射：

| `sandboxMode` | `sandboxLevel` | `sandboxNetwork` | `networkScope` | 说明 |
| --- | --- | --- | --- | --- |
| `LocalAudit` | `standard` | `inherit` | `inherit` | 普通本机执行，保留安全校验和审计。 |
| `OfflineIsolated` | `restricted` | `blocked` | `blocked` | 强隔离，AppContainer 文件系统 + deny-all 网络。 |
| `ControlledNetwork` | `restricted` | `audit` | `internetAudit` | 当前默认本机文件空间 + broker-proxy-preferred + direct-audit。 |

兼容规则：

- 旧 `sandboxLevel` / `sandboxNetwork` 仍可被 Rust 解析，但新调用应优先传 `sandboxMode`。
- `sandboxMode=OfflineIsolated` 会强制 `restricted + blocked`，不允许调用方用 `networkScope` 放宽。
- `sandboxMode=ControlledNetwork` 在未设置 `AGENTVIS_CONTROLLED_NETWORK_BACKEND=legacy` 时默认走本机文件空间的 broker-preferred 路径。
- `network=blocked` 或 Script Skill `brokerOnly` 仍会进入 AppContainer deny-all / 主进程 broker helper 的 fail-closed 路径。

## 七、进程生命周期

| 生命周期 | 使用场景 | Job Object 行为 | 沙箱限制 |
| --- | --- | --- | --- |
| `managed` | CLI、测试、构建、短脚本 | 使用 Job Object，超时、取消、退出时清理进程树 | 所有模式可用 |
| `backgroundManaged` | Vite / dev server / 长跑后台服务 | 后台 registry + Job Object，可通过 `shell_kill` 终止 | 受模式网络和文件边界约束 |
| `detachedLaunch` | `start`、`Start-Process`、Chrome、VS Code、explorer、浏览器 / 桌面 Skill | 不使用 `KILL_ON_JOB_CLOSE`，避免外部 GUI 被误杀 | 离线隔离和当前受控联网默认 fail closed |

桌面能力单独处理：

- `desktopLaunch=true` 表示可能启动外部 GUI / detached 应用。
- `desktopControl=true` 表示需要热键、鼠标、截图、窗口激活、SendInput、pyautogui、pywinauto 等交互式桌面能力。
- 离线隔离模式必须在 spawn 前阻断桌面控制，避免命令退出码为 0 但实际操作被系统隔离或生命周期吞掉。
- 受控联网默认仍阻断通用桌面能力；`agent-browser` 不是通用桌面放行，而是通过专用 Chrome CDP runtime、broker proxy 和命令分类窄口提供浏览器自动化能力。

## 八、文件系统边界

### 8.1 本机审计模式

本机审计模式不限制 Agent 只能访问 workdir。它依赖以下防线：

- Rust `command_validator` 对核心系统目录和自定义保护目录做阻断。
- `file_write` 调用 `validate_path_write_safety()` 保护自定义目录。
- `exec` 中的删除类命令优先进入 Trash Bin 软删除。
- 危险脚本内容在执行前扫描。

### 8.2 离线隔离模式

离线隔离模式的文件边界是 workdir + 应用托管根目录：

- Native 文件工具通过 `getSandboxPathViolation()` 限制在 `sandboxRoots` 或 `workdir` 内。
- Rust 侧 AppContainer 文件系统授权工作目录、`{AppDataDir}/runtime`、`{AppDataDir}/skills` 等 app-managed roots。
- `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`XDG_*` 重定向到 `{AppDataDir}/runtime/sandbox-profile/*`。
- Python runtime 必须 hermetic，不能依赖用户主机 Python。若 `.venv/pyvenv.cfg` 指向 app-managed runtime 外部，应视为 sandbox-incompatible 并重建。
- Trash Bin 是宿主侧软删除代理，隔离模式下必须先校验删除目标位于 workdir 或 app-managed roots，避免绕过 AppContainer。

### 8.3 受控联网模式

受控联网目标形态默认使用本机文件空间：

- 普通 `exec` / Guide Skill 不再默认进入 AppContainer 文件系统边界。
- Native 文件工具通过 `sandboxFilesystemScope=local` 与该语义对齐；若该 scope 未设置为 `local`，`ControlledNetwork` 仍会按 workspace-bounded 逻辑阻断。
- Script Skill 若显式声明 `network=false` 或进入 `brokerOnly` 这类 `restricted + blocked` 路径，仍可能使用 AppContainer deny-all 后端。此时可通过 `execution.permissions.filesystem` 从 string 参数生成 per-run 文件系统 grant，只暴露本次调用需要的文件或目录。
- 允许复用真实 Home、CLI 配置、Skill token cache、浏览器或云服务凭据文件。
- 风险收口转移到 broker 出口策略、日志脱敏、observation 脱敏、上传限制和 direct-audit 授权上。

## 九、网络机制

### 9.1 网络策略

| 策略 | 行为 |
| --- | --- |
| `inherit` | 不改变子进程网络环境。 |
| `audit` | 扫描网络命令 / 网络 API，写审计；在受控联网 broker-preferred 路径中阻断绕过代理信号。 |
| `blocked` | 扫描命中时阻断，并注入禁网环境变量。 |

离线隔离使用 `blocked`，受控联网默认使用 `audit + internetAudit`。

### 9.2 Broker / Proxy

受控联网当前提供两条 broker 路径：

- 普通 `exec` / Guide Skill：启动 per-run 本地 HTTP(S) proxy，注入 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、小写变量、npm / pip / git proxy 配置和浏览器 runtime 可读取的 server-only proxy 环境。
- Script Skill `brokerOnly`：启动文件型 broker session，注入 `AGENTVIS_BROKER_MODE=explicit`、`AGENTVIS_BROKER_PIPE`、`AGENTVIS_BROKER_TOKEN`、`AGENTVIS_BROKER_FETCH`，脚本通过 `agentvis-broker-fetch` 请求主进程代发。
- Script Skill `brokerOnly + execution.credentials`：Contract 可声明 broker-managed credential policy。脚本请求 JSON 只携带 `credentialRef`；真实 secret 不进入 LLM args、环境变量、命令行、脚本 stdout/stderr 或 observation。主进程在发起 HTTP(S) 请求前按 `provider` 从 Windows Credential Manager 读取凭据，并只在 HTTPS、精确 host 白名单命中、请求未自带同名鉴权 header 时注入声明的 header。

`ControlledNetwork + internetAudit + broker-preferred` 的失败语义：

- 检测到 HTTP(S) / Git / npm 等 proxyable network intent 时，broker proxy session 启动失败必须 fail closed，写 `broker_proxy_required_unavailable`，不回退直连。
- broker file/helper session 启动失败但 proxy 可用时允许继续，只写 `broker_helper_unavailable` 诊断。
- proxy session 启动成功写 `broker_proxy_session_started`。
- 命令成功退出但本次 broker file/proxy session 没收到任何 broker 请求时，写 `broker_proxy_expected_but_unused` 诊断，用于排查缓存命中、误判或疑似静默直连。
- `broker_proxy_expected_but_unused` 仍然不阻断任务；审计 detail 固定包含 `reasonCode=broker_proxy_expected_but_unused` 和可聚合的 `reasonClass`，当前取值为 `cache_hit_likely`、`tool_misclassification`、`potential_direct_egress`，便于回归看板区分缓存命中、检测误判和疑似直连。

Broker 安全策略：

- per-run token 鉴权。
- 拒绝 URL credentials。
- 拒绝 localhost、private、link-local、metadata、CGNAT、multicast、unspecified 等目标。
- 在 DNS 前识别 `sslip.io` / `nip.io` / `xip.io` 中编码的 private/local/metadata IPv4；命中时以 `broker_network_block` / `hardBlock` 阻断，并在 `matchedPattern/detail` 中记录 `resolvedRisk`、`resolvedRiskReason`、`resolvedIpSamples`，避免企业 DNS/代理改写到 `198.18.x.x` 后掩盖风险。
- HTTP 请求和 HTTPS CONNECT 都基于已校验地址连接，减少 DNS 校验到连接之间的 TOCTOU。
- 每跳重定向重新解析、校验和 pinning。
- 带 `credentialRef` 的 broker 请求在每一跳重定向时都必须仍是 HTTPS 且 host 命中同一白名单，否则 fail closed，避免 `Authorization` 泄漏到第三方域名。
- 对请求体、响应体、重定向次数、超时设上限。
- 对 `Authorization`、`Proxy-Authorization`、`Cookie`、proxy credential URL、token query 和常见 secret key 做日志 / observation 脱敏。credential broker 响应只允许返回 `credentialRef` 与 `credentialApplied` 布尔状态，不返回 secret。

浏览器类 Skill 注意：

- 普通 CLI / HTTP(S) 工具使用带 token 的标准 proxy URL；浏览器 runtime 使用 `AGENTVIS_BROWSER_PROXY_SERVER` 读取 server-only 地址，不允许把 credential URL 写入命令行、环境回显或 observation。
- `agent-browser` 是当前默认闭环路径：通过 `start-chrome-debug.bat` 启动 AgentVis 专用 Chrome CDP runtime，受控联网下只对该 launcher、`browser-command.bat` wrapper 和已绑定 `agentvis-cdp-*` session 的 CDP 命令开窄口。
- 浏览器 broker proxy session 使用本地一次性 endpoint，浏览器侧不要求用户填写 proxy 用户名 / 密码；若历史扩展或旧 runtime 弹出 proxy auth，应重启 runtime 并使用新版 launcher。
- launcher 会拒绝 direct / bypass / credential proxy Chrome 参数，记录 controlled runtime 状态，检测到非受控旧 runtime 或代理 hash 不匹配时要求 `ensure` 重新建立。
- `browser-command.bat` 会清理普通 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 对本地 CDP 控制面的影响，仅保留 loopback no-proxy；`screenshot` / `screenshot --annotate` 会恢复窗口截图后再最小化，`close` 会走 runtime graceful stop。
- 任意 attach 用户已有 Chrome 只属于本机审计模式能力，不作为受控联网默认承诺；泛化 Playwright / Chromium Skill 仍必须显式读取浏览器 proxy 环境、传入 launch proxy 参数，并拒绝 direct/bypass/credential URL。

### 9.3 绕过代理信号

在 `ControlledNetwork` 的 broker-preferred 路径中，以下信号会被识别为 `proxy_bypass_signal_detected`，默认以 `proxy_bypass_signal_blocked` fail closed：

- `curl --noproxy` / `--no-proxy`。
- 显式 `NO_PROXY` / `no_proxy` / `npm_config_noproxy`。
- 清空或显式关闭 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `npm_config_proxy` / `npm_config_https_proxy`，包括 `cmd /c "set KEY=&& ..."`、`git -c http.proxy=`、`curl -x ""`。
- Chromium direct proxy 参数。
- Python raw socket、IMAP、SMTP、FTP、SSH 类库。
- Python `subprocess` / Node `child_process` 再 spawn 的脚本内 raw socket。
- Node raw TCP / UDP、未配置 proxy agent 的 native fetch。
- PowerShell `.NET TcpClient` / `Socket` / `Test-NetConnection`。
- SSH / SCP / SFTP、Telnet、数据库客户端、raw socket 等非 HTTP(S) 直连命令。

扫描器会解析常见 shell wrapper，包括 `cmd /c` payload、`cd /d ... && node/python script` 后续脚本、多个脚本入口和脚本字符串字面量里的子脚本路径。Playwright / Chromium 脚本若传入 `--proxy-server=direct://` 或 `--proxy-bypass-list=*`，即使经 wrapper 启动也应在 spawn 前阻断。

如果该直连属于非 HTTP(S)，且能解析或预检出精确目标，则进入 direct-audit 授权；否则不弹粗放授权，直接阻断。

### 9.3.1 上传 / 敏感外传 / 远端破坏高置信确认

`ControlledNetwork` 默认不做泛化 DLP，也不检查文件内容；但会在 spawn 前识别三类非常明确的高风险联网语义，并触发一次性用户确认。确认后前端只在同一次重试中传入对应 confirmed flag，后端写确认审计，不持久化授权。

| 风险类 | 首次阻断 reason | 确认后 reason | 重试 flag | 说明 |
| --- | --- | --- | --- | --- |
| `fileUpload` | `network_upload_confirmation_required` | `network_upload_risk_confirmed` | `networkUploadConfirmed=true` | 明确文件上传，但不判断文件内容是否敏感。 |
| `sensitiveEgress` | `network_sensitive_egress_confirmation_required` | `network_sensitive_egress_confirmed` | `networkSensitiveEgressConfirmed=true` | 命令同时出现敏感文件 / 环境变量读取与网络 body 发送。 |
| `remoteDestructive` | `network_remote_destructive_confirmation_required` | `network_remote_destructive_confirmed` | `networkRemoteDestructiveConfirmed=true` | 远端删除、销毁、删库、清空云资源等高置信操作。 |

审计事件会额外写入结构化字段：`riskClass`、`riskKind`、`credentialContext`。`credentialContext=brokerCredentialRef` 表示本次执行携带 broker-managed credential policy；`credentialContext=ambient` 表示使用环境 / CLI / 本机缓存等普通上下文。

首批上传模式：`curl --data-binary @file`、`curl -F name=@file`、`curl -T/--upload-file`、PowerShell `Invoke-WebRequest/Invoke-RestMethod -InFile`、Python `requests/httpx ... files=...`（含 `files = ...` 多行写法）、Node `FormData + fs.createReadStream`。

首批敏感外传模式：`curl` body 中读取 `.env`、`.npmrc`、`.pypirc`、`.git-credentials`、`.netrc`、SSH key、云厂商凭据、kubeconfig、`credentials.json`、service account 等敏感文件；`env` / `printenv` / `set` / PowerShell `Get-ChildItem Env:` 管道到网络请求；Python `requests/httpx post|put|patch` 或 Node `fetch/axios/got/undici` 把敏感文件读取结果放入 body / data。

首批远端破坏模式：`curl -X DELETE`、PowerShell `-Method Delete`、Python / Node HTTP delete；`psql` / `mysql` / `redis-cli` / `mongosh` / `sqlcmd` 等数据库客户端中的 `DROP`、`TRUNCATE`、`DELETE FROM`、`FLUSHALL`、`dropDatabase()`；以及 `terraform destroy`、`kubectl delete`、`helm uninstall/delete`、`gh repo delete`、`az ... delete`、`gcloud ... delete`、`aws s3 rm --recursive`、`aws terminate-/delete-/remove-` 等云资源销毁命令。

普通 `git` / `npm` / `pip`、只读 HTTP(S) 查询、下载到本地、`kubectl get`、`helm list`、`terraform plan`、`aws s3 ls`、数据库 `SELECT` / `INFO` 等日常任务不应触发这三类确认。该边界已进入 Rust 回归测试，并会随真实 Agent 任务 corpus 继续扩展。

### 9.4 WFP 实验增强

WFP 不是默认三档能力，只能通过显式高级开关进入：

- `AGENTVIS_NETWORK_GUARD_BACKEND=wfpCanary`
- `AGENTVIS_NETWORK_GUARD_BACKEND=wfpAppIdBlock`
- `AGENTVIS_NETWORK_GUARD_BACKEND=wfpPerRunAppIdBlock`

当前定位：

- 用于验证 per-run egress guard、readiness、session 和 cleanup 审计。
- 普通 shell 链路会先运行 helper `inspect --json` 诊断，并写入 `wfpEnhanced` 审计事件。
- `wfpCanary` 只做诊断增强，记录 `wfp_canary_direct_egress_observed`、`wfp_canary_no_direct_egress`、`wfp_canary_unavailable`，不等于默认硬禁网。
- hard guard 只对高置信、白名单管理型可执行命令生效，具体命令集合以 Rust `wfp_managed_egress_command_name()` 为准。
- 不递归承诺覆盖被管理 exe 再 spawn 的所有子 exe，也不默认覆盖 detached GUI / 长生命周期外部进程。

## 十、非 HTTP(S) direct-audit 授权

### 10.1 触发条件

direct-audit 只处理非 HTTP(S) 必要直连，包括：

- IMAP / SMTP。
- SSH / SCP / SFTP。
- Telnet / raw TCP。
- 数据库客户端，如 `psql`、`mysql` / `mariadb`、`redis-cli`、`mongosh` / `mongo`、`sqlcmd`。
- PowerShell `Test-NetConnection` / `.NET TcpClient` / Socket。
- 自制或下载 Skill 的 `legacyNonHttp` 入口。

进入 direct-audit 必须能获得精确目标：

```json
{
  "targets": [
    { "protocol": "postgres", "host": "db.example.com", "port": 5432 }
  ]
}
```

目标来源：

- Rust `sandbox_network_direct_targets` 对常见命令做只读目标提取。
- email-helper legacy 入口通过 `--action network_targets` 返回 IMAP / SMTP 目标。
- Script Skill 或 Guide Skill 的 `legacyNonHttp` 入口通过只读 `--action network_targets` preflight 返回目标。

### 10.2 前端授权

`NetworkDirectAuthorizationDialog` 展示目标、授权对象、工作目录和截断后的命令。

风险分级：

- public 目标：可“允许本次”或“本会话允许”。
- localhost / private / link-local / CGNAT：显示高风险文案，即使用户选择本会话也会降级为本次授权。
- metadata 目标：不提供放行按钮，要求切换本机审计模式。
- 授权弹窗前会由 Rust 解析 hostname 并回填 `resolvedRisk`、`resolvedIpSamples`、`resolvedRiskReason`。例如 `db.example.com` 如果解析到 private/link-local/metadata，也按解析结果展示风险并执行 fail-closed / 本次授权降级。为避免企业 DNS/代理把 `sslip.io` / `nip.io` / `xip.io` 改写成代理映射地址，Rust 会优先识别这类 hostname 中编码的 IPv4 地址，例如 `127.0.0.1.sslip.io`、`169-254-169-254.sslip.io`，并标记 `hostnameEncodedPrivateOrLocalIp` / `hostnameEncodedMetadataIp`。`198.18.0.0/15` 等常见代理/压测映射地址保持 `public` 授权体验，但 `resolvedRiskReason` 会标记为 `dnsResolvedBenchmarkOrProxyIp` / `literalBenchmarkOrProxyIp`，供企业代理矩阵聚合。

授权有效期：

- `currentExecution`：当前实现带短期过期时间，默认 15 分钟。
- `session`：前端内存态会话授权，默认 12 小时，到期自动过滤。

### 10.3 后端重试与精确匹配

授权结构：

```ts
type NetworkDirectAllowance = {
  id: string;
  subjectType: 'command' | 'skill' | 'preview' | 'installer';
  subjectId?: string;
  protocol: string;
  host: string;
  port: number;
  scope: 'currentExecution' | 'session';
  expiresAt?: number;
  createdAt: number;
  reason: string;
};
```

前端重试时同时传：

- `networkDirectAllowances`
- `networkDirectTargets`

Rust 侧要求以下字段全部匹配才放行：

- `subjectType`
- `subjectId`
- `protocol`
- `host`
- `port`
- 未过期的 `scope`
- 目标不是 metadata
- 若 hostname 解析到 metadata，仍按 `network_direct_metadata_target_blocked` fail closed；若解析到 localhost/private/link-local/CGNAT，后端只接受 `currentExecution`，不接受 `session` scope。

匹配成功后写 `network_direct_audit_allowed`，`guardMode=directAuditAllowed`，然后继续普通 shell 执行。匹配失败继续以 `proxy_bypass_signal_blocked` 阻断。

## 十一、Skill 权限声明

### 11.1 Script Skill Contract

Script Skill 通过 `external_skill_execute({ skillName, args })` 进入统一执行链路。`SKILL.md` frontmatter 的 `execution.permissions` 支持：

```yaml
execution:
  permissions:
    network: true | false
    networkMode: direct | brokerOnly
    filesystem:
      - fromArg: path
        access: readOnly | readWrite
    desktopLaunch: true | false
    desktopControl: true | false
  credentials:
    - id: github
      provider: github
      mode: brokerAuth
      hosts: [api.github.com]
      headerName: Authorization
      headerValuePrefix: "Bearer "
      required: false
```

规则：

- `network=true`：允许继承系统网络。
- `network=false`：扫描命中网络命令或网络 API 时阻断。
- 未声明 network：默认 audit，尽量不破坏已安装 Skill 可用性。
- `networkMode=brokerOnly`：直连 fail-closed，必须通过主进程 broker helper；不能与 `network=false` 同时声明。
- `filesystem`：为受限 AppContainer 进程追加本次调用的本地文件系统授权。`fromArg` 必须引用 `argsSchema` 中的 string 参数；`readOnly` 适合检查类脚本，`readWrite` 适合整理、移动、创建、删除或修改文件的脚本。
- `execution.credentials` 仅允许与 `networkMode=brokerOnly` 一起使用。v1 只支持 `mode=brokerAuth`、HTTP header 注入、精确 host、HTTPS；不支持 wildcard host、query/body 注入、非 HTTP(S) 协议或透明 broker proxy 路径。
- `provider` 对应 Credential Manager 中的 provider key（例如 `github`）。未配置时 `required=false` 会匿名继续并返回 `credentialApplied=false`；`required=true` 会 fail closed。
- `desktopLaunch=true`：表示可能启动外部 GUI / detached 应用。
- `desktopControl=true`：表示需要热键、截图、鼠标键盘或窗口控制能力。

### 11.2 AgentVis 网络声明

顶层声明：

```yaml
agentvisNetwork: brokerProxyPreferred
```

适用场景：

- HTTP(S) 且 proxy-aware 的 Skill。
- 会遵守 `HTTP_PROXY` / `HTTPS_PROXY` / `AGENTVIS_NETWORK_PROXY_URL`。
- 可在显式 WFP per-run guard 下避免因首 token 是共享解释器而被误伤。

不适用：

- IMAP / SMTP / SSH / 数据库 / raw socket 等非 HTTP(S) 协议。
- 不能把整个非 HTTP(S) Skill 伪装成 HTTP(S) proxy-aware。

入口级声明：

```yaml
agentvisNetworkEntrypoints:
  scripts/gmail_api_helper.py: brokerProxyPreferred
  scripts/email_helper.py: legacyNonHttp
```

规则：

- 入口级声明优先级高于顶层声明。
- `brokerProxyPreferred` 表示该入口是 HTTP(S) API 路径，应走 broker/proxy 并审计。
- `legacyNonHttp` 不是放行标记，只表示该入口命中非 HTTP(S) 时进入 direct-audit 授权闭环。
- Guide 模式普通 `exec` 也会通过脚本路径匹配已加载 Skill 的 `packagePath` 和 `agentvisNetworkEntrypoints`，命中 `legacyNonHttp` 后自动做 `--action network_targets` preflight。

## 十二、审计模型

`SandboxAuditEvent` 是 UI 和诊断的唯一稳定数据源。事件通过 `agentvis://sandbox-audit-event` 实时推送，同时保留最近内存事件并持久化到 `sandbox_audit_events`，查询命令为 `sandbox_audit_events`。

核心字段：

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

审计要求：

- 不记录原始命令全文，只记录稳定 hash、profile、策略、命中原因和结果。
- broker 目标只保留 redacted target、hash、状态码、字节数、耗时和阻断原因。
- 网络 observation、错误消息和审计详情不得泄漏 proxy token、`Authorization`、`Proxy-Authorization`、`Cookie`、token query 或常见 secret key。
- direct-audit 必须记录 subject、目标协议、host、port、reason 和 `guardMode=directAuditAllowed`。
- WFP 事件必须标记为实验增强诊断，不能与默认 broker-only 承诺混淆。
- 以下 detail / `matchedPattern` 字段作为高信号聚合契约保持稳定：`broker_proxy_expected_but_unused.reasonClass`、`proxy_bypass_signal_blocked.matchedPattern`、`network_upload_*` / `network_sensitive_egress_*` / `network_remote_destructive_*` 风险信号、`resolvedRisk` / `resolvedIpSamples` / `resolvedRiskReason`、`wfpCanary.taskCategory`。
- 三类高置信网络风险事件应优先消费结构化字段 `riskClass`、`riskKind`、`credentialContext`；`matchedPattern` 仅作为旧事件兼容和人工排障细节。

## 十三、UI 与 i18n

当前 UI 入口：

- Agent 设置页展示三档：本机审计模式、离线隔离模式、受控联网模式。
- `NetworkDirectAuthorizationDialog` 负责非 HTTP(S) direct-audit 授权。
- `NetworkUploadAuthorizationDialog` 负责高置信上传、敏感外传和远端破坏一次性确认。
- 设置页 `SandboxAuditSettings` 展示持久化审计事件，并支持按 decision、backend、source、guardMode 等过滤。

文案要求：

- 新增或修改用户可见文案、Toast、错误提示、聊天气泡内容、工具 observation、系统 / 工具返回消息时，优先接入 i18n。
- 沙箱阻断消息应告诉用户恢复路径，例如改用 broker/proxy-aware 路径、使用 Gmail API、请求 direct-audit、切换本机审计模式等。
- 安全确认弹窗不得通过点击窗外或 Escape 关闭；打开时初始焦点应落在弹窗内容而不是按钮，避免空格 / 回车误触发取消或允许。用户必须显式点击按钮，或 Tab 到按钮后再用键盘确认。
- 内部日志和纯调试信息可不强制 i18n，但不得泄漏 secret。

## 十四、关键源码索引

前端：

- `src/components/agent/AgentSettingsModal.tsx`：三档模式设置入口。
- `src/hooks/usePlanningMode.ts`：从 Agent 配置向 AgentService 传递 `sandboxMode`。
- `src/services/planning/skills/exec/tool.ts`：普通 `exec` 的 TS 前置校验、模式映射、Guide Skill 入口级网络声明匹配、direct-audit / 上传确认重试。
- `src/services/planning/skills/external_skill_execute/tool.ts`：Script Skill 工具入口。
- `src/services/planning/skills/external/ExternalExecutor.ts`：Script Skill shell 执行、brokerOnly 环境、legacyNonHttp preflight、direct-audit / 上传确认重试。
- `src/services/planning/skills/shared/sandboxPath.ts`：native 文件工具的沙箱路径边界。
- `src/stores/networkDirectAuthorizationStore.ts`：direct-audit 授权状态、有效期和风险降级。
- `src/components/security/NetworkDirectAuthorizationDialog.tsx`：direct-audit UI。
- `src/stores/networkUploadAuthorizationStore.ts`、`src/components/security/NetworkUploadAuthorizationDialog.tsx`：高置信上传 / 敏感外传 / 远端破坏确认 UI。
- `src/components/settings/SandboxAuditSettings.tsx`：审计日志 UI。
- `src/types/sandboxAudit.ts`、`src/types/networkDirectAuthorization.ts`：前端结构化类型。

后端：
- `scripts/collect-enterprise-network-env.ps1` AgentVis 企业级网络兼容只读采集器, 收集当前网络、代理服务器、VPN、防火墙以及 EDR 相关的信号，并生成报告，无需修改系统设置。
- `src-tauri/Run-MatrixTest.ps1` AgentVis WFP 矩阵测试工具。
- `src-tauri/src/commands/shell.rs`：`shell_execute` 主链路、broker session env、WFP 实验入口、direct-audit 匹配、DNS 风险解析与上传 / 敏感外传 / 远端破坏确认参数。
- `src-tauri/src/commands/process_sandbox.rs`：沙箱 facade，继续 re-export 子模块类型和能力，保持外部调用路径稳定。
- `src-tauri/src/commands/process_sandbox/policy.rs`：`ShellSandboxPolicy` 主策略链路，负责档位 / 模式 / 生命周期 / 网络范围 / subject 解析、策略环境变量、审计事件和 direct-audit allowance 匹配。
- `src-tauri/src/commands/process_sandbox/platform.rs`：进程沙箱平台后端 facade，隔离 Windows 与非 Windows 实现并保持上层导出稳定。
- `src-tauri/src/commands/process_sandbox/platform/windows.rs`：Windows 平台后端，承载 Win32 handle、Job Object、AppContainer filesystem profile / probe、Restricted Token process 和管道输出读取。
- `src-tauri/src/commands/process_sandbox/platform/non_windows.rs`：非 Windows stub，仅保留跨平台编译所需的 guard 与 restricted-token probe 占位实现。
- `src-tauri/src/commands/process_sandbox/types.rs`：沙箱档位、网络范围、生命周期、direct-audit 授权 / 目标、AppContainer / Restricted Token 共享类型与 enum 辅助方法。
- `src-tauri/src/commands/process_sandbox/audit.rs`：`SandboxAuditEvent` 存储、查询、SQLite 持久化、命令 hash 与审计目标脱敏。
- `src-tauri/src/commands/process_sandbox/broker_audit.rs`：网络 broker / 主进程网络请求的结构化审计事件构造。
- `src-tauri/src/commands/process_sandbox/network.rs`：进程沙箱网络子模块 facade，稳定主策略文件和网络扫描实现之间的 re-export 边界。
- `src-tauri/src/commands/process_sandbox/network/scan.rs`：网络命令、脚本网络 API、PowerShell payload、proxy bypass、raw socket、高置信上传、敏感外传和远端破坏信号扫描。
- `src-tauri/src/commands/process_sandbox/network/direct_targets.rs`：非 HTTP(S) direct-audit 协议目标解析、Skill entrypoint 网络声明识别、授权目标回填、DNS 风险解析和 metadata 目标拒绝判断。
- `src-tauri/src/commands/process_sandbox/network/powershell.rs`：PowerShell `Test-NetConnection`、`.NET TcpClient` 和嵌套 payload 中的直连目标提取。
- `src-tauri/src/commands/process_sandbox/desktop.rs`：桌面交互能力检测、桌面脚本 API 扫描和 detached launch 命令推断。
- `src-tauri/src/commands/network_broker.rs`：主进程 HTTP(S) broker、proxy server、目标校验、DNS pinning、CONNECT 处理。
- `src-tauri/src/commands/command_validator.rs`：危险命令、保护路径、写入重定向和脚本内容扫描。
- `src-tauri/src/commands/trash_bin.rs`：删除命令软删除兜底。
- `src-tauri/src/bin/agentvis_broker_fetch.rs`：Script `brokerOnly` helper。
- `src-tauri/src/bin/agentvis_wfp_helper.rs`、`src-tauri/src/bin/agentvis_wfp_network_probe.rs`：WFP 实验 helper / probe。

## 十五、验收与回归

代码改动后的基础要求：

- 修改 TS / TSX 后，对改动文件运行 `eslint --fix --quiet`，并运行 `tsc --noEmit`。
- 修改 Rust 后运行 `cargo check`。
- 不运行全局 formatter，只处理改动文件。

沙箱相关建议回归：

- `cargo test process_sandbox`
- `cargo test --manifest-path src-tauri/Cargo.toml network_risk_checkpoint_matrix`
- `cargo test --manifest-path src-tauri/Cargo.toml detector_flags_high_confidence`
- `cargo test --manifest-path src-tauri/Cargo.toml broker_canary`
- `cargo test wfp_network_isolation`，仅在需要验证 WFP helper 时运行。
- `src/services/planning/skills/shared/__tests__/sandboxPath.test.ts`
- `src/services/planning/skills/exec/__tests__/sandboxRuntimeHint.test.ts`
- `src/services/planning/skills/exec/__tests__/guideNetworkEntrypoint.test.ts`
- `src/services/planning/skills/external/__tests__/ExternalExecutor.test.ts`
- `src/services/planning/skills/external/__tests__/ExternalToolProvider.test.ts`
- `src/services/planning/skills/external/__tests__/ContractValidator.test.ts`
- `src/utils/__tests__/networkDirectRisk.test.ts`

手动验收建议：

- 本机审计模式启动 Chrome / VS Code / explorer，不应被 Job Object 误杀。
- 离线隔离删除 workdir 外文件应被阻断，删除 workdir 内文件应进入 Trash Bin。
- 离线隔离运行 `curl`、Python `requests`、Node 网络脚本应 fail closed。
- 受控联网运行 Git HTTPS / curl 普通 HTTP(S) 应经 broker/proxy 正常访问并写审计。
- broker canary 应覆盖 public redirect success、redirect-to-private block、redirect 后 DNS rebinding block。
- 受控联网运行 `curl --noproxy "*" https://example.com` 应阻断。
- 受控联网运行 `curl -x ""`、`git -c http.proxy=`、`cmd /c "set npm_config_proxy=&& npm view ..."` 应以 `proxy_bypass_signal_blocked` 阻断。
- 受控联网运行 Python `subprocess` / Node `child_process` 再 spawn raw socket 脚本，应在父脚本执行前通过静态扫描阻断。
- 受控联网运行 Playwright / Chromium 脚本并显式传入 `--proxy-server=direct://` 或 `--proxy-bypass-list=*`，应在 browser spawn 前阻断。
- SSH / SCP / SFTP、数据库客户端、PowerShell `Test-NetConnection` 应能在解析出目标后弹 direct-audit。
- localhost / private 目标只允许本次，metadata 目标不允许在 `ControlledNetwork` 放行。
- hostname 解析到 private/link-local/metadata 时，应按 resolved IP 风险展示：private/link-local 只允许本次，metadata 无放行入口。建议优先使用 `127.0.0.1.sslip.io` 与 `169-254-169-254.sslip.io` 这类编码 IP hostname 做稳定手工回归；HTTP broker 路径应在 DNS 前识别编码 IP 并返回 `403 Forbidden`，审计 detail 应包含 `resolvedRisk`、`resolvedRiskReason`、`resolvedIpSamples`，即使企业 DNS 将真实解析改写到 `198.18.x.x` 也不能当作普通公网目标放行。
- broker 请求数为 0 的成功联网任务应只产生 `broker_proxy_expected_but_unused` 非阻断诊断，并在 detail 中带 `reasonClass`，用于看板聚合。稳定手工触发样例：`echo https://example.com` 应成功退出、无实际 broker 请求，并生成 `reasonClass=tool_misclassification`。
- 高置信上传、敏感外传、远端破坏命令首次触发一次性确认；确认后本次可执行并写结构化审计字段。`npm` / `pip` / `git`、只读 HTTP(S) 查询、下载到本地、`kubectl get`、`helm list`、`terraform plan`、`aws s3 ls` 和数据库只读查询不应触发这三类确认。
- 自动化场景回归至少覆盖 `network_risk_checkpoint_matrix_covers_daily_and_high_risk_cases`，通过 `id/group/expectation` 矩阵同时验证“正常日常不误拦”和“明确上传 / 外传 / 删库跑路可命中”。其中 Windows 常见 `curl.exe -X DELETE` 与数据库 `DROP DATABASE` 应保持远端破坏优先级，不被普通 `curl` intent 或 `proxy_bypass_signal_blocked` 抢先归类。
- 无 host / port 的 raw socket 不弹授权，直接阻断。
- Script `brokerOnly` 缺少 helper 或 broker session 时 fail closed，不回退直连。

ControlledNetwork 回归矩阵手工验证结论：

- A 组日常公网任务通过：`curl`、`npm view`、`pip index`、`git ls-remote` 均正常走 broker/proxy，无上传确认、无 direct-audit、无 hardBlock。
- B 组代理绕过通过：`curl --noproxy "*"`, `curl -x ""`, `git -c http.proxy=`, `cmd /c "set npm_config_proxy=&& set npm_config_https_proxy=&& npm view ..."` 均以 `proxy_bypass_signal_blocked` / `hardBlock` 阻断，未通过 direct-audit 放行。
- C 组高置信上传确认通过，完整 canary 证据仍分层看待：两次手工补测中，`curl --data-binary @file`、`curl -F file=@...`、`curl -T`、PowerShell `Invoke-RestMethod -InFile` 均触发 `network_upload_confirmation_required`，用户选择“允许本次”后写入 `network_upload_risk_confirmed` 并继续执行；`webhook.site` 端点可返回 200，临时 Vercel endpoint 返回 404 时归类为端点路由问题，不视为沙箱失败。一次 `Invoke-RestMethod` 补测出现非阻断 `broker_proxy_expected_but_unused` / `reasonClass=potential_direct_egress` 诊断，后续继续观察；Rust broker canary 已覆盖自托管 upload body 转发链路，稳定公网手工 upload canary 仍用于沉淀完整可重复报告。
- D/E/F 组 direct-audit 与 metadata 通过：public 非 HTTP 目标可本次授权，private/local 只允许本次，metadata 无放行入口且 fail closed。
- G 组 hostname 编码 IP 风险通过：企业 DNS/代理会将 `sslip.io` 解析改写为 `198.18.x.x`，因此 broker 在 DNS 前识别编码 IP hostname；复测 `127.0.0.1.sslip.io` 返回 `403 Forbidden`，记录 `resolvedRisk=private`、`resolvedRiskReason=hostnameEncodedPrivateOrLocalIp`、`resolvedIpSamples=127.0.0.1`；`169-254-169-254.sslip.io` 返回 `403 Forbidden`，记录 `resolvedRisk=metadata`、`resolvedRiskReason=hostnameEncodedMetadataIp`、`resolvedIpSamples=169.254.169.254`。
- H 组 broker unused 诊断闭环：日常 `npm` / `pip` / `curl` 均有 broker 请求，不误报 `broker_proxy_expected_but_unused`；`cmd /c echo https://example.com` 成功退出且 broker 请求数为 0，生成非阻断诊断 `broker_proxy_expected_but_unused`，detail 包含 `reasonClass=tool_misclassification`。
- I 组敏感外传确认通过：`curl` body 发送假 `.env`、PowerShell 脚本、Python `httpx`、Node `axios` 四条路径均首次触发 `network_sensitive_egress_confirmation_required`；取消路径确认不会继续执行，允许本次路径写入 `network_sensitive_egress_confirmed`；审计包含 `riskClass=sensitiveEgress`、`riskKind`、`credentialContext` 和 `networkIntent=sensitive_egress`。准备脚本步骤应分条写入，避免同一条 `Set-Content` 命令文本同时包含“敏感读取 + 网络发送”而提前触发弹窗。
- J 组远端破坏确认通过：`curl.exe -X DELETE` 命中 `curlDeleteMethod`；`kubectl delete`、`terraform destroy`、`gh repo delete`、`aws s3 rm --recursive` 分别命中对应远端破坏 riskKind；`psql ... DROP DATABASE ...` 命中 `databaseDestructiveQuery`，且不再被 `proxy_bypass_signal_blocked` 抢先归类。除 disposable HTTP DELETE canary 外，真实仓库、云账号、集群和数据库命令默认选择取消。

- WFP Canary 真实任务矩阵通过；其中 Node 分类正向项使用 `node -e "console.log('node_probe https://example.com')"`，裸 `node fetch(...)` 仍按 `nodeNativeFetchWithoutProxyAgent` 高置信绕过阻断。
- 静态扫描增量库负向任务通过，覆盖 `--proxy=direct://`、`$env:HTTP_PROXY=$null`、PowerShell `UseProxy=$false`、Python `proxies={'http': None}` / `ProxyHandler({})`、Node `axios { proxy: false }` 与 undici direct dispatcher。

## 十六、重构边界

后续沙箱组件重构时建议保持以下边界不变：

- 三档用户语义保持稳定：`LocalAudit`、`OfflineIsolated`、`ControlledNetwork`。
- `SandboxAuditEvent` 作为 UI 和诊断稳定契约，新增字段需兼容旧 UI 和历史事件。
- `process_sandbox` 拆分期间应通过 facade 继续 re-export `types` / `audit` / `broker_audit`，避免 `shell.rs`、`network_broker.rs`、`web_search.rs` 调用路径 churn。
- `ShellSandboxPolicy` 应继续作为 Rust 侧模式、生命周期、网络范围、subject 归因的单一解析点。
- `ControlledNetwork` 当前不应被重构回默认 AppContainer 文件隔离，否则会破坏已有 CLI / Skill token cache 体验。
- direct-audit 必须继续要求精确目标和后端精确匹配，不能退化为“允许某协议”或“允许某 Skill 任意直连”。
- WFP 或等价 network-only guard 晋级默认能力前，必须先经过 audit / would-block 观测、误拦回归、恢复路径和 i18n 文案验证。
- 新增网络协议 broker 时，应先定义目标校验、secret 脱敏、审计字段、大小 / 超时限制和失败恢复语义。

## 十七、后续规划

`ControlledNetwork` 后续改进优先级应继续围绕“默认实用、诊断清晰、关键风险可确认”推进；截至 2026-06-01，AgentVis ControlledNetwork 回归矩阵.md 测试已全通过符合预期。 A-J 手工回归矩阵、broker canary、静态扫描增量库和高置信网络风险确认已形成可重复基线。后续工作主要从“补齐核心能力”转向“扩展真实任务 corpus、企业网络兼容、WFP 默认化评估和长期回归看板”。在 WFP 或等价 network-only guard 默认化前，不把默认受控联网描述成全协议硬隔离或 DLP。

已闭环能力说明：`agent-browser` 作为 AgentVis 默认浏览器自动化 Skill，已经完成受控联网代理契约闭环。后续规划中的“浏览器类 Skill 代理契约”主要保留为泛化到其它 Playwright / Chromium Skill、企业网络矩阵和长期回归基线的工作。

1. **P0.5：固化 A-J 手工回归基线**。每轮沙箱网络改动后至少覆盖日常公网、明确代理绕过、高置信上传 / 敏感外传 / 远端破坏确认、direct-audit public/private/metadata、hostname 编码 IP 风险、broker unused `reasonClass`。
   - 状态：已新增 `AgentVis ControlledNetwork 回归矩阵.md`，并补充可直接复制给 Agent 的 A-J 手工任务 prompt 与报告模板。2026-05-29 至 2026-06-01 手工回归中 A/B/C/D/E/F/G/H/I/J 均已覆盖并符合预期；稳定公网 upload / egress / delete canary 仍作为后续手工环境质量事项，不影响核心安全链路结论。
   - A：`curl` / `npm view` / `pip index` / `git ls-remote` 正常走 broker/proxy，无误拦。
   - B：`curl --noproxy "*"`, `curl -x ""`, `git -c http.proxy=`, `cmd /c "set npm_config_proxy=&& set npm_config_https_proxy=&& npm view ..."` 等明确绕过被 `proxy_bypass_signal_blocked` 阻断。
   - C：`curl --data-binary @file`、`curl -F file=@...`、`curl -T`、PowerShell `Invoke-RestMethod -InFile` 首次触发上传确认，确认后本次继续执行；远端 404 / 5xx 结合审计判断为 endpoint 路由或稳定性问题，不误判为沙箱失败。
   - D/E/F：direct-audit public 可授权，private/local 只允许本次，metadata 无放行入口。
   - G：HTTP broker 对 `127.0.0.1.sslip.io` / `169-254-169-254.sslip.io` 在 DNS 前识别编码 IP，返回 `403 Forbidden`，并记录 `resolvedRisk`、`resolvedRiskReason`、`resolvedIpSamples`。
   - H：日常任务不误报 `broker_proxy_expected_but_unused`；`cmd /c echo https://example.com` 稳定触发非阻断诊断，detail 带 `reasonClass=tool_misclassification`。
   - I：敏感文件 / 环境变量读取与网络 body 发送的组合会触发 `network_sensitive_egress_confirmation_required`；取消不继续执行，允许本次写 `network_sensitive_egress_confirmed`。
   - J：HTTP DELETE、删库、云资源销毁等高置信远端破坏命令触发 `network_remote_destructive_confirmation_required`；`curl.exe -X DELETE` 与 `psql DROP DATABASE` 已覆盖前次漏判 / 误归类缺口。
2. **P0.5：稳定自托管 canary**。保留并扩展 broker 自托管 canary，覆盖 public redirect success、redirect-to-private block、redirect 后 DNS rebinding block；第三方公开 redirect / upload 服务只能作为辅助，不作为唯一验收依据。
   - 状态：已补充 broker 自托管 canary 测试支架；测试专用 DNS override 将公网校验地址与本机 canary server 连接地址分离，仅在 `#[cfg(test)]` 生效。
   - 状态：已新增 upload canary 自动化覆盖，验证 broker 代发 POST body、目标校验和 `bytes_out` 语义，避免 `httpbin.org` / 临时 Cloudflare endpoint 这类远端不稳定影响沙箱结论。
   - 状态：`cargo test --manifest-path src-tauri/Cargo.toml broker_canary` 已作为 Broker Canary 定点自动化入口，覆盖 public redirect success、upload body + `bytes_out`、redirect-to-private / metadata block、redirect 后 DNS rebinding block、hostname 编码 private/metadata pre-DNS block、POST redirect 拒绝。
   - 后续只需补一个稳定公网手工 canary endpoint，供真实 Agent 手工报告覆盖 C 组完整链路；若手工报告出现 `broker_proxy_expected_but_unused.reasonClass=potential_direct_egress`，应单独记录为代理使用诊断，不影响上传确认结论但不作为 broker body 转发证明。
3. **P1：审计看板与 reason code 稳定性**。把高信号字段做成可聚合契约，优先覆盖 `broker_proxy_expected_but_unused.reasonClass`、`resolvedRisk` / `resolvedIpSamples` / `resolvedRiskReason`、`network_upload_*`、`network_sensitive_egress_*`、`network_remote_destructive_*`、`proxy_bypass_signal_blocked.matchedPattern`、`wfpCanary.taskCategory`。
   - 状态：审计 UI 已增加高信号摘要与事件级 signal 展示；Sub-Agent observation 已能带出 broker encoded-hostname 风险 detail；高置信网络风险确认事件已写入 `riskClass`、`riskKind`、`credentialContext`。目标是让产品和回归报告能区分缓存命中、检测误判、疑似直连、用户确认上传 / 敏感外传 / 远端破坏、DNS 风险、WFP 观测，而不是只看到“阻断/失败”。
4. **P1：direct-audit DNS 强化**。当前已展示 `resolvedRisk` / `resolvedIpSamples` / `resolvedRiskReason`，并支持 hostname 编码 IP；后续可在授权重试时 pin 本次 resolved IP，降低 DNS rebinding 风险。
   - 状态：hostname 编码 IP 识别已同时用于 direct-audit 风险展示和 HTTP broker 目标校验；private/local/metadata 编码目标在 broker 路径中 fail closed。
   - `198.18.0.0/15` 等代理/压测映射地址继续保持 public 授权体验和诊断标记；是否升级为 `reserved` / `unknown` 交给企业策略或管理员开关，不作为默认阻断。
5. **P1：高置信网络风险确认矩阵**。继续坚持“不是 DLP，不检查文件内容”，只扩高置信上传、敏感外传和远端破坏语义与测试矩阵。
   - 状态：`fileUpload`、`sensitiveEgress`、`remoteDestructive` 三类一次性确认已落地，分别写 `network_upload_risk_confirmed`、`network_sensitive_egress_confirmed`、`network_remote_destructive_confirmed`；前端重试只传本次 confirmed flag，不持久化授权。
   - 状态：Rust 回归矩阵 `network_risk_checkpoint_matrix_covers_daily_and_high_risk_cases` 已覆盖日常负向、上传、敏感外传和远端破坏场景；2026-06-01 I/J 手工重测已验证取消路径、允许本次路径和结构化审计字段。
   - 后续扩展只吸收真实 Agent 任务中高置信变体，例如 PowerShell `-Form`、Python `requests/httpx files = ...` 多变量/多行、Node `FormData + fs.createReadStream` 变量流、更多云 CLI 删除命令；普通 `npm` / `pip` / `git` / 只读 HTTP(S) 查询不应触发这三类确认。
6. **P1：浏览器类 Skill 代理契约**。`agent-browser` 默认路径已闭环；后续泛化到其它 Playwright / Chromium Skill 时，仍需标准化读取 `AGENTVIS_BROWSER_PROXY_SERVER` / `USERNAME` / `PASSWORD`（用户名和密码可能为空）并传入 launch proxy 参数，禁止 credential URL 和 direct/bypass 参数，继续保留真实页面、错误 proxy auth、private target、CONNECT 审计回归。
   - 已将 browser proxy credential URL 纳入高置信绕过信号，`--proxy-server=http://user:pass@...` 和 Playwright 脚本中的 `proxy.server` credential URL 会在受控联网路径中 fail closed；agent-facing observation 同步遮蔽通用 credential URL。
   - `agent-browser` 主路径按 CDP 专用 Chrome runtime 推进：受控联网只对 `start-chrome-debug.bat` / 已绑定 `agentvis-cdp-*` session 的 CDP 命令开窄口，launcher 强制使用 broker browser proxy、拒绝 direct/bypass/credential proxy Chrome 参数，并用 runtime state 防止静默复用本机审计模式启动的旧 Chrome。
   - 2026-05-30 手工回归已验证：受控联网下启动、导航、snapshot、截图 / 标注截图、fill / click / press、scroll、wait、get text / attr、截图清理、窗口最小化和 runtime close 均可稳定使用；`browser-command.bat close` 会转为 runtime graceful stop，避免 Chrome 恢复页。
   - 浏览器 runtime 使用本地一次性 proxy endpoint，用户不应看到或填写 proxy auth；`browser-command.bat` 清理普通 proxy env 对本地 CDP 控制面的干扰，并在截图后稳定恢复最小化。
7. **P1：WFP canary 真实任务矩阵**。继续观测 broker-preferred 命令是否存在 direct egress，重点覆盖 `curl` / `git` / `npm` / `pip` / Python / Node / Playwright / Chromium / background / cleanup。canary 只写诊断，不默认阻断。
   - 已在 canary 诊断 detail 中加入 `taskCategory`，用于区分 `curl`、`git`、`npm`、`pythonPackage`、`node`、`pythonBrokerProxyPreferred`、`background` 和 `proxyBypass:*` 等矩阵行；该字段只用于审计诊断，不改变阻断行为。
   - 状态：`taskCategory` 已贯穿 canary preflight、session stop 和 actual result；Playwright / Chromium / `npx playwright` / `node *playwright*` 归入 `browser`，WFP residual cleanup 归入 `cleanup` 诊断行，方便看板按真实任务矩阵聚合。
   - 验证：2026-05-30 人工回归通过；正向 Node 分类项使用非联网 `node_probe`，裸 `node fetch(...)` 仍按 `nodeNativeFetchWithoutProxyAgent` 高置信绕过阻断。
8. **P1：静态扫描增量库**。继续吸收真实 agent 任务里的 wrapper / shell / runtime 变体，但只阻断高置信绕过和高置信网络风险信号；低置信路径进入 canary / suspicious 审计，避免误拦普通本地脚本。
   - 状态：已补充高置信代理禁用变体，包括 `--proxy=direct://` / `$env:HTTP_PROXY=$null`、PowerShell `UseProxy=$false` / `Proxy=$null`、Python `proxies={'http': None}` / `ProxyHandler({})`、Node `axios { proxy: false }` 与 undici `setGlobalDispatcher(new Agent())`；已覆盖 PowerShell wrapper 中即时 `Set-Content` 写入并执行 Python/Node 脚本、以及 `$env:VAR\script.py` 路径解析；仍不把低置信脚本形态直接升级为阻断。
   - 状态：远端破坏检测已覆盖 Windows 常见 `curl.exe -X DELETE`，且在 ControlledNetwork shell 主链路中优先于 proxy bypass / direct-audit 分类；数据库 `DROP DATABASE` 等删库信号会先进入远端破坏确认。
   - 验证：2026-05-30 至 2026-06-01 负向回归通过，Python `proxies=None` 与 `ProxyHandler({})` 重试均在联网前 hardBlock，命中 `pythonProxyEnvDisabled`；J 组重测验证 `curlDeleteMethod` 与 `databaseDestructiveQuery` 均按预期命中。
9. **P2：企业网络兼容矩阵**。持续记录系统代理、PAC、VPN、EDR、Defender、Heysocks、Clash、公司网关下的 `curl` / `git` / `npm` / `pip` / 浏览器任务表现。
   - 重点观察 `198.18.0.0/15`、本地代理映射、DNS 改写、proxy auth、CONNECT 行为和 WFP/VPN/EDR 策略交叠。
   - 状态：已在 `AgentVis ControlledNetwork 回归矩阵.md` 中新增 P2 企业网络兼容矩阵；固定场景标签为 `baseline`、`system-proxy`、`pac-or-autodetect`、`vpn-on`、`local-proxy-tool`、`corp-gateway-edr`、`dns-198-18-mapping`。
   - 状态：已新增只读采集脚本 `scripts/collect-enterprise-network-env.ps1`，用于生成当前场景的 JSON / Markdown 环境快照；脚本不自动切换代理、VPN、防火墙或 EDR，默认输出到 `%TEMP%\agentvis-enterprise-network-matrix`。
   - 验证：2026-05-30 `NetworkedIsolateTest` 场景通过，覆盖 Heysocks TAP、本地 WinINET 代理、代理环境变量、Defender / Firewall 开启和 DNS `198.18.x.x` 映射；A/B/G/H 与 `broker_canary` 均符合预期。
10. **P2：按需扩展非 HTTP(S) 目标预检**。对更多数据库、消息队列、云 CLI 的只读 target discovery 做 direct-audit 接入；不引入透明 TUN/SOCKS/全协议 broker。
11. **P2：WFP hard guard 实验开关**。仅在 per-run identity 明确、broker proxy 端口已知、允许 loopback broker proxy 且能完成 cleanup 时启用；先作为高级/实验开关，不进入默认三档承诺。

WFP hard guard 的默认化标准：

- 日常 HTTP(S)、Git HTTPS、npm/pip、常见 API helper、Playwright public HTTPS 任务在 canary 下无 direct egress 或只有可解释的 broker loopback。
- `NO_PROXY`、清空 proxy、raw socket、metadata/private 目标、浏览器 direct proxy 参数均能被静态扫描或 WFP 观测捕获。
- 权限不足、VPN/EDR 冲突、残留 cleanup、detached/background 覆盖缺口都有清晰审计 reason 和恢复路径。
- UI / i18n 明确说明 canary 是诊断增强，hard guard 是实验/高级策略，不把默认受控联网误描述成全协议硬禁网。

## 十八、更新清单

每次迭代沙箱机制时，请同步检查本文以下位置：

- 三档权限矩阵是否仍准确。
- `shell_execute` 参数、默认映射和生命周期规则是否变化。
- 文件边界是否影响 native 工具、Trash Bin、AppContainer grants 或 sandbox profile。
- 网络 broker/proxy 环境变量、目标校验、绕过代理信号和 direct-audit 规则是否变化。
- Skill frontmatter / Contract 字段是否新增或改变语义。
- `SandboxAuditEvent` 字段、reason、backend、guardMode 是否新增。
- UI 是否新增用户可见文案，并已接入 i18n。
- 测试和手动验收清单是否覆盖新的风险面。
