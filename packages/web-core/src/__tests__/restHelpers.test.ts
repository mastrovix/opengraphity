/**
 * WHERE THE REST API IS, AND HOW THE BROWSER TALKS TO IT.
 *
 * The GraphQL endpoint is the only URL that is configured; every REST path
 * lives next to it. That matters because the API's auth middleware reads the
 * `Authorization` header and nothing else: neither an `<a href>` nor a native
 * form submit carries one, so uploads and downloads have to go through
 * `fetch` — which is why these helpers exist at all rather than being a link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiBaseFromGraphqlUri, createApiBase } from '../apiBase.js'
import { createClientLogger } from '../clientLogger.js'
import { createAttachments } from '../attachments.js'
import { consoleLogger } from '../logger.js'

describe('apiBaseFromGraphqlUri', () => {
  it.each([
    ['/graphql',                     ''],
    ['/graphql/',                    ''],
    ['https://api.example.com/graphql',  'https://api.example.com'],
    ['https://api.example.com/graphql/', 'https://api.example.com'],
    ['https://api.example.com/',     'https://api.example.com'],
  ])('%s → "%s"', (uri, base) => {
    expect(apiBaseFromGraphqlUri(uri)).toBe(base)
  })

  it('a same-origin setup gives an empty base, so REST paths stay relative', () => {
    // Not '/': `'' + '/api/x'` is `/api/x`, while `'/' + '/api/x'` is `//api/x`,
    // which a browser reads as a protocol-relative URL to host "api".
    expect(createApiBase({ baseUrl: apiBaseFromGraphqlUri('/graphql'), getToken: () => undefined }).apiUrl('/api/x'))
      .toBe('/api/x')
  })
})

describe('createApiBase', () => {
  const api = (token?: string) => createApiBase({ baseUrl: 'https://api.example.com/', getToken: () => token })

  it('drops a trailing slash from the base and builds paths next to it', () => {
    expect(api().baseUrl).toBe('https://api.example.com')
    expect(api().apiUrl('/api/attachments')).toBe('https://api.example.com/api/attachments')
  })

  it('a path without a leading slash is refused, naming what was passed', () => {
    // `base + 'api/x'` silently produces `https://api.example.comapi/x`.
    expect(() => api().apiUrl('api/x')).toThrow('apiUrl: the path must start with "/" (got "api/x")')
    expect(() => api().apiUrl('')).toThrow(/must start with/)
  })

  it('the token is read at every call, never captured once', () => {
    // It is refreshed while the app runs: a captured one would go stale and
    // every REST call would start failing with 401 until a reload.
    let token: string | undefined
    const a = createApiBase({ baseUrl: '', getToken: () => token })
    expect(a.authHeader()).toEqual({})
    token = 'tok-1'
    expect(a.authHeader()).toEqual({ authorization: 'Bearer tok-1' })
    token = 'tok-2'
    expect(a.authHeader()).toEqual({ authorization: 'Bearer tok-2' })
  })

  it('no token means no header at all, not an empty bearer', () => {
    for (const empty of [undefined, '']) {
      expect(createApiBase({ baseUrl: '', getToken: () => empty }).authHeader()).toEqual({})
    }
  })
})

describe('consoleLogger', () => {
  it('passes the data through, and an empty string when there is none', () => {
    const spies = {
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn:  vi.spyOn(console, 'warn').mockImplementation(() => {}),
      info:  vi.spyOn(console, 'info').mockImplementation(() => {}),
    }
    consoleLogger.error('boom', { id: 1 })
    consoleLogger.warn('careful')
    consoleLogger.info('fyi')
    expect(spies.error).toHaveBeenCalledWith('boom', { id: 1 })
    expect(spies.warn).toHaveBeenCalledWith('careful', '')
    expect(spies.info).toHaveBeenCalledWith('fyi', '')
    for (const s of Object.values(spies)) s.mockRestore()
  })
})

describe('createClientLogger — logs that reach the server', () => {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
  const api = createApiBase({ baseUrl: '', getToken: () => 'tok' })

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' } as Response)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.history.replaceState({}, '', '/incidents/inc-1')
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('posts level, message, data, the page and a timestamp, with the bearer', async () => {
    createClientLogger(api).error('render failed', { component: 'TicketList' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/logs/client')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toMatchObject({ level: 'error', message: 'render failed', data: { component: 'TicketList' }, url: '/incidents/inc-1' })
    expect(new Date(body['timestamp'] as string).getTime()).not.toBeNaN()
  })

  it('warn and info carry their own level', async () => {
    const log = createClientLogger(api)
    log.warn('slow query')
    log.info('mounted')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls.map((c) => (JSON.parse(c[1].body as string) as { level: string }).level)).toEqual(['warn', 'info'])
  })

  it('a rejected delivery is reported but NEVER thrown: a broken logger would hide the real error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' } as Response)
    expect(() => createClientLogger(api).error('boom')).not.toThrow()
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(
      '[clientLogger] sending logs failed: 503 Service Unavailable', 'boom'))
  })

  it('a network failure is reported the same way, and the call still returns nothing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(createClientLogger(api).info('hello')).toBeUndefined()
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(
      '[clientLogger] sending logs failed', expect.any(Error), 'hello'))
  })
})

describe('createAttachments', () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
  const api = createApiBase({ baseUrl: '', getToken: () => 'tok' })
  const file = () => new File(['x'], 'report.pdf', { type: 'application/pdf' })
  const res = (over: Partial<Response> & { json?: () => Promise<unknown> } = {}) =>
    ({ ok: true, status: 200, statusText: 'OK', json: async () => ({}), blob: async () => new Blob(['x']), ...over }) as unknown as Response

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(res())
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
    }))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('uploads with the bearer, and the entity fields BEFORE the file', async () => {
    // busboy reads fields in stream order and the backend uses entityId to
    // build the storage path: a file arriving first has nowhere to go.
    await createAttachments(api).uploadAttachment('incident', 'inc-1', file())
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/attachments')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>)['authorization']).toBe('Bearer tok')
    expect([...(init!.body as FormData).keys()]).toEqual(['entityType', 'entityId', 'file'])
  })

  it('a draft upload names the draft and the FIELD the file answers', async () => {
    // The file goes onto a draft id, not onto a ticket that does not exist
    // yet; on creation the files move from the draft to the ticket.
    fetchMock.mockResolvedValueOnce(res({ json: async () => ({ id: 'att-1', filename: 'report.pdf', sizeBytes: 12 }) }))
    const out = await createAttachments(api).uploadFormDraftFile('draft-1', 'allegato', file())
    expect(out).toEqual({ id: 'att-1', filename: 'report.pdf', sizeBytes: 12 })
    const body = fetchMock.mock.calls[0]![1]!.body as FormData
    expect([...body.keys()]).toEqual(['entityType', 'entityId', 'fieldName', 'file'])
    expect(body.get('entityType')).toBe('form_draft')
    expect(body.get('entityId')).toBe('draft-1')
  })

  it('a draft upload that returns no id fails: without it the file cannot be removed before sending', async () => {
    fetchMock.mockResolvedValueOnce(res({ json: async () => ({ filename: 'report.pdf' }) }))
    await expect(createAttachments(api).uploadFormDraftFile('draft-1', 'allegato', file()))
      .rejects.toThrow('The upload did not return the file id')
  })

  it('a draft upload falls back to the local file name and size when the server omits them', async () => {
    fetchMock.mockResolvedValueOnce(res({ json: async () => ({ id: 'att-1' }) }))
    const f = file()
    expect(await createAttachments(api).uploadFormDraftFile('d', 'a', f)).toEqual({ id: 'att-1', filename: f.name, sizeBytes: f.size })
  })

  it('a refusal surfaces the server\'s own message, and falls back to the status when there is none', async () => {
    fetchMock.mockResolvedValueOnce(res({ ok: false, status: 413, statusText: 'Payload Too Large', json: async () => ({ error: 'File too large (max 10MB)' }) }))
    await expect(createAttachments(api).uploadAttachment('incident', 'inc-1', file())).rejects.toThrow('File too large (max 10MB)')

    fetchMock.mockResolvedValueOnce(res({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => { throw new Error('not json') } }))
    await expect(createAttachments(api).uploadAttachment('incident', 'inc-1', file())).rejects.toThrow('500 Internal Server Error')

    fetchMock.mockResolvedValueOnce(res({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: '' }) }))
    await expect(createAttachments(api).uploadAttachment('incident', 'inc-1', file())).rejects.toThrow('400 Bad Request')
  })

  it('a download fetches with the bearer and saves under the given name', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await createAttachments(api).downloadAttachment('/api/attachments/att-1/download', 'rapporto.pdf')
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['authorization']).toBe('Bearer tok')
    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
  })

  it('the object URL is revoked LATER, not right after the click (E-42)', async () => {
    // A synchronous revoke after `click()` cancels the download that just
    // started on Firefox and Safari: from the portal, sometimes, the file
    // simply never arrived.
    document.body.replaceChildren()
    vi.useFakeTimers()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await createAttachments(api).downloadAttachment('/x', 'f.pdf')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(document.querySelectorAll('a[download]')).toHaveLength(1)
    vi.advanceTimersByTime(60_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake')
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)   // and the link is gone
  })

  it('a refused download throws and downloads nothing', async () => {
    fetchMock.mockResolvedValueOnce(res({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: 'Not your attachment' }) }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await expect(createAttachments(api).downloadAttachment('/x', 'f.pdf')).rejects.toThrow('Not your attachment')
    expect(click).not.toHaveBeenCalled()
    click.mockRestore()
  })
})
