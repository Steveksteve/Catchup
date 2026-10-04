'use strict';

// Importe l'export historique dans Loki avec son horodatage d'origine.
//   node tools/import-export.js --file data/admin-export-2026-09-20_26.log --loki http://localhost:3100
// Options : --dry-run (n'envoie rien, affiche le resume), --force (reimporte meme si deja present).

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { parseExport, normalize } = require('./export-parser');

const { values } = parseArgs({
  options: {
    file: { type: 'string', default: 'data/admin-export-2026-09-20_26.log' },
    loki: { type: 'string', default: process.env.LOKI_URL ?? 'http://localhost:3100' },
    tz: { type: 'string', default: 'Europe/Paris' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});

const out = (obj) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForLoki(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${url}/ready`)).ok) return;
    } catch {
      // Loki demarre encore
    }
    await sleep(2000);
  }
  throw new Error(`Loki injoignable sur ${url}`);
}

async function alreadyImported(url, from, to) {
  const q = new URLSearchParams({ query: 'sum(count_over_time({service="game-telemetry",source="export"}[10d]))', time: String(Math.floor(to / 1000) + 3600) });
  const r = await fetch(`${url}/loki/api/v1/query?${q}`);
  if (!r.ok) return 0;
  const body = await r.json();
  return Number(body.data?.result?.[0]?.value?.[1] ?? 0);
}

async function push(url, events) {
  // Labels a faible cardinalite uniquement : 2 evenements x 2 niveaux = 2 flux pour l'export.
  const streams = new Map();
  for (const e of events) {
    const labels = { service: 'game-telemetry', source: 'export', event: e.event, level: e.level };
    const key = JSON.stringify(labels);
    if (!streams.has(key)) streams.set(key, { stream: labels, values: [] });
    streams.get(key).values.push([`${Date.parse(e.ts)}000000`, JSON.stringify(e)]);
  }
  const r = await fetch(`${url}/loki/api/v1/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streams: [...streams.values()] }),
  });
  if (!r.ok) throw new Error(`Loki a refuse le lot (${r.status}) : ${(await r.text()).slice(0, 300)}`);
}

async function main() {
  const { records, errors, lineCount } = parseExport(fs.readFileSync(values.file, 'utf8'), { timeZone: values.tz });
  const events = normalize(records);
  const summary = {
    level: 'info', event: 'export_parsed', file: values.file, lines: lineCount, records: records.length, parseErrors: errors.length,
    spikes: events.filter((e) => e.event === 'perf_spike').length,
    games: events.filter((e) => e.event === 'game_completed').length,
    duplicates: events.filter((e) => e.cls.duplicate).length,
    from: events[0]?.ts, to: events.at(-1)?.ts,
  };
  out(summary);
  for (const e of errors) out({ level: 'warn', event: 'export_parse_error', ...e });
  if (values['dry-run']) return;

  await waitForLoki(values.loki);
  const present = await alreadyImported(values.loki, Date.parse(summary.from), Date.parse(summary.to));
  if (present > 0 && !values.force) {
    out({ level: 'info', event: 'export_import_skipped', reason: 'deja present dans Loki', present });
    return;
  }
  const BATCH = 200;
  for (let i = 0; i < events.length; i += BATCH) await push(values.loki, events.slice(i, i + BATCH));
  out({ level: 'info', event: 'export_imported', pushed: events.length });
}

main().catch((err) => {
  out({ level: 'error', event: 'export_import_failed', message: err.message });
  process.exit(1);
});
