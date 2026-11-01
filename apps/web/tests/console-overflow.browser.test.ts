import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { ConsoleRelayOptions } from '@nickhosting/pterodactyl-adapter';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmConsoleFixtureAddress } from './console-fixture.js';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 Console bounded output', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  const streams = new Set<ConsoleRelayOptions>();
  const errors: string[] = [];

  beforeAll(async () => {
    fixture = await browserHarness();
    const identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    user.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    await confirmConsoleFixtureAddress(fixture.database.db, provider.ids.serverId);
    fixture.setManagement(provider.management);
    const original = provider.adapter.relayConsole;
    provider.adapter.relayConsole = async (id, input) => {
      const relay = await original(id, input);
      if (!input.signal?.aborted) {
        streams.add(input);
        input.signal?.addEventListener('abort', () => streams.delete(input), { once: true });
      }
      return relay;
    };
    base = `${fixture.origin}/servers/${provider.ids.serverId}/console`;
  });

  afterAll(async () => {
    provider?.dispose();
    streams.clear();
    await fixture?.close();
  });

  function emit(data: string) {
    if (!streams.size) throw new Error('Fixture console is not attached');
    for (const stream of streams)
      if (!stream.signal?.aborted) stream.onEvent({ type: 'console', data });
  }

  async function geometry() {
    return user.evaluate(() => {
      const terminal = document.querySelector('.console-terminal');
      const output = document.querySelector('.console');
      const prompt = document.querySelector('.console-prompt');
      const cards = document.querySelectorAll('.console-summary-card');
      if (!terminal || !output || !prompt || !cards.length)
        throw new Error('Console layout missing');
      const bounds = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        terminal: bounds(terminal),
        output: bounds(output),
        prompt: bounds(prompt),
        firstCard: bounds(cards[0] as Element),
        lastCard: bounds(cards[cards.length - 1] as Element),
        scrollHeight: output.scrollHeight,
        clientHeight: output.clientHeight,
        scrollWidth: output.scrollWidth,
        clientWidth: output.clientWidth,
        bodyWidth: document.documentElement.scrollWidth,
        bodyHeight: document.documentElement.scrollHeight,
        viewportWidth: innerWidth,
      };
    });
  }

  for (const [size, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    it(`keeps ${size} geometry fixed while scrolling streamed lines and long unbroken output`, async () => {
      await user.setViewportSize({ width, height });
      await user.goto(base);
      const output = user.locator('.console');
      await browserExpect(output).toContainText('Browser provider fixture attached');
      await browserExpect(user.locator('.console-summary-card')).toHaveCount(8);
      await browserExpect(user.locator('.console-summary-address')).toBeVisible();
      await browserExpect(user.locator('.metric-chart')).toHaveCount(3);
      const before = await geometry();
      for (let index = 0; index < 280; index += 1) {
        emit(`Overflow fixture line ${index}: server log output remains inside the terminal.`);
        // Drain the actual bounded SSE writer; this is layout coverage, not a flood test.
        if (index % 20 === 19)
          await browserExpect(output).toContainText(`Overflow fixture line ${index}:`);
      }
      emit(`Long unbroken line: ${'x'.repeat(8000)} END-LONG-LINE`);
      await browserExpect(output).toContainText('END-LONG-LINE');
      const after = await geometry();
      expect(Math.abs(after.terminal.width - before.terminal.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.terminal.height - before.terminal.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.output.height - before.output.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.bodyHeight - before.bodyHeight)).toBeLessThanOrEqual(1);
      expect(after.bodyWidth).toBeLessThanOrEqual(after.viewportWidth);
      expect(after.scrollHeight).toBeGreaterThan(after.clientHeight + 1000);
      expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth);
      expect(after.prompt.y).toBeGreaterThanOrEqual(after.output.y + after.output.height - 1);
      expect(after.prompt.y + after.prompt.height).toBeLessThanOrEqual(
        after.terminal.y + after.terminal.height + 1,
      );
      if (size === 'desktop') {
        expect(Math.abs(after.firstCard.y - after.terminal.y)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(
            after.lastCard.y + after.lastCard.height - after.terminal.y - after.terminal.height,
          ),
        ).toBeLessThanOrEqual(1);
      }
      const bottomGap = () =>
        output.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        );
      await browserExpect.poll(bottomGap).toBeLessThanOrEqual(2);
      await output.focus();
      await user.keyboard.press('Control+Home');
      await browserExpect.poll(() => output.evaluate((element) => element.scrollTop)).toBe(0);
      emit('Reading older output must not move the viewport');
      await browserExpect(output).toContainText('Reading older output must not move the viewport');
      expect(await output.evaluate((element) => element.scrollTop)).toBe(0);
      expect(await bottomGap()).toBeGreaterThan(1000);
      await user.keyboard.press('Tab');
      const prompt = user.getByRole('textbox', { name: 'Command', exact: true });
      await browserExpect(prompt).toBeFocused();
      await prompt.fill('draft while inspecting logs');
      expect(await output.evaluate((element) => element.scrollTop)).toBe(0);
      await user.keyboard.press('Shift+Tab');
      await browserExpect(output).toBeFocused();
      await user.keyboard.press('Control+End');
      await browserExpect.poll(bottomGap).toBeLessThanOrEqual(2);
      emit('Following new output again');
      await browserExpect(output).toContainText('Following new output again');
      await browserExpect.poll(bottomGap).toBeLessThanOrEqual(2);
      await browserExpect(prompt).toHaveValue('draft while inspecting logs');
      const axe = await new AxeBuilder({ page: user })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(axe.violations.map((violation) => violation.id)).toEqual([]);
      expect(errors).toEqual([]);
      await user.screenshot({
        path: resolve('docs/screenshots/m5', `console-overflow-${size}.png`),
        fullPage: true,
      });
    });
  }
});
