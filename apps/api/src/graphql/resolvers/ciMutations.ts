import { NotFoundError } from '../../lib/errors.js'
import type { Session } from 'neo4j-driver'
import { ValidationError } from '../../lib/errors.js'
import { withSession } from './ci-utils.js'
import { cache } from '../../lib/cache.js'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import { BASE_INPUT_FIELDS } from '@opengraphity/schema-generator'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { calculateChain } from '../../lib/chainCalculator.js'
import { toSnakeCase } from '../../lib/mappers.js'
import { assertWritableCIPropertyKey } from '../../lib/cypherIdentifiers.js'
import { ciNameKey } from '../../lib/ciNameKey.js'
import { initialCIStatus } from '../../lib/ciLifecycle.js'
import { notifyCIGraphChanged, notifyCIMaintenanceChanged } from '../../services/serviceImpact/sync.js'
import { isMaintenanceLifecycle, isRetiredLifecycle, resolveCILifecycleSemantics } from '../../lib/ciLifecycle.js'
import { recomputeCIHealth } from '../../services/events/ciHealth.js'
import { runValidationScript } from '../../lib/metamodelScript.js'
import { assertGroupDeclared, assertGroupRemovable } from '../../lib/ciGroups.js'
import { assertSystemCIChange } from '../../lib/opengrafoSystemCI.js'

export { assertGroupRemovable }

type Props = Record<string, unknown>

const SAFE_LABEL_RE = /^[A-Za-z][A-Za-z0-9_]*$/
function validateLabel(label: string): void {
  if (!SAFE_LABEL_RE.test(label)) throw new ValidationError(`Invalid CI type label: ${label}`)
}

const BASE_FIELDS = ['name', 'status', 'environment', 'description', 'notes'] as const

// ── Metamodel validation, server side (F-13) ─────────────────────────────────

/**
 * Enforces `required`, l'appartenenza al vocabolario per i campi `enum`, il
 * `validationScript` del campo e quello del tipo, sull'**API** (il browser li
 * applica già; un client con API key o un sandbox rotto non devono poterli
 * scavalcare). `input` è il CI intero in camelCase (in modifica: i valori
 * esistenti fusi con la patch).
 *
 * ## Il vocabolario, ondata 7 · A-13
 * Lo SDL generato descrive un campo `enum` come `String`
 * (`schema-generator/src/generator.ts`), quindi GraphQL non impone niente: un
 * client REST o con API key poteva scrivere `status: 'expired'` con `expired`
 * fuori dal vocabolario, e nessuno lo diceva. Dal vivo su c-one erano 68 CI
 * (49 `expired`, 19 `revoked`) — l'ondata 0 ha allineato il vocabolario al
 * dato, ma il meccanismo restava aperto.
 *
 * I valori ammessi sono `field.enumValues`, cioè il vocabolario **di questo
 * cliente**: `graphql/resolvers/ciTypeMetamodel.ts` lo risolve già con la
 * precedenza dell'ondata 1 (l'enum del tenant vince su quello di sistema
 * agganciato, che vince sugli `enum_values` inline del campo). Non si chiama
 * `assertDomainValue` perché `CIFieldDefinition` non porta il NOME del
 * vocabolario, e un campo con soli valori inline non ne ha uno: la lista
 * risolta è la stessa cosa, per il campo che si sta scrivendo.
 *
 * `touched` = i nomi dei campi che la richiesta scrive davvero. In modifica
 * l'appartenenza si controlla **solo** su quelli: un valore già sul CI e non
 * più nel vocabolario è un dato storico, e rifiutare il salvataggio di un
 * altro campo renderebbe il record immodificabile proprio quando lo si vuole
 * sistemare. Il form lo mostra come «non più nel vocabolario» (B7-3), così a
 * correggerlo si va di proposito. Senza `touched` (creazione) si controlla
 * tutto.
 *
 * Throws ValidationError with the script's message. Exported for tests.
 */
