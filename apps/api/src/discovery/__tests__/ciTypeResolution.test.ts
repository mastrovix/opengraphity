/**
 * La discovery non inventa più tipi (ondata 6 · A-11).
 *
 * Prima: `label = PascalCase(ci_type)` e via — un CSV con `ci_type =
 * "Bilanciatore"` creava `:ConfigurationItem:Bilanciatore`, che nessuna pagina
 * mostra; un refuso creava un'etichetta per variante; e `inferCIType` produce
 * `load_balancer`, `container`, `network`, tre tipi che il prodotto non ha.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const loadMetamodel = vi.fn()
vi.mock('@opengraphity/schema-generator', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadMetamodel,
}))

const { CITypeResolver, pascalCaseOf } = await import('../ciTypeResolution.js')
const { ciTypeAliases } = await import('@opengraphity/discovery')

type Rule = { kind?: 'property' | 'ci_type'; source_field: string; target_field: string }
const source = (rules: Rule[] = []) => ({ mapping_rules: rules as never })

const TYPES = [
  { name: 'server',            neo4jLabel: 'Server',            scope: 'base',   active: true },
  { name: 'database_instance', neo4jLabel: 'DatabaseInstance',  scope: 'base',   active: true },
  { name: 'bilanciatore',      neo4jLabel: 'Bilanciatore',      scope: 'tenant', active: true },
]

beforeEach(() => { vi.clearAllMocks(); loadMetamodel.mockResolvedValue(TYPES) })

describe('CITypeResolver', () => {
  it('risolve per nome del tipo, senza badare alle maiuscole', async () => {
    const r = await CITypeResolver.forSource('c-two', source())
    expect(r.resolve('server')).toEqual({ ok: true, type: { name: 'server', label: 'Server' }, via: 'name' })
    expect(r.resolve(' Server ')).toMatchObject({ ok: true, type: { label: 'Server' } })
  })

  it('risolve per etichetta, anche nella forma PascalCase che i connettori producono', async () => {
    const r = await CITypeResolver.forSource('c-two', source())
    expect(r.resolve('Bilanciatore')).toMatchObject({ ok: true, type: { name: 'bilanciatore' } })
    // il connettore manda snake_case: `database_instance` è già il nome, ma
    // `DatabaseInstance` (l'etichetta) va riconosciuta comunque
    expect(r.resolve('DatabaseInstance')).toMatchObject({ ok: true, type: { name: 'database_instance' } })
  })

  it('gli alias REST storici dei tipi spediti valgono solo se il tipo è attivo', async () => {
    const r = await CITypeResolver.forSource('c-two', source())
    expect(r.resolve('db_instance')).toMatchObject({ ok: true, type: { name: 'database_instance' }, via: 'alias' })
    // `ssl_certificate` è nella tabella storica ma nessun tipo attivo ha quell'etichetta
    expect(r.resolve('ssl_certificate')).toMatchObject({ ok: false })
  })

  it('un alias dichiarato nelle mapping_rules risolve il tipo del cliente, e vince sugli storici', async () => {
    const r = await CITypeResolver.forSource('c-two', source([
      { kind: 'ci_type', source_field: 'load_balancer', target_field: 'bilanciatore' },
      { kind: 'ci_type', source_field: 'db_instance',   target_field: 'server' },
    ]))
    expect(r.resolve('load_balancer')).toEqual({ ok: true, type: { name: 'bilanciatore', label: 'Bilanciatore' }, via: 'alias' })
    expect(r.resolve('ELB')).toMatchObject({ ok: false })
    expect(r.resolve('db_instance')).toMatchObject({ ok: true, type: { name: 'server' } })
  })

  it('un alias che punta a un tipo inesistente lo DICE, invece di ricadere sul nome in arrivo', async () => {
    const r = await CITypeResolver.forSource('c-two', source([
      { kind: 'ci_type', source_field: 'elb', target_field: 'bilanciatoer' },
    ]))
    const out = r.resolve('elb')
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toMatch(/l'alias "elb" punta al tipo "bilanciatoer"/)
  })

  it('un tipo sconosciuto dice cosa fare e quali tipi ci sono (mai un\'etichetta inventata)', async () => {
    const r = await CITypeResolver.forSource('c-two', source())
    const out = r.resolve('Bilanciatoer')
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain('crea il tipo nel disegnatore')
    expect(out.ok === false && out.reason).toContain('"kind":"ci_type"')
    expect(out.ok === false && out.reason).toContain('bilanciatore, database_instance, server')
  })

  it('ci_type vuoto è un difetto del connettore, e si dice', async () => {
    const r = await CITypeResolver.forSource('c-two', source())
    expect(r.resolve('   ')).toMatchObject({ ok: false })
    expect((r.resolve('') as { reason: string }).reason).toMatch(/vuoto/)
  })

  it('i tipi di due clienti non si mescolano', async () => {
    loadMetamodel.mockImplementation(async (t: string) => (t === 'c-two' ? TYPES : [TYPES[0]]))
    expect((await CITypeResolver.forSource('c-two', source())).resolve('bilanciatore').ok).toBe(true)
    expect((await CITypeResolver.forSource('c-one', source())).resolve('bilanciatore').ok).toBe(false)
  })

  it('pascalCaseOf', () => {
    expect(pascalCaseOf('load_balancer')).toBe('LoadBalancer')
    expect(pascalCaseOf('bilanciatore')).toBe('Bilanciatore')
  })
})

describe('ciTypeAliases (packages/discovery)', () => {
  it('legge solo le regole kind: ci_type, in minuscolo', () => {
    expect([...ciTypeAliases([
      { source_field: 'env', target_field: 'environment' },
      { kind: 'ci_type', source_field: 'ELB', target_field: 'bilanciatore' },
    ])]).toEqual([['elb', 'bilanciatore']])
  })

  it('una regola ci_type con un capo vuoto è un errore, non un alias che non mappa niente', () => {
    expect(() => ciTypeAliases([{ kind: 'ci_type', source_field: 'ELB', target_field: '  ' }])).toThrow(/ci_type/)
    expect(() => ciTypeAliases([{ kind: 'ci_type', source_field: '', target_field: 'server' }])).toThrow(/ci_type/)
  })
})
