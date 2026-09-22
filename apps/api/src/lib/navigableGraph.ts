import { getSession } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import { toPascalCase } from '@opengraphity/schema-generator'
import { getWorkflowSteps } from './workflowHelpers.js'
import { logger } from './logger.js'
import { enumScopeClause, loadTenantEnumOverrides, applyEnumOverrides } from './enumScope.js'
import { loadITILTypes } from './itilTypes.js'
import { formFields } from './catalogForm.js'
import { FORM_FIELD_TYPES_AS_PROPERTY } from '@opengraphity/types'

export interface NavigableField {
  name:       string
  label:      string
  /**
   * La chiave i18n dell'etichetta, quando l'etichetta è del PRODOTTO e non del
   * metamodello del cliente (revisione totale · C-18): «Name», «Assigned
   * team», «Member» erano letterali inglesi che arrivavano nel costruttore dei
   * report anche a chi usa il prodotto in italiano. Dove il nome è del cliente
   * (un campo o un tipo che ha creato lui) la chiave è assente e vale
   * l'etichetta, che è già la sua.
   */
  labelKey?:  string
  fieldType:  string
  enumValues: string[]
  /** Il vocabolario del campo (`USES_ENUM`), per leggere i valori con la loro etichetta. */
  enumTypeName: string | null
}

export interface NavigableRelation {
  relationshipType:  string
  direction:         string
  label:             string
  /** Chiave i18n dell'etichetta del prodotto (C-18). */
  labelKey?:         string
  targetLabelKey?:   string
  targetEntityType:  string
  targetLabel:       string
  targetNeo4jLabel:  string
}

/** Dove sta un'entità nel costruttore: lo dice l'API, il web non tiene la sua lista. */
export type NavigableGroup = 'itsm' | 'organization' | 'cmdb'

export interface NavigableEntity {
  entityType:  string
  label:       string
  /** Chiave i18n dell'etichetta del prodotto (C-18). */
  labelKey?:   string
  neo4jLabel:  string
  group:       NavigableGroup
  fields:      NavigableField[]
  relations:   NavigableRelation[]
}

// ── Organizzazione (non dal metamodello) ─────────────────────────────────────

const ORGANIZATION_ENTITIES: NavigableEntity[] = [
  {
    entityType: 'Team',
    label:      'Team',
    labelKey:   'reportBuilder.entity.team',
    neo4jLabel: 'Team',
    group:      'organization',
    fields: [
      { name: 'name', label: 'Name', labelKey: 'reportBuilder.field.name', fieldType: 'string', enumValues: [], enumTypeName: null },
      { name: 'type', label: 'Type', labelKey: 'reportBuilder.field.type', fieldType: 'string', enumValues: [], enumTypeName: null },
    ],
    relations: [],
  },
  {
    entityType: 'User',
    label:      'User',
    labelKey:   'reportBuilder.entity.user',
    neo4jLabel: 'User',
    group:      'organization',
    fields: [
      { name: 'name',  label: 'Name',  labelKey: 'reportBuilder.field.name',  fieldType: 'string', enumValues: [], enumTypeName: null },
      { name: 'email', label: 'Email', labelKey: 'reportBuilder.field.email', fieldType: 'string', enumValues: [], enumTypeName: null },
      { name: 'role',  label: 'Role',  labelKey: 'reportBuilder.field.role',  fieldType: 'string', enumValues: [], enumTypeName: null },
    ],
    relations: [],
  },
]

// ── I task (20 set 2026) ─────────────────────────────────────────────────────

/**
 * I TASK NEI REPORT.
 *
 * Fino a oggi non ci si poteva chiedere «quanti task aperti per squadra», né
 * «quanti ne ha chiusi il Desk a settembre», né «quali sono in ritardo»: né
 * il task generico nuovo né i cinque per CI delle change erano fra le entità
 * navigabili. Per i cinque è un buco che c'era da sempre.
 *
 * Sono SEI entità e non una perché sono sei nodi diversi, con campi diversi:
 * l'assessment ha un ruolo e un punteggio, la validazione un esito, il task
 * generico un passo e una scadenza. Unirli avrebbe voluto dire inventare un
 * tipo che nel grafo non esiste, e mostrare campi vuoti a seconda della riga.
 */
