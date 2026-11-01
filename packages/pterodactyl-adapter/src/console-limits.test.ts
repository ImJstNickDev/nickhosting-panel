import { describe, expect, it } from 'vitest';
import { createConsoleOutboundBudget } from './console-limits.js';

describe('Wings outbound wire limits', () => {
  it('counts UTF-8 bytes and JSON escapes, including the envelope', () => {
    const reserve = createConsoleOutboundBudget();
    const overhead = Buffer.byteLength(JSON.stringify({ event: 'send command', args: [''] }));
    const accepted = reserve('send command', ['a'.repeat(4096 - overhead)]);
    expect(Buffer.byteLength(accepted)).toBe(4096);
    for (const command of [
      'a'.repeat(4097 - overhead),
      '🌍'.repeat(1024),
      '\\'.repeat(2048),
      '\n'.repeat(2048),
    ])
      expect(() => reserve('send command', [command])).toThrowError(
        expect.objectContaining({ code: 'validation_failed' }),
      );
    expect(() => reserve('auth', ['x'.repeat(4096)])).toThrowError(
      expect.objectContaining({ code: 'validation_failed' }),
    );
  });

  it('does not spend budgets on rejected oversized frames or replay exhausted commands', () => {
    let time = 0;
    const reserve = createConsoleOutboundBudget(() => time);
    expect(() => reserve('send command', ['x'.repeat(4096)])).toThrow();
    for (let i = 0; i < 10; i++) reserve('send command', ['list']);
    expect(() => reserve('send command', ['list'])).toThrowError(
      expect.objectContaining({ reason: 'rate_limited', outcome: 'rejected', retryAfterMs: 1000 }),
    );
    time = 999;
    expect(() => reserve('send command', ['list'])).toThrowError(
      expect.objectContaining({ reason: 'rate_limited' }),
    );
    time = 1000;
    expect(() => reserve('send command', ['list'])).not.toThrow();
    expect(() => reserve('send command', ['list'])).toThrow();
  });

  it('tracks auth, logs and stats separately while enforcing the shared wire bucket', () => {
    let time = 0;
    const reserve = createConsoleOutboundBudget(() => time);
    reserve('auth', ['jwt']);
    reserve('auth', ['jwt']);
    reserve('send logs', []);
    reserve('send logs', []);
    for (let i = 0; i < 4; i++) reserve('send stats', []);
    expect(() => reserve('auth', ['jwt'])).toThrowError(
      expect.objectContaining({ retryAfterMs: 5000 }),
    );
    expect(() => reserve('send logs', [])).toThrowError(
      expect.objectContaining({ retryAfterMs: 5000 }),
    );
    expect(() => reserve('send stats', [])).toThrowError(
      expect.objectContaining({ retryAfterMs: 1000 }),
    );
    reserve('send command', ['a']);
    reserve('send command', ['b']);
    expect(() => reserve('send command', ['c'])).toThrowError(
      expect.objectContaining({ retryAfterMs: 200 }),
    );
    time = 200;
    expect(() => reserve('send command', ['c'])).not.toThrow();
    time = 5000;
    expect(() => reserve('auth', ['jwt'])).not.toThrow();
    expect(() => reserve('send logs', [])).not.toThrow();
  });
});
