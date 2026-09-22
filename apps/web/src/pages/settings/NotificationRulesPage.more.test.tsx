/**
 * NotificationRulesPage: the write paths (toggle a rule, create one, delete
 * one) and the retry of the routing table. The read paths are covered by
 * NotificationRulesPage.test.tsx. What breaks for an admin if these regress:
 * a toggle that never reaches the server, a new rule whose dialog never
 * closes, a custom rule deleted without asking, or a page stuck on the
 * routing error with no way to try again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import NotificationRulesPage from './NotificationRulesPage'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

function rule(id: string, eventType: string, over: Record<string, unknown> = {}) {
  return {
    id, eventType, enabled: true, severityOverride: 'info', titleKey: `notification.${eventType}.title`,
    channels: ['in_app'], target: 'all', conditions: null, isSeed: true,
    stepPurpose: null, stepCategory: null, eventProduced: true,
    escalationDelayMinutes: null, escalationTarget: null, escalationMessage: null,
    slaWarningThresholdPercent: null, slaWarningTarget: null, digestTime: null, digestRecipients: null,
    ...over,
  }
}

const ROUTING = {
  notificationRouting: {
    defaultChannels: ['in_app', 'email'],
    byEventType: [],
    defaultTargets: ['all'],
    targetsByEventType: [],
  },
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetMe'] = { me: { id: 'u-1', role: 'admin', permissions: [], teams: [] } }
  apolloFinto.risposte['GetNotificationRouting'] = ROUTING
  apolloFinto.risposte['GetWorkflowEventTypes'] = { workflowEventTypes: [] }
  apolloFinto.risposte['GetNotificationRules'] = {
    notificationRules: [
      rule('r1', 'incident.created'),
      rule('r9', 'acme.custom_event', { isSeed: false }),
    ],
  }
})

describe('NotificationRulesPage — writes', () => {
  it('turning a rule off sends the update for that rule and reloads the list', async () => {
    const { user } = renderWithProviders(<NotificationRulesPage />)
    const row = screen.getAllByText('incident.created')[0]!.closest('tr')!
    await user.click(within(row).getByRole('switch'))
    // The row debounces its edits (500 ms) before sending them.
    await waitFor(() => expect(apolloFinto.chiamata('UpdateNotificationRule')).toEqual({ id: 'r1', input: { enabled: false } }))
    await waitFor(() => expect(apolloFinto.refetch).toHaveBeenCalled())
  })

  it('a custom rule is deleted only after confirming', async () => {
    const { user } = renderWithProviders(<NotificationRulesPage />)
    // Custom rules (event types outside the standard list) get their own section.
    expect(screen.getByRole('heading', { name: 'Custom' })).toBeInTheDocument()
    const row = screen.getAllByText('acme.custom_event')[0]!.closest('tr')!

    await user.click(within(row).getByTitle('Delete rule'))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(apolloFinto.chiamate['DeleteNotificationRule']).toBeUndefined()

    await user.click(within(row).getByTitle('Delete rule'))
    // A danger confirmation: the button says what it does.
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteNotificationRule')).toEqual({ id: 'r9' }))
  })

  it('creates a rule from the dialog and closes it on success', async () => {
    const { user } = renderWithProviders(<NotificationRulesPage />)
    await user.click(screen.getByRole('button', { name: 'New rule' }))
    const dialog = screen.getByRole('dialog')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Event type' }), 'incident.created')
    await user.type(within(dialog).getByRole('textbox', { name: /title/i }), 'notification.x.title')
    // In-app is ticked by default; add e-mail.
    await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    const sent = apolloFinto.chiamata('CreateNotificationRule') as { input: Record<string, unknown> }
    expect(sent.input).toMatchObject({ eventType: 'incident.created', titleKey: 'notification.x.title', channels: ['in_app', 'email'] })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('the dialog closes without saving', async () => {
    const { user } = renderWithProviders(<NotificationRulesPage />)
    await user.click(screen.getByRole('button', { name: 'New rule' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate['CreateNotificationRule']).toBeUndefined()
  })
})

describe('NotificationRulesPage — routing error', () => {
  it('offers a retry that reloads the routing table', async () => {
    apolloFinto.erroriQuery['GetNotificationRouting'] = new Error('routing unavailable')
    const { user } = renderWithProviders(<NotificationRulesPage />)
    expect(screen.getByText(/routing unavailable/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
