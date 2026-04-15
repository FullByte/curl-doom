#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REDOOM_REPO_DIR:-/opt/curl-doom}"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "[redoom-update-check] repo not found at $REPO_DIR" >&2
  exit 1
fi

cd "$REPO_DIR"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" == "HEAD" || -z "$branch" ]]; then
  branch="main"
fi

remote_ref="origin/${branch}"

echo "[redoom-update-check] Fetching latest refs for ${remote_ref}..."
git fetch --prune origin

if ! git show-ref --verify --quiet "refs/remotes/${remote_ref}"; then
  echo "[redoom-update-check] remote ref ${remote_ref} not found; skipping" >&2
  exit 1
fi

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "${remote_ref}")"

if [[ "$local_sha" == "$remote_sha" ]]; then
  echo "[redoom-update-check] up to date (${local_sha:0:12})"
  exit 0
fi

behind_count="$(git rev-list --count "${local_sha}..${remote_sha}")"
echo "[redoom-update-check] update detected: behind by ${behind_count} commit(s); running redoom"

exec /usr/bin/env bash "$REPO_DIR/redoom.sh"
