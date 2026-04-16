// cURL DOOM server, spawns one headless doom process per session,
// pipes commands in, reads framebuffers out, and serves ANSI frames.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const rateLimit = require('express-rate-limit');

const app = express();

const PORT = process.env.PORT || 666;
const PUBLIC_GAME_PORT = process.env.PUBLIC_GAME_PORT || 666;
const TLS_PORT = process.env.TLS_PORT || 443;
const TLS_CERT = process.env.TLS_CERT || path.join(__dirname, 'certs', 'fullchain.pem');
const TLS_KEY = process.env.TLS_KEY || path.join(__dirname, 'certs', 'privkey.pem');
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const DOOM_BIN = path.join(__dirname, 'doomgeneric', 'doomgeneric', 'doomgeneric_server');
const IWAD_PATH = process.env.IWAD_PATH || path.join(__dirname, 'doom1.wad');
const PWAD_PATHS = (process.env.PWAD_PATHS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const WARP_EPISODE = process.env.WARP_EPISODE || '1';
const WARP_MAP = process.env.WARP_MAP || '1';
const DOOM_SKILL = process.env.DOOM_SKILL || '3';
const APP_VERSION_RAW = process.env.APP_VERSION || '0.1';
const APP_VERSION = /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(APP_VERSION_RAW) ? APP_VERSION_RAW : '0.1';
const DEBUG_SERVER = /^(1|true|yes|on)$/i.test(process.env.DEBUG_SERVER || '');
const DEBUG_VERBOSE_TICKS = /^(1|true|yes|on)$/i.test(process.env.DEBUG_VERBOSE_TICKS || '');
const DEBUG_TICK_SLOW_MS = parseInt(process.env.DEBUG_TICK_SLOW_MS, 10) || 250;
const STATS_ENABLED = !/^(0|false|no|off)$/i.test(process.env.STATS_ENABLED || '1');
const STATS_LOG_PATH = process.env.STATS_LOG_PATH || '/data/curl-doom-input-stats.jsonl';
const STATS_STATE_PATH = process.env.STATS_STATE_PATH || '/data/curl-doom-runtime-stats.json';
const STATS_MAX_RECENT_EVENTS = parseInt(process.env.STATS_MAX_RECENT_EVENTS, 10) || 500;
const STATS_MAX_ENDED_SESSIONS = parseInt(process.env.STATS_MAX_ENDED_SESSIONS, 10) || 200;

function debugLog(event, fields = {}) {
  if (!DEBUG_SERVER) return;
  const line = `[debug] ${event} ${JSON.stringify(fields)}`;
  console.log(line);
}

// doomgeneric renders at 640×400 RGBA (little-endian 0xAARRGGBB, so the
// byte layout on disk is B, G, R, A).
const DOOM_W = 640;
const DOOM_H = 400;
const FRAME_SIZE = DOOM_W * DOOM_H * 4;

// Idle sessions are reaped after this many ms of no /tick activity.
const IDLE_TIMEOUT_MS = Math.max(60 * 1000, parseInt(process.env.SESSION_IDLE_TIMEOUT_MS, 10) || 10 * 60 * 1000);
const REAP_INTERVAL_MS = 10 * 1000;

// Maximum concurrent sessions server-wide.
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS, 10) || 20;
// Maximum concurrent sessions per IP.
const MAX_SESSIONS_PER_IP = parseInt(process.env.MAX_SESSIONS_PER_IP, 10) || 3;

// Default ANSI viewport. Each terminal row is two stacked pixels (▀ trick),
// so the effective pixel grid is cols × rows*2.
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 40;

// Tics to run per user action. Doom reads input during game tics, so we
// hold the key for a few tics and then release it.
const TICS_KEYDOWN = 4;
const TICS_KEYUP = 1;
// Tics to run per "idle" poll request (no key pressed).
const TICS_IDLE = 2;

// doom key codes (from doomkeys.h)

const K = {
  LEFT: 0xac,
  UP: 0xad,
  RIGHT: 0xae,
  DOWN: 0xaf,
  STRAFE_L: 0xa0,
  STRAFE_R: 0xa1,
  USE: 0xa2,
  FIRE: 0xa3,
  ESCAPE: 27,
  ENTER: 13,
  TAB: 9,
  BACKSPACE: 0x7f,
  RSHIFT: 0x80 + 0x36,
  Y: 'y'.charCodeAt(0),
  N: 'n'.charCodeAt(0),
};

// Map client keystrokes (the bytes doom.sh sends) to a doom keycode.
// null means "tick without pushing a key".
const KEYMAP = {
  w: K.UP, W: K.UP,
  s: K.DOWN, S: K.DOWN,
  a: K.LEFT, A: K.LEFT,
  d: K.RIGHT, D: K.RIGHT,
  ',': K.STRAFE_L, '.': K.STRAFE_R,
  f: K.FIRE, F: K.FIRE,
  ' ': K.USE,
  e: K.USE, E: K.USE,
  enter: K.ENTER, '\n': K.ENTER, '\r': K.ENTER,
  escape: K.ESCAPE, esc: K.ESCAPE,
  tab: K.TAB, '\t': K.TAB,
  shift: K.RSHIFT,
  y: K.Y, Y: K.Y,
  n: K.N, N: K.N,
  '': null,
};

const RAW_KEY_TO_ACTION = {
  w: 'forward', W: 'forward',
  s: 'backward', S: 'backward',
  a: 'turn_left', A: 'turn_left',
  d: 'turn_right', D: 'turn_right',
  ',': 'strafe_left',
  '.': 'strafe_right',
  f: 'shoot', F: 'shoot',
  ' ': 'use',
  e: 'use', E: 'use',
  enter: 'confirm', '\n': 'confirm', '\r': 'confirm',
  escape: 'escape', esc: 'escape',
  tab: 'automap', '\t': 'automap',
  shift: 'run',
  y: 'dialog_yes', Y: 'dialog_yes',
  n: 'dialog_no', N: 'dialog_no',
  '': 'idle',
};

const DOOM_KEY_TO_ACTION = {
  [K.LEFT]: 'turn_left',
  [K.UP]: 'forward',
  [K.RIGHT]: 'turn_right',
  [K.DOWN]: 'backward',
  [K.STRAFE_L]: 'strafe_left',
  [K.STRAFE_R]: 'strafe_right',
  [K.USE]: 'use',
  [K.FIRE]: 'shoot',
  [K.ESCAPE]: 'escape',
  [K.ENTER]: 'confirm',
  [K.TAB]: 'automap',
  [K.RSHIFT]: 'run',
  [K.Y]: 'dialog_yes',
  [K.N]: 'dialog_no',
};

const runtimeStats = {
  startedAt: new Date().toISOString(),
  sessionsCreated: 0,
  sessionsEnded: 0,
  totalInputEvents: 0,
  actionTotals: new Map(),
  recentEvents: [],
  endedSessions: [],
};

const wadIndexCache = new Map();
const mapGeometryCache = new Map();
let statsPersistTimer = null;

function clampStatsArrays() {
  trimRecentEvents();
  if (runtimeStats.endedSessions.length > STATS_MAX_ENDED_SESSIONS) {
    runtimeStats.endedSessions.splice(0, runtimeStats.endedSessions.length - STATS_MAX_ENDED_SESSIONS);
  }
}

function serializeRuntimeStats() {
  clampStatsArrays();
  return {
    startedAt: runtimeStats.startedAt,
    sessionsCreated: runtimeStats.sessionsCreated,
    sessionsEnded: runtimeStats.sessionsEnded,
    totalInputEvents: runtimeStats.totalInputEvents,
    actionTotals: Object.fromEntries(runtimeStats.actionTotals.entries()),
    recentEvents: runtimeStats.recentEvents,
    endedSessions: runtimeStats.endedSessions,
  };
}

function persistRuntimeStatsSync() {
  if (!STATS_ENABLED) return;
  try {
    const tmpPath = `${STATS_STATE_PATH}.tmp`;
    const payload = `${JSON.stringify(serializeRuntimeStats())}\n`;
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, STATS_STATE_PATH);
  } catch (err) {
    if (DEBUG_SERVER) {
      console.error(`[stats] failed to persist state: ${err.message}`);
    }
  }
}

function scheduleStatsPersist() {
  if (!STATS_ENABLED || statsPersistTimer) return;
  statsPersistTimer = setTimeout(() => {
    statsPersistTimer = null;
    persistRuntimeStatsSync();
  }, 500);
  statsPersistTimer.unref?.();
}

function hydrateRuntimeStatsFromState() {
  try {
    if (!fs.existsSync(STATS_STATE_PATH)) return;
    const raw = fs.readFileSync(STATS_STATE_PATH, 'utf8');
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);

    if (typeof parsed.startedAt === 'string') runtimeStats.startedAt = parsed.startedAt;
    runtimeStats.sessionsCreated = Number(parsed.sessionsCreated) || 0;
    runtimeStats.sessionsEnded = Number(parsed.sessionsEnded) || 0;
    runtimeStats.totalInputEvents = Number(parsed.totalInputEvents) || 0;

    const actionTotalsObj = parsed.actionTotals && typeof parsed.actionTotals === 'object'
      ? parsed.actionTotals
      : {};
    runtimeStats.actionTotals = new Map(
      Object.entries(actionTotalsObj).map(([action, count]) => [action, Number(count) || 0])
    );

    runtimeStats.recentEvents = Array.isArray(parsed.recentEvents) ? parsed.recentEvents : [];
    runtimeStats.endedSessions = Array.isArray(parsed.endedSessions) ? parsed.endedSessions : [];
    clampStatsArrays();
  } catch (err) {
    console.error(`[stats] failed to hydrate state ${STATS_STATE_PATH}: ${err.message}`);
  }
}

if (STATS_ENABLED) {
  try {
    fs.mkdirSync(path.dirname(STATS_LOG_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(STATS_STATE_PATH), { recursive: true });
    fs.appendFileSync(STATS_LOG_PATH, '');
    hydrateRuntimeStatsFromState();
  } catch (err) {
    console.error(`[stats] failed to initialize log file ${STATS_LOG_PATH}: ${err.message}`);
  }
}

function hashIp(ip) {
  return crypto
    .createHash('sha256')
    .update(`${ACCESS_TOKEN || 'no-token'}:${ip || 'unknown'}`)
    .digest('hex')
    .slice(0, 12);
}

function actionFromKeys(rawKey, doomKey) {
  if (rawKey in RAW_KEY_TO_ACTION) return RAW_KEY_TO_ACTION[rawKey];
  if (doomKey in DOOM_KEY_TO_ACTION) return DOOM_KEY_TO_ACTION[doomKey];
  return 'unknown';
}

function trimRecentEvents() {
  if (runtimeStats.recentEvents.length <= STATS_MAX_RECENT_EVENTS) return;
  runtimeStats.recentEvents.splice(0, runtimeStats.recentEvents.length - STATS_MAX_RECENT_EVENTS);
}

function parseDoomStatLine(line) {
  if (!line.startsWith('STAT ')) return null;
  try {
    const payload = JSON.parse(line.slice(5));
    if (!payload || payload.ok !== true) return null;
    return payload;
  } catch {
    return null;
  }
}

function writeStatsEvent(event) {
  if (!STATS_ENABLED) return;
  fs.appendFile(STATS_LOG_PATH, `${JSON.stringify(event)}\n`, err => {
    if (err && DEBUG_SERVER) {
      console.error(`[stats] append failed: ${err.message}`);
    }
  });
  scheduleStatsPersist();
}

function mapNameFromState(state) {
  if (!state) return null;
  const ep = Number(state.episode);
  const map = Number(state.map);
  if (!Number.isFinite(ep) || !Number.isFinite(map)) return null;
  if (ep < 1 || map < 1) return null;
  return `E${Math.trunc(ep)}M${Math.trunc(map)}`;
}

function readWadIndex(wadPath) {
  if (wadIndexCache.has(wadPath)) return wadIndexCache.get(wadPath);

  const buf = fs.readFileSync(wadPath);
  if (buf.length < 12) {
    throw new Error(`WAD too small: ${wadPath}`);
  }
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'IWAD' && magic !== 'PWAD') {
    throw new Error(`Invalid WAD magic (${magic}) in ${wadPath}`);
  }

  const numLumps = buf.readInt32LE(4);
  const dirOfs = buf.readInt32LE(8);
  const lumps = [];

  for (let i = 0; i < numLumps; i++) {
    const off = dirOfs + i * 16;
    if (off + 16 > buf.length) break;
    const filepos = buf.readInt32LE(off);
    const size = buf.readInt32LE(off + 4);
    const name = buf.toString('ascii', off + 8, off + 16).replace(/\0+$/, '').toUpperCase();
    lumps.push({ filepos, size, name });
  }

  const index = { wadPath, magic, buf, lumps };
  wadIndexCache.set(wadPath, index);
  return index;
}

