import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { NewSourceWizard } from './NewSourceWizard'
import { GET_SAMPLE_INBOUND_PAYLOAD, GET_PAYLOAD_KEYS, GET_MONITORING_SOURCES } from '@/graphql/queries'
import { PREVIEW_INBOUND_EVENTS, CREATE_MONITORING_SOURCE, SEND_SAMPLE_EVENT } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import type { MonitoringSource } from '@/types/events'

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

function createMock(seen: CreateInput[], over: Partial<{ id: string; name: string; token: string | null; connectorKind: string }> = {}): GqlMock {
  return {
    request: { query: CREATE_MONITORING_SOURCE, variables: (v) => { seen.push((v as { input: CreateInput }).input); return true } },
    result: { data: { createInboundWebhook: {
      __typename: 'InboundWebhookWithToken', id: 'src-new', name: 'My tool', token: 'tok-SECRET-1', entityType: 'event',
      connectorKind: 'generic', fieldMapping: '{}', defaultValues: null, valueMapping: null, enabled: true, createdAt: '2026-09-09T10:00:00Z', ...over,
    } } },
  }
}

const sendSampleMock = (sourceId = 'src-new'): GqlMock => ({
  request: { query: SEND_SAMPLE_EVENT, variables: { sourceId } },
  result: { data: { sendSampleEvent: 1 } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

/** `monitoringSources` interrogata dal passo Prova dopo l'invio (D·2.3). */
function sourcesMock(over: Partial<MonitoringSource> & { id: string }): GqlMock {
  const src: MonitoringSource = {
    name: 'My tool', entityType: 'event', connectorKind: 'generic', fieldMapping: '{}', defaultValues: null, valueMapping: null,
    enabled: true, lastReceivedAt: null, receiveCount: 0, lastError: null, lastErrorAt: null, errorCount: 0, createdAt: '2026-09-09T10:00:00Z', ...over,
  }
  return { request: { query: GET_MONITORING_SOURCES }, result: { data: { monitoringSources: [{ __typename: 'InboundWebhook', ...src }] } }, maxUsageCount: Number.POSITIVE_INFINITY }
}

/** Percorso via input + datalist (D·2.2): si digita il percorso; le opzioni leggibili sono nella datalist. */
async function typePath(user: ReturnType<typeof renderWithProviders>['user'], label: string, path: string) {
  const input = screen.getByLabelText(label)
  await user.clear(input)
  await user.type(input, path)
}

const datalistOptions = (label: string) => {
  const input = screen.getByLabelText(label)
  const list = document.getElementById(input.getAttribute('list')!)!
  return [...list.querySelectorAll('option')].map((o) => [o.getAttribute('value'), o.textContent] as const)
}

/** Preset fino al passo 2 con il nome compilato. */
async function presetToRules(user: ReturnType<typeof renderWithProviders>['user'], tool: RegExp, name: string) {
  await user.click(screen.getByRole('radio', { name: tool }))
  await user.click(screen.getByRole('button', { name: 'Next →' }))
  await user.type(screen.getByLabelText('Source name'), name)
}

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('NewSourceWizard — percorso generico', () => {
  it('strumento → esempio → chiavi → mappatura → anteprima → crea → collegamento → prova (con verifica della ricezione)', async () => {
    const previews: PreviewInput[] = []
    const creates: CreateInput[] = []
    const { user } = renderWithProviders(<NewSourceWizard sampleCheckDelayMs={0} />, {
      route: '/monitoring/sources/new',
      mocks: [sampleMock, keysMock, previewMock(previews), createMock(creates), sendSampleMock(), sourcesMock({ id: 'src-new', lastReceivedAt: '2026-09-09T10:16:00Z', receiveCount: 1 })],
    })

    // Passo 1: scelta esclusiva (radiogroup, D·3.4); senza strumento non si avanza e il motivo è annunciato (role=status)
    expect(screen.getByRole('heading', { level: 2, name: 'Step 1 of 4 · Tool' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Monitoring tool' })).toBeInTheDocument()
    const next = () => screen.getByRole('button', { name: 'Next →' })
    expect(next()).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Pick a tool to continue.')
    await user.click(screen.getByRole('radio', { name: /Other tool/ }))
    expect(screen.getByRole('radio', { name: /Other tool/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(next())

    // Passo 2: per "Altro strumento" l'etichetta dice "mappatura" (D·2.3)
    expect(screen.getByRole('heading', { level: 2, name: 'Step 2 of 4 · Name and mapping' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Source name'), 'My tool')
    const create = () => screen.getByRole('button', { name: 'Create source' })
    expect(create()).toBeDisabled()
    expect(screen.getByText('Map the required fields (title, severity, resource) and make sure the preview shows an event.')).toBeInTheDocument()

    // "Usa esempio" carica sampleInboundPayload('generic') e popola le opzioni leggibili della datalist
    await user.click(screen.getByRole('button', { name: 'Use example' }))
    await waitFor(() => expect(screen.getByLabelText('Sample alarm (JSON)')).toHaveValue(SAMPLE_TEXT))
    await waitFor(() => expect(datalistOptions('Title *')).toContainEqual(['alert.name', 'name (in alert) — CheckoutErrorRate']))
    expect(datalistOptions('Severity *')).toContainEqual(['id', 'id — EVT-100234'])
    expect(screen.getByText(/A path like “a\.b” means: field b inside a/)).toBeInTheDocument()

    // Mappatura: percorso digitato (o scelto dalla datalist)
    await typePath(user, 'Title *', 'alert.name')
    await typePath(user, 'Severity *', 'alert.level')
    await typePath(user, 'Resource (host, IP, …) *', 'host.name')
    await typePath(user, 'Status', 'state')
    await typePath(user, 'External ID', 'id')

    // Traduzione dei valori: "major" va scelto a mano (aria-invalid + testo, D·3.3); "open" è suggerito come firing
    const major = screen.getByLabelText('"major" becomes')
    expect(major).toHaveValue('')
    expect(major).toHaveAttribute('aria-invalid', 'true')
    expect(major).toHaveAccessibleDescription('translation missing')
    expect(create()).toBeDisabled()
    expect(screen.getByLabelText('"open" becomes')).toHaveValue('firing')
    await user.selectOptions(major, 'critical')
    expect(major).not.toHaveAttribute('aria-invalid')

    // un valore aggiunto a mano (prima tabella = severità)
    await user.type(screen.getAllByLabelText('Add another value')[0]!, 'minor{Enter}')
    await user.selectOptions(screen.getByLabelText('"minor" becomes'), 'warning')

    // Severità/stato predefiniti quando il campo manca (D·1.2)
    await user.selectOptions(screen.getByLabelText('Default severity'), 'warning')

    // Anteprima in tempo reale con la configurazione costruita (mai JSON in UI)
    const preview = screen.getByRole('complementary', { name: 'Preview' })
    expect(await within(preview).findByText('CheckoutErrorRate')).toBeInTheDocument()
    expect(within(preview).getByText('api-03.example.local')).toBeInTheDocument()
    await waitFor(() => expect(JSON.parse(previews.at(-1)!.defaultValues)).toEqual({ resourceKind: 'hostname', severity: 'warning' }))
    const last = previews.at(-1)!
    expect(last.connectorKind).toBe('generic')
    expect(JSON.parse(last.fieldMapping)).toEqual({ title: 'alert.name', severity: 'alert.level', resource: 'host.name', status: 'state', externalId: 'id' })
    expect(JSON.parse(last.valueMapping)).toEqual({ severity: { major: 'critical', minor: 'warning' }, status: { open: 'firing' } })

    // Crea la sorgente
    await waitFor(() => expect(create()).toBeEnabled())
    await user.click(create())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Source created'))
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({ name: 'My tool', entityType: 'event', connectorKind: 'generic' })
    expect(JSON.parse(creates[0]!['valueMapping']!)).toEqual({ severity: { major: 'critical', minor: 'warning' }, status: { open: 'firing' } })
    expect(JSON.parse(creates[0]!['defaultValues']!)).toEqual({ resourceKind: 'hostname', severity: 'warning' })

    // Passo 3: URL, token (una volta) e frammento curl con il payload incollato; dal passo 3 non si torna al 2 (la sorgente esiste già)
    expect(screen.getByRole('heading', { level: 2, name: 'Step 3 of 4 · Connection' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '← Prev' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Endpoint URL')).toHaveTextContent('/api/webhooks/inbound/src-new')
    expect(screen.getByLabelText('Token')).toHaveTextContent('tok-SECRET-1')
    expect(screen.getByText(/Copy the token now/)).toBeInTheDocument()
    expect(screen.getByText(/curl -X POST/)).toHaveTextContent('Authorization: Bearer tok-SECRET-1')
    expect(screen.getByText(/curl -X POST/)).toHaveTextContent('"alert":{"name":"CheckoutErrorRate"')
    await user.click(screen.getByRole('button', { name: 'Copy token' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Copied!'))
    await user.click(next())

    // Passo 4: evento di prova, link alla console e verifica della ricezione (D·2.3)
    expect(screen.getByRole('heading', { level: 2, name: 'Step 4 of 4 · Test' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    expect(await screen.findByText('1 test event queued: open the console to see it.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in Events' })).toHaveAttribute('href', '/events?sourceId=src-new')
    expect(await screen.findByText(/Received ✔ — the source accepted the event/)).toBeInTheDocument()

    // token copiato → "Fine" esce senza conferma
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/monitoring/sources')
  })

  it('D·1.10 — con un esempio incollato e l\'anteprima in errore "Crea sorgente" resta bloccato con il motivo', async () => {
    const failingPreview: GqlMock = { request: { query: PREVIEW_INBOUND_EVENTS, variables: () => true }, error: new Error('resource is empty'), maxUsageCount: Number.POSITIVE_INFINITY }
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [sampleMock, keysMock, failingPreview] })
    await user.click(screen.getByRole('radio', { name: /Other tool/ }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.type(screen.getByLabelText('Source name'), 'My tool')
    await user.click(screen.getByRole('button', { name: 'Use example' }))
    await waitFor(() => expect(screen.getByLabelText('Sample alarm (JSON)')).toHaveValue(SAMPLE_TEXT))
    await typePath(user, 'Title *', 'alert.name')
    await typePath(user, 'Severity *', 'alert.level')
    await typePath(user, 'Resource (host, IP, …) *', 'host.name')
    // "major" compare quando l'esempio è stato letto (debounce)
    await user.selectOptions(await screen.findByLabelText('"major" becomes'), 'critical')
    expect(await screen.findByRole('alert')).toHaveTextContent('The rules do not work yet: resource is empty')
    expect(screen.getByRole('button', { name: 'Create source' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('The preview must show an event without errors before creating the source.')
  })

  it('D·1.6 — "Usa esempio" in errore (Apollo 4: execute rigetta) → toast con il messaggio, niente rejection silenziosa', async () => {
    const failing: GqlMock = { request: { query: GET_SAMPLE_INBOUND_PAYLOAD, variables: { connectorKind: 'generic' } }, error: new Error('samples unavailable') }
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [failing] })
    await user.click(screen.getByRole('radio', { name: /Other tool/ }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: 'Use example' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cannot load the example: samples unavailable'))
    expect(screen.getByLabelText('Sample alarm (JSON)')).toHaveValue('')
  })

  it('createInboundWebhook senza token nella risposta → errore in chiaro, si resta al passo 2', async () => {
    const creates: CreateInput[] = []
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [createMock(creates, { token: null, connectorKind: 'datadog' })] })
    await presetToRules(user, /Datadog/, 'DD')
    await user.click(screen.getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The source was not created: createInboundWebhook: token missing in the response'))
    expect(screen.getByRole('heading', { level: 2, name: 'Step 2 of 4 · Name and rules' })).toBeInTheDocument()
  })
})

describe('NewSourceWizard — strumenti noti', () => {
  it('Alertmanager: nessun mappatore, regole del preset (traduzione, severità e risorsa predefinite), frammento YAML con url/token e send_resolved', async () => {
    const creates: CreateInput[] = []
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [createMock(creates, { id: 'src-am', name: 'Prom', token: 'tok-AM', connectorKind: 'alertmanager' })] })
    await presetToRules(user, /Prometheus Alertmanager/, 'Prom')
    expect(screen.getByRole('heading', { level: 2, name: 'Step 2 of 4 · Name and rules' })).toBeInTheDocument()
    expect(screen.getByText(/already understands: no field mapping is needed/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Sample alarm (JSON)')).not.toBeInTheDocument()

    // A1: regole del preset — traduzione di una severità libera e risorsa predefinita
    expect(screen.getByText(/the severity label is free text/)).toBeInTheDocument()
    const addInputs = screen.getAllByLabelText('Add another value')
    await user.type(addInputs[0]!, 'page')
    await user.click(screen.getAllByRole('button', { name: 'Add' })[0]!)
    // valore senza destinazione → il pulsante è bloccato con il motivo
    expect(screen.getByRole('button', { name: 'Create source' })).toBeDisabled()
    expect(screen.getByText('Every value added to the translation needs a target (or remove it).')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('"page" becomes'), 'critical')
    await user.type(screen.getByLabelText('Severity to use when missing'), 'warning')
    await user.type(screen.getByLabelText('Resource to use when missing'), 'prometheus-prod')
    await user.selectOptions(screen.getByLabelText('The resource is a…'), 'name')
    expect(screen.queryByLabelText(/use alert_scope/)).not.toBeInTheDocument()   // solo Datadog

    await user.click(screen.getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(creates).toEqual([{
      name: 'Prom', entityType: 'event', connectorKind: 'alertmanager', rateLimitPerMinute: 100,
      fieldMapping: '{}', defaultValues: JSON.stringify({ severity: 'warning', resource: 'prometheus-prod', resourceKind: 'name' }), valueMapping: JSON.stringify({ severity: { page: 'critical' } }),
    }]))
    const yaml = await screen.findByText(/webhook_configs/)
    expect(yaml).toHaveTextContent('send_resolved: true')
    expect(yaml).toHaveTextContent('credentials: tok-AM')
    expect(yaml).toHaveTextContent('/api/webhooks/inbound/src-am')
  })

  it('Grafana: istruzioni del contact point e frammento con schema Bearer', async () => {
    const creates: CreateInput[] = []
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [createMock(creates, { id: 'src-gf', name: 'Grafana', token: 'tok-GF', connectorKind: 'grafana' })] })
    await presetToRules(user, /Grafana/, 'Grafana')
    await user.click(screen.getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(creates).toEqual([{ name: 'Grafana', entityType: 'event', connectorKind: 'grafana', rateLimitPerMinute: 100, fieldMapping: '{}', defaultValues: '{}', valueMapping: '{}' }]))
    const snippet = await screen.findByText(/Authorization scheme: Bearer/)
    expect(snippet).toHaveTextContent('Authorization creds: tok-GF')
    expect(snippet).toHaveTextContent('/api/webhooks/inbound/src-gf')
    expect(snippet).toHaveTextContent('Send resolved: on')
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(4)   // 4 passi + barra di avanzamento
  })

  it('Zabbix: elenco delle macro del media type e frammento con i parametri; il passo Prova mostra l\'ultimo errore della sorgente', async () => {
    const creates: CreateInput[] = []
    const { user } = renderWithProviders(<NewSourceWizard sampleCheckDelayMs={0} />, {
      route: '/monitoring/sources/new',
      mocks: [
        createMock(creates, { id: 'src-zx', name: 'Zabbix DC', token: 'tok-ZX', connectorKind: 'zabbix' }),
        sendSampleMock('src-zx'),
        sourcesMock({ id: 'src-zx', name: 'Zabbix DC', connectorKind: 'zabbix', lastError: 'event_value is missing ("1" problem | "0" recovery)', lastErrorAt: '2026-09-09T10:20:00Z', errorCount: 1 }),
      ],
    })
    await presetToRules(user, /Zabbix/, 'Zabbix DC')
    await user.click(screen.getByRole('button', { name: 'Create source' }))
    const snippet = await screen.findByText(/# Media type "Webhook" — Parameters/)
    expect(snippet).toHaveTextContent('Token')
    expect(snippet).toHaveTextContent('tok-ZX')
    expect(snippet).toHaveTextContent('event_severity')
    expect(snippet).toHaveTextContent('{EVENT.SEVERITY}')
    // macro elencate nelle istruzioni (host_id ← {HOST.ID})
    expect(screen.getByText('{HOST.ID}')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    expect(await screen.findByText(/Last error: event_value is missing/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('D·1.9 — dal passo Prova si torna al Collegamento (token ancora leggibile); "Fine" senza aver copiato il token chiede conferma', async () => {
    const creates: CreateInput[] = []
    const { user } = renderWithProviders(<NewSourceWizard sampleCheckDelayMs={0} />, {
      route: '/monitoring/sources/new',
      mocks: [createMock(creates, { id: 'src-dt', name: 'DT', token: 'tok-DT', connectorKind: 'dynatrace' })],
    })
    await presetToRules(user, /Dynatrace/, 'DT')
    await user.click(screen.getByRole('button', { name: 'Create source' }))
    await screen.findByRole('heading', { level: 2, name: 'Step 3 of 4 · Connection' })
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Step 4 of 4 · Test' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Step 3 of 4 · Connection' })).toBeInTheDocument()
    expect(screen.getByLabelText('Token')).toHaveTextContent('tok-DT')
    await user.click(screen.getByRole('button', { name: 'Next →' }))

    // Fine senza copia → conferma; "Cancel" resta sulla pagina
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Token not copied')
    expect(dialog).toHaveTextContent(/You have not copied the token/)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/monitoring/sources/new')

    // "Esci comunque" → elenco delle sorgenti
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave anyway' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/monitoring/sources')
    expect(screen.getByTestId('location')).not.toHaveTextContent('/monitoring/sources/new')
  })

  it('Dynatrace: istruzioni, header Bearer e payload personalizzato con {ImpactedEntities} senza virgolette', async () => {
    const creates: CreateInput[] = []
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [createMock(creates, { id: 'src-dt', name: 'DT prod', token: 'tok-DT', connectorKind: 'dynatrace' })] })
    await presetToRules(user, /Dynatrace/, 'DT prod')
    expect(screen.queryByLabelText('Sample alarm (JSON)')).not.toBeInTheDocument()
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
    const { user } = renderWithProviders(<NewSourceWizard />, { route: '/monitoring/sources/new', mocks: [createMock(creates, { id: 'src-dd', name: 'DD', token: 'tok-DD', connectorKind: 'datadog' })] })
    await presetToRules(user, /Datadog/, 'DD')
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
    await presetToRules(user, /Datadog/, 'DD')
    await user.click(screen.getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The source was not created: name already in use'))
    expect(screen.getByRole('heading', { level: 2, name: 'Step 2 of 4 · Name and rules' })).toBeInTheDocument()
  })
})
