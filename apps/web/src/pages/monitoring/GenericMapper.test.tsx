/**
 * GenericMapper isolato (D·7): tabella dei valori (aggiungi/rimuovi, traduzione
 * mancante), valori nuovi da un secondo esempio, errori di payloadKeys e
 * dell'anteprima, anteprima "1 di N" e stato riferito al genitore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { screen, within, waitFor, fireEvent } from '@testing-library/react'
import { toast } from 'sonner'
import { GenericMapper, type PreviewState } from './GenericMapper'
import { EMPTY_MAPPING, type GenericMapping } from './sourceConfig'
import { GET_PAYLOAD_KEYS } from '@/graphql/queries'
import { PREVIEW_INBOUND_EVENTS } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const SAMPLE_A = JSON.stringify({ alert: { name: 'Disk full', level: 'major' }, host: { name: 'db-01' }, state: 'open' })
const SAMPLE_B = JSON.stringify({ alert: { name: 'Disk full', level: 'minor' }, host: { name: 'db-02' }, state: 'closed' })
const MULTI = JSON.stringify({ alerts: [{ name: 'A', level: 'critical', host: 'h1' }, { name: 'B', level: 'warning', host: 'h2' }] })

/** payloadKeys calcolate dal payload ricevuto (stessa forma dell'API: percorso puntato + esempio). */
const keysMock: GqlMock = {
  request: { query: GET_PAYLOAD_KEYS, variables: () => true },
  result: (vars) => {
    const payload = JSON.parse((vars as { payload: string }).payload) as Record<string, unknown>
    const out: { __typename: string; path: string; sample: string }[] = []
    const visit = (v: unknown, prefix: string) => {
      if (Array.isArray(v)) v.forEach((item, i) => visit(item, `${prefix}${i}.`))
      else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) visit(val, `${prefix}${k}.`)
      else out.push({ __typename: 'PayloadKey', path: prefix.slice(0, -1), sample: String(v) })
    }
    visit(payload, '')
    return { data: { payloadKeys: out } }
  },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

type PreviewInput = { payload: string; fieldMapping: string; defaultValues: string; valueMapping: string }

