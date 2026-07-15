# AgentVis 项目结构图

> 说明: 此文档描述项目的完整目录结构，每个组件后面附有中文说明。用户界面中的「Task 模式」对应内部模式值 `planning`；既有目录、组件、Hook 与事件名保持不变。

---

## 📁 根目录

```
AgentVis/
├── 📁 .agent/                    # Agent 项目规则
├── 📁 .github/workflows/         # GitHub Actions 质量门禁
├── 📁 .husky
├── 📁 public/                    # 静态资源目录
├── 📁 scripts/                   # 脚本工具目录
├── 📁 src/                       # 前端源代码（React + TypeScript）
├── 📁 src-tauri/                 # Tauri 后端源代码（Rust）
├── .editorconfig                 # 编辑器编码、缩进与换行基线
├── .eslintrc.cjs                 # ESLint 配置文件
├── .git-blame-ignore-revs        # Git blame 忽略的机械格式化提交
├── .gitattributes                # 跨平台换行与文本属性规则
├── .gitignore                    # Git 忽略规则
├── .prettierrc                   # Prettier 代码格式化配置
├── index.html                    # 应用入口 HTML
├── runtime-requirements-v1.txt   # 预置Python环境依赖
├── package.json                  # npm 项目配置与依赖
├── package-lock.json             # npm 依赖锁定文件
├── tsconfig.eslint.json
├── tsconfig.json                 # TypeScript 主配置
├── tsconfig.node.json            # Node 环境 TypeScript 配置
├── vite.config.ts                # Vite 构建工具配置
└── vitest.config.ts
```

---

## 📁 scripts/ - 脚本工具

```
scripts/
├── build-python-runtime-v1.ps1         # 构建外部 Skill 使用的预置 Python runtime
├── check-rust-panic-boundaries.ps1     # Rust 崩溃边界检查（UTF-8 截断、Mutex lock unwrap 等）
├── collect-enterprise-network-env.ps1  # 收集企业网络、代理、VPN 与系统环境诊断信息
├── prepare-broker-helper-resource.mjs  # 构建后准备 broker helper / WFP helper 资源清单
└── sync-tauri-dev-resources.mjs        # 开发模式同步 Tauri 内置资源（Skills / runtime 等）
```

---

## 📁 src/ - 前端源代码

```
src/
├── App.tsx                       # 应用根组件
├── main.tsx                      # 应用入口文件（挂载 Renderer 根级错误边界）
├── vite-env.d.ts                 # Vite 环境类型声明
│
├── 📁 components/                # UI 组件目录
│   ├── 📁 agent/                 # Agent（智能体）相关组件
│   ├── 📁 chat/                  # 聊天功能组件
│   ├── 📁 diff/                  # 代码差异对比组件
│   ├── 📁 errors/                # Renderer 错误隔离与恢复组件
│   ├── 📁 file/                  # 文件管理组件
│   ├── 📁 hub/                   # Hub（知识中心）组件
│   ├── 📁 layout/                # 布局组件
│   ├── 📁 memory/                # 记忆系统组件
│   ├── 📁 onboarding/            # 首次启动引导组件
│   ├── 📁 settings/              # 设置面板组件
│   ├── 📁 security/
│   ├── 📁 ui/                    # 通用 UI 基础组件
│   └── 📁 widgets/               # 生成式 UI 交互组件（Chat 模式 Widget）
│
├── 📁 config/                    # 应用配置（模型/供应商注册表）
├── 📁 hooks/                     # React 自定义 Hooks
├── 📁 services/                  # 业务逻辑服务层
├── 📁 shims/                     # Node.js 模块浏览器兼容 shim（飞书 SDK 依赖）
├── 📁 stores/                    # Zustand 状态管理
├── 📁 styles/                    # 全局样式文件
└── 📁 types/                     # TypeScript 类型定义
```

---

## 📁 src/components/ - UI 组件详情

### 📁 agent/ - 智能体相关组件

```
agent/
├── AgentChatView.tsx             # 智能体对话视图（主聊天界面）
├── AgentChatView.module.css      # 对话视图样式
├── AgentContextMenu.tsx          # 智能体右键菜单
├── AgentContextMenu.module.css   # 右键菜单样式
├── AgentCreateModal.tsx          # 创建智能体弹窗
├── AgentCreateModal.module.css   # 创建弹窗样式
├── AgentModelSelector.tsx        # 模型选择器组件
├── AgentModelSelector.module.css # 模型选择器样式
├── AgentNavItem.tsx              # 智能体导航项
├── AgentNavItem.module.css       # 导航项样式
├── AgentSettingsModal.tsx        # 智能体设置弹窗（基础/模型/知识库/定时任务 Tab）
├── AgentSettingsModal.module.css # 设置弹窗样式
├── AvatarCropper.tsx             # 圆形头像裁剪器（Canvas 拖拽+缩放+圆形遮罩+导出 WebP）
├── AvatarCropper.module.css      # 头像裁剪器样式
├── CronSettingsTab.tsx           # 定时任务设置 Tab（频率驱动调度 UI + 高级 Cron 模式）
├── CronSettingsTab.module.css    # 定时任务设置样式
├── CronJobItem.tsx               # 定时任务卡片组件（启用/禁用/编辑/删除）
├── CronJobItem.module.css        # 定时任务卡片样式
└── index.ts                      # 模块导出索引
```

### 📁 chat/ - 聊天功能组件

```
chat/
├── AttachmentButton.tsx          # 附件上传按钮
├── AttachmentButton.module.css   # 附件按钮样式
├── AttachmentCard.tsx            # 附件卡片组件
├── AttachmentCard.module.css     # 附件卡片样式
├── AttachmentPreview.tsx         # 附件预览组件
├── AttachmentPreview.module.css  # 附件预览样式
├── ChatHistory.tsx               # 聊天历史记录
├── ChatHistory.module.css        # 聊天历史样式
├── ChatInput.tsx                 # 聊天输入框
├── ChatInput.module.css          # 输入框样式
├── ChatSearchBar.tsx             # 聊天搜索栏（关键字搜索、结果高亮、键盘导航）
├── ChatReasoningTrace.tsx        # Chat 模式推理内容折叠块
├── ChatReasoningTrace.module.css
├── ChatSearchBar.module.css      # 搜索栏样式
├── ImageLightbox.tsx             # 图片灯箱（大图预览）
├── ImageLightbox.module.css      # 灯箱样式
├── InlineGeneratedImages.tsx     # 内联生成图片单图画廊、翻页及 Lightbox 导航
├── InlineGeneratedImages.module.css # 生成图片画廊预览与导航样式
├── inlineGeneratedImageVisibility.ts # 生成图片失败过滤与画廊选中项辅助逻辑
├── inputContextTokens.ts         # 输入上下文 token 结构
├── fileMentionUtils.ts           # 文件提及工具
├── skillSlashUtils.ts            # 技能 / 聊天命令 工具
├── MentionInput.tsx              # @ 提及输入组件
├── MentionInput.module.css       # 提及输入样式
├── MessageActions.tsx            # 消息操作按钮组（含多选入口）
├── MessageActions.module.css     # 操作按钮样式
├── MessageBubble.tsx             # 消息气泡组件（支持多选模式、多文件项目预览收集）
├── MessageBubble.module.css      # 消息气泡样式（含 multiFilePreviewBtn）
├── planningAutoScroll.ts         # Task 模式自动滚动信号
├── streamingAutoScroll.ts        # 流式消息自动滚动节流器
├── PlanningTraceDetails.tsx      # Task 模式持久化执行详情轻量收纳组件
├── PlanningTraceDetails.module.css # Task 模式执行详情收纳样式
├── ModeSelector.tsx              # Chat / Task 模式选择器（内部 chat / planning）
├── ModeSelector.module.css       # 模式选择器样式
├── MultiSelectBar.tsx            # 多选浮动操作栏（批量复制/引用/删除）
├── MultiSelectBar.module.css     # 多选操作栏样式
├── ProjectPathButton.tsx         # 项目路径关联按钮
├── ProjectPathButton.module.css  # 项目路径按钮样式
├── QuotePreview.tsx              # 引用消息预览
├── QuotePreview.module.css       # 引用预览样式
├── SelectCheckbox.tsx            # 多选圆圈指示器组件
├── SelectCheckbox.module.css     # 选择圆圈样式
├── StreamingMessage.tsx          # 流式消息组件
├── StreamingMessage.module.css   # 流式消息样式
├── SubAgentObservationDisplay.tsx      # Sub-Agent 观测静态展示（消息持久化后显示）
├── SubAgentObservationDisplay.module.css # 观测静态展示样式
├── useExpandableToolTarget.ts    # Sub-Agent 工具目标折叠 Hook
├── ThinkingChainDisplay.tsx      # 思维链展示组件
├── ThinkingChainDisplay.module.css # 思维链展示样式
├── index.ts                      # 模块导出索引
│
└── 📁 fsm-visualization/         # FSM 可视化组件
    ├── index.ts                  # 模块导出索引
    ├── FSMVisualizationPanel.tsx # FSM 可视化主面板
    ├── FSMVisualizationPanel.module.css # 主面板样式
    │
    ├── 📁 components/            # 子组件
    │   ├── CollapsibleSection.tsx    # 可折叠区块组件
    │   ├── CollapsibleSection.module.css
    │   ├── HitlInterventionBar.tsx   # Human-in-the-Loop 暂停介入条
    │   ├── HitlInterventionBar.module.css
    │   ├── ThinkingChainSection.tsx  # 思维链区块
    │   ├── ThinkingChainSection.module.css
    │   ├── ThinkingStream.tsx        # 思维流组件
    │   ├── ThinkingStream.module.css
    │   ├── DecisionCard.tsx          # 决策卡片
    │   ├── DecisionCard.module.css
    │   ├── ReasoningTraceSection.tsx   #Master Brain 推理内容流式区块
    │   ├── ReasoningTraceSection.module.css
    │   ├── SubAgentObservationSection.tsx  # Sub-Agent 实时观测面板
    │   └── SubAgentObservationSection.module.css
    │
    └── 📁 hooks/                 # Hook
        └── useFSMVisualization.ts    # FSM 可视化回调绑定 Hook
```

