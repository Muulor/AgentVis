/**
 * ExternalSkillRegistry - 外部技能包注册表
 *
 * 负责在冷启动时扫描 registry.yaml、加载和验证技能包、
 * 检测技能模式（Guide / Script）。
 *
 * 设计理念：
 * - 只在启动时加载一次，运行时不变
 * - 双模式自动检测：有 execution.entry → Script，否则 → Guide
 * - 验证失败的技能包跳过加载而非阻断启动
 * - 依赖注入文件读取函数，便于测试
 */

import type {
  ExternalSkillRegistry as RegistryConfig,
  ExternalSkillEntry,
  ExternalSkillFrontmatter,
  LoadedExternalSkill,
  SkillAgentVisNetwork,
  SkillAgentVisNetworkEntrypoints,
  SkillAgentVisNetworkEntrypointMode,
  SkillMode,
} from './types';
import { REGISTRY_VERSION, NATIVE_SKILL_NAMES } from './types';
import { validateContract, isValidSkillName } from './ContractValidator';
import { getLogger } from '@services/logger';

const logger = getLogger('ExternalSkillRegistry');

// ==================== 文件读取接口 ====================

/**
 * 文件读取函数签名
 *
 * 通过依赖注入避免直接依赖文件系统 / Tauri API
 */
export type FileReadFn = (path: string) => Promise<string>;

/**
 * 目录是否存在的检查函数签名
 */
export type DirExistsFn = (path: string) => Promise<boolean>;

/**
 * 列出目录下文件名列表的函数签名
 *
 * 用于脚本文件扫描（检测技能包是否含可执行脚本）
 */
export type ListFilesFn = (dirPath: string) => Promise<string[]>;

// ==================== 加载结果类型 ====================

/**
 * 注册表加载结果
 */
export interface RegistryLoadResult {
  /** 成功加载的技能列表 */
  skills: LoadedExternalSkill[];
  /** 加载过程中的警告/错误信息 */
  warnings: string[];
}

// ==================== ExternalSkillRegistryLoader 实现 ====================

/**
 * 外部技能包注册表加载器
 *
 * 职责：
 * 1. 解析 registry.yaml
 * 2. 遍历每个已注册且启用的技能包
 * 3. 读取并解析 SKILL.md
 * 4. 自动检测技能模式（Guide / Script）
 * 5. Script 模式下验证 Execution Contract
 * 6. 返回所有成功加载的 LoadedExternalSkill
 */
export class ExternalSkillRegistryLoader {
  private readonly packagesDir: string;
  private readonly readFile: FileReadFn;
  private readonly dirExists: DirExistsFn;
  private readonly listFiles: ListFilesFn;

  /** 脚本文件扫描的扩展名 */
  private static readonly SCRIPT_EXTENSIONS = new Set(['.py', '.sh', '.js', '.ts']);

  /** 资源文件扩展名（非脚本的文档/数据文件，SA 可通过 read 工具读取） */
  private static readonly RESOURCE_EXTENSIONS = new Set([
    '.md',
    '.pdf',
    '.txt',
    '.json',
    '.yaml',
    '.yml',
    '.csv',
    '.html',
    '.css',
  ]);

  /** 资源文件扫描时排除的文件名（大小写不敏感匹配） */
  private static readonly RESOURCE_EXCLUDE_FILES = new Set(['skill.md']);

  /**
   * @param packagesDir 技能包根目录，如 {AppDataDir}/skills/external/packages
   * @param readFile 文件读取函数（依赖注入）
   * @param dirExists 目录存在检查函数（依赖注入）
   * @param listFiles 列出目录文件函数（依赖注入，用于脚本和资源文件扫描）
   */
  constructor(
    packagesDir: string,
    readFile: FileReadFn,
    dirExists: DirExistsFn,
    listFiles: ListFilesFn = () => Promise.resolve([])
  ) {
    this.packagesDir = packagesDir.replace(/\\/g, '/');
    this.readFile = readFile;
    this.dirExists = dirExists;
    this.listFiles = listFiles;
  }

