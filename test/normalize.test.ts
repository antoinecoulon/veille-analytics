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
})
