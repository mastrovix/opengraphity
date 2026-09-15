/**
 * IN QUALI FASI SI VEDE E SI MODIFICA UN CAMPO DEL CLIENTE (secondo giro UI del
 * 15 set 2026, decisione del proprietario).
 *
 * ## Il difetto
 * Ogni campo aggiunto a un tipo di ticket compariva nel modulo di apertura: su
 * `c-test` la change chiedeva «Outcome» (riuscita, fallita, annullata) a chi la
 * apriva, cioè l'esito di una cosa non ancora fatta.
 *
 * ## La regola
 * Chi configura il campo sceglie:
 *  - DOVE SI VEDE: sempre; solo in certe fasi; oppure da una fase in poi, cioè
 *    da quando il ticket è ENTRATO in quella fase almeno una volta (la storia
 *    del workflow, `STEP_HISTORY`). Prima era «le fasi che nel disegnatore
 *    vengono dopo» (`step_order`): un incident riaperto (Resolved → In Progress)
 *    nascondeva il campo compilato alla risoluzione, e un ramo mai percorso
 *    (Pending, prima di Escalated nell'ordine) lo mostrava;
 *  - DOVE SI MODIFICA: dovunque si veda; oppure solo in certe fasi (e comunque
 *    solo dove si vede).
 * L'apertura del ticket è la sua fase iniziale: un campo che lì non si vede non
 * è nel modulo di apertura, e l'API lo rifiuta da ogni canale. Senza regole
 * (`null`) il campo si vede e si modifica sempre, com'era.
 *
 * Un ticket senza istanza di workflow (dato vecchio) non ha fasi: le regole non
 * possono dire niente, e il campo resta visibile e modificabile — lo stesso
 * trattamento dei campi senza regole.
 */
import type { Session } from 'neo4j-driver'
import { ValidationError } from './errors.js'

export type StepVisibility =
  | { mode: 'always' }
  | { mode: 'steps'; steps: string[] }
  | { mode: 'from'; step: string }

export type StepEditability =
  | { mode: 'visible' }
  | { mode: 'steps'; steps: string[] }

export const ALWAYS_VISIBLE: StepVisibility = { mode: 'always' }
export const EDITABLE_WHERE_VISIBLE: StepEditability = { mode: 'visible' }

/** La fase in cui il ticket si trova (o in cui nasce) e quelle in cui è entrato almeno una volta, corrente compresa. */
export interface StepContext { current: string; visited: string[] }

function stepList(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((s) => typeof s !== 'string' || s.trim() === '')) {
    throw new ValidationError(`${where}: "steps" must be a non-empty list of step names.`, { key: 'errors.customField.stepRulesShape', params: { where } })
  }
  return [...new Set((v as string[]).map((s) => s.trim()))]
}

/** Da quello che è salvato (JSON) o arriva dall'input: fail-loud su una forma che non si capisce. */
export function parseStepVisibility(raw: unknown, where: string): StepVisibility {
  if (raw == null || raw === '') return ALWAYS_VISIBLE
  const v = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown>
  switch (v['mode']) {
    case 'always': return ALWAYS_VISIBLE
    case 'steps':  return { mode: 'steps', steps: stepList(v['steps'], where) }
    case 'from': {
      const step = v['step']
      if (typeof step !== 'string' || step.trim() === '') {
        throw new ValidationError(`${where}: "from" needs the step the field is visible from.`, { key: 'errors.customField.stepRulesShape', params: { where } })
      }
      return { mode: 'from', step: step.trim() }
    }
    default:
      throw new ValidationError(`${where}: visibility mode "${String(v['mode'])}" is not one of always, steps, from.`, { key: 'errors.customField.stepRulesShape', params: { where } })
  }
}

export function parseStepEditability(raw: unknown, where: string): StepEditability {
  if (raw == null || raw === '') return EDITABLE_WHERE_VISIBLE
  const v = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown>
  switch (v['mode']) {
    case 'visible': return EDITABLE_WHERE_VISIBLE
    case 'steps':   return { mode: 'steps', steps: stepList(v['steps'], where) }
    default:
      throw new ValidationError(`${where}: editability mode "${String(v['mode'])}" is not one of visible, steps.`, { key: 'errors.customField.stepRulesShape', params: { where } })
  }
}

/** I nomi di fase che le regole citano. */
export function stepsNamedBy(visibility: StepVisibility, editability: StepEditability): string[] {
  return [...new Set([
    ...(visibility.mode === 'steps' ? visibility.steps : visibility.mode === 'from' ? [visibility.step] : []),
    ...(editability.mode === 'steps' ? editability.steps : []),
  ])]
}

