import { v4 as uuidv4 } from 'uuid'
import { getSession, toNumber } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { SYSTEM_TENANT } from '../../lib/enumScope.js'
import { countEnumValueUsage, enumValueUsageMessage, replaceEnumValue } from '../../lib/enumValueUsage.js'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'
import {
  type EnumValueLabelEntry, type EnumValueLabels, type Lingua,
  LINGUE,
  parseValueLabels, valueLabelEntries, pruneValueLabels, renameValueLabel, serializeValueLabels,
  valueLabelsReasonKey,
} from '../../lib/enumValueLabels.js'
import {
  parseValueColors, valueColorEntries, renameValueColor, pruneValueColors, serializeValueColors, assertValueColorsInput,
  type EnumValueColors, type EnumValueColorEntry,
} from '../../lib/enumValueColors.js'
import { languageFor } from '../../lib/tenantLanguage.js'
import { logger } from '../../lib/logger.js'
import { newShippedValues, vocabulariesBehindShipped } from '../../lib/vocabularyShippedDrift.js'
import { requirePermission } from '../../lib/permissions.js'

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
  /** Le etichette come stanno sul nodo: valore → lingua → etichetta. Risolte dal field resolver. */
  valueLabelsRaw: EnumValueLabels
  /** I colori per valore, nell'ordine dei valori (revisione del 14 set 2026 · F9). */
  valueColors: EnumValueColorEntry[]
  /** Perche non porta etichette per valore (chiave i18n), `null` se le porta. */
  valueLabelsReasonKey: string | null
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
/*
  IL MOTIVO È UNA CHIAVE, non un paragrafo.
  Era un paragrafo italiano in questa costante, incollato nel messaggio e
  passato al client come parametro: prosa travestita da dato, che in
  un'interfaccia inglese restava italiana. Qui resta la versione inglese per i
  log, e la chiave per chi ha una lingua.
*/
export const WIRE_VOCABULARIES: Readonly<Record<string, { reason: string; reasonKey: string }>> = {
  event_severity: {
    reason:
      'is the severity the monitoring systems send (the product normalizes alarms to info, warning, critical): '
      + 'changing its values does not change what arrives, and breaks the translation. '
      + 'What you decide is which incident severity they translate into: Settings → Domain matrices, '
      + 'matrix «event_severity».',
    reasonKey: 'errors.enum.wireReason.event_severity',
  },
}

/** Un vocabolario del protocollo in ingresso non cambia valori: dice perché, e dov'è la manopola. */
function assertVocabularyEditable(name: string, opKey: string, opParams: Record<string, string> = {}): void {
  const wire = WIRE_VOCABULARIES[name]
  if (wire === undefined) return
  throw new ValidationError(
    `${opKey}: dictionary "${name}" ${wire.reason}`,
    { key: 'errors.enum.wireVocabulary', params: { name, opKey, reasonKey: wire.reasonKey, ...opParams } },
  )
}

/**
 * I valori di un vocabolario: una lista di stringhe, o un errore che nomina il
 * nodo. Vedi A-18.
 */
/**
 * I valori che un vocabolario puo avere (terza revisione · M7/M10).
 *
 * `createEnumType` rifiutava la lista vuota; `updateEnumType` NO — scriveva
 * `values: input.values ?? null` senza guardare. Via API (che questo repo
 * definisce «una strada documentata, usata da script e integrazioni») un
 * vocabolario si svuotava, e da li in poi:
 *   - `assertDomainValue` rifiuta OGNI valore, quindi non si apre piu un ticket;
 *   - la diagnostica accusa la MATRICE («9 chiavi rimaste da una rinomina»),
 *     perche il prodotto cartesiano di una lista vuota e vuoto, e manda
 *     l'admin a una pagina dove un «Salva» cancella tutte le celle;
 *   - del vocabolario vuoto, che e il problema vero, nessuno dice niente.
 * Si chiude all'origine: un vocabolario senza valori non esiste.
 *
 * E i duplicati: `['a','a']` passava, e un valore due volte nella scala rende
 * ambigua la POSIZIONE, che in questo prodotto e una regola di dominio.
 */
function assertValuesUsable(values: readonly string[], name: string): void {
  if (values.length === 0) {
    throw new ValidationError(
      `Dictionary "${name}" cannot be left without values: no record could be created any more, `
      + `because every value would be rejected as out of vocabulary. If it is no longer needed, `
      + `delete it (deleteEnumType); if you are rewriting the scale, send it whole.`,
      { key: 'errors.enum.noValues', params: { name } },
    )
  }
  const vuoti = values.filter((v) => v.trim() === '')
  if (vuoti.length) {
    throw new ValidationError(`Dictionary "${name}" has ${String(vuoti.length)} empty value(s): every value needs a name.`, { key: 'errors.enum.emptyValues', params: { name, count: vuoti.length } })
  }
  const visti = new Set<string>()
  const doppi = values.filter((v) => (visti.has(v) ? true : (visti.add(v), false)))
  if (doppi.length) {
    throw new ValidationError(
      `Dictionary "${name}" repeats ${[...new Set(doppi)].map((v) => `"${v}"`).join(', ')}: `
      + `in a scale the position is a domain rule (the first value is the lowest, the last the `
      + `highest), and a repeated value makes it ambiguous.`,
      { key: 'errors.enum.duplicateValues', params: { name, values: [...new Set(doppi)].join(', ') } },
    )
  }
}

