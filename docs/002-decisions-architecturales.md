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

---

## D14 — Trois couches d'analyse de sécurité en CI, et ce qu'elles ne couvrent pas

**Date** : Juillet 2026
**Contexte** : la sécurité du projet reposait sur des gestes ponctuels et corrects — secrets hors dépôt, configuration serveur non exposée au client, XSS corrigée, `rel="noopener noreferrer"` — mais sur aucun dispositif. Les deux pipelines vérifiaient les types, le style et les tests ; rien ne regardait les dépendances, l'historique git ni l'application déployée. Une hygiène sans outillage tient à la vigilance d'une personne, et ne survit pas à un mois d'interruption.
**Décision** : trois couches qui ne cherchent pas la même chose, plutôt qu'un scanner généraliste de plus.
- **`pnpm audit --audit-level=high`**, dans un job `security` distinct de `quality`, sur les deux dépôts. Compare l'arbre de dépendances **installé** à la base d'avis publics. Seuil `high` : un seuil plus bas rendrait le pipeline rouge en permanence pour des avis portant sur de l'outillage de développement, et un pipeline qu'on apprend à ignorer ne protège plus rien.
- **`gitleaks` sur l'historique complet** (`fetch-depth: 0`). Un secret retiré par un commit ultérieur reste lisible dans les objets git : ne regarder que le dernier commit donnerait une réponse rassurante et fausse.
- **OWASP ZAP en mode baseline** contre le dashboard déployé, dans un workflow séparé, déclenchable à la main et planifié le lundi. Séparé parce que sa cible est la **production**, pas le code de la branche : scanner à chaque commit mesurerait l'état d'une application qui n'a pas encore reçu ce commit. Baseline, donc exploration et analyse **passive** — aucune charge offensive, ce qui le rend acceptable contre une production.

Le job `security` **ne bloque pas le déploiement** : `deploy` ne dépend que de `quality`. Un avis publié sur une dépendance de développement ne doit pas empêcher de livrer un correctif. Il rend le pipeline rouge, ce qui suffit à forcer le traitement.

**Conséquence immédiate, et démenti du pronostic** : la mise en place devait, selon le plan, ne rien trouver — deux projets jeunes, peu de dépendances directes. Le premier passage a remonté **18 avis** : 10 sur `veille-analytics` (4 *high*, tous sous `wrangler` → `miniflare` : `undici`, `ws`, `esbuild`) et 8 sur `veille-dashboard` dont un **critique** (`tar`, dans la chaîne de construction de `nitropack`). Aucun n'était embarqué dans le code servi — tous relevaient de l'outillage de compilation — mais l'écart entre le pronostic et la mesure est le résultat le plus utile de l'opération : l'intuition sur l'état de sécurité d'un projet ne vaut pas son inventaire.

Traitement : montée de `wrangler` 4.78 → 4.112 côté Worker, qui solde les dix d'un coup ; `pnpm.overrides` versionnés côté dashboard, où les paquets fautifs sont trop profonds pour être atteints autrement. **Piège rencontré** : une clé d'override de la forme `paquet@plage` se compare à la plage **déclarée** par le parent, pas à la version **résolue**. `brace-expansion@>=3.0.0 <5.0.7` ne s'appliquait donc pas à un parent déclarant `^5.0.0`, et l'audit restait rouge malgré un override en apparence correct ; il a fallu la forme `minimatch>brace-expansion`.

**Ce que ces trois couches ne couvrent pas**, et qui doit être dit avant de lire leurs rapports :
- **Aucune ne juge une autorisation.** Le constat le plus grave de cette campagne — des routes de lecture ouvertes à tous, cf. D15 — a été trouvé en lisant le routeur, pas par un outil. Pour ZAP, un endpoint qui répond 200 à tout le monde est un endpoint qui fonctionne.
- **ZAP ne voit que la surface publique.** Le dashboard exigeant une session, l'exploration s'arrête à la page de connexion et aux assets.
- **`pnpm audit` ne prouve pas une absence.** Il compare à des avis *publiés* ; une vulnérabilité non encore déclarée n'y figure pas. Un audit vert dit « rien de connu », jamais « rien ».

