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
  /** L'ambiente dei CI: ingresso della matrice `environment_risk` (revisione del 14 set 2026 · CH-3). */
  environment: [
    { label: 'ConfigurationItem', property: 'environment' },
  ],
  event_severity: [
    { label: 'Event',             property: 'severity' },
    { label: 'Anomaly',           property: 'severity' },
    { label: 'EventHistoryEntry', property: 'severity' },
  ],
  /**
   * Nessun RECORD: la fascia di rischio si deriva dal punteggio a ogni lettura
   * e non si salva sui nodi.
   *
   * Ma non era vero che «i suoi valori vivono solo nelle chiavi della matrice
   * `change_priority`»: lo STESSO commit che scrisse quella frase introdusse
   * `Tenant.risk_band_thresholds`, che è una lista di `{band, upTo}` dove
   * `band` è un valore di questo vocabolario. Una rinomina lasciava le soglie
   * orfane e `parseThresholds` lanciava: nessuna change si creava più.
   * Adesso le soglie sono in `CONFIG_VALUE_SITES`, e
   * `__tests__/enumValuePerimeter.test.ts` pretende che ci restino.
   */
  risk_band: [],
  /** Nessun record: è il vocabolario del file di import, non del prodotto. */
  import_severity: [],
  /**
   * Revisione del 15 set 2026 · CM-7: le categorie della Knowledge Base e il
   * tipo dei team sono validati contro il Dizionario (`assertDomainValue`) ma
   * nessun campo del metamodello li aggancia. Senza queste due righe togliere
   * `network` dalle categorie KB passava contando zero usi con un articolo che
   * lo portava, e una rinomina non riscriveva gli articoli.
   */
  kb_category: [
    { label: 'KBArticle', property: 'category' },
  ],
  team_type: [
    { label: 'Team', property: 'type' },
  ],
}

/**
 * SEDI DI CONFIGURAZIONE che contengono valori di vocabolario (terza revisione · G1).
 *
 * `DOMAIN_VALUE_BINDINGS` sopra copre le PROPRIETA dei nodi ITIL. Non copriva
 * la configurazione, dove i valori vivono dentro un JSON o in proprieta con
 * nomi che non somigliano al vocabolario. Verificato sul grafo vivo: tre
 * `BusinessRule` con `{"field":"severity","value":"critical"}`, un
 * `SLAPolicyNode` con `category: "security"`, un `DynamicCIGroup` con
 * `criteria_environment: "production"`, un `FieldVisibilityRule` con
 * `trigger_field: "category", trigger_value: "hardware"`.
 *
 * Il danno era SILENZIOSO, che e peggio dei critici: rinominando `critical`,
 * la regola «Incident security critico → SecOps» non scattava mai piu perche
 * `evaluateConditions` restituiva `false`. Nessun errore, nessun log.
 */
/**
 * `object_list`: una lista JSON di oggetti dove il campo `listKey` porta il
 * valore (`risk_band_thresholds` → `band`, `portal_severity_options` → `value`).
 */
export type ConfigSiteShape = 'scalar' | 'conditions' | 'object_list' | 'string_list' | 'actions' | 'deadline'

export interface ConfigValueSite {
  label:    string
  property: string
  shape:    ConfigSiteShape
  /** Il vocabolario che governa la proprieta, quando e fisso. */
  vocabulary?: string
  /** Oppure la proprieta che NOMINA il campo, e quindi il vocabolario (FieldVisibilityRule). */
  vocabularyFromField?: string
  /** Per `object_list`: il campo di ogni oggetto che porta il valore. */
  listKey?: string
  /** Come si chiama nel messaggio all'amministratore. */
  where: string
}

