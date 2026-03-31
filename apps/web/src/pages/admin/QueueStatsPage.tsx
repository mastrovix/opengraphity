import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Activity } from 'lucide-react'
import { GET_QUEUE_STATS } from '@/graphql/queries'
import { useEffect } from 'react'

interface QueueJobCounts {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
  paused: number
}

interface QueueStat {
  name: string
  counts: QueueJobCounts
}

const COUNTER_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  active:    { label: 'active',    color: '#3b82f6', bg: 'rgba(59,130,246,0.10)' },
  waiting:   { label: 'waiting',   color: '#f59e0b', bg: 'rgba(245,158,11,0.10)' },
  delayed:   { label: 'delayed',   color: '#8b5cf6', bg: 'rgba(139,92,246,0.10)' },
  failed:    { label: 'failed',    color: '#ef4444', bg: 'rgba(239,68,68,0.10)'  },
  completed: { label: 'completed', color: '#22c55e', bg: 'rgba(34,197,94,0.10)'  },
  paused:    { label: 'paused',    color: '#94a3b8', bg: 'rgba(148,163,184,0.10)'},
}

const COUNTER_ORDER = ['active', 'waiting', 'delayed', 'failed', 'completed', 'paused'] as const

export function QueueStatsPage() {
  const { t } = useTranslation()
  const { data, loading, error, refetch } = useQuery(GET_QUEUE_STATS, {
    fetchPolicy: 'network-only',
  })

  useEffect(() => {
    const id = setInterval(() => { void refetch() }, 10_000)
    return () => clearInterval(id)
  }, [refetch])

  const queues: QueueStat[] = (data as { queueStats?: QueueStat[] } | undefined)?.queueStats ?? []

  return (
    <div style={{ padding: '32px 40px', maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Activity size={22} color="var(--color-brand)" />
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
            {t('pages.queueStats.title')}
          </h1>
        </div>
        <button
          onClick={() => void refetch()}
          disabled={loading}
          style={{
            display:    'flex',
            alignItems: 'center',
            gap:         6,
            padding:    '7px 14px',
            borderRadius: 8,
            border:     '1px solid var(--color-border)',
            background: 'white',
            color:      'var(--color-slate-dark)',
            fontSize:   13,
            cursor:     loading ? 'not-allowed' : 'pointer',
            opacity:    loading ? 0.6 : 1,
          }}
        >
          <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          {t('pages.logs.refresh')}
        </button>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: 13, marginBottom: 20 }}>
          {error.message}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {queues.map((q) => (
          <div
            key={q.name}
            style={{
              background:   'white',
              border:       '1px solid var(--color-border)',
              borderRadius: 10,
              padding:      '16px 20px',
              display:      'flex',
              alignItems:   'center',
              gap:          20,
            }}
          >
            <div style={{ minWidth: 180 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)', fontFamily: 'monospace' }}>
                {q.name}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, flex: 1 }}>
              {COUNTER_ORDER.map((key) => {
                const s = COUNTER_STYLE[key]
                const val = q.counts[key]
                return (
                  <span
                    key={key}
                    style={{
                      display:      'inline-flex',
                      alignItems:   'center',
                      gap:          5,
                      padding:      '3px 10px',
                      borderRadius: 20,
                      background:   s.bg,
                      fontSize:     12,
                      fontWeight:   val > 0 ? 600 : 400,
                      color:        val > 0 ? s.color : '#94a3b8',
                    }}
                  >
                    <span style={{ fontWeight: 700 }}>{val}</span>
                    <span>{t(`pages.queueStats.${key}`, s.label)}</span>
                  </span>
                )
              })}
            </div>
          </div>
        ))}
        {!loading && queues.length === 0 && !error && (
          <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 14, padding: 40 }}>
            {t('common.noResults')}
          </div>
        )}
      </div>

      <p style={{ marginTop: 20, fontSize: 12, color: '#94a3b8' }}>
        {t('pages.queueStats.autoRefresh')}
      </p>
    </div>
  )
}
