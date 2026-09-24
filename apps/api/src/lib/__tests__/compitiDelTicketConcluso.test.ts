/**
 * QUANDO IL TICKET SI CONCLUDE, I SUOI COMPITI SI ANNULLANO (rimedio, 20 set
 * 2026).
 *
 * Il difetto: un incident risolto con tre compiti aperti se li portava
 * dietro per sempre. Restavano in «I miei compiti» della squadra, e chi li
 * vedeva non aveva modo di sapere che il lavoro non serviva più. La guardia
 * `all_tasks_complete` protegge solo dove il disegnatore l'ha messa, quindi
 * chiudere un ticket coi compiti aperti è la regola, non l'eccezione.
 *
 * Due scelte che questi test tengono ferme:
 *  - si ANNULLANO, non si completano: nessuno li ha fatti, e scrivere
 *    «fatto» su un lavoro non fatto è una bugia nel registro;
 *  - vale anche per quelli IN ATTESA, che altrimenti aspetterebbero un
 *    turno che non arriva.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const eseguite = vi.hoisted(() => ({ query: '' as string, params: {} as Record<string, unknown> }))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => undefined }),
  toNumber: (v: unknown) => Number(v),
}))
vi.mock('../db.js', () => ({
  runQuery: async (_s: unknown, q: string, p: Record<string, unknown>) => {
    eseguite.query = q
    eseguite.params = p
    return [{ quanti: 3 }]
  },
  runQueryOne: async () => null,
}))
vi.mock('../sequence.js', () => ({ nextSequenceBlock: async () => 1 }))
vi.mock('../ticketTeamHistory.js', () => ({ firstTeamCypher: () => '', TEAM_NOW_PARAM: '__teamNow' }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { annullaCompitiDelTicketConcluso, TASK_STATE } = await import('../ticketTasks.js')

beforeEach(() => { eseguite.query = ''; eseguite.params = {} })

describe('i compiti di un ticket concluso', () => {
  it('si annullano, col motivo scritto dal prodotto', async () => {
    const quanti = await annullaCompitiDelTicketConcluso('t1', 'inc-1', 'Il ticket è stato chiuso')
    expect(quanti).toBe(3)
    expect(eseguite.params['annullato']).toBe(TASK_STATE.CANCELLED)
    expect(eseguite.params['motivo']).toBe('Il ticket è stato chiuso')
  })

  it('NON si completano: nessuno li ha fatti', async () => {
    await annullaCompitiDelTicketConcluso('t1', 'inc-1', 'x')
    expect(eseguite.params['annullato']).not.toBe(TASK_STATE.COMPLETED)
    expect(eseguite.query).not.toContain(`'${TASK_STATE.COMPLETED}'`)
  })

  it('prende anche quelli IN ATTESA, che un turno non l\'avranno mai', async () => {
    await annullaCompitiDelTicketConcluso('t1', 'inc-1', 'x')
    expect(eseguite.params['daFare']).toEqual([TASK_STATE.OPEN, TASK_STATE.WAITING])
  })

  it('resta dentro il suo cliente', async () => {
    await annullaCompitiDelTicketConcluso('c-uno', 'inc-1', 'x')
    expect(eseguite.params['tenantId']).toBe('c-uno')
    expect(eseguite.query).toContain('tenant_id: $tenantId')
  })
})
