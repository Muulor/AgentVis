/**
 * Central file type registry.
 *
 * A file extension can have different capabilities in different product
 * surfaces. For example JSON is previewed as code and can be attached as
 * readable text, but should not be auto-indexed into the knowledge base.
 */

export type FileFamily =
  | 'audio'
  | 'code'
  | 'config'
  | 'data'
  | 'image'
  | 'markdown'
  | 'office'
  | 'pdf'
  | 'text'
  | 'unknown'
  | 'video';

export type AttachmentKind = 'document' | 'image';
export type PreviewRenderer =
  | 'audio'
  | 'binaryDoc'
  | 'code'
  | 'image'
  | 'markdown'
  | 'plainText'
  | 'video';
export type ParserMode = 'none' | 'rustCommand' | 'text';
export type RustDocumentParserCommand = 'parse_docx' | 'parse_pdf' | 'parse_pptx' | 'parse_xlsx';
export type KnowledgeDocumentType = 'markdown' | 'text';

export interface FileTypeInfo {
  extension: string;
  family: FileFamily;
  codeLanguage?: string;
  mimeType?: string;
  attachment: {
    accepted: boolean;
    kind?: AttachmentKind;
  };
  preview: {
    renderer: PreviewRenderer;
    systemOpenFallback?: boolean;
  };
  parser: {
    mode: ParserMode;
    command?: RustDocumentParserCommand;
  };
  knowledge: {
    autoIndex: boolean;
    documentType?: KnowledgeDocumentType;
  };
}

export const MARKDOWN_EXTENSIONS = ['md', 'markdown'] as const;
export const ATTACHMENT_IMAGE_EXTENSIONS = ['jpeg', 'jpg', 'png', 'webp', 'heif', 'heic'] as const;
export const PREVIEW_IMAGE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
] as const;

export const CODE_FILE_EXTENSIONS = [
  'asm',
  'astro',
  'bat',
  'bash',
  'c',
  'cfg',
  'cc',
  'clj',
  'cljs',
  'cmake',
  'cmd',
  'cnf',
  'conf',
  'cpp',
  'cs',
  'css',
  'cjs',
  'cts',
  'cxx',
  'dart',
  'dockerfile',
  'erl',
  'env',
  'ex',
  'exs',
  'fish',
  'fs',
  'fsx',
  'gql',
  'go',
  'gradle',
  'graphql',
  'groovy',
  'h',
  'hcl',
  'hpp',
  'hrl',
  'hxx',
  'htm',
  'html',
  'ini',
  'ipynb',
  'java',
  'js',
  'json',
  'json5',
  'jsonc',
  'jsonl',
  'jsx',
  'kt',
  'kts',
  'less',
  'lock',
  'lua',
  'm',
  'make',
  'mdx',
  'mm',
  'mjs',
  'mk',
  'mts',
  'php',
  'pl',
  'pm',
  'prisma',
  'properties',
  'proto',
  'ps1',
  'psd1',
  'psm1',
  'py',
  'pyw',
  'r',
  'rb',
  'rs',
  'rst',
  'sass',
  'sc',
  'scala',
  'scss',
  'sh',
  'sol',
  'sql',
  'svelte',
  'swift',
  'tf',
  'tfvars',
  'ts',
  'tsx',
  'toml',
  'vb',
  'vue',
  'xml',
  'yam',
  'yaml',
  'yml',
  'zsh',
] as const;

export const CONFIG_FILE_EXTENSIONS = [
  'cfg',
  'cnf',
  'conf',
  'env',
  'hcl',
  'ini',
  'json',
  'json5',
  'jsonc',
  'jsonl',
  'lock',
  'properties',
  'tf',
  'tfvars',
  'toml',
  'xml',
  'yam',
  'yaml',
  'yml',
] as const;

export const TEXT_DOCUMENT_EXTENSIONS = ['adoc', 'csv', 'log', 'text', 'tsv', 'txt'] as const;

