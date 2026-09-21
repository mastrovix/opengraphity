/**
 * IL PASSO ASPETTA I SUOI COMPITI (20 set 2026, ondata 2).
 *
 * La decisione del proprietario è «no: il passo aspetta». È la ragione per
 * cui esiste un compito invece di una nota — se non blocca, nessuno lo
 * chiude. Qui si tiene ferma la forma esatta della guardia, che è fatta di
 * tre esclusioni facili da sbagliare:
 *
 *  - contano i compiti DEL PASSO che si sta lasciando, non tutti quelli del
 *    ticket: altrimenti un compito rimasto aperto tre passi fa bloccherebbe
 *    per sempre un ticket che è andato avanti;
 *  - conta anche chi è IN ATTESA del suo turno: è lavoro non fatto, non
 *    lavoro che non c'è;
 *  - NON contano gli annullati: annullare è una decisione presa, non un
 *    lavoro rimasto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { registerCondition: vi.fn(), onStepEntered: vi.fn() },
  registerTaskCreator: vi.fn(),
}))
vi.mock('./stepEnteredEvents.js', () => ({}))
vi.mock('../stepEnteredEvents.js', () => ({}))

const compiti = vi.hoisted(() => ({ righe: [] as { step: string; state: string }[] }))

vi.mock('../../lib/ticketTasks.js', () => ({
  compitiDaFareNelPasso: async (_s: unknown, _t: string, _e: string, step: string) =>
    compiti.righe.filter((k) => k.step === step && (k.state === 'open' || k.state === 'waiting')).length,
}))

const { CHANGE_CONDITIONS } = await import('../conditions.js')

const contesto = (fromStepName: string) => ({
  instanceId: 'wi-1', entityId: 'sr-1', entityType: 'service_request', tenantId: 't1',
  fromStepName, toStepName: 'fulfilled', triggerType: 'manual' as const, entityData: {},
})

const valuta = (step: string) =>
  CHANGE_CONDITIONS['all_tasks_complete']!.evaluate(null as never, contesto(step))

beforeEach(() => { compiti.righe = [] })

describe('all_tasks_complete', () => {
  it('senza compiti il passo si lascia', async () => {
    expect(await valuta('in_progress')).toBe(true)
  })

  it('un compito APERTO in questo passo lo tiene fermo', async () => {
    compiti.righe = [{ step: 'in_progress', state: 'open' }]
    expect(await valuta('in_progress')).toBe(false)
  })

  it('un compito IN ATTESA lo tiene fermo: è lavoro non fatto', async () => {
    compiti.righe = [{ step: 'in_progress', state: 'waiting' }]
    expect(await valuta('in_progress')).toBe(false)
  })

  it('un compito ANNULLATO non lo tiene fermo: è una decisione, non un lavoro', async () => {
    compiti.righe = [{ step: 'in_progress', state: 'cancelled' }]
    expect(await valuta('in_progress')).toBe(true)
  })

  it('tutti chiusi: si passa', async () => {
    compiti.righe = [{ step: 'in_progress', state: 'completed' }, { step: 'in_progress', state: 'cancelled' }]
    expect(await valuta('in_progress')).toBe(true)
  })

  /**
   * Il difetto che questa forma evita: contare i compiti di TUTTO il ticket.
   * Un compito rimasto aperto in un passo precedente bloccherebbe ogni
   * transizione successiva, per sempre, senza che nessuno capisca perché.
   */
  it('un compito aperto di un ALTRO passo non c\'entra', async () => {
    compiti.righe = [{ step: 'approval', state: 'open' }]
    expect(await valuta('in_progress')).toBe(true)
  })

  it('la condizione è dichiarata, quindi il disegnatore la offre', async () => {
    const { WORKFLOW_TRANSITION_CONDITIONS } = await import('@opengraphity/types')
    expect(WORKFLOW_TRANSITION_CONDITIONS).toContain('all_tasks_complete')
  })
})
