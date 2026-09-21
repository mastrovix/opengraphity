/**
 * NT-8 (revisione del 14 set 2026): le regole «Escalation» si salvavano e il
 * job era uno stub — nessuno veniva mai avvisato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let rule: Record<string, unknown> | null = { message: 'Nessuno ci lavora', delay: 30 }
let incident: Record<string, unknown> | null = { title: 'DB giù', number: 'INC7' }
let open = true
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn() })),
  runQuery: vi.fn(async () => [{ id: 'r1', delay: 30 }, { id: 'r2', delay: 120 }]),
  runQueryOne: vi.fn(async (_s: unknown, c: string) => (c.includes('NotificationRule') ? rule : incident)),
}))
vi.mock('../publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('../systemText.js', () => ({ systemText: vi.fn(async (_t: string, _k: string, p: Record<string, unknown>) => `${String(p['title'])} after ${String(p['minutes'])}`) }))
// Revisione totale · C-26: «non risolto» si misura sulla CLASSE del passo
// (resolved/closed), non sul flag «terminale» — un cliente che toglie
// «terminale» al suo Risolto riceveva l'avviso su incident risolti da ore.
vi.mock('../workflowHelpers.js', () => ({ isEntityConcluded: vi.fn(async () => !open) }))
const scheduleEscalationCheck = vi.fn()
vi.mock('../../jobs/workflowJobWorker.js', () => ({ scheduleEscalationCheck: (...a: unknown[]) => scheduleEscalationCheck(...a) }))

const { runEscalationCheck, scheduleNotificationEscalations } = await import('../notificationEscalation.js')
const { publishEvent } = await import('../publishEvent.js')

beforeEach(() => { vi.clearAllMocks(); rule = { message: 'Nessuno ci lavora', delay: 30 }; incident = { title: 'DB giù', number: 'INC7' }; open = true })

describe('escalation delle regole di notifica', () => {
  it('alla nascita dell\'incident: un controllo per regola attiva, dopo il suo ritardo', async () => {
    expect(await scheduleNotificationEscalations('t1', 'i1')).toBe(2)
    expect(scheduleEscalationCheck).toHaveBeenCalledWith('i1', 't1', 'r1', 30)
    expect(scheduleEscalationCheck).toHaveBeenCalledWith('i1', 't1', 'r2', 120)
  })
  it('incident ancora aperto → incident.escalation con il messaggio della regola', async () => {
    expect(await runEscalationCheck('t1', 'i1', 'r1')).toBe('escalated')
    expect(publishEvent).toHaveBeenCalledWith('incident.escalation', 't1', 'system', expect.objectContaining({ id: 'i1', message: 'Nessuno ci lavora', number: 'INC7' }))
  })
  it('messaggio vuoto → testo del sistema con titolo e minuti', async () => {
    rule = { message: '', delay: 45 }
    await runEscalationCheck('t1', 'i1', 'r1')
    expect(publishEvent).toHaveBeenCalledWith('incident.escalation', 't1', 'system', expect.objectContaining({ message: 'DB giù after 45' }))
  })
  it('incident chiuso, regola tolta o spenta → nessun avviso', async () => {
    open = false
    expect(await runEscalationCheck('t1', 'i1', 'r1')).toBe('incident_closed')
    rule = null
    expect(await runEscalationCheck('t1', 'i1', 'r1')).toBe('rule_gone')
    expect(publishEvent).not.toHaveBeenCalled()
  })
})
