/**
 * Giro nel browser del 14 set 2026 (#22): i workflow spediti avevano le
 * etichette in italiano — «Nuovo», «Prendi in carico», «Risolvi» — anche per
 * chi usa l'interfaccia in inglese. Da ora il seed spedisce `label` in inglese
 * e le traduzioni in `labels` (JSON `{ it: … }`), e chi mostra l'etichetta
 * sceglie la lingua di chi guarda.
 *
 * Qui si portano i tenant esistenti allo stesso stato, SENZA toccare quello che
 * il cliente ha scritto: un passo o una transizione si aggiorna solo se la sua
 * etichetta è ancora quella spedita (in italiano o in inglese) e non ha già
 * delle traduzioni. La corrispondenza è per tipo di entità + nome del passo, e
 * per le transizioni + passo di partenza, di arrivo e trigger. Un'etichetta
 * cambiata nel disegnatore resta com'è, e il conteggio lo dice.
 * Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW, PROBLEM_WORKFLOW, KB_ARTICLE_WORKFLOW_BASE, type SeedableWorkflow } from '@opengraphity/workflow'
import { CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW } from '../lib/workflowDefinitions.js'

const SHIPPED: readonly SeedableWorkflow[] = [
  INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW, PROBLEM_WORKFLOW, KB_ARTICLE_WORKFLOW_BASE,
  CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW,
]

interface StepRow { entityType: string; name: string; label: string; it: string; labels: string }
interface TransitionRow extends StepRow { from: string; to: string; trigger: string }

/** Le righe della tabella: solo ciò che ha una traduzione. Stesso passo in due definizioni → una riga sola. */
export function shippedLabelRows(defs: readonly SeedableWorkflow[] = SHIPPED): { steps: StepRow[]; transitions: TransitionRow[] } {
  const steps = new Map<string, StepRow>()
  const transitions = new Map<string, TransitionRow>()
  for (const def of defs) {
    for (const s of def.steps) {
      const it = s.labels?.['it']
      if (!it) continue
      const key = `${def.entityType}|${s.name}`
      const row = { entityType: def.entityType, name: s.name, label: s.label, it, labels: JSON.stringify(s.labels) }
      const prev = steps.get(key)
      if (prev && (prev.label !== row.label || prev.it !== row.it)) throw new Error(`${key}: two shipped definitions label this step differently`)
      steps.set(key, row)
    }
    for (const t of def.transitions) {
      const it = t.labels?.['it']
      if (!it) continue
      const key = `${def.entityType}|${t.fromStepName}|${t.toStepName}|${t.trigger}`
      const row = { entityType: def.entityType, name: '', from: t.fromStepName, to: t.toStepName, trigger: t.trigger, label: t.label, it, labels: JSON.stringify(t.labels) }
      const prev = transitions.get(key)
      if (prev && (prev.label !== row.label || prev.it !== row.it)) throw new Error(`${key}: two shipped definitions label this transition differently`)
      transitions.set(key, row)
    }
  }
  return { steps: [...steps.values()], transitions: [...transitions.values()] }
}

export const workflowLabelsByLanguage: Migration = {
  id: '20260924_1060_workflow_labels_by_language',
  description: 'Etichette dei workflow spediti: inglese di base, italiano in labels (solo dove il cliente non le ha cambiate)',
  async up(session) {
    const { steps, transitions } = shippedLabelRows()
    const s = await session.run(`
      UNWIND $rows AS row
      MATCH (wd:WorkflowDefinition {entity_type: row.entityType})-[:HAS_STEP]->(st:WorkflowStep {name: row.name})
      WHERE st.labels IS NULL
      WITH row, st, st.label IN [row.it, row.label] AS shipped
      FOREACH (_ IN CASE WHEN shipped THEN [1] ELSE [] END | SET st.label = row.label, st.labels = row.labels)
      RETURN sum(CASE WHEN shipped THEN 1 ELSE 0 END) AS updated, sum(CASE WHEN shipped THEN 0 ELSE 1 END) AS customized
    `, { rows: steps })
    const t = await session.run(`
      UNWIND $rows AS row
      MATCH (wd:WorkflowDefinition {entity_type: row.entityType})-[:HAS_STEP]->(a:WorkflowStep {name: row.from})
      MATCH (a)-[tr:TRANSITIONS_TO {trigger: row.trigger}]->(b:WorkflowStep {name: row.to})
      WHERE b.definition_id = a.definition_id AND tr.labels IS NULL
      WITH row, tr, tr.label IN [row.it, row.label] AS shipped
      FOREACH (_ IN CASE WHEN shipped THEN [1] ELSE [] END | SET tr.label = row.label, tr.labels = row.labels)
      RETURN sum(CASE WHEN shipped THEN 1 ELSE 0 END) AS updated, sum(CASE WHEN shipped THEN 0 ELSE 1 END) AS customized
    `, { rows: transitions })
    const n = (r: typeof s, k: string) => Number(r.records[0]?.get(k) ?? 0)
    console.log(`[${workflowLabelsByLanguage.id}] passi aggiornati ${n(s, 'updated')}, lasciati come li ha scritti il cliente ${n(s, 'customized')}; transizioni aggiornate ${n(t, 'updated')}, lasciate ${n(t, 'customized')}`)
  },
}
