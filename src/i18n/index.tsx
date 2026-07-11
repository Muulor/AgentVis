import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { enUS } from './locales/en-US';
import { zhCN, type TranslationResource } from './locales/zh-CN';

export type Language = 'zh-CN' | 'en-US';

// eslint-disable-next-line react-refresh/only-export-components
export const SUPPORTED_LANGUAGES: { code: Language; label: string }[] = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en-US', label: 'English' },
];

const STORAGE_KEY = 'agentvis-language';

const resources: Record<Language, TranslationResource> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

type NestedKeys<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends Record<string, unknown>
      ? `${K}.${NestedKeys<T[K]>}`
      : never;
}[keyof T & string];

export type TranslationKey = NestedKeys<typeof zhCN>;

export type TranslationParams = Record<string, string | number | boolean | null | undefined>;

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey, params?: TranslationParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function isLanguage(value: string | null): value is Language {
  return value === 'zh-CN' || value === 'en-US';
}

function getInitialLanguage(): Language {
  if (typeof window === 'undefined') return 'zh-CN';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return isLanguage(saved) ? saved : 'zh-CN';
}

// eslint-disable-next-line react-refresh/only-export-components
export function getCurrentLanguage(): Language {
  return getInitialLanguage();
}

function applyDocumentLanguage(language: Language) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.documentElement.dataset.locale = language;
}

function getTranslationValue(
  resource: TranslationResource,
  key: TranslationKey
): string | undefined {
  const value = key.split('.').reduce<unknown>((current, part) => {
    if (current && typeof current === 'object' && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, resource);

  return typeof value === 'string' ? value : undefined;
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) => {
    const value = params[name];
    return value === null || value === undefined ? match : String(value);
  });
}

// eslint-disable-next-line react-refresh/only-export-components
export function translate(
  key: TranslationKey,
  params?: TranslationParams,
  language: Language = getCurrentLanguage()
): string {
  const translated =
    getTranslationValue(resources[language], key) ?? getTranslationValue(zhCN, key) ?? key;
  return interpolate(translated, params);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage);

  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  const setLanguage = useCallback((nextLanguage: Language) => {
    setLanguageState(nextLanguage);
    window.localStorage.setItem(STORAGE_KEY, nextLanguage);
    applyDocumentLanguage(nextLanguage);
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) => translate(key, params, language),
    [language]
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage,
      t,
    }),
    [language, setLanguage, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
