# VeilleAnalytics — Journal des décisions techniques

Ce document trace les écarts entre le document de conception initiale et les choix réalisés lors de l'implémentation.

---

## D01 — Modèle Mistral : mistral-small → open-mistral-nemo

**Date** : Avril 2026
**Contexte** : le modèle `mistral-small-latest` prévu dans la conception retourne systématiquement des erreurs 429 (rate limit) sur le free tier.
**Décision** : basculer sur `open-mistral-nemo`, un modèle plus léger et moins sollicité sur le free tier.
**Conséquence** : le prompt a dû être raccourci pour éviter les timeouts. La qualité de classification reste acceptable (thèmes cohérents, scores mieux distribués qu'avant).
**Alternative envisagée** : attendre la réinitialisation du quota mistral-small. Rejeté car pas fiable pour un pipeline régulier.

---

## D02 — Prompt Mistral : version allégée

**Date** : Avril 2026
**Contexte** : le prompt détaillé (~800 mots) avec exemples pour chaque score provoquait des timeouts sur open-mistral-nemo.
**Décision** : réduire le prompt à l'essentiel (~200 mots) : format JSON attendu, règles de catégorie, échelle de score avec répartition cible, liste des thèmes.
**Conséquence** : perte de quelques nuances (les exemples concrets par niveau de score). Mais les résultats restent exploitables et le pipeline ne timeout plus.
**Suivi** : si mistral-small redevient accessible, on pourra réintégrer le prompt long.

---

## D03 — Suppression de R2 (stockage objet)

**Date** : Mars 2026 (lors de la simplification du projet)
**Contexte** : la conception initiale prévoyait Cloudflare R2 pour archiver les articles bruts en JSON.
**Décision** : ne pas utiliser R2. Les articles sont stockés dans D1 et le fichier JSON local de Node-RED sert de backup.
**Raison** : complexité inutile pour le volume actuel. R2 n'apportait rien de plus qu'une couche de stockage redondante.
**Impact compétences** : aucun. R2 ne couvrait pas de compétence spécifique qui ne soit pas déjà couverte par D1 et les Workers.

---

## D04 — Worker unique au lieu de deux

**Date** : Mars 2026
**Contexte** : la conception prévoyait un Worker ETL + un Worker API Gateway séparés.
**Décision** : un seul Worker qui gère l'ingestion (`POST /api/ingest`) et l'exposition des données (endpoints `GET` à venir en phase 2).
**Raison** : pour le volume du projet (~500-600 articles), un Worker unique est suffisant et plus simple à maintenir et déployer.

---

## D05 — Schéma D1 simplifié

**Date** : Mars-Avril 2026
**Contexte** : la conception prévoyait un schéma en étoile avec tables de dimension séparées pour les sources, les tags (many-to-many) et les catégories.
**Décision** : schéma simplifié avec une table `articles` principale (tags et thèmes en JSON), une table `dim_date` et une table `agg_quotidien`. Pas de table de dimension pour les sources ni de table de liaison pour les tags.
**Raison** : pour ~500-600 articles, un schéma normalisé complet est sur-ingéniéré. Les requêtes restent performantes avec des champs JSON sur ce volume. Le schéma reste un schéma en étoile (fait + dimensions), ce qui couvre la compétence C27.

---

## D06 — Sources RSS réduites à 10

**Date** : Avril 2026
**Contexte** : la conception listait 16 sources dont plusieurs sans feed RSS exploitable (Medium générique, Architect Elevator, ThoughtWorks Radar, ISO, Google blogs).
**Décision** : conserver 10 sources fiables et testées. Retirer les sources hors-sujet (JSLegendDev, GameDev.net) et celles sans feed fonctionnel.
**Sources conservées** : dev.to, Martin Fowler, InfoQ Architecture, OCTO Blog, AWS Architecture, CNCF Blog, Troy Hunt, OWASP, GitHub Blog, StackOverflow Blog.
**Suivi** : d'autres sources pourront être ajoutées progressivement (newsletters Substack, blogs Medium spécifiques).

---

## D07 — Déclenchement manuel au lieu de Cron

**Date** : Avril 2026
**Contexte** : la conception envisageait un Cron Node-RED. Mais la machine locale n'est pas allumée en permanence.
**Décision** : utiliser un nœud inject manuel. Le pipeline est lancé quand la machine est allumée.
**Conséquence** : la collecte reste intermittente, mais c'est un axe d'amélioration mesurable dans le PDCA (régularité avant/après).
**Suivi** : une automatisation via Cron Trigger Cloudflare pourrait être envisagée si les sources RSS sont appelées directement depuis le Worker (suppression de la dépendance à Node-RED). Hors scope pour l'instant.

---

## D08 — Rate limiter Mistral : 15 secondes

**Date** : Avril 2026
**Contexte** : les appels à open-mistral-nemo échouent avec un rate limiter à 2-5 secondes.
**Décision** : rate limiter à 15 secondes entre chaque appel API.
**Conséquence** : le traitement de 50 articles prend ~12 minutes. Acceptable pour un lancement manuel.

---

## D09 — Normalisation des dates à l'ingestion (ISO 8601)

**Date** : Juin 2026
**Contexte** : les flux RSS fournissent la date de publication au format RFC 822 (`Wed, 28 Jan 2026 15:00:00 +0000`), stockée telle quelle dans `date_article`. SQLite ne sait pas interpréter ce format et attend de l'ISO 8601. Les agrégats temporel retournait donc `NULL`.
**Décision** : normaliser la date en ISO 8601 à la source, dans le Worker d'ingestion (`handleDigest`), avant insertion.
**Raison** : corriger la cause plutôt que la contourner à chaque lecture. Une conversion côté lecture aurait dû être répétée dans chaque endpoint et aurait empêché l'usage des fonctions SQL natives.
**Conséquence** : les nouvelles ingestions arrivent en ISO. Le stock historique (392 articles) a été normalisé en une opération ponctuelle.
**Alternative envisagée** : grouper la timeline sur `date_collecte` (déjà en ISO). Rejeté car cette colonne mesure la date de collecte, pas la date de publication, moins adapté à une veille.

---

## D10 — Dashboard consolidé sur Cloudflare (au lieu de Vercel)

**Date** : Juillet 2026
**Contexte** : le dashboard Nuxt devait ajouter une authentification (accès protégé, un seul compte admin) avant sa mise en ligne. La conception initiale prévoyait un hébergement sur Vercel. Or l'auth a besoin d'une base pour les comptes/sessions, et réutiliser la D1 existante depuis Vercel n'est pas praticable : D1 n'est accessible directement que depuis un runtime Cloudflare (binding), pas via une connexion SQL classique.
**Décision** : héberger le dashboard sur **Cloudflare Pages** (au lieu de Vercel) et gérer l'authentification avec **Better Auth** (package cœur, monté dans une route Nitro attrape-tout) sur une **D1 dédiée à l'auth**, distincte de la base `veille-analytics` mais sur le même compte Cloudflare. Adaptateur **Kysely + `kysely-d1`**.
**Raison** : consolider toute l'infra sur Cloudflare (Worker + D1 + Pages) donne une architecture cohérente et entièrement descriptible en Terraform (Étape 11). Le binding D1 natif supprime le besoin d'une API REST ou d'un service tiers (Turso). Une D1 dédiée évite des migrations croisées entre les deux repos (ownership de schéma clair).
**Conséquence** : la Partie Déploiement du plan passe de Vercel à Pages ; le pipeline CI/CD s'appuie sur l'auto-deploy Git natif de Pages (GitHub Actions se limite au lint/tests pour le dashboard). Le Worker reste l'API de données (le dashboard continue de proxifier `/api` vers lui) ; le KV `AUTH` du Worker (token d'ingestion) est indépendant de l'auth des utilisateurs du dashboard.
**Alternative envisagée** : rester sur Vercel + base **Turso** (libSQL, SQLite en HTTP). Écarté au profit de la cohérence « tout Cloudflare » et du narratif IaC, malgré un coût de migration (~1 j) supérieur à Turso.

