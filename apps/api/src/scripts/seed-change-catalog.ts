/**
 * Seed Standard Change Catalog — categories + entries.
 * Usage: npx tsx src/scripts/seed-change-catalog.ts --tenant-id c-one
 */
import { getSession } from '@opengraphity/neo4j'
import { v4 as uuidv4 } from 'uuid'

const tenantId = (() => {
  const idx = process.argv.indexOf('--tenant-id')
  if (idx < 0 || !process.argv[idx + 1]) {
    process.stderr.write('Usage: seed-change-catalog.ts --tenant-id <id>\n')
    process.exit(1)
  }
  return process.argv[idx + 1]!
})()

// ── Categories ───────────────────────────────────────────────────────────────

interface CategorySpec {
  name:        string
  description: string
  icon:        string
  color:       string
  order:       number
}

const CATEGORIES: CategorySpec[] = [
  { name: 'Sicurezza',         description: 'Change legate alla sicurezza informatica',     icon: 'Shield',  color: '#DC2626', order: 1 },
  { name: 'Infrastruttura',    description: 'Change infrastrutturali su server e storage',  icon: 'Server',  color: '#0284C7', order: 2 },
  { name: 'Gestione Accessi',  description: 'Gestione account, permessi e accessi',         icon: 'Key',     color: '#D97706', order: 3 },
  { name: 'Applicazioni',      description: 'Deploy e aggiornamenti applicativi',           icon: 'Code',    color: '#059669', order: 4 },
  { name: 'Rete',              description: 'Modifiche a dispositivi e configurazioni rete', icon: 'Wifi',    color: '#7C3AED', order: 5 },
]

// ── Entries ──────────────────────────────────────────────────────────────────

interface EntrySpec {
  categoryName:               string
  name:                       string
  description:                string
  riskLevel:                  string
  impact:                     string
  defaultTitleTemplate:       string
  defaultDescriptionTemplate: string
  defaultPriority:            string
  ciTypes:                    string[]
  checklist:                  { title: string; description: string }[]
  estimatedDurationHours:     number
  requiresDowntime:           boolean
  rollbackProcedure:          string
  ciRequired:                 boolean
  maintenanceWindow:          string | null
  notifyTeam:                 boolean
  requireCompletionConfirm:   boolean
  workflowId:                 string | null
}

