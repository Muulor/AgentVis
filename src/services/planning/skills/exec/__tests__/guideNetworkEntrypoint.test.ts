import { describe, expect, it } from 'vitest';
import {
    buildGenericNetworkTargetsCommand,
    resolveExternalSkillCommandReference,
    resolveGuideSkillEntrypointNetworkDeclaration,
} from '../tool';
import type { SkillDefinition } from '../../types';

const GUIDE_SKILL: SkillDefinition = {
    name: 'custom-db-guide',
    description: 'Custom DB guide',
    category: 'external',
    complexity: 1,
    requiresAuth: false,
    fullContent: '# Custom DB Guide',
    source: 'external',
    mode: 'guide',
    packagePath: 'C:/Users/Muulo/AppData/Roaming/com.agentvis.app/skills/external/packages/custom-db-guide',
    scriptFiles: ['scripts/probe.py'],
    agentvisNetworkEntrypoints: {
        'scripts/probe.py': 'legacyNonHttp',
    },
};

describe('Guide Skill network entrypoints for exec', () => {
    it('应从 exec 命令中的绝对脚本路径匹配 Guide frontmatter 入口声明', () => {
        const command = [
            'python',
            '"C:/Users/Muulo/AppData/Roaming/com.agentvis.app/skills/external/packages/custom-db-guide/scripts/probe.py"',
            '--action probe --profile redis',
        ].join(' ');

        expect(resolveGuideSkillEntrypointNetworkDeclaration(command, undefined, [GUIDE_SKILL]))
            .toEqual({
                skillName: 'custom-db-guide',
                packagePath: GUIDE_SKILL.packagePath,
                entry: 'scripts/probe.py',
                mode: 'legacyNonHttp',
            });
    });

    it('应为通用 legacyNonHttp 脚本构造 network_targets preflight 并保留目标参数', () => {
        const command = [
            'python',
            '"C:/skills/external/packages/custom-db-guide/scripts/probe.py"',
            '--action probe',
            '--profile redis',
            '--host cache.example.com',
            '--port 6380',
        ].join(' ');

        expect(buildGenericNetworkTargetsCommand(command)).toBe(
            'python C:/skills/external/packages/custom-db-guide/scripts/probe.py --action network_targets --profile redis --host cache.example.com --port 6380'
        );
    });

    it('should identify installed external skill commands even without network entrypoint metadata', () => {
        const command = [
            'python',
            '"C:/Users/Muulo/AppData/Roaming/com.agentvis.app/skills/external/packages/custom-db-guide/scripts/probe.py"',
            '--action probe',
        ].join(' ');
        const skillWithoutNetworkMetadata: SkillDefinition = {
            ...GUIDE_SKILL,
            agentvisNetworkEntrypoints: undefined,
        };

        expect(resolveExternalSkillCommandReference(command, undefined, [skillWithoutNetworkMetadata]))
            .toEqual({
                skillName: 'custom-db-guide',
                packagePath: GUIDE_SKILL.packagePath,
                mode: 'guide',
            });
    });
});
