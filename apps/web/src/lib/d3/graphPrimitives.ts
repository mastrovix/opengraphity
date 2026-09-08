/**
 * Primitive D3 condivise dai tre grafi (CIGraph, TopologyGraph, MiniPathGraph).
 *
 * Prima ognuno riscriveva defs/marker frecce, zoom, drag, troncamento nomi,
 * l'icona lucide e la stringa del font (23 copie letterali nel perimetro).
 * Qui vive una sola versione di ciascuna; il font è il token `--font-family`.
 */
import * as d3 from 'd3'
import { fontFamily } from '@/lib/tokens'
import { iconPathsOrError, isBrokenIconKey, BROKEN_ICON_COLOR } from '@/lib/ciIconPaths'

/** Font dei testi SVG: token CSS (vale come proprietà `style`, non come attributo). */
export const GRAPH_FONT = fontFamily

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnySelection = d3.Selection<any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Testo SVG con il font dei token (`style`, perché `var()` non vale negli attributi). */
export function styleText<S extends AnySelection>(sel: S): S {
  return sel.style('font-family', GRAPH_FONT) as S
}

/** "Nome molto lungo del CI" → "Nome molto lu…" (max caratteri inclusa l'ellissi). */
export function truncate(name: string, max: number): string {
  return name.length > max ? name.slice(0, max - 1) + '…' : name
}

/** Marker freccia riutilizzabile via `marker-end: url(#id)`. */
export function appendArrowMarker(
  defs: AnySelection,
  id: string,
  color: string,
  { size = 6, opacity = 1 }: { size?: number; opacity?: number } = {},
): void {
  defs.append('marker')
    .attr('id', id)
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 10).attr('refY', 0)
    .attr('markerWidth', size).attr('markerHeight', size)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', color)
    .attr('opacity', opacity)
}

/** Zoom/pan sull'SVG che trasla il gruppo radice `g`. */
export function attachZoom(
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  g: AnySelection,
  {
    scaleExtent = [0.3, 3],
    onZoom,
  }: { scaleExtent?: [number, number]; onZoom?: (e: d3.D3ZoomEvent<SVGSVGElement, unknown>) => void } = {},
): d3.ZoomBehavior<SVGSVGElement, unknown> {
  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent(scaleExtent)
    .on('zoom', (e: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
      g.attr('transform', e.transform.toString())
      onZoom?.(e)
    })
  svg.call(zoom)
  return zoom
}

/**
 * Drag dei nodi di una force simulation. `pinAfterDrag`: true lascia il nodo
 * fissato dove è stato rilasciato (topologia), false lo restituisce alla
 * simulazione (grafo CI). `canDrag` esclude i nodi ancorati (es. il centro).
 */
export function nodeDrag<N extends d3.SimulationNodeDatum>(
  sim: d3.Simulation<N, undefined>,
  { pinAfterDrag = false, canDrag = () => true }: { pinAfterDrag?: boolean; canDrag?: (d: N) => boolean } = {},
): d3.DragBehavior<SVGGElement, N, N | d3.SubjectPosition> {
  return d3.drag<SVGGElement, N>()
    .on('start', (e, d) => {
      if (!e.active) sim.alphaTarget(0.3).restart()
      if (canDrag(d)) { d.fx = d.x; d.fy = d.y }
    })
    .on('drag', (e, d) => {
      if (canDrag(d)) { d.fx = e.x; d.fy = e.y }
    })
    .on('end', (e, d) => {
      if (!e.active) sim.alphaTarget(0)
      if (canDrag(d) && !pinAfterDrag) { d.fx = null; d.fy = null }
    })
}

/**
 * Estremi di un arco accorciati dei raggi dei due nodi, così la freccia si
 * ferma sul bordo del cerchio invece che al centro.
 */
export function linkEndpoints(
  s: { x?: number; y?: number }, t: { x?: number; y?: number },
  sourceRadius: number, targetRadius: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const sx = s.x ?? 0, sy = s.y ?? 0, tx = t.x ?? 0, ty = t.y ?? 0
  const dx = tx - sx, dy = ty - sy
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist === 0) return { x1: sx, y1: sy, x2: tx, y2: ty }
  return {
    x1: sx + (dx / dist) * sourceRadius,
    y1: sy + (dy / dist) * sourceRadius,
    x2: tx - (dx / dist) * targetRadius,
    y2: ty - (dy / dist) * targetRadius,
  }
}

/**
 * Icona lucide (registro `ciIconPaths`) centrata in (0,0) dentro un `<g>`,
 * scalata da 24×24 a `size`. Chiave sconosciuta → "?" rosso.
 */
export function appendIcon(sel: AnySelection, iconKey: string, color: string, size = 18): void {
  const nodes  = iconPathsOrError(iconKey)
  const stroke = isBrokenIconKey(iconKey) ? BROKEN_ICON_COLOR : color
  const scale  = size / 24
  const offset = -(size / 2)
  const g = sel.append('g')
    .attr('class', 'node-icon')
    .attr('transform', `translate(${offset},${offset}) scale(${scale})`)
    .attr('pointer-events', 'none')
  for (const [tag, attrs] of nodes) {
    const el = g.append(tag)
    for (const [k, v] of Object.entries(attrs)) el.attr(k, v)
    el.attr('fill', 'none')
      .attr('stroke', stroke)
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
  }
}

/** Trasformazione di zoom che inquadra il bounding box dei nodi nel canvas. */
export function fitTransform(
  nodes: ReadonlyArray<{ x?: number; y?: number }>,
  width: number, height: number,
  { pad = 60, minScale = 0.3, maxScale = 1 }: { pad?: number; minScale?: number; maxScale?: number } = {},
): d3.ZoomTransform | null {
  if (nodes.length === 0) return null
  const xs = nodes.map((n) => n.x ?? 0)
  const ys = nodes.map((n) => n.y ?? 0)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const bw = (maxX - minX) + pad * 2
  const bh = (maxY - minY) + pad * 2
  if (bw <= 0 || bh <= 0) return null
  const scale = Math.max(minScale, Math.min(maxScale, Math.min(width / bw, height / bh)))
  const tx = width  / 2 - scale * (minX + maxX) / 2
  const ty = height / 2 - scale * (minY + maxY) / 2
  return d3.zoomIdentity.translate(tx, ty).scale(scale)
}
