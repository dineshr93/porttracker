import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persist data in a stable, machine-wide location so a fresh deployment or
// a re-cloned repo does not lose existing records. This file is outside the
// project directory (and git), so it survives new instances.
const DATA_FILE = path.join(os.homedir(), '.portainer', 'config.json');
const PORT = 3000;

// --- Storage -----------------------------------------------------------
async function load() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch (err) {
    if (err.code === 'ENOENT') return migrateFromLegacy();
    throw err;
  }
}

// First run: if the old in-project data.json still exists, adopt its records
// so nothing already entered is lost.
async function migrateFromLegacy() {
  const legacy = path.join(__dirname, 'data.json');
  try {
    const raw = await fs.readFile(legacy, 'utf8');
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    if (records.length) await save(records);
    return records;
  } catch {
    return [];
  }
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
  if (body.description !== undefined && typeof body.description !== 'string') {
    errs.push('description must be a string');
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
    const record = {
      id: nextId(records),
      port: Number(body.port),
      service: body.service.trim(),
      description: body.description?.trim() || '',
      createdAt: new Date().toISOString(),
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

    if (body.port !== undefined) records[idx].port = Number(body.port);
    if (body.service !== undefined) records[idx].service = body.service.trim();
    if (body.description !== undefined) records[idx].description = body.description.trim();
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

  // Prevent path traversal outside the public dir.
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