**Écarté** : **CodeQL**, pourtant gratuit sur dépôt public — l'analyse statique recoupe largement ce que le typage strict et ESLint attrapent déjà sur ce code, et ajouter une quatrième source d'alertes avant d'avoir traité celles des trois premières produirait du bruit, pas de la sécurité. À reconsidérer une fois le rituel installé. **Burp Suite**, cité par le référentiel, est un outil d'analyse manuelle assistée : il n'a pas sa place dans une CI. **Le scan actif** de ZAP, qui injecte réellement des charges : refusé contre une production, et il n'existe pas d'environnement de recette où le pratiquer.

---

## D15 — Réserver les routes de lecture au dashboard, et non à l'obscurité de l'URL

**Date** : Juillet 2026
**Contexte** : la protection des données reposait entièrement sur `proxyToWorker`, côté dashboard, qui vérifie la session avant de relayer au Worker. Le raisonnement était juste et le code aussi — mais il supposait que l'on passe par le dashboard. Or le Worker répond sur sa propre URL publique, laquelle est versionnée en clair dans le `wrangler.toml` d'un dépôt public. Mesuré le 2026-07-21 : un `curl` sur `GET /api/articles`, sans en-tête d'aucune sorte, renvoyait **16 522 octets** d'articles. C'est la leçon de l'Étape 15 — « protéger l'UI ne suffit pas, il faut protéger la donnée » — qui n'avait été appliquée qu'à un seul étage.
**Décision** : le Worker exige un jeton partagé, `X-Dashboard-Token`, sur ses routes de lecture ; le proxy du dashboard est le seul à l'émettre.
- **Whitelist de chemins protégés, pas blacklist.** Une route absente de la liste est donc publique par défaut. Le choix est contre-intuitif et assumé : la liste inverse ferait passer pour protégée une route qu'on aurait simplement oublié d'y inscrire, c'est-à-dire qu'elle transformerait un oubli en fausse sécurité. Ici, l'oubli se voit.
- **Jeton distinct de celui d'ingestion**, dans le même KV. Ingérer et lire ne sont pas le même droit et n'ont pas le même porteur ; les confondre reviendrait à donner l'écriture à qui ne demandait que la lecture.
- **Un jeton absent du KV refuse tout.** La comparaison n'est pas gardée par un « si un jeton est configuré » : une erreur de configuration doit fermer, pas ouvrir. C'est testé.
- **Deux exceptions volontaires et testées** : `GET /api/stats/health`, appelé hors session par la supervision et qui ne rend aucune donnée d'article, et la route de repli. Les tester empêche de les fermer par inadvertance en élargissant la liste — et de découvrir la panne par un indicateur devenu muet.

**Ordre de déploiement, qui fait partie de la décision** : le dashboard d'abord, le Worker ensuite. Émettre un en-tête que personne n'exige encore est sans effet ; l'exiger avant que quiconque l'émette coupe la production. C'est le même réflexe que la désactivation du pipeline pendant une migration.

**Conséquence** : la même requête renvoie désormais **401 et 13 octets**. L'indicateur de santé reste joignable, la production sert toujours ses 542 articles au dashboard authentifié.

**Écarté** : **`workers_dev = false`**, qui supprimerait purement l'URL publique et serait la protection la plus forte, sans une ligne de code. Refusé pour deux raisons concrètes : la supervision HTTP de `/api/stats/health` deviendrait impossible depuis l'extérieur, et le développement local du dashboard, qui appelle le Worker par son URL faute de service binding hors production, cesserait de fonctionner. La protection la plus forte n'est pas la bonne si elle supprime le moyen de vérifier que le système va bien.

**Limites assumées** : un jeton partagé authentifie un **appelant**, pas un **utilisateur**. Il ferme la porte ouverte, il ne remplace pas une autorisation par utilisateur — laquelle n'a pas d'objet ici, où toute session voit le même corpus. Par ailleurs le jeton vit dans le KV et dans un secret du dashboard : sa rotation est manuelle et non couverte par une procédure automatisée.

## D16 — Un script shell pour orchestrer le batch, pas un `.mjs` de plus

