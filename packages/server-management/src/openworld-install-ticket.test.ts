import { randomBytes } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { afterEach, expect, it, vi } from 'vitest';
import { issueOpenworldArtifactUrl, readOpenworldInstallTicket } from './openworld-catalog.js';

afterEach(() => vi.useRealTimers());
it('accepts a bounded release pin, rejects changes, and expires installation credentials', () => {
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  vi.useFakeTimers();
  const pin = { version: 'a1.2.9', sha256: 'a'.repeat(64), size: 34 };
  const url = new URL(issueOpenworldArtifactUrl(codec, 'https://hub.example', pin));
  expect(url.origin).toBe('https://hub.example');
  const ticket = url.searchParams.get('ticket') ?? '';
  expect(readOpenworldInstallTicket(codec, ticket)).toEqual(pin);
  expect(() => readOpenworldInstallTicket(codec, `a${ticket}`)).toThrow();
  vi.advanceTimersByTime(31 * 60_000);
  expect(() => readOpenworldInstallTicket(codec, ticket)).toThrow();
});
