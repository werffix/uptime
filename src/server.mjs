import crypto from 'node:crypto';
import express from 'express';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const PORT = integerEnv('PORT', 3000, 1);
const CHECK_INTERVAL_SECONDS = integerEnv('CHECK_INTERVAL_SECONDS', 60, 10);
const SUBSCRIPTION_REFRESH_SECONDS = integerEnv('SUBSCRIPTION_REFRESH_SECONDS', 300, 30);
const TEST_TIMEOUT_MS = integerEnv('TEST_TIMEOUT_MS', 5000, 500);
const TEST_URL = process.env.TEST_URL || 'https://www.gstatic.com/generate_204';
const XRAY_BINARY = process.env.XRAY_BINARY || 'xray';
const SUBSCRIPTION_URL = process.env.SUBSCRIPTION_URL?.trim();
const DATABASE_PATH = process.env.DATABASE_PATH || './data/monitor.db';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change_me';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret-before-production';

mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL, host TEXT NOT NULL,
    port INTEGER NOT NULL, raw_config TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    is_visible INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL REFERENCES servers(id),
    checked_at TEXT NOT NULL, online INTEGER NOT NULL, latency_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS checks_server_time ON checks(server_id, checked_at DESC);
  CREATE TABLE IF NOT EXISTS monitor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
for (const migration of ['ALTER TABLE servers ADD COLUMN raw_config TEXT NOT NULL DEFAULT \'{}\'', 'ALTER TABLE servers ADD COLUMN is_visible INTEGER NOT NULL DEFAULT 1']) {
  try { db.exec(migration); } catch { /* Existing database already has this column. */ }
}

