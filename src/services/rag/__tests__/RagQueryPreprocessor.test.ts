import { describe, expect, it } from 'vitest';
import {
    buildBm25IndexText,
    buildEmbeddingIndexText,
    preprocessRagQuery,
} from '../RagQueryPreprocessor';

describe('RagQueryPreprocessor', () => {
    it('为 BM25 提取文件名和代码符号', () => {
        const result = preprocessRagQuery('看一下 HybridRetriever.ts 里 finalTopK 的映射');

        expect(result.bm25Query).toContain('HybridRetriever.ts');
        expect(result.bm25Query).toContain('HybridRetriever');
        expect(result.bm25Query).toContain('hybrid');
        expect(result.bm25Query).toContain('retriever');
        expect(result.bm25Query).toContain('finalTopK');
        expect(result.bm25Query).toContain('final');
        expect(result.bm25Query).toContain('top');
        expect(result.extractedTerms).not.toContain('ts');
    });

    it('多行 query 会生成 BM25 片段', () => {
        const result = preprocessRagQuery([
            'RagService.ts 的 topK 怎么传给 finalTopK？',
            '顺便看一下 HybridRetriever 的 RRF 排序日志',
        ].join('\n'));

        expect(result.fragments.length).toBe(2);
        expect(result.fragments[0]!).toContain('RagService.ts');
        expect(result.fragments[1]!).toContain('HybridRetriever');
    });

    it('品牌词 AgentVis 不拆成泛化弱词', () => {
        const result = preprocessRagQuery('AgentVis 有什么特性功能');

        expect(result.extractedTerms).toContain('AgentVis');
        expect(result.extractedTerms).not.toContain('agent');
        expect(result.extractedTerms).not.toContain('vis');
        expect(result.isFocusedQuery).toBe(false);
    });

    it('broad overview query adds feature aliases without repeating the brand term', () => {
        const result = preprocessRagQuery('AgentVis 有什么特性');

        expect(result.isBroadOverviewQuery).toBe(true);
        expect(result.bm25Query.match(/AgentVis/g)).toHaveLength(1);
        expect(result.bm25Query).toContain('features');
        expect(result.bm25Query).toContain('核心特性');
        expect(result.bm25Query).toContain('功能定位');
    });

    it('filename query containing features is not treated as a broad overview query', () => {
        const result = preprocessRagQuery('features_deep_dive.md 里面讲了什么');

        expect(result.isBroadOverviewQuery).toBe(false);
        expect(result.bm25Query).toContain('features_deep_dive.md');
        expect(result.bm25Query).toContain('features');
        expect(result.bm25Query).toContain('deep');
        expect(result.bm25Query).toContain('dive');
    });

    it('阅读类聚焦问题会补充章节别名', () => {
        const result = preprocessRagQuery('夜航西飞这本书的译者读后感是什么');

        expect(result.isFocusedQuery).toBe(true);
        expect(result.bm25Query).toContain('译者后记');
        expect(result.bm25Query).toContain('后记');
    });

    it('English reading-focused questions add alias terms', () => {
        const result = preprocessRagQuery('What does the translator reflection say in West with the Night?');

        expect(result.isFocusedQuery).toBe(true);
        expect(result.bm25Query).toContain('translator note');
        expect(result.bm25Query).toContain('afterword');
    });

    it('BM25 索引文本包含元数据但保留原文内容', () => {
        const text = buildBm25IndexText({
            fileName: 'RagService.ts',
            filePath: 'src/services/rag/RagService.ts',
            sectionPath: '# RAG > ## Retrieval',
            heading: 'Retrieval',
            content: '真正注入 LLM 的 chunk 内容',
        });

        expect(text).toContain('RagService.ts');
        expect(text).toContain('RagService');
        expect(text).toContain('src/services/rag/RagService.ts');
        expect(text).toContain('# RAG > ## Retrieval');
        expect(text).toContain('真正注入 LLM 的 chunk 内容');
    });
    it('embedding index text uses compact metadata without full path noise', () => {
        const text = buildEmbeddingIndexText({
            fileName: 'features_deep_dive.md',
            filePath: 'D:\\AgentVis\\docs\\AgentVis docs\\features_deep_dive.md',
            sectionPath: '# AgentVis > ## Core Features',
            heading: 'Core Features',
            content: 'raw child content',
        });

        expect(text).toContain('Document: features_deep_dive.md');
        expect(text).toContain('features_deep_dive');
        expect(text).toContain('features');
        expect(text).toContain('\u7279\u6027');
        expect(text).toContain('Section: # AgentVis > ## Core Features');
        expect(text).toContain('Heading: Core Features');
        expect(text).toContain('raw child content');
        expect(text).not.toContain('D:\\AgentVis');
    });
});
