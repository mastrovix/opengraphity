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
import { USER_ROLES } from '@opengraphity/types'
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
import { seedFactoryRoles } from './roles.js'
import { seedPortalSeverityOptions } from './portalSeverityOptions.js'
import { seedDefaultLanguage } from './tenantLanguage.js'
import { seedStartingChains } from './cmdbStartingChains.js'
import { ensureOpenGrafoSystemCI, openGrafoSystemCI, type OpenGrafoSystemCIResult } from './opengrafoSystemCI.js'

/** I tipi di entità che devono avere una definizione di workflow attiva. */
export const REQUIRED_WORKFLOW_ENTITY_TYPES = ['incident', 'problem', 'kb_article', 'change', 'service_request'] as const

export interface TenantProvisioningResult {
  /** I ruoli di fabbrica creati adesso (gli altri c'erano già, e non si toccano). */
  rolesCreated: string[]
  /** `true` se la dashboard predefinita è stata creata adesso. */
  dashboardCreated: boolean
  /** Quante regole di notifica sono nate adesso. */
  notificationRulesCreated: number
  /** Le matrici di dominio create adesso (le altre c'erano già). */
  matricesCreated: DomainMatrixKind[]
  /**
   * Le severità dichiarate ADESSO per il portale, `null` se la scelta c'era
   * già (o se manca il vocabolario). Senza questo seme un tenant nasceva con
   * un rilievo di gravità errore addosso e il portale non apriva ticket.
   */
  portalSeveritiesSeeded: readonly string[] | null
  /** La lingua dichiarata adesso, `null` se il cliente l'aveva già scelta. */
  defaultLanguageSeeded: string | null
  /** The starting CMDB chains written now (0 when the tenant already had its own). */
  /** The OpenGrafo CI and its team, created where missing (lib/opengrafoSystemCI.ts). */
  openGrafoCI: OpenGrafoSystemCIResult
  cmdbChainsCreated: number
  /**
   * Una riga per definizione di workflow. `created` è `null` per i seeder che
   * non lo dicono (tornano solo l'id): quello che conta è che dopo la chiamata
   * la definizione **c'è**, e che una esistente non è stata toccata.
   */
  workflows: Array<{ name: string; created: boolean | null }>
  /**
   * Quello che RESTA da configurare a una persona: team, change manager,
   * domande di assessment. Non è un errore — il provisioning non poteva
   * riempirli — ma non si tace: chi chiama lo mostra, e la diagnostica lo porta
   * nel banner dell'amministratore.
   */
  gapsLeft: ProvisioningGap[]
}

/**
 * La dashboard predefinita del tenant. `userId` è l'admin appena creato
 * dall'onboarding; da una migrazione non c'è nessuno a cui intestarla e resta
 * `null` — la dashboard è comunque del tenant (`visibility: 'private'` è il
 * default storico e non lo si cambia qui).
 */
