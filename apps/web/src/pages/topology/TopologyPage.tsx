import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Share2 } from 'lucide-react'
import { GET_TOPOLOGY, GET_ALL_CIS, GET_CI_TYPES } from '@/graphql/queries'
import { fontFamily } from '@/lib/tokens'
import { Pill } from '@/components/ui/Pill'
import { ciStatusStyle, enumLabel, useCIBaseEnums } from '@/lib/ciEnums'
import TopologyGraph, { TopologyLegend, type TopologyNode } from '@/components/topology/TopologyGraph'

// ── Types ────────────────────────────────────────────────────────────────────

interface TopologyData {
  topology: {
    nodes:     TopologyNode[]
    edges:     { source: string; target: string; type: string }[]
    truncated: boolean
    /** Cap server sui nodi (NODE_LIMIT) — mostrato nell'avviso di troncamento. */
    nodeLimit: number
  }
}

interface CIListData {
  allCIs: {
    total: number
    items: { id: string; name: string; type: string; status: string; environment: string | null }[]
  }
}

/** Voci mostrate nel combobox per una ricerca; oltre questo il server ha altri risultati ("mostrati N di M"). */
const COMBOBOX_LIMIT = 80
const COMBOBOX_DEBOUNCE_MS = 250

interface CITypeItem {
  name:  string
  label: string
  icon:  string
  color: string
}

interface Filters {
  type:        string
  environment: string
  status:      string
  onlyIncident: boolean
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function TopologyPage() {
  const { t } = useTranslation()
  const navigate  = useNavigate()
  const [filters, setFilters] = useState<Filters>({
    type:         '',
    environment:  '',
    status:       '',
    onlyIncident: false,
  })
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null)
  const [showLabels, setShowLabels]     = useState(true)
  const [focusNodeId, setFocusNodeId]   = useState<string | null>(null)
  const [maxHops, setMaxHops]           = useState<number | null>(2)  // null = tutti

  // ── CI types from metamodel — popola il dropdown tipo ───────────────────────
  const { data: ciTypesData } = useQuery<{ ciTypes: CITypeItem[] }>(GET_CI_TYPES, {
    fetchPolicy: 'cache-first',
  })
  const ciTypeOptions = useMemo(
    () => (ciTypesData?.ciTypes ?? []).filter(ct => ct.name !== '__base__'),
    [ciTypesData?.ciTypes],
  )
  // Status/environment dal tipo base del metamodello (unica sorgente, F-23)
  const baseEnums = useCIBaseEnums()

  // Reset focusNodeId quando l'utente cambia tipo
  useEffect(() => { setFocusNodeId(null) }, [filters.type])

  // ── Topology query — parte SOLO quando è selezionato un CI specifico ────────
  const queryVars = {
    selectedCiId: focusNodeId ?? undefined,
    maxHops:      maxHops     ?? undefined,
    environment:  filters.environment ? filters.environment : undefined,
    status:       filters.status      ? filters.status      : undefined,
  }

  // Polling a 30 s: TopologyGraph confronta la struttura (id nodi + archi) e a
  // struttura invariata aggiorna solo contatori/stati in place, senza
  // ricostruire simulazione, zoom e posizioni trascinate (F-06).
  const { data, loading, error } = useQuery<TopologyData>(GET_TOPOLOGY, {
    variables:   queryVars,
    skip:        !focusNodeId,
    pollInterval: 30_000,
    fetchPolicy:  'cache-and-network',
  })

  // Stable graph data — memoised per evitare rebuild D3 inutili
  const nodes = useMemo(
    () => (data?.topology.nodes ?? []).filter((n) =>
      !filters.onlyIncident || n.incidentCount > 0,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data?.topology.nodes, filters.onlyIncident],
  )
  const edges = useMemo(
    () => data?.topology.edges ?? [],
    [data?.topology.edges],
  )

  // Stats
  const totalIncident = nodes.reduce((s, n) => s + n.incidentCount, 0)
  const totalChange   = nodes.reduce((s, n) => s + n.changeCount,   0)

  const handleNodeClick = useCallback((node: TopologyNode) => {
    setSelectedNode(node)
  }, [])