---

## D11 — Agrégat décisionnel maintenu à l'écriture, et réellement lu

**Date** : Juillet 2026
**Contexte** : `dim_date` et `agg_quotidien` existaient depuis `0001_init.sql` (Étape 2) mais **n'ont jamais été alimentées ni lues** — vérifié en production : 0 ligne dans chacune, et aucune occurrence dans `src/`, `scripts/`, `spark/` ni dans le dashboard. Toutes les agrégations étaient recalculées à la volée sur la table de faits. La revendication de la compétence C27 (entrepôt décisionnel), portée par l'ADR D05, reposait donc sur un schéma en étoile purement déclaratif, qu'un jury pouvait invalider en ouvrant la base.
**Décision** : maintenir l'agrégat **à l'écriture**, de façon **synchrone**, à chaque ingestion (`refreshAggregatesForDay`, un seul `db.batch()`), et faire lire cet agrégat par `GET /api/stats/timeline` au lieu du `GROUP BY` à la volée. Trois choix de conception l'accompagnent :
- **Recalcul intégral du jour concerné** plutôt qu'incrément des compteurs : l'opération devient idempotente, donc rejouable sans dérive, et `score_moyen` étant une moyenne on ne pourrait pas l'incrémenter sans stocker le dénominateur.
- **Ligne de rollup** par jour (`thematique IS NULL`) portant le total, calculée **sans** la jointure `json_each`. Sommer les lignes par thème double-compterait les articles multi-thèmes et oublierait les articles sans thème (2 en production).
- **Synchrone plutôt qu'en `waitUntil`** (contrairement à la classification ML) : l'endpoint lit l'agrégat, il doit donc être exact dès le retour de l'ingestion. Un échec est capturé séparément et ne fait jamais échouer l'ingestion, filet de sécurité assuré par `scripts/rebuild-aggregates.sql`, rejouable.
**Conséquence** : 135 lignes dans `dim_date`, 718 dans `agg_quotidien` (583 par thème + 135 rollups). Contrôle croisé en production : **0 divergence** entre l'agrégat et le calcul à la volée, jour par jour — même esprit de validation par deux implémentations indépendantes que le contrôle Spark/SQL de l'Étape 16. Le contrat de `GET /api/stats/timeline` (`{ jour, count }`) est inchangé, le test d'intégration existant sert de non-régression.
**Alternative envisagée** : garder le calcul à la volée et n'ajouter qu'un script de rafraîchissement manuel. Rejeté : l'agrégat se serait périmé dès l'ingestion suivante, et un agrégat que personne ne lit ne démontre rien de plus qu'aujourd'hui.
**Limite assumée** : l'agrégat porte sur `themes_mistral`, disponible dès l'insertion, et non sur `themes_ml` posé en asynchrone. Il inclut les 3 libellés hors référentiel connus, par cohérence avec `GET /api/stats/themes` qui ne les filtre pas non plus.

