import { getSession } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import { toPascalCase } from '@opengraphity/schema-generator'
import { getWorkflowSteps } from './workflowHelpers.js'
import { logger } from './logger.js'

export interface NavigableField {
  name:       string
  label:      string
  fieldType:  string
  enumValues: string[]
}

export interface NavigableRelation {
  relationshipType:  string
  direction:         string
  label:             string
  targetEntityType:  string
  targetLabel:       string
  targetNeo4jLabel:  string
}

export interface NavigableEntity {
  entityType:  string
  label:       string
  neo4jLabel:  string
  fields:      NavigableField[]
  relations:   NavigableRelation[]
}

// ── Fixed entities (not from metamodel) ──────────────────────────────────────

const FIXED_ENTITIES: NavigableEntity[] = [
  {
    entityType: 'Incident',
    label:      'Incident',
    neo4jLabel: 'Incident',
    fields: [
      { name: 'title',       label: 'Title',        fieldType: 'text',   enumValues: [] },
      { name: 'severity',    label: 'Severity',     fieldType: 'enum',   enumValues: ['critical', 'high', 'medium', 'low'] },
      // `enumValues` vuoto qui e riempito per tenant da `withWorkflowStatuses`
      // (ondata 8 · B-11): i valori dello stato sono i PASSI del workflow di
      // questo cliente. La lista fissa offriva `open`, che nessun workflow
      // produce, e non offriva i passi veri (`new`, `security_review`, o
      // qualunque cosa il cliente abbia aggiunto): un filtro di report sullo
      // stato non poteva selezionare niente di esistente.
      { name: 'status',      label: 'Status',       fieldType: 'enum',   enumValues: [] },
      { name: 'created_at',  label: 'Created At',   fieldType: 'date',   enumValues: [] },
      { name: 'resolved_at', label: 'Resolved At',  fieldType: 'date',   enumValues: [] },
    ],
    relations: [],
  },
  {
    entityType: 'Change',
    label:      'Change',
    neo4jLabel: 'Change',
    fields: [
      { name: 'title',           label: 'Title',           fieldType: 'text', enumValues: [] },
      { name: 'type',            label: 'Type',            fieldType: 'enum', enumValues: ['standard', 'normal', 'emergency'] },
      { name: 'priority',        label: 'Priority',        fieldType: 'enum', enumValues: ['low', 'medium', 'high', 'critical'] },
      // Come sopra: i passi della definizione change di questo cliente.
      { name: 'status',          label: 'Status',          fieldType: 'enum', enumValues: [] },
      { name: 'scheduled_start', label: 'Scheduled Start', fieldType: 'date', enumValues: [] },
    ],
    relations: [],
  },
  {
    entityType: 'Team',
    label:      'Team',
    neo4jLabel: 'Team',
    fields: [
      { name: 'name', label: 'Name', fieldType: 'text', enumValues: [] },
      { name: 'type', label: 'Type', fieldType: 'text', enumValues: [] },
    ],
    relations: [],
  },
  {
    entityType: 'User',
    label:      'User',
    neo4jLabel: 'User',
    fields: [
      { name: 'name',  label: 'Name',  fieldType: 'text', enumValues: [] },
      { name: 'email', label: 'Email', fieldType: 'text', enumValues: [] },
      { name: 'role',  label: 'Role',  fieldType: 'enum', enumValues: ['admin', 'operator', 'viewer'] },
    ],
    relations: [],
  },
  {
    entityType: 'ChangeTask',
    label:      'Change Task',
    neo4jLabel: 'ChangeTask',
    fields: [
      { name: 'task_type',         label: 'Tipo task',            fieldType: 'enum',    enumValues: ['assessment', 'deploy', 'validation'] },
      { name: 'title',             label: 'Titolo',               fieldType: 'string',  enumValues: [] },
      { name: 'status',            label: 'Stato',                fieldType: 'enum',    enumValues: ['pending', 'in_progress', 'completed', 'failed', 'skipped', 'rejected'] },
      { name: 'order',             label: 'Ordine',               fieldType: 'number',  enumValues: [] },
      { name: 'risk_level',        label: 'Livello rischio',      fieldType: 'enum',    enumValues: ['low', 'medium', 'high', 'critical'] },
      { name: 'notes',             label: 'Note',                 fieldType: 'string',  enumValues: [] },
      { name: 'has_validation',    label: 'Ha validazione',       fieldType: 'boolean', enumValues: [] },
      { name: 'validation_status', label: 'Stato validazione',    fieldType: 'enum',    enumValues: ['pending', 'passed', 'failed'] },
      { name: 'scheduled_start',   label: 'Inizio pianificato',   fieldType: 'date',    enumValues: [] },
      { name: 'scheduled_end',     label: 'Fine pianificata',     fieldType: 'date',    enumValues: [] },
      { name: 'created_at',        label: 'Creato il',            fieldType: 'date',    enumValues: [] },
    ],
    relations: [
      {
        relationshipType: 'HAS_CHANGE_TASK',
        direction:        'incoming',
        label:            'Change',
        targetEntityType: 'Change',
        targetLabel:      'Change',
        targetNeo4jLabel: 'Change',
      },
      {
        relationshipType: 'ASSESSES',
        direction:        'outgoing',
        label:            'CI Valutato',
        targetEntityType: 'any',
        targetLabel:      'CI',
        targetNeo4jLabel: 'any',
      },
    ],
  },
]

// ── Fixed relations ──────────────────────────────────────────────────────────

