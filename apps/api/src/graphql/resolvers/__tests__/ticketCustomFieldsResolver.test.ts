/**
 * Verifica «Cosa resta cablato», ondata 4: la mutation del dettaglio scrive i
 * campi del cliente validati, lascia la traccia nell'Audit Log e avvisa chi
 * ascolta `ticket.updated` (webhook, automazioni). Una scrittura che non cambia
 * niente non lascia traccia.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const runQueryOne = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: (...a: unknown[]) => runQueryOne(...a) }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn({})) }))
const audit = vi.fn(async () => {})
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))
const publishTicketUpdated = vi.fn(async () => {})
vi.mock('../../../lib/ticketUpdated.js', () => ({ publishTicketUpdated: (...a: unknown[]) => publishTicketUpdated(...a) }))
const validateRequiredFields = vi.fn(async () => {})
vi.mock('../../../lib/validateRequiredFields.js', () => ({ validateRequiredFields: (...a: unknown[]) => validateRequiredFields(...a) }))
const DEFS = [{ name: 'outcome', label: 'Esito', fieldType: 'enum', required: false, enumValues: ['successful', 'failed'], enumTypeName: 'change_outcome', validationScript: null, visibleToEndUser: false, order: 1 }]
let current: Record<string, unknown> | null = { id: 'chg-1', outcome: null }
vi.mock('../../../lib/ticketCustomFields.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  customFieldDefs: vi.fn(async () => DEFS),
  loadTicketProps: vi.fn(async () => current),
}))

const { ticketCustomFieldResolvers } = await import('../ticketCustomFields.js')
const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@test.io', role: 'operator', permissions: perms('operator') } as never
const set = (values: { name: string; value: string | null }[], entityType = 'change') =>
  ticketCustomFieldResolvers.Mutation.setTicketCustomFields(null, { entityType, id: 'chg-1', values }, ctx)

beforeEach(() => { vi.clearAllMocks(); current = { id: 'chg-1', outcome: null } })

describe('setTicketCustomFields', () => {
  it('scrive, controlla le regole del cliente, avvisa e lascia la traccia di cosa è cambiato', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { id: 'chg-1', outcome: 'successful' } })
    const out = await set([{ name: 'outcome', value: 'successful' }])
    expect(runQueryOne.mock.calls[0]![2]).toMatchObject({ id: 'chg-1', tenantId: 't1', patch: { outcome: 'successful' } })
    expect(validateRequiredFields).toHaveBeenCalledWith({}, { entityType: 'change', fieldValues: { id: 'chg-1', outcome: 'successful' }, tenantId: 't1' })
    expect(publishTicketUpdated).toHaveBeenCalledWith(ctx, 'change', 'chg-1', current, { id: 'chg-1', outcome: 'successful' })
    expect(audit).toHaveBeenCalledWith(ctx, 'ticket.custom_fields_updated', 'Change', 'chg-1', { fields: { outcome: { from: null, to: 'successful' } } })
    expect(out).toEqual([expect.objectContaining({ name: 'outcome', value: 'successful' })])
  })

  it('niente di cambiato → niente evento e niente audit', async () => {
    current = { id: 'chg-1', outcome: 'failed' }
    runQueryOne.mockResolvedValueOnce({ props: { id: 'chg-1', outcome: 'failed' } })
    await set([{ name: 'outcome', value: 'failed' }])
    expect(publishTicketUpdated).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('un valore fuori vocabolario non arriva al grafo; un tipo senza campi è rifiutato; un ticket inesistente è NOT_FOUND', async () => {
    await expect(set([{ name: 'outcome', value: 'riuscita' }])).rejects.toThrow(/riuscita/)
    await expect(set([], 'kb_article')).rejects.toThrow(/has no custom fields/)
    current = null
    await expect(set([{ name: 'outcome', value: 'failed' }])).rejects.toThrow(/not found/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})
