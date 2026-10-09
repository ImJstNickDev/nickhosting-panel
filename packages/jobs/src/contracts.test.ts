import { describe, expect, it } from 'vitest';
import { commandDigest, parseCommand, retryDelayMs } from './contracts.js';
import { validateTransportOptions } from './transport.js';

const command = {
  type: 'foundation.record-activity',
  version: 1,
  payload: { source: 'user_request' },
} as const;

describe('durable command contracts', () => {
  it('rejects unsupported command versions and hidden credentials', () => {
    expect(parseCommand(command)).toEqual(command);
    for (const value of [
      null,
      { ...command, version: 2 },
      { ...command, token: 'private' },
      { ...command, payload: { source: 'user_request', password: 'private' } },
      { ...command, type: 'server.start' },
    ]) {
      expect(() => parseCommand(value)).toThrow('validation_failed');
    }
  });
  it('hashes normalized command content and tenant identity', () => {
    const input = { command, subjectId: 'subject', resourceOwnerId: 'owner' };
    const digest = commandDigest(input);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      commandDigest({
        ...input,
        command: { payload: command.payload, version: 1, type: command.type },
      }),
    ).toBe(digest);
    expect(commandDigest({ ...input, subjectId: 'other' })).not.toBe(digest);
    expect(commandDigest({ ...input, resourceOwnerId: 'other' })).not.toBe(digest);
    expect(
      commandDigest({ ...input, command: { ...command, payload: { source: 'system_check' } } }),
    ).not.toBe(digest);
  });
  it('uses bounded exponential backoff and rejects invalid attempts', () => {
    expect([1, 2, 3, 7, 20].map(retryDelayMs)).toEqual([1000, 2000, 4000, 60000, 60000]);
    for (const attempt of [-1, 0, 1.5, Number.NaN]) expect(() => retryDelayMs(attempt)).toThrow();
  });
  it('rejects unsafe Redis namespaces and invalid protocols without echoing secrets', () => {
    expect(() =>
      validateTransportOptions({ redisUrl: 'redis://localhost:6379', prefix: 'nh-test' }),
    ).not.toThrow();
    for (const options of [
      { redisUrl: 'https://user:private@example.com', prefix: 'test' },
      { redisUrl: 'redis://localhost:6379', prefix: '*' },
      { redisUrl: 'redis://localhost:6379', prefix: 'test:other' },
      { redisUrl: 'private', prefix: 'test' },
    ])
      expect(() => validateTransportOptions(options)).toThrow('configuration_invalid');
  });
});
