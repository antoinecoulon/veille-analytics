import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test"
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest"
import worker from "../src/index"
import { bornesDuJour } from "../src/lib/aggregates"

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

// C24 — la sélection du jour est passée de `strftime('%Y-%m-%d', date_article) = ?` à un
// encadrement `date_article >= ? AND date_article < ?`, pour redevenir indexable. Le gain est
// mesuré ailleurs (data/perf/) ; ce qui se teste ici, c'est que l'équivalence tient sur les
// bornes — seul vrai risque de la réécriture.
const FORMAT_ATTENDU = /^\d{4}-\d{2}-\d{2}$/

describe("bornesDuJour — calcul des bornes d'un jour", () => {
  it("encadre le jour par le jour suivant", () => {
    expect(bornesDuJour("2026-06-29")).toEqual(["2026-06-29", "2026-06-30"])
  })

  it("franchit correctement un changement de mois", () => {
    expect(bornesDuJour("2026-01-31")).toEqual(["2026-01-31", "2026-02-01"])
  })

  it("franchit correctement un changement d'année", () => {
    expect(bornesDuJour("2026-12-31")).toEqual(["2026-12-31", "2027-01-01"])
  })

  it("gère le 29 février d'une année bissextile", () => {
    expect(bornesDuJour("2028-02-29")).toEqual(["2028-02-29", "2028-03-01"])
  })

  it("gère le 28 février d'une année non bissextile", () => {
    expect(bornesDuJour("2026-02-28")).toEqual(["2026-02-28", "2026-03-01"])
  })

  it("rejette un jour non analysable au lieu de produire des bornes silencieusement fausses", () => {
    expect(() => bornesDuJour("pas-une-date")).toThrow(/Jour invalide/)
  })

  // Le vrai risque n'est pas l'entrée absurde, rejetée de toute façon, mais celle qui ressemble
  // à une date : JavaScript la reporte au lieu de la refuser, et la fenêtre s'élargit en silence.
  it.each([
    ["2026-02-30", "reportée au 2 mars"],
    ["2026-06-31", "reportée au 1er juillet"],
    ["2027-02-29", "année non bissextile"]
  ])("rejette la date calendaire inexistante %s (%s)", (jour) => {
    expect(() => bornesDuJour(jour)).toThrow(/date calendaire inexistante/)
  })

  it.each(["2026-13-01", "2026-00-10"])("rejette le mois hors plage %s", (jour) => {
    expect(() => bornesDuJour(jour)).toThrow(/Jour invalide/)
  })

  // La borne basse est renvoyée telle quelle et comparée LEXICOGRAPHIQUEMENT : une forme non
  // canonique passerait Date.parse tout en se classant au mauvais endroit ("2026-6-9" > "2026-06-10").
  it.each(["2026-6-9", "26-06-29", "2026-06-29T10:00:00Z", "2026/06/29", " 2026-06-29"])(
    "rejette la forme non canonique %s",
    (jour) => {
      expect(() => bornesDuJour(jour)).toThrow(/attendu YYYY-MM-DD/)
    }
  )

  it("n'accepte que des bornes canoniques, donc comparables dans l'ordre lexicographique", () => {
    const [debut, fin] = bornesDuJour("2026-06-29")
    expect(debut < fin).toBe(true)
    expect(debut).toMatch(FORMAT_ATTENDU)
    expect(fin).toMatch(FORMAT_ATTENDU)
  })
})

describe("Agrégat — équivalence de l'encadrement aux bornes du jour", () => {
  it("inclut les articles à minuit et à la dernière milliseconde du jour", async () => {
    await ingest({ ...base, link: "https://example.com/minuit", date: "2026-01-15T00:00:00.000Z" })
    await ingest({ ...base, link: "https://example.com/fin", date: "2026-01-15T23:59:59.999Z" })

    const { results: roll } = await rollups()
    expect(roll).toEqual([{ date: "2026-01-15", nb_articles: 2, score_moyen: 3 }])
  })

  it("n'attire pas dans le jour l'article de minuit du lendemain", async () => {
    await ingest({ ...base, link: "https://example.com/veille", date: "2026-01-15T23:59:59.999Z" })
    await ingest({ ...base, link: "https://example.com/lendemain", date: "2026-01-16T00:00:00.000Z" })

    const { results: roll } = await rollups()
    expect(roll).toEqual([
      { date: "2026-01-15", nb_articles: 1, score_moyen: 3 },
      { date: "2026-01-16", nb_articles: 1, score_moyen: 3 }
    ])
  })

  it("produit exactement le même agrégat que l'ancienne expression strftime", async () => {
    // Cas volontairement variés : date seule, bornes du jour, jours et mois différents.
    await ingest({ ...base, link: "https://example.com/1", date: "2026-01-15" })
    await ingest({ ...base, link: "https://example.com/2", date: "2026-01-15T00:00:00.000Z" })
    await ingest({ ...base, link: "https://example.com/3", date: "2026-01-15T23:59:59.999Z" })
    await ingest({ ...base, link: "https://example.com/4", date: "2026-01-16T12:00:00.000Z" })
    await ingest({ ...base, link: "https://example.com/5", date: "2026-02-01T08:30:00.000Z" })
    await ingest({ ...base, link: "https://example.com/6", date: undefined })

    const { results: roll } = await rollups()

    // La version d'avant C24, rejouée telle quelle sur la table de faits.
    const { results: strftimeVersion } = await env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', date_article) AS date, COUNT(*) AS nb_articles,
              AVG(score_mistral) AS score_moyen
       FROM articles WHERE date_article IS NOT NULL
       GROUP BY date ORDER BY date`
    ).all()

    expect(roll).toEqual(strftimeVersion)
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
