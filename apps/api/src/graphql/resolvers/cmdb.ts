import { GraphQLError } from 'graphql'
/**
 * CMDB resolvers wired in resolvers/index.ts: only `updateCIFields`, which
 * writes through `updateCIRecord` (ciMutations.ts), like `update<Type>`.
 *
 * The former `configurationItems/configurationItem/blastRadius/ciTypes`
 * queries, `createConfigurationItem/updateConfigurationItem/addCIDependency`
 * mutations and the `ConfigurationItem.dependencies*` field resolvers were
 * dead code (B-09): never referenced by index.ts nor by the schema, with a
 * tenant/label scoping that diverged from the live dynamic CI resolvers.
 */
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { assertWritablePropertyKey, assertWritableCIPropertyKey } from '../../lib/cypherIdentifiers.js'
import { runQuery, toNumber } from '@opengraphity/neo4j'
import { loadMetamodel, type CITypeWithDefinitions, type CIFieldDefinition } from '@opengraphity/schema-generator'
import { ENUM_SCOPE } from '../../lib/enumScope.js'
import { updateCIRecord } from './ciMutations.js'
import type { GraphQLContext } from '../../context.js'
import { ciTypeFromLabels } from '../../lib/ciTypeFromLabels.js'
import { ciLabelPredicateForTenant } from '../../lib/ciLabelsForTenant.js'
import { toSnakeCase } from '../../lib/mappers.js'
import { withSession } from './ci-utils.js'

type Props = Record<string, unknown>

function mapCI(tenantId: string, props: Props, label?: string) {
  return {
    id:          props['id']          as string,
    tenantId:    props['tenant_id']   as string,
    name:        props['name']        as string,
    type:        label ? ciTypeFromLabels(tenantId, [label]) : (props['type'] as string ?? 'unknown'),
    status:      props['status']      as string,
    environment: props['environment'] as string,
    createdAt:   props['created_at']  as string,
    updatedAt:   props['updated_at']  as string,
    // optional technical fields
    ipAddress:   (props['ip_address']  ?? null) as string | null,
    expiryDate:  (props['expiry_date'] ?? null) as string | null,
    location:    (props['location']    ?? null) as string | null,
    vendor:      (props['vendor']      ?? null) as string | null,
    version:     (props['version']     ?? null) as string | null,
    port:        props['port'] != null ? toNumber(props['port']) : null,
    url:         (props['url']         ?? null) as string | null,
    region:      (props['region']      ?? null) as string | null,
    notes:       (props['notes']       ?? null) as string | null,
    chain:       (props['chain']      ?? null) as string | null,
    isInfrastructure: props['is_infrastructure'] === true,
    dependencies: [],
    dependents:   [],
  }
}

/**
 * La forma di una chiave di `customFields`: le DUE guardie di sempre, prima di
 * guardare il metamodello. La prima valida la FORMA del nome (è lei che ferma
 * l'injection in una chiave: `x = 1 SET ci.tenant_id`, backtick, spazi) e
 * rifiuta le chiavi di sistema di qualunque nodo; la seconda aggiunge le
 * riservate DEI CI (`name_key`, la salute, `chain`, `type`, i `discovery_*`).
 * Sono ortogonali e servono entrambe.
 */
function assertCustomKey(key: string): void {
  const named = assertWritablePropertyKey(toSnakeCase(key), 'customFields')
  assertWritableCIPropertyKey(named, `customFields.${key}`)
}

/** Un valore arrivato come testo dal modulo, nel tipo che il campo dichiara. */
function coerceFieldValue(field: CIFieldDefinition, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw !== 'string') return raw
  const what = field.label || field.name
  if (field.fieldType === 'number') {
    const n = Number(raw.trim())
    if (raw.trim() === '' || !Number.isFinite(n)) {
      throw new ValidationError(`${what}: "${raw}" is not a number.`, { key: 'errors.ci.notANumber', params: { field: what, value: raw } })
    }
    return n
  }
  if (field.fieldType === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new ValidationError(`${what}: "${raw}" is not true or false.`, { key: 'errors.ci.notABoolean', params: { field: what, value: raw } })
  }
  return raw
}

