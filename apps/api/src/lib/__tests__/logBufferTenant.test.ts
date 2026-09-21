/**
 * LE RIGHE DI LOG DI UN CLIENTE SONO SOLO LE SUE (20 set 2026, dal giro nel
 * browser).
 *
 * La pagina «Log» legge il buffer circolare del PROCESSO, e lo leggeva tutto:
 * un amministratore di un cliente vedeva le righe di ogni altro cliente
 * servito dallo stesso processo — e fra quelle ci sono nomi di CI e numeri di
 * ticket («GraphQL error: CI "DB portale clienti" has no Owner Group»). Il
 * lint sullo scoping non poteva vederlo: qui non c'è nessuna Cypher, c'è un
 * array in memoria.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { pushLog, getLogs, tutteLeRighe, type LogEntry } from '../logBuffer.js'

const riga = (over: Partial<LogEntry>): LogEntry => ({
  id: Math.random().toString(36).slice(2),
  timestamp: new Date().toISOString(),
  level: 'info', module: 'test', message: 'x', data: null, tenantId: null,
  ...over,
})

describe('il buffer dei log è per cliente', () => {
  beforeEach(() => {
    // Il buffer è del modulo: si riempie e si legge, non si azzera. I test
    // guardano quello che hanno appena scritto.
  })

  it('un cliente non vede le righe di un altro', () => {
    pushLog(riga({ tenantId: 'c-uno', message: 'CI «DB portale clienti» senza owner' }))
    pushLog(riga({ tenantId: 'c-due', message: 'roba di un altro cliente' }))
    const suoi = getLogs('c-uno').map((e) => e.message)
    expect(suoi).toContain('CI «DB portale clienti» senza owner')
    expect(suoi).not.toContain('roba di un altro cliente')
  })

  it('le righe di PIATTAFORMA non sono di nessun cliente', () => {
    pushLog(riga({ tenantId: null, message: 'bullmq worker started' }))
    expect(getLogs('c-uno').map((e) => e.message)).not.toContain('bullmq worker started')
    expect(getLogs('c-due').map((e) => e.message)).not.toContain('bullmq worker started')
    // Ci sono: le legge chi amministra la piattaforma.
    expect(tutteLeRighe().map((e) => e.message)).toContain('bullmq worker started')
  })

  it('le righe tornano dalla più recente', () => {
    pushLog(riga({ tenantId: 'c-tre', message: 'prima' }))
    pushLog(riga({ tenantId: 'c-tre', message: 'seconda' }))
    expect(getLogs('c-tre').map((e) => e.message).slice(0, 2)).toEqual(['seconda', 'prima'])
  })
})
