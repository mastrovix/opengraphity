/**
 * THE NOTIFICATIONS PANEL: how it opens, closes, and tells read from unread.
 *
 * The bell's panel is where a person catches up. It must close when they click
 * elsewhere (and only then), say plainly when there is nothing, mark everything
 * read on request, and make the unread ones stand out — a read notification
 * that still looks new is noise, an unread one that looks read is missed. A
 * notification whose title key this web does not know shows the label the event
 * carries, never the raw key; one that arrives without a severity is shown as
 * information, not as an alarm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import type { InAppNotification } from '@/hooks/useNotifications'
import { NotificationPanel } from './NotificationPanel'

const ctx = vi.hoisted(() => ({
  notifications: [] as InAppNotification[],
  markAsRead: vi.fn(),
  markAllAsRead: vi.fn(),
}))

vi.mock('@/contexts/NotificationContext', () => ({
  useNotificationContext: () => ({ ...ctx, unreadCount: 0, connected: true, clearAll: vi.fn() }),
}))

const notif = (id: string, over: Partial<InAppNotification> = {}): InAppNotification => ({
  id, type: 'x', title: `title.${id}`, message: `msg ${id}`, severity: 'info', entity_type: 'incident', entity_id: `inc-${id}`,
  timestamp: '2026-09-01T10:00:00Z', read: false, ...over,
})

const item = (message: string) => screen.getByRole('button', { name: new RegExp(message) })

beforeEach(() => {
  ctx.notifications = []
  ctx.markAsRead.mockReset()
  ctx.markAllAsRead.mockReset()
})

describe('NotificationPanel — opening and closing', () => {
  it('a click outside the panel closes it; a click inside does not', () => {
    ctx.notifications = [notif('n1')]
    const onClose = vi.fn()
    renderWithProviders(<><NotificationPanel onClose={onClose} /><p>Page behind</p></>)
    fireEvent.mouseDown(screen.getByText('Notifications'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(screen.getByText('Page behind'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('with nothing to read it says so, and offers no «Mark all as read»', () => {
    renderWithProviders(<NotificationPanel onClose={vi.fn()} />)
    expect(screen.getByText('No notifications')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull()
  })

  it('«Mark all as read» marks every notification read', async () => {
    ctx.notifications = [notif('n1'), notif('n2')]
    const { user } = renderWithProviders(<NotificationPanel onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(ctx.markAllAsRead).toHaveBeenCalledTimes(1)
  })

  it('the space bar opens a notification like a click (a role="button" must answer to it)', () => {
    ctx.notifications = [notif('n1')]
    const onClose = vi.fn()
    renderWithProviders(<NotificationPanel onClose={onClose} />, { route: '/dashboard' })
    fireEvent.keyDown(item('msg n1'), { key: ' ' })
    expect(ctx.markAsRead).toHaveBeenCalledWith('n1')
    expect(screen.getByTestId('location')).toHaveTextContent('/incidents/inc-n1')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('NotificationPanel — read and unread', () => {
  it('an unread notification is bold with a dot; a read one is plain; hovering highlights and leaving gives back each one\'s own background', () => {
    ctx.notifications = [notif('new'), notif('old', { read: true })]
    renderWithProviders(<NotificationPanel onClose={vi.fn()} />)
    expect(screen.getByText('title.new')).toHaveStyle({ fontWeight: '600' })
    expect(screen.getByText('title.old')).toHaveStyle({ fontWeight: '400' })
    // The unread dot is the only empty span after the time.
    const dot = (el: HTMLElement) => [...el.querySelectorAll('span')].filter((s) => s.textContent === '')
    expect(dot(item('msg new'))).toHaveLength(1)
    expect(dot(item('msg old'))).toHaveLength(0)

    expect(item('msg new')).toHaveStyle({ backgroundColor: 'var(--color-info-light)' })
    expect(item('msg old')).toHaveStyle({ backgroundColor: 'var(--color-white)' })
    for (const [message, own] of [['msg new', 'var(--color-info-light)'], ['msg old', 'var(--color-white)']] as const) {
      fireEvent.mouseEnter(item(message))
      expect(item(message)).toHaveStyle({ backgroundColor: 'var(--color-slate-bg)' })
      fireEvent.mouseLeave(item(message))
      expect(item(message)).toHaveStyle({ backgroundColor: own })
    }
  })
})

describe('NotificationPanel — what a notification shows', () => {
  it('a title key the web does not know shows the label the event carries, never the key', () => {
    ctx.notifications = [notif('s1', { title: 'notification.step.vendor_wait', title_fallback: 'Waiting for the vendor' })]
    renderWithProviders(<NotificationPanel onClose={vi.fn()} />)
    expect(screen.getByText('Waiting for the vendor')).toBeInTheDocument()
    expect(screen.queryByText('notification.step.vendor_wait')).toBeNull()
  })

  it('a change carries the change icon; a notification without a severity is information, not an alarm', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    ctx.notifications = [
      notif('c1', { entity_type: 'change', entity_id: 'chg-1', severity: 'error' }),
      notif('i1', { severity: undefined as unknown as InAppNotification['severity'] }),
    ]
    renderWithProviders(<NotificationPanel onClose={vi.fn()} />)
    expect(item('msg c1').querySelector('svg.lucide-git-pull-request')).not.toBeNull()
    const bell = item('msg i1').querySelector('svg.lucide-bell')
    expect(bell).not.toBeNull()
    expect(bell).toHaveAttribute('stroke', 'var(--color-trigger-manual)')
    expect(item('msg i1').querySelector('svg.lucide-triangle-alert')).toBeNull()
    expect(error).not.toHaveBeenCalled()
  })
})
