/**
 * Le matrici di dominio e il punto unico di validazione dei valori (ondata 7:
 * C-4 / C-7 / C-8 / A-13 / A-14 / B-14 / D-16).
 *
 * ## Il difetto
 * Le regole che traducono un valore di dominio in un altro erano scritte nel
 * codice: la matrice priorità = impatto × urgenza (`lib/priority.ts`), la
 * criticità del servizio → impatto (`IMPACT_BY_CRITICALITY`, quattro chiavi e
 * `?? 'medium'`), la severità dell'allarme → severità dell'incident, i pesi e
 * le soglie del rischio, la severità dell'import dei ticket, e quali stati del
 * ciclo di vita contano come «ritirato» o «in manutenzione». Il Dizionario
 * però **permette di rinominare quei valori** — è una decisione presa: il
 * cliente può chiamare `critical` → `p1` e `high` → `alto`.
 *
 * Conseguenza: il valore rinominato non sta in nessuna di quelle tabelle, e il
 * codice ripiegava su un default — `medium`, `normal` — **in silenzio**. Un
 * servizio critico diventava impatto medio; una change «major» veniva trattata
 * come normal; un CI «dismesso» con un nome nuovo continuava ad aprire
 * incident perché non risultava ritirato.
 *
 * ## La regola
 * Due cose distinte, e nessuna delle due è un default silenzioso:
 *
 *  1. **La validazione**: `assertDomainValue(tenantId, vocabolario, valore)`
 *     controlla il valore contro il vocabolario **del cliente** (gli enum, con
 *     la precedenza dell'ondata 1: il suo vince su quello di sistema). Un
 *     valore fuori vocabolario è un errore che elenca gli ammessi. È il punto
 *     unico: nessun consumatore deve più avere la sua lista.
 *  2. **La traduzione**: le matrici sono **dato del cliente**
 *     (`DomainMatrix {tenant_id, kind, entries}`), seminate esattamente con i
 *     valori che il codice usava finora — quindi il primo giorno non cambia
 *     niente — e modificabili dall'interfaccia. Una cella che manca è un
 *     errore che dice quale coppia manca, non un `medium`.
 *
 * ## Perché non un file di configurazione
 * Perché deve essere modificabile dal cliente senza codice e senza deploy, e
 * perché due clienti hanno matrici diverse: è dato per tenant, come le regole
 * di notifica e la policy degli allarmi.
 */
import { getSession } from '@opengraphity/neo4j'
import { ValidationError } from './errors.js'
import { registerMetamodelCacheClearer } from './schemaInvalidator.js'
import { loadTenantEnumOverrides } from './enumScope.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'domain-matrix' })

/**
 * Le matrici, in un vocabolario chiuso. Ogni voce esiste perché una regola di
 * dominio la usa; `inputs` sono i vocabolari delle dimensioni d'ingresso e
 * `output` quello del risultato — servono alla validazione e all'interfaccia,
 * che così sa quali tendine offrire.
 */
export const DOMAIN_MATRIX_KINDS = {
  /** Priorità del ticket = impatto × urgenza (ITIL). */
  priority:         { inputs: ['impact', 'urgency'], output: 'priority' },
  /** Criticità della business application → impatto dell'incident di servizio. */
  service_impact:   { inputs: ['service_criticality'], output: 'impact' },
  /** Severità dell'allarme → severità dell'incident aperto dal monitoraggio. */
  event_severity:   { inputs: ['event_severity'], output: 'severity' },
  /**
   * Tipo di change × fascia di rischio → priorità (la decisione del prodotto:
   * NON Impatto×Urgenza, che vale per incident e problem).
   */
  change_priority:  { inputs: ['change_type', 'risk_band'], output: 'priority' },
  /**
   * Tipo di change → priorità quando il rischio **non è ancora stato
   * valutato** (prima dell'assessment). È una regola distinta, non la fascia
   * più bassa: «rischio non valutato» e «rischio basso» sono due cose
   * diverse, e il codice che questa matrice sostituisce le teneva separate —
   * una change `normal` appena creata era `medium`, una con rischio basso
   * misurato era `low`. Collassarle cambierebbe la priorità di ogni change a
   * rischio basso.
   */
  change_priority_initial: { inputs: ['change_type'], output: 'priority' },
  /** Severità in ingresso dall'import dei ticket → severità del tenant. */
  import_severity:  { inputs: ['import_severity'], output: 'severity' },
} as const

