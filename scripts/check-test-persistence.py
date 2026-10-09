#!/usr/bin/env python3
"""Explicitly approved restart check; only the dedicated M1 Compose project."""
import json
from pathlib import Path
import subprocess
import sys
import uuid

COMPOSE = ["docker", "compose", "--env-file", ".env.test.local", "-f", "compose.test.yaml"]
PROJECT = "nickhosting-m1-tests"


def run(args, data=None):
    return subprocess.check_output(args, input=data, text=True).strip()


def main():
    if sys.argv[1:] != ["--restart-approved-test-services"]:
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
                or labels.get("com.docker.compose.project.config_files") != str(root / "compose.test.yaml")
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

    assert redis("SET", key, marker) == "OK"
    subprocess.run(COMPOSE + ["restart", "postgres", "redis"], check=True)
    subprocess.run(COMPOSE + ["up", "-d", "--wait", "--no-recreate", "postgres", "redis"], check=True)
    assert run(psql + [f"SELECT value->>'instanceName' FROM \"{schema}\".platform_settings"]) == marker
    assert run(psql + [f'SELECT count(*) FROM "{schema}"."user"']) == "0"
    assert redis("GET", key) == marker
    run(psql + [f'DROP SCHEMA "{schema}" CASCADE'])
    assert redis("DEL", key) == "1"
    print("PASS: All M1 PostgreSQL schema and settings plus Redis markers survived approved service restart; only generated fixtures cleaned.")


if __name__ == "__main__":
    main()
