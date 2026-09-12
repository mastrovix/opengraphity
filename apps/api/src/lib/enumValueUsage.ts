/**
 * Chi sta usando un valore di un vocabolario (ondata 7 · B7-2 / A-13).
 *
 * ## Il difetto
 * `updateEnumType` sostituiva `e.values` **in blocco**: nessun conteggio, e
 * i record restavano nel grafo con un valore che il vocabolario non aveva più.
 * Conseguenza silenziosa: i filtri e i widget per valore non offrono più quel
 * valore (i record «spariscono» dai conteggi), il form del CI mostrava il
 * campo **vuoto** e un salvataggio distratto lo azzerava. Dal vivo su c-one
 * erano 68 CI su due valori (`expired` 49, `revoked` 19) — l'ondata 0 ha
 * allineato il vocabolario al dato, il meccanismo restava aperto.
 *
 * ## La scelta, e perché
 * Togliere un valore in uso è **rifiutato**, e il messaggio dice quanti record
 * lo usano e dove. Chi vuole procedere passa una **sostituzione esplicita**
 * (`replacements: [{from, to}]`): i record vengono riscritti nella stessa
 * transazione del vocabolario, con audit.
 *
 * Perché non riscrivere da soli: cambiare il valore di 49 CI è una modifica
 * ai *dati*, non al vocabolario, e farla come effetto collaterale di una
 * modifica al Dizionario è il tipo di silenzio che quest'ondata chiude.
 * Perché non lasciar fare e basta: è esattamente il difetto A-13.
 *
 * ## Dove si cerca
 * I campi governati da questo vocabolario, cioè quelli agganciati
 * (`USES_ENUM`) a un `EnumTypeDefinition` con lo **stesso nome**. Il nome, non
 * l'id e non il proprietario: la personalizzazione dell'ondata 1 è una copia
 * per tenant con lo stesso nome che vince in lettura, e dal vivo i 31
 * `USES_ENUM` puntano tutti a nodi di UN cliente (C-6) — cercare per id, o
 * filtrare il proprietario del nodo agganciato, non troverebbe nulla proprio
 * nel caso che conta, e si permetterebbe di togliere un valore in uso.
 * L'isolamento è sul TIPO (spedito o di questo cliente) e sul conteggio, che
 * legge solo nodi di questo tenant.
 *
 * Più la **semantica del ciclo di vita** del tenant (`lib/ciLifecycle.ts`): è
 * il pezzo che rende sicuro tenere quella semantica in due liste sulla policy
 * invece che come ruolo sul valore dell'enum. Togliere `decommissioned`
 * mentre `retired_statuses` lo cita viene rifiutato.
 */
import type { Session, ManagedTransaction } from 'neo4j-driver'
import { toNumber } from '@opengraphity/neo4j'
import { assertFieldName, assertLabel } from './cypherIdentifiers.js'
import { toSnakeCase } from './mappers.js'
import { lifecyclePolicyReferences, CI_STATUS_VOCABULARY } from './ciLifecycle.js'

/** Etichetta vera dei nodi del tipo base `__base__`: i CI non hanno un'etichetta «__base__». */
export const BASE_TYPE_PLACEHOLDER = '__base__'
export const BASE_TYPE_LABEL = 'ConfigurationItem'

export interface EnumValueBinding {
  /** Etichetta Neo4j dei nodi che portano il valore (`ConfigurationItem`, `Incident`, …). */
  label: string
  /** Proprietà del nodo (snake_case). */
  property: string
  /** Nome del campo nel metamodello, per il messaggio. */
  fieldName: string
  /** Nome del tipo nel metamodello, per il messaggio. */
  typeName: string
}

