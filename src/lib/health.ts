// Santé du pipeline (P3 — C33/C24), lue par GET /api/stats/health.
//
// Jusqu'ici, un échec de classification ML était totalement silencieux : classifyAndStoreMl
// avale l'exception dans un console.error que personne ne lit, themes_ml reste NULL, et il
// fallait interroger la base à la main pour s'en apercevoir. Une collecte interrompue ne
// signalait rien non plus — l'arrêt de 67 jours de mai 2026 n'a été découvert qu'après coup,
// en établissant la baseline P2.
//
// Répartition des rôles, comme pour mlComparison : le SQL compte, le TypeScript juge. Les
// seuils vivent donc ici, pas dans la requête, et sont testables sans D1 (test/health.test.ts,
// qui couvre aussi la route en intégration).
//
// ⚠️ Le SQL de comptage est dupliqué dans scripts/health-check.sql (version exploitation).
// Même convention de commentaire croisé que aggregates.ts / rebuild-aggregates.sql.

/**
 * Seuils de fraîcheur de la collecte, en jours écoulés depuis la dernière ingestion réussie.
 *
 * Ancrés sur le **meilleur régime réellement atteint**, pas sur le régime observé aujourd'hui :
 * calibrer l'alarme sur la dérive constatée (moyenne 12,5 j sur l'ère D1) reviendrait à
 * normaliser la déviance et à produire un voyant vert par construction. Cf. ADR D12.
 *
 * - `ok` ≤ 3 j — médiane observée (3,5) et intervalle moyen de l'ère Node-RED (3,7)
 * - `degrade` 4 à 14 j — au-delà du meilleur régime, en deçà de la moyenne actuelle
 * - `alerte` > 14 j — pire que le régime déjà dégradé d'aujourd'hui
 */
export const FRAICHEUR_OK_JOURS = 3
export const FRAICHEUR_ALERTE_JOURS = 14

/**
 * Au-delà de ce délai, un `themes_ml` encore NULL est un échec avéré et non une course :
 * la classification part en `waitUntil` et dure quelques secondes, le retry borné de
 * classifyMl est épuisé depuis longtemps. Marge très large, donc aucun faux positif.
 */
export const ML_RETARD_HEURES = 24

export type Statut = "ok" | "degrade" | "alerte"

/** Compteurs bruts renvoyés par la requête SQL. */
export interface HealthRow {
  derniere_ingestion: string | null
  total: number
  ml_en_retard: number
  ml_sans_theme: number
  mistral_manquants: number
}

export interface PipelineHealth {
  statut: Statut
  collecte: {
    derniere_ingestion: string | null
    jours_depuis: number | null
    statut: Statut
  }
  classification: {
    total: number
    ml_en_retard: number
    ml_sans_theme: number
    mistral_manquants: number
    statut: Statut
  }
}

const GRAVITE: Record<Statut, number> = { ok: 0, degrade: 1, alerte: 2 }

function pire(a: Statut, b: Statut): Statut {
  return GRAVITE[a] >= GRAVITE[b] ? a : b
}

/** Horodatage avant lequel un article non classifié est considéré en retard. */
export function seuilRetardMl(now: Date): string {
  return new Date(now.getTime() - ML_RETARD_HEURES * 3_600_000).toISOString()
}

function joursDepuis(iso: string | null, now: Date): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  // Plancher à 0 : une date_collecte légèrement dans le futur (horloge décalée) ne doit pas
  // produire un nombre négatif de jours.
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

export function computeHealth(row: HealthRow, now: Date): PipelineHealth {
  const jours = joursDepuis(row.derniere_ingestion, now)

  // Aucune ingestion connue = le pipeline n'a jamais tourné (ou date illisible) : c'est une
  // alerte, pas un état neutre.
  let statutCollecte: Statut
  if (jours === null) statutCollecte = "alerte"
  else if (jours <= FRAICHEUR_OK_JOURS) statutCollecte = "ok"
  else if (jours <= FRAICHEUR_ALERTE_JOURS) statutCollecte = "degrade"
  else statutCollecte = "alerte"

  // Seul ml_en_retard pilote le statut, et de façon binaire.
  //
  // ml_sans_theme (themes_ml = '[]') n'est PAS un échec : l'article a bien été classifié,
  // aucun thème n'a simplement dépassé le seuil de 0,7. C'est la distinction NULL ≠ [] du
  // modèle de données, exposée ici pour rester lisible — 72 articles en prod, la faire
  // remonter en alerte rendrait l'indicateur inutilisable.
  //
  // mistral_manquants (2 en prod) est un résidu historique figé de la migration initiale,
  // pas un dysfonctionnement courant : exposé pour la même raison, neutre pour la même raison.
  const statutClassification: Statut = row.ml_en_retard > 0 ? "alerte" : "ok"

  return {
    statut: pire(statutCollecte, statutClassification),
    collecte: {
      derniere_ingestion: row.derniere_ingestion,
      jours_depuis: jours,
      statut: statutCollecte
    },
    classification: {
      total: row.total,
      ml_en_retard: row.ml_en_retard,
      ml_sans_theme: row.ml_sans_theme,
      mistral_manquants: row.mistral_manquants,
      statut: statutClassification
    }
  }
}
