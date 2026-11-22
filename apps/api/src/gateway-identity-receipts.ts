/** Process-private receipts. They contain neither provider payloads nor service
 * credentials and can only corroborate an Openworld observation. */
export type GatewayIdentityReceipt = {
  revision: string;
  providerUuid: string;
  snapshotRevision: number;
  gatewayId: string;
  observedAt: number;
  expiresAt: number;
};

function sameScope(left: GatewayIdentityReceipt, right: GatewayIdentityReceipt) {
  return (
    left.revision === right.revision &&
    left.providerUuid === right.providerUuid &&
    left.gatewayId === right.gatewayId &&
    left.snapshotRevision === right.snapshotRevision
  );
}

export function createGatewayIdentityReceipts() {
  let sequence = 0;
  let binding = '';
  let current = new Map<string, GatewayIdentityReceipt>();
  let witnesses = new Map<string, { scope: GatewayIdentityReceipt; seenAt: number }>();
  function clear() {
    sequence++;
    current.clear();
    witnesses.clear();
  }
  function bind(provider: string) {
    if (binding !== provider) clear();
    binding = provider;
  }
  function lookup(id: string, provider: string) {
    const proof = binding === provider && current.get(id);
    const now = Date.now();
    return proof && proof.observedAt <= now && now < proof.expiresAt ? proof : undefined;
  }
  return {
    lookup,
    bind,
    clear,
    begin(provider: string) {
      bind(provider);
      const attempt = ++sequence;
      return {
        publish(candidates: Map<string, GatewayIdentityReceipt>, fresh: boolean) {
          if (attempt !== sequence) return;
          const next = new Map<string, GatewayIdentityReceipt>();
          const nextWitnesses = new Map<
            string,
            { scope: GatewayIdentityReceipt; seenAt: number }
          >();
          const now = Date.now();
          for (const [id, proof] of candidates) {
            const previous = witnesses.get(id);
            const witness =
              previous && sameScope(previous.scope, proof) && previous.seenAt <= now
                ? previous
                : { scope: proof, seenAt: now };
            nextWitnesses.set(id, witness);
            const prior = lookup(id, provider);
            // The long poll can confirm a revision between Gateway requests. Only
            // accept it if this exact local scope was also seen before that read.
            if (prior && prior.observedAt === proof.observedAt && sameScope(prior, proof))
              next.set(id, prior.expiresAt <= proof.expiresAt ? prior : proof);
            else if (fresh || witness.seenAt < proof.observedAt) next.set(id, proof);
          }
          current = next;
          witnesses = nextWitnesses;
        },
        discard() {
          if (attempt === sequence) clear();
        },
      };
    },
  };
}
