/**
 * ChatInput - 聊天输入区域组件
 * 
 * 功能：
 * - 自动调整高度的 textarea
 * - Ctrl/Cmd + Enter 快捷发送
 * - @提及自动补全（Agent窗口支持mention文件、"/"技能、Hub内mention agentAI 智能体）
 * - 集成 QuotePreview 和 ModeSelector
 * - 支持附件上传,粘贴图片
 */

import { useState, useCallback, useRef, useEffect, useLayoutEffect, memo, useMemo, type SetStateAction } from 'react';
import { ArrowBigRightDash, ClipboardPaste, Copy, FileText, Folder, Scissors, Square, TextSelect, Toolbox, X } from 'lucide-react';
import { QuotePreview } from './QuotePreview';
import { ModeSelector } from './ModeSelector';
import { MentionInput } from './MentionInput';
import { AttachmentButton } from './AttachmentButton';
import { ProjectPathButton } from './ProjectPathButton';
import { AttachmentPreview } from './AttachmentPreview';
import {
    filterSkillSlashOptions,
    findSkillSlashTrigger,
    type SkillSlashOption,
    type SkillSlashTrigger,
} from './skillSlashUtils';
import {
    appendUniqueContextToken,
    buildDisplayContent,
    buildContextTokenPrefix,
    removeContextToken,
    type InputDisplayPart,
    type InputContextToken,
    type InputContextTokenType,
} from './inputContextTokens';
import {
    filterFileMentionOptions,
    findFileMentionTrigger,
    type FileMentionOption,
    type FileMentionTrigger,
} from './fileMentionUtils';
import { cx } from '@utils/classNames';
import { useRuntimeStore } from '@stores/runtimeStore';
import { useI18n } from '@/i18n';
import type { ChatMode } from '@/types/chatMode';
import type { QuoteInfo, AttachmentInfo } from '@/types/message';
import styles from './ChatInput.module.css';
import { getLogger } from '@services/logger';

const logger = getLogger('ChatInput');

interface DirectoryEntry {
    name: string;
    isDirectory: boolean;
    size: number;
    createdAt: number;
    relativePath: string;
    absolutePath: string;
}

interface RichEditorSnapshot {
    displayContent: string;
    displayParts: InputDisplayPart[];
    contextTokens: InputContextToken[];
    fileTokens: InputContextToken[];
}

interface ChatInputDraft {
    value: string;
    contextTokens: InputContextToken[];
    displayParts?: InputDisplayPart[];
}

const INLINE_TOKEN_CLASS = 'inline-context-token';
const FILE_TOKEN_CLASS = 'inline-file-token';
const SKILL_TOKEN_CLASS = 'inline-skill-token';
const INLINE_TOKEN_ICON_CLASS = 'inline-context-token-icon';
const INLINE_TOKEN_LABEL_CLASS = 'inline-context-token-label';
const FILE_SCAN_LIMIT = 500;
const DIRECTORY_SCAN_LIMIT = 80;
const SKIPPED_FILE_SCAN_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    'target',
    '.next',
    'out',
    'coverage',
    '.venv',
    '__pycache__',
]);

/** 运行期输入草稿缓存：仅在应用进程内保留，关闭应用后自然清空 */
const chatInputDrafts = new Map<string, ChatInputDraft>();

function cloneContextTokens(tokens: InputContextToken[]): InputContextToken[] {
    return tokens.map(token => ({ ...token }));
}

function cloneDisplayParts(parts?: InputDisplayPart[]): InputDisplayPart[] | undefined {
    return parts?.map(part => (
        part.type === 'text'
            ? { ...part }
            : { type: 'token', token: { ...part.token } }
    ));
}

function getChatInputDraft(draftKey?: string): ChatInputDraft {
    if (!draftKey) {
        return { value: '', contextTokens: [] };
    }

    const draft = chatInputDrafts.get(draftKey);
    return draft
        ? {
            value: draft.value,
            contextTokens: cloneContextTokens(draft.contextTokens),
            displayParts: cloneDisplayParts(draft.displayParts),
        }
        : { value: '', contextTokens: [] };
}

function saveChatInputDraft(draftKey: string | undefined, draft: ChatInputDraft): void {
    if (!draftKey) return;

    if (draft.value.length === 0 && draft.contextTokens.length === 0 && !draft.displayParts?.length) {
        chatInputDrafts.delete(draftKey);
        return;
    }

    chatInputDrafts.set(draftKey, {
        value: draft.value,
        contextTokens: cloneContextTokens(draft.contextTokens),
        displayParts: cloneDisplayParts(draft.displayParts),
    });
}

function sanitizeFolderName(name: string): string {
    return name
        .replace(/[/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        || 'unnamed';
}

async function resolveAttachmentTargetDir(params: {
    projectPath?: string | null;
    hubName?: string;
    agentName?: string;
}): Promise<string | undefined> {
    const { join, appDataDir } = await import('@tauri-apps/api/path');

    if (params.projectPath?.trim()) {
        return await join(params.projectPath, 'attachments');
    }

    if (params.hubName && params.agentName) {
        const appData = await appDataDir();
        return await join(
            appData,
            'deliverables',
            sanitizeFolderName(params.hubName),
            sanitizeFolderName(params.agentName),
            'attachments'
        );
    }

    return undefined;
}

function getSelectionOffset(root: HTMLElement): number | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    if (!root.contains(range.endContainer)) return null;

    const preRange = document.createRange();
    preRange.selectNodeContents(root);
    preRange.setEnd(range.endContainer, range.endOffset);
    return preRange.toString().length;
}

function findTextPosition(root: HTMLElement, offset: number): { node: Text; offset: number } | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode() as Text | null;
    let consumed = 0;

    while (current) {
        const length = current.data.length;
        if (consumed + length >= offset) {
            return {
                node: current,
                offset: Math.max(0, offset - consumed),
            };
        }
        consumed += length;
        current = walker.nextNode() as Text | null;
    }

    if (root.lastChild instanceof Text) {
        return {
            node: root.lastChild,
            offset: root.lastChild.data.length,
        };
    }

    const textNode = document.createTextNode('');
    root.appendChild(textNode);
    return { node: textNode, offset: 0 };
}

function replaceRichEditorTextRange(
    root: HTMLElement,
    start: number,
    end: number,
    nodes: Node[]
): void {
    const startPosition = findTextPosition(root, start);
    const endPosition = findTextPosition(root, end);
    if (!startPosition || !endPosition) return;

    const range = document.createRange();
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset);
    range.deleteContents();

    const fragment = document.createDocumentFragment();
    for (const node of nodes) {
        fragment.appendChild(node);
    }
    const lastNode = nodes[nodes.length - 1] ?? null;
    range.insertNode(fragment);

    if (lastNode) {
        const selection = window.getSelection();
        const nextRange = document.createRange();
        nextRange.setStartAfter(lastNode);
        nextRange.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(nextRange);
    }
}

