import { type Page, expect as visible } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { browserHarness, browserPassword } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';

let fixture: Awaited<ReturnType<typeof browserHarness>>;
let users: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
beforeAll(async () => {
  fixture = await browserHarness();
  users = await prepareJourneyIdentities(fixture);
});
afterAll(async () => fixture?.close());

const hostname = 'aurora.example.test';
const params = new URLSearchParams({ hostname, challenge: 'a'.repeat(64) });
const callback = `https://${hostname}/.nickhosting/callback?code=${'A'.repeat(43)}`;

async function open(page: Page) {
  await page.route(callback, (route) =>
    route.fulfill({ body: 'Aurora', contentType: 'text/plain' }),
  );
  await page.route('**/v1/web/openworld/dashboard/authorize', async (route) => {
    expect(route.request().postDataJSON()).toEqual(Object.fromEntries(params));
    const session = await page.request.get(`${fixture.origin}/v1/web/session`);
    return session.ok()
      ? route.fulfill({ json: { redirectUrl: callback } })
      : route.fulfill({
          status: 401,
          json: { error: { code: 'unauthenticated', messageKey: 'errors.unauthenticated' } },
        });
  });
  await page.goto(`${fixture.origin}/dashboard/authorize?${params}`, { waitUntil: 'commit' });
}

it('uses the current panel session when visiting a dashboard bookmark', async () => {
  await open(users.user);
  await visible(users.user).toHaveURL(callback);
});

it('returns an initially signed-out browser to the same instance after ordinary login', async () => {
  const guest = await fixture.page();
  // The three setup identities all sign in from the same isolated browser host.
  await fixture.database.db.deleteFrom('rateLimit').execute();
  await open(guest);
  await visible(guest.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await guest.getByLabel('Email', { exact: true }).fill('owner@journey.example.test');
  await guest.getByLabel('Password', { exact: true }).fill(browserPassword);
  await guest.getByRole('button', { name: 'Sign in', exact: true }).click();
  await visible(guest).toHaveURL(callback);
});
