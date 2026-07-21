-- C24 — Contrôle du contrat de données sur `date_article`.
--
-- POURQUOI CE FICHIER EXISTE. L'agrégat sélectionne un jour par ENCADREMENT
-- (`date_article >= ?2 AND date_article < ?3`, cf. src/lib/aggregates.ts) au lieu de
-- `strftime('%Y-%m-%d', date_article) = ?`. C'est une comparaison de CHAÎNES : elle ne coïncide
-- avec une comparaison de DATES que si `date_article` est un ISO 8601 **UTC canonique**, la forme
-- que produit `toIsoOrNull` (`toISOString()`, ADR D09).
--
-- Le cas qui fait diverger les deux est précis : un horodatage à décalage horaire.
-- `2026-06-30T00:30:00+02:00` vaut 2026-06-29T22:30Z ; `strftime` le classe donc au **29**,
-- l'encadrement lexicographique au **30**. L'article serait compté dans le mauvais jour, sans
-- erreur. Vérifié par test (test/aggregates.test.ts, « ce que le contrat ne garantit pas »).
--
-- CE QUE CE CONTRÔLE CORRIGE. La vérification faite au moment de la réécriture comptait les
-- valeurs nulles, celles que `strftime` refuse, et celles ne respectant pas le préfixe
-- `AAAA-MM-JJ`. Aucun de ces trois tests n'écarte un décalage horaire : la mesure était juste,
-- mais elle ne prouvait pas ce pour quoi elle était citée. Cette requête-ci teste la propriété
-- dont dépend réellement l'encadrement.
--
-- LECTURE SEULE : `changed_db: false`, `rows_written: 0`.
--
--   # PowerShell
--   $sql = (Get-Content scripts/check-contrat-dates.sql | Where-Object { $_ -notmatch '^\s*--' }) -join ' '
--   npx wrangler d1 execute veille-analytics --remote --json --command $sql
--
--   # bash / WSL
--   npx wrangler d1 execute veille-analytics --remote --json \
--     --command "$(grep -v '^\s*--' scripts/check-contrat-dates.sql | tr '\n' ' ')"
--
-- ATTENDU : `hors_contrat` = 0. Toute autre valeur signifie qu'un agrégat peut ranger des
-- articles dans le mauvais jour, et impose de normaliser les lignes concernées avant de se fier
-- à `agg_quotidien` ou à `GET /api/stats/timeline`.
--
-- Mesuré en production le 2026-07-21 : **0 sur 542**.
--
-- ⚠️ La condition `hors_contrat` est DUPLIQUÉE dans test/aggregates.test.ts, qui vérifie qu'elle
-- détecte bien un décalage horaire — sans quoi ce contrôle pourrait renvoyer 0 pour de mauvaises
-- raisons. Même convention de commentaire croisé que health.ts / health-check.sql.

SELECT
    COUNT(*) AS total,
    -- Aller-retour : la valeur stockée est-elle exactement celle que SQLite rendrait en UTC
    -- canonique ? Plus strict qu'un contrôle de préfixe, et volontairement : il signale aussi
    -- les formes inoffensives (date seule), donc il ne peut pas manquer les nuisibles.
    -- `IS NOT` et non `<>` : null-safe, une date_article NULL ne compte pas ici.
    SUM(CASE WHEN strftime('%Y-%m-%dT%H:%M:%fZ', date_article) IS NOT date_article
             THEN 1 ELSE 0 END) AS hors_contrat,
    -- Exposées à part : une date absente ne fausse aucun agrégat, elle en sort (toute
    -- comparaison avec NULL est fausse, comme l'était `strftime` qui renvoyait NULL).
    SUM(CASE WHEN date_article IS NULL THEN 1 ELSE 0 END) AS sans_date
FROM articles;
