# VeilleAnalytics — Plan d'action

Chaque étape est conçue pour être faisable en quelques heures à quelques jours. L'ordre est important : chaque étape dépend de la précédente. Les cases à cocher permettent de suivre l'avancement.

---

## Phase 1 — Fondations (Mars-Avril 2026) **OK**

L'objectif est d'avoir un pipeline fonctionnel de bout en bout : Node-RED -> Worker -> D1 -> données accessibles via API.

### Étape 1 — Setup des comptes et outils

- [x]  Créer un compte Cloudflare (gratuit, sans CB)
- [x]  Installer Wrangler CLI (`npm install -g wrangler`) et se connecter (`wrangler login`)
- [x]  Créer un repo GitHub public `veille-analytics`
- [x]  Initialiser le projet avec Wrangler (`wrangler init`)
- [x]  Vérifier que tout fonctionne : déployer un Worker "Hello World" avec `wrangler deploy`

**Résultat** : un Worker accessible sur `*.workers.dev`, un repo GitHub, les outils installés.

### Étape 2 — Créer la base D1

- [x]  Créer la base D1 via Wrangler (`wrangler d1 create veille-analytics`)
- [x]  Écrire le fichier de migration SQL avec le schéma (table `articles`, `dim_date`, `agg_quotidien`)
- [x]  Appliquer la migration (`wrangler d1 migrations apply`)
- [x]  Tester avec une insertion manuelle via Wrangler (`wrangler d1 execute`)

**Résultat** : une base D1 avec le schéma en place, vide mais prête.

### Étape 3 — Migration de l'historique JSON

