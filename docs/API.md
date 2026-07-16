# OpenGraphity API Reference

## Endpoints

| Method | Path | Description | Auth required |
|--------|------|-------------|---------------|
| `POST` | `/graphql` | GraphQL API (queries and mutations) | Yes |
| `GET` | `/health` | Health check — returns `{ ok: true }` | No |
| `GET` | `/api/sse` | Server-Sent Events for real-time notifications | Yes |
| `GET` | `/metrics` | Prometheus text metrics | No (internal) |
| `GET` | `/api/report-stream` | Report streaming endpoint | Yes |
| `*` | `/api/v1/*` | REST API v1 (API key auth) — see [REST API v1](#rest-api-v1) | Yes (`X-API-Key`) |

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

## REST API v1

All `/api/v1/*` routes authenticate with an API key (created via the `createApiKey` GraphQL mutation) sent in the `X-API-Key` header. Responses are JSON: `{ "data": ... }` on success (lists add `"meta": { page, limit, total }`), `{ "error": { "code", "message" } }` on failure. Requests are rate-limited per key.

```http
GET /api/v1/changes HTTP/1.1
Host: c-one.localhost
X-API-Key: og_live_...
```

### Changes (`/api/v1/changes`)

RFC-based change process. A change is created against one or more CIs (each CI must have an Owner Group and a Support Group); creation bootstraps the functional/technical assessment tasks, the deploy plan task per CI and the workflow instance. The `phase` field is the current workflow step of the change (from the workflow definition — e.g. `assessment`, `approval`, `scheduled`, `deployment`, `review`, `closed` in the default RFC workflow).

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/v1/changes` | `changes:read` | Paginated list. Query: `page`, `limit`, `phase` (filter by current workflow step) |
| `GET` | `/api/v1/changes/:id` | `changes:read` | Change detail, including `affectedCIs` with per-CI task states |
| `POST` | `/api/v1/changes` | `changes:write` | Create an RFC change (same logic as the GraphQL `createChange` mutation) |
| `GET` | `/api/v1/changes/:id/tasks` | `changes:read` | All tasks of the change (functional/technical assessment, planning, validation, deployment, review) |
| `POST` | `/api/v1/changes/:id/transition` | `changes:write` | Execute a workflow transition (guards apply; `400` if not available) |
| `GET` | `/api/v1/changes/:id/status` | `changes:read` | Compact status: `code`, `phase`, `approvalStatus`, `deployApproved` |

#### `GET /api/v1/changes`

```bash
curl -s "http://c-one.localhost/api/v1/changes?page=1&limit=20&phase=assessment" \
  -H "X-API-Key: $API_KEY"
```

```json
{
  "data": [
    {
      "id": "6f0c…", "code": "CHG00000042",
      "title": "Upgrade DB", "description": null,
      "requester": { "id": "…", "name": "Mario Rossi", "email": "mario@acme.it" },
      "changeOwner": { "id": "…", "name": "Anna Bianchi", "email": "anna@acme.it" },
      "phase": "assessment",
      "aggregateRiskScore": null,
      "approvalRoute": null, "approvalStatus": null,
      "createdAt": "2026-07-15T09:00:00.000Z", "updatedAt": "2026-07-15T09:00:00.000Z"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1 }
}
```

#### `GET /api/v1/changes/:id`

Same fields as the list item, plus `affectedCIs` — one entry per impacted CI with its risk score and the state of every task of the RFC lifecycle:

```json
{
  "data": {
    "id": "6f0c…", "code": "CHG00000042", "phase": "deployment",
    "affectedCIs": [
      {
        "ciId": "ci-1", "ciName": "App Portale", "riskScore": 40,
        "tasks": {
          "functional": { "code": "TASK00000010", "status": "completed" },
          "technical":  { "code": "TASK00000011", "status": "completed" },
          "planning":   { "code": "TASK00000012", "status": "completed" },
          "validation": { "code": "TASK00000020", "status": "pending", "result": null },
          "deployment": { "code": "TASK00000021", "status": "pending" },
          "review":     null
        }
      }
    ]
  }
}
```

Tasks that have not been created yet (e.g. validation/deployment before the deployment step, review before the review step) are `null`.

#### `POST /api/v1/changes`

Body: `title` (required), `description`, `changeOwner` (required, user id), `affectedCIIds` (required, non-empty array of CI ids). Every CI must have an Owner Group and a Support Group — otherwise `400` with the offending CI in the message.

```bash
curl -s -X POST "http://c-one.localhost/api/v1/changes" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Upgrade DB cluster",
    "description": "Minor version upgrade",
    "changeOwner": "<user-id>",
    "affectedCIIds": ["<ci-id-1>", "<ci-id-2>"]
  }'
```

Returns `201` with the same shape as `GET /api/v1/changes/:id`. Validation failures return `400`:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "CI DB Prod manca di Owner Group o Support Group" } }
```

#### `GET /api/v1/changes/:id/tasks`

```bash
curl -s "http://c-one.localhost/api/v1/changes/<id>/tasks" -H "X-API-Key: $API_KEY"
```

```json
{
  "data": [
    {
      "id": "…", "code": "TASK00000010", "type": "functional", "status": "completed",
      "ci": { "id": "ci-1", "name": "App Portale" },
      "assignedTeam": { "id": "team-a", "name": "Platform" },
      "completedBy": { "id": "…", "name": "Mario Rossi", "email": "mario@acme.it" },
      "completedAt": "2026-07-15T10:00:00.000Z"
    }
  ]
}
```

`type` is one of `functional` (CI Owner Group assessment), `technical` (Support Group assessment), `planning` (deploy plan), `validation`, `deployment`, `review`.

#### `POST /api/v1/changes/:id/transition`

Body: `toStep` (required, target workflow step name), `notes` (optional). Reuses the workflow engine: guards are enforced (e.g. all assessments completed before approval, deploy plan present before scheduling). If the transition is not available the response is `400` with the guard's message.

```bash
curl -s -X POST "http://c-one.localhost/api/v1/changes/<id>/transition" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "toStep": "scheduled", "notes": "CAB approved" }'
```

```json
{ "data": { "id": "…", "code": "CHG00000042", "phase": "scheduled", "...": "..." } }
```

```json
{ "error": { "code": "TRANSITION_NOT_AVAILABLE", "message": "Transizione non disponibile: …" } }
```

#### `GET /api/v1/changes/:id/status`

```bash
curl -s "http://c-one.localhost/api/v1/changes/<id>/status" -H "X-API-Key: $API_KEY"
```

```json
{ "data": { "code": "CHG00000042", "phase": "deployment", "approvalStatus": null, "deployApproved": true } }
```

`deployApproved` is `true` when the current workflow step is at or past the deployment step (compared via `step_order` metadata on the workflow definition, not hardcoded step names).

---

## Schema Reference

The full SDL schema is exported to [graphql-schema.graphql](./graphql-schema.graphql).

To regenerate it:

```bash
pnpm tsx apps/api/src/scripts/export-schema.ts
```
