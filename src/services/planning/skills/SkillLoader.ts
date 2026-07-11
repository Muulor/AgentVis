/**
 * SkillLoader - SKILL.md 构建时加载器
 *
 * 使用 Vite 的 import.meta.glob 在构建时加载 SKILL.md 文件
 * 避免了运行时文件系统访问的问题
 *
 * 设计理念：
 * - 构建时加载，无需运行时文件访问
 * - 缓存机制，避免重复解析
 * - 同步初始化，简化调用方
 */

import type { SkillDefinition, SkillMetadata, SkillCategory, ISkillLoader } from './types';
import { getLogger } from '@services/logger';

const logger = getLogger('SkillLoader');

// ==================== 外部技能懒加载 ====================

/**
 * 模块级 Promise 缓存，确保 bootstrapExternalSkills 只执行一次
 *
 * 为什么不直接调用 bootstrapExternalSkills()：
 * - loadAllSkills 可能被多个地方并发调用
 * - Promise 缓存保证 bootstrap 只触发一次，后续调用复用同一 Promise
 */
let externalSkillsInitPromise: Promise<void> | null = null;

function externalSkillsInitOnce(): Promise<void> {
  // 使用动态 import 避免循环依赖（Bootstrap → SkillLoader → Bootstrap）
  externalSkillsInitPromise ??= import('./external/ExternalSkillBootstrap')
    .then(({ bootstrapExternalSkills }) => bootstrapExternalSkills())
    .catch((error: unknown) => {
      logger.warn('[SkillLoader] 外部技能初始化失败:', error);
    });
  return externalSkillsInitPromise;
}

/**
 * 使用 Vite 的 import.meta.glob 在构建时加载所有 SKILL.md 文件
 * { eager: true } 表示同步加载（构建时嵌入）
 * { query: '?raw' } 表示以原始字符串形式导入
 */
const skillModules = import.meta.glob<string>('./**/SKILL.md', {
  eager: true,
  query: '?raw',
  import: 'default',
});

// ==================== 常量 ====================

/** frontmatter 分隔符 */
const FRONTMATTER_DELIMITER = '---';

// ==================== 辅助函数 ====================

/**
 * 解析 YAML frontmatter
 * 简化实现，仅支持基本的 key: value 和数组格式
 */
function parseFrontmatter(content: string): { metadata: Partial<SkillMetadata>; body: string } {
  const lines = content.split('\n');
  let inFrontmatter = false;
  let frontmatterEnd = 0;
  const frontmatterLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';

    if (line === FRONTMATTER_DELIMITER) {
      if (!inFrontmatter) {
        inFrontmatter = true;
      } else {
        frontmatterEnd = i + 1;
        break;
      }
    } else if (inFrontmatter) {
      frontmatterLines.push(lines[i] ?? '');
    }
  }

  const metadata: Partial<SkillMetadata> = {};

  for (const line of frontmatterLines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    // 处理数组格式 [item1, item2]
    if (value.startsWith('[') && value.endsWith(']')) {
      const arrayContent = value.slice(1, -1);
      const arrayValue = arrayContent
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      (metadata as Record<string, unknown>)[key] = arrayValue;
    }
    // 处理布尔值
    else if (value === 'true') {
      (metadata as Record<string, unknown>)[key] = true;
    } else if (value === 'false') {
      (metadata as Record<string, unknown>)[key] = false;
    }
    // 处理数字
    else if (!isNaN(Number(value))) {
      (metadata as Record<string, unknown>)[key] = Number(value);
    }
    // 处理字符串
    else {
      (metadata as Record<string, unknown>)[key] = value;
    }
  }

  const body = lines.slice(frontmatterEnd).join('\n');

  return { metadata, body };
}

/**
 * 从模块路径提取技能名称
 * 例如: './edit/SKILL.md' -> 'edit'
 */
function extractSkillName(modulePath: string): string {
  const match = modulePath.match(/\.\/([^/]+)\/SKILL\.md$/);
  return match?.[1] ?? 'unknown';
}

/**
 * 解析 SKILL.md 内容
 */
function parseSkillContent(content: string, skillName: string): SkillDefinition {
  const { metadata, body } = parseFrontmatter(content);

  return {
    name: metadata.name ?? skillName,
    description: metadata.description ?? '',
    category: metadata.category ?? 'custom',
    complexity: metadata.complexity ?? 1,
    requiresAuth: metadata.requiresAuth ?? false,
    version: metadata.version,
    fullContent: body.trim(), // 保留完整 markdown!
  };
}

// ==================== SkillLoader 实现 ====================

class SkillLoaderImpl implements ISkillLoader {
  /** Native 技能缓存（构建时嵌入） */
  private cache: Map<string, SkillDefinition> = new Map();

  /** External 技能缓存（运行时注册） */
  private externalSkills: Map<string, SkillDefinition> = new Map();

