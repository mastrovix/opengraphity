/** Giro nel browser del 14 set 2026 (#3, #11): widget e report mostravano «medium», «closed» invece delle etichette. */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Providers, type GqlMock } from '@/test/utils'
import { GET_ITIL_TYPES } from '@/graphql/queries'
import { useFieldValueLabel } from './useFieldValueLabel'

vi.mock('@/contexts/DomainVocabularyContext', () => ({
  useDomainVocabularies: () => ({ labelOf: (vocabulary: string, value: string) => (vocabulary === 'priority' && value === 'medium' ? 'Media' : null) }),
}))
vi.mock('@/hooks/useWorkflowSteps', () => ({ useWorkflowSteps: () => ({ labelFor: (s: string) => (s === 'closed' ? 'Chiuso' : s) }) }))

const itil: GqlMock = {
  request: { query: GET_ITIL_TYPES },
  result: { data: { itilTypes: [{
    __typename: 'ITILType', id: 't', name: 'incident', label: 'Incident', icon: '', color: '', active: true, validationScript: null,
    fields: [{ __typename: 'ITILField', id: 'f', name: 'priority', label: 'Priority', fieldType: 'enum', required: false, enumValues: ['medium'], order: 1, isSystem: false, enumTypeId: 'e', enumTypeName: 'priority', validationScript: null, visibilityScript: null, defaultScript: null }],
  }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}
const wrapper = ({ children }: { children: ReactNode }) => <Providers mocks={[itil]}>{children}</Providers>

describe('useFieldValueLabel', () => {
  it('campo con vocabolario → etichetta del Dizionario; valore sconosciuto → il valore', async () => {
    const { result } = renderHook(() => useFieldValueLabel('incident', 'priority'), { wrapper })
    await waitFor(() => expect(result.current('medium')).toBe('Media'))
    expect(result.current('boh')).toBe('boh')
  })

  it('lo stato di un ticket → etichetta del passo', () => {
    const { result } = renderHook(() => useFieldValueLabel('incident', 'status'), { wrapper })
    expect(result.current('closed')).toBe('Chiuso')
  })
})
