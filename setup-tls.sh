#!/usr/bin/env bash
# setup-tls.sh — Issue/renew a TLS certificate via acme.sh for cURL DOOM.
#
# Usage:
#   ./setup-tls.sh <domain> [--force-renew]
#
# Prerequisites:
#   - Port 80 must be reachable from the internet (for HTTP-01 validation).
#   - Run as root or with sudo (acme.sh's standalone mode binds port 80).
#
# What it does:
#   1. Installs acme.sh if not already present.
#   2. Issues a cert for <domain> using the standalone HTTP-01 challenge.
#   3. Installs the cert + key into ./certs/ so index.js picks them up.
#   4. Sets up a cron job for automatic renewal.

set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> [--force-renew]}"
FORCE_RENEW="0"

if [[ "${2:-}" == "--force" || "${2:-}" == "--force-renew" ]]; then
  FORCE_RENEW="1"
elif [[ -n "${2:-}" ]]; then
  echo "Usage: $0 <domain> [--force-renew]" >&2
  exit 1
fi

CERT_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
ACME_HOME="${HOME}/.acme.sh"
ACME_BIN="${ACME_HOME}/acme.sh"
ISSUE_OUTPUT=""
ACME_ISSUE_ARGS=(--issue -d "$DOMAIN" --standalone --server letsencrypt)

if [[ "$FORCE_RENEW" == "1" ]]; then
  ACME_ISSUE_ARGS+=(--force)
fi

# 1. Install acme.sh if missing.
if [ ! -f "$ACME_BIN" ]; then
  echo "Installing acme.sh ..."
  curl -sSL https://get.acme.sh | sh -s email=admin@"${DOMAIN}"
fi

# 2. Issue certificate (standalone mode, port 80).
echo "Issuing certificate for ${DOMAIN} ..."
set +e
ISSUE_OUTPUT="$($ACME_BIN "${ACME_ISSUE_ARGS[@]}" 2>&1)"
ISSUE_STATUS=$?
set -e
echo "$ISSUE_OUTPUT"

if [[ $ISSUE_STATUS -ne 0 ]]; then
  if echo "$ISSUE_OUTPUT" | grep -q "Skipping. Next renewal time is"; then
    echo "Certificate is already valid and not due for renewal yet."
  else
    echo "Certificate issue failed. Make sure port 80 is open and ${DOMAIN} points to this server." >&2
    exit 1
  fi
fi

# 3. Install cert files into ./certs/.
mkdir -p "$CERT_DIR"
"$ACME_BIN" --install-cert -d "$DOMAIN" \
  --fullchain-file "${CERT_DIR}/fullchain.pem" \
  --key-file "${CERT_DIR}/privkey.pem" \
  --reloadcmd "docker restart curl-doom 2>/dev/null || echo 'TLS certs renewed — restart curl-doom to pick them up.'"

echo ""
echo "Done! Certs installed to:"
echo "  ${CERT_DIR}/fullchain.pem"
echo "  ${CERT_DIR}/privkey.pem"
echo ""
echo "Apply certs by restarting the compose service:"
echo "  docker compose restart curl-doom"
echo ""
echo "HTTP  -> http://${DOMAIN}:666"
echo "HTTPS -> https://${DOMAIN}:443  (or set TLS_PORT=<port>)"
