/**
 * MentionInput - @提及自动补全组件
 * 
 * 功能：
 * - 检测输入中的 @ 字符
 * - 弹出 Agent 列表供选择
 * - 支持键盘导航
 */

import { useState, useCallback, useRef, useEffect, memo, useMemo } from 'react';
import { useAgentStore } from '@stores/agentStore';
import { useI18n } from '@/i18n';
import styles from './MentionInput.module.css';

// ==================== 类型定义 ====================

interface MentionInputProps {
    /** 输入框值 */
    value: string;
    /** 值变更回调 */
    onChange: (value: string) => void;
    /** 占位符 */
    placeholder?: string;
    /** 是否禁用 */
    disabled?: boolean;
    /** 键盘事件回调（用于传递快捷键） */
    onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    textareaRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
    onContextMenu?: (e: React.MouseEvent<HTMLTextAreaElement>) => void;
}

interface AgentOption {
    id: string;
    name: string;
}

// ==================== 组件实现 ====================

/**
 * MentionInput @提及输入组件
 */
export const MentionInput = memo(function MentionInput({
    value,
    onChange,
    placeholder,
    disabled = false,
    onKeyDown,
    textareaRef: externalTextareaRef,
    onContextMenu,
}: MentionInputProps) {
    const { t } = useI18n();
    const [showDropdown, setShowDropdown] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [mentionQuery, setMentionQuery] = useState('');
    const [cursorPosition, setCursorPosition] = useState(0);

    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const dropdownRef = useRef<HTMLDivElement | null>(null);

    const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;
        if (externalTextareaRef) {
            externalTextareaRef.current = node;
        }
    }, [externalTextareaRef]);

    const agents = useAgentStore((state) => state.agents);

    // 筛选 Agent 列表
    const filteredAgents = useMemo<AgentOption[]>(() => {
        if (!mentionQuery) {
            return agents.map(a => ({ id: a.id, name: a.name }));
        }
        const query = mentionQuery.toLowerCase();
        return agents
            .filter(a => a.name.toLowerCase().includes(query))
            .map(a => ({ id: a.id, name: a.name }));
    }, [agents, mentionQuery]);

    // 检测 @ 字符
    const checkForMention = useCallback((text: string, cursorPos: number) => {
        // 从光标位置向前查找 @
        const beforeCursor = text.slice(0, cursorPos);
        const lastAtIndex = beforeCursor.lastIndexOf('@');

        if (lastAtIndex === -1) {
            setShowDropdown(false);
            return;
        }

        // 确保 @ 之前是空格或开头
        if (lastAtIndex > 0 && !/\s/.test(beforeCursor[lastAtIndex - 1] ?? '')) {
            setShowDropdown(false);
            return;
        }

        // 检查 @ 之后是否有空格（已完成的提及）
        const afterAt = beforeCursor.slice(lastAtIndex + 1);
        if (/\s/.test(afterAt)) {
            setShowDropdown(false);
            return;
        }

        // 提取查询词
        setMentionQuery(afterAt);
        setShowDropdown(true);
        setSelectedIndex(0);
    }, []);

    // 输入变更
    const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = e.target.value;
        const cursorPos = e.target.selectionStart;

        onChange(newValue);
        setCursorPosition(cursorPos);
        checkForMention(newValue, cursorPos);
    }, [onChange, checkForMention]);

    // 选择 Agent
    const selectAgent = useCallback((agent: AgentOption) => {
        const beforeCursor = value.slice(0, cursorPosition);
        const lastAtIndex = beforeCursor.lastIndexOf('@');
        const afterCursor = value.slice(cursorPosition);

        // 如果名称包含空格，用引号包裹以便正确解析
        const formattedName = agent.name.includes(' ')
            ? `"${agent.name}"`
            : agent.name;

        // 替换 @query 为 @AgentName 或 @"Agent Name"
        const newValue = value.slice(0, lastAtIndex) + `@${formattedName} ` + afterCursor;
        onChange(newValue);

        setShowDropdown(false);
        setMentionQuery('');

        // 聚焦回输入框
        textareaRef.current?.focus();
    }, [value, cursorPosition, onChange]);

    // 键盘导航
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (showDropdown && filteredAgents.length > 0) {
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    setSelectedIndex((prev) =>
                        prev < filteredAgents.length - 1 ? prev + 1 : 0
                    );
                    return;
                case 'ArrowUp':
                    e.preventDefault();
                    setSelectedIndex((prev) =>
                        prev > 0 ? prev - 1 : filteredAgents.length - 1
                    );
                    return;
                case 'Enter':
                    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                        e.preventDefault();
                        const selected = filteredAgents[selectedIndex];
                        if (selected) {
                            selectAgent(selected);
                        }
                        return;
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    setShowDropdown(false);
                    return;
            }
        }

        // 传递其他键盘事件
        onKeyDown?.(e);
    }, [showDropdown, filteredAgents, selectedIndex, selectAgent, onKeyDown]);

    // 自动调整高度
    useEffect(() => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
        }
    }, [value]);

    // 点击外部关闭
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setShowDropdown(false);
            }
        }

        if (showDropdown) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [showDropdown]);

    return (
        <div className={styles.container}>
            <textarea
                ref={setTextareaRef}
                className={styles.textarea}
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onContextMenu={onContextMenu}
                placeholder={placeholder ?? t('chat.defaultPlaceholder')}
                rows={1}
                disabled={disabled}
            />

            {showDropdown && filteredAgents.length > 0 && (
                <div className={styles.dropdown} ref={dropdownRef}>
                    {filteredAgents.map((agent, index) => (
                        <button
                            key={agent.id}
                            className={styles.option}
                            onClick={() => selectAgent(agent)}
                            data-selected={index === selectedIndex}
                        >
                            <span className={styles.optionAvatar}>
                                {agent.name.charAt(0).toUpperCase()}
                            </span>
                            <span className={styles.optionName}>{agent.name}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
});
