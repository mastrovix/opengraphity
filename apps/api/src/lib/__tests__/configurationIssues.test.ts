/**
 * La diagnostica che dice all'amministratore cosa c'è da sistemare (revisione
 * delle otto ondate · A·#3, D·D4, D·#5, C·#8).
 *
 * Il prodotto sapeva già tutte queste cose e le diceva a tutti tranne che a chi
 * può rimediare: l'intestazione HTTP, la metrica, il log e `migrate --status`
 * non arrivano all'amministratore del tenant, che vede solo pagine che non
 * funzionano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let degraded = { degraded: false, reason: null as string | null }
let gaps: Array<{ kind: string; params?: Record<string, string> }> = []
let policy: Record<string, string[]> = { ignore_lifecycle_statuses: [], retired_statuses: [], maintenance_statuses: [] }
let vocabularies: Record<string, string[]> = {}
let matrices: Record<string, Record<string, string>> = {}
/**
 * I vocabolari come stanno sul grafo, per il controllo delle ETICHETTE
 * (ondata 1): quello legge il nodo, non `domainVocabulary`, perché gli serve
 * anche `value_labels`.
 */
let enumRows: Array<{ name: string; owner: string; values: string[]; labels: string | null }> = []
/** La lingua predefinita del cliente: `null` = nessuno l'ha scelta. */
let linguaDelCliente: string | null = 'it'

