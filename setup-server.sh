#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-/opt/curl-doom}"
DOMAIN="${2:-}"
RUN_HARDENING="${RUN_HARDENING:-1}"
ENABLE_REDOOM_ON_BOOT="${ENABLE_REDOOM_ON_BOOT:-1}"

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

  if ! run_root git -C "$REPO_DIR" cat-file -e "${base_commit}^{commit}" 2>/dev/null; then
    echo "0.1"
    return
  fi

  commits_since="$(run_root git -C "$REPO_DIR" rev-list --count "${base_commit}..HEAD" 2>/dev/null || echo 0)"
  if [[ ! "$commits_since" =~ ^[0-9]+$ ]]; then
    commits_since=0
  fi
  minor=$((commits_since + 1))
  echo "0.${minor}"
}

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

configure_basic_firewall() {
  echo "[setup] Configuring firewall..."
  run_root ufw allow 22/tcp
  run_root ufw allow 80/tcp
  run_root ufw allow 443/tcp
  run_root ufw allow 666/tcp
  run_root ufw --force enable
}

install_redoom_update_check_timer() {
  local service_path="/etc/systemd/system/redoom-update-check.service"
  local timer_path="/etc/systemd/system/redoom-update-check.timer"

  echo "[setup] Installing systemd update-check service and timer for redoom..."
  run_root tee "$service_path" >/dev/null <<EOF
[Unit]
Description=cURL DOOM update check and conditional redeploy
Wants=network-online.target
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=${REPO_DIR}
Environment=REDOOM_REPO_DIR=${REPO_DIR}
ExecStart=/usr/bin/env bash ${REPO_DIR}/redoom-update-check.sh
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

  run_root tee "$timer_path" >/dev/null <<EOF
[Unit]
Description=Periodic cURL DOOM update check timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
RandomizedDelaySec=60
Persistent=true
Unit=redoom-update-check.service

[Install]
WantedBy=timers.target
EOF

  run_root systemctl daemon-reload
  run_root systemctl enable --now redoom-update-check.timer
}

sync_repo_to_remote() {
  local branch

  branch="$(run_root git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" == "HEAD" || -z "$branch" ]]; then
    branch="main"
  fi

  echo "[setup] Syncing repo hard to origin/${branch} (overwrite local changes)..."
  run_root git -C "$REPO_DIR" fetch --prune origin
  run_root git -C "$REPO_DIR" reset --hard "origin/${branch}"
  run_root git -C "$REPO_DIR" clean -fd
}

user_name="${SUDO_USER:-$USER}"
user_home="$(getent passwd "$user_name" | cut -d: -f6)"

if [[ -z "$user_home" || ! -d "$user_home" ]]; then
  echo "Error: could not resolve home directory for user $user_name" >&2
  exit 1
fi

echo "[setup] Installing base packages..."
run_root apt-get update -y
run_root apt-get install -y git curl ca-certificates ufw

if ! command -v docker >/dev/null 2>&1; then
  echo "[setup] Installing Docker Engine..."
  run_root apt-get install -y docker.io
  run_root systemctl enable --now docker
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[setup] Installing docker compose plugin..."
  run_root apt-get install -y docker-compose-plugin
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Error: docker compose plugin is not available after installation." >&2
  echo "Install docker-compose-plugin for your distro and rerun setup-server.sh." >&2
  exit 1
fi

echo "[setup] Ensuring repo exists at $REPO_DIR..."
if [[ ! -d "$REPO_DIR/.git" ]]; then
  run_root mkdir -p "$(dirname "$REPO_DIR")"
  run_root git clone https://github.com/FullByte/curl-doom.git "$REPO_DIR"
fi

sync_repo_to_remote

if [[ -f "$REPO_DIR/redoom.sh" ]]; then
  run_root chmod +x "$REPO_DIR/redoom.sh"
fi
if [[ -f "$REPO_DIR/redoom-update-check.sh" ]]; then
  run_root chmod +x "$REPO_DIR/redoom-update-check.sh"
fi
if [[ -f "$REPO_DIR/setup-tls.sh" ]]; then
  run_root chmod +x "$REPO_DIR/setup-tls.sh"
fi
if [[ -f "$REPO_DIR/harding.sh" ]]; then
  run_root chmod +x "$REPO_DIR/harding.sh"
fi

alias_line="alias redoom='bash $REPO_DIR/redoom.sh'"
for rc in "$user_home/.bashrc" "$user_home/.zshrc"; do
  if [[ ! -f "$rc" ]]; then
    run_root touch "$rc"
    run_root chown "$user_name":"$user_name" "$rc"
  fi
  if ! grep -Fq "$alias_line" "$rc"; then
    echo "[setup] Adding redoom alias to $rc"
    printf "\n# cURL DOOM helper\n%s\n" "$alias_line" | run_root tee -a "$rc" >/dev/null
  fi
done

if [[ "$RUN_HARDENING" == "1" ]]; then
  if [[ -f "$REPO_DIR/harding.sh" ]]; then
    echo "[setup] Running hardening script (harding.sh)..."
    run_root bash "$REPO_DIR/harding.sh"
  else
    echo "[setup] harding.sh not found, falling back to basic firewall setup"
    configure_basic_firewall
  fi
else
  echo "[setup] Skipping hardening script because RUN_HARDENING=0"
  configure_basic_firewall
fi

if [[ "$ENABLE_REDOOM_ON_BOOT" == "1" ]]; then
  install_redoom_update_check_timer
else
  echo "[setup] Skipping update-check timer because ENABLE_REDOOM_ON_BOOT=0"
fi

echo "[setup] Building and starting cURL DOOM..."
cd "$REPO_DIR"
run_root docker compose build --no-cache
tool_version="$(compute_tool_version)"
echo "[setup] Deploying website version ${tool_version}"
run_root env APP_VERSION="$tool_version" docker compose up -d --force-recreate --remove-orphans

if [[ -n "$DOMAIN" ]]; then
  echo "[setup] Attempting TLS setup for $DOMAIN"
  run_root bash "$REPO_DIR/setup-tls.sh" "$DOMAIN" || true
  run_root chmod 644 "$REPO_DIR/certs/privkey.pem" 2>/dev/null || true
  run_root docker compose restart
fi

echo "[setup] Complete."
echo "[setup] Run 'source ~/.bashrc' or 'source ~/.zshrc' then use: redoom"
