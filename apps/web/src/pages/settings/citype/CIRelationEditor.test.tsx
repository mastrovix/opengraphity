/**
 * The CI relationship editor of the CI type designer: the dialog that adds a
 * relationship and the table that lists them.
 *
 * What a regression costs the admin:
 * - the technical name and the Neo4j type are written into the graph as they
 *   are: if the editor stopped normalising them (`depends-on`, `runs on`) the
 *   API would create a relationship nobody can query by name;
 * - the dialog stays mounted: reopening it must start from an empty form, or
 *   the relationship just added looks duplicated (G-13);
 * - while saving the button must be disabled, or a double click adds two;
 * - removing a relationship removes data: it must ask first, and a shipped
 *   type (read-only) must not offer a delete the API silently ignores (A-6).
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import type { CITypeDef, CIRelationDef } from '@/contexts/MetamodelContext'
import { CIRelationEditor, CIRelationTable, emptyRelForm, type RelationForm } from './CIRelationEditor'

const TYPES = [{ name: 'server', label: 'Server' }, { name: 'database', label: 'Database' }] as unknown as CITypeDef[]

const rel = (over: Partial<CIRelationDef>): CIRelationDef => ({
  id: over.name ?? 'r', name: 'runs_on', label: 'Runs on', relationshipType: 'RUNS_ON', targetType: 'server',
  cardinality: 'many', direction: 'outgoing', order: 0, ...over,
} as CIRelationDef)

describe('CIRelationEditor — the add dialog', () => {
  it('normalises the technical name and the Neo4j type, and saves the whole form', async () => {
    const onSave = vi.fn(async (_: RelationForm) => {})
    const { user } = renderWithProviders(<CIRelationEditor open onClose={vi.fn()} onSave={onSave} allTypes={TYPES} />)
    const dialog = screen.getByRole('dialog')

    await user.type(within(dialog).getByLabelText('Technical name (slug) *'), 'Runs-On DB')
    await user.type(within(dialog).getByLabelText('Label *'), 'Runs on')
    const neo = within(dialog).getByLabelText('Neo4j relationship type *')
    await user.clear(neo)
    await user.type(neo, 'runs on-db')
    await user.selectOptions(within(dialog).getByLabelText('Target type'), 'database')
    await user.selectOptions(within(dialog).getByLabelText('Cardinality'), 'one')
    await user.selectOptions(within(dialog).getByLabelText('Direction'), 'incoming')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    // Why these exact strings: they become the graph relationship as written.
    expect(onSave).toHaveBeenCalledWith({
      name: 'runs_on_db', label: 'Runs on', relationshipType: 'RUNS_ON_DB',
      targetType: 'database', cardinality: 'one', direction: 'incoming', order: 0,
    })
  })

  it('the target list offers "any" plus every CI type', () => {
    renderWithProviders(<CIRelationEditor open onClose={vi.fn()} onSave={vi.fn()} allTypes={TYPES} />)
    const target = screen.getByLabelText('Target type')
    expect(within(target).getAllByRole('option').map((o) => o.textContent)).toEqual(['any', 'Server', 'Database'])
    expect(target).toHaveValue('any')
  })

  it('while saving the button is disabled (no double submit), then it is usable again', async () => {
    let finish: () => void = () => {}
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const { user } = renderWithProviders(<CIRelationEditor open onClose={vi.fn()} onSave={onSave} allTypes={TYPES} />)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
    finish()
    expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled()
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('Cancel closes, and reopening starts from an empty form (G-13)', async () => {
    const onClose = vi.fn()
    const props = { onClose, onSave: vi.fn(async () => {}), allTypes: TYPES }
    const { user, rerender } = renderWithProviders(<CIRelationEditor open {...props} />)
    await user.type(screen.getByLabelText('Label *'), 'Hosted by')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()

    rerender(<CIRelationEditor open={false} {...props} />)
    rerender(<CIRelationEditor open {...props} />)
    await waitFor(() => expect(screen.getByLabelText('Label *')).toHaveValue(''))
    expect(emptyRelForm()).toMatchObject({ relationshipType: 'DEPENDS_ON', targetType: 'any', cardinality: 'many', direction: 'outgoing' })
  })
})

describe('CIRelationTable', () => {
  it('no relationships: says so instead of an empty table', () => {
    renderWithProviders(<CIRelationTable relations={[]} onRemove={vi.fn()} />)
    expect(screen.getByText('No CI relationship configured.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('lists relationships in their configured order, reading target, cardinality and direction for humans', () => {
    renderWithProviders(<CIRelationTable onRemove={vi.fn()} relations={[
      rel({ name: 'second', order: 2, targetType: 'any', cardinality: 'one', direction: 'incoming' }),
      rel({ name: 'first', order: 1 }),
      rel({ name: 'third', order: 3, targetType: 'firewall', cardinality: 'few', direction: 'both' }),
    ]} />)
    const rows = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').slice(0, 6).map((c) => c.textContent))
    expect(rows.map((r) => r[0])).toEqual(['first', 'second', 'third'])
    expect(rows[0]!.slice(3)).toEqual(['Server', 'Many', 'Outgoing'])
    expect(rows[1]!.slice(3)).toEqual(['any', 'One', 'Incoming'])
    // A type the metamodel does not know, or a value outside the vocabulary, is shown as it is — not hidden.
    expect(rows[2]!.slice(3)).toEqual(['firewall', 'few', 'both'])
  })

  it('deleting asks first: cancel keeps the relationship, confirm removes it', async () => {
    const onRemove = vi.fn()
    const r = rel({ name: 'runs_on' })
    const { user } = renderWithProviders(<CIRelationTable relations={[r]} onRemove={onRemove} />)

    await user.click(screen.getByRole('button', { name: 'Delete relationship runs_on' }))
    let dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Delete relation "runs_on"?')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onRemove).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete relationship runs_on' }))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(r))
  })

  it('a shipped type is read-only: no delete button, just the note (A-6)', () => {
    renderWithProviders(<CIRelationTable relations={[rel({})]} onRemove={vi.fn()} readOnly />)
    expect(screen.queryByRole('button', { name: /Delete relationship/ })).toBeNull()
    expect(screen.getByText('read-only')).toBeInTheDocument()
  })
})
