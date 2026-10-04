'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { Fleet } = require('./fleet');
const { createMetrics } = require('./metrics');
const { classify } = require('./classify');
const { version } = require('../package.json');

const PORT = Number(process.env.PORT ?? 8080);
const LOG_FILE = process.env.LOG_FILE ?? path.join(__dirname, '..', 'logs', 'telemetry.log');
const BUILD = process.env.BUILD ?? 'beta-20260926-6';

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

const log = (obj) => {
  const line = JSON.stringify(obj);
  stream.write(line + '\n');
  if (process.env.LOG_STDOUT !== '0') process.stdout.write(line + '\n');
};

const SPEED = Number(process.env.SPEED ?? 10);

const fleet = new Fleet({
  build: BUILD,
  gamesPerMinute: Number(process.env.GAMES_PER_MINUTE ?? 4),
  speed: SPEED,
  incidents: process.env.INCIDENTS !== '0',
});
const metrics = createMetrics({ build: BUILD, version, fleet });

// Chaque evenement de la flotte alimente les metriques, puis part dans les logs enrichi
// d'un bloc "cls" (classification) : meme schema que l'export historique importe.
fleet.on('log', (entry) => {
  if (entry.event === 'game_created') {
    metrics.gamesCreated.inc({ map: entry.server.map });
  } else if (entry.event === 'game_completed') {
    // La simulation est acceleree : la duree de jeu est la duree reelle multipliee par SPEED.
    const durationS = Math.round(((Date.parse(entry.ts) - entry.server.createdAt) / 1000) * SPEED);
    entry.cls = { durationS, short: durationS < 200 };
    metrics.observeGameCompleted(entry.server, durationS);
  } else if (entry.event === 'perf_spike') {
    entry.cls = classify(entry.report);
    metrics.observeReport(entry.report, entry.cls, 'fleet');
  }
  log(entry);
});
fleet.start();

const app = createApp({ fleet, log, metrics });
const server = app.listen(PORT, () => {
  log({ ts: new Date().toISOString(), level: 'info', event: 'startup', port: PORT, build: BUILD });
});

const shutdown = () => {
  fleet.stop();
  server.close(() => stream.end(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
