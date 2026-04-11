export type Props = Record<string, unknown>

export function mapCategory(props: Props, entryCount?: number) {
  return {
    id:          props['id']          as string,
    name:        props['name']        as string,
    description: (props['description'] ?? null) as string | null,
    icon:        (props['icon']       ?? null) as string | null,
    color:       (props['color']      ?? null) as string | null,
    order:       Number(props['order'] ?? 0),
    enabled:     props['enabled'] !== false,
    entryCount:  entryCount ?? 0,
  }
}

export function mapEntry(props: Props) {
  const ciTypesRaw = props['ci_types']
  let ciTypes: string[] | null = null
  if (typeof ciTypesRaw === 'string') {
    try { ciTypes = JSON.parse(ciTypesRaw) as string[] } catch { ciTypes = null }
  } else if (Array.isArray(ciTypesRaw)) {
    ciTypes = ciTypesRaw as string[]
  }

  return {
    id:                         props['id']                           as string,
    name:                       props['name']                         as string,
    description:                props['description']                  as string,
    categoryId:                 props['category_id']                  as string,
    riskLevel:                  props['risk_level']                   as string,
    impact:                     props['impact']                       as string,
    defaultTitleTemplate:       props['default_title_template']       as string,
    defaultDescriptionTemplate: props['default_description_template'] as string,
    defaultPriority:            props['default_priority']             as string,
    ciTypes,
    checklist:                  (props['checklist']                   ?? null) as string | null,
    estimatedDurationHours:     props['estimated_duration_hours'] != null ? Number(props['estimated_duration_hours']) : null,
    requiresDowntime:           props['requires_downtime'] === true,
    rollbackProcedure:          (props['rollback_procedure']          ?? null) as string | null,
    icon:                       (props['icon']                        ?? null) as string | null,
    color:                      (props['color']                       ?? null) as string | null,
    workflowId:                 (props['workflow_id'] ?? null) as string | null,
    ciRequired:                 props['ci_required'] === true,
    maintenanceWindow:          (props['maintenance_window'] ?? null) as string | null,
    notifyTeam:                 props['notify_team'] === true,
    requireCompletionConfirm:   props['require_completion_confirm'] === true,
    usageCount:                 Number(props['usage_count'] ?? 0),
    enabled:                    props['enabled'] !== false,
    createdBy:                  (props['created_by']                  ?? null) as string | null,
    createdAt:                  props['created_at']                   as string,
    updatedAt:                  props['updated_at']                   as string,
    // populated by field resolver
    category:                   null,
  }
}

export function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`)
}

export function toInt(v: unknown, fallback = 0): number {
  if (v == null) return fallback
  if (typeof v === 'number') return v
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function')
    return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}
