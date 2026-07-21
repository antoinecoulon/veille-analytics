const fs = require("node:fs")

const raw = JSON.parse(fs.readFileSync("./data/dates_prod.json", "utf-8"))
const rows = raw[0].results

const escape = (s) => "'" + String(s).replaceAll("'", "''") + "'"

const updates = rows
  .filter((r) => r.date_article)
  .map((r) => {
    const d = new Date(r.date_article)
    if (Number.isNaN(d.getTime())) return null
    return `UPDATE articles SET date_article = ${escape(d.toISOString())}
      WHERE url = ${escape(r.url)};`
  })
  .filter(Boolean)

// Correctif de DONNÉES, pas une migration de schéma : il ne va pas dans migrations/, qui est
// appliqué en bloc et sans réfléchir sur tous les environnements (cf. migrations/README.md).
// Ce fichier écrivait auparavant `migrations/0005_normalize_dates_prod.sql` — un numéro qui
// serait entré en collision avec la migration d'index de C24, et surtout un emplacement d'où
// il aurait été rejoué sur n'importe quelle base.
fs.writeFileSync("./scripts/sql-ponctuels/normalize_dates_prod.sql", updates.join("\n"))
console.log(`${updates.length} UPDATE générés sur ${rows.length} lignes`)