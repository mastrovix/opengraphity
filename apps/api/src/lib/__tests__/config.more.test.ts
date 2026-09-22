/**
 * Config contract, second part: the optional integrations and the tuning
 * knobs the base test does not read.
 *
 * Why these behaviours matter:
 *  - An optional integration (Anthropic, Slack, GitHub for Autoanalisi, the
 *    platform console) is OFF when its variable is unset or EMPTY: an empty
 *    string must not count as "configured", or a feature would switch on with
 *    a blank key and fail at the first call.
 *  - The platform console has no default even outside production: a default
 *    would make the console that creates and deletes tenants exist on every
 *    installation.
 *  - `PUBLIC_BASE_URL` is concatenated with paths for Slack callbacks: a
 *    trailing slash would produce `//slack/...` URLs Slack rejects.
 *  - Bad values for the knobs THROW with the variable name instead of
 *    degrading to NaN or to a list with no entries.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { config, resetConfigCache } from '../config.js'

const OPTIONAL = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET',
  'PUBLIC_BASE_URL', 'AUTOANALISI_GITHUB_REPO', 'AUTOANALISI_GITHUB_TOKEN', 'PLATFORM_REALM',
  'PLATFORM_CONSOLE_HOST', 'TENANT_URL_TEMPLATE', 'PORTAL_URL_TEMPLATE', 'JWT_SECRET', 'CORS_ORIGIN',
  'DISCOVERY_ENCRYPTION_KEY', 'VOYAGE_API_KEY', 'RESEND_API_KEY',
] as const

function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
  resetConfigCache()
}

afterEach(() => { vi.unstubAllEnvs(); resetConfigCache() })

describe('optional integrations', () => {
  it('are off (undefined) when their variable is empty — even outside production', () => {
    setEnv({ NODE_ENV: 'development', ...Object.fromEntries(OPTIONAL.map((k) => [k, ''])) })
    expect(config.anthropicApiKey).toBeUndefined()
    expect(config.slackClientId).toBeUndefined()
    expect(config.slackClientSecret).toBeUndefined()
    expect(config.slackSigningSecret).toBeUndefined()
    expect(config.publicBaseUrl).toBeUndefined()
    expect(config.autoanalisiGithubRepo).toBeUndefined()
    expect(config.autoanalisiGithubToken).toBeUndefined()
    expect(config.platformRealm).toBeUndefined()
    expect(config.platformHost).toBeUndefined()
    expect(config.tenantUrlTemplate).toBeUndefined()
    expect(config.portalUrlTemplate).toBeUndefined()
    expect(config.jwtSecret).toBeUndefined()
    expect(config.corsOrigin).toBeUndefined()
    expect(config.discoveryEncryptionKey).toBeUndefined()
    expect(config.voyageApiKey).toBeUndefined()
    expect(config.resendApiKey).toBeUndefined()
    // The model has a documented default (its exact id is pinned by aiModel.test.ts).
    expect(config.anthropicModel).toMatch(/^claude-/)
  })

  it('are read as given when set', () => {
    setEnv({
      NODE_ENV: 'development', ANTHROPIC_MODEL: 'test-model-x', PLATFORM_REALM: 'platform',
      PLATFORM_CONSOLE_HOST: 'opengrafo.admin', TENANT_URL_TEMPLATE: 'https://{slug}.acme.com',
      AUTOANALISI_GITHUB_REPO: 'acme/opengrafo', SLACK_CLIENT_ID: 'cid',
    })
    expect(config.anthropicModel).toBe('test-model-x')
    expect(config.platformRealm).toBe('platform')
    expect(config.platformHost).toBe('opengrafo.admin')
    expect(config.tenantUrlTemplate).toBe('https://{slug}.acme.com')
    expect(config.autoanalisiGithubRepo).toBe('acme/opengrafo')
    expect(config.slackClientId).toBe('cid')
  })

  it('PUBLIC_BASE_URL loses its trailing slashes, so callback URLs are not built with "//"', () => {
    setEnv({ NODE_ENV: 'development', PUBLIC_BASE_URL: 'https://opengrafo.acme.com//' })
    expect(config.publicBaseUrl).toBe('https://opengrafo.acme.com')
  })
})

describe('tuning knobs', () => {
  it('have their documented defaults', () => {
    setEnv({ NODE_ENV: 'development', GRAPHQL_SCHEMA_CACHE_MAX: '', MAX_CI_TYPES_PER_TENANT: '', ATTACHMENT_MAX_MB_CAP: '', RATE_LIMIT_WINDOW_MINUTES: '', REQUIRE_APPLIED_MIGRATIONS: '', KEYCLOAK_APP_CLIENT_IDS: '' })
    expect(config.graphqlSchemaCacheMax).toBe(25)
    expect(config.maxCITypesPerTenant).toBe(200)
    expect(config.attachmentMaxMbCap).toBe(100)
    expect(config.rateLimitWindowMinutes).toBe(1)
    expect(config.requireAppliedMigrations).toBe(false)
    expect(config.keycloakAppClientIds).toEqual(['opengrafo-web', 'opengrafo-portal'])
  })

  it('a rate-limit window under one minute is refused', () => {
    setEnv({ NODE_ENV: 'development', RATE_LIMIT_WINDOW_MINUTES: '0' })
    expect(() => config.rateLimitWindowMinutes).toThrow(/RATE_LIMIT_WINDOW_MINUTES must be a whole number of minutes >= 1/)
  })

  it('KEYCLOAK_APP_CLIENT_IDS is trimmed, and a list of only separators is refused', () => {
    setEnv({ NODE_ENV: 'development', KEYCLOAK_APP_CLIENT_IDS: ' web , portal ,' })
    expect(config.keycloakAppClientIds).toEqual(['web', 'portal'])
    setEnv({ NODE_ENV: 'development', KEYCLOAK_APP_CLIENT_IDS: ' , ' })
    expect(() => config.keycloakAppClientIds).toThrow(/KEYCLOAK_APP_CLIENT_IDS is set but contains no client id/)
  })

  it('KEYCLOAK_PUBLIC_URL made only of separators is refused', () => {
    setEnv({ NODE_ENV: 'development', KEYCLOAK_PUBLIC_URL: ',' })
    expect(() => config.keycloakPublicUrls).toThrow(/KEYCLOAK_PUBLIC_URL is set but contains no URL/)
  })

  it('isTest is true only for NODE_ENV=test', () => {
    setEnv({ NODE_ENV: 'test' })
    expect(config.isTest).toBe(true)
    expect(config.isProduction).toBe(false)
    setEnv({ NODE_ENV: 'development' })
    expect(config.isTest).toBe(false)
  })
})

describe('metrics token', () => {
  it('is optional outside production and required in production', () => {
    setEnv({ NODE_ENV: 'development', METRICS_TOKEN: '' })
    expect(config.metricsToken).toBeUndefined()
    setEnv({ NODE_ENV: 'production', METRICS_TOKEN: '' })
    expect(() => config.metricsToken).toThrow(/METRICS_TOKEN is required in production/)
    setEnv({ NODE_ENV: 'production', METRICS_TOKEN: 'tok' })
    expect(config.metricsToken).toBe('tok')
  })
})
