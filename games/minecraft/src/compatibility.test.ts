import { describe, expect, it } from 'vitest';
import {
  assertMinecraftChoice,
  type MinecraftCombination,
  type MinecraftEvidence,
  minecraftDeclaredCapabilities,
  minecraftDigest,
  minecraftSupport,
  minecraftVerificationChecks,
  publicMinecraftChoice,
} from './compatibility.js';

const combination: MinecraftCombination = {
  release: '26.3',
  releaseType: 'release',
  protocolId: 777,
  family: 'netty',
  profile: 'paper',
  javaMajor: 25,
  runtimeDigest: 'a'.repeat(64),
  protocolSource: { url: 'https://example.com/metadata', sha256: 'b'.repeat(64) },
};
const checks = Object.fromEntries(
  minecraftVerificationChecks.map((name) => [name, true]),
) as MinecraftEvidence['checks'];
const evidence: MinecraftEvidence = {
  runId: '10000000-0000-4000-8000-000000000001',
  kind: 'real-server',
  combinationDigest: minecraftDigest(combination),
  choiceDigest: '9'.repeat(64),
  mappingDigest: 'c'.repeat(64),
  recordedAt: '2026-10-09T12:00:00Z',
  evidenceSha256: 'd'.repeat(64),
  checks,
  server: {
    uuid: '10000000-0000-4000-8000-000000000002',
    externalId: 'nh-test',
    artifactSha256: 'e'.repeat(64),
    imageDigest: `sha256:${'f'.repeat(64)}`,
    javaMajor: 25,
  },
  client: { implementation: 'minecraft-protocol', version: '1.68.0', protocolId: 777 },
};
const now = new Date('2026-10-09T13:00:00Z');
describe('Minecraft compatibility evidence', () => {
  it('real installation bootstrap enables only explicit private testing and cannot claim verification', () => {
    const bootstrap: MinecraftEvidence = {
      ...evidence,
      kind: 'installation-bootstrap',
      checks: {
        ...(Object.fromEntries(
          minecraftVerificationChecks.map((key) => [key, false]),
        ) as MinecraftEvidence['checks']),
        installation: true,
        status: true,
        readiness: true,
      },
    };
    expect(
      minecraftSupport(
        combination,
        evidence.mappingDigest,
        evidence.choiceDigest,
        [bootstrap],
        now,
      ),
    ).toBe('experimental');
    const input = {
      combination,
      enabled: true,
      mappingDigest: evidence.mappingDigest,
      choiceDigest: evidence.choiceDigest,
      evidence: [bootstrap],
      privateTester: false,
    };
    expect(() => assertMinecraftChoice(input, now)).toThrow('integration_unavailable');
    expect(() => assertMinecraftChoice({ ...input, privateTester: true }, now)).not.toThrow();
    const failed = {
      ...evidence,
      recordedAt: '2026-10-09T12:01:00Z',
      checks: { ...checks, wakeAdmission: false },
    };
    expect(
      minecraftSupport(
        combination,
        evidence.mappingDigest,
        evidence.choiceDigest,
        [bootstrap, failed],
        now,
      ),
    ).toBe('unverified');
    expect(
      minecraftSupport(
        combination,
        evidence.mappingDigest,
        evidence.choiceDigest,
        [{ ...bootstrap, server: undefined }],
        now,
      ),
    ).toBe('unverified');
  });
  it('a newer failure removes verification until a newer complete revalidation, with ties closed', () => {
    const older = { ...evidence, recordedAt: '2026-10-08T12:00:00Z' };
    const failed = { ...evidence, checks: { ...checks, playerIdle: false } };
    expect(
      minecraftSupport(
        combination,
        evidence.mappingDigest,
        evidence.choiceDigest,
        [older, failed],
        now,
      ),
    ).toBe('unverified');
    const revalidated = { ...evidence, recordedAt: '2026-10-09T12:30:00Z' };
    expect(
      minecraftSupport(
        combination,
        evidence.mappingDigest,
        evidence.choiceDigest,
        [older, failed, revalidated],
        now,
      ),
    ).toBe('verified');
    expect(
      minecraftSupport(
        combination,
        evidence.mappingDigest,
        evidence.choiceDigest,
        [evidence, failed],
        now,
      ),
    ).toBe('unverified');
  });
  it('separates Owner availability from actual whole-flow evidence', () => {
    expect(() =>
      assertMinecraftChoice(
        {
          combination,
          enabled: true,
          mappingDigest: evidence.mappingDigest,
          choiceDigest: evidence.choiceDigest,
          evidence: [],
          privateTester: false,
        },
        now,
      ),
    ).toThrow();
    expect(
      minecraftSupport(combination, evidence.mappingDigest, evidence.choiceDigest, [evidence], now),
    ).toBe('verified');
    expect(() =>
      assertMinecraftChoice(
        {
          combination,
          enabled: false,
          mappingDigest: evidence.mappingDigest,
          choiceDigest: evidence.choiceDigest,
          evidence: [evidence],
          privateTester: false,
        },
        now,
      ),
    ).toThrow();
  });
  it('cannot turn fixtures, stale evidence, a wrong JVM/client or mapping into verified support', () => {
    if (!evidence.server || !evidence.client) throw new Error('Expected complete fixture evidence');
    for (const report of [
      { ...evidence, kind: 'protocol-fixture' as const },
      { ...evidence, server: undefined },
      { ...evidence, server: { ...evidence.server, javaMajor: 21 } },
      { ...evidence, client: { ...evidence.client, protocolId: 774 } },
      { ...evidence, checks: { ...checks, gracefulSave: false } },
    ])
      expect(
        minecraftSupport(combination, evidence.mappingDigest, evidence.choiceDigest, [report], now),
      ).not.toBe('verified');
    expect(
      minecraftSupport(combination, '0'.repeat(64), evidence.choiceDigest, [evidence], now),
    ).toBe('unverified');
    expect(
      minecraftSupport(
        combination,
        evidence.mappingDigest,
        evidence.choiceDigest,
        [evidence],
        new Date('2027-10-09'),
      ),
    ).toBe('unverified');
  });
  it('allows fixtures only for explicit private testers, without publishing matrix details', () => {
    const fixture = { ...evidence, kind: 'protocol-fixture' as const };
    const input = {
      combination,
      enabled: true,
      mappingDigest: evidence.mappingDigest,
      choiceDigest: evidence.choiceDigest,
      evidence: [fixture],
      privateTester: false,
    };
    expect(() => assertMinecraftChoice(input, now)).toThrow();
    expect(() => assertMinecraftChoice({ ...input, privateTester: true }, now)).not.toThrow();
    expect(publicMinecraftChoice('choice', combination)).toEqual({
      id: 'choice',
      runtime: 'paper',
      capabilities: minecraftDeclaredCapabilities(combination),
      version: '26.3',
      releaseType: 'release',
    });
  });
  it('never guesses unknown or pre-Netty compatibility', () => {
    expect(
      minecraftSupport(
        { ...combination, family: 'legacy' },
        evidence.mappingDigest,
        evidence.choiceDigest,
        [evidence],
        now,
      ),
    ).toBe('unsupported');
    expect(
      minecraftSupport(
        { ...combination, protocolId: null },
        evidence.mappingDigest,
        evidence.choiceDigest,
        [evidence],
        now,
      ),
    ).toBe('unsupported');
  });
});

