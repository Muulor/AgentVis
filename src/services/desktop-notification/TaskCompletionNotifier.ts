/**
 * 任务完成桌面通知服务。
 *
 * 将 Chat/Planning 完成后的 assistant 消息转换为系统原生通知，
 * 统一处理设置、窗口状态、权限、防重复、摘要清洗与脱敏。
 */

import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { useAgentStore } from '@stores/agentStore';
import { useHubStore } from '@stores/hubStore';
import { useSettingsStore } from '@stores/settingsStore';
import { translate } from '@/i18n';
import { getLogger } from '@services/logger';
import { stripVisualCodeBlocks } from '@services/planning/visual-enhancer/stripVisualCodeBlocks';
import { redactSensitiveObservation } from '@services/planning/skills/shared/observationRedaction';

const logger = getLogger('TaskCompletionNotifier');

const MAX_NOTIFICATION_BODY_CHARS = 180;
const MAX_DEDUPE_IDS = 200;
const COMPLETION_CHIME_THROTTLE_MS = 1500;

export type TaskCompletionNotificationSource = 'manual' | 'cron' | 'im';
export type TaskCompletionNotificationMode = 'chat' | 'planning';

export interface TaskCompletionNotificationPayload {
  id: string;
  contextType: 'agent' | 'hub';
  contextId: string;
  agentId: string;
  agentName: string;
  hubId?: string;
  hubName?: string;
  content: string;
  source: TaskCompletionNotificationSource;
  mode: TaskCompletionNotificationMode;
  createdAt: number;
}

export function resolveTaskCompletionNotificationSource(
  value: unknown
): TaskCompletionNotificationSource {
  return value === 'cron' || value === 'im' ? value : 'manual';
}

interface WindowNotificationState {
  focused: boolean;
  minimized: boolean;
  visible: boolean;
}

const notifiedMessageIds: string[] = [];
const notifiedMessageIdSet = new Set<string>();
let lastCompletionChimeAt = 0;

function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

function rememberNotificationId(id: string): void {
  notifiedMessageIds.push(id);
  notifiedMessageIdSet.add(id);

  while (notifiedMessageIds.length > MAX_DEDUPE_IDS) {
    const oldest = notifiedMessageIds.shift();
    if (oldest) {
      notifiedMessageIdSet.delete(oldest);
    }
  }
}

function getNotificationId(messageId: string): number {
  let hash = 0;
  for (let index = 0; index < messageId.length; index += 1) {
    hash = (hash * 31 + messageId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 2_147_483_647 || 1;
}

async function getWindowNotificationState(): Promise<WindowNotificationState> {
  try {
    const currentWindow = getCurrentWindow();
    const [focused, minimized, visible] = await Promise.all([
      currentWindow.isFocused(),
      currentWindow.isMinimized(),
      currentWindow.isVisible(),
    ]);

    return { focused, minimized, visible };
  } catch (error) {
    logger.warn('[TaskCompletionNotifier] 获取窗口状态失败，按后台通知处理:', error);
    return { focused: false, minimized: true, visible: false };
  }
}

function isUserViewingPayload(payload: TaskCompletionNotificationPayload): boolean {
  const { currentAgentId } = useAgentStore.getState();
  const { currentHubId } = useHubStore.getState();

  if (payload.contextType === 'agent') {
    return currentAgentId === payload.contextId;
  }

  return currentAgentId === null && currentHubId === payload.contextId;
}

function shouldNotify(
  payload: TaskCompletionNotificationPayload,
  windowState: WindowNotificationState
): boolean {
  const settings = useSettingsStore.getState();
  if (!settings.taskCompletionNotificationsEnabled) {
    return false;
  }

  const isForeground = windowState.focused && windowState.visible && !windowState.minimized;
  if (settings.taskCompletionNotificationsBackgroundOnly && isForeground) {
    return false;
  }

  if (isForeground && isUserViewingPayload(payload)) {
    return false;
  }

  return true;
}

async function ensureNotificationPermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === 'granted';
  }
  return granted;
}

