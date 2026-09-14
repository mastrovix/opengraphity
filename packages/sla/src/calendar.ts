/**
 * IL CALENDARIO DI SERVIZIO DEL CLIENTE (revisione del 14 set 2026 · F6).
 *
 * Le policy SLA e i contratti OLA «in orario lavorativo» contavano i minuti fra
 * le 08:00 e le 18:00, dal lunedì al venerdì, senza festività, per ogni
 * cliente: tre costanti in policy.ts. Ora l'orario è `Tenant.service_calendar`,
 * che il cliente sceglie dalla pagina Organizzazione: i giorni lavorativi, la
 * fascia oraria e le festività.
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

/** Il calendario del cliente, o `null` se non l'ha configurato. Un valore corrotto lancia. */
export async function getServiceCalendar(tenantId: string): Promise<ServiceCalendar | null> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) =>
      tx.run('MATCH (t:Tenant {id: $tenantId}) RETURN t.service_calendar AS calendar', { tenantId }),
    )
    const raw = res.records[0]?.get('calendar') as unknown
    if (raw == null || raw === '') return null
    return parseServiceCalendar(raw)
  } finally {
    await session.close()
  }
}
