import { describe, expect, it } from 'vitest';
import type { Chunk } from '../../../types';
import { HybridRetriever } from '../HybridRetriever';
import { preprocessRagQuery } from '../RagQueryPreprocessor';

function makeChunk(input: {
  id: string;
  parentId: string;
  fileName: string;
  content: string;
  chunkIndex?: number;
  isDocumentOverview?: boolean;
}): Chunk {
  return {
    id: input.id,
    agentId: 'agent1',
    documentId: input.fileName,
    chunkIndex: input.chunkIndex ?? 0,
    content: input.content,
    metadata: {
      fileName: input.fileName,
      parentChunkId: input.parentId,
      sectionPath: '#',
      isDocumentOverview: input.isDocumentOverview,
    },
    createdAt: 0,
  };
}

describe('HybridRetriever output allocation', () => {
  it('downweights BM25-only hits for broad overview queries when embedding has candidates', () => {
    const retriever = new HybridRetriever() as any;
    const featureChunk = makeChunk({
      id: 'feature-1',
      parentId: 'feature-parent',
      fileName: 'features_deep_dive.md',
      content: 'AgentVis 核心特性包括可视化增强、RAG、记忆和协同执行',
    });
    const regressionChunk = makeChunk({
      id: 'regression-1',
      parentId: 'regression-parent',
      fileName: 'AgentVis ControlledNetwork 回归矩阵.md',
      content: 'curl canary powershell proxy bypass 回归测试命令',
    });

    const fused = retriever.rrfFusion(
      [{ chunk: featureChunk, score: 0.72, rank: 5 }],
      [{ chunk: regressionChunk, score: 3.2, rank: 1 }],
      retriever.getConfig(),
      true
    );

    expect(fused[0].chunkId).toBe('feature-1');
  });

  it('keeps full BM25 weight for broad overview source candidates', () => {
    const retriever = new HybridRetriever() as any;
    const featureChunk = makeChunk({
      id: 'feature-title',
      parentId: 'feature-parent',
      fileName: 'features_deep_dive.md',
      content: '# AgentVis 四大核心特性深度技术解析',
    });
    const regressionChunk = makeChunk({
      id: 'regression-command',
      parentId: 'regression-parent',
      fileName: 'AgentVis ControlledNetwork 回归矩阵.md',
      content: 'curl canary powershell proxy bypass 回归测试命令',
    });

    const fused = retriever.rrfFusion(
      [],
      [
        { chunk: regressionChunk, score: 3.2, rank: 1 },
        { chunk: featureChunk, score: 2.8, rank: 2 },
      ],
      retriever.getConfig(),
      true
    );

    expect(fused[0].chunkId).toBe('regression-command');

    const fusedWithEmbeddingCandidates = retriever.rrfFusion(
      [
        {
          chunk: makeChunk({
            id: 'sandbox-embedding',
            parentId: 'sandbox-parent',
            fileName: 'AgentVis 沙箱机制功能文档.md',
            content: '沙箱机制功能边界',
          }),
          score: 0.54,
          rank: 10,
        },
      ],
      [
        { chunk: regressionChunk, score: 3.2, rank: 1 },
        { chunk: featureChunk, score: 2.8, rank: 2 },
      ],
      retriever.getConfig(),
      true
    );

    const typedFused = fusedWithEmbeddingCandidates as Array<{ chunkId: string; rrfScore: number }>;
    const featureScore = typedFused.find((result) => result.chunkId === 'feature-title')?.rrfScore;
    const regressionScore = typedFused.find(
      (result) => result.chunkId === 'regression-command'
    )?.rrfScore;
    expect(featureScore).toBeDefined();
    expect(regressionScore).toBeDefined();
    expect(featureScore!).toBeGreaterThan(regressionScore!);
  });

  it('泛 query 下以最佳 child 为主排序 Parent，避免多命中噪音文档压过主文档', () => {
    const retriever = new HybridRetriever() as any;
    const featureParent = 'feature-parent';
    const noisyParent = 'noisy-parent';

    const aggregated = retriever.aggregateByParent(
      [
        {
          chunkId: 'feature-1',
          chunk: makeChunk({
            id: 'feature-1',
            parentId: featureParent,
            fileName: 'features_deep_dive.md',
            content: 'VisualEnhancerService 功能定位',
          }),
          rrfScore: 0.0164,
        },
        {
          chunkId: 'feature-2',
          chunk: makeChunk({
            id: 'feature-2',
            parentId: featureParent,
            fileName: 'features_deep_dive.md',
            content: 'VisualEnhancerService 触发判断',
          }),
          rrfScore: 0.0159,
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          chunkId: `noisy-${index}`,
          chunk: makeChunk({
            id: `noisy-${index}`,
            parentId: noisyParent,
            fileName: '跨请求上下文持久化 — 故障排查手册.md',
            content: `VisualEnhancer 故障排查 ${index}`,
          }),
          rrfScore: index === 0 ? 0.0156 : 0.0149,
        })),
      ],
      false
    );

    expect(aggregated[0].sourceFile).toBe('features_deep_dive.md');
  });

  it('泛 query 下优先保留主 Parent 细节，再穿插辅助来源，并跳过重复内容', () => {
    const retriever = new HybridRetriever() as any;
    const primary = {
      scoredChunks: [
        {
          chunk: makeChunk({
            id: 'feature-1',
            parentId: 'feature-parent',
            fileName: 'features_deep_dive.md',
            content: 'VisualEnhancerService 功能定位与触发判断',
          }),
          score: 0.0164,
        },
        {
          chunk: makeChunk({
            id: 'feature-duplicate',
            parentId: 'feature-parent',
            fileName: 'features_deep_dive.md',
            content: 'VisualEnhancerService 功能定位与触发判断',
          }),
          score: 0.016,
        },
        {
          chunk: makeChunk({
            id: 'feature-2',
            parentId: 'feature-parent',
            fileName: 'features_deep_dive.md',
            content: 'shouldEnhance 命中后构建可视化 Prompt',
          }),
          score: 0.0159,
        },
        {
          chunk: makeChunk({
            id: 'feature-3',
            parentId: 'feature-parent',
            fileName: 'features_deep_dive.md',
            content: '增强失败时无声降级',
          }),
          score: 0.0156,
        },
      ],
    };
    const supportA = {
      scoredChunks: [
        {
          chunk: makeChunk({
            id: 'structure-1',
            parentId: 'structure-parent',
            fileName: 'PROJECT_STRUCTURE.md',
            content: 'visual-enhancer 模块文件列表',
          }),
          score: 0.0155,
        },
      ],
    };
    const supportB = {
      scoredChunks: [
        {
          chunk: makeChunk({
            id: 'rag-1',
            parentId: 'rag-parent',
            fileName: 'Rag机制.md',
            content: 'RAG 注入上下文',
          }),
          score: 0.015,
        },
      ],
    };

    const results = retriever.selectBalancedParentResults([primary, supportA, supportB], 4, 5);

    expect(results).toHaveLength(5);
    expect(results.slice(0, 3).map((result: { chunk: Chunk }) => result.chunk.id)).toEqual([
      'feature-1',
      'feature-2',
      'feature-3',
    ]);
    expect(results.map((result: { chunk: Chunk }) => result.chunk.id)).not.toContain(
      'feature-duplicate'
    );
    expect(
      results.slice(3).map((result: { chunk: Chunk }) => result.chunk.metadata.fileName)
    ).toEqual(['PROJECT_STRUCTURE.md', 'Rag机制.md']);
  });

  it('泛 query 主来源预算后优先补充不同 source，避免同一文件连续占满结果', () => {
    const retriever = new HybridRetriever() as any;
    const primary = {
      sourceFile: 'features_deep_dive.md',
      scoredChunks: [
        {
          chunk: makeChunk({
            id: 'feature-1',
            parentId: 'feature-parent',
            fileName: 'features_deep_dive.md',
            content: 'AgentVis 核心特性总览',
          }),
          score: 0.0164,
        },
        {
          chunk: makeChunk({
            id: 'feature-2',
            parentId: 'feature-parent',
            fileName: 'features_deep_dive.md',
            content: 'Visual Enhancer 功能定位',
          }),
          score: 0.016,
        },
        {
          chunk: makeChunk({
            id: 'feature-3',
            parentId: 'feature-parent',
            fileName: 'features_deep_dive.md',
            content: '记忆和 RAG 能力',
          }),
          score: 0.0158,
        },
      ],
    };
    const sameSourceExtra = {
      sourceFile: 'features_deep_dive.md',
      scoredChunks: [
        {
          chunk: makeChunk({
            id: 'feature-extra',
            parentId: 'feature-extra-parent',
            fileName: 'features_deep_dive.md',
            content: '同一文件里的更多细节',
          }),
          score: 0.0157,
        },
      ],
    };
    const supportA = {
      sourceFile: 'Skill 功能技术文档.md',
      scoredChunks: [
        {
          chunk: makeChunk({
            id: 'skill-1',
            parentId: 'skill-parent',
            fileName: 'Skill 功能技术文档.md',
            content: 'Skill 能力扩展',
          }),
          score: 0.0156,
        },
      ],
    };
    const supportB = {
      sourceFile: 'Rag机制.md',
      scoredChunks: [
        {
          chunk: makeChunk({
            id: 'rag-1',
            parentId: 'rag-parent',
            fileName: 'Rag机制.md',
            content: 'RAG 检索机制',
          }),
          score: 0.0155,
        },
      ],
    };

    const results = retriever.selectBalancedParentResults(
      [primary, sameSourceExtra, supportA, supportB],
      4,
      5
    );

    expect(results.map((result: { chunk: Chunk }) => result.chunk.id)).toEqual([
      'feature-1',
      'feature-2',
      'feature-3',
      'skill-1',
      'rag-1',
    ]);
  });

  it('final relevance gate keeps grounded hits and allows fewer than finalTopK', () => {
    const retriever = new HybridRetriever() as any;
    const groundedChunk = makeChunk({
      id: 'memory-grounded',
      parentId: 'memory-parent',
      fileName: '记忆机制介绍.md',
      content: 'AgentVis 记忆机制包含事实抽取、水位线整理和摘要注入。',
    });
    const weakChunk = makeChunk({
      id: 'sandbox-weak',
      parentId: 'sandbox-parent',
      fileName: 'AgentVis 沙箱机制功能文档.md',
      content: 'proxy certificate browser command details',
    });
    const strongSemanticChunk = makeChunk({
      id: 'semantic-strong',
      parentId: 'semantic-parent',
      fileName: 'semantic.md',
      content: 'semantically close but without the exact query words',
    });

    const filtered = retriever.applyFinalRelevanceGate(
      [
        { chunk: groundedChunk, score: 0.03 },
        { chunk: weakChunk, score: 0.02 },
        { chunk: strongSemanticChunk, score: 0.01 },
      ],
      [
        { chunkId: groundedChunk.id, chunk: groundedChunk, rrfScore: 0.03, embeddingScore: 0.5 },
        { chunkId: weakChunk.id, chunk: weakChunk, rrfScore: 0.02, embeddingScore: 0.5 },
        {
          chunkId: strongSemanticChunk.id,
          chunk: strongSemanticChunk,
          rrfScore: 0.01,
          embeddingScore: 0.65,
        },
      ],
      preprocessRagQuery('AgentVis 的记忆机制是怎样的'),
      retriever.getConfig()
    );

    expect(filtered.map((result: { chunk: Chunk }) => result.chunk.id)).toEqual([
      'memory-grounded',
      'semantic-strong',
    ]);
  });

  it('final relevance gate keeps BM25-only hits only when they have useful lexical grounding', () => {
    const retriever = new HybridRetriever() as any;
    const groundedChunk = makeChunk({
      id: 'alpha-grounded',
      parentId: 'alpha-parent',
      fileName: 'guide.md',
      content: 'persistent alpha guide',
    });
    const weakChunk = makeChunk({
      id: 'alpha-weak',
      parentId: 'weak-parent',
      fileName: 'guide.md',
      content: 'persistent guide without the target token',
    });

    const filtered = retriever.applyFinalRelevanceGate(
      [
        { chunk: groundedChunk, score: 0.03 },
        { chunk: weakChunk, score: 0.02 },
      ],
      [
        { chunkId: groundedChunk.id, chunk: groundedChunk, rrfScore: 0.03, bm25Score: 1.2 },
        { chunkId: weakChunk.id, chunk: weakChunk, rrfScore: 0.02, bm25Score: 1.1 },
      ],
      preprocessRagQuery('alpha'),
      retriever.getConfig()
    );

    expect(filtered.map((result: { chunk: Chunk }) => result.chunk.id)).toEqual(['alpha-grounded']);
  });

  it('final relevance gate treats broad overview cue terms as useful grounding', () => {
    const retriever = new HybridRetriever() as any;
    const overviewChunk = makeChunk({
      id: 'features-overview',
      parentId: 'features-parent',
      fileName: 'features_deep_dive.md',
      content: '# Document Overview\nTitle: AgentVis 四大核心特性深度技术解析',
    });

    const filtered = retriever.applyFinalRelevanceGate(
      [{ chunk: overviewChunk, score: 0.03 }],
      [{ chunkId: overviewChunk.id, chunk: overviewChunk, rrfScore: 0.03, bm25Score: 1.2 }],
      preprocessRagQuery('AgentVis 有什么特性'),
      retriever.getConfig()
    );

    expect(filtered.map((result: { chunk: Chunk }) => result.chunk.id)).toEqual([
      'features-overview',
    ]);
  });

  it('final relevance gate keeps cross-language reranked semantic hits without lexical grounding', () => {
    const retriever = new HybridRetriever() as any;
    const reportChunk = makeChunk({
      id: 'robustness-report',
      parentId: 'robustness-parent',
      fileName: 'robustness_test_report.md',
      content: [
        '# Browser Automation Robustness Test Report',
        'Test Target: agent-browser automation skill.',
        'Issues Encountered: batch wrapper quoting issue with spaces.',
        'Conclusion: the browser automation workflow is robust overall.',
      ].join('\n'),
    });

    const filtered = retriever.applyFinalRelevanceGate(
      [{ chunk: reportChunk, score: 0.03 }],
      [
        {
          chunkId: reportChunk.id,
          chunk: reportChunk,
          rrfScore: 0.03,
          embeddingScore: 0.58,
          rerankScore: 0.12,
        },
      ],
      preprocessRagQuery(
        '\u8fd9\u4efd\u6d4b\u8bd5\u62a5\u544a\u80fd\u89e3\u91ca\u4e00\u4e0b\u5417'
      ),
      retriever.getConfig()
    );

    expect(filtered.map((result: { chunk: Chunk }) => result.chunk.id)).toEqual([
      'robustness-report',
    ]);
  });

  it('final relevance gate drops cross-language hits when semantic evidence is weak', () => {
    const retriever = new HybridRetriever() as any;
    const reportChunk = makeChunk({
      id: 'weak-english-report',
      parentId: 'weak-english-parent',
      fileName: 'unrelated_report.md',
      content: [
        '# Browser Automation Notes',
        'This note lists internal command-line options and unrelated runtime details.',
      ].join('\n'),
    });

    const filtered = retriever.applyFinalRelevanceGate(
      [{ chunk: reportChunk, score: 0.03 }],
      [
        {
          chunkId: reportChunk.id,
          chunk: reportChunk,
          rrfScore: 0.03,
          embeddingScore: 0.49,
          rerankScore: 0.09,
        },
      ],
      preprocessRagQuery(
        '\u8fd9\u4efd\u6d4b\u8bd5\u62a5\u544a\u80fd\u89e3\u91ca\u4e00\u4e0b\u5417'
      ),
      retriever.getConfig()
    );

    expect(filtered).toEqual([]);
  });

  it('restores cached sibling chunks from the same parent and skips duplicate restored hits', () => {
    const retriever = new HybridRetriever() as any;
    const parentId = 'restore-parent-context-test';
    const chunks = [
      makeChunk({
        id: 'restore-before',
        parentId,
        fileName: 'parent_context_restore.md',
        content: 'Section intro with parent-level framing.',
        chunkIndex: 1,
      }),
      makeChunk({
        id: 'restore-hit',
        parentId,
        fileName: 'parent_context_restore.md',
        content: 'Focused hit that matched the query.',
        chunkIndex: 2,
      }),
      makeChunk({
        id: 'restore-after',
        parentId,
        fileName: 'parent_context_restore.md',
        content: 'Follow-up detail that makes the answer complete.',
        chunkIndex: 3,
      }),
    ];

    for (const chunk of chunks) {
      retriever.vectorStore.cacheChunk(chunk);
    }

    const results = retriever.restoreParentContexts(
      [
        { chunk: chunks[1], score: 0.03 },
        { chunk: chunks[2], score: 0.02 },
      ],
      true,
      1000
    );

    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.03);
    expect(results[0].chunk.metadata.isParentContextRestored).toBe(true);
    expect(results[0].chunk.content).toContain('Section intro with parent-level framing.');
    expect(results[0].chunk.content).toContain('Focused hit that matched the query.');
    expect(results[0].chunk.content).toContain('Follow-up detail that makes the answer complete.');
  });

  it('boosts document overview chunks for broad overview embedding results', () => {
    const retriever = new HybridRetriever() as any;
    const detailChunk = makeChunk({
      id: 'sandbox-detail',
      parentId: 'sandbox-detail-parent',
      fileName: 'AgentVis 沙箱机制功能文档.md',
      content: 'proxy credential implementation detail',
    });
    const overviewChunk = makeChunk({
      id: 'sandbox-overview',
      parentId: 'sandbox-overview',
      fileName: 'AgentVis 沙箱机制功能文档.md',
      content: '# Document Overview\nTopics:\n- H1 AgentVis sandbox capabilities',
      isDocumentOverview: true,
    });

    const focusedFused = retriever.rrfFusion(
      [
        { chunk: detailChunk, score: 0.61, rank: 1 },
        { chunk: overviewChunk, score: 0.6, rank: 2 },
      ],
      [],
      retriever.getConfig(),
      false
    );
    const broadFused = retriever.rrfFusion(
      [
        { chunk: detailChunk, score: 0.61, rank: 1 },
        { chunk: overviewChunk, score: 0.6, rank: 2 },
      ],
      [],
      retriever.getConfig(),
      true
    );

    expect(focusedFused[0].chunkId).toBe('sandbox-detail');
    expect(broadFused[0].chunkId).toBe('sandbox-overview');
  });

  it('broad overview allocation starts with one chunk per source before backfill', () => {
    const retriever = new HybridRetriever() as any;
    const sandboxPrimary = {
      sourceFile: 'AgentVis 沙箱机制功能文档.md',
      scoredChunks: [
        {
          chunk: makeChunk({
            id: 'sandbox-1',
            parentId: 'sandbox-parent',
            fileName: 'AgentVis 沙箱机制功能文档.md',
            content: 'sandbox proxy detail',
          }),
          score: 0.0302,
        },
        {
          chunk: makeChunk({
            id: 'sandbox-2',
            parentId: 'sandbox-parent',
            fileName: 'AgentVis 沙箱机制功能文档.md',
            content: 'sandbox network detail',
          }),
          score: 0.0159,
        },
        {
          chunk: makeChunk({
            id: 'sandbox-3',
            parentId: 'sandbox-parent',
            fileName: 'AgentVis 沙箱机制功能文档.md',
            content: 'sandbox browser detail',
          }),
          score: 0.0145,
        },
      ],
    };
    const safetySupport = {
      sourceFile: 'AgentVis Agent 行为安全防护机制.md',
      scoredChunks: [
        {
          chunk: makeChunk({
            id: 'safety-1',
            parentId: 'safety-parent',
            fileName: 'AgentVis Agent 行为安全防护机制.md',
            content: 'agent safety overview',
          }),
          score: 0.0164,
        },
      ],
    };
    const featureSupport = {
      sourceFile: 'features_deep_dive.md',
      scoredChunks: [
        {
          chunk: makeChunk({
            id: 'features-1',
            parentId: 'features-parent',
            fileName: 'features_deep_dive.md',
            content: 'AgentVis features overview',
          }),
          score: 0.0163,
        },
      ],
    };

    const results = retriever.selectBalancedParentResults(
      [sandboxPrimary, safetySupport, featureSupport],
      4,
      5,
      true
    );

    expect(results.slice(0, 3).map((result: { chunk: Chunk }) => result.chunk.id)).toEqual([
      'sandbox-1',
      'safety-1',
      'features-1',
    ]);
    expect(results.map((result: { chunk: Chunk }) => result.chunk.id)).toEqual([
      'sandbox-1',
      'safety-1',
      'features-1',
      'sandbox-2',
      'sandbox-3',
    ]);
  });

  it('broad overview query uses a wider parent pool before final source allocation', () => {
    const retriever = new HybridRetriever() as any;
    const aggregated = Array.from({ length: 12 }, (_, index) => ({
      sourceFile: index < 8 ? 'AgentVis 沙箱机制功能文档.md' : `support-${index}.md`,
      scoredChunks: [],
    }));

    expect(retriever.getSelectionPool(aggregated, 5, false)).toHaveLength(5);
    expect(retriever.getSelectionPool(aggregated, 5, true)).toHaveLength(12);
  });

  it('rerank source prioritization keeps the best source ahead of many slightly lower same-source hits', () => {
    const retriever = new HybridRetriever() as any;
    const featureOverview = makeChunk({
      id: 'features-overview',
      parentId: 'features-overview',
      fileName: 'features_deep_dive.md',
      content: '# Document Overview\nTitle: AgentVis core features',
      isDocumentOverview: true,
    });
    const sandboxDns = makeChunk({
      id: 'sandbox-dns',
      parentId: 'sandbox-dns-parent',
      fileName: 'AgentVis sandbox.md',
      content: 'DNS pinning and broker network block details',
    });
    const sandboxBrowser = makeChunk({
      id: 'sandbox-browser',
      parentId: 'sandbox-browser-parent',
      fileName: 'AgentVis sandbox.md',
      content: 'agent-browser controlled runtime details',
    });
    const sandboxGoals = makeChunk({
      id: 'sandbox-goals',
      parentId: 'sandbox-goals-parent',
      fileName: 'AgentVis sandbox.md',
      content: 'sandbox core goals and non-goals',
    });

    const aggregated = retriever.aggregateByParent(
      [
        {
          chunkId: featureOverview.id,
          chunk: featureOverview,
          rrfScore: 0.9972,
          rerankScore: 0.9972,
        },
        {
          chunkId: sandboxDns.id,
          chunk: sandboxDns,
          rrfScore: 0.9611,
          rerankScore: 0.9611,
        },
        {
          chunkId: sandboxBrowser.id,
          chunk: sandboxBrowser,
          rrfScore: 0.9606,
          rerankScore: 0.9606,
        },
        {
          chunkId: sandboxGoals.id,
          chunk: sandboxGoals,
          rrfScore: 0.9426,
          rerankScore: 0.9426,
        },
      ],
      false
    );

    const prioritized = retriever.prioritizeSameSource(aggregated, true);

    expect(prioritized[0].sourceFile).toBe('features_deep_dive.md');
  });

  it('rerank-scale source prioritization does not rely solely on an explicit rerank marker', () => {
    const retriever = new HybridRetriever() as any;
    const featureOverview = makeChunk({
      id: 'features-overview-unmarked',
      parentId: 'features-overview-unmarked',
      fileName: 'features_deep_dive.md',
      content: '# Document Overview\nTitle: AgentVis core features',
      isDocumentOverview: true,
    });
    const sandboxChunks = ['dns', 'browser', 'goals'].map((name, index) =>
      makeChunk({
        id: `sandbox-${name}-unmarked`,
        parentId: `sandbox-${name}-parent`,
        fileName: 'AgentVis sandbox.md',
        content: `${name} sandbox implementation detail`,
        chunkIndex: index,
      })
    );

    const prioritized = retriever.prioritizeSameSource(
      [
        {
          parentChunkId: featureOverview.id,
          sectionPath: '#',
          chunks: [featureOverview],
          scoredChunks: [{ chunk: featureOverview, score: 0.9972 }],
          rawScore: 0.9972,
          bestScore: 0.9972,
          totalScore: 0.9972,
          sourceFile: 'features_deep_dive.md',
        },
        ...sandboxChunks.map((chunk, index) => ({
          parentChunkId: chunk.id,
          sectionPath: '#',
          chunks: [chunk],
          scoredChunks: [{ chunk, score: [0.9611, 0.9436, 0.9609][index] }],
          rawScore: [0.9611, 0.9436, 0.9609][index],
          bestScore: [0.9611, 0.9436, 0.9609][index],
          totalScore: [0.9611, 0.9436, 0.9609][index],
          sourceFile: 'AgentVis sandbox.md',
        })),
      ],
      true
    );

    expect(prioritized[0].sourceFile).toBe('features_deep_dive.md');
  });

  it('broad overview source ordering prefers document overview over close-scoring detail chunks', () => {
    const retriever = new HybridRetriever() as any;
    const detailChunk = makeChunk({
      id: 'sandbox-detail',
      parentId: 'sandbox-detail-parent',
      fileName: 'AgentVis sandbox.md',
      content: 'specific DNS and proxy implementation detail',
    });
    const overviewChunk = makeChunk({
      id: 'sandbox-overview',
      parentId: 'sandbox-overview',
      fileName: 'AgentVis sandbox.md',
      content: '# Document Overview\nTitle: AgentVis sandbox feature boundaries',
      isDocumentOverview: true,
    });

    const aggregated = retriever.aggregateByParent(
      [
        {
          chunkId: detailChunk.id,
          chunk: detailChunk,
          rrfScore: 0.96,
          rerankScore: 0.96,
        },
        {
          chunkId: overviewChunk.id,
          chunk: overviewChunk,
          rrfScore: 0.93,
          rerankScore: 0.93,
        },
      ],
      false
    );

    const prioritized = retriever.prioritizeSameSource(aggregated, true);

    expect(prioritized[0].scoredChunks[0].chunk.id).toBe('sandbox-overview');
  });
});
