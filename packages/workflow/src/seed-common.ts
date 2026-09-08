/**
 * Seed IDEMPOTENTE di una WorkflowDefinition (incident, problem, KB, …).
 *
 * Perché esiste: i tre seed storici erano copie con tre semantiche diverse
 * (CREATE sempre → definizioni duplicate; MERGE + DETACH DELETE degli step →
 * istanze vive orfane di CURRENT_STEP; skip-if-exists). Qui una sola regola:
 *   - la definizione è cercata per (tenant_id, entity_type, name) e aggiornata;
 *   - gli step sono MERGE per (definition_id, name): i nodi ESISTENTI vengono
 *     conservati (le istanze vive li puntano via CURRENT_STEP) e aggiornati;
 *     i nuovi ricevono un id scopato alla definizione (niente collisioni tra
 *     definizioni dello stesso tenant);
 *   - uno step rimosso dal seed viene cancellato SOLO se nessuna istanza lo
 *     sta attraversando, altrimenti fail-loud;
 *   - le transizioni vengono ricreate dal seed (sono la parte "canonica");
 *   - infine ogni istanza della definizione senza CURRENT_STEP viene
 *     ricollegata allo step con il suo current_step (auto-riparazione).
 */
import { v4 as uuidv4 } from 'uuid'
import type { Session } from 'neo4j-driver'
import { getSession, toNumber } from '@opengraphity/neo4j'
import type { WorkflowDefinition, WorkflowStepDef } from './types.js'

export type SeedableWorkflow = Omit<WorkflowDefinition, 'id' | 'tenantId'> & { category?: string | null }

export interface SeedResult {
  definitionId: string
  created:      boolean
  relinked:     number
}

export interface SeedOptions {
  /** Se la definizione esiste già, non toccarla (es. KB, personalizzata dal designer). */
  skipIfExists?: boolean
  /** Sessione esterna (WRITE); altrimenti ne apre una propria. */
  session?: Session
}

const STEP_METADATA_KEY_RE = /^[a-z][a-z0-9_]*$/
const RESERVED_STEP_KEYS = new Set(['id', 'name', 'label', 'type', 'definition_id', 'tenant_id', 'enter_actions', 'exit_actions', 'created_at', 'updated_at'])

/** Le chiavi dei metadati finiscono in un `SET s += map`: solo snake_case, mai le proprietà strutturali. */
function assertStepMetadata(defName: string, stepName: string, metadata: WorkflowStepDef['metadata']): Record<string, string | number | boolean | null> {
  if (!metadata) return {}
  for (const key of Object.keys(metadata)) {
    if (!STEP_METADATA_KEY_RE.test(key) || RESERVED_STEP_KEYS.has(key)) {
      throw new Error(`Seed "${defName}", step "${stepName}": chiave metadata non ammessa "${key}"`)
    }
  }
  return metadata
}

