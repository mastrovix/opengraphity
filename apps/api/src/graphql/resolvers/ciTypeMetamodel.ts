import { withSession } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'
import { toPascalCase } from '@opengraphity/schema-generator'
import { assertNewCITypeName, assertNewCIFieldName, type ExistingCIType } from '../../lib/metamodelNames.js'
import { CHAIN_FAMILIES, chainFamiliesToJSON } from '../../lib/chainCalculator.js'
import { assertRelationshipTypeName, defaultServiceRoleOf } from '../../lib/ciMetamodelForTenant.js'
import { describeCITypeUsage, loadCITypeUsage, type CITypeUsage } from '../../lib/ciTypeUsage.js'
import { SETTABLE_SERVICE_NODE_ROLES } from '../../lib/serviceVocabularies.js'
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

/** Le azioni che una mutation del disegnatore può tentare su un tipo CI. */
type TypeAction = 'add' | 'remove' | 'update' | 'addRelation' | 'removeRelation' | 'delete'

const CONSEQUENCE: Record<TypeAction, string> = {
  add:
    'Aggiungere un campo qui lo farebbe comparire nella CMDB di ogni cliente, e siccome lo schema non lo dichiara ' +
    'romperebbe la pagina di dettaglio di tutti i CI. Crea un tuo tipo CI e mettici il campo, oppure usa un campo già spedito.',
  remove:
    'I suoi campi sono in sola lettura: togliere un campo da qui lo toglierebbe a ogni cliente. ' +
    'Si possono eliminare solo i campi dei tuoi tipi.',
  update:
    'Etichetta, icona, colore, script e famiglie di catena sono in sola lettura: cambiarli qui li cambierebbe a ogni ' +
    'cliente. Per un tipo con le tue etichette, creane uno tuo.',
  addRelation:
    'Le sue relazioni sono in sola lettura: aggiungerne una qui la aggiungerebbe a ogni cliente. ' +
    'Le relazioni si definiscono sui tuoi tipi.',
  removeRelation:
    'Le sue relazioni sono in sola lettura: togliere una relazione da qui la toglierebbe a ogni cliente.',
  delete:
    'Non si elimina: sparirebbe dalla CMDB di ogni cliente. Puoi solo non usarlo.',
}

/**
 * Il tipo CI su cui una mutation del disegnatore sta per scrivere: esiste, ed è
 * del tenant? Un tipo **spedito col prodotto** (`__base__`, `server`,
 * `incident`, …) è UN nodo per tutti i clienti, perciò si rifiuta a voce alta
 * invece di riuscire a metà (`addCIField`) o di non fare niente in silenzio
 * (`removeCIField`, `updateCIType`, `addCIRelation`, `removeCIRelation`: tutte
 * rispondevano con `fetchCITypeById`, che sui tipi base TROVA il nodo — così
 * il disegnatore mostrava «Salvato» e i dati erano quelli di prima, A-6).
 */
async function assertTenantOwnedType(
  session: Session, typeId: string, tenantId: string, action: TypeAction,
): Promise<{ name: string; label: string }> {
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
  const name  = r.records[0]!.get('name')  as string
  const label = (r.records[0]!.get('label') as string | null) ?? name
  if (scope === 'tenant') return { name, label }
  throw new ValidationError(`Il tipo "${label}" (${name}) è spedito col prodotto: è un solo tipo per tutti i clienti. ${CONSEQUENCE[action]}`)
}

/**
 * Una mutation del metamodello ha scritto qualcosa? (A-6)
 *
 * `MATCH … WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId` che non trova
 * il nodo esegue zero righe e non lancia: la mutation rispondeva con
 * `fetchCITypeById` e il disegnatore faceva il toast «Salvato» su `onCompleted`,
 * che scatta anche a 0 righe. Il silenzio si chiude qui: se i contatori dicono
 * che non è stato scritto niente, la mutation fallisce.
 */
type Updates = { propertiesSet?: number; nodesCreated?: number; nodesDeleted?: number; relationshipsCreated?: number; relationshipsDeleted?: number }

