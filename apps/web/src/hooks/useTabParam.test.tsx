/**
 * THE OPEN TAB IS IN THE ADDRESS.
 *
 * What a user loses if this regresses: a link to a ticket's diagnosis opens on
 * the overview; a refresh drops back to the first tab; Back walks the tabs one
 * by one instead of leaving the page.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useTabParam } from './useTabParam'

const KEYS = ['overview', 'diagnosis', 'links'] as const

function Page() {
  const [tab, setTab] = useTabParam(KEYS, 'overview')
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <div>
      <output aria-label="tab">{tab}</output>
      <output aria-label="address">{location.pathname + location.search}</output>
      {KEYS.map((k) => <button key={k} type="button" onClick={() => setTab(k)}>{k}</button>)}
      <button type="button" onClick={() => navigate(-1)}>back</button>
    </div>
  )
}

function renderAt(...entries: string[]) {
  const user = userEvent.setup()
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes><Route path="/list" element={<p>list</p>} /><Route path="/t/:id" element={<Page />} /></Routes>
    </MemoryRouter>,
  )
  return { user }
}

const tab = () => screen.getByRole('status', { name: 'tab' }).textContent
const address = () => screen.getByRole('status', { name: 'address' }).textContent

describe('useTabParam', () => {
  it('the plain address opens the first tab', () => {
    renderAt('/t/1')
    expect(tab()).toBe('overview')
  })

  it('a link with ?tab= opens that tab', () => {
    renderAt('/t/1?tab=diagnosis')
    expect(tab()).toBe('diagnosis')
  })

  it('an unknown tab in the address opens the first one', () => {
    renderAt('/t/1?tab=nope')
    expect(tab()).toBe('overview')
  })

  it('choosing a tab writes it, the first one clears it, and the other parameters stay', async () => {
    const { user } = renderAt('/t/1?from=list')
    await user.click(screen.getByRole('button', { name: 'links' }))
    expect(tab()).toBe('links')
    expect(address()).toBe('/t/1?from=list&tab=links')
    await user.click(screen.getByRole('button', { name: 'overview' }))
    expect(address()).toBe('/t/1?from=list')
  })

  it('Back leaves the page: a change of tab replaces the entry, it does not add one', async () => {
    const { user } = renderAt('/list', '/t/1')
    await user.click(screen.getByRole('button', { name: 'diagnosis' }))
    await user.click(screen.getByRole('button', { name: 'links' }))
    await user.click(screen.getByRole('button', { name: 'back' }))
    expect(screen.getByText('list')).toBeInTheDocument()
  })
})
