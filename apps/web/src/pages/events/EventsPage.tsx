/**
 * Console degli allarmi (Event Management, ondata 1): contatori cliccabili,
 * filtri (stato/severità multipli, solo senza CI, ricerca, FilterBuilder),
 * tabella paginata a 50 e azioni per riga per operator/admin.
 * Ondata 3: la colonna "Incident" mostra l'esito della correlazione
 * automatica (chip silenziato/in attesa/collega un CI) e l'azione "Rivaluta ora".
 * Ondata 4: chip "Instabile"/"Tempesta" nella stessa colonna e banner ambra
 * in testa quando una sorgente è in tempesta (`eventStats.stormSources`).
 *
 * Ondata 5 — l'URL è la sorgente di verità dei filtri (`useSearchParams`,
 * `replace: true`): `?stat=` (contatore), `?status=firing,flapping`,
 * `?severity=`, `?orphan=1`, `?q=` (ricerca), `?sourceId=`, `?ciId=`,
 * `?incidentId=`, `?changeId=` (allarmi silenziati da una change), `?page=`
 * (1-based). Un filtro è condivisibile, sopravvive a F5 e a "indietro"; il
 * chip "Solo questo CI" che toglie `ciId` aggiorna l'URL. Il riquadro
 * "Risolti 24h" ricalcola `since` a ogni polling (finestra scorrevole).
 *
 * Aggiornamento: polling ogni 15 s (in pausa a scheda nascosta) + pulsante
 * Aggiorna (l'SSE arriva con un'ondata successiva). Al cambio di filtro o
 * pagina la tabella tiene le righe precedenti con l'indicatore "Aggiornamento…"
 * invece dello skeleton.
 * Il FilterBuilder è applicato lato client alla pagina corrente: `events(filter)`
 * non accetta un gruppo di filtri serializzato (contratto ondata 1); offre
 * solo i campi che la riga leggera (EventRowFields) porta con sé. Quando è
 * attivo il conteggio globale non viene mostrato e sotto la tabella si legge
 * "N di M in questa pagina corrispondono al filtro avanzato".
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'
import { useMe } from '@/hooks/useMe'
import { GET_EVENTS, GET_EVENT_STATS, GET_MONITORING_SOURCE_REFS, GET_EVENT_POLICY } from '@/graphql/queries'
import { applyFilterGroup } from '@/lib/filterGroup'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { ciPath } from '@/lib/ciPath'
import { colors } from '@/lib/tokens'
import { ACCENT, AMBER_BANNER } from '@/lib/eventPalette'
import { pausedWhenHidden, isDocumentHidden } from '@/lib/polling'
import { EventStatusBadge, EventSeverityBadge, EventNoCIBadge, resourceKindLabel } from './eventShared'
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
const DAY_MS          = 24 * 3_600_000

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
  /** Incident (arrivo dal dettaglio incident: allarmi correlati). */
  incidentId: string | null
  /** Change (arrivo dal dettaglio change: allarmi silenziati dalla sua finestra). */
  changeId:   string | null
}

const EMPTY_FILTER: ConsoleFilter = { status: [], severity: [], orphan: false, search: '', since: null, sourceId: null, ciId: null, incidentId: null, changeId: null }

/** Solo i contatori: `stormSources` non è un riquadro. */
type StatKey = keyof EventStatCounts
const STAT_ORDER: StatKey[] = ['firing', 'critical', 'warning', 'orphan', 'suppressed', 'flapping', 'resolved24h']
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
  if (f.incidentId)      vars.incidentId = f.incidentId
  if (f.changeId)        vars.suppressedByChangeId = f.changeId
  return Object.keys(vars).length ? vars : null
}

/** Filtro impostato dal click su un contatore; `now` serve solo a "risolti 24h". */
function presetFor(key: StatKey, now: number): ConsoleFilter {
  switch (key) {
    case 'firing':      return { ...EMPTY_FILTER, status: ['firing'] }
    case 'critical':    return { ...EMPTY_FILTER, status: ['firing'], severity: ['critical'] }
    case 'warning':     return { ...EMPTY_FILTER, status: ['firing'], severity: ['warning'] }
    case 'orphan':      return { ...EMPTY_FILTER, orphan: true }
    case 'suppressed':  return { ...EMPTY_FILTER, status: ['suppressed'] }
    case 'flapping':    return { ...EMPTY_FILTER, status: ['flapping'] }
    case 'resolved24h': return { ...EMPTY_FILTER, status: ['resolved'], since: new Date(now - DAY_MS).toISOString() }
  }
}

