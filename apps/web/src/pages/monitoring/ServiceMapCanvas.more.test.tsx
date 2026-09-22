/**
 * Service map canvas: the node click and the edge of the keyboard grid.
 * What an operator loses if these regress:
 *  - clicking a component opens its side panel, and clicking the SAME
 *    component again closes it (a toggle, as the pressed state announces);
 *  - an arrow key that has nowhere to go (Up from the top row, Down from the
 *    bottom row) must leave the focus where it is — never drop it on the
 *    page body, which throws a keyboard user out of the map.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { ServiceMapCanvas } from './ServiceMapCanvas'
import { renderWithProviders } from '@/test/utils'
import { mapDetail } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'

const detail = () => mapDetail() as unknown as ServiceMapDetail
const nodeOf = (ciId: string) => screen.getAllByTestId('service-map-node').find((n) => n.getAttribute('data-ci-id') === ciId)!

function renderMap(selectedId: string | null = null) {
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
  const onSelect = vi.fn()
  const r = renderWithProviders(<ServiceMapCanvas map={detail()} selectedId={selectedId} onSelect={onSelect} />)
  return { ...r, onSelect }
}

describe('ServiceMapCanvas: selection and keyboard edges', () => {
  it('clicking a component selects it', async () => {
    const { user, onSelect } = renderMap()
    await user.click(nodeOf('cache-02'))
    expect(onSelect).toHaveBeenCalledWith('cache-02')
  })

  it('clicking the selected component again deselects it', async () => {
    const { user, onSelect } = renderMap('cache-02')
    expect(nodeOf('cache-02')).toHaveAttribute('aria-pressed', 'true')
    await user.click(nodeOf('cache-02'))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('ArrowUp on the top row and ArrowDown on the bottom row keep the focus in place', async () => {
    const { user } = renderMap()
    // api-03 is on level 1: the service card above it is not part of the arrow grid.
    nodeOf('api-03').focus()
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(nodeOf('api-03'))

    nodeOf('db-01').focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(nodeOf('db-01'))
  })

  it('keys outside the grid navigation are left to the browser', async () => {
    const { user } = renderMap()
    nodeOf('db-01').focus()
    await user.keyboard('{PageDown}')
    expect(document.activeElement).toBe(nodeOf('db-01'))
  })
})
