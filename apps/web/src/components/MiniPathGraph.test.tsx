/**
 * THE IMPACT PATH OF A WHAT-IF ANALYSIS, drawn small under a row.
 *
 * For every CI the analysis says would be hit, the row opens onto the chain
 * that leads there: from the CI being changed to the one impacted, left to
 * right, one arrow per hop. The reader must see at a glance which end is the
 * change (cyan) and which is the impacted CI (orange), what each CI is (its
 * metamodel icon), and every CI once even when the path passes through it
 * twice. A CI whose type is unknown is drawn with the red «?» and reported,
 * never with a plausible icon; a path too short to be a path draws nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { BROKEN_ICON_COLOR } from '@/lib/ciIconPaths'
import { MiniPathGraph } from './MiniPathGraph'

const TYPE_ICONS = new Map([['server', 'server'], ['database', 'database'], ['application', 'globe']])
const TYPES = new Map([['Checkout', 'application'], ['web-01', 'server'], ['Payments database cluster', 'database']])

type Props = Parameters<typeof MiniPathGraph>[0]
const draw = (over: Partial<Props> = {}) => render(
  <MiniPathGraph
    pathNames={['Checkout', 'web-01', 'Payments database cluster']}
    targetName="Checkout" impactedName="Payments database cluster"
    nameTypeMap={TYPES} typeIconMap={TYPE_ICONS} {...over}
  />,
)

/** What the drawing says: the CIs left to right, and the arrows between them. */
function drawing(container: HTMLElement) {
  const svg = container.querySelector('svg')!
  const [arrows, cis] = [...svg.querySelectorAll(':scope > g')]
  return {
    svg,
    cis: [...(cis?.children ?? [])].map((g) => ({
      label: g.querySelector('text')?.textContent,
      at: g.getAttribute('transform'),
      fill: g.querySelector('circle')?.getAttribute('fill'),
      ring: g.querySelector('circle')?.getAttribute('stroke'),
      iconShape: g.querySelector('.node-icon')?.firstElementChild?.tagName,
      iconColour: g.querySelector('.node-icon')?.firstElementChild?.getAttribute('stroke'),
    })),
    arrows: [...(arrows?.children ?? [])].map((l) => ({
      from: Number(l.getAttribute('x1')), to: Number(l.getAttribute('x2')), y: Number(l.getAttribute('y1')), head: l.getAttribute('marker-end'),
    })),
  }
}

describe('MiniPathGraph', () => {
  it('draws the CIs of the path left to right, the change in cyan and the impacted CI in orange', () => {
    const { container } = draw()
    const { cis } = drawing(container)
    // The name is cut at 16 characters, ellipsis included.
    expect(cis.map((c) => c.label)).toEqual(['Checkout', 'web-01', 'Payments databa…'])
    expect(cis[0]).toMatchObject({ fill: 'var(--color-trigger-manual)', ring: 'var(--color-trigger-manual)', iconColour: 'var(--color-white)' })
    expect(cis[1]).toMatchObject({ fill: 'var(--color-white)', ring: 'var(--color-slate)', iconColour: 'var(--color-slate)' })
    expect(cis[2]).toMatchObject({ fill: 'var(--color-orange)', ring: 'var(--color-orange)', iconColour: 'var(--color-white)' })
  })

  it('each CI carries the icon its type has in the metamodel', () => {
    const { container } = draw()
    // globe → circle, server → rect, database → ellipse: the first shape of each lucide icon.
    expect(drawing(container).cis.map((c) => c.iconShape)).toEqual(['circle', 'rect', 'ellipse'])
  })

  it('spreads the CIs evenly across the width, with one arrow per hop that stops short of each circle', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
    const { container } = draw()
    const { svg, cis, arrows } = drawing(container)
    expect(svg).toHaveAttribute('width', '500')
    expect(cis.map((c) => c.at)).toEqual(['translate(125,54)', 'translate(250,54)', 'translate(375,54)'])
    expect(arrows).toEqual([
      { from: 143, to: 232, y: 54, head: 'url(#arrow-mini-path)' },
      { from: 268, to: 357, y: 54, head: 'url(#arrow-mini-path)' },
    ])
    expect(svg.querySelector('marker#arrow-mini-path')).not.toBeNull()
  })

  it('a CI the path passes through twice is drawn once', () => {
    const { container } = draw({ pathNames: ['Checkout', 'web-01', 'Checkout', 'Payments database cluster'] })
    const { cis, arrows } = drawing(container)
    expect(cis.map((c) => c.label)).toEqual(['Checkout', 'web-01', 'Payments databa…'])
    expect(arrows).toHaveLength(2)
  })

  it('a CI with no known type gets the red «?», and the gap is reported', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = draw({ pathNames: ['Checkout', 'mystery-box'], impactedName: 'mystery-box' })
    const mystery = drawing(container).cis[1]!
    expect(mystery.label).toBe('mystery-box')
    expect(mystery.iconColour).toBe(BROKEN_ICON_COLOR)
    expect(error).toHaveBeenCalledWith('[MiniPathGraph] CI "mystery-box" has no type in the name→type map')
  })

  it('a path of a single CI is not a path: nothing is drawn', () => {
    const { container } = draw({ pathNames: ['Checkout'] })
    const { svg, cis, arrows } = drawing(container)
    expect(cis).toEqual([])
    expect(arrows).toEqual([])
    expect(svg.childElementCount).toBe(0)
  })

  it('a new path replaces the drawing instead of piling onto it', () => {
    const { container, rerender } = draw()
    rerender(
      <MiniPathGraph pathNames={['web-01', 'Payments database cluster']} targetName="web-01" impactedName="Payments database cluster" nameTypeMap={TYPES} typeIconMap={TYPE_ICONS} />,
    )
    const { svg, cis, arrows } = drawing(container)
    expect(cis.map((c) => c.label)).toEqual(['web-01', 'Payments databa…'])
    expect(cis[0]!.fill).toBe('var(--color-trigger-manual)')
    expect(arrows).toHaveLength(1)
    expect(svg.querySelectorAll('marker')).toHaveLength(1)
  })
})