  /**
   * 自动扫描 packages/ 目录加载所有技能包
   *
   * 替代 registry.yaml 的零配置模式：
   * - 扫描 packagesDir 下每个子目录
   * - 以 _ 开头的目录视为禁用，跳过
   * - 每个含 SKILL.md 的子目录当作一个技能包
   * - 错误隔离：单个技能包失败不阻断其他
   * - 名称去重：先扫到先注册，后续重名跳过 + 警告
   */
  async scanAll(): Promise<RegistryLoadResult> {
    const warnings: string[] = [];
    const skills: LoadedExternalSkill[] = [];
    // 技能名去重集合（基于 SKILL.md 中声明的 name）
    const registeredNames = new Set<string>();

    // Step 1: 列出 packages/ 下所有子目录
    let dirEntries: string[];
    try {
      dirEntries = await this.listFiles(this.packagesDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to scan packages directory: ${message}`);
      return { skills, warnings };
    }

    if (dirEntries.length === 0) {
      logger.trace('[ExternalSkillRegistry] packages/ 目录为空，无外部技能');
      return { skills, warnings };
    }

    // Step 2: 逐个扫描子目录
    for (const dirName of dirEntries) {
      // 以 _ 开头的目录视为禁用（约定）
      if (dirName.startsWith('_')) {
        logger.trace(`[ExternalSkillRegistry] 跳过禁用目录: ${dirName}`);
        continue;
      }

      // 检查子目录是否存在（过滤非目录条目）
      const packagePath = `${this.packagesDir}/${dirName}`;
      const isDir = await this.dirExists(packagePath);
      if (!isDir) continue;

      // 检查 SKILL.md 是否存在
      const skillMdPath = `${packagePath}/SKILL.md`;
      let skillMdContent: string;
      try {
        skillMdContent = await this.readFile(skillMdPath);
      } catch {
        // 无 SKILL.md 的目录不是技能包，静默跳过
        continue;
      }

      // 加载技能包（错误隔离：单个失败不阻断其他）
      try {
        const skill = await this.loadSingleSkillFromDir(dirName, skillMdContent);
        if (skill) {
          // 名称去重检查
          if (registeredNames.has(skill.name)) {
            warnings.push(`Duplicate skill name "${skill.name}" (directory ${dirName}); skipped`);
            continue;
          }
          registeredNames.add(skill.name);
          skills.push(skill);
          logger.trace(`[ExternalSkillRegistry] 已加载技能: ${skill.name} (${skill.mode} 模式)`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Failed to load skill package "${dirName}": ${message}`);
      }
    }

    logger.trace(
      `[ExternalSkillRegistry] 扫描完成: ${skills.length} 个技能,` + ` ${warnings.length} 条警告`
    );

