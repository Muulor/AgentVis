import { describe, expect, it } from 'vitest';
import { enUS } from '@/i18n/locales/en-US';
import { zhCN } from '@/i18n/locales/zh-CN';

describe('CloudServiceSettings i18n', () => {
  it('defines mode-aware RAG connection labels in supported locales', () => {
    expect(zhCN.settings.cloud.ragConnectionTitle).toBe('RAG 模型连接');
    expect(zhCN.settings.cloud.ragUseSiliconflow).toContain('SiliconFlow');
    expect(zhCN.settings.cloud.rerankerModel).toBe('Reranker 模型');
    expect(zhCN.settings.cloud.ragPrivacyHint).toContain('API Key');
    expect(zhCN.settings.cloud.ragConfirmChangeDesc).toContain('BM25');
    expect(zhCN.settings.cloud.ragRebuildUnsavedHint).toContain('已生效');
    expect(zhCN.settings.cloud.ragRebuildBusyHint).toContain('请稍候');
    expect(zhCN.settings.cloud.ragProtocolGemini).toBe('Google Gemini Embeddings');
    expect(zhCN.settings.cloud.ragGeminiPrivacyWarning).toContain('人工审核');
    expect(zhCN.settings.cloud.ragGeminiPrivacyWarning).toContain('中国大陆');
    expect(zhCN.settings.cloud.ragGeminiApiKey).toBe('Google API Key');
    expect(zhCN.settings.cloud.ragGeminiRegionsLink).toContain('支持地区');

    expect(enUS.settings.cloud.ragConnectionTitle).toBe('RAG model connections');
    expect(enUS.settings.cloud.ragUseSiliconflow).toContain('SiliconFlow');
    expect(enUS.settings.cloud.rerankerModel).toBe('Reranker Model');
    expect(enUS.settings.cloud.ragPrivacyHint).toContain('API keys');
    expect(enUS.settings.cloud.ragConfirmChangeDesc).toContain('BM25');
    expect(enUS.settings.cloud.ragRebuildUnsavedHint).toContain('active');
    expect(enUS.settings.cloud.ragRebuildBusyHint).toContain('Please wait');
    expect(enUS.settings.cloud.ragProtocolGemini).toBe('Google Gemini Embeddings');
    expect(enUS.settings.cloud.ragGeminiPrivacyWarning).toContain('reviewed by humans');
    expect(enUS.settings.cloud.ragGeminiPrivacyWarning).toContain('Mainland China');
    expect(enUS.settings.cloud.ragGeminiApiKey).toBe('Google API Key');
    expect(enUS.settings.cloud.ragGeminiRegionsLink).toContain('supported regions');
  });

  it('does not advertise the removed Gitee fallback', () => {
    expect('giteeaiDesc' in zhCN.settings.cloud).toBe(false);
    expect('giteeaiDesc' in enUS.settings.cloud).toBe(false);
  });
});
