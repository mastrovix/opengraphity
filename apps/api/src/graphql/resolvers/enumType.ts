import { v4 as uuidv4 } from 'uuid'
import { getSession, toNumber } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { SYSTEM_TENANT } from '../../lib/enumScope.js'
import { countEnumValueUsage, enumValueUsageMessage, replaceEnumValue } from '../../lib/enumValueUsage.js'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'

/**
 * Il vocabolario di questo cliente è cambiato: svuota le cache derivate e
 * avvisa gli altri processi (revisione delle otto ondate · C-N1 / D-N1).
 *
 * Perché serviva, e perché è la prima cosa dell'ondata di rimedio: nessuna
 * mutation di questo file invalidava niente, e la cache dei vocabolari
 * (`lib/domainMatrix.ts`) non aveva scadenza. Misurato dal vivo: subito dopo
 * una rinomina nel Dizionario lo **stesso processo API** continuava a
 * rifiutare il valore nuovo — «non è nel vocabolario di questo cliente» — e ad
 * accettare quello appena rimosso, scrivendolo sui ticket, **fino al riavvio**.
 * Nei worker, che non servono mai queste mutation, per sempre.
 *
 * `invalidateSchema` è la leva unica: svuota tutti i clearer registrati in
 * questo processo (vocabolari, matrici, etichette dei CI, schema…) e pubblica
 * sul canale Redis del metamodello perché gli altri processi svuotino i loro.
 */
function vocabularyChanged(tenantId: string): void {
  invalidateSchema(tenantId)
}

interface EnumTypeDef {
  id:        string
  tenantId:  string
  name:      string
  label:     string
  values:    string[]
  isSystem:  boolean
  /** `tenant_id = 'system'`: spedito col prodotto, uguale per tutti i clienti. */
  isShipped: boolean
  /**
   * Il valore da usare quando nessuno lo indica. `null` = non dichiarato.
   *
   * Serve a togliere una regola di dominio dalla POSIZIONE (revisione delle
   * otto ondate · C·N-2): `initialCIStatus` prendeva il **primo** valore della
   * lista, e siccome il Dizionario sapeva solo aggiungere in coda, rinominare
   * un valore lo spostava in fondo — un CI nuovo nasceva `inactive`, cioè
   * subito escluso dalla salute dei servizi. «Con che valore nasce» è un
   * default, non una posizione: adesso si dichiara.
   */
  defaultValue: string | null
  scope:     string
  createdAt: string
  updatedAt: string
}

/**
 * I vocabolari i cui valori **non sono del cliente** (revisione delle otto
 * ondate · C·N-5).
 *
 * `event_severity` è la severità che i sistemi di monitoraggio **mandano**: è
 * il vocabolario del protocollo in ingresso, e il codice che normalizza gli
 * allarmi produce esattamente `info | warning | critical`
 * (`lib/eventVocabularies.ts`). Il Dizionario però lo offriva come qualunque
 * altro, la mutation lo accettava, e l'ingest lo rifiutava: un cliente che lo
 * rinominava vedeva la matrice pretendere i nomi nuovi e gli allarmi arrivare
 * coi vecchi — nessuna delle tre parti avvisava. Il revisore l'ha chiamato «un
 * vocabolario finto», e aveva ragione.
 *
 * La scelta: si **vede** (è utile sapere cosa mandano le sorgenti) ma i suoi
 * valori non si toccano, e il rifiuto dice dov'è la manopola vera — la matrice
 * «Severità allarme → Severità incident», dove il cliente decide cosa
 * diventano. L'etichetta resta modificabile: è testo per gli umani.
 */
export const WIRE_VOCABULARIES: Readonly<Record<string, string>> = {
  event_severity:
    'è la severità che mandano i sistemi di monitoraggio (il prodotto normalizza gli allarmi a info, warning, critical): ' +
    'cambiarne i valori non cambia quello che arriva, e fa smettere di funzionare la traduzione. ' +
    'Quello che decidi tu è in quale severità di incident si traducono: Impostazioni → Matrici di dominio, ' +
    'matrice «event_severity».',
}

/** Un vocabolario del protocollo in ingresso non cambia valori: dice perché, e dov'è la manopola. */
function assertVocabularyEditable(name: string, what: string): void {
  const reason = WIRE_VOCABULARIES[name]
  if (reason === undefined) return
  throw new ValidationError(`${what}: il vocabolario "${name}" ${reason}`)
}

