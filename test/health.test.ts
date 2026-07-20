import { env, applyD1Migrations, createExecutionContext } from "cloudflare:test"
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest"
import worker from "../src/index"
import {
  computeHealth,
  seuilRetardMl,
  FRAICHEUR_OK_JOURS,
  FRAICHEUR_ALERTE_JOURS,
  ML_RETARD_HEURES,
  type HealthRow,
  type PipelineHealth
} from "../src/lib/health"

// P3 (C33/C24) — les seuils de santé du pipeline vivent en TypeScript (le SQL compte, le TS
// juge) : la première moitié de ce fichier fixe leurs bornes sans toucher à D1, la seconde
// vérifie que la route GET /api/stats/health compte bien ce qu'elle prétend compter.

const NOW = new Date("2026-07-20T12:00:00.000Z")

/** Date d'ingestion située `jours` jours avant NOW. */
function ilYA(jours: number): string {
  return new Date(NOW.getTime() - jours * 86_400_000).toISOString()
}

function row(over: Partial<HealthRow> = {}): HealthRow {
  return {
    derniere_ingestion: ilYA(0),
    total: 10,
    ml_en_retard: 0,
    ml_sans_theme: 0,
    mistral_manquants: 0,
    ...over
  }
}

describe("computeHealth — fraîcheur de la collecte", () => {
  it("ingestion du jour : ok, 0 jour écoulé", () => {
    const out = computeHealth(row(), NOW)
    expect(out.collecte).toMatchObject({ jours_depuis: 0, statut: "ok" })
    expect(out.statut).toBe("ok")
  })

  it("borne haute de ok : exactement 3 jours reste ok", () => {
    const out = computeHealth(row({ derniere_ingestion: ilYA(FRAICHEUR_OK_JOURS) }), NOW)
    expect(out.collecte).toMatchObject({ jours_depuis: 3, statut: "ok" })
  })

  it("premier jour dégradé : 4 jours bascule en degrade", () => {
    const out = computeHealth(row({ derniere_ingestion: ilYA(FRAICHEUR_OK_JOURS + 1) }), NOW)
    expect(out.collecte).toMatchObject({ jours_depuis: 4, statut: "degrade" })
    expect(out.statut).toBe("degrade")
  })

  it("borne haute de degrade : exactement 14 jours reste degrade", () => {
    const out = computeHealth(row({ derniere_ingestion: ilYA(FRAICHEUR_ALERTE_JOURS) }), NOW)
    expect(out.collecte).toMatchObject({ jours_depuis: 14, statut: "degrade" })
  })

  it("premier jour d'alerte : 15 jours bascule en alerte", () => {
    const out = computeHealth(row({ derniere_ingestion: ilYA(FRAICHEUR_ALERTE_JOURS + 1) }), NOW)
    expect(out.collecte).toMatchObject({ jours_depuis: 15, statut: "alerte" })
    expect(out.statut).toBe("alerte")
  })

  it("l'interruption réelle de 67 jours (mai 2026) serait bien en alerte", () => {
    const out = computeHealth(row({ derniere_ingestion: ilYA(67) }), NOW)
    expect(out.collecte).toMatchObject({ jours_depuis: 67, statut: "alerte" })
  })

  it("base vide : aucune ingestion connue est une alerte, pas un état neutre", () => {
    const out = computeHealth(row({ derniere_ingestion: null, total: 0 }), NOW)
    expect(out.collecte).toMatchObject({ derniere_ingestion: null, jours_depuis: null, statut: "alerte" })
    expect(out.statut).toBe("alerte")
  })

  it("date illisible : traitée comme une absence d'ingestion", () => {
    const out = computeHealth(row({ derniere_ingestion: "pas-une-date" }), NOW)
    expect(out.collecte).toMatchObject({ jours_depuis: null, statut: "alerte" })
  })

  it("date légèrement dans le futur : plancher à 0 jour, pas de valeur négative", () => {
    const out = computeHealth(row({ derniere_ingestion: ilYA(-1) }), NOW)
    expect(out.collecte).toMatchObject({ jours_depuis: 0, statut: "ok" })
  })
})

