/**
 * NotificationPanel (revisione 2, D3.2): il click su una notifica porta alla
 * pagina dell'entità secondo la tabella condivisa `entity_type → percorso`
 * (`@opengraphity/types`, la stessa dei link delle email): servizi, sorgenti,
 * allarmi e CI compresi. Una notifica senza pagina non è cliccabile.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { NotificationPanel } from './NotificationPanel'
import { renderWithProviders } from '@/test/utils'
import type { InAppNotification } from '@/hooks/useNotifications'

const markAsRead = vi.fn()
let notifications: InAppNotification[] = []

vi.mock('@/contexts/NotificationContext', () => ({
  useNotificationContext: () => ({ notifications, unreadCount: 0, connected: true, markAsRead, markAllAsRead: vi.fn(), clearAll: vi.fn() }),
}))

function notif(id: string, entity_type: string | undefined, entity_id: string | undefined, over: Partial<InAppNotification> = {}): InAppNotification {
  return { id, type: 'x', title: `title.${id}`, message: `msg ${id}`, severity: 'info', entity_type, entity_id, timestamp: new Date().toISOString(), read: false, ...over }
}

const CASES: Array<[string, string, string]> = [
  ['service',         'map-1', '/monitoring/services/map-1'],
  ['inbound_webhook', 'src-1', '/monitoring/sources/src-1'],
  ['event',           'ev-1',  '/events/ev-1'],
  ['ci',              'ci-1',  '/cis/ci-1'],
  ['incident',        'inc-1', '/incidents/inc-1'],
  ['change',          'chg-1', '/changes/chg-1'],
  ['problem',         'prb-1', '/problems/prb-1'],
  ['request',         'req-1', '/requests/req-1'],
]

describe('NotificationPanel — dove porta il click', () => {
  it.each(CASES)('%s → %s', async (entityType, entityId, path) => {
    notifications = [notif('n1', entityType, entityId)]
    const onClose = vi.fn()
    const { user } = renderWithProviders(<NotificationPanel onClose={onClose} />, { route: '/dashboard' })
    const item = screen.getByRole('button', { name: /msg n1/ })
    expect(item).toHaveStyle({ cursor: 'pointer' })
    await user.click(item)
    expect(screen.getByTestId('location')).toHaveTextContent(path)
    expect(markAsRead).toHaveBeenCalledWith('n1')
    expect(onClose).toHaveBeenCalled()
  })

  it('tipo senza pagina (sync) o senza id → nessuna navigazione, cursore normale', async () => {
    notifications = [notif('n2', 'sync', 'run-1'), notif('n3', 'incident', undefined)]
    const { user } = renderWithProviders(<NotificationPanel onClose={vi.fn()} />, { route: '/dashboard' })
    for (const name of [/msg n2/, /msg n3/]) {
      const item = screen.getByRole('button', { name })
      expect(item).toHaveStyle({ cursor: 'default' })
      await user.click(item)
      expect(screen.getByTestId('location')).toHaveTextContent('/dashboard')
    }
  })
})
