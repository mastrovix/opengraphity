/**
 * GenericMapper: "Use example", the resource kind, the status translation,
 * the full preview, and the shared value table used by the preset connectors.
 *
 * Why it matters: "Use example" is how an admin without a real alarm at hand
 * starts mapping — if it fails silently the page just looks stuck; the
 * resource kind decides which CI alias an alarm is matched against (a wrong
 * kind means no CI, so no incident); the preview is the only proof the rules
 * work before alarms start flowing; and a value typed twice in the value
 * table must not wipe the translation already chosen for it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { GenericMapper, ValueTable } from './GenericMapper'
import { EMPTY_MAPPING, type GenericMapping } from './sourceConfig'
import { GET_PAYLOAD_KEYS, GET_SAMPLE_INBOUND_PAYLOAD } from '@/graphql/queries'
import { PREVIEW_INBOUND_EVENTS } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import i18n from '@/i18n/i18n'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const T = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string
const SAMPLE = JSON.stringify({ alert: { name: 'Disk full', level: 'major' }, host: { name: 'db-01' }, state: 'open' })

const keysMock: GqlMock = {
  request: { query: GET_PAYLOAD_KEYS, variables: () => true },
  result: { data: { payloadKeys: [
    { __typename: 'PayloadKey', path: 'alert.name', sample: 'Disk full' },
    // A key without a sample value: the option shows only the path.
    { __typename: 'PayloadKey', path: 'host.name', sample: '' },
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

function Harness({ initial = EMPTY_MAPPING, initialPayload = '', onMapping }: { initial?: GenericMapping; initialPayload?: string; onMapping?: (m: GenericMapping) => void }) {
  const [mapping, setMapping] = useState(initial)
  const [payload, setPayload] = useState(initialPayload)
  return <GenericMapper mapping={mapping} onChange={(m) => { setMapping(m); onMapping?.(m) }} payload={payload} onPayloadChange={setPayload} />
}

beforeEach(() => { vi.mocked(toast.error).mockClear() })

describe('GenericMapper — Use example', () => {
  it('fills the sample box with the example the API provides', async () => {
    const sampleMock: GqlMock = {
      request: { query: GET_SAMPLE_INBOUND_PAYLOAD, variables: { connectorKind: 'generic' } },
      result: { data: { sampleInboundPayload: SAMPLE } },
    }
    const { user } = renderWithProviders(<Harness />, { mocks: [sampleMock, keysMock] })
    await user.click(screen.getByRole('button', { name: T('monitoring.mapper.useSample') }))
    await waitFor(() => expect(screen.getByLabelText(T('monitoring.mapper.payloadLabel'))).toHaveValue(SAMPLE))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a failing example request is said out loud, not swallowed', async () => {
    const failing: GqlMock = {
      request: { query: GET_SAMPLE_INBOUND_PAYLOAD, variables: { connectorKind: 'generic' } },
      error: new Error('connector unknown'),
    }
    const { user } = renderWithProviders(<Harness />, { mocks: [failing] })
    await user.click(screen.getByRole('button', { name: T('monitoring.mapper.useSample') }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('connector unknown')))
    expect(screen.getByLabelText(T('monitoring.mapper.payloadLabel'))).toHaveValue('')
  })
})

describe('GenericMapper — resource kind and status', () => {
  it('the resource kind chosen ends up in the mapping', async () => {
    const onMapping = vi.fn()
    const { user } = renderWithProviders(<Harness onMapping={onMapping} />, { mocks: [] })
    await user.selectOptions(screen.getByLabelText(T('monitoring.mapper.resourceKind')), 'ip')
    expect(onMapping).toHaveBeenLastCalledWith(expect.objectContaining({ resourceKind: 'ip' }))
  })

  it('a status value can be re-translated by hand', async () => {
    const onMapping = vi.fn()
    const { user } = renderWithProviders(<Harness initialPayload={SAMPLE} onMapping={onMapping} />, { mocks: [keysMock] })
    await user.type(screen.getByLabelText(`${T('monitoring.mapper.fields.status')}`), 'state')
    const open = screen.getByLabelText(T('monitoring.mapper.valueBecomes', { value: 'open' }))
    expect(open).toHaveValue('firing')
    await user.selectOptions(open, 'resolved')
    expect(onMapping).toHaveBeenLastCalledWith(expect.objectContaining({ statusValues: { open: 'resolved' } }))
  })

  it('field suggestions list the paths, with the sample value when there is one', async () => {
    const { container } = renderWithProviders(<Harness initialPayload={SAMPLE} />, { mocks: [keysMock] })
    await waitFor(() => expect(container.querySelectorAll('datalist option').length).toBeGreaterThan(0))
    const labels = [...container.querySelector('datalist')!.querySelectorAll('option')].map((o) => o.textContent)
    expect(labels.some((l) => l?.includes('Disk full'))).toBe(true)
    // No sample: no dangling " — ".
    expect(labels.some((l) => l && !l.includes('—'))).toBe(true)
  })
})

describe('GenericMapper — preview', () => {
  it('shows description and external id when the rules map them, and Prev goes back', async () => {
    const complete: GenericMapping = { ...EMPTY_MAPPING, fields: { ...EMPTY_MAPPING.fields, title: 'alert.name', severity: 'alert.level', resource: 'host.name' }, severityValues: { major: 'critical' } }
    const previewMock: GqlMock = {
      request: { query: PREVIEW_INBOUND_EVENTS, variables: () => true },
      result: { data: { previewInboundEvents: [
        { __typename: 'NormalizedEventPreview', externalId: 'ext-42', status: 'firing', severity: 'critical', title: 'First', description: 'The disk is full', resource: 'db-01', resourceKind: 'hostname', labels: '{}' },
        { __typename: 'NormalizedEventPreview', externalId: null, status: 'resolved', severity: 'warning', title: 'Second', description: null, resource: 'db-02', resourceKind: 'hostname', labels: '{}' },
      ] } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    const { user } = renderWithProviders(<Harness initial={complete} initialPayload={SAMPLE} />, { mocks: [keysMock, previewMock] })
    const aside = screen.getByRole('complementary', { name: T('monitoring.mapper.preview.title') })
    expect(await within(aside).findByText('First')).toBeInTheDocument()
    expect(within(aside).getByText('The disk is full')).toBeInTheDocument()
    expect(within(aside).getByText('ext-42')).toBeInTheDocument()
    await user.click(within(aside).getByRole('button', { name: T('monitoring.mapper.preview.next') }))
    expect(within(aside).getByText('Second')).toBeInTheDocument()
    // Without description/external id, those rows disappear instead of showing empty.
    expect(within(aside).queryByText(T('monitoring.mapper.fields.externalId'))).toBeNull()
    await user.click(within(aside).getByRole('button', { name: T('monitoring.mapper.preview.prev') }))
    expect(within(aside).getByText('First')).toBeInTheDocument()
  })
})

describe('ValueTable (shared with the preset connectors)', () => {
  it('shows the hint, and adding an existing or empty value changes nothing', async () => {
    const onChange = vi.fn()
    const { user } = renderWithProviders(
      <ValueTable title="Severity" hint="The tool sends P1…P5" table={{ P1: 'critical' }} targets={['info', 'warning', 'critical'] as const}
        targetLabel={(v) => v} onChange={onChange} idPrefix="vt" />,
    )
    expect(screen.getByText('The tool sends P1…P5')).toBeInTheDocument()
    // No fieldPath (preset connectors): the table is always active.
    expect(screen.queryByText(T('monitoring.mapper.pickFieldFirst'))).toBeNull()
    const add = screen.getByLabelText(T('monitoring.mapper.addValue'))
    await user.type(add, 'P1{Enter}')
    // An existing value would have reset "critical" to "not translated".
    expect(onChange).not.toHaveBeenCalled()
    expect(add).toHaveValue('')
    await user.type(add, '   {Enter}')
    expect(onChange).not.toHaveBeenCalled()
  })
})
