/**
 * Pagina «Servizi» (gruppo Monitoraggio, staff): la salute dei servizi di
 * business calcolata dai componenti che li reggono, dal più grave.
 *
 * Struttura come Salute CI: quattro riquadri-contatore cliccabili (Giù /
 * Degradati / In manutenzione / Operativi; «Sconosciuti» è solo informativo:
 * nessun componente con salute nota), filtri (stato della mappa, ricerca con
 * debounce) e tabella per gravità: servizio (link), salute con «da N min»,
 * punteggio d'impatto (barra 0–100 + numero), causa principale («db-01 giù
 * via api-03»), componenti, owner. Polling ogni 15 s (in pausa a scheda
 * nascosta) + Aggiorna; al cambio di filtro o pagina la tabella tiene le
 * righe precedenti con «Aggiornamento…».
 *
 * L'URL è la sorgente dei filtri e della pagina (`?health=down&status=active
 * &q=billing&page=2`, scritti con `replace`): un F5 o un link condiviso non li
 * perdono. Stato vuoto (nessuna mappa nel tenant): «Crea una mappa» (admin)
 * apre il dialogo minimale CreateServiceMapDialog.
 *
 * Contratto: `serviceMaps` in apps/api/src/graphql/schema-services.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { NetworkStatus } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Boxes, RefreshCw, XCircle, AlertTriangle, CheckCircle2, Wrench, HelpCircle, Plus, Loader2, type LucideIcon } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { ListPageHeader } from '@/components/ListPageHeader'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import { Pagination } from '@/components/ui/Pagination'
import { Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { useMe } from '@/hooks/useMe'
import { enumLabel } from '@/lib/ciEnums'
import { formatDateTime, formatDuration, currentLocale } from '@/lib/datetime'
import { pausedWhenHidden } from '@/lib/polling'
import { GET_SERVICE_MAPS } from '@/graphql/queries'
import { colors, palette } from '@/lib/tokens'
import { CreateServiceMapDialog } from './CreateServiceMapDialog'
import { SERVICE_HEALTH_FAMILY, ServiceHealthBadge, ServiceStatusPill, ImpactScore, causeLabel, isServiceHealth, serviceHealthFamily } from './servicesShared'
import { SERVICE_MAP_STATUSES, type ServiceHealth, type ServiceMapStatus, type ServiceMapPage, type ServiceMapRow, type ServiceMapFilterVars } from '@/types/services'

const PAGE_SIZE       = 50
const POLL_MS         = 15_000
const SEARCH_DEBOUNCE = 300

const isStatus = (v: string | null): v is ServiceMapStatus => v !== null && (SERVICE_MAP_STATUSES as readonly string[]).includes(v)

export const servicePath = (id: string) => `/monitoring/services/${encodeURIComponent(id)}`

/** Riquadri: i primi quattro filtrano, «sconosciuti» è una nota. */
const TILE_ORDER: ServiceHealth[] = ['down', 'degraded', 'maintenance', 'operational', 'unknown']
const TILE_ICON: Record<ServiceHealth, LucideIcon> = { down: XCircle, degraded: AlertTriangle, maintenance: Wrench, operational: CheckCircle2, unknown: HelpCircle }

/** Testo solo per le tecnologie assistive (descrizioni via `aria-describedby`). */
const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
}

interface ServicesFilter {
  health: ServiceHealth | null
  status: ServiceMapStatus | null
  search: string
}

const hasFilter = (f: ServicesFilter) => f.health !== null || f.status !== null || !!f.search.trim()

function toFilterVars(f: ServicesFilter): ServiceMapFilterVars | null {
  const vars: ServiceMapFilterVars = {}
  if (f.health)        vars.health = [f.health]
  if (f.status)        vars.status = f.status
  if (f.search.trim()) vars.search = f.search.trim()
  return Object.keys(vars).length ? vars : null
}

// ── URL ──────────────────────────────────────────────────────────────────────

