/**
 * Dipendenze e dipendenti di un CI (revisione del 15 set 2026 · CM-5).
 *
 * Si leggevano solo i tipi di relazione dichiarati dal tipo DEL CI. Dal vivo:
 * l'applicazione dichiara `DEPENDS_ON → any`, l'arco verso un firewall veniva
 * creato, e nel dettaglio del firewall — che non dichiara relazioni in entrata
 * — non si vedeva niente.
 */
import { describe, it, expect, vi } from 'vitest'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const edges: { props: Record<string, unknown>; label: string; relation: string }[] = []
const seen: { cypher: string; params: Record<string, unknown> }[] = []
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn({
    executeRead: (work: (tx: unknown) => unknown) => work({
      run: (cypher: string, params: Record<string, unknown>) => {
        seen.push({ cypher, params })
        return Promise.resolve({ records: edges.map((e) => ({ get: (k: string) => (k === 'props' ? e.props : k === 'label' ? e.label : e.relation) })) })
      },
    }),
  })),
}))

const { buildFieldResolvers, relationDeclaredBy } = await import('../ciFieldResolvers.js')

const rel = (relationshipType: string, direction: 'outgoing' | 'incoming', targetType: string) =>
  ({ id: relationshipType, name: relationshipType.toLowerCase(), label: relationshipType, relationshipType, targetType, cardinality: 'many', direction, order: 0 })
const type = (name: string, neo4jLabel: string, relations: ReturnType<typeof rel>[]) =>
  ({ name, neo4jLabel, relations, fields: [], systemRelations: [] }) as unknown as CITypeWithDefinitions

const application = type('application', 'Application', [rel('DEPENDS_ON', 'outgoing', 'any'), rel('HOSTED_ON', 'outgoing', 'Server')])
const server      = type('server', 'Server', [rel('DEPENDS_ON|HOSTED_ON|INSTALLED_ON', 'incoming', 'any')])
const firewall    = type('firewall', 'Firewall', [])
const TYPES = [application, server, firewall]
const ctx = { tenantId: 't1', userId: 'u', userEmail: 'u@x', role: 'admin', permissions: perms('admin') }

describe('relationDeclaredBy', () => {
  it('dichiarata dal tipo sorgente (in uscita), dal tipo destinazione (in entrata), con `any` e con i tipi multipli', () => {
    expect(relationDeclaredBy(TYPES, 'DEPENDS_ON', 'Application', 'Firewall')).toBe(true)     // any in uscita
    expect(relationDeclaredBy(TYPES, 'INSTALLED_ON', 'Firewall', 'Server')).toBe(true)        // in entrata sul server, tipi multipli
    expect(relationDeclaredBy(TYPES, 'HOSTED_ON', 'Application', 'Firewall')).toBe(false)     // l'app la dichiara solo verso Server
    expect(relationDeclaredBy(TYPES, 'PROTECTS', 'Firewall', 'Server')).toBe(false)
  })
})

describe('dependents / dependencies', () => {
  it('CM-5: il firewall vede l\'applicazione che dipende da lui, anche se il suo tipo non dichiara niente', async () => {
    edges.splice(0, edges.length, { props: { id: 'app-1', name: 'App portale' }, label: 'Application', relation: 'DEPENDS_ON' })
    const out = await buildFieldResolvers(firewall, TYPES).dependents({ id: 'fw-1' }, null, ctx)
    expect(out).toEqual([{ ci: { id: 'app-1', name: 'App portale', type: 'application', status: null, environment: null, chain: null }, relation: 'DEPENDS_ON' }])
    // la query non interpola tipi di relazione e resta nel tenant
    expect(seen.at(-1)!.cypher).toContain('(n)<-[rel]-(d)')
    expect(seen.at(-1)!.params).toMatchObject({ id: 'fw-1', tenantId: 't1', labels: ['Application', 'Server', 'Firewall'] })
  })

  it('un arco che nessuna definizione dichiara non si mostra', async () => {
    edges.splice(0, edges.length, { props: { id: 'app-1', name: 'App portale' }, label: 'Application', relation: 'HOSTED_ON' })
    expect(await buildFieldResolvers(firewall, TYPES).dependents({ id: 'fw-1' }, null, ctx)).toEqual([])
  })
})
