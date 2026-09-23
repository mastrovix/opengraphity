/**
 * THE ORGANIZATION'S OWN SETTINGS (tour of 23 Sep 2026: D55, D58).
 *
 * Two things a tenant that has run for three years has chosen, and the demo
 * had left at the factory:
 *  - D55: how long the bell notifications are kept (Settings → Organization).
 *    Not chosen, the nightly clean-up skips the tenant and the diagnostics
 *    say so: the demo showed a configuration warning on its first page.
 *  - D58: who hears about what. The factory rules tell EVERYONE about almost
 *    everything — every assignment, every resolution, every alarm that
 *    flapped. A desk narrows them in its first months: the team of the ticket
 *    hears about its tickets, the operators about the alarms, the
 *    administrators get the daily digest; the alarms' noise is turned off.
 *
 * Both through the app's own mutations, as the administrator of the tenant.
 * What the rules were before is returned, so the clean-up can put it back.
 *
 * D58, the channels (the owner's choice of 23 Sep 2026: «I'll give you a real
 * one»). The product checks a channel's address and then DELIVERS to it, so
 * an invented one would send the tenant's tickets to Microsoft or Slack. The
 * address comes from the environment of the run — `DEMO_TEAMS_WEBHOOK_URL`,
 * `DEMO_SLACK_WEBHOOK_URL` — never from the code, and is never logged. The
 * channel hears only what PEOPLE do in the demo (an incident assigned to a
 * team, a change approved): SLA breaches and escalations the live system
 * produces by itself, by the hundred, on the open tickets in the days after a
 * generation.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../../auth/resolveAuth.js'
import { organizationSettingsResolvers } from '../../../graphql/resolvers/organizationSettings.js'
import { notificationRuleResolvers } from '../../../graphql/resolvers/notificationRules.js'
import { notificationChannelResolvers } from '../../../graphql/resolvers/notificationChannel.js'

export const DEMO_INAPP_RETENTION_DAYS = 90

/** D58: the recipients a mature desk gives the factory rules (event type → target). */
export const DEMO_NOTIFICATION_TARGETS: ReadonlyArray<readonly [eventType: string, target: string]> = [
  ['incident.assigned', 'team_owner'],
  ['incident.in_progress', 'team_owner'],
  ['incident.resolved', 'team_owner'],
  ['incident.closed', 'team_owner'],
  ['incident.escalated', 'team_owner'],
  ['incident.step_entered', 'team_owner'],
  ['problem.created', 'role:operator'],
  ['problem.under_investigation', 'team_owner'],
  ['problem.resolved', 'team_owner'],
  ['problem.closed', 'team_owner'],
  ['problem.deferred', 'team_owner'],
  ['change.approved', 'team_owner'],
  ['change.rejected', 'team_owner'],
  ['change.completed', 'team_owner'],
  ['change.failed', 'team_owner'],
  ['sla.warning', 'team_owner'],
  ['sla.breached', 'team_owner'],
  ['ola.breached', 'team_owner'],
  ['ci.health_changed', 'team_owner'],
  ['service.health_changed', 'team_owner'],
  ['service.incident_opened', 'team_owner'],
  ['event.correlated', 'role:operator'],
  ['event.flapping', 'role:operator'],
  ['event.orphan', 'role:operator'],
  ['event.storm_started', 'role:operator'],
  ['event.storm_ended', 'role:operator'],
  ['sync.completed', 'role:admin'],
  ['sync.failed', 'role:admin'],
  ['conflict.created', 'role:admin'],
  ['digest.daily', 'role:admin'],
]

/** D58: the alarms' noise, turned off (an alarm that stopped flapping, or was suppressed, or resolved itself). */
export const DEMO_NOTIFICATIONS_OFF: readonly string[] = ['event.stable', 'event.suppressed', 'event.resolved']

export interface PreviousRule { id: string; target: string; enabled: boolean; channels: string[] }

/** D58: what a channel of the demo is told (the event keys of the Channels page). */
export const DEMO_CHANNEL_EVENTS: readonly string[] = ['assigned', 'change_approved']
/** D58: the rules that send those events to the channels' platforms too. */
export const DEMO_CHANNEL_RULES: readonly string[] = ['incident.assigned', 'change.approved']

export interface DemoChannelSpec { platform: 'teams' | 'slack'; name: string; env: string }
export const DEMO_CHANNELS: readonly DemoChannelSpec[] = [
  { platform: 'teams', name: 'IT Operations', env: 'DEMO_TEAMS_WEBHOOK_URL' },
  { platform: 'slack', name: '#it-operations', env: 'DEMO_SLACK_WEBHOOK_URL' },
]

