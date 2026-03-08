export const typeDefs = `#graphql

  type Query {
    # Incidents
    incidents(status: String, severity: String, limit: Int, offset: Int): [Incident!]!
    incident(id: ID!): Incident

    # Problems
    problems(status: String, limit: Int, offset: Int): [Problem!]!
    problem(id: ID!): Problem

    # Changes
    changes(status: String, type: String, limit: Int, offset: Int): [Change!]!
    change(id: ID!): Change

    # Service Requests
    serviceRequests(status: String, priority: String, limit: Int, offset: Int): [ServiceRequest!]!
    serviceRequest(id: ID!): ServiceRequest

    # CMDB
    configurationItems(type: String, limit: Int, offset: Int): [ConfigurationItem!]!
    configurationItem(id: ID!): ConfigurationItem
    blastRadius(ciId: ID!, depth: Int): [ConfigurationItem!]!

    # Users
    me: User
  }

  type Mutation {
    # Incidents
    createIncident(input: CreateIncidentInput!): Incident!
    updateIncident(id: ID!, input: UpdateIncidentInput!): Incident!
    resolveIncident(id: ID!, rootCause: String): Incident!
    assignIncident(id: ID!, userId: ID!): Incident!

    # Problems
    createProblem(input: CreateProblemInput!): Problem!
    updateProblem(id: ID!, input: UpdateProblemInput!): Problem!
    resolveProblem(id: ID!, resolution: String!): Problem!
    linkIncidentToProblem(incidentId: ID!, problemId: ID!): Problem!

    # Changes
    createChange(input: CreateChangeInput!): Change!
    approveChange(id: ID!): Change!
    rejectChange(id: ID!, reason: String!): Change!
    deployChange(id: ID!): Change!
    failChange(id: ID!, reason: String!): Change!

    # Service Requests
    createServiceRequest(input: CreateServiceRequestInput!): ServiceRequest!
    updateServiceRequest(id: ID!, input: UpdateServiceRequestInput!): ServiceRequest!
    completeServiceRequest(id: ID!): ServiceRequest!

    # CMDB
    createConfigurationItem(input: CreateCIInput!): ConfigurationItem!
    updateConfigurationItem(id: ID!, input: UpdateCIInput!): ConfigurationItem!
    addCIDependency(fromId: ID!, toId: ID!, type: String!): Boolean!
  }

  type Incident {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    severity: String!
    status: String!
    createdAt: String!
    updatedAt: String!
    resolvedAt: String
    assignee: User
    affectedCIs: [ConfigurationItem!]!
    causedByProblem: Problem
  }

  type Problem {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    status: String!
    impact: String!
    rootCause: String
    workaround: String
    createdAt: String!
    updatedAt: String!
    resolvedAt: String
    relatedIncidents: [Incident!]!
    resolvedByChange: Change
  }

  type Change {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    type: String!
    risk: String!
    status: String!
    windowStart: String!
    windowEnd: String!
    createdAt: String!
    updatedAt: String!
    impactedCIs: [ConfigurationItem!]!
    relatedProblem: Problem
    causedIncidents: [Incident!]!
  }

  type ServiceRequest {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    status: String!
    priority: String!
    dueDate: String
    createdAt: String!
    updatedAt: String!
    completedAt: String
    requestedBy: User
    assignee: User
  }

  type ConfigurationItem {
    id: ID!
    tenantId: String!
    name: String!
    type: String!
    status: String!
    environment: String!
    createdAt: String!
    updatedAt: String!
    dependencies: [ConfigurationItem!]!
    dependents: [ConfigurationItem!]!
  }

  type User {
    id: ID!
    tenantId: String!
    email: String!
    name: String!
    role: String!
  }

  input CreateIncidentInput {
    title: String!
    description: String
    severity: String!
    affectedCIIds: [ID!]
  }

  input UpdateIncidentInput {
    title: String
    description: String
    severity: String
    status: String
  }

  input CreateProblemInput {
    title: String!
    description: String
    impact: String!
  }

  input UpdateProblemInput {
    title: String
    description: String
    status: String
    rootCause: String
    workaround: String
  }

  input CreateChangeInput {
    title: String!
    description: String
    type: String!
    risk: String!
    windowStart: String!
    windowEnd: String!
    impactedCIIds: [ID!]
  }

  input UpdateServiceRequestInput {
    title: String
    description: String
    status: String
    priority: String
    dueDate: String
  }

  input CreateServiceRequestInput {
    title: String!
    description: String
    priority: String!
    dueDate: String
  }

  input CreateCIInput {
    name: String!
    type: String!
    status: String!
    environment: String!
  }

  input UpdateCIInput {
    name: String
    status: String
    environment: String
  }
`
