/**
 * I fatti del passo che accompagnano ogni evento di ingresso in un passo
 * (ondata 4, D-22) e la lista dei tipi di evento che i workflow di un tenant
 * possono davvero produrre.
 *
 * Il contratto (tipo stabile + alias storico, nome del passo nel payload) sta
 * in `@opengraphity/types` — `stepEnteredEventType`, `legacyStepEventType`,
 * `StepEnteredFacts` — perché lo condividono chi pubblica (apps/api) e chi
 * consuma (packages/notifications). Qui c'è solo la lettura dal grafo.
 */
import type { Session } from 'neo4j-driver'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import {
  type StepEnteredFacts, stepEnteredEventType, legacyStepEventType,
} from '@opengraphity/types'
import { audit } from './audit.js'
import type { GraphQLContext } from '../context.js'
import { logger } from './logger.js'
import { parseLocalizedLabels, localizedLabel } from '@opengraphity/types'
import { languageFor } from './tenantLanguage.js'

/**
 * Etichetta, scopo, categoria e id del passo `stepName` nel workflow attivo
 * del tenant per quell'entità.
 *
 * **Fail-loud**: se il passo non c'è, si ferma. Chi chiama ha appena fatto
 * transizionare il motore su quel passo, quindi «non trovato» è
 * un'incoerenza del dato, non un caso normale: proseguire con l'etichetta
 * uguale al nome e lo scopo a `null` sarebbe un ripiego silenzioso (il job
 * dell'evento fallisce, resta nella coda dei falliti e si rigioca).
 *
 * Più definizioni attive per la stessa entità (c-one ne ha due per gli
 * incident) possono avere un passo con lo stesso nome: si prende quella con
 * la versione più alta, deterministicamente.
 */
export async function loadStepFacts(
  session: Session, tenantId: string, entityType: string, stepName: string,
): Promise<StepEnteredFacts> {
  const row = await runQueryOne<{
    stepId: string; label: string | null; labels: string | null; purpose: string | null; category: string | null
  }>(session, `
    MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
    MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep {name: $stepName})
    RETURN s.id AS stepId, s.label AS label, s.labels AS labels, s.purpose AS purpose, s.category AS category,
           wd.version AS version
    ORDER BY version DESC
    LIMIT 1
  `, { tenantId, entityType, stepName })
  /**
   * Anche le definizioni DISATTIVATE (revisione totale · C-31): il passo si
   * cercava solo fra quelle attive, quindi un ticket rimasto su una versione
   * precedente del workflow — normale: si attiva la versione 2 con i ticket in
   * volo — faceva fallire la costruzione dell'evento, e la transizione non
   * notificava più niente. La definizione attiva resta la prima scelta
   * (ORDER BY nella query qui sopra); questa è la seconda.
   */
  const fallback = row ?? await runQueryOne<{
    stepId: string; label: string | null; labels: string | null; purpose: string | null; category: string | null
  }>(session, `
    MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType})
    MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep {name: $stepName})
    RETURN s.id AS stepId, s.label AS label, s.labels AS labels, s.purpose AS purpose, s.category AS category,
           wd.version AS version
    ORDER BY version DESC
    LIMIT 1
  `, { tenantId, entityType, stepName })
  if (!fallback) {
    throw new Error(
      `Tenant ${tenantId}: step "${stepName}" does not exist in any "${entityType}" workflow (active or not) — ` +
      `the step-entered event cannot be built (step label, purpose and category).`,
    )
  }
  if (!row) {
    logger.warn({ module: 'step-event', tenantId, entityType, stepName },
      'Passo assente dal workflow attivo: i fatti del passo vengono da una definizione disattivata (ticket su una versione precedente)')
  }
  // L'etichetta nella lingua del cliente (giro del 14 set 2026, #22): la
  // notifica si compone una volta per tutti, quindi vale la lingua predefinita
  // dell'organizzazione, non quella di chi la leggerà.
  const base = fallback.label ?? stepName
  const stepLabel = localizedLabel(base, parseLocalizedLabels(fallback.labels, `step ${fallback.stepId}`), await languageFor(tenantId))
  return {
    step_id:       fallback.stepId,
    step_name:     stepName,
    step_label:    stepLabel,
    step_purpose:  fallback.purpose ?? null,
    step_category: fallback.category ?? null,
  }
}

/** Un tipo di evento offribile all'interfaccia (regole di notifica, webhook in uscita). */
export interface WorkflowEventTypeRow {
  eventType:    string
  entityType:   string | null
  stepName:     string | null
  stepLabel:    string | null
  stepPurpose:  string | null
  stepCategory: string | null
  stable:       boolean
}

