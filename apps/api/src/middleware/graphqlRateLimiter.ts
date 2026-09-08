/**
 * Per-mutation GraphQL rate limiter — Apollo plugin (A-09).
 *
 * The previous Express middleware keyed on the client-supplied `operationName`
 * (`CreateIncident`, `ExecuteChangeTransition`, …) while the limits were keyed
 * on schema field names (`createIncident`, …): it never matched, and it could
 * be bypassed by renaming/omitting the operation. It also read the tenant
 * from UNVERIFIED JWT claims.
 *
 * This plugin runs in `didResolveOperation`, i.e. after parsing/validation
 * and after the context (verified tenantId/userId) is built. It inspects the
 * ROOT fields of the mutation selection set — the real schema field names,
 * whatever the operation is called — and counts each limited field once per
 * request, per tenant.
 *
 * Store: in-memory, per process. With more than one API replica each replica
 * enforces its own budget (effective limit = N × limit). Move the buckets to
 * Redis (INCR + EXPIRE) before scaling out.
 */
import type { ApolloServerPlugin, GraphQLRequestContextDidResolveOperation } from '@apollo/server'
import { GraphQLError, Kind, type FieldNode, type OperationDefinitionNode } from 'graphql'
import { HeaderMap } from '@apollo/server'
import type { GraphQLContext } from '../context.js'
import { logger } from '../lib/logger.js'

// Limits per Mutation ROOT FIELD name (requests per minute, per tenant)
export const MUTATION_LIMITS: Readonly<Record<string, number>> = {
  // Heavy — max 5/min per tenant
  triggerSync:             5,
  runAnomalyScanner:       5,
  createSyncSource:        5,
  deleteSyncSource:        5,
  exportReportPDF:         5,
  exportReportExcel:       5,
  testNotificationChannel: 5,
  // AI — max 10/min per tenant
  askReport:               10,
  // Moderate — max 30/min per tenant
  createIncident:          30,
  createChange:            30,
  createProblem:           30,
  createServiceRequest:    30,
  createKBArticle:         30,
  createUser:              30,
  executeChangeTransition: 30,
}

const WINDOW_MS = 60_000

interface Bucket { count: number; resetAt: number }

export interface RateLimitDecision { allowed: boolean; retryAfterSeconds: number; limit: number }

/**
 * Fixed-window counter store. Exported as a class so tests can use an
 * isolated instance with an injectable clock.
 */
export class RateLimitStore {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly limits: Readonly<Record<string, number>> = MUTATION_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit of `field` for `tenantId`. Fields without a limit are always allowed and not counted. */
  hit(tenantId: string, field: string): RateLimitDecision {
    const limit = this.limits[field]
    if (!limit) return { allowed: true, retryAfterSeconds: 0, limit: 0 }

    const key = `${tenantId}:${field}`
    const now = this.now()
    let bucket = this.buckets.get(key)
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + WINDOW_MS }
      this.buckets.set(key, bucket)
    }
    bucket.count++
    if (bucket.count > limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000), limit }
    }
    return { allowed: true, retryAfterSeconds: 0, limit }
  }

  /** Drops expired buckets (memory bound). */
  prune(): void {
    const now = this.now()
    for (const [key, bucket] of this.buckets) {
      if (now > bucket.resetAt) this.buckets.delete(key)
    }
  }

  get size(): number { return this.buckets.size }
}

/** Root field names of the operation (aliases ignored: the SCHEMA field is what costs). Fragments at root are expanded. */
export function rootFieldNames(operation: OperationDefinitionNode, fragments: GraphQLRequestContextDidResolveOperation<GraphQLContext>['document']['definitions'] = []): string[] {
  const fragmentMap = new Map<string, { selectionSet: OperationDefinitionNode['selectionSet'] }>()
  for (const def of fragments) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragmentMap.set(def.name.value, def)
  }
  const out: string[] = []
  const visit = (selectionSet: OperationDefinitionNode['selectionSet'], depth: number) => {
    if (depth > 10) return
    for (const sel of selectionSet.selections) {
      if (sel.kind === Kind.FIELD) out.push((sel as FieldNode).name.value)
      else if (sel.kind === Kind.INLINE_FRAGMENT) visit(sel.selectionSet, depth + 1)
      else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const frag = fragmentMap.get(sel.name.value)
        if (frag) visit(frag.selectionSet, depth + 1)
      }
    }
  }
  visit(operation.selectionSet, 0)
  return out
}

export class RateLimitedError extends GraphQLError {
  constructor(field: string, retryAfterSeconds: number, limit: number) {
    super(`Too many requests for ${field} (limit ${limit}/min per tenant). Try again in ${retryAfterSeconds} seconds.`, {
      extensions: {
        code: 'RATE_LIMITED',
        field,
        retryAfterSeconds,
        http: { status: 429, headers: new HeaderMap([['retry-after', String(retryAfterSeconds)]]) },
      },
    })
  }
}

/**
 * Builds the plugin. `store` is injectable for tests; the default is a
 * process-wide store pruned every minute.
 */
export function createGraphqlRateLimiterPlugin(store: RateLimitStore = defaultStore): ApolloServerPlugin<GraphQLContext> {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation(ctx) {
          const { operation, contextValue } = ctx
          if (!operation || operation.operation !== 'mutation') return

          // Verified identity from the resolved context — never from raw headers/claims.
          const tenantId = contextValue.tenantId
          const userId   = contextValue.userId
          if (!tenantId) {
            // The context builder rejects unauthenticated requests before this
            // hook; a missing tenant here is a wiring bug, not a client error.
            throw new Error('[graphqlRateLimiter] contextValue.tenantId is missing — plugin registered before auth?')
          }

          // Each limited root field counts once per request (aliasing the same
          // mutation N times in one document costs N).
          for (const field of rootFieldNames(operation, ctx.document.definitions)) {
            const decision = store.hit(tenantId, field)
            if (!decision.allowed) {
              logger.warn({ tenantId, userId, field, limit: decision.limit, retryAfterSeconds: decision.retryAfterSeconds }, 'GraphQL rate limit exceeded')
              throw new RateLimitedError(field, decision.retryAfterSeconds, decision.limit)
            }
          }
        },
      }
    },
  }
}

const defaultStore = new RateLimitStore()
setInterval(() => defaultStore.prune(), WINDOW_MS).unref()

export const graphqlRateLimiterPlugin: ApolloServerPlugin<GraphQLContext> = createGraphqlRateLimiterPlugin(defaultStore)
