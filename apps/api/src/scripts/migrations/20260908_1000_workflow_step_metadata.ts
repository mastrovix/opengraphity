/**
 * Popola is_initial / is_terminal / is_open / category / step_order sui
 * WorkflowStep che ne sono PRIVI (era lo script one-shot migrate-workflow-metadata).
 *
 * Regole di derivazione (solo per i valori mancanti):
 *   - step.type = 'start' → is_initial true
 *   - step.type = 'end' o nome in TERMINAL_NAMES → is_terminal true, is_open false
 *   - altrimenti → is_open true
 *   - category dal nome (CATEGORY_MAP), step_order da STEP_ORDER
 *
 * B-15: la derivazione è **coalesce**, non `SET` incondizionato. Un valore già
 * presente sul nodo — che sia del seed o scelto dall'amministratore — non viene
 * mai riscritto, nemmeno rilanciando la migrazione con `--force`: `--force`
 * serve a completare i mancanti. Il ripristino di fabbrica è un'altra
 * operazione, esplicita e con diff: `migrate-workflow-metadata --reset-from-factory`
 * (vedi `resetWorkflowStepMetadataFromFactory` più sotto).
 *
 * I nomi di fabbrica restano una **derivazione di ripiego**: sono i seed a
 * dichiarare i metadati dei propri passi (packages/workflow/src/seed*.ts,
 * scripts/lib/workflowDefinitions.ts).
 */
import type { Migration, Queryable } from '@opengraphity/neo4j'

const TERMINAL_NAMES = ['resolved', 'closed', 'completed', 'rejected', 'failed']

const CATEGORY_MAP: Record<string, string> = {
  new:                 'active',
  assigned:            'active',
  in_progress:         'active',
  pending:             'waiting',
  escalated:           'escalated',
  assessment:          'active',
  approval:            'waiting',
  cab_approval:        'waiting',
  emergency_approval:  'waiting',
  scheduled:           'waiting',
  draft:               'draft',
  security_review:     'active',
  deployment:          'active',
  validation:          'active',
  review:              'active',
  published:           'published',
  archived:            'closed',
  pending_review:      'waiting',
  resolved:            'resolved',
  closed:              'closed',
  completed:           'closed',
  rejected:            'failed',
  failed:              'failed',
  post_review:         'closed',
}

/** step_order di ripiego per entity_type; un nome sconosciuto finisce a 99 (in fondo). */
const STEP_ORDER: Record<string, Record<string, number>> = {
  change: {
    assessment: 1, approval: 2, scheduled: 3, deployment: 4, review: 5, closed: 6,
  },
  incident: {
    new: 1, assigned: 2, security_review: 3, in_progress: 4, pending: 5,
    escalated: 6, resolved: 7, closed: 8,
  },
  problem: {
    new: 1, under_investigation: 2, known_error: 3, change_requested: 4,
    change_in_progress: 5, resolved: 6, deferred: 7, rejected: 8, closed: 9,
  },
  kb_article: {
    draft: 1, pending_review: 2, published: 3, archived: 4,
  },
  service_request: {
    submitted: 1, approval: 2, in_progress: 3, fulfilled: 4, closed: 5, rejected: 6,
  },
}

const PARAMS = { terminalNames: TERMINAL_NAMES, categoryMap: CATEGORY_MAP, stepOrder: STEP_ORDER }

export const workflowStepMetadata: Migration = {
  id: '20260908_1000_workflow_step_metadata',
  description: 'WorkflowStep: is_initial/is_terminal/is_open/category/step_order MANCANTI derivati da type e nome (coalesce: mai una riscrittura)',
  async up(session) {
    const res = await session.run(`
      MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)
      WITH wd, s, s.name AS n, s.type AS t
      WITH wd, s, n, t,
           (t = 'start')                                                AS isInitial,
           (t = 'end'  OR n IN $terminalNames)                          AS isTerminal,
           coalesce($stepOrder[wd.entity_type][n], 99)                  AS stepOrd
      WITH wd, s, isInitial, isTerminal, stepOrd, n,
           (s.is_initial IS NULL OR s.is_terminal IS NULL OR s.is_open IS NULL
            OR s.category IS NULL OR s.step_order IS NULL)              AS incomplete
      SET s.is_initial  = coalesce(s.is_initial,  isInitial),
          s.is_terminal = coalesce(s.is_terminal, isTerminal),
          s.is_open     = coalesce(s.is_open,     NOT isTerminal),
          s.category    = coalesce(s.category,    $categoryMap[n], CASE WHEN isTerminal THEN 'closed' ELSE 'active' END),
          s.step_order  = coalesce(s.step_order,  stepOrd)
      RETURN count(s) AS seen, sum(CASE WHEN incomplete THEN 1 ELSE 0 END) AS completed
    `, PARAMS)
    const r = res.records[0]
    console.log(`[${workflowStepMetadata.id}] ${String(r?.get('seen') ?? 0)} WorkflowStep esaminati, ${String(r?.get('completed') ?? 0)} completati (i valori già presenti non sono stati toccati)`)
  },
}

