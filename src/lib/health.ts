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
// Même convention de commentaire croisé que aggregates.ts / rebuild-aggregates.sql. Les deux
// versions ne comptent d'ailleurs pas de la même façon — ici une comparaison de chaînes ISO
// (date_collecte < seuilRetardMl(now)), là-bas de l'arithmétique julianday. Elles ne coïncident
// que si tout date_collecte a exactement la forme d'un toISOString() : condition mesurée en prod
// le 2026-07-20 (0 écart sur 529 articles) plutôt que supposée, cf. l'en-tête du script.

/**
 * Seuils de fraîcheur de la collecte, en jours écoulés depuis le dernier article collecté.
 *
 * Le repère est bien le dernier article **inséré**, pas la dernière passe de collecte : le
 * pipeline ne journalise pas ses passes, et une passe qui ne ramène que des doublons n'écrit
 * rien (`INSERT OR IGNORE`). Cf. la limite énoncée par l'ADR D12.
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
  dernier_article_collecte: string | null
  total: number
  ml_en_retard: number
  ml_sans_theme: number
  mistral_manquants: number
}

export interface PipelineHealth {
  statut: Statut
  collecte: {
    dernier_article_collecte: string | null
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
  const jours = joursDepuis(row.dernier_article_collecte, now)

  // Aucun article connu = le pipeline n'a jamais rien collecté (ou date illisible) : c'est une
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
  //
  // ⚠️ Asymétrie assumée : le raisonnement « ne pas rendre l'indicateur définitivement rouge »
  // qui neutralise ces deux compteurs ne s'applique PAS à ml_en_retard, qui n'offre aucun moyen
  // d'acquitter un article définitivement non classifiable. Un seul contenu que Hugging Face
  // refuserait durablement épinglerait le statut à `alerte` sans recours. Le cas ne se manifeste
  // pas (0 en prod, backfill 503/503) et l'acquittement supposerait une migration ; limite
  // énoncée dans l'ADR D12 plutôt que couverte.
  const statutClassification: Statut = row.ml_en_retard > 0 ? "alerte" : "ok"

  return {
    statut: pire(statutCollecte, statutClassification),
    collecte: {
      dernier_article_collecte: row.dernier_article_collecte,
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
