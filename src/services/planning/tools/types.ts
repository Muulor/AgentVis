/**
 * Tool 类型定义
 *
 * 定义嵌入式运行器模式下的工具接口和类型
 *
 * 架构设计：
 * - Tool: 工具的统一接口，每个工具实现 execute() 方法
 * - ToolSchema: Gemini Function Calling 的 JSON Schema 格式
 * - ToolResult: 工具执行结果，包含 success/error 状态
 *
 * LLM 调用流程：
 * 1. 代码组装 System Prompt + 可用工具 Schema
 * 2. 发送给 LLM，LLM 返回 tool_use 或文本响应
 * 3. 代码解析 tool_use，调用对应 Tool.execute()
 * 4. 将结果加入对话历史，回到步骤 2
 */

// ==================== 工具 Schema 类型 ====================

/**
 * 工具参数 Schema（Gemini functionDeclarations 格式）
 *
 * 对应 Gemini API 的 FunctionDeclaration.parameters
 */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolPropertySchema>;
  required?: string[];
  description?: string;
}

/**
 * 工具属性 Schema
 */
export interface ToolPropertySchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: ToolPropertySchema;
  /** 嵌套对象属性（type='object' 时使用，支持 array-of-objects 等复杂 Schema） */
  properties?: Record<string, ToolPropertySchema>;
  /** 嵌套对象必需字段（与 properties 配合使用） */
  required?: string[];
  default?: unknown;
}

/**
 * 工具 Schema（传递给 LLM 的工具定义）
 *
 * 对应 Gemini API 的 FunctionDeclaration
 */
export interface ToolSchema {
  /** 工具名称（唯一标识） */
  name: string;
  /** 工具描述（LLM 用于理解工具用途） */
  description: string;
  /** 参数 Schema */
  parameters: ToolParameterSchema;
}

// ==================== 工具执行类型 ====================

/**
 * 工具执行上下文
 *
 * 由 AgentLoop 传递给 Tool.execute()
 */
export interface ToolExecutionContext {
  /** Agent ID */
  agentId?: string;
  /** LLM Provider ID */
  providerId?: string;
  /** 模型 ID */
  modelId?: string;
  /** Custom API base URL, used by the local provider and provider-specific tools. */
  baseUrl?: string;
  /** 工作目录（用于文件操作） */
  workdir?: string;
  /** 隔离模式允许访问的文件根目录；未设置时回退到 workdir。 */
  sandboxRoots?: string[];
  /** 用户可见的三档沙箱权限。 */
  sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
  /**
   * Native file-tool filesystem boundary.
   *
   * `workspace` keeps read/file_write/local_search inside sandboxRoots.
   * `local` lets native file tools use the host filesystem; network policy is handled separately.
   */
  sandboxFilesystemScope?: 'workspace' | 'local';
  /** 进度回调（可选） */
  onProgress?: (message: string) => void;
  /** 授权回调（用于敏感操作） */
  onRequestAuthorization?: (operation: string, target: string) => Promise<boolean>;
  /** 是否由 Sub-Agent 调用（true 时跳过交互确认，直接应用修改） */
  isSubAgentContext?: boolean;
  /** 任务取消信号，用于中断长耗时工具调用 */
  signal?: AbortSignal;
  /** venv Python 可执行文件路径（exec 工具用于规范化裸 python 命令） */
  venvPythonPath?: string;
  /**
   * Hub 名称（已清理的文件夹名）
   *
   * 由 AgentLoop 根据 agent/hub entity 信息注入。
   * generate_image 工具使用此字段构建 deliverables 路径，
   * 避免通过 Store 查找（Store 在工具执行时可能未就绪）导致 fallback 到 default/unknown。
   */
  hubName?: string;
  /**
   * Agent 名称（已清理的文件夹名）
   *
   * 由 AgentLoop 根据 agent/hub entity 信息注入。
   * generate_image 工具使用此字段构建 deliverables 路径，
   * 避免通过 Store 查找导致 fallback。
   */
  agentName?: string;
  /**
   * 当前任务来源的 IM Bot ID（仅在消息来自飞书、Slack 等 IM 通道时注入）
   *
   * 供 im_send 等工具精确定位当前 Bot，
   * 确保 IM/cron 触发的出站消息使用正确机器人配置。
   */
  imBotId?: string;
}

/**
 * 工具执行结果
 *
 * Tool.execute() 的返回值
 */
export interface ToolResult {
  /** 执行是否成功 */
  success: boolean;
  /** 结果内容（成功时为工具输出，失败时为错误信息） */
  content: string;
  /** 是否需要用户交互（如 Diff 确认） */
  requiresInteraction?: boolean;
  /** 附加数据（工具特定的结构化数据） */
  data?: Record<string, unknown>;
  /** 图片附件（多模态，read 工具读取图片时填充） */
  images?: Array<{ mimeType: string; data: string }>;
}

// ==================== 工具接口 ====================

/**
 * Tool 接口
 *
 * 所有工具必须实现此接口
 */
export interface Tool {
  /** 工具 Schema（用于 LLM Function Calling） */
  readonly schema: ToolSchema;

  /**
   * 执行工具
   *
   * @param params 工具参数（来自 LLM 的 functionCall.args）
   * @param context 执行上下文
   * @returns 工具执行结果
   */
  execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

// ==================== LLM 响应类型 ====================

/**
 * LLM 工具调用请求（来自 LLM 响应）
 *
 * 对应 Gemini API 的 FunctionCall
 */
export interface ToolCall {
  /** 工具名称 */
  name: string;
  /** 工具参数 */
  args: Record<string, unknown>;
}

/**
 * LLM 响应类型
 *
 * AgentLoop 解析 LLM 响应后的分类
 */
export type LLMResponseType =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolCalls: ToolCall[] }
  | { type: 'error'; error: string };

/**
 * 工具注册表接口
 */
export interface IToolRegistry {
  /** 注册工具 */
  register(tool: Tool): void;

  /** 获取工具 */
  get(name: string): Tool | undefined;

  /** 获取所有工具 */
  getAll(): Tool[];

  /** 获取所有工具的 Schema（用于 LLM 请求） */
  getSchemas(): ToolSchema[];
}

// ═══════════════════════════════════════════════════════════════
// 工具策略类型
// ═══════════════════════════════════════════════════════════════

/**
 * 工具来源类型
 *
 * Phase 1: 仅 'native'
 * Phase 2: 扩展 'external'（Python/Bash Skills）
 */
export type ToolSource = 'native' | 'external';

/**
 * 工具策略（Sub-Agent 权限管理）
 */
export interface ToolPolicy {
  /** 允许使用的工具列表 */
  allowed: string[];
  /** 禁止使用的工具列表 */
  forbidden: string[];
  /**
   * [扩展点] 允许的工具来源
   * Phase 1: 默认 ['native']
   * Phase 2: 可添加 'external'
   */
  allowedSources?: ToolSource[];
}

/**
 * 工具提供者接口（扩展点）
 *
 * Phase 1: 仅 NativeToolProvider
 * Phase 2: 添加 ExternalToolProvider
 */
export interface ToolProvider {
  /** 提供者名称 */
  readonly name: string;
  /** 工具来源类型 */
  readonly source: ToolSource;
  /** 获取所有工具 Schema */
  getSchemas(): ToolSchema[];
  /** 执行工具 */
  execute(toolName: string, params: unknown, context: ToolExecutionContext): Promise<ToolResult>;
  /** 检查是否支持某工具 */
  supports(toolName: string): boolean;
}
