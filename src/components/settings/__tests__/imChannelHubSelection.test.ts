import { describe, expect, it } from 'vitest';
import {
    getMissingAgentReloadKey,
    resolveImBotHubId,
    resolveMissingAgentAction,
    shouldClearAgentAfterHubResolve,
} from '../imChannelHubSelection';

const hub = (id: string) => ({ id });
const agent = (id: string) => ({ id });

describe('imChannelHubSelection', () => {
    it('auto-selects the only Hub when a bot has no configured Hub', () => {
        expect(resolveImBotHubId(null, [hub('hub-1')])).toBe('hub-1');
    });

    it('keeps an existing configured Hub when it is still available', () => {
        expect(resolveImBotHubId('hub-2', [hub('hub-1'), hub('hub-2')])).toBe('hub-2');
    });

    it('does not guess a Hub when multiple Hubs are available and the config is empty', () => {
        expect(resolveImBotHubId(null, [hub('hub-1'), hub('hub-2')])).toBeNull();
    });

    it('clears stale Hub bindings in multi-Hub mode so users must choose explicitly', () => {
        expect(resolveImBotHubId('deleted-hub', [hub('hub-1'), hub('hub-2')])).toBeNull();
        expect(shouldClearAgentAfterHubResolve('deleted-hub', null)).toBe(true);
    });

    it('preserves migrated agentId when filling a missing Hub from the only Hub', () => {
        expect(shouldClearAgentAfterHubResolve(null, 'hub-1')).toBe(false);
    });

    it('does not handle missing agents before the current Hub agent list is loaded', () => {
        expect(resolveMissingAgentAction({
            agentId: 'agent-1',
            currentHubId: 'hub-1',
            lastLoadedHubId: null,
            agents: [],
            lastMissingAgentReloadKey: null,
        })).toBe('none');
    });

    it('keeps a selected agent when it exists in the loaded Hub agent list', () => {
        expect(resolveMissingAgentAction({
            agentId: 'agent-1',
            currentHubId: 'hub-1',
            lastLoadedHubId: 'hub-1',
            agents: [agent('agent-1')],
            lastMissingAgentReloadKey: null,
        })).toBe('none');
    });

    it('reloads once when the selected agent is missing from the loaded list', () => {
        expect(resolveMissingAgentAction({
            agentId: 'agent-1',
            currentHubId: 'hub-1',
            lastLoadedHubId: 'hub-1',
            agents: [agent('agent-2')],
            lastMissingAgentReloadKey: null,
        })).toBe('reload');
    });

    it('clears a selected agent that is still missing after one reload', () => {
        expect(resolveMissingAgentAction({
            agentId: 'agent-1',
            currentHubId: 'hub-1',
            lastLoadedHubId: 'hub-1',
            agents: [agent('agent-2')],
            lastMissingAgentReloadKey: getMissingAgentReloadKey('hub-1', 'agent-1'),
        })).toBe('clear');
    });
});
