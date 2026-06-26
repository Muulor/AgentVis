import type { ToolCall } from './types';

const TOOL_NAME_ALIASES: Record<string, string> = {
    feishu_send: 'im_send',
    slack_send: 'im_send',
};

const IM_SEND_PLATFORM_BY_LEGACY_TOOL: Record<string, 'feishu' | 'slack'> = {
    feishu_send: 'feishu',
    slack_send: 'slack',
};

export function getCanonicalToolName(toolName: string): string {
    return TOOL_NAME_ALIASES[toolName] ?? toolName;
}

export function getLegacyImSendPlatform(toolName: string): 'feishu' | 'slack' | undefined {
    return IM_SEND_PLATFORM_BY_LEGACY_TOOL[toolName];
}

export function getToolNamesForSchemaFilter(toolNames: string[]): string[] {
    return Array.from(new Set(toolNames.flatMap(toolName => [
        toolName,
        getCanonicalToolName(toolName),
    ])));
}

export function isAllowedToolName(toolName: string, allowedTools: string[]): boolean {
    return allowedTools.includes(toolName)
        || allowedTools.includes(getCanonicalToolName(toolName));
}

export function normalizeToolCallForExecution(toolCall: ToolCall): ToolCall {
    const canonicalName = getCanonicalToolName(toolCall.name);
    const legacyPlatform = getLegacyImSendPlatform(toolCall.name);
    if (!legacyPlatform) {
        return canonicalName === toolCall.name
            ? toolCall
            : { ...toolCall, name: canonicalName };
    }

    return {
        name: canonicalName,
        args: {
            ...toolCall.args,
            platform: legacyPlatform,
        },
    };
}
