# OpenGraphity API Reference

## Endpoints

| Method | Path | Description | Auth required |
|--------|------|-------------|---------------|
| `POST` | `/graphql` | GraphQL API (queries and mutations) | Yes |
| `GET` | `/health` | Health check — returns `{ ok: true }` | No |
| `GET` | `/api/sse` | Server-Sent Events for real-time notifications | Yes |
| `GET` | `/metrics` | Prometheus text metrics | No (internal) |
| `GET` | `/api/report-stream` | Report streaming endpoint | Yes |
| `POST` | `/api/webhooks/inbound/:hookId` | Inbound webhook (incident/problem creation, monitoring events) — see [Inbound webhooks](#inbound-webhooks-monitoring-events) | Yes (`Authorization: Bearer <token>`) |
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

### Monitored services (service maps)

Roles are enforced centrally by `lib/authorization.ts` (table pinned in
`lib/__tests__/authorization.test.ts`): reads for the staff
(`admin`, `operator`, `viewer`), the configuration tools and every mutation for
`admin` only. `end_user` (self-service portal) sees none of them.

| Query | Roles | Description |
|-------|-------|-------------|
| `serviceMaps(filter, limit, offset)` | staff | Service maps of the tenant, by severity (down, degraded, maintenance, unknown, operational), then impact score, then name; `counts` are tenant-wide. `limit` ≤ 500 (default 50) |
| `serviceMap(id)` | staff | Single map with `nodes`, `edges`, `explanation` (causes with the `via` path), `rules`, `history(limit)`, `historyCount`, `excluded`, `openIncident` (the service incident currently open, wave 3); `null` when the map is not in the tenant. `healthIfActive` is the health the service would have without the change window in progress (set only when `health = maintenance`), `staleReason` says why the map needs review (`missing_ci` / `over_limit`), and every `ServiceMapNode` carries `excludedReason` (`never` / `change_window` / `lifecycle_maintenance` / `unknown_health`, `null` when it counts) |
| `servicesImpactedByCI(ciId)` | staff | Maps that include the CI, by severity |
| `businessCapabilitiesHealth` | staff | Business capabilities with the health of the services that enable them (`ENABLED_BY` → BusinessApplication with a map): worst health of the linked services, `downServices` / `degradedServices`. Read-only |
| `serviceMapCandidates(search, limit)` | admin | BusinessApplications without a map (candidates for `createServiceMap`); `limit` ≤ 100 (default 20) |
| `serviceMapProposal(id)` | admin | Diff between the map and the graph as it is now — `added` / `removed` / `moved` / `excluded` / `totalProposed`; rebuilt with the map's own `maxDepth` and `relationshipTypes`, writes nothing |
| `serviceImpactPreview(id, rules, nodes)` | admin | Health and impact score the service would have with these settings, on the current alarms; writes nothing, a `ciId` outside the map is an error |

`Incident.impactedServices` (wave 3) lists the services whose health opened that
incident (`IMPACTS_SERVICE`); it is empty for incidents that do not come from a
service map.

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

### Monitored services

Every mutation below is `admin` only (`lib/authorization.ts`).

| Mutation | Description |
|----------|-------------|
| `createServiceMap(serviceId, maxDepth, relationshipTypes, status, autoSync)` | Build the map automatically from the BusinessApplication (REALIZES, then outgoing technical relationships up to `maxDepth`, default 4, max 8, cap 500 nodes) and evaluate it; `status` defaults to `active` (`draft` for a draft), `autoSync` defaults to `true` (live map). Refused with `BAD_USER_INPUT` when the tenant is at its plan limit (`max_service_maps`: starter 5, pro 50, enterprise 200) or when the service already has a map |
| `reevaluateServiceMap(id)` | Evaluate now (trigger `manual`) |
| `setServiceMapStatus(id, expectedVersion, status)` | `active` / `paused` / `draft` with optimistic concurrency; putting a map back in service (from `paused` **or** from `draft`) re-evaluates it at once |
| `updateServiceImpactRules(id, expectedVersion, rules)` | Save the impact rules (`degradedSharePct` ≤ `downSharePct`, `minNodes` ≤ number of components); history entry `rules_changed` with the changed fields, then immediate re-evaluation |
| `updateServiceMapNodes(id, expectedVersion, nodes)` | Change `propagate`, `weight` (1..10) and `critical` of the listed components only; empty list or unknown `ciId` → `BAD_USER_INPUT` |
| `applyServiceMapProposal(id, expectedVersion, add, exclude, remove)` | Apply the choices made on the diff in one transaction: `add` includes proposed CIs (`added_by: manual`), `exclude` never proposes them again (and removes them if included), `remove` drops included or vanished CIs; recomputes `node_ids` and `stale` |
| `removeServiceMapExclusion(id, expectedVersion, ciId)` | Let an excluded CI come back in the next proposal |
| `setServiceMapAutoSync(id, expectedVersion, autoSync)` | Live map (components follow the CMDB by themselves, the default) or frozen map (the diff is applied by hand). History entry `map_changed`; the map is **not** re-evaluated (nothing about its health changes). Writing the value it already has is a `BAD_USER_INPUT` |
| `syncServiceMap(id)` | Synchronize the components with the CMDB now: adds the new ones (`added_by: auto`), drops the automatic ones that are gone, updates `level`/`via`. Manually added components and exclusions are never touched, and neither are `propagate`/`weight`/`critical`. Works on frozen maps too (it is an explicit action), never on `paused` ones (`BAD_USER_INPUT`). Over the 500-component cap nothing is applied and the map is flagged `stale` with `staleReason: over_limit`. Returns **`ServiceMapSyncResult`** (`map`, `added`, `removed`, `moved`, `skipped`, `reason`), not the bare map: `skipped = true` means the cap refused the whole synchronization and `reason` says so |
| `deleteServiceMap(id)` | Delete the map and its history (service and CIs untouched) |

`ServiceMap` carries two fields for this: `autoSync: Boolean!` (live or frozen)
and `syncedAt: String` (last synchronization, `null` when it never happened).

All the configuration mutations take `expectedVersion` (the `version` read by
the client): a mismatch is a `BAD_USER_INPUT` naming the current version and
nothing is written — note that an automatic synchronization also bumps
`version`, so a stale client may hit the conflict without anyone else editing
the map. Each successful write bumps `version`, records
`updatedAt`/`updatedBy`, writes one history entry with a readable note and
re-evaluates the map immediately — except for `paused` maps, which are never
evaluated automatically, and for `setServiceMapAutoSync`. A synchronization
that changes nothing writes only `syncedAt`: no new version, no history entry.

Deleting the `BusinessApplication` itself (through the CI delete mutation of
its type) also deletes its map and history; the service incident already open
is kept (it is the ticket's history). See `docs/OPERATIONS.md`
§*Servizi monitorati* for the engine's behaviour, the plan limits, the metrics
and the retention of `ServiceHealthEntry` (cap 500 per map, no time-based
retention).

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

### Import (`/api/v1/import`)

Historical data importer for migrations from other ITSM tools. Both endpoints accept `multipart/form-data` with a `file` field containing the CSV (max 20MB, header row required) and an optional `?dryRun=true` query parameter. In dry-run mode the whole file is validated but nothing is written. In execute mode rows with errors are skipped (and reported) while valid rows are imported.

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/v1/import/incidents` | `incidents:write` | Import incidents from CSV |
| `POST` | `/api/v1/import/kb-articles` | `kb:write` | Import KB articles from CSV |

Idempotency: each row's `external_id` is stored as `import_external_id` on the node; re-running the same CSV updates the existing records (`updated`) instead of duplicating them.

**Incident CSV columns** — `external_id` (required, idempotency key), `title` (required), `description`, `severity` (free values mapped case-insensitively to low/medium/high/critical; unknown → warning + `medium`), `status` (matched case-insensitively against the tenant's incident workflow step names; unknown → warning + initial step), `number` (optional: preserved; collision with another incident → row error; generated progressively as `INC…` when absent), `created_at`/`updated_at`/`resolved_at` (ISO; invalid → row error), `assignee_email` (unknown user → warning, row still imported), `team_name` (unknown team → warning), `comments` (JSON array `[{author_email, text, created_at}]`).

**KB article CSV columns** — `external_id` (required), `title` (required), `body` (markdown), `category`, `tags` (separated by `;`), `status` (`published`/`draft`, default `draft`), `author_name`, `created_at`, `published_at`. The slug is generated from the title and deduplicated with `-2`, `-3`, … suffixes; on update the existing slug is kept.

```bash
# Dry-run: validate the file, nothing is written
curl -s -X POST "http://c-one.localhost/api/v1/import/incidents?dryRun=true" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@samples/import/incidents-sample.csv"

# Execute
curl -s -X POST "http://c-one.localhost/api/v1/import/incidents" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@samples/import/incidents-sample.csv"

# KB articles
curl -s -X POST "http://c-one.localhost/api/v1/import/kb-articles?dryRun=true" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@samples/import/kb-articles-sample.csv"
```

Response (`200`, same shape for both endpoints, top-level — not wrapped in `data`):

```json
{
  "totalRows": 6,
  "created": 4,
  "updated": 1,
  "errors":   [ { "row": 3, "externalId": "LEGACY-1003", "message": "created_at non è una data ISO valida: \"12/03/2024\"" } ],
  "warnings": [ { "row": 4, "externalId": "LEGACY-1004", "message": "assignee_email \"ghost.user@acme.it\" non trovato — assegnazione saltata" } ]
}
```

Request-level problems (missing/oversized file, malformed multipart, empty CSV) return `400` with `{ "error": { "code": "VALIDATION_ERROR", "message": "…" } }`.

The same importer is available from the CLI:

```bash
pnpm --filter @opengraphity/api import:incidents -- --file samples/import/incidents-sample.csv --tenant-id c-one --dry-run
pnpm --filter @opengraphity/api import:kb        -- --file samples/import/kb-articles-sample.csv --tenant-id c-one
```

---

## Inbound webhooks (monitoring events)

`POST /api/webhooks/inbound/:hookId` receives payloads from external systems. An inbound webhook is created in *Administration → Integrations* (or via `createInboundWebhook`) with an `entityType`: `incident` and `problem` create one ticket per request (flat `fieldMapping` → `201`); `event` is the Event Management source (`apps/api/src/rest/webhooks-inbound.ts`, operations guide in `OPERATIONS.md` §7).

| | |
|---|---|
| Auth | `Authorization: Bearer <token>` **only** — the token is shown once at creation and stored hashed; never in the query string |
| Rate limit | per source: `rateLimitPerMinute` on the `InboundWebhook` (1..10000, editable in *Monitoring → Sources*; **100** for webhooks created before the field — the only default), counted **after** authentication in a fixed one-minute window shared by every API replica (Redis key `og:webhook:rate:<tenant>:<hookId>:<minute>`, atomic INCR+EXPIRE). Over the limit → `429` with header **`Retry-After: <seconds to the end of the window>`** and body `{ "error": { "code": "RATE_LIMITED", "message": "Max N requests/min per webhook", "retry_after": <seconds> } }`; metric `webhook_rate_limited_total{connector}` |
| Body | `application/json` up to **2 MB** (`WEBHOOK_BODY_LIMIT`, parser mounted on the route itself so its errors reach the router's `restErrorHandler`), the payload exactly as the tool sends it; an optional `transformScript` runs first. Malformed JSON → `400`, body over 2 MB → `413`, both as `{ "error": { "code": "BAD_REQUEST", "message" } }` (`server.ts` skips its app-level `express.json()` for this path: in Express 4 an error raised outside the router would bypass it and fall to the default HTML handler) |
| Transform script | at most **4 isolates per replica** run at the same time; further requests wait in a FIFO queue up to **10 s**, then `503` with `Retry-After: 5` and `{ "error": { "code": "SERVICE_UNAVAILABLE", … } }` — nothing was accepted, the sender retries (no `last_error` on the source: the payload is not at fault) |
| Event limit | at most **500 alerts per request** (Alertmanager/Grafana `alerts[]`); more → `400` |
| Response (`event`) | **`202 Accepted`** `{ "id": "<hookId>", "entity_type": "event", "accepted": N, "rejected": [ { "index": i, "error": "…" } ] }` as soon as the N normalised events are queued on `events-ingest`; dedup, CI matching, health and correlation happen asynchronously. **Partial acceptance**: every element of an Alertmanager/Grafana batch is normalised on its own — the valid ones are queued, the invalid ones are listed in `rejected` (index in `alerts[]`, reason), recorded on the source (`last_error` = `"N di M scartati: <first reason>"`, `error_count` += N) and counted in `events_rejected_total{connector}`. Nothing is invented for a rejected element |
| Errors | `400 BAD_REQUEST` when **no** element is acceptable, with the offending field (`alerts[0].labels.severity value "page" is not mapped (value_mapping.severity) and is not one of: info, warning, critical`; for a batch `2 di 2 scartati: …`), recorded on the webhook as `last_error`/`error_count`; `401` missing/invalid token; `404` unknown or disabled webhook; `413` body too large; `429` rate limited (see above); `503` transform capacity exhausted (see above); `500` queue or Redis unavailable — the sender must retry, nothing was accepted (Redis down never disables the rate limit) |

```bash
curl -s -X POST "http://c-one.localhost/api/webhooks/inbound/$HOOK_ID" \
  -H "Authorization: Bearer $HOOK_TOKEN" -H "Content-Type: application/json" \
  -d @alertmanager-payload.json
# → 202 {"id":"…","entity_type":"event","accepted":2,"rejected":[]}
# → 202 {"id":"…","entity_type":"event","accepted":1,"rejected":[{"index":1,"error":"alerts[1].labels.instance is missing or empty and default_values.resource is not set (…)"}]}
```

Normalised event (what every connector produces): `status` (`firing`|`resolved`), `severity` (`info`|`warning`|`critical`), `title`, `resource` + `resourceKind` (`hostname`|`ip`|`fqdn`|`external_id`|`name`, matched against CI aliases then CI names), optional `externalId` (the **alert's** id at the source: dedup key when present), optional `resourceExternalId` (the **resource's** id at the source — Dynatrace `entity`, Zabbix `host_id`, generic `fieldMapping.resourceExternalId` — stored as `Event.resource_external_id`, exposed as `Event.resourceExternalId` and `NormalizedEventPreview.resourceExternalId`, and the value compared with a CI alias of kind `external_id`), `description`, `labels`, `startsAt`/`endsAt`. The fingerprint is `sha256(source + externalId)` or `sha256(source + title + resource + sorted labels)`; the same alert repeating increments `count` instead of creating a node. `Event.severity` is the severity of the **last** payload (the CI health follows the source); `Event.maxSeverity` keeps the highest one seen in the current cycle (null on events written before the field). A `resolved` payload for an alert never seen before creates the Event already resolved with `firstSeenAt = startsAt` of the source (or the receive time) and publishes no `event.resolved`/`event.orphan` (`events_resolved_unknown_total{connector}`).

**Rules valid for every connector** (`InboundWebhook.valueMapping` / `defaultValues`, editable in *Monitoring → Sources* — "Rules" for the preset tools, the visual mapper for `generic`):

- `valueMapping` `{ severity: { <sourceValue>: info|warning|critical }, status: { <sourceValue>: firing|resolved } }` — source values are matched case-insensitively, **before** the connector's built-in table (Alertmanager `page` → `critical`, Zabbix `Average` → `critical`, Datadog `Muted` → `resolved`). A value neither mapped nor in the vocabulary rejects the element with a message naming `value_mapping.<field>`.
- `defaultValues` for the preset connectors accepts only `severity` (used when the payload has none), `resource` + `resourceKind` (both required together: the resource used when the alert carries none — Alertmanager alerts without `instance`, Datadog monitors without `hostname`), and `resourceFrom` (`datadog` only: `"alert_scope"` uses `$ALERT_SCOPE` as a `name` resource when `$HOSTNAME` is empty, before `defaultValues.resource`). Any other key is rejected at save time. Without these an alert without a resource is rejected with the remedy in the message — never a resource invented by the code.

| `connectorKind` | Payload shape | Fields read |
|---|---|---|
| `alertmanager` | `{ alerts: [ … ] }` (Alertmanager webhook receiver) | `alerts[].status`, `labels.alertname` (title), `labels.severity` (free text: `valueMapping.severity`), `labels.instance` (port stripped, IPv6 brackets stripped: `[::1]:9100` → `::1`; absent → `defaultValues.resource`), `annotations.summary/description`, `fingerprint`, `startsAt/endsAt` |
| `grafana` | `{ alerts: [ … ] }` (unified alerting webhook contact point) | same as Alertmanager; `labels.host` when `labels.instance` is absent |
| `zabbix` | one object per request (media type *Webhook*) | `event_id`, `event_name`/`trigger_name`, `event_severity` (Not classified/Information→info, Warning/Average→warning, High/Disaster→critical), `event_value` (`1` problem / `0` recovery), `host_name` or `host_ip` (absent → `defaultValues.resource`), `host_id` (→ `resourceExternalId`), `event_date` + `event_time` (`{EVENT.DATE} {EVENT.TIME}`, local time of the Zabbix server: converted to ISO with `Tenant.timezone`; not convertible → `startsAt` empty and the raw text in `labels.event_time`), `trigger_description`, `event_opdata` |
| `datadog` | one object per request (webhook integration) | `alert_cycle_key` (`$ALERT_CYCLE_KEY`, the alert's identity: one per trigger→resolve cycle; absent → `alert_id@resource`, so the hosts of a multi-alert monitor stay separate), `alert_id` (monitor id, kept in `labels.alert_id`), `alert_scope` (`labels.alert_scope`; resource when `hostname` is empty and `defaultValues.resourceFrom = "alert_scope"`), `alert_transition` (Triggered/Re-Triggered/Warn/Re-Warn/No Data/Re-No Data/Renotify→firing, Recovered/Warn Recovered→resolved — the values documented for `$ALERT_TRANSITION`), `alert_type` (error→critical, warning→warning, info/success→info; others rejected unless mapped), `title`, `body`/`text`, `hostname`, `tags` (`key:value` list, CSV or object), `date` |
| `dynatrace` | one problem per request (Problem notification, custom integration) | `PID`/`ProblemID`, `State` (OPEN/RESOLVED), `ProblemTitle`, `ProblemSeverity` (AVAILABILITY/ERROR→critical, PERFORMANCE/RESOURCE_CONTENTION/CUSTOM_ALERT→warning, MONITORING_UNAVAILABLE→info), `ImpactedEntities[0]` (`name`; `type` HOST → `resourceKind` hostname, otherwise name; `entity` → `resourceExternalId`) or `ImpactedEntity` with a recognised type prefix stripped (`Host web-02` → hostname `web-02`, `Service checkout` → name `checkout`; an unknown prefix such as `3 impacted entities` is rejected), `ProblemDetailsText`, `ProblemImpact`, `ProblemURL`, `Tags` |
| `generic` | any JSON object, one event per request | `fieldMapping` `{ normalizedField: "dotted.path" }` (unmapped field → same-named root key; fields: `title`, `severity`, `status`, `resource`, `resourceKind`, `resourceExternalId`, `externalId`, `description`, `labels`, `startsAt`, `endsAt`), `defaultValues` for missing fields (`resourceKind` is required here or in the payload), `valueMapping` as above; `labels` accepts an object, a `["key:value"]` list or a CSV string |

`sampleInboundPayload(connectorKind)` returns a realistic payload for each connector, `previewInboundEvents` normalises a pasted payload without ingesting it, `sendSampleEvent(sourceId)` pushes the sample through the real pipeline.

Console reads: `events(filter, limit ≤ 500, offset)` returns page and `total` from one query, with `ci`, `source`, `incident` and `acknowledgedBy` resolved with the row; `filter.search` goes through the `event_search` full-text index (title + resource; every word must appear as a substring of a token, case-insensitive — `example` and `local` both find `api-03.example.local`). `Incident.correlatedEvents(limit = 100 ≤ 500, offset)` and `Change.suppressedEvents(limit, offset)` are paginated (a storm incident aggregates thousands of alerts); the totals are `correlatedEventCount` / `suppressedEventCount`.

---

## Schema Reference

The full SDL schema is exported to [graphql-schema.graphql](./graphql-schema.graphql).

To regenerate it:

```bash
pnpm tsx apps/api/src/scripts/export-schema.ts
```
