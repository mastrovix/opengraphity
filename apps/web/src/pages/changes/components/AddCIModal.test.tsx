/**
 * ADDING A CI TO A CHANGE.
 *
 * From the change's "CIs involved" card a user searches the CMDB and adds the
 * CI the change will touch. The API refuses a CI without an owner group or a
 * support group (nobody could assess or plan it), and a CI of a type excluded
 * for changes: the modal must not offer what would then be refused, and must
 * say WHY a CI cannot be added instead of a dead button. Pinned here:
 *  - no search under two characters, and none before the excluded types are
 *    known (for an instant it would offer them);
 *  - each result shows its type, environment and the two groups;
 *  - a CI already in the change is marked, not offered twice;
 *  - adding sends the change and the CI, re-reads affected CIs, impacted CIs
 *    and the audit trail, and says it worked; a failure says so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { AddCIModal } = await import('./AddCIModal')

const DB = { id: 'ci-db', name: 'orders-db', type: 'database', environment: 'production', ownerGroup: { id: 'g1', name: 'DBA' }, supportGroup: { id: 'g2', name: 'Data Ops' } }
const ORPHAN = { id: 'ci-old', name: 'legacy-box', type: 'server', environment: null, ownerGroup: null, supportGroup: { id: 'g2', name: 'Data Ops' } }
const NO_SUPPORT = { id: 'ci-web', name: 'web-01', type: null, environment: 'staging', ownerGroup: { id: 'g1', name: 'DBA' }, supportGroup: null }
const THERE = { id: 'ci-app', name: 'orders-app', type: 'application', environment: 'production', ownerGroup: { id: 'g1', name: 'DBA' }, supportGroup: { id: 'g2', name: 'Data Ops' } }

function mount() {
  const refetch = { affected: vi.fn(async () => ({})), impacted: vi.fn(async () => ({})), audit: vi.fn(async () => ({})) }
  const onClose = vi.fn()
  const r = renderWithProviders(withVocabularyLabels(
    <AddCIModal
      changeId="chg-1"
      existingCIIds={new Set(['ci-app'])}
      onClose={onClose}
      refetchAffected={refetch.affected}
      refetchImpacted={refetch.impacted}
      refetchAudit={refetch.audit}
    />,
  ))
  const dialog = screen.getByRole('dialog', { name: 'Add a CI to the change' })
  return { ...r, dialog, refetch, onClose }
}

const search = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Search a CI by name...' }), { target: { value } })

/** The row of a result, found by the CI name. */
const row = (dialog: HTMLElement, name: string) => within(dialog).getByText(name).parentElement!.parentElement!

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetTicketCIExclusions'] = { ticketCIExclusions: [{ ticketType: 'change', ciTypes: ['person'] }] }
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [DB, ORPHAN, NO_SUPPORT, THERE] } }
})

describe('AddCIModal — searching', () => {
  it('asks for two characters and does not search before', () => {
    const { dialog } = mount()
    expect(within(dialog).getByText('Type at least 2 characters to search')).toBeInTheDocument()
    search('o')
    expect(within(dialog).getByText('Type at least 2 characters to search')).toBeInTheDocument()
    expect(apolloFinto.chiamata('GetAllCIs')).toBeUndefined()
  })

  it('searches with the types excluded for changes, so they are never offered', () => {
    mount()
    expect(apolloFinto.chiamata('GetTicketCIExclusions')).toEqual({ ticketType: 'change' })
    search('or')
    expect(apolloFinto.chiamata('GetAllCIs')).toEqual({ search: 'or', limit: 20, excludeCiTypes: ['person'] })
  })

  it('does not search while the excluded types are still unknown', () => {
    apolloFinto.risposte['GetTicketCIExclusions'] = undefined
    mount()
    search('orders')
    expect(apolloFinto.chiamata('GetAllCIs')).toBeUndefined()
  })

  it('says when nothing matches', () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [] } }
    const { dialog } = mount()
    search('zz')
    expect(within(dialog).getByText('No CI found')).toBeInTheDocument()
  })

  it('shows each CI with the labels of its type and environment, and its two groups', () => {
    const { dialog } = mount()
    search('or')
    const db = row(dialog, 'orders-db')
    expect(within(db).getByText('Database')).toBeInTheDocument()
    expect(within(db).getByText('Production')).toBeInTheDocument()
    expect(within(db).getByText('Owner Group: DBA')).toBeInTheDocument()
    expect(within(db).getByText('Support Group: Data Ops')).toBeInTheDocument()
    // A CI without an environment shows no empty chip, and a missing group reads as a dash.
    const orphan = row(dialog, 'legacy-box')
    expect(within(orphan).getByText('Owner Group: —')).toBeInTheDocument()
    expect(within(orphan).queryByText('Production')).not.toBeInTheDocument()
  })
})

describe('AddCIModal — what can be added', () => {
  it('a CI already in the change is marked and cannot be added twice', () => {
    const { dialog } = mount()
    search('or')
    const there = row(dialog, 'orders-app')
    expect(within(there).getByText('Already added')).toBeInTheDocument()
    expect(within(there).queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
  })

  it('a CI without owner group or without support group cannot be added, and the button says why', () => {
    const { dialog } = mount()
    search('or')
    for (const name of ['legacy-box', 'web-01']) {
      const button = within(row(dialog, name)).getByRole('button', { name: 'Add' })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', 'Owner group and support group are required')
    }
    const ok = within(row(dialog, 'orders-db')).getByRole('button', { name: 'Add' })
    expect(ok).toBeEnabled()
    expect(ok).not.toHaveAttribute('title')
  })

  it('adding sends change and CI, re-reads the three lists and confirms', async () => {
    const { user, dialog, refetch } = mount()
    search('or')
    await user.click(within(row(dialog, 'orders-db')).getByRole('button', { name: 'Add' }))
    expect(apolloFinto.chiamata('AddCIToChange')).toEqual({ changeId: 'chg-1', ciId: 'ci-db' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('CI added'))
    expect(refetch.affected).toHaveBeenCalled()
    expect(refetch.impacted).toHaveBeenCalled()
    expect(refetch.audit).toHaveBeenCalled()
  })

  it('a refused add is reported and nothing is re-read', async () => {
    apolloFinto.esiti['AddCIToChange'] = { error: new Error('CI type excluded for changes') }
    const { user, dialog, refetch } = mount()
    search('or')
    await user.click(within(row(dialog, 'orders-db')).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('CI type excluded for changes'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(refetch.affected).not.toHaveBeenCalled()
  })

  it('the close button hands the closing to the page', async () => {
    const { user, dialog, onClose } = mount()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