function createTokenIconElement(tokenType: InputContextToken['type']): SVGSVGElement {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', INLINE_TOKEN_ICON_CLASS);
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');

    const addPath = (d: string) => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        icon.append(path);
    };

    if (tokenType === 'skill') {
        addPath('M16 12v4');
        addPath('M16 6a2 2 0 0 1 1.414.586l4 4A2 2 0 0 1 22 12v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 .586-1.414l4-4A2 2 0 0 1 8 6z');
        addPath('M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2');
        addPath('M2 14h20');
        addPath('M8 12v4');
        return icon;
    }

    if (tokenType === 'folder') {
        addPath('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z');
        return icon;
    }

    addPath('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z');
    addPath('M14 2v4a2 2 0 0 0 2 2h4');
    addPath('M10 9H8');
    addPath('M16 13H8');
    addPath('M16 17H8');
    return icon;
}

function createInlineTokenElement(token: InputContextToken): HTMLElement {
    const element = document.createElement('span');
    element.className = [
        INLINE_TOKEN_CLASS,
        token.type === 'skill' ? SKILL_TOKEN_CLASS : FILE_TOKEN_CLASS,
    ].join(' ');
    element.contentEditable = 'false';
    element.setAttribute('role', 'button');
    element.tabIndex = 0;
    element.dataset.tokenId = token.id;
    element.dataset.tokenType = token.type;
    element.dataset.label = token.label;
    if (token.description) element.dataset.description = token.description;
    if (token.path) element.dataset.path = token.path;
    if (token.relativePath) element.dataset.relativePath = token.relativePath;
    if (token.badge) element.dataset.badge = token.badge;
    if (token.semanticText) element.dataset.semanticText = token.semanticText;

    const label = document.createElement('span');
    label.className = INLINE_TOKEN_LABEL_CLASS;
    label.textContent = token.label;
    element.append(createTokenIconElement(token.type), label);
    return element;
}

function getTokenFromElement(element: HTMLElement): InputContextToken {
    const rawTokenType = element.dataset.tokenType;
    const tokenType: InputContextTokenType = rawTokenType === 'skill' || rawTokenType === 'folder'
        ? rawTokenType
        : 'file';
    const label = element.dataset.label ?? element.textContent;
    const path = element.dataset.path;
    return {
        id: element.dataset.tokenId ?? `${tokenType}:${path ?? label}`,
        type: tokenType,
        label,
        description: element.dataset.description,
        path,
        relativePath: element.dataset.relativePath,
        badge: element.dataset.badge,
        semanticText: element.dataset.semanticText,
    };
}

function insertTextAtRichEditorSelection(root: HTMLElement | null, text: string): void {
    if (!root) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        root.appendChild(document.createTextNode(text));
        return;
    }

    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
        root.appendChild(document.createTextNode(text));
        return;
    }

    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    const nextRange = document.createRange();
    nextRange.setStartAfter(textNode);
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
}

function insertNodesAtRichEditorSelection(root: HTMLElement | null, nodes: Node[]): void {
    if (!root || nodes.length === 0) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        nodes.forEach(node => root.appendChild(node));
        return;
    }

    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
        nodes.forEach(node => root.appendChild(node));
        return;
    }

    range.deleteContents();
    const fragment = document.createDocumentFragment();
    nodes.forEach(node => fragment.appendChild(node));
    const lastNode = nodes[nodes.length - 1] ?? null;
    range.insertNode(fragment);

    if (!lastNode) return;
    const nextRange = document.createRange();
    nextRange.setStartAfter(lastNode);
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
}

function renderRichEditorDraft(root: HTMLElement | null, draft: ChatInputDraft): void {
    if (!root) return;

    root.textContent = '';

    if (!draft.displayParts?.length) {
        root.textContent = draft.value;
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const part of draft.displayParts) {
        fragment.appendChild(
            part.type === 'text'
                ? document.createTextNode(part.text)
                : createInlineTokenElement(part.token)
        );
    }
    root.appendChild(fragment);
}

function focusRichEditorEnd(root: HTMLElement | null): void {
    if (!root) return;

    root.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function isInlineTokenElement(node: Node): node is HTMLElement {
    return node instanceof HTMLElement && (
        node.classList.contains(INLINE_TOKEN_CLASS) ||
        node.classList.contains(FILE_TOKEN_CLASS)
    );
}

function findClosestInlineTokenElement(target: EventTarget | null, root: HTMLElement | null): HTMLElement | null {
    if (!(target instanceof HTMLElement) || !root) return null;
    const tokenElement = target.closest(`.${INLINE_TOKEN_CLASS}, .${FILE_TOKEN_CLASS}`);
    return tokenElement instanceof HTMLElement && root.contains(tokenElement)
        ? tokenElement
        : null;
}

function parseRichEditor(root: HTMLElement | null): RichEditorSnapshot {
    if (!root) {
        return { displayContent: '', displayParts: [], contextTokens: [], fileTokens: [] };
    }

    const displayParts: InputDisplayPart[] = [];
    const contextTokens: InputContextToken[] = [];
    const fileTokens: InputContextToken[] = [];

    const appendText = (text: string) => {
        if (!text) return;
        const previous = displayParts[displayParts.length - 1];
        if (previous?.type === 'text') {
            previous.text += text;
            return;
        }
        displayParts.push({ type: 'text', text });
    };

    const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            appendText(node.textContent ?? '');
            return;
        }

        if (node instanceof HTMLBRElement) {
            appendText('\n');
            return;
        }

        if (isInlineTokenElement(node)) {
            const token = getTokenFromElement(node);
            displayParts.push({ type: 'token', token });
            contextTokens.push(token);
            if (token.type === 'file' || token.type === 'folder') {
                fileTokens.push(token);
            }
            return;
        }

        if (node instanceof HTMLElement && ['DIV', 'P'].includes(node.tagName) && displayParts.length > 0) {
            appendText('\n');
        }
        node.childNodes.forEach(visit);
    };

    root.childNodes.forEach(visit);

    return {
        displayContent: buildDisplayContent(displayParts).replace(/\u00a0/g, ' '),
        displayParts,
        contextTokens,
        fileTokens,
    };
}

function buildTokenDisplayParts(tokens: InputContextToken[]): InputDisplayPart[] {
    return tokens.flatMap((token, index) => {
        const parts: InputDisplayPart[] = [];
        if (index > 0) {
            parts.push({ type: 'text', text: ' ' });
        }
        parts.push({ type: 'token', token });
        return parts;
    });
}

function isWhitespaceTextNode(node: Node): node is Text {
    return node.nodeType === Node.TEXT_NODE && /^[\s\u00a0]*$/.test(node.textContent ?? '');
}

function normalizeClipboardRichNodes(nodes: Node[]): Node[] {
    const normalized = [...nodes];
    let firstNode = normalized[0];
    while (firstNode && isWhitespaceTextNode(firstNode)) {
        normalized.shift();
        firstNode = normalized[0];
    }
    let lastNode = normalized[normalized.length - 1];
    while (lastNode && isWhitespaceTextNode(lastNode)) {
        normalized.pop();
        lastNode = normalized[normalized.length - 1];
    }

    return normalized.map((node) => {
        if (!isWhitespaceTextNode(node)) return node;
        return document.createTextNode(' ');
    });
}

