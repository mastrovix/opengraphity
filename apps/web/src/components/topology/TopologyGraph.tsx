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

export interface CITypeMeta {
  name:  string
  label: string
  icon:  string
  color: string
}

interface Props {
  nodes:            TopologyNode[]
  edges:            TopologyEdge[]
  onNodeClick:      (node: TopologyNode) => void
  showLabels:       boolean
  highlightNodeId?: string | null
  rootNodeId?:      string | null
  ciTypes?:         CITypeMeta[]
}

// ── Color constants ───────────────────────────────────────────────────────────

const NODE_RADIUS  = 16
const NODE_COLOR   = '#64748b'   // ardesia — uguale per tutti i tipi CI
const EDGE_COLOR   = '#0284c7'   // cyan — uguale per tutti i tipi relazione
const NODE_SELECTED_COLOR = '#f97316'  // arancione — nodo evidenziato

const EDGE_DIST: Record<string, number> = {
  HOSTED_ON: 80, DEPENDS_ON: 120, CONNECTS_TO: 100,
}

// ── Lucide icon node data (raw SVG primitives from lucide-react v0.577) ───────
// Each entry: [tagName, {attribute: value, ...}]

type IconNode = [string, Record<string, string>]
const ICON_NODES: Record<string, IconNode[]> = {
  box: [
    ['path', { d: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z' }],
    ['path', { d: 'm3.3 7 8.7 5 8.7-5' }],
    ['path', { d: 'M12 22V12' }],
  ],
  database: [
    ['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }],
    ['path', { d: 'M3 5V19A9 3 0 0 0 21 19V5' }],
    ['path', { d: 'M3 12A9 3 0 0 0 21 12' }],
  ],
  server: [
    ['rect', { width: '20', height: '8', x: '2', y: '2', rx: '2', ry: '2' }],
    ['rect', { width: '20', height: '8', x: '2', y: '14', rx: '2', ry: '2' }],
    ['line', { x1: '6', x2: '6.01', y1: '6', y2: '6' }],
    ['line', { x1: '6', x2: '6.01', y1: '18', y2: '18' }],
  ],
  shield: [
    ['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }],
  ],
  'hard-drive': [
    ['path', { d: 'M10 16h.01' }],
    ['path', { d: 'M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }],
    ['path', { d: 'M21.946 12.013H2.054' }],
    ['path', { d: 'M6 16h.01' }],
  ],
  cloud: [
    ['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }],
  ],
  globe: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }],
    ['path', { d: 'M2 12h20' }],
  ],
  cpu: [
    ['path', { d: 'M12 20v2' }], ['path', { d: 'M12 2v2' }],
    ['path', { d: 'M17 20v2' }], ['path', { d: 'M17 2v2' }],
    ['path', { d: 'M2 12h2' }],  ['path', { d: 'M2 17h2' }], ['path', { d: 'M2 7h2' }],
    ['path', { d: 'M20 12h2' }], ['path', { d: 'M20 17h2' }], ['path', { d: 'M20 7h2' }],
    ['path', { d: 'M7 20v2' }],  ['path', { d: 'M7 2v2' }],
    ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }],
    ['rect', { x: '8', y: '8', width: '8', height: '8', rx: '1' }],
  ],
  network: [
    ['rect', { x: '16', y: '16', width: '6', height: '6', rx: '1' }],
    ['rect', { x: '2', y: '16', width: '6', height: '6', rx: '1' }],
    ['rect', { x: '9', y: '2', width: '6', height: '6', rx: '1' }],
    ['path', { d: 'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3' }],
    ['path', { d: 'M12 12V8' }],
  ],
  monitor: [
    ['rect', { width: '20', height: '14', x: '2', y: '3', rx: '2' }],
    ['line', { x1: '8', x2: '16', y1: '21', y2: '21' }],
    ['line', { x1: '12', x2: '12', y1: '17', y2: '21' }],
  ],
  lock: [
    ['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }],
    ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }],
  ],
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Normalize CI type name for comparison: "DatabaseInstance" → "databaseinstance"
function normalize(s: string): string {
  return s.toLowerCase().replace(/[_\s]/g, '')
}

const r   = NODE_RADIUS
const ec  = () => EDGE_COLOR
const ed  = (t: string) => EDGE_DIST[t] ?? 110
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nid = (x: any)   => typeof x === 'object' ? (x as { id: string }).id : String(x)

// Appends lucide icon SVG elements to a D3 g selection, centered at (0,0).
// Icon is scaled from 24×24 to `size`×`size` px.
function appendLucideIcon(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sel: d3.Selection<SVGGElement, any, any, any>,
  iconKey: string,
  color: string,
  size = 18,
): void {
  const nodes = ICON_NODES[iconKey] ?? ICON_NODES['box']!
  const scale  = size / 24
  const offset = -(size / 2)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = (sel as any).append('g')
    .attr('class', 'node-icon')
    .attr('transform', `translate(${offset},${offset}) scale(${scale})`)
    .attr('pointer-events', 'none')
  for (const [tag, attrs] of nodes) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = (g as any).append(tag)
    for (const [k, v] of Object.entries(attrs)) { el.attr(k, v) }
    el.attr('fill', 'none')
      .attr('stroke', color)
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
  }
}

// ── Pulse CSS (injected once) ─────────────────────────────────────────────────

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

// ── D3 sim types ──────────────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum, TopologyNode {}
interface SimLink extends d3.SimulationLinkDatum<SimNode> { relType: string }

// ── Component ─────────────────────────────────────────────────────────────────

export default function TopologyGraph({
  nodes, edges, onNodeClick, showLabels, highlightNodeId, rootNodeId, ciTypes,
}: Props) {

  const containerRef = useRef<HTMLDivElement>(null)
  const simRef       = useRef<d3.Simulation<SimNode, SimLink> | null>(null)

  type NodeSel = d3.Selection<SVGGElement,    SimNode, SVGGElement, unknown>
  type LinkSel = d3.Selection<SVGLineElement,  SimLink, SVGGElement, unknown>
  const nodeElRef = useRef<NodeSel | null>(null)
  const linkElRef = useRef<LinkSel | null>(null)

  const snap = useMemo(
    () => ({ nodes, edges, showLabels, rootNodeId, onNodeClick, ciTypes }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, edges, showLabels, rootNodeId, onNodeClick, ciTypes],
  )

  // ── Graph build effect ─────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (simRef.current) { simRef.current.stop(); simRef.current = null }
    while (container.firstChild) { container.removeChild(container.firstChild) }
    nodeElRef.current = null
    linkElRef.current = null

    const { nodes, edges, showLabels, rootNodeId, onNodeClick, ciTypes } = snap
    if (nodes.length === 0) return

    // Build ciType icon lookup from prop (color is uniform — only icon varies)
    const ciIconMap = new Map<string, string>()
    for (const ct of (ciTypes ?? [])) {
      ciIconMap.set(normalize(ct.name), ct.icon)
    }
    const nodeIconKey = (type: string) => ciIconMap.get(normalize(type)) ?? 'box'

    ensurePulseStyle()

    const W = container.clientWidth  || 1000
    const H = container.clientHeight || 600

    const svg = d3.select(container)
      .append('svg')
      .attr('width', '100%').attr('height', '100%').style('display', 'block')

    // Arrow markers
    const defs = svg.append('defs')
    const edgeTypes = Array.from(new Set(edges.map((e) => e.type)))
    edgeTypes.forEach((et) => {
      defs.append('marker')
        .attr('id', `arrow-${et}`)
        .attr('viewBox', '0 -5 10 10').attr('refX', 10).attr('refY', 0)
        .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
        .append('path').attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', ec()).attr('opacity', 0.6)
    })

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

    // ── Sim data ────────────────────────────────────────────────────────────
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

    // ── Simulation ──────────────────────────────────────────────────────────
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
      .force('collision', d3.forceCollide<SimNode>(() => r + 8))
      .alphaDecay(0.02)
    simRef.current = sim

    // ── Edges ───────────────────────────────────────────────────────────────
    const linkEl = g.append('g').attr('class', 'links')
      .selectAll<SVGLineElement, SimLink>('line')
      .data(simLinks).enter().append('line')
      .attr('stroke',         ec())
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

    // ── Nodes ────────────────────────────────────────────────────────────────
    const nodeEl = g.append('g').attr('class', 'nodes')
      .selectAll<SVGGElement, SimNode>('g')
      .data(simNodes).enter().append('g')
      .attr('cursor', 'pointer')

    linkElRef.current = linkEl as unknown as LinkSel
    nodeElRef.current = nodeEl

    // Layer 1 (outermost): incident ring — r+6, always on top of everything
    nodeEl.filter((d) => d.incidentCount > 0).append('circle')
      .attr('class', 'topo-pulse-incident')
      .attr('r', r + 6).attr('fill', 'none')
      .attr('stroke', '#dc2626').attr('stroke-width', 2).attr('pointer-events', 'none')

    // Layer 2: change ring — r+4
    nodeEl.filter((d) => d.changeCount > 0).append('circle')
      .attr('class', 'topo-pulse-change')
      .attr('r', r + 4).attr('fill', 'none')
      .attr('stroke', '#0284c7').attr('stroke-width', 1.5).attr('pointer-events', 'none')

    // Layer 3: root selection ring — r+2
    nodeEl.filter((d) => d.id === rootNodeId).append('circle')
      .attr('r', r + 2).attr('fill', 'none')
      .attr('stroke', '#ea580c').attr('stroke-width', 2.5).attr('pointer-events', 'none')
      .attr('filter', 'drop-shadow(0 3px 10px rgba(0,0,0,.25))')

    // Layer 4 (innermost): white bg circle with slate border
    nodeEl.append('circle')
      .attr('class', 'node-bg')
      .attr('r', r)
      .attr('fill', '#ffffff')
      .attr('stroke', NODE_COLOR)
      .attr('stroke-width', 2.5)
      .attr('opacity', (d) => d.status === 'maintenance' ? 0.65 : 1)

    // Layer 5: lucide icon centered inside the node (always slate)
    nodeEl.each(function(d) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sel = d3.select(this) as any
      appendLucideIcon(sel, nodeIconKey(d.type), NODE_COLOR, 18)
    })

    if (rootNodeId) {
      nodeEl.filter((d) => d.id === rootNodeId).append('text')
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'hanging')
        .attr('y', r * 1.6 + 5)
        .attr('font-size', 11).attr('font-weight', 700)
        .attr('font-family', "'Plus Jakarta Sans', system-ui, sans-serif")
        .attr('fill', 'var(--color-slate-dark)').attr('pointer-events', 'none')
        .text((d) => d.name)
    }

    nodeEl.append('text')
      .attr('class', 'node-label')
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'hanging')
      .attr('y', r + 4).attr('font-size', 10)
      .attr('font-family', "'Plus Jakarta Sans', system-ui, sans-serif")
      .attr('fill', 'var(--color-slate)').attr('pointer-events', 'none')
      .style('display', showLabels ? 'block' : 'none')
      .text((d) => d.name.length > 12 ? d.name.slice(0, 11) + '…' : d.name)

    // ── Interactions ─────────────────────────────────────────────────────────
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
        d3.select(this).select<SVGCircleElement>('.node-bg').transition().duration(120)
          .attr('r', r * 1.3)
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
      .on('mouseout', function() {
        d3.select(this).select<SVGCircleElement>('.node-bg').transition().duration(120)
          .attr('r', r)
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

    // ── Tick ─────────────────────────────────────────────────────────────────
    function linkEndpoints(d: SimLink): { x1: number; y1: number; x2: number; y2: number } {
      if (typeof d.source !== 'object' || typeof d.target !== 'object')
        return { x1: 0, y1: 0, x2: 0, y2: 0 }
      const s = d.source as SimNode, t = d.target as SimNode
      const sx = s.x ?? 0, sy = s.y ?? 0, tx = t.x ?? 0, ty = t.y ?? 0
      const dx = tx - sx, dy = ty - sy
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist === 0) return { x1: sx, y1: sy, x2: tx, y2: ty }
      const sr = r + 2
      const tr = r + 2
      return {
        x1: sx + (dx / dist) * sr,
        y1: sy + (dy / dist) * sr,
        x2: tx - (dx / dist) * tr,
        y2: ty - (dy / dist) * tr,
      }
    }

    sim.on('tick', () => {
      linkEl.each(function(d) {
        const { x1, y1, x2, y2 } = linkEndpoints(d)
        d3.select(this).attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
      })
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

    return () => {
      if (simRef.current) { simRef.current.stop(); simRef.current = null }
      while (container.firstChild) { container.removeChild(container.firstChild) }
      nodeElRef.current = null
      linkElRef.current = null
    }
  }, [snap])

  // ── Highlight effect (no rebuild) ─────────────────────────────────────────
  useEffect(() => {
    const nodeEl = nodeElRef.current
    const linkEl = linkElRef.current
    if (!nodeEl || !linkEl) return

    if (!highlightNodeId) {
      nodeEl.style('opacity', 1)
      nodeEl.select<SVGCircleElement>('.node-bg')
        .attr('stroke-width', 2.5)
        .attr('stroke', NODE_COLOR)
        .attr('r', r)
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
    nodeEl.select<SVGCircleElement>('.node-bg')
      .attr('stroke-width', (n) => n.id === highlightNodeId ? 4 : 2.5)
      .attr('stroke', (n) => n.id === highlightNodeId ? NODE_SELECTED_COLOR : NODE_COLOR)
      .attr('r', (n) => n.id === highlightNodeId ? r * 1.5 : r)
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

// ── Legend ───────────────────────────────────────────────────────────────────

function typeLabel(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

interface LegendProps {
  nodes:    TopologyNode[]
  edges:    TopologyEdge[]
  ciTypes?: CITypeMeta[]
}

// Bare icon SVG for legend — just the lucide paths, no circle wrapper
function LegendIconSvg({ iconKey, color }: { iconKey: string; color: string }) {
  const nodes = ICON_NODES[iconKey] ?? ICON_NODES['box']!
  // 16×16 container, icon scaled from 24→14 and centered (offset = (16-14)/2 = 1)
  const size   = 14
  const scale  = size / 24
  const offset = (16 - size) / 2
  return (
    <svg width={16} height={16}>
      <g
        transform={`translate(${offset},${offset}) scale(${scale})`}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {nodes.map(([tag, attrs], i) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Tag = tag as any
          return <Tag key={i} {...attrs} />
        })}
      </g>
    </svg>
  )
}

export function TopologyLegend({ nodes, edges, ciTypes }: LegendProps) {
  const presentNodeTypes = [...new Set(nodes.map((n) => n.type))].sort()
  const presentEdgeTypes = [...new Set(edges.map((e) => e.type))].sort()

  // Icon lookup by CI type (color is uniform)
  const ciIconMap = new Map<string, string>()
  for (const ct of (ciTypes ?? [])) {
    ciIconMap.set(normalize(ct.name), ct.icon)
  }
  const nodeIconKey = (type: string) => ciIconMap.get(normalize(type)) ?? 'box'

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

      {presentNodeTypes.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ color: 'var(--color-slate-light)', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>NODI</div>
          {presentNodeTypes.map((type) => (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <LegendIconSvg iconKey={nodeIconKey(type)} color={NODE_COLOR} />
              <span style={{ color: 'var(--color-slate)' }}>{typeLabel(type)}</span>
            </div>
          ))}
        </div>
      )}

      {presentEdgeTypes.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ color: 'var(--color-slate-light)', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>RELAZIONI</div>
          {presentEdgeTypes.map((type) => (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <svg width={20} height={8}>
                <line x1={0} y1={4} x2={20} y2={4} stroke={EDGE_COLOR} strokeWidth={2} strokeOpacity={0.7} />
              </svg>
              <span style={{ color: 'var(--color-slate)' }}>{typeLabel(type)}</span>
            </div>
          ))}
        </div>
      )}

      <div>
        <div style={{ color: 'var(--color-slate-light)', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>SEGNALI</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <svg width={16} height={16}><circle cx={8} cy={8} r={5} fill="none" stroke="#dc2626" strokeWidth={2} /></svg>
          <span style={{ color: 'var(--color-slate)' }}>Incident attivo</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width={16} height={16}><circle cx={8} cy={8} r={5} fill="none" stroke="#0284c7" strokeWidth={1.5} /></svg>
          <span style={{ color: 'var(--color-slate)' }}>Change in corso</span>
        </div>
      </div>
    </div>
  )
}
