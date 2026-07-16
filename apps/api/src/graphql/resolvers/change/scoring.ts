/**
 * Pure scoring functions for the Change assessment process.
 *
 * Extracted from assessmentMutations.ts (task score) and helpers.ts
 * (CI risk, approval route) so they can be unit-tested without a Neo4j
 * session. Behaviour is identical to the previous inline code.
 */
import { ValidationError } from '../../../lib/errors.js'

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
