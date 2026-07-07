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
