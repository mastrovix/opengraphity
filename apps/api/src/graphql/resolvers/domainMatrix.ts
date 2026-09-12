/**
 * Le matrici di dominio dall'interfaccia (ondata 7 · A7-4).
 *
 * Il nucleo (`lib/domainMatrix.ts`) legge e traduce; qui si **mostra** e si
 * **salva**. Due scelte da motivare:
 *
 *  1. La query non ritorna «le celle salvate» ma **tutte le combinazioni che i
 *     vocabolari del cliente rendono possibili**, con `value: null` dove la
 *     matrice non arriva. È il solo modo di far vedere il buco: una matrice
 *     con un buco non si nota finché un incident non si apre, e allora fallisce
 *     in faccia a chi non l'ha configurata. In più si elencano le chiavi
 *     rimaste fuori vocabolario (`stale`), cioè il residuo di una rinomina.
 *
 *  2. La mutation rifiuta una matrice **incompleta**, non solo una con valori
 *     sbagliati. Salvare un buco vorrebbe dire spostare l'errore da adesso — a
 *     un admin che sta guardando la pagina e può rimediare — a dopo, dentro un
 *     job di ingest. È la stessa preferenza di `updateEventPolicy`.
 */
import type { GraphQLContext } from '../../context.js'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { ValidationError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import {
  DOMAIN_MATRIX_KINDS, domainVocabulary, isDomainMatrixKind,
  loadDomainMatrix, matrixKey, type DomainMatrixKind,
} from '../../lib/domainMatrix.js'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'
import { criticalServiceCriticalities } from '../../services/serviceImpact/incident.js'
import { preApprovedChangeTypes, setPreApprovedChangeTypes, changeTypeVocabulary } from '../../lib/changePolicy.js'
import { riskBandThresholds, setRiskBandThresholds } from '../../lib/riskBands.js'
import { configurationIssues } from '../../lib/configurationIssues.js'

interface CellOut { key: string; inputs: string[]; value: string | null }

export interface DomainMatrixOut {
  kind:         DomainMatrixKind
  inputs:       string[]
  output:       string
  inputValues:  string[][]
  outputValues: string[]
  cells:        CellOut[]
  missing:      string[]
  stale:        string[]
  invalid:      string[]
  isDefault:    boolean
  updatedAt:    string | null
}

/** Il prodotto cartesiano dei valori d'ingresso, nell'ordine di `inputs`. */
export function cartesianKeys(inputValues: readonly (readonly string[])[]): string[][] {
  return inputValues.reduce<string[][]>(
    (acc, values) => acc.flatMap((prefix) => values.map((v) => [...prefix, v])),
    [[]],
  )
}

async function readMatrix(tenantId: string, kind: DomainMatrixKind): Promise<DomainMatrixOut> {
  const spec = DOMAIN_MATRIX_KINDS[kind]
  const inputValues  = await Promise.all(spec.inputs.map((v) => domainVocabulary(tenantId, v)))
  const outputValues = await domainVocabulary(tenantId, spec.output)
  const matrix = await loadDomainMatrix(tenantId, kind)

  const combos = cartesianKeys(inputValues)
  const cells: CellOut[] = combos.map((values) => {
    const key = matrixKey(...values)
    return { key, inputs: values, value: matrix.entries[key] ?? null }
  })
  const possible = new Set(cells.map((c) => c.key))
  const stale = Object.keys(matrix.entries).filter((k) => !possible.has(k))
  // Le chiavi rimaste fuori vocabolario si MOSTRANO comunque: sono il residuo
  // di una rinomina, e vederle è come si capisce cosa è successo.
  for (const key of stale) cells.push({ key, inputs: key.split('|'), value: matrix.entries[key]! })

  // E il residuo dell'ALTRA metà della rinomina: la chiave è ancora buona ma
  // il VALORE salvato non è più nel vocabolario d'uscita. Dal vivo è il caso
  // di `service_impact` quando si rinominano i valori di `impact`: le quattro
  // chiavi restano valide e la matrice sembrava a posto, mentre ogni cella
  // portava a un impatto che il Dizionario non ha più (`lib/domainValue.ts`).
  const invalid = cells
    .filter((c) => c.value !== null && !outputValues.includes(c.value))
    .map((c) => c.key)

  return {
    kind,
    inputs: [...spec.inputs],
    output: spec.output,
    inputValues: inputValues.map((v) => [...v]),
    outputValues: [...outputValues],
    cells,
    missing: cells.filter((c) => c.value === null).map((c) => c.key),
    stale,
    invalid,
    isDefault: matrix.isDefault,
    updatedAt: matrix.updatedAt,
  }
}

async function domainMatrices(_: unknown, __: unknown, ctx: GraphQLContext): Promise<DomainMatrixOut[]> {
  const kinds = Object.keys(DOMAIN_MATRIX_KINDS) as DomainMatrixKind[]
  const out: DomainMatrixOut[] = []
  for (const kind of kinds) out.push(await readMatrix(ctx.tenantId, kind))
  return out
}

async function updateDomainMatrix(
  _: unknown,
  args: { kind: string; entries: Array<{ key: string; value: string }> },
  ctx: GraphQLContext,
): Promise<DomainMatrixOut> {
  if (!isDomainMatrixKind(args.kind)) {
    throw new ValidationError(
      `Matrice "${args.kind}" inesistente. Ammesse: ${Object.keys(DOMAIN_MATRIX_KINDS).join(', ')}.`,
    )
  }
  const kind = args.kind
  const spec = DOMAIN_MATRIX_KINDS[kind]
  const inputValues  = await Promise.all(spec.inputs.map((v) => domainVocabulary(ctx.tenantId, v)))
  const outputValues = await domainVocabulary(ctx.tenantId, spec.output)

  const entries: Record<string, string> = {}
  for (const e of args.entries) {
    const parts = e.key.split('|')
    if (parts.length !== spec.inputs.length) {
      throw new ValidationError(
        `Matrice "${kind}": la chiave "${e.key}" ha ${parts.length} dimensioni, attese ${spec.inputs.length} (${spec.inputs.join(' × ')}).`,
      )
    }
    parts.forEach((part, i) => {
      if (!inputValues[i]!.includes(part)) {
        throw new ValidationError(
          `Matrice "${kind}": "${part}" non è nel vocabolario "${spec.inputs[i]!}" di questo cliente. Ammessi: ${inputValues[i]!.join(', ')}.`,
        )
      }
    })
    if (!outputValues.includes(e.value)) {
      throw new ValidationError(
        `Matrice "${kind}", cella "${e.key}": "${e.value}" non è nel vocabolario "${spec.output}" di questo cliente. Ammessi: ${outputValues.join(', ')}.`,
      )
    }
    if (e.key in entries) throw new ValidationError(`Matrice "${kind}": la cella "${e.key}" è ripetuta.`)
    entries[e.key] = e.value
  }

  const missing = cartesianKeys(inputValues).map((v) => matrixKey(...v)).filter((k) => !(k in entries))
  if (missing.length) {
    throw new ValidationError(
      `Matrice "${kind}" incompleta: ${missing.length} combinazion${missing.length === 1 ? 'e' : 'i'} senza valore ` +
      `(${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}). ` +
      `Una cella vuota diventa un errore quando serve — nell'apertura di un incident o nell'ingest di un allarme — ` +
      `quindi si compila qui, non si scopre lì.`,
    )
  }

  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ kind: string }>(session, `
      MERGE (m:DomainMatrix {tenant_id: $tenantId, kind: $kind})
      ON CREATE SET m.created_at = $now
      SET m.entries = $entries, m.updated_at = $now, m.updated_by = $userId, m.seeded = false
      RETURN m.kind AS kind
    `, { tenantId: ctx.tenantId, kind, entries: JSON.stringify(entries), now, userId: ctx.userId ?? null })
    if (!row) throw new Error(`Matrice "${kind}": la scrittura non ha toccato nessun nodo`)
  } finally { await session.close() }

  // La leva unica, non `invalidateDomainMatrix` (revisione · C-N9 / D-N1):
  // quella svuotava solo la cache di QUESTO processo, e la cache delle matrici
  // non aveva scadenza. Misurato dal vivo: una matrice corretta dalla pagina
  // restava vecchia nell'events-worker per sempre, cioè «completa la matrice e
  // rigioca il job» — la procedura scritta in `services/events/shared.ts` —
  // non funzionava senza riavviare il worker.
  invalidateSchema(ctx.tenantId)
  void audit(ctx, 'domain_matrix_updated', 'DomainMatrix', kind, { kind, cells: Object.keys(entries).length })
  return readMatrix(ctx.tenantId, kind)
}

