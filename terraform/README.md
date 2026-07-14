# Infrastructure as Code — Terraform

Description en code de l'**infrastructure durable Cloudflare** des deux projets de la plateforme
de veille (`veille-analytics` et `veille-dashboard`).

## Périmètre

| Ressource | Type Terraform | Projet |
|---|---|---|
| Base D1 `veille-analytics` | `cloudflare_d1_database.analytics` | veille-analytics (articles, stats) |
| Base D1 `veille-auth` | `cloudflare_d1_database.auth` | veille-dashboard (Better Auth) |
| Namespace KV `AUTH` | `cloudflare_workers_kv_namespace.auth` | veille-analytics (token d'ingestion) |

### Ce qui n'est PAS géré ici — et pourquoi

Le **code des Workers** (`cloudflare_workers_script`) reste déployé par **wrangler / Cloudflare
Workers Builds**, pas par Terraform. C'est un choix d'architecture délibéré :

- Terraform gère l'**infrastructure durable** (bases, namespaces) — cycle de vie long, ne change
  pas à chaque commit.
- La **CI/CD** gère le **déploiement applicatif** (code des Workers) — change à chaque push.

Si Terraform gérait aussi les scripts, chaque `wrangler deploy` réécrirait la ressource et
créerait un **drift permanent** (deux propriétaires d'une même ressource) : `terraform plan` ne
serait jamais propre. Un seul propriétaire par ressource = pas de conflit.

Sont aussi hors périmètre : le service binding `ANALYTICS` (attribut du script Worker), le secret
`NUXT_BETTER_AUTH_SECRET`, et l'**application des migrations D1** — celles-ci restent gérées par
wrangler :

```bash
wrangler d1 migrations apply veille-analytics --remote   # repo veille-analytics
wrangler d1 migrations apply veille-auth --remote         # repo veille-dashboard
```

## Prérequis

- [Terraform CLI](https://developer.hashicorp.com/terraform/install) ≥ 1.5
- Un token API Cloudflare avec les droits **lecture/écriture** sur **D1** et **Workers KV**,
  exposé en variable d'environnement :

  ```bash
  export CLOUDFLARE_API_TOKEN="<votre-token>"
  ```

- Le fichier `terraform.tfvars` (non versionné) contenant l'identifiant de compte :

  ```hcl
  account_id = "<votre-account-id>"
  ```

  (récupérable via `npx wrangler whoami`.)

## Utilisation

```bash
terraform init      # télécharge le provider cloudflare v5, écrit le lock
terraform plan      # compare la config au réel (doit afficher « No changes »)
terraform apply     # applique les changements (création / mise à jour)
```

## Recréer l'infrastructure from scratch

Sur un **compte vierge** (sans ressources existantes), `terraform apply` crée tout :

```bash
terraform init
terraform apply     # crée les 2 bases D1 + le namespace KV
```

Puis reporter les IDs générés (`terraform output`) dans les `wrangler.toml` des deux repos, et
appliquer les migrations D1 (voir ci-dessus).

## Rattacher l'existant (import)

L'infra actuelle a été **importée** (les ressources existaient déjà), sans rien recréer :

```bash
terraform import cloudflare_d1_database.analytics '<account_id>/<database_id>'
terraform import cloudflare_d1_database.auth '<account_id>/<database_id>'
terraform import cloudflare_workers_kv_namespace.auth '<account_id>/<namespace_id>'
```

## État (state)

État **local** (`terraform.tfstate`, non versionné). Suffisant pour un usage solo. En équipe, on
migrerait vers un backend distant (ex. Cloudflare R2) pour partager et verrouiller l'état.
