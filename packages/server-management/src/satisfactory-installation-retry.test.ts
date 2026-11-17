import { resolveConfig } from '@nickhosting/core';
import { describe, expect, it } from 'vitest';
import { satisfactoryInstallerRetryable } from './satisfactory-installation-retry.js';

const started = new Date('2026-11-05T00:00:00Z');
const message = "ERROR! Failed to install app '1690800' (Missing configuration)";
describe('Satisfactory installer retry policy', () => {
  it('defaults to two retries and respects DB and environment precedence', () => {
    expect(resolveConfig({}).values.satisfactoryInstallationRetries).toBe(2);
    expect(
      resolveConfig({ satisfactoryInstallationRetries: 0 }).values.satisfactoryInstallationRetries,
    ).toBe(0);
    const config = resolveConfig(
      { satisfactoryInstallationRetries: 1 },
      { NH_SATISFACTORY_INSTALLATION_RETRIES: '3' },
    );
    expect(config.values.satisfactoryInstallationRetries).toBe(3);
    expect(config.lockedKeys).toContain('satisfactoryInstallationRetries');
  });
  it('requires exact application, known failure and current attempt', () => {
    const log = (text: string, at = started.toISOString()) => [{ text, at }];
    expect(satisfactoryInstallerRetryable(log(message), started)).toBe(true);
    for (const text of [
      'No space left on device',
      'Missing configuration',
      message.replace('1690800', '123'),
      message.replace('Missing configuration', 'No subscription'),
    ])
      expect(satisfactoryInstallerRetryable(log(text), started)).toBe(false);
    expect(satisfactoryInstallerRetryable(log(message, '2026-11-04T23:59:59Z'), started)).toBe(
      false,
    );
    expect(satisfactoryInstallerRetryable(log(message), null)).toBe(false);
  });
});
