#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REDOOM_REPO_DIR:-/opt/curl-doom}"

compute_tool_version() {
  local base_file="$REPO_DIR/VERSION_BASE_COMMIT"
  local base_commit commits_since minor

  if [[ ! -f "$base_file" ]]; then
    echo "0.1"
    return
  fi

  base_commit="$(<"$base_file")"
  base_commit="${base_commit//[[:space:]]/}"
  if [[ -z "$base_commit" ]]; then
    echo "0.1"
    return
  fi

  if ! git cat-file -e "${base_commit}^{commit}" 2>/dev/null; then
    echo "0.1"
    return
  fi

  commits_since="$(git rev-list --count "${base_commit}..HEAD" 2>/dev/null || echo 0)"
  if [[ ! "$commits_since" =~ ^[0-9]+$ ]]; then
    commits_since=0
  fi
  minor=$((commits_since + 1))
  echo "0.${minor}"
}

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "Error: repo not found at $REPO_DIR" >&2
  exit 1
fi

cd "$REPO_DIR"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" == "HEAD" || -z "$branch" ]]; then
  branch="main"
fi

echo "[redoom] Syncing hard to origin/${branch} (overwrite local changes)..."
git fetch --prune origin
git reset --hard "origin/${branch}"
git clean -fd

echo "[redoom] Rebuilding image (no cache)..."
docker compose build --no-cache

tool_version="$(compute_tool_version)"
echo "[redoom] Deploying website version ${tool_version}"

echo "[redoom] Recreating container..."
APP_VERSION="$tool_version" docker compose up -d --force-recreate --remove-orphans

echo "[redoom] Done."
docker ps --filter "name=curl-doom" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
