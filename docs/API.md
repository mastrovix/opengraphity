# OpenGraphity API Reference

## Endpoints

| Method | Path | Description | Auth required |
|--------|------|-------------|---------------|
| `POST` | `/graphql` | GraphQL API (queries and mutations) | Yes |
| `GET` | `/health` | Health check — returns `{ ok: true }` | No |
| `GET` | `/api/sse` | Server-Sent Events for real-time notifications | Yes |
| `GET` | `/metrics` | Prometheus text metrics | No (internal) |
| `GET` | `/api/report-stream` | Report streaming endpoint | Yes |

---

## Authentication

All `/graphql` and `/api/sse` requests require a Keycloak Bearer token.

```http
POST /graphql HTTP/1.1
Host: c-one.localhost
Authorization: Bearer <access_token>
Content-Type: application/json

{ "query": "{ me { id email } }" }
```

To obtain a token:

```bash
curl -s -X POST \
  "http://localhost:8080/realms/<realm>/protocol/openid-connect/token" \
  -d "client_id=<client>" \
  -d "username=<user>" \
  -d "password=<pass>" \
  -d "grant_type=password" \
  | jq -r .access_token
```

---

## GraphQL Explorer (development)

The Apollo Sandbox is available at `http://localhost:4000/graphql` in development mode.

---

## Main Queries

### Incidents

| Query | Description |
|-------|-------------|
| `incidents(status, severity, limit, offset, filters, sortField, sortDirection)` | List incidents with filtering and pagination |
| `incident(id)` | Get a single incident by ID |
| `incidentWorkflow(incidentId)` | Current workflow state |
| `incidentWorkflowHistory(incidentId)` | Step execution history |
| `incidentAvailableTransitions(incidentId)` | Allowed next steps |

### Changes

| Query | Description |
|-------|-------------|
| `changes(status, type, priority, search, limit, offset, ...)` | List changes |
| `change(id)` | Get a single change |
| `changeTasks(changeId, taskType)` | Tasks for a change |
| `changeImpactAnalysis(ciIds)` | Blast-radius impact |

### Problems

| Query | Description |
|-------|-------------|
| `problems(limit, offset, status, priority, search, ...)` | List problems |
| `problem(id)` | Get a single problem |

### Service Requests

| Query | Description |
|-------|-------------|
| `serviceRequests(status, priority, limit, offset, filters)` | List service requests |
| `serviceRequest(id)` | Get a single service request |

### CMDB

| Query | Description |
|-------|-------------|
| `allCIs(limit, offset, type, environment, status, search, ...)` | All configuration items |
| `ciById(id)` | Single CI |
| `blastRadius(id)` | Downstream impact of a CI |
| `ciIncidents(ciId)` | Incidents linked to a CI |
| `ciChanges(ciId)` | Changes linked to a CI |
| `ciTypes` | All registered CI type definitions |
| `topology(types, environment, status, selectedCiId, maxHops)` | Topology graph data |

### Teams and Users

| Query | Description |
|-------|-------------|
| `teams(filters)` | List teams |
| `team(id)` | Single team |
| `me` | Current authenticated user |
| `users` | All users for tenant |
| `user(id)` | Single user |

### Workflow

| Query | Description |
|-------|-------------|
| `workflowDefinitions(entityType)` | All workflow definitions |
| `workflowDefinition(entityType)` | Definition for entity type |
| `workflowDefinitionById(id)` | Definition by ID |

### Anomalies

| Query | Description |
|-------|-------------|
| `anomalies(status, severity, ruleKey, limit, offset, ...)` | List detected anomalies |
| `anomaly(id)` | Single anomaly |
| `anomalyStats` | Aggregate anomaly statistics |
| `anomalyScanStatus` | Status of last scan |

### Discovery / CMDB Sync

| Query | Description |
|-------|-------------|
| `syncSources` | Configured sync sources |
| `syncRuns(sourceId, limit)` | Run history for a source |
| `syncConflicts(sourceId, status, limit)` | Pending conflicts |
| `syncStats` | Aggregate sync statistics |
| `availableConnectors` | Registered connector types |

### Reporting and Logs

| Query | Description |
|-------|-------------|
| `reportConversations` | AI analysis conversations |
| `reportTemplates` | Custom report templates |
| `executeReport(templateId)` | Run a report template |
| `myDashboards` | Current user's dashboards |
| `logs(level, module, search, limit, offset)` | Application logs |
| `enumTypes(scope)` | Dictionary/enum definitions |
| `auditLog(page, pageSize, action, entityType, fromDate, toDate)` | Audit log |
| `queueStats` | BullMQ queue depths |

---

## Main Mutations

### Incidents

| Mutation | Description |
|----------|-------------|
| `createIncident(input)` | Open a new incident |
| `updateIncident(id, input)` | Update incident fields |
| `resolveIncident(id, rootCause)` | Mark as resolved |
| `assignIncidentToTeam(id, teamId)` | Assign to team |
| `assignIncidentToUser(id, userId)` | Assign to user |
| `addIncidentComment(id, text)` | Add a comment |
| `addAffectedCI / removeAffectedCI` | Link/unlink CIs |

### Changes

| Mutation | Description |
|----------|-------------|
| `createChange(input)` | Create a new change |
| `approveChange(id)` / `rejectChange(id, reason)` | CAB approval |
| `deployChange(id)` / `failChange(id, reason)` | Deployment outcome |
| `executeChangeTransition(instanceId, toStep, notes)` | Manual workflow step |
| `saveDeploySteps(changeId, steps)` | Define deployment plan |
| `updateDeployStepStatus(stepId, status, notes)` | Update step status |

### Problems

| Mutation | Description |
|----------|-------------|
| `createProblem(input)` | Open a problem record |
| `executeProblemTransition(problemId, toStep, notes)` | Workflow transition |
| `linkIncidentToProblem(problemId, incidentId)` | Associate incident |

### CMDB

| Mutation | Description |
|----------|-------------|
| `assignCIOwner(ciId, teamId)` | Set owning team |
| `assignCISupportGroup(ciId, teamId)` | Set support team |
| `createCI(input)` | Create configuration item (dynamic, per type) |

### Discovery

| Mutation | Description |
|----------|-------------|
| `createSyncSource(input)` | Register a new sync source |
| `deleteSyncSource(id)` | Remove a source |
| `triggerSync(sourceId)` | Run a sync immediately |
| `testSyncConnection(sourceId)` | Test connector credentials |
| `resolveConflict(conflictId, resolution)` | Resolve a CMDB conflict |

### Dictionary

| Mutation | Description |
|----------|-------------|
| `createEnumType(input)` | Create dictionary type |
| `updateEnumType(id, input)` | Update label/values |
| `deleteEnumType(id)` | Delete (non-system only) |

---

## Schema Reference

The full SDL schema is exported to [graphql-schema.graphql](./graphql-schema.graphql).

To regenerate it:

```bash
pnpm tsx apps/api/src/scripts/export-schema.ts
```