### 📁 diff/ - 代码差异对比组件

```
diff/
├── CollapsedLines.tsx            # 折叠行指示器
├── CollapsedLines.module.css     # 折叠行样式
├── DiffActions.tsx               # 差异操作按钮（接受/拒绝）
├── DiffActions.module.css        # 差异操作样式
├── DiffBlock.tsx                 # 差异代码分块与独立审批行组件
├── DiffBlock.module.css          # 差异块样式
├── DiffBlockTokenBudget.ts       # 差异块累计语法 token DOM 预算
├── DiffLine.tsx                  # 差异行组件
├── DiffLine.module.css           # 差异行样式
├── DiffLinePreview.ts            # 超长差异行预览与 UTF-16 安全截断
├── DiffSyntaxHighlight.ts        # Diff 语法高亮与大文件性能降级
├── DiffViewer.tsx                # 差异查看器（内嵌）
├── DiffViewer.module.css         # 差异查看器样式
├── FullFileDiffModel.ts          # 完整差异的分块、护栏与虚拟布局纯逻辑
├── FullFileDiffViewer.tsx        # 完整文件差异视图（小块虚拟化与稳定测量行）
├── FullFileDiffViewer.module.css # 完整差异样式
├── SnapshotHistory.tsx           # 快照历史记录
├── SnapshotHistory.module.css    # 快照历史样式
└── index.ts                      # 模块导出索引
```

### 📁 errors/ - Renderer 错误隔离与恢复组件

```
errors/
├── RendererErrorBoundary.tsx        # 根级/子树错误边界、动态模块识别与 Reload/Close 恢复界面
├── RendererErrorBoundary.module.css # Renderer 安全恢复页面样式
├── RendererErrorBoundary.test.tsx   # 动态模块错误识别与独立恢复 UI 回归
└── rendererRecovery.ts              # 动态 import/chunk 错误识别辅助逻辑
```

### 📁 file/ - 文件管理组件

```
file/
├── CodeHighlight.tsx             # 代码语法高亮组件（含 Vite 项目预览触发）
├── CodeHighlight.module.css      # 代码高亮样式（含 Layers 预览按钮）
├── FileContextMenu.tsx           # 文件右键菜单（用户删除进入 Windows 回收站）
├── FileContextMenu.module.css    # 右键菜单样式
├── FileItem.tsx                  # 文件列表项
├── FileItem.module.css           # 文件项样式
├── FileTypeIcon.tsx              # 按文件名/扩展名映射的语言类型图标
├── FileTypeIcon.module.css       # 文件类型图标与主题色样式
├── FileTypeIconRegistry.ts       # 精确文件名、扩展名与文件家族图标映射
├── FileList.tsx                  # 文件列表组件（含交付物文件夹 ▶ Run Preview、系统回收站删除）
├── FileList.module.css           # 文件列表样式（含 projectPreviewBtn）
├── FileListPathRecovery.ts
├── WorkspaceImportService.ts     # HTML5 拖拽分块传输与事务式工作区导入协调
├── FilePreviewImageDataUrl.ts
├── FilePreview.tsx               # 文件预览组件
├── FilePreview.module.css        # 文件预览样式
├── PreviewStore.ts               # 实时代码预览状态管理（已迁移至 stores/previewStore.ts）
├── LivePreviewPanel.tsx          # 实时代码预览面板（HTML/Project 双模式 + bridge 连通握手/运行时诊断）
├── LivePreviewPanel.module.css   # 实时代码预览面板样式
├── LargeTextPreview.tsx          # 大型文本/Markdown 有界分页安全预览组件
├── MarkdownRenderer.tsx          # Markdown 渲染器（Widget/Mermaid/ECharts 拦截 + 图表 lazy-load 局部隔离/重试）
├── MarkdownRenderer.module.css   # Markdown 样式
├── MermaidBlock.tsx              # Mermaid 图表渲染组件（防抖+流式静默错误+SVG 输出）
├── MermaidFlowchartSanitizer.ts
├── MermaidVisualTheme.ts         # Mermaid 视觉主题
├── MermaidBlock.module.css       # Mermaid 样式
├── EchartsVisualTheme.ts         # Echarts 视觉主题
├── EChartsBlock.tsx              # ECharts 数据图表渲染（按需引入+深色模式适配+ResizeObserver）
├── EChartsBlock.module.css       # ECharts 样式
├── TextPreviewPolicy.ts          # 文本预览大小/复杂度预算与 rich/safe/external 决策
└── index.ts                      # 模块导出索引
```

### 📁 hub/ - Hub 知识中心组件

```
hub/
├── HubChatView.tsx               # Hub 聊天视图
├── HubChatView.module.css        # Hub 聊天样式
├── HubContextMenu.tsx            # Hub 右键菜单
├── HubContextMenu.module.css     # Hub 菜单样式
├── HubCreateModal.tsx            # 创建 Hub 弹窗
├── HubCreateModal.module.css     # 创建弹窗样式
├── HubNavItem.tsx                # Hub 导航项
├── HubNavItem.module.css         # 导航项样式
├── HubTabs.tsx                   # Hub 标签页切换
├── HubTabs.module.css            # 标签页样式
└── index.ts                      # 模块导出索引
```

### 📁 layout/ - 布局组件

```
layout/
├── CenterPanel.tsx               # 中央面板容器
├── CenterPanel.module.css        # 中央面板样式
├── LeftPanel.tsx                 # 左侧导航面板
├── LeftPanel.module.css          # 左侧面板样式
├── RightPanel.tsx                # 右侧详情面板
├── RightPanel.module.css         # 右侧面板样式
├── Shell.tsx                     # 应用外壳（主布局）
├── Shell.module.css              # 外壳样式
├── StatusBar.tsx                 # 底部状态栏
├── StatusBar.module.css          # 状态栏样式
├── TopBar.tsx                    # 顶部标题栏
├── TopBar.module.css             # 标题栏样式
└── index.ts                      # 模块导出索引
```

### 📁 memory/ - 记忆系统组件

