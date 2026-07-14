/**
 * RendererErrorBoundary - Renderer 级错误隔离与恢复界面
 *
 * 防止未捕获的 React 渲染异常卸载整个界面，并在主 UI 不可用时保留重载与退出能力。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getLogger } from '@services/logger';
import { translate, type Language, type TranslationKey } from '@/i18n';
import { isDynamicModuleLoadError } from './rendererRecovery';
import styles from './RendererErrorBoundary.module.css';

let boundaryLogger: ReturnType<typeof getLogger> | undefined;

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);

  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

function getBoundaryLogger(): ReturnType<typeof getLogger> {
  boundaryLogger ??= getLogger('RendererErrorBoundary');
  return boundaryLogger;
}

function resetKeysChanged(
  previousKeys: readonly unknown[] | undefined,
  nextKeys: readonly unknown[] | undefined
): boolean {
  if (previousKeys === nextKeys) return false;
  if (!previousKeys || previousKeys.length !== nextKeys?.length) return true;
  return previousKeys.some((value, index) => !Object.is(value, nextKeys[index]));
}

function resolveDocumentLanguage(): Language {
  if (typeof document !== 'undefined' && document.documentElement.lang === 'en-US') {
    return 'en-US';
  }
  return 'zh-CN';
}

export interface RecoveryFallbackProps {
  error: Error;
  resetErrorBoundary: () => void;
}

interface RecoveryErrorBoundaryProps {
  children: ReactNode;
  context: string;
  renderFallback: (props: RecoveryFallbackProps) => ReactNode;
  resetKeys?: readonly unknown[];
}

interface RecoveryErrorBoundaryState {
  error: Error | null;
}

/** 可复用的 React 错误边界，支持由 reset key 或显式操作恢复子树。 */
export class RecoveryErrorBoundary extends Component<
  RecoveryErrorBoundaryProps,
  RecoveryErrorBoundaryState
> {
  override state: RecoveryErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RecoveryErrorBoundaryState {
    return { error: normalizeError(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    getBoundaryLogger().error('[RendererErrorBoundary] React subtree failed', {
      context: this.props.context,
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  override componentDidUpdate(previousProps: RecoveryErrorBoundaryProps): void {
    if (this.state.error && resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  private readonly resetErrorBoundary = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error) {
      return this.props.renderFallback({
        error: this.state.error,
        resetErrorBoundary: this.resetErrorBoundary,
      });
    }

    return this.props.children;
  }
}

interface RendererCrashFallbackProps {
  error: Error;
  language?: Language;
}

/** 根界面崩溃后的最小静态 UI；刻意不依赖 App 内的 Provider 或状态。 */
export function RendererCrashFallback({ error, language }: RendererCrashFallbackProps) {
  const activeLanguage = language ?? resolveDocumentLanguage();
  const t = (key: TranslationKey): string => translate(key, undefined, activeLanguage);
  const descriptionKey = isDynamicModuleLoadError(error)
    ? 'rendererRecovery.dynamicModuleDescription'
    : 'rendererRecovery.description';

  const handleClose = (): void => {
    void getCurrentWindow()
      .destroy()
      .catch(() => {
        window.close();
      });
  };

  return (
    <main className={styles.page} role="alert" aria-live="assertive">
      <section className={styles.card}>
        <div className={styles.statusMark} aria-hidden="true">
          !
        </div>
        <p className={styles.eyebrow}>AgentVis Renderer</p>
        <h1 className={styles.title}>{t('rendererRecovery.title')}</h1>
        <p className={styles.description}>{t(descriptionKey)}</p>

        <div className={styles.actions}>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={() => window.location.reload()}
          >
            {t('rendererRecovery.reload')}
          </button>
          <button className={styles.secondaryButton} type="button" onClick={handleClose}>
            {t('rendererRecovery.closeApp')}
          </button>
        </div>

        <details className={styles.details}>
          <summary>{t('rendererRecovery.errorDetails')}</summary>
          <code>{error.message}</code>
        </details>
      </section>
    </main>
  );
}

/** 包裹整个 renderer 的最后一道 React 错误边界。 */
export function RendererErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <RecoveryErrorBoundary
      context="renderer-root"
      renderFallback={({ error }) => <RendererCrashFallback error={error} />}
    >
      {children}
    </RecoveryErrorBoundary>
  );
}
