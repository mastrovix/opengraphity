/**
 * The organization's own settings and automations (tour of 23 Sep 2026: D55,
 * D58, D68). The mutations validate again when the generator calls them; this
 * checks, without a database, that what the demo asks for is something the
 * product accepts — a rejected rule would stop a generation halfway.
 */
import { describe, it, expect } from 'vitest'
import { USER_ROLES, isTargetApplicable, notificationTargetRole, automationEventSupported } from '@opengraphity/types'
import { SEEDED_EVENT_TYPES } from '../../../seedNotificationRules.js'
import { assertActionsJson, assertConditionsJson } from '../../../../graphql/resolvers/automation.js'
import { DEMO_INAPP_RETENTION_DAYS, DEMO_NOTIFICATION_TARGETS, DEMO_NOTIFICATIONS_OFF } from '../organization.js'
import { demoAutomations } from '../automations.js'
import { INAPP_RETENTION_MAX_DAYS, INAPP_RETENTION_MIN_DAYS } from '../../../tenantInAppRetention.js'

describe('D55: the notification retention', () => {
  it('is a value the Organization page accepts', () => {
    expect(DEMO_INAPP_RETENTION_DAYS).toBeGreaterThanOrEqual(INAPP_RETENTION_MIN_DAYS)
    expect(DEMO_INAPP_RETENTION_DAYS).toBeLessThanOrEqual(INAPP_RETENTION_MAX_DAYS)
  })
})

describe('D58: the notification rules of a desk that has run for years', () => {
  it('every rule narrowed is a factory rule, and its recipient makes sense for the event', () => {
    for (const [eventType, target] of DEMO_NOTIFICATION_TARGETS) {
      expect(SEEDED_EVENT_TYPES).toContain(eventType)
      expect(isTargetApplicable(eventType, target), `${eventType} → ${target}`).toBe(true)
      const role = notificationTargetRole(target)
      if (role) expect(USER_ROLES).toContain(role)
      expect(target).not.toBe('all')
    }
    expect(new Set(DEMO_NOTIFICATION_TARGETS.map(([e]) => e)).size).toBe(DEMO_NOTIFICATION_TARGETS.length)
  })

  it('the rules turned off are factory rules about the alarms\' noise, and are not narrowed too', () => {
    for (const eventType of DEMO_NOTIFICATIONS_OFF) {
      expect(SEEDED_EVENT_TYPES).toContain(eventType)
      expect(eventType.startsWith('event.')).toBe(true)
      expect(DEMO_NOTIFICATION_TARGETS.some(([e]) => e === eventType)).toBe(false)
    }
  })
})

describe('D68: the automations', () => {
  it('are what the automation pages accept: supported event, valid conditions and actions, roles that exist', () => {
    const all = demoAutomations('item-privileged')
    expect(all.map((a) => a.kind).sort()).toEqual(['rule', 'trigger'])
    for (const a of all) {
      const input = a.input
      expect(automationEventSupported(String(input['eventType']), String(input['entityType']))).toBe(true)
      expect(assertConditionsJson(input['conditions'])).toBe(input['conditions'])
      expect(assertActionsJson(input['actions'])).toBe(input['actions'])
      const actions = JSON.parse(String(input['actions'])) as Array<{ type: string; params: Record<string, unknown> }>
      // Only an in-app notification: nothing on the simulated tickets changes.
      expect(actions.map((x) => x.type)).toEqual(['create_notification'])
      expect(actions[0]!.params['channel']).toBe('in_app')
      const role = notificationTargetRole(String(actions[0]!.params['target']))
      expect(role !== null && (USER_ROLES as readonly string[]).includes(role)).toBe(true)
      expect(a.writtenDaysAgo).toBeGreaterThan(30)
      expect(a.firings).toContain('$since')
      expect(a.firings).toContain('demo_run_id = $runId')
    }
  })

  it('the privileged-access trigger matches the catalog item by id, passed as a parameter', () => {
    const trigger = demoAutomations('item-privileged').find((a) => a.kind === 'trigger')!
    expect(JSON.parse(String(trigger.input['conditions']))).toEqual([{ field: 'catalog_item_id', operator: 'equals', value: 'item-privileged' }])
    expect(trigger.firingParams).toEqual({ itemId: 'item-privileged' })
    expect(trigger.firings).not.toContain('item-privileged')
  })

  it('without the catalog item there is no trigger for it', () => {
    expect(demoAutomations(null).map((a) => a.kind)).toEqual(['rule'])
  })
})
