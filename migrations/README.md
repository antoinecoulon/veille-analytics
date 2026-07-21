# migrations/ — schéma uniquement

Ce dossier ne contient que des migrations de **schéma** : `CREATE TABLE`, `CREATE INDEX`,
`ALTER TABLE`. Elles s'appliquent à **tous** les environnements, dans l'ordre, par la commande
standard :

```bash
npx wrangler d1 migrations apply veille-analytics --local    # base locale
npx wrangler d1 migrations apply veille-analytics --remote   # production
```

Wrangler enregistre chaque fichier appliqué dans la table `d1_migrations` de la base concernée.
**Cette table est la source de vérité de l'état d'un environnement** — pas la mémoire de celui qui
a lancé les commandes.

## Ce qui n'a pas sa place ici

Les correctifs de **données** — jeu de démonstration, reclassifications ponctuelles, normalisations
rétroactives — vivent dans [`../scripts/sql-ponctuels/`](../scripts/sql-ponctuels/). Ce sont des
scripts à jouer une fois, sur un environnement choisi, en connaissance de cause :

```bash
npx wrangler d1 execute veille-analytics --local --file scripts/sql-ponctuels/dev_seed.sql
```

## Pourquoi cette séparation

Trois correctifs de données (`dev_seed`, `dev_reclassify_themes`, `dev_normalize_dates`) ont
longtemps porté des numéros de migration, `0002` à `0004`, tout en n'étant destinés qu'à la base
locale. Ils n'ont jamais été appliqués en production, où `d1_migrations` ne contenait que
`0001_init.sql`.

Le danger était que **la commande documentée était la commande dangereuse** : `README.md` et
`terraform/README.md` prescrivent tous deux `wrangler d1 migrations apply --remote`, qui aurait
inséré un jeu de démonstration et écrasé des thématiques dans la base de production, puisque
wrangler considère comme « à appliquer » tout fichier absent du registre.

Le contournement pratiqué jusqu'ici — appliquer les migrations de schéma à la main avec
`--file` — évitait l'accident mais aggravait la cause : le registre s'éloignait un peu plus de
la réalité à chaque fois. C'est ainsi que `0002_perf_indexes.sql` (C24) s'est retrouvé appliqué
en production sans y être enregistré, avant d'être réconcilié par la commande standard, son
`IF NOT EXISTS` rendant l'opération neutre.

La règle qui en découle tient en une phrase : **si un fichier de ce dossier ne peut pas être
appliqué sans réfléchir à tous les environnements, il n'a rien à y faire.**

## Ce que voit la suite de tests

`vitest.config.mts` charge ce dossier tel quel, sans filtrer : les tests d'intégration tournent
donc sur exactement le schéma de production. Auparavant un filtre écartait les migrations de
données ; il n'a plus lieu d'être, et sa disparition supprime aussi le risque qu'il laissait
passer — un correctif de données mal nommé se serait appliqué dans les tests et aurait faussé
les assertions de comptage.