// ── URL ↔ filtro ─────────────────────────────────────────────────────────────

const listParam = <T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): T[] =>
  (params.get(name) ?? '').split(',').filter((v): v is T => (allowed as readonly string[]).includes(v))

/** Il filtro letto dall'URL: con `stat` valido il preset del contatore, altrimenti i parametri espliciti; sorgente/CI/incident/change/ricerca si sommano in entrambi i casi. */
function readFilter(params: URLSearchParams, now: number): { filter: ConsoleFilter; stat: StatKey | null; page: number } {
  const statParam = params.get('stat')
  const stat = isStatKey(statParam) ? statParam : null
  const base = stat ? presetFor(stat, now) : {
    ...EMPTY_FILTER,
    status:   listParam(params, 'status', EVENT_STATUSES),
    severity: listParam(params, 'severity', EVENT_SEVERITIES),
    orphan:   params.get('orphan') === '1',
  }
  const pageParam = Number.parseInt(params.get('page') ?? '1', 10)
  return {
    stat,
    page: Number.isFinite(pageParam) && pageParam > 1 ? pageParam - 1 : 0,
    filter: {
      ...base,
      search:     params.get('q') ?? '',
      sourceId:   params.get('sourceId'),
      ciId:       params.get('ciId'),
      incidentId: params.get('incidentId'),
      changeId:   params.get('changeId'),
    },
  }
}

/** Scrive il filtro esplicito nei parametri (senza `stat`, senza `page`). */
function writeFilter(params: URLSearchParams, f: ConsoleFilter): void {
  const setOrDelete = (name: string, value: string | null) => { if (value) params.set(name, value); else params.delete(name) }
  params.delete('stat')
  params.delete('page')
  setOrDelete('status',   f.status.join(','))
  setOrDelete('severity', f.severity.join(','))
  setOrDelete('orphan',   f.orphan ? '1' : null)
  setOrDelete('q',        f.search.trim())
  setOrDelete('sourceId', f.sourceId)
  setOrDelete('ciId',     f.ciId)
  setOrDelete('incidentId', f.incidentId)
  setOrDelete('changeId', f.changeId)
}

const STAT_ACCENT: Record<StatKey, string> = {
  firing:      ACCENT.danger,
  critical:    ACCENT.critical,
  warning:     ACCENT.warning,
  orphan:      ACCENT.neutral,
  suppressed:  ACCENT.muted,
  flapping:    ACCENT.flapping,
  resolved24h: ACCENT.success,
}

