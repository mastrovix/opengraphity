/**
 * OUTGOING WEBHOOKS: the signature, the SSRF guard, and failing loudly.
 *
 * A subscriber URL is typed by a customer administrator, so it goes through
 * the shared SSRF guard before any fetch — the guard is NOT faked here, this
 * is the place where the two pieces meet.
 *
 * And the delivery fails loudly: "Dispatched — HTTP 500" logged as a success
 * was a lost event with a green checkmark next to it. A non-2xx must reach
 * the calling job so it can retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { dispatchWebhook, type WebhookSubscription } from '../webhook.js'

type FetchInit = { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
const fetchMock = vi.fn<(url: string, init: FetchInit) => Promise<{ ok: boolean; status: number }>>(
  async () => ({ ok: true, status: 200 }),
)
vi.stubGlobal('fetch', fetchMock)

/** A literal public IP: the guard needs no DNS for it. */
const PUBLIC = 'https://93.184.216.34/hooks/og'
const sub = (over: Partial<WebhookSubscription> = {}): WebhookSubscription =>
  ({ id: 'sub-1', tenantId: 't1', event: 'incident.created', url: PUBLIC, ...over })

const originalEnv = process.env['NODE_ENV']
beforeEach(() => {
  process.env['NODE_ENV'] = 'production'
  fetchMock.mockClear()
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { process.env['NODE_ENV'] = originalEnv })

describe('dispatchWebhook', () => {
  it('POSTs the JSON payload with an abort signal, and no signature when there is no secret', async () => {
    await dispatchWebhook(sub(), { id: 'inc-1', title: 'DB down' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(PUBLIC)
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"id":"inc-1","title":"DB down"}')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('with a secret it signs the EXACT body sent, HMAC-SHA256, prefixed sha256=', async () => {
    // The subscriber recomputes the HMAC over the bytes it received: signing
    // anything other than the body actually sent makes every delivery look
    // forged to a correctly implemented receiver.
    const payload = { id: 'inc-1', nested: { a: 1 } }
    await dispatchWebhook(sub({ secret: 'shared-secret' }), payload)
    const [, init] = fetchMock.mock.calls[0]!
    const expected = createHmac('sha256', 'shared-secret').update(init.body).digest('hex')
    expect(init.headers['X-OpenGraphity-Signature']).toBe(`sha256=${expected}`)
    expect(init.body).toBe(JSON.stringify(payload))
  })

  it('the secret itself never leaves in a header or in the body', () => {
    return dispatchWebhook(sub({ secret: 'shared-secret' }), { x: 1 }).then(() => {
      const [, init] = fetchMock.mock.calls[0]!
      expect(JSON.stringify(init.headers)).not.toContain('shared-secret')
      expect(init.body).not.toContain('shared-secret')
    })
  })

  it('a non-2xx response THROWS, naming subscription, host and status — and never the full URL', async () => {
    // Slack- and Teams-style URLs carry a token in the path: the log line
    // gets the host only.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    const err = await dispatchWebhook(sub({ url: 'https://93.184.216.34/services/T00/B00/SECRETTOKEN' }), { x: 1 })
      .then(() => null, (e: Error) => e)
    expect(err?.message).toContain('subscriptionId=sub-1')
    expect(err?.message).toContain('host=93.184.216.34')
    expect(err?.message).toContain('event=incident.created')
    expect(err?.message).toContain('HTTP 500')
    expect(err?.message).not.toContain('SECRETTOKEN')
  })

  it('a network failure propagates: the calling job must fail and retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(dispatchWebhook(sub(), { x: 1 })).rejects.toThrow('ECONNRESET')
  })

  it.each([
    ['https://127.0.0.1/hook',       'loopback'],
    ['https://169.254.169.254/x',    'the cloud metadata service'],
    ['https://10.0.0.5/x',           'a private address'],
    ['https://localhost/x',          'localhost by name'],
    ['file:///etc/passwd',           'a scheme that is not http'],
    ['http://93.184.216.34/x',       'plain http outside development'],
    ['https://user:pw@93.184.216.34/x', 'credentials in the URL'],
  ])('%s is refused before any fetch (%s)', async (url) => {
    await expect(dispatchWebhook(sub({ url }), { x: 1 })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a refused URL is a configuration error, not a quietly skipped delivery', async () => {
    // Swallowing it would leave the administrator with a subscription that
    // looks connected and never delivers anything.
    const err = await dispatchWebhook(sub({ url: 'https://127.0.0.1/hook' }), { x: 1 }).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('UNSAFE_URL')
  })
})
