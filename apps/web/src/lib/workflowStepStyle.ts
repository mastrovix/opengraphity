/**
 * Colour palette for workflow step badges / action buttons, keyed by the
 * step's `category` metadata (admin-editable in the designer). If a tenant
 * defines a new category the UI falls back to the neutral slate style.
 *
 * Consumers should look up a step's category (via `useWorkflowSteps`) and
 * pass it to these helpers — never match on the step name.
 */

export interface CategoryStyle {
  bg:    string
  color: string
}

const CATEGORY_STYLE: Record<string, CategoryStyle> = {
  active:    { bg: '#dbeafe', color: '#2563eb' },
  waiting:   { bg: '#ede9fe', color: '#7c3aed' },
  escalated: { bg: '#fed7aa', color: '#b45309' },
  resolved:  { bg: '#dcfce7', color: '#15803d' },
  published: { bg: '#dcfce7', color: '#15803d' },
  closed:    { bg: 'var(--color-slate-bg)', color: 'var(--color-slate-light)' },
  failed:    { bg: '#fee2e2', color: '#b91c1c' },
  draft:     { bg: '#f1f5f9', color: 'var(--color-slate)' },
}

const NEUTRAL_STYLE: CategoryStyle = { bg: '#f1f5f9', color: 'var(--color-slate)' }

export function styleForCategory(category: string | null | undefined): CategoryStyle {
  if (!category) return NEUTRAL_STYLE
  return CATEGORY_STYLE[category] ?? NEUTRAL_STYLE
}

/** Solid-background style for primary action buttons (e.g. "Resolve"). */
const BUTTON_SOLID: Record<string, { bg: string; fg: string; border: string }> = {
  resolved:  { bg: 'var(--color-trigger-automatic)',  fg: '#fff', border: 'var(--color-trigger-automatic)'  },
  published: { bg: 'var(--color-trigger-automatic)',  fg: '#fff', border: 'var(--color-trigger-automatic)'  },
  escalated: { bg: 'var(--color-trigger-sla-breach)', fg: '#fff', border: 'var(--color-trigger-sla-breach)' },
  failed:    { bg: 'var(--color-trigger-sla-breach)', fg: '#fff', border: 'var(--color-trigger-sla-breach)' },
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
    color:           '#fff',
    borderColor:     'var(--color-brand)',
  }
}
