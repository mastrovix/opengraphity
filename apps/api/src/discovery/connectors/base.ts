/**
 * Base condivisa dei connettori di discovery (aws, azure, gcp, kubernetes,
 * json, csv). Assorbe il codice che era duplicato verbatim in ogni connettore:
 *
 *  - gestione errori uniforme: `withConnectorErrors` / `guardScan` arricchiscono
 *    il messaggio con connettore + operazione e RILANCIANO (mai inghiottono);
 *  - paginazione a token (`paginate`) per gli SDK stile AWS;
 *  - tag/label → `Record<string,string>` (`tagsToRecord`), chiavi lasciate
 *    grezze perché le mapping rule le cercano per nome originale;
 *  - parsing di `resource_types` con validazione (un tipo sconosciuto è un
 *    errore, non "zero risorse scansionate");
 *  - credenziali/config obbligatorie con errore esplicito invece di `!`.
 *
 * L'interfaccia `Connector` di @opengraphity/discovery NON cambia: qui ci sono
 * solo funzioni di supporto usate dentro le implementazioni.
 */

import type { ConfigFieldDefinition } from '@opengraphity/discovery'
import { splitList } from './normalize.js'

// ── Errori ────────────────────────────────────────────────────────────────────

export class ConnectorError extends Error {
  readonly connector: string
  readonly operation: string
  constructor(connector: string, operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`[${connector}] ${operation} failed: ${detail}`, { cause })
    this.name = 'ConnectorError'
    this.connector = connector
    this.operation = operation
  }
}

/**
 * Costruisce l'errore arricchito. Un ConnectorError già formato (sollevato da
 * un'operazione interna) viene restituito com'è: niente doppio wrapping
 * "[aws] ELB scan failed: [aws] target health failed: …".
 */
export function connectorError(connector: string, operation: string, err: unknown): Error {
  if (err instanceof ConnectorError) return err
  return new ConnectorError(connector, operation, err)
}

/** Esegue `fn` e rilancia ogni errore come ConnectorError (mai inghiottito). */
export async function withConnectorErrors<T>(connector: string, operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw connectorError(connector, operation, err)
  }
}

/**
 * Variante per generatori asincroni: `yield* guardScan('aws', 'EC2 scan', async function* () { … })`.
 * Gli errori sollevati dal produttore vengono arricchiti e rilanciati.
 */
export async function* guardScan<T>(
  connector: string,
  operation: string,
  produce:   () => AsyncIterable<T>,
): AsyncIterable<T> {
  try {
    yield* produce()
  } catch (err) {
    throw connectorError(connector, operation, err)
  }
}

/** True se `err` è un Error con uno dei nomi indicati (es. "ResourceNotFoundException"). */
export function errorNamed(err: unknown, ...names: string[]): boolean {
  return err instanceof Error && names.includes(err.name)
}

/** Codice HTTP di un errore SDK (`statusCode` o `status`), se presente. */
export function errorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as { statusCode?: unknown; status?: unknown }
  const code = e.statusCode ?? e.status
  return typeof code === 'number' ? code : undefined
}

// ── Config / credenziali ──────────────────────────────────────────────────────

/**
 * Set dei resource type da scansionare. Vuoto/assente → tutti. Un tipo non
 * presente in `all` è un errore di configurazione (fail-loud: prima un typo
 * come "ec3" scansionava silenziosamente zero risorse).
 */
export function resourceTypeSet(connector: string, raw: unknown, all: readonly string[]): Set<string> {
  const requested = splitList(raw)
  if (requested.length === 0) return new Set(all)
  const unknown = requested.filter(t => !all.includes(t))
  if (unknown.length) {
    throw new ConnectorError(connector, 'config',
      new Error(`resource_types sconosciuti: ${unknown.join(', ')} (ammessi: ${all.join(', ')})`))
  }
  return new Set(requested)
}

/** Ritorna le credenziali richieste, con errore esplicito se una manca o è vuota. */
export function requireCreds(
  connector: string,
  creds:     Record<string, string>,
  required:  readonly string[],
): Record<string, string> {
  const missing = required.filter(k => !creds[k] || creds[k]!.trim() === '')
  if (missing.length) {
    throw new ConnectorError(connector, 'credentials', new Error(`credenziali mancanti: ${missing.join(', ')}`))
  }
  return creds
}

/** Valore stringa obbligatorio dalla config della sorgente. */
export function requireConfigString(connector: string, cfg: Record<string, unknown>, key: string): string {
  const v = cfg[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ConnectorError(connector, 'config', new Error(`campo di configurazione obbligatorio mancante: ${key}`))
  }
  return v.trim()
}

/** Campo `resource_types` per `getConfigFields()`, identico in ogni connettore cloud. */
export function resourceTypesField(all: readonly string[]): ConfigFieldDefinition {
  return {
    name:          'resource_types',
    label:         'Resource Types',
    type:          'text',
    required:      false,
    default_value: all.join(', '),
    help_text:     `Comma-separated: ${all.join(', ')} (leave empty for all)`,
  }
}

// ── Tag ───────────────────────────────────────────────────────────────────────

type TagPair = { Key?: string | null; Value?: string | null }

/**
 * Tag/label del provider → `Record<string,string>`. Accetta la forma AWS
 * (`[{Key, Value}]`) e la forma mappa (Azure/GCP/K8s). Le voci senza chiave o
 * senza valore stringa sono scartate. Le chiavi restano GREZZE: le mapping
 * rule (`applyMappingRules`) le cercano per `source_field` originale.
 */
export function tagsToRecord(
  tags: Iterable<TagPair> | Record<string, string | null | undefined> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!tags) return out
  if (typeof (tags as Iterable<TagPair>)[Symbol.iterator] === 'function') {
    for (const t of tags as Iterable<TagPair>) {
      if (t.Key && typeof t.Value === 'string') out[t.Key] = t.Value
    }
    return out
  }
  for (const [k, v] of Object.entries(tags as Record<string, string | null | undefined>)) {
    if (k && typeof v === 'string') out[k] = v
  }
  return out
}

// ── Paginazione ───────────────────────────────────────────────────────────────

/**
 * Itera le pagine di un'API a token: `fetchPage(token)` restituisce la pagina,
 * `nextToken(page)` il token della successiva (undefined/"" = fine).
 * Un'API che restituisce due volte lo stesso token è un loop infinito: errore.
 */
export async function* paginate<P>(
  fetchPage: (token: string | undefined) => Promise<P>,
  nextToken: (page: P) => string | undefined | null,
): AsyncIterable<P> {
  let token: string | undefined
  const seen = new Set<string>()
  do {
    const page = await fetchPage(token)
    yield page
    const next = nextToken(page) ?? undefined
    if (next !== undefined && next !== '') {
      if (seen.has(next)) throw new Error(`paginate: token ripetuto (${next.slice(0, 20)}…) — loop di paginazione`)
      seen.add(next)
      token = next
    } else {
      token = undefined
    }
  } while (token !== undefined)
}

// ── testConnection ────────────────────────────────────────────────────────────

/**
 * `testConnection` non deve lanciare: converte l'eccezione in `{ ok:false }`
 * con messaggio uniforme. `probe` restituisce il messaggio di successo.
 */
export async function probeConnection(
  displayName: string,
  probe:       () => Promise<string>,
): Promise<{ ok: boolean; message: string }> {
  try {
    return { ok: true, message: await probe() }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `${displayName} connection failed: ${msg}` }
  }
}
