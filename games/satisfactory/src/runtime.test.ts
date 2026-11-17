import { resolveConfig, resolveDnsOptions } from '@nickhosting/core';
import { expect, it } from 'vitest';
import { satisfactoryManifest } from './manifest.js';
import {
  buildSatisfactoryPlan,
  satisfactoryEggEnvironment,
  satisfactoryPortArguments,
} from './runtime.js';

it('declares both game transports and a distinct reliable port', () => {
  expect(satisfactoryManifest.ports).toEqual([
    { role: 'game', transport: 'both', required: true },
    { role: 'reliable', transport: 'tcp', required: true },
  ]);
  expect(buildSatisfactoryPlan({}, 'public').configuration).toEqual({
    branch: 'public',
    autoUpdate: true,
  });
});
it('binds explicit allocated ports and advertised reliable port without shell interpolation', () => {
  expect(satisfactoryPortArguments({ game: 7777, reliable: 8888, externalReliable: 9999 })).toEqual(
    ['-Port=7777', '-ReliablePort=8888', '-ExternalReliablePort=9999'],
  );
  expect(
    satisfactoryEggEnvironment({}, { game: 7777, reliable: 8888, externalReliable: 9999 })
      .EXTERNAL_RELIABLE_PORT,
  ).toBe('9999');
  expect(() =>
    satisfactoryPortArguments({ game: 7777, reliable: 7777, externalReliable: 9999 }),
  ).toThrow();
  expect(() => buildSatisfactoryPlan({ branch: '$(bad)' }, 'public')).toThrow();
});

it('matches the installed SteamCMD egg branch and container contracts', () => {
  expect(
    satisfactoryEggEnvironment(
      { branch: 'experimental' },
      { game: 7777, reliable: 8888, externalReliable: 8888 },
    ),
  ).toMatchObject({ SRCDS_BETAID: 'experimental', SRCDS_APPID: '1690800' });
  expect(
    satisfactoryEggEnvironment({}, { game: 7777, reliable: 8888, externalReliable: 8888 })
      .SRCDS_BETAID,
  ).toBe('');
  expect(satisfactoryManifest.runtimes[0]?.imagePolicy).toEqual({
    mode: 'fixed',
    image: 'ghcr.io/ptero-eggs/steamcmd:debian',
  });
});

it('declares implemented readiness and graceful stop for automatic gateway provisioning', () => {
  expect(satisfactoryManifest.capabilities).toMatchObject({
    readiness: true,
    gracefulStop: true,
    wake: 'manual',
  });
});

it('resolves a fixed shared hostname from Owner domains without SRV or custom labels', () => {
  expect(satisfactoryManifest.connection).toEqual({
    mode: 'shared-host',
    defaultLabel: 'satisfactory',
    allowCustomSubdomain: false,
  });
  const options = resolveDnsOptions(
    resolveConfig({
      dnsBaseDomain: 'example.test',
      cloudflareZoneId: 'a'.repeat(32),
      dnsTarget: '192.0.2.1',
      dnsInstanceId: '8ed937a8-5d44-4495-a568-5b7140324dfa',
    }).values,
    satisfactoryManifest.connection,
    satisfactoryManifest.id,
  );
  expect(options).toMatchObject({
    configured: true,
    customizable: false,
    supportsSrv: false,
    defaultHostname: 'satisfactory.example.test',
  });
});