const URL_KEYS = { health: 'health', status: 'status', search: 'q', page: 'page' } as const

/** Un valore di `health`/`status` fuori vocabolario nell'URL viene ignorato (URL scritto a mano): la pagina mostra tutto. */
function filterFromParams(p: URLSearchParams): ServicesFilter {
  const health = p.get(URL_KEYS.health)
  const status = p.get(URL_KEYS.status)
  return {
    health: isServiceHealth(health) ? health : null,
    status: isStatus(status) ? status : null,
    search: p.get(URL_KEYS.search) ?? '',
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
  /** Assente = riquadro informativo, non cliccabile. */
  onClick?: () => void
}

function HealthTile({ health, value, context, hint, active, onClick }: TileProps) {
  const { t } = useTranslation()
  const fam = SERVICE_HEALTH_FAMILY[health]
  const Icon = TILE_ICON[health]
  const body = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 999, background: fam.tint, color: fam.accent, flexShrink: 0 }}>
          <Icon size={20} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 28, lineHeight: 1.1, fontWeight: 700, color: fam.accent, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 }}>{t(`monitoring.services.tiles.${health}`)}</div>
        </div>
      </div>
      <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 10 }}>{context}</div>
    </>
  )
  const style: React.CSSProperties = {
    textAlign: 'left', font: 'inherit', padding: '14px 16px', borderRadius: 12, minWidth: 0,
    background: active ? fam.tint : colors.white,
    border: active ? `2px solid ${fam.accent}` : '1px solid var(--border)',
    boxShadow: 'var(--shadow-card)',
    cursor: onClick ? 'pointer' : 'default',
    transition: 'background-color 150ms, border-color 150ms',
  }
  return onClick
    ? <button type="button" onClick={onClick} aria-pressed={active} title={hint} style={style}>{body}</button>
    : <div title={hint} style={style}>{body}</div>
}

// ── Tabella ──────────────────────────────────────────────────────────────────

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '10px 12px', fontSize: 'var(--font-size-label)', fontWeight: 600, letterSpacing: '0.05em',
  textTransform: 'uppercase', color: 'var(--color-slate)', background: 'var(--surface-1)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { padding: '10px 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', verticalAlign: 'middle' }

