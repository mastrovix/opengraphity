/**
 * Il doppio di `lib/domainMatrix.ts` per i test che NON parlano di matrici.
 *
 * ## Perché esiste
 * Dall'ondata 7 la traduzione fra valori di dominio è una **lettura**: la
 * matrice è dato del cliente. Quindi `createIncident`, `createChangeRFC`,
 * l'apertura dell'incident da un allarme e l'import dei ticket toccano il
 * grafo anche per la priorità. I loro test mockano `@opengraphity/neo4j` con
 * una sessione finta che risponde solo alle query che LORO misurano: far
 * passare anche la matrice da lì vorrebbe dire insegnare a ognuna di quelle
 * sessioni finte due query in più, e i test diventerebbero un elenco di
 * risposte invece della cosa che misurano.
 *
 * Questo modulo si sostituisce a `lib/domainMatrix.js` e risponde **con la
 * matrice di fabbrica e i vocabolari spediti**, senza grafo:
 *
 *     vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))
 *
 * Il fail-loud resta: un valore fuori vocabolario e una cella mancante
 * lanciano, con gli stessi messaggi del vero. Un test che vuole misurare il
 * comportamento della matrice del CLIENTE non usa questo doppio: mocka
 * `@opengraphity/neo4j` e `enumScope` come fa `domainMatrix.test.ts`.
 *
 * I dati sono ricopiati a mano (questo modulo non può importare quello che
 * sostituisce: il mock è globale nel grafo del test). `domainMatrixFake.test.ts`
 * li confronta con le fonti vere, quindi non possono divergere in silenzio.
 */
import { ValidationError } from '../errors.js'

export const DOMAIN_MATRIX_KINDS = {
  priority:         { inputs: ['impact', 'urgency'], output: 'priority' },
  service_impact:   { inputs: ['service_criticality'], output: 'impact' },
  event_severity:   { inputs: ['event_severity'], output: 'severity' },
  change_priority:  { inputs: ['change_type', 'risk_band'], output: 'priority' },
  change_priority_initial: { inputs: ['change_type'], output: 'priority' },
  import_severity:  { inputs: ['import_severity'], output: 'severity' },
} as const

export type DomainMatrixKind = keyof typeof DOMAIN_MATRIX_KINDS
export type DomainMatrixEntries = Readonly<Record<string, string>>

export interface DomainMatrix {
  kind:      DomainMatrixKind
  entries:   DomainMatrixEntries
  isDefault: boolean
  updatedAt: string | null
}

export function isDomainMatrixKind(v: unknown): v is DomainMatrixKind {
  return typeof v === 'string' && v in DOMAIN_MATRIX_KINDS
}

export function matrixKey(...values: readonly string[]): string { return values.join('|') }

/** Come `DOMAIN_MATRIX_SEEDS` più le correzioni di `lib/domainMatrixSeed.ts`. */
export const FAKE_ENTRIES: Readonly<Record<DomainMatrixKind, DomainMatrixEntries>> = {
  priority: {
    'high|high':     'critical', 'high|medium':   'high',   'high|low':   'medium',
    'medium|high':   'high',     'medium|medium': 'medium', 'medium|low': 'low',
    'low|high':      'medium',   'low|medium':    'low',    'low|low':    'low',
  },
  service_impact: {
    mission_critical: 'high', business_critical: 'high',
    business_operational: 'medium', office_productivity: 'medium',
  },
  event_severity: { critical: 'critical', warning: 'medium', info: 'low' },
  change_priority: {
    'emergency|high': 'critical', 'emergency|medium': 'high',   'emergency|low': 'high',
    'normal|high':    'high',     'normal|medium':    'medium', 'normal|low':    'low',
    'standard|high':  'medium',   'standard|medium':  'low',    'standard|low':  'low',
  },
  change_priority_initial: { emergency: 'high', normal: 'medium', standard: 'low' },
  // Stesso ORDINE di `domainMatrixSeedEntries('import_severity')` (sinonimi
  // storici, poi il seme del nucleo): l'ordine è il vocabolario, e il test di
  // coerenza lo confronta con `SYSTEM_ENUMS.import_severity`.
  import_severity: {
    l: 'low', p4: 'low', '4': 'low', sev4: 'low',
    med: 'medium', m: 'medium', moderate: 'medium', normal: 'medium', p3: 'medium', '3': 'medium', sev3: 'medium',
    h: 'high', p2: 'high', '2': 'high', sev2: 'high',
    crit: 'critical', urgent: 'critical', p1: 'critical', '1': 'critical', sev1: 'critical',
    critical: 'critical', high: 'high', medium: 'medium', low: 'low',
    blocker: 'critical', major: 'high', minor: 'low', trivial: 'low',
  },
}

