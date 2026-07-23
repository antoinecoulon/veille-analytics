# CLAUDE.md — veille-analytics (Worker Cloudflare + D1)

Backend du projet **VeilleAnalytics** : ingestion, stockage et exposition d'articles de veille
technologique, avec double classification thématique (Mistral + ML).

Projet personnel réalisé dans le cadre du titre **EADL** (RNCP 39765) — il couvre les blocs
4 (Cloud), 5.1 (Data/BI) et 5.2 (IA/MLOps), non couverts en entreprise.

## Écosystème (4 repos distincts, pas un monorepo)

| Repo | Rôle |
|---|---|
| **`veille-analytics`** (ici) | Worker Cloudflare : ingestion, API lecture, classification ML, D1, Terraform, batch PySpark |
| `veille-dashboard` | Front Nuxt 4 sur Workers, auth Better Auth, proxy BFF vers ce Worker |
| `veille-ml` | Python : zero-shot mDeBERTa, fine-tuning CamemBERT, évaluation (vit **côté WSL**) |
| `preparation-titre-eadl` | Documents EADL, plan d'action détaillé, livrables M1/M2 |

Le **plan d'action complet et à jour** (20 étapes, décisions et pièges par étape) est dans
`preparation-titre-eadl/veille-analytics-side-project/veille-analytics-plan.md`. C'est la source
de vérité sur l'avancement — le relire avant de raisonner sur « ce qui reste à faire ».

## Chaîne complète

```
Node-RED (local, WSL)          Cloudflare Worker              veille-dashboard
├─ collecte RSS            →   POST /api/ingest           →   Nuxt 4 / Workers
├─ classification Mistral      ├─ D1 (articles)               routes serveur /api/*
└─ mail récapitulatif          ├─ KV AUTH (token ingest)      (BFF, session Better Auth)
                               └─ ctx.waitUntil → HF Inference API (themes_ml)
```

Collecte déclenchée **manuellement** (une passe/jour), décision assumée : pas d'ordonnanceur.

## Stack

Cloudflare Workers (TypeScript, `src/index.ts`, pas de framework), D1 (SQLite), KV, wrangler.
Tests Vitest + `@cloudflare/vitest-pool-workers` (D1 Miniflare réelle). CI GitHub Actions
(typecheck + lint + tests, puis `wrangler deploy` sur `main`). Terraform pour l'infra durable.

Le repo est **CommonJS** → tout nouveau script Node va en `.mjs` (ESM explicite) dans `scripts/`.

## Commandes

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint
pnpm test             # vitest run (140 tests / 7 fichiers, 2026-07-23)
npx wrangler deploy   # déploiement manuel (normalement fait par la CI)
npx wrangler tail veille-analytics   # logs prod — outil de diagnostic n°1
```

## Structure

- `src/index.ts` — routage manuel (`url.pathname`), 7 routes
- `src/lib/normalize.ts` — normalisation pure (tags, dates RFC 822 → ISO), testée unitairement
- `src/lib/classifyMl.ts` — appel HF Inference API, mapping, retry borné
- `src/lib/mlComparison.ts` — calcul de concordance Mistral/ML (fonction pure)
- `migrations/` — `0001_init.sql` est le seul schéma **prod** ; `0002`–`0004` sont préfixées
  `-dev` et **n'ont jamais été appliquées en prod** (seed, reclassif, normalisation locale)
- `scripts/` — outillage offline (migration, reclassification, annotation, backfill, export Spark)
- `spark/` — batch PySpark local (venv `uv`, cf. `spark/README.md`)
- `terraform/` — infra durable uniquement (2 D1 + 1 KV), cf. `terraform/README.md`
- `docs/001-conception-initiale.md`, `docs/002-decisions-architecturales.md` (ADR)

## API

```
POST /api/ingest              Authorization: Bearer <token KV AUTH>
GET  /api/articles            pagination + filtres (theme, source, categorie, score_min,
                              theme_ml, score_ml_min, ml=oui|non, desaccord=1)
