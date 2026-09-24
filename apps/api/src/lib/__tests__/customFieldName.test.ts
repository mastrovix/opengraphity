/**
 * Verifica «Cosa resta cablato», ondata 4: il nome di un campo del cliente
 * diventa la proprietà sul ticket, quindi non può essere un campo del prodotto
 * né un dato che i ticket portano già.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildSchema } from 'graphql'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../tenantSchema.js', () => ({
  getSchemaForTenant: vi.fn(async () => buildSchema('type Query { x: Int } type Change { id: ID! changeType: String what: String approvalRoute: String }')),
}))

const { assertCustomFieldName } = await import('../customFieldName.js')

const sessionWith = (inUse: number) => ({ executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: async () => ({ records: [{ get: () => inUse }] }) })) })
const keyOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as { extensions: { i18n: { key: string } } } | null)?.extensions.i18n.key ?? null

describe('assertCustomFieldName', () => {
  it('un nome nuovo, ben formato, su un tipo di ticket → passa', async () => {
    expect(await keyOf(assertCustomFieldName(sessionWith(0) as never, 't1', 'change', 'outcome'))).toBeNull()
  })

  it('forma: minuscole, cifre e trattino basso, da una lettera', async () => {
    for (const bad of ['Outcome', '1x', 'a', 'esito-finale', 'x'.repeat(41)]) {
      expect(await keyOf(assertCustomFieldName(sessionWith(0) as never, 't1', 'change', bad)), bad).toBe('errors.customField.nameFormat')
    }
  })

  it('un campo che l\'API espone già (in snake_case), o riservato → rifiutato', async () => {
    for (const taken of ['change_type', 'what', 'approval_route', 'number', 'status', 'priority']) {
      expect(await keyOf(assertCustomFieldName(sessionWith(0) as never, 't1', 'change', taken)), taken).toBe('errors.customField.nameTaken')
    }
  })

  it('una proprietà che i ticket del cliente portano già → rifiutata', async () => {
    expect(await keyOf(assertCustomFieldName(sessionWith(3) as never, 't1', 'change', 'legacy_category'))).toBe('errors.customField.nameInData')
  })

  it('i tipi che non sono ticket non passano da qui', async () => {
    expect(await keyOf(assertCustomFieldName(sessionWith(3) as never, 't1', 'kb_article', 'Qualunque'))).toBeNull()
  })
})