/**
 * I contatori della scrittura appena eseguita. Se il driver non li ha
 * restituiti si lancia: dedurre «avrà scritto» sarebbe il fallback silenzioso
 * che questo punto esiste per togliere.
 *
 * Nota verificata su Neo4j 5: `SET n += {…}` conta `propertiesSet` anche
 * quando il valore è identico a quello di prima — un salvataggio che non
 * cambia niente NON viene preso per un no-op.
 */
function updatesOf(result: unknown, what: string): Updates {
  const counters = (result as { summary?: { counters?: { updates?: () => Updates } } }).summary?.counters
  if (typeof counters?.updates !== 'function') {
    throw new Error(`${what}: il driver Neo4j non ha restituito i contatori della scrittura, non si può sapere se ha scritto.`)
  }
  return counters.updates()
}

function assertWrote(result: unknown, what: string): void {
  const c = updatesOf(result, what)
  const written =
    (c.propertiesSet ?? 0) + (c.nodesCreated ?? 0) + (c.nodesDeleted ?? 0) +
    (c.relationshipsCreated ?? 0) + (c.relationshipsDeleted ?? 0)
  if (written > 0) return
  throw new ValidationError(
    `${what}: non è stato scritto niente, e nessuna modifica è stata salvata. ` +
    `L'elemento non esiste più, oppure il tipo è spedito col prodotto — un solo nodo per tutti i clienti, in sola lettura.`,
  )
}

/**
 * I tipi CI che finiranno nello stesso schema di quello che si sta creando:
 * quelli spediti col prodotto (base e ITIL) e quelli del cliente. Servono alla
 * porta sui nomi (A-12), che confronta i nomi **emessi** — PascalCase,
 * plurale, input, mutation — non il nome scritto.
 *
 * `__base__` è compreso: non emette tipi propri, ma occuparne il nome
 * romperebbe ogni lettura del metamodello.
 */
async function loadExistingCITypeNames(session: Session, tenantId: string): Promise<ExistingCIType[]> {
  const r = await session.executeRead((tx) =>
    tx.run(
      // tenant-ok: i tipi spediti col prodotto vivono su 'system' e stanno
      // nello schema di OGNI cliente, quindi i loro nomi sono presi per tutti.
      `MATCH (t:CITypeDefinition)
       WHERE t.scope IN ['base', 'itil'] OR (t.scope = 'tenant' AND t.tenant_id = $tenantId)
       RETURN t.name AS name, t.scope AS scope`,
      { tenantId },
    ),
  )
  return r.records.map((rec) => ({ name: rec.get('name') as string, scope: rec.get('scope') as string | null }))
}

/**
 * I nomi di campo già presi su un tipo: i suoi e quelli di `__base__`, che ogni
 * tipo CI eredita. Un campo omonimo di uno di questi sarebbe dichiarato due
 * volte nell'SDL generato.
 */
