/**
 * Dialogo «Aggiorna mappa» (ondata 2): i tre elenchi del diff col grafo,
 * spunte che partono vuote, «includi» ed «escludi» che si escludono,
 * riepilogo «+N −M esclusi K», apply con `expectedVersion`, mappa già
 * allineata, errore della proposta e riammissione di un CI escluso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { UpdateServiceMapDialog } from './UpdateServiceMapDialog'
import { GET_SERVICE_MAP_PROPOSAL } from '@/graphql/queries'
import { APPLY_SERVICE_MAP_PROPOSAL, REMOVE_SERVICE_MAP_EXCLUSION } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapDetail, proposal } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

const detail = () => mapDetail() as unknown as ServiceMapDetail

const proposalMock = (over: Record<string, unknown> = {}): GqlMock => ({
  request: { query: GET_SERVICE_MAP_PROPOSAL, variables: { id: 'map-1' } },
  result: { data: { serviceMapProposal: proposal(over) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function renderDialog(opts: { mocks?: GqlMock[]; onClose?: () => void } = {}) {
  return renderWithProviders(
    <UpdateServiceMapDialog map={detail()} open onClose={opts.onClose ?? (() => {})} />,
    { mocks: opts.mocks ?? [proposalMock()] },
  )
}

const rowOf = (testId: string, ciId: string) => screen.getAllByTestId(testId).find((r) => r.getAttribute('data-ci-id') === ciId)!

describe('UpdateServiceMapDialog', () => {
  it('mostra i tre elenchi con le spunte vuote e il riepilogo a zero', async () => {
    renderDialog()
    expect(await screen.findByText('2 new components')).toBeInTheDocument()
    expect(screen.getByText('1 component gone')).toBeInTheDocument()
    expect(screen.getByText('1 component moved')).toBeInTheDocument()
    expect(screen.getAllByTestId('proposal-added').map((r) => r.getAttribute('data-ci-id'))).toEqual(['lb-09', 'queue-01'])
    expect(rowOf('proposal-added', 'lb-09')).toHaveTextContent('level 2 · Infrastructure · Weighted · weight 5')
    expect(rowOf('proposal-moved', 'db-01')).toHaveTextContent('level 2 → 3')
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked()
    expect(screen.getByTestId('proposal-summary')).toHaveTextContent('+0 −0 excluded 0')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('«includi» ed «escludi» si escludono; il riepilogo conta le scelte', async () => {
    const { user } = renderDialog()
    await screen.findByText('2 new components')
    await user.click(screen.getByLabelText('Include lb-09'))
    expect(screen.getByTestId('proposal-summary')).toHaveTextContent('+1 −0 excluded 0')
    await user.click(screen.getByLabelText('Never propose lb-09 again'))
    expect(screen.getByLabelText('Include lb-09')).not.toBeChecked()
    expect(screen.getByTestId('proposal-summary')).toHaveTextContent('+0 −0 excluded 1')
    await user.click(screen.getByLabelText('Remove cache-02 from the map'))
    expect(screen.getByTestId('proposal-summary')).toHaveTextContent('+0 −1 excluded 1')
  })

  it('applica con expectedVersion e chiude; il toast dice cosa è cambiato', async () => {
    const seen: unknown[] = []
    const onClose = vi.fn()
    const apply: GqlMock = {
      request: { query: APPLY_SERVICE_MAP_PROPOSAL, variables: (v) => { seen.push(v); return true } },
      result: { data: { applyServiceMapProposal: mapDetail({ version: 4 }) } },
    }
    const { user } = renderDialog({ mocks: [proposalMock(), apply], onClose })
    await screen.findByText('2 new components')
    await user.click(screen.getByLabelText('Include lb-09'))
    await user.click(screen.getByLabelText('Never propose queue-01 again'))
    await user.click(screen.getByLabelText('Remove cache-02 from the map'))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1', expectedVersion: 3, add: ['lb-09'], exclude: ['queue-01'], remove: ['cache-02'] }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Map updated: +1 −1, 1 excluded'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('apply che fallisce → riga d\'errore nel dialogo, che resta aperto', async () => {
    const onClose = vi.fn()
    const failing: GqlMock = { request: { query: APPLY_SERVICE_MAP_PROPOSAL, variables: () => true }, error: new Error('version 5 expected') }
    const { user } = renderDialog({ mocks: [proposalMock(), failing], onClose })
    await screen.findByText('2 new components')
    await user.click(screen.getByLabelText('Include lb-09'))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Operation failed: version 5 expected.')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('mappa allineata: lo dice, senza elenchi', async () => {
    renderDialog({ mocks: [proposalMock({ added: [], removed: [], moved: [], totalProposed: 4 })] })
    expect(await screen.findByText('The map is aligned with the graph: nothing to add, remove or move.')).toBeInTheDocument()
    expect(screen.queryAllByTestId('proposal-added')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('esclusioni: elenco con «Riammetti» → mutation con expectedVersion e proposta riletta', async () => {
    const seen: unknown[] = []
    const readmit: GqlMock = {
      request: { query: REMOVE_SERVICE_MAP_EXCLUSION, variables: (v) => { seen.push(v); return true } },
      result: { data: { removeServiceMapExclusion: mapDetail({ version: 4 }) } },
    }
    const { user } = renderDialog({ mocks: [proposalMock(), readmit] })
    expect(await screen.findByText('1 excluded component')).toBeInTheDocument()
    expect(rowOf('proposal-excluded', 'old-vm')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Re-admit old-vm' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1', expectedVersion: 3, ciId: 'old-vm' }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('old-vm re-admitted: it comes back in the next proposal'))
  })

  it('nessuna esclusione: lo dice invece di lasciare la sezione vuota', async () => {
    renderDialog({ mocks: [proposalMock({ excluded: [] })] })
    expect(await screen.findByText('No exclusion.')).toBeInTheDocument()
  })

  it('proposta che fallisce → errore visibile, mai un dialogo muto', async () => {
    const failing: GqlMock = { request: { query: GET_SERVICE_MAP_PROPOSAL, variables: { id: 'map-1' } }, error: new Error('graph unreachable') }
    renderDialog({ mocks: [failing] })
    expect(await screen.findByText('Proposal unavailable: graph unreachable')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' })).toBeDisabled()
  })
})
