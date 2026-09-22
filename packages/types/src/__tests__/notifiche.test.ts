/**
 * WHERE A NOTIFICATION LEADS, AND WHO RECEIVES IT.
 *
 * Two tables read from three sides — the in-app panel, the "see details" link
 * in the e-mails, and the API validating a rule as it is written.
 *
 * The target table exists because of a rule that could never deliver
 * anything: a tenant had `incident.created → team_owner`, but
 * `CreateIncidentInput` accepts neither assignee nor team, so at the moment
 * of the event that target does not exist yet. It used to be ignored
 * (everybody got everything); once targets started being applied, that job
 * failed on every incident created. Better to refuse the rule at write time.
 */
import { describe, it, expect } from 'vitest'
import {
  NOTIFICATION_ENTITY_PATHS, isNotificationEntityType, notificationEntityPath,
} from '../notificationRoutes.js'
import {
  NOTIFICATION_TARGETS, NOTIFICATION_BASE_TARGETS, NOTIFICATION_ROLE_TARGETS,
  NOTIFICATION_TARGET_ALL, NOTIFICATION_TARGET_ASSIGNEE, NOTIFICATION_TARGET_TEAM,
  roleNotificationTarget, notificationTargetRole, isNotificationTarget,
  applicableNotificationTargets, isTargetApplicable,
} from '../notificationTargets.js'
import { USER_ROLES } from '../user.js'

describe('notification routes', () => {
  it('every path is absolute and carries the :id placeholder', () => {
    for (const [type, path] of Object.entries(NOTIFICATION_ENTITY_PATHS)) {
      expect(path.startsWith('/'), type).toBe(true)
      expect(path, type).toContain(':id')
    }
  })

  it('the SLA engine\'s name for a service request leads to the same page as the API\'s', () => {
    // `packages/sla` says `service_request` and the API says `request`: two
    // names, one page. A missing alias makes half the SLA notifications
    // unclickable.
    expect(NOTIFICATION_ENTITY_PATHS.service_request).toBe(NOTIFICATION_ENTITY_PATHS.request)
  })

  it('a KB article has a path: the "article published" notification used to be dead', () => {
    // It opens by slug, but notifications and approvals carry the id, and
    // the web route resolves and redirects (B-21).
    expect(notificationEntityPath('kb_article', 'kb-1')).toBe('/kb-articles/kb-1')
  })

  it('builds the path by substituting the id', () => {
    expect(notificationEntityPath('incident', 'inc-1')).toBe('/incidents/inc-1')
    expect(notificationEntityPath('service', 'svc-1')).toBe('/monitoring/services/svc-1')
  })

  it('an id needing escaping is encoded, not interpolated raw', () => {
    expect(notificationEntityPath('incident', 'a/../admin?x=1')).toBe('/incidents/a%2F..%2Fadmin%3Fx%3D1')
  })

  it('no entity, or one with no page, means no link — and that is not an error', () => {
    // `sync` and `portal` describe an operation, not a record. The panel must
    // still show the notification, so this returns null rather than throwing.
    for (const [type, id] of [['incident', null], ['incident', ''], [null, 'inc-1'], [undefined, 'inc-1'], ['sync', 'x'], ['unknown', 'x']] as const) {
      expect(notificationEntityPath(type, id), `${String(type)}/${String(id)}`).toBeNull()
    }
  })

  it('the type guard answers on own properties only', () => {
    for (const t of Object.keys(NOTIFICATION_ENTITY_PATHS)) expect(isNotificationEntityType(t)).toBe(true)
    // `toString` and friends are on the prototype: a plain `in` would say yes.
    for (const t of ['toString', 'constructor', '__proto__', 'sync', '']) expect(isNotificationEntityType(t)).toBe(false)
  })
})

