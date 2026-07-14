# Infrastructure durable Cloudflare (bases D1 + namespace KV).
# Le CODE des Workers n'est PAS géré ici : il reste déployé par wrangler / Workers Builds
# (un seul propriétaire par ressource, cf. README pour la justification du découpage IaC/CD).

# Base D1 du Worker veille-analytics (articles, stats). Binding "DB".
resource "cloudflare_d1_database" "analytics" {
  account_id       = var.account_id
  name             = "veille-analytics"
  read_replication = { mode = "disabled" }
}

# Base D1 dédiée à l'authentification du dashboard (Better Auth). Binding "DB_AUTH".
resource "cloudflare_d1_database" "auth" {
  account_id       = var.account_id
  name             = "veille-auth"
  read_replication = { mode = "disabled" }
}

# Namespace KV du Worker veille-analytics (token d'ingestion ETL). Binding "AUTH".
resource "cloudflare_workers_kv_namespace" "auth" {
  account_id = var.account_id
  title      = "AUTH"
}
