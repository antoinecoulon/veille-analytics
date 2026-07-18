// Classification zero-shot via l'Inference API serverless Hugging Face.
// Constantes portées de veille-ml/classifier.py (source de vérité du contrat ML :
// mêmes hypothèses FR, même template, même seuil que l'évaluation de l'Étape 13).

export const MODEL_ID = "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli"

// Libellés canoniques -> hypothèses descriptives FR (cf. scripts/reclassify.js
// et veille-dashboard/shared/utils/themes.ts pour la liste des 7 thèmes).
export const LABEL_MAP: Record<string, string> = {
  "IA/ML": "intelligence artificielle et machine learning",
  "DevOps/Infrastructure": "DevOps, cloud et infrastructure",
  "Architecture": "architecture logicielle et conception de systèmes",
  "Sécurité": "sécurité informatique et cybersécurité",
  "Développement": "développement logiciel et programmation",
  "Pratiques/Qualité": "pratiques d'ingénierie, tests et qualité logicielle",
  "Productivité/Outils": "productivité et outils pour développeurs",
}

const LABEL_INVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(LABEL_MAP).map(([theme, hypothesis]) => [hypothesis, theme])
)

export const CANDIDATE_LABELS = Object.values(LABEL_MAP)
export const HYPOTHESIS_TEMPLATE = "Cet article parle de {}."

// Point opérant retenu par l'évaluation (micro-F1 max, cf. veille-ml/eval_results.json).
export const ML_THRESHOLD = 0.7

const HF_URL = `https://router.huggingface.co/hf-inference/models/${MODEL_ID}`

// Bornées pour rester dans la fenêtre accordée aux tâches waitUntil (~30 s).
const RETRY_DELAYS_MS = [2000, 5000, 10000]

export interface MlClassification {
  // Thèmes canoniques dont le score sigmoïde >= ML_THRESHOLD (peut être vide).
  themes: string[]
  // Score du thème le mieux classé, même sous le seuil.
  confidence: number
}

// La réponse hf-inference suit le format du pipeline transformers
// ({ labels, scores } triés desc) ; la spec Inference Providers documente
// aussi la forme [{ label, score }] — on accepte les deux.
export function mapHfResponse(raw: unknown): MlClassification {
  let pairs: Array<{ label: unknown; score: unknown }> = []

  if (Array.isArray(raw)) {
    pairs = raw as Array<{ label: unknown; score: unknown }>
  } else if (raw && typeof raw === "object") {
    const { labels, scores } = raw as { labels?: unknown[]; scores?: unknown[] }
    if (Array.isArray(labels) && Array.isArray(scores)) {
      pairs = labels.map((label, i) => ({ label, score: scores[i] }))
    }
  }

  const scored = pairs.flatMap(({ label, score }) => {
    const theme = typeof label === "string" ? LABEL_INVERSE[label] : undefined
    return theme && typeof score === "number" ? [{ theme, score }] : []
  })

  if (scored.length === 0) {
    throw new Error(`Réponse HF inexploitable : ${JSON.stringify(raw).slice(0, 200)}`)
  }

  return {
    themes: scored.filter((s) => s.score >= ML_THRESHOLD).map((s) => s.theme),
    confidence: Math.max(...scored.map((s) => s.score)),
  }
}

export async function classifyArticle(
  titre: string,
  resume: string | null | undefined,
  token: string,
  retryDelaysMs: number[] = RETRY_DELAYS_MS
): Promise<MlClassification> {
  const body = JSON.stringify({
    inputs: `${titre}. ${resume ?? ""}`.trim(),
    parameters: {
      // En tableau : une hypothèse contient une virgule, pas de format CSV possible.
      candidate_labels: CANDIDATE_LABELS,
      hypothesis_template: HYPOTHESIS_TEMPLATE,
      multi_label: true,
    },
  })

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(HF_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    })

    if (res.ok) return mapHfResponse(await res.json())

    // 503 = modèle en chargement (cold start), 429 = rate limit : réessayables.
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= retryDelaysMs.length) {
      throw new Error(`Inference API HF ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]))
  }
}
