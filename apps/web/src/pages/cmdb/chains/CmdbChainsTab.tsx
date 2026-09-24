/**
 * CMDB Health → Chains (owner, 24 Sep 2026): the chains that say which
 * relations between CIs are admitted — the API refuses the others, and the
 * Checks tab counts any that got in anyway. Each chain in the list shows how
 * many of its roots in service are complete; choosing one opens it in the
 * editor. The chosen chain lives in the URL (`?chain=`, `new` for a new one).
 */
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Button } from '@/components/Button'
import { QueryError } from '@/components/QueryError'
import { GET_CMDB_CHAINS } from '@/graphql/queries'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { colors } from '@/lib/tokens'
import { ChainEditor } from './ChainEditor'
import { type ChainCoverage, type ChainDraft, type CmdbChain } from './chainModel'
import { sharePercent } from '../sharePercent'

export function CmdbChainsTab({ coverage, canEdit }: { coverage: readonly ChainCoverage[]; canEdit: boolean }) {
  const { t } = useTranslation()
  const { ciTypes } = useMetamodel()
  const [params, setParams] = useSearchParams()
  const chosen = params.get('chain')
  const { data, loading, error, refetch } = useQuery<{ cmdbChains: CmdbChain[] }>(GET_CMDB_CHAINS, { fetchPolicy: 'cache-and-network' })
  const chains = data?.cmdbChains ?? []
  const open = (id: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    if (id) next.set('chain', id)
    else next.delete('chain')
    return next
  }, { replace: true })

  const chain = chains.find((c) => c.id === chosen)
  const firstType = ciTypes.find((ct) => ct.chainFamilies.length > 0)?.name
  const draft: ChainDraft | null = chain
    ? { id: chain.id, name: chain.name, kind: chain.kind, nodes: chain.nodes }
    : chosen === 'new' && canEdit && firstType
      ? { id: null, name: '', kind: 'application', nodes: [{ id: 'root', parentId: null, ciType: firstType, relationType: null, direction: null, required: true }] }
      : null

  if (error && !data) return <QueryError message={error.message} onRetry={() => void refetch()} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', maxWidth: '90ch', lineHeight: 1.5 }}>
        {t('pages.cmdbHealth.chains.intro')}
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
        {chains.map((c) => (
          <ChainCard key={c.id} chain={c} coverage={coverage.find((x) => x.chainId === c.id)} active={c.id === chosen} onClick={() => open(c.id === chosen ? null : c.id)} />
        ))}
        {canEdit && (
          <Button variant="secondary" icon={<Plus size={15} aria-hidden="true" />} onClick={() => open('new')} aria-pressed={chosen === 'new'}>
            {t('pages.cmdbHealth.chains.newChain')}
          </Button>
        )}
        {loading && !data && <span style={{ color: colors.slateLight }}>{t('common.loading')}</span>}
      </div>
      {data && !chains.length && (
        <p role="status" style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-warning-text)' }}>{t('pages.cmdbHealth.chains.noChains')}</p>
      )}
      {draft && (
        <section aria-label={draft.name || t('pages.cmdbHealth.chains.newChain')} className="card-border" style={{ padding: 16 }}>
          <ChainEditor key={draft.id ?? 'new'} initial={draft} canEdit={canEdit} onDone={open} onCancel={() => open(null)} />
        </section>
      )}
    </div>
  )
}

/** A chain in the list: its name, its kind, and how many roots in service follow it whole. */
function ChainCard({ chain, coverage, active, onClick }: { chain: CmdbChain; coverage: ChainCoverage | undefined; active: boolean; onClick: () => void }) {
  const { t, i18n } = useTranslation()
  const num = (n: number) => n.toLocaleString(i18n.language)
  const whole = coverage !== undefined && coverage.roots > 0 && coverage.complete === coverage.roots
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      style={{
        textAlign: 'left', font: 'inherit', padding: '12px 14px', borderRadius: 10, cursor: 'pointer', minWidth: 200, flex: '0 1 260px',
        background: colors.white, border: active ? '2px solid var(--color-brand)' : '1px solid var(--border)', boxShadow: 'var(--shadow-card)',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
      <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{chain.name}</span>
      <span style={{ fontSize: 'var(--font-size-label)', color: colors.slate }}>
        {t(`pages.cmdbHealth.chains.kinds.${chain.kind}`)} · {t('pages.cmdbHealth.chains.types', { count: chain.nodes.length })}
      </span>
      <span style={{ fontSize: 'var(--font-size-label)', color: whole ? 'var(--color-success)' : colors.slateLight }}>
        {!coverage || coverage.roots === 0
          ? t('pages.cmdbHealth.chains.coverageNone')
          : t('pages.cmdbHealth.chains.coverage', { complete: num(coverage.complete), roots: num(coverage.roots), percent: sharePercent(coverage.complete, coverage.roots, i18n.language) })}
      </span>
    </button>
  )
}
