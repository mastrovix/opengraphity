/**
 * Personalizzazioni, ondata 0 (B0-4 / C-4, parte già attiva) — il vocabolario
 * del ciclo di vita del CI non conosceva stati che i CI hanno davvero.
 *
 * Dal vivo su c-one: 49 CI `expired` e 19 `revoked` (certificati), assenti da
 * `CI_LIFECYCLE_STATUSES`, dall'enum `ci_status` e dagli `enum_values` inline
 * del campo `status` di `__base__` (che aveva solo active/inactive/maintenance:
 * mancava anche `decommissioned`, cioè il valore che la policy degli allarmi
 * ignora per default non era assegnabile da nessuna interfaccia).
 *
 * Questa migrazione allinea SOLO i vocabolari, e non tocca la semantica (quali
 * stati contano come ritirati o in manutenzione: `CI_LIFECYCLE_RETIRED`,
 * `CI_LIFECYCLE_MAINTENANCE`, la policy, il motore delle mappe). Nessun
 * `ci.status` viene riscritto: i CI restano come sono.
 *
 *  (a) Per ogni `EnumTypeDefinition {name: 'ci_status'}` di ogni tenant:
 *      i valori mancanti fra quelli del codice (CI_LIFECYCLE_STATUSES) e quelli
 *      DAVVERO presenti sui CI di quel tenant vengono aggiunti in coda. I
 *      valori che il cliente ha aggiunto o rinominato non si toccano: si
 *      aggiunge, non si riscrive (il re-seed che sovrascrive è C-5, altra
 *      ondata). Un valore che arriva dal dato e non è nel vocabolario del
 *      codice finisce nel log, nominato: la deriva resta visibile.
 *  (b) Per ogni `__base__`, il campo `status`: `enum_values` (JSON string)
 *      diventa l'unione con CI_LIFECYCLE_STATUSES. Qui NON entrano i valori
 *      trovati sui CI di un tenant: `__base__` è condiviso, e ci finirebbe il
 *      dato di un cliente nei form di un altro.
 *
 * Idempotente: alla seconda esecuzione non manca più nulla e non scrive.
 */
import type { Migration } from '@opengraphity/neo4j'
import { CI_LIFECYCLE_STATUSES } from '../../lib/eventVocabularies.js'

/** `values` di un enum: lista nativa o JSON serializzato. Corrotto = STOP. */
function parseValues(raw: unknown, what: string): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    if (raw.some((v) => typeof v !== 'string')) throw new Error(`${what} is not a list of strings (got ${JSON.stringify(raw)}); fix it before migrating`)
    return raw as string[]
  }
  if (typeof raw === 'string') {
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch (e) { throw new Error(`${what} is corrupt JSON (${e instanceof Error ? e.message : String(e)}); fix it before migrating`) }
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) throw new Error(`${what} is not a JSON list of strings; fix it before migrating`)
    return parsed as string[]
  }
  throw new Error(`${what} has unexpected type ${typeof raw}; fix it before migrating`)
}

/** Valori mancanti, nell'ordine in cui arrivano, senza doppioni. */
function missing(current: readonly string[], wanted: readonly string[]): string[] {
  const have = new Set(current)
  const out: string[] = []
  for (const v of wanted) if (!have.has(v) && !out.includes(v)) out.push(v)
  return out
}

export const ciStatusVocabulary: Migration = {
  id: '20260912_1210_ci_status_vocabulary',
  description: 'Personalizzazioni (ondata 0, B0-4): align the CI lifecycle vocabulary to the data — add the missing values (expired/revoked/decommissioned) to every tenant ci_status enum and to the __base__ status field',
  async up(session) {
    const now = new Date().toISOString()
    const log: string[] = []

    // (a) Enum `ci_status`, per tenant.
    const enums = await session.run(`
      MATCH (e:EnumTypeDefinition {name: 'ci_status'})
      WHERE e.tenant_id IS NOT NULL
      RETURN e.id AS id, e.tenant_id AS tenantId, e.values AS values
      ORDER BY e.tenant_id
    `)

    let enumsUpdated = 0
    for (const record of enums.records) {
      const id       = String(record.get('id'))
      const tenantId = String(record.get('tenantId'))
      const current  = parseValues(record.get('values'), `EnumTypeDefinition ci_status (${tenantId}).values`)

      // Stati davvero presenti sui CI di QUESTO tenant.
      const live = await session.run(`
        MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
        WHERE ci.status IS NOT NULL
        RETURN DISTINCT ci.status AS status
        ORDER BY status
      `, { tenantId })
      const fromData = live.records
        .map((r) => r.get('status'))
        .filter((s): s is string => typeof s === 'string' && s !== '')

      const toAdd = missing(current, [...CI_LIFECYCLE_STATUSES, ...fromData])
      if (toAdd.length === 0) continue

      const unknownToCode = toAdd.filter((v) => !(CI_LIFECYCLE_STATUSES as readonly string[]).includes(v))
      log.push(
        `ci_status (${tenantId}): +[${toAdd.join(', ')}]` +
        (unknownToCode.length ? ` — ATTENZIONE: [${unknownToCode.join(', ')}] arrivano dai CI e non sono nel vocabolario del codice` : ''),
      )

      await session.run(`
        MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
        SET e.values = $values, e.updated_at = $now
      `, { id, tenantId, values: [...current, ...toAdd], now })
      enumsUpdated++
    }

    // (b) Campo `status` di `__base__` (enum_values inline, JSON string).
    const baseFields = await session.run(`
      MATCH (t:CITypeDefinition {name: '__base__'})-[:HAS_FIELD]->(f:CIFieldDefinition {name: 'status'})
      RETURN f.id AS id, t.tenant_id AS tenantId, f.enum_values AS values
      ORDER BY t.tenant_id
    `)

    let fieldsUpdated = 0
    for (const record of baseFields.records) {
      const id       = String(record.get('id'))
      const tenantId = String(record.get('tenantId'))
      const current  = parseValues(record.get('values'), `__base__.status (${tenantId}).enum_values`)
      const toAdd    = missing(current, CI_LIFECYCLE_STATUSES)
      if (toAdd.length === 0) continue

      log.push(`__base__.status (${tenantId}): +[${toAdd.join(', ')}]`)
      await session.run(`
        MATCH (f:CIFieldDefinition {id: $id})
        SET f.enum_values = $values
      `, { id, values: JSON.stringify([...current, ...toAdd]) })
      fieldsUpdated++
    }

    console.log(
      `[${ciStatusVocabulary.id}] enum ci_status aggiornati ${enumsUpdated}/${enums.records.length}, ` +
      `campo __base__.status aggiornato ${fieldsUpdated}/${baseFields.records.length}` +
      (log.length ? `\n  ${log.join('\n  ')}` : ' — nulla da aggiungere'),
    )
  },
}
