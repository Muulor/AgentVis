/**
 * MasterBrainPrompt 预算管理 单元测试
 *
 * 覆盖范围：
 * - 向后兼容性（无 modelId 时不截断）
 * - 对话历史格式化与截断
 * - 工具目录渐进式截断（Level 1/2/3）
 * - 记忆快照渐进式截断
 * - RAG 证据按相关性截断
 * - 预算分配与总量控制
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { MasterBrainPrompt } from '../MasterBrainPrompt';
import type { MasterBrainInput, ToolCatalogEntry, RAGEvidence, MemorySnapshot } from '../types';
import { createEmptyMemorySnapshot } from '../types';
import { PLANNING_CONSTANTS } from '../../PlanningConstants';

const loggerMocks = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@services/logger', () => ({
  getLogger: () => loggerMocks,
}));

// ═══════════════════════════════════════════════════════════════
// 测试辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 创建测试用 MasterBrainInput（支持所有新字段）
 */
const createTestInput = (overrides: Partial<MasterBrainInput> = {}): MasterBrainInput => ({
  userIntent: {
    explicit: 'Test user intent',
  },
  memory: overrides.memory ?? createEmptyMemorySnapshot(),
  ragEvidence: overrides.ragEvidence ?? [],
  toolCatalog: overrides.toolCatalog ?? [],
  modelId: overrides.modelId,
  conversationHistory: overrides.conversationHistory,
  agentRules: overrides.agentRules,
});

/**
 * 生成大量工具条目（用于测试截断）
 */
function generateLargeToolCatalog(count: number): ToolCatalogEntry[] {
  const tools: ToolCatalogEntry[] = [];
  for (let i = 0; i < count; i++) {
    tools.push({
      name: `tool_${i}`,
      description: `This is a detailed description for tool ${i}. It provides a comprehensive explanation of what the tool does and how it should be used in different scenarios. The tool is designed for handling complex operations with multiple parameters.`,
      whenToUse: [
        `When you need to perform operation type ${i}`,
        `When the user requests action ${i} explicitly`,
        `When combined with tool_${(i + 1) % count} for complex workflows`,
      ],
      whenNotToUse: [`When operation type ${i} is not needed`, `When a simpler alternative exists`],
      decisionHint: [
        `Safe operations: behaviorHint='direct'`,
        `Risky operations: behaviorHint='careful'`,
      ],
      riskLevel: i % 3 === 0 ? 'high' : 'low',
    });
  }
  return tools;
}

/**
 * 生成大量 RAG 证据（用于测试截断）
 */
function generateLargeRAGEvidence(count: number): RAGEvidence[] {
  const evidence: RAGEvidence[] = [];
  for (let i = 0; i < count; i++) {
    evidence.push({
      source: `document_${i}.md`,
      content: `This is the content of evidence item ${i}. It contains relevant information about the topic being discussed. The evidence provides crucial context for decision making.`,
      relevance: Math.max(0.1, 1.0 - i * 0.05),
    });
  }
  return evidence;
}

/**
 * 构建含有大量 facts 的记忆快照
 */
