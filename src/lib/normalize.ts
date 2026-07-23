// Fonctions de normalisation extraites des handlers pour être testables unitairement.

export function normalizeTags(input: unknown): string {
  return Array.isArray(input)
    ? JSON.stringify(input.map((t: string) => t.toLowerCase().trim()))
    : "[]"
}

export function toIsoOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Désérialise une colonne TEXT censée contenir un tableau JSON, sans jamais lever.
 *
 * Le `JSON.parse` était nu ici, alors que `parseThemes` (src/lib/mlComparison.ts) gardait
 * déjà le sien : l'asymétrie était fortuite, et c'est le chemin non gardé qui portait le
 * risque le plus concret. `GET /api/articles` désérialise trois colonnes pour chaque ligne
 * rendue ; une seule valeur illisible en base faisait tomber la page entière en 500, sans
 * qu'aucun message n'indique quel article était en cause.
 *
 * Le risque n'est pas théorique sur cette base : elle a reçu des écritures directes lors de
 * la migration initiale et des correctifs ponctuels (scripts/sql-ponctuels/), et elle porte
 * déjà des anomalies qualité assumées — trois libellés hors référentiel, dont une faute de
 * frappe. Rien ne contraint le format de ces colonnes au niveau du schéma.
 *
 * **Arbitrage assumé** : une valeur illisible est traitée comme absente plutôt que propagée
 * en erreur. C'est le même choix que `parseThemes`, et il a un coût — pour `themes_ml`, le
 * repli `null` dit « jamais classifié », ce qui est faux d'un article dont la valeur est
 * corrompue. On préfère cette imprécision sur une ligne à une page indisponible, d'autant que
 * l'écart reste détectable : `GET /api/stats/health` compte les `themes_ml` restés `NULL` en
 * base, où la valeur corrompue, elle, ne l'est pas.
 */
export function parseJsonArray<T>(raw: unknown, defaut: T): unknown[] | T {
  if (!raw) return defaut
  try {
    const valeur = JSON.parse(raw as string)
    // Un JSON valide mais non-tableau (`"3"`, `{}`) est aussi hors contrat que du JSON cassé :
    // le client attend un tableau, et lui en rendre un autre type déplacerait simplement la
    // panne dans le navigateur.
    return Array.isArray(valeur) ? valeur : defaut
  } catch {
    return defaut
  }
}

export function parseArticleRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    themes_mistral: parseJsonArray(row.themes_mistral, [] as unknown[]),
    // null = jamais classifié ; [] = classifié mais aucun thème au-dessus du seuil.
    themes_ml: parseJsonArray(row.themes_ml, null),
    tags: parseJsonArray(row.tags, [] as unknown[])
  }
}