**Date** : Juillet 2026
**Contexte** : le pipeline du batch PySpark (Étape 16) était trois commandes lancées à la main dans l'ordre — export D1 `--remote` vers JSON, conversion JSON → CSV, puis `spark-submit` dans son venv (`spark/README.md`). Rien n'imposait l'ordre ni ne vérifiait les prérequis : oublier d'activer le venv fait échouer `spark-submit` sur une erreur `SPARK_HOME` illisible, et lancer l'export sans `CLOUDFLARE_API_TOKEN` échoue plus loin, après avoir déjà écrit un fichier. Tout l'outillage du dépôt était par ailleurs en `.mjs` (Node) ou `.py` : aucun script shell, alors que l'enchaînement est précisément un travail d'orchestration de commandes Unix.
**Décision** : câbler ces trois étapes dans `scripts/run-spark-batch.sh` (`pnpm spark:batch`), et le faire en Bash plutôt qu'en Node.
- **Bash parce que la tâche est de l'orchestration de processus**, pas de la logique métier : redirection `>` de l'export, activation d'un venv dans un sous-shell, chaînage conditionnel, propagation des codes de sortie. `set -euo pipefail` fait de « une étape échoue → on s'arrête » le comportement par défaut, sans code de vérification à chaque appel. Réécrire ça en Node rajouterait une couche `child_process` autour de commandes qui sont déjà des commandes shell.
- **Préflight qui échoue avant toute écriture** : présence de `node`/`npx`, du venv (`spark/.venv/bin/activate`), et — en mode export — d'un `CLOUDFLARE_API_TOKEN` non vide. Une erreur de configuration doit s'arrêter avant de produire un fichier à moitié bon, pas après.
- **Un flag `--skip-export`** pour rejouer conversion + Spark sur le JSON déjà exporté, hors-ligne et sans token : le développement du batch (schéma, analyses) n'a aucune raison de repayer un appel D1 `--remote` à chaque itération.
- **`.gitattributes` (`*.sh text eol=lf`)** ajouté dans le même geste. Le dépôt est cloné sous Windows (rédaction) et sous WSL/Linux (exécution) ; sans règle, un checkout Windows réécrit le script en CRLF et le shebang casse côté WSL. Le script est inutile s'il ne survit pas au double checkout.

**Conséquence** : couvre la compétence C23 (« commandes Unix et scripts Bash »), que l'écosystème `.mjs`/`.py` laissait sans preuve, et rend le pipeline du batch rejouable d'une commande. Le script est vérifié en syntaxe (`bash -n`) et en fins de ligne côté Windows ; le run complet suppose l'environnement Spark (Java 17 + venv), présent sur le poste d'exécution.