```
memory/
├── FactCard.tsx                  # 事实卡片组件
├── FactCard.module.css           # 事实卡片样式
├── FactEditModal.tsx             # 事实编辑弹窗
├── FactEditModal.module.css      # 编辑弹窗样式
├── FactsView.tsx                 # 事实记忆视图
├── FactsView.module.css          # 事实视图样式
├── manualFact.ts                 # 手动事实工具函数
├── MemoryPanel.tsx               # 记忆面板容器
├── MemoryPanel.module.css        # 记忆面板样式
├── ShortTermView.tsx             # 短期记忆视图
├── ShortTermView.module.css      # 短期记忆样式
├── SummaryView.tsx               # 摘要记忆视图
├── SummaryView.module.css        # 摘要视图样式
├── WatermarkIndicator.tsx        # 水位线指示器
├── WatermarkIndicator.module.css # 水位线样式
├── types.ts                      # 记忆组件类型定义
└── index.ts                      # 模块导出索引
```

### 📁 onboarding/ - 首次启动引导组件

```
onboarding/
├── onboardingEvents.ts          # 首次启动引导事件
├── SetupChecklist.tsx           # 首次启动引导检查列表
├── SetupChecklist.module.css    # 首次启动引导检查列表样式
├── RuntimeOnboardingBanner.tsx  # Python Runtime 安装引导横幅
└── RuntimeOnboardingBanner.module.css # 引导横幅样式
```

### 📁 security/

```
security/
├── NetworkDirectAuthorizationDialog.tsx  # 网络直连授权弹窗
├── NetworkUploadAuthorizationDialog.tsx
└── NetworkDirectAuthorizationDialog.module.css
```

### 📁 settings/ - 设置面板组件

```
settings/
├── ApiKeySettings.tsx            # API 密钥设置
├── ApiKeySettings.module.css     # API 设置样式
├── CloudServiceSettings.tsx      # 云服务设置
├── CloudServiceSettings.module.css # 云服务样式
├── DataSettings.tsx              # 数据管理设置
├── DataSettings.module.css       # 数据设置样式
├── GeneralSettings.tsx           # 通用设置
├── GeneralSettings.module.css    # 通用设置样式
├── ModelSettings.tsx             # 模型设置
├── ModelSettings.module.css      # 模型设置样式
├── SettingsModal.tsx             # 设置弹窗容器
├── SettingsModal.module.css      # 设置弹窗样式
├── SkillSettings.tsx             # 技能管理设置（外部技能包安装/状态查看）
├── SkillSettings.module.css      # 技能管理样式
├── SkillAuditModal.tsx           # 技能包安全审查弹窗
├── SkillAuditModal.module.css    # 审查弹窗样式
├── FileProtectionSettings.tsx       # 文件保护设置
├── FileProtectionSettings.module.css  # 文件保护设置样式
├── SandboxAuditSettings.tsx      # 沙箱审计事件诊断
├── SandboxAuditSettings.module.css   # 沙箱审计事件诊断样式
├── UpdateSettings.tsx            # 应用版本检测设置区
├── ImChannelSettings.tsx         # IM 通道设置页面（飞书/Slack 多 Bot 配置 + 连接管理）
├── ImChannelSettings.module.css  # IM 通道设置样式
├── imChannelHubSelection.ts      # IM 通道 Hub 选择辅助逻辑
└── index.ts                      # 模块导出索引
```

### 📁 ui/ - 通用 UI 基础组件

```
ui/
├── Button.tsx                    # 按钮组件
├── Button.module.css             # 按钮样式
├── ConfirmDialog.tsx             # 确认对话框
├── ConfirmDialog.module.css      # 确认对话框样式
├── FileRevertDialog.tsx          # 文件回滚对话框
├── FileRevertDialog.module.css   # 回滚对话框样式
├── Input.tsx                     # 输入框组件
├── Input.module.css              # 输入框样式
├── Modal.tsx                     # 模态框基础组件
├── Modal.module.css              # 模态框样式
├── ResizeHandle.tsx              # 可调整大小的手柄
├── ResizeHandle.module.css       # 手柄样式
├── Select.tsx                    # 下拉选择组件
├── Select.module.css             # 下拉选择组件样式
├── SelectionCheck.tsx            # 选择标记组件
├── SelectionCheck.module.css     # 选择标记组件样式
├── TextContextMenu.ts            # 文本复制/粘贴右键菜单
├── TextContextMenu.module.css
├── Toast.tsx                     # 提示消息组件
├── Toast.module.css              # 提示样式
├── Tooltip.tsx                   # 统一悬浮提示组件
├── Tooltip.module.css            # 悬浮提示样式
└── index.ts                      # 模块导出索引
```

### 📁 widgets/ - 生成式 UI 交互组件

```
widgets/
├── WidgetRenderer.tsx            # Widget 分发器（Registry 模式，类型→组件映射）
├── WidgetIcon.tsx                # Widget 通用图标（Lucide 图标名自动识别 + Emoji fallback）
├── widgetUndo.ts                 # Widget 重选撤回工具
├── ChoicesWidget.tsx             # 选项卡片组件（单选、持久化状态、重选撤回）
├── ChoicesWidget.module.css      # 选项卡片样式
├── ChartWidget.tsx               # 图表组件（flow 流程图 / bar 柱状图 / info 信息卡片）
├── ChartWidget.module.css        # 图表组件样式
├── WidgetParsing.tsx             # Widget 解析工具件
├── TreeWidget.tsx                # 渐进式决策树（多层级嵌套+面包屑+淡出滑入动画+叶子回调）
├── TreeWidget.module.css         # 决策树样式
├── StandaloneTreeReplyBar.tsx    # 决策树消息底部操作栏
├── StandaloneTreeReplyBar.module.css
├── BubbleReplyBar.tsx            # 气泡底部统一回复确认栏
├── BubbleReplyBar.module.css     # 气泡统一回复确认栏样式
└── index.ts                      # 模块导出索引
```

---

hooks/
├── useAttachmentManager.ts # 附件管理 Hook
├── useMessageActions.ts # 消息操作逻辑 Hook
├── chatAttachmentContext.ts # Chat 模式附件上下文辅助函数
├── useChatSender.ts # Chat 模式消息发送 Hook
├── useChatSenderPrompt.ts # Chat 模式Prompt Hook
├── useChatSenderContext.ts
├── usePlanningMode.ts # Task 模式消息发送 Hook（内部 planning）
├── useDataLoader.ts # 数据加载 Hook（Hub/Agent 初始化）
└── useTheme.ts # 主题切换 Hook

## 📁 src/stores/ - Zustand 状态管理

```
stores/
├── index.ts                      # 状态库导出索引
├── agentStore.ts                 # 智能体状态管理
├── attachmentViewerStore.ts      # 附件查看器状态
├── chatStore.ts                  # 聊天消息状态管理
├── diffStore.ts                  # 代码差异状态管理
├── fileStore.ts                  # 文件状态管理
├── hubStore.ts                   # Hub 状态管理
├── memoryStore.ts                # 记忆系统状态管理
├── fsmVisualizationStore.ts      # FSM 可视化状态（思维链/决策/Sub-Agent）
├── hitlStore.ts                  # Human-in-the-Loop 状态管理
├── previewStore.ts               # 实时预览状态管理（HTML/Project 双模式，请求代次、关闭、切换与重试资格）
├── previewStore.test.ts          # Project Preview 请求代次、延迟 stop 与重试资格回归
├── cronStore.ts                  # 定时任务状态管理（CRUD + 调度器生命周期）
├── widgetStore.ts                # 生成式 UI Widget 交互通信（事件派发/消费 + 选中态持久化 + 重选撤回）
├── widgetSubmissionRecovery.ts   # 从持久化消息恢复气泡级 Widget 回复状态
├── runtimeStore.ts               # Python Runtime 环境状态管理（persist 持久化）
├── settingsStore.ts              # 应用设置状态管理
├── imChannelStore.ts             # IM 通道状态管理（Bot 配置/连接状态/自动连接/凭据状态）
├── statusStore.ts                # 应用状态（加载/错误等）
├── updateStore.ts
├── networkUploadAuthorizationStore.ts
└── uiStore.ts                    # UI 状态（面板显示/折叠等）
```

## 📁 src/update/ - 版本更新

```
update/
├── index.ts
├── type.ts
└── UpdateService.ts
```

---

## 📁 src/config/ - 应用配置

