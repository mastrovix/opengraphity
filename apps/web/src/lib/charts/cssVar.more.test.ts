/**
 * A CSS TOKEN READ OUTSIDE THE BROWSER.
 *
 * `cssVar` reads the charts' tokens from `:root`. Called where there is no
 * document (a server render, a worker), it must say so by name instead of
 * returning an empty value that ECharts would turn into a default colour or
 * font: a missing token is a configuration error, never a fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cssVar, resetCssVarCache } from './cssVar'

beforeEach(() => { resetCssVarCache() })
afterEach(() => { vi.unstubAllGlobals() })

describe('cssVar outside the browser', () => {
  it('throws, naming the token and why', () => {
    vi.stubGlobal('document', undefined)
    expect(() => cssVar('--color-brand')).toThrow('[cssVar] --color-brand: no document (called outside the browser)')
  })
})