vi.mock('@opengraphity/neo4j', () => ({
  // `runQuery` serve al controllo delle change ferme (changesStuck.ts): senza,
  // quel controllo falliva e ogni scenario di questo file si ritrovava un
  // `check_failed` in più — un mock incompleto che fa sembrare rotto il codice.
  runQuery: vi.fn(async () => []),
  getSession: () => ({
    run: vi.fn(),
    executeRead: (fn: (tx: { run: () => Promise<unknown> }) => unknown) => fn({
      run: async () => ({
        records: enumRows.map((r) => ({
          get: (k: string) => ({ name: r.name, owner: r.owner, values: r.values, labels: r.labels }[k] ?? null),
        })),
      }),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('../schemaCache.js', () => ({ getSchemaState: vi.fn(async () => degraded) }))
/**
 * I campi con una formula e l'interruttore degli script (moduli del catalogo,
 * ondata 6): di default nessun campo calcolato e script accesi, così questo
 * controllo non compare nei casi degli altri.
 */
let campiConFormula: string[] = []
let scriptAccesi = true
vi.mock('../catalogForm.js', () => ({ formFieldsWithFormula: vi.fn(async () => campiConFormula) }))
vi.mock('../scriptingPlan.js', () => ({ getScriptingPlan: vi.fn(async () => ({ plan: 'enterprise', enabled: scriptAccesi })) }))
/*
  La lingua predefinita del cliente: da quando e configurazione, «non
  configurata» e uno stato che la diagnostica deve saper dire.
*/
vi.mock('../tenantLanguage.js', () => ({
  tenantDefaultLanguage: vi.fn(async () => linguaDelCliente),
  LINGUA_DI_ULTIMA_ISTANZA: 'en',
}))
vi.mock('../provisionTenantData.js', () => ({ tenantProvisioningGaps: vi.fn(async () => gaps) }))
/** Il fuso del cliente: `null` = nessuno l'ha scelto. */
let fusoDelCliente: string | null = 'Europe/Rome'
vi.mock('../tenantTimezone.js', () => ({ tenantTimezone: vi.fn(async () => fusoDelCliente) }))
/** Le migrazioni pendenti (F8): di default nessuna. */
let migrazioniPendenti: string[] = []
vi.mock('../migrationState.js', () => ({ pendingMigrations: vi.fn(async () => migrazioniPendenti) }))
/** Policy e contratti in orario di servizio senza un calendario valido (ondata 2): di default nessuno. */
let senzaCalendario: string[] = []
vi.mock('../serviceCalendars.js', () => ({ businessHoursWithoutCalendar: vi.fn(async () => senzaCalendario) }))
/** I team senza interno/esterno: di default nessuno, cosi i test degli altri controlli non li vedono. */
let senzaProvenienza: { count: number; names: string[] } = { count: 0, names: [] }
vi.mock('../teamSourcing.js', () => ({ teamsWithoutSourcing: vi.fn(async () => senzaProvenienza) }))
/** I ticket aperti senza SLA: di default nessuno. */
let senzaSla: { count: number; numbers: string[] } = { count: 0, numbers: [] }
vi.mock('../ticketsWithoutSla.js', () => ({ ticketsWithoutSla: vi.fn(async () => senzaSla) }))
/** I workflow a cui mancano ruoli dei passi (F17): di default nessuno. */
let ruoliMancanti: Array<Record<string, unknown>> = []
vi.mock('../workflowStepRoles.js', () => ({ workflowsMissingStepRoles: vi.fn(async () => ruoliMancanti) }))
/** Le copie dei vocabolari rimaste indietro rispetto ai valori spediti (F20): di default nessuna. */
let copieIndietro: Array<{ id: string; name: string; newValues: string[] }> = []
/** Le copie di vocabolario identiche alla spedita: di default nessuna. */
let copieInutili: Array<{ id: string; name: string; label: string }> = []
vi.mock('../vocabularyShippedDrift.js', () => ({
  vocabulariesBehindShipped: vi.fn(async () => copieIndietro),
  vocabulariesCopiedWithoutChanges: vi.fn(async () => copieInutili),
}))
/** Le policy SLA con il preavviso non prima della scadenza (giro nel browser): di default nessuna. */
let preavvisiScaduti: Array<{ name: string; warningMinutes: number; resolveMinutes: number }> = []
// Verifica «Cosa resta cablato», ondata 1: le severità del portale dichiarate e dentro il vocabolario.
let severitaDelPortale: { value: string; labels: Record<string, string> }[] | null = [{ value: 'low', labels: {} }]
vi.mock('../portalSeverityOptions.js', () => ({
  PORTAL_SEVERITY_VOCABULARY: 'severity',
  portalSeverityOptions: vi.fn(async () => severitaDelPortale),
}))
let giorniNotifiche: number | null = 30
vi.mock('../tenantInAppRetention.js', () => ({ tenantInAppRetentionDays: vi.fn(async () => giorniNotifiche) }))
let vociSenzaPriorita: string[] = []
let vociCategoriaVecchia: Array<{ name: string; legacy: string }> = []
/** D56: the active catalog items without a fulfilment group; none by default. */
let vociSenzaGruppo: string[] = []
vi.mock('../catalogItemPriority.js', () => ({ catalogItemsWithoutPriority: vi.fn(async () => vociSenzaPriorita), catalogItemsWithLegacyCategory: vi.fn(async () => vociCategoriaVecchia), catalogItemsWithoutFulfillmentTeam: vi.fn(async () => vociSenzaGruppo) }))
vi.mock('../stepDeadlineBlocked.js', () => ({ blockedStepDeadlines: vi.fn(async () => []) }))
let canaliSlackSenzaWorkspace: string[] = []
vi.mock('../slackChannelsWithoutWorkspace.js', () => ({ slackChannelsWithoutWorkspace: vi.fn(async () => canaliSlackSenzaWorkspace) }))
/** SV-4: le mappe il cui incident il monitoraggio non riesce a gestire; di default nessuna. */
let mappeConProblema: Array<{ id: string; name: string }> = []
vi.mock('../serviceIncidentProblems.js', () => ({ serviceMapsWithIncidentProblem: vi.fn(async () => mappeConProblema) }))
// Campi dei ticket con regole di fase (secondo giro UI del 15 set 2026): uno che cita una fase sparita.
let campiConFasi: Array<{ label: string; visibility: unknown; editability: unknown }> = []
vi.mock('../ticketCustomFields.js', () => ({ customFieldDefs: vi.fn(async (_s: unknown, _t: string, entityType: string) => entityType === 'change' ? campiConFasi : []) }))
vi.mock('../customFieldSteps.js', async (importOriginal) => ({ ...(await importOriginal<object>()), workflowStepsByDefinition: vi.fn(async () => [
  { workflow: 'Change RFC Process', category: null, steps: [{ name: 'assessment' }, { name: 'review' }, { name: 'closed' }] },
  { workflow: 'Change Emergency', category: 'emergency', steps: [{ name: 'assessment' }, { name: 'closed' }] },
]) }))
// Contratti OLA/UC (secondo giro UI del 15 set 2026, punto 3): di default tutti misurabili.
let misurabilitaOLA: { withoutTeam: string[]; unmeasurable: string[] } = { withoutTeam: [], unmeasurable: [] }
let campiDuplicati: Array<{ typeName: string; field: string; count: number }> = []
let moduliDaSistemare: Array<{ item: string; reason: string; fields: string[] }> = []
vi.mock('../olaMeasurability.js', () => ({ olaContractsMeasurability: vi.fn(async () => misurabilitaOLA) }))
/* I campi duplicati nel metamodello: di norma nessuno (il caso suo sta in metamodelDuplicateFields.test.ts). */
vi.mock('../metamodelDuplicateFields.js', () => ({ duplicateMetamodelFields: vi.fn(async () => campiDuplicati) }))
/* I moduli del catalogo da sistemare: di norma nessuno (il caso suo sta in fondo). */
vi.mock('../catalogFormHealth.js', () => ({ catalogFormsToFix: vi.fn(async () => moduliDaSistemare) }))
vi.mock('../slaWarningCheck.js', () => ({ slaPoliciesWarningNotBeforeDeadline: vi.fn(async () => preavvisiScaduti) }))
vi.mock('../../services/events/policy.js', () => ({ getEventPolicy: vi.fn(async () => policy) }))
vi.mock('../domainMatrix.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../domainMatrix.js')>()
  return {
    ...orig,
    domainVocabulary: vi.fn(async (_t: string, name: string) => vocabularies[name] ?? []),
    // Le dimensioni d'ingresso a scala del prodotto (service_urgency) non sono vocabolari.
    matrixInputValues: vi.fn(async (_t: string, kind: keyof typeof orig.DOMAIN_MATRIX_KINDS) => {
      const spec: { inputs: readonly string[]; inputScales?: Record<string, readonly string[]> } = orig.DOMAIN_MATRIX_KINDS[kind]
      return spec.inputs.map((i) => spec.inputScales?.[i] ?? vocabularies[i] ?? [])
    }),
    // Le uscite a scala (environment_risk) non sono vocabolari: la scala è del prodotto.
    matrixOutputValues: vi.fn(async (_t: string, kind: keyof typeof orig.DOMAIN_MATRIX_KINDS) => {
      const spec: { output: string; scale?: readonly string[] } = orig.DOMAIN_MATRIX_KINDS[kind]
      return spec.scale ?? vocabularies[spec.output] ?? []
    }),
    loadDomainMatrix: vi.fn(async (_t: string, kind: string) => ({ kind, entries: matrices[kind] ?? {}, isDefault: false, updatedAt: null })),
  }
})

const { configurationIssues: configurationIssuesCached, invalidateConfigurationIssues } = await import('../configurationIssues.js')

/**
 * CONTRATTO RINEGOZIATO (revisione totale · C-33): i rilievi stanno in cache
 * per un minuto — il banner li chiedeva a ogni apertura di pagina e i
 * ventitré controlli fanno scansioni vere. Questi test cambiano la
 * configurazione a metà e richiedono i rilievi di nuovo: qui si rilegge
 * sempre fresco, che è quello che vogliono verificare.
 */
const configurationIssues = async (tenantId: string) => {
  invalidateConfigurationIssues()
  return configurationIssuesCached(tenantId)
}
type Issue = Awaited<ReturnType<typeof configurationIssues>>[number]
/**
 * I PARAMETRI, non la frase.
 *
 * Questi test pinnavano il testo italiano che la diagnostica componeva. Ora la
 * diagnostica non compone niente — manda una chiave e i dati, e la frase la
 * scrive il client nella lingua di chi guarda — quindi si pinnano i DATI. Che
 * la frase esista in italiano e in inglese per ogni `kind` lo pinna
 * `configurationIssueKeys.test.ts`: separare le due cose e il punto di tutto
 * il cambiamento.
 */
const par = (i: Issue | undefined) => i?.params ?? {}
const { DOMAIN_MATRIX_KINDS } = await import('../domainMatrix.js')

/** Vocabolari e matrici complete: lo stato in cui non c'è niente da dire. */
function healthy(): void {
  degraded = { degraded: false, reason: null }
  linguaDelCliente = 'it'
  severitaDelPortale = [{ value: 'low', labels: {} }]
  vociSenzaPriorita = []
  vociSenzaGruppo = []
  vociCategoriaVecchia = []
  giorniNotifiche = 30
  canaliSlackSenzaWorkspace = []
  mappeConProblema = []
  gaps = []
  vocabularies = {
    impact: ['low'], urgency: ['low'], priority: ['low'], severity: ['low'],
    service_criticality: ['mission_critical'], event_severity: ['info'], import_severity: ['minor'],
    change_type: ['standard'], risk_band: ['low'], environment: ['production'],
    ci_status: ['active', 'dismesso'],
  }
  matrices = Object.fromEntries(Object.entries(DOMAIN_MATRIX_KINDS).map(([kind, spec]) => {
    // Una dimensione a scala del prodotto (service_urgency) va coperta tutta: i
    // suoi valori non si riducono a uno come i vocabolari del test.
    const scales = (spec as { inputScales?: Record<string, readonly string[]> }).inputScales
    const scale = (spec as { scale?: readonly string[] }).scale
    const out = scale ? scale[0]! : vocabularies[spec.output]![0]!
    const keys = spec.inputs.reduce<string[]>((acc, i) => {
      const values = scales?.[i] ?? [vocabularies[i]![0]!]
      return acc.flatMap((prefix) => values.map((v) => (prefix ? `${prefix}|${v}` : v)))
    }, [''])
    return [kind, Object.fromEntries(keys.map((k) => [k, out]))]
  }))
  policy = { ignore_lifecycle_statuses: [], retired_statuses: ['dismesso'], maintenance_statuses: [], production_environments: ['production'] }
  // Ogni valore con la sua etichetta IN TUTTE LE LINGUE: lo stato in cui il
  // controllo tace. Una lingua sola non basta piu: da quando le etichette sono
  // per lingua, chi ne ha una sola viene segnalato (chi usa l'altra lo legge in
  // italiano).
  enumRows = Object.entries(vocabularies).map(([name, values]) => ({
    name, owner: 'system', values,
    labels: JSON.stringify(Object.fromEntries(values.map((v) => [v, { it: `Etichetta ${v}`, en: `Label ${v}` }]))),
  }))
}

beforeEach(() => { healthy(); invalidateConfigurationIssues() })

describe('configurationIssues', () => {
  it('niente da sistemare → lista vuota (un banner che compare sempre diventa invisibile)', async () => {
    expect(await configurationIssues('c-one')).toEqual([])
  })

  it('ondata 8: canali Slack col bot ma nessun workspace collegato → errore che li nomina, si rimedia in Integrazioni', async () => {
    canaliSlackSenzaWorkspace = ['#ops', '#major']
    expect(await configurationIssues('c-one')).toEqual([
      { kind: 'slack_not_connected', severity: 'error', where: '/admin/integrations', params: { count: '2', channels: '#ops, #major' } },
    ])
  })

  it('SV-4: servizi il cui incident non si riesce a gestire → errore che li nomina; con uno solo si va al suo dettaglio', async () => {
    mappeConProblema = [{ id: 'map-1', name: 'Portale clienti' }]
    expect(await configurationIssues('c-one')).toEqual([
      { kind: 'service_incident_problem', severity: 'error', where: '/monitoring/services/map-1', params: { count: '1', services: 'Portale clienti' } },
    ])
    mappeConProblema = [{ id: 'map-1', name: 'Billing' }, { id: 'map-2', name: 'CRM' }]
    expect(await configurationIssues('c-one')).toEqual([
      { kind: 'service_incident_problem', severity: 'error', where: '/monitoring/services', params: { count: '2', services: 'Billing, CRM' } },
    ])
  })

  it('conservazione delle notifiche non scelta → avviso, si rimedia in Organizzazione', async () => {
    giorniNotifiche = null
    expect(await configurationIssues('c-one')).toEqual([
      { kind: 'inapp_retention_not_set', severity: 'warning', where: '/settings/organization', params: {} },
    ])
  })

  it('voci del catalogo con una categoria scritta a mano non convertita → avviso che le nomina col testo di prima', async () => {
    vociCategoriaVecchia = [{ name: 'Badge', legacy: 'Sicurezza fisica' }]
    expect(await configurationIssues('c-one')).toEqual([
      { kind: 'catalog_items_legacy_category', severity: 'warning', where: '/admin/service-catalog', params: { count: '1', items: 'Badge («Sicurezza fisica»)' } },
    ])
  })

  it('voci attive del catalogo senza priorità → errore che le nomina, si rimedia nel catalogo', async () => {
    vociSenzaPriorita = ['Nuovo laptop', 'Sblocco account']
    expect(await configurationIssues('c-one')).toEqual([
      { kind: 'catalog_items_without_priority', severity: 'error', where: '/admin/service-catalog', params: { count: '2', items: 'Nuovo laptop, Sblocco account' } },
    ])
  })

  // D56 (23 Sep 2026): their requests are born without a team — in nobody's queue, invisible to the OLAs.
  it('active catalog items without a fulfilment group → a warning naming them, fixed in the catalog', async () => {
    vociSenzaGruppo = ['New laptop', 'VPN access']
    expect(await configurationIssues('c-one')).toEqual([
      { kind: 'catalog_items_without_fulfillment_team', severity: 'warning', where: '/admin/service-catalog', params: { count: '2', items: 'New laptop, VPN access' } },
    ])
  })

  it('severità del portale non dichiarate → errore, si rimedia in Organizzazione', async () => {
    severitaDelPortale = null
    expect(await configurationIssues('c-one')).toEqual([
      { kind: 'portal_severities_not_set', severity: 'error', where: '/settings/organization', params: {} },
    ])
  })

  it('severità del portale fuori dal vocabolario (rinominata nel Dizionario) → errore che la nomina', async () => {
    severitaDelPortale = [{ value: 'low', labels: {} }, { value: 'urgente', labels: {} }]
    expect(await configurationIssues('c-one')).toEqual([
      { kind: 'portal_severities_stale', severity: 'error', where: '/settings/organization', params: { values: 'urgente' } },
    ])
  })

  it('schema degradato → errore che riporta il motivo e dove si rimedia', async () => {
    degraded = { degraded: true, reason: 'tipo "armadio": unknown fieldType "integer"' }
    const [issue] = await configurationIssues('c-one')
    expect(issue).toMatchObject({ kind: 'schema_degraded', severity: 'error', where: '/settings/ci-types' })
    expect(par(issue)['reason']).toContain('unknown fieldType "integer"')
  })

  it('buchi di configurazione → errore che porta i buchi come CHIAVI, non come frase', async () => {
    gaps = [{ kind: 'no_workflows', params: { entityTypes: 'incident, change' } }]
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'provisioning_gap')
    expect(issue).toMatchObject({ severity: 'error', where: '/workflow' })
    // Ogni buco passa con la SUA chiave e i suoi dati: il client li risolve uno
    // per uno e li unisce come si uniscono gli elenchi nella sua lingua.
    expect(issue!.gaps).toEqual([{ kind: 'no_workflows', params: { entityTypes: 'incident, change' } }])
    expect(par(issue)['count']).toBe('1')
  })

  /**
   * TRE VOCI, non una con tre pezzi. Prima era un messaggio solo, cucito
   * incollando i pezzi presenti, e prendeva la gravita del peggiore: una chiave
   * residua dentro la stessa voce di una cella mancante diventava un `error`,
   * mentre non ferma niente. Separate, ognuna porta la sua gravita vera.
   */
  it('celle mancanti e chiavi residue sono DUE voci, con due gravita diverse', async () => {
    vocabularies['impact'] = ['low', 'high']   // la matrice `priority` non copre `high|low`
    const mancante = (await configurationIssues('c-one')).find((i) => i.kind === 'matrix_missing_cells')
    expect(mancante).toMatchObject({ severity: 'error', where: '/settings/domain-matrices' })
    expect(par(mancante)).toMatchObject({ matrix: 'priority', count: '1' })
    expect(par(mancante)['examples']).toContain('high|low')

    healthy()
    matrices['priority'] = { ...matrices['priority']!, 'rimasto|low': 'low' }
    const residuo = (await configurationIssues('c-one')).find((i) => i.kind === 'matrix_stale_keys')
    expect(residuo).toMatchObject({ severity: 'warning' })
    expect(par(residuo)).toMatchObject({ matrix: 'priority', count: '1' })
    // e NON e la voce delle celle mancanti: la matrice le ha tutte
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'matrix_missing_cells')).toBeUndefined()
  })

  /**
   * D·#5: la migrazione `1810` scrive `retired_statuses` senza verificare che
   * quei valori siano nel `ci_status` del cliente. Chi aveva già rinominato
   * `decommissioned` si ritrovava una policy che punta al nulla — cioè i CI
   * dismessi di nuovo dentro la salute dei servizi, che è il difetto C-4
   * dichiarato chiuso, spostato dal codice al dato.
   */
  // D44 (23 Sep 2026): a stale production environment empties every service map.
  it('a production environment the vocabulary no longer has → the same error, naming the list', async () => {
    policy = { ...policy, production_environments: ['production', 'prod-old'] }
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'policy_out_of_vocabulary')
    expect(issue).toMatchObject({ severity: 'error', where: '/settings/event-policy', params: { details: 'production_environments → prod-old' } })
  })

  it('la policy che cita uno stato fuori vocabolario → errore che dice la conseguenza', async () => {
    policy = { ...policy, retired_statuses: ['decommissioned'] }   // il cliente l'ha rinominato
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'policy_out_of_vocabulary')
    // La rotta VERA e `settings/event-policy`: questo test pinnava la stringa
    // che l'autore credeva giusta, e il pulsante «Vai a sistemare» portava su
    // una pagina vuota. Chi risolve i `where` contro il router e
    // `apps/web/src/__tests__/configurationIssueRoutes.test.ts`; qui si pinna
    // solo che il campo ci sia e sia quello.
    expect(issue).toMatchObject({ severity: 'error', where: '/settings/event-policy' })
    expect(par(issue)['details']).toContain('retired_statuses → decommissioned')
  })

  /**
   * C·#8, il caso reale di c-one: `expired` e `revoked` sono stati aggiunti al
   * vocabolario, ma `retired_statuses` non li conosce — 68 CI con un ciclo di
   * vita concluso pesavano ancora nella salute dei servizi, e nessuna pagina lo
   * diceva.
   */
  it('stati aggiunti al vocabolario senza semantica → avviso che dice cosa significa per il prodotto', async () => {
    vocabularies['ci_status'] = ['active', 'dismesso', 'expired', 'revoked']
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'vocabulary_without_semantics')
    expect(issue).toMatchObject({ severity: 'warning' })
    expect(par(issue)).toMatchObject({ statuses: 'expired, revoked', count: '2' })
  })

  it('il primo valore della scala non è «senza semantica»: è lo stato in servizio', async () => {
    vocabularies['ci_status'] = ['active', 'dismesso']
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'vocabulary_without_semantics')).toBeUndefined()
  })

  /**
   * Terza revisione · M10. Con un vocabolario vuoto, `cartesian([])` e vuoto,
   * quindi OGNI chiave della matrice risultava «rimasta da una rinomina»: la
   * diagnosi accusava la matrice e mandava l'admin alla pagina dove un «Salva»
   * cancella le chiavi residue — cioe a distruggere una matrice sana. E del
   * vocabolario vuoto, che e il problema vero, non diceva niente.
   */
  it('un vocabolario VUOTO si accusa per nome, e della matrice non si dice niente', async () => {
    vocabularies['impact'] = []
    const issues = await configurationIssues('c-one')

    const vuoto = issues.find((i) => i.kind === 'vocabulary_empty')
    expect(vuoto).toMatchObject({ severity: 'error', where: '/settings/enum-designer' })
    // Il vocabolario si accusa per NOME, e il nome e un dato. La conseguenza
    // vera («non si apre piu nessun ticket») e il rimedio sbagliato da evitare
    // («non salvare la matrice») stanno nei valori i18n, dove si traducono.
    expect(par(vuoto)).toMatchObject({ vocabularies: 'impact', count: '1', matrix: 'priority' })

    // E la matrice che USA quel vocabolario non viene accusata.
    const matrice = issues.filter((i) => i.kind.startsWith('matrix_'))
    expect(matrice.map((i) => i.params['matrix'] ?? '')).not.toContain('priority')
  })

  /**
   * La lingua predefinita era una costante nel codice, e ora e configurazione:
   * apre un caso che prima non esisteva — nessuno l'ha scelta. Bisogna mostrare
   * qualcosa e si mostra la prima lingua del prodotto, ma non in silenzio:
   * altrimenti un cliente si chiede per mesi perche il prodotto gli parla in
   * una lingua che non ha chiesto.
   */
  it('nessuno ha scelto la lingua → avviso che dice quale si sta usando e perche', async () => {
    linguaDelCliente = null
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'default_language_not_set')
    expect(issue).toMatchObject({ severity: 'warning', where: '/settings/organization' })
    expect(par(issue)).toMatchObject({ fallback: 'en', available: 'en, it' })
  })

  it('con la lingua configurata, nessun avviso: e una scelta, non un ripiego', async () => {
    linguaDelCliente = 'it'
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'default_language_not_set')).toBeUndefined()
  })

  /**
   * Revisione del 14 set 2026 · F7: il fuso ora si sceglie da Organizzazione.
   * Senza, ogni scadenza SLA/OLA, il digest e le date dei messaggi falliscono:
   * e un errore, e dice dove si sistema.
   */
  it('nessun fuso configurato → errore che rimanda a Organizzazione', async () => {
    fusoDelCliente = null
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'timezone_not_set')
    expect(issue).toMatchObject({ severity: 'error', where: '/settings/organization' })
    fusoDelCliente = 'Europe/Rome'
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'timezone_not_set')).toBeUndefined()
  })

  /** Revisione del 14 set 2026 · F8: le migrazioni pendenti si dicono all'admin, con quali sono. */
  it('migrazioni pendenti → errore con il numero e i nomi', async () => {
    migrazioniPendenti = ['20260924_1000_x', '20260924_1010_y']
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'migrations_pending')
    expect(issue).toMatchObject({ severity: 'error', where: null, params: { count: '2', migrations: '20260924_1000_x, 20260924_1010_y' } })
    migrazioniPendenti = []
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'migrations_pending')).toBeUndefined()
  })

  /**
   * Revisione del 14 set 2026 · F6: senza calendario, una policy SLA o un
   * contratto OLA in orario lavorativo non sa calcolare le scadenze. Errore
   * solo se qualcuno lo usa.
   */
  it('policy o contratti in orario di servizio senza calendario valido → errore con i nomi; nessuno → silenzio', async () => {
    senzaCalendario = ['Incident di rete', 'OLA Rete']
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'service_calendar_not_set')
    expect(issue).toMatchObject({ severity: 'error', where: '/admin/sla-policies', params: { count: '2', names: 'Incident di rete, OLA Rete' } })
    senzaCalendario = []
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'service_calendar_not_set')).toBeUndefined()
  })

  /**
   * Revisione del 14 set 2026 · F17: un workflow a cui manca la categoria o lo
   * scopo che il codice cerca. Obbligatori → errore (un'operazione si ferma);
   * facoltativi → avviso (un comportamento si spegne in silenzio). Una voce per
   * workflow, con il nome, e i valori mancanti come DATI.
   */
  /**
   * Revisione del 14 set 2026 · F20: il prodotto ha spedito valori nuovi in un
   * vocabolario che il cliente ha personalizzato, e la copia non li ha. Avviso,
   * con i nomi: si decide dal Dizionario (adottarli o tenerli fuori).
   */
  /**
   * Giro nel browser del 14 set 2026: una migrazione aveva messo il preavviso
   * a 30 minuti su tutte le policy, anche su quella da 30 minuti di risoluzione.
   * L'avviso «SLA about to be breached» partiva alla creazione di ogni ticket.
   * Il resolver ora lo rifiuta, ma i dati già scritti li dice la diagnostica.
   */
  it('policy SLA con il preavviso non prima della scadenza → errore con i nomi', async () => {
    preavvisiScaduti = [{ name: 'Incident di rete', warningMinutes: 30, resolveMinutes: 30 }]
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'sla_warning_not_before_deadline')
    expect(issue).toEqual({
      kind: 'sla_warning_not_before_deadline', severity: 'error', where: '/admin/sla-policies',
      params: { count: '1', details: '«Incident di rete»: 30 / 30 min' },
    })
    preavvisiScaduti = []
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'sla_warning_not_before_deadline')).toBeUndefined()
  })

  it('copie dei vocabolari indietro rispetto ai valori spediti → avviso con vocabolari e valori', async () => {
    copieIndietro = [{ id: 'c-1', name: 'priority', newValues: ['critical'] }, { id: 'c-2', name: 'environment', newValues: ['dr', 'lab'] }]
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'vocabulary_behind_shipped')
    expect(issue).toEqual({
      kind: 'vocabulary_behind_shipped', severity: 'warning', where: '/settings/enum-designer',
      params: { count: '2', details: '«priority»: critical · «environment»: dr, lab' },
    })
    copieIndietro = []
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'vocabulary_behind_shipped')).toBeUndefined()
  })

  it('workflow senza i ruoli dei passi → errore per gli obbligatori, avviso per i facoltativi', async () => {
    ruoliMancanti = [
      { workflow: 'Incident — Rinominato', entityType: 'incident', required: { categories: ['resolved', 'escalated'], purposes: [] }, optional: { categories: [], purposes: [] } },
      { workflow: 'Change RFC', entityType: 'change', required: { categories: [], purposes: [] }, optional: { categories: [], purposes: ['implementation'] } },
    ]
    const issues = (await configurationIssues('c-one')).filter((i) => i.kind.startsWith('workflow_'))
    expect(issues).toEqual([
      { kind: 'workflow_step_categories_missing', severity: 'error', where: '/workflow',
        params: { workflow: 'Incident — Rinominato', entityType: 'incident', missing: 'resolved, escalated' } },
      { kind: 'workflow_optional_step_purposes_missing', severity: 'warning', where: '/workflow',
        params: { workflow: 'Change RFC', entityType: 'change', missing: 'implementation' } },
    ])
    ruoliMancanti = []
    expect((await configurationIssues('c-one')).filter((i) => i.kind.startsWith('workflow_'))).toEqual([])
  })

  /**
   * Interno/esterno e un campo nuovo: i team che esistevano prima non lo
   * hanno, e la migrazione non lo indovina. Si dice qui, con i nomi.
   */
  it('team senza interno/esterno → avviso con quanti sono, i primi nomi e quanti restano fuori elenco', async () => {
    senzaProvenienza = { count: 12, names: ['Rete', 'Server'] }
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'teams_without_sourcing')
    expect(issue).toMatchObject({ severity: 'warning', where: '/teams' })
    expect(par(issue)).toMatchObject({ count: '12', teams: 'Rete, Server', others: '10' })
    senzaProvenienza = { count: 0, names: [] }
  })

  it('con tutti i team indicati, nessun avviso', async () => {
    senzaProvenienza = { count: 0, names: [] }
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'teams_without_sourcing')).toBeUndefined()
  })

  /**
   * Senza policy SLA di fabbrica, un ticket che nessuna policy copre resta
   * senza SLA: l'amministratore lo deve vedere, con i numeri.
   */
  it('ticket aperti senza SLA → avviso con quanti sono, i primi numeri e il posto dove si rimedia', async () => {
    senzaSla = { count: 3, numbers: ['INC00000009', 'PRB00000004'] }
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'tickets_without_sla')
    expect(issue).toMatchObject({ severity: 'warning', where: '/admin/sla-policies' })
    expect(par(issue)).toMatchObject({ count: '3', tickets: 'INC00000009, PRB00000004', others: '1' })
    senzaSla = { count: 0, numbers: [] }
  })

  it('con ogni ticket aperto coperto da uno SLA, nessun avviso', async () => {
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'tickets_without_sla')).toBeUndefined()
  })

  it('un controllo che fallisce diventa una voce, e non nasconde gli altri', async () => {
    const { getSchemaState } = await import('../schemaCache.js')
    vi.mocked(getSchemaState).mockRejectedValueOnce(new Error('neo4j giù'))
    gaps = [{ kind: 'no_dashboard' }]
    const issues = await configurationIssues('c-one')
    const rotto = issues.find((i) => i.kind === 'check_failed')
    expect(par(rotto)['error']).toContain('neo4j giù')
    expect(par(rotto)['check']).toBe('checkSchema')
    expect(issues.find((i) => i.kind === 'provisioning_gap')).toBeDefined()
  })
})

