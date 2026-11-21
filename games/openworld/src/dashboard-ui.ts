import type { GameUiHandler } from '@nickhosting/game-sdk/ui';
import { z } from 'zod';

export const dashboardStatusSchema = z.object({
  tps: z.number().nonnegative(),
  players: z.object({ online: z.number().int().nonnegative(), slots: z.number().int().positive() }),
  memory: z.object({ rssMB: z.number().nonnegative() }),
});
export const dashboardStateSchema = z.object({
  enabled: z.boolean(),
  canConfigure: z.boolean(),
  privateAddress: z.string().nullable(),
});
export const openworldDashboardSection = {
  id: 'dashboard',
  titleKey: 'games.openworld.dashboard.title',
  loader: 'dashboard',
  renderer: 'openworld-dashboard',
  navigation: { group: 'config', order: 20, icon: 'settings', placement: 'settings' },
  requiredPermissions: ['settings.read'],
  managePermissions: ['settings.write'],
  requiredCapabilities: [],
  forms: [],
  columns: [],
};
export const openworldDashboardHandlers: Record<string, GameUiHandler> = {
  async dashboard(client, { serverId, signal }) {
    const state = dashboardStateSchema.parse(
      await client.request(`/v1/servers/${serverId}/openworld/dashboard`, { signal }),
    );
    return { values: {}, rows: [], metadata: state };
  },
};
const messages = {
  title: ['Web dashboard', 'Dashboard web'],
  enabled: ['Enable web dashboard', 'Attiva la dashboard web'],
  apply: [
    'Changes take effect the next time the server starts.',
    'Le modifiche si applicano al prossimo avvio del server.',
  ],
  native: ['Open native dashboard', 'Apri la dashboard nativa'],
  private: [
    'The native dashboard uses the server’s private network. Connect through your private network or VPN to open it.',
    'La dashboard nativa usa la rete privata del server. Per aprirla connettiti dalla rete privata o tramite VPN.',
  ],
  show: ['Show dashboard password', 'Mostra password della dashboard'],
  hide: ['Hide password', 'Nascondi password'],
  status: ['Live status', 'Stato in tempo reale'],
  unavailable: ['The dashboard has not responded yet.', 'La dashboard non ha ancora risposto.'],
  offline: [
    'Start the server to view live status.',
    'Avvia il server per visualizzare lo stato in tempo reale.',
  ],
  refresh: ['Refresh', 'Aggiorna'],
  players: ['Players', 'Giocatori'],
  tps: ['Ticks per second', 'Tick al secondo'],
  memory: ['Server memory', 'Memoria del server'],
};
export const openworldDashboardCatalogs = {
  en: Object.fromEntries(
    Object.entries(messages).map(([id, [en]]) => [`games.openworld.dashboard.${id}`, en]),
  ),
  it: Object.fromEntries(
    Object.entries(messages).map(([id, [, it]]) => [`games.openworld.dashboard.${id}`, it]),
  ),
};
