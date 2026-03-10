import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { StatusBadge } from '@/components/StatusBadge'
import { GET_CIS } from '@/graphql/queries'

interface CI {
  id:          string
  name:        string
  type:        string
  status:      string
  environment: string
  createdAt:   string
}

const ENV_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  production:  { bg: '#fef2f2', text: '#dc2626', dot: '#dc2626' },
  staging:     { bg: '#fffbeb', text: '#d97706', dot: '#d97706' },
  development: { bg: '#ecfdf5', text: '#059669', dot: '#059669' },
  dr:          { bg: '#f0f9ff', text: '#0284c7', dot: '#0284c7' },
}

function EnvBadge({ value }: { value: string }) {
  const c = ENV_COLORS[value] ?? { bg: '#f1f3f9', text: '#8892a4', dot: '#8892a4' }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 100, backgroundColor: c.bg, fontSize: 12, fontWeight: 500, color: c.text, textTransform: 'capitalize', whiteSpace: 'nowrap' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: c.dot, flexShrink: 0 }} />
      {value}
    </span>
  )
}

const TYPE_OPTIONS = [
  { value: 'server',           label: 'Server' },
  { value: 'virtual_machine',  label: 'Virtual Machine' },
  { value: 'database',         label: 'Database' },
  { value: 'database_instance',label: 'DB Instance' },
  { value: 'application',      label: 'Application' },
  { value: 'microservice',     label: 'Microservice' },
  { value: 'network_device',   label: 'Network Device' },
  { value: 'storage',          label: 'Storage' },
  { value: 'cloud_service',    label: 'Cloud Service' },
  { value: 'ssl_certificate',  label: 'SSL Certificate' },
  { value: 'api_endpoint',     label: 'API Endpoint' },
]

const columns: ColumnDef<CI>[] = [
  {
    key:        'name',
    label:      'Name',
    sortable:   true,
    filterable: true,
    filterType: 'text',
  },
  {
    key:           'type',
    label:         'Type',
    width:         '160px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: TYPE_OPTIONS,
    render: (v) => (
      <span style={{ fontSize: 13, color: '#4a5468', textTransform: 'capitalize' }}>
        {String(v).replace(/_/g, ' ')}
      </span>
    ),
  },
  {
    key:           'status',
    label:         'Status',
    width:         '130px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'active',         label: 'Active' },
      { value: 'inactive',       label: 'Inactive' },
      { value: 'maintenance',    label: 'Maintenance' },
      { value: 'decommissioned', label: 'Decommissioned' },
    ],
    render: (v) => <StatusBadge value={String(v)} />,
  },
  {
    key:           'environment',
    label:         'Environment',
    width:         '140px',
    sortable:      true,
    filterable:    true,
    filterType:    'select',
    filterOptions: [
      { value: 'production',  label: 'Production' },
      { value: 'staging',     label: 'Staging' },
      { value: 'development', label: 'Development' },
      { value: 'dr',          label: 'DR' },
    ],
    render: (v) => <EnvBadge value={String(v)} />,
  },
  {
    key:      'createdAt',
    label:    'Created',
    width:    '120px',
    sortable: true,
    render:   (v) => (
      <span style={{ color: '#8892a4', fontSize: 13 }}>
        {new Date(String(v)).toLocaleDateString()}
      </span>
    ),
  },
]

export function CMDBPage() {
  const navigate = useNavigate()
  const { data, loading } = useQuery<{ configurationItems: CI[] }>(GET_CIS)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.01em', margin: 0 }}>
            CMDB
          </h1>
          <p style={{ fontSize: 13, color: '#8892a4', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${data?.configurationItems?.length ?? 0} configuration items`}
          </p>
        </div>
        <button
          disabled
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#4f46e5', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'not-allowed', opacity: 0.6 }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          New CI
        </button>
      </div>

      <SortableFilterTable<CI>
        columns={columns}
        data={data?.configurationItems ?? []}
        loading={loading}
        emptyMessage="No configuration items found"
        onRowClick={(row) => navigate(`/cmdb/${row.id}`)}
      />
    </div>
  )
}