## D12 — Seuils de santé calibrés sur l'objectif, pas sur la dérive constatée

**Date** : Juillet 2026
**Contexte** : le pipeline échouait en silence. Un échec de classification ML laisse `themes_ml` à `NULL` et se contente d'un `console.error` que personne ne lit ; une collecte interrompue ne signale rien du tout. L'arrêt de collecte de **67 jours** de mai 2026 n'a été découvert qu'en établissant la baseline P2, deux mois après les faits. C33 (surveillance des systèmes automatisés) était classée *Partielle* pour cette seule raison.
**Décision** : exposer `GET /api/stats/health` (fraîcheur de la collecte + état de la classification), avec des seuils de fraîcheur ancrés sur **le meilleur régime que le projet a réellement tenu**, et non sur son régime courant : `ok` ≤ 3 jours, `degrade` 4 à 14 jours, `alerte` au-delà. La borne de 3 jours vient de la médiane observée sur l'ère D1 (3,5 j) et de l'intervalle moyen de l'ère Node-RED (3,7 j) ; celle de 14 jours encadre la moyenne actuelle (12,5 j), déjà dégradée. Ces trois chiffres sont produits par `scripts/kpi-baseline.sql` et consignés dans `m3/04-baseline-kpi.md` — la médiane n'y a été ajoutée qu'après coup, lors d'une revue qui a constaté qu'elle était citée ici sans être calculée nulle part.
Trois choix l'accompagnent :
- **Le SQL compte, le TypeScript juge** (`src/lib/health.ts`), comme pour `mlComparison`. Les seuils sont ainsi testables sans D1, et le seuil des 24 h du volet ML est calculé en TS puis passé en paramètre à la requête plutôt qu'écrit en `julianday`, ce qui laisse `ML_RETARD_HEURES` seule source de vérité.
- **Seuil ML binaire** : un seul article dont `themes_ml` est resté `NULL` plus de 24 h suffit à déclencher l'alerte. La classification part en `waitUntil` et dure quelques secondes ; passé une journée, le retry borné est épuisé depuis longtemps et il n'y a plus d'ambiguïté à graduer.
- **Compteurs exposés mais neutres** : `ml_sans_theme` (72 en production) et `mistral_manquants` (2) sont affichés sans jamais alimenter un statut. Le premier est la distinction `NULL ≠ []` du modèle de données — un article classifié dont aucun thème n'atteint le seuil de 0,7 n'est pas un échec ; le second est un résidu figé de la migration initiale. Les faire alerter rendrait l'indicateur définitivement rouge pour des raisons qui n'ont rien à voir avec la santé du pipeline.
**Conséquence** : simulation des seuils sur l'historique réel de l'ère D1 (100 jours, 8 écarts) — **23 jours `ok`, 25 `degrade`, 52 `alerte`**. Les 52 jours d'alerte proviennent **intégralement du seul écart de 67 jours** : tous les autres écarts (≤ 12 j) restent sous la borne. L'indicateur discrimine donc réellement au lieu de hurler en permanence, tout en refusant de blanchir l'interruption de mai.
**Alternative envisagée** : calibrer les seuils sur la distribution observée (moyenne 12,5 j), ce qui aurait donné un voyant vert la plupart du temps. Rejeté — c'est la définition même de la normalisation de la déviance : l'alarme aurait été réglée sur la panne. Un tableau de bord vert par construction ne démontre aucune surveillance.
**Limite assumée** : l'endpoint détecte, il n'historise pas. Faute de table de log, les échecs *passés puis rattrapés* (le backfill du 2026-07-18, 503/503) restent invisibles ; `ml_en_retard` vaut 0 en production et l'indicateur ML est donc un détecteur de régression pour l'avenir, pas un constat présent. Ajouter cette table supposerait une migration prod et une écriture sur le chemin d'ingestion — hors périmètre, à énoncer plutôt qu'à laisser croire couvert.

