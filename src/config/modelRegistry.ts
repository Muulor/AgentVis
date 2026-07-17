/**
 * Model Registry - 模型/供应商集中注册表
 *
 * 整个前端中模型和供应商信息的**唯一数据源**。
 * 所有 UI 组件和服务应通过此模块获取供应商/模型数据，
 * 而非各自维护硬编码常量。
 *
 * 设计原则：
 * - 供应商列表固定（对应 Rust 端 match 分支），用户不能新增供应商
 * - 模型列表可自定义（纯前端展示数据，不影响 Rust 路由）
 * - `local` 供应商例外：支持自定义 base_url + 协议自动推断，是"万能代理入口"
 * - 用户自定义模型通过 JSON 配置文件 (model-config.json) 持久化
 */

// ==================== 类型定义 ====================

/**
 * 供应商定义
 *
 * 每个供应商对应 Rust 端 llm.rs 的一个 match 分支，
 * protocol 字段标识 Rust 使用的 API 适配器类型。
 */
export interface ProviderDefinition {
  /** 唯一标识符（与 Rust 端 match 分支对应） */
  id: string;
  /** UI 显示名称 */
  name: string;
  /** Rust 端使用的 API 协议类型 */
  protocol: 'openai' | 'anthropic' | 'gemini';
  /** API Key 输入框占位文字 */
  apiKeyPlaceholder: string;
  /** 获取 API Key 的外部链接 */
  apiKeyUrl?: string;
}

/**
 * AgentVis 的统一推理档位语义。
 *
 * UI 直接展示这些英文 token；具体供应商参数由 Rust 路由适配器解析。
 */
export const REASONING_PRESETS = [
  'recommended',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningPreset = (typeof REASONING_PRESETS)[number];

/**
 * 模型定义
 *
 * 模型属于某个供应商，包含显示名称和上下文窗口大小等信息。
 */
export interface ModelDefinition {
  /** 模型 ID（传给 Rust 端的标识符） */
  id: string;
  /** UI 显示名称 */
  name: string;
  /** 所属供应商 ID */
  providerId: string;
  /** 上下文窗口大小 (tokens) */
  contextWindow: number;
  /** 是否支持视觉/多模态输入。只有显式声明为 true 时才允许传递图片。 */
  supportsVision?: boolean;
}

/**
 * 用户自定义模型配置文件格式
 *
 * 存储在 {appDataDir}/model-config.json
 */
export interface UserModelConfig {
  /** 配置文件版本（用于未来迁移） */
  version: number;
  /** 用户自定义模型列表 */
  models: ModelDefinition[];
}

// ==================== 内置供应商 ====================

/**
 * 内置供应商列表
 *
 * 顺序决定 UI 下拉菜单的显示顺序。
 * 每个条目与 Rust 端 llm.rs 的 provider match 分支一一对应。
 */
const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    apiKeyPlaceholder: 'sk-...',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    name: 'Google AI',
    protocol: 'gemini',
    apiKeyPlaceholder: 'AIza...',
    apiKeyUrl: 'https://aistudio.google.com/api-keys',
  },
  {
    id: 'zhipu',
    name: 'ZhipuAI',
    protocol: 'openai',
    apiKeyPlaceholder: 'API Key...',
    apiKeyUrl: 'https://bigmodel.cn/coding-plan/personal/overview',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    apiKeyPlaceholder: 'sk-...',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'agnes',
    name: 'Agnes AI',
    protocol: 'openai',
    apiKeyPlaceholder: 'API Key...',
    apiKeyUrl: 'https://platform.agnes-ai.com/settings/profile',
  },
  {
    id: 'stepfun',
    name: 'StepFun (Step Plan)',
    protocol: 'openai',
    apiKeyPlaceholder: 'API Key...',
    apiKeyUrl: 'https://platform.stepfun.com/interface-key',
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi(Token Plan)',
    protocol: 'openai',
    apiKeyPlaceholder: 'API Key...',
    apiKeyUrl: 'https://platform.xiaomimimo.com/console/plan-manage',
  },
  {
    id: 'zhipu-coding',
    name: 'ZhipuAI (Coding Plan)',
    protocol: 'openai',
    apiKeyPlaceholder: 'API Key...',
    apiKeyUrl: 'https://bigmodel.cn/coding-plan/personal/overview',
  },
  {
    id: 'minimax',
    name: 'MiniMax(Token Plan)',
    protocol: 'anthropic',
    apiKeyPlaceholder: 'API Key...',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/payment/token-plan',
  },
  {
    id: 'volcengine',
    name: 'Volcengine (Coding Plan)',
    protocol: 'openai',
    apiKeyPlaceholder: 'sk-sp-...',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    apiKeyPlaceholder: 'sk-or-...',
    apiKeyUrl: 'https://openrouter.ai/workspaces/default/keys',
  },
  { id: 'local', name: 'Local', protocol: 'gemini', apiKeyPlaceholder: 'API Key...' },
];

// ==================== 内置模型 ====================

