/**
 * THE INTERNAL CHAT OF A TICKET: whose message is whose, editing, deleting.
 *
 * Agents talk here about a ticket, out of the end user's sight. Each person may
 * change or remove only their own messages, so the actions must appear on
 * those alone; an edit must send the new text (trimmed) and never an empty one;
 * a deletion must be confirmed first. After either, the list is read again so
 * what everyone sees is what the server holds. A failure says why and loses
 * nothing: an edit stays open, a refused message gives back its text without
 * overwriting what was typed meanwhile, and an empty box sends nothing at all.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { GET_INTERNAL_MESSAGES } from '@/graphql/queries'
import { DELETE_INTERNAL_MESSAGE, EDIT_INTERNAL_MESSAGE, SEND_INTERNAL_MESSAGE } from '@/graphql/mutations'
import { InternalChatPanel } from './InternalChatPanel'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const LIST_VARS = { entityType: 'incident', entityId: 'inc-1', limit: 50 }
const message = (over: Record<string, unknown>) => ({
  __typename: 'InternalMessage', id: 'm1', authorId: 'u-1', authorName: 'Test User', body: 'hello', mentions: [],
  createdAt: '2026-09-01T10:00:00Z', editedAt: null, ...over,
})
const MINE = message({ id: 'm1', body: 'I will restart the pool' })
const THEIRS = message({ id: 'm2', authorId: 'u-2', authorName: 'Anna  Neri', body: 'Wait for the backup', editedAt: '2026-09-01T11:00:00Z' })

const list = (messages: unknown[], extra: Partial<GqlMock> = {}): GqlMock => ({
  request: { query: GET_INTERNAL_MESSAGES, variables: LIST_VARS }, result: { data: { internalMessages: messages } }, ...extra,
})

function show(mocks: GqlMock[]) {
  return renderWithProviders(<InternalChatPanel entityType="incident" entityId="inc-1" currentUserId="u-1" />, {
    mocks: [meMock('operator', { maxUsageCount: Number.POSITIVE_INFINITY }), ...mocks],
  })
}
const bubble = (text: string) => screen.getByText(text).closest('div[style*="border-radius: 8px"]') as HTMLElement
const box = () => screen.getByRole('textbox', { name: 'Internal chat' })

describe('InternalChatPanel — whose message is whose', () => {
  it('only my messages offer Edit and Delete; a colleague\'s is read-only and says it was edited', async () => {
    show([list([MINE, THEIRS])])
    await screen.findByText('Wait for the backup')
    const mine = bubble('I will restart the pool')
    const theirs = bubble('Wait for the backup')
    expect(within(mine).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(within(mine).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(within(theirs).queryByRole('button')).toBeNull()
    expect(within(theirs).getByText('(edited)')).toBeInTheDocument()
    expect(within(mine).queryByText('(edited)')).toBeNull()
  })

  it('mine sit on the right, a colleague\'s on the left, each with the author\'s initials', async () => {
    show([list([MINE, THEIRS])])
    await screen.findByText('Wait for the backup')
    const row = (text: string) => bubble(text).parentElement!.parentElement!
    expect(row('I will restart the pool')).toHaveStyle({ justifyContent: 'flex-end' })
    expect(row('Wait for the backup')).toHaveStyle({ justifyContent: 'flex-start' })
    expect(within(row('I will restart the pool')).getByText('TU')).toBeInTheDocument()
    // A double space in a name does not cost an initial.
    expect(within(row('Wait for the backup')).getByText('AN')).toBeInTheDocument()
  })
})

describe('InternalChatPanel — editing my message', () => {
  it('sends the new text trimmed, closes the editor and reads the conversation again', async () => {
    const { user } = show([
      list([MINE]),
      { request: { query: EDIT_INTERNAL_MESSAGE, variables: { messageId: 'm1', body: 'I restarted the pool' } },
        result: { data: { editInternalMessage: { __typename: 'InternalMessage', id: 'm1', body: 'I restarted the pool', editedAt: '2026-09-01T12:00:00Z' } } } },
      list([message({ id: 'm1', body: 'I restarted the pool', editedAt: '2026-09-01T12:00:00Z' }), message({ id: 'm3', authorId: 'u-2', authorName: 'Anna Neri', body: 'Thanks, it is back' })]),
    ])
    await screen.findByText('I will restart the pool')
    await user.click(within(bubble('I will restart the pool')).getByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('textbox', { name: 'Edit' })
    expect(editor).toHaveValue('I will restart the pool')
    await user.clear(editor)
    await user.type(editor, '  I restarted the pool  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    // The colleague's reply comes only from reading the list again.
    expect(await screen.findByText('Thanks, it is back')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Edit' })).toBeNull()
    expect(within(bubble('I restarted the pool')).getByText('(edited)')).toBeInTheDocument()
  })

  it('an emptied edit cannot be saved, and Cancel gives back the message untouched', async () => {
    const { user } = show([list([MINE])])
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('textbox', { name: 'Edit' })
    await user.clear(editor)
    await user.type(editor, '   ')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox', { name: 'Edit' })).toBeNull()
    expect(screen.getByText('I will restart the pool')).toBeInTheDocument()
  })

  it('a refused edit says why and keeps the editor open with the new text', async () => {
    const { user } = show([
      list([MINE]),
      { request: { query: EDIT_INTERNAL_MESSAGE, variables: { messageId: 'm1', body: 'changed' } }, error: new Error('message too old') },
    ])
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('textbox', { name: 'Edit' })
    await user.clear(editor)
    await user.type(editor, 'changed')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Edit failed: message too old'))
    expect(screen.getByRole('textbox', { name: 'Edit' })).toHaveValue('changed')
  })
})

describe('InternalChatPanel — deleting my message', () => {
  it('asks first; confirming deletes it and the conversation is read again without it', async () => {
    const { user } = show([
      list([MINE, THEIRS]),
      { request: { query: DELETE_INTERNAL_MESSAGE, variables: { messageId: 'm1' } }, result: { data: { deleteInternalMessage: true } } },
      list([THEIRS]),
    ])
    await screen.findByText('I will restart the pool')
    await user.click(within(bubble('I will restart the pool')).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Delete this message?')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('I will restart the pool')).toBeNull())
    expect(screen.getByText('Wait for the backup')).toBeInTheDocument()
  })

  it('declining the confirmation deletes nothing', async () => {
    // No mock for the deletion: a request would fail as an unmatched mock.
    const { user } = show([list([MINE])])
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('I will restart the pool')).toBeInTheDocument()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('a refused deletion says why and leaves the message there', async () => {
    const { user } = show([
      list([MINE]),
      { request: { query: DELETE_INTERNAL_MESSAGE, variables: { messageId: 'm1' } }, error: new Error('not yours') },
    ])
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Delete failed: not yours'))
    expect(screen.getByText('I will restart the pool')).toBeInTheDocument()
  })
})

describe('InternalChatPanel — sending', () => {
  it('a new message joins the ones already there, at the end, once', async () => {
    const { user } = show([
      list([THEIRS], { maxUsageCount: Number.POSITIVE_INFINITY }),
      { request: { query: SEND_INTERNAL_MESSAGE, variables: { entityType: 'incident', entityId: 'inc-1', body: 'On it' } },
        result: { data: { sendInternalMessage: message({ id: 'm9', body: 'On it', createdAt: '2026-09-01T12:00:00Z' }) } } },
    ])
    await screen.findByText('Wait for the backup')
    await user.type(box(), 'On it')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(within(bubble('On it')).getByRole('button', { name: 'Edit' })).toBeInTheDocument())
    // Once the server's answer replaced the optimistic one: a single copy, after the colleague's message.
    await waitFor(() => expect(screen.getAllByText('On it')).toHaveLength(1))
    const order = screen.getByText('Wait for the backup').compareDocumentPosition(screen.getByText('On it'))
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Wait for the backup')).toBeInTheDocument()
  })

  it('a message sent before the sender\'s name is known shows at once, and takes the name from the server\'s answer', async () => {
    const { user } = renderWithProviders(<InternalChatPanel entityType="incident" entityId="inc-1" currentUserId="u-1" />, { mocks: [
      meMock(null, { maxUsageCount: Number.POSITIVE_INFINITY }),
      list([]),
      { request: { query: SEND_INTERNAL_MESSAGE, variables: { entityType: 'incident', entityId: 'inc-1', body: 'First!' } },
        result: { data: { sendInternalMessage: message({ id: 'm5', body: 'First!', authorName: 'Test User' }) } }, delay: 500 },
    ] })
    await screen.findByText('No messages')
    await user.type(box(), 'First!')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByText('First!')).toBeInTheDocument()
    expect(within(bubble('First!')).queryByText('Test User')).toBeNull()
    // The server's message replaces the optimistic one: look it up again.
    await waitFor(() => expect(within(bubble('First!')).getByText('Test User')).toBeInTheDocument(), { timeout: 5000 })
  })

  it('an empty box sends nothing, not even with the keyboard shortcut', async () => {
    // No mock for the send: a request would come back as an error toast.
    const { user } = show([list([])])
    await screen.findByText('No messages')
    await user.type(box(), '   ')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByText('No messages')).toBeInTheDocument()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('when a send fails, what was typed meanwhile is kept, not overwritten by the failed text', async () => {
    const { user } = show([
      list([]),
      // The refusal takes a second to come back: time enough to start the next message.
      { request: { query: SEND_INTERNAL_MESSAGE, variables: { entityType: 'incident', entityId: 'inc-1', body: 'first' } }, error: new Error('chat offline'), delay: 1000 },
    ])
    await screen.findByText('No messages')
    await user.type(box(), 'first')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.type(box(), 'second')
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Message not sent: chat offline'), { timeout: 5000 })
    expect(box()).toHaveValue('second')
  })
})
