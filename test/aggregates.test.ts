import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test"
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest"
import worker from "../src/index"

// P1 (C27) — l'agrégat décisionnel (dim_date + agg_quotidien) est maintenu à l'écriture
// par refreshAggregatesForDay et lu par GET /api/stats/timeline. Ces tests vérifient les
// invariants de conception, en particulier que le rollup ne double-compte jamais.

const TOKEN = "test-token"

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
  await env.AUTH.put("API_TOKEN", TOKEN)
  await env.DB.exec("DELETE FROM articles")
  await env.DB.exec("DELETE FROM agg_quotidien")
  await env.DB.exec("DELETE FROM dim_date")
  // La classification ML part en waitUntil et n'a aucun rôle ici : on la fait échouer,
  // l'échec étant avalé par classifyAndStoreMl (themes_ml reste NULL).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("appel sortant non mocké")
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function ingest(body: unknown): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request("https://x/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body)
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

// Lignes de rollup : le total du jour, toutes thématiques confondues.
function rollups() {
  return env.DB.prepare(
    "SELECT date, nb_articles, score_moyen FROM agg_quotidien WHERE thematique IS NULL ORDER BY date"
  ).all<{ date: string; nb_articles: number; score_moyen: number | null }>()
}

function themeRows(jour: string) {
  return env.DB.prepare(
    "SELECT thematique, nb_articles FROM agg_quotidien WHERE date = ? AND thematique IS NOT NULL ORDER BY thematique"
  )
    .bind(jour)
    .all<{ thematique: string; nb_articles: number }>()
}

const base = {
  title: "Un article",
  link: "https://example.com/a",
  source: "dev.to",
  themes: ["Architecture"],
  score: 3,
  date: "2026-01-15"
}

describe("Agrégat — alimentation à l'ingestion", () => {
  it("crée la ligne de rollup, les lignes par thème et la dimension calendaire", async () => {
    expect((await ingest(base)).status).toBe(201)

    const { results: roll } = await rollups()
    expect(roll).toEqual([{ date: "2026-01-15", nb_articles: 1, score_moyen: 3 }])

    const { results: themes } = await themeRows("2026-01-15")
    expect(themes).toEqual([{ thematique: "Architecture", nb_articles: 1 }])

    const dim = await env.DB.prepare("SELECT * FROM dim_date").first<{
      date_complete: string
      annee: number
      mois: number
      semaine: number
      jour_semaine: number
    }>()
    // 2026-01-15 est un jeudi (jour_semaine 4, dimanche = 0).
    expect(dim).toMatchObject({
      date_complete: "2026-01-15",
      annee: 2026,
      mois: 1,
      jour_semaine: 4
    })
  })

  it("deux articles le même jour : rollup à 2, dimension non dupliquée", async () => {
    await ingest(base)
    await ingest({ ...base, link: "https://example.com/b", score: 5 })

    const { results: roll } = await rollups()
    expect(roll).toEqual([{ date: "2026-01-15", nb_articles: 2, score_moyen: 4 }])

    const dim = await env.DB.prepare("SELECT COUNT(*) AS n FROM dim_date").first<{ n: number }>()
    expect(dim?.n).toBe(1)
  })

  it("article multi-thèmes : le rollup ne double-compte pas", async () => {
    await ingest({ ...base, themes: ["Architecture", "Sécurité", "IA/ML"] })

    const { results: themes } = await themeRows("2026-01-15")
    expect(themes).toHaveLength(3)

    // La somme des lignes par thème vaut 3, le rollup doit rester à 1 article.
    const somme = themes.reduce((acc, r) => acc + r.nb_articles, 0)
    expect(somme).toBe(3)

    const { results: roll } = await rollups()
    expect(roll[0]).toMatchObject({ nb_articles: 1 })
  })

  it("article sans thème : présent dans le rollup, absent des lignes par thème", async () => {
    // Cas réel : 2 articles en prod n'ont pas de themes_mistral.
    await ingest({ ...base, themes: undefined })

    const { results: themes } = await themeRows("2026-01-15")
    expect(themes).toEqual([])

    const { results: roll } = await rollups()
    expect(roll[0]).toMatchObject({ date: "2026-01-15", nb_articles: 1 })
  })

  it("doublon réingéré : l'agrégat reste inchangé", async () => {
    await ingest(base)
    await ingest(base)

    const { results: roll } = await rollups()
    expect(roll).toEqual([{ date: "2026-01-15", nb_articles: 1, score_moyen: 3 }])
  })

  it("jours distincts : une ligne de rollup par jour", async () => {
    await ingest(base)
    await ingest({ ...base, link: "https://example.com/b", date: "2026-01-16" })

    const { results: roll } = await rollups()
    expect(roll.map((r) => r.date)).toEqual(["2026-01-15", "2026-01-16"])
  })

  it("article sans date exploitable : aucune ligne d'agrégat", async () => {
    await ingest({ ...base, date: undefined })

    const { results: roll } = await rollups()
    expect(roll).toEqual([])

    const dim = await env.DB.prepare("SELECT COUNT(*) AS n FROM dim_date").first<{ n: number }>()
    expect(dim?.n).toBe(0)
  })
})

describe("GET /api/stats/timeline — lecture de l'agrégat", () => {
  it("contrôle croisé : l'agrégat donne le même résultat que le calcul à la volée", async () => {
    await ingest(base)
    await ingest({ ...base, link: "https://example.com/b", themes: ["Sécurité", "IA/ML"] })
    await ingest({ ...base, link: "https://example.com/c", date: "2026-01-16" })
    await ingest({ ...base, link: "https://example.com/d", date: "2026-02-03", themes: undefined })
    // Sans date : hors périmètre de la timeline, des deux côtés.
    await ingest({ ...base, link: "https://example.com/e", date: undefined })

    const res = await get("/api/stats/timeline")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ jour: string; count: number }> }

    // Ce que faisait l'ancien endpoint, recalculé ici sur la table de faits.
    const { results: aLaVolee } = await env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', date_article) AS jour, COUNT(*) AS count
       FROM articles WHERE date_article IS NOT NULL GROUP BY jour ORDER BY jour ASC`
    ).all()

    expect(body.data).toEqual(aLaVolee)
    expect(body.data).toEqual([
      { jour: "2026-01-15", count: 2 },
      { jour: "2026-01-16", count: 1 },
      { jour: "2026-02-03", count: 1 }
    ])
  })
})