/**
 * I valori senza ETICHETTA (ondata 1).
 *
 * La migrazione semina l'italiano per i valori spediti il giorno in cui è
 * scritta, e non può sapere niente di quelli aggiunti dopo — né di quelli che
 * il cliente aggiunge da sé. Nessuna lista congelata può prevedere il futuro:
 * quel pezzo lo fa questa diagnostica, dove c'è un admin a cui dirlo.
 */
describe('checkValueLabels', () => {
  it('un valore senza etichetta è un AVVISO che lo nomina e dice dove si rimedia', async () => {
    enumRows = enumRows.map((r) => (r.name === 'priority'
      ? { ...r, labels: JSON.stringify({}) }   // priority ha un valore, e nessuna etichetta
      : r))
    const issues = await configurationIssues('c-one')
    const issue = issues.find((i) => i.kind === 'value_labels_missing')
    expect(issue).toBeDefined()
    expect(issue!.severity).toBe('warning')     // si legge peggio, non è rotto
    expect(issue!.where).toBe('/settings/enum-designer')
    expect(par(issue)['details']).toMatch(/«priority»: low/)
  })

  it('i vocabolari senza etichette PER SCELTA non fanno rumore, mai', async () => {
    // `import_severity` (28 chiavi di riconoscimento) e i nomi dei passi:
    // lamentarsene per sempre renderebbe il banner invisibile in una settimana.
    enumRows = [
      { name: 'import_severity', owner: 'system', values: ['p1', 'sev1'], labels: null },
      { name: 'status_incident', owner: 'system', values: ['new', 'closed'], labels: null },
    ]
    const issues = await configurationIssues('c-one')
    expect(issues.find((i) => i.kind === 'value_labels_missing')).toBeUndefined()
  })

  it('il vocabolario del CLIENTE vince su quello spedito, come in lettura', async () => {
    // Lo spedito ha le etichette, la copia del cliente no: è la copia che si
    // legge, quindi è la copia che va segnalata.
    enumRows = [
      { name: 'priority', owner: 'system',  values: ['low'], labels: '{"low":{"it":"Bassa","en":"Low"}}' },
      { name: 'priority', owner: 'c-one',   values: ['low', 'urgentissima'], labels: '{"low":{"it":"Bassa","en":"Low"}}' },
    ]
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'value_labels_missing')
    expect(par(issue)['details']).toMatch(/urgentissima/)
    expect(par(issue)['details']).not.toMatch(/: low/)
  })
})

