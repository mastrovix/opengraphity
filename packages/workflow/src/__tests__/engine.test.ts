import { describe, it, expect, vi } from 'vitest'
import { WorkflowEngine, conditionFailureKey, initialStepSelection } from '../engine.js'
/*
 * QUESTO `vi.mock` STA IN CIMA, E NON PER STILE (21 set 2026, vitest 5).
 *
 * Era dentro il `describe` qui sotto, e SEMBRAVA valere solo per quei test —
 * ma `vi.mock` viene issato ed eseguito prima di tutto il file, quindi valeva
 * per l'intero modulo. Vitest 5 ha smesso di spostarlo in silenzio e ora lo
 * rifiuta: «it will be hoisted and executed before anything in this file. Move
 * it to the top level to reflect its actual execution».
 *
 * Averlo scoperto e' un guadagno: chi leggeva quel file credeva che i test
 * fuori dal `describe` usassero le azioni VERE, e non era cosi'.
 */
vi.mock('../actions.js', async (importOriginal) => {
  const vero = await importOriginal<typeof import('../actions.js')>()
  return {
    ...vero,
    runAction: vi.fn(async (action: { type: string }, _i: unknown, ctx: { actionIndex?: number; actionPhase?: string; actionPosition?: number }) => {
      const g = globalThis as { __azioni?: unknown[] }
      g.__azioni ??= []
      g.__azioni.push({ tipo: action.type, actionIndex: ctx.actionIndex, phase: ctx.actionPhase, position: ctx.actionPosition })
    }),
  }
})

function mockRecord(data: Record<string, unknown>) {
  return { get: (key: string) => data[key] }
}

function makeSession(readRecords: ReturnType<typeof mockRecord>[], writeRecords: ReturnType<typeof mockRecord>[] = []) {
  return {
    executeRead:  vi.fn().mockResolvedValue({ records: readRecords }),
    executeWrite: vi.fn().mockResolvedValue({ records: writeRecords }),
  }
}

/** Riga di stato come la restituisce la query di lettura di transition(). */
function stateRow(over: Record<string, unknown> = {}) {
  return mockRecord({
    wi: { properties: { id: 'wi-1', tenant_id: 'c-one', entity_id: 'inc-1', entity_type: 'incident', definition_id: 'def-1', created_at: 'x' } },
    currentStepId:    'step-1',
    currentStepName:  'in_progress',
    exitActions:      null,
    nextStepId:       'step-2',
    nextStepName:     'resolved',
    nextStepType:     'standard',
    // Metadata del passo di arrivo: sono questi a dire «è il passo di
    // risoluzione» e «è terminale», non il nome (ondata 8 · B-5 / B-20). Di
    // fabbrica `resolved` è `standard` + `is_terminal` + categoria `resolved`.
    nextStepCategory: 'resolved',
    nextStepTerminal: true,
    nextEnterActions: null,
    timerDelayMinutes: null,
    subWorkflowId:    null,
    trigger:          'manual',
    condition:        null,
    enteredAt:        new Date().toISOString(),
    ...over,
  })
}

/** Sessione la cui executeWrite ESEGUE la callback con una tx finta. */
function makeWritableSession(readRecords: ReturnType<typeof mockRecord>[], writeRows: number) {
  const txRun = vi.fn().mockResolvedValue({ records: Array.from({ length: writeRows }, () => mockRecord({ id: 'wi-1' })) })
  return {
    txRun,
    executeRead:  vi.fn().mockResolvedValue({ records: readRecords }),
    executeWrite: vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => work({ run: txRun })),
  }
}

const manual = { instanceId: 'wi-1', toStepName: 'resolved', triggeredBy: 'user-1', triggerType: 'manual' as const }
const actx = { userId: 'user-1', entityData: {} }

