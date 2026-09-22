/**
 * AffectedCIList: opening and closing, searching, opening a CI and removing it.
 *
 * Why it matters: "Add CI" on a collapsed card must open it — the search box
 * lives in the body, so a click that only toggled the hidden search would do
 * nothing visible; the text typed must reach the parent (it runs the search
 * query); the CI name must lead to that CI's page; and the remove button must
 * remove the CI it sits next to, not another one.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { AffectedCIList, type AffectedCIRef } from './AffectedCIList'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { baseCITypeMock } from '@/test/mocks/gql'
import i18n from '@/i18n/i18n'

const T = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

const ci = (over: Partial<AffectedCIRef>): AffectedCIRef =>
  ({ id: 'ci-1', name: 'db-01', type: 'server', status: 'active', environment: '', ...over })

function renderList(props: Partial<Parameters<typeof AffectedCIList>[0]> = {}) {
  const handlers = { onSearchChange: vi.fn(), onAddCI: vi.fn(), onRemoveCI: vi.fn() }
  const r = renderWithProviders(
    <AffectedCIList affectedCIs={[]} excludedTypes={[]} ciResults={[]} {...handlers} {...props} />,
    { mocks: [baseCITypeMock()] },
  )
  return { ...r, ...handlers }
}

describe('AffectedCIList — search', () => {
  it('"Add CI" on a collapsed card opens it and shows the search box; typing reaches the parent', async () => {
    const { user, onSearchChange } = renderList()
    expect(screen.queryByText(T('components.affectedCI.empty'))).toBeNull()
    await user.click(screen.getByRole('button', { name: T('attachments.addCI') }))
    expect(screen.getByText(T('components.affectedCI.empty'))).toBeInTheDocument()
    const box = screen.getByPlaceholderText(T('attachments.searchCIByName'))
    await user.type(box, 'db')
    expect(onSearchChange).toHaveBeenLastCalledWith('db')
    // The same button now closes the search, and the card stays open.
    await user.click(screen.getByRole('button', { name: T('common.close') }))
    expect(screen.queryByPlaceholderText(T('attachments.searchCIByName'))).toBeNull()
    expect(screen.getByText(T('components.affectedCI.empty'))).toBeInTheDocument()
  })

  it('a CI already linked is not proposed again; adding one clears and closes the search', async () => {
    const linked = ci({ id: 'a', name: 'already-linked' })
    const { user, onAddCI, onSearchChange } = renderList({
      defaultOpen: true,
      affectedCIs: [linked],
      ciResults: [linked, ci({ id: 'b', name: 'new-one' })],
    })
    await user.click(screen.getByRole('button', { name: T('attachments.addCI') }))
    expect(screen.getByText('new-one')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '+' })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '+' }))
    expect(onAddCI).toHaveBeenCalledWith('b')
    expect(onSearchChange).toHaveBeenLastCalledWith('')
    expect(screen.queryByPlaceholderText(T('attachments.searchCIByName'))).toBeNull()
  })
})

describe('AffectedCIList — the linked CIs', () => {
  it('the header toggles the card open and closed', async () => {
    const { user } = renderList({ defaultOpen: true })
    expect(screen.getByText(T('components.affectedCI.empty'))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: new RegExp(T('components.affectedCI.title')) }))
    expect(screen.queryByText(T('components.affectedCI.empty'))).toBeNull()
  })

  it('the name opens the CI page, the X removes that CI, and the environment is shown', async () => {
    const { user, onRemoveCI } = renderList({
      defaultOpen: true,
      affectedCIs: [ci({ id: 'srv-9', name: 'web-09', environment: 'production' })],
    })
    await user.click(await screen.findByRole('button', { name: /server/i }))
    expect(screen.getByText(/production/i)).toBeInTheDocument()
    await user.click(screen.getByTitle(T('components.affectedCI.remove')))
    expect(onRemoveCI).toHaveBeenCalledWith('srv-9')
    await user.click(screen.getByRole('button', { name: 'web-09' }))
    await attendiURL('/ci/server/srv-9')
  })
})
