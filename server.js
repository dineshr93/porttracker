import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.PORTTRACKERDIR
  ? path.resolve(process.env.PORTTRACKERDIR)
  : path.join(os.homedir(), '.porttracker');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`invalid PORT "${process.env.PORT}" — expected an integer 1-65535`);
  process.exit(1);
}

// --- Scan host (for port probing) -------------------------------------
const SCAN_HOST = process.env.SCAN_HOST || "127.0.0.1";

// --- Shared helpers ----------------------------------------------------
const log = (...args) => console.log(new Date().toISOString(), ...args);

// All data-file reads/writes are serialized through this lock so concurrent
// requests cannot interleave read-modify-write cycles (lost updates).
let storeLockTail = Promise.resolve();
function withStoreLock(fn) {
  const result = storeLockTail.then(() => fn());
  storeLockTail = result.catch(() => {});
  return result;
}

// --- Undo (in-memory, session-only) ------------------------------------
let lastDeleted = null;


// --- Port probing -----------------------------------------------------
import { createConnection } from "node:net";

function probePort(port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: SCAN_HOST }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeout);
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { resolve(false); });
  });
}
// --- Storage -----------------------------------------------------------
async function load() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    let records = Array.isArray(parsed.records) ? parsed.records : [];

    // Migration: convert old 'description' (string) to new 'endpoints' (string[])
    let changed = false;
    const migratedRecords = records.map(r => {
      if (r.description !== undefined && r.endpoints === undefined) {
        changed = true;
        const endpoints = r.description ? [r.description.trim()] : [];
        return { ...r, endpoints };
      }
      return r;
    });

    if (changed) {
      await save(migratedRecords);
      records = migratedRecords;
    }

    return records;
  } catch (err) {
    if (err.code === 'ENOENT') return migrateFromLegacy();
    throw err;
  }
}

async function migrateFromLegacy() {
  const oldFile = path.join(os.homedir(), '.portainer', 'config.json');
  const legacyFile = path.join(__dirname, 'data.json');
  for (const source of [oldFile, legacyFile]) {
    try {
      const raw = await fs.readFile(source, 'utf8');
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      if (records.length) {
        // When migrating legacy, we should also use the new 'endpoints' format
        const migrated = records.map(r => ({
          ...r,
          endpoints: r.description ? [r.description.trim()] : [],
          description: undefined // remove old field
        }));
        await save(migrated);
        return migrated;
      }
    } catch {}
  }
  return [];
}

async function save(records) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  // Atomic write: write a temp file first, then rename over the target so a
  // crash mid-write can never leave data.json truncated or corrupt.
  const tmp = DATA_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ records }, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

// --- Validation --------------------------------------------------------
function validate(body, partial = false) {
  const errs = [];
  if (body.port !== undefined) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errs.push('port must be an integer between 1 and 65535');
    }
  }
  if (body.service !== undefined && (typeof body.service !== 'string' || !body.service.trim())) {
    errs.push('service must be a non-empty string');
  }
  if (body.endpoints !== undefined) {
    if (!Array.isArray(body.endpoints)) {
      errs.push('endpoints must be an array of strings');
    } else if (!body.endpoints.every(e => typeof e === 'string')) {
      errs.push('each endpoint must be a string');
    } else {
      for (const e of body.endpoints) {
        const trimmed = e.trim();
        if (trimmed && !/^(\/|https?:\/\/)/i.test(trimmed)) {
          errs.push('each endpoint must start with "/" or be a full URL (http/https)');
          break;
        }
      }
    }
  }
  if (body.notes !== undefined && typeof body.notes !== 'string') {
    errs.push('notes must be a string');
  }
  if (body.favorite !== undefined && typeof body.favorite !== 'boolean') {
    errs.push('favorite must be a boolean');
  }
  if (!partial && body.port === undefined && body.service === undefined) {
    errs.push('port and service are required');
  }
  if (partial) {
    const touched = ['port', 'service', 'endpoints', 'description', 'notes', 'favorite']
      .some((k) => body[k] !== undefined);
    if (!touched) errs.push('no fields to update');
  }
  return errs;
}

// --- Helpers -----------------------------------------------------------
// Headers every response carries. The CSP allows the inline script/style the
// single-page UI uses and browser-side port probing to any http(s) host, while
// still blocking external script/style loads and framing.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' http: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Content-Security-Policy': CSP,
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

