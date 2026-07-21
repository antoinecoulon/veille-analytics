// Maintenance de l'agrégat décisionnel (dim_date + agg_quotidien).
//
// Ces deux tables existent depuis 0001_init.sql mais n'étaient ni alimentées ni lues :
// le schéma en étoile revendiqué par l'ADR D05 était resté purement déclaratif. L'agrégat
// est désormais maintenu à l'écriture (ici, à chaque ingestion) et lu par
// GET /api/stats/timeline. Cf. ADR D11.
//
// ⚠️ Le SQL ci-dessous est DUPLIQUÉ dans scripts/rebuild-aggregates.sql, qui reconstruit
// tous les jours d'un coup (même logique, GROUP BY sur toute la base au lieu d'un jour
// filtré). Toute évolution doit être répercutée aux deux endroits — même convention que
// le contrat ML entre src/lib/classifyMl.ts et scripts/classify-ml.mjs.

// Sélection du jour par ENCADREMENT plutôt que par `strftime('%Y-%m-%d', date_article) = ?`.
//
// L'expression strftime s'applique à chaque ligne : elle est non sargable, donc aucun index sur
// date_article ne peut être utilisé, et le filtre coûte un balayage complet de la table — sur le
// chemin d'écriture, à chaque ingestion. Mesuré en production le 2026-07-21 avant correction :
// 542 lignes lues pour écrire 2 lignes de rollup (cf. data/perf/perf-avant.json et l'ADR D13).
//
// La comparaison lexicographique est ici équivalente à la comparaison de dates parce que
// date_article est stocké en ISO 8601 (toIsoOrNull à l'ingestion, ADR D09) : tout horodatage du
// jour J s'écrit « J » suivi d'un « T », donc se situe entre « J » inclus et « J+1 » exclu.
// Condition MESURÉE en production le 2026-07-21, pas supposée : sur 542 articles, 0 date_article
// nulle, 0 non analysable par strftime, 0 hors du format ISO.
//
// Les deux bornes sont calculées en TypeScript et passées en paramètres — même répartition que
// seuilRetardMl dans health.ts (« le SQL compte, le TypeScript juge ») : la définition d'un jour
// reste à un seul endroit, testable sans D1.
const JOUR_ENCADRE = "date_article >= ?2 AND date_article < ?3"

const FORMAT_JOUR = /^\d{4}-\d{2}-\d{2}$/

/**
 * Bornes `[début, fin[` du jour `YYYY-MM-DD`, au format directement comparable à date_article.
 *
 * La borne haute est le jour suivant, calculé en UTC — jamais `jour + 'T99'` ou un artifice du
 * même genre : le passage de mois ou d'année doit être juste, y compris les années bissextiles.
 *
 * La validation est en deux temps, et les deux sont nécessaires :
 *
 * 1. **La forme**, par une expression régulière. `Date.parse` est bien trop permissif pour servir
 *    de validateur : il accepte des variantes non canoniques dont la borne basse, renvoyée telle
 *    quelle, se comparerait mal — la comparaison est lexicographique, donc `"2026-6-9"` se situe
 *    *après* `"2026-06-10"`.
 * 2. **L'existence**, par un aller-retour. Une date calendaire impossible passe l'expression
 *    régulière et JavaScript la **reporte** silencieusement au lieu de la rejeter : le 30 février
 *    2026 devient le 2 mars. Sans ce contrôle, `bornesDuJour("2026-02-30")` renvoyait
 *    `["2026-02-30", "2026-03-03"]` — une fenêtre de **trois jours** étiquetée comme un seul, qui
 *    aurait fait compter trois journées d'articles dans une ligne d'`agg_quotidien` unique, sans
 *    la moindre erreur. Le message d'origine promettait « attendu YYYY-MM-DD » sans le vérifier.
 *
 * Le chemin d'ingestion ne peut pas produire un tel jour (`toIsoOrNull` puis `slice(0, 10)`), mais
 * la fonction est exportée : tout appelant futur — reconstruction jour par jour, paramètre d'API —
 * doit obtenir une erreur plutôt qu'un agrégat faux.
 */
export function bornesDuJour(jour: string): [string, string] {
  if (!FORMAT_JOUR.test(jour)) {
    throw new Error(`Jour invalide (attendu YYYY-MM-DD) : ${jour}`)
  }

  const debut = new Date(`${jour}T00:00:00.000Z`)
  if (Number.isNaN(debut.getTime()) || debut.toISOString().slice(0, 10) !== jour) {
    throw new Error(`Jour invalide (date calendaire inexistante) : ${jour}`)
  }

  return [jour, new Date(debut.getTime() + 86_400_000).toISOString().slice(0, 10)]
}

/**
 * Recalcule intégralement l'agrégat d'un jour (format `YYYY-MM-DD`).
 *
 * Recalcul plutôt qu'incrément : l'opération est idempotente, donc rejouable sans dérive,
 * et `score_moyen` étant une moyenne on ne pourrait pas l'incrémenter sans stocker le
 * dénominateur. Le coût est négligeable (quelques articles par jour).
 */
export async function refreshAggregatesForDay(db: D1Database, jour: string): Promise<void> {
  const [debut, fin] = bornesDuJour(jour)

  await db.batch([
    // Dimension calendaire. date_complete est UNIQUE : OR IGNORE rend l'appel idempotent.
    db
      .prepare(
        `INSERT OR IGNORE INTO dim_date (date_complete, annee, mois, semaine, jour_semaine)
         VALUES (?1,
                 CAST(strftime('%Y', ?1) AS INTEGER),
                 CAST(strftime('%m', ?1) AS INTEGER),
                 CAST(strftime('%W', ?1) AS INTEGER),
                 CAST(strftime('%w', ?1) AS INTEGER))`
      )
      .bind(jour),

    db.prepare("DELETE FROM agg_quotidien WHERE date = ?1").bind(jour),

    // Lignes par thème : un article multi-thèmes compte dans chacune de ses lignes.
    db
      .prepare(
        `INSERT INTO agg_quotidien (date, thematique, nb_articles, score_moyen)
         SELECT ?1, value, COUNT(*), AVG(score_mistral)
         FROM articles, json_each(articles.themes_mistral)
         WHERE ${JOUR_ENCADRE} AND themes_mistral IS NOT NULL
         GROUP BY value`
      )
      .bind(jour, debut, fin),

    // Ligne de rollup (thematique NULL) = total du jour, toutes thématiques confondues.
    // Calculée SANS la jointure json_each : sommer les lignes par thème double-compterait
    // les articles multi-thèmes et oublierait ceux dont themes_mistral est NULL.
    // HAVING COUNT(*) > 0 évite d'écrire un rollup à zéro pour un jour sans article
    // (un agrégat sans GROUP BY renvoie toujours une ligne).
    db
      .prepare(
        `INSERT INTO agg_quotidien (date, thematique, nb_articles, score_moyen)
         SELECT ?1, NULL, COUNT(*), AVG(score_mistral)
         FROM articles
         WHERE ${JOUR_ENCADRE}
         HAVING COUNT(*) > 0`
      )
      .bind(jour, debut, fin)
  ])
}
