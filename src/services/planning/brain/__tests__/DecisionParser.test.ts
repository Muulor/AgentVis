/**
 * DecisionParser 单元测试
 *
 * 测试决策解析器的 JSON 提取、Schema 验证功能
 */

import { describe, it, expect } from 'vitest';
import { DecisionParser } from '../DecisionParser';

// ═══════════════════════════════════════════════════════════════
// 测试数据
// ═══════════════════════════════════════════════════════════════

const createValidDecisionJson = (
    decision: string,
    extras: Record<string, unknown> = {}
) => `
\`\`\`json
{
  "decision": "${decision}",
  "rationale": "This is a test rationale",
  "riskAssessment": {
    "level": "low",
    "notes": "No significant risks"
  }${Object.keys(extras).length > 0 ? ',' : ''}
  ${Object.entries(extras)
        .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`)
        .join(',\n  ')}
}
\`\`\`
`;

// ═══════════════════════════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════════════════════════

describe('DecisionParser', () => {
    const parser = new DecisionParser();

    describe('JSON 块提取', () => {
        it('应该成功提取 markdown JSON 代码块', () => {
            const response = createValidDecisionJson('RESPOND_TO_USER', {
                response: 'Task completed',
            });
            const decision = parser.parse(response);
            expect(decision.decision).toBe('RESPOND_TO_USER');
        });

        it('没有 JSON 块的响应应降级为 RESPOND_TO_USER 兜底决策', () => {
            const response = 'This is just plain text without JSON';
            // DecisionParser 的容错设计：纯文本不再抛出异常，而是包装为 RESPOND_TO_USER
            const decision = parser.parse(response);
            expect(decision.decision).toBe('RESPOND_TO_USER');
            expect(decision.rationale).toContain('downgraded');
            if (decision.decision === 'RESPOND_TO_USER') {
                expect(decision.response).toBe(response);
            }
        });

        it('决策 schema 自言自语伴随重复坍缩时应返回错误提示而非原文', () => {
            const response = [
                'field should contain the reply. is required for RESPOND_TO_USER.',
                'So I will set decision: RESPOND_TO_USER, rationale: greeting,',
                'riskAssessment: level low, nextStep can be empty.',
                'Final JSON must ensure exactly one JSON object.',
                'response. '.repeat(60),
            ].join(' ');

            const decision = parser.parse(response);

            expect(decision.decision).toBe('RESPOND_TO_USER');
            expect(decision.rationale).toContain('malformed');
            if (decision.decision === 'RESPOND_TO_USER') {
                expect(decision.response).toContain('malformed decision');
                expect(decision.response).not.toContain('response. response. response');
            }
        });

        it('应该处理多个 JSON 块（取第一个）', () => {
            const response = `
\`\`\`json
{
  "decision": "RESPOND_TO_USER",
  "rationale": "First block",
  "riskAssessment": { "level": "low", "notes": "" },
  "response": "First"
}
\`\`\`

\`\`\`json
{
  "decision": "REQUEST_MORE_INPUT",
  "rationale": "Second block"
}
\`\`\`
`;
            const decision = parser.parse(response);
            expect(decision.rationale).toBe('First block');
        });

        it('无效 JSON 格式应降级为 RESPOND_TO_USER 兜底决策', () => {
            const response = '```json\n{ invalid json }\n```';
            // DecisionParser 的容错设计：无法解析的 JSON 不再抛出异常
            const decision = parser.parse(response);
            expect(decision.decision).toBe('RESPOND_TO_USER');
            expect(decision.rationale).toContain('downgraded');
        });
    });

    describe('Schema 验证', () => {
        it('应该接受所有有效的决策类型', () => {
            const types = [
                'SPAWN_SUB_AGENT',
                'REQUEST_MORE_INPUT',
                'RESPOND_TO_USER',
            ];

            for (const type of types) {
                const extras: Record<string, unknown> = {};
                if (type === 'REQUEST_MORE_INPUT')
                    extras.questionsForUser = ['What next?'];
                if (type === 'RESPOND_TO_USER')
                    extras.response = 'Done';
                if (type === 'SPAWN_SUB_AGENT') {
                    extras.nextStep = {
                        task: '执行测试任务',
                        tools: ['read'],
                    };
                }

                const response = createValidDecisionJson(type, extras);
                const decision = parser.parse(response);
                expect(decision.decision).toBe(type);
            }
        });

        it('无效决策类型应降级为 RESPOND_TO_USER 兑底决策', () => {
            // parse() 现在采用「修复优先、降级兑底」的设计：
            // validateAndRepairSchema 抛出的 DecisionParseError 被捕获后出发 buildFallbackDecision，
            // 并不再向上抛出。这确保任何无效输入都不会崩溃 MasterBrain。
            const response = createValidDecisionJson('INVALID_TYPE');
            const result = parser.parse(response);
            expect(result.decision).toBe('RESPOND_TO_USER');
        });

        it('缺少 rationale 的决策应降级为 RESPOND_TO_USER 兑底决策', () => {
            const response = `
\`\`\`json
{
  "decision": "RESPOND_TO_USER",
  "riskAssessment": { "level": "low", "notes": "" },
  "response": "Done"
}
\`\`\`
`;
            const result = parser.parse(response);
            expect(result.decision).toBe('RESPOND_TO_USER');
        });

        it('无效的风险等级应自动修复为默认值', () => {
            // riskAssessment.level 无法识别的内容现在填充 low，不抛出，不降级；属于非核心字段。
            // 'critical' 在 RISK_LEVEL_ALIASES 中映射为 'high'，返回合法决策而非兑底。
            const response = `
\`\`\`json
{
  "decision": "RESPOND_TO_USER",
  "rationale": "Test",
  "riskAssessment": { "level": "critical", "notes": "" },
  "response": "Done"
}
\`\`\`
`;
            const result = parser.parse(response);
            expect(result.decision).toBe('RESPOND_TO_USER');
            expect(result.riskAssessment.level).toBe('high'); // critical 映射为 high
        });

        it('操作型决策缺少 riskAssessment 应降级为 RESPOND_TO_USER 兑底决策', () => {
            const response = `
\`\`\`json
{
  "decision": "SPAWN_SUB_AGENT",
  "rationale": "Test"
}
\`\`\`
`;
            const result = parser.parse(response);
            expect(result.decision).toBe('RESPOND_TO_USER');
        });

        it('非操作型决策缺少 riskAssessment 时应自动填充默认值', () => {
            const response = `
\`\`\`json
{
  "decision": "RESPOND_TO_USER",
  "rationale": "Test response",
  "response": "Hello user"
}
\`\`\`
`;
            const decision = parser.parse(response);
            expect(decision.decision).toBe('RESPOND_TO_USER');
            expect(decision.riskAssessment).toEqual({ level: 'low', notes: '' });
        });

        it('缺少早期循环状态字段的决策仍应接受', () => {
            const response = `
\`\`\`json
{
  "decision": "RESPOND_TO_USER",
  "rationale": "Test",
  "riskAssessment": { "level": "low", "notes": "" },
  "response": "Done"
}
\`\`\`
`;
            const result = parser.parse(response);
            expect(result.decision).toBe('RESPOND_TO_USER');
            if (result.decision === 'RESPOND_TO_USER') {
                expect(result.response).toBe('Done');
            }
        });
    });

    describe('SPAWN_SUB_AGENT 增强简化模式', () => {
        it('SPAWN_SUB_AGENT 无 nextStep 应接受（由 SubAgentSpecBuilder JIT 构建）', () => {
            const response = createValidDecisionJson('SPAWN_SUB_AGENT');
            const decision = parser.parse(response);
            expect(decision.decision).toBe('SPAWN_SUB_AGENT');
        });

        it('SPAWN_SUB_AGENT 带 nextStep.task + tools 应接受', () => {
            const response = createValidDecisionJson('SPAWN_SUB_AGENT', {
                nextStep: {
                    task: '读取项目文件',
                    tools: ['read', 'web_search'],
                },
            });
            const decision = parser.parse(response);
            expect(decision.decision).toBe('SPAWN_SUB_AGENT');
        });

        it('repairs malformed MB task JSON missing a quote before tools', () => {
            const response = `
\`\`\`json
{
  "decision": "SPAWN_SUB_AGENT",
  "rationale": "Need a generated image.",
  "riskAssessment": { "level": "low", "notes": "No risk" },
  "nextStep": {
    "task": "Use the generate_image tool to create an image of a character standing
in a cozy kitchen, cooking a delicious-looking meal.
    "tools": ["generate_image"]
  }
}
\`\`\`
`;
            const decision = parser.parse(response);
            const nextStep = decision.nextStep as Record<string, unknown> | undefined;

            expect(decision.decision).toBe('SPAWN_SUB_AGENT');
            expect(nextStep?.task).toContain('delicious-looking meal');
            expect(nextStep?.tools).toEqual(['generate_image']);
        });

        it('recovers a decision from nested escaped JSON when the wrapper is malformed', () => {
            const nestedDecision = {
                decision: 'SPAWN_SUB_AGENT',
                rationale: 'Need one generated image.',
                riskAssessment: { level: 'low', notes: 'No risk' },
                nextStep: {
                    task: 'Use generate_image to create a cute abyssinian kitten in 2K landscape format.',
                    tools: ['generate_image'],
                },
            };

            const response = `\`\`\`json
{
  "decision": "SPAWN_SUB_AGENT": ${JSON.stringify(JSON.stringify(nestedDecision, null, 2))}
}
\`\`\``;

            const decision = parser.parse(response);
            const nextStep = decision.nextStep as Record<string, unknown> | undefined;

            expect(decision.decision).toBe('SPAWN_SUB_AGENT');
            expect(nextStep?.task).toContain('abyssinian kitten');
            expect(nextStep?.tools).toEqual(['generate_image']);
        });

        it('recovers malformed MB JSON with duplicated rationale and missing value terminators', () => {
            const response = `
\`\`\`json
{
  "decision": "SPAWN_SUB_AGENT",
  "rationale": "rationale": "User asked for a cute abyssinian kitten image,
  "riskAssessment": {
    "level": "low",
    "notes": "Image generation is low risk
  },
  "nextStep": {
    "task": "Use generate_image to create a cute abyssinian kitten in 2K landscape format.
    "tools": ["generate_image"],
    "behaviorHint": "direct",
    "role": "Image Generator"
  },
  "response": ""
}
\`\`\`
`;

            const decision = parser.parse(response);
            const nextStep = decision.nextStep as Record<string, unknown> | undefined;

            expect(decision.decision).toBe('SPAWN_SUB_AGENT');
            expect(decision.rationale).toContain('abyssinian kitten');
            expect(decision.riskAssessment.notes).toContain('low risk');
            expect(nextStep?.task).toContain('2K landscape format');
            expect(nextStep?.tools).toEqual(['generate_image']);
        });

        it('recovers malformed MB JSON with an orphan string inside riskAssessment', () => {
            const response = `
\`\`\`json
{
  "decision": "SPAWN_SUB_AGENT",
  "rationale": "Need one generated image.",
  "riskAssessment": {
    "level": "low",
    "notes": "No risk",
    "yes"
  },
  "nextStep": {
    "task": "Use generate_image to create a cute abyssinian kitten in 2K landscape format.",
    "tools": ["generate_image"],
    "behaviorHint": "direct",
    "role": "Image Generator"
  }
}
\`\`\`
`;

            const decision = parser.parse(response);
            const nextStep = decision.nextStep as Record<string, unknown> | undefined;

            expect(decision.decision).toBe('SPAWN_SUB_AGENT');
            expect(nextStep?.tools).toEqual(['generate_image']);
        });

        it('recovers RESPOND_TO_USER JSON followed by an extra closing brace', () => {
            const response = `
\`\`\`json
{
  "decision": "RESPOND_TO_USER",
  "rationale": "The sub-agent completed the requested single-file implementation.",
  "riskAssessment": {
    "level": "low",
    "notes": "The deliverable is ready for user review."
  },
  "nextStep": {},
  "response": "Your high-fidelity 3D ISS Orbital Tracker is ready in index.html."
}
}
\`\`\`
`;

            const decision = parser.parse(response);

            expect(decision.decision).toBe('RESPOND_TO_USER');
            if (decision.decision === 'RESPOND_TO_USER') {
                expect(decision.response).toContain('ISS Orbital Tracker');
            }
        });

        it('recovers RESPOND_TO_USER JSON with quoted UI labels followed by prose commas', () => {
            const response = `
\`\`\`json
{
  "decision": "RESPOND_TO_USER",
  "rationale": "Both checks completed.",
  "riskAssessment": { "level": "low", "notes": "No failures." },
  "nextStep": {},
  "response": "All checks are complete. Window title "GameViewer", interface shows "UU Remote", "My Devices" and the browser stayed minimized."
}
\`\`\`
`;

            const decision = parser.parse(response);

            expect(decision.decision).toBe('RESPOND_TO_USER');
            if (decision.decision === 'RESPOND_TO_USER') {
                expect(decision.response).toContain('"GameViewer", interface');
                expect(decision.response).toContain('"UU Remote", "My Devices"');
            }
        });
    });
});