async function loadFieldNamesFor(session: Session, typeId: string, tenantId: string): Promise<string[]> {
  const r = await session.executeRead((tx) =>
    tx.run(
      `MATCH (t:CITypeDefinition {id: $typeId})
       WHERE t.tenant_id IN [$tenantId, '${SYSTEM_TENANT}']
       OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
         ${fieldScopeClause('f')}
       // tenant-ok: __base__ è il tipo condiviso di sistema, i suoi campi li filtra fieldScopeClause come altrove
       OPTIONAL MATCH (base:CITypeDefinition {name: '__base__'})-[:HAS_FIELD]->(bf:CIFieldDefinition)
         ${fieldScopeClause('bf')}
       RETURN collect(DISTINCT f.name) + collect(DISTINCT bf.name) AS names`,
      { typeId, tenantId },
    ),
  )
  if (!r.records.length) return []
  return ((r.records[0]!.get('names') as Array<string | null>) ?? []).filter((n): n is string => typeof n === 'string')
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
    // A-6: DI CHI è il tipo. Senza questi due campi il disegnatore non poteva
    // distinguere un tipo spedito col prodotto dai propri, e offriva azioni
    // che non scrivevano niente rispondendo «Salvato».
    scope:            t['scope'] ?? 'base',
    tenantId:         t['tenant_id'] ?? SYSTEM_TENANT,
    validationScript: t['validation_script'] ?? null,
    chainFamilies:    parseChainFamilies(t['chain_families']),
    // A-10: il ruolo nella mappa di un servizio è del TIPO. `null` = non
    // dichiarato: il ruolo lo propone il prodotto (seme dei tipi spediti, poi
    // le famiglie di catena), e il disegnatore lo mostra come tale.
    serviceRole:      t['service_role'] ?? null,
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
          // A-6: vedi mapCITypeNode — il disegnatore ne ha bisogno per sapere
          // quali azioni hanno effetto.
          scope:    t['scope'] ?? 'base',
          tenantId: t['tenant_id'] ?? SYSTEM_TENANT,
          validationScript: t['validation_script'] ?? null,
          chainFamilies: parseChainFamilies(t['chain_families']),
          serviceRole:   t['service_role'] ?? null,
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

// ── assertServiceRoleInput / assertCITypeNotInUse ─────────────────────────────

/**
 * Il ruolo nella mappa di un servizio in arrivo dall'interfaccia (A-10).
 * `undefined` = campo non mandato: nessuna scrittura. `null` = «torna a farlo
 * proporre al prodotto». Un valore fuori vocabolario FERMA la mutation
 * nominandolo: dedurre un ruolo cambierebbe in silenzio il peso di ogni
 * componente di quel tipo in ogni mappa.
 */
export function assertServiceRoleInput(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value
  if (!(SETTABLE_SERVICE_NODE_ROLES as readonly string[]).includes(value)) {
    throw new GraphQLError(
      `serviceRole: ${JSON.stringify(value)} non è un ruolo valido (${SETTABLE_SERVICE_NODE_ROLES.join(', ')}). ` +
      `Il ruolo \`entry\` non si dichiara: nella mappa lo prende sempre il livello 1.`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    )
  }
  return value
}

/**
 * A-8 / D-10 — non si cancella (né si disattiva) un tipo che è ancora in uso.
 *
 * Prima `deleteCIType` faceva `DETACH DELETE` senza contare niente, e
 * `active = false` aveva lo stesso effetto sulle letture: i CI restavano nel
 * grafo e non comparivano più da nessuna parte. Qui si conta e si dice, con il
 * numero e con l'elenco di chi cita il tipo per nome.
 */
async function assertCITypeNotInUse(
  session: Session, tenantId: string, typeId: string, type: { name: string; label: string }, action: 'delete' | 'deactivate',
): Promise<void> {
  const neo4jLabel = toPascalCase(type.name)
  const usage: CITypeUsage = await loadCITypeUsage(session, tenantId, typeId, type.name, neo4jLabel)
  const refs = describeCITypeUsage(usage)
  const what = action === 'delete'
    ? `Il tipo "${type.label}" (${type.name}) non è stato eliminato`
    : `Il tipo "${type.label}" (${type.name}) non è stato disattivato`
  const consequence = action === 'delete'
    ? `i loro dati e le loro relazioni resterebbero nel grafo senza comparire più da nessuna parte (liste, impatto, mappe dei servizi, ricerca): una perdita silenziosa.`
    : `un tipo disattivato sparisce dalle letture come se fosse cancellato, quindi quei CI non comparirebbero più da nessuna parte.`

  if (usage.cis > 0) {
    throw new ValidationError(
      `${what}: ci sono ancora ${String(usage.cis)} CI di tipo ${neo4jLabel} in questo cliente, e ${consequence} ` +
      `Sposta o elimina prima quei CI.` + (refs ? ` Il tipo è citato anche da: ${refs}.` : ''),
    )
  }
  if (refs) {
    throw new ValidationError(
      `${what}: nessun CI di questo tipo, ma il tipo è ancora citato da ${refs}. ` +
      `Quei riferimenti sono per NOME: resterebbero appesi a un tipo che non esiste più. Togli prima i riferimenti.`,
    )
  }
}

// ── buildMetamodelMutations ───────────────────────────────────────────────────

export function buildMetamodelMutations() {
  return {
    createCIType: async (
      _: unknown,
      args: { input: { name: string; label: string; icon?: string; color?: string; chainFamilies?: string[]; serviceRole?: string | null } },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const { name, label, icon = 'box', color = '#0284c7' } = args.input
      const chainFamilies = assertChainFamilies(args.input.chainFamilies)
      // A-10: il ruolo nella mappa di un servizio nasce col tipo. Se non lo
      // dichiara, lo propone il prodotto dalle famiglie di catena — scritto
      // ORA, così le mappe non devono indovinarlo a ogni costruzione.
      const serviceRole = assertServiceRoleInput(args.input.serviceRole) ?? defaultServiceRoleOf(args.input.chainFamilies)
      const id = crypto.randomUUID()

      await withSession(async session => {
        // A-12 — LA PORTA. Deve stare qui e prima della scrittura: due tipi
        // GraphQL con lo stesso nome NON fanno lanciare `makeExecutableSchema`,
        // vengono fusi in silenzio (i campi del tipo del cliente entrano nel
        // tipo del prodotto). Non c'è nessuna rete a valle che lo prenda: se
        // questo controllo non gira, non gira niente.
        assertNewCITypeName(name, await loadExistingCITypeNames(session, ctx.tenantId))
        const neo4jLabel = toPascalCase(name)
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
              t.chain_families   = $chainFamilies,
              t.service_role     = $serviceRole
            ON MATCH SET
              t.label            = $label,
              t.icon             = $icon,
              t.color            = $color,
              t.chain_families   = coalesce($chainFamilies, t.chain_families),
              t.service_role     = coalesce($serviceRole, t.service_role)
          `, { name, tenantId: ctx.tenantId, id, label, icon, color, neo4jLabel, chainFamilies, serviceRole }),
        )
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(id, ctx.tenantId)
    },

    updateCIType: async (
      _: unknown,
      args: { id: string; input: { label?: string; icon?: string; color?: string; active?: boolean; validationScript?: string; chainFamilies?: string[]; serviceRole?: string | null } },
      ctx: GraphQLContext,
    ) => {
      requireAdmin(ctx)
      const updates: Props = {}
      const { label, icon, color, active, validationScript, chainFamilies } = args.input
      const serviceRole = assertServiceRoleInput(args.input.serviceRole)
      if (label             !== undefined) updates['label']             = label
      if (icon              !== undefined) updates['icon']              = icon
      if (color             !== undefined) updates['color']             = color
      if (active            !== undefined) updates['active']            = active
      if (validationScript  !== undefined) updates['validation_script'] = validationScript
      // B0-1: il tab «Impostazioni» del disegnatore manda chainFamilies da
      // sempre; finché l'input non lo dichiarava, Apollo rifiutava l'intera
      // richiesta e il salvataggio non funzionava MAI.
      if (chainFamilies     !== undefined) updates['chain_families']    = assertChainFamilies(chainFamilies)
      // A-10: `null` è un valore, non «campo assente»: rimette il ruolo in mano
      // al prodotto (seme dei tipi spediti, poi le famiglie di catena).
      if (serviceRole       !== undefined) updates['service_role']      = serviceRole

      // A-6: `SET t += {}` scrive 0 proprietà anche su un tipo che c'è — senza
      // questo controllo il no-op del chiamante diventerebbe un errore che
      // accusa il tipo di essere spedito col prodotto.
      if (!Object.keys(updates).length) {
        throw new ValidationError('updateCIType: nessun campo da modificare nella richiesta.')
      }

      await withSession(async session => {
        // A-6: il tipo spedito col prodotto va detto PRIMA, con la sua
        // conseguenza; il controllo dei contatori qui sotto è la rete per tutti
        // gli altri modi di non scrivere niente (id sbagliato, tipo eliminato
        // da un'altra sessione).
        const owned = await assertTenantOwnedType(session, args.id, ctx.tenantId, 'update')
        // A-8: disattivare è come cancellare, per chi legge. Non si fa mentre
        // ci sono CI di quel tipo (o riferimenti al suo nome).
        if (active === false) await assertCITypeNotInUse(session, ctx.tenantId, args.id, owned, 'deactivate')
        const r = await session.executeWrite(tx =>
          tx.run(
            `MATCH (t:CITypeDefinition {id: $id})
             WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId
             SET t += $updates`,
            { id: args.id, tenantId: ctx.tenantId, updates },
          ),
        )
        assertWrote(r, `updateCIType(${args.id})`)
      }, true)

      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(args.id, ctx.tenantId)
    },

    deleteCIType: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      requireAdmin(ctx)
      await withSession(async session => {
        // A-6: prima il controllo esplicito era solo su `scope = 'base'`, e un
        // tipo ITIL rispondeva `true` senza eliminare niente.
        const owned = await assertTenantOwnedType(session, args.id, ctx.tenantId, 'delete')
        // A-8 / D-10: prima si conta. `DETACH DELETE` porterebbe via anche le
        // domande di assessment agganciate, e lascerebbe i CI nel grafo
        // invisibili a tutto il prodotto.
        await assertCITypeNotInUse(session, ctx.tenantId, args.id, owned, 'delete')
        const r = await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $id})
            WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId
            OPTIONAL MATCH (t)-[:HAS_FIELD]->(f)
            OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel)
            OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr)
            DETACH DELETE t, f, rel, sr
          `, { id: args.id, tenantId: ctx.tenantId }),
        )
        assertWrote(r, `deleteCIType(${args.id})`)
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
        const owned = await assertTenantOwnedType(session, typeId, ctx.tenantId, 'add')
        // A-12 — LA PORTA sui nomi di campo. Il caso da cui nasce è `tenantId`:
        // `toSnakeCase` lo porta a `tenant_id`, non è fra i campi esclusi dagli
        // input, e la scrittura del CI copia i campi del metamodello DOPO aver
        // impostato il cliente proprietario — il CI nascerebbe nel cliente
        // scelto da chi chiama l'API.
        assertNewCIFieldName(input['name'], {
          typeLabel:          owned.label,
          existingFieldNames: await loadFieldNamesFor(session, typeId, ctx.tenantId),
        })
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
        // A-6: sui tipi spediti col prodotto la CREATE non girava e la mutation
        // rispondeva con `fetchCITypeById` — il disegnatore diceva «Relazione
        // aggiunta» e la relazione non c'era.
        await assertTenantOwnedType(session, typeId, ctx.tenantId, 'addRelation')
        // C-3: `relationship_type` NON era validato affatto — un `String!`
        // passato come parametro Cypher, quindi «bilancia», «a b» o una riga
        // vuota entravano nel metamodello. Da qui quei tipi finiscono nelle
        // mappe dei servizi e nel pattern INTERPOLATO della soppressione in
        // finestra di change: passa solo un identificatore Neo4j.
        const relationshipType = assertRelationshipTypeName(input['relationshipType'], `addCIRelation(${typeId}).relationshipType`)
        const r = await session.executeWrite(tx =>
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
              order:             $order,
              // C-3: senza tenant_id questa definizione non era di nessuno, e
              // allowedRelTypes (che filtra per proprietario) NON la vedeva:
              // la relazione appena definita nel disegnatore veniva rifiutata
              // con «Invalid relation type».
              tenant_id:         $tenantId,
              scope:             'tenant'
            })
            CREATE (t)-[:HAS_RELATION]->(r)
          `, {
            typeId, tenantId: ctx.tenantId, relId,
            name:             input['name'],
            label:            input['label'],
            relationshipType,
            targetType:       input['targetType'],
            cardinality:      input['cardinality'],
            direction:        input['direction'],
            order:            input['order'] ?? 0,
          }),
        )
        assertWrote(r, `addCIRelation(${typeId})`)
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
        // A-6: idem in rimozione — la DELETE non girava e l'interfaccia diceva
        // «Relazione rimossa».
        await assertTenantOwnedType(session, args.typeId, ctx.tenantId, 'removeRelation')
        const r = await session.executeWrite(tx =>
          tx.run(`
            MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_RELATION]->(rel:CIRelationDefinition {id: $relationId})
            WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId
            DETACH DELETE rel
          `, { typeId: args.typeId, relationId: args.relationId, tenantId: ctx.tenantId }),
        )
        assertWrote(r, `removeCIRelation(${args.relationId})`)
      }, true)
      invalidateSchema(ctx.tenantId)
      return fetchCITypeById(args.typeId, ctx.tenantId)
    },
  }
}