describe('WorkflowEngine', () => {
  describe('getAvailableTransitions', () => {
    it('restituisce transizioni manuali disponibili', async () => {
      const session = makeSession([
        mockRecord({ toStep: 'assigned', label: 'Assegna', requiresInput: false, inputField: null, condition: null }),
        mockRecord({ toStep: 'escalated', label: 'Escalate', requiresInput: false, inputField: null, condition: null }),
      ])
      const engine = new WorkflowEngine()
      const transitions = await engine.getAvailableTransitions(session as never, 'instance-123')
      expect(transitions).toHaveLength(2)
      expect(transitions[0].toStep).toBe('assigned')
      expect(transitions[1].toStep).toBe('escalated')
      expect(session.executeRead).toHaveBeenCalledOnce()
    })

    it('restituisce array vuoto se nessuna transizione disponibile', async () => {
      const engine = new WorkflowEngine()
      expect(await engine.getAvailableTransitions(makeSession([]) as never, 'instance-123')).toHaveLength(0)
    })

    it('mappa requiresInput, inputField e condition', async () => {
      const session = makeSession([
        mockRecord({ toStep: 'resolved', label: 'Risolvi', requiresInput: true, inputField: 'notes', condition: 'rootCause != null' }),
      ])
      const t = await new WorkflowEngine().getAvailableTransitions(session as never, 'instance-123')
      expect(t[0].requiresInput).toBe(true)
      expect(t[0].inputField).toBe('notes')
      expect(t[0].condition).toBe('rootCause != null')
    })
  })

  describe('createInstance', () => {
    it('chiama executeWrite e ritorna una WorkflowInstance', async () => {
      const session = { executeRead: vi.fn(), executeWrite: vi.fn().mockResolvedValue({ id: 'wi-123' }) }
      await new WorkflowEngine().createInstance(session as never, 'c-one', 'incident-789', 'incident')
      expect(session.executeWrite).toHaveBeenCalledOnce()
    })

    // ── B2-3 (B-8): il passo di partenza lo dice il DATO ──────────────────────
    // Il pannello «Step iniziale» scrive `is_initial` e non tocca `type`:
    // cercando `WorkflowStep {type:'start'}` l'istanza nasceva sul vecchio
    // passo e l'entità con lo status di quello nuovo (`assertInitialStep`
    // rifiutava poi ogni addCIToChange).

    /** Sessione che ESEGUE la callback; `defRow` è la riga della query di scelta. */
    function makeCreateSession(defRow: ReturnType<typeof mockRecord> | null, anyDefName?: string) {
      const queries: string[] = []
      const txRun = vi.fn(async (q: string) => {
        queries.push(q)
        if (q.includes('AS defId')) return { records: defRow ? [defRow] : [] }
        if (q.includes('AS name'))  return { records: anyDefName ? [mockRecord({ name: anyDefName })] : [] }
        return { records: [mockRecord({ id: 'wi-1' })] }
      })
      return { queries, txRun, executeRead: vi.fn(), executeWrite: vi.fn(async (w: (tx: { run: typeof txRun }) => Promise<unknown>) => w({ run: txRun })) }
    }

    it('parte dallo step marcato is_initial, non da type=start', async () => {
      const session = makeCreateSession(mockRecord({ defId: 'def-1', stepId: 'step-assigned', stepName: 'assigned' }))
      const wi = await new WorkflowEngine().createInstance(session as never, 'c-one', 'inc-1', 'incident')
      expect(wi.currentStep).toBe('assigned')
      const defQuery = session.queries[0]!
      expect(defQuery).toContain("coalesce(startStep.is_initial, startStep.type = 'start')")
      // nessun aggancio al nome del tipo: era `WorkflowStep {type: 'start'}`
      expect(defQuery).not.toContain("{type: 'start'}")
    })

    it('definizione senza nessuno step iniziale → errore che la NOMINA (non «non esiste»)', async () => {
      const session = makeCreateSession(null, 'Incident Management')
      await expect(new WorkflowEngine().createInstance(session as never, 'c-one', 'inc-1', 'incident'))
        .rejects.toThrow(/Workflow "Incident Management".*has no initial step/s)
    })

    it('nessuna definizione attiva → il messaggio storico', async () => {
      const session = makeCreateSession(null)
      await expect(new WorkflowEngine().createInstance(session as never, 'c-one', 'inc-1', 'incident'))
        .rejects.toThrow('No active workflow definition for "incident" in tenant "c-one"')
    })

    // ── Ondata 8 · B-13: il ripiego sulla definizione base non è più muto ─────
    // La variante si scegle confrontando `wd.category` con la categoria
    // dell'entità per uguaglianza. Se il cliente rinomina il valore di
    // vocabolario (`security` → `sicurezza`), la variante resta nel grafo e non
    // viene più scelta da nessuno: gli incident di sicurezza seguono il flusso
    // base. Il ripiego è giusto, il silenzio no: ora l'engine CHIEDE quali
    // varianti esistono e lo scrive nei log.
    /** Come makeCreateSession, ma sa rispondere anche alla query delle varianti. */
    function makeVariantSession(defCategory: string | null, variantCategories: string[]) {
      const queries: string[] = []
      const txRun = vi.fn(async (q: string) => {
        queries.push(q)
        if (q.includes('AS defId')) return { records: [mockRecord({ defId: 'def-1', stepId: 's-1', stepName: 'nuovo', defCategory })] }
        if (q.includes('AS categories')) return { records: [mockRecord({ categories: variantCategories })] }
        return { records: [mockRecord({ id: 'wi-1' })] }
      })
      return { queries, txRun, executeRead: vi.fn(), executeWrite: vi.fn(async (w: (tx: { run: typeof txRun }) => Promise<unknown>) => w({ run: txRun })) }
    }

    it('nessuna definizione applicabile alla categoria e nessuna base → errore che parla di CATEGORIA, non di «step iniziale»', async () => {
      const txRun = vi.fn(async (q: string) => {
        if (q.includes('AS defId')) return { records: [] }
        // la definizione c'è, ha un passo iniziale, ma è riservata a un'altra categoria
        if (q.includes('AS initials')) return { records: [mockRecord({ name: 'Incident — Security', category: 'security', initials: 1 })] }
        return { records: [] }
      })
      const session = { executeRead: vi.fn(), executeWrite: vi.fn(async (w: (tx: { run: typeof txRun }) => Promise<unknown>) => w({ run: txRun })) }
      await expect(new WorkflowEngine().createInstance(session as never, 'c-one', 'inc-1', 'incident', undefined, 'sicurezza'))
        .rejects.toThrow(/applies to category "sicurezza".*reserved for category "security"/s)
    })

    it('categoria che non combacia con nessuna variante → l\'engine elenca le varianti esistenti (nessun ripiego muto)', async () => {
      const session = makeVariantSession(null, ['security'])
      const wi = await new WorkflowEngine().createInstance(session as never, 'c-one', 'inc-1', 'incident', undefined, 'sicurezza')
      expect(wi.currentStep).toBe('nuovo')   // il ripiego resta: l'incident nasce
      expect(session.queries.some((q) => q.includes('AS categories'))).toBe(true)
    })

    it('variante scelta (categoria combaciante) o nessuna variante → nessuna lettura in più', async () => {
      const chosen = makeVariantSession('security', ['security'])
      await new WorkflowEngine().createInstance(chosen as never, 'c-one', 'inc-1', 'incident', undefined, 'security')
      expect(chosen.queries.some((q) => q.includes('AS categories'))).toBe(false)

      const noCategory = makeVariantSession(null, [])
      await new WorkflowEngine().createInstance(noCategory as never, 'c-one', 'inc-2', 'incident')
      expect(noCategory.queries.some((q) => q.includes('AS categories'))).toBe(false)
    })
  })

  describe('transition — validazione prima di scrivere', () => {
    it('errore se nessun arco verso lo step richiesto', async () => {
      const result = await new WorkflowEngine().transition(makeSession([]) as never, { ...manual, toStepName: 'nonexistent' }, actx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('not valid')
      expect(result.errorI18n?.key).toBe('errors.workflow.transitionNotValid')
    })

    it('un trigger manuale NON può percorrere un arco riservato al sistema (timer/automatic/sla_breach)', async () => {
      const session = makeSession([stateRow({ trigger: 'timer', nextStepName: 'closed' })])
      const result = await new WorkflowEngine().transition(session as never, { ...manual, toStepName: 'closed' }, actx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('reserved to the system')
      expect(result.errorI18n).toEqual({ key: 'errors.workflow.transitionSystemOnly', params: { step: expect.any(String) } })
      expect(session.executeWrite).not.toHaveBeenCalled()
    })

    it('un trigger di sistema può percorrere un arco manuale (es. auto-resolve dalla change)', async () => {
      const session = makeWritableSession([stateRow({ trigger: 'manual' })], 1)
      const result = await new WorkflowEngine().transition(session as never, { ...manual, triggerType: 'automatic', notes: 'Risolto dalla change' }, actx)
      expect(result.success).toBe(true)
    })

    it('condizione built-in rootCause: rifiuta senza note, anche con trigger automatico', async () => {
      const engine = new WorkflowEngine()
      const row = stateRow({ condition: 'rootCause != null' })
      const r1 = await engine.transition(makeSession([row]) as never, manual, actx)
      expect(r1.success).toBe(false)
      expect(r1.error).toContain('root cause')
      expect(r1.errorI18n?.key).toBe('errors.workflow.condition.rootCauseRequired')
      const r2 = await engine.transition(makeSession([row]) as never, { ...manual, triggerType: 'automatic' }, actx)
      expect(r2.success).toBe(false)
    })

    it('condizione non registrata → transizione non valida (workflow mal configurato)', async () => {
      const session = makeSession([stateRow({ condition: 'does_not_exist' })])
      const result = await new WorkflowEngine().transition(session as never, manual, actx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown transition condition')
      expect(result.errorI18n).toEqual({ key: 'errors.workflow.unknownCondition', params: { condition: 'does_not_exist' } })
      expect(session.executeWrite).not.toHaveBeenCalled()
    })

    it('condizione registrata dal chiamante: valutata con il contesto e usa il messaggio registrato', async () => {
      const engine = new WorkflowEngine()
      const evaluate = vi.fn().mockResolvedValue(false)
      engine.registerCondition('has_linked_change', evaluate, 'Collega prima una change')
      const session = makeSession([stateRow({ condition: 'has_linked_change', toStepName: 'change_requested' })])
      const result = await engine.transition(session as never, { ...manual, toStepName: 'change_requested', notes: 'n' }, actx)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Collega prima una change')
      expect(result.errorI18n).toEqual({ key: 'errors.workflow.condition.has_linked_change', params: { condition: 'has_linked_change' } })
      expect(evaluate).toHaveBeenCalledWith(session, expect.objectContaining({
        entityId: 'inc-1', tenantId: 'c-one', fromStepName: 'in_progress', toStepName: 'resolved', triggerType: 'manual', notes: 'n',
      }))
    })

    it('entity_type fuori allowlist → nessuna scrittura', async () => {
      const session = makeSession([stateRow({ wi: { properties: { id: 'wi-1', tenant_id: 'c-one', entity_id: 'x', entity_type: 'alien' } } })])
      const result = await new WorkflowEngine().transition(session as never, manual, actx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('ENTITY_LABELS')
      expect(session.executeWrite).not.toHaveBeenCalled()
    })

    // ── B0-5: vocabolario delle azioni ───────────────────────────────────────
    // Dal vivo, un passo di «Incident — Security» aveva un'azione
    // `create_notification` che il motore non conosce: la transizione passava,
    // l'azione non avveniva e l'errore finiva in `actionErrors`, che per gli
    // incident il web non chiede. Ora la transizione si ferma PRIMA di
    // scrivere e nomina l'azione.

    it('azione ignota fra le enter_actions → transizione fallita che la NOMINA, nessuna scrittura', async () => {
      const session = makeSession([stateRow({
        nextEnterActions: JSON.stringify([{ type: 'create_notification', params: { channel: 'in_app', message: 'x' } }]),
      })])
      const result = await new WorkflowEngine().transition(session as never, manual, actx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown workflow action type')
      expect(result.error).toContain('"create_notification"')
      expect(result.error).toContain('enter_actions[0] di "resolved"')
      expect(result.error).toContain('publish_event')   // il vocabolario ammesso è nel messaggio
      expect(session.executeWrite).not.toHaveBeenCalled()
    })

    it('azione ignota fra le exit_actions dello step corrente → stesso trattamento', async () => {
      const session = makeSession([stateRow({
        exitActions: JSON.stringify([{ type: 'sla_stop', params: { sla_type: 'response' } }, { type: 'teleport', params: {} }]),
      })])
      const result = await new WorkflowEngine().transition(session as never, manual, actx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('"teleport" (exit_actions[1] di "in_progress")')
      expect(session.executeWrite).not.toHaveBeenCalled()
    })

    it('azioni tutte del vocabolario → la transizione procede', async () => {
      const session = makeWritableSession([stateRow({
        nextEnterActions: JSON.stringify([{ type: 'notify_rule', params: { title_key: 'k' } }]),
      })], 1)
      const result = await new WorkflowEngine().transition(session as never, manual, actx)
      expect(result.success).toBe(true)
    })
  })

  describe('transition — scrittura atomica', () => {
    it('lo step corrente è cambiato nel frattempo → la scrittura non produce righe e la transizione fallisce', async () => {
      const session = makeWritableSession([stateRow()], 0)
      const result = await new WorkflowEngine().transition(session as never, manual, actx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Concurrent transition')
      expect(result.errorI18n).toEqual({ key: 'errors.workflow.concurrentTransition' })
      // solo la statement di avanzamento è stata tentata, nessun sync status
      expect(session.txRun).toHaveBeenCalledTimes(1)
    })

    it('happy path: avanzamento con guardia sullo step corrente + sync status con label', async () => {
      const session = makeWritableSession([stateRow()], 1)
      const result = await new WorkflowEngine().transition(session as never, { ...manual, notes: 'root cause' }, actx)
      expect(result.success).toBe(true)
      expect(result.instance.currentStep).toBe('resolved')
      const [advanceCypher, advanceParams] = session.txRun.mock.calls[0]! as [string, Record<string, unknown>]
      expect(advanceCypher).toContain('[r:CURRENT_STEP]->(cur:WorkflowStep {id: $currentStepId})')
      expect(advanceCypher).toContain('WITH DISTINCT wi, r')
      // il lock su wi (SET) DEVE precedere la MATCH sullo step corrente
      expect(advanceCypher.indexOf('SET wi.updated_at = $now')).toBeLessThan(advanceCypher.indexOf('[r:CURRENT_STEP]'))
      expect(advanceParams['currentStepId']).toBe('step-1')
      const [statusCypher] = session.txRun.mock.calls[1]! as [string]
      expect(statusCypher).toContain('(entity:Incident {id: $entityId, tenant_id: $tenantId})')
      expect(statusCypher).toContain('coalesce($rootCause, entity.root_cause)')
    })

    // ── Ondata 8 · B-5 / B-20: i metadata del passo, non il suo nome ────────
    it('passo di risoluzione RINOMINATO (categoria resolved) → resolved_at e root_cause, status = nome del passo', async () => {
      const session = makeWritableSession([stateRow({ nextStepName: 'sistemato', nextStepCategory: 'resolved', nextStepTerminal: true })], 1)
      const result = await new WorkflowEngine().transition(
        session as never, { ...manual, toStepName: 'sistemato', notes: 'cavo staccato' }, actx,
      )
      expect(result.success).toBe(true)
      const [statusCypher, statusParams] = session.txRun.mock.calls[1]! as [string, Record<string, unknown>]
      expect(statusCypher).toContain('entity.resolved_at = $now')
      expect(statusCypher).toContain('coalesce($rootCause, entity.root_cause)')
      // lo status è il NOME del passo del cliente, non il letterale 'resolved'
      expect(statusParams['status']).toBe('sistemato')
      expect(statusParams['rootCause']).toBe('cavo staccato')
    })

    it('passo CHIAMATO resolved ma senza categoria di risoluzione → nessun resolved_at (il nome non decide)', async () => {
      const session = makeWritableSession([stateRow({ nextStepCategory: 'active', nextStepTerminal: false })], 1)
      const result = await new WorkflowEngine().transition(session as never, { ...manual, notes: 'x' }, actx)
      expect(result.success).toBe(true)
      const [statusCypher] = session.txRun.mock.calls[1]! as [string]
      expect(statusCypher).not.toContain('resolved_at')
    })

    it('wi.status = completed per un passo TERMINALE anche se non è type=end; active altrimenti', async () => {
      // `resolved` di fabbrica: type `standard` marcato terminale nel disegnatore.
      const terminal = makeWritableSession([stateRow({ nextStepType: 'standard', nextStepTerminal: true })], 1)
      const r1 = await new WorkflowEngine().transition(terminal as never, manual, actx)
      expect(r1.instance.status).toBe('completed')
      expect((terminal.txRun.mock.calls[0]![1] as Record<string, unknown>)['wiStatus']).toBe('completed')

      const open = makeWritableSession([stateRow({ nextStepType: 'standard', nextStepTerminal: false, nextStepCategory: 'active' })], 1)
      const r2 = await new WorkflowEngine().transition(open as never, manual, actx)
      expect(r2.instance.status).toBe('active')
      expect((open.txRun.mock.calls[0]![1] as Record<string, unknown>)['wiStatus']).toBe('active')
    })

    it('tenantId nell\'input finisce nella query di lettura', async () => {
      const session = makeSession([])
      await new WorkflowEngine().transition(session as never, { ...manual, tenantId: 'c-one' }, actx)
      const params = session.executeRead.mock.calls[0]![0] as (tx: { run: (q: string, p: Record<string, unknown>) => unknown }) => unknown
      const run = vi.fn()
      await params({ run })
      expect((run.mock.calls[0]![1] as Record<string, unknown>)['tenantId']).toBe('c-one')
    })
  })
})

/**
 * L'ingresso in un passo detto a chi ascolta, e la conclusione di richieste e
 * change. Giro del 14 set 2026: un problem risolto dalla sua change e una
 * richiesta chiusa dal workflow non avvisavano nessuno, e il loro SLA restava
 * aperto; la richiesta chiusa non aveva nemmeno `completed_at`.
 */
describe('WorkflowEngine — ingresso nel passo', () => {
  it('ogni ascoltatore riceve il passo lasciato (iniziale o no), quello di arrivo, categoria e terminale', async () => {
    const session = makeWritableSession([stateRow({ currentStepInitial: true, nextStepName: 'approval', nextStepCategory: 'waiting', nextStepTerminal: false })], 1)
    const engine = new WorkflowEngine()
    const visti: unknown[] = []
    engine.onStepEntered(async (info) => { visti.push(info) })
    const r = await engine.transition(session as never, { ...manual, toStepName: 'approval' }, actx)
    expect(r.success).toBe(true)
    expect(visti).toEqual([expect.objectContaining({
      tenantId: 'c-one', entityType: 'incident', entityId: 'inc-1', fromStep: 'in_progress', fromInitial: true,
      toStep: 'approval', category: 'waiting', terminal: false, actorId: 'user-1', triggerType: 'manual',
    })])
  })

  // Wave 7 · B2: the event of the entry is written to the outbox in the transition's own transaction.
  it('the step-entered event is recorded in the transition\'s transaction, and the listener gets that same event', async () => {
    const { registerEventOutbox, clearEventOutbox } = await import('@opengraphity/events')
    const recordIn = vi.fn(async () => undefined)
    registerEventOutbox({ record: vi.fn(), recordIn, deliverExtras: vi.fn(), markSent: vi.fn() })
    try {
      const session = makeWritableSession([stateRow({ currentStepInitial: true, nextStepName: 'approval', nextStepCategory: 'waiting', nextStepTerminal: false })], 1)
      const engine = new WorkflowEngine()
      const visti: Array<{ event: unknown }> = []
      engine.onStepEntered(async (info) => { visti.push(info) })
      await engine.transition(session as never, { ...manual, toStepName: 'approval' }, actx)

      expect(recordIn).toHaveBeenCalledTimes(1)
      const [tx, event, options] = recordIn.mock.calls[0] as unknown as [unknown, Record<string, unknown>, unknown]
      // Inside the write transaction, with the move: the tx the transition's statements ran on.
      expect(tx).toEqual(expect.objectContaining({ run: session.txRun }))
      expect(options).toEqual({ webhooks: true })
      expect(event).toMatchObject({
        type: 'workflow.step_entered', tenant_id: 'c-one', actor_id: 'user-1',
        payload: {
          entity_type: 'incident', entity_id: 'inc-1', from_step: 'in_progress', from_initial: true,
          step_name: 'approval', step_category: 'waiting', step_terminal: false, trigger_type: 'manual',
        },
      })
      expect(visti[0]!.event).toBe(event)
    } finally {
      clearEventOutbox()
    }
  })

  it('un ascoltatore che fallisce non annulla la transizione: finisce in actionErrors', async () => {
    const session = makeWritableSession([stateRow()], 1)
    const engine = new WorkflowEngine()
    engine.onStepEntered(async () => { throw new Error('coda giù') })
    const r = await engine.transition(session as never, manual, actx) as unknown as { success: boolean; actionErrors?: string[] }
    expect(r.success).toBe(true)
    expect(r.actionErrors?.join(' ')).toMatch(/step_entered listener: coda giù/)
  })

  it('una service request che entra in un passo terminale riceve completed_at (la prima volta)', async () => {
    const row = stateRow({
      wi: { properties: { id: 'wi-1', tenant_id: 'c-one', entity_id: 'req-1', entity_type: 'service_request', definition_id: 'def-1', created_at: 'x' } },
      nextStepName: 'closed', nextStepCategory: 'closed', nextStepTerminal: true,
    })
    const session = makeWritableSession([row], 1)
    await new WorkflowEngine().transition(session as never, { ...manual, toStepName: 'closed' }, actx)
    const sync = session.txRun.mock.calls.map((c) => String(c[0])).find((q) => q.includes('ServiceRequest'))
    expect(sync).toMatch(/entity\.completed_at = coalesce\(entity\.completed_at, \$now\)/)
  })

  it('un passo NON terminale non tocca completed_at', async () => {
    const row = stateRow({
      wi: { properties: { id: 'wi-1', tenant_id: 'c-one', entity_id: 'req-1', entity_type: 'service_request', definition_id: 'def-1', created_at: 'x' } },
      nextStepName: 'fulfilled', nextStepCategory: 'active', nextStepTerminal: false,
    })
    const session = makeWritableSession([row], 1)
    await new WorkflowEngine().transition(session as never, { ...manual, toStepName: 'fulfilled' }, actx)
    expect(session.txRun.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/completed_at/)
  })

  /**
   * Giro UI del 15 set 2026 · U-7: INC00000019, riaperto dal monitoraggio,
   * mostrava ancora «RESOLVED 14:02» e la root cause di prima mentre era In
   * Progress. Uscire dal passo di risoluzione verso un passo aperto li svuota.
   */
  it('riapertura (dal passo di risoluzione a un passo aperto): resolved_at e root_cause dell\'incident si svuotano', async () => {
    const session = makeWritableSession([stateRow({ currentStepCategory: 'resolved', nextStepName: 'in_progress', nextStepCategory: 'active', nextStepTerminal: false })], 1)
    await new WorkflowEngine().transition(session as never, { ...manual, toStepName: 'in_progress' }, actx)
    const [sync, params] = session.txRun.mock.calls[1]! as [string, Record<string, unknown>]
    expect(sync).toContain('entity.resolved_at = null')
    expect(sync).toContain('entity.root_cause  = CASE WHEN $clearRootCause THEN null ELSE entity.root_cause END')
    expect(params['clearRootCause']).toBe(true)
  })

  it('riapertura di un problem: resolved_at si svuota, la root cause (l\'analisi) resta', async () => {
    const row = stateRow({
      wi: { properties: { id: 'wi-1', tenant_id: 'c-one', entity_id: 'prb-1', entity_type: 'problem', definition_id: 'def-1', created_at: 'x' } },
      currentStepCategory: 'resolved', nextStepName: 'under_investigation', nextStepCategory: 'active', nextStepTerminal: false,
    })
    const session = makeWritableSession([row], 1)
    await new WorkflowEngine().transition(session as never, { ...manual, toStepName: 'under_investigation' }, actx)
    const sync = session.txRun.mock.calls.find((c) => String(c[0]).includes('entity.resolved_at = null'))
    expect(sync).toBeTruthy()
    expect((sync![1] as Record<string, unknown>)['clearRootCause']).toBe(false)
  })

  it('da resolved a closed (terminale) non è una riapertura: resolved_at resta', async () => {
    const session = makeWritableSession([stateRow({ currentStepCategory: 'resolved', nextStepName: 'closed', nextStepCategory: 'closed', nextStepTerminal: true })], 1)
    await new WorkflowEngine().transition(session as never, { ...manual, toStepName: 'closed' }, actx)
    expect(session.txRun.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/resolved_at = null/)
  })

  /** Giro del 14 set 2026 (#43): l'articolo pubblicato diceva «Published: —». */
  it('un articolo KB che entra in un passo di categoria published riceve published_at, anche se il passo è rinominato', async () => {
    const row = stateRow({
      wi: { properties: { id: 'wi-1', tenant_id: 'c-one', entity_id: 'kb-1', entity_type: 'kb_article', definition_id: 'def-1', created_at: 'x' } },
      nextStepName: 'online', nextStepCategory: 'published', nextStepTerminal: false,
    })
    const session = makeWritableSession([row], 1)
    await new WorkflowEngine().transition(session as never, { ...manual, toStepName: 'online' }, actx)
    const sync = session.txRun.mock.calls.find((c) => String(c[0]).includes('KBArticle'))!
    expect(String(sync[0])).toMatch(/entity\.published_at = \$now/)
    expect((sync[1] as Record<string, unknown>)['status']).toBe('online')
  })

  it('un passo CHIAMATO published ma di altra categoria non scrive published_at', async () => {
    const row = stateRow({
      wi: { properties: { id: 'wi-1', tenant_id: 'c-one', entity_id: 'kb-1', entity_type: 'kb_article', definition_id: 'def-1', created_at: 'x' } },
      nextStepName: 'published', nextStepCategory: 'waiting', nextStepTerminal: false,
    })
    const session = makeWritableSession([row], 1)
    await new WorkflowEngine().transition(session as never, { ...manual, toStepName: 'published' }, actx)
    expect(session.txRun.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/published_at/)
  })
})

/**
 * L'IDENTITÀ DI UN'AZIONE (rimedio, 20 set 2026).
 *
 * `actionIndex` conta sulla lista CONCATENATA `[…uscita, …ingresso]`, ed è
 * giusto così: lo usa il retry del webhook per rileggere gli header dal
 * passo. Il guaio era che quell'indice sembrava un'identità dell'azione e
 * non lo è — la stessa azione d'ingresso vale 0 arrivando da un passo senza
 * azioni di uscita e 2 arrivando da uno che ne ha due. I compiti lo usavano
 * come chiave contro i doppioni, e si duplicavano a ogni rientro nel passo.
 *
 * Ora accanto viaggiano FASE e POSIZIONE NELLA PROPRIA LISTA, che non
 * dipendono da dove si arriva. Questi test lo tengono fermo eseguendo una
 * transizione vera sul motore.
 */
describe('fase e posizione delle azioni', () => {
  /*
   * Un TIPO, non un valore (21 set 2026): le azioni eseguite le raccoglie il
   * mock su `globalThis.__azioni`, e questa riga serviva solo a dare un nome
   * alla loro forma. typescript-eslint 8 lo dice — «assigned a value but only
   * used as a type» — e ha ragione: un array vuoto che nessuno legge sembra
   * un accumulatore, e chi legge lo cerca.
   */
  type AzioneEseguita = { tipo: string; actionIndex?: number; phase?: string; position?: number }


  const azioniEseguite = () => ((globalThis as { __azioni?: AzioneEseguita[] }).__azioni ?? [])

  it('la posizione di un\'azione d\'ingresso NON dipende dalle azioni di uscita del passo che si lascia', async () => {
    (globalThis as { __azioni?: unknown[] }).__azioni = []
    const engine = new WorkflowEngine()
    const due = JSON.stringify([{ type: 'sla_stop', params: { sla_type: 'response' } }, { type: 'sla_stop', params: { sla_type: 'resolve' } }])
    const uno = JSON.stringify([{ type: 'notify', params: {} }])
    const s = makeWritableSession([stateRow({ exitActions: due, nextEnterActions: uno })], 1)
    await engine.transition(s as never, manual, actx)

    const ingresso = azioniEseguite().find((a) => a.tipo === 'notify')!
    // Concatenata: è la terza. Nella sua lista: è la prima.
    expect(ingresso.actionIndex).toBe(2)
    expect(ingresso.position).toBe(0)
    expect(ingresso.phase).toBe('enter')
  })

  it('le azioni di USCITA si riconoscono come tali', async () => {
    (globalThis as { __azioni?: unknown[] }).__azioni = []
    const engine = new WorkflowEngine()
    const s = makeWritableSession([stateRow({
      exitActions: JSON.stringify([{ type: 'sla_stop', params: { sla_type: 'response' } }]),
      nextEnterActions: null,
    })], 1)
    await engine.transition(s as never, manual, actx)
    expect(azioniEseguite()[0]).toMatchObject({ tipo: 'sla_stop', phase: 'exit', position: 0 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────

/** A session whose reads RUN the callback: the real query reaches `txRun`. */
function makeReadingSession(records: ReturnType<typeof mockRecord>[]) {
  const txRun = vi.fn().mockResolvedValue({ records })
  return {
    txRun,
    executeRead:  vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => work({ run: txRun })),
    executeWrite: vi.fn(),
  }
}

/**
 * THE TWO READS THE PORTAL SHOWS. Until now the tests passed sessions that
 * resolved without ever RUNNING the callback: the Cypher inside was not even
 * compiled, and the test still went green. Here the callback runs, so the
 * query and its parameters are genuinely under watch — starting with the
 * tenant scoping, which on these two reads is the only thing standing between
 * a user and another customer's history.
 */
describe('getAvailableTransitions / getHistory — the query that actually runs', () => {
  it('available transitions pass instanceId and tenantId, and the bilingual label is parsed', async () => {
    const s = makeReadingSession([mockRecord({
      toStep: 'resolved', label: 'Risolvi', labels: '{"it":"Risolvi","en":"Resolve"}',
      requiresInput: true, inputField: 'notes', condition: null,
    })])
    const t = await new WorkflowEngine().getAvailableTransitions(s as never, 'wi-1', 'c-one')
    const [cypher, params] = s.txRun.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain("TRANSITIONS_TO {trigger: 'manual'}")
    expect(cypher).toContain('$tenantId IS NULL OR wi.tenant_id = $tenantId')
    expect(params).toEqual({ instanceId: 'wi-1', tenantId: 'c-one' })
    expect(t[0].labels).toEqual([{ language: 'it', label: 'Risolvi' }, { language: 'en', label: 'Resolve' }])
  })

  it('with no tenantId the parameter is null, not absent: the WHERE must be able to compare it', async () => {
    const s = makeReadingSession([])
    await new WorkflowEngine().getAvailableTransitions(s as never, 'wi-1')
    expect((s.txRun.mock.calls[0]![1] as Record<string, unknown>)['tenantId']).toBeNull()
  })

  it('history comes back in entry order and returns the node PROPERTIES', async () => {
    const s = makeReadingSession([
      mockRecord({ exec: { properties: { step_name: 'new', entered_at: '2026-01-01T00:00:00Z' } } }),
      mockRecord({ exec: { properties: { step_name: 'resolved', entered_at: '2026-01-02T00:00:00Z' } } }),
    ])
    const history = await new WorkflowEngine().getHistory(s as never, 'wi-1', 'c-one')
    expect(history).toEqual([
      { step_name: 'new', entered_at: '2026-01-01T00:00:00Z' },
      { step_name: 'resolved', entered_at: '2026-01-02T00:00:00Z' },
    ])
    const [cypher, params] = s.txRun.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('ORDER BY exec.entered_at ASC')
    expect(cypher).toContain('$tenantId IS NULL OR wi.tenant_id = $tenantId')
    expect(params['tenantId']).toBe('c-one')
  })
})

/**
 * THE CONDITION REGISTRY. A condition written on an edge is a name: if nobody
 * registered it, the engine does not "carry on" — it stops. And the sentence
 * shown to whoever hits it has an i18n key derived from the name, so the name
 * cannot be just any name.
 */
describe('condition registry', () => {
  it('the built-in condition is there, an invented one is not', () => {
    const engine = new WorkflowEngine()
    expect(engine.hasCondition('rootCause != null')).toBe(true)
    expect(engine.hasCondition('invented')).toBe(false)
  })

  it('the built-in condition looks at the notes, and whitespace is not a root cause', async () => {
    const engine = new WorkflowEngine()
    const c = { entityId: 'inc-1', tenantId: 'c-one', fromStepName: 'a', toStepName: 'b', triggerType: 'manual' as const }
    expect(await engine.evaluateCondition(null as never, 'rootCause != null', { ...c, notes: 'a real cause' })).toBe(true)
    expect(await engine.evaluateCondition(null as never, 'rootCause != null', { ...c, notes: '   ' })).toBe(false)
    expect(await engine.evaluateCondition(null as never, 'rootCause != null', c)).toBe(false)
  })

  it('evaluating a never-registered condition THROWS: it is not treated as "not satisfied"', async () => {
    // Treating it as unsatisfied would block the ticket forever without
    // telling anyone the workflow is misconfigured.
    await expect(new WorkflowEngine().evaluateCondition(null as never, 'never_registered', {} as never))
      .rejects.toThrow('Unknown transition condition "never_registered"')
  })

  it('registering the same condition twice replaces it: the last one wins', async () => {
    const engine = new WorkflowEngine()
    engine.registerCondition('x', async () => false)
    engine.registerCondition('x', async () => true)
    expect(await engine.evaluateCondition(null as never, 'x', {} as never)).toBe(true)
  })

  it('a name that cannot become an i18n key is refused at registration time', () => {
    // The key is `errors.workflow.condition.<name>`: a name with spaces or
    // dots would produce a key no language file can hold, and the user would
    // see the raw key. Whoever needs one passes `failureKey`.
    const engine = new WorkflowEngine()
    expect(() => engine.registerCondition('root cause != null', async () => true))
      .toThrow(/has no i18n key of its own: pass failureKey/)
    expect(() => engine.registerCondition('root cause != null', async () => true, 'msg', 'errors.workflow.condition.rootCauseRequired'))
      .not.toThrow()
  })

  it('conditionFailureKey derives the key from the name', () => {
    expect(conditionFailureKey('allTasksDone')).toBe('errors.workflow.condition.allTasksDone')
    expect(() => conditionFailureKey('2_task')).toThrow(/has no i18n key/)
  })
})

/**
 * CREATEINSTANCE: the two ways it must NOT carry on silently.
 *
 * The node label ends up inside the Cypher (it cannot be a parameter), so an
 * `entity_type` outside the allowlist cannot become a MATCH: without the
 * allowlist we would write onto any node carrying that id. And a CREATE that
 * finds no entity is not an error for Neo4j: it creates nothing and says
 * nothing — the ticket would be left with no workflow.
 */
describe('createInstance — where it stops', () => {
  /** `rows` = how many the final CREATE returns. */
  function creationSession(rowCount: number) {
    const txRun = vi.fn(async (q: string) => {
      if (q.includes('AS defId')) return { records: [mockRecord({ defId: 'def-1', stepId: 'step-1', stepName: 'new', defCategory: null })] }
      return { records: Array.from({ length: rowCount }, () => mockRecord({ id: 'wi-1' })) }
    })
    return { txRun, executeRead: vi.fn(), executeWrite: vi.fn(async (w: (tx: { run: typeof txRun }) => Promise<unknown>) => w({ run: txRun })) }
  }

  it('an entity_type with no known label is refused, LISTING the known types', async () => {
    await expect(new WorkflowEngine().createInstance(creationSession(1) as never, 'c-one', 'x-1', 'alien'))
      .rejects.toThrow(/entity type "alien" has no node label.*Known types: /s)
  })

  it('missing entity (or one of another tenant): the CREATE returns no rows and we THROW', async () => {
    await expect(new WorkflowEngine().createInstance(creationSession(0) as never, 'c-one', 'inc-999', 'incident'))
      .rejects.toThrow('Cannot create workflow instance: entity incident/inc-999 not found in tenant "c-one"')
  })

  /**
   * Called INSIDE the caller's transaction (a `ManagedTransaction` has no
   * `executeWrite`): instance and ticket commit together. Without this path
   * creating the ticket and creating the instance would be two transactions,
   * and a failure in between would leave a ticket with no workflow.
   */
  it('with a ManagedTransaction it opens no transaction of its own: it writes in the caller\'s', async () => {
    const s = creationSession(1)
    const wi = await new WorkflowEngine().createInstance({ run: s.txRun } as never, 'c-one', 'inc-1', 'incident')
    expect(wi).toMatchObject({ tenantId: 'c-one', entityId: 'inc-1', entityType: 'incident', currentStep: 'new', status: 'active' })
    expect(s.executeWrite).not.toHaveBeenCalled()
    expect(s.txRun).toHaveBeenCalled()
  })
})

/**
 * DEFINITION SELECTION BY ID, extracted because the API writes `status` on
 * the ticket with the SAME priority the engine uses to create the instance.
 * They used to be two different reads, and with a per-category definition the
 * ticket was born with the status of one and the instance on another.
 */
describe('initialStepSelection — by definition id', () => {
  const tx = (records: ReturnType<typeof mockRecord>[]) => ({ run: vi.fn().mockResolvedValue({ records }) })

  it('with a definitionId it looks for THAT definition, active and belonging to THIS tenant', async () => {
    const t = tx([mockRecord({ defId: 'def-9', stepId: 'step-9', stepName: 'draft', defCategory: 'hardware' })])
    const chosen = await initialStepSelection(t as never, { tenantId: 'c-one', entityType: 'change', definitionId: 'def-9' })
    expect(chosen).toEqual({ definitionId: 'def-9', stepId: 'step-9', stepName: 'draft', definitionCategory: 'hardware' })
    const [cypher, params] = t.run.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('{id: $definitionId, tenant_id: $tenantId, active: true}')
    expect(cypher).toContain("coalesce(startStep.is_initial, startStep.type = 'start')")
    expect(cypher).toContain('ORDER BY stepPriority ASC')
    expect(params).toEqual({ definitionId: 'def-9', tenantId: 'c-one' })
  })

  it('a missing category on the chosen definition reads as null, not undefined', async () => {
    const t = tx([mockRecord({ defId: 'def-9', stepId: 'step-9', stepName: 'draft', defCategory: undefined })])
    expect((await initialStepSelection(t as never, { tenantId: 'c-one', entityType: 'change', definitionId: 'def-9' }))?.definitionCategory).toBeNull()
  })

  it('a definitionId that does not exist (or belongs to another tenant, or is inactive) gives null', async () => {
    expect(await initialStepSelection(tx([]) as never, { tenantId: 'c-one', entityType: 'change', definitionId: 'def-of-another' })).toBeNull()
  })
})

// Owner's decision, review of 23 Sep 2026: a catalog item's own itinerary is never the fallback of a generic ticket.
describe('initialStepSelection — without a definition id', () => {
  it('a catalog-only definition is left out of the choice; one by id is still reached', async () => {
    const t = { run: vi.fn().mockResolvedValue({ records: [mockRecord({ defId: 'def-1', stepId: 's', stepName: 'new', defCategory: null })] }) }
    await initialStepSelection(t as never, { tenantId: 'c-one', entityType: 'service_request', category: null })
    const [cypher] = t.run.mock.calls[0]! as [string]
    expect(cypher).toContain('WHERE coalesce(wd.catalog_only, false) = false')
    t.run.mockClear()
    await initialStepSelection(t as never, { tenantId: 'c-one', entityType: 'service_request', definitionId: 'def-cat' })
    expect((t.run.mock.calls[0]! as [string])[0]).not.toContain('catalog_only')
  })
})

/**
 * WHAT GOES WRONG AFTER THE TRANSITION IS WRITTEN.
 *
 * The distinction holding this whole block together: a corrupt configuration
 * stops the transition BEFORE touching the graph (otherwise the state is left
 * half-written); an action failing AFTER the write does not undo it — it goes
 * into `actionErrors`, because the step really did change and pretending
 * otherwise would make callers retry against a state that no longer exists.
 */
describe('transition — corrupt configuration and failed actions', () => {
  it('enter_actions that is not valid JSON: we fail BEFORE writing, naming the step', async () => {
    const session = makeWritableSession([stateRow({ nextEnterActions: '[{not json' })], 1)
    const r = await new WorkflowEngine().transition(session as never, manual, actx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('Corrupt step actions JSON (step resolved)')
    expect(session.txRun).not.toHaveBeenCalled()
  })

  it('corrupt exit_actions on the step being LEFT: same treatment', async () => {
    const session = makeWritableSession([stateRow({ exitActions: '{' })], 1)
    const r = await new WorkflowEngine().transition(session as never, manual, actx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('Corrupt step actions JSON')
    expect(session.txRun).not.toHaveBeenCalled()
  })

  it('a failing action does not undo the transition: the step changed, the error is RECORDED', async () => {
    const { runAction } = await import('../actions.js')
    vi.mocked(runAction).mockRejectedValueOnce(new Error('notification not sent'))
    const session = makeWritableSession([stateRow({ nextEnterActions: '[{"type":"notify","params":{}}]' })], 1)
    const r = await new WorkflowEngine().transition(session as never, manual, actx)
    expect(r.success).toBe(true)
    expect(r.actionErrors).toEqual(['notify: notification not sent'])
    expect(r.actionsRun).toEqual([])   // a failed action does not count as run
  })

  /**
   * `sub_workflow` is in the step-type vocabulary but is not implemented.
   * Entering it silently would make the administrator believe the sub-workflow
   * started: the ticket would wait for something that does not exist. We say
   * it, and we say it even when the id is not configured.
   */
  it('a sub_workflow step declares itself unimplemented, with and without a configured id', async () => {
    const withId = makeWritableSession([stateRow({ nextStepType: 'sub_workflow', subWorkflowId: 'def-sub' })], 1)
    const a = await new WorkflowEngine().transition(withId as never, manual, actx)
    expect(a.success).toBe(true)
    expect(a.actionErrors?.[0]).toContain('is not implemented — no sub-workflow was created (definitionId def-sub)')

    const withoutId = makeWritableSession([stateRow({ nextStepType: 'sub_workflow', subWorkflowId: null })], 1)
    const b = await new WorkflowEngine().transition(withoutId as never, manual, actx)
    expect(b.actionErrors?.[0]).toContain('and no subWorkflowId is configured')
  })

  /**
   * A wait step with no valid duration will NEVER leave on its own: the
   * ticket stays put forever. That is an `actionError`, not a log line nobody
   * reads.
   */
  it('timer_wait with no valid duration (absent, zero or negative) says so as an error', async () => {
    for (const duration of [null, 0, -5]) {
      const session = makeWritableSession([stateRow({ nextStepType: 'timer_wait', timerDelayMinutes: duration })], 1)
      const r = await new WorkflowEngine().transition(session as never, manual, actx)
      expect(r.success).toBe(true)
      expect(r.actionErrors?.[0]).toContain('has no valid timer_delay_minutes — the workflow will never leave this step')
    }
  })

  it('an unexpected write error becomes a failure carrying its message, not an exception that escapes', async () => {
    // Without this `catch` the error would climb up to the GraphQL resolver
    // and the user would see a 500 instead of the reason.
    const session = {
      executeRead:  vi.fn().mockResolvedValue({ records: [stateRow()] }),
      executeWrite: vi.fn().mockRejectedValue(new Error('Neo4j deadlock')),
    }
    const r = await new WorkflowEngine().transition(session as never, manual, actx)
    expect(r.success).toBe(false)
    expect(r.error).toBe('Neo4j deadlock')
    expect(r.errorI18n).toBeUndefined()
  })

  it('a rejection that is not an Error is still readable', async () => {
    const session = {
      executeRead:  vi.fn().mockResolvedValue({ records: [stateRow()] }),
      executeWrite: vi.fn().mockRejectedValue('bare string'),
    }
    expect((await new WorkflowEngine().transition(session as never, manual, actx)).error).toBe('bare string')
  })
})

/**
 * THE MESSAGE FALLBACKS, exercised one by one.
 *
 * Every `?? '(none)'`, `?? 'none'` and `instanceof Error ? … : String(e)` in
 * this engine exists because that value really did go missing at least once,
 * and the message without the fallback said "undefined" to the person who had
 * to work out what went wrong. A fallback never executed is a fallback never
 * tested.
 */
describe('the error-message fallbacks', () => {
  it('createInstance with an explicit definitionId looks for THAT definition in the error message too', async () => {
    const txRun = vi.fn(async (q: string) => {
      if (q.includes('AS defId')) return { records: [] }
      if (q.includes('AS initials')) return { records: [mockRecord({ name: 'Change — Standard', category: null, initials: 0 })] }
      return { records: [] }
    })
    const s = { executeRead: vi.fn(), executeWrite: vi.fn(async (w: (tx: { run: typeof txRun }) => Promise<unknown>) => w({ run: txRun })) }
    await expect(new WorkflowEngine().createInstance(s as never, 'c-one', 'chg-1', 'change', 'def-9'))
      .rejects.toThrow(/Workflow "Change — Standard".*has no initial step/s)
    expect((txRun.mock.calls[1]![1] as Record<string, unknown>)).toEqual({ definitionId: 'def-9', tenantId: 'c-one' })
  })

  it('a category missing on either side reads as "(none)", not "undefined"', async () => {
    const txRun = vi.fn(async (q: string) => {
      if (q.includes('AS defId')) return { records: [] }
      if (q.includes('AS initials')) return { records: [mockRecord({ name: 'Incident base', category: null, initials: 1 })] }
      return { records: [] }
    })
    const s = { executeRead: vi.fn(), executeWrite: vi.fn(async (w: (tx: { run: typeof txRun }) => Promise<unknown>) => w({ run: txRun })) }
    await expect(new WorkflowEngine().createInstance(s as never, 'c-one', 'inc-1', 'incident'))
      .rejects.toThrow(/"\(none\)": "Incident base" is reserved for category "\(none\)"/)
  })

  it('no variants in the graph: falling back to the base definition stays quiet (there is nothing to report)', async () => {
    // The warning is for when variants DO exist and none matches: that is
    // where somebody renamed a vocabulary value. With no variants the warning
    // would be noise on every ticket creation.
    const txRun = vi.fn(async (q: string) => {
      if (q.includes('AS defId')) return { records: [mockRecord({ defId: 'def-1', stepId: 's-1', stepName: 'new', defCategory: null })] }
      if (q.includes('AS categories')) return { records: [] }
      return { records: [mockRecord({ id: 'wi-1' })] }
    })
    const s = { executeRead: vi.fn(), executeWrite: vi.fn(async (w: (tx: { run: typeof txRun }) => Promise<unknown>) => w({ run: txRun })) }
    const wi = await new WorkflowEngine().createInstance(s as never, 'c-one', 'inc-1', 'incident', undefined, 'security')
    expect(wi.currentStep).toBe('new')
  })

  it('an edge with no trigger walked manually is refused saying "none"', async () => {
    const r = await new WorkflowEngine().transition(makeSession([stateRow({ trigger: null })]) as never, manual, actx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('reserved to the system (trigger "none")')
  })

  it('a SATISFIED condition lets the transition through', async () => {
    const engine = new WorkflowEngine()
    engine.registerCondition('all_ready', async () => true)
    const s = makeWritableSession([stateRow({ condition: 'all_ready' })], 1)
    expect((await engine.transition(s as never, manual, actx)).success).toBe(true)
  })

  it('with no open history row the step duration is null, not NaN', async () => {
    // `enteredAt` is missing on instances created before the history existed:
    // `Date.now() - new Date(null)` would write a meaningless number on the node.
    const s = makeWritableSession([stateRow({ enteredAt: null })], 1)
    await new WorkflowEngine().transition(s as never, manual, actx)
    expect((s.txRun.mock.calls[0]![1] as Record<string, unknown>)['durationMs']).toBeNull()
  })

  it('a target step with no category does not break the transition', async () => {
    const s = makeWritableSession([stateRow({ nextStepCategory: undefined, nextStepTerminal: false })], 1)
    expect((await new WorkflowEngine().transition(s as never, manual, actx)).success).toBe(true)
  })

  it('an action configured WITHOUT a type is named "null" in the error, not ignored', async () => {
    const s = makeSession([stateRow({ nextEnterActions: '[{"params":{}}]' })])
    const r = await new WorkflowEngine().transition(s as never, manual, actx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('Unknown workflow action type: null (enter_actions')
  })

  it('an action and a listener rejecting with something that is NOT an Error are still readable', async () => {
    const { runAction } = await import('../actions.js')
    vi.mocked(runAction).mockRejectedValueOnce('bare rejection')
    const engine = new WorkflowEngine()
    engine.onStepEntered(() => Promise.reject('bare listener'))
    const s = makeWritableSession([stateRow({ nextEnterActions: '[{"type":"notify","params":{}}]' })], 1)
    const r = await engine.transition(s as never, manual, actx)
    expect(r.actionErrors).toEqual(['notify: bare rejection', 'step_entered listener: bare listener'])
  })

  it('getHistory with no tenantId passes null: the WHERE compares it, it does not skip it', async () => {
    const s = makeReadingSession([])
    await new WorkflowEngine().getHistory(s as never, 'wi-1')
    expect((s.txRun.mock.calls[0]![1] as Record<string, unknown>)['tenantId']).toBeNull()
  })
})
