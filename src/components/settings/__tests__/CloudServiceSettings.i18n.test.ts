import { describe, expect, it } from 'vitest';
import { enUS } from '@/i18n/locales/en-US';
import { zhCN } from '@/i18n/locales/zh-CN';

describe('CloudServiceSettings i18n', () => {
    it('defines SiliconFlow embedding and reranker labels in supported locales', () => {
        expect(zhCN.settings.cloud.siliconflowTitle).toBe('SiliconFlow (Embedding + Reranker)');
        expect(zhCN.settings.cloud.rerankerModel).toBe('Reranker 模型');
        expect(zhCN.settings.cloud.siliconflowDesc).toContain('{embeddingModel}');
        expect(zhCN.settings.cloud.siliconflowDesc).toContain('{rerankerModel}');

        expect(enUS.settings.cloud.siliconflowTitle).toBe('SiliconFlow (Embedding + Reranker)');
        expect(enUS.settings.cloud.rerankerModel).toBe('Reranker Model');
        expect(enUS.settings.cloud.siliconflowDesc).toContain('{embeddingModel}');
        expect(enUS.settings.cloud.siliconflowDesc).toContain('{rerankerModel}');
    });
});