export const OFFICE_DOCUMENT_EXTENSIONS = ['docx', 'xlsx', 'xls', 'pptx'] as const;
export const PDF_DOCUMENT_EXTENSIONS = ['pdf'] as const;

export const PLAIN_TEXT_PROCESSING_EXTENSIONS = [
  ...TEXT_DOCUMENT_EXTENSIONS,
  ...MARKDOWN_EXTENSIONS,
  ...CODE_FILE_EXTENSIONS,
] as const;

export const DOCUMENT_PROCESSING_EXTENSIONS = [
  ...TEXT_DOCUMENT_EXTENSIONS,
  ...MARKDOWN_EXTENSIONS,
  ...OFFICE_DOCUMENT_EXTENSIONS,
  ...PDF_DOCUMENT_EXTENSIONS,
  ...CODE_FILE_EXTENSIONS,
] as const;

export const BINARY_DOCUMENT_PREVIEW_EXTENSIONS = ['docx', 'xlsx', 'xls', 'pptx', 'pdf'] as const;
export const RUST_PARSED_DOCUMENT_EXTENSIONS = ['docx', 'xlsx', 'xls', 'pptx', 'pdf'] as const;

export const KNOWLEDGE_TEXT_FILE_EXTENSIONS = [
  'adoc',
  'csv',
  'md',
  'markdown',
  'text',
  'tsv',
  'txt',
] as const;

export const KNOWLEDGE_OFFICE_FILE_EXTENSIONS = ['docx', 'pdf', 'pptx', 'xls', 'xlsx'] as const;

const INLINE_VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov'] as const;
const SYSTEM_VIDEO_EXTENSIONS = ['mkv', 'avi', 'flv', 'wmv', 'rmvb'] as const;
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'wma'] as const;

const CODE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'bash',
  cjs: 'javascript',
  css: 'css',
  html: 'html',
  js: 'javascript',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  jsonl: 'json',
  jsx: 'jsx',
  mjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mov: 'video/mp4',
  mp4: 'video/mp4',
  ogg: 'video/ogg',
  webm: 'video/webm',
};

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

const RUST_PARSER_BY_EXTENSION: Partial<Record<string, RustDocumentParserCommand>> = {
  docx: 'parse_docx',
  pdf: 'parse_pdf',
  pptx: 'parse_pptx',
  xls: 'parse_xlsx',
  xlsx: 'parse_xlsx',
};

const CODE_FILE_EXTENSION_SET = new Set<string>(CODE_FILE_EXTENSIONS);
const CONFIG_FILE_EXTENSION_SET = new Set<string>(CONFIG_FILE_EXTENSIONS);
const DOCUMENT_PROCESSING_EXTENSION_SET = new Set<string>(DOCUMENT_PROCESSING_EXTENSIONS);
const PLAIN_TEXT_PROCESSING_EXTENSION_SET = new Set<string>(PLAIN_TEXT_PROCESSING_EXTENSIONS);
const ATTACHMENT_IMAGE_EXTENSION_SET = new Set<string>(ATTACHMENT_IMAGE_EXTENSIONS);
const PREVIEW_IMAGE_EXTENSION_SET = new Set<string>(PREVIEW_IMAGE_EXTENSIONS);
const BINARY_DOCUMENT_PREVIEW_EXTENSION_SET = new Set<string>(BINARY_DOCUMENT_PREVIEW_EXTENSIONS);
const INLINE_VIDEO_EXTENSION_SET = new Set<string>(INLINE_VIDEO_EXTENSIONS);
const SYSTEM_VIDEO_EXTENSION_SET = new Set<string>(SYSTEM_VIDEO_EXTENSIONS);
const AUDIO_EXTENSION_SET = new Set<string>(AUDIO_EXTENSIONS);
const KNOWLEDGE_TEXT_FILE_EXTENSION_SET = new Set<string>(KNOWLEDGE_TEXT_FILE_EXTENSIONS);
const KNOWLEDGE_OFFICE_FILE_EXTENSION_SET = new Set<string>(KNOWLEDGE_OFFICE_FILE_EXTENSIONS);
const AGENT_LOG_FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}_agent-log\.md$/i;

