#!/usr/bin/env bash
#
# run-spark-batch.sh — Orchestration du batch d'analyse PySpark (compétences C23 + C29).
#
# Enchaîne les trois étapes du pipeline, jusque-là lancées à la main
# (cf. spark/README.md) :
#   1. Export des articles depuis Cloudflare D1 (--remote) vers JSON
#   2. Conversion JSON -> CSV (format attendu par le batch)
#   3. Exécution du batch Spark (spark-submit) dans son venv dédié

set -euo pipefail

# --- Constantes -------------------------------------------------------------

readonly DB_NAME="veille-analytics"
readonly JSON_PATH="data/articles_spark.json"
readonly CSV_PATH="data/articles_spark.csv"
readonly VENV_ACTIVATE="spark/.venv/bin/activate"
readonly SPARK_JOB="spark/analyse.py"
readonly OUT_DIR="spark/out"
readonly SQL_QUERY="SELECT id, titre, url, source, date_article, themes_mistral, themes_ml, score_confiance_ml, tags FROM articles"

# --- Utilitaires ------------------------------------------------------------

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

die() {
  printf '[%s] ERREUR : %s\n' "$(date '+%H:%M:%S')" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
run-spark-batch.sh — Orchestration du batch d'analyse PySpark.

Enchaîne : export Cloudflare D1 (--remote) -> JSON -> CSV -> spark-submit.

Usage :
  scripts/run-spark-batch.sh                 pipeline complet (export D1 inclus)
  scripts/run-spark-batch.sh --skip-export   rejoue conversion + Spark sur le JSON existant
  scripts/run-spark-batch.sh -h | --help

Prérequis : Java 17, venv spark/.venv, node/npx. En mode export,
CLOUDFLARE_API_TOKEN doit être exporté dans l'environnement (wrangler login
OAuth échoue sous WSL — on passe par le token).
EOF
}

# --- Analyse des arguments --------------------------------------------------

skip_export=false
for arg in "$@"; do
  case "$arg" in
    --skip-export) skip_export=true ;;
    -h | --help) usage; exit 0 ;;
    *) die "option inconnue : $arg (voir --help)" ;;
  esac
done

# --- Racine du repo ---------------------------------------------------------
# Les trois sous-commandes utilisent des chemins relatifs à la racine du repo
# (data/..., spark/...). On s'y place quel que soit le cwd de l'appelant.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# --- Préflight (fail-fast avant toute écriture) -----------------------------

command -v node >/dev/null 2>&1 || die "node introuvable dans le PATH"
command -v npx >/dev/null 2>&1 || die "npx introuvable dans le PATH"
[[ -f "$VENV_ACTIVATE" ]] || die "venv Spark absent ($VENV_ACTIVATE) — voir spark/README.md (uv venv spark/.venv)"

# --- Étape 1 : export D1 -> JSON --------------------------------------------

if [[ "$skip_export" == true ]]; then
  log "Étape 1/3 — export ignoré (--skip-export)"
  [[ -f "$JSON_PATH" ]] || die "$JSON_PATH absent : impossible de rejouer sans export préalable"
else
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN non défini (requis pour --remote)"
  log "Étape 1/3 — export D1 ($DB_NAME, --remote) -> $JSON_PATH"
  npx wrangler d1 execute "$DB_NAME" --remote --json --command "$SQL_QUERY" >"$JSON_PATH"
  [[ -s "$JSON_PATH" ]] || die "$JSON_PATH vide après export"
fi

# --- Étape 2 : JSON -> CSV --------------------------------------------------

log "Étape 2/3 — conversion JSON -> CSV ($CSV_PATH)"
node scripts/export-spark-csv.mjs
log "  $(wc -l <"$CSV_PATH") lignes dans $CSV_PATH (en-tête comprise)"

# --- Étape 3 : batch Spark --------------------------------------------------
# L'activation du venv est OBLIGATOIRE : spark-submit résout SPARK_HOME via le
# premier python3 du PATH, qui doit être celui du venv (où pyspark est installé),
# sinon find_spark_home échoue (cf. spark/README.md). Sous-shell pour ne pas
# polluer l'environnement de ce script.
log "Étape 3/3 — spark-submit $SPARK_JOB"
(
  # shellcheck disable=SC1090,SC1091
  source "$VENV_ACTIVATE"
  spark-submit "$SPARK_JOB"
)

# --- Rapport ----------------------------------------------------------------

log "Terminé en ${SECONDS}s — sorties dans $OUT_DIR/ :"
for csv in "$OUT_DIR"/*.csv; do
  [[ -e "$csv" ]] || { log "  (aucun CSV trouvé)"; break; }
  log "  $csv — $(wc -l <"$csv") lignes"
done
