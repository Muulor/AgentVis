import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  armProjectPreviewReadyTimeout,
  classifyProjectPreviewDiagnostic,
  clearProjectPreviewHandshakeTimeout,
  getPreviewErrorPresentation,
  getTrustedProjectPreviewMessage,
  parseProjectPreviewMessage,
  renderProjectContent,
  sendProjectPreviewPing,
} from '../LivePreviewPanel';
import {
  PreviewServiceError,
  createPreviewInstallError,
  parsePreviewError,
  type PreviewErrorCode,
} from '@services/preview/previewErrors';
import { translate } from '@/i18n';

const STRUCTURED_ERROR_SUMMARIES: Array<readonly [Exclude<PreviewErrorCode, 'cancelled'>, string]> =
  [
    ['missing-dependencies', '项目缺少可解析的依赖，请补充或修正 package.json 后重试'],
    ['invalid-package', '项目的 package.json 无效，请修正后重试'],
    ['ambiguous-entry', '检测到多个 HTML 入口，无法安全确定项目首页'],
    ['entry-not-found', '未找到可运行的项目入口，请进入正确的项目目录或使用文件实时预览'],
    ['nested-project', '当前目录包含嵌套项目，请进入对应项目目录后重新预览'],
    ['unsupported-project', '该项目使用了 Project Preview 尚未支持的构建或依赖契约'],
    ['unsafe-path', '项目包含不安全的文件路径，预览已阻止'],
    ['node-missing', '未找到可用的 Node.js 运行环境'],
    [
      'install-failed',
      '项目依赖安装失败；预览安装会禁用生命周期脚本，依赖原生二进制或安装期代码生成的包可能无法运行',
    ],
    ['install-auth-failed', '依赖安装认证失败，请检查私有 Registry 或 npm 凭据'],
    ['install-network-failed', '依赖安装网络失败，请检查网络、代理、证书或 Registry 状态'],
    ['server-start-failed', '预览服务启动失败'],
    ['compile-failed', '项目入口编译失败'],
    ['process-exited', '预览服务进程已意外退出'],
    ['retry-unavailable', '没有可重试的项目预览，请从文件列表重新启动'],
    ['asset-budget-exceeded', '项目资源超出安全预览限制'],
  ];

const READY_MESSAGE = {
  namespace: 'agentvis:preview',
  type: 'ready',
};

