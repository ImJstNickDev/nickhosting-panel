import { describe, expect, it } from 'vitest';
import { compareMinecraftChoices, minecraftReleaseCatalog } from './catalog.js';

describe('Minecraft catalog ordering', () => {
  it('sorts ordinary releases newest first numerically with deterministic ties', () => {
    const choices = ['1.9', '1.21.11', '26.1', '1.20.5'].map((version) => ({
      version,
      releaseType: 'release' as const,
      runtime: 'vanilla',
      id: version,
    }));
    expect(choices.sort(compareMinecraftChoices).map((choice) => choice.version)).toEqual([
      '26.1',
      '1.21.11',
      '1.20.5',
      '1.9',
    ]);
  });
  it('uses official release timestamps for discovery, filters historical entries and does not infer server availability', async () => {
    const versions = [
      { id: '1.21.11', type: 'release', releaseTime: '2025-12-01T00:00:00Z' },
      { id: '26.1-snapshot-1', type: 'snapshot', releaseTime: '2026-01-01T00:00:00Z' },
      { id: '26.1', type: 'release', releaseTime: '2026-03-01T00:00:00Z' },
    ].map((entry) => ({
      ...entry,
      url: 'https://piston-meta.mojang.com/v1/packages/fixture.json',
      sha1: 'a'.repeat(40),
    }));
    const client = {
      read: async (url: string) => ({
        bytes: Buffer.from(JSON.stringify({ versions })),
        evidence: { url, sha256: 'b'.repeat(64), retrievedAt: new Date().toISOString() },
      }),
    };
    expect((await minecraftReleaseCatalog(client)).map((item) => item.id)).toEqual([
      '26.1',
      '1.21.11',
    ]);
    expect((await minecraftReleaseCatalog(client, true)).map((item) => item.id)).toEqual([
      '26.1',
      '26.1-snapshot-1',
      '1.21.11',
    ]);
  });
});
