/**
 * Sezione "Salute" del dettaglio CI (Event Management): salute dal
 * monitoraggio (`ciHealth`), origine (monitoraggio / forzatura manuale),
 * ultimo evento, allarmi attivi con link alla console filtrata per CI,
 * forzatura manuale (`setCIHealthOverride`, admin/operator: si sceglie nel
 * select e si conferma con "Applica" — la forzatura genera audit, notifiche e
 * cambia topologia e Salute CI, non deve partire scorrendo le opzioni con le
 * frecce), alias del CI (CIAliasesSection condivisa con il dettaglio evento,
 * modifica solo admin) e gli ultimi 5 allarmi del CI.
 *
 * Aperta di default solo se la salute è nota (health ≠ null). Ogni query ha
 * il suo errore visibile: un errore sugli ultimi allarmi non diventa "nessun allarme".
 */
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowRight, Loader2 } from 'lucide-react'
import { QueryError } from '@/components/QueryError'
import { Button } from '@/components/Button'
import { SectionCard } from '@/components/ui/SectionCard'
import { DetailField } from '@/components/ui/DetailField'
import { Select, FieldLabel } from '@/components/ui/FormControls'
import { useMe } from '@/hooks/useMe'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_CI_HEALTH, GET_EVENTS } from '@/graphql/queries'
import { SET_CI_HEALTH_OVERRIDE } from '@/graphql/mutations'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { colors } from '@/lib/tokens'
import { CIHealthBadge, EventStatusBadge } from '@/pages/events/eventShared'
import { CIAliasesSection } from '@/pages/events/CIAliasesSection'
import { CI_HEALTHS, type CIHealthInfo, type CIHealth, type EventRow } from '@/types/events'

const RECENT_LIMIT = 5

const hint: React.CSSProperties = { margin: 0, fontSize: 'var(--font-size-table)', color: colors.slateLight, lineHeight: 1.5 }

