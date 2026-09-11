/**
 * Config contract (G-07): development defaults exist only outside production;
 * in production a missing endpoint/dir/secret throws with the variable name,
 * and validateConfig reports every problem at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { config, resetConfigCache, validateConfig, CONFIG_PROFILES } from '../config.js'

const TOUCHED = [
  'NODE_ENV', 'PORT', 'LOG_LEVEL', 'KEYCLOAK_URL', 'KEYCLOAK_PUBLIC_URL', 'KEYCLOAK_ADMIN_USER',
  'KEYCLOAK_ADMIN_PASSWORD', 'ATTACHMENT_DIR', 'BACKUP_DIR', 'REPORT_DIR', 'EMBEDDINGS_PROVIDER',
  'EMBEDDING_WORKER_EXTERNAL', 'RATE_LIMIT_MAX', 'GRAPHQL_INTROSPECTION', 'OTEL_ENABLED', 'OTEL_ENDPOINT',
  'APP_URL', 'NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD', 'TRANSFORMERS_CACHE', 'EMAIL_FROM',
  'WORKER_PROFILE', 'NEO4J_MAX_POOL_SIZE', 'METRICS_TOKEN',
]

function setEnv(vars: Record<string, string | undefined>): void {
  for (const k of TOUCHED) vi.stubEnv(k, '')
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) vi.stubEnv(k, v)
  resetConfigCache()
}

beforeEach(() => resetConfigCache())
afterEach(() => { vi.unstubAllEnvs(); resetConfigCache() })

describe('config — development defaults', () => {
  it('returns the documented defaults when nothing is set', () => {
    setEnv({ NODE_ENV: 'development' })
    expect(config.nodeEnv).toBe('development')
    expect(config.isProduction).toBe(false)
    expect(config.port).toBe(4000)
    expect(config.keycloakUrl).toBe('http://localhost:8080')
    expect(config.keycloakPublicUrls).toEqual(['http://localhost:8080'])
    expect(config.embeddingsProvider).toBe('local')
    expect(config.embeddingWorkerExternal).toBe(false)
    expect(config.graphqlIntrospection).toBe(false)
    expect(config.rateLimitMax).toBe(1000)
    expect(config.attachmentDir.endsWith('data/attachments')).toBe(true)
    // revisione 2 · D1.1: `all` = comportamento precedente (l'API fa tutto); pool Neo4j 50 come prima
    expect(config.workerProfile).toBe('all')
    expect(config.neo4jMaxPoolSize).toBe(50)
  })

  it('WORKER_PROFILE accetta solo all | api | events; NEO4J_MAX_POOL_SIZE solo interi positivi', () => {
    setEnv({ NODE_ENV: 'development', WORKER_PROFILE: 'events', NEO4J_MAX_POOL_SIZE: '40' })
    expect(config.workerProfile).toBe('events')
    expect(config.neo4jMaxPoolSize).toBe(40)
    setEnv({ NODE_ENV: 'development', WORKER_PROFILE: 'ingest' })
    expect(() => config.workerProfile).toThrow(/WORKER_PROFILE must be one of all, api, events/)
    setEnv({ NODE_ENV: 'development', NEO4J_MAX_POOL_SIZE: '0' })
    expect(() => config.neo4jMaxPoolSize).toThrow(/NEO4J_MAX_POOL_SIZE must be a positive integer/)
    setEnv({ NODE_ENV: 'development', NEO4J_MAX_POOL_SIZE: 'many' })
    expect(() => config.neo4jMaxPoolSize).toThrow(/NEO4J_MAX_POOL_SIZE must be an integer/)
  })

  it('memoizes: a later env change is not seen until resetConfigCache()', () => {
    setEnv({ NODE_ENV: 'development', PORT: '4100' })
    expect(config.port).toBe(4100)
    vi.stubEnv('PORT', '4200')
    expect(config.port).toBe(4100)
    resetConfigCache()
    expect(config.port).toBe(4200)
  })

  it('parses KEYCLOAK_PUBLIC_URL as a comma-separated list and rejects invalid URLs', () => {
    setEnv({ NODE_ENV: 'development', KEYCLOAK_PUBLIC_URL: 'http://localhost:8080, https://auth.example.com ' })
    expect(config.keycloakPublicUrls).toEqual(['http://localhost:8080', 'https://auth.example.com'])
    setEnv({ NODE_ENV: 'development', KEYCLOAK_PUBLIC_URL: 'not a url' })
    expect(() => config.keycloakPublicUrls).toThrow(/invalid URL/)
  })

  it('THROWS on malformed flags/numbers/enums instead of guessing', () => {
    setEnv({ NODE_ENV: 'development', PORT: 'abc' })
    expect(() => config.port).toThrow(/PORT must be an integer/)
    setEnv({ NODE_ENV: 'development', EMBEDDING_WORKER_EXTERNAL: 'yes' })
    expect(() => config.embeddingWorkerExternal).toThrow(/must be "true" or "false"/)
    setEnv({ NODE_ENV: 'development', EMBEDDINGS_PROVIDER: 'openai' })
    expect(() => config.embeddingsProvider).toThrow(/must be one of local, voyage/)
    setEnv({ NODE_ENV: 'staging' })
    expect(() => config.nodeEnv).toThrow(/NODE_ENV must be one of/)
  })
})

describe('config — production has no silent defaults', () => {
  it('THROWS with the variable name for a missing endpoint/directory', () => {
    setEnv({ NODE_ENV: 'production' })
    expect(config.isProduction).toBe(true)
    expect(() => config.keycloakUrl).toThrow(/KEYCLOAK_URL is required in production/)
    expect(() => config.attachmentDir).toThrow(/ATTACHMENT_DIR is required in production/)
    expect(() => config.neo4jPassword).toThrow(/NEO4J_PASSWORD is required in production/)
    expect(() => config.appUrl).toThrow(/APP_URL is required in production/)
  })

  it('keycloakAdminPassword is a secret: required in every environment', () => {
    setEnv({ NODE_ENV: 'development' })
    expect(() => config.keycloakAdminPassword).toThrow(/KEYCLOAK_ADMIN_PASSWORD is required/)
  })

  it('OTEL_ENDPOINT is required in production only when OTEL_ENABLED=true', () => {
    setEnv({ NODE_ENV: 'production', OTEL_ENABLED: 'false' })
    expect(config.otelEndpoint).toBe('http://localhost:4318/v1/traces')
    setEnv({ NODE_ENV: 'production', OTEL_ENABLED: 'true' })
    expect(() => config.otelEndpoint).toThrow(/OTEL_ENDPOINT is required in production/)
  })

  it('validateConfig(api) lists EVERY missing variable in one error', () => {
    setEnv({ NODE_ENV: 'production' })
    let message = ''
    try { validateConfig('api') } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/Invalid configuration for the "api" process/)
    for (const name of ['NEO4J_URI', 'NEO4J_PASSWORD', 'KEYCLOAK_URL', 'ATTACHMENT_DIR', 'BACKUP_DIR', 'REPORT_DIR', 'APP_URL', 'TRANSFORMERS_CACHE', 'EMAIL_FROM']) {
      expect(message).toContain(name)
    }
  })

  it('validateConfig passes with a complete production environment', () => {
    setEnv({
      NODE_ENV: 'production',
      NEO4J_URI: 'bolt://neo4j:7687', NEO4J_USER: 'neo4j', NEO4J_PASSWORD: 'pw',
      KEYCLOAK_URL: 'http://keycloak:8080', KEYCLOAK_PUBLIC_URL: 'https://auth.example.com', KEYCLOAK_ADMIN_USER: 'admin',
      APP_URL: 'https://app.example.com',
      ATTACHMENT_DIR: '/data/attachments', BACKUP_DIR: '/data/backups', REPORT_DIR: '/data/reports',
      EMBEDDINGS_PROVIDER: 'local', TRANSFORMERS_CACHE: '/data/models', EMAIL_FROM: 'ITSM <no-reply@example.com>',
    })
    expect(() => validateConfig('api')).not.toThrow()
    expect(() => validateConfig('worker')).not.toThrow()
    expect(config.attachmentDir).toBe('/data/attachments')
  })

  it('the worker profile is a subset of the api profile, and both validate the process profile and the Neo4j pool size at boot', () => {
    for (const k of CONFIG_PROFILES.worker) expect(CONFIG_PROFILES.api).toContain(k)
    for (const k of ['workerProfile', 'neo4jMaxPoolSize'] as const) {
      expect(CONFIG_PROFILES.api).toContain(k)
      expect(CONFIG_PROFILES.worker).toContain(k)
    }
    // the worker serves GET /metrics: port and token are part of its profile
    expect(CONFIG_PROFILES.worker).toContain('port')
    expect(CONFIG_PROFILES.worker).toContain('metricsToken')
  })
})