const statements = {
  stateGet: db.prepare('SELECT value FROM monitor_state WHERE key = ?'),
  stateSet: db.prepare('INSERT INTO monitor_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  upsertServer: db.prepare(`INSERT INTO servers (id, name, protocol, host, port, raw_config, active, is_visible, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, protocol = excluded.protocol, host = excluded.host,
      port = excluded.port, raw_config = excluded.raw_config, active = 1, updated_at = excluded.updated_at`),
  markInactive: db.prepare('UPDATE servers SET active = 0, updated_at = ? WHERE id NOT IN (SELECT value FROM json_each(?))'),
  legacyServer: db.prepare('SELECT id, is_visible FROM servers WHERE id = ?'),
  migrateChecks: db.prepare('UPDATE checks SET server_id = ? WHERE server_id = ?'),
  setVisibility: db.prepare('UPDATE servers SET is_visible = ? WHERE id = ?'),
  removeServer: db.prepare('DELETE FROM servers WHERE id = ?'),
  activeServers: db.prepare('SELECT * FROM servers WHERE active = 1 ORDER BY name COLLATE NOCASE'),
  insertCheck: db.prepare('INSERT INTO checks (server_id, checked_at, online, latency_ms) VALUES (?, ?, ?, ?)')
};

function integerEnv(name, fallback, minimum) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}
function now() { return new Date().toISOString(); }
function setState(key, value) { statements.stateSet.run(key, String(value)); }
function getState(key) { return statements.stateGet.get(key)?.value ?? null; }
function decodeBase64Url(value) { return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='), 'base64').toString('utf8'); }
function humanName(value, fallback) { try { return decodeURIComponent(value || '').trim() || fallback; } catch { return fallback; } }
function safeDecode(value) { try { return decodeURIComponent(value); } catch { return value; } }

function decodeSubscription(body) {
  const cleaned = body.trim().replace(/\s/g, '');
  if (!cleaned) return '';
  const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
  return /(?:vless|vmess|trojan|ss):\/\//i.test(decoded) ? decoded : body;
}

function parseUri(raw) {
  const line = raw.trim();
  if (!/^(vless|vmess|trojan|ss):\/\//i.test(line)) return null;
  const protocol = line.slice(0, line.indexOf('://')).toLowerCase();
  try {
    if (protocol === 'vmess' && !line.slice(8).includes('@')) {
      const vmess = JSON.parse(decodeBase64Url(line.slice(8).split('#')[0]));
      return makeServer(protocol, vmess.add, Number(vmess.port), humanName(vmess.ps, `${vmess.add}:${vmess.port}`), { vmess });
    }
    if (protocol === 'ss' && !line.slice(5).includes('@')) {
      const decoded = decodeBase64Url(line.slice(5).split('#')[0]);
      const match = /^(.*?):(.*?)@(.+):(\d+)$/.exec(decoded);
      if (!match) return null;
      return makeServer(protocol, match[3], Number(match[4]), humanName(line.split('#')[1], `${match[3]}:${match[4]}`), { method: match[1], password: match[2], query: {} });
    }
    const url = new URL(line);
    const host = url.hostname;
    const port = Number(url.port);
    let credentials = safeDecode(url.username);
    let password = safeDecode(url.password);
    if (protocol === 'ss' && !password) {
      const decoded = decodeBase64Url(credentials);
      const separator = decoded.indexOf(':');
      if (separator > 0) { password = decoded.slice(separator + 1); credentials = decoded.slice(0, separator); }
    }
    return makeServer(protocol, host, port, humanName(url.hash.slice(1), `${host}:${port}`), {
      user: credentials, password, query: Object.fromEntries(url.searchParams)
    });
  } catch { return null; }
}

function makeServer(protocol, host, port, name, connection) {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  // The ID is deliberately a hash: public endpoints must not leak host/port/protocol by decoding it.
  const id = crypto.createHash('sha256').update(`${protocol}\0${host.toLowerCase()}\0${port}`).digest('base64url');
  const legacyId = Buffer.from(`${protocol}\0${host.toLowerCase()}\0${port}\0${name}`).toString('base64url');
  return { id, legacyId, protocol, host, port, name, connection };
}

async function refreshSubscription() {
  if (!SUBSCRIPTION_URL) throw new Error('SUBSCRIPTION_URL is not set');
  const response = await fetch(SUBSCRIPTION_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Subscription returned HTTP ${response.status}`);
  const servers = decodeSubscription(await response.text()).split(/\r?\n/).map(parseUri).filter(Boolean);
  if (!servers.length) throw new Error('Subscription contains no supported server URIs');
  const timestamp = now();
  db.exec('BEGIN');
  try {
    for (const server of servers) {
      // One-time migration from the original reversible ID format. It preserves history and visibility.
      const legacy = server.legacyId !== server.id ? statements.legacyServer.get(server.legacyId) : null;
      statements.upsertServer.run(server.id, server.name, server.protocol, server.host, server.port, JSON.stringify(server.connection), timestamp, timestamp);
      if (legacy) {
        statements.migrateChecks.run(server.id, server.legacyId);
        statements.setVisibility.run(legacy.is_visible, server.id);
        statements.removeServer.run(server.legacyId);
      }
    }
    statements.markInactive.run(timestamp, JSON.stringify(servers.map((server) => server.id)));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  setState('subscription_error', '');
  setState('subscription_updated_at', timestamp);
}

function streamSettings(server, query = {}) {
  const security = query.security || 'none';
  const settings = { network: query.type || 'tcp', security };
  if (security === 'tls') settings.tlsSettings = { serverName: query.sni || server.host, allowInsecure: query.allowInsecure === '1', fingerprint: query.fp, alpn: query.alpn?.split(',').filter(Boolean) };
  if (security === 'reality') settings.realitySettings = { serverName: query.sni || server.host, fingerprint: query.fp || 'chrome', publicKey: query.pbk, shortId: query.sid, spiderX: query.spx || '' };
  if (settings.network === 'ws') settings.wsSettings = { path: query.path || '/', headers: query.host ? { Host: query.host } : undefined };
  if (settings.network === 'grpc') settings.grpcSettings = { serviceName: query.serviceName || '' };
  if (settings.network === 'httpupgrade') settings.httpupgradeSettings = { path: query.path || '/', host: query.host || server.host };
  return settings;
}

function xrayOutbound(server) {
  const connection = JSON.parse(server.raw_config);
  if (connection.vmess) {
    const config = connection.vmess;
    return { tag: 'proxy', protocol: 'vmess', settings: { vnext: [{ address: server.host, port: server.port, users: [{ id: config.id, alterId: Number(config.aid || 0), security: config.scy || 'auto', level: 0 }] }] }, streamSettings: streamSettings(server, { type: config.net, security: config.tls, sni: config.sni || config.host, path: config.path, host: config.host, fp: config.fp, serviceName: config.path }) };
  }
  const query = connection.query || {};
  if (server.protocol === 'vless') return { tag: 'proxy', protocol: 'vless', settings: { vnext: [{ address: server.host, port: server.port, users: [{ id: connection.user, encryption: query.encryption || 'none', flow: query.flow || '', level: 0 }] }] }, streamSettings: streamSettings(server, query) };
  if (server.protocol === 'vmess') return { tag: 'proxy', protocol: 'vmess', settings: { vnext: [{ address: server.host, port: server.port, users: [{ id: connection.user, alterId: Number(query.aid || 0), security: query.scy || 'auto', level: 0 }] }] }, streamSettings: streamSettings(server, query) };
  if (server.protocol === 'trojan') return { tag: 'proxy', protocol: 'trojan', settings: { servers: [{ address: server.host, port: server.port, password: connection.user, level: 0 }] }, streamSettings: streamSettings(server, query) };
  if (server.protocol === 'ss') return { tag: 'proxy', protocol: 'shadowsocks', settings: { servers: [{ address: server.host, port: server.port, method: connection.method || connection.user, password: connection.password, level: 0 }] } };
  throw new Error(`Unsupported protocol ${server.protocol}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close((error) => error ? reject(error) : resolve(port)); });
  });
}
function waitForPort(port, timeout) {
  const until = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => { socket.destroy(); Date.now() >= until ? reject(new Error('XRay startup timed out')) : setTimeout(attempt, 40); });
    };
    attempt();
  });
}
function makeReader(socket) {
  let buffered = Buffer.alloc(0); let failed = null; let wake;
  socket.on('data', (chunk) => { buffered = Buffer.concat([buffered, chunk]); wake?.(); });
  socket.on('error', (error) => { failed = error; wake?.(); });
  socket.on('end', () => { failed ??= new Error('Connection closed'); wake?.(); });
  return async (size) => { while (buffered.length < size) { if (failed) throw failed; await new Promise((resolve) => { wake = resolve; }); wake = null; } const value = buffered.subarray(0, size); buffered = buffered.subarray(size); return value; };
}
async function openSocksTunnel(port, target) {
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const read = makeReader(socket);
  socket.write(Buffer.from([5, 1, 0]));
  const hello = await read(2); if (hello[1] !== 0) throw new Error('SOCKS authentication rejected');
  const host = Buffer.from(target.hostname); const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const destinationPort = Buffer.alloc(2); destinationPort.writeUInt16BE(targetPort);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, destinationPort]));
  const response = await read(4); if (response[1] !== 0) throw new Error(`SOCKS connect failed (${response[1]})`);
  const length = response[3] === 1 ? 4 : response[3] === 4 ? 16 : (await read(1))[0]; await read(length + 2);
  return socket;
}
async function httpThroughSocks(port) {
  const target = new URL(TEST_URL); const started = performance.now();
  const tunnel = await openSocksTunnel(port, target);
  const socket = target.protocol === 'https:' ? tls.connect({ socket: tunnel, servername: target.hostname }) : tunnel;
  if (target.protocol === 'https:') await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  return new Promise((resolve, reject) => {
    let data = ''; const timer = setTimeout(() => finish(new Error('HTTP request timed out')), TEST_TIMEOUT_MS);
    const finish = (error, status) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve({ online: status >= 200 && status < 300, latency: Math.round(performance.now() - started) }); };
    socket.once('error', (error) => finish(error));
    socket.on('data', (chunk) => { data += chunk.toString('latin1'); const match = /^HTTP\/\d\.\d\s+(\d+)/.exec(data); if (match) finish(null, Number(match[1])); });
    socket.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\nUser-Agent: xray-uptime-monitor/1.0\r\n\r\n`);
  });
}
async function checkServer(server) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xray-check-')); let child;
  try {
    const port = await getFreePort();
    const config = { log: { loglevel: 'none' }, inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth', udp: false } }], outbounds: [xrayOutbound(server)] };
    const configPath = path.join(directory, 'config.json'); await writeFile(configPath, JSON.stringify(config));
    child = spawn(XRAY_BINARY, ['run', '-c', configPath], { stdio: 'ignore' });
    await waitForPort(port, TEST_TIMEOUT_MS);
    return await httpThroughSocks(port);
  } catch { return { online: false, latency: null }; }
  finally { child?.kill('SIGTERM'); await rm(directory, { recursive: true, force: true }); }
}
async function mapLimited(items, limit, mapper) {
  const result = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; result[index] = await mapper(items[index]); } }));
  return result;
}
async function runChecks() {
  const servers = statements.activeServers.all();
  const results = await mapLimited(servers, 3, async (server) => ({ server, result: await checkServer(server) }));
  const timestamp = now(); db.exec('BEGIN');
  try { for (const { server, result } of results) statements.insertCheck.run(server.id, timestamp, result.online ? 1 : 0, result.latency); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  setState('last_check_at', timestamp); setState('next_check_at', new Date(Date.now() + CHECK_INTERVAL_SECONDS * 1000).toISOString());
}

let subscriptionInFlight = false;
async function refreshAndCheck() {
  if (subscriptionInFlight) return; subscriptionInFlight = true;
  try { await refreshSubscription(); } catch (error) { setState('subscription_error', error.message); console.error(`[subscription] ${error.message}`); } finally { subscriptionInFlight = false; }
  try { await runChecks(); } catch (error) { console.error(`[checks] ${error.message}`); }
}
function durationForRange(range) { return ({ '24h': 24, '7d': 168, '30d': 720 })[range] * 3600000 || null; }
function rows(visibleOnly) {
  return db.prepare(`SELECT s.id, s.name, s.is_visible, c.online, c.latency_ms, c.checked_at,
    COALESCE((SELECT ROUND(100.0 * AVG(online), 1) FROM checks WHERE server_id = s.id AND checked_at >= datetime('now', '-24 hours')), 0) AS uptime_24h
    FROM servers s LEFT JOIN checks c ON c.id = (SELECT id FROM checks WHERE server_id = s.id ORDER BY checked_at DESC LIMIT 1)
    WHERE s.active = 1 ${visibleOnly ? 'AND s.is_visible = 1' : ''} ORDER BY s.name COLLATE NOCASE`).all().map((row) => {
      const item = { id: row.id, name: row.name, online: row.online === 1, latencyMs: row.latency_ms, lastCheckedAt: row.checked_at, uptime24h: row.uptime_24h };
      return visibleOnly ? item : { ...item, visible: row.is_visible === 1 };
    });
}
function sessionFor(request) {
  const token = request.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith('admin_session='))?.slice(14);
  if (!token) return false; const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url')).exp > Date.now(); } catch { return false; }
}
function requireAdmin(request, response, next) { return sessionFor(request) ? next() : response.status(401).json({ error: 'Unauthorized' }); }
function createSession() { const body = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 86400000 })).toString('base64url'); return `${body}.${crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url')}`; }

