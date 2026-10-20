#!/usr/bin/env bash
set -euo pipefail
# Explicit fresh test-directory preparation. Never repairs existing ownership.
if [[ ${1:-} != --owner-approved || $# -gt 2 || ($# == 2 && $2 != --m1) ]]; then
  printf '%s\n' 'Usage: bash scripts/prepare-m2-test-directories.sh --owner-approved [--m1]' >&2
  exit 2
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
workspace=$(pwd -P)
storage_root=$(node deploy/storage-root.mjs --workspace "$workspace" --require-existing)
scope=m2-tests
if [[ ${2:-} == --m1 ]]; then scope=m1-tests; fi
# Existing trees must be genuine directories; the helper also checks each child.
for path in "$storage_root/$scope" "$storage_root/test-assets"; do
  if [[ -L $path || (-e $path && ! -d $path) ]]; then
    printf '%s\n' 'Test storage contains a symlink or non-directory; no changes made.' >&2
    exit 1
  fi
done
docker run --rm --pull never --network none --user 0 --read-only \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges:true --pids-limit 32 --memory 64m --cpus 0.25 \
  --entrypoint /bin/sh \
  --label nickhosting.purpose=m2-test-directory-preparation \
  --mount "type=bind,src=$storage_root,dst=/storage" \
  postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 \
  -eu -c '
    umask 077
    scope=$3
    storage=$4
    paths="$scope $scope/postgres $scope/redis test-assets"
    if [ "$scope" = m2-tests ]; then
      paths="$paths $scope/sftpgo $scope/sftpgo/state $scope/sftpgo/data"
    fi
    for relative in $paths; do
      path=$storage/$relative
      if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
        printf "%s\n" "Refusing a symlink or non-directory in test storage." >&2
        exit 1
      fi
    done
    for relative in $paths; do
      path=$storage/$relative
      if [ ! -e "$path" ]; then
        mkdir "$path"
        chown "$1:$2" "$path"
        case "$relative" in
          */postgres) chmod 0711 "$path" ;;
          *) chmod 0700 "$path" ;;
        esac
      fi
    done
  ' prepare-tests "$(id -u)" "$(id -g)" "$scope" /storage
