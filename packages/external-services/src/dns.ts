import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { ProviderHttp } from './http.js';

export type DnsRecord =
  | { type: 'A' | 'AAAA' | 'CNAME'; name: string; content: string; ttl: number; proxied: false }
  | {
      type: 'SRV';
      name: string;
      data: { priority: number; weight: number; port: number; target: string };
      ttl: number;
      proxied: false;
    };
export interface DnsOwnership {
  instanceId: string;
  serverId: string;
  assignmentId: string;
}
export interface OwnedDnsRecord {
  id: string;
  zoneId: string;
  ownership: DnsOwnership;
  record: DnsRecord;
}
export interface ObservedDnsRecord {
  id: string;
  type: string;
  name: string;
  content?: string;
  ttl: number;
  proxied?: boolean;
  comment?: string;
  data?: { priority: number; weight: number; port: number; target: string };
}
export type DnsChange =
  | { action: 'create'; zoneId: string; ownership: DnsOwnership; record: DnsRecord }
  | { action: 'update' | 'delete'; previous: OwnedDnsRecord; record: DnsRecord };
export interface ConnectionPlan {
  hostname: string;
  port: number;
  displayAddress: string;
  records: DnsRecord[];
}
export type ConnectionRequest =
  | { mode: 'static-host-port'; hostname: string; port: number }
  | {
      mode: 'custom-subdomain';
      zoneName: string;
      subdomain: string;
      port: number;
      target: { type: 'A' | 'AAAA' | 'CNAME'; content: string };
      ttl?: number;
      srv?: { service: string; protocol: 'tcp' | 'udp'; priority?: number; weight?: number };
    };

