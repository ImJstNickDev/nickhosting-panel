import { isIP } from 'node:net';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { dashboardHostname } from '@nickhosting/external-services';
import {
  type ManagementRuntime,
  privateBackendAddress,
  resolveOpenworldPublication,
} from '@nickhosting/server-management';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Kysely } from 'kysely';
import { openworldDashboardToken } from '../../../games/openworld/src/dashboard-api.js';
import { resolveOpenworldDashboardTarget } from '../../../packages/server-management/src/openworld-dashboard.js';
import {
  callbackPath,
  dashboardSessionBinding,
  digest,
  exchangeDashboardCode,
  randomToken,
  tokenPattern,
} from './openworld-dashboard-sso.js';

const sessionCookie = '__Host-nh-ow-session';
const nonceCookie = '__Host-nh-ow-login';
const cookie = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } as const;
const actions =
  /^\/api\/live\/(?:console|time|summon|checkpoints(?:\/(?:update|delete))?|player\/(?:gamemode|kill|respawn|message|kick|teleport|screenshot))$/;
const nativePath = /^\/(?:[A-Za-z0-9_./-]*)$/;
const jsonBodyLimit = 256 * 1024;

async function readActionBody(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    throw new DomainError('validation_failed', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError('validation_failed');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > jsonBodyLimit) throw new DomainError('validation_failed', 413);
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

function returnPath(input: string, origin: string) {
  if (!input.startsWith('/') || input.length > 1400) return '/';
  const target = new URL(input, origin);
  return target.origin === origin && !target.pathname.startsWith('/.nickhosting/')
    ? target.pathname + target.search
    : '/';
}

export function createOpenworldDashboardIngress(options: {
  db: Kysely<Database>;
  panelOrigin: string;
  management: () => Promise<ManagementRuntime>;
  /** Test-only substitutes for an assigned private service and its provider. */
  lookup?: typeof resolveOpenworldPublication;
  target?: (serverId: string) => Promise<{ address: string; password: string }>;
  fetcher?: typeof fetch;
}) {
  const { db, panelOrigin } = options;
  const panel = new URL(panelOrigin);
  if (panel.protocol !== 'https:' || panel.username || panel.password)
    throw new DomainError('configuration_invalid');
  const lookup = options.lookup ?? resolveOpenworldPublication;
  const fetcher = options.fetcher ?? fetch;
  const target =
    options.target ??
    (async (serverId: string) =>
      resolveOpenworldDashboardTarget(db, (await options.management()).adapter, serverId));
  const tokens = new Map<string, { expires: number; value: Promise<string> }>();
  function tokenFor(key: string, serverId: string, origin: string) {
    const entry = tokens.get(key);
    if (entry && entry.expires > Date.now()) return entry.value;
    const value = (async () => {
      const current = await target(serverId);
      if (current.address !== origin) throw new DomainError('provenance_mismatch');
      return openworldDashboardToken(origin, current.password, AbortSignal.timeout(5000), fetcher);
    })();
    const next = { expires: Date.now() + 60_000, value };
    if (tokens.size >= 256) {
      const first = tokens.keys().next().value;
      if (first) tokens.delete(first);
    }
    tokens.set(key, next);
    value.catch(() => {
      if (tokens.get(key) === next) tokens.delete(key);
    });
    return value;
  }
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('cache-control', 'private, no-store');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'SAMEORIGIN');
    c.header('strict-transport-security', 'max-age=31536000');
    c.header('cross-origin-resource-policy', 'same-origin');
    c.header('cross-origin-opener-policy', 'same-origin');
    c.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'self'; frame-ancestors 'self'; form-action 'self'",
    );
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof DomainError && error.code === 'validation_failed')
      return new Response(null, { status: error.status });
    return c.body(null, 503);
  });
  app.all('*', async (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);
    // This is the dedicated listener. Ignore Forwarded/X-Forwarded-Host and require
    // the actual Host received from the exact-name NPM proxy.
    const hostname = request.headers.get('host')?.toLowerCase() ?? '';
    if (!dashboardHostname(hostname) || hostname === panel.hostname) return c.notFound();
    const origin = `https://${hostname}`;
    const route = await lookup(db, hostname);
    if (!route) return c.notFound();
    if (
      request.headers.has('service-worker') ||
      request.headers.get('sec-fetch-dest') === 'serviceworker'
    )
      return c.body(null, 403);
    if (url.pathname === callbackPath) {
      if (request.method !== 'GET') return c.body(null, 405);
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      if (!/^[a-f0-9]{64}$/.test(state)) return c.body(null, 403);
      const cookieName = `${nonceCookie}-${state}`;
      const [nonce = '', encodedPath = ''] = (getCookie(c, cookieName) ?? '').split('.');
      if (!tokenPattern.test(code) || !tokenPattern.test(nonce)) return c.body(null, 403);
      const token = await exchangeDashboardCode(db, hostname, route.serverId, code, nonce);
      if (!token) return c.body(null, 403);
      setCookie(c, sessionCookie, token, { ...cookie, maxAge: 12 * 60 * 60 });
      deleteCookie(c, cookieName, cookie);
      const path = Buffer.from(encodedPath, 'base64url').toString('utf8');
      return c.redirect(origin + returnPath(path, origin), 303);
    }
    if (
      !nativePath.test(url.pathname) ||
      url.pathname.includes('//') ||
      url.pathname.startsWith('/.nickhosting') ||
      url.pathname.toLowerCase() === '/api/live/login'
    )
      return c.notFound();
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return c.body(null, 405);
    if (
      request.method === 'POST' &&
      (!actions.test(url.pathname) || request.headers.get('origin') !== origin)
    )
      return c.body(null, 403);
    const navigation =
      request.method === 'GET' &&
      (request.headers.has('sec-fetch-mode')
        ? request.headers.get('sec-fetch-mode') === 'navigate'
        : request.headers.get('accept')?.includes('text/html'));
    const site = request.headers.get('sec-fetch-site');
    if (!navigation && (site === 'cross-site' || site === 'same-site')) return c.body(null, 403);
    const session = getCookie(c, sessionCookie);
    if (request.method === 'POST' && (!session || !tokenPattern.test(session)))
      return c.body(null, 403);
    // Read bounded action bodies before checking the current grant. A slow upload
    // cannot retain authorization that was revoked while it was arriving.
    const body = request.method === 'POST' ? await readActionBody(request) : undefined;
    const binding =
      session && tokenPattern.test(session)
        ? await dashboardSessionBinding(db, hostname, route.serverId, session)
        : undefined;
    if (!binding) {
      if (!navigation || request.headers.get('sec-fetch-dest') === 'iframe')
        return c.body(null, 403);
      const nonce = randomToken();
      const path = returnPath(url.pathname + url.search, origin);
      const challenge = digest(nonce);
      // Different tabs can authenticate simultaneously, including deep links.
      const pending = Object.keys(getCookie(c)).filter((name) =>
        name.startsWith(`${nonceCookie}-`),
      );
      for (const old of pending.slice(0, Math.max(0, pending.length - 3)))
        deleteCookie(c, old, cookie);
      setCookie(
        c,
        `${nonceCookie}-${challenge}`,
        `${nonce}.${Buffer.from(path).toString('base64url')}`,
        {
          ...cookie,
          maxAge: 600,
        },
      );
      const authorize = new URL('/dashboard/authorize', panel);
      authorize.searchParams.set('hostname', hostname);
      authorize.searchParams.set('challenge', challenge);
      return c.redirect(authorize.href, 303);
    }
    if (
      !binding.running ||
      !binding.provider ||
      !binding.address ||
      !binding.port ||
      !binding.allocation ||
      !privateBackendAddress(binding.address)
    )
      return c.body(null, 503);
    const address = isIP(binding.address) === 6 ? `[${binding.address}]` : binding.address;
    const backend = `http://${address}:${binding.port}`;
    const key = JSON.stringify([
      route.serverId,
      binding.provider,
      binding.mapping,
      binding.node,
      binding.allocation,
      backend,
    ]);
    const token = await tokenFor(key, route.serverId, backend);
    if (body && (await lookup(db, hostname))?.serverId !== route.serverId) return c.notFound();
    const upstream = new URL(backend);
    upstream.pathname = url.pathname;
    upstream.search = url.search;
    const headers = new Headers();
    if (url.pathname.startsWith('/api/live/')) headers.set('X-OW-Token', token);
    if (body) headers.set('content-type', 'application/json');
    const response = await fetcher(upstream, {
      method: request.method,
      redirect: 'manual',
      headers,
      body,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
    });
    if (response.status === 401 || response.status === 403) {
      tokens.delete(key);
      await response.body?.cancel();
      return c.body(null, response.status === 401 ? 503 : 403);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || request.method !== 'GET') return c.body(null, 502);
      const redirect = new URL(location, upstream);
      if (
        redirect.origin !== upstream.origin ||
        !nativePath.test(redirect.pathname) ||
        redirect.pathname.startsWith('//')
      )
        return c.body(null, 502);
      return c.redirect(origin + redirect.pathname + redirect.search, 302);
    }
    // Rebuild headers: native cookies, authorization, CORS and cache policy
    // never reach a browser. Undici transparently decodes any content-encoding.
    const type = response.headers.get('content-type');
    c.header('content-type', type ?? 'application/octet-stream');
    return new Response(response.body, { status: response.status, headers: c.res.headers });
  });
  return app;
}
