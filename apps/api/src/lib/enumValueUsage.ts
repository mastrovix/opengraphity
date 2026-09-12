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
import { DOMAIN_MATRIX_KINDS, type DomainMatrixKind } from './domainMatrix.js'

/**
 * Dove vivono i valori dei vocabolari **di dominio** (revisione delle otto
 * ondate · C·N-7 / D·N-2).
 *
 * ## Il buco
 * `enumValueBindings` trova i campi agganciati con `USES_ENUM`, cioè i campi
 * del **metamodello dei CI e ITIL**. Ma i vocabolari di dominio non sono campi
 * del metamodello: `impact`, `urgency`, `priority` sono proprietà scritte
 * direttamente sui nodi ITIL, e nessun `USES_ENUM` le collega al vocabolario.
 * Verificato dal vivo nella revisione: l'ITIL type `incident` non ha nemmeno un
 * campo `impact`. Risultato — togliere un valore da `urgency` era **permesso
 * contando zero usi**, con migliaia di incident che lo portavano. Il conteggio
 * dava una fiducia che non aveva una base.
 *
 * ## La tabella
 * Dichiarata, perché nel grafo non c'è niente da cui dedurla, e verificata
 * contro `db.schema.nodeTypeProperties()` sul dato vivo. Il test
 * `lib/__tests__/enumValueUsage.test.ts` pretende che ogni vocabolario
 * nominato da `DOMAIN_MATRIX_KINDS` (ingressi e uscite) compaia qui o sia
 * dichiarato senza record: una matrice nuova non può entrare senza dire dove
 * vivono i suoi valori.
 *
 * ## Due cose che sembrano errori e non lo sono
 *  - **`priority` → `Incident.severity`**: sull'incident la priorità si chiama
 *    `severity` (`lib/priority.ts` la valida contro il vocabolario `priority`).
 *    Non è un refuso: è il nome storico della proprietà.
 *  - **`severity` e `priority` puntano alla stessa proprietà**: sono due
 *    vocabolari distinti con gli stessi valori di fabbrica, e a seconda del
 *    cammino (monitoraggio o impatto×urgenza) su `Incident.severity` finisce
 *    l'uno o l'altro. Contare due volte è la direzione **sicura**: sotto-contare
 *    vorrebbe dire permettere di togliere un valore in uso, che è il difetto.
 */
export const DOMAIN_VALUE_BINDINGS: Readonly<Record<string, readonly { label: string; property: string }[]>> = {
  impact:  [
    { label: 'Incident',                   property: 'impact' },
    { label: 'Problem',                    property: 'impact' },
    { label: 'StandardChangeCatalogEntry', property: 'impact' },
  ],
  urgency: [
    { label: 'Incident', property: 'urgency' },
    { label: 'Problem',  property: 'urgency' },
  ],
  priority: [
    { label: 'Incident',       property: 'severity' },   // sì: `severity`, vedi sopra
    { label: 'Change',         property: 'priority' },
    { label: 'Problem',        property: 'priority' },
    { label: 'ServiceRequest', property: 'priority' },
    { label: 'SLAPolicyNode',  property: 'priority' },   // una policy SLA punta a una priorità
  ],
  severity: [
    { label: 'Incident', property: 'severity' },
  ],
  change_type: [
    { label: 'Change', property: 'change_type' },
  ],
  service_criticality: [
    { label: 'BusinessApplication', property: 'criticality' },
  ],
  event_severity: [
    { label: 'Event',             property: 'severity' },
    { label: 'Anomaly',           property: 'severity' },
    { label: 'EventHistoryEntry', property: 'severity' },
  ],
  /**
   * Nessun record: la fascia di rischio si **deriva** dal punteggio a ogni
   * lettura, non si salva sui nodi. I suoi valori vivono solo nelle chiavi
   * della matrice `change_priority`, che il conteggio scansiona a parte.
   */
  risk_band: [],
  /** Nessun record: è il vocabolario del file di import, non del prodotto. */
  import_severity: [],
}

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
  // I vocabolari di dominio non hanno `USES_ENUM`: le loro proprietà sono
  // dichiarate (vedi DOMAIN_VALUE_BINDINGS in testa al file). Si aggiungono
  // DOPO e solo se non già trovate: quando una coppia (etichetta, proprietà)
  // arriva da entrambe le strade vince quella del metamodello, che porta i nomi
  // veri di tipo e campo per il messaggio. E contarla due volte raddoppierebbe
  // i numeri.
  const seen = new Set(out.map((b) => `${b.label}.${b.property}`))
  for (const b of DOMAIN_VALUE_BINDINGS[vocabularyName] ?? []) {
    const label    = assertLabel(b.label, `vocabolario "${vocabularyName}": etichetta dichiarata`)
    const property = assertFieldName(b.property, `vocabolario "${vocabularyName}": proprietà dichiarata`)
    if (seen.has(`${label}.${property}`)) continue
    seen.add(`${label}.${property}`)
    out.push({ label, property, fieldName: property, typeName: label })
  }
  return out
}

