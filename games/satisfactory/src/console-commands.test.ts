import { expect, it } from 'vitest';
import {
  authorizeStoppedConsoleAdministrator,
  consoleAdministratorIdentity,
} from './console-auth.js';
import {
  isNickHostingCommand,
  parseSatisfactoryConsoleCommand,
  readConsoleCommand,
} from './console-commands.js';
import { createNativeAuthenticationToken, decodeNativePlayerIdentity } from './native-auth.js';

it('uses an exact namespace and a bounded single-command grammar', () => {
  expect(parseSatisfactoryConsoleCommand(' nickhosting ')).toEqual({
    kind: 'command',
    name: 'help',
  });
  expect(parseSatisfactoryConsoleCommand('NICKHOSTING HELP STOP')).toEqual({
    kind: 'command',
    name: 'help',
    helpFor: 'stop',
  });
  expect(parseSatisfactoryConsoleCommand('nickhosting mods')).toEqual({
    kind: 'command',
    name: 'mods',
  });
  for (const command of [
    'nickhosting stop;start',
    'nickhosting stop\nquit',
    'nickhosting stop now',
    'nickhosting help missing',
    `nickhosting ${'x'.repeat(512)}`,
  ])
    expect(parseSatisfactoryConsoleCommand(command)).toEqual({ kind: 'invalid' });
  for (const command of ['quit', 'nickhostingish stop', 'server.SaveGame factory']) {
    expect(isNickHostingCommand(command)).toBe(false);
    expect(parseSatisfactoryConsoleCommand(command)).toEqual({ kind: 'native' });
  }
  expect(readConsoleCommand({ Command: 'nickhosting help', command: 'quit' })).toBeUndefined();
  expect(readConsoleCommand({ COMMAND: 'nickhosting help' })).toBe('nickhosting help');
});
it('verifies real stopped Administrator fingerprints and rejects client or mismatched authority', () => {
  const credentials = {
    build: 513885,
    serverName: 'fixture',
    serverSecret: 'AB'.repeat(256),
    adminPassword: { hash: 'BC'.repeat(64), salt: 'CD'.repeat(32) },
  };
  const playerId = '060102030405060708';
  const player = decodeNativePlayerIdentity(playerId);
  if (!player) throw new Error('fixture');
  const token = createNativeAuthenticationToken(credentials, 'Administrator', player);
  const request = { operation: 'RunCommand', authorization: `Bearer ${token}`, playerId };
  expect(consoleAdministratorIdentity(request)?.token).toBe(token);
  expect(consoleAdministratorIdentity({ ...request, playerId: 'unknown' })).toBeUndefined();
  const anonymous = decodeNativePlayerIdentity();
  if (!anonymous) throw new Error('fixture');
  const anonymousRequest = {
    operation: 'RunCommand',
    authorization: `Bearer ${createNativeAuthenticationToken(credentials, 'Administrator', anonymous)}`,
  };
  expect(consoleAdministratorIdentity(anonymousRequest)?.playerId).toBe('INVALID');
  expect(authorizeStoppedConsoleAdministrator(credentials, anonymousRequest)).toBe(true);
  expect(
    authorizeStoppedConsoleAdministrator(credentials, { ...anonymousRequest, playerId: 'invalid' }),
  ).toBe(true);
  expect(authorizeStoppedConsoleAdministrator(credentials, { ...anonymousRequest, playerId })).toBe(
    false,
  );
  expect(authorizeStoppedConsoleAdministrator(credentials, request)).toBe(true);
  for (const patch of [
    { playerId: '060102030405060709' },
    { authorization: `Bearer ${token.slice(0, -2)}00` },
    { authorization: `Bearer ${createNativeAuthenticationToken(credentials, 'Client', player)}` },
    { playerId: undefined },
  ])
    expect(authorizeStoppedConsoleAdministrator(credentials, { ...request, ...patch })).toBe(false);
  expect(authorizeStoppedConsoleAdministrator({ ...credentials, build: 0 }, request)).toBe(false);
  expect(
    authorizeStoppedConsoleAdministrator(
      { ...credentials, adminPassword: { hash: '', salt: '' } },
      request,
    ),
  ).toBe(false);
  expect(
    authorizeStoppedConsoleAdministrator(
      { ...credentials, serverSecret: 'AA'.repeat(256) },
      request,
    ),
  ).toBe(false);
});
