#!/usr/bin/env bash
# ╔══════════════════════════════════════════╗
# ║            cURL DOOM  /  doom.sh         ║
# ║           DOOM, played over curl.        ║
# ╚══════════════════════════════════════════╝
#
# Thin wrapper: fetch the play script from the server, then exec it.
# This file is here for local development. The minimum-viable invocation
# is just:
#
#     curl -sL http://localhost:666 | bash
#
# Override the server with DOOM_SERVER, terminal size with DOOM_COLS /
# DOOM_ROWS, both are read by the served script.
# Set DOOM_TOKEN to the access token if one is configured on the server.

SERVER="${DOOM_SERVER:-http://localhost:666}"
TOKEN="${DOOM_TOKEN:-}"

AUTH_HEADER=()
[ -n "$TOKEN" ] && AUTH_HEADER=(-H "Authorization: Bearer ${TOKEN}")

SCRIPT=$(curl -sSfL "${AUTH_HEADER[@]}" "$SERVER") || {
  echo "Failed to fetch cURL DOOM from $SERVER" >&2
  echo "Start the server with: npm start" >&2
  exit 1
}

# Hand off to the served script. It reads keys from /dev/tty, so it
# doesn't matter that bash -c's stdin isn't a terminal.
exec bash -c "$SCRIPT"
