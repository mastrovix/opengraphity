/**
 * Seed field visibility and requirement rules for a tenant (idempotent MERGE).
 *
 * Usage:
 *   pnpm --filter @opengraphity/api seed:field-rules -- --tenant=<slug>
 *
 * The tenant is mandatory (no default, no slug lookup): Tenant.id = slug.
 *
 * ## Fail-loud sui campi e sui passi (D-11)
 * Questo seed scriveva regole **senza verificare niente**: né che il campo
 * esistesse nel metamodello del cliente, né che il passo del workflow si
 * chiamasse davvero così. Il risultato era una regola nel pannello,
 * apparentemente attiva, che non si applicava a niente — e nessun modo di
 * accorgersene. Dal vivo: nessun tipo ITIL ha `device_model`, `assigned_to`,
 * `resolution_notes` o `risk_assessment` come `CIFieldDefinition`.
 *
 * Ora ogni regola è verificata prima di essere scritta, e una regola che non
 * potrebbe funzionare **ferma lo script** elencando i campi e i passi veri di
 * quel cliente. Due precisazioni che vengono dalla verifica del punto:
 *
 * - i campi **iniettati** non stanno nel metamodello e funzionano comunque:
 *   `workflowMutations.ts` riempie `assigned_to`/`assigned_team` dalle
 *   relazioni `ASSIGNED_TO` e mappa `notes` su `resolution_notes`/`root_cause`
 *   prima di chiamare `validateRequiredFields`. Sono dichiarati qui, uno per
 *   uno, con la loro provenienza: non sono un'eccezione muta;
 * - il passo si valida con lo stesso `getWorkflowSteps` che usa
 *   `setFieldRequirement` da interfaccia, quindi seed e UI applicano la stessa
 *   regola. Resta vero — e resta aperto — che `FieldRequirementRule` cita il
 *   passo per NOME: una rinomina dal disegnatore spegne la regola in silenzio.
 */

import { v4 as uuidv4 } from 'uuid'
import type { Session } from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'
import { getWorkflowSteps } from '../lib/workflowHelpers.js'
import { resolveTenantArg } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'

interface VisibilityRule {
  entityType:   string
  triggerField: string
  triggerValue: string
  targetField:  string
  action:       'show' | 'hide'
}

interface RequirementRule {
  entityType:   string
  fieldName:    string
  required:     boolean
  workflowStep: string | null
  /**
   * Da dove viene il valore, quando il campo NON è nel metamodello: il
   * validatore lo riceve iniettato dalla transizione. Assente = il campo deve
   * esistere nel metamodello del cliente.
   */
  injectedBy?:  string
}

/**
 * Nessuna regola di visibilità nel seme (D-11). Ce n'era una — «categoria
 * hardware → mostra `device_model`» — e `device_model` non esiste in nessun
 * tipo ITIL spedito col prodotto: era inerte dal primo giorno. Una regola di
 * visibilità ha senso sui campi che il CLIENTE aggiunge, e la si scrive dal
 * pannello Regole sui campi quando quel campo c'è; metterla nel seme voleva
 * dire spedire a tutti una regola che a nessuno serve.
 */
export const VISIBILITY_RULES: VisibilityRule[] = []

export const REQUIREMENT_RULES: RequirementRule[] = [
  // Entrando in `in_progress` il ticket deve avere un assegnatario. Il valore
  // non è un campo del metamodello: lo inietta la transizione dalla relazione
  // ASSIGNED_TO (workflowMutations.ts).
  { entityType: 'incident', fieldName: 'assigned_to',      required: true, workflowStep: 'in_progress', injectedBy: 'workflowMutations.ts, dalla relazione ASSIGNED_TO' },
  // Entrando in `resolved` servono le note di risoluzione: la transizione mappa
  // il suo `notes` su `resolution_notes` (e su `root_cause`).
  { entityType: 'incident', fieldName: 'resolution_notes', required: true, workflowStep: 'resolved',    injectedBy: 'workflowMutations.ts, dal parametro `notes` della transizione' },
  // La regola che c'era per le change (`risk_assessment`@`assessment`) è stata
  // TOLTA: `risk_assessment` non è un campo del metamodello (la change ha
  // `risk`) e nessuno lo inietta — `executeChangeTransition` non chiama
  // `validateRequiredFields` affatto, quindi la regola non è mai scattata. Se e
  // quando le change passeranno dal validatore, la regola si scrive allora, sul
  // campo che esiste.
]

