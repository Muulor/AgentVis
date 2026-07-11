/**
 * ImSendTool - 统一 IM 主动发送工具
 *
 * 根据显式 platform、当前 IM Bot 上下文或目标参数，路由到飞书/Slack 的平台发送实现。
 */

import { translate } from '@/i18n';
import type { BotConfig } from '@services/im-channel/types';
import { getLogger } from '@services/logger';
import { useImChannelStore } from '@stores/imChannelStore';
import type { Tool, ToolExecutionContext, ToolResult, ToolSchema } from '../../tools/types';
import { feishuSendTool } from '../feishu_send/tool';
import { slackSendTool } from '../slack_send/tool';

const logger = getLogger('ImSendTool');

type SupportedImSendPlatform = 'feishu' | 'slack';

const SUPPORTED_PLATFORMS: readonly SupportedImSendPlatform[] = ['feishu', 'slack'];

const SCHEMA: ToolSchema = {
  name: 'im_send',
  description:
    'Send a text message, image, or local file through an AgentVis-configured IM bot. ' +
    'Supports Feishu and Slack. When platform is omitted, the tool uses the current IM bot context, then target-specific parameters, then the single usable bot for the current Agent.',
  parameters: {
    type: 'object',
    properties: {
      platform: {
        type: 'string',
        description:
          'Optional IM platform. Use feishu for Feishu/Lark or slack for Slack. Usually omit it in IM-triggered tasks because the current bot context is injected automatically.',
        enum: ['feishu', 'slack'],
      },
      action: {
        type: 'string',
        description: 'Send action: send_text, send_image, or send_file.',
        enum: ['send_text', 'send_image', 'send_file'],
      },
      text: {
        type: 'string',
        description:
          'Text content for send_text, or an optional caption/summary for send_image/send_file attachments.',
      },
      caption: {
        type: 'string',
        description: 'Optional caption or status summary for an image or file attachment.',
      },
      filePath: {
        type: 'string',
        description: 'Absolute or workdir-relative local file path for send_image or send_file.',
      },
      channelId: {
        type: 'string',
        description:
          'Optional Slack channel, private channel, MPIM, or DM ID such as C..., G..., or D....',
      },
      receiveIdType: {
        type: 'string',
        description:
          'Optional Feishu receiver ID type. Supported: chat_id, open_id, user_id, union_id, email. Defaults to the bot setting or chat_id.',
        enum: ['chat_id', 'open_id', 'user_id', 'union_id', 'email'],
      },
      receiveId: {
        type: 'string',
        description:
          'Optional Feishu receiver ID. Examples: chat_id starting with oc_, open_id, user_id, union_id, or email.',
      },
      botId: {
        type: 'string',
        description:
          'Optional AgentVis IM bot ID. Usually omit it; IM and cron contexts inject the correct bot automatically.',
      },
    },
    required: ['action'],
  },
};