export async function seedWorkflowDefinition(tenantId: string, def: SeedableWorkflow, opts: SeedOptions = {}): Promise<SeedResult> {
  const session = opts.session ?? getSession(undefined, 'WRITE')
  const ownSession = !opts.session
  const now = new Date().toISOString()
  const newDefId = uuidv4()

  try {
    return await session.executeWrite(async (tx) => {
      // 1. Definizione: upsert per (tenant, entity_type, name).
      const existing = await tx.run(`
        MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, name: $name})
        RETURN wd.id AS id LIMIT 1
      `, { tenantId, entityType: def.entityType, name: def.name })
      const existed = existing.records.length > 0
      if (existed && opts.skipIfExists) {
        return { definitionId: existing.records[0]!.get('id') as string, created: false, relinked: 0 }
      }
      const defRes = await tx.run(`
        MERGE (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, name: $name})
        ON CREATE SET wd.id = $newDefId, wd.created_at = $now
        SET wd.version = $version, wd.active = $active, wd.category = $category,
            wd.change_subtype = $changeSubtype, wd.updated_at = $now
        RETURN wd.id AS id
      `, {
        tenantId, entityType: def.entityType, name: def.name, newDefId, now,
        version: def.version, active: def.active,
        category: def.category ?? null, changeSubtype: def.changeSubtype ?? null,
      })
      const defId = defRes.records[0]!.get('id') as string

      // 2. Step: MERGE per (definition_id, name); i nodi esistenti restano.
      await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $defId})
        UNWIND $steps AS st
        MERGE (s:WorkflowStep {definition_id: $defId, name: st.name})
        ON CREATE SET s.id = $defId + '-' + st.id, s.tenant_id = $tenantId, s.created_at = $now
        SET s.label = st.label, s.type = st.type,
            s.enter_actions = st.enterActions, s.exit_actions = st.exitActions,
            s.updated_at = $now
        SET s += st.metadata
        MERGE (wd)-[:HAS_STEP]->(s)
      `, {
        defId, tenantId, now,
        steps: def.steps.map((s) => ({
          id: s.id, name: s.name, label: s.label, type: s.type,
          enterActions: JSON.stringify(s.enterActions), exitActions: JSON.stringify(s.exitActions),
          metadata: assertStepMetadata(def.name, s.name, s.metadata),
        })),
      })

      // 3. Step non più nel seed: via solo se nessuna istanza li attraversa.
      const removed = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $defId})-[:HAS_STEP]->(s:WorkflowStep)
        WHERE NOT s.name IN $names
        OPTIONAL MATCH (wi:WorkflowInstance)-[:CURRENT_STEP]->(s)
        RETURN s.name AS name, count(wi) AS live
      `, { defId, names: def.steps.map((s) => s.name) })
      const blocking = removed.records
        .filter((r) => toNumber(r.get('live')) > 0)
        .map((r) => r.get('name') as string)
      if (blocking.length > 0) {
        throw new Error(`Seed "${def.name}": gli step ${blocking.join(', ')} non sono più nel seed ma hanno istanze in corso — migra prima quelle istanze`)
      }
      if (removed.records.length > 0) {
        await tx.run(`
          MATCH (wd:WorkflowDefinition {id: $defId})-[:HAS_STEP]->(s:WorkflowStep)
          WHERE NOT s.name IN $names
          DETACH DELETE s
        `, { defId, names: def.steps.map((s) => s.name) })
      }

      // 4. Transizioni: ricreate dal seed (canoniche), id scopati alla definizione.
      await tx.run(`
        MATCH (:WorkflowStep {definition_id: $defId})-[t:TRANSITIONS_TO]->(:WorkflowStep {definition_id: $defId})
        DELETE t
      `, { defId })
      const created = await tx.run(`
        UNWIND $transitions AS tr
        MATCH (from:WorkflowStep {definition_id: $defId, name: tr.fromStepName})
        MATCH (to:WorkflowStep   {definition_id: $defId, name: tr.toStepName})
        CREATE (from)-[:TRANSITIONS_TO {
          id: $defId + '-' + tr.id, trigger: tr.trigger, label: tr.label, condition: tr.condition,
          requires_input: tr.requiresInput, input_field: tr.inputField
        }]->(to)
        RETURN count(*) AS n
      `, { defId, transitions: def.transitions })
      // Una transizione verso uno step inesistente sarebbe un CREATE su MATCH
      // vuoto: nessun errore da Neo4j, workflow silenziosamente monco.
      const createdN = toNumber(created.records[0]?.get('n'))
      if (createdN !== def.transitions.length) {
        const known = new Set(def.steps.map((s) => s.name))
        const bad = def.transitions.filter((t) => !known.has(t.fromStepName) || !known.has(t.toStepName))
          .map((t) => `${t.fromStepName}→${t.toStepName}`)
        throw new Error(`Seed "${def.name}": create ${createdN} transizioni su ${def.transitions.length} — step inesistenti in: ${bad.join(', ') || '(vedi nomi step)'}`)
      }

      // 5. Auto-riparazione: istanze senza CURRENT_STEP ricollegate per nome.
      const relink = await tx.run(`
        MATCH (wi:WorkflowInstance {definition_id: $defId})
        WHERE NOT (wi)-[:CURRENT_STEP]->()
        MATCH (s:WorkflowStep {definition_id: $defId, name: wi.current_step})
        MERGE (wi)-[:CURRENT_STEP]->(s)
        RETURN count(wi) AS n
      `, { defId })
      const relinked = toNumber(relink.records[0]?.get('n'))

      console.log(`[workflow] Seeded "${def.name}" for tenant "${tenantId}": definitionId=${defId} (${existed ? 'aggiornata' : 'creata'}${relinked ? `, ${relinked} istanze ricollegate` : ''})`)
      return { definitionId: defId, created: !existed, relinked }
    })
  } finally {
    if (ownSession) await session.close()
  }
}
