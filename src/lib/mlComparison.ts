import { LABEL_MAP } from "./classifyMl"

// Comparaison des classifications Mistral vs ML (Étape 15).
// Calcul en TS plutôt qu'en SQL : ~500 lignes à agréger, logique ensembliste
// plus lisible et testable unitairement ici que via json_each imbriqués.

const THEMES = Object.keys(LABEL_MAP)

export interface MlComparisonRow {
  themes_mistral: string | null
  themes_ml: string | null
}

export interface MlComparison {
  global: {
    total: number
    compares: number
    accord_exact: number
    chevauchement: number
    jaccard_moyen: number
  }
  par_theme: Array<{
    theme: string
    accord: number
    mistral_seul: number
    ml_seul: number
  }>
}

function parseThemes(raw: string | null): Set<string> | null {
  if (!raw) return null
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((t) => typeof t === "string")) : null
  } catch {
    return null
  }
}

export function computeMlComparison(rows: MlComparisonRow[]): MlComparison {
  let compares = 0
  let accordExact = 0
  let chevauchement = 0
  let jaccardSum = 0

  const parTheme = new Map(
    THEMES.map((theme) => [theme, { theme, accord: 0, mistral_seul: 0, ml_seul: 0 }])
  )

  for (const row of rows) {
    const mistral = parseThemes(row.themes_mistral)
    const ml = parseThemes(row.themes_ml)
    // Seuls les articles portant les deux classifications sont comparables.
    if (!mistral || !ml) continue
    compares++

    const inter = [...mistral].filter((t) => ml.has(t))
    const union = new Set([...mistral, ...ml])

    if (mistral.size === ml.size && inter.length === mistral.size) accordExact++
    if (inter.length > 0) chevauchement++
    // Deux ensembles vides sont identiques : Jaccard = 1 par convention.
    jaccardSum += union.size === 0 ? 1 : inter.length / union.size

    for (const theme of union) {
      const stat = parTheme.get(theme)
      if (!stat) continue // thème hors référentiel (ne devrait pas arriver)
      if (mistral.has(theme) && ml.has(theme)) stat.accord++
      else if (mistral.has(theme)) stat.mistral_seul++
      else stat.ml_seul++
    }
  }

  return {
    global: {
      total: rows.length,
      compares,
      accord_exact: accordExact,
      chevauchement,
      jaccard_moyen: compares === 0 ? 0 : Math.round((jaccardSum / compares) * 1000) / 1000
    },
    par_theme: [...parTheme.values()]
  }
}
