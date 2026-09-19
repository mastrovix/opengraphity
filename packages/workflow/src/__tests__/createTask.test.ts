/**
 * L'AZIONE `create_task` (20 set 2026, ondata 1).
 *
 * Due cose che questi test tengono ferme, e che sono il cuore della
 * decisione:
 *
 *  1. **Il tipo del compito non è un parametro.** Lo eredita dall'istanza,
 *     cioè dalla definizione di workflow che contiene il passo. È la prima
 *     delle tre difese sulla regola «un compito di tipo incident non sta su
 *     una change»: qui non è nemmeno esprimibile, e nessun parametro scritto
 *     a mano può cambiarlo.
 *  2. **Chi scrive è il REGISTRO, non il contesto della chiamata.** Tre dei
 *     cinque punti che costruiscono un `ActionContext` lo costruiscono
 *     povero — l'approvazione fra questi, cioè proprio «richiesta approvata →
 *     partono i compiti». Con un callback nel contesto, lì i compiti non
 *     sarebbero nati e la transizione sarebbe riuscita lo stesso, perché il
 *     motore raccoglie gli errori delle azioni invece di annullare il passo.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runAction } from '../actions.js'
import { registerTaskCreator, clearTaskCreator } from '../taskCreator.js'
import type { TaskToCreate } from '../taskCreator.js'
import type { WorkflowActionConfig, WorkflowInstance, ActionContext } from '../types.js'

const istanza = (over: Partial<WorkflowInstance> = {}): WorkflowInstance => ({
  id: 'wi-1', tenantId: 't1', definitionId: 'def-1',
  entityId: 'sr-1', entityType: 'service_request',
  currentStep: 'in_progress', status: 'active',
  createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z',
  ...over,
})

const azione = (params: Record<string, unknown>): WorkflowActionConfig =>
  ({ type: 'create_task', params } as unknown as WorkflowActionConfig)

const contesto: ActionContext = { userId: 'u-1', entityData: { id: 'sr-1', title: 'Nuovo portatile' } }

let scritti: TaskToCreate[] = []

beforeEach(() => {
  scritti = []
  clearTaskCreator()
  registerTaskCreator(async (task) => { scritti.push(task); return 'task-1' })
})

describe('create_task', () => {
  it('scrive il compito con la squadra scelta nel disegnatore', async () => {
    await runAction(azione({ title_template: 'Prepara la macchina', team_id: 'team-desk', due_in_days: '2' }), istanza(), contesto)
    expect(scritti).toHaveLength(1)
    expect(scritti[0]).toMatchObject({
      tenantId: 't1', entityId: 'sr-1', title: 'Prepara la macchina',
      teamId: 'team-desk', dueInDays: 2, createdBy: 'u-1',
    })
  })

  it('IL TIPO lo eredita dal workflow: non è un parametro, e non si può scavalcare', async () => {
    await runAction(
      // Anche scrivendolo a mano nei parametri, non arriva a chi scrive.
      azione({ title_template: 'X', entity_type: 'incident', type: 'incident' }),
      istanza({ entityType: 'change', entityId: 'chg-9' }),
      contesto,
    )
    expect(scritti[0]!.entityType).toBe('change')
  })

  it('porta il PASSO che l\'ha creato: la guardia dovrà sapere quali compiti sono suoi', async () => {
    await runAction(azione({ title_template: 'X' }), istanza({ currentStep: 'fulfilment' }), { ...contesto, actionIndex: 3 })
    expect(scritti[0]).toMatchObject({ stepName: 'fulfilment', actionIndex: 3 })
  })

  it('il titolo passa dai segnaposto, come le altre azioni', async () => {
    await runAction(azione({ title_template: 'Prepara: {title}' }), istanza(), contesto)
    expect(scritti[0]!.title).toBe('Prepara: Nuovo portatile')
  })

  it('un titolo vuoto è un errore, non un compito muto', async () => {
    await expect(runAction(azione({ title_template: '   ' }), istanza(), contesto)).rejects.toThrow(/empty title/)
    expect(scritti).toHaveLength(0)
  })

  it('una scadenza che non è un numero di giorni è un errore', async () => {
    await expect(runAction(azione({ title_template: 'X', due_in_days: 'domani' }), istanza(), contesto)).rejects.toThrow(/due_in_days/)
  })

  it('senza squadra il compito nasce lo stesso, senza destinatario', async () => {
    await runAction(azione({ title_template: 'X' }), istanza(), contesto)
    expect(scritti[0]!.teamId).toBeNull()
  })

  /**
   * Il difetto che il registro evita: se lo scrittore arrivasse dal contesto
   * della chiamata, sui cammini poveri non ci sarebbe e i compiti non
   * nascerebbero — in silenzio, perché il motore non annulla la transizione
   * per un'azione fallita. Senza registro si grida.
   */
  it('senza nessuno che sappia scrivere i compiti, si grida', async () => {
    clearTaskCreator()
    await expect(runAction(azione({ title_template: 'X' }), istanza(), contesto))
      .rejects.toThrow(/registerTaskCreator/)
  })

  it('il registro vale per QUALUNQUE contesto, anche il più povero', async () => {
    // Il contesto dell'approvazione: solo `userId` ed `entityData`, nessun callback.
    const povero: ActionContext = { userId: 'u-2', entityData: {} }
    await runAction(azione({ title_template: 'Fatto lo stesso' }), istanza(), povero)
    expect(scritti).toHaveLength(1)
    expect(scritti[0]!.createdBy).toBe('u-2')
  })

  it('le condizioni dell\'azione valgono anche qui: se non scattano, niente compito', async () => {
    const conCondizione = {
      type: 'create_task',
      params: { title_template: 'Solo per Milano' },
      conditions: [{ field: 'sede', operator: 'eq', value: 'milano' }],
      conditions_logic: 'AND',
    } as unknown as WorkflowActionConfig
    await runAction(conCondizione, istanza(), { ...contesto, entityData: { sede: 'roma' } })
    expect(scritti).toHaveLength(0)
    await runAction(conCondizione, istanza(), { ...contesto, entityData: { sede: 'milano' } })
    expect(scritti).toHaveLength(1)
  })
})

describe('il registro dei compiti', () => {
  it('l\'ultimo registrato è quello che scrive (il processo ne ha uno)', async () => {
    const secondo = vi.fn(async () => 'task-2')
    registerTaskCreator(secondo)
    await runAction(azione({ title_template: 'X' }), istanza(), contesto)
    expect(secondo).toHaveBeenCalledOnce()
    expect(scritti).toHaveLength(0)
  })
})
