/**
 * I CONFLITTI DI RILASCIO, sul dettaglio della change (18 set 2026).
 *
 * È la domanda del CAB: «mentre rilascio, qualcun altro mette le mani sugli
 * stessi CI?». Prima l'unica risposta era aprire il calendario e guardare i
 * colori — su un'altra pagina, a occhio, e proprio mentre si decide se
 * approvare.
 *
 * ## Solo i deploy
 * Due validazioni sullo stesso CI sono due prove e non si disturbano; due
 * RILASCI sono due mani sulla stessa macchina. Il confronto lo fa il server
 * (`Change.deployConflicts`) e riguarda le sole finestre di rilascio: se qui
 * comparissero anche le validazioni, la sezione si riempirebbe di righe che
 * non sono problemi e chi la legge imparerebbe a saltarla.
 *
 * ## La sezione c'è anche quando non c'è niente
 * «Nessun conflitto» è una risposta, e su una decisione di rilascio è LA
 * risposta che si sta cercando. Una sezione che appare solo quando c'è un
 * problema lascia il dubbio fra «non ci sono conflitti» e «nessuno ha
 * guardato» — e quel dubbio, davanti a un'approvazione, si risolve sempre
 * nel modo sbagliato.
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { SectionCard } from '@/components/ui/SectionCard'
import { formatDateTime } from '@/lib/datetime'
import type { ChangeDeployConflict } from '@/types/change'

/** Le righe raggruppate per CI: il CI è la cosa che si condivide, quindi è il titolo. */
function perCI(conflitti: readonly ChangeDeployConflict[]): { ciId: string; ciName: string; righe: ChangeDeployConflict[] }[] {
  const gruppi = new Map<string, { ciId: string; ciName: string; righe: ChangeDeployConflict[] }>()
  for (const c of conflitti) {
    const g = gruppi.get(c.ciId) ?? { ciId: c.ciId, ciName: c.ciName, righe: [] }
    g.righe.push(c)
    gruppi.set(c.ciId, g)
  }
  return [...gruppi.values()].sort((a, b) => a.ciName.localeCompare(b.ciName))
}

export function DeployConflictsSection({ conflitti }: { conflitti: readonly ChangeDeployConflict[] }) {
  const { t } = useTranslation()
  const gruppi = perCI(conflitti)

  return (
    <SectionCard
      title={t('pages.changeDetail.deployConflicts.title')}
      count={conflitti.length}
      /*
       * APERTA SEMPRE, anche quando non c'è niente — e l'ho scoperto da un
       * test che cercava la frase «nessun conflitto» e non la trovava: con
       * `defaultOpen={conflitti.length > 0}` la risposta stava dietro una
       * scheda chiusa, cioè esattamente il dubbio che questa sezione esiste
       * per togliere. Una riga di testo non costa spazio; un'approvazione
       * data senza saperlo costa un rilascio.
       */
      defaultOpen
      /* Rosso solo quando c'è davvero qualcosa: un'intestazione d'allarme su
         «nessun conflitto» insegna che il colore non vuol dire niente. */
      {...(conflitti.length > 0 ? { activeColor: 'var(--color-danger)' } : {})}
    >
      {conflitti.length === 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
          {t('pages.changeDetail.deployConflicts.none')}
        </p>
      ) : (
        <>
          <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', lineHeight: 1.5, maxWidth: '74ch' }}>
            {t('pages.changeDetail.deployConflicts.lede')}
          </p>
          {gruppi.map((g) => (
            <div key={g.ciId} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 6 }}>
                {g.ciName}
              </div>
              {g.righe.map((c, i) => (
                <div
                  key={`${c.changeId}-${String(i)}`}
                  style={{
                    display: 'grid', gridTemplateColumns: 'minmax(180px, auto) 1fr', gap: '2px 16px',
                    padding: '8px 10px', marginBottom: 6,
                    background: 'var(--color-danger-bg, var(--color-slate-bg))',
                    borderLeft: '3px solid var(--color-danger)', borderRadius: 4,
                    fontSize: 'var(--font-size-label)',
                  }}
                >
                  <Link
                    to={`/changes/${c.changeId}`}
                    style={{ fontWeight: 600, color: 'var(--color-brand-hover)', textDecoration: 'none', fontFamily: 'var(--font-mono, monospace)' }}
                  >
                    {c.code}
                  </Link>
                  <span style={{ color: 'var(--color-slate-dark)' }}>
                    {c.title}
                    {c.currentStep !== null && c.currentStep !== '' && (
                      <span style={{ color: 'var(--color-slate-light)' }}> · {c.currentStep}</span>
                    )}
                  </span>

                  {/* Le TRE finestre: la mia, la sua, e le ore in comune. Senza
                      le prime due non si sa cosa spostare; senza la terza si
                      deve calcolare a mente davanti a una decisione. */}
                  <span style={{ color: 'var(--color-slate-light)' }}>{t('pages.changeDetail.deployConflicts.mine')}</span>
                  <span style={{ color: 'var(--color-slate)' }}>{formatDateTime(c.mine.start)} → {formatDateTime(c.mine.end)}</span>

                  <span style={{ color: 'var(--color-slate-light)' }}>{t('pages.changeDetail.deployConflicts.theirs')}</span>
                  <span style={{ color: 'var(--color-slate)' }}>{formatDateTime(c.theirs.start)} → {formatDateTime(c.theirs.end)}</span>

                  <span style={{ color: 'var(--color-slate-light)' }}>{t('pages.changeDetail.deployConflicts.overlap')}</span>
                  <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>
                    {formatDateTime(c.overlap.start)} → {formatDateTime(c.overlap.end)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </SectionCard>
  )
}
