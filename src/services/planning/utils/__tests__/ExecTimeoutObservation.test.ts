import { describe, expect, it } from 'vitest';
import {
    getElapsedExecTimeoutSeconds,
    getExplicitExecTimeoutSeconds,
    getPendingExecTimeoutSeconds,
    getPendingExecTimeoutStatus,
} from '../ExecTimeoutObservation';
import type { SubAgentObservationEvent } from '../../agent-loop/types';

describe('ExecTimeoutObservation', () => {
    it('only exposes numeric explicit exec timeouts', () => {
        expect(getExplicitExecTimeoutSeconds('exec', { timeout: 1800 })).toBe(1800);
        expect(getExplicitExecTimeoutSeconds('exec', { timeout: 1200.8 })).toBe(1200);
        expect(getExplicitExecTimeoutSeconds('exec', {})).toBeUndefined();
        expect(getExplicitExecTimeoutSeconds('exec', { timeout: '1800' })).toBeUndefined();
        expect(getExplicitExecTimeoutSeconds('read', { timeout: 1800 })).toBeUndefined();
    });

    it('returns only the latest pending exec timeout from observations', () => {
        const observations: SubAgentObservationEvent[] = [
            {
                thinking: '',
                toolAction: {
                    tool: 'exec',
                    target: 'npm install',
                    timeoutSeconds: 900,
                    success: true,
                },
                timestamp: 1,
            },
            {
                thinking: '',
                toolAction: {
                    tool: 'read',
                    target: 'package.json',
                },
                timestamp: 2,
            },
            {
                thinking: '',
                toolAction: {
                    tool: 'exec',
                    target: 'download model',
                    timeoutSeconds: 1800,
                },
                timestamp: 3,
            },
        ];

        expect(getPendingExecTimeoutSeconds(observations)).toBe(1800);
        expect(getPendingExecTimeoutStatus(observations)).toEqual({
            timeoutSeconds: 1800,
            startedAtMs: 3,
        });
    });

    it('does not return a timeout after the exec action is completed', () => {
        const observations: SubAgentObservationEvent[] = [
            {
                thinking: '',
                toolAction: {
                    tool: 'exec',
                    target: 'download model',
                    timeoutSeconds: 1800,
                    success: false,
                },
                timestamp: 1,
            },
        ];

        expect(getPendingExecTimeoutSeconds(observations)).toBeUndefined();
        expect(getPendingExecTimeoutStatus(observations)).toBeUndefined();
    });

    it('calculates elapsed seconds from the pending exec start time and clamps to timeout', () => {
        expect(getElapsedExecTimeoutSeconds(1_000, 1_999, 1800)).toBe(0);
        expect(getElapsedExecTimeoutSeconds(1_000, 2_000, 1800)).toBe(1);
        expect(getElapsedExecTimeoutSeconds(1_000, 1_805_000, 1800)).toBe(1800);
        expect(getElapsedExecTimeoutSeconds(2_000, 1_000, 1800)).toBe(0);
    });
});
