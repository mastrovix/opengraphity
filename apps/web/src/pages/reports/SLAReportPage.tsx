/**
 * SLA REPORT — quanto sono stati rispettati gli SLA nella finestra scelta.
 *
 * Il rispetto dei contratti OLA / UC sta nella sua pagina (OLA / UC Report):
 * una pagina sola con le due cose mescolava numeri di natura diversa — uno
 * SLA è una scadenza su un ticket, un contratto un obiettivo misurato a
 * posteriori sui ticket conclusi.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useItilTypeLabels } from '@/hooks/useItilTypeLabels'
import { useQuery } from '@apollo/client/react'
import { Gauge } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { QueryError } from '@/components/QueryError'
import { Skeleton } from '@/components/ui/skeleton'
import { StatTile, StatTileGrid } from '@/components/ui/StatTile'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { GET_SLA_REPORT } from '@/graphql/queries'
import { formatDateTime } from '@/lib/datetime'
import { palette } from '@/lib/tokens'
import { olaScopeLabel, olaMinutes } from '@/pages/admin/OLAContractsPage'
import { ReportHeader, ReportSubheading, PctCell, compliance } from './reportWindow'

interface SLAPriorityRow { priority: string; total: number; met: number; breached: number }
interface SLAPolicyRow {
  policyId: string | null; policyName: string | null; setByRule: string | null
  entityType: string | null; responseMinutes: number | null; resolveMinutes: number | null
  /** L'obiettivo della policy (ondata 2); null per SLA senza policy. */
  complianceTarget: number | null; complianceWarning: number | null
  total: number; met: number; breached: number; paused: number
}
interface SLAReport {
  generatedAt: string; windowDays: number
  sla: {
    total: number; met: number; breached: number; paused: number; openOnTrack: number
    breachRate: number; avgResolutionMinutes: number | null
    byPriority: SLAPriorityRow[]; byPolicy: SLAPolicyRow[]
  }
}

