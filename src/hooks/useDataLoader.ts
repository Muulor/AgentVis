/**
 * useDataLoader Hook
 *
 * 应用启动时加载持久化数据（Hub、Agent 和聊天历史）
 * 从 Rust 后端 SQLite 数据库加载到 Zustand Store
 */
import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useHubStore } from '@stores/hubStore';
import { useAgentStore } from '@stores/agentStore';
import { useChatStore } from '@stores/chatStore';
import { useRuntimeStore } from '@stores/runtimeStore';
import type { ReasoningPreset } from '@/config/modelRegistry';
import { useWidgetStore } from '@stores/widgetStore';
import { collectWidgetBubbleSubmissions } from '@stores/widgetSubmissionRecovery';
import { getLogger } from '@services/logger';
import type { Message } from '@/types';
import { parseQuotedFrom, type PersistedMessageItem } from '@utils/messageReload';

const logger = getLogger('useDataLoader');

// ==================== 工具函数 ====================

export function shouldApplyAgentLoadResult(params: {
  requestedHubId: string;
  activeHubId: string | null;
  requestGeneration: number;
  latestGeneration: number;
}): boolean {
  return (
    params.requestedHubId === params.activeHubId &&
    params.requestGeneration === params.latestGeneration
  );
}

export function resolveInitialHubId(
  hubs: ReadonlyArray<{ id: string }>,
  selectedHubId: string | null
): string | null {
  return selectedHubId && hubs.some((hub) => hub.id === selectedHubId)
    ? selectedHubId
    : (hubs[0]?.id ?? null);
}

/** 从已解析的 metadata 中安全提取 quotedFrom 列表 */

