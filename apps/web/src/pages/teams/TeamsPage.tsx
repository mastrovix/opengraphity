import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { UsersRound, Plus } from 'lucide-react'
import { ListPageHeader } from '@/components/ListPageHeader'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Input, Textarea, FieldLabel } from '@/components/ui/FormControls'
import { CREATE_TEAM } from '@/graphql/mutations'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { GET_TEAMS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Pagination } from '@/components/ui/Pagination'
import { lookupStyle } from '@/lib/tokens'
import { Pill } from '@/components/ui/Pill'
import { QueryError } from '@/components/QueryError'
import { ExportCsvButton } from '@/components/ExportCsvButton'
import { exportToCsv } from '@/lib/csvExport'

interface Team {
  id:          string
  name:        string
  description: string | null
  type:        string | null
  createdAt:   string
}

function TypeBadge({ type }: { type: string | null }) {
  if (!type) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const styles: Record<string, { bg: string; color: string }> = {
    owner:   { bg: 'var(--color-info-bg)', color: '#2563eb' },
    support: { bg: 'var(--color-success-bg)', color: 'var(--color-success)' },
  }
  const s = lookupStyle(styles, type, 'TEAM_TYPE_STYLES')
  return (
    <Pill bg={s.bg} color={s.color} radius={4} style={{ fontSize: 'inherit', textTransform: 'capitalize' }}>
      {type}
    </Pill>
  )
}

const PAGE_SIZE = 50

export function TeamsPage() {
  const { t } = useTranslation()

  const FILTER_FIELDS: FieldConfig[] = [
    { key: 'name',      label: t('pages.teams.name'),      type: 'text' },
    { key: 'type',      label: t('pages.teams.type'),      type: 'enum', options: [
      { value: 'owner',   label: 'Owner'   },
      { value: 'support', label: 'Support' },
    ]},
    { key: 'createdAt', label: t('pages.teams.createdAt'), type: 'date' },
  ]

  const COLUMNS: ColumnDef<Team>[] = [
    { key: 'name',        label: t('pages.teams.name'),        sortable: true },
    { key: 'description', label: t('pages.teams.description'), sortable: false },
    {
      key:    'type',
      label:  t('pages.teams.type'),
      width:  '120px',
      sortable: true,
      render: (v) => <TypeBadge type={v as string | null} />,
    },
    {
      key:    'createdAt',
      label:  t('pages.teams.createdAt'),
      width:  '120px',
      sortable: true,
      render: (v) => v ? new Date(v as string).toLocaleDateString() : '—',
    },
  ]
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)

  const { data, loading, error, refetch } = useQuery<{ teams: Team[] }>(GET_TEAMS, {
    variables: { filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: '', description: '' })
  const [createTeam, { loading: creating }] = useMutation(CREATE_TEAM, {
    onCompleted: async () => { setCreateOpen(false); setForm({ name: '', description: '' }); await refetch(); toast.success('Team creato') },
    onError: (e) => toast.error(e.message),
  })
  const submitTeam = (e: React.FormEvent) => {
    e.preventDefault()
    void createTeam({ variables: { input: { name: form.name.trim(), description: form.description.trim() || null } } })
  }

  function handleSort(field: string, direction: 'asc' | 'desc') { setSortField(field); setSortDir(direction); setPage(0) }

  const teams      = data?.teams ?? []
  const total      = teams.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageItems  = teams.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <PageContainer>
      <ListPageHeader
        icon={<UsersRound size={22} color="var(--color-icon-accent)" />}
        title={t('pages.teams.title')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.teams.count', { count: total })}
          </p>
        }
        actions={
          <Button onClick={() => setCreateOpen(true)} style={{ fontSize: 14 }}>
            <Plus size={15} style={{ marginRight: 6 }} />{t('pages.teams.new')}
          </Button>
        }
      />

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('pages.teams.new')}
        as="form"
        onSubmit={submitTeam}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>Annulla</Button>
            <Button type="submit" disabled={creating || form.name.trim().length === 0}>{creating ? 'Creazione…' : 'Crea'}</Button>
          </>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <FieldLabel>Nome *</FieldLabel>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus placeholder="Es. Network Operations" />
        </div>
        <div>
          <FieldLabel>Descrizione</FieldLabel>
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
        </div>
      </Modal>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={FILTER_FIELDS}
            onApply={(group) => { setFilterGroup(group); setPage(0) }}
          />
        </div>
        <ExportCsvButton
          onExport={async () => { exportToCsv('teams', COLUMNS, teams) }}
        />
      </div>

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <>
          <SortableFilterTable
            columns={COLUMNS}
            data={pageItems}
            loading={loading}
            onSort={handleSort}
            sortField={sortField}
            sortDir={sortDir}
            emptyComponent={
              <EmptyState
                icon={<UsersRound size={32} color="var(--color-slate-light)" />}
                title={t('pages.teams.noResults')}
                description={t('pages.teams.noResultsDesc')}
              />
            }
            onRowClick={(row) => navigate(`/teams/${row.id}`)}
          />

          <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
        </>
      )}
    </PageContainer>
  )
}
