/**
 * Service map layout: an edge that points UP the map.
 *
 * Why it matters: live CMDB edges do not always go from the service down to
 * its suppliers; a component on level 2 can have an edge towards a level-1
 * application (for example "db HOSTS app"). Such an edge must start from the
 * TOP of the lower card and end at the BOTTOM of the upper card, otherwise
 * the curve is drawn through both cards and the operator cannot tell which
 * two components it joins. An edge between two cards of the SAME row joins
 * their facing sides with a straight segment, for the same reason.
 */
import { describe, it, expect } from 'vitest'
import { layoutServiceMap, NODE_H, NODE_W } from './serviceMapLayout'
import type { ServiceMapNode } from '@/types/services'

const n = (id: string, level: number, via: string | null): ServiceMapNode => ({
  ci: { id, name: id, type: 'server' }, level, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false,
  via, addedBy: 'auto', health: 'operational', inMaintenance: false, contributes: true, excludedReason: null,
})

describe('layoutServiceMap — upward edge', () => {
  it('joins the top of the lower card to the bottom of the upper card with a curve', () => {
    const l = layoutServiceMap('svc', [n('app', 1, null), n('db', 2, 'app')], [{ source: 'db', target: 'app', relType: 'HOSTS' }], [])
    const app = l.nodes.find((p) => p.id === 'app')!
    const db = l.nodes.find((p) => p.id === 'db')!
    const edge = l.edges.find((e) => e.relType === 'HOSTS')!
    expect(db.y).toBeGreaterThan(app.y)
    expect(edge).toMatchObject({
      x1: db.x + NODE_W / 2, y1: db.y,
      x2: app.x + NODE_W / 2, y2: app.y + NODE_H,
      live: true, highlight: null,
    })
    // Different rows → a cubic curve, not a straight segment.
    expect(edge.d.startsWith(`M ${edge.x1} ${edge.y1} C `)).toBe(true)
  })

  it('joins two cards of the same row side to side with a straight segment', () => {
    const l = layoutServiceMap('svc', [n('app', 1, null), n('a', 2, 'app'), n('b', 2, 'app')], [{ source: 'a', target: 'b', relType: 'CONNECTS_TO' }], [])
    const a = l.nodes.find((p) => p.id === 'a')!
    const b = l.nodes.find((p) => p.id === 'b')!
    const edge = l.edges.find((e) => e.relType === 'CONNECTS_TO')!
    expect(edge).toMatchObject({ x1: a.x + NODE_W, y1: a.y + NODE_H / 2, x2: b.x, y2: b.y + NODE_H / 2 })
    expect(edge.d).toBe(`M ${edge.x1} ${edge.y1} L ${edge.x2} ${edge.y2}`)
  })
})
