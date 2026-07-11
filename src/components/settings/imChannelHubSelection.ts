/**
 * IM 通道 Hub 选择辅助逻辑
 *
 * 用于在单 Hub 场景下为 Bot 自动归属默认 Hub，同时避免多 Hub 场景下
 * 擅自替用户选择目标路由。
 */

interface HubOption {
  id: string;
}

interface AgentOption {
  id: string;
}

export type MissingAgentAction = 'none' | 'reload' | 'clear';

/**
 * 根据当前 Hub 列表解析 Bot 应使用的有效 Hub ID。
 *
 * - 已配置的 Hub 仍存在：沿用配置
 * - 只有一个 Hub 且配置为空/失效：自动使用唯一 Hub
 * - 没有 Hub 或多个 Hub 且配置为空/失效：返回 null，等待用户显式选择
 */
export function resolveImBotHubId(
  configuredHubId: string | null,
  hubs: readonly HubOption[]
): string | null {
  if (configuredHubId && hubs.some((hub) => hub.id === configuredHubId)) {
    return configuredHubId;
  }

  if (hubs.length === 1) {
    return hubs[0]?.id ?? null;
  }

  return null;
}

/**
 * 只有从一个明确 Hub 切到另一个有效状态时才清空 Agent。
 *
 * 配置为空时自动补全唯一 Hub 不应清空已有 agentId，便于旧数据迁移后
 * 在单 Hub 场景保留原绑定。
 */
export function shouldClearAgentAfterHubResolve(
  configuredHubId: string | null,
  resolvedHubId: string | null
): boolean {
  return configuredHubId !== null && configuredHubId !== resolvedHubId;
}

export function getMissingAgentReloadKey(hubId: string, agentId: string): string {
  return `${hubId}:${agentId}`;
}

/**
 * 解析当前已选 Agent 不在已加载列表中时应采取的动作。
 *
 * 当前 Hub 列表尚未加载时不处理缺失，由外层加载逻辑负责；列表已加载后，
 * 若 Agent 仍缺失，则先重载一次列表，第二次仍缺失才清空 agentId。
 */
export function resolveMissingAgentAction(params: {
  agentId: string | null;
  currentHubId: string | null;
  lastLoadedHubId: string | null;
  agents: readonly AgentOption[];
  lastMissingAgentReloadKey: string | null;
}): MissingAgentAction {
  const { agentId, currentHubId, lastLoadedHubId, agents, lastMissingAgentReloadKey } = params;

  if (!agentId || !currentHubId || lastLoadedHubId !== currentHubId) {
    return 'none';
  }

  if (agents.some((agent) => agent.id === agentId)) {
    return 'none';
  }

  return lastMissingAgentReloadKey === getMissingAgentReloadKey(currentHubId, agentId)
    ? 'clear'
    : 'reload';
}
