/**
 * Skill 系统类型定义
 *
 * 定义 SKILL.md 文件解析后的类型系统
 * 用于将技能指导与工具执行逻辑解耦
 *
 * 设计理念：
 * - SKILL.md 定义技能的描述、使用场景、规则、示例
 * - Tool.execute() 负责具体执行逻辑
 * - SubAgentPromptBuilder / MasterBrainPrompt 从 SkillDefinition 动态生成规则
 */

import type {
  ExecutionContract,
  SkillAgentVisNetwork,
  SkillAgentVisNetworkEntrypoints,
  SkillDependencies,
} from './external/types';

// ==================== 元数据类型 ====================

/**
 * 技能类别
 */
export type SkillCategory =
  | 'file_operation' // 文件操作
  | 'search' // 搜索
  | 'execution' // 命令执行
  | 'external' // 外部扩展技能
  | 'custom'; // 自定义

/**
 * SKILL.md YAML frontmatter 元数据
 */
export interface SkillMetadata {
  /** 技能名称（必须与 Tool.schema.name 匹配） */
  name: string;
  /** 技能描述 */
  description: string;
  /** 技能类别 */
  category: SkillCategory;
  /** 复杂度评级 (1-5) */
  complexity: number;
  /** 是否需要授权 */
  requiresAuth: boolean;
  /** 版本号 */
  version?: string;
}

// ==================== 技能来源 ====================

/**
 * 技能来源类型
 *
 * - native: 内置技能（构建时嵌入）
 * - external: 外部扩展技能（运行时加载）
 */
export type SkillSource = 'native' | 'external';

// ==================== 完整技能定义 ====================

/**
 * 技能定义（SKILL.md 解析结果）
 *
 * 设计理念:
 * - 保留 SKILL.md 的完整 Markdown 格式
 * - 避免字段拆解和重组的复杂性
 * - 符合 Anthropic Skills 的 Progressive Disclosure 设计理念
 */
export interface SkillDefinition {
  /** 技能名称（必须与 Tool.schema.name 匹配） */
  name: string;
  /** 技能描述（用于判断何时使用此技能） */
  description: string;
  /** 技能类别 */
  category?: SkillCategory;
  /** 复杂度评级 (1-5) */
  complexity?: number;
  /** 是否需要授权 */
  requiresAuth?: boolean;
  /** 版本号 */
  version?: string;

  /** 工具使用规则（从 SKILL.md 解析，注入 Prompt 的规则列表） */
  guidance?: {
    rules: string[];
  };

  /** 完整的 Markdown 内容（YAML frontmatter 之后的所有内容） */
  fullContent: string;

  /**
   * [扩展字段] 技能来源
   *
   * 默认 'native'（向后兼容）。
   * External Skill 在注册时设置为 'external'。
   */
  source?: SkillSource;

  /**
   * [扩展字段] External Skill 运行模式
   *
   * 仅 source === 'external' 时有意义。
   * - guide: SKILL.md 是给 LLM 的使用指南
   * - script: SKILL.md 包含 Execution Contract
   */
  mode?: 'guide' | 'script';

  /**
   * [扩展字段] Script 模式 External Skill 的执行契约
   *
   * 仅 source === 'external' 且 mode === 'script' 时有意义。
   */
  contract?: ExecutionContract;

  /** AgentVis controlled networking package-level declaration. */
  agentvisNetwork?: SkillAgentVisNetwork;

  /** AgentVis controlled networking entrypoint-level declaration. */
  agentvisNetworkEntrypoints?: SkillAgentVisNetworkEntrypoints;

  /**
   * [扩展字段] External Skill 依赖声明
   *
   * 由外部技能包 frontmatter.dependencies 解析得到。
   */
  dependencies?: SkillDependencies;

  /**
   * [扩展字段] 技能包目录路径
   *
   * 仅 source === 'external' 时有意义。
   * 指向技能包在 packages/ 下的绝对路径。
   */
  packagePath?: string;

  /**
   * [扩展字段] 技能包内的脚本文件列表
   *
   * 仅 source === 'external' 且 mode === 'guide' 时有意义。
   * 存储相对于 packagePath 的脚本路径（如 scripts/convert_pdf_to_images.py）。
   */
  scriptFiles?: string[];

  /**
   * [扩展字段] 技能包内的资源文件列表
   *
   * 仅 source === 'external' 且 mode === 'guide' 时有意义。
   * 存储相对于 packagePath 的资源文件路径（如 themes/arctic-frost.md）。
   */
  resourceFiles?: string[];
}

/**
 * Skill 加载器接口
 */
export interface ISkillLoader {
  /**
   * 加载单个技能
   * @param skillName 技能名称（对应 skills/${skillName}/SKILL.md）
   */
  loadSkill(skillName: string): Promise<SkillDefinition>;

  /**
   * 加载所有技能
   */
  loadAllSkills(): Promise<SkillDefinition[]>;

  /**
   * 按类别获取技能
   */
  getByCategory(category: SkillCategory): Promise<SkillDefinition[]>;

  /**
   * 刷新缓存
   */
  refresh(): Promise<void>;
}
