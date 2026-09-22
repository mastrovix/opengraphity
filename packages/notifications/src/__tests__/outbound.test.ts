/**
 * SLACK AND TEAMS: a lost notification must FAIL, never return false.
 *
 * These three functions are the last step before a message leaves the
 * product. Every one of them throws on failure — network error, non-2xx,
 * Slack answering `ok: false`, missing configuration, an unsafe URL — because
 * the caller is a BullMQ job: a thrown error is a retry, a returned `false`
 * is a notification nobody ever sees and nobody ever hears about.
 *
 * The webhook URL is typed by a customer administrator, so it goes through
 * the real SSRF guard, not a faked one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const state = vi.hoisted(() => ({ token: 'xoxb-workspace-token' as string | Error, locale: { language: 'it', timeZone: 'Europe/Rome' } }))

vi.mock('../slackInstallation.js', () => ({
  slackBotToken: async () => { if (state.token instanceof Error) throw state.token; return state.token },
}))
vi.mock('../locale.js', () => ({ loadNotificationLocale: async () => state.locale }))

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
vi.stubGlobal('fetch', fetchMock)

const { sendSlackMessage, sendTeamsAdaptiveMessage, sendTestMessage } = await import('../index.js')

const ok = (body: unknown = { ok: true }) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const notOk = (status: number) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response

/** A literal public IP: the SSRF guard needs no DNS for it. */
const HOOK = 'https://93.184.216.34/services/T00/B00/xxx'
const BLOCKS = [{ type: 'section', text: { type: 'mrkdwn', text: 'INC-1' } }]
const CARD = { type: 'AdaptiveCard', version: '1.4', body: [] }

const originalEnv = process.env['NODE_ENV']
beforeEach(() => {
  process.env['NODE_ENV'] = 'production'
  state.token = 'xoxb-workspace-token'
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(ok())
})
afterEach(() => { process.env['NODE_ENV'] = originalEnv })

describe('sendSlackMessage — by incoming webhook', () => {
  it('POSTs the blocks to the configured URL, with an abort signal', async () => {
    expect(await sendSlackMessage('c-one', HOOK, null, BLOCKS)).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(HOOK)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ blocks: BLOCKS }))
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a non-2xx THROWS naming the status', async () => {
    fetchMock.mockResolvedValueOnce(notOk(404))
    await expect(sendSlackMessage('c-one', HOOK, null, BLOCKS)).rejects.toThrow('Slack webhook rejected the message: HTTP 404')
  })

  it('a webhook URL pointing inside our own network is refused before any fetch', async () => {
    await expect(sendSlackMessage('c-one', 'https://169.254.169.254/x', null, BLOCKS)).rejects.toThrow(/SSRF/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendSlackMessage — by the organization bot', () => {
  it('posts to chat.postMessage with the ORGANIZATION token, not a platform-wide one', async () => {
    // Before wave 8 there was a single platform token: every organization's
    // messages left from the same bot.
    expect(await sendSlackMessage('c-one', null, 'C123', BLOCKS)).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer xoxb-workspace-token')
    expect(init.body).toBe(JSON.stringify({ channel: 'C123', blocks: BLOCKS }))
  })

  it('an HTTP failure and a Slack `ok: false` both throw, and the second carries Slack\'s reason', async () => {
    // Slack answers 200 with `ok:false` for channel_not_found and friends:
    // trusting the status code alone would report a delivered message.
    fetchMock.mockResolvedValueOnce(notOk(500))
    await expect(sendSlackMessage('c-one', null, 'C123', BLOCKS)).rejects.toThrow('Slack API error: HTTP 500')

    fetchMock.mockResolvedValueOnce(ok({ ok: false, error: 'channel_not_found' }))
    await expect(sendSlackMessage('c-one', null, 'C123', BLOCKS)).rejects.toThrow('Slack API refused the message: channel_not_found')

    fetchMock.mockResolvedValueOnce(ok({ ok: false }))
    await expect(sendSlackMessage('c-one', null, 'C123', BLOCKS)).rejects.toThrow('Slack API refused the message: unknown error')
  })

  it('an organization with no Slack connected surfaces that error, it does not send', async () => {
    state.token = new Error('Slack is not connected for organization c-one')
    await expect(sendSlackMessage('c-one', null, 'C123', BLOCKS)).rejects.toThrow('Slack is not connected')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a channel with neither a webhook nor a channel id is a configuration error', async () => {
    await expect(sendSlackMessage('c-one', null, null, BLOCKS))
      .rejects.toThrow('sendSlackMessage: neither webhookUrl nor channelId configured')
  })

  it('the webhook wins when both are configured: it is the more specific choice', async () => {
    await sendSlackMessage('c-one', HOOK, 'C123', BLOCKS)
    expect(fetchMock.mock.calls[0]![0]).toBe(HOOK)
  })
})

describe('sendTeamsAdaptiveMessage', () => {
  it('wraps the card in the message envelope Teams expects', async () => {
    expect(await sendTeamsAdaptiveMessage(HOOK, CARD)).toBe(true)
    const body = JSON.parse((fetchMock.mock.calls[0]![1].body as string)) as {
      type: string; attachments: Array<{ contentType: string; content: unknown }>
    }
    expect(body.type).toBe('message')
    expect(body.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(body.attachments[0]!.content).toEqual(CARD)
  })

  it('a non-2xx throws naming the status', async () => {
    fetchMock.mockResolvedValueOnce(notOk(413))
    await expect(sendTeamsAdaptiveMessage(HOOK, CARD)).rejects.toThrow('Teams webhook rejected the message: HTTP 413')
  })

  it('an unsafe webhook URL is refused before any fetch', async () => {
    await expect(sendTeamsAdaptiveMessage('http://localhost:8080/hook', CARD)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendTestMessage — "is this channel really connected?"', () => {
  const channel = (over: Record<string, unknown> = {}) => ({
    id: 'ch-1', platform: 'slack', name: 'Incidenti', webhookUrl: HOOK, channelId: null,
    eventTypes: ['incident.created'], active: true, createdAt: 'x', ...over,
  })

  it('the Slack test message is in the CUSTOMER\'s language and names the channel', async () => {
    // The administrator pressing "Send test" reads it: the product language
    // of the organization, not the server's.
    await sendTestMessage(channel(), 'c-one')
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { blocks: Array<{ text: { text: string } }> }
    expect(body.blocks[0]!.text.text).toContain('Incidenti')
  })

  it('the Teams test message is an adaptive card with a title and a body', async () => {
    await sendTestMessage(channel({ platform: 'teams' }), 'c-one')
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      attachments: Array<{ content: { body: Array<{ text: string }> } }>
    }
    expect(body.attachments[0]!.content.body).toHaveLength(2)
    expect(body.attachments[0]!.content.body[0]!.text).toContain('Incidenti')
  })

  it('a platform the product does not know is an error naming it', async () => {
    await expect(sendTestMessage(channel({ platform: 'discord' }), 'c-one'))
      .rejects.toThrow('sendTestMessage: unsupported platform "discord"')
  })
})
