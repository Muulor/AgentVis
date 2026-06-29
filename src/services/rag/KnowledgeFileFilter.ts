/**
 * Shared allow/deny rules for files that may be automatically indexed into
 * an Agent knowledge base.
 */

export type KnowledgeDocumentType = 'markdown' | 'text';

export const CODE_FILE_EXTENSIONS = [
    'asm',
    'astro',
    'bat',
    'bash',
    'c',
    'cc',
    'clj',
    'cljs',
    'cmd',
    'cpp',
    'cs',
    'css',
    'cxx',
    'dart',
    'erl',
    'ex',
    'exs',
    'fish',
    'fs',
    'fsx',
    'go',
    'h',
    'hpp',
    'hrl',
    'htm',
    'html',
    'ini',
    'java',
    'js',
    'json',
    'jsonl',
    'jsx',
    'kt',
    'kts',
    'less',
    'lua',
    'm',
    'mm',
    'php',
    'pl',
    'ps1',
    'py',
    'r',
    'rb',
    'rs',
    'rst',
    'sass',
    'scala',
    'scss',
    'sh',
    'sol',
    'sql',
    'svelte',
    'swift',
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

export const KNOWLEDGE_TEXT_FILE_EXTENSIONS = [
    'adoc',
    'csv',
    'md',
    'markdown',
    'text',
    'tsv',
    'txt',
] as const;

export const KNOWLEDGE_OFFICE_FILE_EXTENSIONS = [
    'docx',
    'pdf',
    'pptx',
    'xlsx',
] as const;

const CODE_FILE_EXTENSION_SET = new Set<string>(CODE_FILE_EXTENSIONS);
const KNOWLEDGE_TEXT_FILE_EXTENSION_SET = new Set<string>(KNOWLEDGE_TEXT_FILE_EXTENSIONS);
const KNOWLEDGE_OFFICE_FILE_EXTENSION_SET = new Set<string>(KNOWLEDGE_OFFICE_FILE_EXTENSIONS);
const AGENT_LOG_FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}_agent-log\.md$/i;

function getFileNameForKnowledge(filePathOrName: string): string {
    return filePathOrName.replace(/\\/g, '/').split('/').pop() ?? filePathOrName;
}

export function getFileExtensionForKnowledge(filePathOrName: string): string {
    const fileName = getFileNameForKnowledge(filePathOrName);
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot <= 0 || lastDot === fileName.length - 1) return '';
    return fileName.slice(lastDot + 1).toLowerCase();
}

export function isAgentLogFileForKnowledge(filePathOrName: string): boolean {
    return AGENT_LOG_FILE_NAME_PATTERN.test(getFileNameForKnowledge(filePathOrName));
}

export function isCodeFileForKnowledge(filePathOrName: string): boolean {
    const ext = getFileExtensionForKnowledge(filePathOrName);
    return ext.length > 0 && CODE_FILE_EXTENSION_SET.has(ext);
}

export function isKnowledgeTextFile(filePathOrName: string): boolean {
    if (isAgentLogFileForKnowledge(filePathOrName)) return false;

    const ext = getFileExtensionForKnowledge(filePathOrName);
    return ext.length > 0
        && !CODE_FILE_EXTENSION_SET.has(ext)
        && KNOWLEDGE_TEXT_FILE_EXTENSION_SET.has(ext);
}

export function isKnowledgeOfficeFile(filePathOrName: string): boolean {
    if (isAgentLogFileForKnowledge(filePathOrName)) return false;

    const ext = getFileExtensionForKnowledge(filePathOrName);
    return ext.length > 0 && KNOWLEDGE_OFFICE_FILE_EXTENSION_SET.has(ext);
}

export function shouldAutoIndexKnowledgeFile(filePathOrName: string): boolean {
    return isKnowledgeTextFile(filePathOrName) || isKnowledgeOfficeFile(filePathOrName);
}

export function getKnowledgeDocumentType(filePathOrName: string): KnowledgeDocumentType {
    const ext = getFileExtensionForKnowledge(filePathOrName);
    return ['md', 'markdown'].includes(ext) ? 'markdown' : 'text';
}