export const CONFIG_VALUE_SITES: readonly ConfigValueSite[] = [
  { label: 'BusinessRule',  property: 'conditions', shape: 'conditions', where: 'the conditions of a Business Rule' },
  { label: 'AutoTrigger',   property: 'conditions', shape: 'conditions', where: 'the conditions of an Auto Trigger' },
  // Revisione totale · C-5: il perimetro copriva le sole CONDIZIONI. I valori
  // che le AZIONI scrivono (`set_priority`, `set_field`, `update_field`) e
  // quelli che una scadenza del passo imposta restavano sul nome vecchio: il
  // conteggio diceva «0 usi», la rinomina non riscriveva, e la regola
  // «Incident security → set_priority critical» falliva a ogni esecuzione con
  // un messaggio solo nel log.
  { label: 'BusinessRule',  property: 'actions',       shape: 'actions', where: 'the actions of a Business Rule' },
  { label: 'AutoTrigger',   property: 'actions',       shape: 'actions', where: 'the actions of an Auto Trigger' },
  { label: 'WorkflowStep',  property: 'enter_actions', shape: 'actions', where: 'the entry actions of a workflow step' },
  { label: 'WorkflowStep',  property: 'exit_actions',  shape: 'actions', where: 'the exit actions of a workflow step' },
  { label: 'WorkflowStep',  property: 'deadline',      shape: 'deadline', where: 'the fields set by a step deadline' },
  { label: 'SLAPolicyNode', property: 'category',   shape: 'scalar', vocabulary: 'category',    where: 'the category of an SLA Policy' },
  { label: 'DynamicCIGroup', property: 'criteria_environment', shape: 'scalar', vocabulary: 'environment', where: 'the environment of a dynamic CI group' },
  { label: 'StandardChangeCatalogEntry', property: 'default_priority', shape: 'scalar', vocabulary: 'priority', where: 'the priority of a standard change catalog entry' },
  { label: 'FieldVisibilityRule', property: 'trigger_value', shape: 'scalar', vocabularyFromField: 'trigger_field', where: 'the visibility condition of a field' },
  // Il CRITICO della terza revisione (A · C1): le soglie delle fasce di
  // rischio vivono sul Tenant come `[{band, upTo}]`, dove `band` e un valore
  // del vocabolario `risk_band`. La tabella dichiarava `risk_band: []` con la
  // motivazione «i suoi valori vivono solo nelle chiavi della matrice», che
  // era falsa dal commit che ha introdotto le soglie. Dopo una rinomina,
  // `parseThresholds` lancia e NESSUNA change si crea piu.
  { label: 'Tenant', property: 'risk_band_thresholds', shape: 'object_list', listKey: 'band', vocabulary: 'risk_band', where: 'the risk band thresholds' },
  // Verifica «Cosa resta cablato», ondate 1 e 2: le scelte dell'amministratore
  // che nominano valori del Dizionario. Senza queste righe, rinominare una
  // severità o una priorità avrebbe lasciato il portale con un valore che il
  // servizio rifiuta, o una voce del catalogo da cui non nasce più nessuna richiesta.
  { label: 'Tenant', property: 'portal_severity_options', shape: 'object_list', listKey: 'value', vocabulary: 'severity', where: 'the severities offered in the self-service portal' },
  { label: 'ServiceCatalogItem', property: 'priority', shape: 'scalar', vocabulary: 'priority', where: 'the priority of a service catalog item' },
  { label: 'ServiceCatalogItem', property: 'category', shape: 'scalar', vocabulary: 'category', where: 'the category of a service catalog item' },
  // CM-7 (revisione del 15 set 2026): i tipi di change pre-approvati sono una
  // lista di valori di `change_type`. Rinominare `standard` lasciava la lista
  // sul nome vecchio, e quelle change tornavano a chiedere l'approvazione
  // completa — il difetto che l'ondata 8 aveva chiuso.
  { label: 'Tenant', property: 'pre_approved_change_types', shape: 'string_list', vocabulary: 'change_type', where: 'the pre-approved change types' },
]

/**
 * Quale vocabolario governa il `field` di una condizione. `status` dipende
 * dall'entita della regola (`status_incident`, `status_change`, …), quindi si
 * compone col suo `entity_type`.
 */
export const CONDITION_FIELD_VOCABULARY: Readonly<Record<string, string>> = {
  severity: 'severity', priority: 'priority', impact: 'impact', urgency: 'urgency',
  category: 'category', type: 'change_type', change_type: 'change_type',
  environment: 'environment', criticality: 'service_criticality',
}

