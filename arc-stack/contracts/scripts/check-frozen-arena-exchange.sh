#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

abi_tmp="$(mktemp)"
layout_tmp="$(mktemp)"
trap 'rm -f "$abi_tmp" "$layout_tmp"' EXIT

forge inspect ArenaExchange abi --json > "$abi_tmp"
forge inspect ArenaExchange storage-layout --json > "$layout_tmp"

diff -u artifacts/day15/ArenaExchange.abi.json "$abi_tmp"
diff -u artifacts/day15/ArenaExchange.storage-layout.json "$layout_tmp"

echo "ArenaExchange frozen ABI: MATCH"
echo "ArenaExchange frozen storage layout: MATCH"
