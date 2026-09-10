/**
 * Colour palette for workflow step badges / action buttons, keyed by the
 * step's `category` metadata (admin-editable in the designer). If a tenant
 * defines a new category the UI falls back to the neutral slate style.
 *
 * Consumers should look up a step's category (via `useWorkflowSteps`) and
 * pass it to these helpers — never match on the step name.
 */
import { colors, palette } from '@/lib/tokens'

export interface CategoryStyle {
  bg:    string
  color: string
}

const CATEGORY_STYLE: Record<string, CategoryStyle> = {
  active:    { bg: palette.info.tint, color: colors.brand },
  waiting:   { bg: palette.purple.tint, color: palette.purple.base },
  escalated: { bg: palette.orange.tint, color: palette.warning.text },
  resolved:  { bg: palette.success.tint, color: palette.success.text },
  published: { bg: palette.success.tint, color: palette.success.text },
  closed:    { bg: 'var(--color-slate-bg)', color: 'var(--color-slate-light)' },
  failed:    { bg: palette.danger.tint, color: palette.danger.text },
  draft:     { bg: colors.slateBg, color: 'var(--color-slate)' },
}

const NEUTRAL_STYLE: CategoryStyle = { bg: colors.slateBg, color: 'var(--color-slate)' }

export function styleForCategory(category: string | null | undefined): CategoryStyle {
  if (!category) return NEUTRAL_STYLE
  const style = CATEGORY_STYLE[category]
  if (!style) {
    // Neutral styling is acceptable, silence is not: an unknown category means
    // a workflow step this map does not know about.
    console.error(`[workflowStepStyle] categoria sconosciuta: "${category}"`)
    return NEUTRAL_STYLE
  }
  return style
}

/** Solid-background style for primary action buttons (e.g. "Resolve"). */
const BUTTON_SOLID: Record<string, { bg: string; fg: string; border: string }> = {
  resolved:  { bg: 'var(--color-trigger-automatic)',  fg: colors.white, border: 'var(--color-trigger-automatic)'  },
  published: { bg: 'var(--color-trigger-automatic)',  fg: colors.white, border: 'var(--color-trigger-automatic)'  },
  escalated: { bg: 'var(--color-trigger-sla-breach)', fg: colors.white, border: 'var(--color-trigger-sla-breach)' },
  failed:    { bg: 'var(--color-trigger-sla-breach)', fg: colors.white, border: 'var(--color-trigger-sla-breach)' },
  closed:    { bg: 'transparent', fg: 'var(--text-primary)', border: 'var(--border)' },
}

/** Button style for a transition that leads to a step with the given category. */
export function buttonStyleForCategory(category: string | null | undefined): {
  backgroundColor: string; color: string; borderColor: string
} {
  const solid = category ? BUTTON_SOLID[category] : undefined
  if (solid) return { backgroundColor: solid.bg, color: solid.fg, borderColor: solid.border }
  return {
    backgroundColor: 'var(--color-brand)',
    color:           colors.white,
    borderColor:     'var(--color-brand)',
  }
}
