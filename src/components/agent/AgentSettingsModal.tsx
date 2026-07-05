import { useCallback, useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { useAgentStore, type AgentSandboxMode } from '@stores/agentStore';
import { useRuntimeStore } from '@stores/runtimeStore';
import { MemoryPanel } from '@components/memory';
import { ConfirmDialog } from '@components/ui/ConfirmDialog';
import { TextContextMenu, Tooltip, useTextContextMenu } from '@components/ui';
import { getRagService } from '@services/rag';
import { PLANNING_CONSTANTS } from '@services/planning/PlanningConstants';
import { imageCompressionService } from '@services/attachment';
import { CronSettingsTab } from './CronSettingsTab';
import { AvatarCropper } from './AvatarCropper';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import {
    DEFAULT_SAFETY_FOOTER_BODY_TEXT,
    normalizeSafetyFooterBodyText,
} from '@services/planning/sub-agents/SubAgentSafetyFooter';
import styles from './AgentSettingsModal.module.css';
import { getLogger } from '@services/logger';

const logger = getLogger('AgentSettingsModal');

interface AgentSettingsModalProps {
    isOpen: boolean;
    agentId: string | null;
    onClose: () => void;
}

type TabId = 'basic' | 'rules' | 'knowledge' | 'skills' | 'memory' | 'cron';

const SANDBOX_MODE_OPTIONS: AgentSandboxMode[] = ['LocalAudit', 'ControlledNetwork', 'OfflineIsolated'];

/**
 * AgentSettingsModal 组件
 *
 * Agent设置弹窗，多标签页结构：
 * - 基础：名称设置
 * - Rules：直接粘贴 Agent 规则
 * - 知识库：知识库文件管理
 * - 模型：模型选择
 * - 记忆：记忆管理（预留）
 */
export function AgentSettingsModal({ isOpen, agentId, onClose }: AgentSettingsModalProps) {
    const { t } = useI18n();
    const agents = useAgentStore((state) => state.agents);
    const updateAgent = useAgentStore((state) => state.updateAgent);
    const {
        menu: textContextMenu,
        closeMenu: closeTextContextMenu,
        openEditableMenu,
        handleMenuAction,
    } = useTextContextMenu();

    const [activeTab, setActiveTab] = useState<TabId>('basic');
    const [isSaving, setIsSaving] = useState(false);

    // 表单状态
    const [name, setName] = useState('');
    const [nameError, setNameError] = useState<string | null>(null);
    const [mbRules, setMbRules] = useState('');
    const [saRules, setSaRules] = useState('');
    const [chatRules, setChatRules] = useState('');
    const [knowledgePaths, setKnowledgePaths] = useState<string[]>([]);

    // 知识库索引状态：pending | indexing | indexed | error
    type FileIndexStatus = 'pending' | 'indexing' | 'indexed' | 'error';
    const [fileIndexStatus, setFileIndexStatus] = useState<Record<string, FileIndexStatus>>({});
    const [indexingProgress, setIndexingProgress] = useState<{ current: number; total: number; fileName: string } | null>(null);

    // 删除确认对话框状态
    const [deleteKnowledgeConfirmOpen, setDeleteKnowledgeConfirmOpen] = useState(false);
    const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    // 交付物自动同步开关
    const [autoIndexDeliverables, setAutoIndexDeliverables] = useState(true);
    const [visualEnhancementEnabled, setVisualEnhancementEnabled] = useState(true);

    // per-agent MB 决策轮次（null 表示使用全局默认）
    const [planningLoopBudget, setPlanningLoopBudget] = useState<number | null>(null);
    const [sandboxMode, setSandboxMode] = useState<AgentSandboxMode>('LocalAudit');
    const [subAgentSafetyFooterEnabled, setSubAgentSafetyFooterEnabled] = useState(false);
    const [subAgentSafetyFooterText, setSubAgentSafetyFooterText] = useState(DEFAULT_SAFETY_FOOTER_BODY_TEXT);

    // 精准命中技能状态
    const [pinnedSkillsEnabled, setPinnedSkillsEnabled] = useState(false);
    const [pinnedSkillNames, setPinnedSkillNames] = useState<string[]>([]);
    // 从 runtimeStore 获取已安装的外部技能列表
    const installedSkills = useRuntimeStore((s) => s.installedSkills);
    const pinnedSkillsMaxCount = PLANNING_CONSTANTS.PINNED_SKILLS_MAX_COUNT;
    const defaultDecisionRounds = PLANNING_CONSTANTS.LOOP_GOVERNOR_INITIAL_BUDGET;

    // 多选模式状态
    const [isSelectMode, setIsSelectMode] = useState(false);
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);

    // 头像状态
    const [avatar, setAvatar] = useState<string | null>(null); // base64
    const [showCropper, setShowCropper] = useState(false);
    const [cropperImageUrl, setCropperImageUrl] = useState<string>('');

    // 获取当前Agent
    const agent = agents.find((a) => a.id === agentId);

    // 追踪上一次的 isOpen 状态，用于判断是否是首次打开
    const prevIsOpenRef = useRef(false);

    // 初始化表单（从后端加载 Agent 数据，包括 rules 和 knowledge）
    useEffect(() => {
        // 只在弹窗从关闭到打开时初始化，避免 agent 更新时重置标签页
        const wasOpen = prevIsOpenRef.current;
        prevIsOpenRef.current = isOpen;

        if (isOpen && agent) {
            setName(agent.name);
            // 初始化头像
            setAvatar(agent.avatar ?? null);
            setShowCropper(false);
            // 从 Agent 数据中读取直接粘贴的 Rules 文本；旧版文件路径在下方异步迁移为文本预填
            setMbRules(agent.mbRules ?? '');
            setSaRules(agent.saRules ?? '');
            setChatRules(agent.chatRules ?? '');
            if (!agent.mbRules && agent.mbRulesFilePath) {
                readTextFile(agent.mbRulesFilePath)
                    .then((content) => setMbRules(content))
                    .catch((err: unknown) => logger.warn('[Settings] 读取旧版 MB Rules 文件失败:', err));
            }
            if (!agent.saRules && agent.saRulesFilePath) {
                readTextFile(agent.saRulesFilePath)
                    .then((content) => setSaRules(content))
                    .catch((err: unknown) => logger.warn('[Settings] 读取旧版 SA Rules 文件失败:', err));
            }
            if (!agent.chatRules) {
                const legacyRulesPaths = [...new Set([
                    agent.mbRulesFilePath,
                    agent.saRulesFilePath,
                ].filter(Boolean) as string[])];
                if (legacyRulesPaths.length > 0) {
                    Promise.all(legacyRulesPaths.map(async (path) => (await readTextFile(path)).trim()))
                        .then((contents) => setChatRules(contents.filter(Boolean).join('\n\n')))
                        .catch((err: unknown) => logger.warn('[Settings] 读取旧版 Chat Rules 文件失败:', err));
                }
            }
            // knowledge_paths 是 JSON 数组存储
            const kp = agent.knowledgePaths;
            if (kp) {
                try {
                    const paths = JSON.parse(kp) as string[];
                    setKnowledgePaths(paths);
                    // 已存在的文件标记为 indexed（它们在之前保存时已被索引）
                    const statusMap: Record<string, 'indexed'> = {};
                    paths.forEach(p => { statusMap[p] = 'indexed'; });
                    setFileIndexStatus(statusMap);
                } catch {
                    setKnowledgePaths([]);
                    setFileIndexStatus({});
                }
            } else {
                setKnowledgePaths([]);
                setFileIndexStatus({});
            }
            // 初始化交付物自动同步开关（默认 true）
            setAutoIndexDeliverables(agent.autoIndexDeliverables !== false);
            setVisualEnhancementEnabled(agent.visualEnhancementEnabled !== false);
            // 重置多选模式
            setIsSelectMode(false);
            setSelectedPaths(new Set());
            // 初始化精准命中技能状态
            const ps = agent.pinnedSkills;
            if (ps) {
                try {
                    const parsed = JSON.parse(ps) as unknown;
                    const pinnedNames = Array.isArray(parsed)
                        ? parsed
                            .filter((name): name is string => typeof name === 'string')
                            .slice(0, pinnedSkillsMaxCount)
                        : [];
                    if (pinnedNames.length > 0) {
                        setPinnedSkillsEnabled(true);
                        setPinnedSkillNames(pinnedNames);
                    } else {
                        setPinnedSkillsEnabled(false);
                        setPinnedSkillNames([]);
                    }
                } catch {
                    setPinnedSkillsEnabled(false);
                    setPinnedSkillNames([]);
                }
            } else {
                setPinnedSkillsEnabled(false);
                setPinnedSkillNames([]);
            }
            // 初始化 per-agent MB 决策轮次（null = 使用全局默认）
            setPlanningLoopBudget(agent.planningLoopBudget ?? null);
            setSandboxMode(agent.sandboxMode ?? 'LocalAudit');
            setSubAgentSafetyFooterEnabled(agent.subAgentSafetyFooterEnabled === true);
            setSubAgentSafetyFooterText(normalizeSafetyFooterBodyText(agent.subAgentSafetyFooterText));
            // 只在首次打开时重置到基础标签，删除文件后保持在当前标签
            if (!wasOpen) {
                setActiveTab('basic');
            }
        }
    }, [isOpen, agent, pinnedSkillsMaxCount]);

    // 关闭时重置
    useEffect(() => {
        if (!isOpen) {
            setIsSaving(false);
        }
    }, [isOpen]);

    // 保存设置
    const handleSave = useCallback(async () => {
        if (!agentId || !agent) return;

        const trimmedName = name.trim();
        if (!trimmedName) {
            // 名称不能为空（虽然 UI 不应该允许这种情况）
            return;
        }

        // 如果名称被修改，检查同 Hub 下是否有同名 Agent（排除自己）
        if (trimmedName.toLowerCase() !== agent.name.toLowerCase()) {
            const sameHubAgents = useAgentStore.getState().agents.filter(
                a => a.hubId === agent.hubId && a.id !== agentId
            );
            const isDuplicate = sameHubAgents.some(a => a.name.toLowerCase() === trimmedName.toLowerCase());
            if (isDuplicate) {
                setNameError(t('agent.create.duplicateName'));
                return;
            }
        }

        setIsSaving(true);

        try {
            const boundedPinnedSkillNames = pinnedSkillNames.slice(0, pinnedSkillsMaxCount);
            const request: Record<string, unknown> = {
                name: name.trim(),
            };

            // 头像：有值则设置，null 则清除（传空字符串）
            if (avatar) {
                request.avatar = avatar;
            } else if (agent.avatar) {
                // 原来有头像，现在清除
                request.avatar = '';
            }

            request.mb_rules = mbRules;
            request.sa_rules = saRules;
            request.chat_rules = chatRules;

            // 保存粘贴式 Rules 后清除旧版文件路径，避免隐藏 fallback 继续影响 Agent 行为
            if (agent.mbRulesFilePath) {
                request.mb_rules_file_path = '';
            }
            if (agent.saRulesFilePath) {
                request.sa_rules_file_path = '';
            }

            // 知识库路径：有值则设置 JSON，否则清除
            if (knowledgePaths.length > 0) {
                request.knowledge_paths = JSON.stringify(knowledgePaths);
            } else if (agent.knowledgePaths) {
                // 原来有值，现在清除
                request.knowledge_paths = '';
            }

            // 精准命中技能：启用且有选中技能则存储 JSON 数组，否则清除
            if (pinnedSkillsEnabled && boundedPinnedSkillNames.length > 0) {
                request.pinned_skills = JSON.stringify(boundedPinnedSkillNames);
            } else if (agent.pinnedSkills) {
                // 原来有值，现在关闭或清空
                request.pinned_skills = '';
            }

            // 决策轮次：有值则传内容（健寡边界），null 表示用户要重置为默认
            if (planningLoopBudget !== null) {
                // 健寡边界，与 UI 的 min/max 保持一致
                request.planning_loop_budget = Math.max(3, Math.min(20, planningLoopBudget));
            } else if (agent.planningLoopBudget !== null && agent.planningLoopBudget !== undefined) {
                // 用户把原有值清除了，传 0 让后端写 NULL（哨兵值约定）
                request.planning_loop_budget = 0;
            }
            request.sandbox_mode = sandboxMode;
            request.visual_enhancement_enabled = visualEnhancementEnabled;
            request.sub_agent_safety_footer_enabled = subAgentSafetyFooterEnabled;
            const safetyFooterTextForSave = normalizeSafetyFooterBodyText(subAgentSafetyFooterText);
            request.sub_agent_safety_footer_text = safetyFooterTextForSave;

            // ================================================================
            // 知识库向量索引同步
            // ================================================================
            const ragService = getRagService();
            const oldPaths: string[] = agent.knowledgePaths
                ? JSON.parse(agent.knowledgePaths) as unknown as string[]
                : [];

            // 辅助函数：检测文档类型
            const detectDocType = (fileName: string): 'markdown' | 'text' | 'code' => {
                const ext = fileName.split('.').pop()?.toLowerCase();
                if (ext === 'md' || ext === 'markdown') return 'markdown';
                if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java'].includes(ext ?? '')) return 'code';
                return 'text';
            };

            // 删除已移除文件的索引（documentId 统一使用 filePath）
            const removedPaths = oldPaths.filter(p => !knowledgePaths.includes(p));
            for (const path of removedPaths) {
                try {
                    await ragService.deleteDocumentIndex(agentId, path);
                    logger.trace(`[Knowledge] 已删除索引: ${path}`);
                } catch (err) {
                    logger.warn(`[Knowledge] 删除索引失败: ${path}`, err);
                }
            }

            // 索引新增文件（带进度跟踪）
            const addedPaths = knowledgePaths.filter(p => !oldPaths.includes(p));
            const totalToIndex = addedPaths.length;

            for (let i = 0; i < addedPaths.length; i++) {
                const path = addedPaths[i];
                if (path === undefined || path.length === 0) continue;
                const fileName = path.split(/[/\\]/).pop() ?? '';

                // 更新进度状态
                setIndexingProgress({ current: i + 1, total: totalToIndex, fileName });
                setFileIndexStatus(prev => ({ ...prev, [path]: 'indexing' }));

                try {
                    const content = await readTextFile(path);
                    const chunkCount = await ragService.indexDocument(agentId, path, content, {
                        fileName,
                        filePath: path,
                        documentType: detectDocType(fileName),
                    });
                    logger.debug(`[Knowledge] 已索引: ${fileName} (${chunkCount} 个分块)`);
                    setFileIndexStatus(prev => ({ ...prev, [path]: 'indexed' }));
                } catch (err) {
                    setFileIndexStatus(prev => ({ ...prev, [path]: 'error' }));
                    logger.error(`[Knowledge] 索引失败: ${path}`, err);
                }
            }

            // 清除进度状态
            setIndexingProgress(null);

            // 调用 Tauri 命令更新
            await invoke('agent_update', {
                id: agentId,
                request,
            });

            // 更新 Store
            updateAgent(agentId, {
                name: name.trim(),
                avatar: avatar ?? undefined,
                mbRulesFilePath: null,
                saRulesFilePath: null,
                mbRules: mbRules.trim() ? mbRules : null,
                saRules: saRules.trim() ? saRules : null,
                chatRules: chatRules.trim() ? chatRules : null,
                knowledgePaths: knowledgePaths.length > 0 ? JSON.stringify(knowledgePaths) : null,
                pinnedSkills: (pinnedSkillsEnabled && boundedPinnedSkillNames.length > 0)
                    ? JSON.stringify(boundedPinnedSkillNames)
                    : null,
                // per-agent 决策轮次：null 表示已重置为全局默认
                planningLoopBudget: planningLoopBudget,
                sandboxMode,
                visualEnhancementEnabled,
                subAgentSafetyFooterEnabled,
                subAgentSafetyFooterText: safetyFooterTextForSave,
            });

            onClose();
        } catch (err) {
            logger.error('保存Agent设置失败:', err);
        } finally {
            setIsSaving(false);
        }
    }, [agentId, agent, name, avatar, mbRules, saRules, chatRules, knowledgePaths, pinnedSkillsEnabled, pinnedSkillNames, pinnedSkillsMaxCount, planningLoopBudget, sandboxMode, visualEnhancementEnabled, subAgentSafetyFooterEnabled, subAgentSafetyFooterText, updateAgent, onClose, t]);

    // ===== 确认删除知识库文件（立即删除索引和更新后端）=====
    const handleConfirmDeleteKnowledge = useCallback(async () => {
        if (!agentId || !agent || !pendingDeletePath) return;

        setIsDeleting(true);
        try {
            // 1. 删除向量索引（documentId 统一使用 filePath）
            if (fileIndexStatus[pendingDeletePath] === 'indexed') {
                const ragService = getRagService();
                await ragService.deleteDocumentIndex(agentId, pendingDeletePath);
                logger.debug(`[Knowledge] 已删除索引: ${pendingDeletePath}`);
            }

            // 2. 更新知识库路径列表
            const newPaths = knowledgePaths.filter(p => p !== pendingDeletePath);

            // 3. 立即更新后端
            await invoke('agent_update', {
                id: agentId,
                request: {
                    knowledge_paths: newPaths.length > 0 ? JSON.stringify(newPaths) : ''
                },
            });

            // 4. 更新本地状态和 Store
            setKnowledgePaths(newPaths);
            setFileIndexStatus(prev => {
                const next = { ...prev };
                            Reflect.deleteProperty(next, pendingDeletePath);
                return next;
            });
            updateAgent(agentId, {
                knowledgePaths: newPaths.length > 0 ? JSON.stringify(newPaths) : null
            });

            logger.trace('[Knowledge] 文件已删除并更新后端');
        } catch (err) {
            logger.error('[Knowledge] 删除失败:', err);
        } finally {
            setIsDeleting(false);
            setDeleteKnowledgeConfirmOpen(false);
            setPendingDeletePath(null);
        }
    }, [agentId, agent, pendingDeletePath, knowledgePaths, fileIndexStatus, updateAgent]);

    // ===== 切换交付物自动同步开关（立即保存到后端）=====
    const handleToggleAutoIndex = useCallback(async (enabled: boolean) => {
        if (!agentId || !agent) return;

        setAutoIndexDeliverables(enabled);
        try {
            await invoke('agent_update', {
                id: agentId,
                request: { auto_index_deliverables: enabled },
            });
            updateAgent(agentId, { autoIndexDeliverables: enabled });
            logger.trace(`[Knowledge] 交付物自动同步开关: ${enabled ? '开启' : '关闭'}`);
        } catch (err) {
            // 回滚 UI 状态
            setAutoIndexDeliverables(!enabled);
            logger.error('[Knowledge] 更新自动同步开关失败:', err);
        }
    }, [agentId, agent, updateAgent]);

    // ===== 批量删除知识库文件 =====
    const handleConfirmBatchDelete = useCallback(async () => {
        if (!agentId || !agent || selectedPaths.size === 0) return;

        setIsDeleting(true);
        try {
            const ragService = getRagService();
            const pathsToDelete = Array.from(selectedPaths);

            // ========== 诊断日志：删除前状态 ==========
            logger.trace('[Knowledge:BatchDelete] ========== 开始批量删除 ==========');
            logger.trace('[Knowledge:BatchDelete] agentId:', agentId);
            logger.trace('[Knowledge:BatchDelete] 待删除路径:', pathsToDelete);
            logger.trace('[Knowledge:BatchDelete] 各路径 fileIndexStatus:',
                pathsToDelete.map(p => ({ path: p, status: fileIndexStatus[p] ?? 'MISSING' }))
            );

            // 删除前查询 DB 中的 document_id 列表
            try {
                const beforeDocIds = await ragService.listIndexedDocumentIds(agentId);
                logger.debug('[Knowledge:BatchDelete] 删除前 DB 中的 document_ids:', beforeDocIds);
            } catch (listErr) {
                logger.warn('[Knowledge:BatchDelete] 查询删除前 document_ids 失败:', listErr);
            }

            // 逐个清理向量索引
            for (const path of pathsToDelete) {
                const status = fileIndexStatus[path];
                if (status === 'indexed') {
                    try {
                        await ragService.deleteDocumentIndex(agentId, path);
                        logger.debug(`[Knowledge:BatchDelete] ✅ 已调用删除索引: ${path}`);
                    } catch (err) {
                        logger.warn(`[Knowledge:BatchDelete] ❌ 删除索引异常: ${path}`, err);
                    }
                } else {
                    // 关键诊断：如果 status 不是 'indexed'，说明 guard 跳过了删除
                    logger.warn(`[Knowledge:BatchDelete] ⏭️ 跳过删除（status=${status ?? 'unknown'}）: ${path}`);
                }
            }

            // ========== 诊断日志：删除后状态 ==========
            try {
                const afterDocIds = await ragService.listIndexedDocumentIds(agentId);
                // 过滤 memory_ 前缀，只关注知识库文档
                const knowledgeDocIds = afterDocIds.filter(id => !id.startsWith('memory_'));
                logger.trace('[Knowledge:BatchDelete] 删除后 DB 中的知识库 document_ids:', knowledgeDocIds);
                if (knowledgeDocIds.length > 0) {
                    logger.warn('[Knowledge:BatchDelete] ⚠️ 删除后仍有残留向量数据！', knowledgeDocIds);
                } else {
                    logger.trace('[Knowledge:BatchDelete] ✅ 向量数据已全部清除');
                }
            } catch (listErr) {
                logger.warn('[Knowledge:BatchDelete] 查询删除后 document_ids 失败:', listErr);
            }

            // 批量更新路径列表
            const newPaths = knowledgePaths.filter(p => !selectedPaths.has(p));

            // 更新后端
            await invoke('agent_update', {
                id: agentId,
                request: {
                    knowledge_paths: newPaths.length > 0 ? JSON.stringify(newPaths) : ''
                },
            });

            // 更新本地状态
            setKnowledgePaths(newPaths);
            setFileIndexStatus(prev => {
                const next = { ...prev };
                        pathsToDelete.forEach(p => {
                            Reflect.deleteProperty(next, p);
                        });
                return next;
            });
            updateAgent(agentId, {
                knowledgePaths: newPaths.length > 0 ? JSON.stringify(newPaths) : null
            });

            // 退出多选模式
            setSelectedPaths(new Set());
            setIsSelectMode(false);

            logger.trace(`[Knowledge:BatchDelete] ========== 批量删除完成: ${pathsToDelete.length} 个文件 ==========`);

            // 兜底校验：延迟 3 秒后检查是否有 fire-and-forget 后台索引"复活"了已删除的向量数据
            // 场景：file_write 的异步 indexToKnowledgeBase 可能在删除后仍在运行，
            //       等其完成后再做一次清理确保数据一致性
            setTimeout(() => {
                void (async () => {
                try {
                    const afterDocIds = await ragService.listIndexedDocumentIds(agentId);
                    const knowledgeDocIds = afterDocIds.filter(id => !id.startsWith('memory_'));
                    // 与最新的 knowledgePaths 对比，找出孤立的向量数据
                    const validSet = new Set(newPaths);
                    const orphanedDocIds = knowledgeDocIds.filter(id => !validSet.has(id));

                    if (orphanedDocIds.length > 0) {
                        logger.warn(
                            '[Knowledge:BatchDelete] ⚠️ 延迟校验发现孤立向量数据，执行清理:',
                            orphanedDocIds
                        );
                        for (const docId of orphanedDocIds) {
                            await ragService.deleteDocumentIndex(agentId, docId);
                        }
                        logger.trace('[Knowledge:BatchDelete] 孤立数据清理完成');
                    }
                } catch (verifyErr) {
                    logger.warn('[Knowledge:BatchDelete] 延迟校验失败:', verifyErr);
                }
                })();
            }, 3000);
        } catch (err) {
            logger.error('[Knowledge:BatchDelete] 批量删除失败:', err);
        } finally {
            setIsDeleting(false);
            setBatchDeleteConfirmOpen(false);
        }
    }, [agentId, agent, selectedPaths, knowledgePaths, fileIndexStatus, updateAgent]);

    // 点击遮罩关闭
    // Escape关闭
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (isOpen && event.key === 'Escape') {
                onClose();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen || !agent) {
        return null;
    }

    return (
        <div className={styles.overlay}>
            <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="agent-settings-title">
                {/* 头部 */}
                <div className={styles.header}>
                    <h2 id="agent-settings-title" className={styles.title}>{t('agent.settings.title')}</h2>
                    <button className={styles.closeBtn} onClick={onClose} aria-label={t('common.close')}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M4 4l8 8M12 4L4 12" />
                        </svg>
                    </button>
                </div>

                {/* 标签页导航 */}
                <div className={styles.tabList}>
                    {(['basic', 'rules', 'knowledge', 'skills', 'memory', 'cron'] as TabId[]).map((tab) => (
                        <button
                            key={tab}
                            className={styles.tab}
                            data-active={activeTab === tab}
                            onClick={() => setActiveTab(tab)}
                        >
                            {t(`agent.settings.tabs.${tab}`)}
                        </button>
                    ))}
                </div>

                {/* 内容区 */}
                <div className={styles.content}>
                    {/* 基础标签页 */}
                    {activeTab === 'basic' && (
                        <div className={styles.formGroup}>
                            {/* 头像区域 */}
                            <label className={styles.label}>{t('agent.settings.avatar')}</label>
                            <div className={styles.avatarSection}>
                                {showCropper ? (
                                    <AvatarCropper
                                        imageDataUrl={cropperImageUrl}
                                        onCrop={async (base64) => {
                                            setAvatar(base64);
                                            setShowCropper(false);
                                            // 同时将未裁剪的原图保存到文件系统
                                            // 用于 SA 的 generate_image 工具做图生图参考
                                            if (agentId && cropperImageUrl) {
                                                try {
                                                    const { appDataDir: getAppDataDir, join } = await import('@tauri-apps/api/path');
                                                    const { mkdir, exists, writeFile } = await import('@tauri-apps/plugin-fs');
                                                    const appData = await getAppDataDir();
                                                    const avatarsDir = await join(appData, 'avatars');
                                                    const dirExists = await exists(avatarsDir);
                                                    if (!dirExists) {
                                                        await mkdir(avatarsDir, { recursive: true });
                                                    }
                                                    // 从 data URL 提取 base64 数据
                                                    const match = cropperImageUrl.match(/^data:[^;]+;base64,(.+)$/);
                                                    const originalBase64 = match?.[1];
                                                    if (originalBase64) {
                                                        const binaryData = Uint8Array.from(
                                                            atob(originalBase64),
                                                            c => c.charCodeAt(0)
                                                        );
                                                        const filePath = await join(avatarsDir, `${agentId}.webp`);
                                                        await writeFile(filePath, binaryData);
                                                        logger.trace('[AvatarUpload] 📸 原图已保存:', filePath);
                                                    }
                                                } catch (err) {
                                                    // 原图保存失败不阻塞裁剪流程
                                                    logger.warn('[AvatarUpload] 原图保存失败:', err);
                                                }
                                            }
                                        }}
                                        onCancel={() => setShowCropper(false)}
                                    />
                                ) : (
                                    <>
                                        {/* 头像预览 */}
                                        <div className={styles.avatarPreview}>
                                            {avatar ? (
                                                <img
                                                    src={`data:image/webp;base64,${avatar}`}
                                                    alt={t('agent.settings.avatarAlt')}
                                                    className={styles.avatarImage}
                                                />
                                            ) : (
                                                <span className={styles.avatarLetter}>
                                                    {name.trim().charAt(0).toUpperCase() || '?'}
                                                </span>
                                            )}
                                        </div>
                                        <div className={styles.avatarActions}>
                                            <button
                                                className={styles.browseBtn}
                                                onClick={async () => {
                                                    try {
                                                        const selected = await open({
                                                            multiple: false,
                                                            filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'] }],
                                                        });
                                                        if (selected && typeof selected === 'string') {
                                                            // 压缩图片并转为 base64 data URL
                                                            const fileName = selected.split(/[/\\]/).pop() ?? 'avatar';
                                                            const result = await imageCompressionService.compressImage(selected, fileName);
                                                            const base64 = await imageCompressionService.toBase64(result);
                                                            setCropperImageUrl(`data:image/webp;base64,${base64}`);
                                                            setShowCropper(true);
                                                        }
                                                    } catch (err) {
                                                        logger.error('选择头像文件失败:', err);
                                                    }
                                                }}
                                            >
                                                {t('agent.settings.uploadAvatar')}
                                            </button>
                                            {avatar && (
                                                <button
                                                    className={styles.browseBtn}
                                                    onClick={() => setAvatar(null)}
                                                >
                                                    {t('common.remove')}
                                                </button>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* 名称 */}
                            <label htmlFor="agent-name" className={styles.label} style={{ marginTop: 16 }}>{t('agent.settings.name')}</label>
                            <input
                                id="agent-name"
                                type="text"
                                className={styles.input}
                                value={name}
                                onChange={(e) => {
                                    setName(e.target.value);
                                    setNameError(null);  // 清除错误提示
                                }}
                                maxLength={50}
                            />
                            {nameError && (
                                <div style={{ color: '#ef4444', fontSize: '12px', marginTop: '8px' }}>
                                    {nameError}
                                </div>
                            )}

                            <label className={styles.label} style={{ marginTop: 16 }}>
                                {t('agent.settings.sandboxMode')}
                            </label>
                            <div className={styles.sandboxModeGroup} role="radiogroup" aria-label={t('agent.settings.sandboxMode')}>
                                {SANDBOX_MODE_OPTIONS.map((mode) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        className={styles.sandboxModeOption}
                                        data-active={sandboxMode === mode}
                                        role="radio"
                                        aria-checked={sandboxMode === mode}
                                        onClick={() => setSandboxMode(mode)}
                                    >
                                        <span className={styles.sandboxModeTitle}>
                                            {t(`agent.settings.sandboxModes.${mode}.label`)}
                                        </span>
                                        <span className={styles.sandboxModeHint}>
                                            {t(`agent.settings.sandboxModes.${mode}.description`)}
                                        </span>
                                    </button>
                                ))}
                            </div>

                            <div
                                className={styles.safetyFooterSection}
                                data-custom-context-menu
                                onContextMenu={openEditableMenu}
                            >
                                <div className={styles.toggleRow}>
                                    <div className={styles.toggleInfo}>
                                        <span className={styles.toggleLabel}>{t('agent.settings.subAgentSafetyFooter')}</span>
                                        <p className={styles.toggleHint}>
                                            {t('agent.settings.subAgentSafetyFooterHint')}
                                        </p>
                                    </div>
                                    <label className={styles.toggleSwitch}>
                                        <input
                                            type="checkbox"
                                            checked={subAgentSafetyFooterEnabled}
                                            onChange={(e) => setSubAgentSafetyFooterEnabled(e.target.checked)}
                                            aria-label={t('agent.settings.subAgentSafetyFooter')}
                                        />
                                        <span className={styles.toggleSlider} />
                                    </label>
                                </div>
                                {subAgentSafetyFooterEnabled && (
                                    <div className={styles.safetyFooterPromptPanel}>
                                        <label htmlFor="sub-agent-safety-footer-text" className={styles.label}>
                                            {t('agent.settings.subAgentSafetyFooterPrompt')}
                                        </label>
                                        <textarea
                                            id="sub-agent-safety-footer-text"
                                            className={cx(styles.textarea, styles.safetyFooterTextarea)}
                                            value={subAgentSafetyFooterText}
                                            onChange={(e) => setSubAgentSafetyFooterText(e.target.value)}
                                            spellCheck={false}
                                        />
                                    </div>
                                )}
                            </div>

                            {/* 决策轮次步进器 */}
                            <label htmlFor="agent-loop-budget" className={styles.label} style={{ marginTop: 16 }}>
                                {t('agent.settings.loopBudget')}
                            </label>
                            <p className={styles.hint}>
                                {t('agent.settings.loopBudgetHint', { max: defaultDecisionRounds })}
                            </p>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                {/* 自定义步进器：隐藏原生 spinner，用 Lucide 图标替代，hover 才显示 */}
                                <div className={styles.stepperWrapper}>
                                    <input
                                        id="agent-loop-budget"
                                        type="number"
                                        min={3}
                                        max={20}
                                        step={1}
                                        className={styles.stepperInput}
                                        value={planningLoopBudget ?? ''}
                                        placeholder={String(defaultDecisionRounds)}
                                        onChange={(e) => {
                                            const v = e.target.value === '' ? null : Number(e.target.value);
                                            setPlanningLoopBudget(v);
                                        }}
                                    />
                                    <div className={styles.stepperButtons}>
                                        <button
                                            className={styles.stepperBtn}
                                            type="button"
                                            tabIndex={-1}
                                            aria-label={t('agent.settings.increase')}
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                const cur = planningLoopBudget ?? defaultDecisionRounds;
                                                if (cur < 20) setPlanningLoopBudget(cur + 1);
                                            }}
                                        >
                                            <ChevronUp size={12} strokeWidth={2.5} />
                                        </button>
                                        <button
                                            className={styles.stepperBtn}
                                            type="button"
                                            tabIndex={-1}
                                            aria-label={t('agent.settings.decrease')}
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                const cur = planningLoopBudget ?? defaultDecisionRounds;
                                                if (cur > 3) setPlanningLoopBudget(cur - 1);
                                            }}
                                        >
                                            <ChevronDown size={12} strokeWidth={2.5} />
                                        </button>
                                    </div>
                                </div>
                                <span style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>{t('agent.settings.loopUnit')}</span>
                                {planningLoopBudget !== null && (
                                    <Tooltip content={t('agent.settings.resetLoopTitle', { max: defaultDecisionRounds })}>
                                        <button
                                            className={styles.browseBtn}
                                            onClick={() => setPlanningLoopBudget(null)}
                                            type="button"
                                        >
                                            {t('agent.settings.resetDefault')}
                                        </button>
                                    </Tooltip>
                                )}
                            </div>

                            <div className={styles.toggleRow} style={{ marginTop: 16 }}>
                                <div className={styles.toggleInfo}>
                                    <span className={styles.toggleLabel}>{t('agent.settings.visualEnhancement')}</span>
                                    <p className={styles.toggleHint}>
                                        {t('agent.settings.visualEnhancementHint')}
                                    </p>
                                </div>
                                <label className={styles.toggleSwitch}>
                                    <input
                                        type="checkbox"
                                        checked={visualEnhancementEnabled}
                                        onChange={(e) => setVisualEnhancementEnabled(e.target.checked)}
                                        aria-label={t('agent.settings.visualEnhancement')}
                                    />
                                    <span className={styles.toggleSlider} />
                                </label>
                            </div>
                        </div>
                    )}
                    {/* Rules 标签页 */}
                    {activeTab === 'rules' && (
                        <div
                            className={cx(styles.formGroup, styles.rulesEditorList)}
                            data-custom-context-menu
                            onContextMenu={openEditableMenu}
                        >
                            <div className={styles.rulesEditorBlock}>
                                <label htmlFor="agent-mb-rules" className={styles.label}>
                                    {t('agent.settings.mbRulesLabel')}
                                </label>
                                <p className={styles.hint}>{t('agent.settings.mbRulesHint')}</p>
                                <textarea
                                    id="agent-mb-rules"
                                    className={cx(styles.textarea, styles.rulesTextarea)}
                                    value={mbRules}
                                    onChange={(e) => setMbRules(e.target.value)}
                                    placeholder={t('agent.settings.rulesPlaceholder')}
                                    spellCheck={false}
                                />
                            </div>

                            <div className={styles.rulesEditorBlock}>
                                <label htmlFor="agent-sa-rules" className={styles.label}>
                                    {t('agent.settings.saRulesLabel')}
                                </label>
                                <p className={styles.hint}>{t('agent.settings.saRulesHint')}</p>
                                <textarea
                                    id="agent-sa-rules"
                                    className={cx(styles.textarea, styles.rulesTextarea)}
                                    value={saRules}
                                    onChange={(e) => setSaRules(e.target.value)}
                                    placeholder={t('agent.settings.rulesPlaceholder')}
                                    spellCheck={false}
                                />
                            </div>

                            <div className={styles.rulesEditorBlock}>
                                <label htmlFor="agent-chat-rules" className={styles.label}>
                                    {t('agent.settings.chatRulesLabel')}
                                </label>
                                <p className={styles.hint}>{t('agent.settings.chatRulesHint')}</p>
                                <textarea
                                    id="agent-chat-rules"
                                    className={cx(styles.textarea, styles.rulesTextarea)}
                                    value={chatRules}
                                    onChange={(e) => setChatRules(e.target.value)}
                                    placeholder={t('agent.settings.rulesPlaceholder')}
                                    spellCheck={false}
                                />
                            </div>
                        </div>
                    )}

                    {/* 知识库标签页 */}
                    {activeTab === 'knowledge' && (
                        <div className={styles.formGroup}>
                            {/* 交付物自动同步开关 */}
                            <div className={styles.toggleRow}>
                                <div className={styles.toggleInfo}>
                                    <span className={styles.toggleLabel}>{t('agent.settings.autoIndexDeliverables')}</span>
                                    <p className={styles.toggleHint}>
                                        {t('agent.settings.autoIndexHint')}
                                    </p>
                                    <p className={styles.toggleTip}>
                                        {t('agent.settings.autoIndexTip')}
                                    </p>
                                </div>
                                <label className={styles.toggleSwitch}>
                                    <input
                                        type="checkbox"
                                        checked={autoIndexDeliverables}
                                        onChange={(e) => handleToggleAutoIndex(e.target.checked)}
                                    />
                                    <span className={styles.toggleSlider} />
                                </label>
                            </div>

                            {/* 知识库文件管理 */}
                            <label className={styles.label} style={{ marginTop: 16 }}>{t('agent.settings.knowledgeFiles')}</label>
                            <p className={styles.hint}>{t('agent.settings.knowledgeHint')}</p>

                            {/* 操作栏：添加文件 + 选择按钮 */}
                            <div className={styles.knowledgeActions}>
                                <button className={styles.browseBtn} onClick={async () => {
                                    try {
                                        const selected = await open({
                                            multiple: true,
                                            filters: [
                                                { name: 'Documents', extensions: ['md', 'txt', 'json', 'pdf'] },
                                            ],
                                        });
                                        if (selected) {
                                            const paths = Array.isArray(selected) ? selected : [selected];
                                            // 新增的文件标记为 pending
                                            setFileIndexStatus(prev => {
                                                const next = { ...prev };
                                                paths.forEach(p => { next[p] = 'pending'; });
                                                return next;
                                            });
                                            setKnowledgePaths((prev) => [...prev, ...paths]);
                                        }
                                    } catch (err) {
                                        logger.error('添加知识库文件失败:', err);
                                    }
                                }} disabled={isSaving}>
                                    {t('agent.settings.addFiles')}
                                </button>
                                {knowledgePaths.length > 0 && (
                                    <button
                                        className={cx(styles.browseBtn, isSelectMode && styles.selectBtnActive)}
                                        onClick={() => {
                                            if (isSelectMode) {
                                                // 退出多选模式
                                                setIsSelectMode(false);
                                                setSelectedPaths(new Set());
                                            } else {
                                                setIsSelectMode(true);
                                            }
                                        }}
                                        disabled={isSaving || isDeleting}
                                    >
                                        {isSelectMode ? t('agent.settings.cancelSelect') : t('agent.settings.select')}
                                    </button>
                                )}
                            </div>

                            {/* 多选操作栏 */}
                            {isSelectMode && knowledgePaths.length > 0 && (
                                <div className={styles.batchBar}>
                                    <button
                                        className={styles.batchBtn}
                                        onClick={() => {
                                            if (selectedPaths.size === knowledgePaths.length) {
                                                // 取消全选
                                                setSelectedPaths(new Set());
                                            } else {
                                                // 全选
                                                setSelectedPaths(new Set(knowledgePaths));
                                            }
                                        }}
                                    >
                                        {selectedPaths.size === knowledgePaths.length ? t('agent.settings.cancelSelectAll') : t('common.selectAll')}
                                    </button>
                                    <span className={styles.batchCount}>
                                        {t('agent.settings.selectedFiles', { selected: selectedPaths.size, total: knowledgePaths.length })}
                                    </span>
                                    <button
                                        className={styles.batchDeleteBtn}
                                        disabled={selectedPaths.size === 0 || isDeleting}
                                        onClick={() => setBatchDeleteConfirmOpen(true)}
                                    >
                                        {t('agent.settings.deleteSelected')}
                                    </button>
                                </div>
                            )}

                            {/* 文件列表 */}
                            {knowledgePaths.length > 0 ? (
                                <div className={styles.fileList}>
                                    {knowledgePaths.map((path, index) => {
                                        const status = fileIndexStatus[path];
                                        return (
                                            <div key={index} className={styles.fileItem}>
                                                {/* 多选 Checkbox */}
                                                {isSelectMode && (
                                                    <label className={styles.checkbox}>
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedPaths.has(path)}
                                                            onChange={(e) => {
                                                                setSelectedPaths(prev => {
                                                                    const next = new Set(prev);
                                                                    if (e.target.checked) {
                                                                        next.add(path);
                                                                    } else {
                                                                        next.delete(path);
                                                                    }
                                                                    return next;
                                                                });
                                                            }}
                                                        />
                                                        <span className={styles.checkmark} />
                                                    </label>
                                                )}
                                                {/* 状态图标 */}
                                                <span className={cx(styles.fileStatus, status === 'indexing' ? styles.statusIndexing :
                                                    status === 'indexed' ? styles.statusIndexed :
                                                        status === 'error' ? styles.statusError :
                                                            styles.statusPending
                                                )}>
                                                    {status === 'indexing' ? (
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                                                        </svg>
                                                    ) : status === 'indexed' ? (
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <path d="M20 6L9 17l-5-5" />
                                                        </svg>
                                                    ) : status === 'error' ? (
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <circle cx="12" cy="12" r="10" />
                                                            <path d="M15 9l-6 6M9 9l6 6" />
                                                        </svg>
                                                    ) : (
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <circle cx="12" cy="12" r="3" />
                                                        </svg>
                                                    )}
                                                </span>
                                                <span className={styles.fileName}>{path.split(/[/\\]/).pop()}</span>
                                                {/* 非多选模式显示单个删除按钮 */}
                                                {!isSelectMode && (
                                                    <Tooltip
                                                        content={t('agent.settings.deleteFileTitle')}
                                                        disabled={isSaving || isDeleting}
                                                    >
                                                        <button
                                                            className={styles.removeBtn}
                                                            onClick={() => {
                                                                setPendingDeletePath(path);
                                                                setDeleteKnowledgeConfirmOpen(true);
                                                            }}
                                                            disabled={isSaving || isDeleting}
                                                            aria-label={t('agent.settings.deleteFileTitle')}
                                                        >
                                                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                                <path d="M3 3l6 6M9 3L3 9" />
                                                            </svg>
                                                        </button>
                                                    </Tooltip>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className={styles.emptyFiles}>{t('agent.settings.emptyKnowledge')}</div>
                            )}
                            {/* 索引进度条 */}
                            {indexingProgress && (
                                <div className={styles.indexingProgress}>
                                    <div className={styles.progressBar}>
                                        <div
                                            className={styles.progressFill}
                                            style={{ width: `${(indexingProgress.current / indexingProgress.total) * 100}%` }}
                                        />
                                    </div>
                                    <span className={styles.progressText}>
                                        {t('agent.settings.indexingProgress', { current: indexingProgress.current, total: indexingProgress.total })}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

                    {/* 技能标签页 */}
                    {activeTab === 'skills' && (
                        <div className={styles.formGroup}>
                            {/* 精准命中开关 */}
                            <div className={styles.toggleRow}>
                                <div className={styles.toggleInfo}>
                                    <span className={styles.toggleLabel}>{t('agent.settings.pinnedMode')}</span>
                                    <p className={styles.toggleHint}>
                                        {t('agent.settings.pinnedHint', { max: pinnedSkillsMaxCount })}
                                    </p>
                                    <p className={styles.toggleTip}>
                                        {t('agent.settings.pinnedTip')}
                                    </p>
                                </div>
                                <label className={styles.toggleSwitch}>
                                    <input
                                        type="checkbox"
                                        checked={pinnedSkillsEnabled}
                                        onChange={(e) => {
                                            setPinnedSkillsEnabled(e.target.checked);
                                            if (!e.target.checked) {
                                                setPinnedSkillNames([]);
                                            }
                                        }}
                                    />
                                    <span className={styles.toggleSlider} />
                                </label>
                            </div>

                            {/* 技能选择列表 */}
                            {pinnedSkillsEnabled && (
                                <div className={styles.pinnedSkillList}>
                                    {installedSkills.length > 0 ? (
                                        <>
                                            <p className={styles.hint} style={{ marginBottom: 8 }}>
                                                {t('agent.settings.selectedSkills', {
                                                    count: pinnedSkillNames.length,
                                                    max: pinnedSkillsMaxCount,
                                                })}
                                            </p>
                                            {installedSkills.map((skill) => {
                                                const isChecked = pinnedSkillNames.includes(skill.name);
                                                const isDisabled = !isChecked && pinnedSkillNames.length >= pinnedSkillsMaxCount;
                                                return (
                                                    <label
                                                        key={skill.name}
                                                        className={cx(styles.pinnedSkillItem, isDisabled && styles.pinnedSkillDisabled)}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={isChecked}
                                                            disabled={isDisabled}
                                                            onChange={() => {
                                                                if (isChecked) {
                                                                    setPinnedSkillNames(prev => prev.filter(n => n !== skill.name));
                                                                } else if (pinnedSkillNames.length < pinnedSkillsMaxCount) {
                                                                    setPinnedSkillNames(prev => [...prev, skill.name]);
                                                                }
                                                            }}
                                                            className={styles.pinnedSkillHiddenInput}
                                                        />
                                                        <span className={cx(styles.pinnedSkillDot, isChecked && styles.pinnedSkillDotActive)} />
                                                        <div className={styles.pinnedSkillInfo}>
                                                            <span className={styles.pinnedSkillName}>{skill.name}</span>
                                                            {skill.description && (
                                                                <span className={styles.pinnedSkillDesc}>{skill.description}</span>
                                                            )}
                                                        </div>
                                                    </label>
                                                );
                                            })}
                                        </>
                                    ) : (
                                        <div className={styles.emptyFiles}>{t('agent.settings.emptySkills')}</div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* 记忆标签页 */}
                    {activeTab === 'memory' && agentId && (
                        <MemoryPanel agentId={agentId} />
                    )}

                    {/* 定时任务标签页 */}
                    {activeTab === 'cron' && agentId && (
                        <CronSettingsTab agentId={agentId} />
                    )}
                </div>

                {/* 底部 — 仅在需要 modal 级保存的标签页显示 */}
                {/* 定时任务和记忆标签页有自己的内联 CRUD，不需要 modal 级保存按钮 */}
                {activeTab !== 'cron' && activeTab !== 'memory' && (
                    <div className={styles.footer}>
                        <button className={styles.cancelBtn} onClick={onClose} disabled={isSaving}>
                            {t('common.cancel')}
                        </button>
                        <button className={styles.saveBtn} onClick={handleSave} disabled={isSaving}>
                            {indexingProgress
                                ? t('agent.settings.indexingProgressSaving', { current: indexingProgress.current, total: indexingProgress.total })
                                : isSaving
                                    ? t('agent.settings.saving')
                                    : t('common.save')}
                        </button>
                    </div>
                )}
                <TextContextMenu
                    menu={textContextMenu}
                    onAction={handleMenuAction}
                    onClose={closeTextContextMenu}
                />
            </div>

            {/* 知识库文件删除确认对话框 */}
            <ConfirmDialog
                open={deleteKnowledgeConfirmOpen}
                onClose={() => {
                    setDeleteKnowledgeConfirmOpen(false);
                    setPendingDeletePath(null);
                }}
                onConfirm={handleConfirmDeleteKnowledge}
                title={t('agent.settings.deleteKnowledgeTitle')}
                description={t('agent.settings.deleteKnowledgeDescription', { name: pendingDeletePath?.split(/[/\\]/).pop() ?? '' })}
                confirmText={t('common.confirmDelete')}
                cancelText={t('common.cancel')}
                variant="danger"
                isLoading={isDeleting}
            />

            {/* 批量删除确认对话框 */}
            <ConfirmDialog
                open={batchDeleteConfirmOpen}
                onClose={() => setBatchDeleteConfirmOpen(false)}
                onConfirm={handleConfirmBatchDelete}
                title={t('agent.settings.batchDeleteKnowledgeTitle')}
                description={t('agent.settings.batchDeleteKnowledgeDescription', { count: selectedPaths.size })}
                confirmText={t('common.confirmDelete')}
                cancelText={t('common.cancel')}
                variant="danger"
                isLoading={isDeleting}
            />
        </div>
    );
}
