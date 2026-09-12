import { describe, it, expect, vi } from 'vitest'
import { WorkflowEngine } from '../engine.js'

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
        .rejects.toThrow(/Workflow "Incident Management".*non ha nessuno step iniziale/s)
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
        .rejects.toThrow(/si applica alla categoria "sicurezza".*riservata alla categoria "security"/s)
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
      expect(result.error).toContain('non valida')
    })

    it('un trigger manuale NON può percorrere un arco riservato al sistema (timer/automatic/sla_breach)', async () => {
      const session = makeSession([stateRow({ trigger: 'timer', nextStepName: 'closed' })])
      const result = await new WorkflowEngine().transition(session as never, { ...manual, toStepName: 'closed' }, actx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('riservata al sistema')
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
      expect(r1.error).toContain('Root cause')
      const r2 = await engine.transition(makeSession([row]) as never, { ...manual, triggerType: 'automatic' }, actx)
      expect(r2.success).toBe(false)
    })

    it('condizione non registrata → transizione non valida (workflow mal configurato)', async () => {
      const session = makeSession([stateRow({ condition: 'does_not_exist' })])
      const result = await new WorkflowEngine().transition(session as never, manual, actx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('sconosciuta')
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
      expect(result.error).toContain('concorrente')
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
