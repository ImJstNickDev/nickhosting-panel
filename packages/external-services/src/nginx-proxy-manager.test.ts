import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { nginxProxyManager } from './nginx-proxy-manager.js';

const hostname = 'aurora.servers.example';
const options = {
  apiUrl: 'https://manager.example/api',
  bearer: 'fixture-key',
  acmeEmail: 'hosting@servers.example',
  forwardHost: 'isolated-dashboard-ingress',
  forwardPort: 8081,
};
const value = () => ({
  domain_names: [hostname],
  id: 5,
  advanced_config: '# manual',
  forward_scheme: 'http',
  forward_host: 'manual',
  forward_port: 8080,
  certificate_id: 2,
  access_list_id: 0,
  ssl_forced: true,
  http2_support: true,
  hsts_enabled: true,
  block_exploits: true,
  allow_websocket_upgrade: true,
  caching_enabled: false,
  enabled: true,
  locations: [],
  meta: { nginx_online: true },
});
const certificate = (ownership: string) => ({
  id: 19,
  provider: 'letsencrypt',
  domain_names: [hostname],
  created_on: '2026-01-01T00:00:00Z',
  expires_on: '2099-12-31T00:00:00Z',
  meta: { nickpanel_dashboard: ownership },
});
async function fixture() {
  const hosts = new Map<number, ReturnType<typeof value>>(),
    certs = new Map<number, ReturnType<typeof certificate>>();
  const writes: string[] = [],
    issued: string[] = [];
  let loseWriteResponse = false,
    foreignReference = false,
    validation = true;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://manager.example');
    const method = init?.method ?? 'GET';
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-key');
    if (url.pathname === '/api/users/me') return Response.json({ id: 101 });
    if (url.pathname === '/api/nginx/certificates') return Response.json([...certs.values()]);
    const id = Number(url.pathname.split('/')[4]) || 0;
    if (url.pathname.startsWith('/api/nginx/certificates/')) {
      if (method === 'GET')
        return certs.has(id)
          ? Response.json({
              ...certs.get(id),
              proxy_hosts: foreignReference ? [{ id: 473 }] : [],
              redirection_hosts: [],
              dead_hosts: [],
            })
          : new Response(null, { status: 404 });
      if (method === 'DELETE') {
        certs.delete(id);
        writes.push('DELETE cert');
        return Response.json(true);
      }
      throw Error();
    }
    if (!url.pathname.startsWith('/api/nginx/proxy-hosts')) throw Error();
    if (method === 'GET')
      return id
        ? hosts.has(id)
          ? Response.json(hosts.get(id))
          : new Response(null, { status: 404 })
        : Response.json([...hosts.values()]);
    writes.push(method);
    if (method === 'DELETE') {
      hosts.delete(id);
      return Response.json(true);
    }
    const payload = JSON.parse(String(init?.body));
    const fresh = payload.certificate_id === 'new';
    if (fresh) {
      expect(payload.meta).toMatchObject({
        letsencrypt_email: options.acmeEmail,
        letsencrypt_agree: true,
        dns_challenge: false,
      });
      const newCert = certificate(payload.meta.nickpanel_dashboard);
      certs.set(newCert.id, newCert);
      payload.certificate_id = newCert.id;
      issued.push(hostname);
    }
    const host = {
      ...payload,
      id: id || 7,
      meta: { nginx_online: validation },
      ...(fresh ? { ssl_forced: false, http2_support: false, hsts_enabled: false } : {}),
    };
    hosts.set(host.id, host);
    if (loseWriteResponse) {
      loseWriteResponse = false;
      throw Error();
    }
    return Response.json({ id: host.id });
  };
  const manager = await nginxProxyManager(options, fetcher);
  return {
    hosts,
    certs,
    writes,
    issued,
    manager,
    lose() {
      loseWriteResponse = true;
    },
    share() {
      foreignReference = true;
    },
    fail() {
      validation = false;
    },
  };
}

