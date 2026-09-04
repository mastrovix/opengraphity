/**
 * Client mirror of the backend ITIL priority matrix (apps/api/src/lib/priority.ts).
 * Priority = f(Impact, Urgency); the value shares the severity vocabulary.
 */
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

export function priorityCode(priority: string): string {
  return { critical: 'P1', high: 'P2', medium: 'P3', low: 'P4' }[priority] ?? 'P?'
}

export function impactUrgencyFromPriority(priority: string): { impact: ImpactUrgency; urgency: ImpactUrgency } {
  switch (priority) {
    case 'critical': return { impact: 'high',   urgency: 'high' }
    case 'high':     return { impact: 'high',   urgency: 'medium' }
    case 'low':      return { impact: 'low',    urgency: 'low' }
    default:         return { impact: 'medium', urgency: 'medium' }
  }
}

export const IMPACT_URGENCY_OPTIONS: ImpactUrgency[] = ['high', 'medium', 'low']

export const IMPACT_URGENCY_LABEL: Record<ImpactUrgency, string> = {
  high: 'Alto', medium: 'Medio', low: 'Basso',
}