  /** 是否已初始化 */
  private initialized = false;

  constructor() {
    // 在构造时立即解析所有 SKILL.md
    this.initialize();
  }

  /**
   * 初始化：解析所有已加载的 SKILL.md
   */
  private initialize(): void {
    if (this.initialized) return;

    const moduleEntries = Object.entries(skillModules);
    logger.trace(`[SkillLoader] 发现 ${moduleEntries.length} 个 SKILL.md 文件`);

    for (const [path, content] of moduleEntries) {
      try {
        const skillName = extractSkillName(path);
        const skill = parseSkillContent(content, skillName);
        this.cache.set(skillName, skill);
        logger.trace(`[SkillLoader] 已解析技能: ${skillName}`);
      } catch (error) {
        logger.error(`[SkillLoader] 解析失败: ${path}`, error);
      }
    }

    this.initialized = true;
    logger.trace(`[SkillLoader] 初始化完成，共 ${this.cache.size} 个技能`);
  }

  /**
   * 注册外部技能（由 ExternalSkillRegistry 调用）
   *
   * 将 External Skill 注入 SkillLoader 的缓存中，
   * 使其可以通过统一的接口被查询到。
   */
  registerExternal(skill: SkillDefinition): void {
    this.externalSkills.set(skill.name, skill);
    logger.trace(
      `[SkillLoader] 注册外部技能: ${skill.name}` + ` (${skill.mode ?? 'unknown'} 模式)`
    );
  }

  /**
   * 清空外部技能缓存（rescan 前调用）
   *
   * 确保删除技能包后，SkillLoader 不再保留已删除技能的引用。
   * scanAndRegister() 会在清空后重新注册所有仍存在的技能。
   */
  clearExternalSkills(): void {
    this.externalSkills.clear();
    logger.trace('[SkillLoader] 已清空外部技能缓存');
  }

  /**
   * 加载单个技能（同步返回缓存）
   */
  loadSkill(skillName: string): Promise<SkillDefinition> {
    // Native 优先
    const cached = this.cache.get(skillName);
    if (cached) return Promise.resolve(cached);

    // 然后查找 External
    const external = this.externalSkills.get(skillName);
    if (external) return Promise.resolve(external);

    // 返回默认的空技能定义
    return Promise.resolve(this.createDefaultSkill(skillName));
  }

  /**
   * 加载所有技能（Native + External 合并）
   *
   * 首次调用时触发外部技能懒加载（bootstrapExternalSkills）
   */
  async loadAllSkills(): Promise<SkillDefinition[]> {
    // 懒加载外部技能（首次调用时触发，后续幂等）
    await externalSkillsInitOnce();

    return [...this.cache.values(), ...this.externalSkills.values()];
  }

  /**
   * 按类别获取技能
   */
  async getByCategory(category: SkillCategory): Promise<SkillDefinition[]> {
    const all = await this.loadAllSkills();
    return all.filter((s) => s.category === category);
  }

  /**
   * 刷新缓存（重新解析 Native，保留 External）
   */
  refresh(): Promise<void> {
    this.cache.clear();
    this.initialized = false;
    this.initialize();
    // 注意：external skills 不清理，因为它们在冒启动时注册，刷新不影响
    return Promise.resolve();
  }

  /**
   * 获取所有技能（同步版本，Native + External）
   */
  getAllSync(): SkillDefinition[] {
    return [...this.cache.values(), ...this.externalSkills.values()];
  }

  /**
   * 获取所有 Guide 模式的 External Skill
   *
   * 用于 SubAgentPromptBuilder 将 Guide 内容注入 Prompt
   */
  getExternalGuideSkills(): SkillDefinition[] {
    return Array.from(this.externalSkills.values()).filter((s) => s.mode === 'guide');
  }

  /**
   * 获取所有 Script 模式的 External Skill
   *
   * 用于 external_skill_execute 工具和 MB/SA Script Skill 目录注入。
   */
  getExternalScriptSkills(): SkillDefinition[] {
    return Array.from(this.externalSkills.values()).filter(
      (s) => s.mode === 'script' && !!s.contract
    );
  }

  /**
   * 按名称获取 Script 模式的 External Skill
   */
  getExternalScriptSkill(name: string): SkillDefinition | undefined {
    const skill = this.externalSkills.get(name);
    if (skill?.mode === 'script' && skill.contract) {
      return skill;
    }
    return undefined;
  }

  /**
   * 创建默认技能定义
   */
  private createDefaultSkill(skillName: string): SkillDefinition {
    return {
      name: skillName,
      description: `${skillName} tool`,
      category: 'custom',
      complexity: 1,
      requiresAuth: false,
      fullContent: `# ${skillName}\n\nNo detailed documentation is available for this tool yet.`,
    };
  }
}

/**
 * 导出单例
 */
export const skillLoader = new SkillLoaderImpl();
