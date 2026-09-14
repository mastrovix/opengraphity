/**
 * CHI È IL RESPONSABILE DI UN CONTRATTO: un riferimento, non una stringa.
 *
 * Il campo del team era un testo libero («Es. Network Ops»), e permetteva tre
 * cose tutte sbagliate: scrivere un team che non esiste; scriverne uno
 * esistente con un refuso — due responsabili dove ce n'è uno; e vedere per
 * sempre il nome vecchio dopo una rinomina, perché il nome era COPIATO sul
 * contratto. Un team di questo cliente è un'entità: si cita per id.
 *
 * E il FORNITORE esterno è anche lui un team: da quando ogni team dice se è
 * interno o esterno (`Team.sourcing`), «team interno» vuol dire un team con
 * sourcing = internal e «fornitore esterno» un team con sourcing = external. Il
 * nome del fornitore scritto a mano non esiste più.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const admin = { tenantId: 't1', userId: 'u1', role: 'admin' } as never

let righe: Record<string, unknown>[] = []
let unaRiga: Record<string, unknown> | null = null
/** Risposte in ordine per `runQueryOne` (lo stato attuale del contratto, poi il team). */
let coda: (Record<string, unknown> | null)[] = []
const cypher: string[] = []

vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return {
    ...orig,
    runQuery: vi.fn(async (_s: unknown, q: string) => { cypher.push(q); return righe }),
    runQueryOne: vi.fn(async (_s: unknown, q: string) => { cypher.push(q); return coda.length > 0 ? coda.shift()! : unaRiga }),
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
  // Ondata 2: l'obiettivo di conformità è obbligatorio; nessun calendario = 24×7.
  complianceTarget: 95, complianceWarning: 80,
}

beforeEach(() => { cypher.length = 0; righe = [{ props: props(), teamName: 'NOC' }]; unaRiga = null; coda = [] })

async function errore(p: Promise<unknown>): Promise<{ message: string; extensions: Record<string, unknown> }> {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e, 'la chiamata doveva fallire').not.toBeNull()
  return e as { message: string; extensions: Record<string, unknown> }
}

describe('createOLAContract — il responsabile è un team col Sourcing giusto', () => {
  it('team interno: un team con sourcing internal, citato per ID, senza copiarne il nome', async () => {
    unaRiga = { name: 'NOC', sourcing: 'internal' }
    await createOLAContract(null, { input: { ...INPUT, partyType: 'team', teamId: 'team-noc' } }, admin)
    const create = cypher.find((q) => q.includes('CREATE (o:OLAContract'))!
    expect(create).toContain('team_id: $teamId')
    const { runQuery } = await import('@opengraphity/neo4j')
    const params = vi.mocked(runQuery).mock.calls.at(-1)![2] as Record<string, unknown>
    expect(params['partyName']).toBeNull()
    expect(params['teamId']).toBe('team-noc')
  })

  it('fornitore esterno: un team con sourcing external, anche lui citato per ID', async () => {
    unaRiga = { name: 'Acme Cloud', sourcing: 'external' }
    righe = [{ props: props({ type: 'uc', party_type: 'supplier', team_id: 'team-acme' }), teamName: 'Acme Cloud' }]
    await createOLAContract(null, { input: { ...INPUT, type: 'uc', partyType: 'supplier', teamId: 'team-acme' } }, admin)
    const { runQuery } = await import('@opengraphity/neo4j')
    const params = vi.mocked(runQuery).mock.calls.at(-1)![2] as Record<string, unknown>
    expect(params['teamId']).toBe('team-acme')
    expect(params['partyName']).toBeNull()
  })

  it.each([
    ['team',     'external', 'pages.teams.sourcing.internal', 'pages.teams.sourcing.external'],
    ['supplier', 'internal', 'pages.teams.sourcing.external', 'pages.teams.sourcing.internal'],
    ['supplier', null,       'pages.teams.sourcing.external', 'pages.teams.sourcing.notSet'],
  ])('responsabile %s con un team di sourcing %s → rifiuto che dice quale serviva', async (partyType, sourcing, expectedKey, actualKey) => {
    unaRiga = { name: 'Rete', sourcing }
    const e = await errore(createOLAContract(null, { input: { ...INPUT, partyType, teamId: 'team-x' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.teamWrongSourcing', params: { team: 'Rete', expectedKey, actualKey } })
    expect(cypher.some((q) => q.includes('CREATE'))).toBe(false)
  })

  it.each([['team', 'errors.ola.teamRequired'], ['supplier', 'errors.ola.supplierTeamRequired']])(
    'responsabile %s senza team → rifiuto, nessuna scrittura', async (partyType, key) => {
      const e = await errore(createOLAContract(null, { input: { ...INPUT, partyType } }, admin))
      expect(e.extensions['i18n']).toMatchObject({ key })
      expect(cypher.some((q) => q.includes('CREATE'))).toBe(false)
    })

  it('un team di un ALTRO cliente (o inesistente) è un rifiuto che lo nomina', async () => {
    unaRiga = null
    const e = await errore(createOLAContract(null, { input: { ...INPUT, partyType: 'supplier', teamId: 'team-di-altri' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.teamUnknown', params: { team: 'team-di-altri' } })
  })

  it('un tipo di responsabile sconosciuto è un rifiuto', async () => {
    const e = await errore(createOLAContract(null, { input: { ...INPUT, partyType: 'vendor', teamId: 't' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.partyTypeOneOf' })
  })
})

describe('updateOLAContract — il responsabile', () => {
  it('cambiare tipo E team: si valida il team nuovo contro il tipo nuovo', async () => {
    coda = [{ partyType: 'team', teamId: 'team-noc' }, { name: 'Acme', sourcing: 'external' }]
    await updateOLAContract(null, { id: 'ola-1', input: { partyType: 'supplier', teamId: 'team-acme' } }, admin)
    const { runQuery } = await import('@opengraphity/neo4j')
    const params = vi.mocked(runQuery).mock.calls.at(-1)![2] as { sets: Record<string, unknown> }
    expect(params.sets['team_id']).toBe('team-acme')
    expect(params.sets['party_name']).toBeNull()
  })

  /**
   * Il caso che una validazione sull'INPUT non prende: si cambia solo il TIPO,
   * e il team già salvato ha il Sourcing dell'altro tipo.
   */
  it('cambiare solo il tipo tenendo il team di prima è un rifiuto: il suo Sourcing non torna', async () => {
    coda = [{ partyType: 'team', teamId: 'team-noc' }, { name: 'NOC', sourcing: 'internal' }]
    const e = await errore(updateOLAContract(null, { id: 'ola-1', input: { partyType: 'supplier' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.teamWrongSourcing' })
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
