/**
 * The notification bell and panel read from this context. The provider must
 * hand down exactly what the realtime hook reports (unread count, channel
 * state, actions); outside a provider the defaults must be a safe "nothing,
 * disconnected" rather than a crash.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotificationProvider, useNotificationContext } from './NotificationContext'

const markAsRead = vi.fn()
vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => ({
    notifications: [{ id: 'n1', type: 'x', title: 't', message: 'Disk full', severity: 'error', timestamp: '2026-09-22T00:00:00Z', read: false }],
    unreadCount: 1,
    connected: true,
    markAsRead,
    markAllAsRead: vi.fn(),
    clearAll: vi.fn(),
  }),
}))

function Probe() {
  const ctx = useNotificationContext()
  return (
    <div>
      <span>{`unread:${ctx.unreadCount} connected:${String(ctx.connected)} items:${ctx.notifications.length}`}</span>
      <button type="button" onClick={() => { ctx.markAsRead('n1'); ctx.markAllAsRead(); ctx.clearAll() }}>act</button>
    </div>
  )
}

describe('NotificationContext', () => {
  it('outside a provider: empty, disconnected, and the actions are harmless', async () => {
    render(<Probe />)
    expect(screen.getByText('unread:0 connected:false items:0')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'act' }))
  })

  it('inside the provider: the realtime hook state reaches consumers', async () => {
    render(<NotificationProvider><Probe /></NotificationProvider>)
    expect(screen.getByText('unread:1 connected:true items:1')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'act' }))
    expect(markAsRead).toHaveBeenCalledWith('n1')
  })
})