/**
 * L'input di `updateCIFields` nella forma degli input del tipo (camelCase), con
 * le chiavi di `customFields` controllate contro il METAMODELLO del tipo
 * (revisione del 15 set 2026 · CM-2): prima si scriveva qualunque chiave di
 * forma valida, e dal vivo è finita sul CI una `campo_inventato` che nessun
 * tipo dichiara. I valori arrivano come testo dal modulo e prendono il tipo
 * del campo (un numero resta un numero). Exported for tests.
 */
export function ciInputFromFields(
  input: { name?: string; status?: string; environment?: string; description?: string; notes?: string; isInfrastructure?: boolean | null; customFields?: string },
  ciType: CITypeWithDefinitions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of ['name', 'status', 'environment', 'description', 'notes'] as const) {
    if (input[f] !== undefined && input[f] !== null) out[f] = input[f]
  }
  // The infrastructure flag (24 Sep 2026): a base field, a boolean, validated with the others.
  if (input.isInfrastructure !== undefined && input.isInfrastructure !== null) out['isInfrastructure'] = input.isInfrastructure
  if (!input.customFields) return out
  let custom: unknown
  try { custom = JSON.parse(input.customFields) }
  catch (e) {
    throw new ValidationError(`customFields is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { key: 'errors.ci.customFieldsNotJson' })
  }
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) {
    throw new ValidationError('customFields must be a JSON object', { key: 'errors.ci.customFieldsNotObject' })
  }
  for (const [key, val] of Object.entries(custom as Record<string, unknown>)) {
    assertCustomKey(key)
    const field = ciType.fields.find((f) => f.name === key && !f.isSystem)
    if (!field) {
      throw new ValidationError(
        `customFields: "${key}" is not a field of type "${ciType.label || ciType.name}".`,
        { key: 'errors.ci.unknownField', params: { field: key, type: ciType.label || ciType.name } },
      )
    }
    out[key] = coerceFieldValue(field, val)
  }
  return out
}

/**
 * La modifica di un CI dal dettaglio (e dai criteri dei gruppi dinamici).
 * Non scrive più da sé: trova il tipo del CI e passa da `updateCIRecord`, la
 * stessa strada di `update<Tipo>` — vocabolario, obbligatori, script,
 * `name_key`, gancio della manutenzione, audit (CM-2).
 */
async function updateCIFields(
  _: unknown,
  args: {
    id: string
    input: {
      name?: string; status?: string; environment?: string
      description?: string; notes?: string; isInfrastructure?: boolean | null; customFields?: string
    }
  },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  return withSession(async (session) => {
    // Le etichette sono quelle del metamodello del tenant: con la lista fissa
    // un CI di un tipo del cliente non veniva trovato (A-9).
    const rows = await runQuery<{ label: string | null }>(session, `
      MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId})
      WHERE ${await ciLabelPredicateForTenant('ci', ctx.tenantId)}
      RETURN head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS label
    `, { id, tenantId: ctx.tenantId })
    const row = rows[0]
    if (!row) throw new NotFoundError('ConfigurationItem')
    // L'ETICHETTA, non `props.type`: i nodi CI non portano `type` (dal vivo 0
    // su 2049), e senza di essa il tipo non si può dire.
    if (!row.label) {
      throw new GraphQLError(
        `ConfigurationItem ${id} has no type label besides ConfigurationItem: incomplete data, its type cannot be told.`,
        { extensions: { code: 'CONFLICT', i18n: { key: 'errors.ci.noTypeLabel', params: { id } } } },
      )
    }
    const ciType = (await loadMetamodel(ctx.tenantId, ENUM_SCOPE)).find((t) => t.neo4jLabel === row.label)
    if (!ciType) {
      throw new GraphQLError(
        `CI ${id}: no active CI type of this tenant declares label ${row.label}.`,
        { extensions: { code: 'CONFLICT', i18n: { key: 'errors.ci.unknownTypeOnRecord', params: { type: JSON.stringify(row.label) } } } },
      )
    }
    const props = await updateCIRecord(session, ctx, ciType, row.label, id, ciInputFromFields(input, ciType))
    return mapCI(ctx.tenantId, props, row.label)
  }, true)
}

// ── Export ───────────────────────────────────────────────────────────────────

export const cmdbResolvers = {
  Mutation: { updateCIFields },
}
