/**
 * Pagina "Salute CI" (gruppo Monitoraggio, staff): cosa sta male adesso, dal
 * più grave, con chi ne dipende. Prima la voce di menu portava alla topologia
 * con `?health=1`: leggibile per chi conosce la mappa, opaca per tutti gli
 * altri. Qui la stessa informazione è una lista ordinata per gravità e impatto.
 *
 * Struttura: quattro riquadri-contatore (Giù / Degradati / Operativi /
 * Senza monitoraggio; i primi tre filtrano la tabella, il quarto è solo
 * informativo perché `ciHealthOverview.items` elenca SOLO i CI con salute, e
 * rimanda alla CMDB), pannello "tutto bene" quando giù + degradati = 0,
 * filtri (tipo dal metamodello, ambiente dall'enum base, squadra, ricerca con
 * debounce) e tabella con striscia colorata per riga. Polling ogni 15 s (in
 * pausa a scheda nascosta) + Aggiorna; al cambio di filtro o pagina la tabella
 * tiene le righe precedenti con l'indicatore "Aggiornamento…" invece di
 * svuotarsi.
 *
 * L'URL è la sorgente dei filtri e della pagina (D·1.7: `?health=down&type=
 * server&env=production&team=<id>&q=db&page=2`, scritti con `replace` così
 * "indietro" torna alla pagina precedente e non a ogni clic): il dettaglio CI
 * e un F5 non li perdono, e un link è condivisibile. Se il totale scende sotto
 * la pagina corrente (polling: CI tornati operativi con il filtro "giù") la
 * pagina viene riallineata all'ultima disponibile (D·1.15).
 *
 * "Vedi sulla mappa" (D·1.3) porta alla topologia CON un CI di partenza
 * (`/topology?health=1&ciId=…`): dalla riga il CI della riga, dal pulsante
 * generale la prima riga (le righe sono ordinate per gravità: il primo CI
 * giù, se ce n'è uno); senza righe il pulsante è disabilitato con il motivo.
 *
 * Contratto: `ciHealthOverview` in apps/api/src/graphql/schema-events.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { NetworkStatus } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import {
  HeartPulse, Share2, RefreshCw, XCircle, AlertTriangle, CheckCircle2, EyeOff, Radar, Hand, Plus, Loader2, type LucideIcon,
} from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { ListPageHeader } from '@/components/ListPageHeader'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import { Pagination } from '@/components/ui/Pagination'
import { Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { useMe } from '@/hooks/useMe'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { CIIcon } from '@/lib/ciIcon'
import { ciPath } from '@/lib/ciPath'
import { ciTypeLabelKey, enumLabel, useCIBaseEnums } from '@/lib/ciEnums'
import { timeAgo, formatDateTime, formatDuration, currentLocale } from '@/lib/datetime'
import { pausedWhenHidden } from '@/lib/polling'
import { GET_CI_HEALTH_OVERVIEW, GET_TEAMS } from '@/graphql/queries'
import { CIHealthBadge, CI_HEALTH_ACCENT } from '@/pages/events/eventShared'
import type { CIHealth, CIHealthOverview, CIHealthRow, CIHealthFilterVars } from '@/types/events'

const PAGE_SIZE       = 50
const POLL_MS         = 15_000
const SEARCH_DEBOUNCE = 300
/** Da questo numero di dipendenti in su il chip "Impatto" diventa scuro: un guasto qui si propaga. */
const HIGH_IMPACT     = 5

const CI_HEALTHS: readonly CIHealth[] = ['down', 'degraded', 'operational']
const isCIHealth = (v: string | null): v is CIHealth => v !== null && (CI_HEALTHS as readonly string[]).includes(v)

/** Topologia centrata sul CI con la salute evidenziata (TopologyPage legge `ciId` come CI di partenza). */
export const topologyHealthPath = (ciId: string) => `/topology?health=1&ciId=${encodeURIComponent(ciId)}`

type TileKey = CIHealth | 'unmonitored'
const TILE_ORDER: TileKey[] = ['down', 'degraded', 'operational', 'unmonitored']

/** Palette dei riquadri: stessi rosso/ambra/verde dei badge (CI_HEALTH_ACCENT), grigio per "senza monitoraggio". */
const TILE_STYLE: Record<TileKey, { accent: string; tint: string; icon: LucideIcon }> = {
  down:        { accent: CI_HEALTH_ACCENT.down,        tint: '#fee2e2',               icon: XCircle },
  degraded:    { accent: CI_HEALTH_ACCENT.degraded,    tint: '#fef3c7',               icon: AlertTriangle },
  operational: { accent: CI_HEALTH_ACCENT.operational, tint: '#dcfce7',               icon: CheckCircle2 },
  unmonitored: { accent: 'var(--color-slate)',         tint: 'var(--color-slate-bg)', icon: EyeOff },
}

