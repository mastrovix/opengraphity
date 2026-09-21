/**
 * Revisione del 14 set 2026 · F16: le etichette delle entità ITIL erano scritte
 * nel web («Service Request», «Problem»…) in sei pagine, invece di venire dai
 * tipi ITIL del metamodello, che il cliente può rinominare nel designer.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { GET_ITIL_TYPES } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { useItilTypeLabels } from './useItilTypeLabels'

const itilTypes = (types: Array<{ name: string; label: string }>): GqlMock => ({
  request: { query: GET_ITIL_TYPES },
  result: { data: { itilTypes: types.map((t) => ({
    __typename: 'ITILType', id: `t-${t.name}`, name: t.name, label: t.label, icon: 'x', color: 'x', active: true, validationScript: null, fields: [],
  })) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function Probe({ types }: { types: string[] }) {
  const { labelOf, ready } = useItilTypeLabels()
  return <ul data-ready={ready}>{types.map((t) => <li key={t}>{labelOf(t)}</li>)}</ul>
}

describe('useItilTypeLabels', () => {
  it("usa l'etichetta del tipo ITIL del cliente", async () => {
    renderWithProviders(<Probe types={['service_request', 'problem']} />, {
      mocks: [itilTypes([{ name: 'service_request', label: 'Richiesta di servizio' }, { name: 'problem', label: 'Problema' }])],
    })
    expect(await screen.findByText('Richiesta di servizio')).toBeInTheDocument()
    expect(screen.getByText('Problema')).toBeInTheDocument()
  })

  it('un tipo che il metamodello non ha → il nome interno, riconoscibile come tale', async () => {
    renderWithProviders(<Probe types={['incident', 'ghost']} />, {
      mocks: [itilTypes([{ name: 'incident', label: 'Incident' }])],
    })
    expect(await screen.findByText('Incident')).toBeInTheDocument()
    expect(screen.getByText('ghost')).toBeInTheDocument()
  })
})
