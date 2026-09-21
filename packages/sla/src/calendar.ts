/**
 * I CALENDARI DI SERVIZIO DEL CLIENTE (revisione del 14 set 2026 · F6, e
 * verifica «Cosa resta cablato», ondata 2).
 *
 * Le policy SLA e i contratti OLA «in orario lavorativo» contavano i minuti fra
 * le 08:00 e le 18:00, dal lunedì al venerdì, senza festività, per ogni
 * cliente: tre costanti in policy.ts. Poi un calendario per cliente; ora
 * calendari con nome (`ServiceCalendar`), scelti da ogni policy e contratto:
 * i giorni lavorativi, la fascia oraria e le festività.
 *
 * Fail-loud: una policy in orario lavorativo senza calendario non ripiega sulle
 * 08–18 (sarebbe la costante di prima con un altro nome), e la diagnostica lo
 * dice all'admin prima che succeda.
 */
import { getSession } from '@opengraphity/neo4j'

export interface ServiceCalendar {
  /** Giorni lavorativi, 0 = domenica … 6 = sabato. */
  days: number[]
  /** Inizio della fascia, `HH:MM` locale nel fuso della policy. */
  start: string
  /** Fine della fascia, `HH:MM`, dopo l'inizio. */
  end: string
  /** Giorni NON lavorativi, `YYYY-MM-DD` nel calendario locale. */
  holidays: string[]
}

/** Il calendario che il codice usava: il seme della migrazione, non un ripiego. */
export const FACTORY_SERVICE_CALENDAR: ServiceCalendar = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', holidays: [] }

/** Perché un calendario non è valido: un codice stabile, così chi lo mostra lo traduce. */
export type ServiceCalendarProblem = 'not_object' | 'invalid_json' | 'days' | 'time_format' | 'end_before_start' | 'holidays'

export class ServiceCalendarError extends Error {
  constructor(public readonly problem: ServiceCalendarProblem, message: string, public readonly params: Record<string, string> = {}) {
    super(message)
    this.name = 'ServiceCalendarError'
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const YMD  = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

export function minutesOfDay(hhmm: string): number {
  const m = HHMM.exec(hhmm)
  if (!m) throw new ServiceCalendarError('time_format', `Service calendar: "${hhmm}" is not a time in HH:MM format`, { value: hhmm })
  return Number(m[1]) * 60 + Number(m[2])
}

/** Valida e normalizza un calendario (oggetto o JSON). Lancia con un messaggio che dice cosa non va. */
export function parseServiceCalendar(raw: unknown): ServiceCalendar {
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { throw new ServiceCalendarError('invalid_json', 'Service calendar: the stored value is not valid JSON (an object is expected)') }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ServiceCalendarError('not_object', 'Service calendar: an object {days, start, end, holidays} is expected')
  }
  const v = value as Record<string, unknown>
  const days = v['days']
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) {
    throw new ServiceCalendarError('days', 'Service calendar: days must be a non-empty list of week days between 0 (Sunday) and 6 (Saturday)')
  }
  const start = String(v['start'] ?? '')
  const end   = String(v['end'] ?? '')
  const startMin = minutesOfDay(start)
  const endMin   = minutesOfDay(end)
  if (endMin <= startMin) throw new ServiceCalendarError('end_before_start', `Service calendar: the end (${end}) must come after the start (${start})`, { start, end })
  const holidays = v['holidays'] ?? []
  if (!Array.isArray(holidays) || holidays.some((h) => typeof h !== 'string' || !YMD.test(h))) {
    throw new ServiceCalendarError('holidays', 'Service calendar: holidays must be dates in YYYY-MM-DD format')
  }
  return {
    days: [...new Set(days as number[])].sort((a, b) => a - b),
    start, end,
    holidays: [...new Set(holidays as string[])].sort(),
  }
}

/**
 * UN CALENDARIO CON NOME (verifica «Cosa resta cablato», ondata 2). Erano uno
 * per cliente (`Tenant.service_calendar`); ora sono nodi `ServiceCalendar` e
 * ogni policy SLA e ogni contratto OLA/UC sceglie il suo (`calendar_id`), o
 * nessuno per contare 24×7. Un id che non trova il calendario lancia: una
 * policy che punta a un calendario sparito non ripiega sulle 24 ore.
 */
export async function getServiceCalendarById(tenantId: string, calendarId: string): Promise<ServiceCalendar> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) =>
      tx.run(`
        MATCH (c:ServiceCalendar {id: $calendarId, tenant_id: $tenantId})
        RETURN c.days AS days, c.start AS start, c.end AS end, c.holidays AS holidays
      `, { tenantId, calendarId }),
    )
    const row = res.records[0]
    if (!row) throw new Error(`Service calendar ${calendarId} does not exist for tenant ${tenantId}: the SLA policy or OLA/UC contract that points to it cannot compute business-hours deadlines`)
    return parseServiceCalendar({
      days: (row.get('days') as unknown[] | null)?.map((d) => Number(d)) ?? [],
      start: row.get('start'), end: row.get('end'),
      holidays: row.get('holidays') ?? [],
    })
  } finally {
    await session.close()
  }
}

/**
 * Il calendario con cui conta un obiettivo: nessuno se conta 24×7, quello
 * scelto se conta l'orario di servizio. «Orario di servizio» senza calendario è
 * una configurazione incompleta e lancia nominando chi la porta.
 */
export async function calendarFor(
  tenantId: string, owner: { name: string; businessHours: boolean; calendarId: string | null },
): Promise<ServiceCalendar | null> {
  if (!owner.businessHours) return null
  if (!owner.calendarId) {
    throw new Error(`"${owner.name}" counts service hours but has no service calendar: choose one in its settings (tenant ${tenantId})`)
  }
  return getServiceCalendarById(tenantId, owner.calendarId)
}
