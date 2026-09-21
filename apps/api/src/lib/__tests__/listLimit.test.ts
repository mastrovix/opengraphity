/**
 * Revisione del 14 set 2026 · CH-16: `changes(limit)` accettava qualunque
 * valore, e così gli incident, i problem e le richieste. Un tetto silenzioso a
 * 100 avrebbe troncato l'esportazione (che chiede 10 000 righe): il limite è
 * uno, dichiarato, e oltre si rifiuta invece di tagliare.
 */
import { describe, it, expect, vi } from 'vitest'
import { perms } from './testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({ withSession: vi.fn(async () => ({ items: [], total: 0 })) }))

const { listPage, MAX_LIST_LIMIT } = await import('../listLimit.js')
const { changes } = await import('../../graphql/resolvers/change/queries.js')
const { ValidationError } = await import('../errors.js')

describe('limite delle liste', () => {
  it('default, e valori validi fino al massimo', () => {
    expect(listPage({}, 50)).toEqual({ limit: 50, offset: 0 })
    expect(listPage({ limit: MAX_LIST_LIMIT, offset: 20 }, 50)).toEqual({ limit: MAX_LIST_LIMIT, offset: 20 })
    expect(MAX_LIST_LIMIT).toBe(10_000)
  })

  it.each([[{ limit: MAX_LIST_LIMIT + 1 }], [{ limit: 0 }], [{ limit: -5 }], [{ limit: 2.5 }], [{ offset: -1 }]])('%o → rifiutato, non tagliato', (args) => {
    expect(() => listPage(args, 50)).toThrow(ValidationError)
  })

  it('changes rifiuta un limite oltre il massimo prima di interrogare il database', async () => {
    await expect(changes(null, { limit: 1_000_000 }, { tenantId: 't1', userId: 'u1', role: 'operator', permissions: perms('operator') } as never)).rejects.toBeInstanceOf(ValidationError)
  })
})
