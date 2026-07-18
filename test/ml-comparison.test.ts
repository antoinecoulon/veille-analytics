import { describe, it, expect } from "vitest"
import { computeMlComparison } from "../src/lib/mlComparison"

function row(mistral: string[] | null, ml: string[] | null) {
  return {
    themes_mistral: mistral ? JSON.stringify(mistral) : null,
    themes_ml: ml ? JSON.stringify(ml) : null
  }
}

describe("computeMlComparison", () => {
  it("accord exact : mêmes ensembles, ordre indifférent", () => {
    const out = computeMlComparison([row(["IA/ML", "Sécurité"], ["Sécurité", "IA/ML"])])
    expect(out.global).toMatchObject({ total: 1, compares: 1, accord_exact: 1, chevauchement: 1, jaccard_moyen: 1 })
  })

  it("chevauchement partiel : compté en chevauchement, pas en accord exact ; Jaccard fractionnaire", () => {
    // inter = {IA/ML}, union = {IA/ML, Sécurité, Développement} -> Jaccard 1/3
    const out = computeMlComparison([row(["IA/ML", "Sécurité"], ["IA/ML", "Développement"])])
    expect(out.global.accord_exact).toBe(0)
    expect(out.global.chevauchement).toBe(1)
    expect(out.global.jaccard_moyen).toBeCloseTo(1 / 3, 3)
  })

  it("désaccord total : aucun thème commun", () => {
    const out = computeMlComparison([row(["Sécurité"], ["Développement"])])
    expect(out.global).toMatchObject({ accord_exact: 0, chevauchement: 0, jaccard_moyen: 0 })
  })

  it("[] vs [] : accord exact (Jaccard 1 par convention), sans chevauchement", () => {
    const out = computeMlComparison([row([], [])])
    expect(out.global).toMatchObject({ compares: 1, accord_exact: 1, chevauchement: 0, jaccard_moyen: 1 })
  })

  it("les articles sans l'une des deux classifications sont exclus des comparables", () => {
    const out = computeMlComparison([
      row(["IA/ML"], null),
      row(null, ["IA/ML"]),
      row(["IA/ML"], ["IA/ML"])
    ])
    expect(out.global.total).toBe(3)
    expect(out.global.compares).toBe(1)
  })

  it("par_theme : accord / mistral_seul / ml_seul, les 7 thèmes toujours présents", () => {
    const out = computeMlComparison([
      row(["IA/ML", "Sécurité"], ["IA/ML", "Développement"]),
      row(["Sécurité"], ["Sécurité"])
    ])
    const byTheme = Object.fromEntries(out.par_theme.map((t) => [t.theme, t]))
    expect(out.par_theme).toHaveLength(7)
    expect(byTheme["IA/ML"]).toMatchObject({ accord: 1, mistral_seul: 0, ml_seul: 0 })
    expect(byTheme["Sécurité"]).toMatchObject({ accord: 1, mistral_seul: 1, ml_seul: 0 })
    expect(byTheme["Développement"]).toMatchObject({ accord: 0, mistral_seul: 0, ml_seul: 1 })
    expect(byTheme["Architecture"]).toMatchObject({ accord: 0, mistral_seul: 0, ml_seul: 0 })
  })

  it("jaccard_moyen : moyenne sur les seuls comparables, arrondie à 3 décimales", () => {
    const out = computeMlComparison([
      row(["IA/ML"], ["IA/ML"]), // 1
      row(["Sécurité"], ["Développement"]), // 0
      row(["IA/ML"], null) // exclu
    ])
    expect(out.global.jaccard_moyen).toBe(0.5)
  })
})
