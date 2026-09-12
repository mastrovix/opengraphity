/**
 * I semi delle matrici di dominio, e i vocabolari che le matrici presuppongono
 * (ondata 7, A7-4).
 *
 * ## Perché un file a parte
 * `lib/domainMatrix.ts` è il NUCLEO: legge, valida, traduce. Chi *scrive* la
 * prima volta — la migrazione `20260917_1800_domain_matrices` e l'onboarding di
 * un cliente nuovo — ha bisogno di una funzione sola, usata da entrambi, così
 * un tenant creato domani nasce con le stesse matrici di uno migrato ieri.
 * Quella funzione è `seedDomainMatrices`.
 *
 * ## I vocabolari che mancavano
 * `DOMAIN_MATRIX_KINDS` dichiara i vocabolari d'ingresso e d'uscita di ogni
 * matrice, e `domainVocabulary` li cerca nel Dizionario del cliente (il suo
 * vince, poi quello di sistema). Dal vivo (12 set 2026) di quei nomi ne
 * esistevano soltanto quattro — `impact`, `priority`, `severity`,
 * `change_type` — perché gli altri vivevano **solo** come liste nel codice:
 *
 *  - `urgency` non era un vocabolario: l'urgenza era `ImpactUrgency`, il tipo
 *    di `lib/priority.ts`;
 *  - `risk_band` non era un vocabolario: le fasce erano le tre soglie di
 *    `determineApprovalRoute`;
 *  - `service_criticality` viveva come `enum_values` **inline** sul campo
 *    `criticality` della BusinessApplication, con una copia in
 *    `lib/serviceVocabularies.ts` e una terza in `IMPACT_BY_CRITICALITY`;
 *  - `event_severity` era `EVENT_SEVERITIES`;
 *  - `import_severity` era le chiavi di `SEVERITY_MAP` nell'import dei ticket.
 *
 * Diventano vocabolari veri (`SYSTEM_ENUMS`), perché è la sola forma che il
 * cliente può rinominare: la sua copia omonima vince in lettura
 * (`lib/enumScope.ts`), e la matrice si aggiorna dalla pagina «Matrici di
 * dominio».
 *
 * ## Due semi corretti, e perché
 *
 * ### `service_impact`: le chiavi del nucleo non sono di nessun vocabolario
 * Il nucleo dichiara `{critical: high, high: high, medium: medium, low: low}`.
 * Ma le criticità che il prodotto spedisce sono `mission_critical`,
 * `business_critical`, `business_operational`, `office_productivity` — quelle
 * che `IMPACT_BY_CRITICALITY` traduceva — e `critical`/`high`/`medium`/`low`
 * non compaiono in nessun vocabolario di criticità. Seminare quelle chiavi
 * alla lettera darebbe una matrice con **quattro celle fuori vocabolario e
 * quattro combinazioni mancanti**: ogni incident di servizio fallirebbe il
 * primo giorno. Il seme scritto è quindi la tabella che il codice usava, cella
 * per cella.
 *
 * ## Un seme più ricco per l'import, e perché
 * Per quattro matrici su cinque il seme del nucleo è *esattamente* ciò che il
 * codice faceva. Per `import_severity` no: il nucleo dichiara 8 chiavi
 * (`critical, high, medium, low, blocker, major, minor, trivial`) mentre
 * l'import dei ticket risolveva **25** sinonimi (`p1`, `sev2`, `crit`,
 * `moderate`, `1`, …). Seminare solo le 8 farebbe diventare `P1` una riga in
 * errore **da domani**, e «il primo giorno non cambia niente» è la regola più
 * forte: il seme scritto è quindi l'unione, che sulle 8 chiavi comuni coincide
 * cella per cella col nucleo. Le altre 17 sono i sinonimi storici, ora
 * visibili e cancellabili dalla pagina invece che sepolti in un `Record` del
 * codice.
 */
import type { Queryable } from '@opengraphity/neo4j'
import {
  DOMAIN_MATRIX_KINDS, DOMAIN_MATRIX_SEEDS,
  type DomainMatrixEntries, type DomainMatrixKind,
} from './domainMatrix.js'

