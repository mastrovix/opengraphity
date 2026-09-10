import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { NewSourceWizard } from './NewSourceWizard'
import { GET_SAMPLE_INBOUND_PAYLOAD, GET_PAYLOAD_KEYS } from '@/graphql/queries'
import { PREVIEW_INBOUND_EVENTS, CREATE_MONITORING_SOURCE, SEND_SAMPLE_EVENT } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

// Stesso payload dimostrativo dell'API (apps/api/src/lib/eventSamples.ts, GENERIC_SAMPLE).
const GENERIC_SAMPLE = {
  id: 'EVT-100234',
  state: 'open',
  msg: 'Service checkout-api is returning HTTP 500 on 12% of requests',
  alert: { name: 'CheckoutErrorRate', level: 'major', rule: 'error_rate > 10%' },
  host: { name: 'api-03.example.local', ip: '10.0.2.13', datacenter: 'eu-west-1' },
  tags: { env: 'prod', service: 'checkout-api' },
  received_at: '2026-09-09T10:15:00Z',
}
const SAMPLE_TEXT = JSON.stringify(GENERIC_SAMPLE, null, 2)

const KEYS = [
  ['id', 'EVT-100234'], ['state', 'open'], ['msg', 'Service checkout-api is returning HTTP 500 on 12% of requests'],
  ['alert.name', 'CheckoutErrorRate'], ['alert.level', 'major'], ['alert.rule', 'error_rate > 10%'],
  ['host.name', 'api-03.example.local'], ['host.ip', '10.0.2.13'], ['host.datacenter', 'eu-west-1'],
  ['tags.env', 'prod'], ['tags.service', 'checkout-api'], ['received_at', '2026-09-09T10:15:00Z'],
].map(([path, sample]) => ({ __typename: 'PayloadKey', path, sample }))

