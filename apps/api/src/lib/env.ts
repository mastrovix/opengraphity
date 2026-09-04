/**
 * Environment-variable access with fail-loud semantics.
 *
 * No silent fallbacks: a missing secret throws, and a missing config value
 * throws in production instead of degrading to a local default.
 */

/** A required value (typically a secret). Throws if unset or empty, always. */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Environment variable ${name} is required but is not set`)
  }
  return value
}

/**
 * A config value with a development-only default. Returns the env value when
 * set; otherwise returns `devDefault` outside production and throws in
 * production, so a misconfigured deployment fails loudly at startup rather
 * than silently pointing at localhost.
 */
export function envOrThrowInProd(name: string, devDefault: string): string {
  const value = process.env[name]
  if (value) return value
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(`Environment variable ${name} is required in production but is not set`)
  }
  return devDefault
}
