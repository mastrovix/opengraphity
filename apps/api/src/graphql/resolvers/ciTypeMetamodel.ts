import { withSession } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'
import { toPascalCase } from '@opengraphity/schema-generator'
import { CHAIN_FAMILIES, chainFamiliesToJSON } from '../../lib/chainCalculator.js'
import { ValidationError } from '../../lib/errors.js'
import {
  SYSTEM_TENANT, enumScopeClause, loadTenantEnumOverrides, applyEnumOverrides, assertEnumLinkable,
} from '../../lib/enumScope.js'
import type { Session } from 'neo4j-driver'

type Props = Record<string, unknown>

// ── Ambito dei campi di metamodello (A-5) ────────────────────────────────────

/**
 * Filtro da mettere subito dopo un `OPTIONAL MATCH (…)-[:HAS_FIELD]->(v)`.
 *
 * Un campo si legge solo se è **spedito col prodotto** (scope `base`/`itil` sul
 * tenant `system`) o se è **del tenant**. Il caso che manca in mezzo è il
 * difetto A-5: un campo `scope = 'base'` con `tenant_id` di un cliente —
 * quello che `addCIField` scriveva quando lo si aggiungeva al `__base__`
 * condiviso. Letto senza filtro finiva nel metamodello di **ogni** cliente, e
 * quindi nella query dinamica di ogni tipo di ogni cliente, dove l'SDL non lo
 * dichiara: `Cannot query field "<campo>" on type "<Tipo>"`.
 */
export function fieldScopeClause(fieldVar: string): string {
  return `WHERE (${fieldVar}.scope IN ['base', 'itil'] AND ${fieldVar}.tenant_id = '${SYSTEM_TENANT}')` +
         ` OR (${fieldVar}.scope = 'tenant' AND ${fieldVar}.tenant_id = $tenantId)`
}

/**
 * Il tipo CI su cui una mutation di campo sta per scrivere: esiste, ed è del
 * tenant? Un tipo **spedito col prodotto** (`__base__`, `server`, `incident`,
 * …) è UN nodo per tutti i clienti: aggiungerci o togliergli un campo cambia
 * la CMDB di tutti, perciò si rifiuta a voce alta invece di riuscire a metà
 * (`addCIField`) o di non fare niente in silenzio (`removeCIField`).
 */
async function assertTenantOwnedType(session: Session, typeId: string, tenantId: string, action: 'add' | 'remove'): Promise<void> {
  const r = await session.executeRead((tx) =>
    tx.run(
      `MATCH (t:CITypeDefinition {id: $typeId})
       WHERE t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
       RETURN t.scope AS scope, t.name AS name, t.label AS label`,
      { typeId, tenantId },
    ),
  )
  if (!r.records.length) throw new GraphQLError('CIType non trovato')
  const scope = r.records[0]!.get('scope') as string | null
  if (scope === 'tenant') return
  const name  = r.records[0]!.get('name')  as string
  const label = (r.records[0]!.get('label') as string | null) ?? name
  const consequence = action === 'add'
    ? 'Aggiungere un campo qui lo farebbe comparire nella CMDB di ogni cliente, e siccome lo schema non lo dichiara ' +
      'romperebbe la pagina di dettaglio di tutti i CI. Crea un tuo tipo CI e mettici il campo, oppure usa un campo già spedito.'
    : 'I suoi campi sono in sola lettura: togliere un campo da qui lo toglierebbe a ogni cliente. ' +
      'Si possono eliminare solo i campi dei tuoi tipi.'
  throw new ValidationError(`Il tipo "${label}" (${name}) è spedito col prodotto: è un solo tipo per tutti i clienti. ${consequence}`)
}

/**
 * Il vocabolario che si sta per agganciare a un campo del tenant: esiste, e può
 * essere agganciato? Il giudizio è del nucleo (`assertEnumLinkable`), qui si
 * legge solo il nodo. Il vocabolario di un ALTRO cliente esiste nel grafo ma
 * non è agganciabile: la differenza fra «non esiste» e «è di un altro cliente»
 * va detta, non nascosta dietro un legame che non viene creato.
 */