/**
 * 内置模型列表
 *
 * 整合自原 ModelSettings.tsx、AgentModelSelector.tsx、StatusBar.tsx、
 * ContextWindowManager.ts 中分散的硬编码常量。
 * contextWindow 值来源于 ContextWindowManager.ts 中的 MODEL_CONTEXT_WINDOWS。
 */
const BUILTIN_MODELS: ModelDefinition[] = [
  // ━━ OpenAI ━━
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    providerId: 'openai',
    contextWindow: 1050000,
    supportsVision: true,
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4-Mini',
    providerId: 'openai',
    contextWindow: 400000,
    supportsVision: true,
  },
  {
    id: 'gpt-5.4-nano',
    name: 'GPT-5.4-Nano',
    providerId: 'openai',
    contextWindow: 400000,
    supportsVision: true,
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    providerId: 'openai',
    contextWindow: 1050000,
    supportsVision: true,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    providerId: 'openai',
    contextWindow: 1050000,
    supportsVision: true,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    providerId: 'openai',
    contextWindow: 1050000,
    supportsVision: true,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    providerId: 'openai',
    contextWindow: 1050000,
    supportsVision: true,
  },

  // ━━ Anthropic ━━
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude-4.6-Sonnet',
    providerId: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude-5-Sonnet',
    providerId: 'anthropic',
    contextWindow: 1000000,
    supportsVision: true,
  },
  {
    id: 'claude-opus-4-7',
    name: 'Claude-4.7-Opus',
    providerId: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude-4.8-Opus',
    providerId: 'anthropic',
    contextWindow: 1000000,
    supportsVision: true,
  },
  {
    id: 'claude-fable-5',
    name: 'Claude-5-Fable',
    providerId: 'anthropic',
    contextWindow: 1000000,
    supportsVision: true,
  },

  // ━━ Gemini ━━
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini-3-Flash',
    providerId: 'gemini',
    contextWindow: 200000,
    supportsVision: true,
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini-3.1-Pro',
    providerId: 'gemini',
    contextWindow: 200000,
    supportsVision: true,
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini-3.5-Flash',
    providerId: 'gemini',
    contextWindow: 1000000,
    supportsVision: true,
  },

  // ━━ ZhipuAI ━━
  {
    id: 'glm-4.6v-flash',
    name: 'GLM-4.6V-Flash',
    providerId: 'zhipu',
    contextWindow: 128000,
    supportsVision: true,
  },
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    providerId: 'zhipu',
    contextWindow: 204800,
    supportsVision: false,
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    providerId: 'zhipu',
    contextWindow: 1000000,
    supportsVision: false,
  },

  // ━━ DeepSeek ━━
  // DeepSeek 官方 API，使用 OpenAI 兼容协议，支持思考模式（reasoning_content）
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    providerId: 'deepseek',
    contextWindow: 1000000,
    supportsVision: false,
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    providerId: 'deepseek',
    contextWindow: 1000000,
    supportsVision: false,
  },

  // ━━ Agnes AI ━━
  // Agnes AI API 使用 OpenAI 兼容协议；Agnes-2.0-Flash 是 text/agentic 模型
  {
    id: 'agnes-2.0-flash',
    name: 'Agnes 2.0 Flash',
    providerId: 'agnes',
    contextWindow: 512000,
    supportsVision: false,
  },

  // ━━ StepFun Step Plan ━━
  // Step Plan 使用 OpenAI 兼容协议，专属路径为 /step_plan/v1
  {
    id: 'step-3.7-flash',
    name: 'Step 3.7 Flash',
    providerId: 'stepfun',
    contextWindow: 256000,
    supportsVision: true,
  },

  // ━━ Xiaomi Token Plan  ━━
  // Xiaomi MiMo Token Plan API，使用 OpenAI 兼容协议
  {
    id: 'mimo-v2.5',
    name: 'MiMo V2.5',
    providerId: 'xiaomi-mimo',
    contextWindow: 1000000,
    supportsVision: true,
  },
  {
    id: 'mimo-v2.5-pro',
    name: 'MiMo V2.5 Pro',
    providerId: 'xiaomi-mimo',
    contextWindow: 1000000,
    supportsVision: false,
  },

  // ━━ ZhipuAI Coding Plan ━━
  // Coding Plan 专属 endpoint，与普通 zhipu 共享 API Key，但享受编码套餐独立配额
  // 注：GLM-5.1 需要更高级别套餐权限；GLM-4.7 是大多数套餐均可使用的主推模型
  {
    id: 'GLM-4.7',
    name: 'GLM-4.7 (Coding)',
    providerId: 'zhipu-coding',
    contextWindow: 128000,
    supportsVision: true,
  },
  {
    id: 'GLM-5-Turbo',
    name: 'GLM-5-Turbo (Coding)',
    providerId: 'zhipu-coding',
    contextWindow: 200000,
    supportsVision: true,
  },
  {
    id: 'GLM-5.1',
    name: 'GLM-5.1 (Coding)',
    providerId: 'zhipu-coding',
    contextWindow: 204800,
    supportsVision: false,
  },
  {
    id: 'GLM-5.2',
    name: 'GLM-5.2 (Coding)',
    providerId: 'zhipu-coding',
    contextWindow: 1000000,
    supportsVision: false,
  },

  // ━━ MiniMax Token Plan  ━━
  {
    id: 'MiniMax-M2.7',
    name: 'MiniMax M2.7',
    providerId: 'minimax',
    contextWindow: 204800,
    supportsVision: false,
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'MiniMax M2.7 Highspeed',
    providerId: 'minimax',
    contextWindow: 204800,
    supportsVision: false,
  },
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    providerId: 'minimax',
    contextWindow: 1000000,
    supportsVision: true,
  },

  // ━━ 火山引擎 Coding Plan  ━━
  {
    id: 'doubao-seed-2.0-pro',
    name: 'Doubao Seed 2.0 Pro',
    providerId: 'volcengine',
    contextWindow: 256000,
    supportsVision: true,
  },
  {
    id: 'doubao-seed-2.0-code',
    name: 'Doubao Seed 2.0 Code',
    providerId: 'volcengine',
    contextWindow: 256000,
    supportsVision: true,
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    providerId: 'volcengine',
    contextWindow: 1000000,
    supportsVision: false,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    providerId: 'volcengine',
    contextWindow: 1000000,
    supportsVision: false,
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    providerId: 'volcengine',
    contextWindow: 256000,
    supportsVision: true,
  },
  {
    id: 'Kimi-K2.7-Code',
    name: 'Kimi K2.7 Code',
    providerId: 'volcengine',
    contextWindow: 256000,
    supportsVision: true,
  },
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    providerId: 'volcengine',
    contextWindow: 512000,
    supportsVision: true,
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    providerId: 'volcengine',
    contextWindow: 1000000,
    supportsVision: false,
  },

  // ━━ OpenRouter ━━
  // 通过 OpenRouter 聚合路由访问各厂商免费模型（OpenAI 兼容协议）
  // 上下文窗口单位：tokens（原文 K 已换算：262K→262144, 131K→131072, 196K→196608）
  {
    id: 'xiaomi/mimo-v2.5',
    name: 'Mimo V2.5',
    providerId: 'openrouter',
    contextWindow: 1000000,
    supportsVision: true,
  },
  {
    id: 'xiaomi/mimo-v2.5-pro',
    name: 'Mimo V2.5 Pro',
    providerId: 'openrouter',
    contextWindow: 1000000,
    supportsVision: false,
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'Deepseek V4 Flash',
    providerId: 'openrouter',
    contextWindow: 1000000,
    supportsVision: false,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'Deepseek V4 Pro',
    providerId: 'openrouter',
    contextWindow: 1000000,
    supportsVision: false,
  },
  {
    id: 'minimax/minimax-m3',
    name: 'Minimax M3',
    providerId: 'openrouter',
    contextWindow: 1000000,
    supportsVision: true,
  },
  {
    id: 'z-ai/glm-5.2',
    name: 'GLM 5.2',
    providerId: 'openrouter',
    contextWindow: 1000000,
    supportsVision: false,
  },
  {
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3',
    providerId: 'openrouter',
    contextWindow: 1000000,
    supportsVision: true,
  },
  // ━━ Local（本地代理）━━
  // 协议推断规则:
  //   claude-*       → Anthropic 协议
  //   gemini-* / nanobanana → Gemini 官方协议
  //   其余（gpt-* / kimi-* / qwen-* / doubao-* / glm-* / minimax-* 等）→ OpenAI 兼容协议
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    providerId: 'local',
    contextWindow: 400000,
    supportsVision: true,
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    providerId: 'local',
    contextWindow: 400000,
    supportsVision: true,
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini-3.5-Flash',
    providerId: 'local',
    contextWindow: 1000000,
    supportsVision: true,
  },
];

