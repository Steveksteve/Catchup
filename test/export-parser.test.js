'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRng } = require('../src/prng');
const T = require('../src/telemetry');
const { parseExport, normalize } = require('../tools/export-parser');

function sample() {
  const rng = createRng(11);
  const c = T.makeClient(rng);
  const s = T.makeServer(rng, { createdAt: Date.UTC(2026, 8, 26, 20, 2) });
  const spike = T.spikeReport(rng, c, s, { cause: 'overlay', build: 'beta-20260924-3', now: Date.UTC(2026, 8, 26, 20, 5, 4) });
  s.phase = 'ended';
  s.score = [3, 1];
  const end = Date.UTC(2026, 8, 26, 20, 10, 0);
  // ordre de la console : le plus recent d'abord, et le rapport exporte deux fois
  return { text: [T.exportGame(s, end), T.exportSpike(spike), T.exportSpike(spike)].join('\n'), spike, end };
}

test("l'export multi-lignes est decoupe en enregistrements", () => {
  const { text } = sample();
  const { records, errors } = parseExport(text);
  assert.equal(errors.length, 0);
  assert.deepEqual(records.map((r) => r.kind), ['game_completed', 'perf_spike', 'perf_spike']);
});

test("l'heure locale 12 h est convertie en UTC (Paris, heure d'ete puis d'hiver)", () => {
  const { text, end } = sample();
  assert.equal(parseExport(text).records[0].tsMs, end);
  const winter = parseExport('Game completed abc · 12/1/2026, 12:00:05 AM\nvault · 3 - 0\n{"id":"abc","createdAt":0,"score":[3,0]}\n').records[0];
  assert.equal(new Date(winter.tsMs).toISOString(), '2026-11-30T23:00:05.000Z');
});

test('normalize trie par date croissante, marque les doublons et classe', () => {
  const { text } = sample();
  const events = normalize(parseExport(text).records);
  assert.deepEqual(events.map((e) => e.event), ['perf_spike', 'perf_spike', 'game_completed']);
  assert.deepEqual(events.map((e) => e.cls.duplicate), [false, true, false]);
  assert.equal(events[0].cls.cause, 'overlay');
  assert.equal(events[2].cls.durationS, 480);
  assert.equal(events[2].cls.short, false);
});

test('un bloc JSON tronque est signale, pas ignore', () => {
  const { errors, records } = parseExport('Game completed abc · 9/26/2026, 1:00:00 PM\nvault · 3 - 0\n{"id":\n');
  assert.equal(records.length, 0);
  assert.equal(errors.length, 1);
});