const CAMPO = (name: string, labelKey: string, fieldType = 'string'): NavigableField =>
  ({ name, label: name, labelKey, fieldType, enumValues: [], enumTypeName: null })

const TASK_ENTITIES: NavigableEntity[] = [
  {
    entityType: 'Task',
    label:      'Task',
    labelKey:   'reportBuilder.entity.task',
    neo4jLabel: 'Task',
    group:      'itsm',
    fields: [
      CAMPO('code',        'reportBuilder.field.code'),
      CAMPO('title',       'reportBuilder.field.title'),
      CAMPO('state',       'reportBuilder.field.state'),
      CAMPO('entity_type', 'reportBuilder.field.entityType'),
      CAMPO('step_name',   'reportBuilder.field.step'),
      CAMPO('due_at',      'reportBuilder.field.dueAt',      'datetime'),
      CAMPO('created_at',  'reportBuilder.field.createdAt',  'datetime'),
      CAMPO('completed_at', 'reportBuilder.field.completedAt', 'datetime'),
    ],
    relations: [],
  },
  {
    entityType: 'AssessmentTask',
    label:      'Assessment',
    labelKey:   'reportBuilder.entity.assessmentTask',
    neo4jLabel: 'AssessmentTask',
    group:      'itsm',
    fields: [
      CAMPO('code',           'reportBuilder.field.code'),
      CAMPO('status',         'reportBuilder.field.status'),
      CAMPO('responder_role', 'reportBuilder.field.responderRole'),
      CAMPO('score',          'reportBuilder.field.score',      'number'),
      CAMPO('created_at',     'reportBuilder.field.createdAt',  'datetime'),
      CAMPO('completed_at',   'reportBuilder.field.completedAt', 'datetime'),
    ],
    relations: [],
  },
  {
    entityType: 'DeployPlanTask',
    label:      'Deploy plan',
    labelKey:   'reportBuilder.entity.deployPlanTask',
    neo4jLabel: 'DeployPlanTask',
    group:      'itsm',
    fields: [
      CAMPO('code',         'reportBuilder.field.code'),
      CAMPO('status',       'reportBuilder.field.status'),
      CAMPO('created_at',   'reportBuilder.field.createdAt',   'datetime'),
      CAMPO('completed_at', 'reportBuilder.field.completedAt', 'datetime'),
    ],
    relations: [],
  },
  {
    entityType: 'ValidationTest',
    label:      'Validation',
    labelKey:   'reportBuilder.entity.validationTest',
    neo4jLabel: 'ValidationTest',
    group:      'itsm',
    fields: [
      CAMPO('code',      'reportBuilder.field.code'),
      CAMPO('status',    'reportBuilder.field.status'),
      CAMPO('result',    'reportBuilder.field.result'),
      CAMPO('tested_at', 'reportBuilder.field.testedAt', 'datetime'),
    ],
    relations: [],
  },
  {
    entityType: 'DeploymentTask',
    label:      'Deployment',
    labelKey:   'reportBuilder.entity.deploymentTask',
    neo4jLabel: 'DeploymentTask',
    group:      'itsm',
    fields: [
      CAMPO('code',        'reportBuilder.field.code'),
      CAMPO('status',      'reportBuilder.field.status'),
      CAMPO('deployed_at', 'reportBuilder.field.deployedAt', 'datetime'),
    ],
    relations: [],
  },
  {
    entityType: 'ReviewTask',
    label:      'Review',
    labelKey:   'reportBuilder.entity.reviewTask',
    neo4jLabel: 'ReviewTask',
    group:      'itsm',
    fields: [
      CAMPO('code',        'reportBuilder.field.code'),
      CAMPO('status',      'reportBuilder.field.status'),
      CAMPO('result',      'reportBuilder.field.result'),
      CAMPO('reviewed_at', 'reportBuilder.field.reviewedAt', 'datetime'),
    ],
    relations: [],
  },
]

// ── Relazioni dei ticket ──────────────────────────────────────────────────────

/**
 * Le relazioni che i servizi SCRIVONO davvero (verificate sul grafo di c-test
 * il 14 set 2026). Prima la lista diceva `Incident -AFFECTS->` e
 * `Change -AFFECTS->`, mentre gli incident scrivono `AFFECTED_BY` e le change
 * `AFFECTS_CI`: un report «incident per CI» tornava sempre vuoto.
 */
