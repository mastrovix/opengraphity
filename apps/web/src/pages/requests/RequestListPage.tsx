import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Inbox } from 'lucide-react'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge } from '@/components/StatusBadge'
import { EmptyState } from '@/components/EmptyState'
import { GET_SERVICE_REQUESTS } from '@/graphql/queries'

interface ServiceRequest {
  id:        string
  title:     string
  priority:  string
  status:    string
  createdAt: string
}

export function RequestListPage() {
  const { t } = useTranslation()

  const columns: ColumnDef<ServiceRequest>[] = [
    { key: 'title',    label: t('pages.requests.title_col'), sortable: true },
    {
      key:     'priority',
      label:   t('pages.requests.priority'),
      width:   '130px',
      sortable: true,
      render:  (v) => <SeverityBadge value={String(v)} />,
    },
    {
      key:     'status',
      label:   t('pages.requests.status'),
      width:   '130px',
      sortable: true,
      render:  (v) => <StatusBadge value={String(v)} />,
    },
    {
      key:      'createdAt',
      label:    t('pages.requests.createdAt'),
      width:    '120px',
      sortable: true,
      render:   (v) => (
        <span style={{ color: "var(--color-slate-light)" }}>
          {new Date(String(v)).toLocaleDateString()}
        </span>
      ),
    },
  ]
  const navigate = useNavigate()
  const { data, loading } = useQuery<{ serviceRequests: ServiceRequest[] }>(GET_SERVICE_REQUESTS)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', margin: 0 }}>
            {t('pages.requests.title')}
          </h1>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.requests.count', { count: data?.serviceRequests?.length ?? 0 })}
          </p>
        </div>
        <button
          onClick={() => navigate('/requests/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
        >
          {t('pages.requests.new')}
        </button>
      </div>

      <SortableFilterTable<ServiceRequest>
        columns={columns}
        data={data?.serviceRequests ?? []}
        loading={loading}
        emptyComponent={<EmptyState icon={<Inbox size={32} />} title={t('pages.requests.noResults')} description={t('pages.requests.noResultsDesc')} />}
      />
    </div>
  )
}
