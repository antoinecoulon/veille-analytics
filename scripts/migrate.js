const fs = require("node:fs");

const articles = JSON.parse(fs.readFileSync("./data/articles_init.json", "utf-8"));

const escape = (str) => {
  if (str === null || str === undefined) return "NULL";
  return "'" + String(str).replace(/'/g, "''") + "'";
};

const lines = articles
  .filter((a) => a.title && a.link)
  .map((a) => {
    const titre = escape(a.title);
    const url = escape(a.link);
    const resume = escape(a.resume);
    const source = escape(a.source);
    const categorie = escape(a.categorie);
    const score = a.score ?? "NULL";
    const tags = escape(JSON.stringify(a.tags || []));
    const dateArticle = escape(a.date);
    const dateCollecte = escape(a.analyzedAt || new Date().toISOString());

    return `INSERT OR IGNORE INTO articles (titre, url, resume, source, categorie_mistral, score_mistral, tags, date_article, date_collecte)
VALUES (${titre}, ${url}, ${resume}, ${source}, ${categorie}, ${score}, ${tags}, ${dateArticle}, ${dateCollecte});`;
  });

fs.writeFileSync("./migrations/0002_seed.sql", lines.join("\n\n"));
console.log(`${lines.length} articles générés dans migrations/0002_seed.sql`);