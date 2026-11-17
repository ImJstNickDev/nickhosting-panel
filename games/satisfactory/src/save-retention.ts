import { z } from 'zod';

export const satisfactorySafetySaveRetentionSchema = z.strictObject({
  sessionName: z.string().min(1).max(4096),
  keep: z.number().int().min(1).max(100),
});
export const satisfactorySafetySaveName =
  /^nh-stop-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Keep at least one known recovery point for every session. The caller supplies
 * newest-first receipts; unverified filenames are never candidates. */
export function safetySaveRotationCandidates<T extends { session_name: string }>(
  receipts: readonly T[],
  keepForSession: (session: string) => number,
): T[] {
  const counts = new Map<string, number>();
  return receipts.filter((receipt) => {
    const seen = (counts.get(receipt.session_name) ?? 0) + 1;
    counts.set(receipt.session_name, seen);
    return seen > Math.max(1, keepForSession(receipt.session_name));
  });
}