/**
 * I valori di un vocabolario: una lista di stringhe, o un errore che nomina il
 * nodo. Vedi A-18.
 */
function assertEnumValues(vals: unknown, tenantId: unknown, name: unknown): string[] {
  if (Array.isArray(vals) && vals.every((v) => typeof v === 'string')) return vals as string[]
  throw new Error(
    `EnumTypeDefinition ${String(tenantId)}/${String(name)}: "values" non è una lista di stringhe ` +
    `(${typeof vals === 'string' ? 'è una stringa' : typeof vals}). ` +
    `Esegui la migrazione 20260918_1910_provision_tenant_data, che normalizza i vocabolari scritti come stringa JSON.`,
  )
}

function mapEnum(r: { get: (k: string) => unknown }): EnumTypeDef {
  const vals     = r.get('values')
  const tenantId = r.get('tenantId') as string
  return {
    id:        r.get('id')        as string,
    tenantId,
    name:      r.get('name')      as string,
    label:     r.get('label')     as string,
    // A-18: `values` è una lista, sempre. Il ripiego `JSON.parse` copriva UN
    // nodo (`ci_chain`, scritto come stringa JSON dal seed del metamodello) e
    // nascondeva l'incoerenza a tutti: il seed ora scrive una lista e la
    // migrazione 20260918_1910 normalizza il nodo esistente, quindi una
    // stringa qui è un dato rotto e va detto, non indovinato.
    values:    assertEnumValues(vals, tenantId, r.get('name')),
    isSystem:  r.get('isSystem')  as boolean,
    // `is_system` è un flag di protezione scritto anche sulle copie per tenant
    // (A-3): il proprietario si legge dal tenant, non da quel flag.
    isShipped: tenantId === SYSTEM_TENANT,
    defaultValue: (r.get('defaultValue') ?? null) as string | null,
    scope:     r.get('scope')     as string,
    createdAt: r.get('createdAt') as string,
    updatedAt: r.get('updatedAt') as string,
  }
}

export async function enumTypes(
  _: unknown,
  args: { scope?: string },
  ctx: GraphQLContext,
): Promise<EnumTypeDef[]> {
  const session = getSession(undefined, 'READ')
  try {
    // Isolamento (A-3/D-5): `is_system` è un flag di PROTEZIONE scritto sugli
    // enum seminati in OGNI tenant, non un flag di visibilità. Il predicato
    // storico (`OR e.is_system = true`) mostrava quindi a ogni tenant i
    // vocabolari di tutti gli altri. Visibile = il proprio tenant, oppure il
    // tenant condiviso `system`.
    const conditions = ['(e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = \'system\'))']
    const params: Record<string, unknown> = { tenantId: ctx.tenantId }
    if (args.scope) {
      conditions.push('(e.scope = $scope OR e.scope = "shared")')
      params['scope'] = args.scope
    }
    const result = await session.executeRead((tx) =>
      tx.run(`
        // Il WHERE interpolato parte dal predicato di visibilita' (conditions, riga
        // 54): proprio tenant, oppure il tenant condiviso 'system'.
        // tenant-ok: filtro di tenant sempre in testa a conditions.
        MATCH (e:EnumTypeDefinition)
        WHERE ${conditions.join(' AND ')}
        RETURN e.id        AS id,
               e.tenant_id AS tenantId,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.is_system AS isSystem,
               e.scope     AS scope,
               e.default_value AS defaultValue,
               e.created_at AS createdAt,
               e.updated_at AS updatedAt
        ORDER BY e.scope, e.name
      `, params),
    )
    return result.records.map(mapEnum)
  } finally {
    await session.close()
  }
}