export function SLAReportPage() {
  const { t } = useTranslation()
  const { labelOf: typeLabel } = useItilTypeLabels()
  const [windowDays, setWindowDays] = useState(30)
  const { data, loading, error, refetch } = useQuery<{ slaReport: SLAReport }>(GET_SLA_REPORT, {
    variables: { windowDays }, fetchPolicy: 'cache-and-network',
  })
  const report = data?.slaReport

  return (
    <PageContainer>
      <ReportHeader
        icon={<Gauge />}
        title={t('sidebar.slaReport')}
        manageTo="/admin/sla-policies"
        manageLabel={t('pages.slaReport.managePolicies')}
        windowDays={windowDays}
        onWindowChange={setWindowDays}
      />

      {loading && !data && <Skeleton style={{ height: 160 }} />}
      {error && !data && <QueryError message={error.message} onRetry={() => void refetch()} />}

      {report && (() => {
        const finestra = t('pages.slaReport.windowDays', { count: report.windowDays })

        /*
          SLA PER ORIGINE. Ogni SLA registra la policy da cui è nato (o la regola
          che l'ha impostato): la tabella dice quanto ciascuna policy è stata
          rispettata.
        */
        const policyColumns: ColumnDef<SLAPolicyRow & { id: string }>[] = [
          { key: 'policyName', label: t('pages.slaReport.policy'), sortable: true, render: (_v, r) => (
            r.policyName
              ? <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{r.policyName}</span>
              : r.setByRule
                ? <span style={{ color: 'var(--color-slate)' }}>{t('pages.slaReport.setByRule', { rule: r.setByRule })}</span>
                // Il perché sta nel suggerimento: nella cella occupava sei righe.
                : <span title={t('pages.slaReport.noPolicyRecordedHint')} style={{ color: 'var(--color-slate-light)' }}>{t('pages.slaReport.noPolicyRecorded')}</span>
          ) },
          { key: 'entityType', label: t('admin.sla.scopeField'), sortable: true, render: (v) => v ? olaScopeLabel(String(v), t, typeLabel) : '—' },
          // Risposta e risoluzione in una colonna: con due, la tabella usciva dallo schermo.
          { key: 'resolveMinutes', label: t('pages.slaReport.targetsShort'), sortable: true, render: (_v, r) => (
            r.responseMinutes == null && r.resolveMinutes == null ? '—' : `${olaMinutes(r.responseMinutes, t)} / ${olaMinutes(r.resolveMinutes, t)}`
          ) },
          { key: 'total', label: t('pages.slaReport.total'), sortable: true },
          { key: 'met', label: t('pages.slaReport.met'), sortable: true, render: (v) => <span style={{ color: palette.success.text }}>{String(v)}</span> },
          { key: 'breached', label: t('pages.slaReport.breached'), sortable: true, render: (v) => <span style={{ color: palette.danger.text }}>{String(v)}</span> },
          { key: 'paused', label: t('pages.slaReport.pausedShort'), sortable: true },
          { key: 'complianceTarget', label: t('serviceTargets.targetColumn'), sortable: true, render: (v) => v == null ? '—' : `${String(v)}%` },
          { key: 'id', label: t('pages.slaReport.compliance'), sortValue: (r) => compliance(r.met, r.breached), render: (_v, r) => <PctCell pct={compliance(r.met, r.breached)} target={r.complianceTarget} warning={r.complianceWarning} /> },
        ]
        const policyRows = report.sla.byPolicy.map((r, i) => ({ ...r, id: r.policyId ?? `${r.setByRule ?? 'none'}-${i}` }))

        const priorityColumns: ColumnDef<SLAPriorityRow & { id: string }>[] = [
          { key: 'priority', label: t('detail.priority'), sortable: true, render: (v) => <span style={{ fontWeight: 600, color: 'var(--color-slate-dark)', textTransform: 'capitalize' }}>{String(v)}</span> },
          { key: 'total', label: t('pages.slaReport.total'), sortable: true },
          { key: 'met', label: t('pages.slaReport.met'), sortable: true, render: (v) => <span style={{ color: palette.success.text }}>{String(v)}</span> },
          { key: 'breached', label: t('pages.slaReport.breached'), sortable: true, render: (v) => <span style={{ color: palette.danger.text }}>{String(v)}</span> },
          { key: 'id', label: t('pages.slaReport.compliance'), sortValue: (r) => compliance(r.met, r.breached), render: (_v, r) => <PctCell pct={compliance(r.met, r.breached)} /> },
        ]
        const priorityRows = report.sla.byPriority.map((r) => ({ ...r, id: r.priority }))

        return (
          <>
            <StatTileGrid>
              <StatTile label={t('pages.slaReport.slaInWindow', { window: finestra })} value={String(report.sla.total)} />
              <StatTile label={t('pages.slaReport.met')} value={String(report.sla.met)} accent={palette.success.text} />
              <StatTile label={t('pages.slaReport.breached')} value={String(report.sla.breached)} accent={palette.danger.text} />
              <StatTile label={t('sla.paused')} value={String(report.sla.paused)} accent={palette.purple.dark} />
              <StatTile label={t('pages.slaReport.breachRate')} value={`${report.sla.breachRate.toFixed(1)}%`} />
              <StatTile label={t('pages.slaReport.avgResolution')} value={olaMinutes(report.sla.avgResolutionMinutes, t)} />
            </StatTileGrid>

            <ReportSubheading>{t('pages.slaReport.byPolicy')}</ReportSubheading>
            {policyRows.length === 0
              ? <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: 0 }}>{t('pages.slaReport.noData')}</p>
              : <SortableFilterTable columns={policyColumns} data={policyRows} label={t('pages.slaReport.byPolicy')} />}

            <ReportSubheading>{t('pages.slaReport.byPriority')}</ReportSubheading>
            {priorityRows.length === 0
              ? <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: 0 }}>{t('pages.slaReport.noData')}</p>
              : <SortableFilterTable columns={priorityColumns} data={priorityRows} label={t('pages.slaReport.byPriority')} />}

            <p style={{ marginTop: 16, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
              {t('pages.slaReport.generatedOn', { date: formatDateTime(report.generatedAt) })}
            </p>
          </>
        )
      })()}
    </PageContainer>
  )
}
