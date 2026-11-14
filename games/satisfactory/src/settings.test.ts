import { expect, it } from 'vitest';
import {
  satisfactoryAdvancedSettingsSchema,
  satisfactoryAdvancedSettingsUpdateSchema,
} from './settings.js';

it('validates the actual native creative-mode envelope and string settings', () => {
  expect(
    satisfactoryAdvancedSettingsSchema.parse({
      creativeModeEnabled: false,
      advancedGameSettings: { 'FG.GameRules.NoBuildCost': 'False' },
    }).creativeModeEnabled,
  ).toBe(false);
  expect(satisfactoryAdvancedSettingsSchema.safeParse({ advancedGameSettings: {} }).success).toBe(
    false,
  );
  expect(
    satisfactoryAdvancedSettingsSchema.safeParse({
      creativeModeEnabled: true,
      advancedGameSettings: { setting: true },
    }).success,
  ).toBe(false);
});
it('requires bounded nonempty updates and explicit boolean enable consent', () => {
  expect(
    satisfactoryAdvancedSettingsUpdateSchema.parse({
      settings: { option: 'value' },
      expectedSessionName: 'Factory',
    }).confirmEnable,
  ).toBe(false);
  for (const input of [
    { settings: {} },
    { settings: { option: 'value' }, confirmEnable: 'true' },
    { settings: { option: 'value' }, injected: true },
    { settings: { option: 'x'.repeat(4097) } },
    {
      settings: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`option${i}`, 'value'])),
    },
  ])
    expect(
      satisfactoryAdvancedSettingsUpdateSchema.safeParse({
        expectedSessionName: 'Factory',
        ...input,
      }).success,
    ).toBe(false);
});
