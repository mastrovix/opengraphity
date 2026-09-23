/**
 * THE PERSON PICKER (D21): the owner of a change is chosen among the active
 * people whose role can work on changes, not among all 3,001 users.
 *
 * And it asks the SERVER (tour of 23 Sep 2026): the first version downloaded
 * every person of the organization to keep the few that qualify. Now it sends
 * the permission and what the user types, and shows what the server answers.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { SEARCH_USERS } from '@/graphql/queries'
import { UserPicker, CHANGE_WORK_PERMISSION, USER_PICKER_PAGE } from './UserPicker'

const person = (id: string, name: string) => ({ __typename: 'UserSuggestion', id, name, email: `${id}@acme.com` })

/** The server's answer for exactly these variables. */
const answer = (search: string, people: Array<ReturnType<typeof person>>, permission = CHANGE_WORK_PERMISSION): GqlMock => ({
  request: { query: SEARCH_USERS, variables: { search, limit: USER_PICKER_PAGE, permission } },
  result: { data: { searchUsers: people } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function show(mocks: GqlMock[], onChange = vi.fn()) {
  const r = renderWithProviders(
    <UserPicker permission={CHANGE_WORK_PERMISSION} hint="People who can work on changes." label="Change owner" value={null} onChange={onChange} clearLabel="— Nobody —" />,
    { mocks },
  )
  return { ...r, onChange }
}
const box = () => screen.getByRole('combobox', { name: 'Change owner' })

describe('UserPicker', () => {
  it('offers what the server answers for the permission, with the e-mail under the name', async () => {
    const { user } = show([answer('', [person('op', 'Ada Operator')])])
    await user.click(box())
    expect(await screen.findByRole('option', { name: /Ada Operator/ })).toHaveTextContent('op@acme.com')
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Nobody —', 'Ada Operatorop@acme.com'])
    expect(screen.getByText('People who can work on changes.')).toBeInTheDocument()
  })

  it('what the user types goes to the server, and the list shows the new answer', async () => {
    const { user } = show([answer('', [person('op', 'Ada Operator')]), answer('bo', [person('bob', 'Bob Builder')])])
    await user.click(box())
    await screen.findByRole('option', { name: /Ada Operator/ })
    await user.type(box(), 'bo')
    expect(await screen.findByRole('option', { name: /Bob Builder/ }, { timeout: 2000 })).toBeInTheDocument()
  })

  it('choosing a person hands back id and name; the «nobody» choice hands back null', async () => {
    const { user, onChange } = show([answer('', [person('op', 'Ada Operator')])])
    await user.click(box())
    await user.click(await screen.findByRole('option', { name: /Ada Operator/ }))
    expect(onChange).toHaveBeenCalledWith({ id: 'op', name: 'Ada Operator' })
    await user.click(box())
    await user.click(screen.getByRole('option', { name: '— Nobody —' }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('nobody has the permission: the hint says to check the roles', async () => {
    show([answer('', [])])
    expect(await screen.findByText('No active person has a role that can do this: check the roles.')).toBeInTheDocument()
  })

  it('a full page says that typing finds the others', async () => {
    const page = Array.from({ length: USER_PICKER_PAGE }, (_, i) => person(`p${String(i)}`, `Person ${String(i).padStart(2, '0')}`))
    show([answer('', page)])
    expect(await screen.findByText('People who can work on changes. Type a name to find the others.')).toBeInTheDocument()
  })

  it('the people could not be loaded: said in the list', async () => {
    const failing: GqlMock = { request: { query: SEARCH_USERS, variables: () => true }, error: new Error('users down'), maxUsageCount: Number.POSITIVE_INFINITY }
    const { user } = show([failing])
    await user.click(box())
    await waitFor(() => expect(screen.getByText('The choices could not be loaded: users down')).toBeInTheDocument())
  })
})