export function getFileName(filePathOrName: string): string {
  return filePathOrName.replace(/\\/g, '/').split('/').pop() ?? filePathOrName;
}

export function getFileExtension(filePathOrName: string): string {
  const fileName = getFileName(filePathOrName);
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === fileName.length - 1) return '';
  return fileName.slice(lastDot + 1).toLowerCase();
}

export function isAgentLogFile(filePathOrName: string): boolean {
  return AGENT_LOG_FILE_NAME_PATTERN.test(getFileName(filePathOrName));
}

export function isMarkdownFile(filePathOrName: string): boolean {
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(getFileExtension(filePathOrName));
}

export function isHtmlFile(filePathOrName: string): boolean {
  return ['html', 'htm'].includes(getFileExtension(filePathOrName));
}

export function isCodeFile(filePathOrName: string): boolean {
  const ext = getFileExtension(filePathOrName);
  return ext.length > 0 && CODE_FILE_EXTENSION_SET.has(ext);
}

export function isImageFile(filePathOrName: string): boolean {
  const ext = getFileExtension(filePathOrName);
  return ext.length > 0 && PREVIEW_IMAGE_EXTENSION_SET.has(ext);
}

export function isBinaryDocumentFile(filePathOrName: string): boolean {
  const ext = getFileExtension(filePathOrName);
  return ext.length > 0 && BINARY_DOCUMENT_PREVIEW_EXTENSION_SET.has(ext);
}

export function isInlineVideoFile(filePathOrName: string): boolean {
  const ext = getFileExtension(filePathOrName);
  return ext.length > 0 && INLINE_VIDEO_EXTENSION_SET.has(ext);
}

export function isSystemVideoFile(filePathOrName: string): boolean {
  const ext = getFileExtension(filePathOrName);
  return ext.length > 0 && SYSTEM_VIDEO_EXTENSION_SET.has(ext);
}

export function isAudioFile(filePathOrName: string): boolean {
  const ext = getFileExtension(filePathOrName);
  return ext.length > 0 && AUDIO_EXTENSION_SET.has(ext);
}

export function getCodeLanguage(filePathOrName: string): string {
  return CODE_LANGUAGE_BY_EXTENSION[getFileExtension(filePathOrName)] ?? 'text';
}

export function getImageMimeType(filePathOrName: string): string {
  return IMAGE_MIME_BY_EXTENSION[getFileExtension(filePathOrName)] ?? 'image/png';
}

export function getVideoMimeType(filePathOrName: string): string {
  return VIDEO_MIME_BY_EXTENSION[getFileExtension(filePathOrName)] ?? 'video/mp4';
}

export function getAudioMimeType(filePathOrName: string): string {
  return AUDIO_MIME_BY_EXTENSION[getFileExtension(filePathOrName)] ?? 'audio/mpeg';
}

export function getAttachmentKind(filePathOrName: string): AttachmentKind | null {
  const ext = getFileExtension(filePathOrName);
  if (ATTACHMENT_IMAGE_EXTENSION_SET.has(ext)) return 'image';
  if (DOCUMENT_PROCESSING_EXTENSION_SET.has(ext)) return 'document';
  return null;
}

export function getAttachmentAcceptedExtensions(): string[] {
  return Array.from(new Set([...ATTACHMENT_IMAGE_EXTENSIONS, ...DOCUMENT_PROCESSING_EXTENSIONS]));
}

export function isPlainTextProcessableFile(filePathOrName: string): boolean {
  const ext = getFileExtension(filePathOrName);
  return ext.length > 0 && PLAIN_TEXT_PROCESSING_EXTENSION_SET.has(ext);
}

export function getRustParserCommand(filePathOrName: string): RustDocumentParserCommand | null {
  return RUST_PARSER_BY_EXTENSION[getFileExtension(filePathOrName)] ?? null;
}

