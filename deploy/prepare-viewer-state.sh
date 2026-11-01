#!/usr/bin/env bash
set -euo pipefail

# PREPARATION SCRIPT ONLY. Running it creates one new private state directory and
# one transient, networkless helper container. Requires its own Owner approval.
if [[ $# != 3 || ${1:-} != --owner-approved || ! ${2:-} =~ ^[1-9][0-9]{0,9}$ || ! ${3:-} =~ ^[1-9][0-9]{0,9}$ ]]; then
  printf '%s\n' 'Usage: bash deploy/prepare-viewer-state.sh --owner-approved READER_UID READER_GID' >&2
  exit 2
fi
reader_uid=$2
reader_gid=$3
if (( 10#$reader_uid < 1 || 10#$reader_uid > 2147483647 || 10#$reader_gid < 1 || 10#$reader_gid > 2147483647 )); then
  printf '%s\n' 'A verified non-root UID/GID is required.' >&2
  exit 2
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
workspace=$(pwd -P)
cd -- "$workspace"
storage_root=$(node deploy/storage-root.mjs --workspace "$workspace" --require-existing)
for directory in "$storage_root/dev"; do
  if [[ ! -d $directory || -L $directory || $(realpath -- "$directory") != "$directory" ]]; then
    printf '%s\n' 'Existing development parent is absent or is a symlink; no changes made.' >&2
    exit 1
  fi
done
state="$storage_root/dev/sftpgo-viewer"
if [[ -e $state || -L $state ]]; then
  printf '%s\n' 'Viewer state already exists. Preserve and inspect it; preparation never repairs or resets existing state.' >&2
  exit 1
fi
if docker container inspect nickhosting-dev-viewer-prepare >/dev/null 2>&1; then
  printf '%s\n' 'Preparation container name is occupied; no changes made.' >&2
  exit 1
fi
image=drakkan/sftpgo:v2.7.6@sha256:1edd28d80de2a008863fbfc58c8ff7db47b1b410bae48d4e6076192337809b11
# Avoid an implicit pull after partially preparing state.
docker image inspect "$image" >/dev/null
umask 077
mkdir -- "$state"
# Mount ONLY the newly created empty state directory. The Wings root and existing
# dev data are not available to this helper. No recursive chmod/chown, no cleanup.
docker run --rm --pull never --name nickhosting-dev-viewer-prepare \
  --network none --user 0:0 --read-only --cap-drop ALL --cap-add CHOWN --cap-add FOWNER \
  --security-opt no-new-privileges:true --pids-limit 32 --memory 64m --cpus 0.25 \
  --label nickhosting.purpose=viewer-state-preparation \
  --entrypoint /bin/sh --mount "type=bind,src=$state,dst=/viewer-state" \
  "$image" -eu -c 'chown "$1:$2" /viewer-state; chmod 0700 /viewer-state; stat -c "%u:%g %a" /viewer-state' \
  viewer-state "$reader_uid" "$reader_gid"
