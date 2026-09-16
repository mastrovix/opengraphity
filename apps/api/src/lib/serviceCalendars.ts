/**
 * I CALENDARI DI SERVIZIO CON NOME — la porta dall'interfaccia (verifica «Cosa
 * resta cablato», ondata 2).
 *
 * Prima c'era un solo calendario per organizzazione (`Tenant.service_calendar`,
 * revisione del 14 set 2026 · F6): una policy o un contratto poteva scegliere
 * solo fra 24×7 e quel calendario, e un team di turno o un fornitore con orari
 * suoi non si modellava. Ora sono nodi `ServiceCalendar {id, name, days, start,
 * end, holidays}`, e ogni policy SLA e ogni contratto OLA/UC sceglie il suo
 * (`calendar_id`). Il calcolo resta in packages/sla/src/calendar.ts.
 *
 * Un calendario in uso non si elimina: il rifiuto nomina chi lo usa, perché
 * togliergli il calendario lascerebbe quelle scadenze senza modo di calcolarsi.
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { ServiceCalendarError, parseServiceCalendar, type ServiceCalendar } from '@opengraphity/sla'
import { NotFoundError, ValidationError } from './errors.js'

export const SERVICE_CALENDAR_NAME_MAX = 80

export interface NamedServiceCalendar extends ServiceCalendar {
  id:   string
  name: string
  /** Chi lo usa: i nomi delle policy SLA e dei contratti OLA/UC che lo scelgono. */
  usedBySlaPolicies:  string[]
  usedByOlaContracts: string[]
  /** Le scadenze dei passi di workflow che contano con questo calendario («Workflow · Passo»). */
  usedByWorkflowSteps: string[]
}

function toCalendar(input: unknown): ServiceCalendar {
  try {
    return parseServiceCalendar(input)
  } catch (err) {
    if (err instanceof ServiceCalendarError) {
      throw new ValidationError(err.message, { key: `errors.tenant.serviceCalendar.${err.problem}`, params: err.params })
    }
    throw err
  }
}

function assertName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (n === '' || n.length > SERVICE_CALENDAR_NAME_MAX) {
    throw new ValidationError(
      `A service calendar needs a name of at most ${String(SERVICE_CALENDAR_NAME_MAX)} characters.`,
      { key: 'errors.serviceCalendar.name', params: { max: SERVICE_CALENDAR_NAME_MAX } },
    )
  }
  return n
}

const READ_CYPHER = `
  MATCH (c:ServiceCalendar {tenant_id: $tenantId})
  OPTIONAL MATCH (p:SLAPolicyNode {tenant_id: $tenantId, calendar_id: c.id})
  WITH c, collect(DISTINCT p.name) AS policies
  OPTIONAL MATCH (o:OLAContract {tenant_id: $tenantId, calendar_id: c.id})
  WITH c, policies, collect(DISTINCT o.name) AS contracts
  // «Usato dai passi» guarda la SCADENZA, non solo la proprietà di comodo
  // (revisione totale · C-35): deadline_calendar_id la scrive solo il
  // disegnatore, quindi una scadenza arrivata da un seed o da una migrazione
  // non impediva di cancellare il calendario — e la passata delle scadenze
  // finiva «failed» ogni ora. Gli id dei calendari sono UUID: la scadenza che
  // li cita li contiene per intero.
  OPTIONAL MATCH (wd:WorkflowDefinition {tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep)
    WHERE s.deadline_calendar_id = c.id OR (s.deadline IS NOT NULL AND s.deadline CONTAINS c.id)
  RETURN c.id AS id, c.name AS name, c.days AS days, c.start AS start, c.end AS end, c.holidays AS holidays,
         policies, contracts, collect(DISTINCT wd.name + ' · ' + coalesce(s.label, s.name)) AS steps
  ORDER BY toLower(c.name)
`

function mapRow(r: Record<string, unknown>): NamedServiceCalendar {
  const calendar = parseServiceCalendar({
    days: ((r['days'] ?? []) as unknown[]).map((d) => Number(d)), start: r['start'], end: r['end'], holidays: r['holidays'] ?? [],
  })
  return {
    id: r['id'] as string, name: r['name'] as string, ...calendar,
    usedBySlaPolicies:  ((r['policies'] ?? []) as string[]).filter(Boolean).sort(),
    usedByOlaContracts: ((r['contracts'] ?? []) as string[]).filter(Boolean).sort(),
    usedByWorkflowSteps: ((r['steps'] ?? []) as string[]).filter(Boolean).sort(),
  }
}

export async function serviceCalendars(tenantId: string): Promise<NamedServiceCalendar[]> {
  const session = getSession()
  try {
    const rows = await runQuery<Record<string, unknown>>(session, READ_CYPHER, { tenantId })
    return rows.map(mapRow)
  } finally {
    await session.close()
  }
}

