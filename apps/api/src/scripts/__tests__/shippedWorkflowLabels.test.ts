/**
 * Giro nel browser del 14 set 2026 (#22): le etichette dei workflow spediti
 * erano in italiano con l'interfaccia inglese. Il contratto:
 *  - ogni etichetta spedita di base è inglese (niente italiano);
 *  - ogni etichetta ha la sua traduzione italiana, salvo le parole tecniche
 *    dichiarate qui, che in italiano si dicono in inglese;
 *  - la migrazione trova una riga per passo/transizione tradotti, senza
 *    etichette contraddittorie fra definizioni.
 */
import { describe, it, expect } from 'vitest'
import { INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW, PROBLEM_WORKFLOW, KB_ARTICLE_WORKFLOW_BASE } from '@opengraphity/workflow'
import { CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW } from '../lib/workflowDefinitions.js'
import { shippedLabelRows } from '../migrations/20260924_1060_workflow_labels_by_language.js'

const DEFS = [INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW, PROBLEM_WORKFLOW, KB_ARTICLE_WORKFLOW_BASE, CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW]
/** Parole tecniche: uguali nelle due lingue (vedi la regola «parole tecniche in inglese»). */
const SAME_IN_ITALIAN = new Set(['Escalate', 'Security Review', 'Assessment', 'Deployment', 'Review'])
const ITALIAN = /[àèéìòù]|\b(il|la|di|del|della|in carico|attesa|nuovo|chiuso|risolto|approva|rifiuta|rigetta|richiedi|evadi|inviata)\b/i

describe('etichette dei workflow spediti', () => {
  const all = DEFS.flatMap((d) => [
    ...d.steps.map((s) => ({ where: `${d.name} · step ${s.name}`, label: s.label, labels: s.labels })),
    ...d.transitions.map((t) => ({ where: `${d.name} · ${t.fromStepName}→${t.toStepName}`, label: t.label, labels: t.labels })),
  ]).filter((x) => x.label !== '')

  it('la base è inglese', () => {
    expect(all.filter((x) => ITALIAN.test(x.label)).map((x) => `${x.where}: ${x.label}`)).toEqual([])
  })

  it('ogni etichetta ha l\'italiano, salvo le parole tecniche dichiarate', () => {
    expect(all.filter((x) => !x.labels?.['it'] && !SAME_IN_ITALIAN.has(x.label)).map((x) => `${x.where}: ${x.label}`)).toEqual([])
  })

  it('la tabella della migrazione ha i passi e le transizioni tradotti, per entità', () => {
    const { steps, transitions } = shippedLabelRows(DEFS)
    expect(steps).toContainEqual(expect.objectContaining({ entityType: 'incident', name: 'new', label: 'New', it: 'Nuovo' }))
    expect(transitions).toContainEqual(expect.objectContaining({ entityType: 'service_request', from: 'submitted', to: 'in_progress', trigger: 'manual', label: 'Take charge', it: 'Prendi in carico' }))
    expect(JSON.parse(steps[0]!.labels)).toHaveProperty('it')
  })
})
