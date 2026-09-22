/**
 * The customer's default language (Tenant.default_language) and the viewer's.
 *
 * Why these behaviours matter:
 *  - "not configured" must stay distinguishable from "chose English": the
 *    diagnostics warn the admin only in the first case;
 *  - a value that is not a product language must never be applied (a page in a
 *    non-existent language) and must never be swallowed silently: it is logged;
 *  - a person's own choice (Profile) wins over the organisation's default, but
 *    only when it is a real product language;
 *  - the read is cached (it runs on every label resolution) and a write must
 *    drop the cache here, in every other process, and in the notification locale
 *    cache, otherwise e-mails keep going out in the old language.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
const runQueryOne = vi.fn()
const close = vi.fn(async () => undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close }),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
const invalidateSchema = vi.fn()
const clearers: Array<{ one: (t: string) => void; all?: () => void }> = []
vi.mock('../schemaInvalidator.js', () => ({
  registerMetamodelCacheClearer: (_n: string, one: (t: string) => void, all?: () => void) => { clearers.push({ one, all }) },
  invalidateSchema: (t: string) => invalidateSchema(t),
}))
const logError = vi.fn()
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: logError, debug: vi.fn() }) } }))
const invalidateNotificationLocale = vi.fn()
vi.mock('@opengraphity/notifications', () => ({ invalidateNotificationLocale: (t: string) => invalidateNotificationLocale(t) }))

const {
  viewerLanguage, isLingua, tenantDefaultLanguage, languageFor, languageForUser,
  setTenantDefaultLanguage, invalidateTenantLanguageCache, LINGUA_DI_ULTIMA_ISTANZA,
} = await import('../tenantLanguage.js')

const errKey = (e: unknown) => (e as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key
const catchErr = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection') }, (e: unknown) => e)

beforeEach(() => {
  runQuery.mockReset()
  runQueryOne.mockReset()
  close.mockClear()
  logError.mockClear()
  invalidateSchema.mockClear()
  invalidateNotificationLocale.mockClear()
  invalidateTenantLanguageCache()
})

describe('viewerLanguage / isLingua', () => {
  it('empty or absent → undefined (use the organisation\'s language)', () => {
    expect(viewerLanguage(undefined)).toBeUndefined()
    expect(viewerLanguage(null)).toBeUndefined()
    expect(viewerLanguage('')).toBeUndefined()
  })

  it('a product language passes through', () => {
    expect(viewerLanguage('it')).toBe('it')
    expect(viewerLanguage('en')).toBe('en')
  })

  it('an unknown language is an error, not a silent fallback', () => {
    let err: unknown
    try { viewerLanguage('fr') } catch (e) { err = e }
    expect(errKey(err)).toBe('errors.enum.unknownLanguage')
    expect((err as Error).message).toContain('en, it')
  })

  it('isLingua only accepts the shipped language codes, as strings', () => {
    expect(isLingua('it')).toBe(true)
    expect(isLingua('IT')).toBe(false)
    expect(isLingua(1)).toBe(false)
  })
})

describe('tenantDefaultLanguage', () => {
  it('returns the configured language, scoped to the tenant', async () => {
    runQueryOne.mockResolvedValueOnce({ lingua: 'it' })
    expect(await tenantDefaultLanguage('t1')).toBe('it')
    expect(runQueryOne.mock.calls[0]![2]).toEqual({ tenantId: 't1' })
    expect(close).toHaveBeenCalled()
  })

  it('not configured (null or empty) → null, distinct from English', async () => {
    runQueryOne.mockResolvedValueOnce({ lingua: null })
    expect(await tenantDefaultLanguage('t1')).toBeNull()
    runQueryOne.mockResolvedValueOnce({ lingua: '' })
    expect(await tenantDefaultLanguage('t2')).toBeNull()
    expect(logError).not.toHaveBeenCalled()
  })

  it('a value that is not a product language → treated as not configured AND logged', async () => {
    runQueryOne.mockResolvedValueOnce({ lingua: 'klingon' })
    expect(await tenantDefaultLanguage('t1')).toBeNull()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]![0]).toMatchObject({ tenantId: 't1', valore: 'klingon' })
  })

  it('unknown tenant → NotFound, never a guess', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    expect(errKey(await catchErr(tenantDefaultLanguage('ghost')))).toBe('errors.notFound')
    expect(close).toHaveBeenCalled()
  })

  it('is cached, including the "not configured" answer, until invalidated', async () => {
    runQueryOne.mockResolvedValue({ lingua: null })
    await tenantDefaultLanguage('t1')
    await tenantDefaultLanguage('t1')
    expect(runQueryOne).toHaveBeenCalledTimes(1)
    invalidateTenantLanguageCache('t1')
    await tenantDefaultLanguage('t1')
    expect(runQueryOne).toHaveBeenCalledTimes(2)
  })

  it('the cross-process clearer drops one tenant, or all of them', async () => {
    runQueryOne.mockResolvedValue({ lingua: 'it' })
    await tenantDefaultLanguage('t1')
    await tenantDefaultLanguage('t2')
    const registered = clearers[clearers.length - 1]!
    registered.one('t1')
    await tenantDefaultLanguage('t1')
    await tenantDefaultLanguage('t2')
    expect(runQueryOne).toHaveBeenCalledTimes(3)
    registered.all!()
    await tenantDefaultLanguage('t2')
    expect(runQueryOne).toHaveBeenCalledTimes(4)
  })

  it('the cache expires after its TTL', async () => {
    vi.useFakeTimers()
    try {
      runQueryOne.mockResolvedValue({ lingua: 'it' })
      await tenantDefaultLanguage('t1')
      vi.advanceTimersByTime(30_001)
      await tenantDefaultLanguage('t1')
      expect(runQueryOne).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
})

describe('languageFor / languageForUser', () => {
  it('languageFor falls back to the last-resort language only when not configured', async () => {
    runQueryOne.mockResolvedValueOnce({ lingua: null })
    expect(await languageFor('t1')).toBe(LINGUA_DI_ULTIMA_ISTANZA)
    runQueryOne.mockResolvedValueOnce({ lingua: 'it' })
    expect(await languageFor('t2')).toBe('it')
  })

  it('without a user (API key, worker) → the organisation\'s language, no user lookup', async () => {
    runQueryOne.mockResolvedValueOnce({ lingua: 'it' })
    expect(await languageForUser('t1', null)).toBe('it')
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('the person\'s own choice wins over the organisation, looked up inside the tenant', async () => {
    runQuery.mockResolvedValueOnce([{ language: 'en' }])
    expect(await languageForUser('t1', 'u1')).toBe('en')
    expect(runQuery.mock.calls[0]![2]).toEqual({ userId: 'u1', tenantId: 't1' })
    // No need to read the organisation's language at all.
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('a missing or invalid personal choice → the organisation\'s language', async () => {
    runQueryOne.mockResolvedValue({ lingua: 'it' })
    runQuery.mockResolvedValueOnce([{ language: 'xx' }])
    expect(await languageForUser('t1', 'u1')).toBe('it')
    runQuery.mockResolvedValueOnce([])
    expect(await languageForUser('t1', 'u2')).toBe('it')
  })
})

describe('setTenantDefaultLanguage', () => {
  it('rejects a language the product does not ship, before writing', async () => {
    expect(errKey(await catchErr(setTenantDefaultLanguage('t1', 'de')))).toBe('errors.enum.unknownLanguage')
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('writes on this tenant and invalidates every cache (all processes + notifications)', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 't1' })
    expect(await setTenantDefaultLanguage('t1', 'it')).toBe('it')
    expect(runQueryOne.mock.calls[0]![2]).toMatchObject({ tenantId: 't1', lingua: 'it' })
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
    expect(invalidateNotificationLocale).toHaveBeenCalledWith('t1')
  })

  it('unknown tenant → NotFound, and nothing is invalidated', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    expect(errKey(await catchErr(setTenantDefaultLanguage('ghost', 'en')))).toBe('errors.notFound')
    expect(invalidateSchema).not.toHaveBeenCalled()
    expect(invalidateNotificationLocale).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })
})

describe('seedDefaultLanguage (cache interaction)', () => {
  it('a successful seed drops the cached "not configured", so the tenant stops being flagged', async () => {
    const { seedDefaultLanguage } = await import('../tenantLanguage.js')
    runQueryOne.mockResolvedValueOnce({ lingua: null })
    expect(await tenantDefaultLanguage('t1')).toBeNull()
    runQueryOne.mockResolvedValueOnce({ id: 't1' })
    expect(await seedDefaultLanguage({} as never, 't1')).toEqual({ seeded: LINGUA_DI_ULTIMA_ISTANZA })
    runQueryOne.mockResolvedValueOnce({ lingua: 'en' })
    expect(await tenantDefaultLanguage('t1')).toBe('en')
  })

  it('already chosen (no row) → nothing seeded', async () => {
    const { seedDefaultLanguage } = await import('../tenantLanguage.js')
    runQueryOne.mockResolvedValueOnce(null)
    expect(await seedDefaultLanguage({} as never, 't1')).toEqual({ seeded: null })
  })
})
