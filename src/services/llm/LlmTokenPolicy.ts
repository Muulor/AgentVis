/**
 * LlmTokenPolicy - 按 LLM 调用场景集中管理输出 token 预算。
 *
 * 场景策略描述产品期望的输出预算；模型自身的硬上限由模型能力配置单独约束。
 */

export interface LlmTokenPolicy {
  readonly primaryMaxTokens: number;
  readonly parameterFallbackMaxTokens?: number;
}

/** 通用 LLM 场景的首选输出预算。 */
export const DEFAULT_OUTPUT_MAX_TOKENS = 32_768;

/** Provider 拒绝 32K 参数时使用的兼容基线。 */
export const SAFE_COMPATIBLE_OUTPUT_MAX_TOKENS = 24_576;

export const LLM_TOKEN_POLICIES = {
  safeCompatibleOutput: {
    primaryMaxTokens: SAFE_COMPATIBLE_OUTPUT_MAX_TOKENS,
  },
  chat: {
    primaryMaxTokens: DEFAULT_OUTPUT_MAX_TOKENS,
  },
  memory: {
    primaryMaxTokens: DEFAULT_OUTPUT_MAX_TOKENS,
  },
  visualEnhancer: {
    primaryMaxTokens: DEFAULT_OUTPUT_MAX_TOKENS,
  },
  subAgent: {
    primaryMaxTokens: DEFAULT_OUTPUT_MAX_TOKENS,
    parameterFallbackMaxTokens: SAFE_COMPATIBLE_OUTPUT_MAX_TOKENS,
  },
  skillAudit: {
    primaryMaxTokens: SAFE_COMPATIBLE_OUTPUT_MAX_TOKENS,
  },
  imageGeneration: {
    primaryMaxTokens: DEFAULT_OUTPUT_MAX_TOKENS,
  },
} as const satisfies Record<string, LlmTokenPolicy>;

export type LlmTokenPolicyPurpose = keyof typeof LLM_TOKEN_POLICIES;

export function getLlmTokenPolicy(purpose: LlmTokenPolicyPurpose): LlmTokenPolicy {
  return LLM_TOKEN_POLICIES[purpose];
}
