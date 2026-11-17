import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { SatisfactoryApi } from './api.js';

export const satisfactorySaveWorldSchema = z.strictObject({
  saveName: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
});
export const satisfactoryLoadWorldSchema = z.strictObject({
  saveName: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (value) =>
        !value.includes('/') &&
        !value.includes('\\') &&
        [...value].every((character) => character.charCodeAt(0) >= 32),
    ),
  enableAdvancedGameSettings: z.boolean().default(false),
  confirm: z.literal(true),
});
export const satisfactoryCreateWorldSchema = z.strictObject({
  sessionName: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine(
      (value) =>
        !value.includes('/') &&
        !value.includes('\\') &&
        [...value].every((character) => character.charCodeAt(0) >= 32),
    ),
  confirm: z.literal(true),
});
export type SatisfactoryWorldAction =
  | { action: 'save'; input: z.infer<typeof satisfactorySaveWorldSchema> }
  | { action: 'load'; input: z.infer<typeof satisfactoryLoadWorldSchema> }
  | { action: 'create'; input: z.infer<typeof satisfactoryCreateWorldSchema> };

/** Called inside the platform lifecycle lock. A failed safety save aborts map changes. */
export async function changeSatisfactoryWorld(
  api: SatisfactoryApi,
  request: SatisfactoryWorldAction,
  safetySave: string,
  reauthorize: () => Promise<void> = async () => {},
): Promise<void> {
  const [state, listing] = await Promise.all([api.state(), api.sessions()]);
  const saves = listing.sessions.flatMap((session) => session.saveHeaders);
  if (request.action === 'save') {
    if (!state.isGameRunning) throw new DomainError('conflict');
    if (saves.some((save) => save.saveName.toLowerCase() === request.input.saveName.toLowerCase()))
      throw new DomainError('conflict');
    await reauthorize();
    await api.save(request.input.saveName);
    return;
  }
  if (request.action === 'load' && !saves.some((save) => save.saveName === request.input.saveName))
    throw new DomainError('not_found');
  if (
    request.action === 'create' &&
    listing.sessions.some(
      (session) => session.sessionName.toLowerCase() === request.input.sessionName.toLowerCase(),
    )
  )
    throw new DomainError('conflict');
  await reauthorize();
  if (state.isGameRunning) await api.save(safetySave);
  await reauthorize();
  if (request.action === 'load')
    await api.loadWorld(request.input.saveName, request.input.enableAdvancedGameSettings);
  else await api.createWorld(request.input.sessionName);
}
