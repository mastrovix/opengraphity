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
import { FilterBuilder, type FieldConfig } from '@/components/FilterBuilder'
import { Pagination } from '@/components/ui/Pagination'
import { colors, lookupStyle } from '@/lib/tokens'
import { Pill } from '@/components/ui/Pill'
import { QueryError } from '@/components/QueryError'
import { ExportCsvButton } from '@/components/ExportCsvButton'
import { exportToCsv } from '@/lib/csvExport'
import { useListQueryState } from '@/hooks/useListQueryState'

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
    owner:   { bg: 'var(--color-info-bg)', color: colors.brand },
    support: { bg: 'var(--color-success-bg)', color: 'var(--color-success)' },
  }
  const s = lookupStyle(styles, type, 'TEAM_TYPE_STYLES')
  return (
    <Pill bg={s.bg} color={s.color} radius={4} style={{ fontSize: 'inherit', textTransform: 'capitalize' }}>
      {type}
    </Pill>
  )
}

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
  // Sort / filters / page live in the URL: reload and shared links keep the view.
  const list = useListQueryState({ pageSize: 50, persistInQuery: true })

  const { data, loading, error, refetch } = useQuery<{ teams: Team[] }>(GET_TEAMS, {
    variables: list.variables,
    fetchPolicy: 'cache-and-network',
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: '', description: '' })
  const [createTeam, { loading: creating }] = useMutation(CREATE_TEAM, {
    onCompleted: async () => { setCreateOpen(false); setForm({ name: '', description: '' }); await refetch(); toast.success(t('toast.team.created')) },
    onError: (e) => toast.error(e.message),
  })
  const submitTeam = (e: React.FormEvent) => {
    e.preventDefault()
    void createTeam({ variables: { input: { name: form.name.trim(), description: form.description.trim() || null } } })
  }

  const teams = data?.teams ?? []
  const { pageItems, totalPages, total } = list.paginate(teams)

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
          <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => setCreateOpen(true)} style={{ fontSize: 14 }}>
            {t('pages.teams.new')}
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
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={creating || form.name.trim().length === 0}>{creating ? 'Creazione…' : t('common.create')}</Button>
          </>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <FieldLabel>{t('pages.teams.name')} *</FieldLabel>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo aperto dall'utente (Modal)
            autoFocus
            placeholder="Es. Network Operations"
          />
        </div>
        <div>
          <FieldLabel>{t('pages.teams.description')}</FieldLabel>
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
        </div>
      </Modal>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={FILTER_FIELDS}
            onApply={list.setFilterGroup}
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
            onSort={list.handleSort}
            sortField={list.sortField}
            sortDir={list.sortDir}
            emptyComponent={
              <EmptyState
                icon={<UsersRound size={32} color="var(--color-slate-light)" />}
                title={t('pages.teams.noResults')}
                description={t('pages.teams.noResultsDesc')}
              />
            }
            onRowClick={(row) => navigate(`/teams/${row.id}`)}
          />

          <Pagination currentPage={list.page + 1} totalPages={totalPages} onPrev={list.prevPage} onNext={list.nextPage} />
        </>
      )}
    </PageContainer>
  )
}