```
config/
├── modelRegistry.ts              # 模型/供应商注册表（唯一数据源）
│                                 # - 内置供应商与模型定义
│                                 # - 用户自定义模型加载/保存/导入/导出/重置
│                                 # - 供 UI 组件和服务层统一查询的函数接口
└── 📁 __tests__/
    └── modelRegistry.test.ts     # provider/model 推理预算路由完整性测试
```

> 集中管理所有 AI 供应商和模型配置，消除各组件中的硬编码重复。  
> 用户可通过 JSON 配置文件（`model-config.json`）自定义模型列表。

---

## 📁 src/shims/ - Node.js 模块浏览器兼容 shim

```
shims/
├── querystring.ts                # querystring polyfill（URLSearchParams 实现 parse/stringify）
└── ws.ts                         # WebSocket shim（桥接 Node.js ws 包 .on()/.terminate() 到浏览器原生 WebSocket）
```

> 通过 `vite.config.ts` 的 `resolve.alias` 在构建阶段注入，  
> 解决飞书 SDK (@larksuiteoapi/node-sdk) 对 Node.js 内置模块的依赖。

---

## 📁 src/styles/ - 全局样式

```
styles/
├── globals.css                   # 全局样式与重置样式
└── tokens.css                    # 设计令牌（颜色/间距/字体等）
```

## 📁 src/i18n

```
i18n/
├── locales/
│   ├── en.json               # 英文语言包
│   └── zh-CN.json            # 简体中文语言包
├── index.ts
└── runtimeMessages.ts
```

---

## 📁 src/types/ - TypeScript 类型定义

```
types/
├── index.ts                      # 类型导出索引
├── context.ts                    # 上下文相关类型
├── css.d.ts                      # CSS 模块类型声明
├── message.ts                    # 消息相关类型
├── sandboxAudit.ts               # 沙箱安全审计事件结构定义
├── networkDirectAuthorization.ts
├── networkUploadAuthorization.ts
└── rag.ts                        # RAG 检索相关类型
```

## 📁 src/utils/ - 工具函数

```
utils/
├── classNames.ts
├── messageReload.ts
├── networkDirectRisk.ts
└── quoteContent.ts
```

---

## 📁 src/services/ - 业务逻辑服务层

```
services/
├── 📁 attachment/                # 附件处理服务
├── 📁 data/                      # 数据管理服务
├── 📁 diagnostics/               # 诊断服务
├── 📁 fast-apply/                # Fast-Apply 快速应用引擎
├── 📁 file-types/                # 文件类型能力注册表（附件/预览/解析/知识库策略）
├── 📁 llm/                       # LLM 调用服务
├── 📁 language/                  # LLM 输出语言解析、来源语言检测与提示合约
├── 📁 memory/                    # 记忆系统服务
├── 📁 navigation/                # 外部链接与导航边界服务
├── 📁 planning/                  # 规划执行服务（Agent Loop）
├── 📁 preview/                   # Project Preview（独立 staging + Vite/Import Map 双路由）
├── 📁 cron/                      # 定时任务服务（调度/执行/表达式解析）
├── 📁 im-channel/                # IM 通信通道服务（多 Bot 工厂模式，飞书/Slack 集成）
├── 📁 rag/                       # RAG 检索增强服务
├── 📁 desktop-notification       # 任务完成桌面通知服务
└── 📁 utils/                     # 通用工具模块（TimeUtils.ts时间感知工具模块）
```

### 📁 services/attachment/ - 附件处理服务

```
attachment/
├── index.ts                      # 模块导出索引
├── constants.ts                  # 附件处理常量
├── types.ts                      # 附件类型定义
├── AttachmentService.ts          # 附件管理主服务
├── DocumentProcessingService.ts  # 文档处理服务
├── ImageCompressionService.ts    # 图片压缩服务
└── 📁 processors/                # 文档处理器
    ├── index.ts                  # 处理器注册表
    ├── BaseProcessor.ts          # 处理器基类
    ├── DocxProcessor.ts          # Word 文档处理器
    ├── PdfProcessor.ts           # PDF 文档处理器
    ├── PptxProcessor.ts          # PPT 文档处理器
    ├── TextProcessor.ts          # 文本/代码/配置类文件处理器
    └── XlsxProcessor.ts          # Excel 表格处理器（XLSX/XLS）
```

### 📁 services/file-types/ - 文件类型能力注册表

```
file-types/
├── index.ts                      # 模块导出索引
├── FileTypeRegistry.ts           # 文件类型统一注册表（附件上传、文件预览、解析命令、知识库过滤策略）
└── 📁 __tests__/                 # 文件类型策略单元测试
    └── FileTypeRegistry.test.ts  # 附件/预览/解析/知识库能力矩阵测试
```

### 📁 services/data/ - 数据管理服务

```
data/
└── dataManagementService.ts      # 数据导入导出服务
```

### 📁 services/diagnostics/

```
diagnostics/
└── rendererHealth.ts  # WebView renderer 健康诊断
```

### 📁 services/fast-apply/ - Fast-Apply 引擎

```
fast-apply/
├── index.ts                      # 模块导出索引
├── types.ts                      # 类型定义
├── FastApplyService.ts           # Fast-Apply 主服务
├── FastApplyEngine.ts            # 核心引擎（解析与应用）
├── MyersDiff.ts                  # Myers Diff 算法
├── ProtocolParser.ts             # XML 协议解析器
├── ContentMatcher.ts             # 内容匹配器
├── ModificationExecutor.ts       # 修改执行器
├── DiffGenerator.ts              # 差异生成器
├── DiffToXmlConverter.ts         # DiffResult → XML 修改协议转换器
├── FullFileDiffBuilder.ts        # 完整文件差异构建器
└── SnapshotManager.ts            # 快照管理器
```

### 📁 services/llm/ - LLM 调用服务

```
llm/
├── index.ts                      # 模块导出索引
├── types.ts                      # LLM 类型定义
├── LlmService.ts                 # LLM 统一调用服务
├── tokenEstimator.ts             # 用于 StatusBar tokens 估算方法
├── LlmTokenPolicy.ts             # 按调用场景集中定义输出 token 预算与兼容降级
└── 📁 __tests__/
    ├── LlmService.test.ts        # Tauri request/response DTO 合约测试
    └── LlmTokenPolicy.test.ts    # 输出预算场景策略测试
```

### 📁 services/language/

```
language/
└── OutputLanguagePolicy.ts      # 输出目标、显式排除、拉丁语系/简繁检测、来源语言保真与 Prompt 合约
```

### 📁 services/logger/ -

```
logger/
├── crashReporter.ts              # 渲染进程崩溃诊断
├── types.ts                      # 模块类型定义
└── Logger.ts                     # Logger 核心模块
```

### 📁 services/memory/ - 记忆系统服务

```
memory/
├── index.ts                      # 模块导出索引
├── types.ts                      # 记忆类型定义
├── MemoryService.ts              # 记忆管理主服务
├── MemoryContextProvider.ts      # 记忆上下文提供器
├── MemoryIntentDictionary.ts     # 记忆意图词典
├── MemoryVectorIndex.ts          # 记忆向量索引
├── MemoryCandidateScanner.ts     # 记忆候选扫描器
├── MemoryTriggerManager.ts       # 记忆触发管理器
├── MemorySummaryRetriever.ts     # 记忆摘要混合召回器
├── FactExtractor.ts              # 事实提取器（LLM驱动）
├── SummaryManager.ts             # 摘要管理器
├── ShortTermBuffer.ts            # 短期记忆缓冲区
├── EvidenceRetriever.ts          # 证据检索器
├── StabilityVerifier.ts          # 稳定性验证器
├── CategoryConsolidator.ts       # 类别整合器
├── CategoryConsolidationTracker.ts # 整合追踪器
├── ConsolidationConfig.ts        # 整合配置
├── SemanticAnchors.ts            # 语义锚点
├── LLMAdapter.ts                 # LLM 适配器
└── 📁 utils/                     # 记忆工具函数
    ├── index.ts                  # 工具导出
    ├── SafeMessageContent.ts     # 过滤可视化代码块工具
    └── JsonParser.ts             # JSON 解析器
```

### 📁 services/navigation/ - 外部链接与导航边界服务

