import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import * as d3 from 'd3'
import { ciPath } from '@/lib/ciPath'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { buildTypeIconMap, iconKeyForType } from '@/lib/ciIconPaths'
import {
  appendArrowMarker, appendIcon, attachZoom, fitTransform, linkEndpoints, nodeDrag, styleText, truncate,
} from '@/lib/d3/graphPrimitives'
import { alpha, colors, palette } from '@/lib/tokens'

interface CINode {
  id:          string
  name:        string
  type:        string
  status:      string
  environment?: string
}

interface CIRelationInput {
  relationType: string
  ci: CINode
}

interface BlastNode extends CINode {
  parentId?: string | null
  distance?: number
}

interface Props {
  centerCI:     CINode
  dependencies: CIRelationInput[]
  dependents:   CIRelationInput[]
  blastRadius:  BlastNode[]
}

type NodeRole = 'center' | 'dependency' | 'dependent' | 'blast'

interface GraphNode extends d3.SimulationNodeDatum {
  id:           string
  name:         string
  type:         string
  status:       string
  environment:  string
  role:         NodeRole
  relationType: string | null
  distance?:    number
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  relationType: string
  role:         'dependency' | 'dependent' | 'blast'
}

const COLORS: Record<NodeRole, { fill: string; stroke: string; r: number }> = {
  center:     { fill: 'var(--color-brand)', stroke: colors.white, r: 28 },
  dependency: { fill: colors.white, stroke: 'var(--color-brand)', r: 22 },
  dependent:  { fill: colors.white, stroke: 'var(--color-trigger-automatic)', r: 22 },
  blast:      { fill: colors.white, stroke: 'var(--color-trigger-timer)', r: 18 },
}

const LINK_STYLE: Record<GraphLink['role'], { stroke: string; opacity: number; dash?: string }> = {
  dependency: { stroke: 'var(--color-brand)', opacity: 0.6 },
  dependent:  { stroke: 'var(--color-trigger-automatic)', opacity: 0.6 },
  blast:      { stroke: 'var(--color-trigger-timer)', opacity: 0.4, dash: '4' },
}

interface TooltipState {
  x:    number
  y:    number
  node: GraphNode
}

