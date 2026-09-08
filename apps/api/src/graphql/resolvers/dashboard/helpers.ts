import { withSession } from '../ci-utils.js'
import { loadSectionById } from '../../../lib/reportTemplates.js'
import type { ReportSectionDef } from '../../../lib/reportQueryBuilder.js'

export type Props = Record<string, unknown>

// ── loadReportSection ─────────────────────────────────────────────────────────

/**
 * Section a widget points to, via the shared loader (lib/reportTemplates).
 * The previous local copy read `s.limit` (persisted as `limit_val`) and passed
 * `selected_fields` unparsed, so table widgets iterated a JSON string char by
 * char (C-05).
 */
export async function loadReportSection(sectionId: string, tenantId: string): Promise<ReportSectionDef | null> {
  return withSession((session) => loadSectionById(session, sectionId, tenantId))
}

// ── Mappers ───────────────────────────────────────────────────────────────────

export function mapDashboardConfig(props: Props) {
  return {
    id:          props['id']           as string,
    name:        props['name']         as string,
    description: (props['description'] ?? null) as string | null,
    role:        (props['role']        ?? null) as string | null,
    isDefault:   (props['is_default']  ?? false) as boolean,
    isPersonal:  (props['is_personal'] ?? false) as boolean,
    isShared:    (props['is_shared']   ?? false) as boolean,
    visibility:  (props['visibility']  ?? 'private') as string,
    createdAt:   props['created_at']   as string,
    updatedAt:   (props['updated_at']  ?? null) as string | null,
    // resolved by field resolvers
    widgets:       [] as ReturnType<typeof mapDashboardWidget>[],
    customWidgets: [] as unknown[],
    sharedWith:    [] as unknown[],
    createdBy:     null as unknown,
  }
}

export function mapDashboardWidget(props: Props) {
  return {
    id:               props['id']                 as string,
    order:            Math.round(Number(props['order']    ?? 0)),
    colSpan:          Math.round(Number(props['col_span'] ?? 4)),
    reportTemplateId: props['report_template_id']  as string,
    reportSectionId:  props['report_section_id']   as string,
    data:             null as string | null,
    error:            null as string | null,
  }
}
