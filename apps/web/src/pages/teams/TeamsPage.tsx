import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { UsersRound } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { GET_TEAMS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Pagination } from '@/components/ui/Pagination'

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
    owner:   { bg: '#eff6ff', color: '#2563eb' },
    support: { bg: '#f0fdf4', color: '#16a34a' },
  }
  const s = styles[type] ?? { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' }
  return (
    <span style={{ fontWeight: 600, padding: '2px 8px', borderRadius: 4, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>
      {type}
    </span>
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

  const { data, loading } = useQuery<{ teams: Team[] }>(GET_TEAMS, {
    variables: { filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
  })

  function handleSort(field: string, direction: 'asc' | 'desc') { setSortField(field); setSortDir(direction); setPage(0) }

  const teams      = data?.teams ?? []
  const total      = teams.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageItems  = teams.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<UsersRound size={22} color="#38bdf8" />}>
            {t('pages.teams.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.teams.count', { count: total })}
          </p>
        </div>
        <button
          disabled
          style={{
            display:         'flex',
            alignItems:      'center',
            gap:             6,
            padding:         '8px 16px',
            backgroundColor: '#38bdf8',
            color:           '#fff',
            border:          'none',
            borderRadius:    6,
            fontSize:        14,
            fontWeight:      500,
            cursor:          'not-allowed',
          }}
        >
          {t('pages.teams.new')}
        </button>
      </div>

      <FilterBuilder
        fields={FILTER_FIELDS}
        onApply={(group) => { setFilterGroup(group); setPage(0) }}
      />

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
    </PageContainer>
  )
}
