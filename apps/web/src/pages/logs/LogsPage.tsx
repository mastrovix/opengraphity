import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { gql } from '@apollo/client'
import { useTranslation } from 'react-i18next'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { ScrollText } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'

const GET_LOGS = gql`
  query GetLogs($level: String, $module: String, $search: String, $limit: Int, $offset: Int, $filters: String) {
    logs(level: $level, module: $module, search: $search, limit: $limit, offset: $offset, filters: $filters) {
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

const LEVELS  = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
const MODULES = ['http', 'graphql', 'auth', 'workflow', 'notification', 'frontend']
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
        <td style={{ padding: '11px 12px', fontSize: 12, color: 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>
          {new Date(entry.timestamp).toLocaleString('it-IT', { hour12: false })}
        </td>
        <td style={{ padding: '11px 12px' }}>
          <LevelBadge level={entry.level} />
        </td>
        <td style={{ padding: '11px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>
          {entry.module ?? '—'}
        </td>
        <td style={{ padding: '11px 12px', fontSize: 12, color: 'var(--color-slate-dark)' }}>
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

const inputStyle: React.CSSProperties = {
  height:          32,
  padding:         '0 10px',
  borderRadius:    6,
  border:          '1px solid #e5e7eb',
  fontSize:        12,
  color:           'var(--color-slate-dark)',
  backgroundColor: '#fff',
  outline:         'none',
  cursor:          'pointer',
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
    { key: 'module',    label: t('pages.logs.filterModule'),  type: 'text' },
    { key: 'timestamp', label: t('pages.logs.filterDate'),    type: 'date' },
  ]
  const [level,       setLevel]       = useState('')
  const [module,      setModule]      = useState('')
  const [search,      setSearch]      = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [offset,      setOffset]      = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)

  const { data, loading, refetch } = useQuery<{ logs: { entries: LogEntry[]; total: number } }>(GET_LOGS, {
    variables: {
      level:   level  || null,
      module:  module || null,
      search:  search || null,
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
      <div style={{ marginBottom: 20 }}>
        <PageTitle icon={<ScrollText size={22} color="var(--color-brand)" />}>
          {t('pages.logs.title')}
        </PageTitle>
        <p style={{ color: '#0f172a', fontSize: 13, margin: '4px 0 0' }}>
          {loading ? '—' : total > 0 ? t('pages.logs.count', { count: total }) : t('common.noResults')}
        </p>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={level} onChange={(e) => { setLevel(e.target.value); setOffset(0) }} style={inputStyle}>
          <option value="">{t('pages.logs.allLevels')}</option>
          {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>

        <select value={module} onChange={(e) => { setModule(e.target.value); setOffset(0) }} style={inputStyle}>
          <option value="">{t('pages.logs.allModules')}</option>
          {MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        <form
          onSubmit={(e) => { e.preventDefault(); setSearch(searchInput); setOffset(0) }}
          style={{ display: 'flex', gap: 6 }}
        >
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('pages.logs.searchPlaceholder')}
            style={{ ...inputStyle, width: 220, cursor: 'text' }}
          />
          <button type="submit" style={{
            height:          32,
            padding:         '0 14px',
            borderRadius:    6,
            border:          '1px solid #0284c7',
            backgroundColor: 'var(--color-brand)',
            color:           '#fff',
            fontSize:        12,
            cursor:          'pointer',
          }}>{t('pages.logs.search')}</button>
        </form>

        <button
          onClick={() => void refetch()}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          {t('pages.logs.refresh')}
        </button>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-slate)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          {t('pages.logs.autoRefresh')}
        </label>
      </div>

      <FilterBuilder
        fields={LOGS_FILTER_FIELDS}
        onApply={(group) => { setFilterGroup(group); setOffset(0) }}
      />

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
                <td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 13 }}>
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 12 }}>
                  {t('common.noResults')}
                </td>
              </tr>
            )}
            {entries.map((entry) => <LogRow key={entry.id} entry={entry} />)}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16, fontSize: 12, color: 'var(--color-slate)' }}>
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
              fontSize: 12, color: 'var(--color-slate)',
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
              fontSize: 12, color: 'var(--color-slate)',
            }}
          >
            {t('common.next')}
          </button>
        </div>
      )}
    </PageContainer>
  )
}
