// Deploy smoke test: exercises the live API against a running instance.
//   docker exec porttracker node /app/smoke.js
//   PORT=3901 node smoke.js        (local, against `npm start`)
// Exits non-zero on the first failed request, so `make verify` fails loudly.

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;

async function call(path, opts) {
  const res = await fetch(BASE + path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts?.method || 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const json = (payload) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

async function main() {
  const health = await call('/health');
  console.log('  /health:', JSON.stringify(health));

  const list = await call('/api/ports?limit=1');
  console.log('  /api/ports: total=' + list.total + ' page=' + list.page);

  // CRUD cycle on a throwaway high port, always cleaned up.
  const port = 65000 + Math.floor(Math.random() * 500);
  const created = await call('/api/ports', { method: 'POST', ...json({ port, service: 'deploy-smoke' }) });
  try {
    const updated = await call(`/api/ports/${created.id}`, { method: 'PUT', ...json({ notes: 'ok' }) });
    if (updated.notes !== 'ok') throw new Error('PUT did not persist notes');
    console.log(`  CRUD: create id=${created.id} port=${port}, update ok`);
  } finally {
    await call(`/api/ports/${created.id}`, { method: 'DELETE' });
    console.log('  CRUD: delete ok');
  }
}

main().then(
  () => console.log('  smoke: PASS'),
  (err) => {
    console.error('  smoke: FAILED —', err.message);
    process.exit(1);
  },
);
