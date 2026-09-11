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

// ── TAVOLOZZA SEMANTICA ESTESA ───────────────────────────────────────────────
// Le pagine non contengono esadecimali (regola ESLint no-restricted-syntax):
// ogni colore passa da qui e risolve a un token di index.css. Stessa scala per
// ogni famiglia: bg (sfondo pieno), tint (sfondo marcato/hover), border, text
// (testo su bg), strong (testo con più contrasto), base/dark (icone, riempimenti).
// Nei contesti canvas (ECharts, D3 su canvas) usare lib/charts/cssVar per
// ottenere il valore risolto: lì `var()` non viene interpretato.

/** Una famiglia di colore semantico. */
export interface ColorFamily {
  bg: string; tint: string; border: string; text: string; strong: string; base: string; dark: string
}

export const palette = {
  neutral: {
    surface1:     v('--color-surface-1'),      // #f8fafc — sfondo pagina, righe alternate
    surface2:     v('--color-surface-2'),      // #f1f3f9 — pannelli secondari, intestazioni
    slateBg:      v('--color-slate-bg'),       // #f1f5f9 — badge neutri
    border:       v('--color-border'),         // #e2e6f0
    borderLight:  v('--color-border-light'),   // #f3f4f6
    borderStrong: v('--color-border-strong'),  // #c8cfe0
    textLight:    v('--color-slate-light'),    // #94a3b8
    text:         v('--color-slate'),          // #64748b
    textStrong:   v('--color-slate-strong'),   // #475569
    textMuted:    v('--color-slate-muted'),    // #374151
    textDark:     v('--color-slate-dark'),     // #0f172a
    white:        v('--color-white'),
    textDisabled: v('--color-text-disabled'), // #cbd5e1 — controlli disabilitati, numeri decorativi
  },
  success: {
    bg: v('--color-success-bg'), tint: v('--color-success-tint'), border: v('--color-success-border'),
    text: v('--color-success-text'), strong: v('--color-success-strong'), base: v('--color-success'), dark: v('--color-success-dark'),
  } satisfies ColorFamily,
  warning: {
    bg: v('--color-warning-bg'), tint: v('--color-warning-tint'), border: v('--color-warning-border'),
    text: v('--color-warning-text'), strong: v('--color-warning-strong'), base: v('--color-warning'), dark: v('--color-warning-dark'),
  } satisfies ColorFamily,
  /** Evidenziazione gialla (note, righe da rivedere): più chiara dell'avviso. */
  yellow: { bg: v('--color-yellow-bg'), border: v('--color-yellow-border'), text: v('--color-yellow-text') },
  danger: {
    bg: v('--color-danger-bg'), tint: v('--color-danger-tint'), border: v('--color-danger-border'),
    text: v('--color-danger-text'), strong: v('--color-danger-strong'), base: v('--color-danger'), dark: v('--color-danger-dark'),
    borderStrong: v('--color-danger-border-strong'),
  },
  info: {
    bg: v('--color-info-bg'), light: v('--color-info-light'), tint: v('--color-info-tint'), border: v('--color-info-border'),
    text: v('--color-info-text'), strong: v('--color-info-strong'), base: v('--color-brand'), dark: v('--color-brand-hover'),
  },
  purple: {
    bg: v('--color-purple-bg'), tint: v('--color-purple-tint'), border: v('--color-purple-border'),
    text: v('--color-purple-dark'), strong: v('--color-purple-dark'), base: v('--color-purple'), dark: v('--color-purple-dark'),
    light: v('--color-purple-light'),
  },
  orange: {
    bg: v('--color-orange-bg'), tint: v('--color-orange-tint'), border: v('--color-orange-border'),
    text: v('--color-orange-text'), strong: v('--color-orange-text'), base: v('--color-orange'), dark: v('--color-orange-dark'),
  } satisfies ColorFamily,
  /** Solo serie di grafici e categorie. */
  teal: { base: v('--color-teal'), light: v('--color-teal-light'), bg: v('--color-teal-bg'), border: v('--color-teal-border') },
  pink: v('--color-pink'),
  lime: v('--color-lime'),
  iconAccent: v('--color-icon-accent'),
} as const

/** Trasparenze per ombre, veli ed evidenziazioni. */
export const alpha = {
  scrim: v('--color-scrim'),   // velo dietro i modali
  black05: v('--color-black-a05'), black06: v('--color-black-a06'), black08: v('--color-black-a08'),
  black10: v('--color-black-a10'), black12: v('--color-black-a12'), black15: v('--color-black-a15'), black20: v('--color-black-a20'),
  white08: v('--color-white-a08'), white40: v('--color-white-a40'), white92: v('--color-white-a92'),
  success08: v('--color-success-a08'), success10: v('--color-success-a10'), danger08: v('--color-danger-a08'),
  iconAccent12: v('--color-icon-accent-a12'),
  brand08: v('--color-brand-a08'), brand13: v('--color-brand-a13'), brand20: v('--color-brand-a20'), brand32: v('--color-brand-a32'), brand53: v('--color-brand-a53'),
} as const

/** Identità dei fornitori esterni (ToolBadge, canali di notifica): non seguono il tema. */
export const vendorColors = {
  prometheus: v('--color-vendor-prometheus'),
  grafana:    v('--color-vendor-grafana'),
  zabbix:     v('--color-vendor-zabbix'),
  datadog:    v('--color-vendor-datadog'),
  dynatrace:  v('--color-vendor-dynatrace'),
  slack:      v('--color-vendor-slack'),
  teams:      v('--color-vendor-teams'),
} as const

// ── DARK CHROME (Sidebar / Topbar / GlobalSearch) ────────────────────────────
// One palette for the three layout components (E-23): they used to declare
// three different `C` objects with two different border colours.

export const layoutPalette = {
  bg:          v('--chrome-bg'),        // #3d4856
  border:      v('--chrome-border'),    // #4f5e70 — dividers on the dark chrome
  textDefault: v('--chrome-text'),      // #e2e8f0
  textMuted:   v('--color-slate-light'),
  textSection: v('--color-slate-light'),
  textChevron: v('--color-slate-light'),
  hoverBg:     v('--chrome-hover-bg'),  // rgba(255,255,255,0.08)
  activeBg:    v('--chrome-hover-bg'),
  inputBg:     v('--chrome-input-bg'),  // rgba(255,255,255,0.06)
  brand:       v('--color-brand'),
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
  caption:      v('--font-size-caption'),       // 10px — dates, IDs, counts
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

const ERROR_STYLE = { bg: 'var(--color-danger)', color: 'var(--color-white)' }

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
