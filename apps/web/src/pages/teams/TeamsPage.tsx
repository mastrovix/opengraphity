import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { UsersRound } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { GET_TEAMS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'

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
    { key: 'type',      label: t('pages.teams.type'),      type: 'enum', enumValues: ['owner', 'support'] },
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
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)

  const { data, loading } = useQuery<{ teams: Team[] }>(GET_TEAMS, {
    variables: { filters: filterGroup ? JSON.stringify(filterGroup) : null },
    fetchPolicy: 'cache-and-network',
  })

  const teams      = data?.teams ?? []
  const total      = teams.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageItems  = teams.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <UsersRound size={22} color="var(--color-brand)" />
            {t('pages.teams.title')}
          </h1>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
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
        emptyComponent={
          <EmptyState
            icon={<UsersRound size={32} color="var(--color-slate-light)" />}
            title={t('pages.teams.noResults')}
            description={t('pages.teams.noResultsDesc')}
          />
        }
        onRowClick={(row) => navigate(`/teams/${row.id}`)}
      />

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 12, color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total} {t('pages.teams.count', { count: total })}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : 'var(--color-slate)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}
            >
              {t('common.prev')}
            </button>
            <span style={{ padding: '4px 8px', fontSize: 12, color: 'var(--color-slate)' }}>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : 'var(--color-slate)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