```
navigation/
└── externalUrl.ts                # 外部 HTTP(S) 链接统一打开入口（Tauri 内走系统浏览器，避免主 WebView 任意导航）
```

### 📁 services/planning/ - 规划执行服务

```
planning/
├── index.ts                      # 模块导出索引
├── PlanningConstants.ts          # 规划相关常量（温度/预算/上下文窗口等）
├── AgentService.ts               # 智能体服务（会话管理）
├── ContextWindowManager.ts       # 上下文窗口管理器
│
├── 📁 artifact/                  # Task Artifact 跨 SA 成果持久化
│   ├── types.ts                  # TaskArtifact / TaskArtifactSnapshot / ArtifactIndexEntry
│   ├── TaskArtifactStore.ts      # Store 实现（write/read/getSnapshot/FIFO 淘汰）
│   └── 📁 __tests__/             # Store 单元测试
│
├── 📁 agent-loop/                # Agent 循环核心
│   ├── index.ts                  # 模块导出
│   ├── types.ts                  # 循环类型定义
│   ├── ErrorObservationFormatter.ts     # Agent Loop 错误观察格式化器
│   ├── AgentLoop.ts              # Agent 主循环（FSM 驱动）
│   ├── AgentSession.ts           # Agent 会话管理
│   ├── AgentLoopFSMIntegration.ts # Agent Loop FSM 集成（瘦编排器）
│   ├── ExperienceExtractor.ts    # SA 执行经验提取器
│   ├── LoopGovernor.ts           # 循环治理器-预算管理、进度追踪、工具震荡检测、风险阈值评估
│   │
│   ├── 📁 builders/              # 构建器模块
│   │   ├── index.ts              # 模块导出
│   │   └── MasterBrainInputBuilder.ts # MasterBrain 输入构建器
│   │
│   ├── 📁 mappers/               # 映射器模块
│   │   ├── index.ts              # 模块导出
│   │   ├── DecisionMapper.ts     # 决策→FSM事件映射器
│   │   └── SubAgentSpecBuilder.ts # SubAgent 规格构建器
│   │
│   ├── 📁 callers/               # LLM 调用器模块
│   │   ├── index.ts              # 模块导出
│   │   ├── SubAgentLLMCaller.ts  # SubAgent LLM 调用器（32K→24K 参数拒绝降级、finish reason 透传）
│   │   │                         # - call()：单次调用（向后兼容）
│   │   │                         # - callWithContext()：多轮会话调用
│   │   │                         # - buildMessagesWithContext()：消息历史构建
│   │   └── 📁 __tests__/         # 调用器测试
│   │       ├── SubAgentLLMCaller.loop.test.ts # Loop 会话测试
│   │       └── SubAgentLLMCaller.tokenPolicy.test.ts # 输出预算、降级与视觉保留测试
│   │
│   ├── 📁 dispatchers/           # 派遣器模块
│   │   ├── index.ts              # 模块导出
│   │   └── SubAgentDispatcher.ts # SubAgent 派遣器
│   │
│   ├── 📁 handlers/              # 状态处理器模块 [模块化重构]
│   │   ├── index.ts              # 模块导出
│   │   ├── types.ts              # 处理器类型定义（HandlerContext/SharedState）
│   │   ├── StateHandlers.ts      # 集中式状态处理器（5 个处理器函数）
│   │   └── 📁 __tests__/         # 处理器测试
│   │       └── StateHandlers.test.ts # 状态处理器测试
│   │
│   └── 📁 __tests__/             # Agent Loop 测试
│       ├── AgentLoopFSMIntegration.test.ts # Agent Loop FSM 集成测试
│       ├── AgentSession.test.ts  # Agent 会话测试
│       ├── LoopGovernor.test.ts  # 循环治理器测试
│       ├── LoopGovernor.subagent.test.ts # Sub-Agent 预算控制测试
│       └── 📁 builders/          # 构建器测试
│           └── MasterBrainInputBuilder.test.ts # 输入构建器测试
│
├── 📁 fsm/                       # 有限状态机（FSM）引擎
│   ├── index.ts                  # 模块导出
│   ├── types.ts                  # FSM 类型定义（状态/事件/上下文）
│   ├── FSMEngine.ts              # 核心状态机引擎
│   ├── FSMDefinitions.ts         # FSM 定义解析（YAML）
│   ├── AgentServiceFSM.yaml      # Agent Service 状态机配置
│   ├── SubAgentFSM.yaml          # Sub-Agent 状态机配置
│   │
│   ├── 📁 guards/                # Guard 条件函数
│   │   ├── index.ts              # Guard 注册表
│   │   ├── BudgetGuards.ts       # 预算相关检查
│   │   ├── ProgressGuards.ts     # 进度与失败模式检测
│   │   └── SchemaGuards.ts       # Schema 校验
│   │
│   ├── 📁 actions/               # Action 副作用函数
│   │   ├── index.ts              # Action 注册表
│   │   ├── BudgetActions.ts      # 预算管理操作
│   │   ├── ProgressActions.ts    # 进度记录操作
│   │   └── LogActions.ts         # 日志操作
│   │
│   └── 📁 __tests__/             # FSM 单元测试
│       ├── FSMEngine.test.ts     # 引擎测试
│       ├── guards.test.ts        # Guard 测试
│       ├── actions.test.ts       # Action 测试
│       └── FSMDefinitions.test.ts # 定义解析测试
│
├── 📁 brain/                     # Master Brain 决策系统
│   ├── index.ts                  # 模块导出
│   ├── types.ts                  # 决策类型定义
│   │                             # - Input/Decision/Risk（基础类型）
│   │                             # - CheckpointDecision（Loop 决策）
│   │                             # - CheckpointCallback（回调类型）
│   ├── MasterBrain.ts            # 主脑封装（决策协调器）
│   ├── MasterBrainDecisionGuard.ts # MB 决策异常分类与共享语义重试额度
│   ├── MasterBrainReasoningGuard.ts # MB 推理循环检测、硬熔断与有界展示快照
│   ├── MasterBrainPrompt.ts      # Prompt 构建器
│   │                             # - build()：主决策 Prompt
│   │                             # - buildCheckpointEvaluationPrompt()：Checkpoint 评估
│   ├── DecisionParser.ts         # 决策解析器（JSON Schema 验证）
│   ├── CheckpointDecisionParser.ts # Checkpoint 决策解析器
│   │                             # - parseCheckpointDecision()：解析 LLM 输出
│   │                             # - safeParseCheckpointDecision()：安全解析（Result 模式）
│   ├── RiskAssessor.ts           # 风险评估器（自动提升）
│   │
│   └── 📁 __tests__/             # Brain 系统单元测试
│       ├── types.test.ts         # 类型守卫测试
│       ├── DecisionParser.test.ts # 决策解析测试
│       ├── CheckpointDecisionParser.test.ts # Checkpoint 解析测试
│       ├── RiskAssessor.test.ts  # 风险评估测试
│       ├── MasterBrainPrompt.test.ts # Prompt 构建测试
│       └── MasterBrain.test.ts   # 主脑集成测试
│
├── 📁 sub-agents/                # Sub-Agent 子智能体系统
│   ├── index.ts                  # 模块导出
│   ├── types.ts                  # 子智能体类型定义
│   │                             # - Output/TaskContext（基础类型）
│   │                             # - SubAgentLoopConfig（Loop 配置）
│   │                             # - ProgressReport（进度报告
│   │                             # - AccumulatedMessage/LoopState（Loop 状态）
│   ├── SubAgentFactory.ts        # 实例创建工厂（spec 验证 + venv 路径解析）
│   ├── SubAgentRunner.ts         # 执行器（LLM 调用、策略验证、截断工具调用安全拦截）
│   ├── SubAgentSafetyFooter.ts   # Safety Footer 默认提示词
│   ├── SubAgentPromptBuilder.ts  # Prompt 构建器（上下文隔离 + venv 约束注入）
│   │
│   └── 📁 __tests__/             # Sub-Agent 单元测试
│       ├── types.test.ts         # 类型守卫测试
│       ├── SubAgentFactory.test.ts # 工厂测试
│       ├── SubAgentRunner.test.ts # 执行器测试
│       ├── SubAgentRunner.loop.test.ts # Loop 执行测试
│       ├── SubAgentRunnerToolCalls.test.ts # ToolCalls 执行测试
│       ├── SubAgentRunner.outputTruncation.test.ts # 输出截断零执行与单次安全重试测试
│       └── SubAgentPromptBuilder.test.ts # Prompt 构建测试
│
├── 📁 observability/             # 观测性系统
│   ├── index.ts                  # 模块导出
│   ├── types.ts                  # 观测性类型（Trace/Callbacks）
│   ├── FSMTracer.ts              # FSM 状态追踪器
│   │                             # - 会话管理、状态转移记录
│   │                             # - JSON 导出支持
│   ├── DecisionLogger.ts         # 决策日志记录器
│   │                             # - 决策记录与执行结果关联
│   │                             # - 按会话查询与统计
│   ├── ThoughtVisualizer.ts      # 思维链可视化器
│   │                             # - <thinking> 标签提取
│   │                             # - 信心度估算
│   │
│   └── 📁 __tests__/             # 观测性系统测试
│       ├── FSMTracer.test.ts     # 状态追踪器测试
│       ├── DecisionLogger.test.ts # 决策日志测试
│       └── ThoughtVisualizer.test.ts # 思维链可视化测试
│
├── 📁 skills/                    # Agent 技能模块
│   ├── index.ts                  # 技能导出
│   ├── types.ts                  # 技能类型定义
│   ├── SkillLoader.ts            # 技能加载器（Native + External 合并）
│   │
│   ├── 📁 exec/                  # 执行技能（Shell命令）
│   │   ├── SKILL.md              # 技能定义文档
│   │   ├── ExecSafetyPolicy.ts   # Exec 命令安全策略
│   │   └── tool.ts               # 工具实现
│   ├── 📁 external_skill_execute  # Script Skill 统一执行入口
│   │   ├── SKILL.md              # 技能定义文档
│   │   └── tool.ts               # 工具实现
│   ├── 📁 read/                  # 读取技能
│   │   ├── SKILL.md              # 技能定义文档
│   │   └── tool.ts               # 工具实现
│   ├── 📁 file_write/            # 统一写入技能
│   │   ├── SKILL.md              # 技能定义文档
│   │   ├── PostWriteValidator.ts #代码写入后语法检查器
│   │   └── tool.ts               # 工具实现
│   ├── 📁 generate_image/         # 图像生成技能
│   │   ├── SKILL.md              # 技能定义文档
│   │   └── tool.ts               # 工具实现
│   ├── 📁 im_send/              # IM 消息发送工具（飞书 / Slack）
│   │   ├── SKILL.md              # 技能定义文档
│   │   └── tool.ts               # 工具实现
│   ├── 📁 feishu_send/          # 飞书消息发送兼容实现
│   │   ├── SKILL.md              # 技能定义文档
│   │   └── tool.ts               # 工具实现
│   ├── 📁 slack_send/           # slack消息发送兼容实现
│   │   ├── SKILL.md              # 技能定义文档
│   │   └── tool.ts               # 工具实现
│   ├── 📁 shared/               # 外部skill共享类
│   │   ├── sandboxPath.ts
│   │   ├── observationRedaction.ts  #observation 脱敏工具
│   │   └── imageAttachment.ts    # 共享图片附件加载器
│   ├── 📁 web_search/            # 网络搜索技能
│   │   ├── SKILL.md              # 技能定义文档
│   │   └── tool.ts               # 工具实现
│   ├── 📁 cron/                  # 定时任务管理技能（Agent 自主创建/管理定时任务）
│   │   ├── SKILL.md              # 技能定义文档
│   │   └── tool.ts               # 工具实现
│   ├── 📁 local_search/           # 本地搜索技能（grep/find/outline/symbol，tree-sitter AST）
│   │   ├── SKILL.md              # 技能定义文档
│   │   └── tool.ts               # 工具实现
│   ├── 📁 conversation_search/    # 当前 Agent 历史对话检索技能（timeline / snippet 分页 / get 全文）
│   │   ├── SKILL.md              # 技能定义文档
│   │   └── tool.ts               # 工具实现
│   │
│   └── 📁 external/              # 外部技能包子系统
│       ├── index.ts              # 模块导出索引
│       ├── types.ts              # 外部技能类型
│       ├── ExternalSkillRegistry.ts # 注册表加载器（registry.yaml 解析 + SKILL.md 加载）
│       ├── ExternalToolProvider.ts  # Script 模式→工具注册适配器
│       ├── SkillAuditService.ts    # 技能包安全审查服务
│       ├── Skill Audit Prompt.md   # 技能包安全审查 Prompt
│       ├── ExternalExecutor.ts     # Script 模式执行器（Shell 调用）
│       ├── RuntimeManager.ts       # Python Runtime 环境管理（venv/回滚/进度回调/Windows 检测）
│       ├── runtimeReadyMarker.ts    # Python Runtime 就绪标记管理
│       ├── DependencyInstaller.ts    # 非 pip 依赖安装服务
│       ├── requirementsProvider.ts # Runtime 基础依赖清单管理和环境安装共享逻辑
│       ├── DependencyAnalyzer.ts   # 技能包静态依赖分析器
│       ├── SkillPackageWatcher.ts   # packages/ 目录文件监听（Tauri plugin-fs）
│       ├── pythonRuntimeHermeticity.ts   #Python Runtime 沙箱兼容性检测工具
│       ├── ContractValidator.ts    # Execution Contract 验证器
│       ├── SkillRetriever.ts       # Guide 技能语义检索器（内存级向量匹配）
│       ├── tauriShellAdapter.ts    # Tauri Shell 执行适配器
│       └── 📁 __tests__/          # 外部技能测试
│           ├── ContractValidator.test.ts
│           ├── ExternalExecutor.test.ts
│           ├── ExternalSkillRegistry.test.ts
│           ├── ExternalToolProvider.test.ts
│           └── RuntimeManager.test.ts
│
├── 📁 tools/                     # 工具注册与策略
│   ├── index.ts                  # 工具导出
│   ├── types.ts                  # 工具类型定义（含 ToolPolicy）
│   ├── ToolRegistry.ts           # 工具注册表
│   ├── ToolAliases.ts            # 工具别名 (feishu_send/slack_send：im_send)
│   ├── ToolPolicyManager.ts      # 工具风险等级安全守卫（ToolRiskGuard）
│   │
│   └── 📁 __tests__/             # 工具策略测试
│       └── ToolPolicyManager.test.ts # 策略管理器测试
│
├── 📁 visual-enhancer/           # 可视化增强服务
│   ├── index.ts                  # 模块导出索引
│   ├── stripVisualCodeBlocks.ts  # 可视化代码块剥离工具
│   ├── VisualEnhancementJobManager.ts # 消息级增强后台队列与独立取消管理
│   ├── VisualEnhancerService.ts  # 可视化增强主服务
│   ├── VisualEnhancerPostProcess.ts  #可视化增强结果后处理
│   ├── VisualEnhancerPrompt.ts   # 可视化增强 Prompt 模板
│   └── 📁 __tests__/             # 可视化增强与后台队列测试
│
└── 📁 utils/                     # 规划工具函数
    ├── index.ts                  # 工具导出
    ├── ChunkProcessor.ts         # 分块处理器
    ├── SubAgentObservationEvent  # SA观测事件工具
    ├── ExecTimeoutObservation.ts  Exec 超时观测辅助
    ├── LlmRetryPolicy.ts         # LLM 重试分类与 max-token 参数拒绝判定
    ├── DeliverableIndexer.ts     # 交付物二进制文件
    └── FileWriter.ts             # 文件写入器
```