/**
 * Le etichette PER LINGUA (decisione del proprietario dopo aver visto
 * «PRIORITÀ: BASSA» in un'interfaccia inglese).
 *
 * «Senza etichetta» ha due gradi, e hanno conseguenze diverse: chi non ne ha
 * nessuna si legge col nome interno del valore; chi ne ha una sola si legge in
 * quella lingua anche nelle altre, perché il ripiego passa per l'italiano. Il
 * secondo caso è più insidioso: non sembra un difetto, sembra una traduzione.
 */
describe('checkValueLabels — una lingua sola non basta', () => {
  it('un valore con l\'etichetta in una lingua sola è segnalato a parte', async () => {
    enumRows = enumRows.map((r) => (r.name === 'priority'
      ? { ...r, labels: JSON.stringify({ low: { it: 'Bassa' } }) }   // manca l'inglese
      : r))
    const issues = await configurationIssues('c-one')
    const parziale = issues.find((i) => i.kind === 'value_labels_partial')
    expect(parziale).toBeDefined()
    expect(par(parziale)['details']).toMatch(/«priority»: low/)
    expect(par(parziale)['languages']).toBe('en / it')
    // e NON è l'altro avviso: l'etichetta c'è, solo non in tutte le lingue
    expect(issues.find((i) => i.kind === 'value_labels_missing')).toBeUndefined()
  })

  it('con tutte le lingue scritte, nessuno dei due avvisi', async () => {
    const issues = await configurationIssues('c-one')
    expect(issues.filter((i) => i.kind.startsWith('value_labels'))).toEqual([])
  })
})

