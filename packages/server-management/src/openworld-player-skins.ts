import { archiveSkinPng } from '../../../games/openworld/src/archived-skin.js';
import type { CaptureCursor } from '../../../games/openworld/src/capture-evidence.js';
import {
  OpenworldTokenExpired,
  readOpenworldTelemetry,
} from '../../../games/openworld/src/dashboard-api.js';
import { readOpenworldPlayerSkin } from '../../../games/openworld/src/player-skin.js';
import type { OpenworldTelemetryData } from '../../../games/openworld/src/telemetry.js';
import {
  assertCurrentOpenworldScope,
  createOpenworldNativeConnection,
  type OpenworldNativeOptions,
  type OpenworldScope,
  readOpenworldScope,
} from './openworld-telemetry.js';

type Session = CaptureCursor['sessions'][number];
type Member = OpenworldTelemetryData['players']['players'][number];
type Candidate = { account: string; id: number; hash: string };

// A connection may be recycled, and the same account may have simultaneous sessions.
// Store a view only if the native roster unambiguously agrees on its current skin.
function eligible(players: Member[], admitted: Session[]) {
  const ids = new Map<number, number>();
  const byAccount = new Map<string, Candidate | null>();
  const sessions = new Map(admitted.map((s) => [s.connection, s.account]));
  for (const p of players) {
    ids.set(p.id, (ids.get(p.id) ?? 0) + 1);
    if (p.admitted !== true || !p.accountVerified || !p.account) continue;
    const account = p.account.toLowerCase();
    const previous = byAccount.get(account);
    if (!p.skinHash || (previous !== undefined && previous?.hash !== p.skinHash)) {
      byAccount.set(account, null);
    } else if (previous === undefined || sessions.get(previous.id) !== account) {
      byAccount.set(account, { id: p.id, account, hash: p.skinHash });
    }
  }
  return Array.from(byAccount.values()).filter(
    (c): c is Candidate => !!c && sessions.get(c.id) === c.account && ids.get(c.id) === 1,
  );
}

export function createOpenworldSkinCollector(
  options: OpenworldNativeOptions,
  native = createOpenworldNativeConnection(options),
) {
  const { db, now = Date.now, fetcher = fetch } = options;
  const cursors = new Map<string, { key: string; next: number; after: string }>();
  return async (scope: OpenworldScope, sessions: Session[]) => {
    if (!sessions.length) {
      cursors.delete(scope.serverId);
      return;
    }
    const key = JSON.stringify([scope.liveKey, sessions]);
    const prev = cursors.get(scope.serverId);
    const observedAt = now();
    if (prev?.key === key && prev.next > observedAt) return;
    if (cursors.size >= 512 && !prev) cursors.delete(cursors.keys().next().value as string);
    const cursor = {
      key,
      next: observedAt + 45000 + Math.random() * 15000,
      after: prev?.after ?? '',
    };
    cursors.set(scope.serverId, cursor);
    await native(scope, async (origin, token, signal) => {
      const roster = async () =>
        eligible(
          (await readOpenworldTelemetry(origin, token, 'players', signal, undefined, fetcher))
            .players,
          sessions,
        );
      const active = await roster();
      if (!active.length) return;
      const known = await db
        .selectFrom('openworld_player_skins')
        .select(['account_id', 'skin_hash'])
        .where('server_id', '=', scope.serverId)
        .where('binding', '=', scope.binding)
        .where(
          'account_id',
          'in',
          active.map((p) => p.account),
        )
        .execute();
      const hashes = new Map(known.map((k) => [k.account_id, k.skin_hash]));
      const changed = active
        .filter((p) => hashes.get(p.account) !== p.hash)
        .sort(
          (a, b) =>
            Number(a.account <= cursor.after) - Number(b.account <= cursor.after) ||
            (a.account < b.account ? -1 : 1),
        );
      const batch = changed.slice(0, 4);
      const last = batch.at(-1);
      if (!last) return;
      // Rotate before I/O so a timeout cannot keep a busy server on the same four
      // accounts. Parallel pairs leave time for the identity fence on slow backends.
      cursor.after = last.account;
      if (changed.length > batch.length) cursor.next = 0;
      const outcomes = await Promise.allSettled(
        batch.map(async (p) => {
          const read = async (view: 'head' | 'body') =>
            archiveSkinPng(
              await readOpenworldPlayerSkin(origin, token, p.id, view, p.hash, signal, fetcher),
            );
          const [head, body] = await Promise.all([read('head'), read('body')]);
          return { p, head, body };
        }),
      );
      signal.throwIfAborted();
      const images = outcomes.flatMap((outcome) => {
        if (outcome.status === 'fulfilled') return [outcome.value];
        if (outcome.reason instanceof OpenworldTokenExpired) throw outcome.reason;
        return []; // A missing skin must not prevent other accounts from being archived.
      });
      if (!images.length) return;
      const final = new Map((await roster()).map((p) => [p.account, p]));
      const stable = images.filter(({ p }) => {
        const seen = final.get(p.account);
        return seen?.id === p.id && seen.hash === p.hash;
      });
      if (!stable.length) return;
      await db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('managed_servers')
          .select('id')
          .where('id', '=', scope.serverId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        assertCurrentOpenworldScope(scope, await readOpenworldScope(tx, scope.serverId));
        await tx
          .insertInto('openworld_player_skins')
          .values(
            stable.map(({ p, head, body }) => ({
              server_id: scope.serverId,
              binding: scope.binding,
              account_id: p.account,
              skin_hash: p.hash,
              observed_at: new Date(observedAt),
              head_png: head,
              body_png: body,
            })),
          )
          .onConflict((c) =>
            c
              .columns(['server_id', 'account_id'])
              .doUpdateSet((eb) => ({
                binding: eb.ref('excluded.binding'),
                skin_hash: eb.ref('excluded.skin_hash'),
                observed_at: eb.ref('excluded.observed_at'),
                head_png: eb.ref('excluded.head_png'),
                body_png: eb.ref('excluded.body_png'),
              }))
              .whereRef('openworld_player_skins.observed_at', '<', 'excluded.observed_at'),
          )
          .execute();
      });
    });
  };
}
