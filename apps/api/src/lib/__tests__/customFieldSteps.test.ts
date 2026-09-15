/** Secondo giro UI del 15 set 2026: «Outcome» della change si chiedeva già all'apertura. */
import { describe, it, expect } from 'vitest'
import { assertStepsExist, fieldStepState, parseStepEditability, parseStepVisibility } from '../customFieldSteps.js'

const change = (current: string) => ({
  current,
  steps: [
    { name: 'assessment', order: 1 }, { name: 'approval', order: 2 }, { name: 'scheduled', order: 3 },
    { name: 'deployment', order: 4 }, { name: 'review', order: 5 }, { name: 'closed', order: 6 },
  ],
})

describe('fieldStepState', () => {
  it('senza regole: si vede e si modifica sempre', () => {
    expect(fieldStepState(parseStepVisibility(null, 'x'), parseStepEditability(null, 'x'), change('assessment'))).toEqual({ visible: true, editable: true })
  })

  it('«da review in poi»: nascosto all\'apertura, visibile in review e dopo', () => {
    const v = parseStepVisibility('{"mode":"from","step":"review"}', 'outcome')
    const e = parseStepEditability(null, 'outcome')
    expect(fieldStepState(v, e, change('assessment'))).toEqual({ visible: false, editable: false })
    expect(fieldStepState(v, e, change('review'))).toEqual({ visible: true, editable: true })
    expect(fieldStepState(v, e, change('closed'))).toEqual({ visible: true, editable: true })
  })

  it('modificabile solo in alcune fasi: altrove si vede in sola lettura, e mai dove non si vede', () => {
    const v = parseStepVisibility({ mode: 'from', step: 'review' }, 'outcome')
    const e = parseStepEditability({ mode: 'steps', steps: ['review'] }, 'outcome')
    expect(fieldStepState(v, e, change('review'))).toEqual({ visible: true, editable: true })
    expect(fieldStepState(v, e, change('closed'))).toEqual({ visible: true, editable: false })
    const onlyApproval = parseStepEditability({ mode: 'steps', steps: ['approval'] }, 'outcome')
    expect(fieldStepState(v, onlyApproval, change('approval'))).toEqual({ visible: false, editable: false })
  })

  it('«solo in queste fasi»', () => {
    const v = parseStepVisibility({ mode: 'steps', steps: ['approval', 'scheduled'] }, 'x')
    expect(fieldStepState(v, parseStepEditability(null, 'x'), change('scheduled')).visible).toBe(true)
    expect(fieldStepState(v, parseStepEditability(null, 'x'), change('deployment')).visible).toBe(false)
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

describe('le query leggono l\'ordine del disegnatore', () => {
  it('`step_order` (non `order`, che i passi non hanno): dal vivo ogni passo valeva 0 e «da review in poi» si vedeva ovunque', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../customFieldSteps.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/coalesce\(s\.order/)
    expect(src.match(/coalesce\(s\.step_order, 999\)/g)?.length).toBe(2)
  })
})
