# game-telemetry-demo

Service de télémétrie d'un jeu de tir multijoueur web (parties de 1 à 2 joueurs contre des bots), avec sa chaîne d'intégration continue et sa stack d'observabilité : Loki, Alloy, Prometheus, Grafana.

## Démarrage

Prérequis : Docker avec Compose v2.

```bash
docker compose up -d --build
```

Cette commande construit l'image, puis lance le service, le générateur de charge, l'import de l'export historique et toute la stack d'observabilité.

| Service | Adresse | Rôle |
|---|---|---|
| Grafana | http://localhost:3000 | Tableaux de bord, dossier « Game Telemetry » (lecture anonyme, admin/admin pour éditer) |
| Prometheus | http://localhost:9090 | Métriques, recording rules, alertes |
| Loki | http://localhost:3100 | Logs en direct et export historique |
| Alloy | http://localhost:12345 | Agent de collecte des logs |
| API | http://localhost:8080 | `/healthz`, `/api/games`, `/api/reports`, `/metrics` |

L'export historique devient interrogeable dans Grafana **au plus tard 15 minutes après le premier démarrage** : Loki écrit les chunks tout de suite mais ne construit l'index des données anciennes que par période de 15 minutes. `docker compose logs export-import` montre le résumé de l'import.

Les tableaux de bord 2 et 3 s'ouvrent sur la semaine de l'export (20 au 26 septembre 2026, variable `Source` = `export`). Le lien « En direct » en haut de chaque tableau bascule sur les logs du service en cours d'exécution.

Arrêt : `docker compose down` (ajouter `-v` pour supprimer les données).

## Développement

```bash
npm ci
npm start                  # API sur :8080, logs JSON lines dans logs/telemetry.log et stdout
npm test
npm run lint
npm run loadgen -- --rps 5 --burst-every 120 --burst-rps 80
```

Variables d'environnement : `PORT`, `LOG_FILE`, `LOG_STDOUT` (0 pour couper stdout), `BUILD`, `GAMES_PER_MINUTE`, `SPEED`, `INCIDENTS` (0 pour désactiver).

## Organisation du dépôt

```
src/                    service : API, simulation de la flotte, classification, métriques
tools/                  lecture de l'export, import dans Loki, rapport de qualité
scripts/                générateur de charge, démonstration des échecs du pipeline
test/                   tests (node --test)
observability/
  alloy/                collecte des logs en direct
  loki/                 configuration et règles d'alerte sur les logs
  prometheus/           scraping, recording rules, alertes
  grafana/              datasources et tableaux de bord provisionnés
docs/                   rapport, qualité des données, figures
.github/workflows/      pipeline CI
```

## Pipeline CI

`.github/workflows/ci.yml` (GitHub Actions) :

1. **Lint et tests** : `npm run lint`, `npm test`. Un échec arrête tout.
2. **Image** : construction multi-étapes, test de fumée (l'image démarre sans root et répond), analyse Trivy. Une vulnérabilité CRITICAL corrigeable fait échouer le job avant la publication.
3. **Publication** sur `ghcr.io/<propriétaire>/<dépôt>` avec le tag `sha-<commit court>`, le nom de branche, et `latest` sur la branche par défaut.
4. **Validation du déploiement** : `docker compose config` et `promtool check rules`.

Démontrer les deux cas d'échec :

```bash
scripts/ci-demo.sh
```

Le script pousse deux branches. `demo/failing-test` ajoute un test faux : le job « Lint et tests » échoue et aucune image n'est construite. `demo/critical-vuln` ajoute `lodash@4.17.4` (CVE-2019-10744, critique) : Trivy fait échouer le job « Image » et rien n'est publié.

## Image

- Trois étapes : dépendances de production, assemblage, exécution.
- Base d'exécution `gcr.io/distroless/nodejs22-debian12:nonroot` : ni shell, ni npm, ni gestionnaire de paquets.
- Utilisateur 65532, système de fichiers en lecture seule dans Compose, toutes les capacités Linux retirées. Seul le volume des logs est inscriptible.

## Logs

Le service écrit une ligne JSON par événement (`startup`, `game_created`, `game_completed`, `perf_spike`, `http_request`, `http_error`). Chaque `perf_spike` et `game_completed` porte un bloc `cls` calculé par `src/classify.js` : cause classée, client, contrôles d'intégrité, durée de partie.

Labels Loki : `service`, `source` (`live` ou `export`), `event`, `level`. Le client, la partie, le build et la carte restent dans la ligne et se filtrent avec `| json`.

### Export historique

`data/admin-export-2026-09-20_26.log` est l'export brut de la console d'administration : texte multi-lignes, heure locale américaine sur 12 h sans fuseau, ordre antichronologique, doublons.

```bash
node tools/quality-report.js                       # constats chiffrés sur l'export
node tools/import-export.js --dry-run              # lecture seule
node tools/import-export.js --loki http://localhost:3100   # import (fait automatiquement par Compose)
```

## Métriques

`GET /metrics` (prom-client). Voir `src/metrics.js` pour le détail et `docs/rapport.pdf` pour la justification de chaque métrique.

## Alertes

- `observability/prometheus/rules/alerts.yml` : disponibilité, erreurs, latence, régression overlay par build, farming, ticks serveur, rapports falsifiés.
- `observability/loki/rules/fake/alerts.yml` : règles par client, impossibles à porter par un label Prometheus.

Les règles sont visibles dans Prometheus (`/alerts`) et dans Grafana (Alerting, Alert rules). Aucun Alertmanager n'est déployé : les alertes sont évaluées et affichées, pas notifiées.
