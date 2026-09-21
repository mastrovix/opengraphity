/**
 * Ciò che policy SLA e contratti OLA/UC hanno in comune da quando sono
 * configurabili fino in fondo (verifica «Cosa resta cablato», ondata 2):
 *
 *  - il CALENDARIO con cui contano l'orario di servizio (`calendar_id`; nessuno
 *    = 24×7). `business_hours` resta sul nodo, derivato, perché lo SLA lo
 *    registra sul suo stato;
 *  - l'OBIETTIVO DI CONFORMITÀ (`compliance_target`, es. 99,5%) e la SOGLIA
 *    D'ATTENZIONE (`compliance_warning`, es. 97%) con cui il report colora la
 *    percentuale di rispetto. Prima erano 95 e 80, uguali per tutti: un
 *    contratto al 99,5% risultava «verde» al 96%.
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { ValidationError } from './errors.js'
import { assertServiceCalendarExists } from './serviceCalendars.js'

export interface ComplianceObjective { target: number; warning: number }

/** Obiettivo e soglia: percentuali, la soglia sotto l'obiettivo, l'obiettivo al massimo 100. */
export function assertComplianceObjective(target: unknown, warning: unknown): ComplianceObjective {
  const t = Number(target)
  const w = Number(warning)
  if (target == null || !Number.isFinite(t) || t <= 0 || t > 100) {
    throw new ValidationError(`The compliance target must be a percentage above 0 and at most 100 (got ${JSON.stringify(target ?? null)}).`, { key: 'errors.compliance.target' })
  }
  if (warning == null || !Number.isFinite(w) || w <= 0 || w >= t) {
    throw new ValidationError(
      `The attention threshold must be a percentage above 0 and below the target (${String(t)}%) (got ${JSON.stringify(warning ?? null)}).`,
      { key: 'errors.compliance.warning', params: { target: t } },
    )
  }
  return { target: t, warning: w }
}

/**
 * Il calendario scelto: `null` = 24×7; un id deve esistere per il cliente.
 * Ritorna le due proprietà da scrivere insieme.
 */
export async function calendarChoice(tenantId: string, calendarId: unknown): Promise<{ calendar_id: string | null; business_hours: boolean }> {
  if (calendarId == null || calendarId === '') return { calendar_id: null, business_hours: false }
  if (typeof calendarId !== 'string') throw new ValidationError('calendarId must be a calendar id or null (24×7).', { key: 'errors.serviceCalendar.unknown', params: { id: String(calendarId) } })
  await assertServiceCalendarExists(tenantId, calendarId)
  return { calendar_id: calendarId, business_hours: true }
}

/** Il nome del calendario di una policy o di un contratto, per la lettura. */
export async function calendarNameOf(tenantId: string, calendarId: string | null): Promise<string | null> {
  if (!calendarId) return null
  const session = getSession()
  try {
    const row = await runQueryOne<{ name: string }>(session, 'MATCH (c:ServiceCalendar {id: $id, tenant_id: $tenantId}) RETURN c.name AS name', { id: calendarId, tenantId })
    return row?.name ?? null
  } finally {
    await session.close()
  }
}
