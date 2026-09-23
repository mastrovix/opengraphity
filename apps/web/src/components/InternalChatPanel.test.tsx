/**
 * THE INTERNAL CHAT: SENT MEANS SHOWN (D13, tour of 23 Sep 2026).
 *
 * After «send» the message appeared only at the next reading of the list and
 * the text stayed in the box meanwhile; ⌘+Enter did nothing on a Mac. Pinned:
 *  - the box empties and the message is in the list at once, before the
 *    server answers, and stays there after;
 *  - ⌘+Enter sends like Ctrl+Enter, and the hint names the platform's key;
 *  - a failed send gives the text back, so it can be sent again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { GET_INTERNAL_MESSAGES } from '@/graphql/queries'
import { SEND_INTERNAL_MESSAGE } from '@/graphql/mutations'
import { isApplePlatform, sendShortcutLabel } from '@/lib/platform'
import { InternalChatPanel } from './InternalChatPanel'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const LIST_VARS = { entityType: 'incident', entityId: 'inc-1', limit: 50 }
const listMock: GqlMock = {
  request: { query: GET_INTERNAL_MESSAGES, variables: LIST_VARS },
  result: { data: { internalMessages: [] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}
const sent = (body: string): GqlMock => ({
  request: { query: SEND_INTERNAL_MESSAGE, variables: { entityType: 'incident', entityId: 'inc-1', body } },
  result: { data: { sendInternalMessage: { __typename: 'InternalMessage', id: 'm-1', authorId: 'u-1', authorName: 'Test User', body, mentions: [], createdAt: '2026-09-23T10:00:00Z', editedAt: null } } },
  delay: 60,
})
const refused = (body: string): GqlMock => ({
  request: { query: SEND_INTERNAL_MESSAGE, variables: { entityType: 'incident', entityId: 'inc-1', body } },
  error: new Error('chat offline'),
  delay: 30,
})

function show(mocks: GqlMock[]) {
  return renderWithProviders(<InternalChatPanel entityType="incident" entityId="inc-1" currentUserId="u-1" />, { mocks: [listMock, meMock('operator', { maxUsageCount: Number.POSITIVE_INFINITY }), ...mocks] })
}
const box = () => screen.getByRole('textbox', { name: 'Internal chat' })

afterEach(() => { vi.restoreAllMocks() })

describe('InternalChatPanel — sending', () => {
  it('the box empties and the message is in the list at once, then stays with the server\'s answer', async () => {
    const { user } = show([sent('hello team')])
    await screen.findByText('No messages')
    await user.type(box(), 'hello team')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    // Before the server answers (60 ms): already shown, the box already empty.
    expect(box()).toHaveValue('')
    expect(screen.getByText('hello team')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 120))
    expect(screen.getByText('hello team')).toBeInTheDocument()
    expect(screen.queryByText('No messages')).not.toBeInTheDocument()
  })

  it('⌘+Enter sends, like Ctrl+Enter', async () => {
    const { user } = show([sent('via command')])
    await screen.findByText('No messages')
    await user.type(box(), 'via command')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(await screen.findByText('via command')).toBeInTheDocument()
    expect(box()).toHaveValue('')
  })

  it('a refused send gives the text back and says why; the message leaves the list', async () => {
    const { user } = show([refused('lost?')])
    await screen.findByText('No messages')
    await user.type(box(), 'lost?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(box()).toHaveValue('lost?'))
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('chat offline'))
    const list = screen.getByText('No messages').parentElement!
    expect(within(list).queryByText('lost?')).not.toBeInTheDocument()
  })
})

describe('the send shortcut', () => {
  it('is named for the platform: ⌘ on Apple devices, Ctrl elsewhere', () => {
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isApplePlatform({ userAgentData: { platform: 'macOS' } })).toBe(true)
    expect(isApplePlatform({ platform: '', userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' })).toBe(true)
    expect(isApplePlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe(false)
    expect(sendShortcutLabel({ platform: 'MacIntel' })).toBe('⌘+Enter')
    expect(sendShortcutLabel({ platform: 'Linux x86_64', userAgent: 'X11; Linux' })).toBe('Ctrl+Enter')
  })

  it('the placeholder of the chat says it', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    show([])
    expect(await screen.findByPlaceholderText('Write a message... (⌘+Enter to send)')).toBeInTheDocument()
  })
})
