import { z } from 'zod';

const values = z
  .record(z.string().min(1).max(256), z.string().max(4096))
  .refine((settings) => Object.keys(settings).length <= 128);
/** Native GetAdvancedGameSettings, including the session's creative-mode state. */
export const satisfactoryAdvancedSettingsSchema = z.object({
  creativeModeEnabled: z.boolean(),
  advancedGameSettings: values,
});
export const satisfactoryAdvancedSettingsUpdateSchema = z.strictObject({
  settings: values.refine((settings) => Object.keys(settings).length > 0),
  expectedSessionName: z.string().min(1).max(4096),
  confirmEnable: z.boolean().default(false),
});
