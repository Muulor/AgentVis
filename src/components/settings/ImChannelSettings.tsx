/**
 * ImChannelSettings - IM 通道设置页面（多平台多 Bot 版本）
 *
 * 支持配置多个飞书 / Slack 机器人实例，每个 Bot 独立绑定：
 * - 平台凭据（存储在 Windows Credential Manager 中）
 * - 目标 Hub 和 Agent（确定消息路由目标）
 *
 * 开机自动连接和单 Bot 配置表单均采用可折叠卡片呈现，
 * 允许同时展开多个 Bot 进行配置。
 *
 * 迁移兼容：首次加载时检测旧版单 Bot persist 数据，
 * 自动转换为新格式 botConfigs[0]，无数据丢失。
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';
import { ExternalLink } from 'lucide-react';
import { Tooltip } from '@components/ui/Tooltip';
import { Select } from '@components/ui';
import { useImChannelStore, getBotConnectionState } from '@stores/imChannelStore';
import { useHubStore } from '@stores/hubStore';
import {
    createChannelForBot,
    destroyChannelByBotId,
    getChannelByBotId,
    registerPlatform,
} from '@services/im-channel/ImChannelFactory';
import { FeishuChannel } from '@services/im-channel/platforms/FeishuChannel';
import { SlackChannel } from '@services/im-channel/platforms/SlackChannel';
import { initializeImTaskBridge } from '@services/im-channel/ImTaskBridge';
import type { BotConfig, FeishuChannelConfig, SlackChannelConfig } from '@services/im-channel/types';
import { MAX_BOT_COUNT } from '@services/im-channel/types';
import { getLogger } from '@services/logger';
import { cx } from '@utils/classNames';
import styles from './ImChannelSettings.module.css';
import {
    getMissingAgentReloadKey,
    resolveImBotHubId,
    resolveMissingAgentAction,
    shouldClearAgentAfterHubResolve,
} from './imChannelHubSelection';
import { useI18n } from '@/i18n';

const logger = getLogger('ImChannelSettings');

const PLATFORM_APP_URLS = {
    feishu: 'https://open.feishu.cn/app',
    slack: 'https://api.slack.com/apps',
} as const;

// 模块加载时注册飞书平台适配器（幂等，多次调用安全）
registerPlatform('feishu', (config) => new FeishuChannel(config as FeishuChannelConfig));
registerPlatform('slack', (config) => new SlackChannel(config as SlackChannelConfig));

/** 在系统浏览器中打开外部 URL */
const openExternalUrl = async (url: string) => {
    try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
    } catch {
        window.open(url, '_blank');
    }
};

// ============================================================================
// 类型定义
// ============================================================================

/** 从 Rust Keystore 读取的凭据结构 */
interface ImCredentials {
    appId: string;
    appSecret: string;
    botToken?: string;
    appToken?: string;
}

/** 单个 Bot 的本地表单编辑状态（不持久化，组件内临时） */
interface BotFormState {
    appId: string;
    appSecret: string;
    botToken: string;
    appToken: string;
    isLoadingCredentials: boolean;
    isExpanded: boolean;
    hubAgents: { id: string; name: string }[];
    isLoadingAgents: boolean;
    lastMissingAgentReloadKey: string | null;
    /**
     * 最后一次成功加载 hubAgents 时对应的 hubId
     *
     * 用于检测外部状态更新 hubId 后，当前 hubAgents 列表已属于旧 Hub，
     * 需要重新加载以同步 UI。
     */
    lastLoadedHubId: string | null;
}

/** 创建空的表单状态 */
function createEmptyFormState(): BotFormState {
    return {
        appId: '',
        appSecret: '',
        botToken: '',
        appToken: '',
        isLoadingCredentials: false,
        isExpanded: false,
        hubAgents: [],
        isLoadingAgents: false,
        lastMissingAgentReloadKey: null,
        lastLoadedHubId: null,
    };
}

// ============================================================================
// 主组件
// ============================================================================

