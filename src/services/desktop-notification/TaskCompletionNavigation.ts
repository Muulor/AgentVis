/**
 * Task completion notification navigation.
 *
 * Resolves native notification activation payloads into the matching Hub/Agent
 * selection without coupling the Rust notification callback to React components.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useAgentStore } from '@stores/agentStore';
import { useHubStore } from '@stores/hubStore';
import { getLogger } from '@services/logger';

const logger = getLogger('TaskCompletionNavigation');

export const TASK_COMPLETION_NOTIFICATION_OPEN_EVENT = 'task-completion-notification:open';
const RETAINED_TARGET_RETRY_DELAYS_MS = [100, 300, 900] as const;

export interface TaskCompletionNotificationTarget {
  messageId: string;
  contextType: 'agent' | 'hub';
  contextId: string;
  agentId: string;
  hubId?: string;
}

interface AgentOwner {
  id: string;
  hubId: string;
}

function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/** Selects the Hub or Agent that owns a completed-task notification. */
export function navigateToTaskCompletionTarget(target: TaskCompletionNotificationTarget): boolean {
  if (!target.contextId || !target.agentId) {
    return false;
  }

  const hubState = useHubStore.getState();
  const agentState = useAgentStore.getState();

  if (target.contextType === 'hub') {
    const targetHubId = target.contextId;
    if (!hubState.hubs.some((hub) => hub.id === targetHubId)) {
      return false;
    }

    agentState.setCurrentAgentId(null);
    hubState.setCurrentHubId(targetHubId);
    return true;
  }

  const knownAgentHubId =
    agentState.agentHubMap.get(target.agentId) ??
    agentState.agents.find((agent) => agent.id === target.agentId)?.hubId;
  // Do not trust hubId alone: the retained Agent map lets stale notifications for
  // a deleted Agent fail closed instead of selecting a nonexistent conversation.
  if (!knownAgentHubId) {
    return false;
  }

  if (!hubState.hubs.some((hub) => hub.id === knownAgentHubId)) {
    return false;
  }

  hubState.setCurrentHubId(knownAgentHubId);
  agentState.setCurrentAgentId(target.agentId);
  return true;
}

