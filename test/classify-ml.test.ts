import { beforeEach, afterEach, describe, it, expect, vi } from "vitest"
import { classifyArticle, mapHfResponse, LABEL_MAP } from "../src/lib/classifyMl"

const HYP_DEVOPS = LABEL_MAP["DevOps/Infrastructure"]
const HYP_SECURITE = LABEL_MAP["Sécurité"]

// Seul l'appel à l'Inference API HF passe par le fetch global (D1/KV sont des
// bindings) : on le mocke directement, comme recommandé depuis la suppression
// de fetchMock dans @cloudflare/vitest-pool-workers 0.13 (Vitest 4).
let hfFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  hfFetch = vi.fn(async () => {
    throw new Error("appel sortant non mocké")
  })
  vi.stubGlobal("fetch", hfFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("mapHfResponse", () => {
  it("format pipeline ({labels, scores}) : seuil 0,7 + confiance = score max", () => {
    const out = mapHfResponse({
      sequence: "x",
      labels: [HYP_DEVOPS, HYP_SECURITE],
      scores: [0.93, 0.41]
    })
    expect(out.themes).toEqual(["DevOps/Infrastructure"])
    expect(out.confidence).toBeCloseTo(0.93, 5)
  })

  it("format Inference Providers ([{label, score}])", () => {
    const out = mapHfResponse([
      { label: HYP_SECURITE, score: 0.85 },
      { label: HYP_DEVOPS, score: 0.72 }
    ])
    expect(out.themes).toEqual(["Sécurité", "DevOps/Infrastructure"])
    expect(out.confidence).toBeCloseTo(0.85, 5)
  })

  it("aucun thème au-dessus du seuil : themes vide mais confiance renseignée", () => {
    const out = mapHfResponse({ labels: [HYP_DEVOPS], scores: [0.6] })
    expect(out.themes).toEqual([])
    expect(out.confidence).toBeCloseTo(0.6, 5)
  })

  it("réponse sans label reconnu : throw", () => {
    expect(() => mapHfResponse({ labels: ["inconnu"], scores: [0.9] })).toThrow()
    expect(() => mapHfResponse({ error: "oops" })).toThrow()
  })
})

describe("classifyArticle (retry cold start)", () => {
  it("succès direct au premier appel", async () => {
    hfFetch.mockImplementationOnce(async () =>
      Response.json({ labels: [HYP_DEVOPS], scores: [0.9] })
    )

    const out = await classifyArticle("Kubernetes en prod", "retour d'expérience", "tok", [0])
    expect(out.themes).toEqual(["DevOps/Infrastructure"])
    expect(hfFetch).toHaveBeenCalledTimes(1)
  })

  it("503 (modèle en chargement) puis 200 : le retry aboutit", async () => {
    hfFetch
      .mockImplementationOnce(async () => new Response("Model is loading", { status: 503 }))
      .mockImplementationOnce(async () => Response.json({ labels: [HYP_SECURITE], scores: [0.8] }))

    const out = await classifyArticle("CVE critique", "", "tok", [0, 0])
    expect(out.themes).toEqual(["Sécurité"])
    expect(hfFetch).toHaveBeenCalledTimes(2)
  })

  it("4xx : échec immédiat sans retry", async () => {
    hfFetch.mockImplementation(async () => new Response("Unauthorized", { status: 401 }))

    await expect(classifyArticle("Titre", "", "mauvais-token", [0, 0])).rejects.toThrow(/401/)
    expect(hfFetch).toHaveBeenCalledTimes(1)
  })

  it("5xx persistant : échec après épuisement des retries", async () => {
    hfFetch.mockImplementation(async () => new Response("loading", { status: 503 }))

    await expect(classifyArticle("Titre", "", "tok", [0, 0])).rejects.toThrow(/503/)
    expect(hfFetch).toHaveBeenCalledTimes(3)
  })
})
