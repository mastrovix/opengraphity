/**
 * API-side facade over the shared SSRF guard in @opengraphity/events.
 * The only thing added here is the error type: the package throws
 * `UnsafeUrlError` (no GraphQL dependency), resolvers need `ValidationError`
 * (→ BAD_USER_INPUT / HTTP 400). Nothing else — the rules live in ONE place.
 */
import {
  assertSafeOutboundUrl as assertSafeOutboundUrlPkg,
  assertSafeOutboundUrlSync as assertSafeOutboundUrlSyncPkg,
  UnsafeUrlError,
  type SafeUrlOptions,
} from '@opengraphity/events'
import { ValidationError } from './errors.js'

export { loggableUrl, httpsRequiredByPolicy, type SafeUrlOptions } from '@opengraphity/events'

function toValidation(err: unknown): never {
  if (err instanceof UnsafeUrlError) throw new ValidationError(err.message)
  throw err
}

/** Scheme + literal-host checks only (no DNS). Throws ValidationError. */
export function assertSafeOutboundUrlSync(url: string, opts?: SafeUrlOptions): URL {
  try {
    return assertSafeOutboundUrlSyncPkg(url, opts)
  } catch (err) {
    return toValidation(err)
  }
}

/** Full check incl. DNS resolution of every address. Throws ValidationError. */
export async function assertSafeOutboundUrl(url: string, opts?: SafeUrlOptions): Promise<URL> {
  try {
    return await assertSafeOutboundUrlPkg(url, opts)
  } catch (err) {
    return toValidation(err)
  }
}