function buildRichNodesFromClipboardHtml(html: string): Node[] | null {
    if (!html.includes(INLINE_TOKEN_CLASS) && !html.includes(FILE_TOKEN_CLASS) && !html.includes(SKILL_TOKEN_CLASS)) {
        return null;
    }

    const template = document.createElement('template');
    template.innerHTML = html;
    if (!template.content.querySelector(`.${INLINE_TOKEN_CLASS}, .${FILE_TOKEN_CLASS}, .${SKILL_TOKEN_CLASS}`)) {
        return null;
    }
    const nodes: Node[] = [];

    const appendText = (text: string | null) => {
        if (!text) return;
        nodes.push(document.createTextNode(text));
    };

    const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            appendText(node.textContent);
            return;
        }

        if (node instanceof HTMLBRElement) {
            appendText('\n');
            return;
        }

        if (isInlineTokenElement(node)) {
            nodes.push(createInlineTokenElement(getTokenFromElement(node)));
            return;
        }

        node.childNodes.forEach(visit);
    };

    template.content.childNodes.forEach(visit);
    const normalizedNodes = normalizeClipboardRichNodes(nodes);
    return normalizedNodes.length > 0 ? normalizedNodes : null;
}

async function scanMentionFiles(params: {
    projectPath?: string | null;
    hubName?: string;
    agentName?: string;
}): Promise<FileMentionOption[]> {
    const { invoke } = await import('@tauri-apps/api/core');
    const files: FileMentionOption[] = [];
    const queue = [''];
    let scannedDirs = 0;

    while (queue.length > 0 && files.length < FILE_SCAN_LIMIT && scannedDirs < DIRECTORY_SCAN_LIMIT) {
        const relativePath = queue.shift() ?? '';
        scannedDirs += 1;

        let entries: DirectoryEntry[];
        if (params.projectPath) {
            entries = await invoke<DirectoryEntry[]>('file_list_project_directory', {
                rootDir: params.projectPath,
                relativePath,
            });
        } else if (params.hubName && params.agentName) {
            entries = await invoke<DirectoryEntry[]>('file_list_directory', {
                hubName: sanitizeFolderName(params.hubName),
                agentName: sanitizeFolderName(params.agentName),
                relativePath,
            });
        } else {
            return [];
        }

        for (const entry of entries) {
            if (entry.isDirectory) {
                if (!SKIPPED_FILE_SCAN_DIRS.has(entry.name)) {
                    files.push({
                        id: `folder:${entry.absolutePath}`,
                        kind: 'folder',
                        label: entry.name,
                        path: entry.absolutePath,
                        relativePath: entry.relativePath,
                    });
                    queue.push(entry.relativePath);
                }
                if (files.length >= FILE_SCAN_LIMIT) break;
                continue;
            }

            files.push({
                id: `file:${entry.absolutePath}`,
                kind: 'file',
                label: entry.name,
                path: entry.absolutePath,
                relativePath: entry.relativePath,
                size: entry.size,
            });

            if (files.length >= FILE_SCAN_LIMIT) break;
        }
    }

    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

// ==================== 类型定义 ====================

interface ChatInputProps {
    /** 占位符文本 */
    placeholder?: string;
    /** 是否禁用 */
    disabled?: boolean;
    /** 当前模式 */
    mode: ChatMode;
    /** 待引用列表 */
    pendingQuotes?: QuoteInfo[];
    /** 是否启用 @提及功能（仅 Hub 窗口启用，Agent 窗口禁用） */
    enableMention?: boolean;
    /** 是否启用附件功能（默认启用） */
    enableAttachment?: boolean;
    /** 当前附件列表 */
    attachments?: AttachmentInfo[];
    /** 当前 Agent ID（仅 Agent 窗口传入，用于显示项目按钮） */
    agentId?: string;
    /** 当前关联的外部项目路径 */
    projectPath?: string | null;
    hubName?: string;
    agentName?: string;
    /** 发送回调 */
    onSend: (content: string, options?: ChatInputSendOptions) => void;
    /** 模式切换回调 */
    onModeChange: (mode: ChatMode) => void;
    /** 移除引用回调 */
    onRemoveQuote?: (messageId: string) => void;
    /** 附件选择回调（支持多选） */
    onAttachmentAdd?: (filePaths: string[], options?: { targetDir?: string }) => void;
    /** 附件移除回调 */
    onAttachmentRemove?: (attachmentId: string) => void;
    /** 附件重排序回调 */
    onAttachmentReorder?: (reorderedAttachments: AttachmentInfo[]) => void;
    /** 是否正在流式输出 */
    isStreaming?: boolean;
    /** 停止输出回调 */
    onStop?: () => void;
    /** 当前模型名称（用于图像生成模型检测，禁用 Planning 模式） */
    modelName?: string;
    /** 运行期输入草稿隔离 key，不持久化到磁盘 */
    draftKey?: string;
    /** 外部请求恢复到输入框的草稿（例如撤回用户消息后回填原文） */
    restoreDraft?: ChatInputRestoreDraft | null;
}

export interface ChatInputSendOptions {
    displayContent?: string;
    displayParts?: InputDisplayPart[];
    contextTokens?: InputContextToken[];
}

export interface ChatInputRestoreDraft {
    id: string;
    value: string;
    displayParts?: InputDisplayPart[];
    contextTokens?: InputContextToken[];
}

type InputContextMenuAction = 'cut' | 'copy' | 'paste' | 'selectAll';

interface InputContextMenuState {
    x: number;
    y: number;
    hasSelection: boolean;
    hasValue: boolean;
}

// ==================== 组件实现 ====================

/**
 * ChatInput 输入区域组件
 */
export const ChatInput = memo(function ChatInput({
    placeholder,
    disabled = false,
    mode,
    pendingQuotes = [],
    enableMention = true,  // 默认启用，Hub 窗口使用
    enableAttachment = true,  // 默认启用附件功能
    attachments = [],
    agentId,
    projectPath,
    hubName,
    agentName,
    onSend,
    onModeChange,
    onRemoveQuote,
    onAttachmentAdd,
    onAttachmentRemove,
    onAttachmentReorder,
    isStreaming = false,
    onStop,
    modelName,
    draftKey,
    restoreDraft,
}: ChatInputProps) {
    const { t } = useI18n();
    const initialDraft = getChatInputDraft(draftKey);
    const [value, setValueState] = useState(initialDraft.value);
    const [isDragOver, setIsDragOver] = useState(false);
    const [inputContextMenu, setInputContextMenu] = useState<InputContextMenuState | null>(null);
    const [showSkillDropdown, setShowSkillDropdown] = useState(false);
    const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
    const [skillTrigger, setSkillTrigger] = useState<SkillSlashTrigger | null>(null);
    const [showFileDropdown, setShowFileDropdown] = useState(false);
    const [selectedFileIndex, setSelectedFileIndex] = useState(0);
    const [fileTrigger, setFileTrigger] = useState<FileMentionTrigger | null>(null);
    const [fileOptions, setFileOptions] = useState<FileMentionOption[]>([]);
    const [isLoadingFileOptions, setIsLoadingFileOptions] = useState(false);
    const [contextTokens, setContextTokensState] = useState<InputContextToken[]>(initialDraft.contextTokens);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const richEditorRef = useRef<HTMLDivElement | null>(null);
    const inputContextMenuRef = useRef<HTMLDivElement | null>(null);
    const skillDropdownRef = useRef<HTMLDivElement | null>(null);
    const fileDropdownRef = useRef<HTMLDivElement | null>(null);
    const dragCounterRef = useRef(0);  // 用于处理嵌套元素的 dragenter/dragleave
    const activeDraftKeyRef = useRef(draftKey);
    const valueRef = useRef(initialDraft.value);
    const contextTokensRef = useRef<InputContextToken[]>(initialDraft.contextTokens);
    const lastRestoreDraftIdRef = useRef<string | null>(null);
    const installedSkills = useRuntimeStore((s) => s.installedSkills);

    const getAttachmentTargetDir = useCallback(async () => {
        try {
            return await resolveAttachmentTargetDir({ projectPath, hubName, agentName });
        } catch (error) {
            logger.warn('[ChatInput] 解析附件保存目录失败，回退到默认目录:', error);
            return undefined;
        }
    }, [agentName, hubName, projectPath]);

    const setValue = useCallback((nextValue: string) => {
        valueRef.current = nextValue;
        setValueState(nextValue);
        saveChatInputDraft(activeDraftKeyRef.current, {
            value: nextValue,
            contextTokens: contextTokensRef.current,
        });
    }, []);

    const setRichEditorSnapshot = useCallback((snapshot: RichEditorSnapshot) => {
        valueRef.current = snapshot.displayContent;
        setValueState(snapshot.displayContent);
        saveChatInputDraft(activeDraftKeyRef.current, {
            value: snapshot.displayContent,
            contextTokens: contextTokensRef.current,
            displayParts: snapshot.displayParts,
        });
    }, []);

    const setContextTokens = useCallback((nextTokens: SetStateAction<InputContextToken[]>) => {
        setContextTokensState((previousTokens) => {
            const resolvedTokens = typeof nextTokens === 'function'
                ? nextTokens(previousTokens)
                : nextTokens;
            contextTokensRef.current = resolvedTokens;
            saveChatInputDraft(activeDraftKeyRef.current, {
                value: valueRef.current,
                contextTokens: resolvedTokens,
            });
            return resolvedTokens;
        });
    }, []);

    useLayoutEffect(() => {
        const nextDraft = getChatInputDraft(draftKey);
        activeDraftKeyRef.current = draftKey;
        valueRef.current = nextDraft.value;
        contextTokensRef.current = nextDraft.contextTokens;

        setValueState(nextDraft.value);
        setContextTokensState(nextDraft.contextTokens);
        setShowSkillDropdown(false);
        setSkillTrigger(null);
        setShowFileDropdown(false);
        setFileTrigger(null);

        if (!enableMention && richEditorRef.current) {
            renderRichEditorDraft(richEditorRef.current, nextDraft);
        }
    }, [draftKey, enableMention]);

    useEffect(() => {
        if (!restoreDraft || restoreDraft.id === lastRestoreDraftIdRef.current) return;

        lastRestoreDraftIdRef.current = restoreDraft.id;

        const restoredDraft: ChatInputDraft = {
            value: restoreDraft.value,
            contextTokens: restoreDraft.contextTokens ?? [],
            displayParts: restoreDraft.displayParts,
        };

        valueRef.current = restoredDraft.value;
        contextTokensRef.current = restoredDraft.contextTokens;
        setValueState(restoredDraft.value);
        setContextTokensState(restoredDraft.contextTokens);
        saveChatInputDraft(activeDraftKeyRef.current, restoredDraft);
        setShowSkillDropdown(false);
        setSkillTrigger(null);
        setShowFileDropdown(false);
        setFileTrigger(null);

        requestAnimationFrame(() => {
            if (!enableMention) {
                renderRichEditorDraft(richEditorRef.current, restoredDraft);
                focusRichEditorEnd(richEditorRef.current);
                return;
            }

            const textarea = textareaRef.current;
            textarea?.focus();
            textarea?.setSelectionRange(restoredDraft.value.length, restoredDraft.value.length);
        });
    }, [enableMention, restoreDraft]);

    const enabledSkillOptions = useMemo<SkillSlashOption[]>(
        () => installedSkills
            .filter(skill => skill.enabled)
            .map(skill => ({
                name: skill.name,
                description: skill.description,
                enabled: skill.enabled,
                mode: skill.mode,
                packagePath: skill.packagePath,
            })),
        [installedSkills]
    );

    const filteredSkillOptions = useMemo(
        () => filterSkillSlashOptions(enabledSkillOptions, skillTrigger?.query ?? ''),
        [enabledSkillOptions, skillTrigger]
    );

    const filteredFileOptions = useMemo(
        () => filterFileMentionOptions(fileOptions, fileTrigger?.query ?? ''),
        [fileOptions, fileTrigger]
    );

    // 发送消息
    const handleSend = useCallback(() => {
        const richSnapshot = enableMention ? null : parseRichEditor(richEditorRef.current);
        const displayContent = richSnapshot?.displayContent ?? value;
        const trimmed = displayContent.trim();
        const inlineContextTokens = richSnapshot?.contextTokens ?? [];
        const allContextTokens = [...contextTokens, ...inlineContextTokens];
        const contextPrefix = buildContextTokenPrefix(allContextTokens);
        const fileReferenceLines = richSnapshot?.fileTokens
            .filter(token => token.path)
            .map(token => t(
                token.type === 'folder' ? 'chat.folderReferenceLine' : 'chat.fileReferenceLine',
                { name: token.label, path: token.path ?? '' }
            ))
            .join('\n');
        const fileReferenceBlock = fileReferenceLines
            ? `${t('chat.fileReferenceHeader')}\n${fileReferenceLines}`
            : '';
        const content = [contextPrefix, trimmed, fileReferenceBlock].filter(Boolean).join('\n\n');
        if (!content || disabled) return;

        const contextDisplayParts = buildTokenDisplayParts(contextTokens);
        const displayParts = richSnapshot
            ? [
                ...contextDisplayParts,
                ...(contextDisplayParts.length > 0 && richSnapshot.displayParts.length > 0
                    ? [{ type: 'text' as const, text: ' ' }]
                    : []),
                ...richSnapshot.displayParts,
            ]
            : undefined;

        onSend(content, richSnapshot ? {
            displayContent: displayParts ? buildDisplayContent(displayParts) : [contextPrefix, trimmed].filter(Boolean).join(' '),
            displayParts,
            contextTokens: allContextTokens,
        } : undefined);
        setValue('');
        setContextTokens([]);
        setShowSkillDropdown(false);
        setSkillTrigger(null);
        setShowFileDropdown(false);
        setFileTrigger(null);
        if (richEditorRef.current) {
            richEditorRef.current.textContent = '';
        }
    }, [contextTokens, disabled, enableMention, onSend, setContextTokens, setValue, t, value]);

    const closeSkillDropdown = useCallback(() => {
        setShowSkillDropdown(false);
        setSkillTrigger(null);
        setSelectedSkillIndex(0);
    }, []);

    const closeFileDropdown = useCallback(() => {
        setShowFileDropdown(false);
        setFileTrigger(null);
        setSelectedFileIndex(0);
    }, []);

    const ensureFileOptions = useCallback(async () => {
        if (fileOptions.length > 0 || isLoadingFileOptions) return;

        setIsLoadingFileOptions(true);
        try {
            const files = await scanMentionFiles({ projectPath, hubName, agentName });
            setFileOptions(files);
        } catch (error) {
            logger.warn('[ChatInput] 加载文件提及列表失败:', error);
            setFileOptions([]);
        } finally {
            setIsLoadingFileOptions(false);
        }
    }, [agentName, fileOptions.length, hubName, isLoadingFileOptions, projectPath]);

    const updateSkillSlashState = useCallback((text: string, cursorPosition: number) => {
        if (enableMention) {
            closeSkillDropdown();
            return;
        }

        const trigger = findSkillSlashTrigger(text, cursorPosition);
        if (!trigger) {
            closeSkillDropdown();
            return;
        }

        setSkillTrigger((previous) => {
            const isSameTrigger =
                previous?.start === trigger.start &&
                previous.end === trigger.end &&
                previous.query === trigger.query;
            if (!isSameTrigger) {
                setSelectedSkillIndex(0);
            }
            return trigger;
        });
        setShowSkillDropdown(true);
    }, [closeSkillDropdown, enableMention]);

    const updateFileMentionState = useCallback((text: string, cursorPosition: number) => {
        if (enableMention) {
            closeFileDropdown();
            return;
        }

        const trigger = findFileMentionTrigger(text, cursorPosition);
        if (!trigger) {
            closeFileDropdown();
            return;
        }

        setFileTrigger((previous) => {
            const isSameTrigger =
                previous?.start === trigger.start &&
                previous.end === trigger.end &&
                previous.query === trigger.query;
            if (!isSameTrigger) {
                setSelectedFileIndex(0);
            }
            return trigger;
        });
        setShowFileDropdown(true);
        void ensureFileOptions();
    }, [closeFileDropdown, enableMention, ensureFileOptions]);

    const updateRichEditorState = useCallback(() => {
        const editor = richEditorRef.current;
        if (!editor) return;

        const snapshot = parseRichEditor(editor);
        const cursorPosition = getSelectionOffset(editor) ?? snapshot.displayContent.length;

        setRichEditorSnapshot(snapshot);
        updateSkillSlashState(snapshot.displayContent, cursorPosition);
        updateFileMentionState(snapshot.displayContent, cursorPosition);
    }, [setRichEditorSnapshot, updateFileMentionState, updateSkillSlashState]);

    const selectSkill = useCallback((skill: SkillSlashOption) => {
        if (!skillTrigger) return;

        const token: InputContextToken = {
            id: `skill:${skill.name}`,
            type: 'skill',
            label: skill.name,
            description: skill.description,
            path: skill.packagePath,
            badge: skill.mode === 'guide'
                ? t('chat.skillModeGuide')
                : t('chat.skillModeScript'),
            semanticText: t('chat.useSkillTemplate', { name: skill.name }),
        };

        if (!enableMention && richEditorRef.current) {
            const chip = createInlineTokenElement(token);
            replaceRichEditorTextRange(richEditorRef.current, skillTrigger.start, skillTrigger.end, [
                chip,
                document.createTextNode('\u00a0'),
            ]);
            closeSkillDropdown();
            requestAnimationFrame(() => {
                richEditorRef.current?.focus();
                updateRichEditorState();
            });
            return;
        }

        setContextTokens(prev => appendUniqueContextToken(prev, token));

        const beforeTrigger = value.slice(0, skillTrigger.start);
        const afterTrigger = value.slice(skillTrigger.end);
        const spacer = beforeTrigger.length > 0 && afterTrigger.length > 0 &&
            !/\s$/.test(beforeTrigger) && !/^\s/.test(afterTrigger)
            ? ' '
            : '';
        const nextValue = `${beforeTrigger}${spacer}${afterTrigger}`;
        const nextCursor = beforeTrigger.length + spacer.length;

        setValue(nextValue);
        closeSkillDropdown();

        requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            textarea?.focus();
            textarea?.setSelectionRange(nextCursor, nextCursor);
        });
    }, [closeSkillDropdown, enableMention, setContextTokens, setValue, skillTrigger, t, updateRichEditorState, value]);

    const removeToken = useCallback((tokenId: string) => {
        setContextTokens(prev => removeContextToken(prev, tokenId));
    }, [setContextTokens]);

    const selectFile = useCallback((file: FileMentionOption) => {
        if (!fileTrigger || !richEditorRef.current) return;

        const token: InputContextToken = {
            id: file.id,
            type: file.kind,
            label: file.label,
            path: file.path,
            relativePath: file.relativePath,
        };
        const chip = createInlineTokenElement(token);
        replaceRichEditorTextRange(richEditorRef.current, fileTrigger.start, fileTrigger.end, [
            chip,
            document.createTextNode('\u00a0'),
        ]);
        closeFileDropdown();

        requestAnimationFrame(() => {
            richEditorRef.current?.focus();
            updateRichEditorState();
        });
    }, [closeFileDropdown, fileTrigger, updateRichEditorState]);

    const openTokenPath = useCallback(async (token: InputContextToken) => {
        if (!token.path) return;

        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('file_open_system', {
                filePath: token.path,
            });
        } catch (error) {
            logger.warn('[ChatInput] 打开上下文路径失败:', error);
        }
    }, []);

    // 键盘事件 - 快捷发送
    const handleRichEditorMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const tokenElement = findClosestInlineTokenElement(e.target, richEditorRef.current);
        if (!tokenElement) return;

        e.preventDefault();
        e.stopPropagation();
        void openTokenPath(getTokenFromElement(tokenElement));
    }, [openTokenPath]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>) => {
        const tokenElement = findClosestInlineTokenElement(e.target, richEditorRef.current);
        if (tokenElement && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            e.stopPropagation();
            void openTokenPath(getTokenFromElement(tokenElement));
            return;
        }

        if (showFileDropdown) {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeFileDropdown();
                return;
            }

            if (filteredFileOptions.length > 0) {
                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        setSelectedFileIndex(prev =>
                            prev < filteredFileOptions.length - 1 ? prev + 1 : 0
                        );
                        return;
                    case 'ArrowUp':
                        e.preventDefault();
                        setSelectedFileIndex(prev =>
                            prev > 0 ? prev - 1 : filteredFileOptions.length - 1
                        );
                        return;
                    case 'Enter': {
                        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                            e.preventDefault();
                            const selected = filteredFileOptions[selectedFileIndex];
                            if (selected) {
                                selectFile(selected);
                            }
                            return;
                        }
                        break;
                    }
                    default:
                        break;
                }
            }
        }

        if (showSkillDropdown) {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeSkillDropdown();
                return;
            }

            if (filteredSkillOptions.length > 0) {
                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        setSelectedSkillIndex(prev =>
                            prev < filteredSkillOptions.length - 1 ? prev + 1 : 0
                        );
                        return;
                    case 'ArrowUp':
                        e.preventDefault();
                        setSelectedSkillIndex(prev =>
                            prev > 0 ? prev - 1 : filteredSkillOptions.length - 1
                        );
                        return;
                    case 'Enter': {
                        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                            e.preventDefault();
                            const selected = filteredSkillOptions[selectedSkillIndex];
                            if (selected) {
                                selectSkill(selected);
                            }
                            return;
                        }
                        break;
                    }
                    default:
                        break;
                }
            }
        }

        // Ctrl/Cmd + Enter 发送
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            handleSend();
        }
    }, [
        closeFileDropdown,
        closeSkillDropdown,
        filteredFileOptions,
        filteredSkillOptions,
        handleSend,
        openTokenPath,
        selectedFileIndex,
        selectedSkillIndex,
        selectFile,
        selectSkill,
        showFileDropdown,
        showSkillDropdown,
    ]);

    const closeInputContextMenu = useCallback(() => {
        setInputContextMenu(null);
    }, []);

    const getSelectionRange = useCallback(() => {
        const textarea = textareaRef.current;
        if (!textarea) return null;

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;

        return { start, end };
    }, []);

    const replaceTextareaRange = useCallback((start: number, end: number, insertText: string) => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const nextValue = value.slice(0, start) + insertText + value.slice(end);
        const nextCursor = start + insertText.length;

        setValue(nextValue);
        requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(nextCursor, nextCursor);
        });
    }, [setValue, value]);

    const writeClipboardText = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            logger.warn('[ChatInput] Clipboard API 写入失败:', error);
            return false;
        }
    }, []);

    const handleInputContextMenu = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
        e.preventDefault();
        e.stopPropagation();

        textareaRef.current = e.currentTarget;

        const start = e.currentTarget.selectionStart;
        const end = e.currentTarget.selectionEnd;

        setInputContextMenu({
            x: e.clientX,
            y: e.clientY,
            hasSelection: start !== end,
            hasValue: value.length > 0,
        });
    }, [value]);

    const handleInputContextMenuAction = useCallback(async (action: InputContextMenuAction) => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const range = getSelectionRange();
        if (!range) return;

        const { start, end } = range;
        const selectedText = value.slice(start, end);

        switch (action) {
            case 'cut': {
                if (disabled || !selectedText) break;
                const copied = await writeClipboardText(selectedText);
                if (copied) {
                    replaceTextareaRange(start, end, '');
                }
                break;
            }
            case 'copy': {
                if (selectedText) {
                    await writeClipboardText(selectedText);
                }
                break;
            }
            case 'paste': {
                if (disabled) break;
                try {
                    const clipboardText = await navigator.clipboard.readText();
                    if (clipboardText) {
                        replaceTextareaRange(start, end, clipboardText);
                    }
                } catch (error) {
                    logger.error('[ChatInput] 读取剪贴板失败:', error);
                }
                break;
            }
            case 'selectAll': {
                if (value.length > 0) {
                    textarea.focus();
                    textarea.select();
                }
                break;
            }
            default:
                break;
        }

        closeInputContextMenu();
    }, [closeInputContextMenu, disabled, getSelectionRange, replaceTextareaRange, value, writeClipboardText]);

    useEffect(() => {
        if (!inputContextMenu) return;

        const handleMouseDown = (event: MouseEvent) => {
            if (inputContextMenuRef.current && !inputContextMenuRef.current.contains(event.target as Node)) {
                closeInputContextMenu();
            }
        };

        const handleGlobalKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                closeInputContextMenu();
            }
        };

        document.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('keydown', handleGlobalKeyDown);
        window.addEventListener('resize', closeInputContextMenu);
        window.addEventListener('scroll', closeInputContextMenu, true);

        return () => {
            document.removeEventListener('mousedown', handleMouseDown);
            document.removeEventListener('keydown', handleGlobalKeyDown);
            window.removeEventListener('resize', closeInputContextMenu);
            window.removeEventListener('scroll', closeInputContextMenu, true);
        };
    }, [closeInputContextMenu, inputContextMenu]);

    useEffect(() => {
        if (!showSkillDropdown) return;

        const handleMouseDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (
                skillDropdownRef.current?.contains(target) ||
                textareaRef.current?.contains(target) ||
                richEditorRef.current?.contains(target)
            ) {
                return;
            }
            closeSkillDropdown();
        };

        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [closeSkillDropdown, showSkillDropdown]);

    useEffect(() => {
        if (!showFileDropdown) return;

        const handleMouseDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (
                fileDropdownRef.current?.contains(target) ||
                richEditorRef.current?.contains(target)
            ) {
                return;
            }
            closeFileDropdown();
        };

        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [closeFileDropdown, showFileDropdown]);

    useEffect(() => {
        setFileOptions([]);
        closeFileDropdown();
    }, [agentName, closeFileDropdown, hubName, projectPath]);

    // 附件选择处理（支持多选）
    const handleAttachmentSelect = useCallback(async (filePaths: string[]) => {
        const targetDir = await getAttachmentTargetDir();
        onAttachmentAdd?.(filePaths, targetDir ? { targetDir } : undefined);
    }, [getAttachmentTargetDir, onAttachmentAdd]);

    // 附件移除处理
    const handleAttachmentRemove = useCallback((id: string) => {
        onAttachmentRemove?.(id);
    }, [onAttachmentRemove]);

    // 附件重排序处理
    const handleAttachmentReorder = useCallback((reorderedAttachments: AttachmentInfo[]) => {
        onAttachmentReorder?.(reorderedAttachments);
    }, [onAttachmentReorder]);

    // ==================== 拖拽上传事件处理 ====================
    // 注意：已在 tauri.conf.json 中禁用 Tauri 全局拖拽 (dragDropEnabled: false)
    // 现在使用 HTML5 Drag API 处理文件拖放，以避免与附件排序拖拽冲突

    // 拖拽进入（保留作为视觉反馈备用）
    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // 检测是否为内部附件重排序拖拽（通过自定义 MIME 类型识别）
        // 如果是内部拖拽，不显示文件上传覆盖层
        if (e.dataTransfer.types.includes('application/x-attachment-reorder')) {
            return;
        }

        dragCounterRef.current++;
        if (e.dataTransfer.types.includes('Files')) {
            setIsDragOver(true);
        }
    }, []);

    // 拖拽离开
    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // 内部附件拖拽不处理
        if (e.dataTransfer.types.includes('application/x-attachment-reorder')) {
            return;
        }

        dragCounterRef.current--;
        if (dragCounterRef.current === 0) {
            setIsDragOver(false);
        }
    }, []);

    // 拖拽悬停（阻止默认行为）
    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // 内部附件拖拽不处理
        if (e.dataTransfer.types.includes('application/x-attachment-reorder')) {
            return;
        }
    }, []);

    // 释放文件（使用 HTML5 API 处理文件拖放）
    const handleDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // 内部附件拖拽由 AttachmentPreview 组件处理，此处不处理
        if (e.dataTransfer.types.includes('application/x-attachment-reorder')) {
            return;
        }

        dragCounterRef.current = 0;
        setIsDragOver(false);

        // 处理拖放的文件（使用 HTML5 API）
        if (!enableAttachment || disabled) return;

        const files = e.dataTransfer.files;
        if (files.length === 0) return;

        logger.debug('[ChatInput] HTML5 拖放文件:', files.length, '个');

        const { invoke } = await import('@tauri-apps/api/core');
        const targetDir = await getAttachmentTargetDir();
        const savedPaths: string[] = [];

        for (const file of files) {
            try {
                // 读取文件为 base64
                const arrayBuffer = await file.arrayBuffer();
                const uint8Array = new Uint8Array(arrayBuffer);
                let binary = '';
                for (const byte of uint8Array) {
                    binary += String.fromCharCode(byte);
                }
                const base64Data = btoa(binary);

                // 调用后端保存到当前附件目录
                const savedPath = await invoke<string>('save_dropped_file', {
                    base64Data,
                    fileName: file.name,
                    mimeType: file.type || 'application/octet-stream',
                    ...(targetDir ? { targetDir } : {}),
                });

                savedPaths.push(savedPath);
                logger.debug('[ChatInput] 文件已保存:', savedPath);
            } catch (error) {
                logger.error('[ChatInput] 处理拖放文件失败:', file.name, error);
            }
        }

        // 将所有保存的文件路径传递给附件上传流程
        if (savedPaths.length > 0) {
            onAttachmentAdd?.(savedPaths, targetDir ? { targetDir } : undefined);
        }
    }, [enableAttachment, disabled, getAttachmentTargetDir, onAttachmentAdd]);

    // ==================== 粘贴上传事件处理 ====================

    /**
     * 处理粘贴事件，从剪贴板读取图片并上传
     * 
     * 工作流程：
     * 1. 检测剪贴板中是否有图片
     * 2. 将图片转换为 base64
         * 3. 调用后端命令保存到当前附件目录
     * 4. 将临时文件路径传递给附件上传流程
     */
    const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
        if (!enableAttachment || disabled) return;

        const { items } = e.clipboardData;

        // 【关键】在进入任何异步操作之前，同步获取所有图片 File 对象
        // DataTransferItem 在异步操作后会失效，必须在同步阶段调用 getAsFile()
        const imageFiles: File[] = [];
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    imageFiles.push(file);
                }
            }
        }

        // 如果没有图片文件，让默认粘贴行为继续（粘贴文字）
        if (imageFiles.length === 0) return;

        // 阻止默认行为（防止图片被粘贴为文本或其他格式）
        e.preventDefault();

        // 现在可以安全地进行异步操作，因为 File 对象已经获取
        const { invoke } = await import('@tauri-apps/api/core');
        const targetDir = await getAttachmentTargetDir();
        const savedPaths: string[] = [];

        for (const file of imageFiles) {
            try {
                // 读取 file 为 base64
                const arrayBuffer = await file.arrayBuffer();
                const uint8Array = new Uint8Array(arrayBuffer);
                let binary = '';
                for (const byte of uint8Array) {
                    binary += String.fromCharCode(byte);
                }
                const base64Data = btoa(binary);

                // 调用后端保存到当前附件目录
                const savedPath = await invoke<string>('save_clipboard_image', {
                    base64Data,
                    mimeType: file.type,
                    ...(targetDir ? { targetDir } : {}),
                });

                savedPaths.push(savedPath);
            } catch (error) {
                logger.error('[ChatInput] 处理剪贴板图片失败:', error);
            }
        }

        // 将所有保存的文件路径传递给附件上传流程
        if (savedPaths.length > 0) {
            onAttachmentAdd?.(savedPaths, targetDir ? { targetDir } : undefined);
        }
    }, [enableAttachment, disabled, getAttachmentTargetDir, onAttachmentAdd]);

    const canSend = (value.trim().length > 0 || contextTokens.length > 0) && !disabled;
    const inputContextMenuStyle = inputContextMenu
        ? {
            left: Math.min(inputContextMenu.x, window.innerWidth - 168),
            top: Math.min(inputContextMenu.y, window.innerHeight - 180),
        }
        : undefined;

    return (
        <div className={styles.inputArea}>
            {/* 附件预览 - 在拖放区域外部 */}
            {attachments.length > 0 && (
                <AttachmentPreview
                    attachments={attachments}
                    onRemove={handleAttachmentRemove}
                    onReorder={handleAttachmentReorder}
                    enableDrag={true}
                />
            )}

            {/* 引用预览 */}
            {pendingQuotes.length > 0 && (
                <QuotePreview
                    quotes={pendingQuotes}
                    onRemove={onRemoveQuote}
                />
            )}

            {contextTokens.length > 0 && (
                <div className={styles.skillContextBar} aria-label={t('chat.skillContextLabel')}>
                    <span className={styles.skillContextLabel}>{t('chat.skillContextLabel')}</span>
                    <div className={styles.skillChipList}>
                        {contextTokens.map(token => (
                            <span className={styles.skillChip} key={token.id}>
                                <button
                                    type="button"
                                    className={styles.skillChipMain}
                                    onClick={() => { void openTokenPath(token); }}
                                    disabled={!token.path}
                                    title={token.path
                                        ? t(token.type === 'folder'
                                            ? 'chat.openFolderPath'
                                            : token.type === 'skill'
                                                ? 'chat.openSkillPath'
                                                : 'chat.openFilePath', { path: token.path })
                                        : token.label}
                                >
                                    <Toolbox size={13} className={styles.skillChipIcon} aria-hidden="true" />
                                    <span className={styles.skillChipLabel}>{token.label}</span>
                                </button>
                                {token.badge && (
                                    <span className={styles.skillChipBadge}>{token.badge}</span>
                                )}
                                <button
                                    type="button"
                                    className={styles.skillChipRemove}
                                    onClick={() => removeToken(token.id)}
                                    aria-label={t('chat.removeSkillContext', { name: token.label })}
                                    title={t('chat.removeSkillContext', { name: token.label })}
                                >
                                    <X size={14} />
                                </button>
                            </span>
                        ))}
                    </div>
                </div>
            )}

            <div className={styles.composer}>
            {/* 输入框容器 - 拖放事件只在这里触发 */}
            <div
                className={cx(styles.inputWrapper, isDragOver && styles.dragActive)}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
            >
                {/* 拖拽视觉反馈覆盖层 */}
                {isDragOver && (
                    <div className={styles.dropOverlay}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        {t('chat.dropFiles')}
                    </div>
                )}

                <div
                    className={styles.textareaWrapper}
                    onPaste={handlePaste}
                    data-custom-context-menu
                >
                    {enableMention ? (
                        // Hub 窗口：使用 MentionInput 支持 @提及
                        <MentionInput
                            value={value}
                            onChange={setValue}
                            placeholder={placeholder ?? t('chat.defaultPlaceholder')}
                            disabled={disabled}
                            onKeyDown={handleKeyDown}
                            textareaRef={textareaRef}
                            onContextMenu={handleInputContextMenu}
                        />
                    ) : (
                        // Agent 窗口：使用 rich editor 支持内联 @file chip。
                        <div
                            ref={richEditorRef}
                            className={styles.richEditor}
                            contentEditable={!disabled}
                            role="textbox"
                            aria-multiline="true"
                            data-placeholder={placeholder ?? t('chat.defaultPlaceholder')}
                            suppressContentEditableWarning
                            onMouseDown={handleRichEditorMouseDown}
                            onInput={updateRichEditorState}
                            onClick={updateRichEditorState}
                            onKeyUp={(e) => {
                                if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
                                    return;
                                }
                                updateRichEditorState();
                            }}
                            onKeyDown={handleKeyDown}
                            onPaste={(e) => {
                                const html = e.clipboardData.getData('text/html');
                                const richNodes = buildRichNodesFromClipboardHtml(html);
                                if (richNodes) {
                                    e.preventDefault();
                                    insertNodesAtRichEditorSelection(richEditorRef.current, richNodes);
                                    requestAnimationFrame(updateRichEditorState);
                                    return;
                                }

                                const text = e.clipboardData.getData('text/plain');
                                if (!text || e.clipboardData.files.length > 0) return;
                                e.preventDefault();
                                insertTextAtRichEditorSelection(richEditorRef.current, text);
                                requestAnimationFrame(updateRichEditorState);
                            }}
                        />
                    )}
                    {!enableMention && showSkillDropdown && (
                        <div className={styles.skillDropdown} ref={skillDropdownRef}>
                            <div className={styles.skillDropdownHeader}>
                                {t('chat.skillSlashHeader')}
                            </div>
                            {filteredSkillOptions.length > 0 ? (
                                filteredSkillOptions.map((skill, index) => (
                                    <button
                                        key={skill.name}
                                        className={styles.skillOption}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => selectSkill(skill)}
                                        data-selected={index === selectedSkillIndex}
                                        title={skill.description}
                                    >
                                        <span className={styles.skillOptionIcon}>/</span>
                                        <span className={styles.skillOptionText}>
                                            <span className={styles.skillOptionName}>{skill.name}</span>
                                            {skill.description && (
                                                <span className={styles.skillOptionDesc}>{skill.description}</span>
                                            )}
                                        </span>
                                        {skill.mode && (
                                            <span className={styles.skillOptionMode}>
                                                {skill.mode === 'guide'
                                                    ? t('chat.skillModeGuide')
                                                    : t('chat.skillModeScript')}
                                            </span>
                                        )}
                                    </button>
                                ))
                            ) : (
                                <div className={styles.skillEmpty}>
                                    {t('chat.skillSlashEmpty')}
                                </div>
                            )}
                        </div>
                    )}
                    {!enableMention && showFileDropdown && (
                        <div className={styles.skillDropdown} ref={fileDropdownRef}>
                            <div className={styles.skillDropdownHeader}>
                                {t('chat.fileMentionHeader')}
                            </div>
                            {isLoadingFileOptions ? (
                                <div className={styles.skillEmpty}>
                                    {t('chat.fileMentionLoading')}
                                </div>
                            ) : filteredFileOptions.length > 0 ? (
                                filteredFileOptions.map((file, index) => (
                                    <button
                                        key={file.id}
                                        className={styles.skillOption}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => selectFile(file)}
                                        data-selected={index === selectedFileIndex}
                                        title={file.path}
                                    >
                                        <span className={styles.skillOptionIcon}>
                                            {file.kind === 'folder' ? <Folder size={14} /> : <FileText size={14} />}
                                        </span>
                                        <span className={styles.skillOptionText}>
                                            <span className={styles.skillOptionName}>{file.label}</span>
                                            <span className={styles.skillOptionDesc}>{file.relativePath}</span>
                                        </span>
                                    </button>
                                ))
                            ) : (
                                <div className={styles.skillEmpty}>
                                    {t('chat.fileMentionEmpty')}
                                </div>
                            )}
                        </div>
                    )}
                    {inputContextMenu && (
                        <div
                            ref={inputContextMenuRef}
                            className={styles.contextMenu}
                            style={inputContextMenuStyle}
                        >
                            <button
                                className={styles.menuItem}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { void handleInputContextMenuAction('cut'); }}
                                disabled={disabled || !inputContextMenu.hasSelection}
                            >
                                <Scissors size={16} />
                                {t('common.cut')}
                            </button>
                            <button
                                className={styles.menuItem}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { void handleInputContextMenuAction('copy'); }}
                                disabled={!inputContextMenu.hasSelection}
                            >
                                <Copy size={16} />
                                {t('common.copy')}
                            </button>
                            <button
                                className={styles.menuItem}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { void handleInputContextMenuAction('paste'); }}
                                disabled={disabled}
                            >
                                <ClipboardPaste size={16} />
                                {t('common.paste')}
                            </button>
                            <div className={styles.divider} />
                            <button
                                className={styles.menuItem}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { void handleInputContextMenuAction('selectAll'); }}
                                disabled={!inputContextMenu.hasValue}
                            >
                                <TextSelect size={16} />
                                {t('common.selectAll')}
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* 工具栏 */}
            <div className={styles.toolbar}>
                <div className={styles.toolbarLeft}>
                    <ModeSelector
                        mode={mode}
                        onChange={onModeChange}
                        disabled={disabled}
                        modelName={modelName}
                    />
                    {enableAttachment && (
                        <AttachmentButton
                            onFileSelect={handleAttachmentSelect}
                            disabled={disabled}
                        />
                    )}
                    {/* 项目路径按钮：仅 Agent 窗口显示（agentId 存在时） */}
                    {agentId && (
                        <ProjectPathButton
                            agentId={agentId}
                            projectPath={projectPath}
                            disabled={disabled}
                        />
                    )}
                </div>
                <div className={styles.toolbarRight}>
                    <span className={styles.shortcutHint}>{t('chat.sendShortcut')}</span>
                    {isStreaming ? (
                        // 流式输出中：显示停止按钮
                        <button
                            className={cx(styles.sendBtn, styles.stopBtn)}
                            onClick={onStop}
                            aria-label={t('chat.stopOutput')}
                        >
                            <Square size={16} fill="currentColor" />
                        </button>
                    ) : (
                        // 非流式：显示发送按钮
                        <button
                            className={styles.sendBtn}
                            onClick={handleSend}
                            disabled={!canSend}
                            aria-label={t('chat.sendMessage')}
                        >
                            <ArrowBigRightDash size={18} />
                        </button>
                    )}
                </div>
            </div>
            </div>
        </div>
    );
});
