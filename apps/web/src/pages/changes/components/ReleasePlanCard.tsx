/**
 * IL PIANO COMPLESSIVO sul dettaglio della change (decisione del proprietario,
 * 17 set 2026).
 *
 * Il calcolo sta in `../releasePlanSummary.ts`, che spiega il perché di ogni
 * regola; qui c'è solo il come si vede: un elenco in ordine di data, una riga
 * per finestra, col tipo (validazione o rilascio), il task e il CI.
 *
 * Si popola task per task: ogni piano compilato aggiunge le sue voci al posto
 * giusto nella cronologia, senza aspettare gli altri.
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { StatusLabel } from '@/components/ui/badges'
import { Pill } from '@/components/ui/Pill'
import { formatDateTime, formatTime, formatDate } from '@/lib/datetime'
import { colors, palette } from '@/lib/tokens'
import type { AffectedCI } from '@/types/change'
import { riepilogoRilascio, type TipoFinestra } from '../releasePlanSummary'

/**
 * Una finestra come si legge: «21 set 2026, 22:00 → 23:30» quando comincia e
 * finisce nello stesso giorno, altrimenti entrambe le date per intero. Un
 * rilascio che scavalca la mezzanotte è la norma, e scriverlo «22:00 → 01:00»
 * lascerebbe credere che duri tre ore al contrario.
 */
function finestraLeggibile(start: string, end: string): string {
  return formatDate(start) === formatDate(end)
    ? `${formatDateTime(start)} → ${formatTime(end)}`
    : `${formatDateTime(start)} → ${formatDateTime(end)}`
}

/** Validazione e rilascio si distinguono a colpo d'occhio: sono due mestieri diversi. */
function TipoPill({ tipo }: { tipo: TipoFinestra }) {
  const { t } = useTranslation()
  // Due tinte diverse, non due sfumature della stessa: sono due mestieri, e in
  // un elenco alternato devono distinguersi senza leggere l'etichetta.
  const stile = tipo === 'release' ? palette.purple : palette.info
  return (
    <Pill bg={stile.tint} color={stile.text} radius={10}>
      {t(tipo === 'release' ? 'pages.releasePlan.typeRelease' : 'pages.releasePlan.typeValidation')}
    </Pill>
  )
}

function Riquadro({ label, children, color }: { label: string; children: React.ReactNode; color?: string }) {
  return (
    <div style={{ background: 'var(--color-surface-alt)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: color ?? 'var(--color-slate-dark)', fontVariantNumeric: 'tabular-nums' }}>{children}</div>
    </div>
  )
}

export function ReleasePlanCard({ affected }: { affected: readonly AffectedCI[] }) {
  const { t } = useTranslation()
  const r = riepilogoRilascio(affected)

  // Nessuna finestra e nessun task chiuso: non c'è ancora niente da
  // riepilogare, e una sezione vuota si legge come un piano che non esiste
  // invece che come un piano che non è ancora il momento di fare.
  if (r.voci.length === 0 && r.taskChiusi === 0) return null

  return (
    <SectionCard title={t('pages.releasePlan.title')} collapsible defaultOpen count={r.voci.length}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        <Riquadro label={t('pages.releasePlan.envelope')}>
          {r.inviluppo
            ? finestraLeggibile(r.inviluppo.start, r.inviluppo.end)
            : <span style={{ color: colors.slateLight, fontWeight: 400 }}>{t('pages.releasePlan.noWindowYet')}</span>}
          {/* Quante finestre sono: «dal 21 al 25» da solo si legge come un
              fermo di quattro giorni. Se è un blocco unico non serve dirlo. */}
          {r.finestreDistinte > 1 && (
            <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 400, color: palette.warning.text, marginTop: 4 }}>
              {t('pages.releasePlan.windowsApart', { count: r.finestreDistinte })}
            </div>
          )}
        </Riquadro>
        <Riquadro label={t('pages.releasePlan.taskProgress')}>
          {t('pages.releasePlan.ofTotal', { done: r.taskChiusi, total: r.taskTotali })}
        </Riquadro>
        <Riquadro
          label={t('pages.releasePlan.plansDone')}
          color={r.pianiCompletati < r.pianiTotali ? palette.danger.text : undefined}
        >
          {t('pages.releasePlan.ofTotal', { done: r.pianiCompletati, total: r.pianiTotali })}
        </Riquadro>
      </div>

      {r.voci.length > 0 && (
        <div className="og-scroll-x">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 10px' }}>{t('pages.releasePlan.when')}</th>
                <th style={{ textAlign: 'left', padding: '6px 10px' }}>{t('pages.releasePlan.type')}</th>
                <th style={{ textAlign: 'left', padding: '6px 10px' }}>{t('pages.releasePlan.step')}</th>
                <th style={{ textAlign: 'left', padding: '6px 10px' }}>{t('pages.releasePlan.task')}</th>
                <th style={{ textAlign: 'left', padding: '6px 10px' }}>{t('pages.releasePlan.ci')}</th>
              </tr>
            </thead>
            <tbody>
              {r.voci.map((v, i) => (
                <tr key={`${v.taskCode ?? v.ciId}-${v.tipo}-${i}`} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                  <td style={{ padding: '8px 10px', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-dark)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {finestraLeggibile(v.start, v.end)}
                  </td>
                  <td style={{ padding: '8px 10px' }}><TipoPill tipo={v.tipo} /></td>
                  <td style={{ padding: '8px 10px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{v.stepTitle}</td>
                  <td style={{ padding: '8px 10px', fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', whiteSpace: 'nowrap' }}>{v.taskCode ?? '—'}</td>
                  <td style={{ padding: '8px 10px', fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>{v.ciName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* I piani senza una data non si possono mettere in fila, e stanno fuori
          dalla cronologia: ma vanno DETTI, col codice del task da reclamare —
          è la cosa che chi approva deve vedere prima di firmare. */}
      {r.senzaDate.length > 0 && (
        <div style={{
          marginTop: r.voci.length > 0 ? 14 : 0,
          border: `1px solid ${palette.danger.border}`, borderRadius: 8,
          background: palette.danger.tint, padding: '10px 12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-label)', fontWeight: 600, color: palette.danger.text, marginBottom: 6 }}>
            <AlertTriangle size={14} aria-hidden="true" />
            {t('pages.releasePlan.withoutDates', { count: r.senzaDate.length })}
          </div>
          {r.senzaDate.map((p) => (
            <div key={p.ciId} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-dark)', padding: '2px 0' }}>
              <span style={{ fontWeight: 600 }}>{p.ciName}</span>
              <span style={{ color: palette.danger.text }}>{p.taskCode ?? '—'}</span>
              {p.teamName && <span style={{ color: 'var(--color-slate)' }}>{p.teamName}</span>}
              <StatusLabel status={p.stato} />
              <span style={{ color: 'var(--color-slate)' }}>
                {t(p.vuoto ? 'pages.releasePlan.noSteps' : 'pages.releasePlan.unusableDates')}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}