export async function enumType(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<EnumTypeDef | null> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')
        RETURN e.id        AS id,
               e.tenant_id AS tenantId,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.is_system AS isSystem,
               e.scope     AS scope,
               e.default_value AS defaultValue,
               e.created_at AS createdAt,
               e.updated_at AS updatedAt
      `, { id: args.id, tenantId: ctx.tenantId }),
    )
    return result.records.length ? mapEnum(result.records[0]) : null
  } finally {
    await session.close()
  }
}

export async function createEnumType(
  _: unknown,
  args: { input: { name: string; label: string; values: string[]; scope: string } },
  ctx: GraphQLContext,
): Promise<EnumTypeDef> {
  if (ctx.role !== 'admin') throw new ForbiddenError()
  const { input } = args
  if (!input.name.match(/^[a-z][a-z0-9_]*$/)) {
    throw new ValidationError('name must be snake_case (lowercase letters, numbers, underscores)')
  }
  if (input.values.length === 0) {
    throw new ValidationError('values must contain at least one entry')
  }
  const VALID_SCOPES = ['itil', 'cmdb', 'shared'] as const
  if (!VALID_SCOPES.includes(input.scope as typeof VALID_SCOPES[number])) {
    throw new ValidationError(`scope must be one of: ${VALID_SCOPES.join(', ')}`)
  }

  const id  = uuidv4()
  const now = new Date().toISOString()

  const session = getSession(undefined, 'WRITE')
  try {
    // D-17: era «leggi, poi crea» in DUE transazioni — due «Salva» ravvicinati
    // (doppio clic, due admin) passavano entrambi il controllo e creavano due
    // vocabolari omonimi, che `loadMetamodel` poi scarta a metà in silenzio.
    // Qui la creazione è UNA scrittura idempotente: il MERGE sulla chiave
    // naturale (tenant_id, name) regge la corsa — il vincolo di unicità in
    // `packages/neo4j/src/init.ts` la fa reggere anche fra processi — e chi
    // arriva secondo lo scopre dall'`id` che torna diverso dal suo.
    let createdId: string
    try {
      const res = await session.executeWrite((tx) =>
        tx.run(`
          MERGE (e:EnumTypeDefinition {tenant_id: $tenantId, name: $name})
          ON CREATE SET
            e.id         = $id,
            e.label      = $label,
            e.values     = $values,
            e.is_system  = false,
            e.scope      = $scope,
            e.created_at = $now,
            e.updated_at = $now
          RETURN e.id AS id
        `, { id, tenantId: ctx.tenantId, name: input.name, label: input.label, values: input.values, scope: input.scope, now }),
      )
      createdId = res.records[0]!.get('id') as string
    } catch (err) {
      // Corsa persa contro un altro processo: il vincolo ha parlato. Lo stesso
      // rifiuto di sempre, non un errore interno.
      if (String(err).includes('already exists') || String(err).includes('ConstraintValidationFailed')) {
        throw new ValidationError(`An enum type named "${input.name}" already exists for this tenant`)
      }
      throw err
    }
    if (createdId !== id) {
      throw new ValidationError(`An enum type named "${input.name}" already exists for this tenant`)
    }

    vocabularyChanged(ctx.tenantId)
    void audit(ctx, 'enum_type.created', 'EnumTypeDefinition', id, { name: input.name })

    return {
      id, tenantId: ctx.tenantId, name: input.name, label: input.label,
      values: input.values, isSystem: false, isShipped: false, scope: input.scope,
      defaultValue: null,
      createdAt: now, updatedAt: now,
    }
  } finally {
    await session.close()
  }
}

/**
 * «Personalizza» un vocabolario spedito col prodotto: copia su scrittura.
 *
 * Un vocabolario `tenant_id = 'system'` è UN nodo per tutti i clienti, quindi
 * non si modifica in posto (`updateEnumType` scrive solo su
 * `{id, tenant_id: $tenantId}` e fallirebbe). La personalizzazione è una copia
 * con lo STESSO nome sul tenant: `loadTenantEnumOverrides` la fa vincere in
 * lettura per chi la possiede, e solo per lui (lib/enumScope.ts).
 *
 * Se il tenant ha già un vocabolario con quel nome la copia non si fa: sarebbe
 * un doppione e la sua sarebbe comunque già quella che vince. L'errore lo dice.
 */
export async function customizeEnumType(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<EnumTypeDef> {
  if (ctx.role !== 'admin') throw new ForbiddenError()
  if (ctx.tenantId === SYSTEM_TENANT) {
    throw new ValidationError('Il tenant di sistema non personalizza i vocabolari spediti: li modifica il prodotto.')
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const src = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id IN [$tenantId, $systemTenant]
        RETURN e.tenant_id AS tenantId, e.name AS name, e.label AS label,
               e.values AS values, e.scope AS scope, e.default_value AS defaultValue
      `, { id: args.id, tenantId: ctx.tenantId, systemTenant: SYSTEM_TENANT }),
    )
    if (!src.records.length) throw new NotFoundError('EnumTypeDefinition', args.id)

    const row       = src.records[0]!
    const ownerId   = row.get('tenantId') as string
    const name      = row.get('name')     as string
    const rawValues = row.get('values')
    const values    = Array.isArray(rawValues) ? rawValues as string[] : JSON.parse(rawValues as string) as string[]

    if (ownerId !== SYSTEM_TENANT) {
      throw new ValidationError(
        `Il vocabolario "${name}" è già tuo: modificalo direttamente, non c'è niente da personalizzare.`,
      )
    }

    const existing = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {name: $name, tenant_id: $tenantId})
        RETURN e.id AS id LIMIT 1
      `, { name, tenantId: ctx.tenantId }),
    )
    if (existing.records.length) {
      throw new ValidationError(
        `Hai già un vocabolario "${name}" (${existing.records[0]!.get('id') as string}): è quello che vince in lettura per te. ` +
        `Modifica quello invece di crearne un altro.`,
      )
    }

    const id  = uuidv4()
    const now = new Date().toISOString()
    const created = await session.executeWrite((tx) =>
      tx.run(`
        CREATE (e:EnumTypeDefinition {
          id:         $id,
          tenant_id:  $tenantId,
          name:       $name,
          label:      $label,
          values:     $values,
          is_system:  false,
          scope:      $scope,
          // La copia porta anche il valore di default: senza, personalizzare un
          // vocabolario ne perderebbe il default e initialCIStatus ripiegherebbe
          // sul primo valore, cioe' il difetto che il default chiude.
          default_value: $defaultValue,
          created_at: $now,
          updated_at: $now
        })
        RETURN e.id        AS id,
               e.tenant_id AS tenantId,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.is_system AS isSystem,
               e.scope     AS scope,
               e.default_value AS defaultValue,
               e.created_at AS createdAt,
               e.updated_at AS updatedAt
      `, {
        id, tenantId: ctx.tenantId, name,
        label: row.get('label') as string, values,
        scope: row.get('scope') as string, now,
        defaultValue: (row.get('defaultValue') ?? null) as string | null,
      }),
    )
    if (!created.records.length) throw new Error(`customizeEnumType("${name}"): la CREATE non ha restituito il nodo`)

    vocabularyChanged(ctx.tenantId)
    void audit(ctx, 'enum_type.customized', 'EnumTypeDefinition', id, { name, shippedId: args.id })
    return mapEnum(created.records[0]!)
  } finally {
    await session.close()
  }
}

/**
 * Modifica un vocabolario del tenant.
 *
 * ## Togliere un valore, ondata 7 · B7-2 / A-13
 * Prima `values` veniva sostituito **in blocco**: nessun conteggio, e i record
 * restavano nel grafo con un valore che il vocabolario non aveva più (il form
 * mostrava il campo vuoto, i filtri per valore non lo offrivano più, i
 * conteggi lo perdevano — tutto in silenzio; dal vivo 68 CI su c-one).
 *
 * Adesso: si calcola quali valori sparirebbero, si contano gli usi
 * (`lib/enumValueUsage.ts`: i record di ogni tipo il cui campo usa questo
 * vocabolario, **più** la semantica del ciclo di vita sulla policy degli
 * allarmi) e si **rifiuta** dicendo quanti e dove. Per procedere si passa una
 * sostituzione esplicita — `input.replacements: [{from, to}]` — e i record
 * vengono riscritti **nella stessa transazione** del vocabolario, con audit.
 *
 * Perché non riscrivere da soli senza chiedere: cambiare il valore di decine
 * di record è una modifica ai *dati*, e farla come effetto collaterale di una
 * modifica al Dizionario sarebbe lo stesso genere di silenzio.
 */
export async function updateEnumType(
  _: unknown,
  args: { id: string; input: { label?: string; values?: string[]; scope?: string; defaultValue?: string; replacements?: { from: string; to: string }[] } },
  ctx: GraphQLContext,
): Promise<EnumTypeDef> {
  if (ctx.role !== 'admin') throw new ForbiddenError()
  const { id, input } = args

  const session = getSession(undefined, 'WRITE')
  try {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')
        RETURN e.is_system AS isSystem, e.tenant_id AS tenantId, e.name AS name, e.values AS values
      `, { id, tenantId: ctx.tenantId }),
    )
    if (!check.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    const isSystem = check.records[0]!.get('isSystem') as boolean

    // A1-1: un vocabolario spedito è UN nodo per tutti i clienti. La scrittura
    // (`{id, tenant_id: $tenantId}`) non lo trovava e finiva in un NotFound
    // opaco: adesso dice qual è la strada — `customizeEnumType` ne crea la
    // copia del tenant, che vince in lettura solo per chi la possiede.
    if ((check.records[0]!.get('tenantId') as string) === SYSTEM_TENANT) {
      throw new ValidationError(
        `Il vocabolario "${check.records[0]!.get('name') as string}" è spedito col prodotto: è lo stesso per tutti i clienti ` +
        `e non si modifica in posto. Usa "Personalizza" (customizeEnumType) per averne una copia tua e modificare quella.`,
      )
    }

    if (isSystem && input.scope) {
      throw new ValidationError('Cannot change scope of system enum types')
    }
    if (input.values) {
      assertVocabularyEditable(check.records[0]!.get('name') as string, 'Cambiare i valori')
    }

    // ── Valori che sparirebbero (B7-2) ────────────────────────────────────
    const name       = check.records[0]!.get('name') as string
    const rawCurrent = check.records[0]!.get('values')
    const current    = Array.isArray(rawCurrent) ? rawCurrent as string[] : JSON.parse(String(rawCurrent)) as string[]
    const next       = input.values ?? current
    const removed    = current.filter((v) => !next.includes(v))
    const replacements = input.replacements ?? []

    for (const r of replacements) {
      if (!removed.includes(r.from)) {
        throw new ValidationError(
          `replacements: "${r.from}" non è fra i valori che stai togliendo da "${name}" (${removed.length ? removed.join(', ') : 'nessuno'}).`,
        )
      }
      if (!next.includes(r.to)) {
        throw new ValidationError(
          `replacements: il valore di sostituzione "${r.to}" non è fra i valori nuovi di "${name}" (${next.join(', ')}).`,
        )
      }
    }
    const replaced = new Map(replacements.map((r) => [r.from, r.to]))
    const orphaned = removed.filter((v) => !replaced.has(v))
    if (orphaned.length) {
      const usages = await countEnumValueUsage(session, ctx.tenantId, name, orphaned)
      if (usages.length) throw new ValidationError(enumValueUsageMessage(name, usages))
    }

    // Il valore di default deve stare fra i valori NUOVI: un default fuori
    // vocabolario è il difetto che il default esiste per chiudere.
    if (input.defaultValue !== undefined && !next.includes(input.defaultValue)) {
      throw new ValidationError(
        `Il valore di default "${input.defaultValue}" non è fra i valori di "${name}" (${next.join(', ')}).`,
      )
    }

    const now = new Date().toISOString()
    const result = await session.executeWrite(async (tx) => {
      // La riscrittura dei record e quella del vocabolario nella STESSA
      // transazione: non esiste un istante in cui i record puntano a un valore
      // che il vocabolario non ha.
      for (const [from, to] of replaced) {
        const touched = await replaceEnumValue(tx, ctx.tenantId, name, from, to)
        void audit(ctx, 'enum_type.value_replaced', 'EnumTypeDefinition', id, { name, from, to, records: touched })
      }
      return tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
        SET e.label      = coalesce($label, e.label),
            e.values     = coalesce($values, e.values),
            e.scope      = CASE WHEN $scope IS NOT NULL AND NOT e.is_system THEN $scope ELSE e.scope END,
            e.default_value = coalesce($defaultValue, e.default_value),
            e.updated_at = $now
        RETURN e.id        AS id,
               e.tenant_id AS tenantId,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.is_system AS isSystem,
               e.scope     AS scope,
               e.default_value AS defaultValue,
               e.created_at AS createdAt,
               e.updated_at AS updatedAt
      `, {
        id,
        tenantId: ctx.tenantId,
        label:  input.label  ?? null,
        values: input.values ?? null,
        scope:  input.scope  ?? null,
        defaultValue: input.defaultValue ?? null,
        now,
      })
    })

    if (!result.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    vocabularyChanged(ctx.tenantId)
    void audit(ctx, 'enum_type.updated', 'EnumTypeDefinition', id, { label: input.label, removed, replacements })
    return mapEnum(result.records[0])
  } finally {
    await session.close()
  }
}

export async function deleteEnumType(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<boolean> {
  if (ctx.role !== 'admin') throw new ForbiddenError()

  const session = getSession(undefined, 'WRITE')
  try {
    // Check exists + not system
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
        // Qui si CONTA chi usa il vocabolario del tenant prima di cancellarlo,
        // e vanno contati anche i campi condivisi che ci fossero agganciati (è
        // il caso che l'ondata 1 chiude): filtrare i campi per tenant farebbe
        // cancellare un vocabolario ancora in uso.
        // tenant-ok: il vocabolario e è già vincolato a $tenantId dal MATCH sopra.
        OPTIONAL MATCH (f:CIFieldDefinition)-[:USES_ENUM]->(e)
        // Il vocabolario SPEDITO con lo stesso nome: cancellare la copia del
        // cliente lo rimette in gioco (vince per nome, lib/enumScope.ts).
        // tenant-ok: shipped è vincolato al tenant condiviso per definizione.
        OPTIONAL MATCH (shipped:EnumTypeDefinition {name: e.name, tenant_id: 'system'})
        RETURN e.is_system AS isSystem, e.name AS name, e.values AS values,
               count(f) AS usageCount, head(collect(shipped.values)) AS shippedValues
      `, { id: args.id, tenantId: ctx.tenantId }),
    )
    if (!check.records.length) throw new NotFoundError('EnumTypeDefinition', args.id)
    const isSystem   = check.records[0]!.get('isSystem') as boolean
    // `count(...)` non è sempre un `Integer` del driver: dipende dalla
    // configurazione del driver e dal percorso (dentro una `CALL { … }`, o con
    // una sessione finta nei test, è un `number` normale). `.toNumber()` su un
    // numero non esiste, e la cancellazione moriva con
    // «get(...).toNumber is not a function» — su QUALUNQUE vocabolario, anche
    // uno non usato da nessuno. Il repo ha già il convertitore giusto
    // (`toNumber` di @opengraphity/neo4j), che accetta entrambe le forme.
    const usageCount = toNumber(check.records[0]!.get('usageCount'))

    if (isSystem) {
      throw new ValidationError('System enum types cannot be deleted')
    }
    if (usageCount > 0) {
      throw new ValidationError(`Enum in use by ${usageCount} field${usageCount > 1 ? 's' : ''}`)
    }

    // ── Ondata 7 · B7-2: cancellare la copia del cliente NON è mai silenzioso
    //
    // `usageCount` conta solo i campi agganciati a QUESTO nodo. Ma un
    // vocabolario del cliente vince **per nome** (lib/enumScope.ts), e dal
    // vivo i campi condivisi sono agganciati ai nodi di un altro cliente
    // (C-6): quel conteggio è quindi zero anche quando la cancellazione
    // cambia davvero il vocabolario di un campo. Tornare a quello spedito è
    // legittimo — è il modo di annullare una personalizzazione — ma non deve
    // far sparire in silenzio i valori che il cliente aveva AGGIUNTO e che
    // stanno ancora su dei record (o nella semantica del ciclo di vita).
    const name   = check.records[0]!.get('name') as string
    const rawOwn = check.records[0]!.get('values')
    const own    = Array.isArray(rawOwn) ? rawOwn as string[] : JSON.parse(String(rawOwn)) as string[]
    const rawShipped = check.records[0]!.get('shippedValues')
    const shipped = rawShipped == null ? []
      : Array.isArray(rawShipped) ? rawShipped as string[] : JSON.parse(String(rawShipped)) as string[]
    const lost = own.filter((v) => !shipped.includes(v))
    if (lost.length) {
      const usages = await countEnumValueUsage(session, ctx.tenantId, name, lost)
      if (usages.length) {
        throw new ValidationError(
          `Cancellare il tuo vocabolario "${name}" lo riporterebbe a quello spedito col prodotto` +
          `${shipped.length ? ` (${shipped.join(', ')})` : ' (che non esiste: nessun valore resterebbe)'}, ` +
          `e questi valori tuoi sono ancora in uso: ` +
          usages.map((u) => `"${u.value}" (${[
            ...u.records.map((r) => `${String(r.count)} ${r.typeName}.${r.fieldName}`),
            ...u.policyLists.map((l) => `policy degli allarmi: ${l}`),
          ].join(', ')})`).join('; ') +
          `. Cambia prima quei record, oppure togli i valori uno per uno con updateEnumType ` +
          `(che accetta un valore di sostituzione).`,
        )
      }
    }

    await session.executeWrite((tx) =>
      tx.run(`MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId}) DETACH DELETE e`,
        { id: args.id, tenantId: ctx.tenantId }),
    )

    vocabularyChanged(ctx.tenantId)
    void audit(ctx, 'enum_type.deleted', 'EnumTypeDefinition', args.id)
    return true
  } finally {
    await session.close()
  }
}

