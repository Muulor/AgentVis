/**
 * MasterBrain 单元测试
 *
 * 测试主脑决策流程
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MasterBrain } from '../MasterBrain';
import { MasterBrainPrompt } from '../MasterBrainPrompt';
import { DecisionParser } from '../DecisionParser';
import type { MasterBrainInput } from '../types';
import { createEmptyMemorySnapshot } from '../types';
import { PLANNING_CONSTANTS } from '../../PlanningConstants';

// ═══════════════════════════════════════════════════════════════
// Mock LLM Service
// ═══════════════════════════════════════════════════════════════

const createMockLLMService = (response: string) => ({
  generate: vi.fn().mockResolvedValue(response),
});

const createValidLLMResponse = (decision: string, extras: Record<string, unknown> = {}) => `
\`\`\`json
{
  "decision": "${decision}",
  "rationale": "Test rationale",
  "riskAssessment": { "level": "low", "notes": "" }${Object.keys(extras).length > 0 ? ',' : ''}
  ${Object.entries(extras)
    .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`)
    .join(',\n  ')}
}
\`\`\`
`;

// ═══════════════════════════════════════════════════════════════
// 测试辅助
// ═══════════════════════════════════════════════════════════════

const createTestInput = (): MasterBrainInput => ({
  userIntent: { explicit: 'Test intent' },
  memory: createEmptyMemorySnapshot(),
  ragEvidence: [],
  toolCatalog: [],
});

// ═══════════════════════════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════════════════════════

describe('MasterBrain', () => {
  let promptBuilder: MasterBrainPrompt;
  let decisionParser: DecisionParser;

  beforeEach(() => {
    promptBuilder = new MasterBrainPrompt();
    decisionParser = new DecisionParser();
  });

  describe('decide 方法', () => {
    it('应该调用 LLM 并返回解析后的决策', async () => {
      const mockResponse = createValidLLMResponse('RESPOND_TO_USER', {
        nextStep: { response: 'Task completed' },
      });
      const mockLLM = createMockLLMService(mockResponse);

      const brain = new MasterBrain(promptBuilder, decisionParser, mockLLM);

      const input = createTestInput();
      const decision = await brain.decide(input);

      expect(mockLLM.generate).toHaveBeenCalled();
      expect(mockLLM.generate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          maxTokens: PLANNING_CONSTANTS.MASTER_BRAIN_MAX_OUTPUT_TOKENS,
        })
      );
      expect(decision.decision).toBe('RESPOND_TO_USER');
    });

    it('应该将构建的 Prompt 传递给 LLM', async () => {
      const mockResponse = createValidLLMResponse('RESPOND_TO_USER', {
        nextStep: { response: 'Done' },
      });
      const mockLLM = createMockLLMService(mockResponse);

      const brain = new MasterBrain(promptBuilder, decisionParser, mockLLM);

      const input = createTestInput();
      await brain.decide(input);

      // 验证 LLM 被调用且参数包含 Prime Directive
      const calledPrompt = mockLLM.generate.mock.calls[0]![0];
      expect(calledPrompt).toContain('Prime Directive');
      expect(calledPrompt).toContain('Master Brain');
    });

    it('LLM 返回无效响应时应降级为 RESPOND_TO_USER 兜底决策', async () => {
      // DecisionParser 的容错设计：无法解析的响应自动降级为 RESPOND_TO_USER
      const invalidText = 'Invalid response without JSON';
      const mockLLM = createMockLLMService(invalidText);

      const brain = new MasterBrain(promptBuilder, decisionParser, mockLLM);

      const input = createTestInput();
      const decision = await brain.decide(input);

      expect(decision.decision).toBe('RESPOND_TO_USER');
      expect(decision.rationale).toContain('downgraded to a user reply');
      expect(mockLLM.generate).toHaveBeenCalledTimes(2);
      expect(mockLLM.generate.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          mbDecisionCorrection: expect.objectContaining({
            reason: 'plain_text',
          }),
        })
      );
    });

    it('MB 输出伪工具调用协议时应定向纠错并重试一次', async () => {
      const mockLLM = {
        generate: vi
          .fn()
          .mockResolvedValueOnce(
            '<function=web_search><parameter=query>strands-agents</parameter></function>'
          )
          .mockResolvedValueOnce(
            createValidLLMResponse('SPAWN_SUB_AGENT', {
              nextStep: {
                task: 'Research strands-agents through a Sub-Agent',
              },
            })
          ),
      };
      const brain = new MasterBrain(promptBuilder, decisionParser, mockLLM);

      const decision = await brain.decide(createTestInput());

      expect(decision.decision).toBe('SPAWN_SUB_AGENT');
      expect(mockLLM.generate).toHaveBeenCalledTimes(2);
      expect(mockLLM.generate.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          mbDecisionCorrection: expect.objectContaining({
            reason: 'tool_call_envelope',
          }),
        })
      );
    });

    it('嵌套决策依赖截断修复时应消费共享语义额度重试', async () => {
      const nestedDecision = JSON.stringify({
        decision: 'RESPOND_TO_USER',
        rationale: 'Recovered but truncated.',
        riskAssessment: { level: 'low', notes: 'No risk' },
        nextStep: { response: 'Recovered response' },
      }).slice(0, -1);
      const malformedWrapper = `\`\`\`json
{
  "decision": "RESPOND_TO_USER": ${JSON.stringify(nestedDecision)}
}
\`\`\``;
      const mockLLM = {
        generate: vi
          .fn()
          .mockResolvedValueOnce(malformedWrapper)
          .mockResolvedValueOnce(
            createValidLLMResponse('RESPOND_TO_USER', {
              nextStep: { response: 'Safe retry response' },
            })
          ),
      };
      const brain = new MasterBrain(promptBuilder, decisionParser, mockLLM);

      const decision = await brain.decide(createTestInput());

      expect(decision.decision).toBe('RESPOND_TO_USER');
      if (decision.decision === 'RESPOND_TO_USER') {
        expect(decision.response).toBe('Safe retry response');
      }
      expect(mockLLM.generate).toHaveBeenCalledTimes(2);
      expect(mockLLM.generate.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          mbDecisionCorrection: expect.objectContaining({
            reason: 'truncated_output',
          }),
        })
      );
    });

    it('新旧 response 内容冲突时应使用 schema_invalid 共享额度纠错一次', async () => {
      const mockLLM = {
        generate: vi
          .fn()
          .mockResolvedValueOnce(
            createValidLLMResponse('RESPOND_TO_USER', {
              nextStep: { response: 'Canonical response' },
              response: 'Conflicting legacy response',
            })
          )
          .mockResolvedValueOnce(
            createValidLLMResponse('RESPOND_TO_USER', {
              nextStep: { response: 'Corrected response' },
            })
          ),
      };
      const brain = new MasterBrain(promptBuilder, decisionParser, mockLLM);

      const decision = await brain.decide(createTestInput());

      expect(decision.decision).toBe('RESPOND_TO_USER');
      if (decision.decision === 'RESPOND_TO_USER') {
        expect(decision.response).toBe('Corrected response');
      }
      expect(mockLLM.generate).toHaveBeenCalledTimes(2);
      expect(mockLLM.generate.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          mbDecisionCorrection: expect.objectContaining({
            reason: 'schema_invalid',
            detail: expect.stringContaining('conflicting nextStep.response'),
          }),
        })
      );
    });

    it('流式层已消费语义重试额度时，解析失败不得再叠加重试', async () => {
      const mockLLM = {
        generate: vi
          .fn()
          .mockImplementation(
            (
              _prompt: string,
              options?: { mbDecisionRetryState?: { attemptsUsed: number; lastReason?: string } }
            ) => {
              if (options?.mbDecisionRetryState) {
                options.mbDecisionRetryState.attemptsUsed = 1;
                options.mbDecisionRetryState.lastReason = 'anomalous_content';
              }
              return Promise.resolve('{"decision":"RESPOND_TO_USER"');
            }
          ),
      };
      const brain = new MasterBrain(promptBuilder, decisionParser, mockLLM);

      const decision = await brain.decide(createTestInput());

      expect(decision.decision).toBe('RESPOND_TO_USER');
      expect(decision.rationale).toContain('malformed');
      expect(mockLLM.generate).toHaveBeenCalledTimes(1);
    });

    it('LLM 调用失败时应该抛出错误', async () => {
      const mockLLM = {
        generate: vi.fn().mockRejectedValue(new Error('LLM API error')),
      };

      const brain = new MasterBrain(promptBuilder, decisionParser, mockLLM);

      const input = createTestInput();

      await expect(brain.decide(input)).rejects.toThrow('LLM API error');
    });
  });
});
