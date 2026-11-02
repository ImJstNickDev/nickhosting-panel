import { describe, expect, it } from 'vitest';
import { satisfactoryPhaseLabel, satisfactorySchematicLabel } from './progression.js';
import { satisfactoryProgressionCatalogs } from './progression-catalog.js';

const phase = (n: number, root = '/Game/FactoryGame') =>
  `/Script/FactoryGame.FGGamePhase'${root}/GamePhases/GP_Project_Assembly_Phase_${n}.GP_Project_Assembly_Phase_${n}'`;
const schematic = (name: string, root = '/Game/FactoryGame/Schematics/Progression') =>
  `/Script/Engine.BlueprintGeneratedClass'${root}/${name}.${name}_C'`;
describe('native progression presentation', () => {
  it('preserves phase zero and maps each current phase without shifting to the next delivery', () => {
    for (let n = 0; n <= 7; n++) {
      expect(satisfactoryPhaseLabel(phase(n))).toEqual({
        kind: 'localized',
        key: `games.satisfactory.progression.phase.${n}`,
      });
    }
    expect(
      satisfactoryPhaseLabel(
        '/Game/FactoryGame/GamePhases/GP_Project_Assembly_Phase_0.GP_Project_Assembly_Phase_0',
      ),
    ).toEqual(satisfactoryPhaseLabel(phase(0)));
    expect(satisfactoryProgressionCatalogs.en['games.satisfactory.progression.phase.0']).toContain(
      'Phase 0',
    );
  });
  it('handles sentinels and a new numbered vanilla phase without inventing a known name', () => {
    expect(satisfactoryPhaseLabel('None')).toMatchObject({
      key: 'games.satisfactory.progression.noPhase',
    });
    expect(satisfactorySchematicLabel('')).toMatchObject({
      key: 'games.satisfactory.progression.noMilestone',
    });
    expect(satisfactoryPhaseLabel(phase(8))).toMatchObject({
      key: 'games.satisfactory.progression.phaseNumber',
      values: { phase: 8 },
    });
  });
  it('translates known progression and tutorial assets only within their original namespace', () => {
    expect(satisfactorySchematicLabel(schematic('Schematic_1-1'))).toMatchObject({
      key: 'games.satisfactory.progression.milestone.Schematic_1-1',
    });
    expect(
      satisfactorySchematicLabel(
        schematic('Schematic_Tutorial1_5', '/Game/FactoryGame/Schematics/Tutorial'),
      ),
    ).toMatchObject({ key: 'games.satisfactory.progression.milestone.Schematic_Tutorial1_5' });
    expect(satisfactorySchematicLabel(schematic('Schematic_1-1', '/MyMod/Schematics'))).toEqual({
      kind: 'custom',
      label: '1-1',
    });
    expect(satisfactoryPhaseLabel(phase(1, '/MyMod'))).toMatchObject({ kind: 'custom' });
  });
  it('keeps unknown mod labels readable without exposing Unreal paths or markup', () => {
    expect(
      satisfactorySchematicLabel(schematic('Schematic_NewPower', '/MyMod/Schematics')),
    ).toEqual({ kind: 'custom', label: 'New Power' });
    expect(satisfactorySchematicLabel(schematic('Schematic_10-1'))).toMatchObject({
      key: 'games.satisfactory.progression.milestoneNumber',
      values: { milestone: '10-1' },
    });
    expect(satisfactorySchematicLabel('Tier 6 milestone')).toEqual({
      kind: 'custom',
      label: 'Tier 6 milestone',
    });
    for (const invalid of [
      "/Script/Broken'/Game/Path",
      '<img src=x>',
      'x'.repeat(4097),
      '/Game/Mismatch.ADifferentAsset',
      `garbage${phase(0)}`,
    ]) {
      expect(satisfactorySchematicLabel(invalid)).toMatchObject({
        key: 'games.satisfactory.progression.unknown',
      });
    }
  });
  it('ships matching translated keys for every bundled label', () => {
    expect(Object.keys(satisfactoryProgressionCatalogs.en)).toEqual(
      Object.keys(satisfactoryProgressionCatalogs.it),
    );
    expect(
      satisfactoryProgressionCatalogs.en['games.satisfactory.progression.milestone.Schematic_1-1'],
    ).toBe('Base Building');
    expect(
      satisfactoryProgressionCatalogs.it['games.satisfactory.progression.milestone.Schematic_1-1'],
    ).toBe('Costruzione di base');
  });
});
