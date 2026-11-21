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
  canOpen: z.boolean(),
  nativePrepared: z.boolean(),
  phase: z.enum(['disabled', 'pending', 'active', 'error']),
  hostname: z
    .string()
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
    .nullable(),
});
export const openworldDashboardSection = {
  id: 'dashboard',
  titleKey: 'games.openworld.dashboard.title',
  loader: 'dashboard',
  renderer: 'openworld-dashboard',
  navigation: { group: 'config', order: 20, icon: 'settings', placement: 'settings' },
  requiredPermissions: ['server:read'],
  anyPermissions: ['settings.read', 'game.openworld.dashboard.admin'],
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
  enabled: ['Publish web dashboard', 'Pubblica dashboard web'],
  permission: ['Access the administrative dashboard', 'Accedi alla dashboard amministrativa'],
  permissionHelp: [
    'Grants full control of Openworld, including console commands, regardless of other panel permissions.',
    'Consente di amministrare Openworld ed eseguire comandi di console anche se gli altri permessi del pannello li limitano.',
  ],
  native: ['Open dashboard', 'Apri dashboard'],
  missing: [
    'Assign a personal subdomain in Network to publish the dashboard.',
    'Assegna un sottodominio personale in Rete per pubblicare la dashboard.',
  ],
  pending: ['Publishing the dashboard…', 'Pubblicazione della dashboard in corso…'],
  failed: [
    'Publication failed. NickPanel will retry.',
    'Pubblicazione non riuscita. NickPanel riproverà.',
  ],
  unpublished: ['The dashboard is private.', 'La dashboard è privata.'],
  restart: [
    'The private dashboard will be available after the next server start.',
    'La dashboard privata sarà disponibile al prossimo avvio del server.',
  ],
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
