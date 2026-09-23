/**
 * THE RULES TAB OF THE ITIL TYPE DESIGNER: which steps a rule can name.
 *
 * The steps offered are those of EVERY active workflow of the ticket type,
 * each once, with its label in the administrator's language (G-10). The list
 * used to come only from the workflows without a category, with the technical
 * name: a step that exists only in a category workflow could not be chosen,
 * so «root_cause required when entering containment» could not be written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { ITILTypeRules } = await import('./ITILTypeRules')

const FIELDS = [
  { name: 'root_cause', label: 'Root cause', fieldType: 'string', enumValues: [] },
  { name: 'area', label: 'Area', fieldType: 'enum', enumValues: ['network'], enumTypeName: null },
]

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [] }
  apolloFinto.risposte['GetFieldRequirementRules'] = { fieldRequirementRules: [] }
  apolloFinto.risposte['GetTicketWorkflowSteps'] = { ticketWorkflowSteps: [
    { workflow: 'Generic', category: null, steps: [
      { name: 'new', label: 'New', labels: [] },
      { name: 'in_progress', label: 'In progress', labels: [{ language: 'en', label: 'Being worked on' }, { language: 'it', label: 'In lavorazione' }] },
    ] },
    { workflow: 'Security', category: 'security', steps: [
      { name: 'new', label: 'New', labels: [] },
      // A step with no label of its own is named by its technical name, never left blank.
      { name: 'containment', label: '', labels: [] },
    ] },
  ] }
})

const stepColumns = () => screen.getAllByRole('columnheader').map((h) => h.textContent).slice(1)

describe('ITILTypeRules', () => {
  it('offers every step of every workflow of the type once, with its label in the user\'s language', () => {
    renderWithProviders(<ITILTypeRules entityType="incident" fields={FIELDS} />)
    expect(apolloFinto.chiamata('GetTicketWorkflowSteps')).toEqual({ entityType: 'incident' })
    expect(stepColumns()).toEqual(['All steps', 'New', 'Being worked on', 'containment'])
    // The step only the category workflow has can be required.
    expect(screen.getByRole('checkbox', { name: 'Root cause — containment' })).toBeInTheDocument()
  })

  it('the rules are written on the fields of the type', () => {
    renderWithProviders(<ITILTypeRules entityType="incident" fields={FIELDS} />)
    expect(screen.getAllByRole('checkbox', { name: /^Area — / })).toHaveLength(4)
    expect(apolloFinto.chiamata('GetFieldRequirementRules')).toEqual({ entityType: 'incident' })
  })

  it('before the steps arrive, only «all steps» is offered', () => {
    apolloFinto.risposte['GetTicketWorkflowSteps'] = undefined
    renderWithProviders(<ITILTypeRules entityType="incident" fields={FIELDS} />)
    expect(stepColumns()).toEqual(['All steps'])
  })

  it('with no ticket type, no step is asked for', () => {
    renderWithProviders(<ITILTypeRules entityType="" fields={FIELDS} />)
    expect(apolloFinto.chiamate['GetTicketWorkflowSteps']).toBeUndefined()
    expect(stepColumns()).toEqual(['All steps'])
  })
})
