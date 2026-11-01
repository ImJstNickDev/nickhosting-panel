import type { GameUiClient } from '@nickhosting/game-sdk/ui';

export type ModChoice = { reference: string; version: string; enabled?: boolean };
export type ModLock = {
  version: 1;
  mods: Record<
    string,
    {
      version: string;
      dependencies: Record<string, string> | null;
      targets: Record<string, { hash: string; link: string }>;
    }
  >;
};
export type ModProfile = {
  id: string;
  name: string;
  selection: ModChoice[];
  vanilla: boolean;
  requiredTargets?: ('Windows' | 'WindowsServer' | 'LinuxServer')[];
};
export type ModSnapshot = {
  revision: number;
  selection: ModChoice[];
  lock: ModLock;
  profiles: ModProfile[];
  activeProfileId: string | null;
  activePreviewJobId?: string | null;
  vanilla: boolean;
  externalMode: boolean;
  inventoryFingerprint: string | null;
  rollbackAvailable: boolean;
};
export type ModProject = {
  id: string;
  reference: string;
  name: string;
  description?: string;
  logo?: string | null;
  authors?: string[];
  tags?: string[];
  downloads?: number | null;
  updatedAt?: string | null;
  fullDescription?: string;
};
export type ModVersion = {
  version: string;
  gameVersion: string;
  dependencies: { mod_id: string; condition: string; optional: boolean }[];
  targets?: string[];
  requiredOnRemote?: boolean | null;
  changelog?: string;
  compatibility?: 'compatible' | 'incompatible' | 'unknown';
};
export type ModInventoryItem = {
  reference: string;
  name: string;
  version: string | null;
  path: string;
  managed: boolean;
  dependency: boolean;
  gameFeature: boolean;
  issues?: string[];
};
export type ModInventory = {
  items: ModInventoryItem[];
  fingerprint: string;
  diverged: boolean;
  gameVersion: number | null;
  issues?: { path: string; reason: string }[];
};
export type ModChange = {
  reference: string;
  action: 'install' | 'update' | 'remove' | 'enable' | 'disable' | 'unchanged';
  fromVersion?: string | null;
  toVersion?: string | null;
  dependency: boolean;
  requiredBy?: string[];
};
export type ModPlan = {
  id: string;
  status: 'pending' | 'ready' | 'failed' | 'applied';
  phase?: 'queued' | 'preparing' | 'inventory' | 'ready' | 'failed';
  revision: number;
  selection: ModChoice[];
  vanilla: boolean;
  lock: ModLock | null;
  changes: ModChange[];
  filesBytes: number;
  expiresAt?: string;
  errorCode?: string;
};
export type ModUpdates = {
  items: { reference: string; currentVersion: string; version: string }[];
};
export type ProfileInput = {
  name: string;
  selection: ModChoice[];
  vanilla: boolean;
  revision: number;
  idempotencyKey?: string;
  requiredTargets?: ('Windows' | 'WindowsServer' | 'LinuxServer')[];
};

/** Uses the same protected transport as the other bundled game controllers. */
export function createSatisfactoryModsController(client: GameUiClient) {
  const path = (serverId: string, suffix = '') =>
    `/v1/servers/${encodeURIComponent(serverId)}/satisfactory/mods${suffix}`;
  const get = <T>(serverId: string, suffix = '', signal?: AbortSignal) =>
    client.request(path(serverId, suffix), { signal }) as Promise<T>;
  const post = <T>(serverId: string, suffix: string, body: unknown) =>
    client.request(path(serverId, suffix), { method: 'POST', body }) as Promise<T>;
  return {
    snapshot: (id: string, signal?: AbortSignal) => get<ModSnapshot>(id, '', signal),
    inventory: (id: string, signal?: AbortSignal) => get<ModInventory>(id, '/inventory', signal),
    catalog: (id: string, query: string, offset: number, signal?: AbortSignal) =>
      get<{ items: ModProject[]; total: number }>(
        id,
        `/catalog?query=${encodeURIComponent(query)}&offset=${offset}`,
        signal,
      ),
    details: (id: string, reference: string, signal?: AbortSignal) =>
      get<ModProject>(id, `/catalog/${encodeURIComponent(reference)}`, signal),
    versions: (id: string, reference: string, signal?: AbortSignal) =>
      get<ModVersion[]>(id, `/versions/${encodeURIComponent(reference)}`, signal),
    updates: (id: string, signal?: AbortSignal) => get<ModUpdates>(id, '/updates', signal),
    preview: (
      id: string,
      input: {
        selection: ModChoice[];
        vanilla: boolean;
        revision: number;
        profileId?: string;
        idempotencyKey: string;
      },
    ) => post<{ planId: string; jobId: string }>(id, '/preview', input),
    plan: (id: string, planId: string, signal?: AbortSignal) =>
      get<ModPlan>(id, `/plans/${encodeURIComponent(planId)}`, signal),
    apply: (id: string, input: { planId: string; revision: number; idempotencyKey: string }) =>
      post<{ jobId: string }>(id, '/apply', input),
    saveProfile: (id: string, profileId: string | undefined, input: ProfileInput) =>
      client.request(path(id, `/profiles${profileId ? `/${encodeURIComponent(profileId)}` : ''}`), {
        method: profileId ? 'PUT' : 'POST',
        body: input,
      }) as Promise<ModProfile>,
    deleteProfile: (id: string, profileId: string, revision: number) =>
      client.request(path(id, `/profiles/${encodeURIComponent(profileId)}`), {
        method: 'DELETE',
        body: { revision },
      }) as Promise<void>,
    importProfile: (id: string, document: unknown, revision: number, idempotencyKey?: string) =>
      post<ModProfile>(id, '/profiles/import', { document, revision, idempotencyKey }),
    exportProfile: (id: string, profileId: string) =>
      get<unknown>(id, `/profiles/${encodeURIComponent(profileId)}/export`),
    reconcile: (
      id: string,
      input: { fingerprint: string; selection: ModChoice[]; revision: number; profileId?: string },
    ) => post<unknown>(id, '/reconcile', input),
    rollback: (id: string, revision: number, idempotencyKey: string) =>
      post<{ jobId: string }>(id, '/rollback', { revision, idempotencyKey }),
    beginExternal: (id: string, revision: number, idempotencyKey: string) =>
      post<{ externalMode: true; jobId: string | null }>(id, '/external/begin', {
        revision,
        idempotencyKey,
      }),
    finishExternal: (id: string, revision: number, inventoryFingerprint: string) =>
      post<{ externalMode: false }>(id, '/external/finish', { revision, inventoryFingerprint }),
  };
}
