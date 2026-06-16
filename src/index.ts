interface Env {
  DB: D1Database;
  AUTH: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "POST" && url.pathname === "/api/ingest") {
      return handleDigest(request, env)
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
    
    return new Response("VeilleAnalytics API - OK");
  }
}

async function handleDigest(request: Request, env: Env): Promise<Response> {
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

  const tags = Array.isArray(body.tags)
    ? JSON.stringify(body.tags.map((t: string) => t.toLowerCase().trim()))
    : "[]"

  const themes = Array.isArray(body.themes)
    ? JSON.stringify(body.themes)
    : null

  try {
    await env.DB.prepare(
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
        toIsoOrNull(body.date),
        new Date().toISOString()
      )
      .run()

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

  const data = (results as any[]).map((row) => ({
    ...row,
    themes_mistral: row.themes_mistral ? JSON.parse(row.themes_mistral) : [],
    tags: row.tags ? JSON.parse(row.tags) : []
  }))

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

// ======= HELPERS ========
function toIsoOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}