function stripMarkdown(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[>\-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}

function normalizeWhitespace(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function truncateSummary(content: string): string {
  if (content.length <= MAX_NOTIFICATION_BODY_CHARS) {
    return content;
  }
  return `${content.slice(0, MAX_NOTIFICATION_BODY_CHARS - 1)}…`;
}

function buildSummary(content: string): string {
  const visualSafe = stripVisualCodeBlocks(content);
  const markdownSafe = stripMarkdown(visualSafe);
  const redacted = redactSensitiveObservation(markdownSafe);
  return truncateSummary(normalizeWhitespace(redacted));
}

function resolveHubName(payload: TaskCompletionNotificationPayload): string | undefined {
  if (payload.hubName) return payload.hubName;

  const hubId =
    payload.hubId ??
    (payload.contextType === 'hub'
      ? payload.contextId
      : useAgentStore.getState().agentHubMap.get(payload.agentId));
  if (!hubId) return undefined;

  return useHubStore.getState().hubs.find((hub) => hub.id === hubId)?.name;
}

function buildNotificationBody(payload: TaskCompletionNotificationPayload): string {
  const settings = useSettingsStore.getState();
  if (settings.taskCompletionNotificationContentMode === 'private') {
    const hubName = resolveHubName(payload);
    return hubName
      ? translate('notifications.taskCompletedPrivateBodyWithHub', { hubName })
      : translate('notifications.taskCompletedPrivateBody');
  }

  return buildSummary(payload.content) || translate('notifications.taskCompletedFallbackSummary');
}

function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext;
}

function playSoftCompletionChime(): void {
  const nowMs = Date.now();
  if (nowMs - lastCompletionChimeAt < COMPLETION_CHIME_THROTTLE_MS) {
    return;
  }
  lastCompletionChimeAt = nowMs;

  try {
    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) {
      return;
    }

    const audioContext = new AudioContextConstructor();
    const startAt = audioContext.currentTime;
    const durationSeconds = 0.42;

    const filter = audioContext.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, startAt);

    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.045, startAt + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSeconds);

    const oscillator = audioContext.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(523.25, startAt);
    oscillator.frequency.linearRampToValueAtTime(659.25, startAt + 0.16);
    oscillator.frequency.setValueAtTime(659.25, startAt + 0.24);
    oscillator.frequency.linearRampToValueAtTime(587.33, startAt + durationSeconds);

    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(startAt);
    oscillator.stop(startAt + durationSeconds);
    oscillator.onended = () => {
      void audioContext.close().catch((error: unknown) => {
        logger.debug('[TaskCompletionNotifier] 关闭提示音 AudioContext 失败:', error);
      });
    };
  } catch (error) {
    logger.debug('[TaskCompletionNotifier] 播放任务完成提示音失败:', error);
  }
}

/**
 * 发布任务完成桌面通知。
 */
export async function notifyTaskCompleted(
  payload: TaskCompletionNotificationPayload
): Promise<void> {
  if (!hasTauriRuntime()) {
    return;
  }

  if (notifiedMessageIdSet.has(payload.id)) {
    return;
  }
  rememberNotificationId(payload.id);

  try {
    const windowState = await getWindowNotificationState();
    if (!shouldNotify(payload, windowState)) {
      return;
    }

    const granted = await ensureNotificationPermission();
    if (!granted) {
      logger.debug('[TaskCompletionNotifier] 用户未授予系统通知权限');
      return;
    }

    sendNotification({
      id: getNotificationId(payload.id),
      title: translate('notifications.taskCompletedTitle', { agentName: payload.agentName }),
      body: buildNotificationBody(payload),
      group: 'agentvis-task-completed',
      autoCancel: true,
      silent: true,
      extra: {
        messageId: payload.id,
        contextType: payload.contextType,
        contextId: payload.contextId,
        agentId: payload.agentId,
        source: payload.source,
        mode: payload.mode,
        createdAt: payload.createdAt,
      },
    });
    playSoftCompletionChime();
  } catch (error) {
    logger.warn('[TaskCompletionNotifier] 发送任务完成系统通知失败:', error);
  }
}
