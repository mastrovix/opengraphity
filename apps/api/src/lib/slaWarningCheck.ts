/**
 * Le policy SLA il cui preavviso non cade prima della scadenza (giro nel browser
 * del 14 set 2026).
 *
 * Il resolver lo rifiuta alla scrittura (`assertWarningMinutes`), ma una
 * migrazione precedente aveva messo il preavviso a 30 minuti su TUTTE le policy,
 * anche su quelle da 30 minuti di risoluzione: l'avviso «SLA about to be
 * breached» partiva alla creazione di ogni ticket. I dati già scritti li dice la
 * diagnostica, con i nomi; si correggono dalla pagina delle policy.
 */
import type { Session } from 'neo4j-driver'
import { runQuery, toNumber } from '@opengraphity/neo4j'

export interface SlaWarningProblem { name: string; warningMinutes: number; resolveMinutes: number }

export async function slaPoliciesWarningNotBeforeDeadline(session: Session, tenantId: string): Promise<SlaWarningProblem[]> {
  const rows = await runQuery<{ name: string; warning: unknown; resolve: unknown }>(session, `
    MATCH (p:SLAPolicyNode {tenant_id: $tenantId})
    WHERE coalesce(p.enabled, true) AND p.warning_minutes IS NOT NULL AND p.resolve_minutes IS NOT NULL
      AND p.warning_minutes >= p.resolve_minutes
    RETURN p.name AS name, p.warning_minutes AS warning, p.resolve_minutes AS resolve
    ORDER BY name
  `, { tenantId })
  return rows.map((r) => ({ name: r.name, warningMinutes: toNumber(r.warning), resolveMinutes: toNumber(r.resolve) }))
}
