-- P1 (C27) — Reconstruction complète de l'agrégat décisionnel.
--
-- Vide puis reconstruit dim_date et agg_quotidien à partir de la table de faits articles.
-- SQL pur, sans dépendance à Node : applicable directement par wrangler.
--
--   npx wrangler d1 execute veille-analytics --remote --file scripts/rebuild-aggregates.sql
--
-- REJOUABLE : l'opération est idempotente (purge puis recalcul intégral). C'est le filet de
-- sécurité du maintien incrémental fait à l'ingestion — si un rafraîchissement par jour a
-- échoué, ce script remet tout d'aplomb.
--
-- ⚠️ Même logique que refreshAggregatesForDay dans src/lib/aggregates.ts, mais sur tous les
-- jours d'un coup (GROUP BY au lieu d'un jour filtré). Toute évolution doit être répercutée
-- aux deux endroits — même convention que le contrat ML entre src/lib/classifyMl.ts et
-- scripts/classify-ml.mjs.
--
-- La table articles n'est JAMAIS écrite par ce script.

DELETE FROM agg_quotidien;
DELETE FROM dim_date;

-- Dimension calendaire : une ligne par jour distinct présent dans les faits.
INSERT OR IGNORE INTO dim_date (date_complete, annee, mois, semaine, jour_semaine)
SELECT DISTINCT
    strftime('%Y-%m-%d', date_article),
    CAST(strftime('%Y', date_article) AS INTEGER),
    CAST(strftime('%m', date_article) AS INTEGER),
    CAST(strftime('%W', date_article) AS INTEGER),
    CAST(strftime('%w', date_article) AS INTEGER)
FROM articles
WHERE strftime('%Y-%m-%d', date_article) IS NOT NULL;

-- Lignes par thème : un article multi-thèmes compte dans chacune de ses lignes.
-- Aucun filtrage sur le référentiel : on reste cohérent avec GET /api/stats/themes, qui
-- renvoie lui aussi les 3 libellés hors référentiel connus (« Produktivité/Outils » [typo],
-- « Infrastructure », « IoT »).
INSERT INTO agg_quotidien (date, thematique, nb_articles, score_moyen)
SELECT
    strftime('%Y-%m-%d', date_article),
    value,
    COUNT(*),
    AVG(score_mistral)
FROM articles, json_each(articles.themes_mistral)
WHERE themes_mistral IS NOT NULL
  AND strftime('%Y-%m-%d', date_article) IS NOT NULL
GROUP BY 1, 2;

-- Lignes de rollup (thematique NULL) = total du jour, toutes thématiques confondues.
-- Calculées SANS la jointure json_each : sommer les lignes par thème double-compterait les
-- articles multi-thèmes et oublierait ceux dont themes_mistral est NULL.
INSERT INTO agg_quotidien (date, thematique, nb_articles, score_moyen)
SELECT
    strftime('%Y-%m-%d', date_article),
    NULL,
    COUNT(*),
    AVG(score_mistral)
FROM articles
WHERE strftime('%Y-%m-%d', date_article) IS NOT NULL
GROUP BY 1;
