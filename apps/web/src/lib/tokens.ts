// apps/web/src/lib/tokens.ts
// Design tokens — all values resolve to CSS custom properties defined in :root.
// Changing a value in index.css propagates everywhere automatically.

const v = (name: string) => `var(${name})`

// ── COLORS ──────────────────────────────────────────────────────────────────

export const colors = {
  // Brand
  brand:      v('--color-brand'),        // #0284c7 — buttons, links, active menu, nodes
  brandHover: v('--color-brand-hover'),  // #0369a1
  brandLight: v('--color-brand-light'),  // #ecfeff — badge bg, hover bg

  // Slate scale
  slateDark:  v('--color-slate-dark'),   // #0f172a — primary text, titles
  slate:      v('--color-slate'),        // #64748b — secondary text, labels
  slateLight: v('--color-slate-light'),  // #94a3b8 — tertiary text, placeholders
  slateBg:    v('--color-slate-bg'),     // #f1f5f9 — neutral badge backgrounds

  // Base
  white:  v('--color-white'),
  border: v('--color-border'),

  // Brand alpha variants (for React Flow nodes — hex+opacity patterns)
  brandA08: v('--color-brand-a08'),  // rgba(2,132,199,0.08)
  brandA13: v('--color-brand-a13'),  // rgba(2,132,199,0.13)
  brandA20: v('--color-brand-a20'),  // rgba(2,132,199,0.20)
  brandA53: v('--color-brand-a53'),  // rgba(2,132,199,0.53)

  // Semantic feedback
  success: v('--color-success'),  // #22c55e
  warning: v('--color-warning'),  // #eab308
  danger:  v('--color-danger'),   // #ef4444

  // Severity (used in ImpactPanel, SeverityBadge)
  severity: {
    low:      { bg: v('--color-severity-low-bg'),      text: v('--color-severity-low-text'),      border: v('--color-severity-low-border')      },
    medium:   { bg: v('--color-severity-medium-bg'),   text: v('--color-severity-medium-text'),   border: v('--color-severity-medium-border')   },
    high:     { bg: v('--color-severity-high-bg'),     text: v('--color-severity-high-text'),     border: v('--color-severity-high-border')     },
    critical: { bg: v('--color-severity-critical-bg'), text: v('--color-severity-critical-text'), border: v('--color-severity-critical-border') },
  },

  // Workflow trigger types (WorkflowDesignerPage edges + legend)
  trigger: {
    manual:    v('--color-trigger-manual'),      // #0284c7
    automatic: v('--color-trigger-automatic'),   // #059669
    slaBreach: v('--color-trigger-sla-breach'),  // #DC2626
    timer:     v('--color-trigger-timer'),       // #D97706
  },
} as const

// ── TYPOGRAPHY ───────────────────────────────────────────────────────────────

export const fontFamily = v('--font-family')

export const fontSize = {
  pageTitle:    v('--font-size-page-title'),    // 24px
  sectionTitle: v('--font-size-section-title'), // 18px
  cardTitle:    v('--font-size-card-title'),    // 15px
  body:         v('--font-size-body'),          // 14px
  sidebar:      v('--font-size-sidebar'),       // 13px
  table:        v('--font-size-table'),         // 12px
  label:        v('--font-size-label'),         // 12px
  small:        v('--font-size-small'),         // 11px
} as const

export const fontWeight = {
  extralight: 200,
  regular:    400,
  medium:     500,
  semibold:   600,
  bold:       700,
} as const

// ── SPACING ──────────────────────────────────────────────────────────────────

export const spacing = {
  blastRadiusIndent: 24,  // px — CI rows indentation in Impact Analysis blast radius
} as const

// ── LOOKUP HELPER ───────────────────────────────────────────────────────────

const ERROR_STYLE = { bg: '#ef4444', color: '#fff' }

export function lookupOrError<T>(map: Record<string, T>, key: string, mapName: string, errorFallback: T): T {
  const val = map[key]
  if (val === undefined) {
    console.error(`[${mapName}] valore sconosciuto: "${key}"`)
    return errorFallback
  }
  return val
}

/** Shortcut for style maps that return { bg, color } */
export function lookupStyle(map: Record<string, { bg: string; color: string }>, key: string, mapName: string): { bg: string; color: string } {
  return lookupOrError(map, key, mapName, ERROR_STYLE)
}
