import type { ColumnType, Generated } from 'kysely';

export interface GatewayRouteTables {
  gateway_routes: {
    id: string;
    gateway_id: string;
    server_id: string;
    allocation_id: string;
    public_address: string;
    public_port: number;
    transport: 'tcp' | 'udp';
    enabled: Generated<boolean>;
    revision: Generated<string>;
    payload_hash: string | null;
    lease_expires_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  gateway_control_state: {
    gateway_id: string;
    revision: Generated<string>;
    snapshot_hash: string | null;
    updated_at: Generated<Date>;
  };
  gateway_reachability_proofs: {
    route_id: string;
    proof: ColumnType<unknown, string, string>;
    updated_at: Generated<Date>;
  };
}
