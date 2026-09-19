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
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  runQuery: async () => [{ id: 'task-1', teamId: null }],
  runQueryOne: async () => null,
}))
vi.mock('../sequence.js', () => ({ nextSequenceBlock: async () => 1 }))
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
