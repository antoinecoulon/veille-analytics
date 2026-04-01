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
        body.date || null,
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