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
import { slackChannelsWithoutWorkspace } from './slackChannelsWithoutWorkspace.js'
import { serviceMapsWithIncidentProblem } from './serviceIncidentProblems.js'
import type { Session } from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'
import { getScriptingPlan } from './scriptingPlan.js'
import { formFieldsWithFormula } from './catalogForm.js'
import { PORTAL_SEVERITY_VOCABULARY, portalSeverityOptions } from './portalSeverityOptions.js'
import { catalogItemsWithLegacyCategory, catalogItemsWithoutPriority } from './catalogItemPriority.js'
import { tenantInAppRetentionDays } from './tenantInAppRetention.js'
import { getSchemaState } from './schemaCache.js'
import { tenantProvisioningGaps, type ProvisioningGap } from './provisionTenantData.js'
import { DOMAIN_MATRIX_KINDS, domainVocabulary, loadDomainMatrix, matrixInputValues, matrixKey, matrixOutputValues, type DomainMatrixKind } from './domainMatrix.js'
import { CI_STATUS_VOCABULARY } from './eventVocabularies.js'
import { LIFECYCLE_POLICY_LISTS } from './eventPolicy.js'
import { getEventPolicy } from '../services/events/policy.js'
import { logger } from './logger.js'
import { LINGUE, parseValueLabels, vocabularyCarriesLabels } from './enumValueLabels.js'
import { tenantDefaultLanguage, LINGUA_DI_ULTIMA_ISTANZA } from './tenantLanguage.js'
import { tenantTimezone } from './tenantTimezone.js'
import { businessHoursWithoutCalendar } from './serviceCalendars.js'
import { pendingMigrations } from './migrationState.js'
import { teamsWithoutSourcing } from './teamSourcing.js'
import { ticketsWithoutSla } from './ticketsWithoutSla.js'
import { workflowsMissingStepRoles } from './workflowStepRoles.js'
import { vocabulariesBehindShipped } from './vocabularyShippedDrift.js'
import { slaPoliciesWarningNotBeforeDeadline } from './slaWarningCheck.js'
import { blockedStepDeadlines } from './stepDeadlineBlocked.js'
import { customFieldDefs } from './ticketCustomFields.js'
import { stepsNamedBy, workflowStepsByDefinition } from './customFieldSteps.js'
import { olaContractsMeasurability } from './olaMeasurability.js'
import { TICKET_CUSTOM_FIELD_ENTITY_TYPES } from '@opengraphity/types'
import { createMetamodelCache } from './metamodelCache.js'

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
  | 'timezone_not_set'
  | 'service_calendar_not_set'
  | 'portal_severities_not_set'
  | 'portal_severities_stale'
  | 'catalog_items_without_priority'
  | 'inapp_retention_not_set'
  | 'catalog_items_legacy_category'
  | 'migrations_pending'
  | 'teams_without_sourcing'
  | 'tickets_without_sla'
  | 'workflow_step_categories_missing'
  | 'workflow_step_purposes_missing'
  | 'workflow_optional_step_categories_missing'
  | 'workflow_optional_step_purposes_missing'
  | 'vocabulary_behind_shipped'
  | 'sla_warning_not_before_deadline'
  | 'step_deadlines_blocked'
  | 'slack_not_connected'
  | 'service_incident_problem'
  | 'custom_field_steps_missing'
  | 'custom_field_from_step_absent'
  | 'ola_contract_without_team'
  | 'ola_contract_unmeasurable'
  | 'formulas_with_scripting_off'

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

/**
 * I RILIEVI in cache per un minuto (revisione totale · C-33).
 *
 * I ventitré controlli girano in serie e alcuni sono scansioni vere — tutti i
 * ticket aperti, i conteggi per tipo per ogni contratto OLA — e il banner
 * della diagnostica li chiedeva a OGNI apertura di pagina. Su un cliente con
 * centomila ticket erano decine di query pesanti per un banner che cambia una
 * volta al giorno. Un minuto è abbastanza per non farne due nella stessa
 * navigazione e poco per non nascondere un rimedio appena fatto; la cache
 * passa dal canale del metamodello, quindi una modifica alla configurazione
 * la svuota subito.
 */
