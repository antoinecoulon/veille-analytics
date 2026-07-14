// Étape 12 — Valide et canonicalise le CSV d'annotations exporté par la page.
//
// - Lit un CSV (id, themes_manuels ; thèmes |-séparés), par défaut data/annotations.csv.
// - Valide : ids numériques présents dans l'export D1, thèmes ∈ 7 canoniques,
//   pas de doublon d'id ; signale les annotations sans thème.
// - Réécrit le CSV canonique data/annotations.csv (le livrable, sans BOM, trié par id).
// - Affiche la distribution des thèmes manuels + une concordance BRUTE vs themes_mistral
//   (sanity-check uniquement — la vraie métrique de précision est l'Étape 13).
//
// Usage : node scripts/finalize-annotations.mjs [chemin_csv_entrée]

import fs from "node:fs"

const EXPORT_PATH = "./data/articles_export.json"
const OUT_PATH = "./data/annotations.csv"
const INPUT_PATH = process.argv[2] || OUT_PATH

const THEMES = [
  "IA/ML", "DevOps/Infrastructure", "Architecture", "Sécurité",
  "Développement", "Pratiques/Qualité", "Productivité/Outils",
]
const THEME_SET = new Set(THEMES)

function parseThemes(cell) {
  return (cell || "")
    .replace(/^"|"$/g, "")
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean)
}

function canonicalThemes(row) {
  try {
    return JSON.parse(row.themes_mistral || "[]").filter((t) => THEME_SET.has(t))
  } catch {
    return []
  }
}

function fail(msg) {
  console.error(`\n✖ ${msg}`)
  process.exit(1)
}

function main() {
  if (!fs.existsSync(INPUT_PATH)) fail(`Fichier introuvable : ${INPUT_PATH}`)
  const exportRows = JSON.parse(fs.readFileSync(EXPORT_PATH, "utf-8"))[0].results
  const byId = new Map(exportRows.map((r) => [r.id, r]))

  const raw = fs.readFileSync(INPUT_PATH, "utf-8").replace(/^﻿/, "")
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "")
  if (lines.length === 0) fail("CSV vide")
  if (!/^id\s*,\s*themes_manuels/i.test(lines[0])) fail(`En-tête inattendu : « ${lines[0]} » (attendu « id,themes_manuels »)`)

  const seen = new Set()
  const errors = []
  const annotations = [] // { id, themes }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const comma = line.indexOf(",")
    if (comma === -1) { errors.push(`L${i + 1} : pas de virgule (« ${line} »)`); continue }
    const idStr = line.slice(0, comma).trim()
    const id = Number(idStr)
    if (!Number.isInteger(id)) { errors.push(`L${i + 1} : id non entier « ${idStr} »`); continue }
    if (!byId.has(id)) { errors.push(`L${i + 1} : id ${id} absent de l'export D1`); continue }
    if (seen.has(id)) { errors.push(`L${i + 1} : id ${id} en double`); continue }
    seen.add(id)

    const themes = parseThemes(line.slice(comma + 1))
    const bad = themes.filter((t) => !THEME_SET.has(t))
    if (bad.length) { errors.push(`L${i + 1} (id ${id}) : thème(s) inconnu(s) : ${bad.join(", ")}`); continue }
    annotations.push({ id, themes })
  }

  if (errors.length) fail(`${errors.length} erreur(s) :\n  - ${errors.join("\n  - ")}`)

  annotations.sort((a, b) => a.id - b.id)

  // CSV canonique (thèmes réordonnés selon THEMES, sans BOM).
  const out = ["id,themes_manuels"]
  for (const a of annotations) {
    const ordered = THEMES.filter((t) => a.themes.includes(t))
    out.push(`${a.id},${ordered.join("|")}`)
  }
  fs.writeFileSync(OUT_PATH, out.join("\n") + "\n")

  // --- Rapport ---
  console.log(`✔ ${annotations.length} annotations valides → ${OUT_PATH}\n`)

  const empty = annotations.filter((a) => a.themes.length === 0)
  if (empty.length) console.log(`⚠ ${empty.length} article(s) sans thème (id: ${empty.map((a) => a.id).join(", ")})\n`)

  const dist = Object.fromEntries(THEMES.map((t) => [t, 0]))
  for (const a of annotations) for (const t of a.themes) dist[t]++
  console.log("Distribution des thèmes manuels :")
  for (const t of THEMES) console.log(`  ${t.padEnd(22)} ${dist[t]}`)

  // Concordance brute vs Mistral (sanity-check, pas la métrique officielle).
  let exact = 0, jaccardSum = 0
  for (const a of annotations) {
    const gt = new Set(a.themes)
    const mi = new Set(canonicalThemes(byId.get(a.id)))
    const inter = [...gt].filter((t) => mi.has(t)).length
    const union = new Set([...gt, ...mi]).size || 1
    jaccardSum += inter / union
    if (gt.size === mi.size && inter === gt.size) exact++
  }
  const n = annotations.length
  console.log("\nConcordance brute vs themes_mistral (indicatif) :")
  console.log(`  accord exact (ensembles identiques) : ${exact}/${n} (${Math.round((exact / n) * 100)}%)`)
  console.log(`  Jaccard moyen                       : ${(jaccardSum / n).toFixed(3)}`)
}

main()
