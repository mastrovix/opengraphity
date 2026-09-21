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
import type { Queryable } from '@opengraphity/neo4j'
import type { ValueColor } from '@opengraphity/types'
import { v4 as uuidv4 } from 'uuid'
import { CI_LIFECYCLE_STATUSES, EVENT_SEVERITIES } from './eventVocabularies.js'
import { SERVICE_CRITICALITIES } from './serviceVocabularies.js'
import { IMPORT_SEVERITY_VALUES } from './domainMatrixSeed.js'
import { SYSTEM_TENANT } from './enumScope.js'

interface SystemEnum {
  name:   string
  label:  string
  values: string[]
  scope:  'itil' | 'cmdb' | 'shared'
  /**
   * Le etichette di fabbrica per un vocabolario NUOVO. I vocabolari che
   * esistevano prima delle etichette le hanno ricevute dalle migrazioni
   * 20260920_17xx; qui stanno quelle dei vocabolari nati dopo.
   */
  valueLabels?: Readonly<Record<string, { it: string; en: string }>>
  /**
   * I colori di fabbrica (revisione del 14 set 2026 · F9): i colori che il web
   * aveva nelle sue tabelle per valore, ora dato del Dizionario.
   */
  valueColors?: Readonly<Record<string, ValueColor>>
}

/** Priorità e severità hanno la stessa scala, e quindi gli stessi colori. */
const PRIORITY_COLORS: Readonly<Record<string, ValueColor>> = { critical: 'danger', high: 'orange', medium: 'warning', low: 'success' }
/** I colori che il badge del rischio aveva nel web (verde, giallo, rosso) prima di leggere il Dizionario. */
const RISK_BAND_COLORS: Readonly<Record<string, ValueColor>> = { low: 'success', medium: 'warning', high: 'danger' }

