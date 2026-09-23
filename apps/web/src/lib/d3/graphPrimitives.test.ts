/**
 * THE D3 PIECES SHARED BY THE THREE GRAPHS (CI graph, topology, impact path).
 *
 * Each graph used to carry its own copy of these; now there is one, so a
 * regression here shows up in all three at once. What they promise:
 *  - names are shortened to a fixed width with an ellipsis, never cut bare;
 *  - arrows end on the border of the target circle, not at its centre;
 *  - zoom stays inside its scale range and moves the whole graph;
 *  - dragging a node pins it under the pointer and wakes the simulation, and
 *    on release either hands it back (CI graph) or leaves it where it was
 *    dropped (topology); an anchored node (the centre) never moves;
 *  - a node's icon comes from the one icon registry, and an icon that is
 *    missing is a visible red «?», never a plausible icon in its place;
 *  - «fit» frames every node inside the canvas, within the zoom limits.
 * These run on real D3 against jsdom elements.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as d3 from 'd3'
import {
  GRAPH_FONT, styleText, truncate, appendArrowMarker, attachZoom, nodeDrag, linkEndpoints, appendIcon, fitTransform,
} from './graphPrimitives'
import { CI_ICON_PATHS, BROKEN_ICON_KEY, BROKEN_ICON_PATHS, BROKEN_ICON_COLOR } from '@/lib/ciIconPaths'

const SVG_NS = 'http://www.w3.org/2000/svg'

function canvas() {
  const el = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  document.body.appendChild(el)
  const svg = d3.select<SVGSVGElement, unknown>(el)
  const g = svg.append('g')
  return { el, svg, g }
}

afterEach(() => { document.body.innerHTML = '' })

describe('truncate', () => {
  it('a long name is cut to the given width, ellipsis included', () => {
    expect(truncate('Nome molto lungo del CI', 14)).toBe('Nome molto lu…')
    expect(truncate('Nome molto lungo del CI', 14)).toHaveLength(14)
  })

  it('a name that fits is left alone', () => {
    expect(truncate('db-01', 5)).toBe('db-01')
    expect(truncate('db', 5)).toBe('db')
  })
})

describe('styleText', () => {
  it('gives the text the font token as a style (a CSS variable does not work as an attribute) and keeps the chain', () => {
    const { g } = canvas()
    const text = g.append('text')
    expect(styleText(text)).toBe(text)
    expect(text.node()!.style.getPropertyValue('font-family')).toBe(GRAPH_FONT)
    expect(text.attr('font-family')).toBeNull()
  })
})

describe('appendArrowMarker', () => {
  it('defines an arrow head that edges reference by id, in the given colour', () => {
    const { svg } = canvas()
    const defs = svg.append('defs')
    appendArrowMarker(defs, 'arrow-depends', 'red')
    const marker = defs.select('marker#arrow-depends')
    expect(marker.attr('viewBox')).toBe('0 -5 10 10')
    expect(marker.attr('refX')).toBe('10')
    expect(marker.attr('orient')).toBe('auto')
    expect(marker.attr('markerWidth')).toBe('6')
    expect(marker.attr('markerHeight')).toBe('6')
    const path = marker.select('path')
    expect(path.attr('d')).toBe('M0,-5L10,0L0,5')
    expect(path.attr('fill')).toBe('red')
    expect(path.attr('opacity')).toBe('1')
  })

  it('size and opacity can be chosen', () => {
    const { svg } = canvas()
    const defs = svg.append('defs')
    appendArrowMarker(defs, 'faint', 'grey', { size: 10, opacity: 0.4 })
    expect(defs.select('marker#faint').attr('markerWidth')).toBe('10')
    expect(defs.select('marker#faint path').attr('opacity')).toBe('0.4')
  })
})

describe('attachZoom', () => {
  // jsdom lays nothing out, so the SVG has no size of its own: the extent a
  // browser would read from it is given here.
  const sized = <T extends d3.ZoomBehavior<SVGSVGElement, unknown>>(z: T) => z.extent([[0, 0], [400, 300]])

  it('zooming and panning move the whole graph and are reported to the caller', () => {
    const { svg, g } = canvas()
    const onZoom = vi.fn()
    const zoom = sized(attachZoom(svg, g, { onZoom }))
    svg.call(zoom.transform, d3.zoomIdentity.translate(10, 20).scale(2))
    expect(g.attr('transform')).toBe('translate(10,20) scale(2)')
    expect(onZoom).toHaveBeenCalledTimes(1)
    expect(onZoom.mock.calls[0]![0].transform.k).toBe(2)
  })

  it('stays within the default scale range, 0.3 to 3', () => {
    const { svg, g } = canvas()
    const zoom = sized(attachZoom(svg, g))
    expect(zoom.scaleExtent()).toEqual([0.3, 3])
    svg.call(zoom.scaleTo, 50)
    expect(d3.zoomTransform(svg.node()!).k).toBe(3)
    svg.call(zoom.scaleTo, 0.01)
    expect(d3.zoomTransform(svg.node()!).k).toBe(0.3)
  })

  it('a graph can choose its own range', () => {
    const { svg, g } = canvas()
    const zoom = sized(attachZoom(svg, g, { scaleExtent: [0.5, 2] }))
    svg.call(zoom.scaleTo, 50)
    expect(g.attr('transform')).toMatch(/scale\(2\)$/)
  })
})

describe('nodeDrag', () => {
  interface Node extends d3.SimulationNodeDatum { id: string }

  function setup(options?: Parameters<typeof nodeDrag<Node>>[1]) {
    const { svg } = canvas()
    const restart = vi.fn()
    const sim = { alphaTarget: vi.fn(() => ({ restart })) }
    const node: Node = { id: 'n1', x: 10, y: 20 }
    const el = svg.append('g').datum(node).node()!
    d3.select<SVGGElement, Node>(el).call(nodeDrag<Node>(sim as unknown as d3.Simulation<Node, undefined>, options))
    // After the press D3 follows the pointer on the event's window. jsdom's
    // MouseEvent refuses the test's `window` as `view`, so it is set afterwards.
    const at = (type: string, target: EventTarget, x: number, y: number) => {
      const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true })
      Object.defineProperty(e, 'view', { value: window })
      target.dispatchEvent(e)
    }
    return {
      node, sim, restart,
      press: (x: number, y: number) => at('mousedown', el, x, y),
      move: (x: number, y: number) => at('mousemove', window, x, y),
      release: (x: number, y: number) => at('mouseup', window, x, y),
    }
  }

  it('a dragged node follows the pointer and wakes the simulation; released, it goes back to the simulation', () => {
    const d = setup()
    d.press(100, 100)
    expect(d.sim.alphaTarget).toHaveBeenCalledWith(0.3)
    expect(d.restart).toHaveBeenCalledTimes(1)
    expect([d.node.fx, d.node.fy]).toEqual([10, 20])
    d.move(150, 130)
    // The node moves by as much as the pointer did.
    expect([d.node.fx, d.node.fy]).toEqual([60, 50])
    d.release(150, 130)
    expect(d.sim.alphaTarget).toHaveBeenLastCalledWith(0)
    expect([d.node.fx, d.node.fy]).toEqual([null, null])
  })

  it('with pinAfterDrag the node stays where it was dropped', () => {
    const d = setup({ pinAfterDrag: true })
    d.press(100, 100)
    d.move(140, 90)
    d.release(140, 90)
    expect([d.node.fx, d.node.fy]).toEqual([50, 10])
  })

  it('two nodes dragged at once (two fingers) wake the simulation once, and it cools only when the last one is let go', () => {
    const { svg } = canvas()
    const restart = vi.fn()
    const sim = { alphaTarget: vi.fn(() => ({ restart })) }
    const a: Node = { id: 'a', x: 0, y: 0 }
    const b: Node = { id: 'b', x: 100, y: 100 }
    const nodes = svg.selectAll<SVGGElement, Node>('g.n').data([a, b]).join('g').attr('class', 'n')
    nodes.call(nodeDrag<Node>(sim as unknown as d3.Simulation<Node, undefined>))
    const [elA, elB] = nodes.nodes()
    const touch = (type: string, target: Element, identifier: number, clientX: number, clientY: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'changedTouches', { value: [{ identifier, clientX, clientY }] })
      target.dispatchEvent(e)
    }
    touch('touchstart', elA!, 1, 0, 0)
    touch('touchstart', elB!, 2, 100, 100)
    expect(sim.alphaTarget).toHaveBeenCalledTimes(1)
    // The second node is held all the same, and follows its finger.
    expect([b.fx, b.fy]).toEqual([100, 100])
    touch('touchmove', elB!, 2, 120, 90)
    expect([b.fx, b.fy]).toEqual([120, 90])
    touch('touchend', elA!, 1, 0, 0)
    expect(sim.alphaTarget).toHaveBeenCalledTimes(1)
    touch('touchend', elB!, 2, 120, 90)
    expect(sim.alphaTarget).toHaveBeenLastCalledWith(0)
    expect([a.fx, b.fx]).toEqual([null, null])
  })

  it('an anchored node is never moved, but the simulation still wakes', () => {
    const d = setup({ canDrag: (n) => n.id !== 'n1' })
    d.node.fx = 0
    d.node.fy = 0
    d.press(100, 100)
    d.move(160, 160)
    d.release(160, 160)
    expect([d.node.fx, d.node.fy]).toEqual([0, 0])
    expect(d.sim.alphaTarget).toHaveBeenCalledWith(0.3)
    expect(d.sim.alphaTarget).toHaveBeenLastCalledWith(0)
  })
})

describe('linkEndpoints', () => {
  it('an edge starts and ends on the border of the two circles, not at their centres', () => {
    expect(linkEndpoints({ x: 0, y: 0 }, { x: 30, y: 40 }, 5, 10)).toEqual({ x1: 3, y1: 4, x2: 24, y2: 32 })
  })

  it('two nodes in the same place give an edge of no length, not a division by zero', () => {
    expect(linkEndpoints({ x: 7, y: 7 }, { x: 7, y: 7 }, 5, 5)).toEqual({ x1: 7, y1: 7, x2: 7, y2: 7 })
  })

  it('a node not placed yet counts as the origin', () => {
    expect(linkEndpoints({}, { x: 10 }, 2, 3)).toEqual({ x1: 2, y1: 0, x2: 7, y2: 0 })
    expect(linkEndpoints({ x: 10, y: 0 }, {}, 2, 3)).toEqual({ x1: 8, y1: 0, x2: 3, y2: 0 })
  })
})

describe('appendIcon', () => {
  const drawn = (g: d3.Selection<SVGGElement, unknown, null, undefined>) => {
    const icon = g.select<SVGGElement>('g.node-icon')
    const parts = [...icon.node()!.children].map((c) => ({ tag: c.tagName, attrs: Object.fromEntries([...c.attributes].map((a) => [a.name, a.value])) }))
    return { icon, parts }
  }

  it('draws the registry icon centred on the node, scaled from 24 px, in the node colour', () => {
    const { g } = canvas()
    appendIcon(g, 'server', 'teal')
    const { icon, parts } = drawn(g)
    expect(icon.attr('transform')).toBe('translate(-9,-9) scale(0.75)')
    expect(icon.attr('pointer-events')).toBe('none')
    expect(parts.map((p) => p.tag)).toEqual(CI_ICON_PATHS['server']!.map(([tag]) => tag))
    parts.forEach((p, i) => {
      expect(p.attrs).toMatchObject(CI_ICON_PATHS['server']![i]![1])
      expect(p.attrs).toMatchObject({ fill: 'none', stroke: 'teal', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
    })
  })

  it('draws at the requested size', () => {
    const { g } = canvas()
    appendIcon(g, 'database', 'teal', 24)
    expect(drawn(g).icon.attr('transform')).toBe('translate(-12,-12) scale(1)')
  })

  it('the broken-icon key is a red «?», whatever colour the caller asks for', () => {
    const { g } = canvas()
    appendIcon(g, BROKEN_ICON_KEY, 'teal')
    const { parts } = drawn(g)
    expect(parts.map((p) => p.tag)).toEqual(BROKEN_ICON_PATHS.map(([tag]) => tag))
    expect(parts.every((p) => p.attrs['stroke'] === BROKEN_ICON_COLOR)).toBe(true)
  })

  it('an icon the registry does not have is drawn as the «?» and reported, never as another icon', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { g } = canvas()
    appendIcon(g, 'router', 'teal')
    expect(drawn(g).parts.map((p) => p.tag)).toEqual(BROKEN_ICON_PATHS.map(([tag]) => tag))
    expect(consoleError).toHaveBeenCalledWith('[CI_ICON_PATHS] unknown value: "router"')
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: only the reserved
   * `__broken__` key was painted red; a key the registry lacks (the API
   * accepts any `icon`) got the «?» in the node colour, while `CIIcon` painted
   * it red — broken in the lists, ordinary in the graphs.
   */
  it('an icon the registry does not have is painted red, as the lists paint it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { g } = canvas()
    appendIcon(g, 'router', 'teal')
    expect(drawn(g).parts.every((p) => p.attrs['stroke'] === BROKEN_ICON_COLOR)).toBe(true)
  })
})

