import { useEffect, useRef, useMemo } from 'react'
import * as d3 from 'd3'

// ── Types ───────────────────────────────────────────────────────────────────

export interface TopologyNode {
  id:            string
  name:          string
  type:          string
  status:        string
  environment:   string | null
  ownerGroup:    string | null
  incidentCount: number
  changeCount:   number
}

export interface TopologyEdge {
  source: string
  target: string
  type:   string
}

interface Props {
  nodes:            TopologyNode[]
  edges:            TopologyEdge[]
  onNodeClick:      (node: TopologyNode) => void
  showLabels:       boolean
  highlightNodeId?: string | null
  rootNodeId?:      string | null
}

// ── Look-up tables ───────────────────────────────────────────────────────────

const NODE_RADIUS: Record<string, number> = {
  server: 18, application: 14, database: 14, database_instance: 12,
  databaseinstance: 12, ssl_certificate: 10, sslcertificate: 10,
  certificate: 10, virtual_machine: 14, network_device: 13,
  storage: 12, cloud_service: 13, api_endpoint: 12, microservice: 14,
}
const NODE_COLOR: Record<string, string> = {
  server: '#64748b', application: '#0284c7', database: '#059669',
  database_instance: '#059669', databaseinstance: '#059669',
  ssl_certificate: '#d97706', sslcertificate: '#d97706', certificate: '#d97706',
  virtual_machine: '#7c3aed', network_device: '#0891b2', storage: '#94a3b8',
  cloud_service: '#0891b2', api_endpoint: '#0891b2', microservice: '#0284c7',
}
const EDGE_COLOR: Record<string, string> = {
  DEPENDS_ON: '#0284c7', HOSTED_ON: '#64748b', CONNECTS_TO: '#94a3b8',
  RUNS_ON: '#64748b', USES: '#0284c7', CONTAINS: '#059669',
}
const EDGE_DIST: Record<string, number> = {
  HOSTED_ON: 80, DEPENDS_ON: 120, CONNECTS_TO: 100,
}

const r   = (t: string) => NODE_RADIUS[t.toLowerCase()] ?? 13
const nc  = (t: string) => NODE_COLOR[t.toLowerCase()]  ?? '#94a3b8'
const ec  = (t: string) => EDGE_COLOR[t]                ?? '#94a3b8'
const ed  = (t: string) => EDGE_DIST[t]                 ?? 110
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nid = (x: any)   => typeof x === 'object' ? (x as { id: string }).id : String(x)

// ── Pulse CSS (injected once) ────────────────────────────────────────────────

function ensurePulseStyle() {
  if (document.getElementById('topo-pulse-style')) return
  const s = document.createElement('style')
  s.id = 'topo-pulse-style'
  s.textContent = `
    @keyframes topo-pulse { 0%,100%{opacity:.9} 50%{opacity:.3} }
    .topo-pulse-incident { animation: topo-pulse 1.4s ease-in-out infinite }
    .topo-pulse-change   { animation: topo-pulse 2s   ease-in-out infinite }
  `
  document.head.appendChild(s)
}

// ── D3 sim types ─────────────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum, TopologyNode {}
interface SimLink extends d3.SimulationLinkDatum<SimNode> { relType: string }

// ── Component ───────────────────────────────────────────────────────────────