const CONFIGURATION_ISSUES_TTL_MS = 60_000

const issuesCache = createMetamodelCache<ConfigurationIssue[]>({
  name:  'configuration-issues',
  ttlMs: CONFIGURATION_ISSUES_TTL_MS,
  load:  (tenantId) => computeConfigurationIssues(tenantId),
})

export function invalidateConfigurationIssues(tenantId?: string): void {
  if (tenantId) issuesCache.invalidate(tenantId)
  else issuesCache.clear()
}

export async function configurationIssues(tenantId: string): Promise<ConfigurationIssue[]> {
  return issuesCache.get(tenantId)
}

async function computeConfigurationIssues(tenantId: string): Promise<ConfigurationIssue[]> {
  const out: ConfigurationIssue[] = []
  const session = getSession()
  try {
    for (const check of [checkSchema, checkProvisioning, checkMatrices, checkLifecyclePolicy, checkValueLabels, checkMigrations, checkLanguage, checkTimezone, checkServiceCalendar, checkPortalSeverities, checkCatalogItemPriorities, checkCatalogItemCategories, checkInAppRetention, checkTeamSourcing, checkTicketsWithoutSla, checkWorkflowStepRoles, checkVocabulariesBehindShipped, checkSlaWarnings, checkStepDeadlines, checkSlackChannels, checkServiceIncidentProblems, checkCustomFieldSteps, checkOLAContracts, checkFormulasScripting]) {
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
    const inputValues  = await matrixInputValues(tenantId, kind)
    const outputValues = await matrixOutputValues(tenantId, kind)

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
 * IL FUSO NON CONFIGURATO (revisione del 14 set 2026 · F7).
 *
 * È un errore e non un avviso: senza fuso le scadenze SLA/OLA, il digest e le
 * date dei messaggi falliscono, e nessun ripiego è giusto (il fuso del server
 * non è quello del cliente). Si sceglie dalla pagina Organizzazione.
 */
async function checkTimezone(tenantId: string): Promise<ConfigurationIssue[]> {
  if (await tenantTimezone(tenantId) !== null) return []
  return [{ kind: 'timezone_not_set', severity: 'error', where: '/settings/organization', params: {} }]
}

/** Le policy SLA con il preavviso non prima della scadenza: vedi lib/slaWarningCheck.ts. */
async function checkSlaWarnings(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const bad = await slaPoliciesWarningNotBeforeDeadline(session, tenantId)
  if (bad.length === 0) return []
  return [{
    kind: 'sla_warning_not_before_deadline', severity: 'error', where: '/admin/sla-policies',
    params: { count: String(bad.length), details: bad.map((b) => `«${b.name}»: ${b.warningMinutes} / ${b.resolveMinutes} min`).join(' · ') },
  }]
}

/**
 * LE COPIE DEI VOCABOLARI RIMASTE INDIETRO (revisione del 14 set 2026 · F20).
 *
 * Il prodotto ha aggiunto valori a un vocabolario spedito che il cliente ha
 * personalizzato, e la copia — che per scelta non si sovrascrive — non li ha.
 * Avviso: niente è rotto, ma il cliente non vede quello che il prodotto ha
 * aggiunto. Si decide dal Dizionario: adottarli, o tenerli fuori.
 */
async function checkVocabulariesBehindShipped(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const behind = await vocabulariesBehindShipped(session, tenantId)
  if (behind.length === 0) return []
  return [{
    kind: 'vocabulary_behind_shipped', severity: 'warning', where: '/settings/enum-designer',
    params: { count: String(behind.length), details: behind.map((b) => `«${b.name}»: ${b.newValues.join(', ')}`).join(' · ') },
  }]
}

/**
 * I RUOLI DEI PASSI CHE MANCANO (revisione del 14 set 2026 · F17).
 *
 * Il codice cerca i passi per categoria e per scopo, non per nome
 * (`lib/workflowStepRoles.ts`). Un workflow a cui manca un ruolo OBBLIGATORIO fa
 * fermare un'operazione (errore); uno a cui manca un ruolo FACOLTATIVO spegne
 * un comportamento senza dirlo (avviso). Una voce per workflow, gravità e tipo di ruolo;
 * i valori mancanti sono dati, la frase la compone il client.
 */
async function checkWorkflowStepRoles(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const out: ConfigurationIssue[] = []
  for (const m of await workflowsMissingStepRoles(session, tenantId)) {
    for (const [values, kind, severity] of [
      [m.required.categories, 'workflow_step_categories_missing', 'error'],
      [m.required.purposes, 'workflow_step_purposes_missing', 'error'],
      [m.optional.categories, 'workflow_optional_step_categories_missing', 'warning'],
      [m.optional.purposes, 'workflow_optional_step_purposes_missing', 'warning'],
    ] as const) {
      if (values.length === 0) continue
      out.push({ kind, severity, where: '/workflow', params: { workflow: m.workflow, entityType: m.entityType, missing: values.join(', ') } })
    }
  }
  return out
}

/**
 * CAMPI CHE CITANO FASI CHE IL WORKFLOW NON HA PIÙ (secondo giro UI del 15 set
 * 2026). Le regole di fase si validano quando si salva il campo, ma una fase si
 * può togliere o rinominare dopo, nel disegnatore: allora il campo «da quella
 * fase in poi» non si vede più da nessuna parte. Lo si dice qui invece di
 * lasciarlo sparire.
 */
async function checkCustomFieldSteps(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const missing: string[] = []
  const absent: string[] = []
  for (const entityType of TICKET_CUSTOM_FIELD_ENTITY_TYPES) {
    const defs = (await customFieldDefs(session, tenantId, entityType)).filter((d) => d.visibility.mode !== 'always' || d.editability.mode !== 'visible')
    if (defs.length === 0) continue
    const workflows = await workflowStepsByDefinition(session, tenantId, entityType)
    const names = new Set(workflows.flatMap((w) => w.steps.map((s) => s.name)))
    for (const d of defs) {
      const gone = stepsNamedBy(d.visibility, d.editability).filter((s) => !names.has(s))
      if (gone.length > 0) missing.push(`${d.label} (${entityType}): ${gone.join(', ')}`)
      // «Da X in poi» su un tipo con più workflow: dove X non c'è, il campo non si vede mai.
      const from = d.visibility.mode === 'from' ? d.visibility.step : null
      if (from && names.has(from)) {
        const without = workflows.filter((w) => !w.steps.some((s) => s.name === from)).map((w) => w.workflow)
        if (without.length > 0) absent.push(`${d.label} (${entityType}, ${from}): ${without.join(', ')}`)
      }
    }
  }
  const out: ConfigurationIssue[] = []
  if (missing.length > 0) out.push({ kind: 'custom_field_steps_missing', severity: 'warning', where: '/settings/itil-designer', params: { count: String(missing.length), fields: missing.join('; ') } })
  if (absent.length > 0) out.push({ kind: 'custom_field_from_step_absent', severity: 'warning', where: '/settings/itil-designer', params: { count: String(absent.length), fields: absent.join('; ') } })
  return out
}

/**
 * I CONTRATTI OLA/UC CHE NON MISURANO NIENTE (secondo giro UI del 15 set 2026,
 * punto 3): senza team non avvisano mai; su ticket che nessuno assegna a un
 * team restano a zero. Si rimedia nel contratto (team, tipo di ticket).
 */
async function checkOLAContracts(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const { withoutTeam, unmeasurable } = await olaContractsMeasurability(session, tenantId)
  const out: ConfigurationIssue[] = []
  if (withoutTeam.length > 0) out.push({ kind: 'ola_contract_without_team', severity: 'warning', where: '/admin/ola-uc', params: { count: String(withoutTeam.length), names: withoutTeam.join(', ') } })
  if (unmeasurable.length > 0) out.push({ kind: 'ola_contract_unmeasurable', severity: 'warning', where: '/admin/ola-uc', params: { count: String(unmeasurable.length), names: unmeasurable.join(', ') } })
  return out
}

/**
 * LE MIGRAZIONI PENDENTI (revisione del 14 set 2026 · F8). Non riguardano un
 * cliente ma tutti: l'admin le vede perché il sintomo — dati e schema non
 * allineati — lo vede lui per primo. Si rimedia lanciando `migrate.js`.
 */
async function checkMigrations(_tenantId: string): Promise<ConfigurationIssue[]> {
  const pending = await pendingMigrations()
  if (pending.length === 0) return []
  return [{ kind: 'migrations_pending', severity: 'error', where: null, params: { count: String(pending.length), migrations: pending.join(', ') } }]
}

/**
 * CAMPI CALCOLATI CON GLI SCRIPT SPENTI (moduli del catalogo, ondata 6).
 *
 * Una formula è uno script: con l'interruttore spento non gira, e la richiesta
 * NON si crea — il rifiuto dice perché, ma arriva a chi sta compilando, che non
 * può rimediare. Qui lo si dice a chi può: l'amministratore, nel posto dove
 * guarda già.
 *
 * `error` e non `warning`: non è «sarà un problema», è già rotto — quei moduli
 * non si possono compilare.
 */
async function checkFormulasScripting(tenantId: string): Promise<ConfigurationIssue[]> {
  const { enabled } = await getScriptingPlan(tenantId)
  if (enabled) return []
  const names = await formFieldsWithFormula(tenantId)
  if (names.length === 0) return []
  return [{
    kind: 'formulas_with_scripting_off', severity: 'error', where: '/settings/organization',
    params: { count: String(names.length), names: names.join(', ') },
  }]
}

/**
 * ORARIO DI SERVIZIO SENZA CALENDARIO (revisione del 14 set 2026 · F6, ondata 2
 * della verifica «Cosa resta cablato»).
 *
 * Una policy SLA o un contratto OLA/UC che conta l'orario di servizio senza un
 * calendario valido (nessuno scelto, o uno eliminato) non sa calcolare la
 * scadenza, e il motore lo dice al primo ticket. Qui lo si dice prima, con i nomi.
 */
async function checkServiceCalendar(tenantId: string): Promise<ConfigurationIssue[]> {
  const names = await businessHoursWithoutCalendar(tenantId)
  if (names.length === 0) return []
  return [{ kind: 'service_calendar_not_set', severity: 'error', where: '/admin/sla-policies', params: { count: String(names.length), names: names.join(', ') } }]
}

/**
 * LE SEVERITÀ DEL PORTALE (verifica «Cosa resta cablato», ondata 1). Non
 * dichiarate, o con un valore che il Dizionario non ha più: dal portale non si
 * apre nessun ticket, ed è un errore — gli utenti finali lo scoprono per primi.
 */
async function checkPortalSeverities(tenantId: string): Promise<ConfigurationIssue[]> {
  const options = await portalSeverityOptions(tenantId)
  if (options === null || options.length === 0) {
    return [{ kind: 'portal_severities_not_set', severity: 'error', where: '/settings/organization', params: {} }]
  }
  const vocabulary = await domainVocabulary(tenantId, PORTAL_SEVERITY_VOCABULARY)
  const stale = options.filter((o) => !vocabulary.includes(o.value)).map((o) => o.value)
  if (stale.length === 0) return []
  return [{ kind: 'portal_severities_stale', severity: 'error', where: '/settings/organization', params: { values: stale.join(', ') } }]
}

/**
 * VOCI DEL CATALOGO CON LA CATEGORIA SCRITTA A MANO (ondata 2): la conversione
 * al Dizionario non ha trovato un valore corrispondente. Avviso: le richieste
 * nascono senza categoria e le policy SLA per categoria non le vedono.
 */
async function checkCatalogItemCategories(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const items = await catalogItemsWithLegacyCategory(session, tenantId)
  if (items.length === 0) return []
  return [{ kind: 'catalog_items_legacy_category', severity: 'warning', where: '/admin/service-catalog', params: { count: String(items.length), items: items.map((i) => `${i.name} («${i.legacy}»)`).join(', ') } }]
}

/**
 * CANALI SLACK SENZA SLACK COLLEGATO (ondata 8): un canale che scrive con il bot
 * (`channel_id`, non un webhook) usa il token del workspace dell'organizzazione.
 * Senza workspace collegato ogni notifica verso quel canale fallisce.
 */
async function checkSlackChannels(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const names = await slackChannelsWithoutWorkspace(session, tenantId)
  if (names.length === 0) return []
  return [{ kind: 'slack_not_connected', severity: 'error', where: '/admin/integrations', params: { count: String(names.length), channels: names.join(', ') } }]
}

/**
 * SERVIZI IL CUI INCIDENT NON SI RIESCE A GESTIRE (revisione del 15 set 2026 ·
 * SV-4): il motore scrive sulla mappa perché l'ultima riconciliazione è
 * fallita (tipicamente un tipo di CI escluso dagli incident) e lo toglie alla
 * prima che riesce. Prima si leggeva solo nel log del worker, mentre il
 * servizio restava giù senza incident. Con una mappa sola si va dritti al suo
 * dettaglio, dove c'è il motivo.
 */
async function checkServiceIncidentProblems(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const maps = await serviceMapsWithIncidentProblem(session, tenantId)
  if (maps.length === 0) return []
  return [{
    kind: 'service_incident_problem', severity: 'error',
    where: maps.length === 1 ? `/monitoring/services/${maps[0]!.id}` : '/monitoring/services',
    params: { count: String(maps.length), services: maps.map((m) => m.name).join(', ') },
  }]
}

/**
 * LA CONSERVAZIONE DELLE NOTIFICHE NON SCELTA (ondata 2): la pulizia notturna
 * salta questa organizzazione, e le notifiche crescono senza limite. Un avviso:
 * niente è rotto oggi.
 */
async function checkInAppRetention(tenantId: string): Promise<ConfigurationIssue[]> {
  if (await tenantInAppRetentionDays(tenantId) !== null) return []
  return [{ kind: 'inapp_retention_not_set', severity: 'warning', where: '/settings/organization', params: {} }]
}

/**
 * VOCI DEL CATALOGO SENZA PRIORITÀ (verifica «Cosa resta cablato», ondata 1):
 * la priorità delle richieste la decide la voce, e da una voce attiva che non
 * ne ha nessuna il portale non apre richieste.
 */
async function checkCatalogItemPriorities(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const names = await catalogItemsWithoutPriority(session, tenantId)
  if (names.length === 0) return []
  return [{ kind: 'catalog_items_without_priority', severity: 'error', where: '/admin/service-catalog', params: { count: String(names.length), items: names.join(', ') } }]
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

/**
 * Ticket aperti che nessuna policy SLA copre, quindi senza SLA.
 *
 * Prima non potevano esistere: le policy di fabbrica scritte nel codice
 * coprivano tutto, in silenzio. Tolte quelle, un ticket senza policy resta
 * senza SLA — e si dice qui, con i primi numeri.
 */
async function checkTicketsWithoutSla(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const { count, numbers } = await ticketsWithoutSla(session, tenantId)
  if (count === 0) return []
  return [{
    kind: 'tickets_without_sla', severity: 'warning', where: '/admin/sla-policies',
    params: {
      count: String(count),
      tickets: numbers.join(', '),
      others: String(Math.max(0, count - numbers.length)),
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

/**
 * LE SCADENZE DEI PASSI CHE NON RIESCONO A SPOSTARE UN TICKET (ondata 3). Il
 * varco delle approvazioni le ha rifiutate, o il workflow è cambiato e non
 * hanno più strada: il ticket resta nel passo e la scadenza si riprova ogni
 * ora. I numeri, perché chi guarda possa aprirli.
 */
async function checkStepDeadlines(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const blocked = await blockedStepDeadlines(session, tenantId)
  if (blocked.length === 0) return []
  const shown = blocked.slice(0, 10).map((b) => `${b.number} (${b.step})`).join(', ')
  return [{
    kind: 'step_deadlines_blocked', severity: blocked.some((b) => b.outcome === 'failed') ? 'error' : 'warning', where: '/workflow',
    params: { count: String(blocked.length), tickets: blocked.length > 10 ? `${shown}, …` : shown },
  }]
}
