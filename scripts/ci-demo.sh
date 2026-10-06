#!/usr/bin/env bash
# Cree les deux branches qui prouvent que le pipeline bloque :
#   demo/failing-test   -> un test echoue, le job "Lint et tests" est rouge, aucune image n'est construite
#   demo/critical-vuln  -> une dependance avec une CVE critique, Trivy fait echouer le job avant la publication
# Usage : scripts/ci-demo.sh   (depuis main, arbre de travail propre)
set -euo pipefail

if [ -n "$(git status --porcelain)" ]; then
  echo "Arbre de travail non propre : commit ou stash d'abord." >&2
  exit 1
fi
base=$(git rev-parse --abbrev-ref HEAD)

git switch -C demo/failing-test "$base"
cat > test/demo-fail.test.js <<'JS'
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('demonstration : ce test echoue volontairement', () => {
  assert.equal(1 + 1, 3);
});
JS
git add test/demo-fail.test.js
git commit -m "demo: test en echec pour prouver que le pipeline bloque"
git push -u origin demo/failing-test --force

git switch -C demo/critical-vuln "$base"
# lodash 4.17.4 : CVE-2019-10744 (pollution de prototype, CRITICAL, corrigee en 4.17.12)
npm install --save-exact lodash@4.17.4
git add package.json package-lock.json
git commit -m "demo: dependance avec CVE critique pour prouver que Trivy bloque"
git push -u origin demo/critical-vuln --force

git switch "$base"
echo "Branches poussees. Voir l'onglet Actions : les deux executions doivent etre rouges."
