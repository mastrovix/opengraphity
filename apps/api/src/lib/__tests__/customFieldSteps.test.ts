/** Secondo giro UI del 15 set 2026: «Outcome» della change si chiedeva già all'apertura. */
import { describe, it, expect } from 'vitest'
import { assertStepsExist, fieldStepState, parseStepEditability, parseStepVisibility } from '../customFieldSteps.js'

/** Il ticket in una fase, con le fasi in cui è entrato (la storia del workflow). */
const at = (current: string, visited: string[] = []) => ({ current, visited: [...visited, current] })

describe('fieldStepState', () => {
  it('senza regole: si vede e si modifica sempre', () => {
    expect(fieldStepState(parseStepVisibility(null, 'x'), parseStepEditability(null, 'x'), at('assessment'))).toEqual({ visible: true, editable: true })
  })

  it('«da review in poi»: nascosto finché il ticket non ci entra, poi visibile anche nelle fasi successive', () => {
    const v = parseStepVisibility('{"mode":"from","step":"review"}', 'outcome')
    const e = parseStepEditability(null, 'outcome')
    expect(fieldStepState(v, e, at('assessment'))).toEqual({ visible: false, editable: false })
    expect(fieldStepState(v, e, at('review', ['assessment', 'deployment']))).toEqual({ visible: true, editable: true })
    expect(fieldStepState(v, e, at('closed', ['assessment', 'review']))).toEqual({ visible: true, editable: true })
  })

  it('riapertura: un campo «da Resolved in poi» resta visibile quando l\'incident torna In Progress', () => {
    const v = parseStepVisibility({ mode: 'from', step: 'resolved' }, 'resolution')
    expect(fieldStepState(v, parseStepEditability(null, 'x'), at('in_progress', ['new', 'assigned', 'in_progress', 'resolved'])).visible).toBe(true)
  })

  it('un ramo mai percorso non lo mostra: «da Pending in poi» non si vede in Escalated se Pending non c\'è stato', () => {
    const v = parseStepVisibility({ mode: 'from', step: 'pending' }, 'x')
    expect(fieldStepState(v, parseStepEditability(null, 'x'), at('escalated', ['new', 'assigned', 'in_progress'])).visible).toBe(false)
  })

  it('modificabile solo in alcune fasi: altrove si vede in sola lettura, e mai dove non si vede', () => {
    const v = parseStepVisibility({ mode: 'from', step: 'review' }, 'outcome')
    const e = parseStepEditability({ mode: 'steps', steps: ['review'] }, 'outcome')
    expect(fieldStepState(v, e, at('review', ['assessment']))).toEqual({ visible: true, editable: true })
    expect(fieldStepState(v, e, at('closed', ['review']))).toEqual({ visible: true, editable: false })
    const onlyApproval = parseStepEditability({ mode: 'steps', steps: ['approval'] }, 'outcome')
    expect(fieldStepState(v, onlyApproval, at('approval'))).toEqual({ visible: false, editable: false })
  })

  it('«solo in queste fasi» guarda la fase corrente', () => {
    const v = parseStepVisibility({ mode: 'steps', steps: ['approval', 'scheduled'] }, 'x')
    expect(fieldStepState(v, parseStepEditability(null, 'x'), at('scheduled', ['approval'])).visible).toBe(true)
    expect(fieldStepState(v, parseStepEditability(null, 'x'), at('deployment', ['approval', 'scheduled'])).visible).toBe(false)
  })

  it('senza fasi note (ticket senza workflow): sempre sì', () => {
    expect(fieldStepState({ mode: 'steps', steps: ['review'] }, { mode: 'steps', steps: ['review'] }, null)).toEqual({ visible: true, editable: true })
  })
})

describe('forma e validazione delle regole', () => {
  it('una forma che non si capisce è un errore, non un «sempre» di ripiego', () => {
    expect(() => parseStepVisibility({ mode: 'sometimes' }, 'outcome')).toThrow(/not one of always, steps, from/)
    expect(() => parseStepVisibility({ mode: 'steps', steps: [] }, 'outcome')).toThrow(/non-empty list/)
    expect(() => parseStepEditability({ mode: 'steps' }, 'outcome')).toThrow(/non-empty list/)
  })

  it('una fase che il workflow non ha è rifiutata dicendo quali ci sono', () => {
    expect(() => assertStepsExist({ mode: 'from', step: 'revue' }, { mode: 'visible' }, ['assessment', 'review'], 'Outcome'))
      .toThrow(/no step "revue" \(steps: assessment, review\)/)
  })
})

describe('«da X in poi» si legge dalla storia del workflow', () => {
  it('la query del ticket raccoglie le fasi di STEP_HISTORY, non l\'ordine del disegnatore', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../customFieldSteps.ts', import.meta.url), 'utf8')
    const fn = src.slice(src.indexOf('export async function ticketStepContext'), src.indexOf('export async function creationStepContext'))
    expect(fn).toContain('[:STEP_HISTORY]->(x:WorkflowStepExecution)')
    expect(fn).not.toContain('step_order')
  })
})