**Trois limites relevées après coup**, par une revue de code passée sur le merge de P3. Aucune n'invalide le dispositif ; les consigner ici plutôt que les corriger est, pour les deux dernières, le même arbitrage coût/bénéfice que ci-dessus.

- **Le repère de fraîcheur est le dernier article collecté, pas la dernière passe de collecte.** `MAX(date_collecte)` date l'insertion la plus récente ; une passe qui ne ramènerait que des doublons n'écrit rien (`INSERT OR IGNORE`) et laisserait l'indicateur vieillir jusqu'à `alerte` alors que la collecte tourne. Le cas n'est pas théorique : à 9 passes sur 100 jours et une trentaine d'articles par passe (chiffres de la baseline P2), quelques jours de flux silencieux suffisent. Le champ exposé a donc été **renommé `dernier_article_collecte`** — le nom précédent, `derniere_ingestion`, affirmait ce que la mesure ne prouve pas. Détecter une collecte qui tourne à vide demanderait de journaliser les passes, donc une table et une écriture sur le chemin d'ingestion : le même refus que pour les prédictions ML, tranché dans le même sens par cohérence.
- **Aucun acquittement d'un article définitivement non classifiable.** Le raisonnement qui neutralise `ml_sans_theme` et `mistral_manquants` — ne pas rendre l'indicateur définitivement rouge — ne leur est pas appliqué symétriquement : un seul contenu que Hugging Face refuserait durablement épinglerait `ml_en_retard`, et donc le statut, sans recours. Le cas ne se manifeste pas aujourd'hui (0 en production). Deux issues bon marché ont été écartées : borner la fenêtre de retard masquerait de vrais échecs, et poser une valeur sentinelle dans `themes_ml` mentirait sur la donnée. Une limite énoncée d'avance vaut mieux qu'un voyant rouge inexpliqué le jour de la démonstration.
- **L'endpoint et `scripts/health-check.sql` ne comptent pas de la même façon** : le TypeScript compare des chaînes ISO (`date_collecte < ?1`), le SQL fait de l'arithmétique `julianday`. Les deux ne coïncident qu'à la condition que tous les `date_collecte` aient exactement la forme d'un `toISOString()`, ce que les lignes migrées depuis `analyzedAt` (`scripts/migrate.js:21`) ne garantissaient pas a priori. Condition **mesurée** plutôt que supposée, avant toute correction : **0 écart sur 529 articles** en production le 2026-07-20 — aucune date nulle, aucune non analysable, aucune dont l'aller-retour `strftime('%Y-%m-%dT%H:%M:%fZ')` diffère. La normalisation ISO de l'ADR D09 avait donc assaini l'historique migré aussi. La correction s'est réduite à documenter la condition dans les deux fichiers, aucun code n'a bougé. Même dénouement qu'en P1, où le piège redouté sur les dates n'existait pas non plus : le réflexe utile n'est pas de coder défensivement, c'est de mesurer d'abord.

