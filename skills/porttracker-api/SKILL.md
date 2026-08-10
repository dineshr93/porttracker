---
name: porttracker-api
description: Drive the porttracker REST API via curl, with record shape.
version: 0.1.0
author: Dinesh, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [porttracker, api, curl, crud, rest]
    related_skills: []
---

# porttracker-api Skill

Maps the porttracker REST API so an agent can list, create, update, delete, scan, import/export, and undo port→service mappings via `curl`. Covers the record shape, validation rules, pagination, and error codes. Read-only reference — no dependencies beyond `curl` and a running server.

## When to Use

- A task requires reading, creating, editing, deleting, scanning, or importing porttracker records.
- Verifying porttracker behavior by exercising the API with `curl`.
- Writing scripts/automation that talks to a running porttracker server.

Don't use for: frontend UI changes in `public/index.html`, or general REST API tutorials.

## Prerequisites

- The porttracker server must be running: `npm start` (listens on `PORT`, default 3000). For Docker: `make run`.
- `curl` available (Linux/macOS/Windows 10+ ships it).
- Data lives in `~/.porttracker/data.json` (or `PORTTRACKERDIR/data.json`); no setup required.

## How to Run

Issue calls through the `terminal` tool. Base URL is `http://localhost:3000` unless `PORT` is set.

```bash
curl http://localhost:3000/api/ports
```

## Quick Reference

| Action | Command |
|--------|---------|
| List | `curl http://localhost:3000/api/ports` |
| Create | `curl -X POST http://localhost:3000/api/ports -H 'Content-Type: application/json' -d '{"port":8080,"service":"Dev API"}'` |
| Update | `curl -X PUT http://localhost:3000/api/ports/1 -H 'Content-Type: application/json' -d '{"service":"Dev API v2"}'` |
| Delete | `curl -X DELETE http://localhost:3000/api/ports/1` |
| Export | `curl -o export.json http://localhost:3000/api/export` |
| Import | `curl -X POST http://localhost:3000/api/import -H 'Content-Type: application/json' -d '{"records":[...]}'` |
| Scan | `curl -X POST http://localhost:3000/api/ports/scan -H 'Content-Type: application/json' -d '{"from":8000,"to":8010}'` |
| Undo | `curl -X POST http://localhost:3000/api/ports/undo` |
| Health | `curl http://localhost:3000/health` |

## Procedure

1. **Confirm the server is up.** `curl http://localhost:3000/health` → `{"status":"ok",...}`. If it fails, start the server first (`npm start`).
2. **List existing records.** `curl http://localhost:3000/api/ports` to see current IDs and ports before creating/editing. Paginate with `?page=2&limit=100` (limit default 50, cap 200).
3. **Create a record.** POST `/api/ports` with `port` and `service` (required); optional `endpoints` (array, each must start with `/` or be `http(s)://`), `notes`, `favorite`. Expect `201` with the created record.
4. **Update a record.** PUT `/api/ports/:id` with any subset of fields; expect `200` with the updated record.
5. **Delete a record.** DELETE `/api/ports/:id`; expect `200` with the removed record. The delete is undoable once.
6. **Scan a range.** POST `/api/ports/scan` with `{from, to}`; response `{open: [{port, service, known}], scanned: {from, to}}`.
7. **Undo a delete.** POST `/api/ports/undo` restores the most recent delete (`201`), or `404` if nothing to undo.
8. **Import / export.** POST `/api/import` with `{"records":[...]}` replaces all stored records (`200`, `{count}`). GET `/api/export` downloads the full list as JSON.

## Pitfalls

- **Duplicate ports are rejected** — POST/PUT return `400` when the port is already in use by another record.
- **Validation** — `400` on bad input: port not integer 1–65535, empty service, `endpoints` not an array of strings, or endpoint not starting with `/` or `http(s)://`.
- **Undo is session-only** — `lastDeleted` lives in memory; restarting the server clears it.
- **IDs are auto-assigned** — don't send an `id` on create; PUT/DELETE need the numeric id from GET.
- **Import re-assigns IDs** to be sequential/unique after replacing records.
- **Legacy `description`** — POST/PUT/import accept a `description` string and map it to `endpoints[0]`; prefer `endpoints` going forward.

## Verification

- After each call, confirm the status code: `201` create/undo, `200` update/delete/import/export/scan, `400` bad input/dup, `404` missing.
- For a create: `curl http://localhost:3000/api/ports` and confirm the new record appears with `createdAt`/`updatedAt`.
- For a delete: list again and confirm the id is gone; `curl -X POST .../undo` restores it.
- Check persistence: `cat ~/.porttracker/data.json` shows the `{ "records": [...] }` array reflects your changes.
