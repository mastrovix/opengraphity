/**
 * Console degli allarmi (Event Management, ondata 1): contatori cliccabili,
 * filtri (stato/severità multipli, solo senza CI, ricerca, FilterBuilder),
 * tabella paginata a 50 e azioni per riga per operator/admin.
 * Ondata 3: la colonna "Incident" mostra l'esito della correlazione
 * automatica (chip silenziato/in attesa/collega un CI) e l'azione "Rivaluta ora".
 * Ondata 4: chip "Instabile"/"Tempesta" nella stessa colonna e banner ambra
 * in testa quando una sorgente è in tempesta (`eventStats.stormSources`).
 * Servizi monitorati (ondata 3): secondo banner ambra quando almeno un
 * servizio critico è giù (CriticalServicesBanner).
 *
 * Ondata 5 — l'URL è la sorgente di verità dei filtri (`useSearchParams`,
 * `replace: true`): `?stat=` (contatore), `?status=firing,flapping`,
 * `?severity=`, `?orphan=1`, `?q=` (ricerca), `?sourceId=`, `?ciId=`,
 * `?incidentId=`, `?changeId=` (allarmi silenziati da una change), `?page=`
 * (1-based). Un filtro è condivisibile, sopravvive a F5 e a "indietro"; il
 * chip "Solo questo CI" che toglie `ciId` aggiorna l'URL. Il riquadro
 * "Risolti 24h" ricalcola `since` a ogni polling (finestra scorrevole).
 * Revisione 2 (C-15, residuo D·1.7): nell'URL ci sono anche il gruppo del
 * costruttore di filtri (`?f=`, base64url del JSON) e l'ordinamento
 * (`?sort=<campo>&dir=asc|desc`) — prima erano stato del componente e un
 * collegamento condiviso li perdeva. Un `?f=` illeggibile non viene ignorato
 * in silenzio: è una riga `role="alert"` (mostrerebbe più righe di quante il
 * collegamento prometteva).
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
 * Per lo stesso motivo l'ordinamento riguarda la SOLA pagina caricata
 * (`events(filter)` non accetta `sortField`): le intestazioni ordinabili lo
 * dicono nel `title` (D·2.8) invece di far credere a un ordine globale.
 */
