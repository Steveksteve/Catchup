'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createMetrics } = require('../src/metrics');

async function withServer(fn) {
  const metrics = createMetrics({ build: 'beta-test', version: 'test' });
  const app = createApp({ fleet: null, log: () => {}, metrics });
  const server = app.listen(0);
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const post = (base, body) => fetch(`${base}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('GET /metrics expose les metriques RED et metier', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/healthz`);
    await post(base, { report: { id: 'P-0123abcd-1' }, server: { id: 'x' } });
    await post(base, {});
    await post(base, { report: { id: 'garbage' }, server: { id: 'x' } });
    const r = await fetch(`${base}/metrics`);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /http_request_duration_seconds_count\{method="GET",route="\/healthz",status_code="200"\} 1/);
    assert.match(text, /perf_reports_total\{cause="unknown",build="other",source="ingest"\} 1/);
    assert.match(text, /perf_reports_rejected_total\{reason="malformed"\} 1/);
    assert.match(text, /perf_reports_rejected_total\{reason="invalid_id"\} 1/);
    assert.match(text, /game_telemetry_build_info\{build="beta-test",version="test"\} 1/);
  });
});

test('une URL inconnue ne cree pas une serie par chemin', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/nope/1`);
    await fetch(`${base}/nope/2`);
    const text = await (await fetch(`${base}/metrics`)).text();
    assert.match(text, /route="unmatched",status_code="404"\} 2/);
    assert.doesNotMatch(text, /nope/);
  });
});
