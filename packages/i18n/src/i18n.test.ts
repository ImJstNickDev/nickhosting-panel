import { DomainError, domainErrorCodes } from '@nickhosting/core';
import { describe, expect, it } from 'vitest';
import {
  assertCatalogParity,
  CatalogRegistry,
  en,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  it as italian,
  localizeAuthError,
  localizeError,
  renderMail,
  resolveLocale,
  supportedLocales,
  translate,
} from './index.js';

describe('English/Italian foundation catalogs', () => {
  it('covers every domain error and has exact keys and parameter parity', () => {
    expect(() => assertCatalogParity(en, italian)).not.toThrow();
    for (const code of domainErrorCodes)
      for (const locale of supportedLocales) {
        expect(localizeError(new DomainError(code), locale).message).toBeTruthy();
      }
    expect(() => assertCatalogParity({ key: 'Hello {name}' }, { key: 'Ciao' })).toThrow(
      'catalog_placeholder_mismatch',
    );
    expect(() => assertCatalogParity({ key: 'Hello' }, {})).toThrow('catalog_key_mismatch');
  });
  it('detects locales by persisted preference then valid quality-sorted language header', () => {
    expect(resolveLocale('it-IT', 'en;q=1')).toBe('it');
    expect(resolveLocale(undefined, 'fr, en;q=0.5, it-IT;q=0.9')).toBe('it');
    expect(resolveLocale(undefined, 'it;q=0,en;q=0.4')).toBe('en');
    expect(resolveLocale(undefined, 'it;q=9,en;q=0.1')).toBe('en');
    expect(resolveLocale('de', 'fr')).toBe('en');
    expect(translate('de', 'jobs.running')).toBe('Running');
  });
  it('interpolates only named placeholders without evaluating input and enforces missing arguments', () => {
    expect(
      translate('it', 'support.banner', { actor: 'Owner', subject: 'User {actor}' }),
    ).toContain('User {actor}');
    expect(() => translate('en', 'support.banner')).toThrow('translation_parameter_missing');
  });
  it('supports namespaced game catalogs, blocks collisions and validates both locales', () => {
    const registry = new CatalogRegistry();
    registry.register('games.fixture', {
      en: { 'games.fixture.name': 'Fixture' },
      it: { 'games.fixture.name': 'Esempio' },
    });
    expect(registry.translate('it', 'games.fixture.name')).toBe('Esempio');
    expect(registry.translate('de', 'games.fixture.name')).toBe('Fixture');
    expect(() =>
      registry.register('games.fixture', {
        en: { 'games.fixture.name': 'Duplicate' },
        it: { 'games.fixture.name': 'Duplicato' },
      }),
    ).toThrow('invalid_catalog_key');
    expect(() =>
      registry.register('games.fixture', {
        en: { 'games.other.name': 'Wrong namespace' },
        it: { 'games.other.name': 'Namespace errato' },
      }),
    ).toThrow('invalid_catalog_key');
  });
  it('renders every mail kind and localized job status without disclosing raw errors', () => {
    for (const kind of ['verify', 'reset', 'invite', 'link'] as const)
      for (const locale of supportedLocales) {
        const mail = renderMail({
          kind,
          locale,
          url: 'https://example.com/action?token=synthetic',
          instanceName: 'Fixture',
        });
        expect(mail.subject).toContain('Fixture');
        expect(mail.text).toContain('https://example.com/action?token=synthetic');
        expect(mail.text).not.toContain('{url}');
      }
    expect(() =>
      renderMail({ kind: 'verify', url: 'javascript:alert(1)', instanceName: 'Fixture' }),
    ).toThrow();
    expect(() =>
      renderMail({
        kind: 'verify',
        url: 'https://example.com',
        instanceName: 'Fixture\r\nBcc: other@example.com',
      }),
    ).toThrow();
    expect(localizeAuthError('UNKNOWN_PROVIDER_CODE', 'it').message).toBe(
      italian['errors.internal_error'],
    );
    expect(localizeAuthError('INVALID_EMAIL_OR_PASSWORD', 'it').message).toBe(
      italian['auth.invalid_credentials'],
    );
    expect(localizeError(new Error('private upstream response'), 'it').message).not.toContain(
      'private',
    );
    expect(translate('it', 'jobs.succeeded')).toBe('Completato');
  });
  it('uses Intl with locale formatting and supports long interpolation values', () => {
    expect(formatNumber(12345.5, 'it')).toBe('12.345,5');
    expect(formatNumber(12345.5, 'en')).toBe('12,345.5');
    expect(formatRelativeTime(-1, 'day', 'it')).toBe('ieri');
    expect(
      formatDateTime(new Date('2026-01-01T00:00:00Z'), 'it', { timeZone: 'UTC', year: 'numeric' }),
    ).toBe('2026');
    expect(
      translate('it', 'support.banner', { actor: 'A'.repeat(250), subject: 'S'.repeat(250) }),
    ).toContain('S'.repeat(250));
  });
});
