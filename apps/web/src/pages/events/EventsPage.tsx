/**
 * Console degli eventi (Event Management, ondata 1): contatori cliccabili,
 * filtri (stato/severità multipli, solo orfani, ricerca, FilterBuilder),
 * tabella paginata a 50 e azioni per riga per operator/admin.
 * Ondata 3: la colonna "Incident" mostra l'esito della correlazione
 * automatica (chip silenziato/in attesa/collega un CI) e l'azione "Rivaluta ora".
 * Ondata 4: chip "Instabile"/"Tempesta" nella stessa colonna e banner ambra
 * in testa quando una sorgente è in tempesta (`eventStats.stormSources`).
 *
 * Aggiornamento: polling ogni 15 s (in pausa a scheda nascosta) + pulsante
 * Aggiorna (l'SSE arriva con un'ondata successiva). Al cambio di filtro o
 * pagina la tabella tiene le righe precedenti con l'indicatore "Aggiornamento…"
 * invece dello skeleton. Filtri iniziali dalla query string: `?stat=critical`
 * (widget dashboard), `?sourceId=` (sorgenti), `?ciId=` (dettaglio CI).
 * Il FilterBuilder è applicato lato client alla pagina corrente: `events(filter)`
 * non accetta un gruppo di filtri serializzato (contratto ondata 1); offre
 * solo i campi che la riga leggera (EventRowFields) porta con sé.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Radar, RefreshCw, Plug, Loader2 } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { ListPageHeader } from '@/components/ListPageHeader'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import { Pagination } from '@/components/ui/Pagination'
import { Pill } from '@/components/ui/Pill'
import { Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'
import { useMe } from '@/hooks/useMe'
import { GET_EVENTS, GET_EVENT_STATS, GET_MONITORING_SOURCE_REFS, GET_EVENT_POLICY } from '@/graphql/queries'
import { applyFilterGroup } from '@/lib/filterGroup'
import { timeAgo } from '@/lib/datetime'
import { ciPath } from '@/lib/ciPath'
import { colors } from '@/lib/tokens'
import { pausedWhenHidden } from '@/lib/polling'
import { EventStatusBadge, EventSeverityBadge } from './eventShared'
import { EventIncidentCell } from './eventCorrelation'
import { EventActions } from './EventActions'
import { StormBanner } from './StormBanner'
import {
  EVENT_STATUSES, EVENT_SEVERITIES, EVENT_ROW_SCALAR_FIELDS,
  type EventRow, type EventStats, type EventStatCounts, type EventStatus, type EventSeverity, type EventFilterVars, type MonitoringSourceRef, type EventPolicy,
} from '@/types/events'

const PAGE_SIZE       = 50
const POLL_MS         = 15_000
const SEARCH_DEBOUNCE = 300

interface ConsoleFilter {
  status:   EventStatus[]
  severity: EventSeverity[]
  orphan:   boolean
  search:   string
  /** ISO: solo eventi visti dopo questo istante (riquadro "risolti 24h"). */
  since:    string | null
  /** Sorgente di monitoraggio (select) — null = tutte. */
  sourceId: string | null
  /** CI (arrivo dal dettaglio CI) — null = tutti. */
  ciId:     string | null
}

const EMPTY_FILTER: ConsoleFilter = { status: [], severity: [], orphan: false, search: '', since: null, sourceId: null, ciId: null }

const isStatKey = (v: string | null): v is StatKey => v !== null && (STAT_ORDER as string[]).includes(v)

/** Variabili GraphQL: solo i campi valorizzati (un array vuoto non è un filtro). */
function toFilterVars(f: ConsoleFilter): EventFilterVars | null {
  const vars: EventFilterVars = {}
  if (f.status.length)   vars.status   = f.status
  if (f.severity.length) vars.severity = f.severity
  if (f.orphan)          vars.orphan   = true
  if (f.search.trim())   vars.search   = f.search.trim()
  if (f.since)           vars.since    = f.since
  if (f.sourceId)        vars.sourceId = f.sourceId
  if (f.ciId)            vars.ciId     = f.ciId
  return Object.keys(vars).length ? vars : null
}

/** Solo i contatori: `stormSources` non è un riquadro. */
type StatKey = keyof EventStatCounts

