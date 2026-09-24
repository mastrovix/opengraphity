/**
 * THE PANEL OF THE CHOSEN TYPE.
 *
 * What it must do: say where the type's link comes from, in words and the
 * relation's own direction (every link is required: nothing to toggle); remove the
 * type — saying so when what hangs below goes too; and add below it only the
 * links the API offers for this type in a chain of this kind, never one
 * already drawn there. Who cannot change the metamodel reads, and changes
 * nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { ChainNodePanel, linkWords } from './ChainNodePanel'
import type { ChainNode } from './chainModel'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const NODES: ChainNode[] = [
  { id: 'r', parentId: null, ciType: 'application', relationType: null, direction: null, required: true },
  { id: 's', parentId: 'r', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing', required: true },
  { id: 'c', parentId: 's', ciType: 'certificate', relationType: 'INSTALLED_ON', direction: 'incoming', required: false },
]
const OPTIONS = [
  { relationType: 'HOSTED_ON', direction: 'outgoing', ciType: 'server' },
  { relationType: 'USES_CERTIFICATE', direction: 'outgoing', ciType: 'certificate' },
  { relationType: 'DEPENDS_ON', direction: 'outgoing', ciType: 'database' },
]

const handlers = () => ({ onRemove: vi.fn(), onAdd: vi.fn() })
const mount = (id: string, canEdit = true, h = handlers()) => ({
  h, ...renderWithProviders(<ChainNodePanel node={NODES.find((n) => n.id === id)!} nodes={NODES} kind="application" canEdit={canEdit} {...h} />),
})

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetCmdbChainLinkOptions'] = { cmdbChainLinkOptions: OPTIONS }
})

describe('ChainNodePanel', () => {
  it('the root: its name, «root», and the links it may take below', () => {
    mount('r')
    expect(screen.getByRole('heading', { name: /^Application.*root$/ })).toBeInTheDocument()
    expect(apolloFinto.chiamata('GetCmdbChainLinkOptions')).toEqual({ ciType: 'application', kind: 'application' })
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('a link below: where it comes from, the relation\'s way — and nothing to make optional', () => {
    mount('c')
    expect(screen.getByText('From Server: Certificate → Installed on')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('removing says when what hangs below goes too', async () => {
    const { user, h } = mount('s')
    await user.click(screen.getByRole('button', { name: 'Remove this type and what hangs below' }))
    expect(h.onRemove).toHaveBeenCalledOnce()
    mount('c')
    expect(screen.getByRole('button', { name: 'Remove this type' })).toBeInTheDocument()
  })

  it('adds only a link the API offers and that is not drawn there yet', async () => {
    const { user, h } = mount('r')
    const pick = screen.getByRole('combobox', { name: 'Add a link below' })
    // The server is already hosted below the application: not offered twice.
    expect([...pick.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Choose a link…', 'Uses certificate → Certificate', 'Depends on → Database'])
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    await user.selectOptions(pick, 'DEPENDS_ON|outgoing|database')
    await user.click(add)
    expect(h.onAdd).toHaveBeenCalledWith(OPTIONS[2])
    // The choice starts again after an add.
    expect(pick).toHaveValue('')
  })

  it('no link left to add is said; a failed read shows its error', () => {
    apolloFinto.risposte['GetCmdbChainLinkOptions'] = { cmdbChainLinkOptions: [OPTIONS[0]] }
    const first = mount('r')
    expect(screen.getByText('The metamodel and the families allow no further link below this type.')).toBeInTheDocument()
    first.unmount()
    apolloFinto.erroriQuery['GetCmdbChainLinkOptions'] = new Error('options down')
    mount('r')
    expect(screen.getByRole('alert')).toHaveTextContent('options down')
  })

  it('read-only: nothing to remove or add', () => {
    mount('c', false)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('a link in words: the arrow the relation\'s way', () => {
    expect(linkWords({ relationType: 'X', direction: 'outgoing', ciType: 't' }, 'Hosted on', 'Server')).toBe('Hosted on → Server')
    expect(linkWords({ relationType: 'X', direction: 'incoming', ciType: 't' }, 'Installed on', 'Certificate')).toBe('Certificate → Installed on')
  })
})
