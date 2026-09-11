/**
 * Typed application configuration — the ONE place that reads `process.env`
 * in apps/api (G-07, A-24). Rules:
 *
 *   - Every value is a memoized getter: it is parsed the first time it is
 *     read, then frozen for the life of the process.
 *   - Development defaults exist ONLY for `NODE_ENV !== 'production'`. In
 *     production a missing endpoint/secret/directory THROWS (no localhost, no
 *     default password, no "./data" inside the container).
 *   - Behaviour flags and tuning knobs (log level, rate limit, introspection,
 *     OTEL on/off, …) have an explicit, documented default in every
 *     environment: their absence is not a config error.
 *   - `validateConfig(profile)` is called at startup (index.ts → 'api',
 *     worker.ts → 'worker') so every variable that process needs is checked
 *     before the first request, not at the first use hours later.
 *
 * The env-documentation check (`node scripts/check-env-example.mjs`) reads
 * the variable names from the `*Env(<literal>, …)` calls below and from any
 * remaining `process.env[<literal>]` — keep the names as string literals.
 *
 * No imports from the rest of the API (logger imports THIS module).
 */
import path from 'node:path'
import { requireEnv, envOrThrowInProd } from './env.js'
import { WORKER_PROFILES, type WorkerProfile } from './workerProfiles.js'

// ── Primitive readers ────────────────────────────────────────────────────────

/** Optional string; `undefined` when unset or empty. */
function optionalEnv(name: string): string | undefined {
  const v = process.env[name]
  return v ? v : undefined
}

/** Boolean flag: only the literal `true` enables it; unset/anything else → `defaultValue`. */
function boolEnv(name: string, defaultValue: boolean): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return defaultValue
  if (v === 'true') return true
  if (v === 'false') return false
  throw new Error(`Environment variable ${name} must be "true" or "false" (got "${v}")`)
}

/** Integer with a default; a non-integer value throws instead of becoming NaN. */
function intEnv(name: string, defaultValue: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return defaultValue
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error(`Environment variable ${name} must be an integer (got "${v}")`)
  return n
}

/** One of an allowed set (with a default). Anything else throws. */
function enumEnv<T extends string>(name: string, allowed: readonly T[], defaultValue: T): T {
  const v = process.env[name]
  if (v === undefined || v === '') return defaultValue
  if ((allowed as readonly string[]).includes(v)) return v as T
  throw new Error(`Environment variable ${name} must be one of ${allowed.join(', ')} (got "${v}")`)
}

// ── Schema ───────────────────────────────────────────────────────────────────

export const EMBEDDINGS_PROVIDERS = ['local', 'voyage'] as const
export type EmbeddingsProvider = (typeof EMBEDDINGS_PROVIDERS)[number]

export const NODE_ENVS = ['development', 'test', 'production'] as const
export type NodeEnv = (typeof NODE_ENVS)[number]

/**
 * Each entry builds one config value from the environment. Kept as a plain
 * record of thunks so `validateConfig` can iterate the keys of a profile.
 */
