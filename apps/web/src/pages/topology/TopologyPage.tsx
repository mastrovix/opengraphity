import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { Share2 } from 'lucide-react'
import { GET_TOPOLOGY, GET_ALL_CIS, GET_CI_TYPES } from '@/graphql/queries'
import TopologyGraph, { TopologyLegend, type TopologyNode } from '@/components/topology/TopologyGraph'

// ── Types ────────────────────────────────────────────────────────────────────

interface TopologyData {
  topology: {
    nodes:     TopologyNode[]
    edges:     { source: string; target: string; type: string }[]
    truncated: boolean
  }
}

interface CIListData {
  allCIs: {
    items: { id: string; name: string; type: string; status: string; environment: string | null }[]
  }
}

interface CITypeItem {
  name:  string
  label: string
}

interface Filters {
  type:        string
  environment: string
  status:      string
  onlyIncident: boolean
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function TopologyPage() {
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
    () => (ciTypesData?.ciTypes ?? []).filter(t => t.name !== '__base__'),
    [ciTypesData?.ciTypes],
  )

  // ── CI list query — popola il combobox, si avvia solo quando si sceglie un tipo ──
  const { data: ciListData } = useQuery<CIListData>(GET_ALL_CIS, {
    variables:   { type: filters.type || undefined, limit: 500 },
    skip:        !filters.type,
    fetchPolicy: 'cache-first',
  })

  const ciOptions = useMemo(
    () => (ciListData?.allCIs.items ?? [])
      .map((ci) => ({
        id:            ci.id,
        name:          ci.name,
        type:          ci.type,
        status:        ci.status,
        environment:   ci.environment ?? null,
        ownerGroup:    null,
        incidentCount: 0,
        changeCount:   0,
      } as TopologyNode))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [ciListData?.allCIs.items],
  )

  // Reset focusNodeId quando l'utente cambia tipo
  useEffect(() => { setFocusNodeId(null) }, [filters.type])

  // ── Topology query — parte SOLO quando è selezionato un CI specifico ────────
  const queryVars = {
    selectedCiId: focusNodeId ?? undefined,
    maxHops:      maxHops     ?? undefined,
    environment:  filters.environment ? filters.environment : undefined,
    status:       filters.status      ? filters.status      : undefined,
  }

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
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
          Topology Map
        </h1>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Type filter */}
          <select value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))} style={selectStyle}>
            <option value="">Tutti i tipi</option>
            {ciTypeOptions.map(t => (
              <option key={t.name} value={t.name}>{t.label}</option>
            ))}
          </select>

          {/* CI combobox — visible only when a type is selected */}
          {filters.type && (
            <CICombobox
              options={ciOptions}
              value={focusNodeId}
              onChange={(id) => {
                setFocusNodeId(id)
                setSelectedNode(null)   // reset pannello dettaglio al cambio CI
              }}
            />
          )}

          {/* Hop depth selector — visible only when a CI is selected */}
          {focusNodeId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ fontSize: 12, color: 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>Profondità</span>
              <select
                value={maxHops ?? 'all'}
                onChange={(e) => setMaxHops(e.target.value === 'all' ? null : Number(e.target.value))}
                style={selectStyle}
              >
                <option value={1}>1 hop</option>
                <option value={2}>2 hop</option>
                <option value={3}>3 hop</option>
                <option value={4}>4 hop</option>
                <option value={5}>5 hop</option>
                <option value="all">Tutti</option>
              </select>
            </div>
          )}

          {/* Environment filter */}
          <select value={filters.environment} onChange={(e) => setFilters((f) => ({ ...f, environment: e.target.value }))} style={selectStyle}>
            <option value="">Tutti gli env</option>
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="development">Development</option>
          </select>

          {/* Status filter */}
          <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} style={selectStyle}>
            <option value="">Tutti gli stati</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="maintenance">Maintenance</option>
          </select>

          {/* Labels toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--color-slate)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showLabels}
              onChange={(e) => setShowLabels(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Label
          </label>

          {/* Incident only toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--color-slate)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={filters.onlyIncident}
              onChange={(e) => setFilters((f) => ({ ...f, onlyIncident: e.target.checked }))}
              style={{ cursor: 'pointer' }}
            />
            Solo con incident
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
                fontSize: 24, fontWeight: 600,
                color: 'var(--color-slate-dark)',
                fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
              }}>
                Topology Map
              </div>
              <div style={{
                fontSize: 15, color: '#94a3b8',
                fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                textAlign: 'center',
              }}>
                {loading
                  ? 'Caricamento topologia…'
                  : 'Esplora le relazioni tra i CI dell\'infrastruttura'}
              </div>
            </div>
          )}

          {error && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--danger)', fontSize: 14,
              fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
            }}>
              Errore nel caricamento: {error.message}
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
            />
          )}

          <TopologyLegend />

          {/* Truncation warning */}
          {data?.topology.truncated && (
            <div style={{
              position:   'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
              background: '#fef9c3', border: '1px solid #fde047', borderRadius: 6,
              padding:    '5px 14px', fontSize: 12, color: '#854d0e',
              fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
              whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            }}>
              ⚠️ Grafo troncato a 2000 nodi — usa i filtri per restringere
            </div>
          )}

          {/* Stats bar */}
          <div style={{
            position:    'absolute', bottom: 16, right: selectedNode ? 316 : 16,
            background:  'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)',
            border:      '1px solid #e2e8f0', borderRadius: 6,
            padding:     '5px 12px', fontSize: 12,
            color:       'var(--color-slate-light)',
            fontFamily:  "'Plus Jakarta Sans', system-ui, sans-serif",
            transition:  'right 200ms ease',
          }}>
            {nodes.length} nodi · {edges.length} relazioni
            {focusNodeId && (
              <span style={{ marginLeft: 8 }}>
                · profondità: {maxHops !== null ? `${maxHops} hop` : 'tutti'}
              </span>
            )}
            {totalIncident > 0 && <span style={{ color: '#dc2626', marginLeft: 8 }}>{totalIncident} incident attivi</span>}
            {totalChange   > 0 && <span style={{ color: '#f97316', marginLeft: 8 }}>{totalChange} change in corso</span>}
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
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
                  {selectedNode.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginTop: 2 }}>
                  {selectedNode.type.replace(/_/g, ' ')}
                </div>
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 16, padding: 0 }}
              >
                ✕
              </button>
            </div>

            {/* Fields */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <DetailField label="Status">
                <StatusBadge status={selectedNode.status} />
              </DetailField>

              {selectedNode.environment && (
                <DetailField label="Environment">
                  <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{selectedNode.environment}</span>
                </DetailField>
              )}

              {selectedNode.ownerGroup && (
                <DetailField label="Owner Group">
                  <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{selectedNode.ownerGroup}</span>
                </DetailField>
              )}

              {/* Incident count */}
              <DetailField label="Incident aperti">
                {selectedNode.incidentCount > 0 ? (
                  <button
                    onClick={() => navigate(`/incidents?ci=${selectedNode.id}`)}
                    style={{
                      fontSize: 14, fontWeight: 600, color: '#dc2626',
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline',
                    }}
                  >
                    {selectedNode.incidentCount}
                  </button>
                ) : (
                  <span style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>0</span>
                )}
              </DetailField>

              {/* Change count */}
              <DetailField label="Change in corso">
                {selectedNode.changeCount > 0 ? (
                  <button
                    onClick={() => navigate(`/changes?ci=${selectedNode.id}`)}
                    style={{
                      fontSize: 14, fontWeight: 600, color: '#f97316',
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline',
                    }}
                  >
                    {selectedNode.changeCount}
                  </button>
                ) : (
                  <span style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>0</span>
                )}
              </DetailField>
            </div>

            {/* Actions */}
            <div style={{ marginTop: 20 }}>
              <button
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
                  fontFamily:   "'Plus Jakarta Sans', system-ui, sans-serif",
                }}
              >
                Vai al dettaglio →
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
      <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>{label}</div>
      {children}
    </div>
  )
}