type Mutation = (p: unknown, args: unknown, ctx: GraphQLContext) => Promise<unknown>

/** D55: the retention of the bell notifications, as the Organization page sets it. */
export async function setDemoRetention(ctx: GraphQLContext): Promise<void> {
  await (organizationSettingsResolvers.Mutation.setTenantInAppRetentionDays as Mutation)(null, { days: DEMO_INAPP_RETENTION_DAYS }, ctx)
}

/**
 * D58: the rules narrowed with `updateNotificationRule` (it validates that the
 * recipient makes sense for the event, and that the role exists). Only the
 * factory rules still at their factory recipient are touched: a rule someone
 * already changed is theirs. Returns what each changed rule was before.
 */
export async function tuneNotificationRules(session: Session, ctx: GraphQLContext): Promise<PreviousRule[]> {
  const rules = await runQuery<{ id: string; eventType: string; target: string; enabled: boolean; channels: string[] }>(session, `
    MATCH (r:NotificationRule {tenant_id: $tenantId}) WHERE r.is_seed = true AND r.target = 'all'
    RETURN r.id AS id, r.event_type AS eventType, r.target AS target, r.enabled AS enabled, r.channels AS channels`, { tenantId: ctx.tenantId })
  const byEvent = new Map(rules.map((r) => [r.eventType, r]))
  const update = notificationRuleResolvers.Mutation.updateNotificationRule as Mutation
  const previous: PreviousRule[] = []
  for (const [eventType, target] of DEMO_NOTIFICATION_TARGETS) {
    const rule = byEvent.get(eventType)
    if (!rule) continue
    await update(null, { id: rule.id, input: { target } }, ctx)
    previous.push({ id: rule.id, target: rule.target, enabled: rule.enabled, channels: rule.channels })
  }
  for (const eventType of DEMO_NOTIFICATIONS_OFF) {
    const rule = byEvent.get(eventType)
    if (!rule || rule.enabled !== true) continue
    await update(null, { id: rule.id, input: { enabled: false } }, ctx)
    previous.push({ id: rule.id, target: rule.target, enabled: rule.enabled, channels: rule.channels })
  }
  return previous
}

/**
 * D58: the channels whose address the run was given, created with the
 * Channels page's mutation (it resolves the address and refuses an unsafe
 * one: a wrong address stops the generation, it is not skipped), and the two
 * rules routed to their platforms. Returns the channels created and the
 * rules as they were — the channels the rules had, for the clean-up.
 */
export async function createDemoChannels(
  session: Session, ctx: GraphQLContext, env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ created: Array<{ id: string; spec: DemoChannelSpec }>; platforms: string[]; previous: PreviousRule[] }> {
  const create = notificationChannelResolvers.Mutation.createNotificationChannel as Mutation
  const given = DEMO_CHANNELS.filter((c) => (env[c.env] ?? '').trim() !== '')
  const created: Array<{ id: string; spec: DemoChannelSpec }> = []
  for (const c of given) {
    const channel = await create(null, { input: { platform: c.platform, name: c.name, webhookUrl: env[c.env]!.trim(), eventTypes: [...DEMO_CHANNEL_EVENTS] } }, ctx) as { id: string }
    created.push({ id: channel.id, spec: c })
  }
  const platforms = given.map((c) => c.platform)
  const previous: PreviousRule[] = []
  if (platforms.length === 0) return { created, platforms, previous }
  const rules = await runQuery<{ id: string; target: string; enabled: boolean; channels: string[] }>(session, `
    MATCH (r:NotificationRule {tenant_id: $tenantId}) WHERE r.event_type IN $events
    RETURN r.id AS id, r.target AS target, r.enabled AS enabled, r.channels AS channels`, { tenantId: ctx.tenantId, events: [...DEMO_CHANNEL_RULES] })
  const update = notificationRuleResolvers.Mutation.updateNotificationRule as Mutation
  for (const r of rules) {
    await update(null, { id: r.id, input: { channels: [...new Set([...r.channels, ...platforms])] } }, ctx)
    previous.push({ id: r.id, target: r.target, enabled: r.enabled, channels: r.channels })
  }
  return { created, platforms, previous }
}

/** The rules as they were before the run: a rule changed twice keeps its FIRST state (the one to put back). */
export function firstStates(previous: readonly PreviousRule[]): PreviousRule[] {
  const seen = new Map<string, PreviousRule>()
  for (const r of previous) if (!seen.has(r.id)) seen.set(r.id, r)
  return [...seen.values()]
}
