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

/**
 * L'ETICHETTA DI UN ARCO NOMINA TUTTO QUELLO CHE LA SUA CONDIZIONE VERIFICA.
 *
 * `all_assessments_complete` pretende TRE task per ogni CI impattato — gli
 * assessment funzionale e tecnico E il piano di rilascio
 * (`areAllAssessmentsComplete`) — e l'arco si chiamava «Assessment completed».
 * Chi lo vedeva non scattare andava a guardare i due assessment, li trovava
 * completati, e non aveva modo di sapere che mancava il piano. Stessa cosa per
 * `all_deployments_complete`, che verifica la validazione E il deployment
 * mentre l'arco diceva solo «Deployment completed».
 *
 * Il gemello di questo test sta in `apps/web/src/lib/__tests__/
 * condizioniWorkflowNominanoTutto.test.ts` e guarda le due frasi i18n (la
 * scelta nel disegnatore e il motivo del rifiuto); questo guarda le etichette
 * SPEDITE, che sono la terza copia delle stesse parole. Servono tutti e due:
 * la prima volta la cura era arrivata solo a una delle tre (17 set 2026).
 */
describe('un arco con condizione nomina ciò che la condizione verifica', () => {
  /** Condizione → una di queste parole deve comparire, per lingua. */
  const DEVE_NOMINARE: Record<string, { en: readonly string[]; it: readonly string[]; perche: string }> = {
    all_assessments_complete: {
      en: ['plan'], it: ['piano'],
      perche: 'verifica anche il DeployPlanTask, non solo i due assessment',
    },
    all_deployments_complete: {
      en: ['validation'], it: ['verific', 'validazion'],
      perche: 'verifica anche la ValidationTest, non solo il DeploymentTask',
    },
  }

  const archi = DEFS.flatMap((d) => d.transitions.map((t) => ({
    where: `${d.name} · ${t.fromStepName}→${t.toStepName}`,
    condition: t.condition ?? null,
    label: t.label,
    it: (t.labels as { it?: string } | undefined)?.it ?? '',
  })))

  it('ogni arco di fabbrica con una di queste condizioni la nomina per intero', () => {
    const colpevoli: string[] = []
    for (const a of archi) {
      const regola = a.condition ? DEVE_NOMINARE[a.condition] : undefined
      if (!regola) continue
      const nomina = (testo: string, parole: readonly string[]) =>
        parole.some((p) => testo.toLowerCase().includes(p))
      if (!nomina(a.label, regola.en)) colpevoli.push(`${a.where} (en) «${a.label}» — ${regola.perche}`)
      if (a.it !== '' && !nomina(a.it, regola.it)) colpevoli.push(`${a.where} (it) «${a.it}» — ${regola.perche}`)
    }
    expect(colpevoli).toEqual([])
  })

  /* Il guardiano vede il caso che lo motiva, altrimenti è muto. */
  it('la regola riconosce le due etichette di prima', () => {
    const r = DEVE_NOMINARE['all_assessments_complete']!
    expect(r.en.some((p) => 'Assessment completed'.toLowerCase().includes(p))).toBe(false)
    expect(r.en.some((p) => 'Assessments and plan completed'.toLowerCase().includes(p))).toBe(true)
    const d = DEVE_NOMINARE['all_deployments_complete']!
    expect(d.it.some((p) => 'Deployment completato'.toLowerCase().includes(p))).toBe(false)
    expect(d.it.some((p) => 'Deployment e verifiche completati'.toLowerCase().includes(p))).toBe(true)
  })

  /* E almeno un arco deve essere in perimetro: una regola che non guarda niente passa sempre. */
  it('il perimetro non è vuoto', () => {
    expect(archi.filter((a) => a.condition && DEVE_NOMINARE[a.condition]).length).toBeGreaterThan(0)
  })
})
