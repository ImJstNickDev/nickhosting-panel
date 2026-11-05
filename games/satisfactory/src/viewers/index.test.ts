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