async function assertEnumTypeLinkable(session: Session, enumTypeId: string, fieldName: string, tenantId: string): Promise<void> {
  const r = await session.executeRead((tx) =>
    // tenant-ok: l'ambito lo giudica assertEnumLinkable, che distingue «di un
    // altro cliente» da «non esiste» (leggere solo i propri darebbe lo stesso
    // messaggio ai due casi).
    tx.run(
      `MATCH (e:EnumTypeDefinition {id: $enumTypeId}) RETURN e.id AS id, e.name AS name, e.tenant_id AS tenantId`,
      { enumTypeId },
    ),
  )
  if (!r.records.length) {
    throw new ValidationError(`Il vocabolario ${enumTypeId} non esiste: il campo "${fieldName}" non può essere agganciato.`)
  }
  const rec = r.records[0]!
  assertEnumLinkable(
    { id: rec.get('id') as string, name: rec.get('name') as string, tenantId: rec.get('tenantId') as string },
    { name: fieldName, scope: 'tenant', tenantId },
    tenantId,
  )
}

export type CIFieldRow = { f: { properties: Props } | null; enumId: string | null; enumName: string | null; enumValues: string[] | string | null }

function parseEnumValues(raw: string[] | string | null | undefined): string[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') { const parsed: unknown = JSON.parse(raw); if (!Array.isArray(parsed)) throw new Error(`enum_values non è un array JSON valido: ${raw.slice(0, 80)}`); return parsed as string[] }
  return []
}

// ── mapCITypeNode ─────────────────────────────────────────────────────────────

function parseChainFamilies(raw: unknown): string[] {
  // Missing → no families (legitimate). CORRUPT → throw: substituting an
  // invented default silently alters chain calculation for the whole type.
  if (raw == null) return []
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw === 'string') {
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch (e) { throw new Error(`Corrupt chain_families JSON: ${e instanceof Error ? e.message : String(e)}`) }
    if (!Array.isArray(parsed)) throw new Error(`chain_families is not an array (got ${typeof parsed})`)
    return parsed as string[]
  }
  throw new Error(`chain_families has unexpected type ${typeof raw}`)
}

export function mapCITypeNode(t: Props, fields: CIFieldRow[], relations: Props[], systemRels: Props[]) {
  return {
    id:               t['id'],
    name:             t['name'],
    label:            t['label'],
    icon:             t['icon'],
    color:            t['color'],
    active:           t['active'] ?? true,
    validationScript: t['validation_script'] ?? null,
    chainFamilies:    parseChainFamilies(t['chain_families']),
    fields: fields
      .filter(fd => fd?.f?.properties)
      .map(fd => {
        const f = fd.f!.properties
        return {
          id:               f['id'],
          name:             f['name'],
          label:            f['label'],
          fieldType:        f['field_type'],
          required:         f['required'] ?? false,
          defaultValue:     f['default_value'] ?? null,
          enumValues:       parseEnumValues(fd.enumValues ?? fd.f!.properties['enum_values'] as string[] | string | null),
          enumTypeId:       fd.enumId     ?? null,
          enumTypeName:     fd.enumName   ?? null,
          order:            Number(f['order'] ?? 0),
          validationScript: f['validation_script'] ?? null,
          visibilityScript: f['visibility_script'] ?? null,
          defaultScript:    f['default_script']    ?? null,
          isSystem:         f['is_system']         ?? false,
        }
      })
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)),
    relations: relations
      .filter(r => r && Object.keys(r).length)
      .map(r => ({
        id:               r['id'],
        name:             r['name'],
        label:            r['label'],
        relationshipType: r['relationship_type'],
        targetType:       r['target_type'],
        cardinality:      r['cardinality'],
        direction:        r['direction'],
        order:            Number(r['order'] ?? 0),
      }))
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)),
    systemRelations: systemRels
      .filter(sr => sr && Object.keys(sr).length)
      .map(sr => ({
        id:               sr['id'],
        name:             sr['name'],
        label:            sr['label'],
        relationshipType: sr['relationship_type'],
        targetEntity:     sr['target_entity'],
        required:         sr['required'] ?? false,
        order:            Number(sr['order'] ?? 0),
      })),
  }
}

// ── fetchCITypeById ───────────────────────────────────────────────────────────