// ── CICombobox ───────────────────────────────────────────────────────────────

interface CIComboboxProps {
  options:  TopologyNode[]
  value:    string | null
  onChange: (id: string | null) => void
}

function CICombobox({ options, value, onChange }: CIComboboxProps) {
  const [search, setSearch]   = useState('')
  const [open, setOpen]       = useState(false)
  const containerRef          = useRef<HTMLDivElement>(null)

  const selectedName = options.find((o) => o.id === value)?.name ?? ''
  const filtered = search
    ? options.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    : options

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
      }} onClick={() => setOpen(true)}>
        <input
          value={open ? search : selectedName}
          onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder="Cerca CI…"
          style={{
            border: 'none', outline: 'none', background: 'transparent',
            fontSize: 12, width: '100%', color: 'inherit',
            fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
          }}
        />
        {value && (
          <button
            onClick={(e) => { e.stopPropagation(); handleSelect(null) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: '0 2px', fontSize: 12, lineHeight: 1 }}
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
          <div
            onClick={() => handleSelect(null)}
            style={{
              padding: '7px 10px', fontSize: 12, cursor: 'pointer',
              color: 'var(--color-slate-light)',
              borderBottom: '1px solid #f1f5f9',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#f8fafc' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            — Tutti —
          </div>
          {filtered.length === 0 && (
            <div style={{ padding: '7px 10px', fontSize: 12, color: 'var(--color-slate-light)' }}>
              Nessun risultato
            </div>
          )}
          {filtered.slice(0, 80).map((o) => (
            <div
              key={o.id}
              onClick={() => handleSelect(o.id)}
              style={{
                padding:    '7px 10px', fontSize: 12, cursor: 'pointer',
                background: o.id === value ? 'rgba(2,132,199,0.08)' : 'transparent',
                color:      o.id === value ? 'var(--color-brand)' : 'var(--color-slate-dark)',
                fontWeight: o.id === value ? 600 : 400,
                display:    'flex', alignItems: 'center', justifyContent: 'space-between',
              }}
              onMouseEnter={(e) => { if (o.id !== value) (e.currentTarget as HTMLElement).style.background = '#f8fafc' }}
              onMouseLeave={(e) => { if (o.id !== value) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span>{o.name}</span>
              {o.incidentCount > 0 && (
                <span style={{ fontSize: 10, color: '#dc2626', fontWeight: 600 }}>
                  {o.incidentCount} INC
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    active:      { bg: '#dcfce7', color: '#166534' },
    inactive:    { bg: '#fee2e2', color: '#991b1b' },
    maintenance: { bg: '#fef9c3', color: '#854d0e' },
  }
  const s = map[status] ?? { bg: '#f1f5f9', color: '#64748b' }
  return (
    <span style={{
      fontSize: 12, fontWeight: 600,
      background: s.bg, color: s.color,
      padding: '2px 8px', borderRadius: 10,
    }}>
      {status}
    </span>
  )
}
