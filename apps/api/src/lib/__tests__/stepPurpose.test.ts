/**
 * Lo SCOPO del passo (ondata 4, B-4 / C-9 / D-22): il nucleo che sostituisce i
 * letterali dei nomi. `getStepNamesByPurpose` risponde «quali passi hanno
 * questo ruolo», `requireStepNamesByPurpose` si ferma dicendolo quando nessuno
 * ce l'ha — perché una lista vuota spegnerebbe in silenzio una regola di
 * dominio (soppressione degli allarmi, varco delle approvazioni).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  WORKFLOW_STEP_PURPOSES, CHANGE_WINDOW_PURPOSES, FACTORY_STEP_PURPOSES, isWorkflowStepPurpose,
} from '@opengraphity/types'
import {
  getStepNamesByPurpose, getStepPurpose, requireStepNamesByPurpose, invalidateWorkflowCache,
} from '../workflowHelpers.js'

const rec = (m: Record<string, unknown>) => ({ get: (k: string) => (k in m ? m[k] : null) })

interface S { name: string; purpose?: string | null; category?: string | null }
function sessionOf(steps: S[]) {
  const run = vi.fn(async () => ({
    records: steps.map((s) => rec({
      name: s.name, isInitial: false, isTerminal: false, isOpen: true,
      category: s.category ?? 'active', purpose: s.purpose ?? null, stepOrder: null,
    })),
  }))
  return { executeRead: (fn: (tx: { run: typeof run }) => unknown) => fn({ run }) } as never
}

/** Il cliente ha rinominato tutto: i nomi non dicono più niente, gli scopi sì. */
const CLIENTE = [
  { name: 'valutazione_rischio', purpose: 'assessment' },
  { name: 'cab_settimanale',     purpose: 'approval' },
  { name: 'in_calendario',       purpose: 'scheduled' },
  { name: 'rilascio_notturno',   purpose: 'implementation' },
  { name: 'rilascio_urgente',    purpose: 'implementation' },
  { name: 'chiusa',              purpose: null, category: 'closed' },
]

beforeEach(() => invalidateWorkflowCache())

describe('vocabolario degli scopi', () => {
  it('è chiuso, e ogni nome di fabbrica mappa su uno scopo del vocabolario', () => {
    expect(isWorkflowStepPurpose('implementation')).toBe(true)
    expect(isWorkflowStepPurpose('deployment')).toBe(false)   // è un NOME, non uno scopo
    expect(isWorkflowStepPurpose('')).toBe(false)
    for (const [name, purpose] of Object.entries(FACTORY_STEP_PURPOSES)) {
      expect(WORKFLOW_STEP_PURPOSES, `il nome di fabbrica "${name}"`).toContain(purpose)
    }
  })

  it('la finestra di manutenzione è programmata + aperta, e nient\'altro', () => {
    expect(CHANGE_WINDOW_PURPOSES).toEqual(['scheduled', 'implementation'])
  })
})

describe('getStepNamesByPurpose', () => {
  it('trova i passi per ruolo anche se il cliente li ha rinominati, e ne trova DUE con lo stesso scopo', async () => {
    const s = sessionOf(CLIENTE)
    expect(await getStepNamesByPurpose(s, 'c-one', 'change', ['approval'])).toEqual(['cab_settimanale'])
    expect(await getStepNamesByPurpose(s, 'c-one', 'change', [...CHANGE_WINDOW_PURPOSES]))
      .toEqual(['in_calendario', 'rilascio_notturno', 'rilascio_urgente'])
  })

  it('uno scopo che nessun passo dichiara → lista vuota (chi decide dice cosa fa)', async () => {
    expect(await getStepNamesByPurpose(sessionOf(CLIENTE), 'c-one', 'change', ['validation'])).toEqual([])
  })

  it('non confonde i passi senza scopo con quelli che ce l\'hanno', async () => {
    expect(await getStepNamesByPurpose(sessionOf(CLIENTE), 'c-one', 'change', ['review'])).toEqual([])
    expect(await getStepPurpose(sessionOf(CLIENTE), 'c-one', 'change', 'chiusa')).toBeNull()
    expect(await getStepPurpose(sessionOf(CLIENTE), 'c-one', 'change', 'rilascio_notturno')).toBe('implementation')
    expect(await getStepPurpose(sessionOf(CLIENTE), 'c-one', 'change', 'inesistente')).toBeNull()
  })
})

describe('requireStepNamesByPurpose — fail-loud', () => {
  it('nessun passo con quello scopo → errore che nomina scopo, entità, tenant e la strada', async () => {
    const err = await requireStepNamesByPurpose(
      sessionOf(CLIENTE), 'c-one', 'change', ['validation'], 'soppressione degli allarmi durante il rilascio',
    ).then(() => null, (e: unknown) => e)
    expect(String((err as Error).message)).toMatch(/soppressione degli allarmi durante il rilascio/)
    expect(String((err as Error).message)).toMatch(/nessun passo dichiara lo scopo \[validation\]/)
    expect(String((err as Error).message)).toMatch(/disegnatore/)
  })

  it('almeno un passo → la lista, senza errori', async () => {
    expect(await requireStepNamesByPurpose(sessionOf(CLIENTE), 'c-one', 'change', ['implementation'], 'x'))
      .toEqual(['rilascio_notturno', 'rilascio_urgente'])
  })
})