import { Chip } from '@/components/ui/Chip'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Radar, RefreshCw, Plug, Loader2 } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { ListPageHeader } from '@/components/ListPageHeader'
import { SortableFilterTable, sortRowsBy, type ColumnDef } from '@/components/SortableFilterTable'
import { listReturnState } from '@/lib/listReturn'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import { Pagination } from '@/components/ui/Pagination'
import { Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { StatTile, StatTileGrid } from '@/components/ui/StatTile'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'
import { useMe } from '@/hooks/useMe'
import { GET_EVENTS, GET_EVENT_STATS, GET_MONITORING_SOURCE_REFS, GET_EVENT_POLICY } from '@/graphql/queries'
import { applyFilterGroup } from '@/lib/filterGroup'
import { FILTER_GROUP_PARAM, decodeFilterGroup, encodeFilterGroup } from '@/lib/filterGroupUrl'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { ciPath } from '@/lib/ciPath'
import { colors } from '@/lib/tokens'
import { ACCENT, AMBER_BANNER } from '@/lib/eventPalette'
import { pausedWhenHidden, isDocumentHidden } from '@/lib/polling'
import { EventStatusBadge, EventSeverityBadge, EventNoCIBadge, resourceKindLabel } from './eventShared'
import { EventIncidentCell } from './eventCorrelation'
import { EventActions } from './EventActions'
import { StormBanner } from './StormBanner'
import { CriticalServicesBanner } from '@/pages/monitoring/CriticalServicesBanner'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import {
  EVENT_STATUSES, EVENT_STATUS_RANK, EVENT_SEVERITIES, EVENT_ROW_SCALAR_FIELDS,
  type EventRow, type EventStats, type EventStatCounts, type EventStatus, type EventSeverity, type EventFilterVars, type MonitoringSourceRef, type EventPolicy,
} from '@/types/events'

/**
 * Le colonne che sono una SCALA e non del testo (revisione totale · G-EVT-7):
 * l'ordinamento le segue invece di confrontare le parole, altrimenti
 * «Severita crescente» risponde critical, info, warning. Le stesse scale
 * vanno sulle `ColumnDef`, cosi la tabella non controllata ordina uguale.
 */
const COLUMN_RANKS: Readonly<Record<string, readonly string[]>> = {
  status:   EVENT_STATUS_RANK,
  severity: EVENT_SEVERITIES,
}

/** What a column sorts on when its raw value is an object without a name (26 Sep 2026: every column sorts). */
const COLUMN_SORT_VALUES: Readonly<Record<string, (row: EventRow) => unknown>> = {
  incident: (row) => row.incident?.number ?? null,
}

const PAGE_SIZE       = 50
/** Below this the alarm title wraps word by word: it wraps here instead, and the table scrolls (D36). */
const ALARM_TITLE_MIN_WIDTH = 240
const POLL_MS         = 15_000
const SEARCH_DEBOUNCE = 300
const DAY_MS          = 24 * 3_600_000

interface ConsoleFilter {
  status:   EventStatus[]
  severity: EventSeverity[]
  orphan:   boolean
  search:   string
  /** ISO: solo eventi visti dopo questo istante. */
  since:    string | null
  /**
   * ISO: solo eventi RISOLTI dopo questo istante (revisione totale · G-EVT-3).
   * Il riquadro «Risolti 24h» conta su `resolved_at` e il suo filtro usava
   * `since` (visti di recente): un allarme visto tre giorni fa e risolto
   * un'ora prima era nel numero e non nell'elenco.
   */
  resolvedSince: string | null
  /** Sorgente di monitoraggio (select) — null = tutte. */
  sourceId: string | null
  /** CI (arrivo dal dettaglio CI) — null = tutti. */
  ciId:     string | null
  /** Incident (arrivo dal dettaglio incident: allarmi correlati). */
  incidentId: string | null
  /** Change (arrivo dal dettaglio change: allarmi silenziati dalla sua finestra). */
  changeId:   string | null
}

const EMPTY_FILTER: ConsoleFilter = { status: [], severity: [], orphan: false, search: '', since: null, resolvedSince: null, sourceId: null, ciId: null, incidentId: null, changeId: null }

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
  if (f.resolvedSince)   vars.resolvedSince = f.resolvedSince
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
    // G-EVT-3: la stessa domanda del riquadro — risolti nelle ultime 24 ore.
    case 'resolved24h': return { ...EMPTY_FILTER, status: ['resolved'], resolvedSince: new Date(now - DAY_MS).toISOString() }
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

// ── Ordinamento nell'URL ─────────────────────────────────────────────────────

const SORT_PARAM = 'sort'
const SORT_DIR_PARAM = 'dir'

/** Le colonne su cui la tabella ordina: un `?sort=` fuori da qui è un URL scritto a mano e viene ignorato, come `?stat`/`?status`. */
const SORTABLE_KEYS: readonly (keyof EventRow)[] = ['status', 'severity', 'title', 'count', 'lastSeenAt']

interface SortState { field: keyof EventRow | null; dir: 'asc' | 'desc' }

function readSort(params: URLSearchParams): SortState {
  const field = params.get(SORT_PARAM)
  const valid = field !== null && (SORTABLE_KEYS as readonly string[]).includes(field)
  return {
    field: valid ? (field as keyof EventRow) : null,
    dir: params.get(SORT_DIR_PARAM) === 'desc' ? 'desc' : 'asc',
  }
}

/** Scrive il filtro esplicito nei parametri (senza `stat`, senza `page`). Il gruppo avanzato e l'ordinamento restano: sono un'altra dimensione. */
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

/**
 * Un gruppo di filtri: etichetta sopra, chip sotto. L'etichetta era una
 * `legend` con `float: left` dentro un fieldset flex — fuori dal flusso, quindi
 * saliva sopra i chip e i gruppi non si allineavano fra loro; e con un gap
 * uguale a quello fra i chip le due famiglie sembravano una sola fila.
 * Resta un `fieldset`/`legend` (il gruppo ha un nome per i lettori di schermo),
 * ma impaginato a blocco: i chip vivono in una riga loro.
 */
function FilterChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
      <legend style={{ padding: 0, marginBottom: 6, fontSize: 'var(--font-size-table)', color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>{children}</div>
    </fieldset>
  )
}

/** A filter of the console: the app's Chip. */
function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Chip pressed={active} onClick={onClick}>
      {label}
    </Chip>
  )
}