export function isKnowledgeTextFile(filePathOrName: string): boolean {
  if (isAgentLogFile(filePathOrName)) return false;

  const ext = getFileExtension(filePathOrName);
  return (
    ext.length > 0 &&
    !CODE_FILE_EXTENSION_SET.has(ext) &&
    KNOWLEDGE_TEXT_FILE_EXTENSION_SET.has(ext)
  );
}

export function isKnowledgeOfficeFile(filePathOrName: string): boolean {
  if (isAgentLogFile(filePathOrName)) return false;

  const ext = getFileExtension(filePathOrName);
  return ext.length > 0 && KNOWLEDGE_OFFICE_FILE_EXTENSION_SET.has(ext);
}

export function shouldAutoIndexKnowledgeFile(filePathOrName: string): boolean {
  return isKnowledgeTextFile(filePathOrName) || isKnowledgeOfficeFile(filePathOrName);
}

export function getKnowledgeDocumentType(filePathOrName: string): KnowledgeDocumentType {
  return isMarkdownFile(filePathOrName) ? 'markdown' : 'text';
}

export function getFileFamily(filePathOrName: string): FileFamily {
  const ext = getFileExtension(filePathOrName);
  if (!ext) return 'unknown';
  if (isMarkdownFile(filePathOrName)) return 'markdown';
  if (PREVIEW_IMAGE_EXTENSION_SET.has(ext)) return 'image';
  if (INLINE_VIDEO_EXTENSION_SET.has(ext) || SYSTEM_VIDEO_EXTENSION_SET.has(ext)) return 'video';
  if (AUDIO_EXTENSION_SET.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if ((OFFICE_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) return 'office';
  if (CONFIG_FILE_EXTENSION_SET.has(ext)) return 'config';
  if (CODE_FILE_EXTENSION_SET.has(ext)) return 'code';
  if (['csv', 'tsv'].includes(ext)) return 'data';
  if (['txt', 'text', 'adoc'].includes(ext)) return 'text';
  return 'unknown';
}

export function getPreviewRenderer(filePathOrName: string): PreviewRenderer {
  if (isImageFile(filePathOrName)) return 'image';
  if (isInlineVideoFile(filePathOrName)) return 'video';
  if (isSystemVideoFile(filePathOrName) || isBinaryDocumentFile(filePathOrName)) return 'binaryDoc';
  if (isAudioFile(filePathOrName)) return 'audio';
  if (isHtmlFile(filePathOrName)) return 'code';
  if (isMarkdownFile(filePathOrName)) return 'markdown';
  if (isCodeFile(filePathOrName)) return 'code';
  return 'plainText';
}

export function getFileTypeInfo(filePathOrName: string): FileTypeInfo {
  const ext = getFileExtension(filePathOrName);
  const attachmentKind = getAttachmentKind(filePathOrName);
  const rustCommand = getRustParserCommand(filePathOrName);
  const mimeType =
    IMAGE_MIME_BY_EXTENSION[ext] ?? VIDEO_MIME_BY_EXTENSION[ext] ?? AUDIO_MIME_BY_EXTENSION[ext];

  return {
    extension: ext,
    family: getFileFamily(filePathOrName),
    codeLanguage: isCodeFile(filePathOrName) ? getCodeLanguage(filePathOrName) : undefined,
    mimeType,
    attachment: {
      accepted: attachmentKind !== null,
      ...(attachmentKind ? { kind: attachmentKind } : {}),
    },
    preview: {
      renderer: getPreviewRenderer(filePathOrName),
      systemOpenFallback: isSystemVideoFile(filePathOrName),
    },
    parser: rustCommand
      ? { mode: 'rustCommand', command: rustCommand }
      : isPlainTextProcessableFile(filePathOrName)
        ? { mode: 'text' }
        : { mode: 'none' },
    knowledge: {
      autoIndex: shouldAutoIndexKnowledgeFile(filePathOrName),
      documentType: shouldAutoIndexKnowledgeFile(filePathOrName)
        ? getKnowledgeDocumentType(filePathOrName)
        : undefined,
    },
  };
}
