import { useState, useMemo } from 'react'
import { useLazyQuery, useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FlaskConical, Zap, Trash2, Users, ShieldCheck, GitBranch } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { MiniPathGraph } from '@/components/MiniPathGraph'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Skeleton } from '@/components/ui/skeleton'
import { Pill } from '@/components/ui/Pill'
import { Pagination } from '@/components/ui/Pagination'
import { Input } from '@/components/ui/FormControls'
import { RiskBadge, riskLevel, SEVERITY_STYLE } from '@/components/ui/badges'
import { GET_ALL_CIS, GET_CI_TYPES, WHAT_IF_ANALYSIS } from '@/graphql/queries'
import { lookupOrError, lookupStyle } from '@/lib/tokens'
import { buildTypeIconMap } from '@/lib/ciIconPaths'

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
  { key: 'impact', icon: Zap,    labelKey: 'pages.whatIf.impact',  bg: '#e0f2fe', fg: 'var(--color-trigger-manual)' },
  { key: 'remove', icon: Trash2, labelKey: 'pages.whatIf.remove',  bg: '#e0f2fe', fg: 'var(--color-trigger-manual)' },
]

// Livello di impatto (critical/high/medium/low): stessa palette della severità
// (ui/badges.tsx) — prima WhatIf aveva un quarto set di colori proprio.
function impactBadge(level: string, label: string) {
  const s = lookupStyle(SEVERITY_STYLE, level, 'SEVERITY_STYLE')
  return badge(s.bg, s.color, label)
}

// Colore del cerchio del risk score: stesso livello di RiskBadge (soglie di
// riskLevel(), le stesse del backend) — prima WhatIf usava 4 soglie proprie.
const RISK_LEVEL_COLOR: Record<ReturnType<typeof riskLevel>, string> = {
  low:    'var(--color-success)',
  medium: 'var(--color-warning)',
  high:   'var(--color-danger)',
}

function badge(bg: string, fg: string, text: string) {
  return <Pill bg={bg} color={fg} radius={10}>{text}</Pill>
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
  const typeIconMap = useMemo(() => buildTypeIconMap(ciTypesData?.ciTypes ?? []), [ciTypesData])

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
    { key: 'environment', label: t('pages.whatIf.colEnv'), sortable: true, width: '110px', render: (v) => v ? badge('var(--color-success-bg)', '#166534', String(v)) : <span style={{ color: '#cbd5e1' }}>—</span> },
    { key: 'impactLevel', label: t('pages.whatIf.colImpact'), sortable: true, width: '100px', render: (v) => impactBadge(String(v), impactLabel(String(v))) },
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
        <GitBranch size={15} color={expandedGraphId === row.id ? 'var(--color-brand)' : 'var(--color-slate-light)'} />
      </button>
    )},
  ]

  const scoreColor = (s: number) => lookupOrError(RISK_LEVEL_COLOR, riskLevel(s), 'RISK_LEVEL_COLOR', 'var(--color-danger)')

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<FlaskConical size={22} color="var(--color-icon-accent)" />}>
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
          <Input
            style={{ padding: '8px 12px', border: '1px solid #e5e7eb' }}
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
                  className="hover-bg"
                  style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 'var(--font-size-body)', display: 'flex', justifyContent: 'space-between', ['--hover-bg' as string]: '#f0f9ff' }}
                >
                  <span style={{ fontWeight: 500 }}>{ci.name}</span>
                  <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{ci.type}</span>
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
                  background: sel ? a.bg : '#fff', color: sel ? a.fg : 'var(--color-slate)',
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
            background: selectedCI ? 'var(--color-brand)' : '#e5e7eb',
            color: selectedCI ? '#fff' : 'var(--color-slate-light)',
            fontSize: 'var(--font-size-card-title)', fontWeight: 600, cursor: selectedCI ? 'pointer' : 'not-allowed',
            transition: 'background 150ms',
          }}
          onMouseEnter={e => { if (selectedCI) (e.currentTarget as HTMLElement).style.background = 'var(--color-brand)' }}
          onMouseLeave={e => { if (selectedCI) (e.currentTarget as HTMLElement).style.background = 'var(--color-brand)' }}
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 4 }}>
                {t('pages.whatIf.riskScore')}
                <RiskBadge score={result.riskScore} />
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
                  <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
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
                <Pagination currentPage={cisPage + 1} totalPages={totalPages} onPrev={() => setCisPage(p => Math.max(0, p - 1))} onNext={() => setCisPage(p => Math.min(totalPages - 1, p + 1))} />
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
                      { key: 'environment', label: t('pages.whatIf.colEnv'), sortable: true, width: '110px', render: (v) => v ? badge('var(--color-success-bg)', '#166534', String(v)) : <span style={{ color: '#cbd5e1' }}>—</span> },
                      { key: 'impactLevel', label: t('pages.whatIf.colImpact'), sortable: true, width: '100px', render: (v) => impactBadge(String(v), impactLabel(String(v))) },
                      { key: 'impactPath', label: t('pages.whatIf.colPath'), sortable: true, render: (v) => <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{(v as unknown as string[])?.join(' → ') || '—'}</span> },
                    ]}
                    data={paged}
                    loading={false}
                    emptyComponent={<EmptyState icon={<ShieldCheck size={32} color="#16a34a" />} title={t('pages.whatIf.noServices')} />}
                    onRowClick={row => navigate(`/ci/${labelToRoute(row.type)}/${row.id}`)}
                  />
                  <Pagination currentPage={svcPage + 1} totalPages={totalPages} onPrev={() => setSvcPage(p => Math.max(0, p - 1))} onNext={() => setSvcPage(p => Math.min(totalPages - 1, p + 1))} />
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
                  <Pagination currentPage={teamPage + 1} totalPages={totalPages} onPrev={() => setTeamPage(p => Math.max(0, p - 1))} onNext={() => setTeamPage(p => Math.min(totalPages - 1, p + 1))} />
                </>
          })()}
        </div>
      )}

      {/* Fade-in animation */}
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </PageContainer>
  )
}

// Paginazione: ui/Pagination (prima un Pager locale). Grafo del percorso: components/MiniPathGraph.
