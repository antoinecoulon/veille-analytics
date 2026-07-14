// Étape 12 — Échantillonnage stratifié pour l'annotation manuelle.
//
// Lit le dump D1 (data/articles_export.json) et sélectionne ~100 articles
// diversifiés en thèmes ET en sources, de façon DÉTERMINISTE (aucune part
// d'aléatoire → sélection reproductible et documentable).
//
// Sortie : data/annotation_sample.json = [{ id, titre, resume, source, url }]
// SANS themes_mistral — c'est le seul fichier lu par la suite pour l'annotation
// « à l'aveugle » (on ne veut pas ancrer l'annotateur sur la prédiction Mistral).
//
// Usage : node scripts/sample-annotation.mjs

import fs from "node:fs"

const EXPORT_PATH = "./data/articles_export.json"
const SAMPLE_PATH = "./data/annotation_sample.json"
const TARGET = 100

// Les 7 thèmes canoniques (cf. scripts/reclassify.js). Tout label hors de cette
// liste dans themes_mistral (ex. coquilles « Produktivité/Outils ») est ignoré.
const THEMES = [
  "IA/ML", "DevOps/Infrastructure", "Architecture", "Sécurité",
  "Développement", "Pratiques/Qualité", "Productivité/Outils",
]
const THEME_SET = new Set(THEMES)

function canonicalThemes(row) {
  try {
    return JSON.parse(row.themes_mistral || "[]").filter((t) => THEME_SET.has(t))
  } catch {
    return []
  }
}

// Choisit, parmi `candidates`, l'article qui minimise l'usage courant de sa
// source (diversité des sources), départage par id croissant (déterminisme).
function pickMostDiverse(candidates, sourceCount) {
  return candidates
    .slice()
    .sort((a, b) => {
      const ca = sourceCount[a.source] || 0
      const cb = sourceCount[b.source] || 0
      return ca - cb || a.id - b.id
    })[0]
}

function main() {
  const raw = JSON.parse(fs.readFileSync(EXPORT_PATH, "utf-8"))
  const articles = raw[0].results
  console.log(`${articles.length} articles dans l'export\n`)

  const selected = new Map() // id -> row
  const sourceCount = {}
  const perThemeQuota = Math.ceil(TARGET / THEMES.length) // 15

  const select = (row) => {
    selected.set(row.id, row)
    sourceCount[row.source] = (sourceCount[row.source] || 0) + 1
  }

  // 1) Quota par thème : garantit la couverture des 7 thèmes.
  for (const theme of THEMES) {
    let picked = 0
    while (picked < perThemeQuota && selected.size < TARGET) {
      const candidates = articles.filter(
        (a) => !selected.has(a.id) && canonicalThemes(a).includes(theme),
      )
      if (candidates.length === 0) break
      select(pickMostDiverse(candidates, sourceCount))
      picked++
    }
  }

  // 2) Complément jusqu'à TARGET (si des thèmes rares ont épuisé leurs candidats),
  //    en continuant à diversifier les sources. On n'inclut que des articles ayant
  //    au moins un thème canonique (annotables).
  while (selected.size < TARGET) {
    const candidates = articles.filter(
      (a) => !selected.has(a.id) && canonicalThemes(a).length > 0,
    )
    if (candidates.length === 0) break
    select(pickMostDiverse(candidates, sourceCount))
  }

  // Sortie triée par id, SANS themes_mistral.
  const sample = [...selected.values()]
    .sort((a, b) => a.id - b.id)
    .map(({ id, titre, resume, source, url }) => ({ id, titre, resume, source, url }))

  fs.writeFileSync(SAMPLE_PATH, JSON.stringify(sample, null, 2))

  // Rapport de couverture (basé sur themes_mistral, pour vérif uniquement).
  const themeCov = Object.fromEntries(THEMES.map((t) => [t, 0]))
  const srcCov = {}
  for (const row of selected.values()) {
    for (const t of canonicalThemes(row)) themeCov[t]++
    srcCov[row.source] = (srcCov[row.source] || 0) + 1
  }

  console.log(`${sample.length} articles sélectionnés → ${SAMPLE_PATH}\n`)
  console.log("Couverture par thème (multi-label) :")
  for (const t of THEMES) console.log(`  ${t.padEnd(22)} ${themeCov[t]}`)
  console.log("\nCouverture par source :")
  for (const [s, n] of Object.entries(srcCov).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(28)} ${n}`)
  }
}

main()