function assertEnumValues(vals: unknown, tenantId: unknown, name: unknown): string[] {
  if (Array.isArray(vals) && vals.every((v) => typeof v === 'string')) return vals as string[]
  throw new Error(
    `EnumTypeDefinition ${String(tenantId)}/${String(name)}: "values" is not a list of strings ` +
    `(${typeof vals === 'string' ? 'it is a string' : typeof vals}). ` +
    `Run the 20260918_1910_provision_tenant_data migration, which normalizes dictionaries written as a JSON string.`,
  )
}

/**
 * La lingua chiesta, o un rifiuto che dice quali ci sono. Non si ripiega in
 * silenzio su `it`: chi manda `de` sta scrivendo un'etichetta che nessuno
 * leggerebbe mai, e va detto invece di salvarla come italiana.
 */
function assertLingua(v: unknown): Lingua {
  if (typeof v === 'string' && (LINGUE as readonly string[]).includes(v)) return v as Lingua
  throw new ValidationError(
    `Language "${String(v)}" not recognised: the product has ${LINGUE.join(', ')}.`,
    { key: 'errors.enum.unknownLanguage', params: { language: String(v), available: LINGUE.join(', ') } },
  )
}

function mapEnum(r: { get: (k: string) => unknown }): EnumTypeDef {
  const vals     = r.get('values')
  const tenantId = r.get('tenantId') as string
  const valori   = assertEnumValues(vals, tenantId, r.get('name'))
  // Un `value_labels` corrotto NON rende illeggibile il vocabolario: si
  // perdono le etichette (e a schermo si legge il valore, che è vero) e il
  // motivo finisce nei log. Un vocabolario si legge su ogni pagina.
  const { labels: etichette, error: erroreEtichette } = parseValueLabels(r.get('valueLabels'))
  if (erroreEtichette) {
    logger.warn(
      { module: 'enum-type', tenantId, name: r.get('name'), err: erroreEtichette },
      '[vocabolario] etichette per valore non leggibili: a schermo si legge il valore',
    )
  }
  const { colors: colori, error: erroreColori } = parseValueColors(r.get('valueColors'))
  if (erroreColori) {
    logger.warn(
      { module: 'enum-type', tenantId, name: r.get('name'), err: erroreColori },
      '[vocabolario] colori per valore non leggibili: a schermo il valore resta neutro',
    )
  }
  const nome = r.get('name') as string
  return {
    id:        r.get('id')        as string,
    tenantId,
    name:      nome,
    // Il motivo viaggia col vocabolario: la pagina non deve tenere una sua
    // copia dell'elenco, che divergerebbe al primo vocabolario nuovo.
    valueLabelsReasonKey: valueLabelsReasonKey(nome),
    label:     r.get('label')     as string,
    // A-18: `values` è una lista, sempre. Il ripiego `JSON.parse` copriva UN
    // nodo (`ci_chain`, scritto come stringa JSON dal seed del metamodello) e
    // nascondeva l'incoerenza a tutti: il seed ora scrive una lista e la
    // migrazione 20260918_1910 normalizza il nodo esistente, quindi una
    // stringa qui è un dato rotto e va detto, non indovinato.
    values:    valori,
    /*
      Le etichette GREZZE (valore → lingua → etichetta): la risoluzione nella
      lingua chiesta la fa il field resolver `EnumTypeDefinition.valueLabels`,
      che e' l'unico posto che conosce l'argomento `language`.
    */
    valueLabelsRaw: etichette,
    valueColors: valueColorEntries(valori, colori),
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
               e.updated_at AS updatedAt, e.value_labels AS valueLabels, e.value_colors AS valueColors
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
               e.updated_at AS updatedAt, e.value_labels AS valueLabels, e.value_colors AS valueColors
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
  requirePermission(ctx, 'config.metamodel')
  const { input } = args
  if (!input.name.match(/^[a-z][a-z0-9_]*$/)) {
    throw new ValidationError('name must be snake_case (lowercase letters, numbers, underscores)', { key: 'errors.enum.nameFormat', params: { name: input.name } })
  }
  assertValuesUsable(input.values, input.name)
  const VALID_SCOPES = ['itil', 'cmdb', 'shared'] as const
  if (!VALID_SCOPES.includes(input.scope as typeof VALID_SCOPES[number])) {
    throw new ValidationError(`scope must be one of: ${VALID_SCOPES.join(', ')}`, { key: 'errors.enum.scopeInvalid', params: { allowed: VALID_SCOPES.join(', ') } })
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
        throw new ValidationError(`An enum type named "${input.name}" already exists for this tenant`, { key: 'errors.enum.nameExists', params: { name: input.name } })
      }
      throw err
    }
    if (createdId !== id) {
      throw new ValidationError(`An enum type named "${input.name}" already exists for this tenant`, { key: 'errors.enum.nameExists', params: { name: input.name } })
    }

    vocabularyChanged(ctx.tenantId)
    void audit(ctx, 'enum_type.created', 'EnumTypeDefinition', id, { name: input.name })

    return {
      id, tenantId: ctx.tenantId, name: input.name, label: input.label,
      values: input.values, isSystem: false, isShipped: false, scope: input.scope,
      // Un vocabolario del cliente porta etichette: l'elenco di quelli che non
      // le portano è dei vocabolari spediti, e chi crea non può entrarci.
      valueLabelsReasonKey: valueLabelsReasonKey(input.name),
      // Un vocabolario nuovo nasce senza etichette: a schermo si legge il
      // valore, e l'admin le scrive dal Dizionario quando vuole.
      valueLabelsRaw: {},
      valueColors: [],
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
  requirePermission(ctx, 'config.metamodel')
  if (ctx.tenantId === SYSTEM_TENANT) {
    throw new ValidationError('The system tenant does not customize the shipped dictionaries: the product changes those.', { key: 'errors.enum.systemTenant' })
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const src = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id IN [$tenantId, $systemTenant]
        RETURN e.tenant_id AS tenantId, e.name AS name, e.label AS label,
               e.values AS values, e.scope AS scope, e.default_value AS defaultValue,
               e.value_labels AS valueLabels, e.value_colors AS valueColors
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
        `Dictionary "${name}" is already yours: edit it directly, there is nothing to customize.`,
        { key: 'errors.enum.alreadyYours', params: { name } },
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
        `You already have a dictionary "${name}" (${existing.records[0]!.get('id') as string}): that is the one you read. `
        + `Edit it instead of creating another.`,
        { key: 'errors.enum.yoursExists', params: { name, id: existing.records[0]!.get('id') as string } },
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
          // E porta le ETICHETTE, per la stessa ragione: personalizzare
          // «impact» per aggiungere un valore non deve far tornare gli altri
          // tre in inglese. Chi personalizza parte da dov'era, e cambia quel
          // che vuole.
          value_labels: $valueLabels,
          // E i COLORI (F9), per la stessa ragione delle etichette.
          value_colors: $valueColors,
          // I valori spediti che la copia ha VISTO (F20): quelli spediti dopo si
          // riconoscono e la diagnostica li segnala; quelli tolti di proposito no.
          shipped_values_seen: $shippedValuesSeen,
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
               e.updated_at AS updatedAt, e.value_labels AS valueLabels, e.value_colors AS valueColors
      `, {
        id, tenantId: ctx.tenantId, name,
        label: row.get('label') as string, values,
        scope: row.get('scope') as string, now,
        defaultValue: (row.get('defaultValue') ?? null) as string | null,
        valueLabels: (row.get('valueLabels') ?? null) as string | null,
        valueColors: (row.get('valueColors') ?? null) as string | null,
        shippedValuesSeen: values,
      }),
    )
    if (!created.records.length) throw new Error(`customizeEnumType("${name}"): the CREATE returned no node`)

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
  args: { id: string; input: { label?: string; values?: string[]; scope?: string; defaultValue?: string; replacements?: { from: string; to: string }[]; valueLabels?: { value: string; language: string; label: string }[]; valueColors?: { value: string; color: string }[] } },
  ctx: GraphQLContext,
): Promise<EnumTypeDef> {
  requirePermission(ctx, 'config.metamodel')
  const { id, input } = args

  const session = getSession(undefined, 'WRITE')
  try {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')
        RETURN e.is_system AS isSystem, e.tenant_id AS tenantId, e.name AS name, e.values AS values,
               e.default_value AS defaultValue, e.value_labels AS valueLabels, e.value_colors AS valueColors
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
        `Dictionary "${check.records[0]!.get('name') as string}" ships with the product: it is the same for every tenant `
        + `and cannot be edited in place. Use "Customize" (customizeEnumType) to get your own copy and edit that.`,
        { key: 'errors.enum.shippedUseCustomize', params: { name: check.records[0]!.get('name') as string } },
      )
    }

    if (isSystem && input.scope) {
      throw new ValidationError('Cannot change scope of system enum types', { key: 'errors.enum.systemScope' })
    }
    if (input.values) {
      assertVocabularyEditable(check.records[0]!.get('name') as string, 'errors.enum.op.changeValues')
      assertValuesUsable(input.values, check.records[0]!.get('name') as string)
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
          `replacements: "${r.from}" is not among the values you are removing from "${name}" (${removed.length ? removed.join(', ') : 'none'}).`,
          { key: removed.length ? 'errors.enum.replacementNotRemoved' : 'errors.enum.replacementNothingRemoved', params: { from: r.from, name, removed: removed.join(', ') } },
        )
      }
      if (!next.includes(r.to)) {
        throw new ValidationError(
          `replacements: the replacement value "${r.to}" is not among the new values of "${name}" (${next.join(', ')}).`,
          { key: 'errors.enum.replacementNotNew', params: { to: r.to, name, values: next.join(', ') } },
        )
      }
    }
    const replaced = new Map(replacements.map((r) => [r.from, r.to]))
    const orphaned = removed.filter((v) => !replaced.has(v))
    if (orphaned.length) {
      const usages = await countEnumValueUsage(session, ctx.tenantId, name, orphaned)
      if (usages.length) throw new ValidationError(enumValueUsageMessage(name, usages), { key: 'errors.enum.valuesInUse', params: { name, usages: usages.map((u) => u.value).join(', ') } })
    }

    // ── IL DEFAULT SEGUE I VALORI (terza revisione · C2) ──────────────────
    // La rinomina porta dietro il default (`CASE WHEN e.default_value = $from`),
    // questa strada NO: il Cypher faceva `coalesce($defaultValue,
    // e.default_value)`, cioè «se non me ne dài uno nuovo, tieni quello che
    // c'è» — anche quando quello che c'è era il valore appena TOLTO. E
    // `countEnumValueUsage` non guarda `default_value`, quindi su un tenant
    // dove nessun record usa quel valore la rimozione passava in silenzio.
    // Dopo: `initialCIStatus` lancia su ogni CI creato senza stato esplicito,
    // che è il caso normale — nessun CI nasce più.
    const currentDefault = (check.records[0]!.get('defaultValue') ?? null) as string | null
    // Le sostituzioni valgono anche per il default: è un riferimento al
    // vocabolario come i record, la policy e le celle delle matrici.
    const defaultAfterReplace = currentDefault != null && replaced.has(currentDefault)
      ? replaced.get(currentDefault)!
      : currentDefault
    const finalDefault = input.defaultValue !== undefined ? input.defaultValue : defaultAfterReplace

    /**
     * LE ETICHETTE DOPO QUESTA MODIFICA.
     *
     * Tre cose in una, e ognuna chiude un modo di perderle:
     *  - se l'input le porta, SOSTITUISCONO in blocco (la lista mandata e
     *    quella che resta): e come il Dizionario le modifica, tutte insieme;
     *  - le sostituzioni (`replacements`, cioe togliere un valore riscrivendo i
     *    record su un altro) spostano l'etichetta come fa la rinomina, altrimenti
     *    l'etichetta del valore tolto resterebbe appesa a una chiave morta;
     *  - le etichette dei valori che NON esistono piu si scartano: senza,
     *    ricreare un valore con lo stesso nome ne farebbe riapparire
     *    un'etichetta scritta mesi prima e dimenticata.
     */
    const { labels: etichetteCorrenti } = parseValueLabels(check.records[0]!.get('valueLabels'))
    let etichette: EnumValueLabels = input.valueLabels
      ? (() => {
          // Una voce per valore E PER LINGUA: `{value, language, label}`.
          // Un'etichetta vuota significa «non scritta», e non si conserva.
          const per: Record<string, Partial<Record<Lingua, string>>> = {}
          for (const e of input.valueLabels) {
            const etichetta = e.label.trim()
            if (etichetta === '') continue
            const lingua = assertLingua(e.language)
            per[e.value] = { ...per[e.value], [lingua]: etichetta }
          }
          return per
        })()
      : etichetteCorrenti
    for (const [from, to] of replaced) etichette = renameValueLabel(etichette, from, to)
    const etichetteFinali = serializeValueLabels(pruneValueLabels(etichette, next))

    // I COLORI (F9) seguono le stesse tre regole delle etichette.
    let colori: EnumValueColors = input.valueColors
      ? assertValueColorsInput(input.valueColors, next, name)
      : parseValueColors(check.records[0]!.get('valueColors')).colors
    for (const [from, to] of replaced) colori = renameValueColor(colori, from, to)
    const coloriFinali = serializeValueColors(pruneValueColors(colori, next))

    if (finalDefault != null && !next.includes(finalDefault)) {
      // Chi lo legge deve sapere quali sono le sue due uscite.
      throw new ValidationError(
        currentDefault === finalDefault && input.defaultValue === undefined
          ? `You are removing "${finalDefault}" from "${name}", which is its default value: a new record `
            + `would be born with a value the dictionary does not have. Say what to rewrite it to (replacements) `
            + `or choose a new default (defaultValue) in the same call.`
          : `The default value "${finalDefault}" is not among the values of "${name}" (${next.join(', ')}).`,
        currentDefault === finalDefault && input.defaultValue === undefined
          ? { key: 'errors.enum.removingDefault', params: { value: finalDefault, name } }
          : { key: 'errors.enum.defaultNotInValues', params: { value: finalDefault, name, values: next.join(', ') } },
      )
    }

    const now = new Date().toISOString()
    /** Le riscritture avvenute: si scrivono in audit solo DOPO il commit. */
    const auditQueue: { from: string; to: string; records: number }[] = []
    const result = await session.executeWrite(async (tx) => {
      // Un ritentativo della transazione ricomincia da capo: la coda si svuota
      // per non contare due volte la stessa riscrittura.
      auditQueue.length = 0
      // La riscrittura dei record e quella del vocabolario nella STESSA
      // transazione: non esiste un istante in cui i record puntano a un valore
      // che il vocabolario non ha.
      for (const [from, to] of replaced) {
        // L'audit si RACCOGLIE qui e si scrive dopo il commit (terza revisione
        // · M3): `audit` apre una sessione propria, quindi stava fuori dalla
        // transazione pur essendo chiamato dentro — e `executeWrite` RITENTA
        // sugli errori transienti, che e il suo comportamento normale. Ogni
        // ritentativo lasciava una voce d'audit per una riscrittura che non era
        // avvenuta, o la duplicava. L'audit del rimedio e una delle
        // giustificazioni dichiarate di questa strada: non puo essere il pezzo
        // meno affidabile.
        auditQueue.push({ from, to, records: await replaceEnumValue(tx, ctx.tenantId, name, from, to) })
      }
      return tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
        SET e.label      = coalesce($label, e.label),
            e.values     = coalesce($values, e.values),
            e.scope      = CASE WHEN $scope IS NOT NULL AND NOT e.is_system THEN $scope ELSE e.scope END,
            e.default_value = $finalDefault,
            e.value_labels = $valueLabels,
            e.value_colors = $valueColors,
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
               e.updated_at AS updatedAt, e.value_labels AS valueLabels, e.value_colors AS valueColors
      `, {
        id,
        tenantId: ctx.tenantId,
        label:  input.label  ?? null,
        values: input.values ?? null,
        scope:  input.scope  ?? null,
        finalDefault,
        valueLabels: etichetteFinali,
        valueColors: coloriFinali,
        now,
      })
    })

    if (!result.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    vocabularyChanged(ctx.tenantId)
    for (const a of auditQueue) {
      void audit(ctx, 'enum_type.value_replaced', 'EnumTypeDefinition', id, { name, from: a.from, to: a.to, records: a.records })
    }
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
  requirePermission(ctx, 'config.metamodel')

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
      throw new ValidationError('System enum types cannot be deleted', { key: 'errors.enum.systemDelete' })
    }
    if (usageCount > 0) {
      throw new ValidationError(`Enum in use by ${usageCount} field${usageCount > 1 ? 's' : ''}`, { key: 'errors.enum.inUseByFields', params: { count: usageCount } })
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
          `Deleting your dictionary "${name}" would bring it back to the one shipped with the product`
          + `${shipped.length ? ` (${shipped.join(', ')})` : ' (which does not exist: no value would be left)'}, `
          + `and these values of yours are still in use: `
          + usages.map((u) => `"${u.value}" (${[
            ...u.records.map((r) => `${String(r.count)} ${r.typeName}.${r.fieldName}`),
            ...u.policyLists.map((l) => `alarm policy: ${l}`),
          ].join(', ')})`).join('; ')
          + `. Change those records first, or remove the values one by one with updateEnumType `
          + `(which takes a replacement value).`,
          {
            key: shipped.length ? 'errors.enum.deleteInUse' : 'errors.enum.deleteInUseNoShipped',
            params: {
              name,
              shipped: shipped.join(', '),
              usages: usages.map((u) => `"${u.value}" (${[
                ...u.records.map((r) => `${String(r.count)} ${r.typeName}.${r.fieldName}`),
                ...u.policyLists.map((l) => l),
              ].join(', ')})`).join('; '),
            },
          },
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
  requirePermission(ctx, 'config.metamodel')
  const { id } = args
  const from = args.from.trim()
  const to   = args.to.trim()
  if (to === '') throw new ValidationError('The new value cannot be empty.', { key: 'errors.enum.renameEmpty' })

  const session = getSession(undefined, 'WRITE')
  try {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id})
        WHERE e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')
        RETURN e.tenant_id AS tenantId, e.name AS name, e.values AS values, e.default_value AS defaultValue,
               e.value_labels AS valueLabels, e.value_colors AS valueColors
      `, { id, tenantId: ctx.tenantId }),
    )
    if (!check.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    const row  = check.records[0]!
    const name = row.get('name') as string

    if ((row.get('tenantId') as string) === SYSTEM_TENANT) {
      throw new ValidationError(
        `Dictionary "${name}" ships with the product: it is the same for every tenant and cannot be edited in place. `
        + `Use "Customize" to get your own copy, and rename the values on that one.`,
        { key: 'errors.enum.shippedRename', params: { name } },
      )
    }
    assertVocabularyEditable(name, 'errors.enum.op.rename', { from, to })

    const rawValues = row.get('values')
    const current = Array.isArray(rawValues) ? rawValues as string[] : JSON.parse(String(rawValues)) as string[]
    const at = current.indexOf(from)
    if (at === -1) {
      throw new ValidationError(
        `Value "${from}" is not among those of "${name}" (${current.join(', ')}): there is nothing to rename.`,
        { key: 'errors.enum.renameMissing', params: { from, name, values: current.join(', ') } },
      )
    }
    if (from === to) throw new ValidationError(`Value "${from}" is already called that.`, { key: 'errors.enum.renameSame', params: { value: from } })
    if (current.includes(to)) {
      throw new ValidationError(
        `"${name}" already has a value "${to}". Renaming "${from}" to "${to}" would merge two distinct values into one, `
        + `and the records of the first would become the second without anyone asking. `
        + `If that is what you want, remove "${from}" giving "${to}" as its replacement (updateEnumType).`,
        { key: 'errors.enum.renameWouldMerge', params: { name, from, to } },
      )
    }

    const next = [...current]
    next[at] = to
    const now = new Date().toISOString()

    // L'ETICHETTA SEGUE IL VALORE. Senza questo, rinominare `high` in `alta`
    // lascerebbe «Alta» appesa a una chiave che non esiste piu: a schermo
    // comparirebbe «Alta» per caso (title-case del valore nuovo) o si
    // perderebbe del tutto l'etichetta che l'admin aveva scritto.
    const { labels: etichetteCorrenti } = parseValueLabels(row.get('valueLabels'))
    const etichetteNuove = serializeValueLabels(renameValueLabel(etichetteCorrenti, from, to))
    // E il COLORE (F9), per la stessa ragione.
    const coloriNuovi = serializeValueColors(renameValueColor(parseValueColors(row.get('valueColors')).colors, from, to))

    /** Quanti record ha toccato l'ULTIMO tentativo: l'audit va dopo il commit. */
    let touchedRecords = 0
    const result = await session.executeWrite(async (tx) => {
      // I record, la policy e le matrici PRIMA: se qualcosa qui lancia, il
      // vocabolario non è ancora cambiato e non resta niente a metà.
      // L'audit invece va FUORI (terza revisione · M3): apre una sessione
      // propria, e `executeWrite` ritenta sugli errori transienti — restavano
      // voci per rinomine mai avvenute.
      touchedRecords = await replaceEnumValue(tx, ctx.tenantId, name, from, to)
      return tx.run(`
        MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
        SET e.values        = $values,
            e.default_value = CASE WHEN e.default_value = $from THEN $to ELSE e.default_value END,
            e.value_labels  = $valueLabels,
            e.value_colors  = $valueColors,
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
               e.updated_at AS updatedAt, e.value_labels AS valueLabels, e.value_colors AS valueColors
      `, { id, tenantId: ctx.tenantId, values: next, from, to, now, valueLabels: etichetteNuove, valueColors: coloriNuovi })
    })
    if (!result.records.length) throw new NotFoundError('EnumTypeDefinition', id)
    vocabularyChanged(ctx.tenantId)
    void audit(ctx, 'enum_type.value_renamed', 'EnumTypeDefinition', id, { name, from, to, records: touchedRecords })
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
  requirePermission(ctx, 'config.metamodel')
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
        `Dictionary "${name}" ships with the product: use "Customize" to get your own copy and reorder that one.`,
        { key: 'errors.enum.shippedReorder', params: { name } },
      )
    }
    assertVocabularyEditable(name, 'errors.enum.op.reorder')
    const rawValues = row.get('values')
    const current = Array.isArray(rawValues) ? rawValues as string[] : JSON.parse(String(rawValues)) as string[]

    const sortedA = [...current].sort()
    const sortedB = [...values].sort()
    if (values.length !== current.length || sortedA.some((v, i) => v !== sortedB[i])) {
      const missing = current.filter((v) => !values.includes(v))
      const extra   = values.filter((v) => !current.includes(v))
      throw new ValidationError(
        `Reordering changes only the ORDER of the values of "${name}", not the set`
        + (missing.length ? `; missing: ${missing.join(', ')}` : '')
        + (extra.length   ? `; extra: ${extra.join(', ')}`    : '')
        + `. To add or remove a value use the dictionary edit (which counts who uses it), `
        + `to change its name use the rename.`,
        { key: 'errors.enum.reorderSameSet', params: { name, missing: missing.join(', '), extra: extra.join(', ') } },
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
               e.updated_at AS updatedAt, e.value_labels AS valueLabels, e.value_colors AS valueColors
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

// ── I valori spediti dopo la copia (revisione del 14 set 2026 · F20) ─────────

const ENUM_RETURN = `
  RETURN e.id AS id, e.tenant_id AS tenantId, e.name AS name, e.label AS label, e.values AS values,
         e.is_system AS isSystem, e.scope AS scope, e.default_value AS defaultValue,
         e.created_at AS createdAt, e.updated_at AS updatedAt, e.value_labels AS valueLabels, e.value_colors AS valueColors`

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${what} is not a list of strings (${JSON.stringify(value)})`)
  }
  return value as string[]
}

/** La copia del cliente e il suo gemello spedito, già validati per le due decisioni. */
async function loadCopyAndShipped(session: ReturnType<typeof getSession>, id: string, tenantId: string) {
  const r = await session.executeRead((tx) => tx.run(`
    MATCH (c:EnumTypeDefinition {id: $id})
    WHERE c.tenant_id IN [$tenantId, 'system']
    OPTIONAL MATCH (s:EnumTypeDefinition {tenant_id: 'system', name: c.name})
    RETURN c.tenant_id AS owner, c.name AS name, c.values AS values, c.shipped_values_seen AS seen,
           c.value_labels AS valueLabels, c.value_colors AS valueColors,
           s.values AS shipped, s.value_labels AS shippedLabels, s.value_colors AS shippedColors
  `, { id, tenantId }))
  const row = r.records[0]
  if (!row) throw new NotFoundError('EnumTypeDefinition', id)
  const name = row.get('name') as string
  if ((row.get('owner') as string) === SYSTEM_TENANT) {
    throw new ValidationError(
      `Dictionary "${name}" ships with the product: shipped values are adopted or declined on YOUR copy, not on the shipped dictionary.`,
      { key: 'errors.enum.shippedValuesOnlyCopies', params: { name } },
    )
  }
  if (row.get('shipped') == null) {
    throw new ValidationError(
      `Dictionary "${name}" is your own: there is no shipped dictionary with this name, so there are no shipped values to adopt or decline.`,
      { key: 'errors.enum.noShippedCounterpart', params: { name } },
    )
  }
  const values  = stringList(row.get('values'), `Dictionary "${name}": values`)
  const shipped = stringList(row.get('shipped'), `Shipped dictionary "${name}": values`)
  const rawSeen = row.get('seen')
  const seen    = rawSeen == null ? null : stringList(rawSeen, `Dictionary "${name}": shipped_values_seen`)
  return { row, name, values, shipped, newValues: newShippedValues(shipped, values, seen) }
}

/**
 * Aggiunge alla copia i valori spediti che non aveva visto, IN CODA e con le
 * etichette e i colori spediti; le etichette e i colori dei valori che il
 * cliente ha già restano i suoi. Segna vista la lista spedita di adesso.
 */
export async function adoptShippedValues(_: unknown, args: { id: string }, ctx: GraphQLContext): Promise<EnumTypeDef> {
  requirePermission(ctx, 'config.metamodel')
  const session = getSession(undefined, 'WRITE')
  try {
    const { row, name, values, shipped, newValues } = await loadCopyAndShipped(session, args.id, ctx.tenantId)
    const next = [...values, ...newValues]
    assertValuesUsable(next, name)
    const shippedLabels = parseValueLabels(row.get('shippedLabels')).labels
    const shippedColors = parseValueColors(row.get('shippedColors')).colors
    const labels: Record<string, EnumValueLabels[string]> = { ...parseValueLabels(row.get('valueLabels')).labels }
    const colors: Record<string, EnumValueColors[string]> = { ...parseValueColors(row.get('valueColors')).colors }
    for (const v of newValues) {
      if (shippedLabels[v] !== undefined) labels[v] = shippedLabels[v]
      if (shippedColors[v] !== undefined) colors[v] = shippedColors[v]
    }
    const now = new Date().toISOString()
    const result = await session.executeWrite((tx) => tx.run(`
      MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
      SET e.values = $values,
          e.value_labels = $valueLabels,
          e.value_colors = $valueColors,
          e.shipped_values_seen = $seen,
          e.updated_at = $now
      ${ENUM_RETURN}
    `, {
      id: args.id, tenantId: ctx.tenantId, values: next, seen: shipped, now,
      valueLabels: serializeValueLabels(pruneValueLabels(labels, next)),
      valueColors: serializeValueColors(pruneValueColors(colors, next)),
    }))
    if (!result.records.length) throw new NotFoundError('EnumTypeDefinition', args.id)
    vocabularyChanged(ctx.tenantId)
    void audit(ctx, 'enum_type.shipped_values_adopted', 'EnumTypeDefinition', args.id, { name, values: newValues })
    return mapEnum(result.records[0]!)
  } finally {
    await session.close()
  }
}

/** Tiene fuori i valori spediti non ancora visti: la lista resta com'è, e smettono di essere segnalati. */
export async function acknowledgeShippedValues(_: unknown, args: { id: string }, ctx: GraphQLContext): Promise<EnumTypeDef> {
  requirePermission(ctx, 'config.metamodel')
  const session = getSession(undefined, 'WRITE')
  try {
    const { name, shipped, newValues } = await loadCopyAndShipped(session, args.id, ctx.tenantId)
    const now = new Date().toISOString()
    const result = await session.executeWrite((tx) => tx.run(`
      MATCH (e:EnumTypeDefinition {id: $id, tenant_id: $tenantId})
      SET e.shipped_values_seen = $seen,
          e.updated_at = $now
      ${ENUM_RETURN}
    `, { id: args.id, tenantId: ctx.tenantId, seen: shipped, now }))
    if (!result.records.length) throw new NotFoundError('EnumTypeDefinition', args.id)
    vocabularyChanged(ctx.tenantId)
    void audit(ctx, 'enum_type.shipped_values_declined', 'EnumTypeDefinition', args.id, { name, values: newValues })
    return mapEnum(result.records[0]!)
  } finally {
    await session.close()
  }
}

/** Una lettura per richiesta: il Dizionario chiede il campo per ogni vocabolario. */
const driftPerRequest = new WeakMap<GraphQLContext, Promise<Map<string, string[]>>>()

async function newShippedValuesField(parent: EnumTypeDef, _args: unknown, ctx: GraphQLContext): Promise<string[]> {
  if (parent.isShipped) return []
  let pending = driftPerRequest.get(ctx)
  if (!pending) {
    pending = (async () => {
      const session = getSession()
      try {
        return new Map((await vocabulariesBehindShipped(session, ctx.tenantId)).map((d) => [d.id, d.newValues]))
      } finally {
        await session.close()
      }
    })()
    driftPerRequest.set(ctx, pending)
  }
  return (await pending).get(parent.id) ?? []
}

/**
 * `EnumTypeDefinition.valueLabels(language)`: l'unico posto che conosce la
 * lingua chiesta. L'API non la sa da se — non c'e' `Accept-Language` e l'utente
 * non la porta — quindi la chiede il client, che e' l'unico a saperla.
 *
 * Senza l'argomento si usa la lingua predefinita DEL CLIENTE, che e
 * configurazione (`lib/tenantLanguage.ts`), e quella e anche il ripiego per le
 * etichette scritte in una lingua sola. Una lingua chiesta e non riconosciuta
 * non si ripiega in silenzio: si rifiuta, dicendo quali ci sono — chiedere
 * `language: "de"` e ricevere l'inglese senza una parola e il modo migliore di
 * non accorgersi che il tedesco non c'e.
 */
async function enumValueLabelsField(
  parent: EnumTypeDef,
  args: { language?: string | null },
  ctx: GraphQLContext,
): Promise<EnumValueLabelEntry[]> {
  const predefinita = await languageFor(ctx.tenantId)
  const lingua = args.language == null || args.language === '' ? predefinita : assertLingua(args.language)
  return valueLabelEntries(parent.values, parent.valueLabelsRaw, lingua, predefinita)
}

/**
 * Cosa tocca rinominare (o togliere) un valore, prima di farlo: record per tipo
 * e campo, liste della policy degli allarmi, matrici di dominio, configurazione
 * (secondo giro UI del 15 set 2026: la rinomina riscriveva i record senza una
 * conferma né un conteggio). Stesso conteggio del rifiuto della cancellazione.
 */
export async function enumValueUsage(_: unknown, args: { id: string; value: string }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'READ')
  try {
    const found = await session.executeRead((tx) => tx.run(`
      MATCH (e:EnumTypeDefinition {id: $id})
      WHERE e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')
      RETURN e.name AS name
    `, { id: args.id, tenantId: ctx.tenantId }))
    if (!found.records.length) throw new NotFoundError('EnumTypeDefinition', args.id)
    const name = found.records[0]!.get('name') as string
    const [usage] = await countEnumValueUsage(session, ctx.tenantId, name, [args.value])
    return usage ?? { value: args.value, records: [], policyLists: [], matrices: [], configSites: [], total: 0 }
  } finally {
    await session.close()
  }
}

export const enumTypeResolvers = {
  Query:    { enumTypes, enumType, enumValueUsage },
  Mutation: { createEnumType, updateEnumType, deleteEnumType, customizeEnumType, renameEnumValue, reorderEnumValues, adoptShippedValues, acknowledgeShippedValues },
  EnumTypeDefinition: { valueLabels: enumValueLabelsField, newShippedValues: newShippedValuesField },
}
