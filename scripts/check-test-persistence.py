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

    assert redis("SET", key, marker) == "OK"
    subprocess.run(COMPOSE + ["restart", "postgres", "redis"], check=True)
    subprocess.run(COMPOSE + ["up", "-d", "--wait", "--no-recreate", "postgres", "redis"], check=True)
    assert run(psql + [f"SELECT value->>'instanceName' FROM \"{schema}\".platform_settings"]) == marker
    assert run(psql + [f"SELECT state FROM \"{schema}\".operation_jobs WHERE id='{job}'"]) == "queued"
    assert run(psql + [f"SELECT count(*) FROM \"{schema}\".job_outbox WHERE job_id='{job}'"]) == "1"
    assert run(psql + [f"SELECT step FROM \"{schema}\".job_steps WHERE job_id='{job}'"]) == "fixture.checkpoint"
    assert redis("GET", key) == marker
    run(psql + [f'DROP SCHEMA "{schema}" CASCADE'])
    assert redis("DEL", key) == "1"
    print("PASS: PostgreSQL migrations, settings, queued job, outbox/checkpoint and Redis marker survived approved scoped restart; only generated fixtures cleaned.")


if __name__ == "__main__":
    main()
