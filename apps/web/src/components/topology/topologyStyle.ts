/**
 * The colours shared by the topology graph and its legend: one definition,
 * so the legend always shows what the graph draws.
 */
import { palette } from '@/lib/tokens'

export const NODE_COLOR = 'var(--color-slate)'   // ardesia — uguale per tutti i tipi CI
export const EDGE_COLOR = 'var(--color-trigger-manual)'   // cyan — uguale per tutti i tipi relazione

/** Colori della salute (stessa palette di CIHealthBadge in pages/events/eventShared). */
export const HEALTH_COLOR: Record<string, { stroke: string; fill: string }> = {
  down:     { stroke: palette.danger.dark, fill: palette.danger.tint },
  degraded: { stroke: palette.warning.dark, fill: palette.warning.tint },
}
