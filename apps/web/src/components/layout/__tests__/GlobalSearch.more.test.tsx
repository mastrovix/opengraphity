/**
 * GLOBAL SEARCH: the box in the top bar that jumps anywhere.
 *
 * It is the fastest way into a ticket, a CI or an article, and it is used from
 * the keyboard. What a user loses if these regress:
 *  - a result that opens the wrong page (every kind has its own route; a CI
 *    whose type is unknown must still open somewhere, not crash);
 *  - Ctrl/Cmd+K no longer focusing the box, arrows that run past the list,
 *    Enter that opens nothing, Escape that leaves the list open;
 *  - a failed search that looks like "no results" (the user concludes the
 *    ticket does not exist);
 *  - a slow answer to an OLD query overwriting the results of the new one.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { GlobalSearch } from '../GlobalSearch'

const query = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apollo', () => ({ apolloClient: { query } }))

const ALL = {
  cis: [
    { id: 'ci-1', name: 'db-01', type: 'database_instance' },
    { id: 'ci-2', name: 'mystery', type: null },
  ],
  changes: [{ id: 'chg-1', code: 'CHG0001', title: 'Patch the DB' }],
  incidents: [{ id: 'inc-1', number: 'INC0001', title: 'DB down' }],
  problems: [{ id: 'prb-1', number: 'PRB0001', title: 'DB keeps failing' }],
  serviceRequests: [],
  tasks: [{ id: 't-1', code: 'TSK0001', taskType: 'deploy', status: 'open', changeCode: 'CHG0001', changeId: 'chg-1', ciName: 'db-01' }],
  kbArticles: [{ id: 'kb-1', title: 'How to restart the DB', slug: 'restart-db' }],
}

beforeEach(() => { query.mockReset() })

const box = () => screen.getByRole('combobox')

describe('GlobalSearch — results', () => {
  it('shows every group in order and opens each kind on its own page', async () => {
    query.mockResolvedValue({ data: { globalSearch: ALL } })
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(box(), 'db')
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'db-01database instance',
      'mystery',
      'CHG0001Patch the DB',
      'INC0001DB down',
      'PRB0001DB keeps failing',
      // A task shows the change it belongs to as a badge.
      'TSK0001deployCHG0001',
      'How to restart the DB',
    ])
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ variables: { query: 'db', limit: 5 } }))
    // A CI without a type still opens (on the "unknown" route) rather than crashing.
    await user.click(screen.getByRole('option', { name: /mystery/ }))
    await attendiURL('/ci/unknown/ci-2')
  })

  it.each([
    [/CHG0001Patch/, '/changes/chg-1'],
    [/INC0001/, '/incidents/inc-1'],
    [/PRB0001/, '/problems/prb-1'],
    [/TSK0001/, '/tasks/t-1'],
    [/How to restart/, '/knowledge-base/restart-db'],
  ])('%s opens %s', async (name, route) => {
    query.mockResolvedValue({ data: { globalSearch: ALL } })
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(box(), 'db')
    await user.click(await screen.findByRole('option', { name }))
    await attendiURL(route)
    // The box is emptied and the list closed after choosing.
    expect(box()).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('says "no results" for an empty answer, and for an answer without data', async () => {
    query.mockResolvedValue({ data: null })
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(box(), 'zz')
    expect(await screen.findByText("No results for 'zz'")).toBeInTheDocument()
  })

  it('a failed search says it failed, not "no results"', async () => {
    query.mockRejectedValue(new Error('search is down'))
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(box(), 'db')
    expect(await screen.findByRole('alert')).toHaveTextContent('Search error: search is down')
    expect(screen.queryByText(/No results/)).not.toBeInTheDocument()
  })

  it('a failure that is not an Error is still shown', async () => {
    query.mockRejectedValue('gateway timeout')
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(box(), 'db')
    expect(await screen.findByRole('alert')).toHaveTextContent('Search error: gateway timeout')
  })

  it('shorter than two characters: no search and no list', async () => {
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(box(), 'd')
    await new Promise((r) => setTimeout(r, 350))
    expect(query).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('a late answer to an old query does not overwrite the new one', async () => {
    let resolveOld!: (v: unknown) => void
    let rejectOld!: (e: unknown) => void
    query
      .mockImplementationOnce(() => new Promise((res) => { resolveOld = res }))
      .mockImplementationOnce(() => new Promise((_res, rej) => { rejectOld = rej }))
      .mockResolvedValue({ data: { globalSearch: { ...ALL, cis: [], changes: [], problems: [], tasks: [], kbArticles: [] } } })
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(box(), 'db')
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    await user.type(box(), 'x')
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    await user.type(box(), 'y')
    await waitFor(() => expect(query).toHaveBeenCalledTimes(3))
    expect(await screen.findByRole('option', { name: /INC0001/ })).toBeInTheDocument()

    // The two older queries answer now (one ok, one failed): nothing changes.
    await act(async () => { resolveOld({ data: { globalSearch: ALL } }); rejectOld(new Error('stale')) })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('GlobalSearch — keyboard', () => {
  it('Ctrl+K and Cmd+K focus the box from anywhere', async () => {
    const { user } = renderWithProviders(<><GlobalSearch /><button type="button">elsewhere</button></>)
    screen.getByRole('button', { name: 'elsewhere' }).focus()
    await user.keyboard('{Control>}k{/Control}')
    expect(box()).toHaveFocus()
    screen.getByRole('button', { name: 'elsewhere' }).focus()
    await user.keyboard('{Meta>}K{/Meta}')
    expect(box()).toHaveFocus()
    // A plain "k" is just a letter.
    screen.getByRole('button', { name: 'elsewhere' }).focus()
    await user.keyboard('k')
    expect(box()).not.toHaveFocus()
  })

  it('arrows move within the list and stop at its ends; Enter opens the selected result', async () => {
    query.mockResolvedValue({ data: { globalSearch: ALL } })
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(box(), 'db')
    const options = await screen.findAllByRole('option')
    expect(box()).toHaveAttribute('aria-activedescendant', options[0]!.id)

    await user.keyboard('{ArrowUp}')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(options[2]).toHaveAttribute('aria-selected', 'true')
    for (let i = 0; i < 10; i++) await user.keyboard('{ArrowDown}')
    expect(options.at(-1)).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}')
    expect(options.at(-2)).toHaveAttribute('aria-selected', 'true')

    // The mouse moves the selection too.
    fireEvent.mouseEnter(options[3]!)
    expect(options[3]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    await attendiURL('/incidents/inc-1')
  })

  it('arrows and Enter with no results do nothing', async () => {
    query.mockResolvedValue({ data: { globalSearch: { ...ALL, cis: [], changes: [], incidents: [], problems: [], tasks: [], kbArticles: [] } } })
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(box(), 'zz')
    await screen.findByText("No results for 'zz'")
    await user.keyboard('{ArrowDown}{Enter}')
    await attendiURL('/')
    expect(box()).not.toHaveAttribute('aria-activedescendant')
  })

  it('Escape closes the list and leaves the box', async () => {
    query.mockResolvedValue({ data: { globalSearch: ALL } })
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(box(), 'db')
    await screen.findByRole('listbox')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(box()).not.toHaveFocus()
    // Focusing again reopens it with the same text.
    await user.click(box())
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('an option can be opened with Enter on the option itself', async () => {
    query.mockResolvedValue({ data: { globalSearch: ALL } })
    renderWithProviders(<GlobalSearch />)
    fireEvent.change(box(), { target: { value: 'db' } })
    const option = await screen.findByRole('option', { name: /PRB0001/ })
    fireEvent.keyDown(option, { key: 'Enter' })
    await attendiURL('/problems/prb-1')
  })

  it('a click outside closes the list', async () => {
    query.mockResolvedValue({ data: { globalSearch: ALL } })
    const { user } = renderWithProviders(<><GlobalSearch /><p>outside</p></>)
    await user.type(box(), 'db')
    await screen.findByRole('listbox')
    await user.click(screen.getByText('outside'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