/** Testo solo per le tecnologie assistive (descrizioni via `aria-describedby`): fuori dal flusso, mai visibile. */
const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
}

interface HealthFilter {
  /** Stato scelto dal riquadro (un solo stato alla volta); null = tutti. */
  health:      CIHealth | null
  type:        string
  environment: string
  team:        string
  search:      string
}

const hasFilter = (f: HealthFilter) => f.health !== null || !!f.type || !!f.environment || !!f.team || !!f.search.trim()

/** Variabili GraphQL: solo i campi valorizzati. */
function toFilterVars(f: HealthFilter): CIHealthFilterVars | null {
  const vars: CIHealthFilterVars = {}
  if (f.health)        vars.health      = [f.health]
  if (f.type)          vars.type        = f.type
  if (f.environment)   vars.environment = f.environment
  if (f.team)          vars.team        = f.team
  if (f.search.trim()) vars.search      = f.search.trim()
  return Object.keys(vars).length ? vars : null
}

// ── URL ──────────────────────────────────────────────────────────────────────

/** Nomi dei parametri: corti perché finiscono nella barra degli indirizzi. */
const URL_KEYS = { health: 'health', type: 'type', environment: 'env', team: 'team', search: 'q', page: 'page' } as const

/**
 * Filtri dall'URL. Un valore di `health` fuori vocabolario viene ignorato
 * (non è un errore dell'app ma un URL scritto a mano: la pagina mostra tutto,
 * e il primo clic su un riquadro lo riscrive).
 */
function filterFromParams(p: URLSearchParams): HealthFilter {
  const health = p.get(URL_KEYS.health)
  return {
    health:      isCIHealth(health) ? health : null,
    type:        p.get(URL_KEYS.type) ?? '',
    environment: p.get(URL_KEYS.environment) ?? '',
    team:        p.get(URL_KEYS.team) ?? '',
    search:      p.get(URL_KEYS.search) ?? '',
  }
}

/** Pagina dall'URL: `page` è 1-based per chi legge l'indirizzo, 0-based nello stato. */
function pageFromParams(p: URLSearchParams): number {
  const n = Number.parseInt(p.get(URL_KEYS.page) ?? '', 10)
  return Number.isFinite(n) && n > 1 ? n - 1 : 0
}

// ── Riquadri ─────────────────────────────────────────────────────────────────

interface TileProps {
  tileKey:  TileKey
  label:    string
  value:    number
  context:  string
  /** Tooltip dell'intero riquadro. */
  hint?:    string
  /** Contenuto sotto il contesto (es. il link alla CMDB del riquadro informativo). */
  extra?:   ReactNode
  active:   boolean
  /** Assente = riquadro informativo, non cliccabile. */
  onClick?: () => void
}

function HealthTile({ tileKey, label, value, context, hint, extra, active, onClick }: TileProps) {
  const { accent, tint, icon: Icon } = TILE_STYLE[tileKey]
  const body = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 999, background: tint, color: accent, flexShrink: 0 }}>
          <Icon size={20} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 28, lineHeight: 1.1, fontWeight: 700, color: accent, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 }}>{label}</div>
        </div>
      </div>
      <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 10 }}>{context}</div>
      {extra}
    </>
  )
  const style: React.CSSProperties = {
    textAlign: 'left', font: 'inherit', padding: '14px 16px', borderRadius: 12, minWidth: 0,
    background: active ? tint : '#fff',
    border: active ? `2px solid ${accent}` : '1px solid var(--border)',
    boxShadow: 'var(--shadow-card)',
    cursor: onClick ? 'pointer' : 'default',
    transition: 'background-color 150ms, border-color 150ms',
  }
  return onClick
    ? <button type="button" onClick={onClick} aria-pressed={active} title={hint} style={style}>{body}</button>
    : <div title={hint} style={style}>{body}</div>
}

// ── Celle ────────────────────────────────────────────────────────────────────

