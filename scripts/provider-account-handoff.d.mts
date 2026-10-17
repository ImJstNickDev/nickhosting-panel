export type HandoffIdentity = {
  serverId: string;
  providerId: number;
  providerUuid: string;
  oldOwnerId: number;
};
export function parseArguments(args: string[]): HandoffIdentity;
export function assertRemote(
  remote: { id: number; uuid: string; identifier: string; external_id: string; node: number },
  server: { pterodactyl_identifier: string; external_id: string; pterodactyl_node_id: number },
  expected: HandoffIdentity,
): void;
export function assertHandoffRevision(
  snapshot: { type: string; revision: string | number },
  projection?: { revision: string | number },
): void;
export function main(args?: string[]): Promise<void>;