async function criticalServiceCriticalitiesQuery(_: unknown, __: unknown, ctx: GraphQLContext): Promise<string[]> {
  return criticalServiceCriticalities(ctx.tenantId)
}

/**
 * I tipi di change pre-approvati (ondata 8). Non è una matrice — «essere
 * pre-approvato» è un concetto del codice, non un valore che il cliente possa
 * rinominare — ma vive nella stessa pagina, perché per l'amministratore è la
 * stessa cosa: una regola di dominio che decide lui.
 */
async function preApprovedChangeTypesQuery(_: unknown, __: unknown, ctx: GraphQLContext) {
  const [types, vocabulary] = await Promise.all([
    preApprovedChangeTypes(ctx.tenantId),
    changeTypeVocabulary(ctx.tenantId),
  ])
  return { types: [...types], vocabulary: [...vocabulary] }
}

async function updatePreApprovedChangeTypes(_: unknown, args: { types: string[] }, ctx: GraphQLContext) {
  // La leva la tira `setPreApprovedChangeTypes`, dov'è la scrittura: quella
  // funzione è chiamata anche da migrazioni e script.
  const saved = await setPreApprovedChangeTypes(ctx.tenantId, args.types)
  void audit(ctx, 'change.pre_approved_types.updated', 'Tenant', ctx.tenantId, { types: [...saved] })
  const vocabulary = await changeTypeVocabulary(ctx.tenantId)
  return { types: [...saved], vocabulary: [...vocabulary] }
}

