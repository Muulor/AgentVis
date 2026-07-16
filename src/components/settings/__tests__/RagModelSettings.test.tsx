import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { ToastProvider } from '@components/ui/Toast';
import {
  DEFAULT_CUSTOM_RERANKER_CONFIG,
  DEFAULT_GEMINI_EMBEDDING_CONFIG,
  useSettingsStore,
} from '@stores/settingsStore';
import {
  createEmbeddingConfigForProtocol,
  getEmbeddingFailureHintKey,
  isRagCredentialActionLocked,
  RagIndexRebuildButton,
  RagModelSettings,
  selectEmbeddingProtocolDraft,
  shouldApplyRagTestResult,
  startRagApplyAfterConfirmation,
} from '../RagModelSettings';

vi.mock('@components/ui/Tooltip', () => ({
  Tooltip: ({ children, content }: { children: ReactNode; content?: ReactNode }) => (
    <span data-tooltip={content ?? ''}>{children}</span>
  ),
}));

function renderRebuildButton(
  overrides: Partial<Parameters<typeof RagIndexRebuildButton>[0]> = {}
): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <RagIndexRebuildButton
        applying={false}
        hasUnsavedChanges={false}
        activeEmbeddingReady
        needsRetry={false}
        onRebuild={() => undefined}
        {...overrides}
      />
    </I18nProvider>
  );
}

describe('RagIndexRebuildButton', () => {
  it('stays visible but disabled while a custom-mode draft has unsaved changes', () => {
    const html = renderRebuildButton({ hasUnsavedChanges: true });

    expect(html).toContain('检查并重建索引');
    expect(html).toContain('disabled=""');
    expect(html).toContain('索引重建只使用已生效的 Embedding 配置');
    expect(html).not.toContain('title=');
  });

  it('explains missing active Embedding configuration or credentials', () => {
    const html = renderRebuildButton({ activeEmbeddingReady: false });

    expect(html).toContain('disabled=""');
    expect(html).toContain('请先补全当前 Embedding 连接与凭据');
  });

  it('uses the busy hint while applying and enables only a ready unchanged profile', () => {
    const busyHtml = renderRebuildButton({ applying: true, hasUnsavedChanges: true });
    const readyHtml = renderRebuildButton();

    expect(busyHtml).toContain('正在应用配置或重建索引');
    expect(busyHtml).toContain('disabled=""');
    expect(readyHtml).not.toContain('disabled=""');
  });

  it('keeps the retry label without changing the active-profile guard', () => {
    const html = renderRebuildButton({ needsRetry: true, hasUnsavedChanges: true });

    expect(html).toContain('重试索引重建');
    expect(html).toContain('disabled=""');
  });
});

describe('RAG apply confirmation', () => {
  it('dismisses the confirmation before starting the background apply and rebuild', () => {
    const calls: string[] = [];

    startRagApplyAfterConfirmation(
      () => calls.push('close'),
      () => calls.push('start')
    );

    expect(calls).toEqual(['close', 'start']);
  });
});

describe('Gemini Embedding protocol defaults', () => {
  it('renders fixed Gemini controls, a dedicated key field, and the privacy disclosure', () => {
    const serverState = useSettingsStore.getInitialState();
    const previousState = {
      ragServiceMode: serverState.ragServiceMode,
      customEmbeddingConfig: serverState.customEmbeddingConfig,
      customRerankerConfig: serverState.customRerankerConfig,
    };
    Object.assign(serverState, {
      ragServiceMode: 'custom',
      customEmbeddingConfig: DEFAULT_GEMINI_EMBEDDING_CONFIG,
      customRerankerConfig: DEFAULT_CUSTOM_RERANKER_CONFIG,
    });

    try {
      const html = renderToStaticMarkup(
        <I18nProvider>
          <ToastProvider>
            <RagModelSettings />
          </ToastProvider>
        </I18nProvider>
      );

      expect(html).toContain('https://generativelanguage.googleapis.com/v1beta');
      expect(html).toContain('Google API Key');
      expect(html).toContain('人工审核');
      expect(html).toContain('查看支持地区');
      expect(html).toContain('readonly=""');
      expect(html).not.toContain('Bearer API Key');
    } finally {
      Object.assign(serverState, previousState);
    }
  });

  it('uses the fixed Google endpoint, native API-key auth, stable default model and 768 dimensions', () => {
    const config = createEmbeddingConfigForProtocol('gemini');

    expect(config).toEqual({
      providerName: 'Google Gemini',
      protocol: 'gemini',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelId: 'gemini-embedding-2',
      authMode: 'google_api_key',
      outputDimension: 768,
    });
  });

  it('keeps OpenAI Embeddings as a separate configurable protocol', () => {
    expect(createEmbeddingConfigForProtocol('openai')).toEqual({
      providerName: '',
      protocol: 'openai',
      endpointUrl: '',
      modelId: '',
      authMode: 'bearer',
    });
  });

  it('restores each protocol draft when switching back and forth', () => {
    const openAiDraft = {
      ...createEmbeddingConfigForProtocol('openai'),
      providerName: 'Existing provider',
      endpointUrl: 'https://example.com/v1/embeddings',
      modelId: 'existing-model',
    };
    const geminiDraft = {
      ...createEmbeddingConfigForProtocol('gemini'),
      modelId: 'gemini-embedding-001' as const,
      outputDimension: 1536 as const,
    };

    expect(selectEmbeddingProtocolDraft('gemini', openAiDraft, geminiDraft)).toBe(geminiDraft);
    expect(selectEmbeddingProtocolDraft('openai', openAiDraft, geminiDraft)).toBe(openAiDraft);
  });
});

describe('RAG connection-test concurrency guards', () => {
  it('rejects a response after its route or credential generation is invalidated', () => {
    expect(shouldApplyRagTestResult(4, 4)).toBe(true);
    expect(shouldApplyRagTestResult(4, 5)).toBe(false);
  });

  it('locks only the credential actions owned by the running test', () => {
    expect(isRagCredentialActionLocked('embedding', 'testing', 'idle')).toBe(true);
    expect(isRagCredentialActionLocked('gemini_embedding', 'testing', 'idle')).toBe(true);
    expect(isRagCredentialActionLocked('reranker', 'testing', 'idle')).toBe(false);

    expect(isRagCredentialActionLocked('embedding', 'idle', 'testing')).toBe(false);
    expect(isRagCredentialActionLocked('reranker', 'idle', 'testing')).toBe(true);
    expect(isRagCredentialActionLocked('siliconflow', 'testing', 'testing')).toBe(true);
  });
});

describe('Embedding failure guidance', () => {
  it('recognizes provider-neutral rate limits through rebuild and activation causes', () => {
    const providerError = new Error('Google Gemini Embedding API returned HTTP 429');
    const rebuildError = new Error('RAG_INDEX_REBUILD_FAILED', { cause: providerError });
    const activationError = new Error('RAG_ACTIVATION_REBUILD_FAILED', { cause: rebuildError });

    expect(getEmbeddingFailureHintKey(activationError, 'rebuild')).toBe(
      'settings.cloud.ragEmbeddingRateLimitRebuildHint'
    );
    expect(
      getEmbeddingFailureHintKey(
        new Error('Custom RAG Embedding API returned HTTP 429'),
        'connection'
      )
    ).toBe('settings.cloud.ragEmbeddingRateLimitConnectionHint');
    expect(getEmbeddingFailureHintKey(new Error('RAG_INDEX_REBUILD_FAILED'), 'rebuild')).toBeNull();
  });
});
