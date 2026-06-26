/**
 * SkillLoader 外部 Script Skill 注册测试
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { skillLoader } from '../SkillLoader';
import type { ExecutionContract } from '../external/types';

const BROKER_CONTRACT: ExecutionContract = {
    runtime: 'python',
    entry: 'scripts/broker_e2e.py',
    timeout: 45,
    maxOutput: 65536,
    argsSchema: [
        {
            name: 'url',
            type: 'string',
            required: true,
            description: 'Public URL to fetch',
        },
    ],
    permissions: { networkMode: 'brokerOnly' },
};

describe('SkillLoader external Script Skill registration', () => {
    beforeEach(() => {
        skillLoader.clearExternalSkills();
    });

    afterEach(() => {
        skillLoader.clearExternalSkills();
    });

    it('registerExternal 应保留 contract、dependencies 与 packagePath，并能从 Script catalog 查到', () => {
        skillLoader.registerExternal({
            name: 'broker-e2e',
            description: 'Broker E2E',
            fullContent: '# Broker E2E',
            source: 'external',
            mode: 'script',
            category: 'external',
            complexity: 1,
            requiresAuth: false,
            packagePath: 'C:/skills/external/packages/broker-e2e',
            contract: BROKER_CONTRACT,
            dependencies: {
                python: '>=3.11',
                packages: ['requests>=2.32'],
            },
            agentvisNetworkEntrypoints: {
                'scripts/broker_e2e.py': 'brokerProxyPreferred',
            },
        });

        const scripts = skillLoader.getExternalScriptSkills();
        expect(scripts.map(skill => skill.name)).toEqual(['broker-e2e']);

        const brokerSkill = skillLoader.getExternalScriptSkill('broker-e2e');
        expect(brokerSkill).toMatchObject({
            name: 'broker-e2e',
            mode: 'script',
            packagePath: 'C:/skills/external/packages/broker-e2e',
            contract: BROKER_CONTRACT,
            dependencies: {
                python: '>=3.11',
                packages: ['requests>=2.32'],
            },
            agentvisNetworkEntrypoints: {
                'scripts/broker_e2e.py': 'brokerProxyPreferred',
            },
        });
    });

    it('Guide 模式 external skill 不应进入 Script catalog', () => {
        skillLoader.registerExternal({
            name: 'guide-only',
            description: 'Guide only',
            fullContent: '# Guide',
            source: 'external',
            mode: 'guide',
            category: 'external',
            complexity: 1,
            requiresAuth: false,
            packagePath: 'C:/skills/external/packages/guide-only',
            agentvisNetworkEntrypoints: {
                'scripts/probe.py': 'legacyNonHttp',
            },
        });

        expect(skillLoader.getExternalScriptSkills()).toEqual([]);
        expect(skillLoader.getExternalScriptSkill('guide-only')).toBeUndefined();
        expect(skillLoader.getAllSync().find(skill => skill.name === 'guide-only'))
            .toMatchObject({
                agentvisNetworkEntrypoints: {
                    'scripts/probe.py': 'legacyNonHttp',
                },
            });
    });
});
