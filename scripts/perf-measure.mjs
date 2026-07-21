// C24 — Mesure de performance des requêtes chaudes, avant / après optimisation.
//
// Même discipline que scripts/kpi-baseline.sql (P2) : aucun chiffre du rapport n'est écrit à
// la main, tout est régénéré par une exécution. Ici on relève, pour chaque requête chaude :
//
//   - son PLAN d'exécution (EXPLAIN QUERY PLAN) — SCAN = balayage complet, SEARCH = index utilisé.
//     C'est la preuve QUALITATIVE, déterministe, indépendante du volume.
//   - `rows_read` renvoyé par D1 — la preuve QUANTITATIVE. C'est le KPI retenu parce qu'il est
//     déterministe et reproductible, et parce que c'est aussi l'unité de facturation de D1.
//   - `duration` (ms) — reporté à titre INDICATIF seulement. À 542 articles, la latence réseau
//     et la variance du serveur dominent largement le coût du plan : en tirer une conclusion
//     serait malhonnête. Voir m3/05-performance.md, section « Limites ».
//
// LECTURE SEULE : aucune requête n'écrit (`rows_written: 0`, `changed_db: false`). Le DELETE du
// chemin d'agrégation est mesuré en EXPLAIN seul, jamais exécuté.
//
// Prérequis : CLOUDFLARE_API_TOKEN dans l'environnement (comme tout appel `--remote`).
//
// Usage :
//   node scripts/perf-measure.mjs --label avant            # production
//   node scripts/perf-measure.mjs --label avant --local    # D1 locale
//
// Sortie : data/perf/perf-<label>.json + un tableau récapitulatif sur la sortie standard.

import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

const WRANGLER = "node_modules/wrangler/bin/wrangler.js"
const DB = "veille-analytics"
const OUT_DIR = "data/perf"

// Jour de mesure figé plutôt que calculé : les deux exécutions (avant / après) doivent porter
// sur exactement la même requête pour être comparables. 2026-06-29 est le jour le plus chargé
// de la base (17 articles) — c'est-à-dire le pire cas du chemin d'agrégation.
const JOUR = "2026-06-29"
// Borne haute de l'encadrement, en dur comme JOUR : ce script mesure, il ne doit pas dépendre
// du code qu'il mesure (importer bornesDuJour depuis src/ créerait un angle mort si la fonction
// se trompait — les deux se recoupent, test/aggregates.test.ts couvrant le calcul lui-même).
const JOUR_SUIVANT = "2026-06-30"

// Les requêtes exactement telles qu'elles sont exécutées en production. Toute divergence avec
// src/ ou scripts/ invaliderait la mesure — d'où le rappel de l'origine sur chaque entrée.
const REQUETES = [
  {
    nom: "agg_jour_themes",
    origine: "src/lib/aggregates.ts — INSERT ... SELECT par thème",
    chemin: "écriture (chaque ingestion)",
    sql: `SELECT '${JOUR}', value, COUNT(*), AVG(score_mistral)
          FROM articles, json_each(articles.themes_mistral)
          WHERE date_article >= '${JOUR}' AND date_article < '${JOUR_SUIVANT}'
            AND themes_mistral IS NOT NULL
          GROUP BY value`,
  },
  {
    nom: "agg_jour_rollup",
    origine: "src/lib/aggregates.ts — INSERT ... SELECT de la ligne de rollup",
    chemin: "écriture (chaque ingestion)",
    sql: `SELECT '${JOUR}', NULL, COUNT(*), AVG(score_mistral)
          FROM articles
          WHERE date_article >= '${JOUR}' AND date_article < '${JOUR_SUIVANT}'
          HAVING COUNT(*) > 0`,
  },
  {
    nom: "agg_delete_jour",
    origine: "src/lib/aggregates.ts — DELETE du jour avant recalcul",
    chemin: "écriture (chaque ingestion)",
    // Jamais exécuté : ce script est en lecture seule. Seul le plan est relevé.
    explainSeulement: true,
    sql: `DELETE FROM agg_quotidien WHERE date = '${JOUR}'`,
  },
  {
    nom: "articles_liste",
    origine: "src/index.ts — fetchArticles, première page sans filtre",
    chemin: "lecture (GET /api/articles)",
    sql: `SELECT * FROM articles ORDER BY date_article DESC, date_collecte DESC LIMIT 20 OFFSET 0`,
  },
  {
    nom: "timeline",
    origine: "src/index.ts — fetchArticlesTimeline",
    chemin: "lecture (GET /api/stats/timeline)",
    sql: `SELECT date AS jour, nb_articles AS count FROM agg_quotidien
          WHERE thematique IS NULL ORDER BY date ASC`,
  },
  // Les deux requêtes suivantes ne figuraient pas dans la sélection initiale : c'est
  // `wrangler d1 insights` qui les a désignées comme les plus lourdes en lecture réelle.
  {
    nom: "stats_themes",
    origine: "src/index.ts — fetchArticlesCountByTheme",
    chemin: "lecture (GET /api/stats/themes)",
    sql: `SELECT value AS theme, COUNT(*) AS count
          FROM articles, json_each(articles.themes_mistral)
          WHERE articles.themes_mistral IS NOT NULL
          GROUP BY value ORDER BY count DESC`,
  },
  {
    nom: "stats_sources",
    origine: "src/index.ts — fetchArticlesCountBySource",
    chemin: "lecture (GET /api/stats/sources)",
    sql: `SELECT source, COUNT(*) AS count FROM articles GROUP BY source ORDER BY count DESC`,
  },
  // Témoin volontaire : cette requête lit toute la table PAR CONCEPTION (la concordance se
  // calcule sur l'ensemble du corpus, cf. Étape 15). Aucun index ne peut l'améliorer. Elle est
  // mesurée pour que le rapport montre aussi ce qui n'a pas bougé — un avant/après où tout
  // s'améliore est un avant/après mal choisi.
  {
    nom: "ml_comparison",
    origine: "src/index.ts — fetchMlComparison (témoin, non optimisable)",
    chemin: "lecture (GET /api/stats/ml-comparison)",
    sql: `SELECT themes_mistral, themes_ml FROM articles`,
  },
]

