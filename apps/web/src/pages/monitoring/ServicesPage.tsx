/**
 * Pagina «Servizi» (gruppo Monitoraggio, staff): la salute dei servizi di
 * business calcolata dai componenti che li reggono, dal più grave.
 *
 * Struttura come Salute CI: cinque riquadri-contatore cliccabili (Giù /
 * Degradati / In manutenzione / Operativi / Sconosciuti — quest'ultimo
 * «nessun componente con salute nota»: dalla revisione 2 filtra come gli
 * altri, perché `unknown` è una salute del vocabolario e l'URL la accettava
 * già), filtri (stato della mappa, ricerca con
 * debounce) e tabella per gravità: servizio (link), salute con «da N min»,
 * punteggio d'impatto (barra 0–100 + numero), causa principale («db-01 giù
 * via api-03»), componenti, owner. Polling ogni 15 s (in pausa a scheda
 * nascosta) + Aggiorna; al cambio di filtro o pagina la tabella tiene le
 * righe precedenti con «Aggiornamento…».
 *
 * In fondo, in sola lettura, le capacità di business con la salute peggiore
 * fra i servizi che le abilitano (BusinessCapabilitiesSection, ondata 3).
 *
 * L'URL è la sorgente dei filtri e della pagina (`?health=down&status=active
 * &q=billing&ciId=<id>&page=2`, scritti con `replace`): un F5 o un link
 * condiviso non li perdono. `?ciId=` (revisione 2, C-14) tiene solo i servizi
 * la cui mappa include quel CI — ci arriva la colonna «Servizi» di Salute CI —
 * ed è rappresentato da un chip che lo toglie.
 * Stato vuoto (nessuna mappa nel tenant): «Crea una mappa» (admin)
 * apre il dialogo minimale CreateServiceMapDialog.
 *
 * Contratto: `serviceMaps` in apps/api/src/graphql/schema-services.ts.
 */
import { Loading } from '@/components/ui/Loading'
import { Chip } from '@/components/ui/Chip'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { NetworkStatus } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Boxes, RefreshCw, AlertTriangle, Plus, Loader2 } from 'lucide-react'
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
import { useCriticalityLabel } from '@/hooks/useCILabels'
import { formatDateTime, formatDuration, currentLocale } from '@/lib/datetime'
import { pausedWhenHidden } from '@/lib/polling'
import { GET_SERVICE_MAPS } from '@/graphql/queries'
import { palette } from '@/lib/tokens'
import { srOnlyStyle } from '@/lib/a11y'
import { CreateServiceMapDialog } from './CreateServiceMapDialog'
import { BusinessCapabilitiesSection } from './BusinessCapabilitiesSection'
import { SERVICE_HEALTH_FAMILY, ServiceHealthBadge, ServiceHealthIcon, SERVICE_HEALTH_ICON, ServiceStatusPill, ImpactScore, causeLabel, healthIfActiveNote, isServiceHealth, staleShortLabel } from './servicesShared'
import { SERVICE_HEALTHS, SERVICE_MAP_STATUSES, type ServiceHealth, type ServiceMapStatus, type ServiceMapPage, type ServiceMapRow, type ServiceMapFilterVars } from '@/types/services'

const PAGE_SIZE       = 50
const POLL_MS         = 15_000
const SEARCH_DEBOUNCE = 300

const isStatus = (v: string | null): v is ServiceMapStatus => v !== null && (SERVICE_MAP_STATUSES as readonly string[]).includes(v)

export const servicePath = (id: string) => `/monitoring/services/${encodeURIComponent(id)}`

/** I servizi la cui mappa include questo CI (colonna «Servizi» di Salute CI, C-14). */
export const servicesForCIPath = (ciId: string) => `/monitoring/services?ciId=${encodeURIComponent(ciId)}`

/**
 * Riquadri: tutti e cinque filtrano. «Sconosciuti» era una nota per analogia
 * con Salute CI, dove il quarto riquadro conta CI che la query non elenca
 * nemmeno; qui `unknown` è una salute del vocabolario (`SERVICE_HEALTHS`), la
 * lista li mostra e l'URL accettava già `?health=unknown`: un riquadro non
 * cliccabile lasciava un filtro che si poteva mettere da un link e non
 * togliere dai riquadri (C-13).
 */
const TILE_ORDER: ServiceHealth[] = ['down', 'degraded', 'maintenance', 'operational', 'unknown']

