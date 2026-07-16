/**
 * DocumentChunker 分块硬上限与层级分块验证
 */
import { describe, it, expect } from 'vitest';
import { createDocumentChunker } from '@services/rag/DocumentChunker';

function expectChunksWithinLimit(chunks: Array<{ content: string }>, limit: number): void {
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk.content.length).toBeLessThanOrEqual(limit);

    const firstCodeUnit = chunk.content.charCodeAt(0);
    const lastCodeUnit = chunk.content.charCodeAt(chunk.content.length - 1);
    expect(firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff).toBe(false);
    expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
  }
}

describe('chunkPlainText 超长段落切分', () => {
  const chunker = createDocumentChunker({ chunkSize: 500, minChunkSize: 100 });

  it('无空行的 JSON 文件应被按行切分为多个 chunk', () => {
    // 模拟 muji_data.json 类型的无空行 JSON 文件
    const lines: string[] = ['{'];
    for (let i = 0; i < 300; i++) {
      lines.push(`  "key_${i}": "value_${i}_${'x'.repeat(20)}",`);
    }
    lines.push('}');
    const jsonContent = lines.join('\n');

    // 10000+ 字符的内容不应生成单个 chunk
    expect(jsonContent.length).toBeGreaterThan(10000);

    const chunks = chunker.chunk(jsonContent, 'agent-1', 'doc-1', {});

    // 应该生成多个 chunk
    expect(chunks.length).toBeGreaterThan(1);

    expectChunksWithinLimit(chunks, 500);
  });

  it('正常文本（有空行）分块不受影响', () => {
    const normalText = Array.from(
      { length: 10 },
      (_, i) => `这是第 ${i + 1} 段。` + 'A'.repeat(200)
    ).join('\n\n');

    const chunks = chunker.chunk(normalText, 'agent-1', 'doc-2', {});
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('无标点超长单行及 emoji 应按硬上限切分并保留头尾', () => {
    const hardLimit = 128;
    const unicodeChunker = createDocumentChunker({ chunkSize: hardLimit, minChunkSize: 20 });
    const content = `TEXT_HEAD_${'连续中文🚀'.repeat(600)}_TEXT_TAIL`;

    const chunks = unicodeChunker.chunk(content, 'agent-1', 'doc-unicode', {
      documentType: 'text',
    });

    expectChunksWithinLimit(chunks, hardLimit);
    expect(chunks.some((chunk) => chunk.content.includes('TEXT_HEAD'))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes('TEXT_TAIL'))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes('🚀'))).toBe(true);
  });
});

describe('chunkCode 超大语义块硬上限', () => {
  const hardLimit = 256;
  const chunker = createDocumentChunker({ chunkSize: hardLimit, minChunkSize: 40 });
  const codeBody = Array.from(
    { length: 240 },
    (_, index) => `  const value${index} = '代码内容${index}🚀${'x'.repeat(36)}';`
  ).join('\n');

  it.each([
    {
      name: 'class',
      content: `// CLASS_HEAD_MARKER 🚀\nexport class HugeService {\n${codeBody}\n}\n// CLASS_TAIL_MARKER 🧭`,
      head: 'CLASS_HEAD_MARKER',
      tail: 'CLASS_TAIL_MARKER',
    },
    {
      name: 'function',
      content: `// FUNCTION_HEAD_MARKER 🚀\nexport async function hugeFunction() {\n${codeBody}\n}\n// FUNCTION_TAIL_MARKER 🧭`,
      head: 'FUNCTION_HEAD_MARKER',
      tail: 'FUNCTION_TAIL_MARKER',
    },
  ])('超大 $name 应保留语义头尾且每块不超过 chunkSize', ({ content, head, tail }) => {
    expect(content.length).toBeGreaterThan(10_000);

    const chunks = chunker.chunk(content, 'agent-code', `doc-${head}`, {
      documentType: 'code',
    });

    expectChunksWithinLimit(chunks, hardLimit);
    expect(chunks.some((chunk) => chunk.content.includes(head))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes(tail))).toBe(true);
  });
});

describe('chunkMarkdownHierarchy 混合换行分块', () => {
  const chunker = createDocumentChunker({ chunkSize: 500, minChunkSize: 100 });

  it('混合 CRLF/LF 的 Markdown 应识别前半段标题并生成 child', () => {
    const visualSection = [
      '### 1.1 功能定位',
      '',
      '`VisualEnhancerService` 是 Planning 模式的后处理增强层。',
      '当 Master Brain 给出纯文本响应后，该服务判断内容是否适合可视化。',
      '若适合则驱动 LLM 将其转化为包含 ECharts 图表、Mermaid 流程图、Widget 交互组件的富媒体版本。',
      '',
      '设计原则：增强失败时无声降级，绝不影响主流程的响应输出。',
    ].join('\r\n');
    const laterSection = ['#### 孤儿进程清理', '', '首次启动 Vite 项目预览时执行懒初始化。'].join(
      '\n'
    );
    const content = [
      '# AgentVis 四大核心特性深度技术解析',
      '',
      '## 一、交互可视化增强（Visual Enhancer）',
      '',
      visualSection,
      '',
      laterSection,
    ].join('\r\n');

    const result = chunker.chunkWithHierarchy(content, 'agent-1', 'doc-markdown', {
      documentType: 'markdown',
      fileName: 'features_deep_dive.md',
    });

    const visualChild = result.childChunks.find((chunk) =>
      chunk.content.includes('VisualEnhancerService')
    );

    expect(visualChild).toBeDefined();
    expect(visualChild?.metadata.sectionPath).toContain('### 1.1 功能定位');
    expect(visualChild?.content).toContain('可视化');
    expect(result.childChunks[0]?.content).toContain('1.1 功能定位');
  });

  it('无标点长句仅切分 child，完整 parent 保留层级语义', () => {
    const hardLimit = 180;
    const hierarchyChunker = createDocumentChunker({
      chunkSize: hardLimit,
      minChunkSize: 40,
    });
    const longSection = `MARKDOWN_HEAD_${'章节内容🧭'.repeat(500)}_MARKDOWN_TAIL`;
    const content = `## 超长章节\n${longSection}`;

    const result = hierarchyChunker.chunkWithHierarchy(
      content,
      'agent-markdown',
      'doc-long-markdown',
      { documentType: 'markdown' }
    );

    expect(result.parentChunks).toHaveLength(1);
    expect(result.parentChunks[0]?.content.length).toBeGreaterThan(hardLimit);
    expectChunksWithinLimit(result.childChunks, hardLimit);
    expect(result.childChunks.some((chunk) => chunk.content.includes('MARKDOWN_HEAD'))).toBe(true);
    expect(result.childChunks.some((chunk) => chunk.content.includes('MARKDOWN_TAIL'))).toBe(true);
    expect(
      result.chunks
        .filter((chunk) => !chunk.metadata.isParent)
        .every((chunk) => chunk.content.length <= hardLimit)
    ).toBe(true);
  });
});
