/**
 * Revisione del 14 set 2026 · F15: `tenant_id` sui nodi figli di report e
 * dashboard (`ReportSection`, `ReportNode`, `DashboardWidget`).
 *
 * Nascevano senza: erano raggiunti solo attraverso il padre (che ce l'ha), ma
 * una lettura futura per id li avrebbe trovati in qualunque tenant. Da ora il
 * codice lo scrive alla creazione; qui si copia dal padre sui nodi esistenti.
 * I figli senza padre — irraggiungibili da qualunque pagina — si tolgono, e si
 * dice quanti. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const reportDashboardChildrenTenant: Migration = {
  id: '20260923_1070_report_dashboard_children_tenant',
  description: 'tenant_id copiato dal padre su ReportSection, ReportNode e DashboardWidget; i figli senza padre rimossi',
  async up(session) {
    const steps: Array<[string, string]> = [
      ['ReportSection dal ReportTemplate', `
        MATCH (r:ReportTemplate)-[:HAS_SECTION]->(s:ReportSection) WHERE s.tenant_id IS NULL AND r.tenant_id IS NOT NULL
        SET s.tenant_id = r.tenant_id RETURN count(s) AS n`],
      ['ReportNode dalla ReportSection', `
        MATCH (s:ReportSection)-[:HAS_NODE]->(n:ReportNode) WHERE n.tenant_id IS NULL AND s.tenant_id IS NOT NULL
        SET n.tenant_id = s.tenant_id RETURN count(n) AS n`],
      ['DashboardWidget dalla DashboardConfig', `
        MATCH (d:DashboardConfig)-[:HAS_WIDGET]->(w:DashboardWidget) WHERE w.tenant_id IS NULL AND d.tenant_id IS NOT NULL
        SET w.tenant_id = d.tenant_id RETURN count(w) AS n`],
      ['ReportNode senza sezione (rimossi)', `
        MATCH (n:ReportNode) WHERE n.tenant_id IS NULL AND NOT ()-[:HAS_NODE]->(n)
        WITH collect(n) AS ns FOREACH (x IN ns | DETACH DELETE x) RETURN size(ns) AS n`],
      ['ReportSection senza report (rimosse)', `
        MATCH (s:ReportSection) WHERE s.tenant_id IS NULL AND NOT ()-[:HAS_SECTION]->(s)
        WITH collect(s) AS ss FOREACH (x IN ss | DETACH DELETE x) RETURN size(ss) AS n`],
      ['DashboardWidget senza dashboard (rimossi)', `
        MATCH (w:DashboardWidget) WHERE w.tenant_id IS NULL AND NOT ()-[:HAS_WIDGET]->(w)
        WITH collect(w) AS ws FOREACH (x IN ws | DETACH DELETE x) RETURN size(ws) AS n`],
    ]
    for (const [what, cypher] of steps) {
      const r = await session.run(cypher)
      console.log(`[${reportDashboardChildrenTenant.id}] ${what}: ${String(r.records[0]?.get('n') ?? 0)}`)
    }
  },
}
