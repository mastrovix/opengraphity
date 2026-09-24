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
import { riskBandOf } from '../../lib/riskBands.js'
import { ValidationError } from '../../lib/errors.js'
import { assertDomainValue } from '../../lib/domainMatrix.js'
import { resolveDomainValue } from '../../lib/domainValue.js'

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
 * "Is the production environment affected?" question). The score of the CI's
 * environment comes from the domain matrix `environment_risk`
 * (lib/environmentRisk.ts, revisione del 14 set 2026 · CH-3): it used to be
 * two literals here, `production` → 3 and `staging` → 1. Its WEIGHT against
 * the questions is the tenant's `change_environment_weight`
 * (lib/changeEnvironmentWeight.ts): it used to be `ENV_WEIGHT = 5` here, and
 * every production change came out high-risk whatever the answers (#32).
 */
export const ENV_MAX = 3

/**
 * Weighted assessment-task score, integer 0..100:
 *
 *   round( (Σ weight·score + envWeight·envScore)
 *        / (Σ weight·maxScore + envWeight·ENV_MAX) · 100 )
 *
 * An empty question list is a caller bug (the resolver refuses to complete a
 * task without questions), so it raises a ValidationError instead of
 * returning a meaningless score. With a zero environment weight and questions
 * whose options all score 0 there is nothing to measure: that is an error of
 * the questionnaire, said as such, never NaN.
 */
export function calculateTaskScore(
  questions: QuestionScore[],
  envScore: number,
  envWeight: number,
): number {
  if (questions.length === 0) {
    throw new ValidationError('No assessment question: the score cannot be computed', { key: 'errors.assessment.noQuestions' })
  }
  let num = 0, den = 0
  for (const q of questions) {
    num += q.weight * q.score
    den += q.weight * q.maxScore
  }
  if (!Number.isInteger(envScore) || envScore < 0 || envScore > ENV_MAX) {
    throw new Error(`Environment score ${String(envScore)} is outside the 0..${String(ENV_MAX)} scale`)
  }
  if (!Number.isInteger(envWeight) || envWeight < 0) {
    throw new Error(`Environment weight ${String(envWeight)} is not a non-negative integer`)
  }
  num += envWeight * envScore
  den += envWeight * ENV_MAX
  if (den === 0) {
    throw new ValidationError(
      'The assessment questions have no scored option and the environment weight is 0: there is nothing to score',
      { key: 'errors.assessment.nothingToScore' },
    )
  }
  return Math.round((num / den) * 100)
}

/** CI risk = arithmetic mean (rounded to integer) of owner + support task scores. */
export function calculateCIRiskScore(ownerScore: number, supportScore: number): number {
  return Math.round((ownerScore + supportScore) / 2)
}

/**
 * approval_route di una change: la **fascia di rischio del cliente** del
 * punteggio aggregato (il MASSIMO dei punteggi per CI). Prima erano tre rotte
 * fisse (≤30 low, ≤60 medium, oltre high) mentre la fascia — e quindi la
 * priorità — seguiva le soglie di Matrici di dominio: con soglie 20/50 la
 * stessa change aveva priorità «alta» e rotta «medium» (verifica «Cosa resta
 * cablato», ondata 1). Con quattro fasce le rotte sono quattro.
 */
export async function determineApprovalRoute(tenantId: string, aggregateScore: number): Promise<string> {
  return riskBandOf(tenantId, aggregateScore)
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
 * **Le soglie non sono più qui** (revisione delle otto ondate · C·N-2): erano
 * 30 e 60 nel codice, e le fasce si leggevano per POSIZIONE (`bands[0..2]`) —
 * quindi riordinare il vocabolario invertiva le fasce in silenzio, e una quarta
 * fascia era irraggiungibile. Ora sono dato del cliente: `lib/riskBands.ts`.
 */
export { riskBandOf } from '../../lib/riskBands.js'

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
  return resolveDomainValue(tenantId, 'change_priority', type, await riskBandOf(tenantId, aggregateRiskScore))
}
