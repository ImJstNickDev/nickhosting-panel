import type { ConnectionMode } from '@nickhosting/game-sdk';
import { z } from 'zod';
import { canonicalAllocationAddress } from './allocation-pool.js';

const connectionSchema = z.object({
  hostname: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  records: z.array(
    z.object({
      type: z.string(),
      name: z.string().optional(),
      content: z.string().optional(),
      data: z.object({ port: z.number(), target: z.string().optional() }).optional(),
    }),
  ),
});
type ConfirmedConnection = z.infer<typeof connectionSchema>;

export function confirmedDnsConnection(assignment: { state: string; plan: unknown } | undefined) {
  const intent = assignment?.plan as { connection?: unknown; confirmedConnection?: unknown } | null;
  const result = connectionSchema.safeParse(
    assignment?.state === 'active' ? intent?.connection : intent?.confirmedConnection,
  );
  return result.data;
}

function primaryDnsRecord(confirmed: ConfirmedConnection) {
  return confirmed.records.find(
    (record) => record.name === confirmed.hostname && ['A', 'AAAA', 'CNAME'].includes(record.type),
  );
}

/** A gateway can bind behind NAT. After a port change, use the current port only
 * when the stored DNS target also identifies its public endpoint. */
export function canUseConfirmedEndpoint(
  confirmed: ConfirmedConnection | undefined,
  host: string,
  port: number,
) {
  if (!confirmed) return false;
  if (confirmed.port === port) return true;
  const record = primaryDnsRecord(confirmed);
  if (!record?.content) return false;
  if (record.type === 'AAAA') {
    const target = canonicalAllocationAddress(record.content);
    return !!target && target === canonicalAllocationAddress(host);
  }
  return record.content === host.toLowerCase().replace(/\.$/, '');
}

/** Only the declared service for the primary transport can replace the public port. */
export function playerAddress(
  host: string | null,
  port: number | null,
  transport: string,
  primary: boolean,
  mode: ConnectionMode | null,
  confirmed?: ConfirmedConnection,
) {
  if (!host || !port) return null;
  const explicit = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const srv = mode?.mode === 'custom-subdomain' ? mode.srv : undefined;
  if (
    !primary ||
    !srv ||
    srv.proto !== transport ||
    confirmed?.hostname !== host ||
    confirmed.port !== port
  )
    return explicit;

  const address = primaryDnsRecord(confirmed);
  const target = address?.type === 'CNAME' ? address.content : address?.name;
  const owner = `${srv.service}._${srv.proto}.${host}`;
  return target &&
    confirmed.records.some(
      (record) =>
        record.type === 'SRV' &&
        record.name === owner &&
        record.data?.port === port &&
        record.data.target === target,
    )
    ? host
    : explicit;
}
