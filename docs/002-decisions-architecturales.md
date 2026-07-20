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
