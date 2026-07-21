-- C24 — Index de performance. Migration APPLICABLE EN PRODUCTION (contrairement aux
-- migrations 0002 à 0004, marquées `-dev`, qui ne concernent que la base locale).
--
-- Motivée par une mesure, pas par principe : `wrangler d1 insights` a montré que la base
-- servait des balayages complets sur tous ses chemins chauds, y compris à l'écriture. Chiffres
-- d'avant dans data/perf/perf-avant.json et data/perf/insights-avant.json ; raisonnement complet
-- dans l'ADR D13 et dans m3/05-performance.md.
--
-- Chaque index ci-dessous répond à une requête identifiée et a été retenu APRÈS vérification
-- qu'il change effectivement le plan d'exécution (EXPLAIN QUERY PLAN : SCAN → SEARCH). Aucun
-- index « au cas où » : sur une table écrite à chaque ingestion, un index inutile est un coût
-- net.
--
-- Application (la base de prod n'ayant jamais reçu les migrations dev, on applique ce fichier
-- explicitement plutôt que par `migrations apply`) :
--   node node_modules/wrangler/bin/wrangler.js d1 execute veille-analytics --remote \
--     --file migrations/0005_perf_indexes.sql

-- Sert deux besoins d'un seul index, sa colonne de tête étant date_article :
--   1. l'encadrement du jour de refreshAggregatesForDay (chemin d'ÉCRITURE, à chaque ingestion),
--      devenu utilisable par un index depuis l'abandon de strftime — cf. src/lib/aggregates.ts ;
--   2. le tri de GET /api/articles (ORDER BY date_article DESC, date_collecte DESC), qui
--      balayait et triait 542 lignes pour en rendre 20.
-- L'ordre DESC des deux colonnes reproduit celui de l'ORDER BY : SQLite peut alors parcourir
-- l'index dans le sens de lecture et s'arrêter au LIMIT, sans table de tri temporaire.
CREATE INDEX IF NOT EXISTS idx_articles_date_article
  ON articles (date_article DESC, date_collecte DESC);

-- Sert le DELETE par jour de refreshAggregatesForDay (chemin d'ÉCRITURE).
-- Ce n'est volontairement PAS une contrainte UNIQUE : thematique est NULL sur les lignes de
-- rollup, et SQLite considère deux NULL comme distincts — la contrainte ne garantirait donc pas
-- l'unicité là où elle importerait le plus. L'idempotence du rafraîchissement repose sur le
-- DELETE préalable, pas sur le schéma.
CREATE INDEX IF NOT EXISTS idx_agg_quotidien_date
  ON agg_quotidien (date, thematique);

-- Second index sur la MÊME table, avec les colonnes dans l'ordre inverse : il sert
-- GET /api/stats/timeline, qui filtre sur `thematique IS NULL` puis trie par date.
-- L'index précédent ne pouvait pas le servir (thematique n'y est pas colonne de tête, donc le
-- filtre restait un balayage) — mesuré : 862 lignes lues avant, 726 avec le seul index (date,
-- thematique), 137 avec celui-ci. Deux index sur une table écrite à chaque ingestion se
-- justifient ici parce que le rafraîchissement d'un jour ne touche qu'une poignée de lignes,
-- alors que la timeline est un chemin de lecture utilisateur.
CREATE INDEX IF NOT EXISTS idx_agg_quotidien_thematique_date
  ON agg_quotidien (thematique, date);

-- Sert le GROUP BY source de GET /api/stats/sources : le parcours de l'index est déjà ordonné
-- par source, ce qui supprime la table de tri temporaire du regroupement.
CREATE INDEX IF NOT EXISTS idx_articles_source
  ON articles (source);
