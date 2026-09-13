/**
 * Il dato che un tenant deve avere per funzionare — in **una** funzione (D-14).
 *
 * ## Il difetto
 * Un tenant aveva due modi di nascere, e solo uno lo rendeva usabile:
 * - `scripts/onboard-tenant.ts`: nodo `:Tenant`, utente admin, dashboard
 *   predefinita, regole di notifica, matrici di dominio e **tutte** le
 *   definizioni di workflow;
 * - la migrazione `20260909_1010` (e poi la `20260910_1070` per i tenant «solo
 *   integrazione»): il solo nodo `:Tenant` con la policy eventi.
 *
 * `c-two` è nato nel secondo modo, ed è il motivo per cui gli manca tutto: dal
 * vivo 0 `EnumTypeDefinition` propri, **0 `WorkflowDefinition`**, 1 dashboard e
 * le sole regole di notifica messe dalle migrazioni. Il primo `createIncident`
 * di quel tenant muore — giustamente a voce alta — con
 * «No active workflow definition for "incident" in tenant "c-two"»: un tenant
 * che esiste e non può fare niente.
 *
 * ## La regola
 * Un tenant nasce in **un** modo. Questa funzione è quel modo: la chiama
 * `onboard-tenant` e la chiama la migrazione `20260918_1910`, che completa i
 * tenant nati dall'altra strada. È **additiva e idempotente** per costruzione —
 * ogni pezzo è un MERGE «solo dove manca», e nulla riallinea al seme quello che
 * il cliente ha già modificato dal disegnatore (la regola dell'ondata 2).
 *
 * Fuori da qui, perché non è dato del tenant: i vocabolari spediti col prodotto
 * (`seedSystemEnumTypes`, un nodo per tutti su `tenant_id = 'system'`) e i tipi
 * CI condivisi (`seed:metamodel`, una volta per stack).
 */
import { v4 as uuidv4 } from 'uuid'
import type { Queryable } from '@opengraphity/neo4j'
import {
  seedWorkflowForTenant,
  seedProblemWorkflowForTenant,
  seedKBWorkflowForTenant,
  seedWorkflowDefinition,
} from '@opengraphity/workflow'
import { CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW } from '../scripts/lib/workflowDefinitions.js'
import { seedNotificationRules } from './seedNotificationRules.js'
import { seedDomainMatrices } from './domainMatrixSeed.js'
import type { DomainMatrixKind } from './domainMatrix.js'

/** I tipi di entità che devono avere una definizione di workflow attiva. */
export const REQUIRED_WORKFLOW_ENTITY_TYPES = ['incident', 'problem', 'kb_article', 'change', 'service_request'] as const

export interface TenantProvisioningResult {
  /** `true` se la dashboard predefinita è stata creata adesso. */
  dashboardCreated: boolean
  /** Quante regole di notifica sono nate adesso. */
  notificationRulesCreated: number
  /** Le matrici di dominio create adesso (le altre c'erano già). */
  matricesCreated: DomainMatrixKind[]
  /**
   * Una riga per definizione di workflow. `created` è `null` per i seeder che
   * non lo dicono (tornano solo l'id): quello che conta è che dopo la chiamata
   * la definizione **c'è**, e che una esistente non è stata toccata.
   */
  workflows: Array<{ name: string; created: boolean | null }>
}

/**
 * La dashboard predefinita del tenant. `userId` è l'admin appena creato
 * dall'onboarding; da una migrazione non c'è nessuno a cui intestarla e resta
 * `null` — la dashboard è comunque del tenant (`visibility: 'private'` è il
 * default storico e non lo si cambia qui).
 */
async function provisionDefaultDashboard(session: Queryable, tenantId: string, userId: string | null): Promise<boolean> {
  const r = await session.run(
    `MERGE (d:DashboardConfig {tenant_id: $tenantId, name: 'Dashboard', is_default: true})
     ON CREATE SET
       d.id         = $id,
       d.user_id    = $userId,
       d.visibility = 'private',
       d.created_at = $now,
       d.updated_at = $now
     RETURN (d.created_at = $now) AS wasCreated`,
    { tenantId, id: uuidv4(), userId, now: new Date().toISOString() },
  )
  return (r.records[0]?.get('wasCreated') as boolean | undefined) ?? false
}

/**
 * Porta il tenant allo stato «usabile»: dashboard, regole di notifica, matrici
 * di dominio e le definizioni di workflow di ogni tipo di ticket.
 *
 * I seeder dei workflow aprono sessioni proprie (vivono in
 * `@opengraphity/workflow`), quindi `session` serve solo alle scritture di qui;
 * una transazione gestita va bene come una sessione.
 */