/** I vocabolari spediti che le matrici usano (`SYSTEM_ENUMS`). */
export const FAKE_VOCABULARIES: Readonly<Record<string, readonly string[]>> = {
  impact:              ['low', 'medium', 'high'],
  urgency:             ['low', 'medium', 'high'],
  priority:            ['low', 'medium', 'high', 'critical'],
  severity:            ['low', 'medium', 'high', 'critical'],
  risk_band:           ['low', 'medium', 'high'],
  change_type:         ['standard', 'normal', 'emergency'],
  event_severity:      ['info', 'warning', 'critical'],
  service_criticality: ['mission_critical', 'business_critical', 'business_operational', 'office_productivity'],
  import_severity:     Object.keys(FAKE_ENTRIES.import_severity),
  ci_status:           ['active', 'inactive', 'maintenance', 'decommissioned', 'expired', 'revoked'],
}

export function loadDomainMatrix(_tenantId: string, kind: DomainMatrixKind): Promise<DomainMatrix> {
  return Promise.resolve({ kind, entries: FAKE_ENTRIES[kind], isDefault: true, updatedAt: null })
}

export function resolveDomainMatrix(
  tenantId: string, kind: DomainMatrixKind, ...values: readonly string[]
): Promise<string> {
  const spec = DOMAIN_MATRIX_KINDS[kind]
  if (values.length !== spec.inputs.length) {
    return Promise.reject(new Error(`Matrice "${kind}": attesi ${spec.inputs.length} valori (${spec.inputs.join(', ')}), ricevuti ${values.length}`))
  }
  const out = FAKE_ENTRIES[kind][matrixKey(...values)]
  if (out === undefined) {
    return Promise.reject(new ValidationError(
      `Matrice "${kind}" del cliente ${tenantId}: nessun valore per ${spec.inputs.map((i, n) => `${i}="${values[n]}"`).join(', ')}. ` +
      `Completa la matrice in Impostazioni → Matrici di dominio (ora è quella di fabbrica: è possibile che tu abbia rinominato un valore del vocabolario senza aggiornarla).`,
    ))
  }
  return Promise.resolve(out)
}

export function domainVocabulary(tenantId: string, vocabulary: string): Promise<readonly string[]> {
  const values = FAKE_VOCABULARIES[vocabulary]
  if (!values) {
    return Promise.reject(new Error(
      `Vocabolario "${vocabulary}" inesistente (né del cliente ${tenantId} né di sistema): ` +
      `il codice sta chiedendo un nome che il Dizionario non ha.`,
    ))
  }
  return Promise.resolve(values)
}

export async function assertDomainValue(tenantId: string, vocabulary: string, value: unknown): Promise<string> {
  const allowed = await domainVocabulary(tenantId, vocabulary)
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError(`${vocabulary}: valore assente o non testuale (${JSON.stringify(value ?? null)}). Ammessi: ${allowed.join(', ')}.`)
  }
  if (!allowed.includes(value)) {
    throw new ValidationError(`${vocabulary}: "${value}" non è nel vocabolario di questo cliente. Ammessi: ${allowed.join(', ')}.`)
  }
  return value
}

export async function isDomainValue(tenantId: string, vocabulary: string, value: unknown): Promise<boolean> {
  if (typeof value !== 'string' || value === '') return false
  return (await domainVocabulary(tenantId, vocabulary)).includes(value)
}

export const DOMAIN_MATRIX_SEEDS = FAKE_ENTRIES
export function invalidateDomainMatrix(): void { /* niente cache nel doppio */ }
export function clearDomainCaches(): void { /* niente cache nel doppio */ }
