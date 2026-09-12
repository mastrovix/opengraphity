/**
 * Single mapping WorkflowDefinition/WorkflowStep/TRANSITIONS_TO → GraphQL
 * shape. It was copied in workflowQueries (×3) and workflowMutations (×2)
 * with drifting field sets (A-23: `workflowDefinitions` lacked
 * sourceHandle/targetHandle/timerDelayMinutes/subWorkflowId/positionX/Y).
 * Every resolver now returns the same superset.
 */
import type { Session } from 'neo4j-driver'

type Props = Record<string, unknown>

export interface TransitionRow {
  id:            string
  fromStep:      string
  toStep:        string
  trigger:       string
  label:         string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
  timerHours:    unknown
  sourceHandle:  string | null
  targetHandle:  string | null
}

/**
 * Loads the transitions of a definition. Steps are matched on
 * (definition_id, tenant_id), so the rows are tenant-scoped by construction.
 */
export async function loadTransitionRows(session: Session, definitionId: string, tenantId: string): Promise<TransitionRow[]> {
  const result = await session.executeRead((tx) =>
    tx.run(`
      MATCH (from:WorkflowStep {definition_id: $defId, tenant_id: $tenantId})-[tr:TRANSITIONS_TO]->(to:WorkflowStep)
      RETURN from.name AS fromStep, to.name AS toStep,
             tr.id AS id, tr.trigger AS trigger, tr.label AS label,
             tr.requires_input AS requiresInput,
             tr.input_field AS inputField,
             tr.condition AS condition,
             tr.timer_hours AS timerHours,
             tr.source_handle AS sourceHandle,
             tr.target_handle AS targetHandle
    `, { defId: definitionId, tenantId }),
  )
  return result.records.map((r) => ({
    id:            r.get('id')            as string,
    fromStep:      r.get('fromStep')      as string,
    toStep:        r.get('toStep')        as string,
    trigger:       r.get('trigger')       as string,
    label:         r.get('label')         as string,
    requiresInput: r.get('requiresInput') as boolean,
    inputField:    (r.get('inputField')   ?? null) as string | null,
    condition:     (r.get('condition')    ?? null) as string | null,
    timerHours:    r.get('timerHours'),
    sourceHandle:  (r.get('sourceHandle') ?? null) as string | null,
    targetHandle:  (r.get('targetHandle') ?? null) as string | null,
  }))
}

export function mapWorkflowStep(s: Props) {
  return {
    id:                s['id']    as string,
    // `definitionId` non è nello SDL: serve al field resolver
    // `WorkflowStep.currentInstances`, che senza di esso non saprebbe in quale
    // definizione cercare lo step (i nomi si ripetono tra definizioni).
    definitionId:      s['definition_id'] as string,
    name:              s['name']  as string,
    label:             s['label'] as string,
    type:              s['type']  as string,
    enterActions:      (s['enter_actions'] ?? null) as string | null,
    exitActions:       (s['exit_actions']  ?? null) as string | null,
    timerDelayMinutes: s['timer_delay_minutes'] != null ? Number(s['timer_delay_minutes']) : null,
    subWorkflowId:     (s['sub_workflow_id'] ?? null) as string | null,
    isInitial:         Boolean(s['is_initial']  ?? s['type'] === 'start'),
    isTerminal:        Boolean(s['is_terminal'] ?? s['type'] === 'end'),
    isOpen:            (s['is_open'] != null) ? Boolean(s['is_open']) : !(s['type'] === 'end'),
    category:          (s['category'] ?? null) as string | null,
    order:             s['step_order'] != null ? Number(s['step_order']) : 999,
    // Designer layout: written by saveWorkflowChanges.positions, read back
    // here so the canvas does not fall back to the default layout.
    positionX:         s['position_x'] != null ? Number(s['position_x']) : null,
    positionY:         s['position_y'] != null ? Number(s['position_y']) : null,
  }
}

export function mapWorkflowTransition(r: TransitionRow) {
  return {
    id:            r.id,
    fromStepName:  r.fromStep,
    toStepName:    r.toStep,
    trigger:       r.trigger,
    label:         r.label,
    requiresInput: r.requiresInput,
    inputField:    r.inputField,
    condition:     r.condition,
    timerHours:    r.timerHours != null ? Number(r.timerHours) : null,
    sourceHandle:  r.sourceHandle,
    targetHandle:  r.targetHandle,
  }
}

export function mapWorkflowDefinition(
  wd: Props,
  steps: Array<{ properties: Props }>,
  transitions: TransitionRow[],
) {
  return {
    id:            wd['id']              as string,
    name:          wd['name']            as string,
    entityType:    wd['entity_type']     as string,
    category:      (wd['category']       ?? null) as string | null,
    changeSubtype: (wd['change_subtype'] ?? null) as string | null,
    version:       Number(wd['version'] ?? 1),
    active:        wd['active']          as boolean,
    steps:         steps.map((s) => mapWorkflowStep(s.properties)).sort((a, b) => a.order - b.order),
    transitions:   transitions.map(mapWorkflowTransition),
  }
}