async function seedVisibilityRule(tenantId: string, rule: VisibilityRule): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const existing = await session.executeRead((tx) =>
      tx.run(`
        MATCH (r:FieldVisibilityRule {
          tenant_id:     $tenantId,
          entity_type:   $entityType,
          trigger_field: $triggerField,
          trigger_value: $triggerValue,
          target_field:  $targetField
        }) RETURN r.id AS id LIMIT 1
      `, { tenantId, ...rule }),
    )
    if (existing.records.length > 0) {
      process.stdout.write(`  ↩ VisibilityRule ${rule.entityType}:${rule.triggerField}=${rule.triggerValue}→${rule.action} ${rule.targetField} — già esistente\n`)
      return
    }
    const id  = uuidv4()
    const now = new Date().toISOString()
    await session.executeWrite((tx) =>
      tx.run(`
        CREATE (:FieldVisibilityRule {
          id:            $id,
          tenant_id:     $tenantId,
          entity_type:   $entityType,
          trigger_field: $triggerField,
          trigger_value: $triggerValue,
          target_field:  $targetField,
          action:        $action,
          created_at:    $now,
          updated_at:    $now
        })
      `, { id, tenantId, now, ...rule }),
    )
    process.stdout.write(`  ✓ VisibilityRule ${rule.entityType}:${rule.triggerField}=${rule.triggerValue}→${rule.action} ${rule.targetField}\n`)
  } finally {
    await session.close()
  }
}

async function seedRequirementRule(tenantId: string, rule: RequirementRule): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const existing = await session.executeRead((tx) =>
      tx.run(`
        MATCH (r:FieldRequirementRule {
          tenant_id:     $tenantId,
          entity_type:   $entityType,
          field_name:    $fieldName,
          workflow_step: $workflowStep
        }) RETURN r.id AS id LIMIT 1
      `, { tenantId, entityType: rule.entityType, fieldName: rule.fieldName, workflowStep: rule.workflowStep }),
    )
    if (existing.records.length > 0) {
      process.stdout.write(`  ↩ RequirementRule ${rule.entityType}:${rule.fieldName}@${rule.workflowStep ?? 'all'} — già esistente\n`)
      return
    }
    const id  = uuidv4()
    const now = new Date().toISOString()
    await session.executeWrite((tx) =>
      tx.run(`
        CREATE (:FieldRequirementRule {
          id:            $id,
          tenant_id:     $tenantId,
          entity_type:   $entityType,
          field_name:    $fieldName,
          required:      $required,
          workflow_step: $workflowStep,
          created_at:    $now,
          updated_at:    $now
        })
      `, { id, tenantId, now, ...rule }),
    )
    process.stdout.write(`  ✓ RequirementRule ${rule.entityType}:${rule.fieldName}@${rule.workflowStep ?? 'all'} required=${rule.required}\n`)
  } finally {
    await session.close()
  }
}

/**
 * I nomi di campo che esistono per quel tipo di entità in QUESTO cliente:
 * i campi del tipo ITIL (suoi e spediti). Il tipo ITIL si chiama come
 * l'`entityType` (`incident`, `change`, `problem`, `service_request`).
 */
