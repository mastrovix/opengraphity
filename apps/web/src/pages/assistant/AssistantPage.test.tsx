/**
 * THE AI ASSISTANT: a chat grounded on the tenant's graph.
 *
 * A question is POSTed with the whole conversation to `/api/assistant/stream`
 * and the answer comes back as Server-Sent Events: `tool` while the assistant
 * reads the graph, `text` pieces while it writes, then `done` or `error`.
 *
 * The page promises to tell the truth about what happened, and that is what
 * these tests pin: the tools in use are shown while they run, a server error
 * or a broken connection is shown in the chat with its real message, a stream
 * that stops early is called incomplete instead of passing for an answer, a
 * frame cut in two by the network is put back together, an unreadable frame
 * does not kill the whole answer (F-18), and the next question carries the
 * conversation so far — but never the error messages, which the model must not
 * mistake for its own words. When the organization turned the assistant off,
 * the page says so and offers no chat.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, act } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { AssistantPage } from './AssistantPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

/** A response body whose chunks the test hands over one at a time. */
function sseStream() {
  const encoder = new TextEncoder()
  type Chunk = { done: boolean; value?: Uint8Array } | { failure: unknown }
  const chunks: Chunk[] = []
  let wake: (() => void) | null = null
  const state = { failed: false }
  const read = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
    while (chunks.length === 0) await new Promise<void>((resolve) => { wake = resolve })
    const next = chunks.shift()!
    if ('failure' in next) { state.failed = true; throw next.failure }
    return next
  }
  const put = (c: Chunk) => { chunks.push(c); wake?.(); wake = null }
  return {
    body: { getReader: () => ({ read }) },
    push: (text: string) => put({ done: false, value: encoder.encode(text) }),
    end: () => put({ done: true }),
    fail: (failure: unknown) => put({ failure }),
    state,
  }
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

type FetchInit = { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
let fetchMock: ReturnType<typeof vi.fn>

/** `fetch` answers each call with the next stream (or response) in the list. */
function answerWith(...responses: Array<ReturnType<typeof sseStream> | { ok: boolean; status: number; body: unknown } | Error | string>) {
  fetchMock.mockImplementation(async (_url: string, init: FetchInit) => {
    const r = responses.shift()
    if (r instanceof Error || typeof r === 'string') throw r
    if (r && 'push' in r) {
      init.signal.addEventListener('abort', () => r.fail(new DOMException('The operation was aborted.', 'AbortError')))
      return { ok: true, status: 200, body: r.body }
    }
    return r
  })
}

/** A complete answer, all in one go. */
function answered(...frames: string[]) {
  const s = sseStream()
  for (const f of frames) s.push(f)
  s.end()
  return s
}

const sentMessages = (call = -1) => (JSON.parse((fetchMock.mock.calls.at(call)![1] as FetchInit).body) as { messages: unknown[] }).messages

const box = () => screen.getByRole('textbox', { name: 'Ask something about your environment...' })
const sendButton = () => screen.getByRole('button', { name: 'Send' })

async function ask(user: ReturnType<typeof renderWithProviders>['user'], question: string) {
  await user.type(box(), question)
  await user.click(sendButton())
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { assistant: true } } }
  apolloFinto.risposte['GetMe'] = { me: { id: 'u-1', name: 'Tester', permissions: [], teams: [] } }
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { vi.unstubAllGlobals() })

