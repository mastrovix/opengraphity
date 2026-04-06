import type { Session } from 'neo4j-driver'
import { v4 as uuidv4 } from 'uuid'

interface SystemEnum {
  name:   string
  label:  string
  values: string[]
  scope:  'itil' | 'cmdb' | 'shared'
}

const SYSTEM_ENUMS: SystemEnum[] = [
  { name: 'priority',                label: 'Priority',               values: ['low', 'medium', 'high', 'critical'],              scope: 'shared' },
  { name: 'severity',                label: 'Severity',               values: ['low', 'medium', 'high', 'critical'],              scope: 'shared' },
  { name: 'environment',             label: 'Environment',            values: ['production', 'staging', 'development', 'testing', 'dr'], scope: 'shared' },
  { name: 'risk',                    label: 'Risk',                   values: ['low', 'medium', 'high'],                          scope: 'shared' },
  { name: 'impact',                  label: 'Impact',                 values: ['low', 'medium', 'high'],                          scope: 'shared' },
  { name: 'category',                label: 'Category',               values: ['hardware', 'software', 'network', 'access', 'other'], scope: 'shared' },
  { name: 'ci_status',               label: 'CI Status',              values: ['active', 'inactive', 'maintenance', 'decommissioned'], scope: 'cmdb' },
  { name: 'status_incident',         label: 'Incident Status',        values: ['new', 'open', 'assigned', 'in_progress', 'pending', 'escalated', 'resolved', 'closed'], scope: 'itil' },
  { name: 'status_change',           label: 'Change Status',          values: ['draft', 'assessment', 'cab_approval', 'emergency_approval', 'scheduled', 'deployment', 'validation', 'post_review', 'completed', 'approved', 'failed', 'rejected', 'cancelled'], scope: 'itil' },
  { name: 'status_problem',          label: 'Problem Status',         values: ['new', 'under_investigation', 'change_requested', 'change_in_progress', 'resolved', 'closed', 'rejected', 'deferred'], scope: 'itil' },
  { name: 'status_service_request',  label: 'Service Request Status', values: ['open', 'in_progress', 'completed', 'cancelled'],  scope: 'itil' },
  { name: 'change_type',             label: 'Change Type',            values: ['standard', 'normal', 'emergency'],                scope: 'itil' },
]

export async function seedSystemEnumTypes(tenantId: string, session: Session): Promise<void> {
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
        tenantId,
        id:       uuidv4(),
        label:    e.label,
        values:   e.values,
        scope:    e.scope,
        now,
      }),
    )
  }
}
