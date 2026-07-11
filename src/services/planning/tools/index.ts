/**
 * Tools 模块入口
 *
 * 导出所有工具和注册表，并完成工具注册
 *
 * 架构说明：
 * - 工具实现已迁移到 skills/ 目录
 * - 每个技能目录包含 SKILL.md（技能定义）和 tool.ts（工具实现）
 * - 此文件作为统一入口保持向后兼容
 */

// ==================== 类型导出 ====================
export type {
  Tool,
  ToolSchema,
  ToolParameterSchema,
  ToolPropertySchema,
  ToolResult,
  ToolExecutionContext,
  ToolCall,
  LLMResponseType,
  IToolRegistry,
} from './types';

// ==================== 工具注册表 ====================
export { toolRegistry } from './ToolRegistry';

// ==================== 工具导出（从 skills 目录导入） ====================
export { readTool } from '../skills/read/tool';
export { fileWriteTool } from '../skills/file_write/tool';
export { webSearchTool } from '../skills/web_search/tool';
export { execTool } from '../skills/exec/tool';
export { generateImageTool } from '../skills/generate_image/tool';
export { cronTool } from '../skills/cron/tool';
export { localSearchTool } from '../skills/local_search/tool';
export { conversationSearchTool } from '../skills/conversation_search/tool';
export { imSendTool } from '../skills/im_send/tool';
export { feishuSendTool } from '../skills/feishu_send/tool';
export { slackSendTool } from '../skills/slack_send/tool';
export { externalSkillExecuteTool } from '../skills/external_skill_execute/tool';

// ==================== 工具注册 ====================
import { toolRegistry } from './ToolRegistry';
import { readTool } from '../skills/read/tool';
import { fileWriteTool } from '../skills/file_write/tool';
import { webSearchTool } from '../skills/web_search/tool';
import { execTool } from '../skills/exec/tool';
import { generateImageTool } from '../skills/generate_image/tool';
import { cronTool } from '../skills/cron/tool';
import { localSearchTool } from '../skills/local_search/tool';
import { conversationSearchTool } from '../skills/conversation_search/tool';
import { imSendTool } from '../skills/im_send/tool';
import { externalSkillExecuteTool } from '../skills/external_skill_execute/tool';
import { getLogger } from '@services/logger';

const logger = getLogger('index');

/**
 * 初始化工具注册表
 *
 * 注册所有内置工具
 *
 * 注意：file_write 是统一的文件工具，已替代 write + edit
 */
export function initializeTools(): void {
  // 避免重复注册
  if (toolRegistry.size > 0) {
    logger.trace('[Tools] 工具已注册，跳过初始化');
    return;
  }

  toolRegistry.registerAll([
    readTool,
    fileWriteTool, // 统一文件工具（替代 write + edit）
    webSearchTool,
    execTool,
    generateImageTool,
    cronTool,
    localSearchTool,
    conversationSearchTool,
    imSendTool, // 统一 IM 原生发送工具（飞书/Slack）
    externalSkillExecuteTool,
  ]);

  logger.trace(`[Tools] 初始化完成，共注册 ${toolRegistry.size} 个工具`);
}
