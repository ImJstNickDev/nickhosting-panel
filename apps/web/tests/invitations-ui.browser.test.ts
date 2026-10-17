import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  expect as browserExpect,
  chromium,
  type Page,
} from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Invitation } from '../src/features/owner-invitations-api.js';

const future = '2035-10-13T12:00:42.000Z';
const link = 'https://panel.example.test/register?invite=frontend-fixture-token';
const screenshots = '.codex/local/m5-browser/screenshots';

function fixtures(): Invitation[] {
  const base = {
    role: 'user' as const,
    maxUses: 5,
    remainingUses: 2,
    expiresAt: future,
    revokedAt: null,
    linkAvailable: true,
  };
  return [
    { ...base, id: 'active', email: 'active@example.test' },
    { ...base, id: 'expired', email: 'expired@example.test', expiresAt: '2020-01-01T00:00:00Z' },
    { ...base, id: 'exhausted', email: 'exhausted@example.test', remainingUses: 0 },
    { ...base, id: 'revoked', email: 'revoked@example.test', revokedAt: '2026-01-01T00:00:00Z' },
    { ...base, id: 'legacy', email: 'legacy@example.test', linkAvailable: false },
  ];
}

describe('Owner invitation UI against the proposed API contract (isolated fixtures)', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let origin: string;
  let locale: 'en' | 'it';
  let invitations: Invitation[];
  let linkFails: boolean;
  let editFails: boolean;
  let linkRequests: string[];
  let patches: Array<{ id: string; body: Record<string, unknown> }>;
  let deletions: string[];
  let errors: string[];

  beforeAll(async () => {
    server = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/invitations-test-vite`,
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    origin = server.resolvedUrls?.local[0] ?? '';
    if (!origin) throw new Error('Isolated Vite server did not return a local URL');
    browser = await chromium.launch({
      headless: true,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`,
      },
    });
    await mkdir(screenshots, { recursive: true });
  });

  beforeEach(async () => {
    locale = 'en';
    invitations = fixtures();
    linkFails = false;
    editFails = false;
    linkRequests = [];
    patches = [];
    deletions = [];
    errors = [];
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value: string) => sessionStorage.setItem('copied-link', value) },
      });
    });
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const person = {
        id: 'invitation-ui-owner',
        name: 'Morgan Rossi',
        email: 'morgan@example.test',
        emailVerified: true,
        locale,
        role: 'owner',
        twoFactorEnabled: false,
      };
      if (path === '/v1/web/config')
        return route.fulfill({
          json: { instanceName: 'NickHosting', defaultLocale: locale, auth: { email: true } },
        });
      if (path === '/v1/setup')
        return route.fulfill({ json: { ownerClaimed: true, completed: true } });
      if (path === '/v1/web/session')
        return route.fulfill({
          json: {
            context: {
              actorUserId: person.id,
              subjectUserId: person.id,
              role: 'owner',
              sessionType: 'regular',
              ownerElevation: false,
            },
            actor: person,
            subject: person,
          },
        });
      if (path === '/v1/owner/invitations' && method === 'GET')
        return route.fulfill({ json: invitations });
      if (path === '/v1/owner/invitations' && method === 'POST') {
        const body = route.request().postDataJSON();
        const created: Invitation = {
          id: 'created',
          email: body.email ?? null,
          role: body.role,
          maxUses: body.maxUses,
          remainingUses: body.maxUses,
          expiresAt: body.expiresAt ?? future,
          revokedAt: null,
        };
        invitations.push(created);
        // The existing create response intentionally omits linkAvailable and other list fields.
        return route.fulfill({ json: { id: created.id, url: link, expiresAt: created.expiresAt } });
      }
      const match = path.match(/^\/v1\/owner\/invitations\/([^/]+)(\/link)?$/);
      if (match) {
        const id = match[1] ?? '';
        if (method === 'GET' && match[2]) {
          linkRequests.push(id);
          return route.fulfill(
            linkFails
              ? { status: 404, json: { code: 'not_found' } }
              : { json: { url: link }, headers: { 'Cache-Control': 'no-store' } },
          );
        }
        if (method === 'PATCH') {
          const body = route.request().postDataJSON();
          patches.push({ id, body });
          if (editFails) return route.fulfill({ status: 500, json: { code: 'internal_error' } });
          const invite = invitations.find((entry) => entry.id === id);
          if (!invite) throw new Error(`Unknown fixture invitation: ${id}`);
          const consumed = invite.maxUses - invite.remainingUses;
          Object.assign(invite, {
            expiresAt: body.expiresAt,
            maxUses: body.maxUses,
            remainingUses: body.maxUses - consumed,
          });
          return route.fulfill({ json: invite });
        }
        if (method === 'DELETE') {
          deletions.push(id);
          const invite = invitations.find((entry) => entry.id === id);
          if (!invite) throw new Error(`Unknown fixture invitation: ${id}`);
          invite.revokedAt = new Date().toISOString();
          return route.fulfill({ status: 204 });
        }
      }
      errors.push(`Unmocked request: ${method} ${path}`);
      return route.fulfill({ status: 404, json: { code: 'not_found' } });
    });
    await page.route('**/api/auth/**', (route) => route.fulfill({ json: [] }));
  });

  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function open() {
    await page.goto(`${origin}owner/invitations`);
    await browserExpect(page.getByText('active@example.test', { exact: true })).toBeVisible({
      timeout: 30000,
    });
  }
  function row(id: string) {
    return page
      .getByRole('row')
      .filter({ has: page.getByText(`${id}@example.test`, { exact: true }) });
  }
  async function accessible(selector: string) {
    const result = await new AxeBuilder({ page })
      .include(selector)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
    ).toEqual([]);
  }

  it('renders all lifecycle states with appropriate actions and an accessible desktop layout', async () => {
    await open();
    for (const [id, status] of [
      ['active', 'Active'],
      ['expired', 'Expired'],
      ['exhausted', 'Used up'],
      ['revoked', 'Revoked'],
    ])
      await browserExpect(row(id ?? '').getByText(status ?? '', { exact: true })).toBeVisible();
    await browserExpect(row('active').getByText('3 / 5', { exact: true })).toBeVisible();
    await browserExpect(row('active').getByRole('button')).toHaveCount(3);
    await browserExpect(row('expired').getByRole('button')).toHaveCount(2);
    await browserExpect(row('exhausted').getByRole('button')).toHaveCount(2);
    await browserExpect(row('revoked').getByRole('button')).toHaveCount(0);
    await page.screenshot({ path: `${screenshots}/invitations-desktop-en.png` });
    await accessible('main');
  });

  it('creates with the existing response and retains the one-time link while mounted', async () => {
    await open();
    await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Email (Optional)', { exact: true }).fill('created@example.test');
    await dialog.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await browserExpect(dialog).toHaveAccessibleName('Invitation link');
    await browserExpect(dialog.getByLabel('Invitation link', { exact: true })).toHaveValue(link);
    await browserExpect(
      dialog.getByText('Copy this link now. It cannot be retrieved again.', { exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await row('created').getByRole('button', { name: 'Show link: created@example.test' }).click();
    await browserExpect(dialog.getByLabel('Invitation link', { exact: true })).toHaveValue(link);
    expect(linkRequests).toEqual([]);
  });

  it('recovers and copies a link, selects it on clipboard failure and restores Escape focus', async () => {
    await open();
    const trigger = row('active').getByRole('button', { name: 'Show link: active@example.test' });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    const input = dialog.getByLabel('Invitation link', { exact: true });
    await browserExpect(input).toHaveValue(link);
    await browserExpect(input).toBeFocused();
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await browserExpect(dialog.getByRole('status')).toHaveText('Copied');
    expect(await page.evaluate(() => sessionStorage.getItem('copied-link'))).toBe(link);
    await page.screenshot({ path: `${screenshots}/invitations-link-desktop-en.png` });
    await accessible('dialog[open]');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('Clipboard denied by fixture');
          },
        },
      });
    });
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await browserExpect(dialog.getByRole('alert')).toHaveText(
      'Could not copy the link. Select it and copy it manually.',
    );
    await browserExpect(input).toBeFocused();
    expect(
      await input.evaluate((element: HTMLInputElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([0, link.length]);
    await page.keyboard.press('Escape');
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(trigger).toBeFocused();
    expect(linkRequests.length).toBeGreaterThanOrEqual(1);
    expect(linkRequests.every((id) => id === 'active')).toBe(true);
  });

  it('exposes a missing recovery API as a retryable error and explains legacy links without a request', async () => {
    await open();
    linkFails = true;
    await row('active').getByRole('button', { name: 'Show link: active@example.test' }).click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByRole('alert')).toBeVisible();
    const initialRequests = linkRequests.length;
    await browserExpect(dialog.getByLabel('Invitation link', { exact: true })).toHaveCount(0);
    linkFails = false;
    await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
    await browserExpect(dialog.getByLabel('Invitation link', { exact: true })).toHaveValue(link);
    await page.keyboard.press('Escape');
    await row('legacy').getByRole('button', { name: 'Show link: legacy@example.test' }).click();
    await browserExpect(dialog.getByRole('status')).toHaveText(
      'This invitation’s link cannot be retrieved. Create a new invitation if you no longer have it.',
    );
    expect(linkRequests.length).toBe(initialRequests + 1);
    expect(linkRequests.every((id) => id === 'active')).toBe(true);
  });

  it('edits only expiry and use limit, validates consumed uses and retains a failed draft', async () => {
    await open();
    await row('active')
      .getByRole('button', { name: 'Edit invitation: active@example.test' })
      .click();
    const dialog = page.getByRole('dialog');
    const uses = dialog.getByLabel('Maximum uses', { exact: true });
    const expiry = dialog.getByLabel('Expires', { exact: true });
    await browserExpect(uses).toHaveAttribute('min', '3');
    await browserExpect(
      dialog.getByText('The recipient and role cannot be changed.', { exact: true }),
    ).toBeVisible();
    await uses.fill('2');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect(patches).toEqual([]);
    await uses.fill('8');
    await expiry.fill('2036-04-05T12:30');
    editFails = true;
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(dialog.getByRole('alert')).toBeVisible();
    await browserExpect(uses).toHaveValue('8');
    await browserExpect(expiry).toHaveValue('2036-04-05T12:30');
    expect(Object.keys(patches[0]?.body ?? {}).sort()).toEqual(['expiresAt', 'maxUses']);
    expect(patches[0]?.body.maxUses).toBe(8);
    expect(patches[0]?.body.expiresAt).toMatch(/^2036-04-05T\d{2}:30:00\.000Z$/);
    await page.screenshot({ path: `${screenshots}/invitations-edit-error-desktop-en.png` });
    editFails = false;
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(row('active').getByText('3 / 8', { exact: true })).toBeVisible();
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual(patches[0]);
    await row('exhausted')
      .getByRole('button', { name: 'Edit invitation: exhausted@example.test' })
      .click();
    await browserExpect(
      dialog.getByText(
        'Extending the expiration or increasing uses can make this invitation usable again.',
        { exact: true },
      ),
    ).toBeVisible();
    await browserExpect(dialog.getByLabel('Maximum uses', { exact: true })).toHaveAttribute(
      'min',
      '5',
    );
    await dialog.getByLabel('Maximum uses', { exact: true }).fill('6');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    expect(patches[2]?.body).toEqual({ expiresAt: future, maxUses: 6 });
    await browserExpect(row('exhausted').getByText('Active', { exact: true })).toBeVisible();
  });

  it('requires explicit revoke confirmation, cancels without a request and retains the revoked row', async () => {
    await open();
    const trigger = row('active').getByRole('button', {
      name: 'Revoke invitation: active@example.test',
    });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await browserExpect(
      dialog.getByText(
        'This link will no longer allow registration. Existing accounts are unaffected.',
        { exact: true },
      ),
    ).toBeVisible();
    expect(deletions).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(deletions).toEqual([]);
    await browserExpect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(row('active').getByText('Revoked', { exact: true })).toBeVisible();
    await browserExpect(row('active').getByRole('button')).toHaveCount(0);
    expect(deletions).toEqual(['active']);
    await browserExpect(
      page.getByRole('button', { name: 'Create invitation', exact: true }),
    ).toBeFocused();
  });

  it('renders Italian mobile list and link/edit dialogs without document overflow', async () => {
    locale = 'it';
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await browserExpect(page.getByRole('heading', { name: 'Inviti', exact: true })).toBeVisible();
    await page.screenshot({ path: `${screenshots}/invitations-mobile-it.png` });
    const actionBounds = await row('active')
      .getByRole('button', { name: 'Mostra link: active@example.test' })
      .boundingBox();
    expect(actionBounds).not.toBeNull();
    expect(actionBounds?.x).toBeGreaterThanOrEqual(0);
    expect((actionBounds?.x ?? 0) + (actionBounds?.width ?? 0)).toBeLessThanOrEqual(390);
    expect((actionBounds?.y ?? 0) + (actionBounds?.height ?? 0)).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await accessible('main');
    await row('active').getByRole('button', { name: 'Mostra link: active@example.test' }).click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByLabel('Link di invito', { exact: true })).toHaveValue(link);
    await page.screenshot({ path: `${screenshots}/invitations-link-mobile-it.png` });
    await accessible('dialog[open]');
    await page.keyboard.press('Escape');
    await row('active')
      .getByRole('button', { name: 'Modifica invito: active@example.test' })
      .click();
    await browserExpect(dialog).toHaveAccessibleName('Modifica invito');
    await page.screenshot({ path: `${screenshots}/invitations-edit-mobile-it.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await accessible('dialog[open]');
  });
});
