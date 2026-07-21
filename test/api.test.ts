import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test"
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest"
import worker from "../src/index"
import { LABEL_MAP } from "../src/lib/classifyMl"

const TOKEN = "test-token"

// Seul l'appel HF (classification ML en waitUntil) passe par le fetch global :
// on le mocke directement. Par défaut il échoue (pas de réseau dans les tests),
// l'échec étant avalé par classifyAndStoreMl — themes_ml reste alors NULL.
let hfFetch: ReturnType<typeof vi.fn>

// Applique le schéma (0001) puis pilote le Worker via son export default.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
  await env.AUTH.put("API_TOKEN", TOKEN)
  await env.DB.exec("DELETE FROM articles")
  // L'agrégat est maintenu à l'écriture : sans purge, ses lignes survivraient à la
  // suppression des faits et fausseraient les assertions de comptage.
  await env.DB.exec("DELETE FROM agg_quotidien")
  await env.DB.exec("DELETE FROM dim_date")
  hfFetch = vi.fn(async () => {
    throw new Error("appel sortant non mocké")
  })
  vi.stubGlobal("fetch", hfFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Attend la fin des tâches waitUntil (classification ML) avant de rendre la main.
async function ingest(body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request("https://x/api/ingest", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    env,
    ctx
  )
  await waitOnExecutionContext(ctx)
  return res
}

function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://x${path}`), env, createExecutionContext())
}

// Mocke une réponse HF (format pipeline) pour le prochain appel Inference API.
function mockHf(scores: Array<[theme: string, score: number]>) {
  hfFetch.mockImplementationOnce(async () =>
    Response.json({
      labels: scores.map(([theme]) => LABEL_MAP[theme]),
      scores: scores.map(([, score]) => score)
    })
  )
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

describe("Classification ML (waitUntil + Inference API HF)", () => {
  it("ingest → themes_ml (seuil 0,7) et score_confiance_ml renseignés", async () => {
    mockHf([["DevOps/Infrastructure", 0.93], ["Sécurité", 0.41]])
    expect((await ingest(article)).status).toBe(201)

    const res = await get("/api/articles")
    const body = (await res.json()) as {
      data: Array<{ themes_ml: string[] | null; score_confiance_ml: number | null }>
    }
    expect(body.data[0].themes_ml).toEqual(["DevOps/Infrastructure"])
    expect(body.data[0].score_confiance_ml).toBeCloseTo(0.93, 5)
  })

  it("échec HF → l'ingestion répond quand même 201, themes_ml reste NULL", async () => {
    // Pas de mockHf : l'appel HF rejette (fetch par défaut du beforeEach).
    expect((await ingest(article)).status).toBe(201)

    const res = await get("/api/articles")
    const body = (await res.json()) as {
      data: Array<{ themes_ml: string[] | null; score_confiance_ml: number | null }>
      pagination: { total: number }
    }
    expect(body.pagination.total).toBe(1)
    expect(body.data[0].themes_ml).toBeNull()
    expect(body.data[0].score_confiance_ml).toBeNull()
  })

  it("doublon ignoré → pas de re-classification (un seul appel HF)", async () => {
    mockHf([["IA/ML", 0.88]])
    expect((await ingest(article)).status).toBe(201)
    expect((await ingest(article)).status).toBe(201)

    expect(hfFetch).toHaveBeenCalledTimes(1)
    const res = await get("/api/articles")
    const body = (await res.json()) as {
      data: Array<{ themes_ml: string[] | null }>
      pagination: { total: number }
    }
    expect(body.pagination.total).toBe(1)
    expect(body.data[0].themes_ml).toEqual(["IA/ML"])
  })
})

describe("Filtres ML sur GET /api/articles + GET /api/stats/ml-comparison", () => {
  // 3 articles : accord ML/Mistral, désaccord total, sans classification ML.
  beforeEach(async () => {
    await ingest({ title: "A1", link: "https://x/a1", themes: ["IA/ML"] })
    await ingest({ title: "A2", link: "https://x/a2", themes: ["Sécurité"] })
    await ingest({ title: "A3", link: "https://x/a3", themes: ["Architecture"] })
    await env.DB.prepare("UPDATE articles SET themes_ml = ?, score_confiance_ml = ? WHERE url = ?")
      .bind('["IA/ML"]', 0.9, "https://x/a1").run()
    await env.DB.prepare("UPDATE articles SET themes_ml = ?, score_confiance_ml = ? WHERE url = ?")
      .bind('["Développement"]', 0.8, "https://x/a2").run()
  })

  async function urls(query: string): Promise<string[]> {
    const res = await get(`/api/articles?${query}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ url: string }> }
    return body.data.map((a) => a.url).sort()
  }

  it("theme_ml : filtre sur les thèmes ML (pas Mistral)", async () => {
    expect(await urls("theme_ml=IA/ML")).toEqual(["https://x/a1"])
    expect(await urls("theme_ml=Développement")).toEqual(["https://x/a2"])
  })

  it("score_ml_min : seuil de confiance ML", async () => {
    expect(await urls("score_ml_min=0.85")).toEqual(["https://x/a1"])
    expect(await urls("score_ml_min=0.5")).toEqual(["https://x/a1", "https://x/a2"])
  })

  it("ml=oui / ml=non : présence ou absence de classification ML", async () => {
    expect(await urls("ml=oui")).toEqual(["https://x/a1", "https://x/a2"])
    expect(await urls("ml=non")).toEqual(["https://x/a3"])
  })

  it("desaccord=1 : aucun thème commun entre Mistral et ML", async () => {
    expect(await urls("desaccord=1")).toEqual(["https://x/a2"])
  })

  it("ml-comparison : agrégats globaux + détail par thème", async () => {
    const res = await get("/api/stats/ml-comparison")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        global: Record<string, number>
        par_theme: Array<{ theme: string; accord: number; mistral_seul: number; ml_seul: number }>
      }
    }
    expect(body.data.global).toEqual({
      total: 3,
      compares: 2,
      accord_exact: 1,
      chevauchement: 1,
      jaccard_moyen: 0.5
    })
    const byTheme = Object.fromEntries(body.data.par_theme.map((t) => [t.theme, t]))
    expect(byTheme["IA/ML"]).toMatchObject({ accord: 1 })
    expect(byTheme["Sécurité"]).toMatchObject({ mistral_seul: 1 })
    expect(byTheme["Développement"]).toMatchObject({ ml_seul: 1 })
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

// En-têtes de sécurité (C18). Le point testé n'est pas « la fonction pose bien les
// en-têtes » — ce serait tester la fonction contre elle-même — mais « AUCUNE réponse du
// Worker n'y échappe », y compris les chemins d'erreur et la route de repli. C'est
// précisément la propriété qu'une application au cas par cas finirait par perdre.
describe("En-têtes de sécurité sur toutes les réponses", () => {
  const attendus = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains"
  }

  it.each([
    ["route de repli", () => get("/")],
    ["lecture d'articles", () => get("/api/articles")],
    ["statistiques", () => get("/api/stats/themes")],
    ["indicateur de santé", () => get("/api/stats/health")]
  ])("%s", async (_libelle, appel) => {
    const res = await appel()
    for (const [nom, valeur] of Object.entries(attendus)) {
      expect(res.headers.get(nom)).toBe(valeur)
    }
  })

  it("un refus d'authentification les porte aussi", async () => {
    const res = await ingest(article, null)
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  it("le Content-Type d'origine n'est pas écrasé", async () => {
    const res = await get("/api/stats/themes")
    expect(res.headers.get("Content-Type")).toContain("application/json")
  })
})
