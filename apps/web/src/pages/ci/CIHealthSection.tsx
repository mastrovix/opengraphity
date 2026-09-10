/**
 * Sezione "Salute" del dettaglio CI (Event Management): salute dal
 * monitoraggio (`ciHealth`), origine (monitoraggio / forzatura manuale),
 * ultimo evento, allarmi attivi con link alla console filtrata per CI,
 * forzatura manuale (`setCIHealthOverride`, admin/operator), alias del CI
 * (admin) e gli ultimi 5 eventi del CI.
 *
 * Aperta di default solo se la salute è nota (health ≠ null).
 */
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Trash2, Plus, Loader2, ExternalLink } from 'lucide-react'
import { QueryError } from '@/components/QueryError'
import { Button } from '@/components/Button'
import { SectionCard } from '@/components/ui/SectionCard'
import { DetailField } from '@/components/ui/DetailField'
import { Pill } from '@/components/ui/Pill'
import { Input, Select, FieldLabel } from '@/components/ui/FormControls'
import { useMe } from '@/hooks/useMe'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_CI_HEALTH, GET_CI_ALIASES, GET_EVENTS } from '@/graphql/queries'
import { SET_CI_HEALTH_OVERRIDE, CREATE_CI_ALIAS, DELETE_CI_ALIAS } from '@/graphql/mutations'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { colors } from '@/lib/tokens'
import { CIHealthBadge, EventStatusBadge } from '@/pages/events/eventShared'
import { CI_ALIAS_KINDS, CI_HEALTHS, type CIHealthInfo, type CIAlias, type CIAliasKind, type CIHealth, type EventRow } from '@/types/events'

const RECENT_LIMIT = 5

const hint: React.CSSProperties = { margin: 0, fontSize: 'var(--font-size-table)', color: colors.slateLight, lineHeight: 1.5 }

