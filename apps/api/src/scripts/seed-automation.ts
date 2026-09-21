/**
 * Seeds automation data for a tenant:
 * - Security incident workflow with extra security_review step
 * - Granular SLA policies
 * - Auto triggers
 * - Business rules
 *
 * Usage: pnpm --filter @opengraphity/api seed:automation -- --tenant=<slug>
 */

import { DEFAULT_SLA_WARNING_MINUTES } from '@opengraphity/types'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import { resolveTenantArg } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'

async function main(TENANT: string) {
  const session = getSession(undefined, 'WRITE')

  console.log('\n=== Seed Automation Data ===\n')

  try {
    // ── SLA Policies ───────────────────────────────────────────────────────────

    const slaPolicies = [
      { name: 'Incident Default',                    entity_type: 'incident', priority: null,       category: null,       team_id: null, response_minutes: 240,  resolve_minutes: 1440, business_hours: true },
      { name: 'Incident Critical',                   entity_type: 'incident', priority: 'critical', category: null,       team_id: null, response_minutes: 30,   resolve_minutes: 240,  business_hours: false },
      { name: 'Incident Critical Security',          entity_type: 'incident', priority: 'critical', category: 'security', team_id: null, response_minutes: 15,   resolve_minutes: 120,  business_hours: false },
      { name: 'Incident Low Priority',               entity_type: 'incident', priority: 'low',      category: null,       team_id: null, response_minutes: 480,  resolve_minutes: 4320, business_hours: true },
    ]

    for (const p of slaPolicies) {
      await session.executeWrite(tx => tx.run(`
        MERGE (p:SLAPolicyNode {tenant_id: $tenantId, name: $name})
        ON CREATE SET p.id = $id, p.entity_type = $entityType,
          p.priority = $priority, p.category = $category, p.team_id = $teamId,
          // Nessun fuso proprio: segue quello del cliente (revisione del 14 set 2026 · F7).
          p.warning_minutes = $warningMinutes,
          p.response_minutes = $responseMinutes, p.resolve_minutes = $resolveMinutes,
          p.business_hours = $businessHours, p.enabled = true,
          p.created_at = $now, p.updated_at = $now
        ON MATCH SET p.response_minutes = $responseMinutes, p.resolve_minutes = $resolveMinutes,
          p.business_hours = $businessHours, p.updated_at = $now
      `, {
        tenantId: TENANT, id: uuidv4(), name: p.name,
        entityType: p.entity_type, priority: p.priority, category: p.category, teamId: p.team_id,
        responseMinutes: p.response_minutes, resolveMinutes: p.resolve_minutes, warningMinutes: DEFAULT_SLA_WARNING_MINUTES,
        businessHours: p.business_hours, now: new Date().toISOString(),
      }))
    }
    console.log(`  SLA policies: ${slaPolicies.length} created`)

    /**
     * I BERSAGLI DELLE REGOLE DI ESEMPIO devono esistere in QUESTO cliente
     * (revisione totale · H-8). Prima erano letterali: `team_id: 'helpdesk'`
     * e `'secops'` (i team seminati hanno id uuid), `to_step: 'approved'` (il
     * workflow change di fabbrica ha `approval`), `status = 'new'` (un nome di
     * passo cablato). Sono le regole che il cliente vede in Automazioni e
     * crede funzionanti: puntavano nel vuoto e falliva l'azione, in silenzio,
     * a ogni esecuzione.
     *
     * Qui i bersagli si RISOLVONO dal grafo del cliente, e una regola il cui
     * bersaglio non esiste non viene seminata: lo si dice, invece di scriverne
     * una rotta.
     */
    const teamRow = await session.executeRead(tx => tx.run(
      'MATCH (t:Team {tenant_id: $tenantId}) RETURN t.id AS id, t.name AS name ORDER BY t.name LIMIT 1',
      { tenantId: TENANT },
    ))
    const teamId   = teamRow.records[0]?.get('id') as string | undefined
    const teamName = teamRow.records[0]?.get('name') as string | undefined
    const { getInitialStepName, getStepNamesByPurpose } = await import('../lib/workflowHelpers.js')
    const incidentInitialStep = await getInitialStepName(session, TENANT, 'incident')
    const changeApprovalStep  = (await getStepNamesByPurpose(session, TENANT, 'change', ['approval']))[0]
    if (teamId) console.log(`  I gruppi delle regole di esempio: «${String(teamName)}»`)
    else console.log('  ⚠ nessun Team in questo cliente: le regole che assegnano un gruppo non vengono seminate')
    if (!changeApprovalStep) console.log('  ⚠ nessun passo di scopo «approval» nel workflow change: la regola di auto-approvazione non viene seminata')

    // ── Auto Triggers ──────────────────────────────────────────────────────────

    const triggers = [
      {
        name: 'Auto-assegna incident non assegnato',
        entity_type: 'incident', event_type: 'on_timer',
        conditions: JSON.stringify([
          { field: 'assigned_to', operator: 'is_null' },
          { field: 'status', operator: 'equals', value: incidentInitialStep },
        ]),
        timer_delay_minutes: 30,
        actions: JSON.stringify([
          { type: 'assign_team', params: { team_id: teamId } },
        ]),
      },
      {
        name: 'Escalation incident critico',
        entity_type: 'incident', event_type: 'on_timer',
        conditions: JSON.stringify([
          { field: 'severity', operator: 'equals', value: 'critical' },
          { field: 'status', operator: 'equals', value: incidentInitialStep },
        ]),
        timer_delay_minutes: 60,
        actions: JSON.stringify([
          { type: 'set_priority', params: { priority: 'critical' } },
          { type: 'create_notification', params: { channel: 'in_app', message: 'Incident critico non gestito da 1 ora' } },
        ]),
      },
      {
        name: 'Auto-notifica SLA breach',
        entity_type: 'incident', event_type: 'on_sla_breach',
        conditions: JSON.stringify([]),
        timer_delay_minutes: null,
        actions: JSON.stringify([
          { type: 'create_notification', params: { channel: 'in_app', message: 'SLA violato' } },
        ]),
      },
    ]

    for (const t of triggers) {
      // H-8: una regola il cui bersaglio non esiste in questo cliente non si
      // semina — sarebbe una regola «attiva» che fallisce a ogni esecuzione.
      if (t.actions.includes('"team_id":null') || t.actions.includes('"to_step":null')) {
        console.log(`  ⚠ salto «${t.name}»: il bersaglio non esiste in questo cliente`)
        continue
      }
      await session.executeWrite(tx => tx.run(`
        MERGE (t:AutoTrigger {tenant_id: $tenantId, name: $name})
        ON CREATE SET t.id = $id, t.entity_type = $entityType, t.event_type = $eventType,
          t.conditions = $conditions, t.timer_delay_minutes = $timerDelayMinutes,
          t.actions = $actions, t.enabled = true, t.execution_count = 0,
          t.created_at = $now, t.updated_at = $now
        ON MATCH SET t.conditions = $conditions, t.actions = $actions, t.updated_at = $now
      `, {
        tenantId: TENANT, id: uuidv4(), name: t.name,
        entityType: t.entity_type, eventType: t.event_type,
        conditions: t.conditions, timerDelayMinutes: t.timer_delay_minutes,
        actions: t.actions, now: new Date().toISOString(),
      }))
    }
    console.log(`  Auto triggers: ${triggers.length} created`)

    // ── Business Rules ─────────────────────────────────────────────────────────

    const rules = [
      {
        name: 'Incident security critico → SecOps',
        description: 'Assegna automaticamente incident security critici al team SecOps',
        entity_type: 'incident', event_type: 'on_create',
        condition_logic: 'and',
        conditions: JSON.stringify([
          { field: 'severity', operator: 'equals', value: 'critical' },
          { field: 'category', operator: 'equals', value: 'security' },
        ]),
        actions: JSON.stringify([
          { type: 'assign_team', params: { team_id: teamId } },
          { type: 'create_notification', params: { channel: 'in_app', message: 'Incident security critico assegnato a SecOps' } },
          { type: 'set_sla', params: { response_minutes: 15, resolve_minutes: 120 } },
        ]),
        priority: 1, stop_on_match: true,
      },
      {
        name: 'Change emergency → approvazione immediata',
        description: 'Auto-approva i change di tipo emergency',
        entity_type: 'change', event_type: 'on_create',
        condition_logic: 'and',
        conditions: JSON.stringify([
          { field: 'type', operator: 'equals', value: 'emergency' },
        ]),
        actions: JSON.stringify([
          { type: 'transition_workflow', params: { to_step: changeApprovalStep } },
          { type: 'create_comment', params: { text: 'Auto-approvato: change emergency' } },
        ]),
        priority: 1, stop_on_match: false,
      },
      {
        name: 'Incident bassa priorità → SLA rilassato',
        description: 'Applica SLA rilassato agli incident a bassa priorità',
        entity_type: 'incident', event_type: 'on_create',
        condition_logic: 'and',
        conditions: JSON.stringify([
          { field: 'severity', operator: 'equals', value: 'low' },
        ]),
        actions: JSON.stringify([
          { type: 'set_sla', params: { response_minutes: 480, resolve_minutes: 4320 } },
        ]),
        priority: 10, stop_on_match: false,
      },
    ]

    for (const r of rules) {
      // H-8: vedi sopra.
      if (r.actions.includes('"team_id":null') || r.actions.includes('"to_step":null')) {
        console.log(`  ⚠ salto «${r.name}»: il bersaglio non esiste in questo cliente`)
        continue
      }
      await session.executeWrite(tx => tx.run(`
        MERGE (r:BusinessRule {tenant_id: $tenantId, name: $name})
        ON CREATE SET r.id = $id, r.description = $description,
          r.entity_type = $entityType, r.event_type = $eventType,
          r.condition_logic = $conditionLogic, r.conditions = $conditions,
          r.actions = $actions, r.priority = $priority, r.stop_on_match = $stopOnMatch,
          r.enabled = true, r.created_at = $now, r.updated_at = $now
        ON MATCH SET r.conditions = $conditions, r.actions = $actions, r.updated_at = $now
      `, {
        tenantId: TENANT, id: uuidv4(), name: r.name, description: r.description,
        entityType: r.entity_type, eventType: r.event_type,
        conditionLogic: r.condition_logic, conditions: r.conditions,
        actions: r.actions, priority: r.priority, stopOnMatch: r.stop_on_match,
        now: new Date().toISOString(),
      }))
    }
    console.log(`  Business rules: ${rules.length} created`)

    console.log('\n=== Seed complete ===\n')
  } finally {
    await session.close()
  }
}

runScript('seed-automation', () => main(resolveTenantArg()))