/** Filtro impostato dal click su un contatore. */
function presetFor(key: StatKey): ConsoleFilter {
  switch (key) {
    case 'firing':      return { ...EMPTY_FILTER, status: ['firing'] }
    case 'critical':    return { ...EMPTY_FILTER, status: ['firing'], severity: ['critical'] }
    case 'warning':     return { ...EMPTY_FILTER, status: ['firing'], severity: ['warning'] }
    case 'orphan':      return { ...EMPTY_FILTER, orphan: true }
    case 'suppressed':  return { ...EMPTY_FILTER, status: ['suppressed'] }
    case 'flapping':    return { ...EMPTY_FILTER, status: ['flapping'] }
    case 'resolved24h': return { ...EMPTY_FILTER, status: ['resolved'], since: new Date(Date.now() - 24 * 3_600_000).toISOString() }
  }
}

const STAT_ACCENT: Record<StatKey, string> = {
  firing:      colors.danger,
  critical:    '#b91c1c',
  warning:     '#b45309',
  orphan:      colors.slate,
  suppressed:  colors.slateLight,
  flapping:    '#6d28d9',
  resolved24h: '#15803d',
}

const STAT_ORDER: StatKey[] = ['firing', 'critical', 'warning', 'orphan', 'suppressed', 'flapping', 'resolved24h']

function StatTile({ label, value, accent, active, onClick }: { label: string; value: number; accent: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        flex: 1, minWidth: 110, textAlign: 'left', cursor: 'pointer',
        background: '#fff', borderRadius: 10, padding: '12px 16px',
        border: active ? `2px solid ${accent}` : '1px solid #e5e7eb',
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
        font: 'inherit',
      }}
    >
      <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 700, color: accent }}>{value}</div>
    </button>
  )
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        padding: '4px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 'var(--font-size-body)',
        border: `1px solid ${active ? colors.brand : colors.border}`,
        background: active ? colors.brandLight : '#fff',
        color: active ? colors.brand : colors.slate,
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  )
}

function toggle<T>(list: T[], v: T): T[] { return list.includes(v) ? list.filter((x) => x !== v) : [...list, v] }