/** Dove finiscono i valori di questo vocabolario: etichetta + proprietà, una volta per coppia. */
export async function enumValueBindings(
  session: Session | ManagedTransaction, tenantId: string, vocabularyName: string,
): Promise<EnumValueBinding[]> {
  const r = await run(session, `
    // tenant-ok: qui NON si leggono i valori di un vocabolario (e quindi non
    // c'è nulla da isolare su \`e\`): si chiede quali CAMPI sono governati dal
    // vocabolario con questo NOME. Il proprietario del nodo agganciato è
    // irrilevante — e filtrarlo sarebbe dannoso, perché dal vivo i campi
    // condivisi sono agganciati ai nodi di UN cliente (C-6), quindi su ogni
    // altro tenant non si troverebbe nessun campo e si permetterebbe di
    // togliere un valore ancora in uso. L'isolamento sta dove conta: il TIPO
    // deve essere spedito o di questo cliente (riga sotto) e il conteggio
    // legge solo nodi con \`tenant_id = $tenantId\`.
    // Nessun filtro su \`t.active\`: il tipo base \`__base__\` è \`active = false\`
    // per costruzione (non è un tipo che si crea), e porta il campo che conta
    // più di tutti — \`status\`. Anche un tipo disattivato dal cliente ha
    // ancora i suoi record nel grafo con quel valore: contarli è la direzione
    // sicura (sotto-contare vorrebbe dire permettere di togliere un valore in uso).
    MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition)-[:USES_ENUM]->(e:EnumTypeDefinition {name: $name})
    WHERE t.scope IN ['base', 'itil'] OR t.tenant_id = $tenantId
    RETURN DISTINCT coalesce(t.neo4j_label, t.name) AS label, t.name AS typeName, f.name AS fieldName
    ORDER BY label, fieldName
  `, { tenantId, name: vocabularyName })
  const out: EnumValueBinding[] = []
  for (const rec of r) {
    const rawLabel = String(rec.label)
    const label = rawLabel === BASE_TYPE_PLACEHOLDER ? BASE_TYPE_LABEL : rawLabel
    const fieldName = String(rec.fieldName)
    out.push({
      // Le due identità finiscono nel testo di una query: validate, mai interpolate a occhi chiusi.
      label:    assertLabel(label, `vocabolario "${vocabularyName}": etichetta del tipo ${String(rec.typeName)}`),
      // `assertFieldName` e non `assertWritableCIPropertyKey`: qui non si
      // valuta se un campo del metamodello *possa* esistere (quello lo fa il
      // disegnatore), si mette una proprietà già esistente nel testo di una
      // query. `chain` e `type` sono proprietà riservate ma reali, e contarle
      // deve funzionare.
      property: assertFieldName(toSnakeCase(fieldName), `vocabolario "${vocabularyName}": campo ${fieldName}`),
      fieldName,
      typeName: String(rec.typeName),
    })
  }
  return out
}

export interface EnumValueUsage {
  value: string
  /** Record che portano ancora il valore, per tipo. */
  records: { typeName: string; fieldName: string; count: number }[]
  /** Liste della policy del ciclo di vita che citano il valore (`retired_statuses`, …). */
  policyLists: readonly string[]
  total: number
}

/**
 * Quanti record usano ciascuno dei `values` dati. Conta anche i record
 * cancellati logicamente (`deleted = true`): si possono ripristinare, e un
 * ripristino su un valore inesistente sarebbe lo stesso difetto più tardi.
 */
export async function countEnumValueUsage(
  session: Session, tenantId: string, vocabularyName: string, values: readonly string[],
): Promise<EnumValueUsage[]> {
  if (values.length === 0) return []
  const bindings = await enumValueBindings(session, tenantId, vocabularyName)
  const byValue = new Map<string, EnumValueUsage>(
    values.map((v) => [v, { value: v, records: [], policyLists: [], total: 0 }]),
  )
  for (const b of bindings) {
    const counted = await run(session, `
      MATCH (n:${b.label} {tenant_id: $tenantId})
      WHERE n.${b.property} IN $values
      RETURN n.${b.property} AS value, count(*) AS n
    `, { tenantId, values: [...values] })
    for (const row of counted) {
      const value = String(row.value)
      const count = toNumber(row.n)
      const hit = byValue.get(value)
      if (!hit || count === 0) continue
      hit.records.push({ typeName: b.typeName, fieldName: b.fieldName, count })
      hit.total += count
    }
  }
  // La semantica del ciclo di vita è un uso a tutti gli effetti: se la si
  // perde, allarmi e mappe cambiano comportamento in silenzio.
  if (vocabularyName === CI_STATUS_VOCABULARY) {
    for (const usage of byValue.values()) {
      usage.policyLists = await lifecyclePolicyReferences(session, tenantId, usage.value)
      usage.total += usage.policyLists.length
    }
  }
  return [...byValue.values()].filter((u) => u.total > 0)
}

