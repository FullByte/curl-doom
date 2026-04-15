# cURL DOOM

DOOM played over curl.

- Homepage: <https://doom.yolo.omg.lol>
- Game service: <http://doom.yolo.omg.lol:666>
- Website version is shown in the UI and auto-increments per main-branch commit starting at `0.1`.

## Play Doom using Curl

Use this command:

```bash
curl -sL -H "Authorization: Bearer slayer" doom.yolo.omg.lol:666 | bash
```

Quick health check:

```bash
curl -sSI http://doom.yolo.omg.lol:666/health | head -n 1
```

Controls:

- WASD: move/turn
- F: fire
- Space or E: use/open door
- Q: quit

## Host Curl-Doom

`setup-server.sh` installs Docker Engine and the Docker Compose plugin when missing.

`setup-server.sh` and `redoom` always sync hard to the remote branch
(`git fetch --prune`, `git reset --hard origin/<branch>`, `git clean -fd`).
Local tracked changes and untracked files in the repo are overwritten/removed.

```bash
git clone https://github.com/FullByte/curl-doom.git /opt/curl-doom
cd /opt/curl-doom
chmod +x setup-server.sh redoom.sh harding.sh
./setup-server.sh /opt/curl-doom doom.yolo.omg.lol
```

Check update-check timer status:

```bash
systemctl status redoom-update-check.timer
systemctl is-enabled redoom-update-check.timer
```

Run an immediate check manually:

```bash
systemctl start redoom-update-check.service
```

## Update or redeploy

After setup, redeploy with one command:

```bash
redoom
```

`redoom` always overwrites local repo changes with the remote branch first.
It also computes and injects `APP_VERSION=0.N` where `N` is commits since
`VERSION_BASE_COMMIT` plus one (so this baseline commit is `0.1`).

`setup-server.sh` also installs a persistent systemd timer that survives reboot
and periodically checks for new GitHub commits. If updates are detected, it
automatically runs `redoom`.

## Custom Doom 1 WADs

Default runtime uses `doom1.wad` as IWAD.

You can override map content via env vars:

- `IWAD_PATH` (default `/app/doom1.wad`)
- `PWAD_PATHS` (comma-separated PWAD file list, loaded via `-file`)
- `WARP_EPISODE` (default `1`)
- `WARP_MAP` (default `1`)
- `DOOM_SKILL` (default `3`)

Example:

```bash
cd /opt/curl-doom
IWAD_PATH=/app/doom1.wad \
PWAD_PATHS=/app/wads/mymap.wad \
WARP_EPISODE=1 WARP_MAP=3 DOOM_SKILL=3 \
docker compose up -d --force-recreate
```

Note: the WAD files must exist inside the container path (`/app/...`),
typically by mounting them as a volume in `docker-compose.yml`.

## Live Stats

The server now records player input telemetry (move, shoot, use, etc.) and
current in-game state (position, map, health, ammo) per session.

- HTML dashboard: `/stats`
- JSON API: `/stats.json`
- Event log file (persistent by default): `/data/curl-doom-input-stats.jsonl`
- Runtime stats state (persistent by default): `/data/curl-doom-runtime-stats.json`

Optional env vars:

```bash
STATS_ENABLED=1
STATS_LOG_PATH=/data/curl-doom-input-stats.jsonl
STATS_STATE_PATH=/data/curl-doom-runtime-stats.json
STATS_MAX_RECENT_EVENTS=500
STATS_MAX_ENDED_SESSIONS=200
SESSION_IDLE_TIMEOUT_MS=600000
```

`docker-compose.yml` mounts `./data:/data`, so `/stats.json` totals survive
container recreate, host reboot, and normal `redoom` updates.

`SESSION_IDLE_TIMEOUT_MS` controls when an inactive game session is reaped.
Default is now 10 minutes (`600000` ms), minimum allowed is 60 seconds.

## Credits

- Original author: [Sawyer X](https://github.com/xsawyerx/curl-doom)
- DOOM: id Software, 1993
- doomgeneric: [ozkl](https://github.com/ozkl/doomgeneric)
