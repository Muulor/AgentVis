/**
 * 文件管理组件统一导出
 */

// 主要组件
export { FileList } from './FileList';
export { FileItem } from './FileItem';
export { FilePreview } from './FilePreview';
export { LargeTextPreview } from './LargeTextPreview';
export { FileContextMenu } from './FileContextMenu';
export { FileTypeIcon } from './FileTypeIcon';

// 渲染组件
export { MarkdownRenderer } from './MarkdownRenderer';
export { CodeHighlight } from './CodeHighlight';
export { LivePreviewPanel } from './LivePreviewPanel';
export { decideTextPreview, getTextPreviewKind } from './TextPreviewPolicy';

// 类型导出
export type { FileItemData } from './FileItem';
export type {
  TextPreviewAnalysis,
  TextPreviewDecision,
  TextPreviewKind,
  TextPreviewMode,
} from './TextPreviewPolicy';