/** Il messaggio del rifiuto: dice cosa usa il valore e come procedere. */
export function enumValueUsageMessage(vocabularyName: string, usages: readonly EnumValueUsage[]): string {
  const parts = usages.map((u) => {
    const where = [
      ...u.records.map((r) => `${String(r.count)} ${r.typeName}.${r.fieldName}`),
      ...u.policyLists.map((l) => `la policy degli allarmi (${l})`),
    ]
    return `"${u.value}" è ancora usato da ${where.join(', ')}`
  })
  return (
    `Il vocabolario "${vocabularyName}" non può perdere questi valori: ${parts.join('; ')}. ` +
    `Cambia prima quei record, oppure indica un valore di sostituzione ` +
    `(replacements: [{from: "…", to: "…"}]) e verranno riscritti insieme al vocabolario.`
  )
}

/**
 * Riscrive `from` → `to` su tutti i record e nelle liste della policy, nella
 * transazione del chiamante. Restituisce quanti record ha toccato.
 */
export async function replaceEnumValue(
  tx: ManagedTransaction, tenantId: string, vocabularyName: string, from: string, to: string,
): Promise<number> {
  const bindings = await enumValueBindings(tx, tenantId, vocabularyName)
  let touched = 0
  for (const b of bindings) {
    const updated = await runWrite(tx, `
      MATCH (n:${b.label} {tenant_id: $tenantId})
      WHERE n.${b.property} = $from
      SET n.${b.property} = $to
      RETURN count(*) AS n
    `, { tenantId, from, to })
    for (const row of updated) touched += toNumber(row.n)
  }
  if (vocabularyName === CI_STATUS_VOCABULARY) {
    // Le tre liste del ciclo di vita nella policy: sostituzione testuale sul
    // JSON no — si rilegge, si riscrive la lista, si risalva.
    const r = await run(tx, 'MATCH (t:Tenant {id: $tenantId}) RETURN t.event_policy AS raw', { tenantId })
    const raw = r.length ? r[0]!.raw : null
    if (typeof raw === 'string' && raw !== '') {
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { parsed = null }
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const p = parsed as Record<string, unknown>
        let changed = false
        for (const key of ['ignore_lifecycle_statuses', 'retired_statuses', 'maintenance_statuses']) {
          const list = p[key]
          if (!Array.isArray(list) || !list.includes(from)) continue
          const next = [...new Set(list.map((v) => (v === from ? to : v)))]
          p[key] = next
          changed = true
        }
        if (changed) {
          await runWrite(tx, 'MATCH (t:Tenant {id: $tenantId}) SET t.event_policy = $policy, t.updated_at = $now',
            { tenantId, policy: JSON.stringify(p), now: new Date().toISOString() })
        }
      }
    }
  }
  return touched
}

// ── Dettagli ─────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

/** Lettura, che la si dia una sessione o la transazione del chiamante. */
async function run(q: Session | ManagedTransaction, cypher: string, params: Record<string, unknown>): Promise<Row[]> {
  const asSession = q as Session
  const res = typeof asSession.executeRead === 'function'
    ? await asSession.executeRead((tx) => tx.run(cypher, params))
    : await (q as ManagedTransaction).run(cypher, params)
  return rows(res)
}

/** Scrittura: sempre dentro la transazione del chiamante (il vocabolario e i record cambiano insieme). */
async function runWrite(tx: ManagedTransaction, cypher: string, params: Record<string, unknown>): Promise<Row[]> {
  return rows(await tx.run(cypher, params))
}

interface RecordLike { keys: readonly PropertyKey[]; get(k: never): unknown }

function rows(res: { records: readonly RecordLike[] }): Row[] {
  return res.records.map((rec) =>
    Object.fromEntries(rec.keys.map((k) => [String(k), (rec.get as (key: PropertyKey) => unknown)(k)])) as Row,
  )
}
