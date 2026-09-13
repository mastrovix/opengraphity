/**
 * CHI È IL RESPONSABILE DI UN CONTRATTO: un riferimento, non una stringa.
 *
 * Il campo del team era un testo libero («Es. Network Ops»), e permetteva tre
 * cose tutte sbagliate: scrivere un team che non esiste; scriverne uno
 * esistente con un refuso — due responsabili dove ce n'è uno; e vedere per
 * sempre il nome vecchio dopo una rinomina, perché il nome era COPIATO sul
 * contratto. Un team di questo cliente è un'entità: si cita per id.
 *
 * Il fornitore esterno non è un'entità del prodotto e resta una stringa: è la
 * forma giusta per lui, e questi test pinnano che le due forme non si mescolino.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const admin = { tenantId: 't1', userId: 'u1', role: 'admin' } as never

let righe: Record<string, unknown>[] = []
let unaRiga: Record<string, unknown> | null = null
const cypher: string[] = []

vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return {
    ...orig,
    runQuery: vi.fn(async (_s: unknown, q: string) => { cypher.push(q); return righe }),
    runQueryOne: vi.fn(async (_s: unknown, q: string) => { cypher.push(q); return unaRiga }),
  }
})
vi.mock('../ci-utils.js', () => ({ withSession: async (fn: (s: unknown) => unknown) => fn({}) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))

const { createOLAContract, updateOLAContract } = await import('../ola.js')

const props = (over: Record<string, unknown> = {}) => ({
  id: 'ola-1', type: 'ola', name: 'Rete entro 4h', entity_type: 'incident',
  response_minutes: 60, resolve_minutes: 240, business_hours: false,
  party_type: 'team', party_name: null, team_id: 'team-noc', enabled: true, created_at: 'ora',
  ...over,
})

const INPUT = {
  type: 'ola', name: 'Rete entro 4h', entityType: 'incident',
  responseMinutes: 60, resolveMinutes: 240,
}

beforeEach(() => { cypher.length = 0; righe = [{ props: props(), teamName: 'NOC' }]; unaRiga = null })

async function errore(p: Promise<unknown>): Promise<{ message: string; extensions: Record<string, unknown> }> {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e, 'la chiamata doveva fallire').not.toBeNull()
  return e as { message: string; extensions: Record<string, unknown> }
}

describe('createOLAContract — il responsabile', () => {
  it('un team si cita per ID, e il suo nome NON viene copiato sul contratto', async () => {
    unaRiga = { name: 'NOC' }   // il team esiste
    await createOLAContract(null, { input: { ...INPUT, partyType: 'team', teamId: 'team-noc', partyName: 'scritto a mano' } }, admin)
    const create = cypher.find((q) => q.includes('CREATE (o:OLAContract'))!
    expect(create).toContain('team_id: $teamId')
    // Il nome scritto a mano si scarta: la verità è il nome del team, risolto
    // in lettura. Copiarlo qui vorrebbe dire mostrarlo vecchio dopo una rinomina.
    const { runQuery } = await import('@opengraphity/neo4j')
    const params = vi.mocked(runQuery).mock.calls.at(-1)![2] as Record<string, unknown>
    expect(params['partyName']).toBeNull()
    expect(params['teamId']).toBe('team-noc')
  })

  it('senza il team il rifiuto lo dice, invece di salvare un responsabile che non esiste', async () => {
    const e = await errore(createOLAContract(null, { input: { ...INPUT, partyType: 'team' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.teamRequired' })
    expect(cypher.some((q) => q.includes('CREATE'))).toBe(false)
  })

  it('un team di un ALTRO cliente (o inesistente) è un rifiuto che lo nomina', async () => {
    unaRiga = null   // nessun :Team con quell'id in questo tenant
    const e = await errore(createOLAContract(null, { input: { ...INPUT, partyType: 'team', teamId: 'team-di-altri' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.teamUnknown', params: { team: 'team-di-altri' } })
    expect(cypher.some((q) => q.includes('CREATE'))).toBe(false)
  })

  it('un FORNITORE esterno resta una stringa: non sta fra i team, e il nome serve', async () => {
    righe = [{ props: props({ party_type: 'supplier', party_name: 'Acme Cloud', team_id: null }), teamName: null }]
    await createOLAContract(null, { input: { ...INPUT, type: 'uc', partyType: 'supplier', partyName: 'Acme Cloud' } }, admin)
    const { runQuery } = await import('@opengraphity/neo4j')
    const params = vi.mocked(runQuery).mock.calls.at(-1)![2] as Record<string, unknown>
    expect(params['partyName']).toBe('Acme Cloud')
    expect(params['teamId']).toBeNull()
  })

  it('un fornitore senza nome è un rifiuto: sarebbe un contratto senza controparte', async () => {
    const e = await errore(createOLAContract(null, { input: { ...INPUT, type: 'uc', partyType: 'supplier' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.supplierNameRequired' })
  })
})

describe('updateOLAContract — il responsabile', () => {
  it('passando a fornitore il riferimento al team si scorda (le due forme non convivono)', async () => {
    unaRiga = { partyType: 'team', teamId: 'team-noc', partyName: null }
    righe = [{ props: props({ party_type: 'supplier', party_name: 'Acme', team_id: null }), teamName: null }]
    await updateOLAContract(null, { id: 'ola-1', input: { partyType: 'supplier', partyName: 'Acme' } }, admin)
    const { runQuery } = await import('@opengraphity/neo4j')
    const params = vi.mocked(runQuery).mock.calls.at(-1)![2] as { sets: Record<string, unknown> }
    expect(params.sets['team_id']).toBeNull()
    expect(params.sets['party_name']).toBe('Acme')
  })

  it('passando a team si scorda il nome scritto a mano', async () => {
    unaRiga = { partyType: 'supplier', teamId: null, partyName: 'Acme' }
    await updateOLAContract(null, { id: 'ola-1', input: { partyType: 'team', teamId: 'team-noc' } }, admin)
    const { runQuery } = await import('@opengraphity/neo4j')
    const params = vi.mocked(runQuery).mock.calls.at(-1)![2] as { sets: Record<string, unknown> }
    expect(params.sets['party_name']).toBeNull()
    expect(params.sets['team_id']).toBe('team-noc')
  })

  /**
   * Il caso che una validazione sull'INPUT non prende: la modifica manda solo
   * il tipo, e la metà che conta è quella già salvata.
   */
  it('cambiare tipo a team SENZA mandare il team è un rifiuto, non un contratto rotto', async () => {
    unaRiga = { partyType: 'supplier', teamId: null, partyName: 'Acme' }
    const e = await errore(updateOLAContract(null, { id: 'ola-1', input: { partyType: 'team' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.teamRequired' })
    expect(cypher.some((q) => q.includes('SET o +='))).toBe(false)
  })

  it('una modifica che non tocca il responsabile non lo rivalida', async () => {
    await updateOLAContract(null, { id: 'ola-1', input: { responseMinutes: 30 } }, admin)
    // La query che VALIDA il team (`MATCH (t:Team {id: $teamId ...})`) non parte.
    // Quella che ne LEGGE il nome sì, sempre: è l'`OPTIONAL MATCH` della
    // lettura, e serve a restituire `teamName` — che è il motivo per cui il
    // nome non è copiato sul contratto.
    expect(cypher.some((q) => q.includes('MATCH (t:Team {id: $teamId'))).toBe(false)
    expect(cypher.some((q) => q.includes('SET o +='))).toBe(true)
  })
})
