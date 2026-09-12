/**
 * Seed di una WorkflowDefinition (incident, problem, KB, …).
 *
 * Regola cardine (B-2): **il seed non distrugge la configurazione del cliente.**
 * Una definizione che esiste già NON viene toccata — per tutte le definizioni,
 * non solo per la KB — e il seed dice che l'ha saltata e perché. Riallineare al
 * seed di fabbrica è un'operazione deliberata:
 *
 *   - `overwrite: true` (script: `--overwrite`) stampa PRIMA il diff (passi
 *     aggiunti/rimossi/cambiati, transizioni, azioni, proprietà della
 *     definizione) e poi scrive;
 *   - se la definizione è marchiata come personalizzata (`wd.customized_at`,
 *     scritto dalle mutation del disegnatore) l'overwrite semplice **si
 *     rifiuta**, nominando definizione, data e autore: serve
 *     `overwriteCustomized: true` (script: `--overwrite-customized`).
 *
 * Quando scrive davvero, la scrittura resta quella di prima:
 *   - la definizione è cercata per (tenant_id, entity_type, name);
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

/** Perché il seed non ha scritto su una definizione che esisteva già. */
export type SeedSkipReason = 'exists' | null

export interface SeedStepChange {
  name:   string
  fields: string[]
}

export interface SeedTransitionChange {
  key:    string
  fields: string[]
}

/** Che cosa cambierebbe (o è cambiato) riallineando la definizione al seed. */
export interface SeedDiff {
  definitionFields:   string[]
  stepsAdded:         string[]
  stepsRemoved:       string[]
  stepsChanged:       SeedStepChange[]
  transitionsAdded:   string[]
  transitionsRemoved: string[]
  transitionsChanged: SeedTransitionChange[]
}

export function seedDiffIsEmpty(d: SeedDiff): boolean {
  return d.definitionFields.length === 0
    && d.stepsAdded.length === 0 && d.stepsRemoved.length === 0 && d.stepsChanged.length === 0
    && d.transitionsAdded.length === 0 && d.transitionsRemoved.length === 0 && d.transitionsChanged.length === 0
}

export interface SeedResult {
  definitionId: string
  created:      boolean
  /** True quando la definizione esisteva e il seed NON l'ha toccata. */
  skipped:      boolean
  skipReason:   SeedSkipReason
  relinked:     number
  /** Valorizzato solo quando il seed ha riscritto una definizione esistente. */
  diff:         SeedDiff | null
  /** Marchio del disegnatore trovato sulla definizione esistente (se c'era). */
  customizedAt: string | null
  customizedBy: string | null
}

export interface SeedOptions {
  /**
   * Riallinea al seed una definizione che esiste già (default: NO, la salta).
   * Stampa il diff prima di scrivere.
   */
  overwrite?: boolean
  /**
   * Secondo consenso, necessario per riallineare una definizione marchiata
   * come personalizzata dal disegnatore (`wd.customized_at`). Implica
   * `overwrite`.
   */
  overwriteCustomized?: boolean
  /** Sessione esterna (WRITE); altrimenti ne apre una propria. */
  session?: Session
}

