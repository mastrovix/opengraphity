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
 * Colonna "Servizi" (ondata 3 dei Servizi monitorati): quanti servizi
 * monitorati dipendono dal CI (`servicesCount`), con link alla pagina Servizi
 * filtrata su quel CI (`?ciId=`).
 *
 * "Vedi sulla mappa" (D·1.3) porta alla topologia CON un CI di partenza
 * (`/topology?health=1&ciId=…`): dalla riga il CI della riga, dal pulsante
 * generale la prima riga (le righe sono ordinate per gravità: il primo CI
 * giù, se ce n'è uno); senza righe il pulsante è disabilitato con il motivo.
 *
 * Contratto: `ciHealthOverview` in apps/api/src/graphql/schema-events.ts.
 */
import { Loading } from '@/components/ui/Loading'
import { Pill } from '@/components/ui/Pill'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { NetworkStatus } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import {
  HeartPulse, Share2, RefreshCw, CheckCircle2, EyeOff, Radar, Hand, Plus, Loader2, type LucideIcon,
} from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { ListPageHeader } from '@/components/ListPageHeader'
import { EmptyState } from '@/components/EmptyState'
import { QueryError, StaleDataBanner } from '@/components/QueryError'
import { Pagination } from '@/components/ui/Pagination'
import { Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { StatTile } from '@/components/ui/StatTile'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { useMe } from '@/hooks/useMe'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { useCILabels } from '@/hooks/useCILabels'
import { CIIcon } from '@/lib/ciIcon'
import { ciPath } from '@/lib/ciPath'
import { useCIBaseEnums } from '@/lib/ciEnums'
import { timeAgo, formatDateTime, formatDuration, currentLocale } from '@/lib/datetime'
import { pausedWhenHidden } from '@/lib/polling'
import { GET_CI_HEALTH_OVERVIEW, GET_EVENT_POLICY, GET_TEAMS } from '@/graphql/queries'
import { CIHealthBadge, CIHealthIcon, CI_HEALTH_ACCENT, CI_HEALTH_ICON, CI_HEALTH_TINT } from '@/pages/events/eventShared'
import { servicesForCIPath } from './ServicesPage'
import type { CIHealth, CIHealthOverview, CIHealthRow, CIHealthFilterVars } from '@/types/events'
import { colors, palette } from '@/lib/tokens'
import { srOnlyStyle } from '@/lib/a11y'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { TEAM_TYPE } from '@/lib/teamVocabularies'

const PAGE_SIZE       = 50
const POLL_MS         = 15_000
const SEARCH_DEBOUNCE = 300
/**
 * La soglia «un guasto qui si propaga» viene dalla Policy eventi
 * (revisione totale · G-MON-7): era il numero 5 scritto qui, lo stesso per una
 * CMDB da 50 CI e per una da 50.000. Finche la policy non e arrivata la soglia
 * non si conosce: il chip mostra il solo conteggio, senza dire «si propaga»
 * sulla base di un numero che non abbiamo letto.
 */

const CI_HEALTHS: readonly CIHealth[] = ['down', 'degraded', 'operational']
const isCIHealth = (v: string | null): v is CIHealth => v !== null && (CI_HEALTHS as readonly string[]).includes(v)

/** Topologia centrata sul CI con la salute evidenziata (TopologyPage legge `ciId` come CI di partenza). */
export const topologyHealthPath = (ciId: string) => `/topology?health=1&ciId=${encodeURIComponent(ciId)}`

type TileKey = CIHealth | 'unmonitored'
const TILE_ORDER: TileKey[] = ['down', 'degraded', 'operational', 'unmonitored']

/** Palette dei riquadri: stessi rosso/ambra/verde dei badge (CI_HEALTH_ACCENT), grigio per "senza monitoraggio". */
const TILE_STYLE: Record<TileKey, { accent: string; tint: string; icon: LucideIcon }> = {
  down:        { accent: CI_HEALTH_ACCENT.down,        tint: CI_HEALTH_TINT.down,        icon: CI_HEALTH_ICON.down },
  degraded:    { accent: CI_HEALTH_ACCENT.degraded,    tint: CI_HEALTH_TINT.degraded,    icon: CI_HEALTH_ICON.degraded },
  operational: { accent: CI_HEALTH_ACCENT.operational, tint: CI_HEALTH_TINT.operational, icon: CI_HEALTH_ICON.operational },
  unmonitored: { accent: 'var(--color-slate)',         tint: 'var(--color-slate-bg)', icon: EyeOff },
}

/*
  La copia locale di questo stile aveva lo stesso difetto dell'originale —
  `position: absolute` senza coordinate, quindi dentro una tabella larga
  allungava la pagina — ed essendo una copia non si correggeva correggendo
  l'originale. Ora punta a quella condivisa: un posto solo.
*/
const SR_ONLY = srOnlyStyle

interface HealthFilter {
  /** Stato scelto dal riquadro (un solo stato alla volta); null = tutti. */
  health:      CIHealth | null
  type:        string
  environment: string
  team:        string
  /** Id of the support group (SUPPORTED_BY): the team that acts on the CI. */
  supportTeam: string
  search:      string
}

const hasFilter = (f: HealthFilter) => f.health !== null || !!f.type || !!f.environment || !!f.team || !!f.supportTeam || !!f.search.trim()

/** Variabili GraphQL: solo i campi valorizzati. */
function toFilterVars(f: HealthFilter): CIHealthFilterVars | null {
  const vars: CIHealthFilterVars = {}
  if (f.health)        vars.health      = [f.health]
  if (f.type)          vars.type        = f.type
  if (f.environment)   vars.environment = f.environment
  if (f.team)          vars.team        = f.team
  if (f.supportTeam)   vars.supportTeam = f.supportTeam
  if (f.search.trim()) vars.search      = f.search.trim()
  return Object.keys(vars).length ? vars : null
}

// ── URL ──────────────────────────────────────────────────────────────────────

/** Nomi dei parametri: corti perché finiscono nella barra degli indirizzi. */
const URL_KEYS = { health: 'health', type: 'type', environment: 'env', team: 'team', supportTeam: 'support', search: 'q', page: 'page' } as const

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
    supportTeam: p.get(URL_KEYS.supportTeam) ?? '',
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

/** A tile of the page: the app's StatTile (26 Sep 2026), pressed while its filter is on. */
function HealthTile({ tileKey, label, value, context, hint, extra, active, onClick }: TileProps) {
  const { accent, tint, icon: Icon } = TILE_STYLE[tileKey]
  return <StatTile label={label} value={value} accent={accent} tint={tint} icon={<Icon size={20} />} context={context} hint={hint} extra={extra} onClick={onClick} pressed={active} />
}

// ── Celle ────────────────────────────────────────────────────────────────────

/** Il motivo (soglia di propagazione / quanti dipendono) è nel tooltip E in una descrizione per le tecnologie assistive. */
function ImpactChip({ dependents, highImpact, describedBy }: { dependents: number; highImpact: number | null; describedBy: string }) {
  const { t } = useTranslation()
  // 0 = l'organizzazione ha spento l'evidenza; null = policy non ancora letta.
  const high = highImpact !== null && highImpact > 0 && dependents >= highImpact
  // G-MON-7: anche la frase diceva «Almeno 5»: il 5 era nella traduzione.
  const reason = high && highImpact !== null
    ? t('monitoring.health.dependentsHigh', { min: highImpact })
    : t('monitoring.health.dependentsHint', { count: dependents })
  return (
    <>
      <Pill bg={high ? 'var(--color-slate-dark)' : 'var(--color-slate-bg)'} color={high ? colors.white : 'var(--color-slate)'} radius={999} title={reason} aria-describedby={describedBy} style={{ fontSize: 'var(--font-size-table)', fontWeight: high ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>
        {t('monitoring.health.dependents', { count: dependents })}
      </Pill>
      <span id={describedBy} style={SR_ONLY}>{reason}</span>
    </>
  )
}

/**
 * Quanti servizi monitorati dipendono dal CI (`servicesCount`, ondata 3 dei
 * Servizi monitorati): con almeno uno è un link alla pagina Servizi filtrata
 * su QUESTO CI (`?ciId=`, revisione 2 C-14: prima portava alla lista intera,
 * cioè a tutt'altro insieme di quello che il numero contava), a zero resta un
 * numero spento. Il motivo è nel tooltip E in una descrizione per le
 * tecnologie assistive, come le altre celle della tabella.
 */
function ServicesCell({ count, ciId, name, describedBy }: { count: number; ciId: string; name: string; describedBy: string }) {
  const { t } = useTranslation()
  const hint = count > 0 ? t('monitoring.health.servicesHint', { count, name }) : t('monitoring.health.servicesNone')
  return (
    <>
      {count > 0
        ? (
          <Link
            to={servicesForCIPath(ciId)}
            onClick={(e) => e.stopPropagation()}
            aria-label={hint}
            title={hint}
            aria-describedby={describedBy}
            style={{ color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2, fontWeight: 600, whiteSpace: 'nowrap' }}
          >
            {t('monitoring.health.services', { count })}
          </Link>
        )
        : <span title={hint} aria-describedby={describedBy} style={{ color: 'var(--color-slate-light)' }}>{t('monitoring.health.services', { count })}</span>}
      <span id={describedBy} style={SR_ONLY}>{hint}</span>
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
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: manual ? palette.purple.dark : 'var(--color-slate)', whiteSpace: 'nowrap' }}
      >
        <Icon size={13} aria-hidden="true" />
        {manual ? t('monitoring.health.sourceManual') : t('monitoring.health.sourceMonitoring')}
      </span>
      <span id={describedBy} style={SR_ONLY}>{hint}</span>
    </>
  )
}

/**
 * The two team filters. Each offers the teams that do that job (D10): owner
 * teams own CIs, support groups run them. A tenant whose teams have no type
 * sees them all in both lists — the label of the list says which role it
 * filters on. A failed read is said, not shown as an empty list.
 */
function TeamFilters({ owner, support, onOwner, onSupport }: { owner: string; support: string; onOwner: (id: string) => void; onSupport: (id: string) => void }) {
  const { t } = useTranslation()
  const { data, error } = useQuery<{ teams: { id: string; name: string; type: string | null }[] }>(GET_TEAMS, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const teams = data?.teams ?? []
  const ofType = (type: string) => {
    const fit = teams.filter((tm) => tm.type === type)
    return fit.length ? fit : teams
  }
  return (
    <>
      <Select aria-label={t('monitoring.health.filters.team')} value={owner} onChange={(e) => onOwner(e.target.value)} style={{ width: 180 }}>
        <option value="">{t('monitoring.health.filters.allTeams')}</option>
        {ofType(TEAM_TYPE.OWNER).map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
      </Select>
      <Select aria-label={t('monitoring.health.filters.supportTeam')} value={support} onChange={(e) => onSupport(e.target.value)} style={{ width: 180 }}>
        <option value="">{t('monitoring.health.filters.allSupportTeams')}</option>
        {ofType(TEAM_TYPE.SUPPORT).map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
      </Select>
      {error && (
        <span role="alert" style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-danger)' }}>
          {t('monitoring.health.filters.teamsUnavailable', { error: error.message })}
        </span>
      )}
    </>
  )
}

/**
 * The columns of the list (26 Sep 2026: the app's table, not a hand-made one).
 * The row opens the CI; the alarms count and the map are links elsewhere.
 */
function useHealthColumns(highImpact: number | null): ColumnDef<CIHealthRow>[] {
  const { t } = useTranslation()
  const { getCIType } = useMetamodel()
  const { environmentLabel, typeLabel } = useCILabels()
  const ids = (row: CIHealthRow) => ({ since: `ci-health-${row.id}-since`, impact: `ci-health-${row.id}-impact`, services: `ci-health-${row.id}-services`, source: `ci-health-${row.id}-source` })
  return [
    { key: 'name', label: t('monitoring.health.columns.ci'), render: (_v, row) => {
      const ciType = getCIType(row.type)
      return (
        // The health as an icon, beside the name (26 Sep 2026: it was a stripe along the row).
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <CIHealthIcon health={row.health} />
          {ciType && <CIIcon icon={ciType.icon} size={16} color={ciType.color} style={{ flexShrink: 0 }} />}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{row.name}</div>
            <div style={{ marginTop: 2 }}>{typeLabel(row.type)}{row.environment ? ` · ${environmentLabel(row.environment)}` : ''}</div>
          </div>
        </div>
      )
    } },
    // The gravest first when sorting up (26 Sep 2026: every column sorts).
    { key: 'health', label: t('monitoring.health.columns.health'), width: '150px', rank: ['down', 'degraded', 'operational'], render: (_v, row) => {
      const since = row.healthSince ? formatDuration(Date.now() - new Date(row.healthSince).getTime()) : null
      return (
        <>
          <CIHealthBadge health={row.health} compact />
          {since && (
            <div aria-describedby={ids(row).since} title={t('monitoring.health.sinceHint', { date: formatDateTime(row.healthSince) })} style={{ marginTop: 3 }}>
              {t('monitoring.health.since', { duration: since })}
              <span id={ids(row).since} style={SR_ONLY}>{t('monitoring.health.sinceHint', { date: formatDateTime(row.healthSince) })}</span>
            </div>
          )}
        </>
      )
    } },
    { key: 'firingEvents', label: t('monitoring.health.columns.alarms'), width: '110px', render: (_v, row) => row.firingEvents > 0
      ? <Link to={`/events?ciId=${row.id}`} aria-label={t('monitoring.health.alarmsLink', { count: row.firingEvents, name: row.name })} style={{ color: CI_HEALTH_ACCENT[row.health], fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: 2, fontVariantNumeric: 'tabular-nums' }}>{row.firingEvents}</Link>
      : <span>0</span> },
    { key: 'dependents', label: t('monitoring.health.columns.impact'), width: '130px', render: (_v, row) => <ImpactChip dependents={row.dependents} highImpact={highImpact} describedBy={ids(row).impact} /> },
    { key: 'servicesCount', label: t('monitoring.health.columns.services'), width: '120px', render: (_v, row) => <ServicesCell count={row.servicesCount} ciId={row.id} name={row.name} describedBy={ids(row).services} /> },
    // Who acts on it: the SUPPORT team, not the owner (tour of 23 Sep 2026).
    { key: 'supportTeam', label: t('monitoring.health.columns.supportTeam'), width: '170px', render: (_v, row) => row.supportTeam ?? '—' },
    { key: 'lastEventAt', label: t('monitoring.health.columns.lastEvent'), width: '130px', render: (_v, row) => row.lastEventAt
      ? <span title={formatDateTime(row.lastEventAt)}>{timeAgo(row.lastEventAt)}</span>
      : t('monitoring.health.never') },
    { key: 'healthSource', label: t('monitoring.health.columns.source'), width: '130px', render: (_v, row) => <SourceCell source={row.healthSource} describedBy={ids(row).source} /> },
    { key: 'id', label: t('monitoring.health.columns.map'), sortable: false, width: '70px', render: (_v, row) => (
      <Link
        to={topologyHealthPath(row.id)}
        aria-label={t('monitoring.health.viewOnMapRow', { name: row.name })}
        title={t('monitoring.health.viewOnMapRow', { name: row.name })}
        style={{ display: 'inline-flex', color: 'var(--color-slate)', padding: 4 }}
      >
        <Share2 size={14} aria-hidden="true" />
      </Link>
    ) },
  ]
}

// ── Pagina ───────────────────────────────────────────────────────────────────

export function CIHealthPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { can } = useMe()
  const managesSources = can('config.monitoring')
  const { ciTypes } = useMetamodel()
  const baseEnums = useCIBaseEnums()
  // Secondo giro UI del 15 set 2026 · V-21: ambienti con l'etichetta del Dizionario, non umanizzati
  const { environmentLabel, typeLabel } = useCILabels()

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
    fetchPolicy: METAMODEL_FETCH_POLICY,
    ...pausedWhenHidden(POLL_MS),
    notifyOnNetworkStatusChange: true,
  })
  // The previous filter's rows stand in only while the new ones are on their
  // way: after a failure they read as the answer, with the new tile pressed
  // (review of 23 Sep 2026).
  const data = liveData ?? (networkStatus === NetworkStatus.setVariables ? previousData : undefined)
  const updating = networkStatus === NetworkStatus.setVariables && previousData !== undefined
  useEffect(() => { if (networkStatus === NetworkStatus.ready && liveData) setLastUpdated(Date.now()) }, [networkStatus, liveData])

  // D·1.15: il totale è sceso sotto la pagina corrente (polling) → ultima pagina disponibile.
  const liveTotal = liveData?.ciHealthOverview.total
  useEffect(() => {
    if (liveTotal === undefined) return
    const lastPage = Math.max(0, Math.ceil(liveTotal / PAGE_SIZE) - 1)
    if (page > lastPage) setPage(lastPage)
  }, [liveTotal, page, setPage])

  /**
   * G-MON-7: la soglia dell'evidenza «si propaga» e una scelta
   * dell'organizzazione (Policy eventi). null = non ancora letta.
   */
  const { data: policyData } = useQuery<{ eventPolicy: { highImpactDependents: number } }>(GET_EVENT_POLICY, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const healthColumns = useHealthColumns(policyData?.eventPolicy.highImpactDependents ?? null)
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


  let tableBody: ReactNode
  if (error && !data) {
    tableBody = <QueryError message={error.message} onRetry={() => void refetch()} />
  } else if (loading && !data) {
    tableBody = <Loading padded />
  } else if (nothingYet) {
    tableBody = (
      <div className="card-border">
        <EmptyState
          icon={<Radar size={32} />}
          title={t('monitoring.health.empty.title')}
          description={`${t('monitoring.health.empty.description')}${managesSources ? '' : ` ${t('monitoring.health.empty.askAdmin')}`}`}
          action={managesSources ? <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => navigate('/monitoring/sources/new')}>{t('monitoring.health.empty.cta')}</Button> : undefined}
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
        <SortableFilterTable<CIHealthRow>
          label={t('monitoring.health.title')}
          columns={healthColumns}
          data={items}
          emptyMessage={t('monitoring.health.noMatch')}
          // The server pages the list by gravity: a column sorts the page on screen, and says so.
          sortHint={t('common.sortPageOnly')}
          onRowClick={(row) => navigate(ciPath(row))}
       />
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
                  // `?health=none` → la CMDB apre il filtro avanzato "Salute è vuoto" (CI mai toccati da un allarme).
                  <Link to="/cmdb?health=none" style={{ display: 'inline-block', marginTop: 6, fontSize: 'var(--font-size-table)', color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
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
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', marginBottom: 16, background: palette.success.bg, border: `1px solid ${palette.success.border}`, borderRadius: 10, color: CI_HEALTH_ACCENT.operational }}>
          <CheckCircle2 size={22} aria-hidden="true" style={{ flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 'var(--font-size-card-title)' }}>{t('monitoring.health.allGood')}</div>
            <div style={{ fontSize: 'var(--font-size-table)', color: palette.success.strong, marginTop: 2 }}>{t('monitoring.health.allGoodDetail', { count: monitored })}</div>
          </div>
        </div>
      )}

      {/* Filtri (nell'URL). Gli errori delle liste di supporto (enum base, squadre) sono testo visibile, non solo un tooltip. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Select aria-label={t('monitoring.health.filters.type')} value={filter.type} onChange={(e) => setParams({ type: e.target.value })} style={{ width: 180 }}>
          <option value="">{t('monitoring.health.filters.allTypes')}</option>
          {typeOptions.map((ct) => <option key={ct.name} value={ct.name}>{typeLabel(ct.name)}</option>)}
        </Select>
        <Select aria-label={t('monitoring.health.filters.environment')} value={filter.environment} onChange={(e) => setParams({ environment: e.target.value })} style={{ width: 170 }}>
          <option value="">{t('monitoring.health.filters.allEnvironments')}</option>
          {baseEnums.environments.map((v) => <option key={v} value={v}>{environmentLabel(v)}</option>)}
        </Select>
        {baseEnums.error && (
          <span role="alert" style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-danger)' }}>
            {t('monitoring.health.filters.enumsUnavailable', { error: baseEnums.error })}
          </span>
        )}
        <TeamFilters owner={filter.team} support={filter.supportTeam} onOwner={(team) => setParams({ team })} onSupport={(supportTeam) => setParams({ supportTeam })} />
        <Input
          aria-label={t('monitoring.health.filters.search')}
          placeholder={t('monitoring.health.filters.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{ width: 240, marginLeft: 'auto' }}
        />
      </div>

      {error && data && <StaleDataBanner message={error.message} readAt={lastUpdated} onRetry={() => void refetch()} />}
      {tableBody}
    </PageContainer>
  )
}
