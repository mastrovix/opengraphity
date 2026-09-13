/**
 * Pezzi comuni ai report di rispetto degli obiettivi (SLA Report, OLA / UC Report).
 *
 * Erano una pagina sola; divise, le due pagine devono restare gemelle: la
 * stessa finestra di giorni, gli stessi colori per le percentuali, lo stesso
 * modo di calcolare il rispetto. Qui una volta sola, invece di due copie che
 * derivano.
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageTitle } from '@/components/PageTitle'
import { useMe } from '@/hooks/useMe'
import { colors, palette } from '@/lib/tokens'

export const REPORT_WINDOWS = [7, 30, 90] as const

/** Verde da 95 %, giallo da 80 %, rosso sotto; grigio se non c'è niente da misurare. */
export function pctColor(pct: number | null): string {
  if (pct == null) return 'var(--color-slate-light)'
  if (pct >= 95) return palette.success.text
  if (pct >= 80) return palette.warning.text
  return palette.danger.text
}

/** Rispetto fra gli obiettivi CONCLUSI (rispettati + violati), o null se nessuno è concluso. */
export function compliance(met: number, breached: number): number | null {
  const concluso = met + breached
  return concluso > 0 ? (met / concluso) * 100 : null
}

export function PctCell({ pct }: { pct: number | null }) {
  return <span style={{ fontWeight: 600, color: pctColor(pct) }}>{pct == null ? '—' : `${pct.toFixed(0)}%`}</span>
}

/** Il selettore della finestra (7 / 30 / 90 giorni). */
export function WindowSelector({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {REPORT_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          aria-pressed={value === w}
          onClick={() => onChange(w)}
          style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-border-light)', background: value === w ? 'var(--color-brand)' : colors.white, color: value === w ? colors.white : 'var(--color-slate)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
        >
          {t('pages.slaReport.windowDays', { count: w })}
        </button>
      ))}
    </div>
  )
}

/** Il sottotitolo di una tabella del report. */
export function ReportSubheading({ children }: { children: React.ReactNode }) {
  return <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '24px 0 10px' }}>{children}</h3>
}

/**
 * La testata di un report: titolo, il link alla pagina dove si configura ciò
 * che il report misura (solo per gli admin, che sono gli unici a poterla
 * aprire) e la finestra. Obbligatorio il link: un report senza la strada per
 * cambiare ciò che misura era proprio la differenza fra le due pagine.
 */
export function ReportHeader({ icon, title, manageTo, manageLabel, windowDays, onWindowChange }: {
  icon: React.ReactElement
  title: string
  manageTo: string
  manageLabel: string
  windowDays: number
  onWindowChange: (days: number) => void
}) {
  const { isAdmin } = useMe()
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
      <PageTitle icon={icon}>{title}</PageTitle>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {isAdmin && (
          <Link to={manageTo} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: 500 }}>
            {manageLabel}
          </Link>
        )}
        <WindowSelector value={windowDays} onChange={onWindowChange} />
      </div>
    </div>
  )
}