/**
 * I sinonimi che l'import dei ticket risolveva con `SEVERITY_MAP`
 * (`services/ticketImportService.ts`, prima dell'ondata 7). Le chiavi si
 * confrontano in minuscolo, come faceva quella mappa.
 */
export const IMPORT_SEVERITY_LEGACY_SYNONYMS: Readonly<Record<string, string>> = {
  l: 'low', p4: 'low', '4': 'low', sev4: 'low',
  med: 'medium', m: 'medium', moderate: 'medium', normal: 'medium', p3: 'medium', '3': 'medium', sev3: 'medium',
  h: 'high', p2: 'high', '2': 'high', sev2: 'high',
  crit: 'critical', urgent: 'critical', p1: 'critical', '1': 'critical', sev1: 'critical',
}

/**
 * Il contenuto con cui la matrice del cliente nasce. È il seme del nucleo,
 * più — per il solo `import_severity` — i sinonimi storici (vedi sopra).
 */
/**
 * La tabella `IMPACT_BY_CRITICALITY` che `services/serviceImpact/incident.ts`
 * aveva nel codice: i due livelli «critici» valgono impatto alto, gli altri
 * medio. Le chiavi sono i valori del vocabolario `service_criticality`.
 */
export const SERVICE_IMPACT_BY_CRITICALITY: Readonly<Record<string, string>> = {
  mission_critical:     'high',
  business_critical:    'high',
  business_operational: 'medium',
  office_productivity:  'medium',
}

export function domainMatrixSeedEntries(kind: DomainMatrixKind): DomainMatrixEntries {
  const core = DOMAIN_MATRIX_SEEDS[kind]
  // `service_impact` è stato corretto NEL NUCLEO (le chiavi sono i valori veri
  // del vocabolario): qui non serve più un'eccezione, e `SERVICE_IMPACT_BY_CRITICALITY`
  // resta come pin del contenuto atteso, verificato dal test.
  if (kind !== 'import_severity') return core
  return { ...IMPORT_SEVERITY_LEGACY_SYNONYMS, ...core }
}

/**
 * I valori del vocabolario `import_severity`: le chiavi che l'import dei
 * ticket sa risolvere. Sono le chiavi del seme della matrice, perché le due
 * cose sono la stessa: una severità in ingresso che il cliente non dichiara
 * nel vocabolario non la sa tradurre nessuno, e la riga va in errore.
 */
export const IMPORT_SEVERITY_VALUES: string[] = Object.keys(domainMatrixSeedEntries('import_severity'))

/** Le chiavi d'ingresso che il seme di una matrice usa (per il vocabolario). */
export function domainMatrixSeedInputValues(kind: DomainMatrixKind): readonly string[][] {
  const spec = DOMAIN_MATRIX_KINDS[kind]
  const cols: Array<Set<string>> = spec.inputs.map(() => new Set<string>())
  for (const key of Object.keys(domainMatrixSeedEntries(kind))) {
    const parts = key.split('|')
    parts.forEach((p, i) => cols[i]?.add(p))
  }
  return cols.map((s) => [...s])
}

/**
 * Scrive le matrici di un cliente **senza toccarne nessuna già salvata**: una
 * matrice modificata dall'admin è la sua scelta, e una migrazione che gira due
 * volte non deve riportarla al seme. Ritorna i tipi effettivamente creati.
 */
export async function seedDomainMatrices(session: Queryable, tenantId: string): Promise<DomainMatrixKind[]> {
  const created: DomainMatrixKind[] = []
  const now = new Date().toISOString()
  for (const kind of Object.keys(DOMAIN_MATRIX_KINDS) as DomainMatrixKind[]) {
    // `Queryable` (sessione **o** transazione): la chiamano l'onboarding e la
    // migrazione 20260917_1800, che riceve una transazione gestita.
    const r = await session.run(
      `MERGE (m:DomainMatrix {tenant_id: $tenantId, kind: $kind})
       ON CREATE SET m.entries = $entries, m.created_at = $now, m.updated_at = $now, m.seeded = true
       RETURN m.created_at = $now AS wasCreated`,
      { tenantId, kind, entries: JSON.stringify(domainMatrixSeedEntries(kind)), now },
    )
    if (r.records[0]?.get('wasCreated') === true) created.push(kind)
  }
  return created
}
