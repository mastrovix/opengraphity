import { useRef, useEffect, useCallback } from 'react'
import * as d3 from 'd3'
import { iconKeyForType } from '@/lib/ciIconPaths'
import { appendArrowMarker, appendIcon, styleText, truncate } from '@/lib/d3/graphPrimitives'

const MINI_R = 16
const MINI_NODE_COLOR = 'var(--color-slate)'
const MINI_EDGE_COLOR = 'var(--color-trigger-manual)'
const MINI_IMPACTED_COLOR = '#f97316'

interface MiniPathGraphProps {
  pathNames: string[]
  targetName: string
  impactedName: string
  nameTypeMap: Map<string, string>
  /** Tipo CI (normalizzato) → chiave icona, da `buildTypeIconMap(ciTypes)`. */
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

    appendArrowMarker(sel.append('defs'), 'arrow-mini-path', MINI_EDGE_COLOR, { size: 5, opacity: 0.7 })

    sel.append('g').selectAll('line')
      .data(nodes.slice(1))
      .join('line')
      .attr('x1', (_, i) => nodes[i]!.x + MINI_R + 2).attr('y1', cy)
      .attr('x2', d => d.x - MINI_R - 2).attr('y2', cy)
      .attr('stroke', MINI_EDGE_COLOR).attr('stroke-width', 1.5).attr('stroke-opacity', 0.5)
      .attr('marker-end', 'url(#arrow-mini-path)')

    const nodeSel = sel.append('g').selectAll('g').data(nodes).join('g')
      .attr('transform', d => `translate(${d.x},${d.y})`)

    const accent = (d: N) => d.name === targetName ? MINI_EDGE_COLOR : d.name === impactedName ? MINI_IMPACTED_COLOR : null

    nodeSel.append('circle')
      .attr('r', MINI_R)
      .attr('fill', d => accent(d) ?? '#ffffff')
      .attr('stroke', d => accent(d) ?? MINI_NODE_COLOR)
      .attr('stroke-width', 2)

    nodeSel.each(function (d) {
      const g = d3.select(this)
      const iconColor = accent(d) ? '#ffffff' : MINI_NODE_COLOR
      // Un CI del percorso senza tipo noto è un dato incoerente: si vede ("?" rosso).
      const ciType = nameTypeMap.get(d.name)
      if (ciType === undefined) console.error(`[MiniPathGraph] CI "${d.name}" senza tipo nella mappa nome→tipo`)
      appendIcon(g, iconKeyForType(typeIconMap, ciType ?? ''), iconColor, 16)
    })

    styleText(nodeSel.append('text'))
      .text(d => truncate(d.name, 16))
      .attr('text-anchor', 'middle').attr('dy', MINI_R + 14)
      .attr('font-size', 10).attr('fill', 'var(--color-slate-dark)').attr('font-weight', 500)

  }, [pathNames, targetName, impactedName, nameTypeMap, typeIconMap])

  useEffect(() => { draw() }, [draw])

  return (
    <div style={{ background: '#ffffff', borderRadius: 6, overflow: 'hidden', width: '100%' }}>
      <svg ref={svgRef} style={{ display: 'block', width: '100%', height: HEIGHT }} />
    </div>
  )
}
