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

// ── Patch coerente priorità / impatto / urgenza ───────────────────────────────

import { ValidationError } from './errors.js'

const PRIORITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low'])

/**
 * Calcola la patch di (priority, impact, urgency) mantenendo l'invariante
 * ITIL "priorità = impatto × urgenza" su update parziali di incident/problem:
 *  - impact e/o urgency nella patch → merge col corrente e priorità ricalcolata;
 *  - solo priority nella patch → impact/urgency riallineati alla priorità;
 *  - valori non validi → ValidationError (niente scritture silenziosamente
 *    incoerenti).
 * Ritorna null per i campi da non toccare (il chiamante usa coalesce).
 */
export function resolvePriorityPatch(
  current: { impact: string | null | undefined; urgency: string | null | undefined },
  patch: { priority?: string | null; impact?: string | null; urgency?: string | null },
): { severity: string | null; impact: string | null; urgency: string | null } {
  const hasIU = patch.impact != null || patch.urgency != null
  if (hasIU) {
    for (const [k, v] of [['impact', patch.impact], ['urgency', patch.urgency]] as const) {
      if (v != null && !isImpactUrgency(v)) throw new ValidationError(`${k} non valido: "${v}" (high | medium | low)`)
    }
    const mImpact  = patch.impact  ?? current.impact
    const mUrgency = patch.urgency ?? current.urgency
    if (isImpactUrgency(mImpact) && isImpactUrgency(mUrgency)) {
      return { severity: derivePriority(mImpact, mUrgency), impact: mImpact, urgency: mUrgency }
    }
    // Manca la controparte (dato storico incompleto): si salva il valore dato,
    // la priorità resta quella corrente.
    return { severity: null, impact: patch.impact ?? null, urgency: patch.urgency ?? null }
  }
  if (patch.priority != null) {
    if (!PRIORITIES.has(patch.priority)) throw new ValidationError(`priority non valida: "${patch.priority}" (critical | high | medium | low)`)
    const iu = impactUrgencyFromPriority(patch.priority)
    return { severity: patch.priority, impact: iu.impact, urgency: iu.urgency }
  }
  return { severity: null, impact: null, urgency: null }
}
