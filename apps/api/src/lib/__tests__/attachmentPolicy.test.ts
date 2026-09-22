/**
 * The attachments an organisation accepts (Tenant.attachment_policy).
 *
 * Why these behaviours matter:
 *  - the customer chooses UNDER two platform ceilings: a size cap from config
 *    and a closed list of extensions that excludes what a browser executes
 *    (html, svg, js) and executables. Letting either through means a file that
 *    attacks whoever opens it;
 *  - an absent property must mean the factory policy (the old hard-coded 10 MB
 *    and types), or existing tenants would suddenly refuse uploads;
 *  - a ceiling lowered after the customer saved must apply at once: the stored
 *    policy is re-validated on read, and fails loudly rather than exceeding it;
 *  - the check is on the filename extension, not the browser-declared MIME type.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const runQueryOne = vi.fn()
const close = vi.fn(async () => undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close }),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
const invalidateSchema = vi.fn()
vi.mock('../schemaInvalidator.js', () => ({
  registerMetamodelCacheClearer: vi.fn(),
  invalidateSchema: (t: string) => invalidateSchema(t),
}))

const { resetConfigCache } = await import('../config.js')
const {
  assertAttachmentPolicy, attachmentPolicy, setAttachmentPolicy, clearAttachmentPolicyCache,
  fileExtension, extensionAllowed, FACTORY_ATTACHMENT_POLICY,
} = await import('../attachmentPolicy.js')

const errKey = (e: unknown) => (e as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key
const catchErr = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection') }, (e: unknown) => e)
const syncErrKey = (fn: () => unknown) => { try { fn(); return 'NO ERROR' } catch (e) { return errKey(e) } }

beforeEach(() => {
  vi.stubEnv('ATTACHMENT_MAX_MB_CAP', '50')
  resetConfigCache()
  runQueryOne.mockReset()
  close.mockClear()
  invalidateSchema.mockClear()
  clearAttachmentPolicyCache()
})
afterEach(() => { vi.unstubAllEnvs(); resetConfigCache() })

describe('assertAttachmentPolicy', () => {
  it('normalises extensions (case, leading dot, spaces) and drops duplicates', () => {
    expect(assertAttachmentPolicy({ maxSizeMb: 20, extensions: [' .PDF', 'pdf', 'Gz', 'pcap'] }))
      .toEqual({ maxSizeMb: 20, extensions: ['pdf', 'gz', 'pcap'] })
  })

  it.each([
    ['missing size', {}],
    ['zero', { maxSizeMb: 0, extensions: ['pdf'] }],
    ['fractional', { maxSizeMb: 1.5, extensions: ['pdf'] }],
    ['string', { maxSizeMb: '10', extensions: ['pdf'] }],
    // Above the platform cap (50 here): the customer cannot exceed it.
    ['above the platform cap', { maxSizeMb: 51, extensions: ['pdf'] }],
  ])('size: rejects %s', (_l, raw) => {
    expect(syncErrKey(() => assertAttachmentPolicy(raw))).toBe('errors.attachmentPolicy.size')
  })

  it('null input is treated as an empty policy and rejected, not crashed on', () => {
    expect(syncErrKey(() => assertAttachmentPolicy(null))).toBe('errors.attachmentPolicy.size')
  })

  it('accepts exactly the platform cap', () => {
    expect(assertAttachmentPolicy({ maxSizeMb: 50, extensions: ['pdf'] }).maxSizeMb).toBe(50)
  })

  it('requires at least one extension', () => {
    expect(syncErrKey(() => assertAttachmentPolicy({ maxSizeMb: 5, extensions: [] }))).toBe('errors.attachmentPolicy.noExtensions')
    expect(syncErrKey(() => assertAttachmentPolicy({ maxSizeMb: 5, extensions: 'pdf' }))).toBe('errors.attachmentPolicy.noExtensions')
  })

  it.each(['html', 'svg', 'js', 'exe', '', 42])('refuses %j: not a type the platform accepts', (ext) => {
    expect(syncErrKey(() => assertAttachmentPolicy({ maxSizeMb: 5, extensions: ['pdf', ext] }))).toBe('errors.attachmentPolicy.extension')
  })
})

describe('attachmentPolicy (loading)', () => {
  it('absent property → the factory policy, marked default, as a fresh copy', async () => {
    runQueryOne.mockResolvedValueOnce({ raw: null })
    const p = await attachmentPolicy('t1')
    expect(p).toEqual({ ...FACTORY_ATTACHMENT_POLICY, isDefault: true })
    // A caller mutating its copy must not corrupt the factory constant.
    expect(p.extensions).not.toBe(FACTORY_ATTACHMENT_POLICY.extensions)
    expect(runQueryOne.mock.calls[0]![2]).toEqual({ tenantId: 't1' })
    expect(close).toHaveBeenCalled()
  })

  it('stored policy → that policy, not default', async () => {
    runQueryOne.mockResolvedValueOnce({ raw: JSON.stringify({ maxSizeMb: 25, extensions: ['log', 'gz'] }) })
    expect(await attachmentPolicy('t1')).toEqual({ maxSizeMb: 25, extensions: ['log', 'gz'], isDefault: false })
  })

  it('a platform cap lowered after saving applies at once: the stored policy is rejected', async () => {
    vi.stubEnv('ATTACHMENT_MAX_MB_CAP', '10')
    resetConfigCache()
    runQueryOne.mockResolvedValueOnce({ raw: JSON.stringify({ maxSizeMb: 25, extensions: ['pdf'] }) })
    expect(errKey(await catchErr(attachmentPolicy('t1')))).toBe('errors.attachmentPolicy.size')
  })

  it('corrupt JSON → a loud error naming the tenant', async () => {
    runQueryOne.mockResolvedValueOnce({ raw: '{nope' })
    await expect(attachmentPolicy('t1')).rejects.toThrow(/Tenant t1: attachment_policy is not valid JSON/)
  })

  it('unknown tenant → NotFound', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    expect(errKey(await catchErr(attachmentPolicy('ghost')))).toBe('errors.notFound')
    expect(close).toHaveBeenCalled()
  })

  it('is cached per tenant', async () => {
    runQueryOne.mockResolvedValue({ raw: null })
    await attachmentPolicy('t1')
    await attachmentPolicy('t1')
    await attachmentPolicy('t2')
    expect(runQueryOne).toHaveBeenCalledTimes(2)
  })
})

describe('setAttachmentPolicy', () => {
  it('validates before writing', async () => {
    expect(errKey(await catchErr(setAttachmentPolicy('t1', { maxSizeMb: 5, extensions: ['exe'] })))).toBe('errors.attachmentPolicy.extension')
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('writes the normalised JSON on this tenant and invalidates the caches', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 't1' })
    expect(await setAttachmentPolicy('t1', { maxSizeMb: 5, extensions: ['.TXT'] })).toEqual({ maxSizeMb: 5, extensions: ['txt'], isDefault: false })
    const params = runQueryOne.mock.calls[0]![2] as Record<string, unknown>
    expect(params['tenantId']).toBe('t1')
    expect(JSON.parse(String(params['json']))).toEqual({ maxSizeMb: 5, extensions: ['txt'] })
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
  })

  it('unknown tenant → NotFound and no invalidation', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    expect(errKey(await catchErr(setAttachmentPolicy('ghost', { maxSizeMb: 5, extensions: ['pdf'] })))).toBe('errors.notFound')
    expect(invalidateSchema).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })
})

describe('fileExtension / extensionAllowed', () => {
  it.each([
    ['report.PDF', 'pdf'],
    ['archive.tar.gz', 'gz'],
    ['C:\\Users\\me\\trace.pcap', 'pcap'],
    ['/var/log/app.log', 'log'],
    // A dotfile has no extension: ".env" is a name, not type "env".
    ['.env', ''],
    ['README', ''],
    ['dir.d/README', ''],
  ])('%s → %j', (name, ext) => {
    expect(fileExtension(name)).toBe(ext)
  })

  it('allows only the policy\'s extensions, and never a file without one', () => {
    const policy = { maxSizeMb: 5, extensions: ['pdf', 'log'] }
    expect(extensionAllowed(policy, 'a.PDF')).toBe(true)
    expect(extensionAllowed(policy, 'a.html')).toBe(false)
    expect(extensionAllowed(policy, 'Makefile')).toBe(false)
    // The MIME trick: a name that ends in .pdf.html is an html file.
    expect(extensionAllowed(policy, 'invoice.pdf.html')).toBe(false)
  })
})
