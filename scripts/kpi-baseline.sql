-- P2 (C35) — KPI du processus de veille, avant / après l'industrialisation.
--
-- Régénère l'intégralité du tableau de m3/04-baseline-kpi.md. Aucun chiffre du rapport ne
-- doit être recopié à la main : C35 demande de MESURER l'impact, et la règle du projet est
-- de ne jamais citer une métrique sans l'avoir revérifiée.
--
-- ⚠️ NE PAS lancer avec `--file` : ce mode n'affiche qu'un résumé et jamais les lignes d'un
-- SELECT (il est conçu pour les migrations). Il faut passer la requête à `--command`, en
-- retirant au passage les commentaires — sinon la ligne de commande dépasse la limite de
-- longueur sous Windows.
--
--   # bash / WSL
--   npx wrangler d1 execute veille-analytics --remote --json \
--     --command "$(grep -v '^\s*--' scripts/kpi-baseline.sql | tr '\n' ' ')"
--
--   # PowerShell
--   $sql = (Get-Content scripts/kpi-baseline.sql | Where-Object { $_ -notmatch '^\s*--' }) -join ' '
--   npx wrangler d1 execute veille-analytics --remote --json --command $sql
--
-- LECTURE SEULE : `changed_db: false`, `rows_written: 0` à chaque exécution.
--
-- Sortie : deux lignes, une par ère. Le document m3/04 les transpose en tableau
-- indicateur / avant / après.
--
-- Frontière des deux ères : 2026-04-01.
--   « avant » = pipeline Node-RED seul (fichier JSON local, mail quotidien).
--   « après » = pipeline D1 (Worker, API, dashboard, classification ML).
-- Elle est fiable pour deux raisons : scripts/migrate.js a conservé `analyzedAt` de Node-RED
-- comme date_collecte des articles migrés — la période antérieure est donc réellement
-- mesurée, pas reconstituée de mémoire — et aucune collecte n'a eu lieu entre le 2026-03-27
-- (dernière passe Node-RED) et le 2026-04-09 (première ingestion par le Worker), si bien
-- qu'aucun article ne peut être attribué à la mauvaise ère.
--
-- NB : date_collecte (quand l'article est entré dans le système) ≠ date_article (quand il a
-- été publié). Les jours de collecte se comptent en dizaines, les jours de publication en
-- centaines : ne pas confondre les deux dans le rapport.
--
-- Deux contraintes de D1 ont façonné la forme de cette requête :
--   1. La forme « une ligne par indicateur » via UNION ALL dépasse la limite de termes d'un
--      compound SELECT (SQLITE_ERROR « too many terms »). D'où l'agrégation par ère.
--   2. `wrangler d1 execute --file` ne renvoie qu'un résumé quand le fichier contient
--      PLUSIEURS instructions — il est conçu pour les migrations, pas pour lire. D'où une
--      instruction unique, où les métriques de régularité sont jointes aux volumes.

WITH faits AS (
    SELECT
        strftime('%Y-%m-%d', date_collecte) AS jour_collecte,
        CASE WHEN date_collecte < '2026-04-01' THEN 'avant' ELSE 'apres' END AS ere,
        score_mistral,
        categorie_mistral,
        themes_mistral,
        source,
        julianday(date_collecte) - julianday(date_article) AS age_jours
    FROM articles
),
-- Écarts entre passes successives. Le partitionnement par ère exclut volontairement
-- l'intervalle de transition (27 mars → 9 avril) : il relève du basculement d'un système à
-- l'autre, pas d'une interruption imputable à l'un des deux.
jours AS (
    SELECT DISTINCT ere, jour_collecte FROM faits
),
ecarts AS (
    SELECT
        ere,
        julianday(jour_collecte)
            - julianday(LAG(jour_collecte) OVER (PARTITION BY ere ORDER BY jour_collecte))
          AS ecart_j
    FROM jours
),
regularite AS (
    SELECT
        ere,
        ROUND(AVG(ecart_j), 1)        AS intervalle_moyen_j,
        CAST(MAX(ecart_j) AS INTEGER) AS plus_longue_interruption_j
    FROM ecarts
    WHERE ecart_j IS NOT NULL
    GROUP BY ere
),
volumes AS (
SELECT
    ere,
    COUNT(*)                                                         AS articles,
    COUNT(DISTINCT jour_collecte)                                    AS passes,
    MIN(jour_collecte)                                               AS premiere_collecte,
    MAX(jour_collecte)                                               AS derniere_collecte,
    CAST(julianday(MAX(jour_collecte)) - julianday(MIN(jour_collecte)) AS INTEGER)
                                                                     AS etendue_j,
    ROUND(1.0 * COUNT(*) / COUNT(DISTINCT jour_collecte), 1)         AS articles_par_passe,
    ROUND(AVG(age_jours), 1)                                         AS age_moyen_j,
    -- Biais annoncé dans docs/001-conception-initiale.md (mars 2026) : 76 % de score 3,
    -- 22 % de score 4, jamais de 1, 2, 5 ni de HORS_SCOPE.
    ROUND(100.0 * SUM(score_mistral = 3) / COUNT(*), 1)              AS pct_score_3,
    ROUND(100.0 * SUM(score_mistral = 4) / COUNT(*), 1)              AS pct_score_4,
    SUM(score_mistral IN (1, 2))                                     AS notes_1_ou_2,
    SUM(score_mistral = 5)                                           AS notes_5,
    COUNT(DISTINCT categorie_mistral)                                AS categories_distinctes,
    SUM(categorie_mistral = 'HORS_SCOPE')                            AS hors_scope,
    COUNT(DISTINCT source)                                           AS sources_distinctes,
    SUM(themes_mistral IS NULL)                                      AS sans_theme
FROM faits
GROUP BY ere
)

SELECT
    v.*,
    r.intervalle_moyen_j,
    r.plus_longue_interruption_j
FROM volumes v
JOIN regularite r ON r.ere = v.ere
ORDER BY v.ere DESC;