/** Una fase citata che il workflow di quel tipo di ticket non ha: rifiutata quando si salva il campo. */
export function assertStepsExist(visibility: StepVisibility, editability: StepEditability, knownSteps: readonly string[], field: string): void {
  const unknown = stepsNamedBy(visibility, editability).filter((s) => !knownSteps.includes(s))
  if (unknown.length > 0) {
    throw new ValidationError(
      `Field "${field}": the workflow has no step ${unknown.map((s) => `"${s}"`).join(', ')} (steps: ${knownSteps.join(', ')}).`,
      { key: 'errors.customField.unknownSteps', params: { field, steps: unknown.join(', '), known: knownSteps.join(', ') } },
    )
  }
}

/** Visibile e modificabile nella fase del contesto. `null` = nessuna fase nota: sempre sì. */
export function fieldStepState(visibility: StepVisibility, editability: StepEditability, ctx: StepContext | null): { visible: boolean; editable: boolean } {
  if (!ctx) return { visible: true, editable: true }
  let visible: boolean
  switch (visibility.mode) {
    case 'always': visible = true; break
    case 'steps':  visible = visibility.steps.includes(ctx.current); break
    case 'from':   visible = ctx.current === visibility.step || ctx.visited.includes(visibility.step); break
  }
  const editable = visible && (editability.mode === 'visible' || editability.steps.includes(ctx.current))
  return { visible, editable }
}

/** La fase corrente del ticket e quelle in cui è entrato (dalla storia del workflow); null senza istanza. */
export async function ticketStepContext(session: Session, tenantId: string, ticketId: string): Promise<StepContext | null> {
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (e {id: $ticketId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(x:WorkflowStepExecution)
    RETURN wi.current_step AS current, collect(DISTINCT x.step_name) AS visited
  `, { ticketId, tenantId }))
  const r = res.records[0]
  if (!r || r.get('current') == null) return null
  const current = String(r.get('current'))
  const visited = ((r.get('visited') ?? []) as unknown[]).filter((v): v is string => typeof v === 'string')
  return { current, visited: visited.includes(current) ? visited : [...visited, current] }
}

/**
 * Il contesto dell'APERTURA: la definizione che il motore sceglierebbe per quel
 * tipo e quella categoria (la stessa selezione di `createInstance`) e il suo
 * passo iniziale. null se il tipo non ha una definizione attiva.
 */
export async function creationStepContext(session: Session, tenantId: string, entityType: string, category: string | null): Promise<StepContext | null> {
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
    WITH wd, CASE WHEN wd.category IS NOT NULL AND wd.category = $category THEN 0 WHEN wd.category IS NULL THEN 1 ELSE 2 END AS priority
    WHERE priority < 2
    WITH wd ORDER BY priority ASC, wd.version DESC LIMIT 1
    MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
    WHERE coalesce(s.is_initial, s.type = 'start')
    RETURN s.name AS initial ORDER BY CASE WHEN s.is_initial = true THEN 0 ELSE 1 END, s.name LIMIT 1
  `, { tenantId, entityType, category }))
  const initial = res.records[0]?.get('initial') as string | undefined
  if (!initial) return null
  return { current: initial, visited: [initial] }
}

/** Le fasi di ogni workflow attivo di un tipo di ticket, per il disegnatore e per la diagnostica. */
export async function workflowStepsByDefinition(session: Session, tenantId: string, entityType: string): Promise<Array<{ workflow: string; category: string | null; steps: Array<{ name: string; label: string; labels: string | null; order: number }> }>> {
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})-[:HAS_STEP]->(s:WorkflowStep)
    WITH wd, s ORDER BY coalesce(s.step_order, 999), s.name
    RETURN wd.name AS workflow, wd.category AS category,
           collect({name: s.name, label: coalesce(s.label, s.name), labels: s.labels, order: coalesce(s.step_order, 999)}) AS steps
    ORDER BY (wd.category IS NULL) DESC, wd.name
  `, { tenantId, entityType }))
  return res.records.map((r) => ({
    workflow: String(r.get('workflow')),
    category: (r.get('category') ?? null) as string | null,
    steps: (r.get('steps') as Array<{ name: string; label: string; labels: unknown; order: unknown }>).map((s) => ({
      name: s.name, label: s.label, labels: typeof s.labels === 'string' ? s.labels : null, order: Number(s.order),
    })),
  }))
}

/** Tutti i nomi di fase dei workflow attivi di un tipo di ticket (per validare le regole quando si salva il campo). */
export async function workflowStepNames(session: Session, tenantId: string, entityType: string): Promise<string[]> {
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})-[:HAS_STEP]->(s:WorkflowStep)
    RETURN collect(DISTINCT s.name) AS names
  `, { tenantId, entityType }))
  return ((res.records[0]?.get('names') ?? []) as string[]).sort()
}