const app = express();
app.disable('x-powered-by'); app.set('trust proxy', 1); app.use(express.urlencoded({ extended: false })); app.use(express.json());
app.get('/api/servers', (_request, response) => response.json({ servers: rows(true), subscriptionError: getState('subscription_error') }));
app.get('/api/summary', (_request, response) => { const servers = rows(true); const latencies = servers.filter((server) => server.online && server.latencyMs !== null).map((server) => server.latencyMs); response.json({ total: servers.length, online: servers.filter((server) => server.online).length, offline: servers.filter((server) => !server.online).length, averageLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null, lastCheckAt: getState('last_check_at'), nextCheckAt: getState('next_check_at'), checkIntervalSeconds: CHECK_INTERVAL_SECONDS, subscriptionError: getState('subscription_error') }); });
app.get('/api/servers/:id/history', (request, response) => { const milliseconds = durationForRange(request.query.range || '24h'); if (!milliseconds) return response.status(400).json({ error: 'range must be 24h, 7d, or 30d' }); const server = db.prepare('SELECT id, name FROM servers WHERE id = ? AND active = 1 AND is_visible = 1').get(request.params.id); if (!server) return response.status(404).json({ error: 'Server not found' }); const checks = db.prepare('SELECT checked_at AS checkedAt, online = 1 AS online, latency_ms AS latencyMs FROM checks WHERE server_id = ? AND checked_at >= ? ORDER BY checked_at').all(server.id, new Date(Date.now() - milliseconds).toISOString()); const uptime = checks.length ? Math.round(checks.filter((check) => check.online).length / checks.length * 1000) / 10 : null; response.json({ server, range: request.query.range || '24h', uptime, checks }); });
app.get('/admin', (request, response) => sessionFor(request) ? response.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/admin.html')) : response.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/login.html')));
app.post('/admin/login', (request, response) => { const login = String(request.body.login || ''); const password = String(request.body.password || ''); const validLogin = login.length === ADMIN_LOGIN.length && crypto.timingSafeEqual(Buffer.from(login), Buffer.from(ADMIN_LOGIN)); const validPassword = password.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD)); if (!validLogin || !validPassword) return response.status(401).send('Неверный логин или пароль'); response.cookie('admin_session', createSession(), { httpOnly: true, sameSite: 'strict', secure: request.secure, maxAge: 7 * 86400000, path: '/admin' }); response.redirect('/admin'); });
app.get('/admin/api/servers', requireAdmin, (_request, response) => response.json({ servers: rows(false) }));
app.post('/admin/api/servers/:id/visibility', requireAdmin, (request, response) => { const server = db.prepare('SELECT id, is_visible FROM servers WHERE id = ? AND active = 1').get(request.params.id); if (!server) return response.status(404).json({ error: 'Server not found' }); const visible = typeof request.body.visible === 'boolean' ? request.body.visible : !server.is_visible; db.prepare('UPDATE servers SET is_visible = ?, updated_at = ? WHERE id = ?').run(visible ? 1 : 0, now(), server.id); response.json({ id: server.id, visible }); });
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public')));
app.use((_request, response) => response.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html')));

app.listen(PORT, '0.0.0.0', () => { console.log(`XRay uptime monitor listening on ${PORT}`); setState('next_check_at', new Date(Date.now() + CHECK_INTERVAL_SECONDS * 1000).toISOString()); refreshAndCheck(); setInterval(refreshAndCheck, SUBSCRIPTION_REFRESH_SECONDS * 1000); setInterval(() => runChecks().catch((error) => console.error(`[checks] ${error.message}`)), CHECK_INTERVAL_SECONDS * 1000); });