/** Il vocabolario di un campo di condizione, dato il tipo di entita della regola. */
export function conditionFieldVocabulary(field: string, entityType: string | null): string | null {
  if (field === 'status') return entityType ? `status_${entityType}` : null
  return CONDITION_FIELD_VOCABULARY[field] ?? null
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
    const label    = assertLabel(b.label, `vocabulary "${vocabularyName}": declared label`)
    const property = assertFieldName(b.property, `vocabulary "${vocabularyName}": declared property`)
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
        if (hit && !hit.includes(`${kind} (key "${key}")`)) hit.push(`${kind} (key "${key}")`)
      }
      if (spec.output === vocabularyName) {
        const hit = out.get(String(value))
        if (hit && !hit.includes(`${kind} (cell "${key}")`)) hit.push(`${kind} (cell "${key}")`)
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
  /**
   * Sedi di CONFIGURAZIONE che citano il valore (terza revisione · G1): le
   * condizioni delle regole e dei trigger, la categoria di una policy SLA,
   * l'ambiente di un gruppo dinamico, le soglie delle fasce di rischio. Erano
   * fuori dal perimetro: il conteggio diceva zero, quindi togliere il valore
   * passava in silenzio e la regola non scattava piu, senza un errore.
   */
  configSites: readonly string[]
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
    values.map((v) => [v, { value: v, records: [], policyLists: [], matrices: [], configSites: [], total: 0 }]),
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
  // E la CONFIGURAZIONE (terza revisione · G1): regole, trigger, policy SLA,
  // gruppi dinamici, soglie delle fasce. Erano fuori dal perimetro.
  const inConfig = await configReferences(session, tenantId, vocabularyName, values)
  for (const usage of byValue.values()) {
    usage.configSites = inConfig.get(usage.value) ?? []
    usage.total += usage.configSites.length
  }
  return [...byValue.values()].filter((u) => u.total > 0)
}

