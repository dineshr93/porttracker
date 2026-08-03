# porttracker

A tiny, minimalistic web app that remembers **which service runs on which port** on your local host — so you never have to dig through `netstat`, config files, or your own scattered notes again.

It's a small CRUD app: add, view, edit, and delete port→service mappings from a single clean page.

## Features

- **Create** — record a port, service name, and optional notes. The add form is tucked behind a themed **+** button in the top-right of the header; click it to toggle the form open/closed (the icon flips to **×** when open).
- **Read** — see all current mappings in a table, sorted by port.
- **Update** — edit any mapping inline.
- **Delete** — remove a mapping with a confirmation prompt.
- **Click to open** — clicking a port number opens the live site at `http://0.0.0.0:<port>`, plus the path in the notes if it starts with `/` (e.g. `/v1/models` → `http://0.0.0.0:8888/v1/models`).
- **Persistent storage** — data lives in `data.json` on disk, so it survives restarts.
- **Zero dependencies** — only Node's built-in `http` module; no `npm install`, no database, no framework.
- **Minimalistic UI** — one self-contained HTML page with clean, responsive styling.

## Quick start

Requires **Node.js 18+**. No packages to install.

```bash
cd porttracker
npm start          # or: node server.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

To stop: `Ctrl+C` in the terminal that's running the server.

## How it works

The app is two pieces:

| Piece | File | Role |
|-------|------|------|
| Server | `server.js` | Node HTTP server: serves the frontend and exposes the REST API; reads/writes `data.json`. |
| Frontend | `public/index.html` | Single-page UI (HTML + inline CSS + vanilla JS) for CRUD. |

### REST API

The browser talks to the server through a small JSON REST API.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET`    | `/api/ports`        | List all mappings |
| `POST`   | `/api/ports`        | Create a mapping |
| `PUT`    | `/api/ports/:id`    | Update a mapping |
| `DELETE` | `/api/ports/:id`    | Delete a mapping |

**Record shape** (`data.json` stores an array under `{ "records": [...] }`):

```json
{
  "id": 1,
  "port": 8080,
  "service": "Dev API",
  "description": "local dev backend",
  "createdAt": "2026-08-03T09:46:09.306Z",
  "updatedAt": "2026-08-03T09:46:09.320Z"
}
```

- `port` — integer between 1 and 65535 (required).
- `service` — non-empty name (required).
- `description` — free-form notes, optional. If it starts with `/` it's treated as a URL path (e.g. `/v1/models`), and clicking the port opens `http://0.0.0.0:<port><path>`.
- `createdAt` / `updatedAt` — timestamps, set automatically.

### Example API calls

```bash
# List
curl http://localhost:3000/api/ports

# Create
curl -X POST http://localhost:3000/api/ports \
  -H 'Content-Type: application/json' \
  -d '{"port":8080,"service":"Dev API","description":"local backend"}'

# Update
curl -X PUT http://localhost:3000/api/ports/1 \
  -H 'Content-Type: application/json' \
  -d '{"service":"Dev API v2"}'

# Delete
curl -X DELETE http://localhost:3000/api/ports/1
```

Invalid input returns `400` with a message (e.g. a port outside 1–65535); missing records return `404`.

## Project layout

```
porttracker/
├── package.json      # app metadata + start script
├── server.js         # HTTP server, REST API, JSON-file storage
├── public/
│   └── index.html    # single-page frontend (UI + logic)
├── data.json         # your data — created on first write (git-ignored)
└── README.md         # this file
```

> `data.json` is **not** tracked by git (see `.gitignore`) — it holds your local data, so it won't get committed or overwritten by version control.

## Customization

- **Change the port** the app listens on: edit `const PORT = 3000;` in `server.js`.
- **Move/rename the data file**: change `DATA_FILE` in `server.js`.
- **Styling**: tweak the CSS custom properties at the top of `public/index.html` (colors, spacing, fonts).

## Git history

This project is under version control with a clear commit per change:

```
chore: scaffold repo with .gitignore and package.json
feat: add zero-dependency Node server with CRUD REST API
feat: add minimalistic single-page frontend
docs: add README.md
```

Run `git log --oneline` inside `porttracker/` to see the history.

## License

Free to use — this is a personal utility for your own machine.
