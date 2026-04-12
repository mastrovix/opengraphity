import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as d3 from 'd3'
import { ciPath } from '@/lib/ciPath'
import { lookupOrError } from '@/lib/tokens'

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
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  relationType: string
  role:         'dependency' | 'dependent' | 'blast'
}

const COLORS: Record<NodeRole, { fill: string; stroke: string; r: number }> = {
  center:     { fill: 'var(--color-brand)', stroke: '#ffffff', r: 28 },
  dependency: { fill: '#ffffff', stroke: 'var(--color-brand)', r: 22 },
  dependent:  { fill: '#ffffff', stroke: 'var(--color-trigger-automatic)', r: 22 },
  blast:      { fill: '#ffffff', stroke: 'var(--color-trigger-timer)', r: 18 },
}

const LINK_STYLE: Record<string, { stroke: string; opacity: number; dash?: string }> = {
  dependency: { stroke: 'var(--color-brand)', opacity: 0.6 },
  dependent:  { stroke: 'var(--color-trigger-automatic)', opacity: 0.6 },
  blast:      { stroke: 'var(--color-trigger-timer)', opacity: 0.4, dash: '4' },
}

const TYPE_ICON: Record<string, string> = {
  server:            '🖥',
  virtual_machine:   '☁',
  database:          '🗄',
  database_instance: '🗄',
  application:       '📦',
  microservice:      '⚙',
  network_device:    '🌐',
  storage:           '💾',
  cloud_service:     '☁',
  ssl_certificate:   '🔒',
  api_endpoint:      '🔌',
}

interface TooltipState {
  x:    number
  y:    number
  node: GraphNode
}

