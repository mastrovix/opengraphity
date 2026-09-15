/**
 * Ondata 7 di «Nulla cablato»: i ruoli sono dato dell'organizzazione.
 * Qui la lettura (un ruolo che non c'è è rifiutato, un permesso sconosciuto è
 * un errore di integrità) e la semina dei ruoli di fabbrica (solo dove mancano).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FACTORY_ROLE_PERMISSIONS } from '@opengraphity/types'

const runQuery = vi.fn()
const txRun = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn(), executeWrite: (fn: (tx: unknown) => unknown) => fn({ run: txRun }) })),
  runQuery: (...a: unknown[]) => runQuery(...a),
}))
vi.mock('../schemaInvalidator.js', () => ({ invalidateSchema: vi.fn(), registerMetamodelCacheClearer: vi.fn() }))

const { rolePermissions, seedFactoryRoles, clearRolesCache, roleKeyFromName, createRole, updateRole, deleteRole, setUserRole, factoryRoleNamedLike } = await import('../roles.js')
const { invalidateSchema } = await import('../schemaInvalidator.js')

/** Una risposta Neo4j con una riga. */
const rec = (row: Record<string, unknown>) => ({ records: [{ get: (k: string) => row[k] }] })
const none = { records: [] }
const errKey = async (p: Promise<unknown>) => p.then(() => null, (e: { extensions?: { i18n?: { key?: string } } }) => e.extensions?.i18n?.key ?? String(e))

beforeEach(() => { clearRolesCache(); runQuery.mockReset(); txRun.mockReset() })

describe('rolePermissions', () => {
  it('restituisce i permessi del ruolo della persona', async () => {
    runQuery.mockResolvedValue([{ key: 'service_desk', name: 'Service Desk', permissions: ['workspace.use', 'incident.read'], isFactory: false }])
    const perms = await rolePermissions('c-test', 'service_desk')
    expect([...perms].sort()).toEqual(['incident.read', 'workspace.use'])
  })

  it('un ruolo che l\'organizzazione non ha è rifiutato, non degradato', async () => {
    runQuery.mockResolvedValue([{ key: 'admin', name: null, permissions: ['admin.users'], isFactory: true }])
    await expect(rolePermissions('c-test', 'manager')).rejects.toMatchObject({
      message: expect.stringMatching(/Unknown role 'manager'/),
      extensions: { code: 'FORBIDDEN' },
    })
  })

  it('un permesso fuori catalogo nel dato è un errore di integrità', async () => {
    runQuery.mockResolvedValue([{ key: 'admin', name: null, permissions: ['admin.users', 'admin.everything'], isFactory: true }])
    await expect(rolePermissions('c-test', 'admin')).rejects.toThrow(/unknown permissions: admin\.everything/)
  })

  it('i ruoli si leggono una volta per tenant (cache)', async () => {
    runQuery.mockResolvedValue([{ key: 'viewer', name: null, permissions: ['workspace.use'], isFactory: true }])
    await rolePermissions('c-test', 'viewer')
    await rolePermissions('c-test', 'viewer')
    expect(runQuery).toHaveBeenCalledTimes(1)
  })
})

describe('seedFactoryRoles', () => {
  it('crea i quattro ruoli con i permessi di fabbrica, solo dove mancano', async () => {
    const calls: Array<Record<string, unknown>> = []
    const session = {
      run: vi.fn(async (_c: string, p: Record<string, unknown>) => {
        calls.push(p)
        return { records: [{ get: () => p['key'] !== 'admin' }] }
      }),
    }
    const created = await seedFactoryRoles(session as never, 'c-test')
    expect(created).toEqual(['operator', 'viewer', 'end_user'])
    expect(calls.map((c) => c['key'])).toEqual(['admin', 'operator', 'viewer', 'end_user'])
    expect(calls.find((c) => c['key'] === 'end_user')!['permissions']).toEqual([...FACTORY_ROLE_PERMISSIONS.end_user])
    expect(String(session.run.mock.calls[0]![0])).toMatch(/MERGE \(r:Role \{tenant_id: \$tenantId, key: \$key\}\)\s+ON CREATE SET/)
  })
})

describe('la chiave di un ruolo nuovo', () => {
  it('nasce dal nome, senza accenti né spazi, ed è unica nel tenant', () => {
    expect(roleKeyFromName('Service Desk 1° livello', new Set())).toBe('service_desk_1_livello')
    expect(roleKeyFromName('Change Manager', new Set(['change_manager']))).toBe('change_manager_2')
    expect(roleKeyFromName('Città', new Set())).toBe('citta')
    expect(roleKeyFromName('42', new Set())).toBe('role')
  })
})

