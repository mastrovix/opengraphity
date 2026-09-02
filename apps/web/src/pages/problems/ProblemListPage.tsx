import { useState } from 'react'
import { useQuery, useLazyQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { Search, Sparkles } from 'lucide-react'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Button } from '@/components/Button'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { EmptyState } from '@/components/EmptyState'
import { GET_PROBLEMS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'
import { Pagination } from '@/components/ui/Pagination'
import { QueryError } from '@/components/QueryError'
import { ExportCsvButton } from '@/components/ExportCsvButton'
import { exportToCsv } from '@/lib/csvExport'
import { apolloClient } from '@/lib/apollo'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

const PROBLEM_CANDIDATES = gql`
  query ProblemCandidates {
    problemCandidates {
      title
      motivation
      incidents { id number title status severity }
    }
  }
`
interface Candidate {
  title: string
  motivation: string
  incidents: { id: string; number: string | null; title: string; status: string; severity: string }[]
}

interface Problem {
  id:        string
  number:    string
  title:     string
  priority:  string
  status:    string
  createdAt: string
}

const PAGE_SIZE = 50

export function ProblemListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const columns: ColumnDef<Problem>[] = [
    { key: 'number',   label: 'Number',                               width: '120px', sortable: true },
    { key: 'title',    label: t('pages.problems.title_col'), sortable: true },
    {
      key:     'priority',
      label:   t('pages.problems.priority'),
      width:   '130px',
      sortable: true,
      render:  (v) => <SeverityBadge value={String(v)} />,
    },
    {
      key:     'status',
      label:   t('pages.problems.status'),
      width:   '130px',
      sortable: true,
      render:  (v) => <StatusBadge value={String(v)} />,
    },
    {
      key:      'createdAt',
      label:    t('pages.problems.createdAt'),
      width:    '120px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate-light)" }}>
          {new Date(String(v)).toLocaleDateString()}
        </span>
      ),
    },
  ]

  const { fields: filterFields } = useEntityFields('Problem')
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [runCandidates, { loading: candidatesLoading }] = useLazyQuery<{ problemCandidates: Candidate[] }>(PROBLEM_CANDIDATES, { fetchPolicy: 'network-only' })
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0)
  }

  const { data, loading, error, refetch } = useQuery<{ problems: { items: Problem[]; total: number } }>(GET_PROBLEMS, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
    pollInterval: 30_000,   // keep the list fresh without manual reload
  })

  const items      = data?.problems?.items ?? []
  const total      = data?.problems?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <PageContainer>
      <ListPageHeader
        icon={<Search size={22} color="var(--color-icon-accent)" />}
        title={t('pages.problems.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.problems.count', { count: total })}
          </p>
        }
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="secondary"
              disabled={candidatesLoading}
              icon={<Sparkles size={13} />}
              onClick={() => {
                void runCandidates().then((res) => {
                  if (res.error) toast.error(`Analisi fallita: ${res.error.message}`)
                  else if (res.data) setCandidates(res.data.problemCandidates)
                  else toast.error('Analisi fallita: nessuna risposta')
                })
              }}
            >
              {candidatesLoading ? 'Analisi in corso…' : 'Candidati Problem'}
            </Button>
            <Button onClick={() => navigate('/problems/new')}>
              {t('pages.problems.new')}
            </Button>
          </div>
        }
      />

      {candidates !== null && (
        <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 10, padding: '14px 18px', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)', marginBottom: 8 }}>
            <Sparkles size={14} color="var(--color-brand)" /> Candidati Problem da incident ricorrenti
          </div>
          {candidates.length === 0 ? (
            <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
              Nessun cluster di incident simili ricorrenti trovato (minimo 3 incident non chiusi con lo stesso pattern).
            </p>
          ) : candidates.map((c, i) => (
            <div key={i} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginBottom: 4 }}>{c.title}</div>
              <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', lineHeight: 1.45 }}>{c.motivation}</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {c.incidents.map((inc) => (
                  <Link key={inc.id} to={`/incidents/${inc.id}`} style={{ fontSize: 'var(--font-size-label)', padding: '2px 8px', borderRadius: 6, background: '#f1f5f9', color: 'var(--color-slate-dark)', textDecoration: 'none', border: '1px solid #e5e7eb' }}>
                    {inc.number ?? inc.title.slice(0, 20)}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={filterFields}
            onApply={(group) => { setFilterGroup(group); setPage(0) }}
          />
        </div>
        <ExportCsvButton
          onExport={async () => {
            const res = await apolloClient.query<{ problems: { items: Problem[] } }>({
              query: GET_PROBLEMS,
              variables: { limit: 10000, offset: 0, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
              fetchPolicy: 'network-only',
            })
            exportToCsv('problems', columns, res.data?.problems?.items ?? [])
          }}
        />
      </div>

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          <SortableFilterTable<Problem>
            columns={columns}
            data={items}
            loading={loading}
            emptyComponent={<EmptyState icon={<Search size={32} />} title={t('pages.problems.noResults')} description={t('pages.problems.noResultsDesc')} />}
            onRowClick={(row) => navigate(`/problems/${row.id}`)}
            onSort={handleSort}
            sortField={sortField}
            sortDir={sortDir}
          />

          <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
        </>
      )}
    </PageContainer>
  )
}
