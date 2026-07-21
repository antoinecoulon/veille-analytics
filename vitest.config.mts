import { defineConfig } from "vitest/config"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Aucun filtre : `migrations/` ne contient que du schéma, les correctifs de données
      // vivent dans scripts/sql-ponctuels/ (cf. migrations/README.md). Les tests d'intégration
      // tournent donc sur exactement le schéma de production, index compris.
      //
      // Un filtre a existé ici, d'abord par numéro puis par marqueur de nom. Les deux
      // dépendaient d'une convention de nommage que rien ne faisait respecter : le premier a
      // silencieusement écarté une migration de schéma, le second aurait laissé passer un
      // correctif de données mal nommé. Ranger les fichiers au bon endroit règle les deux.
      const migrations = await readD1Migrations("migrations")
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            HF_API_TOKEN: "hf-test-token"
          }
        }
      }
    })
  ]
})
