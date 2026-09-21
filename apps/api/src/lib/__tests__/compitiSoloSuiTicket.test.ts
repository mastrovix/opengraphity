/**
 * UN COMPITO STA SOLO SU UN TICKET (rimedio, 20 set 2026).
 *
 * L'azione `create_task` era offerta su ogni tipo di entità che il motore sa
 * muovere, e fra quelli c'è l'articolo della knowledge base. Un compito su
 * un articolo sarebbe stato **legale e irraggiungibile**: nessuna pagina
 * della KB mostra i compiti, «I miei compiti» non sa dove portare (un
 * articolo non ha numero né una rotta fra quelle dei ticket), e con la
 * guardia `all_tasks_complete` l'articolo si sarebbe bloccato senza che
 * esista un'interfaccia per sbloccarlo.
 *
 * La risposta era già scritta accanto alla mappa delle etichette:
 * `TICKET_ENTITY_TYPES`, col commento «l'articolo della knowledge base non è
 * un ticket». Bastava leggerla.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => undefined }),
  toNumber: (v: unknown) => Number(v),
}))
const finto = vi.hoisted(() => ({ esisteGia: false, numeriPresi: 0 }))

vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  runQuery: async () => [{ id: 'task-1', teamId: null }],
  runQueryOne: async (_s: unknown, q: string) =>
    (q.includes('task_key: $chiave') && finto.esisteGia ? { id: 'task-vecchio' } : null),
}))
vi.mock('../sequence.js', () => ({
  nextSequenceBlock: async () => { finto.numeriPresi += 1; return finto.numeriPresi },
}))
vi.mock('../ticketTeamHistory.js', () => ({ firstTeamCypher: () => '', TEAM_NOW_PARAM: '__teamNow' }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { creaCompito } = await import('../ticketTasks.js')

const compito = (entityType: string) => ({
  tenantId: 't1', entityId: 'e-1', entityType, stepName: 's', actionIndex: 0,
  title: 'X', description: null, teamId: null, teamFromField: null,
  dueInDays: null, after: null, createdBy: 'u',
})

describe('su cosa può stare un compito', () => {
  for (const tipo of ['incident', 'problem', 'change', 'service_request']) {
    it(`su un ${tipo} sì`, async () => {
      await expect(creaCompito(compito(tipo))).resolves.toBe('task-1')
    })
  }

  it('su un ARTICOLO della knowledge base no, e si dice perché', async () => {
    await expect(creaCompito(compito('kb_article'))).rejects.toThrow(/is not a ticket/)
  })

  it('su un tipo che il prodotto non conosce no', async () => {
    await expect(creaCompito(compito('pratica_del_futuro'))).rejects.toThrow(/is not a ticket/)
  })
})

describe('la numerazione non fa buchi', () => {
  it('rientrare nello stesso passo NON brucia un numero', async () => {
    finto.numeriPresi = 0

    finto.esisteGia = false
    await creaCompito(compito('incident'))
    expect(finto.numeriPresi, 'il primo task prende il suo numero').toBe(1)

    // Stessa chiave naturale: la MERGE non crea niente, e il contatore non
    // deve muoversi. Prima si prendeva un numero comunque, e la numerazione
    // usciva coi buchi.
    finto.esisteGia = true
    await creaCompito(compito('incident'))
    expect(finto.numeriPresi, 'il rientro non prende niente').toBe(1)
  })
})
