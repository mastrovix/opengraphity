import { useEffect, useRef, useMemo } from 'react'
import * as d3 from 'd3'
import { colors, palette } from '@/lib/tokens'
import { BROKEN_ICON_COLOR, buildTypeIconMap, iconKeyForType } from '@/lib/ciIconPaths'
import { humanizeValue } from '@opengraphity/web-core'
import { linkDistance, type CITypeRelations } from './relationDistance'
import { NODE_COLOR, EDGE_COLOR, HEALTH_COLOR } from './topologyStyle'
import {
  appendArrowMarker, appendIcon, attachZoom, linkEndpoints, nodeDrag, styleText, truncate,
} from '@/lib/d3/graphPrimitives'

// ── Types ───────────────────────────────────────────────────────────────────

export interface TopologyNode {
  id:            string
  name:          string
  type:          string
  /** Lo stato del ciclo di vita, dal Dizionario; null se il CI non ne ha uno. */
  status:        string | null
  /**
   * In manutenzione secondo la policy degli allarmi DEL CLIENTE (revisione del
   * 15 set 2026 · CM-11): prima si confrontava `status` col letterale
   * `maintenance`, e uno stato rinominato non si vedeva più attenuato.
   */
  inMaintenance: boolean
  environment:   string | null
  ownerGroup:    string | null
  incidentCount: number
  changeCount:   number
  /** Salute dal monitoraggio (operational | degraded | down); null = sconosciuta. */
  health:        string | null
}

export interface TopologyEdge {
  source: string
  target: string
  type:   string
}

export interface CITypeMeta extends CITypeRelations {
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
  /** Colora bordo e sfondo dei nodi dalla salute (down rosso, degraded ambra), con priorità sugli altri colori. */
  highlightHealth?: boolean
}

// ── Color constants ───────────────────────────────────────────────────────────

const NODE_RADIUS  = 16
const NODE_SELECTED_COLOR = palette.orange.base  // arancione — nodo evidenziato

/** Bordo del nodo: salute (se evidenziata) > anelli incident/change (bordo assente) > ardesia. */
function nodeStroke(d: TopologyNode, highlightHealth: boolean): string {
  const h = highlightHealth && d.health ? HEALTH_COLOR[d.health] : undefined
  if (h) return h.stroke
  return (d.incidentCount > 0 || d.changeCount > 0) ? 'none' : NODE_COLOR
}

/** Sfondo del nodo: root ciano, salute evidenziata (down/degraded) colorata, altrimenti bianco. */
function nodeFill(d: TopologyNode, rootNodeId: string | null | undefined, highlightHealth: boolean): string {
  const h = highlightHealth && d.health ? HEALTH_COLOR[d.health] : undefined
  if (h) return h.fill
  return d.id === rootNodeId ? EDGE_COLOR : colors.white
}

/** The border drawn: the selected CI is outlined in orange — never the root, which the whole map is about. */
function nodeOutline(d: TopologyNode, highlightNodeId: string | null | undefined, rootNodeId: string | null | undefined, highlightHealth: boolean): string {
  return d.id === highlightNodeId && highlightNodeId !== rootNodeId ? NODE_SELECTED_COLOR : nodeStroke(d, highlightHealth)
}