export function CIGraph({ centerCI, dependencies, dependents, blastRadius }: Props) {
  const svgRef   = useRef<SVGSVGElement>(null)
  const navigate = useNavigate()
  const { t } = useTranslation()
  const baseId = useId()
  const ids = { blast: `${baseId}-blast`, depth: `${baseId}-depth`, spread: `${baseId}-spread` }
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [showBlastRadius, setShowBlastRadius] = useState(false)
  const [maxDepth, setMaxDepth] = useState(5)
  const [nodeSpread, setNodeSpread] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)

  // Icona per tipo dal metamodello (`ciType.icon`): prima CIGraph usava una
  // mappa emoji propria che ignorava il metamodello e mostrava ❌ per i tipi
  // non previsti.
  const { ciTypes } = useMetamodel()
  const typeIconMap = useMemo(() => buildTypeIconMap(ciTypes), [ciTypes])

  const centerCIRef = useRef(centerCI)
  centerCIRef.current = centerCI
  const centerCIId = centerCI.id

  useEffect(() => {
    const centerCI = centerCIRef.current
    const svg = d3.select(svgRef.current!)
    svg.selectAll('*').remove()

    const width  = svgRef.current!.clientWidth  || 800
    const height = 600

    // ── Build node/link arrays ──────────────────────────────────────────────

    const nodeMap = new Map<string, GraphNode>()

    function addNode(ci: CINode, role: NodeRole, relationType: string | null = null, distance?: number) {
      if (!nodeMap.has(ci.id)) {
        nodeMap.set(ci.id, {
          id:           ci.id,
          name:         ci.name,
          type:         ci.type,
          status:       ci.status,
          environment:  ci.environment ?? '',
          role,
          relationType,
          distance,
        })
      }
    }

    addNode(centerCI, 'center', null)
    dependencies.forEach(({ ci, relationType }) => addNode(ci, 'dependency', relationType))
    dependents.forEach(({ ci, relationType }) => addNode(ci, 'dependent', relationType))

    const depIds = new Set([
      ...dependencies.map((r) => r.ci.id),
      ...dependents.map((r) => r.ci.id),
    ])
    const blastNodes = showBlastRadius
      ? blastRadius.filter((b) => (b.distance ?? 0) <= maxDepth && !depIds.has(b.id) && b.id !== centerCI.id)
      : []
    blastNodes.forEach((ci) => addNode(ci, 'blast', null, ci.distance))

    const nodes: GraphNode[] = Array.from(nodeMap.values())

    const links: GraphLink[] = [
      ...dependencies.map((r) => ({ source: centerCI.id, target: r.ci.id, relationType: r.relationType, role: 'dependency' as const })),
      ...dependents.map((r)   => ({ source: r.ci.id, target: centerCI.id, relationType: r.relationType, role: 'dependent' as const })),
      ...blastNodes.map((ci)  => ({ source: ci.parentId ?? centerCI.id, target: ci.id, relationType: 'blast_radius', role: 'blast' as const })),
    ]

    // ── SVG setup ───────────────────────────────────────────────────────────

    const root = svg.attr('width', '100%').attr('height', height)

    const defs = root.append('defs')
    ;(Object.keys(LINK_STYLE) as GraphLink['role'][]).forEach((role) =>
      appendArrowMarker(defs, `arrow-${role}`, LINK_STYLE[role].stroke),
    )

    const g = root.append('g')
    const zoom = attachZoom(root, g, { scaleExtent: [0.3, 3], onZoom: () => setTooltip(null) })

    // ── Simulation ──────────────────────────────────────────────────────────

    const centerNode = nodes.find((n) => n.id === centerCI.id)!
    centerNode.fx = width / 2
    centerNode.fy = height / 2

    const simulation = d3.forceSimulation<GraphNode>(nodes)
      .force('link',      d3.forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance((d) => (d.role === 'blast' ? 120 : 80) * nodeSpread).strength(0.8))
      .force('charge',    d3.forceManyBody().strength(-300 * nodeSpread))
      .force('center',    d3.forceCenter(width / 2, height / 2).strength(0.1))
      .force('collision', d3.forceCollide(40))
      .force('radial',    d3.forceRadial<GraphNode>((n) => {
        if (n.role === 'center') return 0
        if (n.role === 'dependency' || n.role === 'dependent') return 120 * nodeSpread
        return (120 + (n.distance ?? 1) * 80) * nodeSpread
      }, width / 2, height / 2).strength(0.5))

    // ── Links ───────────────────────────────────────────────────────────────

    const linkEl = g.append('g').attr('class', 'links')
      .selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('stroke',            (d) => LINK_STYLE[d.role].stroke)
      .attr('stroke-opacity',    (d) => LINK_STYLE[d.role].opacity)
      .attr('stroke-width',      1.5)
      .attr('stroke-dasharray',  (d) => LINK_STYLE[d.role].dash ?? null)
      .attr('marker-end',        (d) => `url(#arrow-${d.role})`)

    // ── Nodes ───────────────────────────────────────────────────────────────

    const nodeEl = g.append('g').attr('class', 'nodes')
      .selectAll<SVGGElement, GraphNode>('g')
      .data(nodes)
      .enter().append('g')
      .attr('cursor', (d) => d.role === 'center' ? 'default' : 'pointer')
      .on('click', (_event, d) => {
        if (d.role !== 'center') navigate(ciPath({ id: d.id, type: d.type }))
      })
      .on('mouseover', (event, d) => {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        setTooltip({ x: event.clientX - rect.left + 12, y: event.clientY - rect.top - 10, node: d })
      })
      .on('mousemove', (event) => {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        setTooltip((prev) => prev ? { ...prev, x: event.clientX - rect.left + 12, y: event.clientY - rect.top - 10 } : null)
      })
      .on('mouseout', () => setTooltip(null))

    nodeEl.append('circle')
      .attr('r',            (d) => COLORS[d.role].r)
      .attr('fill',         (d) => COLORS[d.role].fill)
      .attr('stroke',       (d) => COLORS[d.role].stroke)
      .attr('stroke-width', (d) => d.role === 'center' ? 3 : 2)
      .attr('opacity',      (d) => d.role === 'blast' ? 0.7 : 1)
      .attr('filter',       (d) => d.role === 'center' ? `drop-shadow(0 4px 12px ${alpha.brand53})` : null)

    // Icona lucide dal metamodello (bianca sul centro, colore del ruolo altrove)
    nodeEl.each(function (d) {
      const sel = d3.select(this)
      const color = d.role === 'center' ? colors.white : COLORS[d.role].stroke
      appendIcon(sel, iconKeyForType(typeIconMap, d.type), color, d.role === 'center' ? 22 : 18)
    })

    // Name label (row 1)
    styleText(nodeEl.append('text'))
      .attr('text-anchor',       'middle')
      .attr('dominant-baseline', 'hanging')
      .attr('y',                 (d) => COLORS[d.role].r + 14)
      .attr('font-size',         11)
      .attr('font-weight',       600)
      .attr('fill',              'var(--color-slate-dark)')
      .text((d) => truncate(d.name, 14))

    // Type label (row 2)
    styleText(nodeEl.append('text'))
      .attr('text-anchor',       'middle')
      .attr('dominant-baseline', 'hanging')
      .attr('y',                 (d) => COLORS[d.role].r + 25)
      .attr('font-size',         10)
      .attr('fill',              'var(--color-slate-light)')
      .text((d) => d.type.replace(/_/g, ' '))

    // Relation type label (row 3 — only for non-center nodes)
    styleText(nodeEl.filter((d) => d.role !== 'center' && d.relationType !== null).append('text'))
      .attr('text-anchor',       'middle')
      .attr('dominant-baseline', 'hanging')
      .attr('y',                 (d) => COLORS[d.role].r + 35)
      .attr('font-size',         9)
      .attr('fill',              'var(--color-brand)')
      .text((d) => (d.relationType ?? '').replace(/_/g, ' '))

    // ── Drag ────────────────────────────────────────────────────────────────

    nodeEl.call(nodeDrag(simulation, { canDrag: (d) => d.role !== 'center' }))

    // ── Tick ────────────────────────────────────────────────────────────────

    simulation.on('tick', () => {
      linkEl.each(function (d) {
        const s = d.source as GraphNode
        const t = d.target as GraphNode
        const { x1, y1, x2, y2 } = linkEndpoints(s, t, COLORS[s.role].r, COLORS[t.role].r + 8)
        d3.select(this).attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
      })
      nodeEl.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    // Zoom-to-fit once the layout settles, so every node is visible without
    // manual pan/zoom — matters for large groups where the members would
    // otherwise overflow the fixed-height canvas.
    simulation.on('end', () => {
      const tr = fitTransform(nodes, width, height)
      if (tr) root.transition().duration(500).call(zoom.transform, tr)
    })

    return () => { simulation.stop() }
  }, [centerCIId, dependencies, dependents, blastRadius, showBlastRadius, maxDepth, nodeSpread, navigate, typeIconMap])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: `1px solid ${palette.neutral.borderLight}` }}>
        <input
          type="checkbox"
          id={ids.blast}
          checked={showBlastRadius}
          onChange={e => setShowBlastRadius(e.target.checked)}
          style={{ cursor: 'pointer' }}
        />
        <label htmlFor={ids.blast} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer', userSelect: 'none' }}>
          {t('components.ciGraph.showBlastRadius')}
        </label>
        {showBlastRadius && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 16 }}>
            <label htmlFor={ids.depth} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('components.ciGraph.maxDepth')}</label>
            <select
              id={ids.depth}
              value={maxDepth}
              onChange={e => setMaxDepth(Number(e.target.value))}
              style={{ fontSize: 'var(--font-size-body)', padding: '2px 4px', borderRadius: 4, border: `1px solid ${palette.neutral.borderStrong}`, cursor: 'pointer' }}
            >
              {[1, 2, 3, 4, 5].map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 16 }}>
          <label htmlFor={ids.spread} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('components.ciGraph.spread')}</label>
          <input
            id={ids.spread}
            type="range"
            min={0.5}
            max={3}
            step={0.1}
            value={nodeSpread}
            onChange={e => setNodeSpread(Number(e.target.value))}
            style={{ width: 80, cursor: 'pointer' }}
          />
        </div>
      </div>
      <svg key={`graph-${showBlastRadius}-${maxDepth}`} ref={svgRef} style={{ width: '100%', height: 600, display: 'block', backgroundColor: palette.neutral.surface1, borderRadius: 8 }} />

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position:     'absolute',
          left:         tooltip.x,
          top:          tooltip.y,
          background:   colors.white,
          border:       `1px solid ${colors.border}`,
          borderRadius: 6,
          padding:      '8px 12px',
          boxShadow:    `0 4px 16px ${alpha.black10}`,
          fontSize:     12,
          zIndex:       100,
          pointerEvents: 'none',
          whiteSpace:   'nowrap',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 4 }}>{tooltip.node.name}</div>
          <div style={{ color: 'var(--color-slate)' }}>{t('pages.cmdb.type')}: <span style={{ color: 'var(--color-slate-dark)' }}>{tooltip.node.type.replace(/_/g, ' ')}</span></div>
          <div style={{ color: 'var(--color-slate)' }}>{t('pages.cmdb.status')}: <span style={{ color: 'var(--color-slate-dark)' }}>{tooltip.node.status}</span></div>
          {tooltip.node.environment && (
            <div style={{ color: 'var(--color-slate)' }}>{t('pages.cmdb.environment')}: <span style={{ color: 'var(--color-slate-dark)' }}>{tooltip.node.environment}</span></div>
          )}
        </div>
      )}

      {/* Legend */}
      <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[
          { color: 'var(--color-brand)', label: t('components.ciGraph.legendDependencies') },
          { color: 'var(--color-trigger-automatic)', label: t('components.ciGraph.legendDependents') },
          { color: 'var(--color-trigger-timer)', label: t('components.ciGraph.legendBlast') },
        ].map(({ color, label }) => (
          <div key={color} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color, flexShrink: 0, display: 'inline-block' }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  )
}
