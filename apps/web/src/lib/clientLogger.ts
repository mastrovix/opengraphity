/**
 * Client → server logger (`POST /api/logs/client`). Implementation in
 * `@opengraphity/web-core` (shared with apps/portal): a failed delivery is
 * reported on the console — never swallowed silently — but cannot throw
 * into the caller (E-19).
 */
import { createClientLogger } from '@opengraphity/web-core'
import { apiBase } from './apiBase'

export const clientLogger = createClientLogger(apiBase)