export function ImChannelSettings() {
    const { t } = useI18n();
    // ─── Store 状态 ───
    const botConfigs = useImChannelStore((s) => s.botConfigs);
    const connectionStates = useImChannelStore((s) => s.connectionStates);
    const autoConnect = useImChannelStore((s) => s.autoConnect);
    // 旧版迁移哨兵字段
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const legacyHubId = useImChannelStore((s) => s.defaultHubId);
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const legacyAgentId = useImChannelStore((s) => s.defaultAgentId);

    const addBotConfig = useImChannelStore((s) => s.addBotConfig);
    const updateBotConfig = useImChannelStore((s) => s.updateBotConfig);
    const removeBotConfig = useImChannelStore((s) => s.removeBotConfig);
    const setBotConnected = useImChannelStore((s) => s.setBotConnected);
    const setBotConnecting = useImChannelStore((s) => s.setBotConnecting);
    const setBotConnectionError = useImChannelStore((s) => s.setBotConnectionError);
    const setAutoConnect = useImChannelStore((s) => s.setAutoConnect);
    const clearLegacyFields = useImChannelStore((s) => s.clearLegacyFields);

    // ─── Hub 列表 ───
    const hubs = useHubStore((s) => s.hubs);

    // ─── 每个 Bot 的本地表单状态（botId → BotFormState） ───
    const [formStates, setFormStates] = useState<Record<string, BotFormState>>({});

    // ─── 迁移是否已执行（防止重复） ───
    const migrationDoneRef = useRef(false);

    // ─── 正在加载 Agent 列表的 botId 集合（防止并发重入） ───
    const loadingAgentsRef = useRef(new Set<string>());

    // ============================================================================
    // 旧版数据迁移（一次性）
    // ============================================================================

    useEffect(() => {
        if (migrationDoneRef.current) return;
        // 迁移条件：旧版 agentId 存在且当前 botConfigs 为空
        if (!legacyAgentId || botConfigs.length > 0) return;

        migrationDoneRef.current = true;
        void performLegacyMigration(legacyHubId, legacyAgentId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * 将旧版单 Bot 配置迁移到新格式 botConfigs[0]
     *
     * 1. 读取旧 Keystore 凭据 im_feishu_credentials
     * 2. 创建新的 BotConfig 写入 Store
     * 3. 将凭据保存到 im_feishu_{botId}_credentials
     * 4. 清除旧版哨兵字段
     */
    async function performLegacyMigration(
        hubId: string | null,
        agentId: string,
    ): Promise<void> {
        logger.info('检测到旧版 IM 配置，正在自动迁移到多 Bot 格式...');
        try {
            // 读取旧凭据
            const creds = await invoke<ImCredentials>('im_get_credentials', {
                platform: 'feishu',
            });

            const botId = uuidv4();
            const newConfig: BotConfig = {
                botId,
                displayName: t('settings.im.defaultBotName'),
                platform: 'feishu',
                hubId,
                agentId,
                enabled: true,
                outboundReceiveIdType: 'chat_id',
                outboundReceiveId: null,
                slackDefaultChannelId: null,
                hasCredentials: !!(creds.appId && creds.appSecret),
            };

            // 保存到新格式 Keystore
            if (creds.appId && creds.appSecret) {
                await invoke('im_save_bot_credentials', {
                    platform: 'feishu',
                    botId,
                    appId: creds.appId,
                    appSecret: creds.appSecret,
                });
            }

            addBotConfig(newConfig);
            clearLegacyFields();
            logger.info(`旧版 IM 配置迁移完成: botId=${botId}`);
        } catch (error) {
            logger.error('旧版 IM 配置迁移失败', { error });
        }
    }

    // ============================================================================
    // 表单状态管理辅助函数
    // ============================================================================

    /** 获取指定 Bot 的表单状态（不存在时返回空状态） */
    const getFormState = useCallback(
        (botId: string): BotFormState =>
            formStates[botId] ?? createEmptyFormState(),
        [formStates],
    );

    /** 更新指定 Bot 的部分表单状态 */
    const updateFormState = useCallback(
        (botId: string, updates: Partial<BotFormState>) => {
            setFormStates((prev) => ({
                ...prev,
                [botId]: { ...(prev[botId] ?? createEmptyFormState()), ...updates },
            }));
        },
        [],
    );

    // ============================================================================
    // Hub 归属规范化（单 Hub 自动绑定，失效 Hub 自动清理）
    // ============================================================================

    useEffect(() => {
        for (const config of botConfigs) {
            const resolvedHubId = resolveImBotHubId(config.hubId, hubs);
            if (resolvedHubId === config.hubId) continue;

            const shouldClearAgent = shouldClearAgentAfterHubResolve(
                config.hubId,
                resolvedHubId,
            );

            updateBotConfig(config.botId, shouldClearAgent
                ? { hubId: resolvedHubId, agentId: null }
                : { hubId: resolvedHubId });

            if (!resolvedHubId) {
                updateFormState(config.botId, {
                    hubAgents: [],
                    isLoadingAgents: false,
                    lastMissingAgentReloadKey: null,
                    lastLoadedHubId: null,
                });
            }
        }
    }, [botConfigs, hubs, updateBotConfig, updateFormState]);

    // ============================================================================
    // Bot 展开/折叠（同时加载凭据）
    // ============================================================================

    const handleToggleExpand = useCallback(
        async (botId: string) => {
            const current = getFormState(botId);
            const willExpand = !current.isExpanded;
            const botConfig = botConfigs.find((config) => config.botId === botId);
            if (!botConfig) return;

            updateFormState(botId, { isExpanded: willExpand });

            // 展开时加载凭据（如果尚未加载）
            const hasLoadedCredentials = botConfig.platform === 'slack'
                ? Boolean(current.botToken)
                : Boolean(current.appId);
            if (willExpand && !hasLoadedCredentials) {
                updateFormState(botId, { isLoadingCredentials: true });
                try {
                    const creds = await invoke<ImCredentials>('im_get_bot_credentials', {
                        platform: botConfig.platform,
                        botId,
                    });
                    updateFormState(botId, {
                        appId: creds.appId,
                        appSecret: creds.appSecret,
                        botToken: creds.botToken ?? '',
                        appToken: creds.appToken ?? '',
                        isLoadingCredentials: false,
                    });
                } catch {
                    updateFormState(botId, { isLoadingCredentials: false });
                }
            }
        },
        [botConfigs, getFormState, updateFormState],
    );

    // ============================================================================
    // Bot 添加
    // ============================================================================

    const handleAddBot = useCallback((platform: 'feishu' | 'slack') => {
        const platformBotCount = botConfigs.filter((config) => config.platform === platform).length;
        if (platformBotCount >= MAX_BOT_COUNT) return;

        const defaultHubId = resolveImBotHubId(null, hubs);
        const newConfig: BotConfig = {
            botId: uuidv4(),
            displayName: platform === 'slack'
                ? t('settings.im.slackNumberedBotName', { index: platformBotCount + 1 })
                : t('settings.im.numberedBotName', { index: platformBotCount + 1 }),
            platform,
            hubId: defaultHubId,
            agentId: null,
            enabled: true,
            outboundReceiveIdType: platform === 'feishu' ? 'chat_id' : null,
            outboundReceiveId: null,
            slackDefaultChannelId: null,
            hasCredentials: false,
        };
        addBotConfig(newConfig);
        // 自动展开新 Bot 的配置面板
        updateFormState(newConfig.botId, { isExpanded: true });
    }, [botConfigs, hubs, addBotConfig, updateFormState, t]);

    // ============================================================================
    // Bot 删除
    // ============================================================================

    const handleDeleteBot = useCallback(
        async (botConfig: BotConfig) => {
            // 先断开连接
            if (getChannelByBotId(botConfig.botId)) {
                await destroyChannelByBotId(botConfig.botId);
            }

            // 删除 Keystore 凭据
            try {
                await invoke('im_delete_bot_credentials', {
                    platform: botConfig.platform,
                    botId: botConfig.botId,
                });
            } catch (error) {
                logger.warn('删除 Bot 凭据失败（可能从未保存过）', { error });
            }

            // 从 Store 移除配置
            removeBotConfig(botConfig.botId);

            // 清理本地表单状态
            setFormStates((prev) => {
                const next = { ...prev };
                Reflect.deleteProperty(next, botConfig.botId);
                return next;
            });

            logger.info(`Bot 已删除: ${botConfig.botId}`);
        },
        [removeBotConfig],
    );

    // ============================================================================
    // 保存 Bot 配置（凭据 + Store 元数据）
    // ============================================================================

    const handleSaveBotConfig = useCallback(
        async (botId: string) => {
            const form = getFormState(botId);
            const botConfig = botConfigs.find((config) => config.botId === botId);
            if (!botConfig) return;

            const missingCredentials = botConfig.platform === 'slack'
                ? (!form.botToken.trim() || !form.appToken.trim())
                : (!form.appId.trim() || !form.appSecret.trim());
            if (missingCredentials) {
                logger.warn('IM Bot 凭据为空，拒绝保存');
                return;
            }

            try {
                if (botConfig.platform === 'slack') {
                    await invoke('im_save_bot_credentials', {
                        platform: 'slack',
                        botId,
                        botToken: form.botToken.trim(),
                        appToken: form.appToken.trim(),
                    });
                } else {
                    await invoke('im_save_bot_credentials', {
                        platform: 'feishu',
                        botId,
                        appId: form.appId.trim(),
                        appSecret: form.appSecret.trim(),
                    });
                }
                // 保存成功后在 store 中标记凭据已配置，供折叠状态的卡片头部正确显示
                updateBotConfig(botId, { hasCredentials: true });
                logger.info(`Bot ${botId} 凭据已保存`);
            } catch (error) {
                logger.error('保存 Bot 凭据失败', { botId, error });
            }
        },
        [botConfigs, getFormState, updateBotConfig],
    );

    // ============================================================================
    // 只加载 Agent 列表到本地表单状态（不写 Store！）
    // ============================================================================

    /**
     * 加载指定 Hub 下的 Agent 列表，仅更新本地 formState。
     *
     * 与 handleHubChange 的关键区别：不修改 Zustand Store，
     * 因此不会触发 botConfigs 变化 → 不会引起循环渲染。
     */
    const loadAgentsForBot = useCallback(
        async (botId: string, hubId: string) => {
            // 防止并发重入：如果该 Bot 已在加载，直接跳过
            if (loadingAgentsRef.current.has(botId)) return;
            loadingAgentsRef.current.add(botId);

            updateFormState(botId, { isLoadingAgents: true });
            try {
                const agents = await invoke<{ id: string; name: string }[]>('agent_list_by_hub', {
                    hubId,
                });
                // 写入 lastLoadedHubId，供 useEffect 检测 Hub 是否已被外部切换
                updateFormState(botId, { hubAgents: agents, isLoadingAgents: false, lastLoadedHubId: hubId });
            } catch (error) {
                logger.error('加载 Hub Agent 列表失败', { hubId, error });
                updateFormState(botId, { hubAgents: [], isLoadingAgents: false });
            } finally {
                loadingAgentsRef.current.delete(botId);
            }
        },
        [updateFormState],
    );

    // ============================================================================
    // Hub 变更 → 更新 Store 并加载 Agent 列表
    // ============================================================================

    const handleHubChange = useCallback(
        async (botId: string, hubId: string | null) => {
            // 只有 hub 实际发生变化时才重置 agentId，避免循环初始化时无用地清空已存的 agentId
            const currentConfig = botConfigs.find((c) => c.botId === botId);
            if (currentConfig?.hubId !== hubId) {
                // Hub 确实发生变化，重置 agentId 是合理的
                updateBotConfig(botId, { hubId, agentId: null });
            } else if (hubId && currentConfig.hubId === hubId) {
                // Hub 没变，只需确保 hubId 写入
                updateBotConfig(botId, { hubId });
            }

            if (!hubId) {
                updateFormState(botId, { hubAgents: [] });
                return;
            }

            // 加载 Agent 列表（不会再次触发 Store 写入）
            await loadAgentsForBot(botId, hubId);
        },
        [botConfigs, updateBotConfig, updateFormState, loadAgentsForBot],
    );

    // ============================================================================
    // 连接 / 断开
    // ============================================================================

    const handleConnect = useCallback(
        async (botConfig: BotConfig) => {
            let form = getFormState(botConfig.botId);
            const hasRequiredCredentials = (candidate: BotFormState): boolean =>
                botConfig.platform === 'slack'
                    ? Boolean(candidate.botToken.trim() && candidate.appToken.trim())
                    : Boolean(candidate.appId.trim() && candidate.appSecret.trim());

            // 凭据尚未加载到 formState（卡片折叠状态下常见）
            // 若 botConfig.hasCredentials = true，说明 Keystore 中有凭据，
            // 先从后端加载再连接，而非报假阳性的"请先填写"错误
            if (!hasRequiredCredentials(form) && botConfig.hasCredentials) {
                setBotConnecting(botConfig.botId, true);
                setBotConnectionError(botConfig.botId, null);
                try {
                    const creds = await invoke<ImCredentials>('im_get_bot_credentials', {
                        platform: botConfig.platform,
                        botId: botConfig.botId,
                    });
                    updateFormState(botConfig.botId, {
                        appId: creds.appId,
                        appSecret: creds.appSecret,
                        botToken: creds.botToken ?? '',
                        appToken: creds.appToken ?? '',
                    });
                    // 重新读取，此时凭据已填充
                    form = {
                        ...form,
                        appId: creds.appId,
                        appSecret: creds.appSecret,
                        botToken: creds.botToken ?? '',
                        appToken: creds.appToken ?? '',
                    };
                } catch (loadError) {
                    setBotConnecting(botConfig.botId, false);
                    setBotConnectionError(botConfig.botId, t('settings.im.loadCredentialsFailed'));
                    logger.error('连接前加载凭据失败', { botId: botConfig.botId, error: loadError });
                    return;
                }
            } else if (!hasRequiredCredentials(form)) {
                // 确实未填写（hasCredentials = false）
                setBotConnectionError(botConfig.botId, botConfig.platform === 'slack'
                    ? t('settings.im.slackMissingCredentials')
                    : t('settings.im.missingCredentials'));
                return;
            }

            // 凭据就绪：保存到 Keystore（幂等，确保最新值持久化）
            await handleSaveBotConfig(botConfig.botId);

            setBotConnecting(botConfig.botId, true);
            setBotConnectionError(botConfig.botId, null);

            try {
                // 若已有旧连接则先销毁
                if (getChannelByBotId(botConfig.botId)) {
                    await destroyChannelByBotId(botConfig.botId);
                }

                // 创建新 Channel 实例
                const channel = botConfig.platform === 'slack'
                    ? createChannelForBot(botConfig.botId, {
                        platform: 'slack',
                        botToken: form.botToken.trim(),
                        appToken: form.appToken.trim(),
                        defaultAgentId: botConfig.agentId ?? undefined,
                    } as SlackChannelConfig)
                    : createChannelForBot(botConfig.botId, {
                        platform: 'feishu',
                        appId: form.appId.trim(),
                        appSecret: form.appSecret.trim(),
                        defaultAgentId: botConfig.agentId ?? undefined,
                    } as FeishuChannelConfig);

                // 注册连接状态回调
                channel.onConnectionChange((connected, error) => {
                    setBotConnected(botConfig.botId, connected);
                    if (error) setBotConnectionError(botConfig.botId, error);
                });

                // 建立 WebSocket 连接
                await channel.connect();

                // 初始化任务桥接（携带 botId）
                initializeImTaskBridge(botConfig.botId, channel);

                setBotConnected(botConfig.botId, true);
                logger.info(`Bot ${botConfig.botId} (${botConfig.displayName}) 已连接`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setBotConnectionError(botConfig.botId, message);
                setBotConnected(botConfig.botId, false);
                logger.error('连接 IM Bot 失败', { botId: botConfig.botId, platform: botConfig.platform, error: message });
            }
        },
        [getFormState, updateFormState, handleSaveBotConfig, setBotConnecting, setBotConnectionError, setBotConnected, t],
    );

    const handleDisconnect = useCallback(
        async (botConfig: BotConfig) => {
            try {
                await destroyChannelByBotId(botConfig.botId);
                setBotConnected(botConfig.botId, false);
                setBotConnectionError(botConfig.botId, null);
                logger.info(`Bot ${botConfig.botId} 已断开`);
            } catch (error) {
                logger.error('断开 IM Bot 失败', { botId: botConfig.botId, platform: botConfig.platform, error });
            }
        },
        [setBotConnected, setBotConnectionError],
    );

    // ============================================================================
    // 展开时按需加载 Agent 列表
    // ============================================================================

    useEffect(() => {
        for (const config of botConfigs) {
            const form = formStates[config.botId];
            if (!form?.isExpanded || !config.hubId) continue;
            if (loadingAgentsRef.current.has(config.botId)) continue;

            // 条件 1：当前 Hub 的 agent 列表尚未加载（初次展开或 Hub 被外部切换）
            // lastLoadedHubId 可以区分“尚未加载”和“已加载但列表为空”，避免空 Hub 反复加载。
            const agentsNotLoaded =
                form.lastLoadedHubId !== config.hubId
                && !form.isLoadingAgents;

            const missingAgentAction = resolveMissingAgentAction({
                agentId: config.agentId,
                currentHubId: config.hubId,
                lastLoadedHubId: form.lastLoadedHubId,
                agents: form.hubAgents,
                lastMissingAgentReloadKey: form.lastMissingAgentReloadKey,
            });

            if (missingAgentAction === 'clear') {
                updateBotConfig(config.botId, { agentId: null });
                updateFormState(config.botId, { lastMissingAgentReloadKey: null });
                continue;
            }

            if (missingAgentAction === 'reload' && config.agentId) {
                updateFormState(config.botId, {
                    lastMissingAgentReloadKey: getMissingAgentReloadKey(
                        config.hubId,
                        config.agentId,
                    ),
                });
            }

            if (agentsNotLoaded || missingAgentAction === 'reload') {
                void loadAgentsForBot(config.botId, config.hubId);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [botConfigs, formStates]);

    // ============================================================================
    // 渲染
    // ============================================================================

    const renderPlatformSection = (platform: 'feishu' | 'slack') => {
        const platformBotConfigs = botConfigs.filter((config) => config.platform === platform);
        const title = platform === 'slack'
            ? t('settings.im.slackTitle')
            : t('settings.im.feishuTitle');
        const description = platform === 'slack'
            ? t('settings.im.slackDescription')
            : t('settings.im.feishuDescription');
        const addLabel = platform === 'slack'
            ? t('settings.im.addSlackBot')
            : t('settings.im.addFeishuBot');
        const openAppTitle = platform === 'slack'
            ? t('settings.im.openSlackAppsTitle')
            : t('settings.im.openFeishuAppsTitle');
        const platformAtLimit = platformBotConfigs.length >= MAX_BOT_COUNT;

        return (
            <div className={styles.serviceSection}>
                <div className={styles.headerRow}>
                    <div>
                        <div className={styles.serviceTitleRow}>
                            <h4 className={styles.serviceName}>{title}</h4>
                            <Tooltip content={openAppTitle}>
                                <button
                                    className={styles.externalLinkButton}
                                    onClick={() => void openExternalUrl(PLATFORM_APP_URLS[platform])}
                                    aria-label={openAppTitle}
                                >
                                    <ExternalLink size={14} />
                                </button>
                            </Tooltip>
                        </div>
                        <p className={styles.serviceDesc}>{description}</p>
                    </div>
                    <Tooltip
                        content={platformAtLimit
                            ? t('settings.im.maxBotsTitle', { count: MAX_BOT_COUNT })
                            : t('settings.im.addBotTitle')}
                    >
                        <span className={styles.tooltipButtonWrap}>
                            <button
                                id={`im-add-${platform}-bot-button`}
                                className={styles.addBotButton}
                                onClick={() => handleAddBot(platform)}
                                disabled={platformAtLimit}
                                aria-label={platformAtLimit
                                    ? t('settings.im.maxBotsTitle', { count: MAX_BOT_COUNT })
                                    : t('settings.im.addBotTitle')}
                            >
                                {addLabel}
                            </button>
                        </span>
                    </Tooltip>
                </div>

                <div className={styles.botList}>
                    {platformBotConfigs.length === 0 ? (
                        <div className={styles.emptyState}>
                            {platform === 'slack'
                                ? t('settings.im.emptySlackBots')
                                : t('settings.im.emptyFeishuBots')}<br />
                            {t('settings.im.emptyBotsHint')}
                        </div>
                    ) : (
                        platformBotConfigs.map((botConfig) => (
                            <BotCard
                                key={botConfig.botId}
                                botConfig={botConfig}
                                connectionState={getBotConnectionState({ connectionStates }, botConfig.botId)}
                                formState={getFormState(botConfig.botId)}
                                hubs={hubs}
                                onToggleExpand={() => handleToggleExpand(botConfig.botId)}
                                onFormStateChange={(updates) => updateFormState(botConfig.botId, updates)}
                                onHubChange={(hubId) => handleHubChange(botConfig.botId, hubId)}
                                onAgentChange={(agentId) => updateBotConfig(botConfig.botId, { agentId })}
                                onDisplayNameChange={(name) => updateBotConfig(botConfig.botId, { displayName: name })}
                                onOutboundReceiveIdTypeChange={(outboundReceiveIdType) => updateBotConfig(botConfig.botId, { outboundReceiveIdType })}
                                onOutboundReceiveIdChange={(outboundReceiveId) => updateBotConfig(botConfig.botId, { outboundReceiveId })}
                                onSlackDefaultChannelIdChange={(slackDefaultChannelId) => updateBotConfig(botConfig.botId, { slackDefaultChannelId })}
                                onConnect={() => handleConnect(botConfig)}
                                onDisconnect={() => handleDisconnect(botConfig)}
                                onDelete={() => handleDeleteBot(botConfig)}
                                onSave={() => handleSaveBotConfig(botConfig.botId)}
                            />
                        ))
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className={styles.container}>
            <div className={styles.serviceSection}>
                <h4 className={styles.serviceName}>{t('settings.im.title')}</h4>
                <p className={styles.serviceDesc}>{t('settings.im.description')}</p>
            </div>

            {renderPlatformSection('feishu')}
            {renderPlatformSection('slack')}

            {/* ─── 全局设置 ─── */}
            <div className={styles.serviceSection}>
                <div className={styles.toggleRow}>
                    <label className={styles.toggleLabel}>
                        <input
                            id="im-auto-connect-toggle"
                            className={styles.toggleInput}
                            type="checkbox"
                            checked={autoConnect}
                            onChange={(e) => setAutoConnect(e.target.checked)}
                        />
                        <span className={styles.toggleSwitch} />
                        <span className={styles.toggleText}>{t('settings.im.autoConnect')}</span>
                    </label>
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// BotCard 子组件（单个 Bot 卡片）
// ============================================================================

interface BotCardProps {
    botConfig: BotConfig;
    connectionState: import('@stores/imChannelStore').BotConnectionState;
    formState: BotFormState;
    hubs: { id: string; name: string }[];
    onToggleExpand: () => void;
    onFormStateChange: (updates: Partial<BotFormState>) => void;
    onHubChange: (hubId: string | null) => void;
    onAgentChange: (agentId: string | null) => void;
    onDisplayNameChange: (name: string) => void;
    onOutboundReceiveIdTypeChange: (receiveIdType: NonNullable<BotConfig['outboundReceiveIdType']>) => void;
    onOutboundReceiveIdChange: (receiveId: string | null) => void;
    onSlackDefaultChannelIdChange: (channelId: string | null) => void;
    onConnect: () => void;
    onDisconnect: () => void;
    onDelete: () => void;
    onSave: () => void;
}

function BotCard({
    botConfig,
    connectionState,
    formState,
    hubs,
    onToggleExpand,
    onFormStateChange,
    onHubChange,
    onAgentChange,
    onDisplayNameChange,
    onOutboundReceiveIdTypeChange,
    onOutboundReceiveIdChange,
    onSlackDefaultChannelIdChange,
    onConnect,
    onDisconnect,
    onDelete,
    onSave,
}: BotCardProps) {
    const { t } = useI18n();
    const { isConnected, isConnecting, connectionError, totalTasksHandled } = connectionState;
    const { appId, appSecret, botToken, appToken, isLoadingCredentials, isExpanded, hubAgents, isLoadingAgents } = formState;

    // ─── 状态徽章 ───
    const statusBadgeClass = cx(
        styles.statusBadge,
        isConnected ? styles.online : isConnecting ? styles.connecting : styles.offline
    );

    const statusText = isConnected ? t('settings.im.online') : isConnecting ? t('settings.im.connecting') : t('settings.im.offline');

    // ─── Bot 元信息：凭据状态 + App ID 前缀 ───
    // hasCredentials 持久化在 store 中，折叠/刷新后依然正确。
    // appId 来自 formState，只有展开后才有值，用于额外细节展示。
    const botMeta = (() => {
        if (botConfig.platform === 'slack' && botToken) return `Token: ${botToken.slice(0, 12)}...`;
        if (appId) return `App: ${appId.slice(0, 12)}...`;
        if (botConfig.hasCredentials) return t('settings.im.credentialsSaved');
        return t('settings.im.credentialsMissing');
    })();

    const botCardClass = cx(styles.botCard, isConnected && styles.botCardConnected);

    return (
        <div className={botCardClass}>
            {/* ─── 卡片头部（折叠行） ─── */}
            <div className={styles.botCardHeader} onClick={onToggleExpand}>
                <span className={cx(styles.expandIcon, isExpanded && styles.expandIconOpen)}>
                    ▶
                </span>

                <div className={styles.botInfo}>
                    <div className={styles.botName}>{botConfig.displayName}</div>
                    <div className={styles.botMeta}>{botMeta}</div>
                </div>

                <span className={statusBadgeClass}>
                    <span className={styles.statusDot} />
                    {statusText}
                </span>

                {isConnected && totalTasksHandled > 0 && (
                    <span className={styles.statsRow}>
                        <span className={styles.statsCount}>{totalTasksHandled}</span>
                        <span> {t('settings.im.tasks')}</span>
                    </span>
                )}

                {/* 阻止按钮点击冒泡到折叠逻辑 */}
                <div
                    className={styles.botHeaderActions}
                    onClick={(e) => e.stopPropagation()}
                >
                    {!isConnected ? (
                        <button
                            id={`im-connect-btn-${botConfig.botId}`}
                            className={styles.connectButton}
                            onClick={onConnect}
                            disabled={isConnecting}
                        >
                            {isConnecting ? t('settings.im.connecting') : t('settings.im.connect')}
                        </button>
                    ) : (
                        <button
                            id={`im-disconnect-btn-${botConfig.botId}`}
                            className={styles.disconnectButton}
                            onClick={onDisconnect}
                        >
                            {t('settings.im.disconnect')}
                        </button>
                    )}
                    <Tooltip content={t('settings.im.deleteBotTitle')}>
                        <button
                            id={`im-delete-btn-${botConfig.botId}`}
                            className={styles.deleteBotButton}
                            onClick={onDelete}
                            aria-label={t('settings.im.deleteBotTitle')}
                        >
                            {t('common.delete')}
                        </button>
                    </Tooltip>
                </div>
            </div>

            {/* ─── 连接错误提示 ─── */}
            {connectionError && (
                <div className={styles.errorMessage} style={{ margin: '0 12px 8px' }}>
                    ❌ {connectionError}
                </div>
            )}

            {/* ─── 可折叠配置面板 ─── */}
            {isExpanded && (
                <div className={styles.botConfigPanel}>
                    {/* 显示名称 */}
                    <div className={styles.fieldGroup}>
                        <label className={styles.label}>{t('settings.im.displayName')}</label>
                        <input
                            className={styles.input}
                            type="text"
                            placeholder={t('settings.im.displayNamePlaceholder')}
                            value={botConfig.displayName}
                            onChange={(e) => onDisplayNameChange(e.target.value)}
                        />
                    </div>

                    {botConfig.platform === 'slack' ? (
                        <div className={styles.twoColRow}>
                            <div className={styles.fieldGroup}>
                                <label className={styles.label}>{t('settings.im.slackBotToken')}</label>
                                <input
                                    id={`im-slack-bot-token-${botConfig.botId}`}
                                    className={styles.input}
                                    type="password"
                                    placeholder={t('settings.im.slackBotTokenPlaceholder')}
                                    value={isLoadingCredentials ? '' : botToken}
                                    onChange={(e) => onFormStateChange({ botToken: e.target.value })}
                                    disabled={isConnected || isLoadingCredentials}
                                />
                            </div>
                            <div className={styles.fieldGroup}>
                                <label className={styles.label}>{t('settings.im.slackAppToken')}</label>
                                <input
                                    id={`im-slack-app-token-${botConfig.botId}`}
                                    className={styles.input}
                                    type="password"
                                    placeholder={t('settings.im.slackAppTokenPlaceholder')}
                                    value={isLoadingCredentials ? '' : appToken}
                                    onChange={(e) => onFormStateChange({ appToken: e.target.value })}
                                    disabled={isConnected || isLoadingCredentials}
                                />
                            </div>
                        </div>
                    ) : (
                        <div className={styles.twoColRow}>
                            <div className={styles.fieldGroup}>
                                <label className={styles.label}>App ID</label>
                                <input
                                    id={`im-app-id-${botConfig.botId}`}
                                    className={styles.input}
                                    type="text"
                                    placeholder={t('settings.im.feishuAppIdPlaceholder')}
                                    value={isLoadingCredentials ? t('common.loading') : appId}
                                    onChange={(e) => onFormStateChange({ appId: e.target.value })}
                                    disabled={isConnected || isLoadingCredentials}
                                />
                            </div>
                            <div className={styles.fieldGroup}>
                                <label className={styles.label}>App Secret</label>
                                <input
                                    id={`im-app-secret-${botConfig.botId}`}
                                    className={styles.input}
                                    type="password"
                                    placeholder={t('settings.im.feishuAppSecretPlaceholder')}
                                    value={isLoadingCredentials ? '' : appSecret}
                                    onChange={(e) => onFormStateChange({ appSecret: e.target.value })}
                                    disabled={isConnected || isLoadingCredentials}
                                />
                            </div>
                        </div>
                    )}

                    {/* Hub 选择（多 Hub 时显示） */}
                    {hubs.length > 1 && (
                        <div className={styles.fieldGroup}>
                            <label className={styles.label}>Hub</label>
                            <Select
                                id={`im-hub-select-${botConfig.botId}`}
                                className={styles.select}
                                value={botConfig.hubId ?? ''}
                                onValueChange={(value) => onHubChange(value || null)}
                                options={[
                                    {
                                        value: '',
                                        label: t('settings.im.selectHub'),
                                    },
                                    ...hubs.map((hub) => ({
                                        value: hub.id,
                                        label: hub.name,
                                    })),
                                ]}
                            />
                            <span className={styles.hint}>{t('settings.im.hubHint')}</span>
                        </div>
                    )}

                    {/* Agent 选择 */}
                    <div className={styles.fieldGroup}>
                        <label className={styles.label}>{t('settings.im.targetAgent')}</label>
                        <Select
                            id={`im-agent-select-${botConfig.botId}`}
                            className={styles.select}
                            value={botConfig.agentId ?? ''}
                            disabled={!botConfig.hubId || isLoadingAgents}
                            onValueChange={(value) => onAgentChange(value || null)}
                            options={[
                                {
                                    value: '',
                                    label: !botConfig.hubId
                                        ? t('settings.im.selectHubFirst')
                                        : isLoadingAgents
                                          ? t('common.loading')
                                          : t('settings.im.selectAgent'),
                                },
                                ...hubAgents.map((agent) => ({
                                    value: agent.id,
                                    label: agent.name,
                                })),
                            ]}
                        />
                        <span className={styles.hint}>
                            {t('settings.im.targetAgentHint')}
                        </span>
                    </div>

                    {botConfig.platform === 'slack' ? (
                        <div className={styles.fieldGroup}>
                            <label className={styles.label}>{t('settings.im.slackDefaultChannel')}</label>
                            <input
                                id={`im-slack-default-channel-${botConfig.botId}`}
                                className={styles.input}
                                type="text"
                                placeholder={t('settings.im.slackDefaultChannelPlaceholder')}
                                value={botConfig.slackDefaultChannelId ?? ''}
                                onChange={(e) => onSlackDefaultChannelIdChange(e.target.value.trim() || null)}
                            />
                            <span className={styles.hint}>
                                {t('settings.im.slackDefaultChannelHint')}
                            </span>
                        </div>
                    ) : (
                        <div className={styles.fieldGroup}>
                            <label className={styles.label}>{t('settings.im.defaultOutboundTarget')}</label>
                            <div className={styles.twoColRow}>
                                <Select
                                    id={`im-outbound-type-${botConfig.botId}`}
                                    className={styles.select}
                                    value={botConfig.outboundReceiveIdType ?? 'chat_id'}
                                    onValueChange={(value) => onOutboundReceiveIdTypeChange(
                                        value as NonNullable<BotConfig['outboundReceiveIdType']>,
                                    )}
                                    options={[
                                        { value: 'chat_id', label: 'chat_id' },
                                        { value: 'open_id', label: 'open_id' },
                                        { value: 'user_id', label: 'user_id' },
                                        { value: 'union_id', label: 'union_id' },
                                        { value: 'email', label: 'email' },
                                    ]}
                                />
                                <input
                                    id={`im-outbound-id-${botConfig.botId}`}
                                    className={styles.input}
                                    type="text"
                                    placeholder={t('settings.im.defaultOutboundReceiveIdPlaceholder')}
                                    value={botConfig.outboundReceiveId ?? ''}
                                    onChange={(e) => onOutboundReceiveIdChange(e.target.value.trim() || null)}
                                />
                            </div>
                            <span className={styles.hint}>
                                {t('settings.im.defaultOutboundTargetHint')}
                            </span>
                        </div>
                    )}

                    {/* 保存按钮 */}
                    <div className={styles.saveActions}>
                        <button
                            id={`im-save-btn-${botConfig.botId}`}
                            className={styles.saveButton}
                            onClick={onSave}
                            disabled={botConfig.platform === 'slack'
                                ? (!botToken.trim() || !appToken.trim())
                                : (!appId.trim() || !appSecret.trim())}
                        >
                            {t('settings.im.saveCredentials')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
