import { useState } from 'react'
import { pausedWhenHidden } from '@/lib/polling'
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
import { toast } from 'sonner'
import { formatDate } from '@/lib/datetime'
import { useAIFeature } from '@/hooks/useAIFeature'
import { useAIDisabledText } from '@/components/ai/AIDisabledNotice'
import { showError } from '@/lib/showError'
import { ProblemCandidatesPanel, type ProblemCandidatesResult } from './ProblemCandidatesPanel'

/**
 * The candidates and what was examined to find them (D15): an empty list is
 * «no cluster» only when open incidents were actually analysed.
 */
const PROBLEM_CANDIDATES = gql`
  query ProblemCandidates {
    problemCandidates {
      candidates {
        title
        motivation
        incidents { id number title status severity }
      }
      examined
      notAnalysed
      analysisFailures
      capped
    }
  }
`

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
    // Intestazione TRADOTTA (revisione totale · i 29 warning): era la stringa
    // inglese «Number» scritta nel codice, in mezzo a colonne che passano da
    // i18n — e nessun guardiano poteva vederla, perché per quella colonna una
    // chiave non era mai stata scritta.
    { key: 'number',   label: t('common.number'),                               width: '120px', sortable: true },
    { key: 'title',    label: t('pages.problems.title_col'), sortable: true },
    {
      key:     'priority',
      label:   t('pages.problems.priority'),
      width:   '130px',
      sortable: true,
      // La priorità viene dal vocabolario `priority` (le uscite della matrice),
      // non da `severity`: col vocabolario sbagliato un cliente con `p1..p4`
      // vedeva la pill rossa «valore fuori vocabolario» su ogni riga, con un
      // `console.error` per riga (revisione totale · F-5).
      render:  (v) => <SeverityBadge value={String(v)} vocabulary="priority" />,
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
  const [candidates, setCandidates] = useState<ProblemCandidatesResult | null>(null)
  const [runCandidates, { loading: candidatesLoading }] = useLazyQuery<{ problemCandidates: ProblemCandidatesResult }>(PROBLEM_CANDIDATES, { fetchPolicy: 'network-only' })
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0)
  }

  const { data, loading, error, refetch } = useQuery<{ problems: { items: Problem[]; total: number } }>(GET_PROBLEMS, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
    // F-21: il polling si ferma quando la scheda è in background.
    ...pausedWhenHidden(30_000),
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

      {candidates !== null && <ProblemCandidatesPanel result={candidates} />}

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
