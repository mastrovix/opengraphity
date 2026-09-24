/**
 * CMDB HEALTH (owner's request, 24 Sep 2026): what is missing or does not add
 * up in the CMDB, counted live on every visit.
 *
 * One card per check — how many CIs it finds, out of how many it looked at —
 * and, for the card chosen, the list of those CIs with the filters and the
 * CSV. The chosen check lives in the URL (`?check=`), so a link or F5 opens
 * the same list. The rules of each check are the API's (services/cmdbHealth.ts):
 * this page only shows them. Retired CIs are left out, and the page says which
 * statuses that means.
 *
 * Two tabs (`?tab=`): the checks, and the CMDB chains — which relations
 * between CIs are admitted (owner, 24 Sep 2026). Three checks come from the
 * chains: outside every chain, incomplete chains, relations not admitted.
 */
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApolloClient, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Download, HeartPulse } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { QueryError } from '@/components/QueryError'
import { Pagination } from '@/components/ui/Pagination'
import { Tabs } from '@/components/ui/Tabs'
import { Select } from '@/components/ui/FormControls'
import { GET_CMDB_HEALTH, GET_CMDB_HEALTH_ITEMS } from '@/graphql/queries'
import { useCILabels } from '@/hooks/useCILabels'
import { useCIBaseEnums } from '@/lib/ciEnums'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { exportToCsv } from '@/lib/csvExport'
import { formatDate } from '@/lib/datetime'
import { showError } from '@/lib/showError'
import { colors } from '@/lib/tokens'
import { useMe } from '@/hooks/useMe'
import { CmdbChainsTab } from './chains/CmdbChainsTab'
import { linkWords } from './chains/ChainNodePanel'
import { relationLabel, type ChainCoverage } from './chains/chainModel'

const PAGE_SIZE = 25
/** The CSV holds every CI of the check, up to the API's ceiling. */
const CSV_LIMIT = 10_000

interface HealthCheck { key: string; count: number; population: number; notCheckedTypes: string[]; needsChains: boolean }
interface MissingLink { chain: string; ciType: string; relationType: string; direction: string }
interface HealthItem {
  id: string; name: string; type: string; environment: string | null; status: string | null
  expiresAt: string | null; inUseBy: number | null; sameName: number | null; missingFields: string[]
  missingLinks: MissingLink[]; relation: string | null; relatedId: string | null; relatedName: string | null; relatedType: string | null
}
interface HealthSummary { checks: HealthCheck[]; retiredStatuses: string[]; chainCount: number; chainCoverage: ChainCoverage[] }
interface HealthItems { total: number; population: number; items: HealthItem[] }

export function CmdbHealthPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const chosen = params.get('check')
  const tab = params.get('tab') === 'chains' ? 'chains' : 'checks'
  const { can } = useMe()
  const { data, loading, error, refetch } = useQuery<{ cmdbHealth: HealthSummary }>(GET_CMDB_HEALTH, {
    fetchPolicy: 'cache-and-network',
  })
  const ciLabels = useCILabels()
  const health = data?.cmdbHealth
  const showTab = (key: 'checks' | 'chains') => setParams((prev) => {
    const next = new URLSearchParams(prev)
    if (key === 'chains') next.set('tab', 'chains')
    else { next.delete('tab'); next.delete('chain') }
    return next
  }, { replace: true })
  const choose = (key: string) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    if (next.get('check') === key) next.delete('check')
    else next.set('check', key)
    return next
  }, { replace: true })

  return (
    <PageContainer style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <PageTitle icon={<HeartPulse size={22} color="var(--color-icon-accent)" aria-hidden="true" />}>
          {t('pages.cmdbHealth.title')}
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: '4px 0 0', maxWidth: '90ch', lineHeight: 1.5 }}>
          {health && health.retiredStatuses.length > 0
            ? t('pages.cmdbHealth.subtitleRetired', { statuses: health.retiredStatuses.map((s) => ciLabels.statusLabel(s)).join(', ') })
            : t('pages.cmdbHealth.subtitle')}
        </p>
      </div>

      <Tabs ariaLabel={t('pages.cmdbHealth.title')} value={tab} onChange={showTab}
        items={[{ key: 'checks', label: t('pages.cmdbHealth.tabs.checks') }, { key: 'chains', label: t('pages.cmdbHealth.tabs.chains'), badge: health?.chainCount }]} />

      {tab === 'chains' ? (
        <CmdbChainsTab coverage={health?.chainCoverage ?? []} canEdit={can('config.metamodel')} />
      ) : error && !health ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {(health?.checks ?? []).map((c) => (
            <CheckCard key={c.key} check={c} active={c.key === chosen} onClick={() => choose(c.key)} />
          ))}
          {loading && !health && <p style={{ color: colors.slateLight }}>{t('common.loading')}</p>}
        </div>
      )}

      {tab === 'checks' && chosen && health && <CheckList key={chosen} check={chosen} />}
      {tab === 'checks' && !chosen && health && (
        <p style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, margin: 0 }}>{t('pages.cmdbHealth.pickCheck')}</p>
      )}
    </PageContainer>
  )
}

