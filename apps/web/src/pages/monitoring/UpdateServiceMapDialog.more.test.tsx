/**
 * «Update map» dialog: re-admitting an excluded component when the API
 * answers without the map. The dialog must not claim success on an empty
 * answer: a "re-admitted" toast with nothing re-admitted sends the operator
 * looking for a component that will never come back. The failure is shown in
 * the dialog instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { toast } from 'sonner'
import { UpdateServiceMapDialog } from './UpdateServiceMapDialog'
import { GET_SERVICE_MAP_PROPOSAL } from '@/graphql/queries'
import { REMOVE_SERVICE_MAP_EXCLUSION } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapDetail, proposal } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear() })

const proposalMock: GqlMock = {
  request: { query: GET_SERVICE_MAP_PROPOSAL, variables: { id: 'map-1' } },
  result: { data: { serviceMapProposal: proposal() } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

describe('UpdateServiceMapDialog: re-admit without a result', () => {
  it('an empty answer is an error in the dialog, not a success toast', async () => {
    const readmit: GqlMock = {
      request: { query: REMOVE_SERVICE_MAP_EXCLUSION, variables: () => true },
      result: { data: { removeServiceMapExclusion: null } },
    }
    const { user } = renderWithProviders(
      <UpdateServiceMapDialog map={mapDetail({ autoSync: false }) as unknown as ServiceMapDetail} open onClose={() => {}} />,
      { mocks: [proposalMock, readmit] },
    )
    await user.click(await screen.findByRole('button', { name: 'Re-admit old-vm' }))
    expect(await screen.findByText(/removeServiceMapExclusion did not return the map/)).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