### 📁 services/rag/ - RAG 检索增强服务

```
rag/
├── index.ts                      # 模块导出索引
├── RagService.ts                 # RAG 主服务（单例模式）
├── ContextProvider.ts            # 上下文提供器
├── HybridRetriever.ts            # 混合检索器（向量+关键词）
├── VectorStore.ts                # 向量存储（单例 + LRU 缓存）
├── EmbeddingService.ts           # 嵌入向量服务（单例 + LRU 缓存 + 分批调用）
├── DocumentChunker.ts            # 文档分块器
├── BM25Index.ts                  # BM25 关键词索引（增量 IDF 更新）
├── RagQueryPreprocessor.ts       # RAG 查询预处理器
├── RerankService.ts              # 重排序服务
├── DocumentOverviewBuilder.ts    # 文档总览合成块构建器（提升概览类 RAG 召回）
├── KnowledgeFileFilter.ts        # 知识库自动索引文件过滤兼容入口（委托 file-types 策略）
├── LruCache.ts                   # 轻量级 LRU 缓存工具类
└── 📁 __tests__/                # 单元测试
    ├── LruCache.test.ts          # LRU 缓存测试
    ├── BM25Index.test.ts         # BM25 索引测试
    ├── DocumentChunker.test.ts   # 文档分块测试
    ├── DocumentOverviewBuilder.test.ts # 文档总览合成块测试
    ├── HybridRetrieverOutput.test.ts # 混合检索输出策略测试
    ├── RagQueryPreprocessor.test.ts  # 查询预处理测试
    ├── RagService.test.ts        # RAG 主服务测试
    └── VectorStore.test.ts       # 向量存储封装测试
```

