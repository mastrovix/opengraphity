import { useState, useEffect } from 'react'
import { useQuery, useMutation, useLazyQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { RefreshCw, Activity, ChevronDown, ChevronRight, RotateCcw, AlertCircle } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { toast } from 'sonner'
import { GET_QUEUE_STATS, GET_QUEUE_JOBS } from '@/graphql/queries'
import { RETRY_QUEUE_JOB } from '@/graphql/mutations'

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

interface QueueJob {
  id: string
  name: string
  queueName: string
  status: string
  data: string
  timestamp: string
  processedOn: string | null
  finishedOn: string | null
  failedReason: string | null
  stacktrace: string[]
  attemptsMade: number
  maxAttempts: number
  returnValue: string | null
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
const JOB_STATUSES  = ['failed', 'waiting', 'active', 'completed', 'delayed'] as const

function formatTs(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function JobDetail({ job, onRetry, retrying }: { job: QueueJob; onRetry: () => void; retrying: boolean }) {
  const [showPayload, setShowPayload] = useState(false)
  const [showStack,   setShowStack]   = useState(false)

  let prettyData = job.data
  try { prettyData = JSON.stringify(JSON.parse(job.data), null, 2) } catch { /* keep raw */ }

  return (
    <div style={{ padding: '12px 16px', background: '#f8fafc', borderTop: '1px solid #e5e7eb', fontSize: 'var(--font-size-body)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Job ID</div>
          <code style={{ fontSize: 'var(--font-size-body)', color: '#1a2332', wordBreak: 'break-all' }}>{job.id}</code>
        </div>
        <div>
          <div style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Name</div>
          <span style={{ color: '#1a2332' }}>{job.name}</span>
        </div>
        <div>
          <div style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Attempts</div>
          <span style={{ color: '#1a2332' }}>{job.attemptsMade} / {job.maxAttempts}</span>
        </div>
        <div>
          <div style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Created</div>
          <span style={{ color: '#1a2332' }}>{formatTs(job.timestamp)}</span>
        </div>
        {job.processedOn && (
          <div>
            <div style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Processed</div>
            <span style={{ color: '#1a2332' }}>{formatTs(job.processedOn)}</span>
          </div>
        )}
        {job.finishedOn && (
          <div>
            <div style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>Finished</div>
            <span style={{ color: '#1a2332' }}>{formatTs(job.finishedOn)}</span>
          </div>
        )}
      </div>

      {job.failedReason && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.06)', borderRadius: 6, border: '1px solid rgba(239,68,68,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <AlertCircle size={13} color="#ef4444" />
            <span style={{ fontSize: 'var(--font-size-table)', fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Error</span>
          </div>
          <code style={{ fontSize: 'var(--font-size-body)', color: '#ef4444', wordBreak: 'break-all' }}>{job.failedReason}</code>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          onClick={() => setShowPayload((p) => !p)}
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 'var(--font-size-body)', borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#475569' }}
        >
          {showPayload ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Payload
        </button>
        {job.stacktrace.length > 0 && (
          <button
            onClick={() => setShowStack((p) => !p)}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 'var(--font-size-body)', borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#475569' }}
          >
            {showStack ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Stack trace ({job.stacktrace.length})
          </button>
        )}
        {job.status === 'failed' && (
          <button
            onClick={onRetry}
            disabled={retrying}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 'var(--font-size-body)', borderRadius: 5, border: 'none', background: '#38bdf8', color: '#fff', cursor: retrying ? 'not-allowed' : 'pointer', opacity: retrying ? 0.6 : 1, fontWeight: 500 }}
          >
            <RotateCcw size={12} /> {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
        {job.returnValue && (
          <span style={{ fontSize: 'var(--font-size-table)', color: '#22c55e', padding: '3px 8px', background: 'rgba(34,197,94,0.08)', borderRadius: 4 }}>
            Return: {job.returnValue.length > 60 ? job.returnValue.slice(0, 60) + '…' : job.returnValue}
          </span>
        )}
      </div>

      {showPayload && (
        <pre style={{ marginTop: 10, padding: '10px 12px', background: '#1a2332', color: '#e2e8f0', borderRadius: 6, fontSize: 'var(--font-size-table)', lineHeight: 1.5, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {prettyData}
        </pre>
      )}
      {showStack && job.stacktrace.length > 0 && (
        <pre style={{ marginTop: 10, padding: '10px 12px', background: '#1a2332', color: '#fca5a5', borderRadius: 6, fontSize: 'var(--font-size-table)', lineHeight: 1.5, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {job.stacktrace.join('\n')}
        </pre>
      )}
    </div>
  )
}

function QueueRow({ queue, onQueueRefetch }: { queue: QueueStat; onQueueRefetch: () => void }) {
  const { t } = useTranslation()
  const [expanded,    setExpanded]    = useState(false)
  const [jobStatus,   setJobStatus]   = useState<string>('failed')
  const [expandedJob, setExpandedJob] = useState<string | null>(null)
  const [retryingId,  setRetryingId]  = useState<string | null>(null)

  const [loadJobs, { data, loading: jobsLoading, refetch: refetchJobs }] = useLazyQuery(GET_QUEUE_JOBS, {
    fetchPolicy: 'network-only',
  })

  const [retryJob] = useMutation(RETRY_QUEUE_JOB, {
    onCompleted: () => {
      toast.success('Job queued for retry')
      setRetryingId(null)
      void refetchJobs?.()
      onQueueRefetch()
    },
    onError: (e) => { toast.error(e.message); setRetryingId(null) },
  })

  function handleExpand() {
    const next = !expanded
    setExpanded(next)
    if (next) {
      void loadJobs({ variables: { queueName: queue.name, status: jobStatus, limit: 50 } })
    }
  }

  function handleStatusChange(s: string) {
    setJobStatus(s)
    setExpandedJob(null)
    void loadJobs({ variables: { queueName: queue.name, status: s, limit: 50 } })
  }

  const jobs: QueueJob[] = (data as { queueJobs?: QueueJob[] } | undefined)?.queueJobs ?? []

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden' }}>
      {/* Queue header row */}
      <div
        onClick={handleExpand}
        style={{ padding: '16px 20px', background: 'white', display: 'flex', alignItems: 'center', gap: 20, cursor: 'pointer' }}
      >
        <div style={{ color: '#94a3b8', flexShrink: 0 }}>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>
        <div style={{ minWidth: 180 }}>
          <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', fontFamily: 'monospace' }}>
            {queue.name}
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, flex: 1 }}>
          {COUNTER_ORDER.map((key) => {
            const s   = COUNTER_STYLE[key]
            const val = queue.counts[key]
            return (
              <span
                key={key}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '3px 10px', borderRadius: 20, background: s.bg, fontSize: 'var(--font-size-body)',
                  fontWeight: val > 0 ? 600 : 400,
                  color: val > 0 ? s.color : '#94a3b8',
                }}
              >
                <span style={{ fontWeight: 700 }}>{val}</span>
                <span>{t(`pages.queueStats.${key}`, s.label)}</span>
              </span>
            )
          })}
        </div>
      </div>

      {/* Expanded job list */}
      {expanded && (
        <div style={{ borderTop: '1px solid #e5e7eb' }}>
          {/* Status filter tabs */}
          <div style={{ display: 'flex', gap: 4, padding: '10px 16px', background: '#f8fafc', alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', marginRight: 4 }}>Show:</span>
            {JOB_STATUSES.map((s) => (
              <button
                key={s}
                onClick={(e) => { e.stopPropagation(); handleStatusChange(s) }}
                style={{
                  padding: '3px 10px', borderRadius: 5, border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer',
                  fontWeight: 500,
                  background: jobStatus === s ? (COUNTER_STYLE[s]?.color ?? '#38bdf8') : '#e2e8f0',
                  color: jobStatus === s ? '#fff' : '#475569',
                }}
              >
                {s}
              </button>
            ))}
            <button
              onClick={(e) => { e.stopPropagation(); void loadJobs({ variables: { queueName: queue.name, status: jobStatus, limit: 50 } }) }}
              style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', fontSize: 'var(--font-size-body)', borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#475569' }}
            >
              <RefreshCw size={11} /> Refresh
            </button>
          </div>

          {jobsLoading && (
            <div style={{ padding: '20px 16px', fontSize: 'var(--font-size-body)', color: '#94a3b8', textAlign: 'center' }}>Loading jobs…</div>
          )}

          {!jobsLoading && jobs.length === 0 && (
            <div style={{ padding: '24px 16px', fontSize: 'var(--font-size-body)', color: '#94a3b8', textAlign: 'center' }}>
              No {jobStatus} jobs in this queue
            </div>
          )}

          {!jobsLoading && jobs.map((job) => (
            <div key={job.id} style={{ borderTop: '1px solid #f1f5f9' }}>
              {/* Job summary row */}
              <div
                onClick={(e) => { e.stopPropagation(); setExpandedJob(expandedJob === job.id ? null : job.id) }}
                style={{ padding: '10px 20px 10px 52px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', background: expandedJob === job.id ? '#f1f5f9' : 'white' }}
              >
                <div style={{ color: '#94a3b8', flexShrink: 0 }}>
                  {expandedJob === job.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </div>
                <code style={{ fontSize: 'var(--font-size-body)', color: '#64748b', minWidth: 120 }}>{job.id}</code>
                <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: '#1a2332', flex: 1 }}>{job.name}</span>
                {job.failedReason && (
                  <span style={{ fontSize: 'var(--font-size-body)', color: '#ef4444', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {job.failedReason}
                  </span>
                )}
                <span style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                  {new Date(job.timestamp).toLocaleString()}
                </span>
              </div>

              {/* Job detail panel */}
              {expandedJob === job.id && (
                <JobDetail
                  job={job}
                  retrying={retryingId === job.id}
                  onRetry={() => {
                    setRetryingId(job.id)
                    void retryJob({ variables: { queueName: queue.name, jobId: job.id } })
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Activity size={22} color="#38bdf8" />}>
            {t('pages.queueStats.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${queues.length} code`}
          </p>
        </div>
        <button
          onClick={() => void refetch()}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 14px', borderRadius: 8, border: '1px solid var(--color-border)',
            background: 'white', color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)',
            cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1,
          }}
        >
          <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          {t('pages.logs.refresh')}
        </button>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: 'var(--font-size-body)', marginBottom: 20 }}>
          {error.message}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {queues.map((q) => (
          <QueueRow key={q.name} queue={q} onQueueRefetch={() => void refetch()} />
        ))}
        {!loading && queues.length === 0 && !error && (
          <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 'var(--font-size-card-title)', padding: 40 }}>
            {t('common.noResults')}
          </div>
        )}
      </div>

      <p style={{ marginTop: 20, fontSize: 'var(--font-size-body)', color: '#94a3b8' }}>
        {t('pages.queueStats.autoRefresh')}
      </p>
    </PageContainer>
  )
}
