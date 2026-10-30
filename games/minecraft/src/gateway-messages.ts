import type { GatewayPresentation, MinecraftGatewayResponses } from '@nickhosting/core';
import {
  type GatewayMessageDefinition,
  gatewayMessageDefinitionSchema,
} from '@nickhosting/game-sdk';
import { minecraftFormattingTokens as formattingTokens } from './message-formatting.js';
import {
  alignMinecraftMotd,
  boundedMinecraftMessage,
  minecraftMessageAlignment,
  stripMinecraftMessageAlignment,
} from './message-layout.js';

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
export const gatewayMessageVariables = [
  'server',
  'state',
  'eta',
  'version',
  'runtime',
  'address',
  'elapsed',
] as const;

export function minecraftGatewayRuntimeName(runtimeId: string): string {
  const names: Record<string, string> = {
    vanilla: 'Vanilla',
    paper: 'Paper',
    folia: 'Folia',
    fabric: 'Fabric',
    forge: 'Forge',
  };
  return Object.hasOwn(names, runtimeId) ? (names[runtimeId] ?? '') : '';
}
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
  channel: 'motd' | 'disconnect' = 'motd',
) {
  const alignment = channel === 'motd' ? minecraftMessageAlignment(template) : 'left';
  const source = channel === 'motd' ? stripMinecraftMessageAlignment(template) : template;
  const variables = minecraftGatewayMessageValues(state, locale, presentation, now);
  const rendered = source
    .replace(
      /\{(server|state|eta|version|runtime|address|elapsed)\}/g,
      (_, name: keyof typeof variables) => variables[name],
    )
    .slice(0, 1024);
  return channel === 'motd'
    ? alignMinecraftMotd(rendered, alignment)
    : boundedMinecraftMessage(rendered);
}

/** One value resolver for protocol output and editor metadata. */
export function minecraftGatewayMessageValues(
  state: GatewayMessageState,
  locale: 'en' | 'it',
  presentation?: GatewayPresentation,
  now = Date.now(),
) {
  let eta = '';
  let elapsed = '';
  if (state === 'waking' && presentation?.startupBeganAt) {
    const seconds = Math.max(0, (now - Date.parse(presentation.startupBeganAt)) / 1000);
    if (Number.isFinite(seconds)) {
      elapsed = `${Math.floor(seconds)} s`;
      if (presentation.estimatedStartupSeconds !== undefined) {
        const remaining = Math.ceil(presentation.estimatedStartupSeconds - seconds);
        if (remaining > 0) eta = `${remaining} s`;
      }
    }
  }
  return {
    server: presentation?.serverName ?? '',
    state: gatewayMessageDefaults[locale][state],
    eta,
    version: presentation?.variables?.version ?? '',
    runtime: minecraftGatewayRuntimeName(presentation?.variables?.runtime ?? ''),
    address: presentation?.variables?.address ?? '',
    elapsed,
  };
}

const stateLabels: Record<GatewayMessageState, { en: string; it: string }> = {
  sleeping: { en: 'Sleeping', it: 'In sospensione' },
  waking: { en: 'Starting', it: 'In avvio' },
  stopping: { en: 'Stopping', it: 'In arresto' },
  blocked: { en: 'Blocked', it: 'Bloccato' },
  maintenance: { en: 'Maintenance', it: 'Manutenzione' },
  manually_stopped: { en: 'Manually stopped', it: 'Arrestato manualmente' },
  wake_disabled: { en: 'Manual start required', it: 'Avvio manuale richiesto' },
  capacity_denied: { en: 'Insufficient capacity', it: 'Risorse insufficienti' },
  unavailable: { en: 'Temporarily unavailable', it: 'Temporaneamente non disponibile' },
};

export const minecraftGatewayMessages = gatewayMessageDefinitionSchema.parse({
  version: 1,
  channels: [
    {
      id: 'motd',
      label: { en: 'Server list message', it: 'Messaggio nella lista server' },
      maxLength: 512,
      multiline: true,
      formatting: {
        tokens: [
          ...formattingTokens,
          {
            value: '[align=center]',
            label: { en: 'Center alignment', it: 'Allineamento al centro' },
          },
          { value: '[align=right]', label: { en: 'Right alignment', it: 'Allineamento a destra' } },
        ],
        caseInsensitive: true,
      },
    },
    {
      id: 'disconnect',
      label: { en: 'Join message', it: 'Messaggio alla connessione' },
      maxLength: 512,
      multiline: true,
      formatting: { tokens: formattingTokens, caseInsensitive: true },
    },
  ],
  states: gatewayMessageStates.map((id) => ({
    id,
    label: stateLabels[id],
    defaults: {
      en: { motd: gatewayMessageDefaults.en[id], disconnect: gatewayMessageDefaults.en[id] },
      it: { motd: gatewayMessageDefaults.it[id], disconnect: gatewayMessageDefaults.it[id] },
    },
    previewVariables: {
      en: minecraftGatewayMessageValues(id, 'en'),
      it: minecraftGatewayMessageValues(id, 'it'),
    },
  })),
  variables: [
    { id: 'server', label: { en: 'Server name', it: 'Nome server' } },
    { id: 'state', label: { en: 'State', it: 'Stato' } },
    { id: 'eta', label: { en: 'Estimated time', it: 'Tempo stimato' } },
    { id: 'version', label: { en: 'Game version', it: 'Versione del gioco' } },
    { id: 'runtime', label: { en: 'Runtime', it: 'Runtime' } },
    { id: 'address', label: { en: 'Server address', it: 'Indirizzo server' } },
    { id: 'elapsed', label: { en: 'Elapsed startup time', it: 'Tempo trascorso dall’avvio' } },
  ],
});

/** Owner defaults follow the existing channel/state precedence. Hypothetical
 * editor states omit timing context rather than inventing elapsed time or estimates. */
export function resolveMinecraftGatewayMessages(
  responses: MinecraftGatewayResponses | undefined,
  serverName: string,
  context: Omit<GatewayPresentation, 'serverName' | 'messages'> = {},
  now = Date.now(),
): GatewayMessageDefinition {
  return gatewayMessageDefinitionSchema.parse({
    ...minecraftGatewayMessages,
    states: minecraftGatewayMessages.states.map((state) => ({
      ...state,
      defaults: Object.fromEntries(
        (['en', 'it'] as const).map((locale) => [
          locale,
          Object.fromEntries(
            (['motd', 'disconnect'] as const).map((channel) => {
              const configured = responses?.[channel] as
                | Record<string, { en: string; it: string }>
                | undefined;
              return [channel, configured?.[state.id]?.[locale] ?? state.defaults[locale][channel]];
            }),
          ),
        ]),
      ),
      previewVariables: {
        en: minecraftGatewayMessageValues(
          state.id as GatewayMessageState,
          'en',
          { ...context, serverName, messages: {} },
          now,
        ),
        it: minecraftGatewayMessageValues(
          state.id as GatewayMessageState,
          'it',
          { ...context, serverName, messages: {} },
          now,
        ),
      },
    })),
  });
}
