#!/usr/bin/env bash
set -Eeuo pipefail

# Hardening Script fuer Debian/Ubuntu
#
# Standardwerte:
#   PUBLIC_SSH=1
#   ALLOW_TCP_PORTS=("80" "443")
#   EXTRA_ALLOW_TCP_PORTS=("666")
#
# Dieses Skript macht:
# - installiert und konfiguriert Fail2Ban
# - haertet SSH
# - setzt UFW restriktiv
# - setzt sysctl-Basis-Haertung
# - deaktiviert unnoetige Dienste
# - prueft Docker-Portfreigaben
# - gibt Warnungen fuer unsaubere externe Exposition aus
#
# Wichtige Hinweise:
# 1. Vorher pruefen, ob dein SSH-Zugang per Key oder Teleport sauber funktioniert.
# 2. Wenn du SSH nur ueber Teleport brauchst, setze PUBLIC_SSH=0.
# 3. Wenn du Docker-Container mit oeffentlichen Ports betreibst, musst du deren Port-Binding
#    zusaetzlich sauber konfigurieren. UFW allein ist bei Docker nicht immer ausreichend.

############################
# Standard-Konfiguration
############################

PUBLIC_SSH=1
SSH_PORT="22"

ALLOW_TCP_PORTS=("80" "443")
EXTRA_ALLOW_TCP_PORTS=("666")
DOCKER_ALLOWED_TARGET_PORTS=("8443" "8666")

# Optional: feste Admin-IPs fuer SSH. Nur relevant wenn PUBLIC_SSH=1 und RESTRICT_SSH_TO_IPS=1.
SSH_ALLOWED_IPS=()
RESTRICT_SSH_TO_IPS=0

DISABLE_ATD=1
DISABLE_ROOT_SSH=1
DISABLE_PASSWORD_AUTH=1
DISABLE_X11_FORWARDING=1
DISABLE_AGENT_FORWARDING=1
DISABLE_TCP_FORWARDING=1

ENABLE_FAIL2BAN_RECIDIVE=1
FAIL2BAN_MAXRETRY="3"
FAIL2BAN_FINDTIME="10m"
FAIL2BAN_BANTIME="12h"
FAIL2BAN_RECIDIVE_BANTIME="7d"
FAIL2BAN_RECIDIVE_FINDTIME="1d"
FAIL2BAN_RECIDIVE_MAXRETRY="5"

# Docker-Handling:
# 0 = nur warnen
# 1 = Docker UFW Fix einspielen und warnen
ENABLE_DOCKER_UFW_FIX=1

############################
# Hilfsfunktionen
############################

log() {
  printf "\n[%s] %s\n" "$(date '+%F %T')" "$*"
}

warn() {
  printf "\n[WARNUNG] %s\n" "$*" >&2
}

die_msg() {
  printf "\n[FEHLER] %s\n" "$*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die_msg "Dieses Skript muss als root laufen."
  fi
}

backup_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    cp -a "$f" "${f}.bak.$(date +%F-%H%M%S)"
  fi
}

append_if_missing() {
  local line="$1"
  local file="$2"
  grep -Fxq "$line" "$file" 2>/dev/null || echo "$line" >> "$file"
}

