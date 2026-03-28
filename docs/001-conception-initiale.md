# VeilleAnalytics — Document de conception initiale

**Auteur** : Antoine COULON
**Date** : Mars 2026
**Version** : 0.3 — Draft
**Contexte** : Projet personnel complémentaire au PEP EADL (M3.2 — Rapport d'amélioration continue)

---

## Contexte et problématique

### Situation de départ

Dans le cadre de ma montée en compétences en tant que développeur chez BRIAND Group, j'ai mis en place un pipeline automatisé de veille technologique. Construit avec Node-RED et Mistral AI, il collecte des articles via des flux RSS, les classifie par pertinence et les distribue quotidiennement par mail.

Ce système, en production depuis décembre 2025, répond à un besoin concret : industrialiser ma veille sur des domaines en évolution rapide (architecture logicielle, DevSecOps, cloud). Les résultats sont stockés dans un dashboard Node-RED sous forme de fichier JSON, qui constitue un historique exploitable.

À ce jour (mars 2026), le pipeline a collecté 270 articles, classifiés par Mistral selon deux axes : la pertinence selon mon contexte (PRO, PERSO, LES_DEUX, HORS_SCOPE) et un score de 1 à 5. Chaque article est enrichi d'un résumé, de tags et de métadonnées (source, date, lien).

### Limites identifiées

Le pipeline actuel a plusieurs limites :

- Les données sont stockées dans un fichier JSON local sans structure. Il n'y a aucun moyen d'analyser les tendances dans le temps, la distribution par source ou par thème.
- La classification Mistral est biaisée : 76% des articles reçoivent un score de 3, 22% un score de 4, et les scores 1, 2 et 5 ne sont jamais attribués. La catégorie HORS_SCOPE n'apparaît jamais.
- Le pipeline dépend d'un lancement manuel (ma machine n'est pas allumée en permanence), ce qui crée des trous dans la collecte.
- L'infrastructure est locale, sans reproductibilité ni monitoring.

### Objectifs du projet

L'idée est de faire évoluer ce pipeline vers quelque chose de plus complet : stocker les articles dans une vraie base, les analyser via un dashboard, et tester une classification ML alternative à Mistral. Le tout déployé en cloud, avec une infrastructure reproductible.

L'objectif secondaire est de couvrir les compétences EADL peu représentées dans mes missions d'entreprise.

### Contraintes

Tout doit fonctionner gratuitement et le projet doit rester en ligne au moment de la soutenance.

---

## Analyse du dataset existant

### Volume et structure

Le dataset contient 270 articles. Les premiers articles datent d'août 2025 (analysés rétrospectivement), la collecte régulière a débuté en février 2026. Chaque article est représenté comme un objet avec ces propriétés :

```json
{
  "id": 1770507615544,
  "title": "Are bugs and incidents inevitable with AI coding agents?",
  "link": "<https://stackoverflow.blog/>...",
  "source": "StackOverflow Blog",
  "date": "Wed, 28 Jan 2026 15:00:00 GMT",
  "resume": "L'article explore les types de bugs spécifiques générés par...",
  "categorie": "PRO",
  "score": 3,
  "tags": ["IA", "développement", "bugs", "production"],
  "analyzedAt": "2026-02-07T23:40:15.543Z",
  "lu": false
}
```

On a donc un titre, un résumé, des tags, une catégorie, un score et des métadonnées. C'est suffisant pour alimenter un Data Warehouse et pour servir d'input à un modèle ML.

### Ce que révèlent les données

**Catégories** : PRO domine (65%), LES_DEUX représente 29%, PERSO seulement 5%, et HORS_SCOPE n'est jamais attribué. Le dataset est très déséquilibré.

**Scores** : 76% de score 3, 22% de score 4, aucun 1, 2 ou 5. Malgré la consigne de sévérité dans le prompt, Mistral maintient un score quasi binaire.

**Tags** : 501 tags distincts, dont 75 avec 3+ occurrences. En les regroupant, on obtient des thématiques naturelles :