/** Anteprima: un evento per ogni elemento di `alerts` (payload multiplo) o uno solo. */
function previewMock(seen: PreviewInput[] = []): GqlMock {
  return {
    request: { query: PREVIEW_INBOUND_EVENTS, variables: (v) => { seen.push((v as { input: PreviewInput }).input); return true } },
    result: (vars) => {
      const payload = JSON.parse((vars as { input: PreviewInput }).input.payload) as Record<string, unknown>
      const items = Array.isArray(payload['alerts']) ? (payload['alerts'] as { name: string; level: string; host: string }[]) : [{ name: (payload['alert'] as { name: string }).name, level: 'critical', host: (payload['host'] as { name: string }).name }]
      return { data: { previewInboundEvents: items.map((a) => ({
        __typename: 'NormalizedEventPreview', externalId: null, status: 'firing', severity: a.level === 'warning' ? 'warning' : 'critical',
        title: a.name, description: null, resource: a.host, resourceKind: 'hostname', labels: '{}',
      })) } }
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

/** Il genitore possiede mapping e payload, come la procedura guidata e la pagina di modifica. */
function Harness({ initial = EMPTY_MAPPING, initialPayload = '', onPreviewState, onMapping }: { initial?: GenericMapping; initialPayload?: string; onPreviewState?: (s: PreviewState) => void; onMapping?: (m: GenericMapping) => void }) {
  const [mapping, setMapping] = useState(initial)
  const [payload, setPayload] = useState(initialPayload)
  return <GenericMapper mapping={mapping} onChange={(m) => { setMapping(m); onMapping?.(m) }} payload={payload} onPayloadChange={setPayload} onPreviewState={onPreviewState} />
}

const setPayload = (text: string) => fireEvent.change(screen.getByLabelText('Sample alarm (JSON)'), { target: { value: text } })

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('GenericMapper — tabella dei valori', () => {
  it('scegliere il campo severità propone i valori trovati; un valore senza traduzione è segnalato; aggiungi/rimuovi a mano', async () => {
    const { user } = renderWithProviders(<Harness initialPayload={SAMPLE_A} />, { mocks: [keysMock, previewMock()] })
    expect(screen.getAllByText('Pick the field above first.')).toHaveLength(2)   // severità e stato
    await waitFor(() => expect(screen.getByText(/A path like “a\.b” means/)).toBeInTheDocument())
    await user.type(screen.getByLabelText('Severity *'), 'alert.level')

    const major = screen.getByLabelText('"major" becomes')
    expect(major).toHaveValue('')
    expect(major).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('translation missing')).toBeInTheDocument()
    await user.selectOptions(major, 'critical')
    expect(screen.queryByText('translation missing')).not.toBeInTheDocument()

    // valore con spazi e simboli: id per indice, la label resta associata (D·1.16)
    await user.type(screen.getAllByLabelText('Add another value')[0]!, 'P1 - High Priority{Enter}')
    const p1 = screen.getByLabelText('"P1 - High Priority" becomes')
    expect(p1).toHaveValue('')
    await user.selectOptions(p1, 'warning')
    await user.click(screen.getByRole('button', { name: 'Remove value major' }))
    expect(screen.queryByLabelText('"major" becomes')).not.toBeInTheDocument()
    expect(screen.getByLabelText('"P1 - High Priority" becomes')).toHaveValue('warning')
  })

  it('un secondo esempio aggiunge i valori nuovi (con suggerimento) senza toccare quelli già tradotti', async () => {
    const { user } = renderWithProviders(<Harness initialPayload={SAMPLE_A} />, { mocks: [keysMock, previewMock()] })
    await user.type(screen.getByLabelText('Severity *'), 'alert.level')
    await user.type(screen.getByLabelText('Status'), 'state')
    await user.selectOptions(screen.getByLabelText('"major" becomes'), 'critical')
    expect(screen.getByLabelText('"open" becomes')).toHaveValue('firing')

    setPayload(SAMPLE_B)
    expect(await screen.findByLabelText('"minor" becomes')).toHaveValue('warning')   // sinonimo inequivocabile
    expect(screen.getByLabelText('"major" becomes')).toHaveValue('critical')
    expect(screen.getByLabelText('"closed" becomes')).toHaveValue('resolved')
    expect(screen.getByLabelText('"open" becomes')).toHaveValue('firing')
  })
})

describe('GenericMapper — errori visibili', () => {
  it('JSON non valido → avviso; payloadKeys in errore → avviso con il messaggio (nessun elenco vuoto silenzioso)', async () => {
    const failingKeys: GqlMock = { request: { query: GET_PAYLOAD_KEYS, variables: () => true }, error: new Error('payload too large'), maxUsageCount: Number.POSITIVE_INFINITY }
    renderWithProviders(<Harness initialPayload="{not json" />, { mocks: [failingKeys] })
    expect(await screen.findByRole('alert')).toHaveTextContent(/The sample is not valid JSON/)
    setPayload(SAMPLE_A)
    // l'esempio è letto dopo il debounce: si aspetta il messaggio, non il primo alert
    expect(await screen.findByText('Cannot read the fields: payload too large')).toHaveAttribute('role', 'alert')
    expect(screen.queryByText(/The sample is not valid JSON/)).not.toBeInTheDocument()
  })

  it('anteprima in errore → avviso e stato "non ok" al genitore; anteprima buona → ok', async () => {
    const states: PreviewState[] = []
    const failingPreview: GqlMock = { request: { query: PREVIEW_INBOUND_EVENTS, variables: () => true }, error: new Error('resource is empty'), maxUsageCount: Number.POSITIVE_INFINITY }
    const complete: GenericMapping = { ...EMPTY_MAPPING, fields: { ...EMPTY_MAPPING.fields, title: 'alert.name', severity: 'alert.level', resource: 'host.name' }, severityValues: { major: 'critical' } }
    renderWithProviders(<Harness initial={complete} initialPayload={SAMPLE_A} onPreviewState={(s) => states.push(s)} />, { mocks: [keysMock, failingPreview] })
    expect(await screen.findByRole('alert')).toHaveTextContent('The rules do not work yet: resource is empty')
    await waitFor(() => expect(states.at(-1)).toEqual({ hasSample: true, ok: false, error: 'resource is empty' }))
  })
})

describe('GenericMapper — anteprima', () => {
  const complete: GenericMapping = { ...EMPTY_MAPPING, fields: { ...EMPTY_MAPPING.fields, title: 'alerts.0.name', severity: 'alerts.0.level', resource: 'alerts.0.host' } }

  it('payload con più allarmi → "1 di N" con frecce; lo stato ok arriva al genitore; i predefiniti finiscono nella configurazione', async () => {
    const states: PreviewState[] = []
    const previews: PreviewInput[] = []
    const { user } = renderWithProviders(<Harness initial={complete} initialPayload={MULTI} onPreviewState={(s) => states.push(s)} />, { mocks: [keysMock, previewMock(previews)] })
    const aside = screen.getByRole('complementary', { name: 'Preview' })
    expect(await within(aside).findByText('A')).toBeInTheDocument()
    expect(within(aside).getByText('1 of 2')).toBeInTheDocument()
    expect(within(aside).getByText('The sample contains 2 alarms: each becomes an event.')).toBeInTheDocument()
    expect(within(aside).getByRole('button', { name: 'Previous alarm' })).toBeDisabled()
    await user.click(within(aside).getByRole('button', { name: 'Next alarm' }))
    expect(within(aside).getByText('B')).toBeInTheDocument()
    expect(within(aside).getByText('2 of 2')).toBeInTheDocument()
    expect(within(aside).getByRole('button', { name: 'Next alarm' })).toBeDisabled()
    await waitFor(() => expect(states.at(-1)).toEqual({ hasSample: true, ok: true, error: null }))

    await user.selectOptions(screen.getByLabelText('Default severity'), 'info')
    await user.selectOptions(screen.getByLabelText('Default status'), 'resolved')
    await waitFor(() => expect(JSON.parse(previews.at(-1)!.defaultValues)).toEqual({ resourceKind: 'hostname', severity: 'info', status: 'resolved' }))
    // una nuova anteprima riparte dal primo allarme
    expect(await within(aside).findByText('1 of 2')).toBeInTheDocument()
  })

  it('senza esempio: niente anteprima, percorsi comunque scrivibili a mano, stato "nessun esempio" al genitore', async () => {
    const states: PreviewState[] = []
    const { user } = renderWithProviders(<Harness onPreviewState={(s) => states.push(s)} />, { mocks: [] })
    expect(screen.getByText('Paste a sample alarm to see its fields, or type the paths by hand.')).toBeInTheDocument()
    expect(screen.getByText('Map title, severity and resource to see the preview.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Title *'), 'alert.name')
    expect(screen.getByLabelText('Title *')).toHaveValue('alert.name')
    expect(states.at(-1)).toEqual({ hasSample: false, ok: false, error: null })
  })
})