  const selectStyle = {
    fontSize:     12,
    color:        'var(--color-slate-dark)',
    border:       '1px solid #e2e8f0',
    borderRadius: 6,
    padding:      '5px 10px',
    background:   '#fff',
    cursor:       'pointer',
    outline:      'none',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'space-between',
        padding:         '12px 20px',
        borderBottom:    '1px solid #e5e7eb',
        background:      '#fff',
        flexShrink:      0,
      }}>
        <h1 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>
          {t('pages.topology.title')}
        </h1>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Type filter */}
          <select aria-label={t('pages.cmdb.type')} value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))} style={selectStyle}>
            <option value="">{t('pages.topology.allTypes')}</option>
            {ciTypeOptions.map(ct => (
              <option key={ct.name} value={ct.name}>{ct.label}</option>
            ))}
          </select>

          {/* CI combobox — visible only when a type is selected */}
          {filters.type && (
            <CICombobox
              ciType={filters.type}
              value={focusNodeId}
              onChange={(id) => {
                setFocusNodeId(id)
                setSelectedNode(null)   // reset pannello dettaglio al cambio CI
              }}
            />
          )}

          {/* Hop depth selector — visible only when a CI is selected */}
          {focusNodeId && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>{t('pages.topology.depth')}</span>
              <select
                value={maxHops ?? 'all'}
                onChange={(e) => setMaxHops(e.target.value === 'all' ? null : Number(e.target.value))}
                style={selectStyle}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{t('pages.topology.hops', { count: n })}</option>
                ))}
                <option value="all">{t('pages.topology.allHops')}</option>
              </select>
            </label>
          )}

          {/* Environment filter */}
          <select aria-label={t('pages.cmdb.environment')} value={filters.environment} onChange={(e) => setFilters((f) => ({ ...f, environment: e.target.value }))} style={selectStyle} title={baseEnums.error ?? undefined}>
            <option value="">{t('pages.topology.allEnvironments')}</option>
            {baseEnums.environments.map((v) => <option key={v} value={v}>{enumLabel(v)}</option>)}
          </select>

          {/* Status filter */}
          <select aria-label={t('pages.cmdb.status')} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} style={selectStyle} title={baseEnums.error ?? undefined}>
            <option value="">{t('pages.topology.allStatuses')}</option>
            {baseEnums.statuses.map((v) => <option key={v} value={v}>{enumLabel(v)}</option>)}
          </select>
          {baseEnums.error && (
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-danger)' }} title={baseEnums.error}>
              {t('pages.topology.enumsUnavailable')}
            </span>
          )}

          {/* Labels toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showLabels}
              onChange={(e) => setShowLabels(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            {t('pages.topology.showLabels')}
          </label>

          {/* Incident only toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={filters.onlyIncident}
              onChange={(e) => setFilters((f) => ({ ...f, onlyIncident: e.target.checked }))}
              style={{ cursor: 'pointer' }}
            />
            {t('pages.topology.onlyWithIncidents')}
          </label>
        </div>
      </div>

      {/* ── Main area ───────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>

        {/* Graph canvas */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {/* Empty / loading state */}
          {nodes.length === 0 && !error && (
            <div style={{
              position:        'absolute', inset: 0,
              display:         'flex', flexDirection: 'column',
              alignItems:      'center', justifyContent: 'center',
              gap:             16,
              userSelect:      'none',
            }}>
              <Share2 size={48} color="#94a3b8" strokeWidth={1.5} />
              <div style={{
                fontSize: 'var(--font-size-page-title)', fontWeight: 600,
                color: 'var(--color-slate-dark)',
                fontFamily,
              }}>
                {t('pages.topology.title')}
              </div>
              <div style={{
                fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-light)',
                fontFamily,
                textAlign: 'center',
              }}>
                {loading
                  ? t('pages.topology.loading')
                  : t('pages.topology.emptyHint')}
              </div>
            </div>
          )}

          {error && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--danger)', fontSize: 'var(--font-size-card-title)',
              fontFamily,
            }}>
              {t('pages.topology.loadError', { error: error.message })}
            </div>
          )}

          {nodes.length > 0 && (
            <TopologyGraph
              nodes={nodes}
              edges={edges}
              onNodeClick={handleNodeClick}
              showLabels={showLabels}
              highlightNodeId={focusNodeId}
              rootNodeId={focusNodeId}
              ciTypes={ciTypeOptions}
            />
          )}

          <TopologyLegend nodes={nodes} edges={edges} ciTypes={ciTypeOptions} />

          {/* Truncation warning */}
          {data?.topology.truncated && (
            <div style={{
              position:   'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
              background: '#fef9c3', border: '1px solid #fde047', borderRadius: 6,
              padding:    '5px 14px', fontSize: 'var(--font-size-body)', color: '#854d0e',
              fontFamily,
              whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            }}>
              {t('pages.topology.truncated', { limit: data.topology.nodeLimit })}
            </div>
          )}

          {/* Stats bar */}
          <div style={{
            position:    'absolute', bottom: 16, right: selectedNode ? 316 : 16,
            background:  'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)',
            border:      '1px solid #e2e8f0', borderRadius: 6,
            padding:     '5px 12px', fontSize: 'var(--font-size-body)',
            color:       'var(--color-slate)',
            fontFamily,
            transition:  'right 200ms ease',
          }}>
            {t('pages.topology.stats', { nodes: nodes.length, edges: edges.length })}
            {focusNodeId && (
              <span style={{ marginLeft: 8 }}>
                {t('pages.topology.statsDepth', { depth: maxHops !== null ? t('pages.topology.hops', { count: maxHops }) : t('pages.topology.depthAll') })}
              </span>
            )}
            {totalIncident > 0 && <span style={{ color: 'var(--color-trigger-sla-breach)', marginLeft: 8 }}>{t('pages.topology.activeIncidents', { count: totalIncident })}</span>}
            {totalChange   > 0 && <span style={{ color: '#8b5cf6', marginLeft: 8 }}>{t('pages.topology.changesInProgress', { count: totalChange })}</span>}
          </div>
        </div>

        {/* ── Detail panel ─────────────────────────────────────────────── */}
        {selectedNode && (
          <div style={{
            width:       300,
            borderLeft:  '1px solid #e5e7eb',
            background:  '#fff',
            flexShrink:  0,
            overflow:    'auto',
            padding:     '16px',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>
                  {selectedNode.name}
                </div>
                <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 2 }}>
                  {selectedNode.type.replace(/_/g, ' ')}
                </div>
              </div>
              <button
                type="button"
                aria-label={t('common.close')}
                onClick={() => setSelectedNode(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 'var(--font-size-section-title)', padding: 0 }}
              >
                ✕
              </button>
            </div>

            {/* Fields */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <DetailField label={t('pages.cmdb.status')}>
                <StatusBadge status={selectedNode.status} />
              </DetailField>

              {selectedNode.environment && (
                <DetailField label={t('pages.cmdb.environment')}>
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{selectedNode.environment}</span>
                </DetailField>
              )}

              {selectedNode.ownerGroup && (
                <DetailField label={t('pages.cmdb.ownerGroup')}>
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{selectedNode.ownerGroup}</span>
                </DetailField>
              )}

              {/* Incident count */}
              <DetailField label={t('pages.topology.openIncidents')}>
                {selectedNode.incidentCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/incidents?ci=${selectedNode.id}`)}
                    style={{
                      fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-trigger-sla-breach)',
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline',
                    }}
                  >
                    {selectedNode.incidentCount}
                  </button>
                ) : (
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>0</span>
                )}
              </DetailField>

              {/* Change count */}
              <DetailField label={t('pages.topology.changeInProgress')}>
                {selectedNode.changeCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/changes?ci=${selectedNode.id}`)}
                    style={{
                      fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: '#f97316',
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline',
                    }}
                  >
                    {selectedNode.changeCount}
                  </button>
                ) : (
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>0</span>
                )}
              </DetailField>
            </div>

            {/* Actions */}
            <div style={{ marginTop: 20 }}>
              <button
                type="button"
                onClick={() => navigate(`/ci/${selectedNode.type}/${selectedNode.id}`)}
                style={{
                  width:        '100%',
                  padding:      '8px 0',
                  background:   'var(--color-brand)',
                  color:        '#fff',
                  border:       'none',
                  borderRadius: 6,
                  fontSize:     13,
                  fontWeight:   600,
                  cursor:       'pointer',
                  fontFamily,
                }}
              >
                {t('pages.topology.goToDetail')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 2 }}>{label}</div>
      {children}
    </div>
  )
}

