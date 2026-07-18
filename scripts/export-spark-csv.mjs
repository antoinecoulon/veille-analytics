// Étape 16 — Exporte les articles au format CSV pour le batch PySpark.
//
// - Lit articles_spark.json (déjà généré, forme wrangler [{ results: [...] }]).
// - Exporte un CSV strictement formaté (guillemets doubles, échappement des guillemets internes).
// - Les champs JSON (themes_mistral, themes_ml, tags) sont écrits tels quels dans la cellule CSV.
//
// Entrée : data/articles_spark.json
// Sortie : data/articles_spark.csv
//
// Usage : node scripts/export-spark-csv.mjs

import fs from "node:fs"

const JSON_PATH = "./data/articles_spark.json"
const CSV_PATH = "./data/articles_spark.csv"

// Formate une cellule CSV : guillemets autour des champs texte, doublage des guillemets internes.
// Les champs numériques et null sont traités spécialement.
function csvCell(value) {
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "number") {
    return String(value)
  }
  // Pour les chaînes : entourer de guillemets et doubler les guillemets internes.
  const str = String(value)
  return `"${str.replaceAll('"', '""')}"`
}

function main() {
  if (!fs.existsSync(JSON_PATH)) {
    console.error(`Erreur : fichier introuvable : ${JSON_PATH}`)
    process.exit(1)
  }

  const raw = fs.readFileSync(JSON_PATH, "utf-8")
  const result = JSON.parse(raw)
  const articles = result[0].results

  console.log(`Traitement de ${articles.length} articles...\n`)

  // En-tête CSV
  const csv = [["id", "titre", "url", "source", "date_article", "themes_mistral", "themes_ml", "score_confiance_ml", "tags"].join(",")]

  // Lignes de données
  for (const article of articles) {
    const row = [
      csvCell(article.id),
      csvCell(article.titre),
      csvCell(article.url),
      csvCell(article.source),
      csvCell(article.date_article),
      csvCell(article.themes_mistral),
      csvCell(article.themes_ml),
      csvCell(article.score_confiance_ml),
      csvCell(article.tags),
    ]
    csv.push(row.join(","))
  }

  fs.writeFileSync(CSV_PATH, csv.join("\n") + "\n")

  console.log(`✔ ${csv.length} lignes écrites (en-tête + ${articles.length} articles) → ${CSV_PATH}`)
}

main()
