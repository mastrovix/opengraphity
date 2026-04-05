import { useQuery }         from '@apollo/client/react'
import { useTranslation }   from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { useState, useEffect, useRef } from 'react'
import { Activity }         from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import ReactECharts         from 'echarts-for-react'
import { GET_SYSTEM_HEALTH, GET_SYSTEM_METRICS, GET_TRACE_INFO } from '@/graphql/queries'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServiceCheck { status: string; latencyMs: number | null; error: string | null }
interface SystemHealth {
  status: string; uptime: number
  checks: { neo4j: ServiceCheck; redis: ServiceCheck; keycloak: ServiceCheck }
}
interface StatusCodeCount { code: string; count: number }
interface ResolverMetric { name: string; averageMs: number; maxMs: number; count: number }
interface ResolverError  { name: string; count: number; lastError: string | null }
interface QueueMetrics   { name: string; waiting: number; active: number; completed: number; failed: number; delayed: number }
interface SlowQuery      { query: string; durationMs: number; timestamp: string }
interface RecentTrace    { traceId: string; operationName: string; durationMs: number; status: string; timestamp: string; spanCount: number }

interface SystemMetrics {
  requests: {
    totalRequests: number; requestsPerMinute: number; averageResponseMs: number
    p95ResponseMs: number; errorRate: number; statusCodes: StatusCodeCount[]
  }
  graphql: { totalOperations: number; slowestResolvers: ResolverMetric[]; errorsByResolver: ResolverError[] }
  queues:  QueueMetrics[]
  neo4j:   { totalQueries: number; averageQueryMs: number; slowQueries: SlowQuery[]; connectionPoolActive: number; connectionPoolIdle: number }
  system:  { memoryUsageMb: number; memoryRssMb: number; cpuUsagePercent: number; nodeVersion: string; uptimeSeconds: number; pid: number }
}

// ── Style helpers ─────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background:   'white',
  border:       '1px solid #e5e7eb',
  borderRadius: 10,
  padding:      '20px 24px',
  marginBottom: 16,
}

const sectionTitle: React.CSSProperties = {
  fontSize:     15,
  fontWeight:   700,
  color:        'var(--color-slate-dark)',
  marginBottom: 16,
  marginTop:    0,
}

