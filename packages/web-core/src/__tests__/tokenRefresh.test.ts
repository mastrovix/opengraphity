import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTokenRefresh, type KeycloakLike } from '../tokenRefresh.js'
import type { ClientLogger } from '../logger.js'

function makeKeycloak(overrides: Partial<KeycloakLike> = {}): KeycloakLike & { updateToken: ReturnType<typeof vi.fn>; login: ReturnType<typeof vi.fn> } {
  return {
    token: 'tok',
    updateToken: vi.fn(async () => true),
    login: vi.fn(async () => {}),
    ...overrides,
  } as KeycloakLike & { updateToken: ReturnType<typeof vi.fn>; login: ReturnType<typeof vi.fn> }
}

function makeNotify() {
  return { error: vi.fn(), success: vi.fn() }
}

const silentLogger: ClientLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }

async function flush(): Promise<void> {
  // let promise chains settle (finally + catch) without advancing timers
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('refreshToken', () => {
  it('shares one in-flight updateToken between concurrent callers', async () => {
    let resolve!: (v: boolean) => void
    const keycloak = makeKeycloak({
      updateToken: vi.fn(async () => true).mockImplementationOnce(() => new Promise<boolean>((r) => { resolve = r })),
    })
    const tr = createTokenRefresh({ keycloak, notify: makeNotify(), logger: silentLogger })

    const a = tr.refreshToken(-1)
    const b = tr.refreshToken(-1)
    expect(keycloak.updateToken).toHaveBeenCalledTimes(1)
    expect(keycloak.updateToken).toHaveBeenCalledWith(-1)
    resolve(true)
    await expect(a).resolves.toBe(true)
    await expect(b).resolves.toBe(true)

    // after settling, a new call starts a new round-trip
    await tr.refreshToken(30)
    expect(keycloak.updateToken).toHaveBeenCalledTimes(2)
  })
})

describe('isSessionInvalid / forceLogin', () => {
  it('isSessionInvalid reflects the presence of a token', () => {
    const keycloak = makeKeycloak()
    const tr = createTokenRefresh({ keycloak, notify: makeNotify(), logger: silentLogger })
    expect(tr.isSessionInvalid()).toBe(false)
    keycloak.token = undefined
    expect(tr.isSessionInvalid()).toBe(true)
  })

  it('forceLogin redirects once and notifies once even when called N times', () => {
    const keycloak = makeKeycloak()
    const notify = makeNotify()
    const tr = createTokenRefresh({ keycloak, notify, logger: silentLogger })
    tr.forceLogin(); tr.forceLogin(); tr.forceLogin()
    expect(keycloak.login).toHaveBeenCalledTimes(1)
    expect(notify.error).toHaveBeenCalledTimes(1)
    expect(notify.error).toHaveBeenCalledWith('Sessione scaduta — nuovo accesso necessario')
  })

  it('uses app-provided messages', () => {
    const keycloak = makeKeycloak()
    const notify = makeNotify()
    const tr = createTokenRefresh({ keycloak, notify, logger: silentLogger, messages: { sessionExpired: () => 'Session expired' } })
    tr.forceLogin()
    expect(notify.error).toHaveBeenCalledWith('Session expired')
  })
})

describe('startTokenRefreshLoop', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('installs onTokenExpired (forced refresh) and a safety interval (minValidity 60)', async () => {
    const keycloak = makeKeycloak()
    const tr = createTokenRefresh({ keycloak, notify: makeNotify(), logger: silentLogger, intervalMs: 30_000 })
    const stop = tr.startTokenRefreshLoop()

    expect(keycloak.onTokenExpired).toBeTypeOf('function')
    keycloak.onTokenExpired!()
    await flush()
    expect(keycloak.updateToken).toHaveBeenLastCalledWith(-1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(keycloak.updateToken).toHaveBeenLastCalledWith(60)
    expect(keycloak.updateToken).toHaveBeenCalledTimes(2)

    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(keycloak.updateToken).toHaveBeenCalledTimes(2)
    expect(keycloak.onTokenExpired).toBeUndefined()
  })

  it('transport error with a token still present: retries with backoff, notifies, never redirects; recovery notifies success', async () => {
    const keycloak = makeKeycloak({
      updateToken: vi.fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue(true),
    })
    const notify = makeNotify()
    const logger: ClientLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
    const tr = createTokenRefresh({ keycloak, notify, logger, backoffMs: [5_000, 10_000], intervalMs: 30_000 })
    tr.startTokenRefreshLoop()

    keycloak.onTokenExpired!()
    await flush()
    expect(keycloak.login).not.toHaveBeenCalled()
    expect(notify.error).toHaveBeenCalledTimes(1)
    expect(notify.error).toHaveBeenLastCalledWith(
      'Server di autenticazione non raggiungibile — nuovo tentativo tra 5s',
      { id: 'keycloak-refresh', duration: 5_000 },
    )
    expect(logger.warn).toHaveBeenCalledWith('Refresh token fallito (rete), nuovo tentativo', expect.objectContaining({ attempt: 1, delayMs: 5_000, message: 'ECONNREFUSED' }))

    // 2nd attempt after 5s fails again → next delay 10s (backoff)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(keycloak.updateToken).toHaveBeenCalledTimes(2)
    expect(notify.error).toHaveBeenLastCalledWith(expect.stringContaining('10s'), { id: 'keycloak-refresh', duration: 10_000 })

    // 3rd attempt succeeds → success notification, counters reset
    await vi.advanceTimersByTimeAsync(10_000)
    expect(keycloak.updateToken).toHaveBeenCalledTimes(3)
    expect(notify.success).toHaveBeenCalledWith('Connessione al server di autenticazione ripristinata', { id: 'keycloak-refresh' })
    expect(keycloak.login).not.toHaveBeenCalled()
  })

  it('the safety interval does not fire while a retry is pending', async () => {
    const keycloak = makeKeycloak({ updateToken: vi.fn().mockRejectedValue(new Error('down')) })
    const tr = createTokenRefresh({ keycloak, notify: makeNotify(), logger: silentLogger, backoffMs: [60_000], intervalMs: 30_000 })
    tr.startTokenRefreshLoop()
    keycloak.onTokenExpired!()
    await flush()
    expect(keycloak.updateToken).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)   // interval tick, retry still pending
    expect(keycloak.updateToken).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)   // 60s: retry fires
    expect(keycloak.updateToken).toHaveBeenCalledTimes(2)
  })

  it('refresh failure that cleared the token (HTTP 400) → forceLogin, loop stopped (no further refresh attempts)', async () => {
    const keycloak = makeKeycloak({
      updateToken: vi.fn(async function (this: KeycloakLike) { keycloak.token = undefined; throw new Error('Failed to refresh token') }),
    })
    const notify = makeNotify()
    const tr = createTokenRefresh({ keycloak, notify, logger: silentLogger })
    tr.startTokenRefreshLoop()
    keycloak.onTokenExpired!()
    await flush()
    expect(keycloak.login).toHaveBeenCalledTimes(1)
    expect(notify.error).toHaveBeenCalledWith('Sessione scaduta — nuovo accesso necessario')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(keycloak.updateToken).toHaveBeenCalledTimes(1)
  })
})