// ── CICombobox ───────────────────────────────────────────────────────────────

interface CIComboboxProps {
  ciType:   string
  value:    string | null
  onChange: (id: string | null) => void
}

/**
 * Ricerca server-side (allCIs search + limit): prima caricava 500 CI del tipo
 * e ne mostrava al più 80 filtrati in locale, senza dire che mancavano gli
 * altri. Ora il totale è visibile ("mostrati N di M") e la ricerca copre tutto.
 */
function CICombobox({ ciType, value, onChange }: CIComboboxProps) {
  const { t } = useTranslation()
  const [search, setSearch]   = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen]       = useState(false)
  const [selectedName, setSelectedName] = useState('')
  const containerRef          = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = setTimeout(() => setDebounced(search.trim()), COMBOBOX_DEBOUNCE_MS)
    return () => clearTimeout(h)
  }, [search])

  const { data, loading, error } = useQuery<CIListData>(GET_ALL_CIS, {
    variables:   { type: ciType, search: debounced || undefined, limit: COMBOBOX_LIMIT },
    fetchPolicy: 'cache-first',
  })
  const options = useMemo(() => data?.allCIs.items ?? [], [data])
  const total   = data?.allCIs.total ?? 0

  // Nome del CI selezionato: tenuto in stato perché la lista cambia con la ricerca
  useEffect(() => {
    if (!value) { setSelectedName(''); return }
    const hit = options.find((o) => o.id === value)
    if (hit) setSelectedName(hit.name)
  }, [value, options])

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function handleSelect(id: string | null) {
    onChange(id)
    setSelectedName(id ? (options.find((o) => o.id === id)?.name ?? '') : '')
    setSearch('')
    setOpen(false)
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div style={{
        display:      'flex',
        alignItems:   'center',
        gap:          4,
        border:       '1px solid #e2e8f0',
        borderRadius: 6,
        background:   '#fff',
        padding:      '4px 8px',
        fontSize:     12,
        cursor:       'text',
        minWidth:     170,
        color:        value ? 'var(--color-slate-dark)' : 'var(--color-slate-light)',
      }}>
        {/* Nessun onClick sul contenitore: l'input occupa tutta la larghezza e apre la lista al focus */}
        <input
          value={open ? search : selectedName}
          onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          placeholder={t('pages.ci.searchTarget')}
          aria-label={t('pages.ci.searchTarget')}
          style={{
            border: 'none', outline: 'none', background: 'transparent',
            fontSize: 'var(--font-size-body)', width: '100%', color: 'inherit',
            fontFamily,
          }}
        />
        {value && (
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={(e) => { e.stopPropagation(); handleSelect(null) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: '0 2px', fontSize: 'var(--font-size-body)', lineHeight: 1 }}
          >
            ✕
          </button>
        )}
      </div>

      {open && (
        <div style={{
          position:   'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6,
          boxShadow:  '0 4px 16px rgba(0,0,0,0.1)',
          maxHeight:  220, overflowY: 'auto', marginTop: 2,
        }}>
          <button
            type="button"
            onClick={() => handleSelect(null)}
            className="hover-bg"
            style={{
              display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', font: 'inherit',
              padding: '7px 10px', fontSize: 'var(--font-size-body)', cursor: 'pointer',
              color: 'var(--color-slate-light)',
              borderBottom: '1px solid #f1f5f9',
            }}
          >
            {t('pages.topology.comboAll')}
          </button>
          {error && (
            <div style={{ padding: '7px 10px', fontSize: 'var(--font-size-body)', color: 'var(--color-danger)' }}>
              {t('pages.topology.searchError', { error: error.message })}
            </div>
          )}
          {!error && options.length === 0 && (
            <div style={{ padding: '7px 10px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
              {loading ? t('pages.topology.searching') : t('common.noResults')}
            </div>
          )}
          {options.map((o) => (
            <button
              type="button"
              key={o.id}
              onClick={() => handleSelect(o.id)}
              style={{
                width: '100%', textAlign: 'left', border: 'none', font: 'inherit',
                padding:    '7px 10px', fontSize: 'var(--font-size-body)', cursor: 'pointer',
                background: o.id === value ? 'rgba(2,132,199,0.08)' : 'transparent',
                color:      o.id === value ? 'var(--color-brand)' : 'var(--color-slate-dark)',
                fontWeight: o.id === value ? 600 : 400,
                display:    'flex', alignItems: 'center', justifyContent: 'space-between',
              }}
              onMouseEnter={(e) => { if (o.id !== value) (e.currentTarget as HTMLElement).style.background = 'var(--color-slate-bg)' }}
              onMouseLeave={(e) => { if (o.id !== value) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span>{o.name}</span>
              {o.environment && (
                <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                  {o.environment}
                </span>
              )}
            </button>
          ))}
          {total > options.length && (
            <div style={{ padding: '6px 10px', fontSize: 'var(--font-size-label)', color: '#854d0e', background: '#fef9c3', borderTop: '1px solid #fde68a' }}>
              {t('pages.topology.comboShown', { shown: options.length, total })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Stato CI colorato: palette unica in lib/ciEnums (CI_STATUS_STYLE). */
function StatusBadge({ status }: { status: string }) {
  const s = ciStatusStyle(status)
  return <Pill bg={s.bg} color={s.color} radius={10} style={{ fontSize: 'var(--font-size-body)' }}>{status}</Pill>
}
