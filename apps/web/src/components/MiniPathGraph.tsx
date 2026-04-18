import { useRef, useEffect, useCallback } from 'react'
import * as d3 from 'd3'
import { lookupOrError } from '@/lib/tokens'

const MINI_R = 16
const MINI_NODE_COLOR = '#64748b'
const MINI_EDGE_COLOR = '#0284c7'

type IconPath = [string, Record<string, string>]
const MINI_ICONS: Record<string, IconPath[]> = {
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function appendMiniIcon(sel: d3.Selection<any, any, any, any>, iconKey: string, color: string, size = 16) {
  const paths = lookupOrError(MINI_ICONS, iconKey, 'MINI_ICONS', MINI_ICONS['box']!)
  const scale = size / 24
  const offset = -(size / 2)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = (sel as any).append('g')
    .attr('transform', `translate(${offset},${offset}) scale(${scale})`)
    .attr('pointer-events', 'none')
  for (const [tag, attrs] of paths) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = (g as any).append(tag)
    for (const [k, v] of Object.entries(attrs)) el.attr(k, v)
    el.attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2)
      .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round')
  }
}

interface MiniPathGraphProps {
  pathNames: string[]
  targetName: string
  impactedName: string
  nameTypeMap: Map<string, string>
  typeIconMap: Map<string, string>
}

export function MiniPathGraph({ pathNames, targetName, impactedName, nameTypeMap, typeIconMap }: MiniPathGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const HEIGHT = 120

  const draw = useCallback(() => {
    const svg = svgRef.current
    if (!svg || pathNames.length < 2) return
    const width = svg.parentElement?.clientWidth ?? 600

    const sel = d3.select(svg)
    sel.selectAll('*').remove()
    sel.attr('width', width).attr('height', HEIGHT)

    const unique: string[] = []
    for (const n of pathNames) { if (!unique.includes(n)) unique.push(n) }

    const gap = width / (unique.length + 1)
    const cy = HEIGHT / 2 - 6

    type N = { id: string; name: string; x: number; y: number }
    const nodes: N[] = unique.map((name, i) => ({ id: name, name, x: gap * (i + 1), y: cy }))

    sel.append('defs').append('marker')
      .attr('id', 'arrow-mini-path').attr('viewBox', '0 -5 10 10')
      .attr('refX', 10).attr('refY', 0)
      .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', MINI_EDGE_COLOR).attr('opacity', 0.7)

    sel.append('g').selectAll('line')
      .data(nodes.slice(1))
      .join('line')
      .attr('x1', (_, i) => nodes[i]!.x + MINI_R + 2).attr('y1', cy)
      .attr('x2', d => d.x - MINI_R - 2).attr('y2', cy)
      .attr('stroke', MINI_EDGE_COLOR).attr('stroke-width', 1.5).attr('stroke-opacity', 0.5)
      .attr('marker-end', 'url(#arrow-mini-path)')

    const nodeSel = sel.append('g').selectAll('g').data(nodes).join('g')
      .attr('transform', d => `translate(${d.x},${d.y})`)

    nodeSel.append('circle')
      .attr('r', MINI_R)
      .attr('fill', d => d.name === targetName ? MINI_EDGE_COLOR : d.name === impactedName ? '#f97316' : '#ffffff')
      .attr('stroke', d => d.name === targetName ? MINI_EDGE_COLOR : d.name === impactedName ? '#f97316' : MINI_NODE_COLOR)
      .attr('stroke-width', 2)

    nodeSel.each(function (d) {
      const g = d3.select(this) as d3.Selection<SVGGElement, N, null, undefined>
      const iconColor = (d.name === targetName || d.name === impactedName) ? '#ffffff' : MINI_NODE_COLOR
      const ciType = nameTypeMap.get(d.name) ?? ''
      const iconKey = typeIconMap.get(ciType.toLowerCase().replace(/[_\s]/g, '')) ?? 'box'
      appendMiniIcon(g, iconKey, iconColor, 16)
    })

    nodeSel.append('text')
      .text(d => d.name.length > 16 ? d.name.slice(0, 15) + '…' : d.name)
      .attr('text-anchor', 'middle').attr('dy', MINI_R + 14)
      .attr('font-size', 10).attr('fill', '#0f172a').attr('font-weight', 500)
      .attr('font-family', "'Plus Jakarta Sans', system-ui, sans-serif")

  }, [pathNames, targetName, impactedName, nameTypeMap, typeIconMap])

  useEffect(() => { draw() }, [draw])

  return (
    <div style={{ background: '#ffffff', borderRadius: 6, overflow: 'hidden', width: '100%' }}>
      <svg ref={svgRef} style={{ display: 'block', width: '100%', height: HEIGHT }} />
    </div>
  )
}