function args() {
  const argv = process.argv.slice(2)
  const label = argv.includes("--label") ? argv[argv.indexOf("--label") + 1] : null
  if (!label) {
    console.error("Erreur : --label <avant|apres|...> est obligatoire (il nomme le fichier de sortie).")
    process.exit(1)
  }
  return { label, local: argv.includes("--local") }
}

// Une instruction, une exécution. On passe par un tableau d'arguments (pas de shell) : ni
// échappement de guillemets, ni limite de longueur de ligne de commande Windows — les deux
// pièges rencontrés en P2 avec `--command` sous PowerShell.
function d1(sql, local) {
  const sortie = execFileSync(
    process.execPath,
    [WRANGLER, "d1", "execute", DB, local ? "--local" : "--remote", "--json", "--command", sql],
    { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }
  )
  const parsed = JSON.parse(sortie)
  return parsed[0]
}

function mesurer({ sql, explainSeulement }, local) {
  const plan = d1(`EXPLAIN QUERY PLAN ${sql}`, local).results.map((r) => r.detail)

  if (explainSeulement) {
    return { plan, rows_read: null, rows_written: null, duration_ms: null, lignes_rendues: null }
  }

  const reel = d1(sql, local)
  // La base locale (Miniflare) ne renseigne pas rows_read : seuls les plans y sont exploitables,
  // les volumes doivent être mesurés en --remote. On normalise en null plutôt que de laisser
  // passer un undefined qui disparaîtrait silencieusement du JSON.
  return {
    plan,
    rows_read: reel.meta.rows_read ?? null,
    rows_written: reel.meta.rows_written ?? null,
    duration_ms: reel.meta.duration ?? null,
    lignes_rendues: reel.results.length,
  }
}

function main() {
  const { label, local } = args()

  if (!fs.existsSync(WRANGLER)) {
    console.error(`Erreur : ${WRANGLER} introuvable — lancer depuis la racine du dépôt, après pnpm install.`)
    process.exit(1)
  }

  const cible = local ? "local" : "remote"
  console.log(`Mesure « ${label} » sur la base ${cible} (jour de référence ${JOUR})...\n`)

  const total = d1("SELECT COUNT(*) AS n FROM articles", local).results[0].n

  const mesures = REQUETES.map((requete) => {
    process.stdout.write(`  ${requete.nom}... `)
    const resultat = mesurer(requete, local)
    console.log(resultat.rows_read === null ? "plan seul" : `${resultat.rows_read} lignes lues`)
    return {
      nom: requete.nom,
      origine: requete.origine,
      chemin: requete.chemin,
      sql: requete.sql.replace(/\s+/g, " ").trim(),
      ...resultat,
    }
  })

  const rapport = {
    label,
    cible,
    mesure_le: new Date().toISOString(),
    jour_reference: JOUR,
    articles_en_base: total,
    mesures,
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const fichier = path.join(OUT_DIR, `perf-${label}.json`)
  fs.writeFileSync(fichier, JSON.stringify(rapport, null, 2) + "\n")

  console.log(`\n${total} articles en base.\n`)
  console.log("requête".padEnd(18) + "lignes lues".padEnd(14) + "durée (ms)".padEnd(13) + "plan")
  console.log("-".repeat(100))
  for (const m of mesures) {
    console.log(
      m.nom.padEnd(18) +
        String(m.rows_read ?? "—").padEnd(14) +
        String(m.duration_ms ?? "—").padEnd(13) +
        m.plan.join(" | ")
    )
  }
  console.log(`\n✔ Rapport écrit → ${fichier}`)
}

main()