/** Il motivo (soglia di propagazione / quanti dipendono) è nel tooltip E in una descrizione per le tecnologie assistive. */
function ImpactChip({ dependents, describedBy }: { dependents: number; describedBy: string }) {
  const { t } = useTranslation()
  const high = dependents >= HIGH_IMPACT
  const reason = high ? t('monitoring.health.dependentsHigh') : t('monitoring.health.dependentsHint', { count: dependents })
  return (
    <>
      <span
        title={reason}
        aria-describedby={describedBy}
        style={{
          display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap',
          fontSize: 'var(--font-size-table)', fontWeight: high ? 700 : 500, fontVariantNumeric: 'tabular-nums',
          background: high ? 'var(--color-slate-dark)' : 'var(--color-slate-bg)',
          color: high ? '#fff' : 'var(--color-slate)',
        }}
      >
        {t('monitoring.health.dependents', { count: dependents })}
      </span>
      <span id={describedBy} style={SR_ONLY}>{reason}</span>
    </>
  )
}

function SourceCell({ source, describedBy }: { source: CIHealthRow['healthSource']; describedBy: string }) {
  const { t } = useTranslation()
  if (!source) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const manual = source === 'manual'
  const Icon = manual ? Hand : Radar
  const hint = manual ? t('monitoring.health.sourceManualHint') : t('monitoring.health.sourceMonitoringHint')
  return (
    <>
      <span
        title={hint}
        aria-describedby={describedBy}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: manual ? '#6d28d9' : 'var(--color-slate)', whiteSpace: 'nowrap' }}
      >
        <Icon size={13} aria-hidden="true" />
        {manual ? t('monitoring.health.sourceManual') : t('monitoring.health.sourceMonitoring')}
      </span>
      <span id={describedBy} style={SR_ONLY}>{hint}</span>
    </>
  )
}

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '10px 12px', fontSize: 'var(--font-size-label)', fontWeight: 600, letterSpacing: '0.05em',
  textTransform: 'uppercase', color: 'var(--color-slate)', background: 'var(--surface-1)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { padding: '10px 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', verticalAlign: 'middle' }

/**
 * Riga: il clic con il mouse apre il dettaglio (comodità), ma il bersaglio
 * da tastiera è il Link sul nome (D·3.2: niente `tabIndex` sulla riga, che
 * non saprebbe dichiararsi link). I link secondari fermano la propagazione.
 */
