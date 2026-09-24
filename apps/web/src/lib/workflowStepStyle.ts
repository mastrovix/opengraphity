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
    console.error(`[workflowStepStyle] unknown category: "${category}"`)
    return NEUTRAL_STYLE
  }
  return style
}

export interface ButtonColors { backgroundColor: string; color: string; borderColor: string }

/** The danger style of an action that ends a ticket badly (D27). */
export const DANGER_BUTTON: ButtonColors = {
  backgroundColor: 'var(--color-danger)',
  color:           colors.white,
  borderColor:     'var(--color-danger)',
}

/** The primary style: brand background. */
export const BRAND_BUTTON: ButtonColors = {
  backgroundColor: 'var(--color-brand)',
  color:           colors.white,
  borderColor:     'var(--color-brand)',
}

/** Solid-background style for primary action buttons (e.g. "Resolve"). */
const BUTTON_SOLID: Record<string, { bg: string; fg: string; border: string }> = {
  resolved:  { bg: 'var(--color-trigger-automatic)',  fg: colors.white, border: 'var(--color-trigger-automatic)'  },
  published: { bg: 'var(--color-trigger-automatic)',  fg: colors.white, border: 'var(--color-trigger-automatic)'  },
  escalated: { bg: 'var(--color-trigger-sla-breach)', fg: colors.white, border: 'var(--color-trigger-sla-breach)' },
  failed:    { bg: DANGER_BUTTON.backgroundColor, fg: DANGER_BUTTON.color, border: DANGER_BUTTON.borderColor },
  closed:    { bg: 'transparent', fg: 'var(--text-primary)', border: 'var(--border)' },
}

/** Button style for a transition that leads to a step with the given category. */
export function buttonStyleForCategory(category: string | null | undefined): ButtonColors {
  const solid = category ? BUTTON_SOLID[category] : undefined
  if (solid) return { backgroundColor: solid.bg, color: solid.fg, borderColor: solid.border }
  return BRAND_BUTTON
}

/**
 * THE INPUT A REJECTION ASKS FOR. The shipped workflows (problem, knowledge
 * base, service request) ask for `rejection_reason` on every transition that
 * rejects, and the service request page already reads it to name the field.
 */
export const REJECTION_INPUT_FIELD = 'rejection_reason'

/**
 * What a transition asks the person for: the kinds the shipped workflows use
 * (review of 23 Sep 2026). The panel offered only `rootCause` and `notes`, so
 * a shipped «Reject» (rejection_reason) showed «None» and, once changed, could
 * not be chosen again.
 */
export const TRANSITION_INPUT_FIELDS = ['notes', 'rootCause', REJECTION_INPUT_FIELD, 'defer_reason', 'reopen_reason'] as const

/**
 * IS THIS TRANSITION DESTRUCTIVE? Decided here, once, for every page that
 * draws transition buttons (D27, tour of 23 Sep 2026: the only action on a
 * request in approval was «Reject», drawn as the blue primary button).
 *
 * From the workflow's own metadata, never from a step name:
 *  - the target step's CATEGORY is `failed` — the category the designer
 *    describes as «Ended badly (cancelled, rejected)»;
 *  - or the transition asks for a rejection reason (`REJECTION_INPUT_FIELD`):
 *    the shipped service request workflow files its `rejected` step under
 *    `closed`, so the category alone does not see that «Reject» rejects.
 */
export function isDestructiveTransition(targetCategory: string | null | undefined, inputField?: string | null): boolean {
  return targetCategory === 'failed' || inputField === REJECTION_INPUT_FIELD
}

/**
 * The colours of a transition button. A destructive transition is always
 * DANGER. Otherwise `byCategory` colours by the target category (incident
 * and problem headers), `brand` keeps the primary style (request sidebar,
 * change card).
 */
export function transitionButtonColors(
  targetCategory: string | null | undefined, inputField: string | null | undefined, palette: 'byCategory' | 'brand',
): ButtonColors {
  if (isDestructiveTransition(targetCategory, inputField)) return DANGER_BUTTON
  return palette === 'byCategory' ? buttonStyleForCategory(targetCategory) : BRAND_BUTTON
}
