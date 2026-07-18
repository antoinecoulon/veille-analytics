"""Batch PySpark — Étape 16 (compétence C29).

Objet
-----
Ce batch analyse en local (mode `local[*]`) les articles de veille technologique
déjà classifiés par thème (annotation Mistral + classifieur ML zero-shot, cf.
Étapes 13-15 et `src/lib/classifyMl.ts`). Il produit des statistiques
descriptives destinées à comparer les deux méthodes d'annotation et à repérer
des motifs (fréquences, cooccurrences, tendances temporelles).

Entrée
------
`data/articles_spark.csv` — généré par `scripts/export-spark-csv.mjs` à partir
de l'export `data/articles_spark.json`. Les colonnes `themes_mistral`,
`themes_ml` et `tags` contiennent des tableaux JSON sérialisés en chaîne
(ex. `["IA/ML","Sécurité"]`).

Sorties
-------
Un CSV par analyse, écrit dans `spark/out/` :
  - `spark/out/freq_themes.csv` — fréquences des thèmes par source d'annotation.
  - `spark/out/cooccurrences_tags.csv` — paires de tags fréquemment associés.
  - `spark/out/tendances_hebdo.csv` — volume hebdomadaire + moyenne glissante.

Exécution
---------
Depuis la racine du repo (les chemins d'entrée/sortie sont relatifs à la
racine) :

    spark-submit spark/analyse.py
"""

import glob
import shutil
from pathlib import Path

from pyspark.sql import DataFrame, SparkSession, Window
from pyspark.sql import functions as F
from pyspark.sql.types import ArrayType, DoubleType, IntegerType, StringType, StructField, StructType

# --- Constantes ------------------------------------------------------------

# Référentiel des thèmes canoniques (cf. src/lib/classifyMl.ts, LABEL_MAP).
# Tout thème hors de cette liste est considéré "hors référentiel" (erreur
# d'annotation, faute de frappe, etc.) — voir freq_themes().
THEMES_CANONIQUES = [
    "IA/ML",
    "DevOps/Infrastructure",
    "Architecture",
    "Sécurité",
    "Développement",
    "Pratiques/Qualité",
    "Productivité/Outils",
]

CSV_ENTREE = "data/articles_spark.csv"
DIR_SORTIE = "spark/out"

# Cooccurrences : 1 187 tags distincts sur 529 articles → distribution très
# éparse, la majorité des paires n'apparaissent qu'une fois. Un support minimal
# de 5 isole les associations réellement structurantes.
SUPPORT_MIN = 5
TOP_N = 50


# --- Session Spark -----------------------------------------------------------


def build_spark() -> SparkSession:
    """Construit la SparkSession locale utilisée par tout le batch."""
    spark = (
        SparkSession.builder.appName("veille-analytics-batch")
        .master("local[*]")
        # Le volume de données est minuscule (529 articles) : les 200 partitions
        # de shuffle par défaut de Spark créeraient des centaines de petits
        # fichiers/tâches pour rien. On réduit à 8, suffisant pour local[*].
        .config("spark.sql.shuffle.partitions", 8)
        .getOrCreate()
    )
    # On ne garde que les warnings/erreurs : les logs INFO de Spark noient les
    # print() applicatifs qui servent de jalons de suivi du batch.
    spark.sparkContext.setLogLevel("WARN")
    return spark


# --- Chargement --------------------------------------------------------------


def load_articles(spark: SparkSession) -> DataFrame:
    """Charge le CSV d'articles avec un schéma explicite.

    On préfère un schéma explicite à l'inférence automatique
    (`inferSchema=True`) pour deux raisons : (1) éviter un premier passage sur
    tout le fichier juste pour deviner les types, et (2) garantir des types
    stables et prévisibles (ex. `score_confiance_ml` en DOUBLE) quel que soit
    le contenu des données.

    Les colonnes `themes_mistral`, `themes_ml` et `tags` restent des chaînes :
    ce sont des tableaux JSON sérialisés, qui seront parsés à la demande via
    `from_json` dans chaque analyse qui en a besoin (pas d'intérêt à les
    éclater ici, chaque analyse ne consomme pas forcément les trois colonnes).
    """
    schema = StructType(
        [
            StructField("id", IntegerType(), nullable=False),
            StructField("titre", StringType(), nullable=True),
            StructField("url", StringType(), nullable=True),
            StructField("source", StringType(), nullable=True),
            StructField("date_article", StringType(), nullable=True),
            StructField("themes_mistral", StringType(), nullable=True),
            StructField("themes_ml", StringType(), nullable=True),
            StructField("score_confiance_ml", DoubleType(), nullable=True),
            StructField("tags", StringType(), nullable=True),
        ]
    )

    return (
        spark.read.option("header", True)
        # Les champs texte (titre, tableaux JSON) peuvent contenir des retours
        # à la ligne ou des guillemets échappés : multiLine + escape/quote sont
        # nécessaires pour que le parseur CSV ne coupe pas une ligne logique
        # en plusieurs lignes physiques.
        .option("multiLine", True)
        .option("escape", '"')
        .option("quote", '"')
        .schema(schema)
        .csv(CSV_ENTREE)
    )


