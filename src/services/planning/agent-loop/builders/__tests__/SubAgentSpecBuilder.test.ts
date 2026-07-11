/**
 * SubAgentSpecBuilder Script Skill 工具注入测试
 */

import { describe, expect, it } from 'vitest';
import { SubAgentSpecBuilder } from '../SubAgentSpecBuilder';
import type { ExternalScriptSkillInfo, MasterBrainDecision } from '../../../brain/types';
import { resolveOutputLanguage } from '@services/language/OutputLanguagePolicy';

const BROKER_SCRIPT_SKILL: ExternalScriptSkillInfo = {
  name: 'broker-e2e',
  description: 'Broker E2E',
  packagePath: 'C:/skills/external/packages/broker-e2e',
  contract: {
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
  },
};

function createSpawnDecision(): MasterBrainDecision {
  return {
    decision: 'SPAWN_SUB_AGENT',
    rationale: '需要运行 broker-e2e 验证受控联网 broker',
    riskAssessment: {
      level: 'medium',
      notes: '使用受控联网 broker',
    },
    nextStep: {
      task: '使用 broker-e2e 验证 https://example.com',
      tools: ['read'],
    },
  } as MasterBrainDecision;
}

describe('SubAgentSpecBuilder', () => {
  it('命中 Script Skill 时应自动授权 external_skill_execute 并使用 careful 行为', () => {
    const builder = new SubAgentSpecBuilder();

    const spec = builder.buildFromNextStep(createSpawnDecision(), undefined, [BROKER_SCRIPT_SKILL]);

    expect(spec).not.toBeNull();
    expect(spec?.allowedTools).toContain('external_skill_execute');
    expect(spec?.behaviorHint).toBe('careful');
  });

  it('应将原始用户请求的结构化语言提示传入 SubAgentSpec', () => {
    const builder = new SubAgentSpecBuilder();
    const outputLanguageHint = resolveOutputLanguage('Please provide the result in French.', {
      useRuntimePreference: false,
    });

    const spec = builder.buildFromNextStep(
      createSpawnDecision(),
      undefined,
      undefined,
      outputLanguageHint
    );

    expect(spec?.outputLanguageHint).toEqual(outputLanguageHint);
  });
});
