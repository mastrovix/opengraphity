/**
 * GLI OLA/UC DI UN TICKET (secondo giro UI del 15 set 2026): nel dettaglio di un
 * ticket gli OLA non si vedevano, e chi lavorava il ticket non sapeva quale
 * impegno di team stava correndo né quando scadeva. Il riquadro mostra i
 * contratti del tipo del ticket con le regole del report: quelli che contano
 * (scadenza, stato) e quelli che non contano, col motivo.
 */
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { SectionCard } from '@/components/ui/SectionCard'
import { Pill } from '@/components/ui/Pill'
import { GET_TICKET_OLAS } from '@/graphql/queries'
import { formatDateTime } from '@/lib/datetime'
import { TINT_CRITICAL, TINT_INFO, TINT_NEUTRAL, TINT_SUCCESS } from '@/lib/eventPalette'
import { olaMinutes } from '@/pages/admin/OLAContractsPage'

export interface TicketOLA {
  contractId: string; name: string; type: string; teamName: string | null; resolveMinutes: number; calendarName: string | null
  applies: boolean; reason: string | null; deadline: string | null; concludedAt: string | null; state: string | null
}

const STATE_TINT = { met: TINT_SUCCESS, breached: TINT_CRITICAL, running: TINT_INFO } as const

export function TicketOLACard({ entityType, entityId }: { entityType: 'incident' | 'problem' | 'change' | 'service_request'; entityId: string }) {
  const { t } = useTranslation()
  const { data, error } = useQuery<{ ticketOLAs: TicketOLA[] }>(GET_TICKET_OLAS, { variables: { entityType, entityId }, fetchPolicy: 'cache-and-network' })
  const rows = data?.ticketOLAs ?? []
  if (!error && rows.length === 0) return null
  const counting = rows.filter((r) => r.applies)
  const notCounting = rows.filter((r) => !r.applies)
  return (
    <SectionCard title={t('ticketOla.title')} count={counting.length} collapsible defaultOpen={counting.some((r) => r.state !== 'met')}>
      {error && <p role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>{t('ticketOla.loadError', { error: error.message })}</p>}
      {counting.length === 0 && !error && <p style={{ margin: '0 0 8px', color: 'var(--color-slate-light)' }}>{t('ticketOla.noneCounting')}</p>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {counting.map((r) => {
          const state = (r.state ?? 'running') as keyof typeof STATE_TINT
          const tint = STATE_TINT[state] ?? TINT_NEUTRAL
          return (
            <li key={r.contractId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                  <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginRight: 6 }}>{r.type.toUpperCase()}</span>{r.name}
                </div>
                <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
                  {t('ticketOla.target', { team: r.teamName ?? '—', target: olaMinutes(r.resolveMinutes, t), calendar: r.calendarName ?? t('ticketOla.allHours') })}
                </div>
                <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                  {r.concludedAt
                    ? t('ticketOla.concluded', { deadline: formatDateTime(r.deadline), concluded: formatDateTime(r.concludedAt) })
                    : t('ticketOla.deadline', { deadline: formatDateTime(r.deadline) })}
                </div>
              </div>
              <Pill bg={tint.bg} color={tint.color} style={{ fontSize: 'var(--font-size-label)', whiteSpace: 'nowrap' }}>{t(`ticketOla.state.${state}`)}</Pill>
            </li>
          )
        })}
      </ul>
      {notCounting.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('ticketOla.notCountingTitle', { count: notCounting.length })}</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {notCounting.map((r) => (
              <li key={r.contractId}>
                {r.reason === 'created_before_contract'
                  ? t('ticketOla.reason.created_before_contract', { name: r.name })
                  : t('ticketOla.reason.other_team', { name: r.name, team: r.teamName ?? '—' })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  )
}
