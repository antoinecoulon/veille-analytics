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

// date_article est stocké en ISO (toIsoOrNull à l'ingestion) ; strftime renvoie NULL sur
// une valeur non analysable, ces lignes ne matchent alors jamais un jour donné.
const JOUR = "strftime('%Y-%m-%d', date_article)"

/**
 * Recalcule intégralement l'agrégat d'un jour (format `YYYY-MM-DD`).
 *
 * Recalcul plutôt qu'incrément : l'opération est idempotente, donc rejouable sans dérive,
 * et `score_moyen` étant une moyenne on ne pourrait pas l'incrémenter sans stocker le
 * dénominateur. Le coût est négligeable (quelques articles par jour).
 */
export async function refreshAggregatesForDay(db: D1Database, jour: string): Promise<void> {
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
         WHERE ${JOUR} = ?1 AND themes_mistral IS NOT NULL
         GROUP BY value`
      )
      .bind(jour),

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
         WHERE ${JOUR} = ?1
         HAVING COUNT(*) > 0`
      )
      .bind(jour)
  ])
}