# --- Écriture des résultats ---------------------------------------------------


def ecrire_csv(df: DataFrame, nom: str) -> None:
    """Écrit un DataFrame en un unique fichier CSV lisible : `spark/out/<nom>.csv`.

    Piège classique : Spark écrit toujours un *répertoire* contenant un
    fichier par partition (`part-00000-...csv`, etc.), jamais un fichier CSV
    unique directement. `coalesce(1)` force le regroupement de toutes les
    données sur une seule partition avant l'écriture, ce qui produit un
    répertoire avec un unique part-file — acceptable ici vu le volume (529
    lignes au total), mais un anti-pattern à grande échelle (perte du
    parallélisme d'écriture, risque de saturer la mémoire d'un seul
    exécuteur).

    On écrit donc dans un répertoire temporaire, puis on déplace le seul
    part-file produit vers le nom de fichier final attendu, et on nettoie le
    répertoire temporaire.
    """
    dir_tmp = f"{DIR_SORTIE}/_tmp_{nom}"
    chemin_final = f"{DIR_SORTIE}/{nom}.csv"

    df.coalesce(1).write.mode("overwrite").option("header", True).csv(dir_tmp)

    part_files = glob.glob(f"{dir_tmp}/part-*.csv")
    if not part_files:
        raise RuntimeError(f"Aucun part-file trouvé dans {dir_tmp} — écriture Spark en échec ?")

    Path(DIR_SORTIE).mkdir(parents=True, exist_ok=True)
    shutil.move(part_files[0], chemin_final)
    shutil.rmtree(dir_tmp)


# --- Analyse 1 : fréquences par thème -----------------------------------------


def freq_themes(df: DataFrame) -> DataFrame:
    """Compte les occurrences de chaque thème, pour les deux méthodes d'annotation.

    Compare `themes_mistral` (annotation par LLM, Étape 6) et `themes_ml`
    (classifieur zero-shot, Étape 13), colonne par colonne, avant de les
    réunir en un seul DataFrame `theme, source_annotation, count,
    hors_referentiel`.

    Le drapeau `hors_referentiel` signale les thèmes absents de
    THEMES_CANONIQUES : en production, `themes_mistral` contient quelques
    labels parasites (variantes non normalisées produites par le LLM, ex. la
    faute de frappe "Produktivité/Outils"), qu'on veut pouvoir repérer sans
    les faire disparaître silencieusement du décompte.
    """

    def _freq(colonne: str, etiquette: str) -> DataFrame:
        return (
            df.select(F.from_json(F.col(colonne), ArrayType(StringType())).alias("themes"))
            .select(F.explode("themes").alias("theme"))
            .groupBy("theme")
            .count()
            .withColumn("source_annotation", F.lit(etiquette))
            .withColumn("hors_referentiel", ~F.col("theme").isin(THEMES_CANONIQUES))
        )

    freq_mistral = _freq("themes_mistral", "mistral")
    freq_ml = _freq("themes_ml", "ml")

    return (
        freq_mistral.union(freq_ml)
        .select("theme", "source_annotation", "count", "hors_referentiel")
        .orderBy(F.desc("count"))
    )


# --- Analyse 2 : cooccurrences de tags ----------------------------------------