/**
 * **Rinominare** un valore, che finora era un'operazione che il prodotto non
 * aveva (revisione delle otto ondate · C·N-2 — il difetto centrale del
 * programma).
 *
 * ## Cosa faceva il cliente, e cosa succedeva
 * Il Dizionario sapeva solo `addValue` (in coda) e `removeValue`. Rinominare
 * era quindi togliere + aggiungere, cioè **spostare il valore in fondo**. E
 * tre regole di dominio leggevano il vocabolario per POSIZIONE. Misurato dal
 * vivo, con la mutation vera:
 *
 *     risk_band  rinomino low→basso  ⇒ ["medium","high","basso"]
 *       riskBandOf(10) [rischio BASSO] = "medium"   ← era "low"
 *       riskBandOf(80) [rischio ALTO ] = "basso"    ← era "high"
 *     ci_status  rinomino active→attivo
 *       initialCIStatus = "inactive"   ← un CI NUOVO nasce fuori servizio
 *     impact     rinomino low→basso
 *       criticalServiceCriticalities = []   ← il banner dei servizi critici si spegne
 *
 * Tutte e tre silenziose, tutte su strada dritta. E senza uscita: per rimettere
 * il valore in testa bisognava togliere e riaggiungere gli altri, ma togliere
 * un valore in uso è (giustamente) rifiutato.
 *
 * ## Cos'è una rinomina, per davvero
 * Un solo comando che tiene insieme cinque cose, **nella stessa transazione**:
 *  1. il valore nella lista, **al suo posto** (non in coda);
 *  2. i record che lo portano (`replaceEnumValue`, che ora conosce anche i
 *     vocabolari di dominio senza `USES_ENUM`);
 *  3. le liste della policy degli allarmi e la `severity_map`;
 *  4. le chiavi e le celle delle **matrici di dominio** — senza questo la
 *     rinomina rompeva la matrice e ogni apertura di incident si fermava;
 *  5. il valore di default del vocabolario, se era quello.
 *
 * Non è una scorciatoia per «togli + aggiungi»: è l'operazione che il cliente
 * intendeva fare, e che prima doveva improvvisare.
 */
