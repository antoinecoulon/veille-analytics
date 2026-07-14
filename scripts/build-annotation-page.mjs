// Étape 12 — Génère une page HTML autonome d'annotation manuelle.
//
// Entrées :
//   data/annotation_sample.json      (contexte : id, titre, resume, source, url)
//   data/annotation_suggestions.json (suggestions aveugles de Claude : id -> themes[])
//
// Sortie : annotation/index.html — page 100 % offline (données + CSS + JS inline,
// aucune requête réseau), ouvrable en file://. L'utilisateur révise les cases
// pré-cochées puis exporte annotations.csv (id, themes_manuels ; thèmes |-séparés).
//
// IMPORTANT : themes_mistral n'apparaît nulle part dans la page (revue non ancrée).
//
// Usage : node scripts/build-annotation-page.mjs

import fs from "node:fs"

const SAMPLE_PATH = "./data/annotation_sample.json"
const SUGGEST_PATH = "./data/annotation_suggestions.json"
const OUT_DIR = "./annotation"
const OUT_PATH = `${OUT_DIR}/index.html`

const THEMES = [
  "IA/ML", "DevOps/Infrastructure", "Architecture", "Sécurité",
  "Développement", "Pratiques/Qualité", "Productivité/Outils",
]

// Sérialise en JSON sûr à inliner dans <script> (neutralise </script>).
function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

