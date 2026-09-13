/**
 * OLA / UC REPORT — quanto sono stati rispettati i contratti nella finestra scelta.
 *
 * Pagina gemella dell'SLA Report (stessa finestra, stessi box, stesse
 * percentuali: `reportWindow.tsx`). Qui si LEGGE; i contratti si creano e si
 * modificano in Admin → OLA / UC.
 *
 * Una «valutazione» è un'entità conclusa nella finestra confrontata con
 * l'obiettivo di risoluzione di un contratto: la stessa entità conta una volta
 * per ogni contratto che la copre.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@apollo/client/react'
import { Handshake } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { QueryError } from '@/components/QueryError'
import { Skeleton } from '@/components/ui/skeleton'
import { Pill } from '@/components/ui/Pill'
import { StatTile, StatTileGrid } from '@/components/ui/StatTile'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { GET_OLA_REPORT, GET_OLA_CONTRACTS } from '@/graphql/queries'
import { formatDateTime } from '@/lib/datetime'
import { palette } from '@/lib/tokens'
import { olaScopeLabel, olaMinutes, type OLAContract } from '@/pages/admin/OLAContractsPage'
import { ReportHeader, ReportSubheading, PctCell, pctColor } from './reportWindow'

interface OLARow {
  id: string; type: string; name: string; entityType: string; partyType: string | null
  partyName: string | null; resolveMinutes: number; evaluated: number; met: number
  breached: number; attainmentPct: number | null
}
interface OLAReport { generatedAt: string; windowDays: number; ola: OLARow[] }

export function OLAReportPage() {
  const { t } = useTranslation()
  const [windowDays, setWindowDays] = useState(30)
  const { data, loading, error, refetch } = useQuery<{ slaReport: OLAReport }>(GET_OLA_REPORT, {
    variables: { windowDays }, fetchPolicy: 'cache-and-network',
  })
  // I contratti (anche quelli disattivati, che il calcolo del rispetto salta)
  // e i nomi dei team responsabili vengono dall'elenco dei contratti.
  const { data: olaData } = useQuery<{ olaContracts: OLAContract[] }>(GET_OLA_CONTRACTS, { fetchPolicy: 'cache-and-network' })

  const report = data?.slaReport
  const contracts = olaData?.olaContracts ?? []

  return (
    <PageContainer>
      <ReportHeader
        icon={<Handshake />}
        title={t('sidebar.olaReport')}
        manageTo="/admin/ola-uc"
        manageLabel={t('pages.slaReport.manageContracts')}
        windowDays={windowDays}
        onWindowChange={setWindowDays}
      />

      {loading && !data && <Skeleton style={{ height: 160 }} />}
      {error && !data && <QueryError message={error.message} onRetry={() => void refetch()} />}

      {report && (() => {
        const finestra = t('pages.slaReport.windowDays', { count: report.windowDays })
        const attivi      = contracts.filter((o) => o.enabled)
        const valutazioni = report.ola.reduce((n, r) => n + r.evaluated, 0)
        const olaMet      = report.ola.reduce((n, r) => n + r.met, 0)
        const olaBreached = report.ola.reduce((n, r) => n + r.breached, 0)
        const olaPct      = valutazioni > 0 ? (olaMet / valutazioni) * 100 : null

        const columns: ColumnDef<OLAContract>[] = [
          { key: 'type', label: t('common.type'), sortable: true, width: '80px', render: (v) => (
            <Pill bg={v === 'uc' ? palette.purple.tint : palette.info.tint} color={v === 'uc' ? palette.purple.dark : palette.info.text}>{String(v).toUpperCase()}</Pill>
          ) },
          { key: 'name', label: t('common.name'), sortable: true, render: (v, o) => (
            <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)', opacity: o.enabled ? 1 : 0.55 }}>{String(v)}</span>
          ) },
          { key: 'entityType', label: t('admin.sla.scopeField'), sortable: true, render: (v) => olaScopeLabel(String(v), t) },
          { key: 'teamName', label: t('pages.slaReport.party'), sortable: true, render: (_v, o) => o.teamName ?? o.partyName ?? '—' },
          { key: 'resolveMinutes', label: t('pages.slaReport.target'), sortable: true, render: (v) => olaMinutes(Number(v), t) },
          { key: 'id', label: t('pages.slaReport.attainment', { window: finestra }), sortable: false, render: (_v, o) => {
            const att = report.ola.find((r) => r.id === o.id)
            const pct = att?.attainmentPct ?? null
            return (
              <span style={{ opacity: o.enabled ? 1 : 0.55 }}>
                {pct == null ? <span style={{ color: 'var(--color-slate-light)' }}>{t('components.widgetBody.noData')}</span> : <PctCell pct={pct} />}
                {att && att.evaluated > 0 && (
                  <span style={{ color: 'var(--color-slate-light)', marginLeft: 6, fontSize: 'var(--font-size-label)' }}>({att.met}/{att.evaluated})</span>
                )}
              </span>
            )
          } },
        ]

        return (
          <>
            <StatTileGrid>
              <StatTile label={t('pages.slaReport.activeContracts')} value={String(attivi.length)} />
              <StatTile label={t('pages.slaReport.evaluations', { window: finestra })} value={String(valutazioni)} />
              <StatTile label={t('pages.slaReport.met')} value={String(olaMet)} accent={palette.success.text} />
              <StatTile label={t('pages.slaReport.breached')} value={String(olaBreached)} accent={palette.danger.text} />
              <StatTile label={t('pages.slaReport.attainmentShort')} value={olaPct == null ? '—' : `${olaPct.toFixed(1)}%`} accent={pctColor(olaPct)} />
            </StatTileGrid>

            <ReportSubheading>{t('pages.slaReport.byContract')}</ReportSubheading>
            {contracts.length === 0
              ? <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: 0 }}>{t('pages.slaReport.noContracts')}</p>
              : <SortableFilterTable columns={columns} data={contracts} label={t('pages.slaReport.byContract')} />}

            <p style={{ marginTop: 16, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
              {t('pages.slaReport.generatedNote', { date: formatDateTime(report.generatedAt) })}
            </p>
          </>
        )
      })()}
    </PageContainer>
  )
}
