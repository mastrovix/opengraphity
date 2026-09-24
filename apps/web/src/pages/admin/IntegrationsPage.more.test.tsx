/**
 * INTEGRATIONS: WHAT AN ADMINISTRATOR DOES WITH A WEBHOOK OR AN API KEY.
 *
 * The page is where credentials are born. A token or an API key is shown
 * ONCE, in the "secret" dialog, right after creation or regeneration: if that
 * dialog does not open, or opens empty, the administrator holds a webhook
 * nobody can call and has to delete it and start again. A test run against an
 * outbound webhook must say whether the far end answered, and with what. A
 * new API key with an empty expiry must be sent as "never expires" (null),
 * never as the empty string the server rejects.
 *
 * `IntegrationsPage.test.tsx` covers the inbound endpoint column; this file
 * covers the writes on all three tabs, through the fake Apollo (the page has
 * four queries and twelve mutations: what matters is what it does with the
 * answers, not the wire).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))
// Slack has its own test file; here only "the Slack tab shows the Slack section" matters.
vi.mock('./SlackSection', () => ({ SlackSection: () => <div data-testid="slack-section" /> }))

const { IntegrationsPage } = await import('./IntegrationsPage')

const INBOUND = [
  { id: 'wh1', name: 'Jira incidents', entityType: 'incident', connectorKind: null, fieldMapping: '{}', defaultValues: '{}', transformScript: null, enabled: true, lastReceivedAt: null, receiveCount: 7, createdAt: '2026-09-01T00:00:00Z' },
  { id: 'wh2', name: 'Prometheus prod', entityType: 'event', connectorKind: 'alertmanager', fieldMapping: '{}', defaultValues: '{}', transformScript: null, enabled: false, lastReceivedAt: null, receiveCount: 0, createdAt: '2026-09-02T00:00:00Z' },
  { id: 'wh3', name: 'Custom thing', entityType: 'custom_kind', connectorKind: null, fieldMapping: '{}', defaultValues: '{}', transformScript: null, enabled: true, lastReceivedAt: null, receiveCount: 0, createdAt: '2026-09-02T00:00:00Z' },
]
const OUTBOUND = [
  { id: 'o1', name: 'Teams hook', url: 'https://teams.example/hook', method: 'POST', headers: '{}', events: ['incident.created'], payloadTemplate: null, enabled: true, lastSentAt: null, lastStatusCode: 200, sendCount: 4, errorCount: 0, lastError: null, retryOnFailure: true },
  // `events` may arrive as a JSON string from older rows: it must still render as pills.
  { id: 'o2', name: 'Legacy hook', url: 'https://legacy.example', method: 'PUT', headers: '{}', events: '["sla.breached","change.approved"]', payloadTemplate: null, enabled: false, lastSentAt: null, lastStatusCode: 500, sendCount: 2, errorCount: 2, lastError: 'ECONNREFUSED', retryOnFailure: false },
  { id: 'o3', name: 'Never sent', url: 'https://new.example', method: 'POST', headers: '{}', events: [], payloadTemplate: null, enabled: true, lastSentAt: null, lastStatusCode: null, sendCount: 0, errorCount: 0, lastError: null, retryOnFailure: true },
]
const KEYS = [
  { id: 'k1', name: 'CI robot', keyPrefix: 'og_abc', permissions: ['incidents:read'], rateLimit: 100, enabled: true, lastUsedAt: null, requestCount: 12, createdBy: 'u1', expiresAt: null, createdAt: '2026-09-01T00:00:00Z' },
  { id: 'k2', name: 'Old importer', keyPrefix: 'og_old', permissions: '["changes:read","problems:write"]', rateLimit: 50, enabled: false, lastUsedAt: null, requestCount: 0, createdBy: null, expiresAt: null, createdAt: '2026-09-01T00:00:00Z' },
]

beforeEach(() => {
  apolloFinto.reset()
  Object.values(toast).forEach((f) => f.mockReset())
  apolloFinto.risposte['InboundWebhooks'] = { inboundWebhooks: INBOUND }
  apolloFinto.risposte['OutboundWebhooks'] = { outboundWebhooks: OUTBOUND }
  apolloFinto.risposte['ApiKeys'] = { apiKeys: KEYS }
  apolloFinto.risposte['GetWorkflowEventTypes'] = { workflowEventTypes: [
    // A product event also returned by the workflow list must not appear twice.
    { eventType: 'incident.created', stepLabel: null, stable: true },
    { eventType: 'incident.step_entered', stepLabel: null, stable: true },
    { eventType: 'incident.step.triage', stepLabel: 'Triage', stable: false },
  ] }
})

const show = (route = '/admin/integrations') => renderWithProviders(<IntegrationsPage />, { route })
const rowOf = (name: string) => screen.getByText(name).closest('tr')!
const dialog = () => screen.getByRole('dialog')

async function confirmDialog(user: ReturnType<typeof show>['user'], answer: string) {
  const d = await screen.findByRole('dialog')
  await user.click(within(d).getByRole('button', { name: answer }))
}

describe('tabs', () => {
  it('the tab lives in the URL: an unknown value opens Webhook In, ?tab=slack opens Slack', async () => {
    const { user, unmount } = show('/admin/integrations?tab=nonsense')
    expect(await screen.findByText('Jira incidents')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Slack' }))
    // Returning from Slack's OAuth must reopen this tab: the choice is written in the address.
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('tab=slack'))
    expect(screen.getByTestId('slack-section')).toBeInTheDocument()
    unmount()
    show('/admin/integrations?tab=slack')
    expect(screen.getByTestId('slack-section')).toBeInTheDocument()
    expect(screen.queryByText('Jira incidents')).not.toBeInTheDocument()
  })
})

describe('inbound webhooks', () => {
  it('the entity column uses the same names as the filter, and an unknown kind shows as-is', async () => {
    show()
    await screen.findByText('Jira incidents')
    expect(within(rowOf('Jira incidents')).getByText('Incident')).toBeInTheDocument()
    expect(within(rowOf('Prometheus prod')).getByText('Event')).toBeInTheDocument()
    expect(within(rowOf('Prometheus prod')).getByText('alertmanager')).toBeInTheDocument()
    expect(within(rowOf('Custom thing')).getByText('custom_kind')).toBeInTheDocument()
    expect(within(rowOf('Jira incidents')).getByText('7')).toBeInTheDocument()
  })

  it('creating one shows its token once, copyable, and the dialog forgets it on close', async () => {
    apolloFinto.esiti['CreateInboundWebhook'] = { data: { createInboundWebhook: { id: 'wh9', token: 'tok-secret-1' } } }
    const { user } = show()
    await screen.findByText('Jira incidents')
    await user.click(screen.getByRole('button', { name: 'New inbound webhook' }))
    const create = within(dialog()).getByRole('button', { name: 'Create' })
    expect(create).toBeDisabled() // a webhook without a name cannot be told apart in the list
    await user.type(within(dialog()).getByLabelText('Name'), 'Zabbix')
    // The allowed targets follow the entity type: problem has priority, not severity.
    expect(dialog()).toHaveTextContent(/Allowed targets: title, description, severity/)
    await user.selectOptions(within(dialog()).getByLabelText('Entity type'), 'problem')
    expect(dialog()).toHaveTextContent(/Allowed targets: title, description, priority, category\./)
    const mapping = within(dialog()).getByLabelText('Field mapping (JSON)')
    await user.clear(mapping)
    await user.type(mapping, '{{"t":"title"}')
    await user.clear(within(dialog()).getByLabelText('Default values (JSON)'))
    await user.type(within(dialog()).getByLabelText('Transform script'), 'return x')
    await user.click(create)

    expect(apolloFinto.chiamata('CreateInboundWebhook')).toEqual({ input: {
      name: 'Zabbix', entityType: 'problem', fieldMapping: '{"t":"title"}', defaultValues: '', transformScript: 'return x',
    } })
    expect(apolloFinto.refetch).toHaveBeenCalled()
    const secret = await screen.findByRole('dialog', { name: 'Generated credential' })
    expect(within(secret).getByRole('alert')).toHaveTextContent('will not be shown again')
    expect(within(secret).getByText('tok-secret-1')).toBeInTheDocument()
    await user.click(within(secret).getByRole('button', { name: 'Copy' }))
    expect(await navigator.clipboard.readText()).toBe('tok-secret-1')
    expect(toast.success).toHaveBeenCalledWith('Copied!')
    await user.click(within(secret).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // Reopening the form starts clean: the previous webhook's values are gone.
    await user.click(screen.getByRole('button', { name: 'New inbound webhook' }))
    expect(within(dialog()).getByLabelText('Name')).toHaveValue('')
    expect(within(dialog()).getByLabelText('Entity type')).toHaveValue('incident')
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a creation answer without a token is an error, not an empty secret dialog', async () => {
    apolloFinto.esiti['CreateInboundWebhook'] = { data: { createInboundWebhook: { id: 'wh9', token: null } } }
    const { user } = show()
    await screen.findByText('Jira incidents')
    await user.click(screen.getByRole('button', { name: 'New inbound webhook' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Zabbix')
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Webhook creation failed: Webhook created but the token is missing in the response'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a refused creation says why', async () => {
    apolloFinto.esiti['CreateInboundWebhook'] = { error: new Error('target "foo" not allowed') }
    const { user } = show()
    await screen.findByText('Jira incidents')
    await user.click(screen.getByRole('button', { name: 'New inbound webhook' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Zabbix')
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Webhook creation failed: target "foo" not allowed'))
    // The form stays open with what was typed, so the admin can fix it.
    expect(within(dialog()).getByLabelText('Name')).toHaveValue('Zabbix')
  })

  it('the switch flips the webhook, the delete asks first, and only a yes deletes', async () => {
    const { user } = show()
    await screen.findByText('Jira incidents')
    await user.click(screen.getByRole('switch', { name: 'Toggle Jira incidents' }))
    expect(apolloFinto.chiamata('UpdateInboundWebhook')).toEqual({ id: 'wh1', input: { enabled: false } })
    await user.click(screen.getByRole('switch', { name: 'Toggle Prometheus prod' }))
    expect(apolloFinto.chiamata('UpdateInboundWebhook')).toEqual({ id: 'wh2', input: { enabled: true } })

    await user.click(within(rowOf('Jira incidents')).getByRole('button', { name: 'Delete' }))
    await confirmDialog(user, 'Cancel')
    expect(apolloFinto.chiamata('DeleteInboundWebhook')).toBeUndefined()
    await user.click(within(rowOf('Jira incidents')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('dialog', { name: 'Delete this webhook?' })).toHaveTextContent('Jira incidents')
    await confirmDialog(user, 'Delete')
    await waitFor(() => expect(apolloFinto.chiamata('DeleteInboundWebhook')).toEqual({ id: 'wh1' }))
    expect(toast.success).toHaveBeenCalledWith('Webhook deleted')
  })

  it('regenerating a token shows the new one; a missing token or a failure is said', async () => {
    const { user } = show()
    await screen.findByText('Jira incidents')
    // Asked first (review of 23 Sep 2026): the old token stops working at once.
    const regen = async () => {
      await user.click(within(rowOf('Jira incidents')).getByRole('button', { name: 'Regenerate the token of Jira incidents' }))
      await confirmDialog(user, 'Regenerate token')
    }

    await user.click(within(rowOf('Jira incidents')).getByRole('button', { name: 'Regenerate the token of Jira incidents' }))
    expect(await screen.findByRole('dialog', { name: 'Regenerate the token of «Jira incidents»?' })).toHaveTextContent('stops working at once')
    await confirmDialog(user, 'Cancel')
    expect(apolloFinto.chiamate['RegenerateWebhookToken']).toBeUndefined()

    apolloFinto.esiti['RegenerateWebhookToken'] = { data: { regenerateWebhookToken: { token: 'tok-new' } } }
    await regen()
    expect(await screen.findByText('tok-new')).toBeInTheDocument()
    expect(apolloFinto.chiamata('RegenerateWebhookToken')).toEqual({ id: 'wh1' })
    await user.click(within(dialog()).getByRole('button', { name: 'Close' }))

    apolloFinto.esiti['RegenerateWebhookToken'] = { data: { regenerateWebhookToken: null } }
    await regen()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Token regeneration failed: regenerateWebhookToken: token missing in the response'))

    apolloFinto.esiti['RegenerateWebhookToken'] = { error: new Error('forbidden') }
    await regen()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Token regeneration failed: forbidden'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('outbound webhooks', () => {
  async function openTab() {
    const r = show('/admin/integrations?tab=outbound')
    await screen.findByText('Teams hook')
    return r
  }

  it('each row shows its events, whether the last send worked, and the last error', async () => {
    await openTab()
    const teams = rowOf('Teams hook')
    expect(within(teams).getByText('incident.created')).toBeInTheDocument()
    expect(within(teams).getByText('200')).toBeInTheDocument()
    const legacy = rowOf('Legacy hook')
    expect(within(legacy).getByText('sla.breached')).toBeInTheDocument()
    expect(within(legacy).getByText('change.approved')).toBeInTheDocument()
    expect(within(legacy).getByText('500')).toBeInTheDocument()
    expect(within(legacy).getByText('ECONNREFUSED')).toBeInTheDocument()
    // Never sent: no status and no error, a dash rather than an empty cell.
    expect(within(rowOf('Never sent')).getAllByText('—')).toHaveLength(2)
  })

  it('a test says the status on success, the far end\'s error on failure, and an empty answer is an error', async () => {
    const { user } = await openTab()
    const test = () => user.click(within(rowOf('Teams hook')).getByRole('button', { name: 'Test' }))

    apolloFinto.esiti['TestOutboundWebhook'] = { data: { testOutboundWebhook: { success: true, statusCode: 204, error: null } } }
    await test()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Test OK — status 204'))
    expect(apolloFinto.chiamata('TestOutboundWebhook')).toEqual({ id: 'o1' })

    apolloFinto.esiti['TestOutboundWebhook'] = { data: { testOutboundWebhook: { success: false, statusCode: 502, error: 'Bad gateway' } } }
    await test()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Test failed: Bad gateway'))

    apolloFinto.esiti['TestOutboundWebhook'] = { data: {} }
    await test()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Webhook test failed: empty response'))

    apolloFinto.esiti['TestOutboundWebhook'] = { error: new Error('timeout') }
    await test()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Webhook test failed: timeout'))
  })

  it('the switch and the delete act on the right webhook', async () => {
    const { user } = await openTab()
    await user.click(screen.getByRole('switch', { name: 'Toggle Legacy hook' }))
    expect(apolloFinto.chiamata('UpdateOutboundWebhook')).toEqual({ id: 'o2', input: { enabled: true } })
    await user.click(within(rowOf('Legacy hook')).getByRole('button', { name: 'Delete' }))
    await confirmDialog(user, 'Delete')
    await waitFor(() => expect(apolloFinto.chiamata('DeleteOutboundWebhook')).toEqual({ id: 'o2' }))
    expect(toast.success).toHaveBeenCalledWith('Webhook deleted')
    await user.click(within(rowOf('Teams hook')).getByRole('button', { name: 'Delete' }))
    await confirmDialog(user, 'Cancel')
    expect(apolloFinto.chiamate['DeleteOutboundWebhook']).toHaveLength(1)
  })

  it('the form offers product events plus the tenant\'s workflow steps, once each, and sends what was chosen', async () => {
    apolloFinto.esiti['CreateOutboundWebhook'] = { data: { createOutboundWebhook: { id: 'o9' } } }
    const { user } = await openTab()
    await user.click(screen.getByRole('button', { name: 'New outbound webhook' }))
    const d = dialog()
    const create = within(d).getByRole('button', { name: 'Create' })
    await user.type(within(d).getByLabelText('Name'), 'Pager')
    expect(create).toBeDisabled() // a webhook needs somewhere to send to
    await user.type(within(d).getByLabelText('URL'), 'https://pager.example')
    expect(create).toBeEnabled()
    await user.selectOptions(within(d).getByLabelText('Method'), 'PATCH')
    await user.clear(within(d).getByLabelText('Headers (JSON)'))
    // D-22: a workflow step is subscribable, with its label next to the technical type.
    expect(within(d).getAllByRole('checkbox', { name: 'incident.created' })).toHaveLength(1)
    await user.click(within(d).getByRole('checkbox', { name: 'incident.step.triage — Triage' }))
    await user.click(within(d).getByRole('checkbox', { name: 'incident.step_entered' }))
    await user.click(within(d).getByRole('checkbox', { name: 'sla.breached' }))
    await user.click(within(d).getByRole('checkbox', { name: 'incident.step_entered' })) // and off again
    await user.type(within(d).getByLabelText('Payload template'), 'tpl')
    await user.type(within(d).getByLabelText('Secret'), 's3')
    await user.click(within(d).getByRole('checkbox', { name: 'Retry on failure' }))
    await user.click(create)

    expect(apolloFinto.chiamata('CreateOutboundWebhook')).toEqual({ input: {
      name: 'Pager', url: 'https://pager.example', method: 'PATCH', headers: '',
      events: ['incident.step.triage', 'sla.breached'], payloadTemplate: 'tpl', secret: 's3', retryOnFailure: false,
    } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Outbound webhook created'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a refused creation keeps the form open and says why', async () => {
    apolloFinto.esiti['CreateOutboundWebhook'] = { error: new Error('invalid URL') }
    const { user } = await openTab()
    await user.click(screen.getByRole('button', { name: 'New outbound webhook' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Pager')
    await user.type(within(dialog()).getByLabelText('URL'), 'nope')
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Webhook creation failed: invalid URL'))
    expect(dialog()).toBeInTheDocument()
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('API keys', () => {
  async function openTab() {
    const r = show('/admin/integrations?tab=apikeys')
    await screen.findByText('CI robot')
    return r
  }

  it('each row shows the prefix, the permissions (also from a JSON string) and the rate limit', async () => {
    await openTab()
    expect(within(rowOf('CI robot')).getByText('og_abc...')).toBeInTheDocument()
    expect(within(rowOf('CI robot')).getByText('incidents:read')).toBeInTheDocument()
    expect(within(rowOf('CI robot')).getByText('100/min')).toBeInTheDocument()
    expect(within(rowOf('Old importer')).getByText('changes:read')).toBeInTheDocument()
    expect(within(rowOf('Old importer')).getByText('problems:write')).toBeInTheDocument()
  })

  it('an empty expiry is sent as null (never expires), a chosen day as that day', async () => {
    apolloFinto.esiti['CreateApiKey'] = { data: { createApiKey: { id: 'k9', key: 'og_live_123' } } }
    const { user } = await openTab()
    await user.click(screen.getByRole('button', { name: 'New API key' }))
    const create = within(dialog()).getByRole('button', { name: 'Create' })
    await user.type(within(dialog()).getByLabelText('Name'), 'Importer')
    expect(create).toBeDisabled() // a key without permissions would get 403 on every route
    await user.click(within(dialog()).getByRole('checkbox', { name: 'incidents:write' }))
    await user.click(within(dialog()).getByRole('checkbox', { name: 'changes:read' }))
    await user.click(within(dialog()).getByRole('checkbox', { name: 'changes:read' }))
    expect(create).toBeEnabled()
    const rate = within(dialog()).getByLabelText('Rate limit (req/min)')
    await user.clear(rate)
    expect(create).toBeDisabled() // zero requests per minute is not a key anyone can use
    await user.type(rate, '250')
    await user.click(create)
    expect(apolloFinto.chiamata('CreateApiKey')).toEqual({ input: { name: 'Importer', permissions: ['incidents:write'], rateLimit: 250, expiresAt: null } })
    expect(await screen.findByText('og_live_123')).toBeInTheDocument()
    await user.click(within(dialog()).getByRole('button', { name: 'Close' }))

    await user.click(screen.getByRole('button', { name: 'New API key' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Temp')
    await user.click(within(dialog()).getByRole('checkbox', { name: 'incidents:read' }))
    await user.type(within(dialog()).getByLabelText('Expires at'), '2026-12-31')
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }))
    expect(apolloFinto.chiamata('CreateApiKey')).toMatchObject({ input: { name: 'Temp', expiresAt: '2026-12-31', rateLimit: 1000 } })
  })

  it('an answer without the key, or a refusal, is said', async () => {
    const { user } = await openTab()
    const createOne = async () => {
      await user.click(screen.getByRole('button', { name: 'New API key' }))
      await user.type(within(dialog()).getByLabelText('Name'), 'X')
      await user.click(within(dialog()).getByRole('checkbox', { name: 'incidents:read' }))
      await user.click(within(dialog()).getByRole('button', { name: 'Create' }))
    }
    apolloFinto.esiti['CreateApiKey'] = { data: { createApiKey: { id: 'k9', key: '' } } }
    await createOne()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('API key creation failed: API key created but the key is missing in the response'))

    apolloFinto.esiti['CreateApiKey'] = { error: new Error('name taken') }
    await createOne()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('API key creation failed: name taken'))
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
  })

  it('switch, delete and regenerate act on the right key', async () => {
    const { user } = await openTab()
    await user.click(screen.getByRole('switch', { name: 'Toggle CI robot' }))
    expect(apolloFinto.chiamata('UpdateApiKey')).toEqual({ id: 'k1', input: { enabled: false } })

    await user.click(within(rowOf('CI robot')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('dialog', { name: 'Delete this API key?' })).toBeInTheDocument()
    await confirmDialog(user, 'Delete')
    await waitFor(() => expect(apolloFinto.chiamata('DeleteApiKey')).toEqual({ id: 'k1' }))
    expect(toast.success).toHaveBeenCalledWith('API key deleted')
    await user.click(within(rowOf('CI robot')).getByRole('button', { name: 'Delete' }))
    await confirmDialog(user, 'Cancel')
    expect(apolloFinto.chiamate['DeleteApiKey']).toHaveLength(1)

    const regen = async () => {
      await user.click(within(rowOf('Old importer')).getByRole('button', { name: 'Regenerate the key of Old importer' }))
      await confirmDialog(user, 'Regenerate key')
    }
    apolloFinto.esiti['RegenerateApiKey'] = { data: { regenerateApiKey: { key: 'og_rotated' } } }
    await regen()
    expect(await screen.findByText('og_rotated')).toBeInTheDocument()
    expect(apolloFinto.chiamata('RegenerateApiKey')).toEqual({ id: 'k2' })
    await user.click(within(dialog()).getByRole('button', { name: 'Close' }))

    apolloFinto.esiti['RegenerateApiKey'] = { data: {} }
    await regen()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Key regeneration failed: API key created but the key is missing in the response'))
    apolloFinto.esiti['RegenerateApiKey'] = { error: new Error('nope') }
    await regen()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Key regeneration failed: nope'))
  })
})

describe('closing a creation form', () => {
  it('the X closes each form without creating anything', async () => {
    const { user } = show()
    await screen.findByText('Jira incidents')
    for (const [tab, button] of [['Webhook In', 'New inbound webhook'], ['Webhook Out', 'New outbound webhook'], ['API Keys', 'New API key']] as const) {
      await user.click(screen.getByRole('tab', { name: tab }))
      await user.click(await screen.findByRole('button', { name: button }))
      await user.click(within(dialog()).getByRole('button', { name: 'Close' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    }
    expect(Object.keys(apolloFinto.chiamate).filter((n) => n.startsWith('Create'))).toEqual([])
  })
})
