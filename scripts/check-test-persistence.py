#!/usr/bin/env python3
"""Explicitly approved restart check; only a dedicated M1 or M2 Compose project."""
import json
from pathlib import Path
import subprocess
import sys
import uuid

M2 = "--m2" in sys.argv[1:]
CONFIG = "compose.m2-test.yaml" if M2 else "compose.test.yaml"
COMPOSE = ["docker", "compose", "--env-file", ".env.m2-test.local" if M2 else ".env.test.local", "-f", CONFIG]
PROJECT = "nickhosting-m2-tests" if M2 else "nickhosting-m1-tests"


def run(args, data=None):
    return subprocess.check_output(args, input=data, text=True).strip()


def main():
    if [arg for arg in sys.argv[1:] if arg != "--m2"] != ["--restart-approved-test-services"]:
        raise SystemExit("Requires explicit Owner approval and --restart-approved-test-services")
    root = Path(__file__).resolve().parent.parent
    if Path.cwd().resolve() != root:
        raise SystemExit("Run from the project root")
    for service in ("postgres", "redis"):
        identifier = run(COMPOSE + ["ps", "-q", service])
        state = json.loads(run(["docker", "inspect", identifier]))[0]
        labels = state["Config"]["Labels"]
        if (labels.get("com.docker.compose.project") != PROJECT
                or labels.get("com.docker.compose.service") != service
                or labels.get("com.docker.compose.project.working_dir") != str(root)
                or labels.get("com.docker.compose.project.config_files") != str(root / CONFIG)
                or list(state["NetworkSettings"]["Networks"]) != [PROJECT + "_default"]):
            raise SystemExit("Test resource ownership mismatch; no operation performed")
    schema = "nh_persistence_" + uuid.uuid4().hex
    key = "nh-test-persistence:" + uuid.uuid4().hex
    marker = uuid.uuid4().hex
    psql = COMPOSE + ["exec", "-T", "postgres", "psql", "-U", "nickhosting_test",
                      "-d", "nickhosting_test", "-v", "ON_ERROR_STOP=1", "-At", "-c"]

    def redis(*args):
        # Credentials remain inside the already-approved container environment.
        return run(COMPOSE + ["exec", "-T", "redis", "/bin/sh", "-c",
                   'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --raw "$@"', "redis-check", *args])

    migrations = "\n".join(path.read_text() for path in sorted(Path("packages/database/migrations").glob("*.sql")))
    run(psql + [f'BEGIN; CREATE SCHEMA "{schema}"; SET LOCAL search_path="{schema}"; '
                + migrations + f"INSERT INTO platform_settings(key,value) VALUES ('platform','{{\"instanceName\":\"{marker}\"}}'); COMMIT;"])
    assert run(psql + [f'SELECT count(*) FROM "{schema}"."user"']) == "0"
    job = str(uuid.uuid4())
    actor = uuid.uuid4().hex
    run(psql + [f'''SET search_path="{schema}";
        INSERT INTO "user"(id,name,email,role) VALUES ('{actor}','Isolated restart fixture','{actor}@example.test','user');
        INSERT INTO operation_jobs(id,actor_id,subject_id,resource_owner_id,idempotency_key,command_hash,command,policy_snapshot,max_attempts)
        VALUES ('{job}','{actor}','{actor}','{actor}','{job}','{'0' * 64}','{{"type":"foundation.check","version":1,"payload":{{}}}}','{{}}',3);
        INSERT INTO job_outbox(job_id) VALUES ('{job}');
        INSERT INTO job_steps(job_id,step) VALUES ('{job}','fixture.checkpoint');'''])

    if M2:
        host, node, mapping, server, claim, allocation = (str(uuid.uuid4()) for _ in range(6))
        # Only this generated isolated schema is populated. No provider request
        # or real filesystem path is involved in the durable-claim restart test.
        run(psql + [f'''SET search_path="{schema}";
            INSERT INTO physical_hosts(id,name,memory_limit_mib,cpu_limit_percent,storage_pool_mib,
                memory_headroom_mib,cpu_headroom_percent,disk_headroom_mib,local_disk_path,observer_id)
            VALUES ('{host}','Restart fixture',2048,200,4096,256,20,256,'/isolated-fixture','fixture');
            INSERT INTO managed_nodes(id,physical_host_id,pterodactyl_node_id,provision_user_id)
            VALUES ('{node}','{host}',1,1);
            INSERT INTO game_integrations(id,version,manifest) VALUES ('{mapping}','1','{{}}');
            INSERT INTO runtime_egg_mappings(id,game_id,runtime_id,node_id,nest_id,egg_id,
                docker_image,startup,environment,port_roles,feature_limits)
            VALUES ('{mapping}','{mapping}','fixture','{node}',1,1,'fixture','fixture','{{}}','[]','{{}}');
            INSERT INTO managed_servers(id,owner_id,mapping_id,node_id,name,external_id,limits)
            VALUES ('{server}','{actor}','{mapping}','{node}','Restart fixture','{server}','{{}}');
            INSERT INTO server_allocations(id,server_id,node_id,pterodactyl_allocation_id,
                address,backend_address,port,role,protocols,is_primary)
            VALUES ('{allocation}','{server}','{node}',1,'127.0.0.1','10.0.0.254',25565,
                'game',ARRAY['tcp','udp'],true);
            INSERT INTO upload_ingestion_claims(id,physical_host_id,server_id,actor_user_id,
                declared_bytes,reserved_bytes,scope,scope_hash)
            VALUES ('{claim}','{host}','{server}','{actor}',1024,67584,
                '{{"fixture":"{marker}"}}','{'0' * 64}');'''])

    if M2:
        gateway, route, generation = (str(uuid.uuid4()) for _ in range(3))
        run(psql + [f'''SET search_path="{schema}";
            INSERT INTO gateway_server_states(server_id,generation,enabled,protocol_id,game_version,state,
                idle_timeout_seconds,readiness_timeout_seconds,readiness_max_age_seconds,estimate_max_age_seconds,wake_retry_seconds,wake_job_id)
            VALUES ('{server}','{generation}',true,'fixture','1','waking',60,60,15,3600,10,'{job}');
            INSERT INTO gateway_routes(id,gateway_id,server_id,allocation_id,public_address,public_port,transport,lease_expires_at)
            VALUES ('{route}','{gateway}','{server}','{allocation}','192.0.2.1',25565,'tcp',TIMESTAMPTZ '2099-01-01 00:00:00+00');
            INSERT INTO gateway_control_state(gateway_id,revision,snapshot_hash) VALUES ('{gateway}',7,'{marker}');
            INSERT INTO gateway_reachability_proofs(route_id,proof) VALUES ('{route}','{{"fixture":"{marker}"}}');'''])

    assert redis("SET", key, marker) == "OK"
    subprocess.run(COMPOSE + ["restart", "postgres", "redis"], check=True)
    subprocess.run(COMPOSE + ["up", "-d", "--wait", "--no-recreate", "postgres", "redis"], check=True)
    assert run(psql + [f"SELECT value->>'instanceName' FROM \"{schema}\".platform_settings"]) == marker
    assert run(psql + [f"SELECT state FROM \"{schema}\".operation_jobs WHERE id='{job}'"]) == "queued"
    assert run(psql + [f"SELECT count(*) FROM \"{schema}\".job_outbox WHERE job_id='{job}'"]) == "1"
    assert run(psql + [f"SELECT step FROM \"{schema}\".job_steps WHERE job_id='{job}'"]) == "fixture.checkpoint"
    assert redis("GET", key) == marker
    if M2:
        assert run(psql + [f'''SELECT address || ':' || backend_address || ':' || port::text
            FROM "{schema}".server_allocations WHERE id='{allocation}'
            AND server_id='{server}' AND node_id='{node}'
            ''']) == '127.0.0.1:10.0.0.254:25565'
        # The nested exception block rolls back only the deliberately attempted
        # fixture retarget. If the trigger stops protecting identity, fail loudly.
        run(psql + [f'''SET search_path="{schema}";
            DO $test$ BEGIN
                BEGIN
                    UPDATE server_allocations SET backend_address='10.0.0.253'
                    WHERE id='{allocation}';
                    RAISE EXCEPTION 'identity retarget unexpectedly succeeded';
                EXCEPTION WHEN raise_exception THEN
                    IF SQLERRM <> 'allocation identity is immutable' THEN RAISE; END IF;
                END;
            END $test$;'''])
        assert run(psql + [f'''SELECT server_id::text || ':' || declared_bytes::text || ':' ||
            reserved_bytes::text || ':' || (scope->>'fixture')
            FROM "{schema}".upload_ingestion_claims WHERE id='{claim}' AND physical_host_id='{host}'
            ''']) == f"{server}:1024:67584:{marker}"
    if M2:
        assert run(psql + [f'''SELECT generation::text || ':' || state || ':' || wake_job_id::text
            FROM "{schema}".gateway_server_states WHERE server_id='{server}'
            ''']) == f"{generation}:waking:{job}"
        assert run(psql + [f'''SELECT revision FROM "{schema}".gateway_control_state
            WHERE gateway_id='{gateway}' AND snapshot_hash='{marker}'
            ''']) == '7'
        assert run(psql + [f'''SELECT count(*) FROM "{schema}".gateway_routes
            WHERE id='{route}' AND allocation_id='{allocation}' AND lease_expires_at=TIMESTAMPTZ '2099-01-01 00:00:00+00'
            ''']) == '1'
        assert run(psql + [f'''SELECT proof->>'fixture' FROM "{schema}".gateway_reachability_proofs
            WHERE route_id='{route}'
            ''']) == marker
    run(psql + [f'DROP SCHEMA "{schema}" CASCADE'])
    assert redis("DEL", key) == "1"
    claims = ", immutable provider/effective allocation addresses, ambiguous upload claim, Gateway wake generation/job, route lease/revision and reachability proof" if M2 else ""
    print(f"PASS: PostgreSQL migrations, settings, queued job, outbox/checkpoint{claims} and Redis marker survived approved scoped restart; only generated fixtures cleaned.")


if __name__ == "__main__":
    main()
