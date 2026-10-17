import { z } from 'zod';

export const gatewayMessageStates = [
  'sleeping',
  'waking',
  'stopping',
  'blocked',
  'maintenance',
  'manually_stopped',
  'wake_disabled',
  'capacity_denied',
  'unavailable',
] as const;
export type GatewayMessageState = (typeof gatewayMessageStates)[number];
export const gatewayMessageVariables = ['server', 'state', 'eta'] as const;
const messageText = z
  .string()
  .min(1)
  .max(512)
  .refine((text) =>
    [...text].every((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    }),
  )
  .refine((text) => !/[{}]/.test(text.replace(/\{(?:server|state|eta)\}/g, '')));
export const gatewayMessageOverridesSchema = z.partialRecord(
  z.enum(gatewayMessageStates),
  z.strictObject({ motd: messageText.optional(), disconnect: messageText.optional() }),
);
export type GatewayMessageOverrides = z.infer<typeof gatewayMessageOverridesSchema>;
export const gatewayPresentationSchema = z.strictObject({
  serverName: z.string().max(160),
  messages: gatewayMessageOverridesSchema,
  stopping: z.boolean().optional(),
  blockedReason: z.enum(['capacity_denied', 'unavailable']).optional(),
  // Historical startup estimate, not a routing/readiness timer.
  estimatedStartupSeconds: z.number().int().nonnegative().max(86400).optional(),
  startupBeganAt: z.iso.datetime({ offset: true }).optional(),
});
export type GatewayPresentation = z.infer<typeof gatewayPresentationSchema>;
export const gatewayMessageDefaults: Record<'en' | 'it', Record<GatewayMessageState, string>> = {
  en: {
    sleeping: 'Server sleeping. Join to start it.',
    waking: 'Server starting. Please reconnect shortly.',
    stopping: 'Server stopping. Please try again shortly.',
    blocked: 'Server cannot start right now. Please try again later.',
    maintenance: 'Server under maintenance. Please try again later.',
    manually_stopped: 'Server stopped. Start it from the panel.',
    wake_disabled: 'Server offline. Start it from the panel.',
    capacity_denied: 'Not enough resources to start the server. Try again later.',
    unavailable: 'Server temporarily unavailable. Try again later.',
  },
  it: {
    sleeping: 'Server in sospensione. Connettiti per avviarlo.',
    waking: 'Server in avvio. Riconnettiti tra poco.',
    stopping: 'Server in spegnimento. Riprova tra poco.',
    blocked: 'Impossibile avviare il server ora. Riprova più tardi.',
    maintenance: 'Server in manutenzione. Riprova più tardi.',
    manually_stopped: 'Server arrestato. Avvialo dal pannello.',
    wake_disabled: 'Server spento. Avvialo dal pannello.',
    capacity_denied: 'Risorse insufficienti per avviare il server. Riprova più tardi.',
    unavailable: 'Server temporaneamente non disponibile. Riprova più tardi.',
  },
};
export function gatewayMessageState(
  mode: string,
  wakeEnabled: boolean | undefined,
  presentation?: GatewayPresentation,
): GatewayMessageState | undefined {
  if (mode !== 'online' && presentation?.stopping) return 'stopping';
  if (mode === 'sleeping' && wakeEnabled === false) return 'wake_disabled';
  if (mode === 'blocked' && presentation?.blockedReason) return presentation.blockedReason;
  return (gatewayMessageStates as readonly string[]).includes(mode)
    ? (mode as GatewayMessageState)
    : undefined;
}
export function renderGatewayMessage(
  template: string,
  state: GatewayMessageState,
  locale: 'en' | 'it',
  presentation?: GatewayPresentation,
  now = Date.now(),
) {
  let eta = '';
  if (
    state === 'waking' &&
    presentation?.estimatedStartupSeconds !== undefined &&
    presentation.startupBeganAt
  ) {
    const elapsed = Math.max(0, (now - Date.parse(presentation.startupBeganAt)) / 1000);
    const remaining = Math.ceil(presentation.estimatedStartupSeconds - elapsed);
    if (remaining > 0) eta = `${remaining} s`;
  }
  const variables = {
    server: presentation?.serverName ?? '',
    state: gatewayMessageDefaults[locale][state],
    eta,
  };
  const rendered = template
    .replace(/\{(server|state|eta)\}/g, (_, name: keyof typeof variables) => variables[name])
    .slice(0, 1024);
  // Never emit an isolated high surrogate when limiting expanded placeholders.
  const last = rendered.charCodeAt(rendered.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? rendered.slice(0, -1) : rendered;
}