const sampleMock: GqlMock = {
  request: { query: GET_SAMPLE_INBOUND_PAYLOAD, variables: { connectorKind: 'generic' } },
  result: { data: { sampleInboundPayload: SAMPLE_TEXT } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}
const keysMock: GqlMock = {
  request: { query: GET_PAYLOAD_KEYS, variables: { payload: SAMPLE_TEXT } },
  result: { data: { payloadKeys: KEYS } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

type PreviewInput = { connectorKind: string; payload: string; fieldMapping: string; defaultValues: string; valueMapping: string }

function previewMock(seen: PreviewInput[]): GqlMock {
  return {
    request: { query: PREVIEW_INBOUND_EVENTS, variables: (v) => { seen.push((v as { input: PreviewInput }).input); return true } },
    result: { data: { previewInboundEvents: [{
      __typename: 'NormalizedEventPreview', externalId: 'EVT-100234', status: 'firing', severity: 'critical',
      title: 'CheckoutErrorRate', description: null, resource: 'api-03.example.local', resourceKind: 'hostname', labels: '{}',
    }] } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

type CreateInput = Record<string, string>

function createMock(seen: CreateInput[]): GqlMock {
  return {
    request: { query: CREATE_MONITORING_SOURCE, variables: (v) => { seen.push((v as { input: CreateInput }).input); return true } },
    result: { data: { createInboundWebhook: {
      __typename: 'InboundWebhookWithToken', id: 'src-new', name: 'My tool', token: 'tok-SECRET-1', entityType: 'event',
      connectorKind: 'generic', fieldMapping: '{}', defaultValues: null, valueMapping: null, enabled: true, createdAt: '2026-09-09T10:00:00Z',
    } } },
  }
}

const sendSampleMock: GqlMock = {
  request: { query: SEND_SAMPLE_EVENT, variables: { sourceId: 'src-new' } },
  result: { data: { sendSampleEvent: 1 } },
}

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('NewSourceWizard — percorso generico', () => {
  it('strumento → esempio → chiavi → mappatura → anteprima → crea → collegamento → prova', async () => {
    const previews: PreviewInput[] = []
    const creates: CreateInput[] = []
    const { user } = renderWithProviders(<NewSourceWizard />, {
      route: '/monitoring/sources/new',
      mocks: [sampleMock, keysMock, previewMock(previews), createMock(creates), sendSampleMock],
    })

    // Passo 1: senza strumento non si avanza
    expect(screen.getByRole('heading', { level: 2, name: 'Step 1 of 4 · Tool' })).toBeInTheDocument()
    const next = () => screen.getByRole('button', { name: 'Next →' })
    expect(next()).toBeDisabled()
    expect(screen.getByText('Pick a tool to continue.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Other tool/ }))
    expect(screen.getByRole('button', { name: /Other tool/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(next())

    // Passo 2: nome + mappatore
    expect(screen.getByRole('heading', { level: 2, name: 'Step 2 of 4 · Name and rules' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Source name'), 'My tool')
    const create = () => screen.getByRole('button', { name: 'Create source' })
    expect(create()).toBeDisabled()
    expect(screen.getByText('Map the required fields (title, severity, resource) and make sure the preview shows an event.')).toBeInTheDocument()

    // "Usa esempio" carica sampleInboundPayload('generic') e popola le chiavi
    await user.click(screen.getByRole('button', { name: 'Use example' }))
    await waitFor(() => expect(screen.getByLabelText('Sample alarm (JSON)')).toHaveValue(SAMPLE_TEXT))
    const titleSelect = screen.getByLabelText('Title *')
    await waitFor(() => expect(within(titleSelect).getByRole('option', { name: 'alert.name — CheckoutErrorRate' })).toBeInTheDocument())

    // Mappatura: percorso e valore d'esempio nelle option
    await user.selectOptions(titleSelect, 'alert.name')
    await user.selectOptions(screen.getByLabelText('Severity *'), 'alert.level')
    await user.selectOptions(screen.getByLabelText('Resource (host, IP, …) *'), 'host.name')
    await user.selectOptions(screen.getByLabelText('Status'), 'state')
    await user.selectOptions(screen.getByLabelText('External ID'), 'id')

    // Traduzione dei valori: "major" trovato nel campo severità va scelto a mano; "open" è suggerito come firing
    const major = screen.getByLabelText('"major" becomes')
    expect(major).toHaveValue('')
    expect(create()).toBeDisabled()
    expect(screen.getByLabelText('"open" becomes')).toHaveValue('firing')
    await user.selectOptions(major, 'critical')

    // un valore aggiunto a mano (prima tabella = severità)
    await user.type(screen.getAllByLabelText('Add another value')[0]!, 'minor{Enter}')
    await user.selectOptions(screen.getByLabelText('"minor" becomes'), 'warning')

    // Anteprima in tempo reale con la configurazione costruita (mai JSON in UI)
    const preview = screen.getByRole('complementary', { name: 'Preview' })
    expect(await within(preview).findByText('CheckoutErrorRate')).toBeInTheDocument()
    expect(within(preview).getByText('api-03.example.local')).toBeInTheDocument()
    const last = previews.at(-1)!
    expect(last.connectorKind).toBe('generic')
    expect(JSON.parse(last.fieldMapping)).toEqual({ title: 'alert.name', severity: 'alert.level', resource: 'host.name', status: 'state', externalId: 'id' })
    expect(JSON.parse(last.defaultValues)).toEqual({ resourceKind: 'hostname' })
    expect(JSON.parse(last.valueMapping)).toEqual({ severity: { major: 'critical', minor: 'warning' }, status: { open: 'firing' } })

    // Crea la sorgente
    await waitFor(() => expect(create()).toBeEnabled())
    await user.click(create())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Source created'))
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({ name: 'My tool', entityType: 'event', connectorKind: 'generic' })
    expect(JSON.parse(creates[0]!['valueMapping']!)).toEqual({ severity: { major: 'critical', minor: 'warning' }, status: { open: 'firing' } })

    // Passo 3: URL, token (una volta) e frammento curl con il payload incollato
    expect(screen.getByRole('heading', { level: 2, name: 'Step 3 of 4 · Connection' })).toBeInTheDocument()
    expect(screen.getByLabelText('Endpoint URL')).toHaveTextContent('/api/webhooks/inbound/src-new')
    expect(screen.getByLabelText('Token')).toHaveTextContent('tok-SECRET-1')
    expect(screen.getByText(/Copy the token now/)).toBeInTheDocument()
    expect(screen.getByText(/curl -X POST/)).toHaveTextContent('Authorization: Bearer tok-SECRET-1')
    expect(screen.getByText(/curl -X POST/)).toHaveTextContent('"alert":{"name":"CheckoutErrorRate"')
    await user.click(next())

    // Passo 4: evento di prova e link alla console
    expect(screen.getByRole('heading', { level: 2, name: 'Step 4 of 4 · Test' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    expect(await screen.findByRole('status')).toHaveTextContent('1 test event queued')
    expect(screen.getByRole('link', { name: 'Open in Events' })).toHaveAttribute('href', '/events?sourceId=src-new')
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/monitoring/sources')
  })

  it('strumento noto (Alertmanager): nessun mappatore, frammento YAML con url/token e send_resolved', async () => {
    const creates: CreateInput[] = []
    const mock: GqlMock = {
      request: { query: CREATE_MONITORING_SOURCE, variables: (v) => { creates.push((v as { input: CreateInput }).input); return true } },
      result: { data: { createInboundWebhook: {
        __typename: 'InboundWebhookWithToken', id: 'src-am', name: 'Prom', token: 'tok-AM', entityType: 'event',
        connectorKind: 'alertmanager', fieldMapping: '{}', defaultValues: null, valueMapping: null, enabled: true, createdAt: '2026-09-09T10:00:00Z',
      } } },
    }
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [mock] })
    await user.click(screen.getByRole('button', { name: /Prometheus Alertmanager/ }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(screen.getByText(/already understands: no field mapping is needed/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Sample alarm (JSON)')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Source name'), 'Prom')

    // A1: regole del preset — traduzione di una severità libera e risorsa predefinita
    expect(screen.getByText(/the severity label is free text/)).toBeInTheDocument()
    const addInputs = screen.getAllByLabelText('Add another value')
    await user.type(addInputs[0]!, 'page')
    await user.click(screen.getAllByRole('button', { name: 'Add' })[0]!)
    // valore senza destinazione → il pulsante è bloccato con il motivo
    expect(screen.getByRole('button', { name: 'Create source' })).toBeDisabled()
    expect(screen.getByText('Every value added to the translation needs a target (or remove it).')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('"page" becomes'), 'critical')
    await user.type(screen.getByLabelText('Resource to use when missing'), 'prometheus-prod')
    await user.selectOptions(screen.getByLabelText('The resource is a…'), 'name')
    expect(screen.queryByLabelText(/use alert_scope/)).not.toBeInTheDocument()   // solo Datadog

    await user.click(screen.getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(creates).toEqual([{
      name: 'Prom', entityType: 'event', connectorKind: 'alertmanager', rateLimitPerMinute: 100,
      fieldMapping: '{}', defaultValues: JSON.stringify({ resource: 'prometheus-prod', resourceKind: 'name' }), valueMapping: JSON.stringify({ severity: { page: 'critical' } }),
    }]))
    const yaml = await screen.findByText(/webhook_configs/)
    expect(yaml).toHaveTextContent('send_resolved: true')
    expect(yaml).toHaveTextContent('credentials: tok-AM')
    expect(yaml).toHaveTextContent('/api/webhooks/inbound/src-am')
  })

  it('strumento noto (Dynatrace): istruzioni, header Bearer e payload personalizzato con {ImpactedEntities} senza virgolette', async () => {
    const creates: CreateInput[] = []
    const mock: GqlMock = {
      request: { query: CREATE_MONITORING_SOURCE, variables: (v) => { creates.push((v as { input: CreateInput }).input); return true } },
      result: { data: { createInboundWebhook: {
        __typename: 'InboundWebhookWithToken', id: 'src-dt', name: 'DT prod', token: 'tok-DT', entityType: 'event',
        connectorKind: 'dynatrace', fieldMapping: '{}', defaultValues: null, valueMapping: null, enabled: true, createdAt: '2026-09-09T10:00:00Z',
      } } },
    }
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [mock] })
    await user.click(screen.getByRole('button', { name: /Dynatrace/ }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(screen.queryByLabelText('Sample alarm (JSON)')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Source name'), 'DT prod')
    await user.click(screen.getByRole('button', { name: 'Create source' }))
    // nessuna regola aggiunta → JSON vuoti (l'API non ha default da applicare)
    await waitFor(() => expect(creates).toEqual([{ name: 'DT prod', entityType: 'event', connectorKind: 'dynatrace', rateLimitPerMinute: 100, fieldMapping: '{}', defaultValues: '{}', valueMapping: '{}' }]))
    expect(await screen.findByText(/Problem notifications → Add notification/)).toBeInTheDocument()
    expect(screen.getByText(/also sends the closing notification \(State = RESOLVED\)/)).toBeInTheDocument()
    const snippet = screen.getByText(/# Custom payload \(paste as is/)
    expect(snippet).toHaveTextContent('Header value: Bearer tok-DT')
    expect(snippet).toHaveTextContent('/api/webhooks/inbound/src-dt')
    expect(snippet).toHaveTextContent('"PID": "{PID}"')
    expect(snippet).toHaveTextContent('"ImpactedEntities": {ImpactedEntities}')
    expect(snippet).not.toHaveTextContent('"{ImpactedEntities}"')
  })

  it('A1 — Datadog: la spunta "usa alert_scope" scrive default_values.resourceFrom; il frammento include $ALERT_CYCLE_KEY e $ALERT_SCOPE', async () => {
    const creates: CreateInput[] = []
    const mock: GqlMock = {
      request: { query: CREATE_MONITORING_SOURCE, variables: (v) => { creates.push((v as { input: CreateInput }).input); return true } },
      result: { data: { createInboundWebhook: {
        __typename: 'InboundWebhookWithToken', id: 'src-dd', name: 'DD', token: 'tok-DD', entityType: 'event',
        connectorKind: 'datadog', fieldMapping: '{}', defaultValues: '{"resourceFrom":"alert_scope"}', valueMapping: '{}', enabled: true, createdAt: '2026-09-09T10:00:00Z',
      } } },
    }
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [mock] })
    await user.click(screen.getByRole('button', { name: /Datadog/ }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.type(screen.getByLabelText('Source name'), 'DD')
    await user.click(screen.getByLabelText(/use alert_scope/))
    await user.click(screen.getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(creates).toEqual([{ name: 'DD', entityType: 'event', connectorKind: 'datadog', rateLimitPerMinute: 100, fieldMapping: '{}', defaultValues: JSON.stringify({ resourceFrom: 'alert_scope' }), valueMapping: '{}' }]))
    const snippet = await screen.findByText(/# Custom payload/)
    expect(snippet).toHaveTextContent('"alert_cycle_key": "$ALERT_CYCLE_KEY"')
    expect(snippet).toHaveTextContent('"alert_scope": "$ALERT_SCOPE"')
  })

  it('errore di creazione → toast con il messaggio del server, si resta al passo 2', async () => {
    const mock: GqlMock = {
      request: { query: CREATE_MONITORING_SOURCE, variables: () => true },
      error: new Error('name already in use'),
    }
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [mock] })
    await user.click(screen.getByRole('button', { name: /Datadog/ }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.type(screen.getByLabelText('Source name'), 'DD')
    await user.click(screen.getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The source was not created: name already in use'))
    expect(screen.getByRole('heading', { level: 2, name: 'Step 2 of 4 · Name and rules' })).toBeInTheDocument()
  })
})