export async function validateCIInput(
  ciType: CITypeWithDefinitions,
  input: Record<string, unknown>,
  tenantId: string,
  touched?: ReadonlySet<string>,
): Promise<void> {
  const errors: string[] = []
  for (const field of ciType.fields) {
    // Revisione delle otto ondate · A·3.3. Il filtro era `field.isSystem`, e
    // `is_system` è vero su TUTTI e nove i campi di `__base__` — `status` e
    // `environment` compresi, che sono i più scritti della CMDB. Quindi la
    // validazione del vocabolario non girava mai su di loro: `status: "pizza"`
    // entrava, ed entrava anche il valore che il cliente aveva TOLTO dal suo
    // Dizionario.
    //
    // Il discriminante giusto non è «di sistema» ma «è un campo d'ingresso»:
    // `BASE_INPUT_FIELDS` sono i campi che il generatore dichiara negli input
    // (name, status, environment, description, notes, i due gruppi, e i tre
    // della salute), quindi scrivibili; `id`, `createdAt`, `updatedAt` e
    // `chain` non lo sono, e su quelli non c'è niente da validare.
    if (field.isSystem && !BASE_INPUT_FIELDS.has(field.name)) continue
    const value = input[field.name]
    if (field.required && (value == null || value === '')) {
      errors.push(`${field.label || field.name} is required`)
      continue
    }
    if (
      field.fieldType === 'enum' && value != null && value !== '' &&
      field.enumValues.length > 0 && (touched === undefined || touched.has(field.name)) &&
      !field.enumValues.includes(String(value))
    ) {
      errors.push(
        `${field.label || field.name}: "${String(value)}" is not in the dictionary of this tenant. ` +
        `Allowed: ${field.enumValues.join(', ')}`,
      )
      continue
    }
    // A yes/no field takes a yes or a no (24 Sep 2026, the shared-infrastructure flag): «maybe» is not stored.
    if (field.fieldType === 'boolean' && value != null && typeof value !== 'boolean') {
      errors.push(`${field.label || field.name}: "${String(value)}" is not true or false`)
      continue
    }
    // A status this type does not offer (G35): «Expired» on a server.
    if (
      field.name === 'status' && value != null && value !== '' && (touched === undefined || touched.has(field.name)) &&
      (ciType.statusesExcluded ?? []).includes(String(value))
    ) {
      errors.push(`${field.label || field.name}: "${String(value)}" is not a status of ${ciType.label || ciType.name}`)
      continue
    }
    if (field.validationScript && value != null) {
      const err = await runValidationScript(field.validationScript, { input, value }, `${ciType.name}.${field.name}.validation_script`, tenantId, field.scope)
      if (err) errors.push(`${field.label || field.name}: ${err}`)
    }
  }
  if (errors.length) throw new ValidationError(`CI validation failed: ${errors.join('; ')}`, { key: 'errors.ci.validationFailed', params: { details: errors.join('; ') } })

  if (ciType.validationScript) {
    const err = await runValidationScript(ciType.validationScript, { input }, `${ciType.name}.validation_script`, tenantId, ciType.scope)
    if (err) throw new ValidationError(`CI validation failed: ${err}`, { key: 'errors.ci.validationFailed', params: { details: err } })
  }
}

/**
 * Le relazioni di sistema che il metamodello dichiara obbligatorie (oggi
 * `ownerGroup`) si scrivono alla creazione con `<nome>Id`. Giro nel browser del
 * 14 set 2026 (#55): `ownerGroup` era «required» ma il modulo non lo chiedeva
 * e l'API non lo controllava, quindi il CI nasceva senza owner e le change su
 * di lui fallivano dopo.
 */
