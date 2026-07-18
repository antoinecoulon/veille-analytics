// Étape 14 — Backfill de la classification ML zero-shot sur les articles existants.
//
// Appelle l'Inference API serverless Hugging Face (le contrat ML — endpoint, payload,
// mapping des labels, seuil — est DUPLIQUÉ ici depuis src/lib/classifyMl.ts, source de
// vérité TypeScript utilisée par le Worker ; ce script Node ne peut pas importer un .ts).
// Toute évolution du contrat (LABEL_MAP, seuil, template) doit être répercutée aux deux
// endroits, cf. commentaire "synchronisé avec src/lib/classifyMl.ts" ci-dessous.
//
// Entrée : data/articles_sans_ml.json, produit par (503 articles en base, cf. Étape 12) :
//   pnpm wrangler d1 execute veille-analytics --remote --json \
//     --command "SELECT id, titre, resume FROM articles WHERE themes_ml IS NULL" \
//     > data/articles_sans_ml.json
//
// Sortie : data/backfill_themes_ml.sql (UPDATE par article), appliqué ensuite via :
//   pnpm wrangler d1 execute veille-analytics --remote --file data/backfill_themes_ml.sql
//
// Token : HF_API_TOKEN doit être présent dans l'environnement (Node charge .env.local
// via le flag natif --env-file, comme reclassify.js qui lit MISTRAL_API_KEY sans code de
// chargement dédié) :
//   node --env-file=.env.local scripts/classify-ml.mjs
//
// Re-runnable : l'export SQL source filtre déjà `themes_ml IS NULL`, donc un article en
// échec définitif reste NULL et sera repris automatiquement au prochain export + run.

import fs from "node:fs"

const EXPORT_PATH = "./data/articles_sans_ml.json"
const SQL_PATH = "./data/backfill_themes_ml.sql"
const HF_API_TOKEN = process.env.HF_API_TOKEN
const DELAY_MS = 2000 // free tier HF : quelques centaines de req/h, on reste large.

// --- Contrat ML — synchronisé avec src/lib/classifyMl.ts (ne pas diverger) -------------

const MODEL_ID = "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli"
const HF_URL = `https://router.huggingface.co/hf-inference/models/${MODEL_ID}`

// Libellés canoniques -> hypothèses descriptives FR (cf. scripts/reclassify.js pour la
// liste des 7 thèmes bruts).
const LABEL_MAP = {
  "IA/ML": "intelligence artificielle et machine learning",
  "DevOps/Infrastructure": "DevOps, cloud et infrastructure",
  "Architecture": "architecture logicielle et conception de systèmes",
  "Sécurité": "sécurité informatique et cybersécurité",
  "Développement": "développement logiciel et programmation",
  "Pratiques/Qualité": "pratiques d'ingénierie, tests et qualité logicielle",
  "Productivité/Outils": "productivité et outils pour développeurs",
}

const LABEL_INVERSE = Object.fromEntries(
  Object.entries(LABEL_MAP).map(([theme, hypothesis]) => [hypothesis, theme]),
)

const CANDIDATE_LABELS = Object.values(LABEL_MAP)
const HYPOTHESIS_TEMPLATE = "Cet article parle de {}."
const ML_THRESHOLD = 0.7

// Backoff en cas de 429 (rate limit) ou 5xx (503 = modèle en chargement / cold start).
const RETRY_DELAYS_MS = [2000, 5000, 10000]

// La réponse hf-inference suit le format du pipeline transformers ({ labels, scores }
// triés desc) ; la spec Inference Providers documente aussi [{ label, score }] — les
// deux formats sont acceptés ici, comme dans mapHfResponse (classifyMl.ts).
function mapHfResponse(raw) {
  let pairs = []

  if (Array.isArray(raw)) {
    pairs = raw
  } else if (raw && typeof raw === "object") {
    const { labels, scores } = raw
    if (Array.isArray(labels) && Array.isArray(scores)) {
      pairs = labels.map((label, i) => ({ label, score: scores[i] }))
    }
  }

  const scored = pairs.flatMap(({ label, score }) => {
    const theme = typeof label === "string" ? LABEL_INVERSE[label] : undefined
    return theme && typeof score === "number" ? [{ theme, score }] : []
  })

  if (scored.length === 0) {
    throw new Error(`Réponse HF inexploitable : ${JSON.stringify(raw).slice(0, 200)}`)
  }

  return {
    themes: scored.filter((s) => s.score >= ML_THRESHOLD).map((s) => s.theme),
    confidence: Math.max(...scored.map((s) => s.score)),
  }
}

async function classifyArticle(titre, resume, token, retryDelaysMs = RETRY_DELAYS_MS) {
  const body = JSON.stringify({
    inputs: `${titre}. ${resume ?? ""}`.trim(),
    parameters: {
      // En tableau : une hypothèse contient une virgule, pas de format CSV possible.
      candidate_labels: CANDIDATE_LABELS,
      hypothesis_template: HYPOTHESIS_TEMPLATE,
      multi_label: true,
    },
  })

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(HF_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    })

    if (res.ok) return mapHfResponse(await res.json())

    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= retryDelaysMs.length) {
      throw new Error(`Inference API HF ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]))
  }
}

// --- Backfill ---------------------------------------------------------------------------

function escape(str) {
  return str.replaceAll("'", "''")
}

async function main() {
  if (!HF_API_TOKEN) {
    throw new Error(
      "HF_API_TOKEN manquant. Lance avec : node --env-file=.env.local scripts/classify-ml.mjs",
    )
  }

  const raw = fs.readFileSync(EXPORT_PATH, "utf-8")
  const result = JSON.parse(raw)
  const articles = result[0].results

  console.log(`${articles.length} articles à classifier (ML zero-shot)\n`)

  // SQL écrit au fil de l'eau : une interruption ne perd pas les articles déjà classés.
  fs.writeFileSync(SQL_PATH, "")
  let success = 0
  let errors = 0
  let emptyThemes = 0

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i]
    console.log(`[${i + 1}/${articles.length}] ${article.titre.substring(0, 50)}...`)

    try {
      const { themes, confidence } = await classifyArticle(article.titre, article.resume, HF_API_TOKEN)
      const themesJson = escape(JSON.stringify(themes))
      const score = Math.round(confidence * 10000) / 10000
      fs.appendFileSync(
        SQL_PATH,
        `UPDATE articles SET themes_ml = '${themesJson}', score_confiance_ml = ${score} WHERE id = ${article.id};\n`,
      )

      if (themes.length === 0) {
        emptyThemes++
        console.log(`  -> (aucun thème >= seuil, confiance max ${score})`)
      } else {
        console.log(`  -> ${themes.join(", ")} (confiance ${score})`)
      }
      success++
    } catch (e) {
      console.error(`  Erreur définitive: ${e.message}`)
      errors++
    }

    if (i < articles.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_MS))
    }
  }

  console.log(`\nTerminé: ${success} classifiés, ${errors} échecs, ${emptyThemes} sans thème (>= seuil)`)
  console.log(`SQL généré dans ${SQL_PATH}`)
  if (errors > 0) {
    console.log(
      "Les articles en échec restent themes_ml IS NULL : relance l'export puis ce script pour les reprendre.",
    )
  }
}

main()
