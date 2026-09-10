import { GraphQLError } from 'graphql'
import { ValidationError } from '../../lib/errors.js'
import { withSession } from './ci-utils.js'
import { cache } from '../../lib/cache.js'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { calculateChain } from '../../lib/chainCalculator.js'
import { toSnakeCase } from '../../lib/mappers.js'
import { ciNameKey } from '../../lib/ciNameKey.js'
import { notifyCIGraphChanged, notifyCIMaintenanceChanged } from '../../services/serviceImpact/sync.js'
import { CI_LIFECYCLE_MAINTENANCE } from '../../services/serviceImpact/engine.js'

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
): Promise<string | null> {
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
 * Enforces `required`, per-field `validationScript` and the type-level
 * `validationScript` of the metamodel on the API (the browser already does
 * it; an API-key client or a broken sandbox must not bypass it). `input` is
 * the full camelCase CI (for updates: existing values merged with the patch).
 * Throws ValidationError with the script's message. Exported for tests.
 */
export async function validateCIInput(
  ciType: CITypeWithDefinitions,
  input: Record<string, unknown>,
  tenantId: string,
): Promise<void> {
  const errors: string[] = []
  for (const field of ciType.fields) {
    if (field.isSystem) continue   // id/created_at/…: managed by the API, never user input
    const value = input[field.name]
    if (field.required && (value == null || value === '')) {
      errors.push(`${field.label || field.name} è obbligatorio`)
      continue
    }
    if (field.validationScript && value != null) {
      const err = await runValidationScript(field.validationScript, { input, value }, `${ciType.name}.${field.name}.validation_script`, tenantId)
      if (err) errors.push(`${field.label || field.name}: ${err}`)
    }
  }
  if (errors.length) throw new ValidationError(`Validazione CI fallita: ${errors.join('; ')}`)

  if (ciType.validationScript) {
    const err = await runValidationScript(ciType.validationScript, { input }, `${ciType.name}.validation_script`, tenantId)
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
        status:      input['status']      ?? 'active',
        environment: input['environment'] ?? null,
        description: input['description'] ?? null,
        notes:       input['notes']       ?? null,
        created_at:  now, updated_at: now,
      }
      for (const field of ciType.fields) {
        if (input[field.name] !== undefined) {
          props[toSnakeCase(field.name)] = input[field.name]
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
      await validateCIInput(ciType, merged, ctx.tenantId)

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      for (const f of BASE_FIELDS) {
        if (input[f] !== undefined) updates[f] = input[f]
      }
      if (input['name'] !== undefined) updates['name_key'] = ciNameKey(input['name'])
      for (const field of ciType.fields) {
        if (input[field.name] !== undefined) {
          updates[toSnakeCase(field.name)] = input[field.name]
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
      const wasMaintenance = current['status'] === CI_LIFECYCLE_MAINTENANCE
      const isMaintenance  = updates['status'] === undefined ? wasMaintenance : updates['status'] === CI_LIFECYCLE_MAINTENANCE
      if (wasMaintenance !== isMaintenance) {
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