function StatTile({ label, value, accent, active, onClick }: { label: string; value: number; accent: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        flex: 1, minWidth: 110, textAlign: 'left', cursor: 'pointer',
        background: colors.white, borderRadius: 10, padding: '12px 16px',
        border: active ? `2px solid ${accent}` : `1px solid ${colors.border}`,
        boxShadow: 'var(--shadow-card)',
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
        background: active ? colors.brandLight : colors.white,
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

  // "Adesso" per la finestra "risolti 24h": avanza a ogni polling (e con
  // Aggiorna), così `since` non resta fermo all'istante del primo click.
  const [clock, setClock] = useState(() => Date.now())

  const [searchParams, setSearchParams] = useSearchParams()
  const { filter, stat: activeStat, page } = useMemo(() => readFilter(searchParams, clock), [searchParams, clock])

  const writeParams = useCallback((mutate: (p: URLSearchParams) => void) => {
    setSearchParams((prev) => { const next = new URLSearchParams(prev); mutate(next); return next }, { replace: true })
  }, [setSearchParams])

  // Qualsiasi modifica esplicita del filtro "materializza" il preset del
  // contatore attivo (il riquadro non è più "il" filtro) e torna alla prima pagina.
  const updateFilter = useCallback((patch: Partial<ConsoleFilter>) => {
    writeParams((p) => writeFilter(p, { ...filter, ...patch, since: null }))
  }, [filter, writeParams])

  // Sorgente, CI, incident, change e ricerca sopravvivono al click sui contatori: sono "dove guardo", non "cosa cerco".
  const applyStat = (key: StatKey) => {
    if (key === 'resolved24h') setClock(Date.now())
    writeParams((p) => {
      writeFilter(p, { ...EMPTY_FILTER, search: filter.search, sourceId: filter.sourceId, ciId: filter.ciId, incidentId: filter.incidentId, changeId: filter.changeId })
      if (activeStat !== key) p.set('stat', key)
    })
  }

  const setPage = useCallback((n: number) => {
    writeParams((p) => { if (n > 0) p.set('page', String(n + 1)); else p.delete('page') })
  }, [writeParams])

  // Ricerca testuale con debounce: la query (e l'URL) partono quando l'utente
  // smette di scrivere; un cambio dell'URL dall'esterno ("indietro") riallinea la casella.
  const [searchInput, setSearchInput] = useState(filter.search)
  useEffect(() => { setSearchInput(filter.search) }, [filter.search])
  useEffect(() => {
    if (searchInput === filter.search) return
    const timer = setTimeout(() => updateFilter({ search: searchInput }), SEARCH_DEBOUNCE)
    return () => clearTimeout(timer)
  }, [searchInput, filter.search, updateFilter])

  // Finestra scorrevole di "risolti 24h": un tick per polling (in pausa a scheda nascosta).
  const sliding = activeStat === 'resolved24h'
  useEffect(() => {
    if (!sliding) return
    const id = setInterval(() => { if (!isDocumentHidden()) setClock(Date.now()) }, POLL_MS)
    return () => clearInterval(id)
  }, [sliding])

  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)

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
  // Con la finestra scorrevole il tick di `clock` cambia già le variabili
  // ogni 15 s: il polling di Apollo sarebbe una seconda richiesta.
  const { data: liveData, previousData, loading, error, refetch } = useQuery<{ events: { items: EventRow[]; total: number } }>(GET_EVENTS, {
    variables: { filter: toFilterVars(filter), limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
    ...(sliding ? {} : pausedWhenHidden(POLL_MS)),
  })
  const data = liveData ?? previousData
  const updating = loading && liveData === undefined && previousData !== undefined

  // Sorgenti: select del filtro + banner "nessuna sorgente" (nessun allarme può
  // arrivare). Riferimenti leggeri (id, nome, connettore): la configurazione
  // completa (monitoringSources) è riservata all'admin nella pagina Sorgenti.
  // Un errore è mostrato accanto al filtro: un select vuoto senza spiegazione
  // sembrerebbe "nessuna sorgente".
  const { data: sourcesData, error: sourcesError } = useQuery<{ monitoringSourceRefs: MonitoringSourceRef[] }>(GET_MONITORING_SOURCE_REFS, { fetchPolicy: 'cache-and-network' })
  const sources = sourcesData?.monitoringSourceRefs ?? []
  const noSources = sourcesData !== undefined && sources.length === 0

  // Policy di correlazione: serve solo al countdown "apertura tra N s" degli
  // eventi in attesa; se non arriva il chip dice comunque "In attesa".
  const { data: policyData } = useQuery<{ eventPolicy: EventPolicy }>(GET_EVENT_POLICY, { fetchPolicy: 'cache-first' })
  const policy = policyData?.eventPolicy ?? null

  const onChanged = () => { if (sliding) setClock(Date.now()); void refetch(); void refetchStats() }

  const rows = useMemo(() => data?.events.items ?? [], [data])
  const items = useMemo(() => applyFilterGroup(rows, filterGroup), [rows, filterGroup])
  const total = data?.events.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const stats = statsData?.eventStats
  const advanced = filterGroup !== null

  // Con il polling il totale può scendere (allarmi risolti, conservazione):
  // la pagina corrente non deve superare l'ultima ("3 / 2", tabella vuota).
  useEffect(() => {
    if (liveData === undefined) return
    const last = Math.max(0, totalPages - 1)
    if (page > last) setPage(last)
  }, [liveData, totalPages, page, setPage])

  const columns: ColumnDef<EventRow>[] = [
    { key: 'status',   label: t('events.columns.status'),   width: '120px', sortable: true, render: (_v, row) => <EventStatusBadge status={row.status} severity={row.severity} /> },
    { key: 'severity', label: t('events.columns.severity'), width: '110px', sortable: true, render: (_v, row) => <EventSeverityBadge severity={row.severity} /> },
    {
      // Il titolo è un link al dettaglio: è lui il bersaglio da tastiera (la
      // riga resta cliccabile con il mouse ma non è focalizzabile, vedi
      // SortableFilterTable `focusableRows`).
      key: 'title', label: t('events.columns.title'), sortable: true,
      render: (_v, row) => (
        <div>
          <Link to={`/events/${row.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600, color: colors.slateDark, textDecoration: 'none' }}>{row.title}</Link>
          <div style={{ fontSize: 'var(--font-size-table)', color: colors.slateLight, marginTop: 2 }}>{resourceKindLabel(t, row.resourceKind)} · {row.resource}</div>
        </div>
      ),
    },
    {
      key: 'ci', label: t('events.columns.ci'), width: '180px',
      render: (_v, row) => row.ci
        ? <Link to={ciPath(row.ci)} onClick={(e) => e.stopPropagation()} style={{ color: colors.brand, textDecoration: 'none', fontWeight: 500 }}>{row.ci.name}</Link>
        : <EventNoCIBadge matchReason={row.matchReason} />,
    },
    { key: 'source',     label: t('events.columns.source'), width: '140px', render: (_v, row) => <span style={{ color: colors.slate }}>{row.source?.name ?? '—'}</span> },
    { key: 'count',      label: t('events.columns.count'),  width: '90px',  sortable: true, render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{String(v)}</span> },
    { key: 'lastSeenAt', label: t('events.columns.lastSeen'), width: '130px', sortable: true, render: (v) => <span style={{ color: colors.slateLight }} title={formatDateTime(String(v))}>{timeAgo(String(v))}</span> },
    {
      // Link all'incident (con icona se l'ha aperto/agganciato il monitoraggio)
      // oppure il chip che spiega perché non c'è: silenziato, in attesa, CI da collegare.
      key: 'incident', label: t('events.columns.incident'), width: '150px',
      render: (_v, row) => <EventIncidentCell event={row} policy={policy} stopRowClick />,
    },
  ]
  if (canAct) {
    columns.push({ key: 'id', label: t('events.columns.actions'), width: '190px', render: (_v, row) => <EventActions event={row} onChanged={onChanged} compact /> })
  }

  return (
    <PageContainer>
      <ListPageHeader
        icon={<Radar size={22} color="var(--color-icon-accent)" />}
        title={t('events.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            {loading && !data ? '—' : advanced ? t('events.filters.advancedActive') : t('events.count', { count: total })}
            {updating && (
              <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: colors.slateLight, fontSize: 'var(--font-size-table)' }}>
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />{t('monitoring.console.updating')}
              </span>
            )}
          </p>
        }
      />

      {noSources && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 14px', marginBottom: 16, background: AMBER_BANNER.bg, border: `1px solid ${AMBER_BANNER.border}`, borderRadius: 8, color: AMBER_BANNER.text, fontSize: 'var(--font-size-body)' }}>
          <Plug size={16} aria-hidden="true" />
          <span style={{ flex: 1 }}>{t('monitoring.console.noSourcesBanner')} {!isAdmin && t('monitoring.console.noSourcesAsk')}</span>
          {isAdmin && <Link to="/monitoring/sources/new" style={{ color: AMBER_BANNER.text, fontWeight: 600 }}>{t('monitoring.console.noSourcesCta')} →</Link>}
        </div>
      )}

      {/* Tempesta in corso: una riga per sorgente, link all'incident di tempesta, ai suoi allarmi e alle Sorgenti. */}
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
        {/* Chip di contesto (arrivo da CI/incident/change): il click li toglie e aggiorna l'URL. */}
        {filter.ciId       && <Chip label={t('monitoring.console.ciFilter')}    active onClick={() => updateFilter({ ciId: null })} />}
        {filter.incidentId && <Chip label={t('events.filters.incidentOnly')}   active onClick={() => updateFilter({ incidentId: null })} />}
        {filter.changeId   && <Chip label={t('events.filters.changeOnly')}     active onClick={() => updateFilter({ changeId: null })} />}
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, marginLeft: 'auto' }}>
          <Select
            aria-label={t('monitoring.console.sourceFilter')}
            value={filter.sourceId ?? ''}
            onChange={(e) => updateFilter({ sourceId: e.target.value || null })}
            style={{ width: 200 }}
          >
            <option value="">{t('monitoring.console.allSources')}</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          {sourcesError && (
            <span role="alert" style={{ fontSize: 'var(--font-size-table)', color: colors.danger, maxWidth: 200 }}>
              {t('events.filters.sourcesError', { error: sourcesError.message })}
            </span>
          )}
        </span>
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
            focusableRows={false}
          />
          {advanced && (
            <p role="status" style={{ margin: '8px 0 0', fontSize: 'var(--font-size-table)', color: colors.slate }}>
              {t('events.filters.advancedMatch', { count: items.length, total: rows.length })}
            </p>
          )}
          <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(page - 1)} onNext={() => setPage(page + 1)} />
        </>
      )}
    </PageContainer>
  )
}
