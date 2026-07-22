# Batch PySpark — Étape 16

Batch d'analyse distribuée (compétence **C29** du référentiel, M3.2) exécuté en local sur les
articles déjà classifiés par thème (annotation Mistral, Étape 6, et classifieur ML zero-shot,
Étape 13). Trois analyses : fréquences par thème, cooccurrences de tags, tendances hebdomadaires.

## Prérequis

| Outil          | Version testée              | Note                                              |
| -------------- | ---------------------------- | -------------------------------------------------- |
| Java (JDK)     | OpenJDK **17.0.19** (`openjdk-17-jre-headless`) | Spark 3.5.x nécessite Java 8/11/17 — pas Java 21+ |
| Python         | **3.12.3**                   | Spark 3.5.x supporte Python jusqu'à 3.12 inclus     |
| PySpark        | **3.5.4**                    | Embarque Spark (pas d'installation Spark séparée)   |
| Gestionnaire d'env. | [uv](https://docs.astral.sh/uv/) | Voir piège ci-dessous                          |

La combinaison Spark 3.5.x + Java 17 + Python 3.12 est la plus récente officiellement supportée
au moment de l'Étape 16 (juillet 2026) — Java 21 et Python 3.13 ne sont pas garantis par Spark 3.5.

## Setup

```bash
# Depuis la racine du repo
sudo apt install openjdk-17-jre-headless   # si Java absent
java -version                              # doit afficher 17.x

# Environnement virtuel Python dédié à spark/
uv venv spark/.venv --python 3.12
source spark/.venv/bin/activate
uv pip install -r spark/requirements.txt   # pyspark==3.5.4
```

**Piège rencontré : `python3.12-venv` / `ensurepip` absents du système.** Le module standard
`venv` de Python plante à la création (`ensurepip is not available`) faute du paquet
`python3.12-venv`, indisponible tel quel sur cette install WSL2/Ubuntu. Plutôt que d'installer un
paquet système supplémentaire, on est passé par **uv** (`uv venv`), qui crée l'environnement sans
dépendre d'`ensurepip`. `uv pip install` fonctionne ensuite normalement dans ce venv.

## Pipeline d'exécution

### En une commande (recommandé)

Le script `scripts/run-spark-batch.sh` enchaîne les trois étapes ci-dessous, avec
garde d'environnement (`CLOUDFLARE_API_TOKEN`, venv présent) et arrêt au premier
échec (`set -euo pipefail`). À lancer depuis la **racine du repo** :

```bash
pnpm spark:batch                       # pipeline complet (export D1 inclus)
# ou directement :
bash scripts/run-spark-batch.sh
bash scripts/run-spark-batch.sh --skip-export   # rejoue conversion + Spark sur le JSON déjà exporté (hors-ligne, sans token)
bash scripts/run-spark-batch.sh --help
```

Le venv `spark/.venv` doit exister au préalable (voir *Setup* ci-dessus) ;
`CLOUDFLARE_API_TOKEN` doit être exporté dans l'environnement pour l'étape d'export.
Choix de conception : ADR **D16** dans `docs/002-decisions-architecturales.md`.

### Les trois étapes détaillées

Ce que le script automatise, si on veut les lancer une à une (toujours depuis la
racine du repo) :

```bash
# 1. Export D1 → JSON (colonnes utiles au batch)
npx wrangler d1 execute veille-analytics --remote --json --command \
  "SELECT id, titre, url, source, date_article, themes_mistral, themes_ml, score_confiance_ml, tags FROM articles" \
  > data/articles_spark.json

# 2. Conversion JSON → CSV (format attendu par le batch)
node scripts/export-spark-csv.mjs

# 3. Exécution du batch (nécessite le venv du batch activé, voir piège ci-dessous)
source spark/.venv/bin/activate
spark-submit spark/analyse.py
```

**Piège rencontré : `spark-submit` et `SPARK_HOME`.** Le script `spark-submit` (fourni par le
paquet `pyspark`) résout `SPARK_HOME` en invoquant le `python3` trouvé en premier dans le `PATH`
(via `find_spark_home.py`, qui importe `pyspark` pour localiser son propre répertoire d'install).
Si le venv `spark/.venv` n'est **pas activé**, ce `python3` est celui du système, qui n'a pas
`pyspark` installé — la résolution échoue silencieusement côté `find_spark_home`
(`AttributeError`) et `spark-class` est introuvable (`/bin/spark-class: No such file or
directory`). Il faut donc **impérativement** `source spark/.venv/bin/activate` (ou préfixer le
`PATH` avec `spark/.venv/bin`) avant d'appeler `spark-submit` — même si l'invocation se fait
depuis la racine du repo et non depuis `spark/`.

Les 3 CSV de sortie atterrissent dans `spark/out/` : `freq_themes.csv`, `cooccurrences_tags.csv`,
`tendances_hebdo.csv`.

## Les trois analyses

Code complet dans [`analyse.py`](analyse.py). Entrée commune : `data/articles_spark.csv`, chargé
avec un **schéma explicite** (pas d'`inferSchema`, pour éviter un passage de lecture superflu et
garantir des types stables, ex. `score_confiance_ml` en `DOUBLE`). Les colonnes `themes_mistral`,
`themes_ml` et `tags` restent des chaînes JSON sérialisées (`["IA/ML","Sécurité"]`) et sont
parsées à la demande avec `from_json` dans chaque analyse qui en a besoin.

### 1. Fréquences par thème (`freq_themes`)

Objectif : comparer la distribution des thèmes entre l'annotation Mistral (LLM, Étape 6) et le
classifieur ML zero-shot (Étape 13).

Mécanique : `from_json` (parse le tableau JSON) → `explode` (une ligne par occurrence de thème) →
`groupBy("theme").count()`, une fois par colonne source, puis `union` des deux résultats. Un
drapeau `hors_referentiel` (`~col("theme").isin(THEMES_CANONIQUES)`) signale les labels absents de
la whitelist des 7 thèmes canoniques — sans les faire disparaître silencieusement du décompte.

Colonnes de sortie : `theme, source_annotation, count, hors_referentiel`.

### 2. Cooccurrences de tags (`cooccurrences_tags`)

Objectif : repérer les paires de tags qui apparaissent fréquemment ensemble sur un même article.

Mécanique — démarche distribuée classique de recherche d'associations :
1. `explode` du tableau de tags → relation `(id, tag)`, une ligne par occurrence (`dropDuplicates`
   pour ignorer un tag dupliqué sur un même article) ;
2. **auto-jointure** de cette relation sur `id` : chaque article produit toutes les paires de ses
   tags ;
3. la condition `tag_a < tag_b` (ordre lexicographique) élimine en un coup les auto-paires `(x,
   x)` et les doublons miroir `(x, y)` / `(y, x)` — chaque paire n'est comptée qu'une fois, sous
   une forme canonique ;
4. `groupBy(tag_a, tag_b).count()` → `support`, filtré au seuil minimal (`SUPPORT_MIN = 5`), top
   50 (`TOP_N`).

Le seuil de support 5 est justifié dans le code : 1 187 tags distincts sur 529 articles donnent
une distribution très éparse (la plupart des paires n'apparaissent qu'une fois) ; un seuil de 5
isole les associations réellement structurantes.

Colonnes de sortie : `tag_a, tag_b, support`.

### 3. Tendances hebdomadaires (`tendances_hebdo`)

Objectif : volume d'articles par semaine, lissé pour dégager une tendance.

Mécanique — deux mécaniques Spark distinctes et complémentaires :
- `F.window("jour", "7 days")` : agrégation par *fenêtre temporelle* (tumbling window de 7 jours)
  → volume hebdomadaire brut ;
- `Window.orderBy("semaine").rowsBetween(-3, 0)` + `avg(...).over(...)` : une **window function**
  au sens SQL — pour chaque semaine, moyenne de la semaine courante et des 3 précédentes, sans
  effondrer les lignes (contrairement à un `groupBy`). C'est ce mécanisme, distinct de
  l'agrégation classique, qui sert de démonstration de la compétence C29 sur ce batch.

Cette window function **sans `partitionBy`** rapatrie tout le calcul sur une seule partition —
Spark le signale par un `WARN WindowExec: No Partition Defined for Window operation!`. Assumé ici
(≈44 semaines, volume négligeable) ; sur un plus gros volume on partitionnerait par une clé (ex.
par thème) pour paralléliser.

Colonnes de sortie : `semaine, nb_articles, moyenne_glissante_4s`.

## Écriture des CSV et piège `coalesce(1)`

Spark écrit toujours un **répertoire** contenant un fichier par partition
(`part-00000-....csv`, etc.), jamais un fichier CSV unique directement. `ecrire_csv()` (dans
`analyse.py`) force `coalesce(1)` pour regrouper toutes les données sur une seule partition avant
écriture, produisant un répertoire avec un unique part-file, qu'on déplace ensuite vers le nom de
fichier final attendu (`spark/out/<nom>.csv`), avant de nettoyer le répertoire temporaire.

Acceptable ici vu le volume (529 lignes au total), **mais c'est un anti-pattern à grande échelle** :
`coalesce(1)` supprime le parallélisme d'écriture et risque de saturer la mémoire d'un seul
exécuteur si les données sont volumineuses. À ne pas reproduire tel quel sur un vrai jeu de
données distribué — préférer un répertoire multi-part-files, ou une compaction a posteriori hors
du chemin critique.

## Aperçu des résultats (run du 2026-07-18, 529 articles)

### `freq_themes.csv` (17 lignes)

Mistral : Développement 222, Architecture 222, DevOps/Infrastructure 211, IA/ML 192, Sécurité 156,
Pratiques/Qualité 152, Productivité/Outils 93 — plus 3 labels `hors_referentiel=true` (1 occurrence
chacun) : « Produktivité/Outils » (faute de frappe), « IoT », « Infrastructure ».

```
theme,source_annotation,count,hors_referentiel
Développement,ml,352,false
Développement,mistral,222,false
Architecture,mistral,222,false
DevOps/Infrastructure,mistral,211,false
Sécurité,ml,203,false
IA/ML,mistral,192,false
...
Infrastructure,mistral,1,true
Produktivité/Outils,mistral,1,true
IoT,mistral,1,true
```

**Contrôle croisé réussi** : les fréquences Mistral (colonnes non filtrées) coïncident **exactement**
ligne à ligne avec `GET /api/stats/themes` du Worker en prod (même agrégation `json_each` côté
SQL) — les 3 labels parasites sont exactement ceux détectés par la whitelist `THEMES_CANONIQUES`
via le drapeau `hors_referentiel`, ce qui valide le filtrage des deux côtés (batch Spark et
endpoint Worker).

### `cooccurrences_tags.csv` (30 paires, support ≥ 5)

Top : DevOps↔Kubernetes 16, IA↔bonnes pratiques 14, DevOps↔architecture 12, IA↔architecture 10,
IA↔développement 10, sécurité↔vulnérabilités 10, AWS↔architecture 9.

```
tag_a,tag_b,support
DevOps,Kubernetes,16
IA,bonnes pratiques,14
DevOps,architecture,12
IA,architecture,10
IA,développement,10
sécurité,vulnérabilités,10
AWS,architecture,9
...
```

**Observation qualité de données** : certains tags ont échappé à la normalisation lowercase
(« DevOps », « IA », « AWS » côtoient « devops », « ia », « aws » — voir par exemple les lignes
distinctes `IA,sécurité` et `ia,sécurité` dans le fichier), probablement un héritage de la
migration initiale des données. Sans impact sur le calcul des cooccurrences (les tags sont comptés
tels quels, la mécanique de jointure ne présuppose aucune casse), mais à corriger un jour à la
source.

### `tendances_hebdo.csv` (44 semaines, 2025-08 → 2026-07)

Moyenne glissante 4 semaines autour de ~30 articles/semaine sur la période récente (dernière
semaine du run, partielle : 11 articles).

```
semaine,nb_articles,moyenne_glissante_4s
2025-08-07,2,2.0
2025-08-14,1,1.5
2025-08-21,4,2.33
...
2026-06-25,28,24.0
2026-07-02,39,30.75
2026-07-09,41,29.5
2026-07-16,11,29.75
```

## Voir l'UI Spark

Pendant l'exécution de `spark-submit spark/analyse.py`, l'UI Spark est disponible sur
[http://localhost:4040](http://localhost:4040) (jobs, stages, DAG, plan d'exécution SQL). Le
process Spark tournant en local et se terminant à la fin du script, l'UI n'est accessible que le
temps du run — utile pour visualiser concrètement le shuffle de l'auto-jointure (analyse 2) ou le
`WindowExec` sans partition (analyse 3).