export type DomainMatrixKind = keyof typeof DOMAIN_MATRIX_KINDS

export function isDomainMatrixKind(v: unknown): v is DomainMatrixKind {
  return typeof v === 'string' && v in DOMAIN_MATRIX_KINDS
}

/**
 * Una matrice: dalla chiave d'ingresso al valore d'uscita. Le dimensioni
 * multiple si compongono con `|` nell'ordine di `inputs`, così una matrice a
 * due dimensioni resta una mappa piatta (facile da leggere, da salvare come
 * JSON e da mostrare come tabella).
 */
export type DomainMatrixEntries = Readonly<Record<string, string>>

export interface DomainMatrix {
  kind:      DomainMatrixKind
  entries:   DomainMatrixEntries
  /** `true` quando è il seme del prodotto e il cliente non l'ha mai toccata. */
  isDefault: boolean
  updatedAt: string | null
}

/** La chiave di una cella: i valori delle dimensioni nell'ordine di `inputs`. */
export function matrixKey(...values: readonly string[]): string {
  return values.join('|')
}

// ── Semi: esattamente ciò che il codice faceva finora ────────────────────────

/**
 * I semi NON sono «valori di default a cui ripiegare»: sono il contenuto con
 * cui la matrice del cliente nasce, una volta, così il comportamento del primo
 * giorno è identico a prima. Dopo, comanda il dato.
 */
export const DOMAIN_MATRIX_SEEDS: Readonly<Record<DomainMatrixKind, DomainMatrixEntries>> = {
  priority: {
    'high|high':     'critical', 'high|medium':   'high',   'high|low':   'medium',
    'medium|high':   'high',     'medium|medium': 'medium', 'medium|low': 'low',
    'low|high':      'medium',   'low|medium':    'low',    'low|low':    'low',
  },
  /**
   * Le chiavi sono i valori veri del vocabolario `service_criticality`
   * (`mission_critical`, `business_critical`, `business_operational`,
   * `office_productivity`), e i valori sono quelli che
   * `IMPACT_BY_CRITICALITY` traduceva in `serviceImpact/incident.ts`: i due
   * livelli «critici» valgono impatto alto, gli altri medio.
   *
   * Questo seme era stato scritto con le chiavi `critical/high/medium/low`,
   * che NON appartengono a nessun vocabolario di criticità: sarebbero state
   * quattro celle fuori vocabolario e quattro combinazioni mancanti, cioè
   * ogni incident di servizio senza impatto dal primo giorno. È il motivo per
   * cui un seme si copia dal codice che sostituisce, non dal buon senso.
   */
  service_impact: {
    mission_critical: 'high', business_critical: 'high',
    business_operational: 'medium', office_productivity: 'medium',
  },
  event_severity: {
    critical: 'critical', warning: 'medium', info: 'low',
  },
  /**
   * Trascritta da `deriveChangePriority` (`resolvers/change/scoring.ts`) prima
   * dell'ondata 7, cella per cella: `emergency` → `critical` solo con rischio
   * alto, altrimenti `high`; `standard` → `medium` solo con rischio alto,
   * altrimenti `low`; `normal` → la fascia stessa.
   *
   * Due celle di questo seme erano state scritte a intuito invece che
   * trascritte (`emergency|medium` come `critical` e `normal|low` come
   * `medium`): avrebbero cambiato in silenzio la priorità di change reali. Un
   * seme si copia dal codice che sostituisce.
   */
  change_priority: {
    'emergency|high': 'critical', 'emergency|medium': 'high',   'emergency|low': 'high',
    'normal|high':    'high',     'normal|medium':    'medium', 'normal|low':    'low',
    'standard|high':  'medium',   'standard|medium':  'low',    'standard|low':  'low',
  },
  /** Rischio non ancora valutato: la priorità di creazione di prima. */
  change_priority_initial: {
    emergency: 'high', normal: 'medium', standard: 'low',
  },
  import_severity: {
    critical: 'critical', high: 'high', medium: 'medium', low: 'low',
    blocker: 'critical', major: 'high', minor: 'low', trivial: 'low',
  },
}

