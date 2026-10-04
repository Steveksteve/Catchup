'use strict';

const client = require('prom-client');

// Toutes les metriques du service. Regle suivie pour les labels : uniquement des dimensions
// bornees (route, code, carte, cause, build). Tout ce qui identifie un joueur, un client ou
// une partie reste dans les logs.
function createMetrics({ build = 'unknown', version = '0.0.0', fleet = null } = {}) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const buildInfo = new client.Gauge({
    name: 'game_telemetry_build_info',
    help: 'Version deployee du service (valeur constante 1).',
    labelNames: ['build', 'version'],
    registers: [registry],
  });
  buildInfo.set({ build, version }, 1);

  // RED : un seul histogramme donne le debit (_count), les erreurs (label status_code) et la duree.
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duree des requetes HTTP par methode, route et code de reponse.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  const reportsRejected = new client.Counter({
    name: 'perf_reports_rejected_total',
    help: 'Rapports refuses a l ingestion, par motif.',
    labelNames: ['reason'],
    registers: [registry],
  });

  const reports = new client.Counter({
    name: 'perf_reports_total',
    help: 'Rapports de performance recus, par cause classee, build client et origine.',
    labelNames: ['cause', 'build', 'source'],
    registers: [registry],
  });

  const reportFrame = new client.Histogram({
    name: 'perf_report_frame_milliseconds',
    help: 'Duree de l image signalee par les rapports, par cause.',
    labelNames: ['cause'],
    buckets: [50, 100, 250, 500, 1000, 2500, 5000],
    registers: [registry],
  });

  const reportsSuspect = new client.Counter({
    name: 'perf_reports_suspect_total',
    help: 'Rapports qui violent un invariant physique, par controle echoue.',
    labelNames: ['check'],
    registers: [registry],
  });

  const gamesCreated = new client.Counter({
    name: 'game_games_created_total',
    help: 'Parties creees, par carte.',
    labelNames: ['map'],
    registers: [registry],
  });

  const gamesCompleted = new client.Counter({
    name: 'game_games_completed_total',
    help: 'Parties terminees, par carte, issue et mise en quarantaine.',
    labelNames: ['map', 'outcome', 'quarantined'],
    registers: [registry],
  });

  const gameDuration = new client.Histogram({
    name: 'game_duration_seconds',
    help: 'Duree de jeu des parties terminees, par carte.',
    labelNames: ['map'],
    buckets: [60, 120, 200, 300, 450, 600, 750, 900],
    registers: [registry],
  });

  const gamesActive = new client.Gauge({
    name: 'game_games_active',
    help: 'Parties en cours, par carte.',
    labelNames: ['map'],
    registers: [registry],
    collect() {
      this.reset();
      if (!fleet) return;
      for (const g of fleet.liveGames()) this.inc({ map: g.map });
    },
  });

  const tickGapMax = new client.Gauge({
    name: 'game_server_tick_gap_max_milliseconds',
    help: 'Plus grand ecart entre deux ticks parmi les parties en cours.',
    registers: [registry],
    collect() {
      const games = fleet ? fleet.liveGames() : [];
      this.set(games.reduce((m, g) => Math.max(m, g.tickGapMaxMs ?? 0), 0));
    },
  });

  function observeReport(report, cls, source) {
    reports.inc({ cause: cls.cause, build: cls.build, source });
    if (typeof report?.frameMs === 'number') reportFrame.observe({ cause: cls.cause }, report.frameMs);
    for (const check of cls.violations) reportsSuspect.inc({ check });
  }

  function observeGameCompleted(server, durationS) {
    const [a, b] = server.score ?? [0, 0];
    gamesCompleted.inc({ map: server.map, outcome: a > b ? 'win' : 'loss', quarantined: String(server.quarantined === true) });
    gameDuration.observe({ map: server.map }, durationS);
  }

  return {
    registry,
    httpDuration,
    reportsRejected,
    gamesCreated,
    gamesActive,
    tickGapMax,
    observeReport,
    observeGameCompleted,
  };
}

module.exports = { createMetrics };