async function provisionDefaultDashboard(session: Queryable, tenantId: string, userId: string | null): Promise<boolean> {
  /*
   * LA CHIAVE DEL MERGE NON PORTA `is_default` (revisione del 17 set 2026).
   *
   * È lo stesso schema che ha creato cinque campi duplicati nel metamodello:
   * una proprietà di STATO nella chiave di un MERGE. `is_default` lo riscrive
   * la pagina delle dashboard (impostarne un'altra come predefinita spegne
   * questa), quindi alla seconda esecuzione — e questa è una MUTATION, non una
   * migrazione a colpo singolo — l'onboarding non riconosceva più la propria
   * dashboard e ne creava una seconda con lo stesso nome.
   *
   * La chiave è tenant + nome, che è ciò che identifica «la dashboard
   * provisionata»; `is_default` si scrive alla creazione e da lì in poi è del
   * cliente.
   */
  const r = await session.run(
    `MERGE (d:DashboardConfig {tenant_id: $tenantId, name: 'Dashboard'})
     ON CREATE SET
       d.id         = $id,
       d.user_id    = $userId,
       d.is_default = true,
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
  // Per primi i ruoli: senza, nessuna persona del tenant può eseguire niente.
  const rolesCreated = await seedFactoryRoles(session, tenantId)
  const dashboardCreated = await provisionDefaultDashboard(session, tenantId, opts.userId ?? null)
  const rules = await seedNotificationRules(tenantId, session)
  const matricesCreated = await seedDomainMatrices(session, tenantId)
  /*
   * Le severità del portale: tutte quelle del vocabolario, con le parole del
   * Dizionario. È una dichiarazione neutra, non una scelta al posto del
   * cliente — che resta liberissimo di restringerla da Organizzazione — e
   * senza di lei un tenant nuovo non poteva accettare un ticket dal portale.
   */
  const severita = await seedPortalSeverityOptions(session, tenantId)
  /*
   * La lingua: inglese, cioè quella che il prodotto mostra già a chi non ha
   * scelto. Scriverla non cambia niente a schermo — cambia che è una scelta e
   * non un ripiego, e che la pagina Organizzazione la mostra come tale.
   */
  const lingua = await seedDefaultLanguage(session, tenantId)
  // The CMDB chains (24 Sep 2026): without one, every relation between CIs is refused.
  const cmdbChainsCreated = await seedStartingChains(session, tenantId)
  // OpenGrafo as a CI of the tenant, owned by its administrators (26 Sep 2026): the remedies' problems land there.
  const openGrafoCI = await ensureOpenGrafoSystemCI(session, tenantId)

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

  /**
   * ALLA FINE si CONTROLLA che il tenant sia davvero completo (revisione
   * totale · C-21).
   *
   * Il provisioning non è atomico e non può esserlo com'è scritto: i seeder
   * dei workflow aprono sessioni proprie, quindi dentro la transazione di una
   * migrazione un'interruzione a metà lasciava il tenant con ruoli, dashboard
   * e regole ma senza workflow — e nessuno lo diceva: la migrazione risultava
   * non applicata, mentre `createIncident` cominciava a fallire. Non lo
   * rendiamo atomico (sarebbe un rifacimento dei seeder), lo rendiamo
   * VISIBILE: se manca qualcosa il chiamante lo sa subito, con la lista, e
   * rilanciare completa (il provisioning è idempotente).
   */
  /*
   * MA SI FALLISCE SOLO PER I BUCHI CHE IL PROVISIONING POTEVA CHIUDERE
   * (17 set 2026).
   *
   * Prima si lanciava per QUALUNQUE buco, e fra quelli ce ne sono tre che il
   * prodotto non può riempire da sé: i TEAM (sono persone, nessuno le può
   * inventare), il CHANGE MANAGER (è un team) e le DOMANDE di assessment (sono
   * la configurazione del cliente, non un dato di fabbrica). Risultato: ogni
   * tenant nuovo finiva con «provisioned only in part … run it again», e
   * rilanciare non cambiava niente — visto dal vivo creando `prova-cons`, con
   * l'onboarding che aveva fatto tutto e si dichiarava fallito.
   *
   * Un errore che compare sempre e non si può risolvere non è un errore: è
   * rumore che insegna a ignorare gli errori veri. Quei tre tornano nel
   * risultato come `gapsLeft`, e la diagnostica li mostra già all'admin col
   * banner (`configurationIssues`, voce `provisioning_gap`), che è il posto
   * dove una persona può rimediare.
   */
  const gaps = await tenantProvisioningGaps(session, tenantId)
  const miei = gaps.filter((g) => !GAP_DA_PERSONA.includes(g.kind))
  if (miei.length > 0) {
    throw new Error(
      `Tenant ${tenantId} provisioned only in part: ${miei.map((g) => formatGap(g)).join('; ')}. `
      + 'The provisioning is idempotent: run it again to complete it.',
    )
  }

  return {
    rolesCreated,
    dashboardCreated,
    notificationRulesCreated: rules.created,
    matricesCreated,
    portalSeveritiesSeeded: severita.seeded,
    defaultLanguageSeeded: lingua.seeded,
    cmdbChainsCreated,
    openGrafoCI,
    workflows,
    gapsLeft: gaps.filter((g) => GAP_DA_PERSONA.includes(g.kind)),
  }
}

/**
 * I buchi che NESSUN provisioning può chiudere: li riempie una persona dalle
 * pagine del prodotto. Elencarli qui è la differenza fra «qualcosa è andato
 * storto» e «resta da configurare».
 */
const GAP_DA_PERSONA: readonly ProvisioningGap['kind'][] = [
  'no_teams',
  'no_change_manager',
  'no_assessment_questions',
  // The OpenGrafo CI's team is people: if it has none, a person adds them (26 Sep 2026).
  'opengrafo_ci_nobody',
]

/**
 * UN BUCO, come DATO e non come frase.
 *
 * Prima questa funzione restituiva prosa italiana, e la consumavano tre posti:
 * `migrate --status` (una CLI), la pagina del disegnatore e il banner della
 * diagnostica — le ultime due in un'interfaccia che può essere in inglese, dove
 * quelle frasi restavano italiane. Ora i FATTI stanno qui e la resa sta dove
 * c'è una lingua: `formatGap` per la CLI e i log, `t('configurationIssues.gap.<kind>')`
 * per il client, che è l'unico a sapere in che lingua sta guardando qualcuno.
 */
export interface ProvisioningGap {
  kind:
    | 'tenant_missing' | 'no_roles' | 'no_dashboard' | 'no_notification_rules' | 'no_domain_matrices'
    | 'no_workflows' | 'no_assessment_questions' | 'no_teams' | 'no_change_manager'
    | 'no_opengrafo_ci' | 'opengrafo_ci_nobody'
  /** Solo dati per l'interpolazione: mai prosa. */
  params?: Record<string, string>
}

/**
 * La resa di un buco per la CLI e per i log, che non hanno un i18n e non ne
 * vogliono uno: una lingua sola, e quella lingua è l'INGLESE, che è la lingua
 * del prodotto (13 set 2026). Il client non passa da qui — ha le sue chiavi in
 * `configurationIssues.gap.*`, e le risolve nella lingua di chi guarda.
 */
export function formatGap(g: ProvisioningGap): string {
  switch (g.kind) {
    case 'tenant_missing':          return 'no row: the tenant does not exist'
    case 'no_roles':                return `missing roles: ${g.params?.['roles'] ?? ''} (the people with these roles cannot do anything)`
    case 'no_dashboard':            return 'no dashboard'
    case 'no_notification_rules':   return 'no notification rules'
    case 'no_domain_matrices':      return 'no domain matrices'
    case 'no_workflows':            return `no active workflow for: ${g.params?.['entityTypes'] ?? ''}`
    case 'no_assessment_questions': return 'no assessment questions: no change could ever get past the assessment stage (Assessment Questions)'
    case 'no_teams':                return 'no teams: without teams CIs have no Owner/Support Group and no change can be created (Organization & access → Teams)'
    case 'no_change_manager':       return 'no team designated Change Manager: normal and emergency changes cannot enter approval (Organization & access → Teams)'
    case 'no_opengrafo_ci':         return 'no OpenGrafo CI: the problems of the operational remedies have no CI to be opened on'
    case 'opengrafo_ci_nobody':     return 'the OpenGrafo CI has no Owner Group with members: the problems of the operational remedies reach no one (CMDB → OpenGrafo)'
  }
}

/**
 * Cosa manca a un tenant per essere usabile. Serve a `migrate --status`, che
 * elenca i tenant incompleti: `c-two` era incompleto da giorni e nessuno lo
 * sapeva, perché il sintomo arriva al primo `createIncident`.
 */
export async function tenantProvisioningGaps(session: Queryable, tenantId: string): Promise<ProvisioningGap[]> {
  const gaps: ProvisioningGap[] = []
  const r = await session.run(
    `OPTIONAL MATCH (ro:Role {tenant_id: $tenantId})
     WITH collect(ro.key) AS roleKeys
     OPTIONAL MATCH (u:User {tenant_id: $tenantId})
     WITH roleKeys, collect(DISTINCT u.role) AS userRoles
     OPTIONAL MATCH (d:DashboardConfig {tenant_id: $tenantId})
     WITH roleKeys, userRoles, count(d) AS dashboards
     OPTIONAL MATCH (n:NotificationRule {tenant_id: $tenantId})
     WITH roleKeys, userRoles, dashboards, count(n) AS rules
     OPTIONAL MATCH (m:DomainMatrix {tenant_id: $tenantId})
     WITH roleKeys, userRoles, dashboards, rules, count(m) AS matrices
     OPTIONAL MATCH (aq:AssessmentQuestion {tenant_id: $tenantId})
     WITH roleKeys, userRoles, dashboards, rules, matrices, count(aq) AS questions
     OPTIONAL MATCH (tm:Team {tenant_id: $tenantId})
     // The system team (OpenGrafo Administrators) is not the tenant's teams: with it alone no change can be made.
     WITH roleKeys, userRoles, dashboards, rules, matrices, questions,
          count(CASE WHEN coalesce(tm.is_system, false) = false THEN 1 END) AS teams,
          count(CASE WHEN tm.is_change_manager = true THEN 1 END) AS changeManagers
     OPTIONAL MATCH (w:WorkflowDefinition {tenant_id: $tenantId})
     WHERE w.active = true
     RETURN roleKeys, userRoles, dashboards, rules, matrices, questions, teams, changeManagers,
            collect(DISTINCT w.entity_type) AS entityTypes`,
    { tenantId },
  )
  const row = r.records[0]
  if (!row) return [{ kind: 'tenant_missing' }]
  const num = (key: string): number => Number(row.get(key) ?? 0)
  const entityTypes = ((row.get('entityTypes') as Array<string | null>) ?? []).filter((t): t is string => typeof t === 'string')
  // I ruoli (ondata 7): quelli di fabbrica e quelli che le persone portano.
  const roleKeys = new Set(((row.get('roleKeys') as unknown[]) ?? []).map(String))
  const userRoles = ((row.get('userRoles') as unknown[]) ?? []).filter((r): r is string => typeof r === 'string')
  const missingRoles = [...new Set([...USER_ROLES, ...userRoles])].filter((k) => !roleKeys.has(k))
  if (missingRoles.length) gaps.push({ kind: 'no_roles', params: { roles: missingRoles.join(', ') } })
  if (num('dashboards') === 0) gaps.push({ kind: 'no_dashboard' })
  if (num('rules') === 0) gaps.push({ kind: 'no_notification_rules' })
  if (num('matrices') === 0) gaps.push({ kind: 'no_domain_matrices' })
  const missing = REQUIRED_WORKFLOW_ENTITY_TYPES.filter((t) => !entityTypes.includes(t))
  if (missing.length > 0) gaps.push({ kind: 'no_workflows', params: { entityTypes: missing.join(', ') } })

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
    gaps.push({ kind: 'no_assessment_questions' })
  }
  if (num('teams') === 0) {
    gaps.push({ kind: 'no_teams' })
  } else if (num('changeManagers') === 0) {
    gaps.push({ kind: 'no_change_manager' })
  }
  // The OpenGrafo CI and who answers for it (26 Sep 2026, lib/opengrafoSystemCI.ts).
  const sistema = await openGrafoSystemCI(session, tenantId)
  if (!sistema) gaps.push({ kind: 'no_opengrafo_ci' })
  else if (sistema.ownerMembers === 0) gaps.push({ kind: 'opengrafo_ci_nobody' })
  return gaps
}
