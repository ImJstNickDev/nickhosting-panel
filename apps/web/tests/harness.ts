import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { SecretCodec } from '@nickhosting/core';
import { saveBootstrapConfiguration } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { validateConnection } from '@nickhosting/pterodactyl-adapter';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { type Browser, chromium, type Page } from '@playwright/test';
import { createServer as createViteServer } from 'vite';
import { createApp } from '../../api/src/app.js';
import { createApiHttpServer } from '../../api/src/http-server.js';

export const browserPassword = 'Browser-only-password-697!';
export async function browserHarness(
  options: { discord?: { clientId: string; clientSecret: string } } = {},
) {
  const database = await createTestDatabase();
  const mails: IdentityMail[] = [];
  const errors: unknown[] = [];
  const setupToken = randomBytes(32).toString('base64url');
  const codec = new SecretCodec({
    activeKeyId: 'browser-test',
    keys: { 'browser-test': randomBytes(32) },
  });
  let app: ReturnType<typeof createApp>,
    vite: Awaited<ReturnType<typeof createViteServer>> | undefined,
    browser: Browser | undefined;
  let management: ManagementRuntime | undefined;
  const listener = createApiHttpServer((request, response) => {
    if (request.url?.startsWith('/v1/') || request.url?.startsWith('/api/auth/'))
      getRequestListener(app.fetch)(request, response);
    else
      vite?.middlewares(request, response, () => {
        response.writeHead(404);
        response.end();
      });
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated browser listener');
  const origin = `http://localhost:${address.port}`;
  const env: Record<string, string | undefined> = {
    NH_PUBLIC_URL: origin,
    NH_API_URL: origin,
    SMTP_HOST: 'mail.example.test',
    SMTP_FROM: 'NickHosting <test@example.test>',
    ...(options.discord
      ? {
          DISCORD_CLIENT_ID: options.discord.clientId,
          DISCORD_CLIENT_SECRET: options.discord.clientSecret,
        }
      : {}),
  };
  try {
    const identity = createIdentity({
      pool: database.pool,
      baseURL: origin,
      publicURL: origin,
      authSecret: randomBytes(32).toString('base64url'),
      bootstrapToken: setupToken,
      ...(options.discord ? { discord: options.discord } : {}),
      mail: async (mail) => {
        mails.push(mail);
      },
      completeSetup: async (tx, input, actor) => {
        await validateConnection(
          {
            baseURL: input.pterodactylBaseURL,
            applicationKey: input.pterodactylApplicationKey,
            clientKey: input.pterodactylClientKey,
          },
          async () => Response.json({ object: 'list', data: [] }),
        );
        await saveBootstrapConfiguration(tx, codec, input, actor, env);
      },
    });
    app = createApp({
      database,
      identity: async () => identity,
      codec,
      env,
      origins: [origin],
      management: async () => {
        if (!management) throw new Error('Browser provider fixture not installed');
        return management;
      },
      log: (event) => errors.push(event),
    });
    vite = await createViteServer({
      root: resolve('apps/web'),
      configFile: resolve('apps/web/vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: false,
        ws: { server: listener, clientPort: address.port },
      },
      appType: 'spa',
      logLevel: 'error',
    });
    const libs = resolve(
      homedir(),
      '.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu',
    );
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(libs)
        ? {
            env: {
              ...process.env,
              LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
            },
          }
        : {}),
    });
    const screenshotRoot = resolve('.codex/local/m5-browser/screenshots');
    await mkdir(screenshotRoot, { recursive: true });
    return {
      database,
      identity,
      codec,
      env,
      mails,
      errors,
      origin,
      setupToken,
      browser,
      setManagement(value: ManagementRuntime) {
        management = value;
      },
      async page(locale: 'en' | 'it' | 'pseudo' = 'en', mobile = false) {
        const context = await browser!.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          locale: locale === 'it' ? 'it-IT' : 'en-GB',
          reducedMotion: 'reduce',
        });
        await context.addInitScript((value) => localStorage.setItem('nh.locale', value), locale);
        const page = await context.newPage();
        return page;
      },
      async screenshot(page: Page, name: string) {
        await page.screenshot({
          path: resolve(screenshotRoot, `${name}.png`),
          fullPage: true,
          maskColor: '#c8d2d9',
          mask: [
            page.locator('input[type="password"]:not(:placeholder-shown)'),
            page.locator('input[autocomplete="off"]'),
          ],
        });
      },
      async close() {
        await browser?.close();
        await vite?.close();
        listener.closeAllConnections();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        await database.destroy();
      },
    };
  } catch (error) {
    await browser?.close();
    await vite?.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await database.destroy();
    throw error;
  }
}