function host(input: string): string {
  if (
    /[\\/:?#@%\s]/.test(input) ||
    [...input].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new DomainError('validation_failed');
  const value = domainToASCII(input.toLowerCase().replace(/\.$/, ''));
  if (
    !value ||
    value.length > 253 ||
    value.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    throw new DomainError('validation_failed');
  return value;
}
function port(input: number): number {
  if (!Number.isSafeInteger(input) || input < 1 || input > 65535)
    throw new DomainError('validation_failed');
  return input;
}
function integer16(input: number): number {
  if (!Number.isSafeInteger(input) || input < 0 || input > 65535)
    throw new DomainError('validation_failed');
  return input;
}
function recordName(value: string): string {
  const srv = /^(_[a-z0-9-]+)\.(_(?:tcp|udp))\.(.+)$/i.exec(value);
  const name = srv
    ? `${srv[1]?.toLowerCase()}.${srv[2]?.toLowerCase()}.${host(srv[3] ?? '')}`
    : host(value);
  if (name.length > 253 || name.split('.').some((part) => part.length > 63))
    throw new DomainError('validation_failed');
  return name;
}
function record(value: DnsRecord): DnsRecord {
  const name = recordName(value.name);
  if (
    (value.ttl !== 1 && (value.ttl < 60 || value.ttl > 86400)) ||
    !Number.isInteger(value.ttl) ||
    value.proxied !== false
  )
    throw new DomainError('validation_failed');
  if (value.type === 'SRV') {
    if (!name.startsWith('_')) throw new DomainError('validation_failed');
    return {
      type: 'SRV',
      name,
      ttl: value.ttl,
      proxied: false,
      data: {
        port: port(value.data.port),
        target: host(value.data.target),
        priority: integer16(value.data.priority),
        weight: integer16(value.data.weight),
      },
    };
  }
  if (name.startsWith('_') || !['A', 'AAAA', 'CNAME'].includes(value.type))
    throw new DomainError('validation_failed');
  if (
    (value.type === 'A' && isIP(value.content) !== 4) ||
    (value.type === 'AAAA' && isIP(value.content) !== 6)
  )
    throw new DomainError('validation_failed');
  return {
    type: value.type,
    name,
    ttl: value.ttl,
    proxied: false,
    content: value.type === 'CNAME' ? host(value.content) : value.content,
  };
}
function ownershipMarker(ownership: DnsOwnership): string {
  if (
    ![ownership.instanceId, ownership.serverId, ownership.assignmentId].every(
      (id) => z.uuid().safeParse(id).success,
    )
  )
    throw new DomainError('validation_failed');
  return `nickhosting:${ownership.instanceId}:${ownership.serverId}:${ownership.assignmentId}`;
}
function key(value: Pick<DnsRecord, 'type' | 'name'>): string {
  return `${value.type}:${recordName(value.name)}`;
}
function equal(a: DnsRecord, b: DnsRecord): boolean {
  return JSON.stringify(record(a)) === JSON.stringify(record(b));
}
function validateZone(zoneId: string): void {
  if (!/^[a-f0-9]{32}$/.test(zoneId)) throw new DomainError('configuration_invalid');
}
function assertOwned(observed: ObservedDnsRecord, expected: OwnedDnsRecord): void {
  if (
    observed.id !== expected.id ||
    observed.comment !== ownershipMarker(expected.ownership) ||
    key(observed as DnsRecord) !== key(expected.record)
  )
    throw new DomainError('conflict');
}

/** Implements the plugin's declared connection mode. A static mode owns no DNS records. */
export function planConnection(input: ConnectionRequest): ConnectionPlan {
  const assignedPort = port(input.port);
  if (input.mode === 'static-host-port') {
    const hostname = host(input.hostname);
    return {
      hostname,
      port: assignedPort,
      displayAddress: `${hostname}:${assignedPort}`,
      records: [],
    };
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.subdomain))
    throw new DomainError('validation_failed');
  const hostname = host(`${input.subdomain}.${host(input.zoneName)}`);
  const target = record({
    type: input.target.type,
    name: hostname,
    content: input.target.content,
    ttl: input.ttl ?? 120,
    proxied: false,
  });
  const records = [target];
  if (input.srv) {
    if (
      !/^_[a-z0-9-]{1,62}$/.test(input.srv.service) ||
      !['tcp', 'udp'].includes(input.srv.protocol)
    )
      throw new DomainError('validation_failed');
    records.push(
      record({
        type: 'SRV',
        name: `${input.srv.service}._${input.srv.protocol}.${hostname}`,
        ttl: input.ttl ?? 120,
        proxied: false,
        data: {
          priority: input.srv.priority ?? 0,
          weight: input.srv.weight ?? 0,
          port: assignedPort,
          target: input.target.type === 'CNAME' ? input.target.content : hostname,
        },
      }),
    );
  }
  return {
    hostname,
    port: assignedPort,
    displayAddress: input.srv ? hostname : `${hostname}:${assignedPort}`,
    records,
  };
}

/** Caller must supply complete observations for every desired and previously owned name. */
export function planDnsChanges(input: {
  zoneId: string;
  ownership: DnsOwnership;
  desired: readonly DnsRecord[];
  observed: readonly ObservedDnsRecord[];
  ledger: readonly OwnedDnsRecord[];
}): DnsChange[] {
  validateZone(input.zoneId);
  const marker = ownershipMarker(input.ownership);
  const desired = input.desired.map(record);
  if (new Set(desired.map(key)).size !== desired.length) throw new DomainError('conflict');
  for (const item of input.ledger) {
    if (item.zoneId !== input.zoneId || ownershipMarker(item.ownership) !== marker)
      throw new DomainError('conflict');
    const live = input.observed.find((entry) => entry.id === item.id);
    if (live) assertOwned(live, item);
  }
  const ownedIds = new Set(input.ledger.map((entry) => entry.id));
  for (const item of desired) {
    // Reserve each name exclusively for this assignment, including CNAME/type conflicts.
    const atName = input.observed.filter((entry) => recordName(entry.name) === item.name);
    if (
      atName.some(
        (entry) =>
          !ownedIds.has(entry.id) &&
          !(
            entry.comment === marker &&
            desired.some(
              (candidate) =>
                key(entry as DnsRecord) === key(candidate) && equal(entry as DnsRecord, candidate),
            )
          ),
      )
    )
      throw new DomainError('conflict');
    if (atName.filter((entry) => key(entry as DnsRecord) === key(item)).length > 1)
      throw new DomainError('conflict');
    if (
      desired.some(
        (other) =>
          other !== item &&
          other.name === item.name &&
          (other.type === 'CNAME' || item.type === 'CNAME'),
      )
    )
      throw new DomainError('conflict');
  }
  const changes: DnsChange[] = [];
  // Delete old types/names first so replacing A with CNAME is accepted by Cloudflare.
  for (const previous of input.ledger) {
    if (
      !desired.some((entry) => key(entry) === key(previous.record)) &&
      input.observed.some((entry) => entry.id === previous.id)
    )
      changes.push({ action: 'delete', previous, record: previous.record });
  }
  for (const item of desired) {
    const previous = input.ledger.find((entry) => key(entry.record) === key(item));
    const live = previous && input.observed.find((entry) => entry.id === previous.id);
    if (!previous || !live)
      changes.push({
        action: 'create',
        zoneId: input.zoneId,
        ownership: input.ownership,
        record: item,
      });
    else if (!equal(live as DnsRecord, item))
      changes.push({ action: 'update', previous, record: item });
  }
  return changes;
}

const observedSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  type: z.string(),
  name: z.string(),
  ttl: z.number(),
  content: z.string().optional(),
  proxied: z.boolean().optional(),
  comment: z.string().nullable().optional(),
  data: z
    .object({ priority: z.number(), weight: z.number(), port: z.number(), target: z.string() })
    .optional(),
});