/*
  La copia locale di questo stile aveva lo stesso difetto dell'originale —
  `position: absolute` senza coordinate, quindi dentro una tabella larga
  allungava la pagina — ed essendo una copia non si correggeva correggendo
  l'originale. Ora punta a quella condivisa: un posto solo.
*/
const SR_ONLY = srOnlyStyle

interface ServicesFilter {
  health: ServiceHealth | null
  status: ServiceMapStatus | null
  search: string
  /** Solo i servizi la cui mappa include questo CI; null = tutti. */
  ciId:   string | null
}

const hasFilter = (f: ServicesFilter) => f.health !== null || f.status !== null || !!f.search.trim() || f.ciId !== null

function toFilterVars(f: ServicesFilter): ServiceMapFilterVars | null {
  const vars: ServiceMapFilterVars = {}
  if (f.health)        vars.health = [f.health]
  if (f.status)        vars.status = f.status
  if (f.search.trim()) vars.search = f.search.trim()
  if (f.ciId)          vars.ciId   = f.ciId
  return Object.keys(vars).length ? vars : null
}

// ── URL ──────────────────────────────────────────────────────────────────────

const URL_KEYS = { health: 'health', status: 'status', search: 'q', ciId: 'ciId', page: 'page' } as const

/** Un valore di `health`/`status` fuori vocabolario nell'URL viene ignorato (URL scritto a mano): la pagina mostra tutto. */
function filterFromParams(p: URLSearchParams): ServicesFilter {
  const health = p.get(URL_KEYS.health)
  const status = p.get(URL_KEYS.status)
  return {
    health: isServiceHealth(health) ? health : null,
    status: isStatus(status) ? status : null,
    search: p.get(URL_KEYS.search) ?? '',
    ciId:   p.get(URL_KEYS.ciId),
  }
}

function pageFromParams(p: URLSearchParams): number {
  const n = Number.parseInt(p.get(URL_KEYS.page) ?? '', 10)
  return Number.isFinite(n) && n > 1 ? n - 1 : 0
}

// ── Riquadri ─────────────────────────────────────────────────────────────────

interface TileProps {
  health:   ServiceHealth
  value:    number
  context:  string
  hint:     string
  active:   boolean
  onClick:  () => void
}

/** A tile of the page: the app's StatTile (26 Sep 2026), pressed while its filter is on. */
function HealthTile({ health, value, context, hint, active, onClick }: TileProps) {
  const { t } = useTranslation()
  const fam = SERVICE_HEALTH_FAMILY[health]
  const Icon = SERVICE_HEALTH_ICON[health]
  return <StatTile label={t(`monitoring.services.tiles.${health}`)} value={value} accent={fam.accent} tint={fam.tint} icon={<Icon size={20} />} context={context} hint={hint} onClick={onClick} pressed={active} />
}

// ── Tabella ──────────────────────────────────────────────────────────────────

/**
 * The columns of the list (26 Sep 2026: the app's table, not a hand-made one).
 * The row opens the service. `data-tone` keeps the colour of what carries a
 * judgement (the maintenance note, the stale mark): the table greys the rest.
 */