export default function TopologyGraph({
  nodes, edges, onNodeClick, showLabels, highlightNodeId, rootNodeId,
}: Props) {

  // Container div — D3 creates/destroys the <svg> inside it
  const containerRef = useRef<HTMLDivElement>(null)
  const simRef       = useRef<d3.Simulation<SimNode, SimLink> | null>(null)

  // Selections shared with the lightweight highlight effect
  type NodeSel = d3.Selection<SVGGElement,    SimNode, SVGGElement, unknown>
  type LinkSel = d3.Selection<SVGLineElement,  SimLink, SVGGElement, unknown>
  const nodeElRef = useRef<NodeSel | null>(null)
  const linkElRef = useRef<LinkSel | null>(null)

  // Single stable dep — fires only when real graph data changes
  const snap = useMemo(
    () => ({ nodes, edges, showLabels, rootNodeId, onNodeClick }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, edges, showLabels, rootNodeId, onNodeClick],
  )

  // ── Graph build effect ────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // ── STEP 1: destroy everything that existed before ────────────────────
    if (simRef.current) {
      simRef.current.stop()
      simRef.current = null
    }
    // Physically remove all child nodes (including any previous <svg>)
    while (container.firstChild) {
      container.removeChild(container.firstChild)
    }
    nodeElRef.current = null
    linkElRef.current = null

    const { nodes, edges, showLabels, rootNodeId, onNodeClick } = snap
    if (nodes.length === 0) return

    ensurePulseStyle()

    // ── STEP 2: create a brand-new <svg> from scratch ─────────────────────
    const W = container.clientWidth  || 1000
    const H = container.clientHeight || 600

    const svg = d3.select(container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .style('display', 'block')

    // Arrow markers
    const defs = svg.append('defs')
    const edgeTypes = Array.from(new Set(edges.map((e) => e.type)))
    edgeTypes.forEach((et) => {
      defs.append('marker')
        .attr('id', `arrow-${et}`)
        .attr('viewBox', '0 -5 10 10').attr('refX', 28).attr('refY', 0)
        .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
        .append('path').attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', ec(et)).attr('opacity', 0.6)
    })

    // Single <g> — zoom target
    const g = svg.append('g').attr('class', 'topo-root')

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 4])
      .on('zoom', (e: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr('transform', e.transform as unknown as string)
        g.selectAll<SVGTextElement, SimNode>('.node-label')
          .style('display', (showLabels || e.transform.k > 0.8) ? 'block' : 'none')
      })
    svg.call(zoom)

    svg.on('dblclick.zoom', () =>
      svg.transition().duration(600).call(
        zoom.transform,
        d3.zoomIdentity.translate(W / 2, H / 2).scale(0.85).translate(-W / 2, -H / 2),
      ),
    )

    // ── Sim data ──────────────────────────────────────────────────────────
    const nodeIds    = new Set(nodes.map((n) => n.id))
    const validEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))

    const simNodes: SimNode[] = nodes.map((n) => ({ ...n }))
    const nodeById = new Map(simNodes.map((n) => [n.id, n]))

    if (rootNodeId) {
      const root = nodeById.get(rootNodeId)
      if (root) { root.fx = W / 2; root.fy = H / 2 }
    }

    const simLinks: SimLink[] = validEdges.map((e) => ({
      source: e.source, target: e.target, relType: e.type,
    }))

    // ── Simulation ────────────────────────────────────────────────────────
    const sim = d3.forceSimulation<SimNode>(simNodes)
      .force('link',
        d3.forceLink<SimNode, SimLink>(simLinks)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .id((d: any) => d.id)
          .distance((d) => ed(d.relType))
          .strength(0.5),
      )
      .force('charge',    d3.forceManyBody<SimNode>().strength(-300))
      .force('center',    d3.forceCenter(W / 2, H / 2))
      .force('collision', d3.forceCollide<SimNode>((d) => r(d.type) + 8))
      .alphaDecay(0.02)
    simRef.current = sim

    // ── Edges ─────────────────────────────────────────────────────────────
    const linkEl = g.append('g').attr('class', 'links')
      .selectAll<SVGLineElement, SimLink>('line')
      .data(simLinks).enter().append('line')
      .attr('stroke',         (d) => ec(d.relType))
      .attr('stroke-opacity', 0.5)
      .attr('stroke-width',   1.5)
      .attr('marker-end',     (d) => `url(#arrow-${d.relType})`)
      .style('cursor', 'pointer')

    const edgeLabelEl = g.append('g').attr('class', 'edge-labels')
      .selectAll<SVGTextElement, SimLink>('text')
      .data(simLinks).enter().append('text')
      .attr('text-anchor', 'middle').attr('font-size', 9)
      .attr('font-family', "'Plus Jakarta Sans', system-ui, sans-serif")
      .attr('fill', 'var(--color-slate-light)').attr('pointer-events', 'none')
      .style('display', 'none')
      .text((d) => d.relType.replace(/_/g, ' '))

    // ── Nodes ─────────────────────────────────────────────────────────────
    const nodeEl = g.append('g').attr('class', 'nodes')
      .selectAll<SVGGElement, SimNode>('g')
      .data(simNodes).enter().append('g')
      .attr('cursor', 'pointer')

    // Store for highlight effect
    linkElRef.current = linkEl as unknown as LinkSel
    nodeElRef.current = nodeEl

    nodeEl.append('circle')
      .attr('r',      (d) => d.id === rootNodeId ? r(d.type) + 4 : r(d.type))
      .attr('fill',   (d) => d.id === rootNodeId ? '#f97316'
                           : d.status === 'inactive' ? '#e5e7eb' : nc(d.type))
      .attr('stroke', (d) => {
        if (d.id === rootNodeId) return '#ea580c'
        const c = nc(d.type)
        return d3.color(c)?.darker(0.5)?.toString() ?? c
      })
      .attr('stroke-width', (d) => d.id === rootNodeId ? 3 : 1.5)
      .attr('opacity',      (d) => d.status === 'maintenance' ? 0.65 : 1)
      .attr('filter',       (d) =>
        d.id === rootNodeId ? 'drop-shadow(0 3px 10px rgba(0,0,0,.25))' : null)

    if (rootNodeId) {
      nodeEl.filter((d) => d.id === rootNodeId).append('text')
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'hanging')
        .attr('y', (d) => r(d.type) * 1.6 + 5)
        .attr('font-size', 11).attr('font-weight', 700)
        .attr('font-family', "'Plus Jakarta Sans', system-ui, sans-serif")
        .attr('fill', 'var(--color-slate-dark)').attr('pointer-events', 'none')
        .text((d) => d.name)
    }

    nodeEl.filter((d) => d.incidentCount > 0).append('circle')
      .attr('class', 'topo-pulse-incident')
      .attr('r', (d) => r(d.type) + 5).attr('fill', 'none')
      .attr('stroke', '#dc2626').attr('stroke-width', 2).attr('pointer-events', 'none')

    nodeEl.filter((d) => d.changeCount > 0 && d.incidentCount === 0).append('circle')
      .attr('class', 'topo-pulse-change')
      .attr('r', (d) => r(d.type) + 5).attr('fill', 'none')
      .attr('stroke', '#f97316').attr('stroke-width', 1.5).attr('pointer-events', 'none')

    nodeEl.append('text')
      .attr('class', 'node-label')
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'hanging')
      .attr('y', (d) => r(d.type) + 4).attr('font-size', 10)
      .attr('font-family', "'Plus Jakarta Sans', system-ui, sans-serif")
      .attr('fill', 'var(--color-slate)').attr('pointer-events', 'none')
      .style('display', showLabels ? 'block' : 'none')
      .text((d) => d.name.length > 12 ? d.name.slice(0, 11) + '…' : d.name)

    // ── Interactions ──────────────────────────────────────────────────────
    linkEl
      .on('mouseover', function(_e, d) {
        d3.select(this).attr('stroke-opacity', 0.9).attr('stroke-width', 2)
        edgeLabelEl.filter((ld) => ld === d).style('display', 'block')
        nodeEl.style('opacity', (n) =>
          n.id === nid(d.source) || n.id === nid(d.target) ? 1 : 0.2)
      })
      .on('mouseout', function(_e, d) {
        d3.select(this).attr('stroke-opacity', 0.5).attr('stroke-width', 1.5)
        edgeLabelEl.filter((ld) => ld === d).style('display', 'none')
        nodeEl.style('opacity', 1)
      })

    nodeEl
      .on('click', (_e, d) => onNodeClick(d))
      .on('mouseover', function(_e, d) {
        d3.select(this).select('circle').transition().duration(120)
          .attr('r', r(d.type) * 1.3)
        const conn = new Set<string>([d.id])
        simLinks.forEach((l) => {
          if (nid(l.source) === d.id) conn.add(nid(l.target))
          if (nid(l.target) === d.id) conn.add(nid(l.source))
        })
        nodeEl.style('opacity', (n) => conn.has(n.id) ? 1 : 0.1)
        linkEl
          .attr('stroke-opacity', (l) =>
            nid(l.source) === d.id || nid(l.target) === d.id ? 0.8 : 0.05)
          .attr('stroke-width', (l) =>
            nid(l.source) === d.id || nid(l.target) === d.id ? 2 : 1)
      })
      .on('mouseout', function(_e, d) {
        d3.select(this).select('circle').transition().duration(120)
          .attr('r', d.id === rootNodeId ? r(d.type) + 4 : r(d.type))
        nodeEl.style('opacity', 1)
        linkEl.attr('stroke-opacity', 0.5).attr('stroke-width', 1.5)
      })

    nodeEl.call(
      d3.drag<SVGGElement, SimNode>()
        .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
        .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y })
        .on('end',   (e, _d) => { if (!e.active) sim.alphaTarget(0) }),
    )
    nodeEl.on('dblclick.drag', (_e, d) => {
      if (d.id !== rootNodeId) { d.fx = null; d.fy = null }
    })

    // ── Tick ──────────────────────────────────────────────────────────────
    sim.on('tick', () => {
      linkEl
        .attr('x1', (d) => typeof d.source === 'object' ? ((d.source as SimNode).x ?? 0) : 0)
        .attr('y1', (d) => typeof d.source === 'object' ? ((d.source as SimNode).y ?? 0) : 0)
        .attr('x2', (d) => typeof d.target === 'object' ? ((d.target as SimNode).x ?? 0) : 0)
        .attr('y2', (d) => typeof d.target === 'object' ? ((d.target as SimNode).y ?? 0) : 0)
      edgeLabelEl
        .attr('x', (d) => typeof d.source === 'object' && typeof d.target === 'object'
          ? (((d.source as SimNode).x ?? 0) + ((d.target as SimNode).x ?? 0)) / 2 : 0)
        .attr('y', (d) => typeof d.source === 'object' && typeof d.target === 'object'
          ? (((d.source as SimNode).y ?? 0) + ((d.target as SimNode).y ?? 0)) / 2 - 4 : 0)
      nodeEl.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    sim.on('end', () => {
      const w = container.clientWidth  || W
      const h = container.clientHeight || H
      svg.transition().duration(500).call(
        zoom.transform,
        d3.zoomIdentity.translate(w / 2, h / 2).scale(0.85).translate(-w / 2, -h / 2),
      )
    })

    // ── STEP 3: cleanup — physically remove the <svg> from the DOM ────────
    return () => {
      if (simRef.current) {
        simRef.current.stop()
        simRef.current = null
      }
      while (container.firstChild) {
        container.removeChild(container.firstChild)
      }
      nodeElRef.current = null
      linkElRef.current = null
    }
  }, [snap])   // ← single stable dep

  // ── Highlight effect (no rebuild, just style tweaks) ──────────────────────
  useEffect(() => {
    const nodeEl = nodeElRef.current
    const linkEl = linkElRef.current
    if (!nodeEl || !linkEl) return

    if (!highlightNodeId) {
      nodeEl.style('opacity', 1)
      nodeEl.select('circle:first-child').attr('stroke-width', 1.5)
      linkEl.attr('stroke-opacity', 0.5).attr('stroke-width', 1.5)
      return
    }

    if (highlightNodeId === rootNodeId) {
      nodeEl.style('opacity', 1)
      linkEl.attr('stroke-opacity', 0.5).attr('stroke-width', 1.5)
      return
    }

    const connected = new Set<string>([highlightNodeId])
    linkEl.each((l) => {
      const s = nid(l.source), t = nid(l.target)
      if (s === highlightNodeId) connected.add(t)
      if (t === highlightNodeId) connected.add(s)
    })

    nodeEl.style('opacity', (n) => connected.has(n.id) ? 1 : 0.08)
    nodeEl.select('circle:first-child')
      .attr('stroke-width', (n) => n.id === highlightNodeId ? 4 : 1.5)
      .attr('r',            (n) => n.id === highlightNodeId ? r(n.type) * 1.5 : r(n.type))
    linkEl
      .attr('stroke-opacity', (l) =>
        nid(l.source) === highlightNodeId || nid(l.target) === highlightNodeId ? 0.85 : 0.06)
      .attr('stroke-width', (l) =>
        nid(l.source) === highlightNodeId || nid(l.target) === highlightNodeId ? 2.5 : 1)
  }, [highlightNodeId, rootNodeId])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', overflow: 'hidden' }}
    />
  )
}

