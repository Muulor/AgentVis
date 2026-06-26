/**
 * DocumentChunker chunkPlainText 超长段落切分验证
 */
import { describe, it, expect } from 'vitest';
import { createDocumentChunker } from '@services/rag/DocumentChunker';

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

        // 每个 chunk 不应超过 chunkSize * 2 = 1000 字符
        for (const chunk of chunks) {
            expect(chunk.content.length).toBeLessThanOrEqual(1200);
        }
    });

    it('正常文本（有空行）分块不受影响', () => {
        const normalText = Array.from({ length: 10 }, (_, i) =>
            `这是第 ${i + 1} 段。` + 'A'.repeat(200)
        ).join('\n\n');

        const chunks = chunker.chunk(normalText, 'agent-1', 'doc-2', {});
        expect(chunks.length).toBeGreaterThan(1);
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
        const laterSection = [
            '#### 孤儿进程清理',
            '',
            '首次启动 Vite 项目预览时执行懒初始化。',
        ].join('\n');
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

        const visualChild = result.childChunks.find(chunk =>
            chunk.content.includes('VisualEnhancerService')
        );

        expect(visualChild).toBeDefined();
        expect(visualChild?.metadata.sectionPath).toContain('### 1.1 功能定位');
        expect(visualChild?.content).toContain('可视化');
        expect(result.childChunks[0]?.content).toContain('1.1 功能定位');
    });
});
