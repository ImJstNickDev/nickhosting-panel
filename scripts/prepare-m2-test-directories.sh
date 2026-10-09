#!/usr/bin/env bash
set -euo pipefail
# Requires separate Owner approval: the existing mountdata parent is root-owned.
cd "$(dirname "$0")/.."
test "${1:-}" = --owner-approved
test ! -L mountdata
test ! -L mountdata/m2-tests
test ! -L mountdata/test-assets
docker run --rm --network none --user 0 --entrypoint /bin/sh \
  --label nickhosting.purpose=m2-test-directory-preparation \
  --volume "$PWD/mountdata/m2-tests:/tests" \
  --volume "$PWD/mountdata/test-assets:/ledger" \
  postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 \
  -c 'mkdir -p /tests/sftpgo/state /tests/sftpgo/data && chown "$1:$2" /tests /tests/sftpgo /tests/sftpgo/state /tests/sftpgo/data /ledger' \
  prepare-m2 "$(id -u)" "$(id -g)"
