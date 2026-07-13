import { defineConfig } from "vitest/config"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Schéma seul (0001) : on écarte les migrations de données (dev seed, fixes prod)
      // qui fausseraient les assertions de comptage des tests d'intégration.
      const migrations = (await readD1Migrations("migrations")).filter((m) =>
        m.name.startsWith("0001")
      )
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations }
        }
      }
    })
  ]
})
