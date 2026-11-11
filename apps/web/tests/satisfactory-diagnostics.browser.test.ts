import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect } from '@playwright/test';
import { expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

it('opens bounded Satisfactory diagnostics through the existing Fileman shell', async () => {
  const harness = await browserHarness();
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>> | undefined;
  try {
    const identities = await prepareJourneyIdentities(harness);
    const page = identities.user;
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    const id = provider.ids.serverId;
    const beforeOperations = await harness.database.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', id)
      .execute();
    const files = await provider.files();
    files.clear();
    files.set(
      'FactoryGame.log',
      Buffer.from(
        'LogInit: Display: Starting server\nLogGame: Warning: Missing optional configuration\nLogGame: Error: Example diagnostic\n',
      ),
    );
    files.set('Empty.log', Buffer.alloc(0));
    files.set(
      'Large.log',
      Buffer.from(`${'LogInit: Display: old line\n'.repeat(5000)}LogGame: Error: Tail marker\n`),
    );
    files.set('Unavailable.log', Buffer.from('cannot read'));

    files.set(
      'CrashContext.runtime-xml',
      Buffer.from(
        '<FGenericCrashContext><RuntimeProperties><CrashType>Crash</CrashType><ErrorMessage>Factory diagnostic crash</ErrorMessage><GameName>FactoryGame</GameName><EngineVersion>5.3.2</EngineVersion><CallStack>FactoryServer!ExampleFrame</CallStack></RuntimeProperties></FGenericCrashContext>',
      ),
    );
    files.set('Broken.runtime-xml', Buffer.from('<FGenericCrashContext>'));
    files.set(
      'cert_chain.pem',
      Buffer.from(`-----BEGIN CERTIFICATE-----
MIIDdDCCAlygAwIBAgIUcyMOPY+3aXlE7WLTRxFBGkhr3hkwDQYJKoZIhvcNAQEL
BQAwOTEdMBsGA1UEAwwUZmFjdG9yeS5leGFtcGxlLnRlc3QxGDAWBgNVBAoMD0Jy
b3dzZXIgRml4dHVyZTAeFw0yNjExMTEwMjIzNTlaFw0zNjExMDgwMjIzNTlaMDkx
HTAbBgNVBAMMFGZhY3RvcnkuZXhhbXBsZS50ZXN0MRgwFgYDVQQKDA9Ccm93c2Vy
IEZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQClPOchKL2d
m0RP9LdD/fTSIp1TW0P4mUHgaSXvh4jic/MaoqNOZ+XCbjra8qlz4wQr80tWebwU
dpPVsckSTxKxTiaHp3yMoTPNJmzru3MqSVwSB3qeV/pPjKCDWTSHqA14E8y8qg6v
yFyirY13TTPr7wRrUJLihmMIRzftCGVOD7DnGJCJ8di8k7gPRKteCpjE1MaEjFmO
0CQ7tTKI+mlF1W9VphaFOS3OUKG/kA2KpXs0wZVU0c5xyGMtrGs6KYHi9cJzV4Oy
kznZs1UzP8IdkkuwAfZY6+KpBZxJLRkfhVV9rcPbPCjj++sT8+cDjIxnniZ2rz6V
MQ7pkZF4r9olAgMBAAGjdDByMB0GA1UdDgQWBBRwVehA6k1s/ukcSzQ85ZqNWSYT
zDAfBgNVHSMEGDAWgBRwVehA6k1s/ukcSzQ85ZqNWSYTzDAPBgNVHRMBAf8EBTAD
AQH/MB8GA1UdEQQYMBaCFGZhY3RvcnkuZXhhbXBsZS50ZXN0MA0GCSqGSIb3DQEB
CwUAA4IBAQBoReA0Rigi6QmUVObuUbidTtxkbA+BC2dDRfHwUhqd6+5+sk1Z0Ikm
NvAs4oRAFNltQTK6FjTajn1DySeHgr5F/S7yJttoI2Qmc+QGrlvNNVDyhIiwDVcG
45ciQmqXoGq9WXzJbxl3AiaZ0gZg9eAIGgdb22qNLe+dOnmo+FuSeQUtNhAtgntc
s9BVfLDr9FRRRF4Jtzthx6inXnM2V1R8l3tOxmv4U/3QrSWjad1lmi0ToBPnNl1M
jAK66psczflXAtW8flPF70ThNubjC70G25UiFxaQyRWmO9kOC7Nds8TS6CCUZZL5
w0RLozHnei051W51+srovbeS+CruyOGw
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDdDCCAlygAwIBAgIUcyMOPY+3aXlE7WLTRxFBGkhr3hkwDQYJKoZIhvcNAQEL
BQAwOTEdMBsGA1UEAwwUZmFjdG9yeS5leGFtcGxlLnRlc3QxGDAWBgNVBAoMD0Jy
b3dzZXIgRml4dHVyZTAeFw0yNjExMTEwMjIzNTlaFw0zNjExMDgwMjIzNTlaMDkx
HTAbBgNVBAMMFGZhY3RvcnkuZXhhbXBsZS50ZXN0MRgwFgYDVQQKDA9Ccm93c2Vy
IEZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQClPOchKL2d
m0RP9LdD/fTSIp1TW0P4mUHgaSXvh4jic/MaoqNOZ+XCbjra8qlz4wQr80tWebwU
dpPVsckSTxKxTiaHp3yMoTPNJmzru3MqSVwSB3qeV/pPjKCDWTSHqA14E8y8qg6v
yFyirY13TTPr7wRrUJLihmMIRzftCGVOD7DnGJCJ8di8k7gPRKteCpjE1MaEjFmO
0CQ7tTKI+mlF1W9VphaFOS3OUKG/kA2KpXs0wZVU0c5xyGMtrGs6KYHi9cJzV4Oy
kznZs1UzP8IdkkuwAfZY6+KpBZxJLRkfhVV9rcPbPCjj++sT8+cDjIxnniZ2rz6V
MQ7pkZF4r9olAgMBAAGjdDByMB0GA1UdDgQWBBRwVehA6k1s/ukcSzQ85ZqNWSYT
zDAfBgNVHSMEGDAWgBRwVehA6k1s/ukcSzQ85ZqNWSYTzDAPBgNVHRMBAf8EBTAD
AQH/MB8GA1UdEQQYMBaCFGZhY3RvcnkuZXhhbXBsZS50ZXN0MA0GCSqGSIb3DQEB
CwUAA4IBAQBoReA0Rigi6QmUVObuUbidTtxkbA+BC2dDRfHwUhqd6+5+sk1Z0Ikm
NvAs4oRAFNltQTK6FjTajn1DySeHgr5F/S7yJttoI2Qmc+QGrlvNNVDyhIiwDVcG
45ciQmqXoGq9WXzJbxl3AiaZ0gZg9eAIGgdb22qNLe+dOnmo+FuSeQUtNhAtgntc
s9BVfLDr9FRRRF4Jtzthx6inXnM2V1R8l3tOxmv4U/3QrSWjad1lmi0ToBPnNl1M
jAK66psczflXAtW8flPF70ThNubjC70G25UiFxaQyRWmO9kOC7Nds8TS6CCUZZL5
w0RLozHnei051W51+srovbeS+CruyOGw
-----END CERTIFICATE-----
`),
    );
    files.set('private_key.pem', Buffer.from('PRIVATE FIXTURE CONTENT'));
    const fileBytes = new Map([...files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
    const fixtureBytes = (name: string) => {
      const bytes = fileBytes.get(name);
      if (!bytes) throw new Error('Missing browser fixture');
      return bytes;
    };
    const writes: string[] = [];
    const contentReads: { path: string; range: string }[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      // Directory batching is an existing read-only POST endpoint.
      if (
        path.startsWith(`/v1/servers/${id}/files`) &&
        path !== `/v1/servers/${id}/files/directories` &&
        !['GET', 'HEAD'].includes(request.method())
      )
        writes.push(`${request.method()} ${path}`);
    });
    await page.route(`**/v1/platform/servers/${id}`, async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      return route.fulfill({
        json: { ...value, gameId: 'satisfactory', runtimeId: 'satisfactory' },
      });
    });
    const revision = (body: Buffer) => createHash('sha256').update(body).digest('hex');
    await page.route(
      (url) => url.pathname === `/v1/servers/${id}/files/viewer`,
      async (route) => {
        const body = files.get(new URL(route.request().url()).searchParams.get('path') ?? '');
        if (!body) return route.fulfill({ status: 404, json: { code: 'not_found' } });
        return route.fulfill({
          json: { revision: revision(body), size: body.length, mtimeMs: 1700000000000 },
        });
      },
    );
    await page.route(`**/v1/servers/${id}/files/viewer/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/capabilities'))
        return route.fulfill({ json: { available: true } });
      if (url.pathname.endsWith('/preferences'))
        return route.fulfill({ json: { preferences: [] } });
      if (!url.pathname.endsWith('/content')) return route.fulfill({ status: 404 });
      const path = url.searchParams.get('path') ?? '';
      if (path === 'Unavailable.log')
        return route.fulfill({ status: 503, json: { code: 'integration_unavailable' } });
      const body = files.get(path);
      if (!body) return route.fulfill({ status: 404, json: { code: 'not_found' } });
      const range = route.request().headers().range ?? '';
      contentReads.push({ path, range });
      if (!range) return route.fulfill({ body, contentType: 'application/octet-stream' });
      expect(route.request().headers()['if-match']).toBe(`"${revision(body)}"`);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) return route.fulfill({ status: 400 });
      const start = Number(match[1]),
        end = Math.min(Number(match[2]), body.length - 1);
      return route.fulfill({
        status: 206,
        body: body.subarray(start, end + 1),
        contentType: 'application/octet-stream',
        headers: {
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        },
      });
    });
    const base = `${harness.origin}/servers/${id}/files`;
    await page.goto(base);
    const open = async (name: string) =>
      page.locator('.fm-filename').getByText(name, { exact: true }).click();
    const back = async () =>
      page.getByRole('button', { name: /^(Back to files|Torna ai file)$/ }).click();
    await open('FactoryGame.log');
    const log = page.locator('.satisfactory-log-viewer');
    await browserExpect(log).toContainText('Example diagnostic');
    await log.getByLabel('Filter lines', { exact: true }).fill('Missing');
    await browserExpect(log).toContainText('Missing optional configuration');
    await browserExpect(log).not.toContainText('Example diagnostic');
    await log.getByLabel('Filter lines', { exact: true }).fill('');
    await log.getByRole('combobox').selectOption({ label: 'Errors' });
    await browserExpect(log).toContainText('Example diagnostic');
    await browserExpect(log).not.toContainText('Missing optional configuration');
    await log.getByRole('combobox').selectOption({ label: 'All levels' });
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: 'test-results/satisfactory-log-desktop-en.png', fullPage: true });
    files.set('FactoryGame.log', Buffer.from('LogGame: Display: Refreshed server status\n'));
    await log.getByRole('button', { name: 'Refresh', exact: true }).click();
    await browserExpect(log).toContainText('Refreshed server status');
    await back();
    files.set('FactoryGame.log', fixtureBytes('FactoryGame.log'));
    await open('Large.log');
    await browserExpect(log).toContainText('Tail marker');
    await log.getByLabel('Filter lines', { exact: true }).fill('Tail marker');
    await browserExpect(log).toContainText('Tail marker');
    const largeRead = contentReads.find((read) => read.path === 'Large.log');
    expect(largeRead?.range).toBe(
      `bytes=${fixtureBytes('Large.log').length - 65536}-${fixtureBytes('Large.log').length - 1}`,
    );
    await back();
    await open('Unavailable.log');
    await browserExpect(log.getByRole('alert')).toBeVisible();
    await back();
    await open('Empty.log');
    await browserExpect(log).toContainText('No log lines.');
    await back();
    await open('CrashContext.runtime-xml');
    const diagnostic = page.locator('.satisfactory-diagnostic-viewer');
    await browserExpect(diagnostic).toContainText('Factory diagnostic crash');
    await browserExpect(diagnostic).toContainText('FactoryServer!ExampleFrame');
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({
      path: 'test-results/satisfactory-crash-desktop-en.png',
      fullPage: true,
    });
    await back();
    await open('cert_chain.pem');
    await browserExpect(
      diagnostic.getByRole('heading', { name: 'Certificate 2', exact: true }),
    ).toBeVisible();
    await browserExpect(diagnostic).toContainText('factory.example.test');
    await browserExpect(diagnostic).toContainText('SHA-256');
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({
      path: 'test-results/satisfactory-certificate-desktop-en.png',
      fullPage: true,
    });
    await back();
    await open('private_key.pem');
    await browserExpect(diagnostic).toHaveCount(0);
    const beforePrivateRead = contentReads.length;
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    await browserExpect(
      page.getByRole('dialog').getByRole('button', { name: 'Public certificate', exact: true }),
    ).toHaveCount(0);
    expect(contentReads.length).toBe(beforePrivateRead);
    await page.keyboard.press('Escape');
    await back();
    files.set('CrashContext.runtime-xml', Buffer.from('<FGenericCrashContext>'));
    await open('CrashContext.runtime-xml');
    await browserExpect(diagnostic.getByRole('alert')).toBeVisible();
    await page.screenshot({ path: 'test-results/satisfactory-crash-error-en.png', fullPage: true });
    await back();
    files.set('CrashContext.runtime-xml', fixtureBytes('CrashContext.runtime-xml'));
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}?directory=`);
    await open('cert_chain.pem');
    await browserExpect(diagnostic).toContainText('factory.example.test');
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: 'test-results/satisfactory-certificate-mobile-it.png',
      fullPage: true,
    });
    await back();
    await open('CrashContext.runtime-xml');
    await browserExpect(diagnostic).toContainText('Factory diagnostic crash');
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({
      path: 'test-results/satisfactory-crash-mobile-it.png',
      fullPage: true,
    });
    await back();
    await open('FactoryGame.log');
    await browserExpect(log).toContainText('Example diagnostic');
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: 'test-results/satisfactory-log-mobile-it.png', fullPage: true });
    expect(
      contentReads
        .filter(({ path }) => ['CrashContext.runtime-xml', 'cert_chain.pem'].includes(path))
        .every(({ range }) => range === 'bytes=0-65535'),
    ).toBe(true);
    expect(writes).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect([...files]).toEqual([...fileBytes]);
    expect(
      await harness.database.db
        .selectFrom('server_operations')
        .select('job_id')
        .where('server_id', '=', id)
        .execute(),
    ).toEqual(beforeOperations);
  } finally {
    provider?.dispose();
    await harness.close();
  }
}, 180000);
