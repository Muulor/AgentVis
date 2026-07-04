import { create } from 'zustand';

export type AgentSandboxMode = 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';

/**
 * Agent 类型定义
 * 注意：字段名需与Rust端AgentItem结构体保持一致（使用camelCase）
 */
interface Agent {
    id: string;
    hubId: string;  // 对应Rust的hub_id，serde自动转为hubId
    name: string;
    sortOrder?: number;
    avatarColor: string | null;  // 对应Rust的avatar_color
    avatar?: string | null;  // base64 编码的自定义头像
    modelProvider: string | null;  // 对应Rust的model_provider
    modelName: string | null;  // 对应Rust的model_name
    mbRulesFilePath: string | null;  // 对应Rust的mb_rules_file_path，Master Brain 专属 rules
    saRulesFilePath: string | null;  // 对应Rust的sa_rules_file_path，Sub-Agent 专属 rules
    mbRules: string | null;  // 对应Rust的mb_rules，Master Agent 粘贴式 rules
    saRules: string | null;  // 对应Rust的sa_rules，Sub-Agent 粘贴式 rules
    chatRules: string | null;  // 对应Rust的chat_rules，Chat 模式专属 rules
    knowledgePaths: string | null;  // 对应Rust的knowledge_paths (JSON数组)
    autoIndexDeliverables?: boolean | null;  // 对应Rust的auto_index_deliverables，交付物自动索引开关
    visualEnhancementEnabled?: boolean | null;  // 对应Rust的visual_enhancement_enabled，Planning最终回复可视化增强开关
    pinnedSkills?: string | null;  // 对应Rust的pinned_skills，精准命中技能列表（JSON数组）
    /** MB 最大决策轮次，null 时使用全局默认值（LOOP_GOVERNOR_INITIAL_BUDGET） */
    planningLoopBudget?: number | null;  // 对应Rust的planning_loop_budget
    /** 用户关联的外部项目路径（用户在授权弹窗确认后 Agent 具有全权限），null 表示未关联 */
    projectPath?: string | null;  // 对应Rust的project_path
    sandboxMode?: AgentSandboxMode | null;  // 对应Rust的sandbox_mode
    subAgentSafetyFooterEnabled?: boolean | null;  // 对应Rust的sub_agent_safety_footer_enabled
    subAgentSafetyFooterText?: string | null;  // 对应Rust的sub_agent_safety_footer_text
    createdAt: number;  // 对应Rust的created_at，类型为i64
    updatedAt: number;  // 对应Rust的updated_at，类型为i64
}

/**
 * Agent 状态类型
 */
interface AgentState {
    // 数据
    agents: Agent[];
    currentAgentId: string | null;

    /**
     * 跨 hub 的 agentId → hubId 映射（只增不清空）
     * 用途：切换 hub 后 agents 数组会被替换，但此 Map 保留所有曾加载过的
     * agent 的归属信息，供 HubTabs 未读圆点计算使用。
     */
    agentHubMap: Map<string, string>;

    // 加载状态
    isLoading: boolean;
    error: string | null;

    // Actions
    setAgents: (agents: Agent[]) => void;
    addAgent: (agent: Agent) => void;
    updateAgent: (id: string, data: Partial<Agent>) => void;
    reorderAgents: (hubId: string, orderedIds: string[]) => void;
    removeAgent: (id: string) => void;
    setCurrentAgentId: (id: string | null) => void;
    setLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;

    // 选择器
    getAgentsByHubId: (hubId: string) => Agent[];
}

/**
 * Agent Store - 管理 Agent 列表和当前选中的 Agent
 *
 * 将与 Tauri Commands 集成实现持久化
 */
export const useAgentStore = create<AgentState>((set, get) => ({
    // 初始状态
    agents: [],
    currentAgentId: null,
    agentHubMap: new Map<string, string>(),
    isLoading: false,
    error: null,

    // Actions
    setAgents: (agents) => set((state) => {
        // 合并更新 agentHubMap，保留已加载过的其他 hub 的映射关系
        const newMap = new Map(state.agentHubMap);
        for (const agent of agents) {
            newMap.set(agent.id, agent.hubId);
        }
        return { agents, agentHubMap: newMap };
    }),
    addAgent: (agent) => set((state) => ({
        agents: [...state.agents, agent],
        // 新建 agent 时同步写入 map
        agentHubMap: new Map(state.agentHubMap).set(agent.id, agent.hubId),
    })),
    updateAgent: (id, data) =>
        set((state) => ({
            agents: state.agents.map((a) => (a.id === id ? { ...a, ...data } : a)),
        })),
    reorderAgents: (hubId, orderedIds) =>
        set((state) => {
            const agentsById = new Map(state.agents.map((agent) => [agent.id, agent]));
            const orderedAgents = orderedIds
                .map<Agent | null>((id, sortOrder) => {
                    const agent = agentsById.get(id);
                    return agent?.hubId === hubId ? { ...agent, sortOrder } : null;
                })
                .filter((agent): agent is Agent => agent !== null);
            let cursor = 0;

            return {
                agents: state.agents.map((agent) => {
                    if (agent.hubId !== hubId) return agent;
                    const nextAgent = orderedAgents[cursor];
                    cursor += 1;
                    return nextAgent ?? agent;
                }),
            };
        }),
    removeAgent: (id) =>
        set((state) => {
            const newMap = new Map(state.agentHubMap);
            newMap.delete(id);
            return {
                agents: state.agents.filter((a) => a.id !== id),
                currentAgentId: state.currentAgentId === id ? null : state.currentAgentId,
                agentHubMap: newMap,
            };
        }),
    setCurrentAgentId: (id) => set({ currentAgentId: id }),
    setLoading: (loading) => set({ isLoading: loading }),
    setError: (error) => set({ error }),

    // 选择器
    getAgentsByHubId: (hubId) => get().agents.filter((a) => a.hubId === hubId),
}));
