import { env, applyD1Migrations } from "cloudflare:test"
import { beforeAll, beforeEach, describe, it, expect } from "vitest"
import worker from "../src/index"

const TOKEN = "test-token"

// Applique le schéma (0001) puis pilote le Worker via son export default.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
  await env.AUTH.put("API_TOKEN", TOKEN)
  await env.DB.exec("DELETE FROM articles")
})

function ingest(body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  return worker.fetch(
    new Request("https://x/api/ingest", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    env
  )
}

function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://x${path}`), env)
}

const article = {
  title: "Un article",
  link: "https://example.com/a",
  source: "dev.to",
  themes: ["ia", "web"],
  tags: ["  React ", "TS"],
  date: "2026-01-15"
}

describe("POST /api/ingest — auth", () => {
  it("401 sans header Authorization", async () => {
    const res = await ingest(article, null)
    expect(res.status).toBe(401)
  })

  it("403 avec un token invalide", async () => {
    const res = await ingest(article, "mauvais-token")
    expect(res.status).toBe(403)
  })
})

describe("POST /api/ingest — validation", () => {
  it("400 si le JSON est invalide", async () => {
    const res = await ingest("{ pas du json")
    expect(res.status).toBe(400)
  })

  it("400 si title ou link manque", async () => {
    const res = await ingest({ title: "sans lien" })
    expect(res.status).toBe(400)
  })
})

describe("POST /api/ingest — succès + lecture", () => {
  it("201 puis GET /api/articles renvoie l'article avec tags/themes en tableaux", async () => {
    expect((await ingest(article)).status).toBe(201)

    const res = await get("/api/articles")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ url: string; tags: string[]; themes_mistral: string[] }>
      pagination: { total: number }
    }
    expect(body.pagination.total).toBe(1)
    expect(body.data[0].url).toBe("https://example.com/a")
    expect(body.data[0].tags).toEqual(["react", "ts"])
    expect(body.data[0].themes_mistral).toEqual(["ia", "web"])
  })
})

describe("Dédoublonnage (INSERT OR IGNORE sur url UNIQUE)", () => {
  it("insérer 2× la même url ne crée qu'une ligne", async () => {
    expect((await ingest(article)).status).toBe(201)
    expect((await ingest(article)).status).toBe(201)

    const res = await get("/api/articles")
    const body = (await res.json()) as { pagination: { total: number } }
    expect(body.pagination.total).toBe(1)
  })
})

describe("GET /api/stats/*", () => {
  beforeEach(async () => {
    await ingest(article)
  })

  it("themes : 200 + comptage par thème", async () => {
    const res = await get("/api/stats/themes")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ theme: string; count: number }> }
    expect(body.data).toEqual(
      expect.arrayContaining([
        { theme: "ia", count: 1 },
        { theme: "web", count: 1 }
      ])
    )
  })

  it("sources : 200 + comptage par source", async () => {
    const res = await get("/api/stats/sources")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ source: string; count: number }> }
    expect(body.data).toEqual([{ source: "dev.to", count: 1 }])
  })

  it("timeline : 200 + comptage par jour", async () => {
    const res = await get("/api/stats/timeline")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ jour: string; count: number }> }
    expect(body.data).toEqual([{ jour: "2026-01-15", count: 1 }])
  })
})
