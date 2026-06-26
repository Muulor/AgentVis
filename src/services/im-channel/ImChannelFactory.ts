/**
 * ImChannelFactory - IM 通道工厂（多 Bot 版本）
 *
 * 从"per-platform 单实例"升级为"per-botId 多实例"：
 * - activeChannels 的 key 从 ImPlatform 改为 botId（UUID）
 * - 每个 Bot 独立持有一个 Channel 实例，互不干扰
 * - 旧 API（createChannel / getChannel / destroyChannel）保留向后兼容，
 *   内部映射到 botId='__legacy__' 的 slot，确保 CronExecutor 等不受影响
 *
 * 设计说明：
 * - 策略模式替代 if-else，符合开闭原则
 * - 工厂维护 Channel 实例缓存，避免重复连接
 */

import type {
    ImPlatform,
    ImChannel,
    ImChannelConfig,
    ImChannelCreator,
} from './types';
import { getLogger } from '@services/logger';
import { clearImBotTaskState } from './ImTaskBridge';

const logger = getLogger('ImChannelFactory');

// ============================================================================
// 错误类型
// ============================================================================

/** 不支持的平台错误 */
export class UnsupportedPlatformError extends Error {
    constructor(public readonly platform: string) {
        super(`Unsupported IM platform: ${platform}`);
        this.name = 'UnsupportedPlatformError';
    }
}

/** Channel 已存在错误 */
export class ChannelAlreadyExistsError extends Error {
    constructor(public readonly botId: string) {
        super(`Channel instance for bot ${botId} already exists. Call destroyChannelByBotId() first.`);
        this.name = 'ChannelAlreadyExistsError';
    }
}

// ============================================================================
// 注册表与实例缓存
// ============================================================================

/** 平台适配器注册表（platform → creator） */
const platformCreators = new Map<ImPlatform, ImChannelCreator>();

/**
 * 活跃的 Channel 实例缓存
 *
 * key = botId（UUID）
 * 每个 Bot 独立维护一个 Channel 实例，允许多 Bot 并联运行。
 */
const activeChannels = new Map<string, ImChannel>();

// ============================================================================
// 平台注册
// ============================================================================

/**
 * 注册平台适配器
 *
 * 在模块加载时调用，例如:
 * ```ts
 * registerPlatform('feishu', (config) => new FeishuChannel(config as FeishuChannelConfig));
 * ```
 *
 * @param platform - 平台标识
 * @param creator - 创建函数
 */
export function registerPlatform(platform: ImPlatform, creator: ImChannelCreator): void {
    if (platformCreators.has(platform)) {
        logger.warn(`平台 ${platform} 已注册，将覆盖原有创建函数`);
    }
    platformCreators.set(platform, creator);
    logger.trace(`已注册 IM 平台适配器: ${platform}`);
}

// ============================================================================
// 多 Bot 核心 API
// ============================================================================

/**
 * 为指定 botId 创建 Channel 实例
 *
 * 如果该 botId 已存在 Channel 实例，会抛出 ChannelAlreadyExistsError。
 * 创建后的实例缓存在工厂中，可通过 getChannelByBotId() 获取。
 *
 * @param botId - Bot 唯一标识（UUID）
 * @param config - Channel 配置（包含 appId / appSecret）
 * @returns 创建的 Channel 实例
 * @throws UnsupportedPlatformError 如果平台未注册
 * @throws ChannelAlreadyExistsError 如果该 botId 已存在实例
 */
export function createChannelForBot(botId: string, config: ImChannelConfig): ImChannel {
    if (activeChannels.has(botId)) {
        throw new ChannelAlreadyExistsError(botId);
    }

    const creator = platformCreators.get(config.platform);
    if (!creator) {
        throw new UnsupportedPlatformError(config.platform);
    }

    const channel = creator(config);
    activeChannels.set(botId, channel);
    logger.trace(`已创建 Channel 实例: botId=${botId}, platform=${config.platform}`);
    return channel;
}

