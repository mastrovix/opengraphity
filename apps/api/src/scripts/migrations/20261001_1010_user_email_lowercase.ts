/**
 * Revisione totale del 16 set 2026 · A-3: l'e-mail di una persona si scrive
 * minuscola, perché Keycloak la dà minuscola nel token e l'autenticazione la
 * cerca con un confronto esatto sull'indice (tenant_id, email). Prima una
 * persona creata come «Mario.Rossi@Acme.com» non entrava («user not found»).
 * Due persone dello stesso tenant che differiscono solo per le maiuscole non si
 * uniscono in silenzio: la migrazione fallisce nominandole.
 * Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const userEmailLowercase: Migration = {
  id:          '20261001_1010_user_email_lowercase',
  description: 'E-mail delle persone in minuscolo (autenticazione con confronto esatto)',

  async up(session) {
    const clashes = await session.run(`
      MATCH (u:User) WHERE u.email IS NOT NULL
      WITH u.tenant_id AS tenantId, toLower(u.email) AS email, collect(u.id) AS ids
      WHERE size(ids) > 1
      RETURN tenantId, email, ids`)
    if (clashes.records.length > 0) {
      const list = clashes.records.map((r) => `${String(r.get('tenantId'))}: ${String(r.get('email'))} (${(r.get('ids') as string[]).join(', ')})`)
      throw new Error(`Persons that differ only by upper/lower case in the e-mail — merge or rename them first: ${list.join('; ')}`)
    }
    const res = await session.run(`
      MATCH (u:User) WHERE u.email IS NOT NULL AND u.email <> toLower(u.email)
      SET u.email = toLower(u.email)
      RETURN count(u) AS n`)
    console.log(`[${userEmailLowercase.id}] e-mail portate in minuscolo: ${String(res.records[0]?.get('n'))}`)
  },
}
