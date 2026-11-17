import { expect, it } from 'vitest';
import { satisfactoryViewers } from './index.js';

it('suggests world inspection only for world save names', () => {
  const matches = satisfactoryViewers[0].matches;
  if (!matches) throw new Error('Missing save viewer matcher');
  const source = { name: 'Factory.sav', path: 'Factory.sav', size: 100, gameId: 'satisfactory' };
  expect(matches(source)).toBe(true);
  for (const name of ['ServerSettings.28014.sav', 'serversettings.7777.SAV', 'ServerSettings.sav'])
    expect(matches({ ...source, name })).toBe(false);
  expect(matches({ ...source, name: 'ServerSettings.28014_Autosave.sav' })).toBe(true);
});

it('suggests INI and known manifest names only in Satisfactory', () => {
  const source = { name: 'Game.ini', path: 'Game.ini', size: 100, gameId: 'satisfactory' };
  const ini = satisfactoryViewers.find((viewer) => viewer.descriptor.id === 'satisfactory:ini');
  const manifest = satisfactoryViewers.find(
    (viewer) => viewer.descriptor.id === 'satisfactory:manifest',
  );
  expect(ini?.matches?.(source)).toBe(true);
  expect(ini?.matches?.({ ...source, gameId: 'minecraft' })).toBe(false);
  for (const name of [
    'SML.uplugin',
    'Factory.smmprofile',
    'profiles.json',
    'nick_hosting-lock.json',
  ])
    expect(manifest?.matches?.({ ...source, name })).toBe(true);
  for (const name of ['notes.json', 'credentials.json', 'private_key.pem', 'profiles.json.bak'])
    expect(manifest?.matches?.({ ...source, name })).toBe(false);
  expect(manifest?.matches?.({ ...source, name: 'SML.uplugin', gameId: 'minecraft' })).toBe(false);
});