const readers = {
  nodeEnv:      (): NodeEnv => enumEnv('NODE_ENV', NODE_ENVS, 'development'),
  port:         (): number  => intEnv('PORT', 4000),
  logLevel:     (): string  => optionalEnv('LOG_LEVEL') ?? 'info',

  // Neo4j — the driver (packages/neo4j) reads these itself; mirrored here so
  // the startup validation covers them and nothing else reads process.env.
  neo4jUri:      (): string => envOrThrowInProd('NEO4J_URI', 'neo4j://localhost:7687'),
  neo4jUser:     (): string => envOrThrowInProd('NEO4J_USER', 'neo4j'),
  neo4jPassword: (): string => envOrThrowInProd('NEO4J_PASSWORD', 'opengraphity_local'),
  /** Connections per process (the driver reads it too; validated here so a bad value stops the boot). Default 50. */
  neo4jMaxPoolSize: (): number => {
    const n = intEnv('NEO4J_MAX_POOL_SIZE', 50)
    if (n < 1) throw new Error(`Environment variable NEO4J_MAX_POOL_SIZE must be a positive integer (got "${n}")`)
    return n
  },

  // Process profile (revisione 2 · D1.1): which work groups THIS process starts —
  // the table is lib/workerProfiles.ts. `all` = the API runs everything (as before).
  workerProfile: (): WorkerProfile => enumEnv('WORKER_PROFILE', WORKER_PROFILES, 'all'),

  // Keycloak
  /** Internal URL for server-to-server calls (JWKS fetch, admin API). */
  keycloakUrl:           (): string   => envOrThrowInProd('KEYCLOAK_URL', 'http://localhost:8080'),
  /** Public origins browsers use; tokens carry one of them as `iss`. Comma-separated. */
  keycloakPublicUrls:    (): string[] => {
    const raw = envOrThrowInProd('KEYCLOAK_PUBLIC_URL', readers.keycloakUrl())
    const urls = raw.split(',').map((u) => u.trim()).filter((u) => u.length > 0)
    if (urls.length === 0) throw new Error('Environment variable KEYCLOAK_PUBLIC_URL is set but contains no URL')
    for (const u of urls) {
      try { new URL(u) } catch { throw new Error(`KEYCLOAK_PUBLIC_URL contains an invalid URL: "${u}"`) }
    }
    return urls
  },
  keycloakAdminUser:     (): string => envOrThrowInProd('KEYCLOAK_ADMIN_USER', 'admin'),
  /** Secret: required in every environment, read lazily (only createUser/onboarding need it). */
  keycloakAdminPassword: (): string => requireEnv('KEYCLOAK_ADMIN_PASSWORD'),

  // Auth
  /** Legacy HS256 dev tokens (auth/resolveAuth.ts). Off unless ALLOW_LEGACY_JWT=true. */
  allowLegacyJwt: (): boolean            => boolEnv('ALLOW_LEGACY_JWT', false),
  /** Only meaningful with allowLegacyJwt; resolveAuth enforces its presence in that case. */
  jwtSecret:      (): string | undefined => optionalEnv('JWT_SECRET'),

  // HTTP
  /** Undefined → server.ts refuses to start in production, allows everything in dev. */
  corsOrigin:           (): string | undefined => optionalEnv('CORS_ORIGIN'),
  /** Requests/min per client for the GraphQL rate limiter (production only). */
  rateLimitMax:         (): number  => intEnv('RATE_LIMIT_MAX', 1000),
  /** Apollo introspection in production (off by default; always on outside). */
  graphqlIntrospection: (): boolean => boolEnv('GRAPHQL_INTROSPECTION', false),
  /** Bearer token for GET /metrics; empty → loopback/private networks only. */
  metricsToken:         (): string | undefined => optionalEnv('METRICS_TOKEN'),
  /** Base URL of the web app used in every outbound link (emails, Slack cards). */
  appUrl:               (): string  => envOrThrowInProd('APP_URL', 'http://localhost:5173'),

  // Storage
  attachmentDir: (): string => path.resolve(envOrThrowInProd('ATTACHMENT_DIR', './data/attachments')),
  backupDir:     (): string => path.resolve(envOrThrowInProd('BACKUP_DIR', './backups')),
  reportDir:     (): string => path.resolve(envOrThrowInProd('REPORT_DIR', './data/reports')),

  // Discovery
  /** 32-byte hex key for connector credentials at rest; unset → discovery sources cannot be saved. */
  discoveryEncryptionKey: (): string | undefined => optionalEnv('DISCOVERY_ENCRYPTION_KEY'),

  // Embeddings (semantic similarity)
  embeddingsProvider:      (): EmbeddingsProvider => enumEnv('EMBEDDINGS_PROVIDER', EMBEDDINGS_PROVIDERS, 'local'),
  /** Required only with embeddingsProvider=voyage (checked there). */
  voyageApiKey:            (): string | undefined => optionalEnv('VOYAGE_API_KEY'),
  transformersCache:       (): string  => envOrThrowInProd('TRANSFORMERS_CACHE', './data/models'),
  /** true → the API skips its in-process embedding worker (a `worker` container runs it). */
  embeddingWorkerExternal: (): boolean => boolEnv('EMBEDDING_WORKER_EXTERNAL', false),

  // Email (Resend) — packages/notifications enforces the key in production.
  resendApiKey: (): string | undefined => optionalEnv('RESEND_API_KEY'),
  emailFrom:    (): string => envOrThrowInProd('EMAIL_FROM', 'OpenGrafo <onboarding@resend.dev>'),

  // Observability
  otelEnabled:  (): boolean => boolEnv('OTEL_ENABLED', false),
  /** OTLP/HTTP traces endpoint; required (in production) only when otelEnabled. */
  otelEndpoint: (): string  => readers.otelEnabled()
    ? envOrThrowInProd('OTEL_ENDPOINT', 'http://localhost:4318/v1/traces')
    : (optionalEnv('OTEL_ENDPOINT') ?? 'http://localhost:4318/v1/traces'),

  // Optional integrations (features stay off when unset)
  anthropicApiKey:    (): string | undefined => optionalEnv('ANTHROPIC_API_KEY'),
  slackBotToken:      (): string | undefined => optionalEnv('SLACK_BOT_TOKEN'),
  slackSigningSecret: (): string | undefined => optionalEnv('SLACK_SIGNING_SECRET'),
} as const

