import type {
  OpenworldFlags,
  OpenworldRuleFlag,
  OpenworldRulesSnapshot as Snapshot,
} from './rules.js';
import { openworldRuleFlags } from './rules.js';
import { zonesFromFile } from './rules-documents.js';

type Reply = { accepted: boolean; lines: string[] } | undefined;

export function globalFlags(reply: Reply): OpenworldFlags | null {
  if (!reply?.accepted) return null;
  const match =
    /^(?:No zone yet \(\/zone create NAME \[RADIUS\]\)\.|\d+ zone\(s\)\.) Server rules: (.+)$/.exec(
      reply.lines[0] ?? '',
    );
  if (!match?.[1]) return null;
  if (match[1] === '-') return {};
  const result: OpenworldFlags = {};
  for (const part of match[1].split(', ')) {
    const pair = /^([a-z]+) (✓|✗)$/.exec(part);
    const key = pair?.[1] as OpenworldRuleFlag;
    if (!pair || !openworldRuleFlags.includes(key) || result[key]) return null;
    result[key] = pair[2] === '✓' ? 'allow' : 'deny';
  }
  return result;
}
export function permissionNodes(reply: Reply) {
  if (!reply?.accepted || !reply.lines[0]?.startsWith('Permissions (a role grants patterns:'))
    return null;
  const nodes = reply.lines.slice(1).map((l) => /^ {2}• ([a-z0-9_.*-]{1,128}) — .+$/.exec(l)?.[1]);
  return nodes.length && nodes.every((n): n is string => !!n) ? nodes : null;
}
export function mergeZoneDetails(live: Snapshot['zones'], doc: unknown) {
  const index = new Map(
    zonesFromFile(doc)?.map((z) => [JSON.stringify([z.world?.toLowerCase(), z.name]), z]),
  );
  return live?.map((z) => index.get(JSON.stringify([z.world?.toLowerCase(), z.name])) ?? z) ?? null;
}
