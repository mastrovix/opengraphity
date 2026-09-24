/**
 * A CMDB chain drawn: a box per CI type, laid out as the tree it is, and a
 * line per link with the relation's name. The arrow points the relation's own
 * way (a certificate is INSTALLED ON the server below it: the arrow points up
 * to the server). Every link is required: an alternative is another chain. A tap or
 * a click on a box chooses it — the editor's panel then says what hangs there.
 * No dragging, no drawing by hand: the tree places the boxes, and a link is
 * added only from what the metamodel and the families allow.
 */
import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Background, Controls, Handle, MarkerType, Position, ReactFlow } from '@xyflow/react'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { useCILabels } from '@/hooks/useCILabels'
import { CIIcon } from '@/lib/ciIcon'
import { colors } from '@/lib/tokens'
import { layoutTree, relationLabel, type ChainNode } from './chainModel'

export interface ChainBoxData extends Record<string, unknown> {
  label: string
  icon: string
  color: string
  isRoot: boolean
  chosen: boolean
}

const ChainBox = memo(function ChainBox({ data }: NodeProps<Node<ChainBoxData>>) {
  const { t } = useTranslation()
  return (
    <div data-testid="chain-box" aria-current={data.chosen ? 'true' : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', minWidth: 150, borderRadius: 10, cursor: 'pointer',
        background: colors.white, boxShadow: 'var(--shadow-card)',
        border: data.chosen ? '2px solid var(--color-brand)' : `1px solid ${data.isRoot ? 'var(--color-brand)' : 'var(--border)'}`,
      }}>
      <Handle type="target" position={Position.Top} isConnectable={false} style={{ opacity: 0 }} />
      <CIIcon icon={data.icon} size={18} color={data.color} />
      <span style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{data.label}</span>
        {data.isRoot && <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-brand)' }}>{t('pages.cmdbHealth.chains.root')}</span>}
      </span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} style={{ opacity: 0 }} />
    </div>
  )
})

const nodeTypes = { chainBox: ChainBox }

export function ChainCanvas({ nodes, chosenId, onChoose }: { nodes: readonly ChainNode[]; chosenId: string | null; onChoose: (id: string | null) => void }) {
  const { t } = useTranslation()
  const { getCIType } = useMetamodel()
  const ciLabels = useCILabels()
  const { flowNodes, flowEdges } = useMemo(() => {
    const at = layoutTree(nodes, 190, 110)
    const flowNodes: Node<ChainBoxData>[] = nodes.filter((n) => at.has(n.id)).map((n) => {
      const def = getCIType(n.ciType)
      return {
        id: n.id, type: 'chainBox', position: at.get(n.id)!, draggable: false, connectable: false,
        data: { label: ciLabels.typeLabel(n.ciType), icon: def?.icon ?? 'box', color: def?.color ?? colors.slate, isRoot: !n.parentId, chosen: n.id === chosenId },
      }
    })
    const flowEdges: Edge[] = nodes.filter((n) => n.parentId && n.relationType && at.has(n.id)).map((n) => {
      const arrow = { type: MarkerType.ArrowClosed, color: colors.slate }
      const words = relationLabel(n.relationType!)
      return {
        id: `${n.parentId!}->${n.id}`, source: n.parentId!, target: n.id,
        label: words,
        // The arrow points the relation's own way.
        ...(n.direction === 'incoming' ? { markerStart: arrow } : { markerEnd: arrow }),
        style: { stroke: colors.slate, strokeWidth: 1.5 },
        labelStyle: { fontSize: 'var(--font-size-label)', fill: colors.slateDark },
        labelBgStyle: { fill: colors.white },
      }
    })
    return { flowNodes, flowEdges }
  }, [nodes, chosenId, getCIType, ciLabels])

  // As tall as the tree: a row per depth, between a short chain and a long one.
  const rows = new Set(nodes.map((n) => layoutTree(nodes, 190, 110).get(n.id)?.y)).size
  return (
    <div>
    <div style={{ height: Math.min(560, Math.max(260, rows * 110 + 80)), border: '1px solid var(--border)', borderRadius: 10, background: colors.white }}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_e, n) => onChoose(n.id)}
        onPaneClick={() => onChoose(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        colorMode="light"
        fitView
        fitViewOptions={{ padding: 0.25 }}
        minZoom={0.3}
        maxZoom={1.6}
        aria-label={t('pages.cmdbHealth.chains.canvas')}
      >
        <Background color={colors.border} gap={20} size={1} />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
    </div>
      <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight }}>{t('pages.cmdbHealth.chains.legend')}</p>
    </div>
  )
}
