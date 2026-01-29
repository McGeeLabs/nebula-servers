#!/usr/bin/env node
'use strict';

/**
 * Nebula Servers - backend poller v0.1
 * - Reads ../frontend/servers.config.json
 * - Checks each service/game server
 * - Writes ../frontend/servers.status.json
 *
 * Minimal deps: none
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');
const os = require('os');

// ---------------------------
// Paths
// ---------------------------
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const CONFIG_PATH = path.join(FRONTEND_DIR, 'servers.config.json');
const STATUS_PATH = path.join(FRONTEND_DIR, 'servers.status.json');

// ---------------------------
// Tunables
// ---------------------------
const DEFAULT_TIMEOUT_MS = 3500;
const CONCURRENCY = 10; // keep it polite; increase later if needed

// ---------------------------
// Utilities
// ---------------------------
function isEnabled(server) {
  const v = server?.enabled;

  // default: enabled if missing
  if (v === undefined || v === null) return true;

  // accept common "false" representations
  if (v === false) return false;
  if (typeof v === "string" && v.toLowerCase() === "false") return false;
  if (typeof v === "number" && v === 0) return false;

  return true;
}

function shouldSkipPoll(server) {
  // 0.0.0.0 means “bind all interfaces”, not a real reachable target.
  // In your config it also indicates “placeholder / offline display”.
  const host = server.ip || server.host;
  if (host === '0.0.0.0') return true;

  // If it has neither url nor (host+port), we cannot poll it.
  const hasUrl = typeof server.url === 'string' && server.url.startsWith('http');
  const { host: h, port: p } = pickHostPort(server);
  const hasHostPort = !!h && Number.isFinite(p) && p > 0;

  return !(hasUrl || hasHostPort);
}

function nowIso() {
  return new Date().toISOString();
}

function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function readJsonIfExists(filePath, fallbackValue) {
  try {
    const buf = await fsp.readFile(filePath);
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return fallbackValue;
    // If JSON parse fails, surface it (better than silently nuking status)
    throw err;
  }
}

async function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpName = `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  const json = JSON.stringify(data, null, 2) + '\n';
  await fsp.writeFile(tmpPath, json, 'utf8');
  await fsp.rename(tmpPath, filePath);
}

function normalizeStatusArray(maybe) {
  // Frontend merges by id. We’ll store an array of status objects:
  // [{ id, online, players?, version?, lastCheckAt }]
  if (Array.isArray(maybe)) return maybe;
  return [];
}

function makeStatusIndex(statusArr) {
  const map = new Map();
  for (const item of statusArr) {
    if (item && typeof item.id === 'string') map.set(item.id, item);
  }
  return map;
}

function pickHostPort(server) {
  // If ip/host missing but a port exists, assume local service
  const host = server.ip || server.host || (server.port ? '127.0.0.1' : undefined);
  const port = server.port !== undefined ? Number(server.port) : undefined;
  return { host, port };
}


// Simple promise pool for concurrency
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let i = 0;

  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await mapper(items[idx], idx);
      } catch (err) {
        results[idx] = { __error: err };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

// ---------------------------
// Checkers
// ---------------------------

async function checkTcp({ host, port, timeoutMs }) {
  const start = Date.now();
  const online = await withTimeout(
    new Promise((resolve) => {
      const socket = new net.Socket();

      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };

      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));

      socket.setTimeout(timeoutMs);
      socket.connect(port, host);
    }),
    timeoutMs + 250,
    'tcp-check-timeout'
  );

  return {
    online,
    rttMs: Date.now() - start,
  };
}

async function checkHttp({ url, timeoutMs }) {
  const start = Date.now();
  try {
    const res = await withTimeout(
      fetch(url, {
        method: 'GET',
        redirect: 'follow',
      }),
      timeoutMs,
      'http-timeout'
    );

    // Consider 2xx/3xx as online
    const online = res.status >= 200 && res.status < 400;

    return {
      online,
      rttMs: Date.now() - start,
      // version: could be parsed later from headers/body if you want
    };
  } catch {
    return { online: false, rttMs: Date.now() - start };
  }
}

/**
 * Minecraft "Server List Ping" (Java Edition) without deps.
 * Returns:
 * - online boolean
 * - players { online, max } (optional)
 * - version string (optional)
 *
 * Protocol notes:
 * - Handshake (packet 0x00) then Status Request (0x00)
 * - Read Status Response (0x00) which contains JSON string
 */