/**
 * Le matrici di dominio che citano un valore di questo vocabolario, nelle
 * **chiavi** o nei **valori** (revisione delle otto ondate · D·N-2).
 *
 * L'ondata 7 rifiutava di togliere un valore «in uso», ma «in uso» voleva dire
 * *record nel grafo* più *liste del ciclo di vita*: le `DomainMatrix` — che
 * l'ondata 7 ha appena creato, e che si rompono esattamente così — non erano
 * nell'elenco. Misurato dal vivo: aggiunto `estremo` a `impact`, completata la
 * matrice `priority` con le sue celle, e poi tolto `estremo` — **accettato,
 * senza una parola**, lasciando due celle che puntano a un valore che non
 * esiste più.
 */
async function matrixReferences(
  q: Session | ManagedTransaction, tenantId: string, vocabularyName: string, values: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(values.map((v) => [v, []]))
  const kinds = Object.entries(DOMAIN_MATRIX_KINDS).filter(
    ([, spec]) => (spec.inputs as readonly string[]).includes(vocabularyName) || spec.output === vocabularyName,
  )
  if (kinds.length === 0) return out

  const rows = await run(q, `
    MATCH (m:DomainMatrix {tenant_id: $tenantId})
    WHERE m.kind IN $kinds
    RETURN m.kind AS kind, m.entries AS entries
  `, { tenantId, kinds: kinds.map(([k]) => k) })

  for (const row of rows) {
    const kind = String(row.kind)
    const spec = DOMAIN_MATRIX_KINDS[kind as DomainMatrixKind]
    let entries: Record<string, unknown>
    try { entries = JSON.parse(String(row.entries)) as Record<string, unknown> }
    catch { continue }   // una matrice illeggibile è un problema suo: lo dice `loadDomainMatrix`
    for (const [key, value] of Object.entries(entries)) {
      const parts = key.split('|')
      for (const [i, vocabulary] of spec.inputs.entries()) {
        if (vocabulary !== vocabularyName) continue
        const hit = out.get(parts[i] ?? '')
        if (hit && !hit.includes(`${kind} (chiave "${key}")`)) hit.push(`${kind} (chiave "${key}")`)
      }
      if (spec.output === vocabularyName) {
        const hit = out.get(String(value))
        if (hit && !hit.includes(`${kind} (cella "${key}")`)) hit.push(`${kind} (cella "${key}")`)
      }
    }
  }
  return out
}

export interface EnumValueUsage {
  value: string
  /** Record che portano ancora il valore, per tipo. */
  records: { typeName: string; fieldName: string; count: number }[]
  /** Liste della policy del ciclo di vita che citano il valore (`retired_statuses`, …). */
  policyLists: readonly string[]
  /** Matrici di dominio che citano il valore, in una chiave o in una cella. */
  matrices: readonly string[]
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
    values.map((v) => [v, { value: v, records: [], policyLists: [], matrices: [], total: 0 }]),
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
  // E le matrici di dominio, che si rompono esattamente così (D·N-2).
  const inMatrices = await matrixReferences(session, tenantId, vocabularyName, values)
  for (const usage of byValue.values()) {
    usage.matrices = inMatrices.get(usage.value) ?? []
    usage.total += usage.matrices.length
  }
  return [...byValue.values()].filter((u) => u.total > 0)
}

