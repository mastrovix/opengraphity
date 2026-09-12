/**
 * Personalizzazioni, ondata 1 (A-2 / C-6) — i vocabolari spediti col prodotto
 * diventano di sistema, e i campi condivisi si riagganciano a quelli.
 *
 * **Il difetto, misurato dal vivo il 12 set 2026**: i vocabolari spediti non
 * esistevano come nodi di sistema. `seedEnumTypes.ts` ne scriveva una COPIA per
 * ogni tenant (`MERGE (e {name, tenant_id: $tenantId})`, `is_system = true`), e
 * `seed-itil-metamodel.ts` agganciava i campi con
 * `MATCH (e:EnumTypeDefinition {name: $enumName})` — «pick any available
 * instance». Risultato: **30 campi condivisi** (`f.tenant_id = 'system'`,
 * scope `base`/`itil`) agganciati ai **15** vocabolari di `c-one`. Ogni altro
 * cliente, nella pagina Policy e nell'editor dei CI, vedeva e assegnava i
 * valori di c-one — e non vedeva nemmeno i propri `enum_values` inline, perché
 * l'enum agganciato vince.
 *
 * **Cosa fa questa migrazione**
 *  (a) `MERGE` il nodo di sistema di ogni vocabolario spedito (`SYSTEM_ENUMS`
 *      in lib/seedEnumTypes.ts, fonte unica) con i valori del seed.
 *  (b) Ri-aggancia ogni `USES_ENUM` che parte da un campo CONDIVISO
 *      (`f.tenant_id = 'system'` oppure `f.scope IN ['base','itil']`) al
 *      vocabolario di sistema con lo STESSO nome.
 *  (c) Se per un nome agganciato non esiste il vocabolario di sistema si
 *      **ferma e lo dice**: togliere il legame al buio farebbe perdere al campo
 *      i suoi valori.
 *  (d) **Non tocca** i vocabolari dei tenant: restano, e diventano le loro
 *      personalizzazioni (`loadTenantEnumOverrides` fa vincere quello del
 *      tenant per chi lo possiede, e solo per lui). È così che `c-one`
 *      conserva `expired`/`revoked` nel suo `ci_status`.
 *
 * Idempotente: alla seconda esecuzione i nodi ci sono già e non c'è più nessun
 * legame da spostare.
 */
import type { Migration } from '@opengraphity/neo4j'
import { SYSTEM_ENUMS } from '../../lib/seedEnumTypes.js'
import { SYSTEM_TENANT, SHARED_FIELD_SCOPES } from '../../lib/enumScope.js'

export const systemEnumTypes: Migration = {
  id: '20260913_1300_system_enum_types',
  description: 'Personalizzazioni (ondata 1, A-2/C-6): seed the shipped enum vocabularies on tenant_id=\'system\' and re-point every USES_ENUM of a shared field to the system vocabulary with the same name',
  async up(session) {
    const now = new Date().toISOString()

    // (a) I nodi di sistema dei vocabolari spediti.
    let created = 0
    for (const e of SYSTEM_ENUMS) {
      const r = await session.run(`
        MERGE (e:EnumTypeDefinition {name: $name, tenant_id: $systemTenant})
        ON CREATE SET
          e.id         = randomUUID(),
          e.label      = $label,
          e.values     = $values,
          e.is_system  = true,
          e.scope      = $scope,
          e.created_at = $now,
          e.updated_at = $now
        ON MATCH SET
          e.values     = $values,
          e.updated_at = $now
        RETURN e.created_at = $now AS wasCreated
      `, { name: e.name, systemTenant: SYSTEM_TENANT, label: e.label, values: [...e.values], scope: e.scope, now })
      if (r.records[0]?.get('wasCreated') === true) created++
    }

    // (b/c) I legami dei campi condivisi.
    const links = await session.run(`
      MATCH (f:CIFieldDefinition)-[:USES_ENUM]->(e:EnumTypeDefinition)
      WHERE f.tenant_id = $systemTenant OR f.scope IN $sharedScopes
      RETURN f.id AS fieldId, f.name AS fieldName, f.tenant_id AS fieldTenantId,
             e.id AS enumId, e.name AS enumName, e.tenant_id AS enumTenantId
      ORDER BY e.name, f.name
    `, { systemTenant: SYSTEM_TENANT, sharedScopes: [...SHARED_FIELD_SCOPES] })

    const alreadyOk: string[] = []
    const toMove: Array<{ fieldId: string; fieldName: string; enumName: string; fromTenant: string }> = []
    const orphanNames = new Set<string>()

    for (const rec of links.records) {
      const enumTenantId = String(rec.get('enumTenantId'))
      const enumName     = String(rec.get('enumName'))
      if (enumTenantId === SYSTEM_TENANT) { alreadyOk.push(`${String(rec.get('fieldName'))}→${enumName}`); continue }
      toMove.push({
        fieldId:    String(rec.get('fieldId')),
        fieldName:  String(rec.get('fieldName')),
        enumName,
        fromTenant: enumTenantId,
      })
    }

    // (c) STOP se manca un nome: il campo perderebbe i valori.
    for (const m of toMove) {
      const sys = await session.run(`
        MATCH (e:EnumTypeDefinition {name: $name, tenant_id: $systemTenant}) RETURN e.id AS id
      `, { name: m.enumName, systemTenant: SYSTEM_TENANT })
      if (!sys.records.length) orphanNames.add(m.enumName)
    }
    if (orphanNames.size) {
      throw new Error(
        `[${systemEnumTypes.id}] nessun vocabolario spedito per ${[...orphanNames].map((n) => `"${n}"`).join(', ')}: ` +
        `${toMove.filter((m) => orphanNames.has(m.enumName)).length} campi condivisi ci sono agganciati e togliere il legame ` +
        `al buio farebbe perdere loro i valori. Aggiungi quei nomi a SYSTEM_ENUMS (lib/seedEnumTypes.ts) e riesegui.`,
      )
    }

    let moved = 0
    for (const m of toMove) {
      const r = await session.run(`
        MATCH (f:CIFieldDefinition {id: $fieldId})-[old:USES_ENUM]->(:EnumTypeDefinition {name: $name, tenant_id: $fromTenant})
        MATCH (sys:EnumTypeDefinition {name: $name, tenant_id: $systemTenant})
        DELETE old
        MERGE (f)-[:USES_ENUM]->(sys)
        RETURN sys.id AS id
      `, { fieldId: m.fieldId, name: m.enumName, fromTenant: m.fromTenant, systemTenant: SYSTEM_TENANT })
      if (!r.records.length) {
        throw new Error(`[${systemEnumTypes.id}] ${m.fieldName}→${m.enumName}: il ri-aggancio non ha scritto nulla (legame sparito sotto i piedi?)`)
      }
      moved++
    }

    const byName = new Map<string, number>()
    for (const m of toMove) byName.set(`${m.enumName} (da ${m.fromTenant})`, (byName.get(`${m.enumName} (da ${m.fromTenant})`) ?? 0) + 1)

    console.log(
      `[${systemEnumTypes.id}] vocabolari di sistema: ${created} creati, ${SYSTEM_ENUMS.length - created} già presenti; ` +
      `legami di campi condivisi: ${moved} spostati, ${alreadyOk.length} già a posto` +
      (byName.size ? `\n  ${[...byName].map(([k, n]) => `${k}: ${n} camp${n === 1 ? 'o' : 'i'}`).join('\n  ')}` : ' — niente da spostare'),
    )
  },
}
