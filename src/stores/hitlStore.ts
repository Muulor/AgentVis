/**
 * hitlStore - Human-in-the-Loop 暂停机制状态管理
 *
 * 实现用户主动暂停 SA 执行并介入的通信通道：
 * - 服务层（SubAgentRunner）调用 waitForResume() 阻塞等待用户决策
 * - UI 层（HitlInterventionBar）调用 pause() / resume() 控制暂停状态
 *
 * 设计：以 contextId（agentId）为 key 隔离，支持多 Agent 并发场景。
 * Promise resolver 通过 resolversMap 存储，对外不暴露。
 *
 * 边界情况处理：
 * 1. resume() 先于 waitForResume() 调用（用户手速过快）：
 *    通过 preResolvedMap + preResolvedContexts 双轨暂存，
 *    preResolvedContexts 纳入 Zustand state 确保 React 能订阅感知变化。
 * 2. AbortSignal 已触发时 waitForResume() 立即 reject，同步清除 pausedContexts。
 * 3. waitForResume() 内部一次性包装 resolver（避免二次 set 导致的 abort 监听泄漏）。
 */

import { create } from 'zustand';
import { getLogger } from '@services/logger';

const logger = getLogger('hitlStore');

// ============================================================================
// 类型定义
// ============================================================================

interface HitlState {
    /** 当前处于暂停等待状态的 contextId 集合 */
    pausedContexts: Set<string>;
    /**
     * 已预解决（resume 早于 waitForResume）的 contextId 集合
     *
     * 与 preResolvedMap 同步更新，使 React 组件能通过 Zustand 订阅感知
     * "预解决" 状态，避免 UI 显示"已恢复"但 SA 仍处于隐形阻塞的情况。
     * （preResolvedMap 是纯内存 Map，不触发 React 重渲染）
     */
    preResolvedContexts: Set<string>;
}

interface HitlActions {
    /** UI 层：请求暂停指定 context 的 SA 执行 */
    pause: (contextId: string) => void;
    /** UI 层：携带可选介入消息恢复 SA 执行 */
    resume: (contextId: string, message?: string) => void;
    /**
     * 查询指定 context 是否当前处于暂停状态
     *
     * 同时检测正常暂停（pausedContexts）和预解决暂停（preResolvedContexts），
     * 确保 SA 在任意路径下的挂起状态都能被 UI 感知。
     */
    isPaused: (contextId: string) => boolean;
    /**
     * 服务层：创建 Promise 阻塞直到用户做出决策
     *
     * - 返回 undefined：用户直接点继续，无介入消息
     * - 返回 string：用户输入了介入指令
     * - 抛出错误（AbortError）：AbortSignal 触发，SA 应退出循环
     */
    waitForResume: (contextId: string, signal: AbortSignal) => Promise<string | undefined>;
    /** SA 执行结束时清理残留状态（防止下次任务误触发） */
    cleanup: (contextId: string) => void;
}

// ── 模块级内部状态（不放入 Zustand state，避免函数序列化问题）──

/** 等待用户决策的 Promise resolve 函数（resume() 调用时唤醒） */
const resolversMap = new Map<string, (message?: string) => void>();

/**
 * 预解决值缓存 —— 处理 resume() 先于 waitForResume() 调用的竞争条件
 *
 * 当 resume() 在 SA 调用 waitForResume() 之前触发时，resolve 函数
 * 尚不存在，此时将消息暂存于此。waitForResume() 启动时立即消费，不挂起。
 *
 * 重要：该 Map 的增删操作必须同步更新 Zustand state 中的 preResolvedContexts，
 * 以确保 React 订阅能感知变化（Map 本身不触发重渲染）。
 */
const preResolvedMap = new Map<string, string | undefined>();

// ============================================================================
// Store 实现
// ============================================================================