export async function fetchCITypeById(id: string, tenantId: string) {
  return withSession(async session => {
    const r = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition {id: $id})
        WHERE t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId)
        OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
          ${fieldScopeClause('f')}
        OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
          ${enumScopeClause('enumDef')}
        OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel:CIRelationDefinition)
        OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
        RETURN t,
          collect(DISTINCT {f: f, enumId: enumDef.id, enumName: enumDef.name, enumValues: enumDef.values}) AS fields,
          collect(DISTINCT rel) AS relations,
          collect(DISTINCT sr) AS systemRels
      `, { id, tenantId }),
    )
    if (!r.records.length) throw new GraphQLError('CIType non trovato')
    const overrides = await loadTenantEnumOverrides(session, tenantId)
    const rec = r.records[0]
    return mapCITypeNode(
      rec.get('t').properties as Props,
      applyEnumOverrides((rec.get('fields') as CIFieldRow[]).filter(fd => fd?.f?.properties), overrides),
      (rec.get('relations') as Array<{ properties: Props } | null>)
        .filter(Boolean).map(r => r!.properties),
      (rec.get('systemRels') as Array<{ properties: Props } | null>)
        .filter(Boolean).map(sr => sr!.properties),
    )
  })
}

// ── requireAdmin ──────────────────────────────────────────────────────────────

export function requireAdmin(ctx: GraphQLContext) {
  if (ctx.role !== 'admin') {
    throw new GraphQLError('Accesso negato: richiesto ruolo admin', {
      extensions: { code: 'FORBIDDEN' },
    })
  }
}

// ── assertChainFamilies ───────────────────────────────────────────────────────

/**
 * Valida le famiglie di catena in arrivo dall'interfaccia (B0-1) e le
 * restituisce come JSON canonico per `chain_families`. `undefined` = campo non
 * mandato: nessuna scrittura. Un valore fuori vocabolario o un doppione
 * FERMANO la mutation nominando il valore: una famiglia inventata cambierebbe
 * in silenzio il calcolo della catena di ogni CI del tipo.
 */
export function assertChainFamilies(value: string[] | undefined): string | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) {
    throw new GraphQLError(`chainFamilies deve essere una lista di famiglie (${CHAIN_FAMILIES.join(', ')}). Ricevuto: ${JSON.stringify(value)}`, { extensions: { code: 'BAD_USER_INPUT' } })
  }
  const seen = new Set<string>()
  for (const f of value) {
    if (typeof f !== 'string' || !(CHAIN_FAMILIES as readonly string[]).includes(f)) {
      throw new GraphQLError(`chainFamilies: ${JSON.stringify(f)} non è una famiglia di catena valida (${CHAIN_FAMILIES.join(', ')})`, { extensions: { code: 'BAD_USER_INPUT' } })
    }
    if (seen.has(f)) {
      throw new GraphQLError(`chainFamilies: ${f} compare due volte`, { extensions: { code: 'BAD_USER_INPUT' } })
    }
    seen.add(f)
  }
  return chainFamiliesToJSON(value)
}

// ── buildCITypesResolver ──────────────────────────────────────────────────────

export function buildCITypesResolver() {
  return async (_: unknown, __: unknown, ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition)
           WHERE (t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId))
             AND t.active = true
             AND t.name <> '__base__'
           OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
             ${fieldScopeClause('f')}
           OPTIONAL MATCH (f)-[:USES_ENUM]->(fEnum:EnumTypeDefinition)
             ${enumScopeClause('fEnum')}
           OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel:CIRelationDefinition)
           OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
           // A-5: un campo di un cliente agganciato al __base__ condiviso non
           // deve vedersi dagli altri — i CAMPI li filtra fieldScopeClause.
           // tenant-ok: __base__ è il tipo condiviso di sistema
           OPTIONAL MATCH (base:CITypeDefinition {name: '__base__'})-[:HAS_FIELD]->(bf:CIFieldDefinition)
             ${fieldScopeClause('bf')}
           OPTIONAL MATCH (bf)-[:USES_ENUM]->(bfEnum:EnumTypeDefinition)
             ${enumScopeClause('bfEnum')}
           RETURN t,
             collect(DISTINCT {f: f, enumId: fEnum.id, enumName: fEnum.name, enumValues: fEnum.values})  AS typeFields,
             collect(DISTINCT {f: bf, enumId: bfEnum.id, enumName: bfEnum.name, enumValues: bfEnum.values}) AS baseFields,
             collect(DISTINCT rel) AS relations,
             collect(DISTINCT sr) AS systemRels
           ORDER BY t.name`,
          { tenantId: ctx.tenantId },
        ),
      )
      const overrides = await loadTenantEnumOverrides(session, ctx.tenantId)
      return r.records.map(rec => {
        const t = rec.get('t').properties as Props

        type FRow = { f: { properties: Props } | null; enumId: string | null; enumName: string | null; enumValues: string[] | string | null }
        const mapF = (fd: FRow) => {
          const f = fd.f!.properties
          return {
            id:               f['id'],
            name:             f['name'],
            label:            f['label'],
            fieldType:        f['field_type'],
            required:         f['required']      ?? false,
            defaultValue:     f['default_value'] ?? null,
            enumValues:       parseEnumValues(fd.enumValues ?? f['enum_values'] as string[] | string | null),
            enumTypeId:       fd.enumId          ?? null,
            enumTypeName:     fd.enumName        ?? null,
            order:            f['order']          ?? 0,
            validationScript: f['validation_script'] ?? null,
            visibilityScript: f['visibility_script'] ?? null,
            defaultScript:    f['default_script']    ?? null,
            isSystem:         f['is_system']          ?? false,
          }
        }

        // La personalizzazione del tenant si applica PRIMA di mappare: `mapF`
        // fa `fd.enumValues ?? f['enum_values']`, quindi l'agganciato vince
        // sull'inline — con l'override applicato la precedenza diventa quella
        // del contratto (vocabolario del tenant > agganciato > inline).
        const typeFields = applyEnumOverrides((rec.get('typeFields') as FRow[]).filter(fd => fd?.f?.properties), overrides)
          .map(fd => mapF(fd))
        const baseFields = applyEnumOverrides((rec.get('baseFields') as FRow[]).filter(fd => fd?.f?.properties), overrides)
          .map(fd => mapF(fd))

        const seen = new Set<string>()
        const fields = [...baseFields, ...typeFields]
          .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
          .filter(f => { if (seen.has(f.name as string)) return false; seen.add(f.name as string); return true })

        return {
          id:    t['id'],
          name:  t['name'],
          label: t['label'],
          icon:  t['icon'],
          color: t['color'],
          active: t['active'],
          validationScript: t['validation_script'] ?? null,
          chainFamilies: parseChainFamilies(t['chain_families']),
          fields,
          relations: (rec.get('relations') as Array<{ properties: Props }>)
            .filter(r => r?.properties)
            .map(r => r.properties)
            .map(r => ({
              id: r['id'], name: r['name'], label: r['label'],
              relationshipType: r['relationship_type'], targetType: r['target_type'],
              cardinality: r['cardinality'], direction: r['direction'], order: r['order'] ?? 0,
            })),
          systemRelations: (rec.get('systemRels') as Array<{ properties: Props }>)
            .filter(sr => sr?.properties)
            .map(sr => sr.properties)
            .map(sr => ({
              id: sr['id'], name: sr['name'], label: sr['label'],
              relationshipType: sr['relationship_type'], targetEntity: sr['target_entity'],
              required: sr['required'] ?? false, order: sr['order'] ?? 0,
            })),
        }
      })
    })
}