describe('compiled Vanilla capabilities', () => {
  it('allows installable Vanilla independently of signed reports while preserving Owner availability', () => {
    for (const version of [
      { release: '1.6.4', family: 'legacy', protocolId: 78, releaseType: 'release' },
      { release: '26.3', family: 'unknown', protocolId: null, releaseType: 'release' },
      { release: '25w03a', family: 'netty', protocolId: 1073742084, releaseType: 'snapshot' },
    ] as const) {
      const selected = { ...combination, ...version, profile: 'vanilla' as const };
      expect(minecraftDeclaredCapabilities(selected)).toEqual({
        installation: true,
        directConnection: true,
        playerManagement: version.release === '26.3',
        gateway: false,
        readiness: false,
        playerIdle: false,
        sleepWake: false,
      });
      const input = {
        combination: selected,
        enabled: true,
        mappingDigest: 'a'.repeat(64),
        choiceDigest: 'b'.repeat(64),
        evidence: [],
        privateTester: false,
      };
      expect(() => assertMinecraftChoice(input, now)).not.toThrow();
      expect(() => assertMinecraftChoice({ ...input, enabled: false }, now)).toThrow();
    }
  });
  it('separates modern player-file management from direct installation', () => {
    for (const [release, expected] of [
      ['1.7.5', false],
      ['1.7.6', true],
      ['1.20.4', true],
    ] as const) {
      expect(
        minecraftDeclaredCapabilities({ ...combination, profile: 'vanilla', release })
          .playerManagement,
      ).toBe(expected);
    }
  });
  it('declares Gateway only for exact real-server-covered Vanilla pairs', () => {
    expect(
      minecraftDeclaredCapabilities({
        ...combination,
        profile: 'vanilla',
        release: '1.21.4',
        protocolId: 769,
      }).gateway,
    ).toBe(false);
    for (const [release, protocolId] of [['26.1', 775]] as const) {
      const selected = { ...combination, profile: 'vanilla' as const, release, protocolId };
      expect(minecraftDeclaredCapabilities(selected).sleepWake).toBe(true);
      expect(minecraftDeclaredCapabilities({ ...selected, protocolId: 999 }).gateway).toBe(false);
      expect(minecraftDeclaredCapabilities({ ...selected, releaseType: 'snapshot' }).gateway).toBe(
        false,
      );
      expect(minecraftDeclaredCapabilities({ ...selected, profile: 'paper' }).installation).toBe(
        false,
      );
    }
  });
});
