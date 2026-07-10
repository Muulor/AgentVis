/**
 * VisualEnhancementJobManager 单元测试
 */

import { describe, expect, it, vi } from 'vitest';
import {
    VisualEnhancementJobManager,
    type VisualEnhancementJobState,
} from '../VisualEnhancementJobManager';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => {};
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('VisualEnhancementJobManager', () => {
    it('serializes enhancement jobs within the same context', async () => {
        const states = new Map<string, VisualEnhancementJobState>();
        const first = deferred();
        const second = deferred();
        const executionOrder: string[] = [];
        const manager = new VisualEnhancementJobManager((messageId, state) => {
            if (state) states.set(messageId, state);
            else states.delete(messageId);
        });

        manager.enqueue({
            messageId: 'message-1',
            contextId: 'agent-1',
            execute: async () => {
                executionOrder.push('message-1');
                await first.promise;
            },
        });
        manager.enqueue({
            messageId: 'message-2',
            contextId: 'agent-1',
            execute: async () => {
                executionOrder.push('message-2');
                await second.promise;
            },
        });

        expect(executionOrder).toEqual(['message-1']);
        expect(states.get('message-1')?.status).toBe('running');
        expect(states.get('message-2')?.status).toBe('queued');

        first.resolve();
        await flushPromises();

        expect(executionOrder).toEqual(['message-1', 'message-2']);
        expect(states.has('message-1')).toBe(false);
        expect(states.get('message-2')?.status).toBe('running');

        second.resolve();
        await flushPromises();
        expect(states.size).toBe(0);
    });

    it('cancels a running enhancement without affecting later jobs', async () => {
        const states = new Map<string, VisualEnhancementJobState>();
        const onAbort = vi.fn();
        const nextJob = deferred();
        const manager = new VisualEnhancementJobManager((messageId, state) => {
            if (state) states.set(messageId, state);
            else states.delete(messageId);
        });

        manager.enqueue({
            messageId: 'message-1',
            contextId: 'agent-1',
            execute: signal => new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => {
                    onAbort();
                    resolve();
                }, { once: true });
            }),
        });
        manager.enqueue({
            messageId: 'message-2',
            contextId: 'agent-1',
            execute: () => nextJob.promise,
        });

        expect(manager.cancel('message-1')).toBe(true);
        await flushPromises();

        expect(onAbort).toHaveBeenCalledOnce();
        expect(states.get('message-2')?.status).toBe('running');

        nextJob.resolve();
        await flushPromises();
        expect(states.size).toBe(0);
    });

    it('removes a queued enhancement before it starts', async () => {
        const activeJob = deferred();
        const queuedExecute = vi.fn(async () => undefined);
        const manager = new VisualEnhancementJobManager(() => undefined);

        manager.enqueue({
            messageId: 'message-1',
            contextId: 'agent-1',
            execute: () => activeJob.promise,
        });
        manager.enqueue({
            messageId: 'message-2',
            contextId: 'agent-1',
            execute: queuedExecute,
        });

        expect(manager.cancel('message-2')).toBe(true);
        activeJob.resolve();
        await flushPromises();

        expect(queuedExecute).not.toHaveBeenCalled();
    });
});
