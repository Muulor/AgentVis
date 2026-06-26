/**
 * ToolRiskGuard - 工具风险等级安全守卫
 *
 * 基于工具风险等级的安全兜底，替代原来基于 Agent 类型的工具策略。
 *
 * 设计原则：
 * - 不再将工具权限与 Sub-Agent 类型绑定
 * - MasterBrain 动态决定工具授权，安全层基于工具自身风险
 * - 支持运行时自定义风险等级
 */



// ═══════════════════════════════════════════════════════════════
// 风险等级定义
// ═══════════════════════════════════════════════════════════════

/**
 * 工具风险等级
 *
 * - low: 只读操作，无副作用
 * - medium: 写入操作，有 fast apply 回滚兜底
 * - high: 系统命令执行，可能有不可逆副作用
 */
export type ToolRiskLevel = 'low' | 'medium' | 'high';

/**
 * 工具风险注册表
 *
 * 定义每个 native 工具的风险等级。
 * 外部工具和未注册工具默认为 medium。
 */
export const TOOL_RISK_REGISTRY: Record<string, ToolRiskLevel> = {
    read: 'low',
    web_search: 'low',
    file_write: 'medium',
    exec: 'high',
    // 图像生成仅保存到 deliverables 目录，无不可逆副作用
    generate_image: 'low',
    local_search: 'low',
    im_send: 'low',
    feishu_send: 'low',
    slack_send: 'low',
    // 定时任务管理：能自动定期触发 Agent 执行（间接产生 LLM 调用开销），但操作可撤销
    cron: 'medium',
    // 外部 Script Skill 会执行技能包脚本，风险等级按命令执行处理
    external_skill_execute: 'high',
};

/** 未注册工具的默认风险等级 */
export const DEFAULT_TOOL_RISK: ToolRiskLevel = 'medium';

// ═══════════════════════════════════════════════════════════════
// 验证结果类型
// ═══════════════════════════════════════════════════════════════

/**
 * 工具列表验证结果
 */
export interface ToolListValidation {
    /** 未注册的工具（警告，不阻止） */
    unknownTools: string[];
    /** 高风险工具列表 */
    highRiskTools: string[];
}

// ═══════════════════════════════════════════════════════════════
// 守卫器类
// ═══════════════════════════════════════════════════════════════

/**
 * 工具风险守卫器
 *
 * 提供基于工具风险等级的安全检查功能。
 * 不再与 Sub-Agent 类型绑定，统一基于工具自身特性。
 */
export class ToolRiskGuard {
    private customRisks: Map<string, ToolRiskLevel> = new Map();

    /**
     * 查询工具风险等级
     */
    getToolRisk(toolName: string): ToolRiskLevel {
        // 优先使用自定义风险等级
        const custom = this.customRisks.get(toolName);
        if (custom) {
            return custom;
        }
        return TOOL_RISK_REGISTRY[toolName] ?? DEFAULT_TOOL_RISK;
    }

    /**
     * 设置自定义风险等级
     */
    setCustomRisk(toolName: string, risk: ToolRiskLevel): void {
        this.customRisks.set(toolName, risk);
    }

    /**
     * 清除自定义风险等级
     */
    clearCustomRisk(toolName: string): void {
        this.customRisks.delete(toolName);
    }

    /**
     * 验证工具列表（警告未注册工具，不阻止执行）
     */
    validateToolList(toolNames: string[]): ToolListValidation {
        const unknownTools: string[] = [];
        const highRiskTools: string[] = [];

        for (const toolName of toolNames) {
            // 检查是否为已注册工具
            if (!(toolName in TOOL_RISK_REGISTRY) && !this.customRisks.has(toolName)) {
                unknownTools.push(toolName);
            }

            // 检查是否为高风险工具
            if (this.getToolRisk(toolName) === 'high') {
                highRiskTools.push(toolName);
            }
        }

        return { unknownTools, highRiskTools };
    }

    /**
     * 返回列表中的高风险工具
     */
    getHighRiskTools(toolNames: string[]): string[] {
        return toolNames.filter(name => this.getToolRisk(name) === 'high');
    }

    /**
     * 判断工具调用前是否需要 Checkpoint
     *
     * 高风险工具需要在执行前触发 Checkpoint
     */
    requiresCheckpoint(toolName: string): boolean {
        return this.getToolRisk(toolName) === 'high';
    }

    /**
     * 获取所有已注册工具的风险映射
     */
    getAllRisks(): Record<string, ToolRiskLevel> {
        const result = { ...TOOL_RISK_REGISTRY };
        for (const [name, risk] of this.customRisks) {
            result[name] = risk;
        }
        return result;
    }
}

/**
 * 工具风险守卫器单例
 */
export const toolRiskGuard = new ToolRiskGuard();
