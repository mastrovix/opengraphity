/**
 * THE TEAM PICKER (D10 / D34): the teams that do the job, searchable, and a
 * filter that says what it filters.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { teamChoicesMock } from '@/test/mocks/gql'
import { GET_TEAM_CHOICES } from '@/graphql/queries'
import { TEAM_TYPE, teamsFor, type TeamChoice } from '@/lib/teamVocabularies'
import { TeamPicker } from './TeamPicker'

const TEAMS = [
  { id: 'own-1', name: 'OWN_Controlling Platform Owner', type: 'owner' },
  { id: 'sup-1', name: 'SUP_Network EMEA', type: 'support' },
  { id: 'sup-2', name: 'SUP_Database Platform', type: 'support' },
  { id: 'cmo', name: 'Change Management Office', type: 'support', isChangeManager: true },
  { id: 'old', name: 'Legacy Team', type: null },
]

function show(role: 'owner' | 'support', mocks: GqlMock[] = [teamChoicesMock(TEAMS)], onChange = vi.fn()) {
  const r = renderWithProviders(<TeamPicker role={role} label="Team" value={null} onChange={onChange} />, { mocks })
  return { ...r, onChange }
}
const box = () => screen.getByRole('combobox', { name: 'Team' })
const names = () => within(screen.getByRole('listbox')).queryAllByRole('option').map((o) => o.textContent)

describe('teamsFor', () => {
  const all: TeamChoice[] = TEAMS.map((t) => ({ isChangeManager: false, ...t }))

  it('support: the support teams, never the Change Manager team', () => {
    expect(teamsFor(TEAM_TYPE.SUPPORT, all).map((t) => t.id)).toEqual(['sup-1', 'sup-2'])
  })

  it('owner: the owner teams; an untyped team is in neither list', () => {
    expect(teamsFor(TEAM_TYPE.OWNER, all).map((t) => t.id)).toEqual(['own-1'])
    expect(teamsFor(TEAM_TYPE.OWNER, [{ id: 'cm', name: 'CM', type: 'owner', isChangeManager: true }])).toEqual([])
  })
})

describe('TeamPicker', () => {
  it('support: offers the support teams only, and says so — the owner teams and the CAB are not there', async () => {
    const { user } = show('support')
    await user.click(box())
    expect(await screen.findByRole('option', { name: 'SUP_Network EMEA' })).toBeInTheDocument()
    expect(names()).toEqual(['SUP_Network EMEA', 'SUP_Database Platform'])
    expect(screen.getByText(/Teams of type «support» only\./)).toBeInTheDocument()
    expect(screen.getByText(/The Change Manager team approves changes and is not offered\./)).toBeInTheDocument()
  })

  it('«Show all teams» widens the list, with the type of each team, and can narrow it again', async () => {
    const { user } = show('support')
    await user.click(box())
    await screen.findByRole('option', { name: 'SUP_Network EMEA' })
    await user.click(screen.getByRole('button', { name: 'Show all teams (5)' }))
    expect(names()).toHaveLength(5)
    expect(screen.getByRole('option', { name: /OWN_Controlling Platform Owner/ })).toHaveTextContent('owner')
    expect(screen.getByRole('option', { name: /Legacy Team/ })).toHaveTextContent('no type')
    expect(screen.getByText(/All teams are shown\./)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Only teams of type «support»' }))
    expect(names()).toHaveLength(2)
  })

  it('choosing a team hands back its id and name', async () => {
    const { user, onChange } = show('owner')
    await user.click(box())
    await user.click(await screen.findByRole('option', { name: 'OWN_Controlling Platform Owner' }))
    expect(onChange).toHaveBeenCalledWith({ id: 'own-1', name: 'OWN_Controlling Platform Owner' })
  })

  it('no team of that type: it says so, instead of an unexplained empty list', async () => {
    const { user } = show('owner', [teamChoicesMock([{ id: 'x', name: 'Untyped', type: null }])])
    await user.click(box())
    expect(await screen.findByText(/No team is of type «owner»\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show all teams (1)' })).toBeInTheDocument()
  })

  it('the teams could not be loaded: said in the list', async () => {
    const failing: GqlMock = { request: { query: GET_TEAM_CHOICES }, error: new Error('teams down'), maxUsageCount: Number.POSITIVE_INFINITY }
    const { user } = show('support', [failing])
    await user.click(box())
    expect(await screen.findByText('The choices could not be loaded: teams down')).toBeInTheDocument()
  })
})
