/**
 * NOTIFICATION CHANNELS: the Slack and Teams destinations that receive the
 * product's alerts (SLA breach, escalation, assignment, change outcomes).
 *
 * A channel saved wrong is a message that never arrives, and nobody finds
 * out until the SLA breach nobody saw. So these tests pin what is sent — the
 * platform, the webhook or channel id, empty ones as null, the events ticked
 * (three are on by default) — that a refused save keeps what was typed, that
 * a delete asks first, and that «Test» says plainly whether the message got
 * through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { default: NotificationsPage } = await import('./NotificationsPage')

const SLACK = {
  id: 'ch-1', platform: 'slack', name: 'NOC alerts', webhookUrl: 'https://hooks.slack.com/services/T0/B0/x', channelId: null,
  eventTypes: ['sla_breach', 'escalation'], active: true, createdAt: '2026-09-01T00:00:00Z',
}
const TEAMS = {
  id: 'ch-2', platform: 'teams', name: 'Change board', webhookUrl: 'https://outlook.office.com/webhook/abc', channelId: null,
  eventTypes: ['change_approved'], active: true, createdAt: '2026-09-02T00:00:00Z',
}

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetNotificationChannels'] = { notificationChannels: [SLACK, TEAMS] }
})

const show = () => renderWithProviders(<NotificationsPage />)
const dialog = () => within(screen.getByRole('dialog'))
const rowOf = (name: string) => screen.getByText(name).parentElement!.parentElement!
const EVENTS = ['SLA Breach', 'Escalation', 'Assigned to me', 'Incident resolved', 'Change approved', 'Change failed', 'Assessment task assigned']
const ticked = () => EVENTS.filter((e) => (dialog().getByRole('checkbox', { name: e }) as HTMLInputElement).checked)

describe('NotificationsPage — the list', () => {
  it('with no channel, the page says what to add', () => {
    apolloFinto.risposte['GetNotificationChannels'] = { notificationChannels: [] }
    show()
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeInTheDocument()
    expect(screen.getByText('No channel configured. Add Slack or Teams to receive notifications.')).toBeInTheDocument()
  })

  it('before the channels arrive, the list is empty rather than broken', () => {
    apolloFinto.risposte['GetNotificationChannels'] = undefined
    show()
    expect(screen.getByText('No channel configured. Add Slack or Teams to receive notifications.')).toBeInTheDocument()
  })

  it('each channel shows its platform, its name and the events it receives', () => {
    show()
    const slack = rowOf('NOC alerts')
    expect(within(slack).getByText('slack')).toBeInTheDocument()
    expect(within(slack).getByText('sla_breach, escalation')).toBeInTheDocument()
    expect(within(rowOf('Change board')).getByText('teams')).toBeInTheDocument()
  })
})

describe('NotificationsPage — adding and editing', () => {
  it('a new channel starts on Slack with three events ticked, and is sent with empty fields as null', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Add a channel' }))
    expect(dialog().getByText('Add a channel')).toBeInTheDocument()
    expect(dialog().getByRole('button', { name: 'Slack' })).toHaveAttribute('aria-pressed', 'true')
    expect(dialog().getByRole('group', { name: 'Platform' })).toBeInTheDocument()
    expect(ticked()).toEqual(['SLA Breach', 'Escalation', 'Assigned to me'])
    expect(dialog().getByText('Use the webhook URL for public channels, the channel ID if you have configured the bot token.')).toBeInTheDocument()

    await user.type(dialog().getByLabelText('Name'), 'Service desk')
    await user.type(dialog().getByLabelText('Webhook URL'), 'https://hooks.slack.com/services/T1/B1/y')
    await user.click(dialog().getByRole('checkbox', { name: 'Escalation' }))
    await user.click(dialog().getByRole('checkbox', { name: 'Change failed' }))
    await user.click(dialog().getByRole('button', { name: 'Save' }))

    expect(apolloFinto.chiamata('CreateNotificationChannel')).toEqual({ input: {
      platform: 'slack', name: 'Service desk', webhookUrl: 'https://hooks.slack.com/services/T1/B1/y', channelId: null,
      eventTypes: ['sla_breach', 'assigned', 'change_failed'],
    } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a Slack channel can be reached by its channel id instead of a webhook', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Add a channel' }))
    await user.type(dialog().getByLabelText('Name'), 'Bot channel')
    await user.type(dialog().getByLabelText(/^Channel ID/), 'C0123456789')
    await user.click(dialog().getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('CreateNotificationChannel')).toMatchObject({ input: { webhookUrl: null, channelId: 'C0123456789' } })
  })

  it('a Teams channel asks only for its webhook', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Add a channel' }))
    await user.click(dialog().getByRole('button', { name: 'Teams' }))
    expect(dialog().getByRole('button', { name: 'Teams' })).toHaveAttribute('aria-pressed', 'true')
    expect(dialog().queryByLabelText(/^Channel ID/)).toBeNull()
    await user.type(dialog().getByLabelText('Name'), 'Change board')
    await user.type(dialog().getByLabelText('Webhook URL *'), 'https://outlook.office.com/webhook/def')
    await user.click(dialog().getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('CreateNotificationChannel')).toMatchObject({ input: {
      platform: 'teams', name: 'Change board', webhookUrl: 'https://outlook.office.com/webhook/def', channelId: null,
    } })
  })

  it('editing opens the channel as saved and updates THAT channel', async () => {
    const { user } = show()
    await user.click(within(rowOf('NOC alerts')).getByRole('button', { name: 'Edit' }))
    expect(dialog().getByText('Edit the channel')).toBeInTheDocument()
    expect(dialog().getByLabelText('Name')).toHaveValue('NOC alerts')
    expect(dialog().getByLabelText('Webhook URL')).toHaveValue(SLACK.webhookUrl)
    expect(dialog().getByLabelText(/^Channel ID/)).toHaveValue('')
    expect(ticked()).toEqual(['SLA Breach', 'Escalation'])
    await user.clear(dialog().getByLabelText('Name'))
    await user.type(dialog().getByLabelText('Name'), 'NOC night shift')
    await user.click(dialog().getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateNotificationChannel')).toEqual({ id: 'ch-1', input: {
      platform: 'slack', name: 'NOC night shift', webhookUrl: SLACK.webhookUrl, channelId: null, eventTypes: ['sla_breach', 'escalation'],
    } })
    expect(apolloFinto.chiamata('CreateNotificationChannel')).toBeUndefined()
  })

  it('a channel reached by its channel id opens with that id and no webhook, and saves them so', async () => {
    apolloFinto.risposte['GetNotificationChannels'] = { notificationChannels: [
      { ...SLACK, id: 'ch-3', name: 'Bot channel', webhookUrl: null, channelId: 'C0123456789' },
    ] }
    const { user } = show()
    await user.click(within(rowOf('Bot channel')).getByRole('button', { name: 'Edit' }))
    expect(dialog().getByLabelText('Webhook URL')).toHaveValue('')
    expect(dialog().getByLabelText(/^Channel ID/)).toHaveValue('C0123456789')
    await user.click(dialog().getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateNotificationChannel')).toMatchObject({ id: 'ch-3', input: { webhookUrl: null, channelId: 'C0123456789' } })
  })

  it('«Add» after an edit starts from a new, empty channel', async () => {
    const { user } = show()
    await user.click(within(rowOf('Change board')).getByRole('button', { name: 'Edit' }))
    await user.click(dialog().getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: '+ Add a channel' }))
    expect(dialog().getByText('Add a channel')).toBeInTheDocument()
    expect(dialog().getByLabelText('Name')).toHaveValue('')
    expect(dialog().getByRole('button', { name: 'Slack' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('a refused save says why and keeps the dialog open with what was typed', async () => {
    apolloFinto.esiti['CreateNotificationChannel'] = { error: new Error('Invalid webhook URL') }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Add a channel' }))
    await user.type(dialog().getByLabelText('Name'), 'Service desk')
    await user.click(dialog().getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Invalid webhook URL'))
    expect(dialog().getByLabelText('Name')).toHaveValue('Service desk')
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('Cancel closes the dialog without saving', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Add a channel' }))
    await user.click(dialog().getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate['CreateNotificationChannel']).toBeUndefined()
  })

  it('Escape closes the dialog too', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Add a channel' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('NotificationsPage — delete and test', () => {
  it('delete asks first; confirming deletes that channel and reloads the list', async () => {
    const { user } = show()
    await user.click(within(rowOf('Change board')).getByRole('button', { name: 'Delete' }))
    const confirm = within(await screen.findByRole('dialog'))
    expect(confirm.getByText('Delete this channel?')).toBeInTheDocument()
    await user.click(confirm.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteNotificationChannel')).toEqual({ id: 'ch-2' }))
    await waitFor(() => expect(apolloFinto.refetch).toHaveBeenCalled())
  })

  it('declining the confirmation deletes nothing', async () => {
    const { user } = show()
    await user.click(within(rowOf('Change board')).getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamate['DeleteNotificationChannel']).toBeUndefined()
  })

  it('a refused delete says why and does not reload', async () => {
    apolloFinto.esiti['DeleteNotificationChannel'] = { error: new Error('Channel in use') }
    const { user } = show()
    await user.click(within(rowOf('Change board')).getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Channel in use'))
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('«Test» says on the channel whether the message got through', async () => {
    apolloFinto.esiti['TestNotificationChannel'] = { data: { testNotificationChannel: true } }
    const { user } = show()
    await user.click(within(rowOf('NOC alerts')).getByRole('button', { name: 'Test' }))
    expect(apolloFinto.chiamata('TestNotificationChannel')).toEqual({ id: 'ch-1' })
    expect(await within(rowOf('NOC alerts')).findByText('✓ Sent')).toBeInTheDocument()
    // The other channel was not tested: it says nothing.
    expect(within(rowOf('Change board')).queryByText(/Sent|Error/)).toBeNull()

    apolloFinto.esiti['TestNotificationChannel'] = { data: { testNotificationChannel: false } }
    await user.click(within(rowOf('Change board')).getByRole('button', { name: 'Test' }))
    expect(await within(rowOf('Change board')).findByText('✗ Error')).toBeInTheDocument()
  })

  it('a test with no answer, or refused, is a failure too', async () => {
    apolloFinto.esiti['TestNotificationChannel'] = { data: null }
    const { user } = show()
    await user.click(within(rowOf('NOC alerts')).getByRole('button', { name: 'Test' }))
    expect(await within(rowOf('NOC alerts')).findByText('✗ Error')).toBeInTheDocument()

    apolloFinto.esiti['TestNotificationChannel'] = { error: new Error('Webhook returned 404') }
    await user.click(within(rowOf('Change board')).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Webhook returned 404'))
    expect(await within(rowOf('Change board')).findByText('✗ Error')).toBeInTheDocument()
  })
})