const ENTRIES: EntrySpec[] = [
  {
    categoryName: 'Sicurezza',
    name: 'Rinnovo Certificato SSL',
    description: 'Procedura standard per il rinnovo di un certificato SSL/TLS su un server o bilanciatore.',
    riskLevel: 'low',
    impact: 'low',
    defaultTitleTemplate: 'Rinnovo certificato SSL — {ci_name}',
    defaultDescriptionTemplate: 'Rinnovo del certificato SSL/TLS per {ci_name} secondo la procedura standard di catalogo.',
    defaultPriority: 'medium',
    ciTypes: ['server', 'application'],
    checklist: [
      { title: 'Generare CSR',                     description: 'Generare la Certificate Signing Request sul server target.' },
      { title: 'Richiedere certificato alla CA',    description: 'Inviare la CSR alla Certificate Authority e ottenere il certificato firmato.' },
      { title: 'Installare il certificato',         description: 'Installare il certificato e la catena intermedia sul server.' },
      { title: 'Verificare connettività HTTPS',     description: 'Validare che il sito risponda correttamente su HTTPS senza errori.' },
    ],
    estimatedDurationHours: 2,
    requiresDowntime: false,
    rollbackProcedure: 'Ripristinare il certificato precedente dal backup e riavviare il servizio web.',
    ciRequired: true,
    maintenanceWindow: null,
    notifyTeam: true,
    requireCompletionConfirm: false,
    workflowId: null,
  },
  {
    categoryName: 'Sicurezza',
    name: 'Patch di Sicurezza OS',
    description: 'Applicazione di patch di sicurezza critiche al sistema operativo di un server.',
    riskLevel: 'medium',
    impact: 'medium',
    defaultTitleTemplate: 'Patch sicurezza OS — {ci_name}',
    defaultDescriptionTemplate: 'Applicazione delle patch di sicurezza OS su {ci_name} secondo la procedura standard.',
    defaultPriority: 'high',
    ciTypes: ['server'],
    checklist: [
      { title: 'Snapshot/Backup pre-patch',        description: 'Creare uno snapshot o backup del sistema prima di applicare le patch.' },
      { title: 'Verificare compatibilità patch',   description: 'Controllare la compatibilità delle patch con il software installato.' },
      { title: 'Applicare le patch',                description: 'Installare le patch di sicurezza tramite il package manager.' },
      { title: 'Riavviare il server',               description: 'Effettuare il reboot del server per applicare le patch kernel.' },
      { title: 'Verificare i servizi',              description: 'Controllare che tutti i servizi applicativi siano ripartiti correttamente.' },
    ],
    estimatedDurationHours: 4,
    requiresDowntime: true,
    rollbackProcedure: 'Ripristinare lo snapshot pre-patch e riavviare il server dalla configurazione precedente.',
    ciRequired: true,
    maintenanceWindow: 'Sabato 02:00-06:00',
    notifyTeam: true,
    requireCompletionConfirm: false,
    workflowId: null,
  },
  {
    categoryName: 'Gestione Accessi',
    name: 'Aggiunta Utente Active Directory',
    description: 'Creazione di un nuovo account utente in Active Directory con gruppo e permessi standard.',
    riskLevel: 'low',
    impact: 'low',
    defaultTitleTemplate: 'Nuovo utente AD — {ci_name}',
    defaultDescriptionTemplate: 'Creazione account Active Directory per nuovo utente su dominio {ci_name}.',
    defaultPriority: 'low',
    ciTypes: ['server'],
    checklist: [
      { title: 'Creare account AD',                description: 'Creare l\'account utente in Active Directory con i dati richiesti.' },
      { title: 'Assegnare ai gruppi',              description: 'Aggiungere l\'utente ai gruppi di sicurezza appropriati.' },
      { title: 'Verificare accesso',               description: 'Confermare che l\'utente possa autenticarsi e accedere alle risorse.' },
    ],
    estimatedDurationHours: 0.5,
    requiresDowntime: false,
    rollbackProcedure: 'Disabilitare o eliminare l\'account AD appena creato.',
    ciRequired: true,
    maintenanceWindow: null,
    notifyTeam: true,
    requireCompletionConfirm: false,
    workflowId: null,
  },
  {
    categoryName: 'Applicazioni',
    name: 'Deploy Applicazione in Staging',
    description: 'Deployment di una nuova versione applicativa nell\'ambiente di staging per test pre-produzione.',
    riskLevel: 'low',
    impact: 'low',
    defaultTitleTemplate: 'Deploy staging — {ci_name}',
    defaultDescriptionTemplate: 'Deploy della nuova versione di {ci_name} in ambiente staging per validazione.',
    defaultPriority: 'medium',
    ciTypes: ['application'],
    checklist: [
      { title: 'Build artefatto',                  description: 'Compilare e creare l\'artefatto di deploy dalla branch rilasciata.' },
      { title: 'Deploy su staging',                description: 'Effettuare il deploy dell\'artefatto nell\'ambiente staging.' },
      { title: 'Eseguire smoke test',              description: 'Eseguire i test di base per verificare il corretto funzionamento.' },
      { title: 'Comunicare esito al team',         description: 'Notificare il team dell\'esito del deploy e dei test.' },
    ],
    estimatedDurationHours: 1,
    requiresDowntime: false,
    rollbackProcedure: 'Eseguire il rollback alla versione precedente tramite il pipeline CI/CD.',
    ciRequired: true,
    maintenanceWindow: null,
    notifyTeam: true,
    requireCompletionConfirm: false,
    workflowId: null,
  },
  {
    categoryName: 'Rete',
    name: 'Aggiornamento Firmware Switch',
    description: 'Aggiornamento del firmware di uno switch di rete alla versione raccomandata dal vendor.',
    riskLevel: 'medium',
    impact: 'medium',
    defaultTitleTemplate: 'Aggiornamento firmware switch — {ci_name}',
    defaultDescriptionTemplate: 'Aggiornamento firmware dello switch {ci_name} alla versione raccomandata.',
    defaultPriority: 'high',
    ciTypes: ['server'],
    checklist: [
      { title: 'Backup configurazione',           description: 'Salvare la configurazione corrente dello switch.' },
      { title: 'Scaricare firmware',               description: 'Scaricare il firmware dalla pagina del vendor e verificare il checksum.' },
      { title: 'Caricare firmware sullo switch',   description: 'Trasferire il firmware sullo switch via SCP/TFTP.' },
      { title: 'Applicare e riavviare',            description: 'Applicare il firmware e riavviare lo switch.' },
      { title: 'Verificare connettività',          description: 'Controllare che tutte le porte e VLAN funzionino correttamente.' },
    ],
    estimatedDurationHours: 3,
    requiresDowntime: true,
    rollbackProcedure: 'Ripristinare il firmware precedente dal backup e ricaricare la configurazione salvata.',
    ciRequired: true,
    maintenanceWindow: 'Sabato 02:00-06:00',
    notifyTeam: true,
    requireCompletionConfirm: false,
    workflowId: null,
  },
]

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const session = getSession(undefined, 'WRITE')
  const now = new Date().toISOString()
  let catCreated = 0, catSkipped = 0
  let entCreated = 0, entSkipped = 0

  try {
    // Seed categories
    for (const cat of CATEGORIES) {
      const res = await session.executeWrite((tx) =>
        tx.run(`
          MERGE (c:ChangeCatalogCategory {tenant_id: $tenantId, name: $name})
          ON CREATE SET
            c.id          = $id,
            c.description = $description,
            c.icon        = $icon,
            c.color       = $color,
            c.\`order\`   = $order,
            c.enabled     = true,
            c.created_at  = $now,
            c.updated_at  = $now
          ON MATCH SET
            c.description = $description,
            c.icon        = $icon,
            c.color       = $color,
            c.\`order\`   = $order,
            c.updated_at  = $now
          RETURN c.created_at = $now AS isNew
        `, { tenantId, id: uuidv4(), ...cat, now }),
      )
      const isNew = res.records[0]?.get('isNew') as boolean
      if (isNew) catCreated++; else catSkipped++
    }

    // Seed entries
    for (const entry of ENTRIES) {
      const res = await session.executeWrite((tx) =>
        tx.run(`
          MATCH (cat:ChangeCatalogCategory {tenant_id: $tenantId, name: $categoryName})
          MERGE (e:StandardChangeCatalogEntry {tenant_id: $tenantId, name: $name, category_id: cat.id})
          ON CREATE SET
            e.id                           = $id,
            e.description                  = $description,
            e.risk_level                   = $riskLevel,
            e.impact                       = $impact,
            e.default_title_template       = $defaultTitleTemplate,
            e.default_description_template = $defaultDescriptionTemplate,
            e.default_priority             = $defaultPriority,
            e.ci_types                     = $ciTypes,
            e.checklist                    = $checklist,
            e.estimated_duration_hours     = $estimatedDurationHours,
            e.requires_downtime            = $requiresDowntime,
            e.rollback_procedure           = $rollbackProcedure,
            e.ci_required                  = $ciRequired,
            e.maintenance_window           = $maintenanceWindow,
            e.notify_team                  = $notifyTeam,
            e.require_completion_confirm   = $requireCompletionConfirm,
            e.workflow_id                  = $workflowId,
            e.icon                         = null,
            e.color                        = null,
            e.usage_count                  = 0,
            e.enabled                      = true,
            e.created_by                   = 'seed',
            e.created_at                   = $now,
            e.updated_at                   = $now
          ON MATCH SET
            e.description                  = $description,
            e.risk_level                   = $riskLevel,
            e.impact                       = $impact,
            e.default_title_template       = $defaultTitleTemplate,
            e.default_description_template = $defaultDescriptionTemplate,
            e.default_priority             = $defaultPriority,
            e.ci_types                     = $ciTypes,
            e.checklist                    = $checklist,
            e.estimated_duration_hours     = $estimatedDurationHours,
            e.requires_downtime            = $requiresDowntime,
            e.rollback_procedure           = $rollbackProcedure,
            e.ci_required                  = $ciRequired,
            e.maintenance_window           = $maintenanceWindow,
            e.notify_team                  = $notifyTeam,
            e.require_completion_confirm   = $requireCompletionConfirm,
            e.workflow_id                  = $workflowId,
            e.updated_at                   = $now
          MERGE (e)-[:BELONGS_TO_CATEGORY]->(cat)
          RETURN e.created_at = $now AS isNew
        `, {
          tenantId, id: uuidv4(),
          categoryName: entry.categoryName,
          name: entry.name,
          description: entry.description,
          riskLevel: entry.riskLevel,
          impact: entry.impact,
          defaultTitleTemplate: entry.defaultTitleTemplate,
          defaultDescriptionTemplate: entry.defaultDescriptionTemplate,
          defaultPriority: entry.defaultPriority,
          ciTypes: JSON.stringify(entry.ciTypes),
          checklist: JSON.stringify(entry.checklist),
          estimatedDurationHours: entry.estimatedDurationHours,
          requiresDowntime: entry.requiresDowntime,
          rollbackProcedure: entry.rollbackProcedure,
          ciRequired: entry.ciRequired,
          maintenanceWindow: entry.maintenanceWindow,
          notifyTeam: entry.notifyTeam,
          requireCompletionConfirm: entry.requireCompletionConfirm,
          workflowId: entry.workflowId,
          now,
        }),
      )
      const isNew = res.records[0]?.get('isNew') as boolean
      if (isNew) entCreated++; else entSkipped++
    }

    process.stdout.write(
      `Change catalog seed: categories ${catCreated} created / ${catSkipped} updated, ` +
      `entries ${entCreated} created / ${entSkipped} updated (tenant=${tenantId})\n`,
    )
  } finally {
    await session.close()
    process.exit(0)
  }
}

main().catch((err) => { process.stderr.write(String(err) + '\n'); process.exit(1) })