function toggle<T>(list: T[], v: T): T[] { return list.includes(v) ? list.filter((x) => x !== v) : [...list, v] }

export function EventsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // G-EVT-13: i filtri della console, da portare nella scheda e riavere al ritorno.
  const location = useLocation()
  const { can } = useMe()
  const canAct = can('event.work')
  const managesSources = can('config.monitoring')

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
  /**
   * Un chip aggiunto NON allarga la finestra temporale (revisione totale ·
   * G-EVT-5): `since: null` azzerava il taglio del riquadro, quindi dal
   * riquadro «Risolti 24h» aggiungere «critical» dava «tutti i risolti di
   * sempre, critici» — dodici righe diventavano ottocento. La finestra è
   * parte di quello che si sta guardando: si tocca solo se la si tocca.
   */
  const updateFilter = useCallback((patch: Partial<ConsoleFilter>) => {
    writeParams((p) => writeFilter(p, { ...filter, ...patch }))
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
  /**
   * G-EVT-4: l'URL porta il testo TRIMMATO e l'effetto riallineava la casella
   * a quello — così uno spazio finale seguito da una pausa spariva mentre si
   * stava ancora scrivendo («api », pausa, «03» → «api03»). Il riallineamento
   * serve solo quando l'URL cambia da FUORI (indietro, link incollato): lo si
   * riconosce dal fatto che il testo trimmato di chi scrive è già quello.
   */
  useEffect(() => {
    setSearchInput((current) => (current.trim() === filter.search ? current : filter.search))
  }, [filter.search])
  useEffect(() => {
    if (searchInput.trim() === filter.search) return
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

  // Gruppo del costruttore di filtri: sta nell'URL (`?f=`), non nello stato.
  // `invalid` = parametro presente ma illeggibile: si dice, non si ignora.
  const decodedGroup = useMemo(() => decodeFilterGroup(searchParams.get(FILTER_GROUP_PARAM)), [searchParams])
  const groupInvalid = decodedGroup === 'invalid'
  const filterGroup: FilterGroup | null = groupInvalid ? null : decodedGroup

  // Il pannello parte dalle regole dell'URL. `writtenGroup` ricorda l'ultimo
  // valore scritto da qui: se `?f=` cambia da fuori ("indietro", un link
  // incollato) il pannello viene rimontato sulle regole nuove invece di
  // mostrarne altre (stesso accorgimento della casella di ricerca).
  const rawGroup = searchParams.get(FILTER_GROUP_PARAM)
  const writtenGroup = useRef(rawGroup)
  const [builderKey, setBuilderKey] = useState(0)
  useEffect(() => {
    if (rawGroup === writtenGroup.current) return
    writtenGroup.current = rawGroup
    setBuilderKey((k) => k + 1)
  }, [rawGroup])

  const applyGroup = useCallback((group: FilterGroup | null) => {
    const encoded = encodeFilterGroup(group)
    writtenGroup.current = encoded
    writeParams((p) => {
      if (encoded) p.set(FILTER_GROUP_PARAM, encoded); else p.delete(FILTER_GROUP_PARAM)
      p.delete('page')
    })
  }, [writeParams])

  const sort = useMemo(() => readSort(searchParams), [searchParams])
  const onSort = useCallback((field: string, direction: 'asc' | 'desc') => {
    writeParams((p) => { p.set(SORT_PARAM, field); p.set(SORT_DIR_PARAM, direction) })
  }, [writeParams])

  // Solo i campi che la riga leggera porta con sé: una regola su `description`
  // o `labels` non potrebbe essere valutata sulla pagina caricata.
  const { fields: entityFields } = useEntityFields('Event')
  const filterFields = useMemo(() => entityFields.filter((f) => EVENT_ROW_SCALAR_FIELDS.has(f.key)), [entityFields])

  const { data: statsData, error: statsError, refetch: refetchStats } = useQuery<{ eventStats: EventStats }>(GET_EVENT_STATS, {
    ...pausedWhenHidden(POLL_MS), fetchPolicy: METAMODEL_FETCH_POLICY,
  })

  // Al cambio di variabili (filtro, pagina) `liveData` torna undefined: si
  // mostrano le righe precedenti con l'indicatore "Aggiornamento…" al posto
  // dello skeleton, che a ogni click farebbe sfarfallare la tabella.
  // Con la finestra scorrevole il tick di `clock` cambia già le variabili
  // ogni 15 s: il polling di Apollo sarebbe una seconda richiesta.
  const { data: liveData, previousData, loading, error, refetch } = useQuery<{ events: { items: EventRow[]; total: number } }>(GET_EVENTS, {
    variables: { filter: toFilterVars(filter), limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    fetchPolicy: METAMODEL_FETCH_POLICY,
    ...(sliding ? {} : pausedWhenHidden(POLL_MS)),
  })
  const data = liveData ?? previousData
  const updating = loading && liveData === undefined && previousData !== undefined

  // Sorgenti: select del filtro + banner "nessuna sorgente" (nessun allarme può
  // arrivare). Riferimenti leggeri (id, nome, connettore): la configurazione
  // completa (monitoringSources) è riservata all'admin nella pagina Sorgenti.
  // Un errore è mostrato accanto al filtro: un select vuoto senza spiegazione
  // sembrerebbe "nessuna sorgente".
  const { data: sourcesData, error: sourcesError } = useQuery<{ monitoringSourceRefs: MonitoringSourceRef[] }>(GET_MONITORING_SOURCE_REFS, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const sources = sourcesData?.monitoringSourceRefs ?? []
  const noSources = sourcesData !== undefined && sources.length === 0
  /**
   * G-EVT-6: il filtro punta a una sorgente che l'elenco non ha (eliminata, o
   * un id scritto a mano). Si sa solo dopo che le sorgenti sono arrivate.
   */
  const sourceGone = filter.sourceId !== null && sourcesData !== undefined
    && !sources.some((s) => s.id === filter.sourceId)

  // Policy di correlazione: serve solo al countdown "apertura tra N s" degli
  // eventi in attesa; se non arriva il chip dice comunque "In attesa".
  const { data: policyData } = useQuery<{ eventPolicy: EventPolicy }>(GET_EVENT_POLICY, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const policy = policyData?.eventPolicy ?? null

  const onChanged = () => { if (sliding) setClock(Date.now()); void refetch(); void refetchStats() }

  const rows = useMemo(() => data?.events.items ?? [], [data])
  // Filtro avanzato e ordinamento sono ENTRAMBI della sola pagina caricata:
  // prima si scartano le righe, poi si ordina quel che resta.
  const items = useMemo(() => {
    const matching = applyFilterGroup(rows, filterGroup)
    return sort.field === null
      ? matching
      : sortRowsBy(matching, String(sort.field), sort.dir, COLUMN_RANKS[String(sort.field)], COLUMN_SORT_VALUES[String(sort.field)])
  }, [rows, filterGroup, sort])
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

  /*
   * READABLE AT 1280-1440px (D36, tour of 23 Sep 2026): the table was 1284px
   * wide in a 1057px container, and Incident and Actions were out of view.
   * Now the widths are what the content needs, the alarm title never shrinks
   * below a readable width (it wraps there), the incident sits next to the CI
   * it is about, and the actions stay pinned at the right edge while the rest
   * scrolls inside the table's own container.
   */
  const columns: ColumnDef<EventRow>[] = [
    { key: 'status',   label: t('events.columns.status'),   width: '110px', sortable: true, rank: EVENT_STATUS_RANK, render: (_v, row) => (
      // Giro del 14 set 2026 (#50): la presa in carico si registrava ma la riga non lo diceva.
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
        <EventStatusBadge status={row.status} severity={row.severity} />
        {row.acknowledgedAt && <span title={formatDateTime(row.acknowledgedAt)} style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>{t('events.acknowledged')}</span>}
      </span>
    ) },
    { key: 'severity', label: t('events.columns.severity'), width: '100px', sortable: true, rank: EVENT_SEVERITIES, render: (_v, row) => <EventSeverityBadge severity={row.severity} /> },
    {
      // The row opens the alarm, from the mouse and the keyboard, as in every list (26 Sep 2026).
      key: 'title', label: t('events.columns.title'), sortable: true,
      render: (_v, row) => (
        <div style={{ minWidth: ALARM_TITLE_MIN_WIDTH }}>
          <div style={{ fontWeight: 600 }}>{row.title}</div>
          <div style={{ fontSize: 'var(--font-size-table)', color: colors.slateLight, marginTop: 2 }}>{resourceKindLabel(t, row.resourceKind)} · {row.resource}</div>
        </div>
      ),
    },
    {
      key: 'ci', label: t('events.columns.ci'), width: '160px',
      render: (_v, row) => row.ci
        ? <Link to={ciPath(row.ci)} onClick={(e) => e.stopPropagation()} style={{ color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2, fontWeight: 500 }}>{row.ci.name}</Link>
        : <EventNoCIBadge matchReason={row.matchReason} />,
    },
    {
      // Link all'incident (con icona se l'ha aperto/agganciato il monitoraggio)
      // oppure il chip che spiega perché non c'è: silenziato, in attesa, CI da collegare.
      key: 'incident', label: t('events.columns.incident'), width: '140px',
      render: (_v, row) => <EventIncidentCell event={row} policy={policy} stopRowClick />,
    },
    { key: 'source',     label: t('events.columns.source'), width: '120px', render: (_v, row) => <span style={{ color: colors.slate }}>{row.source?.name ?? '—'}</span> },
    { key: 'count',      label: t('events.columns.count'),  width: '110px', sortable: true, render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{String(v)}</span> },
    { key: 'lastSeenAt', label: t('events.columns.lastSeen'), width: '110px', sortable: true, render: (v) => <span style={{ color: colors.slateLight, whiteSpace: 'nowrap' }} title={formatDateTime(String(v))}>{timeAgo(String(v))}</span> },
  ]
  if (canAct) {
    // Pinned at the right edge: the actions stay in view while the table scrolls (D36).
    columns.push({ key: 'id', label: t('events.columns.actions'), width: '170px', sticky: 'end', render: (_v, row) => <EventActions event={row} onChanged={onChanged} compact /> })
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
          <span style={{ flex: 1 }}>{t('monitoring.console.noSourcesBanner')} {!managesSources && t('monitoring.console.noSourcesAsk')}</span>
          {managesSources && <Link to="/monitoring/sources/new" style={{ color: AMBER_BANNER.text, fontWeight: 600 }}>{t('monitoring.console.noSourcesCta')} →</Link>}
        </div>
      )}

      {/* Tempesta in corso: una riga per sorgente, link all'incident di tempesta, ai suoi allarmi e alle Sorgenti. */}
      {stats && <StormBanner sources={stats.stormSources} showSourcesLink={managesSources} />}

      {/* Un servizio critico è giù adesso (Servizi monitorati, ondata 3): niente banner se non ce n'è nessuno. */}
      <CriticalServicesBanner />

      {/* Contatori */}
      {statsError && !stats && <QueryError message={statsError.message} onRetry={() => void refetchStats()} />}
      {stats && (
        // The app's tiles (26 Sep 2026: the console drew its own, label above the number).
        <StatTileGrid>
          {STAT_ORDER.map((key) => (
            <StatTile key={key} label={t(`events.stats.${key}`)} value={stats[key]} accent={STAT_ACCENT[key]} pressed={activeStat === key} onClick={() => applyStat(key)} />
          ))}
        </StatTileGrid>
      )}

      {/* Filtri rapidi: un gruppo per famiglia, etichetta sopra i suoi chip. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px 32px', marginBottom: 12 }}>
        <FilterChipGroup label={t('events.columns.status')}>
          {EVENT_STATUSES.map((s) => (
            <FilterChip key={s} label={t(`events.status.${s}`)} active={filter.status.includes(s)} onClick={() => updateFilter({ status: toggle(filter.status, s) })} />
          ))}
        </FilterChipGroup>
        <FilterChipGroup label={t('events.columns.severity')}>
          {EVENT_SEVERITIES.map((s) => (
            <FilterChip key={s} label={t(`events.severity.${s}`)} active={filter.severity.includes(s)} onClick={() => updateFilter({ severity: toggle(filter.severity, s) })} />
          ))}
        </FilterChipGroup>
        <FilterChipGroup label={t('events.filters.other')}>
          <FilterChip label={t('events.filters.orphanOnly')} active={filter.orphan} onClick={() => updateFilter({ orphan: !filter.orphan })} />
          {/* Chip di contesto (arrivo da CI/incident/change): il click li toglie e aggiorna l'URL. */}
          {filter.ciId       && <FilterChip label={t('monitoring.console.ciFilter')}    active onClick={() => updateFilter({ ciId: null })} />}
          {filter.incidentId && <FilterChip label={t('events.filters.incidentOnly')}   active onClick={() => updateFilter({ incidentId: null })} />}
          {filter.changeId   && <FilterChip label={t('events.filters.changeOnly')}     active onClick={() => updateFilter({ changeId: null })} />}
          {/* G-EVT-6: il filtro su una sorgente che non esiste piu si toglie da qui. */}
          {sourceGone        && <FilterChip label={t('events.filters.sourceGoneClear')} active onClick={() => updateFilter({ sourceId: null })} />}
        </FilterChipGroup>
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, marginLeft: 'auto' }}>
          <Select
            aria-label={t('monitoring.console.sourceFilter')}
            value={filter.sourceId ?? ''}
            onChange={(e) => updateFilter({ sourceId: e.target.value || null })}
            style={{ width: 200 }}
          >
            <option value="">{t('monitoring.console.allSources')}</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {/**
              * Una sorgente che non c'e piu resta nel menu come voce sua
              * (revisione totale · G-EVT-6): `?sourceId=` non veniva
              * confrontato con le sorgenti, quindi un link a una sorgente
              * eliminata mostrava «Tutte le sorgenti» con il filtro ATTIVO —
              * zero righe e nessuna spiegazione. Cosi si vede che c'e un
              * filtro, e il chip qui sotto lo toglie.
              */}
            {sourceGone && <option value={filter.sourceId ?? ''}>{t('events.filters.sourceGoneClear')}</option>}
          </Select>
          {sourceGone && (
            <span role="alert" style={{ fontSize: 'var(--font-size-table)', color: colors.danger, maxWidth: 200 }}>
              {t('events.filters.sourceGone')}
            </span>
          )}
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

      <FilterBuilder key={builderKey} fields={filterFields} initialRules={filterGroup?.rules} onApply={applyGroup} />

      {/* `?f=` presente ma illeggibile: la tabella mostra PIÙ righe di quante il collegamento prometteva, e lo dice. */}
      {groupInvalid && (
        <p role="alert" style={{ margin: '-8px 0 16px', fontSize: 'var(--font-size-table)', color: colors.danger }}>
          {t('events.filters.advancedUrlInvalid')}
        </p>
      )}

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
            // G-EVT-13: la scheda deve sapere con quali filtri si e arrivati.
            onRowClick={(row) => navigate(`/events/${row.id}`, { state: listReturnState(location.search) })}
            onSort={onSort}
            sortField={sort.field === null ? null : String(sort.field)}
            sortDir={sort.dir}
            sortHint={t('events.filters.sortPageOnly')}
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
