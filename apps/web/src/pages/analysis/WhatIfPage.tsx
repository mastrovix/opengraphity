import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useLazyQuery, useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FlaskConical, Zap, Trash2, Users, ShieldCheck, GitBranch } from 'lucide-react'
import * as d3 from 'd3'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Skeleton } from '@/components/ui/skeleton'
import { GET_ALL_CIS, GET_CI_TYPES, WHAT_IF_ANALYSIS } from '@/graphql/queries'

// ── Types ────────────────────────────────────────────────────────────────────

interface WhatIfCI {
  id: string; name: string; type: string; environment: string | null
  status: string | null; impactLevel: string; impactPath: string[]; isRedundant: boolean
}
interface WhatIfTeam { id: string; name: string; role: string; impactedCICount: number }
interface WhatIfResult {
  targetCI: WhatIfCI; action: string; impactedCIs: WhatIfCI[]
  impactedServices: WhatIfCI[]; impactedTeams: WhatIfTeam[]
  totalImpacted: number; riskScore: number; hasRedundancy: boolean
  openIncidents: number; summary: string
}
interface CIOption { id: string; name: string; type: string }

type Action = 'impact' | 'remove'

// ── Styles ───────────────────────────────────────────────────────────────────

const ACTIONS: { key: Action; icon: typeof Zap; labelKey: string; bg: string; fg: string }[] = [
  { key: 'impact', icon: Zap,    labelKey: 'pages.whatIf.impact',  bg: '#e0f2fe', fg: '#0284c7' },
  { key: 'remove', icon: Trash2, labelKey: 'pages.whatIf.remove',  bg: '#e0f2fe', fg: '#0284c7' },
]

const IMPACT_STYLES: Record<string, { bg: string; fg: string }> = {
  critical: { bg: '#fee2e2', fg: '#991b1b' },
  high:     { bg: '#ffedd5', fg: '#9a3412' },
  medium:   { bg: '#fef3c7', fg: '#92400e' },
  low:      { bg: '#f3f4f6', fg: '#374151' },
}

function badge(bg: string, fg: string, text: string) {
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 'var(--font-size-table)', fontWeight: 600, background: bg, color: fg }}>{text}</span>
}

