import { describe, it, expect } from "vitest"
import { jetonsEgaux } from "../src/lib/jetons"

// Ce qui est testé ici est la CORRECTION de la comparaison, pas sa constance temporelle.
// Mesurer un temps constant dans une suite de tests donnerait un résultat dominé par le bruit
// de l'ordonnanceur : le test échouerait au hasard, ou passerait pour de mauvaises raisons.
// La constance se lit dans l'implémentation — aucun retour anticipé dans la boucle — et c'est
// ainsi qu'elle est défendue. Ce que ces tests garantissent, c'est qu'en durcissant la
// comparaison on n'a pas changé qui est accepté et qui est refusé.

describe("Comparaison de jetons", () => {
  it("accepte deux jetons identiques", () => {
    expect(jetonsEgaux("s3cr3t-de-lecture", "s3cr3t-de-lecture")).toBe(true)
  })

  it.each([
    ["premier caractère", "aecret", "secret"],
    ["dernier caractère", "secrea", "secret"],
    ["casse", "SECRET", "secret"],
    ["longueur", "secre", "secret"],
    ["espace de bordure", "secret ", "secret"]
  ])("refuse un jeton qui diffère par %s", (_libelle, fourni, attendu) => {
    expect(jetonsEgaux(attendu, fourni)).toBe(false)
  })

  // Le cas qui ouvrirait tout : deux valeurs absentes ne doivent JAMAIS se valider
  // mutuellement. C'est la même exigence que le test « refuse tout si le jeton est absent du
  // KV » de api.test.ts, ici au niveau de la fonction.
  it.each([
    ["les deux absents", null, null],
    ["attendu absent", null, "un-jeton"],
    ["fourni absent", "un-jeton", null],
    ["attendu vide", "", "un-jeton"],
    ["fourni vide", "un-jeton", ""],
    ["les deux vides", "", ""],
    ["fourni undefined", "un-jeton", undefined]
  ])("refuse quand %s", (_libelle, attendu, fourni) => {
    expect(jetonsEgaux(attendu, fourni)).toBe(false)
  })

  it("ne se laisse pas tromper par un jeton non ASCII de même longueur", () => {
    expect(jetonsEgaux("jetoné", "jetone")).toBe(false)
    expect(jetonsEgaux("jetoné", "jetoné")).toBe(true)
  })
})
