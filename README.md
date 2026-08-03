# porttracker

A tiny, minimalistic web app that remembers **which service runs on which port** on your local host — so you never have to dig through `netstat`, config files, or your own scattered notes again.

It's a small CRUD app: add, view, edit, and delete port→service mappings from a single clean page.

## Features

- **Create** — record a port, service name, and an optional endpoint. The add form is tucked behind a themed **+** button in the top-right of the header; click it to toggle the form open/closed (the icon flips to **×** when open).
- **Read** — see all current mappings in a table, sorted by port.
- **Update** — edit any mapping inline.
- **Delete** — remove a mapping with a confirmation prompt.
- **Click to open** — clicking a port number opens the live site at `http://0.0.0.0:<port>`, plus the path in the endpoint if it starts with `/` (e.g. `/v1/models` → `http://0.0.0.0:8888/v1/models`).
- **Search** — a magnifier button beside the **+** toggles a search bar that filters the list live by port, service, or endpoint.
- **Persistent storage** — data lives in `~/.porttracker/data.json` (outside the repo), so it survives restarts **and** fresh deployments / re-cloned repos.
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
| Server | `server.js` | Node HTTP server: serves the frontend and exposes the REST API; reads/writes `~/.porttracker/data.json`. |
| Frontend | `public/index.html` | Single-page UI (HTML + inline CSS + vanilla JS) for CRUD. |

### REST API

The browser talks to the server through a small JSON REST API.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET`    | `/api/ports`        | List all mappings |
| `POST`   | `/api/ports`        | Create a mapping |
| `PUT`    | `/api/ports/:id`    | Update a mapping |
| `DELETE` | `/api/ports/:id`    | Delete a mapping |

**Record shape** (`~/.porttracker/data.json` stores an array under `{ "records": [...] }`):

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
- `description` — free-form endpoint, optional. If it starts with `/` it's treated as a URL path (e.g. `/v1/models`), and clicking the port opens `http://0.0.0.0:<port><path>`.
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
├── data.json         # legacy data (auto-migrated to ~/.porttracker/data.json on first run)
└── README.md         # this file
```

> Your data is **not** stored in the repo — it lives at `~/.porttracker/data.json` (or the dir set by `PORTTRACKERDIR`), so it's never committed or lost when you re-clone/redepoly. On first run, existing data from `~/.portainer/config.json` or an old in-project `data.json` is migrated automatically.

## Docker

The app ships with a minimal Dockerfile (`node:22-alpine`, zero npm dependencies — ~58 MB).

Build the image:

```bash
docker build -t porttracker .
```

Or use the bundled **Makefile** (removes the old image, clean-builds, then runs):

```bash
make        # clean build + run on port 3000 (data persisted to ~/.porttracker)
make run    # same as above
make run PORT=9000   # run on a different port
make run DATA_DIR=/custom   # persist data somewhere else (default ~/.porttracker)
make build  # remove old image + clean (no-cache) build only
make clean  # remove old image and containers
make stop   # stop/remove the running container
```

Run it on the default port 3000:

```bash
docker run -p 3000:3000 porttracker
```

Change the port while running — the `PORT` env var overrides the container's listening port (default 3000), so map the host to match:

```bash
# listen on 9000 inside the container, exposed on host port 9000
docker run -p 9000:9000 -e PORT=9000 porttracker

# host port 8080 → container port 9000
docker run -p 8080:9000 -e PORT=9000 porttracker
```

Set the data directory with `PORTTRACKERDIR` (default `~/.porttracker` inside the container) and persist it on a host volume:

```bash
docker run -p 3000:3000 -e PORTTRACKERDIR=/data -v /host/dir:/data porttracker
```

## Customization

- **Change the port** the app listens on: set `PORT` (default `3000`), e.g. `PORT=9000 npm start` or `docker run -e PORT=9000`.
- **Set the data directory**: export `PORTTRACKERDIR=/some/dir` before starting, and data is stored in `$PORTTRACKERDIR/data.json`. Default is `~/.porttracker` (i.e. `~/.porttracker/data.json`).
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
