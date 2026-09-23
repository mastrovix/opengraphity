/**
 * AI ANALYSIS: a person asks questions about the data and the answer streams in.
 *
 * The question is posted with the person's token to the report stream; the
 * page shows the tool steps, then the text as it arrives, and keeps the
 * conversation in the sidebar to reopen, delete, print or export as CSV.
 *
 * What breaks for a user if it regresses: a question that is sent twice or
 * not at all, an answer that ends up in the wrong conversation, an error that
 * is swallowed instead of said (it goes in the chat AND in a toast), fragments
 * of the answer dropped in silence, a CSV that is not the table on screen, or
 * a question box offered when the organisation has turned the feature off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { default: ReportsPage } = await import('./ReportsPage')

// ── Data ─────────────────────────────────────────────────────────────────────

interface Message { id: string; role: string; content: string; createdAt: string }
interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; messages: Message[] }

/** An answer with every piece of markdown the page styles: headings, bold, a table, a list, code. */
const ANSWER = [
  '## Open incidents',
  '',
  '### By team',
  '',
  'The **Network** team has the most.',
  '',
  '| Team | Open |',
  '|------|------|',
  '| Network | 3 |',
  '| Database | 1 |',
  '',
  '- Oldest: `INC-7`',
  '- Newest: `INC-9`',
].join('\n')

const QUESTION = 'How many **open** incidents per team?'

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', title: 'Incident backlog', createdAt: '2026-09-20T08:00:00Z', updatedAt: '2026-09-20T08:00:05Z',
  messages: [
    { id: 'm1', role: 'user', content: QUESTION, createdAt: '2026-09-20T08:00:00Z' },
    { id: 'm2', role: 'assistant', content: ANSWER, createdAt: '2026-09-20T08:00:05Z' },
  ],
  ...over,
})

const OTHER = conversation({
  id: 'c2', title: 'SLA breaches', updatedAt: '2026-09-19T09:00:00Z',
  messages: [
    { id: 'm3', role: 'user', content: 'Which SLAs were breached?', createdAt: '2026-09-19T09:00:00Z' },
    { id: 'm4', role: 'assistant', content: 'None this week.', createdAt: '2026-09-19T09:00:03Z' },
  ],
})

const answerMessage = (content: string) => ({ id: 'm-final', role: 'assistant', content, createdAt: '2026-09-23T10:00:00Z' })

// ── The stream ───────────────────────────────────────────────────────────────

