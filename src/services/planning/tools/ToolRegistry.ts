/**
 * ToolRegistry - 工具注册表
 *
 * 管理所有可用工具的注册、查询和 Schema 生成
 *
 * 设计理念：
 * - 单例模式，全局唯一
 * - 工具按名称注册，名称必须唯一
 * - 支持动态注册和按策略过滤（预留）
 */

import type { Tool, ToolSchema, IToolRegistry } from './types';
import { getLogger } from '@services/logger';

const logger = getLogger('ToolRegistry');

/**
 * 工具注册表实现
 */
class ToolRegistryImpl implements IToolRegistry {
    /** 工具存储 */
    private tools: Map<string, Tool> = new Map();

    /**
     * 注册工具
     *
     * @throws 如果工具名称已存在
     */
    register(tool: Tool): void {
        const name = tool.schema.name;
        if (this.tools.has(name)) {
            throw new Error(`[ToolRegistry] Tool "${name}" already exists. Check for duplicate registration.`);
        }
        this.tools.set(name, tool);
        logger.trace(`[ToolRegistry] 注册工具: ${name}`);
    }

    /**
     * 批量注册工具
     */
    registerAll(tools: Tool[]): void {
        for (const tool of tools) {
            this.register(tool);
        }
    }

    /**
     * 获取工具
     */
    get(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    /**
     * 获取所有工具
     */
    getAll(): Tool[] {
        return Array.from(this.tools.values());
    }

    /**
     * 获取所有工具的 Schema（用于 LLM 请求）
     */
    getSchemas(): ToolSchema[] {
        return this.getAll().map((tool) => tool.schema);
    }

    /**
     * 获取工具数量
     */
    get size(): number {
        return this.tools.size;
    }

    /**
     * 检查工具是否存在
     */
    has(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * 清除所有工具（仅用于测试）
     */
    clear(): void {
        this.tools.clear();
        logger.trace('[ToolRegistry] 已清除所有工具');
    }
}

/**
 * 工具注册表单例
 */
export const toolRegistry = new ToolRegistryImpl();

/**
 * 导出类型（用于类型标注）
 */
export type { IToolRegistry };