def cooccurrences_tags(df: DataFrame) -> DataFrame:
    """Paires de tags apparaissant ensemble sur un même article.

    Démarche distribuée classique de recherche d'associations :
    1. `explode` des tableaux de tags → une ligne `(id, tag)` par occurrence ;
    2. **auto-jointure** de cette relation sur `id` : chaque article produit
       toutes les paires de ses tags ;
    3. la condition `tag_a < tag_b` (ordre lexicographique) élimine d'un coup
       les auto-paires (x, x) et les doublons miroir (x, y)/(y, x) — chaque
       paire n'est comptée qu'une fois, sous une forme canonique ;
    4. agrégation en `support` (nombre d'articles où la paire apparaît),
       filtrage au support minimal, top N.
    """
    article_tags = (
        df.select("id", F.explode(F.from_json(F.col("tags"), ArrayType(StringType()))).alias("tag"))
        # Sécurité : un même tag dupliqué sur un article ne doit compter qu'une fois.
        .dropDuplicates(["id", "tag"])
    )

    a = article_tags.alias("a")
    b = article_tags.alias("b")

    return (
        a.join(b, "id")
        .where(F.col("a.tag") < F.col("b.tag"))
        .groupBy(F.col("a.tag").alias("tag_a"), F.col("b.tag").alias("tag_b"))
        .agg(F.count("*").alias("support"))
        .where(F.col("support") >= SUPPORT_MIN)
        .orderBy(F.desc("support"), "tag_a", "tag_b")
        .limit(TOP_N)
    )


# --- Analyse 3 : tendances temporelles ----------------------------------------


def tendances_hebdo(df: DataFrame) -> DataFrame:
    """Volume d'articles par semaine + moyenne glissante sur 4 semaines.

    Deux mécaniques Spark distinctes et complémentaires :
    - `F.window("jour", "7 days")` : agrégation par *fenêtres temporelles*
      (tumbling window de 7 jours) → le volume hebdomadaire brut ;
    - `Window.orderBy(...).rowsBetween(-3, 0)` + `avg().over(...)` : une
      *window function* au sens SQL — pour chaque semaine, moyenne de la
      semaine courante et des 3 précédentes, sans effondrer les lignes
      (contrairement à un groupBy). C'est elle qui lisse la saisonnalité.

    Note : ce Window sans partitionBy rapatrie tout sur une partition (Spark
    l'annonce en WARN) — assumé ici (≈50 semaines), à partitionner par clé
    (ex. par thème) sur de gros volumes.
    """
    par_jour = (
        df.select(F.to_date(F.to_timestamp("date_article")).alias("jour"))
        .where(F.col("jour").isNotNull())
    )

    hebdo = (
        par_jour.groupBy(F.window("jour", "7 days").alias("fenetre"))
        .agg(F.count("*").alias("nb_articles"))
        .select(F.to_date("fenetre.start").alias("semaine"), "nb_articles")
    )

    glissante = Window.orderBy("semaine").rowsBetween(-3, 0)

    return (
        hebdo.withColumn("moyenne_glissante_4s", F.round(F.avg("nb_articles").over(glissante), 2))
        .orderBy("semaine")
    )


# --- Point d'entrée ------------------------------------------------------------


def main() -> None:
    spark = build_spark()

    df = load_articles(spark)

    nb_articles = df.count()
    print(f"Articles lus : {nb_articles} (529 attendus)")

    bornes_dates = df.select(F.min("date_article"), F.max("date_article")).first()
    print(f"Plage de dates : {bornes_dates[0]} → {bornes_dates[1]}")

    print("\n--- Analyse 1 : fréquences par thème ---")
    df_freq_themes = freq_themes(df)
    ecrire_csv(df_freq_themes, "freq_themes")
    print(f"{df_freq_themes.count()} lignes écrites → {DIR_SORTIE}/freq_themes.csv")

    print("\n--- Analyse 2 : cooccurrences de tags ---")
    df_cooc = cooccurrences_tags(df)
    ecrire_csv(df_cooc, "cooccurrences_tags")
    print(f"{df_cooc.count()} paires (support >= {SUPPORT_MIN}) → {DIR_SORTIE}/cooccurrences_tags.csv")

    print("\n--- Analyse 3 : tendances hebdomadaires ---")
    df_tendances = tendances_hebdo(df)
    ecrire_csv(df_tendances, "tendances_hebdo")
    print(f"{df_tendances.count()} semaines → {DIR_SORTIE}/tendances_hebdo.csv")

    spark.stop()


if __name__ == "__main__":
    main()