// ==================== 常量 ====================

/** 未在注册表中找到模型时的默认上下文窗口大小 */
const DEFAULT_CONTEXT_WINDOW = 128000;

/** 配置文件名 */
const CONFIG_FILE_NAME = 'model-config.json';

/** 当前配置文件版本 */
const CONFIG_VERSION = 1;

/**
 * Built-in models whose generated reasoning shares the provider output budget.
 *
 * Keep this provider-scoped: the same model ID routed through a compatible local
 * endpoint does not necessarily expose or account for reasoning the same way.
 */
const SHARED_REASONING_OUTPUT_BUDGET_MODEL_ROUTES = [
  ['openai', 'gpt-5.4'],
  ['openai', 'gpt-5.4-mini'],
  ['openai', 'gpt-5.4-nano'],
  ['openai', 'gpt-5.5'],
  ['openai', 'gpt-5.6-luna'],
  ['openai', 'gpt-5.6-terra'],
  ['openai', 'gpt-5.6-sol'],
  ['anthropic', 'claude-sonnet-4-6'],
  ['anthropic', 'claude-sonnet-5'],
  ['anthropic', 'claude-opus-4-7'],
  ['anthropic', 'claude-opus-4-8'],
  ['anthropic', 'claude-fable-5'],
  ['gemini', 'gemini-3-flash-preview'],
  ['gemini', 'gemini-3.1-pro-preview'],
  ['gemini', 'gemini-3.5-flash'],
  ['zhipu', 'glm-5.1'],
  ['zhipu', 'glm-5.2'],
  ['stepfun', 'step-3.7-flash'],
  ['deepseek', 'deepseek-v4-pro'],
  ['deepseek', 'deepseek-v4-flash'],
  ['xiaomi-mimo', 'mimo-v2.5'],
  ['xiaomi-mimo', 'mimo-v2.5-pro'],
  ['zhipu-coding', 'GLM-5.1'],
  ['zhipu-coding', 'glm-5.2'],
  ['minimax', 'MiniMax-M3'],
  ['volcengine', 'deepseek-v4-flash'],
  ['volcengine', 'deepseek-v4-pro'],
  ['volcengine', 'kimi-k2.6'],
  ['volcengine', 'Kimi-K2.7-Code'],
  ['volcengine', 'MiniMax-M3'],
  ['volcengine', 'glm-5.2'],
  ['openrouter', 'xiaomi/mimo-v2.5'],
  ['openrouter', 'xiaomi/mimo-v2.5-pro'],
  ['openrouter', 'deepseek/deepseek-v4-pro'],
  ['openrouter', 'deepseek/deepseek-v4-flash'],
  ['openrouter', 'minimax/minimax-m3'],
  ['openrouter', 'z-ai/glm-5.2'],
  ['openrouter', 'moonshotai/kimi-k3'],
] as const;

