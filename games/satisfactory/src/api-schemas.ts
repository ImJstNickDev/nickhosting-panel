import { z } from 'zod';

export const satisfactoryGameStateSchema = z.object({
  activeSessionName: z.string(),
  numConnectedPlayers: z.number().int().nonnegative(),
  playerLimit: z.number().int().nonnegative(),
  techTier: z.number().int().nonnegative(),
  activeSchematic: z.string(),
  gamePhase: z.string(),
  isGameRunning: z.boolean(),
  totalGameDuration: z.number().nonnegative(),
  isGamePaused: z.boolean(),
  averageTickRate: z.number().finite(),
  autoLoadSessionName: z.string(),
});
export type SatisfactoryGameState = z.infer<typeof satisfactoryGameStateSchema>;
// Coffee Stain's FGSaveManagerInterface FSessionSaveStruct/FSaveHeader and
// FGServerSaveGameController EnumerateSessions response. No world/file data is
// synthesized from this metadata; consumers still require native Admin scope.
export const satisfactorySaveHeaderSchema = z.object({
  saveVersion: z.number().int().nonnegative().max(2147483647),
  buildVersion: z.number().int().nonnegative().max(2147483647),
  saveName: z.string().max(4096),
  saveLocationInfo: z.enum(['SLI_Default', 'SLI_Common', 'SLI_Server']).optional(),
  mapName: z.string().max(4096),
  mapOptions: z.string().max(16384),
  sessionName: z.string().max(4096),
  playDurationSeconds: z.number().int().nonnegative().max(2147483647),
  saveDateTime: z.string().max(128),
  isModdedSave: z.boolean(),
  isEditedSave: z.boolean(),
  isCreativeModeEnabled: z.boolean(),
});
export const satisfactorySessionsSchema = z
  .object({
    sessions: z
      .array(
        z.object({
          sessionName: z.string().max(4096),
          saveHeaders: z.array(satisfactorySaveHeaderSchema).max(4096),
        }),
      )
      .max(1024),
    currentSessionIndex: z.number().int().min(-1).max(2147483647),
  })
  .refine(
    (value) =>
      value.currentSessionIndex < value.sessions.length &&
      value.sessions.reduce((total, session) => total + session.saveHeaders.length, 0) <= 32768,
  );
