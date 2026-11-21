import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readOpenworldArchive, readOpenworldCatalog } from './catalog-source.js';

const token = 'mtv_fixture';
const version = 'a1.2.9';
const content = 'fixture archive';
const pin = {
  version,
  size: Buffer.byteLength(content),
  sha256: createHash('sha256').update(content).digest('hex'),
};
const mirror = 'https://metiva.imjstnick.com/p/pascard-openworld/r/dedicated-linux-server-x64';
const official = 'https://core.openworld.pascard.com';
const cdn = 'https://ow-bucket.s3.eu-west-par.io.cloud.ovh.net/releases/client/id';
const filename = `openworld-server-${version}-linux-x64.zip`;
function fixture() {
  const assets = new Map<string, unknown>([
    [
      `${mirror}/manifest.json`,
      {
        project: 'pascard-openworld',
        runtime: 'dedicated-linux-server-x64',
        schema_version: 1,
        releases: [
          {
            version,
            artifacts: [{ ...pin, filename, url: `${mirror}/files/${version}/${filename}` }],
          },
        ],
      },
    ],
    [`${official}/manifest.json`, { client: { channels: { alpha: { pages: 1 } } } }],
    [
      `${official}/c/manifest/client/alpha-1.json`,
      {
        page: 1,
        pages: 1,
        channel: 'alpha',
        versions: [{ version, server: { 'linux-x64': { ...pin, url: `${cdn}/${filename}` } } }],
      },
    ],
    [`${mirror}/files/${version}/${filename}`, content],
    [`${cdn}/${filename}`, content],
  ]);
  const http = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      url.startsWith(mirror) ? `Bearer ${token}` : null,
    );
    const value = assets.get(url);
    if (value === undefined) return new Response(null, { status: 404 });
    return typeof value === 'string' ? new Response(value) : Response.json(value);
  });
  return { http, assets };
}
describe('Openworld Linux releases', () => {
  it('uses the private mirror for both catalog and bytes and only returns an immutable pin', async () => {
    const { http } = fixture();
    expect(await readOpenworldCatalog(token, http)).toEqual({ source: 'metiva', releases: [pin] });
    expect(String(await readOpenworldArchive(pin, token, http))).toEqual(content);
    expect(http.mock.calls.every(([url]) => String(url).startsWith(mirror))).toBe(true);
  });
  it('falls back to the official exact publish on inaccessible manifest or changed mirror bytes', async () => {
    const { assets, http } = fixture();
    assets.set(`${mirror}/files/${version}/${filename}`, 'x'.repeat(pin.size));
    expect(String(await readOpenworldArchive(pin, token, http))).toEqual(content);
    assets.delete(`${mirror}/manifest.json`);
    expect(await readOpenworldCatalog(token, http)).toEqual({
      source: 'official',
      releases: [pin],
    });
    expect(String(await readOpenworldArchive(pin, token, http))).toEqual(content);
    await expect(
      readOpenworldArchive({ ...pin, version: 'a1.2.10' }, token, http),
    ).rejects.toMatchObject({ code: 'provenance_mismatch' });
  });
  it('does not follow misdirected mirror credentials or trust same-sized different content', async () => {
    const { assets, http } = fixture();
    assets.set(`${mirror}/manifest.json`, {
      project: 'pascard-openworld',
      runtime: 'dedicated-linux-server-x64',
      schema_version: 1,
      releases: [
        { version, artifacts: [{ ...pin, filename, url: 'https://unrelated.example/file' }] },
      ],
    });
    assets.set(`${cdn}/${filename}`, 'x'.repeat(pin.size));
    await expect(readOpenworldArchive(pin, token, http)).rejects.toMatchObject({
      code: 'provenance_mismatch',
    });
    expect(http.mock.calls.some(([url]) => String(url).includes('unrelated.example'))).toBe(false);
  });
});
