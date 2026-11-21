import { createHash, randomBytes } from 'node:crypto';
import { DomainError, SecretCodec } from '@nickhosting/core';
import { issueOpenworldArtifactUrl } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import type { Variables } from './app.js';
import { registerOpenworldArtifactRoute } from './openworld-artifacts.js';

afterEach(() => vi.unstubAllGlobals());
it('rejects a request before contacting Metiva and returns only the bytes authorized by the install ticket', async () => {
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  const token = 'mtv_fixture';
  const mirror = 'https://metiva.imjstnick.com/p/pascard-openworld/r/dedicated-linux-server-x64';
  const bytes = 'pack-fixture';
  const release = {
    version: 'a1.2.9',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const filename = 'openworld-server-a1.2.9-linux-x64.zip';
  const artifactUrl = `${mirror}/files/a1.2.9/${filename}`;
  const http = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    if (input === artifactUrl) return new Response(bytes);
    expect(input).toBe(`${mirror}/manifest.json`);
    return Response.json({
      project: 'pascard-openworld',
      runtime: 'dedicated-linux-server-x64',
      schema_version: 1,
      releases: [
        { version: release.version, artifacts: [{ ...release, filename, url: artifactUrl }] },
      ],
    });
  });
  vi.stubGlobal('fetch', http);
  const app = new Hono<{ Variables: Variables }>();
  app.onError((err, c) => c.body(null, err instanceof DomainError ? (err.status as 403) : 500));
  registerOpenworldArtifactRoute(app, {
    db: {} as never,
    codec,
    env: { NH_METIVA_ACCESS_TOKEN_OPENWORLD: token },
  });
  const url = issueOpenworldArtifactUrl(codec, 'https://panel.example', release);
  const endpoint = new URL(url).pathname;
  expect((await app.request(endpoint)).status).toBe(403);
  const head = await app.request(url, { method: 'HEAD' });
  expect(head.headers.get('content-length')).toBe(String(bytes.length));
  expect(http).not.toHaveBeenCalled();
  const response = await app.request(url);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-length')).toBe(String(bytes.length));
  expect(await response.text()).toBe(bytes);
  expect([...response.headers.values()].join('')).not.toContain(token);
  expect(http).toHaveBeenCalledTimes(2);
});
