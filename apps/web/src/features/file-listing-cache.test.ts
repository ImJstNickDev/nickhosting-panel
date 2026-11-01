import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFileListing, readFileListing, writeFileListing } from './file-listing-cache.js';
import type { ServerFile } from './service-contracts.js';

const scope = ['owner', 'subject', 'regular'] as const;
const file: ServerFile = {
  name: 'server.properties',
  mode: '-rw-r--r--',
  mode_bits: '644',
  size: 120,
  is_file: true,
  is_symlink: false,
  mimetype: 'text/plain',
  created_at: '2026-10-01T00:00:00Z',
  modified_at: '2026-10-12T00:00:00Z',
};
let values: Map<string, string>;
let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
  vi.stubGlobal('sessionStorage', storage);
});
afterEach(() => vi.unstubAllGlobals());

function stored(): [string, string] {
  const entry = [...values.entries()][0];
  if (!entry) throw new Error('Expected a saved listing');
  return entry;
}

describe('tab-local file listing snapshots', () => {
  it('round-trips metadata and empty directories, replacing the previous folder snapshot', () => {
    expect(readFileListing(scope, 'server-a', '/')).toBeUndefined();
    writeFileListing(scope, 'server-a', '/', [file]);
    expect(readFileListing([...scope], 'server-a', '/')).toEqual([file]);
    writeFileListing(scope, 'server-a', '/empty', []);
    expect(values.size).toBe(1);
    expect(readFileListing(scope, 'server-a', '/')).toBeUndefined();
    expect(readFileListing(scope, 'server-a', '/empty')).toEqual([]);
    clearFileListing();
    expect(values.size).toBe(0);
  });

  it('requires the exact identity scope, server and directory', () => {
    writeFileListing(scope, 'server-a', '/plugins', [file]);
    expect(readFileListing(scope, 'server-b', '/plugins')).toBeUndefined();
    expect(readFileListing(scope, 'server-a', '/')).toBeUndefined();
    expect(readFileListing(undefined, 'server-a', '/plugins')).toBeUndefined();
    expect(readFileListing([], 'server-a', '/plugins')).toBeUndefined();
    for (const otherScope of [
      ['other-owner', 'subject', 'regular'],
      ['owner', 'other-subject', 'regular'],
      ['owner', 'subject', 'support'],
      ['subject', 'owner', 'regular'],
      ['owner', 'subject'],
      [...scope, 'extra'],
    ]) {
      expect(readFileListing(otherScope, 'server-a', '/plugins')).toBeUndefined();
    }
  });

  it('stores only schema-approved metadata, never extra content, URLs or tokens', () => {
    const extra = {
      ...file,
      content: 'private-file-content',
      downloadUrl: 'https://private.invalid/download?token=signed-secret',
      token: 'private-token',
      metadata: { secret: 'nested-secret' },
    };
    writeFileListing(scope, 'server-a', '/', [extra]);
    const [, serialized] = stored();
    expect(JSON.parse(serialized).files).toEqual([file]);
    for (const secret of [
      'private-file-content',
      'private.invalid',
      'private-token',
      'nested-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const [key] = stored();
    values.set(key, JSON.stringify({ ...JSON.parse(serialized), files: [extra] }));
    expect(readFileListing(scope, 'server-a', '/')).toEqual([file]);
  });

  it.each([
    '{broken-json',
    'null',
    JSON.stringify({ version: 2, scope, serverId: 'server-a', directory: '/', files: [file] }),
    JSON.stringify({ version: 1, scope, serverId: 'server-a', directory: '/', files: [{}] }),
    JSON.stringify({
      version: 1,
      scope,
      serverId: 'server-a',
      directory: '/',
      files: [{ ...file, size: -1 }],
    }),
  ])('ignores corrupt or incompatible snapshots: %s', (serialized) => {
    writeFileListing(scope, 'server-a', '/', [file]);
    const [key] = stored();
    values.set(key, serialized);
    expect(readFileListing(scope, 'server-a', '/')).toBeUndefined();
  });

  it('drops the previous snapshot when an unauthenticated or invalid listing cannot be cached', () => {
    for (const invalidScope of [undefined, []]) {
      writeFileListing(scope, 'server-a', '/', [file]);
      writeFileListing(invalidScope, 'server-a', '/', [file]);
      expect(values.size).toBe(0);
    }
    writeFileListing(scope, 'server-a', '/', [file]);
    writeFileListing(scope, 'server-a', '/', [{ ...file, size: -1 }]);
    expect(values.size).toBe(0);
  });

  it('bounds entry count even when the serialized listing is small', () => {
    const small: ServerFile = {
      name: '',
      mode: '',
      size: 0,
      is_file: true,
      is_symlink: false,
      mimetype: '',
      created_at: '',
      modified_at: '',
    };
    writeFileListing(
      scope,
      'server-a',
      '/',
      Array.from({ length: 5000 }, () => small),
    );
    expect(readFileListing(scope, 'server-a', '/')).toHaveLength(5000);
    const [key, serialized] = stored();
    const tooMany = Array.from({ length: 5001 }, () => small);
    values.set(key, JSON.stringify({ ...JSON.parse(serialized), files: tooMany }));
    expect(readFileListing(scope, 'server-a', '/')).toBeUndefined();
    writeFileListing(scope, 'server-a', '/', tooMany);
    expect(values.size).toBe(0);
  });

  it('bounds serialized UTF-8 bytes for both writes and reads', () => {
    writeFileListing(scope, 'server-a', '/', [file]);
    const [key, serialized] = stored();
    const oversized = [{ ...file, mimetype: 'é'.repeat(600_000) }];
    writeFileListing(scope, 'server-a', '/', oversized);
    expect(values.size).toBe(0);
    values.set(key, JSON.stringify({ ...JSON.parse(serialized), files: oversized }));
    expect(readFileListing(scope, 'server-a', '/')).toBeUndefined();
    values.set(key, ' '.repeat(1024 * 1024 + 1));
    expect(readFileListing(scope, 'server-a', '/')).toBeUndefined();
  });

  it('falls back without throwing when storage is unavailable or access is denied', () => {
    for (const unavailable of [
      undefined,
      {
        getItem: () => {
          throw new DOMException('Access denied', 'SecurityError');
        },
        setItem: () => {
          throw new DOMException('Access denied', 'SecurityError');
        },
        removeItem: () => {
          throw new DOMException('Access denied', 'SecurityError');
        },
      },
    ]) {
      vi.stubGlobal('sessionStorage', unavailable);
      expect(readFileListing(scope, 'server-a', '/')).toBeUndefined();
      expect(() => writeFileListing(scope, 'server-a', '/', [file])).not.toThrow();
      expect(() => clearFileListing()).not.toThrow();
    }
  });

  it('removes an older snapshot when a write exceeds the browser quota', () => {
    writeFileListing(scope, 'server-a', '/', [file]);
    vi.mocked(storage.setItem).mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    expect(() => writeFileListing(scope, 'server-a', '/', [])).not.toThrow();
    expect(readFileListing(scope, 'server-a', '/')).toBeUndefined();
  });
});
