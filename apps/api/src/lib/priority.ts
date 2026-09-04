/**
 * ITIL priority model: Priority = f(Impact, Urgency).
 *
 * Impact and Urgency are the two input dimensions (high/medium/low). The
 * derived priority uses the same four-value vocabulary the app already uses for
 * `severity` (critical/high/medium/low), so every existing consumer of
 * `severity` — SLA policy selection, badges, filters — keeps working unchanged:
 * the `severity` field now HOLDS the derived priority.
 *
 * Matrix (rows = impact, cols = urgency):
 *              urgency:  high     medium   low
 *   impact high         critical  high     medium
 *   impact medium       high      medium   low
 *   impact low          medium    low      low
 */
export type ImpactUrgency = 'high' | 'medium' | 'low'
export type Priority = 'critical' | 'high' | 'medium' | 'low'

const MATRIX: Record<ImpactUrgency, Record<ImpactUrgency, Priority>> = {
  high:   { high: 'critical', medium: 'high',   low: 'medium' },
  medium: { high: 'high',     medium: 'medium', low: 'low' },
  low:    { high: 'medium',   medium: 'low',    low: 'low' },
}

export function isImpactUrgency(v: unknown): v is ImpactUrgency {
  return v === 'high' || v === 'medium' || v === 'low'
}

/** Derive the ITIL priority from impact and urgency. */
export function derivePriority(impact: ImpactUrgency, urgency: ImpactUrgency): Priority {
  return MATRIX[impact][urgency]
}

/**
 * Back-fill impact and urgency from an existing single-dimension value
 * (severity/priority) so introducing the matrix on old data is lossless:
 * the pair chosen always maps back to the same value through the matrix.
 */
export function impactUrgencyFromPriority(priority: string): { impact: ImpactUrgency; urgency: ImpactUrgency } {
  switch (priority) {
    case 'critical': return { impact: 'high',   urgency: 'high' }
    case 'high':     return { impact: 'high',   urgency: 'medium' }
    case 'low':      return { impact: 'low',    urgency: 'low' }
    case 'medium':
    default:         return { impact: 'medium', urgency: 'medium' }
  }
}

/** P1–P4 label for display, derived from the priority value. */
export function priorityCode(priority: string): string {
  switch (priority) {
    case 'critical': return 'P1'
    case 'high':     return 'P2'
    case 'medium':   return 'P3'
    case 'low':      return 'P4'
    default:         return 'P?'
  }
}
