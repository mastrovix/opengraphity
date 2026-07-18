import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Users, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { BulkActionsBar } from '@/components/BulkActionsBar'
import { Select, Textarea, FieldLabel } from '@/components/ui/FormControls'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { EmptyState } from '@/components/EmptyState'
import { GET_INCIDENTS, GET_TEAMS } from '@/graphql/queries'
import { ASSIGN_INCIDENT_TO_TEAM, RESOLVE_INCIDENT } from '@/graphql/mutations'
import { FilterBuilder, type FilterGroup } from '@/components/FilterBuilder'
import { useEntityFields } from '@/hooks/useEntityFields'
import { Pagination } from '@/components/ui/Pagination'
import { QueryError } from '@/components/QueryError'
import { ExportCsvButton } from '@/components/ExportCsvButton'
import { SlaBadge, type SlaStatusInfo } from '@/components/SlaBadge'
import { exportToCsv } from '@/lib/csvExport'
import { apolloClient } from '@/lib/apollo'

interface Incident {
  id:        string
  number:    string
  title:     string
  severity:  string
  status:    string
  createdAt: string
  slaStatus: SlaStatusInfo | null
}

const PAGE_SIZE = 50

export function IncidentListPage() {
  const { t } = useTranslation()

  const columns: ColumnDef<Incident>[] = [
    { key: 'number',   label: 'Number',                                 width: '120px', sortable: true },
    { key: 'title',    label: t('pages.incidents.title_col'),    sortable: true },
    {
      key:     'severity',
      label:   t('pages.incidents.severity'),
      width:   '130px',
      sortable: true,
      render:  (v) => <SeverityBadge value={String(v)} />,
    },
    {
      key:     'status',
      label:   t('pages.incidents.status'),
      width:   '130px',
      sortable: true,
      render:  (v) => <StatusBadge value={String(v)} />,
    },
    {
      key:      'slaStatus',
      label:    t('sla.title'),
      width:    '140px',
      sortable: false,
      render:   (v) => <SlaBadge sla={v as SlaStatusInfo | null} compact />,
    },
    {
      key:      'createdAt',
      label:    t('pages.incidents.createdAt'),
      width:    '120px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate-light)" }}>
          {new Date(String(v)).toLocaleDateString()}
        </span>
      ),
    },
  ]

  const { fields: filterFields } = useEntityFields('Incident')
  const navigate = useNavigate()
  const location = useLocation()
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Bulk selection — reset whenever page, filters or sort change
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkModal, setBulkModal] = useState<'assignTeam' | 'resolve' | null>(null)
  const [bulkTeamId, setBulkTeamId] = useState('')
  const [bulkNotes, setBulkNotes] = useState('')
  const [bulkRunning, setBulkRunning] = useState(false)

  const clearSelection = () => setSelectedIds(new Set())

  const handleSort = (field: string, dir: 'asc' | 'desc') => {
    setSortField(field); setSortDir(dir); setPage(0); clearSelection()
  }

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleAll = (ids: string[]) => {
    setSelectedIds((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id))
      const next = new Set(prev)
      if (allSelected) ids.forEach((id) => next.delete(id))
      else ids.forEach((id) => next.add(id))
      return next
    })
  }

  const { data, loading, error, refetch } = useQuery<{
    incidents: { items: Incident[]; total: number }
  }>(GET_INCIDENTS, {
    variables: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
    pollInterval: 30_000,   // keep the list fresh without manual reload
  })

  const items = data?.incidents?.items ?? []
  const total = data?.incidents?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  const { data: teamsData } = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, {
    skip: bulkModal !== 'assignTeam',
    fetchPolicy: 'cache-first',
  })
  const teams = teamsData?.teams ?? []

  const [assignToTeam] = useMutation(ASSIGN_INCIDENT_TO_TEAM)
  const [resolveIncident] = useMutation(RESOLVE_INCIDENT)

  /** Runs `fn` for every selected id (batches of 5), then shows a summary toast. */
  const runBulk = async (fn: (id: string) => Promise<unknown>) => {
    const ids = [...selectedIds]
    setBulkRunning(true)
    let ok = 0
    let failed = 0
    try {
      const BATCH = 5
      for (let i = 0; i < ids.length; i += BATCH) {
        const results = await Promise.allSettled(ids.slice(i, i + BATCH).map((id) => fn(id)))
        for (const r of results) {
          if (r.status === 'fulfilled') ok++
          else failed++
        }
      }
    } finally {
      setBulkRunning(false)
    }
    const summary = failed > 0
      ? t('bulk.summaryWithFailed', { ok, failed })
      : t('bulk.summary', { ok })
    if (failed > 0) toast.warning(summary)
    else toast.success(summary)
    setBulkModal(null)
    setBulkTeamId('')
    setBulkNotes('')
    clearSelection()
    void refetch()
  }

  const handleBulkAssign = () => {
    if (!bulkTeamId) return
    void runBulk((id) => assignToTeam({ variables: { id, teamId: bulkTeamId } }))
  }

  const handleBulkResolve = () => {
    const rootCause = bulkNotes.trim() || null
    void runBulk((id) => resolveIncident({ variables: { id, rootCause } }))
  }

  useEffect(() => {
    if ((location.state as { refresh?: boolean } | null)?.refresh) {
      void refetch()
    }
  }, [location.state]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PageContainer>
      <ListPageHeader
        icon={<AlertCircle size={22} color="var(--color-icon-accent)" />}
        title={t('pages.incidents.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.incidents.count', { count: total })}
          </p>
        }
        actions={
          <Button onClick={() => navigate('/incidents/new')}>
            {t('pages.incidents.new')}
          </Button>
        }
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={filterFields}
            onApply={(group) => { setFilterGroup(group); setPage(0); clearSelection() }}
          />
        </div>
        <ExportCsvButton
          onExport={async () => {
            const res = await apolloClient.query<{ incidents: { items: Incident[] } }>({
              query: GET_INCIDENTS,
              variables: { limit: 10000, offset: 0, filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
              fetchPolicy: 'network-only',
            })
            exportToCsv('incidents', columns, res.data?.incidents?.items ?? [])
          }}
        />
      </div>

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          <BulkActionsBar count={selectedIds.size} onClear={clearSelection}>
            <Button
              variant="secondary"
              size="xs"
              disabled={bulkRunning}
              icon={<Users size={13} />}
              onClick={() => setBulkModal('assignTeam')}
            >
              {t('bulk.assignTeam')}
            </Button>
            <Button
              variant="secondary"
              size="xs"
              disabled={bulkRunning}
              icon={<CheckCircle2 size={13} />}
              onClick={() => setBulkModal('resolve')}
            >
              {t('bulk.resolve')}
            </Button>
          </BulkActionsBar>

          <SortableFilterTable<Incident>
            columns={columns}
            data={items}
            loading={loading}
            emptyComponent={<EmptyState icon={<AlertCircle size={32} />} title={t('pages.incidents.noResults')} description={t('pages.incidents.noResultsDesc')} />}
            onRowClick={(row) => navigate(`/incidents/${row.id}`)}
            onSort={handleSort}
            sortField={sortField}
            sortDir={sortDir}
            selectable
            selectedIds={selectedIds}
            onToggleRow={toggleRow}
            onToggleAll={toggleAll}
          />

          <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => { setPage(p => p - 1); clearSelection() }} onNext={() => { setPage(p => p + 1); clearSelection() }} />
        </>
      )}

      {/* Bulk: assign to team */}
      <Modal
        open={bulkModal === 'assignTeam'}
        onClose={() => { if (!bulkRunning) setBulkModal(null) }}
        title={t('bulk.assignTeamTitle', { count: selectedIds.size })}
        footer={
          <>
            <Button variant="secondary" size="xs" disabled={bulkRunning} onClick={() => setBulkModal(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="xs"
              disabled={bulkRunning || !bulkTeamId}
              icon={bulkRunning ? <Loader2 size={13} className="animate-spin" /> : undefined}
              onClick={handleBulkAssign}
            >
              {t('bulk.confirm')}
            </Button>
          </>
        }
      >
        <FieldLabel>{t('bulk.team')}</FieldLabel>
        <Select value={bulkTeamId} onChange={(e) => setBulkTeamId(e.target.value)} disabled={bulkRunning}>
          <option value="">{t('common.select')}</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>{team.name}</option>
          ))}
        </Select>
      </Modal>

      {/* Bulk: resolve */}
      <Modal
        open={bulkModal === 'resolve'}
        onClose={() => { if (!bulkRunning) setBulkModal(null) }}
        title={t('bulk.resolveTitle', { count: selectedIds.size })}
        footer={
          <>
            <Button variant="secondary" size="xs" disabled={bulkRunning} onClick={() => setBulkModal(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="xs"
              disabled={bulkRunning}
              icon={bulkRunning ? <Loader2 size={13} className="animate-spin" /> : undefined}
              onClick={handleBulkResolve}
            >
              {t('bulk.confirm')}
            </Button>
          </>
        }
      >
        <FieldLabel>{t('bulk.resolveNotes')}</FieldLabel>
        <Textarea
          rows={3}
          value={bulkNotes}
          onChange={(e) => setBulkNotes(e.target.value)}
          disabled={bulkRunning}
          placeholder={t('common.writeHere')}
        />
      </Modal>
    </PageContainer>
  )
}