function extractMapGeometryFromIndex(index, mapName) {
  const mapMarker = mapName.toUpperCase();
  const markerIdx = index.lumps.findIndex(l => l.name === mapMarker);
  if (markerIdx < 0) return null;

  let vertexLump = null;
  let linedefLump = null;
  for (let i = markerIdx + 1; i < index.lumps.length; i++) {
    const l = index.lumps[i];
    if (/^E\dM\d$/.test(l.name) || /^MAP\d\d$/.test(l.name)) break;
    if (l.name === 'VERTEXES') vertexLump = l;
    if (l.name === 'LINEDEFS') linedefLump = l;
    if (vertexLump && linedefLump) break;
  }

  if (!vertexLump || !linedefLump) return null;

  const vertices = [];
  for (let o = 0; o + 4 <= vertexLump.size; o += 4) {
    const pos = vertexLump.filepos + o;
    if (pos + 4 > index.buf.length) break;
    const x = index.buf.readInt16LE(pos);
    const y = index.buf.readInt16LE(pos + 2);
    vertices.push([x, y]);
  }

  if (vertices.length === 0) return null;

  const lines = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let o = 0; o + 14 <= linedefLump.size; o += 14) {
    const pos = linedefLump.filepos + o;
    if (pos + 14 > index.buf.length) break;
    const v1 = index.buf.readUInt16LE(pos);
    const v2 = index.buf.readUInt16LE(pos + 2);
    if (!vertices[v1] || !vertices[v2]) continue;
    const [x1, y1] = vertices[v1];
    const [x2, y2] = vertices[v2];
    lines.push([x1, y1, x2, y2]);
    if (x1 < minX) minX = x1;
    if (x2 < minX) minX = x2;
    if (y1 < minY) minY = y1;
    if (y2 < minY) minY = y2;
    if (x1 > maxX) maxX = x1;
    if (x2 > maxX) maxX = x2;
    if (y1 > maxY) maxY = y1;
    if (y2 > maxY) maxY = y2;
  }

  if (lines.length === 0) return null;

  return {
    mapName: mapMarker,
    source: path.basename(index.wadPath),
    bbox: { minX, minY, maxX, maxY },
    lines,
  };
}

function getMapGeometry(mapName) {
  if (!mapName) return null;
  if (mapGeometryCache.has(mapName)) return mapGeometryCache.get(mapName);

  const sourceWads = [...PWAD_PATHS].reverse().concat([IWAD_PATH]);
  let geometry = null;
  for (const wadPath of sourceWads) {
    if (!wadPath || !fs.existsSync(wadPath)) continue;
    try {
      const index = readWadIndex(wadPath);
      geometry = extractMapGeometryFromIndex(index, mapName);
      if (geometry) break;
    } catch (err) {
      if (DEBUG_SERVER) {
        console.error(`[stats] failed reading WAD ${wadPath}: ${err.message}`);
      }
    }
  }

  mapGeometryCache.set(mapName, geometry);
  return geometry;
}

function recordInputEvent(session, fields) {
  if (!STATS_ENABLED || !session || session.dead) return;

  const action = fields.action || 'unknown';
  const now = Date.now();
  const event = {
    ts: new Date(now).toISOString(),
    sessionId: session.id,
    source: fields.source || 'unknown',
    action,
    rawKey: fields.rawKey ?? null,
    doomKey: fields.doomKey ?? null,
    ipHash: session.stats.clientIpHash,
    tickMs: fields.tickMs ?? null,
    state: session.lastDoomState || null,
  };

  session.stats.events += 1;
  session.stats.lastEventAt = now;
  session.stats.actionCounts[action] = (session.stats.actionCounts[action] || 0) + 1;

  runtimeStats.totalInputEvents += 1;
  runtimeStats.actionTotals.set(action, (runtimeStats.actionTotals.get(action) || 0) + 1);
  runtimeStats.recentEvents.push(event);
  trimRecentEvents();

  writeStatsEvent(event);
}

function getSessionStatsSummary(session) {
  const latestState = session.lastDoomState || null;
  return {
    sessionId: session.id,
    ipHash: session.stats.clientIpHash,
    startedAt: new Date(session.stats.createdAt).toISOString(),
    endedAt: session.stats.endedAt ? new Date(session.stats.endedAt).toISOString() : null,
    events: session.stats.events,
    actionCounts: session.stats.actionCounts,
    latestState,
    mapName: mapNameFromState(latestState),
  };
}

function buildStatsSnapshot() {
  const activeSessions = [...sessions.values()].map(getSessionStatsSummary);
  const actionTotals = [...runtimeStats.actionTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([action, count]) => ({ action, count }));

  const mapNames = [...new Set(activeSessions.map(s => s.mapName).filter(Boolean))];
  const mapGeometries = {};
  for (const mapName of mapNames) {
    const geometry = getMapGeometry(mapName);
    if (geometry) {
      mapGeometries[mapName] = geometry;
    }
  }

  return {
    startedAt: runtimeStats.startedAt,
    now: new Date().toISOString(),
    enabled: STATS_ENABLED,
    logPath: STATS_LOG_PATH,
    sessionsCreated: runtimeStats.sessionsCreated,
    sessionsEnded: runtimeStats.sessionsEnded,
    activeSessionCount: activeSessions.length,
    totalInputEvents: runtimeStats.totalInputEvents,
    actionTotals,
    activeSessions,
    mapGeometries,
    endedSessions: runtimeStats.endedSessions,
    recentEvents: runtimeStats.recentEvents,
  };
}

// play script (served by GET /)
//
// The bash wrapper lives in `play.sh` next to this file. We load it once at
// startup, with `__SERVER__` as a placeholder, then substitute the request's
// own host on each GET / so the script keeps talking back to wherever it was
// downloaded from.

const PLAY_SCRIPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'play.sh'),
  'utf8'
);

// sessions

/**
 * Session shape:
 *   id           string
 *   proc         ChildProcess
 *   frameStream  Readable (fd 3)
 *   frameBuf     Buffer (accumulates partial frame reads)
 *   pending      Array<{resolve, reject}> (awaiting the next full frame)
 *   busy         Promise | null (serialises /tick requests on this session)
 *   lastActive   number (ms since epoch)
 *   dead         boolean
 */
const sessions = new Map();
// Track how many sessions each IP has open.
const sessionsByIp = new Map();

function spawnDoom() {
  // stdio: [0]=stdin pipe, [1]=inherit (unused, the child dup2s stderr
  // onto fd 1 anyway), [2]=stderr pipe, [3]=frame pipe.
  // Defaults are IWAD doom1.wad + -warp 1 1 -skill 3, but this can be
  // overridden by IWAD_PATH, PWAD_PATHS, WARP_EPISODE, WARP_MAP, DOOM_SKILL.
  const args = ['-iwad', IWAD_PATH];
  if (PWAD_PATHS.length > 0) {
    args.push('-file', ...PWAD_PATHS);
  }
  args.push('-warp', String(WARP_EPISODE), String(WARP_MAP), '-skill', String(DOOM_SKILL));

  const proc = spawn(DOOM_BIN, args, {
    stdio: ['pipe', 'inherit', 'pipe', 'pipe'],
    cwd: __dirname,
  });
  return proc;
}

function createSession(clientIp) {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error('server full — try again later');
  }
  const ipCount = sessionsByIp.get(clientIp) || 0;
  if (ipCount >= MAX_SESSIONS_PER_IP) {
    throw new Error('too many sessions from your IP — try again later');
  }
  sessionsByIp.set(clientIp, ipCount + 1);

  const id = crypto.randomBytes(8).toString('hex');
  const proc = spawnDoom();

  const session = {
    id,
    proc,
    frameStream: proc.stdio[3],
    frameBuf: Buffer.alloc(0),
    pending: [],
    pendingHead: 0,
    busy: null,
    lastActive: Date.now(),
    dead: false,
    stderrBuf: '',
    lastDoomState: null,
    stats: {
      createdAt: Date.now(),
      clientIpHash: hashIp(clientIp),
      events: 0,
      actionCounts: {},
      endedAt: null,
      lastEventAt: null,
    },
  };

  runtimeStats.sessionsCreated += 1;
  scheduleStatsPersist();

  proc.stderr.on('data', chunk => {
    const text = chunk.toString('utf8');
    session.stderrBuf += text;
    let nl;
    while ((nl = session.stderrBuf.indexOf('\n')) >= 0) {
      const line = session.stderrBuf.slice(0, nl).trim();
      session.stderrBuf = session.stderrBuf.slice(nl + 1);
      if (!line) continue;
      const state = parseDoomStatLine(line);
      if (state) {
        session.lastDoomState = state;
      } else if (DEBUG_SERVER) {
        console.log(`[doom] ${line}`);
      }
    }
  });

  session.frameStream.on('data', chunk => {
    session.frameBuf = session.frameBuf.length === 0
      ? chunk
      : Buffer.concat([session.frameBuf, chunk]);
    while (session.frameBuf.length >= FRAME_SIZE && session.pending.length > session.pendingHead) {
      const frame = session.frameBuf.subarray(0, FRAME_SIZE);
      session.frameBuf = session.frameBuf.subarray(FRAME_SIZE);
      const waiter = session.pending[session.pendingHead++];
      // Copy so subsequent reads into the shared buffer can't race.
      waiter.resolve(Buffer.from(frame));
    }
    if (session.pendingHead > 128 && session.pendingHead * 2 > session.pending.length) {
      session.pending = session.pending.slice(session.pendingHead);
      session.pendingHead = 0;
    }
  });

  const markDead = (reason) => {
    destroySession(session, reason);
  };

  proc.on('exit', code => markDead(`doom exited (code ${code})`));
  proc.on('error', err => markDead(`doom spawn error: ${err.message}`));
  session.frameStream.on('error', err => markDead(`frame stream: ${err.message}`));

  session.clientIp = clientIp;
  sessions.set(id, session);
  debugLog('session.new', {
    sessionId: id,
    ip: clientIp,
    openSessions: sessions.size,
    perIpSessions: sessionsByIp.get(clientIp) || 0,
  });
  return session;
}

function destroySession(session, reason = 'reaped') {
  if (session.dead) return;
  const openBefore = sessions.size;
  const ipBefore = session.clientIp ? (sessionsByIp.get(session.clientIp) || 1) : 0;
  session.dead = true;
  try { session.proc.stdin.write('Q\n'); } catch {}
  try { session.proc.kill('SIGTERM'); } catch {}
  // Fallback hard-kill if the process ignores SIGTERM.
  setTimeout(() => {
    try { session.proc.kill('SIGKILL'); } catch {}
  }, 1000).unref();
  for (const w of session.pending) w.reject(new Error(reason));
  session.pending.length = 0;
  session.pendingHead = 0;
  sessions.delete(session.id);
  // Decrement per-IP counter.
  if (session.clientIp) {
    const n = (sessionsByIp.get(session.clientIp) || 1) - 1;
    if (n <= 0) sessionsByIp.delete(session.clientIp);
    else sessionsByIp.set(session.clientIp, n);
  }

  session.stats.endedAt = Date.now();
  runtimeStats.sessionsEnded += 1;
  runtimeStats.endedSessions.push({
    ...getSessionStatsSummary(session),
    endReason: reason,
  });
  if (runtimeStats.endedSessions.length > STATS_MAX_ENDED_SESSIONS) {
    runtimeStats.endedSessions.splice(0, runtimeStats.endedSessions.length - STATS_MAX_ENDED_SESSIONS);
  }
  scheduleStatsPersist();

  debugLog('session.destroy', {
    sessionId: session.id,
    reason,
    ip: session.clientIp || 'unknown',
    openSessionsBefore: openBefore,
    openSessionsAfter: sessions.size,
    perIpBefore: ipBefore,
    perIpAfter: session.clientIp ? (sessionsByIp.get(session.clientIp) || 0) : 0,
  });
}

// Reap idle sessions.
setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const s of sessions.values()) {
    if (s.lastActive < cutoff) destroySession(s, 'idle timeout');
  }
}, REAP_INTERVAL_MS).unref();

// Kill all doom children if the Node server itself dies.
function killAll() {
  for (const s of [...sessions.values()]) destroySession(s, 'server shutdown');
  persistRuntimeStatsSync();
}
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(0); });
process.on('SIGTERM', () => { killAll(); process.exit(0); });

// per-session command pipeline

function writeCmd(session, line) {
  if (session.dead) throw new Error('session dead');
  session.proc.stdin.write(line + '\n');
}

function requestFrame(session) {
  return new Promise((resolve, reject) => {
    if (session.dead) return reject(new Error('session dead'));
    session.pending.push({ resolve, reject });
    writeCmd(session, 'F');
  });
}

// Run one "key press" cycle end-to-end and return the resulting frame.
// Serialised per-session via `busy` so concurrent /tick requests queue up
// instead of interleaving commands on the same pipe.
async function step(session, doomKey) {
  // Wait for the previous step on this session to finish. We grab the
  // current busy promise before awaiting so we only wait one cycle.
  // Otherwise a settled promise would leave us spinning forever.
  while (session.busy) {
    const prev = session.busy;
    try { await prev; } catch {}
    if (session.busy === prev) session.busy = null;
  }

  const work = (async () => {
    session.lastActive = Date.now();
    if (doomKey != null) {
      writeCmd(session, `K 1 ${doomKey}`);
      writeCmd(session, `T ${TICS_KEYDOWN}`);
      writeCmd(session, `K 0 ${doomKey}`);
      writeCmd(session, `T ${TICS_KEYUP}`);
    } else {
      writeCmd(session, `T ${TICS_IDLE}`);
    }
    writeCmd(session, 'S');
    return requestFrame(session);
  })();
  session.busy = work;
  try {
    return await work;
  } finally {
    if (session.busy === work) session.busy = null;
  }
}

// framebuffer to ANSI

const RESET = '\x1b[0m';
const CLEAR = '\x1b[2J\x1b[H';
const HOME = '\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';