/** Il messaggio del rifiuto: dice cosa usa il valore e come procedere. */
export function enumValueUsageMessage(vocabularyName: string, usages: readonly EnumValueUsage[]): string {
  const parts = usages.map((u) => {
    const where = [
      ...u.records.map((r) => `${String(r.count)} ${r.typeName}.${r.fieldName}`),
      ...u.policyLists.map((l) => `the alarm policy (${l})`),
      ...u.matrices.map((m) => `the ${m} matrix`),
      ...u.configSites,
    ]
    return `"${u.value}" is still used by ${where.join(', ')}`
  })
  return (
    `The dictionary "${vocabularyName}" cannot lose these values: ${parts.join('; ')}. ` +
    `Change those records first, or give a replacement value ` +
    `(replacements: [{from: "…", to: "…"}]) and they are rewritten together with the dictionary.`
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
  await replaceInConfig(tx, tenantId, vocabularyName, from, to)
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
/**
 * Le SEDI DI CONFIGURAZIONE che citano ciascuno dei `values` (terza revisione · G1).
 *
 * Si legge e si interpreta in JS invece di filtrare in Cypher, perche in tre
 * casi su quattro il valore sta dentro un JSON e il vocabolario che lo governa
 * dipende da un ALTRO campo dello stesso nodo (`trigger_field`, `entity_type`).
 * Un filtro in Cypher lo direbbe a meta.
 */
async function configReferences(
  q: Session | ManagedTransaction, tenantId: string, vocabularyName: string, values: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const add = (value: string, where: string): void => {
    const list = out.get(value) ?? []
    if (!list.includes(where)) list.push(where)
    out.set(value, list)
  }
  const wanted = new Set(values)

  for (const site of CONFIG_VALUE_SITES) {
    // Il Tenant non porta `tenant_id`: si identifica per `id`, come in TUTTO
    // il resto del codice (revisione totale · C-25). Qui era `slug`, che è
    // scritto solo ON CREATE: un tenant nato prima di quella proprietà non
    // veniva trovato, quindi la rinomina di una fascia di rischio o di un
    // tipo di change non riscriveva le soglie e la creazione delle change si
    // fermava — il critico della terza revisione, di nuovo.
    const match = site.label === 'Tenant'
      ? 'MATCH (n:Tenant {id: $tenantId})'
      : `MATCH (n:${site.label} {tenant_id: $tenantId})`

    if (site.shape === 'scalar') {
      if (site.vocabulary != null && site.vocabulary !== vocabularyName) continue
      const rows = await run(q, `
        ${match}
        WHERE n.${site.property} IS NOT NULL
        RETURN n.${site.property} AS value, n.${site.vocabularyFromField ?? site.property} AS field, n.name AS name
      `, { tenantId })
      for (const row of rows) {
        const value = String(row['value'])
        if (!wanted.has(value)) continue
        // Sede il cui vocabolario e nominato da un altro campo: si tiene solo
        // se quel campo nomina proprio il vocabolario in questione.
        if (site.vocabularyFromField != null && String(row['field']) !== vocabularyName) continue
        add(value, `${site.where}${row['name'] != null ? ` «${String(row['name'])}»` : ''}`)
      }
      continue
    }

    if (site.shape === 'conditions') {
      const rows = await run(q, `
        ${match}
        WHERE n.${site.property} IS NOT NULL
        RETURN n.${site.property} AS raw, n.entity_type AS entityType, n.name AS name
      `, { tenantId })
      for (const row of rows) {
        for (const c of parseConditionList(row['raw'])) {
          if (conditionFieldVocabulary(c.field, row['entityType'] == null ? null : String(row['entityType'])) !== vocabularyName) continue
          if (!wanted.has(c.value)) continue
          add(c.value, `${site.where}${row['name'] != null ? ` «${String(row['name'])}»` : ''}`)
        }
      }
      continue
    }

    if (site.shape === 'actions' || site.shape === 'deadline') {
      const rows = await run(q, `
        ${match}
        WHERE n.${site.property} IS NOT NULL
        RETURN n.${site.property} AS raw, n.entity_type AS entityType, n.name AS name, n.definition_id AS definitionId
      `, { tenantId })
      for (const row of rows) {
        const writes = site.shape === 'actions' ? parseActionWrites(row['raw']) : parseDeadlineWrites(row['raw'])
        for (const w of writes) {
          if (fieldVocabulary(w.field) !== vocabularyName) continue
          if (!wanted.has(w.value)) continue
          add(w.value, `${site.where}${row['name'] != null ? ` «${String(row['name'])}»` : ''}`)
        }
      }
      continue
    }

    if (site.vocabulary !== vocabularyName) continue
    if (site.shape === 'string_list') {
      const rows = await run(q, `${match} RETURN n.${site.property} AS raw`, { tenantId })
      for (const row of rows) {
        for (const value of parseStringList(row['raw'])) if (wanted.has(value)) add(value, site.where)
      }
      continue
    }
    // `object_list`: [{<listKey>: valore, …}] (le soglie delle fasce, le severità del portale).
    const rows = await run(q, `${match} RETURN n.${site.property} AS raw`, { tenantId })
    for (const row of rows) {
      for (const item of parseObjectList(row['raw'], site.listKey!)) {
        const value = item[site.listKey!] as string
        if (wanted.has(value)) add(value, site.where)
      }
    }
  }
  return out
}

/** Riscrive `from` → `to` nelle sedi di configurazione, nella transazione del chiamante. */
async function replaceInConfig(
  tx: ManagedTransaction, tenantId: string, vocabularyName: string, from: string, to: string,
): Promise<void> {
  for (const site of CONFIG_VALUE_SITES) {
    // C-25: `id`, non `slug` (vedi `configReferences`).
    const match = site.label === 'Tenant'
      ? 'MATCH (n:Tenant {id: $tenantId})'
      : `MATCH (n:${site.label} {tenant_id: $tenantId})`

    if (site.shape === 'scalar') {
      if (site.vocabulary != null && site.vocabulary !== vocabularyName) continue
      if (site.vocabularyFromField != null) {
        await runWrite(tx, `
          ${match}
          WHERE n.${site.property} = $from AND n.${site.vocabularyFromField} = $vocabulary
          SET n.${site.property} = $to
          RETURN count(*) AS n
        `, { tenantId, from, to, vocabulary: vocabularyName })
      } else {
        await runWrite(tx, `
          ${match}
          WHERE n.${site.property} = $from
          SET n.${site.property} = $to
          RETURN count(*) AS n
        `, { tenantId, from, to })
      }
      continue
    }

    if (site.shape === 'conditions') {
      // JSON: si rilegge, si riscrive, si risalva — mai sostituzione testuale,
      // che prenderebbe anche un nome di campo o una sottostringa.
      const rows = await runWrite(tx, `
        ${match}
        WHERE n.${site.property} IS NOT NULL
        RETURN n.id AS id, n.${site.property} AS raw, n.entity_type AS entityType
      `, { tenantId })
      for (const row of rows) {
        const list = parseConditionList(row['raw'])
        if (list.length === 0) continue
        let changed = false
        const next = list.map((c) => {
          const vocab = conditionFieldVocabulary(c.field, row['entityType'] == null ? null : String(row['entityType']))
          if (vocab !== vocabularyName || c.value !== from) return c.raw
          changed = true
          return { ...c.raw, value: to }
        })
        if (!changed) continue
        await runWrite(tx, `
          MATCH (n:${site.label} {id: $id, tenant_id: $tenantId})
          SET n.${site.property} = $raw
          RETURN count(*) AS n
        `, { tenantId, id: String(row['id']), raw: JSON.stringify(next) })
      }
      continue
    }

    if (site.shape === 'actions' || site.shape === 'deadline') {
      // JSON: si rilegge, si riscrive, si risalva. I nodi `WorkflowStep` non
      // hanno `tenant_id` sulla stessa forma degli altri? Ce l'hanno, e si
      // riscrivono per id come le condizioni (C-5).
      const rows = await runWrite(tx, `
        ${match}
        WHERE n.${site.property} IS NOT NULL
        RETURN n.id AS id, n.${site.property} AS raw
      `, { tenantId })
      for (const row of rows) {
        const next = site.shape === 'actions'
          ? rewriteActionWrites(row['raw'], vocabularyName, from, to)
          : rewriteDeadlineWrites(row['raw'], vocabularyName, from, to)
        if (next == null) continue
        await runWrite(tx, `
          MATCH (n:${site.label} {id: $id, tenant_id: $tenantId})
          SET n.${site.property} = $raw
          RETURN count(*) AS n
        `, { tenantId, id: row['id'], raw: next })
      }
      continue
    }

    if (site.vocabulary !== vocabularyName) continue
    if (site.shape === 'string_list') {
      const rows = await runWrite(tx, `${match} RETURN n.${site.property} AS raw`, { tenantId })
      for (const row of rows) {
        const list = parseStringList(row['raw'])
        if (!list.includes(from)) continue
        const next = [...new Set(list.map((v) => (v === from ? to : v)))]
        await runWrite(tx, `
          ${match}
          SET n.${site.property} = $list
          RETURN count(*) AS n
        `, { tenantId, list: next })
      }
      continue
    }
    const rows = await runWrite(tx, `${match} RETURN n.${site.property} AS raw`, { tenantId })
    for (const row of rows) {
      const key = site.listKey!
      const parsed = parseObjectList(row['raw'], key)
      if (!parsed.some((b) => b[key] === from)) continue
      const next = parsed.map((b) => (b[key] === from ? { ...b, [key]: to } : b))
      await runWrite(tx, `
        ${match}
        SET n.${site.property} = $raw
        RETURN count(*) AS n
      `, { tenantId, raw: JSON.stringify(next) })
    }
  }
}

interface ParsedCondition { field: string; value: string; raw: Record<string, unknown> }

/** Le condizioni di una regola, saltando quelle che non hanno la forma attesa. */
/**
 * I VALORI DI VOCABOLARIO CHE UN'AZIONE SCRIVE (revisione totale · C-5).
 *
 * `set_priority` scrive la priorità, `set_field`/`update_field` scrivono il
 * campo che nominano. Un valore con un segnaposto (`{category}`) si risolve a
 * runtime e non è un valore di vocabolario: si salta.
 */
interface FieldWrite { field: string; value: string }

function parseActionWrites(raw: unknown): FieldWrite[] {
  if (raw == null) return []
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out: FieldWrite[] = []
  for (const item of parsed) {
    const w = actionWriteOf(item)
    if (w) out.push(w)
  }
  return out
}

/** Il campo e il valore scritti da una singola azione, se ne scrive uno. */
function actionWriteOf(item: unknown): FieldWrite | null {
  if (item == null || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  const params = o['params']
  if (params == null || typeof params !== 'object') return null
  const p = params as Record<string, unknown>
  if (o['type'] === 'set_priority') {
    const value = p['priority'] ?? p['value']
    return typeof value === 'string' && value && !isPlaceholder(value) ? { field: 'priority', value } : null
  }
  if (o['type'] === 'set_field' || o['type'] === 'update_field') {
    const field = p['field']
    const value = p['value']
    if (typeof field !== 'string' || !field) return null
    return typeof value === 'string' && value && !isPlaceholder(value) ? { field, value } : null
  }
  return null
}

/** I campi impostati da una scadenza del passo: `{after, unit, to_step, set_fields: [{field, value}]}`. */
function parseDeadlineWrites(raw: unknown): FieldWrite[] {
  if (raw == null) return []
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
  if (parsed == null || typeof parsed !== 'object') return []
  const fields = (parsed as Record<string, unknown>)['set_fields']
  if (!Array.isArray(fields)) return []
  const out: FieldWrite[] = []
  for (const f of fields) {
    if (f == null || typeof f !== 'object') continue
    const o = f as Record<string, unknown>
    if (typeof o['field'] === 'string' && typeof o['value'] === 'string' && o['value'] && !isPlaceholder(o['value'])) {
      out.push({ field: o['field'], value: o['value'] })
    }
  }
  return out
}

function isPlaceholder(value: string): boolean {
  return /\{[A-Za-z_][\w.]*\}/.test(value)
}

/**
 * Il vocabolario che governa un campo scritto da un'azione. `status` non entra:
 * i nomi dei passi non sono valori di vocabolario (li valida
 * `assertStepTargets`).
 */
function fieldVocabulary(field: string): string | null {
  if (field === 'status') return null
  if (field === 'severity') return 'severity'
  return CONDITION_FIELD_VOCABULARY[field] ?? null
}

/** La lista di azioni riscritta, o null se non c'era niente da cambiare. */
function rewriteActionWrites(raw: unknown, vocabularyName: string, from: string, to: string): string | null {
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
  if (!Array.isArray(parsed)) return null
  let changed = false
  const next = parsed.map((item) => {
    const w = actionWriteOf(item)
    if (!w || w.value !== from || fieldVocabulary(w.field) !== vocabularyName) return item
    changed = true
    const o = item as Record<string, unknown>
    const p = { ...(o['params'] as Record<string, unknown>) }
    if (o['type'] === 'set_priority') {
      if (typeof p['priority'] === 'string') p['priority'] = to
      if (typeof p['value'] === 'string') p['value'] = to
    } else {
      p['value'] = to
    }
    return { ...o, params: p }
  })
  return changed ? JSON.stringify(next) : null
}

/** La scadenza riscritta, o null se non c'era niente da cambiare. */
function rewriteDeadlineWrites(raw: unknown, vocabularyName: string, from: string, to: string): string | null {
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
  if (parsed == null || typeof parsed !== 'object') return null
  const o = { ...(parsed as Record<string, unknown>) }
  const fields = o['set_fields']
  if (!Array.isArray(fields)) return null
  let changed = false
  o['set_fields'] = fields.map((f) => {
    if (f == null || typeof f !== 'object') return f
    const ff = f as Record<string, unknown>
    if (typeof ff['field'] !== 'string' || ff['value'] !== from) return f
    if (fieldVocabulary(ff['field']) !== vocabularyName) return f
    changed = true
    return { ...ff, value: to }
  })
  return changed ? JSON.stringify(o) : null
}

function parseConditionList(raw: unknown): ParsedCondition[] {
  if (raw == null) return []
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out: ParsedCondition[] = []
  for (const item of parsed) {
    if (item == null || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const field = o['field']
    const value = o['value']
    // Solo i confronti con un valore di testo: un `value` numerico o una lista
    // non e un valore di vocabolario.
    if (typeof field !== 'string' || typeof value !== 'string') continue
    out.push({ field, value, raw: o })
  }
  return out
}

/** Una lista di stringhe (proprietà lista di Neo4j), saltando ciò che non è una stringa. */
function parseStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

/** Una lista JSON di oggetti con il valore in `key`, saltando le voci che non hanno la forma attesa. */
function parseObjectList(raw: unknown, key: string): Record<string, unknown>[] {
  if (raw == null) return []
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((b): b is Record<string, unknown> =>
    b != null && typeof b === 'object' && typeof (b as Record<string, unknown>)[key] === 'string')
}

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