/**
 * 获取指定 botId 的 Channel 实例
 *
 * @param botId - Bot 唯一标识
 * @returns Channel 实例，不存在则返回 null
 */
export function getChannelByBotId(botId: string): ImChannel | null {
    return activeChannels.get(botId) ?? null;
}

/**
 * 销毁指定 botId 的 Channel 实例
 *
 * 断开连接并移除缓存，释放 WebSocket 资源。
 *
 * @param botId - Bot 唯一标识
 */
export async function destroyChannelByBotId(botId: string): Promise<void> {
    const channel = activeChannels.get(botId);
    if (!channel) {
        clearImBotTaskState(botId);
        logger.warn(`销毁 Channel 失败: botId=${botId} 不存在`);
        return;
    }

    try {
        if (channel.isConnected()) {
            await channel.disconnect();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`断开 botId=${botId} Channel 时出错`, { error: message });
    }

    activeChannels.delete(botId);
    clearImBotTaskState(botId);
    logger.trace(`已销毁 Channel 实例: botId=${botId}`);
}

/**
 * 销毁所有 Channel 实例
 *
 * 应用退出时调用，确保所有 WebSocket 连接被关闭。
 */
export async function destroyAllChannels(): Promise<void> {
    const botIds = Array.from(activeChannels.keys());
    for (const botId of botIds) {
        await destroyChannelByBotId(botId);
    }
    logger.trace('已销毁所有 Channel 实例');
}

/**
 * 获取所有活跃连接的 botId 列表
 */
export function getConnectedBotIds(): string[] {
    return Array.from(activeChannels.entries())
        .filter(([, channel]) => channel.isConnected())
        .map(([botId]) => botId);
}

/**
 * 获取所有已注册的平台列表
 */
export function getSupportedPlatforms(): ImPlatform[] {
    return Array.from(platformCreators.keys());
}

// ============================================================================
// 向后兼容 API（旧单 Bot 接口，不对外推荐，仅供过渡期使用）
// ============================================================================

/** 旧版单 Bot 接口使用的保留 botId */
const LEGACY_BOT_ID = '__legacy__';

/**
 * @deprecated 请使用 createChannelForBot(botId, config)
 *
 * 向后兼容：创建 Channel 实例，映射到 LEGACY_BOT_ID slot。
 * 确保 CronExecutor、现有设置面板等旧路径不受影响。
 */
export function createChannel(config: ImChannelConfig): ImChannel {
    return createChannelForBot(LEGACY_BOT_ID, config);
}

/**
 * @deprecated 请使用 getChannelByBotId(botId)
 *
 * 注意：传入的 platform 参数已被忽略，始终返回 LEGACY_BOT_ID slot。
 * 如果你调用了 createChannelForBot(realBotId, ...) 创建的 Bot，请不要用此方法读取。
 */
export function getChannel(_platform: ImPlatform): ImChannel | null {
    logger.warn(
        '[ImChannelFactory] getChannel(平台) 已废弃，platform 参数将被忽略，'
        + '结果为 LEGACY_BOT_ID slot。请改用 getChannelByBotId(botId)。'
    );
    return getChannelByBotId(LEGACY_BOT_ID);
}

/**
 * 获取当前活跃的 Channel（任意 botId 中第一个）
 *
 * @deprecated 多 Bot 场景下请通过 botId 精确获取
 */
export function getActiveChannel(): ImChannel | null {
    const first = activeChannels.values().next();
    return first.done ? null : first.value;
}

/**
 * @deprecated 请使用 destroyChannelByBotId(botId)
 */
export async function destroyChannel(_platform: ImPlatform): Promise<void> {
    await destroyChannelByBotId(LEGACY_BOT_ID);
}

/**
 * @deprecated 请使用 getConnectedBotIds()
 */
export function getConnectedPlatforms(): ImPlatform[] {
    return Array.from(activeChannels.entries())
        .filter(([, channel]) => channel.isConnected())
        .map(([, channel]) => channel.platform);
}