const MAX_BODY_BYTES = 1_000_000; // 1 MiB — generous for this API's small payloads

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    const tooLarge = () => {
      rejected = true;
      chunks.length = 0;
      const err = new Error('request body exceeds 1 MiB');
      err.status = 413;
      reject(err);
      req.resume(); // drain so the client can still read the response
      return err;
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooLarge();
      else chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        const err = new Error('invalid JSON body');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ["api","ports","1"]

  // GET /api/ports
  if (method === 'GET' && parts.join('/') === 'api/ports') {
    const records = await load();
    const params = url.searchParams;
    const q = (params.get('q') || '').toLowerCase().trim();
    const page = Math.max(1, Number(params.get('page')) || 1);
    const limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 50));

    const filtered = q 
      ? records.filter(r => 
          String(r.port).includes(q) || 
          (r.service || '').toLowerCase().includes(q) || 
          (r.endpoints || []).some(e => e.toLowerCase().includes(q))
        )
      : records;

    const start = (page - 1) * limit;
    // sort=custom serves records in stored array order — the persisted manual
    // arrangement. Otherwise favorites are pinned to the front so they always
    // land on page 1, then the rest keep stable insertion order.
    const sorted = params.get('sort') === 'custom'
      ? filtered
      : [...filtered].sort((a, b) => {
          if (a.favorite && !b.favorite) return -1;
          if (!a.favorite && b.favorite) return 1;
          return 0;
        });
    const paginated = sorted.slice(start, start + limit);
    return sendJson(res, 200, { records: paginated, total: filtered.length, page, limit });
  }

  // POST /api/ports
  if (method === 'POST' && parts.join('/') === 'api/ports') {
    const body = await readBody(req);
    const errs = validate(body);
    if (errs.length) return sendJson(res, 400, { error: errs.join('; ') });

    const records = await load();
    const dup = records.find((r) => r.port === Number(body.port));
    if (dup) return sendJson(res, 400, { error: `port ${body.port} is already used by "${dup.service}"` });

    // Handle both old 'description' and new 'endpoints' for backward compatibility in POST
    let endpoints = [];
    if (Array.isArray(body.endpoints)) {
      endpoints = body.endpoints.map(e => e.trim()).filter(Boolean);
    } else if (typeof body.description === 'string' && body.description.trim()) {
      endpoints = [body.description.trim()];
    }

    const record = {
      id: nextId(records),
      port: Number(body.port),
      service: body.service.trim(),
      endpoints,
      notes: typeof body.notes === 'string' ? body.notes.trim() : '',
      favorite: body.favorite === true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    records.push(record);
    await save(records);
    return sendJson(res, 201, record);
  }

  // PUT /api/ports/:id
  if (method === 'PUT' && parts.join('/').match(/^api\/ports\/\d+$/)) {
    const id = Number(parts[2]);
    const body = await readBody(req);
    const errs = validate(body, true);
    if (errs.length) return sendJson(res, 400, { error: errs.join('; ') });

    const records = await load();
    const idx = records.findIndex((r) => r.id === id);
    if (idx === -1) return sendJson(res, 404, { error: 'not found' });

    if (body.port !== undefined) {
      const dup = records.find((r) => r.id !== id && r.port === Number(body.port));
      if (dup) return sendJson(res, 400, { error: `port ${body.port} is already used by "${dup.service}"` });
      records[idx].port = Number(body.port);
    }
    if (body.service !== undefined) records[idx].service = body.service.trim();

    if (body.endpoints !== undefined) {
      records[idx].endpoints = body.endpoints.map(e => e.trim()).filter(Boolean);
    } else if (body.description !== undefined) {
      // Support legacy 'description' in PUT
      records[idx].endpoints = body.description ? [body.description.trim()] : [];
    }
    if (body.notes !== undefined) records[idx].notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    if (body.favorite !== undefined) records[idx].favorite = body.favorite === true;

    records[idx].updatedAt = new Date().toISOString();

    await save(records);
    return sendJson(res, 200, records[idx]);
  }

  // POST /api/ports/:id/move — reorder a record within the stored list.
  // Body: { direction: "up"|"down" } swaps it with its adjacent record, or
  // { beforeId: n } / { afterId: n } moves it next to a target record.
  // The stored array order IS the persisted custom order (sort=custom serves it).
  if (method === 'POST' && parts.join('/').match(/^api\/ports\/\d+\/move$/)) {
    const id = Number(parts[2]);
    const body = await readBody(req);
    const records = await load();
    const idx = records.findIndex((r) => r.id === id);
    if (idx === -1) return sendJson(res, 404, { error: 'not found' });

    const direction = body?.direction;
    const beforeId = body?.beforeId !== undefined ? Number(body.beforeId) : undefined;
    const afterId = body?.afterId !== undefined ? Number(body.afterId) : undefined;

    if (direction !== undefined && (beforeId !== undefined || afterId !== undefined)) {
      return sendJson(res, 400, { error: 'send direction or beforeId/afterId, not both' });
    }
    if (beforeId !== undefined && afterId !== undefined) {
      return sendJson(res, 400, { error: 'send beforeId or afterId, not both' });
    }

    if (direction === 'up' || direction === 'down') {
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= records.length) {
        return sendJson(res, 400, { error: `already at the ${direction === 'up' ? 'top' : 'bottom'}` });
      }
      [records[idx], records[targetIdx]] = [records[targetIdx], records[idx]];
      await save(records);
      return sendJson(res, 200, records[targetIdx]); // the moved record now sits here
    }
    if (direction !== undefined) {
      return sendJson(res, 400, { error: 'direction must be "up" or "down"' });
    }
    if (beforeId !== undefined && (!Number.isInteger(beforeId) || beforeId < 1)) {
      return sendJson(res, 400, { error: 'beforeId must be a record id' });
    }
    if (afterId !== undefined && (!Number.isInteger(afterId) || afterId < 1)) {
      return sendJson(res, 400, { error: 'afterId must be a record id' });
    }

    const targetId = beforeId ?? afterId; // exactly one is defined here
    const targetIdx = records.findIndex((r) => r.id === targetId);
    if (targetIdx === -1) return sendJson(res, 404, { error: 'target record not found' });
    if (targetIdx === idx) return sendJson(res, 200, records[idx]); // dropped on itself

    const [moved] = records.splice(idx, 1);
    let insertAt = records.findIndex((r) => r.id === targetId);
    if (afterId !== undefined) insertAt += 1; // land just after the target
    records.splice(insertAt, 0, moved);
    await save(records);
    return sendJson(res, 200, moved);
  }

  // DELETE /api/ports/:id
  if (method === 'DELETE' && parts.join('/').match(/^api\/ports\/\d+$/)) {
    const id = Number(parts[2]);
    const records = await load();
    const idx = records.findIndex((r) => r.id === id);
    if (idx === -1) return sendJson(res, 404, { error: 'not found' });
    const [removed] = records.splice(idx, 1);
    await save(records);
    lastDeleted = { record: removed, deletedAt: new Date().toISOString() };
    return sendJson(res, 200, removed);
  }

  // GET /api/export — download the full records list as a JSON file.
  if (method === 'GET' && parts.join('/') === 'api/export') {
    const records = await load();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="porttracker-export.json"`,
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ records }, null, 2));
    return;
  }

  // POST /api/import — replace the stored records with the uploaded ones.
  // Body: { "records": [...] }. Validates each record and dedupes ports.
  if (method === 'POST' && parts.join('/') === 'api/import') {
    const body = await readBody(req);
    const incoming = Array.isArray(body?.records) ? body.records : null;
    if (!incoming) return sendJson(res, 400, { error: 'expected { records: [...] }' });

    const errs = [];
    const seenPorts = new Set();
    const clean = [];
    for (const rec of incoming) {
      if (!Number.isInteger(Number(rec.port)) || Number(rec.port) < 1 || Number(rec.port) > 65535) {
        errs.push(`record ${rec.service || '(unnamed)'}: port must be an integer between 1 and 65535`);
        continue;
      }
      if (typeof rec.service !== 'string' || !rec.service.trim()) {
        errs.push(`record on port ${rec.port}: service must be a non-empty string`);
        continue;
      }
      const port = Number(rec.port);
      if (seenPorts.has(port)) {
        errs.push(`duplicate port ${port} in import`);
        continue;
      }
      seenPorts.add(port);

      // Support both old and new formats in import
      let endpoints = [];
      if (Array.isArray(rec.endpoints)) {
        endpoints = rec.endpoints.map(e => e.trim()).filter(Boolean);
      } else if (typeof rec.description === 'string' && rec.description.trim()) {
        endpoints = [rec.description.trim()];
      }

      clean.push({
        id: Number(rec.id) || 0,
        port,
        service: rec.service.trim(),
        endpoints,
        notes: typeof rec.notes === 'string' ? rec.notes.trim() : '',
        favorite: rec.favorite === true,
        createdAt: typeof rec.createdAt === 'string' && rec.createdAt ? rec.createdAt : new Date().toISOString(),
        updatedAt: typeof rec.updatedAt === 'string' && rec.updatedAt ? rec.updatedAt : new Date().toISOString(),
      });
    }
    if (errs.length) return sendJson(res, 400, { error: errs.join('; ') });

    // Re-assign IDs to ensure they are sequential and unique after import.
    let maxId = 0;
    for (const r of clean) maxId = Math.max(maxId, Number(r.id) || 0);
    const records = clean.map((r, i) => ({ ...r, id: maxId + i + 1 }));
    await save(records);
    return sendJson(res, 200, { count: records.length });
  }

  // GET /health
  if (method === 'GET' && parts.join('/') === 'health') {
    const uptime = process.uptime();
    const records = await load();
    return sendJson(res, 200, { status: 'ok', uptime: Math.floor(uptime), records: records.length });
  }

  // POST /api/ports/scan — scan a port range and return open ports
  if (method === 'POST' && parts.join('/') === 'api/ports/scan') {
    const body = await readBody(req);
    const from = Math.max(1, Math.min(65535, Number(body?.from) || 1));
    const to = Math.max(1, Math.min(65535, Number(body?.to) || 65535));
    if (from > to) return sendJson(res, 400, { error: 'from must be <= to' });
    if (to - from > 1023) {
      return sendJson(res, 400, { error: 'scan at most 1024 ports per request' });
    }

    const records = await load();

    // Probe all ports in the range concurrently, in batches, so a slow host
    // doesn't serialize 1200ms timeouts into a multi-minute request.
    const batches = [];
    for (let start = from; start <= to; start += 50) {
      const end = Math.min(start + 49, to);
      const ports = [];
      for (let p = start; p <= end; p++) ports.push(p);
      batches.push(ports);
    }

    const open = [];
    const batchResults = await Promise.all(
      batches.map((batch) =>
        Promise.all(batch.map(async (p) => ({ port: p, up: await probePort(p) })))
      )
    );
    for (const batch of batchResults) {
      for (const r of batch) {
        if (!r.up) continue;
        const match = records.find(rec => rec.port === r.port);
        open.push({ port: r.port, service: match ? match.service : null, known: !!match });
      }
    }
    return sendJson(res, 200, { open, scanned: { from, to } });
  }

  // POST /api/ports/undo — restore the most recently deleted record
  if (method === 'POST' && parts.join('/') === 'api/ports/undo') {
    if (!lastDeleted) return sendJson(res, 404, { error: 'nothing to undo' });
    const record = lastDeleted.record;
    // Re-assign a fresh id to avoid collisions
    const allRecords = await load();
    if (allRecords.some((r) => r.port === record.port)) {
      return sendJson(res, 409, { error: `port ${record.port} is used by another mapping — undo it first` });
    }
    const maxId = allRecords.reduce((m, r) => Math.max(m, r.id), 0);
    record.id = maxId + 1;
    record.updatedAt = new Date().toISOString();
    record.createdAt = new Date().toISOString();
    allRecords.push(record);
    await save(allRecords);
    lastDeleted = null;
    return sendJson(res, 201, record);
  }

  return sendJson(res, 405, { error: `unsupported ${method} ${url.pathname}` });
}

function nextId(records) {
  return records.reduce((max, r) => Math.max(max, r.id), 0) + 1;
}

// --- Static files ------------------------------------------------------
const PUBLIC_ROOT = path.resolve(__dirname, 'public');

async function serveStatic(res, method, pathname) {
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
    return res.end();
  }

  const requested = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(path.join(PUBLIC_ROOT, requested));

  // Block path traversal (.., odd siblings like /publicX) and, after read,
  // symlink escapes from public/.
  const inPublic = (p) => p === PUBLIC_ROOT || p.startsWith(PUBLIC_ROOT + path.sep);
  if (!inPublic(resolved)) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end('Forbidden');
  }

  try {
    const data = await fs.readFile(resolved);
    const real = await fs.realpath(resolved);
    if (!inPublic(real)) {
      res.writeHead(403, SECURITY_HEADERS);
      return res.end('Forbidden');
    }
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
    };
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': types[path.extname(real).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': path.extname(real).toLowerCase() === '.html' ? 'no-store' : 'no-cache',
    });
    if (method === 'HEAD') return res.end();
    res.end(data);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// --- Server ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    if (pathname === '/health') await handleApi(req, res, url);
    else if (pathname.startsWith('/api/')) {
      // The scan endpoint only reads data and can run for seconds — keep it
      // outside the store lock so it never blocks CRUD requests.
      if (pathname === '/api/ports/scan') await handleApi(req, res, url);
      else await withStoreLock(() => handleApi(req, res, url));
    } else {
      await serveStatic(res, req.method, url.pathname);
    }
  } catch (err) {
    const status = err?.status || 500;
    if (status >= 500) log(`error handling ${req.method} ${req.url}: ${err?.stack || err}`);
    if (res.writableEnded || res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    sendJson(res, status, status >= 500 ? { error: 'internal server error' } : { error: err?.message || 'bad request' });
  }
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    log(`port ${PORT} is already in use`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  log(`porttracker running at http://localhost:${PORT} (data: ${DATA_FILE})`);
});

// Graceful shutdown: stop accepting connections, let in-flight requests
// finish (saves are atomic), then exit — SIGTERM/SIGINT never corrupt data.
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1); // second signal forces exit
    shuttingDown = true;
    log(`${sig} received — shutting down`);
    // Stop accepting new connections and drop idle keep-alive sockets so
    // close() can actually complete instead of waiting on parked clients.
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