/**
 * Le soglie delle fasce di rischio (rimedio 3 · revisione C·N-2). Come i tipi
 * pre-approvati: non è una matrice — un punteggio non è un valore di
 * vocabolario — ma per l'amministratore è la stessa cosa, una regola di dominio
 * che decide lui, e vive nella stessa pagina.
 */
async function riskBandThresholdsQuery(_: unknown, __: unknown, ctx: GraphQLContext) {
  const [thresholds, vocabulary, declared] = await Promise.all([
    riskBandThresholds(ctx.tenantId),
    domainVocabulary(ctx.tenantId, 'risk_band'),
    tenantHasRiskBandThresholds(ctx.tenantId),
  ])
  return { thresholds: [...thresholds], vocabulary: [...vocabulary], isDefault: !declared }
}

/** Il cliente le ha dichiarate, o sta usando quelle di fabbrica? */
async function tenantHasRiskBandThresholds(tenantId: string): Promise<boolean> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ declared: boolean }>(session,
      'MATCH (t:Tenant {id: $tenantId}) RETURN t.risk_band_thresholds IS NOT NULL AS declared', { tenantId })
    return row?.declared === true
  } finally { await session.close() }
}

async function updateRiskBandThresholds(
  _: unknown, args: { entries: Array<{ band: string; upTo: number }> }, ctx: GraphQLContext,
) {
  // La leva dell'invalidazione la tira `setRiskBandThresholds`, dov'è la
  // scrittura: la chiamano anche le migrazioni.
  const saved = await setRiskBandThresholds(ctx.tenantId, args.entries)
  void audit(ctx, 'change.risk_band_thresholds.updated', 'Tenant', ctx.tenantId, { thresholds: [...saved] })
  const vocabulary = await domainVocabulary(ctx.tenantId, 'risk_band')
  return { thresholds: [...saved], vocabulary: [...vocabulary], isDefault: false }
}

async function configurationIssuesQuery(_: unknown, __: unknown, ctx: GraphQLContext) {
  return configurationIssues(ctx.tenantId)
}

export const domainMatrixResolvers = {
  Query: {
    configurationIssues: configurationIssuesQuery,
    domainMatrices,
    criticalServiceCriticalities: criticalServiceCriticalitiesQuery,
    preApprovedChangeTypes: preApprovedChangeTypesQuery,
    riskBandThresholds: riskBandThresholdsQuery,
  },
  Mutation: { updateDomainMatrix, updatePreApprovedChangeTypes, updateRiskBandThresholds },
}
