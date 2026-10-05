#!/bin/sh
# Build the hub and (re)start it and its Cloudflare Tunnel on this machine
# (deploy/README.md). Extra arguments go to `docker compose up`, e.g. `hub`
# to restart only the hub.
set -eu
export HUB_HOME="${HUB_HOME:-$HOME/rotmg-hub}"
export HUB_UID="${HUB_UID:-$(id -u)}" HUB_GID="${HUB_GID:-$(id -g)}"
for need in "$HUB_HOME/hub.env" "$HUB_HOME/cloudflared/config.yml"; do
  [ -f "$need" ] || { echo "missing $need (deploy/README.md)" >&2; exit 1; }
done
mkdir -p "$HUB_HOME/data"
cd "$(dirname "$0")"
exec docker compose up -d --build "$@"
