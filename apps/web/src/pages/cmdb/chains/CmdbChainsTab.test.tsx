/**
 * CMDB HEALTH → CHAINS.
 *
 * What the tab must do: list the chains with their kind, their size and how
 * many roots in service follow them whole; open a chain in the editor from the
 * list (a second click closes it) with the choice in the URL; offer «New
 * chain» only to who can change the metamodel, starting from a type that has
 * a chain family; say plainly when no chain is drawn — the relations follow
 * the metamodel alone then; show a failed read with a retry. The editor is a stand-in
 * here (its own tests: ChainEditor.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { MetamodelContext, type CITypeDef } from '@/contexts/MetamodelContext'
import { CmdbChainsTab } from './CmdbChainsTab'
import type { ChainDraft } from './chainModel'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('./ChainEditor', () => ({
  ChainEditor: ({ initial, canEdit, onDone, onCancel }: { initial: ChainDraft; canEdit: boolean; onDone: (id: string | null) => void; onCancel: () => void }) => (
    <div data-testid="editor">
      {`${initial.id ?? 'new'} · ${initial.name || '—'} · ${initial.nodes.map((n) => n.ciType).join('/')} · edit ${String(canEdit)}`}
      <button type="button" onClick={() => onDone('c2')}>saved</button>
      <button type="button" onClick={onCancel}>cancel</button>
    </div>
  ),
}))

const type = (name: string, chainFamilies: string[]) =>
  ({ id: name, name, label: name, labels: [], icon: 'box', color: 'var(--color-slate)', active: true, scope: 'base', tenantId: 'system',
    validationScript: null, chainFamilies, serviceRole: null, fields: [], relations: [], systemRelations: [] }) as unknown as CITypeDef
// The first type has no family: a new chain starts from the first type that has one.
const TYPES = [type('floor_plan', []), type('business_application', ['Application'])]
const withTypes = (children: ReactNode) => (
  <MetamodelContext.Provider value={{ ciTypes: TYPES, loading: false, error: null, getCIType: (n: string) => TYPES.find((t) => t.name === n) }}>{children}</MetamodelContext.Provider>
)
const node = (id: string, parentId: string | null) => ({ id, parentId, ciType: 'business_application', relationType: null, direction: null, required: true })
const CHAINS = { cmdbChains: [
  { id: 'c1', name: 'Application services', kind: 'application', createdAt: null, updatedAt: null, nodes: [node('r', null), node('a', 'r'), node('s', 'a')] },
  { id: 'c2', name: 'CI groups', kind: 'mixed', createdAt: null, updatedAt: null, nodes: [node('g', null)] },
] }
const COVERAGE = [{ chainId: 'c1', name: 'Application services', kind: 'application', roots: 2000, complete: 1500 }]
const mount = (canEdit = true, route = '/cmdb/health?tab=chains') => renderWithProviders(withTypes(<CmdbChainsTab coverage={COVERAGE} canEdit={canEdit} />), { route })

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetCmdbChains'] = CHAINS
})

describe('CmdbChainsTab', () => {
  it('each chain: its name, its kind, its size, and how many roots in service follow it whole', () => {
    mount()
    const apps = screen.getByRole('button', { name: /Application services/ })
    expect(apps).toHaveTextContent('Application · 3 types')
    expect(apps).toHaveTextContent('1,500 of 2,000 roots follow it · 75%')
    expect(screen.getByRole('button', { name: /CI groups/ })).toHaveTextContent('Mixed · 1 typeNo root in service')
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('a chain opens in the editor with ?chain=, a second click closes it; after a save the saved one stays open', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: /Application services/ }))
    await attendiURL('/cmdb/health', { tab: 'chains', chain: 'c1' })
    expect(screen.getByTestId('editor')).toHaveTextContent('c1 · Application services · business_application/business_application/business_application · edit true')
    await user.click(screen.getByRole('button', { name: 'saved' }))
    await attendiURL('/cmdb/health', { tab: 'chains', chain: 'c2' })
    await user.click(screen.getByRole('button', { name: /CI groups/ }))
    await attendiURL('/cmdb/health', { tab: 'chains' })
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('«New chain» opens an empty one from the first type with a chain family; Cancel closes it', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'New chain' }))
    await attendiURL('/cmdb/health', { tab: 'chains', chain: 'new' })
    expect(screen.getByTestId('editor')).toHaveTextContent('new · — · business_application · edit true')
    await user.click(screen.getByRole('button', { name: 'cancel' }))
    await attendiURL('/cmdb/health', { tab: 'chains' })
  })

  it('read-only: no «New chain», and a link to a new one opens nothing', () => {
    mount(false, '/cmdb/health?tab=chains&chain=new')
    expect(screen.queryByRole('button', { name: 'New chain' })).toBeNull()
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('no chain drawn: it says the relations follow the metamodel alone, and CMDB Health cannot judge', () => {
    apolloFinto.risposte['GetCmdbChains'] = { cmdbChains: [] }
    mount()
    expect(screen.getByRole('status')).toHaveTextContent('No chain drawn: the relations between CIs follow the metamodel alone, and CMDB Health cannot judge where a CI belongs.')
  })

  it('a failed read shows the error with a retry', async () => {
    apolloFinto.erroriQuery['GetCmdbChains'] = new Error('chains down')
    const { user } = mount()
    expect(screen.getByText('chains down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