    return { skills, warnings };
  }

  /**
   * 从 registry.yaml 加载技能包
   *
   * @deprecated 请使用 scanAll() 替代。此方法保留用于向后兼容。
   */
  async loadAll(registryPath: string): Promise<RegistryLoadResult> {
    const warnings: string[] = [];
    const skills: LoadedExternalSkill[] = [];

    let registryConfig: RegistryConfig;
    try {
      const registryContent = await this.readFile(registryPath);
      registryConfig = this.parseRegistryYaml(registryContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to read registry.yaml: ${message}`);
      return { skills, warnings };
    }

    if (registryConfig.version !== REGISTRY_VERSION) {
      warnings.push(
        `registry.yaml version mismatch: expected ${REGISTRY_VERSION}, got ${registryConfig.version}`
      );
      return { skills, warnings };
    }

    for (const entry of registryConfig.skills) {
      if (!entry.enabled) {
        logger.trace(`[ExternalSkillRegistry] 跳过已禁用技能: ${entry.name}`);
        continue;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        const skill = await this.loadSingleSkillByEntry(entry);
        if (skill) {
          skills.push(skill);
          logger.trace(`[ExternalSkillRegistry] 已加载技能: ${skill.name} (${skill.mode} 模式)`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Failed to load skill "${entry.name}": ${message}`);
      }
    }

    logger.trace(
      `[ExternalSkillRegistry] 加载完成: ${skills.length} 个技能,` + ` ${warnings.length} 条警告`
    );

    return { skills, warnings };
  }

  /**
   * 从目录名和已读取的 SKILL.md 内容加载单个技能包
   *
   * 由 scanAll() 调用，SKILL.md 已预先读取
   */
  private async loadSingleSkillFromDir(
    dirName: string,
    skillMdContent: string
  ): Promise<LoadedExternalSkill | null> {
    const packagePath = `${this.packagesDir}/${dirName}`;
    return this.loadSkillFromContent(packagePath, skillMdContent);
  }

  /**
   * 从 ExternalSkillEntry 加载单个技能包
   *
   * @deprecated 由 loadAll() 调用，保留用于向后兼容
   */
  private async loadSingleSkillByEntry(
    entry: ExternalSkillEntry
  ): Promise<LoadedExternalSkill | null> {
    // 检查与 Native Skill 的名称冲突
    if (NATIVE_SKILL_NAMES.includes(entry.name)) {
      throw new Error(`Skill name "${entry.name}" conflicts with a native skill`);
    }

    // 验证技能名称格式
    if (!isValidSkillName(entry.name)) {
      throw new Error(
        `Invalid skill name "${entry.name}" (only lowercase letters, numbers, and hyphens are allowed)`
      );
    }

    // 确认技能包目录存在
    const packagePath = `${this.packagesDir}/${entry.name}`;
    const exists = await this.dirExists(packagePath);
    if (!exists) {
      throw new Error(`Skill package directory does not exist: ${packagePath}`);
    }

    // 读取 SKILL.md
    const skillMdPath = `${packagePath}/SKILL.md`;
    const skillMdContent = await this.readFile(skillMdPath);

    return this.loadSkillFromContent(packagePath, skillMdContent);
  }

  /**
   * 核心加载逻辑：从 SKILL.md 内容解析技能包
   *
   * 由 loadSingleSkillFromDir 和 loadSingleSkillByEntry 共用
   */
  private async loadSkillFromContent(
    packagePath: string,
    skillMdContent: string
  ): Promise<LoadedExternalSkill | null> {
    // 解析 frontmatter
    const { frontmatter, body: _body } = this.parseSkillMd(skillMdContent);

    // 验证必须字段
    if (!frontmatter.name) {
      throw new Error('SKILL.md frontmatter is missing the name field');
    }
    if (!frontmatter.description) {
      throw new Error('SKILL.md frontmatter is missing the description field');
    }

    // 检查与 Native Skill 的名称冲突
    if (NATIVE_SKILL_NAMES.includes(frontmatter.name)) {
      throw new Error(`Skill name "${frontmatter.name}" conflicts with a native skill`);
    }

    // 验证技能名称格式
    if (!isValidSkillName(frontmatter.name)) {
      throw new Error(
        `Invalid skill name "${frontmatter.name}" (only lowercase letters, numbers, and hyphens are allowed)`
      );
    }

    const agentvisNetwork = this.normalizeAgentVisNetwork(frontmatter.agentvisNetwork);
    const agentvisNetworkEntrypoints = this.normalizeAgentVisNetworkEntrypoints(
      frontmatter.agentvisNetworkEntrypoints
    );

    // 自动检测技能模式
    const mode = this.detectMode(frontmatter);

    // Script 模式：验证 Execution Contract
    if (mode === 'script') {
      const result = validateContract(frontmatter);
      if (!result.valid) {
        throw new Error(`Execution Contract validation failed:\n${result.errors.join('\n')}`);
      }

      return {
        name: frontmatter.name,
        description: frontmatter.description,
        mode: 'script',
        packagePath,
        fullContent: skillMdContent,
        contract: result.contract,
        dependencies: frontmatter.dependencies,
        agentvisNetwork,
        agentvisNetworkEntrypoints,
        enabled: true,
      };
    }

    // Guide 模式：收集脚本文件列表 + 资源文件列表
    const scriptFiles = await this.collectScriptFiles(packagePath);
    const resourceFiles = await this.collectResourceFiles(packagePath);

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      mode: 'guide',
      packagePath,
      fullContent: skillMdContent,
      dependencies: frontmatter.dependencies,
      agentvisNetwork,
      agentvisNetworkEntrypoints,
      enabled: true,
      scriptFiles: scriptFiles.length > 0 ? scriptFiles : undefined,
      resourceFiles: resourceFiles.length > 0 ? resourceFiles : undefined,
      triggers: frontmatter.triggers,
    };
  }

  private normalizeAgentVisNetwork(value: unknown): SkillAgentVisNetwork | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new Error('SKILL.md frontmatter agentvisNetwork must be brokerProxyPreferred');
    }

    const normalized = value.trim();
    if (normalized === 'brokerProxyPreferred') {
      return normalized;
    }

    throw new Error('SKILL.md frontmatter agentvisNetwork must be brokerProxyPreferred');
  }

  private normalizeAgentVisNetworkEntrypoints(
    value: unknown
  ): SkillAgentVisNetworkEntrypoints | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('SKILL.md frontmatter agentvisNetworkEntrypoints must be an object');
    }

    const normalized: SkillAgentVisNetworkEntrypoints = {};
    for (const [entry, mode] of Object.entries(value as Record<string, unknown>)) {
      if (typeof mode !== 'string') {
        throw new Error('SKILL.md frontmatter agentvisNetworkEntrypoints values must be strings');
      }
      const normalizedEntry = this.normalizeEntrypointPath(entry);
      const normalizedMode = this.normalizeAgentVisNetworkEntrypointMode(mode);
      normalized[normalizedEntry] = normalizedMode;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeEntrypointPath(entry: string): string {
    return entry
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '')
      .replace(/\/+/g, '/');
  }

  private normalizeAgentVisNetworkEntrypointMode(
    value: string
  ): SkillAgentVisNetworkEntrypointMode {
    const normalized = value.trim();
    if (normalized === 'brokerProxyPreferred' || normalized === 'legacyNonHttp') {
      return normalized;
    }
    throw new Error(
      'SKILL.md frontmatter agentvisNetworkEntrypoints values must be brokerProxyPreferred or legacyNonHttp'
    );
  }

  /**
   * 自动检测技能模式
   *
   * 有 execution.entry → Script 模式
   * 否则 → Guide 模式
   */
  private detectMode(frontmatter: ExternalSkillFrontmatter): SkillMode {
    if (frontmatter.execution?.entry) {
      return 'script';
    }
    return 'guide';
  }

  /**
   * 收集技能包内的脚本文件列表
   *
   * 扫描 packagePath 及其子目录下的脚本文件（.py/.sh/.js/.ts），
   * 返回相对于 packagePath 的路径列表。
   *
   * 用途：
   * 1. 注入到 SA Prompt 中，让 SA 知道有哪些现成脚本可用
   * 2. 判断是否包含可执行脚本（供 exec 工具补全使用）
   */
  private async collectScriptFiles(packagePath: string): Promise<string[]> {
    try {
      const result: string[] = [];
      await this.scanDirForFiles(
        packagePath,
        '',
        result,
        ExternalSkillRegistryLoader.SCRIPT_EXTENSIONS
      );
      return result;
    } catch {
      // 列目录失败时返回空列表，不影响技能加载
      return [];
    }
  }

  /**
   * 收集技能包内的资源文件列表
   *
   * 扫描 packagePath 及其子目录下的文档/数据文件（.md/.pdf/.txt 等），
   * 返回相对于 packagePath 的路径列表。
   * 排除 SKILL.md（已注入 fullContent）和 LICENSE* 文件。
   *
   * 用途：注入 SA Prompt，让 SA 知道技能包内有哪些可读取的资源文件
   */
  private async collectResourceFiles(packagePath: string): Promise<string[]> {
    try {
      const result: string[] = [];
      await this.scanDirForFiles(
        packagePath,
        '',
        result,
        ExternalSkillRegistryLoader.RESOURCE_EXTENSIONS
      );
      // 过滤排除文件（SKILL.md、LICENSE* 等）
      return result.filter((filePath) => {
        const fileName = filePath.includes('/')
          ? filePath.substring(filePath.lastIndexOf('/') + 1)
          : filePath;
        const lowerName = fileName.toLowerCase();
        // 排除 SKILL.md 和以 license 开头的文件
        return (
          !ExternalSkillRegistryLoader.RESOURCE_EXCLUDE_FILES.has(lowerName) &&
          !lowerName.startsWith('license')
        );
      });
    } catch {
      return [];
    }
  }

  /**
   * 递归扫描目录中的指定类型文件
   *
   * 通用文件扫描引擎，由 collectScriptFiles 和 collectResourceFiles 共用。
   *
   * @param basePath - 技能包根路径
   * @param relativePath - 当前扫描的相对路径（用于构建结果）
   * @param result - 收集结果数组（累积模式，避免频繁数组创建）
   * @param extensions - 目标文件扩展名集合
   */
  private async scanDirForFiles(
    basePath: string,
    relativePath: string,
    result: string[],
    extensions: Set<string>
  ): Promise<void> {
    const currentDir = relativePath ? `${basePath}/${relativePath}` : basePath;

    const entries = await this.listFiles(currentDir);

    for (const entry of entries) {
      const entryRelativePath = relativePath ? `${relativePath}/${entry}` : entry;

      // 检查是否为目标扩展名的文件
      const dotIndex = entry.lastIndexOf('.');
      if (dotIndex > 0) {
        const ext = entry.substring(dotIndex);
        if (extensions.has(ext)) {
          result.push(entryRelativePath);
          continue;
        }
      }

      // 尝试作为子目录递归（如 scripts/、themes/）
      // 仅对不含扩展名的条目尝试递归，避免对文件调用 listFiles
      if (dotIndex < 0 || !entry.substring(dotIndex).match(/^\.[a-z]+$/i)) {
        try {
          await this.scanDirForFiles(basePath, entryRelativePath, result, extensions);
        } catch {
          // 不是目录或无权限，静默跳过
        }
      }
    }
  }

  /**
   * 解析 SKILL.md 内容（frontmatter + body）
   *
   * 使用简化的 YAML 解析器处理 frontmatter，
   * 支持嵌套对象（execution.xxx）和数组。
   */
  private parseSkillMd(content: string): { frontmatter: ExternalSkillFrontmatter; body: string } {
    const lines = content.split('\n');
    let inFrontmatter = false;
    let frontmatterEnd = 0;
    const frontmatterLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim() ?? '';

      if (line === '---') {
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

    const frontmatter = this.parseFrontmatterYaml(frontmatterLines.join('\n'));
    const body = lines.slice(frontmatterEnd).join('\n').trim();

    return { frontmatter, body };
  }

  /**
   * 简化 YAML frontmatter 解析
   *
   * 使用基于缩进的状态机处理嵌套结构：
   * - 顶级 key: value
   * - 顶级块标量（description: > 或 description: |)
   * - 一级嵌套对象（execution:）
   * - 二级嵌套数组（argsSchema: / packages:）
   * - 数组元素中的多行对象属性
   */
  private parseFrontmatterYaml(yaml: string): ExternalSkillFrontmatter {
    const result: Record<string, unknown> = {};
    const lines = yaml.split('\n');

    // 状态追踪
    let level1Key: string | null = null; // 顶级嵌套键（如 execution, dependencies）
    let level1Obj: Record<string, unknown> = {}; // 顶级嵌套对象的属性

    let level2Key: string | null = null; // 二级嵌套键（如 argsSchema, packages）
    let level2Array: unknown[] = []; // 二级嵌套数组
    let level2Obj: Record<string, unknown> = {}; // 二级嵌套对象（如 permissions）

    let currentArrayItem: Record<string, unknown> | null = null; // 当前数组元素对象
    let level3Key: string | null = null; // 三级嵌套键（如 permissions.filesystem）
    let level3Array: unknown[] = []; // 三级嵌套数组
    let level3CurrentArrayItem: Record<string, unknown> | null = null;

    // 块标量收集状态（处理 description: > 或 description: | 格式）
    let blockScalarKey: string | null = null; // 当前处理的块标量键名
    let blockScalarMode: '>' | '|' | null = null; // '>' 折叠模式 | '|' 字面模式
    let blockScalarLines: string[] = []; // 收集到的块标量内容行

    for (const line of lines) {
      // 块标量模式下空行不忽略（属于内容的一部分）
      // 非块标量模式下，跳过空行和注释
      if (!blockScalarKey && (line.trim() === '' || line.trim().startsWith('#'))) continue;

      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();

      // ===== 处理块标量模式 =====
      if (blockScalarKey !== null) {
        if (indent > 0) {
          // 缩进行属于块标量内容
          blockScalarLines.push(trimmed);
          continue;
        } else {
          // 回到 indent=0，块标量结束，拼合内容并存入 result
          if (blockScalarMode === '>') {
            // 折叠模式：将换行替换为空格，整体内容作为一个长字符串
            result[blockScalarKey] = blockScalarLines.join(' ').replace(/\s+/g, ' ').trim();
          } else {
            // 字面模式：保留换行
            result[blockScalarKey] = blockScalarLines.join('\n').trim();
          }
          blockScalarKey = null;
          blockScalarMode = null;
          blockScalarLines = [];
          // 不执行 continue，继续处理当前行（它是下一个顶级 key）
        }
      }

      // ===== 顶级（indent=0）=====
      if (indent === 0) {
        // 保存之前的上下文
        this.flushParserState(
          result,
          level1Key,
          level1Obj,
          level2Key,
          level2Array,
          level2Obj,
          currentArrayItem,
          level3Key,
          level3Array,
          level3CurrentArrayItem
        );

        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;

        const key = trimmed.slice(0, colonIdx).trim();
        const rawVal = trimmed.slice(colonIdx + 1).trim();

        if (rawVal === '>' || rawVal === '|') {
          // 块标量开始：后续缩进行是内容
          blockScalarKey = key;
          blockScalarMode = rawVal;
          blockScalarLines = [];
          level1Key = null;
          level1Obj = {};
          level2Key = null;
          level2Array = [];
          level2Obj = {};
          currentArrayItem = null;
          level3Key = null;
          level3Array = [];
          level3CurrentArrayItem = null;
        } else if (rawVal === '') {
          // 开始嵌套对象
          level1Key = key;
          level1Obj = {};
          level2Key = null;
          level2Array = [];
          level2Obj = {};
          currentArrayItem = null;
          level3Key = null;
          level3Array = [];
          level3CurrentArrayItem = null;
        } else {
          // 简单 key: value
          result[key] = this.parseYamlValue(rawVal);
          level1Key = null;
          level1Obj = {};
          level2Key = null;
          level2Array = [];
          level2Obj = {};
          currentArrayItem = null;
          level3Key = null;
          level3Array = [];
          level3CurrentArrayItem = null;
        }
        continue;
      }

      // ===== 一级嵌套（indent=2）=====
      if (indent >= 2 && indent < 4 && level1Key) {
        // 数组项开始（如 "  - name: file_path"）
        if (trimmed.startsWith('- ')) {
          const itemContent = trimmed.slice(2).trim();

          if (level2Key) {
            // 正在收集数组，追加新元素
            // 先保存前一个数组元素
            if (currentArrayItem && Object.keys(currentArrayItem).length > 0) {
              level2Array.push(currentArrayItem);
            }

            const colonIdx = itemContent.indexOf(':');
            if (colonIdx !== -1) {
              // 对象数组元素的第一个属性
              const key = itemContent.slice(0, colonIdx).trim();
              const val = itemContent.slice(colonIdx + 1).trim();
              currentArrayItem = { [key]: this.parseYamlValue(val) };
            } else {
              // 简单数组元素
              level2Array.push(this.parseYamlValue(itemContent));
              currentArrayItem = null;
            }
          }
          continue;
        }

        // key: value 格式
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;

        const key = trimmed.slice(0, colonIdx).trim();
        const rawVal = trimmed.slice(colonIdx + 1).trim();

        if (rawVal === '') {
          // 二级嵌套开始（如 argsSchema: / packages:）
          // 先保存前一个二级上下文
          this.flushLevel2State(
            level1Obj,
            level2Key,
            level2Array,
            level2Obj,
            currentArrayItem,
            level3Key,
            level3Array,
            level3CurrentArrayItem
          );
          level2Key = key;
          level2Array = [];
          level2Obj = {};
          currentArrayItem = null;
          level3Key = null;
          level3Array = [];
          level3CurrentArrayItem = null;
        } else {
          this.flushLevel2State(
            level1Obj,
            level2Key,
            level2Array,
            level2Obj,
            currentArrayItem,
            level3Key,
            level3Array,
            level3CurrentArrayItem
          );
          level2Key = null;
          level2Array = [];
          level2Obj = {};
          currentArrayItem = null;
          level3Key = null;
          level3Array = [];
          level3CurrentArrayItem = null;
          // 一级嵌套的简单属性
          level1Obj[key] = this.parseYamlValue(rawVal);
        }
        continue;
      }

      // ===== 二级及更深（indent>=4）=====
      if (indent >= 4 && level1Key) {
        // 数组项
        if (trimmed.startsWith('- ')) {
          const itemContent = trimmed.slice(2).trim();

          if (level3Key) {
            if (level3CurrentArrayItem && Object.keys(level3CurrentArrayItem).length > 0) {
              level3Array.push(level3CurrentArrayItem);
            }

            const colonIdx = itemContent.indexOf(':');
            if (colonIdx !== -1) {
              const key = itemContent.slice(0, colonIdx).trim();
              const val = itemContent.slice(colonIdx + 1).trim();
              level3CurrentArrayItem = { [key]: this.parseYamlValue(val) };
            } else {
              level3Array.push(this.parseYamlValue(itemContent));
              level3CurrentArrayItem = null;
            }
          } else if (level2Key) {
            // 保存前一个数组元素对象
            if (currentArrayItem && Object.keys(currentArrayItem).length > 0) {
              level2Array.push(currentArrayItem);
            }

            const colonIdx = itemContent.indexOf(':');
            if (colonIdx !== -1) {
              const key = itemContent.slice(0, colonIdx).trim();
              const val = itemContent.slice(colonIdx + 1).trim();
              currentArrayItem = { [key]: this.parseYamlValue(val) };
            } else {
              level2Array.push(this.parseYamlValue(itemContent));
              currentArrayItem = null;
            }
          }
          continue;
        }

        if (level3CurrentArrayItem && indent > 4) {
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx !== -1) {
            const key = trimmed.slice(0, colonIdx).trim();
            const rawVal = trimmed.slice(colonIdx + 1).trim();
            level3CurrentArrayItem[key] = this.parseYamlValue(rawVal);
          }
          continue;
        }

        // 数组元素对象的后续属性（如 type:, required:, description:）
        if (currentArrayItem) {
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx !== -1) {
            const key = trimmed.slice(0, colonIdx).trim();
            const rawVal = trimmed.slice(colonIdx + 1).trim();
            currentArrayItem[key] = this.parseYamlValue(rawVal);
          }
        } else if (level2Key) {
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx !== -1) {
            const key = trimmed.slice(0, colonIdx).trim();
            const rawVal = trimmed.slice(colonIdx + 1).trim();
            this.flushLevel3State(level2Obj, level3Key, level3Array, level3CurrentArrayItem);
            level3Key = null;
            level3Array = [];
            level3CurrentArrayItem = null;

            if (rawVal === '') {
              level3Key = key;
            } else {
              level2Obj[key] = this.parseYamlValue(rawVal);
            }
          }
        }
      }
    }

    // 处理未结束的块标量
    if (blockScalarKey !== null && blockScalarLines.length > 0) {
      if (blockScalarMode === '>') {
        result[blockScalarKey] = blockScalarLines.join(' ').replace(/\s+/g, ' ').trim();
      } else {
        result[blockScalarKey] = blockScalarLines.join('\n').trim();
      }
    }

    // 保存最终状态
    this.flushParserState(
      result,
      level1Key,
      level1Obj,
      level2Key,
      level2Array,
      level2Obj,
      currentArrayItem,
      level3Key,
      level3Array,
      level3CurrentArrayItem
    );

    return result as unknown as ExternalSkillFrontmatter;
  }

  /**
   * 保存解析器累积状态到结果对象
   */
  private flushParserState(
    result: Record<string, unknown>,
    level1Key: string | null,
    level1Obj: Record<string, unknown>,
    level2Key: string | null,
    level2Array: unknown[],
    level2Obj: Record<string, unknown>,
    currentArrayItem: Record<string, unknown> | null,
    level3Key: string | null,
    level3Array: unknown[],
    level3CurrentArrayItem: Record<string, unknown> | null
  ): void {
    if (!level1Key) return;

    this.flushLevel2State(
      level1Obj,
      level2Key,
      level2Array,
      level2Obj,
      currentArrayItem,
      level3Key,
      level3Array,
      level3CurrentArrayItem
    );

    // 保存一级嵌套对象
    if (Object.keys(level1Obj).length > 0) {
      result[level1Key] = level1Obj;
    }
  }

  /**
   * 保存当前二级解析状态到一级对象
   */
  private flushLevel2State(
    level1Obj: Record<string, unknown>,
    level2Key: string | null,
    level2Array: unknown[],
    level2Obj: Record<string, unknown>,
    currentArrayItem: Record<string, unknown> | null,
    level3Key: string | null,
    level3Array: unknown[],
    level3CurrentArrayItem: Record<string, unknown> | null
  ): void {
    if (!level2Key) return;

    this.flushLevel3State(level2Obj, level3Key, level3Array, level3CurrentArrayItem);

    if (currentArrayItem && Object.keys(currentArrayItem).length > 0) {
      level2Array.push(currentArrayItem);
    }

    if (level2Array.length > 0) {
      level1Obj[level2Key] = level2Array;
    } else if (Object.keys(level2Obj).length > 0) {
      level1Obj[level2Key] = level2Obj;
    }
  }

  /**
   * 保存三级数组状态到二级对象
   */
  private flushLevel3State(
    level2Obj: Record<string, unknown>,
    level3Key: string | null,
    level3Array: unknown[],
    level3CurrentArrayItem: Record<string, unknown> | null
  ): void {
    if (!level3Key) return;

    if (level3CurrentArrayItem && Object.keys(level3CurrentArrayItem).length > 0) {
      level3Array.push(level3CurrentArrayItem);
    }

    if (level3Array.length > 0) {
      level2Obj[level3Key] = level3Array;
    }
  }

  /**
   * 解析单个 YAML 值
   */
  private parseYamlValue(raw: string): unknown {
    // 去除引号
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }

    // 布尔值
    if (raw === 'true') return true;
    if (raw === 'false') return false;

    // 数字
    if (!isNaN(Number(raw)) && raw !== '') return Number(raw);

    // 内联数组 [a, b, c]
    if (raw.startsWith('[') && raw.endsWith(']')) {
      return raw
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map((item) => this.parseYamlValue(item));
    }

    return raw;
  }

  /**
   * 解析 registry.yaml
   *
   * 使用简化的 YAML 解析器，仅支持 registry.yaml 的特定格式
   */
  private parseRegistryYaml(content: string): RegistryConfig {
    const lines = content.split('\n');
    let version = 1;
    const skills: ExternalSkillEntry[] = [];
    let currentSkill: Partial<ExternalSkillEntry> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // 跳过空行和注释
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      // 顶级 version
      if (trimmed.startsWith('version:')) {
        version = Number(trimmed.split(':')[1]?.trim()) || 1;
        continue;
      }

      // skills: 列表标记
      if (trimmed === 'skills:') continue;

      // 新技能条目开始
      if (trimmed.startsWith('- name:')) {
        // 保存前一个条目
        if (currentSkill?.name) {
          skills.push(this.buildSkillEntry(currentSkill));
        }
        currentSkill = {
          name: trimmed.replace('- name:', '').trim(),
        };
        continue;
      }

      // 技能条目属性
      if (currentSkill) {
        if (trimmed.startsWith('mode:')) {
          currentSkill.mode = trimmed.split(':')[1]?.trim() as SkillMode;
        } else if (trimmed.startsWith('enabled:')) {
          currentSkill.enabled = trimmed.split(':')[1]?.trim() === 'true';
        } else if (trimmed.startsWith('installed_at:')) {
          const value = trimmed.replace('installed_at:', '').trim();
          currentSkill.installedAt = value.replace(/"/g, '');
        }
      }
    }

    // 保存最后一个条目
    if (currentSkill?.name) {
      skills.push(this.buildSkillEntry(currentSkill));
    }

    return { version, skills };
  }

  /**
   * 从部分数据构建完整的 ExternalSkillEntry
   */
  private buildSkillEntry(partial: Partial<ExternalSkillEntry>): ExternalSkillEntry {
    return {
      name: partial.name ?? 'unknown',
      mode: partial.mode ?? 'guide',
      enabled: partial.enabled ?? true,
      installedAt: partial.installedAt ?? new Date().toISOString(),
    };
  }
}
