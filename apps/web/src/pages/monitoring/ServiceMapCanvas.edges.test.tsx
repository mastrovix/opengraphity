/**
 * THE SERVICE MAP AT ITS EDGES: a path the CMDB no longer draws, and the ends of a row.
 *
 * The impact path is the evaluation's own data. When the map is no longer
 * aligned with the CMDB (the relationship between two components of the path
 * was removed), the segment is still drawn — dashed, and titled as a segment
 * without a live relationship — rather than silently dropped: hiding it would
 * leave a component «down» with no visible route to the service.
 *
 * On the keyboard, Home and End jump to the first and last component of the
 * row, as in any grid. `ServiceMapCanvas.test.tsx` and `.more.test.tsx`
 * cover the rest.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { mapDetail, EDGES } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'
import { ServiceMapCanvas } from './ServiceMapCanvas'

function renderMap(over: Record<string, unknown> = {}) {
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
  return renderWithProviders(<ServiceMapCanvas map={mapDetail(over) as unknown as ServiceMapDetail} selectedId={null} onSelect={vi.fn()} />)
}

const edge = (source: string, target: string) =>
  screen.getAllByTestId('service-map-edge').find((e) => e.getAttribute('data-source') === source && e.getAttribute('data-target') === target)
const nodeOf = (ciId: string) => screen.getAllByTestId('service-map-node').find((n) => n.getAttribute('data-ci-id') === ciId)!
const focused = () => document.activeElement?.getAttribute('data-ci-id')

describe('ServiceMapCanvas edges', () => {
  it('a path segment the CMDB no longer has is drawn dashed and said to have no live relationship', () => {
    renderMap({ edges: EDGES.filter((e) => e.target !== 'db-01') })
    const missing = edge('api-03', 'db-01')!
    expect(missing).toHaveAttribute('data-live', 'false')
    expect(missing).toHaveAttribute('stroke-dasharray', '6 4')
    expect(missing).toHaveAttribute('data-highlight', 'down')
    expect(missing.querySelector('title')).toHaveTextContent('Path segment without a live relationship')
  })

  it('a live relationship is drawn solid and titled with its type', () => {
    renderMap()
    const live = edge('api-03', 'db-01')!
    expect(live).toHaveAttribute('data-live', 'true')
    expect(live).not.toHaveAttribute('stroke-dasharray')
    expect(live.querySelector('title')).toHaveTextContent('DEPENDS_ON')
  })

  it('End goes to the last component of the row and Home back to the first', async () => {
    const { user } = renderMap()
    nodeOf('db-01').focus()
    await user.keyboard('{End}')
    const last = focused()!
    // Nothing to the right of the last one.
    await user.keyboard('{ArrowRight}')
    expect(focused()).toBe(last)
    await user.keyboard('{Home}')
    const first = focused()!
    expect(first).not.toBe(last)
    // Nothing to the left of the first one.
    await user.keyboard('{ArrowLeft}')
    expect(focused()).toBe(first)
  })
})
