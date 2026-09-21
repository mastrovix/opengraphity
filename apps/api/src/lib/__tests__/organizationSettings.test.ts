/**
 * Verifica «Cosa resta cablato», ondata 6: le regole delle impostazioni
 * dell'organizzazione che prima erano scritte nel codice — numerazione dei
 * ticket, allegati, AI, marchio. Qui le parti pure (forma e coerenza); la
 * lettura dal Tenant ha i valori di fabbrica dichiarati, uguali a prima.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('@opengraphity/notifications', () => ({ invalidateTenantBrand: vi.fn() }))

const { assertTicketNumbering, formatTicketNumber, FACTORY_TICKET_NUMBERING } = await import('../ticketNumbering.js')
const { assertAttachmentPolicy, extensionAllowed, fileExtension, FACTORY_ATTACHMENT_POLICY, PLATFORM_ATTACHMENT_EXTENSIONS } = await import('../attachmentPolicy.js')
const { assertAISettings, FACTORY_AI_SETTINGS } = await import('../aiSettings.js')
const { detectLogoType } = await import('../brand.js')
const { brandedFrom, parseTenantBrand, assertReplyTo } = await import('@opengraphity/types')

const code = (fn: () => unknown) => { try { fn(); return null } catch (e) { return ((e as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key) ?? (e as Error).message } }

describe('numerazione dei ticket', () => {
  it('il formato di fabbrica è quello di prima', () => {
    expect(assertTicketNumbering(FACTORY_TICKET_NUMBERING)).toEqual(FACTORY_TICKET_NUMBERING)
    expect(formatTicketNumber(FACTORY_TICKET_NUMBERING.incident, 42)).toBe('INC00000042')
    expect(formatTicketNumber({ prefix: 'TKT-', digits: 6 }, 123)).toBe('TKT-000123')
  })

  it('prefissi validi, cifre nell\'intervallo, niente sovrapposizioni fra tipi', () => {
    const base = { ...FACTORY_TICKET_NUMBERING }
    expect(code(() => assertTicketNumbering({ ...base, incident: { prefix: 'tkt', digits: 8 } }))).toBe('errors.ticketNumbering.prefix')
    expect(code(() => assertTicketNumbering({ ...base, incident: { prefix: '1NC', digits: 8 } }))).toBe('errors.ticketNumbering.prefix')
    expect(code(() => assertTicketNumbering({ ...base, problem: { prefix: 'PRB', digits: 2 } }))).toBe('errors.ticketNumbering.digits')
    expect(code(() => assertTicketNumbering({ ...base, problem: { prefix: 'INC', digits: 8 } }))).toBe('errors.ticketNumbering.prefixOverlap')
    expect(code(() => assertTicketNumbering({ ...base, problem: { prefix: 'INCP', digits: 8 } }))).toBe('errors.ticketNumbering.prefixOverlap')
    expect(code(() => assertTicketNumbering({ ...base, incident: { prefix: 'TKT-', digits: 6 } }))).toBeNull()
  })
})

describe('allegati', () => {
  it('la politica di fabbrica accetta quello che si accettava prima', () => {
    expect(assertAttachmentPolicy(FACTORY_ATTACHMENT_POLICY)).toEqual(FACTORY_ATTACHMENT_POLICY)
    for (const ext of FACTORY_ATTACHMENT_POLICY.extensions) expect(PLATFORM_ATTACHMENT_EXTENSIONS).toContain(ext)
  })

  it('sotto il tetto della piattaforma, solo tipi del catalogo, mai eseguibili o html/svg', () => {
    expect(code(() => assertAttachmentPolicy({ maxSizeMb: 0, extensions: ['pdf'] }))).toBe('errors.attachmentPolicy.size')
    expect(code(() => assertAttachmentPolicy({ maxSizeMb: 10_000, extensions: ['pdf'] }))).toBe('errors.attachmentPolicy.size')
    expect(code(() => assertAttachmentPolicy({ maxSizeMb: 5, extensions: [] }))).toBe('errors.attachmentPolicy.noExtensions')
    for (const bad of ['exe', 'html', 'svg', 'js']) {
      expect(code(() => assertAttachmentPolicy({ maxSizeMb: 5, extensions: [bad] }))).toBe('errors.attachmentPolicy.extension')
    }
    expect(assertAttachmentPolicy({ maxSizeMb: 20, extensions: ['.PCAP', 'gz', 'gz'] })).toEqual({ maxSizeMb: 20, extensions: ['pcap', 'gz'] })
  })

  it('il tipo si riconosce dal nome del file, non dal MIME', () => {
    const policy = { maxSizeMb: 5, extensions: ['pcap', 'gz'] }
    expect(fileExtension('trace.PCAP')).toBe('pcap')
    expect(fileExtension('.bashrc')).toBe('')
    expect(extensionAllowed(policy, 'logs.tar.gz')).toBe(true)
    expect(extensionAllowed(policy, 'report.pdf')).toBe(false)
    expect(extensionAllowed(policy, 'noextension')).toBe(false)
  })
})

describe('AI', () => {
  it('tutto acceso con 0,72 e 3 di fabbrica; soglie nell\'intervallo; ogni funzione dichiarata', () => {
    expect(assertAISettings(FACTORY_AI_SETTINGS)).toEqual(FACTORY_AI_SETTINGS)
    const { embeddings: _e, ...missing } = FACTORY_AI_SETTINGS.features
    expect(code(() => assertAISettings({ ...FACTORY_AI_SETTINGS, features: missing }))).toBe('errors.aiSettings.shape')
    expect(code(() => assertAISettings({ ...FACTORY_AI_SETTINGS, clusterMinSimilarity: 0.3 }))).toBe('errors.aiSettings.similarity')
    expect(code(() => assertAISettings({ ...FACTORY_AI_SETTINGS, clusterMinSize: 1 }))).toBe('errors.aiSettings.size')
  })
})

describe('marchio', () => {
  it('il logo si riconosce dal contenuto: PNG, SVG pulito; niente script né altri formati', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)])
    expect(detectLogoType(png)).toBe('image/png')
    expect(detectLogoType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'))).toBe('image/svg+xml')
    expect(code(() => detectLogoType(Buffer.from('<svg onload="alert(1)"></svg>')))).toBe('errors.brand.logoUnsafe')
    expect(code(() => detectLogoType(Buffer.from('<svg><script>alert(1)</script></svg>')))).toBe('errors.brand.logoUnsafe')
    expect(code(() => detectLogoType(Buffer.from('<svg><a href="https://evil">x</a></svg>')))).toBe('errors.brand.logoUnsafe')
    expect(code(() => detectLogoType(Buffer.from('GIF89a....')))).toBe('errors.brand.logoType')
    expect(code(() => detectLogoType(Buffer.alloc(1024 * 1024 + 1)))).toBe('errors.brand.logoSize')
  })

  it('mittente con il nome del cliente e l\'indirizzo della piattaforma; senza marchio salvato, OpenGrafo', () => {
    expect(brandedFrom('OpenGrafo <noreply@opengrafo.io>', 'ACME IT')).toBe('ACME IT <noreply@opengrafo.io>')
    expect(brandedFrom('noreply@opengrafo.io', 'ACME IT')).toBe('ACME IT <noreply@opengrafo.io>')
    expect(parseTenantBrand(null, 't1')).toMatchObject({ displayName: 'OpenGrafo', senderName: 'OpenGrafo', replyTo: null, logo: null, isDefault: true })
    expect(() => assertReplyTo('not-an-address')).toThrow(/not an e-mail/)
    expect(() => parseTenantBrand(JSON.stringify({ displayName: 'A <b>', senderName: 'x', replyTo: null, logo: null }), 't1')).toThrow(/displayName/)
  })
})