describe('gestione dei ruoli', () => {
  /** Secondo giro UI del 15 set 2026 · V-16: un ruolo personalizzato «Admin» nasceva accanto a quello di fabbrica. */
  it('V-16: un ruolo non può chiamarsi come uno di fabbrica, in nessuna lingua; il ruolo di fabbrica può tenere il suo nome', async () => {
    expect(await errKey(createRole('c-test', { name: 'Admin', permissions: [] }))).toBe('errors.role.nameTaken')
    expect(await errKey(createRole('c-test', { name: ' operatore ', permissions: [] }))).toBe('errors.role.nameTaken')
    expect(await errKey(createRole('c-test', { name: 'END USER', permissions: [] }))).toBe('errors.role.nameTaken')
    expect(txRun).not.toHaveBeenCalled()
    expect(factoryRoleNamedLike('Viewer', 'viewer')).toBeNull()
    expect(factoryRoleNamedLike('Visualizzatore', 'operator')).toBe('viewer')
    expect(factoryRoleNamedLike('Service Desk', null)).toBeNull()
  })

  it('createRole: nome obbligatorio, permessi del catalogo, nome non duplicato; poi la leva del metamodello', async () => {
    expect(await errKey(createRole('c-test', { name: '  ', permissions: [] }))).toBe('errors.role.name')
    expect(await errKey(createRole('c-test', { name: 'X', permissions: ['incident.read', 'root.everything'] }))).toBe('errors.role.permissions')

    txRun.mockResolvedValueOnce(rec({ key: 'change_manager' }))
    expect(await errKey(createRole('c-test', { name: 'Change Manager', permissions: [] }))).toBe('errors.role.nameTaken')

    txRun.mockResolvedValueOnce(none).mockResolvedValueOnce(rec({ keys: ['admin', 'operator'] })).mockResolvedValueOnce(none)
    const role = await createRole('c-test', { name: 'Change Manager', permissions: ['change.write', 'change.read'] })
    // L'ordine dei permessi è quello del catalogo, non quello dell'invio.
    expect(role).toEqual({ key: 'change_manager', name: 'Change Manager', permissions: ['change.read', 'change.write'], isFactory: false, userCount: 0 })
    expect(String(txRun.mock.calls.at(-1)![0])).toContain('CREATE (r:Role {id: $id, tenant_id: $tenantId, key: $key')
    expect(invalidateSchema).toHaveBeenCalledWith('c-test')
  })

  it('updateRole: togliere admin.users all\'ultimo ruolo che lo ha usato da qualcuno è rifiutato', async () => {
    txRun
      .mockResolvedValueOnce(rec({ name: null, permissions: ['admin.users', 'incident.read'], isFactory: true, userCount: 1 }))
      .mockResolvedValueOnce(rec({ n: 0 }))
    expect(await errKey(updateRole('c-test', 'admin', { name: null, permissions: ['incident.read'] }))).toBe('errors.role.lastUsersAdmin')
    expect(txRun).toHaveBeenCalledTimes(2)
  })

  it('updateRole: un ruolo di fabbrica resta senza nome se non lo si rinomina', async () => {
    txRun
      .mockResolvedValueOnce(rec({ name: null, permissions: ['incident.read'], isFactory: true, userCount: 3 }))
      .mockResolvedValueOnce(none)
    const { after } = await updateRole('c-test', 'viewer', { name: '', permissions: ['incident.read', 'kb.read'] })
    expect(after).toEqual({ key: 'viewer', name: null, permissions: ['incident.read', 'kb.read'], isFactory: true, userCount: 3 })
  })

  it('deleteRole: un ruolo di fabbrica o con persone non si cancella', async () => {
    txRun.mockResolvedValueOnce(rec({ name: null, permissions: [], isFactory: true, userCount: 0 }))
    expect(await errKey(deleteRole('c-test', 'viewer'))).toBe('errors.role.factoryNotDeletable')
    txRun.mockResolvedValueOnce(rec({ name: 'Desk', permissions: [], isFactory: false, userCount: 2 }))
    expect(await errKey(deleteRole('c-test', 'desk'))).toBe('errors.role.inUse')
    txRun.mockResolvedValueOnce(none)
    expect(await errKey(deleteRole('c-test', 'missing'))).toBe('errors.notFound')
  })

  it('setUserRole: il ruolo deve esistere, e l\'ultima persona che gestisce persone e ruoli non lo perde', async () => {
    txRun.mockResolvedValueOnce(rec({ previousRole: 'admin', roleExists: false, wasUsersAdmin: true }))
    expect(await errKey(setUserRole('c-test', 'u1', 'nope'))).toBe('errors.authz.invalidRole')

    txRun.mockResolvedValueOnce(rec({ previousRole: 'admin', roleExists: true, wasUsersAdmin: true })).mockResolvedValueOnce(rec({ n: 0 }))
    expect(await errKey(setUserRole('c-test', 'u1', 'viewer'))).toBe('errors.role.lastUsersAdmin')

    txRun.mockResolvedValueOnce(rec({ previousRole: 'operator', roleExists: true, wasUsersAdmin: false })).mockResolvedValueOnce(none)
    await expect(setUserRole('c-test', 'u2', 'viewer')).resolves.toEqual({ previousRole: 'operator' })
  })
})