function frameToAnsi(fb, cols, rows) {
  // Two stacked pixels per character row using '▀' (upper half block):
  // foreground = top pixel, background = bottom pixel, doubling vertical
  // resolution for free.
  //
  // We start each frame with cursor-home (`\x1b[H`), NOT clear-screen
  // (`\x1b[2J`). On slow terminals the difference is night and day: with
  // 2J, if the terminal hasn't finished rendering frame N before frame
  // N+1's clear arrives, the user sees a blank/half-blank screen. With
  // home-only, the new frame overwrites in place, so the worst-case
  // glitch is a frame that's "torn" (top from N+1, bottom from N), far
  // more readable than blanking. Callers that need to actually clear the
  // screen (e.g. the very first frame of a session) prepend CLEAR
  // themselves.
  const pxH = rows * 2;
  const xScale = DOOM_W / cols;
  const yScale = DOOM_H / pxH;

  const parts = [HOME, HIDE_CURSOR];
  let prevTr = -1, prevTg = -1, prevTb = -1;
  let prevBr = -1, prevBg = -1, prevBb = -1;

  for (let row = 0; row < rows; row++) {
    const syTop = Math.min(DOOM_H - 1, ((row * 2) * yScale) | 0);
    const syBot = Math.min(DOOM_H - 1, ((row * 2 + 1) * yScale) | 0);
    for (let col = 0; col < cols; col++) {
      const sx = Math.min(DOOM_W - 1, (col * xScale) | 0);
      const topIdx = (syTop * DOOM_W + sx) * 4;
      const botIdx = (syBot * DOOM_W + sx) * 4;
      const tr = fb[topIdx + 2];
      const tg = fb[topIdx + 1];
      const tb = fb[topIdx];
      const br = fb[botIdx + 2];
      const bg = fb[botIdx + 1];
      const bb = fb[botIdx];

      // Emit SGR only when color changes, shrinks the response ~5×.
      if (tr !== prevTr || tg !== prevTg || tb !== prevTb) {
        parts.push(`\x1b[38;2;${tr};${tg};${tb}m`);
        prevTr = tr;
        prevTg = tg;
        prevTb = tb;
      }
      if (br !== prevBr || bg !== prevBg || bb !== prevBb) {
        parts.push(`\x1b[48;2;${br};${bg};${bb}m`);
        prevBr = br;
        prevBg = bg;
        prevBb = bb;
      }
      parts.push('\u2580'); // ▀
    }
    parts.push(RESET, '\n');
    prevTr = prevTg = prevTb = -1;
    prevBr = prevBg = prevBb = -1;
  }
  return parts.join('');
}

// HTTP

// Hide Express fingerprint.
app.disable('x-powered-by');

// Trust first proxy for req.ip (set to 0 or remove if not behind a reverse proxy).
app.set('trust proxy', 1);

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

// Simple access token gate. When ACCESS_TOKEN is set, every request
// (except /health and the browser landing page) must carry an
// Authorization: Bearer <token> header. Keeps drive-by bots and scanners
// out without leaking the token in URLs.
if (ACCESS_TOKEN) {
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (req.path === '/favicon.ico') return next();
    if (req.path === '/stats' && req.method === 'GET') return next();
    // Let browsers see the HTML landing page (they can't play without the token).
    if (req.path === '/' && req.method === 'GET') {
      const ua = (req.headers['user-agent'] || '').toLowerCase();
      if (!/^(curl|wget|fetch|httpie|powershell|libfetch)/.test(ua)) return next();
    }
    if (req.path === '/stats.json' && req.method === 'GET') {
      const ua = (req.headers['user-agent'] || '').toLowerCase();
      if (!/^(curl|wget|fetch|httpie|powershell|libfetch)/.test(ua)) return next();
    }
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (bearer === ACCESS_TOKEN) return next();
    res.status(403).send('#!/bin/sh\necho "Access denied. Wrong or missing token." >&2\nexit 1\n');
  });
}

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// Global rate limiter: max 600 requests per minute per IP.
// Each /tick is one request, so gameplay alone needs ~300-400/min.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests — slow down.\n',
  handler: (req, res, next, options) => {
    debugLog('rate.limit', {
      ip: getClientIp(req),
      path: req.path,
      method: req.method,
      sessionId: req.query?.s || null,
    });
    res.status(options.statusCode).send(options.message);
  },
});
app.use(globalLimiter);

// Stricter limiter for session-creation endpoints.
const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many new sessions — wait a minute.\n',
});

// Upper bounds match doom's native resolution under the half-block glyph
// (cols × rows*2 pixels). Beyond 320×200 we'd just be upscaling, which
// adds bytes without adding detail.
const MAX_COLS = 320;
const MAX_ROWS = 100;

function parseDims(req) {
  const cols = Math.max(20, Math.min(MAX_COLS, parseInt(req.query.cols, 10) || DEFAULT_COLS));
  const rows = Math.max(10, Math.min(MAX_ROWS, parseInt(req.query.rows, 10) || DEFAULT_ROWS));
  return { cols, rows };
}

// POST /new to create session, return session id + first frame.
app.post('/new', sessionLimiter, async (req, res) => {
  let session;
  try {
    session = createSession(getClientIp(req));
    const { cols, rows } = parseDims(req);
    // The C side runs 35 warm-up tics inside main() before accepting
    // commands, so the first framebuffer already contains a real frame.
    writeCmd(session, 'S');
    const fb = await requestFrame(session);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Session', session.id);
    // First frame clears the screen; subsequent /tick frames just home.
    res.send(CLEAR + frameToAnsi(fb, cols, rows));
  } catch (err) {
    if (session) destroySession(session, 'new failed');
    res.status(500).send(`Failed to start doom: ${err.message}\n`);
  }
});

