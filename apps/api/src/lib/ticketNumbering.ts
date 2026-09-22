/**
 * LA NUMERAZIONE DEI TICKET, scelta del cliente (verifica «Cosa resta cablato»,
 * ondata 6).
 *
 * ## Il difetto
 * `'INC' + padStart(8)`, `'PRB'…`, `'CHG'…`, `'REQ'…` erano scritti in quattro
 * servizi, uguali per tutti: chi migra da un altro strumento non poteva tenere
 * la propria numerazione (`TKT-000123`).
 *
 * ## La regola
 * `Tenant.ticket_numbering` = `{incident: {prefix, digits}, …}`. Vale solo per i
 * ticket NUOVI: i numeri già scritti non cambiano, e il contatore
 * (`lib/sequence.ts`) resta del prodotto e prosegue. Un prefisso non può essere
 * uguale — né l'inizio — di quello di un altro tipo, e non può essere già usato
 * dai numeri esistenti di un altro tipo: due ticket di tipi diversi con lo
 * stesso numero sarebbero indistinguibili in una ricerca o in un'e-mail.
 *
 * La proprietà assente è il formato di fabbrica (INC/PRB/CHG/REQ, 8 cifre), e
 * la migrazione `20260927_1000_ticket_numbering` la scrive esplicita.
 */
import { getSession, runQuery } from '@opengraphity/neo4j'
import { ValidationError } from './errors.js'
import { createMetamodelCache } from './metamodelCache.js'
import { invalidateSchema } from './schemaInvalidator.js'
import { nextSequenceValue, type SessionOrTx } from './sequence.js'

export const TICKET_NUMBER_KINDS = ['incident', 'problem', 'change', 'service_request'] as const
export type TicketNumberKind = (typeof TICKET_NUMBER_KINDS)[number]

export interface TicketNumberFormat { prefix: string; digits: number }
export type TicketNumbering = Record<TicketNumberKind, TicketNumberFormat>

export const FACTORY_TICKET_NUMBERING: Readonly<TicketNumbering> = {
  incident:        { prefix: 'INC', digits: 8 },
  problem:         { prefix: 'PRB', digits: 8 },
  change:          { prefix: 'CHG', digits: 8 },
  service_request: { prefix: 'REQ', digits: 8 },
}

/** Lettere maiuscole e cifre, eventualmente un trattino finale (`TKT-`); inizia con una lettera. */
export const TICKET_PREFIX_RE = /^[A-Z][A-Z0-9]{0,7}-?$/
export const MIN_TICKET_DIGITS = 3
export const MAX_TICKET_DIGITS = 12

const LABELS: Record<TicketNumberKind, string> = { incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'ServiceRequest' }

const cache = createMetamodelCache<TicketNumbering & { isDefault: boolean }>({
  name: 'ticket-numbering',
  load: (tenantId) => loadNumbering(tenantId),
})

/** Solo per i test. */
export function clearTicketNumberingCache(): void { cache.clear() }

export function ticketNumbering(tenantId: string): Promise<TicketNumbering & { isDefault: boolean }> {
  return cache.get(tenantId)
}

export function formatTicketNumber(format: TicketNumberFormat, sequence: number): string {
  return format.prefix + String(sequence).padStart(format.digits, '0')
}

/** Il prossimo numero di un ticket nuovo: contatore del prodotto, formato del cliente. */
export async function nextTicketNumber(sessionOrTx: SessionOrTx, tenantId: string, kind: TicketNumberKind): Promise<string> {
  const format = (await ticketNumbering(tenantId))[kind]
  return formatTicketNumber(format, await nextSequenceValue(sessionOrTx, tenantId, kind))
}

function fail(message: string, key: string, params: Record<string, string | number>): never {
  throw new ValidationError(message, { key: `errors.ticketNumbering.${key}`, params })
}

