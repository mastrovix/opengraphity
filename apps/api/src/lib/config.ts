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
  /**
   * Revisione del 14 set 2026 · F8: `true` = il processo non parte con
   * migrazioni pendenti. Spento per default perché la ricetta locale le lancia
   * dentro il container dell'API (vedi lib/migrationState.ts).
   */
  requireAppliedMigrations: (): boolean => boolEnv('REQUIRE_APPLIED_MIGRATIONS', false),

  // Keycloak
  /** Internal URL for server-to-server calls (JWKS fetch, admin API). */
  keycloakUrl:           (): string   => envOrThrowInProd('KEYCLOAK_URL', 'http://localhost:8080'),
  /** Public origins browsers use; tokens carry one of them as `iss`. Comma-separated. */
  /**
   * I client Keycloak delle app (web e portale) a cui l'API crede
   * (revisione totale · A-7): un token del realm emesso per un altro client
   * (account-console, un'altra applicazione federata) non è un accesso a
   * OpenGrafo. Nel compose viene da VITE_KEYCLOAK_CLIENT_ID e
   * VITE_KEYCLOAK_CLIENT_ID_PORTAL: una sorgente sola con i bundle.
   */
  keycloakAppClientIds:  (): string[] => {
    const raw = envOrThrowInProd('KEYCLOAK_APP_CLIENT_IDS', 'opengrafo-web,opengrafo-portal')
    const ids = raw.split(',').map((u) => u.trim()).filter((u) => u.length > 0)
    if (ids.length === 0) throw new Error('Environment variable KEYCLOAK_APP_CLIENT_IDS is set but contains no client id')
    return ids
  },
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

  /*
   * LA CONSOLE DI PIATTAFORMA (17 set 2026): il realm Keycloak dei suoi
   * amministratori e l'host su cui vive.
   *
   * Non hanno un default, nemmeno fuori produzione, e il motivo è la
   * sicurezza: un default farebbe esistere la console — quella che crea e
   * cancella i tenant — su ogni installazione, anche dove nessuno l'ha voluta.
   * Assenti, il suo cammino di autenticazione rifiuta tutto e nginx non la
   * espone.
   *
   * L'host si confronta per INTERO (`opengrafo.admin`, non un primo pezzo):
   * così nessun nome di tenant diventa vietato, mentre riservare l'etichetta
   * `admin.` avrebbe impedito per sempre a un cliente di chiamarsi così.
   */
  platformRealm: (): string | undefined => optionalEnv('PLATFORM_REALM'),
  platformHost:  (): string | undefined => optionalEnv('PLATFORM_CONSOLE_HOST'),
  /*
   * GLI INDIRIZZI DELLE APP DI UN TENANT, con `{slug}` al posto del nome.
   *
   * Sono una scelta dell'installazione, non una costante: in locale i tenant
   * stanno su `http://{slug}.localhost`, in produzione su
   * `https://{slug}.azienda.com`, e c'è chi mette il portale su un dominio a
   * parte. Dedurli dall'host della console sarebbe un ripiego silenzioso che
   * indovina bene finché le due cose stanno sullo stesso dominio, e poi mostra
   * link rotti senza dirlo — quindi se non sono configurati la console scrive
   * «not configured» invece di inventarli.
   */
  tenantUrlTemplate: (): string | undefined => optionalEnv('TENANT_URL_TEMPLATE'),
  portalUrlTemplate: (): string | undefined => optionalEnv('PORTAL_URL_TEMPLATE'),

  // Auth
  /** Legacy HS256 dev tokens (auth/resolveAuth.ts). Off unless ALLOW_LEGACY_JWT=true. */
  allowLegacyJwt: (): boolean            => boolEnv('ALLOW_LEGACY_JWT', false),
  /** Only meaningful with allowLegacyJwt; resolveAuth enforces its presence in that case. */
  jwtSecret:      (): string | undefined => optionalEnv('JWT_SECRET'),

  // HTTP
  /** Undefined → server.ts refuses to start in production, allows everything in dev. */
  corsOrigin:           (): string | undefined => optionalEnv('CORS_ORIGIN'),
  /**
   * Richieste per FINESTRA e per client (IP) del limitatore HTTP, in
   * produzione. La finestra è `RATE_LIMIT_WINDOW_MINUTES` — prima era un
   * quarto d'ora scritto nel codice mentre questo commento diceva «al
   * minuto» (revisione totale · A-10).
   */
  rateLimitMax:         (): number  => intEnv('RATE_LIMIT_MAX', 1000),
  /** La finestra del limitatore, in minuti (default: 1 → «al minuto»). */
  rateLimitWindowMinutes: (): number => {
    const n = intEnv('RATE_LIMIT_WINDOW_MINUTES', 1)
    if (!Number.isInteger(n) || n < 1) throw new Error(`RATE_LIMIT_WINDOW_MINUTES must be a whole number of minutes >= 1 (got "${String(n)}")`)
    return n
  },
  /** Apollo introspection in production (off by default; always on outside). */
  graphqlIntrospection: (): boolean => boolEnv('GRAPHQL_INTROSPECTION', false),
  /**
   * Quanti schemi GraphQL per tenant questo processo tiene in memoria
   * (ondata 5, A-1). Ogni voce è uno schema eseguibile generato dal
   * metamodello del tenant: al superamento si sfratta il meno usato di
   * recente e si ricostruisce alla richiesta successiva (una lettura del
   * metamodello). Si vede con `graphql_schema_evictions_total`.
   */
  graphqlSchemaCacheMax: (): number => intEnv('GRAPHQL_SCHEMA_CACHE_MAX', 25),
  /**
   * Quanti tipi CI può avere un cliente (revisione delle otto ondate · A·#6).
   *
   * Non c'era nessun tetto: mille tipi — importabili via API in pochi minuti —
   * costano 313 MB di heap e mezzo secondo a ogni ricostruzione dello schema,
   * e la ricostruzione avviene a ogni modifica del metamodello **in ogni
   * processo in ascolto sul canale**. Era un modo per un cliente di rallentare
   * il processo che serve anche gli altri. Duecento è largo (dal vivo il
   * cliente più ricco ne ha 13) e si alza con la variabile d'ambiente.
   */
  maxCITypesPerTenant:  (): number => intEnv('MAX_CI_TYPES_PER_TENANT', 200),
  /**
   * Bearer token di GET /metrics. In produzione è OBBLIGATORIO (revisione
   * totale · A-24): senza, l'accesso era deciso dall'indirizzo del socket, e su
   * una rete bridge di Docker qualunque container leggeva le metriche —
   * compresa `tenant_provisioning_gaps{tenant}`, cioè l'elenco dei clienti che
   * `/health` nasconde di proposito. Fuori produzione resta facoltativo.
   */
  metricsToken:         (): string | undefined => {
    const token = optionalEnv('METRICS_TOKEN')
    if (!token && process.env['NODE_ENV'] === 'production') {
      throw new Error('Environment variable METRICS_TOKEN is required in production: without it /metrics is open to the whole Docker network')
    }
    return token
  },
  /** Base URL of the web app used in every outbound link (emails, Slack cards). */
  appUrl:               (): string  => envOrThrowInProd('APP_URL', 'http://localhost:5173'),

  // Storage
  attachmentDir: (): string => path.resolve(envOrThrowInProd('ATTACHMENT_DIR', './data/attachments')),
  backupDir:     (): string => path.resolve(envOrThrowInProd('BACKUP_DIR', './backups')),
  reportDir:     (): string => path.resolve(envOrThrowInProd('REPORT_DIR', './data/reports')),
  /**
   * Il TETTO della piattaforma per un allegato, in MB (verifica «Cosa resta
   * cablato», ondata 6): ogni organizzazione sceglie il suo limite sotto questo
   * valore. È dell'operatore, non del cliente: protegge disco e memoria di tutti.
   */
  attachmentMaxMbCap: (): number => intEnv('ATTACHMENT_MAX_MB_CAP', 100),

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
  /**
   * Modello Claude di TUTTI i servizi AI (triage, assistente, post-incident,
   * agente dei report): UN solo posto da cambiare per aggiornarlo. Prima l'id
   * era scritto dentro cinque punti diversi e uno di loro dichiarava, falso,
   * di usare «la stessa costante degli altri».
   *
   * L'agente dei report accetta ancora `REPORT_AI_MODEL` per usarne uno
   * diverso solo lì (interroga il grafo con gli strumenti: può convenire un
   * modello distinto).
   */
  anthropicModel:     (): string => optionalEnv('ANTHROPIC_MODEL') ?? 'claude-opus-5',
  /*
    L'app Slack DI OPENGRAFO (ondata 8): serve al collegamento con un clic
    («Aggiungi a Slack»). Il token di ogni organizzazione NON sta qui: sta nel
    grafo, cifrato (SlackInstallation). Senza queste tre il collegamento con un
    clic non si offre; resta quello con il token dell'app dell'organizzazione.
  */
  /*
    DAL PROBLEM ALLA PROPOSTA DI CODICE, SENZA PASSARE DA UNA PERSONA
    (21 set 2026).

    Quando si apre un Problem da una proposta dell'Autoanalisi, il prodotto
    porta il fascicolo d'indagine su GitHub come issue e chiede l'analisi.
    Serve il repository dove vive il codice e un token che possa scriverci.

    Sono di PIATTAFORMA, non di un cliente: l'Autoanalisi gira solo sul tenant
    `opengrafo`, e il repository e' uno solo per tutta l'installazione. Per
    questo stanno qui e non nelle impostazioni di un'organizzazione.

    Vuote = il giro si ferma al Problem, che resta un Problem come un altro.
    Non in silenzio: la diagnostica lo dichiara
    (`configurationIssue.autoanalisiGithubMissing`).
  */
  autoanalisiGithubRepo:  (): string | undefined => optionalEnv('AUTOANALISI_GITHUB_REPO'),
  autoanalisiGithubToken: (): string | undefined => optionalEnv('AUTOANALISI_GITHUB_TOKEN'),

  slackClientId:      (): string | undefined => optionalEnv('SLACK_CLIENT_ID'),
  slackClientSecret:  (): string | undefined => optionalEnv('SLACK_CLIENT_SECRET'),
  slackSigningSecret: (): string | undefined => optionalEnv('SLACK_SIGNING_SECRET'),
  /**
   * L'indirizzo da cui Internet raggiunge OpenGrafo (es. https://opengrafo.acme.com):
   * Slack chiama lì i comandi, le azioni e il ritorno dell'installazione.
   * Senza, Slack non può raggiungere OpenGrafo e la pagina Integrazioni lo dice.
   */
  publicBaseUrl:      (): string | undefined => optionalEnv('PUBLIC_BASE_URL')?.replace(/\/+$/, ''),
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
    'nodeEnv', 'port', 'logLevel', 'workerProfile', 'requireAppliedMigrations',
    'neo4jUri', 'neo4jUser', 'neo4jPassword', 'neo4jMaxPoolSize',
    'keycloakUrl', 'keycloakPublicUrls', 'keycloakAppClientIds', 'keycloakAdminUser',
    'allowLegacyJwt', 'corsOrigin', 'rateLimitMax', 'rateLimitWindowMinutes', 'graphqlIntrospection', 'graphqlSchemaCacheMax', 'maxCITypesPerTenant', 'metricsToken', 'appUrl',
    'attachmentDir', 'backupDir', 'reportDir',
    'embeddingsProvider', 'transformersCache', 'embeddingWorkerExternal',
    'emailFrom', 'otelEnabled', 'otelEndpoint',
  ],
  // The worker serves GET /metrics on `port` (Prometheus scrapes it like the API).
  worker: [
    'nodeEnv', 'port', 'logLevel', 'workerProfile', 'metricsToken', 'requireAppliedMigrations',
    'neo4jUri', 'neo4jUser', 'neo4jPassword', 'neo4jMaxPoolSize',
    'embeddingsProvider', 'transformersCache',
  ],
  // The process that runs the maintenance work group (backup and purges) also
  // needs these (review of 23 Sep 2026): checked by worker.ts only when the
  // profile starts that group, so the `events-worker` does not ask for them.
  maintenance: [
    'keycloakUrl', 'keycloakAdminUser', 'attachmentDir', 'backupDir',
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
