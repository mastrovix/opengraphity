import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as d3 from 'd3'

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

interface Props {
  centerCI:     CINode
  dependencies: CIRelationInput[]
  dependents:   CIRelationInput[]
  blastRadius:  CINode[]
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
  center:     { fill: '#4f46e5', stroke: '#ffffff', r: 28 },
  dependency: { fill: '#ffffff', stroke: '#4f46e5', r: 22 },
  dependent:  { fill: '#ffffff', stroke: '#059669', r: 22 },
  blast:      { fill: '#ffffff', stroke: '#d97706', r: 18 },
}

const LINK_STYLE: Record<string, { stroke: string; opacity: number; dash?: string }> = {
  dependency: { stroke: '#4f46e5', opacity: 0.6 },
  dependent:  { stroke: '#059669', opacity: 0.6 },
  blast:      { stroke: '#d97706', opacity: 0.4, dash: '4' },
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

    const depIds = new Set([
      ...dependencies.map((r) => r.ci.id),
      ...dependents.map((r) => r.ci.id),
    ])
    blastRadius
      .filter((ci) => !depIds.has(ci.id) && ci.id !== centerCI.id)
      .forEach((ci) => addNode(ci, 'blast'))

    const nodes: GraphNode[] = Array.from(nodeMap.values())

    const links: GraphLink[] = [
      ...dependencies.map((r) => ({
        source:       r.ci.id,
        target:       centerCI.id,
        relationType: r.relationType,
        role:         'dependency' as const,
      })),
      ...dependents.map((r) => ({
        source:       centerCI.id,
        target:       r.ci.id,
        relationType: r.relationType,
        role:         'dependent' as const,
      })),
      ...blastRadius
        .filter((ci) => !depIds.has(ci.id) && ci.id !== centerCI.id)
        .map((ci) => ({
          source:       centerCI.id,
          target:       ci.id,
          relationType: 'blast_radius',
          role:         'blast' as const,
        })),
    ]

    // ── SVG setup ───────────────────────────────────────────────────────────

    const root = svg
      .attr('width',  '100%')
      .attr('height', height)

    // Arrow markers
    const defs = root.append('defs')
    const markerDefs: Array<{ id: string; color: string }> = [
      { id: 'arrow-dependency', color: '#4f46e5' },
      { id: 'arrow-dependent',  color: '#059669' },
      { id: 'arrow-blast',      color: '#d97706' },
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
      .force('link',    d3.forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance(200))
      .force('charge',  d3.forceManyBody().strength(-600))
      .force('center',  d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide(70))

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
        if (d.role !== 'center') navigate(`/cmdb/${d.id}`)
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
      .text((d) => TYPE_ICON[d.type] ?? '📄')

    // Name label (row 1)
    nodeEl.append('text')
      .attr('text-anchor',       'middle')
      .attr('dominant-baseline', 'hanging')
      .attr('y',                 (d) => COLORS[d.role].r + 14)
      .attr('font-size',         11)
      .attr('font-weight',       600)
      .attr('fill',              '#0f1629')
      .text((d) => d.name.length > 14 ? d.name.slice(0, 13) + '…' : d.name)

    // Type label (row 2)
    nodeEl.append('text')
      .attr('text-anchor',       'middle')
      .attr('dominant-baseline', 'hanging')
      .attr('y',                 (d) => COLORS[d.role].r + 25)
      .attr('font-size',         10)
      .attr('fill',              '#8892a4')
      .text((d) => d.type.replace(/_/g, ' '))

    // Relation type label (row 3 — only for non-center nodes)
    nodeEl.filter((d) => d.role !== 'center' && d.relationType !== null)
      .append('text')
      .attr('text-anchor',       'middle')
      .attr('dominant-baseline', 'hanging')
      .attr('y',                 (d) => COLORS[d.role].r + 35)
      .attr('font-size',         9)
      .attr('font-family',       'DM Mono, monospace')
      .attr('fill',              '#4f46e5')
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
  }, [centerCI.id, dependencies, dependents, blastRadius, navigate])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <svg ref={svgRef} style={{ width: '100%', height: 600, display: 'block', backgroundColor: '#fafbfc', borderRadius: 8 }} />

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
          <div style={{ fontWeight: 600, color: '#0f1629', marginBottom: 4 }}>{tooltip.node.name}</div>
          <div style={{ color: '#4a5468' }}>Type: <span style={{ color: '#0f1629' }}>{tooltip.node.type.replace(/_/g, ' ')}</span></div>
          <div style={{ color: '#4a5468' }}>Status: <span style={{ color: '#0f1629' }}>{tooltip.node.status}</span></div>
          {tooltip.node.environment && (
            <div style={{ color: '#4a5468' }}>Env: <span style={{ color: '#0f1629' }}>{tooltip.node.environment}</span></div>
          )}
        </div>
      )}

      {/* Legend */}
      <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[
          { color: '#4f46e5', label: 'Dipendenze (questo CI dipende da)' },
          { color: '#059669', label: 'Dipendenti (dipendono da questo CI)' },
          { color: '#d97706', label: 'Blast radius (impatto indiretto)' },
        ].map(({ color, label }) => (
          <div key={color} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#4a5468' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color, flexShrink: 0, display: 'inline-block' }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  )
}