| Thématique | Tags principaux | Occurrences |
| --- | --- | --- |
| IA / Machine Learning | ia, ai, llm, machine learning, copilot, openai | ~130 |
| DevOps / Infrastructure | devops, kubernetes, cloud, aws, ci/cd, docker | ~120 |
| Architecture | architecture, microservices, api, backend | ~80 |
| Pratiques / Qualité | bonnes pratiques, tests, documentation, performance | ~60 |
| Développement | javascript, typescript, python, c#, react, node.js | ~50 |
| Productivité / Outils | productivité, automatisation, cli, open source | ~50 |
| Sécurité | sécurité, authentification, gouvernance | ~45 |

Ces regroupements sont issus des données réelles. Contrairement aux catégories PERSO/PRO qui dépendent de mon contexte personnel, ces thématiques dépendent du contenu de l'article. C'est un problème de classification que le ML peut réellement traiter.

---

## Architecture

### Vue d'ensemble

```
┌─────────────────────────────────────────────────────┐
│              DASHBOARD BI (Nuxt.js / Vercel)        │
│         Tendances, distribution, comparaison ML     │
└──────────────────────┬──────────────────────────────┘
                       │ API
┌──────────────────────┴──────────────────────────────┐
│              CLOUDFLARE WORKER                      │
│            ETL + API Gateway                        │
│    Ingestion, transformation, exposition données    │
└───────┬──────────────────────┬──────────────────────┘
        │                      │
┌───────┴──────────┐   ┌───────┴─────────────────────┐
│  Cloudflare D1   │   │   Hugging Face Spaces       │
│  (base SQLite)   │   │   Classification par thème  │
└───────┬──────────┘   └─────────────────────────────┘
        │
┌───────┴─────────────────────────────────────────────┐
│           NODE-RED + MISTRAL AI (local)             │
│     Collecte RSS → classification → webhook POST    │
└─────────────────────────────────────────────────────┘
```

### Comment ça fonctionne

1. Node-RED collecte les articles RSS et les envoie à Mistral pour classification (c’est l'existant).
2. Après classification, Node-RED fait un POST vers le Worker Cloudflare avec l'article enrichi (adaptation à faire : ajout d'un nœud HTTP Request + modification du prompt Mistral pour ajouter un champ `theme`).
3. Le Worker transforme les données (normalisation des dates, des tags, dédoublonnage) et les insère dans D1.
4. Le modèle ML sur Hugging Face Spaces est appelé pour une classification thématique indépendante de Mistral.
5. Le dashboard interroge le même Worker pour afficher les données.

### Migration initiale

Les 270 articles du JSON existant seront importés dans D1 comme première étape. Ca donne immédiatement des données réelles pour le dashboard et pour évaluer le modèle ML.

---

## Détail par couche

### Collecte — Node-RED (adaptation)

**Ce qui existe** : le pipeline collecte, classifie via Mistral, envoie un mail et stocke dans un JSON local.

**Ce qui change** : j'ajoute un nœud HTTP Request en sortie du flux pour pousser chaque article vers le Worker Cloudflare. Je modifie aussi le prompt Mistral pour qu'il retourne un champ `theme` en plus de la catégorie et du score. Le mail et le stockage local continuent de fonctionner en parallèle.

### ETL + API — Cloudflare Worker

Un seul Worker avec deux rôles :

**Ingestion** (`POST /api/ingest`) : reçoit un article depuis Node-RED, normalise les champs (dates ISO, tags en lowercase, dédoublonnage des variantes comme "open source"/"open-source"), et l'insère dans D1. Authentification par token stocké dans Cloudflare KV.

**Exposition** (`GET /api/articles`, `/api/stats`, etc.) : fournit les données au dashboard. Filtres par date, thème, source, score. Agrégations pour les graphiques.

### Données — Cloudflare D1

Base SQLite avec un schéma en étoile simplifié :

