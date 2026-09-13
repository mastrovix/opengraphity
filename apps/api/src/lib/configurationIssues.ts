/**
 * Cosa c'è da sistemare nella configurazione di QUESTO cliente, in un posto
 * solo (revisione delle otto ondate · A·#3, D·D4, D·#5, C·#8).
 *
 * ## Il difetto, ed è lo stesso quattro volte
 * Il prodotto **sa** quando la configurazione di un cliente è rotta o
 * incompleta, e lo dice a tutti tranne che a chi può rimediare:
 *
 *  - lo **schema degradato** ha l'intestazione HTTP, la metrica e il log — e
 *    l'amministratore del tenant, l'unico che può correggere il tipo colpevole,
 *    vede solo pagine che dicono «Cannot query field»;
 *  - le **matrici incomplete** sono esposte bene da `domainMatrices`
 *    (`missing`/`stale`/`invalid`), ma bisogna andare nella pagina apposta per
 *    saperlo: il sintomo arriva invece all'apertura di un incident;
 *  - i **buchi di configurazione** (nessun workflow, nessuna matrice) li
 *    conosceva solo `migrate --status`;
 *  - le **liste della policy che citano valori fuori vocabolario** non le
 *    guardava nessuno. La migrazione `1810` scrive `retired_statuses` senza
 *    verificare che quei valori siano nel `ci_status` del cliente: chi aveva
 *    già rinominato `decommissioned` si ritrovava una policy che punta al
 *    nulla, cioè i CI dismessi di nuovo dentro la salute dei servizi — lo
 *    stesso difetto C-4 che l'ondata 7 dichiara chiuso, spostato dal codice al
 *    dato. E i valori AGGIUNTI a `ci_status` senza semantica (dal vivo su
 *    c-one: `expired` e `revoked`, con 68 CI sopra) pesano ancora nella salute
 *    dei servizi, senza che nessuna pagina lo dica.
 *
 * Qui si raccolgono tutti, con la stessa forma, per un banner solo. Un
 * controllo che fallisce non nasconde gli altri: diventa lui stesso una voce.
 *
 * ## E la frase non si compone qui
 * Fino a ieri ogni voce portava un `message` in italiano, scritto da questo
 * file. Ma questo file sta nell'API, e **l'API non sa in che lingua guarda chi
 * legge**: non c'è `Accept-Language`, non c'è `language` sull'utente. Risultato
 * misurato in un browser in inglese: interfaccia inglese, banner della
 * diagnostica in italiano. Ora ogni voce è un DATO — una `kind`, che è la
 * chiave, e i soli `params` da interpolare — e la frase la compone il client,
 * che la lingua la conosce (`configurationIssue.<kind>`).
 */
import type { Session } from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'
import { getSchemaState } from './schemaCache.js'
import { tenantProvisioningGaps, type ProvisioningGap } from './provisionTenantData.js'
import { DOMAIN_MATRIX_KINDS, domainVocabulary, loadDomainMatrix, matrixKey, type DomainMatrixKind } from './domainMatrix.js'
import { CI_STATUS_VOCABULARY } from './eventVocabularies.js'
import { LIFECYCLE_POLICY_LISTS } from './eventPolicy.js'
import { getEventPolicy } from '../services/events/policy.js'
import { logger } from './logger.js'
import { LINGUE, parseValueLabels, vocabularyCarriesLabels } from './enumValueLabels.js'
import { tenantDefaultLanguage, LINGUA_DI_ULTIMA_ISTANZA } from './tenantLanguage.js'
import { teamsWithoutSourcing } from './teamSourcing.js'

const log = logger.child({ module: 'configuration-issues' })

export type ConfigurationIssueKind =
  | 'schema_degraded'
  | 'provisioning_gap'
  | 'matrix_missing_cells'
  | 'matrix_invalid_cells'
  | 'matrix_stale_keys'
  | 'policy_out_of_vocabulary'
  | 'vocabulary_without_semantics'
  | 'check_failed'
  | 'vocabulary_empty'
  | 'value_labels_missing'
  | 'value_labels_partial'
  | 'default_language_not_set'
  | 'teams_without_sourcing'