const FIXED_RELATIONS: Array<NavigableRelation & { sourceEntityType: string }> = [
  {
    sourceEntityType: 'Incident',
    relationshipType: 'AFFECTS',
    direction:        'outgoing',
    label:            'Affects CI',
    targetEntityType: 'CI',
    targetLabel:      'CI',
    targetNeo4jLabel: 'CIBase',
  },
  {
    sourceEntityType: 'Incident',
    relationshipType: 'ASSIGNED_TO_TEAM',
    direction:        'outgoing',
    label:            'Assigned to Team',
    targetEntityType: 'Team',
    targetLabel:      'Team',
    targetNeo4jLabel: 'Team',
  },
  {
    sourceEntityType: 'Incident',
    relationshipType: 'ASSIGNED_TO',
    direction:        'outgoing',
    label:            'Assigned to User',
    targetEntityType: 'User',
    targetLabel:      'User',
    targetNeo4jLabel: 'User',
  },
  {
    sourceEntityType: 'Change',
    relationshipType: 'AFFECTS',
    direction:        'outgoing',
    label:            'Affects CI',
    targetEntityType: 'CI',
    targetLabel:      'CI',
    targetNeo4jLabel: 'CIBase',
  },
  {
    sourceEntityType: 'Change',
    relationshipType: 'ASSIGNED_TO_TEAM',
    direction:        'outgoing',
    label:            'Assigned to Team',
    targetEntityType: 'Team',
    targetLabel:      'Team',
    targetNeo4jLabel: 'Team',
  },
  {
    sourceEntityType: 'Team',
    relationshipType: 'MEMBER_OF',
    direction:        'incoming',
    label:            'Member',
    targetEntityType: 'User',
    targetLabel:      'User',
    targetNeo4jLabel: 'User',
  },
  {
    sourceEntityType: 'Change',
    relationshipType: 'HAS_CHANGE_TASK',
    direction:        'outgoing',
    label:            'Change Task',
    targetEntityType: 'ChangeTask',
    targetLabel:      'Change Task',
    targetNeo4jLabel: 'ChangeTask',
  },
]

// ── Main exports ──────────────────────────────────────────────────────────────

export async function getNavigableEntities(tenantId: string): Promise<NavigableEntity[]> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition)
        WHERE t.active = true
          AND (t.scope = 'base' OR t.tenant_id = $tenantId)
          AND t.name <> '__base__'
        OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
        OPTIONAL MATCH (t)-[:HAS_RELATION]->(r:CIRelationDefinition)
        OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
        RETURN t,
          collect(DISTINCT f)  AS fields,
          collect(DISTINCT r)  AS relations,
          collect(DISTINCT sr) AS systemRelations
        ORDER BY t.name
      `, { tenantId }),
    )

    const ciEntities: NavigableEntity[] = result.records.map(record => {
      const t = record.get('t').properties as Record<string, unknown>

      const fields: NavigableField[] = (record.get('fields') as Array<{ properties: Record<string, unknown> }>)
        .filter(f => f && f.properties)
        .map(f => ({
          name:       f.properties['name'] as string,
          label:      f.properties['label'] as string,
          fieldType:  f.properties['field_type'] as string,
          enumValues: f.properties['enum_values']
            ? JSON.parse(f.properties['enum_values'] as string) as string[]
            : [],
        }))

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
        fields,
        relations,
      }
    })

    return [...ciEntities, ...await withWorkflowStatuses(session, tenantId)]
  } finally {
    await session.close()
  }
}

/**
 * Le entità fisse con il campo `status` riempito dai PASSI del workflow di
 * questo cliente (ondata 8 · B-11). `STATUS_FROM_WORKFLOW` dice quale
 * `entity_type` di workflow corrisponde a quale entità navigabile.
 *
 * Nessun ripiego sulla lista di fabbrica: se il cliente non ha un workflow per
 * quell'entità, `enumValues` resta vuoto e il costruttore di report offre un
 * campo di testo libero (`ConditionRowEditor`) invece di una tendina di valori
 * che non esistono nel suo grafo.
 */
const STATUS_FROM_WORKFLOW: Record<string, string> = { Incident: 'incident', Change: 'change' }

async function withWorkflowStatuses(session: Session, tenantId: string): Promise<NavigableEntity[]> {
  const out: NavigableEntity[] = []
  for (const entity of FIXED_ENTITIES) {
    const workflowEntityType = STATUS_FROM_WORKFLOW[entity.entityType]
    if (!workflowEntityType) { out.push(entity); continue }
    const steps = await getWorkflowSteps(session, tenantId, workflowEntityType)
    // Senza ripetizioni: un tenant con due definizioni attive della stessa
    // entità (c-one ne ha due per gli incident, base e «Security») contribuisce
    // con l'unione dei passi, e i nomi in comune arrivano due volte — una
    // tendina con «resolved» ripetuto due volte è peggio di una lista fissa.
    const names = [...new Set(
      steps
        .slice()
        .sort((a, b) => (a.stepOrder ?? 999) - (b.stepOrder ?? 999) || a.name.localeCompare(b.name))
        .map((s) => s.name),
    )]
    if (names.length === 0) {
      logger.warn({ module: 'navigable-graph', tenantId, entityType: entity.entityType }, 'Nessun passo di workflow: il filtro di stato dei report non offrirà valori')
    }
    out.push({
      ...entity,
      fields: entity.fields.map((f) => (f.name === 'status' ? { ...f, enumValues: names } : f)),
    })
  }
  return out
}

export async function getNavigableRelations(
  entityType: string,
  _neo4jLabel: string,
  tenantId: string,
): Promise<NavigableRelation[]> {
  // Fixed entities
  const fixedRels = FIXED_RELATIONS
    .filter(r => r.sourceEntityType === entityType)
    .map(({ sourceEntityType: _src, ...rest }) => rest)

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