describe('configurationIssues — campi che citano fasi sparite', () => {
  it('un campo «da revue in poi» su un workflow senza «revue» → avviso che lo nomina, si rimedia nel disegnatore ITIL', async () => {
    campiConFasi = [
      { label: 'Esito', visibility: { mode: 'from', step: 'revue' }, editability: { mode: 'visible' } },
      { label: 'Note di chiusura', visibility: { mode: 'from', step: 'review' }, editability: { mode: 'visible' } },
    ]
    try {
      const issues = await configurationIssues('t1')
      expect(issues.filter((i) => i.kind === 'custom_field_steps_missing')).toEqual([
        { kind: 'custom_field_steps_missing', severity: 'warning', where: '/settings/itil-designer', params: { count: '1', fields: 'Esito (change): revue' } },
      ])
      // «da review in poi» e il workflow d'emergenza non ha review: lì il campo non si vede mai
      expect(issues.filter((i) => i.kind === 'custom_field_from_step_absent')).toEqual([
        { kind: 'custom_field_from_step_absent', severity: 'warning', where: '/settings/itil-designer', params: { count: '1', fields: 'Note di chiusura (change, review): Change Emergency' } },
      ])
    } finally { campiConFasi = [] }
  })
})

/**
 * CAMPI DEFINITI DUE VOLTE NELLO STESSO TIPO (trovato nel browser su c-test:
 * «Priorità» due volte nelle tendine delle automazioni). È un `error` e non un
 * avviso: una regola di visibilità scritta su una definizione non vale per
 * l'altra, quindi la configurazione dice una cosa e il prodotto ne fa un'altra.
 */
