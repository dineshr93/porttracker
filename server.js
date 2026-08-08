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
    }
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
    return sendJson(res, 200, records);
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
