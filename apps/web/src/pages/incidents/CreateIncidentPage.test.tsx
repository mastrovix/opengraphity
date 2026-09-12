/**
 * Il form più usato del prodotto, che finora **non aveva un test** (revisione
 * delle otto ondate · C·N-3).
 *
 * Impatto, urgenza e priorità venivano da una copia della matrice scritta in
 * `lib/priority.ts`: tre bottoni `high/medium/low` con etichette italiane fisse
 * e una matrice 3×3 del 2025. Ma la matrice è dato del cliente dall'ondata 7, e
 * i vocabolari si possono rinominare — quindi chi lo faceva vedeva qui i valori
 * vecchi e ogni invio veniva rifiutato dal server, senza modo di aggiustare la
 * pagina dall'interfaccia. Nella stessa pagina la *categoria* veniva già dal
 * metamodello: la strada giusta esisteva e non era stata usata per questi due.
 *
 * Qui si verifica che i valori e la priorità calcolata vengano dalla matrice
 * che il server manda — compreso il caso che conta, il cliente che ha
 * rinominato tutto.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { CreateIncidentPage } from './CreateIncidentPage'
import { GET_TEAMS, GET_ITIL_CI_RELATION_RULES, GET_ALL_CIS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { domainMatricesMock, itilTypesMock } from '@/test/mocks/gql'

const teamsMock = (): GqlMock => ({
  request: { query: GET_TEAMS },
  result: { data: { teams: [] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})
const ciRulesMock = (): GqlMock => ({
  request: { query: GET_ITIL_CI_RELATION_RULES, variables: { itilType: 'incident' } },
  result: { data: { itilCIRelationRules: [] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})
const allCisMock = (): GqlMock => ({
  request: { query: GET_ALL_CIS },
  result: { data: { allCIs: [] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function render(matrix: GqlMock) {
  return renderWithProviders(
    <CreateIncidentPage />,
    { mocks: [matrix, teamsMock(), ciRulesMock(), allCisMock(), itilTypesMock()] },
  )
}

/** I bottoni di una delle due scale (impatto / urgenza), in ordine. */
function scaleButtons(label: string): string[] {
  const heading = screen.getByText((text) => text.startsWith(label))
  const group = heading.parentElement!
  return [...group.querySelectorAll('button')].map((b) => b.textContent ?? '')
}

describe('CreateIncidentPage — impatto, urgenza e priorità dalla matrice del cliente', () => {
  it('i bottoni sono i valori del vocabolario, nell\'ordine della matrice', async () => {
    render(domainMatricesMock())
    await waitFor(() => { expect(scaleButtons('Impatto')).toEqual(['low', 'medium', 'high']) })
    expect(scaleButtons('Urgenza')).toEqual(['low', 'medium', 'high'])
  })

  it('il cliente che ha RINOMINATO vede i suoi valori, non quelli di fabbrica', async () => {
    render(domainMatricesMock({
      impacts:    ['basso', 'medio', 'alto'],
      urgencies:  ['rilassata', 'normale', 'urgente'],
      priorities: ['p4', 'p3', 'p2', 'p1'],
      cells: { 'medio|normale': 'p3', 'alto|urgente': 'p1', 'basso|rilassata': 'p4' },
    }))
    await waitFor(() => { expect(scaleButtons('Impatto')).toEqual(['basso', 'medio', 'alto']) })
    expect(scaleButtons('Urgenza')).toEqual(['rilassata', 'normale', 'urgente'])
    // E la priorità calcolata è quella della SUA matrice: il valore mediano
    // della scala è quello preselezionato.
    expect(await screen.findByText('p3')).toBeInTheDocument()
    expect(screen.getByText('P3')).toBeInTheDocument()
  })

  it('una coppia che la matrice non copre lo DICE, invece di mostrare una priorità che il server rifiuta', async () => {
    render(domainMatricesMock({ cells: { 'low|low': 'low' } }))
    await waitFor(() => { expect(scaleButtons('Impatto')).toHaveLength(3) })
    expect(screen.getByText('da compilare nella matrice')).toBeInTheDocument()
  })
})
