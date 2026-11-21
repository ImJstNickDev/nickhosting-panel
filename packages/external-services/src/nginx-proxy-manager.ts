import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { endpoint, ProviderHttp } from './http.js';

const hostLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function dashboardHostname(value: string) {
  return (
    value.length <= 253 &&
    value.includes('.') &&
    !isIP(value) &&
    value.split('.').every((label) => hostLabel.test(label))
  );
}
const hostSchema = z.object({
  id: z.number().int().positive(),
  domain_names: z.array(z.string()),
  advanced_config: z.string(),
  forward_scheme: z.string(),
  forward_host: z.string(),
  forward_port: z.number().int(),
  certificate_id: z.number().int(),
  ssl_forced: z.boolean(),
  http2_support: z.boolean(),
  hsts_enabled: z.boolean(),
  block_exploits: z.boolean(),
  allow_websocket_upgrade: z.boolean(),
  caching_enabled: z.boolean(),
  enabled: z.boolean(),
  access_list_id: z.number().int(),
  locations: z.array(z.unknown()).nullish(),
  meta: z.object({ nginx_online: z.boolean().optional() }),
});
const certSchema = z.object({
  id: z.number().int().positive(),
  provider: z.string(),
  domain_names: z.array(z.string()),
  created_on: z.string(),
  expires_on: z.string(),
  meta: z.object({ nickpanel_dashboard: z.string().optional() }),
});
function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DomainError('integration_unavailable');
  return parsed.data;
}
export interface NpmRoute {
  ownership: string;
  hostname: string;
  remoteId: number | null;
}
export interface DashboardProxyProvider {
  readonly origin: string;
  ensure(route: NpmRoute): Promise<number>;
  prepare(route: NpmRoute): Promise<void>;
  remove(route: NpmRoute, keepCertificate: boolean): Promise<void>;
}
export interface NpmDashboardOptions {
  apiUrl: string;
  bearer: string;
  acmeEmail: string;
  forwardHost: string;
  forwardPort: number;
}
export async function nginxProxyManager(
  options: NpmDashboardOptions,
  fetcher = fetch,
): Promise<DashboardProxyProvider> {
  const { bearer, acmeEmail, forwardHost, forwardPort } = options;
  const base = endpoint(options.apiUrl);
  if (
    !['/', '/api/'].includes(base.pathname) ||
    !z.email().safeParse(acmeEmail).success ||
    acmeEmail.length > 254 ||
    acmeEmail.includes("'") ||
    !/^[A-Za-z0-9._~+/=-]{1,8192}$/.test(bearer) ||
    forwardHost.length > 253 ||
    !forwardHost.split('.').every((l) => hostLabel.test(l)) ||
    !Number.isInteger(forwardPort) ||
    forwardPort < 1 ||
    forwardPort > 65535
  )
    throw new DomainError('configuration_invalid');
  base.pathname = '/api/';
  const http = new ProviderHttp({
    baseURL: base.href,
    headers: { Authorization: `Bearer ${bearer}` },
    fetcher,
    timeoutMs: 60_000,
  });
  // Scope ownership to the authenticated operator. Token rotation does not lose
  // the ledger. Switching accounts must never turn hidden records into false 404s.
  const user = read(
    z.object({ id: z.number().int().positive() }),
    (await http.request('users/me')).data,
  );
  const marker = (r: NpmRoute) => `# NickPanel dashboard ${r.ownership}`;
  function check(route: NpmRoute) {
    if (
      !dashboardHostname(route.hostname) ||
      !z.uuid().safeParse(route.ownership).success ||
      (route.remoteId !== null && (!Number.isSafeInteger(route.remoteId) || route.remoteId <= 0))
    )
      throw new DomainError('configuration_invalid');
  }
  function isOwned(row: z.infer<typeof hostSchema>, route: NpmRoute) {
    return (
      row.advanced_config === marker(route) &&
      row.domain_names.length === 1 &&
      row.domain_names[0] === route.hostname
    );
  }
  async function current(route: NpmRoute, removing: boolean) {
    check(route);
    if (route.remoteId !== null) {
      const response = await http.request(`nginx/proxy-hosts/${route.remoteId}`);
      if (response.status !== 404) {
        const row = read(hostSchema, response.data);
        if (row.id !== route.remoteId || !isOwned(row, route))
          throw new DomainError('provenance_mismatch');
        return row;
      }
    }
    // A remote create may commit and lose its response before the local ID is stored.
    const response = await http.request(
      `nginx/proxy-hosts?query=${encodeURIComponent(route.hostname)}`,
    );
    const matches = read(z.array(hostSchema), response.data).filter((r) =>
      r.domain_names.some((n) => n.toLowerCase() === route.hostname),
    );
    if (matches.length > 1) throw new DomainError('conflict');
    const row = matches[0];
    if (row && !isOwned(row, route)) {
      if (removing) return;
      throw new DomainError('conflict');
    }
    return row;
  }
  const ownsCert = (cert: z.infer<typeof certSchema>, route: NpmRoute) =>
    cert.provider === 'letsencrypt' &&
    cert.meta.nickpanel_dashboard === route.ownership &&
    cert.domain_names.length === 1 &&
    cert.domain_names[0] === route.hostname;
  async function certificates(route: NpmRoute) {
    const response = await http.request(
      `nginx/certificates?query=${encodeURIComponent(route.hostname)}`,
    );
    return read(z.array(certSchema), response.data)
      .filter((c) => ownsCert(c, route))
      .sort((a, b) => Date.parse(b.expires_on) - Date.parse(a.expires_on));
  }
  async function cleanupCertificates(route: NpmRoute) {
    for (const cert of await certificates(route)) {
      // NPM may still be completing a timed-out ACME request; never revoke a pending cert.
      if (isIssuing(cert)) throw new DomainError('operation_busy');
      const url = `nginx/certificates/${cert.id}`;
      const response = await http.request(`${url}?expand=proxy_hosts,redirection_hosts,dead_hosts`);
      if (response.status === 404) continue;
      const current = read(
        certSchema.extend({
          proxy_hosts: z.array(z.unknown()),
          redirection_hosts: z.array(z.unknown()),
          dead_hosts: z.array(z.unknown()),
        }),
        response.data,
      );
      if (current.id !== cert.id || !ownsCert(current, route))
        throw new DomainError('provenance_mismatch');
      if (
        current.proxy_hosts.length ||
        current.redirection_hosts.length ||
        current.dead_hosts.length
      )
        continue;
      const removed = await http.request(url, 'DELETE');
      if (removed.status !== 404 && removed.data !== true)
        throw new DomainError('integration_unavailable');
    }
  }
  // NPM inserts a row with expires_on=created_on before running certbot.
  function isIssuing(c: z.infer<typeof certSchema>) {
    return (
      Date.parse(c.expires_on) <= Date.now() && Date.parse(c.created_on) > Date.now() - 20 * 60_000
    );
  }
  async function ensure(route: NpmRoute) {
    const row = await current(route, false);
    const payload = {
      domain_names: [route.hostname],
      forward_scheme: 'http',
      forward_host: forwardHost,
      forward_port: forwardPort,
      advanced_config: marker(route),
      ssl_forced: true,
      http2_support: true,
      hsts_enabled: true,
      hsts_subdomains: false,
      block_exploits: true,
      allow_websocket_upgrade: true,
      caching_enabled: false,
      access_list_id: 0,
      locations: [],
      enabled: true,
    };
    const matches = (r: z.infer<typeof hostSchema>, id: number) =>
      isOwned(r, route) &&
      r.forward_scheme === 'http' &&
      r.forward_host === forwardHost &&
      r.forward_port === forwardPort &&
      r.certificate_id === id &&
      r.ssl_forced &&
      r.http2_support &&
      r.hsts_enabled &&
      r.block_exploits &&
      r.allow_websocket_upgrade &&
      !r.caching_enabled &&
      r.access_list_id === 0 &&
      !r.locations?.length &&
      r.enabled &&
      r.meta.nginx_online === true;
    let drift =
      route.remoteId !== null &&
      (!row || !matches(row, row.certificate_id) || row.certificate_id < 1);
    try {
      const certs = await certificates(route);
      const cert = certs.find((c) => Date.parse(c.expires_on) > Date.now());
      drift ||= route.remoteId !== null && (!row || !cert || !matches(row, cert.id));
      if (!cert && certs.some(isIssuing)) throw new DomainError('operation_busy');
      if (row && cert && matches(row, cert.id)) return row.id;
      // Quick Certificate reserves the exact Proxy Host first. NPM checks dead
      // and redirection hosts too, before certbot temporarily handles HTTP-01.
      const body = cert
        ? { ...payload, certificate_id: cert.id }
        : {
            ...payload,
            certificate_id: 'new',
            meta: {
              letsencrypt_email: acmeEmail,
              letsencrypt_agree: true,
              dns_challenge: false,
              nickpanel_dashboard: route.ownership,
            },
          };
      const basePath = 'nginx/proxy-hosts';
      const saved = await http.request(
        row ? `${basePath}/${row.id}` : basePath,
        row ? 'PUT' : 'POST',
        body,
      );
      const id = read(z.object({ id: z.number().int().positive() }), saved.data).id;
      if (row && id !== row.id) throw new DomainError('provenance_mismatch');
      const path = `${basePath}/${id}`;
      let checked = read(hostSchema, (await http.request(path)).data);
      if (checked.id !== id || !isOwned(checked, route))
        throw new DomainError('provenance_mismatch');
      const issued =
        cert ??
        (await certificates(route)).find(
          (c) => c.id === checked.certificate_id && Date.parse(c.expires_on) > Date.now(),
        );
      if (!issued) throw new DomainError('provenance_mismatch');
      // In v2.12.3 createQuickCertificate may normalize SSL/HTTP2/HSTS to
      // false before the certificate ID exists. Reapply them with the real ID.
      if (!matches(checked, issued.id) && !cert) {
        await http.request(path, 'PUT', { ...payload, certificate_id: issued.id });
        checked = read(hostSchema, (await http.request(path)).data);
      }
      if (checked.id !== id || !matches(checked, issued.id))
        throw new DomainError('provenance_mismatch');
      return id;
    } catch (error) {
      if (drift) throw new DomainError('provenance_mismatch');
      throw error;
    }
  }
  async function remove(route: NpmRoute, keepCertificate: boolean) {
    const row = await current(route, true);
    if (row) {
      const removed = await http.request(`nginx/proxy-hosts/${row.id}`, 'DELETE');
      if (removed.status !== 404 && removed.data !== true)
        throw new DomainError('integration_unavailable');
    }
    if (!keepCertificate) await cleanupCertificates(route);
  }
  async function prepare(route: NpmRoute) {
    check(route);
    const valid = (await certificates(route)).some(
      (cert) => Date.parse(cert.expires_on) > Date.now(),
    );
    // A new certificate uses a temporary exact host for HTTP-01. Ingress
    // authorizes only enabled publications. Its bookkeeping stays pending
    // throughout issuance and the temporary Proxy Host is then removed.
    const remoteId = valid ? route.remoteId : await ensure(route);
    await remove({ ...route, remoteId }, true);
  }
  return {
    origin: createHash('sha256')
      .update(JSON.stringify([base.origin, user.id]))
      .digest('hex'),
    prepare,
    ensure,
    remove,
  };
}