/** A check: its number, what it looked at, and a click opens its CIs. Green when nothing is found. */
function CheckCard({ check, active, onClick }: { check: HealthCheck; active: boolean; onClick: () => void }) {
  const { t, i18n } = useTranslation()
  // Numbers in the product's language, not the browser's.
  const num = (n: number) => n.toLocaleString(i18n.language)
  const clean = check.count === 0
  const accent = clean ? colors.success : colors.warning
  const percent = check.population > 0 ? Math.round((check.count / check.population) * 1000) / 10 : 0
  // This one counts relations, not CIs.
  const unit = check.key === 'relation_not_admitted' ? 'Relations' : ''
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      style={{
        textAlign: 'left', font: 'inherit', padding: '14px 16px', borderRadius: 12, minWidth: 0, cursor: 'pointer',
        background: colors.white, border: active ? `2px solid ${accent}` : '1px solid var(--border)', boxShadow: 'var(--shadow-card)',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
      <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
        {t(`pages.cmdbHealth.checks.${check.key}.title`)}
      </span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: accent, lineHeight: 1 }}>
          {clean ? <CheckCircle2 size={24} aria-label={t('pages.cmdbHealth.clean')} /> : num(check.count)}
        </span>
        <span style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight }}>
          {clean
            ? t(`pages.cmdbHealth.cleanOf${unit}`, { population: num(check.population) })
            : t(`pages.cmdbHealth.countOf${unit}`, { population: num(check.population), percent: num(percent) })}
        </span>
      </span>
      <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', lineHeight: 1.45 }}>
        {t(`pages.cmdbHealth.checks.${check.key}.description`)}
      </span>
      {check.needsChains && (
        <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-warning-text)', lineHeight: 1.45 }}>
          {t('pages.cmdbHealth.needsChains')}
        </span>
      )}
      {check.notCheckedTypes.length > 0 && (
        <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-warning-text)', lineHeight: 1.45 }}>
          {t('pages.cmdbHealth.notChecked', { types: check.notCheckedTypes.join(', ') })}
        </span>
      )}
    </button>
  )
}

type Words = { relation: (r: string) => string; type: (t: string) => string }

/** What a CI of this check has wrong, beyond being in the list. */
function detailOf(check: string, item: HealthItem, t: (k: string, o?: Record<string, unknown>) => string, words: Words): string {
  if (check === 'chain_incomplete' && item.missingLinks.length) {
    // One group per chain: within it the links go together, between chains they are alternatives.
    const chains = [...new Set(item.missingLinks.map((l) => l.chain))]
    const groups = chains.map((chain) => `${item.missingLinks.filter((l) => l.chain === chain).map((l) => linkWords(l, words.relation(l.relationType), words.type(l.ciType))).join(' + ')} (${chain})`)
    return chains.length > 1
      ? t('pages.cmdbHealth.detail.missingOneOf', { links: groups.join(` ${t('pages.cmdbHealth.detail.or')} `) })
      : t('pages.cmdbHealth.detail.missingLinks', { links: groups[0] })
  }
  if (check === 'relation_not_admitted' && item.relation) {
    return t('pages.cmdbHealth.detail.relation', { relation: words.relation(item.relation), name: item.relatedName ?? '', type: item.relatedType ? words.type(item.relatedType) : '' })
  }
  if (check === 'certificate_expired_in_use' && item.expiresAt) {
    return t('pages.cmdbHealth.detail.expired', { date: formatDate(item.expiresAt), count: item.inUseBy ?? 0 })
  }
  if (check === 'duplicate_name' && item.sameName != null) return t('pages.cmdbHealth.detail.sameName', { count: item.sameName })
  if (check === 'required_field_empty' && item.missingFields.length) return t('pages.cmdbHealth.detail.missing', { fields: item.missingFields.join(', ') })
  return ''
}

