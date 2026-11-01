import { type AuthContext, authSessionId } from '@nickhosting/core';
import { describe, expect, it, vi } from 'vitest';
import { createConsoleCommandRelays } from './console-command-relays.js';

const context: AuthContext = {
  [authSessionId]: 'session',
  actorUserId: 'actor',
  subjectUserId: 'subject',
  sessionType: 'regular',
  role: 'owner',
  ownerElevation: false,
};
const relay = () => ({
  sendCommand: vi.fn(async () => {}),
  requestLogs: vi.fn(async () => {}),
  requestStats: vi.fn(async () => {}),
  close: vi.fn(),
});
describe('app-local command relay registry', () => {
  it('isolates all authority, managed identity and provider credential boundaries', () => {
    const registry = createConsoleCommandRelays(),
      handle = relay();
    registry.register(context, 'server', 'provider-id', 'credentials-a', handle);
    expect(registry.find(context, 'server', 'provider-id', 'credentials-a')).toBe(handle);
    for (const change of [
      { [authSessionId]: 'other' },
      { actorUserId: 'other' },
      { subjectUserId: 'other' },
      { sessionType: 'support' as const },
      { ownerElevation: true },
    ])
      expect(
        registry.find({ ...context, ...change }, 'server', 'provider-id', 'credentials-a'),
      ).toBeUndefined();
    expect(registry.find(context, 'other', 'provider-id', 'credentials-a')).toBeUndefined();
    expect(registry.find(context, 'server', 'other', 'credentials-a')).toBeUndefined();
    expect(registry.find(context, 'server', 'provider-id', 'credentials-b')).toBeUndefined();
  });
  it('bounds handles and old disconnects cannot remove a newer connection', () => {
    const registry = createConsoleCommandRelays(1),
      first = relay(),
      second = relay();
    const removeFirst = registry.register(context, 'server', 'id', 'provider', first);
    registry.register(context, 'other', 'id', 'provider', relay());
    expect(registry.find(context, 'other', 'id', 'provider')).toBeUndefined();
    const removeSecond = registry.register(context, 'server', 'id', 'provider', second);
    removeFirst();
    expect(registry.find(context, 'server', 'id', 'provider')).toBe(second);
    removeSecond();
    expect(registry.find(context, 'server', 'id', 'provider')).toBeUndefined();
  });
});
