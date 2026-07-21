import { normalizeTags, toIsoOrNull, parseArticleRow } from "./lib/normalize"
import { classifyArticle } from "./lib/classifyMl"
import { computeMlComparison, type MlComparisonRow } from "./lib/mlComparison"
import { refreshAggregatesForDay } from "./lib/aggregates"
import { computeHealth, seuilRetardMl, type HealthRow } from "./lib/health"
import { withSecurityHeaders } from "./lib/securityHeaders"

export interface Env {
  DB: D1Database;
  AUTH: KVNamespace;
  HF_API_TOKEN: string;
}

export default {
  // Le routage est délégué à `route` ; ce point d'entrée ne fait qu'appliquer les
  // en-têtes de sécurité à ce qui en sort, quelle que soit la branche empruntée —
  // y compris les 401, 403 et 500, qui sont des réponses comme les autres.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withSecurityHeaders(await route(request, env, ctx))
  }
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === "POST" && url.pathname === "/api/ingest") {
    return handleDigest(request, env, ctx)
  }

  if (request.method === "GET" && url.pathname === "/api/articles") {
    const params = url.searchParams
    return fetchArticles(params, env)
  }

  if (request.method === "GET" && url.pathname === "/api/stats/themes") {
    return fetchArticlesCountByTheme(env)
  }

  if (request.method === "GET" && url.pathname === "/api/stats/sources") {
    return fetchArticlesCountBySource(env)
  }

  if (request.method === "GET" && url.pathname === "/api/stats/timeline") {
    return fetchArticlesTimeline(env)
  }

  if (request.method === "GET" && url.pathname === "/api/stats/ml-comparison") {
    return fetchMlComparison(env)
  }

  if (request.method === "GET" && url.pathname === "/api/stats/health") {
    return fetchHealth(env)
  }

  return new Response("VeilleAnalytics API - OK")
}

