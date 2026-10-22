import { glob, readFile } from 'node:fs/promises';
import { type Messages, setupI18n } from '@lingui/core';
import { expect, it } from 'vitest';
import { platformConfigSchema } from '../../../../packages/core/src/config.js';
import { formatBytes } from './format.js';
import messages from './messages.json';

it('ships matching complete catalogs and labels for every configurable setting', () => {
  expect(Object.keys(messages.it).sort()).toEqual(Object.keys(messages.en).sort());
  expect(Object.keys(messages.pseudo).sort()).toEqual(Object.keys(messages.en).sort());
  const keys = new Set(Object.keys(messages.en));
  // These settings use dedicated sleep controls instead of generic Owner fields.
  const dedicatedLabels: Record<string, string> = {
    defaultIdleTimeoutSeconds: 'sleepTiming.timeout',
    idleTimeoutUserAccess: 'sleepTiming.userAccess',
    gameIdleTimeouts: 'sleepTiming.game',
    dnsDomains: 'connection.domains',
    dnsDefaultDomainId: 'connection.defaultDomain',
    dnsGamePolicies: 'connection.domainPolicy',
    dnsBlockedTerms: 'connection.term',
    dnsNameReuseDelaySeconds: 'connection.reuseDelay',
    gameContentPolicies: 'integrationConfig.modAlternatives',
    gameAutoWakePolicies: 'automation.autoWake',
    defaultAutoWakeEnabled: 'automation.autoWake',
    autoWakeUserAccess: 'automation.wakeAccess',
  };
  for (const key of Object.keys(platformConfigSchema.shape))
    expect(keys.has(dedicatedLabels[key] ?? `owner.config.${key}`), key).toBe(true);
});
it('renders actual plurals in English/Italian and expands pseudolocale', () => {
  const i18n = setupI18n({
    locale: 'en',
    messages: messages as unknown as Record<string, Messages>,
  });
  expect(i18n._('owner.reconcileSummary', { count: 1 })).toBe('1 server checked');
  expect(i18n._('owner.reconcileSummary', { count: 2 })).toBe('2 servers checked');
  i18n.activate('it');
  expect(i18n._('owner.reconcileSummary', { count: 1 })).toBe('1 server controllato');
  expect(i18n._('owner.reconcileSummary', { count: 2 })).toBe('2 server controllati');
  i18n.activate('pseudo');
  expect(i18n._('web.settings')).toContain('［');
});
it('does not silently omit literal application translation keys', async () => {
  const keys = new Set(Object.keys(messages.en));
  const missing: string[] = [];
  for await (const file of glob('apps/web/src/**/*.tsx')) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\bt\(['"]([^'"]+)['"]/g))
      if (!keys.has(match[1]!)) missing.push(`${file}:${match[1]}`);
  }
  expect(missing).toEqual([]);
});

it('shows small nonempty files accurately with localized binary units', () => {
  expect(formatBytes(0, 'en-GB')).toBe('0 B');
  expect(formatBytes(42, 'en-GB')).toBe('42 B');
  expect(formatBytes(1536, 'it-IT')).toBe('1,5 KiB');
  expect(formatBytes(12 * 1024 ** 2, 'en-GB')).toBe('12 MiB');
  expect(formatBytes(3 * 1024 ** 3, 'en-GB')).toBe('3 GiB');
});