export const useHitlStore = create<HitlState & HitlActions>()((set, get) => ({
    pausedContexts: new Set<string>(),
    preResolvedContexts: new Set<string>(),

    pause: (contextId: string) => {
        set((state) => {
            const next = new Set(state.pausedContexts);
            next.add(contextId);
            return { pausedContexts: next };
        });
        logger.debug(`[hitlStore] ⏸ 暂停请求: ${contextId}`);
    },

    resume: (contextId: string, message?: string) => {
        // 清除正常暂停标记
        set((state) => {
            const next = new Set(state.pausedContexts);
            next.delete(contextId);
            return { pausedContexts: next };
        });

        // 唤醒等待中的 Promise（正常路径：waitForResume 已在阻塞中）
        const resolver = resolversMap.get(contextId);
        if (resolver) {
            resolversMap.delete(contextId);
            resolver(message);
            logger.debug(`[hitlStore] ▶ 恢复执行: ${contextId}${message ? ` (含介入消息: ${message.slice(0, 50)}...)` : ' (无消息)'}`);
        } else {
            // waitForResume 尚未被调用（SA 正阻塞在工具 HTTP 调用中，
            // 尚未到达 while 循环顶部的 HITL 检查点）。
            // 将消息暂存为预解决值，waitForResume() 启动时立即消费，不会永久挂起。
            //
            // 防覆盖保护：若 preResolvedMap 中已存在有意义的介入指令（非 undefined），
            // 而本次调用传入的是空内容（undefined），则静默忽略，保留原有指令。
            // 场景：用户发送了指令后因 UI 无视觉反馈而误以为未生效，
            // 反复点击「继续」（空内容），若不保护则会覆盖掉有价值的指令。
            const existingMessage = preResolvedMap.get(contextId);
            const shouldUpdate = !preResolvedMap.has(contextId)  // 尚无预解决值
                || message !== undefined                           // 本次有实际内容，覆盖旧值
                || existingMessage === undefined;                  // 旧值也是空，允许覆盖

            if (shouldUpdate) {
                preResolvedMap.set(contextId, message);
                logger.debug(`[hitlStore] ▶ 恢复（预解决）: ${contextId}，消息已暂存等待 waitForResume 消费`);
            } else {
                // 旧指令存在，本次空内容静默忽略，保护用户已发送的指令
                logger.debug(`[hitlStore] ▶ 恢复（预解决）忽略空内容: ${contextId}，保留已暂存指令 "${existingMessage.slice(0, 30)}..."`);
            }

            // 无论是否更新消息内容，都确保 preResolvedContexts 标记存在
            // （使 React 能订阅感知"预解决等待中"状态）
            set((state) => {
                const next = new Set(state.preResolvedContexts);
                next.add(contextId);
                return { preResolvedContexts: next };
            });
        }
    },

    isPaused: (contextId: string) => {
        // 同时检测两种暂停路径：
        // 1. pausedContexts：用户已点击暂停，waitForResume 正在阻塞中
        // 2. preResolvedContexts：resume() 已调用但 waitForResume 尚未注册
        //    （两者都纳入 Zustand state，确保 React 订阅时能触发重渲染）
        const state = get();
        return state.pausedContexts.has(contextId) || state.preResolvedContexts.has(contextId);
    },

    waitForResume: (contextId: string, signal: AbortSignal): Promise<string | undefined> => {
        // AbortSignal 已触发时，同步清除 pausedContexts 后再立即 reject，
        // 避免 UI 因状态残留而持续显示「SA 已暂停」界面。
        if (signal.aborted) {
            set((state) => {
                const nextPaused = new Set(state.pausedContexts);
                nextPaused.delete(contextId);
                return { pausedContexts: nextPaused };
            });
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }

        // 检测预解决值：resume() 在此调用前已被触发（竞争条件兜底）
        // 直接返回已解决的 Promise，同步清除 preResolvedContexts。
        if (preResolvedMap.has(contextId)) {
            const preResolved = preResolvedMap.get(contextId);
            preResolvedMap.delete(contextId);
            set((state) => {
                const next = new Set(state.preResolvedContexts);
                next.delete(contextId);
                return { preResolvedContexts: next };
            });
            logger.debug(`[hitlStore] ⚡ waitForResume 消费预解决值: ${contextId}${preResolved ? ` (${preResolved.slice(0, 50)}...)` : ' (无消息)'}`);
            return Promise.resolve(preResolved);
        }

        return new Promise<string | undefined>((resolve, reject) => {
            // 一次性完成包装，直接将「移除 abort 监听器」的逻辑内聚在 wrappedResolver中，避免原实现两次 resolversMap.set() 导致的竞态隐患：
            // 第一次 set 写入原始 resolve，第二次才写包装版，
            // 若 resume() 恰好在两次 set 之间执行，将取到未包装的 resolve，
            // 导致 abort 事件监听器永久泄漏。
            const onAbort = () => {
                resolversMap.delete(contextId);
                // 同步清除所有暂停标记，避免 UI 状态残留
                useHitlStore.getState().cleanup(contextId);
                reject(new DOMException('Aborted', 'AbortError'));
                logger.debug(`[hitlStore] ⛔ 中止信号触发，结束暂停等待: ${contextId}`);
            };

            // 直接注册包含清理逻辑的最终版 resolver，全程只 set 一次
            const wrappedResolver = (message?: string) => {
                signal.removeEventListener('abort', onAbort);
                resolve(message);
            };
            resolversMap.set(contextId, wrappedResolver);

            signal.addEventListener('abort', onAbort, { once: true });
        });
    },

    cleanup: (contextId: string) => {
        // 移除所有暂停标记和残留的内部状态，防止下次任务误触发
        set((state) => {
            const nextPaused = new Set(state.pausedContexts);
            nextPaused.delete(contextId);
            const nextPreResolved = new Set(state.preResolvedContexts);
            nextPreResolved.delete(contextId);
            return { pausedContexts: nextPaused, preResolvedContexts: nextPreResolved };
        });

        if (resolversMap.has(contextId)) {
            resolversMap.delete(contextId);
            logger.debug(`[hitlStore] 🧹 清理残留 resolver: ${contextId}`);
        }
        if (preResolvedMap.has(contextId)) {
            preResolvedMap.delete(contextId);
            logger.debug(`[hitlStore] 🧹 清理残留预解决值: ${contextId}`);
        }
    },
}));
