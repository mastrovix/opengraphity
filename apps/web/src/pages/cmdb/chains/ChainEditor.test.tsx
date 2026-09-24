/**
 * ONE CMDB CHAIN IN THE EDITOR.
 *
 * What it must do: change nothing until «Save», and save the whole tree —
 * a new chain created, a saved one updated — as the API takes it; show the
 * API's refusal as it comes and stay open; delete only after a confirmation;
 * let the root change only while nothing hangs below it, among the types that
 * have a chain family; build the tree from the panel (add, remove), every link required.
 * Who cannot change the metamodel reads: no field, no button.
 * The drawing is a stand-in here (its own tests: ChainCanvas.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { MetamodelContext, type CITypeDef } from '@/contexts/MetamodelContext'
import { ChainEditor } from './ChainEditor'
import type { ChainDraft, ChainNode } from './chainModel'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const ui = vi.hoisted(() => ({ toast: { success: vi.fn() }, showError: vi.fn() }))
vi.mock('sonner', () => ({ toast: ui.toast }))
vi.mock('@/lib/showError', () => ({ showError: ui.showError }))
vi.mock('./ChainCanvas', () => ({
  ChainCanvas: ({ nodes, onChoose }: { nodes: ChainNode[]; onChoose: (id: string | null) => void }) => (
    <ul aria-label="drawing">
      {nodes.map((n) => <li key={n.id}><button type="button" onClick={() => onChoose(n.id)}>{`box ${n.ciType}`}</button></li>)}
      <li><button type="button" onClick={() => onChoose(null)}>empty canvas</button></li>
    </ul>
  ),
}))

const type = (name: string, label: string, chainFamilies: string[]) =>
  ({ id: name, name, label, labels: [], icon: 'box', color: 'var(--color-slate)', active: true, scope: 'base', tenantId: 'system',
    validationScript: null, chainFamilies, serviceRole: null, fields: [], relations: [], systemRelations: [] }) as unknown as CITypeDef
const TYPES = [type('application', 'Application', ['Application']), type('server', 'Server', ['Application', 'Infrastructure']), type('floor_plan', 'Floor plan', [])]
const withTypes = (children: ReactNode) => (
  <MetamodelContext.Provider value={{ ciTypes: TYPES, loading: false, error: null, getCIType: (n: string) => TYPES.find((t) => t.name === n) }}>{children}</MetamodelContext.Provider>
)

const ROOT: ChainNode = { id: 'root', parentId: null, ciType: 'application', relationType: null, direction: null, required: true }
const NEW: ChainDraft = { id: null, name: '', kind: 'application', nodes: [ROOT] }
const SAVED: ChainDraft = {
  id: 'c1', name: 'Apps', kind: 'application',
  nodes: [ROOT, { id: 's', parentId: 'root', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing', required: true }],
}
const mount = (initial: ChainDraft, canEdit = true) => {
  const onDone = vi.fn()
  const onCancel = vi.fn()
  return { onDone, onCancel, ...renderWithProviders(withTypes(<ChainEditor initial={initial} canEdit={canEdit} onDone={onDone} onCancel={onCancel} />)) }
}

beforeEach(() => {
  apolloFinto.reset()
  ui.toast.success.mockReset()
  ui.showError.mockReset()
  apolloFinto.risposte['GetCmdbChainLinkOptions'] = { cmdbChainLinkOptions: [{ relationType: 'HOSTED_ON', direction: 'outgoing', ciType: 'server' }] }
  apolloFinto.esiti['CreateCmdbChain'] = { data: { createCmdbChain: { id: 'new-1' } } }
  apolloFinto.esiti['UpdateCmdbChain'] = { data: { updateCmdbChain: { id: 'c1' } } }
  apolloFinto.esiti['DeleteCmdbChain'] = { data: { deleteCmdbChain: true } }
})

describe('ChainEditor — a new chain', () => {
  it('nothing to save until something changes; then the whole tree is created as the API takes it', async () => {
    const { user, onDone } = mount(NEW)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Apps')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'mixed')
    expect(screen.getByText('Types of any family; each link joins two types that share one.')).toBeInTheDocument()
    // The root is chosen at once (nothing below it yet); add a server below it from the panel.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add a link below' }), 'HOSTED_ON|outgoing|server')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(within(screen.getByRole('list', { name: 'drawing' })).getByRole('button', { name: 'box server' })).toBeInTheDocument()
    await user.click(save)
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('new-1'))
    const input = apolloFinto.chiamata('CreateCmdbChain')!['input'] as { name: string; kind: string; nodes: ChainNode[] }
    expect(input).toMatchObject({ name: 'Apps', kind: 'mixed' })
    expect(input.nodes).toEqual([ROOT, { id: expect.stringMatching(/^n-/), parentId: 'root', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing', required: true }])
    expect(ui.toast.success).toHaveBeenCalledWith('Chain saved')
  })

  it('the root type can change while nothing hangs below it, among the types with a chain family', async () => {
    const { user } = mount(NEW)
    const root = screen.getByRole('combobox', { name: 'Root type' })
    expect([...root.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Application', 'Server'])
    await user.selectOptions(root, 'server')
    expect(screen.getByRole('button', { name: 'box server' })).toBeInTheDocument()
  })

  it('the API\'s refusal is shown and the editor stays open', async () => {
    apolloFinto.esiti['CreateCmdbChain'] = { error: new Error('Application and NetworkSwitch share no chain family') }
    const { user, onDone } = mount(NEW)
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'X')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(ui.showError).toHaveBeenCalled())
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })
})

describe('ChainEditor — a saved chain', () => {
  it('a change updates it; the root type cannot change while something hangs below', async () => {
    const { user, onDone } = mount(SAVED)
    expect(screen.queryByRole('combobox', { name: 'Root type' })).toBeNull()
    // Remove the server from its panel.
    await user.click(screen.getByRole('button', { name: 'box server' }))
    await user.click(screen.getByRole('button', { name: 'Remove this type' }))
    expect(screen.queryByRole('button', { name: 'box server' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('c1'))
    expect(apolloFinto.chiamata('UpdateCmdbChain')).toMatchObject({ id: 'c1', input: { name: 'Apps', nodes: [ROOT] } })
  })

  it('delete asks first, then removes it and says so; a failed delete is shown', async () => {
    const { user, onDone } = mount(SAVED)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete the chain «Apps»?' })
    expect(apolloFinto.chiamata('DeleteCmdbChain')).toBeUndefined()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(null))
    expect(apolloFinto.chiamata('DeleteCmdbChain')).toEqual({ id: 'c1' })
    expect(ui.toast.success).toHaveBeenCalledWith('Chain deleted')

    apolloFinto.esiti['DeleteCmdbChain'] = { error: new Error('gone') }
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(ui.showError).toHaveBeenCalled())
  })

  it('Cancel goes back without saving', async () => {
    const { user, onCancel } = mount(SAVED)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(apolloFinto.chiamata('UpdateCmdbChain')).toBeUndefined()
  })

  it('read-only: the chain is shown, nothing can be changed, and it says who can', () => {
    mount(SAVED, false)
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Kind' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByText('Only who can change the metamodel draws chains.')).toBeInTheDocument()
  })

  it('after a removal the type above is chosen; with none chosen, it says what to do', async () => {
    const { user } = mount(SAVED)
    await user.click(screen.getByRole('button', { name: 'box server' }))
    await user.click(screen.getByRole('button', { name: 'Remove this type' }))
    expect(screen.getByRole('heading', { name: /^Application.*root$/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'empty canvas' }))
    expect(screen.getByText('Choose a type in the drawing to see its link and add links below it.')).toBeInTheDocument()
  })
})
