import type { Page } from '@playwright/test';
import { vi } from 'vitest';

interface DiscordProfile {
  id: string;
  email: string | null;
  verified: boolean;
}

/** Only Discord is simulated. The browser still follows the real application
 * OAuth start/callback routes, state cookie, invitation and session handlers. */
export function discordProviderFixture(clientId: string) {
  const profiles = new Map<string, DiscordProfile>();
  const calls = { authorization: 0, token: 0, profile: 0 };
  const unexpected: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === 'https://discord.com/api/oauth2/token') {
      const body = new URLSearchParams(String(init?.body));
      const code = body.get('code');
      if (!code || !profiles.has(code) || body.get('client_id') !== clientId)
        throw new Error('Unexpected fixture OAuth token exchange');
      calls.token++;
      return Response.json({
        access_token: code,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'identify email',
      });
    }
    if (
      url.href === 'https://discord.com/api/users/@me' ||
      url.href === 'https://discord.com/api/users/%40me'
    ) {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      const profile = profiles.get(authorization.replace(/^Bearer /, ''));
      if (!profile) throw new Error('Unknown fixture Discord identity');
      calls.profile++;
      return Response.json({
        ...profile,
        username: 'fixture-discord',
        global_name: 'Fixture Discord',
        discriminator: '0',
        avatar: null,
      });
    }
    unexpected.push(`${url.hostname}${url.pathname}`);
    throw new Error('Unexpected external request in isolated Discord fixture');
  });
  return {
    profiles,
    calls,
    unexpected,
    async authorize(page: Page, origin: string, code: string) {
      if (!profiles.has(code)) throw new Error('Missing fixture Discord profile');
      await page.route('https://discord.com/**', async (route) => {
        const url = new URL(route.request().url());
        const callback = new URL(url.searchParams.get('redirect_uri') ?? 'about:blank');
        const state = url.searchParams.get('state');
        if (
          !['/oauth2/authorize', '/api/oauth2/authorize'].includes(url.pathname) ||
          route.request().method() !== 'GET' ||
          url.searchParams.get('client_id') !== clientId ||
          callback.origin !== origin ||
          callback.pathname !== '/api/auth/callback/discord' ||
          !state
        ) {
          unexpected.push(`${url.hostname}${url.pathname}`);
          await route.abort();
          return;
        }
        calls.authorization++;
        callback.searchParams.set('state', state);
        callback.searchParams.set('code', code);
        await route.fulfill({ status: 302, headers: { location: callback.href }, body: '' });
      });
    },
    close() {
      vi.unstubAllGlobals();
    },
  };
}