export class CloudflareDnsProvider {
  readonly #http: ProviderHttp;
  readonly #instanceId: string;
  constructor(input: {
    apiToken: string;
    instanceId: string;
    fetcher?: typeof fetch;
    baseURL?: string;
    timeoutMs?: number;
  }) {
    if (
      !input.apiToken.trim() ||
      input.apiToken.length > 4096 ||
      /[\r\n]/.test(input.apiToken) ||
      !z.uuid().safeParse(input.instanceId).success
    )
      throw new DomainError('configuration_invalid');
    this.#instanceId = input.instanceId;
    this.#http = new ProviderHttp({
      ...input,
      baseURL: input.baseURL ?? 'https://api.cloudflare.com/client/v4/',
      headers: { Authorization: `Bearer ${input.apiToken}` },
    });
  }
  #checkOwnership(ownership: DnsOwnership): void {
    ownershipMarker(ownership);
    if (ownership.instanceId !== this.#instanceId) throw new DomainError('forbidden');
  }
  async #request(zoneId: string, suffix = '', method = 'GET', body?: unknown): Promise<unknown> {
    validateZone(zoneId);
    const response = await this.#http.request(`zones/${zoneId}/dns_records${suffix}`, method, body);
    if (response.status === 404) return null;
    if (response.status === 409) throw new DomainError('conflict');
    const parsed = z
      .object({
        success: z.literal(true),
        result: z.unknown(),
        result_info: z
          .object({ total_pages: z.number().int().nonnegative().optional() })
          .optional(),
      })
      .safeParse(response.data);
    if (!parsed.success) throw new DomainError('integration_unavailable');
    return parsed.data;
  }
  #parseRecord(value: unknown): ObservedDnsRecord {
    const parsed = observedSchema.safeParse(value);
    if (!parsed.success) throw new DomainError('integration_unavailable');
    return {
      ...parsed.data,
      name: recordName(parsed.data.name),
      comment: parsed.data.comment ?? undefined,
    };
  }
  async listAtName(zoneId: string, name: string): Promise<ObservedDnsRecord[]> {
    const normalized = recordName(name);
    const result: ObservedDnsRecord[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = (await this.#request(
        zoneId,
        `?${new URLSearchParams({ name: normalized, page: String(page), per_page: '100' })}`,
      )) as { result: unknown[]; result_info?: { total_pages?: number } } | null;
      if (!response || !Array.isArray(response.result))
        throw new DomainError('integration_unavailable');
      const entries = response.result.map((entry) => this.#parseRecord(entry));
      if (entries.some((entry) => entry.name !== normalized))
        throw new DomainError('integration_unavailable');
      result.push(...entries);
      if (response.result_info?.total_pages === undefined && entries.length >= 100)
        throw new DomainError('integration_unavailable');
      if (page >= (response.result_info?.total_pages ?? 1)) return result;
    }
    throw new DomainError('integration_unavailable');
  }
  async plan(input: {
    zoneId: string;
    ownership: DnsOwnership;
    desired: readonly DnsRecord[];
    ledger: readonly OwnedDnsRecord[];
  }): Promise<DnsChange[]> {
    this.#checkOwnership(input.ownership);
    const names = [
      ...new Set(
        [...input.desired, ...input.ledger.map((entry) => entry.record)].map((entry) =>
          recordName(entry.name),
        ),
      ),
    ];
    const observed = (
      await Promise.all(names.map((name) => this.listAtName(input.zoneId, name)))
    ).flat();
    return planDnsChanges({ ...input, observed });
  }

  /** Recover only existing records proven by the durable assignment intent; never creates DNS. */
  async inspectOwned(input: {
    zoneId: string;
    ownership: DnsOwnership;
    desired: readonly DnsRecord[];
  }): Promise<OwnedDnsRecord[]> {
    this.#checkOwnership(input.ownership);
    const recovered: OwnedDnsRecord[] = [];
    for (const desired of input.desired.map(record)) {
      const owned = (await this.listAtName(input.zoneId, desired.name)).filter(
        (entry) =>
          entry.comment === ownershipMarker(input.ownership) &&
          key(entry as DnsRecord) === key(desired),
      );
      if (owned.length > 1 || owned.some((entry) => !equal(entry as DnsRecord, desired)))
        throw new DomainError('conflict');
      if (owned[0])
        recovered.push({
          id: owned[0].id,
          zoneId: input.zoneId,
          ownership: input.ownership,
          record: desired,
        });
    }
    return recovered;
  }
  async apply(
    changes: readonly DnsChange[],
    input: {
      onRecordCreated: (record: OwnedDnsRecord) => Promise<void>;
      onRecordDeleted: (record: OwnedDnsRecord) => Promise<void>;
    },
  ): Promise<void> {
    for (const change of changes) {
      const ownership = change.action === 'create' ? change.ownership : change.previous.ownership;
      const zoneId = change.action === 'create' ? change.zoneId : change.previous.zoneId;
      this.#checkOwnership(ownership);
      const desired = record(change.record);
      if (change.action === 'create') {
        const atName = await this.listAtName(zoneId, desired.name);
        if (atName.some((entry) => entry.comment !== ownershipMarker(ownership)))
          throw new DomainError('conflict');
        const matching = atName.filter((entry) => key(entry as DnsRecord) === key(desired));
        // A durable create intent plus exact marker/content recovers an acknowledged-lost POST.
        if (matching.length) {
          if (matching.length !== 1 || !equal(matching[0] as DnsRecord, desired))
            throw new DomainError('conflict');
          const recovered = matching[0];
          if (!recovered) throw new DomainError('conflict');
          await input.onRecordCreated({ id: recovered.id, zoneId, ownership, record: desired });
          continue;
        }
        if (atName.some((entry) => entry.type === 'CNAME' || desired.type === 'CNAME'))
          throw new DomainError('conflict');
        const response = (await this.#request(zoneId, '', 'POST', {
          ...desired,
          comment: ownershipMarker(ownership),
        })) as { result: unknown } | null;
        if (!response) throw new DomainError('integration_unavailable');
        const created = this.#parseRecord(response.result);
        if (created.comment !== ownershipMarker(ownership) || !equal(created as DnsRecord, desired))
          throw new DomainError('integration_unavailable');
        await input.onRecordCreated({ id: created.id, zoneId, ownership, record: desired });
      } else {
        if (!/^[a-f0-9]{32}$/.test(change.previous.id)) throw new DomainError('validation_failed');
        const response = (await this.#request(zoneId, `/${change.previous.id}`)) as {
          result: unknown;
        } | null;
        if (!response) {
          if (change.action === 'delete') {
            await input.onRecordDeleted(change.previous);
            continue;
          }
          throw new DomainError('conflict');
        }
        assertOwned(this.#parseRecord(response.result), change.previous);
        if (change.action === 'delete') {
          await this.#request(zoneId, `/${change.previous.id}`, 'DELETE');
          await input.onRecordDeleted(change.previous);
        } else {
          if (key(desired) !== key(change.previous.record)) throw new DomainError('conflict');
          const atName = await this.listAtName(zoneId, desired.name);
          if (atName.some((entry) => entry.comment !== ownershipMarker(ownership)))
            throw new DomainError('conflict');
          const updated = (await this.#request(zoneId, `/${change.previous.id}`, 'PUT', {
            ...desired,
            comment: ownershipMarker(ownership),
          })) as { result: unknown } | null;
          if (!updated) throw new DomainError('conflict');
          const observed = this.#parseRecord(updated.result);
          assertOwned(observed, change.previous);
          if (!equal(observed as DnsRecord, desired))
            throw new DomainError('integration_unavailable');
          await input.onRecordCreated({ ...change.previous, record: desired });
        }
      }
    }
  }
}
