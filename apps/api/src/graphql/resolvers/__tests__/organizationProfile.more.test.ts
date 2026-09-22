/**
 * resolvers/organizationProfile.ts — brand and attachment policy.
 *
 * The brand is what every email and PDF of the customer carries; the public
 * `tenantBrand` query feeds the login page, so it must expose the display name
 * and logo URL but nothing about sender or reply-to. The attachment policy
 * write must go to the Audit Log with what was actually stored (the library
 * may normalise the input), and answer with the platform caps alongside.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/config.js', () => ({ config: { attachmentMaxMbCap: 25, anthropicApiKey: '' } }))
vi.mock('../../../lib/tenantName.js', () => ({ tenantName: vi.fn(), setTenantName: vi.fn() }))
const tenantBrand = vi.fn()
const setTenantBrandTexts = vi.fn()
vi.mock('../../../lib/brand.js', () => ({
  tenantBrand: (...a: unknown[]) => tenantBrand(...a),
  setTenantBrandTexts: (...a: unknown[]) => setTenantBrandTexts(...a),
  logoUrlOf: vi.fn((tenantId: string, b: { logo: unknown }) => (b.logo ? `/api/brand/${tenantId}/logo` : null)),
}))
vi.mock('../../../lib/ticketNumbering.js', () => ({ ticketNumbering: vi.fn(), setTicketNumbering: vi.fn() }))
const setAttachmentPolicy = vi.fn()
vi.mock('../../../lib/attachmentPolicy.js', () => ({
  PLATFORM_ATTACHMENT_EXTENSIONS: ['pdf', 'png', 'txt'],
  attachmentPolicy: vi.fn(),
  setAttachmentPolicy: (...a: unknown[]) => setAttachmentPolicy(...a),
}))
vi.mock('../../../lib/aiSettings.js', () => ({ aiSettings: vi.fn(), setAISettings: vi.fn() }))
vi.mock('../../../lib/scriptingPlan.js', () => ({ getScriptingPlan: vi.fn(), setScriptingEnabled: vi.fn() }))
const audit = vi.fn()
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const { organizationProfileResolvers: R } = await import('../organizationProfile.js')

const ctx = (...permissions: string[]) => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set(permissions),
}) as never
const ADMIN = ctx('config.organization')

beforeEach(() => {
  vi.clearAllMocks()
  tenantBrand.mockResolvedValue({ displayName: 'Acme', senderName: 'Help', replyTo: 'r@acme', logo: { mimeType: 'image/svg+xml' }, isDefault: false })
})

describe('tenantBrand (public view)', () => {
  it('exposes display name, logo URL and default flag, and nothing about the sender', async () => {
    const out = await R.Query.tenantBrand(null, null, ctx())
    expect(out).toEqual({ displayName: 'Acme', logoUrl: '/api/brand/t1/logo', isDefault: false })
    expect(tenantBrand).toHaveBeenCalledWith('t1')
  })
})

describe('setTenantBrand', () => {
  it('a missing replyTo is stored as null, and the audit carries what was stored', async () => {
    setTenantBrandTexts.mockResolvedValue({ displayName: 'Acme 2', senderName: 'Support', replyTo: null, logo: null, isDefault: false })
    const out = await R.Mutation.setTenantBrand(null, { input: { displayName: ' Acme 2 ', senderName: 'Support' } }, ADMIN)
    expect(setTenantBrandTexts).toHaveBeenCalledWith('t1', { displayName: ' Acme 2 ', senderName: 'Support', replyTo: null })
    expect(audit).toHaveBeenCalledWith(ADMIN, 'tenant.brand.updated', 'Tenant', 't1', { displayName: 'Acme 2', senderName: 'Support', replyTo: null })
    // No logo: the view says so explicitly rather than pointing at a missing file.
    expect(out).toEqual({ displayName: 'Acme 2', senderName: 'Support', replyTo: null, logoUrl: null, logoMimeType: null, isDefault: false })
  })
})

describe('setAttachmentPolicy', () => {
  it('audits the stored policy and answers with the platform caps next to it', async () => {
    setAttachmentPolicy.mockResolvedValue({ maxSizeMb: 5, extensions: ['pdf'], isDefault: false })
    const input = { maxSizeMb: 5, extensions: ['PDF', 'pdf'] }
    const out = await R.Mutation.setAttachmentPolicy(null, { input }, ADMIN)
    expect(setAttachmentPolicy).toHaveBeenCalledWith('t1', { maxSizeMb: 5, extensions: ['PDF', 'pdf'] })
    // What the library normalised, not what the client sent.
    expect(audit).toHaveBeenCalledWith(ADMIN, 'tenant.attachment_policy.updated', 'Tenant', 't1', { maxSizeMb: 5, extensions: ['pdf'] })
    expect(out).toEqual({ maxSizeMb: 5, extensions: ['pdf'], isDefault: false, platformMaxSizeMb: 25, platformExtensions: ['pdf', 'png', 'txt'] })
  })

  it('without config.organization nothing is written', async () => {
    await expect(R.Mutation.setAttachmentPolicy(null, { input: { maxSizeMb: 1, extensions: [] } }, ctx('incident.read'))).rejects.toThrow()
    expect(setAttachmentPolicy).not.toHaveBeenCalled()
  })
})