// ── buildBaseCITypeResolver ───────────────────────────────────────────────────

export function buildBaseCITypeResolver() {
  return async (_: unknown, __: unknown, ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition {name: '__base__'})
           WHERE t.tenant_id = $tenantId OR t.tenant_id = 'system'
           WITH t ORDER BY t.tenant_id DESC
           LIMIT 1
           OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
             ${fieldScopeClause('f')}
           OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
             ${enumScopeClause('enumDef')}
           RETURN t, collect(DISTINCT {f: f, enumId: enumDef.id, enumName: enumDef.name, enumValues: enumDef.values}) AS fields`,
          { tenantId: ctx.tenantId },
        ),
      )
      if (!r.records.length) throw new GraphQLError('__base__ non trovato')
      const overrides = await loadTenantEnumOverrides(session, ctx.tenantId)
      const rec = r.records[0]
      return mapCITypeNode(
        rec.get('t').properties as Props,
        applyEnumOverrides((rec.get('fields') as CIFieldRow[]).filter(fd => fd?.f?.properties), overrides),
        [],
        [],
      )
    })
}

// ── buildMetamodelMutations ───────────────────────────────────────────────────

export function buildMetamodelMutations() {
  return {
    createCIType: async (
      _: unknown,
      args: { input: { name: string; label: string; icon?: string; color?: string; chainFamilies?: string[] } },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const { name, label, icon = 'box', color = '#0284c7' } = args.input
      const chainFamilies = assertChainFamilies(args.input.chainFamilies)
      const id = crypto.randomUUID()
      const neo4jLabel = toPascalCase(name)

      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(`
            MERGE (t:CITypeDefinition {name: $name, tenant_id: $tenantId})
            ON CREATE SET
              t.id               = $id,
              t.scope            = 'tenant',
              t.label            = $label,
              t.icon             = $icon,
              t.color            = $color,
              t.active           = true,
              t.neo4j_label      = $neo4jLabel,
              t.tenant_id        = $tenantId,
              t.chain_families   = $chainFamilies
            ON MATCH SET
              t.label            = $label,
              t.icon             = $icon,
              t.color            = $color,
              t.chain_families   = coalesce($chainFamilies, t.chain_families)
          `, { name, tenantId: ctx.tenantId, id, label, icon, color, neo4jLabel, chainFamilies }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(id, ctx.tenantId)
    },

    updateCIType: async (
      _: unknown,
      args: { id: string; input: { label?: string; icon?: string; color?: string; active?: boolean; validationScript?: string; chainFamilies?: string[] } },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const updates: Props = {}
      const { label, icon, color, active, validationScript, chainFamilies } = args.input
      if (label             !== undefined) updates['label']             = label
      if (icon              !== undefined) updates['icon']              = icon
      if (color             !== undefined) updates['color']             = color
      if (active            !== undefined) updates['active']            = active
      if (validationScript  !== undefined) updates['validation_script'] = validationScript
      // B0-1: il tab «Impostazioni» del disegnatore manda chainFamilies da
      // sempre; finché l'input non lo dichiarava, Apollo rifiutava l'intera
      // richiesta e il salvataggio non funzionava MAI.
      if (chainFamilies     !== undefined) updates['chain_families']    = assertChainFamilies(chainFamilies)

      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(
            `MATCH (t:CITypeDefinition {id: $id})
             WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId
             SET t += $updates`,
            { id: args.id, tenantId: ctx.tenantId, updates },
          ),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(args.id, ctx.tenantId)
    },

    deleteCIType: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      requireAdmin(ctx)
      await withSession(async session => {
        const r = await session.executeRead(tx =>
          tx.run(`MATCH (t:CITypeDefinition {id: $id}) WHERE t.tenant_id IN [$tenantId, 'system'] RETURN t.scope AS scope`, { id: args.id, tenantId: ctx.tenantId }),
        )
        if (r.records.length && r.records[0].get('scope') === 'base') {
          throw new GraphQLError('I tipi base non possono essere eliminati')
        }
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $id})
            WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId
            OPTIONAL MATCH (t)-[:HAS_FIELD]->(f)
            OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel)
            OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr)
            DETACH DELETE t, f, rel, sr
          `, { id: args.id, tenantId: ctx.tenantId }),
        )
      }, true)
      invalidateSchema(ctx.tenantId)
      return true
    },

    addCIField: async (
      _: unknown,
      args: { typeId: string; input: Record<string, unknown> },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const { typeId, input } = args
      const fieldId    = crypto.randomUUID()
      const enumTypeId = (input['enumTypeId'] as string | null | undefined) ?? null

      if (input['fieldType'] === 'enum' && !enumTypeId) {
        throw new GraphQLError('enumTypeId obbligatorio per campi di tipo enum', {
          extensions: { code: 'BAD_USER_INPUT' },
        })
      }

      await withSession(async session => {
        // A-5: un campo si aggiunge SOLO a un tipo del tenant. Sul `__base__`
        // (o su un altro tipo spedito) il campo entrava con `scope: 'base'` e
        // `is_system: true` e finiva nella CMDB di tutti i clienti.
        await assertTenantOwnedType(session, typeId, ctx.tenantId, 'add')
        // A-2: il vocabolario agganciato passa dal nucleo. Il legame verso il
        // vocabolario di un altro cliente è rifiutato con il messaggio, non
        // ignorato in silenzio come faceva il `WHERE` dentro il CALL.
        if (enumTypeId) await assertEnumTypeLinkable(session, enumTypeId, String(input['name'] ?? ''), ctx.tenantId)
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})
            WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId
            CREATE (f:CIFieldDefinition {
              id:                $fieldId,
              name:              $name,
              label:             $label,
              field_type:        $fieldType,
              required:          $required,
              default_value:     $defaultValue,
              order:             $order,
              scope:             'tenant',
              tenant_id:         $tenantId,
              is_system:         false,
              validation_script: $validationScript,
              visibility_script: $visibilityScript,
              default_script:    $defaultScript
            })
            CREATE (t)-[:HAS_FIELD]->(f)
            WITH f
            CALL {
              WITH f
              // Un filtro di tenant anche qui sarebbe un fallback silenzioso:
              // il legame non si creerebbe e nessuno saprebbe perché.
              // tenant-ok: l'ambito l'ha già imposto assertEnumTypeLinkable (nucleo assertEnumLinkable)
              MATCH (e:EnumTypeDefinition {id: $enumTypeId})
              WHERE $enumTypeId IS NOT NULL
              MERGE (f)-[:USES_ENUM]->(e)
              RETURN count(e) AS linked
            }
            RETURN f
          `, {
            typeId,
            fieldId,
            name:             input['name'],
            label:            input['label'],
            fieldType:        input['fieldType'],
            required:         input['required']          ?? false,
            defaultValue:     input['defaultValue']      ?? null,
            enumTypeId,
            order:            input['order']             ?? 0,
            tenantId:         ctx.tenantId,
            validationScript: input['validationScript']  ?? null,
            visibilityScript: input['visibilityScript']  ?? null,
            defaultScript:    input['defaultScript']     ?? null,
          }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(typeId, ctx.tenantId)
    },

    removeCIField: async (
      _: unknown,
      args: { typeId: string; fieldId: string },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      await withSession(async session => {
        // A-5: sui tipi spediti il `WHERE t.scope = 'tenant'` rendeva questa
        // mutation un no-op silenzioso — l'interfaccia diceva «fatto» e il
        // campo restava. Ora si ferma e dice perché.
        await assertTenantOwnedType(session, args.typeId, ctx.tenantId, 'remove')
        const r = await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId})
            WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId
              AND f.scope = 'tenant' AND f.tenant_id = $tenantId
            WITH f, f.name AS name
            DETACH DELETE f
            RETURN name
          `, { typeId: args.typeId, fieldId: args.fieldId, tenantId: ctx.tenantId }),
        )
        if (!r.records.length) {
          throw new ValidationError(
            `Il campo ${args.fieldId} non è un campo tuo su questo tipo: non è stato eliminato. ` +
            `I campi spediti col prodotto sono in sola lettura.`,
          )
        }
      }, true)
      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(args.typeId, ctx.tenantId)
    },

    addCIRelation: async (
      _: unknown,
      args: { typeId: string; input: Record<string, unknown> },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const { typeId, input } = args
      const relId = crypto.randomUUID()

      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})
            WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId
            CREATE (r:CIRelationDefinition {
              id:                $relId,
              name:              $name,
              label:             $label,
              relationship_type: $relationshipType,
              target_type:       $targetType,
              cardinality:       $cardinality,
              direction:         $direction,
              order:             $order
            })
            CREATE (t)-[:HAS_RELATION]->(r)
          `, {
            typeId, tenantId: ctx.tenantId, relId,
            name:             input['name'],
            label:            input['label'],
            relationshipType: input['relationshipType'],
            targetType:       input['targetType'],
            cardinality:      input['cardinality'],
            direction:        input['direction'],
            order:            input['order'] ?? 0,
          }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(typeId, ctx.tenantId)
    },

    removeCIRelation: async (
      _: unknown,
      args: { typeId: string; relationId: string },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      await withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_RELATION]->(r:CIRelationDefinition {id: $relationId})
            WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId
            DETACH DELETE r
          `, { typeId: args.typeId, relationId: args.relationId, tenantId: ctx.tenantId }),
        )
      }, true)
      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(args.typeId, ctx.tenantId)
    },
  }
}
