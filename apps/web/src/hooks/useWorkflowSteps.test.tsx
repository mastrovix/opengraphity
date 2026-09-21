/**
 * Secondo giro UI del 15 set 2026: la colonna «Fase» dell'elenco change diceva
 * «Scheduled» in italiano, mentre il dettaglio (V-7) diceva «Pianificata». Le
 * etichette dei passi escono dal hook già nella lingua di chi guarda.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import i18n from '@/i18n/i18n'
import { GET_WORKFLOW_DEFINITION } from '@/graphql/queries/workflow'
import { Providers, type GqlMock } from '@/test/utils'
import { useWorkflowSteps } from './useWorkflowSteps'

const step = (name: string, label: string, labels: { language: string; label: string }[], order: number) => ({
  __typename: 'WorkflowStep', id: name, name, label, labels: labels.map((l) => ({ __typename: 'LocalizedLabel', ...l })),
  type: 'standard', enterActions: null, exitActions: null, isInitial: order === 1, isTerminal: false, isOpen: true, category: null, purpose: null, order,
})

describe('useWorkflowSteps — etichette nella lingua di chi guarda', () => {
  afterEach(async () => { await i18n.changeLanguage('en') })

  it('byName e steps portano l\'etichetta tradotta; un\'etichetta del cliente senza traduzioni resta la sua', async () => {
    await i18n.changeLanguage('it')
    const mock: GqlMock = {
      request: { query: GET_WORKFLOW_DEFINITION, variables: { entityType: 'change' } },
      result: { data: { workflowDefinition: { __typename: 'WorkflowDefinition', id: 'wd', name: 'Change', entityType: 'change', category: null, version: 1, active: true, transitions: [], steps: [
        step('scheduled', 'Scheduled', [{ language: 'it', label: 'Pianificata' }], 1),
        step('cab_review', 'Revisione CAB', [], 2),
      ] } } },
    }
    const wrapper = ({ children }: { children: ReactNode }) => <Providers mocks={[mock]}>{children}</Providers>
    const { result } = renderHook(() => useWorkflowSteps('change'), { wrapper })
    await waitFor(() => expect(result.current.steps).toHaveLength(2))
    expect(result.current.byName.get('scheduled')?.label).toBe('Pianificata')
    expect(result.current.steps[1]!.label).toBe('Revisione CAB')
    expect(result.current.labelFor('scheduled')).toBe('Pianificata')
  })
})
