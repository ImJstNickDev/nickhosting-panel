import type { Page } from '@playwright/test';
import { type browserHarness, browserPassword } from './harness.js';

export type BrowserHarness = Awaited<ReturnType<typeof browserHarness>>;

/** Preparation uses actual HTTP handlers and browser-context cookies. No users,
 * sessions or invitations are seeded; account.browser.test proves their UI. */
export async function journeyRequest<T>(
  fixture: BrowserHarness,
  page: Page,
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const response = await page.request.fetch(`${fixture.origin}${path}`, {
    method: body === undefined && method === 'POST' ? 'GET' : method,
    headers: { Origin: fixture.origin },
    ...(body === undefined ? {} : { data: body }),
  });
  if (!response.ok())
    throw new Error(
      `Journey preparation ${method} ${path} failed: ${response.status()} ${await response.text()}`,
    );
  return response.status() === 204 ? (undefined as T) : ((await response.json()) as T);
}
async function verifyAndSignIn(fixture: BrowserHarness, page: Page, email: string) {
  const mail = fixture.mails.findLast(
    (value) => value.to === email && value.template === 'verify-email',
  );
  if (!mail) throw new Error('Expected actual verification mail from isolated sink');
  const verification = await page.request.get(mail.url);
  if (!verification.ok()) throw new Error(`Verification failed: ${verification.status()}`);
  await journeyRequest(fixture, page, '/api/auth/sign-in/email', {
    email,
    password: browserPassword,
  });
  const session = await journeyRequest<{ actor: { id: string } }>(fixture, page, '/v1/web/session');
  return session.actor.id;
}
export async function prepareJourneyIdentities(fixture: BrowserHarness) {
  const owner = await fixture.page();
  await journeyRequest(fixture, owner, '/v1/setup/owner', {
    token: fixture.setupToken,
    name: 'Morgan Owner',
    email: 'owner@journey.example.test',
    password: browserPassword,
    locale: 'en',
  });
  const ownerId = await verifyAndSignIn(fixture, owner, 'owner@journey.example.test');
  await journeyRequest(fixture, owner, '/v1/setup/complete', {
    instanceName: 'NickHosting',
    pterodactylBaseURL: 'https://panel.example.test',
    pterodactylApplicationKey: 'browser-fixture-application',
    pterodactylClientKey: 'browser-fixture-client',
  });
  async function invite(name: string, email: string, locale: 'en' | 'it' = 'en') {
    const invitation = await journeyRequest<{ url: string }>(
      fixture,
      owner,
      '/v1/owner/invitations',
      { email, role: 'user', maxUses: 1 },
    );
    const token = new URL(invitation.url).pathname.split('/').at(-1);
    if (!token) throw new Error('Invitation token missing');
    const page = await fixture.page(locale);
    const registration = await page.request.post(`${fixture.origin}/api/auth/sign-up/email`, {
      headers: { Origin: fixture.origin, 'X-Invitation-Token': token },
      data: {
        name,
        email,
        password: browserPassword,
        locale,
        callbackURL: `${fixture.origin}/login`,
      },
    });
    if (!registration.ok())
      throw new Error(
        `Invited registration failed: ${registration.status()} ${await registration.text()}`,
      );
    const id = await verifyAndSignIn(fixture, page, email);
    return { page, id, email, name };
  }
  const user = await invite('Alex', 'alex@journey.example.test');
  const peer = await invite('Taylor', 'taylor@journey.example.test');
  return {
    owner,
    ownerId,
    user: user.page,
    userId: user.id,
    peer: peer.page,
    peerId: peer.id,
    peerEmail: peer.email,
    invite,
  };
}