it('recovers an ambiguous create, repairs NPM’s first-issue SSL defaults and reuses the certificate after republishing', async () => {
  const f = await fixture(),
    route = { ownership: randomUUID(), hostname, remoteId: null };
  f.lose();
  await expect(f.manager.ensure(route)).rejects.toMatchObject({ code: 'integration_unavailable' });
  await expect(f.manager.ensure(route)).resolves.toBe(7);
  await expect(f.manager.ensure({ ...route, remoteId: 7 })).resolves.toBe(7);
  expect(f.writes).toEqual(['POST', 'PUT']);
  expect(f.hosts.get(7)).toMatchObject({
    domain_names: [hostname],
    certificate_id: 19,
    ssl_forced: true,
    http2_support: true,
    hsts_enabled: true,
    block_exploits: true,
    allow_websocket_upgrade: true,
    caching_enabled: false,
    locations: [],
    forward_host: options.forwardHost,
    forward_port: 8081,
  });
  await f.manager.remove({ ...route, remoteId: 7 }, true);
  expect(f.certs.size).toBe(1);
  await f.manager.ensure(route);
  await f.manager.remove({ ...route, remoteId: 7 }, false);
  expect(f.writes).toEqual(['POST', 'PUT', 'DELETE', 'POST', 'DELETE', 'DELETE cert']);
  expect(f.issued).toEqual([hostname]);
  expect(f.certs.size).toBe(0);
});

it('enables every requested proxy switch on the very first successful ACME issuance', async () => {
  const f = await fixture(),
    route = { ownership: randomUUID(), hostname, remoteId: null };
  await f.manager.ensure(route);
  expect(f.writes).toEqual(['POST', 'PUT']);
  expect(f.hosts.get(7)).toMatchObject({
    ssl_forced: true,
    http2_support: true,
    hsts_enabled: true,
    block_exploits: true,
    allow_websocket_upgrade: true,
  });
});

it('refuses foreign hosts, extra aliases and a lost ownership marker; leaves others’ and in-use certs intact', async () => {
  const f = await fixture(),
    route = { ownership: randomUUID(), hostname, remoteId: null };
  const foreign = value();
  f.hosts.set(5, foreign);
  const foreignCert = { ...certificate(randomUUID()), id: 12 };
  f.certs.set(12, foreignCert);
  await expect(f.manager.ensure(route)).rejects.toMatchObject({ code: 'conflict' });
  await f.manager.remove(route, false);
  await expect(f.manager.remove({ ...route, remoteId: 5 }, false)).rejects.toMatchObject({
    code: 'provenance_mismatch',
  });
  foreign.advanced_config = `# NickPanel dashboard ${route.ownership}`;
  foreign.domain_names.push('other.servers.example');
  await expect(f.manager.ensure(route)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.writes).toHaveLength(0);
  f.hosts.clear();
  await f.manager.ensure(route);
  f.share();
  await f.manager.remove(route, false);
  expect(f.certs.has(12)).toBe(true);
  expect(f.certs.has(19)).toBe(true);
});

it('denies wildcard names, pending issuance and failed Nginx validation', async () => {
  const f = await fixture(),
    route = { ownership: randomUUID(), hostname, remoteId: null };
  await expect(f.manager.ensure({ ...route, hostname: '*.example' })).rejects.toMatchObject({
    code: 'configuration_invalid',
  });
  const pending = {
    ...certificate(route.ownership),
    created_on: new Date().toISOString(),
    expires_on: new Date().toISOString(),
  };
  f.certs.set(19, pending);
  await expect(f.manager.ensure(route)).rejects.toMatchObject({ code: 'operation_busy' });
  expect(f.writes).toHaveLength(0);
  f.certs.clear();
  f.fail();
  await expect(f.manager.ensure(route)).rejects.toMatchObject({ code: 'provenance_mismatch' });
});

it('prepares an unpublished name with its own certificate and leaves no Proxy Host, including on retry', async () => {
  const f = await fixture(),
    route = { ownership: randomUUID(), hostname, remoteId: null };
  await f.manager.prepare(route);
  await f.manager.prepare(route);
  expect(f.hosts.size).toBe(0);
  expect(f.certs.size).toBe(1);
  expect(f.issued).toEqual([hostname]);
  expect(f.writes).toEqual(['POST', 'PUT', 'DELETE']);
  await f.manager.ensure(route);
  expect(f.issued).toEqual([hostname]);
  expect(f.hosts.size).toBe(1);
});