describe("computeHealth — classification", () => {
  it("aucun article en retard : ok", () => {
    expect(computeHealth(row(), NOW).classification.statut).toBe("ok")
  })

  it("un seul article en retard suffit à déclencher l'alerte (seuil binaire)", () => {
    const out = computeHealth(row({ ml_en_retard: 1 }), NOW)
    expect(out.classification.statut).toBe("alerte")
    expect(out.statut).toBe("alerte")
  })

  it("ml_sans_theme ([]) n'est pas un échec et ne dégrade jamais le statut", () => {
    // 72 articles en prod : les faire remonter en alerte rendrait l'indicateur inutilisable.
    const out = computeHealth(row({ ml_sans_theme: 72 }), NOW)
    expect(out.classification).toMatchObject({ ml_sans_theme: 72, statut: "ok" })
    expect(out.statut).toBe("ok")
  })

  it("mistral_manquants (résidu historique) est exposé mais neutre", () => {
    const out = computeHealth(row({ mistral_manquants: 2 }), NOW)
    expect(out.classification).toMatchObject({ mistral_manquants: 2, statut: "ok" })
    expect(out.statut).toBe("ok")
  })

  it("les compteurs bruts sont relayés tels quels", () => {
    const out = computeHealth(
      row({ total: 529, ml_en_retard: 0, ml_sans_theme: 72, mistral_manquants: 2 }),
      NOW
    )
    expect(out.classification).toMatchObject({
      total: 529,
      ml_en_retard: 0,
      ml_sans_theme: 72,
      mistral_manquants: 2
    })
  })
})

describe("computeHealth — statut global", () => {
  it("retient le pire des deux sous-statuts", () => {
    // Collecte dégradée + classification en alerte -> alerte.
    const out = computeHealth(row({ derniere_ingestion: ilYA(5), ml_en_retard: 3 }), NOW)
    expect(out.collecte.statut).toBe("degrade")
    expect(out.classification.statut).toBe("alerte")
    expect(out.statut).toBe("alerte")
  })

  it("une collecte en alerte l'emporte sur une classification saine", () => {
    const out = computeHealth(row({ derniere_ingestion: ilYA(30) }), NOW)
    expect(out.classification.statut).toBe("ok")
    expect(out.statut).toBe("alerte")
  })
})

describe("seuilRetardMl", () => {
  it("recule de ML_RETARD_HEURES heures depuis maintenant", () => {
    expect(seuilRetardMl(NOW)).toBe(
      new Date(NOW.getTime() - ML_RETARD_HEURES * 3_600_000).toISOString()
    )
  })

  it("vaut 24 h, soit très au-delà de la durée réelle d'une classification", () => {
    expect(ML_RETARD_HEURES).toBe(24)
    expect(seuilRetardMl(NOW)).toBe("2026-07-19T12:00:00.000Z")
  })
})

// --- Intégration : GET /api/stats/health contre une vraie D1 (patron d'aggregates.test.ts) ---

const TOKEN = "test-token"

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
  await env.AUTH.put("API_TOKEN", TOKEN)
  await env.DB.exec("DELETE FROM articles")
  await env.DB.exec("DELETE FROM agg_quotidien")
  await env.DB.exec("DELETE FROM dim_date")
  // La classification ML part en waitUntil : on la fait échouer, l'échec étant avalé par
  // classifyAndStoreMl. themes_ml reste donc NULL — exactement le scénario que P3 doit rendre
  // visible.
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
  return worker.fetch(
    new Request("https://x/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body)
    }),
    env,
    createExecutionContext()
  )
}

async function health(): Promise<PipelineHealth> {
  const res = await worker.fetch(
    new Request("https://x/api/stats/health"),
    env,
    createExecutionContext()
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: PipelineHealth }
  return body.data
}