const TICKET_RELATIONS: Array<NavigableRelation & { sourceEntityType: string }> = [
  { sourceEntityType: 'Incident', relationshipType: 'AFFECTED_BY', direction: 'outgoing', label: 'Affected CI', labelKey: 'reportBuilder.relation.affectedCI', targetEntityType: 'CI', targetLabel: 'CI', targetLabelKey: 'reportBuilder.entity.ci', targetNeo4jLabel: 'ConfigurationItem' },
  { sourceEntityType: 'Incident', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Assigned team', labelKey: 'reportBuilder.relation.assignedTeam', targetEntityType: 'Team', targetLabel: 'Team', targetLabelKey: 'reportBuilder.entity.team', targetNeo4jLabel: 'Team' },
  { sourceEntityType: 'Incident', relationshipType: 'ASSIGNED_TO', direction: 'outgoing', label: 'Assigned user', labelKey: 'reportBuilder.relation.assignedUser', targetEntityType: 'User', targetLabel: 'User', targetLabelKey: 'reportBuilder.entity.user', targetNeo4jLabel: 'User' },
  { sourceEntityType: 'Incident', relationshipType: 'RESOLVED_BY', direction: 'outgoing', label: 'Resolved by change', labelKey: 'reportBuilder.relation.resolvedByChange', targetEntityType: 'Change', targetLabel: 'Change', targetLabelKey: 'reportBuilder.entity.change', targetNeo4jLabel: 'Change' },
  { sourceEntityType: 'Problem', relationshipType: 'AFFECTS', direction: 'outgoing', label: 'Affected CI', labelKey: 'reportBuilder.relation.affectedCI', targetEntityType: 'CI', targetLabel: 'CI', targetLabelKey: 'reportBuilder.entity.ci', targetNeo4jLabel: 'ConfigurationItem' },
  { sourceEntityType: 'Problem', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Assigned team', labelKey: 'reportBuilder.relation.assignedTeam', targetEntityType: 'Team', targetLabel: 'Team', targetLabelKey: 'reportBuilder.entity.team', targetNeo4jLabel: 'Team' },
  { sourceEntityType: 'Problem', relationshipType: 'ASSIGNED_TO', direction: 'outgoing', label: 'Assigned user', labelKey: 'reportBuilder.relation.assignedUser', targetEntityType: 'User', targetLabel: 'User', targetLabelKey: 'reportBuilder.entity.user', targetNeo4jLabel: 'User' },
  { sourceEntityType: 'Problem', relationshipType: 'CAUSED_BY', direction: 'outgoing', label: 'Related incident', labelKey: 'reportBuilder.relation.relatedIncident', targetEntityType: 'Incident', targetLabel: 'Incident', targetLabelKey: 'reportBuilder.entity.incident', targetNeo4jLabel: 'Incident' },
  { sourceEntityType: 'Problem', relationshipType: 'RESOLVED_BY', direction: 'outgoing', label: 'Resolved by change', labelKey: 'reportBuilder.relation.resolvedByChange', targetEntityType: 'Change', targetLabel: 'Change', targetLabelKey: 'reportBuilder.entity.change', targetNeo4jLabel: 'Change' },
  { sourceEntityType: 'Change', relationshipType: 'AFFECTS_CI', direction: 'outgoing', label: 'Affected CI', labelKey: 'reportBuilder.relation.affectedCI', targetEntityType: 'CI', targetLabel: 'CI', targetLabelKey: 'reportBuilder.entity.ci', targetNeo4jLabel: 'ConfigurationItem' },
  { sourceEntityType: 'Change', relationshipType: 'REQUESTED_BY', direction: 'outgoing', label: 'Requested by', labelKey: 'reportBuilder.relation.requestedBy', targetEntityType: 'User', targetLabel: 'User', targetLabelKey: 'reportBuilder.entity.user', targetNeo4jLabel: 'User' },
  { sourceEntityType: 'Change', relationshipType: 'OWNED_BY', direction: 'outgoing', label: 'Owner', labelKey: 'reportBuilder.relation.owner', targetEntityType: 'User', targetLabel: 'User', targetLabelKey: 'reportBuilder.entity.user', targetNeo4jLabel: 'User' },
  { sourceEntityType: 'ServiceRequest', relationshipType: 'REQUESTED_BY', direction: 'outgoing', label: 'Requested by', labelKey: 'reportBuilder.relation.requestedBy', targetEntityType: 'User', targetLabel: 'User', targetLabelKey: 'reportBuilder.entity.user', targetNeo4jLabel: 'User' },
  { sourceEntityType: 'ServiceRequest', relationshipType: 'ASSIGNED_TO', direction: 'outgoing', label: 'Assigned user', labelKey: 'reportBuilder.relation.assignedUser', targetEntityType: 'User', targetLabel: 'User', targetLabelKey: 'reportBuilder.entity.user', targetNeo4jLabel: 'User' },
  { sourceEntityType: 'Team', relationshipType: 'MEMBER_OF', direction: 'incoming', label: 'Member', labelKey: 'reportBuilder.relation.member', targetEntityType: 'User', targetLabel: 'User', targetLabelKey: 'reportBuilder.entity.user', targetNeo4jLabel: 'User' },

  /**
   * I TASK (20 set 2026). Da ogni ticket ai suoi, e da un task alla squadra
   * e alla persona: è quello che serve per «quanti aperti per squadra».
   * `HAS_TASK` è il task generico del workflow; le cinque `HAS_*` delle
   * change sono quelle che il prodotto scrive da sempre.
   */
  { sourceEntityType: 'Incident',       relationshipType: 'HAS_TASK', direction: 'outgoing', label: 'Task', labelKey: 'reportBuilder.relation.task', targetEntityType: 'Task', targetLabel: 'Task', targetLabelKey: 'reportBuilder.entity.task', targetNeo4jLabel: 'Task' },
  { sourceEntityType: 'Problem',        relationshipType: 'HAS_TASK', direction: 'outgoing', label: 'Task', labelKey: 'reportBuilder.relation.task', targetEntityType: 'Task', targetLabel: 'Task', targetLabelKey: 'reportBuilder.entity.task', targetNeo4jLabel: 'Task' },
  { sourceEntityType: 'Change',         relationshipType: 'HAS_TASK', direction: 'outgoing', label: 'Task', labelKey: 'reportBuilder.relation.task', targetEntityType: 'Task', targetLabel: 'Task', targetLabelKey: 'reportBuilder.entity.task', targetNeo4jLabel: 'Task' },
  { sourceEntityType: 'ServiceRequest', relationshipType: 'HAS_TASK', direction: 'outgoing', label: 'Task', labelKey: 'reportBuilder.relation.task', targetEntityType: 'Task', targetLabel: 'Task', targetLabelKey: 'reportBuilder.entity.task', targetNeo4jLabel: 'Task' },

  { sourceEntityType: 'Change', relationshipType: 'HAS_ASSESSMENT',  direction: 'outgoing', label: 'Assessment',  labelKey: 'reportBuilder.relation.assessment',  targetEntityType: 'AssessmentTask', targetLabel: 'Assessment',  targetLabelKey: 'reportBuilder.entity.assessmentTask', targetNeo4jLabel: 'AssessmentTask' },
  { sourceEntityType: 'Change', relationshipType: 'HAS_DEPLOY_PLAN', direction: 'outgoing', label: 'Deploy plan', labelKey: 'reportBuilder.relation.deployPlan', targetEntityType: 'DeployPlanTask', targetLabel: 'Deploy plan', targetLabelKey: 'reportBuilder.entity.deployPlanTask', targetNeo4jLabel: 'DeployPlanTask' },
  { sourceEntityType: 'Change', relationshipType: 'HAS_VALIDATION',  direction: 'outgoing', label: 'Validation',  labelKey: 'reportBuilder.relation.validation',  targetEntityType: 'ValidationTest', targetLabel: 'Validation',  targetLabelKey: 'reportBuilder.entity.validationTest', targetNeo4jLabel: 'ValidationTest' },
  { sourceEntityType: 'Change', relationshipType: 'HAS_DEPLOYMENT',  direction: 'outgoing', label: 'Deployment',  labelKey: 'reportBuilder.relation.deployment',  targetEntityType: 'DeploymentTask', targetLabel: 'Deployment',  targetLabelKey: 'reportBuilder.entity.deploymentTask', targetNeo4jLabel: 'DeploymentTask' },
  { sourceEntityType: 'Change', relationshipType: 'HAS_REVIEW',      direction: 'outgoing', label: 'Review',      labelKey: 'reportBuilder.relation.review',      targetEntityType: 'ReviewTask',     targetLabel: 'Review',      targetLabelKey: 'reportBuilder.entity.reviewTask',     targetNeo4jLabel: 'ReviewTask' },

  { sourceEntityType: 'Task', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Assigned team', labelKey: 'reportBuilder.relation.assignedTeam', targetEntityType: 'Team', targetLabel: 'Team', targetLabelKey: 'reportBuilder.entity.team', targetNeo4jLabel: 'Team' },
  { sourceEntityType: 'Task', relationshipType: 'ASSIGNED_TO',      direction: 'outgoing', label: 'Assigned user', labelKey: 'reportBuilder.relation.assignedUser', targetEntityType: 'User', targetLabel: 'User', targetLabelKey: 'reportBuilder.entity.user', targetNeo4jLabel: 'User' },
  { sourceEntityType: 'AssessmentTask', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Assigned team', labelKey: 'reportBuilder.relation.assignedTeam', targetEntityType: 'Team', targetLabel: 'Team', targetLabelKey: 'reportBuilder.entity.team', targetNeo4jLabel: 'Team' },
  { sourceEntityType: 'DeployPlanTask', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Assigned team', labelKey: 'reportBuilder.relation.assignedTeam', targetEntityType: 'Team', targetLabel: 'Team', targetLabelKey: 'reportBuilder.entity.team', targetNeo4jLabel: 'Team' },
]

const relationsOf = (entityType: string): NavigableRelation[] =>
  TICKET_RELATIONS
    .filter((r) => r.sourceEntityType === entityType)
    .map(({ sourceEntityType: _src, ...rest }) => rest)

// ── Main exports ──────────────────────────────────────────────────────────────

export async function getNavigableEntities(tenantId: string): Promise<NavigableEntity[]> {
  const session = getSession(undefined, 'READ')
  try {
    const overrides = await loadTenantEnumOverrides(session, tenantId)
    const result = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition)
        WHERE t.active = true
          AND t.scope <> 'itil'
          AND (t.scope = 'base' OR t.tenant_id = $tenantId)
          AND t.name <> '__base__'
        OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
        OPTIONAL MATCH (f)-[:USES_ENUM]->(en:EnumTypeDefinition)
          ${enumScopeClause('en')}
        OPTIONAL MATCH (t)-[:HAS_RELATION]->(r:CIRelationDefinition)
        OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
        RETURN t,
          collect(DISTINCT {f: f, enumId: en.id, enumName: en.name, enumValues: en.values}) AS fields,
          collect(DISTINCT r)  AS relations,
          collect(DISTINCT sr) AS systemRelations
        ORDER BY t.name
      `, { tenantId }),
    )

    type FieldRow = { f: { properties: Record<string, unknown> } | null; enumId: string | null; enumName: string | null; enumValues: string[] | string | null }
    const ciEntities: NavigableEntity[] = result.records.map(record => {
      const t = record.get('t').properties as Record<string, unknown>

      const fields: NavigableField[] = applyEnumOverrides(
        (record.get('fields') as FieldRow[]).filter(row => row.f && row.f.properties),
        overrides,
      ).map(row => {
        const props = row.f!.properties
        return {
          name:         props['name'] as string,
          label:        props['label'] as string,
          fieldType:    props['field_type'] as string,
          enumValues:   row.enumName ? enumValuesOf(row.enumValues) : enumValuesOf(props['enum_values'] as string | null),
          enumTypeName: row.enumName ?? null,
        }
      })

      const relations: NavigableRelation[] = [
        ...(record.get('relations') as Array<{ properties: Record<string, unknown> }>)
          .filter(r => r && r.properties)
          .map(r => ({
            relationshipType:  r.properties['relationship_type'] as string,
            direction:         r.properties['direction'] as string,
            label:             r.properties['label'] as string,
            targetEntityType:  r.properties['target_type'] as string,
            targetLabel:       toPascalCase(r.properties['target_type'] as string),
            targetNeo4jLabel:  toPascalCase(r.properties['target_type'] as string),
          })),
        ...(record.get('systemRelations') as Array<{ properties: Record<string, unknown> }>)
          .filter(sr => sr && sr.properties)
          .map(sr => ({
            relationshipType:  sr.properties['relationship_type'] as string,
            direction:         'outgoing',
            label:             sr.properties['label'] as string,
            targetEntityType:  sr.properties['target_entity'] as string,
            targetLabel:       sr.properties['target_entity'] as string,
            targetNeo4jLabel:  sr.properties['target_entity'] as string,
          })),
      ]

      const entityType = t['name'] as string
      return {
        entityType,
        label:      t['label'] as string,
        neo4jLabel: (t['neo4j_label'] as string | null) ?? toPascalCase(entityType),
        group:      'cmdb' as const,
        // Il NOME del CI, per la stessa ragione del numero di un ticket: è
        // una proprietà del prodotto, non un campo del tipo, e senza non si
        // può dire in tabella DI QUALE CI parla la riga.
        fields: [
          ...(fields.some((f) => f.name === 'name') ? [] : [
            { name: 'name', label: 'Name', labelKey: 'reportBuilder.field.name', fieldType: 'string', enumValues: [] as string[], enumTypeName: null },
          ]),
          ...fields,
        ],
        relations,
      }
    })

    return [
      ...await ticketEntities(session, tenantId),
      ...TASK_ENTITIES.map(withRelations),
      ...ORGANIZATION_ENTITIES.map(withRelations),
      ...ciEntities,
    ]
  } finally {
    await session.close()
  }
}

function enumValuesOf(raw: string[] | string | null | undefined): string[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw !== '') {
    // C-28: il messaggio dice che è un JSON corrotto, non un SyntaxError nudo.
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch (e) {
      throw new Error(`enum values are not valid JSON (${e instanceof Error ? e.message : String(e)}): ${raw.slice(0, 80)}`, { cause: e })
    }
    if (!Array.isArray(parsed)) throw new Error(`enum values are not a JSON array: ${raw.slice(0, 80)}`)
    return parsed as string[]
  }
  return []
}

const withRelations = (e: NavigableEntity): NavigableEntity => ({ ...e, relations: relationsOf(e.entityType) })

/**
 * I ticket (Incident, Problem, Change, Service Request) con i campi del
 * METAMODELLO ITIL del tenant — quelli che il cliente vede e aggiunge nel
 * disegnatore — invece di una lista scritta qui. Prima c'erano solo Incident
 * (5 campi) e Change: niente problem né richieste, niente categoria, impatto
 * o priorità.
 *
 * Il campo `status` prende i PASSI del workflow di questo cliente (ondata 8 ·
 * B-11). Nessun ripiego sulla lista di fabbrica: se il cliente non ha un
 * workflow per quell'entità, `enumValues` resta vuoto e il costruttore offre
 * un campo di testo libero invece di valori che non esistono nel suo grafo.
 *
 * Alle RICHIESTE si aggiungono i campi della LIBRERIA dei moduli del catalogo
 * (ondata 4). Sono proprietà del ticket come le altre — è il motivo per cui i
 * moduli scrivono proprietà e non un documento — e senza di loro la promessa
 * «la stessa domanda è una colonna sola in ogni report» non sarebbe vera: si
 * potevano filtrare e mettere in colonna, ma non riportare. Qui c'è TUTTA la
 * libreria, non solo i campi «nelle liste»: un report si compone scegliendo i
 * campi uno per uno, quindi non c'è lo spazio a schermo da difendere.
 */
async function ticketEntities(session: Session, tenantId: string): Promise<NavigableEntity[]> {
  const types = await loadITILTypes(session, tenantId)
  const out: NavigableEntity[] = []
  for (const type of types) {
    const neo4jLabel = type.neo4jLabel ?? toPascalCase(type.name)
    const steps = await getWorkflowSteps(session, tenantId, type.name)
    // Senza ripetizioni: un tenant con due definizioni attive della stessa
    // entità (c-one ne ha due per gli incident, base e «Security») contribuisce
    // con l'unione dei passi, e i nomi in comune arrivano due volte.
    const stepNames = [...new Set(
      steps
        .slice()
        .sort((a, b) => (a.stepOrder ?? 999) - (b.stepOrder ?? 999) || a.name.localeCompare(b.name))
        .map((s) => s.name),
    )]
    if (stepNames.length === 0) {
      logger.warn({ module: 'navigable-graph', tenantId, entityType: neo4jLabel }, 'Nessun passo di workflow: il filtro di stato dei report non offrirà valori')
    }
    out.push({
      entityType: neo4jLabel,
      label:      type.label,
      neo4jLabel,
      group:      'itsm',
      fields: [
        /*
         * IL NUMERO DEL TICKET (20 set 2026, dal giro nel browser: «tra le
         * colonne non c'è l'id del ci (in questo caso il numero del ticket)»).
         *
         * `number` è del PRODOTTO — il metamodello ITIL non lo dichiara, come
         * non dichiara `id` — quindi non arrivava fra i campi navigabili: una
         * tabella di incident si poteva costruire con titolo, stato e
         * severità, e non con INC00000024. Cioè senza la colonna che dice a
         * QUALE ticket si riferisce la riga, che è la prima che si guarda e
         * l'unica con cui si va ad aprirlo.
         */
        // Se un domani il metamodello lo dichiarasse, vince quello del cliente.
        ...(type.fields.some((f) => f.name === 'number') ? [] : [
          { name: 'number', label: 'Number', labelKey: 'reportBuilder.field.number', fieldType: 'string', enumValues: [] as string[], enumTypeName: null },
        ]),
        ...type.fields.map((f) => ({
          name:         f.name as string,
          label:        f.label as string,
          fieldType:    f.fieldType as string,
          enumValues:   f.name === 'status' ? stepNames : (f.enumValues as string[]),
          enumTypeName: f.name === 'status' ? null : (f.enumTypeName as string | null),
        })),
      ],
      relations: relationsOf(neo4jLabel),
    })
  }
  for (const entity of out) {
    if (entity.neo4jLabel !== 'ServiceRequest') continue
    const libreria = await formFields(session, tenantId)
    for (const campo of libreria) {
      // Solo i campi che diventano una proprietà: una nota non ha risposta, un
      // allegato è un file e un riferimento è una relazione — nessuno dei tre
      // è una colonna che un report possa leggere da `n.<nome>`.
      if (!FORM_FIELD_TYPES_AS_PROPERTY.includes(campo.fieldType)) continue
      if (entity.fields.some((f) => f.name === campo.name)) continue
      entity.fields.push({
        name:         campo.name,
        // Etichetta del cliente: nessuna `labelKey`, come per i campi che ha
        // creato lui nel disegnatore.
        label:        campo.label,
        fieldType:    campo.fieldType,
        enumValues:   [],
        // Il vocabolario: il costruttore legge da lì i valori con la loro
        // etichetta, invece di offrire testo libero.
        enumTypeName: campo.vocabulary,
      })
    }
  }
  return out
}

export async function getNavigableRelations(
  entityType: string,
  _neo4jLabel: string,
  tenantId: string,
): Promise<NavigableRelation[]> {
  // Fixed entities
  const fixedRels = relationsOf(entityType)

  if (fixedRels.length > 0) return fixedRels

  // CI types: query metamodel
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition {name: $entityType})
        WHERE t.active = true AND (t.scope = 'base' OR t.tenant_id = $tenantId)
        OPTIONAL MATCH (t)-[:HAS_RELATION]->(r:CIRelationDefinition)
        OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
        RETURN collect(DISTINCT r) AS relations, collect(DISTINCT sr) AS systemRelations
      `, { entityType, tenantId }),
    )

    if (!result.records.length) return []
    const record = result.records[0]

    return [
      ...(record.get('relations') as Array<{ properties: Record<string, unknown> }>)
        .filter(r => r && r.properties)
        .map(r => ({
          relationshipType:  r.properties['relationship_type'] as string,
          direction:         r.properties['direction'] as string,
          label:             r.properties['label'] as string,
          targetEntityType:  r.properties['target_type'] as string,
          targetLabel:       toPascalCase(r.properties['target_type'] as string),
          targetNeo4jLabel:  toPascalCase(r.properties['target_type'] as string),
        })),
      ...(record.get('systemRelations') as Array<{ properties: Record<string, unknown> }>)
        .filter(sr => sr && sr.properties)
        .map(sr => ({
          relationshipType:  sr.properties['relationship_type'] as string,
          direction:         'outgoing',
          label:             sr.properties['label'] as string,
          targetEntityType:  sr.properties['target_entity'] as string,
          targetLabel:       sr.properties['target_entity'] as string,
          targetNeo4jLabel:  sr.properties['target_entity'] as string,
        })),
    ]
  } finally {
    await session.close()
  }
}