/** Icon colour, read off the background under it: white on the root's cyan, slate on white or on a health colour. */
function iconColor(d: TopologyNode, rootNodeId: string | null | undefined, highlightHealth: boolean): string {
  return nodeFill(d, rootNodeId, highlightHealth) === EDGE_COLOR ? colors.white : NODE_COLOR
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// Icone: registro unico in lib/ciIconPaths.ts (chiave = `ciType.icon` del metamodello).

const r   = NODE_RADIUS
const ec  = () => EDGE_COLOR
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nid = (x: any)   => typeof x === 'object' ? (x as { id: string }).id : String(x)

/** Etichetta del nodo: il root per intero, gli altri troncati. */
const nodeLabel = (d: TopologyNode, rootNodeId: string | null | undefined) =>
  d.id === rootNodeId ? d.name : truncate(d.name, 12)

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

/**
 * Anelli incident/change di ogni nodo, in base ai contatori del datum.
 * Rimuove gli anelli esistenti e li reinserisce come primi figli del gruppo
 * (sotto node-bg/icona/label) così l'ordine dei layer resta quello del build.
 */
function drawStatusRings(nodeEl: d3.Selection<SVGGElement, SimNode, SVGGElement, unknown>): void {
  nodeEl.selectAll('.topo-pulse-incident, .topo-pulse-change').remove()
  nodeEl.filter((d) => d.changeCount > 0).insert('circle', ':first-child')
    .attr('class', 'topo-pulse-change')
    .attr('r', r + 4).attr('fill', 'none')
    .attr('stroke', palette.purple.light).attr('stroke-width', 3).attr('pointer-events', 'none')
  nodeEl.filter((d) => d.incidentCount > 0).insert('circle', ':first-child')
    .attr('class', 'topo-pulse-incident')
    .attr('r', r + 6).attr('fill', 'none')
    .attr('stroke', 'var(--color-trigger-sla-breach)').attr('stroke-width', 3).attr('pointer-events', 'none')
}

/**
 * Repaints the icons in place when the background under them changes colour
 * without a redraw («highlight health», a poll). The red «?» of a type with no
 * icon in the metamodel keeps its colour: it reports a gap, not a state.
 */
function paintIcons(nodeEl: d3.Selection<SVGGElement, SimNode, SVGGElement, unknown>, rootNodeId: string | null | undefined, highlightHealth: boolean): void {
  nodeEl.each(function(d) {
    d3.select(this).selectAll<SVGElement, unknown>('.node-icon > *')
      .filter(function() { return this.getAttribute('stroke') !== BROKEN_ICON_COLOR })
      .attr('stroke', iconColor(d, rootNodeId, highlightHealth))
  })
}

/**
 * What a poll refreshes in place on a CI already on the map: everything but
 * `id` and `type`, which only a redraw changes. `satisfies` makes a new field
 * of TopologyNode a compile error until it is listed here — the comparison
 * written out by hand had left `inMaintenance` out.
 */
const REFRESHED_ON_POLL = {
  name: true, status: true, inMaintenance: true, environment: true, ownerGroup: true,
  incidentCount: true, changeCount: true, health: true,
} as const satisfies Record<Exclude<keyof TopologyNode, 'id' | 'type'>, true>

/** Copies one field of the poll onto the datum the drawing reads; true when it changed. */
function refreshField<K extends keyof TopologyNode>(d: TopologyNode, fresh: TopologyNode, key: K): boolean {
  if (d[key] === fresh[key]) return false
  d[key] = fresh[key]
  return true
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TopologyGraph({
  nodes, edges, onNodeClick, showLabels, highlightNodeId, rootNodeId, ciTypes, highlightHealth = false,
}: Props) {
  // Letto dagli effetti che non devono ricostruire il grafo quando cambia.
  const highlightHealthRef = useRef(highlightHealth)
  highlightHealthRef.current = highlightHealth
  const highlightNodeIdRef = useRef(highlightNodeId)
  highlightNodeIdRef.current = highlightNodeId

  const containerRef = useRef<HTMLDivElement>(null)
  const simRef       = useRef<d3.Simulation<SimNode, SimLink> | null>(null)

  type NodeSel = d3.Selection<SVGGElement,    SimNode, SVGGElement, unknown>
  type LinkSel = d3.Selection<SVGLineElement,  SimLink, SVGGElement, unknown>
  const nodeElRef = useRef<NodeSel | null>(null)
  const linkElRef = useRef<LinkSel | null>(null)

  // ── Diff strutturale (F-06) ────────────────────────────────────────────────
  // Il polling di GET_TOPOLOGY (30 s) produce array nuovi a ogni giro anche se
  // il grafo non è cambiato: prima ogni poll smontava SVG, simulazione, zoom e
  // posizioni trascinate. Ora la ricostruzione avviene SOLO se cambia la
  // struttura (insieme di id nodi + archi); a struttura invariata i nuovi
  // contatori/stati vengono applicati in place agli elementi esistenti.
  const structureKey = useMemo(() => {
    const ids = nodes.map((n) => n.id).sort().join('|')
    const es  = edges.map((e) => `${e.source}>${e.target}:${e.type}`).sort().join('|')
    return `${ids}#${es}`
  }, [nodes, edges])

  const snap = useMemo(
    () => ({ nodes, edges, showLabels, rootNodeId, onNodeClick, ciTypes }),
    // nodes/edges volutamente esclusi: entrano tramite structureKey (vedi sopra)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structureKey, showLabels, rootNodeId, onNodeClick, ciTypes],
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
    const typeIconMap = buildTypeIconMap(ciTypes ?? [])

    ensurePulseStyle()

    const W = container.clientWidth  || 1000
    const H = container.clientHeight || 600

    const svg = d3.select(container)
      .append('svg')
      .attr('width', '100%').attr('height', '100%').style('display', 'block')

    // Arrow markers
    const defs = svg.append('defs')
    const edgeTypes = Array.from(new Set(edges.map((e) => e.type)))
    edgeTypes.forEach((et) => appendArrowMarker(defs, `arrow-${et}`, ec(), { size: 5, opacity: 0.6 }))

    const g = svg.append('g').attr('class', 'topo-root')

    const zoom = attachZoom(svg, g, {
      scaleExtent: [0.05, 4],
      onZoom: (e) => {
        g.selectAll<SVGTextElement, SimNode>('.node-label')
          .style('display', (showLabels || e.transform.k > 0.8) ? 'block' : 'none')
      },
    })

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
          // D76: every relation type the metamodel declares has a distance; only undeclared ones are reported.
          .distance(linkDistance(ciTypes))
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

    const edgeLabelEl = styleText(g.append('g').attr('class', 'edge-labels')
      .selectAll<SVGTextElement, SimLink>('text')
      .data(simLinks).enter().append('text'))
      .attr('text-anchor', 'middle').attr('font-size', 9)
      .attr('fill', 'var(--color-slate-light)').attr('pointer-events', 'none')
      .style('display', 'none')
      .text((d) => humanizeValue(d.relType))

    // ── Nodes ────────────────────────────────────────────────────────────────
    const nodeEl = g.append('g').attr('class', 'nodes')
      .selectAll<SVGGElement, SimNode>('g')
      .data(simNodes).enter().append('g')
      .attr('cursor', 'pointer')

    linkElRef.current = linkEl as unknown as LinkSel
    nodeElRef.current = nodeEl

    // Layer 1-2: incident (r+6) / change (r+4) rings — ridisegnati anche
    // dall'effetto di aggiornamento in place quando cambiano i contatori.
    drawStatusRings(nodeEl)

    // Layer 3 (removed): root selection ring was #ea580c at r+2 — removed because
    // it was visually indistinguishable from the change ring and confused users.
    // The highlight effect (stroke NODE_SELECTED_COLOR on .node-bg) handles focus emphasis.

    // Layer 4 (innermost): root node = cyan fill; others = white fill
    nodeEl.append('circle')
      .attr('class', 'node-bg')
      .attr('r', r)
      .attr('fill', (d) => nodeFill(d, rootNodeId, highlightHealthRef.current))
      .attr('stroke', (d) => nodeStroke(d, highlightHealthRef.current))
      .attr('stroke-width', 2.5)
      .attr('opacity', (d) => d.inMaintenance ? 0.65 : 1)

    // Layer 5: icon — white on root node (cyan bg), slate on all others
    nodeEl.each(function(d) {
      appendIcon(d3.select(this), iconKeyForType(typeIconMap, d.type), iconColor(d, rootNodeId, highlightHealthRef.current), 18)
    })

    styleText(nodeEl.append('text'))
      .attr('class', 'node-label')
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'hanging')
      .attr('y', (d) => d.id === rootNodeId ? r * 1.6 + 5 : r + 4)
      .attr('font-size', (d) => d.id === rootNodeId ? 11 : 10)
      .attr('font-weight', (d) => d.id === rootNodeId ? 700 : 400)
      .attr('fill', (d) => d.id === rootNodeId ? 'var(--color-slate-dark)' : 'var(--color-slate)')
      .attr('pointer-events', 'none')
      .style('display', showLabels ? 'block' : 'none')
      .text((d) => nodeLabel(d, rootNodeId))

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

    // I nodi trascinati restano fissati (pinAfterDrag); dblclick li libera.
    nodeEl.call(nodeDrag(sim, { pinAfterDrag: true }))
    nodeEl.on('dblclick.drag', (_e, d) => {
      if (d.id !== rootNodeId) { d.fx = null; d.fy = null }
    })

    // ── Tick ─────────────────────────────────────────────────────────────────
    // Returns the outermost visible radius for a node (node + rings + gap)
    function outerRadius(n: SimNode): number {
      if (n.incidentCount > 0) return r + 6 + 3   // outside incident ring (r+6)
      if (n.changeCount   > 0) return r + 4 + 3   // outside change ring (r+4)
      return r + 2                                  // just outside node border
    }

    sim.on('tick', () => {
      linkEl.each(function(d) {
        if (typeof d.source !== 'object' || typeof d.target !== 'object') return
        const s = d.source as SimNode, t = d.target as SimNode
        const { x1, y1, x2, y2 } = linkEndpoints(s, t, outerRadius(s), outerRadius(t))
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

  // ── In-place update effect (no rebuild) ───────────────────────────────────
  // Stessa struttura, dati freschi dal polling: aggiorna i datum della
  // simulazione (gli stessi oggetti letti dal tick per il raggio esterno) e
  // ridisegna anelli, bordo e opacità. Zoom, posizioni e drag restano intatti.
  useEffect(() => {
    const nodeEl = nodeElRef.current
    if (!nodeEl) return
    const fresh = new Map(nodes.map((n) => [n.id, n]))
    let changed = false
    nodeEl.each((d) => {
      const f = fresh.get(d.id)
      if (!f) return
      for (const key of Object.keys(REFRESHED_ON_POLL) as (keyof typeof REFRESHED_ON_POLL)[]) {
        if (refreshField(d, f, key)) changed = true
      }
    })
    if (!changed) return
    drawStatusRings(nodeEl)
    nodeEl.select<SVGCircleElement>('.node-bg')
      .attr('fill', (d) => nodeFill(d, rootNodeId, highlightHealthRef.current))
      // The selected CI keeps its orange outline through the poll.
      .attr('stroke', (d) => nodeOutline(d, highlightNodeIdRef.current, rootNodeId, highlightHealthRef.current))
      .attr('opacity', (d) => d.inMaintenance ? 0.65 : 1)
    // A root whose health changed under «highlight health» changes background: its icon follows.
    paintIcons(nodeEl, rootNodeId, highlightHealthRef.current)
    nodeEl.select<SVGTextElement>('.node-label')
      .text((d) => nodeLabel(d, rootNodeId))
  }, [nodes, rootNodeId])

  // ── Health highlight effect (no rebuild) ──────────────────────────────────
  // L'interruttore "Evidenzia salute" ricolora bordo e sfondo in place.
  useEffect(() => {
    const nodeEl = nodeElRef.current
    if (!nodeEl) return
    nodeEl.select<SVGCircleElement>('.node-bg')
      .attr('fill', (d) => nodeFill(d, rootNodeId, highlightHealth))
      .attr('stroke', (d) => nodeOutline(d, highlightNodeId, rootNodeId, highlightHealth))
    // The root's icon follows its background: white on cyan, slate on the red of a CI down.
    paintIcons(nodeEl, rootNodeId, highlightHealth)
  }, [highlightHealth, rootNodeId, highlightNodeId])

  // ── Highlight effect (no rebuild) ─────────────────────────────────────────
  // Also run after every redraw (`snap`): a redrawn map starts plain, and the
  // selection's outline and fading used to be lost until the selection changed.
  useEffect(() => {
    const nodeEl = nodeElRef.current
    const linkEl = linkElRef.current
    if (!nodeEl || !linkEl) return

    // Nothing selected, or the root, which the whole map is about: nothing
    // stands out, and a CI selected before gets its size and border back.
    if (!highlightNodeId || highlightNodeId === rootNodeId) {
      nodeEl.style('opacity', 1)
      nodeEl.select<SVGCircleElement>('.node-bg')
        .attr('stroke-width', 2.5)
        .attr('stroke', (n) => nodeStroke(n, highlightHealthRef.current))
        .attr('r', r)
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
      .attr('stroke', (n) => {
        if (n.id === highlightNodeId) return NODE_SELECTED_COLOR
        return nodeStroke(n, highlightHealthRef.current)
      })
      .attr('r', (n) => n.id === highlightNodeId ? r * 1.5 : r)
    linkEl
      .attr('stroke-opacity', (l) =>
        nid(l.source) === highlightNodeId || nid(l.target) === highlightNodeId ? 0.85 : 0.06)
      .attr('stroke-width', (l) =>
        nid(l.source) === highlightNodeId || nid(l.target) === highlightNodeId ? 2.5 : 1)
  }, [highlightNodeId, rootNodeId, snap])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', overflow: 'hidden' }}
    />
  )
}

// The legend lives in its own module (it has no D3): re-exported here for the pages that import it with the graph.
export { TopologyLegend } from './TopologyLegend'
export { HEALTH_COLOR } from './topologyStyle'