/** Convert PascalCase Neo4j label to snake_case route param: "DatabaseInstance" → "database_instance" */
function labelToRoute(label: string): string {
  return label.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

// ── Component ────────────────────────────────────────────────────────────────

export function WhatIfPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  // Input state
  const [ciSearch, setCiSearch] = useState('')
  const [selectedCI, setSelectedCI] = useState<CIOption | null>(null)
  const [action, setAction] = useState<Action>('impact')
  const [depth, setDepth] = useState(5)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [resultTab, setResultTab] = useState<'cis' | 'services' | 'teams'>('cis')
  const [expandedGraphId, setExpandedGraphId] = useState<string | null>(null)

  // CI type → icon map from metamodel
  const { data: ciTypesData } = useQuery<{ ciTypes: { name: string; icon: string }[] }>(GET_CI_TYPES, { fetchPolicy: 'cache-first' })
  const typeIconMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const ct of ciTypesData?.ciTypes ?? []) m.set(ct.name.toLowerCase().replace(/[_\s]/g, ''), ct.icon ?? 'box')
    return m
  }, [ciTypesData])

  // CI search
  const { data: ciData } = useQuery<{ allCIs: { items: CIOption[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch || null, limit: 20 },
    skip: ciSearch.length < 1,
  })
  const ciOptions = ciData?.allCIs?.items ?? []

  // Analysis
  const [runAnalysis, { data: resultData, loading }] = useLazyQuery<{ whatIfAnalysis: WhatIfResult }>(WHAT_IF_ANALYSIS, { fetchPolicy: 'network-only' })
  const result = resultData?.whatIfAnalysis ?? null

  function handleAnalyze() {
    if (!selectedCI) return
    void runAnalysis({ variables: { ciId: selectedCI.id, action, depth } })
  }

  // name → type map from results
  const nameTypeMap = useMemo(() => {
    const m = new Map<string, string>()
    if (result) {
      m.set(result.targetCI.name, result.targetCI.type)
      for (const ci of result.impactedCIs) m.set(ci.name, ci.type)
    }
    return m
  }, [result])

  // Filter + pagination for results tables
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [cisPage, setCisPage] = useState(0)
  const [svcPage, setSvcPage] = useState(0)
  const [teamPage, setTeamPage] = useState(0)
  const PAGE_SIZE = 20

  const impactLabel = (k: string) => t(`pages.whatIf.${k}` as const, k)

  const filterFields: FieldConfig[] = useMemo(() => {
    if (!result) return []
    const types = [...new Set(result.impactedCIs.map(c => c.type))].map(v => ({ value: v, label: v }))
    const levels = (['critical', 'high', 'medium', 'low']).map(k => ({ value: k, label: impactLabel(k) }))
    const envs = [...new Set(result.impactedCIs.map(c => c.environment).filter(Boolean))].map(e => ({ value: e!, label: e! }))
    return [
      { key: 'name', label: t('pages.whatIf.colName'), type: 'text' as const },
      { key: 'type', label: t('pages.whatIf.filterType'), type: 'enum' as const, options: types },
      { key: 'impactLevel', label: t('pages.whatIf.filterImpact'), type: 'enum' as const, options: levels },
      { key: 'environment', label: t('pages.whatIf.filterEnv'), type: 'enum' as const, options: envs },
    ]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, t])

  // Client-side filter/sort for results (data already loaded)
  const filteredCIs = useMemo(() => {
    let cis = result?.impactedCIs ?? []
    if (filterGroup?.rules?.length) {
      cis = cis.filter(ci => filterGroup.rules.every(r => {
        const raw = (ci as unknown as Record<string, unknown>)[r.field]
        const val = String(Array.isArray(raw) ? raw.join(', ') : raw ?? '').toLowerCase()
        const op = r.operator as string
        if (op === 'in' || op === 'equals') {
          const vals = Array.isArray(r.value) ? r.value.map(v => v.toLowerCase()) : [String(r.value ?? '').toLowerCase()]
          return vals.some(v => val === v)
        }
        if (op === 'not_in' || op === 'not_equals') {
          const vals = Array.isArray(r.value) ? r.value.map(v => v.toLowerCase()) : [String(r.value ?? '').toLowerCase()]
          return !vals.some(v => val === v)
        }
        if (op === 'contains') return val.includes(String(r.value ?? '').toLowerCase())
        if (op === 'starts_with') return val.startsWith(String(r.value ?? '').toLowerCase())
        if (op === 'is_empty') return val === ''
        if (op === 'is_not_empty') return val !== ''
        return true
      }))
    }
    if (sortField) {
      const dir = sortDir === 'asc' ? 1 : -1
      cis = [...cis].sort((a, b) => {
        const va = String((a as unknown as Record<string, unknown>)[sortField] ?? '')
        const vb = String((b as unknown as Record<string, unknown>)[sortField] ?? '')
        return va < vb ? -dir : va > vb ? dir : 0
      })
    }
    return cis
  }, [result, filterGroup, sortField, sortDir])

  const columns: ColumnDef<WhatIfCI>[] = [
    { key: 'name', label: t('pages.whatIf.colName'), sortable: true },
    { key: 'type', label: t('pages.whatIf.colType'), sortable: true, width: '120px', render: (v) => badge('#e0f2fe', '#0369a1', String(v)) },
    { key: 'environment', label: t('pages.whatIf.colEnv'), sortable: true, width: '110px', render: (v) => v ? badge('#f0fdf4', '#166534', String(v)) : <span style={{ color: '#cbd5e1' }}>—</span> },
    { key: 'impactLevel', label: t('pages.whatIf.colImpact'), sortable: true, width: '100px', render: (v) => {
      const ic = IMPACT_STYLES[String(v)] ?? IMPACT_STYLES['low']
      return badge(ic.bg, ic.fg, impactLabel(String(v)))
    }},
    { key: 'impactPath', label: t('pages.whatIf.colPath'), sortable: true, render: (v) => {
      const path = v as unknown as string[]
      return <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{path?.join(' → ') || '—'}</span>
    }},
    { key: 'id', label: '', width: '44px', render: (_v, row) => (
      <button
        onClick={e => { e.stopPropagation(); setExpandedGraphId(expandedGraphId === row.id ? null : row.id) }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', borderRadius: 4 }}
        title={t('pages.whatIf.viewPath')}
      >
        <GitBranch size={15} color={expandedGraphId === row.id ? 'var(--color-brand)' : '#94a3b8'} />
      </button>
    )},
  ]

  // Risk score color
  const scoreColor = (s: number) => s < 30 ? '#16a34a' : s < 60 ? '#eab308' : s < 80 ? '#f97316' : '#ef4444'

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<FlaskConical size={22} color="#38bdf8" />}>
          {t('pages.whatIf.title')}
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 4, marginBottom: 0 }}>
          {t('pages.whatIf.subtitle')}
        </p>
      </div>

      {/* Input bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {/* CI search */}
        <div style={{ position: 'relative', width: 300 }}>
          <input
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)', outline: 'none', boxSizing: 'border-box' }}
            placeholder={t('pages.whatIf.searchCI')}
            value={selectedCI ? selectedCI.name : ciSearch}
            onChange={e => { setCiSearch(e.target.value); setSelectedCI(null); setDropdownOpen(true) }}
            onFocus={() => { if (ciSearch.length >= 1) setDropdownOpen(true) }}
            onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
          />
          {dropdownOpen && ciOptions.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, marginTop: 2, maxHeight: 200, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
              {ciOptions.map(ci => (
                <div
                  key={ci.id}
                  onMouseDown={() => { setSelectedCI(ci); setCiSearch(''); setDropdownOpen(false) }}
                  style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 'var(--font-size-body)', display: 'flex', justifyContent: 'space-between' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#f0f9ff' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#fff' }}
                >
                  <span style={{ fontWeight: 500 }}>{ci.name}</span>
                  <span style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8' }}>{ci.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Action pills */}
        <div style={{ display: 'flex', gap: 4 }}>
          {ACTIONS.map(a => {
            const sel = action === a.key
            return (
              <button
                key={a.key}
                onClick={() => setAction(a.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px',
                  borderRadius: 20, border: sel ? `2px solid ${a.fg}` : '2px solid #e5e7eb',
                  background: sel ? a.bg : '#fff', color: sel ? a.fg : '#64748b',
                  fontSize: 'var(--font-size-body)', fontWeight: 600, cursor: 'pointer', transition: 'all 100ms',
                }}
              >
                <a.icon size={13} />
                {t(a.labelKey)}
              </button>
            )
          })}
        </div>

        {/* Depth */}
        <select
          value={depth}
          onChange={e => setDepth(Number(e.target.value))}
          style={{ width: 'auto', padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', cursor: 'pointer' }}
        >
          {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
            <option key={n} value={n}>{t('pages.whatIf.depth')}: {n}</option>
          ))}
        </select>

        {/* Analyze button */}
        <button
          onClick={handleAnalyze}
          disabled={!selectedCI || loading}
          style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 20px', borderRadius: 6, border: 'none',
            background: selectedCI ? '#38bdf8' : '#e5e7eb',
            color: selectedCI ? '#fff' : '#94a3b8',
            fontSize: 'var(--font-size-card-title)', fontWeight: 600, cursor: selectedCI ? 'pointer' : 'not-allowed',
            transition: 'background 150ms',
          }}
          onMouseEnter={e => { if (selectedCI) (e.currentTarget as HTMLElement).style.background = '#0ea5e9' }}
          onMouseLeave={e => { if (selectedCI) (e.currentTarget as HTMLElement).style.background = '#38bdf8' }}
        >
          <FlaskConical size={14} />
          {loading ? t('common.loading') : t('pages.whatIf.analyze')}
        </button>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Skeleton style={{ height: 100, borderRadius: 10 }} />
          <Skeleton style={{ height: 300, borderRadius: 10 }} />
        </div>
      )}

      {/* Empty state — no analysis run yet */}
      {!loading && !result && (
        <EmptyState
          icon={<FlaskConical size={40} color="var(--color-slate-light)" />}
          title={t('pages.whatIf.subtitle')}
        />
      )}

      {/* Results */}
      {!loading && result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'fadeIn 300ms ease' }}>

          {/* Summary card */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: 20, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
            {/* Risk score circle */}
            <div style={{
              width: 80, height: 80, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `4px solid ${scoreColor(result.riskScore)}`,
              background: `${scoreColor(result.riskScore)}10`,
            }}>
              <span style={{ fontSize: 28, fontWeight: 800, color: scoreColor(result.riskScore) }}>
                {result.riskScore}
              </span>
            </div>

            {/* Summary text */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 4 }}>
                {t('pages.whatIf.riskScore')}
              </div>
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: 0, lineHeight: 1.5 }}>
                {result.summary}
              </p>
            </div>

            {/* Mini counters */}
            <div style={{ display: 'flex', gap: 16, flexShrink: 0 }}>
              {[
                { n: result.totalImpacted, label: t('pages.whatIf.impactedCIs') },
                { n: result.impactedServices.length, label: t('pages.whatIf.services') },
                { n: result.impactedTeams.length, label: t('pages.whatIf.teams') },
                { n: result.openIncidents, label: t('pages.whatIf.incidents') },
              ].map((s, i) => (
                <div key={i} style={{ textAlign: 'center', minWidth: 60 }}>
                  <div style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 800, color: 'var(--color-slate-dark)' }}>{s.n}</div>
                  <div style={{ fontSize: 'var(--font-size-label)', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb' }}>
            {(['cis', 'services', 'teams'] as const).map(tab => {
              const sel = resultTab === tab
              const count = tab === 'cis' ? result.totalImpacted : tab === 'services' ? result.impactedServices.length : result.impactedTeams.length
              const label = tab === 'cis' ? t('pages.whatIf.tabCIs') : tab === 'services' ? t('pages.whatIf.tabServices') : t('pages.whatIf.tabTeams')
              return (
                <button key={tab} onClick={() => setResultTab(tab)} style={{
                  padding: '10px 14px', border: 'none', borderBottom: sel ? '2px solid var(--color-brand)' : '2px solid transparent',
                  marginBottom: -1, background: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer',
                  color: sel ? 'var(--color-brand)' : 'var(--color-slate)', fontWeight: sel ? 600 : 400,
                }}>
                  {label} ({count})
                </button>
              )
            })}
          </div>

          {/* Tab: CI Impattati */}
          {resultTab === 'cis' && (() => {
            const total = filteredCIs.length
            const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
            const paged = filteredCIs.slice(cisPage * PAGE_SIZE, (cisPage + 1) * PAGE_SIZE)
            return (
              <>
                <FilterBuilder fields={filterFields} onApply={g => { setFilterGroup(g); setCisPage(0) }} />
                <SortableFilterTable<WhatIfCI>
                  columns={columns}
                  data={paged}
                  loading={false}
                  onSort={(f, d) => { setSortField(f); setSortDir(d); setCisPage(0) }}
                  sortField={sortField}
                  sortDir={sortDir}
                  emptyComponent={<EmptyState icon={<ShieldCheck size={32} color="#16a34a" />} title={t('pages.whatIf.noImpacted')} />}
                  onRowClick={row => navigate(`/ci/${labelToRoute(row.type)}/${row.id}`)}
                  expandedRowId={expandedGraphId}
                  renderExpandedRow={row => {
                    if (!Array.isArray(row.impactPath) || row.impactPath.length < 2) return null
                    return (
                      <div style={{ padding: '8px 12px' }}>
                        <MiniPathGraph pathNames={row.impactPath} targetName={result.targetCI.name} impactedName={row.name} nameTypeMap={nameTypeMap} typeIconMap={typeIconMap} />
                      </div>
                    )
                  }}
                />
                {total > PAGE_SIZE && <Pager page={cisPage} totalPages={totalPages} total={total} onPage={setCisPage} t={t} />}
              </>
            )
          })()}

          {/* Tab: Servizi */}
          {resultTab === 'services' && (() => {
            const all = result.impactedServices
            const total = all.length
            const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
            const paged = all.slice(svcPage * PAGE_SIZE, (svcPage + 1) * PAGE_SIZE)
            return total === 0
              ? <EmptyState icon={<ShieldCheck size={32} color="#16a34a" />} title={t('pages.whatIf.noServices')} />
              : <>
                  <SortableFilterTable<WhatIfCI>
                    columns={[
                      { key: 'name', label: t('pages.whatIf.colName'), sortable: true },
                      { key: 'environment', label: t('pages.whatIf.colEnv'), sortable: true, width: '110px', render: (v) => v ? badge('#f0fdf4', '#166534', String(v)) : <span style={{ color: '#cbd5e1' }}>—</span> },
                      { key: 'impactLevel', label: t('pages.whatIf.colImpact'), sortable: true, width: '100px', render: (v) => { const ic = IMPACT_STYLES[String(v)] ?? IMPACT_STYLES['low']; return badge(ic.bg, ic.fg, impactLabel(String(v))) } },
                      { key: 'impactPath', label: t('pages.whatIf.colPath'), sortable: true, render: (v) => <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{(v as unknown as string[])?.join(' → ') || '—'}</span> },
                    ]}
                    data={paged}
                    loading={false}
                    emptyComponent={<EmptyState icon={<ShieldCheck size={32} color="#16a34a" />} title={t('pages.whatIf.noServices')} />}
                    onRowClick={row => navigate(`/ci/${labelToRoute(row.type)}/${row.id}`)}
                  />
                  {total > PAGE_SIZE && <Pager page={svcPage} totalPages={totalPages} total={total} onPage={setSvcPage} t={t} />}
                </>
          })()}

          {/* Tab: Team */}
          {resultTab === 'teams' && (() => {
            const all = result.impactedTeams
            const total = all.length
            const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
            const paged = all.slice(teamPage * PAGE_SIZE, (teamPage + 1) * PAGE_SIZE)
            return total === 0
              ? <EmptyState icon={<Users size={32} color="var(--color-slate-light)" />} title={t('pages.whatIf.noTeams')} />
              : <>
                  <SortableFilterTable<WhatIfTeam>
                    columns={[
                      { key: 'name', label: t('pages.whatIf.colTeamName'), sortable: true },
                      { key: 'impactedCICount', label: t('pages.whatIf.colTeamCIs'), sortable: true, width: '120px', render: (v) => <span style={{ fontWeight: 700, color: 'var(--color-brand)' }}>{String(v)}</span> },
                    ]}
                    data={paged}
                    loading={false}
                    emptyComponent={<EmptyState icon={<Users size={32} color="var(--color-slate-light)" />} title={t('pages.whatIf.noTeams')} />}
                  />
                  {total > PAGE_SIZE && <Pager page={teamPage} totalPages={totalPages} total={total} onPage={setTeamPage} t={t} />}
                </>
          })()}
        </div>
      )}

      {/* Fade-in animation */}
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </PageContainer>
  )
}

