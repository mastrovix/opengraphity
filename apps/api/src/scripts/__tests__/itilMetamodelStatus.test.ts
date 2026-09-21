/**
 * Il campo `status` del metamodello ITIL spedito elenca ESATTAMENTE i passi
 * del workflow spedito (revisione totale · H-43).
 *
 * Erano quattro elenchi scritti a mano e nessuno coincideva col suo workflow:
 * l'incident aveva un `open` che nessun passo ha, la richiesta di servizio
 * diceva `open/in_progress/completed/cancelled` mentre il workflow fa
 * `submitted/approval/in_progress/fulfilled/closed/rejected`, la change
 * elencava dodici valori di un workflow che non esiste più e il problem
 * dimenticava `known_error`. Il campo lo scrive il motore dei workflow: se le
 * due liste divergono, il Dizionario offre valori che nessun ticket avrà mai e
 * ne nasconde altri che ha.
 */
import { describe, it, expect } from 'vitest'
import { INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW, PROBLEM_WORKFLOW } from '@opengraphity/workflow'
import { ITIL_TYPES } from '../seed-itil-metamodel.js'
import { CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW } from '../lib/workflowDefinitions.js'

/** I valori dichiarati dal campo `status` di un tipo ITIL del metamodello. */
function statusValues(typeName: string): string[] {
  const type = ITIL_TYPES.find((t) => t.name === typeName)
  expect(type, `tipo ITIL "${typeName}" assente dal metamodello spedito`).toBeDefined()
  const field = type!.fields.find((f) => f.name === 'status')
  expect(field?.enum_values, `il campo status di "${typeName}" non ha enum_values`).toBeDefined()
  return field!.enum_values!
}

const CASI: Array<[string, ReadonlyArray<{ steps: ReadonlyArray<{ name: string }> }>]> = [
  ['incident',        [INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW]],
  ['problem',         [PROBLEM_WORKFLOW]],
  ['change',          [CHANGE_RFC_WORKFLOW]],
  ['service_request', [SERVICE_REQUEST_WORKFLOW]],
]

describe('metamodello ITIL spedito: status ↔ passi del workflow', () => {
  for (const [typeName, workflows] of CASI) {
    it(`${typeName}: gli status sono i nomi dei passi, senza aggiunte né mancanze`, () => {
      const passi = [...new Set(workflows.flatMap((w) => w.steps.map((s) => s.name)))]
      expect(statusValues(typeName).slice().sort()).toEqual(passi.slice().sort())
    })
  }

  it('nessuno status è una stringa vuota o duplicata', () => {
    for (const [typeName] of CASI) {
      const valori = statusValues(typeName)
      expect(valori.filter((v) => v.trim() === ''), typeName).toEqual([])
      expect(new Set(valori).size, typeName).toBe(valori.length)
    }
  })
})