## D13 — Indexer d'après la mesure, et rendre les prédicats indexables d'abord

**Date** : Juillet 2026
**Contexte** : la base n'avait aucun index en dehors des contraintes implicites du schéma (`id`, `url UNIQUE`, `date_complete UNIQUE`), et personne n'avait jamais ouvert l'analytique que Cloudflare collecte pourtant depuis le premier jour. `wrangler d1 insights` sur sept jours a montré que tous les chemins chauds balayaient la table entière, y compris le chemin d'**écriture** : l'`INSERT` de la ligne de rollup, exécuté à chaque ingestion, avait tourné 16 fois en lisant 541 lignes à chaque passage pour en écrire 2 — une `queryEfficiency` de 0. Le coût n'était donc pas dans la latence ressentie, invisible à ce volume, mais dans un travail proportionnel au corpus payé à chaque article inséré.
**Décision** : deux changements, dans cet ordre, et rien de plus.
- **Rendre le prédicat indexable avant d'indexer.** La sélection d'un jour s'écrivait `strftime('%Y-%m-%d', date_article) = ?`. Une fonction appliquée à la colonne filtrée rend le prédicat non sargable : aucun index sur `date_article` ne peut alors servir au filtrage. Elle est remplacée par un encadrement `date_article >= ? AND date_article < ?`, dont les deux bornes sont calculées en TypeScript (`bornesDuJour`) et passées en paramètres — même répartition que `seuilRetardMl` dans D12, « le SQL compte, le TypeScript juge ».
- **Quatre index, chacun justifié par une requête et retenu seulement après vérification qu'il change le plan** (`EXPLAIN QUERY PLAN` : `SCAN` → `SEARCH`) : `articles(date_article DESC, date_collecte DESC)` sert à la fois l'encadrement du jour et le tri de `GET /api/articles` ; `agg_quotidien(date, thematique)` sert le `DELETE` du rafraîchissement ; `agg_quotidien(thematique, date)` sert la timeline, que le précédent ne pouvait pas servir faute d'avoir `thematique` en tête ; `articles(source)` sert le regroupement de `GET /api/stats/sources`.

**Conséquence** — lignes lues en production, 542 articles, jour de mesure figé au plus chargé de la base :

| Requête | Avant | Après |
|---|---|---|
| Agrégat du jour, lignes par thème (écriture) | 616 | 92 |
| Agrégat du jour, ligne de rollup (écriture) | 542 | 18 |
| `GET /api/articles`, première page | 1 084 | 20 |
| `GET /api/stats/timeline` | 862 | 137 |
| `GET /api/stats/sources` | 1 097 | 555 |
| `GET /api/stats/themes` *(témoin)* | 3 118 | 3 118 |
| `GET /api/stats/ml-comparison` *(témoin)* | 542 | 542 |

Le chemin d'écriture passe de 1 158 à 110 lignes lues par ingestion. Les deux témoins ne bougent pas, et c'est voulu : ils lisent tout le corpus par conception — la concordance ML se calcule sur l'ensemble des articles, et le comptage par thème doit développer chaque tableau `themes_mistral` avec `json_each`. Un avant/après où tout s'améliore serait un avant/après mal choisi.

