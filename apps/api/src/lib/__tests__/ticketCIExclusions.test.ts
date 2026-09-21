/**
 * I tipi di CI esclusi per tipo di ticket (revisione del 15 set 2026 · CM-8).
 *
 * Le vecchie regole «tipi ammessi» valevano in due punti su sei: aggiungere un
 * CI a un incident o a un problem già aperti. Non alla creazione, non per le
 * change, e il loro tipo di relazione non lo leggeva nessuno. Qui si pinnano
 * la regola nuova e, soprattutto, che OGNI scrittura di un collegamento
 * ticket → CI passi dal controllo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TICKET_CI_RELATIONSHIP } from '@opengraphity/types'

const rows: { exclusions: string[]; cis: { id: string; name: string; labels: string[] }[] } = { exclusions: [], cis: [] }
const writes: { cypher: string; params: Record<string, unknown> }[] = []

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    close: vi.fn(),
    executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: (cypher: string, params: Record<string, unknown>) => { writes.push({ cypher, params }); return Promise.resolve({ records: [] }) } })),
  })),
  runQuery: vi.fn(async (_s: unknown, cypher: string) => (cypher.includes('TicketCIExclusion')
    ? rows.exclusions.map((ciType) => ({ ciType }))
    : rows.cis)),
}))
vi.mock('@opengraphity/schema-generator', () => ({
  loadMetamodel: vi.fn(async () => [
    { name: 'server',      label: 'Server',      neo4jLabel: 'Server' },
    { name: 'certificate', label: 'Certificate', neo4jLabel: 'Certificate' },
    { name: 'firewall',    label: 'Firewall',    neo4jLabel: 'Firewall' },
  ]),
}))
const invalidateSchema = vi.fn()
vi.mock('../schemaInvalidator.js', () => ({ invalidateSchema: (t: string) => invalidateSchema(t), registerMetamodelCacheClearer: vi.fn() }))

const { assertCIsLinkable, setTicketCIExclusions, excludedCITypes, assertTicketCIType } = await import('../ticketCIExclusions.js')

beforeEach(() => { rows.exclusions = []; rows.cis = []; writes.length = 0; vi.clearAllMocks() })

describe('assertCIsLinkable', () => {
  it('nessuna esclusione = tutti ammessi, senza nemmeno leggere i CI', async () => {
    await expect(assertCIsLinkable('t-none', 'incident', ['ci-1'])).resolves.toBeUndefined()
  })

  it('un CI di un tipo escluso ferma tutto, e l\'errore nomina il CI, il tipo e dove si toglie', async () => {
    rows.exclusions = ['certificate']
    rows.cis = [
      { id: 'ci-1', name: 'SRV-01', labels: ['ConfigurationItem', 'Server'] },
      { id: 'ci-2', name: 'cert-portale', labels: ['ConfigurationItem', 'Certificate'] },
    ]
    const err = await assertCIsLinkable('t-cert', 'incident', ['ci-1', 'ci-2']).then(() => null, (e: unknown) => e as Error & { extensions: Record<string, unknown> })
    expect(err?.message).toContain('cert-portale (Certificate)')
    expect(err?.message).not.toContain('SRV-01')
    expect(err?.extensions['i18n']).toMatchObject({ key: 'errors.ticketCI.excluded', params: { ticketType: 'incident', cis: 'cert-portale (Certificate)' } })
  })

  it('i tipi ammessi passano', async () => {
    rows.exclusions = ['certificate']
    rows.cis = [{ id: 'ci-1', name: 'SRV-01', labels: ['ConfigurationItem', 'Server'] }]
    await expect(assertCIsLinkable('t-srv', 'change', ['ci-1'])).resolves.toBeUndefined()
  })
})

describe('setTicketCIExclusions', () => {
  it('sostituisce l\'elenco e invalida le cache del metamodello (anche negli altri processi)', async () => {
    const out = await setTicketCIExclusions('t1', 'service_request', ['firewall', 'certificate', 'firewall'])
    expect(out).toEqual({ ticketType: 'service_request', ciTypes: ['certificate', 'firewall'] })
    expect(writes[0]!.cypher).toContain('WHERE NOT x.ci_type IN $wanted')
    expect(writes[1]!.cypher).toContain('MERGE (x:TicketCIExclusion {tenant_id: $tenantId, ticket_type: $ticketType, ci_type: ciType})')
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
  })

  it('un tipo CI che il cliente non ha è rifiutato: un\'esclusione verso il nulla non escluderebbe niente', async () => {
    await expect(setTicketCIExclusions('t1', 'incident', ['bilanciatore'])).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.ticketCI.unknownCIType' } } })
    expect(writes).toHaveLength(0)
  })

  it('un tipo di ticket che non si collega ai CI è rifiutato', () => {
    expect(() => assertTicketCIType('kb_article')).toThrow(/does not link CIs/)
  })

  it('le quattro categorie di ticket si collegano ai CI, richieste comprese', async () => {
    expect(Object.keys(TICKET_CI_RELATIONSHIP).sort()).toEqual(['change', 'incident', 'problem', 'service_request'])
    await expect(excludedCITypes('t9', 'service_request')).resolves.toEqual([])
  })
})

describe('ogni scrittura di un collegamento ticket → CI passa dal controllo', () => {
  const SRC = join(process.cwd(), 'src')
  const REL = Object.values(TICKET_CI_RELATIONSHIP).join('|')
  // Il tipo scritto per esteso, o interpolato dalla costante (`${TICKET_CI_RELATIONSHIP.x}`, `${REQUEST_CI}`).
  const WRITE = new RegExp(String.raw`(MERGE|CREATE)\s*\(\w+\)-\[\w*:((${REL})\b|\$\{(TICKET_CI_RELATIONSHIP|REQUEST_CI)[^}]*\})`)

  function sorgenti(dir: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (!['__tests__', 'migrations', 'scripts'].includes(e.name)) out.push(...sorgenti(p)) }
      else if (e.name.endsWith('.ts')) out.push(p)
    }
    return out
  }
  const scrittori = sorgenti(SRC).filter((f) => WRITE.test(readFileSync(f, 'utf8')))

  it('la lettura trova gli scrittori (se questo cade, il guardiano è finto)', () => {
    expect(scrittori.length).toBeGreaterThanOrEqual(7)
  })

  it.each(scrittori.map((f) => f.slice(SRC.length + 1)))('%s chiama assertCIsLinkable', (file) => {
    expect(readFileSync(join(SRC, file), 'utf8'), `${file} scrive un collegamento ticket → CI senza controllare le esclusioni`).toContain('assertCIsLinkable(')
  })
})