// POST /tick?s=SESSION&key=KEY to advance game, return ANSI frame.
app.post('/tick', async (req, res) => {
  const id = req.query.s;
  const session = id && sessions.get(id);
  if (!session) {
    res.status(400).send('Unknown session. POST /new to start.\n');
    return;
  }
  // Verify the request comes from the same IP that created the session.
  if (session.clientIp && session.clientIp !== getClientIp(req)) {
    res.status(403).send('Session not yours.\n');
    return;
  }
  const rawKey = req.query.key || '';
  if (!(rawKey in KEYMAP)) {
    res.status(400).send(`Unknown key: ${JSON.stringify(rawKey)}\n`);
    return;
  }
  const tickStart = Date.now();
  try {
    const { cols, rows } = parseDims(req);
    const doomKey = KEYMAP[rawKey];
    const fb = await step(session, doomKey);
    const tickMs = Date.now() - tickStart;
    recordInputEvent(session, {
      source: 'tick',
      action: actionFromKeys(rawKey, doomKey),
      rawKey,
      doomKey,
      tickMs,
    });
    if (DEBUG_VERBOSE_TICKS || tickMs >= DEBUG_TICK_SLOW_MS) {
      debugLog('tick', {
        sessionId: session.id,
        ip: getClientIp(req),
        rawKey,
        doomKey: KEYMAP[rawKey],
        tickMs,
        queueDepth: session.pending.length - session.pendingHead,
      });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(frameToAnsi(fb, cols, rows));
  } catch (err) {
    debugLog('tick.error', {
      sessionId: session.id,
      ip: getClientIp(req),
      rawKey,
      error: err.message,
    });
    res.status(500).send(`Tick failed: ${err.message}\n`);
  }
});

// POST /quit?s=SESSION to explicit cleanup (doom.sh sends this on exit).
app.post('/quit', (req, res) => {
  const id = req.query.s;
  const session = id && sessions.get(id);
  if (session) destroySession(session, 'quit');
  res.send('bye\n');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/stats.json', (req, res) => {
  if (!STATS_ENABLED) {
    res.status(503).json({ status: 'disabled' });
    return;
  }
  res.json(buildStatsSnapshot());
});

app.get('/stats', (req, res) => {
  if (!STATS_ENABLED) {
    res.status(503).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<!doctype html><html><body><h1>Stats disabled</h1><p>Set STATS_ENABLED=1 to enable.</p></body></html>');
    return;
  }

  const stats = buildStatsSnapshot();
  const initialStatsJson = JSON.stringify(stats).replace(/</g, '\\u003c');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>cURL DOOM Stats Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=JetBrains+Mono:wght@400;600&display=swap');
  :root {
    --bg:#080d12;
    --bg2:#0d141c;
    --panel:#101924;
    --panel2:#101924;
    --border:#1a2a3a;
    --ink:#d8e7f3;
    --muted:#93aabc;
    --hot:#ff6a3d;
    --cool:#27d3ff;
    --ok:#31df95;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: var(--ink);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    background:
      radial-gradient(1200px 500px at 100% -10%, rgba(39,211,255,.14), transparent 60%),
      radial-gradient(900px 500px at -10% 10%, rgba(255,106,61,.14), transparent 60%),
      linear-gradient(160deg, var(--bg), var(--bg2));
    min-height: 100vh;
    padding: 1rem;
  }
  .crt-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 9998;
    background:
      linear-gradient(rgba(255,255,255,0) 50%, rgba(0,0,0,0.28) 50%),
      linear-gradient(90deg, rgba(255,0,0,0.06), rgba(0,255,255,0.03));
    background-size: 100% 3px, 5px 100%;
    opacity: 0.32;
    animation: crtFlicker 5.5s steps(40, end) infinite;
  }
  .crt-vignette {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 9997;
    background: radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0,.40) 100%);
    opacity: .36;
  }
  @keyframes crtFlicker {
    0%, 100% { opacity: .30; }
    50% { opacity: .36; }
  }
  .wrap {
    max-width: 1200px;
    margin: 0 auto;
    border: 1px solid #29425a;
    padding: 1rem;
    background: linear-gradient(180deg, rgba(10,18,26,.72), rgba(10,18,26,.5));
  }
  .top {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  h1 {
    margin: 0;
    font-family: 'Orbitron', sans-serif;
    font-weight: 900;
    letter-spacing: .08em;
    color: #fff;
    text-shadow: 0 0 18px rgba(39,211,255,.45);
    font-size: clamp(1.1rem, 4.6vw, 2.1rem);
  }
  .sub { color: var(--muted); font-size: .85rem; }
  a { color: var(--cool); text-decoration: none; }
  a:hover { color: #8be7ff; }
  .toolbar { display: flex; gap: .8rem; align-items: center; color: var(--muted); font-size: .85rem; }
  .toolbar-btn {
    border: 1px solid #2a4a61;
    background: #0f2232;
    color: #d5f1ff;
    padding: .34rem .62rem;
    cursor: pointer;
    font: inherit;
  }
  .toolbar-btn:hover { border-color: #3f7394; color: #ffffff; }
  .grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(12, minmax(0, 1fr));
  }
  .panel {
    background: transparent;
    border: none;
    border-radius: 0;
    padding: .25rem 0 0 0;
    box-shadow: none;
  }
  .kpi-grid {
    grid-column: 1 / -1;
    display: grid;
    gap: .8rem;
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
  .kpi {
    background: transparent;
    border: none;
    border-radius: 0;
    padding: .35rem 0 .55rem 0;
    border-bottom: 1px solid #1c3145;
  }
  .kpi .label { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; }
  .kpi .val { font-family: 'Orbitron', sans-serif; font-size: 1.18rem; margin-top: .2rem; }
  .actions { grid-column: span 5; }
  .map { grid-column: span 7; }
  .sessions { grid-column: 1 / -1; }
  h2 {
    margin: 0 0 .8rem;
    font-family: 'Orbitron', sans-serif;
    font-size: .95rem;
    letter-spacing: .08em;
    color: #eaf6ff;
  }
  .bars { display: grid; gap: .55rem; }
  .bar-row { display: grid; grid-template-columns: 120px 1fr 70px; gap: .6rem; align-items: center; }
  .bar-label { color: #cce3f6; font-size: .82rem; }
  .bar-track { background: #0c1620; border: 1px solid #233a50; border-radius: 999px; overflow: hidden; height: 14px; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, var(--hot), #ffb35c); }
  .bar-val { color: #ffd7c9; text-align: right; font-size: .8rem; }
  .canvas-wrap { position: relative; border: none; border-radius: 0; overflow: hidden; background: #0a131c; }
  canvas { width: 100%; height: 260px; display: block; }
  .map-caption { color: var(--muted); margin-top: .55rem; font-size: .78rem; }
  .toggle-row {
    display: flex;
    flex-wrap: wrap;
    gap: .45rem;
    margin: 0 0 .65rem 0;
  }
  .chip {
    border: 1px solid transparent;
    color: #b8d4ea;
    background: #0e1a25;
    border-radius: 4px;
    padding: .26rem .62rem;
    font-size: .74rem;
    cursor: pointer;
    user-select: none;
  }
  .chip.active {
    border-color: #31df95;
    color: #eafff5;
    background: rgba(49,223,149,.18);
  }
  .chip.off {
    opacity: .45;
  }
  table { width: 100%; border-collapse: collapse; font-size: .86rem; }
  th, td { text-align: left; padding: .52rem; border-bottom: 1px solid #1e3144; }
  th { color: #a8c5dd; font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; }
  tbody tr:hover { background: rgba(39,211,255,.04); }
  .empty { color: var(--muted); font-size: .88rem; padding: .5rem 0; }
  .hover-tip {
    position: fixed;
    z-index: 10001;
    max-width: min(360px, calc(100vw - 24px));
    padding: .5rem .62rem;
    border: 1px solid #35576f;
    background: rgba(7, 16, 24, .96);
    color: #e8f4ff;
    font-size: .76rem;
    line-height: 1.35;
    pointer-events: none;
    box-shadow: 0 12px 32px rgba(0, 0, 0, .4);
    opacity: 0;
    transform: translateY(4px);
    transition: opacity .08s linear, transform .08s linear;
  }
  .hover-tip.show {
    opacity: 1;
    transform: translateY(0);
  }
  dialog.help-dialog {
    width: min(780px, calc(100vw - 1.2rem));
    margin: auto;
    border: 1px solid #29425a;
    padding: 0;
    background: linear-gradient(180deg, rgba(8,16,24,.98), rgba(8,16,24,.94));
    color: var(--ink);
    box-shadow: 0 28px 80px rgba(0, 0, 0, .52);
  }
  dialog.help-dialog::backdrop {
    background: rgba(2, 7, 11, .72);
    backdrop-filter: blur(2px);
  }
  .help-sheet { padding: 1rem; }
  .help-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: .8rem;
    margin-bottom: .85rem;
  }
  .help-head h2 { margin: 0; }
  .help-close {
    border: 1px solid #2a4a61;
    background: #0f2232;
    color: #d5f1ff;
    padding: .35rem .58rem;
    cursor: pointer;
    font: inherit;
  }
  .help-grid {
    display: grid;
    grid-template-columns: minmax(120px, 190px) 1fr;
    gap: .45rem .9rem;
    font-size: .84rem;
    margin-bottom: .9rem;
  }
  .help-abbr { color: #8be7ff; }
  .help-section {
    margin: .85rem 0 .35rem;
    color: #d7ebf9;
    font-family: 'Orbitron', sans-serif;
    font-size: .82rem;
    letter-spacing: .07em;
    text-transform: uppercase;
  }
  .help-note {
    color: var(--muted);
    font-size: .78rem;
    line-height: 1.45;
  }
  @media (max-width: 980px) {
    .top {
      flex-direction: column;
      align-items: flex-start;
    }
    .toolbar { flex-wrap: wrap; }
    .kpi-grid { grid-template-columns: repeat(3, minmax(0,1fr)); }
    .actions, .map { grid-column: 1 / -1; }
  }
  @media (max-width: 620px) {
    body { padding: .6rem; }
    .crt-overlay { opacity: .18; animation: none; }
    .crt-vignette { opacity: .20; }
    .wrap { padding: .7rem; }
    .kpi-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
    .bar-row { grid-template-columns: 90px 1fr 56px; }
    canvas { height: 220px; }
    th, td { padding: .4rem .35rem; }
    .sessions > div { overflow-x: auto; }
    .hover-tip { max-width: calc(100vw - 16px); font-size: .72rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .crt-overlay { animation: none; }
  }
</style></head><body>
  <div class="crt-vignette" aria-hidden="true"></div>
  <div class="crt-overlay" aria-hidden="true"></div>
<div class="wrap">
  <div class="top">
    <div>
      <h1>cURL DOOM STATS</h1>
      <div class="sub">Live gameplay analytics and movement telemetry</div>
    </div>
    <div class="toolbar">
      <a href="/">Back</a>
      <span>·</span>
      <span>Version ${APP_VERSION}</span>
      <span>·</span>
      <button type="button" class="toolbar-btn" id="open-help-btn">Help</button>
      <span>·</span>
      <a href="/stats.json">JSON</a>
      <span>·</span>
      <span id="updated">updating...</span>
    </div>
  </div>

  <dialog class="help-dialog" id="help-dialog">
    <div class="help-sheet">
      <div class="help-head">
        <div>
          <h2>Stats Help</h2>
          <div class="sub">Legend for abbreviations and values on this screen</div>
        </div>
        <button type="button" class="help-close" id="close-help-btn">Close</button>
      </div>

      <div class="help-section">Active Players Table</div>
      <div class="help-grid">
        <div class="help-abbr">Session</div><div>Unique server-side session ID for the connected player.</div>
        <div class="help-abbr">IP Hash</div><div>Short anonymized fingerprint of the client IP.</div>
        <div class="help-abbr">Events</div><div>Total input events sent by that player this session.</div>
        <div class="help-abbr">Position (x,y,z)</div><div>Player world coordinates from the current map state.</div>
        <div class="help-abbr">Map</div><div>Map identifier like E1M1 (episode 1, map 1).</div>
        <div class="help-abbr">Health</div><div>Current player health points.</div>
        <div class="help-abbr">Armor</div><div>Current armor points.</div>
        <div class="help-abbr">Secrets</div><div>Secret progress as found/total (percentage).</div>
        <div class="help-abbr">Weapon</div><div>Current active weapon name.</div>
        <div class="help-abbr">Keys/Skulls</div><div>Owned access items shown with short codes (see below).</div>
        <div class="help-abbr">Ammo</div><div>Ammo amounts in this order: clip/shell/cell/misl.</div>
      </div>

      <div class="help-section">Key/Skull Codes</div>
      <div class="help-grid">
        <div class="help-abbr">BC / YC / RC</div><div>Blue card / Yellow card / Red card.</div>
        <div class="help-abbr">BS / YS / RS</div><div>Blue skull / Yellow skull / Red skull.</div>
      </div>

      <div class="help-section">Other Panels</div>
      <div class="help-grid">
        <div class="help-abbr">KPI cards</div><div>Server-level counts and timestamps across all sessions.</div>
        <div class="help-abbr">Action Distribution</div><div>Top input action frequencies during the current server uptime.</div>
        <div class="help-abbr">Live Position Plot</div><div>2D map-space projection of active players on the selected map.</div>
        <div class="help-abbr">Player chips</div><div>Click a player chip to hide/show that player in chart and table.</div>
      </div>

      <div class="help-note">Values refresh every ~5 seconds and represent the latest telemetry received from active sessions.</div>
    </div>
  </dialog>

  <div class="grid">
    <div class="kpi-grid" id="kpis">
      <div class="kpi"><div class="label">Uptime Started</div><div class="val" id="kpi-started">-</div></div>
      <div class="kpi"><div class="label">Sessions Created</div><div class="val" id="kpi-created">0</div></div>
      <div class="kpi"><div class="label">Sessions Ended</div><div class="val" id="kpi-ended">0</div></div>
      <div class="kpi"><div class="label">Active Sessions</div><div class="val" id="kpi-active">0</div></div>
      <div class="kpi"><div class="label">Total Inputs</div><div class="val" id="kpi-inputs">0</div></div>
      <div class="kpi"><div class="label">Last Update</div><div class="val" id="kpi-now">-</div></div>
    </div>

    <section class="panel actions">
      <h2>Action Distribution</h2>
      <div id="action-bars" class="bars"></div>
      <div id="action-empty" class="empty" style="display:none;">No action data yet.</div>
    </section>

    <section class="panel map">
      <h2>Live Position Plot</h2>
      <div id="map-toggle-row" class="toggle-row"></div>
      <div id="player-toggle-row" class="toggle-row"></div>
      <div class="canvas-wrap"><canvas id="pos-canvas" width="820" height="260"></canvas></div>
      <div id="map-caption" class="map-caption">No active player positions yet.</div>
    </section>

    <section class="panel sessions">
      <h2>Active Players</h2>
      <div style="overflow:auto;">
        <table>
          <thead><tr><th data-tip="Unique server-side session identifier.">Session</th><th data-tip="Anonymized hash of the client IP address.">IP Hash</th><th data-tip="Count of input events sent in this session.">Events</th><th data-tip="Player world coordinates x, y, z.">Position (x,y,z)</th><th data-tip="Current map label, for example E1M1.">Map</th><th data-tip="Current player health points.">Health</th><th data-tip="Current player armor points.">Armor</th><th data-tip="Secrets found over total and percentage for current map.">Secrets</th><th data-tip="Currently equipped weapon.">Weapon</th><th data-tip="Owned keycards and skull keys. BC/YC/RC and BS/YS/RS.">Keys/Skulls</th><th data-tip="Ammo totals in order: clip/shell/cell/misl.">Ammo</th></tr></thead>
          <tbody id="session-body"></tbody>
        </table>
      </div>
      <div id="session-empty" class="empty" style="display:none;">No active sessions.</div>
    </section>
  </div>
</div>
<div id="hover-tip" class="hover-tip" role="tooltip" aria-hidden="true"></div>

<script>
const initialStats = ${initialStatsJson};

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderKpis(data) {
  setText('kpi-started', data.startedAt ? new Date(data.startedAt).toLocaleTimeString() : '-');
  setText('kpi-created', fmtNum(data.sessionsCreated));
  setText('kpi-ended', fmtNum(data.sessionsEnded));
  setText('kpi-active', fmtNum(data.activeSessionCount));
  setText('kpi-inputs', fmtNum(data.totalInputEvents));
  setText('kpi-now', data.now ? new Date(data.now).toLocaleTimeString() : '-');
  setText('updated', 'updated ' + new Date().toLocaleTimeString());
}

function actionMeaning(action) {
  const labels = {
    forward: 'Move forward.',
    backward: 'Move backward.',
    turn_left: 'Turn camera/player left.',
    turn_right: 'Turn camera/player right.',
    strafe_left: 'Move sideways to the left.',
    strafe_right: 'Move sideways to the right.',
    shoot: 'Fire the currently equipped weapon.',
    use: 'Use or interact (doors, switches, etc.).',
    confirm: 'Confirm menu or dialog action.',
    escape: 'Open or close in-game menu.',
    automap: 'Toggle automap view.',
    run: 'Hold run/speed modifier.',
    dialog_yes: 'Answer yes in prompts.',
    dialog_no: 'Answer no in prompts.',
    idle: 'No input sent; idle poll tick.',
    unknown: 'Input action not mapped to a known command.',
  };
  return labels[action] || ('Action: ' + action + '.');
}

function setupHoverTooltips() {
  const tip = document.getElementById('hover-tip');
  if (!tip) return;
  let activeEl = null;
  let hideTimer = null;
  const margin = 14;

  function textFor(el) {
    return el ? el.getAttribute('data-tip') : '';
  }

  function place(x, y) {
    if (!tip.classList.contains('show')) return;
    const rect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x + margin;
    let top = y + margin;
    if (left + rect.width > vw - 8) left = Math.max(8, x - rect.width - margin);
    if (top + rect.height > vh - 8) top = Math.max(8, y - rect.height - margin);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function show(el, x, y) {
    const text = textFor(el);
    if (!text) return;
    activeEl = el;
    tip.textContent = text;
    tip.classList.add('show');
    tip.setAttribute('aria-hidden', 'false');
    place(x, y);
  }

  function hide() {
    activeEl = null;
    tip.classList.remove('show');
    tip.setAttribute('aria-hidden', 'true');
  }

  document.addEventListener('pointerover', function (event) {
    const el = event.target.closest('[data-tip]');
    if (!el) return;
    clearTimeout(hideTimer);
    show(el, event.clientX, event.clientY);
  });

  document.addEventListener('pointermove', function (event) {
    if (!activeEl) return;
    place(event.clientX, event.clientY);
  });

  document.addEventListener('pointerout', function (event) {
    if (!activeEl) return;
    const next = event.relatedTarget;
    if (next && activeEl.contains(next)) return;
    hide();
  });

  document.addEventListener('focusin', function (event) {
    const el = event.target.closest('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, r.right, r.bottom);
  });

  document.addEventListener('focusout', function (event) {
    const el = event.target.closest('[data-tip]');
    if (el === activeEl) hide();
  });

  document.addEventListener('touchstart', function (event) {
    const el = event.target.closest('[data-tip]');
    if (!el) {
      hide();
      return;
    }
    const t = event.touches && event.touches[0];
    if (!t) return;
    show(el, t.clientX, t.clientY);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 2400);
  }, { passive: true });

  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('resize', hide);
}

function renderActionBars(data) {
  const container = document.getElementById('action-bars');
  const empty = document.getElementById('action-empty');
  container.innerHTML = '';
  const rows = (data.actionTotals || []).slice(0, 8);
  if (!rows.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  const max = Math.max(...rows.map(r => r.count || 0), 1);
  for (const row of rows) {
    const pct = Math.max(4, Math.round(((row.count || 0) / max) * 100));
    const item = document.createElement('div');
    item.className = 'bar-row';
    item.setAttribute('data-tip', actionMeaning(row.action));
    item.innerHTML = '<div class="bar-label">' + row.action + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="bar-val">' + fmtNum(row.count) + '</div>';
    const label = item.querySelector('.bar-label');
    if (label) label.setAttribute('data-tip', actionMeaning(row.action));
    container.appendChild(item);
  }
}

let selectedMapName = null;
const hiddenPlayers = new Set();

function mapLabelOfSession(s) {
  if (s.mapName) return s.mapName;
  const st = s.latestState || {};
  if (typeof st.episode === 'number' && typeof st.map === 'number') {
    return 'E' + st.episode + 'M' + st.map;
  }
  return 'unknown';
}

function keysOwnedLabel(st) {
  const keys = [];
  if (st.key_blue_card) keys.push('BC');
  if (st.key_yellow_card) keys.push('YC');
  if (st.key_red_card) keys.push('RC');
  if (st.key_blue_skull) keys.push('BS');
  if (st.key_yellow_skull) keys.push('YS');
  if (st.key_red_skull) keys.push('RS');
  return keys.length ? keys.join(' ') : '-';
}

function syncMapSelection(data) {
  const maps = [...new Set((data.activeSessions || []).map(mapLabelOfSession))].filter(Boolean);
  if (!maps.length) {
    selectedMapName = null;
    return maps;
  }
  if (!selectedMapName || !maps.includes(selectedMapName)) {
    selectedMapName = maps[0];
  }
  return maps;
}

function renderMapToggles(data) {
  const maps = syncMapSelection(data);
  const row = document.getElementById('map-toggle-row');
  row.innerHTML = '';
  if (!maps.length) return;
  for (const mapName of maps) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (mapName === selectedMapName ? ' active' : '');
    btn.textContent = mapName;
    btn.addEventListener('click', () => {
      selectedMapName = mapName;
      render(data);
    });
    row.appendChild(btn);
  }
}

function renderPlayerToggles(data) {
  const row = document.getElementById('player-toggle-row');
  row.innerHTML = '';
  const sessions = (data.activeSessions || []).filter(s => mapLabelOfSession(s) === selectedMapName);
  for (const s of sessions) {
    const hidden = hiddenPlayers.has(s.sessionId);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (hidden ? ' off' : ' active');
    btn.textContent = s.sessionId.slice(0, 8);
    btn.addEventListener('click', () => {
      if (hiddenPlayers.has(s.sessionId)) hiddenPlayers.delete(s.sessionId);
      else hiddenPlayers.add(s.sessionId);
      drawPositions(data);
      renderSessions(data);
      renderPlayerToggles(data);
    });
    row.appendChild(btn);
  }
}

function drawPositions(data) {
  const canvas = document.getElementById('pos-canvas');
  const cap = document.getElementById('map-caption');
  const ctx = canvas.getContext('2d');
  const filteredSessions = (data.activeSessions || [])
    .filter(s => mapLabelOfSession(s) === selectedMapName)
    .filter(s => !hiddenPlayers.has(s.sessionId));

  const points = filteredSessions
    .map(s => {
      const st = s.latestState || {};
      if (typeof st.x !== 'number' || typeof st.y !== 'number') return null;
      return {
        x: st.x,
        y: st.y,
        sid: s.sessionId,
        mapName: mapLabelOfSession(s),
      };
    })
    .filter(Boolean);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0a131c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#1f3446';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const y = (canvas.height / 6) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  for (let i = 1; i < 8; i++) {
    const x = (canvas.width / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }

  if (!selectedMapName) {
    cap.textContent = 'No active map.';
    return;
  }

  const geometry = data.mapGeometries ? data.mapGeometries[selectedMapName] : null;

  let minX;
  let maxX;
  let minY;
  let maxY;
  if (geometry && geometry.bbox) {
    ({ minX, maxX, minY, maxY } = geometry.bbox);
  } else if (points.length) {
    minX = Math.min(...points.map(p => p.x));
    maxX = Math.max(...points.map(p => p.x));
    minY = Math.min(...points.map(p => p.y));
    maxY = Math.max(...points.map(p => p.y));
    } else {
      cap.textContent = 'Map ' + selectedMapName + ': no visible players.';
    return;
  }

  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);

  const pad = 20;
  const toCanvas = (x, y) => {
    const px = pad + ((x - minX) / spanX) * (canvas.width - pad * 2);
    const py = pad + ((y - minY) / spanY) * (canvas.height - pad * 2);
    return [px, canvas.height - py];
  };

  if (geometry && geometry.lines && geometry.lines.length) {
    ctx.strokeStyle = '#21465f';
    ctx.lineWidth = 1;
    for (const ln of geometry.lines) {
      const [x1, y1, x2, y2] = ln;
      const [sx1, sy1] = toCanvas(x1, y1);
      const [sx2, sy2] = toCanvas(x2, y2);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  }

  for (const p of points) {
    const [px, yFlip] = toCanvas(p.x, p.y);
    ctx.beginPath();
    ctx.arc(px, yFlip, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#31df95';
    ctx.fill();
    ctx.strokeStyle = '#073627';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#b8f5d8';
    ctx.font = '11px JetBrains Mono';
    ctx.fillText(p.sid.slice(0, 6), px + 8, yFlip - 8);
  }

    if (geometry && geometry.source) {
      cap.textContent = 'Map ' + selectedMapName + ' overlay from ' + geometry.source + '; visible players: ' + points.length + '.';
    } else {
      cap.textContent = 'Map ' + selectedMapName + ' without geometry overlay; visible players: ' + points.length + '.';
  }
}

function renderSessions(data) {
  const body = document.getElementById('session-body');
  const empty = document.getElementById('session-empty');
  body.innerHTML = '';
  const sessions = (data.activeSessions || [])
    .filter(s => mapLabelOfSession(s) === selectedMapName)
    .filter(s => !hiddenPlayers.has(s.sessionId));
  if (!sessions.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  for (const s of sessions) {
    const st = s.latestState || {};
    const pos = (typeof st.x === 'number' && typeof st.y === 'number' && typeof st.z === 'number')
      ? (st.x.toFixed(2) + ', ' + st.y.toFixed(2) + ', ' + st.z.toFixed(2))
      : '-';
    const secretPct = (typeof st.secret_pct === 'number') ? st.secret_pct.toFixed(1) : '0.0';
    const secrets = (typeof st.secret_count === 'number' && typeof st.secret_total === 'number')
      ? (st.secret_count + '/' + st.secret_total + ' (' + secretPct + '%)')
      : '-';
    const weapon = st.weapon || (typeof st.weapon_id === 'number' ? ('#' + st.weapon_id) : '-');
    const keysOwned = keysOwnedLabel(st);
    const ammo = [st.ammo_clip, st.ammo_shell, st.ammo_cell, st.ammo_misl]
      .filter(v => typeof v === 'number')
      .join('/');
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td data-tip="Unique server-side session identifier.">' + s.sessionId + '</td>' +
      '<td data-tip="Anonymized hash of the client IP address.">' + s.ipHash + '</td>' +
      '<td data-tip="Count of input events sent in this session.">' + fmtNum(s.events) + '</td>' +
      '<td data-tip="Player world coordinates x, y, z.">' + pos + '</td>' +
      '<td data-tip="Current map label, for example E1M1.">' + mapLabelOfSession(s) + '</td>' +
      '<td data-tip="Current player health points.">' + (st.health ?? '-') + '</td>' +
      '<td data-tip="Current player armor points.">' + (st.armor ?? '-') + '</td>' +
      '<td data-tip="Secrets found over total and percentage for current map.">' + secrets + '</td>' +
      '<td data-tip="Currently equipped weapon.">' + weapon + '</td>' +
      '<td data-tip="Owned keycards and skull keys. BC/YC/RC and BS/YS/RS.">' + keysOwned + '</td>' +
      '<td data-tip="Ammo totals in order: clip/shell/cell/misl.">' + (ammo || '-') + '</td>';
    body.appendChild(tr);
  }
}

function render(data) {
  renderMapToggles(data);
  renderPlayerToggles(data);
  renderKpis(data);
  renderActionBars(data);
  drawPositions(data);
  renderSessions(data);
}

async function refresh() {
  try {
    const res = await fetch('/stats.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    render(data);
  } catch (err) {
    setText('updated', 'update failed: ' + err.message);
  }
}

function setupHelpDialog() {
  const helpBtn = document.getElementById('open-help-btn');
  const helpDialog = document.getElementById('help-dialog');
  const closeHelpBtn = document.getElementById('close-help-btn');

  function openHelp() {
    if (!helpDialog) return;
    if (typeof helpDialog.showModal === 'function') helpDialog.showModal();
    else helpDialog.setAttribute('open', 'open');
  }

  function closeHelp() {
    if (!helpDialog) return;
    if (typeof helpDialog.close === 'function') helpDialog.close();
    else helpDialog.removeAttribute('open');
  }

  if (helpBtn) helpBtn.addEventListener('click', openHelp);
  if (closeHelpBtn) closeHelpBtn.addEventListener('click', closeHelp);

  if (helpDialog) {
    helpDialog.addEventListener('click', function (event) {
      const rect = helpDialog.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) closeHelp();
    });
  }
}

setupHelpDialog();
setupHoverTooltips();
render(initialStats);
setInterval(refresh, 5000);
</script>
</div>
</body></html>`);
});

// GET / to have content-negotiated landing page.
//
//   curl: returns play.sh, with __SERVER__ rewritten to whichever host
//      it's fetched it from. Pipe straight to bash:
//      curl -sL doom.example.com | bash
//   browser: tiny HTML page that shows the same one-liner.
app.get('/', (req, res) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isCli = /^(curl|wget|fetch|httpie|powershell|libfetch)/.test(ua);

  // Reconstruct the URL the client used to reach us so the served script
  // talks back to the right host (works behind proxies via X-Forwarded-*).
  const protoRaw = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  const proto = /^https?$/.test(protoRaw) ? protoRaw : 'http';
  const hostRaw = (req.headers['x-forwarded-host'] || '').split(',')[0].trim()
    || req.headers.host
    || `localhost:${PORT}`;
  // Sanitize: allow only hostname[:port], reject anything with shell metacharacters.
  const host = /^[a-zA-Z0-9._-]+(:[0-9]{1,5})?$/.test(hostRaw) ? hostRaw : `localhost:${PORT}`;
  // Game URL always uses HTTP on port 666, regardless of how the page is served.
  const gameHost = host.replace(/:[0-9]+$/, '');
  const gameUrl = `http://${gameHost}:${PUBLIC_GAME_PORT}`;

  if (isCli) {
    const auth = req.headers.authorization || '';
    const token = ACCESS_TOKEN && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const script = PLAY_SCRIPT_TEMPLATE
      .replace(/__SERVER__/g, gameUrl)
      .replace(/__TOKEN__/g, token);
    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.send(script);
    return;
  }

  const stats = buildStatsSnapshot();
  const initialStatsJson = JSON.stringify(stats).replace(/</g, '\\u003c');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cURL DOOM</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=JetBrains+Mono:wght@400;600&display=swap');
  :root {
    --bg:#080d12;
    --bg2:#0d141c;
    --ink:#d8e7f3;
    --muted:#93aabc;
    --hot:#ff6a3d;
    --cool:#27d3ff;
    --ok:#31df95;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: var(--ink);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    background:
      radial-gradient(1200px 500px at 100% -10%, rgba(39,211,255,.14), transparent 60%),
      radial-gradient(900px 500px at -10% 10%, rgba(255,106,61,.14), transparent 60%),
      linear-gradient(160deg, var(--bg), var(--bg2));
    min-height: 100vh;
    padding: .75rem;
  }
  .crt-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 9998;
    background:
      linear-gradient(rgba(255,255,255,0) 50%, rgba(0,0,0,0.28) 50%),
      linear-gradient(90deg, rgba(255,0,0,0.06), rgba(0,255,255,0.03));
    background-size: 100% 3px, 5px 100%;
    opacity: 0.32;
    animation: crtFlicker 5.5s steps(40, end) infinite;
  }
  .crt-vignette {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 9997;
    background: radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0,.40) 100%);
    opacity: .36;
  }
  @keyframes crtFlicker {
    0%, 100% { opacity: .30; }
    50% { opacity: .36; }
  }
  .wrap {
    max-width: 1200px;
    margin: 0 auto;
    border: 1px solid #29425a;
    padding: 1rem;
    background: linear-gradient(180deg, rgba(10,18,26,.72), rgba(10,18,26,.5));
  }
  .hero {
    margin: .2rem 0 1rem;
    padding: .3rem 0 .45rem;
    border: none;
    background: transparent;
    box-shadow: none;
  }
  .hero-top {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 1rem;
  }
  .hero-play {
    margin-top: .7rem;
    display: grid;
    gap: .5rem;
  }
  h1 {
    margin: 0;
    font-family: 'Orbitron', sans-serif;
    font-weight: 900;
    letter-spacing: .08em;
    color: #fff;
    text-shadow: 0 0 18px rgba(39,211,255,.45);
    font-size: clamp(1.1rem, 4.6vw, 2.1rem);
  }
  .sub { color: var(--muted); font-size: .85rem; }
  .toolbar { display:flex; gap:.55rem; align-items:center; color:var(--muted); font-size:.82rem; flex-wrap:wrap; justify-content:center; }
  .hero-toolbar { justify-content: center; }
  a { color: var(--cool); text-decoration: none; }
  a:hover { color: #8be7ff; }
  .hero-lead {
    margin: 0;
    font-family: 'Orbitron', sans-serif;
    font-size: .76rem;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: #a8c9dd;
  }
  .hero-actions {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: .4rem;
    flex-wrap: wrap;
    margin: 0;
  }
  .cmd-row {
    display: block;
  }
  .cmd-line-wrap {
    display: block;
    width: 100%;
    min-width: 0;
    overflow: visible;
  }
  .cmd-line {
    display: block;
    width: 100%;
    text-align: center;
    box-sizing: border-box;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
    background: transparent;
    color: #eff9ff;
    border: none;
    box-shadow: none;
    font-size: clamp(.96rem, 1.8vw, 1.16rem);
    line-height: 1.45;
    font-weight: 600;
    letter-spacing: .01em;
    padding: .12rem 0;
    min-width: 0;
  }
  .cmd-strong {
    color: #9fe9ff;
    margin-right: .3rem;
  }
  .copy-btn {
    border: 1px solid rgba(71, 104, 128, .4);
    background: rgba(13, 28, 40, .9);
    color: #d5f1ff;
    padding: .42rem .68rem;
    cursor: pointer;
    font: inherit;
    font-size: .84rem;
  }
  .copy-btn:hover { border-color: rgba(120, 164, 194, .55); color: #ffffff; }
  .copy-btn.secondary {
    background: rgba(13, 28, 40, .82);
    color: #c1d7e5;
  }
  .copy-btn.help {
    background: rgba(13, 28, 40, .82);
    color: #c1d7e5;
  }
  .copy-status {
    color: var(--muted);
    font-size: .78rem;
    min-width: 48px;
  }
  dialog.video-dialog {
    width: min(920px, calc(100vw - 1.2rem));
    margin: auto;
    border: 1px solid #29425a;
    padding: 0;
    background: linear-gradient(180deg, rgba(8,16,24,.98), rgba(8,16,24,.94));
    color: var(--ink);
    box-shadow: 0 28px 80px rgba(0, 0, 0, .52);
  }
  dialog.video-dialog::backdrop {
    background: rgba(2, 7, 11, .72);
    backdrop-filter: blur(2px);
  }
  .video-sheet { padding: 1rem; }
  .video-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: .8rem;
    margin-bottom: .85rem;
  }
  .video-head h2 { margin: 0; }
  .video-close {
    border: 1px solid #2a4a61;
    background: #0f2232;
    color: #d5f1ff;
    padding: .35rem .58rem;
    cursor: pointer;
    font: inherit;
  }
  .video-frame {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #05090d;
    border: 1px solid #22384c;
  }
  .video-frame iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }
  dialog.controls-dialog {
    width: min(560px, calc(100vw - 1.2rem));
    margin: auto;
    border: 1px solid #29425a;
    padding: 0;
    background: linear-gradient(180deg, rgba(8,16,24,.98), rgba(8,16,24,.94));
    color: var(--ink);
    box-shadow: 0 28px 80px rgba(0, 0, 0, .52);
  }
  dialog.controls-dialog::backdrop {
    background: rgba(2, 7, 11, .72);
    backdrop-filter: blur(2px);
  }
  .controls-sheet {
    padding: 1rem;
  }
  .controls-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: .8rem;
    margin-bottom: .85rem;
  }
  .controls-head h2 {
    margin: 0;
  }
  .controls-close {
    border: 1px solid #2a4a61;
    background: #0f2232;
    color: #d5f1ff;
    padding: .35rem .58rem;
    cursor: pointer;
    font: inherit;
  }
  .controls-grid {
    display: grid;
    gap: .55rem .9rem;
    grid-template-columns: minmax(92px, 132px) 1fr;
    font-size: .86rem;
  }
  .controls-key {
    color: #8be7ff;
  }
  .controls-note {
    margin-top: .9rem;
    color: var(--muted);
    font-size: .78rem;
    line-height: 1.45;
  }
  dialog.help-dialog {
    width: min(780px, calc(100vw - 1.2rem));
    margin: auto;
    border: 1px solid #29425a;
    padding: 0;
    background: linear-gradient(180deg, rgba(8,16,24,.98), rgba(8,16,24,.94));
    color: var(--ink);
    box-shadow: 0 28px 80px rgba(0, 0, 0, .52);
  }
  dialog.help-dialog::backdrop {
    background: rgba(2, 7, 11, .72);
    backdrop-filter: blur(2px);
  }
  .help-sheet { padding: 1rem; }
  .help-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: .8rem;
    margin-bottom: .85rem;
  }
  .help-head h2 { margin: 0; }
  .help-close {
    border: 1px solid #2a4a61;
    background: #0f2232;
    color: #d5f1ff;
    padding: .35rem .58rem;
    cursor: pointer;
    font: inherit;
  }
  .help-grid {
    display: grid;
    grid-template-columns: minmax(120px, 190px) 1fr;
    gap: .45rem .9rem;
    font-size: .84rem;
    margin-bottom: .9rem;
  }
  .help-abbr { color: #8be7ff; }
  .help-section {
    margin: .85rem 0 .35rem;
    color: #d7ebf9;
    font-family: 'Orbitron', sans-serif;
    font-size: .82rem;
    letter-spacing: .07em;
    text-transform: uppercase;
  }
  .help-note {
    color: var(--muted);
    font-size: .78rem;
    line-height: 1.45;
  }
  pre {
    margin: .45rem 0;
    background: #0a131c;
    color: #d5f1ff;
    padding: .9rem;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .spoiler {
    background: #103248;
    color: transparent;
    padding: 0 .28rem;
    cursor: pointer;
    user-select: none;
  }
  .spoiler.revealed { color: #b6ebff; }
  .content-shell { display:grid; gap:1rem; grid-template-columns: 320px minmax(0, 1fr); align-items:start; }
  .left-rail {
    display:grid;
    gap:1rem;
    align-content:start;
    border-right: 1px solid #1c3145;
    padding-right: .9rem;
  }
  .content-shell > .left-rail { grid-column: 1; }
  .content-shell > .map { grid-column: 2; min-width: 0; }
  .grid { display:grid; gap:1rem; grid-template-columns:repeat(12,minmax(0,1fr)); }
  .side-stats { width: 100%; }
  .side-stats h2 {
    margin: 0 0 .65rem;
    font-size: .86rem;
  }
  .mini-kpis { display:grid; gap:.65rem; }
  .mini-kpi {
    padding-bottom: .5rem;
    border-bottom: 1px solid #1c3145;
  }
  .mini-kpi:last-child { border-bottom: none; padding-bottom: 0; }
  .mini-kpi .label { color: var(--muted); font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; }
  .mini-kpi .val { font-family: 'Orbitron', sans-serif; font-size: .95rem; margin-top: .16rem; }
  .panel { background: transparent; border: none; padding: .25rem 0 0 0; }
  .actions { grid-column: span 5; }
  .map { grid-column: span 7; }
  .sessions { grid-column: 1 / -1; }
  h2 {
    margin: 0 0 .8rem;
    font-family: 'Orbitron', sans-serif;
    font-size: .95rem;
    letter-spacing: .08em;
    color: #eaf6ff;
  }
  .bars { display: grid; gap: .55rem; }
  .bar-row { display: grid; grid-template-columns: 120px 1fr 70px; gap: .6rem; align-items: center; }
  .bar-label { color: #cce3f6; font-size: .82rem; }
  .bar-track { background: #0c1620; border: 1px solid #233a50; border-radius: 999px; overflow: hidden; height: 14px; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, var(--hot), #ffb35c); }
  .bar-val { color: #ffd7c9; text-align: right; font-size: .8rem; }
  .toggle-row { display:flex; flex-wrap:wrap; gap:.45rem; margin:0 0 .65rem 0; }
  .chip {
    border: 1px solid transparent;
    color: #b8d4ea;
    background: #0e1a25;
    border-radius: 4px;
    padding: .26rem .62rem;
    font-size: .74rem;
    cursor: pointer;
    user-select: none;
  }
  .chip.active { border-color:#31df95; color:#eafff5; background: rgba(49,223,149,.18); }
  .chip.off { opacity:.45; }
  .canvas-wrap { position: relative; border: none; overflow: hidden; background: #0a131c; }
  canvas { width: 100%; height: 260px; display: block; }
  .map-caption { color: var(--muted); margin-top: .55rem; font-size: .78rem; }
  table { width: 100%; border-collapse: collapse; font-size: .86rem; }
  th, td { text-align: left; padding: .52rem; border-bottom: 1px solid #1e3144; }
  th { color: #a8c5dd; font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; }
  tbody tr:hover { background: rgba(39,211,255,.04); }
  .empty { color: var(--muted); font-size: .88rem; padding: .5rem 0; }
  .hover-tip {
    position: fixed;
    z-index: 10001;
    max-width: min(360px, calc(100vw - 24px));
    padding: .5rem .62rem;
    border: 1px solid #35576f;
    background: rgba(7, 16, 24, .96);
    color: #e8f4ff;
    font-size: .76rem;
    line-height: 1.35;
    pointer-events: none;
    box-shadow: 0 12px 32px rgba(0, 0, 0, .4);
    opacity: 0;
    transform: translateY(4px);
    transition: opacity .08s linear, transform .08s linear;
  }
  .hover-tip.show {
    opacity: 1;
    transform: translateY(0);
  }
  .footer {
    margin-top: 1.2rem;
    border-top: 1px solid #1c3145;
    padding-top: .8rem;
    color: #72879a;
    font-size: .78rem;
  }
  @media (max-width: 980px) {
    .hero-top { flex-direction: column; align-items: center; }
    .content-shell { grid-template-columns: 1fr; }
    .content-shell > .left-rail { grid-column: 1; }
    .content-shell > .map { grid-column: 1; }
    .left-rail { order: 2; }
    .map { order: 1; }
    .side-stats {
      border-top: 1px solid #1c3145;
      padding-top: .8rem;
    }
    .left-rail {
      border-right: none;
      padding-right: 0;
    }
  }
  @media (max-width: 620px) {
    body { padding: .55rem; }
    .crt-overlay { opacity: .18; animation: none; }
    .crt-vignette { opacity: .20; }
    .wrap { padding: .7rem; }
    .hero { padding: .2rem 0 .35rem; }
    .hero-top { gap: .45rem; }
    .toolbar { gap: .45rem; font-size: .78rem; }
    .hero-toolbar { justify-content: center; }
    .cmd-line {
      font-size: .92rem;
      padding: .1rem 0;
    }
    .copy-btn { padding: .42rem .52rem; }
    .copy-status { min-width: 0; }
    .controls-head { align-items: flex-start; }
    .controls-grid { grid-template-columns: 1fr; }
    .bar-row { grid-template-columns: 90px 1fr 56px; }
    canvas { height: 220px; }
    th, td { padding: .4rem .35rem; }
    .sessions > div { overflow-x: auto; }
    .hover-tip { max-width: calc(100vw - 16px); font-size: .72rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .crt-overlay { animation: none; }
  }
</style></head><body>
  <div class="crt-vignette" aria-hidden="true"></div>
  <div class="crt-overlay" aria-hidden="true"></div>
<div class="wrap">
  <section class="hero">
    <div class="hero-top">
      <div>
        <h1>cURL DOOM</h1>
        <div class="sub">Play from terminal, monitor live stats on this page</div>
      </div>
      <div class="toolbar hero-toolbar">
        <button type="button" class="copy-btn" id="copy-cmd-btn">Copy Command</button>
        <button type="button" class="copy-btn secondary" id="open-controls-btn">Controls</button>
        <button type="button" class="copy-btn help" id="open-help-btn">Help</button>
        <button type="button" class="copy-btn secondary" id="open-video-btn">Demo Video</button>
        <span class="copy-status" id="copy-cmd-status"></span>
      </div>
    </div>

    <div class="hero-play">
      <div class="cmd-row">
        <div class="cmd-line-wrap">
          <code class="cmd-line" id="cmd-line"><span class="cmd-strong">Play Now:</span> curl -sL -H "Authorization: Bearer <span class="spoiler" id="token-spoiler" title="Click to reveal">slayer</span>" doom.yolo.omg.lol:666 | bash</code>
        </div>
      </div>
    </div>
  </section>

  <dialog class="controls-dialog" id="controls-dialog">
    <div class="controls-sheet">
      <div class="controls-head">
        <div>
          <h2>Controls</h2>
          <div class="sub">Terminal input mapping for cURL DOOM</div>
        </div>
        <button type="button" class="controls-close" id="close-controls-btn">Close</button>
      </div>
      <div class="controls-grid">
        <div class="controls-key">W A S D</div><div>Move and turn</div>
        <div class="controls-key">Arrow keys</div><div>Alternative movement and turning</div>
        <div class="controls-key">, and .</div><div>Strafe left and right</div>
        <div class="controls-key">F</div><div>Fire</div>
        <div class="controls-key">Space or E</div><div>Use or open door</div>
        <div class="controls-key">Enter</div><div>Confirm menu actions</div>
        <div class="controls-key">Esc</div><div>Open the in-game menu</div>
        <div class="controls-key">Tab</div><div>Toggle automap</div>
        <div class="controls-key">Q</div><div>Quit the curl session</div>
      </div>
      <div class="controls-note">If your terminal does not forward some special keys cleanly, the letter keys are the most reliable path.</div>
    </div>
  </dialog>

  <dialog class="help-dialog" id="help-dialog">
    <div class="help-sheet">
      <div class="help-head">
        <div>
          <h2>Stats Help</h2>
          <div class="sub">Legend for abbreviations and values on this screen</div>
        </div>
        <button type="button" class="help-close" id="close-help-btn">Close</button>
      </div>

      <div class="help-section">Active Players Table</div>
      <div class="help-grid">
        <div class="help-abbr">Session</div><div>Unique server-side session ID for the connected player.</div>
        <div class="help-abbr">IP Hash</div><div>Short anonymized fingerprint of the client IP.</div>
        <div class="help-abbr">Events</div><div>Total input events sent by that player this session.</div>
        <div class="help-abbr">Position (x,y,z)</div><div>Player world coordinates from the current map state.</div>
        <div class="help-abbr">Map</div><div>Map identifier like E1M1 (episode 1, map 1).</div>
        <div class="help-abbr">Health</div><div>Current player health points.</div>
        <div class="help-abbr">Armor</div><div>Current armor points.</div>
        <div class="help-abbr">Secrets</div><div>Secret progress as found/total (percentage).</div>
        <div class="help-abbr">Weapon</div><div>Current active weapon name.</div>
        <div class="help-abbr">Keys/Skulls</div><div>Owned access items shown with short codes (see below).</div>
        <div class="help-abbr">Ammo</div><div>Ammo amounts in this order: clip/shell/cell/misl.</div>
      </div>

      <div class="help-section">Key/Skull Codes</div>
      <div class="help-grid">
        <div class="help-abbr">BC / YC / RC</div><div>Blue card / Yellow card / Red card.</div>
        <div class="help-abbr">BS / YS / RS</div><div>Blue skull / Yellow skull / Red skull.</div>
      </div>

      <div class="help-section">Other Panels</div>
      <div class="help-grid">
        <div class="help-abbr">KPI cards</div><div>Server-level counts and timestamps across all sessions.</div>
        <div class="help-abbr">Action Distribution</div><div>Top input action frequencies during the current server uptime.</div>
        <div class="help-abbr">Live Position Plot</div><div>2D map-space projection of active players on the selected map.</div>
        <div class="help-abbr">Player chips</div><div>Click a player chip to hide/show that player in chart and table.</div>
      </div>

      <div class="help-note">Values refresh every ~5 seconds and represent the latest telemetry received from active sessions.</div>
    </div>
  </dialog>

  <dialog class="video-dialog" id="video-dialog">
    <div class="video-sheet">
      <div class="video-head">
        <div>
          <h2>Demo Video</h2>
          <div class="sub">Quick walkthrough of cURL DOOM in action</div>
        </div>
        <button type="button" class="video-close" id="close-video-btn">Close</button>
      </div>
      <div class="video-frame">
        <iframe
          id="demo-video-frame"
          title="cURL DOOM Demo Video"
          data-src="https://www.youtube-nocookie.com/embed/N5JphX56r5U?autoplay=1&rel=0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"></iframe>
      </div>
    </div>
  </dialog>

  <div class="content-shell">
  <aside class="left-rail">
    <section class="side-stats" aria-labelledby="live-stats-title">
      <h2 id="live-stats-title">Live Stats</h2>
      <div class="mini-kpis" id="kpis">
        <div class="mini-kpi"><div class="label">Sessions</div><div class="val" id="kpi-active">0</div></div>
        <div class="mini-kpi"><div class="label">Total Inputs</div><div class="val" id="kpi-inputs">0</div></div>
        <div class="mini-kpi"><div class="label">Last Update</div><div class="val" id="kpi-now">-</div></div>
      </div>
    </section>

    <section class="panel actions">
      <h2>Action Distribution</h2>
      <div id="action-bars" class="bars"></div>
      <div id="action-empty" class="empty" style="display:none;">No action data yet.</div>
    </section>
  </aside>

    <section class="panel map">
      <h2>Live Player Positions</h2>
      <div id="map-toggle-row" class="toggle-row"></div>
      <div id="player-toggle-row" class="toggle-row"></div>
      <div class="canvas-wrap"><canvas id="pos-canvas" width="820" height="260"></canvas></div>
      <div id="map-caption" class="map-caption">No active player positions yet.</div>
    </section>
  </div>

  <section class="panel sessions">
    <h2>Active Players</h2>
    <div style="overflow:auto;">
      <table>
        <thead><tr><th data-tip="Unique server-side session identifier.">Session</th><th data-tip="Anonymized hash of the client IP address.">IP Hash</th><th data-tip="Count of input events sent in this session.">Events</th><th data-tip="Player world coordinates x, y, z.">Position (x,y,z)</th><th data-tip="Current map label, for example E1M1.">Map</th><th data-tip="Current player health points.">Health</th><th data-tip="Current player armor points.">Armor</th><th data-tip="Secrets found over total and percentage for current map.">Secrets</th><th data-tip="Currently equipped weapon.">Weapon</th><th data-tip="Owned keycards and skull keys. BC/YC/RC and BS/YS/RS.">Keys/Skulls</th><th data-tip="Ammo totals in order: clip/shell/cell/misl.">Ammo</th></tr></thead>
        <tbody id="session-body"></tbody>
      </table>
    </div>
    <div id="session-empty" class="empty" style="display:none;">No active sessions.</div>
  </section>

  <p class="footer">cURL DOOM Mod by <a href="https://github.com/FullByte">FullByte</a> · cURL DOOM by: <a href="https://github.com/xsawyerx/curl-doom">Sawyer X</a> · <a href="https://github.com/ozkl/doomgeneric">doomgeneric</a>: ozkl · DOOM: id Software, 1993 · Version ${APP_VERSION} · <a href="/stats.json">JSON</a> · <span id="updated">updating...</span></p>
</div>
<div id="hover-tip" class="hover-tip" role="tooltip" aria-hidden="true"></div>

<script>
const initialStats = ${initialStatsJson};

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderKpis(data) {
  setText('kpi-started', data.startedAt ? new Date(data.startedAt).toLocaleTimeString() : '-');
  setText('kpi-created', fmtNum(data.sessionsCreated));
  setText('kpi-ended', fmtNum(data.sessionsEnded));
  setText('kpi-active', fmtNum(data.activeSessionCount));
  setText('kpi-inputs', fmtNum(data.totalInputEvents));
  setText('kpi-now', data.now ? new Date(data.now).toLocaleTimeString() : '-');
  setText('updated', 'updated ' + new Date().toLocaleTimeString());
}

function actionMeaning(action) {
  const labels = {
    forward: 'Move forward.',
    backward: 'Move backward.',
    turn_left: 'Turn camera/player left.',
    turn_right: 'Turn camera/player right.',
    strafe_left: 'Move sideways to the left.',
    strafe_right: 'Move sideways to the right.',
    shoot: 'Fire the currently equipped weapon.',
    use: 'Use or interact (doors, switches, etc.).',
    confirm: 'Confirm menu or dialog action.',
    escape: 'Open or close in-game menu.',
    automap: 'Toggle automap view.',
    run: 'Hold run/speed modifier.',
    dialog_yes: 'Answer yes in prompts.',
    dialog_no: 'Answer no in prompts.',
    idle: 'No input sent; idle poll tick.',
    unknown: 'Input action not mapped to a known command.',
  };
  return labels[action] || ('Action: ' + action + '.');
}

function setupHoverTooltips() {
  const tip = document.getElementById('hover-tip');
  if (!tip) return;
  let activeEl = null;
  let hideTimer = null;
  const margin = 14;

  function textFor(el) {
    return el ? el.getAttribute('data-tip') : '';
  }

  function place(x, y) {
    if (!tip.classList.contains('show')) return;
    const rect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x + margin;
    let top = y + margin;
    if (left + rect.width > vw - 8) left = Math.max(8, x - rect.width - margin);
    if (top + rect.height > vh - 8) top = Math.max(8, y - rect.height - margin);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function show(el, x, y) {
    const text = textFor(el);
    if (!text) return;
    activeEl = el;
    tip.textContent = text;
    tip.classList.add('show');
    tip.setAttribute('aria-hidden', 'false');
    place(x, y);
  }

  function hide() {
    activeEl = null;
    tip.classList.remove('show');
    tip.setAttribute('aria-hidden', 'true');
  }

  document.addEventListener('pointerover', function (event) {
    const el = event.target.closest('[data-tip]');
    if (!el) return;
    clearTimeout(hideTimer);
    show(el, event.clientX, event.clientY);
  });

  document.addEventListener('pointermove', function (event) {
    if (!activeEl) return;
    place(event.clientX, event.clientY);
  });

  document.addEventListener('pointerout', function (event) {
    if (!activeEl) return;
    const next = event.relatedTarget;
    if (next && activeEl.contains(next)) return;
    hide();
  });

  document.addEventListener('focusin', function (event) {
    const el = event.target.closest('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, r.right, r.bottom);
  });

  document.addEventListener('focusout', function (event) {
    const el = event.target.closest('[data-tip]');
    if (el === activeEl) hide();
  });

  document.addEventListener('touchstart', function (event) {
    const el = event.target.closest('[data-tip]');
    if (!el) {
      hide();
      return;
    }
    const t = event.touches && event.touches[0];
    if (!t) return;
    show(el, t.clientX, t.clientY);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 2400);
  }, { passive: true });

  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('resize', hide);
}

function renderActionBars(data) {
  const container = document.getElementById('action-bars');
  const empty = document.getElementById('action-empty');
  container.innerHTML = '';
  const rows = (data.actionTotals || []).slice(0, 8);
  if (!rows.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  const max = Math.max(...rows.map(r => r.count || 0), 1);
  for (const row of rows) {
    const pct = Math.max(4, Math.round(((row.count || 0) / max) * 100));
    const item = document.createElement('div');
    item.className = 'bar-row';
    item.setAttribute('data-tip', actionMeaning(row.action));
    item.innerHTML = '<div class="bar-label">' + row.action + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="bar-val">' + fmtNum(row.count) + '</div>';
    const label = item.querySelector('.bar-label');
    if (label) label.setAttribute('data-tip', actionMeaning(row.action));
    container.appendChild(item);
  }
}

let selectedMapName = null;
const hiddenPlayers = new Set();

function mapLabelOfSession(s) {
  if (s.mapName) return s.mapName;
  const st = s.latestState || {};
  if (typeof st.episode === 'number' && typeof st.map === 'number') {
    return 'E' + st.episode + 'M' + st.map;
  }
  return 'unknown';
}

function keysOwnedLabel(st) {
  const keys = [];
  if (st.key_blue_card) keys.push('BC');
  if (st.key_yellow_card) keys.push('YC');
  if (st.key_red_card) keys.push('RC');
  if (st.key_blue_skull) keys.push('BS');
  if (st.key_yellow_skull) keys.push('YS');
  if (st.key_red_skull) keys.push('RS');
  return keys.length ? keys.join(' ') : '-';
}

function syncMapSelection(data) {
  const maps = [...new Set((data.activeSessions || []).map(mapLabelOfSession))].filter(Boolean);
  if (!maps.length) {
    selectedMapName = null;
    return maps;
  }
  if (!selectedMapName || !maps.includes(selectedMapName)) {
    selectedMapName = maps[0];
  }
  return maps;
}

function renderMapToggles(data) {
  const maps = syncMapSelection(data);
  const row = document.getElementById('map-toggle-row');
  row.innerHTML = '';
  if (!maps.length) return;
  for (const mapName of maps) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (mapName === selectedMapName ? ' active' : '');
    btn.textContent = mapName;
    btn.addEventListener('click', () => {
      selectedMapName = mapName;
      render(data);
    });
    row.appendChild(btn);
  }
}

function renderPlayerToggles(data) {
  const row = document.getElementById('player-toggle-row');
  row.innerHTML = '';
  const sessions = (data.activeSessions || []).filter(s => mapLabelOfSession(s) === selectedMapName);
  for (const s of sessions) {
    const hidden = hiddenPlayers.has(s.sessionId);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (hidden ? ' off' : ' active');
    btn.textContent = s.sessionId.slice(0, 8);
    btn.addEventListener('click', () => {
      if (hiddenPlayers.has(s.sessionId)) hiddenPlayers.delete(s.sessionId);
      else hiddenPlayers.add(s.sessionId);
      drawPositions(data);
      renderSessions(data);
      renderPlayerToggles(data);
    });
    row.appendChild(btn);
  }
}

function drawPositions(data) {
  const canvas = document.getElementById('pos-canvas');
  const cap = document.getElementById('map-caption');
  const ctx = canvas.getContext('2d');
  const filteredSessions = (data.activeSessions || [])
    .filter(s => mapLabelOfSession(s) === selectedMapName)
    .filter(s => !hiddenPlayers.has(s.sessionId));

  const points = filteredSessions
    .map(s => {
      const st = s.latestState || {};
      if (typeof st.x !== 'number' || typeof st.y !== 'number') return null;
      return { x: st.x, y: st.y, sid: s.sessionId, mapName: mapLabelOfSession(s) };
    })
    .filter(Boolean);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0a131c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#1f3446';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const y = (canvas.height / 6) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  for (let i = 1; i < 8; i++) {
    const x = (canvas.width / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }

  if (!selectedMapName) {
    cap.textContent = 'No active map.';
    return;
  }

  const geometry = data.mapGeometries ? data.mapGeometries[selectedMapName] : null;
  let minX;
  let maxX;
  let minY;
  let maxY;
  if (geometry && geometry.bbox) {
    ({ minX, maxX, minY, maxY } = geometry.bbox);
  } else if (points.length) {
    minX = Math.min(...points.map(p => p.x));
    maxX = Math.max(...points.map(p => p.x));
    minY = Math.min(...points.map(p => p.y));
    maxY = Math.max(...points.map(p => p.y));
  } else {
    cap.textContent = 'Map ' + selectedMapName + ': no visible players.';
    return;
  }

  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const pad = 20;
  const toCanvas = (x, y) => {
    const px = pad + ((x - minX) / spanX) * (canvas.width - pad * 2);
    const py = pad + ((y - minY) / spanY) * (canvas.height - pad * 2);
    return [px, canvas.height - py];
  };

  if (geometry && geometry.lines && geometry.lines.length) {
    ctx.strokeStyle = '#21465f';
    ctx.lineWidth = 1;
    for (const ln of geometry.lines) {
      const [x1, y1, x2, y2] = ln;
      const [sx1, sy1] = toCanvas(x1, y1);
      const [sx2, sy2] = toCanvas(x2, y2);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  }

  for (const p of points) {
    const [px, yFlip] = toCanvas(p.x, p.y);
    ctx.beginPath();
    ctx.arc(px, yFlip, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#31df95';
    ctx.fill();
    ctx.strokeStyle = '#073627';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#b8f5d8';
    ctx.font = '11px JetBrains Mono';
    ctx.fillText(p.sid.slice(0, 6), px + 8, yFlip - 8);
  }

  if (geometry && geometry.source) {
    cap.textContent = 'Map ' + selectedMapName + ' overlay from ' + geometry.source + '; visible players: ' + points.length + '.';
  } else {
    cap.textContent = 'Map ' + selectedMapName + ' without geometry overlay; visible players: ' + points.length + '.';
  }
}

function renderSessions(data) {
  const body = document.getElementById('session-body');
  const empty = document.getElementById('session-empty');
  body.innerHTML = '';
  const sessions = (data.activeSessions || [])
    .filter(s => mapLabelOfSession(s) === selectedMapName)
    .filter(s => !hiddenPlayers.has(s.sessionId));
  if (!sessions.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  for (const s of sessions) {
    const st = s.latestState || {};
    const pos = (typeof st.x === 'number' && typeof st.y === 'number' && typeof st.z === 'number')
      ? (st.x.toFixed(2) + ', ' + st.y.toFixed(2) + ', ' + st.z.toFixed(2))
      : '-';
    const secretPct = (typeof st.secret_pct === 'number') ? st.secret_pct.toFixed(1) : '0.0';
    const secrets = (typeof st.secret_count === 'number' && typeof st.secret_total === 'number')
      ? (st.secret_count + '/' + st.secret_total + ' (' + secretPct + '%)')
      : '-';
    const weapon = st.weapon || (typeof st.weapon_id === 'number' ? ('#' + st.weapon_id) : '-');
    const keysOwned = keysOwnedLabel(st);
    const ammo = [st.ammo_clip, st.ammo_shell, st.ammo_cell, st.ammo_misl]
      .filter(v => typeof v === 'number')
      .join('/');
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td data-tip="Unique server-side session identifier.">' + s.sessionId + '</td>' +
      '<td data-tip="Anonymized hash of the client IP address.">' + s.ipHash + '</td>' +
      '<td data-tip="Count of input events sent in this session.">' + fmtNum(s.events) + '</td>' +
      '<td data-tip="Player world coordinates x, y, z.">' + pos + '</td>' +
      '<td data-tip="Current map label, for example E1M1.">' + mapLabelOfSession(s) + '</td>' +
      '<td data-tip="Current player health points.">' + (st.health ?? '-') + '</td>' +
      '<td data-tip="Current player armor points.">' + (st.armor ?? '-') + '</td>' +
      '<td data-tip="Secrets found over total and percentage for current map.">' + secrets + '</td>' +
      '<td data-tip="Currently equipped weapon.">' + weapon + '</td>' +
      '<td data-tip="Owned keycards and skull keys. BC/YC/RC and BS/YS/RS.">' + keysOwned + '</td>' +
      '<td data-tip="Ammo totals in order: clip/shell/cell/misl.">' + (ammo || '-') + '</td>';
    body.appendChild(tr);
  }
}

function render(data) {
  renderMapToggles(data);
  renderPlayerToggles(data);
  renderKpis(data);
  renderActionBars(data);
  drawPositions(data);
  renderSessions(data);
}

async function refresh() {
  try {
    const res = await fetch('/stats.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    render(data);
  } catch (err) {
    setText('updated', 'update failed: ' + err.message);
  }
}

  function buildPlayCommand() {
    var tokenEl = document.getElementById('token-spoiler');
    var token = tokenEl ? tokenEl.textContent.trim() : '';
    return 'curl -sL -H "Authorization: Bearer ' + token + '" doom.yolo.omg.lol:666 | bash';
  }

  (function () {
    var tokenEl = document.getElementById('token-spoiler');
    var copyBtn = document.getElementById('copy-cmd-btn');
    var statusEl = document.getElementById('copy-cmd-status');
    var controlsBtn = document.getElementById('open-controls-btn');
    var controlsDialog = document.getElementById('controls-dialog');
    var closeControlsBtn = document.getElementById('close-controls-btn');
    var helpBtn = document.getElementById('open-help-btn');
    var helpDialog = document.getElementById('help-dialog');
    var closeHelpBtn = document.getElementById('close-help-btn');
    var videoBtn = document.getElementById('open-video-btn');
    var videoDialog = document.getElementById('video-dialog');
    var closeVideoBtn = document.getElementById('close-video-btn');
    var videoFrame = document.getElementById('demo-video-frame');

    setupHoverTooltips();

    function openControls() {
      if (!controlsDialog) return;
      if (typeof controlsDialog.showModal === 'function') controlsDialog.showModal();
      else controlsDialog.setAttribute('open', 'open');
    }

    function closeControls() {
      if (!controlsDialog) return;
      if (typeof controlsDialog.close === 'function') controlsDialog.close();
      else controlsDialog.removeAttribute('open');
    }

    function openHelp() {
      if (!helpDialog) return;
      if (typeof helpDialog.showModal === 'function') helpDialog.showModal();
      else helpDialog.setAttribute('open', 'open');
    }

    function closeHelp() {
      if (!helpDialog) return;
      if (typeof helpDialog.close === 'function') helpDialog.close();
      else helpDialog.removeAttribute('open');
    }

    function openVideo() {
      if (!videoDialog) return;
      if (videoFrame && !videoFrame.getAttribute('src')) {
        videoFrame.setAttribute('src', videoFrame.getAttribute('data-src') || '');
      }
      if (typeof videoDialog.showModal === 'function') videoDialog.showModal();
      else videoDialog.setAttribute('open', 'open');
    }

    function closeVideo() {
      if (!videoDialog) return;
      if (typeof videoDialog.close === 'function') videoDialog.close();
      else videoDialog.removeAttribute('open');
      if (videoFrame) videoFrame.setAttribute('src', '');
    }

    if (tokenEl) {
      tokenEl.addEventListener('click', function () {
        tokenEl.classList.toggle('revealed');
      });
    }

    if (controlsBtn) {
      controlsBtn.addEventListener('click', openControls);
    }

    if (closeControlsBtn) {
      closeControlsBtn.addEventListener('click', closeControls);
    }

    if (helpBtn) {
      helpBtn.addEventListener('click', openHelp);
    }

    if (closeHelpBtn) {
      closeHelpBtn.addEventListener('click', closeHelp);
    }

    if (videoBtn) {
      videoBtn.addEventListener('click', openVideo);
    }

    if (closeVideoBtn) {
      closeVideoBtn.addEventListener('click', closeVideo);
    }

    if (controlsDialog) {
      controlsDialog.addEventListener('click', function (event) {
        var rect = controlsDialog.getBoundingClientRect();
        var inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (!inside) closeControls();
      });
    }

    if (helpDialog) {
      helpDialog.addEventListener('click', function (event) {
        var rect = helpDialog.getBoundingClientRect();
        var inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (!inside) closeHelp();
      });
    }

    if (videoDialog) {
      videoDialog.addEventListener('click', function (event) {
        var rect = videoDialog.getBoundingClientRect();
        var inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (!inside) closeVideo();
      });
      videoDialog.addEventListener('close', function () {
        if (videoFrame) videoFrame.setAttribute('src', '');
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async function () {
        try {
          await navigator.clipboard.writeText(buildPlayCommand());
          if (statusEl) statusEl.textContent = 'Copied';
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Failed';
        }
        if (statusEl) {
          setTimeout(function () { statusEl.textContent = ''; }, 1400);
        }
      });
    }
  })();

render(initialStats);
setInterval(refresh, 5000);
</script>
</body></html>`);
});

// POST /play for bidirectional streaming. Read keystrokes from the request
// body, stream ANSI frames out as the response body. The pure-curl path:
//
//   curl -sN -X POST -T - "$SERVER/play?cols=200&rows=60" < /dev/tty
//
// Doom runs at ~35Hz on its own (no client poll loop). Keys are released
// 150ms after the last byte for that key, so holding W moves you smoothly.
app.post('/play', sessionLimiter, async (req, res) => {
  const { cols, rows } = parseDims(req);
  let session;
  try {
    session = createSession(getClientIp(req));
  } catch (err) {
    res.status(500).send(`Failed to start doom: ${err.message}\n`);
    return;
  }

  // Disable Nagle so each frame leaves the kernel as one packet instead of
  // getting batched with the next, terminal emulators read the pty in
  // chunks, and batching makes the partial-frame problem visibly worse.
  try { req.socket.setNoDelay(true); } catch {}

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // One-time clear so the first frame lands on a blank screen. Subsequent
  // frames overwrite in place via cursor-home (see frameToAnsi).
  res.write(CLEAR);

  // Frame pacing. Doom-native is ~35 Hz, but a single ANSI frame at
  // 200x60 is roughly 300 KB; at 35 Hz that's ~10 MB/s of escape
  // sequences, which most terminal emulators can't render in real time.
  // 15 Hz is the smoothest default that "just works" across terminals
  // (Apple Terminal, iTerm, Ghostty, kitty); pass ?fps=N (5..35) to
  // override. Combined with the cursor-home trick, even when frames tear
  // the result is a partially-updated frame instead of a blank one.
  const fpsRaw = parseInt(req.query.fps, 10);
  const fps = Number.isFinite(fpsRaw) ? Math.max(5, Math.min(35, fpsRaw)) : 15;
  const FRAME_MS = Math.round(1000 / fps);

  let closed = false;
  const heldTimers = new Map(); // doomKey -> timeoutId

  // Detect client disconnect via the underlying TCP socket. We can NOT use
  // req.on('close') here: in modern Node it fires when the request body's
  // Readable stream ends, which for `curl -T -` with no stdin data is
  // basically instantaneous and would tear the session down before we
  // ever wrote a frame. The TCP socket's 'close' event only fires on real
  // connection termination.
  const onClientGone = () => close('client disconnect');
  req.socket.once('close', onClientGone);

  const close = (reason) => {
    if (closed) return;
    closed = true;
    req.socket.removeListener('close', onClientGone);
    for (const t of heldTimers.values()) clearTimeout(t);
    heldTimers.clear();
    destroySession(session, reason || 'play closed');
    try { res.end(); } catch {}
  };
  req.on('error', () => close('req error'));
  res.on('error', () => close('res error'));

  // held-key state
  // Each pressed key gets a 150ms release timer; new bytes for the same
  // key reset the timer. Doom sees one K 1 ... K 0 cycle per "press".
  const RELEASE_MS = 150;
  function pressKey(doomKey) {
    if (closed || session.dead) return;
    recordInputEvent(session, {
      source: 'play',
      action: actionFromKeys(null, doomKey),
      rawKey: null,
      doomKey,
      tickMs: null,
    });
    const existing = heldTimers.get(doomKey);
    if (existing) {
      clearTimeout(existing);
    } else {
      try { writeCmd(session, `K 1 ${doomKey}`); } catch { return; }
    }
    const t = setTimeout(() => {
      heldTimers.delete(doomKey);
      try { writeCmd(session, `K 0 ${doomKey}`); } catch {}
    }, RELEASE_MS);
    heldTimers.set(doomKey, t);
  }

  // byte parser
  // Two-byte ESC[A/B/C/D for arrows, bare ESC = menu. Across-chunk safe
  // because escState/escTimer are closed over by req's data handler.
  let escState = 0; // 0=normal, 1=after ESC, 2=after ESC[
  let escTimer = null;

  function clearEscTimer() {
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
  }
  function flushBareEsc() {
    clearEscTimer();
    if (escState === 1) pressKey(K.ESCAPE);
    escState = 0;
  }

  function feedByte(b) {
    if (escState === 1) {
      clearEscTimer();
      if (b === 0x5b /* '[' */) {
        escState = 2;
        escTimer = setTimeout(() => { escState = 0; escTimer = null; }, 100);
        return;
      }
      // Bare ESC followed by something else: emit ESC, then process the byte.
      pressKey(K.ESCAPE);
      escState = 0;
      // fall through and process this byte normally
    } else if (escState === 2) {
      clearEscTimer();
      escState = 0;
      switch (b) {
        case 0x41: return pressKey(K.UP);    // A
        case 0x42: return pressKey(K.DOWN);  // B
        case 0x43: return pressKey(K.RIGHT); // C
        case 0x44: return pressKey(K.LEFT);  // D
        default: return;
      }
    }

    if (b === 0x1b /* ESC */) {
      escState = 1;
      escTimer = setTimeout(flushBareEsc, 80);
      return;
    }
    // Quit bytes: 'q', 'Q', Ctrl-C, Ctrl-D.
    if (b === 0x71 || b === 0x51 || b === 0x03 || b === 0x04) {
      close('quit byte');
      return;
    }
    if (b === 0x0a || b === 0x0d) return pressKey(K.ENTER);
    if (b === 0x09) return pressKey(K.TAB);

    const ch = String.fromCharCode(b);
    if (ch in KEYMAP) {
      const dk = KEYMAP[ch];
      if (dk != null) pressKey(dk);
    }
  }

  req.on('data', chunk => {
    for (const b of chunk) feedByte(b);
  });

  // tic loop
  // Drives doom forward one tic at a time, streaming each frame to the
  // client. The C side has already done 140 warmup tics by the time it
  // hits its read-loop, so the very first frame we ask for here is a
  // real in-game scene.
  try {
    while (!closed && !session.dead) {
      try {
        writeCmd(session, 'T 1');
        writeCmd(session, 'S');
      } catch { break; }
      let fb;
      try {
        fb = await requestFrame(session);
      } catch { break; }
      if (closed) break;

      session.lastActive = Date.now();
      const ansi = frameToAnsi(fb, cols, rows);
      const ok = res.write(ansi);
      if (!ok) {
        // Backpressure: wait for the socket to drain before queueing more.
        await new Promise(resolve => {
          const onDrain = () => { res.off('close', onClose); resolve(); };
          const onClose = () => { res.off('drain', onDrain); resolve(); };
          res.once('drain', onDrain);
          res.once('close', onClose);
        });
      }
      await sleep(FRAME_MS);
    }
  } finally {
    close('play loop exit');
  }
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.listen(PORT, () => {
  console.log(`cURL DOOM running on http://localhost:${PORT}`);
  console.log(`doom binary: ${DOOM_BIN}`);
  console.log(`IWAD:        ${IWAD_PATH}`);
  console.log(`PWADs:       ${PWAD_PATHS.length > 0 ? PWAD_PATHS.join(', ') : '(none)'}`);
  console.log(`warp/skill:  E${WARP_EPISODE}M${WARP_MAP} skill ${DOOM_SKILL}`);
  console.log(`Play with:   curl -sL http://localhost:${PORT} | bash`);
  console.log(`         or: ./doom.sh`);
});

// Start HTTPS server if TLS certs are present.
try {
  if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
    const tlsOpts = {
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY),
    };
    https.createServer(tlsOpts, app).listen(TLS_PORT, () => {
      console.log(`cURL DOOM (HTTPS) running on https://localhost:${TLS_PORT}`);
    });
  }
} catch (err) {
  console.error(`HTTPS disabled: ${err.message}`);
}
