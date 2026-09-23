/**
 * THE SHELL OF EVERY AUTHENTICATED PAGE: sidebar, top bar and the page itself.
 *
 * What the user relies on:
 * - nobody sees the app without a session: an unauthenticated visit goes to
 *   the login page instead of rendering an empty shell;
 * - a keyboard user can jump over the menu straight to the content (the skip
 *   link appears when focused, and hides again when left);
 * - on a narrow window the sidebar starts closed and closes by itself when
 *   the window shrinks (at 683px an open sidebar took a third of the screen),
 *   while reopening it stays the user's choice;
 * - the page content sits next to the sidebar, never under it.
 *
 * Sidebar and Topbar have their own tests; here they are stand-ins that keep
 * the contract the shell relies on (the sidebar's width and its collapse
 * button, labelled like the real one).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { mockKeycloak } from '@/test/mocks/keycloak'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('./Sidebar', () => ({
  Sidebar: ({ collapsed, width, onToggle }: { collapsed: boolean; width: number; onToggle: () => void }) => (
    <nav aria-label="Main menu" style={{ width }}>
      <button type="button" onClick={onToggle}>{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</button>
    </nav>
  ),
}))
vi.mock('./Topbar', () => ({ Topbar: () => <header>Top bar</header> }))

const { AppLayout } = await import('./AppLayout')

// ── A controllable `(max-width: 900px)` media query ─────────────────────────

type Listener = (e: MediaQueryListEvent) => void
const media = { narrow: false, listeners: new Set<Listener>() }
const originalMatchMedia = window.matchMedia

function fakeMatchMedia(query: string): MediaQueryList {
  return {
    matches: media.narrow, media: query, onchange: null,
    addEventListener: (_: string, l: Listener) => { media.listeners.add(l) },
    removeEventListener: (_: string, l: Listener) => { media.listeners.delete(l) },
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  } as unknown as MediaQueryList
}

/** The window crosses the 900px threshold. */
function resize(narrow: boolean) {
  media.narrow = narrow
  act(() => { for (const l of [...media.listeners]) l({ matches: narrow } as MediaQueryListEvent) })
}

function mountShell() {
  const user = userEvent.setup()
  const r = render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<h1>Dashboard page</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
  return { ...r, user }
}

const sidebarToggle = () => screen.getByRole('button', { name: /sidebar/ })
const contentColumn = () => screen.getByRole('main').parentElement as HTMLElement

beforeEach(() => {
  apolloFinto.reset()
  media.narrow = false
  media.listeners.clear()
  window.matchMedia = fakeMatchMedia
  mockKeycloak.authenticated = true
  mockKeycloak.login.mockClear()
})

afterEach(() => {
  window.matchMedia = originalMatchMedia
  mockKeycloak.authenticated = true
})

describe('AppLayout', () => {
  it('without a session it sends the user to the login and shows nothing of the app', () => {
    mockKeycloak.authenticated = false
    mountShell()
    expect(mockKeycloak.login).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Dashboard page')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('with a session: menu, top bar and the page inside the main landmark', () => {
    mountShell()
    expect(mockKeycloak.login).not.toHaveBeenCalled()
    expect(screen.getByRole('navigation', { name: 'Main menu' })).toBeInTheDocument()
    expect(screen.getByText('Top bar')).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content')
    expect(screen.getByRole('main')).toContainElement(screen.getByRole('heading', { name: 'Dashboard page' }))
  })

  it('asks for the tenant language when the shell mounts', () => {
    mountShell()
    expect(apolloFinto.chiamate['GetTenantLanguageSettings']).toHaveLength(1)
  })

  it('the skip link jumps to the content and shows itself only while it has the focus', async () => {
    const { user } = mountShell()
    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(skip).toHaveAttribute('href', '#main-content')
    expect(skip).toHaveStyle({ top: '-40px' })
    await user.tab()
    expect(skip).toHaveFocus()
    expect(skip).toHaveStyle({ top: '16px' })
    await user.tab()
    expect(skip).not.toHaveFocus()
    expect(skip).toHaveStyle({ top: '-40px' })
  })

  it('on a wide window the sidebar starts open, and the content sits beside it', () => {
    mountShell()
    expect(sidebarToggle()).toHaveTextContent('Collapse sidebar')
    expect(screen.getByRole('navigation')).toHaveStyle({ width: '240px' })
    expect(contentColumn()).toHaveStyle({ marginLeft: '240px' })
  })

  it('on a narrow window the sidebar starts closed', () => {
    media.narrow = true
    mountShell()
    expect(sidebarToggle()).toHaveTextContent('Expand sidebar')
    expect(screen.getByRole('navigation')).toHaveStyle({ width: '56px' })
    expect(contentColumn()).toHaveStyle({ marginLeft: '56px' })
  })

  it('the user can close and reopen the sidebar, and the content follows', async () => {
    const { user } = mountShell()
    await user.click(sidebarToggle())
    expect(sidebarToggle()).toHaveTextContent('Expand sidebar')
    expect(contentColumn()).toHaveStyle({ marginLeft: '56px' })
    await user.click(sidebarToggle())
    expect(sidebarToggle()).toHaveTextContent('Collapse sidebar')
    expect(contentColumn()).toHaveStyle({ marginLeft: '240px' })
  })

  it('shrinking the window closes the sidebar; widening it again leaves the choice to the user', async () => {
    const { user } = mountShell()
    resize(true)
    expect(sidebarToggle()).toHaveTextContent('Expand sidebar')
    resize(false)
    expect(sidebarToggle()).toHaveTextContent('Expand sidebar')
    await user.click(sidebarToggle())
    expect(sidebarToggle()).toHaveTextContent('Collapse sidebar')
  })

  it('stops listening to the window size once the shell is gone', () => {
    const { unmount } = mountShell()
    expect(media.listeners.size).toBe(1)
    unmount()
    expect(media.listeners.size).toBe(0)
  })

  it('a browser without matchMedia still gets the shell, with the sidebar open', () => {
    // @ts-expect-error — an old or embedded browser without the API
    window.matchMedia = undefined
    mountShell()
    expect(sidebarToggle()).toHaveTextContent('Collapse sidebar')
    expect(screen.getByText('Dashboard page')).toBeInTheDocument()
  })
})