- [x]  Écrire un script (Node.js ou Python) qui lit le fichier `articles.json`
- [x]  Pour chaque article : normaliser les champs (dates ISO, tags en lowercase, dédoublonnage variantes)
- [x]  Insérer les 270 articles dans D1 via le script (en batch, via Wrangler ou l'API D1)
- [x]  Vérifier le contenu : `SELECT COUNT(*) FROM articles`, quelques `SELECT` de contrôle

**Résultat** : les 270 articles historiques sont dans D1.

### Étape 4 — Worker ETL (endpoint d'ingestion)

- [x]  Coder la route `POST /api/ingest` dans le Worker
- [x]  Logique : valider le payload, normaliser les champs, insérer dans D1
- [x]  Dédoublonnage par URL (contrainte UNIQUE, gérer le conflit proprement)
- [x]  Créer un secret KV pour l'authentification par token
- [x]  Vérifier le token dans le header `Authorization` à chaque requête
- [x]  Tester avec curl ou Postman : envoyer un article de test, vérifier qu'il arrive dans D1
- [x]  Déployer avec `wrangler deploy`

**Résultat** : un endpoint fonctionnel qui reçoit des articles et les stocke dans D1.

### Étape 5 — Adapter Node-RED

- [x]  Ajouter un nœud HTTP Request après la classification Mistral
- [x]  Configurer le POST vers l'URL du Worker avec le token en header
- [x]  Mapper les champs du payload Node-RED vers le format attendu par le Worker
- [x]  Modifier le prompt Mistral pour ajouter un champ `theme` (parmi les 7 thématiques identifiées)
- [x]  Tester de bout en bout : lancer le pipeline, vérifier qu'un nouvel article arrive dans D1
- [x]  Garder le stockage JSON local et le mail en parallèle (ne rien casser)

**Résultat** : chaque article collecté par Node-RED est automatiquement poussé dans D1. Le pipeline existant continue de fonctionner normalement.

### Étape 6 — Reclassification thématique de l'historique

- [x]  Écrire un script qui parcourt les 270 articles dans D1
- [x]  Pour chaque article, appeler Mistral avec le titre + résumé et demander les thèmes
- [x]  Mettre à jour le champ `themes_mistral` dans D1
- [x]  Vérifier la distribution : combien d'articles par thème ?

**Résultat** : tous les articles (anciens et nouveaux) ont un champ `themes_mistral` renseigné.

---

## Phase 2 — API + Dashboard + CI/CD (Mai-Juin 2026)

L'objectif est d'exposer les données et de les visualiser, avec un pipeline de déploiement automatisé.

### Étape 7 — Worker API (endpoints de lecture)

- [x]  Ajouter les routes GET au Worker :
    - [x]  `GET /api/articles` — liste paginée avec filtres (date, thème, source, score)
    - [x]  `GET /api/stats/themes` — nombre d'articles par thème
    - [x]  `GET /api/stats/timeline` — volume d'articles par jour/semaine
        - [x]  Nécessite de convertir les dates du format RFC 822 vers ISO
    - [x]  `GET /api/stats/sources` — distribution par source
- [~]  Configurer le CORS (autoriser uniquement le domaine Vercel) — **contourné côté dashboard** : un proxy Nitro (routes serveur `server/api/*` depuis C3, `routeRules` à l'origine) rend tous les appels same-origin, donc le CORS n'est plus bloquant. À ajouter sur le Worker seulement si on veut un jour l'appeler en direct depuis le navigateur.
- [x]  Tester chaque endpoint avec curl
- [x]  Déployer

**Résultat** : une API REST fonctionnelle qui expose les données de D1.

### Étape 8 — Dashboard v1

### Plan

### Partie A — Socle

### A1. Initialiser Nuxt 4

- [x]  Lancer le scaffolder (`nuxi init`), choisir pnpm
- [x]  Vérifier `nuxt: ^4.x` dans `package.json`
- [x]  `pnpm dev` → page de démo sur `localhost:3000`
- [x]  Comprendre la structure générée : `app.vue`, `nuxt.config.ts`, dossier `app/` (en Nuxt 4 le code applicatif vit dans `app/` par défaut — c'est le changement majeur vs Nuxt 3)

**Concepts à creuser :** structure de dossiers Nuxt 4, rôle de `app.vue`, `nuxt.config.ts`.

### A2. Configurer l'accès à l'API Worker

- [x]  Définir l'URL de base du Worker dans la config — finalement en `runtimeConfig` **server-only** (pas `public`) : le client n'appelle jamais le Worker en direct, tout passe par le proxy Nitro `/api`. L'URL reste donc côté serveur.
- [x]  Comprendre pourquoi une URL d'API publique va dans `runtimeConfig.public` et pas en dur — et pourquoi, ici, le pattern proxy (BFF) la garde côté serveur

**Concepts :** `runtimeConfig`, variables d'environnement (`.env` + `NUXT_PUBLIC_...`), proxy Nitro / pattern BFF.

### A3. Composable de fetch

- [x]  Créer un composable (dossier `composables/`, auto-importé) (`createUseFetch`)
- [x]  Une fonction par route : articles, stats/themes, stats/sources, stats/timeline
- [x]  Typer les réponses TypeScript (interfaces `Article`, `ThemeStat`, `SourceStat`...) — tu as les shapes
- [x]  Choisir entre `useFetch` et `$fetch` et savoir pourquoi

**Concepts :** auto-imports des composables, différence `useFetch` (réactif, lié au cycle SSR, dédup) vs `$fetch` (appel impératif). Règle simple à valider : `useFetch` dans le `<script setup>` au chargement de page, `$fetch` pour un appel déclenché par une action (clic, changement de filtre).

---

### Partie B — Vues

### B0. Routing

- [x]  Comprendre le routing par fichiers : dossier `pages/` → routes automatiques
- [x]  Décider de ta structure : une page par vue (`/`, `/distribution`, `/tendances`) ou une seule page à onglets
- [x]  Si `pages/` est utilisé, `app.vue` doit contenir `<NuxtPage />`
- [x]  Navigation entre pages avec `<NuxtLink>`

**Concepts :** file-based routing, `<NuxtPage>`, `<NuxtLink>`, layouts (optionnel).

> **App shell + design system en place** (d'après le wireframe Claude Design) :
> - Layout `app/layouts/default.vue` — **sidebar** via les composants Dashboard de Nuxt UI
>   (`UDashboardGroup`/`UDashboardSidebar`/`UNavigationMenu`), responsive (slideover mobile),
>   appliqué via `<NuxtLayout>` dans `app.vue`.
> - Nav : **Articles** actif ; groupe STATISTIQUES (Thèmes/Sources/Timeline) **désactivé**
>   jusqu'à B2/B3 (pas de liens 404).
> - Design system : palette **emerald** (primary) + **slate** (neutral) dans `app.config.ts`,
>   mode **clair** verrouillé, typos **Space Grotesk** + **IBM Plex Mono** via `@nuxt/fonts`,
>   effet papier (`bg-muted` contenu / `bg-default` cartes).
> - Reste de B0 (pages `/distribution`, `/tendances`) à faire avec B2/B3.

### B1. Vue détail — table paginée + filtres

La plus simple, commence par elle car elle mappe directement `/api/articles`.

- [x]  Récupérer les articles via le composable
- [x]  Afficher dans un tableau (Nuxt UI `UTable`) — responsive : table sur desktop, vue cartes sur mobile
- [x]  Gérer les états : chargement (`pending`), erreur (`error`), vide
- [x]  Pagination : state local (page courante), passer les params à l'API, composant `UPagination`
- [x]  Filtres : `USelect` liés en `v-model` (thème, source, catégorie, score min.), refetch au changement + bouton réinitialiser
- [x]  Comprendre comment `useFetch` se re-déclenche quand un param réactif change (query réactive via `computed`)
- [x]  Ajouter une option "Nombre d'articles par page" (sélecteur de taille de page, ex. 10/25/50, lié au param `limit`)

**Concepts :** `ref`/`reactive`, `v-model`, `v-for`, rendu conditionnel `v-if`/`v-else`, réactivité du refetch.

> **Note** — pièges rencontrés et corrigés sur cette vue : réactivité (ne pas figer les données avec `ref(response.value?.data)`, utiliser un `computed`) ; Reka UI interdit `value: ''` sur un `SelectItem` (utiliser une sentinelle `'all'`) ; Tailwind v4 ne met plus `cursor: pointer` par défaut sur les éléments cliquables.

### B2. Vue distribution — répartition par source et par thème

- [x]  Installer `vue-chartjs chart.js` (maintenant)
- [x]  Créer un composant graphe réutilisable (enregistrer les éléments Chart.js : `ArcElement`, `Tooltip`, `Legend` pour un doughnut) — deux composants `app/components/charts/Doughnut.vue` + `Bar.vue`, enregistrement centralisé dans `register.ts`
- [x]  Mapper `{ data: [{ theme, count }] }` → format Chart.js (`labels`, `datasets`)
- [x]  Deux graphes : Doughnut par thème, Bar (horizontal) par source — page `app/pages/distribution.vue`
- [x]  Envelopper dans `<ClientOnly>` (SSR + canvas)

**Concepts :** props de composant, `computed` pour transformer les données API en structure Chart.js, `<ClientOnly>`.

### B3. Vue tendances — évolution dans le temps

- [x]  Consommer `/api/stats/timeline` (volume quotidien)
- [x]  Graphe en ligne (`Line`, enregistrer `LineElement`, `PointElement`, `CategoryScale`, `LinearScale`)
- [x]  Mapper dates → axe X, counts → axe Y
- [x]  Même pattern `computed` + `<ClientOnly>`

**Concepts :** réutilisation du composant graphe, gestion de l'axe temporel.

---

### Partie C — Authentification (accès protégé)

Objectif : verrouiller l'accès au dashboard derrière une connexion. Un seul compte admin (toi), pas d'inscription publique. Comme le titre du projet est orienté sécurité, cette partie est l'occasion de démontrer des pratiques concrètes : hachage de mot de passe, sessions signées, cookies `HttpOnly`, protection des routes serveur.

> **Stack d'auth verrouillée** (décision « tout Cloudflare »)
> - **Où vit l'auth :** au niveau de **Nitro** (le serveur Nuxt), pas sur le Worker. Le dashboard passe déjà par un **proxy Nitro** (`/api/*`, pattern BFF) ; en mettant la session au même endroit, le cookie est **same-origin**, sans galère de cookies cross-domaine entre le domaine Pages du dashboard et `*.workers.dev`. Le Worker garde son token d'ingestion (KV `AUTH`) et n'a pas à connaître les utilisateurs.
> - **Base :** une **D1 dédiée à l'auth**, distincte de la base `veille-analytics` (articles), mais sur le **même compte Cloudflare**. On reste 100 % Cloudflare, et chaque repo possède proprement son schéma (pas de migrations croisées entre les deux repos).
> - **Accès à la base :** le dashboard étant hébergé sur **Cloudflare Pages** (cf. Partie D), il obtient un **binding D1 natif** — pas d'API REST à bricoler. Adaptateur **Kysely + `kysely-d1`** (léger, taillé pour D1).
> - **Package :** `better-auth` (le **cœur**, stable), monté dans une **route Nitro attrape-tout** (`server/api/auth/[...all]`). On écarte le module `@onmax/nuxt-better-auth` (encore en alpha) : plus de contrôle et de valeur pédagogique à câbler soi-même.

### C1. Installer et configurer Better Auth

- [x]  Installer les dépendances : `better-auth` (+ `wrangler`, `nitro-cloudflare-dev`, `@cloudflare/workers-types` en dev). **`kysely`/`kysely-d1` non nécessaires** : Better Auth 1.6 auto-détecte un binding D1 (méthodes `batch`/`exec`/`prepare`) et applique son dialect D1 interne.
- [~]  Déclarer le binding **D1** (`DB_AUTH`) dans le `wrangler.toml` du dashboard. **D1 distante reportée à la Partie D** (choix « local d'abord ») : dev sur SQLite locale `.wrangler/` émulée par `nitro-cloudflare-dev` ; `database_id` = placeholder jusqu'à `wrangler d1 create veille-auth`.
- [x]  Renseigner les secrets en `.env` (`NUXT_BETTER_AUTH_SECRET`, `NUXT_BETTER_AUTH_URL`) → mappés en `runtimeConfig` server-only ; `.env.example` créé, `.wrangler/` gitignoré.
- [x]  Configurer Better Auth (fabrique **par requête** `serverAuth(event)` dans `server/utils/auth.ts`, binding D1 lu sur `event.context.cloudflare.env`) + handler monté dans `server/api/auth/[...all].ts`.
- [x]  Générer (via `@better-auth/cli generate` contre une SQLite `node:sqlite` en mémoire) et appliquer les migrations des tables `user`, `session`, `account`, `verification` (`wrangler d1 migrations apply veille-auth --local`).
- [x]  Activer **uniquement** email + password (`emailAndPassword.enabled`), **inscription désactivée** (`disableSignUp: true`) — vérifié : sign-up → 400 `EMAIL_PASSWORD_SIGN_UP_DISABLED`.

**Concepts :** route serveur attrape-tout Nitro, binding D1 (accès natif Cloudflare, **par requête**), auto-détection D1 par Better Auth, migrations D1, `runtimeConfig` server-only pour les secrets.

> **Note C1** — pièges rencontrés et corrigés :
> - **Collision proxy** : la route-rule `/api/**` → Worker avalait aussi `/api/auth/**` (le proxy gagne sur la route-fichier, la spécificité ne suffit pas). Corrigé en restreignant le proxy aux préfixes analytics (`/api/articles`, `/api/articles/**`, `/api/stats/**`) et en laissant `/api/auth/**` au handler local. **(Obsolète depuis C3 : le proxy `routeRules` a été entièrement remplacé par des routes serveur explicites — cf. Note C3 — cette collision n'existe plus.)**
> - **Splat vide** : `/api/articles/**` ne matche pas `/api/articles` exact → ajouter la règle exacte `/api/articles` en plus du wildcard.
> - **Transactions D1** : le gotcha des vieilles versions (better-auth #4732) n'existe plus en 1.6 — `transaction` vaut déjà `false` par défaut pour l'adaptateur Kysely.
> - **Génération migrations** : la CLI Better Auth ne voit pas le binding D1 → schéma généré contre `node:sqlite` (intégré à Node 24, zéro dép native), SQL directement applicable à D1. Script `pnpm auth:generate`.

### C2. Page de connexion + état de session

- [x]  Créer le client d'auth (`createAuthClient` de **`better-auth/vue`** — variante Vue avec `useSession` réactif) dans `app/composables/useAuth.ts` (singleton, same-origin `/api/auth`)
- [x]  Page `/login` : **`UAuthForm`** (Nuxt UI 4.9 — gère champs/validation/bouton loading) dans une carte centrée, `layout: false` (pas de sidebar)
- [x]  Connexion via `authClient.signIn.email(...)`, redirection vers `/` au succès, erreur affichée dans un `UAlert` (message générique sur `INVALID_EMAIL_OR_PASSWORD`)
- [x]  Afficher l'utilisateur connecté + bouton **Déconnexion** dans la sidebar (`useSession()` + `signOut()`), enveloppé dans `<ClientOnly>` (session hydratée côté client)
- [x]  Rediriger un visiteur déjà connecté hors de `/login` (`watchEffect` sur `session.data`)

**Concepts :** client Better Auth (`createAuthClient` version Vue), session réactive (`useSession`), appels `signIn` / `signOut`, redirections sûres, `<ClientOnly>` (mismatch d'hydratation).

> **Note C2** — vérifié **sans login réussi** (compte différé à C4) : rendu de `/login` (formulaire, sans sidebar), dashboard `/` intact, aucune erreur/mismatch d'hydratation. Le happy-path (login OK → footer avec email → déconnexion) sera validé après le seed C4. `UForm`/`UInput` du plan initial remplacés par `UAuthForm` (plus haut niveau, existe en v4.9).

### C3. Protéger les routes (le point critique sécurité)

- [x]  Protéger **les pages** : middleware Nuxt global `app/middleware/auth.global.ts`, **client-only** (`import.meta.server` return — le client Better Auth n'a pas d'URL absolue), qui `await useAuth().getSession()` et redirige vers `/login` (sauf `/login`).
- [x]  Protéger **le proxy `/api/*`** : la vérif se fait dans des **routes serveur explicites** (`server/api/articles/*`, `server/api/stats/*`) via un util `proxyToWorker` (`server/utils/proxyWorker.ts`) qui appelle `serverAuth(event).api.getSession({ headers })`, renvoie **401** si absente, sinon `proxyRequest` vers le Worker. Le proxy `routeRules` a été **supprimé** de `nuxt.config.ts`.
- [x]  Vérifié : `curl` non authentifié → **401** sur `/api/articles`, `/api/stats/themes`, `/api/stats/sources` ; `/api/auth/get-session` et les pages restent **200**.

**Concepts :** middleware Nuxt (route côté client/SSR), routes serveur Nitro + `proxyRequest`, vérification de session serveur (`auth.api.getSession`). Idée clé : **protéger l'UI ne suffit pas, il faut protéger la donnée**.

> **Note C3** — piège majeur : un proxy `routeRules` (`{ proxy }`) **court-circuite** aussi bien un `server/middleware/` qu'un hook Nitro `request` — le proxy s'exécute avant, et un `throw` dans le hook `request` est **avalé** (testé : la route restait 200). Impossible d'intercepter l'auth « autour » d'une route-rule proxy. Solution : **abandonner le proxy `routeRules`** et le reconstruire en **routes serveur explicites** (handlers `defineEventHandler`) où `throw createError(401)` bloque réellement l'appel au Worker. Deux fichiers par ressource pour couvrir base + sous-chemins (`articles/index.ts` + `articles/[...path].ts`), car un splat `[...path]` ne matche pas le chemin exact. Défense **default-deny** conservée : chaque handler passe par `proxyToWorker` qui vérifie la session en premier. Happy-path connecté (200 avec cookie) différé au seed C4.

### C4. Créer le compte admin (seed)

- [x]  Inscription fermée → compte créé via une **route de seed temporaire** `server/api/_seed-admin.post.ts` (dev-only, instance Better Auth jetable avec inscription activée, `signUpEmail`), **supprimée après usage**. Identifiants lus depuis `.env` (`SEED_ADMIN_EMAIL`/`PASSWORD`), retirés ensuite.
- [x]  Vérifié : `account.password` est un **hash** scrypt (format `salt:hash`, 161 car.), pas de clair. Chaîne complète validée : login → **200** + cookie `HttpOnly; SameSite=Lax` ; `/api/articles` avec cookie → **200**, sans cookie → **401**.

**Concepts :** seed, hachage (scrypt/argon2 selon Better Auth), moindre privilège (pas de signup public).

> **Note C4** — `getPlatformProxy()` (wrangler), la voie standard d'un script de seed standalone pour accéder au binding D1 hors requête, **se bloque dans ce WSL** (jamais résolu, tué à 45s/120s). D'où le choix de la **route temporaire** (binding D1 en contexte de requête, chemin déjà prouvé). `wrangler d1 execute --local`, lui, fonctionne (utilisé pour vérifier le hash). Config app `disableSignUp: true` **inchangée** ; la route jetable utilise sa propre instance. Seed **prod** (Part D) : même approche mais garde par **token** (`import.meta.dev` bloque en prod).

### C5. Durcissement

- [x]  Cookies de session `HttpOnly` + `SameSite=Lax` **vérifiés** (en-tête `Set-Cookie` au login C4/C5). `Secure` : absent en dev (http local, normal), **auto en prod** (Better Auth l'active sur `baseURL` https) → à re-confirmer une fois déployé (Part D).
- [x]  **Rate limiting activé** (`rateLimit: { enabled: true, storage: 'database' }` dans `server/utils/auth.ts`). Règle stricte **intégrée** anti-brute-force sur `/sign-in`, `/sign-up`, `/change-password`, `/change-email` : **max 3 / 10s**. Vérifié : 3× 401 puis **429** à la 4e tentative ; compteur persisté en table D1 `rateLimit` puis expire (login légitime non bloqué au-delà de la fenêtre). `storage: 'database'` **obligatoire** sur Cloudflare (mémoire non partagée entre isolates). Migration `migrations/0002_rate_limit.sql`.
- [x]  **CSRF vérifiée** : Better Auth compare l'`Origin` aux `trustedOrigins` (= `baseURL`). Testé : `Origin: http://evil.com` → **403 `INVALID_ORIGIN`** ; `Origin: localhost` accepté. En prod, `NUXT_BETTER_AUTH_URL` = domaine de prod suffit.
- [x]  **Surface d'attaque relue** : aucun `runtimeConfig.public` (secrets `betterAuthSecret`/`workerBaseUrl`/`betterAuthUrl` **server-only**, zéro référence dans `app/`) ; routes données `/api/articles` + `/api/stats/*` → 401 sans session ; `/api/auth/*` public par design ; route de seed C4 supprimée.

**Concepts :** attributs de cookie, brute-force / rate limit (storage D1 vs mémoire en serverless), CSRF (contrôle d'origine), revue de surface d'attaque.

> **Note C5** — le rate limit Better Auth est par défaut `storage: 'memory'` et `enabled: isProduction`. Sur Cloudflare (isolates éphémères et non partagés), la mémoire rend le compteur contournable → on force `storage: 'database'` (table `rateLimit`, générée via `pnpm auth:generate` puis extraite en `0002_rate_limit.sql`) et `enabled: true` (actif aussi en dev, pour tester). `scripts/auth-generate.ts` reflète ce `rateLimit` pour rester en phase. Cookies `Secure` et CSRF sont des **défauts** Better Auth (rien à coder), juste vérifiés.

**Résultat** : le dashboard est inaccessible sans connexion — **pages et API**. Un seul compte admin, mot de passe haché, sessions signées same-origin. Une base concrète pour argumenter la partie sécurité du M3.2.

---

### Partie D — Déploiement

> **Pivot Pages → Workers (2026-07-12)** : le projet Cloudflare a été créé en **Workers Builds**
> (déploiement via `npx wrangler deploy`), incompatible avec une sortie Pages. Plutôt que de
> recréer un projet Pages, on a **adopté la cible Workers** (direction recommandée par Cloudflare
> aujourd'hui) : preset Nitro `cloudflare_module`, `main` + `[assets]` dans `wrangler.toml`. Le
> binding D1 et les variables restent identiques. URL de prod : `*.workers.dev` (pas `*.pages.dev`).

### D1. Préparer le repo

- [x]  `veille-dashboard` versionné sur GitHub (repo dédié `antoinecoulon/veille-dashboard`)
- [x]  `.env` dans `.gitignore`, aucun secret commit (vérifié : seuls `.env.example` + config)

### D2. Cloudflare Workers (Workers Builds)

- [x]  Preset Nitro `cloudflare_module` dans `nuxt.config.ts` + `wrangler.toml` (`main` + `[assets]`)
- [x]  Binding **D1 auth** (`DB_AUTH`) + flag `nodejs_compat` dans `wrangler.toml` (avec le vrai `database_id`)
- [x]  Créer le projet Workers et **connecter le repo GitHub** → auto-deploy sur push
- [x]  `NUXT_WORKER_BASE_URL` (renommée depuis `NUXT_PUBLIC_...`) déclarée en **`[vars]`** du `wrangler.toml` (sinon effacée à chaque `wrangler deploy`), lue au runtime sur **`event.context.cloudflare.env`** par `proxyToWorker`
- [x]  `NUXT_BETTER_AUTH_SECRET` (**secret**, persiste) + `NUXT_BETTER_AUTH_URL` (en `[vars]`), lus aussi sur `event.context.cloudflare.env` (`auth.ts`). La base auth passe par le binding `DB_AUTH`.
- [x]  Service binding **`ANALYTICS`** → Worker `veille-analytics` (proxy Worker→Worker, cf. pièges ci-dessous)
- [x]  Migrations d'auth sur la D1 distante (`pnpm db:migrate:remote` → `0001` + `0002`, 5 tables)
- [x]  Déploiement vérifié end-to-end : login OK, **articles affichés**, `/api/*` 401 sans session, CSRF 403
- [~]  CORS — **non nécessaire** grâce au proxy Nitro (appels same-origin). À ne reconsidérer que si on appelle le Worker en direct depuis le client.

**Piège rencontré** : `pnpm-workspace.yaml` ne contenait qu'une clé `allowBuilds` non standard
(ignorée par pnpm) et **sans champ `packages`** → l'image de build Cloudflare (pnpm 10.11) échoue
« packages field missing or empty ». Corrigé : suppression du fichier (repo mono-package),
allowlist des build scripts via `pnpm.onlyBuiltDependencies`, `packageManager` épinglé.

**Seed admin (D4)** : inscription fermée → hash scrypt généré **en local** par Better Auth
(`better-auth/crypto`, `scripts/seed-admin-sql.mjs`), inséré sur la D1 distante via
`wrangler d1 execute --remote`. Mécanisme validé end-to-end en local (login 200 + cookie).

**4 pièges runtime en prod** (le login marchait mais « Erreur lors du chargement des données » ;
chacun cachait le suivant — bon matériau Check/Act pour le M3.2) :
1. **`useFetch` fetchait en SSR** alors que l'auth est **client-only** (middleware `return` côté
   serveur) → requête SSR sans cookie de session. Fix : `server: false` sur le composable
   (`app/composables/useVeilleApi.ts`) → fetch côté navigateur, qui porte le cookie.
2. **`runtimeConfig` non alimenté au runtime sur le Worker** : les overrides `NUXT_*` ne
   remontent pas → `workerBaseUrl`/secret vides (500 « URL du Worker indisponible » ; Better Auth
   tombait même sur son secret par défaut = faille). Fix : lire sur `event.context.cloudflare.env`
   (comme `DB_AUTH`), `runtimeConfig` en repli dev (`proxyWorker.ts`, `auth.ts`).
3. **`wrangler deploy` efface les variables plaintext** posées au dashboard si absentes du
   `wrangler.toml` (le binding D1 et les secrets survivent, pas les vars texte). Fix : les
   déclarer en `[vars]`.
4. **Worker→Worker via `*.workers.dev` du même compte = erreur 1042.** Fix : **service binding**
   `ANALYTICS`, passé comme `fetch` à `proxyRequest` (h3 `ProxyOptions.fetch`) en prod.

Outils de diagnostic clés : `wrangler tail veille-dashboard` (a montré que `/api/articles`
partait en SSR, jamais côté client) et `wrangler deploy --dry-run` (bindings/vars réellement
déployés).

**Concepts :** preset Nitro `cloudflare_module` (Worker + Workers Assets), bindings D1
(`wrangler.toml`, `nodejs_compat`), variables d'env / secrets en production, proxy Nitro (BFF).

## BONUS

- [ ] Trouver un moyen de démarrer automatiquement et régulièrement la collecte d'articles (Node-RED) — **décision : déclenchement manuel conservé** (une passe/jour lancée à la main ; le coût d'un ordonnancement fiable — inject `interval` + persistance pm2/service, contrainte par une machine allumée par intermittence en WSL — ne se justifie pas pour l'instant)
- [x] Ajouter un favicon — favicon SVG propre au projet (tuile emerald + barres analytics)
- [x] Vérifier la documentation — schéma d'archi analytics corrigé (Workers, pas Pages) + Phase 2 cochée ; vues stats du dashboard notées comme livrées
- [x] PWA installable — `@vite-pwa/nuxt` (manifest + service worker), `<VitePwaManifest />` dans `app.vue` pour injecter le `<link rel="manifest">` en SSR ; icône = le favicon SVG

---

### Deux pièges déjà identifiés à ne pas oublier

- **Encodage** `DÃ©veloppement` : à corriger côté Worker (header `charset=utf-8` / double-encodage) avant que ça pollue les labels.
- **CORS** : ~~ton Worker devra autoriser l'origine du dashboard en prod~~ → **résolu** via proxy Nitro côté dashboard (tous les appels sont same-origin, plus de CORS à gérer en dev comme en prod).

### Résumé de l'étape

- [x]  Initialiser un projet Nuxt.js
- [x]  Connecter au Worker API (composable `useFetch` ou `$fetch`)
- [x]  Vue tendances : graphique d'évolution par thème (librairie au choix : Chart.js, ou simple HTML/CSS)
- [x]  Vue distribution : répartition par source et par thème
- [x]  Vue détail : table paginée avec filtres (responsive desktop/mobile)
- [x]  Déployer sur Cloudflare **Workers** (repo GitHub connecté, déploiement automatique) — cf. Partie D

**Résultat** : un dashboard accessible en ligne qui visualise les données de veille.

### Étape 9 — GitHub Actions (CI/CD)

- [x]  Créer `.github/workflows/ci.yml` — **un workflow par dépôt** (deux repos Git distincts, pas de monorepo)
- [x]  `veille-analytics` : job `quality` (typecheck `tsc --noEmit` + lint ESLint) sur push + PR, puis job `deploy` (`wrangler deploy`) sur push `main` uniquement
- [x]  `veille-dashboard` : job `quality` (typecheck `nuxt typecheck` + lint) — **pas de deploy** : Cloudflare **Workers Builds** déploie déjà sur push (pivot Pages → Workers, cf. Partie D)
- [x]  Ajouter les secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (GitHub Actions) pour le déploiement du Worker
- [x]  Tester : PR sur les deux repos → `quality` au vert ; merge `veille-analytics` → `deploy` OK
- [ ]  Ajouter les tests au pipeline → **reporté à l'Étape 10** (aucun test n'existe encore ; `quality` = typecheck + lint pour l'instant)

**Résultat** : chaque push/PR déclenche typecheck + lint sur les deux dépôts ; un push sur `main` de `veille-analytics` déploie le Worker automatiquement (le dashboard, lui, via Workers Builds).

> **Note Étape 9** — pièges rencontrés et corrigés :
> - **Un workflow par repo, pas un `deploy.yml` unique** : ce sont deux dépôts Git distincts → deux `ci.yml`. Le plan initial (« lint → tests → deploy » dans un seul fichier) supposait un monorepo.
> - **Pas de job deploy pour le dashboard** : il se déploie déjà via Workers Builds (intégration Git Cloudflare). Le dupliquer dans Actions créerait un double déploiement concurrent.
> - **TypeScript 6 vs 7** : l'outillage Nuxt résout le peer `typescript` vers 7.0.2, que `typescript-eslint` 8.63 ne sait pas encore parser (`eslint` crashe : `reading 'Cjs'`). Corrigé par `pnpm.overrides` → `typescript: 6.0.3` dans le dashboard.
> - **Token Cloudflare** : le job `deploy` a d'abord échoué (`code 9109 Invalid access token`). Le secret `CLOUDFLARE_API_TOKEN` doit contenir un **API Token** valide (modèle « Edit Cloudflare Workers », collé sans espace) — pas la *Global API Key* ; wrangler fait aussi des appels `/accounts` + *User settings* au démarrage, que ce modèle couvre.

### Étape 10 — Tests

- [x]  Installer Vitest (+ `@cloudflare/vitest-pool-workers` pour une vraie D1 Miniflare)
- [x]  Extraire la normalisation en fonctions pures (`src/lib/normalize.ts`) pour la tester
- [x]  Tests unitaires : normalisation **tags** et **dates** + parse des lignes (`test/normalize.test.ts`)
- [x]  Tests d'intégration : piloter `export default.fetch` sur D1 réelle — auth, validation,
  ingest, lecture, **dédoublonnage**, stats themes/sources/timeline (`test/api.test.ts`)
- [x]  Ajouter `pnpm test` au job `quality` du pipeline GitHub Actions
- [x]  Vérifier que le pipeline échoue si un test casse (prouvé : assertion cassée → exit 1)

> **Note Étape 10** — précisions vs plan initial :
> - Le **dédoublonnage n'a aucune logique JS** : c'est `INSERT OR IGNORE` sur la contrainte
>   `url TEXT NOT NULL UNIQUE`. Il se teste donc en **intégration D1** (insérer 2× la même url →
>   1 ligne), pas en unitaire.
> - Les endpoints stats utilisent des fonctions SQLite (`json_each`, `strftime`) → mock D1
>   impraticable, d'où `@cloudflare/vitest-pool-workers` (Miniflare, vraie SQLite).
> - Config en **`vitest.config.mts`** (le pool est ESM-only, le repo est CommonJS), D1 en
>   **schéma seul** (migration `0001` filtrée) pour ne pas fausser les comptages.
> - Amélioration CI au passage : **`paths-ignore`** (`**.md`, `docs/**`) → un changement de doc
>   seul ne relance plus CI + deploy.

**Résultat** : une base de tests (17) qui tourne à chaque push/PR ; le pipeline échoue si un
test casse.

### Étape 11 — Terraform (IaC)

- [x]  Installer Terraform CLI
- [x]  Écrire la configuration : provider Cloudflare v5, ressources **durables** — D1 articles (`veille-analytics`) **+ D1 auth** (`veille-auth`, dashboard) **+ KV** (`AUTH`). Le **code des Workers** est hors périmètre (géré par wrangler / Workers Builds — voir Note).
- [x]  Importer les ressources existantes (`terraform import`) — aucune création
- [x]  Vérifier : `terraform plan` ne montre aucun changement (l'état correspond à ce qui existe)
- [x]  Documenter : un README qui explique comment recréer l'infra from scratch

**Résultat** : l'infrastructure durable est décrite en code (`veille-analytics/terraform/`). `terraform apply` recrée les bases D1 et le KV.

> **Note Étape 11** — Découpage IaC / CD assumé
>
> - **Périmètre = infra durable seulement** (2 D1 + 1 KV). Le *code* des Workers reste déployé
>   par **wrangler / Cloudflare Workers Builds**, pas par Terraform. Gérer
>   `cloudflare_workers_script` en IaC créerait un **drift permanent** : chaque `wrangler deploy`
>   réécrit la ressource → deux propriétaires → `terraform plan` jamais propre. Pattern d'archi :
>   **Terraform = infra durable, CI/CD = déploiement applicatif**, un seul propriétaire par ressource.
> - Le point de départ mentionnait un « **projet Pages** » pour le dashboard : **obsolète** depuis
>   le pivot Pages → Workers (Partie D). Le dashboard est un **Worker** → hors périmètre Terraform.
> - **Import sans création** : les ressources existaient déjà ; on les rattache à l'état. Piège
>   réconcilié pour un `plan` propre : les D1 exigent `read_replication = { mode = "disabled" }`
>   explicite dans le HCL, sinon Terraform propose un faux diff.
> - **État local** (`terraform.tfstate` gitignored), `account_id` via `terraform.tfvars` non
>   versionné, auth du provider via `$CLOUDFLARE_API_TOKEN`, lock du provider committé. En équipe,
>   on migrerait vers un backend distant (R2). Les **migrations D1 restent appliquées par wrangler**.

---

## Phase 3 — ML + Analytics (Juillet-Août 2026)

L'objectif est de déployer un modèle ML, le comparer à Mistral, et enrichir le dashboard.

### Étape 12 — Annotation manuelle

- [ ]  Exporter ~100 articles depuis D1 (diversifiés en thèmes et sources)
- [ ]  Pour chaque article, attribuer manuellement les thèmes corrects (ground truth)
- [ ]  Format simple : CSV avec colonnes `id, themes_manuels`
- [ ]  Importer dans D1 ou garder en fichier séparé pour l'évaluation

**Résultat** : un jeu de validation indépendant de Mistral.

### Étape 13 — Déploiement zero-shot sur Hugging Face

- [ ]  Créer un Space sur Hugging Face (Gradio ou FastAPI)
- [ ]  Charger un modèle zero-shot (ex. `MoritzLaurer/deberta-v3-base-zeroshot-v2`)
- [ ]  Endpoint : reçoit titre + résumé, retourne les probabilités par thème
- [ ]  Tester sur quelques articles manuellement
- [ ]  Comparer avec les annotations manuelles : calculer la précision

**Résultat** : un modèle ML accessible via API qui classifie les articles par thème.

### Étape 14 — Intégration ML dans le pipeline

- [ ]  Modifier le Worker : après ingestion, appeler le Space HF pour obtenir les thèmes ML
- [ ]  Stocker les résultats dans D1 (`themes_ml`, `score_confiance_ml`)
- [ ]  Gérer le cas où le Space est en veille (cold start, retry)
- [ ]  Vérifier sur quelques articles que les deux classifications (Mistral et ML) sont bien présentes

**Résultat** : chaque article a une double classification : Mistral + ML.

### Étape 15 — Dashboard v2 (vue ML)

- [ ]  Ajouter la vue comparaison ML : accord/désaccord Mistral vs ML par thème
- [ ]  Afficher le taux de concordance global
- [ ]  Possibilité de filtrer les articles où ML et Mistral sont en désaccord
- [ ]  Ajouter un filtre "Machine Learning" sur la vue détail (table) pour exploiter les props ML : `themes_ml`, `score_confiance_ml` (ex. filtrer par thème ML, seuil de confiance min., présence/absence de classification ML) + colonnes correspondantes dans la table

**Résultat** : le dashboard montre visuellement la comparaison entre les deux approches.

### Étape 16 — PySpark (batch local)

- [ ]  Exporter les données de D1 en CSV
- [ ]  Écrire un script PySpark : fréquences par thème, cooccurrences de tags, tendances par fenêtre glissante
- [ ]  Exécuter localement, sauvegarder les résultats en CSV
- [ ]  Documenter le script et les résultats

**Résultat** : compétence C29 couverte. Résultats exploitables pour le M3.2.

### Étape 17 (optionnelle) — Fine-tuning

- [ ]  Si le volume de données est suffisant (~500+ articles) et si le temps le permet
- [ ]  Préparer le dataset d'entraînement (titre + résumé → thèmes Mistral comme labels)
- [ ]  Fine-tuner un petit modèle (DistilBERT ou CamemBERT-base)
- [ ]  Évaluer sur le jeu annoté manuellement
- [ ]  Comparer : zero-shot vs fine-tuné vs Mistral
- [ ]  Documenter les résultats, même négatifs

**Résultat** : une expérimentation documentée. Succès ou échec, c'est valorisable.

---

## Phase 4 — Finalisation (Sept-Nov 2026)

L'objectif est de produire les preuves et la documentation pour le M3.2.

### Étape 18 — Captures et preuves

- [ ]  Screenshots horodatés : dashboard, Cloudflare, GitHub Actions, HF Spaces
- [ ]  Enregistrement vidéo d'une démo complète (article collecté → D1 → dashboard)
- [ ]  Export des métriques : KPI avant/après (régularité collecte, concordance ML, couverture tests)
- [ ]  Sauvegarder le `terraform plan` comme preuve d'IaC

**Résultat** : un dossier de preuves solide, utilisable même si un service tombe avant la soutenance.

### Étape 19 — Documentation

- [ ]  README du repo : installation, architecture, déploiement
- [ ]  Documentation API : endpoints, paramètres, exemples de réponses
- [ ]  Section "Usage d'IA" pour le rapport (Claude et Mistral)

**Résultat** : documentation technique complète.

### Étape 20 — Rédaction M3.2

- [ ]  Reprendre la démarche PDCA avec les vrais chiffres
- [ ]  Plan : situation initiale (métriques du diagnostic)
- [ ]  Do : ce qui a été fait, couche par couche
- [ ]  Check : KPI mesurés, comparaison avant/après
- [ ]  Act : ajustements, limites, projections
- [ ]  Relecture et finalisation

**Résultat** : le rapport d'amélioration continue, prêt pour le M3.

---

## Résumé visuel

```
Mars          Avril         Mai           Juin          Juillet       Août          Sept          Oct-Nov
|-------------|-------------|-------------|-------------|-------------|-------------|-------------|
 Setup         Node-RED      API           Dashboard     Annotation    ML intégré    Captures      M3.2
 D1            adapté        endpoints     v1            manuelle      Dashboard v2  Documentation Soutenance
 Migration     Worker ETL    CI/CD         Terraform     Zero-shot     PySpark       Preuves
 270 articles  Reclassif.    Tests                       HF Spaces     (Fine-tuning)
```