**Écarté** : **un `run-batch.mjs`** qui envelopperait les mêmes commandes. Techniquement possible, mais il faudrait recréer en Node ce que le shell fait nativement (redirection, activation de venv, propagation d'échec), et cela ne démontrerait pas la compétence visée. La règle du dépôt reste : `.mjs` quand il y a une transformation de données (comme `export-spark-csv.mjs`), shell quand il n'y a qu'un enchaînement de commandes.

**Limite assumée** : le script est écrit et vérifié en syntaxe sur le poste Windows, mais son exécution de bout en bout n'a lieu que là où vivent Java 17 et le venv Spark. La CI ne l'exécute pas (le batch est un outil d'analyse local, pas un artefact déployé).

## D17 — SonarCloud dans la CI comme quality gate persistante

**Date** : Juillet 2026
**Contexte** : la qualité du code reposait sur ESLint et `tsc --noEmit` (job `quality` de la CI). C'est un filet nécessaire mais local et sans mémoire : il dit si le code compile et respecte les règles de lint à l'instant du push, pas s'il accumule des *code smells*, de la duplication ou des bugs latents, et il ne garde aucune trace dans le temps. La compétence C19 attend un outil d'*analyse de qualité de code* de la classe SonarQube, absent du dispositif.
**Décision** : brancher **SonarCloud** sur les dépôts, en analyse **déclenchée par la CI** (job `sonar` dans `ci.yml`, secret `SONAR_TOKEN`), config versionnée dans `sonar-project.properties`.
- **SonarCloud (SaaS) plutôt que SonarQube Community auto-hébergé.** Les dépôts sont publics, donc SonarCloud est gratuit ; il fournit un **dashboard persistant** et une **quality gate** historisée — exactement la preuve durable qu'un jury peut consulter, là où un SonarQube en conteneur local ne vivrait que le temps d'une démo et demanderait une infra à maintenir. Cohérent avec la contrainte « zéro coût, zéro serveur à gérer » de tout le projet.
- **Analyse en CI plutôt qu'automatique.** SonarCloud sait scanner tout seul à chaque push, sans rien dans la CI. On a préféré le **job dans le pipeline** pour la même raison que l'analyse de sécurité (ADR D14) : le récit du dossier est « les outils de contrôle vivent dans le pipeline ». Le job `sonar` est **séparé et non bloquant** pour le déploiement (`deploy` ne dépend que de `quality`) — un manquement de qualité rend le pipeline rouge, ce qui suffit à forcer le traitement, sans empêcher de livrer un correctif urgent.
- **Trois dépôts, même patron.** `veille-analytics` (TypeScript) et `veille-dashboard` (Nuxt) sont câblés ici ; `veille-ml` (Python — SonarCloud analyse aussi Python) suit le même modèle, à finaliser sur le poste où ce dépôt est disponible.

**Conséquence** : couvre C19 par un outil de la classe attendue, avec une trace persistante. L'écart avec ESLint/tsc est assumé : les trois sont complémentaires (lint = règles de style, `tsc` = types, Sonar = smells/duplication/bugs sur la durée).

**Limite assumée — la couverture de tests n'est pas remontée.** La suite `veille-analytics` tourne sur `@cloudflare/vitest-pool-workers` (Miniflare/workerd), où la couverture v8 est instable ; `veille-dashboard` n'avait alors aucun test automatisé (il en porte 13 depuis l'ADR D18). Plutôt que publier un taux de couverture faux ou partiel, on l'omet et on le documente. L'analyse Sonar reste pleinement utile sans couverture (elle ne dépend pas d'elle pour les smells, bugs et duplication) ; la ligne `sonar.javascript.lcov.reportPaths` est présente mais commentée, à activer si un `lcov` fiable est produit un jour.

**À câbler manuellement** (hors dépôt) : créer le compte SonarCloud, lier l'organisation GitHub, importer les trois dépôts, générer le `SONAR_TOKEN` et le poser en secret GitHub Actions de chacun. Tant que le secret est absent, le job `sonar` échoue volontairement — il n'a de sens qu'une fois SonarCloud connecté.

---

## D18 — Un contrat recopié à la main dérive en silence : le tester, faute de pouvoir le générer

**Date** : Juillet 2026
**Contexte** : l'ADR D12 renomme `derniere_ingestion` en `dernier_article_collecte`, et le motive : la mesure est un `MAX(date_collecte)`, elle date le dernier article **inséré** et non la dernière passe de collecte. Le Worker a suivi. Le dashboard, non. Son type `PipelineHealth` (`veille-dashboard/shared/types/stats.ts`) porte le contrat de cette route **recopié à la main**, et `sante.vue` lisait donc un champ que le Worker n'émet plus.

Ce qui rend le cas intéressant n'est pas l'oubli, c'est **pourquoi rien ne l'a vu** :

- **TypeScript ne pouvait rien signaler.** Le type est une déclaration sur du JSON non validé : il décrit ce qu'on croit recevoir, pas ce qu'on reçoit. `tsc` a validé une fiction cohérente avec elle-même.
- **L'échec était silencieux par construction.** `formatDate` reçoit `undefined`, son garde `if (!iso)` renvoie `'—'`. Ce garde est correct — il existe pour la base vide — mais il absorbe indistinctement l'absence légitime et le champ inexistant.
- **Toutes les vérifications en place passaient au vert.** La route répond `200`, la page se rend, `jours_depuis` s'affiche juste. Le relevé de production consigné dans les notes de l'Étape 15 (« dashboard 200, y compris `distribution` et `comparaison-ml` ») portait sur le code de réponse, pas sur le contenu. Un contrôle qui ne regarde pas la bonne propriété ne prouve rien — **quatrième occurrence** du même enseignement après P1, P2 et le contrat de dates de D13.

Symptôme réel : sous le compteur de fraîcheur, l'horodatage exact affichait un tiret. Et le libellé de la carte était resté « Dernière ingestion », c'est-à-dire précisément la formulation que D12 déclarait fausse — la correction sémantique n'avait pas franchi la frontière non plus.

**Décision** : corriger, puis poser le filet qui manquait, en admettant ce qu'on ne peut pas faire ici.

- **La bonne réponse est de ne pas recopier le contrat.** Un type dérivé de la source ne peut pas dériver d'elle. C'est exactement ce que fait le générateur C#→TypeScript en entreprise, et l'absence d'un tel générateur ici n'est pas un oubli mais une conséquence du dimensionnement : deux dépôts, un consommateur, une poignée de routes. La génération n'a pas été retenue.
- **À défaut, un test de contrat triangulé** (`veille-dashboard/test/contrat-health.test.ts`), sur trois affirmations qui ne peuvent pas dériver ensemble : une **fixture** capturée du Worker, la **liste des chemins** transcrite du producteur (`src/lib/health.ts`), et une **liaison de type** vers ce que consomment les pages. Modifier une seule des trois fait tomber la vérification ; les modifier toutes les trois est un renommage délibéré, ce qui est le comportement voulu.
- **Le cœur décisionnel du BFF devient testable** (`server/utils/relais.ts`, `preparerRelais`), extrait de `proxyToWorker` qui mêlait h3, Better Auth et décisions. Même répartition qu'ici entre `health.ts` et la requête D1 : les entrées-sorties d'un côté, le jugement de l'autre. Effet de bord recherché : l'affirmation de l'ADR D15 — rien ne part vers le Worker sans session — devient **structurelle** et non plus dépendante de l'ordre des lignes.
- **`pnpm test` enchaîne deux passes** côté dashboard, `tsc -p tsconfig.test.json` puis vitest. `nuxt typecheck` n'inclut pas `test/` : sans cette passe, la liaison de type ne serait jamais compilée. Un garde-fou qu'on ne compile pas n'est pas un garde-fou — vérifié par mutation, remettre l'ancien nom dans le type fait échouer la suite sur deux erreurs.

**Conséquence** : `veille-dashboard` passe de **0 à 13 tests**, exécutés dans le job `quality` de sa CI ; `veille-analytics` de **120 à 140** (comparaison de jetons et désérialisation défensive, ci-dessous). L'ADR D17 est amendé : son constat « `veille-dashboard` n'a pas de tests automatisés » n'est plus vrai.

**Deux durcissements pris dans le même passage**, l'un et l'autre relevés en revue plutôt qu'en production :

- **`parseArticleRow` désérialisait sans garde** trois colonnes TEXT, alors que `parseThemes` (`mlComparison.ts`) gardait déjà le sien — asymétrie fortuite, et c'est le chemin non gardé qui portait le risque : une seule valeur illisible en base faisait tomber **toute** la page `GET /api/articles` en 500, sans indiquer l'article en cause. Rien au niveau du schéma ne contraint le format de ces colonnes, et la base a reçu des écritures directes (migration initiale, `scripts/sql-ponctuels/`). Elle porte d'ailleurs déjà des anomalies qualité assumées. Repli assumé et documenté : une valeur corrompue devient indiscernable d'une absence — imprécision sur une ligne préférée à une page indisponible.
- **Comparaison de jetons en temps constant** (`src/lib/jetons.ts`), sur les deux autorisations. L'exploitation réelle contre un Worker Cloudflare est douteuse, la variance réseau dépassant de plusieurs ordres de grandeur l'écart mesurable. Le correctif est retenu parce qu'il coûte dix lignes et supprime la question : « ce n'est probablement pas exploitable » est un raisonnement à refaire à chaque revue, « la comparaison est en temps constant » se vérifie une fois. **Limite énoncée** : la longueur du jeton attendu reste observable ; la masquer supposerait de hacher avant comparaison, et cette information seule ne réduit pas utilement l'espace de recherche.

**Ce que ces tests ne couvrent toujours pas**, et qui doit être dit : le rendu des pages, les routes Nitro assemblées et la session Better Auth réelle. Monter le runtime Nuxt en test exigerait un build complet à chaque exécution, pour couvrir ce que le scan ZAP et le relevé manuel couvrent déjà. Le découplage de `relais.ts` a été fait précisément pour éviter ce coût — c'est un arbitrage, pas une couverture complète.

**Écarté** : **valider la réponse à l'exécution** (Zod ou équivalent) à la frontière du BFF, ce qui aurait transformé la dérive en erreur explicite plutôt qu'en tiret silencieux. Séduisant, et sans doute la bonne réponse sur un contrat qui bouge souvent. Rejeté ici parce que le schéma serait, lui aussi, **recopié à la main** : on déplacerait la dérive d'un fichier à l'autre en payant une dépendance et une validation par requête. Le test de contrat attrape la même chose, au moment où la faute est commise plutôt qu'en production.

**Limite assumée** : la fixture est un instantané. Si le Worker change son contrat sans que personne ne rejoue la capture, les deux dépôts resteront cohérents *avec la fixture* et faux vis-à-vis de la production. Le test protège contre la dérive **entre les deux dépôts**, pas contre une capture périmée — d'où le commentaire en tête du fichier, qui dit d'où vient la fixture et quand la reprendre. Fermer cette limite supposerait d'appeler le vrai Worker en CI, donc d'y exposer un jeton de lecture et de rendre le pipeline dépendant d'un service tiers.
