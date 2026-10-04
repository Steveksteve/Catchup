'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRng } = require('../src/prng');
const T = require('../src/telemetry');
const { classify } = require('../src/classify');

const EXPECTED = { generic: 'render_generic', overlay: 'overlay', shader: 'shader_compile', hidden: 'tab_hidden', world: 'world', network: 'network' };

function make(cause, { version = 1, seed = 7 } = {}) {
  const rng = createRng(seed);
  const c = T.makeClient(rng);
  const s = T.makeServer(rng, { createdAt: Date.now() });
  return T.spikeReport(rng, c, s, { cause, build: 'beta-20260924-3', now: Date.now(), version }).report;
}

for (const [cause, expected] of Object.entries(EXPECTED)) {
  test(`un rapport ${cause} est classe ${expected} (schemas v1 et v2)`, () => {
    for (let seed = 1; seed <= 50; seed++) {
      for (const version of [1, 2]) {
        const cls = classify(make(cause, { version, seed }));
        assert.equal(cls.cause, expected);
        assert.equal(cls.suspect, false);
      }
    }
  });
}

test('rttMs est lu au bon endroit selon le schema', () => {
  assert.equal(typeof classify(make('generic', { version: 1 })).rttMs, 'number');
  assert.equal(typeof classify(make('generic', { version: 2 })).rttMs, 'number');
});

test('un rapport falsifie est marque suspect avec le controle echoue', () => {
  const r = make('generic');
  r.fps = 999;
  r.work.stages.render = -30.6;
  r.work.totalMs = r.frameMs + 300;
  const cls = classify(r);
  assert.equal(cls.suspect, true);
  assert.deepEqual(cls.violations.sort(), ['fps_above_cap', 'frame_shorter_than_work', 'negative_duration', 'render_sum_mismatch']);
});

test('un build hors motif ne cree pas de nouvelle valeur de label', () => {
  const r = make('generic');
  r.build = 'x'.repeat(40);
  assert.equal(classify(r).build, 'other');
});

test('un rapport minimal ne fait pas planter la classification', () => {
  const cls = classify({ id: 'P-0123abcd-1' });
  assert.equal(cls.cause, 'unknown');
  assert.equal(cls.client, '0123abcd');
});
