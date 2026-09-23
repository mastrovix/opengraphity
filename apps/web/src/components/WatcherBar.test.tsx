/**
 * WATCHERS OF A TICKET: following it, and choosing who else follows it.
 *
 * A watcher is told about every change of the ticket, so the bar decides who
 * gets notified. The toggle must say whether I am watching and switch it for
 * THIS ticket; the counter opens the list of watchers, each removable; the
 * «add» search asks the server only once two characters are typed (E-17: never
 * the whole directory), offers only people who are not watching yet, and adds
 * the one chosen. Every change refreshes what the bar shows and is confirmed;
 * a refusal says why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { WatcherBar } = await import('./WatcherBar')

const TICKET = { entityType: 'incident', entityId: 'inc-7' }
const ANNA = { id: 'u-anna', name: 'Anna Neri', email: 'anna@acme.com' }
const NONAME = { id: 'u-ops', name: '', email: 'ops@acme.com' }
const BOB = { id: 'u-bob', name: 'Bob Rossi', email: 'bob@acme.com' }

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['IsWatching'] = { isWatching: false }
  apolloFinto.risposte['GetWatchers'] = { watchers: [ANNA, NONAME] }
  apolloFinto.risposte['SearchUsers'] = { searchUsers: [ANNA, BOB] }
})

const show = () => renderWithProviders(<WatcherBar {...TICKET} />)

describe('WatcherBar — my own watching', () => {
  it('not watching: «Watch» starts watching this ticket, refreshes the bar and confirms', async () => {
    const { user } = show()
    const toggle = screen.getByRole('button', { name: 'Watch' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(apolloFinto.chiamata('IsWatching')).toEqual(TICKET)
    await user.click(toggle)
    expect(apolloFinto.chiamata('WatchEntity')).toEqual(TICKET)
    expect(apolloFinto.chiamate['UnwatchEntity']).toBeUndefined()
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(2)
    expect(toast.success).toHaveBeenCalledWith('You are now watching')
  })

  it('watching: «Watching» is pressed, and a click stops it', async () => {
    apolloFinto.risposte['IsWatching'] = { isWatching: true }
    const { user } = show()
    const toggle = screen.getByRole('button', { name: 'Watching' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await user.click(toggle)
    expect(apolloFinto.chiamata('UnwatchEntity')).toEqual(TICKET)
    expect(apolloFinto.chiamate['WatchEntity']).toBeUndefined()
    expect(toast.success).toHaveBeenCalledWith('You are no longer watching')
  })

  it('a refusal says why, and confirms nothing', async () => {
    apolloFinto.esiti['WatchEntity'] = { error: new Error('not allowed on this ticket') }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Watch' }))
    expect(toast.error).toHaveBeenCalledWith('not allowed on this ticket')
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('WatcherBar — before the answers arrive', () => {
  it('it does not claim I am watching, nor that anyone is', () => {
    apolloFinto.risposte['IsWatching'] = undefined
    apolloFinto.risposte['GetWatchers'] = undefined
    show()
    expect(screen.getByRole('button', { name: 'Watch' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Watchers: 0' })).toBeInTheDocument()
  })
})

describe('WatcherBar — the list of watchers', () => {
  it('the counter says how many watch, and opens and closes the list', async () => {
    const { user } = show()
    const counter = screen.getByRole('button', { name: 'Watchers: 2' })
    expect(counter).toHaveAttribute('aria-expanded', 'false')
    expect(apolloFinto.chiamata('GetWatchers')).toEqual(TICKET)
    await user.click(counter)
    expect(counter).toHaveAttribute('aria-expanded', 'true')
    const list = document.getElementById(counter.getAttribute('aria-controls')!)!
    expect(list).toHaveTextContent('Watchers (2)')
    expect(within(list).getByText('Anna Neri')).toBeInTheDocument()
    // Without a name, a watcher is shown by e-mail — and the avatar takes its initial.
    expect(within(list).getByText('ops@acme.com')).toBeInTheDocument()
    expect(within(list).getByText('O')).toBeInTheDocument()
    await user.click(counter)
    expect(screen.queryByText('Anna Neri')).toBeNull()
  })

  it('removing a watcher removes that person from this ticket, and confirms', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Watchers: 2' }))
    await user.click(screen.getByRole('button', { name: 'Remove ops@acme.com' }))
    expect(apolloFinto.chiamata('RemoveWatcher')).toEqual({ ...TICKET, userId: 'u-ops' })
    expect(toast.success).toHaveBeenCalledWith('Watcher removed')
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('WatcherBar — adding a watcher', () => {
  const openSearch = async (user: ReturnType<typeof show>['user']) => {
    await user.click(screen.getByRole('button', { name: 'Watchers: 2' }))
    await user.click(screen.getByRole('button', { name: 'Add watcher' }))
    return screen.getByRole('textbox', { name: 'Search user…' })
  }

  it('asks the server only from two characters, and offers only who is not watching yet', async () => {
    // The search waits for a pause in the typing: the clock is ours, so «a pause» is exact.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { user } = show()
      const search = await openSearch(user)
      expect(search).toHaveFocus()
      await user.type(search, 'b')
      act(() => { vi.advanceTimersByTime(300) })
      expect(apolloFinto.chiamate['SearchUsers']).toBeUndefined()
      expect(screen.getByText('Type at least 2 characters')).toBeInTheDocument()

      await user.type(search, 'o')
      act(() => { vi.advanceTimersByTime(300) })
      expect(apolloFinto.chiamate['SearchUsers']).toEqual([{ search: 'bo', limit: 8 }])
      expect(screen.getByRole('button', { name: /Bob Rossi/ })).toHaveTextContent('Bob Rossi (bob@acme.com)')
      // Anna is already watching: the server may return her, the bar does not offer her twice.
      expect(screen.queryByRole('button', { name: /anna@acme.com\)/ })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('choosing a person adds them to this ticket, closes the search and confirms', async () => {
    const { user } = show()
    await user.type(await openSearch(user), 'bob')
    // The search waits for a pause in the typing (250 ms): a loaded machine may take longer.
    await user.click(await screen.findByRole('button', { name: /Bob Rossi/ }, { timeout: 10_000 }))
    expect(apolloFinto.chiamata('AddWatcher')).toEqual({ ...TICKET, userId: 'u-bob' })
    expect(toast.success).toHaveBeenCalledWith('Watcher added')
    expect(screen.queryByRole('textbox', { name: 'Search user…' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add watcher' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('nobody new to offer: it says «No results»', async () => {
    apolloFinto.risposte['SearchUsers'] = { searchUsers: [ANNA] }
    const { user } = show()
    await user.type(await openSearch(user), 'anna')
    expect(await screen.findByText('No results', {}, { timeout: 10_000 })).toBeInTheDocument()
  })

  it('closing the search and opening it again starts from an empty box', async () => {
    const { user } = show()
    await user.type(await openSearch(user), 'bo')
    await user.click(screen.getByRole('button', { name: 'Add watcher' }))
    expect(screen.queryByRole('textbox', { name: 'Search user…' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add watcher' }))
    expect(screen.getByRole('textbox', { name: 'Search user…' })).toHaveValue('')
    await waitFor(() => expect(screen.getByText('Type at least 2 characters')).toBeInTheDocument(), { timeout: 10_000 })
  })
})
