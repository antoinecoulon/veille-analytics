import type { D1Migration } from "cloudflare:test"

// Types de l'env de test : bindings du wrangler.toml (DB, AUTH) + le binding
// TEST_MIGRATIONS injecté par vitest.config.ts pour appliquer le schéma.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      AUTH: KVNamespace
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
