/**
 * THE TOP BAR: who is signed in, the bell, the user menu.
 *
 * Why these behaviours matter to every user, on every page:
 *  - the avatar initials and the name come from the Keycloak token, whatever
 *    it carries (full name, a single name, only an e-mail): a blank avatar
 *    or «undefined» is the first thing anyone sees;
 *  - the bell says how many notifications are unread (capped at «9+») and
 *    shows an amber dot when the realtime channel is DOWN, so silence is not
 *    mistaken for «nothing happened»;
 *  - «Settings» is offered only to a role whose permissions open that page:
 *    offering it to everyone meant a click that ends on «access denied»;
 *  - «Logout» really logs out, back to the application root.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { mockKeycloak } from '@/test/mocks/keycloak'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const notifications = vi.hoisted(() => ({ unreadCount: 0, connected: true }))
vi.mock('@/contexts/NotificationContext', () => ({
  useNotificationContext: () => ({
    notifications: [], markAsRead: () => {}, markAllAsRead: () => {}, clearAll: () => {}, ...notifications,
  }),
}))
// The children with their own queries and tests are not what this file is about.
vi.mock('./GlobalSearch', () => ({ GlobalSearch: () => null }))
vi.mock('./TopbarConfigurationIssues', () => ({ TopbarConfigurationIssues: () => null }))
vi.mock('@/components/ui/NotificationPanel', () => ({
  NotificationPanel: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Notification panel"><button type="button" onClick={onClose}>close panel</button></div>
  ),
}))

const { Topbar, Breadcrumb } = await import('./Topbar')

const ORIGINAL_TOKEN = mockKeycloak.tokenParsed
const setToken = (claims: Record<string, unknown> | undefined) => {
  (mockKeycloak as { tokenParsed: unknown }).tokenParsed = claims
}
const me = (permissions: string[]) => {
  apolloFinto.risposte['GetMe'] = {
    me: { id: 'u1', name: 'X', email: 'x@y', role: 'r', roleName: null, permissions, slackId: null, emailNotifications: null, language: null, teams: [] },
  }
}

beforeEach(() => {
  apolloFinto.reset()
  notifications.unreadCount = 0
  notifications.connected = true
  mockKeycloak.logout.mockClear()
  me([])
})
afterEach(() => { setToken(ORIGINAL_TOKEN) })

const userMenu = () => screen.getByRole('button', { name: /^User menu/ })

describe('Topbar — who is signed in', () => {
  it.each([
    ['a full name', { name: 'Ada King Lovelace', email: 'ada@acme.com' }, 'AL', 'Ada King Lovelace'],
    ['a single name', { name: 'Ada', email: 'ada@acme.com' }, 'AD', 'Ada'],
    ['only a username', { preferred_username: 'operator1' }, 'OP', 'operator1'],
    ['only an e-mail', { email: 'zed@acme.com' }, 'ZE', 'zed'],
  ])('with %s the initials and the display name are sensible', (_label, claims, initials, display) => {
    setToken(claims)
    renderWithProviders(<Topbar />)
    expect(userMenu()).toHaveAccessibleName(`User menu (${display})`)
    expect(userMenu()).toHaveTextContent(`${initials}${display}`)
  })

  it('with no claims at all the name is a dash, never «undefined»', () => {
    setToken(undefined)
    renderWithProviders(<Topbar />)
    expect(userMenu()).toHaveAccessibleName('User menu (—)')
  })
})

describe('Topbar — the bell', () => {
  it('no unread and a live channel: a plain bell, no badge, no warning dot', () => {
    renderWithProviders(<Topbar />)
    const bell = screen.getByRole('button', { name: 'Notifications' })
    expect(bell.textContent).toBe('')
    expect(screen.queryByTitle('Real-time notifications disconnected')).not.toBeInTheDocument()
  })

  it('unread notifications are counted, and more than nine read «9+»', () => {
    notifications.unreadCount = 4
    const { unmount } = renderWithProviders(<Topbar />)
    expect(screen.getByRole('button', { name: 'Notifications, 4 unread' })).toHaveTextContent('4')
    unmount()
    notifications.unreadCount = 12
    renderWithProviders(<Topbar />)
    expect(screen.getByRole('button', { name: 'Notifications, 12 unread' })).toHaveTextContent('9+')
  })

  it('a dropped realtime channel is shown on the bell', () => {
    notifications.connected = false
    renderWithProviders(<Topbar />)
    expect(screen.getByRole('status', { name: 'Real-time notifications disconnected' })).toBeInTheDocument()
  })

  it('the bell opens and closes the panel, and the panel can close itself', async () => {
    const { user } = renderWithProviders(<Topbar />)
    const bell = screen.getByRole('button', { name: 'Notifications' })
    await user.click(bell)
    expect(bell).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'close panel' }))
    expect(screen.queryByRole('dialog', { name: 'Notification panel' })).not.toBeInTheDocument()
    expect(bell).toHaveAttribute('aria-expanded', 'false')
    await user.click(bell)
    await user.click(bell)
    expect(screen.queryByRole('dialog', { name: 'Notification panel' })).not.toBeInTheDocument()
  })
})

describe('Topbar — the user menu', () => {
  it('without the notification settings permission there is no «Settings»; Profile navigates', async () => {
    const { user } = renderWithProviders(<Topbar />)
    await user.click(userMenu())
    expect(await screen.findByRole('menuitem', { name: 'Profile' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Settings' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Profile' }))
    await attendiURL('/profile')
  })

  it('with the permission «Settings» is offered and opens the notification settings', async () => {
    me(['config.notifications'])
    const { user } = renderWithProviders(<Topbar />)
    await user.click(userMenu())
    await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
    await attendiURL('/settings/notifications')
  })

  it('«Logout» ends the Keycloak session and comes back to the root', async () => {
    const { user } = renderWithProviders(<Topbar />)
    await user.click(userMenu())
    await user.click(await screen.findByRole('menuitem', { name: 'Logout' }))
    await waitFor(() => expect(mockKeycloak.logout).toHaveBeenCalledWith({ redirectUri: `${window.location.origin}/` }))
  })
})

describe('Breadcrumb — the bits the menu tests do not touch', () => {
  it('the root is the dashboard', () => {
    renderWithProviders(<Breadcrumb />, { route: '/' })
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('a crumb link darkens on hover and returns muted after', () => {
    renderWithProviders(<Breadcrumb />, { route: '/some-page/123' })
    const link = screen.getByRole('link', { name: 'Some-page' })
    const muted = link.style.color
    fireEvent.mouseEnter(link)
    expect(link.style.color).not.toBe(muted)
    fireEvent.mouseLeave(link)
    expect(link.style.color).toBe(muted)
    // A numeric id is a «Detail», not a raw number.
    expect(screen.getByText('Detail')).toHaveAttribute('aria-current', 'page')
  })

  it('under a menu page, the segments below it link back up to that page', () => {
    renderWithProviders(<Breadcrumb />, { route: '/incidents/0f8e2a64-1c3b-4a9e-9d2f-5b7c6e4a3d21' })
    expect(screen.getByRole('link', { name: 'Incidents' })).toHaveAttribute('href', '/incidents')
    // A uuid is a «Detail» too.
    expect(screen.getByText('Detail')).toHaveAttribute('aria-current', 'page')
  })
})