function getStringParam(params: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = params[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isSupportedPlatform(platform: string | undefined): platform is SupportedImSendPlatform {
  return SUPPORTED_PLATFORMS.includes(platform as SupportedImSendPlatform);
}

function formatBotList(bots: BotConfig[]): string {
  return bots.map((bot) => `- ${bot.displayName} (${bot.platform}, ${bot.botId})`).join('\n');
}

function findBot(botId: string | undefined): BotConfig | undefined {
  if (!botId) return undefined;
  return useImChannelStore.getState().botConfigs.find((config) => config.botId === botId);
}

function inferPlatformFromTargetParams(
  params: Record<string, unknown>
): SupportedImSendPlatform | undefined {
  if (getStringParam(params, 'channelId', 'channel_id')) {
    return 'slack';
  }

  if (getStringParam(params, 'receiveId', 'receive_id', 'receiveIdType', 'receive_id_type')) {
    return 'feishu';
  }

  return undefined;
}

function inferPlatformFromConfiguredBots(context: ToolExecutionContext): {
  platform?: SupportedImSendPlatform;
  error?: string;
} {
  const { botConfigs } = useImChannelStore.getState();
  const usableBots = botConfigs.filter(
    (bot) => bot.enabled && bot.hasCredentials && isSupportedPlatform(bot.platform)
  );
  const agentMatchedBots = context.agentId
    ? usableBots.filter((bot) => bot.agentId === context.agentId)
    : [];

  if (agentMatchedBots.length === 1) {
    return { platform: agentMatchedBots[0]?.platform as SupportedImSendPlatform };
  }
  if (agentMatchedBots.length > 1) {
    return {
      error: translate('tools.imSend.multipleBotsForAgent', {
        list: formatBotList(agentMatchedBots),
      }),
    };
  }

  if (usableBots.length === 1) {
    return { platform: usableBots[0]?.platform as SupportedImSendPlatform };
  }
  if (usableBots.length > 1) {
    return {
      error: translate('tools.imSend.multipleBots', {
        list: formatBotList(usableBots),
      }),
    };
  }

  return { error: translate('tools.imSend.noUsableBot') };
}

function resolvePlatform(
  params: Record<string, unknown>,
  context: ToolExecutionContext
): { platform?: SupportedImSendPlatform; error?: string } {
  const explicitPlatform = getStringParam(params, 'platform');
  if (explicitPlatform) {
    return isSupportedPlatform(explicitPlatform)
      ? { platform: explicitPlatform }
      : { error: translate('tools.imSend.invalidPlatform', { platform: explicitPlatform }) };
  }

  const requestedBotId = getStringParam(params, 'botId', 'bot_id');
  const botFromArgsOrContext = findBot(requestedBotId ?? context.imBotId);
  if (requestedBotId || context.imBotId) {
    const botId = requestedBotId ?? context.imBotId;
    if (!botFromArgsOrContext) {
      return { error: translate('tools.imSend.botNotFound', { botId }) };
    }
    if (!isSupportedPlatform(botFromArgsOrContext.platform)) {
      return {
        error: translate('tools.imSend.botUnsupportedPlatform', {
          botId,
          platform: botFromArgsOrContext.platform,
        }),
      };
    }
    return { platform: botFromArgsOrContext.platform };
  }

  const targetPlatform = inferPlatformFromTargetParams(params);
  if (targetPlatform) {
    return { platform: targetPlatform };
  }

  return inferPlatformFromConfiguredBots(context);
}

function buildRoutedContext(
  platform: SupportedImSendPlatform,
  params: Record<string, unknown>,
  context: ToolExecutionContext
): ToolExecutionContext {
  const requestedBotId = getStringParam(params, 'botId', 'bot_id');
  if (requestedBotId || !context.imBotId) {
    return context;
  }

  const contextBot = findBot(context.imBotId);
  if (contextBot?.platform === platform) {
    return context;
  }

  return {
    ...context,
    imBotId: undefined,
  };
}

function buildRoutedParams(params: Record<string, unknown>): Record<string, unknown> {
  const routedParams = { ...params };
  delete routedParams.platform;
  return routedParams;
}

class ImSendToolImpl implements Tool {
  readonly schema = SCHEMA;

  async execute(
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const platformResolution = resolvePlatform(params, context);
    if (!platformResolution.platform) {
      return {
        success: false,
        content: platformResolution.error ?? translate('tools.imSend.missingPlatform'),
      };
    }

    const platform = platformResolution.platform;
    const routedContext = buildRoutedContext(platform, params, context);
    const routedParams = buildRoutedParams(params);

    logger.trace('im_send 路由到 IM 平台', {
      platform,
      botId: getStringParam(params, 'botId', 'bot_id') ?? routedContext.imBotId,
    });

    return platform === 'feishu'
      ? feishuSendTool.execute(routedParams, routedContext)
      : slackSendTool.execute(routedParams, routedContext);
  }
}

export const imSendTool = new ImSendToolImpl();