export interface ConfigurationIssue {
  /** La CHIAVE del problema: il client la risolve nella sua lingua. */
  kind: ConfigurationIssueKind
  /** `error` = qualcosa è già rotto; `warning` = lo sarà, o è silenziosamente sbagliato. */
  severity: 'error' | 'warning'
  /** Solo DATI da interpolare nella chiave: mai prosa. */
  params: Record<string, string>
  /**
   * I buchi di configurazione, ognuno con la SUA chiave — solo per
   * `provisioning_gap`. Un elenco di chiavi e non una frase già cucita: la
   * cuce il client, che sa anche come si separa un elenco nella sua lingua.
   */
  gaps?: ProvisioningGap[]
  /** Dove si rimedia: un percorso dell'interfaccia. */
  where: string | null
}

export async function configurationIssues(tenantId: string): Promise<ConfigurationIssue[]> {
  const out: ConfigurationIssue[] = []
  const session = getSession()
  try {
    for (const check of [checkSchema, checkProvisioning, checkMatrices, checkLifecyclePolicy, checkValueLabels, checkLanguage, checkTeamSourcing]) {
      try {
        out.push(...await check(tenantId, session))
      } catch (err) {
        // Un controllo che non gira non deve nascondere gli altri — né sparire.
        log.error({ err, tenantId, check: check.name }, 'Controllo di configurazione fallito')
        out.push({
          kind: 'check_failed', severity: 'warning', where: null,
          params: { check: check.name, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  } finally {
    await session.close()
  }
  return out
}

async function checkSchema(tenantId: string): Promise<ConfigurationIssue[]> {
  const state = await getSchemaState(tenantId)
  if (!state.degraded) return []
  return [{
    kind: 'schema_degraded', severity: 'error', where: '/settings/ci-types',
    // `reason` puo mancare: e il client a dire «motivo non disponibile», nella
    // sua lingua. Qui non si scrive prosa nemmeno per il ripiego.
    params: state.reason ? { reason: state.reason } : {},
  }]
}

async function checkProvisioning(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const gaps = await tenantProvisioningGaps(session, tenantId)
  if (gaps.length === 0) return []
  return [{
    kind: 'provisioning_gap', severity: 'error', where: '/workflow',
    params: { count: String(gaps.length) },
    gaps,
  }]
}

async function checkMatrices(tenantId: string): Promise<ConfigurationIssue[]> {
  const out: ConfigurationIssue[] = []
  for (const kind of Object.keys(DOMAIN_MATRIX_KINDS) as DomainMatrixKind[]) {
    const spec   = DOMAIN_MATRIX_KINDS[kind]
    const matrix = await loadDomainMatrix(tenantId, kind)
    const inputValues  = await Promise.all(spec.inputs.map((v) => domainVocabulary(tenantId, v)))
    const outputValues = await domainVocabulary(tenantId, spec.output)

    // UN VOCABOLARIO VUOTO non e un problema della matrice (terza revisione · M10).
    // `cartesian([])` e vuoto, quindi `wanted` e vuoto, quindi OGNI chiave
    // esistente risulta «rimasta da una rinomina»: la diagnosi accusava la
    // matrice, mandava l'admin alla sua pagina, e la pagina offre un «Salva»
    // che rimuove le chiavi residue — cioe cancellava una matrice sana. Del
    // problema vero (nessun ticket si apre piu, perche `assertDomainValue`
    // rifiuta ogni valore) non diceva niente. Falso positivo distruttivo e
    // falso negativo nella stessa voce.
    const vuoti: string[] = spec.inputs.filter((_, i) => inputValues[i]!.length === 0)
    if (outputValues.length === 0) vuoti.push(spec.output)
    if (vuoti.length) {
      out.push({
        kind: 'vocabulary_empty',
        severity: 'error',
        where: '/settings/enum-designer',
        // `count` decide il plurale nella lingua del client: «Il vocabolario»
        // contro «I vocabolari» non e una scelta che possa fare l'API.
        params: { count: String(vuoti.length), vocabularies: vuoti.join(', '), matrix: kind },
      })
      // E non si dice niente della matrice: il suo contenuto non e giudicabile
      // finche il vocabolario e vuoto.
      continue
    }

    const wanted  = cartesian(inputValues).map((v) => matrixKey(...v))
    const missing = wanted.filter((k) => matrix.entries[k] === undefined)
    const stale   = Object.keys(matrix.entries).filter((k) => !wanted.includes(k))
    const invalid = Object.entries(matrix.entries).filter(([, v]) => !outputValues.includes(v)).map(([k]) => k)

    /*
      TRE VOCI, non una con tre pezzi.
      Prima era un messaggio solo, cucito qui incollando i pezzi presenti:
      «Matrice «x»: 3 combinazioni senza valore (a, b), 2 chiavi rimaste da una
      rinomina». Una frase cucita a pezzi non si traduce — e teneva insieme tre
      casi che NON hanno la stessa gravita: una cella mancante ferma l'apertura
      di un incident, una chiave rimasta e residuo e non ferma niente, e la
      voce unica prendeva la gravita del peggiore. Separate, ognuna ha la sua
      chiave, il suo plurale e la sua gravita vera.
    */
    if (missing.length) out.push({
      kind: 'matrix_missing_cells', severity: 'error', where: '/settings/domain-matrices',
      params: {
        matrix: kind, count: String(missing.length),
        examples: missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', …' : ''),
      },
    })
    if (invalid.length) out.push({
      kind: 'matrix_invalid_cells', severity: 'error', where: '/settings/domain-matrices',
      params: { matrix: kind, count: String(invalid.length) },
    })
    if (stale.length) out.push({
      kind: 'matrix_stale_keys', severity: 'warning', where: '/settings/domain-matrices',
      params: { matrix: kind, count: String(stale.length) },
    })
  }
  return out
}

/**
 * I valori senza ETICHETTA (ondata 1).
 *
 * La migrazione ha seminato l'italiano per i valori SPEDITI il giorno in cui è
 * stata scritta, e non può sapere niente di quelli aggiunti dopo — né di quelli
 * che il cliente aggiunge da sé. Un valore senza etichetta si legge a schermo
 * col suo nome interno («mission_critical» → «Mission Critical»), che è vero ma
 * non è la lingua del prodotto.
 *
 * È un avviso, non un errore: il prodotto funziona, si legge solo peggio. E
 * salta i vocabolari che di proposito non portano etichette
 * (`VOCABULARIES_WITHOUT_LABELS`), altrimenti si lamenterebbe per sempre dei 28
 * valori di `import_severity` e dei nomi dei passi.
 */
async function checkValueLabels(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const r = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e:EnumTypeDefinition)
       WHERE e.tenant_id IN [$tenantId, 'system']
       RETURN e.name AS name, e.tenant_id AS owner, e.values AS values, e.value_labels AS labels`,
      { tenantId },
    ),
  )
  // Precedenza, la stessa di domainVocabulary: il vocabolario del cliente vince.
  const perNome = new Map<string, { values: string[]; labels: unknown; own: boolean }>()
  for (const rec of r.records) {
    const name = rec.get('name') as string
    const own  = (rec.get('owner') as string) !== 'system'
    if (perNome.has(name) && !own) continue
    const values = rec.get('values')
    perNome.set(name, { values: Array.isArray(values) ? values as string[] : [], labels: rec.get('labels'), own })
  }

  const senza: string[] = []
  const incomplete: string[] = []
  for (const [name, v] of perNome) {
    if (!vocabularyCarriesLabels(name)) continue
    const { labels } = parseValueLabels(v.labels)
    /*
      Da quando le etichette sono PER LINGUA, «senza etichetta» ha due gradi, e
      si segnalano entrambi perche' hanno conseguenze diverse: chi non ne ha
      nessuna si legge col nome interno, chi ne ha una sola si legge in quella
      lingua anche nelle altre (il ripiego passa per l'italiano).
    */
    const nessuna = v.values.filter((val) => labels[val] === undefined)
    const parziali = v.values.filter((val) => {
      const per = labels[val]
      return per !== undefined && LINGUE.some((l) => per[l] === undefined)
    })
    // Nomi di vocabolario e nomi di valore: dati, non frasi. Le virgolette e i
    // due punti sono punteggiatura, e non cambiano da una lingua all'altra.
    if (nessuna.length > 0)  senza.push(`«${name}»: ${nessuna.join(', ')}`)
    if (parziali.length > 0) incomplete.push(`«${name}»: ${parziali.join(', ')}`)
  }
  const out: ConfigurationIssue[] = []
  if (senza.length > 0) {
    out.push({
      kind: 'value_labels_missing',
      severity: 'warning',
      where: '/settings/enum-designer',
      params: { details: senza.join(' · ') },
    })
  }
  if (incomplete.length > 0) {
    out.push({
      kind: 'value_labels_partial',
      severity: 'warning',
      where: '/settings/enum-designer',
      params: { details: incomplete.join(' · '), languages: LINGUE.join(' / ') },
    })
  }
  return out
}

/**
 * LA LINGUA NON CONFIGURATA.
 *
 * La lingua predefinita del cliente era una costante nel codice, e ora è
 * configurazione — il che apre un caso che prima non esisteva: nessuno l'ha
 * scelta. Bisogna pur mostrare qualcosa, e si mostra la prima delle lingue del
 * prodotto; ma mostrarla in silenzio sarebbe il solito ripiego muto, cioè un
 * cliente che si chiede per mesi perché il prodotto gli parla in una lingua che
 * non ha chiesto. È un avviso e non un errore: niente è rotto, si legge solo in
 * una lingua che nessuno ha deciso.
 */
async function checkLanguage(tenantId: string): Promise<ConfigurationIssue[]> {
  if (await tenantDefaultLanguage(tenantId) !== null) return []
  return [{
    kind: 'default_language_not_set', severity: 'warning', where: '/settings/organization',
    params: { fallback: LINGUA_DI_ULTIMA_ISTANZA, available: LINGUE.join(', ') },
  }]
}

/**
 * Team che non dicono se sono interni o esterni.
 *
 * Sono quelli nati prima del campo: la migrazione non lo indovina (un team
 * «Rete» può essere il tuo o quello del fornitore), quindi resta vuoto e si
 * dice qui, con i nomi, finché qualcuno non lo sceglie dalla pagina del team.
 * I team nuovi non possono finire in questa lista: l'API pretende il valore.
 */
async function checkTeamSourcing(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const { count, names } = await teamsWithoutSourcing(session, tenantId)
  if (count === 0) return []
  return [{
    kind: 'teams_without_sourcing', severity: 'warning', where: '/teams',
    params: {
      count: String(count),
      teams: names.join(', '),
      // Quanti nomi NON sono in elenco: la frase lo dice invece di troncare muta.
      others: String(Math.max(0, count - names.length)),
    },
  }]
}

async function checkLifecyclePolicy(tenantId: string): Promise<ConfigurationIssue[]> {
  const out: ConfigurationIssue[] = []
  const policy = await getEventPolicy(tenantId)
  const values = await domainVocabulary(tenantId, CI_STATUS_VOCABULARY)

  // (a) La policy cita valori che il vocabolario non ha (più).
  const fuori = new Map<string, string[]>()
  for (const list of LIFECYCLE_POLICY_LISTS) {
    const orfani = (policy[list] as readonly string[]).filter((v) => !values.includes(v))
    if (orfani.length) fuori.set(list, orfani)
  }
  if (fuori.size) {
    out.push({
      kind: 'policy_out_of_vocabulary', severity: 'error', where: '/settings/event-policy',
      params: { details: [...fuori].map(([l, v]) => `${l} → ${v.join(', ')}`).join('; ') },
    })
  }

  // (b) Valori del vocabolario che NESSUNA lista cita: non hanno semantica, e
  // il caso reale (c-one: `expired`, `revoked`) è passato inosservato per mesi.
  const citati = new Set(LIFECYCLE_POLICY_LISTS.flatMap((l) => policy[l] as readonly string[]))
  const senzaSemantica = values.filter((v) => !citati.has(v))
  // Il primo valore della scala (o il default) è «in servizio» per definizione:
  // non citarlo è la norma, non una dimenticanza.
  const atteso = senzaSemantica.length > 0 && senzaSemantica[0] === values[0] ? senzaSemantica.slice(1) : senzaSemantica
  if (atteso.length) {
    out.push({
      kind: 'vocabulary_without_semantics', severity: 'warning', where: '/settings/event-policy',
      params: { statuses: atteso.join(', '), count: String(atteso.length) },
    })
  }
  return out
}

function cartesian(lists: readonly (readonly string[])[]): string[][] {
  return lists.reduce<string[][]>((acc, list) => acc.flatMap((prefix) => list.map((v) => [...prefix, v])), [[]])
}
