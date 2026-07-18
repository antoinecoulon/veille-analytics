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

export function parseArticleRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    themes_mistral: row.themes_mistral ? JSON.parse(row.themes_mistral as string) : [],
    // null = jamais classifié ; [] = classifié mais aucun thème au-dessus du seuil.
    themes_ml: row.themes_ml ? JSON.parse(row.themes_ml as string) : null,
    tags: row.tags ? JSON.parse(row.tags as string) : []
  }
}
