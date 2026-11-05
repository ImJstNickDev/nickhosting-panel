import { describe, expect, it } from 'vitest';
import { satisfactoryFileKind, satisfactoryFileLocations } from './fileman.js';

describe('Satisfactory Fileman presentation', () => {
  it('recognizes native files without parsing or classifying private keys', () => {
    expect(satisfactoryFileKind('ServerSettings.28014.sav')).toBe('serverSettings');
    expect(satisfactoryFileKind('ServerSettings.sav')).toBe('serverSettings');
    expect(satisfactoryFileKind('ServerSettings_factory.sav')).toBe('save');
    expect(satisfactoryFileKind('Factory_A.SAV')).toBe('save');
    expect(satisfactoryFileKind('Constructor.sbp')).toBe('blueprint');
    expect(satisfactoryFileKind('Constructor.sbpcfg')).toBe('blueprint');
    expect(satisfactoryFileKind('Game.ini')).toBe('configuration');
    expect(satisfactoryFileKind('FactoryGame.log')).toBe('log');
    expect(satisfactoryFileKind('SML.uplugin')).toBe('modManifest');
    expect(satisfactoryFileKind('nick_hosting-lock.json')).toBe('modManifest');
    expect(satisfactoryFileKind('Factory.smmprofile')).toBe('modManifest');
    expect(satisfactoryFileKind('profiles.json')).toBe('modManifest');
    expect(satisfactoryFileKind('private_key.pem')).toBeUndefined();
    expect(satisfactoryFileKind('notes.json')).toBeUndefined();
    expect(satisfactoryFileKind('world.sav.bak')).toBeUndefined();
  });
  it('offers relative native locations without exposing host paths', () => {
    expect(satisfactoryFileLocations.map((item) => item.id)).toEqual([
      'saves',
      'mods',
      'configuration',
      'logs',
    ]);
    expect(
      satisfactoryFileLocations.every(
        (item) => !item.path.startsWith('/') && !item.path.includes('..'),
      ),
    ).toBe(true);
  });
});