async function handleDigest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response("Non autorisé", { status: 401 })
  }

  const token = authHeader.replace("Bearer ", "")
  const validToken = await env.AUTH.get("API_TOKEN")
  if (token !== validToken) {
    return new Response("Token invalide", { status: 403 })
  }

  let body: any;
  try {
    body = await request.json()
  } catch {
    return new Response("JSON invalide", { status: 400 })
  }

  if (!body.title || !body.link) {
    return new Response("Champs 'title' et 'link' obligatoires", { status: 400 })
  }

  const tags = normalizeTags(body.tags)

  const themes = Array.isArray(body.themes)
    ? JSON.stringify(body.themes)
    : null

  const dateArticle = toIsoOrNull(body.date)

  try {
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO articles
      (titre, url, resume, source, categorie_mistral, score_mistral, themes_mistral, tags, date_article, date_collecte)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        body.title,
        body.link,
        body.resume || null,
        body.source || "inconnu",
        body.categorie || null,
        body.score || null,
        themes,
        tags,
        dateArticle,
        new Date().toISOString()
      )
      .run()

    // Classification ML en arrière-plan, seulement pour un article réellement
    // inséré (pas un doublon ignoré). La réponse 201 part sans attendre HF.
    if (result.meta.changes > 0) {
      ctx.waitUntil(classifyAndStoreMl(env, body.title, body.resume || null, body.link))
    }

    // Agrégat décisionnel maintenu à l'écriture, de façon synchrone : GET /api/stats/timeline
    // le lit directement, il doit donc être exact dès le retour de l'ingestion (cf. ADR D11).
    // Un échec ne doit jamais faire échouer l'ingestion — même philosophie que le ML — et
    // reste rattrapable par scripts/rebuild-aggregates.sql.
    if (result.meta.changes > 0 && dateArticle) {
      try {
        await refreshAggregatesForDay(env.DB, dateArticle.slice(0, 10))
      } catch (err) {
        console.error(`Rafraîchissement de l'agrégat échoué pour ${dateArticle}:`, err)
      }
    }

    return new Response(JSON.stringify({ status: "ok" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}

// Un échec HF (cold start épuisé, rate limit...) laisse themes_ml à NULL :
// l'article reste rattrapable par le script de backfill (scripts/classify-ml.mjs).
async function classifyAndStoreMl(env: Env, titre: string, resume: string | null, url: string): Promise<void> {
  if (!env.HF_API_TOKEN) {
    console.warn("HF_API_TOKEN absent : classification ML ignorée")
    return
  }
  try {
    const { themes, confidence } = await classifyArticle(titre, resume, env.HF_API_TOKEN)
    await env.DB.prepare("UPDATE articles SET themes_ml = ?, score_confiance_ml = ? WHERE url = ?")
      .bind(JSON.stringify(themes), confidence, url)
      .run()
  } catch (err) {
    console.error(`Classification ML échouée pour ${url}:`, err)
  }
}

async function fetchArticles(params: URLSearchParams, env: Env): Promise<Response> {
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(params.get("limit") ?? "20", 10) || 20))
  const offset = (page - 1) * limit

  const conditions: string[] = []
  const binds: unknown[] = []

  const theme = params.get("theme")
  if (theme) {
    conditions.push("themes_mistral IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(themes_mistral) WHERE value = ?)")
    binds.push(theme)
  }

  const source = params.get("source")
  if (source) {
    conditions.push("source = ?")
    binds.push(source)
  }

  const categorie = params.get("categorie")
  if (categorie) {
    conditions.push("categorie_mistral = ?")
    binds.push(categorie)
  }

  const scoreMin = params.get("score_min")
  if (scoreMin !== null) {
    const n = Number.parseInt(scoreMin, 10)
    if (!Number.isNaN(n)) {
      conditions.push("score_mistral >= ?")
      binds.push(n)
    }
  }

  const themeMl = params.get("theme_ml")
  if (themeMl) {
    conditions.push("themes_ml IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(themes_ml) WHERE value = ?)")
    binds.push(themeMl)
  }

  const scoreMlMin = params.get("score_ml_min")
  if (scoreMlMin !== null) {
    const n = Number.parseFloat(scoreMlMin)
    if (!Number.isNaN(n)) {
      conditions.push("score_confiance_ml >= ?")
      binds.push(n)
    }
  }

  // Présence/absence d'une classification ML.
  const ml = params.get("ml")
  if (ml === "oui") {
    conditions.push("themes_ml IS NOT NULL")
  } else if (ml === "non") {
    conditions.push("themes_ml IS NULL")
  }

  // Désaccord = les deux classifications existent et n'ont aucun thème commun.
  if (params.get("desaccord") === "1") {
    conditions.push(`themes_mistral IS NOT NULL AND themes_ml IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM json_each(themes_mistral) AS a
      WHERE EXISTS (SELECT 1 FROM json_each(themes_ml) AS b WHERE b.value = a.value))`)
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""

  const countRow = await env.DB
    .prepare(`SELECT COUNT(*) AS total FROM articles ${whereClause}`)
    .bind(...binds)
    .first<{ total: number }>()

  const total = countRow?.total ?? 0

  const { results } = await env.DB
    .prepare(`SELECT * FROM articles ${whereClause} ORDER BY date_article DESC, date_collecte DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all()

  const data = (results as Record<string, unknown>[]).map(parseArticleRow)

  return Response.json({
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  })
}

async function fetchArticlesCountByTheme(env: Env): Promise<Response> {
  const { results } = await env.DB
    .prepare(`
        SELECT value AS theme, COUNT(*) AS count
        FROM articles, json_each(articles.themes_mistral)
        WHERE articles.themes_mistral IS NOT NULL
        GROUP BY value
        ORDER BY count DESC
      `)
    .all()

  return Response.json({ data: results })
}

async function fetchArticlesCountBySource(env: Env): Promise<Response> {
  const { results } = await env.DB
    .prepare(`
        SELECT source, COUNT(*) AS count
        FROM articles
        GROUP BY source
        ORDER BY count DESC
      `)
    .all()

  return Response.json({ data: results })
}

async function fetchMlComparison(env: Env): Promise<Response> {
  const { results } = await env.DB
    .prepare("SELECT themes_mistral, themes_ml FROM articles")
    .all<MlComparisonRow>()

  return Response.json({ data: computeMlComparison(results) })
}

// Santé du pipeline (P3 — C33/C24). Un seul aller-retour D1 : les compteurs sont des
// sous-SELECT d'une même requête. Le jugement (seuils, statuts) est délégué à computeHealth,
// fonction pure testable sans D1 — cf. src/lib/health.ts et ADR D12.
//
// ⚠️ Ces comptages sont dupliqués dans scripts/health-check.sql (version exploitation, à
// lancer en --remote pour recouper l'endpoint). Toute évolution va aux deux endroits.
async function fetchHealth(env: Env): Promise<Response> {
  const now = new Date()

  const row = await env.DB.prepare(
    `SELECT
       (SELECT MAX(date_collecte) FROM articles) AS dernier_article_collecte,
       (SELECT COUNT(*) FROM articles) AS total,
       (SELECT COUNT(*) FROM articles
         WHERE themes_ml IS NULL AND date_collecte < ?1) AS ml_en_retard,
       (SELECT COUNT(*) FROM articles WHERE themes_ml = '[]') AS ml_sans_theme,
       (SELECT COUNT(*) FROM articles WHERE themes_mistral IS NULL) AS mistral_manquants`
  )
    // Le seuil des 24 h est calculé en TS et passé en paramètre plutôt qu'écrit en julianday :
    // la constante ML_RETARD_HEURES reste ainsi l'unique source de vérité.
    .bind(seuilRetardMl(now))
    .first<HealthRow>()

  // .first() ne renvoie null que si la requête ne produit aucune ligne ; ici les sous-SELECT
  // agrégés en produisent toujours une, même base vide. Repli défensif malgré tout.
  const compteurs: HealthRow = row ?? {
    dernier_article_collecte: null,
    total: 0,
    ml_en_retard: 0,
    ml_sans_theme: 0,
    mistral_manquants: 0
  }

  return Response.json({ data: computeHealth(compteurs, now) })
}

// Lecture de l'agrégat pré-calculé (lignes de rollup, thematique NULL) au lieu d'un
// GROUP BY à la volée sur articles : c'est le principe même de l'entrepôt décisionnel,
// l'agrégat étant maintenu à l'écriture par refreshAggregatesForDay (cf. ADR D11).
// Contrat de sortie inchangé : { jour, count }.
async function fetchArticlesTimeline(env: Env): Promise<Response> {
  const { results } = await env.DB
    .prepare(`
        SELECT date AS jour, nb_articles AS count
        FROM agg_quotidien
        WHERE thematique IS NULL
        ORDER BY date ASC
      `)
    .all()

  return Response.json({ data: results })
}