export async function provisionTenantData(
  session: Queryable,
  tenantId: string,
  opts: { userId?: string | null } = {},
): Promise<TenantProvisioningResult> {
  const dashboardCreated = await provisionDefaultDashboard(session, tenantId, opts.userId ?? null)
  const rules = await seedNotificationRules(tenantId, session)
  const matricesCreated = await seedDomainMatrices(session, tenantId)

  // Ogni tipo di ticket vuole la sua definizione PRIMA del primo create*:
  // `createInstance` fallisce a voce alta senza (packages/workflow/engine.ts).
  // Una definizione che esiste già viene SALTATA, non riallineata al seme.
  const workflows: Array<{ name: string; created: boolean | null }> = []
  await seedWorkflowForTenant(tenantId)
  workflows.push({ name: 'Incident (base + security)', created: null })
  await seedProblemWorkflowForTenant(tenantId)
  workflows.push({ name: 'Problem', created: null })
  await seedKBWorkflowForTenant(tenantId)
  workflows.push({ name: 'KB Article', created: null })
  for (const def of [CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW]) {
    const res = await seedWorkflowDefinition(tenantId, def)
    workflows.push({ name: def.name, created: res.created })
  }

  return {
    dashboardCreated,
    notificationRulesCreated: rules.created,
    matricesCreated,
    workflows,
  }
}

/**
 * Cosa manca a un tenant per essere usabile. Serve a `migrate --status`, che
 * elenca i tenant incompleti: `c-two` era incompleto da giorni e nessuno lo
 * sapeva, perché il sintomo arriva al primo `createIncident`.
 */
export async function tenantProvisioningGaps(session: Queryable, tenantId: string): Promise<string[]> {
  const gaps: string[] = []
  const r = await session.run(
    `OPTIONAL MATCH (d:DashboardConfig {tenant_id: $tenantId})
     WITH count(d) AS dashboards
     OPTIONAL MATCH (n:NotificationRule {tenant_id: $tenantId})
     WITH dashboards, count(n) AS rules
     OPTIONAL MATCH (m:DomainMatrix {tenant_id: $tenantId})
     WITH dashboards, rules, count(m) AS matrices
     OPTIONAL MATCH (aq:AssessmentQuestion {tenant_id: $tenantId})
     WITH dashboards, rules, matrices, count(aq) AS questions
     OPTIONAL MATCH (tm:Team {tenant_id: $tenantId})
     WITH dashboards, rules, matrices, questions,
          count(tm) AS teams,
          count(CASE WHEN tm.is_change_manager = true THEN 1 END) AS changeManagers
     OPTIONAL MATCH (w:WorkflowDefinition {tenant_id: $tenantId})
     WHERE w.active = true
     RETURN dashboards, rules, matrices, questions, teams, changeManagers,
            collect(DISTINCT w.entity_type) AS entityTypes`,
    { tenantId },
  )
  const row = r.records[0]
  if (!row) return ['nessuna riga: il tenant non esiste']
  const num = (key: string): number => Number(row.get(key) ?? 0)
  const entityTypes = ((row.get('entityTypes') as Array<string | null>) ?? []).filter((t): t is string => typeof t === 'string')
  if (num('dashboards') === 0) gaps.push('nessuna dashboard')
  if (num('rules') === 0) gaps.push('nessuna regola di notifica')
  if (num('matrices') === 0) gaps.push('nessuna matrice di dominio')
  const missing = REQUIRED_WORKFLOW_ENTITY_TYPES.filter((t) => !entityTypes.includes(t))
  if (missing.length > 0) gaps.push(`nessun workflow attivo per: ${missing.join(', ')}`)

  // ── I TEAM (terza revisione, trovato provando un tenant appena creato) ─────
  //
  // Questo controllo non c'era, e senza team un tenant e INUSABILE mentre il
  // prodotto dichiarava «nessun buco». Provato dal vivo su un tenant creato
  // cinque minuti prima:
  //   - `createChange` rifiuta: «CI <nome> manca di Owner Group o Support
  //     Group» — e i gruppi sono team, quindi NESSUNA change si crea;
  //   - il dialogo «Assegna» di un incident apre una tendina col solo
  //     segnaposto, senza dire perche;
  //   - e senza un team designato Change Manager nessuna change entra in
  //     approvazione (`approvalCreation` e fail-loud su quello).
  //
  // `provisionTenantData` NON li crea: un team contiene persone vere, e
  // inventarne uno sarebbe un dato finto in mezzo ai dati del cliente. Qui si
  // DICHIARA il buco, che e il mestiere di questa funzione.
  // Le DOMANDE DI ASSESSMENT (terza revisione, provato dal vivo). Senza di
  // esse `completeAssessmentTask` rifiuta — «Nessuna domanda di assessment
  // assegnata al tipo di CI per la categoria richiesta» — e NESSUNA change
  // supera l'assessment: resta lì per sempre. Il pulsante del task dice
  // «Completa (0/0)», quindi invita a premerlo e non riesce mai.
  //
  // `provisionTenantData` non le semina: l'insieme di fabbrica vive dentro
  // `scripts/seed-assessment-questions.ts` e non in un modulo riusabile.
  // Estrarlo e la correzione migliore; finche non c'e, almeno il prodotto lo
  // DICE, e la pagina «Domande Assessment» permette di crearle a mano.
  if (num('questions') === 0) {
    gaps.push('nessuna domanda di assessment: nessuna change potrebbe superare la fase di assessment (Domande Assessment)')
  }
  if (num('teams') === 0) {
    gaps.push('nessun team: senza team i CI non hanno Owner/Support Group e nessuna change si crea (Team e Utenti)')
  } else if (num('changeManagers') === 0) {
    gaps.push('nessun team designato Change Manager: le change normal ed emergency non possono entrare in approvazione (Team e Utenti)')
  }
  return gaps
}