**Ce que la mesure a démenti** : l'index seul n'aurait rien réglé sur le chemin d'écriture. Une fois `idx_articles_date_article` créé, l'ancienne requête `strftime` passe en `SCAN articles USING COVERING INDEX` — le plan *mentionne* l'index, ce qui pourrait faire croire à un gain — mais lit toujours **542 lignes**. Elle parcourt l'index au lieu de la table sans jamais s'en servir pour filtrer. `SCAN … USING INDEX` et `SEARCH … USING INDEX` sont deux choses différentes, et seule la seconde restreint le nombre de lignes lues. C'est la réécriture du prédicat qui fait le gain, l'index n'en est que la condition.

**Alternative envisagée** : un index d'expression sur `strftime('%Y-%m-%d', date_article)`, qui aurait évité de toucher au SQL. Rejeté — SQLite n'admet dans un index que des expressions déterministes, et ses fonctions de date ne le sont pas au sens du moteur. Réécrire le prédicat était de toute façon préférable : cela supprime un appel de fonction par ligne en plus de rendre l'index utilisable.

**Prérequis mesuré, pas supposé** : l'encadrement lexicographique n'équivaut à une comparaison de dates que si tout `date_article` est un ISO 8601 **UTC canonique**. Vérifié en production avant d'écrire une ligne de code — sur 542 articles, 0 valeur nulle, 0 non analysable par `strftime`, 0 hors du préfixe `AAAA-MM-JJ`. La normalisation de l'ADR D09 avait fait son travail.

**Correction post-revue : cette première vérification ne prouvait pas ce qu'on lui faisait dire.** Aucun de ses trois compteurs n'écarte un horodatage à décalage horaire, qui passe le contrôle de préfixe *et* `strftime` — or c'est précisément le cas où les deux implémentations divergent : `2026-06-30T00:30:00+02:00` vaut 2026-06-29T22:30Z, donc `strftime` le classe au 29 et l'encadrement au 30. La mesure était juste, mais elle portait à côté. Le contrôle qui teste la bonne propriété est un aller-retour — `strftime('%Y-%m-%dT%H:%M:%fZ', date_article) IS NOT date_article` — plus strict, donc incapable de manquer le cas nuisible : **0 sur 542** en production. Il est désormais versionné et rejouable (`scripts/check-contrat-dates.sql`), et sa capacité à détecter réellement un décalage horaire est elle-même couverte par un test, faute de quoi il pourrait renvoyer 0 pour de mauvaises raisons.

Même dénouement que les trois fois précédentes (P1, P2, clôture des dettes de P3) : le chiffre était bon, la conclusion tenait — mais un chiffre exact et un chiffre qui prouve l'affirmation qu'il accompagne sont deux choses différentes.

**Limites assumées** :
- **Le volume rend `duration` inexploitable.** À 542 articles, la latence est dominée par le réseau et la variance du serveur : les durées relevées (0,2 à 3,5 ms) se recouvrent d'une exécution à l'autre, y compris entre l'avant et l'après. Seul `rows_read` est retenu comme indicateur — déterministe, reproductible, et accessoirement l'unité de facturation de D1. Conclure sur les millisecondes à cette échelle serait de la sur-interprétation.
- **Le coût d'écriture des index n'a pas été mesuré.** Quatre index se maintiennent à chaque `INSERT` ; la création en a écrit 2 540 entrées. À une trentaine d'articles par passe le surcoût est négligeable devant le balayage supprimé, mais c'est un raisonnement, pas une mesure.
- **`GET /api/stats/themes` reste le chemin le plus lourd** (3 118 lignes lues, `queryEfficiency` 0,003). Le développement de `json_each` interdit tout index. Le levier serait de le servir depuis `agg_quotidien`, déjà alimenté par thème et par jour — c'est-à-dire d'étendre à cet endpoint ce que D11 a fait pour la timeline. Identifié, non fait.
- **La rétention de l'analytique Cloudflare est bornée** sur le plan gratuit : `wrangler d1 insights` regarde en arrière sur une fenêtre courte. Les sorties brutes sont donc versionnées dans `data/perf/` plutôt que régénérables à volonté — contrairement aux mesures `rows_read`, que `scripts/perf-measure.mjs` rejoue à tout moment.
