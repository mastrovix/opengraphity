/**
 * LAVORO QUOTIDIANO — i numeri, prima delle proposte (20 set 2026).
 *
 * Ondata 2 di «Miglioramento continuo». Questa pagina non propone niente:
 * mostra le misure su cui l'analista si fonderà, perché una persona possa
 * guardarle. Se i numeri sono sbagliati si vede qui, non fra due ondate
 * dentro una proposta che sembra sensata.
 *
 * ## La copertura viene prima di tutto, e non è una decorazione
 * Su `c-one` ci sono 1.519 incident e 93 voci di creazione nel registro: il
 * 94% del parco è entrato per import. Un cruscotto che mostrasse i conteggi
 * senza dire quanto vede mentirebbe per omissione — quindi la prima riga
 * dice quanto vede, e lo dice anche quando è poco.
 *
 * ## Le soglie si mostrano
 * Sotto ogni tabella c'è il criterio con cui le righe sono state scelte. Chi
 * guarda deve poter dire «questa soglia è sbagliata», e per dirlo deve
 * vederla.
 */
import { Loading } from '@/components/ui/Loading'
import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Gauge, AlertTriangle } from 'lucide-react'
import { GET_DAILY_WORK_AGGREGATES } from '@/graphql/queries/dailyWork'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { QueryError } from '@/components/QueryError'
import { StatTile } from '@/components/ui/StatTile'
import { EmptyState } from '@/components/EmptyState'
import { colors, palette } from '@/lib/tokens'

interface Coverage {
  tickets: number; withCreationEntry: number; entries: number
  humanEntries: number; genericEntries: number; unreadableActions: number; windowDays: number
}
interface Action { object: string; verb: string; n: number; distinctActors: number; distinctObjects: number }
interface StepTime { stepName: string; n: number; medianHours: number; p90Hours: number; over48h: number; discardedZeros: number }
interface Pair { first: string; then: string; n: number; distinctObjects: number; distinctActors: number }
interface AIUsage { feature: string; n: number; distinctActors: number }
interface Thresholds {
  minWindowDays: number; minOccurrences: number; minRunsPerStep: number
  pairMinOccurrences: number; pairMinDistinctObjects: number; pairMinDistinctActors: number; pairMaxMinutes: number
}
interface Aggregates {
  coverage: Coverage; actions: Action[]; stepTimes: StepTime[]
  pairs: Pair[]; aiUsage: AIUsage[]; thresholds: Thresholds
}

const FINESTRE = [7, 30, 90] as const

const cella: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--color-border)',
  fontSize: 'var(--font-size-body)',
}
const intestazione: React.CSSProperties = {
  ...cella, fontWeight: 600, fontSize: 'var(--font-size-label)',
  textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-slate)',
  background: palette.info.tint, whiteSpace: 'nowrap',
}

function Sezione({ titolo, criterio, vuoto, children }: {
  titolo: string; criterio: string; vuoto: boolean; children: React.ReactNode
}) {
  return (
    <section style={{ marginBottom: 28 }} aria-label={titolo}>
      <h2 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 4px' }}>
        {titolo}
      </h2>
      <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', margin: '0 0 10px' }}>
        {criterio}
      </p>
      {vuoto
        ? <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', padding: '12px 0' }}>—</p>
        : (
          <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 8, background: colors.white }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>{children}</table>
          </div>
        )}
    </section>
  )
}