```sql
-- Table principale
CREATE TABLE articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titre TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    resume TEXT,
    source TEXT NOT NULL,
    categorie_mistral TEXT,
    score_mistral INTEGER,
    themes_mistral TEXT,      -- JSON array
    themes_ml TEXT,           -- JSON array (prédictions du modèle)
    score_confiance_ml REAL,
    tags TEXT,                -- JSON array des tags bruts
    date_article TEXT,
    date_collecte TEXT NOT NULL
);

-- Dimension date (pour les agrégations)
CREATE TABLE dim_date (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_complete TEXT NOT NULL UNIQUE,
    annee INTEGER,
    mois INTEGER,
    semaine INTEGER,
    jour_semaine INTEGER
);

-- Agrégations quotidiennes (alimentées par un Cron Trigger)
CREATE TABLE agg_quotidien (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    thematique TEXT,
    nb_articles INTEGER DEFAULT 0,
    score_moyen REAL
);
```

J'ai simplifié par rapport à un schéma en étoile complet : pas de tables de dimension séparées pour les sources et les tags (stockés en JSON dans la table articles). Pour mon volume (~500-600 articles à terme), c'est suffisant et plus simple à manipuler.

### ML — Hugging Face Spaces

**Le problème** : les catégories Mistral (PERSO/PRO/LES_DEUX) sont subjectives et liées à mon contexte. Un modèle ML ne peut pas apprendre ce que "pertinent pour mon travail chez BRIAND" veut dire à partir d'un résumé d'article. En revanche, classer un article par thème technique (IA, DevOps, Architecture, etc.) est un problème objectif lié au contenu.

**L'approche** :

Phase 1 — Zero-shot : je déploie un modèle pré-entraîné sur Hugging Face Spaces avec les 7 labels thématiques. Le modèle reçoit le titre + résumé et retourne une probabilité par thème. Pas besoin de données d'entraînement, ça fonctionne immédiatement. En parallèle, j'annote manuellement ~100 articles pour avoir un jeu de référence indépendant de Mistral.

Phase 2 (optionnelle) — Fine-tuning : si j'ai suffisamment de données (~500+ articles) et de temps, je tente d'entraîner un petit modèle spécialisé et je compare ses résultats au zero-shot et à Mistral. Si les résultats ne sont pas meilleurs, je le documente honnêtement.

**Monitoring** : les prédictions ML sont stockées dans D1 (champs `themes_ml` et `score_confiance_ml`). Le dashboard affiche une vue de comparaison ML vs Mistral sur les thèmes et permet un suivi visuel de l'évolution dans le temps.

### Dashboard BI — Nuxt.js sur Vercel

Nuxt.js pour rester cohérent avec ma stack entreprise et éviter une nouvelle courbe d’apprentissage. Quatre vues :

**Vue tendances** : évolution du nombre d'articles par thématique dans le temps.
**Vue distribution** : répartition par source et par thème.
**Vue comparaison ML** : accord/désaccord entre Mistral et le modèle ML sur les thèmes.
**Vue détail** : liste des articles avec filtres (date, thème, source, score).

### Big Data — PySpark (local)

La compétence C29 demande l'utilisation de technologies telles que Hadoop/Spark. Mon volume de données ne justifie pas un cluster, mais un script PySpark local sur un export CSV de D1 permet de montrer la maîtrise de l'outil. Traitements prévus : fréquences thématiques, cooccurrences de tags, tendances par fenêtre glissante, le tout documenté et reproductible.

### Infrastructure — Terraform + GitHub Actions

**Terraform** : provisionnement de la base D1, du Worker et des clés KV via le provider Cloudflare. L'objectif est de pouvoir recréer l'infrastructure from scratch en une commande.

**GitHub Actions** : pipeline lint + tests + déploiement automatique du Worker (via Wrangler) et du dashboard (via Vercel).

**Tests** : tests unitaires sur les fonctions de transformation (normalisation tags, parsing dates) et tests d'intégration sur les endpoints API.

### Sécurité

