-- P3 (C33/C24) — santé du pipeline, version exploitation.
--
-- Même mesure que `GET /api/stats/health`, exécutable sans passer par le Worker : sert à
-- recouper l'endpoint (les compteurs doivent coïncider exactement) et à diagnostiquer quand
-- le Worker lui-même est en cause.
--
-- ⚠️ DUPLICATION ASSUMÉE : la vérité vit dans src/lib/health.ts (compteurs) et dans les
-- constantes FRAICHEUR_OK_JOURS / FRAICHEUR_ALERTE_JOURS / ML_RETARD_HEURES (seuils). Ce
-- fichier les recopie parce qu'un `.sql` ne peut pas importer un `.ts`. Toute évolution des
-- seuils doit être répercutée ici — même convention que aggregates.ts / rebuild-aggregates.sql
-- et que classifyMl.ts / classify-ml.mjs.
--
-- ⚠️ NE PAS lancer avec `--file` : ce mode n'affiche qu'un résumé et jamais les lignes d'un
-- SELECT (il est conçu pour les migrations). Passer la requête à `--command`, en retirant au
-- passage les commentaires — sinon la ligne de commande dépasse la limite de longueur sous
-- Windows.
--
--   # bash / WSL
--   npx wrangler d1 execute veille-analytics --remote --json \
--     --command "$(grep -v '^\s*--' scripts/health-check.sql | tr '\n' ' ')"
--
--   # PowerShell
--   $sql = (Get-Content scripts/health-check.sql | Where-Object { $_ -notmatch '^\s*--' }) -join ' '
--   npx wrangler d1 execute veille-analytics --remote --json --command $sql
--
-- LECTURE SEULE : `changed_db: false`, `rows_written: 0` à chaque exécution.
--
-- Lecture des colonnes :
--   derniere_ingestion  MAX(date_collecte) — la dernière passe de collecte réussie.
--   jours_depuis        Âge de cette passe. Seuils : ok <= 3, degrade 4-14, alerte > 14.
--                       Ancrés sur le meilleur régime réellement atteint (médiane observée
--                       3,5 j, ère Node-RED 3,7 j) et non sur la dérive constatée (moyenne
--                       12,5 j) — cf. ADR D12.
--   ml_en_retard        themes_ml encore NULL plus de 24 h après la collecte = échec avéré
--                       de classification (le waitUntil dure quelques secondes, le retry
--                       borné est épuisé depuis longtemps). Rattrapable par
--                       scripts/classify-ml.mjs. C'est le SEUL compteur qui déclenche une
--                       alerte de classification, et il le fait dès 1.
--   ml_sans_theme       themes_ml = '[]' : article classifié, mais aucun thème au-dessus du
--                       seuil de 0,7. N'est PAS un échec (NULL != []), n'alerte jamais.
--   mistral_manquants   Résidu historique figé de la migration initiale, pas un
--                       dysfonctionnement courant. N'alerte jamais.

SELECT
    (SELECT MAX(date_collecte) FROM articles) AS derniere_ingestion,

    CAST(julianday('now') - julianday((SELECT MAX(date_collecte) FROM articles)) AS INTEGER)
        AS jours_depuis,

    (SELECT COUNT(*) FROM articles) AS total,

    -- 24 h = ML_RETARD_HEURES. L'endpoint calcule ce seuil en TypeScript et le passe en
    -- paramètre ; ici on l'exprime en jours juliens, ce qui est équivalent.
    (SELECT COUNT(*) FROM articles
      WHERE themes_ml IS NULL
        AND julianday('now') - julianday(date_collecte) > 1.0) AS ml_en_retard,

    (SELECT COUNT(*) FROM articles WHERE themes_ml = '[]') AS ml_sans_theme,

    (SELECT COUNT(*) FROM articles WHERE themes_mistral IS NULL) AS mistral_manquants,

    -- Statuts : recopie des seuils de src/lib/health.ts (cf. avertissement en en-tête).
    CASE
        WHEN (SELECT MAX(date_collecte) FROM articles) IS NULL THEN 'alerte'
        WHEN julianday('now') - julianday((SELECT MAX(date_collecte) FROM articles)) < 4.0
            THEN 'ok'
        WHEN julianday('now') - julianday((SELECT MAX(date_collecte) FROM articles)) < 15.0
            THEN 'degrade'
        ELSE 'alerte'
    END AS statut_collecte,

    CASE
        WHEN (SELECT COUNT(*) FROM articles
               WHERE themes_ml IS NULL
                 AND julianday('now') - julianday(date_collecte) > 1.0) > 0 THEN 'alerte'
        ELSE 'ok'
    END AS statut_classification;