export async function renameEnumValue(
  _: unknown,
  args: { id: string; from: string; to: string },
  ctx: GraphQLContext,
): Promise<EnumTypeDef> {
  if (ctx.role !== 'admin') throw new ForbiddenError()
  const { id } = args
  const from = args.from.trim()
  const to   = args.to.trim()
  if (to === '') throw new ValidationError('Il valore nuovo non può essere vuoto.')

  const session = getSession(undefined, 'WRITE')
  try {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')
        RETURN e.tenant_id AS tenantId, e.name AS name, e.values AS values, e.default_value AS defaultValue
      `, { id, tenantId: ctx.tenantId }),
    )
    if (!check.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    const row  = check.records[0]!
    const name = row.get('name') as string

    if ((row.get('tenantId') as string) === SYSTEM_TENANT) {
      throw new ValidationError(
        `Il vocabolario "${name}" è spedito col prodotto: è lo stesso per tutti i clienti e non si modifica in posto. ` +
        `Usa "Personalizza" per averne una copia tua, e rinomina i valori su quella.`,
      )
    }
    assertVocabularyEditable(name, `Rinominare "${from}" in "${to}"`)

    const rawValues = row.get('values')
    const current = Array.isArray(rawValues) ? rawValues as string[] : JSON.parse(String(rawValues)) as string[]
    const at = current.indexOf(from)
    if (at === -1) {
      throw new ValidationError(
        `Il valore "${from}" non è fra quelli di "${name}" (${current.join(', ')}): non c'è niente da rinominare.`,
      )
    }
    if (from === to) throw new ValidationError(`Il valore "${from}" si chiama già così.`)
    if (current.includes(to)) {
      throw new ValidationError(
        `"${name}" ha già un valore "${to}". Rinominare "${from}" in "${to}" unirebbe due valori distinti in uno, ` +
        `e i record del primo diventerebbero del secondo senza che nessuno l'abbia chiesto. ` +
        `Se è quello che vuoi, togli "${from}" indicando "${to}" come sostituzione (updateEnumType).`,
      )
    }

    const next = [...current]
    next[at] = to
    const now = new Date().toISOString()

    const result = await session.executeWrite(async (tx) => {
      // I record, la policy e le matrici PRIMA: se qualcosa qui lancia, il
      // vocabolario non è ancora cambiato e non resta niente a metà.
      const touched = await replaceEnumValue(tx, ctx.tenantId, name, from, to)
      void audit(ctx, 'enum_type.value_renamed', 'EnumTypeDefinition', id, { name, from, to, records: touched })
      return tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
        SET e.values        = $values,
            e.default_value = CASE WHEN e.default_value = $from THEN $to ELSE e.default_value END,
            e.updated_at    = $now
        RETURN e.id        AS id,
               e.tenant_id AS tenantId,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.is_system AS isSystem,
               e.scope     AS scope,
               e.default_value AS defaultValue,
               e.created_at AS createdAt,
               e.updated_at AS updatedAt
      `, { id, tenantId: ctx.tenantId, values: next, from, to, now })
    })
    if (!result.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    vocabularyChanged(ctx.tenantId)
    return mapEnum(result.records[0]!)
  } finally {
    await session.close()
  }
}

/**
 * **Riordinare** i valori: l'altra metà della rinomina (revisione · C·N-2).
 *
 * Per i vocabolari di scala l'ordine PORTA SIGNIFICATO — `impact` va dal più
 * basso al più alto, e «l'impatto più alto» è l'ultimo valore — ma non era
 * modificabile: il Dizionario aggiungeva solo in coda. Un cliente che avesse
 * aggiunto una severità intermedia non poteva metterla al suo posto.
 *
 * Qui si cambia **solo** l'ordine: lo stesso insieme di valori, permutato. Un
 * insieme diverso è un errore che rimanda alle operazioni giuste, perché
 * togliere un valore ha un conteggio e una sostituzione da rispettare, e
 * aggiungerne uno no — confonderli qui vorrebbe dire aggirarli.
 */
export async function reorderEnumValues(
  _: unknown,
  args: { id: string; values: string[] },
  ctx: GraphQLContext,
): Promise<EnumTypeDef> {
  if (ctx.role !== 'admin') throw new ForbiddenError()
  const { id, values } = args

  const session = getSession(undefined, 'WRITE')
  try {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')
        RETURN e.tenant_id AS tenantId, e.name AS name, e.values AS values
      `, { id, tenantId: ctx.tenantId }),
    )
    if (!check.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    const row  = check.records[0]!
    const name = row.get('name') as string
    if ((row.get('tenantId') as string) === SYSTEM_TENANT) {
      throw new ValidationError(
        `Il vocabolario "${name}" è spedito col prodotto: usa "Personalizza" per averne una copia tua e riordinare quella.`,
      )
    }
    assertVocabularyEditable(name, 'Riordinare i valori')
    const rawValues = row.get('values')
    const current = Array.isArray(rawValues) ? rawValues as string[] : JSON.parse(String(rawValues)) as string[]

    const sortedA = [...current].sort()
    const sortedB = [...values].sort()
    if (values.length !== current.length || sortedA.some((v, i) => v !== sortedB[i])) {
      const missing = current.filter((v) => !values.includes(v))
      const extra   = values.filter((v) => !current.includes(v))
      throw new ValidationError(
        `Il riordino cambia solo l'ORDINE dei valori di "${name}", non l'insieme` +
        (missing.length ? `; mancano: ${missing.join(', ')}` : '') +
        (extra.length   ? `; in più: ${extra.join(', ')}`   : '') +
        `. Per aggiungere o togliere un valore usa la modifica del vocabolario (che conta chi lo usa), ` +
        `per cambiargli nome la rinomina.`,
      )
    }

    const result = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
        SET e.values = $values, e.updated_at = $now
        RETURN e.id        AS id,
               e.tenant_id AS tenantId,
               e.name      AS name,
               e.label     AS label,
               e.values    AS values,
               e.is_system AS isSystem,
               e.scope     AS scope,
               e.default_value AS defaultValue,
               e.created_at AS createdAt,
               e.updated_at AS updatedAt
      `, { id, tenantId: ctx.tenantId, values, now: new Date().toISOString() }),
    )
    if (!result.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    vocabularyChanged(ctx.tenantId)
    void audit(ctx, 'enum_type.values_reordered', 'EnumTypeDefinition', id, { name, values })
    return mapEnum(result.records[0]!)
  } finally {
    await session.close()
  }
}

export const enumTypeResolvers = {
  Query:    { enumTypes, enumType },
  Mutation: { createEnumType, updateEnumType, deleteEnumType, customizeEnumType, renameEnumValue, reorderEnumValues },
}
