#!/bin/sh
# Plain sideload of examples/legacy-app (no brighttest). Usage: sideload.sh --host <ip>
# The developer password comes from the ROKU_PASSWORD environment variable only; it is never
# printed or written. Optional env: ROKU_USER (default rokudev).
set -eu
HOST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$HOST" ] || { echo "usage: sideload.sh --host <ip>" >&2; exit 2; }
[ -n "${ROKU_PASSWORD:-}" ] || { echo "ROKU_PASSWORD is not set" >&2; exit 2; }
APP="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
(cd "$APP" && zip -qr "$TMP/legacy-app.zip" manifest source components certs -x '*.bs' -x 'source/tests/*')
echo "sideloading legacy-app to $HOST"
# the credential is passed through a curl config on stdin so it never appears in argv
printf 'user = "%s:%s"\n' "${ROKU_USER:-rokudev}" "$ROKU_PASSWORD" | curl -sS --digest --config - \
  --connect-timeout 5 --max-time 60 \
  -F mysubmit=Install -F "archive=@$TMP/legacy-app.zip" \
  "http://$HOST/plugin_install" | grep -o 'Install Success\|Identical to previous version\|Install Failure[^<]*' || true
