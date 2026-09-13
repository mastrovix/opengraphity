import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { formatDateTime } from '@/lib/datetime'
import { useQuery } from '@apollo/client/react'
import { Gauge, ShieldCheck } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { QueryError } from '@/components/QueryError'
import { Skeleton } from '@/components/ui/skeleton'
import { Pill } from '@/components/ui/Pill'
import { GET_SLA_REPORT, GET_OLA_CONTRACTS } from '@/graphql/queries'
import { useMe } from '@/hooks/useMe'
import { olaScopeLabel, olaMinutes, type OLAContract } from '@/pages/admin/OLAContractsPage'
import { colors, palette } from '@/lib/tokens'
import { StatTile, StatTileGrid } from '@/components/ui/StatTile'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SLAPriorityRow { priority: string; total: number; met: number; breached: number }
interface OLARow {
  id: string; type: string; name: string; entityType: string; partyType: string | null
  partyName: string | null; resolveMinutes: number; evaluated: number; met: number
  breached: number; attainmentPct: number | null
}
interface SLAReport {
  generatedAt: string; windowDays: number
  sla: {
    total: number; met: number; breached: number; paused: number; openOnTrack: number
    breachRate: number; avgResolutionMinutes: number | null; byPriority: SLAPriorityRow[]
  }
  ola: OLARow[]
}
const WINDOWS = [7, 30, 90]

// ── Helpers ─────────────────────────────────────────────────────────────────