function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  while (true) {
    if ((v & 0xffffff80) === 0) {
      bytes.push(v);
      return Buffer.from(bytes);
    }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
}

function readVarInt(buf, offset = 0) {
  let numRead = 0;
  let result = 0;
  let byte = 0;

  do {
    if (offset + numRead >= buf.length) return null;
    byte = buf[offset + numRead];
    result |= (byte & 0x7f) << (7 * numRead);
    numRead++;
    if (numRead > 5) return null;
  } while ((byte & 0x80) !== 0);

  return { value: result, size: numRead };
}

function writeString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
}

function buildMcHandshakePacket({ host, port, protocolVersion = 758 /* 1.18.2+-ish */ }) {
  // protocolVersion can be whatever; most servers accept unknown-ish values for status ping
  const packetId = writeVarInt(0x00);
  const pv = writeVarInt(protocolVersion);
  const hostStr = writeString(host);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  const nextState = writeVarInt(0x01); // status

  const data = Buffer.concat([packetId, pv, hostStr, portBuf, nextState]);
  return Buffer.concat([writeVarInt(data.length), data]);
}

function buildMcStatusRequestPacket() {
  const packetId = writeVarInt(0x00);
  const data = packetId;
  return Buffer.concat([writeVarInt(data.length), data]);
}

async function checkMinecraft({ host, port, timeoutMs }) {
  const start = Date.now();

  return withTimeout(
    new Promise((resolve) => {
      const socket = new net.Socket();
      const chunks = [];

      const finish = (result) => {
        socket.destroy();
        resolve({
          ...result,
          rttMs: Date.now() - start,
        });
      };

      socket.once('error', () => finish({ online: false }));
      socket.setTimeout(timeoutMs, () => finish({ online: false }));

      socket.connect(port, host, () => {
        try {
          socket.write(buildMcHandshakePacket({ host, port }));
          socket.write(buildMcStatusRequestPacket());
        } catch {
          finish({ online: false });
        }
      });

      socket.on('data', (d) => chunks.push(d));
      socket.on('close', () => {
        // Try parse whatever we got
        try {
          const buf = Buffer.concat(chunks);
          // packet length varint
          const lenInfo = readVarInt(buf, 0);
          if (!lenInfo) return finish({ online: false });

          let offset = lenInfo.size;
          const packetIdInfo = readVarInt(buf, offset);
          if (!packetIdInfo) return finish({ online: false });

          offset += packetIdInfo.size;
          const packetId = packetIdInfo.value;
          if (packetId !== 0x00) return finish({ online: false });

          const jsonLenInfo = readVarInt(buf, offset);
          if (!jsonLenInfo) return finish({ online: false });

          offset += jsonLenInfo.size;
          const jsonLen = jsonLenInfo.value;
          const jsonStr = buf.slice(offset, offset + jsonLen).toString('utf8');

          const parsed = JSON.parse(jsonStr);

          const playersOnline = parsed?.players?.online;
          const playersMax = parsed?.players?.max;
          const versionName = parsed?.version?.name;

          const out = { online: true };
          if (Number.isFinite(playersOnline) && Number.isFinite(playersMax)) {
            out.players = { online: playersOnline, max: playersMax };
          }
          if (typeof versionName === 'string') {
            out.version = versionName;
          }

          return finish(out);
        } catch {
          return finish({ online: false });
        }
      });
    }),
    timeoutMs + 250,
    'minecraft-timeout'
  );
}