/** Forma e coerenza di un formato completo; non guarda i dati (vedi `setTicketNumbering`). */
export function assertTicketNumbering(raw: unknown): TicketNumbering {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('The ticket numbering must be an object per ticket type', 'shape', {})
  const obj = raw as Record<string, unknown>
  const out = {} as TicketNumbering
  for (const kind of TICKET_NUMBER_KINDS) {
    const f = (obj[kind] ?? null) as Record<string, unknown> | null
    if (!f || typeof f !== 'object') fail(`Numbering of ${kind} is missing`, 'shape', { entityType: kind })
    const prefix = f['prefix']
    const digits = f['digits']
    if (typeof prefix !== 'string' || !TICKET_PREFIX_RE.test(prefix)) {
      fail(`Prefix of ${kind} "${String(prefix)}": 1–8 capital letters or digits, starting with a letter, optionally ending with "-"`, 'prefix', { entityType: kind, prefix: String(prefix) })
    }
    if (typeof digits !== 'number' || !Number.isInteger(digits) || digits < MIN_TICKET_DIGITS || digits > MAX_TICKET_DIGITS) {
      fail(`Digits of ${kind} must be an integer between ${String(MIN_TICKET_DIGITS)} and ${String(MAX_TICKET_DIGITS)}`, 'digits', { entityType: kind, min: MIN_TICKET_DIGITS, max: MAX_TICKET_DIGITS })
    }
    out[kind] = { prefix, digits }
  }
  for (const a of TICKET_NUMBER_KINDS) {
    for (const b of TICKET_NUMBER_KINDS) {
      if (a >= b) continue
      const pa = out[a].prefix, pb = out[b].prefix
      if (pa.startsWith(pb) || pb.startsWith(pa)) {
        fail(`The prefixes of ${a} (${pa}) and ${b} (${pb}) overlap: numbers of the two types could not be told apart`, 'prefixOverlap', { a, b, prefixA: pa, prefixB: pb })
      }
    }
  }
  return out
}

async function loadNumbering(tenantId: string): Promise<TicketNumbering & { isDefault: boolean }> {
  const session = getSession()
  try {
    const rows = await runQuery<{ raw: unknown }>(session, 'MATCH (t:Tenant {id: $tenantId}) RETURN t.ticket_numbering AS raw', { tenantId })
    if (!rows.length) throw new Error(`Tenant ${tenantId} does not exist: the ticket numbering cannot be determined`)
    const raw = rows[0]!.raw
    if (raw == null) return { ...FACTORY_TICKET_NUMBERING, isDefault: true }
    let parsed: unknown
    try { parsed = JSON.parse(String(raw)) }
    catch (e) { throw new Error(`Tenant ${tenantId}: ticket_numbering is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e }) }
    return { ...assertTicketNumbering(parsed), isDefault: false }
  } finally {
    await session.close()
  }
}

/** Escape per una regex Cypher: il prefisso è già validato, ma il trattino va lasciato letterale. */
const cypherRegexPrefix = (prefix: string) => prefix.replace(/-/g, '\\-')

export async function setTicketNumbering(tenantId: string, input: unknown): Promise<TicketNumbering & { isDefault: boolean }> {
  const numbering = assertTicketNumbering(input)
  const session = getSession(undefined, 'WRITE')
  try {
    // Un prefisso già usato dai numeri ESISTENTI di un altro tipo: i vecchi
    // ticket di quel tipo e i nuovi di questo si confonderebbero.
    for (const kind of TICKET_NUMBER_KINDS) {
      for (const other of TICKET_NUMBER_KINDS) {
        if (other === kind) continue
        const rows = await runQuery<{ number: string }>(session, `
          MATCH (n:${LABELS[other]} {tenant_id: $tenantId})
          WHERE n.number =~ $re
          RETURN n.number AS number LIMIT 1
        `, { tenantId, re: `${cypherRegexPrefix(numbering[kind].prefix)}[0-9]+` })
        if (rows.length) {
          fail(`The prefix ${numbering[kind].prefix} is already used by ${other} numbers (e.g. ${rows[0]!.number})`, 'prefixInUse',
            { entityType: kind, prefix: numbering[kind].prefix, other, example: rows[0]!.number })
        }
      }
    }
    const res = await runQuery<{ id: string }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      SET t.ticket_numbering = $json, t.updated_at = $now
      RETURN t.id AS id
    `, { tenantId, json: JSON.stringify(numbering), now: new Date().toISOString() })
    if (!res.length) throw new ValidationError(`Tenant ${tenantId} does not exist`, { key: 'errors.notFound', params: { entity: 'Tenant', id: tenantId } })
  } finally {
    await session.close()
  }
  invalidateSchema(tenantId)
  return { ...numbering, isDefault: false }
}