function getModelRouteKey(providerId: string, modelId: string): string {
  return `${providerId.trim().toLowerCase()}::${modelId.trim().toLowerCase()}`;
}

/**
 * 可复用的推理档位集合。
 *
 * 这里只声明已验证为有效且行为互不重复的档位。未经验证的聚合路由、本地路由、
 * 用户自定义路由以及尚未验证的供应商路由都会回退为 recommended-only。
 */
const REASONING_PRESET_PROFILES = {
  recommendedOnly: ['recommended'],
  openAiXhigh: ['recommended', 'none', 'low', 'medium', 'high', 'xhigh'],
  openAiMax: ['recommended', 'none', 'low', 'medium', 'high', 'xhigh', 'max'],
  anthropicAdaptive: ['recommended', 'low', 'medium', 'high', 'xhigh', 'max'],
  anthropicSonnet46: ['recommended', 'low', 'medium', 'high', 'max'],
  geminiFlash: ['recommended', 'minimal', 'low', 'medium', 'high'],
  geminiPro: ['recommended', 'low', 'medium', 'high'],
  stepFun: ['recommended', 'low', 'medium', 'high'],
  toggle: ['recommended', 'none'],
  toggleHigh: ['recommended', 'none', 'high'],
  highMax: ['recommended', 'none', 'high', 'max'],
} as const satisfies Record<string, readonly ReasoningPreset[]>;

type ReasoningPresetProfileId = keyof typeof REASONING_PRESET_PROFILES;

/**
 * 推理能力必须绑定实际 provider/model 路由，不能只按模型 ID 推断。
 */
const REASONING_PRESET_MODEL_ROUTES = [
  ['openai', 'gpt-5.4', 'openAiXhigh'],
  ['openai', 'gpt-5.4-mini', 'openAiXhigh'],
  ['openai', 'gpt-5.4-nano', 'openAiXhigh'],
  ['openai', 'gpt-5.5', 'openAiXhigh'],
  ['openai', 'gpt-5.6-sol', 'openAiMax'],
  ['openai', 'gpt-5.6-terra', 'openAiMax'],
  ['openai', 'gpt-5.6-luna', 'openAiMax'],
  ['anthropic', 'claude-sonnet-4-6', 'anthropicSonnet46'],
  ['anthropic', 'claude-sonnet-5', 'anthropicAdaptive'],
  ['anthropic', 'claude-opus-4-7', 'anthropicAdaptive'],
  ['anthropic', 'claude-opus-4-8', 'anthropicAdaptive'],
  ['anthropic', 'claude-fable-5', 'anthropicAdaptive'],
  ['gemini', 'gemini-3-flash-preview', 'geminiFlash'],
  ['gemini', 'gemini-3.1-pro-preview', 'geminiPro'],
  ['gemini', 'gemini-3.5-flash', 'geminiFlash'],
  ['stepfun', 'step-3.7-flash', 'stepFun'],
  ['zhipu', 'glm-5.1', 'toggle'],
  ['zhipu', 'glm-5.2', 'highMax'],
  ['deepseek', 'deepseek-v4-pro', 'highMax'],
  ['deepseek', 'deepseek-v4-flash', 'highMax'],
  ['xiaomi-mimo', 'mimo-v2.5', 'toggleHigh'],
  ['xiaomi-mimo', 'mimo-v2.5-pro', 'toggleHigh'],
  ['zhipu-coding', 'GLM-5.1', 'toggle'],
  ['zhipu-coding', 'GLM-5.2', 'highMax'],
  ['minimax', 'MiniMax-M3', 'toggleHigh'],
  ['volcengine', 'deepseek-v4-flash', 'highMax'],
  ['volcengine', 'deepseek-v4-pro', 'highMax'],
  ['volcengine', 'kimi-k2.6,', 'toggle'],
  ['volcengine', 'Kimi-K2.7-Code', 'toggleHigh'],
  ['volcengine', 'glm-5.2', 'highMax'],
  ['openrouter', 'xiaomi/mimo-v2.5', 'toggle'],
  ['openrouter', 'xiaomi/mimo-v2.5-pro', 'toggle'],
  ['openrouter', 'deepseek/deepseek-v4-pro', 'highMax'],
  ['openrouter', 'deepseek/deepseek-v4-flash', 'highMax'],
  ['openrouter', 'z-ai/glm-5.2', 'highMax'],
] as const satisfies ReadonlyArray<readonly [string, string, ReasoningPresetProfileId]>;

