/**
 * IL NOME DELL'ORGANIZZAZIONE, dalla pagina Organizzazione (verifica «Cosa resta
 * cablato», ondata 6). Prima si scriveva solo con `onboard-tenant.ts` o con una
 * migrazione. Piano, limiti e creazione restano all'operatore della piattaforma
 * (F11, rinviato).
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { NotFoundError, ValidationError } from './errors.js'
import { invalidateSchema } from './schemaInvalidator.js'

export const TENANT_NAME_MAX_LENGTH = 120

export function assertTenantName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name.length === 0 || name.length > TENANT_NAME_MAX_LENGTH) {
    throw new ValidationError(`The organization name must be 1–${String(TENANT_NAME_MAX_LENGTH)} characters.`,
      { key: 'errors.tenant.name', params: { max: TENANT_NAME_MAX_LENGTH } })
  }
  return name
}

export async function tenantName(tenantId: string): Promise<string> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ name: unknown }>(session, 'MATCH (t:Tenant {id: $tenantId}) RETURN t.name AS name', { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    return String(row.name ?? tenantId)
  } finally {
    await session.close()
  }
}

export async function setTenantName(tenantId: string, raw: unknown): Promise<string> {
  const name = assertTenantName(raw)
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session,
      'MATCH (t:Tenant {id: $tenantId}) SET t.name = $name, t.updated_at = $now RETURN t.id AS id',
      { tenantId, name, now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
  invalidateSchema(tenantId)
  return name
}