export const SYSTEM_ENUMS: readonly SystemEnum[] = [
  { name: 'priority',                label: 'Priority',               values: ['low', 'medium', 'high', 'critical'],              scope: 'shared', valueColors: PRIORITY_COLORS },
  { name: 'severity',                label: 'Severity',               values: ['low', 'medium', 'high', 'critical'],              scope: 'shared', valueColors: PRIORITY_COLORS },
  { name: 'environment',             label: 'Environment',            values: ['production', 'staging', 'development', 'testing', 'dr'], scope: 'shared' },
  { name: 'risk',                    label: 'Risk',                   values: ['low', 'medium', 'high'],                          scope: 'shared' },
  { name: 'impact',                  label: 'Impact',                 values: ['low', 'medium', 'high'],                          scope: 'shared' },
  { name: 'category',                label: 'Category',               values: ['hardware', 'software', 'network', 'access', 'security', 'other'], scope: 'shared' },
  // Ciclo di vita del CI: la lista sta in lib/eventVocabularies.ts (fonte unica
  // con la policy `ignore_lifecycle_statuses` e con i Servizi monitorati).
  { name: 'ci_status',               label: 'CI Status',              values: [...CI_LIFECYCLE_STATUSES],                         scope: 'cmdb',
    valueColors: { active: 'success', inactive: 'danger', maintenance: 'warning', decommissioned: 'neutral' } },
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
  // ── Ondata 7: i vocabolari che le matrici di dominio presuppongono ────────
  // Erano liste nel codice, quindi il cliente non poteva rinominarli e il
  // codice ripiegava in silenzio su `medium`/`normal` quando non riconosceva
  // un valore. Ora sono vocabolari veri: `lib/domainMatrix.ts` li legge con
  // `domainVocabulary` (la copia del cliente vince), e le matrici di
  // `Impostazioni → Matrici di dominio` li usano come tendine.
  // Il perché di ciascuno è in lib/domainMatrixSeed.ts.
  { name: 'urgency',                 label: 'Urgency',                values: ['low', 'medium', 'high'],                          scope: 'shared' },
  { name: 'risk_band',               label: 'Risk Band',              values: ['low', 'medium', 'high'],                          scope: 'shared', valueColors: RISK_BAND_COLORS },
  { name: 'event_severity',          label: 'Event Severity',         values: [...EVENT_SEVERITIES],                              scope: 'shared',
    valueColors: { critical: 'danger', warning: 'warning', info: 'info' } },
  { name: 'service_criticality',     label: 'Service Criticality',    values: [...SERVICE_CRITICALITIES],                         scope: 'cmdb' },
  { name: 'import_severity',         label: 'Import Severity',        values: IMPORT_SEVERITY_VALUES,                             scope: 'shared' },
  /*
    TIPO DI TEAM. Era una lista scritta nella pagina e mai scrivibile: la
    colonna e il filtro di «Team e Utenti» offrivano `owner` e `support`
    cablati, `CreateTeamInput` non aveva il campo e `createTeam` scriveva
    `type: null` — quindi un team nuovo nasceva senza tipo e non c'era modo di
    darglielo (`type` non era nemmeno fra i campi filtrabili, quindi il filtro
    non filtrava). Ora e un vocabolario come gli altri: il cliente lo
    rinomina o ne aggiunge dei suoi dal Dizionario, e l'API rifiuta un valore
    che non c'e.
  */
  { name: 'team_type',               label: 'Team Type',              values: ['owner', 'support'],                               scope: 'shared' },
  /*
    CATEGORIE DELLA KNOWLEDGE BASE (revisione del 14 set 2026 · F5). Avevano
    tre fonti: colori e icone scritti nel web per sette categorie, la pagina
    admin che proponeva il vocabolario `category` degli incident, e la lista
    pubblica che mostrava le categorie già usate. `database` è fra i valori
    perché era la categoria più usata dal vivo e mancava dalla tabella del web.
  */
  { name: 'kb_category',             label: 'KB Category',            values: ['hardware', 'software', 'network', 'security', 'database', 'how-to', 'faq', 'general'], scope: 'itil',
    valueLabels: {
      hardware: { it: 'Hardware', en: 'Hardware' }, software: { it: 'Software', en: 'Software' },
      network:  { it: 'Rete', en: 'Network' },      security: { it: 'Sicurezza', en: 'Security' },
      database: { it: 'Database', en: 'Database' }, 'how-to': { it: 'Come fare', en: 'How-to' },
      faq:      { it: 'Domande frequenti', en: 'FAQ' }, general: { it: 'Generale', en: 'General' },
    },
    valueColors: {
      hardware: 'info', software: 'purple', network: 'info', security: 'danger',
      database: 'orange', 'how-to': 'success', faq: 'warning', general: 'neutral',
    } },
]

/**
 * Semina i vocabolari spediti su `tenant_id = 'system'`. Idempotente, e NON
 * per tenant: non prende uno slug perché non ne crea più copie.
 */
export async function seedSystemEnumTypes(session: Queryable): Promise<void> {
  const now = new Date().toISOString()
  for (const e of SYSTEM_ENUMS) {
    // `Queryable` (sessione **o** transazione) perché la chiamano sia
    // l'onboarding sia una migrazione, che riceve una transazione gestita.
    await session.run(`
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
        // I colori del vocabolario spedito sono del prodotto (nessun cliente
        // lo modifica in posto); le etichette invece si scrivono solo dove
        // mancano, perché le hanno già seminate le migrazioni delle etichette.
        SET e.value_colors = $valueColors,
            e.value_labels = coalesce(e.value_labels, $valueLabels)
      `, {
        name:     e.name,
        tenantId: SYSTEM_TENANT,
        id:       uuidv4(),
        label:    e.label,
        values:   e.values,
        scope:    e.scope,
        valueColors: e.valueColors ? JSON.stringify(e.valueColors) : null,
        valueLabels: e.valueLabels ? JSON.stringify(e.valueLabels) : null,
        now,
    })
  }
}