export function CIHealthSection({ ciId, ciName }: { ciId: string; ciName: string }) {
  const { t } = useTranslation()
  const { role, isAdmin } = useMe()
  const canOverride = role === 'admin' || role === 'operator'
  const overrideId = useId()

  const { data, loading, error, refetch } = useQuery<{ ciHealth: CIHealthInfo }>(GET_CI_HEALTH, { variables: { ciId }, fetchPolicy: 'cache-and-network' })
  // Righe leggere (EventRowFields): qui servono stato, titolo e ultimo visto.
  const { data: eventsData, error: eventsError, refetch: refetchEvents } = useQuery<{ events: { items: EventRow[]; total: number } }>(GET_EVENTS, {
    variables: { filter: { ciId }, limit: RECENT_LIMIT, offset: 0 }, fetchPolicy: 'cache-and-network',
  })
  const [setOverride, { loading: overriding }] = useMutation<{ setCIHealthOverride: CIHealthInfo }>(SET_CI_HEALTH_OVERRIDE)

  const info = data?.ciHealth ?? null
  const events = eventsData?.events.items ?? []
  const isManual = info?.healthSource === 'manual'
  /** Valore della forzatura in vigore ('' = nessuna): il select parte da qui e "Applica" si accende solo se cambia. */
  const currentOverride = isManual && info?.health ? info.health : ''

  // Aperta se la salute è nota: il dato arriva dopo il mount, quindi la scheda
  // segue la query finché l'utente non la apre/chiude a mano.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? (info?.health !== null && info?.health !== undefined)

  // Scelta nel select non ancora applicata (null = segue il valore in vigore).
  const [draft, setDraft] = useState<string | null>(null)
  const selected = draft ?? currentOverride
  const dirty = selected !== currentOverride

  async function applyOverride(value: string) {
    const health = value === '' ? null : value
    try {
      await setOverride({ variables: { ciId, health } })
      toast.success(health ? t('toast.monitoring.healthOverridden', { health: t(`events.health.${health}`) }) : t('toast.monitoring.overrideRemoved'))
      setDraft(null)
      void refetch()
    } catch (e) { toast.error(t('toast.events.actionFailed', { error: errorMessage(e) })) }
  }

  const consoleLink = `/events?ciId=${encodeURIComponent(ciId)}`

  return (
    <SectionCard
      title={t('monitoring.ciHealth.title')}
      open={open}
      onToggle={() => setUserOpen(!open)}
      headerRight={info?.health ? <CIHealthBadge health={info.health} /> : undefined}
    >
      {error && !data && <QueryError message={error.message} onRetry={() => void refetch()} />}
      {loading && !data && <p style={hint}>{t('common.loading')}</p>}
      {info && (
        <>
          {info.health === null && <p style={{ ...hint, fontSize: 'var(--font-size-body)' }}>{t('monitoring.ciHealth.noHealth')}</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <DetailField label={t('monitoring.ciHealth.title')} value={info.health ? <CIHealthBadge health={info.health} /> : t('events.health.unknown')} />
            <DetailField label={t('monitoring.ciHealth.source')} value={info.healthSource ? (isManual ? t('monitoring.ciHealth.sourceManual') : t('monitoring.ciHealth.sourceMonitoring')) : null} />
            <DetailField label={t('monitoring.ciHealth.lastEvent')} value={info.lastEventAt ? `${formatDateTime(info.lastEventAt)} · ${timeAgo(info.lastEventAt)}` : null} />
            <DetailField
              label={t('monitoring.ciHealth.activeEvents')}
              value={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ color: info.firingEvents > 0 ? colors.danger : colors.slateDark }}>{info.firingEvents}</strong>
                  {/* Link interno alla console: freccia, non l'icona "nuova finestra". */}
                  <Link to={consoleLink} style={{ color: colors.brand, textDecoration: 'none', fontSize: 'var(--font-size-table)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {t('monitoring.ciHealth.viewEvents')} <ArrowRight size={11} aria-hidden="true" />
                  </Link>
                </span>
              }
            />
          </div>

          {canOverride && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
              <div style={{ flex: '0 0 220px' }}>
                <FieldLabel htmlFor={overrideId}>{t('monitoring.ciHealth.override')}</FieldLabel>
                <Select id={overrideId} value={selected} onChange={(e) => setDraft(e.target.value)} disabled={overriding}>
                  <option value="">{t('monitoring.ciHealth.overrideNone')}</option>
                  {CI_HEALTHS.map((h: CIHealth) => <option key={h} value={h}>{t(`events.health.${h}`)}</option>)}
                </Select>
              </div>
              <Button size="xs" disabled={overriding || !dirty} icon={overriding ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined} onClick={() => void applyOverride(selected)}>
                {t('common.apply')}
              </Button>
              {isManual && (
                <Button variant="secondary" size="xs" disabled={overriding} onClick={() => void applyOverride('')}>{t('monitoring.ciHealth.removeOverride')}</Button>
              )}
              <p style={{ ...hint, flexBasis: '100%' }}>{t('monitoring.ciHealth.overrideHint')}</p>
            </div>
          )}
        </>
      )}

      <CIAliasesSection ci={{ id: ciId, name: ciName }} canEdit={isAdmin} variant="inline" />

      <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
        <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{t('monitoring.ciHealth.recentEvents')}</div>
        {eventsError && !eventsData && <QueryError message={eventsError.message} onRetry={() => void refetchEvents()} />}
        {!eventsError && !eventsData && <p style={hint}>{t('common.loading')}</p>}
        {eventsData && events.length === 0 && <p style={hint}>{t('monitoring.ciHealth.noEvents')}</p>}
        {events.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {events.map((ev) => (
              <li key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)' }}>
                <EventStatusBadge status={ev.status} severity={ev.severity} />
                <Link to={`/events/${ev.id}`} style={{ color: colors.brand, textDecoration: 'none', fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</Link>
                <span style={{ color: colors.slateLight, whiteSpace: 'nowrap' }} title={formatDateTime(ev.lastSeenAt)}>{timeAgo(ev.lastSeenAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {events.length > 0 && <Button variant="ghost" size="xs" onClick={() => void refetchEvents()} style={{ marginTop: 6, color: colors.slateLight, fontSize: 'var(--font-size-table)' }}>{t('monitoring.console.refresh')}</Button>}
      </div>
    </SectionCard>
  )
}