/** Rifiuto esplicito: la definizione è stata personalizzata dall'amministratore. */
export class CustomizedWorkflowError extends Error {
  override readonly name = 'CustomizedWorkflowError'
  constructor(
    readonly tenantId:     string,
    readonly definition:   string,
    readonly definitionId: string,
    readonly customizedAt: string,
    readonly customizedBy: string | null,
  ) {
    super(
      `Seed "${definition}" (tenant "${tenantId}", defId ${definitionId}): la definizione è stata personalizzata `
      + `il ${customizedAt} da ${customizedBy ?? 'utente sconosciuto'} — l'overwrite si rifiuta. `
      + `Per riportarla comunque al seed di fabbrica, e PERDERE quelle modifiche, rilancia con --overwrite-customized.`,
    )
  }
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

// ── Diff ─────────────────────────────────────────────────────────────────────

interface LiveStep {
  name:         string
  label:        string | null
  type:         string | null
  enterActions: string | null
  exitActions:  string | null
  metadata:     Record<string, unknown>
}

interface LiveTransition {
  fromStepName:  string
  toStepName:    string
  trigger:       string | null
  label:         string | null
  condition:     string | null
  requiresInput: boolean | null
  inputField:    string | null
}

function trKey(t: { fromStepName: string; toStepName: string; trigger: string | null }): string {
  return `${t.fromStepName} → ${t.toStepName} [${t.trigger ?? '?'}]`
}

/** Confronta valori che in Neo4j possono arrivare come Integer/Float e in JS come number. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  const na = toNumberish(a)
  const nb = toNumberish(b)
  if (na !== null && nb !== null) return na === nb
  return String(a) === String(b)
}

function toNumberish(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'object' && v !== null && 'low' in (v as Record<string, unknown>)) {
    try { return toNumber(v) } catch { return null }
  }
  return null
}

export function computeSeedDiff(
  def:       SeedableWorkflow,
  liveDef:   { version: unknown; active: unknown; category: unknown; changeSubtype: unknown },
  liveSteps: readonly LiveStep[],
  liveTrs:   readonly LiveTransition[],
): SeedDiff {
  const definitionFields: string[] = []
  if (!sameValue(liveDef.version, def.version))                             definitionFields.push(`version ${String(liveDef.version)} → ${String(def.version)}`)
  if (!sameValue(liveDef.active, def.active))                               definitionFields.push(`active ${String(liveDef.active)} → ${String(def.active)}`)
  if (!sameValue(liveDef.category, def.category ?? null))                   definitionFields.push(`category ${String(liveDef.category)} → ${String(def.category ?? null)}`)
  if (!sameValue(liveDef.changeSubtype, def.changeSubtype ?? null))         definitionFields.push(`change_subtype ${String(liveDef.changeSubtype)} → ${String(def.changeSubtype ?? null)}`)

  const liveByName = new Map(liveSteps.map((s) => [s.name, s]))
  const seedNames  = new Set(def.steps.map((s) => s.name))

  const stepsAdded   = def.steps.filter((s) => !liveByName.has(s.name)).map((s) => s.name)
  const stepsRemoved = liveSteps.filter((s) => !seedNames.has(s.name)).map((s) => s.name)
  const stepsChanged: SeedStepChange[] = []
  for (const s of def.steps) {
    const live = liveByName.get(s.name)
    if (!live) continue
    const fields: string[] = []
    if (!sameValue(live.label, s.label)) fields.push(`label "${String(live.label)}" → "${s.label}"`)
    if (!sameValue(live.type, s.type))   fields.push(`type "${String(live.type)}" → "${s.type}"`)
    const seedEnter = JSON.stringify(s.enterActions)
    const seedExit  = JSON.stringify(s.exitActions)
    if ((live.enterActions ?? '[]') !== seedEnter) fields.push(`enter_actions ${live.enterActions ?? '[]'} → ${seedEnter}`)
    if ((live.exitActions ?? '[]') !== seedExit)   fields.push(`exit_actions ${live.exitActions ?? '[]'} → ${seedExit}`)
    for (const [k, v] of Object.entries(s.metadata ?? {})) {
      if (!sameValue(live.metadata[k], v)) fields.push(`${k} ${String(live.metadata[k])} → ${String(v)}`)
    }
    if (fields.length > 0) stepsChanged.push({ name: s.name, fields })
  }

  const liveTrByKey = new Map(liveTrs.map((t) => [trKey(t), t]))
  const seedTrKeys  = new Set(def.transitions.map((t) => trKey(t)))
  const transitionsAdded   = def.transitions.filter((t) => !liveTrByKey.has(trKey(t))).map((t) => trKey(t))
  const transitionsRemoved = liveTrs.filter((t) => !seedTrKeys.has(trKey(t))).map((t) => trKey(t))
  const transitionsChanged: SeedTransitionChange[] = []
  for (const t of def.transitions) {
    const live = liveTrByKey.get(trKey(t))
    if (!live) continue
    const fields: string[] = []
    if (!sameValue(live.label, t.label))                   fields.push(`label "${String(live.label)}" → "${t.label}"`)
    if (!sameValue(live.condition, t.condition ?? null))   fields.push(`condition ${String(live.condition)} → ${String(t.condition ?? null)}`)
    if (!sameValue(live.requiresInput, t.requiresInput))   fields.push(`requires_input ${String(live.requiresInput)} → ${String(t.requiresInput)}`)
    if (!sameValue(live.inputField, t.inputField ?? null)) fields.push(`input_field ${String(live.inputField)} → ${String(t.inputField ?? null)}`)
    if (fields.length > 0) transitionsChanged.push({ key: trKey(t), fields })
  }

  return { definitionFields, stepsAdded, stepsRemoved, stepsChanged, transitionsAdded, transitionsRemoved, transitionsChanged }
}

/** Il diff in righe leggibili: quello che l'operatore vede PRIMA della scrittura. */
export function formatSeedDiff(defName: string, tenantId: string, d: SeedDiff): string[] {
  const out = [`[workflow] Diff "${defName}" (tenant "${tenantId}") — quello che --overwrite sta per scrivere:`]
  if (seedDiffIsEmpty(d)) { out.push('  (nessuna differenza: la definizione è già identica al seed)'); return out }
  for (const f of d.definitionFields)         out.push(`  ~ definizione: ${f}`)
  for (const n of d.stepsAdded)               out.push(`  + passo "${n}"`)
  for (const n of d.stepsRemoved)             out.push(`  - passo "${n}"  (rimosso: non è nel seed)`)
  for (const c of d.stepsChanged)  for (const f of c.fields) out.push(`  ~ passo "${c.name}": ${f}`)
  for (const k of d.transitionsAdded)         out.push(`  + transizione ${k}`)
  for (const k of d.transitionsRemoved)       out.push(`  - transizione ${k}  (rimossa: non è nel seed)`)
  for (const c of d.transitionsChanged) for (const f of c.fields) out.push(`  ~ transizione ${c.key}: ${f}`)
  return out
}

// ── Seed ─────────────────────────────────────────────────────────────────────

export async function seedWorkflowDefinition(tenantId: string, def: SeedableWorkflow, opts: SeedOptions = {}): Promise<SeedResult> {
  const session = opts.session ?? getSession(undefined, 'WRITE')
  const ownSession = !opts.session
  const now = new Date().toISOString()
  const newDefId = uuidv4()
  const overwriteCustomized = opts.overwriteCustomized === true
  const overwrite = opts.overwrite === true || overwriteCustomized

  try {
    return await session.executeWrite(async (tx) => {
      // 1. La definizione esiste già? Se sì, di regola NON la si tocca (B-2).
      const existing = await tx.run(`
        MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, name: $name})
        RETURN wd.id AS id, wd.version AS version, wd.active AS active, wd.category AS category,
               wd.change_subtype AS changeSubtype,
               wd.customized_at AS customizedAt, wd.customized_by AS customizedBy
        LIMIT 1
      `, { tenantId, entityType: def.entityType, name: def.name })
      const existedRec   = existing.records[0]
      const existed      = existedRec !== undefined
      // Il marchio lo scrivono le mutation del disegnatore; una definizione che
      // non ce l'ha semplicemente non è (ancora) stata personalizzata.
      const customizedAt = (existedRec?.get('customizedAt') as string | null | undefined) ?? null
      const customizedBy = (existedRec?.get('customizedBy') as string | null | undefined) ?? null

      if (existed && !overwrite) {
        const defId = existedRec.get('id') as string
        const why = customizedAt !== null
          ? `è stata personalizzata il ${customizedAt} da ${customizedBy ?? 'utente sconosciuto'}`
          : 'esiste già'
        console.log(
          `[workflow] "${def.name}" (tenant "${tenantId}", defId ${defId}): SALTATA, ${why}. `
          + `Il seed non sovrascrive una definizione esistente: per riallinearla al seed di fabbrica usa --overwrite`
          + `${customizedAt !== null ? ' --overwrite-customized' : ''}.`,
        )
        return { definitionId: defId, created: false, skipped: true, skipReason: 'exists' as const, relinked: 0, diff: null, customizedAt, customizedBy }
      }

      if (existed && customizedAt !== null && !overwriteCustomized) {
        throw new CustomizedWorkflowError(tenantId, def.name, existedRec.get('id') as string, customizedAt, customizedBy)
      }

      // 2. Overwrite deliberato: leggi lo stato attuale e stampa il diff PRIMA di scrivere.
      let diff: SeedDiff | null = null
      if (existed) {
        const defId = existedRec.get('id') as string
        const stepsRes = await tx.run(`
          MATCH (:WorkflowDefinition {id: $defId})-[:HAS_STEP]->(s:WorkflowStep)
          RETURN s.name AS name, s.label AS label, s.type AS type,
                 s.enter_actions AS enterActions, s.exit_actions AS exitActions, properties(s) AS props
        `, { defId })
        const liveSteps: LiveStep[] = stepsRes.records.map((r) => ({
          name:         r.get('name') as string,
          label:        r.get('label') as string | null,
          type:         r.get('type') as string | null,
          enterActions: r.get('enterActions') as string | null,
          exitActions:  r.get('exitActions') as string | null,
          metadata:     (r.get('props') as Record<string, unknown>) ?? {},
        }))
        const trRes = await tx.run(`
          MATCH (from:WorkflowStep {definition_id: $defId})-[t:TRANSITIONS_TO]->(to:WorkflowStep {definition_id: $defId})
          RETURN from.name AS fromStepName, to.name AS toStepName, t.trigger AS trigger, t.label AS label,
                 t.condition AS condition, t.requires_input AS requiresInput, t.input_field AS inputField
        `, { defId })
        const liveTrs: LiveTransition[] = trRes.records.map((r) => ({
          fromStepName:  r.get('fromStepName') as string,
          toStepName:    r.get('toStepName') as string,
          trigger:       r.get('trigger') as string | null,
          label:         r.get('label') as string | null,
          condition:     r.get('condition') as string | null,
          requiresInput: r.get('requiresInput') as boolean | null,
          inputField:    r.get('inputField') as string | null,
        }))
        diff = computeSeedDiff(def, {
          version:       existedRec.get('version'),
          active:        existedRec.get('active'),
          category:      existedRec.get('category'),
          changeSubtype: existedRec.get('changeSubtype'),
        }, liveSteps, liveTrs)
        for (const line of formatSeedDiff(def.name, tenantId, diff)) console.log(line)
        if (customizedAt !== null) {
          console.log(`[workflow] ATTENZIONE: "${def.name}" era marchiata come personalizzata (${customizedAt}, ${customizedBy ?? 'utente sconosciuto'}); --overwrite-customized rimuove il marchio.`)
        }
      }

      const defRes = await tx.run(`
        MERGE (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, name: $name})
        ON CREATE SET wd.id = $newDefId, wd.created_at = $now
        SET wd.version = $version, wd.active = $active, wd.category = $category,
            wd.change_subtype = $changeSubtype, wd.updated_at = $now
        ${existed ? 'SET wd.customized_at = null, wd.customized_by = null, wd.seed_overwritten_at = $now' : ''}
        RETURN wd.id AS id
      `, {
        tenantId, entityType: def.entityType, name: def.name, newDefId, now,
        version: def.version, active: def.active,
        category: def.category ?? null, changeSubtype: def.changeSubtype ?? null,
      })
      const defId = defRes.records[0]!.get('id') as string

      // 3. Step: MERGE per (definition_id, name); i nodi esistenti restano.
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

      // 4. Step non più nel seed: via solo se nessuna istanza li attraversa.
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

      // 5. Transizioni: ricreate dal seed (canoniche), id scopati alla definizione.
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

      // 6. Auto-riparazione: istanze senza CURRENT_STEP ricollegate per nome.
      const relink = await tx.run(`
        MATCH (wi:WorkflowInstance {definition_id: $defId})
        WHERE NOT (wi)-[:CURRENT_STEP]->()
        MATCH (s:WorkflowStep {definition_id: $defId, name: wi.current_step})
        MERGE (wi)-[:CURRENT_STEP]->(s)
        RETURN count(wi) AS n
      `, { defId })
      const relinked = toNumber(relink.records[0]?.get('n'))

      console.log(`[workflow] Seeded "${def.name}" for tenant "${tenantId}": definitionId=${defId} (${existed ? 'RISCRITTA dal seed (--overwrite)' : 'creata'}${relinked ? `, ${relinked} istanze ricollegate` : ''})`)
      return { definitionId: defId, created: !existed, skipped: false, skipReason: null, relinked, diff, customizedAt, customizedBy }
    })
  } finally {
    if (ownSession) await session.close()
  }
}