/**
 * I MODULI CHE NON SI POSSONO COMPILARE (revisione del 17 set 2026): la
 * pubblicazione rifiuta le configurazioni impossibili, ma un modulo pubblicato
 * prima della regola — o rotto cancellando un campo dalla libreria — lo
 * scoprirebbe solo chi apre la richiesta.
 */
describe('configurationIssues — moduli del catalogo da sistemare', () => {
  it('un modulo impossibile → errore che nomina la voce e il motivo, si rimedia nel costruttore', async () => {
    moduliDaSistemare = [
      { item: 'Nuovo portatile', reason: 'requiredNotForEndUser', fields: ['per_chi'] },
      { item: 'Nuovo accesso', reason: 'fieldsMissing', fields: ['centro_di_costo'] },
    ]
    try {
      const issues = await configurationIssues('t1')
      expect(issues.filter((i) => i.kind === 'catalog_form_to_fix')).toEqual([
        {
          kind: 'catalog_form_to_fix', severity: 'error', where: '/settings/catalog-forms',
          params: {
            count: '2',
            forms: 'Nuovo portatile (requiredNotForEndUser: per_chi); Nuovo accesso (fieldsMissing: centro_di_costo)',
          },
        },
      ])
    } finally { moduliDaSistemare = [] }
  })
})

