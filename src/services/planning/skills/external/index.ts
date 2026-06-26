/**
 * External Skill 模块入口
 *
 * 导出外部技能系统的所有公共 API
 */

// 类型导出
export type {
    SkillMode,
    ScriptRuntime,
    ContractArg,
    ExecutionContract,
    SkillDependencies,
    ExternalSkillEntry,
    ExternalSkillRegistry,
    ExternalSkillFrontmatter,
    LoadedExternalSkill,
    ScriptExecutionResult,
} from './types';

export {
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_MAX_OUTPUT_BYTES,
    REGISTRY_VERSION,
    SUPPORTED_RUNTIMES,
    NATIVE_SKILL_NAMES,
} from './types';

// ContractValidator
export {
    validateContract,
    validateArgs,
    isNativeSkillConflict,
    isValidSkillName,
} from './ContractValidator';
export type { ValidationResult, ArgValidationResult } from './ContractValidator';

// ExternalExecutor
export { ExternalExecutor } from './ExternalExecutor';
export type { ShellExecuteFn } from './ExternalExecutor';

// RuntimeManager
export { RuntimeManager, BASE_REQUIREMENTS_FILENAME } from './RuntimeManager';
export type { RuntimeStatus, RuntimeCheckResult } from './RuntimeManager';

// ExternalSkillRegistry
export { ExternalSkillRegistryLoader } from './ExternalSkillRegistry';
export type {
    FileReadFn,
    DirExistsFn,
    ListFilesFn,
    RegistryLoadResult,
} from './ExternalSkillRegistry';

// ExternalToolProvider
export { ExternalToolProvider } from './ExternalToolProvider';

// SkillRetriever
export { SkillRetriever, createSkillRetriever } from './SkillRetriever';
export type { SkillRetrievalResult, EmbeddingServiceDep } from './SkillRetriever';

// ExternalSkillBootstrap
export { bootstrapExternalSkills, resetBootstrapState, reconcileVenvState } from './ExternalSkillBootstrap';

// Tauri Shell 适配器
export { createTauriShellExecute } from './tauriShellAdapter';

// Runtime 基础依赖清单管理和环境安装共享逻辑
export {
    ensureRequirementsFile,
    performEnvironmentSetup,
    performEnvironmentRebuild,
} from './requirementsProvider';