const REASONING_PRESET_PROFILE_BY_MODEL_KEY = new Map<string, ReasoningPresetProfileId>(
  REASONING_PRESET_MODEL_ROUTES.map(([providerId, modelId, profileId]) => [
    getModelRouteKey(providerId, modelId),
    profileId,
  ])
);

const SHARED_REASONING_OUTPUT_BUDGET_MODEL_KEYS = new Set(
  SHARED_REASONING_OUTPUT_BUDGET_MODEL_ROUTES.map(([providerId, modelId]) =>
    getModelRouteKey(providerId, modelId)
  )
);

// ==================== 用户自定义模型（运行时状态） ====================

/**
 * 用户自定义模型缓存（运行时热数据）
 *
 * 从配置文件加载后缓存在内存中，避免每次查询都读磁盘。
 * 通过 loadUserModels / saveUserModels 与磁盘同步。
 */
let userModels: ModelDefinition[] = [];

/** 用户配置是否已从磁盘加载（防止重复加载） */
let userConfigLoaded = false;

/** 注册变更监听器，UI 组件通过此函数订阅模型列表变化 */
type ModelChangeListener = () => void;
const changeListeners: Set<ModelChangeListener> = new Set();

// ==================== 合并逻辑 ====================

/**
 * 获取合并后的模型列表
 *
 * 内置模型在前，用户自定义模型在后。
 * 如果用户模型的 (id + providerId) 与内置模型冲突，用户配置覆盖内置。
 */
function getMergedModels(): ModelDefinition[] {
  if (userModels.length === 0) return BUILTIN_MODELS;

  // 用户模型以 (id + providerId) 为键进行覆盖
  const userModelKeys = new Set(userModels.map((m) => `${m.id}::${m.providerId}`));

  // 过滤掉被用户自定义覆盖的内置模型
  const filteredBuiltin = BUILTIN_MODELS.filter(
    (m) => !userModelKeys.has(`${m.id}::${m.providerId}`)
  );

  return [...filteredBuiltin, ...userModels];
}

// ==================== 查询接口 ====================

/**
 * 获取所有供应商列表
 *
 * 返回内置供应商（顺序固定，对应 Rust 端路由）。
 */
export function getProviders(): ProviderDefinition[] {
  return BUILTIN_PROVIDERS;
}

/**
 * 获取供应商 ID 列表
 *
 * 常用于初始化 settingsStore 的 apiKeyConfigured。
 */
export function getProviderIds(): string[] {
  return BUILTIN_PROVIDERS.map((p) => p.id);
}

/**
 * 获取指定供应商下的所有模型
 *
 * 返回内置模型 + 用户自定义模型的合并结果。
 *
 * @param providerId - 供应商 ID
 * @returns 该供应商下的模型列表；供应商不存在时返回空数组
 */
export function getModelsByProvider(providerId: string): ModelDefinition[] {
  return getMergedModels().filter((m) => m.providerId === providerId);
}

/**
 * 获取指定供应商的默认模型 ID。
 *
 * 用于初始化设置和 provider 切换兜底，避免在各处散落具体模型 ID。
 */
export function getDefaultModelIdForProvider(providerId: string): string {
  return getModelsByProvider(providerId)[0]?.id ?? '';
}

/**
 * 获取模型的显示名称
 *
 * 查找注册表中的 name 字段，未找到时返回原始 modelId。
 * 同一模型 ID 可能存在于多个供应商中，
 * 返回第一个匹配的显示名称（显示名称通常相同）。
 */
export function getModelDisplayName(modelId: string): string {
  const model = getMergedModels().find((m) => m.id === modelId);
  return model?.name ?? modelId;
}

/**
 * 获取供应商的显示名称
 *
 * 查找注册表中的 name 字段，未找到时返回原始 providerId。
 */
export function getProviderDisplayName(providerId: string): string {
  const provider = BUILTIN_PROVIDERS.find((p) => p.id === providerId);
  return provider?.name ?? providerId;
}

/**
 * 获取模型的上下文窗口大小
 *
 * 查找注册表中的 contextWindow 值。
 * 同一模型 ID 可能存在于多个供应商中。调用方提供 providerId 时，
 * 仅使用完整路由匹配，避免把其他供应商的同名模型窗口用于当前调用。
 *
 * @param modelId - 模型 ID
 * @param providerId - 可选供应商 ID；已知实际路由时应始终传入
 * @returns 上下文窗口大小 (tokens)；未找到时返回默认值 128000
 */