describe('notification targets — the shape', () => {
  it('there is one role target per factory role, and the offered list is base + roles', () => {
    expect(NOTIFICATION_ROLE_TARGETS).toEqual(USER_ROLES.map((r) => `role:${r}`))
    expect(NOTIFICATION_TARGETS).toEqual([...NOTIFICATION_BASE_TARGETS, ...NOTIFICATION_ROLE_TARGETS])
  })

  it('a role key round-trips through its target', () => {
    for (const role of [...USER_ROLES, 'service_desk_l1', 'change_manager']) {
      expect(notificationTargetRole(roleNotificationTarget(role))).toBe(role)
    }
  })

  it('a target whose role key is malformed is not a role target', () => {
    // The key becomes part of a Cypher parameter and of the dropdown: a
    // malformed one resolves to nobody, and the rule delivers nothing.
    for (const bad of ['role:', 'role:Admin', 'role:1st_line', 'role:con-trattino', 'role:a', `role:${'a'.repeat(41)}`]) {
      expect(notificationTargetRole(bad), bad).toBeNull()
    }
    expect(notificationTargetRole('all')).toBeNull()
  })

  it('the guard takes the fixed targets and any well-formed role, and nothing else', () => {
    // Whether the role EXISTS is the tenant's business: a custom role
    // (wave 7) is valid here and resolved against the data.
    for (const t of NOTIFICATION_TARGETS) expect(isNotificationTarget(t)).toBe(true)
    expect(isNotificationTarget('role:service_desk_l1')).toBe(true)
    for (const v of [undefined, null, 42, {}, '', 'everyone', 'role:', 'assignee ']) expect(isNotificationTarget(v)).toBe(false)
  })
})

describe('which targets make sense for which event', () => {
  it('a normal ticket event offers all three base targets', () => {
    expect(applicableNotificationTargets('incident.assigned')).toEqual([...NOTIFICATION_BASE_TARGETS, ...NOTIFICATION_ROLE_TARGETS])
  })

  it('at a ticket\'s BIRTH there is no assignee and no team yet', () => {
    // This is the rule that used to fail on every incident created.
    for (const e of ['incident.created', 'problem.created']) {
      const t = applicableNotificationTargets(e)
      expect(t).not.toContain(NOTIFICATION_TARGET_ASSIGNEE)
      expect(t).not.toContain(NOTIFICATION_TARGET_TEAM)
      expect(t).toContain(NOTIFICATION_TARGET_ALL)
    }
  })

  it('alarms, sources and syncs have neither assignee nor team', () => {
    for (const e of ['event.received', 'sync.failed', 'conflict.created', 'event.storm_started']) {
      expect(applicableNotificationTargets(e)).toEqual([NOTIFICATION_TARGET_ALL, ...NOTIFICATION_ROLE_TARGETS])
    }
  })

  it('a CI or a service has an owning team but nobody assigned', () => {
    for (const e of ['ci.health_changed', 'service.health_changed', 'service.incident_opened']) {
      const t = applicableNotificationTargets(e)
      expect(t).toContain(NOTIFICATION_TARGET_TEAM)
      expect(t).not.toContain(NOTIFICATION_TARGET_ASSIGNEE)
    }
  })

  it('a tenant digest has no entity at all (NT-8)', () => {
    expect(applicableNotificationTargets('digest.daily')).toEqual([NOTIFICATION_TARGET_ALL, ...NOTIFICATION_ROLE_TARGETS])
  })

  it('an event we do not know allows everything: blocking the unknown is worse than the defect', () => {
    // A static test guarantees every event the product seeds is in the
    // table; at runtime the permissive default keeps a new event working.
    expect(applicableNotificationTargets('something.brand_new')).toEqual([...NOTIFICATION_BASE_TARGETS, ...NOTIFICATION_ROLE_TARGETS])
  })

  it('the tenant\'s own roles are offered when passed, and the factory ones otherwise', () => {
    // The API already accepted custom roles; only the dropdown did not offer
    // them, because this list held the four factory ones (E-39).
    expect(applicableNotificationTargets('incident.assigned', ['role:service_desk_l1']))
      .toEqual([...NOTIFICATION_BASE_TARGETS, 'role:service_desk_l1'])
  })

  it('a role target applies to every event: it does not depend on the entity', () => {
    for (const e of ['incident.created', 'event.received', 'digest.daily', 'whatever.happened']) {
      expect(isTargetApplicable(e, 'role:admin')).toBe(true)
      expect(isTargetApplicable(e, 'role:service_desk_l1')).toBe(true)
    }
  })

  it('assignee on incident.created is refused, on incident.assigned accepted', () => {
    expect(isTargetApplicable('incident.created', NOTIFICATION_TARGET_ASSIGNEE)).toBe(false)
    expect(isTargetApplicable('incident.assigned', NOTIFICATION_TARGET_ASSIGNEE)).toBe(true)
    expect(isTargetApplicable('ci.health_changed', NOTIFICATION_TARGET_ASSIGNEE)).toBe(false)
    expect(isTargetApplicable('ci.health_changed', NOTIFICATION_TARGET_TEAM)).toBe(true)
  })
})
