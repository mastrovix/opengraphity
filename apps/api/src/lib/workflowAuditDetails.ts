/**
 * COSA È CAMBIATO in un salvataggio del disegnatore dei workflow, per l'Audit
 * Log (secondo giro UI del 15 set 2026, note minori). La voce
 * `workflow.updated` diceva solo quale workflow: non quale passo, quale arco,
 * quale scadenza, né da che versione a quale.
 *
 * Il salvataggio manda tutti i passi e gli archi del disegno, cambiati o no:
 * il confronto si fa sulle fotografie del grafo prima e dopo, nella stessa
 * transazione, e nel registro finisce solo quello che è davvero diverso.
 */
import type { ManagedTransaction } from 'neo4j-driver'

export type Snapshot = Record<string, Record<string, unknown>>

/** Un valore troppo lungo (le azioni in JSON) si tronca: il registro dice che è cambiato, non ne fa una copia. */
const MAX_VALUE = 300
function shown(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_VALUE) return `${v.slice(0, MAX_VALUE)}…`
  return v ?? null
}

const STEP_FIELDS = ['label', 'category', 'purpose', 'enter_actions', 'exit_actions', 'is_initial', 'is_terminal', 'is_open', 'deadline'] as const
const TRANSITION_FIELDS = ['label', 'trigger', 'requires_input', 'input_field', 'condition', 'timer_hours'] as const

/** Passi e archi del workflow come stanno ora nel grafo. */
export async function workflowSnapshot(tx: ManagedTransaction, tenantId: string, definitionId: string): Promise<{ steps: Snapshot; transitions: Snapshot }> {
  const s = await tx.run(`
    MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(st:WorkflowStep)
    RETURN st.name AS name, st { ${STEP_FIELDS.map((f) => `.${f}`).join(', ')} } AS props
  `, { definitionId, tenantId })
  const tr = await tx.run(`
    MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(src:WorkflowStep)-[t:TRANSITIONS_TO]->(dst:WorkflowStep)
    RETURN src.name + ' → ' + dst.name AS name, t { ${TRANSITION_FIELDS.map((f) => `.${f}`).join(', ')} } AS props
  `, { definitionId, tenantId })
  const toMap = (rows: typeof s.records): Snapshot => Object.fromEntries(rows.map((r) => [String(r.get('name')), r.get('props') as Record<string, unknown>]))
  return { steps: toMap(s.records), transitions: toMap(tr.records) }
}

type Change = { from: unknown; to: unknown }

function diff(before: Snapshot, after: Snapshot, fields: readonly string[]): Array<{ name: string; changed: Record<string, Change> }> {
  const out: Array<{ name: string; changed: Record<string, Change> }> = []
  for (const name of Object.keys(after).sort()) {
    const a = after[name] ?? {}
    const b = before[name] ?? {}
    const changed: Record<string, Change> = {}
    for (const f of fields) {
      const from = b[f] ?? null
      const to = a[f] ?? null
      if (JSON.stringify(from) !== JSON.stringify(to)) changed[f] = { from: shown(from), to: shown(to) }
    }
    if (Object.keys(changed).length > 0) out.push({ name, changed })
  }
  return out
}

/** I dettagli della voce `workflow.updated`: versioni e solo i passi e gli archi cambiati. */
export function workflowChangeDetails(
  before: { steps: Snapshot; transitions: Snapshot },
  after: { steps: Snapshot; transitions: Snapshot },
  fromVersion: number,
  toVersion: number,
): Record<string, unknown> {
  return {
    fromVersion,
    toVersion,
    steps: diff(before.steps, after.steps, STEP_FIELDS).map(({ name, changed }) => ({ step: name, changed })),
    transitions: diff(before.transitions, after.transitions, TRANSITION_FIELDS).map(({ name, changed }) => ({ transition: name, changed })),
  }
}
