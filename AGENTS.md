# AGENTS.md — porttracker

Guidance for AI coding agents working in this repo. Keep it concise; the README has full prose.

## What this is

A tiny, zero-dependency CRUD webapp that remembers which service runs on which local host port. Node's built-in `http` module only — no packages, no framework, no database.

## Architecture

| Piece | File | Role |
|-------|------|------|
| Server | `server.js` | Node HTTP server: serves the frontend, exposes the REST API, reads/writes `data.json`. |
| Frontend | `public/index.html` | Single-page UI (HTML + inline CSS + vanilla JS). No build step. |

- Requests starting with `/api/` go to `handleApi` in `server.js`; everything else is served as a static file from `public/` (traversal-guarded).
- Storage is a JSON file. Path = `PORTTRACKERDIR/data.json`, default `~/.porttracker/data.json` (outside the repo). The file's shape is `{ "records": [ ... ] }`.

## Commands

- Run locally: `npm start` (== `node server.js`), listens on `PORT` (default 3000).
- Docker: `make` / `make run` (clean build + run), `make build`, `make clean`, `make stop`. `make run PORT=9000` / `DATA_DIR=/custom`.
- Verify: `make build` (per project Makefile); for code checks, `node --check server.js`.
- No test suite exists — run the server and curl the API to verify behavior.

## Data model (record shape)

```json
{ "id": 1, "port": 8080, "service": "Dev API", "endpoints": ["/v1/models", "/health"],
  "notes": "", "favorite": false, "createdAt": "...", "updatedAt": "..." }
```

- `id` — integer, auto-assigned (max+1).
- `port` — integer 1–65535, **required**, unique across records (server rejects duplicates).
- `service` — non-empty string, **required**.
- `endpoints` — array of strings; each must start with `/` or be a full `http(s)://` URL. Replaces the legacy `description` string (migration handled in `load()`).
- `notes` — optional string. `favorite` — optional boolean.
- `createdAt` / `updatedAt` — ISO timestamps, set server-side.

## REST API (see the `porttracker-api` skill for full usage)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/ports` | List (paginated: `page`, `limit`; default limit 50, cap 200) |
| POST | `/api/ports` | Create (`{port, service, endpoints?, notes?, favorite?}`) → 201 |
| PUT | `/api/ports/:id` | Partial update (any field) → 200 |
| DELETE | `/api/ports/:id` | Delete → 200, stores record for undo |
| GET | `/api/export` | Download all as JSON (attachment) |
| POST | `/api/import` | Replace records from `{ "records": [...] }` → 200 |
| POST | `/api/ports/scan` | Probe range `{from, to}` → open ports |
| POST | `/api/ports/undo` | Restore most recent delete → 201 (in-memory, session only) |
| GET | `/health` | `{status, uptime, records}` |

Errors: `400` (validation/dup), `404` (missing / nothing to undo), `405` (unsupported method).

## Conventions & gotchas

- **Zero deps** — don't add npm packages or frameworks; stick to Node built-ins.
- Legacy `description` field is accepted in POST/PUT/import for backward compat and mapped to `endpoints`; new code should use `endpoints`.
- Undo (`lastDeleted`) is in-memory/session-only — cleared on restart.
- Port probing (`probePort`) targets `SCAN_HOST` (default `127.0.0.1`); the Makefile sets it to the docker0 bridge IP for Docker runs.
- The frontend probes ports from the browser (works in Docker), auto-refresh 10s.
- Data is intentionally NOT committed to the repo; don't create or track a `data.json` in the repo.