describe('configurationIssues — campi duplicati nel metamodello', () => {
  it('doppioni → errore che li nomina col tipo, si rimedia nel disegnatore', async () => {
    campiDuplicati = [
      { typeName: 'incident', field: 'priority', count: 2 },
      { typeName: 'problem',  field: 'impact',   count: 2 },
    ]
    try {
      const issues = await configurationIssues('t1')
      expect(issues.filter((i) => i.kind === 'metamodel_duplicate_field')).toEqual([
        {
          kind: 'metamodel_duplicate_field', severity: 'error', where: '/settings/itil-designer',
          params: { count: '2', fields: 'incident.priority (2), problem.impact (2)' },
        },
      ])
    } finally { campiDuplicati = [] }
  })
})

describe('configurationIssues — contratti OLA/UC che non misurano niente', () => {
  it('senza team e su ticket che nessuno assegna a un team → due avvisi con i nomi, si rimedia nei contratti', async () => {
    misurabilitaOLA = { withoutTeam: ['Vecchio contratto'], unmeasurable: ['Service Desk evade le richieste entro 1 giorno (service_request)'] }
    try {
      const issues = await configurationIssues('t1')
      expect(issues.filter((i) => i.kind.startsWith('ola_contract'))).toEqual([
        { kind: 'ola_contract_without_team', severity: 'warning', where: '/admin/ola-uc', params: { count: '1', names: 'Vecchio contratto' } },
        { kind: 'ola_contract_unmeasurable', severity: 'warning', where: '/admin/ola-uc', params: { count: '1', names: 'Service Desk evade le richieste entro 1 giorno (service_request)' } },
      ])
    } finally { misurabilitaOLA = { withoutTeam: [], unmeasurable: [] } }
  })
})

