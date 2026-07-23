# VeilleAnalytics

[![CI](https://github.com/antoinecoulon/veille-analytics/actions/workflows/ci.yml/badge.svg)](https://github.com/antoinecoulon/veille-analytics/actions/workflows/ci.yml)

Pipeline de veille technologique automatisé avec analytics et classification ML.

## Qu'est-ce que c'est ?

Un outil personnel qui collecte des articles tech via des flux RSS, les classifie avec Mistral AI, les stocke dans une base cloud (Cloudflare D1) et les expose via une API. Une seconde classification par modèle ML tourne en parallèle, et un dashboard BI ([`veille-dashboard`](https://github.com/antoinecoulon/veille-dashboard)) rend les deux comparables.

## Architecture

```
Node-RED (local)          Cloudflare Worker         Dashboard
Collecte RSS          →   API ingestion + lecture  →  Nuxt 4 / Cloudflare Workers
Classification Mistral     Cloudflare D1 (SQLite)       proxy /api → Worker
Email récapitulatif        Cloudflare KV (auth API)     Better Auth / D1 dédiée
```

## Stack

| Composant | Technologie |
|---|---|
| Collecte & orchestration | Node-RED |
| Classification | Mistral AI (open-mistral-nemo) |
| ETL + API | Cloudflare Workers |
| Base de données | Cloudflare D1 (SQLite) |
| Authentification API (ingestion) | Cloudflare KV |
| Dashboard | Nuxt 4 sur Cloudflare Workers |
| Authentification dashboard | Better Auth (cœur) + D1 dédiée |
| Classification ML | Hugging Face Inference API (mDeBERTa-v3 XNLI, zero-shot) |
| IaC | Terraform (D1 + KV) |
| CI/CD | GitHub Actions (typecheck + lint + tests + deploy Worker) |
| Tests | Vitest + @cloudflare/vitest-pool-workers (D1 Miniflare) — 140 tests / 7 fichiers |
| Qualité | ESLint + SonarCloud (quality gate en CI) |

L'hébergement d'un **Space Hugging Face** a été envisagé puis abandonné en juillet 2026 : CPU basic
et ZeroGPU sont passés derrière un compte payant. La classification ML passe donc par l'**Inference
API serverless**, appelée directement depuis le Worker (`src/lib/classifyMl.ts`). Un modèle
CamemBERT affiné sur le corpus a également été évalué hors ligne ; il ne bat pas Mistral et n'est
pas déployé.

## Installation

### Prérequis

- Node.js >= 18
- pnpm
- Un compte Cloudflare (gratuit)
- Node-RED (pour la collecte)

### Setup

```bash
pnpm install
export CLOUDFLARE_API_TOKEN="token"
npx wrangler whoami
```

### Jetons (KV `AUTH`)

Deux jetons distincts, deux droits distincts, stockés dans le même namespace KV :

| Clé | Porteur | Donne le droit de |
|---|---|---|
| `API_TOKEN` | le flux Node-RED | ingérer un article (`POST /api/ingest`, en-tête `Authorization: Bearer`) |
| `READ_TOKEN` | le dashboard | lire les articles et les statistiques (en-tête `X-Dashboard-Token`) |

`READ_TOKEN` a été introduit par C18 : les routes de lecture répondaient auparavant à
quiconque connaissait l'URL du Worker, laquelle est publique. `GET /api/stats/health` et la
route de repli restent volontairement ouvertes — supervision hors session, aucune donnée
rendue. Le dashboard doit porter la même valeur dans son secret `NUXT_WORKER_READ_TOKEN`.

```bash
npx wrangler kv key put --binding AUTH --remote READ_TOKEN "<valeur>"
```

### Déploiement du Worker

Automatique via GitHub Actions : chaque push sur `main` déclenche le job `deploy`
(`.github/workflows/ci.yml`) après le passage du typecheck + lint + tests. Déploiement manuel
possible en local :

```bash
npx wrangler deploy
```

### Tests

```bash
pnpm test          # 140 tests / 7 fichiers (vérifié le 2026-07-23)
```

Tests unitaires (normalisation, agrégats, comparaison ML, santé) et d'intégration (endpoints sur
une D1 Miniflare réelle chargée avec le schéma de production) via
`@cloudflare/vitest-pool-workers`. Lancés aussi dans le job `quality` de la CI.

### Infrastructure (Terraform)

L'infrastructure durable (bases D1 des deux projets + namespace KV) est décrite en code dans
[`terraform/`](terraform/). Le code des Workers reste déployé par wrangler / Workers Builds —
voir le [README dédié](terraform/README.md) pour le détail du découpage IaC / CD.

### Base de données

```bash
# Créer la base
npx wrangler d1 create veille-analytics

# Appliquer les migrations
npx wrangler d1 migrations apply veille-analytics --remote
```

`migrations/` ne contient que du **schéma**, applicable sans réfléchir sur tous les
environnements ; les correctifs de **données** vivent dans `scripts/sql-ponctuels/` et se jouent
un par un. La règle et ce qui l'a motivée sont dans [`migrations/README.md`](migrations/README.md).

### Agrégat décisionnel (`dim_date` + `agg_quotidien`)

Le schéma est en étoile : `articles` est la table de faits, `dim_date` la dimension calendaire et
`agg_quotidien` l'agrégat pré-calculé par jour et par thématique. L'agrégat est **maintenu à
l'écriture** — chaque ingestion recalcule le jour concerné — et lu par `GET /api/stats/timeline`
(cf. ADR D11).

Chaque jour porte, en plus de ses lignes par thème, une **ligne de rollup** (`thematique IS NULL`)
avec le total : sommer les lignes par thème double-compterait les articles multi-thèmes.

Reconstruction complète, idempotente, à lancer si un rafraîchissement a échoué ou après une
modification en masse des faits :

```bash
npx wrangler d1 execute veille-analytics --remote --file scripts/rebuild-aggregates.sql
```

Contrôle croisé — doit renvoyer **zéro ligne**, l'agrégat et le calcul à la volée devant concorder :

```sql
SELECT a.date, a.nb_articles, v.count
FROM (SELECT date, nb_articles FROM agg_quotidien WHERE thematique IS NULL) a
JOIN (SELECT strftime('%Y-%m-%d', date_article) AS jour, COUNT(*) AS count
      FROM articles WHERE date_article IS NOT NULL GROUP BY jour) v
  ON a.date = v.jour
WHERE a.nb_articles <> v.count;
```

### KPI du processus de veille (baseline avant/après)

`scripts/kpi-baseline.sql` mesure l'impact de l'industrialisation sur le processus lui-même :
volume, régularité, fraîcheur des articles, biais de classification, couverture — avant
(pipeline Node-RED seul, jusqu'au 2026-03-27) et après (pipeline D1, à partir du 2026-04-09).

La frontière est fiable parce que `scripts/migrate.js` a conservé l'horodatage `analyzedAt` de
Node-RED comme `date_collecte` des articles migrés : la période antérieure est réellement mesurée,
pas reconstituée.

```bash
npx wrangler d1 execute veille-analytics --remote --json \
  --command "$(grep -v '^\s*--' scripts/kpi-baseline.sql | tr '\n' ' ')"
```

Lecture seule. **Ne pas utiliser `--file`** : ce mode n'affiche qu'un résumé, jamais les lignes d'un
SELECT. Le retrait des commentaires évite de dépasser la limite de longueur de ligne de commande.

Analyse des résultats dans
[`preparation-titre-eadl/m3/04-baseline-kpi.md`](https://github.com/antoinecoulon/preparation-titre-eadl/blob/main/m3/04-baseline-kpi.md).

### Annotation manuelle (jeu de validation — Étape 12)

Construit un jeu de validation indépendant (~100 articles annotés à la main) pour évaluer plus
tard la classification thématique (Mistral, puis modèle ML). Les thèmes de référence sont
**séparés** de la prédiction `themes_mistral`.

```bash
# 1. Exporter les articles de la D1 distante
npx wrangler d1 execute veille-analytics --remote --json \
  --command "SELECT id, titre, resume, source, url, themes_mistral, date_article FROM articles ORDER BY id" \
  > data/articles_export.json

# 2. Échantillon stratifié ~100 (couvre les 7 thèmes + diversifie les sources)
node scripts/sample-annotation.mjs

# 3. Générer la page d'annotation (les suggestions aveugles vivent dans data/annotation_suggestions.json)
node scripts/build-annotation-page.mjs

# 4. Ouvrir annotation/index.html dans un navigateur, réviser les thèmes, « Exporter CSV »
#    puis déposer le fichier téléchargé dans data/annotations.csv

# 5. Valider + canonicaliser le CSV, afficher distribution et concordance brute vs Mistral
node scripts/finalize-annotations.mjs
```

Le livrable est `data/annotations.csv` (`id, themes_manuels` ; thèmes `|`-séparés).

### Batch PySpark (Étape 16)

Analyse distribuée locale (fréquences par thème, cooccurrences de tags, tendances hebdomadaires).
Détails, prérequis et pièges rencontrés dans [`spark/README.md`](spark/README.md).

```bash
# 1. Export D1 → JSON
npx wrangler d1 execute veille-analytics --remote --json --command \
  "SELECT id, titre, url, source, date_article, themes_mistral, themes_ml, score_confiance_ml, tags FROM articles" \
  > data/articles_spark.json

# 2. Conversion JSON → CSV
node scripts/export-spark-csv.mjs

# 3. Exécution du batch (le venv du batch doit être activé, cf. spark/README.md)
source spark/.venv/bin/activate
spark-submit spark/analyse.py
```

## API

Sept routes, deux autorisations distinctes. Le **contrat complet** — paramètres, schémas de
réponse, codes d'erreur et comportements de bord — est dans
[`docs/003-api.md`](docs/003-api.md).

| Route | En-tête requis |
|---|---|
| `POST /api/ingest` | `Authorization: Bearer <API_TOKEN>` |
| `GET /api/articles` | `X-Dashboard-Token: <READ_TOKEN>` |
| `GET /api/stats/themes` | `X-Dashboard-Token` |
| `GET /api/stats/sources` | `X-Dashboard-Token` |
| `GET /api/stats/timeline` | `X-Dashboard-Token` |
| `GET /api/stats/ml-comparison` | `X-Dashboard-Token` |
| `GET /api/stats/health` | aucun — supervision, ne rend aucune donnée |

## Avancement

- [x] Phase 1 — Fondations (collecte, ETL, D1, migration historique)
- [x] Phase 2 — API lecture + Dashboard + CI/CD
- [x] Phase 3 — ML + Analytics (classification ML, comparaison Mistral/ML, PySpark, fine-tuning)
- [ ] Phase 4 — Finalisation *(en cours : preuves, documentation, rédaction M3.2)*

## Contexte

Projet personnel réalisé dans le cadre du titre EADL (Expert Architecte en Développement Logiciel) à l'ENI. Il complète les compétences acquises en entreprise sur les blocs 4 (Cloud), 5.1 (Data/BI) et 5.2 (IA/MLOps).

## Usage d'IA

- **Mistral AI** (`open-mistral-nemo`) : classification des articles — catégorie, score, thèmes —
  appelée depuis Node-RED à la collecte.
- **mDeBERTa-v3 XNLI** (Hugging Face Inference API) : seconde classification zero-shot, asynchrone,
  déclenchée par le Worker à l'ingestion.
- **CamemBERT affiné** sur le corpus : évalué hors ligne, non déployé — il ne bat pas Mistral.
- **Claude (Anthropic)** : aide à la conception, à la rédaction de la documentation et des ADR,
  et à la relecture. Toute production est relue et toute commande exécutée avant d'être retenue.

Les trois classificateurs ont été évalués **contre un jeu de 100 articles annotés à la main**
(`data/annotations.csv`), et non l'un contre l'autre : la démarche et ses résultats — y compris le
résultat négatif du modèle affiné — sont détaillés dans le rapport M3.
