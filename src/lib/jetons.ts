// Comparaison de jetons en temps constant (C18).
//
// `a !== b` sur des chaînes s'arrête au premier octet qui diffère : le temps de réponse dépend
// alors du nombre de caractères devinés juste. C'est la faille par laquelle un jeton se
// reconstruit octet par octet, sans jamais avoir été divulgué.
//
// L'exploitation réelle contre un Worker Cloudflare est douteuse — la variance du réseau et
// de la plateforme dépasse de plusieurs ordres de grandeur l'écart mesuré, et rien n'est
// journalisé qui permettrait d'affiner. Le correctif est retenu malgré tout parce qu'il coûte
// dix lignes et qu'il supprime la question : « ce n'est probablement pas exploitable » est un
// raisonnement qu'il faut refaire à chaque revue, « la comparaison est en temps constant » se
// vérifie une fois.
//
// LIMITE ASSUMÉE, et elle est réelle : la LONGUEUR du jeton attendu reste observable. Deux
// chaînes de longueurs différentes sortent par le premier `if`. Masquer aussi la longueur
// supposerait de hacher les deux valeurs avant comparaison ; les jetons de ce projet ont une
// longueur fixe, connue de qui les a posés, et cette information seule ne réduit pas l'espace
// de recherche de façon utile.

/**
 * Compare deux chaînes en un temps indépendant de la position du premier écart.
 *
 * L'accumulation par OU-exclusif parcourt toute la chaîne quoi qu'il arrive : aucun retour
 * anticipé, donc aucune fuite de la position de l'écart. Le résultat n'est testé qu'à la fin.
 */
export function jetonsEgaux(attendu: string | null | undefined, fourni: string | null | undefined): boolean {
  // Un jeton absent du KV, ou un en-tête absent de la requête, est un refus — jamais une
  // égalité. Deux valeurs vides ne doivent surtout pas se valider mutuellement : c'est le cas
  // « erreur de configuration » qui ouvrirait tout.
  if (!attendu || !fourni) return false
  if (attendu.length !== fourni.length) return false

  let ecart = 0
  for (let i = 0; i < attendu.length; i++) {
    ecart |= attendu.charCodeAt(i) ^ fourni.charCodeAt(i)
  }
  return ecart === 0
}
