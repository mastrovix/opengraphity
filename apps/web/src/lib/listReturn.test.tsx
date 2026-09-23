/**
 * BACK TO THE LIST WITH THE FILTERS IT HAD (G-EVT-13).
 *
 * «Back» on a detail page went to `/events` and threw the query string away:
 * from `/events?stat=critical&page=3` one landed on page one with no filter,
 * and the work of scrolling a long list was lost. The list puts its own
 * search in the navigation state; the detail reads it back. Opened from a
 * direct link (a notification, a bookmark) there is no state, and «Back»
 * goes to the plain list — which is right.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LocationSpy } from '@/test/utils'
import { listReturnState, useListReturn } from './listReturn'

function Back() {
  const { to, goBack } = useListReturn('/events')
  return <button type="button" data-to={to} onClick={goBack}>Back</button>
}

const openDetail = (state?: unknown) => render(
  <MemoryRouter initialEntries={[{ pathname: '/events/e1', state }]}>
    <Back /><LocationSpy />
  </MemoryRouter>,
)

describe('listReturnState', () => {
  it('is the state the list passes when it opens a detail: its own query string', () => {
    expect(listReturnState('?stat=critical&page=3')).toEqual({ listSearch: '?stat=critical&page=3' })
  })
})

describe('useListReturn', () => {
  it('opened from the list, «Back» returns to it with its filters and page', () => {
    openDetail(listReturnState('?stat=critical&page=3'))
    const back = screen.getByRole('button', { name: 'Back' })
    expect(back).toHaveAttribute('data-to', '/events?stat=critical&page=3')
    fireEvent.click(back)
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/events\?stat=critical&page=3$/)
  })

  it('opened from a direct link, «Back» goes to the plain list', () => {
    openDetail()
    const back = screen.getByRole('button', { name: 'Back' })
    expect(back).toHaveAttribute('data-to', '/events')
    fireEvent.click(back)
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/events$/)
  })

  it('a list that had no filters returns to the plain list too', () => {
    openDetail(listReturnState(''))
    expect(screen.getByRole('button', { name: 'Back' })).toHaveAttribute('data-to', '/events')
  })
})
