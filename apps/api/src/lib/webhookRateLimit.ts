/**
 * Rate limit per sorgente del webhook in ingresso (M7), condiviso fra le
 * repliche tramite Redis (`getSharedRedis`).
 *
 * Scelta: finestra FISSA al minuto — chiave
 * `og:webhook:rate:<tenant>:<webhookId>:<minutoEpoch>`, INCR + EXPIRE in un
 * unico script Lua (atomico: nessuna chiave che resta senza TTL se il processo
 * muore fra i due comandi). Rispetto a una finestra scorrevole costa un solo
 * round trip e nessuna struttura ordinata; il prezzo è che a cavallo di due
 * minuti una sorgente può passare fino a 2× il limite in 60 s reali, il che
 * per allarmi di monitoraggio (già deduplicati a valle) è accettabile. Stessa
 * chiave-per-minuto del contatore di tempesta (services/eventStorm.ts).
 *
 * `Retry-After` = secondi che mancano alla fine del minuto corrente (almeno 1):
 * Alertmanager/Grafana leggono l'header, non il corpo JSON.
 *
 * Niente fallback silenziosi: Redis irraggiungibile → l'errore propaga e il
 * webhook risponde 500 (il mittente ritenta), MAI "limite disattivato".
 */
import { getSharedRedis } from './bullmq.js'
import { ValidationError } from './errors.js'

/**
 * Limite usato quando la sorgente non ha `rate_limit_per_minute` (webhook
 * creati prima del campo). È l'UNICO default ammesso qui: documentato anche
 * nell'SDL (`InboundWebhook.rateLimitPerMinute`) e in docs/API.md.
 */
export const DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE = 100
export const WEBHOOK_RATE_LIMIT_MIN = 1
export const WEBHOOK_RATE_LIMIT_MAX = 10_000

/** TTL della chiave-minuto: il doppio della finestra, così sopravvive a un piccolo sfasamento di orologio fra repliche. */
export const WEBHOOK_RATE_KEY_TTL_SECONDS = 120

/** INCR + EXPIRE atomici: il TTL viene impostato solo alla prima richiesta del minuto. */
export const WEBHOOK_RATE_LUA = `local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c`

/**
 * Valida un limite proposto (input GraphQL o valore letto dal grafo).
 * `what` finisce nel messaggio (es. "rateLimitPerMinute").
 */
export function validateRateLimitPerMinute(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < WEBHOOK_RATE_LIMIT_MIN || value > WEBHOOK_RATE_LIMIT_MAX) {
    throw new ValidationError(`${what} must be an integer in ${WEBHOOK_RATE_LIMIT_MIN}..${WEBHOOK_RATE_LIMIT_MAX} (got ${JSON.stringify(value ?? null)})`)
  }
  return value
}

/**
 * Limite effettivo di un InboundWebhook dalle sue proprietà: assente/null →
 * default documentato; presente ma non valido → errore di configurazione
 * (ValidationError → 400 sul webhook, come per un field_mapping corrotto).
 * Gli interi Neo4j arrivano già come number (`runQuery` li converte).
 */
export function rateLimitOf(props: Record<string, unknown>): number {
  const raw = props['rate_limit_per_minute']
  if (raw === undefined || raw === null) return DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE
  return validateRateLimitPerMinute(raw, 'rate_limit_per_minute')
}

export function webhookRateKey(tenantId: string, webhookId: string, atMs: number): string {
  return `og:webhook:rate:${tenantId}:${webhookId}:${Math.floor(atMs / 60_000)}`
}

/** Secondi alla fine del minuto corrente, mai meno di 1. */
export function secondsToWindowEnd(atMs: number): number {
  return Math.max(1, Math.ceil((60_000 - (atMs % 60_000)) / 1000))
}

export interface RateDecision {
  allowed: boolean
  /** Richieste contate in questo minuto, compresa quella corrente. */
  count: number
  limit: number
  /** Valore per l'header `Retry-After` (secondi alla fine della finestra). */
  retryAfterSeconds: number
}

/**
 * Conta la richiesta corrente nel minuto di (tenant, webhook) e dice se è
 * entro `limit`. Va chiamata DOPO l'autenticazione: solo il traffico
 * legittimo consuma il bucket (A-20).
 */
export async function consumeWebhookRate(tenantId: string, webhookId: string, limit: number, atMs = Date.now()): Promise<RateDecision> {
  const raw = await getSharedRedis().eval(WEBHOOK_RATE_LUA, 1, webhookRateKey(tenantId, webhookId, atMs), WEBHOOK_RATE_KEY_TTL_SECONDS)
  const count = Number(raw)
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`webhook rate limit: unexpected INCR reply ${JSON.stringify(raw)} for ${tenantId}/${webhookId}`)
  }
  return { allowed: count <= limit, count, limit, retryAfterSeconds: secondsToWindowEnd(atMs) }
}