function useServiceColumns(): ColumnDef<ServiceMapRow>[] {
  const { t } = useTranslation()
  const criticalityLabel = useCriticalityLabel()
  return [
    { key: 'name', label: t('monitoring.services.columns.service'), render: (_v, row) => {
      const meta = [row.service.criticality ? criticalityLabel(row.service.criticality) : null].filter(Boolean).join(' · ')
      return (
        // The health as an icon, beside the name (26 Sep 2026: it was a stripe along the row).
        // The name and its subtitle stand together to the right of the icon, as in the CI health list.
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ServiceHealthIcon health={row.health} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>{row.name}</span>
              {row.status !== 'active' && <ServiceStatusPill status={row.status} />}
              {row.stale && (
                <span role="img" data-testid="stale-icon" data-tone="stale" data-reason={row.staleReason ?? 'none'} aria-label={staleShortLabel(t, row.staleReason)} title={staleShortLabel(t, row.staleReason)} style={{ display: 'inline-flex', color: palette.warning.base }}>
                  <AlertTriangle size={14} aria-hidden="true" />
                </span>
              )}
            </div>
            {meta && <div style={{ marginTop: 2 }}>{meta}</div>}
          </div>
        </div>
      )
    } },
    // The gravest first when sorting up (26 Sep 2026: every column sorts).
    { key: 'health', label: t('monitoring.services.columns.health'), width: '160px', rank: SERVICE_HEALTHS, render: (_v, row) => {
      const since = row.healthSince ? formatDuration(Date.now() - new Date(row.healthSince).getTime()) : null
      const sinceId = `service-${row.id}-since`
      const ifActive = healthIfActiveNote(t, row)
      return (
        <>
          <ServiceHealthBadge health={row.health} />
          {/* R1: «in manutenzione» da solo nasconderebbe che senza la finestra di change il servizio sarebbe giù. */}
          {ifActive && (
            <div data-testid="health-if-active" data-tone="maintenance" style={{ color: palette.purple.text, marginTop: 3 }}>{ifActive}</div>
          )}
          {since && (
            <div aria-describedby={sinceId} title={t('monitoring.services.sinceHint', { date: formatDateTime(row.healthSince) })} style={{ marginTop: 3 }}>
              {t('monitoring.services.since', { duration: since })}
              <span id={sinceId} style={SR_ONLY}>{t('monitoring.services.sinceHint', { date: formatDateTime(row.healthSince) })}</span>
            </div>
          )}
        </>
      )
    } },
    { key: 'impactScore', label: t('monitoring.services.columns.impact'), width: '150px', render: (_v, row) => <ImpactScore score={row.impactScore} health={row.health} /> },
    { key: 'explanation', label: t('monitoring.services.columns.cause'), sortValue: (row) => (row.explanation[0] ? causeLabel(t, row.explanation[0]) : null), render: (_v, row) => {
      const first = row.explanation[0]
      return first
        ? <span title={causeLabel(t, first)} style={{ display: 'block', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{causeLabel(t, first)}</span>
        : '—'
    } },
    { key: 'nodeCount', label: t('monitoring.services.columns.components'), width: '130px', render: (_v, row) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{t('monitoring.services.components', { count: row.nodeCount })}</span> },
    { key: 'service', label: t('monitoring.services.columns.owner'), width: '150px', sortValue: (row) => row.service.ownerGroup?.name ?? null, render: (_v, row) => row.service.ownerGroup?.name ?? '—' },
  ]
}

// ── Pagina ───────────────────────────────────────────────────────────────────

export function ServicesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { can } = useMe()
  const managesServices = can('config.services')

  const [searchParams, setSearchParams] = useSearchParams()
  const filter = useMemo(() => filterFromParams(searchParams), [searchParams])
  const page = pageFromParams(searchParams)
  const [searchInput, setSearchInput] = useState(filter.search)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

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

  // Ricerca con debounce; se `q` cambia da fuori (indietro/avanti) la casella si allinea.
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

  const toggleHealth = (h: ServiceHealth) => setParams({ health: filter.health === h ? null : h })

  const { data: liveData, previousData, loading, error, refetch, networkStatus } = useQuery<{ serviceMaps: ServiceMapPage }>(GET_SERVICE_MAPS, {
    variables: { filter: toFilterVars(filter), limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
    ...pausedWhenHidden(POLL_MS),
    notifyOnNetworkStatusChange: true,
  })
  // The previous filter's rows stand in only while the new ones are on their
  // way: after a failure they read as the answer, with the new tile pressed
  // (review of 23 Sep 2026).
  const data = liveData ?? (networkStatus === NetworkStatus.setVariables ? previousData : undefined)
  const updating = networkStatus === NetworkStatus.setVariables && previousData !== undefined
  useEffect(() => { if (networkStatus === NetworkStatus.ready && liveData) setLastUpdated(Date.now()) }, [networkStatus, liveData])

  // Il totale è sceso sotto la pagina corrente (polling) → ultima pagina disponibile.
  const liveTotal = liveData?.serviceMaps.total
  useEffect(() => {
    if (liveTotal === undefined) return
    const lastPage = Math.max(0, Math.ceil(liveTotal / PAGE_SIZE) - 1)
    if (page > lastPage) setPage(lastPage)
  }, [liveTotal, page, setPage])

  const pageData = data?.serviceMaps
  const counts = pageData?.counts
  const items = pageData?.items ?? []
  const total = pageData?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const nothingYet = counts !== undefined && counts.total === 0 && !hasFilter(filter)

  const tileContext = (h: ServiceHealth): string => {
    if (h === 'unknown') return t('monitoring.services.tiles.unknownContext')
    if ((counts?.[h] ?? 0) === 0) return t('monitoring.services.tiles.noneContext')
    return t('monitoring.services.tiles.shareContext', { count: counts?.total ?? 0 })
  }

  const updatedLabel = lastUpdated
    ? t('monitoring.services.updatedAt', { time: new Date(lastUpdated).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' }) })
    : '—'

  const serviceColumns = useServiceColumns()

  let tableBody: ReactNode
  if (error && !data) {
    tableBody = <QueryError message={error.message} onRetry={() => void refetch()} />
  } else if (loading && !data) {
    tableBody = <Loading padded />
  } else if (nothingYet) {
    tableBody = (
      <div className="card-border">
        <EmptyState
          icon={<Boxes size={32} />}
          title={t('monitoring.services.empty.title')}
          description={`${t('monitoring.services.empty.description')}${managesServices ? '' : ` ${t('monitoring.services.empty.askAdmin')}`}`}
          action={managesServices ? <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>{t('monitoring.services.empty.cta')}</Button> : undefined}
        />
      </div>
    )
  } else {
    tableBody = (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {t('monitoring.services.count', { count: total })}
            {updating && (
              <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-table)' }}>
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />{t('monitoring.console.updating')}
              </span>
            )}
          </span>
          {totalPages > 1 && <span>{t('monitoring.services.page', { page: page + 1, total: totalPages })}</span>}
        </div>
        <SortableFilterTable<ServiceMapRow>
          label={t('monitoring.services.title')}
          columns={serviceColumns}
          data={items}
          emptyMessage={t('monitoring.services.noMatch')}
          // The server pages the list by gravity: a column sorts the page on screen, and says so.
          sortHint={t('common.sortPageOnly')}
          onRowClick={(row) => navigate(servicePath(row.id))}
       />
        <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(page - 1)} onNext={() => setPage(page + 1)} />
      </>
    )
  }

  return (
    <PageContainer>
      <ListPageHeader
        icon={<Boxes size={22} color="var(--color-icon-accent)" />}
        title={t('monitoring.services.title')}
        subtitle={<p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>{t('monitoring.services.subtitle')}</p>}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>{updatedLabel}</span>
            <Button variant="secondary" size="xs" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={() => void refetch()}>{t('monitoring.services.refresh')}</Button>
            {managesServices && !nothingYet && (
              <Button size="xs" icon={<Plus size={13} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>{t('monitoring.services.create.title')}</Button>
            )}
          </div>
        }
      />

      {counts && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
          {TILE_ORDER.map((h) => (
            <HealthTile
              key={h}
              health={h}
              value={counts[h]}
              context={tileContext(h)}
              hint={t('monitoring.services.tiles.toggleHint')}
              active={filter.health === h}
              onClick={() => toggleHealth(h)}
            />
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        {/* Arrivo dalla colonna «Servizi» di Salute CI: il chip dice che si guarda un solo CI e il clic lo toglie. */}
        {filter.ciId && (
          <Chip pressed={true} data-testid="services-ci-filter" onClick={() => setParams({ ciId: null })}>
            {t('monitoring.console.ciFilter')}
          </Chip>
        )}
        <Select aria-label={t('monitoring.services.filters.status')} value={filter.status ?? ''} onChange={(e) => setParams({ status: e.target.value })} style={{ width: 180 }}>
          <option value="">{t('monitoring.services.filters.allStatuses')}</option>
          {SERVICE_MAP_STATUSES.map((s) => <option key={s} value={s}>{t(`monitoring.services.status.${s}`)}</option>)}
        </Select>
        <Input
          aria-label={t('monitoring.services.filters.search')}
          placeholder={t('monitoring.services.filters.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{ width: 240, marginLeft: 'auto' }}
        />
      </div>

      {error && data && <StaleDataBanner message={error.message} readAt={lastUpdated} onRetry={() => void refetch()} />}
      {tableBody}

      {/* Capacità di business in sola lettura (ondata 3): sotto la tabella, non è un filtro della lista. */}
      <div style={{ marginTop: 24 }}>
        <BusinessCapabilitiesSection />
      </div>

      {/* Mounted when opened: every opening starts clean (review of 23 Sep 2026). */}
      {managesServices && createOpen && <CreateServiceMapDialog open onClose={() => setCreateOpen(false)} onCreated={() => void refetch()} />}
    </PageContainer>
  )
}