/**
 * I tipi di evento che i workflow del tenant possono produrre: per ogni entità
 * con un workflow attivo il tipo **stabile** (`incident.step_entered`) e, per
 * ogni passo, l'**alias** col nome del passo (`incident.pending`) — che è
 * quello a cui sono agganciate le regole di fabbrica e quelle già scritte.
 *
 * È la risposta a «abbonare un webhook al proprio passo era impossibile»: le
 * sei costanti di `OUTBOUND_EVENTS` non contenevano nessun passo intermedio,
 * e il nome del tipo generato non era indovinabile.
 */
export async function workflowEventTypeRows(
  session: Session, tenantId: string, entityType?: string | null,
): Promise<WorkflowEventTypeRow[]> {
  const rows = await runQuery<{
    entityType: string; stepName: string; label: string | null
    purpose: string | null; category: string | null; stepOrder: unknown
  }>(session, `
    MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, active: true})
    WHERE $entityType IS NULL OR wd.entity_type = $entityType
    MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
    RETURN wd.entity_type AS entityType, s.name AS stepName, s.label AS label,
           s.purpose AS purpose, s.category AS category, s.step_order AS stepOrder
    ORDER BY entityType, stepOrder, stepName
  `, { tenantId, entityType: entityType ?? null })

  const out: WorkflowEventTypeRow[] = []
  const seen = new Set<string>()
  const entities = [...new Set(rows.map((r) => r.entityType))]
  for (const et of entities) {
    out.push({
      eventType: stepEnteredEventType(et), entityType: et,
      stepName: null, stepLabel: null, stepPurpose: null, stepCategory: null, stable: true,
    })
    seen.add(stepEnteredEventType(et))
  }
  for (const r of rows) {
    const eventType = legacyStepEventType(r.entityType, r.stepName)
    // Due definizioni attive con lo stesso nome di passo → un tipo solo.
    if (seen.has(eventType)) continue
    seen.add(eventType)
    out.push({
      eventType,
      entityType:   r.entityType,
      stepName:     r.stepName,
      stepLabel:    r.label ?? r.stepName,
      stepPurpose:  r.purpose  ?? null,
      stepCategory: r.category ?? null,
      stable:       false,
    })
  }
  return out
}

// ── L'azione di audit dell'ingresso in un passo (D-22, punto 3) ───────────────

/**
 * Scrive la voce di audit dell'ingresso in un passo con un'azione **stabile**
 * (`incident.step_entered`) e il passo nei dettagli.
 *
 * ## Il taglio dichiarato
 * Prima l'azione era composta col nome del passo (`incident.assigned`,
 * `incident.in_progress`): il vocabolario dell'audit ERA il vocabolario dei
 * passi, quindi una rinomina spezzava in due la storia di un filtro o di un
 * report. Le azioni **storiche non vengono riscritte** — un registro di
 * conformità non si corregge a posteriori, e riscriverlo sarebbe peggio del
 * difetto. Il cambio di vocabolario è quindi un taglio nella storia, e va
 * dichiarato: dalla data di questa ondata le transizioni si trovano sotto
 * `<entità>.step_entered`, prima sotto `<entità>.<nome del passo>`.
 * `details.legacy_action` porta il vecchio nome, così un filtro sui dettagli
 * ricuce le due metà; la pagina dell'audit offre in tendina le azioni
 * realmente presenti nel registro, comprese quelle vecchie.
 *
 * Se i fatti del passo non si leggono, la voce si scrive comunque col solo
 * nome del passo e il motivo finisce nei log: un'operazione tracciabile non
 * deve restare senza traccia perché un metadato manca.
 */
export async function auditStepEntered(
  session: Session,
  ctx: GraphQLContext,
  entityType: string,
  auditEntityType: string,
  entityId: string,
  stepName: string,
): Promise<void> {
  const legacyAction = legacyStepEventType(entityType, stepName)
  let details: Record<string, unknown> = { step_name: stepName, legacy_action: legacyAction }
  try {
    details = { ...(await loadStepFacts(session, ctx.tenantId, entityType, stepName)), legacy_action: legacyAction }
  } catch (err) {
    logger.warn(
      { err, module: 'step-event', tenantId: ctx.tenantId, entityType, stepName },
      '[audit] fatti del passo non leggibili: la voce di audit porta solo il nome del passo',
    )
  }
  await audit(ctx, stepEnteredEventType(entityType), auditEntityType, entityId, details)
}