/** One server-sent event, as the API writes it. */
const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`

/**
 * The body of a streamed answer, fed by the test piece by piece as the
 * network would: `send` delivers each text as one packet, `close` ends it.
 */
function answerStream() {
  const encoder = new TextEncoder()
  const packets: Array<Uint8Array | null> = []
  let waiting: ((r: { done: boolean; value?: Uint8Array }) => void) | null = null
  const deliver = () => {
    if (!waiting || packets.length === 0) return
    const next = packets.shift()!
    const resolve = waiting
    waiting = null
    resolve(next === null ? { done: true } : { done: false, value: next })
  }
  const reader = { read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => { waiting = resolve; deliver() }) }
  const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  return {
    response: { ok: true, status: 200, body: { getReader: () => reader } },
    send: async (...texts: string[]) => {
      await act(async () => { for (const text of texts) { packets.push(encoder.encode(text)); deliver() } await settle() })
    },
    close: async () => {
      await act(async () => { packets.push(null); deliver(); await settle() })
    },
  }
}

const fetchMock = vi.fn()

/** What the page posted to the report stream. */
const posted = (call = 0) => {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit]
  return { url, init, body: JSON.parse(init.body as string) as { question: string; conversationId: string | null } }
}

// ── Page helpers ─────────────────────────────────────────────────────────────

const questionBox = () => screen.getByRole('textbox', { name: 'AI Analysis' })
const row = (title: string) => screen.getByText(title).closest('[role="button"]') as HTMLElement

/** The answer of `ANSWER`, drawn as formatted text. */
function expectFormattedAnswer() {
  expect(screen.getByRole('heading', { level: 2, name: 'Open incidents' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { level: 3, name: 'By team' })).toBeInTheDocument()
  expect(screen.getByText('Network', { selector: 'strong' })).toBeInTheDocument()
  const table = screen.getByRole('table')
  expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Team', 'Open'])
  const rows = within(table).getAllByRole('row').slice(1)
  expect(rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([['Network', '3'], ['Database', '1']])
  expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Oldest: INC-7', 'Newest: INC-9'])
  expect(screen.getByText('INC-7', { selector: 'code' })).toBeInTheDocument()
}

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  toast.warning.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { reportAnalysis: true } } }
  apolloFinto.risposte['GetReportConversations'] = { reportConversations: [] }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ── The page ─────────────────────────────────────────────────────────────────

describe('AI Analysis — the page', () => {
  it.each([
    ['with no conversation yet', { reportConversations: [] }],
    ['while the conversations are still loading', undefined],
  ])('%s, the sidebar says there is none and the page invites the first question', (_case, answer) => {
    apolloFinto.risposte['GetReportConversations'] = answer
    renderWithProviders(<ReportsPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'AI Analysis' })).toBeInTheDocument()
    expect(screen.getByText('No conversations')).toBeInTheDocument()
    expect(screen.getByText('Ask the first question to start.')).toBeInTheDocument()
    expect(screen.getByText('Ask questions about your data in natural language')).toBeInTheDocument()
    expect(questionBox()).toHaveAttribute('placeholder', 'Ask a question about your data...')
    expect(screen.getByText('Enter to send · Shift+Enter for a new line')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    // Nothing to print or export yet.
    expect(screen.queryByRole('button', { name: '↓ PDF' })).toBeNull()
    expect(screen.queryByRole('button', { name: '↓ CSV' })).toBeNull()
  })

  it('when the organisation has turned report analysis off, the notice takes the place of the question box', () => {
    apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { reportAnalysis: false } } }
    renderWithProviders(<ReportsPage />)
    expect(screen.getByRole('status')).toHaveTextContent('«Report analysis» is turned off for your organization.')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  it('the question box grows with the text, up to four lines', () => {
    renderWithProviders(<ReportsPage />)
    const box = questionBox()
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 44 })
    fireEvent.input(box)
    expect(box.style.height).toBe('44px')
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 300 })
    fireEvent.input(box)
    expect(box.style.height).toBe('96px')
  })
})

describe('AI Analysis — conversations', () => {
  it('lists the conversations, shortening a long title, with when each was last updated', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-23T12:00:00Z') })
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [
      conversation({ title: 'Open incidents by team over the last quarter of the year', updatedAt: '2026-09-23T10:00:00Z' }),
      conversation({ id: 'c2', title: 'SLA breaches', updatedAt: '2026-09-21T12:00:00Z' }),
    ] }
    renderWithProviders(<ReportsPage />)
    // Forty characters and an ellipsis: the whole title would push the time out of the sidebar.
    expect(within(row('Open incidents by team over the last qua…')).getByText('2 hours ago')).toBeInTheDocument()
    expect(within(row('SLA breaches')).getByText('2 days ago')).toBeInTheDocument()
    expect(screen.queryByText('No conversations')).toBeNull()
  })

  it('opening a conversation shows the question as it was typed and the answer as formatted text', async () => {
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation()] }
    const { user } = renderWithProviders(<ReportsPage />)
    expect(row('Incident backlog')).not.toHaveAttribute('aria-current')
    await user.click(row('Incident backlog'))
    expect(row('Incident backlog')).toHaveAttribute('aria-current', 'true')
    // The question is the person's own text: its asterisks are not turned into bold.
    expect(screen.getByText(QUESTION)).toBeInTheDocument()
    expectFormattedAnswer()
    expect(screen.queryByText('Ask questions about your data in natural language')).toBeNull()
    expect(screen.getByRole('button', { name: '↓ PDF' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '↓ CSV' })).toBeInTheDocument()
  })

  it('a conversation opens from the keyboard too', async () => {
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation()] }
    const { user } = renderWithProviders(<ReportsPage />)
    row('Incident backlog').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText(QUESTION)).toBeInTheDocument()
    expect(row('Incident backlog')).toHaveAttribute('aria-current', 'true')
  })

  it('hovering a conversation highlights it, and the open one keeps its own highlight', async () => {
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation(), OTHER] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.hover(row('SLA breaches'))
    expect(row('SLA breaches').style.background).toBe('var(--color-border-light)')
    await user.unhover(row('SLA breaches'))
    expect(row('SLA breaches').style.background).toBe('transparent')
    await user.hover(row('Incident backlog'))
    expect(row('Incident backlog').style.background).toBe('var(--color-border)')
    await user.unhover(row('Incident backlog'))
    expect(row('Incident backlog').style.background).toBe('var(--color-border)')
  })

  it('deleting the open conversation closes it and reloads the list', async () => {
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation(), OTHER] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.click(within(row('Incident backlog')).getByRole('button', { name: 'Delete' }))
    expect(apolloFinto.chiamata('DeleteReportConversation')).toEqual({ id: 'c1' })
    expect(await screen.findByText('Ask questions about your data in natural language')).toBeInTheDocument()
    expect(screen.queryByText(QUESTION)).toBeNull()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('deleting another conversation leaves the open one alone', async () => {
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation(), OTHER] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.click(within(row('SLA breaches')).getByRole('button', { name: 'Delete' }))
    expect(apolloFinto.chiamata('DeleteReportConversation')).toEqual({ id: 'c2' })
    // The click on the bin is not a click on the row: SLA breaches is not opened.
    expect(row('Incident backlog')).toHaveAttribute('aria-current', 'true')
    expect(row('SLA breaches')).not.toHaveAttribute('aria-current')
    expect(screen.getByText(QUESTION)).toBeInTheDocument()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a delete the server refuses is reported, and the conversation stays open', async () => {
    apolloFinto.esiti['DeleteReportConversation'] = { error: new Error('Not your conversation') }
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation()] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.click(within(row('Incident backlog')).getByRole('button', { name: 'Delete' }))
    expect(toast.error).toHaveBeenCalledWith('Not your conversation')
    expect(screen.getByText(QUESTION)).toBeInTheDocument()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('"+" starts a new conversation and puts the cursor in the question box', async () => {
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation()] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.type(questionBox(), 'half a question')
    await user.click(screen.getByTitle('New conversation'))
    expect(screen.getByText('Ask questions about your data in natural language')).toBeInTheDocument()
    expect(screen.queryByText(QUESTION)).toBeNull()
    expect(row('Incident backlog')).not.toHaveAttribute('aria-current')
    expect(questionBox()).toHaveValue('')
    expect(questionBox()).toHaveFocus()
  })
})

// ── Asking ───────────────────────────────────────────────────────────────────

describe('AI Analysis — asking', () => {
  it('a new question is posted with the token, streamed in, and its conversation becomes the current one', async () => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    let saved = false
    const created = conversation({ id: 'c9', title: 'Incidents per team', messages: [
      { id: 'm8', role: 'user', content: 'How many open incidents per team?', createdAt: '2026-09-23T10:00:00Z' },
      { id: 'm9', role: 'assistant', content: ANSWER, createdAt: '2026-09-23T10:00:05Z' },
    ] })
    apolloFinto.risposte['GetReportConversations'] = () => ({ reportConversations: saved ? [created] : [] })
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { user } = renderWithProviders(<ReportsPage />)

    await user.type(questionBox(), 'How many open incidents per team?')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    // Posted to the report stream, with the person's token, as a new conversation.
    const { url, init, body } = posted()
    expect(url).toBe('/api/report/stream')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', authorization: 'Bearer test-token' })
    expect(body).toEqual({ question: 'How many open incidents per team?', conversationId: null })

    // The question shows at once, the box is emptied, and Send waits for the answer.
    expect(screen.getByText('How many open incidents per team?')).toBeInTheDocument()
    expect(questionBox()).toHaveValue('')
    expect(screen.getByRole('button', { name: '…' })).toBeDisabled()

    // A tool step is shown while no text has arrived yet.
    await stream.send(frame('tool', { description: 'Counting open incidents' }))
    expect(screen.getByText('Counting open incidents')).toBeInTheDocument()

    // The text streams in as formatted markdown, and the chat follows it down.
    const scrolledBefore = scroll.mock.calls.length
    await stream.send(frame('chunk', { text: ANSWER.slice(0, 50) }), frame('chunk', { text: ANSWER.slice(50) }))
    expect(screen.queryByText('Counting open incidents')).toBeNull()
    expectFormattedAnswer()
    expect(scroll.mock.calls.length).toBeGreaterThan(scrolledBefore)
    expect(scroll).toHaveBeenLastCalledWith({ behavior: 'smooth' })

    saved = true
    await stream.send(frame('conversation', { conversationId: 'c9' }), frame('done', { conversationId: 'c9', message: answerMessage(ANSWER) }))
    await stream.close()

    // The answer stays, under the question.
    expectFormattedAnswer()
    expect(screen.getByText('How many open incidents per team?')).toBeInTheDocument()
    // The list is reloaded and the new conversation is the current one.
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(row('Incidents per team')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('Enter sends the question, Shift+Enter starts a new line', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents by team{Shift>}{Enter}{/Shift}and by priority')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(questionBox()).toHaveValue('Incidents by team\nand by priority')
    await user.keyboard('{Enter}')
    expect(posted().body.question).toBe('Incidents by team\nand by priority')
  })

  it('a blank question is not sent', async () => {
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), '   ')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('while an answer is streaming, a second question is not sent and stays in the box', async () => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'First question{Enter}')
    await user.type(questionBox(), 'Second question{Enter}')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(questionBox()).toHaveValue('Second question')
    await stream.send(frame('done', { message: answerMessage('First answer.') }))
    await stream.close()
    expect(screen.getByText('First answer.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
  })

  it('in an open conversation the question continues it, below what was said before', async () => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation()] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.type(questionBox(), 'And last week?{Enter}')
    expect(posted().body).toEqual({ question: 'And last week?', conversationId: 'c1' })
    // A conversation frame is only for a NEW conversation: here it moves nothing.
    // No text was streamed, so the answer is the one the server saved.
    await stream.send(frame('conversation', { conversationId: 'c-other' }) + frame('done', { message: answerMessage('Two incidents last week.') }))
    await stream.close()
    const answer = screen.getByText('Two incidents last week.')
    const question = screen.getByText('And last week?')
    expect(screen.getByText(QUESTION).compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row('Incident backlog')).toHaveAttribute('aria-current', 'true')
  })

  it('a new conversation takes its id from the conversation frame when the final frame does not carry it', async () => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    let saved = false
    const created = conversation({ id: 'c7', title: 'Closed today', messages: [
      { id: 'm1', role: 'user', content: 'Closed today?', createdAt: '2026-09-23T10:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'Four.', createdAt: '2026-09-23T10:00:02Z' },
    ] })
    apolloFinto.risposte['GetReportConversations'] = () => ({ reportConversations: saved ? [created] : [] })
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Closed today?{Enter}')
    saved = true
    await stream.send(frame('conversation', { conversationId: 'c7' }), frame('chunk', { text: 'Four.' }), frame('done', { message: answerMessage('Four.') }))
    await stream.close()
    expect(row('Closed today')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('Four.')).toBeInTheDocument()
  })

  it('until the reloaded list arrives, the answer on screen is not replaced by an older copy of the conversation', async () => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    // The reload is still on its way; meanwhile the cache already knows the
    // new conversation, but only with the question.
    apolloFinto.refetch.mockReturnValueOnce(new Promise(() => {}))
    let saved = false
    const partial = conversation({ id: 'c5', title: 'Closed this week', messages: [
      { id: 'm1', role: 'user', content: 'Closed this week?', createdAt: '2026-09-23T10:00:00Z' },
    ] })
    apolloFinto.risposte['GetReportConversations'] = () => ({ reportConversations: saved ? [partial] : [] })
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Closed this week?{Enter}')
    saved = true
    await stream.send(frame('chunk', { text: 'Eleven.' }), frame('done', { conversationId: 'c5', message: answerMessage('Eleven.') }))
    await stream.close()
    expect(row('Closed this week')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('Closed this week?')).toBeInTheDocument()
    expect(screen.getByText('Eleven.')).toBeInTheDocument()
  })

  it('reads a frame split across two packets, skips keep-alive comments, and keeps a last frame without the blank line', async () => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Anything open?{Enter}')
    const chunk = frame('chunk', { text: 'All **12** incidents are closed.' })
    await stream.send(': keep-alive\n\n', chunk.slice(0, 20))
    await stream.send(chunk.slice(20))
    await stream.send(frame('done', { message: answerMessage('saved') }).trimEnd())
    await stream.close()
    expect(screen.getByText('12', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('Anything open?')).toBeInTheDocument()
    // A comment is not an unreadable fragment of the answer.
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('leaving the page stops the answer being generated, without an error', async () => {
    let signal: AbortSignal | undefined
    let request: Promise<never> | undefined
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      request = new Promise<never>((_resolve, reject) => {
        signal = init.signal!
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
      return request
    })
    const { user, unmount } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents?{Enter}')
    expect(signal?.aborted).toBe(false)
    unmount()
    expect(signal?.aborted).toBe(true)
    await expect(request).rejects.toThrow('aborted')
    expect(toast.error).not.toHaveBeenCalled()
  })
})

// ── Failures ─────────────────────────────────────────────────────────────────

describe('AI Analysis — when something goes wrong', () => {
  it.each([
    ['an overloaded AI', frame('error', { message: 'upstream overloaded_error' }), 'AI service temporarily overloaded. Try again in a few seconds.'],
    ['a server error', frame('error', { message: 'Neo4j is unavailable' }), 'Neo4j is unavailable'],
    ['an error frame without a message', frame('error', {}), 'Error while generating the answer'],
    ['a malformed error frame', 'event: error\ndata: {not json\n\n', 'Error while generating the answer'],
  ])('%s is said in the chat and in a toast, and the question stays', async (_case, errorFrame, message) => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents by team?{Enter}')
    await stream.send(errorFrame)
    // What arrives after the error is not taken as the answer.
    await stream.send(frame('done', { message: answerMessage('A late answer') }))
    await stream.close()
    expect(toast.error).toHaveBeenCalledWith(message)
    expect(screen.getByText(`Error: ${message}`)).toBeInTheDocument()
    expect(screen.getByText('Incidents by team?')).toBeInTheDocument()
    expect(screen.queryByText('A late answer')).toBeNull()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it.each([
    ['a refused request', { ok: false, status: 503, body: {} }, 'HTTP 503'],
    ['a response without a body', { ok: true, status: 200, body: null }, 'HTTP 200'],
  ])('%s is said in the chat and in a toast', async (_case, response, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockResolvedValue(response)
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents?{Enter}')
    expect(await screen.findByText(`Error: ${message}`)).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith(message)
    expect(screen.getByText('Incidents?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('a failure that is not even an Error is still said', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockRejectedValue('network down')
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents?{Enter}')
    expect(await screen.findByText('Error: network down')).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith('network down')
  })

  it('fragments that cannot be read are counted and reported with the first reason, and the answer still arrives', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents?{Enter}')
    await stream.send(
      'data: {"text":"no event name"}\n\n',
      'event: chunk\ndata: {broken\n\n',
      frame('mystery', { text: 'unknown event' }),
      frame('chunk', { text: 'Three incidents are open.' }),
      frame('done', { message: answerMessage('saved') }),
    )
    await stream.close()
    expect(toast.warning).toHaveBeenCalledWith('3 fragments of the answer could not be interpreted (event "—" with an unexpected payload): the text may be incomplete.')
    expect(screen.getByText('Three incidents are open.')).toBeInTheDocument()
  })

  it('a fragment that is not JSON is reported with the parser\'s reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents?{Enter}')
    await stream.send('event: chunk\ndata: {broken\n\n', frame('chunk', { text: 'Two.' }), frame('done', { message: answerMessage('saved') }))
    await stream.close()
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/^1 fragment of the answer could not be interpreted \(invalid JSON: .+\): the text may be incomplete\.$/))
    expect(screen.getByText('Two.')).toBeInTheDocument()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: a stream that ended with
  // neither the final answer nor an error removed the question from the chat
  // and said nothing.
  it('a stream that ends without the final answer keeps the question in the chat', async () => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents by team?{Enter}')
    await stream.send(frame('chunk', { text: 'Network has' }))
    await stream.close()
    expect(screen.getByText('Incidents by team?')).toBeInTheDocument()
    const noAnswer = 'The answer did not arrive: the connection closed before the end. Ask the question again.'
    expect(screen.getByText(`Error: ${noAnswer}`)).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith(noAnswer)
    // The half-streamed text is not left on screen as if it were the answer.
    expect(screen.queryByText('Network has')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: a refused request said
  // «HTTP 403» and dropped the reason the server gives in the body.
  it('a refused request shows the reason the server gave', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reason = "Role 'viewer' is not authorized. Requires: report.ai"
    fetchMock.mockResolvedValue({ ok: false, status: 403, body: {}, json: async () => ({ error: reason }), text: async () => JSON.stringify({ error: reason }) })
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents?{Enter}')
    expect(await screen.findByText(/^Error: /)).toHaveTextContent(reason)
    expect(toast.error).toHaveBeenCalledWith(reason)
  })

  // The other bodies the report stream refuses with (`rest/report-stream.ts`,
  // `rest/errorHandler.ts`), and what is left when there is no reason.
  it.each([
    ['the AI turned off by the organisation, said in the reader\'s language',
      async () => ({ error: { code: 'AI_DISABLED', feature: 'reportAnalysis', message: 'The AI feature "reportAnalysis" is turned off for this organization.' } }),
      'The AI feature «Report analysis» is turned off for this organization. An administrator can turn it on in Organization → AI.'],
    ['a refusal of the REST error handler', async () => ({ error: { code: 'VALIDATION_ERROR', message: 'question is required' } }), 'question is required'],
    ['a body without a reason', async () => ({ error: { code: 'FORBIDDEN' } }), 'HTTP 403'],
    ['a body that is not JSON (a proxy\'s page)', async () => { throw new SyntaxError('Unexpected token <') }, 'HTTP 403'],
  ])('a refused request: %s', async (_case, json, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockResolvedValue({ ok: false, status: 403, body: {}, json })
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents?{Enter}')
    expect(await screen.findByText(`Error: ${message}`)).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith(message)
  })

  // Found by this test (tour of 23 Sep 2026), fixed: an answer still streaming
  // when another conversation was opened was added to THAT conversation's
  // messages on screen (the server had saved it in the first one).
  it('an answer that arrives after opening another conversation is not shown inside that conversation', async () => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation(), OTHER] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.type(questionBox(), 'And last week?{Enter}')
    await user.click(row('SLA breaches'))
    await stream.send(frame('chunk', { text: 'Two incidents' }))
    // Not even while it streams.
    expect(screen.queryByText('Two incidents')).toBeNull()
    await stream.send(frame('done', { message: answerMessage('Two incidents last week.') }))
    await stream.close()
    expect(row('SLA breaches')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('None this week.')).toBeInTheDocument()
    expect(screen.queryByText('And last week?')).toBeNull()
    expect(screen.queryByText('Two incidents last week.')).toBeNull()
    // The list is reloaded: the first conversation comes back with its answer.
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('an error of an answer whose conversation was left is still said, in a toast only', async () => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation(), OTHER] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.type(questionBox(), 'And last week?{Enter}')
    await user.click(row('SLA breaches'))
    await stream.send(frame('error', { message: 'Neo4j is unavailable' }))
    await stream.close()
    expect(toast.error).toHaveBeenCalledWith('Neo4j is unavailable')
    expect(screen.queryByText('Error: Neo4j is unavailable')).toBeNull()
    expect(screen.getByText('None this week.')).toBeInTheDocument()
  })

  it('opening the conversation already on screen leaves the answer streaming into it', async () => {
    const stream = answerStream()
    fetchMock.mockResolvedValue(stream.response)
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation()] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.type(questionBox(), 'And last week?{Enter}')
    await user.click(row('Incident backlog'))
    await stream.send(frame('done', { message: answerMessage('Two incidents last week.') }))
    await stream.close()
    expect(screen.getByText('And last week?')).toBeInTheDocument()
    expect(screen.getByText('Two incidents last week.')).toBeInTheDocument()
  })
})

// ── Print and CSV ────────────────────────────────────────────────────────────

describe('AI Analysis — print and CSV', () => {
  it('PDF prints the conversation under its own title, and gives the page its title back afterwards', async () => {
    document.title = 'OpenGrafo'
    const titlesWhenPrinting: string[] = []
    vi.spyOn(window, 'print').mockImplementation(() => { titlesWhenPrinting.push(document.title) })
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation()] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.click(screen.getByRole('button', { name: '↓ PDF' }))
    expect(titlesWhenPrinting).toEqual(['Incident backlog'])
    window.dispatchEvent(new Event('afterprint'))
    expect(document.title).toBe('OpenGrafo')
    // Restored once: a later print of something else does not reset the title again.
    document.title = 'Another page'
    window.dispatchEvent(new Event('afterprint'))
    expect(document.title).toBe('Another page')
  })

  it('a conversation not saved yet prints as "ITSM report"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const titlesWhenPrinting: string[] = []
    vi.spyOn(window, 'print').mockImplementation(() => { titlesWhenPrinting.push(document.title) })
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: {} })
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents?{Enter}')
    await screen.findByText('Error: HTTP 500')
    await user.click(screen.getByRole('button', { name: '↓ PDF' }))
    expect(titlesWhenPrinting).toEqual(['ITSM report'])
    window.dispatchEvent(new Event('afterprint'))
  })

  it('CSV downloads the table of the LAST answer', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation({ messages: [
      { id: 'm1', role: 'assistant', content: '| Priority | Open |\n|---|---|\n| high | 9 |\n', createdAt: '2026-09-20T08:00:00Z' },
      { id: 'm2', role: 'user', content: 'And per team?', createdAt: '2026-09-20T08:01:00Z' },
      { id: 'm3', role: 'assistant', content: ANSWER, createdAt: '2026-09-20T08:01:05Z' },
    ] })] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.click(screen.getByRole('button', { name: '↓ CSV' }))
    const blob = createUrl.mock.calls[0]![0] as Blob
    // Written by `exportToCsv`, like every CSV of the app: RFC 4180 line ends,
    // and a BOM so that Excel reads accented letters right.
    expect(blob.type).toBe('text/csv;charset=utf-8')
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blob.arrayBuffer())).toBe('﻿Team,Open\r\nNetwork,3\r\nDatabase,1')
    const anchor = click.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.download).toBe('report.csv')
    expect(anchor.href).toBe('blob:report')
    // The blob URL is released, or every export leaks the file in memory.
    expect(revoke).toHaveBeenCalledWith('blob:report')
  })

  it('CSV of an answer without a table says there is none', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const createUrl = vi.spyOn(URL, 'createObjectURL')
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [OTHER] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('SLA breaches'))
    await user.click(screen.getByRole('button', { name: '↓ CSV' }))
    expect(alert).toHaveBeenCalledWith('No table found in the answer')
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('before the first answer, CSV has nothing to export and does nothing', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const createUrl = vi.spyOn(URL, 'createObjectURL')
    fetchMock.mockReturnValue(new Promise(() => {}))
    const { user } = renderWithProviders(<ReportsPage />)
    await user.type(questionBox(), 'Incidents?{Enter}')
    await user.click(screen.getByRole('button', { name: '↓ CSV' }))
    expect(alert).not.toHaveBeenCalled()
    expect(createUrl).not.toHaveBeenCalled()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the CSV dropped the empty
  // cells and never quoted, so «Rome, Milan» became two columns and every
  // value after it moved one column left.
  it('CSV keeps every cell in its own column, even a cell with a comma or an empty one', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation({ messages: [
      { id: 'm1', role: 'assistant', content: '| Team | Sites | Note |\n|---|---|---|\n| Network |  | none |\n| Field | Rome, Milan | two |\n', createdAt: '2026-09-20T08:00:00Z' },
    ] })] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.click(screen.getByRole('button', { name: '↓ CSV' }))
    const csv = await (createUrl.mock.calls[0]![0] as Blob).text()
    expect(csv.split('\r\n')).toEqual(['Team,Sites,Note', 'Network,,none', 'Field,"Rome, Milan",two'])
  })

  it('CSV has the columns of the table as drawn: a pipe written as \\| stays in its cell, a short row gets empty cells, extra cells are left out', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    apolloFinto.risposte['GetReportConversations'] = { reportConversations: [conversation({ messages: [
      { id: 'm1', role: 'assistant', content: '| Rule | Note |\n|---|---|\n| a \\| b | say "hi" |\n| short |\n| x | y | extra |\n', createdAt: '2026-09-20T08:00:00Z' },
    ] })] }
    const { user } = renderWithProviders(<ReportsPage />)
    await user.click(row('Incident backlog'))
    await user.click(screen.getByRole('button', { name: '↓ CSV' }))
    const csv = await (createUrl.mock.calls[0]![0] as Blob).text()
    expect(csv.split('\r\n')).toEqual(['Rule,Note', 'a | b,"say ""hi"""', 'short,', 'x,y'])
  })
})