### 📁 services/preview/ - Project Preview 隔离预览服务

```
preview/
├── index.ts                      # 模块导出索引
├── types.ts                      # 类型定义（ProjectFile/TemplateConfig/ViteServerState）
├── VitePreviewService.ts         # 隔离 staging、静态预检、health/owned PID 与公平 cleanup/stale recovery 调度
├── TemplateManager.ts            # 受控模板缓存（禁用 npm lifecycle scripts + 完成 marker）
├── TemplateManager.test.ts       # 模板 warmup/Preview 并发安装去重与 npm 命令策略回归
├── templateInference.ts          # 模板推断逻辑
├── htmlResourceInliner.ts        # HTML 相对路径资源内嵌工具
├── projectPathPolicy.ts          # Agent 项目相对路径标准化与越界拒绝
├── projectPathPolicy.test.ts     # 绝对路径/盘符/UNC/URL/NUL/.. 路径策略回归
├── importMapAnalysis.ts          # Import Map 合法性/精确+前缀映射和 module specifier 分析
├── importMapAnalysis.test.ts     # malformed map、映射、inline/module 入口、重导出/动态导入回归
├── previewDependencyPolicy.ts    # npm allow-list、256 KiB manifest/128 依赖等预算与受控 package.json
├── previewDependencyPolicy.test.ts # 本地/Git/HTTP/alias 拒绝及 manifest/依赖/名称/spec 边界回归
├── previewProjectPlan.ts         # 完整项目/片段入口图隔离、同 stem 遮蔽防护与项目工具链探测
├── previewProjectPlan.test.ts    # 模板入口污染、缺失 HTML 生成和 Vite/PostCSS 配置保留回归
├── previewSourcePolicy.ts        # UI 收集与服务边界共享的源文件数量/单文件/总字节/扫描预算
├── previewSourcePolicy.test.ts   # UTF-8 字节、文件数量、总量预算与根级工具配置过滤回归
├── tailwindThemePolicy.ts        # 片段回退路径的 Tailwind 字面量 theme 静态提取与预算策略
├── tailwindThemePolicy.test.ts   # ESM/CJS/TS 字面量兼容、动态表达式拒绝与原型污染回归
├── previewSourceStaging.ts       # root-relative 原生源文件枚举/读取、路径复验与 remaining-byte 预算
├── previewSourceStaging.test.ts  # native 命令参数、路径规范化、预算/拒绝映射及无旧 fs 读取回归
├── previewAssetCopier.ts         # owned workspace 原生资产复制、非可执行 allow-list 与容量预算
├── previewAssetCopier.test.ts    # asset copy owner token、destinationPrefix、skipFiles、预算及无 renderer fs 复制回归
├── trustedPreviewRuntime.ts      # AgentVis Vite 包装/静态服务器与可重放 lifecycle diagnostics bridge
├── trustedPreviewRuntime.test.ts # 包装边界、项目 alias/React TSX 编译及 fs/CORS/token/bridge 回归
├── windowCloseLifecycle.ts       # 窗口关闭前同步失效请求、限时 cleanup 与 destroy 失败恢复
├── windowCloseLifecycle.test.ts  # 关闭时序、cleanup timeout 与 destroy 重试回归
├── VitePreviewService.test.ts    # 路径/依赖预检、Import Map native-JS-only 拒绝与真实重试回归
├── VitePreviewServiceCleanup.test.ts # 原生 create/cleanup/stale、lease 门槛、公平 backlog 与 sweep 重调度回归
├── VitePreviewServiceCancellation.test.ts # source/package 写入、依赖链接与 shell execution 取消竞态回归
├── VitePreviewServiceTemplateInstall.test.ts # 模板 install owner/joiner 取消与失败重试回归
├── previewErrors.ts              # 结构化 Preview 错误码、序列化与取消识别
├── previewUrlPolicy.ts           # Project Preview URL allow-list（仅允许受控 localhost 预览端口）
└── PortAllocator.ts              # 端口分配器（async fetch 探测防冲突，范围 3100-3199）
```

### 📁 services/cron/ - 定时任务服务

```
cron/
├── index.ts                      # 模块导出索引
├── types.ts                      # 定时任务类型定义（CronJob/CronJobCreateParams/CronJobUpdateParams）
├── cronExpression.ts             # Cron 表达式工具（解析/描述/构建/ScheduleConfig 双向转换）
├── CronScheduler.ts              # 定时任务调度器（轮询/执行/自动关闭/生命周期管理）
└── CronExecutor.ts               # 定时任务执行器（Task 模式 + 跨 Hub Agent 切换 + 事件触发）
```

### 📁 services/im-channel/ - IM 通信通道服务

```
im-channel/
├── index.ts                      # 模块导出索引
├── types.ts                      # IM 通道类型定义（ImChannel 接口/IncomingMessage/BotConfig/凭据类型）
├── cardTemplates.ts              # IM 通用卡片模板
├── ImChannelFactory.ts           # 通道工厂（工厂模式，按 botId 创建/复用 Channel 实例）
├── ImTaskBridge.ts               # IM→Agent 任务桥接器（消息接收→Agent 调度→结果回传 IM 卡片）
├── ImProgressTracker.ts          # IM 进度追踪器（FSM 状态→IM 卡片实时更新）
│
└── 📁 platforms/                 # 平台实现
    ├── FeishuChannel.ts          # 飞书通道（WSClient 长连接 + XHR 代理绕 CORS + Rust 后端 REST API）
    ├── feishuCardBuilder.ts      # 飞书消息卡片构建器（任务状态/进度/结果 Interactive Card）
    ├── SlackChannel.ts           # Slack 通道适配器（Socket Mode + Rust 后端 HTTP 代理）
    └── slackBlockBuilder.ts      # Slack Block Kit 构建器
```

### 📁 services/desktop-notification/ -任务完成通知服务

```
desktop-notification/
├── index.ts                      # 模块导出索引
└── TaskCompletionNotifier.ts     # 任务完成通知组件
```

---

## 📁 src-tauri/ - Tauri 后端 (Rust)

```
src-tauri/
├── Cargo.toml                    # Rust 项目配置
├── Cargo.lock                    # 依赖锁定文件
├── build.rs                      # 构建脚本
├── tauri.conf.json               # Tauri 应用配置
├── Run-MatrixTest.ps1            # WFP 手工共存矩阵测试脚本
├── Test.bat                      # WFP 矩阵测试启动脚本（自动提权）
│
├── 📁 capabilities/              # Tauri 能力配置
├── 📁 gen/                       # 自动生成的代码
├── 📁 icons/                     # 应用图标资源
├── 📁 broker-bin/                # 打包随附的 broker helper / WFP helper 二进制资源
├── 📁 node-bundle/               # 内置 Node.js 运行时压缩包资源
├── 📁 python-embed/              # 嵌入式 Python 原始资源与 bootstrap 工具
├── 📁 python-runtime/            # 预构建 Python runtime 压缩包与签名
├── 📁 skills-bundle/             # 内置外部 Skill 包资源
├── 📁 native-scripts/            # 原生命令使用的内置 Python helper（如 DDGS 后备搜索）
├── 📁 target/                    # Rust 编译输出
│
└── 📁 src/                       # Rust 源代码
    ├── main.rs                   # 应用入口
    ├── lib.rs                    # 库入口（含 Preview workspace 原生 create/cleanup/stale 命令注册）
    ├── error.rs                  # 错误类型定义
    ├── text_utils.rs             # UTF-8 文本处理工具
    ├── webview_diagnostics.rs    # WebView2 进程级诊断
    │
    ├── 📁 bin/                   # 二进制入口
    ├── 📁 tests/                 # 测试文件
    │
    ├── 📁 commands/              # Tauri 命令（IPC 接口）
    ├── 📁 db/                    # 数据库层（SQLite）
    ├── 📁 llm/                   # LLM 提供商集成
    └── 📁 crypto/                # 加密模块
```

