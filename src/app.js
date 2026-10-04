'use strict';

const express = require('express');
const { classify } = require('./classify');

// Application HTTP : ingestion des rapports clients + consultation des parties en cours.
function createApp({ fleet, log, metrics = null }) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
      // req.route.path est le gabarit de route (cardinalite bornee) ; une URL inconnue devient "unmatched".
      const route = req.route?.path ?? 'unmatched';
      if (route !== '/metrics') metrics?.httpDuration.observe({ method: req.method, route, status_code: res.statusCode }, durationMs / 1000);
      log({ ts: new Date().toISOString(), level: 'info', event: 'http_request', method: req.method, path: req.route?.path ?? req.path, status: res.statusCode, durationMs: Math.round(durationMs * 100) / 100 });
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.get('/metrics', async (req, res) => {
    if (!metrics) return res.status(404).end();
    res.set('Content-Type', metrics.registry.contentType);
    return res.end(await metrics.registry.metrics());
  });

  app.get('/api/games', (req, res) => res.json(fleet ? fleet.liveGames() : []));

  app.post('/api/reports', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || !body.report || !body.server) {
      metrics?.reportsRejected.inc({ reason: 'malformed' });
      return res.status(400).json({ error: 'expected { report, server }' });
    }
    const { report } = body;
    if (typeof report.id !== 'string' || !/^P-[0-9a-f]{8}-\d+$/.test(report.id)) {
      metrics?.reportsRejected.inc({ reason: 'invalid_id' });
      return res.status(422).json({ error: 'invalid report id' });
    }
    // Simule un traitement plus lent quand le rapport est gros (analyse, enrichissement)
    const size = JSON.stringify(body).length;
    const busy = Date.now() + Math.min(40, size / 400);
    while (Date.now() < busy) { /* travail synchrone volontaire */ }
    const cls = classify(report);
    metrics?.observeReport(report, cls, 'ingest');
    log({ ts: new Date().toISOString(), level: 'warn', event: 'perf_spike', source: 'ingest', report, server: body.server, cls });
    return res.status(202).json({ accepted: report.id });
  });

  app.use((err, req, res, _next) => {
    log({ ts: new Date().toISOString(), level: 'error', event: 'http_error', message: err.message, path: req.path });
    res.status(err.status ?? 500).json({ error: 'internal' });
  });

  return app;
}

module.exports = { createApp };