export function assertRequiredSystemRelations(ciType: CITypeWithDefinitions, input: Record<string, unknown>): void {
  const missing = (ciType.systemRelations ?? [])
    .filter((sr) => sr.required && !input[`${sr.name}Id`])
    .map((sr) => sr.label || sr.name)
  if (missing.length === 0) return
  const details = missing.map((m) => `${m}: required`).join('; ')
  throw new ValidationError(`CI validation failed: ${details}`, { key: 'errors.ci.validationFailed', params: { details } })
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function buildCreateMutation(
  ciType: CITypeWithDefinitions,
  neo4jLabel: string,
  mapCI: (props: Props, ciType: CITypeWithDefinitions) => Record<string, unknown>,
) {
  validateLabel(neo4jLabel)
  return async (_: unknown, args: { input: Record<string, unknown> }, ctx: GraphQLContext) => {
    const { input } = args
    assertRequiredSystemRelations(ciType, input)
    // A group the type does not declare is refused (a business capability has no Support Group).
    for (const g of GROUP_INPUTS) if (input[g.input]) assertGroupDeclared(ciType, g.relation)
    await validateCIInput(ciType, input, ctx.tenantId)

    return withSession(async (session) => {
      const id  = crypto.randomUUID()
      const now = new Date().toISOString()

      const props: Record<string, unknown> = {
        id, tenant_id: ctx.tenantId,
        name:        input['name'],
        name_key:    ciNameKey(input['name']),   // riconoscimento per nome degli allarmi (lib/ciNameKey.ts)
        // Ondata 7: lo stato iniziale NON è il letterale `'active'`. Il
        // cliente può aver rinominato il vocabolario `ci_status` (per esempio
        // in `attivo`), e scrivere `'active'` metterebbe sul CI un valore che
        // il suo Dizionario non ha: il form lo mostrerebbe vuoto e un
        // salvataggio distratto lo azzererebbe (A-13). Senza uno stato
        // esplicito si prende il PRIMO valore del suo vocabolario, che è
        // l'ordine in cui il Dizionario li presenta.
        status:      input['status'] ?? await initialCIStatus(ctx.tenantId),
        environment: input['environment'] ?? null,
        description: input['description'] ?? null,
        notes:       input['notes']       ?? null,
        created_at:  now, updated_at: now,
      }
      for (const field of ciType.fields) {
        if (input[field.name] !== undefined) {
          // A-12: le proprietà del prodotto (`tenant_id`, `id`, `name_key`, la
          // salute, `discovery_*`) sono già impostate sopra. Un campo del
          // metamodello chiamato `tenantId` le sovrascriverebbe con il valore
          // mandato dal chiamante — e il CI nascerebbe nel cliente scelto da
          // lui. La porta (`createCIType`/`addCIField`) non lascia entrare
          // nomi così; questa è la rete per quelli entrati per altre vie.
          props[assertWritableCIPropertyKey(toSnakeCase(field.name), field.name)] = input[field.name]
        }
      }

      // Every CI carries :ConfigurationItem plus its type label, like the
      // ones created by discovery/resolveConflict (B-08): queries and the
      // ci_id_unique/ci_tenant_id constraints on :ConfigurationItem see them.
      //
      // Giro nel browser del 14 set 2026 (#55): il CI e i suoi gruppi nascono
      // nella STESSA transazione, e un gruppo che non esiste nel tenant è un
      // errore. Prima erano scritture separate con un MATCH che, senza team,
      // non creava niente in silenzio: il CI nasceva senza owner.
      const result = await session.executeWrite(async (tx) => {
        const created = await tx.run(`CREATE (n:ConfigurationItem:${neo4jLabel} $props) RETURN properties(n) AS p`, { props })
        for (const [key, rel] of [['ownerGroupId', 'OWNED_BY'], ['supportGroupId', 'SUPPORTED_BY']] as const) {
          const teamId = input[key]
          if (!teamId) continue
          const linked = await tx.run(
            `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
             MERGE (n)-[:${rel}]->(t)
             RETURN t.id AS teamId`,
            { id, teamId, tenantId: ctx.tenantId },
          )
          if (!linked.records.length) throw new NotFoundError('Team', String(teamId))
        }
        return created
      })

      // Calculate chain based on chain_families of CI type and upstream
      // dependencies. A failure must surface: a CI with no chain silently
      // breaks impact analysis for everything downstream.
      await calculateChain(id, ctx.tenantId)

      cache.invalidate(`ci:${ctx.tenantId}:${neo4jLabel}:`)
      cache.invalidate(`topology:${ctx.tenantId}:`)
      void audit(ctx, 'ci.created', 'ConfigurationItem', id)
      return mapCI(result.records[0].get('p') as Props, ciType)
    }, true)
  }
}

/** Le relazioni verso i team che gli input dei CI accettano come `<nome>Id`. */
const GROUP_INPUTS = [
  { input: 'ownerGroupId',   relation: 'ownerGroup',   relType: 'OWNED_BY' },
  { input: 'supportGroupId', relation: 'supportGroup', relType: 'SUPPORTED_BY' },
] as const

/**
 * LA scrittura della modifica di un CI (revisione del 15 set 2026 · CM-2).
 *
 * Prima esistevano due strade. `update<Tipo>` validava il vocabolario, gli
 * obbligatori e gli script, aggiornava `name_key`, avvisava i Servizi
 * monitorati sulla manutenzione e scriveva l'audit; `updateCIFields` — quella
 * che il dettaglio del CI usa davvero — non faceva niente di tutto questo.
 * Dal vivo accettava `status: "pizza"`, lasciava `name_key` sul nome vecchio
 * (gli allarmi riconoscevano ancora il CI col nome di prima) e scriveva
 * proprietà fuori dal metamodello. Adesso entrambe passano da qui.
 *
 * `input` è in camelCase, come gli input GraphQL del tipo; `ownerGroupId` e
 * `supportGroupId` (CM-6) si applicano nella stessa transazione: prima lo
 * schema li accettava e questa funzione li ignorava rispondendo «ok».
 */
export async function updateCIRecord(
  session: Session,
  ctx: GraphQLContext,
  ciType: CITypeWithDefinitions,
  neo4jLabel: string,
  id: string,
  input: Record<string, unknown>,
): Promise<Props> {
  validateLabel(neo4jLabel)

  // Validation runs on the CI as it will be after the patch, like the
  // browser validates the whole form: read the current properties first.
  const existing = await session.executeRead(tx =>
    tx.run(
      `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS p`,
      { id, tenantId: ctx.tenantId },
    ),
  )
  if (!existing.records.length) throw new NotFoundError('CI')
  const current = existing.records[0].get('p') as Props
  // The OpenGrafo CI of every tenant is the product's: not renamed (lib/opengrafoSystemCI.ts).
  assertSystemCIChange(current, { name: input['name'] })

  const groupInputs = new Set<string>(GROUP_INPUTS.map((g) => g.input))
  const merged: Record<string, unknown> = {}
  for (const f of BASE_FIELDS) merged[f] = input[f] !== undefined ? input[f] : (current[f] ?? null)
  for (const field of ciType.fields) {
    merged[field.name] = input[field.name] !== undefined
      ? input[field.name]
      : (current[toSnakeCase(field.name)] ?? current[field.name] ?? null)
  }
  await validateCIInput(ciType, merged, ctx.tenantId, new Set(Object.keys(input).filter((k) => !groupInputs.has(k))))
  for (const g of GROUP_INPUTS) {
    if (input[g.input] === null || input[g.input] === '') assertGroupRemovable(ciType, g.relation)
    else if (input[g.input] !== undefined) assertGroupDeclared(ciType, g.relation)
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const f of BASE_FIELDS) {
    if (input[f] !== undefined) updates[f] = input[f]
  }
  if (input['name'] !== undefined) updates['name_key'] = ciNameKey(input['name'])
  for (const field of ciType.fields) {
    if (input[field.name] !== undefined) {
      // A-12, come in creazione: `updated_at` e `name_key` sono già in
      // `updates`, e un campo `tenantId` porterebbe il CI in un altro
      // cliente con un `SET n += $updates`.
      updates[assertWritableCIPropertyKey(toSnakeCase(field.name), field.name)] = input[field.name]
    }
  }
  const result = await session.executeWrite(async (tx) => {
    const written = await tx.run(
      `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) SET n += $updates RETURN properties(n) AS p`,
      { id, tenantId: ctx.tenantId, updates },
    )
    if (!written.records.length) throw new NotFoundError('CI')
    for (const g of GROUP_INPUTS) {
      const teamId = input[g.input]
      if (teamId === undefined) continue
      await tx.run(
        `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId})-[old:${g.relType}]->(:Team) DELETE old`,
        { id, tenantId: ctx.tenantId },
      )
      if (teamId === null || teamId === '') continue
      const linked = await tx.run(
        `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
         MERGE (n)-[:${g.relType}]->(t)
         RETURN t.id AS teamId`,
        { id, teamId, tenantId: ctx.tenantId },
      )
      if (!linked.records.length) throw new NotFoundError('Team', String(teamId))
    }
    return written
  })
  cache.invalidate(`ci:${ctx.tenantId}:${neo4jLabel}:`)
  cache.invalidate(`topology:${ctx.tenantId}:`)
  // Servizi monitorati (revisione 2 · D6.1): il ciclo di vita
  // `maintenance` toglie il CI dal calcolo della salute del servizio (gli
  // allarmi non ne aggiornano più la salute), quindi entrarci o uscirne
  // cambia la salute di ogni mappa che lo include. Senza questo gancio il
  // cambiamento si vedeva solo alla passata periodica, fino a 15 minuti
  // dopo. Dopo la scrittura e senza mai lanciare.
  // Ondata 7 · C-4: «in manutenzione» è la semantica del cliente, non il
  // valore `maintenance` di fabbrica — su un vocabolario rinominato il
  // gancio non scattava e la mappa restava ferma fino alla passata
  // periodica.
  const lifecycle = await resolveCILifecycleSemantics(ctx.tenantId)
  const previousStatus = current['status'] as string | null
  const nextStatus = updates['status'] === undefined ? previousStatus : updates['status'] as string | null
  const wasMaintenance = isMaintenanceLifecycle(previousStatus, lifecycle)
  const isMaintenance  = isMaintenanceLifecycle(nextStatus, lifecycle)
  // Revisione del 15 set 2026 · SV-5: anche il ciclo di vita «dismesso» toglie
  // il CI dal calcolo (D6.3), ma il gancio guardava solo la manutenzione — un
  // server giù dismesso lasciava il servizio giù fino alla passata periodica.
  const wasRetired = isRetiredLifecycle(previousStatus, lifecycle)
  const isRetired  = isRetiredLifecycle(nextStatus, lifecycle)
  if (wasRetired !== isRetired && wasMaintenance === isMaintenance) {
    await notifyCIMaintenanceChanged(ctx.tenantId, [id], `ci.status:${wasRetired ? 'left' : 'entered'}_retired`)
  }
  if (wasMaintenance !== isMaintenance) {
    // Revisione 2 · B2-14: PRIMA la salute, poi le mappe. In manutenzione
    // il monitoraggio non scrive `ci.health` (services/events/ciHealth.ts):
    // all'uscita il CI mostrava ancora la salute di prima della finestra
    // finché lo strumento non rimandava un payload (fino a `repeat_interval`
    // di distanza). Il ricalcolo la riporta a quella vera dagli allarmi
    // ancora accesi e pubblica `ci.health_changed` se cambia; entrando in
    // manutenzione è un no-op sul valore (regola `maintenance`), ma ripara
    // `health_source` se manca. La notifica alle mappe viene dopo, così la
    // valutazione del servizio legge la salute già aggiornata.
    await recomputeCIHealth(ctx.tenantId, id, ctx.userId)
    await notifyCIMaintenanceChanged(ctx.tenantId, [id], `ci.status:${wasMaintenance ? 'left' : 'entered'}_maintenance`)
  }
  void audit(ctx, 'ci.updated', 'ConfigurationItem', id)
  return result.records[0].get('p') as Props
}

export function buildUpdateMutation(
  ciType: CITypeWithDefinitions,
  neo4jLabel: string,
  mapCI: (props: Props, ciType: CITypeWithDefinitions) => Record<string, unknown>,
) {
  validateLabel(neo4jLabel)
  return async (
    _: unknown,
    args: { id: string; input: Record<string, unknown> },
    ctx: GraphQLContext,
  ) =>
    withSession(async session => mapCI(await updateCIRecord(session, ctx, ciType, neo4jLabel, args.id, args.input), ciType), true)
}

export function buildDeleteMutation(
  neo4jLabel: string,
) {
  validateLabel(neo4jLabel)
  return async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
    withSession(async session => {
      // Cancellazione FISICA (non soft-delete): il CI sparisce dal grafo.
      // Event Management (B7), nella stessa transazione:
      //  - gli alias (CIAlias -[:ALIAS_OF]-> ci) vanno via con il CI, altrimenti
      //    restano nomi "pendenti" che il vincolo (tenant, kind, value) impedisce
      //    di riassegnare a un altro CI;
      //  - gli Event RAISED_ON il CI restano come orfani coerenti: il CI di un
      //    Event vive SOLO nella relazione (nessuna proprietà ci_id sul nodo,
      //    vedi eventService.ts), quindi DETACH DELETE basta — l'evento torna
      //    "senza CI riconosciuto" e un nuovo aggancio (linkEventToCI /
      //    reevaluateEvent) riparte da zero.
      // Servizi monitorati (ondata 4), nella stessa scrittura: se il CI è una
      // BusinessApplication con una mappa, la ServiceMap e la sua cronologia
      // (ServiceHealthEntry) vanno via con lei — un servizio che non esiste più
      // non ha una salute da mostrare, e la mappa resterebbe orfana (nessuna
      // HAS_SERVICE_MAP) senza modo di cancellarla dall'interfaccia. Le
      // relazioni INCLUDES/EXCLUDES/IMPACTS_SERVICE cadono con il DETACH DELETE
      // della mappa; l'incident del servizio eventualmente aperto NON si
      // cancella (è storia del ticket): resta senza servizio collegato, e va
      // bene. Un CI SEMPLICEMENTE INCLUSO in una mappa altrui non la tocca: la
      // mappa perde la sua INCLUDES e diventa `stale` alla prima valutazione
      // (services/serviceImpact/engine.ts).
      // Revisione 2 · D4.3, PRIMA della cancellazione (dopo non c'è più niente
      // da leggere): (a) l'incident che aveva SOLO questo CI riceve un commento
      // — resta aperto, ma per l'operatore sarebbe un ticket senza motivo, e i
      // suoi allarmi non hanno più un CI da cui essere richiusi; (b) se il CI è
      // una BusinessApplication con una mappa, gli incident di servizio ancora
      // aperti vengono annotati come in `deleteServiceMap`.
      // CM-11: un id che non esiste in questo tenant rispondeva `true`, con
      // tanto di voce d'audit per una cancellazione mai avvenuta.
      const found = await session.executeRead(tx =>
        tx.run(`MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS p`, { id: args.id, tenantId: ctx.tenantId }),
      )
      if (!found.records.length) throw new NotFoundError('CI', args.id)
      // The OpenGrafo CI of every tenant is the product's: not deleted (lib/opengrafoSystemCI.ts).
      assertSystemCIChange(found.records[0].get('p') as Props, 'delete')
      await noteIncidentsBeforeCIDeletion(ctx.tenantId, args.id, session)
      await session.executeWrite(tx =>
        tx.run(
          `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId})
           OPTIONAL MATCH (a:CIAlias {tenant_id: $tenantId})-[:ALIAS_OF]->(n)
           OPTIONAL MATCH (n)-[:HAS_SERVICE_MAP]->(m:ServiceMap {tenant_id: $tenantId})
           OPTIONAL MATCH (m)-[:HAS_HEALTH_HISTORY]->(h:ServiceHealthEntry {tenant_id: $tenantId})
           DETACH DELETE a, h, m, n`,
          { id: args.id, tenantId: ctx.tenantId },
        ),
      )
      cache.invalidate(`ci:${ctx.tenantId}:${neo4jLabel}:`)
      cache.invalidate(`topology:${ctx.tenantId}:`)
      // Servizi monitorati (ondata 5): il CI cancellato si è portato via le sue
      // relazioni, quindi le mappe vive che lo includevano (o che avevano un
      // componente dietro di lui) vanno risincronizzate subito. Dopo il commit
      // e senza mai lanciare: la cancellazione è fatta, la passata di sicurezza
      // recupera se la coda è giù.
      await notifyCIGraphChanged(ctx.tenantId, [args.id], 'ci.deleted')
      void audit(ctx, 'ci.deleted', 'ConfigurationItem', args.id)
      return true
    }, true)
}

/**
 * Revisione 2 · D4.3: i commenti da scrivere PRIMA che il CI sparisca (dopo
 * non c'è più niente da leggere). La regola sta con le altre cancellazioni a
 * cascata, in services/events/cascade.ts; qui si passa solo la sessione della
 * mutation. Import dinamico: il modulo trascina incidentService, inutile a chi
 * crea o aggiorna un CI.
 */
async function noteIncidentsBeforeCIDeletion(tenantId: string, ciId: string, session: Session): Promise<void> {
  const { noteIncidentsBeforeCIDeletion: note } = await import('../../services/events/cascade.js')
  await note(tenantId, ciId, session)
}