/** Hub 类型 - 对应 Rust 端 HubItem */
interface HubItem {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** Agent 类型 - 对应 Rust 端 AgentItem */
interface AgentItem {
  id: string;
  hubId: string;
  name: string;
  sortOrder?: number;
  avatarColor: string | null;
  modelProvider: string | null;
  modelName: string | null;
  reasoningPreset: ReasoningPreset | null;
  mbRulesFilePath: string | null;
  saRulesFilePath: string | null;
  mbRules: string | null;
  saRules: string | null;
  chatRules: string | null;
  knowledgePaths: string | null;
  visualEnhancementEnabled?: boolean | null;
  sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork' | null;
  latestMessagePreview?: string | null;
  latestMessageAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 加载 Hub、Agent 和聊天历史数据的 Hook
 *
 * 在应用启动时调用一次，从后端获取持久化数据
 */
export function useDataLoader(): void {
  const setHubs = useHubStore((state) => state.setHubs);
  const setCurrentHubId = useHubStore((state) => state.setCurrentHubId);
  const currentHubId = useHubStore((state) => state.currentHubId);
  const setAgents = useAgentStore((state) => state.setAgents);
  const currentAgentId = useAgentStore((state) => state.currentAgentId);
  const setMessages = useChatStore((state) => state.setMessages);
  // 技能偏好初始化（AppData 文件加载）
  const initSkillPreferences = useRuntimeStore((state) => state.initSkillPreferences);

  // 使用 ref 标记是否已初始化，防止重复加载
  const isInitialized = useRef(false);
  // 记录已加载消息的 Agent，避免重复加载
  const loadedAgentIds = useRef<Set<string>>(new Set());
  // 记录已加载消息的 Hub，避免重复加载
  const loadedHubIds = useRef<Set<string>>(new Set());
  // Hub 快速切换时只允许最后一次 Agent 列表请求写入 store。
  const agentLoadGenerationRef = useRef(0);

  // 初始化加载 Hub 列表
  useEffect(() => {
    if (isInitialized.current) return;
    isInitialized.current = true;

    async function loadInitialData(): Promise<void> {
      try {
        // 0. 预先加载技能开关偏好，必须在 scanAndRegister 调用 setInstalledSkills 前完成
        //    避免首次加载时技能开关状态闪灯（内存空 → 全开 → 加载偏好 → 部分关闭）
        await initSkillPreferences();

        // 1. 加载 Hub 列表
        const hubs = await invoke<HubItem[]>('hub_list');

        // 转换字段名以匹配前端类型
        const formattedHubs = hubs.map((h) => ({
          id: h.id,
          name: h.name,
          sortOrder: h.sortOrder,
          createdAt: String(h.createdAt),
          updatedAt: String(h.updatedAt),
        }));

        setHubs(formattedHubs);

        // 2. 优先使用当前 Store 选择（通知激活可能在 setHubs 订阅中刚更新它），
        //    如果不存在，再回退到第一个 Hub。避免启动水合覆盖通知导航。
        const selectedHubId = useHubStore.getState().currentHubId;
        const initialHubId = resolveInitialHubId(hubs, selectedHubId);
        if (initialHubId !== selectedHubId) {
          setCurrentHubId(initialHubId);
        }

        if (initialHubId) {
          // 3. 加载初始 Hub 下的 Agent
          const requestGeneration = ++agentLoadGenerationRef.current;
          const agents = await invoke<AgentItem[]>('agent_list_by_hub', {
            hubId: initialHubId,
          });
          if (
            shouldApplyAgentLoadResult({
              requestedHubId: initialHubId,
              activeHubId: useHubStore.getState().currentHubId,
              requestGeneration,
              latestGeneration: agentLoadGenerationRef.current,
            })
          ) {
            setAgents(agents);
          } else {
            logger.trace('[useDataLoader] 忽略过期的初始 Hub Agent 列表响应', {
              hubId: initialHubId,
              requestGeneration,
            });
          }
        }

        logger.trace('[useDataLoader] 初始化数据加载完成', {
          hubCount: hubs.length,
        });
      } catch (error) {
        logger.error('[useDataLoader] 加载初始数据失败:', error);
      }
    }

    void loadInitialData();
  }, [setHubs, setCurrentHubId, setAgents, currentHubId, initSkillPreferences]);

  // 监听 Hub 切换，加载对应的 Agent 列表
  useEffect(() => {
    // 跳过初始加载（由上面的 effect 处理）
    if (!currentHubId) return;
    const requestedHubId: string = currentHubId;

    async function loadAgentsForHub(): Promise<void> {
      const requestGeneration = ++agentLoadGenerationRef.current;
      try {
        const agents = await invoke<AgentItem[]>('agent_list_by_hub', {
          hubId: requestedHubId,
        });
        if (
          !shouldApplyAgentLoadResult({
            requestedHubId,
            activeHubId: useHubStore.getState().currentHubId,
            requestGeneration,
            latestGeneration: agentLoadGenerationRef.current,
          })
        ) {
          logger.trace('[useDataLoader] 忽略过期的 Hub Agent 列表响应', {
            hubId: requestedHubId,
            requestGeneration,
          });
          return;
        }
        setAgents(agents);
        logger.trace('[useDataLoader] 加载 Hub 下的 Agent', {
          hubId: requestedHubId,
          agentCount: agents.length,
        });
      } catch (error) {
        logger.error('[useDataLoader] 加载 Agent 失败:', error);
      }
    }

    void loadAgentsForHub();
  }, [currentHubId, setAgents]);

  // 监听 Agent 切换，加载对应的聊天历史
  useEffect(() => {
    if (!currentAgentId) return;
    // 避免重复加载同一 Agent 的消息
    if (loadedAgentIds.current.has(currentAgentId)) return;

    async function loadMessagesForAgent(): Promise<void> {
      if (!currentAgentId) return;
      try {
        // 初始加载最新 100 条消息，同时查询总数用于判断是否有更早历史
        // 使用 message_get_recent 而非 list_by_agent：后者按 ASC 取最旧的 N 条，
        // 消息超过限额后新消息永远加载不到 UI；get_recent 始终保证最新消息可见。
        // 仅加载 100 条避免 Widget/图表等重渲染组件一次性渲染太多影响性能，
        // 超出部分通过 ChatHistory 顶部的"加载更多"按钮分批拉取。
        const INITIAL_LOAD_COUNT = 100;
        const [messagesFromDb, totalCount] = await Promise.all([
          invoke<PersistedMessageItem[]>('message_get_recent', {
            agentId: currentAgentId,
            count: INITIAL_LOAD_COUNT,
          }),
          invoke<number>('message_count_by_agent', {
            agentId: currentAgentId,
          }),
        ]);

        // 转换为前端 Message 类型
        const messages: Message[] = messagesFromDb.map((m) => {
          // 解析 metadata JSON 字符串
          let parsedMetadata: Message['metadata'] = undefined;
          if (m.metadata) {
            try {
              parsedMetadata = JSON.parse(m.metadata) as unknown as Message['metadata'];
            } catch (e) {
              logger.warn('[useDataLoader] 解析 metadata 失败:', e);
            }
          }

          const parsedMeta = parsedMetadata as Record<string, unknown> | undefined;
          return {
            id: m.id,
            agentId: m.agentId,
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content,
            createdAt: m.createdAt,
            metadata: parsedMetadata,
            // 从 metadata 恢复 quotedFrom，保证重启后引用展示正常
            quotedFrom: parseQuotedFrom(parsedMeta),
          };
        });

        // 过滤掉来自 Hub 的消息（Hub 消息使用 Agent ID 满足外键约束，但不应显示在 Agent 窗口）
        const agentOnlyMessages = messages.filter((m) => {
          // 检查 metadata 中的 sourceType，如果是 'hub' 则排除
          const sourceType = (m.metadata as { sourceType?: string } | undefined)?.sourceType;
          return sourceType !== 'hub';
        });

        // 按 createdAt 排序，确保顺序正确（处理同一秒内多条消息的情况）
        agentOnlyMessages.sort((a, b) => {
          // 首先按 createdAt 排序
          if (a.createdAt !== b.createdAt) {
            return a.createdAt - b.createdAt;
          }
          // 如果 createdAt 相同，按 ID 排序（UUID 按时间生成，保证顺序）
          return a.id.localeCompare(b.id);
        });

        // 从隐藏的 widget 用户消息恢复气泡已提交状态、选择摘要和补充文字。
        // 优先使用新 metadata 中的结构化快照；旧消息则从 content 文本兜底解析。
        const widgetSubmissions = collectWidgetBubbleSubmissions(agentOnlyMessages);
        if (widgetSubmissions.length > 0) {
          const { restoreBubbleSubmittedState } = useWidgetStore.getState();
          for (const submission of widgetSubmissions) {
            restoreBubbleSubmittedState(
              submission.bubbleId,
              submission.selections,
              submission.extraText
            );
          }
          logger.trace('[useDataLoader] 恢复 Widget 气泡提交状态:', widgetSubmissions.length, '个');
        }

        // 设置到 chatStore
        setMessages(currentAgentId, agentOnlyMessages);
        loadedAgentIds.current.add(currentAgentId);

        // 判断是否还有更早的历史消息可加载
        // 注意：totalCount 是 DB 中未删除消息总数（含 hub 消息），
        // agentOnlyMessages 是过滤掉 hub 消息后的数量，
        // 所以用 messagesFromDb.length（过滤前） < totalCount 更准确
        const hasMore = messagesFromDb.length < totalCount;
        useChatStore.getState().setHasMore(currentAgentId, hasMore);

        logger.trace('[useDataLoader] 加载 Agent 聊天历史', {
          agentId: currentAgentId,
          messageCount: agentOnlyMessages.length,
          totalInDb: totalCount,
          hasMore,
          filteredHubMessages: messages.length - agentOnlyMessages.length,
        });
      } catch (error) {
        logger.error('[useDataLoader] 加载聊天历史失败:', error);
      }
    }

    void loadMessagesForAgent();
  }, [currentAgentId, setMessages]);

  // 监听 Hub 切换，从 SQLite 加载 Hub 消息历史
  useEffect(() => {
    if (!currentHubId) return;
    // 避免重复加载同一 Hub 的消息
    if (loadedHubIds.current.has(currentHubId)) return;

    async function loadMessagesForHub(): Promise<void> {
      if (!currentHubId) return;
      try {
        // 初始加载最新 100 条 Hub 消息，同时查总数判断是否有更早历史
        // 使用 message_get_recent_hub 替代 message_list_by_hub(limit=200)，
        // 后者按 ASC 取最旧的 200 条，消息超限后新消息加载不到 UI
        const HUB_INITIAL_LOAD_COUNT = 100;
        const [messagesFromDb, totalCount] = await Promise.all([
          invoke<PersistedMessageItem[]>('message_get_recent_hub', {
            hubId: currentHubId,
            count: HUB_INITIAL_LOAD_COUNT,
          }),
          invoke<number>('message_count_by_hub', {
            hubId: currentHubId,
          }),
        ]);

        // 转换为前端 Message 类型
        const messages: Message[] = messagesFromDb.map((m) => {
          let parsedMetadata: Message['metadata'] = undefined;
          if (m.metadata) {
            try {
              parsedMetadata = JSON.parse(m.metadata) as unknown as Message['metadata'];
            } catch (e) {
              logger.warn('[useDataLoader] 解析 Hub 消息 metadata 失败:', e);
            }
          }
          const parsedMeta = parsedMetadata as Record<string, unknown> | undefined;
          return {
            id: m.id,
            agentId: m.agentId,
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content,
            createdAt: m.createdAt,
            metadata: parsedMetadata,
            // 从 metadata 恢复 quotedFrom，保证重启后引用展示正常
            quotedFrom: parseQuotedFrom(parsedMeta),
          };
        });

        // 按创建时间升序排列
        messages.sort((a, b) => {
          if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
          return a.id.localeCompare(b.id);
        });

        // 从隐藏的 widget 用户消息恢复气泡已提交状态、选择摘要和补充文字。
        const hubWidgetSubmissions = collectWidgetBubbleSubmissions(messages);
        if (hubWidgetSubmissions.length > 0) {
          const { restoreBubbleSubmittedState } = useWidgetStore.getState();
          for (const submission of hubWidgetSubmissions) {
            restoreBubbleSubmittedState(
              submission.bubbleId,
              submission.selections,
              submission.extraText
            );
          }
          logger.trace(
            '[useDataLoader] Hub 恢复 Widget 气泡提交状态:',
            hubWidgetSubmissions.length,
            '个'
          );
        }

        // 写入 chatStore
        const { setHubMessages, setHubHasMore } = useChatStore.getState();
        setHubMessages(currentHubId, messages);
        loadedHubIds.current.add(currentHubId);

        // 判断是否还有更早历史
        const hubHasMore = messagesFromDb.length < totalCount;
        setHubHasMore(currentHubId, hubHasMore);

        logger.trace('[useDataLoader] 加载 Hub 聊天历史', {
          hubId: currentHubId,
          messageCount: messages.length,
          totalInDb: totalCount,
          hasMore: hubHasMore,
        });
      } catch (error) {
        logger.error('[useDataLoader] 加载 Hub 聊天历史失败:', error);
      }
    }

    void loadMessagesForHub();
  }, [currentHubId]);
}
