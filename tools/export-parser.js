'use strict';

// Lecture de l'export brut de la console d'administration.
//
// Pieges traites ici :
//  1. format multi-lignes : un en-tete texte, un sous-titre, puis un bloc JSON indente ;
//  2. horodatage en heure locale americaine sur 12 h ("9/26/2026, 10:23:04 PM"), sans fuseau ;
//  3. fuseau : heure de Paris (verifie contre server.createdAt, qui est en epoch UTC) ;
//  4. ordre antichronologique (le plus recent en premier) ;
//  5. doublons exacts (meme enregistrement exporte deux fois) ;
//  6. deux schemas de rapport (v1 : report.rttMs, v2 : report.network.rttMs + etape physics) ;
//  7. valeurs falsifiees (controles d'integrite dans src/classify.js).

const { classify } = require('../src/classify');

const HEADER_RE = /^(Performance spike|Game completed) (\S+) · (\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/;
const SHORT_GAME_S = 200;

// Decalage (ms) du fuseau a un instant donne, sans dependance externe.
function tzOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

// "9/26/2026, 10:23:04 PM" (heure murale) -> epoch ms UTC
function parseLocal(m, timeZone) {
  let hour = Number(m[6]) % 12;
  if (m[9] === 'PM') hour += 12;
  const wall = Date.UTC(Number(m[5]), Number(m[3]) - 1, Number(m[4]), hour, Number(m[7]), Number(m[8]));
  // deux passes : la seconde corrige un eventuel changement d'heure entre les deux estimations
  let utc = wall - tzOffsetMs(wall, timeZone);
  utc = wall - tzOffsetMs(utc, timeZone);
  return utc;
}

/**
 * Decoupe le texte en enregistrements { kind, serverId, tsMs, lineNo, subtitle, json }.
 * Les blocs illisibles sont renvoyes dans `errors` plutot que jetes silencieusement.
 */
function parseExport(text, { timeZone = 'Europe/Paris' } = {}) {
  const lines = text.split(/\r?\n/);
  const records = [];
  const errors = [];
  let i = 0;
  while (i < lines.length) {
    const m = HEADER_RE.exec(lines[i]);
    if (!m) {
      if (lines[i].trim() !== '') errors.push({ lineNo: i + 1, error: 'ligne hors enregistrement', text: lines[i].slice(0, 80) });
      i += 1;
      continue;
    }
    const lineNo = i + 1;
    const subtitle = lines[i + 1] ?? '';
    let j = i + 2;
    const body = [];
    while (j < lines.length && !HEADER_RE.test(lines[j])) body.push(lines[j++]);
    try {
      records.push({
        kind: m[1] === 'Performance spike' ? 'perf_spike' : 'game_completed',
        serverId: m[2],
        tsMs: parseLocal(m, timeZone),
        localText: lines[i].split(' · ')[1],
        lineNo,
        subtitle,
        json: JSON.parse(body.join('\n')),
      });
    } catch (err) {
      errors.push({ lineNo, error: `JSON invalide : ${err.message}` });
    }
    i = j;
  }
  return { records, errors, lineCount: lines.length };
}

/**
 * Transforme les enregistrements en evenements au schema des logs en direct, tries par
 * date croissante, enrichis d'un bloc `cls` (classification, doublon, duree).
 * Les doublons sont conserves et marques : ils restent comptables dans Loki.
 */
function normalize(records) {
  const seen = new Set();
  const events = records.map((r) => {
    const base = { ts: new Date(r.tsMs).toISOString(), event: r.kind, origin: 'admin-export', exportLine: r.lineNo };
    if (r.kind === 'perf_spike') {
      const { report, server } = r.json;
      const key = `spike:${report.id}`;
      const duplicate = seen.has(key);
      seen.add(key);
      return { ...base, level: 'warn', report, server, cls: { ...classify(report), duplicate } };
    }
    const server = r.json;
    const key = `game:${server.id}`;
    const duplicate = seen.has(key);
    seen.add(key);
    const durationS = Math.round((r.tsMs - server.createdAt) / 1000);
    return { ...base, level: 'info', server, cls: { durationS, short: durationS < SHORT_GAME_S, duplicate } };
  });
  return events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.exportLine - b.exportLine));
}

module.exports = { parseExport, normalize, parseLocal, tzOffsetMs, HEADER_RE, SHORT_GAME_S };