/** Il messaggio del rifiuto: dice cosa usa il valore e come procedere. */
export function enumValueUsageMessage(vocabularyName: string, usages: readonly EnumValueUsage[]): string {
  const parts = usages.map((u) => {
    const where = [
      ...u.records.map((r) => `${String(r.count)} ${r.typeName}.${r.fieldName}`),
      ...u.policyLists.map((l) => `la policy degli allarmi (${l})`),
      ...u.matrices.map((m) => `la matrice ${m}`),
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
  // Il numero restituito resta «quanti RECORD»: la policy e le matrici sono
  // configurazione, non dati, e sommarle darebbe un conteggio che non significa
  // niente in nessuna delle due unità.
  await replaceInPolicy(tx, tenantId, vocabularyName, from, to)
  await replaceInMatrices(tx, tenantId, vocabularyName, from, to)
  return touched
}

/**
 * La policy degli allarmi: le tre liste del ciclo di vita e la mappa delle
 * severità. Sostituzione testuale sul JSON no — si rilegge, si riscrive, si
 * risalva.
 *
 * `severity_map` è la seconda metà (revisione delle otto ondate · C·N-4): la
 * mappa dice, per ogni severità d'allarme, con quale **impatto e urgenza**
 * aprire l'incident, e quei due valori sono del vocabolario del cliente. Chi
 * rinominava `impact` si trovava in un vicolo cieco: l'ingest registrava
 * l'allarme, la pipeline moriva su `createIncident` perché la policy citava il
 * valore vecchio, il job finiva nella coda dei falliti — e la pagina della
 * policy **rifiutava** di salvare il valore nuovo, perché la validazione
 * confrontava con una lista scritta nel codice. Ora la rinomina riscrive anche
 * questa mappa, e la validazione passa dal vocabolario del cliente.
 */
async function replaceInPolicy(
  tx: ManagedTransaction, tenantId: string, vocabularyName: string, from: string, to: string,
): Promise<number> {
  const isLifecycle = vocabularyName === CI_STATUS_VOCABULARY
  const isSeverityMapValue = vocabularyName === 'impact' || vocabularyName === 'urgency'
  if (!isLifecycle && !isSeverityMapValue) return 0

  const r = await run(tx, 'MATCH (t:Tenant {id: $tenantId}) RETURN t.event_policy AS raw', { tenantId })
  const raw = r.length ? r[0]!.raw : null
  if (typeof raw !== 'string' || raw === '') return 0
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return 0 }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 0

  const p = parsed as Record<string, unknown>
  let changed = 0
  if (isLifecycle) {
    for (const key of ['ignore_lifecycle_statuses', 'retired_statuses', 'maintenance_statuses']) {
      const list = p[key]
      if (!Array.isArray(list) || !list.includes(from)) continue
      p[key] = [...new Set(list.map((v) => (v === from ? to : v)))]
      changed += 1
    }
  }
  if (isSeverityMapValue) {
    const map = p['severity_map']
    if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
      for (const entry of Object.values(map as Record<string, unknown>)) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const e = entry as Record<string, unknown>
        if (e[vocabularyName] === from) { e[vocabularyName] = to; changed += 1 }
      }
    }
  }
  if (changed > 0) {
    await runWrite(tx, 'MATCH (t:Tenant {id: $tenantId}) SET t.event_policy = $policy, t.updated_at = $now',
      { tenantId, policy: JSON.stringify(p), now: new Date().toISOString() })
  }
  return changed
}

/**
 * Le matrici di dominio: **chiavi e valori** (revisione · C·N-2 / D·N-2).
 *
 * È il pezzo che rende la rinomina un'operazione vera invece di una mezza.
 * Rinominare `low` → `basso` senza toccare la matrice `priority` lascia nove
 * celle con chiavi `low|…`: `resolveDomainMatrix` non trova più niente e ogni
 * apertura di incident si ferma. Prima l'unico modo era ricompilare la matrice
 * a mano dalla pagina, cella per cella — e l'admin non sapeva di doverlo fare.
 */
async function replaceInMatrices(
  tx: ManagedTransaction, tenantId: string, vocabularyName: string, from: string, to: string,
): Promise<number> {
  const kinds = Object.entries(DOMAIN_MATRIX_KINDS).filter(
    ([, spec]) => (spec.inputs as readonly string[]).includes(vocabularyName) || spec.output === vocabularyName,
  )
  if (kinds.length === 0) return 0

  const rows = await run(tx, `
    MATCH (m:DomainMatrix {tenant_id: $tenantId})
    WHERE m.kind IN $kinds
    RETURN m.kind AS kind, m.entries AS entries
  `, { tenantId, kinds: kinds.map(([k]) => k) })

  let changed = 0
  for (const row of rows) {
    const kind = String(row.kind)
    const spec = DOMAIN_MATRIX_KINDS[kind as DomainMatrixKind]
    let entries: Record<string, unknown>
    try { entries = JSON.parse(String(row.entries)) as Record<string, unknown> }
    catch { continue }

    const next: Record<string, string> = {}
    let touchedHere = 0
    for (const [key, value] of Object.entries(entries)) {
      const parts = key.split('|')
      const newParts = parts.map((part, i) =>
        (spec.inputs[i] === vocabularyName && part === from ? to : part))
      const newValue = spec.output === vocabularyName && String(value) === from ? to : String(value)
      if (newParts.join('|') !== key || newValue !== String(value)) touchedHere += 1
      next[newParts.join('|')] = newValue
    }
    if (touchedHere === 0) continue
    await runWrite(tx, `
      MATCH (m:DomainMatrix {tenant_id: $tenantId, kind: $kind})
      SET m.entries = $entries, m.updated_at = $now
    `, { tenantId, kind, entries: JSON.stringify(next), now: new Date().toISOString() })
    changed += touchedHere
  }
  return changed
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