type Readers = typeof readers
export type AppConfig = { readonly [K in keyof Readers]: ReturnType<Readers[K]> } & {
  readonly isProduction: boolean
  readonly isTest: boolean
}

export type ConfigKey = keyof Readers

// ── Memoized accessor ────────────────────────────────────────────────────────

const cache = new Map<ConfigKey, unknown>()

function read<K extends ConfigKey>(key: K): ReturnType<Readers[K]> {
  if (cache.has(key)) return cache.get(key) as ReturnType<Readers[K]>
  const value = (readers[key] as () => ReturnType<Readers[K]>)()
  cache.set(key, value)
  return value
}

function buildConfig(): AppConfig {
  const target = {} as Record<string, unknown>
  for (const key of Object.keys(readers) as ConfigKey[]) {
    Object.defineProperty(target, key, { enumerable: true, get: () => read(key) })
  }
  Object.defineProperty(target, 'isProduction', { enumerable: true, get: () => read('nodeEnv') === 'production' })
  Object.defineProperty(target, 'isTest',       { enumerable: true, get: () => read('nodeEnv') === 'test' })
  return target as AppConfig
}

/** The application configuration. Values are read from the environment on first access. */
export const config: AppConfig = buildConfig()

/**
 * Forgets every memoized value so the next access re-reads process.env.
 * Tests only (vi.stubEnv + resetConfigCache); never call it at runtime.
 */
export function resetConfigCache(): void {
  cache.clear()
}

// ── Startup validation ───────────────────────────────────────────────────────

/**
 * Keys each process needs. Reading a key runs its reader, i.e. its
 * production guard: a missing value throws HERE, at boot, with the variable
 * name in the message. Secrets that only some code paths need
 * (keycloakAdminPassword, voyageApiKey, jwtSecret) are checked at use.
 */
export const CONFIG_PROFILES = {
  api: [
    'nodeEnv', 'port', 'logLevel', 'workerProfile',
    'neo4jUri', 'neo4jUser', 'neo4jPassword', 'neo4jMaxPoolSize',
    'keycloakUrl', 'keycloakPublicUrls', 'keycloakAdminUser',
    'allowLegacyJwt', 'corsOrigin', 'rateLimitMax', 'graphqlIntrospection', 'metricsToken', 'appUrl',
    'attachmentDir', 'backupDir', 'reportDir',
    'embeddingsProvider', 'transformersCache', 'embeddingWorkerExternal',
    'emailFrom', 'otelEnabled', 'otelEndpoint',
  ],
  // The worker serves GET /metrics on `port` (Prometheus scrapes it like the API).
  worker: [
    'nodeEnv', 'port', 'logLevel', 'workerProfile', 'metricsToken',
    'neo4jUri', 'neo4jUser', 'neo4jPassword', 'neo4jMaxPoolSize',
    'embeddingsProvider', 'transformersCache',
  ],
} as const satisfies Record<string, readonly ConfigKey[]>

export type ConfigProfile = keyof typeof CONFIG_PROFILES

/**
 * Reads every key of the profile; collects ALL failures and throws once with
 * the full list, so an operator fixes the deployment in one round instead of
 * discovering the missing variables one restart at a time.
 */
export function validateConfig(profile: ConfigProfile): void {
  const failures: string[] = []
  for (const key of CONFIG_PROFILES[profile]) {
    try {
      read(key)
    } catch (err) {
      failures.push(`  - ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`Invalid configuration for the "${profile}" process (${failures.length} problem(s)):\n${failures.join('\n')}`)
  }
}
