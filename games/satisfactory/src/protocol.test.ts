import { describe, expect, it } from 'vitest';
import {
  decodeSatisfactoryPoll,
  decodeSatisfactoryState,
  encodeSatisfactoryPoll,
  encodeSatisfactoryState,
} from './protocol.js';

const state = {
  state: 3 as const,
  netCL: 123456,
  flags: 0x8000000000000001n,
  substates: [
    { id: 0, version: 65535 },
    { id: 250, version: 42 },
  ],
  name: 'Fabbrica 🏭',
};
describe('Satisfactory Lightweight Query protocol', () => {
  it('encodes documented little-endian poll and preserves full cookie precision', () => {
    const poll = encodeSatisfactoryPoll(0xfedcba9876543210n);
    expect(Buffer.from(poll).toString('hex')).toBe('d5f600011032547698badcfe01');
    expect(decodeSatisfactoryPoll(poll)).toEqual({ cookie: 0xfedcba9876543210n });
  });
  it('round trips all fields including unknown substates and UTF-8 byte lengths', () => {
    const bytes = encodeSatisfactoryState(42n, state);
    expect(decodeSatisfactoryState(bytes, 42n)).toEqual({ ...state, cookie: 42n });
    expect(() => decodeSatisfactoryState(bytes, 43n)).toThrow();
  });
  it('rejects every truncated datagram and trailing data', () => {
    const bytes = encodeSatisfactoryState(1n, state);
    for (let i = 0; i < bytes.length; i++)
      expect(() => decodeSatisfactoryState(bytes.slice(0, i))).toThrow();
    expect(() => decodeSatisfactoryState(Buffer.concat([bytes, Buffer.from([1])]))).toThrow();
    for (let i = 0; i < 13; i++)
      expect(decodeSatisfactoryPoll(encodeSatisfactoryPoll(1n).slice(0, i))).toBeUndefined();
  });
  it('does not accept gameplay, malformed query headers, or duplicate substates', () => {
    const poll = Buffer.from(encodeSatisfactoryPoll(1n));
    poll[3] = 2;
    expect(decodeSatisfactoryPoll(poll)).toBeUndefined();
    expect(() =>
      encodeSatisfactoryState(1n, {
        ...state,
        substates: [
          { id: 0, version: 1 },
          { id: 0, version: 2 },
        ],
      }),
    ).toThrow();
    const bytes = Buffer.from(encodeSatisfactoryState(1n, state));
    bytes[12] = 4;
    expect(() => decodeSatisfactoryState(bytes)).toThrow();
  });
});