// ── Lettura ──────────────────────────────────────────────────────────────────

const cache = new Map<string, Promise<DomainMatrix>>()

registerMetamodelCacheClearer('domain-matrix', (tenantId: string) => {
  for (const key of [...cache.keys()]) if (key.startsWith(`${tenantId}::`)) cache.delete(key)
})

/** Svuota la cache di una matrice (la chiama la mutation che la salva). */
export function invalidateDomainMatrix(tenantId: string, kind?: DomainMatrixKind): void {
  if (kind) { cache.delete(`${tenantId}::${kind}`); return }
  for (const key of [...cache.keys()]) if (key.startsWith(`${tenantId}::`)) cache.delete(key)
}

export async function loadDomainMatrix(tenantId: string, kind: DomainMatrixKind): Promise<DomainMatrix> {
  const cacheKey = `${tenantId}::${kind}`
  const hit = cache.get(cacheKey)
  if (hit) return hit

  const load = (async (): Promise<DomainMatrix> => {
    const session = getSession()
    try {
      const r = await session.executeRead((tx) =>
        tx.run(
          `MATCH (m:DomainMatrix {tenant_id: $tenantId, kind: $kind})
           RETURN m.entries AS entries, m.updated_at AS updatedAt`,
          { tenantId, kind },
        ),
      )
      if (!r.records.length) {
        // Nessuna matrice salvata: il cliente non l'ha mai toccata e la
        // migrazione non è ancora passata. Si usa il seme, e si DICE quale
        // caso è: non è un ripiego su un valore inventato, è il contenuto di
        // fabbrica dichiarato.
        return { kind, entries: DOMAIN_MATRIX_SEEDS[kind], isDefault: true, updatedAt: null }
      }
      const raw = r.records[0].get('entries')
      const entries = parseEntries(raw, kind)
      return { kind, entries, isDefault: false, updatedAt: (r.records[0].get('updatedAt') as string | null) ?? null }
    } finally {
      await session.close()
    }
  })().catch((err: unknown) => {
    cache.delete(cacheKey)
    log.error({ tenantId, kind, err }, 'Matrice di dominio non leggibile')
    throw err
  })

  cache.set(cacheKey, load)
  return load
}

function parseEntries(raw: unknown, kind: DomainMatrixKind): DomainMatrixEntries {
  if (raw == null) throw new Error(`Matrice "${kind}": nodo senza \`entries\``)
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) }
    catch (e) { throw new Error(`Matrice "${kind}": \`entries\` non è JSON valido (${e instanceof Error ? e.message : String(e)})`) }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Matrice "${kind}": \`entries\` deve essere un oggetto chiave → valore`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`Matrice "${kind}": la cella "${k}" non è una stringa (${typeof v})`)
    out[k] = v
  }
  return out
}

/**
 * Traduce una combinazione d'ingresso nel valore d'uscita. **Fail-loud**: una
 * cella che manca è un errore che nomina la matrice, la combinazione e come
 * rimediare — mai un `medium` silenzioso, che è il difetto che chiudiamo.
 */