/** The CIs one check finds, filtered by type and environment, a page at a time, and all of them in the CSV. */
function CheckList({ check }: { check: string }) {
  const { t } = useTranslation()
  const client = useApolloClient()
  const ciLabels = useCILabels()
  const { environments } = useCIBaseEnums()
  const { ciTypes } = useMetamodel()
  const words: Words = { relation: (r) => relationLabel(r), type: (x) => ciLabels.typeLabel(x) }
  const [type, setType] = useState('')
  const [environment, setEnvironment] = useState('')
  const [page, setPage] = useState(0)
  const [exporting, setExporting] = useState(false)
  const variables = { check, type: type || null, environment: environment || null }
  const { data, previousData, loading, error, refetch } = useQuery<{ cmdbHealthItems: HealthItems }>(GET_CMDB_HEALTH_ITEMS, {
    variables: { ...variables, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
  })
  const list = data?.cmdbHealthItems
  // While the next page loads the pager keeps the last total (the anomalies' lesson, 24 Sep 2026).
  const total = (data ?? previousData)?.cmdbHealthItems.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  useEffect(() => {
    if (data && !loading && page > 0 && page >= totalPages) setPage(totalPages - 1)
  }, [data, loading, page, totalPages])

  const exportCsv = async () => {
    setExporting(true)
    try {
      const res = await client.query<{ cmdbHealthItems: HealthItems }>({
        query: GET_CMDB_HEALTH_ITEMS, fetchPolicy: 'network-only', variables: { ...variables, limit: CSV_LIMIT, offset: 0 },
      })
      const rows = (res.data?.cmdbHealthItems.items ?? []).map((i) => ({
        name: i.name, type: ciLabels.typeLabel(i.type), environment: i.environment ? ciLabels.environmentLabel(i.environment) : '',
        status: i.status ? ciLabels.statusLabel(i.status) : '', detail: detailOf(check, i, t, words),
      }))
      exportToCsv(`cmdb-health-${check}`, [
        { key: 'name', label: t('pages.cmdbHealth.col.name') }, { key: 'type', label: t('pages.cmdbHealth.col.type') },
        { key: 'environment', label: t('pages.cmdbHealth.col.environment') }, { key: 'status', label: t('pages.cmdbHealth.col.status') },
        { key: 'detail', label: t('pages.cmdbHealth.col.detail') },
      ], rows)
    } catch (err) {
      showError(err)
    } finally {
      setExporting(false)
    }
  }

  const cell: React.CSSProperties = { padding: '8px 12px', fontSize: 'var(--font-size-body)', borderBottom: '1px solid var(--border)', textAlign: 'left' }
  return (
    <section aria-label={t(`pages.cmdbHealth.checks.${check}.title`)} className="card-border" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', flex: '1 1 auto' }}>
          {t(`pages.cmdbHealth.checks.${check}.title`)}
          {list && <span style={{ fontWeight: 400, color: colors.slateLight }}> · {t(check === 'relation_not_admitted' ? 'pages.cmdbHealth.foundRelations' : 'pages.cmdbHealth.found', { count: list.total })}</span>}
        </h2>
        <Select aria-label={t('pages.cmdbHealth.col.type')} value={type} onChange={(e) => { setType(e.target.value); setPage(0) }} style={{ width: 'auto' }}>
          <option value="">{t('pages.cmdbHealth.allTypes')}</option>
          {ciTypes.map((ct) => <option key={ct.name} value={ct.name}>{ciLabels.typeLabel(ct.name)}</option>)}
        </Select>
        <Select aria-label={t('pages.cmdbHealth.col.environment')} value={environment} onChange={(e) => { setEnvironment(e.target.value); setPage(0) }} style={{ width: 'auto' }}>
          <option value="">{t('pages.cmdbHealth.allEnvironments')}</option>
          {environments.map((v) => <option key={v} value={v}>{ciLabels.environmentLabel(v)}</option>)}
        </Select>
        <button type="button" onClick={() => void exportCsv()} disabled={exporting || total === 0}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)',
            background: colors.white, color: colors.slate, fontSize: 'var(--font-size-body)', cursor: exporting || total === 0 ? 'not-allowed' : 'pointer',
          }}>
          <Download size={14} aria-hidden="true" /> {t('pages.cmdbHealth.exportCsv')}
        </button>
      </div>

      {error && !list ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : list && list.items.length === 0 ? (
        <p style={{ margin: 0, color: colors.slateLight, fontSize: 'var(--font-size-body)' }}>
          {type || environment ? t('pages.cmdbHealth.emptyFiltered') : t('pages.cmdbHealth.emptyCheck')}
        </p>
      ) : (
        // Wide lists scroll inside their box; the header's look is index.css's (`table thead th`).
        <div className="og-scroll-x">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {(['name', 'type', 'environment', 'status', 'detail'] as const).map((c) => (
                <th key={c} scope="col" style={{ padding: '8px 12px', textAlign: 'left' }}>
                  {t(`pages.cmdbHealth.col.${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(list?.items ?? []).map((i) => (
              // A CI with two relations not admitted is on two rows.
              <tr key={`${i.id}|${i.relation ?? ''}|${i.relatedId ?? ''}`}>
                <td style={cell}><Link to={`/ci/${i.type}/${i.id}`} style={{ color: 'var(--color-brand-hover)', textDecoration: 'none', fontWeight: 500 }}>{i.name}</Link></td>
                <td style={cell}>{ciLabels.typeLabel(i.type)}</td>
                <td style={cell}>{i.environment ? ciLabels.environmentLabel(i.environment) : '—'}</td>
                <td style={cell}>{i.status ? ciLabels.statusLabel(i.status) : '—'}</td>
                <td style={{ ...cell, color: 'var(--color-slate)' }}>
                  {detailOf(check, i, t, words) || '—'}
                  {i.relatedId && i.relatedType && (
                    <> · <Link to={`/ci/${i.relatedType}/${i.relatedId}`} style={{ color: 'var(--color-brand-hover)', textDecoration: 'none' }}>{t('pages.cmdbHealth.detail.openRelated')}</Link></>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
    </section>
  )
}
