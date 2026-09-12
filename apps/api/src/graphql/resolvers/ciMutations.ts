import { GraphQLError } from 'graphql'
import type { Session } from 'neo4j-driver'
import { ValidationError } from '../../lib/errors.js'
import { withSession } from './ci-utils.js'
import { cache } from '../../lib/cache.js'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { calculateChain } from '../../lib/chainCalculator.js'
import { toSnakeCase } from '../../lib/mappers.js'
import { assertWritableCIPropertyKey } from '../../lib/cypherIdentifiers.js'
import { ciNameKey } from '../../lib/ciNameKey.js'
import { initialCIStatus } from '../../lib/ciLifecycle.js'
import { notifyCIGraphChanged, notifyCIMaintenanceChanged } from '../../services/serviceImpact/sync.js'
import { isMaintenanceLifecycle, resolveCILifecycleSemantics } from '../../lib/ciLifecycle.js'
import { recomputeCIHealth } from '../../services/events/ciHealth.js'
import { assertScriptingEnabled, isTenantOwnedDefinition } from '../../lib/scriptingPlan.js'

type Props = Record<string, unknown>

const SAFE_LABEL_RE = /^[A-Za-z][A-Za-z0-9_]*$/
function validateLabel(label: string): void {
  if (!SAFE_LABEL_RE.test(label)) throw new ValidationError(`Invalid CI type label: ${label}`)
}

const BASE_FIELDS = ['name', 'status', 'environment', 'description', 'notes'] as const

// ── Metamodel validation, server side (F-13) ─────────────────────────────────

/**
 * Runs one metamodel validation script in the scripting sandbox. The script
 * has the same contract as in the browser (CIDynamicForm/ciValidator): the
 * free variables `input` (whole CI, camelCase) and `value` (the field value)
 * are in scope and the script THROWS to reject. Returns the rejection
 * message, or null when the script accepted the value.
 */
async function runValidationScript(
  code: string,
  data: { input: Record<string, unknown>; value?: unknown },
  name: string,
  tenantId: string,
  scope: string | undefined,
): Promise<string | null> {
  // Limite di piano (D-12): uno script scritto dal cliente non gira se il suo
  // piano non include gli script, e il rifiuto è esplicito. Gli script del
  // metamodello condiviso (scope base/itil: url, ipAddress, expiresAt,
  // certificate) sono comportamento del prodotto e non passano dal limite.
  if (isTenantOwnedDefinition(scope)) {
    await assertScriptingEnabled(tenantId, `${name}`)
  }
  const { runScript } = await import('@opengraphity/scripting')
  const now = new Date().toISOString()
  const result = await runScript(
    {
      id: name, tenant_id: tenantId, name, trigger: 'manual',
      code: `const input = ctx.input;\nconst value = ctx.value;\n${code}`,
      enabled: true, created_at: now, updated_at: now,
    },
    { input: data.input, value: data.value ?? null, tenantId },
  )
  return result.success ? null : (result.error ?? `${name} failed`)
}

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
    if (field.isSystem) continue   // id/created_at/…: managed by the API, never user input
    const value = input[field.name]
    if (field.required && (value == null || value === '')) {
      errors.push(`${field.label || field.name} è obbligatorio`)
      continue
    }
    if (
      field.fieldType === 'enum' && value != null && value !== '' &&
      field.enumValues.length > 0 && (touched === undefined || touched.has(field.name)) &&
      !field.enumValues.includes(String(value))
    ) {
      errors.push(
        `${field.label || field.name}: "${String(value)}" non è nel vocabolario di questo cliente. ` +
        `Ammessi: ${field.enumValues.join(', ')}`,
      )
      continue
    }
    if (field.validationScript && value != null) {
      const err = await runValidationScript(field.validationScript, { input, value }, `${ciType.name}.${field.name}.validation_script`, tenantId, field.scope)
      if (err) errors.push(`${field.label || field.name}: ${err}`)
    }
  }
  if (errors.length) throw new ValidationError(`Validazione CI fallita: ${errors.join('; ')}`)

  if (ciType.validationScript) {
    const err = await runValidationScript(ciType.validationScript, { input }, `${ciType.name}.validation_script`, tenantId, ciType.scope)
    if (err) throw new ValidationError(`Validazione CI fallita: ${err}`)
  }
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
      const result = await session.executeWrite(tx =>
        tx.run(`CREATE (n:ConfigurationItem:${neo4jLabel} $props) RETURN properties(n) AS p`, { props }),
      )

      if (input['ownerGroupId']) {
        await session.executeWrite(tx =>
          tx.run(
            `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
             MERGE (n)-[:OWNED_BY]->(t)`,
            { id, teamId: input['ownerGroupId'], tenantId: ctx.tenantId },
          ),
        )
      }
      if (input['supportGroupId']) {
        await session.executeWrite(tx =>
          tx.run(
            `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
             MERGE (n)-[:SUPPORTED_BY]->(t)`,
            { id, teamId: input['supportGroupId'], tenantId: ctx.tenantId },
          ),
        )
      }

      // Calculate chain based on chain_families of CI type and upstream
      // dependencies. A failure must surface: a CI with no chain silently
      // breaks impact analysis for everything downstream.
      await calculateChain(id, ctx.tenantId)

      cache.invalidate(`ci:${ctx.tenantId}:${neo4jLabel}`)
      cache.invalidate(`topology:${ctx.tenantId}`)
      void audit(ctx, 'ci.created', 'ConfigurationItem', id)
      return mapCI(result.records[0].get('p') as Props, ciType)
    }, true)
  }
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
    withSession(async session => {
      const { id, input } = args

      // Validation runs on the CI as it will be after the patch, like the
      // browser validates the whole form: read the current properties first.
      const existing = await session.executeRead(tx =>
        tx.run(
          `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS p`,
          { id, tenantId: ctx.tenantId },
        ),
      )
      if (!existing.records.length) throw new GraphQLError('CI non trovato', { extensions: { code: 'NOT_FOUND' } })
      const current = existing.records[0].get('p') as Props

      const merged: Record<string, unknown> = {}
      for (const f of BASE_FIELDS) merged[f] = input[f] !== undefined ? input[f] : (current[f] ?? null)
      for (const field of ciType.fields) {
        merged[field.name] = input[field.name] !== undefined
          ? input[field.name]
          : (current[toSnakeCase(field.name)] ?? current[field.name] ?? null)
      }
      await validateCIInput(ciType, merged, ctx.tenantId, new Set(Object.keys(input)))

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
      const result = await session.executeWrite(tx =>
        tx.run(
          `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) SET n += $updates RETURN properties(n) AS p`,
          { id, tenantId: ctx.tenantId, updates },
        ),
      )
      if (!result.records.length) throw new GraphQLError('CI non trovato', { extensions: { code: 'NOT_FOUND' } })
      cache.invalidate(`ci:${ctx.tenantId}:${neo4jLabel}`)
      cache.invalidate(`topology:${ctx.tenantId}`)
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
      const wasMaintenance = isMaintenanceLifecycle(current['status'] as string | null, lifecycle)
      const isMaintenance  = updates['status'] === undefined ? wasMaintenance : isMaintenanceLifecycle(updates['status'] as string | null, lifecycle)
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
      return mapCI(result.records[0].get('p') as Props, ciType)
    }, true)
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
      cache.invalidate(`ci:${ctx.tenantId}:${neo4jLabel}`)
      cache.invalidate(`topology:${ctx.tenantId}`)
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