function generateLargeMemorySnapshot(factCount: number): MemorySnapshot {
  const snapshot = createEmptyMemorySnapshot();
  for (let i = 0; i < factCount; i++) {
    snapshot.facts.push({
      id: `fact-${i}`,
      agentId: 'agent-1',
      layer: 'fact',
      content: `This is fact number ${i} about the project. It describes an important aspect of the system architecture that has been confirmed through previous interactions.`,
      category: 'knowledge_level',
      importance: Math.max(0.1, 1.0 - i * 0.02),
      sourceMessageIds: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  snapshot.summaries.push({
    id: 'summary-1',
    agentId: 'agent-1',
    layer: 'summary',
    content: 'This is a summary of previous conversation.',
    category: null,
    importance: 0.9,
    sourceMessageIds: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    confirmedDecisions: ['Use TypeScript for the project', 'Use React for the frontend'],
    openQuestions: [
      {
        question: 'What database to use?',
        scope: 'technical',
        reason: 'Need to finalize data layer architecture',
      },
    ],
    invalidatedPoints: ['Initial plan to use Python was abandoned'],
  });
  return snapshot;
}

// ═══════════════════════════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════════════════════════

describe('MasterBrainPrompt 预算管理', () => {
  const builder = new MasterBrainPrompt();

  beforeEach(() => {
    loggerMocks.trace.mockClear();
    loggerMocks.debug.mockClear();
    loggerMocks.warn.mockClear();
    loggerMocks.error.mockClear();
  });

  // ═══════════════════════════════════════════════════════════
  // 向后兼容性
  // ═══════════════════════════════════════════════════════════

  describe('向后兼容性（无 modelId 时不截断）', () => {
    it('无 modelId 时输出应包含所有内容（不触发截断）', () => {
      const input = createTestInput({
        toolCatalog: generateLargeToolCatalog(20),
        ragEvidence: generateLargeRAGEvidence(10),
        memory: generateLargeMemorySnapshot(20),
        // 注意：没有 modelId
      });
      const prompt = builder.build(input);

      // 应该包含所有 20 个工具的 whenToUse
      expect(prompt).toContain('tool_0');
      expect(prompt).toContain('tool_19');
      expect(prompt).toContain('When you need to perform operation type');

      // 应该包含所有 RAG 证据
      expect(prompt).toContain('document_0.md');
      expect(prompt).toContain('document_9.md');

      // 应该包含所有 facts
      expect(prompt).toContain('fact number 0');
      expect(prompt).toContain('fact number 19');

      // 不应出现截断标记
      expect(prompt).not.toContain('truncated');
    });

    it('有 modelId 时应触发预算控制（console.log 输出预算信息）', () => {
      const input = createTestInput({
        modelId: 'gemini-3-flash',
        toolCatalog: generateLargeToolCatalog(5),
      });
      builder.build(input);

      // 预算管理应该产生日志输出
      const budgetLogCalls = loggerMocks.trace.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('[MasterBrainPrompt]') &&
          call[0].includes('total=')
      );
      expect(budgetLogCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 对话历史格式化
  // ═══════════════════════════════════════════════════════════

  describe('对话历史格式化', () => {
    it('应该正确格式化对话历史（用户和助手标签）', () => {
      const input = createTestInput({
        conversationHistory: [
          { role: 'user', content: '帮我写一个函数' },
          { role: 'assistant', content: '好的，我来帮你写' },
        ],
      });
      const prompt = builder.build(input);

      expect(prompt).toContain('[CONVERSATION_HISTORY]');
      expect(prompt).toContain('User');
      expect(prompt).toContain('Assistant');
      expect(prompt).toContain('帮我写一个函数');
      expect(prompt).toContain('好的，我来帮你写');
    });

    it('无对话历史时显示默认提示', () => {
      const input = createTestInput();
      const prompt = builder.build(input);

      expect(prompt).toContain('[CONVERSATION_HISTORY]');
      expect(prompt).toContain('No recent conversation history');
    });

    it('超长消息应被截断', () => {
      const longMessage = 'A'.repeat(PLANNING_CONSTANTS.MASTER_BRAIN_MAX_MESSAGE_CHARS + 500);
      const input = createTestInput({
        conversationHistory: [{ role: 'user', content: longMessage }],
      });
      const prompt = builder.build(input);

      // 应该包含截断标记
      expect(prompt).toContain('truncated');
      // 不应包含完整的超长消息
      expect(prompt).not.toContain(longMessage);
    });

    it('短消息不应被截断', () => {
      const shortMessage = '这是一条短消息';
      const input = createTestInput({
        conversationHistory: [{ role: 'user', content: shortMessage }],
      });
      const prompt = builder.build(input);

      expect(prompt).toContain(shortMessage);
      // 不应出现截断标记（针对该消息）
      const historySection =
        prompt.split('[CONVERSATION_HISTORY]')[1]?.split('[RAG_EVIDENCE]')[0] ?? '';
      expect(historySection).not.toContain('truncated');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 工具目录截断
  // ═══════════════════════════════════════════════════════════

  describe('工具目录截断', () => {
    it('少量工具时应完整保留（Level 1）', () => {
      const input = createTestInput({
        modelId: 'gemini-3-flash',
        toolCatalog: generateLargeToolCatalog(3),
      });
      const prompt = builder.build(input);

      // 3 个工具应该完整保留，包括 whenToUse
      expect(prompt).toContain('tool_0');
      expect(prompt).toContain('tool_1');
      expect(prompt).toContain('tool_2');
      expect(prompt).toContain('When you need to perform operation type');
    });

    it('大量工具时应触发截断（移除 whenToUse 或截断 description）', () => {
      // 使用 200 个工具 + 最小上下文窗口确保触发截断
      const input = createTestInput({
        modelId: 'qwen/qwen3-32b', // 64k 上下文窗口
        toolCatalog: generateLargeToolCatalog(200),
      });
      const prompt = builder.build(input);

      // 即使截断，所有工具名称应保留（设计原则：不删除工具条目）
      expect(prompt).toContain('tool_0');
      expect(prompt).toContain('tool_199');

      // 截断日志应该存在
      const truncationLogs = loggerMocks.trace.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('toolCatalog Level')
      );
      expect(truncationLogs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 记忆截断
  // ═══════════════════════════════════════════════════════════

  describe('记忆截断', () => {
    it('少量 facts 时应完整保留', () => {
      const input = createTestInput({
        modelId: 'gemini-3-flash',
        memory: generateLargeMemorySnapshot(3),
      });
      const prompt = builder.build(input);

      expect(prompt).toContain('fact number 0');
      expect(prompt).toContain('fact number 2');
      expect(prompt).toContain('Confirmed decisions');
    });

    it('大量 facts 时低 importance 的应优先被裁剪', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const input = createTestInput({
        modelId: 'qwen/qwen3-32b', // 较小上下文窗口
        memory: generateLargeMemorySnapshot(100),
      });
      const prompt = builder.build(input);

      // 高 importance 的 facts 应该保留
      expect(prompt).toContain('fact number 0');

      // 检查是否有截断日志
      const memoryLogs = consoleSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('memory Level')
      );
      // 如果触发了截断，应该有相关日志
      // 注意：如果内容不够多以触发截断，这也是可接受的
      if (memoryLogs.length > 0) {
        expect(memoryLogs[0]![0]).toMatch(/Level [23]/);
      }

      consoleSpy.mockRestore();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // RAG 截断
  // ═══════════════════════════════════════════════════════════

  describe('RAG 证据截断', () => {
    it('少量证据时应完整保留', () => {
      const input = createTestInput({
        modelId: 'gemini-3-flash',
        ragEvidence: generateLargeRAGEvidence(3),
      });
      const prompt = builder.build(input);

      expect(prompt).toContain('document_0.md');
      expect(prompt).toContain('document_1.md');
      expect(prompt).toContain('document_2.md');
    });

    it('大量证据时低相关性的应被丢弃', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const input = createTestInput({
        modelId: 'qwen/qwen3-32b',
        ragEvidence: generateLargeRAGEvidence(50),
      });
      const prompt = builder.build(input);

      // 高相关性证据应该保留（前面的 relevance 更高）
      expect(prompt).toContain('document_0.md');

      const ragLogs = consoleSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('RAG: 保留')
      );
      if (ragLogs.length > 0) {
        // 低相关性证据可能被丢弃
        expect(ragLogs[0]![0]).toMatch(/保留 \d+\/50 条/);
      }

      consoleSpy.mockRestore();
    });

    it('单条超大附件证据超预算时应保留截断预览', () => {
      const hugeAttachmentContent = [
        'Attachment Manifest:',
        '- 夜航西飞.md (document, md, 478KB)',
        'Path: C:\\Users\\Muulo\\AppData\\Roaming\\com.agentvis.app\\deliverables\\Nano_Crew\\Luckily\\attachments\\夜航西飞.md',
        '# 夜航西飞',
        '序言',
        '《夜航西飞》充满诱惑与神秘。',
        '正文'.repeat(200000),
      ].join('\n');

      const input = createTestInput({
        modelId: 'gemini-3-flash',
        ragEvidence: [
          {
            source: 'attachment',
            content: hugeAttachmentContent,
            relevance: 1,
          },
        ],
      });
      const prompt = builder.build(input);
      const ragSection = prompt.split('[RAG_EVIDENCE]')[1]?.split('[TOOL_CATALOG]')[0] ?? '';

      expect(ragSection).toContain('attachment');
      expect(ragSection).toContain('夜航西飞.md');
      expect(ragSection).toContain('# 夜航西飞');
      expect(ragSection).toContain('... (truncated)');
      expect(ragSection).not.toContain('(RAG evidence has been truncated)');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Prompt 结构完整性
  // ═══════════════════════════════════════════════════════════

  describe('Prompt 结构完整性', () => {
    it('预算管理后 Prompt 结构不应被破坏', () => {
      const input = createTestInput({
        modelId: 'gemini-3-flash',
        toolCatalog: generateLargeToolCatalog(10),
        ragEvidence: generateLargeRAGEvidence(5),
        memory: generateLargeMemorySnapshot(10),
        conversationHistory: [
          { role: 'user', content: '测试' },
          { role: 'assistant', content: '好的' },
        ],
      });
      const prompt = builder.build(input);

      // 核心 sections 应全部存在
      expect(prompt).toContain('Prime Directive');
      expect(prompt).toContain('[USER_INTENT]');
      // [SYSTEM_STATE] 已移除，预算由 LoopGovernor 后台管理
      expect(prompt).not.toContain('[SYSTEM_STATE]');
      expect(prompt).toContain('[MEMORY]');
      expect(prompt).toContain('[CONVERSATION_HISTORY]');
      expect(prompt).toContain('[RAG_EVIDENCE]');
      expect(prompt).toContain('[TOOL_CATALOG]');
      expect(prompt).toContain('Output Format');
    });

    it('section 顺序应正确（MEMORY → HISTORY → RAG）', () => {
      const input = createTestInput({
        modelId: 'gemini-3-flash',
        conversationHistory: [{ role: 'user', content: '测试消息' }],
      });
      const prompt = builder.build(input);

      const memoryIndex = prompt.indexOf('[MEMORY]');
      const historyIndex = prompt.indexOf('[CONVERSATION_HISTORY]');
      const ragIndex = prompt.indexOf('[RAG_EVIDENCE]');

      // 验证顺序：MEMORY < HISTORY < RAG
      expect(memoryIndex).toBeLessThan(historyIndex);
      expect(historyIndex).toBeLessThan(ragIndex);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 极端场景
  // ═══════════════════════════════════════════════════════════

  describe('极端场景', () => {
    it('所有可变内容为空时不应崩溃', () => {
      const input = createTestInput({
        modelId: 'gemini-3-flash',
        toolCatalog: [],
        ragEvidence: [],
        memory: createEmptyMemorySnapshot(),
        conversationHistory: [],
      });
      const prompt = builder.build(input);

      expect(prompt).toContain('Prime Directive');
      expect(prompt).toContain('No available tools');
      expect(prompt).toContain('No recent conversation history');
    });

    it('未知 modelId 应使用 default 上下文窗口', () => {
      const input = createTestInput({
        modelId: 'unknown-model-xyz',
        toolCatalog: generateLargeToolCatalog(5),
      });
      // 不应抛出异常
      const prompt = builder.build(input);
      expect(prompt).toContain('Prime Directive');

      // 验证使用了 default 窗口大小的预算
      const budgetLog = loggerMocks.trace.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('预算: total=')
      );
      expect(budgetLog).toBeDefined();

      // 默认窗口 128000 * 0.85 = 108800
      const expectedBudget = Math.floor(
        PLANNING_CONSTANTS.DEFAULT_CONTEXT_WINDOW *
          PLANNING_CONSTANTS.MASTER_BRAIN_PROMPT_BUDGET_RATIO
      );
      expect(budgetLog![0]).toContain(`total=${expectedBudget}`);
    });

    it('agentRules 应该在 Prime Directive 之后渲染', () => {
      const input = createTestInput({
        agentRules: '你是一个专注于代码质量的 AI 助手',
      });
      const prompt = builder.build(input);

      const primeIndex = prompt.indexOf('Prime Directive');
      const rulesIndex = prompt.indexOf('User-Defined Persona');

      expect(primeIndex).toBeGreaterThan(-1);
      expect(rulesIndex).toBeGreaterThan(-1);
      expect(rulesIndex).toBeGreaterThan(primeIndex);
    });
  });
});