/** Registers the native activation listener for the lifetime of the renderer. */
export async function listenForTaskCompletionNotificationNavigation(): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => undefined;
  }

  let pendingTarget: TaskCompletionNotificationTarget | null = null;
  let isNavigating = false;
  let disposed = false;
  let liveActivationGeneration = 0;
  let retainedReadGeneration = 0;
  let retainedReadRetryAttempt = 0;
  let retainedReadRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let ownershipResolutionGeneration = 0;
  let resolvingAgent: { messageId: string; generation: number } | null = null;
  let lastHandledMessageId: string | null = null;
  const rendererDocument = typeof document === 'undefined' ? null : document;

  const scheduleRetainedReadRetry = (): void => {
    if (disposed || retainedReadRetryTimer !== undefined) return;
    const delay = RETAINED_TARGET_RETRY_DELAYS_MS[retainedReadRetryAttempt];
    if (delay === undefined) return;
    retainedReadRetryAttempt += 1;
    retainedReadRetryTimer = setTimeout(() => {
      retainedReadRetryTimer = undefined;
      readRetainedTarget();
    }, delay);
  };

  const acknowledgeTarget = (messageId: string): void => {
    void invoke('clear_pending_task_completion_notification_target', { messageId }).catch(
      (error: unknown) => {
        logger.warn('[TaskCompletionNavigation] Failed to acknowledge notification target', error);
      }
    );
  };

  function resolvePendingAgentOwnership(target: TaskCompletionNotificationTarget): void {
    const agentState = useAgentStore.getState();
    if (
      target.contextType !== 'agent' ||
      agentState.agentHubMap.has(target.agentId) ||
      agentState.agents.some((agent) => agent.id === target.agentId) ||
      resolvingAgent?.messageId === target.messageId
    ) {
      return;
    }

    const generation = ++ownershipResolutionGeneration;
    resolvingAgent = { messageId: target.messageId, generation };

    void invoke<AgentOwner | null>('agent_get', { id: target.agentId })
      .then((agent) => {
        if (
          disposed ||
          generation !== ownershipResolutionGeneration ||
          pendingTarget?.messageId !== target.messageId
        ) {
          return;
        }

        if (agent?.id !== target.agentId || !agent.hubId) {
          pendingTarget = null;
          lastHandledMessageId = target.messageId;
          acknowledgeTarget(target.messageId);
          return;
        }

        useAgentStore.setState((state) => {
          const agentHubMap = new Map(state.agentHubMap);
          agentHubMap.set(agent.id, agent.hubId);
          return { agentHubMap };
        });
        retryPendingTarget();
      })
      .catch((error: unknown) => {
        if (
          !disposed &&
          generation === ownershipResolutionGeneration &&
          pendingTarget?.messageId === target.messageId
        ) {
          logger.warn('[TaskCompletionNavigation] Failed to resolve notification Agent', error);
        }
      })
      .finally(() => {
        if (resolvingAgent?.generation === generation) {
          resolvingAgent = null;
        }
      });
  }

  function retryPendingTarget(): boolean {
    if (disposed || !pendingTarget || isNavigating) return false;

    const target = pendingTarget;
    let navigated = false;
    isNavigating = true;
    try {
      navigated = navigateToTaskCompletionTarget(target);
      if (navigated) {
        pendingTarget = null;
      }
    } finally {
      isNavigating = false;
    }

    if (navigated) {
      lastHandledMessageId = target.messageId;
      acknowledgeTarget(target.messageId);
    } else {
      resolvePendingAgentOwnership(target);
    }
    return navigated;
  }

  const queueTarget = (target: TaskCompletionNotificationTarget): void => {
    if (disposed) return;
    if (target.messageId === lastHandledMessageId) {
      acknowledgeTarget(target.messageId);
      return;
    }
    pendingTarget = target;
    if (!retryPendingTarget()) {
      logger.debug('[TaskCompletionNavigation] Waiting for notification target data', {
        messageId: target.messageId,
        contextType: target.contextType,
        contextId: target.contextId,
        agentId: target.agentId,
      });
    }
  };

  const stopListening = await listen<TaskCompletionNotificationTarget>(
    TASK_COMPLETION_NOTIFICATION_OPEN_EVENT,
    ({ payload }) => {
      liveActivationGeneration += 1;
      queueTarget(payload);
    }
  );
  const stopHubSubscription = useHubStore.subscribe(() => {
    retryPendingTarget();
  });
  const stopAgentSubscription = useAgentStore.subscribe(() => {
    retryPendingTarget();
  });

  function readRetainedTarget(): void {
    const readGeneration = ++retainedReadGeneration;
    const observedLiveGeneration = liveActivationGeneration;
    void invoke<TaskCompletionNotificationTarget | null>(
      'get_pending_task_completion_notification_target'
    )
      .then((retainedTarget) => {
        if (
          retainedTarget &&
          !disposed &&
          readGeneration === retainedReadGeneration &&
          observedLiveGeneration === liveActivationGeneration
        ) {
          queueTarget(retainedTarget);
        }
        retainedReadRetryAttempt = 0;
      })
      .catch((error: unknown) => {
        if (!disposed) {
          logger.warn(
            '[TaskCompletionNavigation] Failed to read retained notification target',
            error
          );
          scheduleRetainedReadRetry();
        }
      });
  }

  // Native activation restores and focuses the window before emitting. A focus
  // retry drains the retained target if WebView2 resumed too late for that event.
  const handleVisibilityChange = (): void => {
    if (rendererDocument?.visibilityState === 'visible') readRetainedTarget();
  };
  window.addEventListener('focus', readRetainedTarget);
  window.addEventListener('pageshow', readRetainedTarget);
  rendererDocument?.addEventListener('visibilitychange', handleVisibilityChange);
  readRetainedTarget();

  return () => {
    disposed = true;
    retainedReadGeneration += 1;
    ownershipResolutionGeneration += 1;
    pendingTarget = null;
    resolvingAgent = null;
    if (retainedReadRetryTimer !== undefined) clearTimeout(retainedReadRetryTimer);
    stopAgentSubscription();
    stopHubSubscription();
    stopListening();
    window.removeEventListener('focus', readRetainedTarget);
    window.removeEventListener('pageshow', readRetainedTarget);
    rendererDocument?.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}
