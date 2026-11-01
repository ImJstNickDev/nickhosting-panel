import { type Messages, setupI18n } from '@lingui/core';
import { I18nProvider, useLingui } from '@lingui/react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { setRequestLocale } from '../api/client.js';
import { formatBytes } from './format.js';
import messages from './messages.json';

export type Locale = 'en' | 'it' | 'pseudo';
const detectLocale = (): Locale => {
  const saved = localStorage.getItem('nh.locale');
  if (saved === 'en' || saved === 'it' || (import.meta.env.DEV && saved === 'pseudo')) return saved;
  return navigator.language.startsWith('it') ? 'it' : 'en';
};
const i18n = setupI18n({ locale: 'en', messages: messages as unknown as Record<string, Messages> });
const LocaleContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void }>({
  locale: 'en',
  setLocale: () => {},
});
const activate = (value: Locale) => {
  i18n.activate(value);
  document.documentElement.lang = value === 'pseudo' ? 'en' : value;
  setRequestLocale(value === 'pseudo' ? 'en' : value);
};
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, update] = useState(detectLocale);
  useEffect(() => {
    activate(locale);
  }, [locale]);
  const setLocale = useCallback((value: Locale) => {
    if (value !== 'pseudo') localStorage.setItem('nh.locale', value);
    update(value);
  }, []);
  return (
    <LocaleContext.Provider
      value={{
        locale,
        setLocale,
      }}
    >
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    </LocaleContext.Provider>
  );
}
export function useLocale() {
  return useContext(LocaleContext);
}
export function useT() {
  const { i18n: active } = useLingui();
  return (key: string, values?: Record<string, string | number>) =>
    active._(key in (messages.en as Record<string, unknown>) ? key : 'web.unknown', values);
}
export function useFormat() {
  const { locale } = useLocale();
  const tag = locale === 'it' ? 'it-IT' : 'en-GB';
  return {
    number: (value: number, maximumFractionDigits = 1) =>
      new Intl.NumberFormat(tag, { maximumFractionDigits }).format(value),
    date: (value: string | Date) =>
      new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      ),
    bytes: (value: number) => formatBytes(value, tag),
    relative: (value: string | Date) =>
      new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }).format(
        Math.round((new Date(value).getTime() - Date.now()) / 60000),
        'minute',
      ),
  };
}
