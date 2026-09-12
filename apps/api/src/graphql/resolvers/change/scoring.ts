/**
 * Pure scoring functions for the Change assessment process.
 *
 * Extracted from assessmentMutations.ts (task score) and helpers.ts
 * (CI risk, approval route) so they can be unit-tested without a Neo4j
 * session.
 *
 * Ondata 7 (B-14 / C-8): la priorita' della change non e' piu' una cascata di
 * `if` sui nomi di fabbrica ma la matrice `change_priority` del cliente
 * (tipo x fascia di rischio). Le funzioni di punteggio puro — fattore
 * d'ambiente, punteggio della domanda, rischio del CI, rotta d'approvazione —
 * restano sincrone e senza dipendenze.
 */
import { ValidationError } from '../../../lib/errors.js'
import { assertDomainValue, domainVocabulary } from '../../../lib/domainMatrix.js'
import { resolveDomainValue } from '../../../lib/domainValue.js'

export interface QuestionScore {
  /** rel.weight on (CITypeDefinition)-[:HAS_QUESTION]->(question), default 1 */
  weight: number
  /** score of the AnswerOption selected in the response */
  score: number
  /** max score across the question's AnswerOptions */
  maxScore: number
}

/**
 * Automatic environment factor (replaces the removed
 * "Is the production environment affected?" question):
 *   production → score 3 (max)
 *   staging    → score 1
 *   altro      → score 0
 */
export const ENV_WEIGHT = 5
export const ENV_MAX = 3

export function environmentScore(environment: string | null | undefined): number {
  return environment === 'production' ? 3 :
         environment === 'staging'    ? 1 :
                                        0
}

/**
 * Weighted assessment-task score, integer 0..100:
 *
 *   round( (Σ weight·score + ENV_WEIGHT·envScore)
 *        / (Σ weight·maxScore + ENV_WEIGHT·ENV_MAX) · 100 )
 *
 * The environment factor is always part of the pool, so the denominator is
 * never 0 and the result is never NaN. An empty question list is a caller
 * bug (the resolver refuses to complete a task without questions), so it
 * raises a ValidationError instead of returning a meaningless score.
 */
export function calculateTaskScore(
  questions: QuestionScore[],
  environment: string | null | undefined,
): number {
  if (questions.length === 0) {
    throw new ValidationError('Nessuna domanda di assessment: impossibile calcolare lo score')
  }
  let num = 0, den = 0
  for (const q of questions) {
    num += q.weight * q.score
    den += q.weight * q.maxScore
  }
  num += ENV_WEIGHT * environmentScore(environment)
  den += ENV_WEIGHT * ENV_MAX
  return Math.round((num / den) * 100)
}

/** CI risk = arithmetic mean (rounded to integer) of owner + support task scores. */
export function calculateCIRiskScore(ownerScore: number, supportScore: number): number {
  return Math.round((ownerScore + supportScore) / 2)
}

/**
 * approval_route of a Change from its aggregate risk score
 * (the MAX across the per-CI risk scores):
 *   ≤ 30 → 'low'  (frontend: Auto-approve)
 *   ≤ 60 → 'medium' (frontend: Change Manager)
 *   > 60 → 'high' (frontend: CAB)
 */
export function determineApprovalRoute(aggregateScore: number): 'low' | 'medium' | 'high' {
  return aggregateScore <= 30 ? 'low' :
         aggregateScore <= 60 ? 'medium' :
                                'high'
}

/**
 * Fascia di rischio (`risk_band`) dal punteggio aggregato.
 *
 * Le **soglie** restano nel codice (le stesse di `determineApprovalRoute`:
 * ≤30 bassa, ≤60 media, oltre alta) — sono un modello di punteggio, non una
 * traduzione fra valori di dominio, e renderle configurabili è un lavoro a
 * parte (dichiarato come limite nel rapporto dell'ondata 7). I **nomi** delle
 * fasce invece no: sono il vocabolario `risk_band` del cliente, e la coppia
 * (tipo, fascia) si traduce in priorità con la sua matrice `change_priority`.
 *
 * Rischio **non ancora valutato** (`null`, prima dell'assessment) NON passa
 * da qui: è una regola distinta, la matrice `change_priority_initial`. «Non
 * valutato» e «basso» sono due cose diverse, e il codice che questa funzione
 * sostituisce le teneva separate — una change `normal` appena creata era
 * `medium`, una con rischio basso misurato era `low`. Collassarle avrebbe
 * cambiato in silenzio la priorità di ogni change a rischio basso.
 *
 * **L'ordine del vocabolario conta**: le fasce si leggono dalla più bassa alla
 * più alta. Rinominarle è sicuro (la matrice usa i nomi del cliente),
 * riordinarle cambia il significato delle soglie.
 */
export function riskBandOf(aggregateRiskScore: number | null | undefined, bands: readonly string[]): string {
  if (bands.length < 3) {
    throw new ValidationError(
      `Vocabolario "risk_band": servono almeno tre fasce (bassa, media, alta) per derivare la priorità di una change; trovate ${bands.length}: ${bands.join(', ')}.`,
    )
  }
  const [low, medium, high] = bands as readonly [string, string, string]
  if (aggregateRiskScore == null) {
    throw new Error('riskBandOf: il rischio non valutato non ha una fascia — usa la matrice change_priority_initial')
  }
  return aggregateRiskScore <= 30 ? low : aggregateRiskScore <= 60 ? medium : high
}

/**
 * Priorità della Change = **tipo × fascia di rischio** (decisione del
 * prodotto: NON Impatto×Urgenza, che vale per incident e problem).
 *
 * Prima era una cascata di `if` sui nomi di fabbrica (`emergency`, `standard`,
 * poi «normal» come ramo finale): un tipo aggiunto dal cliente — `major` —
 * finiva nel ramo `normal` **in silenzio**, con la priorità di una change
 * ordinaria. Ora il tipo è validato contro il vocabolario `change_type` del
 * cliente e la coppia si traduce con la sua matrice.
 */
export async function deriveChangePriority(
  tenantId: string,
  changeType: unknown,
  aggregateRiskScore: number | null | undefined,
): Promise<string> {
  const type = await assertDomainValue(tenantId, 'change_type', changeType)
  // Rischio non ancora valutato: la sua matrice, non la fascia più bassa.
  if (aggregateRiskScore == null) {
    return resolveDomainValue(tenantId, 'change_priority_initial', type)
  }
  const bands = await domainVocabulary(tenantId, 'risk_band')
  return resolveDomainValue(tenantId, 'change_priority', type, riskBandOf(aggregateRiskScore, bands))
}
