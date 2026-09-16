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
| `change(id) { assessmentOwner assessmentSupport deployPlan }` | Tasks of a change: they are **fields of `Change`**, not a query. Revisione totale · H-25: `changeTasks(changeId, taskType)` never existed in the schema |
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
| `serviceRequest(id)` | Get a single service request, with `affectedCIs` (the CIs it concerns) |

### CMDB

| Query | Description |
|-------|-------------|
| `allCIs(limit, offset, type, environment, status, search, ciTypes, excludeCiTypes, ...)` | All configuration items. `ciTypes` keeps only those types, `excludeCiTypes` removes them (type name or label); an unknown type is an error |
| `ciById(id)` | Single CI |
| `blastRadius(id)` | Downstream impact of a CI, along the tenant's impact relationships (the shipped ones plus those its own CI types declare) |
| `ciIncidents(ciId)` / `ciProblems(ciId)` / `ciChanges(ciId)` / `ciServiceRequests(ciId)` | Tickets linked to a CI |
| `ticketCIExclusions(ticketType)` | CI types that a ticket type (`incident`, `problem`, `change`, `service_request`) may not involve; without the argument, all four |
| `ciTypes` | CI type definitions **visible to the caller's tenant**: the shared ones (`tenant_id = 'system'`, shipped with the product and read-only) plus the tenant's own. A type another customer created is never returned. See `docs/CUSTOMIZATION.md` |
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
| `anomalyRules` / `anomalyRuleOptions` | The tenant's anomaly rule configuration and the CI types, relations and severities to choose from (admin) |
| `widgetCatalog` | Entities and fields a dashboard widget can use, from the tenant's metamodel |
| `impactAnalysisWeights` | Points and time windows of the change impact analysis (admin) |
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
| `monitoringSource(id)` | admin | One monitoring source with its full configuration (edit page); `null` when it does not exist in the tenant. Opening one no longer requires reading them all |
| `serviceMaps(filter, limit, offset)` | staff | Service maps of the tenant, by severity (down, degraded, maintenance, unknown, operational), then impact score, then name; `counts` are tenant-wide. `limit` ≤ 500 (default 50). `ServiceMapFilter` = `health`, `status`, `search`, plus `criticality: [String!]` (of the root business application: `mission_critical`, `business_critical`, `business_operational`, `office_productivity` — an unknown value is a `BAD_USER_INPUT`) and `ciId: ID` (only the services whose map includes that CI) |
| `serviceMap(id)` | staff | Single map with `nodes`, `edges`, `explanation` (causes with the `via` path), `rules`, `history(limit)`, `historyCount`, `excluded`, `openIncident` (the service incident currently open, wave 3), `incidentProblem` (why the monitoring could not bring the service incident up to date — `key`/`params` of the error, the English `message`, `since`; `null` when it is fine, review of 15 Sep 2026 · SV-4); `null` when the map is not in the tenant. `healthIfActive` is the health the service would have without the change window in progress (set only when `health = maintenance`), `healthNote` explains the health when the causes are not enough (a storming source with `duringStorm = hold`, or components inside an upstream change window — review 2, wave 3), `staleReason` says why the map needs review (`missing_ci` / `over_limit`), and every `ServiceMapNode` carries `excludedReason` (`never` / `lifecycle_decommissioned` / `change_window` / `upstream_change_window` / `lifecycle_maintenance` / `unknown_health`, `null` when it counts) |
| `servicesImpactedByCI(ciId)` | staff | Maps that include the CI, by severity |
| `businessCapabilitiesHealth` | staff | Business capabilities with the health of the services that enable them (`ENABLED_BY` → BusinessApplication with a map): worst health of the linked services, `downServices` / `degradedServices`. Read-only |
| `serviceMapCreationPreview(serviceId, maxDepth, relationshipTypes)` | admin | The components a new map would have with these settings (`nodes` with level and role): the same build as `createServiceMap`, writes nothing. «Create a map» shows it before creating |
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
| `executeReport(templateId, language)` | Run a report template. `language` (`en`/`it`, optional) is the reader's language for the value labels — dictionary values and workflow steps; empty = the organization's language, an unknown language is refused (`errors.enum.unknownLanguage`) |
| `previewReportSection(input, language)` | Run one section without saving it (same `language`) |
| `DashboardWidget.data(language)` / `DashboardWidget.error(language)` | A widget's result with the value labels in the viewer's language (same rule). The web passes the language it is showing |
| `ticketOLAs(entityType, entityId)` | The OLA/UC contracts of a ticket's type (enabled, own type or `any`), measured as **team time**: when it counts, `applies` with `usedMinutes`, `remainingMinutes`, `state` (`running` with `deadline` if the team keeps the ticket, `handed_off`, `met`, `breached`, `scheduled` before a deploy plan window opens) and `inferred`; otherwise `reason` (`other_team`: the team never had it; `before_contract`: only before the contract existed). On a change a contract returns one row per measure of its tasks that counts (`unitKind` `assessment` / `validation` / `release`, with `unitKey`, `ciName`, `responderRole`, `stepTitle`, `startsAt`). Same rule as the report and the alerts |
| `slaReport(...)` | SLA and OLA attainment. An OLA counts the tickets of the contract's entity type (`any` = incident, problem, change, service request) **concluded** in the period that its team had at least once; a ticket meets it when the team time stayed within `resolveMinutes`. `OLAAttainmentRow.inferred` counts the evaluations whose time was reconstructed from ticket opening |
| `myDashboards` | Current user's dashboards |
| `logs(level, module, search, limit, offset)` | Application logs |
| `enumTypes(scope)` | Dictionary definitions **visible to the caller's tenant**: the tenant's own, plus the shipped ones (`is_system = true` **and** `tenant_id = 'system'`). Shipped dictionaries are one node for every customer: a tenant customises one with `customizeEnumType`, which makes a copy of its own that wins by name. See `docs/CUSTOMIZATION.md` |
| `auditLog(page, pageSize, action, entityType, fromDate, toDate)` | Audit log |
| `queueStats` | BullMQ queue depths. Every `QueueStat` carries `group` (`events` / `services` / `itsm` / `platform`: the subsystem, from the API's single queue registry) and `retryable` (whether `retryQueueJob` accepts jobs of that queue — the four domain-consumer queues are not retryable from the UI: an exhausted event must be re-emitted by its producer). The Queues page groups by `group` and shows the retry button only where `retryable` is true; no queue name is hard-coded in the web |
| `queueJobs(queueName, status, limit)` | Jobs of one registered queue (`Unknown queue` for a name outside the registry) |

**OLA/UC contracts.** `deleteOLAContract(id)` (`config.sla`) deletes a contract; the Audit Log entry `ola_contract.deleted` keeps it as it was.

**Team time** (second UI tour, 15 Sep 2026, `lib/olaAttainment.ts` — one rule for the ticket card, the report and the alerts). A contract measures the time the ticket was assigned to **its team**: the sum of the assignment periods to that team, counted from when the contract exists until the ticket is concluded (or now), on the contract's calendar in the organization's timezone. The SLA pause does not stop it. **Changes are measured on their tasks** (owner's decision, `lib/olaChangeUnits.ts`): a change has no team, its tasks do. Each assessment task is one measure (team time of the task, with its own assignment history, until it is completed). Each step of the deploy plan gives two: **validation**, from the start of its validation window until the validation test is recorded, for the CI's owner team, and **release**, from the start of its release window until the deployment is marked done, for the CI's support team (the teams that may complete those tasks). Before the window opens the time does not run (`scheduled`); done before it counts zero; a window not planned yet measures nothing. In the report each measure is one evaluation. Every write of a ticket's or change task's team goes through `assignTeamCypher` (or `firstTeamCypher` for a task that is being created) (`lib/ticketTeamHistory.ts`, guarded by a test): it replaces `ASSIGNED_TO_TEAM`, closes the open `TicketTeamSegment` of the previous team and opens one for the new team (`(ticket)-[:TEAM_SEGMENT]->(:TicketTeamSegment {team_id, started_at, ended_at, inferred})`). Tickets that had a team before the history existed got one segment from their opening, `inferred: true` (migration `20260930_1030_ticket_team_segments`); the card and the report say so; assessment tasks and deploy plans got the same from their creation (migration `20260930_1040_change_task_team_segments`). A contract without a team counts from ticket opening for any team.

**OLA/UC alerts.** No timer is armed per ticket any more: the API worker runs a sweep every minute (`ola_sweep`). For each enabled contract with a team it reads the open tickets of its type currently assigned to that team and not yet alerted for it (on a change: the open measures of its tasks for that team, marked on the task with `contractId` or `contractId:unitKey`), measures the team time with the rules in force now (target, calendar, timezone), and when it exceeds the target it writes the contract id into `ticket.ola_alerted` and publishes `ola.breached` (`used_minutes`, `target_minutes`, `contract_id`, …) — once per contract and ticket. So a ticket that reaches the team after its time, a changed target and a re-enabled contract are all seen at the next sweep. Old `ola.breach` jobs still queued are dropped. The configuration diagnostics report enabled contracts without a team (`ola_contract_without_team`: they never alert) and contracts whose ticket types are never assigned to a team — tickets exist and none has ever had one; for changes the tasks count (`ola_contract_unmeasurable`: they stay at zero).

**Audit Log.** `workflow.updated` carries `fromVersion`, `toVersion` and only the steps and transitions that really changed, field by field (long values are truncated). For mutations without their own entry, the registry records `add…To<X>` / `remove…From<X>` under the container `X` and its `…Id` argument (`addCIToChange` → `Change`, the change id).

### Notifications

| Query | Roles | Description |
|-------|-------|-------------|
| `notificationRules` | admin | Notification rules of the tenant (one per `eventType`) |
| `notificationRouting` | staff | Channels the dispatcher can actually deliver, per event type (review 2, D3.1): `defaultChannels` (`in_app`, `email` — valid for any event type) and `byEventType` (the event types with a dedicated Slack/Teams formatter and their full channel list: `incident.created/assigned/escalated/resolved` and `sla.breached` → `in_app, email, slack, teams`; `change.approved` and `change.task_assigned` → `in_app, email, slack`). Single source: `ROUTABLE_CHANNELS_BY_EVENT` in `@opengraphity/notifications`. The rules UI offers only these channels for the chosen type; `createNotificationRule` / `updateNotificationRule` refuse any other channel with `BAD_USER_INPUT` (and an empty channel list); a rule written by other means that still carries an unroutable channel makes the notification job fail with an explicit error after the routable channels were delivered — never a silent drop. Migration `20260911_1150_notification_channels_routable` strips such channels from existing rules |

Notification links: the in-app panel and the "Vedi dettagli" link of the notification email resolve `entity_type → path` through the same table (`NOTIFICATION_ENTITY_PATHS` in `@opengraphity/types`): `incident → /incidents/:id`, `change → /changes/:id`, `problem → /problems/:id`, `request` and `service_request → /requests/:id`, `ci → /cis/:id`, `event → /events/:id`, `service → /monitoring/services/:id`, `inbound_webhook → /monitoring/sources/:id`. An event type without a page (`sync.*`, `portal.*`) yields no link. `ci.health_changed` carries the CI `name` in its payload, so the notification body reads `db-01 — down`, not a uuid; `event.*` bodies are `<title> — <resource>`, storms `<source> — <rate>/min`.

---

## Main Mutations

Every successful mutation leaves an Audit Log entry. Most write their own, with a domain action name; a mutation that did not is recorded by the server as `mutation.<name>` with its arguments (secrets redacted, long values truncated) and `source: audit-registry`. Only read-only or personal mutations are skipped (notifications read/dismissed, watch/unwatch, own e-mail preferences, KB article rating, event previews, report questions and exports).

### Incidents

| Mutation | Description |
|----------|-------------|
| `createIncident(input)` | Open a new incident |
| `updateIncident(id, input)` | Update incident fields |
| `resolveIncident(id, rootCause)` | Mark as resolved |

Reopening an incident (a transition from a step of category `resolved` to a non-terminal step, by hand or by monitoring) clears `resolvedAt` and `rootCause`; the previous values stay in the timeline. A problem keeps its root cause. When monitoring reopens a service incident, the title follows the current service health.
| `assignIncidentToTeam(id, teamId)` | Assign to team |
| `assignIncidentToUser(id, userId)` | Assign to user |
| `addIncidentComment(id, text)` | Add a comment |
| `addAffectedCI / removeAffectedCI` | Link/unlink CIs |

### Custom fields (incident, problem, change, service request)

The fields a tenant adds in the ITIL designer are real fields of the ticket. `Incident`, `Problem`, `Change` and `ServiceRequest` expose `customFields: [CustomFieldValue!]!` (`name`, `label`, `fieldType`, `value` as text or null, `enumValues`, `enumTypeName`, `required`, `visibleToEndUser`, `options(language)`, `valueLabel(language)`). The create inputs (`CreateIncidentInput`, `CreateProblemInput`, `CreateChangeInput`, `CreateServiceRequestInput`) accept `customFields: [CustomFieldInput!]` (`{ name, value }`, null or empty clears).

| Mutation | Description |
|----------|-------------|
| `setTicketCustomFields(entityType, id, values)` | Write custom fields from the ticket detail: publishes `ticket.updated` and writes `ticket.custom_fields_updated` in the Audit Log when something changed |
| `itilFieldValueCount(typeId, fieldId)` *(query)* | How many tickets of the type carry a value in the custom field: the ITIL designer shows it in the delete confirmation |
| `deleteITILField(typeId, fieldId)` | Delete a custom field **and its values** from every ticket of the type, in the same transaction. The Audit Log entry `itil_type.field_removed` keeps `valuesRemoved` and up to 50 previous values (`previousValues`, ticket number → value) |

Every channel validates the same way: the field must exist for the ticket type, the value must fit its type (`number`, `boolean` as `true`/`false`, `date` as ISO) and its vocabulary, a `required` field needs a value (on creation, or when it is cleared), and the field's validation script runs. Channels that do not know the customer's fields (monitoring, service maps, Slack, workflow step actions) create tickets without them, like the field requirement rules. From the portal only the fields marked **visible to end users** are offered (`portalCustomFields(entityType, category)`), accepted, and returned. A field's name is its property on the ticket: it cannot reuse a field of the product or a property the tenant's tickets already carry, and name and type cannot change after creation. Custom fields are filterable in the lists (`entityFilterFields`), shown as list columns, in the PDF dossiers under «Additional fields», and settable by step deadlines and `update_field`.

**Workflow steps of a field** (second UI tour, 15 Sep 2026). `ITILFieldInput` takes `stepVisibility: { mode: always | steps | from, steps, step }` (where the field is shown: always; only in `steps`; from `step` on: once the ticket has **entered** that step at least once — its step history or current step —, so it stays after a reopening and never shows on a branch that skipped the step) and `stepEditability: { mode: visible | steps, steps }` (where it can be changed: wherever it is shown, or only in `steps`). `CIFieldDef` returns both. Step names must exist in an active workflow of the ticket type (`errors.customField.unknownSteps`); left out on update, the stored rules stay. Opening a ticket is the initial step of the definition the engine would pick (type and category): a field not editable there is not asked on creation. The forms read that list from the API, with the same rule it accepts them by: `ticketCreationCustomFields(entityType, category)` (`workspace.use`) and, on the portal, `portalCustomFields(entityType, category)`. `ticketWorkflowSteps(entityType)` (`config.metamodel`) lists the steps of every active workflow of the type, with its category, for the ITIL Type Designer (a step present only in some workflows is marked «only …»). `CustomFieldValue.visible` / `editable` are computed for the ticket's current step; writing a field outside its steps is refused from every channel (`errors.customField.notInStep`, `errors.customField.notEditableInStep`), re-sending an unchanged value is not. A ticket without a workflow instance has no steps: its fields stay visible and editable. A field that names a step the workflow no longer has is reported by the configuration diagnostics (`custom_field_steps_missing`), and a field shown «from a step on» where some workflow of its type lacks that step — on those tickets it never shows — as `custom_field_from_step_absent`.

### Changes

| Mutation | Description |
|----------|-------------|
| `createChange(input)` | Create a new change |
| `approveChangeApproval(changeId, teamId, note)` / `rejectChangeApproval(changeId, teamId, note, reopenAll, reopenTaskIds)` | Multi-party approval: one **team's** requirement at a time; rejecting sends the change back to assessment reopening the chosen tasks |
| `completeDeployment(changeId, ciId)` / `completeValidationTest(changeId, ciId, result)` / `completeReview(changeId, ciId, result)` | Deployment, validation and review outcome, per impacted CI |
| `executeChangeTransition(changeId, toStep, notes)` | Manual workflow step (the argument is the **change** id, not the workflow instance) |
| `saveDeployPlan(taskId, steps)` / `completeDeployPlanTask(taskId)` | Define and close the deployment plan (it hangs off the plan **task**, not off the change) |

> Revisione totale · H-25: this table used to list `approveChange`,
> `rejectChange`, `deployChange`, `failChange`, `saveDeploySteps` and
> `updateDeployStepStatus`, none of which exist in the schema — an integrator
> writing `mutation { approveChange(id: …) }` got «Cannot query field». The
> operations above are the real ones (`apps/api/src/graphql/schema-change.ts`);
> `operationPermissions.ts` refuses to start with an operation that has no
> permission row, so an operation missing from there does not exist.

A change's `aggregateRiskScore` stays `null` until every impacted CI has a risk score from its assessment: meanwhile the priority is the initial one from the `change_priority_initial` matrix (change type only), and the change detail says the risk is not yet assessed. Once all assessments are complete, the priority comes from change type × risk band.

### Problems

| Mutation | Description |
|----------|-------------|
| `createProblem(input)` | Open a problem record |
| `executeProblemTransition(problemId, toStep, notes)` | Workflow transition |
| `linkIncidentToProblem(problemId, incidentId)` | Associate incident |

### CMDB

| Mutation | Description |
|----------|-------------|
| `assignCIOwner(ciId, teamId)` | Set owning team; `teamId: null` removes it, refused when the CI type requires it |
| `assignCISupportGroup(ciId, teamId)` | Set support team (same rule) |
| `create<Type>(input)` | Create a configuration item. The mutation is **generated per CI type** from the metamodel (`createServer`, `createDatabase`, …): there is no single `createCI` (revisione totale · H-25). The schema of an organization lists the ones its types produce |
| `update<Type>(id, input)` / `updateCIFields(id, input)` | Update a CI. Both go through the same write: dictionary values, required fields and scripts are validated, the name key used by alarm matching follows the name, `ownerGroupId`/`supportGroupId` are applied, and the change is audited. `updateCIFields.customFields` accepts only fields of the CI's type, and text values take the field's type |
| `addCIRelationship` / `removeCIRelationship` | Link / unlink two CIs. A relationship defined in the CI type designer can be created as long as one of the two types declares it (target: a type, or `any`); removing a link does not depend on its definition and fails if the link does not exist |
| `deleteCIType(id)` | Delete a tenant CI type (`config.metamodel`). The **only** obstacle is a ticket (incident, problem, change or service request, closed ones included) linked to one of its CIs — `errors.ciType.inTicketsDelete` — or a service map following a relationship type only this type declares (`errors.ciType.typeDeleteUsedByServiceMaps`). Everything else goes with the type in the same transaction: its CIs (aliases, service map and history included), the ticket-type exclusions, the dynamic groups (the type leaves their criteria; a group that listed only this type is deleted), field visibility/requirement rules, business rules, triggers, dashboard widgets and report sections on the type, the links to assessment questions (the questions stay). Rule of 15 Sep 2026 |
| `ciTypeDeletionImpact(id)` *(query)* | What `deleteCIType` would remove, with counts (`cis`, `ticketCIs`, `tickets`, `ticketCIExclusions`, `groupsUpdated`, `groupsDeleted`, `fieldVisibilityRules`, `fieldRequirementRules`, `businessRules`, `autoTriggers`, `customWidgets`, `reportSections`, `assessmentQuestionLinks`) plus `blockingServiceMaps` (names of the service maps that follow a relationship type only this CI type declares); `ticketCIs > 0` or a non-empty `blockingServiceMaps` means it cannot be deleted. Deactivating a type (`updateCIType` with `active: false`) is refused when a ticket cites its CIs or while it still has CIs (`errors.ciType.hasCIsDeactivate`), or while a service map follows a relationship type only this type declares (`errors.ciType.typeDeactivateUsedByServiceMaps`) |
| `ciFieldValueCount(typeId, fieldId)` *(query)* | How many CIs of the type (the base type: all CIs) have a value in that field. The designer asks before removing a field and says how many values go; `removeCIField` writes a sample of up to 50 removed values in the Audit Log (`previousValues`) |
| `setTicketCIExclusions(ticketType, ciTypes)` | Replace the excluded CI types of a ticket type (`config.metamodel`). An excluded CI cannot be linked to that ticket type at creation or later, from any channel — monitoring included |
| `addCIToServiceRequest(requestId, ciId)` / `removeCIFromServiceRequest(requestId, ciId)` | The CIs a service request concerns (`request.write`) |

Removed: `itilCIRelationRules`, `allITILCIRelationRules`, `createITILCIRelationRule`, `deleteITILCIRelationRule` (the «allowed CI types» rules, replaced by the exclusions above), and the `relationType` argument of `addAffectedCI` / `addCIToProblem`. In the metamodel designer, removing a relationship still used by links between CIs, or removing a field, now respectively fails with the count or deletes the field's values from the CIs.

### Monitored services

Every mutation below is `admin` only (`lib/authorization.ts`).

| Mutation | Description |
|----------|-------------|
| `createServiceMap(serviceId, maxDepth, relationshipTypes, status, autoSync)` | Build the map automatically from the BusinessApplication (REALIZES, then outgoing technical relationships up to `maxDepth`, default 4, max 8, cap 500 nodes) and evaluate it; `relationshipTypes` defaults to all the types of `serviceRelationshipTypes` (the tenant's, SV-8); `status` defaults to `active` (`draft` for a draft), `autoSync` defaults to `true` (live map). Refused with `BAD_USER_INPUT` when the tenant is at its plan limit (`max_service_maps`: starter 5, pro 50, enterprise 200) or when the service already has a map |
| `reevaluateServiceMap(id)` | Evaluate now (trigger `manual`) |
| `setServiceMapStatus(id, expectedVersion, status)` | `active` / `paused` / `draft` with optimistic concurrency; putting a map back in service (from `paused` **or** from `draft`) re-evaluates it at once |
| `updateServiceImpactRules(id, expectedVersion, rules)` | Save the impact rules (`degradedSharePct` ≤ `downSharePct`, `minNodes` ≤ number of components, `duringStorm` one of `hold` / `evaluate`); history entry `rules_changed` with the changed fields, then immediate re-evaluation. `duringStorm = hold` (default) suspends the evaluation while an alert source of the components is storming: health and incidents stay as they are and `healthNote` says why |
| `updateServiceMapNodes(id, expectedVersion, nodes)` | Change `propagate`, `weight` (1..10) and `critical` of the listed components only; empty list or unknown `ciId` → `BAD_USER_INPUT` |
| `applyServiceMapProposal(id, expectedVersion, add, exclude, remove)` | Apply the choices made on the diff in one transaction: `add` includes proposed CIs (`added_by: manual`), `exclude` never proposes them again (and removes them if included), `remove` drops included or vanished CIs; recomputes `node_ids` and `stale` |
| `removeServiceMapExclusion(id, expectedVersion, ciId)` | Let an excluded CI come back in the next proposal. On a live map (`autoSync`, not paused) the map is also synchronized right away (Audit Log `service_map.synced` with `trigger: readmitted`); if that synchronization fails the re-admission stays and the periodic pass catches up |
| `setServiceMapAutoSync(id, expectedVersion, autoSync)` | Live map (components follow the CMDB by themselves, the default) or frozen map (the diff is applied by hand). History entry `map_changed`; the map is **not** re-evaluated (nothing about its health changes). Writing the value it already has is a `BAD_USER_INPUT` |
| `syncServiceMap(id)` | Synchronize the components with the CMDB now: adds the new ones (`added_by: auto`), drops the automatic ones that are gone, updates `level`/`via`. Manually added components and exclusions are never touched, and neither are `propagate`/`weight`/`critical`. Works on frozen maps too (it is an explicit action), never on `paused` ones (`BAD_USER_INPUT`). Over the 500-component cap nothing is applied and the map is flagged `stale` with `staleReason: over_limit`. Returns **`ServiceMapSyncResult`** (`map`, `added`, `removed`, `moved`, `skipped`, `reason`), not the bare map: `skipped = true` means the cap refused the whole synchronization and `reason` says so |
| `updateServiceMapScope(id, expectedVersion, relationshipTypes, maxDepth)` | Change the relationship types followed and the depth of an existing map (review of 15 Sep 2026 · SV-6: they were fixed at creation). Types must be among `serviceRelationshipTypes` (so a type no longer declared can be dropped), depth 1..8; nothing changed is a `BAD_USER_INPUT`. History entry `map_changed`; a live map that is not paused is synchronized right away with the new scope |
| `deleteServiceMap(id)` | Delete the map and its history (service and CIs untouched). A service incident still open is **not** closed — it is the ticket's history — but it receives one comment before the map goes («the service is no longer monitored: the map was deleted»), because without the map nothing can close it automatically any more (review 2 · D4.3) |

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

The service incident is reconciled at **every** evaluation that is not on hold,
from the state and not from the change (review of 15 Sep 2026 · SV-1/SV-2):
a failed reconciliation, a draft activated while the service is already down or
a lowered opening threshold now open the incident at the next evaluation. When
the reconciliation fails the reason stays on the map (`incidentProblem`, also a
`service_incident_problem` entry in `configurationIssues`) until one succeeds.
The service incident lists the BusinessApplication among its affected CIs,
before the causes. Removing from the metamodel a relationship (or a CI type)
that is the only declaration of a type a service map follows is refused with
`errors.ciType.relationUsedByServiceMaps`, naming the maps.

Deleting the `BusinessApplication` itself (through the CI delete mutation of
its type) also deletes its map and history; the service incident already open
is kept (it is the ticket's history) and gets the same comment as
`deleteServiceMap`. Deleting **any** CI also comments the open incidents whose
only affected CI was that one (review 2 · D4.3): they stay open, but the
operator can see why nothing will close them. See `docs/OPERATIONS.md`
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
| `createEnumType(input)` | Create one of the tenant's dictionaries. `(tenant_id, name)` is unique (database constraint): a second dictionary with the same name is refused, also when two requests arrive together |
| `updateEnumType(id, input)` | Update label/values |
| `deleteEnumType(id)` | Delete one of the tenant's own dictionaries (never a shipped one, and never one still used by a field). Deleting a customised copy puts the shipped dictionary of the same name back in play |
| `enumValueUsage(id, value)` *(query)* | What uses a value: `records` (type, field, count), `policyLists`, `matrices`, `configSites`, `total`. The Dictionary asks it before `renameEnumValue` and shows it in the confirmation |

### Organization (admin)

Verifica «Cosa resta cablato», ondata 6: settings that were code, platform environment variables or command-line only.

| Operation | Description |
|-----------|-------------|
| `tenantName` / `setTenantName(name)` | The organization name (1–120 characters) |
| `tenantBrand` | Name shown and logo URL — readable by every role, the portal included |
| `tenantBrandSettings` / `setTenantBrand(input)` | Name shown, sender name (the sending address stays the platform's `EMAIL_FROM`), reply-to address |
| `ticketNumbering` / `setTicketNumbering(input)` | Prefix (1–8 capital letters or digits, optional trailing `-`) and digits (3–12) per ticket type. New tickets only; the counter is unchanged. Overlapping prefixes, or a prefix already used by another type's numbers, are refused |
| `attachmentPolicy` / `setAttachmentPolicy(input)` | Maximum size (≤ `ATTACHMENT_MAX_MB_CAP`) and allowed extensions (from the platform catalog). Readable by every role; checked on the file name, not the browser MIME type |
| `aiSettings` / `setAISettings(input)` | On/off per AI feature (`triage`, `assistant`, `reportAnalysis`, `postIncident`, `kbArticles`, `embeddings`) and the problem-candidate thresholds. A feature that is off never calls the model: GraphQL answers `AI_DISABLED` with the feature name, `/api/report/stream` answers `403 {error: {code: 'AI_DISABLED'}}`, `similarIncidents`/`suggestedArticles` answer `disabled: true` |
| `updateComment(id, body)` / `deleteComment(id)` | The author edits or deletes their own comment; a role with `ticket.moderateComments` any. Deleting leaves a trace (`deletedAt`, `deletedByName`, empty text); the previous text goes to the Audit Log |

Logo (REST, same origin as the app):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/brand/logo` | admin session | `multipart/form-data` `file`: PNG or SVG up to 1 MB. SVG with scripts, event handlers or links is refused. PDFs embed only PNG logos |
| `DELETE` | `/api/brand/logo` | admin session | Back to the name only |
| `GET` | `/api/brand/:tenantId/logo` | none | Public on purpose (e-mail clients have no session); served with a sandboxing CSP |

### Automation conditions

Business rules and auto triggers share the condition operators (`CONDITION_OPERATORS` in `resolvers/automation.ts`). `changed` («is changed») takes no value and is true when the update changed that field: it is accepted only for business rules on `on_update` and triggers on `on_update` / `on_field_change` (`errors.automation.changedNeedsUpdate` otherwise), because only an update knows which fields changed.

### Roles and permissions

Verifica «Cosa resta cablato», ondata 7. Every root operation requires **at least one** permission of the caller's role; the table is `apps/api/src/lib/operationPermissions.ts`, the catalog (53 permissions in 7 areas) is `PERMISSION_CATALOG` in `@opengraphity/types`. A role is a `(:Role {tenant_id, key, name, permissions, is_factory})` node; `User.role` holds its key. The four factory roles (`admin`, `operator`, `viewer`, `end_user`) are created by `provisionTenantData` and by migration `20260928_1000_factory_roles`: they can be changed, not deleted. A refused call answers `FORBIDDEN` with `errors.authz.roleNotAllowed` and the permissions it needed. `me.permissions` lists the caller's permissions: web and portal show pages and actions from it.

| Operation | Permission | Description |
|-----------|------------|-------------|
| `roles` | `admin.users`, `config.notifications`, `config.workflow` or `config.automation` | Roles with their permissions and how many people have each |
| `setMyLanguage(language)` | authenticated | The person's language (`en`, `it`; null = the organization's), stored on the user and returned as `User.language`: the web Profile and the portal menu write it, both apps read it. An unknown language is refused |
| `createRole(input: {name, permissions})` | `admin.users` | The key is derived from the name and never changes. Names are unique — also against the factory roles' names in every product language («Admin», «Operatore»…): `errors.role.nameTaken`; unknown permissions are refused |
| `updateRole(key, input)` | `admin.users` | A factory role may keep `name: null` (translated from its key). Removing `admin.users` is refused when no active person would keep it |
| `deleteRole(key)` | `admin.users` | Refused for factory roles, roles that people have, and roles used as notification recipients (rules, workflow steps, automations) |
| `setUserRole(userId, role)` | `admin.users` | Refused when it would leave nobody able to manage people and roles |
| `User.permissions`, `User.roleName` | — | The permissions and the organization's name of a person's role |

`POST /api/assistant/stream` (the AI assistant) needs `assistant.use`, and the model only gets the tools for data the role can read (`incident.read`, `cmdb.read`, `change.read`, `kb.read`).

Notification recipients `role:<key>` accept any role of the organization (rules, workflow step notifications, automations); a role that does not exist is refused on save.

### Slack and company sign-in (organization)

Verifica «Cosa resta cablato», ondata 8.

| Operation | Permission | Description |
|-----------|------------|-------------|
| `slackSettings` | `config.integrations` | Connected workspace (mode `app` or `token`, team, who and when — never a secret), whether one-click install is available, whether the platform can encrypt tokens, and the addresses Slack must call (`null` without `PUBLIC_BASE_URL`) |
| `startSlackInstall(returnTo)` | `config.integrations` | Slack authorize URL for the OpenGrafo app; the signed `state` carries organization, person and return page (which must belong to the organization) |
| `connectSlackWithToken(botToken, signingSecret)` | `config.integrations` | Connects the organization's own Slack app: the token is tested with `auth.test` before saving; both secrets are stored encrypted (`SECRETS_ENCRYPTION_KEY`). A workspace belongs to one organization |
| `disconnectSlack` | `config.integrations` | Removes the connection |
| `loginSettings` | `admin.users` | Password rules and company sign-in providers of the organization's Keycloak realm |
| `setPasswordRules(input)` | `admin.users` | Length, required characters, not username/e-mail, history, expiry, temporary lock after failed attempts (never permanent). Policy parts the page does not manage are kept |
| `testLoginProvider(input)` | `admin.users` | Microsoft: tenant discovery + client credentials; Google: discovery + client id format; SAML: metadata import. Returns each check |
| `saveLoginProvider(input, activate)` | `admin.users` | `activate: true` tests first and enables only if every check passes; `false` saves it turned off. The secret stays in Keycloak and is never returned. First sign-in from a provider links an existing person by e-mail and refuses anyone else (flow `opengrafo-existing-users-only`); passwords keep working |
| `deactivateLoginProvider(kind)` / `removeLoginProvider(kind)` | `admin.users` | Turn off / remove `microsoft`, `google` or `saml` |

REST: `GET /api/slack/oauth/callback` (public, verifies the signed state, redirects back to Integrations with `?slack=connected|error`). `POST /api/slack/commands` and `/api/slack/actions` recognise the organization by the workspace (`team_id`) and verify the signature with that connection's secret. `SLACK_BOT_TOKEN` no longer exists.


---

## REST API v1

All `/api/v1/*` routes authenticate with an API key (created via the `createApiKey` GraphQL mutation) sent in the `X-API-Key` header. Responses are JSON: `{ "data": ... }` on success (lists add `"meta": { page, limit, total }`), `{ "error": { "code", "message" } }` on failure. Requests are rate-limited per key. The ticket routes carry the tenant's custom fields as an object `customFields: { fieldName: value }` in responses, and accept it in `POST` (incidents, problems, changes) and in `PATCH /api/v1/incidents/:id`; a value must be a string, a number, a boolean or null.

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

Body: `title` (required), `why` (required), `what` (required), `changeOwner` (required, user id), `changeType` (required: a value of the tenant's `change_type` vocabulary — there is no default type), `affectedCIIds` (required, non-empty array of CI ids). Every CI must have an Owner Group and a Support Group — otherwise `400` with the offending CI in the message.

```bash
curl -s -X POST "http://c-one.localhost/api/v1/changes" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Upgrade DB cluster",
    "why": "The current minor version is end of life",
    "what": "Minor version upgrade of the cluster",
    "changeOwner": "<user-id>",
    "changeType": "normal",
    "affectedCIIds": ["<ci-id-1>", "<ci-id-2>"]
  }'
```

Returns `201` with the same shape as `GET /api/v1/changes/:id`. Validation failures return `400`:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "CI DB Prod has no Owner Group or Support Group" } }
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

`deployApproved` is `true` when the current workflow step is at or past the release step, i.e. the step whose purpose is `implementation` (compared via `step_order` metadata on the workflow definition, not step names). A change workflow with no `implementation` step answers `500`: the question has no answer until the purpose is set in the workflow designer.

### Import (`/api/v1/import`)

Historical data importer for migrations from other ITSM tools. All endpoints accept `multipart/form-data` with a `file` field containing the CSV (max 20MB, header row required) and an optional `?dryRun=true` query parameter. In dry-run mode the whole file is validated but nothing is written. In execute mode rows with errors are skipped (and reported) while valid rows are imported.

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/api/v1/import/incidents` | `incidents:write` | Import incidents from CSV |
| `POST` | `/api/v1/import/problems` | `problems:write` | Import problems from CSV |
| `POST` | `/api/v1/import/changes` | `changes:write` | Import changes from CSV |
| `POST` | `/api/v1/import/service-requests` | `requests:write` | Import service requests from CSV |
| `POST` | `/api/v1/import/kb-articles` | `kb:write` | Import KB articles from CSV |

Idempotency: each row's `external_id` is stored as `import_external_id` on the node; re-running the same CSV updates the existing records (`updated`) instead of duplicating them.

**Incident CSV columns** — `external_id` (required, idempotency key), `title` (required), `description`, `severity` (translated by the tenant's `import_severity` domain matrix — Settings → Domain matrices, seeded with 25 synonyms and editable; a value the matrix cannot resolve puts the **row in error**, it is never rewritten to `medium`; an empty cell is a row error too), `status` (matched case-insensitively against the tenant's incident workflow step names; unknown → warning + initial step), `number` (optional: preserved; collision with another incident → row error; when absent the next value of the tenant's `INC…` counter, the same one the app uses — the counter is also raised above every preserved number, so tickets created afterwards never reuse an imported number), `created_at`/`updated_at`/`resolved_at` (ISO; invalid → row error), `assignee_email` (unknown user → warning, row still imported), `team_name` (unknown team → warning), `comments` (JSON array `[{author_email, text, created_at, internal}]` — `internal: false` imports the comment as a **reply visible to the requester** in the portal, which is what a migrated history usually needs; omitted means an internal staff note, and a non-boolean puts the row in error), and one column per **custom field**, named like the field: the value is checked like everywhere else (type, vocabulary, validation script) and a wrong value puts the row in error; an empty cell leaves the field untouched, and the required flag does not apply to imported history.

**Problem, change and service request CSV columns** — the same common columns as incidents (`external_id`*, `title`*, `status`, `number` with the `PRB…`/`CHG…`/`REQ…` counter, `created_at`, `updated_at`, `comments`, one column per custom field of the type), plus:

- problems: `priority` (required), `impact`, `urgency`, `description`, `workaround`, `root_cause`, `resolved_at`, `assignee_email`, `team_name`;
- changes: `change_type` (required), `priority`, `why`, `what`, `aggregate_risk_score` (integer 0–100), `completed_at`. The number is also written as the change `code`. An imported change is history: no approval, assessment or CI is created, and its workflow step comes from `status`;
- service requests: `priority` (required), `description`, `due_date`, `completed_at`, `assignee_email`, `team_name`.

Vocabulary columns (`priority`, `impact`, `urgency`, `change_type`) are matched case-insensitively against the tenant's dictionary: a value outside it puts the row in error, listing the allowed values.

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

Response (`200`, same shape for every endpoint, top-level — not wrapped in `data`):

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
pnpm --filter @opengraphity/api import:incidents -- --file problems.csv --tenant-id c-one --type problem
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
| `alertmanager` | `{ alerts: [ … ] }` (Alertmanager webhook receiver) | `alerts[].status`, `labels.alertname` (title), `labels.severity` (free text: `valueMapping.severity`), `labels.instance` (port stripped, IPv6 brackets stripped: `[::1]:9100` → `::1`; an IPv4/IPv6 literal becomes `resourceKind: ip`, so the CI's `ip` alias is the one looked up — review 2 · B2-17; absent → `defaultValues.resource`), `annotations.summary/description`, `fingerprint`, `startsAt/endsAt` |
| `grafana` | `{ alerts: [ … ] }` (unified alerting webhook contact point) | same as Alertmanager; `labels.host` when `labels.instance` is absent |
| `zabbix` | one object per request (media type *Webhook*) | `event_id`, `event_name`/`trigger_name`, `event_severity` (Not classified/Information→info, Warning/Average→warning, High/Disaster→critical), `event_value` (`1` problem / `0` recovery), `host_name` or `host_ip` (absent → `defaultValues.resource`), `host_id` (→ `resourceExternalId`), `event_date` + `event_time` (`{EVENT.DATE} {EVENT.TIME}`, local time of the Zabbix server: converted to ISO with `Tenant.timezone`; not convertible → `startsAt` empty and the raw text in `labels.event_time`), `trigger_description`, `event_opdata` |
| `datadog` | one object per request (webhook integration) | `alert_cycle_key` (`$ALERT_CYCLE_KEY`, the alert's identity: one per trigger→resolve cycle; absent → `alert_id@resource`, so the hosts of a multi-alert monitor stay separate), `alert_id` (monitor id, kept in `labels.alert_id`), `alert_scope` (`labels.alert_scope`; resource when `hostname` is empty and `defaultValues.resourceFrom = "alert_scope"`), `alert_transition` (Triggered/Re-Triggered/Warn/Re-Warn/No Data/Re-No Data/Renotify→firing, Recovered/Warn Recovered→resolved — the values documented for `$ALERT_TRANSITION`), `alert_type` (error→critical, warning→warning, info/success→info; others rejected unless mapped), `title`, `body`/`text`, `hostname`, `tags` (`key:value` list, CSV or object), `date` |
| `dynatrace` | one problem per request (Problem notification, custom integration) | `PID`/`ProblemID`, `State` (OPEN/RESOLVED), `ProblemTitle`, `ProblemSeverity` (AVAILABILITY/ERROR→critical, PERFORMANCE/RESOURCE_CONTENTION/CUSTOM_ALERT→warning, MONITORING_UNAVAILABLE→info), `ImpactedEntities[0]` (`name`; `type` HOST → `resourceKind` hostname, otherwise name; `entity` → `resourceExternalId`) or `ImpactedEntity` with a recognised type prefix stripped (`Host web-02` → hostname `web-02`, `Service checkout` → name `checkout`; an unknown prefix such as `3 impacted entities` is rejected), `ProblemDetailsText`, `ProblemImpact`, `ProblemURL`, `Tags` |
| `generic` | any JSON object, one event per request | `fieldMapping` `{ normalizedField: "dotted.path" }` (unmapped field → same-named root key; fields: `title`, `severity`, `status`, `resource`, `resourceKind`, `resourceExternalId`, `externalId`, `description`, `labels`, `startsAt`, `endsAt`), `defaultValues` for missing fields (`resourceKind` is required here or in the payload; a declared `hostname` holding an IP literal is stored as `ip`, like Alertmanager), `valueMapping` as above; `labels` accepts an object, a `["key:value"]` list or a CSV string |

**Deleting a source** (`deleteInboundWebhook(id)`) returns **`DeleteSourceResult`** (`deleted`, `resolvedEvents`, `affectedCIs`), not a bare boolean (review 2 · D4.1): in the same transaction every alert of that source still `firing`/`suppressed`/`flapping` is resolved (`resolvedBy` = the user, history entry `resolved_manually` with the reason, correlation untouched) because no `resolved` payload can ever arrive again; after the commit the health of the CIs involved is recomputed (publishing `ci.health_changed`, so the services re-evaluate) and every resolved alert goes through the pipeline in `reevaluate`, which closes the incidents the normal way. `deleted: false` means the source did not exist. Before this, a deleted source left its alerts `firing` for ever: CIs `down`, incidents open, services degraded.

`sampleInboundPayload(connectorKind)` returns a realistic payload for each connector, `previewInboundEvents` normalises a pasted payload without ingesting it, `sendSampleEvent(sourceId)` pushes the sample through the real pipeline.

Console reads: `events(filter, limit ≤ 500, offset)` returns page and `total` from one query, with `ci`, `source`, `incident` and `acknowledgedBy` resolved with the row; `filter.search` goes through the `event_search` full-text index (title + resource; every word must appear as a substring of a token, case-insensitive — `example` and `local` both find `api-03.example.local`). `Incident.correlatedEvents(limit = 100 ≤ 500, offset)` and `Change.suppressedEvents(limit, offset)` are paginated (a storm incident aggregates thousands of alerts); the totals are `correlatedEventCount` / `suppressedEventCount`.

---

## Schema Reference

The full SDL schema is exported to [graphql-schema.graphql](./graphql-schema.graphql).

To regenerate it:

```bash
pnpm tsx apps/api/src/scripts/export-schema.ts
```