/** Riga: il clic apre il dettaglio, il bersaglio da tastiera è il Link sul nome (niente tabIndex sulla riga). */
function ServiceRowView({ row }: { row: ServiceMapRow }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // Salute fuori vocabolario → famiglia «rotta» (rossa, loggata), mai un colore plausibile.
  const fam = serviceHealthFamily(row.health)
  const since = row.healthSince ? formatDuration(Date.now() - new Date(row.healthSince).getTime()) : null
  const to = servicePath(row.id)
  const sinceId = `service-${row.id}-since`
  const first = row.explanation[0]
  const meta = [row.service.criticality ? enumLabel(row.service.criticality) : null].filter(Boolean).join(' · ')

  return (
    <tr onClick={() => navigate(to)} className="hover-bg" style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
      <td style={{ ...TD, borderLeft: `4px solid ${fam.accent}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Link to={to} onClick={(e) => e.stopPropagation()} title={t('monitoring.services.openService', { name: row.name })} style={{ fontWeight: 600, color: 'var(--color-slate-dark)', textDecoration: 'none' }}>
            {row.name}
          </Link>
          {row.status !== 'active' && <ServiceStatusPill status={row.status} />}
          {row.stale && (
            <span role="img" aria-label={t('monitoring.services.staleShort')} title={t('monitoring.services.staleShort')} style={{ display: 'inline-flex', color: palette.warning.base }}>
              <AlertTriangle size={14} aria-hidden="true" />
            </span>
          )}
        </div>
        {meta && <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 2 }}>{meta}</div>}
      </td>
      <td style={TD}>
        <ServiceHealthBadge health={row.health} />
        {since && (
          <div aria-describedby={sinceId} title={t('monitoring.services.sinceHint', { date: formatDateTime(row.healthSince) })} style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 3 }}>
            {t('monitoring.services.since', { duration: since })}
            <span id={sinceId} style={SR_ONLY}>{t('monitoring.services.sinceHint', { date: formatDateTime(row.healthSince) })}</span>
          </div>
        )}
      </td>
      <td style={TD}><ImpactScore score={row.impactScore} health={row.health} /></td>
      <td style={{ ...TD, maxWidth: 320 }}>
        {first
          ? <span title={causeLabel(t, first)} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{causeLabel(t, first)}</span>
          : <span style={{ color: 'var(--color-slate-light)' }}>—</span>}
      </td>
      <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{t('monitoring.services.components', { count: row.nodeCount })}</td>
      <td style={TD}>{row.service.ownerGroup?.name ?? <span style={{ color: 'var(--color-slate-light)' }}>—</span>}</td>
    </tr>
  )
}

// ── Pagina ───────────────────────────────────────────────────────────────────

export function ServicesPage() {
  const { t } = useTranslation()
  const { isAdmin } = useMe()

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
  const data = liveData ?? previousData
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

  const headers: { key: string; label: string; width?: string }[] = [
    { key: 'service',    label: t('monitoring.services.columns.service') },
    { key: 'health',     label: t('monitoring.services.columns.health'),     width: '160px' },
    { key: 'impact',     label: t('monitoring.services.columns.impact'),     width: '150px' },
    { key: 'cause',      label: t('monitoring.services.columns.cause') },
    { key: 'components', label: t('monitoring.services.columns.components'), width: '130px' },
    { key: 'owner',      label: t('monitoring.services.columns.owner'),      width: '150px' },
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
          icon={<Boxes size={32} />}
          title={t('monitoring.services.empty.title')}
          description={`${t('monitoring.services.empty.description')}${isAdmin ? '' : ` ${t('monitoring.services.empty.askAdmin')}`}`}
          action={isAdmin ? <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>{t('monitoring.services.empty.cta')}</Button> : undefined}
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
        <div className="card-border" style={{ overflowX: 'auto' }}>
          <table aria-label={t('monitoring.services.title')} style={{ width: '100%', minWidth: 860, borderCollapse: 'collapse' }}>
            <thead>
              <tr>{headers.map((h) => <th key={h.key} scope="col" style={{ ...TH, width: h.width }}>{h.label}</th>)}</tr>
            </thead>
            <tbody>
              {items.length === 0
                ? <tr><td colSpan={headers.length} style={{ ...TD, textAlign: 'center', color: 'var(--color-slate-light)', padding: '28px 12px' }}>{t('monitoring.services.noMatch')}</td></tr>
                : items.map((row) => <ServiceRowView key={row.id} row={row} />)}
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
        icon={<Boxes size={22} color="var(--color-icon-accent)" />}
        title={t('monitoring.services.title')}
        subtitle={<p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>{t('monitoring.services.subtitle')}</p>}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>{updatedLabel}</span>
            <Button variant="secondary" size="xs" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={() => void refetch()}>{t('monitoring.services.refresh')}</Button>
            {isAdmin && !nothingYet && (
              <Button size="xs" icon={<Plus size={13} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>{t('monitoring.services.create.title')}</Button>
            )}
          </div>
        }
      />

      {counts && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
          {TILE_ORDER.map((h) => {
            const clickable = h !== 'unknown'
            return (
              <HealthTile
                key={h}
                health={h}
                value={counts[h]}
                context={tileContext(h)}
                hint={clickable ? t('monitoring.services.tiles.toggleHint') : t('monitoring.services.tiles.unknownHint')}
                active={clickable && filter.health === h}
                onClick={clickable ? () => toggleHealth(h) : undefined}
              />
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
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

      {tableBody}

      {isAdmin && <CreateServiceMapDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => void refetch()} />}
    </PageContainer>
  )
}
