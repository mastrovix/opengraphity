/**
 * AU-3 (revisione del 14 set 2026): «imposta priorità» scriveva `e.priority`
 * sull'incident, che la priorità la tiene in `severity` — il valore restava nel
 * vuoto — e nessuna scrittura automatica manteneva «priorità = impatto ×
 * urgenza» né validava il Dizionario.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../domainMatrix.js', () => import('./domainMatrixFake.js'))
vi.mock('@opengraphity/neo4j', () => ({ runQueryOne: vi.fn(), getSession: vi.fn() }))

const { priorityWrite } = await import('../ticketFieldWrite.js')

describe('priorityWrite', () => {
  it('incident: la priorità va in severity, e impatto e urgenza si riallineano', async () => {
    const out = await priorityWrite('t1', 'incident', 'priority', 'critical', { impact: 'low', urgency: 'low' })
    expect(out).toEqual({ severity: 'critical', impact: 'high', urgency: 'high' })
    expect(out).not.toHaveProperty('priority')
  })
  it('incident: un\'urgenza cambiata ricalcola la priorità dalla matrice', async () => {
    expect(await priorityWrite('t1', 'incident', 'urgency', 'high', { impact: 'high', urgency: 'low' }))
      .toEqual({ severity: 'critical', impact: 'high', urgency: 'high' })
  })
  it('problem: la priorità resta in priority', async () => {
    expect(await priorityWrite('t1', 'problem', 'severity', 'low', { impact: 'medium', urgency: 'medium' }))
      .toEqual({ priority: 'low', impact: 'low', urgency: 'low' })
  })
  it('valori fuori Dizionario e change sono rifiutati', async () => {
    await expect(priorityWrite('t1', 'incident', 'priority', 'altissima', {})).rejects.toThrow(/altissima/)
    await expect(priorityWrite('t1', 'service_request', 'priority', 'altissima', {})).rejects.toThrow(/altissima/)
    await expect(priorityWrite('t1', 'change', 'priority', 'high', {})).rejects.toThrow(/type and risk/)
  })
})