// ── Pagination ───────────────────────────────────────────────────────────────

function Pager({ page, totalPages, total, onPage, t }: {
  page: number; totalPages: number; total: number
  onPage: (p: number) => void; t: (k: string) => string
}) {
  const PAGE_SIZE = 20
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
      <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => onPage(Math.max(0, page - 1))}
          disabled={page === 0}
          style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', border: '1px solid #e5e7eb', borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : 'var(--color-slate)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
        >{t('common.prev')}</button>
        <span style={{ padding: '4px 8px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{page + 1} / {totalPages}</span>
        <button
          onClick={() => onPage(Math.min(totalPages - 1, page + 1))}
          disabled={page >= totalPages - 1}
          style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', border: '1px solid #e5e7eb', borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : 'var(--color-slate)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
        >{t('common.next')}</button>
      </div>
    </div>
  )
}

// ── Mini Path Graph (D3 force-simulation) ────────────────────────────────────

const MINI_R = 16
const MINI_NODE_COLOR = '#64748b'
const MINI_EDGE_COLOR = '#0284c7'


// Lucide icon SVG path data (subset from TopologyGraph)
type IconPath = [string, Record<string, string>]
const MINI_ICONS: Record<string, IconPath[]> = {
  box: [
    ['path', { d: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z' }],
    ['path', { d: 'm3.3 7 8.7 5 8.7-5' }],
    ['path', { d: 'M12 22V12' }],
  ],
  database: [
    ['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }],
    ['path', { d: 'M3 5V19A9 3 0 0 0 21 19V5' }],
    ['path', { d: 'M3 12A9 3 0 0 0 21 12' }],
  ],
  server: [
    ['rect', { width: '20', height: '8', x: '2', y: '2', rx: '2', ry: '2' }],
    ['rect', { width: '20', height: '8', x: '2', y: '14', rx: '2', ry: '2' }],
    ['line', { x1: '6', x2: '6.01', y1: '6', y2: '6' }],
    ['line', { x1: '6', x2: '6.01', y1: '18', y2: '18' }],
  ],
  shield: [
    ['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }],
  ],
  'hard-drive': [
    ['path', { d: 'M10 16h.01' }],
    ['path', { d: 'M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }],
    ['path', { d: 'M21.946 12.013H2.054' }],
    ['path', { d: 'M6 16h.01' }],
  ],
}

function appendMiniIcon(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sel: d3.Selection<any, any, any, any>,
  iconKey: string,
  color: string,
  size = 16,
) {
  const paths = MINI_ICONS[iconKey] ?? MINI_ICONS['box']!
  const scale = size / 24
  const offset = -(size / 2)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = (sel as any).append('g')
    .attr('transform', `translate(${offset},${offset}) scale(${scale})`)
    .attr('pointer-events', 'none')
  for (const [tag, attrs] of paths) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = (g as any).append(tag)
    for (const [k, v] of Object.entries(attrs)) el.attr(k, v)
    el.attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2)
      .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round')
  }
}

function MiniPathGraph({ pathNames, targetName, impactedName, nameTypeMap, typeIconMap }: {
  pathNames: string[]; targetName: string; impactedName: string
  nameTypeMap: Map<string, string>; typeIconMap: Map<string, string>
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const HEIGHT = 120

  const draw = useCallback(() => {
    const svg = svgRef.current
    if (!svg || pathNames.length < 2) return
    const width = svg.parentElement?.clientWidth ?? 600

    const sel = d3.select(svg)
    sel.selectAll('*').remove()
    sel.attr('width', width).attr('height', HEIGHT)

    const unique: string[] = []
    for (const n of pathNames) { if (!unique.includes(n)) unique.push(n) }

    const gap = width / (unique.length + 1)
    const cy = HEIGHT / 2 - 6

    type N = { id: string; name: string; x: number; y: number }
    const nodes: N[] = unique.map((name, i) => ({ id: name, name, x: gap * (i + 1), y: cy }))

    // Arrow marker — refX=10 aligns tip with end of line
    sel.append('defs').append('marker')
      .attr('id', 'arrow-mini-path').attr('viewBox', '0 -5 10 10')
      .attr('refX', 10).attr('refY', 0)
      .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', MINI_EDGE_COLOR).attr('opacity', 0.7)

    // Edges — line ends at circle border (x ± MINI_R)
    sel.append('g').selectAll('line')
      .data(nodes.slice(1))
      .join('line')
      .attr('x1', (_, i) => nodes[i]!.x + MINI_R + 2).attr('y1', cy)
      .attr('x2', d => d.x - MINI_R - 2).attr('y2', cy)
      .attr('stroke', MINI_EDGE_COLOR).attr('stroke-width', 1.5).attr('stroke-opacity', 0.5)
      .attr('marker-end', 'url(#arrow-mini-path)')

    // Nodes
    const nodeSel = sel.append('g').selectAll('g').data(nodes).join('g')
      .attr('transform', d => `translate(${d.x},${d.y})`)

    // Circle
    nodeSel.append('circle')
      .attr('r', MINI_R)
      .attr('fill', d => d.name === targetName ? MINI_EDGE_COLOR : d.name === impactedName ? '#f97316' : '#ffffff')
      .attr('stroke', d => d.name === targetName ? MINI_EDGE_COLOR : d.name === impactedName ? '#f97316' : MINI_NODE_COLOR)
      .attr('stroke-width', 2)

    // Icon inside circle — resolved from metamodel
    nodeSel.each(function (d) {
      const g = d3.select(this) as d3.Selection<SVGGElement, N, null, undefined>
      const iconColor = (d.name === targetName || d.name === impactedName) ? '#ffffff' : MINI_NODE_COLOR
      const ciType = nameTypeMap.get(d.name) ?? ''
      const iconKey = typeIconMap.get(ciType.toLowerCase().replace(/[_\s]/g, '')) ?? 'box'
      appendMiniIcon(g, iconKey, iconColor, 16)
    })

    // Name below circle
    nodeSel.append('text')
      .text(d => d.name.length > 16 ? d.name.slice(0, 15) + '…' : d.name)
      .attr('text-anchor', 'middle').attr('dy', MINI_R + 14)
      .attr('font-size', 10).attr('fill', '#0f172a').attr('font-weight', 500)
      .attr('font-family', "'Plus Jakarta Sans', system-ui, sans-serif")

  }, [pathNames, targetName, impactedName, nameTypeMap, typeIconMap])

  useEffect(() => { draw() }, [draw])

  return (
    <div style={{ background: '#ffffff', borderRadius: 6, overflow: 'hidden', width: '100%' }}>
      <svg ref={svgRef} style={{ display: 'block', width: '100%', height: HEIGHT }} />
    </div>
  )
}
