import { type Messages, setupI18n } from '@lingui/core';
import { I18nProvider, useLingui } from '@lingui/react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { setRequestLocale } from '../api/client.js';
import { formatBytes } from './format.js';
import bootstrap from './messages/bootstrap.json';
import englishUrl from './messages/en.json?url';
import italianUrl from './messages/it.json?url';
import pseudoUrl from './messages/pseudo.json?url';

export type Locale = 'en' | 'it' | 'pseudo';
const detectLocale = (): Locale => {
  const saved = localStorage.getItem('nh.locale');
  if (saved === 'en' || saved === 'it' || (import.meta.env.DEV && saved === 'pseudo')) return saved;
  return navigator.language.startsWith('it') ? 'it' : 'en';
};
const catalogs = { en: englishUrl, it: italianUrl, pseudo: pseudoUrl };
const loaded = new Map<Locale, Promise<Messages>>();
function loadCatalog(locale: Locale) {
  const cached = loaded.get(locale);
  if (cached) return cached;
  const request = fetch(catalogs[locale], {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
    .then(async (response): Promise<Messages> => {
      if (!response.ok) throw new Error('locale_unavailable');
      return response.json();
    })
    .catch((error: unknown) => {
      loaded.delete(locale);
      throw error;
    });
  loaded.set(locale, request);
  return request;
}
const LocaleContext = createContext<{
  locale: Locale;
  requestedLocale: Locale;
  setLocale: (locale: Locale) => void;
}>({
  locale: 'en',
  requestedLocale: 'en',
  setLocale: () => {},
});
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [i18n] = useState(() => setupI18n());
  const [selection, request] = useState(() => ({ locale: detectLocale() }));
  const [active, setActive] = useState<Locale>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const requested = selection.locale;
    let current = true;
    setFailed(false);
    void loadCatalog(requested).then(
      (messages) => {
        if (!current) return;
        const language = requested === 'pseudo' ? 'en' : requested;
        document.documentElement.lang = language;
        setRequestLocale(language);
        i18n.loadAndActivate({ locale: requested, messages });
        setActive(requested);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [selection, i18n]);
  const setLocale = useCallback((value: Locale) => {
    if (value !== 'pseudo') localStorage.setItem('nh.locale', value);
    request({ locale: value });
  }, []);
  const requested = selection.locale;
  const copy = bootstrap[requested === 'pseudo' ? 'en' : requested];
  return (
    <>
      {failed && (
        <div role="alert" className="notice error">
          <p>{copy.failed}</p>
          <button type="button" onClick={() => request({ locale: requested })}>
            {copy.retry}
          </button>
        </div>
      )}
      {active ? (
        <LocaleContext.Provider value={{ locale: active, requestedLocale: requested, setLocale }}>
          <I18nProvider i18n={i18n}>{children}</I18nProvider>
        </LocaleContext.Provider>
      ) : (
        !failed && (
          <p role="status" className="muted">
            {copy.loading}
          </p>
        )
      )}
    </>
  );
}
export function useLocale() {
  return useContext(LocaleContext);
}
export function useT() {
  const { i18n: active } = useLingui();
  return (key: string, values?: Record<string, string | number>) =>
    active._(Object.hasOwn(active.messages, key) ? key : 'web.unknown', values);
}
function localeFormats(tag: string) {
  const numbers = new Map<number, Intl.NumberFormat>();
  const date = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' });
  const relative = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  const number = (value: number, maximumFractionDigits = 1) => {
    let formatter = numbers.get(maximumFractionDigits);
    if (!formatter) {
      formatter = new Intl.NumberFormat(tag, { maximumFractionDigits });
      numbers.set(maximumFractionDigits, formatter);
    }
    return formatter.format(value);
  };
  return {
    number,
    date: (value: string | Date) => date.format(new Date(value)),
    bytes: (value: number) => formatBytes(value, tag, number),
    relative: (value: string | Date) =>
      relative.format(Math.round((new Date(value).getTime() - Date.now()) / 60000), 'minute'),
  };
}
const formats = { en: localeFormats('en-GB'), it: localeFormats('it-IT') };
export function useFormat() {
  const { i18n: active } = useLingui();
  return active.locale === 'it' ? formats.it : formats.en;
}
