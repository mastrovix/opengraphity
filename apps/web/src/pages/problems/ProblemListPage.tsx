import { useState } from 'react'
import { useCustomFieldColumns, withCustomFieldCells } from '@/components/ticket/customFields/customFieldColumns'
import { useQuery, useLazyQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { Search, Sparkles, Plus } from 'lucide-react'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Button } from '@/components/Button'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { TicketStatusBadge } from '@/components/StatusBadge'
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
import { colors, palette } from '@/lib/tokens'
import { formatDate } from '@/lib/datetime'
import { useAIFeature } from '@/hooks/useAIFeature'
import { useAIDisabledText } from '@/components/ai/AIDisabledNotice'
import { showError } from '@/lib/showError'

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
  customFields?: { name: string; value: string | null }[]
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
  // Il raggruppamento usa embedding e modello (ondata 6): servono le due funzioni accese.
  const postIncidentOn = useAIFeature('postIncident')
  const embeddingsOn = useAIFeature('embeddings')
  const candidatesOffText = useAIDisabledText(postIncidentOn === false ? 'postIncident' : 'embeddings')
  const navigate = useNavigate()

  // Campi del cliente (verifica «Cosa resta cablato», ondata 4): una colonna per campo.
  const customColumns = useCustomFieldColumns<Problem>('problem')
  const baseColumns: ColumnDef<Problem>[] = [
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
      render:  (v) => <TicketStatusBadge value={String(v)} entityType="problem" />,
    },
    {
      key:      'createdAt',
      label:    t('pages.problems.createdAt'),
      width:    '120px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate-light)" }}>
          {formatDate(String(v))}
        </span>
      ),
    },
  ]
  const columns = [...baseColumns, ...customColumns]


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
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.problems.count', { count: total })}
          </p>
        }
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="secondary"
              disabled={candidatesLoading || postIncidentOn !== true || embeddingsOn !== true}
              title={postIncidentOn === false || embeddingsOn === false ? candidatesOffText : undefined}
              icon={<Sparkles size={13} />}
              onClick={() => {
                void runCandidates().then((res) => {
                  if (res.error) showError(res.error, t('toast.problem.analysisFailed', { error: res.error.message }))
                  else if (res.data) setCandidates(res.data.problemCandidates)
                  else toast.error(t('toast.problem.analysisNoResponse'))
                })
              }}
            >
              {candidatesLoading ? t('components.triage.analyzing') : t('pages.problems.candidatesButton')}
            </Button>
            <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => navigate('/problems/new')}>
              {t('pages.problems.new')}
            </Button>
          </div>
        }
      />

      {candidates !== null && (
        <div style={{ background: palette.info.light, border: `1px solid ${palette.info.border}`, borderRadius: 10, padding: '14px 18px', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)', marginBottom: 8 }}>
            <Sparkles size={14} color="var(--color-brand)" /> {t('pages.problems.candidatesTitle')}
          </div>
          {candidates.length === 0 ? (
            <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
              {t('pages.problems.candidatesEmpty')}
            </p>
          ) : candidates.map((c, i) => (
            <div key={i} style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginBottom: 4 }}>{c.title}</div>
              <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', lineHeight: 1.45 }}>{c.motivation}</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {c.incidents.map((inc) => (
                  <Link key={inc.id} to={`/incidents/${inc.id}`} style={{ fontSize: 'var(--font-size-label)', padding: '2px 8px', borderRadius: 6, background: colors.slateBg, color: 'var(--color-slate-dark)', textDecoration: 'none', border: `1px solid ${colors.border}` }}>
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
            exportToCsv('problems', columns, withCustomFieldCells(res.data?.problems?.items ?? []))
          }}
        />
      </div>

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          <SortableFilterTable<Problem>
            columns={columns}
            data={withCustomFieldCells(items)}
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