export function EventsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { role, isAdmin } = useMe()
  const canAct = role === 'admin' || role === 'operator'

  // Filtri iniziali dalla query string (letti una volta al mount).
  const [searchParams] = useSearchParams()
  const initialStat = isStatKey(searchParams.get('stat')) ? (searchParams.get('stat') as StatKey) : null
  const [filter, setFilter] = useState<ConsoleFilter>(() => ({
    ...(initialStat ? presetFor(initialStat) : EMPTY_FILTER),
    sourceId: searchParams.get('sourceId'),
    ciId:     searchParams.get('ciId'),
  }))
  const [searchInput, setSearchInput] = useState('')
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [activeStat, setActiveStat] = useState<StatKey | null>(initialStat)

  // Ricerca testuale con debounce: la query parte quando l'utente smette di scrivere.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilter((f) => (f.search === searchInput ? f : { ...f, search: searchInput }))
      setPage(0)
    }, SEARCH_DEBOUNCE)
    return () => clearTimeout(timer)
  }, [searchInput])

  const updateFilter = (patch: Partial<ConsoleFilter>) => {
    setFilter((f) => ({ ...f, ...patch, since: patch.since === undefined ? null : patch.since }))
    setActiveStat(null)
    setPage(0)
  }

  // Sorgente e CI sopravvivono al click sui contatori: sono "dove guardo", non "cosa cerco".
  const applyStat = (key: StatKey) => {
    const keep = { search: filter.search, sourceId: filter.sourceId, ciId: filter.ciId }
    if (activeStat === key) { setFilter({ ...EMPTY_FILTER, ...keep }); setActiveStat(null) }
    else { setFilter({ ...presetFor(key), ...keep }); setActiveStat(key) }
    setPage(0)
  }

  // Solo i campi che la riga leggera porta con sé: una regola su `description`
  // o `labels` non potrebbe essere valutata sulla pagina caricata.
  const { fields: entityFields } = useEntityFields('Event')
  const filterFields = useMemo(() => entityFields.filter((f) => EVENT_ROW_SCALAR_FIELDS.has(f.key)), [entityFields])

  const { data: statsData, error: statsError, refetch: refetchStats } = useQuery<{ eventStats: EventStats }>(GET_EVENT_STATS, {
    ...pausedWhenHidden(POLL_MS), fetchPolicy: 'cache-and-network',
  })

  // Al cambio di variabili (filtro, pagina) `liveData` torna undefined: si
  // mostrano le righe precedenti con l'indicatore "Aggiornamento…" al posto
  // dello skeleton, che a ogni click farebbe sfarfallare la tabella.
  const { data: liveData, previousData, loading, error, refetch } = useQuery<{ events: { items: EventRow[]; total: number } }>(GET_EVENTS, {
    variables: { filter: toFilterVars(filter), limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
    ...pausedWhenHidden(POLL_MS),
  })
  const data = liveData ?? previousData
  const updating = loading && liveData === undefined && previousData !== undefined

  // Sorgenti: select del filtro + banner "nessuna sorgente" (nessun allarme può
  // arrivare). Riferimenti leggeri (id, nome, connettore): la configurazione
  // completa (monitoringSources) è riservata all'admin nella pagina Sorgenti.
  const { data: sourcesData } = useQuery<{ monitoringSourceRefs: MonitoringSourceRef[] }>(GET_MONITORING_SOURCE_REFS, { fetchPolicy: 'cache-and-network' })
  const sources = sourcesData?.monitoringSourceRefs ?? []
  const noSources = sourcesData !== undefined && sources.length === 0

  // Policy di correlazione: serve solo al countdown "apertura tra N s" degli
  // eventi in attesa; se non arriva il chip dice comunque "In attesa".
  const { data: policyData } = useQuery<{ eventPolicy: EventPolicy }>(GET_EVENT_POLICY, { fetchPolicy: 'cache-first' })
  const policy = policyData?.eventPolicy ?? null

  const onChanged = () => { void refetch(); void refetchStats() }

  const items = useMemo(() => applyFilterGroup(data?.events.items ?? [], filterGroup), [data, filterGroup])
  const total = data?.events.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const stats = statsData?.eventStats

  const columns: ColumnDef<EventRow>[] = [
    { key: 'status',   label: t('events.columns.status'),   width: '120px', sortable: true, render: (_v, row) => <EventStatusBadge status={row.status} severity={row.severity} /> },
    { key: 'severity', label: t('events.columns.severity'), width: '110px', sortable: true, render: (_v, row) => <EventSeverityBadge severity={row.severity} /> },
    {
      key: 'title', label: t('events.columns.title'), sortable: true,
      render: (_v, row) => (
        <div>
          <div style={{ fontWeight: 600, color: colors.slateDark }}>{row.title}</div>
          <div style={{ fontSize: 'var(--font-size-table)', color: colors.slateLight, marginTop: 2 }}>{row.resourceKind} · {row.resource}</div>
        </div>
      ),
    },
    {
      key: 'ci', label: t('events.columns.ci'), width: '180px',
      render: (_v, row) => row.ci
        ? <Link to={ciPath(row.ci)} onClick={(e) => e.stopPropagation()} style={{ color: colors.brand, textDecoration: 'none', fontWeight: 500 }}>{row.ci.name}</Link>
        : <Pill bg="var(--color-slate-bg)" color="var(--color-slate)" style={{ fontSize: 'var(--font-size-label)' }}>{t('events.orphan')}</Pill>,
    },
    { key: 'source',     label: t('events.columns.source'), width: '140px', render: (_v, row) => <span style={{ color: colors.slate }}>{row.source?.name ?? '—'}</span> },
    { key: 'count',      label: t('events.columns.count'),  width: '80px',  sortable: true, render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{String(v)}</span> },
    { key: 'lastSeenAt', label: t('events.columns.lastSeen'), width: '130px', sortable: true, render: (v) => <span style={{ color: colors.slateLight }}>{timeAgo(String(v))}</span> },
    {
      // Link all'incident (con icona se l'ha aperto/agganciato il monitoraggio)
      // oppure il chip che spiega perché non c'è: silenziato, in attesa, CI da collegare.
      key: 'incident', label: t('events.columns.incident'), width: '150px',
      render: (_v, row) => <EventIncidentCell event={row} policy={policy} stopRowClick />,
    },
  ]
  if (canAct) {
    columns.push({ key: 'id', label: t('events.columns.actions'), render: (_v, row) => <EventActions event={row} onChanged={onChanged} /> })
  }

  return (
    <PageContainer>
      <ListPageHeader
        icon={<Radar size={22} color="var(--color-icon-accent)" />}
        title={t('events.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            {loading && !data ? '—' : t('events.count', { count: total })}
            {updating && (
              <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: colors.slateLight, fontSize: 'var(--font-size-table)' }}>
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />{t('monitoring.console.updating')}
              </span>
            )}
          </p>
        }
      />

      {noSources && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 14px', marginBottom: 16, background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 8, color: '#854d0e', fontSize: 'var(--font-size-body)' }}>
          <Plug size={16} aria-hidden="true" />
          <span style={{ flex: 1 }}>{t('monitoring.console.noSourcesBanner')} {!isAdmin && t('monitoring.console.noSourcesAsk')}</span>
          {isAdmin && <Link to="/monitoring/sources/new" style={{ color: '#854d0e', fontWeight: 600 }}>{t('monitoring.console.noSourcesCta')} →</Link>}
        </div>
      )}

      {/* Tempesta in corso: una riga per sorgente, link all'incident di tempesta e alle Sorgenti. */}
      {stats && <StormBanner sources={stats.stormSources} showSourcesLink={isAdmin} />}

      {/* Contatori */}
      {statsError && !stats && <QueryError message={statsError.message} onRetry={() => void refetchStats()} />}
      {stats && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
          {STAT_ORDER.map((key) => (
            <StatTile key={key} label={t(`events.stats.${key}`)} value={stats[key]} accent={STAT_ACCENT[key]} active={activeStat === key} onClick={() => applyStat(key)} />
          ))}
        </div>
      )}

      {/* Filtri rapidi */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginBottom: 12 }}>
        <fieldset style={{ display: 'flex', gap: 6, alignItems: 'center', border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ float: 'left', marginRight: 6, fontSize: 'var(--font-size-table)', color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('events.columns.status')}</legend>
          {EVENT_STATUSES.map((s) => (
            <Chip key={s} label={t(`events.status.${s}`)} active={filter.status.includes(s)} onClick={() => updateFilter({ status: toggle(filter.status, s) })} />
          ))}
        </fieldset>
        <fieldset style={{ display: 'flex', gap: 6, alignItems: 'center', border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ float: 'left', marginRight: 6, fontSize: 'var(--font-size-table)', color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('events.columns.severity')}</legend>
          {EVENT_SEVERITIES.map((s) => (
            <Chip key={s} label={t(`events.severity.${s}`)} active={filter.severity.includes(s)} onClick={() => updateFilter({ severity: toggle(filter.severity, s) })} />
          ))}
        </fieldset>
        <Chip label={t('events.filters.orphanOnly')} active={filter.orphan} onClick={() => updateFilter({ orphan: !filter.orphan })} />
        {filter.ciId && <Chip label={t('monitoring.console.ciFilter')} active onClick={() => updateFilter({ ciId: null })} />}
        <Select
          aria-label={t('monitoring.console.sourceFilter')}
          value={filter.sourceId ?? ''}
          onChange={(e) => updateFilter({ sourceId: e.target.value || null })}
          style={{ width: 200, marginLeft: 'auto' }}
        >
          <option value="">{t('monitoring.console.allSources')}</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Input
          aria-label={t('events.filters.search')}
          placeholder={t('events.filters.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{ width: 240 }}
        />
        <Button variant="secondary" size="xs" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={onChanged}>{t('monitoring.console.refresh')}</Button>
      </div>

      <FilterBuilder fields={filterFields} onApply={(group) => { setFilterGroup(group) }} />

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          <SortableFilterTable<EventRow>
            columns={columns}
            data={items}
            loading={loading && !data}
            label={t('events.title')}
            emptyComponent={<EmptyState icon={<Radar size={32} />} title={t('events.empty.title')} description={t('events.empty.description')} />}
            onRowClick={(row) => navigate(`/events/${row.id}`)}
          />
          <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
        </>
      )}
    </PageContainer>
  )
}
