/**
 * IL PROFILO DELL'ORGANIZZAZIONE (22 set 2026).
 *
 * ## Perché non c'erano
 * `resolvers/organizationProfile.ts` stava al 10%. È la pagina «Organizzazione»:
 * nome, marchio, numerazione dei ticket, politica degli allegati, script, AI.
 * Tredici porte, e tutte scrivono nel registro.
 *
 * Il file dice di sé: «Le regole stanno nei moduli di `lib/`; qui si espongono,
 * si scrive l'Audit Log e si limita alla pagina Organizzazione». Quindi è
 * QUELLO che si verifica — il permesso su ogni mutation, la registrazione col
 * prima e il dopo, e le tre forme che questo strato costruisce e che nessun
 * altro costruisce:
 *
 *  - `serviceRequest` per lo schema, `service_request` per il grafo;
 *  - i limiti DI PIATTAFORMA accanto a quelli del cliente, perché chi imposta
 *    un tetto deve vedere contro cosa sbatte;
 *  - `platformConfigured`, cioè «c'è una chiave Anthropic?»: senza, gli
 *    interruttori dell'AI sono accesi su qualcosa che non esiste.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const chiaveAI = vi.fn(() => 'sk-finta')
vi.mock('../../../lib/config.js', () => ({
  config: { attachmentMaxMbCap: 25, get anthropicApiKey() { return chiaveAI() } },
}))

const setTenantName = vi.fn()
vi.mock('../../../lib/tenantName.js', () => ({
  tenantName: vi.fn(async () => 'Prima S.p.A.'),
  setTenantName: (...a: unknown[]) => setTenantName(...a),
}))

const setTenantBrandTexts = vi.fn()
vi.mock('../../../lib/brand.js', () => ({
  tenantBrand: vi.fn(async () => ({ displayName: 'Prima', senderName: 'Assistenza', replyTo: null, logo: { mimeType: 'image/png' }, isDefault: false })),
  setTenantBrandTexts: (...a: unknown[]) => setTenantBrandTexts(...a),
  logoUrlOf: vi.fn((tenantId: string) => `/api/brand/${tenantId}/logo`),
}))

const setTicketNumbering = vi.fn()
vi.mock('../../../lib/ticketNumbering.js', () => ({
  ticketNumbering: vi.fn(async () => ({
    incident: { prefix: 'INC', digits: 8 }, problem: { prefix: 'PRB', digits: 8 },
    change: { prefix: 'CHG', digits: 8 }, service_request: { prefix: 'REQ', digits: 8 }, isDefault: true,
  })),
  setTicketNumbering: (...a: unknown[]) => setTicketNumbering(...a),
}))

const setAttachmentPolicy = vi.fn()
vi.mock('../../../lib/attachmentPolicy.js', () => ({
  PLATFORM_ATTACHMENT_EXTENSIONS: ['pdf', 'png'],
  attachmentPolicy: vi.fn(async () => ({ maxSizeMb: 10, extensions: ['pdf'], isDefault: true })),
  setAttachmentPolicy: (...a: unknown[]) => setAttachmentPolicy(...a),
}))

const setAISettings = vi.fn()
vi.mock('../../../lib/aiSettings.js', () => ({
  aiSettings: vi.fn(async () => ({ features: { triage: false }, isDefault: true })),
  setAISettings: (...a: unknown[]) => setAISettings(...a),
}))

const setScriptingEnabled = vi.fn()
vi.mock('../../../lib/scriptingPlan.js', () => ({
  getScriptingPlan: vi.fn(async () => ({ plan: 'pro', enabled: false })),
  setScriptingEnabled: (...a: unknown[]) => setScriptingEnabled(...a),
}))

const audit = vi.fn()
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const { organizationProfileResolvers: R } = await import('../organizationProfile.js')

const ctx = (...permessi: string[]) => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set(permessi),
}) as never
const ADMIN = ctx('config.organization')

async function codice(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'NESSUN RIFIUTO' } catch (e) {
    return String((e as GraphQLError).extensions?.['code'] ?? 'THROWN')
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  chiaveAI.mockReturnValue('sk-finta')
  setTenantName.mockResolvedValue('Dopo S.p.A.')
  setTenantBrandTexts.mockResolvedValue({ displayName: 'Dopo', senderName: 'Supporto', replyTo: 'a@b', logo: null, isDefault: false })
  setTicketNumbering.mockResolvedValue({
    incident: { prefix: 'IN2', digits: 6 }, problem: { prefix: 'PR2', digits: 6 },
    change: { prefix: 'CH2', digits: 6 }, service_request: { prefix: 'RQ2', digits: 6 }, isDefault: false,
  })
  setAttachmentPolicy.mockResolvedValue({ maxSizeMb: 5, extensions: ['png'], isDefault: false })
  setAISettings.mockResolvedValue({ features: { triage: true }, isDefault: false })
  setScriptingEnabled.mockResolvedValue({ plan: 'pro', enabled: true })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('ogni scrittura chiede `config.organization`', () => {
  const mutazioni: Array<[string, () => Promise<unknown>]> = [
    ['setTenantName', () => R.Mutation.setTenantName(null, { name: 'X' }, ctx('incident.write'))],
    ['setTenantBrand', () => R.Mutation.setTenantBrand(null, { input: { displayName: 'X', senderName: 'Y' } }, ctx('incident.write'))],
    ['setTicketNumbering', () => R.Mutation.setTicketNumbering(null, { input: {
      incident: { prefix: 'A', digits: 6 }, problem: { prefix: 'B', digits: 6 },
      change: { prefix: 'C', digits: 6 }, serviceRequest: { prefix: 'D', digits: 6 },
    } }, ctx('incident.write'))],
    ['setAttachmentPolicy', () => R.Mutation.setAttachmentPolicy(null, { input: { maxSizeMb: 5, extensions: [] } }, ctx('incident.write'))],
    ['setScriptingEnabled', () => R.Mutation.setScriptingEnabled(null, { enabled: true }, ctx('incident.write'))],
    ['setAISettings', () => R.Mutation.setAISettings(null, { input: { features: {} } as never }, ctx('incident.write'))],
  ]
  it.each(mutazioni)('%s', async (_n, chiama) => {
    expect(await codice(chiama)).toBe('FORBIDDEN')
    expect(audit).not.toHaveBeenCalled()
  })

  it('le LETTURE invece stanno sotto la pagina, non sotto questo permesso', async () => {
    // Chi apre Organizzazione in sola lettura deve poter vedere cosa c'è.
    expect(await R.Query.tenantName(null, null, ctx())).toBe('Prima S.p.A.')
    expect(await codice(() => R.Query.attachmentPolicy(null, null, ctx()))).toBe('NESSUN RIFIUTO')
  })
})

describe('le forme che questo strato costruisce', () => {
  it('la numerazione: `serviceRequest` per lo schema, `service_request` per il grafo', async () => {
    const letto = await R.Query.ticketNumbering(null, null, ADMIN) as Record<string, unknown>
    expect(letto['serviceRequest']).toEqual({ prefix: 'REQ', digits: 8 })
    expect(letto).not.toHaveProperty('service_request')

    await R.Mutation.setTicketNumbering(null, { input: {
      incident: { prefix: 'IN2', digits: 6 }, problem: { prefix: 'PR2', digits: 6 },
      change: { prefix: 'CH2', digits: 6 }, serviceRequest: { prefix: 'RQ2', digits: 6 },
    } }, ADMIN)
    // E nell'altro verso: alla libreria arriva il nome del grafo.
    expect(setTicketNumbering.mock.calls[0]![1]).toMatchObject({ service_request: { prefix: 'RQ2', digits: 6 } })
  })

  it('gli allegati: accanto al tetto del cliente c\'è quello di PIATTAFORMA', async () => {
    const out = await R.Query.attachmentPolicy(null, null, ADMIN) as Record<string, unknown>
    // Chi imposta un tetto deve vedere contro cosa sbatte.
    expect(out).toMatchObject({ maxSizeMb: 10, platformMaxSizeMb: 25, platformExtensions: ['pdf', 'png'] })
  })

  it('l\'AI dice se una chiave c\'è: senza, gli interruttori sarebbero accesi sul vuoto', async () => {
    expect(((await R.Query.aiSettings(null, null, ADMIN)) as Record<string, unknown>)['platformConfigured']).toBe(true)
    chiaveAI.mockReturnValue('')
    expect(((await R.Query.aiSettings(null, null, ADMIN)) as Record<string, unknown>)['platformConfigured']).toBe(false)
  })

  it('il marchio porta l\'indirizzo del logo, che è una rotta pubblica del tenant', async () => {
    const out = await R.Query.tenantBrandSettings(null, null, ADMIN) as Record<string, unknown>
    expect(out).toMatchObject({ logoUrl: '/api/brand/t1/logo', logoMimeType: 'image/png', isDefault: false })
  })

  it('«di fabbrica» esce sempre: il cliente sa se quel valore l\'ha deciso lui', async () => {
    expect(((await R.Query.ticketNumbering(null, null, ADMIN)) as Record<string, unknown>)['isDefault']).toBe(true)
    expect(((await R.Query.attachmentPolicy(null, null, ADMIN)) as Record<string, unknown>)['isDefault']).toBe(true)
    expect(((await R.Query.aiSettings(null, null, ADMIN)) as Record<string, unknown>)['isDefault']).toBe(true)
  })

  it('gli script: l\'interruttore sta in Organizzazione, il PIANO si legge accanto', async () => {
    // Legarlo al piano vorrebbe dire campi calcolati spenti su metà dei tenant.
    expect(await R.Query.scriptingSettings(null, null, ADMIN)).toEqual({ enabled: false, plan: 'pro' })
  })
})

describe('il registro: il PRIMA e il DOPO, non solo il dopo', () => {
  it('il nome', async () => {
    await R.Mutation.setTenantName(null, { name: 'Dopo S.p.A.' }, ADMIN)
    expect(audit.mock.calls[0]![1]).toBe('tenant.name.updated')
    expect(audit.mock.calls[0]![4]).toEqual({ from: 'Prima S.p.A.', to: 'Dopo S.p.A.' })
  })

  it('gli script', async () => {
    await R.Mutation.setScriptingEnabled(null, { enabled: true }, ADMIN)
    expect(audit.mock.calls[0]![4]).toEqual({ from: false, to: true })
  })

  it('l\'AI, con `isDefault` FUORI dal registro: non è un\'impostazione', async () => {
    await R.Mutation.setAISettings(null, { input: { features: { triage: true } } as never }, ADMIN)
    expect(audit.mock.calls[0]![4]).toEqual({ from: { features: { triage: false } }, to: { features: { triage: true } } })
  })

  it('e un `enabled` che non è `true` vale falso: non si accende per distrazione', async () => {
    await R.Mutation.setScriptingEnabled(null, { enabled: 'si' as never }, ADMIN)
    expect(setScriptingEnabled).toHaveBeenCalledWith('t1', false)
  })
})
