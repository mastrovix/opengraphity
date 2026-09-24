/**
 * The type chosen in a chain's drawing: where its link comes from — required,
 * as every link is — removing it (with what hangs below), and the links that may be
 * added below it — only those the API offers for this type in a chain of this
 * kind (the metamodel's relations, the families' rule), never a free choice.
 */
import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/Button'
import { Select } from '@/components/ui/FormControls'
import { GET_CMDB_CHAIN_LINK_OPTIONS } from '@/graphql/queries'
import { useCILabels } from '@/hooks/useCILabels'
import { colors } from '@/lib/tokens'
import { childrenOf, relationLabel, type ChainKind, type ChainNode, type LinkOption } from './chainModel'

interface Props {
  node: ChainNode
  nodes: readonly ChainNode[]
  kind: ChainKind
  canEdit: boolean
  onRemove: () => void
  onAdd: (option: LinkOption) => void
}

/** A link in words, the arrow the relation's way: «Hosted on → Server», «Certificate → Installed on». */
export function linkWords(option: { relationType: string; direction: string; ciType: string }, relation: string, type: string): string {
  return option.direction === 'incoming' ? `${type} → ${relation}` : `${relation} → ${type}`
}

export function ChainNodePanel({ node, nodes, kind, canEdit, onRemove, onAdd }: Props) {
  const { t } = useTranslation()
  const ciLabels = useCILabels()
  const parent = node.parentId ? nodes.find((n) => n.id === node.parentId) : undefined
  const words = (o: { relationType: string; direction: string; ciType: string }) => linkWords(o, relationLabel(o.relationType), ciLabels.typeLabel(o.ciType))

  return (
    <section aria-label={ciLabels.typeLabel(node.ciType)} className="card-border" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>
        {ciLabels.typeLabel(node.ciType)}
        {!parent && <span style={{ fontWeight: 400, color: colors.slateLight }}> · {t('pages.cmdbHealth.chains.root')}</span>}
      </h3>
      {parent && node.relationType && node.direction && (
        <>
          <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
            {t('pages.cmdbHealth.chains.linkFrom', { parent: ciLabels.typeLabel(parent.ciType), link: words({ relationType: node.relationType, direction: node.direction, ciType: node.ciType }) })}
          </p>
          {canEdit && (
            <Button variant="danger" size="xs" icon={<Trash2 size={14} aria-hidden="true" />} onClick={onRemove}>
              {childrenOf(nodes, node.id).length ? t('pages.cmdbHealth.chains.removeWithBelow') : t('pages.cmdbHealth.chains.remove')}
            </Button>
          )}
        </>
      )}
      {canEdit && <LinkPicker node={node} nodes={nodes} kind={kind} words={words} onAdd={onAdd} />}
    </section>
  )
}

function LinkPicker({ node, nodes, kind, words, onAdd }: {
  node: ChainNode; nodes: readonly ChainNode[]; kind: ChainKind; words: (o: LinkOption) => string; onAdd: (o: LinkOption) => void
}) {
  const { t } = useTranslation()
  const [picked, setPicked] = useState('')
  const { data, loading, error } = useQuery<{ cmdbChainLinkOptions: LinkOption[] }>(GET_CMDB_CHAIN_LINK_OPTIONS, { variables: { ciType: node.ciType, kind } })
  const keyOf = (o: LinkOption) => `${o.relationType}|${o.direction}|${o.ciType}`
  // The links already drawn below this type are not offered twice.
  const drawn = new Set(childrenOf(nodes, node.id).map((c) => `${c.relationType ?? ''}|${c.direction ?? ''}|${c.ciType}`))
  const options = (data?.cmdbChainLinkOptions ?? []).filter((o) => !drawn.has(keyOf(o)))
  const chosen = options.find((o) => keyOf(o) === picked)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{t('pages.cmdbHealth.chains.addBelow')}</span>
      {error ? (
        <span role="alert" style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-danger)' }}>{error.message}</span>
      ) : !loading && !options.length ? (
        <span style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight }}>{t('pages.cmdbHealth.chains.noOptions')}</span>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Select aria-label={t('pages.cmdbHealth.chains.addBelow')} value={picked} onChange={(e) => setPicked(e.target.value)} style={{ flex: '1 1 200px' }} disabled={loading}>
            <option value="">{loading ? t('common.loading') : t('pages.cmdbHealth.chains.pickLink')}</option>
            {options.map((o) => <option key={keyOf(o)} value={keyOf(o)}>{words(o)}</option>)}
          </Select>
          <Button size="xs" icon={<Plus size={14} aria-hidden="true" />} disabled={!chosen} onClick={() => { if (chosen) { onAdd(chosen); setPicked('') } }}>
            {t('pages.cmdbHealth.chains.addLink')}
          </Button>
        </div>
      )}
    </div>
  )
}
