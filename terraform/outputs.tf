output "d1_analytics_id" {
  description = "ID de la base D1 veille-analytics"
  value       = cloudflare_d1_database.analytics.id
}

output "d1_auth_id" {
  description = "ID de la base D1 veille-auth (dashboard)"
  value       = cloudflare_d1_database.auth.id
}

output "kv_auth_id" {
  description = "ID du namespace KV AUTH"
  value       = cloudflare_workers_kv_namespace.auth.id
}