export function CIGraph({ centerCI, dependencies, dependents, blastRadius }: Props) {
  const svgRef   = useRef<SVGSVGElement>(null)
  const navigate = useNavigate()
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [showBlastRadius, setShowBlastRadius] = useState(false)
  const [maxDepth, setMaxDepth] = useState(5)
  const [nodeSpread, setNodeSpread] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const svg = d3.select(svgRef.current!)
    svg.selectAll('*').remove()

    const width  = svgRef.current!.clientWidth  || 800
    const height = 600

    // ── Build node/link arrays ──────────────────────────────────────────────

    const nodeMap = new Map<string, GraphNode>()

    function addNode(ci: CINode, role: NodeRole, relationType: string | null = null) {
      if (!nodeMap.has(ci.id)) {
        nodeMap.set(ci.id, {
          id:           ci.id,
          name:         ci.name,
          type:         ci.type,
          status:       ci.status,
          environment:  ci.environment ?? '',
          role,
          relationType,
        })
      }
    }

    addNode(centerCI, 'center', null)
    dependencies.forEach(({ ci, relationType }) => addNode(ci, 'dependency', relationType))
    dependents.forEach(({ ci, relationType }) => addNode(ci, 'dependent', relationType))

    const filteredBlastRadius = showBlastRadius
      ? blastRadius.filter((b) => (b.distance ?? 0) <= maxDepth)
      : []

    const depIds = new Set([
      ...dependencies.map((r) => r.ci.id),
      ...dependents.map((r) => r.ci.id),
    ])
    if (showBlastRadius) {
      filteredBlastRadius
        .filter((ci) => !depIds.has(ci.id) && ci.id !== centerCI.id)
        .forEach((ci) => addNode(ci, 'blast'))
    }

    const nodes: GraphNode[] = Array.from(nodeMap.values())

    const links: GraphLink[] = [
      ...dependencies.map((r) => ({
        source:       centerCI.id,
        target:       r.ci.id,
        relationType: r.relationType,
        role:         'dependency' as const,
      })),
      ...dependents.map((r) => ({
        source:       r.ci.id,
        target:       centerCI.id,
        relationType: r.relationType,
        role:         'dependent' as const,
      })),
      ...(showBlastRadius
        ? filteredBlastRadius
            .filter((ci) => !depIds.has(ci.id) && ci.id !== centerCI.id)
            .map((ci) => ({
              source:       ci.parentId ?? centerCI.id,
              target:       ci.id,
              relationType: 'blast_radius',
              role:         'blast' as const,
            }))
        : []),
    ]

    // ── SVG setup ───────────────────────────────────────────────────────────

    const root = svg
      .attr('width',  '100%')
      .attr('height', height)

    // Arrow markers
    const defs = root.append('defs')
    const markerDefs: Array<{ id: string; color: string }> = [
      { id: 'arrow-dependency', color: 'var(--color-brand)' },
      { id: 'arrow-dependent',  color: 'var(--color-trigger-automatic)' },
      { id: 'arrow-blast',      color: 'var(--color-trigger-timer)' },
    ]
    markerDefs.forEach(({ id, color }) => {
      defs.append('marker')
        .attr('id',           id)
        .attr('viewBox',      '0 -5 10 10')
        .attr('refX',         10)
        .attr('refY',         0)
        .attr('markerWidth',  6)
        .attr('markerHeight', 6)
        .attr('orient',       'auto')
        .append('path')
        .attr('d',    'M0,-5L10,0L0,5')
        .attr('fill', color)
    })

    // Zoom/pan container
    const g = root.append('g')

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
        setTooltip(null)
      })
    root.call(zoom)

    // ── Simulation ──────────────────────────────────────────────────────────

    const centerNode = nodes.find((n) => n.id === centerCI.id)!
    centerNode.fx = width / 2
    centerNode.fy = height / 2

    const simulation = d3.forceSimulation<GraphNode>(nodes)
      .force('link',      d3.forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance((d) => ((d as GraphLink).role === 'blast' ? 120 : 80) * nodeSpread).strength(0.8))
      .force('charge',    d3.forceManyBody().strength(-300 * nodeSpread))
      .force('center',    d3.forceCenter(width / 2, height / 2).strength(0.1))
      .force('collision', d3.forceCollide(40))
      .force('radial',    d3.forceRadial((d) => {
        const n = d as GraphNode
        if (n.role === 'center')     return 0
        if (n.role === 'dependency') return 120 * nodeSpread
        if (n.role === 'dependent')  return 120 * nodeSpread
        return (120 + ((n as GraphNode & { distance?: number }).distance ?? 1) * 80) * nodeSpread
      }, width / 2, height / 2).strength(0.5))

    // ── Links ───────────────────────────────────────────────────────────────

    const linkGroup = g.append('g').attr('class', 'links')

    const linkEl = linkGroup.selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('stroke',            (d) => LINK_STYLE[d.role].stroke)
      .attr('stroke-opacity',    (d) => LINK_STYLE[d.role].opacity)
      .attr('stroke-width',      1.5)
      .attr('stroke-dasharray',  (d) => LINK_STYLE[d.role].dash ?? null)
      .attr('marker-end',        (d) => `url(#arrow-${d.role})`)

    // ── Nodes ───────────────────────────────────────────────────────────────

    const nodeGroup = g.append('g').attr('class', 'nodes')

    const nodeEl = nodeGroup.selectAll('g')
      .data(nodes)
      .enter().append('g')
      .attr('cursor', (d) => d.role === 'center' ? 'default' : 'pointer')
      .on('click', (_event, d) => {
        if (d.role !== 'center') navigate(ciPath({ id: d.id, type: d.type }))
      })
      .on('mouseover', (event, d) => {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        setTooltip({
          x:    event.clientX - rect.left + 12,
          y:    event.clientY - rect.top  - 10,
          node: d,
        })
      })
      .on('mousemove', (event, _d) => {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        setTooltip((prev) => prev ? { ...prev, x: event.clientX - rect.left + 12, y: event.clientY - rect.top - 10 } : null)
      })
      .on('mouseout', () => setTooltip(null))

    // Circle
    nodeEl.append('circle')
      .attr('r',            (d) => COLORS[d.role].r)
      .attr('fill',         (d) => COLORS[d.role].fill)
      .attr('stroke',       (d) => COLORS[d.role].stroke)
      .attr('stroke-width', (d) => d.role === 'center' ? 3 : 2)
      .attr('opacity',      (d) => d.role === 'blast' ? 0.7 : 1)
      .attr('filter',       (d) => d.role === 'center' ? 'drop-shadow(0 4px 12px rgba(79,70,229,0.4))' : null)

    // Icon emoji
    nodeEl.append('text')
      .attr('text-anchor',     'middle')
      .attr('dominant-baseline', 'central')
      .attr('font-size',       (d) => d.role === 'center' ? 20 : 16)
      .attr('y',               0)
      .text((d) => lookupOrError(TYPE_ICON, d.type, 'TYPE_ICON', '❌'))

    // Name label (row 1)
    nodeEl.append('text')
      .attr('text-anchor',       'middle')
      .attr('dominant-baseline', 'hanging')
      .attr('y',                 (d) => COLORS[d.role].r + 14)
      .attr('font-size',         11)
      .attr('font-weight',       600)
      .attr('fill',              'var(--color-slate-dark)')
      .text((d) => d.name.length > 14 ? d.name.slice(0, 13) + '…' : d.name)

    // Type label (row 2)
    nodeEl.append('text')
      .attr('text-anchor',       'middle')
      .attr('dominant-baseline', 'hanging')
      .attr('y',                 (d) => COLORS[d.role].r + 25)
      .attr('font-size',         10)
      .attr('fill',              'var(--color-slate-light)')
      .text((d) => d.type.replace(/_/g, ' '))

    // Relation type label (row 3 — only for non-center nodes)
    nodeEl.filter((d) => d.role !== 'center' && d.relationType !== null)
      .append('text')
      .attr('text-anchor',       'middle')
      .attr('dominant-baseline', 'hanging')
      .attr('y',                 (d) => COLORS[d.role].r + 35)
      .attr('font-size',         9)
      .attr('font-family', "'Plus Jakarta Sans', system-ui, sans-serif")
      .attr('fill',              'var(--color-brand)')
      .text((d) => (d.relationType ?? '').replace(/_/g, ' '))

    // ── Drag ────────────────────────────────────────────────────────────────

    const drag = d3.drag<SVGGElement, GraphNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart()
        if (d.role !== 'center') { d.fx = d.x; d.fy = d.y }
      })
      .on('drag', (event, d) => {
        if (d.role !== 'center') { d.fx = event.x; d.fy = event.y }
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0)
        if (d.role !== 'center') { d.fx = null; d.fy = null }
      })

    nodeEl.call(drag as d3.DragBehavior<SVGGElement, GraphNode, GraphNode | d3.SubjectPosition>)

    // ── Tick ────────────────────────────────────────────────────────────────

    simulation.on('tick', () => {
      linkEl
        .attr('x1', (d) => {
          const s = d.source as GraphNode
          const t = d.target as GraphNode
          const dx = (t.x ?? 0) - (s.x ?? 0)
          const dy = (t.y ?? 0) - (s.y ?? 0)
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          return (s.x ?? 0) + dx / dist * COLORS[s.role].r
        })
        .attr('y1', (d) => {
          const s = d.source as GraphNode
          const t = d.target as GraphNode
          const dx = (t.x ?? 0) - (s.x ?? 0)
          const dy = (t.y ?? 0) - (s.y ?? 0)
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          return (s.y ?? 0) + dy / dist * COLORS[s.role].r
        })
        .attr('x2', (d) => {
          const s = d.source as GraphNode
          const t = d.target as GraphNode
          const dx = (t.x ?? 0) - (s.x ?? 0)
          const dy = (t.y ?? 0) - (s.y ?? 0)
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          return (t.x ?? 0) - dx / dist * (COLORS[t.role].r + 8)
        })
        .attr('y2', (d) => {
          const s = d.source as GraphNode
          const t = d.target as GraphNode
          const dx = (t.x ?? 0) - (s.x ?? 0)
          const dy = (t.y ?? 0) - (s.y ?? 0)
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          return (t.y ?? 0) - dy / dist * (COLORS[t.role].r + 8)
        })

      nodeEl.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    return () => { simulation.stop() }
  }, [centerCI.id, dependencies, dependents, blastRadius, showBlastRadius, maxDepth, nodeSpread, navigate])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid #f3f4f6' }}>
        <input
          type="checkbox"
          id="showBlast"
          checked={showBlastRadius}
          onChange={e => setShowBlastRadius(e.target.checked)}
          style={{ cursor: 'pointer' }}
        />
        <label htmlFor="showBlast" style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer', userSelect: 'none' }}>
          Mostra blast radius
        </label>
        {showBlastRadius && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 16 }}>
            <label style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Profondità max</label>
            <select
              value={maxDepth}
              onChange={e => setMaxDepth(Number(e.target.value))}
              style={{ fontSize: 'var(--font-size-body)', padding: '2px 4px', borderRadius: 4, border: '1px solid #d1d5db', cursor: 'pointer' }}
            >
              {[1, 2, 3, 4, 5].map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 16 }}>
          <label style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Distanza</label>
          <input
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
      <svg key={`graph-${showBlastRadius}-${maxDepth}`} ref={svgRef} style={{ width: '100%', height: 600, display: 'block', backgroundColor: '#fafbfc', borderRadius: 8 }} />

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position:     'absolute',
          left:         tooltip.x,
          top:          tooltip.y,
          background:   '#ffffff',
          border:       '1px solid #e2e6f0',
          borderRadius: 6,
          padding:      '8px 12px',
          boxShadow:    '0 4px 16px rgba(0,0,0,0.10)',
          fontSize:     12,
          zIndex:       100,
          pointerEvents: 'none',
          whiteSpace:   'nowrap',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 4 }}>{tooltip.node.name}</div>
          <div style={{ color: 'var(--color-slate)' }}>Type: <span style={{ color: 'var(--color-slate-dark)' }}>{tooltip.node.type.replace(/_/g, ' ')}</span></div>
          <div style={{ color: 'var(--color-slate)' }}>Status: <span style={{ color: 'var(--color-slate-dark)' }}>{tooltip.node.status}</span></div>
          {tooltip.node.environment && (
            <div style={{ color: 'var(--color-slate)' }}>Env: <span style={{ color: 'var(--color-slate-dark)' }}>{tooltip.node.environment}</span></div>
          )}
        </div>
      )}

      {/* Legend */}
      <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[
          { color: 'var(--color-brand)', label: 'Dipendenze (questo CI dipende da)' },
          { color: 'var(--color-trigger-automatic)', label: 'Dipendenti (dipendono da questo CI)' },
          { color: 'var(--color-trigger-timer)', label: 'Blast radius (impatto indiretto)' },
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
