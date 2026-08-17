import express from 'express';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const PORT = integerEnv('PORT', 3000, 1);
const CHECK_INTERVAL_SECONDS = integerEnv('CHECK_INTERVAL_SECONDS', 60, 10);
const SUBSCRIPTION_REFRESH_SECONDS = integerEnv('SUBSCRIPTION_REFRESH_SECONDS', 300, 30);
const CONNECT_TIMEOUT_MS = integerEnv('CONNECT_TIMEOUT_MS', 4000, 500);
const SUBSCRIPTION_URL = process.env.SUBSCRIPTION_URL?.trim();
const DATABASE_PATH = process.env.DATABASE_PATH || './data/monitor.db';

mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL REFERENCES servers(id),
    checked_at TEXT NOT NULL,
    online INTEGER NOT NULL,
    latency_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS checks_server_time ON checks(server_id, checked_at DESC);
  CREATE TABLE IF NOT EXISTS monitor_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const statements = {
  stateGet: db.prepare('SELECT value FROM monitor_state WHERE key = ?'),
  stateSet: db.prepare(`INSERT INTO monitor_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  upsertServer: db.prepare(`INSERT INTO servers (id, name, protocol, host, port, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, protocol = excluded.protocol,
      host = excluded.host, port = excluded.port, active = 1, updated_at = excluded.updated_at`),
  markInactive: db.prepare('UPDATE servers SET active = 0, updated_at = ? WHERE id NOT IN (SELECT value FROM json_each(?))'),
  activeServers: db.prepare('SELECT * FROM servers WHERE active = 1 ORDER BY name COLLATE NOCASE'),
  insertCheck: db.prepare('INSERT INTO checks (server_id, checked_at, online, latency_ms) VALUES (?, ?, ?, ?)')
};

function integerEnv(name, fallback, min) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function now() { return new Date().toISOString(); }

function setState(key, value) { statements.stateSet.run(key, value); }
function getState(key) { return statements.stateGet.get(key)?.value ?? null; }

function decodeSubscription(body) {
  const cleaned = body.trim().replace(/\s/g, '');
  if (!cleaned) return '';
  try {
    const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
    return /(?:vless|vmess|trojan|ss):\/\//i.test(decoded) ? decoded : body;
  } catch {
    return body;
  }
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function humanName(value, fallback) {
  try { return decodeURIComponent(value || '').trim() || fallback; } catch { return fallback; }
}

function parseUri(raw) {
  const line = raw.trim();
  if (!line || !/^(vless|vmess|trojan|ss):\/\//i.test(line)) return null;
  const protocol = line.slice(0, line.indexOf('://')).toLowerCase();

  if (protocol === 'vmess' && !line.slice(8).includes('@')) {
    try {
      const config = JSON.parse(decodeBase64Url(line.slice(8).split('#')[0]));
      const host = config.add;
      const port = Number.parseInt(config.port, 10);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      const name = humanName(config.ps, `${host}:${port}`);
      return makeServer(protocol, host, port, name);
    } catch { return null; }
  }

  try {
    const url = new URL(line);
    const host = url.hostname;
    const port = Number.parseInt(url.port, 10);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return makeServer(protocol, host, port, humanName(url.hash.slice(1), `${host}:${port}`));
  } catch {
    return null;
  }
}

function makeServer(protocol, host, port, name) {
  const id = Buffer.from(`${protocol}\u0000${host.toLowerCase()}\u0000${port}\u0000${name}`).toString('base64url');
  return { id, protocol, host, port, name };
}

async function refreshSubscription() {
  if (!SUBSCRIPTION_URL) throw new Error('SUBSCRIPTION_URL is not set');
  const response = await fetch(SUBSCRIPTION_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Subscription returned HTTP ${response.status}`);
  const parsed = decodeSubscription(await response.text()).split(/\r?\n/).map(parseUri).filter(Boolean);
  if (!parsed.length) throw new Error('Subscription contains no supported server URIs');

  const timestamp = now();
  db.exec('BEGIN');
  try {
    for (const server of parsed) statements.upsertServer.run(server.id, server.name, server.protocol, server.host, server.port, timestamp, timestamp);
    statements.markInactive.run(timestamp, JSON.stringify(parsed.map((server) => server.id)));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  setState('subscription_error', '');
  setState('subscription_updated_at', timestamp);
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (online) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ online, latency: online ? Math.round(performance.now() - started) : null });
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function runChecks() {
  const servers = statements.activeServers.all();
  const results = await Promise.all(servers.map(async (server) => ({ server, result: await checkPort(server.host, server.port) })));
  const timestamp = now();
  db.exec('BEGIN');
  try {
    for (const { server, result } of results) statements.insertCheck.run(server.id, timestamp, result.online ? 1 : 0, result.latency);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  setState('last_check_at', timestamp);
}

let subscriptionInFlight = false;
async function refreshAndCheck() {
  if (subscriptionInFlight) return;
  subscriptionInFlight = true;
  try { await refreshSubscription(); }
  catch (error) {
    setState('subscription_error', error.message);
    console.error(`[subscription] ${error.message}`);
  } finally { subscriptionInFlight = false; }
  try { await runChecks(); } catch (error) { console.error(`[checks] ${error.message}`); }
}

function durationForRange(range) {
  const matches = /^(24h|7d|30d)$/.exec(range);
  if (!matches) return null;
  return { '24h': 24, '7d': 168, '30d': 720 }[matches[1]] * 60 * 60 * 1000;
}

function serverRows() {
  return db.prepare(`SELECT s.*, c.online, c.latency_ms, c.checked_at,
    COALESCE((SELECT ROUND(100.0 * AVG(online), 1) FROM checks WHERE server_id = s.id AND checked_at >= datetime('now', '-24 hours')), 0) AS uptime_24h
    FROM servers s LEFT JOIN checks c ON c.id = (SELECT id FROM checks WHERE server_id = s.id ORDER BY checked_at DESC LIMIT 1)
    WHERE s.active = 1 ORDER BY s.name COLLATE NOCASE`).all().map((row) => ({
      id: row.id, name: row.name, protocol: row.protocol, host: row.host, port: row.port,
      online: row.online === 1, latencyMs: row.latency_ms, lastCheckedAt: row.checked_at,
      uptime24h: row.uptime_24h
    }));
}

const app = express();
app.disable('x-powered-by');
app.get('/api/servers', (_req, res) => res.json({ servers: serverRows(), subscriptionError: getState('subscription_error'), subscriptionUpdatedAt: getState('subscription_updated_at') }));
app.get('/api/summary', (_req, res) => {
  const servers = serverRows();
  const online = servers.filter((server) => server.online).length;
  const latencies = servers.filter((server) => server.online && server.latencyMs !== null).map((server) => server.latencyMs);
  res.json({ total: servers.length, online, offline: servers.length - online, averageLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null, lastCheckAt: getState('last_check_at'), subscriptionError: getState('subscription_error') });
});
app.get('/api/servers/:id/history', (req, res) => {
  const milliseconds = durationForRange(req.query.range || '24h');
  if (!milliseconds) return res.status(400).json({ error: 'range must be 24h, 7d, or 30d' });
  const server = db.prepare('SELECT id, name FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const since = new Date(Date.now() - milliseconds).toISOString();
  const checks = db.prepare('SELECT checked_at AS checkedAt, online = 1 AS online, latency_ms AS latencyMs FROM checks WHERE server_id = ? AND checked_at >= ? ORDER BY checked_at').all(server.id, since);
  const uptime = checks.length ? Math.round(checks.filter((check) => check.online).length / checks.length * 1000) / 10 : null;
  res.json({ server, range: req.query.range || '24h', uptime, checks });
});
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public')));
app.use((_req, res) => res.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`XRay uptime monitor listening on ${PORT}`);
  refreshAndCheck();
  setInterval(refreshAndCheck, SUBSCRIPTION_REFRESH_SECONDS * 1000);
  setInterval(() => runChecks().catch((error) => console.error(`[checks] ${error.message}`)), CHECK_INTERVAL_SECONDS * 1000);
});
