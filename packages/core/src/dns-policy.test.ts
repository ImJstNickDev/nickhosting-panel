import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import {
  dnsNameWords,
  resolveDnsDomains,
  resolveDnsOptions,
  validateDnsLabel,
} from './dns-policy.js';

const connection = {
  mode: 'custom-subdomain',
  srv: { service: '_minecraft', proto: 'tcp' },
} as const;
const domains = [
  { id: 'first', hostname: 'example.test', zoneId: 'a'.repeat(32), enabled: true },
  { id: 'second', hostname: 'games.example.net', zoneId: 'b'.repeat(32), enabled: true },
  { id: 'disabled', hostname: 'old.example.org', zoneId: 'c'.repeat(32), enabled: false },
];
const base = {
  dnsDomains: domains,
  dnsTarget: '192.0.2.1',
  dnsInstanceId: '8ed937a8-5d44-4495-a568-5b7140324dfa',
};
describe('game DNS policy', () => {
  it('uses existing single-zone settings without inventing domains or credentials', () => {
    const absent = resolveConfig().values;
    expect(resolveDnsOptions(absent, connection, 'minecraft').configured).toBe(false);
    expect(resolveDnsDomains(absent, connection, 'minecraft')).toEqual([]);
    const legacy = resolveConfig({
      dnsBaseDomain: 'Example.test',
      cloudflareZoneId: 'a'.repeat(32),
      dnsTarget: '192.0.2.1',
    }).values;
    expect(resolveDnsDomains(legacy, connection, 'minecraft')).toEqual([
      {
        id: 'legacy',
        hostname: 'example.test',
        zoneId: 'a'.repeat(32),
        target: '192.0.2.1',
        enabled: true,
      },
    ]);
    expect(legacy.dnsBlockedTerms).toEqual([]);
  });
  it('filters domains and chooses eligible game, platform or first defaults', () => {
    const config = resolveConfig({
      ...base,
      dnsDefaultDomainId: 'first',
      dnsGamePolicies: {
        minecraft: { selection: 'deny', domainIds: ['first'], defaultDomainId: 'disabled' },
      },
    }).values;
    const options = resolveDnsOptions(config, connection, 'minecraft');
    expect(options.domains).toEqual([{ id: 'second', hostname: 'games.example.net' }]);
    expect(options.defaultDomainId).toBe('second');
    expect(options.supportsSrv).toBe(true);
    expect(options.configured).toBe(true);
    expect(
      resolveDnsOptions(
        resolveConfig({
          ...base,
          dnsGamePolicies: { minecraft: { selection: 'allow', domainIds: [] } },
        }).values,
        connection,
        'minecraft',
      ).configured,
    ).toBe(false);
    expect(
      resolveDnsOptions(
        resolveConfig({
          ...base,
          dnsGamePolicies: {
            minecraft: { selection: 'all', domainIds: [], defaultDomainId: 'second' },
          },
        }).values,
        connection,
        'minecraft',
      ).defaultDomainId,
    ).toBe('second');
  });
  it('offers only domains with a resolved target and skips incomplete defaults', () => {
    const config = resolveConfig({
      dnsInstanceId: base.dnsInstanceId,
      dnsDefaultDomainId: 'first',
      dnsDomains: [domains[0], { ...domains[1], target: '192.0.2.2' }],
    }).values;
    expect(resolveDnsDomains(config, connection, 'minecraft').map((d) => d.id)).toEqual(['second']);
    expect(resolveDnsOptions(config, connection, 'minecraft')).toMatchObject({
      defaultDomainId: 'second',
      configured: true,
    });
  });
  it('supports shared fixed and customizable hostnames separately from SRV', () => {
    const config = resolveConfig({
      ...base,
      dnsGamePolicies: { fixture: { selection: 'all', domainIds: [], sharedLabel: 'sandbox' } },
    }).values;
    for (const allowCustomSubdomain of [false, true]) {
      const options = resolveDnsOptions(
        config,
        { mode: 'shared-host', defaultLabel: 'fixture', allowCustomSubdomain },
        'fixture',
      );
      expect(options.defaultHostname).toBe('sandbox.example.test');
      expect(options.customizable).toBe(allowCustomSubdomain);
      expect(options.supportsSrv).toBe(false);
    }
    const staticConfig = resolveConfig({ staticGameHostname: 'static.example.test' }).values;
    expect(
      resolveDnsOptions(
        staticConfig,
        { mode: 'static-host-port', hostnameSettingKey: 'staticGameHostname' },
        'fixture',
      ),
    ).toMatchObject({
      configured: true,
      customizable: false,
      defaultHostname: 'static.example.test',
    });
  });
  it('applies case-insensitive exact, word and substring bans without seeding an Owner list', () => {
    const config = resolveConfig({
      dnsBlockedTerms: [
        { value: 'Reserved', match: 'exact' },
        { value: 'bad-word', match: 'word' },
        { value: 'spam', match: 'substring' },
      ],
    }).values;
    for (const value of [
      'reserved',
      'BAD-WORD',
      'cute-bad-word-cat',
      'cuteSPAMcat',
      'www',
      'bad.name',
      'xn--fake',
      '-bad',
      'bad-',
      'a'.repeat(64),
    ])
      expect(() => validateDnsLabel(value, config)).toThrow();
    expect(validateDnsLabel(' Cute-Panda-Bag ', config)).toBe('cute-panda-bag');
    expect(validateDnsLabel('reserved-cat', config)).toBe('reserved-cat');
    expect(validateDnsLabel('bad-wording', config)).toBe('bad-wording');
  });
  it('offers over 200,000 generated candidates and rejects duplicate domain identities', () => {
    expect(new Set(dnsNameWords).size).toBe(dnsNameWords.length);
    expect(dnsNameWords.length ** 3).toBeGreaterThanOrEqual(200000);
    for (const word of dnsNameWords)
      expect(validateDnsLabel(`${word}-${word}-${word}`, { dnsBlockedTerms: [] })).toBe(
        `${word}-${word}-${word}`,
      );
    for (const dnsDomains of [
      [domains[0], domains[0]],
      [domains[0], { ...domains[1], hostname: 'example.test' }],
    ])
      expect(() => resolveConfig({ dnsDomains })).toThrow();
    expect(() =>
      resolveConfig({ dnsDomains: [{ ...domains[0], target: 'https://example.test' }] }),
    ).toThrow();
  });
  it('keeps typed environment precedence for lists and quarantine', () => {
    const config = resolveConfig(
      { dnsBlockedTerms: [] },
      {
        NH_DNS_BLOCKED_TERMS: JSON.stringify([{ value: 'blocked', match: 'exact' }]),
        NH_DNS_NAME_REUSE_DELAY_SECONDS: '60',
      },
    );
    expect(config.values.dnsNameReuseDelaySeconds).toBe(60);
    expect(config.sources.dnsBlockedTerms).toBe('environment');
    expect(config.lockedKeys).toContain('dnsBlockedTerms');
    expect(() => validateDnsLabel('blocked', config.values)).toThrow();
    expect(() => resolveConfig({}, { NH_DNS_NAME_REUSE_DELAY_SECONDS: '-1' })).toThrow();
  });
});
