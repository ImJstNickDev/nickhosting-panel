import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import { type ContentPolicyOverride, resolveConfig, resolveContentPolicy } from '@nickhosting/core';
import {
  type Browser,
  type BrowserContext,
  expect as check,
  firefox,
  type Page,
} from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('integration policy forms (real React, isolated API responses)', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let policy: ContentPolicyOverride,
    locked: boolean,
    messages: Record<string, unknown>,
    writes: Record<string, unknown>[];
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/integration-forms-vite`,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await vite.listen();
    origin = vite.resolvedUrls?.local[0] ?? '';
    browser = await firefox.launch({
      headless: true,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`,
      },
    });
    await mkdir('.codex/local/m5-browser/screenshots', { recursive: true });
  });
  beforeEach(async () => {
    policy = {};
    locked = false;
    messages = { motd: { waking: { en: 'Starting', it: 'Avvio' } } };
    writes = [];
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('nh.locale', 'en');
    });
    await page.route('**/policy-forms/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>Integration settings</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/integration-policy-forms.tsx"></script></body></html>',
      }),
    );
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (path.endsWith('/content-policy')) policy = body;
        else messages = body.minecraftGatewayResponses;
      }
      if (path.endsWith('/content-policy')) {
        const config = resolveConfig(
          { contentSourceConcurrent: 4, gameContentPolicies: { minecraft: policy } },
          locked ? { NH_GAME_CONTENT_POLICIES: JSON.stringify({ minecraft: policy }) } : {},
        );
        return route.fulfill({
          json: { policy, locked, effective: resolveContentPolicy(config, 'minecraft') },
        });
      }
      return route.fulfill({
        json: {
          config: {
            values: { minecraftGatewayResponses: messages },
            lockedKeys: locked ? ['minecraftGatewayResponses'] : [],
          },
        },
      });
    });
  });
  afterEach(async () => {
    await context.close();
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  it('saves only explicit overrides and restores inheritance by clearing them', async () => {
    await page.goto(`${origin}policy-forms/content`);
    const concurrent = page.getByLabel('Concurrent content operations', { exact: true });
    await check(concurrent).toHaveValue('');
    await check(concurrent).toHaveAttribute('placeholder', 'Inherit: 4');
    await concurrent.fill('2');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await check.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({ sourceConcurrent: 2 });
    await check(concurrent).toHaveValue('2');
    await concurrent.fill('');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await check.poll(() => writes.length).toBe(2);
    expect(writes[1]).toEqual({});
    await check(concurrent).toHaveValue('');
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/integration-content-desktop-en.png',
      fullPage: true,
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
  it('honors environment locks without allowing a form write', async () => {
    locked = true;
    await page.goto(`${origin}policy-forms/content`);
    await check(page.getByLabel('Concurrent content operations', { exact: true })).toBeDisabled();
    await check(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    expect(writes).toEqual([]);
  });
  it('edits one response without losing other states and retains drafts across selectors', async () => {
    await page.goto(`${origin}policy-forms/messages`);
    await page.getByLabel('English', { exact: true }).fill('Sleeping');
    await page.getByLabel('Italian', { exact: true }).fill('Sospeso');
    await page.getByLabel('Status', { exact: true }).selectOption('waking');
    await check(page.getByLabel('English', { exact: true })).toHaveValue('Starting');
    await page.getByLabel('Status', { exact: true }).selectOption('sleeping');
    await check(page.getByLabel('English', { exact: true })).toHaveValue('Sleeping');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await check.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({
      minecraftGatewayResponses: {
        motd: {
          waking: { en: 'Starting', it: 'Avvio' },
          sleeping: { en: 'Sleeping', it: 'Sospeso' },
        },
      },
    });
  });
  it.each(['English', 'Italian'])(
    'does not save a blank alternate locale when only %s is filled',
    async (language) => {
      await page.goto(`${origin}policy-forms/messages`);
      await page.getByLabel(language, { exact: true }).fill('Custom text');
      await page.getByLabel('Status', { exact: true }).selectOption('waking');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await check(page.getByRole('alert')).toContainText('Complete both languages');
      await check(page.getByLabel('Status', { exact: true })).toHaveValue('sleeping');
      expect(writes).toEqual([]);
    },
  );
  it('fits Italian content limits on mobile with readable labels and keyboard focus', async () => {
    await page.addInitScript(() => {
      localStorage.setItem('nh.locale', 'it');
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}policy-forms/content`);
    await check(page.getByRole('heading', { name: 'Limiti contenuti', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByLabel('Operazioni contenuti simultanee', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await check(page.getByLabel('Operazioni simultanee per utente', { exact: true })).toBeFocused();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/integration-content-mobile-it.png',
      fullPage: true,
    });
  });
});
