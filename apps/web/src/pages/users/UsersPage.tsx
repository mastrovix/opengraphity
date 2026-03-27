import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { User } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { EmptyState } from '@/components/EmptyState'
import { GET_USERS } from '@/graphql/queries'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'

interface UserRow {
  id:        string
  name:      string
  email:     string
  role:      string
  createdAt: string | null
}

const ROLE_STYLES: Record<string, { bg: string; color: string }> = {
  admin:    { bg: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
  operator: { bg: '#eff6ff', color: '#2563eb' },
  viewer:   { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' },
}

function RoleBadge({ role }: { role: string }) {
  const s = ROLE_STYLES[role] ?? { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' }
  return (
    <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 4, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>
      {role}
    </span>
  )
}

const PAGE_SIZE = 50

export function UsersPage() {
  const { t } = useTranslation()

  const FILTER_FIELDS: FieldConfig[] = [
    { key: 'name',      label: t('pages.users.name'),      type: 'text' },
    { key: 'email',     label: t('pages.users.email'),     type: 'text' },
    { key: 'role',      label: t('pages.users.role'),      type: 'enum', enumValues: ['admin', 'operator', 'viewer'] },
    { key: 'createdAt', label: t('pages.users.createdAt'), type: 'date' },
  ]

  const COLUMNS: ColumnDef<UserRow>[] = [
    { key: 'name',  label: t('pages.users.name'),  sortable: true },
    { key: 'email', label: t('pages.users.email'), sortable: true },
    {
      key:    'role',
      label:  t('pages.users.role'),
      width:  '120px',
      sortable: true,
      render: (v) => <RoleBadge role={v as string} />,
    },
    {
      key:     'createdAt',
      label:   t('pages.users.createdAt'),
      width:   '120px',
      sortable: true,
      render:  (v) => v ? new Date(v as string).toLocaleDateString() : '—',
    },
  ]
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)

  const { data, loading } = useQuery<{ users: UserRow[] }>(GET_USERS, {
    fetchPolicy: 'cache-and-network',
  })

  const allUsers   = data?.users ?? []
  const filtered   = filterGroup ? allUsers : allUsers
  const total      = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageItems  = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <User size={22} color="var(--color-brand)" />
            {t('pages.users.title')}
          </h1>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.users.count', { count: total })}
          </p>
        </div>
        <button
          disabled
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'not-allowed' }}
        >
          {t('pages.users.newUser')}
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
            icon={<User size={32} color="var(--color-slate-light)" />}
            title={t('pages.users.noResults')}
            description={t('pages.users.noResultsDesc')}
          />
        }
        onRowClick={(row) => navigate(`/users/${row.id}`)}
      />

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 12, color: 'var(--color-slate-light)' }}>
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total} {t('pages.users.count', { count: total })}
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