export async function resolveDomainMatrix(
  tenantId: string, kind: DomainMatrixKind, ...values: readonly string[]
): Promise<string> {
  const spec = DOMAIN_MATRIX_KINDS[kind]
  if (values.length !== spec.inputs.length) {
    throw new Error(`Matrice "${kind}": attesi ${spec.inputs.length} valori (${spec.inputs.join(', ')}), ricevuti ${values.length}`)
  }
  const matrix = await loadDomainMatrix(tenantId, kind)
  const key = matrixKey(...values)
  const out = matrix.entries[key]
  if (out === undefined) {
    throw new ValidationError(
      `Matrice "${kind}" del cliente ${tenantId}: nessun valore per ${spec.inputs.map((i, n) => `${i}="${values[n]}"`).join(', ')}. ` +
      `Completa la matrice in Impostazioni → Matrici di dominio` +
      (matrix.isDefault ? ' (ora è quella di fabbrica: è possibile che tu abbia rinominato un valore del vocabolario senza aggiornarla).' : '.'),
    )
  }
  return out
}

// ── Il punto unico di validazione di un valore di dominio ────────────────────

/**
 * Il valore appartiene al vocabolario del cliente?
 *
 * Sostituisce le liste sparse (`isImpactUrgency`, `['standard','normal',
 * 'emergency'].includes`, `SEVERITY_MAP`, le copie di `SERVICE_CRITICALITIES`):
 * il vocabolario è quello del tenant, che può averlo rinominato.
 *
 * `null`/`undefined` **non** sono validi: chi accetta un valore assente deve
 * dirlo prima, non passare qui.
 */
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

/** Come `assertDomainValue` ma senza lanciare: per i rami che devono decidere. */
export async function isDomainValue(tenantId: string, vocabulary: string, value: unknown): Promise<boolean> {
  if (typeof value !== 'string' || value === '') return false
  return (await domainVocabulary(tenantId, vocabulary)).includes(value)
}

const vocabCache = new Map<string, Promise<readonly string[]>>()

registerMetamodelCacheClearer('domain-vocabulary', (tenantId: string) => {
  for (const key of [...vocabCache.keys()]) if (key.startsWith(`${tenantId}::`)) vocabCache.delete(key)
})

/**
 * I valori del vocabolario per questo cliente: il suo enum omonimo se esiste
 * (precedenza dell'ondata 1), altrimenti quello di sistema. Un vocabolario che
 * non esiste da nessuna parte è un errore: significa che il codice sta
 * chiedendo un nome sbagliato, e un elenco vuoto lo nasconderebbe.
 */
export async function domainVocabulary(tenantId: string, vocabulary: string): Promise<readonly string[]> {
  const cacheKey = `${tenantId}::${vocabulary}`
  const hit = vocabCache.get(cacheKey)
  if (hit) return hit

  const load = (async (): Promise<readonly string[]> => {
    const session = getSession()
    try {
      const own = await loadTenantEnumOverrides(session, tenantId)
      const mine = own.get(vocabulary)
      if (mine) return mine.values
      const r = await session.executeRead((tx) =>
        tx.run(
          `MATCH (e:EnumTypeDefinition {tenant_id: 'system', name: $name}) RETURN e.values AS values`,
          { name: vocabulary },
        ),
      )
      if (!r.records.length) {
        throw new Error(
          `Vocabolario "${vocabulary}" inesistente (né del cliente ${tenantId} né di sistema): ` +
          `il codice sta chiedendo un nome che il Dizionario non ha.`,
        )
      }
      const raw = r.records[0].get('values')
      const values = Array.isArray(raw) ? raw as string[] : JSON.parse(String(raw)) as string[]
      return values
    } finally {
      await session.close()
    }
  })().catch((err: unknown) => {
    vocabCache.delete(cacheKey)
    throw err
  })

  vocabCache.set(cacheKey, load)
  return load
}

/** Solo per i test. */
export function clearDomainCaches(): void {
  cache.clear()
  vocabCache.clear()
}