// ---------------------------
// Checker routing
// ---------------------------
function chooseChecker(server) {
  // Prefer URL-based checks if provided
  if (typeof server.url === 'string' && server.url.startsWith('http')) return 'http';

  // Otherwise, if we have host+port (or port with localhost default), do TCP
  const { host, port } = pickHostPort(server);
  if (host && Number.isFinite(port) && port > 0) return 'tcp';

  // No valid target
  return 'none';
}

async function runCheck(server) {
  const timeoutMs =
    Number(server.timeoutMs) > 0 ? Number(server.timeoutMs) : DEFAULT_TIMEOUT_MS;

  if (!isEnabled(server)) {
    return {
      online: false,
      disabled: true
    };
  }

  if (shouldSkipPoll(server)) {
    return {
      online: false,
      skipped: true
    };
  }

  const checker = chooseChecker(server);

  if (checker === "http") {
    return checkHttp({ url: server.url, timeoutMs });
  }

  if (checker === "tcp") {
    const { host, port } = pickHostPort(server);
    return checkTcp({ host, port, timeoutMs });
  }

  return { online: false };
}

// ---------------------------
// Main
// ---------------------------
async function runOnce() {
  await main();
}

async function runWatch() {
  // Run immediately, then repeat
  await runOnce();
  setInterval(runOnce, DEFAULT_INTERVAL_MS);
}

const DEFAULT_INTERVAL_MS = 60000; // 1 minute

// ---------------------------
// Entry point
// ---------------------------

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch") || args.has("-w");

(watch ? runWatch() : runOnce()).catch((err) => {
  console.error("[poller] Fatal error:", err);
  process.exitCode = 1;
});

async function main() {
  const config = await readJsonIfExists(CONFIG_PATH, null);
  if (!config) {
    console.error(`[poller] Missing config file: ${CONFIG_PATH}`);
    process.exitCode = 2;
    return;
  }

  if (!Array.isArray(config)) {
    console.error('[poller] servers.config.json must be an array of server objects.');
    process.exitCode = 2;
    return;
  }

  const disabled = config.filter(s => !isEnabled(s)).map(s => s.id);

  const existingStatusRaw = await readJsonIfExists(STATUS_PATH, []);
  const existingStatus = normalizeStatusArray(existingStatusRaw);
  const statusIndex = makeStatusIndex(existingStatus);

  const checkedAt = nowIso();

  const results = await mapWithConcurrency(config, CONCURRENCY, async (server) => {
    const id = server.id;
    const base = statusIndex.get(id) || { id };

    // Guard: id is required for merge
    if (typeof id !== 'string' || !id.trim()) {
      return null; // skip invalid
    }

    const result = await runCheck(server);

    // Only keep allowed/expected fields: online, players (optional), version (optional), lastCheckAt
    const next = {
      ...base,
      id,
      online: Boolean(result.online),
      lastCheckAt: checkedAt,
    };

    if (result.players !== undefined) next.players = result.players;
    else delete next.players;

    if (result.version !== undefined) next.version = result.version;
    else delete next.version;

    return next;
  });

  const nextStatus = {};
    for (const item of results) {
    if (!item || !item.id) continue;

    // only write status fields (don’t duplicate config)
    const { id, online, lastCheckAt, players, version } = item;
    nextStatus[id] = { online, lastCheckAt };

    if (players !== undefined) nextStatus[id].players = players;
    if (version !== undefined) nextStatus[id].version = version;
    }

    // Optional: keep statuses for servers removed from config?
    // For v0.1, we’ll only output what’s in config (clean & predictable).
    await atomicWriteJson(STATUS_PATH, nextStatus);

    const total = config.length;
    const disabledCount = config.filter(s => !isEnabled(s)).length;
    const writtenCount = Object.keys(nextStatus).length;

    console.log(
    `[poller] Disabled in config: ${disabledCount ? config.filter(s => !isEnabled(s)).map(s => s.id).join(", ") : "none"}`
    );
    console.log(
    `[poller] Checked ${total - disabledCount}/${total} enabled servers @ ${checkedAt} (wrote ${writtenCount})`
    );
}

main().catch((err) => {
  console.error('[poller] Fatal error:', err);
  process.exitCode = 1;
});