describe('whether there is a chat at all', () => {
  it('an assistant the organization turned off is announced, with no chat', () => {
    apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { assistant: false } } }
    renderWithProviders(<AssistantPage />)
    expect(screen.getByRole('status')).toHaveTextContent('«AI assistant» is turned off for your organization. An administrator can turn it on.')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('until the setting is known it shows neither the chat nor the notice', () => {
    delete apolloFinto.risposte['GetAISettings']
    renderWithProviders(<AssistantPage />)
    expect(screen.getByRole('heading', { name: 'AI Assistant' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('asking', () => {
  it('an empty chat introduces the assistant; a suggested question is asked as it reads, with the bearer token', async () => {
    answerWith(answered(frame('done', { text: 'CHG-1 touches db-01.' })))
    const { user } = renderWithProviders(<AssistantPage />)
    expect(screen.getByText(/Ask something about your environment: incidents, CIs/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Which changes are in flight and which CIs do they touch?' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as [string, FetchInit]
    expect(url).toBe('/api/assistant/stream')
    expect(init.method).toBe('POST')
    // Header names are case-insensitive: compare them as HTTP does.
    const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]))
    expect(headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer test-token' })
    expect(sentMessages()).toEqual([{ role: 'user', content: 'Which changes are in flight and which CIs do they touch?' }])
    expect(await screen.findByText('CHG-1 touches db-01.')).toBeInTheDocument()
    expect(screen.getByText('Which changes are in flight and which CIs do they touch?')).toBeInTheDocument()
    // The suggestions belong to an empty chat.
    expect(screen.queryByRole('button', { name: 'If I shut down SRV-009, what do I impact?' })).toBeNull()
  })

  it('Enter sends and clears the box; Shift+Enter does not send; a blank question is never sent', async () => {
    answerWith(answered(frame('done', { text: 'ok' })))
    const { user } = renderWithProviders(<AssistantPage />)
    await user.type(box(), '   ')
    expect(sendButton()).toBeDisabled()
    await user.type(box(), '{Enter}')
    expect(fetchMock).not.toHaveBeenCalled()
    await user.clear(box())
    await user.type(box(), 'Which CIs are down?{Shift>}{Enter}{/Shift}')
    expect(fetchMock).not.toHaveBeenCalled()
    await user.type(box(), '{Enter}')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sentMessages()).toEqual([{ role: 'user', content: 'Which CIs are down?' }])
    expect(box()).toHaveValue('')
    expect(await screen.findByText('ok')).toBeInTheDocument()
  })

  it('shows the tools at work and the text as it arrives, and locks the input until the answer is complete', async () => {
    const s = sseStream()
    answerWith(s)
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'What breaks if SRV-009 stops?')
    expect(await screen.findByText('Looking through the graph…')).toBeInTheDocument()
    expect(box()).toBeDisabled()
    expect(sendButton()).toBeDisabled()

    await act(async () => { s.push(frame('tool', { name: 'cerca_ci' })) })
    expect(await screen.findByText('CI search')).toBeInTheDocument()
    // A tool the client has no name for shows its identifier instead of disappearing.
    await act(async () => { s.push(frame('tool', { name: 'nuovo_strumento' })) })
    expect(await screen.findByText('nuovo_strumento')).toBeInTheDocument()

    await act(async () => { s.push(frame('text', { delta: 'Three services ' })) })
    expect(await screen.findByText('Three services')).toBeInTheDocument()
    expect(screen.queryByText('Looking through the graph…')).toBeNull()

    await act(async () => { s.push(frame('done', { text: 'Three services depend on SRV-009.' })); s.end() })
    expect(await screen.findByText('Three services depend on SRV-009.')).toBeInTheDocument()
    await waitFor(() => expect(box()).toBeEnabled())
    expect(screen.queryByText('CI search')).toBeNull()
  })

  it('a final event without text keeps the text that was streamed', async () => {
    answerWith(answered(frame('text', { delta: 'Two open ' }), frame('text', { delta: 'incidents.' }), frame('done', {})))
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'How many incidents are open?')
    expect(await screen.findByText('Two open incidents.')).toBeInTheDocument()
  })

  it('a frame cut in two by the network is put back together, and the last frame counts even without a blank line after it', async () => {
    const s = sseStream()
    s.push('event: text\ndata: {"del')
    s.push('ta":"Hello "}\n\nevent: text\ndata: {"delta":"there"}\n\n')
    s.push('event: done\ndata: {}')
    s.end()
    answerWith(s)
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'Hi')
    expect(await screen.findByText('Hello there')).toBeInTheDocument()
  })

  it('an unreadable frame is skipped and the answer goes on (F-18)', async () => {
    answerWith(answered(
      frame('text', { delta: 'First part, ' }),
      'event: text\ndata: {not json\n\n',
      // A frame with nothing useful in it changes nothing either, nor does a keep-alive.
      'event: tool\ndata: {}\n\n',
      'event: ping\ndata: {}\n\n',
      ': a comment line\n\n',
      '\n\n',
      frame('text', { delta: 'second part.' }),
      frame('done', {}),
    ))
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'Tell me')
    expect(await screen.findByText('First part, second part.')).toBeInTheDocument()
    expect(screen.queryByText(/^Error:/)).toBeNull()
  })
})

describe('telling the truth when it goes wrong', () => {
  it('an error from the server is shown in the chat with its message', async () => {
    answerWith(answered(frame('text', { delta: 'Partial' }), frame('error', { message: 'the model is overloaded' })))
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'Anything?')
    expect(await screen.findByText('Error: the model is overloaded')).toBeInTheDocument()
  })

  it('an error without a message still says there was an error', async () => {
    answerWith(answered(frame('error', {})))
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'Anything?')
    expect(await screen.findByText('Error: unknown')).toBeInTheDocument()
  })

  it('an answer that stops without its final event is called incomplete, not passed off as complete', async () => {
    answerWith(answered(frame('text', { delta: 'The impact is' })))
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'Impact?')
    expect(await screen.findByText('Error: the answer stopped before it was complete.')).toBeInTheDocument()
  })

  it('an HTTP failure is shown with its status, and so is a response with no body', async () => {
    answerWith({ ok: false, status: 502, body: null }, { ok: true, status: 204, body: null })
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'First')
    expect(await screen.findByText('Error: HTTP 502')).toBeInTheDocument()
    await ask(user, 'Second')
    expect(await screen.findByText('Error: HTTP 204')).toBeInTheDocument()
  })

  it('a connection that fails is shown with its message, whatever was thrown', async () => {
    answerWith(new TypeError('Failed to fetch'), 'offline')
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'First')
    expect(await screen.findByText('Error: Failed to fetch')).toBeInTheDocument()
    await ask(user, 'Second')
    expect(await screen.findByText('Error: offline')).toBeInTheDocument()
  })
})

