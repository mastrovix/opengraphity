/**
 * Ruolo nella mappa del servizio e tipi di relazione percorribili, **per
 * cliente** (ondata 6 · A-10 / C-3).
 *
 * Prima: il ruolo era una tabella per etichetta nel codice (e `roleOfLabels`
 * lanciava su tutto il resto), i tipi di relazione erano quattro costanti. Un
 * tipo o una relazione del cliente non entravano in nessuna mappa, e la
 * finestra di change non silenziava gli allarmi a monte lungo le SUE relazioni.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const loadMetamodel = vi.fn()
vi.mock('@opengraphity/schema-generator', () => ({ loadMetamodel }))

const {
  serviceRolesForTenant, serviceRelationshipTypesForTenant, suppressionRelPatternForTenant,
  impactRelPatternForTenant, assertRelationshipTypeName, splitRelationshipTypes,
  defaultServiceRoleOf, clearCIMetamodelCache,
} = await import('../ciMetamodelForTenant.js')
const { registeredMetamodelCacheClearers, invalidateSchema } = await import('../schemaInvalidator.js')
const { roleOfLabels, ROLE_BY_CI_LABEL } = await import('../serviceVocabularies.js')

interface FakeRelation { name: string; relationshipType: string }
const type = (over: Partial<{ name: string; neo4jLabel: string; scope: string; serviceRole: string | null; chainFamilies: string[]; relations: FakeRelation[] }> = {}) => ({
  name: 'load_balancer', neo4jLabel: 'LoadBalancer', scope: 'tenant', active: true,
  serviceRole: null, chainFamilies: [], relations: [], ...over,
})

beforeEach(() => { vi.clearAllMocks(); clearCIMetamodelCache() })

describe('serviceRolesForTenant', () => {
  it('il ruolo dichiarato dal tipo vince', async () => {
    loadMetamodel.mockResolvedValue([type({ serviceRole: 'component' })])
    expect((await serviceRolesForTenant('c-one')).get('LoadBalancer')).toBe('component')
  })

  it('senza ruolo dichiarato: prima il seme dei tipi spediti, poi le famiglie di catena', async () => {
    loadMetamodel.mockResolvedValue([
      // un tipo spedito senza service_role (prima della migrazione): vince il seme
      type({ name: 'certificate', neo4jLabel: 'Certificate', scope: 'base', chainFamilies: ['Application', 'Infrastructure'] }),
      // solo Application → component
      type({ name: 'portale', neo4jLabel: 'Portale', chainFamilies: ['Application'] }),
      // ambiguo o senza famiglie → infrastructure, il ruolo più conservativo
      type({ name: 'filiale', neo4jLabel: 'Filiale', chainFamilies: ['Application', 'Infrastructure'] }),
      type({ name: 'sonda',   neo4jLabel: 'Sonda',   chainFamilies: [] }),
    ])
    const roles = await serviceRolesForTenant('c-one')
    expect(roles.get('Certificate')).toBe('certificate')
    expect(roles.get('Portale')).toBe('component')
    expect(roles.get('Filiale')).toBe('infrastructure')
    expect(roles.get('Sonda')).toBe('infrastructure')
  })

  it('le etichette spedite senza un tipo nel metamodello restano nel seme (15 etichette, 9 tipi base dal vivo)', async () => {
    loadMetamodel.mockResolvedValue([])
    const roles = await serviceRolesForTenant('c-one')
    for (const [label, role] of Object.entries(ROLE_BY_CI_LABEL)) expect(roles.get(label)).toBe(role)
    expect(roles.get('SslCertificate')).toBe('certificate')
  })

  it('un service_role fuori vocabolario sul grafo FERMA la lettura nominando il tipo', async () => {
    loadMetamodel.mockResolvedValue([type({ serviceRole: 'entry' })])
    await expect(serviceRolesForTenant('c-one')).rejects.toThrow(/load_balancer.*service_role/)
  })

  it('roleOfLabels: entry al livello 1, il ruolo del tipo sotto, errore per un\'etichetta di nessun tipo attivo', async () => {
    loadMetamodel.mockResolvedValue([type({ serviceRole: 'component' })])
    const roles = await serviceRolesForTenant('c-one')
    expect(roleOfLabels(roles, ['LoadBalancer'], 1)).toBe('entry')
    expect(roleOfLabels(roles, ['LoadBalancer'], 2)).toBe('component')
    expect(() => roleOfLabels(roles, ['Cancellato'], 2)).toThrow(/No service node role for CI labels \["Cancellato"\]/)
  })
})

describe('serviceRelationshipTypesForTenant', () => {
  it('i quattro spediti più quelli dei tipi DEL cliente, in ordine stabile', async () => {
    loadMetamodel.mockResolvedValue([
      type({ relations: [{ name: 'bilancia', relationshipType: 'BILANCIA' }, { name: 'replica', relationshipType: 'REPLICA_SU' }] }),
    ])
    expect(await serviceRelationshipTypesForTenant('c-one')).toEqual([
      'DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE', 'BILANCIA', 'REPLICA_SU',
    ])
  })

  it('le relazioni dei tipi SPEDITI non entrano: REALIZES resta fuori dalle mappe', async () => {
    loadMetamodel.mockResolvedValue([
      type({ name: 'business_application', neo4jLabel: 'BusinessApplication', scope: 'base', relations: [{ name: 'realizza', relationshipType: 'REALIZES' }] }),
    ])
    expect(await serviceRelationshipTypesForTenant('c-one')).not.toContain('REALIZES')
  })

  it('una definizione con più tipi separati da | vale per tutti', async () => {
    loadMetamodel.mockResolvedValue([type({ relations: [{ name: 'x', relationshipType: 'BILANCIA|SMISTA' }] })])
    expect(await serviceRelationshipTypesForTenant('c-one')).toContain('SMISTA')
  })

  it('un relationship_type fuori forma sul grafo FERMA la lettura (finisce interpolato nel Cypher)', async () => {
    loadMetamodel.mockResolvedValue([type({ relations: [{ name: 'brutta', relationshipType: 'bilancia*]->(x)' }] })])
    await expect(serviceRelationshipTypesForTenant('c-one')).rejects.toThrow(/non è un tipo di relazione valido/)
  })

  it('due clienti non si vedono le relazioni', async () => {
    loadMetamodel.mockImplementation(async (t: string) =>
      t === 'c-one' ? [type({ relations: [{ name: 'b', relationshipType: 'BILANCIA' }] })] : [])
    expect(await serviceRelationshipTypesForTenant('c-one')).toContain('BILANCIA')
    expect(await serviceRelationshipTypesForTenant('c-two')).not.toContain('BILANCIA')
  })

  it('il pattern della soppressione e quello del blast radius derivano dalla stessa lista', async () => {
    loadMetamodel.mockResolvedValue([type({ relations: [{ name: 'b', relationshipType: 'BILANCIA' }] })])
    expect(await suppressionRelPatternForTenant('c-one')).toBe('DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE|BILANCIA')
    expect(await impactRelPatternForTenant('c-one')).toBe('DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE|BILANCIA|REALIZES|ENABLED_BY')
  })
})

describe('cache e fail-loud', () => {
  it('una lettura per tenant, e di nuovo dopo un\'invalidazione del metamodello', async () => {
    loadMetamodel.mockResolvedValue([])
    await serviceRolesForTenant('c-one')
    await serviceRelationshipTypesForTenant('c-one')
    expect(loadMetamodel).toHaveBeenCalledTimes(1)
    expect(registeredMetamodelCacheClearers()).toContain('ci-metamodel-for-tenant')
    invalidateSchema('c-one')
    await serviceRolesForTenant('c-one')
    expect(loadMetamodel).toHaveBeenCalledTimes(2)
  })

  it('se il metamodello non si legge l\'errore ESCE e non resta in cache', async () => {
    loadMetamodel.mockRejectedValueOnce(new Error('neo4j giù'))
    await expect(serviceRolesForTenant('c-one')).rejects.toThrow('neo4j giù')
    loadMetamodel.mockResolvedValue([type({ serviceRole: 'component' })])
    expect((await serviceRolesForTenant('c-one')).get('LoadBalancer')).toBe('component')
  })
})

describe('le funzioni pure', () => {
  it('assertRelationshipTypeName ammette solo MAIUSCOLO_CON_UNDERSCORE', () => {
    expect(assertRelationshipTypeName('BILANCIA_SU', 'x')).toBe('BILANCIA_SU')
    expect(assertRelationshipTypeName('A1', 'x')).toBe('A1')
    for (const bad of ['bilancia', 'Bilancia', '1A', 'A B', 'A-B', '', 'A]->(n)', null, 42, 'A'.repeat(65)]) {
      expect(() => assertRelationshipTypeName(bad, 'campo')).toThrow(/campo/)
    }
  })

  it('splitRelationshipTypes divide su | e valida ogni pezzo', () => {
    expect(splitRelationshipTypes('A|B_C', 'x')).toEqual(['A', 'B_C'])
    expect(splitRelationshipTypes(' A | B ', 'x')).toEqual(['A', 'B'])
    expect(() => splitRelationshipTypes('A|b', 'x')).toThrow()
  })

  it('defaultServiceRoleOf: solo Application → component, tutto il resto infrastructure', () => {
    expect(defaultServiceRoleOf(['Application'])).toBe('component')
    expect(defaultServiceRoleOf(['Application', 'Infrastructure'])).toBe('infrastructure')
    expect(defaultServiceRoleOf(['Infrastructure'])).toBe('infrastructure')
    expect(defaultServiceRoleOf([])).toBe('infrastructure')
    expect(defaultServiceRoleOf(undefined)).toBe('infrastructure')
  })
})