/**
 * CAMPI CALCOLATI CON GLI SCRIPT SPENTI (ondata 6). Il rifiuto al salvataggio
 * lo vede chi compila, che non può rimediare: questo controllo è il modo di
 * dirlo a chi può.
 */
describe('formule e interruttore degli script', () => {
  it('script spenti e campi con formula → un rilievo ERRORE che nomina i campi e dove si accende', async () => {
    scriptAccesi = false
    campiConFormula = ['Costo totale (EUR)', 'Giorni stimati']
    const issues = await configurationIssues('t1')
    const mio = issues.find((i) => i.kind === 'formulas_with_scripting_off')!
    expect(mio).toBeDefined()
    expect(mio.severity).toBe('error')
    expect(mio.where).toBe('/settings/organization')
    expect(mio.params['count']).toBe('2')
    expect(mio.params['names']).toContain('Costo totale (EUR)')
  })

  it('script spenti ma NESSUN campo calcolato → niente rilievo: non c'+String.fromCharCode(39)+'è niente di rotto', async () => {
    scriptAccesi = false
    campiConFormula = []
    const issues = await configurationIssues('t1')
    expect(issues.some((i) => i.kind === 'formulas_with_scripting_off')).toBe(false)
  })

  it('script accesi → niente rilievo, e la libreria non si legge affatto', async () => {
    scriptAccesi = true
    campiConFormula = ['Costo totale (EUR)']
    const issues = await configurationIssues('t1')
    expect(issues.some((i) => i.kind === 'formulas_with_scripting_off')).toBe(false)
  })

  it('una copia di vocabolario identica a quella di fabbrica → avviso che la nomina', async () => {
    // Non compra niente e paga il prezzo di ogni copia: non ricevera i valori
    // che il prodotto aggiungera. Avviso e non errore: oggi non e rotto niente.
    copieInutili = [{ id: 'v1', name: 'priority', label: 'Priority' }]
    const out = await configurationIssues('c-one')
    const avviso = out.find((i) => i.kind === 'vocabulary_copy_without_changes')
    expect(avviso?.severity).toBe('warning')
    expect(avviso?.params['names']).toContain('Priority')
    expect(avviso?.where).toBe('/settings/enum-designer')
    copieInutili = []
  })
})