function HealthRowView({ row }: { row: CIHealthRow }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { getCIType } = useMetamodel()
  const ciType = getCIType(row.type)
  const typeKey = ciTypeLabelKey(row.type)
  const typeLabel = typeKey ? t(typeKey) : (ciType?.label ?? enumLabel(row.type))
  const accent = CI_HEALTH_ACCENT[row.health]
  const since = row.healthSince ? formatDuration(Date.now() - new Date(row.healthSince).getTime()) : null
  const to = ciPath(row)
  const ids = { since: `ci-health-${row.id}-since`, impact: `ci-health-${row.id}-impact`, source: `ci-health-${row.id}-source` }

  return (
    <tr
      onClick={() => navigate(to)}
      className="hover-bg"
      style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}
    >
      <td style={{ ...TD, borderLeft: `4px solid ${accent}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {ciType && <CIIcon icon={ciType.icon} size={16} color={ciType.color} style={{ flexShrink: 0 }} />}
          <div style={{ minWidth: 0 }}>
            <Link to={to} onClick={(e) => e.stopPropagation()} title={t('monitoring.health.openCI', { name: row.name })} style={{ fontWeight: 600, color: 'var(--color-slate-dark)', textDecoration: 'none' }}>
              {row.name}
            </Link>
            <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 2 }}>
              {typeLabel}{row.environment ? ` · ${enumLabel(row.environment)}` : ''}
            </div>
          </div>
        </div>
      </td>
      <td style={TD}>
        <CIHealthBadge health={row.health} compact />
        {since && (
          <div aria-describedby={ids.since} title={t('monitoring.health.sinceHint', { date: formatDateTime(row.healthSince) })} style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 3 }}>
            {t('monitoring.health.since', { duration: since })}
            <span id={ids.since} style={SR_ONLY}>{t('monitoring.health.sinceHint', { date: formatDateTime(row.healthSince) })}</span>
          </div>
        )}
      </td>
      <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>
        {row.firingEvents > 0
          ? <Link to={`/events?ciId=${row.id}`} onClick={(e) => e.stopPropagation()} aria-label={t('monitoring.health.alarmsLink', { count: row.firingEvents, name: row.name })} style={{ color: accent, fontWeight: 700, textDecoration: 'none' }}>{row.firingEvents}</Link>
          : <span style={{ color: 'var(--color-slate-light)' }}>0</span>}
      </td>
      <td style={TD}><ImpactChip dependents={row.dependents} describedBy={ids.impact} /></td>
      <td style={TD}>{row.ownerTeam ?? <span style={{ color: 'var(--color-slate-light)' }}>—</span>}</td>
      <td style={TD}>
        {row.lastEventAt
          ? <span title={formatDateTime(row.lastEventAt)} style={{ color: 'var(--color-slate)' }}>{timeAgo(row.lastEventAt)}</span>
          : <span style={{ color: 'var(--color-slate-light)' }}>{t('monitoring.health.never')}</span>}
      </td>
      <td style={TD}><SourceCell source={row.healthSource} describedBy={ids.source} /></td>
      <td style={{ ...TD, textAlign: 'center' }}>
        <Link
          to={topologyHealthPath(row.id)}
          onClick={(e) => e.stopPropagation()}
          aria-label={t('monitoring.health.viewOnMapRow', { name: row.name })}
          title={t('monitoring.health.viewOnMapRow', { name: row.name })}
          style={{ display: 'inline-flex', color: 'var(--color-slate)', padding: 4 }}
        >
          <Share2 size={14} aria-hidden="true" />
        </Link>
      </td>
    </tr>
  )
}

// ── Pagina ───────────────────────────────────────────────────────────────────

export function CIHealthPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isAdmin } = useMe()
  const { ciTypes } = useMetamodel()
  const baseEnums = useCIBaseEnums()

  // Filtri e pagina vivono nell'URL; qui si legge e si scrive solo quello.
  const [searchParams, setSearchParams] = useSearchParams()
  const filter = useMemo(() => filterFromParams(searchParams), [searchParams])
  const page = pageFromParams(searchParams)
  const [searchInput, setSearchInput] = useState(filter.search)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)

  /** Scrive i parametri (null = toglie); ogni cambio di filtro riparte dalla prima pagina. `replace`: niente una voce di cronologia per clic. */
  const setParams = useCallback((patch: Partial<Record<keyof typeof URL_KEYS, string | null>>, opts: { keepPage?: boolean } = {}) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (!opts.keepPage) next.delete(URL_KEYS.page)
      for (const [key, value] of Object.entries(patch)) {
        const name = URL_KEYS[key as keyof typeof URL_KEYS]
        if (value) next.set(name, value); else next.delete(name)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])
  const setPage = useCallback((p: number) => setParams({ page: p > 0 ? String(p + 1) : null }, { keepPage: true }), [setParams])

  // Ricerca con debounce: la query parte quando l'utente smette di scrivere.
  // `writtenSearch` ricorda l'ultimo valore scritto da qui: se `q` cambia da
  // fuori (indietro/avanti, link) la casella si allinea invece di riscriverlo.
  const writtenSearch = useRef(filter.search)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (filter.search !== searchInput) { writtenSearch.current = searchInput; setParams({ search: searchInput }) }
    }, SEARCH_DEBOUNCE)
    return () => clearTimeout(timer)
  }, [searchInput, filter.search, setParams])
  useEffect(() => {
    if (filter.search !== writtenSearch.current) { writtenSearch.current = filter.search; setSearchInput(filter.search) }
  }, [filter.search])

  const toggleHealth = (h: CIHealth) => setParams({ health: filter.health === h ? null : h })

  // Al cambio di variabili (filtro, pagina) `liveData` torna undefined: la
  // tabella mostra le righe precedenti con "Aggiornamento…" invece del testo
  // di caricamento, così un click su un riquadro non la svuota.
  const { data: liveData, previousData, loading, error, refetch, networkStatus } = useQuery<{ ciHealthOverview: CIHealthOverview }>(GET_CI_HEALTH_OVERVIEW, {
    variables: { filter: toFilterVars(filter), limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
    ...pausedWhenHidden(POLL_MS),
    notifyOnNetworkStatusChange: true,
  })
  const data = liveData ?? previousData
  const updating = networkStatus === NetworkStatus.setVariables && previousData !== undefined
  useEffect(() => { if (networkStatus === NetworkStatus.ready && liveData) setLastUpdated(Date.now()) }, [networkStatus, liveData])

  // D·1.15: il totale è sceso sotto la pagina corrente (polling) → ultima pagina disponibile.
  const liveTotal = liveData?.ciHealthOverview.total
  useEffect(() => {
    if (liveTotal === undefined) return
    const lastPage = Math.max(0, Math.ceil(liveTotal / PAGE_SIZE) - 1)
    if (page > lastPage) setPage(lastPage)
  }, [liveTotal, page, setPage])

  const { data: teamsData, error: teamsError } = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, { fetchPolicy: 'cache-first' })
  const teams = teamsData?.teams ?? []
  const typeOptions = useMemo(() => ciTypes.filter((ct) => ct.name !== '__base__'), [ciTypes])

  const overview = data?.ciHealthOverview
  const items = overview?.items ?? []
  const total = overview?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const monitored = overview ? overview.down + overview.degraded + overview.operational : 0
  const allGood = overview !== undefined && monitored > 0 && overview.down + overview.degraded === 0
  const nothingYet = overview !== undefined && monitored === 0 && !hasFilter(filter)
  /** CI di partenza per la mappa: la prima riga (ordinate per gravità → il primo CI giù, se c'è). */
  const mapTarget = items[0] ?? null

  const tileContext = (key: TileKey): string => {
    if (key === 'unmonitored') return t('monitoring.health.tiles.unmonitoredContext')
    if (key === 'operational') return t('monitoring.health.tiles.operationalContext', { count: monitored })
    if ((overview?.[key] ?? 0) === 0) return t('monitoring.health.tiles.noneContext')
    // Aggregato del server su tutto il tenant (D·2.6), non della pagina corrente.
    const dependents = key === 'down' ? (overview?.downDependents ?? 0) : (overview?.degradedDependents ?? 0)
    return t('monitoring.health.tiles.dependentsContext', { count: dependents })
  }

  const updatedLabel = lastUpdated
    ? t('monitoring.health.updatedAt', { time: new Date(lastUpdated).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' }) })
    : '—'

  const headers: { key: string; label: string; width?: string }[] = [
    { key: 'ci',        label: t('monitoring.health.columns.ci') },
    { key: 'health',    label: t('monitoring.health.columns.health'),    width: '150px' },
    { key: 'alarms',    label: t('monitoring.health.columns.alarms'),    width: '110px' },
    { key: 'impact',    label: t('monitoring.health.columns.impact'),    width: '130px' },
    { key: 'team',      label: t('monitoring.health.columns.team'),      width: '150px' },
    { key: 'lastEvent', label: t('monitoring.health.columns.lastEvent'), width: '130px' },
    { key: 'source',    label: t('monitoring.health.columns.source'),    width: '130px' },
    { key: 'map',       label: t('monitoring.health.columns.map'),       width: '70px' },
  ]

  let tableBody: ReactNode
  if (error && !data) {
    tableBody = <QueryError message={error.message} onRetry={() => void refetch()} />
  } else if (loading && !data) {
    tableBody = <p role="status" style={{ color: 'var(--color-slate-light)', padding: '24px 0' }}>{t('common.loading')}</p>
  } else if (nothingYet) {
    tableBody = (
      <div className="card-border">
        <EmptyState
          icon={<Radar size={32} />}
          title={t('monitoring.health.empty.title')}
          description={`${t('monitoring.health.empty.description')}${isAdmin ? '' : ` ${t('monitoring.health.empty.askAdmin')}`}`}
          action={isAdmin ? <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => navigate('/monitoring/sources/new')}>{t('monitoring.health.empty.cta')}</Button> : undefined}
        />
      </div>
    )
  } else {
    tableBody = (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {t('monitoring.health.count', { count: total })}
            {updating && (
              <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-table)' }}>
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />{t('monitoring.console.updating')}
              </span>
            )}
          </span>
          {totalPages > 1 && <span>{t('monitoring.health.page', { page: page + 1, total: totalPages })}</span>}
        </div>
        {/* Sotto ~900px la tabella scorre nel proprio contenitore, mai la pagina. */}
        <div className="card-border" style={{ overflowX: 'auto' }}>
          <table aria-label={t('monitoring.health.title')} style={{ width: '100%', minWidth: 880, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {headers.map((h) => <th key={h.key} scope="col" style={{ ...TH, width: h.width }}>{h.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {items.length === 0
                ? <tr><td colSpan={headers.length} style={{ ...TD, textAlign: 'center', color: 'var(--color-slate-light)', padding: '28px 12px' }}>{t('monitoring.health.noMatch')}</td></tr>
                : items.map((row) => <HealthRowView key={row.id} row={row} />)}
            </tbody>
          </table>
        </div>
        <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(page - 1)} onNext={() => setPage(page + 1)} />
      </>
    )
  }

  return (
    <PageContainer>
      <ListPageHeader
        icon={<HeartPulse size={22} color="var(--color-icon-accent)" />}
        title={t('monitoring.health.title')}
        subtitle={<p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>{t('monitoring.health.subtitle')}</p>}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>{updatedLabel}</span>
            <Button variant="secondary" size="xs" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={() => void refetch()}>{t('monitoring.health.refresh')}</Button>
            <Button
              variant="secondary"
              size="xs"
              icon={<Share2 size={13} aria-hidden="true" />}
              disabled={!mapTarget}
              title={mapTarget ? t('monitoring.health.viewOnMapRow', { name: mapTarget.name }) : t('monitoring.health.viewOnMapDisabled')}
              onClick={() => { if (mapTarget) navigate(topologyHealthPath(mapTarget.id)) }}
            >
              {t('monitoring.health.viewOnMap')}
            </Button>
          </div>
        }
      />

      {/* Riquadri: i tre stati filtrano la tabella, "senza monitoraggio" è informativo e rimanda alla CMDB. */}
      {overview && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 20 }}>
          {TILE_ORDER.map((key) => {
            const clickable = key !== 'unmonitored'
            return (
              <HealthTile
                key={key}
                tileKey={key}
                label={t(`monitoring.health.tiles.${key}`)}
                value={overview[key]}
                context={tileContext(key)}
                hint={clickable ? t('monitoring.health.tiles.toggleHint') : t('monitoring.health.tiles.unmonitoredHint')}
                extra={clickable ? undefined : (
                  // La CMDB non ha (ancora) un filtro "senza salute" nell'URL: il link porta all'elenco completo.
                  <Link to="/cmdb" style={{ display: 'inline-block', marginTop: 6, fontSize: 'var(--font-size-table)', color: 'var(--color-brand)' }}>
                    {t('monitoring.health.tiles.unmonitoredLink')}
                  </Link>
                )}
                active={clickable && filter.health === key}
                onClick={clickable ? () => toggleHealth(key) : undefined}
              />
            )
          })}
        </div>
      )}

      {allGood && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', marginBottom: 16, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, color: CI_HEALTH_ACCENT.operational }}>
          <CheckCircle2 size={22} aria-hidden="true" style={{ flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 'var(--font-size-card-title)' }}>{t('monitoring.health.allGood')}</div>
            <div style={{ fontSize: 'var(--font-size-table)', color: '#166534', marginTop: 2 }}>{t('monitoring.health.allGoodDetail', { count: monitored })}</div>
          </div>
        </div>
      )}

      {/* Filtri (nell'URL). Gli errori delle liste di supporto (enum base, squadre) sono testo visibile, non solo un tooltip. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Select aria-label={t('monitoring.health.filters.type')} value={filter.type} onChange={(e) => setParams({ type: e.target.value })} style={{ width: 180 }}>
          <option value="">{t('monitoring.health.filters.allTypes')}</option>
          {typeOptions.map((ct) => { const k = ciTypeLabelKey(ct.name); return <option key={ct.name} value={ct.name}>{k ? t(k) : ct.label}</option> })}
        </Select>
        <Select aria-label={t('monitoring.health.filters.environment')} value={filter.environment} onChange={(e) => setParams({ environment: e.target.value })} style={{ width: 170 }}>
          <option value="">{t('monitoring.health.filters.allEnvironments')}</option>
          {baseEnums.environments.map((v) => <option key={v} value={v}>{enumLabel(v)}</option>)}
        </Select>
        {baseEnums.error && (
          <span role="alert" style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-danger)' }}>
            {t('monitoring.health.filters.enumsUnavailable', { error: baseEnums.error })}
          </span>
        )}
        <Select aria-label={t('monitoring.health.filters.team')} value={filter.team} onChange={(e) => setParams({ team: e.target.value })} style={{ width: 180 }}>
          <option value="">{t('monitoring.health.filters.allTeams')}</option>
          {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
        </Select>
        {teamsError && (
          <span role="alert" style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-danger)' }}>
            {t('monitoring.health.filters.teamsUnavailable', { error: teamsError.message })}
          </span>
        )}
        <Input
          aria-label={t('monitoring.health.filters.search')}
          placeholder={t('monitoring.health.filters.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{ width: 240, marginLeft: 'auto' }}
        />
      </div>

      {tableBody}
    </PageContainer>
  )
}
