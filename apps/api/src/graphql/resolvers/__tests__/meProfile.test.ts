/**
 * `me` restituiva solo i campi del token (id, email, ruolo): `slackId` era
 * sempre assente, quindi il Profilo diceva «non collegato» anche dopo aver
 * collegato Slack. E la scelta di ricevere le e-mail (CO-1, revisione del 14
 * set 2026) non aveva una porta: ora `me` legge il nodo User e
 * `setMyEmailNotifications` la scrive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const runQueryOne = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({ runQueryOne: (...a: unknown[]) => runQueryOne(...a), getSession: vi.fn(() => ({ close: vi.fn(async () => {}) })) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))

const { meResolvers } = await import('../me.js')
const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'bob@azienda.it', role: 'operator', permissions: perms('operator') } as never

describe('me', () => {
  beforeEach(() => { runQueryOne.mockReset() })

  it('legge il nodo User: slackId e scelta sulle e-mail', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { id: 'u1', tenant_id: 't1', email: 'bob@azienda.it', name: 'Bob', role: 'operator', slack_id: 'U123', notifications_enabled: false } })
    const me = await meResolvers.Query.me(null, {}, ctx)
    expect(me).toMatchObject({ id: 'u1', name: 'Bob', slackId: 'U123', emailNotifications: false })
    const [, cypher, params] = runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('MATCH (u:User {id: $userId, tenant_id: $tenantId})')
    expect(params).toEqual({ userId: 'u1', tenantId: 't1' })
  })

  it('assente = e-mail attive', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { id: 'u1', tenant_id: 't1', email: 'bob@azienda.it', name: 'Bob', role: 'operator' } })
    expect(await meResolvers.Query.me(null, {}, ctx)).toMatchObject({ slackId: null, emailNotifications: true })
  })

  it('setMyEmailNotifications scrive la scelta sulla propria persona', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { id: 'u1', tenant_id: 't1', email: 'bob@azienda.it', name: 'Bob', role: 'operator', notifications_enabled: false } })
    const me = await meResolvers.Mutation.setMyEmailNotifications(null, { enabled: false }, ctx)
    expect(me).toMatchObject({ emailNotifications: false })
    const [, cypher, params] = runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('SET u.notifications_enabled = $enabled')
    expect(params).toMatchObject({ userId: 'u1', tenantId: 't1', enabled: false })
  })

  /** Secondo giro UI del 15 set 2026: la lingua personale stava solo nel browser del web, il portale non la vedeva. */
  it('setMyLanguage scrive la lingua sulla persona; null torna a quella dell\'organizzazione', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { id: 'u1', tenant_id: 't1', email: 'bob@azienda.it', role: 'operator', language: 'it' } })
    expect(await meResolvers.Mutation.setMyLanguage(null, { language: 'it' }, ctx)).toMatchObject({ language: 'it' })
    expect((runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>])[2]).toMatchObject({ language: 'it' })
    runQueryOne.mockResolvedValueOnce({ props: { id: 'u1', tenant_id: 't1', email: 'bob@azienda.it', role: 'operator' } })
    expect(await meResolvers.Mutation.setMyLanguage(null, { language: null }, ctx)).toMatchObject({ language: null })
    expect((runQueryOne.mock.calls[1] as [unknown, string, Record<string, unknown>])[2]).toMatchObject({ language: null })
  })

  it('setMyLanguage rifiuta una lingua che il prodotto non ha, senza scrivere', async () => {
    await expect(meResolvers.Mutation.setMyLanguage(null, { language: 'klingon' }, ctx)).rejects.toThrow(/not recognised/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})