### 📁 src-tauri/src/commands/ - Tauri 命令

```
commands/
├── mod.rs                        # 模块入口
├── agent.rs                      # 智能体相关命令
├── hub.rs                        # Hub 相关命令
├── message.rs                    # 消息相关命令
├── file.rs                       # 文件管理命令（含可信工作区边界校验与 Windows 回收站操作）
├── text_preview.rs               # 大型文本有界读取与 Markdown 复杂度分析命令
├── workspace_import.rs           # 工作区导入 session、staging、分块写入与整批提交/回滚
├── preview_staging.rs            # Project Preview root-relative 有界 no-follow 源读取与 owned workspace 资产复制
├── trash_bin.rs                  # 回收站管理命令
├── command_validator.rs          # 命令安全校验器
├── memory.rs                     # 记忆系统命令
├── memory_trigger.rs             # 记忆触发命令
├── rag.rs                        # RAG 检索命令
├── llm.rs                        # LLM 调用命令
├── settings.rs                   # 设置相关命令
├── renderer_health.rs            # Renderer health diagnostics
├── snapshot.rs                   # 快照管理命令
├── diff_record.rs                # 差异记录命令
├── data_management.rs            # 数据导入导出命令
├── document_parser.rs            # 文档解析命令
├── cloud_embedding.rs            # 云端嵌入服务命令
├── security_settings.rs          # 安全设置相关
├── shell.rs                      # Shell 执行编排 + Preview 本进程 lease、receipt 原子隔离与 no-follow workspace/trash 回收
├── network_broker.rs             # 主进程网络 Broker 核心
├── process_sandbox.rs            # 进程沙箱能力 facade
├── process_sandbox/              # 进程沙箱策略、审计、网络扫描与平台后端
│   ├── audit.rs                  # 沙箱审计事件存储、查询、持久化与 hash 工具
│   ├── broker_audit.rs           # 网络 Broker / 主进程网络请求审计事件构造
│   ├── desktop.rs                # 桌面交互检测与 detached launch 推断
│   ├── policy.rs                 # ShellSandboxPolicy 主策略链路
│   ├── types.rs                  # 沙箱档位、网络范围、生命周期和共享类型
│   ├── network.rs                # 网络扫描子模块 facade
│   ├── network/
│   │   ├── scan.rs               # 网络命令、脚本 API、proxy bypass / raw socket 扫描
│   │   ├── direct_targets.rs     # 非 HTTP(S) direct-audit 目标解析与授权匹配辅助
│   │   └── powershell.rs         # PowerShell 直连目标提取
│   ├── platform.rs               # 平台后端 facade
│   └── platform/
│       ├── windows.rs            # Windows Job Object / AppContainer / Restricted Token 后端
│       └── non_windows.rs        # 非 Windows stub，保持跨平台编译边界
├── embedded_node_setup.rs        # 内嵌 Node.js 环境准备命令 (打包相关)
├── embedded_python_setup.rs      # 内嵌 Python 环境准备命令 (打包相关)
├── skills_bootstrap.rs           # 内嵌 skill 预安装包 (打包相关)
├── skill_install.rs              # GitHub 技能包下载安装命令（ZIP 下载+解压）
├── web_search.rs                 # 网络搜索命令（Tavily 优先，DDGS 后备）
├── search.rs                     # 代码搜索命令（grep/find/outline/symbol，tree-sitter AST 解析）
├── cron.rs                       # 定时任务 CRUD 命令（IPC 接口）
├── feishu.rs                     # 飞书 API 代理命令（token/发消息/更新卡片/HTTP 通用代理，绕 CORS）
└── slack.rs                      # Slack HTTP API 代理命令
```

### 📁 src-tauri/native-scripts/ - 原生命令脚本资源

```
native-scripts/
└── 📁 web-search/
    └── ddgs_search.py            # DDGS 后备搜索 helper，复用 web-scraper 清洗逻辑并通过 Broker 代理出网
```

### 📁 src-tauri/src/bin/

```
bin/
├── agentvis_wfp_helper.rs            # AgentVis WFP 网络隔离 Spike helper
├── agentvis_broker_fetch.rs          # AgentVis 显式网络 Broker 请求 helper
└── agentvis_wfp_network_probe.rs     # AgentVis WFP 网络隔离测试探针
```

### 📁 src-tauri/tests/ - 测试模块

```
tests/
└── wfp_network_isolation.rs      # AgentVis WFP 网络隔离集成验证
```

### 📁 src-tauri/ - 手工验证脚本

```
src-tauri/
├── Run-MatrixTest.ps1            # 执行 WFP TCP/UDP/非目标网络与 cleanup 检查
└── Test.bat                      # 管理员模式启动矩阵测试，便于记录 Defender / 代理 / VPN 共存结果
```

### 📁 src-tauri/src/db/ - 数据库层

```
db/
├── mod.rs                        # 模块入口与连接管理
├── schema.rs                     # 数据库表结构定义
├── models.rs                     # 数据模型定义
├── hub_repo.rs                   # Hub 数据仓库
├── agent_repo.rs                 # 智能体数据仓库
├── message_repo.rs               # 消息数据仓库
├── file_repo.rs                  # 文件数据仓库
├── memory_repo.rs                # 记忆数据仓库
├── memory_trigger_repo.rs        # 记忆触发数据仓库
├── vector_repo.rs                # 向量数据仓库
├── snapshot_repo.rs              # 快照数据仓库
├── diff_record_repo.rs           # 差异记录数据仓库
└── cron_repo.rs                  # 定时任务数据仓库
```

### 📁 src-tauri/src/llm/ - LLM 提供商集成

```
llm/
├── mod.rs                        # 模块入口
├── types.rs                      # LLM 类型、默认输出预算与 tool-call finish reason
├── http_client.rs                # HTTP 客户端（连接池）
├── schema_compat.rs
├── json_repair.rs                # 流式/截断 JSON 参数修复（上层须结合 finish reason 安全处置）
├── gemini.rs                     # Google Gemini 适配器
├── openai.rs                     # OpenAI 适配器（ZhipuAI/火山引擎复用）
└── anthropic.rs                  # Anthropic Claude 适配器（百炼/Minimax 复用）
```

### 📁 src-tauri/src/crypto/ - 加密模块

```
crypto/
├── mod.rs                        # 模块入口
└── keystore.rs                   # API 密钥安全存储
```

---

## 🏗️ 核心模块说明

| 模块                              | 说明                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Planning（Task 模式内部实现）** | Agent 规划执行系统，基于 FSM + Master Brain + Sub-Agent 实现自主任务完成                        |
| **Memory**                        | 三层记忆系统：短期记忆、摘要记忆、事实记忆                                                      |
| **RAG**                           | 混合检索增强生成，结合向量相似度与 BM25 关键词搜索                                              |
| **Fast-Apply**                    | 代码快速应用引擎，支持 XML 协议解析与差异预览                                                   |
| **Attachment**                    | 多格式文档处理（PDF/DOCX/XLSX/PPTX/TXT/MD）                                                     |
| **Preview**                       | Vite 实时多文件项目预览（React+Tailwind / Vue+Tailwind / Vanilla）                              |
| **Cron**                          | Agent 定时任务系统，支持频率驱动调度 UI + 高级 Cron 表达式，以 Task 模式触发执行                |
| **IM Channel**                    | IM 通信通道（多 Bot 工厂模式），支持飞书/Slack 长连接，手机端下发任务并实时查看思维链与执行结果 |

---
