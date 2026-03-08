import { incidentResolvers } from './incident.js'
import { cmdbResolvers } from './cmdb.js'
import type { GraphQLContext } from '../../context.js'

// ── Stub resolver helpers ────────────────────────────────────────────────────

const notImplemented = (name: string) => () => {
  throw new Error(`${name} not yet implemented`)
}

// ── Problem stubs ─────────────────────────────────────────────────────────────

const problemQueryStubs = {
  problems: (_: unknown, __: unknown, ___: GraphQLContext) => [],
  problem:  (_: unknown, __: unknown, ___: GraphQLContext) => null,
}

const problemMutationStubs = {
  createProblem:          notImplemented('createProblem'),
  updateProblem:          notImplemented('updateProblem'),
  resolveProblem:         notImplemented('resolveProblem'),
  linkIncidentToProblem:  notImplemented('linkIncidentToProblem'),
}

const problemFieldStubs = {
  Problem: {
    relatedIncidents: () => [],
    resolvedByChange: () => null,
  },
}

// ── Change stubs ──────────────────────────────────────────────────────────────

const changeQueryStubs = {
  changes: (_: unknown, __: unknown, ___: GraphQLContext) => [],
  change:  (_: unknown, __: unknown, ___: GraphQLContext) => null,
}

const changeMutationStubs = {
  createChange: notImplemented('createChange'),
  approveChange: notImplemented('approveChange'),
  rejectChange:  notImplemented('rejectChange'),
  deployChange:  notImplemented('deployChange'),
  failChange:    notImplemented('failChange'),
}

const changeFieldStubs = {
  Change: {
    impactedCIs:     () => [],
    relatedProblem:  () => null,
    causedIncidents: () => [],
  },
}

// ── ServiceRequest stubs ──────────────────────────────────────────────────────

const requestQueryStubs = {
  serviceRequests: (_: unknown, __: unknown, ___: GraphQLContext) => [],
  serviceRequest:  (_: unknown, __: unknown, ___: GraphQLContext) => null,
}

const requestMutationStubs = {
  createServiceRequest:  notImplemented('createServiceRequest'),
  updateServiceRequest:  notImplemented('updateServiceRequest'),
  completeServiceRequest: notImplemented('completeServiceRequest'),
}

const requestFieldStubs = {
  ServiceRequest: {
    requestedBy: () => null,
    assignee:    () => null,
  },
}

// ── me stub ───────────────────────────────────────────────────────────────────

const meStub = {
  me: (_: unknown, __: unknown, ctx: GraphQLContext) => ({
    id:       ctx.userId,
    tenantId: ctx.tenantId,
    email:    ctx.userEmail,
    name:     ctx.userEmail,
    role:     ctx.role,
  }),
}

// ── Combined resolvers ────────────────────────────────────────────────────────

export const resolvers = {
  Query: {
    ...incidentResolvers.Query,
    ...cmdbResolvers.Query,
    ...problemQueryStubs,
    ...changeQueryStubs,
    ...requestQueryStubs,
    ...meStub,
  },
  Mutation: {
    ...incidentResolvers.Mutation,
    ...cmdbResolvers.Mutation,
    ...problemMutationStubs,
    ...changeMutationStubs,
    ...requestMutationStubs,
  },
  Incident:            incidentResolvers.Incident,
  ConfigurationItem:   cmdbResolvers.ConfigurationItem,
  ...problemFieldStubs,
  ...changeFieldStubs,
  ...requestFieldStubs,
}
