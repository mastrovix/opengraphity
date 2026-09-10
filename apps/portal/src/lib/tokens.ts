// apps/portal/src/lib/tokens.ts
// Token di colore del portale — sul modello di apps/web/src/lib/tokens.ts.
// Ogni valore risolve a una custom property di index.css (:root): cambiando
// il valore lì si propaga ovunque. I sorgenti .ts/.tsx non contengono
// esadecimali (regola ESLint no-restricted-syntax): ogni colore passa da qui.
// Solo le famiglie che il portale usa davvero; i nomi CSS sono gli stessi
// dell'app web, così i due frontend condividono il vocabolario.

const v = (name: string) => `var(${name})`

// ── COLORI BASE ──────────────────────────────────────────────────────────────

export const colors = {
  // Brand (portale: #0EA5E9)
  brand:      v('--color-brand'),        // link, pulsanti, tab attiva
  brandHover: v('--color-brand-hover'),  // #0284C7
  brandLight: v('--color-brand-light'),  // #F0F9FF — sfondo attivo / hover / badge brand

  // Scala slate
  slateDark:  v('--color-slate-dark'),   // #0F172A — testo principale, titoli
  slate:      v('--color-slate'),        // #64748B — testo secondario, etichette
  slateLight: v('--color-slate-light'),  // #94A3B8 — testo terziario, placeholder, icone spente
  slateBg:    v('--color-slate-bg'),     // #F1F5F9 — badge neutri

  // Base
  white:  v('--color-white'),
  border: v('--color-border'),           // #E2E8F0

  // Feedback semantico (icone, riempimenti, indicatori di priorità)
  success: v('--color-success'),  // #22C55E
  warning: v('--color-warning'),  // #EAB308
  danger:  v('--color-danger'),   // #EF4444
} as const

// ── TAVOLOZZA SEMANTICA ──────────────────────────────────────────────────────
// Stessa scala per ogni famiglia: bg (sfondo pieno), tint (sfondo marcato /
// hover), border, text (testo su bg), strong (testo con più contrasto),
// base/dark (icone, riempimenti).

/** Una famiglia di colore semantico. */
export interface ColorFamily {
  bg: string; tint: string; border: string; text: string; strong: string; base: string; dark: string
}

export const palette = {
  neutral: {
    surface1:     v('--color-surface-1'),      // #f8fafc — sfondo pagina, righe alternate, card
    surface2:     v('--color-surface-2'),      // #f1f3f9 — pannelli secondari
    slateBg:      v('--color-slate-bg'),       // #F1F5F9 — badge neutri
    border:       v('--color-border'),
    borderLight:  v('--color-border-light'),   // #f3f4f6
    borderStrong: v('--color-border-strong'),  // #c8cfe0 — bordi marcati, input, zona di trascinamento
    textLight:    v('--color-slate-light'),
    text:         v('--color-slate'),
    textStrong:   v('--color-slate-strong'),   // #475569
    textMuted:    v('--color-slate-muted'),    // #374151
    textDark:     v('--color-slate-dark'),
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
  danger: {
    bg: v('--color-danger-bg'), tint: v('--color-danger-tint'), border: v('--color-danger-border'),
    text: v('--color-danger-text'), strong: v('--color-danger-strong'), base: v('--color-danger'), dark: v('--color-danger-dark'),
    borderStrong: v('--color-danger-border-strong'),
  },
  info: {
    bg: v('--color-info-bg'), light: v('--color-info-light'), tint: v('--color-info-tint'), border: v('--color-info-border'),
    text: v('--color-info-text'), strong: v('--color-info-strong'), base: v('--color-brand'), dark: v('--color-brand-hover'),
  },
  orange: {
    bg: v('--color-orange-bg'), tint: v('--color-orange-tint'), border: v('--color-orange-border'),
    text: v('--color-orange-text'), strong: v('--color-orange-text'), base: v('--color-orange'), dark: v('--color-orange-dark'),
  } satisfies ColorFamily,
} as const

/** Trasparenze per ombre, veli ed evidenziazioni. */
export const alpha = {
  scrim: v('--color-scrim'),   // velo dietro i modali
  black05: v('--color-black-a05'), black06: v('--color-black-a06'), black08: v('--color-black-a08'),
  black10: v('--color-black-a10'), black12: v('--color-black-a12'), black15: v('--color-black-a15'), black20: v('--color-black-a20'),
  brand08: v('--color-brand-a08'), brand13: v('--color-brand-a13'), brand20: v('--color-brand-a20'), brand53: v('--color-brand-a53'),
} as const
