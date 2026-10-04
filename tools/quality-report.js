'use strict';

// Rapport de qualite de l'export historique : chaque constat est chiffre.
//   node tools/quality-report.js [--file data/admin-export-2026-09-20_26.log] [--json]

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { parseExport, normalize } = require('./export-parser');

const { values } = parseArgs({
  options: {
    file: { type: 'string', default: 'data/admin-export-2026-09-20_26.log' },
    json: { type: 'boolean', default: false },
  },
});

const count = (arr, keyFn) => {
  const m = new Map();
  for (const x of arr) m.set(keyFn(x), (m.get(keyFn(x)) ?? 0) + 1);
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
};
const parisHour = (ts) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(new Date(ts)).slice(0, 13);
const parisDay = (ts) => parisHour(ts).slice(0, 10);

const raw = fs.readFileSync(values.file, 'utf8');
const { records, errors, lineCount } = parseExport(raw);
const events = normalize(records);
const spikes = events.filter((e) => e.event === 'perf_spike');
const games = events.filter((e) => e.event === 'game_completed');
const uSpikes = spikes.filter((e) => !e.cls.duplicate);
const uGames = games.filter((e) => !e.cls.duplicate);

// --- format et horodatage
let descending = 0;
for (let i = 1; i < records.length; i++) if (records[i - 1].tsMs >= records[i].tsMs) descending += 1;
const offsets = records.map((r) => {
  // ecart entre l'heure murale lue comme de l'UTC et createdAt (epoch UTC) : revele le fuseau
  const createdAt = (r.json.server ?? r.json).createdAt;
  return Math.floor((r.tsMs + 2 * 3600e3 - createdAt) / 3600e3);
});

// --- trous : heures sans aucun enregistrement
const seenHours = new Set(events.map((e) => parisHour(e.ts)));
const emptyHours = [];
for (let t = Date.parse(events[0].ts); t <= Date.parse(events.at(-1).ts); t += 3600e3) if (!seenHours.has(parisHour(t))) emptyHours.push(parisHour(t));
let maxGap = { hours: 0 };
for (let i = 1; i < events.length; i++) {
  const hours = (Date.parse(events[i].ts) - Date.parse(events[i - 1].ts)) / 3600e3;
  if (hours > maxGap.hours) maxGap = { hours: Math.round(hours * 100) / 100, from: events[i - 1].ts, to: events[i].ts };
}

// --- numeros de sequence manquants (clients honnetes)
const byClient = new Map();
for (const e of uSpikes) {
  if (!byClient.has(e.cls.client)) byClient.set(e.cls.client, []);
  byClient.get(e.cls.client).push(e);
}
let expected = 0;
let received = 0;
for (const list of byClient.values()) {
  if (list.some((e) => e.cls.suspect)) continue;
  expected += Math.max(...list.map((e) => e.cls.seq));
  received += list.length;
}

const suspects = uSpikes.filter((e) => e.cls.suspect);
const floatCreatedAt = spikes.filter((e) => !Number.isInteger(e.server.createdAt));
const gameIds = new Set(uGames.map((e) => e.server.id));
const spikeServers = new Set(uSpikes.map((e) => e.server.id));
const short = uGames.filter((e) => e.cls.short);
const overlay = uSpikes.filter((e) => e.cls.cause === 'overlay');

const report = {
  volumetry: {
    bytes: Buffer.byteLength(raw), lines: lineCount, records: records.length, parseErrors: errors.length,
    spikes: spikes.length, games: games.length, from: events[0].ts, to: events.at(-1).ts,
    perDay: count(events, (e) => parisDay(e.ts)),
  },
  format: {
    descendingPairs: `${descending}/${records.length - 1}`,
    timezoneOffsetHoursVsCreatedAt: count(offsets, (o) => o),
    hour12: count(records, (r) => r.localText.slice(-2)),
    schemaVersions: count(uSpikes, (e) => e.cls.schema),
    schemaVersionsByBuild: count(uSpikes, (e) => `${e.report.build} v${e.cls.schema}`),
    nonIntegerCreatedAt: floatCreatedAt.length,
  },
  duplicates: {
    spikes: spikes.length - uSpikes.length, games: games.length - uGames.length,
    uniqueSpikes: uSpikes.length, uniqueGames: uGames.length,
  },
  gaps: { emptyHours, maxGap, sequence: { expected, received, missing: expected - received } },
  incoherences: {
    suspectReports: suspects.length,
    suspectClients: count(suspects, (e) => e.cls.client),
    violations: count(suspects.flatMap((e) => e.cls.violations), (v) => v),
    suspectFps: count(suspects, (e) => e.report.fps),
    suspectServersWithCompletedGame: suspects.filter((e) => gameIds.has(e.server.id)).length,
    spikeServersWithoutCompletedGame: [...spikeServers].filter((id) => !gameIds.has(id)).length,
    gamesWithoutSpike: [...gameIds].filter((id) => !spikeServers.has(id)).length,
  },
  typology: {
    causes: count(uSpikes, (e) => e.cls.cause),
    causesPerDay: Object.fromEntries(Object.keys(count(events, (e) => parisDay(e.ts))).sort().map((d) => [d, count(uSpikes.filter((e) => parisDay(e.ts) === d), (e) => e.cls.cause)])),
    overlayByBuild: Object.fromEntries(Object.entries(count(uSpikes, (e) => e.report.build)).sort().map(([b, n]) => [b, { reports: n, overlay: overlay.filter((e) => e.report.build === b).length }])),
    overlayWideBloom: count(overlay, (e) => e.cls.wideBloom),
    clients: byClient.size,
    clientsWideBloom: [...byClient.values()].filter((l) => l[0].cls.wideBloom).length,
    clientsWideBloomWithOverlay: [...byClient.values()].filter((l) => l[0].cls.wideBloom && l.some((e) => e.cls.cause === 'overlay' && e.report.build >= 'beta-20260924-3')).length,
  },
  games: {
    shortGames: short.length, shortByMap: count(short, (e) => e.server.map), shortScores: count(short, (e) => e.server.score.join('-')),
    shortVaultByNight: count(short.filter((e) => e.server.map === 'vault'), (e) => parisDay(e.ts)),
    quarantined: uGames.filter((e) => e.server.quarantined).length,
    degradedTick: count(uGames.filter((e) => e.server.tickGapMaxMs > 100), (e) => parisHour(e.ts)),
    twoPlayers: uGames.filter((e) => e.server.players === 2).length,
  },
};

if (values.json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  for (const [section, content] of Object.entries(report)) {
    process.stdout.write(`\n== ${section}\n`);
    for (const [k, v] of Object.entries(content)) process.stdout.write(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}\n`);
  }
}
