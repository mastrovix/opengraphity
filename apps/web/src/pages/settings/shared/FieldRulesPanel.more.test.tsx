/**
 * FIELD RULES, the paths FieldRulesPanel.test.tsx does not walk: choosing the
 * target field, cancelling an edit, and a create or update the server
 * refuses. What breaks for an administrator if these regress: a rule saved on
 * the wrong target field, an edit that cannot be abandoned, or a refused
 * save that closes the form and reports success as if it had worked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { FieldRulesPanel } = await import('./FieldRulesPanel')

const FIELDS = [
  { name: 'category', label: 'Category', fieldType: 'enum', enumValues: ['hardware', 'software'], enumTypeName: null },
  { name: 'serial', label: 'Serial', fieldType: 'string', enumValues: [] },
  { name: 'notes', label: 'Notes', fieldType: 'string', enumValues: [] },
]
const RULE = { id: 'r1', triggerField: 'category', triggerValue: 'hardware', targetField: 'serial', action: 'show' }

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [] }
  apolloFinto.risposte['GetFieldRequirementRules'] = { fieldRequirementRules: [] }
})

const show = () => renderWithProviders(<FieldRulesPanel entityType="incident" fields={FIELDS} workflowSteps={[]} />)
const addButton = () => screen.getByRole('button', { name: /add/i })
const targetSelect = () => screen.getByLabelText(/target field/i)
const editButton = () => screen.getAllByRole('button').find((b) => b.getAttribute('aria-label')?.includes('serial') && /edit/i.test(b.getAttribute('aria-label')!))!

describe('visibility rules — target field', () => {
  it('the chosen target field is the one saved', async () => {
    const { user } = show()
    await user.click(addButton())
    await user.selectOptions(screen.getByLabelText(/trigger value/i), 'software')
    await user.selectOptions(targetSelect(), 'notes')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(apolloFinto.chiamata('CreateFieldVisibilityRule')).toMatchObject({ triggerValue: 'software', targetField: 'notes' })
  })
})

describe('visibility rules — refused saves', () => {
  it('a refused create shows the error and keeps the form open', async () => {
    apolloFinto.esiti['CreateFieldVisibilityRule'] = { error: new Error('duplicate rule') }
    const { user } = show()
    await user.click(addButton())
    await user.selectOptions(screen.getByLabelText(/trigger value/i), 'hardware')
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('duplicate rule'))
    expect(toast.success).not.toHaveBeenCalled()
    // The admin's input is still there to fix and retry.
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
  })

  it('a refused update shows the error and stays in edit mode', async () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [RULE] }
    apolloFinto.esiti['UpdateFieldVisibilityRule'] = { error: new Error('rule changed meanwhile') }
    const { user } = show()
    await user.click(editButton())
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rule changed meanwhile'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
  })
})

describe('visibility rules — cancelling an edit', () => {
  it('returns to the rule as it was, without saving', async () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [RULE] }
    const { user } = show()
    await user.click(editButton())
    // The edit form starts from the saved rule.
    expect(targetSelect()).toHaveValue('serial')
    await user.selectOptions(targetSelect(), 'notes')
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
    expect(apolloFinto.chiamate['UpdateFieldVisibilityRule']).toBeUndefined()
    expect(editButton()).toBeInTheDocument()
  })
})
