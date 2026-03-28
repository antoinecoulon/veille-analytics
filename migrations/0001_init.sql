CREATE TABLE articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titre TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    resume TEXT,
    source TEXT NOT NULL,
    categorie_mistral TEXT,
    score_mistral INTEGER,
    themes_mistral TEXT,
    themes_ml TEXT,
    score_confiance_ml REAL,
    tags TEXT,
    date_article TEXT,
    date_collecte TEXT NOT NULL
);

CREATE TABLE dim_date (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_complete TEXT NOT NULL UNIQUE,
    annee INTEGER,
    mois INTEGER,
    semaine INTEGER,
    jour_semaine INTEGER
);

CREATE TABLE agg_quotidien (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    thematique TEXT,
    nb_articles INTEGER DEFAULT 0,
    score_moyen REAL
);