/**
 * lib/pageErrorReport.ts — page errors and uncaught errors reach the server
 * log (review of 23 Sep 2026); an unknown address does not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logged = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('./clientLogger', () => ({ clientLogger: { error: logged.error } }))

const { reportRouteError, listenForUncaughtErrors } = await import('./pageErrorReport')

beforeEach(() => { logged.error.mockClear() })

describe('reportRouteError', () => {
  it('a thrown error is reported with its message, the page and its stack', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'id')")
    reportRouteError(err, '/incidents/7')
    expect(logged.error).toHaveBeenCalledWith("Route error: Cannot read properties of undefined (reading 'id')", { path: '/incidents/7', stack: err.stack!.slice(0, 500) })
  })

  it('a 404 is an address nobody has, not a broken page', () => {
    reportRouteError({ status: 404, statusText: 'Not Found', internal: true, data: '' }, '/nope')
    expect(logged.error).not.toHaveBeenCalled()
  })
})

describe('listenForUncaughtErrors', () => {
  it('an uncaught error and an unhandled rejection are reported; stopping removes both listeners', () => {
    // A plain target standing for the window: jsdom would report an error event on the real one as a test failure.
    const target = Object.assign(new EventTarget(), { location: { pathname: '/changes/3' } }) as unknown as Window
    const stop = listenForUncaughtErrors(target)
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('handler exploded'), message: 'handler exploded' }))
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown }
    rejection.reason = new Error('nobody awaited me')
    target.dispatchEvent(rejection)
    expect(logged.error.mock.calls.map((c) => c[0])).toEqual(['Uncaught error: handler exploded', 'Unhandled rejection: nobody awaited me'])
    expect(logged.error.mock.calls[0]![1]).toMatchObject({ path: '/changes/3' })
    stop()
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('after stop') }))
    expect(logged.error).toHaveBeenCalledTimes(2)
  })
})