- Authentification API par token (Cloudflare KV).
- CORS restrictif (seul le domaine Vercel peut appeler l'API).
- Secrets gérés via GitHub Secrets et variables d'environnement Cloudflare.
- Aucune donnée personnelle stockée.

---

## Mapping compétences EADL

### Bloc 4 — Cloud Computing

| Compétence | Comment le projet la couvre |
| --- | --- |
| C21 — Services Cloud via API | Worker, D1, KV : consommés via les API Cloudflare |
| C22 — Automatisation config Cloud | Terraform avec le provider Cloudflare |
| C23 — Administration Cloud | Gestion du Worker, de D1, monitoring Cloudflare |
| C24 — Performances Cloud | Optimisation des requêtes D1, gestion du cold start |
| C25 — Sécurité Cloud | Token API, CORS, gestion des secrets |
| C26 — Blockchain | Non couvert ici (cours ENI / ECF) |

### Bloc 5.1 — Data & BI

| Compétence | Comment le projet la couvre |
| --- | --- |
| C27 — Data Warehouse | Schéma D1 avec table de faits + dimension date + agrégations |
| C28 — ETL | Worker d'ingestion + migration des 270 articles |
| C29 — Big Data (Spark) | Script PySpark local sur l'export historique |
| C30 — Business Intelligence | Dashboard Nuxt.js avec 4 vues analytiques |
| C31 — RPA | Déjà couvert par le pipeline Node-RED existant |

### Bloc 5.2 — IA & MLOps

| Compétence | Comment le projet la couvre |
| --- | --- |
| C32 — Machine Learning | Classification thématique zero-shot (+ fine-tuning optionnel) |
| C33 — Monitoring | Comparaison ML/Mistral dans le dashboard, logs de prédictions |
| C34 — Documentation technique | Ce document + README + documentation API |
| C35 — Amélioration continue | Démarche PDCA, KPI avant/après |

### Renforcements

| Compétence | Comment le projet la couvre |
| --- | --- |
| C08 — TDD | Tests unitaires et d'intégration |
| C16-C17 — CI/CD | GitHub Actions : lint, tests, déploiement |
| C18 — DevSecOps | Gestion des secrets, scan de dépendances |

---

## Stack technique

| Couche | Technologie | Free Tier |
| --- | --- | --- |
| Collecte | Node-RED + Mistral AI (local) | Oui |
| ETL + API | Cloudflare Worker | Oui (100k req/jour) |
| Base de données | Cloudflare D1 | Oui (5 Mo, 5M lectures/jour) |
| Secrets | Cloudflare KV | Oui (100k lectures/jour) |
| ML | Hugging Face Spaces | Oui (2 vCPU, 16 Go) |
| Dashboard | Vercel | Oui (hobby plan) |
| CI/CD | GitHub Actions | Oui (repos publics) |
| IaC | Terraform CLI | Oui (open source) |
| Big Data | PySpark local | Oui |

---

## Démarche PDCA

### Plan

Constat de départ :

- 270 articles collectés en ~2 mois, avec des trous (lancement manuel).
- Scores biaisés (76% de 3, 22% de 4, rien d'autre).
- Aucune analyse rétrospective possible.
- Infra locale, non reproductible.

KPI à mesurer :

- Régularité de collecte (% de jours couverts).
- Concordance ML/Mistral sur les thèmes.
- Couverture de tests.
- Temps de redéploiement from scratch.

### Do

Implémentation progressive : migration JSON vers D1, adaptation Node-RED, déploiement du Worker, mise en place du zero-shot, construction du dashboard, IaC Terraform, CI/CD.

### Check

Mesure des KPI après chaque étape. Comparaison avant/après. Évaluation du zero-shot sur le jeu annoté manuellement.

### Act

Ajustements selon les résultats. Documentation honnête, y compris des limites et des échecs. Projection vers une éventuelle adoption en entreprise.

---

## Planning

| Période | Ce que je fais |
| --- | --- |
| Mars-Avril 2026 | Adaptation Node-RED (webhook + thème). Worker ETL + schéma D1. Migration des 270 articles. |
| Mai-Juin 2026 | Terraform + GitHub Actions. Dashboard v1. Déploiement zero-shot. Début annotation manuelle. |
| Juillet-Août 2026 | Fine-tuning (si possible). PySpark. Dashboard v2 (vue ML). |
| Sept-Oct 2026 | Stabilisation. Documentation. Captures et vidéos. Rédaction M3.2. Préparation soutenance. |