set_sshd_option() {
  local key="$1"
  local value="$2"
  local file="/etc/ssh/sshd_config"

  if grep -Eq "^[#[:space:]]*${key}[[:space:]]+" "$file"; then
    sed -ri "s|^[#[:space:]]*(${key})[[:space:]]+.*|\1 ${value}|g" "$file"
  else
    echo "${key} ${value}" >> "$file"
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

teleport_is_ready() {
  local teleport_cfg="/etc/teleport.yaml"

  if systemctl is-active --quiet teleport && [[ -s "$teleport_cfg" ]]; then
    return 0
  fi

  return 1
}

join_by() {
  local sep="$1"
  shift
  local first=1
  for arg in "$@"; do
    if [[ $first -eq 1 ]]; then
      printf "%s" "$arg"
      first=0
    else
      printf "%s%s" "$sep" "$arg"
    fi
  done
}

############################
# Docker UFW Fix
############################
# Docker kann UFW umgehen, wenn Container direkt Ports publishen.
# Dieser Fix fuegt die empfohlene Integration ueber /etc/ufw/after.rules ein.
# Er beeinflusst nur TCP/UDP-Forwarding fuer Docker-Traffic und ist ein guter Basisschutz.
############################

install_docker_ufw_fix() {
  local file="/etc/ufw/after.rules"
  local tmpfile

  if [[ ! -f "$file" ]]; then
    warn "/etc/ufw/after.rules existiert nicht. Docker-UFW-Fix wird uebersprungen."
    return
  fi

  backup_file "$file"

  if grep -q "BEGIN UFW AND DOCKER" "$file"; then
    sed -i '/# BEGIN UFW AND DOCKER/,/# END UFW AND DOCKER/d' "$file"
  fi

  tmpfile="$(mktemp)"

  {
    echo
    echo "# BEGIN UFW AND DOCKER"
    echo "*filter"
    echo ":ufw-user-forward - [0:0]"
    echo ":ufw-docker-logging-deny - [0:0]"
    echo ":DOCKER-USER - [0:0]"
    echo
    echo "-A DOCKER-USER -j ufw-user-forward"

    for p in "${DOCKER_ALLOWED_TARGET_PORTS[@]}"; do
      echo "-A DOCKER-USER -p tcp --dport ${p} -j RETURN"
    done

    echo "-A DOCKER-USER -j RETURN -s 10.0.0.0/8"
    echo "-A DOCKER-USER -j RETURN -s 172.16.0.0/12"
    echo "-A DOCKER-USER -j RETURN -s 192.168.0.0/16"
    echo "-A DOCKER-USER -p udp --sport 53 --dport 1024:65535 -j RETURN"
    echo "-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN"
    echo "-A DOCKER-USER -j ufw-docker-logging-deny -p udp -m conntrack --ctstate NEW"
    echo "-A DOCKER-USER -j RETURN"
    echo
    echo '-A ufw-docker-logging-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW DOCKER BLOCK] "'
    echo "-A ufw-docker-logging-deny -j DROP"
    echo "COMMIT"
    echo "# END UFW AND DOCKER"
  } > "$tmpfile"

  cat "$tmpfile" >> "$file"
  rm -f "$tmpfile"

  log "Docker-UFW-Fix in /etc/ufw/after.rules eingetragen"
}

############################
# Start
############################

require_root

log "Paketlisten aktualisieren"
apt update

log "Pakete installieren"
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  -o Dpkg::Options::="--force-confnew" \
  fail2ban \
  python3-systemd \
  ufw \
  unattended-upgrades

log "Automatische Sicherheitsupdates aktivieren"
dpkg-reconfigure -f noninteractive unattended-upgrades || true
systemctl enable unattended-upgrades || true

log "Fail2Ban konfigurieren"
backup_file /etc/fail2ban/jail.local

cat > /etc/fail2ban/jail.local <<EOF
[DEFAULT]
banaction = iptables-multiport
backend = systemd
maxretry = ${FAIL2BAN_MAXRETRY}
findtime = ${FAIL2BAN_FINDTIME}
bantime = ${FAIL2BAN_BANTIME}

[sshd]
enabled = true
backend = systemd
maxretry = ${FAIL2BAN_MAXRETRY}
findtime = ${FAIL2BAN_FINDTIME}
bantime = ${FAIL2BAN_BANTIME}
port = ${SSH_PORT}
EOF

if [[ "${ENABLE_FAIL2BAN_RECIDIVE}" -eq 1 ]]; then
  cat >> /etc/fail2ban/jail.local <<EOF

[recidive]
enabled = true
logpath = /var/log/fail2ban.log
bantime = ${FAIL2BAN_RECIDIVE_BANTIME}
findtime = ${FAIL2BAN_RECIDIVE_FINDTIME}
maxretry = ${FAIL2BAN_RECIDIVE_MAXRETRY}
EOF
fi

log "Fail2Ban Konfiguration testen"
fail2ban-client -t

log "Fail2Ban aktivieren"
systemctl enable fail2ban
systemctl restart fail2ban

log "SSH haerten"
backup_file /etc/ssh/sshd_config

if [[ "${DISABLE_ROOT_SSH}" -eq 1 ]]; then
  set_sshd_option "PermitRootLogin" "no"
fi

if [[ "${DISABLE_PASSWORD_AUTH}" -eq 1 ]]; then
  set_sshd_option "PasswordAuthentication" "no"
  set_sshd_option "KbdInteractiveAuthentication" "no"
  set_sshd_option "ChallengeResponseAuthentication" "no"
fi

set_sshd_option "PubkeyAuthentication" "yes"
set_sshd_option "MaxAuthTries" "3"
set_sshd_option "LoginGraceTime" "30"
set_sshd_option "ClientAliveInterval" "300"
set_sshd_option "ClientAliveCountMax" "2"

if [[ "${DISABLE_X11_FORWARDING}" -eq 1 ]]; then
  set_sshd_option "X11Forwarding" "no"
fi

if [[ "${DISABLE_AGENT_FORWARDING}" -eq 1 ]]; then
  set_sshd_option "AllowAgentForwarding" "no"
fi

if [[ "${DISABLE_TCP_FORWARDING}" -eq 1 ]]; then
  set_sshd_option "AllowTcpForwarding" "no"
fi

log "sshd Konfiguration pruefen"
sshd -t

log "SSH Dienst neu laden"
systemctl reload ssh

log "UFW Regeln setzen"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

if teleport_is_ready; then
  log "Teleport ist aktiv und konfiguriert -> oeffentliche SSH-Freigabe wird deaktiviert"
  PUBLIC_SSH=0
fi

if [[ "${PUBLIC_SSH}" -eq 1 ]]; then
  if [[ "${RESTRICT_SSH_TO_IPS}" -eq 1 ]]; then
    if [[ "${#SSH_ALLOWED_IPS[@]}" -eq 0 ]]; then
      die_msg "RESTRICT_SSH_TO_IPS=1 ist gesetzt, aber SSH_ALLOWED_IPS ist leer."
    fi
    for ip in "${SSH_ALLOWED_IPS[@]}"; do
      ufw allow from "${ip}" to any port "${SSH_PORT}" proto tcp
    done
  else
    ufw allow "${SSH_PORT}/tcp"
  fi
fi

for p in "${ALLOW_TCP_PORTS[@]}"; do
  ufw allow "${p}/tcp"
done

for p in "${EXTRA_ALLOW_TCP_PORTS[@]}"; do
  ufw allow "${p}/tcp"
done

if [[ "${ENABLE_DOCKER_UFW_FIX}" -eq 1 ]]; then
  install_docker_ufw_fix
fi

ufw --force enable
systemctl restart ufw

log "sysctl haerten"
backup_file /etc/sysctl.conf

append_if_missing "" /etc/sysctl.conf
append_if_missing "# Hardening baseline" /etc/sysctl.conf
append_if_missing "net.ipv4.tcp_syncookies = 1" /etc/sysctl.conf
append_if_missing "net.ipv4.conf.all.rp_filter = 1" /etc/sysctl.conf
append_if_missing "net.ipv4.conf.default.rp_filter = 1" /etc/sysctl.conf
append_if_missing "net.ipv4.icmp_echo_ignore_broadcasts = 1" /etc/sysctl.conf
append_if_missing "net.ipv4.conf.all.accept_source_route = 0" /etc/sysctl.conf
append_if_missing "net.ipv4.conf.default.accept_source_route = 0" /etc/sysctl.conf
append_if_missing "net.ipv4.conf.all.accept_redirects = 0" /etc/sysctl.conf
append_if_missing "net.ipv4.conf.default.accept_redirects = 0" /etc/sysctl.conf
append_if_missing "net.ipv4.conf.all.send_redirects = 0" /etc/sysctl.conf
append_if_missing "net.ipv4.conf.default.send_redirects = 0" /etc/sysctl.conf

sysctl -p

if [[ "${DISABLE_ATD}" -eq 1 ]]; then
  log "atd deaktivieren"
  systemctl disable --now atd 2>/dev/null || true
fi

############################
# Analyse und Warnungen
############################

log "Analyse laufender Docker-Portfreigaben"
if command_exists docker; then
  docker_ps_output="$(docker ps --format '{{.Names}} {{.Ports}}' || true)"
  if [[ -n "${docker_ps_output}" ]]; then
    echo "${docker_ps_output}"
    if echo "${docker_ps_output}" | grep -Eq '0\.0\.0\.0:|:::|[[]::[]]:'; then
      warn "Mindestens ein Docker-Container published Ports auf allen Interfaces."
      warn "Wenn ein Dienst nicht oeffentlich sein soll, binde ihn nur an 127.0.0.1 oder nur ins interne Docker-Netz."
      warn "Beispiel fuer lokales Binding: -p 127.0.0.1:666:666"
    fi
  else
    log "Keine laufenden Docker-Container mit Portausgabe gefunden"
  fi
else
  log "Docker ist nicht installiert oder nicht im PATH"
fi

log "Pruefe Teleport"
if teleport_is_ready; then
  log "Teleport ist aktiv und konfiguriert. SSH ist nicht oeffentlich freigegeben."
elif systemctl is-active --quiet teleport; then
  warn "Teleport laeuft, aber /etc/teleport.yaml fehlt/ist leer. SSH bleibt oeffentlich freigegeben."
fi

############################
# Status
############################

echo
echo "===== FAIL2BAN ====="
fail2ban-client status || true
echo
fail2ban-client status sshd || true
echo
if [[ "${ENABLE_FAIL2BAN_RECIDIVE}" -eq 1 ]]; then
  fail2ban-client status recidive || true
fi

echo
echo "===== UFW ====="
ufw status verbose || true

echo
echo "===== LISTENING PORTS ====="
ss -tulpen || true

echo
echo "===== SSHD EFFECTIVE CONFIG ====="
sshd -T | egrep 'permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|maxauthtries|logingracetime|x11forwarding|allowagentforwarding|allowtcpforwarding|clientaliveinterval|clientalivecountmax' || true

echo
echo "===== HINWEISE ====="
if [[ "${PUBLIC_SSH}" -eq 0 ]]; then
  echo "- SSH ist per UFW nicht oeffentlich freigegeben (Teleport-Zugang)."
else
  if [[ "${RESTRICT_SSH_TO_IPS}" -eq 1 ]]; then
    echo "- SSH ist nur fuer diese IPs freigegeben: $(join_by ', ' "${SSH_ALLOWED_IPS[@]}")"
  else
    echo "- SSH ist oeffentlich auf Port ${SSH_PORT} freigegeben."
  fi
fi
echo "- HTTPS ist auf Port 443 erreichbar."
echo "- HTTP auf Port 80 sollte auf HTTPS weiterleiten."
echo "- Der cURL-Game-Service ist auf Port 666 erreichbar."

echo
echo "Fertig."