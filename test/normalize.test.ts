import { describe, it, expect } from "vitest"
import { normalizeTags, toIsoOrNull, parseArticleRow } from "../src/lib/normalize"

describe("normalizeTags", () => {
  it("met en minuscule, trim et sérialise en JSON", () => {
    expect(normalizeTags(["  React ", "TS"])).toBe('["react","ts"]')
  })

  it("renvoie \"[]\" pour un tableau vide", () => {
    expect(normalizeTags([])).toBe("[]")
  })

  it("renvoie \"[]\" pour une entrée non-tableau", () => {
    expect(normalizeTags(undefined)).toBe("[]")
    expect(normalizeTags("react")).toBe("[]")
    expect(normalizeTags(null)).toBe("[]")
  })
})

describe("toIsoOrNull", () => {
  it("convertit une date valide en ISO", () => {
    expect(toIsoOrNull("2026-01-15")).toBe("2026-01-15T00:00:00.000Z")
  })

  it("renvoie null pour une date invalide", () => {
    expect(toIsoOrNull("pas-une-date")).toBeNull()
  })

  it("renvoie null pour une valeur non-string ou vide", () => {
    expect(toIsoOrNull(null)).toBeNull()
    expect(toIsoOrNull(42)).toBeNull()
    expect(toIsoOrNull("   ")).toBeNull()
  })
})

describe("parseArticleRow", () => {
  it("parse themes_mistral, themes_ml et tags depuis leur JSON", () => {
    const row = {
      id: 1,
      titre: "Titre",
      themes_mistral: '["ia","web"]',
      themes_ml: '["IA/ML"]',
      tags: '["react"]'
    }
    expect(parseArticleRow(row)).toEqual({
      id: 1,
      titre: "Titre",
      themes_mistral: ["ia", "web"],
      themes_ml: ["IA/ML"],
      tags: ["react"]
    })
  })

  it("renvoie des tableaux vides quand les champs sont null (themes_ml reste null : jamais classifié)", () => {
    const row = { id: 2, titre: "Autre", themes_mistral: null, themes_ml: null, tags: null }
    expect(parseArticleRow(row)).toEqual({
      id: 2,
      titre: "Autre",
      themes_mistral: [],
      themes_ml: null,
      tags: []
    })
  })

  it("distingue '[]' de NULL : classifié sans thème au seuil n'est pas non classifié", () => {
    const row = { id: 3, themes_mistral: "[]", themes_ml: "[]", tags: "[]" }
    const parsed = parseArticleRow(row)
    expect(parsed.themes_ml).toEqual([])
    expect(parsed.themes_ml).not.toBeNull()
  })

  // Une valeur illisible faisait tomber TOUTE la page en 500, sans indiquer l'article en
  // cause. La base a reçu des écritures directes (migration, correctifs ponctuels) et rien au
  // niveau du schéma ne contraint le format de ces colonnes TEXT.
  it.each([
    ["du JSON tronqué", '["ia"'],
    ["du texte brut", "ia, web"],
    ["un objet JSON valide mais hors contrat", '{"theme":"ia"}'],
    ["un scalaire JSON", "42"]
  ])("dégrade %s en valeur par défaut au lieu de lever", (_libelle, brut) => {
    const row = { id: 4, themes_mistral: brut, themes_ml: brut, tags: brut }
    expect(() => parseArticleRow(row)).not.toThrow()
    const parsed = parseArticleRow(row)
    expect(parsed.themes_mistral).toEqual([])
    expect(parsed.tags).toEqual([])
    // Repli assumé : corrompu devient indiscernable de « jamais classifié » sur ce champ.
    expect(parsed.themes_ml).toBeNull()
  })

  it("laisse intactes les colonnes qui ne sont pas du JSON", () => {
    const row = { id: 5, titre: "Titre", url: "https://exemple", score_mistral: 3 }
    expect(parseArticleRow(row)).toMatchObject({
      id: 5,
      titre: "Titre",
      url: "https://exemple",
      score_mistral: 3
    })
  })
})
