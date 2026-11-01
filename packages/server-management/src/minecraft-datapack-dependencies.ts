import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { FilemanEntry } from '@nickhosting/game-sdk';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';

/** Current graph only: retain the latest applied writer of each path, plus live drafts.
 * Audit history may grow indefinitely without truncating active dependency receipts. */
export async function datapackStateRows(db: Kysely<Database>, serverId: string, world: string) {
  const result = await sql<Selectable<Database['minecraft_datapack_changes']>>`
    WITH latest_touches AS (
      SELECT DISTINCT ON (t.path) c.id, t.path
      FROM minecraft_datapack_changes c
      CROSS JOIN LATERAL (VALUES (c.plan->>'from'),(c.plan->>'to')) AS t(path)
      WHERE c.server_id=${serverId} AND c.world=${world} AND c.state='applied' AND t.path IS NOT NULL
      ORDER BY t.path,c.created_at DESC,c.id DESC
    )
    SELECT c.* FROM minecraft_datapack_changes c
    WHERE c.server_id=${serverId} AND c.world=${world} AND (
      c.state IN ('preparing','ready','dispatched','uncertain','failed') OR
      (c.state='applied' AND c.action<>'delete' AND EXISTS (
        SELECT 1 FROM latest_touches t WHERE t.id=c.id AND t.path=c.plan->>'to'
      ))
    ) ORDER BY c.created_at DESC,c.id DESC
  `.execute(db);
  return result.rows;
}

const reference = z.object({ projectId: z.string(), versionId: z.string().optional() });
export const datapackProvenanceSchema = z.object({
  provider: z.enum(['modrinth', 'curseforge']),
  projectId: z.string(),
  versionId: z.string(),
  required: z.array(reference),
  conflicts: z.array(reference),
  mods: z
    .array(
      z.object({
        projectId: z.string(),
        versionId: z.string(),
        path: z.string(),
        size: z.number(),
        modifiedAt: z.string(),
      }),
    )
    .default([]),
});
export type DatapackProvenance = z.infer<typeof datapackProvenanceSchema>;
export type DatapackReceipt = {
  path: string;
  size: number;
  modifiedAt?: string;
  enabled: boolean;
  catalog: DatapackProvenance;
};
export type DependencyChange = {
  action: string;
  state: string;
  plan: unknown;
};
const receiptPlan = z.object({
  from: z.string(),
  to: z.string().nullable(),
  size: z.number(),
  modifiedAt: z.string().optional(),
  catalog: datapackProvenanceSchema.optional(),
});
export function datapackReceipts(rows: readonly DependencyChange[]): DatapackReceipt[] {
  const paths = new Set<string>();
  const receipts: DatapackReceipt[] = [];
  // Caller supplies newest first. Deletes and untracked replacements invalidate older receipts.
  for (const row of rows) {
    if (row.state !== 'applied') continue;
    const parsed = receiptPlan.safeParse(row.plan);
    if (!parsed.success) continue;
    const plan = parsed.data;
    const path = plan.to ?? plan.from;
    if (paths.has(path)) continue;
    paths.add(path);
    if (plan.from !== path) paths.add(plan.from);
    if (row.action === 'delete' || !plan.catalog || !plan.to) continue;
    receipts.push({
      path,
      size: plan.size,
      modifiedAt: plan.modifiedAt,
      enabled: !path.endsWith('.disabled') && !path.startsWith('.nickhosting-datapacks/'),
      catalog: plan.catalog,
    });
  }
  return receipts;
}
export function receiptMatches(receipt: DatapackReceipt, entry: FilemanEntry | undefined) {
  return (
    !!entry &&
    entry.kind === 'file' &&
    receipt.size === entry.size &&
    !!receipt.modifiedAt &&
    receipt.modifiedAt === entry.modifiedAt
  );
}
/** Pure final-state graph check. No provider calls or per-file network requests. */
export function assertDatapackDependencyGraph(
  receipts: readonly DatapackReceipt[],
  changes: readonly DependencyChange[],
  entries: ReadonlyMap<string, FilemanEntry>,
  mods: readonly {
    path: string;
    provider: string;
    projectId: string;
    versionId: string;
    incompatible?: readonly { provider: string; projectId: string; versionId?: string }[];
  }[] = [],
) {
  const final = new Map(
    receipts
      .filter((receipt) => receiptMatches(receipt, entries.get(receipt.path)))
      .map((receipt) => [receipt.path, receipt]),
  );
  for (const change of changes) {
    if (change.state !== 'ready') continue;
    const plan = receiptPlan.parse(change.plan);
    final.delete(plan.from);
    if (plan.to) final.delete(plan.to);
    if (change.action === 'delete' || change.action === 'disable' || !plan.catalog || !plan.to)
      continue;
    final.set(plan.to, {
      path: plan.to,
      size: plan.size,
      enabled: !plan.to.endsWith('.disabled') && !plan.to.startsWith('.nickhosting-datapacks/'),
      catalog: plan.catalog,
    });
  }
  const active = [...final.values()].filter((receipt) => receipt.enabled);
  const activeMods = mods.filter(
    (mod) => /^mods\/[^/]+\.jar$/.test(mod.path) && entries.get(mod.path)?.kind === 'file',
  );
  for (const pack of active) {
    const sameProvider = active.filter((item) => item.catalog.provider === pack.catalog.provider);
    for (const requirement of pack.catalog.required) {
      const dependency = sameProvider.some(
        (item) =>
          item.catalog.projectId === requirement.projectId &&
          (!requirement.versionId || item.catalog.versionId === requirement.versionId),
      );
      const mod = pack.catalog.mods.some((item) => {
        const entry = entries.get(item.path);
        return (
          item.projectId === requirement.projectId &&
          (!requirement.versionId || item.versionId === requirement.versionId) &&
          entry?.kind === 'file' &&
          item.size === entry.size &&
          item.modifiedAt === entry.modifiedAt
        );
      });
      if (!dependency && !mod)
        throw new DomainError('content_dependency_missing', 409, {
          projectId: requirement.projectId,
        });
    }
    for (const mod of activeMods) {
      if (
        (mod.provider === pack.catalog.provider &&
          pack.catalog.conflicts.some(
            (ref) =>
              ref.projectId === mod.projectId &&
              (!ref.versionId || ref.versionId === mod.versionId),
          )) ||
        mod.incompatible?.some(
          (ref) =>
            ref.provider === pack.catalog.provider &&
            ref.projectId === pack.catalog.projectId &&
            (!ref.versionId || ref.versionId === pack.catalog.versionId),
        )
      )
        throw new DomainError('content_dependency_conflict', 409, { projectId: mod.projectId });
    }
    for (const conflict of pack.catalog.conflicts) {
      if (
        sameProvider.some(
          (item) =>
            item.catalog.projectId === conflict.projectId &&
            (!conflict.versionId || item.catalog.versionId === conflict.versionId),
        )
      )
        throw new DomainError('content_dependency_conflict', 409, {
          projectId: conflict.projectId,
        });
    }
  }
}