describe('LivePreviewPanel diagnostic bridge', () => {
  it('does not report a handshake timeout after trusted booting while window.load stays slow', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      let bridgeConnected = false;
      const iframeWindow = {} as MessageEventSource;
      const timeout = armProjectPreviewReadyTimeout(null, () => bridgeConnected, onTimeout, 8_000);

      vi.advanceTimersByTime(1_000);
      expect(onTimeout).not.toHaveBeenCalled();

      const booting = getTrustedProjectPreviewMessage(
        {
          source: iframeWindow,
          origin: 'http://localhost:3100',
          data: { namespace: 'agentvis:preview', type: 'booting' },
        },
        iframeWindow,
        'http://localhost:3100/'
      );
      expect(booting).toEqual({ type: 'booting', message: null });
      bridgeConnected = booting !== null;

      vi.advanceTimersByTime(30_000);
      expect(onTimeout).not.toHaveBeenCalled();

      clearTimeout(timeout);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a stale handshake warning when ready arrives late without hiding runtime errors', () => {
    expect(parseProjectPreviewMessage(READY_MESSAGE)?.type).toBe('ready');
    expect(
      clearProjectPreviewHandshakeTimeout({ kind: 'handshake-timeout', message: null })
    ).toBeNull();
    expect(
      clearProjectPreviewHandshakeTimeout({ kind: 'runtime-error', message: 'module failed' })
    ).toEqual({ kind: 'runtime-error', message: 'module failed' });
  });

  it('accepts only the supported namespaced message types', () => {
    expect(parseProjectPreviewMessage(READY_MESSAGE)).toEqual({ type: 'ready', message: null });
    expect(parseProjectPreviewMessage({ namespace: 'agentvis:preview', type: 'booting' })).toEqual({
      type: 'booting',
      message: null,
    });
    expect(
      parseProjectPreviewMessage({
        namespace: 'agentvis:preview',
        type: 'runtime-error',
        detail: '  module failed  ',
      })
    ).toEqual({ type: 'runtime-error', message: 'module failed' });
    expect(
      parseProjectPreviewMessage({ namespace: 'another:namespace', type: 'ready' })
    ).toBeNull();
    expect(
      parseProjectPreviewMessage({ namespace: 'agentvis:preview', type: 'unknown-event' })
    ).toBeNull();
  });

  it('bounds diagnostic text received from an untrusted page', () => {
    const parsed = parseProjectPreviewMessage({
      namespace: 'agentvis:preview',
      type: 'resource-error',
      message: 'x'.repeat(10_000),
    });

    expect(parsed?.message).toHaveLength(2_000);
  });

  it('classifies embedded-browser, cross-origin, and remote resource diagnostics', () => {
    expect(
      classifyProjectPreviewDiagnostic('runtime-error', 'WebGPU is not available in this WebView')
    ).toBe('browser-capability');
    expect(classifyProjectPreviewDiagnostic('resource-error', 'Blocked by CORS policy')).toBe(
      'cross-origin'
    );
    expect(
      classifyProjectPreviewDiagnostic('resource-error', 'https://cdn.example/model.glb')
    ).toBe('external-resource');
    expect(classifyProjectPreviewDiagnostic('runtime-error', 'ordinary app failure')).toBeNull();
  });

  it('distinguishes dependency authentication and network failures', () => {
    expect(createPreviewInstallError('npm ERR! code E401').code).toBe('install-auth-failed');
    expect(createPreviewInstallError('npm ERR! code ENOTFOUND registry.npmjs.org').code).toBe(
      'install-network-failed'
    );
    expect(createPreviewInstallError('npm ERR! code ETARGET').code).toBe('install-failed');
  });

  it('rejects unknown structured error codes at the UI boundary', () => {
    expect(parsePreviewError('AGENTVIS_PREVIEW_ERROR:{"code":"future-unknown-code"}')).toBeNull();
  });

  it('localizes structured service errors and bounds their raw detail', () => {
    const presentation = getPreviewErrorPresentation(
      new PreviewServiceError('compile-failed', 'x'.repeat(5_000)).message,
      translate
    );

    expect(presentation.summary).toBe('项目入口编译失败');
    expect(presentation.detail).toHaveLength(600);
    expect(presentation.cancelled).toBe(false);
    expect(
      getPreviewErrorPresentation(new PreviewServiceError('cancelled').message, translate)
    ).toEqual({ summary: null, detail: null, cancelled: true });
  });

  it.each(STRUCTURED_ERROR_SUMMARIES)('maps %s to localized user copy', (code, summary) => {
    expect(getPreviewErrorPresentation(new PreviewServiceError(code).message, translate)).toEqual({
      summary,
      detail: null,
      cancelled: false,
    });
  });

  it('turns safety and budget reason codes into bounded actionable details', () => {
    expect(
      getPreviewErrorPresentation(
        new PreviewServiceError('unsafe-path', 'file-hard-link:C:\\outside.jpeg').message,
        translate
      ).detail
    ).toContain('越界硬链接');
    expect(
      getPreviewErrorPresentation(
        new PreviewServiceError('asset-budget-exceeded', 'source-file-count').message,
        translate
      ).detail
    ).toBe('预览最多读取 500 个源文件。');
  });

  it('preserves the primary failure while explaining omitted environment files', () => {
    const error = new PreviewServiceError('compile-failed', 'missing API URL', undefined, [
      { code: 'environment-files-omitted', count: 2 },
    ]);
    const presentation = getPreviewErrorPresentation(error.message, translate);

    expect(presentation.summary).toBe('项目入口编译失败');
    expect(presentation.detail).toContain('missing API URL');
    expect(presentation.detail).toContain('检测到 2 个 .env 环境文件');
  });

  it('requires both the current iframe source and exact managed origin', () => {
    const iframeWindow = {} as MessageEventSource;
    const trustedEvent = {
      source: iframeWindow,
      origin: 'http://localhost:3100',
      data: READY_MESSAGE,
    };

    expect(
      getTrustedProjectPreviewMessage(trustedEvent, iframeWindow, 'http://localhost:3100/')
    ).toEqual({ type: 'ready', message: null });
    expect(
      getTrustedProjectPreviewMessage(
        { ...trustedEvent, source: {} as MessageEventSource },
        iframeWindow,
        'http://localhost:3100/'
      )
    ).toBeNull();
    expect(
      getTrustedProjectPreviewMessage(
        { ...trustedEvent, origin: 'http://localhost:3101' },
        iframeWindow,
        'http://localhost:3100/'
      )
    ).toBeNull();
    expect(
      getTrustedProjectPreviewMessage(trustedEvent, iframeWindow, 'https://localhost:3100/')
    ).toBeNull();
  });

  it('sends bridge pings only to the exact managed iframe origin', () => {
    const postMessage = vi.fn();

    expect(sendProjectPreviewPing({ postMessage }, 'http://localhost:3100/nested/preview')).toBe(
      true
    );
    expect(postMessage).toHaveBeenCalledWith(
      { namespace: 'agentvis:preview', type: 'ping' },
      'http://localhost:3100'
    );

    postMessage.mockClear();
    expect(sendProjectPreviewPing({ postMessage }, 'https://localhost:3100/')).toBe(false);
    expect(sendProjectPreviewPing({ postMessage }, 'http://localhost:8080/')).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('does not ping the inherited host origin while the iframe is still about:blank', () => {
    const postMessage = vi.fn();

    expect(
      sendProjectPreviewPing(
        { postMessage, location: { href: 'about:blank' } },
        'http://localhost:3100/'
      )
    ).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('fails closed for every retry surface when the preview request is unavailable', () => {
    const commonOptions = {
      error: { summary: 'failed', detail: null, cancelled: false },
      refreshKey: 0,
      isResizing: false,
      frameLoadState: 'ready' as const,
      isRetrying: false,
      onLoad: vi.fn(),
      onRetry: vi.fn(),
      t: translate,
      iframeRef: vi.fn(),
    };
    const retrySurfaces = [
      { status: 'error', url: null, diagnostic: null },
      { status: 'running', url: 'https://localhost:3100', diagnostic: null },
      {
        status: 'running',
        url: 'http://localhost:3100',
        diagnostic: { kind: 'runtime-error', message: 'boom' },
      },
    ] as const;

    for (const surface of retrySurfaces) {
      const unavailableHtml = renderToStaticMarkup(
        renderProjectContent({ ...commonOptions, ...surface, canRetry: false })
      );
      expect(unavailableHtml).toContain('请从文件列表重新启动');
      expect(unavailableHtml).not.toContain('<button');

      const retryableHtml = renderToStaticMarkup(
        renderProjectContent({ ...commonOptions, ...surface, canRetry: true })
      );
      expect(retryableHtml).toContain('<button');
      expect(retryableHtml).not.toContain('请从文件列表重新启动');
    }
  });
});
