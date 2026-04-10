import fs from "node:fs";
import { env } from "node:process";

const MISTRAL_API_KEY = env.MISTRAL_API_KEY
const MODEL = "open-mistral-nemo"
const DELAY_MS = 5000

const THEMES = [
  "IA/ML", "DevOps/Infrastructure", "Architecture", "Sécurité",
  "Développement", "Pratiques/Qualité", "Productivité/Outils"
]

async function classifyArticles(article) {
  const prompt = `Analyse cet article tech. Retourne UNIQUEMENT un JSON : {"themes": ["theme1", "theme2"]}

    Titre : ${article.titre}
    Résumé : ${article.resume || "Pas de résumé"}
    Source : ${article.source}

    Thèmes possibles (1 à 3) : ${THEMES.join(", ")}
  `

  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MISTRAL_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      response_format: { type: "json_object" }
    })
  })

  const data = await res.json()

  if (data.object === "error" || !data.choices) {
    console.error(`  API error: ${data.message || JSON.stringify(data).substring(0, 100)}`);
    return null
  }

  const content = data.choices[0].message.content
  const parsed = JSON.parse(content)
  return parsed.themes || []
}

function escape(str) {
  return str.replace(/'/g, "''")
}

async function main() {
  const raw = fs.readFileSync("./data/articles_sans_themes.json", "utf-8")
  const result = JSON.parse(raw)

  const articles = result[0].results
  console.log(`${articles.length} articles à classifier\n`)

  const updates = []
  let success = 0
  let errors = 0

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i]
    console.log(`[${i + 1}] ${article.titre.substring(0, 50)}...`)

    try {
      const themes = await classifyArticles(article)
      if (themes) {
        const themesJson = escape(JSON.stringify(themes))
        updates.push(
          `UPDATE articles SET themes_mistral = '${themesJson}' WHERE id = ${article.id};`
        )
        console.log(` -> ${themes.join(", ")}`)
        success++
      } else {
        errors++
      }
    } catch (e) {
      console.error(` Erreur: ${e.message}`)
      errors++
    }

    if (i < articles.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_MS))
    }
  }

  fs.writeFileSync("./migrations/0003_reclassify_themes.sql", updates.join("\n"))
  console.log(`\nTerminé: ${success} classifiés, ${errors} erreurs`)
  console.log(`SQL généré dans migrations/`)
}

main()