async function metamodelFieldNames(session: Session, tenantId: string, entityType: string): Promise<string[]> {
  const r = await session.executeRead((tx) =>
    tx.run(`
      MATCH (t:CITypeDefinition {name: $entityType})
      WHERE t.tenant_id IN [$tenantId, 'system']
      OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
      WHERE f.tenant_id IN [$tenantId, 'system']
      RETURN collect(DISTINCT f.name) AS names
    `, { tenantId, entityType }),
  )
  return ((r.records[0]?.get('names') as Array<string | null> | undefined) ?? [])
    .filter((n): n is string => typeof n === 'string')
}

/** Fermarsi dicendo perché, con i valori veri di questo cliente sotto gli occhi. */
function refuse(what: string, reason: string, available: string[]): never {
  throw new Error(
    `${what}: ${reason}\n` +
    `  Disponibili per questo cliente: ${available.length > 0 ? available.join(', ') : '(nessuno)'}\n` +
    `  Una regola su un valore che non esiste resterebbe nel pannello senza applicarsi a niente: meglio fermarsi qui.`,
  )
}

/**
 * Verifica TUTTE le regole prima di scriverne una (D-11): un seed che si ferma
 * a metà lascia il cliente in uno stato che nessuno ha scelto.
 */
export async function assertRulesApplicable(tenantId: string): Promise<void> {
  const session = getSession(undefined, 'READ')
  try {
    const fieldsByEntity = new Map<string, string[]>()
    const stepsByEntity  = new Map<string, string[]>()
    const fieldsOf = async (entityType: string): Promise<string[]> => {
      if (!fieldsByEntity.has(entityType)) fieldsByEntity.set(entityType, await metamodelFieldNames(session, tenantId, entityType))
      return fieldsByEntity.get(entityType)!
    }
    const stepsOf = async (entityType: string): Promise<string[]> => {
      if (!stepsByEntity.has(entityType)) stepsByEntity.set(entityType, (await getWorkflowSteps(session, tenantId, entityType)).map((s) => s.name))
      return stepsByEntity.get(entityType)!
    }

    for (const rule of VISIBILITY_RULES) {
      const fields = await fieldsOf(rule.entityType)
      for (const [label, name] of [['campo scatenante', rule.triggerField], ['campo bersaglio', rule.targetField]] as const) {
        if (!fields.includes(name)) {
          refuse(`VisibilityRule ${rule.entityType}:${rule.targetField}`, `il ${label} "${name}" non esiste nel metamodello di "${rule.entityType}"`, fields)
        }
      }
    }

    for (const rule of REQUIREMENT_RULES) {
      const fields = await fieldsOf(rule.entityType)
      if (!fields.includes(rule.fieldName) && !rule.injectedBy) {
        refuse(`RequirementRule ${rule.entityType}:${rule.fieldName}`, `il campo "${rule.fieldName}" non esiste nel metamodello di "${rule.entityType}" e nessuno lo inietta`, fields)
      }
      if (rule.injectedBy && !fields.includes(rule.fieldName)) {
        process.stdout.write(`  ℹ ${rule.entityType}:${rule.fieldName} non è un campo del metamodello: il valore arriva da ${rule.injectedBy}\n`)
      }
      if (rule.workflowStep != null) {
        const steps = await stepsOf(rule.entityType)
        if (!steps.includes(rule.workflowStep)) {
          refuse(`RequirementRule ${rule.entityType}:${rule.fieldName}@${rule.workflowStep}`, `il workflow di "${rule.entityType}" non ha un passo chiamato "${rule.workflowStep}"`, steps)
        }
      }
    }
  } finally {
    await session.close()
  }
}

async function main() {
  const tenantId = resolveTenantArg()
  process.stdout.write(`Seeding field rules for tenant ${tenantId}…\n\n`)

  // Prima si verifica tutto, poi si scrive (D-11).
  await assertRulesApplicable(tenantId)

  for (const rule of VISIBILITY_RULES) {
    await seedVisibilityRule(tenantId, rule)
  }
  for (const rule of REQUIREMENT_RULES) {
    await seedRequirementRule(tenantId, rule)
  }

  process.stdout.write('\nDone.\n')
}

runScript('seed-field-rules', main)
