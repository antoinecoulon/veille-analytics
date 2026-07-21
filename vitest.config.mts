import { defineConfig } from "vitest/config"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Schéma seul : on écarte les migrations de DONNÉES (dev seed, fixes ponctuels), qui
      // fausseraient les assertions de comptage des tests d'intégration.
      //
      // Le critère porte sur le marqueur `-dev` du nom de fichier plutôt que sur « 0001 »
      // uniquement : filtrer par numéro écartait aussi les migrations de SCHÉMA ultérieures
      // (0005_perf_indexes), et les tests auraient alors tourné sur un schéma différent de
      // celui de la production — précisément ce qu'une suite d'intégration doit éviter.
      const migrations = (await readD1Migrations("migrations")).filter(
        (m) => !m.name.includes("-dev")
      )
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