/** Recule la date_collecte d'un article déjà inséré, pour simuler l'écoulement du temps. */
function vieillir(url: string, jours: number): Promise<unknown> {
  const date = new Date(Date.now() - jours * 86_400_000).toISOString()
  return env.DB.prepare("UPDATE articles SET date_collecte = ?1 WHERE url = ?2")
    .bind(date, url)
    .run()
}

describe("GET /api/stats/health", () => {
  it("base vide : alerte, aucune ingestion connue", async () => {
    const out = await health()
    expect(out.statut).toBe("alerte")
    expect(out.collecte).toMatchObject({ derniere_ingestion: null, jours_depuis: null })
    expect(out.classification).toMatchObject({ total: 0, ml_en_retard: 0, ml_sans_theme: 0 })
  })

  it("ingestion à l'instant : tout est vert malgré themes_ml NULL (moins de 24 h)", async () => {
    await ingest({ title: "A", link: "https://x/a", themes: ["IA/ML"], date: "2026-07-20" })

    const out = await health()
    expect(out.classification).toMatchObject({ total: 1, ml_en_retard: 0 })
    expect(out.collecte.jours_depuis).toBe(0)
    expect(out.statut).toBe("ok")
  })

  it("article non classifié depuis plus de 24 h : passe en alerte", async () => {
    await ingest({ title: "A", link: "https://x/a", themes: ["IA/ML"], date: "2026-07-20" })
    await vieillir("https://x/a", 2)

    const out = await health()
    expect(out.classification).toMatchObject({ ml_en_retard: 1, statut: "alerte" })
    expect(out.statut).toBe("alerte")
  })

  it("themes_ml = [] compte en ml_sans_theme, jamais en retard : NULL ≠ []", async () => {
    await ingest({ title: "A", link: "https://x/a", themes: ["IA/ML"], date: "2026-07-20" })
    // Classifié, mais aucun thème au-dessus du seuil de 0,7.
    await env.DB.prepare("UPDATE articles SET themes_ml = '[]' WHERE url = ?1")
      .bind("https://x/a")
      .run()
    await vieillir("https://x/a", 5)

    const out = await health()
    expect(out.classification).toMatchObject({ ml_sans_theme: 1, ml_en_retard: 0, statut: "ok" })
  })

  it("compte les articles sans classification Mistral, sans dégrader le statut", async () => {
    await ingest({ title: "A", link: "https://x/a", date: "2026-07-20" })

    const out = await health()
    expect(out.classification).toMatchObject({ mistral_manquants: 1, statut: "ok" })
  })

  it("derniere_ingestion vaut bien MAX(date_collecte)", async () => {
    await ingest({ title: "A", link: "https://x/a", date: "2026-07-20" })
    await ingest({ title: "B", link: "https://x/b", date: "2026-07-20" })
    await vieillir("https://x/a", 10)

    const attendu = await env.DB.prepare("SELECT MAX(date_collecte) AS m FROM articles").first<{
      m: string
    }>()
    const out = await health()
    expect(out.collecte.derniere_ingestion).toBe(attendu?.m)
    // Le plus récent des deux articles est de l'instant : la collecte reste fraîche.
    expect(out.collecte.statut).toBe("ok")
  })

  it("une collecte ancienne dégrade le statut même sans problème de classification", async () => {
    await ingest({ title: "A", link: "https://x/a", themes: ["IA/ML"], date: "2026-07-20" })
    await env.DB.prepare("UPDATE articles SET themes_ml = '[\"IA/ML\"]' WHERE url = ?1")
      .bind("https://x/a")
      .run()
    await vieillir("https://x/a", FRAICHEUR_OK_JOURS + 1)

    const out = await health()
    expect(out.classification.statut).toBe("ok")
    expect(out.collecte).toMatchObject({ jours_depuis: 4, statut: "degrade" })
    expect(out.statut).toBe("degrade")
  })
})
