'use strict';

// Classification automatique d'un rapport "Performance spike" et controles d'integrite.
//
// Les seuils viennent de l'export de production du 20 au 26 septembre 2026 (2 110 rapports
// uniques) : pour chaque signature, la valeur "normale" et la valeur "en incident" sont
// separees par un ordre de grandeur, le seuil est place dans l'intervalle vide.
//
//   signature            normal (max)   incident (min)   seuil
//   renderOverlay (ms)        3.0           222.8          100
//   worldDynamics (ms)        0.4            70.3           30
//   newPrograms               2              40             20
//   rtt (ms)                 60.0           182.2          150
const THRESHOLDS = Object.freeze({
  overlayMs: 100,
  worldDynamicsMs: 30,
  newPrograms: 20,
  rttMs: 150,
  fpsMax: 144, // plafond du client de jeu
  sumToleranceMs: 1,
});

const CAUSES = Object.freeze(['network', 'tab_hidden', 'shader_compile', 'overlay', 'world', 'render_generic', 'unknown']);

const BUILD_RE = /^beta-\d{8}-\d+$/;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// rttMs a change de place entre le schema v1 (report.rttMs) et v2 (report.network.rttMs).
function rttOf(report) {
  return num(report?.rttMs) ?? num(report?.network?.rttMs);
}

// Identifiant client : P-<client>-<sequence>
function clientOf(report) {
  const m = /^P-([0-9a-f]{8})-(\d+)$/.exec(report?.id ?? '');
  return m ? { client: m[1], seq: Number(m[2]) } : { client: 'invalid', seq: null };
}

// Build borne a un motif connu : la valeur vient du client, elle ne doit pas pouvoir
// faire exploser la cardinalite d'un label Prometheus.
function buildLabel(report) {
  return BUILD_RE.test(report?.build ?? '') ? report.build : 'other';
}

function causeOf(report) {
  const details = report?.work?.details;
  const graphics = report?.graphics;
  if (!details || !graphics) return 'unknown';
  const rtt = rttOf(report);
  if (report.reason === 'network' || (rtt !== undefined && rtt >= THRESHOLDS.rttMs)) return 'network';
  if ((report.activities ?? []).some((a) => a?.name === 'visibilityHidden')) return 'tab_hidden';
  if (graphics.firstCapture === true || num(graphics.newPrograms) >= THRESHOLDS.newPrograms) return 'shader_compile';
  if (num(details.renderOverlay) >= THRESHOLDS.overlayMs) return 'overlay';
  if (num(details.worldDynamics) >= THRESHOLDS.worldDynamicsMs) return 'world';
  return 'render_generic';
}

// Un rapport honnete respecte des invariants physiques. Chaque violation est nommee.
function integrityViolations(report) {
  const out = [];
  const work = report?.work;
  if (!work?.stages || !work?.details) return out;
  const values = [...Object.values(work.stages), ...Object.values(work.details)];
  if (values.some((v) => num(v) !== undefined && v < 0)) out.push('negative_duration');
  if (num(report.fps) > THRESHOLDS.fpsMax) out.push('fps_above_cap');
  if (num(report.frameMs) !== undefined && num(work.totalMs) !== undefined && report.frameMs + THRESHOLDS.sumToleranceMs < work.totalMs) {
    out.push('frame_shorter_than_work');
  }
  const d = work.details;
  const renderSum = (num(d.renderShadows) ?? 0) + (num(d.renderWorld) ?? 0) + (num(d.renderPostprocess) ?? 0) + (num(d.renderOverlay) ?? 0);
  if (num(work.stages.render) !== undefined && Math.abs(renderSum - work.stages.render) > THRESHOLDS.sumToleranceMs) out.push('render_sum_mismatch');
  return out;
}

function classify(report) {
  const { client, seq } = clientOf(report);
  const violations = integrityViolations(report);
  const g = report?.graphics ?? {};
  return {
    cause: causeOf(report),
    client,
    seq,
    build: buildLabel(report),
    schema: num(report?.version) ?? 0,
    rttMs: rttOf(report) ?? null,
    wideBloom: num(g.width) >= 2560 && g.bloom === true,
    suspect: violations.length > 0,
    violations,
  };
}

module.exports = { THRESHOLDS, CAUSES, classify, causeOf, integrityViolations, rttOf, clientOf, buildLabel };