function pctColor(pct: number | null): string {
  if (pct == null) return 'var(--color-slate-light)'
  if (pct >= 95) return palette.success.text
  if (pct >= 80) return palette.warning.text
  return palette.danger.text
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SLAReportPage() {
  const { t } = useTranslation()
  const [windowDays, setWindowDays] = useState(30)
  const { data, loading, error, refetch } = useQuery<{ slaReport: SLAReport }>(GET_SLA_REPORT, {
    variables: { windowDays }, fetchPolicy: 'cache-and-network',
  })
  const { data: olaData } = useQuery<{ olaContracts: OLAContract[] }>(GET_OLA_CONTRACTS, {
    fetchPolicy: 'cache-and-network',
  })
  const { isAdmin } = useMe()

  const report = data?.slaReport
  const contracts = olaData?.olaContracts ?? []

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <PageTitle icon={<Gauge size={22} color="var(--color-icon-accent)" />}>{t('sidebar.slaReport')}</PageTitle>
        <div style={{ display: 'flex', gap: 6 }}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={windowDays === w}
              onClick={() => setWindowDays(w)}
              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-border-light)', background: windowDays === w ? 'var(--color-brand)' : colors.white, color: windowDays === w ? colors.white : 'var(--color-slate)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
            >
              {t('pages.slaReport.windowDays', { count: w })}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && <Skeleton style={{ height: 160 }} />}
      {error && !data && <QueryError message={error.message} onRetry={() => void refetch()} />}

      {report && (
        <>
          {/* SLA compliance KPIs */}
          <StatTileGrid>
            <StatTile label={t('pages.slaReport.slaInWindow', { window: t('pages.slaReport.windowDays', { count: report.windowDays }) })} value={String(report.sla.total)} />
            <StatTile label={t('pages.slaReport.met')} value={String(report.sla.met)} accent={palette.success.text} />
            <StatTile label={t('pages.slaReport.breached')} value={String(report.sla.breached)} accent={palette.danger.text} />
            <StatTile label={t('sla.paused')} value={String(report.sla.paused)} accent={palette.purple.dark} />
            <StatTile label={t('pages.slaReport.breachRate')} value={`${report.sla.breachRate.toFixed(1)}%`} accent={pctColor(100 - report.sla.breachRate)} />
            <StatTile label={t('pages.slaReport.avgResolution')} value={olaMinutes(report.sla.avgResolutionMinutes, t)} />
          </StatTileGrid>

          {/* By priority */}
          <div style={{ marginBottom: 28 }}>
            <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 10px' }}>{t('pages.slaReport.byPriority')}</h3>
            {report.sla.byPriority.length === 0 ? (
              <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('pages.slaReport.noData')}</p>
            ) : (
              <div style={{ border: '1px solid var(--color-border-light)', overflow: 'hidden' }}>
                <div className="og-scroll-x">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
                  <thead>
                    <tr style={{ textAlign: 'left' }}>
                      <th style={{ padding: '9px 14px' }}>{t('detail.priority')}</th>
                      <th style={{ padding: '9px 14px' }}>{t('pages.slaReport.total')}</th>
                      <th style={{ padding: '9px 14px' }}>{t('pages.slaReport.met')}</th>
                      <th style={{ padding: '9px 14px' }}>{t('pages.slaReport.breached')}</th>
                      <th style={{ padding: '9px 14px' }}>{t('pages.slaReport.compliance')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.sla.byPriority.map((r) => {
                      const concluded = r.met + r.breached
                      const pct = concluded > 0 ? (r.met / concluded) * 100 : null
                      return (
                        <tr key={r.priority} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: 'var(--color-slate-dark)', textTransform: 'capitalize' }}>{r.priority}</td>
                          <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{r.total}</td>
                          <td style={{ padding: '9px 14px', color: palette.success.text }}>{r.met}</td>
                          <td style={{ padding: '9px 14px', color: palette.danger.text }}>{r.breached}</td>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: pctColor(pct) }}>{pct == null ? '—' : `${pct.toFixed(0)}%`}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              </div>
            )}
          </div>

          {/* OLA / UC attainment */}
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ShieldCheck size={16} /> {t('pages.slaReport.contracts')}
            </h3>
            {/*
              Qui si LEGGE quanto i contratti sono stati rispettati. Si creano e
              si modificano in Admin → OLA / UC: un report non e il posto dove
              si scrive la configurazione.
            */}
            {isAdmin && (
              <Link to="/admin/ola-uc" style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: 500 }}>
                {t('pages.slaReport.manageContracts')}
              </Link>
            )}
          </div>

          {contracts.length === 0 ? (
            <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
              {t('pages.slaReport.noContracts')}
            </p>
          ) : (
            <div style={{ border: '1px solid var(--color-border-light)', overflow: 'hidden' }}>
              <div className="og-scroll-x">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
                <thead>
                  <tr style={{ textAlign: 'left' }}>
                    <th style={{ padding: '9px 14px' }}>{t('common.type')}</th>
                    <th style={{ padding: '9px 14px' }}>{t('common.name')}</th>
                    <th style={{ padding: '9px 14px' }}>{t('admin.sla.scopeField')}</th>
                    <th style={{ padding: '9px 14px' }}>{t('pages.slaReport.party')}</th>
                    <th style={{ padding: '9px 14px' }}>{t('pages.slaReport.target')}</th>
                    <th style={{ padding: '9px 14px' }}>{t('pages.slaReport.attainment', { window: t('pages.slaReport.windowDays', { count: report.windowDays }) })}</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((o) => {
                    const att = report.ola.find((r) => r.id === o.id)
                    const pct = att?.attainmentPct ?? null
                    return (
                      <tr key={o.id} style={{ borderTop: '1px solid var(--color-border-light)', opacity: o.enabled ? 1 : 0.55 }}>
                        <td style={{ padding: '9px 14px' }}>
                          <Pill bg={o.type === 'uc' ? palette.purple.tint : palette.info.tint} color={o.type === 'uc' ? palette.purple.dark : palette.info.text}>{o.type.toUpperCase()}</Pill>
                        </td>
                        <td style={{ padding: '9px 14px', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{o.name}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{olaScopeLabel(o.entityType, t)}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{o.teamName ?? o.partyName ?? '—'}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{olaMinutes(o.resolveMinutes, t)}</td>
                        <td style={{ padding: '9px 14px', fontWeight: 600, color: pctColor(pct) }}>
                          {pct == null ? <span style={{ color: 'var(--color-slate-light)', fontWeight: 400 }}>{t('components.widgetBody.noData')}</span> : `${pct.toFixed(0)}%`}
                          {att && att.evaluated > 0 && (
                            <span style={{ color: 'var(--color-slate-light)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                              ({att.met}/{att.evaluated})
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            </div>
          )}

          <p style={{ marginTop: 10, fontSize: 12, color: 'var(--color-slate-light)' }}>
            {t('pages.slaReport.generatedNote', { date: formatDateTime(report.generatedAt) })}
          </p>
        </>
      )}

    </PageContainer>
  )
}