GET  /api/stats/themes
GET  /api/stats/sources
GET  /api/stats/timeline
GET  /api/stats/ml-comparison
GET  /api/stats/health        fraîcheur de la collecte + état de la classification (ADR D12)
```

Pas de CORS configuré : le dashboard passe par un proxy Nitro, tous les appels sont same-origin.
À n'ajouter que si on appelle le Worker en direct depuis un navigateur.

## Modèle de données — les 7 thèmes canoniques

`IA/ML`, `DevOps/Infrastructure`, `Architecture`, `Sécurité`, `Développement`,
`Pratiques/Qualité`, `Productivité/Outils`.

Cette liste est dupliquée en 4 endroits qui doivent rester synchrones :
`src/lib/classifyMl.ts` (`LABEL_MAP`), `scripts/reclassify.js`, `spark/analyse.py`
(`THEMES_CANONIQUES`), `veille-dashboard/shared/utils/themes.ts`.

Colonnes de classification sur `articles` (toutes présentes depuis `0001_init.sql`) :

- `themes_mistral` — array JSON, posé à l'ingestion par Node-RED (synchrone)
- `themes_ml` — array JSON, posé en asynchrone. **`NULL` ≠ `[]`** : `NULL` = jamais classifié,
  `[]` = classifié mais aucun thème au-dessus du seuil. Distinction significative, ne pas
  l'aplatir.
- `score_confiance_ml` — score du top-1, stocké même sous le seuil

**Seuil ML = 0,7** (`ML_THRESHOLD`), retenu par l'évaluation de `veille-ml`. Le mapping FR, le
template d'hypothèse et le seuil sont **recopiés** depuis `veille-ml/classifier.py` pour rester
identiques à l'éval — toute modification doit être faite des deux côtés.

Dédoublonnage : **aucune logique JS**, c'est `INSERT OR IGNORE` sur `url TEXT NOT NULL UNIQUE`.
Se teste donc en intégration D1, pas en unitaire.

## Chiffres de référence (prod, juillet 2026)

- **529 articles** en base ; backfill ML du 2026-07-18 : 503/503 classifiés, 0 échec
- Éval sur les 100 articles annotés à la main (micro-F1) : **Mistral 0,667** > **fine-tuné
  CamemBERT 0,630** (0,559 au seuil choisi en validation, le chiffre méthodologiquement propre)
  > **zero-shot mDeBERTa 0,525**
- Concordance Mistral/ML sur 527 comparables : accord exact 8 %, chevauchement 79 %,
  Jaccard moyen 0,389 ; 110 articles en désaccord total

**Ne jamais citer un chiffre sans l'avoir revérifié** (base vivante, et ces chiffres partent dans
un dossier noté). En cas de doute, marquer `[À VÉRIFIER]`.

## Pièges connus de cet environnement

- **`getPlatformProxy()` (wrangler) se bloque sous ce WSL** — jamais résolu. Aucun script
  standalone ne peut donc lire le binding D1. Contournement systématique :
  `wrangler d1 execute --remote --json` (forme de réponse : `result[0].results`).
- **`wrangler login` (OAuth) échoue sous WSL** → utiliser `CLOUDFLARE_API_TOKEN`.
- **`fetchMock` de `cloudflare:test` a disparu** en `@cloudflare/vitest-pool-workers` ≥ 0.13.
  Mocker `globalThis.fetch` via `vi.stubGlobal` (possible car seuls les appels HF passent par le
  fetch global ; D1 et KV sont des bindings).
- **`waitUntil` en test** : créer le contexte via `createExecutionContext()` et attendre avec
  `waitOnExecutionContext()`, sinon l'assertion s'exécute avant la fin de la classification.
- **`wrangler deploy` efface les variables plaintext** absentes du `wrangler.toml` (les secrets
  et bindings, eux, survivent). Les déclarer en `[vars]`.
- **Worker → Worker via `*.workers.dev` du même compte = erreur 1042** → service binding.
- Config Vitest en **`vitest.config.mts`** (le pool est ESM-only, le repo est CommonJS).
- La CI a un `paths-ignore` (`**.md`, `docs/**`) : un changement de doc seul ne redéploie pas.

## Qualité de données — anomalies connues, non corrigées

- 3 labels hors référentiel dans `themes_mistral` prod : « Produktivité/Outils » (typo),
  « Infrastructure », « IoT » (1 article chacun). Filtrés par whitelist côté endpoint et côté
  Spark, jamais nettoyés en base.
- Des tags échappent à la normalisation lowercase (« DevOps » coexiste avec « devops ») —
  héritage de la migration initiale.

## Sécurité — invariants à ne pas casser

- Le token d'ingestion vit en **KV `AUTH`**, jamais en dur ni en `[vars]`.
- `HF_API_TOKEN` est un **secret** wrangler (en local : `.env.local`, gitignoré).
- Côté dashboard : aucun secret en `runtimeConfig.public`, jamais de `v-html` sur un champ
  d'article (XSS constatée sur l'id 407), `rel="noopener noreferrer"` sur les liens externes.

## Méthode de collaboration attendue

Validation **étape par étape** : confirmer chaque décision avant de passer à la suivante, plutôt
que produire un bloc complet à implémenter seul. Solutions directes et idiomatiques. Être
pédagogique et critique, signaler explicitement les suppositions non vérifiées.

Chaque étape terminée est **documentée dans le plan** (`veille-analytics-plan.md`) avec ses
décisions, ses écarts au plan initial et ses pièges — ce matériau alimente directement la partie
Check/Act du rapport M3.2. Ne pas sauter cette étape de documentation.