async function assertUniqueName(tenantId: string, name: string, exceptId: string | null): Promise<void> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (c:ServiceCalendar {tenant_id: $tenantId}) WHERE toLower(c.name) = toLower($name) AND ($exceptId IS NULL OR c.id <> $exceptId)
      RETURN c.id AS id LIMIT 1
    `, { tenantId, name, exceptId })
    if (row) throw new ValidationError(`A service calendar named "${name}" already exists.`, { key: 'errors.serviceCalendar.duplicateName', params: { name } })
  } finally {
    await session.close()
  }
}

export async function createServiceCalendar(tenantId: string, input: { name: unknown; calendar: unknown }): Promise<NamedServiceCalendar> {
  const name = assertName(input.name)
  const calendar = toCalendar(input.calendar)
  await assertUniqueName(tenantId, name, null)
  const id = uuidv4()
  const session = getSession(undefined, 'WRITE')
  try {
    await runQuery(session, `
      CREATE (c:ServiceCalendar {id: $id, tenant_id: $tenantId, name: $name, days: $days, start: $start, end: $end, holidays: $holidays, created_at: $now, updated_at: $now})
    `, { id, tenantId, name, ...calendar, now: new Date().toISOString() })
  } finally {
    await session.close()
  }
  return { id, name, ...calendar, usedBySlaPolicies: [], usedByOlaContracts: [], usedByWorkflowSteps: [] }
}

export async function updateServiceCalendar(tenantId: string, id: string, input: { name?: unknown; calendar?: unknown }): Promise<NamedServiceCalendar> {
  const sets: Record<string, unknown> = {}
  if (input.name !== undefined) {
    sets['name'] = assertName(input.name)
    await assertUniqueName(tenantId, sets['name'] as string, id)
  }
  if (input.calendar !== undefined) Object.assign(sets, toCalendar(input.calendar))
  if (Object.keys(sets).length === 0) throw new ValidationError('updateServiceCalendar: no field to update', { key: 'errors.nothingToUpdate' })
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (c:ServiceCalendar {id: $id, tenant_id: $tenantId})
      SET c += $sets, c.updated_at = $now
      RETURN c.id AS id
    `, { id, tenantId, sets, now: new Date().toISOString() })
    if (!row) throw new NotFoundError('ServiceCalendar', id)
  } finally {
    await session.close()
  }
  const out = (await serviceCalendars(tenantId)).find((c) => c.id === id)
  if (!out) throw new NotFoundError('ServiceCalendar', id)
  return out
}

export async function deleteServiceCalendar(tenantId: string, id: string): Promise<void> {
  const current = (await serviceCalendars(tenantId)).find((c) => c.id === id)
  if (!current) throw new NotFoundError('ServiceCalendar', id)
  const users = [...current.usedBySlaPolicies, ...current.usedByOlaContracts, ...current.usedByWorkflowSteps]
  if (users.length > 0) {
    throw new ValidationError(
      `The service calendar "${current.name}" is used by ${users.join(', ')}: choose another calendar for them first.`,
      { key: 'errors.serviceCalendar.inUse', params: { name: current.name, users: users.join(', ') } },
    )
  }
  const session = getSession(undefined, 'WRITE')
  try {
    await runQuery(session, 'MATCH (c:ServiceCalendar {id: $id, tenant_id: $tenantId}) DELETE c', { id, tenantId })
  } finally {
    await session.close()
  }
}

/**
 * Vero se il calendario esiste per il cliente: la scrittura di una policy o di
 * un contratto lo verifica, invece di salvare un id che il motore non trova.
 */
export async function assertServiceCalendarExists(tenantId: string, calendarId: string): Promise<void> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ id: string }>(session, 'MATCH (c:ServiceCalendar {id: $id, tenant_id: $tenantId}) RETURN c.id AS id', { id: calendarId, tenantId })
    if (!row) throw new ValidationError(`Service calendar ${calendarId} does not exist.`, { key: 'errors.serviceCalendar.unknown', params: { id: calendarId } })
  } finally {
    await session.close()
  }
}

/**
 * Policy SLA e contratti OLA/UC che contano l'orario di servizio senza un
 * calendario valido (nessuno scelto, o uno sparito): il motore non sa calcolare
 * le loro scadenze. Per la diagnostica.
 */
export async function businessHoursWithoutCalendar(tenantId: string): Promise<string[]> {
  const session = getSession()
  try {
    const rows = await runQuery<{ name: string }>(session, `
      CALL {
        MATCH (p:SLAPolicyNode {tenant_id: $tenantId}) WHERE p.business_hours = true AND coalesce(p.enabled, true) = true
          AND (p.calendar_id IS NULL OR NOT EXISTS { MATCH (c:ServiceCalendar {id: p.calendar_id, tenant_id: $tenantId}) })
        RETURN p.name AS name
        UNION ALL
        MATCH (o:OLAContract {tenant_id: $tenantId}) WHERE o.business_hours = true AND coalesce(o.enabled, true) = true
          AND (o.calendar_id IS NULL OR NOT EXISTS { MATCH (c:ServiceCalendar {id: o.calendar_id, tenant_id: $tenantId}) })
        RETURN o.name AS name
      }
      RETURN name ORDER BY name
    `, { tenantId })
    return rows.map((r) => r.name)
  } finally {
    await session.close()
  }
}