/**
 * Ripristino di fabbrica ESPLICITO dei metadati dei passi: riscrive
 * is_initial/is_terminal/is_open/category/step_order derivandoli da type e
 * nome, **cancellando** le scelte dell'amministratore.
 *
 * Non è una migrazione (non ha marker, non entra nel registro): è il vecchio
 * comportamento di `--force`, con il nome che gli spetta e il diff stampato
 * prima di scrivere. Lo usa `migrate-workflow-metadata --reset-from-factory`.
 */
export async function resetWorkflowStepMetadataFromFactory(
  session: Queryable,
  opts: { dryRun?: boolean; log?: (m: string) => void } = {},
): Promise<{ changed: number }> {
  const log = opts.log ?? ((m: string) => { console.log(m) })
  const diff = await session.run(`
    MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)
    WITH wd, s, s.name AS n, s.type AS t
    WITH wd, s, n,
         (t = 'start')                               AS isInitial,
         (t = 'end'  OR n IN $terminalNames)         AS isTerminal,
         coalesce($stepOrder[wd.entity_type][n], 99) AS stepOrd
    WITH wd, s, n, isInitial, isTerminal, stepOrd,
         coalesce($categoryMap[n], CASE WHEN isTerminal THEN 'closed' ELSE 'active' END) AS cat
    WHERE s.is_initial <> isInitial OR s.is_terminal <> isTerminal OR s.is_open <> (NOT isTerminal)
       OR s.category <> cat OR s.step_order <> stepOrd
       OR s.is_initial IS NULL OR s.is_terminal IS NULL OR s.is_open IS NULL
       OR s.category IS NULL OR s.step_order IS NULL
    RETURN wd.tenant_id AS tenant, wd.name AS def, n AS step,
           s.is_initial AS oldInit,  isInitial  AS newInit,
           s.is_terminal AS oldTerm, isTerminal AS newTerm,
           s.category   AS oldCat,   cat        AS newCat,
           s.step_order AS oldOrd,   stepOrd    AS newOrd
    ORDER BY tenant, def, step
  `, PARAMS)

  log(`[reset-from-factory] ${String(diff.records.length)} passi cambierebbero:`)
  for (const r of diff.records) {
    const bits: string[] = []
    if (String(r.get('oldInit')) !== String(r.get('newInit'))) bits.push(`is_initial ${String(r.get('oldInit'))}→${String(r.get('newInit'))}`)
    if (String(r.get('oldTerm')) !== String(r.get('newTerm'))) bits.push(`is_terminal ${String(r.get('oldTerm'))}→${String(r.get('newTerm'))}`)
    if (String(r.get('oldCat'))  !== String(r.get('newCat')))  bits.push(`category ${String(r.get('oldCat'))}→${String(r.get('newCat'))}`)
    if (String(r.get('oldOrd'))  !== String(r.get('newOrd')))  bits.push(`step_order ${String(r.get('oldOrd'))}→${String(r.get('newOrd'))}`)
    log(`  ~ ${String(r.get('tenant'))} / "${String(r.get('def'))}" / ${String(r.get('step'))}: ${bits.join(', ')}`)
  }
  if (opts.dryRun === true) { log('[reset-from-factory] --dry-run: niente scritto.'); return { changed: diff.records.length } }
  if (diff.records.length === 0) return { changed: 0 }

  await session.run(`
    MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)
    WITH wd, s, s.name AS n, s.type AS t
    WITH wd, s, n,
         (t = 'start')                               AS isInitial,
         (t = 'end'  OR n IN $terminalNames)         AS isTerminal,
         coalesce($stepOrder[wd.entity_type][n], 99) AS stepOrd
    SET s.is_initial  = isInitial,
        s.is_terminal = isTerminal,
        s.is_open     = NOT isTerminal,
        s.category    = coalesce($categoryMap[n], CASE WHEN isTerminal THEN 'closed' ELSE 'active' END),
        s.step_order  = stepOrd
  `, PARAMS)
  log(`[reset-from-factory] scritti ${String(diff.records.length)} passi.`)
  return { changed: diff.records.length }
}