export function CIHealthSection({ ciId }: { ciId: string }) {
  const { t } = useTranslation()
  const { role, isAdmin } = useMe()
  const canOverride = role === 'admin' || role === 'operator'
  const overrideId = useId()

  const { data, loading, error, refetch } = useQuery<{ ciHealth: CIHealthInfo }>(GET_CI_HEALTH, { variables: { ciId }, fetchPolicy: 'cache-and-network' })
  // Righe leggere (EventRowFields): qui servono stato, titolo e ultimo visto.
  const { data: eventsData, refetch: refetchEvents } = useQuery<{ events: { items: EventRow[]; total: number } }>(GET_EVENTS, {
    variables: { filter: { ciId }, limit: RECENT_LIMIT, offset: 0 }, fetchPolicy: 'cache-and-network',
  })
  const [setOverride, { loading: overriding }] = useMutation<{ setCIHealthOverride: CIHealthInfo }>(SET_CI_HEALTH_OVERRIDE)

  const info = data?.ciHealth ?? null
  const events = eventsData?.events.items ?? []
  const isManual = info?.healthSource === 'manual'

  // Aperta se la salute è nota: il dato arriva dopo il mount, quindi la scheda
  // segue la query finché l'utente non la apre/chiude a mano.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? (info?.health !== null && info?.health !== undefined)

  async function handleOverride(value: string) {
    const health = value === '' ? null : value
    try {
      await setOverride({ variables: { ciId, health } })
      toast.success(health ? t('toast.monitoring.healthOverridden', { health: t(`events.health.${health}`) }) : t('toast.monitoring.overrideRemoved'))
      void refetch()
    } catch (e) { toast.error(t('toast.events.actionFailed', { error: errorMessage(e) })) }
  }

  const consoleLink = `/events?ciId=${ciId}`

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
                  <Link to={consoleLink} style={{ color: colors.brand, textDecoration: 'none', fontSize: 'var(--font-size-table)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {t('monitoring.ciHealth.viewEvents')} <ExternalLink size={11} aria-hidden="true" />
                  </Link>
                </span>
              }
            />
          </div>

          {canOverride && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
              <div style={{ flex: '0 0 220px' }}>
                <FieldLabel htmlFor={overrideId}>{t('monitoring.ciHealth.override')}</FieldLabel>
                <Select id={overrideId} value={isManual && info.health ? info.health : ''} onChange={(e) => void handleOverride(e.target.value)} disabled={overriding}>
                  <option value="">{t('monitoring.ciHealth.overrideNone')}</option>
                  {CI_HEALTHS.map((h: CIHealth) => <option key={h} value={h}>{t(`events.health.${h}`)}</option>)}
                </Select>
              </div>
              {isManual && (
                <Button variant="secondary" size="xs" disabled={overriding} onClick={() => void handleOverride('')}>{t('monitoring.ciHealth.removeOverride')}</Button>
              )}
              <p style={{ ...hint, flexBasis: '100%' }}>{t('monitoring.ciHealth.overrideHint')}</p>
            </div>
          )}
        </>
      )}

      <AliasList ciId={ciId} canEdit={isAdmin} />

      <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
        <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{t('monitoring.ciHealth.recentEvents')}</div>
        {events.length === 0
          ? <p style={hint}>{t('monitoring.ciHealth.noEvents')}</p>
          : (
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

// ── Alias del CI ─────────────────────────────────────────────────────────────

function AliasList({ ciId, canEdit }: { ciId: string; canEdit: boolean }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const kindId = useId()
  const valueId = useId()
  const [kind, setKind] = useState<CIAliasKind>('hostname')
  const [value, setValue] = useState('')

  const { data, loading, error, refetch } = useQuery<{ ciAliases: CIAlias[] }>(GET_CI_ALIASES, { variables: { ciId } })
  const [deleteAlias] = useMutation(DELETE_CI_ALIAS)
  const [createAlias, { loading: creating }] = useMutation(CREATE_CI_ALIAS)
  const aliases = data?.ciAliases ?? []

  async function handleDelete(alias: CIAlias) {
    const ok = await confirm({ title: t('events.aliases.deleteTitle'), body: `${alias.kind}: ${alias.value}`, danger: true })
    if (!ok) return
    try {
      await deleteAlias({ variables: { id: alias.id } })
      toast.success(t('toast.events.aliasDeleted'))
      void refetch()
    } catch (err) { toast.error(t('toast.events.actionFailed', { error: errorMessage(err) })) }
  }

  async function handleCreate() {
    const v = value.trim()
    if (!v) return
    try {
      await createAlias({ variables: { ciId, kind, value: v } })
      toast.success(t('toast.events.aliasCreated'))
      setValue('')
      void refetch()
    } catch (err) { toast.error(t('toast.events.actionFailed', { error: errorMessage(err) })) }
  }

  return (
    <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
      <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{t('monitoring.ciHealth.aliases')}</div>
      <p style={{ ...hint, marginBottom: 8 }}>{t('monitoring.ciHealth.aliasesHint')}</p>
      {error && <QueryError message={error.message} onRetry={() => void refetch()} />}
      {!error && loading && !data && <p style={hint}>{t('common.loading')}</p>}
      {!error && data && aliases.length === 0 && <p style={hint}>{t('events.aliases.empty')}</p>}
      {aliases.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {aliases.map((a) => (
            <li key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)' }}>
              <Pill bg="var(--color-info-bg)" color="#2563eb" style={{ fontSize: 'var(--font-size-label)' }}>{t(`events.aliases.kind.${a.kind}`)}</Pill>
              <span style={{ fontFamily: 'monospace', color: colors.slateDark, wordBreak: 'break-all' }}>{a.value}</span>
              <span style={{ color: colors.slateLight, marginLeft: 'auto', whiteSpace: 'nowrap' }} title={formatDateTime(a.createdAt)}>{a.source}</span>
              {canEdit && (
                <Button variant="danger" size="xs" aria-label={t('events.aliases.delete', { value: a.value })} title={t('common.delete')} onClick={() => void handleDelete(a)} style={{ padding: 4 }}>
                  <Trash2 size={13} aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10 }}>
          <div style={{ flex: '0 0 130px' }}>
            <FieldLabel htmlFor={kindId}>{t('events.aliases.kindLabel')}</FieldLabel>
            <Select id={kindId} value={kind} onChange={(e) => setKind(e.target.value as CIAliasKind)} disabled={creating}>
              {CI_ALIAS_KINDS.map((k) => <option key={k} value={k}>{t(`events.aliases.kind.${k}`)}</option>)}
            </Select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <FieldLabel htmlFor={valueId}>{t('events.aliases.valueLabel')}</FieldLabel>
            <Input id={valueId} value={value} onChange={(e) => setValue(e.target.value)} disabled={creating} placeholder={t('events.aliases.valuePlaceholder')} />
          </div>
          <Button size="xs" disabled={creating || !value.trim()} icon={creating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />} onClick={() => void handleCreate()}>
            {t('events.aliases.add')}
          </Button>
        </div>
      )}
    </div>
  )
}
