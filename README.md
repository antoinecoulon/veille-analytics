# VeilleAnalytics

Pipeline de veille technologique automatisé avec analytics et classification ML.

## Qu'est-ce que c'est ?

Un outil personnel qui collecte des articles tech via des flux RSS, les classifie avec Mistral AI, les stocke dans une base cloud (Cloudflare D1) et les expose via une API. Un dashboard BI et un modèle ML de classification thématique sont prévus.

## Architecture

```
Node-RED (local)          Cloudflare Worker         Dashboard (à venir)
Collecte RSS          →   API ingestion + lecture  →  Nuxt.js / Vercel
Classification Mistral     Cloudflare D1 (SQLite)
Email récapitulatif        Cloudflare KV (auth)
```

## Stack

| Composant | Technologie |
|---|---|
| Collecte & orchestration | Node-RED |
| Classification | Mistral AI (open-mistral-nemo) |
| ETL + API | Cloudflare Workers |
| Base de données | Cloudflare D1 (SQLite) |
| Authentification API | Cloudflare KV |
| Dashboard (à venir) | Nuxt.js sur Vercel |
| ML (à venir) | Hugging Face Spaces |
| IaC (à venir) | Terraform |
| CI/CD (à venir) | GitHub Actions |

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

### Déploiement du Worker

```bash
npx wrangler deploy
```

### Base de données

```bash
# Créer la base
npx wrangler d1 create veille-analytics

# Appliquer les migrations
npx wrangler d1 migrations apply veille-analytics --remote
```

## API

### Ingestion

```
POST /api/ingest
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Titre de l'article",
  "link": "https://...",
  "source": "nom_source",
  "resume": "...",
  "categorie": "PRO",
  "score": 3,
  "tags": ["tag1", "tag2"],
  "themes": ["Architecture", "DevOps/Infrastructure"]
}
```

### Lecture (à venir — phase 2)

```
GET /api/articles
GET /api/stats/themes
GET /api/stats/timeline
GET /api/stats/sources
```

## Avancement

- [x] Phase 1 — Fondations (collecte, ETL, D1, migration historique)
- [ ] Phase 2 — API lecture + Dashboard + CI/CD
- [ ] Phase 3 — ML + Analytics
- [ ] Phase 4 — Finalisation + documentation M3.2

## Contexte

Projet personnel réalisé dans le cadre du titre EADL (Expert Architecte en Développement Logiciel) à l'ENI. Il complète les compétences acquises en entreprise sur les blocs 4 (Cloud), 5.1 (Data/BI) et 5.2 (IA/MLOps).

## Usage d'IA

- **Mistral AI** : classification des articles (catégorie, score, thèmes) via l'API, modèle open-mistral-nemo.
- **Claude (Anthropic)** : aide à la conception et à la rédaction de la documentation.