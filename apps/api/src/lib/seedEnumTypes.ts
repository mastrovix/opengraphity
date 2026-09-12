/**
 * I vocabolari SPEDITI col prodotto.
 *
 * Stanno su `tenant_id = 'system'`, come i tipi e i campi spediti (A-2 / C-6):
 * un campo condiviso è UN nodo per tutti i clienti, quindi il suo `USES_ENUM`
 * non può puntare al vocabolario di un cliente. Prima di questa ondata il seed
 * ne scriveva una COPIA per ogni tenant (`MERGE (e {name, tenant_id:
 * $tenantId})` con `is_system = true`), e l'onboarding la creava a ogni nuovo
 * cliente: dal vivo i 30 campi condivisi risultavano agganciati alle copie di
 * `c-one`, e ogni altro cliente vedeva e assegnava i valori di c-one.
 *
 * Adesso: il seme è uno e vive su `system`; le copie per tenant sono le
 * PERSONALIZZAZIONI e nascono solo quando il cliente personalizza
 * (`customizeEnumType`). Una copia con lo stesso nome vince in lettura per chi
 * la possiede, e solo per lui (`lib/enumScope.ts`).
 */
import type { Session } from 'neo4j-driver'
import { v4 as uuidv4 } from 'uuid'
import { CI_LIFECYCLE_STATUSES } from './eventVocabularies.js'
import { SYSTEM_TENANT } from './enumScope.js'

interface SystemEnum {
  name:   string
  label:  string
  values: string[]
  scope:  'itil' | 'cmdb' | 'shared'
}

export const SYSTEM_ENUMS: readonly SystemEnum[] = [
  { name: 'priority',                label: 'Priority',               values: ['low', 'medium', 'high', 'critical'],              scope: 'shared' },
  { name: 'severity',                label: 'Severity',               values: ['low', 'medium', 'high', 'critical'],              scope: 'shared' },
  { name: 'environment',             label: 'Environment',            values: ['production', 'staging', 'development', 'testing', 'dr'], scope: 'shared' },
  { name: 'risk',                    label: 'Risk',                   values: ['low', 'medium', 'high'],                          scope: 'shared' },
  { name: 'impact',                  label: 'Impact',                 values: ['low', 'medium', 'high'],                          scope: 'shared' },
  { name: 'category',                label: 'Category',               values: ['hardware', 'software', 'network', 'access', 'security', 'other'], scope: 'shared' },
  // Ciclo di vita del CI: la lista sta in lib/eventVocabularies.ts (fonte unica
  // con la policy `ignore_lifecycle_statuses` e con i Servizi monitorati).
  { name: 'ci_status',               label: 'CI Status',              values: [...CI_LIFECYCLE_STATUSES],                         scope: 'cmdb' },
  { name: 'status_incident',         label: 'Incident Status',        values: ['new', 'open', 'assigned', 'in_progress', 'pending', 'escalated', 'resolved', 'closed'], scope: 'itil' },
  { name: 'status_change',           label: 'Change Status',          values: ['draft', 'assessment', 'cab_approval', 'emergency_approval', 'scheduled', 'deployment', 'validation', 'post_review', 'completed', 'approved', 'failed', 'rejected', 'cancelled'], scope: 'itil' },
  { name: 'status_problem',          label: 'Problem Status',         values: ['new', 'under_investigation', 'change_requested', 'change_in_progress', 'resolved', 'closed', 'rejected', 'deferred'], scope: 'itil' },
  { name: 'status_service_request',  label: 'Service Request Status', values: ['open', 'in_progress', 'completed', 'cancelled'],  scope: 'itil' },
  { name: 'change_type',             label: 'Change Type',            values: ['standard', 'normal', 'emergency'],                scope: 'itil' },
  // Vocabolari dei campi enum del metamodello CMDB spedito
  // (`scripts/seed-metamodel.ts`: server.os, database.instanceType,
  // database_instance.instanceType, certificate.certificateType). Erano già
  // agganciati dal vivo — ma alle copie di c-one, nate da
  // `migrate-enum-references.ts`: senza il nodo di sistema la migrazione A1-1
  // non avrebbe dove ri-agganciarli.
  { name: 'os',                      label: 'OS',                     values: ['Windows', 'Linux'],                               scope: 'cmdb' },
  { name: 'instance_type',           label: 'Instance Type',          values: ['PostgreSQL', 'Oracle', 'SQL Server'],             scope: 'cmdb' },
  { name: 'certificate_type',        label: 'Certificate Type',       values: ['public', 'external'],                             scope: 'cmdb' },
]

/**
 * Semina i vocabolari spediti su `tenant_id = 'system'`. Idempotente, e NON
 * per tenant: non prende uno slug perché non ne crea più copie.
 */
export async function seedSystemEnumTypes(session: Session): Promise<void> {
  const now = new Date().toISOString()
  for (const e of SYSTEM_ENUMS) {
    await session.executeWrite((tx) =>
      tx.run(`
        MERGE (e:EnumTypeDefinition {name: $name, tenant_id: $tenantId})
        ON CREATE SET
          e.id         = $id,
          e.label      = $label,
          e.values     = $values,
          e.is_system  = true,
          e.scope      = $scope,
          e.created_at = $now,
          e.updated_at = $now
        ON MATCH SET
          e.values     = $values,
          e.updated_at = $now
      `, {
        name:     e.name,
        tenantId: SYSTEM_TENANT,
        id:       uuidv4(),
        label:    e.label,
        values:   e.values,
        scope:    e.scope,
        now,
      }),
    )
  }
}
