#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(cat "$project_dir/.node-version")
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) arch=unsupported ;;
esac
node_bin="${NH_DEV_NODE_BIN:-$HOME/.local/share/nickhosting-node/node-v$version-linux-$arch/bin}"
if [ -x "$node_bin/node" ]; then
  PATH="$node_bin:$PATH"
  export PATH
fi
if [ "$(node --version)" != "v$version" ]; then
  printf 'Activate Node %s using your user-scoped runtime before continuing.\n' "$version" >&2
  exit 1
fi
exec "$@"
