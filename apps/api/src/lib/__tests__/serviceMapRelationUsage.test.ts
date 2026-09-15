/**
 * Revisione del 15 set 2026 · SV-6: una relazione che una mappa di servizio
 * segue non si toglie dal metamodello. Tolta la sola definizione che
 * dichiarava un tipo, la mappa non si sincronizzava più (la costruzione valida
 * i tipi salvati contro quelli percorribili adesso) e l'unica uscita era
 * ricrearla perdendo cronologia, esclusioni e regole.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

const TYPES = vi.hoisted(() => ({ value: [] as unknown[] }))
vi.mock('@opengraphity/schema-generator', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/schema-generator')>()
  return { ...orig, loadMetamodel: vi.fn(async () => TYPES.value) }
})
vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return { ...orig, runQuery: vi.fn(), getSession: vi.fn() }
})

const { traversableRelationshipTypes } = await import('../ciMetamodelForTenant.js')
const { assertNoServiceMapFollows, relationshipTypesLostWithout, serviceMapsBlockingRemoval, SERVICE_MAPS_FOLLOWING_TYPES_CYPHER } = await import('../serviceMapRelationUsage.js')
const { runQuery } = await import('@opengraphity/neo4j')

function type(id: string, name: string, scope: 'base' | 'tenant', relations: Array<{ id: string; name: string; relationshipType: string }>) {
  return { id, name, label: name.toUpperCase(), scope, neo4jLabel: name, relations: relations.map((r) => ({ ...r, label: r.name })) } as unknown as CITypeWithDefinitions
}
const firewall = type('ct-fw', 'Firewall', 'tenant', [{ id: 'r-prot', name: 'protegge', relationshipType: 'PROTECTS' }, { id: 'r-dep', name: 'dipende', relationshipType: 'DEPENDS_ON' }])
const balancer = type('ct-lb', 'Balancer', 'tenant', [{ id: 'r-bal', name: 'bilancia', relationshipType: 'BALANCES|PROTECTS' }])
const server = type('ct-srv', 'Server', 'base', [{ id: 'r-host', name: 'ospita', relationshipType: 'HOSTS_VM' }])

beforeEach(() => { vi.clearAllMocks(); TYPES.value = [firewall, balancer, server] })

describe('traversableRelationshipTypes', () => {
  it('i quattro spediti, poi quelli dei tipi DEL cliente in ordine alfabetico (le relazioni dei tipi spediti no)', () => {
    expect(traversableRelationshipTypes([firewall, balancer, server])).toEqual(['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE', 'BALANCES', 'PROTECTS'])
  })
  it('senza una relazione o senza un tipo', () => {
    expect(traversableRelationshipTypes([firewall, balancer], { relationId: 'r-bal' })).toEqual(['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE', 'PROTECTS'])
    expect(traversableRelationshipTypes([firewall, balancer], { typeId: 'ct-fw' })).toEqual(['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE', 'BALANCES', 'PROTECTS'])
  })
})

describe('relationshipTypesLostWithout', () => {
  it('un tipo dichiarato anche altrove non si perde; uno spedito non si perde mai', async () => {
    expect(await relationshipTypesLostWithout('t1', { relationId: 'r-prot' })).toEqual({ lost: [], name: 'protegge' })
    expect(await relationshipTypesLostWithout('t1', { relationId: 'r-dep' })).toEqual({ lost: [], name: 'dipende' })
    expect(await relationshipTypesLostWithout('t1', { relationId: 'r-bal' })).toEqual({ lost: ['BALANCES'], name: 'bilancia' })
    TYPES.value = [firewall]
    expect(await relationshipTypesLostWithout('t1', { typeId: 'ct-fw' })).toEqual({ lost: ['PROTECTS'], name: 'FIREWALL' })
  })
})

describe('serviceMapsBlockingRemoval (giro UI 15 set · U-16: la conferma del tipo le legge prima)', () => {
  const session = {} as never
  it('restituisce le mappe per nome senza rifiutare; nessun tipo perso → nessuna domanda', async () => {
    TYPES.value = [firewall]
    vi.mocked(runQuery).mockResolvedValueOnce([{ name: 'Portale clienti' }] as never)
    expect(await serviceMapsBlockingRemoval(session, 't1', { typeId: 'ct-fw' })).toEqual({ lost: ['PROTECTS'], name: 'FIREWALL', maps: ['Portale clienti'] })
    vi.mocked(runQuery).mockClear()
    TYPES.value = [firewall, balancer, server]
    expect(await serviceMapsBlockingRemoval(session, 't1', { relationId: 'r-prot' })).toEqual({ lost: [], name: 'protegge', maps: [] })
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('assertNoServiceMapFollows', () => {
  const session = {} as never

  it('nessun tipo perso → nessuna domanda alle mappe', async () => {
    await assertNoServiceMapFollows(session, 't1', { relationId: 'r-prot' })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('tipo perso ma nessuna mappa lo segue → si toglie', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await expect(assertNoServiceMapFollows(session, 't1', { relationId: 'r-bal' })).resolves.toBeUndefined()
    expect(runQuery).toHaveBeenCalledWith(session, SERVICE_MAPS_FOLLOWING_TYPES_CYPHER, { tenantId: 't1', types: ['BALANCES'] })
  })

  it('tipo perso e seguito da mappe → rifiutato con le mappe, chiave i18n', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ name: 'CRM' }, { name: 'Portale clienti' }] as never)
    const err = await assertNoServiceMapFollows(session, 't1', { relationId: 'r-bal' }).then(() => null, (e: unknown) => e as { extensions: Record<string, unknown> })
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.extensions['i18n']).toEqual({ key: 'errors.ciType.relationUsedByServiceMaps', params: { name: 'bilancia', relationshipTypes: 'BALANCES', count: 2, maps: 'CRM, Portale clienti' } })
  })

  /** Secondo giro UI del 15 set 2026 · V-14: disattivando un tipo il messaggio parlava di una relazione tolta. */
  it('V-14: disattivare o eliminare un tipo ha la sua chiave e il suo verbo', async () => {
    TYPES.value = [firewall]
    vi.mocked(runQuery).mockResolvedValueOnce([{ name: 'Portale clienti' }] as never)
    const deact = await assertNoServiceMapFollows(session, 't1', { typeId: 'ct-fw' }, 'deactivateType').then(() => null, (e: { message: string; extensions: Record<string, unknown> }) => e)
    expect(deact!.message).toContain('was not deactivated')
    expect((deact!.extensions['i18n'] as { key: string }).key).toBe('errors.ciType.typeDeactivateUsedByServiceMaps')
    vi.mocked(runQuery).mockResolvedValueOnce([{ name: 'Portale clienti' }] as never)
    const del = await assertNoServiceMapFollows(session, 't1', { typeId: 'ct-fw' }, 'deleteType').then(() => null, (e: { message: string; extensions: Record<string, unknown> }) => e)
    expect((del!.extensions['i18n'] as { key: string }).key).toBe('errors.ciType.typeDeleteUsedByServiceMaps')
  })
})