function main() {
  const sample = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf-8"))
  const suggestions = JSON.parse(fs.readFileSync(SUGGEST_PATH, "utf-8"))

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Annotation manuelle — VeilleAnalytics (Étape 12)</title>
<style>
  :root {
    --bg: #f5f5f4; --card: #ffffff; --border: #e7e5e4; --text: #1c1917;
    --muted: #78716c; --primary: #059669; --primary-soft: #d1fae5;
    --accent: #0f766e; --shadow: 0 1px 2px rgba(0,0,0,.06);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: "Space Grotesk", system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    line-height: 1.5;
  }
  header {
    position: sticky; top: 0; z-index: 10; background: var(--card);
    border-bottom: 1px solid var(--border); padding: .75rem 1rem; box-shadow: var(--shadow);
  }
  .bar { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.05rem; margin: 0; margin-right: auto; }
  .progress-wrap { flex: 1 1 180px; min-width: 160px; }
  .progress { height: 8px; background: var(--border); border-radius: 999px; overflow: hidden; }
  .progress > i { display: block; height: 100%; background: var(--primary); width: 0%; transition: width .2s; }
  .progress-label { font-size: .78rem; color: var(--muted); margin-top: .2rem; }
  button {
    font: inherit; border: 1px solid var(--border); background: var(--card); color: var(--text);
    padding: .45rem .8rem; border-radius: 8px; cursor: pointer;
  }
  button.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
  button:hover { filter: brightness(.97); }
  label.chk { display: inline-flex; gap: .35rem; align-items: center; font-size: .82rem; cursor: pointer; }
  main { max-width: 900px; margin: 1rem auto; padding: 0 1rem 4rem; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 1rem; margin-bottom: 1rem; box-shadow: var(--shadow);
  }
  .card.reviewed { border-color: var(--primary); background: linear-gradient(0deg, var(--primary-soft) 0%, #fff 6%); }
  .card-head { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; }
  .idx { font-family: "IBM Plex Mono", ui-monospace, monospace; color: var(--muted); font-size: .8rem; }
  .card h2 { font-size: 1rem; margin: 0; flex: 1 1 auto; }
  .src { font-size: .72rem; background: var(--border); color: var(--muted); padding: .1rem .5rem; border-radius: 999px; white-space: nowrap; }
  .resume { color: var(--text); font-size: .9rem; margin: .5rem 0 .6rem; }
  .url { font-size: .78rem; color: var(--accent); word-break: break-all; }
  .themes { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .7rem; }
  .themes label {
    display: inline-flex; gap: .4rem; align-items: center; font-size: .84rem;
    border: 1px solid var(--border); border-radius: 999px; padding: .28rem .7rem; cursor: pointer; user-select: none;
  }
  .themes label:has(input:checked) { background: var(--primary-soft); border-color: var(--primary); color: var(--accent); font-weight: 600; }
  .card-foot { margin-top: .8rem; display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
  .card-foot .review { font-weight: 600; }
  .empty-warn { color: #b91c1c; font-size: .78rem; }
  .hint { color: var(--muted); font-size: .82rem; margin: .3rem 0 1rem; }
</style>
</head>
<body>
<header>
  <div class="bar">
    <h1>Annotation manuelle · <span id="count"></span></h1>
    <div class="progress-wrap">
      <div class="progress"><i id="pbar"></i></div>
      <div class="progress-label" id="plabel"></div>
    </div>
    <label class="chk"><input type="checkbox" id="hideReviewed"> Masquer les revus</label>
    <button id="exportBtn" class="primary">Exporter CSV</button>
    <button id="resetBtn" title="Réinitialiser toutes les annotations">Réinitialiser</button>
  </div>
</header>
<main>
  <p class="hint">
    Les thèmes pré-cochés sont des <strong>suggestions</strong> (classification à l'aveugle, sans la
    prédiction Mistral). Corrige-les, puis coche <strong>« Revu »</strong> pour suivre ta progression.
    Tout est sauvegardé automatiquement dans ce navigateur. Quand tu as fini, clique
    <strong>Exporter CSV</strong> et dépose le fichier dans <code>data/annotations.csv</code>.
  </p>
  <div id="list"></div>
</main>

<script>
const THEMES = ${inlineJson(THEMES)};
const DATA = ${inlineJson(sample)};
const SUGGEST = ${inlineJson(suggestions)};
const STORAGE_KEY = "veille-annotation-v1";

// État : { "<id>": { themes: string[], reviewed: bool } }
function loadState() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { saved = {}; }
  const state = {};
  for (const a of DATA) {
    const prev = saved[a.id];
    state[a.id] = prev
      ? { themes: prev.themes || [], reviewed: !!prev.reviewed }
      : { themes: (SUGGEST[a.id] || []).slice(), reviewed: false };
  }
  return state;
}
const state = loadState();
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

const listEl = document.getElementById("list");
const hideReviewed = document.getElementById("hideReviewed");

function render() {
  document.getElementById("count").textContent = DATA.length + " articles";
  listEl.innerHTML = "";
  DATA.forEach((a, i) => {
    const st = state[a.id];
    if (hideReviewed.checked && st.reviewed) return;
    const card = document.createElement("div");
    card.className = "card" + (st.reviewed ? " reviewed" : "");

    const chips = THEMES.map((t) => {
      const on = st.themes.includes(t) ? "checked" : "";
      return '<label><input type="checkbox" data-id="' + a.id + '" value="' + t + '" ' + on + '>' + t + "</label>";
    }).join("");

    card.innerHTML =
      '<div class="card-head">' +
        '<span class="idx">#' + (i + 1) + " · id " + a.id + "</span>" +
        "<h2>" + esc(a.titre) + "</h2>" +
        '<span class="src">' + esc(a.source) + "</span>" +
      "</div>" +
      '<p class="resume">' + esc(a.resume || "(pas de résumé)") + "</p>" +
      '<a class="url" href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.url) + "</a>" +
      '<div class="themes">' + chips + "</div>" +
      '<div class="card-foot">' +
        '<span class="empty-warn" data-warn="' + a.id + '"></span>' +
        '<label class="review chk"><input type="checkbox" data-review="' + a.id + '" ' + (st.reviewed ? "checked" : "") + "> Revu</label>" +
      "</div>";
    listEl.appendChild(card);
    updateWarn(a.id, card);
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function updateWarn(id, scope) {
  const el = (scope || document).querySelector('[data-warn="' + id + '"]');
  if (el) el.textContent = state[id].themes.length === 0 ? "Aucun thème sélectionné" : "";
}

function updateProgress() {
  const done = Object.values(state).filter((s) => s.reviewed).length;
  const pct = Math.round((done / DATA.length) * 100);
  document.getElementById("pbar").style.width = pct + "%";
  document.getElementById("plabel").textContent = done + " / " + DATA.length + " revus (" + pct + "%)";
}

listEl.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.id) {
    const id = t.dataset.id, set = new Set(state[id].themes);
    t.checked ? set.add(t.value) : set.delete(t.value);
    state[id].themes = THEMES.filter((x) => set.has(x));
    updateWarn(id);
    save();
  } else if (t.dataset.review) {
    const id = t.dataset.review;
    state[id].reviewed = t.checked;
    t.closest(".card").classList.toggle("reviewed", t.checked);
    save(); updateProgress();
    if (hideReviewed.checked && t.checked) render();
  }
});

hideReviewed.addEventListener("change", render);

document.getElementById("exportBtn").addEventListener("click", () => {
  const notReviewed = Object.values(state).filter((s) => !s.reviewed).length;
  const empty = DATA.filter((a) => state[a.id].themes.length === 0).map((a) => a.id);
  let msg = "";
  if (notReviewed) msg += notReviewed + " article(s) pas encore marqués « Revu ». ";
  if (empty.length) msg += empty.length + " article(s) sans aucun thème (id: " + empty.join(", ") + "). ";
  if (msg && !confirm(msg + "\\nExporter quand même ?")) return;

  const rows = ["id,themes_manuels"];
  for (const a of DATA) rows.push(a.id + "," + state[a.id].themes.join("|"));
  const blob = new Blob(["\\uFEFF" + rows.join("\\n") + "\\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = "annotations.csv";
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
});

document.getElementById("resetBtn").addEventListener("click", () => {
  if (!confirm("Réinitialiser toutes les annotations aux suggestions de départ ?")) return;
  localStorage.removeItem(STORAGE_KEY);
  const fresh = loadState();
  for (const k in fresh) state[k] = fresh[k];
  render(); updateProgress();
});

render();
updateProgress();
</script>
</body>
</html>
`

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT_PATH, html)
  console.log(`Page générée → ${OUT_PATH} (${sample.length} articles)`)
}

main()