describe('the conversation', () => {
  it('each question carries the conversation so far, without the error messages', async () => {
    answerWith(
      answered(frame('done', { text: 'Five incidents.' })),
      answered(frame('error', { message: 'timeout' })),
      answered(frame('done', { text: 'Two of them.' })),
    )
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'How many incidents?')
    await screen.findByText('Five incidents.')
    await ask(user, 'Which are critical?')
    await screen.findByText('Error: timeout')
    await ask(user, 'And now?')
    await screen.findByText('Two of them.')
    expect(sentMessages()).toEqual([
      { role: 'user', content: 'How many incidents?' },
      { role: 'assistant', content: 'Five incidents.' },
      { role: 'user', content: 'Which are critical?' },
      { role: 'user', content: 'And now?' },
    ])
  })

  it('«New conversation» starts over, and cannot be used while an answer is arriving', async () => {
    const s = sseStream()
    answerWith(answered(frame('done', { text: 'First answer.' })), s)
    const { user } = renderWithProviders(<AssistantPage />)
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull()
    await ask(user, 'First question')
    await screen.findByText('First answer.')
    await ask(user, 'Second question')
    expect(await screen.findByRole('button', { name: 'New conversation' })).toBeDisabled()
    await act(async () => { s.push(frame('done', { text: 'Second answer.' })); s.end() })
    await screen.findByText('Second answer.')
    await user.click(screen.getByRole('button', { name: 'New conversation' }))
    expect(screen.queryByText('First answer.')).toBeNull()
    expect(screen.queryByText('Second answer.')).toBeNull()
    // Back to the empty chat, suggestions included.
    expect(screen.getByRole('button', { name: 'Which server do the most services depend on, and what would shutting it down impact?' })).toBeInTheDocument()
  })

  it('the answer is markdown and is drawn as such: bold, tables; the question stays as typed (G11)', async () => {
    answerWith(answered(frame('done', { text: 'There are **284** open changes.\n\n| Step | Count |\n|---|---|\n| Approval | 12 |' })))
    const { user } = renderWithProviders(<AssistantPage />)
    await ask(user, 'How many **changes**?')
    expect((await screen.findByText('284')).tagName).toBe('STRONG')
    expect(screen.getByRole('table')).toHaveTextContent('Approval12')
    expect(screen.queryByText(/\|---\|/)).toBeNull()
    // What the person typed is not interpreted.
    expect(screen.getByText('How many **changes**?')).toBeInTheDocument()
  })

  it('the chat scrolls to the newest message', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    answerWith(answered(frame('done', { text: 'Done.' })))
    const { user } = renderWithProviders(<AssistantPage />)
    scroll.mockClear()
    await ask(user, 'Go')
    await screen.findByText('Done.')
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth' })
  })

  it('leaving the page while an answer arrives stops the request, and no error is reported for it', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const s = sseStream()
    answerWith(s)
    const { user, unmount } = renderWithProviders(<AssistantPage />)
    await ask(user, 'A long question')
    await screen.findByText('Looking through the graph…')
    const signal = (fetchMock.mock.calls[0]![1] as FetchInit).signal
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
    // The aborted read fails as a browser's does; the page must let it end quietly.
    await waitFor(() => expect(s.state.failed).toBe(true))
    await act(async () => { await Promise.resolve() })
    expect(consoleError).not.toHaveBeenCalled()
  })
})
