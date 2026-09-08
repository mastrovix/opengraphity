/**
 * Normalizzazione valori/chiavi per i connettori di discovery.
 *
 * UNICO modulo per `toSnake` / `toNum` / `toBool` / `splitList` nell'area
 * discovery: i connettori (cloud, json, csv) normalizzano A MONTE, perché la
 * riconciliazione rifiuta (fail-loud) ogni chiave di proprietà che non rispetta
 * `FIELD_NAME_RE` (`^[a-z][a-z0-9_]*$`, lib/cypherIdentifiers.ts).
 *
 * Regola "niente fallback silenziosi": i convertitori restituiscono
 * `undefined` SOLO per "valore assente" (null/undefined/stringa vuota) e
 * lanciano `NormalizeError` per un valore presente ma non convertibile.
 */

import { FIELD_NAME_RE } from '../../lib/cypherIdentifiers.js'

export class NormalizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NormalizeError'
  }
}

function preview(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s === undefined ? String(value) : s.length > 60 ? `${s.slice(0, 60)}…` : s
}

/** Prefisso applicato quando la chiave normalizzata inizierebbe con una cifra. */
export const DIGIT_PREFIX = 'f_'

/**
 * Converte una chiave arbitraria (tag cloud, header CSV, chiave JSON) in un
 * identificatore snake_case conforme a FIELD_NAME_RE.
 *
 *   "Cost Center"      → "cost_center"
 *   "costCenter"       → "cost_center"
 *   "app.kubernetes.io/name" → "app_kubernetes_io_name"
 *   "HTTPServer"       → "http_server"
 *   "2ndOwner"         → "f_2nd_owner"   (una chiave non può iniziare con cifra)
 *
 * Lancia NormalizeError se la chiave non contiene alcun carattere alfanumerico
 * (es. "###" o stringa vuota): non esiste un nome sensato da derivare.
 */
export function toSnake(key: string): string {
  if (typeof key !== 'string') throw new NormalizeError(`toSnake: la chiave deve essere una stringa, ricevuto ${preview(key)}`)
  const snake = key
    .trim()
    // camelCase / PascalCase → separatore
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    // acronimi seguiti da parola: "HTTPServer" → "HTTP_Server"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    // tutto ciò che non è alfanumerico → "_"
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (snake === '') {
    throw new NormalizeError(`toSnake: impossibile derivare un nome da ${JSON.stringify(preview(key))}`)
  }
  const result = /^[0-9]/.test(snake) ? `${DIGIT_PREFIX}${snake}` : snake
  if (!FIELD_NAME_RE.test(result)) {
    // Non dovrebbe accadere: la pipeline sopra produce solo [a-z0-9_]. Difesa
    // contro regressioni della regex condivisa.
    throw new NormalizeError(`toSnake: ${JSON.stringify(result)} non rispetta ${FIELD_NAME_RE.source}`)
  }
  return result
}

/**
 * Applica `toSnake` a tutte le chiavi di un oggetto. Due chiavi sorgente
 * diverse che collassano sulla stessa chiave normalizzata ("Cost Center" e
 * "costCenter") sono un errore: sovrascrivere in silenzio perderebbe dati.
 * `what` identifica la sorgente nel messaggio (es. "csv row 3").
 */
export function normalizeKeys<V>(obj: Record<string, V>, what: string): Record<string, V> {
  const out: Record<string, V> = {}
  const origin: Record<string, string> = {}
  for (const [rawKey, value] of Object.entries(obj)) {
    let key: string
    try {
      key = toSnake(rawKey)
    } catch (err) {
      throw new NormalizeError(`${what}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const prev = origin[key]
    if (prev !== undefined && prev !== rawKey) {
      throw new NormalizeError(
        `${what}: le chiavi ${JSON.stringify(prev)} e ${JSON.stringify(rawKey)} collidono su "${key}" dopo la normalizzazione`,
      )
    }
    origin[key] = rawKey
    out[key] = value
  }
  return out
}

const NUMERIC_STRING_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/**
 * Numero da: number finito, bigint, Integer di neo4j (`{ toNumber() }`),
 * stringa numerica. Assente (null/undefined/"") → undefined. Altro → errore.
 */
export function toNum(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NormalizeError(`toNum: valore non finito ${String(value)}`)
    return value
  }
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const s = value.trim()
    if (s === '') return undefined
    if (!NUMERIC_STRING_RE.test(s)) throw new NormalizeError(`toNum: stringa non numerica ${JSON.stringify(preview(value))}`)
    return Number(s)
  }
  if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber(): number }).toNumber()
  }
  throw new NormalizeError(`toNum: tipo non convertibile (${typeof value}) ${preview(value)}`)
}

/**
 * Booleano da: boolean, "true"/"false" (case-insensitive, spazi ignorati).
 * Assente (null/undefined/"") → undefined. Altro → errore (niente "1"/"yes"
 * accettati in silenzio: se serve, il chiamante mappa esplicitamente).
 */
export function toBool(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === '') return undefined
    if (s === 'true') return true
    if (s === 'false') return false
  }
  throw new NormalizeError(`toBool: valore non booleano ${JSON.stringify(preview(value))}`)
}

/**
 * Lista di stringhe da: array di stringhe o stringa separata da virgole.
 * Voci vuote scartate, spazi rimossi. Assente → [].
 * Usata per `regions`, `resource_types`, `namespaces`, `project_ids`, ...
 */
export function splitList(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      if (typeof v !== 'string') throw new NormalizeError(`splitList: elemento ${i} non è una stringa (${typeof v})`)
      return v.trim()
    }).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value.split(',').map(s => s.trim()).filter(Boolean)
  }
  throw new NormalizeError(`splitList: atteso array o stringa, ricevuto ${typeof value}`)
}