describe('fitTransform', () => {
  it('no nodes: nothing to frame', () => {
    expect(fitTransform([], 400, 300)).toBeNull()
  })

  it('centres the nodes in the canvas and never enlarges past 1 by default', () => {
    const t = fitTransform([{ x: 0, y: 0 }, { x: 200, y: 100 }], 400, 300)!
    expect(t.k).toBe(1)
    // The centre of the nodes (100, 50) lands on the centre of the canvas (200, 150).
    expect(t.apply([100, 50])).toEqual([200, 150])
  })

  it('a graph wider than the canvas is shrunk to fit, but not below the minimum scale', () => {
    const fits = fitTransform([{ x: 0, y: 0 }, { x: 680, y: 0 }], 400, 300)!
    // (680 + 2×60 of padding) into 400 px: half size.
    expect(fits.k).toBe(0.5)
    expect(fits.apply([340, 0])).toEqual([200, 150])
    const huge = fitTransform([{ x: 0, y: 0 }, { x: 40_000, y: 0 }], 400, 300)!
    expect(huge.k).toBe(0.3)
  })

  it('padding and limits can be chosen', () => {
    const t = fitTransform([{ x: 0, y: 0 }, { x: 100, y: 100 }], 400, 400, { pad: 0, minScale: 0.1, maxScale: 3 })!
    expect(t.k).toBe(3)
    // A lower floor lets a big graph shrink below the default 0.3.
    const small = fitTransform([{ x: 0, y: 0 }, { x: 4000, y: 4000 }], 400, 400, { pad: 0, minScale: 0.05 })!
    expect(small.k).toBe(0.1)
  })

  it('a node not placed yet counts as the origin', () => {
    const t = fitTransform([{}, { x: 200, y: 100 }], 400, 300)!
    expect(t.apply([100, 50])).toEqual([200, 150])
  })

  it('a single node with no padding has nothing to measure', () => {
    expect(fitTransform([{ x: 5, y: 5 }], 400, 300, { pad: 0 })).toBeNull()
  })
})
