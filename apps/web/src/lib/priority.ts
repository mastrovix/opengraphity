/**
 * Client mirror of the backend ITIL priority matrix (apps/api/src/lib/priority.ts).
 * Priority = f(Impact, Urgency); the value shares the severity vocabulary.
 */
import { lookupOrError } from './tokens'

export type ImpactUrgency = 'high' | 'medium' | 'low'
export type Priority = 'critical' | 'high' | 'medium' | 'low'

const MATRIX: Record<ImpactUrgency, Record<ImpactUrgency, Priority>> = {
  high:   { high: 'critical', medium: 'high',   low: 'medium' },
  medium: { high: 'high',     medium: 'medium', low: 'low' },
  low:    { high: 'medium',   medium: 'low',    low: 'low' },
}

export function derivePriority(impact: ImpactUrgency, urgency: ImpactUrgency): Priority {
  return MATRIX[impact][urgency]
}

const PRIORITY_CODE: Record<string, string> = { critical: 'P1', high: 'P2', medium: 'P3', low: 'P4' }

/** `critical → P1` … ; an unknown value is logged and rendered as a visible `P?`. */
export function priorityCode(priority: string): string {
  return lookupOrError(PRIORITY_CODE, priority, 'PRIORITY_CODE', 'P?')
}

const IMPACT_URGENCY_FROM_PRIORITY: Record<string, { impact: ImpactUrgency; urgency: ImpactUrgency }> = {
  critical: { impact: 'high',   urgency: 'high' },
  high:     { impact: 'high',   urgency: 'medium' },
  medium:   { impact: 'medium', urgency: 'medium' },
  low:      { impact: 'low',    urgency: 'low' },
}

/**
 * Inverse of the matrix (one canonical pair per priority). An unknown priority
 * is a data error: it is logged via `lookupOrError` instead of silently
 * becoming `medium/medium`.
 */
export function impactUrgencyFromPriority(priority: string): { impact: ImpactUrgency; urgency: ImpactUrgency } {
  return lookupOrError(IMPACT_URGENCY_FROM_PRIORITY, priority, 'IMPACT_URGENCY_FROM_PRIORITY', { impact: 'medium', urgency: 'medium' })
}

export const IMPACT_URGENCY_OPTIONS: ImpactUrgency[] = ['high', 'medium', 'low']

export const IMPACT_URGENCY_LABEL: Record<ImpactUrgency, string> = {
  high: 'Alto', medium: 'Medio', low: 'Basso',
}
