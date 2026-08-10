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

// --- Scan host (for port probing) -------------------------------------
const SCAN_HOST = process.env.SCAN_HOST || "127.0.0.1";

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
  await fs.writeFile(DATA_FILE, JSON.stringify({ records }, null, 2));
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
  return errs;
}

// --- Helpers -----------------------------------------------------------
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
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
    const page = Math.max(1, Number(req.url.split('page=')[1]?.split('&')[0]) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.url.split('limit=')[1]?.split('&')[0]) || 50));
    const start = (page - 1) * limit;
    const paginated = records.slice(start, start + limit);
    return sendJson(res, 200, { records: paginated, total: records.length, page, limit });
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
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="porttracker-export.json"`,
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
        createdAt: rec.createdAt || new Date().toISOString(),
        updatedAt: rec.updatedAt || new Date().toISOString(),
      });
    }
    if (errs.length) return sendJson(res, 400, { error: errs.join('; ') });

    let maxId = 0;
    for (const r of clean) maxId = Math.max(maxId, Number(r.id) || 0);
    // Re-assign IDs to ensure they are sequential and unique after import
    // Note: This might change IDs, but it's generally okay for an import.
    // Let's try to preserve existing IDs if they are valid and don't collide.
    // Actually, the original code just did maxId + i + 1. Let's stick to that for simplicity.
    // But we must ensure we don't lose the existing IDs if we want to keep it simple.
    // The original code: const records = clean.map((r, i) => ({ ...r, id: maxId + i + 1 }));
    // This is fine.
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

    const records = await load();
    const existingPorts = new Set(records.map(r => r.port));

    const open = [];
    // Scan in batches to avoid overwhelming the system
    const batchSize = 50;
    for (let start = from; start <= to; start += batchSize) {
      const end = Math.min(start + batchSize - 1, to);
      const batch = [];
      for (let p = start; p <= end; p++) {
        batch.push(p);
      }
      const results = await Promise.all(batch.map(async (p) => {
        const up = await probePort(p);
        return { port: p, up };
      }));
      for (const r of results) {
        if (r.up) {
          const match = records.find(rec => rec.port === r.port);
          open.push({
            port: r.port,
            service: match ? match.service : null,
            known: !!match,
          });
        }
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
async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, 'public', requested);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(path.resolve(__dirname, 'public'))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// --- Server ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(res, url.pathname);
    }
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`porttracker running at http://localhost:${PORT}`);
});