// ── Legend ──────────────────────────────────────────────────────────────────

export function TopologyLegend() {
  const nodeTypes = [
    { type: 'server',            label: 'Server' },
    { type: 'application',       label: 'Application' },
    { type: 'database',          label: 'Database' },
    { type: 'database_instance', label: 'DB Instance' },
    { type: 'ssl_certificate',   label: 'Certificate' },
    { type: 'virtual_machine',   label: 'VM' },
    { type: 'cloud_service',     label: 'Cloud Service' },
  ]
  const edgeTypes = [
    { type: 'DEPENDS_ON',  label: 'Depends On' },
    { type: 'HOSTED_ON',   label: 'Hosted On' },
    { type: 'CONNECTS_TO', label: 'Connects To' },
    { type: 'USES',        label: 'Uses' },
  ]

  return (
    <div style={{
      position: 'absolute', bottom: 16, left: 16,
      background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)',
      border: '1px solid #e2e8f0', borderRadius: 8,
      padding: '10px 14px', fontSize: 11,
      fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      boxShadow: '0 2px 8px rgba(0,0,0,0.08)', minWidth: 190,
    }}>
      <div style={{ fontWeight: 700, color: 'var(--color-slate-dark)', marginBottom: 8 }}>Legenda</div>

      <div style={{ marginBottom: 6 }}>
        <div style={{ color: 'var(--color-slate-light)', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>NODI</div>
        {nodeTypes.map(({ type, label }) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <svg width={16} height={16}><circle cx={8} cy={8} r={6} fill={nc(type)} /></svg>
            <span style={{ color: 'var(--color-slate)' }}>{label}</span>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 6 }}>
        <div style={{ color: 'var(--color-slate-light)', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>RELAZIONI</div>
        {edgeTypes.map(({ type, label }) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <svg width={20} height={8}>
              <line x1={0} y1={4} x2={20} y2={4} stroke={ec(type)} strokeWidth={2} strokeOpacity={0.7} />
            </svg>
            <span style={{ color: 'var(--color-slate)' }}>{label}</span>
          </div>
        ))}
      </div>

      <div>
        <div style={{ color: 'var(--color-slate-light)', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>SEGNALI</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <svg width={16} height={16}><circle cx={8} cy={8} r={5} fill="none" stroke="#dc2626" strokeWidth={2} /></svg>
          <span style={{ color: 'var(--color-slate)' }}>Incident attivo</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width={16} height={16}><circle cx={8} cy={8} r={5} fill="none" stroke="#f97316" strokeWidth={1.5} /></svg>
          <span style={{ color: 'var(--color-slate)' }}>Change in corso</span>
        </div>
      </div>
    </div>
  )
}