export function DailyWorkPage() {
  const { t } = useTranslation()
  const [giorni, setGiorni] = useState<number>(30)

  const { data, loading, error, refetch } = useQuery<{ dailyWorkAggregates: Aggregates }>(
    GET_DAILY_WORK_AGGREGATES,
    { variables: { windowDays: giorni }, fetchPolicy: 'cache-and-network' },
  )
  const a = data?.dailyWorkAggregates

  /*
   * La copertura come PERCENTUALE, perché è così che si legge: «il registro
   * vede il 6% dei ticket» dice in tre parole quello che «93 su 1.519» dice
   * in sei.
   */
  const coperturaTicket = a && a.coverage.tickets > 0
    ? Math.round((a.coverage.withCreationEntry / a.coverage.tickets) * 100)
    : null
  const quotaUmana = a && a.coverage.entries > 0
    ? Math.round((a.coverage.humanEntries / a.coverage.entries) * 100)
    : null

  return (
    <PageContainer>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <PageTitle icon={<Gauge size={22} color="var(--color-icon-accent)" aria-hidden="true" />}>
            {t('pages.dailyWork.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {t('pages.dailyWork.subtitle')}
          </p>
        </div>
        <div role="radiogroup" aria-label={t('pages.dailyWork.window')} style={{ display: 'flex', gap: 6 }}>
          {FINESTRE.map((g) => (
            <button key={g} type="button" role="radio" aria-checked={giorni === g} onClick={() => setGiorni(g)}
              style={{
                padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--font-size-body)',
                fontWeight: giorni === g ? 600 : 400,
                border: `1.5px solid ${giorni === g ? 'var(--color-brand)' : 'var(--color-border)'}`,
                background: giorni === g ? palette.info.light : 'var(--color-slate-bg)',
                color: giorni === g ? 'var(--color-brand)' : 'var(--color-slate)',
              }}>
              {t('pages.dailyWork.days', { count: g })}
            </button>
          ))}
        </div>
      </div>

      {error && <QueryError message={error.message} onRetry={() => void refetch()} />}
      {!error && loading && !a && (
        <Loading padded />
      )}

      {a && (
        <>
          {/* LA COPERTURA, per prima e con l'avviso quando è bassa. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
            <StatTile label={t('pages.dailyWork.coverage.tickets')} value={a.coverage.tickets}
              context={coperturaTicket !== null ? t('pages.dailyWork.coverage.withEntry', { pct: coperturaTicket }) : undefined} />
            <StatTile label={t('pages.dailyWork.coverage.entries')} value={a.coverage.entries}
              context={t('pages.dailyWork.coverage.window', { days: a.coverage.windowDays })} />
            <StatTile label={t('pages.dailyWork.coverage.human')} value={a.coverage.humanEntries}
              context={quotaUmana !== null ? t('pages.dailyWork.coverage.humanPct', { pct: quotaUmana }) : undefined} />
            <StatTile label={t('pages.dailyWork.coverage.generic')} value={a.coverage.genericEntries}
              context={t('pages.dailyWork.coverage.genericHelp')} />
          </div>

          {coperturaTicket !== null && coperturaTicket < 50 && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 20,
              padding: '10px 14px', borderRadius: 8,
              background: palette.warning.tint, border: `1px solid ${palette.warning.border}`,
              fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
            }}>
              <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{t('pages.dailyWork.lowCoverage', { pct: coperturaTicket })}</span>
            </div>
          )}

          {a.coverage.unreadableActions > 0 && (
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)', marginBottom: 20 }}>
              {t('pages.dailyWork.unreadActions', { count: a.coverage.unreadableActions })}
            </p>
          )}

          <Sezione
            titolo={t('pages.dailyWork.steps.title')}
            criterio={t('pages.dailyWork.steps.criterion', { min: a.thresholds.minRunsPerStep })}
            vuoto={a.stepTimes.length === 0}
          >
            <thead><tr>
              <th style={intestazione}>{t('pages.dailyWork.steps.step')}</th>
              <th style={intestazione}>{t('pages.dailyWork.steps.n')}</th>
              <th style={intestazione}>{t('pages.dailyWork.steps.median')}</th>
              <th style={intestazione}>{t('pages.dailyWork.steps.p90')}</th>
              <th style={intestazione}>{t('pages.dailyWork.steps.over48')}</th>
            </tr></thead>
            <tbody>
              {a.stepTimes.map((s) => (
                <tr key={s.stepName}>
                  <td style={cella}>{s.stepName}</td>
                  <td style={cella}>{s.n}</td>
                  <td style={{ ...cella, fontWeight: 600 }}>{s.medianHours} h</td>
                  <td style={cella}>{s.p90Hours} h</td>
                  <td style={{ ...cella, color: s.over48h > 0 ? 'var(--color-trigger-sla-breach)' : undefined }}>{s.over48h}</td>
                </tr>
              ))}
            </tbody>
          </Sezione>

          <Sezione
            titolo={t('pages.dailyWork.actions.title')}
            criterio={t('pages.dailyWork.actions.criterion')}
            vuoto={a.actions.length === 0}
          >
            <thead><tr>
              <th style={intestazione}>{t('pages.dailyWork.actions.object')}</th>
              <th style={intestazione}>{t('pages.dailyWork.actions.verb')}</th>
              <th style={intestazione}>{t('pages.dailyWork.actions.n')}</th>
              <th style={intestazione}>{t('pages.dailyWork.actions.people')}</th>
              <th style={intestazione}>{t('pages.dailyWork.actions.objects')}</th>
            </tr></thead>
            <tbody>
              {a.actions.slice(0, 25).map((r) => (
                <tr key={`${r.object}.${r.verb}`}>
                  <td style={cella}>{r.object}</td>
                  <td style={cella}>{r.verb}</td>
                  <td style={{ ...cella, fontWeight: 600 }}>{r.n}</td>
                  <td style={cella}>{r.distinctActors}</td>
                  <td style={cella}>{r.distinctObjects}</td>
                </tr>
              ))}
            </tbody>
          </Sezione>

          <Sezione
            titolo={t('pages.dailyWork.pairs.title')}
            criterio={t('pages.dailyWork.pairs.criterion', {
              n: a.thresholds.pairMinOccurrences,
              oggetti: a.thresholds.pairMinDistinctObjects,
              persone: a.thresholds.pairMinDistinctActors,
              minuti: a.thresholds.pairMaxMinutes,
            })}
            vuoto={a.pairs.length === 0}
          >
            <thead><tr>
              <th style={intestazione}>{t('pages.dailyWork.pairs.first')}</th>
              <th style={intestazione}>{t('pages.dailyWork.pairs.then')}</th>
              <th style={intestazione}>{t('pages.dailyWork.actions.n')}</th>
              <th style={intestazione}>{t('pages.dailyWork.actions.objects')}</th>
              <th style={intestazione}>{t('pages.dailyWork.actions.people')}</th>
            </tr></thead>
            <tbody>
              {a.pairs.map((p) => (
                <tr key={`${p.first}→${p.then}`}>
                  <td style={cella}>{p.first}</td>
                  <td style={cella}>{p.then}</td>
                  <td style={{ ...cella, fontWeight: 600 }}>{p.n}</td>
                  <td style={cella}>{p.distinctObjects}</td>
                  <td style={cella}>{p.distinctActors}</td>
                </tr>
              ))}
            </tbody>
          </Sezione>

          <Sezione
            titolo={t('pages.dailyWork.ai.title')}
            criterio={t('pages.dailyWork.ai.criterion')}
            vuoto={a.aiUsage.length === 0}
          >
            <thead><tr>
              <th style={intestazione}>{t('pages.dailyWork.ai.feature')}</th>
              <th style={intestazione}>{t('pages.dailyWork.actions.n')}</th>
              <th style={intestazione}>{t('pages.dailyWork.actions.people')}</th>
            </tr></thead>
            <tbody>
              {a.aiUsage.map((u) => (
                <tr key={u.feature}>
                  <td style={cella}>{u.feature}</td>
                  <td style={{ ...cella, fontWeight: 600 }}>{u.n}</td>
                  <td style={cella}>{u.distinctActors}</td>
                </tr>
              ))}
            </tbody>
          </Sezione>

          {a.actions.length === 0 && a.stepTimes.length === 0 && (
            <EmptyState icon={<Gauge size={40} />}
              title={t('pages.dailyWork.empty')}
              description={t('pages.dailyWork.emptyHelp', { days: giorni })} />
          )}
        </>
      )}
    </PageContainer>
  )
}
