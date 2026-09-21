/**
 * Designer ITIL · giro UI del 15 set 2026:
 *  - U-13: lo Status delle richieste elencava il vocabolario agganciato al
 *    campo (open, in_progress…), che non sono i passi del workflow;
 *  - U-14: la testata diceva «not editable» ma ogni riga ha «Edit».
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { GET_WORKFLOW_DEFINITION } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { ITILTypeFields } from './ITILTypeFields'
import type { ITILField } from './useITILTypeDesigner'

const field = (over: Partial<ITILField>): ITILField => ({
  id: 'f-status', name: 'status', label: 'Status', fieldType: 'enum', required: true, enumValues: ['open', 'in_progress', 'completed', 'cancelled'],
  order: 1, isSystem: true, enumTypeId: 'e-1', enumTypeName: 'status_service_request', validationScript: null, visibilityScript: null, defaultScript: null,
  visibleToEndUser: false, ...over,
} as ITILField)

const step = (name: string, label: string, order: number) => ({
  __typename: 'WorkflowStep', id: `s-${name}`, name, label, labels: [], type: 'standard', enterActions: null, exitActions: null,
  isInitial: order === 1, isTerminal: name === 'fulfilled', isOpen: name !== 'fulfilled', category: 'active', purpose: null, order,
})
const workflow: GqlMock = {
  request: { query: GET_WORKFLOW_DEFINITION, variables: { entityType: 'service_request' } },
  result: { data: { workflowDefinition: {
    __typename: 'WorkflowDefinition', id: 'wd-1', name: 'SR', entityType: 'service_request', category: null, version: 1, active: true,
    steps: [step('submitted', 'Submitted', 1), step('fulfilled', 'Fulfilled', 2)], transitions: [],
  } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

describe('ITILTypeFields', () => {
  it('U-13: lo Status dice che i valori sono i passi del workflow; U-14: la testata dice cosa si modifica', async () => {
    renderWithProviders(
      <ITILTypeFields
        typeId="t-sr" typeName="service_request"
        fields={[field({}), field({ id: 'f-title', name: 'title', label: 'Title', fieldType: 'string', enumValues: [], enumTypeId: null, enumTypeName: null })]}
        editingFieldId={null} setEditingFieldId={vi.fn()} addingField={false} setAddingField={vi.fn()}
        onSaveField={vi.fn()} onDeleteField={vi.fn()} enumTypesData={undefined}
      />,
      { mocks: [workflow] },
    )
    expect(await screen.findByTestId('field-values-note')).toHaveTextContent('values = the steps of the workflow: Submitted, Fulfilled')
    expect(screen.queryByText(/open, in_progress/)).toBeNull()
    expect(screen.getByText(/SYSTEM FIELDS \(2\) — name, type and required are fixed/)).toBeInTheDocument()
    expect(screen.queryByText(/not editable/)).toBeNull()
  })
})
