import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { gql } from '@apollo/client'
import { useTranslation } from 'react-i18next'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { EmptyState } from '@/components/EmptyState'
import { ScrollText } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'

const GET_LOGS = gql`
  query GetLogs($limit: Int, $offset: Int, $filters: String) {
    logs(limit: $limit, offset: $offset, filters: $filters) {
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

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const hasData = entry.data && entry.data !== '{}'

  return (
    <>
      <tr
        onClick={() => hasData && setExpanded((e) => !e)}
        style={{
          cursor:          hasData ? 'pointer' : 'default',
          borderBottom:    '1px solid #f1f3f9',
          backgroundColor: expanded ? '#f5f7ff' : '#fff',
          transition:      'background 100ms',
        }}
        onMouseEnter={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.backgroundColor = '#f5f7ff' }}
        onMouseLeave={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.backgroundColor = '#fff' }}
      >
        <td style={{ padding: '11px 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>
          {new Date(entry.timestamp).toLocaleString('it-IT', { hour12: false })}
        </td>
        <td style={{ padding: '11px 12px' }}>
          <LevelBadge level={entry.level} />
        </td>
        <td style={{ padding: '11px 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
          {entry.module ?? '—'}
        </td>
        <td style={{ padding: '11px 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
          {entry.message}
        </td>
      </tr>
      {expanded && hasData && (
        <tr style={{ backgroundColor: '#f8fafc' }}>
          <td colSpan={4} style={{ padding: '0 12px 12px 12px' }}>
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
          </td>
        </tr>
      )}
    </>
  )
}


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

  const { data, loading, refetch } = useQuery<{ logs: { entries: LogEntry[]; total: number } }>(GET_LOGS, {
    variables: {
      limit:   PAGE_SIZE,
      offset,
      filters: filterGroup ? JSON.stringify(filterGroup) : null,
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

  const thStyle: React.CSSProperties = {
    background:    '#f9fafb',
    borderBottom:  '2px solid #e5e7eb',
    padding:       '8px 12px 6px',
    textAlign:     'left',
    whiteSpace:    'nowrap',
    fontSize:      11,
    fontWeight:    500,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    color:         'var(--color-slate-light)',
  }

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<ScrollText size={22} color="var(--color-brand)" />}>
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
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: 160 }}>{t('pages.logs.timestamp')}</th>
              <th style={{ ...thStyle, width: 90  }}>{t('pages.logs.level')}</th>
              <th style={{ ...thStyle, width: 120 }}>{t('pages.logs.source')}</th>
              <th style={thStyle}>{t('pages.logs.message')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <EmptyState
                    icon={<ScrollText size={32} color="var(--color-slate-light)" />}
                    title={t('common.noResults')}
                  />
                </td>
              </tr>
            )}
            {entries.map((entry) => <LogRow key={entry.id} entry={entry} />)}
          </tbody>
        </table>
      </div>

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
