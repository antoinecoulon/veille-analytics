// En-têtes de sécurité appliqués à TOUTES les réponses du Worker (C18).
//
// Mesuré en production le 2026-07-21 avant correction : le Worker ne renvoyait aucun
// en-tête de sécurité. Le dashboard a les siens, posés par Nitro (cf. nuxt.config.ts du
// dépôt veille-dashboard), mais le Worker est joignable directement : ses réponses ne
// passent pas toutes par le dashboard, et une réponse JSON servie sans `nosniff` peut
// être interprétée autrement que ce qu'elle prétend être.
//
// Appliqué en UN SEUL point, à la sortie du routeur, plutôt qu'à chaque `new Response` :
// une couverture qui dépend de la vigilance à chaque construction de réponse finit
// toujours par avoir un trou, et le trou est invisible.
//
// Le jeu est volontairement plus court que celui du dashboard : une API JSON ne rend pas
// de document, donc ni CSP de rendu ni Permissions-Policy n'ont d'objet. `frame-ancestors`
// et `nosniff` couvrent ce qui reste : empêcher qu'une réponse soit encadrée ou requalifiée.
const EN_TETES_SECURITE: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains"
}

/**
 * Renvoie une réponse identique, augmentée des en-têtes de sécurité.
 *
 * Les en-têtes déjà posés par l'appelant ne sont pas écrasés (`has` avant `set`) : le
 * jour où une route aura besoin d'une politique propre, elle la posera et celle-ci sera
 * respectée. La réponse d'origine n'est jamais mutée — les en-têtes d'une Response issue
 * d'un `fetch` sont immuables, et une copie coûte moins cher qu'un plantage à l'exécution.
 */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [nom, valeur] of Object.entries(EN_TETES_SECURITE)) {
    if (!headers.has(nom)) {
      headers.set(nom, valeur)
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}
