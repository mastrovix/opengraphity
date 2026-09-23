/**
 * «UPDATE THE MAP»: components whose CI is gone, and an answer without the map.
 *
 * G-MON-10: a CI deleted from the CMDB has no level and no role any more —
 * only its reference is left in the map. The API answers level 0 and role
 * «component», and the dialog used to print «Level 0 · Component» as if those
 * were values it had read. It must say the CI is no longer in the CMDB.
 * Choosing a component twice un-chooses it, and an «Apply» whose answer does
 * not carry the map is an error in the dialog, never a success toast.
 * `UpdateServiceMapDialog.test.tsx` and `.more.test.tsx` cover the rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { mapDetail, proposal, ciRef } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'
import { UpdateServiceMapDialog } from './UpdateServiceMapDialog'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const GHOST = { __typename: 'ServiceMapNode', ci: ciRef('ghost-01', 'ghost-01', 'server'), level: 0, role: 'component', addedBy: 'gone' }
const CACHE = { __typename: 'ServiceMapNode', ci: ciRef('cache-02', 'cache-02', 'microservice'), level: 2, role: 'component', addedBy: 'auto' }

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  apolloFinto.risposte['GetServiceMapProposal'] = { serviceMapProposal: proposal({ removed: [GHOST, CACHE] }) }
})

const openDialog = () => renderWithProviders(
  <UpdateServiceMapDialog map={mapDetail({ autoSync: false }) as unknown as ServiceMapDetail} open onClose={() => {}} />,
)
const removedRow = (ciId: string) => screen.getAllByTestId('proposal-removed').find((r) => r.getAttribute('data-ci-id') === ciId)!

describe('UpdateServiceMapDialog', () => {
  it('a component whose CI was deleted says so, instead of a level and a role nobody read (G-MON-10)', () => {
    openDialog()
    const ghost = within(removedRow('ghost-01')).getByText('CI no longer in the CMDB')
    expect(ghost).toHaveAttribute('title', expect.stringContaining('This CI was deleted from the CMDB'))
    expect(within(removedRow('ghost-01')).queryByText(/Level 0/)).toBeNull()
    expect(within(removedRow('cache-02')).getByText('Level 2 · Component')).toBeInTheDocument()
  })

  it('choosing a component twice un-chooses it, and with nothing chosen there is nothing to apply', async () => {
    const { user } = openDialog()
    const remove = screen.getByRole('checkbox', { name: 'Remove ghost-01 from the map' })
    await user.click(remove)
    expect(remove).toBeChecked()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
    await user.click(remove)
    expect(remove).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('an «Apply» whose answer does not carry the map is an error in the dialog, not a success', async () => {
    apolloFinto.esiti['ApplyServiceMapProposal'] = { data: { applyServiceMapProposal: null } }
    const { user } = openDialog()
    await user.click(screen.getByRole('checkbox', { name: 'Remove cache-02 from the map' }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('applyServiceMapProposal did not return the map')
    expect(apolloFinto.chiamata('ApplyServiceMapProposal')).toEqual({ id: 'map-1', expectedVersion: 3, add: [], exclude: [], remove: ['cache-02'] })
    expect(toast.success).not.toHaveBeenCalled()
  })
})