export function getContextWindowSize(modelId: string, providerId?: string): number {
  const models = getMergedModels();
  const model = providerId
    ? models.find((m) => m.id === modelId && m.providerId === providerId)
    : models.find((m) => m.id === modelId);
  return model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * 查询模型是否支持视觉输入。
 *
 * 只有显式声明 supportsVision: true 时才允许传递图片。
 * 用户自定义模型默认按纯文本处理，避免误传 image_url 导致 API 报错。
 */
export function modelSupportsVision(modelId: string, providerId?: string): boolean {
  const models = getMergedModels();
  const model =
    models.find((m) => m.id === modelId && (!providerId || m.providerId === providerId)) ??
    models.find((m) => m.id === modelId);
  return model?.supportsVision === true;
}

/**
 * 返回指定供应商路由实际开放的推理档位。
 *
 * 未知、本地、未经验证的聚合路由以及尚未验证的供应商路由只返回 recommended，
 * 避免发送未经验证的参数。
 */
export function getSupportedReasoningPresets(
  providerId: string,
  modelId: string
): readonly ReasoningPreset[] {
  const profileId = REASONING_PRESET_PROFILE_BY_MODEL_KEY.get(
    getModelRouteKey(providerId, modelId)
  );
  return profileId
    ? REASONING_PRESET_PROFILES[profileId]
    : REASONING_PRESET_PROFILES.recommendedOnly;
}

/** 将无效或当前路由不支持的持久化值安全重置为 recommended。 */
export function normalizeReasoningPreset(
  providerId: string,
  modelId: string,
  preset: unknown
): ReasoningPreset {
  if (typeof preset !== 'string') return 'recommended';
  const supported = getSupportedReasoningPresets(providerId, modelId);
  return supported.includes(preset as ReasoningPreset)
    ? (preset as ReasoningPreset)
    : 'recommended';
}

/** 返回推理档位注册中已无法解析到内置模型的路由，供注册表不变量测试使用。 */
export function getUnregisteredReasoningPresetRoutes(): string[] {
  const builtinKeys = new Set(
    BUILTIN_MODELS.map((model) => getModelRouteKey(model.providerId, model.id))
  );
  return REASONING_PRESET_MODEL_ROUTES.flatMap(([providerId, modelId]) => {
    const routeKey = getModelRouteKey(providerId, modelId);
    return builtinKeys.has(routeKey) ? [] : [routeKey];
  });
}

/**
 * Whether the built-in provider/model route generates reasoning that consumes
 * the same transport output budget as the final response.
 */
export function modelUsesSharedReasoningOutputBudget(modelId: string, providerId: string): boolean {
  return SHARED_REASONING_OUTPUT_BUDGET_MODEL_KEYS.has(getModelRouteKey(providerId, modelId));
}

/**
 * Return shared-reasoning routes that no longer resolve to a built-in model.
 *
 * This is exposed for registry invariant tests so renamed model IDs cannot
 * silently fall back from the reasoning transport budget to the default one.
 */
export function getUnregisteredSharedReasoningOutputBudgetRoutes(): string[] {
  const builtinKeys = new Set(
    BUILTIN_MODELS.map((model) => getModelRouteKey(model.providerId, model.id))
  );
  return SHARED_REASONING_OUTPUT_BUDGET_MODEL_ROUTES.flatMap(([providerId, modelId]) => {
    const routeKey = getModelRouteKey(providerId, modelId);
    return builtinKeys.has(routeKey) ? [] : [routeKey];
  });
}

/**
 * 获取上下文窗口大小的完整映射表
 *
 * 兼容旧代码中 MODEL_CONTEXT_WINDOWS[modelKey] 的用法。
 * 包含 'default' 键作为兜底值。
 */
export function getContextWindowMap(): Record<string, number> {
  const map: Record<string, number> = { default: DEFAULT_CONTEXT_WINDOW };
  for (const model of getMergedModels()) {
    // 同一 ID 取第一个注册的值（先注册的优先）
    if (!(model.id in map)) {
      map[model.id] = model.contextWindow;
    }
  }
  return map;
}

/**
 * 获取供应商的 API Key 占位文字
 *
 * 用于 ApiKeySettings.tsx 的输入框 placeholder。
 */
export function getApiKeyPlaceholder(providerId: string): string {
  const provider = BUILTIN_PROVIDERS.find((p) => p.id === providerId);
  return provider?.apiKeyPlaceholder ?? 'API Key...';
}

/**
 * 校验供应商 ID 是否有效
 *
 * 用于运行时校验（替代编译期的联合类型约束）。
 */
export function isValidProvider(providerId: string): boolean {
  return BUILTIN_PROVIDERS.some((p) => p.id === providerId);
}

// ==================== 用户配置文件管理 ====================

/**
 * 获取配置文件存储路径
 *
 * 延迟导入 Tauri API，避免非 Tauri 环境（如测试）下的模块加载错误。
 */
async function getConfigFilePath(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const appData = await appDataDir();
  return join(appData, CONFIG_FILE_NAME);
}

/**
 * 从磁盘加载用户自定义模型配置
 *
 * 应用启动时调用一次。已加载则跳过。
 * 加载失败时静默降级为空列表（不影响内置模型使用）。
 */
export async function loadUserModels(): Promise<void> {
  if (userConfigLoaded) return;

  try {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
    const configPath = await getConfigFilePath();

    const fileExists = await exists(configPath);
    if (!fileExists) {
      userConfigLoaded = true;
      return;
    }

    const rawContent = await readTextFile(configPath);
    const config = JSON.parse(rawContent) as unknown as UserModelConfig;

    // 校验版本和基本结构
    if (config.version !== CONFIG_VERSION || !Array.isArray(config.models)) {
      console.warn('[ModelRegistry] 配置文件版本不匹配或格式错误，忽略用户配置');
      userConfigLoaded = true;
      return;
    }

    // 校验每个模型必须属于已知供应商
    const validProviderIds = new Set(BUILTIN_PROVIDERS.map((p) => p.id));
    const validModels = config.models.filter((m) => {
      if (!m.id || !m.name || !m.providerId || !m.contextWindow) {
        console.warn(`[ModelRegistry] 跳过无效模型配置: ${JSON.stringify(m)}`);
        return false;
      }
      if (!validProviderIds.has(m.providerId)) {
        console.warn(`[ModelRegistry] 跳过未知供应商的模型: ${m.id} (providerId: ${m.providerId})`);
        return false;
      }
      return true;
    });

    userModels = validModels;
    userConfigLoaded = true;
    console.log(`[ModelRegistry] 已加载 ${validModels.length} 个用户自定义模型`);
    notifyListeners();
  } catch (error) {
    // 加载失败时静默降级——不应阻塞应用启动
    console.warn('[ModelRegistry] 用户配置加载失败（降级为仅内置模型）:', error);
    userConfigLoaded = true;
  }
}

/**
 * 保存用户自定义模型到配置文件
 *
 * 将当前内存中的 userModels 写入 {appDataDir}/model-config.json
 */
export async function saveUserModels(): Promise<void> {
  try {
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const configPath = await getConfigFilePath();

    const config: UserModelConfig = {
      version: CONFIG_VERSION,
      models: userModels,
    };

    const content = JSON.stringify(config, null, 2);
    await writeTextFile(configPath, content);
    console.log(`[ModelRegistry] 已保存 ${userModels.length} 个用户自定义模型`);
  } catch (error) {
    console.error('[ModelRegistry] 保存用户配置失败:', error);
    throw new ModelConfigError('Failed to save model configuration', error);
  }
}

function normalizeUserModelDefinition(model: ModelDefinition): ModelDefinition {
  const id = model.id.trim();
  const name = model.name.trim();
  const providerId = model.providerId.trim();
  const contextWindow = Math.floor(model.contextWindow);

  if (!id || !name || !providerId || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new ModelConfigError('Invalid model definition');
  }
  if (!isValidProvider(providerId)) {
    throw new ModelConfigError(`Provider "${providerId}" does not exist`);
  }

  return {
    id,
    name,
    providerId,
    contextWindow,
    ...(model.supportsVision === true ? { supportsVision: true } : {}),
  };
}

function sameModelKey(
  a: { id: string; providerId: string },
  b: { id: string; providerId: string }
): boolean {
  return a.id === b.id && a.providerId === b.providerId;
}

/**
 * 查找当前注册表中指定 provider 下的模型（内置 + 用户自定义）。
 */
export function findRegisteredModel(
  modelId: string,
  providerId: string
): ModelDefinition | undefined {
  return getMergedModels().find((model) => model.id === modelId && model.providerId === providerId);
}

/**
 * 检查指定 provider 下是否已存在同 id 模型。
 */
export function hasRegisteredModel(modelId: string, providerId: string): boolean {
  return findRegisteredModel(modelId, providerId) !== undefined;
}

/**
 * 添加用户自定义模型。
 *
 * UI 新增模型时使用。与 JSON 导入不同，这里会拦截已存在的 (id + providerId)，
 * 避免用户误覆盖内置模型或已有自定义模型。
 */
export async function addUserModel(model: ModelDefinition): Promise<void> {
  const normalized = normalizeUserModelDefinition(model);

  if (hasRegisteredModel(normalized.id, normalized.providerId)) {
    throw new ModelConfigError('Model already exists');
  }

  userModels.push(normalized);
  await saveUserModels();
  notifyListeners();
}

/**
 * 更新用户自定义模型。
 *
 * 仅允许编辑用户自定义模型；若编辑后目标 (id + providerId) 已被其他模型占用则拒绝。
 */
export async function updateUserModel(
  originalModelId: string,
  originalProviderId: string,
  model: ModelDefinition
): Promise<void> {
  const normalized = normalizeUserModelDefinition(model);
  const originalKey = { id: originalModelId, providerId: originalProviderId };
  const index = userModels.findIndex((existing) => sameModelKey(existing, originalKey));

  if (index < 0) {
    throw new ModelConfigError('Custom model not found');
  }

  const duplicate = getMergedModels().some(
    (existing) => sameModelKey(existing, normalized) && !sameModelKey(existing, originalKey)
  );
  if (duplicate) {
    throw new ModelConfigError('Model already exists');
  }

  userModels[index] = normalized;
  await saveUserModels();
  notifyListeners();
}

/**
 * 导入外部 JSON 配置文件
 *
 * 解析并校验用户选择的 JSON 文件，合并到当前用户模型列表。
 * 同 (id + providerId) 的模型会被覆盖。
 *
 * @param jsonContent - JSON 文件内容（由 UI 层读取后传入）
 * @returns 成功导入的模型数量
 */
export async function importModelsFromJson(jsonContent: string): Promise<number> {
  const config = JSON.parse(jsonContent) as unknown as UserModelConfig;

  if (!config.version || !Array.isArray(config.models)) {
    throw new ModelConfigError(
      'Invalid configuration file format: missing version or models field'
    );
  }

  // 校验每个模型的必要字段和供应商有效性
  const validProviderIds = new Set(BUILTIN_PROVIDERS.map((p) => p.id));
  const validModels: ModelDefinition[] = [];
  const skippedReasons: string[] = [];

  for (const model of config.models) {
    if (!model.id || !model.name || !model.providerId || typeof model.contextWindow !== 'number') {
      skippedReasons.push(`${model.id}: missing required fields`);
      continue;
    }
    if (!validProviderIds.has(model.providerId)) {
      skippedReasons.push(`${model.id}: provider "${model.providerId}" does not exist`);
      continue;
    }
    validModels.push({
      id: model.id,
      name: model.name,
      providerId: model.providerId,
      contextWindow: model.contextWindow,
      ...(typeof model.supportsVision === 'boolean'
        ? { supportsVision: model.supportsVision }
        : {}),
    });
  }

  if (skippedReasons.length > 0) {
    console.warn('[ModelRegistry] 导入时跳过的模型:', skippedReasons);
  }

  if (validModels.length === 0) {
    throw new ModelConfigError('No valid model definitions found in the configuration file');
  }

  // 合并：同 (id + providerId) 覆盖，新增追加
  const existingKeys = new Set(userModels.map((m) => `${m.id}::${m.providerId}`));

  for (const newModel of validModels) {
    const key = `${newModel.id}::${newModel.providerId}`;
    if (existingKeys.has(key)) {
      // 覆盖已有的用户自定义模型
      const index = userModels.findIndex(
        (m) => m.id === newModel.id && m.providerId === newModel.providerId
      );
      if (index >= 0) {
        userModels[index] = newModel;
      }
    } else {
      userModels.push(newModel);
      existingKeys.add(key);
    }
  }

  await saveUserModels();
  notifyListeners();
  return validModels.length;
}

/**
 * 导出当前用户自定义模型为 JSON 字符串
 *
 * 仅包含用户自定义模型，不包含内置模型。
 */
export function exportUserModelsAsJson(): string {
  const config: UserModelConfig = {
    version: CONFIG_VERSION,
    models: userModels,
  };
  return JSON.stringify(config, null, 2);
}

/**
 * 获取用户自定义模型列表（仅用户添加的，不含内置）
 */
export function getUserModels(): ModelDefinition[] {
  return [...userModels];
}

/**
 * 删除指定的用户自定义模型
 *
 * @returns 是否成功删除（false 表示未找到）
 */
export async function removeUserModel(modelId: string, providerId: string): Promise<boolean> {
  const index = userModels.findIndex((m) => m.id === modelId && m.providerId === providerId);
  if (index < 0) return false;

  userModels.splice(index, 1);
  await saveUserModels();
  notifyListeners();
  return true;
}

/**
 * 重置用户配置（清除所有自定义模型）
 *
 * 删除配置文件并清空内存缓存。
 */
export async function resetUserModels(): Promise<void> {
  userModels = [];

  try {
    const { exists, remove } = await import('@tauri-apps/plugin-fs');
    const configPath = await getConfigFilePath();
    const fileExists = await exists(configPath);
    if (fileExists) {
      await remove(configPath);
    }
  } catch (error) {
    console.warn('[ModelRegistry] 删除配置文件失败（已清空内存）:', error);
  }

  notifyListeners();
}

/**
 * 检查用户是否有自定义模型配置
 */
export function hasUserModels(): boolean {
  return userModels.length > 0;
}

// ==================== 变更通知 ====================

/**
 * 订阅模型列表变更
 *
 * UI 组件可通过此函数在模型导入/删除/重置时触发重渲染。
 * 返回取消订阅函数。
 */
export function onModelsChange(listener: ModelChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** 通知所有监听器模型列表已变更 */
function notifyListeners(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch (error) {
      console.error('[ModelRegistry] 变更监听器执行失败:', error);
    }
  }
}

// ==================== 错误类型 ====================

/**
 * 模型配置错误
 *
 * 区别于通用 Error，便于 UI 层捕获并展示友好提示。
 */
export class ModelConfigError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ModelConfigError';
  }
}
