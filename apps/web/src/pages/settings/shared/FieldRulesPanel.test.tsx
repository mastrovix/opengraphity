/**
 * FIELD RULES: when a field shows, and in which steps it is required.
 *
 * Two small rule sets an administrator edits here. The steps offered are the
 * TRANSLATED labels of every active workflow (G-10): the old list came only
 * from workflows without a category, so a step that exists only in a category
 * workflow could not be picked — "root_cause required entering containment"
 * could not be written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { FieldRulesPanel } = await import('./FieldRulesPanel')

const FIELDS = [
  { name: 'category', label: 'Category', fieldType: 'enum', enumValues: ['hardware', 'software'], enumTypeName: null },
  { name: 'serial', label: 'Serial', fieldType: 'string', enumValues: [] },
  { name: 'notes', label: '', fieldType: 'string', enumValues: [] },
]
const STEPS = [{ name: 'in_progress', label: 'In lavorazione' }, { name: 'resolved', label: 'Risolto' }]

const regola = { id: 'r1', triggerField: 'category', triggerValue: 'hardware', targetField: 'serial', action: 'show' }

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [] }
  apolloFinto.risposte['GetFieldRequirementRules'] = { fieldRequirementRules: [] }
})

const mostra = (flat = false) => renderWithProviders(
  <FieldRulesPanel entityType="incident" fields={FIELDS} workflowSteps={STEPS} flat={flat} />)

const nomeVisibilita = () => Object.keys(apolloFinto.chiamate).find((n) => /Visibility/.test(n) && /Get/.test(n))!

describe('visibility rules', () => {
  it('an empty list says so', async () => {
    mostra()
    expect(await screen.findByText(/no .*rule|nessuna/i)).toBeInTheDocument()
    expect(apolloFinto.chiamata(nomeVisibilita())).toEqual({ entityType: 'incident' })
  })

  it('adding: an enum trigger offers its values, and the rule is created with them', async () => {
    const { user } = mostra()
    await user.click(screen.getAllByRole('button').find((b) => /add|aggiungi/i.test(b.textContent ?? ''))!)
    const valore = screen.getAllByRole('combobox')[1]!
    await user.selectOptions(valore, 'hardware')
    await user.click(screen.getByRole('button', { name: /save/i }))
    const creata = Object.entries(apolloFinto.chiamate).find(([n]) => /CreateFieldVisibility/.test(n))![1].at(-1)
    expect(creata).toMatchObject({ entityType: 'incident', triggerField: 'category', triggerValue: 'hardware', action: 'show' })
    expect(toast.success).toHaveBeenCalled()
  })

  it('a free-text trigger has an input, and an empty value is not saved', async () => {
    const { user } = mostra()
    await user.click(screen.getAllByRole('button').find((b) => /add|aggiungi/i.test(b.textContent ?? ''))!)
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'serial')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(Object.keys(apolloFinto.chiamate).some((n) => /CreateFieldVisibility/.test(n))).toBe(false)
    await user.type(screen.getByRole('textbox'), 'SN')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(Object.keys(apolloFinto.chiamate).some((n) => /CreateFieldVisibility/.test(n))).toBe(true)
  })

  it('the target list never offers the trigger itself', async () => {
    const { user } = mostra()
    await user.click(screen.getAllByRole('button').find((b) => /add|aggiungi/i.test(b.textContent ?? ''))!)
    const bersaglio = screen.getAllByRole('combobox').at(-1)!
    expect(within(bersaglio).queryByRole('option', { name: 'Category' })).toBeNull()
  })

  it('cancelling closes the form', async () => {
    const { user } = mostra()
    await user.click(screen.getAllByRole('button').find((b) => /add|aggiungi/i.test(b.textContent ?? ''))!)
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
  })

  it('an existing rule can be edited and deleted, and its icon buttons have a name', async () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [regola] }
    const { user } = mostra()
    await screen.findAllByText(/serial/i)
    const conNome = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-label')?.includes('serial'))
    expect(conNome).toHaveLength(2)   // edit and delete, each with a name (G-15)
    await user.click(conNome[0]!)
    await user.selectOptions(screen.getAllByRole('combobox')[2]!, 'hide')
    await user.click(screen.getByRole('button', { name: /save/i }))
    const aggiornata = Object.entries(apolloFinto.chiamate).find(([n]) => /UpdateFieldVisibility/.test(n))![1].at(-1)
    expect(aggiornata).toMatchObject({ id: 'r1', action: 'hide' })

    const elimina = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-label')?.includes('serial')).at(-1)!
    await user.click(elimina)
    expect(Object.entries(apolloFinto.chiamate).find(([n]) => /DeleteFieldVisibility/.test(n))![1].at(-1)).toEqual({ id: 'r1' })
  })

  it('a failed mutation shows the error', async () => {
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [regola] }
    for (const n of ['DeleteFieldVisibilityRule']) apolloFinto.esiti[n] = { error: new Error('nope') }
    const { user } = mostra()
    await screen.findAllByRole('button')
    const elimina = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-label')?.includes('serial')).at(-1)!
    await user.click(elimina)
    await waitFor(() => { expect(toast.success).not.toHaveBeenCalled() })
    errore.mockRestore()
  })
})

describe('requirement rules', () => {
  it('one column for "all steps" and one per step, with the TRANSLATED step label', () => {
    mostra()
    expect(screen.getByRole('columnheader', { name: 'In lavorazione' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Risolto' })).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(4)
  })

  it('ticking a box requires the field in that step; "all steps" sends null', async () => {
    const { user } = mostra()
    const boxes = screen.getAllByRole('checkbox')
    await user.click(boxes[0]!)   // category, all steps
    await user.click(boxes[2]!)   // category, resolved
    const chiamate = Object.entries(apolloFinto.chiamate).find(([n]) => /SetFieldRequirement/.test(n))![1]
    expect(chiamate[0]).toEqual({ entityType: 'incident', fieldName: 'category', required: true, workflowStep: null })
    expect(chiamate[1]).toMatchObject({ workflowStep: 'resolved' })
  })

  it('unticking deletes that rule', async () => {
    apolloFinto.risposte['GetFieldRequirementRules'] = { fieldRequirementRules: [{ id: 'q1', fieldName: 'serial', required: true, workflowStep: 'resolved' }] }
    const { user } = mostra()
    const box = screen.getByRole('checkbox', { name: 'Serial — Risolto' }) as HTMLInputElement
    expect(box.checked).toBe(true)
    await user.click(box)
    expect(Object.entries(apolloFinto.chiamate).find(([n]) => /DeleteFieldRequirement/.test(n))![1].at(-1)).toEqual({ id: 'q1' })
  })

  it('a field without a label shows its name', () => {
    mostra()
    expect(screen.getAllByText('notes').length).toBeGreaterThan(0)
  })

  it('flat mode renders the same content without the card', () => {
    const { container } = mostra(true)
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0)
    expect(container.firstElementChild?.getAttribute('style') ?? '').not.toContain('border-radius: 10px')
  })
})
