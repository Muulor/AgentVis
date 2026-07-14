/**
 * Preview 预览服务模块
 *
 * 提供 Vite Dev Server 实时预览功能的服务层接口。
 */

export { vitePreviewService } from './VitePreviewService';
export { templateManager } from './TemplateManager';
export { portAllocator } from './PortAllocator';
export {
  getManagedPreviewPort,
  isManagedPreviewUrl,
  PREVIEW_PORT_RANGE_END,
  PREVIEW_PORT_RANGE_START,
} from './previewUrlPolicy';
export { inlineHtmlResources, injectSrcdocHashNavFix } from './htmlResourceInliner';
export {
  MAX_PREVIEW_ASSET_BYTES,
  MAX_PREVIEW_ASSET_FILES,
  MAX_PREVIEW_SINGLE_ASSET_BYTES,
} from './previewAssetCopier';
export {
  analyzeHtmlImports,
  collectBareImportPackageRoots,
  collectBareImportSpecifiers,
  collectModuleSpecifiers,
  getBarePackageRoot,
  isImportMapSpecifierMapped,
  normalizeImportMapImports,
  normalizeImportMapScopes,
  parseImportMapImports,
  resolveImportMapSpecifier,
  resolveImportMapSpecifierForReferrer,
  shouldUseStaticImportMapPreview,
} from './importMapAnalysis';
export type { HtmlImportMapAnalysis, ImportMapScopes } from './importMapAnalysis';
export {
  normalizeProjectFile,
  normalizeProjectFiles,
  normalizeProjectRelativePath,
  ProjectPathValidationError,
} from './projectPathPolicy';
export type { ProjectPathValidationErrorCode } from './projectPathPolicy';
export {
  enforcePreviewSourceBudgets,
  getPreviewSourceByteLength,
  MAX_PREVIEW_SOURCE_DIRECTORY_DEPTH,
  MAX_PREVIEW_SOURCE_FILE_BYTES,
  MAX_PREVIEW_SOURCE_FILES,
  MAX_PREVIEW_SOURCE_SCAN_ENTRIES,
  MAX_PREVIEW_SOURCE_TOTAL_BYTES,
} from './previewSourcePolicy';
export {
  listPreviewSourceTree,
  readPreviewPackageJson,
  readPreviewSourceFiles,
} from './previewSourceStaging';
export type { PreviewSourceEntry, PreviewSourceTree } from './previewSourceStaging';
export {
  isPreviewableFile,
  inferTemplateFromFileName,
  inferTemplateFromFileNames,
  inferTemplateFromLanguage,
  inferTemplateFromLanguages,
} from './templateInference';
export type {
  ProjectFile,
  TemplateId,
  TemplateConfig,
  ViteServerStatus,
  ViteServerState,
  TemplateStatus,
} from './types';
