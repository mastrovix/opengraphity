import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { gql } from '@apollo/client'
import { useTranslation } from 'react-i18next'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { ScrollText } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'

const GET_LOGS = gql`
  query GetLogs($limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    logs(limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      entries {
        id timestamp level module message data
      }
    }
  }
`

const LEVEL_STYLES: Record<string, React.CSSProperties> = {
  trace:   { backgroundColor: '#f1f5f9', color: 'var(--color-slate-light)' },
  debug:   { backgroundColor: '#f1f5f9', color: 'var(--color-slate-light)' },
  info:    { backgroundColor: 'rgba(2,132,199,0.12)', color: '#2563eb' },
  warn:    { backgroundColor: '#fff7ed', color: '#d97706' },
  error:   { backgroundColor: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
  fatal:   { backgroundColor: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
}

const PAGE_SIZE = 50

interface LogEntry {
  id: string
  timestamp: string
  level: string
  module: string | null
  message: string
  data: string | null
}

function LevelBadge({ level }: { level: string }) {
  const style = LEVEL_STYLES[level] ?? LEVEL_STYLES['info']
  return (
    <span style={{
      ...style,
      padding:      '2px 8px',
      borderRadius: 4,
      fontSize:     11,
      fontWeight:   600,
      display:      'inline-block',
      minWidth:     46,
      textAlign:    'center',
    }}>
      {level.toUpperCase()}
    </span>
  )
}

const LOG_COLUMNS: ColumnDef<LogEntry>[] = [
  {
    key: 'timestamp',
    label: 'Timestamp',
    width: '160px',
    sortable: true,
    render: (_val, row) => (
      <span style={{ color: 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>
        {new Date(row.timestamp).toLocaleString('it-IT', { hour12: false })}
      </span>
    ),
  },
  {
    key: 'level',
    label: 'Level',
    width: '90px',
    sortable: true,
    render: (_val, row) => <LevelBadge level={row.level} />,
  },
  {
    key: 'module',
    label: 'Module',
    width: '120px',
    sortable: true,
    render: (_val, row) => <span style={{ color: 'var(--color-slate-light)' }}>{row.module ?? '—'}</span>,
  },
  {
    key: 'message',
    label: 'Message',
    sortable: true,
    render: (_val, row) => <span style={{ color: 'var(--color-slate-dark)' }}>{row.message}</span>,
  },
]


export function LogsPage() {
  const { t } = useTranslation()

  const LOGS_FILTER_FIELDS: FieldConfig[] = [
    { key: 'message',   label: t('pages.logs.filterMessage'), type: 'text' },
    { key: 'level',     label: t('pages.logs.filterLevel'),   type: 'enum', options: [
      { value: 'trace', label: 'Trace' },
      { value: 'debug', label: 'Debug' },
      { value: 'info',  label: 'Info'  },
      { value: 'warn',  label: 'Warn'  },
      { value: 'error', label: 'Error' },
      { value: 'fatal', label: 'Fatal' },
    ]},
    { key: 'module',    label: t('pages.logs.filterModule'),  type: 'enum', options: [
      { value: 'http',         label: 'HTTP' },
      { value: 'graphql',      label: 'GraphQL' },
      { value: 'auth',         label: 'Auth' },
      { value: 'workflow',     label: 'Workflow' },
      { value: 'notification', label: 'Notification' },
      { value: 'frontend',     label: 'Frontend' },
    ]},
    { key: 'timestamp', label: t('pages.logs.filterDate'),    type: 'date' },
  ]
  const [offset,      setOffset]      = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const [expandedId,  setExpandedId]  = useState<string | null>(null)
  const [sortField,   setSortField]   = useState<string | null>(null)
  const [sortDir,     setSortDir]     = useState<'asc' | 'desc'>('desc')

  const { data, loading, refetch } = useQuery<{ logs: { entries: LogEntry[]; total: number } }>(GET_LOGS, {
    variables: {
      limit:   PAGE_SIZE,
      offset,
      filters:       filterGroup ? JSON.stringify(filterGroup) : null,
      sortField:     sortField ?? 'timestamp',
      sortDirection: sortDir,
    },
    fetchPolicy: 'network-only',
  })

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => { void refetch() }, 10_000)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [autoRefresh, refetch])

  const entries: LogEntry[] = data?.logs.entries ?? []
  const total:   number     = data?.logs.total   ?? 0
  const totalPages  = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<ScrollText size={22} color="#38bdf8" />}>
          {t('pages.logs.title')}
        </PageTitle>
        <p style={{ color: '#0f172a', fontSize: 'var(--font-size-body)', margin: '4px 0 0' }}>
          {loading ? '—' : total > 0 ? t('pages.logs.count', { count: total }) : t('common.noResults')}
        </p>
      </div>

      {/* Advanced Filters + controls */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <FilterBuilder
            fields={LOGS_FILTER_FIELDS}
            onApply={(group) => { setFilterGroup(group); setOffset(0) }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 2 }}>
          <button
            onClick={() => void refetch()}
            style={{
              height: 32, padding: '0 14px', borderRadius: 6,
              border: '1px solid #e5e7eb', background: '#fff',
              fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer',
            }}
          >
            {t('pages.logs.refresh')}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            {t('pages.logs.autoRefresh')}
          </label>
        </div>
      </div>

      {/* Table */}
      <SortableFilterTable<LogEntry>
        columns={LOG_COLUMNS}
        data={entries}
        loading={loading}
        sortField={sortField}
        sortDir={sortDir}
        onSort={(field, dir) => { setSortField(field); setSortDir(dir); setOffset(0) }}
        expandedRowId={expandedId}
        onRowClick={(entry) => {
          if (entry.data && entry.data !== '{}') {
            setExpandedId(prev => prev === entry.id ? null : entry.id)
          }
        }}
        renderExpandedRow={(entry) => (
          <pre style={{
            margin:          0,
            padding:         12,
            backgroundColor: '#f1f5f9',
            color:           'var(--color-slate-dark)',
            borderRadius:    6,
            fontSize:        11,
            overflowX:       'auto',
            whiteSpace:      'pre-wrap',
            wordBreak:       'break-all',
            border:          '1px solid #e2e8f0',
          }}>
            {JSON.stringify(JSON.parse(entry.data!), null, 2)}
          </pre>
        )}
      />

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
          <span style={{ marginRight: 8 }}>
            {currentPage} {t('common.of')} {totalPages}
          </span>
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            style={{
              padding: '4px 10px', borderRadius: 4,
              border: '1px solid #e5e7eb', background: '#fff',
              cursor: offset === 0 ? 'not-allowed' : 'pointer',
              opacity: offset === 0 ? 0.4 : 1,
              fontSize: 'var(--font-size-body)', color: 'var(--color-slate)',
            }}
          >
            {t('common.prev')}
          </button>
          <button
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            style={{
              padding: '4px 10px', borderRadius: 4,
              border: '1px solid #e5e7eb', background: '#fff',
              cursor: offset + PAGE_SIZE >= total ? 'not-allowed' : 'pointer',
              opacity: offset + PAGE_SIZE >= total ? 0.4 : 1,
              fontSize: 'var(--font-size-body)', color: 'var(--color-slate)',
            }}
          >
            {t('common.next')}
          </button>
        </div>
      )}
    </PageContainer>
  )
}