const statCard: React.CSSProperties = {
  background:   '#f8f9fc',
  border:       '1px solid #e5e7eb',
  borderRadius: 8,
  padding:      '14px 18px',
  flex:         1,
  minWidth:     120,
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'ok' ? '#16a34a' : '#ef4444'
  return (
    <div style={{
      width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
    }} />
  )
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MonitoringPage() {
  const { t } = useTranslation()

  const { data: healthData }  = useQuery<{ systemHealth: SystemHealth }>(GET_SYSTEM_HEALTH,  { pollInterval: 15_000, fetchPolicy: 'network-only' })
  const { data: metricsData } = useQuery<{ systemMetrics: SystemMetrics }>(GET_SYSTEM_METRICS, { pollInterval: 15_000, fetchPolicy: 'network-only' })
  const { data: traceData }   = useQuery<{ traceInfo: { enabled: boolean; endpoint: string | null; recentTraces: RecentTrace[] } }>(GET_TRACE_INFO, { pollInterval: 15_000, fetchPolicy: 'network-only' })

  const health  = healthData?.systemHealth
  const metrics = metricsData?.systemMetrics
  const trace   = traceData?.traceInfo

  // Rolling RPM chart — keep last 30 samples
  const rpmHistory = useRef<number[]>([])
  const [rpmChartData, setRpmChartData] = useState<number[]>([])

  useEffect(() => {
    if (metrics?.requests?.requestsPerMinute !== undefined) {
      rpmHistory.current.push(metrics.requests.requestsPerMinute)
      if (rpmHistory.current.length > 30) rpmHistory.current.shift()
      setRpmChartData([...rpmHistory.current])
    }
  }, [metrics?.requests?.requestsPerMinute])

  const rpmChartOption = {
    grid:    { top: 8, right: 8, bottom: 8, left: 36, containLabel: true },
    xAxis:   { type: 'category', show: false, data: rpmChartData.map((_, i) => i) },
    yAxis:   { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
    tooltip: { trigger: 'axis', formatter: (p: { value: number }[]) => `${p[0]?.value ?? 0} req/min` },
    series:  [{
      type:      'line',
      data:      rpmChartData,
      smooth:    true,
      lineStyle: { color: 'var(--color-brand)', width: 2 },
      areaStyle: { color: 'rgba(56,189,248,0.12)' },
      symbol:    'none',
    }],
  }

  const serviceEntries: { key: 'neo4j' | 'redis' | 'keycloak'; label: string }[] = [
    { key: 'neo4j',    label: t('pages.monitoring.health.neo4j')    },
    { key: 'redis',    label: t('pages.monitoring.health.redis')    },
    { key: 'keycloak', label: t('pages.monitoring.health.keycloak') },
  ]

  return (
    <PageContainer>
      {/* Header */}
      <PageTitle icon={<Activity size={22} color="var(--color-brand)" />}>
        {t('pages.monitoring.title')}
      </PageTitle>
      <p style={{ fontSize: 13, color: 'var(--color-slate-light)', marginTop: 4, marginBottom: 24 }}>
        {t('pages.monitoring.subtitle')}
      </p>

      {/* Section 1: System Health */}
      <div style={card}>
        <p style={sectionTitle}>{t('pages.monitoring.health.title')}</p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {/* Overall */}
          <div style={{ ...statCard, display: 'flex', alignItems: 'center', gap: 10 }}>
            <StatusDot status={health?.status ?? 'unknown'} />
            <div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.health.uptime')}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                {health ? formatUptime(health.uptime) : '—'}
              </div>
            </div>
          </div>

          {serviceEntries.map(({ key, label }) => {
            const check = health?.checks[key]
            return (
              <div key={key} style={{ ...statCard, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <StatusDot status={check?.status ?? 'unknown'} />
                <div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: check?.status === 'ok' ? '#16a34a' : '#ef4444' }}>
                    {check?.status === 'ok' ? t('pages.monitoring.health.ok') : t('pages.monitoring.health.error')}
                  </div>
                  {check?.latencyMs !== null && check?.latencyMs !== undefined && (
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                      {t('pages.monitoring.health.latency')}: {check.latencyMs}ms
                    </div>
                  )}
                  {check?.error && (
                    <div style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>
                      {check.error}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Section 2: Request Metrics */}
      <div style={card}>
        <p style={sectionTitle}>{t('pages.monitoring.requests.title')}</p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.requests.rpm')}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-brand)' }}>
              {metrics?.requests.requestsPerMinute.toFixed(0) ?? '—'}
            </div>
          </div>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.requests.avg')}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
              {metrics ? `${metrics.requests.averageResponseMs.toFixed(0)}ms` : '—'}
            </div>
          </div>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.requests.p95')}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
              {metrics ? `${metrics.requests.p95ResponseMs.toFixed(0)}ms` : '—'}
            </div>
          </div>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.requests.errorRate')}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: metrics && metrics.requests.errorRate > 0.05 ? '#ef4444' : 'var(--color-slate-dark)' }}>
              {metrics ? `${(metrics.requests.errorRate * 100).toFixed(1)}%` : '—'}
            </div>
          </div>
        </div>

        {/* Mini RPM chart */}
        {rpmChartData.length > 1 && (
          <div style={{ height: 120 }}>
            <ReactECharts option={rpmChartOption} style={{ height: 120 }} />
          </div>
        )}
      </div>

      {/* Section 3: BullMQ Queues */}
      <div style={card}>
        <p style={sectionTitle}>{t('pages.monitoring.queues.title')}</p>
        {metrics?.queues && metrics.queues.length > 0 ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ textAlign: 'left', padding: '6px 12px 6px 0', color: '#6b7280', fontWeight: 600 }}>Queue</th>
                <th style={{ textAlign: 'right', padding: '6px 12px', color: '#3b82f6', fontWeight: 600 }}>{t('pages.monitoring.queues.waiting')}</th>
                <th style={{ textAlign: 'right', padding: '6px 12px', color: '#22c55e', fontWeight: 600 }}>{t('pages.monitoring.queues.active')}</th>
                <th style={{ textAlign: 'right', padding: '6px 12px', color: '#6b7280', fontWeight: 600 }}>{t('pages.monitoring.queues.completed')}</th>
                <th style={{ textAlign: 'right', padding: '6px 12px', color: '#ef4444', fontWeight: 600 }}>{t('pages.monitoring.queues.failed')}</th>
                <th style={{ textAlign: 'right', padding: '6px 12px', color: '#8b5cf6', fontWeight: 600 }}>{t('pages.monitoring.queues.delayed')}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.queues.map((q) => (
                <tr key={q.name} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 12px 8px 0', fontFamily: 'monospace', fontWeight: 600 }}>{q.name}</td>
                  <td style={{ textAlign: 'right', padding: '8px 12px' }}>{q.waiting}</td>
                  <td style={{ textAlign: 'right', padding: '8px 12px' }}>{q.active}</td>
                  <td style={{ textAlign: 'right', padding: '8px 12px' }}>{q.completed}</td>
                  <td style={{ textAlign: 'right', padding: '8px 12px', color: q.failed > 0 ? '#ef4444' : undefined }}>{q.failed}</td>
                  <td style={{ textAlign: 'right', padding: '8px 12px' }}>{q.delayed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: 24 }}>
            {t('common.noResults')}
          </div>
        )}
      </div>

      {/* Section 4: Neo4j */}
      <div style={card}>
        <p style={sectionTitle}>{t('pages.monitoring.neo4j.title')}</p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.neo4j.totalQueries')}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
              {metrics?.neo4j.totalQueries ?? '—'}
            </div>
          </div>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.neo4j.avgQuery')}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
              {metrics ? `${metrics.neo4j.averageQueryMs.toFixed(1)}ms` : '—'}
            </div>
          </div>
        </div>

        {metrics?.neo4j.slowQueries && metrics.neo4j.slowQueries.length > 0 && (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>
              {t('pages.monitoring.neo4j.slowQueries')}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <tbody>
                {metrics.neo4j.slowQueries.map((sq, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '6px 0', fontFamily: 'monospace', wordBreak: 'break-all', color: '#374151' }}>
                      {sq.query}
                    </td>
                    <td style={{ padding: '6px 12px', color: '#ef4444', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {sq.durationMs.toFixed(0)}ms
                    </td>
                    <td style={{ padding: '6px 0', color: '#9ca3af', whiteSpace: 'nowrap' }}>
                      {new Date(sq.timestamp).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* Section 5: OpenTelemetry Tracing */}
      <div style={card}>
        <p style={sectionTitle}>{t('pages.monitoring.tracing.title')}</p>
        {trace ? (
          trace.enabled ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#16a34a' }} />
                <span style={{ fontSize: 13, color: '#16a34a', fontWeight: 600 }}>
                  {t('pages.monitoring.tracing.enabled')}
                </span>
                {trace.endpoint && (
                  <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 8 }}>{trace.endpoint}</span>
                )}
              </div>

              {trace.recentTraces.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                      <th style={{ textAlign: 'left', padding: '6px 0', color: '#6b7280', fontWeight: 600 }}>Operation</th>
                      <th style={{ textAlign: 'right', padding: '6px 12px', color: '#6b7280', fontWeight: 600 }}>Duration</th>
                      <th style={{ textAlign: 'right', padding: '6px 12px', color: '#6b7280', fontWeight: 600 }}>Status</th>
                      <th style={{ textAlign: 'right', padding: '6px 0', color: '#6b7280', fontWeight: 600 }}>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...trace.recentTraces].reverse().slice(0, 20).map((tr) => (
                      <tr key={tr.traceId} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '6px 0', fontFamily: 'monospace' }}>
                          {tr.operationName}
                          {tr.spanCount > 1 && (
                            <span style={{ color: '#9ca3af', marginLeft: 8, fontSize: 11 }}>
                              — {tr.spanCount} spans
                            </span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', padding: '6px 12px', fontWeight: 600 }}>{tr.durationMs.toFixed(1)}ms</td>
                        <td style={{ textAlign: 'right', padding: '6px 12px' }}>
                          <span style={{ color: tr.status === 'OK' ? '#16a34a' : '#ef4444', fontWeight: 600 }}>
                            {tr.status}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right', padding: '6px 0', color: '#9ca3af' }}>
                          {new Date(tr.timestamp).toLocaleTimeString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: 13, color: '#9ca3af' }}>No recent traces</div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 13, color: '#9ca3af', padding: '12px 0' }}>
              {t('pages.monitoring.tracing.noTracing')}
            </div>
          )
        ) : null}
      </div>

      {/* Section 6: Process Info */}
      <div style={card}>
        <p style={sectionTitle}>{t('pages.monitoring.process.title')}</p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.process.memory')}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
              {metrics ? `${metrics.system.memoryUsageMb.toFixed(0)} MB` : '—'}
            </div>
          </div>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.process.rss')}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
              {metrics ? `${metrics.system.memoryRssMb.toFixed(0)} MB` : '—'}
            </div>
          </div>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.process.cpu')}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
              {metrics ? `${metrics.system.cpuUsagePercent.toFixed(1)}%` : '—'}
            </div>
          </div>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.process.version')}</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-slate-dark)', fontFamily: 'monospace' }}>
              {metrics?.system.nodeVersion ?? '—'}
            </div>
          </div>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.process.pid')}</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-slate-dark)', fontFamily: 'monospace' }}>
              {metrics?.system.pid ?? '—'}
            </div>
          </div>
          <div style={statCard}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t('pages.monitoring.health.uptime')}</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
              {metrics ? formatUptime(metrics.system.uptimeSeconds) : '—'}
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  )
}
